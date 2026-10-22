/**
 * @file Agent 3: UKVI Compliance Engine (Student visa, formerly "Tier 4").
 *
 * The critical, zero-hallucination module. Unlike the LLM-backed agents, this
 * one is deterministic: every figure comes from `config/ukvi_rules.yaml`, so
 * the output can be audited line by line against gov.uk.
 *
 * Responsibilities
 *  1. Proof of Funds: outstanding first-year tuition (per CAS) plus living
 *     costs at the London or outside-London monthly rate, capped at 9 months.
 *  2. 28-day timeline: when funds must be in place and which statement
 *     closing dates are acceptable for a given visa application date.
 *  3. Balance-history audit: given daily balances, prove an unbroken 28-day
 *     window at or above the required amount that ends within 31 days of the
 *     application.
 *  4. CAS guardrails: 6-month CAS validity and the 6-month earliest-apply rule.
 *
 * Out of scope for Phase 1: dependants, differentiated evidence for
 * low-risk nationalities, official financial sponsors, accommodation-fee
 * deductions, and the 12-month "established presence" exemption. These are
 * flagged as warnings rather than silently ignored.
 *
 * This is decision support, not legal advice. Re-verify against
 * https://www.gov.uk/student-visa/money before you apply.
 */
import { PATHS } from '../lib/paths.js';
import { readYaml } from '../lib/files.js';

const DAY_MS = 86_400_000;

/**
 * @typedef {'london'|'outside-london'} UkviLocation
 *
 * @typedef {object} UkviRules Shape of `config/ukvi_rules.yaml`.
 * @property {{ max_months: number, rates: Array<{ effective_from: string|null, london_monthly: number, outside_london_monthly: number, status: string, note?: string }> }} maintenance
 * @property {{ consecutive_days: number, max_days_end_before_application: number }} funds_holding
 * @property {{ validity_months: number, earliest_apply_before_course_months: number }} cas
 * @property {string} source
 *
 * @typedef {object} FundsBreakdown
 * @property {UkviLocation} location
 * @property {number} monthlyRate         GBP per month applied.
 * @property {string|null} rateEffectiveFrom
 * @property {string} rateStatus          in_force | announced | superseded
 * @property {number} monthsCounted       ceil(course months), capped at max_months.
 * @property {number} maintenance         monthlyRate × monthsCounted.
 * @property {number} tuitionFirstYear
 * @property {number} tuitionPaid
 * @property {number} tuitionOutstanding  max(0, first-year tuition − paid).
 * @property {number} total               The figure your bank statement must show.
 *
 * @typedef {object} FundsTimeline
 * @property {string} applicationDate
 * @property {string} holdMustStartBy           Latest day funds can land and still give 28 days.
 * @property {string} statementEndEarliest      Earliest acceptable 28-day period end date.
 * @property {string} statementEndLatest        Latest acceptable end date (application day).
 * @property {string|null} earliestApplyDate    Course start − 6 months (if courseStart given).
 * @property {string|null} casExpiresOn         CAS issue + 6 months (if casIssuedOn given).
 *
 * @typedef {object} FundsAudit
 * @property {FundsBreakdown} funds
 * @property {FundsTimeline} timeline
 * @property {{ balance: number, shortfall: number } | null} position
 * @property {string[]} warnings
 * @property {string} source
 */

/**
 * Load UKVI rules from disk.
 * @param {string} [rulesPath]
 * @returns {Promise<UkviRules>}
 */
export async function loadUkviRules(rulesPath = PATHS.ukviRules) {
  return readYaml(rulesPath);
}

/**
 * Normalise user input to a UKVI location.
 *
 * UKVI's "London" means the City of London plus all 32 boroughs, inner AND
 * outer. So both `inner` and `outer` (London) resolve to the London rate;
 * only campuses outside Greater London use the lower rate.
 *
 * @param {string} input london | inner | outer | outside | outside-london
 * @returns {UkviLocation}
 */
export function normaliseLocation(input) {
  const v = String(input).trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['london', 'inner', 'inner-london', 'outer', 'outer-london', 'greater-london'].includes(v)) return 'london';
  if (['outside', 'outside-london', 'non-london', 'rest-of-uk', 'uk'].includes(v)) return 'outside-london';
  throw new RangeError(`Unknown location "${input}". Use "london" (incl. inner/outer boroughs) or "outside".`);
}

/**
 * Pick the maintenance rate in force on a given application date.
 * @param {UkviRules} rules
 * @param {Date} applicationDate
 */
