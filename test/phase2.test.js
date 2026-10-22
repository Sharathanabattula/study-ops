import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { recordingClient } from './helpers.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'study-ops-p2-'));
process.env.STUDY_OPS_HOME = home;
process.env.ANTHROPIC_API_KEY = 'test-key';

const { setClient } = await import('../src/llm/claude.js');
const fc = await import('../src/lib/factcheck.js');
const { tailorPersonalStatement, namedPeople } = await import('../src/agents/2_sop_tailor.js');
const { buildMasterSop, parseInterview } = await import('../src/agents/8_master_sop.js');
const { draftLors } = await import('../src/agents/9_lor_drafter.js');
const { buildAcademicCv } = await import('../src/agents/10_academic_cv.js');
const { initWorkspace } = await import('../src/commands/init.js');
const { PATHS } = await import('../src/lib/paths.js');

const PROFILE = {
  schema_version: 1,
  identity: { full_name: 'Asha Rao', nationality: 'India' },
  target: { level: 'MSc', intake: '2027-09', subjects: ['Finance'], research_interests: ['biotech venture financing'] },
  academics: { degree: 'B.Tech Biotechnology', cgpa: 8.4, cgpa_scale: 10, graduation_year: 2024 },
  experience: { total_months: 18, roles: [{ title: 'Analyst', organisation: 'Helix CRO', highlights: ['Cut assay cost 18% across 3 labs'] }] },
};
const MASTER = `I spent two years scaling assays at Helix CRO and cut assay cost by 18% across 3 labs. ${'Good science kept failing to get funded, and I want to understand why capital moves the way it does. '.repeat(6)}My goal is to work in biotech venture financing.`;

before(async () => {
  await initWorkspace();
  await fs.writeFile(PATHS.profile, `---\n${YAML.stringify(PROFILE)}---\n\n## Core Narrative\nBiotech to finance.\n`);
});
after(async () => fs.rm(home, { recursive: true, force: true }));

/* ───────────── Fabrication guards ───────────── */

test('unsupportedNumbers flags figures absent from every source', () => {
  assert.deepEqual(fc.unsupportedNumbers('Cut cost by 18% across 3 labs, saving £40,000 in 2024.', ['18% cost cut, 2024']), ['£40,000']);
  assert.deepEqual(fc.unsupportedNumbers('Ranked 1 of 2', []), [], 'tiny structural numbers are ignored');
  assert.deepEqual(fc.unsupportedNumbers('a 25x return', ['25 x']), []);
});

test('changeRatio measures the rewritten share; ngramOverlap catches copy-paste', () => {
  const a = 'one two three four five six seven eight nine ten';
  assert.equal(fc.changeRatio(a, a), 0);
  assert.equal(fc.changeRatio(a, 'one two three four five six seven alpha beta gamma'), 0.3);
  assert.ok(fc.ngramOverlap(a, a) === 1);
  assert.equal(fc.ngramOverlap(a, 'completely different words here for sure today'), 0);
});

test('reference checks normalise titles', () => {
  assert.ok(fc.mentions('Meet Prof. Jane Smith, our head of finance', 'Professor Jane Smith'));
  assert.deepEqual(fc.checkReferences(['Dr Jane Smith', 'Prof. Made Up'], ['Jane Smith']), { ok: ['Dr Jane Smith'], unverified: ['Prof. Made Up'] });
  assert.deepEqual(namedPeople('I admire Professor Jane Smith and Dr. Raj Patel.'), ['Jane Smith', 'Raj Patel']);
});

/* ───────────── University-specific tailoring ───────────── */

