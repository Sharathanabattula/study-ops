/**
 * @file Agent 5: Safe / Target / Reach Shortlist Matrix.
 *
 * Builds a programme-by-programme shortlist for one subject across the
 * Russell Group (or the student's own list), and places each in Safe,
 * Target or Reach.
 *
 * Pipeline
 *  1. Discover: for each university, Claude runs web search restricted to that
 *     university's own domains to find matching taught programmes. Results
 *     are cached for 30 days. Skip this with `urls` to classify known pages.
 *  2. Extract:  each programme page → requirements (shared, cached catalog).
 *  3. Classify (deterministic, {@link classifyProgramme}):
 *       a. Academic margin: the student's percentage minus the page's own
 *          home-country minimum. If the page has none, minus the estimated
 *          percentage for its UK classification at the student's tier.
 *       b. Selectivity sets how much margin counts as Safe.
 *       c. English, active backlogs and heavy backlog history cap the category.
 *       d. Historical outcomes: if `data/outcomes.yaml` holds ≥ 5 past
 *          applicants to that university with a similar percentage (± 5
 *          points), their admit rate decides the category instead.
 *  4. Cost:     cost of attendance vs budget for every programme.
 *  5. Persist:  `reports/shortlist-<subject>.md` and tracker entries (new
 *     entries get status `shortlisted`; existing statuses are left alone).
 *
 * On "historical acceptance rates": UK universities don't publish admit
 * rates by applicant profile. Study-Ops uses real outcomes only when you
 * provide them in `data/outcomes.yaml`, such as your consultancy's past
 * cases or your peers' results. Otherwise it says the category comes from
 * published requirements alone.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import YAML from 'yaml';
import { PATHS } from '../lib/paths.js';
import { exists, readYaml } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { loadUniversities } from '../lib/universities.js';
import { getProgramme, programmeId, totalTuition, yearOneTuition } from '../lib/programme.js';
import { upsertApplication } from '../lib/tracker.js';
import { isConfigured, structuredWithSearch } from '../llm/claude.js';
import { auditProfile, loadGradeRules, toPercentage } from './4_profile_auditor.js';
import { budgetFit, costOfAttendance } from './6_cost_roi_mapper.js';

/** Margin (percentage points above the minimum) needed for each category. */
export const BUFFERS = Object.freeze({
  standard: { safe: 8, target: 0 },
  high: { safe: 12, target: 0 },
  very_high: { safe: Infinity, target: 5 },
});

/** Similar past applicants needed before outcomes override the requirement-based rule. */
export const MIN_OUTCOMES = 5;

const LEVELS = ['reach', 'target', 'safe'];
const DISCOVERY_MAX_AGE_DAYS = 30;

export const DiscoverySchema = z.object({
  programmes: z.array(z.object({
    title: z.string(),
    url: z.string().describe("The programme's own page on the university's official site"),
    award: z.string().nullable(),
    relevance: z.string().describe('One line: why this matches the subject'),
  })),
});

/**
 * @typedef {'safe'|'target'|'reach'} Category
 *
 * @typedef {object} Classification
 * @property {Category} category
 * @property {boolean} belowMinimum
 * @property {number|null} margin          Percentage points above the minimum.
 * @property {string} basis                How the minimum was determined.
 * @property {'high'|'medium'|'low'} confidence
 * @property {'meets'|'below'|'unknown'} english
 * @property {{ similar: number, admitted: number } | null} outcomes
 * @property {string[]} reasons
 */

/**
 * Place one programme in Safe / Target / Reach. Pure function.
 *
 * @param {object} input
 * @param {import('./4_profile_auditor.js').ProfileAudit} input.audit
 * @param {Record<string, any>} input.academics      profile academics block
 * @param {import('../lib/programme.js').ProgrammeRecord['requirements']} input.requirements
 * @param {string|null} input.selectivity
 * @param {Array<Record<string, any>>} [input.outcomes]  Already filtered to this university.
 * @param {any} input.gradeRules
 * @returns {Classification}
 */
