/**
 * @file Agent 7: Course Syllabus Matcher.
 *
 * Compares the student's undergraduate modules with what a UK master's
 * expects them to know already. UK admissions tutors check this closely,
 * especially for conversion-heavy subjects like finance, data science and
 * economics.
 *
 * Pipeline
 *  1. Read the programme page from the shared catalog, plus an optional extra
 *     page (e.g. a separate "entry requirements" or module catalogue URL).
 *  2. Claude lists the prerequisites: stated outright, or clearly implied by
 *     the core modules. Each one carries a quote from the page.
 *  3. Claude maps each prerequisite to the student's modules: met, partial,
 *     missing or unclear. Only module names the student supplied may be cited;
 *     anything else is dropped and reported.
 *  4. Bridging plan for the gaps, plus points worth making in the statement.
 *  5. Write `reports/syllabus-<id>.md` and record the fit in the tracker.
 *
 * Modules come from `academics.modules` in the profile, or from a free-text
 * transcript file (`--modules-file`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { PATHS } from '../lib/paths.js';
import { loadProfile } from '../lib/profile.js';
import { getProgramme, programmeId } from '../lib/programme.js';
import { fetchPageText } from '../lib/web.js';
import { upsertApplication } from '../lib/tracker.js';
import { isConfigured, structured } from '../llm/claude.js';

export const SyllabusSchema = z.object({
  prerequisites: z.array(z.object({
    id: z.string().describe('Short slug, e.g. "linear-algebra"'),
    requirement: z.string(),
    importance: z.enum(['required', 'recommended', 'implied']),
    source_quote: z.string().describe('Exact words from the page this is based on'),
  })),
  matches: z.array(z.object({
    prerequisite_id: z.string(),
    status: z.enum(['met', 'partial', 'missing', 'unclear']),
    matched_modules: z.array(z.string()).describe("Exact module names from the student's list"),
    explanation: z.string(),
  })),
  overall: z.enum(['strong', 'adequate', 'weak', 'insufficient_information']),
  summary: z.string().describe('Two or three sentences'),
  bridging: z.array(z.object({ gap: z.string(), action: z.string().describe('Concrete step before the course starts') })),
  statement_points: z.array(z.string()).describe('Module-backed points worth making in the personal statement'),
});

const SYSTEM = `You are the Syllabus Matcher in Study-Ops. You compare a student's undergraduate modules with the prior knowledge a UK master's programme expects.

Rules:
- Prerequisites must come from the programme pages. Mark "implied" ones only when the core curriculum clearly assumes them, and quote the words you relied on.
- Match only against the student's listed modules, citing their exact names. A module title alone is weak evidence; use "partial" or "unclear" rather than guessing.
- Bridging actions should be specific and achievable before the course starts.`;

/**
 * Format modules for the prompt.
 * @param {Array<Record<string, any>>} modules
 */
export function formatModules(modules) {
  return modules
    .filter((m) => m?.name)
    .map((m) => `- ${m.name}${m.grade ? ` (grade: ${m.grade})` : ''}${m.credits ? `, ${m.credits} credits` : ''}${m.description ? `: ${m.description}` : ''}`)
    .join('\n');
}

/**
 * @param {object} input
 * @param {string} input.url
 * @param {string} [input.extraUrl]       Separate entry-requirements or module page.
 * @param {string} [input.modulesFile]    Free-text transcript, used instead of profile modules.
 * @param {boolean} [input.refresh]
 * @param {(stage: string) => void} [input.onProgress]
 * @param {typeof fetch} [input.fetchImpl]
 */
