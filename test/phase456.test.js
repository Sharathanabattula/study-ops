import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { recordingClient } from './helpers.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'study-ops-p456-'));
process.env.STUDY_OPS_HOME = home;
process.env.ANTHROPIC_API_KEY = 'test-key';

const { setClient } = await import('../src/llm/claude.js');
const { initWorkspace } = await import('../src/commands/init.js');
const { PATHS } = await import('../src/lib/paths.js');
const { readYaml } = await import('../src/lib/files.js');
const { loadUkviRules, parseDate } = await import('../src/agents/3_ukvi_compliance_engine.js');
const { auditProfile } = await import('../src/agents/4_profile_auditor.js');
const sch = await import('../src/agents/15_scholarship_matcher.js');
const loan = await import('../src/agents/16_loan_docket.js');
const { getRate, toHome, formatHome } = await import('../src/lib/fx.js');
const { casStatus, casSet, casReport } = await import('../src/agents/17_cas_tracker.js');
const st = await import('../src/agents/18_statement_auditor.js');
const { visaPack } = await import('../src/agents/19_visa_filing.js');
const { arrivalChecklist, findAccommodation, PBSA_DOMAINS } = await import('../src/agents/20_arrival_planner.js');
const { findUniversity } = await import('../src/lib/universities.js');

const rules = await loadUkviRules();
const TODAY = new Date('2026-10-22T12:00:00Z');
const FACTS = {
  identity: { full_name: 'Asha Rao', nationality: 'India' },
  target: { level: 'MSc', intake: '2027-09', subjects: ['Finance'], living_zone: 'inner' },
  academics: { cgpa: 8.4, cgpa_scale: 10, cgpa_conversion: 'aicte', institution_tier: 2 },
  experience: { total_months: 18 },
  budget: { flights_and_setup_gbp: 1000 },
};

before(async () => {
  await initWorkspace();
  await fs.writeFile(PATHS.profile, `---\n${YAML.stringify({ schema_version: 1, ...FACTS })}---\n`);
});
after(async () => fs.rm(home, { recursive: true, force: true }));

const audit = await auditProfile({ profile: { facts: FACTS, narrative: {}, raw: '' } });
const schemes = (await readYaml(path.join(process.cwd(), 'config', 'scholarships.yaml'))).schemes;
const scheme = (id) => schemes.find((s) => s.id === id);

/* ───────────── Phase 4: scholarships ───────────── */

test('Chevening: rules checked in code, and the 2027-28 window is reported closed', () => {
  const m = sch.matchScheme(scheme('chevening'), { facts: FACTS, audit, courseMonths: 12, today: TODAY });
  assert.equal(m.eligibility, 'ineligible');
  assert.ok(m.rules.some((r) => r.rule === 'work experience' && r.status === 'fail' && /18 of 24/.test(r.detail)));
  assert.equal(m.window.cycle, '2027-28');
  assert.equal(m.window.status, 'closed');
  const withWork = sch.matchScheme(scheme('chevening'), { facts: { ...FACTS, experience: { total_months: 30 } }, audit, courseMonths: 12, today: new Date('2026-09-01T00:00:00Z') });
  assert.equal(withWork.eligibility, 'check'); // return-home commitment is the student's to confirm
  assert.equal(withWork.window.status, 'open');
  assert.equal(withWork.window.daysLeft, 36);
});

test('Commonwealth excludes MBAs and checks grades; GREAT needs a master’s', () => {
  const mba = sch.matchScheme(scheme('commonwealth-masters-india'), { facts: { ...FACTS, target: { ...FACTS.target, level: 'MBA' } }, audit, courseMonths: 12, today: TODAY });
  assert.ok(mba.rules.some((r) => r.rule === 'level' && r.status === 'fail'));
  const msc = sch.matchScheme(scheme('commonwealth-masters-india'), { facts: FACTS, audit, courseMonths: 12, today: TODAY });
  assert.ok(msc.rules.some((r) => r.rule === 'grades' && r.status === 'pass'));
  const bsc = sch.matchScheme(scheme('great-india'), { facts: { ...FACTS, target: { ...FACTS.target, level: 'BSc' } }, audit, today: TODAY });
  assert.ok(bsc.rules.some((r) => r.rule === 'level' && r.status === 'fail'), "catch-all Master's must not admit a BSc");
  assert.equal(sch.matchScheme(scheme('great-india'), { facts: FACTS, audit, today: TODAY }).window.status, 'unannounced');
  assert.equal(sch.cycleFor('2027-09'), '2027-28');
});