const PROG_URL = 'https://www.lse.ac.uk/msc-finance';
const STAFF_URL = 'https://www.lse.ac.uk/finance/people';
const PAGES = {
  [PROG_URL]: `<html><title>MSc Finance</title><body><h1>MSc Finance</h1><p>Core modules: Asset Markets; Corporate Finance. Overseas fee £44,000. 10 months.</p>${'<p>Students study quantitative finance in depth with leading faculty.</p>'.repeat(4)}</body></html>`,
  [STAFF_URL]: `<html><title>People</title><body><h1>Faculty</h1><p>Professor Jane Smith works on venture capital and biotech financing.</p><p>Financial Markets Group studies market structure.</p>${'<p>Department of Finance staff directory and research.</p>'.repeat(4)}</body></html>`,
};
const fakeFetch = async (url) => new Response(PAGES[String(url)] ?? '', { status: PAGES[String(url)] ? 200 : 404, headers: { 'content-type': 'text/html' } });
const REQUIREMENTS = {
  programme_title: 'MSc Finance', award: 'MSc', duration_months: 10, intake: null, tuition_international_gbp: 44000, tuition_basis: 'total_course',
  application_deadlines: [], academic_requirement: '2:1', min_uk_classification: 'upper_second', international_equivalent: null,
  home_country_min_percentage: null, home_country_min_cgpa_10: null, subject_background: null, ielts_overall: 7, ielts_min_component: 6.5,
  pte_overall: null, work_experience: null, tests_required: null, career_outcomes: null, scholarships: [], notes: null,
};

test('specifics keep only names found on official pages; tailoring flags strays', async () => {
  await fs.writeFile(PATHS.personalStatement, MASTER);
  const tailored = MASTER.replace('My goal is to work in biotech venture financing.', 'At LSE, Asset Markets and Professor Jane Smith’s work on biotech financing connect directly to this. My goal is to work in biotech venture financing.');
  const reqs = recordingClient(setClient, (body) => {
    const props = Object.keys(body.output_config?.format?.schema?.properties ?? {}).sort().join(',');
    if (props.includes('programme_title')) return JSON.stringify(REQUIREMENTS);
    if (props === 'modules') return JSON.stringify({ modules: [{ name: 'Asset Markets', type: 'core', summary: null }, { name: 'Quantum Banking', type: 'optional', summary: null }] });
    if (props === 'labs,people') return JSON.stringify({ people: [{ name: 'Jane Smith', role: 'Professor', research_focus: 'VC and biotech financing', url: STAFF_URL }, { name: 'Imaginary Person', role: null, research_focus: 'x', url: STAFF_URL }], labs: [{ name: 'Financial Markets Group', focus: 'market structure', url: STAFF_URL }] });
    if (props.includes('references')) return JSON.stringify({ scores: { specificity: 4, programme_fit: 4, evidence: 4, tone_match: 4, why_uk_and_goals: 4, voice: 4 }, references: [{ name: 'Professor Jane Smith', kind: 'person' }, { name: 'Dr Ghost', kind: 'person' }], unsupported_claims: [], cliches: [], fixes: [] });
    return body.messages[0].content.includes('required_changes') ? tailored : `${tailored} Dr Ghost advised me, saving 40,000 hours.`;
  });

  const res = await tailorPersonalStatement({ university: 'lse', url: PROG_URL, researchUrls: [STAFF_URL], fetchImpl: fakeFetch });
  assert.deepEqual(res.specifics.modules.map((m) => m.name), ['Asset Markets']);
  assert.deepEqual(res.specifics.people.map((p) => p.name), ['Jane Smith']);
  assert.deepEqual(res.specifics.labs.map((l) => l.name), ['Financial Markets Group']);
  assert.deepEqual(res.specifics.dropped.sort(), ['Imaginary Person', 'Quantum Banking']);

  const revise = reqs.find((r) => r.body.stream && r.body.messages[0].content.includes('required_changes'));
  assert.match(revise.body.messages[0].content, /Remove "Dr Ghost"/);
  assert.match(revise.body.messages[0].content, /"40,000"/);
  assert.ok(res.changeRatio > 0 && res.changeRatio < 0.3);
  assert.match(await fs.readFile(res.outputPath, 'utf8'), /Jane Smith: https:\/\/www\.lse\.ac\.uk\/finance\/people/);
});

/* ───────────── Master SOP ───────────── */

const PLAN = (critical) => ({
  central_thesis: 'Why good biotech science fails to get funded.',
  arc: [{ section: 'academic_foundation', beat: 'Biotech training', evidence: ['B.Tech Biotechnology'] }],
  open_questions: [{ question: 'Which project made you notice the funding gap?', why: 'turning point', critical }],
});