export async function matchSyllabus({ url, extraUrl, modulesFile, refresh = false, onProgress = () => {}, fetchImpl }) {
  if (!isConfigured()) throw new Error('Syllabus matching reads programme pages with Claude. Sign in to Claude Code with your Claude subscription, or add ANTHROPIC_API_KEY to .env.');
  const profile = await loadProfile();

  const profileModules = profile.facts.academics?.modules ?? [];
  const moduleText = modulesFile ? (await fs.readFile(modulesFile, 'utf8')).trim() : formatModules(profileModules);
  if (!moduleText) {
    throw new Error('No undergraduate modules found. Add them under academics.modules in data/student_profile.md, or pass --modules-file <transcript.txt>.');
  }
  const knownNames = modulesFile ? null : new Set(profileModules.map((m) => m.name?.toLowerCase()).filter(Boolean));

  onProgress('Reading programme page');
  const prog = await getProgramme({ url, nationality: profile.facts.identity?.nationality, refresh, fetchImpl });
  let extraText = '';
  if (extraUrl) {
    onProgress('Reading extra page');
    extraText = (await fetchPageText(extraUrl, { fetchImpl })).text;
  }

  onProgress('Matching modules to prerequisites');
  const result = await structured({
    system: [SYSTEM],
    schema: SyllabusSchema,
    effort: 'high',
    prompt: [
      `Programme: ${prog.requirements.programme_title ?? 'unknown'} at ${prog.universityName}.`,
      `Student's degree: ${profile.facts.academics?.degree || 'unknown'}.`,
      `<student_modules>\n${moduleText}\n</student_modules>`,
      `<programme_page url="${prog.url}">\n${prog.pageText}\n</programme_page>`,
      extraText ? `<extra_page url="${extraUrl}">\n${extraText}\n</extra_page>` : '',
    ].filter(Boolean).join('\n\n'),
  });

  // Drop any module citation the student didn't supply.
  const dropped = [];
  if (knownNames) {
    for (const m of result.matches) {
      const kept = m.matched_modules.filter((name) => knownNames.has(name.toLowerCase()));
      dropped.push(...m.matched_modules.filter((name) => !knownNames.has(name.toLowerCase())));
      m.matched_modules = kept;
      if (!kept.length && (m.status === 'met' || m.status === 'partial')) m.status = 'unclear';
    }
  }

  const id = programmeId(prog.universityKey, prog.requirements.programme_title, prog.url);
  const reportPath = path.join(PATHS.reports, `syllabus-${id}.md`);
  await fs.mkdir(PATHS.reports, { recursive: true });
  await fs.writeFile(reportPath, renderSyllabus({ prog, result, dropped }), 'utf8');

  const gaps = result.matches.filter((m) => m.status === 'missing').length;
  const tracker = await upsertApplication({ id, url: prog.url, syllabus: { fit: result.overall, gaps } });

  return { ...result, programme: prog, reportPath, droppedModules: dropped, gaps, tracker };
}

function renderSyllabus({ prog, result, dropped }) {
  const icon = { met: '✅', partial: '🟡', missing: '❌', unclear: '❔' };
  const byId = new Map(result.prerequisites.map((p) => [p.id, p]));
  return [
    `# Syllabus match: ${prog.requirements.programme_title ?? 'Programme'} · ${prog.universityName}`,
    '',
    `**Overall: ${result.overall.replace('_', ' ')}**`,
    '',
    `> ${result.summary}`,
    '',
    `Source: ${prog.url}`,
    '',
    '| Prerequisite | Type | Status | Your modules | Why |',
    '|---|---|---|---|---|',
    ...result.matches.map((m) => {
      const p = byId.get(m.prerequisite_id);
      return `| ${p?.requirement ?? m.prerequisite_id} | ${p?.importance ?? ''} | ${icon[m.status]} ${m.status} | ${m.matched_modules.join(', ') || '–'} | ${m.explanation.replace(/\|/g, '\\|')} |`;
    }),
    '',
    '## Where each prerequisite comes from',
    '',
    ...result.prerequisites.map((p) => `- **${p.requirement}**: "${p.source_quote}"`),
    '',
    '## Bridging plan',
    '',
    ...(result.bridging.length ? result.bridging.map((b) => `- [ ] **${b.gap}**: ${b.action}`) : ['_No gaps to bridge._']),
    '',
    '## Use in your statement',
    '',
    ...result.statement_points.map((s) => `- ${s}`),
    '',
    dropped.length ? `> Removed module names not in your profile: ${[...new Set(dropped)].join(', ')}\n` : '',
  ].join('\n');
}