export function selectRate(rules, applicationDate) {
  const iso = toIsoDate(applicationDate);
  const applicable = rules.maintenance.rates.filter((r) => r.effective_from === null || r.effective_from <= iso);
  const rate = applicable.at(-1) ?? rules.maintenance.rates[0];
  return rate;
}

/**
 * Calculate the exact Proof of Funds.
 *
 * Formula: total = max(0, tuitionFirstYear − tuitionPaid)
 *                + monthlyRate(location, applicationDate) × min(ceil(courseMonths), 9)
 *
 * @param {object} input
 * @param {string} input.location        See {@link normaliseLocation}.
 * @param {number} input.courseMonths    Course length in months (part months round up).
 * @param {number} input.tuitionFirstYear Year-one tuition (or whole course if < 1 year), as on CAS.
 * @param {number} [input.tuitionPaid=0] Deposit/fees already paid to the university.
 * @param {Date}   [input.applicationDate=new Date()] Determines which rate applies.
 * @param {UkviRules} input.rules
 * @returns {FundsBreakdown}
 */
export function calculateProofOfFunds({ location, courseMonths, tuitionFirstYear, tuitionPaid = 0, applicationDate = new Date(), rules }) {
  assertNonNegative('courseMonths', courseMonths, { strictlyPositive: true });
  assertNonNegative('tuitionFirstYear', tuitionFirstYear);
  assertNonNegative('tuitionPaid', tuitionPaid);

  const loc = normaliseLocation(location);
  const rate = selectRate(rules, applicationDate);
  const monthlyRate = loc === 'london' ? rate.london_monthly : rate.outside_london_monthly;
  const monthsCounted = Math.min(Math.ceil(courseMonths), rules.maintenance.max_months);
  const maintenance = monthlyRate * monthsCounted;
  const tuitionOutstanding = Math.max(0, tuitionFirstYear - tuitionPaid);

  return {
    location: loc,
    monthlyRate,
    rateEffectiveFrom: rate.effective_from,
    rateStatus: rate.status,
    monthsCounted,
    maintenance,
    tuitionFirstYear,
    tuitionPaid,
    tuitionOutstanding,
    total: maintenance + tuitionOutstanding,
  };
}

/**
 * Build the 28-day bank-statement timeline around a planned application date.
 *
 * Rules modelled:
 *  - Funds held for ≥ 28 consecutive days (inclusive of both ends).
 *  - The 28-day period must END no more than 31 days before the application.
 *  - Applications from outside the UK open 6 months before the course start.
 *  - A CAS can be used within 6 months of issue.
 *
 * @param {object} input
 * @param {Date} input.applicationDate
 * @param {Date} [input.courseStart]
 * @param {Date} [input.casIssuedOn]
 * @param {UkviRules} input.rules
 * @returns {FundsTimeline}
 */
export function buildFundsTimeline({ applicationDate, courseStart, casIssuedOn, rules }) {
  const { consecutive_days: hold, max_days_end_before_application: maxGap } = rules.funds_holding;
  return {
    applicationDate: toIsoDate(applicationDate),
    holdMustStartBy: toIsoDate(addDays(applicationDate, -(hold - 1))),
    statementEndEarliest: toIsoDate(addDays(applicationDate, -maxGap)),
    statementEndLatest: toIsoDate(applicationDate),
    earliestApplyDate: courseStart ? toIsoDate(addMonths(courseStart, -rules.cas.earliest_apply_before_course_months)) : null,
    casExpiresOn: casIssuedOn ? toIsoDate(addMonths(casIssuedOn, rules.cas.validity_months)) : null,
  };
}

/**
 * Verify a daily balance history satisfies the 28-day rule.
 *
 * Walks backwards from the application date looking for a run of
 * `consecutive_days` days, each at or above `required`, whose final day sits
 * within the 31-day window. Missing days are treated as breaks: export a
 * full daily statement.
 *
 * @param {object} input
 * @param {Array<{ date: string, balance: number }>} input.balances  Closing balance per day (YYYY-MM-DD).
 * @param {number} input.required
 * @param {Date} input.applicationDate
 * @param {UkviRules} input.rules
 * @returns {{ compliant: boolean, window: { start: string, end: string } | null, lowestBalance: number | null, reason: string }}
 */
