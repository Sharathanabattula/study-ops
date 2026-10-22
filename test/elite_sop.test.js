import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { recordingClient } from './helpers.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'study-ops-elite-'));
process.env.STUDY_OPS_HOME = home;
process.env.ANTHROPIC_API_KEY = 'test-key';

const { setClient } = await import('../src/llm/claude.js');
const { loadFramework, eliteViolations, listUnder } = await import('../src/lib/sop_framework.js');
const { generateTailoredSOP, sopFileName } = await import('../src/agents/2_sop_tailor.js');
const { initWorkspace } = await import('../src/commands/init.js');
const { PATHS } = await import('../src/lib/paths.js');

const RAW = `# Master SOP: Raw Material

## 1. The milestone
At Helix CRO I rebuilt the assay scheduling model and cut turnaround time by 14% across 3 labs.

## 3. Projects
Built a survival-analysis model in R to predict which assay batches would fail QC; it flagged 22 of 25 failures in a back-test.

## 5. The turning point
Funding committees rejected sound projects because nobody could price the scientific risk.

## 8. Goals
Short term: analyst at a life-sciences venture fund. Long term: build a fund that prices scientific risk explicitly.
`;

const DETAILS = { professor: 'Professor Jane Smith', module: 'Analytics for Healthcare', lab: 'Institute of Global Health Innovation' };

const COMPLIANT = `At Helix CRO I rebuilt the assay scheduling model and cut turnaround time by 14% across 3 labs.

The survival-analysis model I built in R flagged 22 of 25 QC failures in a back-test, which convinced me that scientific risk can be priced.

Funding committees kept rejecting sound projects because nobody could price that risk.

At Imperial, Analytics for Healthcare would formalise the survival methods I used; Professor Jane Smith's work on healthcare decision models extends them; and the Institute of Global Health Innovation would let me test them on clinical data.

I intend to join a life-sciences venture fund as an analyst, and later build a fund that prices scientific risk explicitly.`;

const VIOLATING = `Ever since I was a child I have been passionate about science, and I improved processes by 99%.

The survival-analysis model I built in R flagged 22 of 25 QC failures.

At Imperial, Analytics for Healthcare and Professor Jane Smith's research align with my goals.

I want to work in venture capital.`;

before(async () => {
  await initWorkspace();
  await fs.writeFile(PATHS.profile, `---\n${YAML.stringify({ schema_version: 1, identity: { full_name: 'Asha Rao', nationality: 'India' }, target: { subjects: ['Business Analytics'] } })}---\n`);
});
after(async () => fs.rm(home, { recursive: true, force: true }));

