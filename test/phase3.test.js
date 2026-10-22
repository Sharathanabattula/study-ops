import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import YAML from 'yaml';
import { recordingClient } from './helpers.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'study-ops-p3-'));
process.env.STUDY_OPS_HOME = home;
process.env.ANTHROPIC_API_KEY = 'test-key';
if (!process.env.STUDY_OPS_CHROMIUM && existsSync('/opt/pw-browsers/chromium')) process.env.STUDY_OPS_CHROMIUM = '/opt/pw-browsers/chromium';

const { setClient } = await import('../src/llm/claude.js');
const { formatFor, isProtected, CATALOG } = await import('../src/lib/applicant.js');
const { auditApplicant } = await import('../src/agents/11_application_auditor.js');
const filler = await import('../src/agents/12_form_filler.js');
const { portalRow, portalSet, portalDashboard } = await import('../src/agents/13_portal_manager.js');
const { generateInterviewBank, practiceSession, answerChecks } = await import('../src/agents/14_interview_prep.js');
const { initWorkspace } = await import('../src/commands/init.js');
const { PATHS } = await import('../src/lib/paths.js');
const { openHeadless } = await import('../src/lib/browser.js');
const { loadFramework } = await import('../src/lib/sop_framework.js');

const APPLICANT = {
  personal: { title: 'Ms', given_names: 'Asha', family_name: 'Rao', preferred_name: 'Asha', date_of_birth: '2002-05-14', sex: 'F', country_of_birth: 'India', city_of_birth: 'Hyderabad', nationality: 'India' },
  passport: { number: 'K1234567', issue_date: '2022-03-01', expiry_date: '2032-02-28', issuing_country: 'India', place_of_issue: 'Hyderabad' },
  contact: { email: 'asha.rao@example.com', phone: '+91 98765 43210' },
  address: { line1: '12 MG Road', city: 'Hyderabad', state: 'Telangana', postcode: '500001', country: 'India' },
  education: [
    { institution: 'VIT University', country: 'India', qualification: 'B.Tech', subject: 'Biotechnology', start_date: '2020-08-01', end_date: '2024-05-31', grade: '8.4 CGPA', grading_scale: '10-point CGPA' },
    { institution: 'Narayana Junior College', country: 'India', qualification: 'Class XII', subject: 'PCB', start_date: '2018-06-01', end_date: '2020-03-31', grade: '94%' },
  ],
  employment: [{ employer: 'Helix CRO', job_title: 'Analyst', start_date: '2024-07-01', end_date: '' }],
  english_test: { test: 'IELTS Academic UKVI', test_date: '2026-06-01', reference_number: '26IN012345RAOA', overall: 7, listening: 7.5, reading: 7, writing: 6, speaking: 7 },
  referees: [{ name: 'Dr K Iyer', email: 'k.iyer@vit.ac.in' }, { name: 'M Shah', email: 'mshah@gmail.com' }],
  immigration: { requires_visa: true, visa_refusals: false },
};
const PROFILE = { identity: { full_name: 'Asha Rao' }, target: { intake: '2027-09', level: 'MSc' }, academics: { cgpa: 8.4 }, english: { overall: 7, bands: { listening: 7.5, reading: 7, writing: 6, speaking: 7 } } };
const SECRETS = ['K1234567', 'asha.rao@example.com', '2002-05-14', '98765', '12 MG Road', '500001', '26IN012345RAOA'];

before(async () => {
  await initWorkspace();
  await fs.writeFile(PATHS.applicant, YAML.stringify(APPLICANT));
  await fs.writeFile(PATHS.profile, `---\n${YAML.stringify({ schema_version: 1, ...PROFILE })}---\n`);
});
after(async () => fs.rm(home, { recursive: true, force: true }));

/* ───────────── Formatting, protection, matching ───────────── */

