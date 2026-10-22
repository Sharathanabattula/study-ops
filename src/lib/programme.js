/**
 * @file Programme catalog: fetch + extract a programme page once, reuse everywhere.
 *
 * Extractions are cached as YAML in `data/programmes/`, keyed by URL, so the
 * evaluator, shortlist matrix, cost mapper and syllabus matcher never pay
 * twice for the same page. Pass `refresh: true` to re-fetch.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import YAML from 'yaml';
import { PATHS } from './paths.js';
import { exists } from './files.js';
import { findUniversityByUrl } from './universities.js';
import { fetchPageText } from './web.js';
import { structured } from '../llm/claude.js';

/** Cached extractions older than this are re-fetched. */
const MAX_AGE_DAYS = 30;

/** What Claude extracts from a programme page. Every field may be null. */
export const RequirementsSchema = z.object({
  programme_title: z.string().nullable(),
  award: z.string().nullable().describe('e.g. MSc, MA, MBA'),
  duration_months: z.number().nullable().describe('Full-time duration in months'),
  intake: z.string().nullable(),
  tuition_international_gbp: z.number().nullable().describe('Overseas tuition in GBP'),
  tuition_basis: z.enum(['per_year', 'total_course', 'unknown']),
  application_deadlines: z.array(z.object({ label: z.string(), date: z.string() })),
  academic_requirement: z.string().nullable().describe('Minimum classification/GPA, verbatim where possible'),
  min_uk_classification: z.enum(['first', 'upper_second', 'lower_second', 'third', 'unspecified']),
  international_equivalent: z.string().nullable().describe("Equivalent for the student's country, verbatim, if the page states one"),
  home_country_min_percentage: z.number().nullable().describe("Minimum percentage for the student's country, only if stated"),
  home_country_min_cgpa_10: z.number().nullable().describe("Minimum 10-point CGPA for the student's country, only if stated"),
  subject_background: z.string().nullable().describe('Required or preferred undergraduate subjects and prior knowledge'),
  ielts_overall: z.number().nullable(),
  ielts_min_component: z.number().nullable().describe('Lowest band allowed in any single component'),
  pte_overall: z.number().nullable(),
  work_experience: z.string().nullable(),
  tests_required: z.string().nullable().describe('GMAT/GRE requirement, if any'),
  career_outcomes: z.string().nullable().describe('Placement, salary or employer data stated on the page'),
  scholarships: z.array(z.string()),
  notes: z.string().nullable().describe('Anything else that affects eligibility'),
});

const SYSTEM = `You extract facts from UK university programme pages for Study-Ops.
Return only what the page states. If a field isn't on the page, return null (or "unspecified"/"unknown" for enums). Never fill gaps from general knowledge of the university.`;

/**
 * @typedef {object} ProgrammeRecord
 * @property {string} url
 * @property {string} fetchedAt     ISO timestamp.
 * @property {string|null} universityKey
 * @property {string} universityName
 * @property {'london'|'outside-london'|null} ukviLocation
 * @property {string|null} selectivity
 * @property {boolean} truncated
 * @property {string} pageText      Kept so later agents (e.g. syllabus matching) can re-read it.
 * @property {z.infer<typeof RequirementsSchema>} requirements
 */

/** @param {string} url */
export function cachePath(url) {
  const u = new URL(url);
  const slug = `${u.hostname}${u.pathname}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
  return path.join(PATHS.data, 'programmes', `${slug}.yaml`);
}

/**
 * Load a programme from cache, or fetch and extract it.
 * @param {object} input
 * @param {string} input.url
 * @param {string} [input.nationality]  Steers the "home country" fields.
 * @param {boolean} [input.refresh]
 * @param {typeof fetch} [input.fetchImpl]
 * @returns {Promise<ProgrammeRecord & { cached: boolean }>}
 */
export async function getProgramme({ url, nationality, refresh = false, fetchImpl }) {
  const file = cachePath(url);
  if (!refresh && (await exists(file))) {
    const record = YAML.parse(await fs.readFile(file, 'utf8'));
    const ageDays = (Date.now() - Date.parse(record.fetchedAt)) / 86_400_000;
    if (ageDays <= MAX_AGE_DAYS) return { ...record, cached: true };
  }

  const uni = await findUniversityByUrl(url);
  const page = await fetchPageText(url, { fetchImpl });
  const requirements = await structured({
    system: [SYSTEM],
    schema: RequirementsSchema,
    effort: 'medium',
    prompt: [
      `Extract the programme details from this page. The student's country (for the home-country fields): ${nationality || 'unknown'}.`,
      page.truncated ? 'Note: the page was very long and has been cut to its first 200,000 characters.' : '',
      `<page url="${page.url}" title="${page.title ?? ''}">`,
      page.text,
      '</page>',
    ].filter(Boolean).join('\n\n'),
  });

  /** @type {ProgrammeRecord} */
  const record = {
    url,
    fetchedAt: new Date().toISOString(),
    universityKey: uni?.key ?? null,
    universityName: uni?.name ?? new URL(url).hostname,
    ukviLocation: uni?.ukvi_location ?? null,
    selectivity: uni?.selectivity ?? null,
    truncated: page.truncated,
    pageText: page.text,
    requirements,
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, YAML.stringify(record), 'utf8');
  return { ...record, cached: false };
}

/** @returns {Promise<ProgrammeRecord[]>} Every cached programme. */
export async function listProgrammes() {
  const dir = path.join(PATHS.data, 'programmes');
  if (!(await exists(dir))) return [];
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.yaml'));
  return Promise.all(files.map(async (f) => YAML.parse(await fs.readFile(path.join(dir, f), 'utf8'))));
}

/**
 * Year-one tuition from an extraction, converting a whole-course fee for
 * courses longer than a year.
 * @param {z.infer<typeof RequirementsSchema>} req
 */
export function yearOneTuition(req) {
  if (req.tuition_international_gbp == null) return null;
  const months = req.duration_months ?? 12;
  return req.tuition_basis === 'total_course' && months > 12
    ? Math.round((req.tuition_international_gbp * 12) / months)
    : req.tuition_international_gbp;
}

/** Whole-course tuition (assumes a per-year fee repeats for multi-year courses). */
export function totalTuition(req) {
  if (req.tuition_international_gbp == null) return null;
  const months = req.duration_months ?? 12;
  return req.tuition_basis === 'per_year' && months > 12
    ? Math.round(req.tuition_international_gbp * (months / 12))
    : req.tuition_international_gbp;
}

/**
 * Stable tracker id for a programme, e.g. "lse-msc-finance".
 * @param {string | null} universityKey
 * @param {string | null} title
 * @param {string} url
 */
export function programmeId(universityKey, title, url) {
  const u = new URL(url);
  return `${universityKey ?? u.hostname}-${title ?? u.pathname}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
