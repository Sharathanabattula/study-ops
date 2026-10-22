/**
 * @file Agent 12: Form Filler. Fills portal forms accurately, with the student in control.
 *
 * Privacy model, enforced in code and tested:
 *  - Field values come from `data/applicant.yaml` and are filled locally.
 *  - Claude sees only field descriptors (label, name, type, section, options)
 *    and the catalog of keys. No passport number, address or date of birth
 *    ever enters a prompt.
 *
 * Safety model:
 *  - Never submits, pays, or clicks anything. The student reviews and submits.
 *  - Never overwrites a field that already has a value (unless `overwrite`).
 *  - Never fills protected fields: declarations, criminal convictions,
 *    disability/health, equality monitoring, passwords, consent. These are
 *    highlighted for the student to answer personally.
 *  - Low-confidence mappings are highlighted, not filled.
 *
 * Pipeline per page
 *  1. Extract field descriptors from the DOM (labels resolved from <label>,
 *     aria-label, aria-labelledby, placeholder, nearby text; section from
 *     fieldset legend or nearest heading).
 *  2. Map descriptors to catalog keys: offline synonym matcher first, Claude
 *     for the rest (labels only), cached per form in data/forms/<host>.yaml.
 *  3. Fill values formatted for each field (UK dates by default, date parts,
 *     phone country codes, select/radio option matching).
 *  4. Outline filled fields in blue and fields needing the student in amber.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import * as z from 'zod';
import YAML from 'yaml';
import { PATHS } from '../lib/paths.js';
import { exists } from '../lib/files.js';
import { CATALOG, CATALOG_KEYS, MONTHS, formatFor, isProtected, loadApplicant, rawValue } from '../lib/applicant.js';
import { openAssisted } from '../lib/browser.js';
import { isConfigured, structured } from '../llm/claude.js';

/** Mappings below this confidence are highlighted for review instead of filled. */
export const MIN_CONFIDENCE = 0.7;

const PARTS = ['full', 'day', 'month', 'year', 'country_code', 'number'];

export const MappingSchema = z.object({
  mappings: z.array(z.object({
    field_id: z.string(),
    key: z.enum([...CATALOG_KEYS, 'none']),
    part: z.enum(PARTS),
    confidence: z.number().describe('0 to 1'),
  })),
});

/* ───────────────────────────── 1. Extraction ───────────────────────────── */

/**
 * Runs inside the page. Tags each field with data-studyops-id and returns
 * descriptors only: values are never read.
 */
/* c8 ignore start */
function extractInPage() {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.type !== 'hidden';
  };
  const labelFor = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ');
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return text(l);
    }
    const wrap = el.closest('label');
    if (wrap) return text(wrap);
    let prev = el.previousElementSibling;
    while (prev && !text(prev)) prev = prev.previousElementSibling;
    return text(prev) || el.placeholder || el.name || '';
  };
  const sectionFor = (el) => {
    const fs = el.closest('fieldset');
    if (fs?.querySelector('legend')) return text(fs.querySelector('legend'));
    // Headings only: another fieldset's legend must not leak into unrelated fields.
    const heads = [...document.querySelectorAll('h1,h2,h3,h4')];
    const before = heads.filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    return text(before.at(-1));
  };

  const out = [];
  const seenRadio = new Set();
  let n = 0;
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text').toLowerCase();
    if (['submit', 'button', 'reset', 'image', 'hidden'].includes(type) || !visible(el) || el.disabled) continue;
    if (type === 'radio') {
      if (!el.name || seenRadio.has(el.name)) continue;
      seenRadio.add(el.name);
      const group = [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)];
      const id = `f${n++}`;
      group.forEach((r) => r.setAttribute('data-studyops-id', id));
      const fsLegend = el.closest('fieldset')?.querySelector('legend');
      out.push({ id, type, name: el.name, label: fsLegend ? text(fsLegend) : el.name, section: sectionFor(el), options: group.map(labelFor), required: group.some((r) => r.required) });
      continue;
    }
    const id = `f${n++}`;
    el.setAttribute('data-studyops-id', id);
    out.push({
      id, type, name: el.name || el.id || '', label: labelFor(el), placeholder: el.placeholder || '', section: sectionFor(el), required: el.required,
      ...(type === 'select' ? { options: [...el.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 300) } : {}),
    });
  }
  return out;
}
/* c8 ignore stop */

/** @param {import('playwright').Page} page @returns {Promise<import('../lib/applicant.js').FieldDescriptor[]>} */
export async function extractFields(page) {
  return page.evaluate(extractInPage);
}

/* ───────────────────────────── 2. Mapping ───────────────────────────── */