test('values are formatted for each field type', () => {
  const dob = CATALOG.find((c) => c.key === 'personal.date_of_birth');
  assert.equal(formatFor('2002-05-14', dob, { type: 'text', placeholder: 'DD/MM/YYYY' }), '14/05/2002');
  assert.equal(formatFor('2002-05-14', dob, { type: 'text', placeholder: 'MM/DD/YYYY' }), '05/14/2002');
  assert.equal(formatFor('2002-05-14', dob, { type: 'date' }), '2002-05-14');
  assert.equal(formatFor('2002-05-14', dob, { type: 'select' }, 'month'), 'May');
  assert.equal(formatFor('2002-05-14', dob, { type: 'select' }, 'day'), '14');
  const phone = CATALOG.find((c) => c.key === 'contact.phone');
  assert.equal(formatFor('+91 98765 43210', phone, { type: 'text' }, 'country_code'), '+91');
  assert.equal(formatFor('+91 98765 43210', phone, { type: 'text' }, 'number'), '9876543210');
  assert.equal(formatFor('1234567890', CATALOG.find((c) => c.key === 'ucas.personal_id'), { type: 'text' }), '123-456-7890');
  assert.equal(filler.chooseOption(['Please select', 'Republic of India', 'Nepal'], 'India'), 'Republic of India');
  assert.equal(filler.chooseOption(['Jan', 'Feb', 'Mar', 'Apr', 'May'], 'May'), 'May');
});

test('declarations, convictions, health, equality monitoring and passwords are protected', () => {
  for (const label of ['Do you have any unspent criminal convictions?', 'I confirm the information is true and complete', 'Do you have a disability?', 'Ethnic origin', 'Password', 'Religion or belief']) {
    assert.ok(isProtected({ label, type: 'text' }), label);
  }
  assert.ok(isProtected({ label: 'Upload CV', type: 'file' }));
  assert.ok(!isProtected({ label: 'Passport number', type: 'text' }));
});

test('heuristic matching: synonyms, sections, split dates and repeated blocks', () => {
  const m = (f) => filler.heuristicMatch({ name: '', placeholder: '', section: '', type: 'text', id: 'x', ...f });
  assert.equal(m({ label: 'Surname' }).key, 'personal.family_name');
  assert.equal(m({ label: 'Programme title' }), null, 'no false positive on the personal title');
  assert.deepEqual([m({ label: 'Day', section: 'Date of birth' }).key, m({ label: 'Day', section: 'Date of birth' }).part], ['personal.date_of_birth', 'day']);
  assert.equal(m({ label: 'Country code', section: 'Mobile number' }).part, 'country_code');
  assert.equal(m({ label: 'Start date', section: 'Employment history' }).key, 'employment.0.start_date');
  const re = filler.reindexRepeats([{ field_id: 'a', key: 'education.0.institution', part: 'full' }, { field_id: 'b', key: 'education.0.institution', part: 'full' }]);
  assert.deepEqual(re.map((x) => x.key), ['education.0.institution', 'education.1.institution']);
});

/* ───────────── Application audit ───────────── */

test('auditor catches passport, score, referee and refusal problems', () => {
  const today = new Date('2026-10-22T00:00:00Z');
  assert.ok(!auditApplicant(APPLICANT, PROFILE, today).some((f) => f.level === 'error'));

  const bad = structuredClone(APPLICANT);
  bad.passport.number = 'K12345';
  bad.passport.expiry_date = '2028-01-01';
  bad.english_test.writing = 6.5;
  bad.immigration.visa_refusals = true;
  bad.contact.phone = '98765 43210';
  const f = auditApplicant(bad, PROFILE, today);
  const has = (field, level) => f.some((x) => x.field === field && x.level === level);
  assert.ok(has('passport.number', 'error'));
  assert.ok(has('passport.expiry_date', 'warn'), 'expires before course + visa leave');
  assert.ok(has('english_test.writing', 'error'), 'differs from the profile');
  assert.ok(has('immigration.visa_refusal_details', 'error'));
  assert.ok(has('contact.phone', 'error'));
  assert.ok(f.some((x) => x.field === 'referees.1.email' && x.level === 'warn'), 'personal email for a referee');
});

