/**
 * @file Agent 6: Cost-of-Attendance & ROI Mapper.
 *
 * Deterministic. It answers two questions a consultancy asks before
 * shortlisting:
 *   1. What will this programme actually cost, all-in, and does it fit the
 *      student's budget?
 *   2. How long until the degree pays for itself?
 *
 * Cost of attendance = whole-course tuition
 *                    + living costs for the full course (inner London / outer
 *                      London / outside London, from config/living_costs.yaml)
 *                    + visa application fee
 *                    + Immigration Health Surcharge for the full visa length
 *                    + flights and setup (from the profile)
 *
 * ROI uses the salaries the student enters in the profile's `career` block.
 * Study-Ops has no salary database and won't invent one. Figures are pre-tax.
 *
 * This is separate from the UKVI proof-of-funds figure: UKVI caps living
 * costs at 9 months at a fixed rate, while real costs run for the whole course.
 */
import { PATHS } from '../lib/paths.js';
import { readYaml } from '../lib/files.js';
import { loadUkviRules } from './3_ukvi_compliance_engine.js';

/** @typedef {'inner_london'|'outer_london'|'outside_london'} LivingZone */

/**
 * @typedef {object} CostBreakdown
 * @property {LivingZone} zone
 * @property {number} courseMonths
 * @property {number} visaMonths
 * @property {Array<{ label: string, amount: number, note?: string }>} lines
 * @property {number} total
 * @property {number} yearOneTotal   Costs due in the first 12 months.
 *
 * @typedef {object} BudgetFit
 * @property {number|null} limit
 * @property {'max_total_course'|'max_total_year_one'|null} basis
 * @property {'within'|'stretch'|'over'|'unknown'} status  stretch = up to 10% over.
 * @property {number|null} headroom   Positive = under budget.
 *
 * @typedef {object} RoiEstimate
 * @property {number|null} graduateRouteMonths
 * @property {string|null} graduateRouteNote
 * @property {number|null} annualUpliftGbp
 * @property {number|null} paybackYears
 * @property {number|null} fiveYearMultiple   5 × uplift ÷ (cost + forgone salary).
 * @property {number|null} forgoneSalaryGbp
 * @property {string[]} notes
 */

/** @returns {Promise<{ monthly: Record<LivingZone, number>, note?: string }>} */
export async function loadLivingCosts() {
  return readYaml(`${PATHS.config}/living_costs.yaml`);
}

/**
 * Normalise CLI/registry input to a living zone.
 * @param {string | null | undefined} input inner | outer | outside | london | outside-london
 * @returns {LivingZone}
 */
export function normaliseZone(input) {
  const v = String(input ?? 'inner').toLowerCase().replace(/[\s-]+/g, '_');
  if (['inner', 'inner_london', 'london'].includes(v)) return 'inner_london';
  if (['outer', 'outer_london'].includes(v)) return 'outer_london';
  if (['outside', 'outside_london', 'rest_of_uk', 'uk'].includes(v)) return 'outside_london';
  throw new RangeError(`Unknown zone "${input}". Use inner, outer or outside.`);
}

/**
 * Visa length and Immigration Health Surcharge.
 * @param {number} courseMonths
 * @param {any} rules ukvi_rules.yaml
 */
export function visaAndIhs(courseMonths, rules) {
  const { extra_leave_months: extras, ihs_per_year: perYear, ihs_half_year: halfYear } = rules.visa_costs;
  const extra = extras.find((e) => courseMonths >= e.course_months_at_least)?.extra ?? 0;
  const visaMonths = Math.ceil(courseMonths) + extra;
  const years = Math.floor(visaMonths / 12);
  const rest = visaMonths % 12;
  const ihs = years * perYear + (rest > 6 ? perYear : rest > 0 ? halfYear : 0);
  return { visaMonths, ihs };
}

/**
 * Graduate Route length for an application made on `applyDate`.
 * @param {Date} applyDate
 * @param {any} rules
 */
export function graduateRouteMonths(applyDate, rules) {
  const iso = applyDate.toISOString().slice(0, 10);
  const applicable = rules.graduate_route.filter((r) => r.applications_from === null || r.applications_from <= iso);
  return applicable.at(-1).months;
}

/**
 * Full cost of attendance.
 * @param {object} input
 * @param {number} input.tuitionTotal       Whole-course tuition (GBP).
 * @param {number} [input.tuitionYearOne]   Defaults to tuitionTotal for courses ≤ 12 months.
 * @param {number} input.courseMonths
 * @param {string} [input.zone]             inner | outer | outside
 * @param {number} [input.flightsAndSetup]
 * @param {number} [input.livingMonthlyOverride]
 * @param {any} [input.rules]
 * @param {{ monthly: Record<LivingZone, number> }} [input.living]
 * @returns {Promise<CostBreakdown>}
 */
