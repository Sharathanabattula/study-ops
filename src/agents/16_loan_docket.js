/**
 * @file Agent 16: Education Loan Docket.
 *
 * Deterministic, no LLM: loan files contain the most sensitive family
 * financial data, so nothing here leaves the machine.
 *
 *  1. Funding plan: cost of attendance (tuition + living + visa + IHS +
 *     travel) minus own funds and confirmed scholarships gives the loan
 *     amount, in GBP and INR.
 *  2. Docket: the lender's document list from `config/lenders.yaml`, picked
 *     by loan type (secured/unsecured) and each co-applicant's employment,
 *     with ✅/⬜ from `data/finance.yaml`.
 *  3. Cost-of-study statement: the table banks ask for, in both currencies.
 *  4. UKVI angle: if the loan will be your visa financial evidence, checks the
 *     sanction letter against UKVI's loan-letter conditions.
 *
 * Output: `outputs/finance/loan-docket-<lender>.md`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { PATHS } from '../lib/paths.js';
import { exists, readYaml } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { formatHome, getRate, toHome } from '../lib/fx.js';
import { costOfAttendance } from './6_cost_roi_mapper.js';

const DAY = 86_400_000;

/** @returns {Promise<Record<string, any>>} */
export async function loadFinance() {
  if (!(await exists(PATHS.finance))) throw new Error('No data/finance.yaml. Run `study-ops init`.');
  return YAML.parse(await fs.readFile(PATHS.finance, 'utf8')) ?? {};
}

/**
 * Funding gap. Pure.
 * @param {import('./6_cost_roi_mapper.js').CostBreakdown} cost
 * @param {Record<string, any>} finance
 */
export function fundingPlan(cost, finance) {
  const own = Number(finance.own_funds_gbp ?? 0) || 0;
  const awards = (finance.scholarships_awarded ?? []).filter((s) => s?.name && s.amount_gbp > 0);
  const scholarships = awards.reduce((sum, s) => sum + Number(s.amount_gbp), 0);
  const gap = Math.max(0, cost.total - own - scholarships);
  const requested = typeof finance.loan?.amount_requested_gbp === 'number' ? finance.loan.amount_requested_gbp : gap;
  return { costTotal: cost.total, own, scholarships, awards, gap, loanGbp: requested, shortfallAfterLoan: Math.max(0, gap - requested) };
}

/**
 * Lender document list for this case. Pure.
 * @param {any} lender     config entry
 * @param {any} common     config.common
 * @param {Record<string, any>} finance
 */
export function docketFor(lender, common, finance) {
  const sections = [];
  const coApps = (finance.co_applicants ?? []).filter((c) => c?.relationship);
  for (const s of lender.sections) {
    if (s === 'co_applicant_income') {
      const kinds = new Set(coApps.map((c) => (c.employment === 'self_employed' ? 'self_employed' : 'salaried')));
      if (!kinds.size) kinds.add('salaried');
      for (const k of kinds) sections.push({ title: `Co-applicant income (${k.replace('_', '-')})`, docs: common[`co_applicant_income_${k}`] });
    } else if (s === 'collateral_if_secured') {
      if (finance.loan?.secured) sections.push({ title: 'Collateral', docs: finance.collateral?.type === 'fd' || finance.collateral?.type === 'lic' ? common.collateral.filter((d) => d.id === 'fd_receipts') : common.collateral.filter((d) => d.id !== 'fd_receipts') });
    } else if (s === 'student_kyc_passport_only') {
      sections.push({ title: 'Student identity', docs: common.student_kyc.filter((d) => d.id === 'student_passport') });
    } else {
      sections.push({ title: s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace('Kyc', 'KYC'), docs: common[s] ?? [] });
    }
  }
  const have = finance.documents ?? {};
  for (const sec of sections) sec.docs = sec.docs.map((d) => ({ ...d, have: Boolean(have[d.id]) }));
  const missing = sections.flatMap((s) => s.docs.filter((d) => !d.have));
  return { sections, missing, total: sections.reduce((n, s) => n + s.docs.length, 0) };
}

/**
 * UKVI loan-letter checks against a planned visa application date. Pure.
 * @param {Record<string, any>} sanction  finance.loan.sanction
 * @param {string} [plannedDate]          YYYY-MM-DD
 */
export function loanLetterChecks(sanction = {}, plannedDate) {
  const out = [];
  if (!sanction.sanction_letter_date) return [{ ok: null, message: 'No sanction letter yet. When it arrives, record its date in data/finance.yaml.' }];
  if (plannedDate) {
    const age = (Date.parse(`${plannedDate}T00:00:00Z`) - Date.parse(`${sanction.sanction_letter_date}T00:00:00Z`)) / DAY;
    out.push(age <= 183
      ? { ok: true, message: `Letter is ${Math.round(age)} days old at your planned visa date (limit ≈ 6 months).` }
      : { ok: false, message: `Letter will be ${Math.round(age)} days old at your planned visa date. Ask the lender to reissue it (limit ≈ 6 months).` });
  }
  out.push({ ok: null, message: 'Confirm the letter states: your name, the amount, that it is for your studies, and that visa grant is the only release condition.' });
  return out;
}