/* ───────────── Real browser fill ───────────── */

const FORM = `<!doctype html><html><body>
<form id="app" onsubmit="window.__submitted = true; return false;">
  <h2>Personal details</h2>
  <label for="t">Title</label><select id="t" name="title"><option>Please select</option><option>Mr</option><option>Ms</option><option>Dr</option></select>
  <label for="fn">First name</label><input id="fn" name="first_name">
  <label for="sn">Surname</label><input id="sn" name="surname">
  <label for="pn">Preferred name</label><input id="pn" name="preferred" value="Ash">
  <fieldset><legend>Date of birth</legend>
    <label for="d">Day</label><select id="d" name="dob_day"><option></option>${Array.from({ length: 31 }, (_, i) => `<option>${i + 1}</option>`).join('')}</select>
    <label for="m">Month</label><select id="m" name="dob_month"><option></option>${['January', 'February', 'March', 'April', 'May', 'June'].map((x) => `<option>${x}</option>`).join('')}</select>
    <label for="y">Year</label><select id="y" name="dob_year"><option></option>${Array.from({ length: 20 }, (_, i) => `<option>${1995 + i}</option>`).join('')}</select>
  </fieldset>
  <label for="nat">Nationality</label><select id="nat" name="nationality"><option>Please select</option><option>India</option><option>United Kingdom</option></select>
  <label for="pp">Passport number</label><input id="pp" name="passport_no">
  <label for="pe">Passport expiry date</label><input id="pe" type="date" name="passport_expiry">
  <label for="em">Email address</label><input id="em" type="email" name="email">
  <fieldset><legend>Mobile number</legend>
    <label for="cc">Country code</label><input id="cc" name="cc"><label for="num">Number</label><input id="num" name="mobile">
  </fieldset>
  <fieldset><legend>Home address</legend>
    <label for="co">Country</label><select id="co" name="country"><option>Please select</option><option>India</option></select>
    <label for="pc">Postcode</label><input id="pc" name="postcode">
  </fieldset>
  <fieldset><legend>Qualification 1</legend>
    <label for="i1">Institution</label><input id="i1"><label for="s1">Start date</label><input id="s1" placeholder="DD/MM/YYYY"><label for="g1">Grade</label><input id="g1">
  </fieldset>
  <fieldset><legend>Qualification 2</legend>
    <label for="i2">Institution</label><input id="i2"><label for="s2">Start date</label><input id="s2" placeholder="DD/MM/YYYY">
  </fieldset>
  <fieldset><legend>Do you have any unspent criminal convictions?</legend>
    <label><input type="radio" name="crim" value="y">Yes</label><label><input type="radio" name="crim" value="n">No</label>
  </fieldset>
  <label for="hear">How did you hear about us?</label><select id="hear"><option>Please select</option><option>Agent</option><option>Website</option></select>
  <label for="pw">Create a password</label><input id="pw" type="password">
  <label><input type="checkbox" id="decl"> I confirm the information is true and complete</label>
  <button type="submit">Submit application</button>
</form></body></html>`;

async function withPage(fn) {
  let session;
  try {
    session = await openHeadless();
  } catch (err) {
    return { skipped: err.message };
  }
  try {
    await session.page.setContent(FORM);
    return await fn(session.page);
  } finally {
    await session.browser.close();
  }
}

