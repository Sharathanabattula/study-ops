/**
 * @file Assisted browser: a real Chromium window that the student controls.
 *
 * Study-Ops opens portals in a visible browser with a persistent local
 * profile per site (data/browser/<host>/), so the student signs in once,
 * completes CAPTCHAs and 2FA themselves, and stays signed in between runs.
 * The tool fills fields; it never clicks submit, pay or "create account".
 *
 * Playwright is an optional dependency:
 *   npm install playwright && npx playwright install chromium
 * Set STUDY_OPS_CHROMIUM to use an existing Chrome/Chromium binary instead.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './paths.js';

/** @returns {Promise<import('playwright').BrowserType>} */
async function chromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    throw new Error('Browser automation needs Playwright: run `npm install playwright && npx playwright install chromium`.');
  }
}

function launchOptions(headless) {
  return { headless, ...(process.env.STUDY_OPS_CHROMIUM ? { executablePath: process.env.STUDY_OPS_CHROMIUM } : {}) };
}

/**
 * Open a persistent, visible browser for one site.
 * @param {string} url
 * @param {{ headless?: boolean }} [opts]
 * @returns {Promise<{ context: import('playwright').BrowserContext, page: import('playwright').Page }>}
 */
export async function openAssisted(url, { headless = false } = {}) {
  const host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
  const profileDir = path.join(PATHS.browserProfiles, host);
  await fs.mkdir(profileDir, { recursive: true });
  const browser = await chromium();
  let context;
  try {
    context = await browser.launchPersistentContext(profileDir, { ...launchOptions(headless), viewport: null });
  } catch (err) {
    throw new Error(`Could not start Chromium (${err.message.split('\n')[0]}). Run \`npx playwright install chromium\` or set STUDY_OPS_CHROMIUM.`);
  }
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

/**
 * Throwaway headless browser, used by tests and `--headless` dry runs.
 * @returns {Promise<{ browser: import('playwright').Browser, page: import('playwright').Page }>}
 */
export async function openHeadless() {
  const browser = await (await chromium()).launch(launchOptions(true));
  return { browser, page: await browser.newPage() };
}