export function checkBalanceHistory({ balances, required, applicationDate, rules }) {
  const { consecutive_days: hold, max_days_end_before_application: maxGap } = rules.funds_holding;
  const byDate = new Map(balances.map((b) => [b.date, b.balance]));
  const latestEnd = toIsoDate(applicationDate);
  const earliestEnd = toIsoDate(addDays(applicationDate, -maxGap));

  for (let end = parseDate(latestEnd); toIsoDate(end) >= earliestEnd; end = addDays(end, -1)) {
    let lowest = Infinity;
    let ok = true;
    for (let i = 0; i < hold; i++) {
      const bal = byDate.get(toIsoDate(addDays(end, -i)));
      if (bal === undefined || bal < required) { ok = false; break; }
      lowest = Math.min(lowest, bal);
    }
    if (ok) {
      return {
        compliant: true,
        window: { start: toIsoDate(addDays(end, -(hold - 1))), end: toIsoDate(end) },
        lowestBalance: lowest,
        reason: `Balance stayed ≥ £${required} for ${hold} consecutive days.`,
      };
    }
  }
  return {
    compliant: false,
    window: null,
    lowestBalance: balances.length ? Math.min(...balances.map((b) => b.balance)) : null,
    reason: `No ${hold}-day run at or above £${required} ending between ${earliestEnd} and ${latestEnd}.`,
  };
}

/**
 * One-shot audit used by `study-ops audit-funds`.
 *
 * @param {object} input
 * @param {string} input.location
 * @param {number} input.durationMonths
 * @param {number} input.tuition            First-year tuition.
 * @param {number} [input.deposit=0]        Already paid to the university.
 * @param {number} [input.balance]          Current funds available, to compute shortfall.
 * @param {Date}   [input.applicationDate]  Defaults to today.
 * @param {Date}   [input.courseStart]
 * @param {Date}   [input.casIssuedOn]
 * @param {UkviRules} [input.rules]         Injected for tests; loaded from disk otherwise.
 * @returns {Promise<FundsAudit>}
 */
export async function auditFunds({
  location,
  durationMonths,
  tuition,
  deposit = 0,
  balance,
  applicationDate = new Date(),
  courseStart,
  casIssuedOn,
  rules,
}) {
  rules ??= await loadUkviRules();
  const funds = calculateProofOfFunds({
    location,
    courseMonths: durationMonths,
    tuitionFirstYear: tuition,
    tuitionPaid: deposit,
    applicationDate,
    rules,
  });
  const timeline = buildFundsTimeline({ applicationDate, courseStart, casIssuedOn, rules });

  /** @type {string[]} */
  const warnings = [];
  if (funds.rateStatus === 'announced') {
    warnings.push(`Using an announced rate effective ${funds.rateEffectiveFrom}. Confirm it is in force on gov.uk.`);
  }
  const upcoming = rules.maintenance.rates.find((r) => r.effective_from && r.effective_from > timeline.applicationDate);
  if (upcoming) {
    warnings.push(`Rates rise on ${upcoming.effective_from} (London £${upcoming.london_monthly}/mo, outside £${upcoming.outside_london_monthly}/mo). Applying on or after that date needs more money.`);
  }
  if (timeline.earliestApplyDate && timeline.applicationDate < timeline.earliestApplyDate) {
    warnings.push(`You cannot apply from outside the UK before ${timeline.earliestApplyDate} (6 months before course start).`);
  }
  if (timeline.casExpiresOn && timeline.applicationDate > timeline.casExpiresOn) {
    warnings.push(`CAS expires ${timeline.casExpiresOn}, before your planned application date.`);
  }
  if (tuition > 0 && deposit >= tuition) {
    warnings.push('Deposit covers all first-year tuition. Make sure the CAS shows fees paid, or UKVI will expect proof.');
  }
  warnings.push('Not modelled: dependants, official sponsors, accommodation-fee deductions, differentiated evidence.');

  const position = typeof balance === 'number'
    ? { balance, shortfall: Math.max(0, funds.total - balance) }
    : null;

  return { funds, timeline, position, warnings, source: rules.source };
}

/* ─────────────────────────── date + validation utils ─────────────────────────── */

/** @param {Date} d */
export function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Parse `YYYY-MM-DD` as a UTC midnight date.
 * @param {string} iso
 */
export function parseDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new RangeError(`Invalid date "${iso}". Use YYYY-MM-DD.`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date "${iso}".`);
  return d;
}

/** @param {Date} d @param {number} n */
function addDays(d, n) {
  return new Date(d.getTime() + n * DAY_MS);
}

/** @param {Date} d @param {number} n Calendar months; clamps to month end. */
function addMonths(d, n) {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return out;
}

/** @param {string} name @param {number} value @param {{ strictlyPositive?: boolean }} [opts] */
function assertNonNegative(name, value, { strictlyPositive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (strictlyPositive && value === 0)) {
    throw new RangeError(`${name} must be a ${strictlyPositive ? 'positive' : 'non-negative'} number (got ${value}).`);
  }
}
