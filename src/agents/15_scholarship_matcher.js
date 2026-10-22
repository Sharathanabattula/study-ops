/**
 * @file Agent 15: Scholarship Matcher.
 *
 * Two sources, two levels of trust:
 *
 *  1. External schemes (Chevening, GREAT, Commonwealth…) from
 *     `config/scholarships.yaml`. Each rule (nationality, level, course
 *     length, work experience, grades, prior UK master's) is checked in code
 *     against the profile and applicant data, and each window is dated, so
 *     a closed scheme says "closed", not "apply now".
 *  2. University awards and bursaries: Claude searches each university's own
 *     domain, then every award page is fetched locally. An award is kept only
 *     if its name appears on that page; stated amounts must also appear there.
 *
 * Output: `reports/scholarships.md`, eligible and open first, with what each
 * needs and when it closes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import YAML from 'yaml';
import { PATHS } from '../lib/paths.js';
import { exists, readYaml } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { findUniversity, loadUniversities } from '../lib/universities.js';
import { fetchPageText } from '../lib/web.js';
import { mentions, unsupportedNumbers } from '../lib/factcheck.js';
import { isConfigured, structuredWithSearch } from '../llm/claude.js';
import { CLASS_ORDER, auditProfile } from './4_profile_auditor.js';

const DAY = 86_400_000;

/**
 * @typedef {{ rule: string, status: 'pass'|'fail'|'check', detail: string }} RuleResult
 * @typedef {object} SchemeMatch
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} covers
 * @property {'eligible'|'check'|'ineligible'} eligibility
 * @property {RuleResult[]} rules
 * @property {{ cycle: string|null, status: 'open'|'closed'|'upcoming'|'unannounced', closes: string|null, daysLeft: number|null, note: string }} window
 */

/** Academic cycle for an intake, e.g. "2027-09" → "2027-28". */
export function cycleFor(intake) {
  const y = Number(String(intake ?? '').slice(0, 4));
  return y ? `${y}-${String((y + 1) % 100).padStart(2, '0')}` : null;
}

/**
 * Check one scheme. Pure.
 * @param {any} scheme              config entry
 * @param {object} ctx
 * @param {Record<string, any>} ctx.facts       profile front-matter
 * @param {Record<string, any>} [ctx.applicant] applicant.yaml
 * @param {import('./4_profile_auditor.js').ProfileAudit} ctx.audit
 * @param {number} [ctx.courseMonths]
 * @param {Date} [ctx.today]
 * @returns {SchemeMatch}
 */
export function matchScheme(scheme, { facts, applicant = {}, audit, courseMonths, today = new Date() }) {
  const r = scheme.rules ?? {};
  /** @type {RuleResult[]} */
  const rules = [];
  const add = (rule, status, detail) => rules.push({ rule, status, detail });

  const nationality = applicant.personal?.nationality || facts.identity?.nationality;
  if (r.nationalities) {
    if (!nationality) add('nationality', 'check', 'Nationality not set in your profile.');
    else add('nationality', r.nationalities.some((n) => n.toLowerCase() === String(nationality).toLowerCase()) ? 'pass' : 'fail', `${nationality}`);
  }

  const level = facts.target?.level;
  if (r.levels || r.excluded_levels) {
    if (!level) add('level', 'check', 'Target level not set.');
    else if (r.excluded_levels?.some((l) => l.toLowerCase() === level.toLowerCase())) add('level', 'fail', `${level} is excluded.`);
    else {
      // "Master's" in the config stands for any master's-level award (MSc, MA, MRes, MPhil, LLM…).
      const ok = !r.levels || r.levels.some((l) => l.toLowerCase() === level.toLowerCase() || (l === "Master's" && /^(m[a-z]*|llm)$/i.test(level)));
      add('level', ok ? 'pass' : 'fail', level);
    }
  }

  if (r.max_course_months) {
    if (courseMonths == null) add('course length', 'check', `Must be ≤ ${r.max_course_months} months; check each course.`);
    else add('course length', courseMonths <= r.max_course_months ? 'pass' : 'fail', `${courseMonths} months (max ${r.max_course_months})`);
  }

  if (r.min_work_months) {
    const months = facts.experience?.total_months;
    if (typeof months !== 'number' || months === 0) add('work experience', months === 0 ? 'fail' : 'check', `Needs ${r.min_work_months} months; profile shows ${months ?? 'none'}.`);
    else add('work experience', months >= r.min_work_months ? 'pass' : 'fail', `${months} of ${r.min_work_months} months`);
  }

  if (r.min_uk_class) {
    if (!audit.grades.ukClass) add('grades', 'check', 'No grade in profile.');
    else add('grades', CLASS_ORDER.indexOf(audit.grades.ukClass) >= CLASS_ORDER.indexOf(r.min_uk_class) ? 'pass' : 'fail', `Estimated ${audit.grades.ukClassLabel}; needs ${r.min_uk_class.replace('_', ' ')}`);
  }
  if (r.min_percentage_india && audit.grades.percentage !== null) {
    add('percentage', audit.grades.percentage >= r.min_percentage_india ? 'pass' : 'fail', `${audit.grades.percentage}% (reported minimum ${r.min_percentage_india}%)`);
  }

  if (r.no_previous_uk_masters) {
    const ukMasters = (applicant.education ?? []).some((e) => /united kingdom|^uk$|england|scotland|wales/i.test(e?.country ?? '') && /master|msc|ma\b|mres|llm/i.test(e?.qualification ?? ''));
    add('no previous UK master’s', ukMasters ? 'fail' : 'pass', ukMasters ? 'You already hold a UK master’s.' : 'None recorded.');
  }
  if (r.return_home_years) add('return home', 'check', `You must commit to living in your home country for ${r.return_home_years} years after the award.`);
  if (r.requires_participating_university) add('university', 'check', 'Only at participating universities, which change every year.');
  if (r.nominated_by) add('route', 'check', `Apply via: ${r.nominated_by}.`);

  const eligibility = rules.some((x) => x.status === 'fail') ? 'ineligible' : rules.some((x) => x.status === 'check') ? 'check' : 'eligible';

  // Window for the student's intake cycle.
  const cycle = cycleFor(facts.target?.intake);
  const w = cycle ? scheme.cycles?.[cycle] : null;
  let window;
  if (!w) window = { cycle, status: 'unannounced', closes: null, daysLeft: null, note: scheme.next_cycle_note ?? 'Dates not yet published.' };
  else {
    const closes = w.closes ? Date.parse(w.closes.length === 10 ? `${w.closes}T23:59:59Z` : w.closes) : null;
    const opens = w.opens ? Date.parse(`${w.opens}T00:00:00Z`) : null;
    const status = closes && today > closes ? 'closed' : opens && today < opens ? 'upcoming' : 'open';
    window = { cycle, status, closes: w.closes ?? null, daysLeft: closes ? Math.ceil((closes - today) / DAY) : null, note: status === 'closed' ? scheme.next_cycle_note ?? '' : '' };
  }

  return { id: scheme.id, name: scheme.name, url: scheme.url, covers: scheme.covers, eligibility, rules, window };
}

