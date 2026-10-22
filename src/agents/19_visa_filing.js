/**
 * @file Agent 19: Student Visa Filing (from India).
 *
 * Builds the complete filing pack for the online Student visa application:
 *  - Document checklist with status (CAS, passport, funds, TB certificate,
 *    ATAS, parental consent, loan letter…), derived from your files.
 *  - Fees: £558 application + Immigration Health Surcharge for the full visa
 *    length. Both are paid inside the online application, so there is no
 *    separate IHS link to generate; the IHS reference appears when you pay.
 *  - Timeline gates: earliest application date, CAS validity, TB certificate
 *    validity, the 28-day funds window, loan-letter age, passport validity.
 *  - Steps: gov.uk application → pay fee + IHS → book biometrics at VFS
 *    Global → attend → decision → eVisa (UKVI account; no BRP).
 *
 * `visa open` launches the assisted browser at the official application
 * start page. Study-Ops fills what it can from applicant.yaml, and the
 * immigration-history and declaration questions are always left to you.
 *
 * Not immigration advice. For advice on your case, use your university's
 * international student advisers or an IAA-regulated adviser.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { PATHS } from '../lib/paths.js';
import { exists, readYaml } from '../lib/files.js';
import { loadUkviRules } from './3_ukvi_compliance_engine.js';
import { visaAndIhs } from './6_cost_roi_mapper.js';
import { casStatus } from './17_cas_tracker.js';
import { assistedFillSession } from './12_form_filler.js';

export const APPLY_URL = 'https://www.gov.uk/student-visa/apply';
export const VFS_INDIA_URL = 'https://visa.vfsglobal.com/ind/en/gbr/';

const DAY = 86_400_000;
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
const monthsBetween = (a, b) => Math.max(1, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (DAY * 30.44)));

/**
 * Build the visa pack. Pure given its inputs.
 * @param {object} input
 * @param {Record<string, any>} input.app         tracker entry (firm choice)
 * @param {Record<string, any>} [input.applicant]
 * @param {Record<string, any>} [input.visa]
 * @param {Record<string, any>} [input.finance]
 * @param {any} input.rules
 * @param {Date} [input.today]
 */
export function visaPack({ app, applicant = {}, visa = {}, finance = {}, rules, today = new Date() }) {
  const cas = app.cas ?? {};
  const planned = visa.application?.planned_date;
  const courseMonths = isIso(cas.course_start) && isIso(cas.course_end) ? monthsBetween(cas.course_start, cas.course_end) : 12;
  const { visaMonths, ihs } = visaAndIhs(courseMonths, rules);
  const fees = { application: rules.visa_costs.application_fee, ihs, total: rules.visa_costs.application_fee + ihs, visaMonths, courseMonths, estimatedCourseLength: !(isIso(cas.course_start) && isIso(cas.course_end)) };

  const parentFunds = visa.parental_funds?.used || (finance.pof_accounts ?? []).some((a) => a?.relationship === 'parent');
  const loanEvidence = (finance.pof_accounts ?? []).some((a) => a?.type === 'loan') || Boolean(finance.loan?.sanction?.sanction_letter_date);
  const docs = [
    { item: 'Current passport (valid for the whole stay)', ok: Boolean(applicant.passport?.number) },
    { item: `CAS reference number${cas.number ? ` (${cas.number})` : ''}`, ok: Boolean(cas.number) },
    { item: 'Financial evidence: statements showing 28 consecutive days, ending ≤ 31 days before you apply', ok: Boolean((finance.pof_accounts ?? []).some((a) => a?.statement_csv)) || null },
    { item: `TB test certificate from a Home Office-approved clinic${visa.tb_test?.date ? ` (${visa.tb_test.date})` : ''}`, ok: isIso(visa.tb_test?.date) },
    ...(app.atas?.required ? [{ item: 'ATAS certificate', ok: isIso(app.atas?.issued_on) }] : []),
    ...(parentFunds ? [
      { item: 'Birth certificate (to show the relationship to the parent account holder)', ok: Boolean(visa.parental_funds?.birth_certificate) },
      { item: "Parent's signed consent letter for use of funds", ok: Boolean(visa.parental_funds?.consent_letter) },
    ] : []),
    ...(loanEvidence ? [{ item: 'Education loan letter meeting UKVI conditions (≤ 6 months old, regulated lender, release only on visa grant)', ok: Boolean(finance.loan?.sanction?.sanction_letter_date) }] : []),
    { item: 'Documents listed on your CAS (academic certificates, English test) if the CAS says they were used to assess you', ok: null },
    { item: 'Certified translations of any document not in English', ok: null },
  ];

  const timeline = [];
  const casGates = casStatus(app, { rules, visa, today });
  if (casGates.dates.earliestVisaApplication) timeline.push({ label: 'Earliest application date (6 months before course start)', date: casGates.dates.earliestVisaApplication, ok: !planned || planned >= casGates.dates.earliestVisaApplication });
  if (casGates.dates.casExpires) timeline.push({ label: 'CAS expires', date: casGates.dates.casExpires, ok: !planned || planned <= casGates.dates.casExpires });
  if (casGates.dates.tbValidUntil) timeline.push({ label: 'TB certificate valid until', date: casGates.dates.tbValidUntil, ok: !planned || planned <= casGates.dates.tbValidUntil });
  if (isIso(planned)) {
    const p = Date.parse(`${planned}T00:00:00Z`);
    const hold = rules.funds_holding.consecutive_days;
    const gap = rules.funds_holding.max_days_end_before_application;
    timeline.push({ label: `Funds must be held from at least (28 days ending on ${planned})`, date: new Date(p - (hold - 1) * DAY).toISOString().slice(0, 10), ok: null });
    timeline.push({ label: 'Earliest acceptable statement end date', date: new Date(p - gap * DAY).toISOString().slice(0, 10), ok: null });
    const sanction = finance.loan?.sanction?.sanction_letter_date;
    if (isIso(sanction)) timeline.push({ label: 'Loan letter date (must be ≤ ~6 months old)', date: sanction, ok: (p - Date.parse(`${sanction}T00:00:00Z`)) / DAY <= 183 });
  }
  if (isIso(applicant.passport?.expiry_date) && isIso(cas.course_end)) {
    timeline.push({ label: 'Passport expiry (should outlast the course + visa leave)', date: applicant.passport.expiry_date, ok: applicant.passport.expiry_date > cas.course_end });
  }

  const steps = [
    `Complete the online application from ${APPLY_URL} (choose "apply from outside the UK"). Have your CAS number and passport ready.`,
    `Pay the £${fees.application} application fee and the £${fees.ihs.toLocaleString('en-GB')} Immigration Health Surcharge inside the application. Note the IHS reference it shows.`,
    `Book a biometrics appointment with VFS Global (${VFS_INDIA_URL}) using the link sent after you submit. Upload documents if asked.`,
    'Attend the appointment with your passport and documents. Keep your own copies of everything.',
    'Wait for a decision (standard service is about 3 weeks after biometrics). Answer any UKVI credibility call calmly and consistently with your application.',
    'When granted: create your UKVI account, link your passport, and check your eVisa. BRPs are no longer issued.',
  ];

  const blocking = [...docs.filter((d) => d.ok === false).map((d) => d.item), ...timeline.filter((t) => t.ok === false).map((t) => `${t.label}: ${t.date}`)];
  return { fees, docs, timeline, steps, blocking, casReady: casGates.gates.find((g) => g.id === 'cas')?.status === 'done' };
}