test('master SOP interviews first, then drafts from the answers', async () => {
  let plan = PLAN(true);
  const reqs = recordingClient(setClient, (body) => {
    const props = Object.keys(body.output_config?.format?.schema?.properties ?? {}).sort().join(',');
    if (props.includes('central_thesis')) return JSON.stringify(plan);
    if (props.includes('scores')) return JSON.stringify({ scores: { central_thesis: 4, academic_rigour: 3, coherence: 4, evidence: 4, goals: 4, voice: 4 }, unsupported_claims: [], cliches: ['passion for'], fixes: ['Deepen the method'] });
    return body.messages[0].content.includes('required_changes') ? 'Final master essay about funding gaps.' : 'First master essay.';
  });

  const first = await buildMasterSop();
  assert.equal(first.status, 'needs_answers');
  const md = await fs.readFile(PATHS.sopInterview, 'utf8');
  assert.match(md, /## 1\. Which project made you notice the funding gap\?/);

  await fs.writeFile(PATHS.sopInterview, md.replace('<!-- your answer -->', 'My final-year assay project lost its grant.'));
  assert.equal(parseInterview(await fs.readFile(PATHS.sopInterview, 'utf8'))[0].answer, 'My final-year assay project lost its grant.');

  plan = PLAN(true); // the model repeats the question; it is now answered, so drafting proceeds
  const done = await buildMasterSop({ adopt: true });
  assert.equal(done.status, 'complete');
  assert.equal(done.draft, 'Final master essay about funding gaps.');
  assert.ok(done.backupPath, 'previous master backed up');
  assert.equal((await fs.readFile(PATHS.personalStatement, 'utf8')).trim(), 'Final master essay about funding gaps.');
  const planCall = reqs.filter((r) => r.body.output_config?.format)[2];
  assert.match(planCall.body.system.at(-1).text, /My final-year assay project lost its grant/);
  const revise = reqs.at(-1).body.messages[0].content;
  assert.match(revise, /Cut the cliché "passion for"/);
});

/* ───────────── LORs ───────────── */

test('LORs get distinct angles; near-duplicate and invented numbers trigger a revision', async () => {
  await fs.writeFile(PATHS.recommenders, YAML.stringify({
    recommenders: [
      { id: 'prof', name: 'Dr K Iyer', title: 'Professor', organisation: 'VIT', type: 'academic', relationship: 'Project supervisor', focus: 'research', evidence: ['Redesigned the assay protocol, cutting reagent cost by 18%'] },
      { id: 'boss', name: 'M Shah', title: 'Lab Head', organisation: 'Helix CRO', type: 'professional', relationship: 'Line manager', focus: 'leadership', evidence: ['Led a 4-person audit team'] },
    ],
  }));
  const shared = 'Asha is a careful and rigorous analyst who consistently delivers excellent results under pressure and I recommend her strongly for graduate study';
  const reqs = recordingClient(setClient, (body) => {
    if (body.output_config?.format) return JSON.stringify({ letters: [
      { recommender_id: 'prof', primary_angle: 'research', secondary_angle: null, evidence: ['Redesigned the assay protocol, cutting reagent cost by 18%'], structure: 'A', opening: 'Project' },
      { recommender_id: 'boss', primary_angle: 'leadership', secondary_angle: 'teamwork', evidence: ['Led a 4-person audit team'], structure: 'B', opening: 'Audit' },
    ] });
    const c = body.messages[0].content;
    if (c.includes('required_changes')) return 'In the audit she ran, Asha organised four colleagues and kept the work moving. — M Shah, Lab Head';
    return c.includes('Dr K Iyer') ? `${shared}. She cut reagent cost by 18%.` : `${shared}. She saved 90 hours.`;
  });

  const r = await draftLors({ programme: 'MSc Finance' });
  assert.equal(r.letters.length, 2);
  assert.deepEqual(r.letters.map((l) => l.plan.primary_angle), ['research', 'leadership']);
  const revision = reqs.find((q) => q.body.messages[0].content.includes('required_changes'));
  assert.match(revision.body.messages[0].content, /repeats phrasing from prof/);
  assert.match(revision.body.messages[0].content, /"90"/);
  assert.ok(r.letters[1].overlaps[0].score < 0.06);
  const file = await fs.readFile(r.letters[0].outputPath, 'utf8');
  assert.match(file, /rewrite it in your own words/);
  assert.match(file, /submit it yourself/);
});

/* ───────────── Academic CV ───────────── */

test('academic CV renders UK sections and flags invented numbers and papers', async () => {
  await fs.writeFile(PATHS.resume, `Asha Rao | asha@example.com\n${'Analyst at Helix CRO 2024-2026. Cut assay cost 18% across 3 labs. Python, R, Excel. '.repeat(3)}\nDOB: 01/01/2002. Marital status: single.\nPoster: "Low-cost assays at scale", BioAsia 2023.`);
  recordingClient(setClient, () => JSON.stringify({
    header: { name: 'Asha Rao', email: 'asha@example.com', phone: null, location: null, links: [] },
    research_interests: ['Biotech venture financing'],
    education: [{ degree: 'B.Tech Biotechnology', institution: 'VIT', dates: '2020 – 2024', grade: 'CGPA 8.4/10', thesis: null, highlights: [] }],
    research_experience: [],
    publications: [
      { citation: 'Rao, A. "Low-cost assays at scale." Poster, BioAsia 2023.', title: 'Low-cost assays at scale', status: 'poster' },
      { citation: 'Rao, A. "Gene pricing." Nature 2025.', title: 'Gene pricing', status: 'published' },
    ],
    projects: [],
    professional_experience: [{ title: 'Analyst', organisation: 'Helix CRO', dates: '2024 – 2026', bullets: ['Cut assay cost 18% across 3 labs', 'Built models used by 250 clients'] }],
    skills: [{ category: 'Programming', items: ['Python', 'R'] }],
    awards: [], leadership: [], certifications: [],
    removed_personal_details: ['Date of birth', 'Marital status'],
    quantify_prompts: ['How many assays per month did your process handle?'],
  }));
  const r = await buildAcademicCv();
  assert.match(r.markdown, /## Education[\s\S]*## Publications & Presentations[\s\S]*## Professional Experience/);
  assert.ok(r.warnings.some((w) => w.includes('250')));
  assert.ok(r.warnings.some((w) => w.includes('Gene pricing')));
  assert.ok(!r.warnings.some((w) => w.includes('Low-cost assays')));
  const file = await fs.readFile(r.outputPath, 'utf8');
  assert.match(file, /Removed \(not used on UK CVs\):\*\* Date of birth, Marital status/);
  assert.doesNotMatch(r.markdown, /DOB|Marital/);
});

test('--find-faculty: search hits are fetched locally and dropped unless the page names them', async () => {
  const { gatherSpecifics } = await import('../src/lib/specifics.js');
  const { findUniversity } = await import('../src/lib/universities.js');
  const reqs = recordingClient(setClient, (body) => {
    const props = Object.keys(body.output_config?.format?.schema?.properties ?? {}).sort().join(',');
    if (props === 'modules') return JSON.stringify({ modules: [] });
    return JSON.stringify({
      people: [
        { name: 'Jane Smith', role: 'Professor', research_focus: 'VC', url: STAFF_URL },
        { name: 'Ada Ghost', role: 'Reader', research_focus: 'x', url: 'https://www.lse.ac.uk/missing' },
      ],
      labs: [],
    });
  });
  const programme = { url: PROG_URL, pageText: 'MSc Finance page', requirements: { programme_title: 'MSc Finance' } };
  const s = await gatherSpecifics({ programme, university: await findUniversity('lse'), interests: ['vc'], findFaculty: true, refresh: true, fetchImpl: fakeFetch });
  assert.deepEqual(s.people.map((p) => p.name), ['Jane Smith']);
  assert.deepEqual(s.dropped, ['Ada Ghost']);
  const search = reqs.find((r) => r.body.tools);
  assert.deepEqual(search.body.tools[0].allowed_domains, ['lse.ac.uk']);
});
