/**
 * @file Claude provider: the only module that talks to an LLM.
 *
 * Every agent goes through these helpers, so the provider, model, refusal
 * handling, fallbacks and prompt caching are decided in one place.
 *
 * Two providers, picked automatically (override with STUDY_OPS_PROVIDER):
 *  - `api`: the Anthropic API with ANTHROPIC_API_KEY (pay per use). Used
 *    when a key is set.
 *  - `claude-code`: your Claude subscription (Pro/Max) through the Claude
 *    Code CLI you're signed in to (`claude -p`). Used when there's no key
 *    and `claude` is installed. See ./claude_code.js.
 *
 * Nothing is sent until an agent calls {@link structured} or {@link generate}.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { claudeCodeAvailable, runClaudeCode } from './claude_code.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * Server-side fallback: if the model's safety classifiers decline a request,
 * the API re-runs it on Anthropic's recommended fallback model in the same call.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** @type {Anthropic | null} */
let client = null;

/**
 * Swap in a client (tests pass a stub with the same `beta.messages` shape).
 * @param {object | null} next
 */
export function setClient(next) {
  client = next;
}

/** @returns {Anthropic} */
function getClient() {
  client ??= new Anthropic();
  return client;
}

/** Model id from `STUDY_OPS_MODEL`, else the default. */
export function model() {
  return process.env.STUDY_OPS_MODEL || DEFAULT_MODEL;
}

/**
 * Which provider will handle calls: 'api', 'claude-code', or null if neither is set up.
 * STUDY_OPS_PROVIDER=claude-code forces the subscription even when a key is set;
 * STUDY_OPS_PROVIDER=api (or the older "anthropic") forces the API; "off" disables AI steps.
 * @returns {'api'|'claude-code'|null}
 */
export function provider() {
  const forced = (process.env.STUDY_OPS_PROVIDER ?? '').toLowerCase();
  if (forced === 'off' || forced === 'none') return null;
  if (forced === 'claude-code' || forced === 'subscription') return 'claude-code';
  if (forced === 'api' || forced === 'anthropic') return 'api';
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'api';
  return claudeCodeAvailable() ? 'claude-code' : null;
}

/** Human-readable provider, for CLI notes. */
export function providerLabel() {
  const p = provider();
  return p === 'claude-code' ? 'your Claude subscription (Claude Code)' : p === 'api' ? `the Anthropic API (${model()})` : 'no provider';
}

/**
 * Pre-flight so commands can say "set up a provider" instead of failing mid-run.
 */
export function isConfigured() {
  return provider() !== null;
}

/** Shared "not set up" message. */
export const NOT_CONFIGURED = 'No Claude access set up. Either install Claude Code and sign in with your Claude subscription (https://code.claude.com), or add ANTHROPIC_API_KEY to .env.';

/**
 * Build a cached system prompt. The stable context (instructions, profile,
 * master statement) goes first, so repeated calls in one run, like the SOP
 * generate → critique → revise loop, read it from cache.
 * @param {string[]} parts
 */
function cachedSystem(parts) {
  const blocks = parts.map((text) => ({ type: 'text', text }));
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  return blocks;
}

/**
 * Throw a readable error if the whole fallback chain refused or output was cut off.
 * @param {{ stop_reason: string | null, stop_details?: { category?: string | null } | null }} response
 */
function assertUsable(response) {
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category ?? 'unspecified';
    throw new Error(`Claude declined this request (category: ${category}). Rephrase the inputs and try again.`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Claude hit the output limit before finishing. Try a shorter input.');
  }
}

/**
 * One call whose answer is validated against a Zod schema.
 *
 * @template T
 * @param {object} input
 * @param {string[]} input.system      Stable system context, cached.
 * @param {string} input.prompt        Per-call user message.
 * @param {import('zod').ZodType<T>} input.schema
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [input.effort='high']
 * @returns {Promise<T>}
 */
export async function structured({ system, prompt, schema, effort = 'high' }) {
  if (provider() === 'claude-code') return (await runClaudeCode({ system, prompt, schema, effort })).data;
  const response = await getClient().beta.messages.parse({
    model: model(),
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    system: cachedSystem(system),
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: betaZodOutputFormat(schema) },
  });
  assertUsable(response);
  if (!response.parsed_output) throw new Error('Claude returned output that did not match the expected format.');
  return response.parsed_output;
}

/**
 * Structured call with Anthropic's server-side web search, limited to the given
 * domains. Long searches can pause mid-turn (`pause_turn`). The paused turn is
 * sent back as-is so the server resumes where it stopped.
 *
 * @template T
 * @param {object} input
 * @param {string[]} input.system
 * @param {string} input.prompt
 * @param {import('zod').ZodType<T>} input.schema
 * @param {string[]} input.allowedDomains
 * @param {number} [input.maxSearches=5]
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [input.effort='medium']
 * @returns {Promise<T>}
 */
export async function structuredWithSearch({ system, prompt, schema, allowedDomains, maxSearches = 5, effort = 'medium' }) {
  if (provider() === 'claude-code') {
    // Claude Code's WebSearch has no domain filter, so the limit is stated in
    // the prompt. Agents still verify every URL's domain and content locally.
    const scoped = `Search and fetch only pages on these domains: ${allowedDomains.join(', ')}. Use at most ${maxSearches} searches.\n\n${prompt}`;
    return (await runClaudeCode({ system, prompt: scoped, schema, effort, tools: ['WebSearch', 'WebFetch'] })).data;
  }
  const messages = [{ role: 'user', content: prompt }];
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await getClient().beta.messages.parse({
      model: model(),
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      system: cachedSystem(system),
      messages,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches, allowed_domains: allowedDomains }],
      output_config: { effort, format: betaZodOutputFormat(schema) },
    });
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    assertUsable(response);
    if (!response.parsed_output) throw new Error('Claude returned output that did not match the expected format.');
    return response.parsed_output;
  }
  throw new Error('Web search did not finish after several resumes. Try again, or pass programme URLs directly with --urls.');
}

/**
 * One free-text call. Streams under the hood so long drafts never hit HTTP
 * timeouts, and returns the final text.
 *
 * @param {object} input
 * @param {string[]} input.system
 * @param {string} input.prompt
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [input.effort='high']
 * @returns {Promise<string>}
 */
export async function generate({ system, prompt, effort = 'high' }) {
  if (provider() === 'claude-code') return (await runClaudeCode({ system, prompt, effort })).text;
  const stream = getClient().beta.messages.stream({
    model: model(),
    max_tokens: 64000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    system: cachedSystem(system),
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort },
  });
  const response = await stream.finalMessage();
  assertUsable(response);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Map SDK errors to one-line messages the CLI can show.
 * @param {unknown} err
 * @returns {Error}
 */
export function explainError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env.');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new Error(`This API key cannot use ${model()}. Set STUDY_OPS_MODEL in .env to a model your account can access.`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Rate limited by Anthropic. Wait a minute and retry.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('Could not reach the Anthropic API. Check your internet connection.');
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error ${err.status}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