test('university awards are kept only when their own page confirms name and amount', async () => {
  const PAGE = 'https://www.ucl.ac.uk/scholarships/global-masters';
  const pages = { [PAGE]: `<html><body><h1>Global Masters Scholarship</h1><p>Worth £15,000 for students from India.</p>${'<p>Funding details.</p>'.repeat(20)}</body></html>` };
  const fetchImpl = async (u) => new Response(pages[String(u)] ?? '', { status: pages[String(u)] ? 200 : 404 });
  const reqs = recordingClient(setClient, () => JSON.stringify({ awards: [
    { name: 'Global Masters Scholarship', amount: '£15,000', eligibility: 'Indian students', deadline: null, url: PAGE },
    { name: 'Phantom Bursary', amount: '£9,999', eligibility: 'All', deadline: null, url: 'https://www.ucl.ac.uk/missing' },
    { name: 'Off-site Award', amount: null, eligibility: 'All', deadline: null, url: 'https://example.com/award' },
  ] }));
  const ucl = await findUniversity('ucl');
  const r = await sch.findUniversityAwards(ucl, { refresh: true, fetchImpl });
  assert.deepEqual(r.awards.map((a) => a.name), ['Global Masters Scholarship']);
  assert.deepEqual(r.dropped.sort(), ['Off-site Award', 'Phantom Bursary']);
  assert.deepEqual(reqs[0].body.tools[0].allowed_domains, ['ucl.ac.uk']);
});

/* ───────────── Phase 4: loans ───────────── */

test('fx: manual override, live fetch with daily cache, rounding', async () => {
  assert.equal((await getRate({ override: 110 })).rate, 110);
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ date: '2026-10-21', rates: { INR: 111.25 } })); };
  assert.equal((await getRate({ fetchImpl })).rate, 111.25);
  await getRate({ fetchImpl });
  assert.equal(calls, 1, 'cached for the day');
  assert.equal(toHome(47130, 112, 0.05), 5543000);
  assert.equal(formatHome(5543000), '₹55,43,000');
});

test('loan docket: funding gap, lender-specific sections, letter age', async () => {
  const cost = { total: 60000, lines: [] };
  const plan = loan.fundingPlan(cost, { own_funds_gbp: 15000, scholarships_awarded: [{ name: 'GREAT', amount_gbp: 10000 }, { name: '', amount_gbp: 0 }] });
  assert.equal(plan.gap, 35000);

  const config = await readYaml(path.join(process.cwd(), 'config', 'lenders.yaml'));
  const finance = { loan: { secured: true }, co_applicants: [{ relationship: 'Father', employment: 'self_employed' }, { relationship: 'Mother', employment: 'salaried' }], documents: { offer_letter: true } };
  const credila = loan.docketFor(config.lenders.credila, config.common, finance);
  const titles = credila.sections.map((s) => s.title);
  assert.ok(titles.includes('Co-applicant income (self-employed)') && titles.includes('Co-applicant income (salaried)') && titles.includes('Collateral'));
  assert.ok(credila.sections.flatMap((s) => s.docs).find((d) => d.id === 'offer_letter').have);
  const prodigy = loan.docketFor(config.lenders.prodigy, config.common, finance);
  assert.ok(!prodigy.sections.some((s) => /Co-applicant|Collateral/.test(s.title)), 'Prodigy needs no co-applicant or collateral');

  const old = loan.loanLetterChecks({ sanction_letter_date: '2026-11-01' }, '2027-06-15');
  assert.equal(old[0].ok, false);
  assert.equal(loan.loanLetterChecks({ sanction_letter_date: '2027-03-01' }, '2027-06-15')[0].ok, true);
});