const AwardsSchema = z.object({
  awards: z.array(z.object({
    name: z.string().describe('Award name exactly as on the page'),
    amount: z.string().nullable().describe('As stated, e.g. "£5,000 tuition fee discount"'),
    eligibility: z.string().describe('Who can apply, as stated'),
    deadline: z.string().nullable().describe('As stated'),
    url: z.string().describe('Official page describing this award'),
  })),
});

/**
 * Find and verify a university's own awards for international postgraduates.
 * Cached for 30 days in data/scholarships/<uni>.yaml.
 * @param {import('../lib/universities.js').University} university
 * @param {{ level?: string, subject?: string, refresh?: boolean, fetchImpl?: typeof fetch }} [opts]
 */
export async function findUniversityAwards(university, { level = 'MSc', subject = '', refresh = false, fetchImpl } = {}) {
  const file = path.join(PATHS.data, 'scholarships', `${university.key}.yaml`);
  if (!refresh && (await exists(file))) {
    const cached = await readYaml(file);
    if ((Date.now() - Date.parse(cached.at)) / DAY <= 30) return cached;
  }
  const found = await structuredWithSearch({
    system: ['You find scholarships, bursaries and fee discounts on UK university websites for Study-Ops. Only return awards you saw on official pages during this search, with those pages’ URLs and wording.'],
    schema: AwardsSchema,
    allowedDomains: university.domains,
    maxSearches: 4,
    prompt: `Find scholarships, bursaries or fee discounts at ${university.name} open to international (ideally Indian) students starting a ${level}${subject ? ` in ${subject}` : ''}. Up to 8.`,
  });
  const verified = [];
  const dropped = [];
  for (const a of found.awards) {
    let text = '';
    try {
      const host = new URL(a.url).hostname;
      if (!university.domains.some((d) => host === d || host.endsWith(`.${d}`))) throw new Error('off-domain');
      text = (await fetchPageText(a.url, { fetchImpl })).text;
    } catch {
      dropped.push(a.name);
      continue;
    }
    if (!mentions(text, a.name)) { dropped.push(a.name); continue; }
    const amountOk = !a.amount || !unsupportedNumbers(a.amount, [text]).length;
    verified.push({ ...a, amount: amountOk ? a.amount : null, amount_note: amountOk ? null : 'Amount not confirmed on the page' });
  }
  const result = { at: new Date().toISOString(), university: university.name, awards: verified, dropped };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, YAML.stringify(result), 'utf8');
  return result;
}

