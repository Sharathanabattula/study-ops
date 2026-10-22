import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { recordingClient } from './helpers.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'study-ops-p1-'));
process.env.STUDY_OPS_HOME = home;
process.env.ANTHROPIC_API_KEY = 'test-key';

const { setClient, structuredWithSearch } = await import('../src/llm/claude.js');
const auditor = await import('../src/agents/4_profile_auditor.js');
const { classifyProgramme, buildShortlist } = await import('../src/agents/5_shortlist_matrix.js');
const roi = await import('../src/agents/6_cost_roi_mapper.js');
const { matchSyllabus } = await import('../src/agents/7_syllabus_matcher.js');
const { initWorkspace } = await import('../src/commands/init.js');
const { loadUkviRules, parseDate } = await import('../src/agents/3_ukvi_compliance_engine.js');
const { DiscoverySchema } = await import('../src/agents/5_shortlist_matrix.js');

const grades = await auditor.loadGradeRules();
const ukvi = await loadUkviRules();
const record = (respond) => recordingClient(setClient, respond);

const PROFILE = {
  schema_version: 1,
  identity: { full_name: 'Test', nationality: 'India' },
  target: { level: 'MSc', intake: '2027-09', subjects: ['Finance'], living_zone: 'inner' },
  academics: {
    degree: 'B.Tech Biotechnology', cgpa: 8.4, cgpa_scale: 10, cgpa_conversion: 'aicte', institution_tier: 2, graduation_year: 2024,
    backlogs: { active: 0, cleared: 1 },
    modules: [{ name: 'Engineering Mathematics I', grade: 'A' }, { name: 'Biostatistics', grade: 'A+' }, { name: 'Cell Biology', grade: 'B' }],
  },
  english: { test: 'IELTS Academic UKVI', overall: 7.0, bands: { listening: 7.5, reading: 7.0, writing: 6.0, speaking: 7.0 }, test_date: '2026-06-01' },
  experience: { total_months: 18 },
  budget: { max_total_course: 60000, flights_and_setup_gbp: 1500, fx_gbp_to_home: 112 },
  career: { current_salary_annual: 900000, current_salary_currency: 'INR', expected_salary_annual_gbp: 45000 },
};

before(async () => {
  await initWorkspace();
  await fs.writeFile(path.join(home, 'data', 'student_profile.md'), `---\n${YAML.stringify(PROFILE)}---\n\n## Core Narrative\nBiotech to finance.\n`);
});
after(async () => fs.rm(home, { recursive: true, force: true }));

/* ───────────── Profile audit ───────────── */

test('CGPA → percentage uses the chosen formula; official % wins', () => {
  assert.equal(auditor.toPercentage({ cgpa: 8.4, cgpa_scale: 10, cgpa_conversion: 'aicte' }, grades).percentage, 76.5);
  assert.equal(auditor.toPercentage({ cgpa: 8.4, cgpa_scale: 10, cgpa_conversion: 'cbse' }, grades).percentage, 79.8);
  assert.equal(auditor.toPercentage({ cgpa: 8.4, cgpa_scale: 10, cgpa_conversion: 'custom', cgpa_conversion_custom: { multiply: 7.1, add: 11 } }, grades).percentage, 70.6);
  assert.equal(auditor.toPercentage({ cgpa: 8.4, percentage: 81 }, grades).percentage, 81);
  assert.match(auditor.toPercentage({ cgpa: 8.4, cgpa_scale: 10 }, grades).source, /assumed/);
  assert.equal(auditor.toPercentage({ cgpa: 3.6, cgpa_scale: 4 }, grades).percentage, null);
});

test('percentage → UK class depends on institution tier', () => {
  assert.deepEqual(auditor.toUkClass(76.5, 2, grades), { ukClass: 'first', marginToNextClass: null });
  assert.deepEqual(auditor.toUkClass(66, 2, grades), { ukClass: 'upper_second', marginToNextClass: 9 });
  assert.equal(auditor.toUkClass(61, 1, grades).ukClass, 'upper_second');
  assert.equal(auditor.toUkClass(61, 3, grades).ukClass, 'lower_second');
  assert.equal(auditor.toUsGpa(76.5, grades), 4);
  assert.equal(auditor.toUsGpa(55, grades), 3);
});