test('loan docket end to end writes a GBP/INR statement and checklist', async () => {
  const fin = YAML.parse(await fs.readFile(PATHS.finance, 'utf8'));
  fin.own_funds_gbp = 20000;
  fin.co_applicants = [{ relationship: 'Father', employment: 'salaried', annual_income_inr: 1800000 }];
  await fs.writeFile(PATHS.finance, YAML.stringify(fin));
  const r = await loan.buildLoanDocket({ lender: 'sbi', tuitionTotal: 38000, courseMonths: 12, zone: 'inner', fx: 112 });
  assert.equal(r.plan.costTotal, 38000 + 1529 * 12 + 558 + 1164 + 1000);
  const md = await fs.readFile(r.outputPath, 'utf8');
  assert.match(md, /\*\*Loan needed\*\* \| \*\*£39,070\*\* \| \*\*₹43,75,840\*\*/);
  assert.match(md, /Co-applicant income \(salaried\)/);
  assert.match(md, /visa grant is the only condition|only condition for release/);
  await assert.rejects(loan.buildLoanDocket({ lender: 'nope', tuitionTotal: 1 }), /Unknown lender/);
});

/* ───────────── Phase 5: CAS ───────────── */

const APP = {
  id: 'ucl-msc-finance', university: 'University College London', short_name: 'UCL', programme: 'MSc Finance', status: 'offer_conditional',
  offer: { type: 'conditional', conditions: ['Final transcript', 'IELTS 7.0'], conditions_met: ['IELTS 7.0'] },
  fees: { deposit_amount: 5000, deposit_paid: 0 },
  atas: { required: true, applied_on: '2027-03-01' },
  pre_cas: {}, cas: { course_start: '2027-09-27' },
};

test('CAS gates: the first unmet gate is the next action; ATAS and TB dates computed', () => {
  const r = casStatus(APP, { rules, visa: { tb_test: { date: '2026-12-01' }, application: { planned_date: '2027-07-01' } }, today: TODAY });
  assert.equal(r.gates[0].status, 'pending');
  assert.match(r.next, /Final transcript/);
  assert.equal(r.gates.find((g) => g.id === 'atas').status, 'pending');
  assert.equal(r.dates.atasExpected, '2027-04-12'); // 30 working days after 1 Mar 2027
  assert.equal(r.dates.earliestVisaApplication, '2027-03-27');
  assert.ok(r.warnings.some((w) => /TB certificate expires 2027-06-01/.test(w)));
  assert.equal(r.ready, false);

  const done = casStatus({ ...APP, status: 'cas_issued', offer: { ...APP.offer, conditions_met: APP.offer.conditions, firm_accepted_on: '2027-04-01' }, fees: { deposit_amount: 5000, deposit_paid: 5000 }, atas: { required: true, issued_on: '2027-04-20' }, pre_cas: { documents_submitted: true, finance_check_passed: true, credibility_interview_passed: true }, cas: { ...APP.cas, number: 'E4G7H8J9K0L1M2', issued_on: '2027-06-01' } }, { rules, visa: { tb_test: { date: '2027-05-01' } }, today: TODAY });
  assert.equal(done.ready, true);
  assert.equal(done.dates.casExpires, '2027-12-01');
  assert.match(done.next, /visa checklist/);
});

test('cas set records progress in the tracker', async () => {
  const tracker = YAML.parse(await fs.readFile(PATHS.tracker, 'utf8'));
  tracker.applications.push(structuredClone(APP));
  await fs.writeFile(PATHS.tracker, YAML.stringify(tracker));
  const r = await casSet('ucl-msc-finance', { conditionMet: 'Final transcript', firm: '2027-04-01', depositPaid: 5000 });
  assert.equal(r.gates.find((g) => g.id === 'offer').status, 'done');
  assert.equal(r.gates.find((g) => g.id === 'deposit').status, 'done');
  assert.equal((await casReport('ucl-msc-finance')).app.offer.conditions_met.length, 2);
});

/* ───────────── Phase 5: statements & 28-day rule ───────────── */

