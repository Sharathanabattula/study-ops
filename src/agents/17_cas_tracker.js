/**
 * @file Agent 17: CAS Tracker.
 *
 * A CAS is issued only when every gate before it is cleared. This agent turns
 * a tracker entry into an ordered checklist of those gates, says which one
 * blocks the CAS right now, and computes the dates that follow from it.
 *
 * Gates, in order:
 *  1. Offer conditions met (unconditional offer)
 *  2. Offer firmly accepted
 *  3. Tuition deposit paid (amount from the offer)
 *  4. ATAS certificate, if the course needs one (≈30 working days)
 *  5. Pre-CAS documents uploaded (passport, final transcripts, financial evidence)
 *  6. University finance check, if it runs one
 *  7. Credibility / pre-CAS interview, if it holds one
 *  8. CAS requested → CAS issued (number, date)
 *
 * Dates: earliest visa application (course start − 6 months, from outside the
 * UK), CAS expiry (issue + 6 months), ATAS expected date, TB certificate
 * validity on the planned visa date.
 */
import { PATHS } from '../lib/paths.js';
import { exists, readYaml } from '../lib/files.js';
import { upsertApplication } from '../lib/tracker.js';
import { loadUkviRules } from './3_ukvi_compliance_engine.js';

const DAY = 86_400_000;
const AFTER_FIRM = new Set(['firm_accepted', 'deposit_paid', 'cas_requested', 'cas_issued', 'visa_submitted', 'visa_granted', 'enrolled']);

/** @typedef {{ id: string, label: string, status: 'done'|'pending'|'todo'|'check'|'n/a', detail: string, action?: string }} Gate */

const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
const addMonths = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.toISOString().slice(0, 10);
};
/** Add working days (Mon–Fri). */
const addWorkingDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() % 6 !== 0) n--;
  }
  return d.toISOString().slice(0, 10);
};

/**
 * Compute CAS gates and dates. Pure.
 * @param {Record<string, any>} app   tracker entry
 * @param {object} ctx
 * @param {any} ctx.rules             ukvi_rules.yaml
 * @param {Record<string, any>} [ctx.visa]  data/visa.yaml
 * @param {Date} [ctx.today]
 */