/**
 * Full match: external schemes + (optionally) each university's awards.
 * @param {object} [input]
 * @param {string[]} [input.universities]  Registry keys; default = tracked applications' universities.
 * @param {boolean} [input.internal=true]  Search university sites (needs Claude access).
 * @param {number} [input.courseMonths]
 * @param {boolean} [input.refresh]
 * @param {Date} [input.today]
 * @param {(s: string) => void} [input.onProgress]
 * @param {typeof fetch} [input.fetchImpl]
 */
export async function matchScholarships({ universities, internal = true, courseMonths, refresh = false, today = new Date(), onProgress = () => {}, fetchImpl } = {}) {
  const [profile, config] = await Promise.all([loadProfile(), readYaml(PATHS.scholarships)]);
  const applicant = (await exists(PATHS.applicant)) ? YAML.parse(await fs.readFile(PATHS.applicant, 'utf8')) ?? {} : {};
  const audit = await auditProfile({ profile });
  const external = config.schemes
    .map((s) => matchScheme(s, { facts: profile.facts, applicant, audit, courseMonths, today }))
    .sort((a, b) => rank(a) - rank(b));

  const internalResults = [];
  const warnings = [];
  if (internal) {
    if (!isConfigured()) warnings.push('University awards need Claude access (Claude Code sign-in or ANTHROPIC_API_KEY). Showing external schemes only.');
    else {
      let keys = universities;
      if (!keys?.length) {
        const tracker = (await exists(PATHS.tracker)) ? await readYaml(PATHS.tracker) : {};
        const registry = await loadUniversities();
        keys = [...new Set((tracker?.applications ?? []).filter((a) => !String(a.id).startsWith('example-'))
          .map((a) => registry.find((u) => u.name === a.university || u.key === String(a.short_name ?? '').toLowerCase())?.key).filter(Boolean))];
      }
      if (!keys.length) warnings.push('No universities to search. Pass --unis lse,ucl or add applications to the tracker.');
      for (const key of keys) {
        const uni = await findUniversity(key);
        if (!uni) { warnings.push(`"${key}" is not in the registry.`); continue; }
        onProgress(`Searching ${uni.name} for awards`);
        try {
          internalResults.push(await findUniversityAwards(uni, { level: profile.facts.target?.level, subject: profile.facts.target?.subjects?.[0], refresh, fetchImpl }));
        } catch (err) {
          warnings.push(`${uni.name}: ${err.message}`);
        }
      }
    }
  }

  const reportPath = path.join(PATHS.reports, 'scholarships.md');
  await fs.mkdir(PATHS.reports, { recursive: true });
  await fs.writeFile(reportPath, renderReport({ external, internalResults, warnings, lastChecked: config.last_checked }), 'utf8');
  return { external, internal: internalResults, warnings, reportPath };
}

/** Open-and-eligible first, closed-or-ineligible last. */
function rank(m) {
  const e = { eligible: 0, check: 1, ineligible: 3 }[m.eligibility];
  const w = { open: 0, upcoming: 1, unannounced: 1, closed: 2 }[m.window.status];
  return e * 3 + w;
}

function renderReport({ external, internalResults, warnings, lastChecked }) {
  const icon = { pass: '✅', fail: '❌', check: '❔' };
  const win = (w) => (w.status === 'open' ? `🟢 open, closes ${w.closes}${w.daysLeft != null ? ` (${w.daysLeft} days)` : ''}` : w.status === 'closed' ? `🔴 closed for ${w.cycle}` : w.status === 'upcoming' ? `🟡 opens later (closes ${w.closes})` : `⚪ ${w.cycle ?? 'cycle'} dates not yet published`);
  return [
    '# Scholarship match',
    '',
    `External schemes checked against public sources on ${lastChecked}. Confirm on each official site.`,
    '',
    '## External schemes',
    '',
    ...external.flatMap((m) => [
      `### ${m.name} · ${m.eligibility.toUpperCase()}`,
      '',
      `${win(m.window)}${m.window.note ? `. ${m.window.note}` : ''}`,
      '',
      `Covers: ${m.covers} · [Official page](${m.url})`,
      '',
      ...m.rules.map((r) => `- ${icon[r.status]} **${r.rule}**: ${r.detail}`),
      '',
    ]),
    '## University awards (verified on official pages)',
    '',
    ...(internalResults.length ? internalResults.flatMap((u) => [
      `### ${u.university}`,
      '',
      ...(u.awards.length ? u.awards.map((a) => `- **[${a.name}](${a.url})**${a.amount ? `: ${a.amount}` : ''}${a.amount_note ? ` _(${a.amount_note})_` : ''}. ${a.eligibility}${a.deadline ? ` · Deadline: ${a.deadline}` : ''}`) : ['_No verified awards found._']),
      ...(u.dropped?.length ? ['', `_Not confirmed on the university's pages, so left out: ${u.dropped.join(', ')}_`] : []),
      '',
    ]) : ['_Not searched._', '']),
    ...(warnings.length ? ['## Notes', '', ...warnings.map((w) => `- ${w}`), ''] : []),
  ].join('\n');
}
