/**
 * @file Agent 1: University Evaluator.
 *
 * Takes the student profile and a programme URL and produces a structured
 * A–F report with a weighted 1.0–5.0 score, in the spirit of career-ops'
 * job-offer evaluator.
 *
 * Pipeline
 *  1. Resolve:  map the URL's domain to the Russell Group registry for city,
 *               UKVI location and tone metadata.
 *  2. Fetch:    download the programme page locally and reduce it to text.
 *  3. Extract:  Claude pulls entry requirements, tuition, duration and
 *               deadlines into a strict schema. Anything not on the page is
 *               null; nothing is guessed.
 *  4. Check:    deterministic comparisons ({@link buildFacts}): IELTS overall
 *               and bands vs minima, tuition vs budget, and year-one cost
 *               using the UKVI engine's living-cost rates.
 *  5. Score:    Claude rates each dimension 1.0–5.0 given the profile, the
 *               extracted requirements and the computed facts. The weighted
 *               mean ({@link DIMENSIONS}) maps to a letter ({@link scoreToGrade}).
 *  6. Persist:  write `reports/<id>.md` and upsert the score into
 *               `data/tracker.yaml`.
 *
 * Hard rule: the evaluator never invents entry requirements. If a threshold
 * isn't on the page, the dimension may be scored `null` (unknown), and
 * unknown dimensions are excluded from the weighted mean.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { HOME, PATHS } from '../lib/paths.js';
import { loadProfile, missingCoreFields } from '../lib/profile.js';
import { findUniversityByUrl } from '../lib/universities.js';
import { fetchPageText } from '../lib/web.js';
import { upsertApplication } from '../lib/tracker.js';
import { isConfigured, structured } from '../llm/claude.js';
import { calculateProofOfFunds, loadUkviRules } from './3_ukvi_compliance_engine.js';

/**
 * Scoring dimensions and weights (sum = 1.0).
 * @type {ReadonlyArray<{ key: string, label: string, weight: number, describes: string }>}
 */
export const DIMENSIONS = Object.freeze([
  { key: 'admission_probability', label: 'Admission probability', weight: 0.3, describes: 'CGPA/classification, English bands and experience vs published entry requirements.' },
  { key: 'budget_fit', label: 'Budget fit', weight: 0.2, describes: 'Tuition + UKVI living costs vs budget.max_total_year_one.' },
  { key: 'roi', label: 'ROI', weight: 0.2, describes: 'Expected salary uplift and Graduate Route value vs total cost.' },
  { key: 'programme_fit', label: 'Programme fit', weight: 0.15, describes: 'Curriculum and faculty alignment with the core narrative and goals.' },
  { key: 'career_outcomes', label: 'Career outcomes', weight: 0.15, describes: 'Placement data, employer links and alumni network in the target field.' },
]);

/** Letter bands, highest first. Lower bound inclusive. */
export const GRADE_BANDS = Object.freeze([
  { grade: 'A', min: 4.5, verdict: 'Apply. Strong fit on every axis.' },
  { grade: 'B', min: 3.75, verdict: 'Apply. Good fit with minor trade-offs.' },
  { grade: 'C', min: 3.0, verdict: 'Consider. Reach or stretch on one axis.' },
  { grade: 'D', min: 2.0, verdict: 'Unlikely. Significant gaps; apply only if strategic.' },
  { grade: 'F', min: 1.0, verdict: 'Do not apply.' },
]);

/* ────────────────────────────────── schemas ────────────────────────────────── */

/** What Claude extracts from the programme page. Every field may be null. */
export const RequirementsSchema = z.object({
  programme_title: z.string().nullable(),
  award: z.string().nullable().describe('e.g. MSc, MA, MBA'),
  duration_months: z.number().nullable().describe('Full-time duration in months'),
  intake: z.string().nullable(),
  tuition_international_gbp: z.number().nullable().describe('Annual or total overseas tuition in GBP'),
  tuition_basis: z.enum(['per_year', 'total_course', 'unknown']),
  application_deadlines: z.array(z.object({ label: z.string(), date: z.string() })),
  academic_requirement: z.string().nullable().describe('Minimum classification/GPA, verbatim where possible'),
  international_equivalent: z.string().nullable().describe("Equivalent for the student's country, if the page states one"),
  ielts_overall: z.number().nullable(),
  ielts_min_component: z.number().nullable().describe('Lowest band allowed in any single component'),
  pte_overall: z.number().nullable(),
  work_experience: z.string().nullable(),
  tests_required: z.string().nullable().describe('GMAT/GRE requirement, if any'),
  career_outcomes: z.string().nullable().describe('Placement or employer data stated on the page'),
  scholarships: z.array(z.string()),
  notes: z.string().nullable().describe('Anything else that affects eligibility'),
});