export function casStatus(app, { rules, visa = {}, today = new Date() }) {
  const offer = app.offer ?? {};
  const fees = app.fees ?? {};
  const atas = app.atas ?? {};
  const pre = app.pre_cas ?? {};
  const cas = app.cas ?? {};
  /** @type {Gate[]} */
  const gates = [];

  const conditions = offer.conditions ?? [];
  const met = new Set((offer.conditions_met ?? []).map((c) => String(c).toLowerCase()));
  const open = conditions.filter((c) => !met.has(String(c).toLowerCase()));
  if (!offer.type) gates.push({ id: 'offer', label: 'Offer received', status: 'todo', detail: 'No offer recorded.', action: 'Record your offer in the tracker (offer.type, offer.conditions).' });
  else if (offer.type === 'unconditional' || !open.length) gates.push({ id: 'offer', label: 'Unconditional offer', status: 'done', detail: conditions.length ? `All ${conditions.length} condition(s) met.` : 'Unconditional.' });
  else gates.push({ id: 'offer', label: 'Unconditional offer', status: 'pending', detail: `Outstanding: ${open.join('; ')}`, action: `Meet and send evidence for: ${open[0]}` });

  const firm = Boolean(offer.firm_accepted_on) || AFTER_FIRM.has(app.status);
  gates.push(firm ? { id: 'firm', label: 'Offer firmly accepted', status: 'done', detail: offer.firm_accepted_on ?? 'Yes.' } : { id: 'firm', label: 'Offer firmly accepted', status: 'todo', detail: 'Not yet.', action: 'Accept the offer in the portal (firm choice).' });

  if (fees.deposit_amount == null) gates.push({ id: 'deposit', label: 'Tuition deposit', status: 'check', detail: 'Deposit amount unknown.', action: 'Check the offer letter for the deposit amount and deadline; record fees.deposit_amount.' });
  else if ((fees.deposit_paid ?? 0) >= fees.deposit_amount) gates.push({ id: 'deposit', label: 'Tuition deposit', status: 'done', detail: `£${fees.deposit_paid.toLocaleString('en-GB')} paid.` });
  else gates.push({ id: 'deposit', label: 'Tuition deposit', status: 'todo', detail: `£${(fees.deposit_paid ?? 0).toLocaleString('en-GB')} of £${fees.deposit_amount.toLocaleString('en-GB')} paid.`, action: `Pay the £${(fees.deposit_amount - (fees.deposit_paid ?? 0)).toLocaleString('en-GB')} deposit${app.deadlines?.deposit ? ` by ${app.deadlines.deposit}` : ''} and keep the receipt.` });

  let atasExpected = null;
  if (atas.required === false) gates.push({ id: 'atas', label: 'ATAS certificate', status: 'n/a', detail: 'Not required for this course.' });
  else if (atas.required == null) gates.push({ id: 'atas', label: 'ATAS certificate', status: 'check', detail: 'Unknown whether this course needs ATAS.', action: 'Check the offer letter or ask admissions whether ATAS applies; set atas.required.' });
  else if (isIso(atas.issued_on)) gates.push({ id: 'atas', label: 'ATAS certificate', status: 'done', detail: `Issued ${atas.issued_on}; use within ${rules.atas.certificate_valid_months} months (until ${addMonths(atas.issued_on, rules.atas.certificate_valid_months)}).` });
  else if (isIso(atas.applied_on)) {
    atasExpected = addWorkingDays(atas.applied_on, rules.atas.typical_processing_working_days);
    gates.push({ id: 'atas', label: 'ATAS certificate', status: 'pending', detail: `Applied ${atas.applied_on}; typically about ${rules.atas.typical_processing_working_days} working days (≈ ${atasExpected}), often longer in peak season.` });
  } else gates.push({ id: 'atas', label: 'ATAS certificate', status: 'todo', detail: 'Required but not applied for.', action: 'Apply for ATAS now (free; allow 6+ weeks). The CAS will not be issued without it.' });

  gates.push(pre.documents_submitted
    ? { id: 'docs', label: 'Pre-CAS documents', status: 'done', detail: 'Submitted.' }
    : { id: 'docs', label: 'Pre-CAS documents', status: 'todo', detail: 'Passport, final transcripts/certificates, English test, financial evidence.', action: 'Upload pre-CAS documents in the portal (passport, transcripts, funds evidence).' });

  gates.push(pre.finance_check_passed
    ? { id: 'finance', label: 'University finance check', status: 'done', detail: 'Passed.' }
    : { id: 'finance', label: 'University finance check', status: 'check', detail: 'Many universities review your funds before issuing a CAS.', action: 'Ask whether your university runs a finance check; if so, send statements meeting the 28-day rule.' });

  if (pre.credibility_interview_passed) gates.push({ id: 'interview', label: 'Credibility interview', status: 'done', detail: 'Passed.' });
  else if (isIso(pre.credibility_interview_on)) gates.push({ id: 'interview', label: 'Credibility interview', status: 'pending', detail: `Scheduled ${pre.credibility_interview_on}.`, action: 'Prepare: study-ops interview --type credibility' });
  else gates.push({ id: 'interview', label: 'Credibility interview', status: 'check', detail: 'Some universities interview before issuing a CAS.', action: 'Prepare anyway: study-ops interview --type credibility' });

  if (cas.number && isIso(cas.issued_on)) gates.push({ id: 'cas', label: 'CAS issued', status: 'done', detail: `${cas.number} on ${cas.issued_on}.` });
  else if (isIso(cas.requested_on)) gates.push({ id: 'cas', label: 'CAS issued', status: 'pending', detail: `Requested ${cas.requested_on}.` });
  else gates.push({ id: 'cas', label: 'CAS issued', status: 'todo', detail: 'Not requested.', action: 'Request your CAS once the gates above are clear.' });

  // Dates
  const dates = {};
  if (isIso(cas.course_start)) dates.earliestVisaApplication = addMonths(cas.course_start, -rules.cas.earliest_apply_before_course_months);
  if (isIso(cas.issued_on)) dates.casExpires = addMonths(cas.issued_on, rules.cas.validity_months);
  if (atasExpected) dates.atasExpected = atasExpected;
  const planned = visa.application?.planned_date;
  const warnings = [];
  if (isIso(visa.tb_test?.date)) {
    dates.tbValidUntil = addMonths(visa.tb_test.date, rules.tb_test.certificate_valid_months);
    if (isIso(planned) && dates.tbValidUntil < planned) warnings.push(`TB certificate expires ${dates.tbValidUntil}, before your planned visa date ${planned}. Retake it closer to applying.`);
  } else warnings.push('No TB test recorded. Indian applicants staying over 6 months need a certificate from a Home Office-approved clinic.');
  if (isIso(planned) && dates.casExpires && planned > dates.casExpires) warnings.push(`Planned visa date ${planned} is after the CAS expires (${dates.casExpires}).`);
  if (isIso(planned) && dates.earliestVisaApplication && planned < dates.earliestVisaApplication) warnings.push(`You can't apply before ${dates.earliestVisaApplication} (6 months before the course starts).`);
  if (isIso(cas.course_start)) {
    const daysToStart = Math.ceil((Date.parse(`${cas.course_start}T00:00:00Z`) - today) / DAY);
    if (daysToStart < 45 && !gates.find((g) => g.id === 'cas' && g.status === 'done')) warnings.push(`${daysToStart} days to course start and no CAS yet. Standard visa processing is about 3 weeks after biometrics.`);
  }

  const blocking = gates.find((g) => g.status === 'todo' || g.status === 'pending');
  const next = blocking?.action ?? gates.find((g) => g.status === 'check')?.action ?? 'CAS issued. Next: study-ops visa checklist';
  return { gates, dates, warnings, next, ready: gates.every((g) => g.status === 'done' || g.status === 'n/a' || g.status === 'check') };
}