test('fills a realistic form locally; never submits; leaves protected and prefilled fields alone', async (t) => {
  const result = await withPage(async (page) => {
    const report = await filler.fillCurrentPage(page, { applicant: APPLICANT, useLlm: false });
    const v = (sel) => page.$eval(sel, (el) => el.value);
    const selected = (sel) => page.$eval(sel, (el) => el.options[el.selectedIndex]?.text ?? '');
    assert.equal(await selected('#t'), 'Ms');
    assert.equal(await v('#fn'), 'Asha');
    assert.equal(await v('#sn'), 'Rao');
    assert.equal(await v('#pn'), 'Ash', 'existing value not overwritten');
    assert.deepEqual([await selected('#d'), await selected('#m'), await selected('#y')], ['14', 'May', '2002']);
    assert.equal(await selected('#nat'), 'India');
    assert.equal(await v('#pp'), 'K1234567');
    assert.equal(await v('#pe'), '2032-02-28');
    assert.equal(await v('#em'), 'asha.rao@example.com');
    assert.deepEqual([await v('#cc'), await v('#num')], ['+91', '9876543210']);
    assert.equal(await selected('#co'), 'India');
    assert.equal(await v('#pc'), '500001');
    assert.deepEqual([await v('#i1'), await v('#s1'), await v('#g1')], ['VIT University', '01/08/2020', '8.4 CGPA']);
    assert.deepEqual([await v('#i2'), await v('#s2')], ['Narayana Junior College', '01/06/2018']);

    assert.equal(await page.$eval('#pw', (el) => el.value), '');
    assert.equal(await page.$eval('#decl', (el) => el.checked), false);
    assert.equal(await page.$$eval('input[name=crim]:checked', (els) => els.length), 0);
    assert.equal(await page.evaluate(() => window.__submitted ?? false), false, 'never submits');
    assert.ok(report.protectedFields.length >= 3);
    assert.ok(report.unmapped.some((f) => /hear about us/i.test(f.label)));
    return true;
  });
  if (result?.skipped) t.skip(`No Chromium available: ${result.skipped}`);
});

test('privacy: Claude only ever sees field labels, never applicant values', async (t) => {
  const reqs = recordingClient(setClient, (body) => JSON.stringify({ mappings: [] }));
  const result = await withPage(async (page) => {
    await fs.rm(PATHS.formMappings, { recursive: true, force: true });
    await filler.fillCurrentPage(page, { applicant: APPLICANT, useLlm: true });
    return true;
  });
  if (result?.skipped) return t.skip(`No Chromium available: ${result.skipped}`);
  assert.ok(reqs.length >= 1, 'unmatched fields were sent for mapping');
  const sent = JSON.stringify(reqs.map((r) => r.body));
  for (const secret of SECRETS) assert.ok(!sent.includes(secret), `leaked ${secret}`);
  assert.match(sent, /How did you hear about us/);
});

test('form pack: UK-formatted copy sheet, local only', async () => {
  const out = await filler.formPack({ name: 'ucl' });
  const md = await fs.readFile(out, 'utf8');
  assert.match(md, /\| Date of birth \| 14\/05\/2002 \|/);
  assert.match(md, /\| Passport number \| K1234567 \|/);
  assert.match(md, /Answer these yourself/);
  assert.ok(out.startsWith(path.join(home, 'outputs', 'forms')));
});

/* ───────────── Portal manager ───────────── */

test('portal dashboard computes the single next action', () => {
  const base = { id: 'x', university: 'UCL', status: 'drafting', portal: {}, documents: {}, deadlines: { application: '2026-11-01' } };
  const ctx = { sopExists: false, cvExists: false, lorCount: 0, today: new Date('2026-10-22T00:00:00Z') };
  assert.match(portalRow(base, ctx).next, /Add the portal URL/);
  assert.match(portalRow({ ...base, portal: { url: 'https://x' } }, ctx).next, /Create your account/);
  assert.match(portalRow({ ...base, portal: { url: 'https://x', account_created: true } }, ctx).next, /generate-sop/);
  const ready = { ...base, portal: { url: 'https://x', account_created: true, application_fee_paid: true }, documents: { sop_uploaded: true, cv_uploaded: true, passport_uploaded: true, english_test_uploaded: true, transcripts_uploaded: true } };
  assert.match(portalRow(ready, { ...ctx, sopExists: true, cvExists: true, lorCount: 2 }).next, /Review every page, then submit/);
  const r = portalRow(base, ctx);
  assert.equal(r.daysLeft, 11);
  assert.equal(r.urgent, true);
});

