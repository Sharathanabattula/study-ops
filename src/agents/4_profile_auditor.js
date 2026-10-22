/**
 * @file Agent 4: Profile Auditor. Step one of a consultancy-style intake.
 *
 * Deterministic, no LLM. It reads `data/student_profile.md` and produces a
 * standardised academic and English profile that every other agent builds on:
 *
 *  - Grades: 10-point CGPA → percentage (formula from your transcript), then
 *    percentage → estimated UK classification (by institution tier) and a
 *    reference US 4.0 GPA.
 *  - Backlogs: active vs cleared, and how they are likely to read.
 *  - English: IELTS overall and components against the UKVI B2 floor and the
 *    common Russell Group tiers, plus test validity at intake.
 *  - Gaps: study gap since graduation, missing fields.
 *
 * All conversion tables live in `config/grade_equivalence.yaml`. They are
 * heuristics. A programme page's own India-specific threshold, when there is
 * one, always wins (see the shortlist matrix).
 */
import { PATHS } from '../lib/paths.js';
import { readYaml } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';

/**
 * @typedef {object} GradeAudit
 * @property {number|null} percentage
 * @property {string} percentageSource       How the percentage was obtained.
 * @property {number} tier                   Institution tier used (1–3).
 * @property {'first'|'upper_second'|'lower_second'|'third'|null} ukClass
 * @property {string|null} ukClassLabel      e.g. "2:1 (Upper Second)"
 * @property {number|null} marginToNextClass Percentage points to the next class up.
 * @property {number|null} usGpa
 *
 * @typedef {object} EnglishAudit
 * @property {string|null} test
 * @property {number|null} overall
 * @property {Record<string, number>} bands
 * @property {number|null} lowestBand
 * @property {boolean|null} meetsUkviB2
 * @property {string[]} tiersMet             e.g. ["Standard", "Higher"]
 * @property {string|null} validUntil
 * @property {boolean|null} validAtIntake
 *
 * @typedef {object} ProfileAudit
 * @property {GradeAudit} grades
 * @property {{ active: number, cleared: number, level: 'clean'|'note'|'caution'|'risk' }} backlogs
 * @property {EnglishAudit} english
 * @property {{ months: number|null, graduationYear: number|null }} studyGap
 * @property {number} workMonths
 * @property {Array<{ level: 'ok'|'warn'|'risk', message: string }>} flags
 */

export const CLASS_LABELS = Object.freeze({
  first: 'First',
  upper_second: '2:1 (Upper Second)',
  lower_second: '2:2 (Lower Second)',
  third: 'Third / Pass',
});

/** Ordered lowest → highest; used to compare classifications. */
export const CLASS_ORDER = Object.freeze(['third', 'lower_second', 'upper_second', 'first']);

/** @returns {Promise<any>} */
export async function loadGradeRules() {
  return readYaml(`${PATHS.config}/grade_equivalence.yaml`);
}

/**
 * Convert the profile's grade to a percentage.
 * @param {Record<string, any>} academics
 * @param {any} rules
 * @returns {{ percentage: number|null, source: string }}
 */
export function toPercentage(academics = {}, rules) {
  if (typeof academics.percentage === 'number') {
    return { percentage: round1(academics.percentage), source: 'Official percentage from transcript' };
  }
  const { cgpa, cgpa_scale: scale = 10 } = academics;
  if (typeof cgpa !== 'number') return { percentage: null, source: 'No CGPA or percentage in profile' };

  if (scale === 100) return { percentage: round1(cgpa), source: 'Percentage scale' };
  if (scale === 4) return { percentage: null, source: '4-point GPA: no reliable percentage conversion; use each university’s GPA requirement' };
  if (scale !== 10) {
    return { percentage: round1((cgpa / scale) * 100), source: `Linear conversion from ${scale}-point scale (rough)` };
  }

  const key = academics.cgpa_conversion ?? 'aicte';
  const custom = academics.cgpa_conversion_custom;
  const formula = key === 'custom' && typeof custom?.multiply === 'number'
    ? { label: `Custom: CGPA × ${custom.multiply} + ${custom.add ?? 0}`, multiply: custom.multiply, add: custom.add ?? 0 }
    : rules.cgpa_to_percentage[key] ?? rules.cgpa_to_percentage.aicte;
  const assumed = academics.cgpa_conversion ? '' : ' (assumed; set cgpa_conversion to your university’s formula)';
  return { percentage: round1(Math.min(100, cgpa * formula.multiply + formula.add)), source: `${formula.label}${assumed}` };
}

