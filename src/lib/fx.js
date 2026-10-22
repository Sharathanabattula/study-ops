/**
 * @file GBP → home-currency exchange rates.
 *
 * UKVI converts funds held in other currencies with OANDA's rate on the day
 * you submit your online application. Study-Ops cannot know that future rate,
 * so it uses today's reference rate (European Central Bank, via
 * frankfurter.app) plus a buffer. Pass a rate explicitly (`--fx`) to use your
 * bank's rate or a rate you've checked on OANDA.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { PATHS } from './paths.js';
import { exists } from './files.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.from='GBP']
 * @param {string} [opts.to='INR']
 * @param {number} [opts.override]      Use this rate as-is.
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ rate: number, source: string, date: string }>}
 */
export async function getRate({ from = 'GBP', to = 'INR', override, fetchImpl = fetch } = {}) {
  if (typeof override === 'number' && override > 0) return { rate: override, source: 'manual', date: new Date().toISOString().slice(0, 10) };

  const cacheFile = path.join(PATHS.data, 'fx.yaml');
  const today = new Date().toISOString().slice(0, 10);
  const cache = (await exists(cacheFile)) ? YAML.parse(await fs.readFile(cacheFile, 'utf8')) ?? {} : {};
  const key = `${from}-${to}`;
  if (cache[key]?.fetched === today) return cache[key];

  let json;
  try {
    const res = await fetchImpl(`https://api.frankfurter.app/latest?from=${from}&to=${to}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (err) {
    throw new Error(`Could not fetch a ${from}/${to} rate (${err.message}). Pass one with --fx, e.g. --fx 112.4`);
  }
  const rate = json?.rates?.[to];
  if (!(rate > 0)) throw new Error(`No ${from}/${to} rate in the response. Pass one with --fx.`);
  const result = { rate, source: 'ECB reference rate (frankfurter.app)', date: json.date ?? today, fetched: today };
  cache[key] = result;
  await fs.mkdir(PATHS.data, { recursive: true });
  await fs.writeFile(cacheFile, YAML.stringify(cache), 'utf8');
  return result;
}

/**
 * Convert GBP to home currency with a buffer, rounded up to a clean figure.
 * @param {number} gbp
 * @param {number} rate
 * @param {number} [buffer=0]   e.g. 0.05 for 5%
 * @param {number} [roundTo=1000]
 */
export function toHome(gbp, rate, buffer = 0, roundTo = 1000) {
  return Math.ceil((gbp * rate * (1 + buffer)) / roundTo) * roundTo;
}

/** Indian-style grouping (12,34,567) for INR, standard otherwise. */
export function formatHome(amount, currency = 'INR') {
  return `${currency === 'INR' ? '₹' : `${currency} `}${Math.round(amount).toLocaleString(currency === 'INR' ? 'en-IN' : 'en-GB')}`;
}