const DimensionKey = z.enum(DIMENSIONS.map((d) => d.key));

/** What Claude returns when scoring. */
export const ScoringSchema = z.object({
  dimensions: z.array(z.object({
    key: DimensionKey,
    score: z.number().nullable().describe('1.0 to 5.0, one decimal; null only if there is no basis to judge'),
    rationale: z.string().describe('One or two sentences citing specific facts'),
  })),
  summary: z.string().describe('Three sentences: the verdict and the main reason for it'),
  strengths: z.array(z.string()),
  risks: z.array(z.string()),
  next_actions: z.array(z.string()).describe('Concrete steps, e.g. "Retake IELTS writing to reach 6.5"'),
});

/* ─────────────────────────────── types + scoring ─────────────────────────────── */

/**
 * @typedef {object} DimensionScore
 * @property {string} key
 * @property {string} label
 * @property {number} weight
 * @property {number|null} score  1.0–5.0, or null when unknown.
 * @property {string} rationale
 *
 * @typedef {object} EvaluationReport
 * @property {'scaffold'|'complete'} status
 * @property {string} id               Tracker id.
 * @property {string} url
 * @property {{ name: string, city: string, ukviLocation: string, russellGroup: boolean } | null} university
 * @property {z.infer<typeof RequirementsSchema> | null} requirements
 * @property {string[]} facts          Deterministic checks given to the scorer.
 * @property {DimensionScore[]} dimensions
 * @property {number|null} score       Weighted 1.0–5.0 (one decimal).
 * @property {string|null} grade       A–F.
 * @property {string|null} verdict
 * @property {string|null} summary
 * @property {string[]} strengths
 * @property {string[]} risks
 * @property {string[]} nextSteps
 * @property {string[]} missingProfileFields
 * @property {string|null} reportPath
 * @property {'created'|'updated'|'skipped'|null} tracker
 */

/**
 * Map a 1.0–5.0 score to its letter grade band.
 * @param {number} score
 * @returns {{ grade: string, verdict: string }}
 */
export function scoreToGrade(score) {
  if (score < 1 || score > 5) throw new RangeError(`Score must be within 1.0–5.0 (got ${score}).`);
  const band = GRADE_BANDS.find((b) => score >= b.min) ?? GRADE_BANDS.at(-1);
  return { grade: band.grade, verdict: band.verdict };
}

/**
 * Weighted mean over known dimensions, re-normalising weights so unknown
 * dimensions don't drag the score down.
 * @param {Array<{ score: number|null, weight: number }>} dimensions
 * @returns {number|null}
 */
export function weightedScore(dimensions) {
  const known = dimensions.filter((d) => typeof d.score === 'number');
  if (!known.length) return null;
  const totalWeight = known.reduce((sum, d) => sum + d.weight, 0);
  const score = known.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight;
  return Math.round(score * 10) / 10;
}

/**
 * Deterministic checks computed from the profile and extracted requirements.
 * These are handed to the scorer as ground truth, so arithmetic never
 * depends on the model.
 *
 * @param {object} input
 * @param {Record<string, any>} input.facts         Profile front-matter.
 * @param {z.infer<typeof RequirementsSchema>} input.requirements
 * @param {'london'|'outside-london'} input.location
 * @param {import('./3_ukvi_compliance_engine.js').UkviRules} input.rules
 * @param {Date} [input.applicationDate]
 * @returns {string[]}
 */
export function buildFacts({ facts, requirements: req, location, rules, applicationDate = new Date() }) {
  const out = [];
  const english = facts.english ?? {};
  const bands = Object.entries(english.bands ?? {}).filter(([, v]) => typeof v === 'number');

  if (req.ielts_overall != null && typeof english.overall === 'number') {
    const gap = english.overall - req.ielts_overall;
    out.push(`English overall: student ${english.overall} vs required ${req.ielts_overall} → ${gap >= 0 ? 'meets' : `short by ${-gap}`}.`);
  }
  if (req.ielts_min_component != null && bands.length) {
    const below = bands.filter(([, v]) => v < req.ielts_min_component).map(([k, v]) => `${k} ${v}`);
    out.push(`English components vs minimum ${req.ielts_min_component}: ${below.length ? `below in ${below.join(', ')}` : 'all meet'}.`);
  }

  const tuition = req.tuition_international_gbp;
  const months = req.duration_months ?? 12;
  if (tuition != null) {
    const yearOneTuition = req.tuition_basis === 'total_course' && months > 12 ? (tuition * 12) / months : tuition;
    const funds = calculateProofOfFunds({ location, courseMonths: months, tuitionFirstYear: yearOneTuition, applicationDate, rules });
    out.push(`Year-one tuition ≈ £${Math.round(yearOneTuition).toLocaleString('en-GB')} (${req.tuition_basis}).`);
    out.push(`UKVI living costs: £${funds.monthlyRate}/mo × ${funds.monthsCounted} = £${funds.maintenance.toLocaleString('en-GB')} (${location}).`);
    out.push(`UKVI proof of funds ≈ £${funds.total.toLocaleString('en-GB')}.`);

    const { max_tuition: maxTuition, max_total_year_one: maxTotal } = facts.budget ?? {};
    if (typeof maxTuition === 'number') {
      out.push(`Tuition vs budget ceiling £${maxTuition.toLocaleString('en-GB')}: ${yearOneTuition <= maxTuition ? 'within' : `over by £${Math.round(yearOneTuition - maxTuition).toLocaleString('en-GB')}`}.`);
    }
    if (typeof maxTotal === 'number') {
      out.push(`Tuition + UKVI living costs vs total budget £${maxTotal.toLocaleString('en-GB')}: ${funds.total <= maxTotal ? 'within' : `over by £${(funds.total - maxTotal).toLocaleString('en-GB')}`} (excludes visa fee, IHS and flights).`);
    }
  } else {
    out.push('Tuition not stated on the page; budget fit cannot be computed.');
  }
  return out;
}