export function classifyProgramme({ audit, academics = {}, requirements: req, selectivity, outcomes = [], gradeRules }) {
  const reasons = [];
  const pct = audit.grades.percentage;
  const buffers = BUFFERS[selectivity] ?? BUFFERS.standard;

  // a. Academic margin
  let margin = null;
  let basis = 'No academic threshold found on the page';
  let confidence = 'low';
  if (pct !== null && req.home_country_min_percentage != null) {
    margin = round1(pct - req.home_country_min_percentage);
    basis = `Page states ${req.home_country_min_percentage}% for your country`;
    confidence = 'high';
  } else if (req.home_country_min_cgpa_10 != null && typeof academics.cgpa === 'number' && (academics.cgpa_scale ?? 10) === 10) {
    margin = round1((academics.cgpa - req.home_country_min_cgpa_10) * 10);
    basis = `Page states CGPA ${req.home_country_min_cgpa_10}/10 for your country`;
    confidence = 'high';
  } else if (pct !== null && req.min_uk_classification && req.min_uk_classification !== 'unspecified') {
    const bands = gradeRules.uk_classification.india.tiers[audit.grades.tier] ?? gradeRules.uk_classification.india.tiers[2];
    const needed = { first: bands.first, upper_second: bands.upper_second, lower_second: bands.lower_second, third: 40 }[req.min_uk_classification];
    margin = round1(pct - needed);
    basis = `Requires UK ${req.min_uk_classification.replace('_', ' ')}; ≈ ${needed}% at tier ${audit.grades.tier} (heuristic)`;
    confidence = 'medium';
  }

  let category;
  if (margin === null) {
    category = 'target';
    reasons.push('Academic fit unverified. Check the entry requirements yourself.');
  } else if (margin < 0) {
    category = 'reach';
    reasons.push(`${Math.abs(margin)} points below the minimum.`);
  } else if (margin >= buffers.safe) {
    category = 'safe';
  } else if (margin >= buffers.target) {
    category = 'target';
  } else {
    category = 'reach';
    reasons.push(`Meets the minimum, but this programme is highly selective (+${margin} points).`);
  }
  if (selectivity === 'very_high') reasons.push('Highly selective: never classed as Safe on requirements alone.');

  // c. Caps
  let english = 'unknown';
  if (req.ielts_overall != null && audit.english.overall !== null && /ielts/i.test(audit.english.test ?? '')) {
    const bandOk = req.ielts_min_component == null || (audit.english.lowestBand ?? 0) >= req.ielts_min_component;
    english = audit.english.overall >= req.ielts_overall && bandOk ? 'meets' : 'below';
    if (english === 'below') {
      category = cap(category, 'target');
      reasons.push(`IELTS below ${req.ielts_overall}${req.ielts_min_component != null ? ` (min ${req.ielts_min_component} per band)` : ''}; any offer will be conditional on a retake.`);
    }
  }
  if (audit.backlogs.active > 0) {
    category = cap(category, 'target');
    reasons.push('Active backlogs: the offer will be conditional on clearing them.');
  } else if (audit.backlogs.level === 'risk' && selectivity !== 'standard') {
    category = lower(category);
    reasons.push('Heavy backlog history counts against you at selective programmes.');
  }

  // d. Outcomes override
  let evidence = null;
  if (outcomes.length && pct !== null) {
    const similar = outcomes
      .map((o) => ({ o, p: toPercentage(o, gradeRules).percentage }))
      .filter(({ o, p }) => p !== null && Math.abs(p - pct) <= 5 && ['admit', 'reject'].includes(o.result));
    const admitted = similar.filter(({ o }) => o.result === 'admit').length;
    evidence = { similar: similar.length, admitted };
    if (similar.length >= MIN_OUTCOMES) {
      const rate = admitted / similar.length;
      const fromData = rate >= 0.7 ? 'safe' : rate >= 0.4 ? 'target' : 'reach';
      if (fromData !== category) reasons.push(`Past outcomes moved this from ${category} to ${fromData}.`);
      category = english === 'below' || audit.backlogs.active > 0 ? cap(fromData, 'target') : fromData;
      basis += `; ${admitted}/${similar.length} similar past applicants admitted`;
      confidence = 'high';
    } else if (similar.length) {
      reasons.push(`${admitted}/${similar.length} similar past applicants admitted (too few to rely on).`);
    }
  }

  return { category, belowMinimum: margin !== null && margin < 0, margin, basis, confidence, english, outcomes: evidence, reasons };
}

/**
 * Find programmes at one university. Cached in data/programmes/_discovery.yaml.
 * @param {object} input
 * @param {import('../lib/universities.js').University} input.university
 * @param {string} input.subject
 * @param {string} input.level
 * @param {number} input.maxPerUniversity
 * @param {boolean} [input.refresh]
 * @returns {Promise<Array<{ title: string, url: string }>>}
 */
