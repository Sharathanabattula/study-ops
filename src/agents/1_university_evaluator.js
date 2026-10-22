/**
 * @file Agent 1: University Evaluator.
 *
 * Takes the student profile and a programme URL and produces a structured
 * A–F report with a weighted 1.0–5.0 score, in the spirit of career-ops'
 * job-offer evaluator.
 *
 * Intended pipeline (LLM wiring lands in Phase 1.1):
 *  1. Resolve:  map the URL's domain to the Russell Group registry for city,
 *               UKVI location and tone metadata.
 *  2. Scrape:   fetch the programme page and extract entry requirements
 *               (min classification / CGPA equivalence, IELTS overall + bands),
 *               tuition, duration, intake and deadlines.
 *  3. Compare:  deterministic checks first (CGPA vs threshold, IELTS bands vs
 *               minima, tuition vs `budget.max_tuition`), then LLM judgement
 *               for soft fit (narrative ↔ programme focus, work experience).
 *  4. Score:    rate each dimension 1.0–5.0, take the weighted mean
 *               ({@link DIMENSIONS}) and map it to a letter ({@link scoreToGrade}).
 *  5. Persist:  write `reports/<uni>-<slug>.md` and upsert the score into
 *               `data/tracker.yaml`.
 *
 * Hard rule: the evaluator must never invent entry requirements. If a
 * threshold isn't on the page, the dimension is marked `unknown` and excluded
 * from the weighted mean.
 */
import { loadProfile, missingCoreFields } from '../lib/profile.js';
import { findUniversityByUrl } from '../lib/universities.js';

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
 * @property {string} url
 * @property {{ name: string, city: string, ukviLocation: string, russellGroup: boolean } | null} university
 * @property {DimensionScore[]} dimensions
 * @property {number|null} score   Weighted 1.0–5.0 (one decimal).
 * @property {string|null} grade   A–F.
 * @property {string|null} verdict
 * @property {string[]} missingProfileFields
 * @property {string[]} nextSteps
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
 * @param {DimensionScore[]} dimensions
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
 * Evaluate a university programme against the student profile.
 *
 * @param {object} input
 * @param {string} input.url               Programme page URL.
 * @param {string} [input.profilePath]     Defaults to data/student_profile.md.
 * @returns {Promise<EvaluationReport>}
 */
export async function evaluateUniversity({ url, profilePath }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`"${url}" is not a valid URL.`);
  }

  const profile = await loadProfile(profilePath);
  const uni = await findUniversityByUrl(parsed.href);

  // TODO(phase-1.1): fetch + extract programme requirements, then score.
  /** @type {DimensionScore[]} */
  const dimensions = DIMENSIONS.map((d) => ({ ...d, score: null, rationale: 'Pending: LLM provider not configured.' }));
  const score = weightedScore(dimensions);
  const graded = score === null ? null : scoreToGrade(score);

  return {
    status: 'scaffold',
    url: parsed.href,
    university: uni
      ? { name: uni.name, city: uni.city, ukviLocation: uni.ukvi_location, russellGroup: true }
      : null,
    dimensions,
    score,
    grade: graded?.grade ?? null,
    verdict: graded?.verdict ?? null,
    missingProfileFields: missingCoreFields(profile),
    nextSteps: [
      'Set an LLM provider in .env (see .env.example).',
      'Fill any missing profile fields listed above.',
    ],
  };
}