/* ─────────────────────────────────── agent ─────────────────────────────────── */

const SYSTEM = `You are the University Evaluator in Study-Ops, an assistant that helps one student decide which UK postgraduate programmes to apply to.

Principles:
- Use only facts from the programme page, the student profile and the computed facts. Never invent entry requirements, fees, rankings or salaries.
- If the page doesn't state something, return null for it. Don't fill gaps from general knowledge of the university.
- Computed facts are exact arithmetic. Trust them over your own calculations.
- Be candid. The student is better served by a realistic C than an inflated B.`;

/**
 * Evaluate a university programme against the student profile.
 *
 * @param {object} input
 * @param {string} input.url               Programme page URL.
 * @param {string} [input.profilePath]     Defaults to data/student_profile.md.
 * @param {(stage: string) => void} [input.onProgress]
 * @param {typeof fetch} [input.fetchImpl] Injected for tests.
 * @returns {Promise<EvaluationReport>}
 */
export async function evaluateUniversity({ url, profilePath, onProgress = () => {}, fetchImpl }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`"${url}" is not a valid URL.`);
  }

  const profile = await loadProfile(profilePath);
  const uni = await findUniversityByUrl(parsed.href);
  const missing = missingCoreFields(profile);
  const base = {
    url: parsed.href,
    university: uni ? { name: uni.name, city: uni.city, ukviLocation: uni.ukvi_location, russellGroup: true } : null,
    missingProfileFields: missing,
  };

  if (!isConfigured()) {
    return {
      ...base,
      status: 'scaffold',
      id: slugify(`${uni?.key ?? parsed.hostname}-${parsed.pathname}`),
      requirements: null,
      facts: [],
      dimensions: DIMENSIONS.map((d) => ({ ...d, score: null, rationale: 'Pending: no LLM provider configured.' })),
      score: null, grade: null, verdict: null, summary: null, strengths: [], risks: [],
      nextSteps: ['Add ANTHROPIC_API_KEY to .env (see .env.example).'],
      reportPath: null, tracker: null,
    };
  }

  onProgress('Fetching programme page');
  const page = await fetchPageText(parsed.href, { fetchImpl });

  onProgress('Extracting entry requirements');
  const requirements = await structured({
    system: [SYSTEM],
    schema: RequirementsSchema,
    effort: 'medium',
    prompt: [
      `Extract the programme details below from this page. Student nationality (for the international equivalent): ${profile.facts.identity?.nationality || 'unknown'}.`,
      page.truncated ? 'Note: the page was very long and has been cut to its first 200,000 characters.' : '',
      `<page url="${page.url}" title="${page.title ?? ''}">`,
      page.text,
      '</page>',
    ].filter(Boolean).join('\n\n'),
  });

  const location = uni?.ukvi_location ?? (profile.facts.target?.study_location === 'outside-london' ? 'outside-london' : 'london');
  const facts = buildFacts({ facts: profile.facts, requirements, location, rules: await loadUkviRules() });

  onProgress('Scoring fit');
  const scoring = await structured({
    system: [SYSTEM],
    schema: ScoringSchema,
    effort: 'high',
    prompt: [
      'Score this programme for this student on each dimension, from 1.0 (very poor) to 5.0 (excellent).',
      'Dimensions:',
      ...DIMENSIONS.map((d) => `- ${d.key}: ${d.describes}`),
      `<university>${uni?.name ?? parsed.hostname}${uni ? ' (Russell Group)' : ''}</university>`,
      `<requirements>\n${JSON.stringify(requirements, null, 2)}\n</requirements>`,
      `<computed_facts>\n${facts.map((f) => `- ${f}`).join('\n')}\n</computed_facts>`,
      missing.length ? `<profile_gaps>${missing.join(', ')}</profile_gaps>` : '',
      `<student_profile>\n${profile.raw}\n</student_profile>`,
    ].filter(Boolean).join('\n\n'),
  });

  const byKey = new Map(scoring.dimensions.map((d) => [d.key, d]));
  const dimensions = DIMENSIONS.map((d) => {
    const s = byKey.get(d.key);
    const score = typeof s?.score === 'number' ? Math.round(Math.min(5, Math.max(1, s.score)) * 10) / 10 : null;
    return { ...d, score, rationale: s?.rationale ?? 'Not scored.' };
  });
  const score = weightedScore(dimensions);
  const graded = score === null ? null : scoreToGrade(score);

  const id = slugify(`${uni?.key ?? parsed.hostname}-${requirements.programme_title ?? parsed.pathname}`);
  /** @type {EvaluationReport} */
  const report = {
    ...base,
    status: 'complete',
    id,
    requirements,
    facts,
    dimensions,
    score,
    grade: graded?.grade ?? null,
    verdict: graded?.verdict ?? null,
    summary: scoring.summary,
    strengths: scoring.strengths,
    risks: scoring.risks,
    nextSteps: scoring.next_actions,
    reportPath: path.join(PATHS.reports, `${id}.md`),
    tracker: null,
  };

  await fs.mkdir(PATHS.reports, { recursive: true });
  await fs.writeFile(report.reportPath, renderReport(report), 'utf8');

  report.tracker = await upsertApplication({
    id,
    university: uni?.name ?? parsed.hostname,
    short_name: uni?.key?.toUpperCase() ?? null,
    russell_group: Boolean(uni),
    programme: requirements.programme_title,
    url: parsed.href,
    location,
    evaluation: { score, grade: report.grade, report: path.relative(HOME, report.reportPath) },
    fees: { tuition_year_one: requirements.tuition_international_gbp },
  });

  return report;
}