/**
 * Build the docket.
 * @param {object} input
 * @param {string} input.lender                 id in config/lenders.yaml
 * @param {number} input.tuitionTotal
 * @param {number} [input.courseMonths=12]
 * @param {string} [input.zone]
 * @param {number} [input.fx]                   override GBP→INR
 * @param {typeof fetch} [input.fetchImpl]
 */
export async function buildLoanDocket({ lender: lenderId, tuitionTotal, courseMonths = 12, zone, fx, fetchImpl }) {
  const [config, finance, profile] = await Promise.all([readYaml(PATHS.lenders), loadFinance(), loadProfile()]);
  const lender = config.lenders[lenderId];
  if (!lender) throw new Error(`Unknown lender "${lenderId}". Use: ${Object.keys(config.lenders).join(', ')}`);
  if (!(tuitionTotal >= 0)) throw new Error('Tuition is required (--tuition, or an application with fees in the tracker).');

  const cost = await costOfAttendance({
    tuitionTotal, courseMonths, zone: zone ?? (profile.facts.target?.study_location === 'outside-london' ? 'outside' : profile.facts.target?.living_zone ?? 'inner'),
    flightsAndSetup: profile.facts.budget?.flights_and_setup_gbp ?? 0,
  });
  const plan = fundingPlan(cost, finance);
  const rate = await getRate({ override: fx ?? finance.fx_gbp_to_home ?? undefined, fetchImpl });
  const docket = docketFor(lender, config.common, finance);
  const visa = (await exists(PATHS.visa)) ? YAML.parse(await fs.readFile(PATHS.visa, 'utf8')) ?? {} : {};
  const letter = loanLetterChecks(finance.loan?.sanction, visa.application?.planned_date || undefined);

  const inr = (gbp) => formatHome(toHome(gbp, rate.rate, 0, 1), finance.currency_home ?? 'INR');
  const md = [
    `# Education loan docket · ${lender.name}`,
    '',
    `Prepared ${new Date().toISOString().slice(0, 10)} for ${profile.facts.identity?.full_name || 'the applicant'} · rate £1 = ${rate.rate} (${rate.source}, ${rate.date})`,
    '',
    '> Typical document list. Lenders add case-specific requests, so confirm the final list with your loan officer.',
    '',
    '## Funding plan',
    '',
    '| | GBP | INR |', '|---|---|---|',
    `| Cost of attendance | £${plan.costTotal.toLocaleString('en-GB')} | ${inr(plan.costTotal)} |`,
    `| Own funds | − £${plan.own.toLocaleString('en-GB')} | ${inr(plan.own)} |`,
    `| Scholarships | − £${plan.scholarships.toLocaleString('en-GB')} | ${inr(plan.scholarships)} |`,
    `| **Loan needed** | **£${plan.gap.toLocaleString('en-GB')}** | **${inr(plan.gap)}** |`,
    ...(plan.loanGbp !== plan.gap ? [`| Loan requested | £${plan.loanGbp.toLocaleString('en-GB')} | ${inr(plan.loanGbp)} |`, `| Shortfall after loan | £${plan.shortfallAfterLoan.toLocaleString('en-GB')} | ${inr(plan.shortfallAfterLoan)} |`] : []),
    '',
    '## Cost of study (statement for the lender)',
    '',
    '| Item | GBP | INR |', '|---|---|---|',
    ...cost.lines.map((l) => `| ${l.label} | £${l.amount.toLocaleString('en-GB')} | ${inr(l.amount)} |`),
    `| **Total** | **£${cost.total.toLocaleString('en-GB')}** | **${inr(cost.total)}** |`,
    '',
    `## Documents (${docket.total - docket.missing.length}/${docket.total} ready)`,
    '',
    ...docket.sections.flatMap((s) => [`### ${s.title}`, '', ...s.docs.map((d) => `- ${d.have ? '✅' : '⬜'} ${d.label}`), '']),
    '## Lender notes',
    '',
    ...lender.notes.map((n) => `- ${n}`),
    `- More: ${lender.url}`,
    '',
    '## If this loan is your UKVI financial evidence',
    '',
    ...config.ukvi_loan_letter.map((r) => `- ${r}`),
    '',
    ...letter.map((c) => `- ${c.ok === true ? '✅' : c.ok === false ? '❌' : '❔'} ${c.message}`),
    '',
    '> Interest on an education loan from an approved lender may be deductible under Section 80E, but only if the person repaying files under the old tax regime. Ask a tax adviser.',
    '',
  ].join('\n');

  await fs.mkdir(PATHS.financeOutput, { recursive: true });
  const outputPath = path.join(PATHS.financeOutput, `loan-docket-${lenderId}.md`);
  await fs.writeFile(outputPath, md, 'utf8');
  return { lender, cost, plan, rate, docket, letter, outputPath };
}