test('English audit: tiers, UKVI B2 floor, validity at intake', () => {
  const e = auditor.auditEnglish(PROFILE.english, grades, '2027-09');
  assert.deepEqual(e.tiersMet, ['Standard']); // writing 6.0 blocks "Higher" (6.5 min)
  assert.equal(e.meetsUkviB2, true);
  assert.equal(e.validUntil, '2028-06-01');
  assert.equal(e.validAtIntake, true);
  assert.equal(auditor.auditEnglish({ ...PROFILE.english, test_date: '2025-06-01' }, grades, '2027-09').validAtIntake, false);
  assert.equal(auditor.auditEnglish({ ...PROFILE.english, bands: { writing: 5.0 } }, grades).meetsUkviB2, false);
});

test('backlogs: legacy number and active/cleared object', () => {
  assert.deepEqual(auditor.auditBacklogs(3, grades), { active: 0, cleared: 3, level: 'note' });
  assert.equal(auditor.auditBacklogs({ active: 1, cleared: 0 }, grades).level, 'risk');
  assert.equal(auditor.auditBacklogs({ active: 0, cleared: 7 }, grades).level, 'caution');
});

test('full audit flags', async () => {
  const a = await auditor.auditProfile();
  assert.equal(a.grades.percentage, 76.5);
  assert.equal(a.grades.ukClass, 'first');
  assert.ok(!a.flags.some((f) => f.level === 'risk'));
});

/* ───────────── Cost & ROI ───────────── */

test('visa length and IHS', () => {
  assert.deepEqual(roi.visaAndIhs(12, ukvi), { visaMonths: 16, ihs: 776 + 388 });
  assert.deepEqual(roi.visaAndIhs(9, ukvi), { visaMonths: 11, ihs: 776 });
  assert.deepEqual(roi.visaAndIhs(24, ukvi), { visaMonths: 28, ihs: 776 * 2 + 388 });
  assert.equal(roi.graduateRouteMonths(parseDate('2026-12-31'), ukvi), 24);
  assert.equal(roi.graduateRouteMonths(parseDate('2027-01-01'), ukvi), 18);
});

test('cost of attendance, budget fit and ROI', async () => {
  const cost = await roi.costOfAttendance({ tuitionTotal: 38000, courseMonths: 12, zone: 'inner', flightsAndSetup: 1500 });
  assert.equal(cost.total, 38000 + 1529 * 12 + 558 + 1164 + 1500);
  assert.equal(roi.budgetFit(cost, { max_total_course: 60000 }).status, 'within');
  assert.equal(roi.budgetFit(cost, { max_total_course: 56000 }).status, 'stretch');
  assert.equal(roi.budgetFit(cost, { max_total_course: 50000 }).status, 'over');
  assert.throws(() => roi.normaliseZone('mars'), RangeError);

  const r = await roi.estimateRoi({ cost, career: PROFILE.career, budget: PROFILE.budget, courseStart: parseDate('2027-09-01') });
  const currentGbp = 900000 / 112;
  assert.equal(r.annualUpliftGbp, Math.round(45000 - currentGbp));
  assert.equal(r.graduateRouteMonths, 18);
  assert.ok(r.paybackYears > 1.5 && r.paybackYears < 2.5);
});

/* ───────────── Safe / Target / Reach ───────────── */

const audit = await (async () => auditor.auditProfile({ profile: { facts: PROFILE, narrative: {}, raw: '' } }))();
const req = (over = {}) => ({ min_uk_classification: 'upper_second', home_country_min_percentage: null, home_country_min_cgpa_10: null, ielts_overall: 6.5, ielts_min_component: 6.0, ...over });