/** Load everything and write outputs/visa/checklist.md. */
export async function visaChecklist({ id, today } = {}) {
  const tracker = (await exists(PATHS.tracker)) ? await readYaml(PATHS.tracker) : {};
  const visa = (await exists(PATHS.visa)) ? (await readYaml(PATHS.visa)) ?? {} : {};
  const appId = id ?? visa.application_for;
  if (!appId) throw new Error('Which application? Pass the id, or set application_for in data/visa.yaml.');
  const app = (tracker?.applications ?? []).find((a) => a.id === appId);
  if (!app) throw new Error(`No application "${appId}" in data/tracker.yaml.`);
  const applicant = (await exists(PATHS.applicant)) ? YAML.parse(await fs.readFile(PATHS.applicant, 'utf8')) ?? {} : {};
  const finance = (await exists(PATHS.finance)) ? YAML.parse(await fs.readFile(PATHS.finance, 'utf8')) ?? {} : {};
  const pack = visaPack({ app, applicant, visa, finance, rules: await loadUkviRules(), today });

  const tick = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '❔');
  const md = [
    `# Student visa filing pack · ${app.university ?? appId}`,
    '',
    '> Not immigration advice. Rules change, so check gov.uk/student-visa. For advice on your case, ask your university’s international student advisers or an IAA-regulated adviser.',
    '',
    '## Fees',
    '',
    `| Item | Amount |`, `|---|---|`,
    `| Application fee | £${pack.fees.application} |`,
    `| Immigration Health Surcharge (${pack.fees.visaMonths}-month visa${pack.fees.estimatedCourseLength ? ', estimated from a 12-month course' : ''}) | £${pack.fees.ihs.toLocaleString('en-GB')} |`,
    `| **Total** | **£${pack.fees.total.toLocaleString('en-GB')}** |`,
    '',
    'Both are paid inside the online application; there is no separate IHS payment link.',
    '',
    '## Documents',
    '',
    ...pack.docs.map((d) => `- ${tick(d.ok)} ${d.item}`),
    '',
    '## Dates',
    '',
    ...pack.timeline.map((t) => `- ${tick(t.ok)} ${t.label}: **${t.date}**`),
    '',
    '## Steps',
    '',
    ...pack.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## Before you submit',
    '',
    '- Run `study-ops audit-funds … --statements …` on your final statements.',
    '- Run `study-ops interview --type credibility` and practise: course modules, campus location, who is funding you and how, your plans after the course.',
    '- Answer the immigration-history questions yourself, truthfully. Previous refusals anywhere must be declared.',
    '',
  ].join('\n');
  await fs.mkdir(PATHS.visaOutput, { recursive: true });
  const outputPath = path.join(PATHS.visaOutput, 'checklist.md');
  await fs.writeFile(outputPath, md, 'utf8');
  return { ...pack, app, outputPath };
}

/** Open the official application in the assisted browser. */
export async function visaOpen({ onReport } = {}) {
  await assistedFillSession(APPLY_URL, { onReport });
}
