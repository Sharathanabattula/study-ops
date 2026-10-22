/**
 * @file University specifics: modules, faculty and labs for SOP tailoring.
 *
 * Naming a professor who doesn't exist, or a module that isn't taught, is the
 * fastest way to sink a statement. Everything here is verified the same way:
 * a name is kept only if it literally appears on an official page we
 * fetched ourselves.
 *
 * Sources, in order:
 *  1. The programme page (modules), from the shared catalog.
 *  2. Research/faculty pages the student passes in (`--research-urls`).
 *  3. Optional discovery (`--find-faculty`): Claude web-searches the
 *     university's own domains for people and labs matching the student's
 *     interests. Every hit is then fetched locally and checked.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import YAML from 'yaml';
import { PATHS } from './paths.js';
import { exists } from './files.js';
import { fetchPageText } from './web.js';
import { mentions } from './factcheck.js';
import { structured, structuredWithSearch } from '../llm/claude.js';

const MAX_AGE_DAYS = 30;

const ModulesSchema = z.object({
  modules: z.array(z.object({
    name: z.string().describe('Exact module name as written on the page'),
    type: z.enum(['core', 'optional', 'unknown']),
    summary: z.string().nullable(),
  })),
});

const PeopleLabsSchema = z.object({
  people: z.array(z.object({
    name: z.string().describe('Full name exactly as on the page'),
    role: z.string().nullable(),
    research_focus: z.string().describe('What they work on, from the page'),
    url: z.string().describe('Official page that names this person'),
  })),
  labs: z.array(z.object({
    name: z.string(),
    focus: z.string(),
    url: z.string().describe('Official page that names this lab or centre'),
  })),
});

/**
 * @typedef {object} Specifics
 * @property {Array<{ name: string, type: string, summary: string|null, source: string }>} modules
 * @property {Array<{ name: string, role: string|null, research_focus: string, source: string }>} people
 * @property {Array<{ name: string, focus: string, source: string }>} labs
 * @property {string[]} dropped      Names that failed verification.
 * @property {string[]} sources
 */

/** All verified names, for the reference check. @param {Specifics} s */
export function verifiedNames(s) {
  return [...s.modules.map((m) => m.name), ...s.people.map((p) => p.name), ...s.labs.map((l) => l.name)];
}

/**
 * @param {object} input
 * @param {import('./programme.js').ProgrammeRecord} input.programme
 * @param {import('./universities.js').University | undefined} input.university
 * @param {string[]} [input.interests]
 * @param {string[]} [input.researchUrls]
 * @param {boolean} [input.findFaculty]
 * @param {boolean} [input.refresh]
 * @param {(stage: string) => void} [input.onProgress]
 * @param {typeof fetch} [input.fetchImpl]
 * @returns {Promise<Specifics>}
 */
export async function gatherSpecifics({ programme, university, interests = [], researchUrls = [], findFaculty = false, refresh = false, onProgress = () => {}, fetchImpl }) {
  const key = JSON.stringify([programme.url, [...interests].sort(), [...researchUrls].sort(), findFaculty]);
  const file = path.join(PATHS.data, 'programmes', `specifics-${hash(key)}.yaml`);
  if (!refresh && (await exists(file))) {
    const cached = YAML.parse(await fs.readFile(file, 'utf8'));
    if ((Date.now() - Date.parse(cached.at)) / 86_400_000 <= MAX_AGE_DAYS) return cached.specifics;
  }

  /** @type {Specifics} */
  const out = { modules: [], people: [], labs: [], dropped: [], sources: [programme.url] };
  const interestLine = interests.length ? `The student's interests: ${interests.join('; ')}.` : '';

  // 1. Modules from the programme page
  onProgress('Listing modules');
  const { modules } = await structured({
    system: ['You list modules from UK programme pages. Copy names exactly; include only modules on the page.'],
    schema: ModulesSchema,
    effort: 'low',
    prompt: `List the modules on this programme page.\n\n<page url="${programme.url}">\n${programme.pageText}\n</page>`,
  });
  for (const m of modules) {
    if (mentions(programme.pageText, m.name)) out.modules.push({ ...m, source: programme.url });
    else out.dropped.push(m.name);
  }

  // 2. Student-supplied research pages
  for (const url of researchUrls) {
    onProgress(`Reading ${new URL(url).hostname}${new URL(url).pathname.slice(0, 40)}`);
    const page = await fetchPageText(url, { fetchImpl });
    const found = await structured({
      system: ['You extract academic staff and research groups from UK university pages. Only include names on the page.'],
      schema: PeopleLabsSchema,
      effort: 'low',
      prompt: `${interestLine}\nList the people and labs/centres on this page most relevant to those interests (max 8 people, 5 labs). Use this page's URL for each.\n\n<page url="${url}">\n${page.text}\n</page>`,
    });
    addVerified(out, found, () => page.text, url);
    out.sources.push(url);
  }

  // 3. Discovery on the university's own domains, then local verification
  if (findFaculty && university) {
    onProgress(`Searching ${university.name} for relevant faculty and labs`);
    const found = await structuredWithSearch({
      system: ['You find academic staff and research groups on UK university websites for Study-Ops. Only return people and labs you saw on official pages during this search, with those pages’ URLs.'],
      schema: PeopleLabsSchema,
      allowedDomains: university.domains,
      maxSearches: 5,
      prompt: `${interestLine}\nFind up to 6 faculty members and 4 research labs or centres at ${university.name} connected to the programme "${programme.requirements.programme_title ?? ''}" and these interests. Prefer people who teach on the programme or lead relevant research.`,
    });
    const pages = new Map();
    const textFor = async (url) => {
      if (!pages.has(url)) pages.set(url, await fetchPageText(url, { fetchImpl }).then((p) => p.text).catch(() => ''));
      return pages.get(url);
    };
    for (const p of found.people) await textFor(p.url);
    for (const l of found.labs) await textFor(l.url);
    addVerified(out, found, (url) => pages.get(url) ?? '', null);
    out.sources.push(...[...pages.keys()].filter((u) => pages.get(u)));
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, YAML.stringify({ at: new Date().toISOString(), specifics: out }), 'utf8');
  return out;
}

/**
 * Keep only people/labs whose names appear on the page they were attributed to.
 * @param {Specifics} out
 * @param {z.infer<typeof PeopleLabsSchema>} found
 * @param {(url: string) => string} textFor
 * @param {string|null} fixedUrl
 */
function addVerified(out, found, textFor, fixedUrl) {
  for (const p of found.people) {
    const url = fixedUrl ?? p.url;
    if (mentions(textFor(url), p.name) && !out.people.some((x) => x.name === p.name)) {
      out.people.push({ name: p.name, role: p.role, research_focus: p.research_focus, source: url });
    } else if (!out.people.some((x) => x.name === p.name)) out.dropped.push(p.name);
  }
  for (const l of found.labs) {
    const url = fixedUrl ?? l.url;
    if (mentions(textFor(url), l.name) && !out.labs.some((x) => x.name === l.name)) out.labs.push({ name: l.name, focus: l.focus, source: url });
    else if (!out.labs.some((x) => x.name === l.name)) out.dropped.push(l.name);
  }
}

/** Short, stable hash for cache file names. @param {string} s */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