test('init scaffolds the framework and raw-material files at the requested paths', async () => {
  assert.equal(PATHS.eliteFramework, path.join(home, 'data', 'templates', 'elite_sop_framework.md'));
  assert.equal(PATHS.masterRaw, path.join(home, 'data', 'master_sop_raw.md'));
  assert.match(await fs.readFile(PATHS.eliteFramework, 'utf8'), /The "Anti-Childhood" Rule/);
  assert.match(await fs.readFile(PATHS.masterRaw, 'utf8'), /## 1\. The milestone/);
  assert.equal(sopFileName('Imperial College London'), 'SOP_Imperial_College_London.md');
});

test('framework lists are parsed from the Markdown, so code and prompt share one source', async () => {
  const f = await loadFramework();
  assert.ok(f.bannedWords.includes('passionate') && f.bannedWords.includes('hardworking') && f.bannedWords.includes('fascinated'));
  assert.ok(f.bannedOpenings.includes('ever since'));
  assert.doesNotMatch(f.text, /<!--/, 'comments are stripped from the system prompt');
  assert.deepEqual(listUnder('## Banned words\n- `alpha`\n- `beta`\n## Next', 'Banned words'), ['alpha', 'beta']);
});

test('eliteViolations enforces Rules 1–3', async () => {
  const f = await loadFramework();
  assert.deepEqual(eliteViolations(COMPLIANT, f, DETAILS), []);
  const issues = eliteViolations(VIOLATING, f, DETAILS);
  assert.ok(issues.some((i) => i.startsWith('Rule 1')));
  assert.ok(issues.some((i) => i.includes('"passionate"')));
  assert.ok(issues.some((i) => i.includes('lab "Institute of Global Health Innovation"')));
  assert.ok(!issues.some((i) => i.includes('professor')), 'professor is present in the final body paragraph');
});

test('generateTailoredSOP: framework as system prompt, violations fed into revision, saved as SOP_<Uni>.md', async () => {
  await fs.writeFile(PATHS.masterRaw, RAW);
  const reqs = recordingClient(setClient, (body) => {
    if (body.output_config?.format) {
      return JSON.stringify({ scores: { opening: 2, evidence: 2, why_university: 3, tone: 2, truthfulness: 2, coherence: 3 }, references: [{ name: 'Professor Jane Smith', kind: 'person' }, { name: 'Dr Nobody', kind: 'person' }], unsupported_claims: ['improved processes by 99%'], cliches: [], fixes: ['Open with the Helix milestone'] });
    }
    return body.messages[0].content.includes('required_changes') ? COMPLIANT : VIOLATING;
  });

  const r = await generateTailoredSOP('Imperial College London', 'MSc Business Analytics', DETAILS);
  assert.equal(r.status, 'complete');
  assert.equal(r.outputPath, path.join(home, 'outputs', 'sops', 'SOP_Imperial_College_London.md'));
  assert.deepEqual(r.violations, []);
  assert.equal(reqs.length, 3);

  assert.match(reqs[0].body.system[0].text, /^# The Elite SOP Constraints/);
  assert.match(reqs[0].body.system[1].text, /cut turnaround time by 14%/);
  const task = reqs[0].body.messages[0].content;
  assert.match(task, /Professor: Professor Jane Smith/);
  assert.match(task, /Module: Analytics for Healthcare/);
  assert.match(task, /Lab \/ research group \/ facility: Institute of Global Health Innovation/);

  const revision = reqs[2].body.messages[0].content;
  for (const re of [/Rule 1/, /"passionate"/, /Rule 3: .*Institute of Global Health Innovation/, /"99%"/, /Remove "Dr Nobody"/]) assert.match(revision, re);

  const saved = await fs.readFile(r.outputPath, 'utf8');
  assert.match(saved, /Elite rules:\*\* all code checks pass/);
  assert.ok(r.warnings.some((w) => /unverified/.test(w)), 'CLI-supplied names without pages are flagged for checking');
});

test('missing Rule 3 details are reported, never invented', async () => {
  recordingClient(setClient, (body) => (body.output_config?.format
    ? JSON.stringify({ scores: { opening: 4, evidence: 4, why_university: 3, tone: 4, truthfulness: 5, coherence: 4 }, references: [], unsupported_claims: [], cliches: [], fixes: [] })
    : COMPLIANT));
  const r = await generateTailoredSOP('LSE', 'MSc Finance', { module: 'Asset Markets' });
  assert.equal(r.details.professor, null);
  assert.ok(r.warnings.some((w) => /No professor supplied/.test(w)));
  assert.ok(r.warnings.some((w) => /No lab supplied/.test(w)));
});

test('bracketed editorial notes inside an essay are detected', async () => {
  const { bracketNotes } = await import('../src/agents/2_sop_tailor.js');
  assert.deepEqual(bracketNotes('I would study X. [No usable professor was supplied, so none is named.] Then Y [1].'), ['[No usable professor was supplied, so none is named.]']);
});

test('refuses an empty raw-material template', async () => {
  await fs.copyFile(path.join(PATHS.templates, 'master_sop_raw.md'), PATHS.masterRaw);
  await assert.rejects(generateTailoredSOP('LSE', 'MSc Finance', DETAILS), /still the empty template/);
  await fs.writeFile(PATHS.masterRaw, RAW);
});

test('CLI: study-ops generate-sop --uni --course --prof --module works end to end (scaffold mode)', () => {
  const bin = fileURLToPath(new URL('../bin/study-ops.js', import.meta.url));
  const env = { ...process.env, STUDY_OPS_HOME: home, STUDY_OPS_PROVIDER: 'off' };
  delete env.ANTHROPIC_API_KEY;
  const out = spawnSync(process.execPath, [bin, 'generate-sop', '--uni', 'Target University', '--course', 'Course Name', '--prof', 'Professor Name', '--module', 'Specific Module'], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /SOP_Target_University\.prompt\.md/);
  return fs.readFile(path.join(home, 'outputs', 'sops', 'SOP_Target_University.prompt.md'), 'utf8').then((prompt) => {
    assert.match(prompt, /Elite SOP Constraints/);
    assert.match(prompt, /Professor: Professor Name/);
    assert.match(prompt, /Module: Specific Module/);
    assert.match(prompt, /cut turnaround time by 14%/);
  });
});