test('bank formats: dates, amounts, header detection, newest-first order', () => {
  assert.equal(st.parseBankDate('14/05/2027'), '2027-05-14');
  assert.equal(st.parseBankDate('14-05-27'), '2027-05-14');
  assert.equal(st.parseBankDate('14 May 2027'), '2027-05-14');
  assert.equal(st.parseBankDate('14-May-2027'), '2027-05-14');
  assert.equal(st.parseAmount('1,23,456.78 Cr'), 123456.78);
  assert.equal(st.parseAmount('500.00 Dr'), -500);
  const csv = 'Account: XXXX\n\nDate,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance\n03/06/2027,UPI,100,,"9,900"\n01/06/2027,OPENING,,"10,000","10,000"\nTotal,,,,';
  const { rows, columns } = st.parseStatementCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(columns.balance, 'closing balance');
  const days = st.dailyBalances(rows);
  assert.deepEqual([...days], [['2027-06-01', 10000], ['2027-06-02', 10000], ['2027-06-03', 9900]], 'no-transaction days carry the balance forward');
});

/** Build a statement: one row every `step` days with the given balance function. */
function statement(from, to, balanceOn, step = 4, extra = {}) {
  const lines = ['Txn Date,Description,Debit,Credit,Balance'];
  for (let d = parseDate(from); d <= parseDate(to); d = new Date(d.getTime() + step * 86_400_000)) {
    const iso = d.toISOString().slice(0, 10);
    const [y, m, dd] = iso.split('-');
    lines.push(`${dd}/${m}/${y},TXN,,${extra[iso] ? `"${extra[iso]}"` : ''},"${balanceOn(iso).toLocaleString('en-IN')}"`);
  }
  return lines.join('\n');
}

test('28-day audit passes on sparse statements and fails on a single dip', async () => {
  const required = 5_300_000;
  const ok = await st.auditStatements({ texts: [statement('2027-05-01', '2027-06-29', () => 5_400_000)], required, applicationDate: parseDate('2027-07-01'), rules });
  assert.equal(ok.compliant, true, 'transactions every 4 days still give 28 continuous days');
  assert.equal(ok.headroom, 100_000);

  // 28 clean days ending inside the 31-day window would still pass (UKVI's rule), so the
  // statement starts late enough that every possible window contains the dip.
  const dip = await st.auditStatements({ texts: [statement('2027-05-25', '2027-06-29', (iso) => (iso >= '2027-06-10' && iso < '2027-06-14' ? 5_000_000 : 5_400_000), 1)], required, applicationDate: parseDate('2027-07-01'), rules });
  assert.equal(dip.compliant, false, 'a 4-day dip leaves no 28-day run ending in the window');
  assert.equal(dip.dips.length, 4);
  assert.equal(dip.dips[0].short, 300_000);

  const credit = await st.auditStatements({ texts: [statement('2027-05-01', '2027-06-29', () => 5_400_000, 4, { '2027-06-02': '2,000,000' })], required, applicationDate: parseDate('2027-07-01'), rules });
  assert.ok(credit.notes.some((n) => /large credit/.test(n)));

  const stale = await st.auditStatements({ texts: [statement('2027-03-01', '2027-04-20', () => 5_400_000)], required, applicationDate: parseDate('2027-07-01'), rules });
  assert.equal(stale.compliant, false);
  assert.ok(stale.notes.some((n) => /more than 31 days before/.test(n)));
});

test('rows with unquoted thousands separators stop the audit instead of corrupting balances', () => {
  assert.throws(() => st.parseStatementCsv('Date,Narration,Credit,Balance\n01/06/2027,SALARY,2,000,000,"54,00,000"'), /more or fewer columns/);
});

test('two accounts are summed day by day', async () => {
  const a = statement('2027-05-20', '2027-06-29', () => 3_000_000, 5);
  const b = statement('2027-05-20', '2027-06-29', () => 2_500_000, 7);
  const r = await st.auditStatements({ texts: [a, b], required: 5_300_000, applicationDate: parseDate('2027-07-01'), rules });
  assert.equal(r.compliant, true);
  assert.ok(r.notes.some((n) => /2 accounts combined/.test(n)));
});

/* ───────────── Phase 5: visa filing ───────────── */