const norm = (s) => String(s ?? '').toLowerCase().replace(/[*:()?]/g, ' ').replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const PART_LABEL = /^(day|month|year|dd|mm|yyyy|country code|dialling code|code|number)$/;
const DOMAINS = { education: /educat|qualificat|academic|degree|universit|school/, employment: /employ|work|job|career|professional/, referees: /refer|recommend/, emergency_contact: /emergency|next of kin/, passport: /passport|travel document/, english_test: /english|language test|ielts|pte|toefl/, address: /address|residen|domicile/ };

/**
 * Offline matcher: synonyms + section context. Returns a mapping or null.
 * @param {import('../lib/applicant.js').FieldDescriptor} f
 */
export function heuristicMatch(f) {
  // A bare "Day" / "Country code" label takes its meaning from the section ("Date of birth", "Mobile number").
  const ownLabel = norm(f.label);
  const partLabel = PART_LABEL.test(ownLabel) && f.section;
  const label = partLabel ? norm(f.section) : ownLabel;
  const hay = ` ${norm([partLabel ? f.section : '', f.label, String(f.name ?? '').replace(/[_-]+/g, ' '), f.placeholder].join(' '))} `;
  const section = norm(f.section);
  let best = null;
  for (const entry of CATALOG) {
    if (!entry.key.match(/\.0\.|^[^.]+\.[^.0-9]+$|^[^.]+$/)) continue; // repeated blocks: match index 0, re-indexed later
    const domain = entry.key.split('.')[0];
    for (const syn of entry.synonyms) {
      // Short synonyms ("to", "title", "city") only count as an exact label match, so
      // "Programme title" never picks up the personal title.
      let score = label === syn ? 3 : syn.length > 5 && hay.includes(` ${syn} `) ? 2 + syn.length / 100 : 0;
      if (!score) continue;
      const inDomain = DOMAINS[domain]?.test(section);
      if (inDomain) score += 1;
      else if (Object.entries(DOMAINS).some(([d, re]) => d !== domain && re.test(section))) score -= 1.5;
      // Confidence: exact label match, or how much of the label the synonym covers.
      const coverage = label === syn ? 1 : syn.length / Math.max(syn.length, label.length);
      const confidence = Math.min(0.98, 0.55 + 0.4 * coverage + (inDomain ? 0.05 : 0));
      if (!best || score > best.score) best = { key: entry.key, score, confidence };
    }
  }
  if (!best || best.score < 2) return null;

  let part = 'full';
  const kind = CATALOG.find((c) => c.key === best.key)?.kind;
  if (kind === 'date') {
    if (/\bday\b|\bdd\b/.test(hay) && !/dd ?\/ ?mm/.test(hay)) part = 'day';
    else if (/\bmonth\b|\bmm\b/.test(hay) && !/mm ?\/ ?(dd|yy)/.test(hay)) part = 'month';
    else if (/\byear\b|\byyyy\b/.test(hay) && !/\/ ?yyyy/.test(hay)) part = 'year';
  }
  if (kind === 'phone' && /country code|dialling code|dial code|calling code/.test(hay)) part = 'country_code';
  else if (kind === 'phone' && ownLabel === 'number') part = 'number';
  return { field_id: f.id, key: best.key, part, confidence: best.confidence, source: 'heuristic' };
}

/**
 * Re-index repeated blocks in document order: a second "Institution" field
 * becomes education.1.institution, and so on.
 * @param {Array<{ field_id: string, key: string, part: string }>} mappings
 */
export function reindexRepeats(mappings) {
  const seen = new Map();
  return mappings.map((m) => {
    const match = m.key.match(/^(education|employment|referees)\.(\d)\.(.+)$/);
    if (!match) return m;
    const [, block, , leaf] = match;
    const slot = `${block}|${leaf}|${m.part}`;
    const n = seen.get(slot) ?? 0;
    seen.set(slot, n + 1);
    return { ...m, key: `${block}.${n}.${leaf}` };
  });
}