test('classification uses the page threshold first, then the class heuristic', () => {
  const pageBased = classifyProgramme({ audit, academics: PROFILE.academics, requirements: req({ home_country_min_percentage: 60 }), selectivity: 'standard', gradeRules: grades });
  assert.equal(pageBased.margin, 16.5);
  assert.equal(pageBased.category, 'safe');
  assert.equal(pageBased.confidence, 'high');

  const heuristic = classifyProgramme({ audit, academics: PROFILE.academics, requirements: req(), selectivity: 'high', gradeRules: grades });
  assert.equal(heuristic.margin, 11.5); // 76.5 − 65 (2:1 at tier 2)
  assert.equal(heuristic.category, 'target'); // high selectivity needs +12 for safe
  assert.equal(heuristic.confidence, 'medium');

  const below = classifyProgramme({ audit, academics: PROFILE.academics, requirements: req({ home_country_min_percentage: 80 }), selectivity: 'standard', gradeRules: grades });
  assert.equal(below.category, 'reach');
  assert.equal(below.belowMinimum, true);
});

test('very-high selectivity is never Safe; English gap caps at Target', () => {
  const lse = classifyProgramme({ audit, academics: PROFILE.academics, requirements: req({ home_country_min_percentage: 60 }), selectivity: 'very_high', gradeRules: grades });
  assert.equal(lse.category, 'target');
  const eng = classifyProgramme({ audit, academics: PROFILE.academics, requirements: req({ home_country_min_percentage: 50, ielts_overall: 7.0, ielts_min_component: 6.5 }), selectivity: 'standard', gradeRules: grades });
  assert.equal(eng.english, 'below');
  assert.equal(eng.category, 'target');
});

test('historical outcomes override once there are enough similar applicants', () => {
  const mk = (result, percentage = 75) => ({ university: 'warwick', percentage, result });
  const outcomes = [mk('reject'), mk('reject'), mk('reject'), mk('admit'), mk('reject'), mk('admit', 95)];
  const c = classifyProgramme({ audit, academics: PROFILE.academics, requirements: req({ home_country_min_percentage: 60 }), selectivity: 'standard', outcomes, gradeRules: grades });
  assert.deepEqual(c.outcomes, { similar: 5, admitted: 1 }); // the 95% case is not similar
  assert.equal(c.category, 'reach');
  assert.match(c.basis, /1\/5 similar past applicants/);
});

test('web search resumes after pause_turn', async () => {
  const calls = [];
  setClient({ beta: { messages: { parse: async (p) => {
    calls.push(p);
    return calls.length === 1
      ? { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'x', name: 'web_search', input: {} }] }
      : { stop_reason: 'end_turn', parsed_output: { programmes: [] } };
  } } } });
  const out = await structuredWithSearch({ system: ['s'], prompt: 'find', schema: DiscoverySchema, allowedDomains: ['lse.ac.uk'] });
  assert.deepEqual(out, { programmes: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.at(-1).role, 'assistant');
  assert.equal(calls[0].tools[0].type, 'web_search_20260209');
  assert.deepEqual(calls[0].tools[0].allowed_domains, ['lse.ac.uk']);
});

const page = (title, fee, extra = '') => `<html><title>${title}</title><body><h1>${title}</h1><p>Overseas fee £${fee}. 12 months.</p>${extra}${'<p>Programme content and core modules in quantitative finance and statistics.</p>'.repeat(4)}</body></html>`;
const PAGES = {
  'https://warwick.ac.uk/fac/msc-finance': page('MSc Finance | Warwick', '39,000'),
  'https://www.lse.ac.uk/msc-finance': page('MSc Finance | LSE', '44,000'),
};
const fakeFetch = async (url) => new Response(PAGES[String(url)] ?? '', { status: PAGES[String(url)] ? 200 : 404, headers: { 'content-type': 'text/html' } });
const extraction = (title, fee, pct) => ({
  programme_title: title, award: 'MSc', duration_months: 12, intake: 'Sept 2027', tuition_international_gbp: fee, tuition_basis: 'total_course',
  application_deadlines: [], academic_requirement: '2:1', min_uk_classification: 'upper_second', international_equivalent: null,
  home_country_min_percentage: pct, home_country_min_cgpa_10: null, subject_background: 'Calculus and statistics', ielts_overall: 7, ielts_min_component: 6.5,
  pte_overall: null, work_experience: null, tests_required: null, career_outcomes: null, scholarships: [], notes: null,
});