test('visa pack: fee + IHS, conditional documents, date gates', () => {
  const app = { ...APP, atas: { required: true, issued_on: '2027-04-20' }, cas: { number: 'E4G7', issued_on: '2027-06-01', course_start: '2027-09-27', course_end: '2028-09-26' } };
  const pack = visaPack({
    app,
    applicant: { passport: { number: 'K1234567', expiry_date: '2032-01-01' } },
    visa: { tb_test: { date: '2026-12-01' }, application: { planned_date: '2027-07-01' }, parental_funds: { used: true, birth_certificate: true, consent_letter: false } },
    finance: { pof_accounts: [{ relationship: 'parent', statement_csv: 'x.csv' }], loan: { sanction: { sanction_letter_date: '2026-11-01' } } },
    rules, today: TODAY,
  });
  assert.deepEqual([pack.fees.application, pack.fees.ihs, pack.fees.total], [558, 1164, 1722]);
  assert.ok(pack.docs.some((d) => /consent letter/.test(d.item) && d.ok === false));
  assert.ok(pack.docs.some((d) => /ATAS/.test(d.item) && d.ok === true));
  assert.ok(pack.blocking.some((b) => /TB certificate valid until/.test(b)));
  assert.ok(pack.blocking.some((b) => /Loan letter/.test(b)));
  assert.ok(pack.steps.some((s) => /eVisa/.test(s) && /BRPs are no longer issued/.test(s)));
  assert.ok(pack.steps.some((s) => /inside the application/.test(s)), 'IHS is paid within the application');
});

/* ───────────── Phase 6: arrival ───────────── */

test('arrival checklist reflects current rules: eVisa, no BRP, no police registration', () => {
  const sections = arrivalChecklist({ courseStart: '2027-09-27', rules });
  const all = sections.flatMap((s) => s.items).join('\n');
  assert.match(all, /BRPs are no longer issued/);
  assert.match(all, /Police registration is not required/);
  assert.match(all, /20 hours per week/);
  assert.equal(sections[0].when, '2027-08-28');
});

test('housing: listings verified on their own pages, prices only if stated there', async () => {
  const A = 'https://www.unite-students.com/london/stratford-one';
  const B = 'https://www.iqstudentaccommodation.com/london/makauley';
  const pages = {
    [A]: `<html><body><h1>Stratford One</h1><p>Rooms from £289 per week.</p>${'<p>Bills included.</p>'.repeat(20)}</body></html>`,
    [B]: `<html><body><h1>Makauley Lodge</h1><p>Contact us for prices.</p>${'<p>On-site gym and study rooms.</p>'.repeat(20)}</body></html>`,
  };
  const fetchImpl = async (u) => new Response(pages[String(u)] ?? '', { status: pages[String(u)] ? 200 : 404 });
  const reqs = recordingClient(setClient, () => JSON.stringify({ listings: [
    { name: 'Stratford One', operator: 'Unite Students', kind: 'pbsa', weekly_price: 'from £289 per week', contract_weeks: 51, distance_or_travel: '20 min by tube', url: A },
    { name: 'Makauley Lodge', operator: 'iQ', kind: 'pbsa', weekly_price: '£199 per week', contract_weeks: 44, distance_or_travel: null, url: B },
    { name: 'Ghost Halls', operator: 'Nobody', kind: 'private', weekly_price: '£99', contract_weeks: null, distance_or_travel: null, url: 'https://www.unite-students.com/missing' },
  ] }));
  const r = await findAccommodation({ university: 'qmul', campus: 'Mile End', maxWeekly: 250, fetchImpl });
  assert.deepEqual(r.listings.map((l) => l.name).sort(), ['Makauley Lodge', 'Stratford One']);
  assert.deepEqual(r.dropped, ['Ghost Halls']);
  const stratford = r.listings.find((l) => l.name === 'Stratford One');
  assert.equal(stratford.weekly, 289);
  assert.equal(stratford.overCeiling, true);
  assert.equal(r.listings.find((l) => l.name === 'Makauley Lodge').weekly_price, null, '£199 is not on the page, so it is not shown');
  const domains = reqs[0].body.tools[0].allowed_domains;
  assert.ok(domains.includes('qmul.ac.uk') && PBSA_DOMAINS.every((d) => domains.includes(d)));
});