/**
 * Render the Markdown report saved under `reports/`.
 * @param {EvaluationReport} r
 */
export function renderReport(r) {
  const req = r.requirements ?? {};
  const line = (label, value) => (value == null || value === '' ? null : `| ${label} | ${String(value).replace(/\|/g, '\\|')} |`);
  return [
    `# ${req.programme_title ?? 'Programme'} · ${r.university?.name ?? r.url}`,
    '',
    `**Grade ${r.grade ?? '–'}** · ${r.score ?? '–'}/5.0 · ${r.verdict ?? ''}`,
    '',
    `> ${r.summary ?? ''}`,
    '',
    `Source: ${r.url}  `,
    `Evaluated: ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## Scorecard',
    '',
    '| Dimension | Weight | Score | Rationale |',
    '|---|---|---|---|',
    ...r.dimensions.map((d) => `| ${d.label} | ${Math.round(d.weight * 100)}% | ${d.score ?? '–'} | ${d.rationale.replace(/\|/g, '\\|')} |`),
    '',
    '## Requirements (as stated on the page)',
    '',
    '| Item | Value |',
    '|---|---|',
    ...[
      line('Award', req.award),
      line('Duration (months)', req.duration_months),
      line('Intake', req.intake),
      line('Tuition (international)', req.tuition_international_gbp != null ? `£${req.tuition_international_gbp.toLocaleString('en-GB')} (${req.tuition_basis})` : null),
      line('Academic', req.academic_requirement),
      line('International equivalent', req.international_equivalent),
      line('IELTS', req.ielts_overall != null ? `${req.ielts_overall} overall, ${req.ielts_min_component ?? '?'} min component` : null),
      line('PTE', req.pte_overall),
      line('Work experience', req.work_experience),
      line('GMAT/GRE', req.tests_required),
      ...(req.application_deadlines ?? []).map((d) => line(`Deadline: ${d.label}`, d.date)),
    ].filter(Boolean),
    '',
    '## Computed checks',
    '',
    ...r.facts.map((f) => `- ${f}`),
    '',
    '## Strengths',
    '',
    ...r.strengths.map((s) => `- ${s}`),
    '',
    '## Risks',
    '',
    ...r.risks.map((s) => `- ${s}`),
    '',
    '## Next actions',
    '',
    ...r.nextSteps.map((s) => `- [ ] ${s}`),
    '',
    r.missingProfileFields.length ? `> ⚠️ Profile gaps reduced accuracy: ${r.missingProfileFields.join(', ')}\n` : '',
  ].join('\n');
}

/** @param {string} s */
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