/** Signature for caching a form's mapping. */
export function formSignature(fields) {
  const s = fields.map((f) => `${f.type}:${norm(f.label)}:${f.name}`).join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * Map fields to catalog keys. Protected fields are never mapped.
 * @param {import('../lib/applicant.js').FieldDescriptor[]} fields
 * @param {{ host?: string, useLlm?: boolean }} [opts]
 * @returns {Promise<{ mappings: Array<{ field_id: string, key: string, part: string, confidence: number, source: string }>, protectedIds: string[] }>}
 */
export async function mapFields(fields, { host = 'local', useLlm = isConfigured() } = {}) {
  const protectedIds = fields.filter(isProtected).map((f) => f.id);
  const candidates = fields.filter((f) => !protectedIds.includes(f.id));

  const cacheFile = path.join(PATHS.formMappings, `${host}.yaml`);
  const sig = formSignature(candidates);
  const cache = (await exists(cacheFile)) ? YAML.parse(await fs.readFile(cacheFile, 'utf8')) ?? {} : {};
  if (cache[sig]) return { mappings: cache[sig], protectedIds };

  const heuristic = candidates.map(heuristicMatch).filter(Boolean);
  const unmatched = candidates.filter((f) => !heuristic.some((m) => m.field_id === f.id));
  let llm = [];
  if (useLlm && unmatched.length) {
    // Descriptors only. These objects never contain applicant values.
    const descriptors = unmatched.map(({ id, label, name, placeholder, section, type, options }) => ({ id, label, name, placeholder, section, type, ...(options ? { options: options.slice(0, 15) } : {}) }));
    const res = await structured({
      system: ['You map web-form fields to a fixed catalog of applicant-data keys for Study-Ops. You never see or produce applicant data. Use "none" when no key fits. For split dates use part day/month/year; for split phone numbers use country_code/number; otherwise part "full". For repeated blocks (education, employment, referees) use index 0 for the first block, 1 for the second, and so on.'],
      schema: MappingSchema,
      effort: 'low',
      prompt: `Catalog:\n${CATALOG.map((c) => `- ${c.key}: ${c.label}`).join('\n')}\n\nFields:\n${JSON.stringify(descriptors, null, 1)}`,
    });
    llm = res.mappings.filter((m) => m.key !== 'none' && unmatched.some((f) => f.id === m.field_id)).map((m) => ({ ...m, source: 'claude' }));
  }

  const order = new Map(fields.map((f, i) => [f.id, i]));
  const heuristicReindexed = reindexRepeats(heuristic);
  const mappings = [...heuristicReindexed, ...llm].sort((a, b) => order.get(a.field_id) - order.get(b.field_id));

  cache[sig] = mappings;
  await fs.mkdir(PATHS.formMappings, { recursive: true });
  await fs.writeFile(cacheFile, YAML.stringify(cache), 'utf8');
  return { mappings, protectedIds };
}

/* ───────────────────────────── 3. Filling ───────────────────────────── */

const COUNTRY_ALIASES = { india: ['india', 'in', 'ind', 'indian', 'republic of india'], 'united kingdom': ['united kingdom', 'uk', 'gb', 'gbr', 'great britain', 'british'] };

/**
 * Pick the option that best matches a value.
 * @param {string[]} options
 * @param {string|boolean} value
 */
export function chooseOption(options, value) {
  const v = norm(value);
  const aliases = [v, ...(COUNTRY_ALIASES[v] ?? []), ...(/^\d{1,2}$/.test(v) ? [norm(MONTHS[Number(v) - 1] ?? ''), String(Number(v))] : [])];
  const monthIdx = MONTHS.findIndex((m) => norm(m) === v);
  if (monthIdx >= 0) aliases.push(norm(MONTHS[monthIdx].slice(0, 3)), String(monthIdx + 1), String(monthIdx + 1).padStart(2, '0'));
  const normed = options.map(norm);
  for (const a of aliases.filter(Boolean)) {
    const i = normed.findIndex((o) => o === a);
    if (i >= 0) return options[i];
  }
  for (const a of aliases.filter((x) => x && x.length > 2)) {
    const i = normed.findIndex((o) => o.startsWith(a) || o.includes(` ${a}`));
    if (i >= 0) return options[i];
  }
  return null;
}

/**
 * @typedef {object} FillReport
 * @property {Array<{ id: string, label: string, key: string }>} filled
 * @property {Array<{ id: string, label: string }>} protectedFields
 * @property {Array<{ id: string, label: string, reason: string }>} review
 * @property {Array<{ id: string, label: string }>} unmapped
 */

/**
 * Fill the current page. Never submits.
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {Record<string, any>} [opts.applicant]
 * @param {boolean} [opts.overwrite]
 * @param {boolean} [opts.useLlm]
 * @returns {Promise<FillReport>}
 */
export async function fillCurrentPage(page, { applicant, overwrite = false, useLlm } = {}) {
  applicant ??= await loadApplicant();
  const fields = await extractFields(page);
  const host = (() => { try { return new URL(page.url()).hostname || 'local'; } catch { return 'local'; } })();
  const { mappings, protectedIds } = await mapFields(fields, { host, useLlm });
  const byId = new Map(fields.map((f) => [f.id, f]));
  /** @type {FillReport} */
  const report = { filled: [], protectedFields: [], review: [], unmapped: [] };

  for (const id of protectedIds) report.protectedFields.push({ id, label: byId.get(id).label });
  const mappedIds = new Set(mappings.map((m) => m.field_id));
  for (const f of fields) if (!protectedIds.includes(f.id) && !mappedIds.has(f.id)) report.unmapped.push({ id: f.id, label: f.label });

  for (const m of mappings) {
    const f = byId.get(m.field_id);
    if (!f) continue;
    const entry = CATALOG.find((c) => c.key === m.key);
    if (m.confidence < MIN_CONFIDENCE) { report.review.push({ id: f.id, label: f.label, reason: `unsure (maps to ${m.key})` }); continue; }
    const value = formatFor(rawValue(applicant, m.key), entry, f, m.part === 'full' ? null : m.part);
    if (value === null) { report.review.push({ id: f.id, label: f.label, reason: `no value for ${m.key} in applicant.yaml` }); continue; }

    const sel = `[data-studyops-id="${f.id}"]`;
    try {
      if (f.type === 'select') {
        const opt = chooseOption(f.options ?? [], value);
        if (!opt) { report.review.push({ id: f.id, label: f.label, reason: 'no matching option' }); continue; }
        const current = await page.$eval(sel, (el) => el.selectedIndex);
        if (current > 0 && !overwrite) { report.review.push({ id: f.id, label: f.label, reason: 'already selected; left as is' }); continue; }
        await page.selectOption(sel, { label: opt });
      } else if (f.type === 'radio') {
        const opt = chooseOption(f.options ?? [], value);
        if (!opt) { report.review.push({ id: f.id, label: f.label, reason: 'no matching choice' }); continue; }
        const index = f.options.indexOf(opt);
        await page.locator(sel).nth(index).check();
      } else if (f.type === 'checkbox') {
        await page.locator(sel).setChecked(Boolean(value));
      } else {
        const current = await page.$eval(sel, (el) => el.value);
        if (current && !overwrite) { report.review.push({ id: f.id, label: f.label, reason: 'already has a value; left as is' }); continue; }
        await page.fill(sel, String(value));
      }
      report.filled.push({ id: f.id, label: f.label, key: m.key });
    } catch (err) {
      report.review.push({ id: f.id, label: f.label, reason: `could not fill (${err.message.split('\n')[0]})` });
    }
  }

  // 4. Highlight: blue = filled by Study-Ops, amber = needs the student.
  await page.evaluate(({ filled, attention }) => {
    for (const id of filled) document.querySelectorAll(`[data-studyops-id="${id}"]`).forEach((el) => { el.style.outline = '2px solid #8AB4FF'; });
    for (const id of attention) document.querySelectorAll(`[data-studyops-id="${id}"]`).forEach((el) => { el.style.outline = '2px solid #FFC861'; });
  }, { filled: report.filled.map((x) => x.id), attention: [...report.protectedFields, ...report.review].map((x) => x.id) });

  return report;
}

/**
 * Interactive session: open the portal, let the student navigate, fill each
 * page on Enter. Never submits.
 * @param {string} url
 * @param {{ overwrite?: boolean, onReport?: (r: FillReport) => void, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [opts]
 */
export async function assistedFillSession(url, { overwrite = false, onReport = () => {}, input = process.stdin, output = process.stdout } = {}) {
  const applicant = await loadApplicant();
  const { context, page } = await openAssisted(url);
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const answer = (await rl.question('\n  Sign in and open a form page in the browser, then press Enter to fill it (q to quit): ')).trim().toLowerCase();
      if (answer === 'q') break;
      onReport(await fillCurrentPage(page, { applicant, overwrite }));
    }
  } finally {
    rl.close();
    await context.close();
  }
}