test('shortlist end-to-end with --urls: matrix, report, tracker defaults', async () => {
  const requests = record((body) => {
    const text = body.messages[0].content;
    return JSON.stringify(text.includes('Warwick') ? extraction('MSc Finance', 39000, 60) : extraction('MSc Finance', 44000, 65));
  });
  const { rows, reportPath } = await buildShortlist({ subject: 'Finance', urls: Object.keys(PAGES), fetchImpl: fakeFetch });
  assert.equal(requests.length, 2);
  const byUni = Object.fromEntries(rows.map((r) => [r.programme.universityKey, r]));
  assert.equal(byUni.lse.classification.category, 'target'); // very_high: +11.5 clears the +5 target bar, never safe
  assert.equal(byUni.lse.classification.english, 'below'); // writing 6.0 < 6.5
  assert.equal(byUni.warwick.classification.category, 'target'); // high selectivity, +16.5, but English below → capped
  assert.equal(byUni.warwick.budget.status, 'within');

  const md = await fs.readFile(reportPath, 'utf8');
  assert.match(md, /Safe \/ Target \/ Reach/);
  assert.match(md, /published entry requirements only/);

  const tracker = YAML.parse(await fs.readFile(path.join(home, 'data', 'tracker.yaml'), 'utf8'));
  const entry = tracker.applications.find((a) => a.id === 'warwick-msc-finance');
  assert.equal(entry.status, 'shortlisted');
  assert.equal(entry.shortlist.category, 'target');

  // Re-run uses the cache (no new requests) and leaves an advanced status alone.
  const raw = (await fs.readFile(path.join(home, 'data', 'tracker.yaml'), 'utf8')).replace(/(id: warwick-msc-finance\n(?:.*\n)*?\s+status: )shortlisted/, '$1submitted');
  await fs.writeFile(path.join(home, 'data', 'tracker.yaml'), raw);
  await buildShortlist({ subject: 'Finance', urls: Object.keys(PAGES), fetchImpl: fakeFetch });
  assert.equal(requests.length, 2);
  const again = YAML.parse(await fs.readFile(path.join(home, 'data', 'tracker.yaml'), 'utf8'));
  assert.equal(again.applications.find((a) => a.id === 'warwick-msc-finance').status, 'submitted');
});

test('syllabus matcher drops module names the student never listed', async () => {
  record(() => JSON.stringify({
    prerequisites: [
      { id: 'calculus', requirement: 'Calculus', importance: 'required', source_quote: 'Calculus and statistics' },
      { id: 'stats', requirement: 'Statistics', importance: 'required', source_quote: 'Calculus and statistics' },
    ],
    matches: [
      { prerequisite_id: 'calculus', status: 'met', matched_modules: ['Advanced Calculus III'], explanation: 'Invented module' },
      { prerequisite_id: 'stats', status: 'met', matched_modules: ['Biostatistics'], explanation: 'Covers inference' },
    ],
    overall: 'adequate', summary: 'Decent.', bridging: [{ gap: 'Calculus', action: 'MIT OCW 18.01' }], statement_points: ['Biostatistics A+'],
  }));
  const r = await matchSyllabus({ url: 'https://warwick.ac.uk/fac/msc-finance', fetchImpl: fakeFetch });
  assert.deepEqual(r.droppedModules, ['Advanced Calculus III']);
  assert.equal(r.matches[0].status, 'unclear');
  assert.equal(r.matches[1].status, 'met');
  assert.match(await fs.readFile(r.reportPath, 'utf8'), /Removed module names not in your profile/);
});