/** Load tracker + visa file and compute status for one application. */
export async function casReport(id, { today } = {}) {
  const tracker = (await exists(PATHS.tracker)) ? await readYaml(PATHS.tracker) : {};
  const app = (tracker?.applications ?? []).find((a) => a.id === id);
  if (!app) throw new Error(`No application "${id}" in data/tracker.yaml.`);
  const visa = (await exists(PATHS.visa)) ? await readYaml(PATHS.visa) : {};
  return { app, ...casStatus(app, { rules: await loadUkviRules(), visa: visa ?? {}, today }) };
}

/**
 * Record CAS progress.
 * @param {string} id
 * @param {Record<string, any>} c  CLI options
 */
export async function casSet(id, c) {
  const { app } = await casReport(id);
  const entry = { id };
  const set = (pathKeys, v) => {
    if (v === undefined) return;
    let o = entry;
    for (const k of pathKeys.slice(0, -1)) o = o[k] ??= {};
    o[pathKeys.at(-1)] = v;
  };
  set(['offer', 'type'], c.offerType);
  if (c.condition) set(['offer', 'conditions'], [...new Set([...(app.offer?.conditions ?? []), c.condition])]);
  if (c.conditionMet) set(['offer', 'conditions_met'], [...new Set([...(app.offer?.conditions_met ?? []), c.conditionMet])]);
  set(['offer', 'firm_accepted_on'], c.firm);
  set(['fees', 'deposit_amount'], c.depositAmount);
  set(['fees', 'deposit_paid'], c.depositPaid);
  set(['atas', 'required'], c.atasRequired === undefined ? undefined : c.atasRequired === 'yes');
  set(['atas', 'applied_on'], c.atasApplied);
  set(['atas', 'issued_on'], c.atasIssued);
  set(['pre_cas', 'documents_submitted'], c.preCasDocs);
  set(['pre_cas', 'finance_check_passed'], c.financeCheck);
  set(['pre_cas', 'credibility_interview_on'], c.interview);
  set(['pre_cas', 'credibility_interview_passed'], c.interviewPassed);
  set(['cas', 'requested_on'], c.casRequested);
  set(['cas', 'issued_on'], c.casIssued);
  set(['cas', 'number'], c.casNumber);
  set(['cas', 'course_start'], c.courseStart);
  set(['cas', 'course_end'], c.courseEnd);
  if (c.casIssued && c.casNumber) set(['status'], 'cas_issued');
  else if (c.casRequested) set(['status'], 'cas_requested');
  else if (c.depositPaid !== undefined && c.depositAmount !== undefined && c.depositPaid >= c.depositAmount) set(['status'], 'deposit_paid');
  else if (c.firm) set(['status'], 'firm_accepted');
  await upsertApplication(entry);
  return casReport(id);
}