/**
 * Copy-paste sheet for portals that block automation: every value, formatted
 * the UK way, grouped like a typical application. Saved locally (git-ignored).
 * @param {{ name?: string }} [opts]
 */
export async function formPack({ name = 'applicant' } = {}) {
  const a = await loadApplicant();
  const groups = {};
  for (const entry of CATALOG) {
    const v = rawValue(a, entry.key);
    if (v === null || v === undefined || entry.key === 'personal.full_name') continue;
    const value = formatFor(v, entry, { type: 'text', label: '' });
    const group = entry.key.split('.').slice(0, entry.key.match(/\.\d\./) ? 2 : 1).join(' ');
    (groups[group] ??= []).push(`| ${entry.label.replace(/ \(#\d\)$/, '')} | ${String(value).replace(/\|/g, '\\|')} |`);
  }
  const md = [
    `# Application form pack · ${name}`,
    '',
    '> 🔒 Contains passport and personal data. Keep it on this machine and delete it when you finish.',
    '> Dates are DD/MM/YYYY (UK). Copy each value exactly.',
    '',
    ...Object.entries(groups).flatMap(([g, rows]) => [`## ${g.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`, '', '| Field | Value |', '|---|---|', ...rows, '']),
    '## Answer these yourself',
    '',
    'Declarations, criminal convictions, disability/health and equality-monitoring questions are never pre-filled. Answer them personally and truthfully.',
    '',
  ].join('\n');
  await fs.mkdir(PATHS.formsOutput, { recursive: true });
  const out = path.join(PATHS.formsOutput, `${name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.md`);
  await fs.writeFile(out, md, 'utf8');
  return out;
}