test('portal set records details but refuses passwords', async () => {
  const tracker = YAML.parse(await fs.readFile(PATHS.tracker, 'utf8'));
  tracker.applications.push({ id: 'ucl-msc-finance', university: 'University College London', short_name: 'UCL', programme: 'MSc Finance', status: 'drafting', portal: {}, documents: {}, deadlines: {} });
  await fs.writeFile(PATHS.tracker, YAML.stringify(tracker));
  const app = await portalSet('ucl-msc-finance', { url: 'https://portal.example.ac.uk', accountCreated: true, applicantId: 'UCL123', uploaded: ['cv', 'passport'], deadline: '2027-01-15' });
  assert.equal(app.portal.account_created, true);
  assert.equal(app.documents.cv_uploaded, true);
  await assert.rejects(portalSet('ucl-msc-finance', { password: 'hunter2' }), /never stores passwords/);
  await assert.rejects(portalSet('nope', {}), /No application "nope"/);
  const { rows } = await portalDashboard({ today: new Date('2026-10-22T00:00:00Z') });
  assert.equal(rows[0].id, 'ucl-msc-finance');
});

/* ───────────── Interview prep ───────────── */

const BANK = {
  questions: [
    { category: 'Finances', question: 'Who is funding your studies?', why_asked: 'Genuine student test', answer_outline: ['My parents, from savings held for 28 days', 'Total required is £99,999'], evidence_used: [], model_answer: null, pitfalls: ['Vague answers'], follow_ups: ['What do they do?'] },
    { category: 'Course', question: 'Name two core modules.', why_asked: 'Course research', answer_outline: ['Asset Markets'], evidence_used: [], model_answer: null, pitfalls: [], follow_ups: [] },
  ],
};

test('interview bank: saved as Markdown + YAML, invented numbers flagged', async () => {
  const reqs = recordingClient(setClient, () => JSON.stringify(BANK));
  const r = await generateInterviewBank({ university: 'UCL', course: 'MSc Finance', type: 'credibility', count: 2 });
  assert.equal(r.questions.length, 2);
  assert.ok(r.warnings.some((w) => w.includes('99,999')));
  assert.match(reqs[0].body.messages[0].content, /Credibility \/ pre-CAS interview/);
  assert.match(await fs.readFile(r.outputPath, 'utf8'), /## 1\. Who is funding your studies\?/);
  assert.ok(existsSync(r.bankPath));
});

test('practice session: timed questions, scored feedback, deterministic checks, log', async () => {
  recordingClient(setClient, () => JSON.stringify({
    scores: { structure: 4, specificity: 3, relevance: 5, consistency: 2, concision: 4 },
    inconsistencies: ['Says the course is 2 years; it is 1 year'], strengths: ['Direct'], improvements: ['Name the sponsor'], stronger_answer: ['My father funds it from savings'],
  }));
  const printed = [];
  const answers = ['Basically my father, like, you know, funds it and I am passionate about it, costing £12,345.', ''];
  const { results, logPath } = await practiceSession({
    university: 'UCL', type: 'credibility', count: 2,
    io: { ask: async () => answers.shift(), print: (s) => printed.push(s), countdown: async () => {} },
  });
  assert.equal(results.length, 1, 'blank answer skipped');
  const fb = results[0].feedback;
  assert.ok(fb.inconsistencies.some((x) => x.includes('12,345')), 'invented figure flagged');
  assert.ok(results[0].checks.notes.some((n) => n.includes('"passionate"')));
  assert.ok(results[0].checks.notes.some((n) => /filler/.test(n)));
  assert.ok(printed.some((p) => /Score 3\.6\/5/.test(p)));
  assert.match(await fs.readFile(logPath, 'utf8'), /Stronger answer/);
});

test('answer length is sized to the clock', async () => {
  const f = await loadFramework();
  assert.match(answerChecks('word '.repeat(400), 90, f).notes[0], /runs over 90s/);
  assert.match(answerChecks('too short', 90, f).notes[0], /fuller answer/);
});