export async function discoverProgrammes({ university, subject, level, maxPerUniversity, refresh = false }) {
  const cacheFile = path.join(PATHS.data, 'programmes', '_discovery.yaml');
  const cache = (await exists(cacheFile)) ? (await readYaml(cacheFile)) ?? {} : {};
  const key = `${university.key}|${subject.toLowerCase()}|${level.toLowerCase()}`;
  const hit = cache[key];
  if (!refresh && hit && (Date.now() - Date.parse(hit.at)) / 86_400_000 <= DISCOVERY_MAX_AGE_DAYS) return hit.programmes;

  const found = await structuredWithSearch({
    system: ['You find taught postgraduate programmes on UK university websites for Study-Ops. Only return programmes you saw on the official site during this search, with their exact URLs.'],
    schema: DiscoverySchema,
    allowedDomains: university.domains,
    maxSearches: 4,
    prompt: `Find up to ${maxPerUniversity} ${level} programmes at ${university.name} closely matching "${subject}" for the next intake. Return each programme's own course page (not a search or list page). If none match, return an empty list.`,
  });
  const onDomain = found.programmes
    .filter((p) => {
      try {
        const host = new URL(p.url).hostname;
        return university.domains.some((d) => host === d || host.endsWith(`.${d}`));
      } catch {
        return false;
      }
    })
    .slice(0, maxPerUniversity)
    .map(({ title, url }) => ({ title, url }));

  cache[key] = { at: new Date().toISOString(), programmes: onDomain };
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, YAML.stringify(cache), 'utf8');
  return onDomain;
}

/**
 * Build the full matrix.
 *
 * @param {object} input
 * @param {string} input.subject             e.g. "Finance"
 * @param {string} [input.level='MSc']
 * @param {string[]} [input.universities]    Registry keys; defaults to profile shortlist, else all 24.
 * @param {string[]} [input.urls]            Classify these pages instead of discovering.
 * @param {number} [input.maxPerUniversity=2]
 * @param {boolean} [input.refresh]
 * @param {(stage: string) => void} [input.onProgress]
 * @param {typeof fetch} [input.fetchImpl]
 */
export async function buildShortlist({ subject, level = 'MSc', universities, urls, maxPerUniversity = 2, refresh = false, onProgress = () => {}, fetchImpl }) {
  if (!isConfigured()) throw new Error('The shortlist reads programme pages with Claude. Add ANTHROPIC_API_KEY to .env first.');
  const profile = await loadProfile();
  const [audit, gradeRules, registry] = await Promise.all([auditProfile({ profile }), loadGradeRules(), loadUniversities()]);
  const outcomesFile = PATHS.outcomes;
  const outcomes = (await exists(outcomesFile)) ? ((await readYaml(outcomesFile))?.outcomes ?? []) : [];
  const warnings = [];

  // 1. Candidate URLs
  /** @type {Array<{ url: string, title?: string }>} */
  let candidates;
  if (urls?.length) {
    candidates = urls.map((url) => ({ url }));
  } else {
    const keys = universities?.length ? universities : profile.facts.target?.shortlist?.length ? profile.facts.target.shortlist : registry.map((u) => u.key);
    const unis = keys.map((k) => registry.find((u) => u.key === String(k).toLowerCase() || u.name.toLowerCase() === String(k).toLowerCase()) ?? k);
    for (const missing of unis.filter((u) => typeof u === 'string')) warnings.push(`"${missing}" is not in the Russell Group registry; skipped.`);
    const valid = unis.filter((u) => typeof u !== 'string');
    let done = 0;
    const found = await pool(valid, 3, async (university) => {
      try {
        const list = await discoverProgrammes({ university, subject, level, maxPerUniversity, refresh });
        onProgress(`Searched ${university.name} (${++done}/${valid.length}): ${list.length} found`);
        return list;
      } catch (err) {
        warnings.push(`${university.name}: search failed (${err.message})`);
        return [];
      }
    });
    candidates = found.flat();
  }
  if (!candidates.length) throw new Error(`No ${level} programmes found for "${subject}". Try a broader subject or pass --urls.`);

  // 2–4. Extract, classify, cost
  let read = 0;
  const rows = (await pool(candidates, 3, async ({ url }) => {
    try {
      const prog = await getProgramme({ url, nationality: profile.facts.identity?.nationality, refresh, fetchImpl });
      onProgress(`Read ${prog.requirements.programme_title ?? url} (${++read}/${candidates.length})`);
      const uniOutcomes = outcomes.filter((o) => String(o.university).toLowerCase() === prog.universityKey);
      const classification = classifyProgramme({
        audit, academics: profile.facts.academics, requirements: prog.requirements, selectivity: prog.selectivity, outcomes: uniOutcomes, gradeRules,
      });
      const tuition = totalTuition(prog.requirements);
      const zone = prog.ukviLocation === 'outside-london' ? 'outside' : profile.facts.target?.living_zone ?? 'inner';
      const cost = tuition != null
        ? await costOfAttendance({ tuitionTotal: tuition, tuitionYearOne: yearOneTuition(prog.requirements) ?? undefined, courseMonths: prog.requirements.duration_months ?? 12, zone, flightsAndSetup: profile.facts.budget?.flights_and_setup_gbp ?? 0 })
        : null;
      return { programme: prog, classification, cost, budget: cost ? budgetFit(cost, profile.facts.budget) : null };
    } catch (err) {
      warnings.push(`${url}: ${err.message}`);
      return null;
    }
  })).filter(Boolean);

  rows.sort((a, b) => LEVELS.indexOf(b.classification.category) - LEVELS.indexOf(a.classification.category)
    || (b.classification.margin ?? -99) - (a.classification.margin ?? -99));

  // 5. Persist
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const reportPath = path.join(PATHS.reports, `shortlist-${slug}.md`);
  await fs.mkdir(PATHS.reports, { recursive: true });
  await fs.writeFile(reportPath, renderShortlist({ subject, level, audit, rows, warnings, outcomesCount: outcomes.length }), 'utf8');

  for (const { programme: p, classification: c, cost } of rows) {
    await upsertApplication({
      id: programmeId(p.universityKey, p.requirements.programme_title, p.url),
      university: p.universityName,
      russell_group: Boolean(p.universityKey),
      programme: p.requirements.programme_title,
      url: p.url,
      location: p.ukviLocation,
      shortlist: { category: c.category, margin: c.margin, confidence: c.confidence, cost_of_attendance: cost?.total ?? null },
      fees: { tuition_year_one: yearOneTuition(p.requirements) },
    }, { defaults: { status: 'shortlisted' } });
  }

  return { rows, warnings, reportPath, audit };
}