/**
 * Estimate the UK classification for a percentage at a given tier.
 * @param {number} percentage
 * @param {number} tier
 * @param {any} rules
 */
export function toUkClass(percentage, tier, rules) {
  const bands = rules.uk_classification.india.tiers[tier] ?? rules.uk_classification.india.tiers[2];
  const steps = [['first', bands.first], ['upper_second', bands.upper_second], ['lower_second', bands.lower_second]];
  const index = steps.findIndex(([, min]) => percentage >= min);
  if (index === -1) return { ukClass: 'third', marginToNextClass: round1(bands.lower_second - percentage) };
  const [ukClass] = steps[index];
  const next = steps[index - 1];
  return { ukClass, marginToNextClass: next ? round1(next[1] - percentage) : null };
}

/** @param {number} percentage @param {any} rules */
export function toUsGpa(percentage, rules) {
  return rules.us_gpa.india.wes_bands.find((b) => percentage >= b.min)?.gpa ?? 0;
}

/**
 * Audit English test scores.
 * @param {Record<string, any>} english
 * @param {any} rules
 * @param {string} [intake] YYYY-MM
 * @returns {EnglishAudit}
 */
export function auditEnglish(english = {}, rules, intake) {
  const bands = Object.fromEntries(Object.entries(english.bands ?? {}).filter(([, v]) => typeof v === 'number'));
  const values = Object.values(bands);
  const lowestBand = values.length ? Math.min(...values) : null;
  const overall = typeof english.overall === 'number' ? english.overall : null;
  const isIelts = /ielts/i.test(english.test ?? '');

  const tiersMet = isIelts && overall !== null && lowestBand !== null
    ? rules.english.ielts_tiers.filter((t) => overall >= t.overall && lowestBand >= t.min_component).map((t) => t.name)
    : [];

  let validUntil = null;
  let validAtIntake = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(english.test_date ?? '')) {
    const d = new Date(`${english.test_date}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + rules.english.validity_years);
    validUntil = d.toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}$/.test(intake ?? '')) validAtIntake = validUntil >= `${intake}-01`;
  }

  return {
    test: english.test || null,
    overall,
    bands,
    lowestBand,
    meetsUkviB2: isIelts && lowestBand !== null ? lowestBand >= rules.english.ukvi_b2_ielts_each_component : null,
    tiersMet,
    validUntil,
    validAtIntake,
  };
}

/**
 * Normalise backlogs from either `backlogs: 3` (old template) or
 * `backlogs: { active, cleared }`.
 * @param {number | { active?: number, cleared?: number } | undefined} raw
 * @param {any} rules
 */
export function auditBacklogs(raw, rules) {
  const active = typeof raw === 'object' && raw ? raw.active ?? 0 : 0;
  const cleared = typeof raw === 'object' && raw ? raw.cleared ?? 0 : typeof raw === 'number' ? raw : 0;
  const total = active + cleared;
  const level = active > 0 || total > rules.backlogs.cleared_risk_above
    ? 'risk'
    : total > rules.backlogs.cleared_caution_above ? 'caution' : total > 0 ? 'note' : 'clean';
  return { active, cleared, level };
}

/**
 * Run the full audit.
 * @param {object} [input]
 * @param {Awaited<ReturnType<typeof loadProfile>>} [input.profile]
 * @param {any} [input.rules]
 * @param {Date} [input.today]
 * @returns {Promise<ProfileAudit>}
 */
export async function auditProfile({ profile, rules, today = new Date() } = {}) {
  profile ??= await loadProfile();
  rules ??= await loadGradeRules();
  const { academics = {}, english = {}, experience = {}, target = {} } = profile.facts;

  const { percentage, source } = toPercentage(academics, rules);
  const tier = [1, 2, 3].includes(academics.institution_tier) ? academics.institution_tier : 2;
  const cls = percentage !== null ? toUkClass(percentage, tier, rules) : { ukClass: null, marginToNextClass: null };
  /** @type {GradeAudit} */
  const grades = {
    percentage,
    percentageSource: source,
    tier,
    ukClass: cls.ukClass,
    ukClassLabel: cls.ukClass ? CLASS_LABELS[cls.ukClass] : null,
    marginToNextClass: cls.marginToNextClass,
    usGpa: percentage !== null ? toUsGpa(percentage, rules) : null,
  };

  const backlogs = auditBacklogs(academics.backlogs, rules);
  const englishAudit = auditEnglish(english, rules, target.intake);

  const gradYear = typeof academics.graduation_year === 'number' ? academics.graduation_year : null;
  const intakeYear = /^\d{4}/.test(target.intake ?? '') ? Number(target.intake.slice(0, 4)) : today.getUTCFullYear();
  const studyGapMonths = gradYear ? Math.max(0, (intakeYear - gradYear) * 12 - 3) : null; // UG usually ends ~June, PG starts ~Sept
  const workMonths = experience.total_months ?? 0;

  /** @type {ProfileAudit['flags']} */
  const flags = [];
  if (percentage === null) flags.push({ level: 'risk', message: 'Add academics.cgpa (with cgpa_scale) or academics.percentage.' });
  else if (!academics.cgpa_conversion && typeof academics.percentage !== 'number' && academics.cgpa_scale === 10) {
    flags.push({ level: 'warn', message: 'CGPA converted with the AICTE formula by default. Set academics.cgpa_conversion to match your transcript.' });
  }
  if (!academics.institution_tier) flags.push({ level: 'warn', message: 'Institution tier not set; assumed tier 2. Many UK universities publish tiered India lists.' });
  if (grades.marginToNextClass !== null && grades.marginToNextClass <= 2) {
    flags.push({ level: 'ok', message: `Within ${grades.marginToNextClass} points of the next classification; a strong final semester could move you up.` });
  }
  if (backlogs.active > 0) flags.push({ level: 'risk', message: `${backlogs.active} active backlog(s). Offers will be conditional on clearing them before final transcripts.` });
  else if (backlogs.level === 'caution' || backlogs.level === 'risk') flags.push({ level: 'warn', message: `${backlogs.cleared} cleared backlogs. Address them briefly in your statement; selective programmes may screen on this.` });
  if (englishAudit.overall === null) flags.push({ level: 'warn', message: 'No English test score yet. Most programmes need IELTS/PTE before an unconditional offer.' });
  if (englishAudit.meetsUkviB2 === false) flags.push({ level: 'risk', message: `A component is below ${rules.english.ukvi_b2_ielts_each_component}, the UKVI B2 minimum for degree-level study.` });
  if (englishAudit.validAtIntake === false) flags.push({ level: 'risk', message: `English test expires ${englishAudit.validUntil}, before your intake. Plan a retake.` });
  if (studyGapMonths !== null && studyGapMonths >= 24 && workMonths < studyGapMonths - 6) {
    flags.push({ level: 'warn', message: `About ${Math.round(studyGapMonths / 12)} years since graduation with less work experience than that. Be ready to explain the gap.` });
  }

  return { grades, backlogs, english: englishAudit, studyGap: { months: studyGapMonths, graduationYear: gradYear }, workMonths, flags };
}

/** @param {number} n */
function round1(n) {
  return Math.round(n * 10) / 10;
}
