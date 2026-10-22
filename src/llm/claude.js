/**
 * @file Anthropic Claude provider: the only module that talks to an LLM.
 *
 * Every agent goes through these helpers, so model choice, refusal handling,
 * fallbacks and prompt caching are decided in one place.
 *
 * Credentials resolve the SDK's usual way: `ANTHROPIC_API_KEY`, then
 * `ANTHROPIC_AUTH_TOKEN`, then an `ant auth login` profile. Nothing is sent
 * until an agent calls {@link structured} or {@link generate}.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';

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
 * Cheap pre-flight so commands can say "configure a provider" instead of
 * failing mid-run. An `ant auth login` profile also works even when this
 * returns false, so set `STUDY_OPS_PROVIDER=anthropic` to skip the check.
 */
export function isConfigured() {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.STUDY_OPS_PROVIDER === 'anthropic',
  );
}

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