/** Markdown matrix saved under reports/. */
export function renderShortlist({ subject, level, audit, rows, warnings, outcomesCount }) {
  const gbp = (n) => (n == null ? '–' : `£${Math.round(n).toLocaleString('en-GB')}`);
  const section = (cat, title, blurb) => {
    const list = rows.filter((r) => r.classification.category === cat);
    if (!list.length) return [`## ${title}`, '', '_None._', ''];
    return [
      `## ${title}`, '', blurb, '',
      '| University | Programme | Margin | Basis | English | Cost of attendance | Budget | Confidence |',
      '|---|---|---|---|---|---|---|---|',
      ...list.map(({ programme: p, classification: c, cost, budget }) =>
        `| ${p.universityName} | [${p.requirements.programme_title ?? 'Programme'}](${p.url}) | ${c.margin == null ? '?' : `${c.margin >= 0 ? '+' : ''}${c.margin}`} | ${c.basis} | ${c.english} | ${gbp(cost?.total)} | ${budget?.status ?? 'unknown'} | ${c.confidence} |`),
      '',
      ...list.flatMap(({ programme: p, classification: c }) => (c.reasons.length ? [`- **${p.universityName}, ${p.requirements.programme_title ?? ''}:** ${c.reasons.join(' ')}`] : [])),
      '',
    ];
  };
  return [
    `# ${level} ${subject}: Safe / Target / Reach`,
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} · ${rows.length} programmes`,
    '',
    `**Your profile:** ${audit.grades.percentage ?? '?'}% (${audit.grades.ukClassLabel ?? 'unknown'} est., tier ${audit.grades.tier}) · ${audit.english.test ?? 'no English test'} ${audit.english.overall ?? ''} · backlogs ${audit.backlogs.active} active / ${audit.backlogs.cleared} cleared`,
    '',
    outcomesCount
      ? `Historical data: ${outcomesCount} past outcomes in data/outcomes.yaml.`
      : '> Categories come from published entry requirements only. Add past admission results to `data/outcomes.yaml` to base them on real acceptance data.',
    '',
    '_Margin = your percentage minus the minimum, in percentage points._',
    '',
    ...section('safe', '🟢 Safe', 'Comfortably above the published minimum at a less selective programme.'),
    ...section('target', '🟡 Target', 'Meets the requirements; a competitive but realistic application.'),
    ...section('reach', '🔴 Reach', 'Below the minimum, highly selective, or blocked by a fixable gap.'),
    ...(warnings.length ? ['## Notes', '', ...warnings.map((w) => `- ${w}`), ''] : []),
    '> A typical balanced list is 2 Safe, 3–4 Target and 1–2 Reach.',
    '',
  ].join('\n');
}

/** Run `fn` over items with at most `limit` in flight, keeping order. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

/** @param {Category} c @param {Category} max */
const cap = (c, max) => (LEVELS.indexOf(c) > LEVELS.indexOf(max) ? max : c);
/** @param {Category} c */
const lower = (c) => LEVELS[Math.max(0, LEVELS.indexOf(c) - 1)];
/** @param {number} n */
const round1 = (n) => Math.round(n * 10) / 10;
