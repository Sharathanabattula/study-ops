import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordingClient } from './helpers.js';

// Isolate the workspace before any module reads PATHS.
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'study-ops-'));
process.env.STUDY_OPS_HOME = home;
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.STUDY_OPS_MODEL;

const { setClient, structured } = await import('../src/llm/claude.js');
const record = (respond) => recordingClient(setClient, respond);
const { RequirementsSchema, buildFacts, evaluateUniversity } = await import('../src/agents/1_university_evaluator.js');
const { tailorPersonalStatement, countWords } = await import('../src/agents/2_sop_tailor.js');
const { initWorkspace } = await import('../src/commands/init.js');
const { loadUkviRules, parseDate } = await import('../src/agents/3_ukvi_compliance_engine.js');
const { htmlToText } = await import('../src/lib/web.js');

const PROFILE_FACTS = `identity:
  full_name: "Test Student"
  nationality: "India"
english:
  test: "IELTS Academic UKVI"
  overall: 7.0
  bands: { listening: 7.5, reading: 7.0, writing: 6.0, speaking: 7.0 }
budget:
  max_tuition: 40000
  max_total_year_one: 50000`;

before(async () => {
  await initWorkspace();
  await fs.writeFile(path.join(home, 'data', 'student_profile.md'), `---\nschema_version: 1\n${PROFILE_FACTS}\n---\n\n## Core Narrative\nBiotech to finance.\n`);
});
after(async () => fs.rm(home, { recursive: true, force: true }));

const PAGE = `<html><head><title>MSc Finance | LSE</title></head><body><h1>MSc Finance</h1>
<p>Duration: 10 months full-time. Fees for overseas students: &pound;41,000.</p>
<p>Minimum entry: UK 2:1 or equivalent. English: IELTS 7.0 overall with 7.0 in each component.</p>
${'<p>Filler about the programme and its modules in corporate finance and asset pricing.</p>'.repeat(5)}</body></html>`;
const fakePageFetch = async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });

const REQUIREMENTS = {
  programme_title: 'MSc Finance', award: 'MSc', duration_months: 10, intake: 'September 2027',
  tuition_international_gbp: 41000, tuition_basis: 'total_course', application_deadlines: [],
  academic_requirement: 'UK 2:1', international_equivalent: null, ielts_overall: 7, ielts_min_component: 7,
  pte_overall: null, work_experience: null, tests_required: null, career_outcomes: null, scholarships: [], notes: null,
  min_uk_classification: 'upper_second', home_country_min_percentage: 65, home_country_min_cgpa_10: null, subject_background: 'Quantitative degree with calculus and statistics',
};

