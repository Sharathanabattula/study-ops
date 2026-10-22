/**
 * @file Claude Code provider: runs every AI step on your Claude subscription.
 *
 * Instead of calling the API with a key, Study-Ops runs `claude -p`, the
 * headless mode of the Claude Code CLI you're signed in to (Pro or Max). Usage
 * counts against your plan's limits rather than API billing. This is how
 * career-ops-style tools run.
 *
 * How each call is made:
 *  - The system prompt goes in a temporary file (`--system-prompt-file`) and the
 *    prompt on stdin, so long programme pages don't hit Windows'
 *    command-line limit.
 *  - Writing calls get no tools (`--tools ""`). Search calls get only
 *    WebSearch and WebFetch, pre-approved, and everything they return is
 *    still verified locally by Study-Ops.
 *  - Structured calls pass a JSON Schema (`--json-schema`) and the answer is
 *    validated again against the agent's Zod schema.
 *  - Runs from a temporary directory with `--no-session-persistence`, so it
 *    picks up no project CLAUDE.md, hooks or MCP servers and leaves no history.
 *  - `--bare` is deliberately not used: bare mode ignores your subscription login.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import * as z from 'zod';

/** Command to run. Tests point this at a fake CLI. */
export function claudeBin() {
  return process.env.STUDY_OPS_CLAUDE_BIN || 'claude';
}

/** Split the configured binary into command + leading args (a .mjs fake runs under node). */
function command() {
  const bin = claudeBin();
  return /\.(mjs|cjs|js)$/.test(bin) ? [process.execPath, [bin]] : [bin, []];
}

let available = null;

/** Is the `claude` CLI installed? Cached; spawns `claude --version` once. */
export function claudeCodeAvailable() {
  if (available !== null) return available;
  const [cmd, pre] = command();
  const r = spawn.sync(cmd, [...pre, '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  available = r.status === 0;
  return available;
}

/** Reset the availability cache (tests). */
export function resetClaudeCodeCache() {
  available = null;
}

/**
 * Run one headless call.
 * @param {object} input
 * @param {string[]} input.system
 * @param {string} input.prompt
 * @param {import('zod').ZodType} [input.schema]    structured output when given
 * @param {string[]} [input.tools]                  e.g. ['WebSearch', 'WebFetch']; default none
 * @param {string} [input.effort]
 * @param {number} [input.timeoutMs=900000]
 * @returns {Promise<{ text: string, data: any, costUsd: number|null }>}
 */
export async function runClaudeCode({ system, prompt, schema, tools = [], effort, timeoutMs = 900_000 }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'study-ops-cc-'));
  const systemFile = path.join(dir, 'system.md');
  await fs.writeFile(systemFile, system.join('\n\n'), 'utf8');

  const args = [
    '-p', 'Follow the task given on standard input.',
    '--output-format', 'json',
    '--system-prompt-file', systemFile,
    '--no-session-persistence',
    '--tools', tools.join(','),
    ...(tools.length ? ['--allowedTools', tools.join(','), '--max-turns', '30'] : ['--max-turns', '3']),
    ...(schema ? ['--json-schema', JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }))] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(process.env.STUDY_OPS_CLAUDE_MODEL ? ['--model', process.env.STUDY_OPS_CLAUDE_MODEL] : []),
  ];

  // Make sure the CLI uses your subscription login, not an API key that
  // happens to be in the environment (that would bill API usage instead).
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const [cmd, pre] = command();
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(cmd, [...pre, ...args], { cwd: dir, windowsHide: true, env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Claude Code took longer than ${Math.round(timeoutMs / 60000)} minutes.`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error('The `claude` command was not found. Install Claude Code (https://code.claude.com) and sign in, or set ANTHROPIC_API_KEY.') : e); });
    child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, stdout: out, stderr: err }); });
    child.stdin.end(prompt);
  }).finally(() => fs.rm(dir, { recursive: true, force: true }));

  let json;
  try {
    json = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) ?? '');
  } catch {
    throw new Error(`Claude Code returned no JSON (exit ${code}). ${stderr.trim().split('\n').at(-1) ?? ''}`.trim());
  }
  if (json.is_error || code !== 0) {
    const msg = String(json.result ?? json.error ?? stderr ?? 'unknown error');
    if (/log ?in|auth|credential|not logged/i.test(msg)) throw new Error('Claude Code is not signed in. Run `claude` once and log in with your Claude account (or run `claude auth login`).');
    if (/limit|usage|quota/i.test(msg)) throw new Error(`Your Claude plan's usage limit was reached: ${msg.slice(0, 160)}`);
    throw new Error(`Claude Code failed: ${msg.slice(0, 300)}`);
  }

  let data = null;
  if (schema) {
    if (json.structured_output == null) throw new Error('Claude Code finished without structured output. Try again.');
    const parsed = schema.safeParse(json.structured_output);
    if (!parsed.success) throw new Error(`Claude Code's answer did not match the expected format: ${parsed.error.issues[0]?.message ?? ''}`);
    data = parsed.data;
  }
  return { text: String(json.result ?? '').trim(), data, costUsd: json.total_cost_usd ?? null };
}
