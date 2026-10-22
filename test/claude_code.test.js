import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';

// A fake `claude` CLI that records how it was called and answers like `claude -p --output-format json`.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'study-ops-cc-test-'));
const log = path.join(dir, 'calls.jsonl');
const fake = path.join(dir, 'fake-claude.mjs');
await fs.writeFile(fake, `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const at = (f) => args[args.indexOf(f) + 1];
  const system = fs.readFileSync(at('--system-prompt-file'), 'utf8');
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin, system, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null }) + '\\n');
  if (stdin.includes('FAIL_AUTH')) { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })); process.exit(1); }
  const schema = args.includes('--json-schema') ? JSON.parse(at('--json-schema')) : null;
  const structured = schema ? (stdin.includes('BAD_SHAPE') ? { wrong: true } : { fee_gbp: 41000, programmes: [] }) : undefined;
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Drafted text.', structured_output: structured, total_cost_usd: 0.01 }));
});
`);

process.env.STUDY_OPS_PROVIDER = 'claude-code';
process.env.STUDY_OPS_CLAUDE_BIN = fake;
process.env.ANTHROPIC_API_KEY = 'sk-should-not-be-used';

const { structured, generate, structuredWithSearch, provider, isConfigured } = await import('../src/llm/claude.js');
const { claudeCodeAvailable, resetClaudeCodeCache } = await import('../src/llm/claude_code.js');

const calls = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
before(async () => fs.rm(log, { force: true }));
after(async () => fs.rm(dir, { recursive: true, force: true }));

test('provider selection: forced subscription, auto-detection, off switch', () => {
  assert.equal(provider(), 'claude-code');
  assert.equal(isConfigured(), true);
  process.env.STUDY_OPS_PROVIDER = '';
  assert.equal(provider(), 'api', 'an API key wins when nothing is forced');
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  resetClaudeCodeCache();
  assert.equal(claudeCodeAvailable(), true);
  assert.equal(provider(), 'claude-code', 'no key + claude installed → subscription');
  process.env.STUDY_OPS_PROVIDER = 'off';
  assert.equal(provider(), null);
  process.env.STUDY_OPS_PROVIDER = 'claude-code';
  process.env.ANTHROPIC_API_KEY = key;
});

test('structured call: schema passed, prompt on stdin, system in a file, no tools, no API key, temp cwd', async () => {
  const out = await structured({ system: ['RULES', 'PROFILE'], prompt: 'Extract the fee. PAGE TEXT', schema: z.object({ fee_gbp: z.number().nullable(), programmes: z.array(z.string()) }) });
  assert.equal(out.fee_gbp, 41000);
  const [c] = await calls();
  assert.ok(c.args.includes('-p') && c.args.includes('--no-session-persistence'));
  assert.equal(c.args[c.args.indexOf('--output-format') + 1], 'json');
  assert.equal(c.args[c.args.indexOf('--tools') + 1], '', 'writing calls get no tools');
  assert.ok(!c.args.includes('--bare'), 'bare mode would ignore the subscription login');
  assert.match(c.stdin, /PAGE TEXT/);
  assert.match(c.system, /RULES\n\nPROFILE/);
  assert.equal(c.apiKey, null, 'API key removed so the subscription is used');
  assert.ok(c.cwd.includes('study-ops-cc-'), 'runs outside the repo so no CLAUDE.md or hooks load');
  const schema = JSON.parse(c.args[c.args.indexOf('--json-schema') + 1]);
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties.fee_gbp);
});

test('text and search calls', async () => {
  await fs.rm(log, { force: true });
  assert.equal(await generate({ system: ['S'], prompt: 'Write.' }), 'Drafted text.');
  await structuredWithSearch({ system: ['S'], prompt: 'Find programmes', schema: z.object({ programmes: z.array(z.string()) }), allowedDomains: ['ucl.ac.uk'], maxSearches: 3 });
  const [gen, search] = await calls();
  assert.ok(!gen.args.includes('--json-schema'));
  assert.equal(search.args[search.args.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(search.args[search.args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  assert.match(search.stdin, /only pages on these domains: ucl\.ac\.uk/);
});

test('errors: not signed in, wrong shape', async () => {
  await assert.rejects(generate({ system: ['S'], prompt: 'FAIL_AUTH' }), /not signed in/);
  await assert.rejects(structured({ system: ['S'], prompt: 'BAD_SHAPE', schema: z.object({ fee_gbp: z.number() }) }), /did not match the expected format/);
});

test('an empty API balance points to the subscription instead of a top-up', async () => {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { explainError } = await import('../src/llm/claude.js');
  const err = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'Your credit balance is too low to access the Anthropic API.', new Headers());
  assert.match(explainError(err).message, /STUDY_OPS_PROVIDER=claude-code/);
});