export async function costOfAttendance({ tuitionTotal, tuitionYearOne, courseMonths, zone, flightsAndSetup = 0, livingMonthlyOverride, rules, living }) {
  if (!(courseMonths > 0)) throw new RangeError('courseMonths must be positive.');
  if (!(tuitionTotal >= 0)) throw new RangeError('tuitionTotal must be a non-negative number.');
  rules ??= await loadUkviRules();
  living ??= await loadLivingCosts();
  const z = normaliseZone(zone);
  const monthly = livingMonthlyOverride ?? living.monthly[z];
  const { visaMonths, ihs } = visaAndIhs(courseMonths, rules);
  const fee = rules.visa_costs.application_fee;
  const livingTotal = Math.round(monthly * courseMonths);
  const firstYearMonths = Math.min(12, courseMonths);
  const yearOneTuition = tuitionYearOne ?? (courseMonths <= 12 ? tuitionTotal : Math.round((tuitionTotal * 12) / courseMonths));

  const lines = [
    { label: 'Tuition (whole course)', amount: tuitionTotal },
    { label: `Living costs (${courseMonths} mo × £${monthly.toLocaleString('en-GB')})`, amount: livingTotal, note: z.replace('_', ' ') },
    { label: 'Student visa application', amount: fee },
    { label: `Immigration Health Surcharge (${visaMonths}-month visa)`, amount: ihs },
    ...(flightsAndSetup ? [{ label: 'Flights & setup', amount: flightsAndSetup }] : []),
  ];
  return {
    zone: z,
    courseMonths,
    visaMonths,
    lines,
    total: lines.reduce((sum, l) => sum + l.amount, 0),
    yearOneTotal: yearOneTuition + Math.round(monthly * firstYearMonths) + fee + ihs + flightsAndSetup,
  };
}

/**
 * Compare a cost against the profile budget.
 * @param {CostBreakdown} cost
 * @param {Record<string, any>} budget  profile `budget` block
 * @returns {BudgetFit}
 */
export function budgetFit(cost, budget = {}) {
  const [basis, limit, spend] = typeof budget.max_total_course === 'number'
    ? ['max_total_course', budget.max_total_course, cost.total]
    : typeof budget.max_total_year_one === 'number'
      ? ['max_total_year_one', budget.max_total_year_one, cost.yearOneTotal]
      : [null, null, null];
  if (limit === null) return { limit: null, basis: null, status: 'unknown', headroom: null };
  const headroom = limit - spend;
  const status = headroom >= 0 ? 'within' : -headroom <= limit * 0.1 ? 'stretch' : 'over';
  return { limit, basis, status, headroom };
}

/**
 * Payback-style ROI from salaries the student provides.
 * @param {object} input
 * @param {CostBreakdown} input.cost
 * @param {Record<string, any>} [input.career]  profile `career` block
 * @param {Record<string, any>} [input.budget]  for fx_gbp_to_home
 * @param {Date} [input.courseStart]
 * @param {any} [input.rules]
 * @returns {Promise<RoiEstimate>}
 */
export async function estimateRoi({ cost, career = {}, budget = {}, courseStart, rules }) {
  rules ??= await loadUkviRules();
  const notes = ['Pre-tax figures. Salaries come from your profile, not from Study-Ops.'];
  const fx = typeof budget.fx_gbp_to_home === 'number' && budget.fx_gbp_to_home > 0 ? budget.fx_gbp_to_home : null;
  const toGbp = (amount, currency) => {
    if (typeof amount !== 'number') return null;
    if (!currency || currency === 'GBP') return amount;
    return fx ? amount / fx : null;
  };

  const current = toGbp(career.current_salary_annual, career.current_salary_currency) ?? 0;
  const expected = typeof career.expected_salary_annual_gbp === 'number'
    ? career.expected_salary_annual_gbp
    : toGbp(career.expected_home_salary_annual, career.current_salary_currency);
  if (career.current_salary_annual && current === 0 && career.current_salary_currency !== 'GBP') {
    notes.push('Set budget.fx_gbp_to_home to convert your current salary to GBP.');
  }

  let gradMonths = null;
  let gradNote = null;
  if (courseStart) {
    const end = new Date(courseStart);
    end.setUTCMonth(end.getUTCMonth() + Math.ceil(cost.courseMonths));
    gradMonths = graduateRouteMonths(end, rules);
    gradNote = `Applying around ${end.toISOString().slice(0, 7)} → ${gradMonths}-month Graduate Route.`;
  }

  const forgone = Math.round((current * cost.courseMonths) / 12);
  if (expected === null) {
    notes.push('Add career.expected_salary_annual_gbp (or expected_home_salary_annual) to estimate payback.');
    return { graduateRouteMonths: gradMonths, graduateRouteNote: gradNote, annualUpliftGbp: null, paybackYears: null, fiveYearMultiple: null, forgoneSalaryGbp: forgone || null, notes };
  }

  const uplift = Math.round(expected - current);
  const invested = cost.total + forgone;
  return {
    graduateRouteMonths: gradMonths,
    graduateRouteNote: gradNote,
    annualUpliftGbp: uplift,
    paybackYears: uplift > 0 ? Math.round((invested / uplift) * 10) / 10 : null,
    fiveYearMultiple: invested > 0 ? Math.round(((5 * uplift) / invested) * 100) / 100 : null,
    forgoneSalaryGbp: forgone || null,
    notes: uplift <= 0 ? [...notes, 'Expected salary is not above current salary; no financial payback.'] : notes,
  };
}