test('request shape: Opus 5.5, server-side fallbacks, cached system, structured output', async () => {
  const requests = record(() => JSON.stringify(REQUIREMENTS));
  const out = await structured({ system: ['rules', 'context'], prompt: 'extract', schema: RequirementsSchema, effort: 'medium' });
  assert.equal(out.programme_title, 'MSc Finance');

  const { url, headers, body } = requests[0];
  assert.match(url, /\/v1\/messages\?beta=true$/);
  assert.match(headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.system.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal(body.thinking, undefined, 'thinking cannot be disabled on Opus 5.5; leave it unset');
});

test('refusals surface as readable errors', async () => {
  setClient({ beta: { messages: { parse: async () => ({ stop_reason: 'refusal', stop_details: { category: 'bio' } }) } } });
  await assert.rejects(structured({ system: ['s'], prompt: 'p', schema: RequirementsSchema }), /declined.*bio/);
});

test('buildFacts: band gaps and budget computed deterministically', async () => {
  const rules = await loadUkviRules();
  const facts = buildFacts({
    facts: { english: { overall: 7, bands: { writing: 6, reading: 7 } }, budget: { max_tuition: 40000, max_total_year_one: 50000 } },
    requirements: REQUIREMENTS, location: 'london', rules, applicationDate: parseDate('2026-10-22'),
  });
  assert.ok(facts.some((f) => f.includes('below in writing 6')));
  assert.ok(facts.some((f) => f.includes('over by £1,000')), 'tuition 41k vs 40k ceiling');
  assert.ok(facts.some((f) => f.includes('£1529/mo × 9')), '10 months capped at 9');
});

test('evaluate end-to-end: extract → score → report + tracker', async () => {
  const requests = record((body) => body.messages[0].content.startsWith('Extract')
    ? JSON.stringify(REQUIREMENTS)
    : JSON.stringify({
        dimensions: [
          { key: 'admission_probability', score: 3.2, rationale: 'Writing 6.0 is below 7.0.' },
          { key: 'budget_fit', score: 2.5, rationale: 'Over budget.' },
          { key: 'roi', score: 4, rationale: 'Strong uplift.' },
          { key: 'programme_fit', score: 9, rationale: 'Clamped to 5.' },
          { key: 'career_outcomes', score: null, rationale: 'No data on page.' },
        ],
        summary: 'Stretch.', strengths: ['Brand'], risks: ['IELTS writing'], next_actions: ['Retake IELTS writing'],
      }));

  const report = await evaluateUniversity({ url: 'https://www.lse.ac.uk/programmes/msc-finance', fetchImpl: fakePageFetch });
  assert.equal(requests.length, 2);
  assert.match(requests[0].body.messages[0].content, /Fees for overseas students: £41,000/);
  assert.match(requests[1].body.messages[0].content, /below in writing 6/);

  assert.equal(report.status, 'complete');
  assert.equal(report.dimensions.find((d) => d.key === 'programme_fit').score, 5);
  // (3.2×.3 + 2.5×.2 + 4×.2 + 5×.15) / .85 = 3.5
  assert.equal(report.score, 3.5);
  assert.equal(report.grade, 'C');
  assert.match(await fs.readFile(report.reportPath, 'utf8'), /Grade C/);

  const tracker = await fs.readFile(path.join(home, 'data', 'tracker.yaml'), 'utf8');
  assert.match(tracker, /id: lse-msc-finance/);
  assert.match(tracker, /grade: C/);
  assert.match(tracker, /status lifecycle/, 'header comments survive');

  await evaluateUniversity({ url: 'https://www.lse.ac.uk/programmes/msc-finance', fetchImpl: fakePageFetch });
  const again = await fs.readFile(path.join(home, 'data', 'tracker.yaml'), 'utf8');
  assert.equal(again.match(/id: lse-msc-finance/g).length, 1, 're-evaluating updates in place');
});

test('tailor-sop end-to-end: draft → critique → revise', async () => {
  await fs.writeFile(path.join(home, 'data', 'personal_statement.md'), '# Master\nI scaled assays at a CRO.');
  const requests = record((body, n) => [
    'First draft about assays.',
    JSON.stringify({ scores: { specificity: 3, programme_fit: 2, evidence: 3, tone_match: 3, why_uk_and_goals: 3, voice: 4 }, references: [], unsupported_claims: ['I led a team of 50'], cliches: [], fixes: ['Cut the team claim'] }),
    'Final draft about assays at a CRO.',
  ][n - 1]);

  const res = await tailorPersonalStatement({ university: 'imperial', wordLimit: 700 });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.stream, true, 'long-form generation streams');
  assert.match(requests[0].body.system.at(-1).text, /I scaled assays/);
  assert.match(requests[0].body.system[0].text, /Elite SOP Constraints/, 'framework is the system prompt');
  assert.deepEqual(requests[0].body.system, requests[2].body.system, 'identical cached prefix across calls');
  assert.match(requests[2].body.messages[0].content, /I led a team of 50/);

  assert.equal(res.status, 'complete');
  assert.equal(res.draft, 'Final draft about assays at a CRO.');
  assert.match(await fs.readFile(res.outputPath, 'utf8'), /Changes applied in revision/);
  assert.ok(res.warnings.some((w) => /No --url given/.test(w)));
});

test('htmlToText keeps structure and decodes entities', () => {
  assert.equal(htmlToText('<p>Fee &pound;1&#44;000</p><ul><li>A</li></ul><script>x</script>'), 'Fee £1,000\n\n• A');
  assert.equal(countWords('## Hi there\n- one two'), 4);
});
