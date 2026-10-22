/**
 * @file Agent 2: SOP / Personal Statement Tailor (the generator).
 *
 * Takes the master personal statement (`data/personal_statement.md`) plus the
 * student profile, and rewrites it for one UK university and programme:
 * LSE's argument-driven register is not Imperial's evidence-first one.
 *
 * Pipeline
 *  1. Resolve the university from the Russell Group registry to get its
 *     tone heuristic.
 *  2. Optionally fetch the programme page (`--url`) so the draft can cite
 *     real modules, and follow the page's own statement prompts and limits.
 *  3. Generate: a draft constrained to facts in the profile and master
 *     statement, in the target tone, within the word limit.
 *  4. Critique: Claude grades the draft against a fixed rubric and flags any
 *     claim it can't trace to the inputs.
 *  5. Revise once using the critique. Word count is checked locally.
 *  6. Write `output/sop/<uni>.md`, with the critique appended as review notes.
 *
 * Without a configured provider, the agent stops after building the prompt
 * and saves it to `output/sop/<uni>.prompt.md` so it can be used with any model.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { PATHS } from '../lib/paths.js';
import { exists } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { findUniversity } from '../lib/universities.js';
import { fetchPageText } from '../lib/web.js';
import { generate, isConfigured, structured } from '../llm/claude.js';

/** Applied when a university has no tone entry in the registry. */
export const DEFAULT_TONE =
  'Clear, specific and evidence-led. Show why this programme, why now and why the UK, grounded in concrete experience.';

/** Rubric the critique pass scores against (1–5 each). */
export const RUBRIC = Object.freeze({
  specificity: 'Concrete details and numbers rather than generic claims',
  programme_fit: 'Why this programme specifically, tied to real modules or strengths',
  evidence: 'Each claim about ability is backed by an example from the inputs',
  tone_match: 'Matches the target tone',
  why_uk_and_goals: 'Clear reasons for the UK and a credible career plan',
  voice: "Sounds like a person, with no clichés or filler",
});

export const CritiqueSchema = z.object({
  scores: z.object(Object.fromEntries(Object.keys(RUBRIC).map((k) => [k, z.number().describe('1 to 5')]))),
  unsupported_claims: z.array(z.string()).describe('Quotes from the draft that are not supported by the profile or master statement'),
  cliches: z.array(z.string()),
  fixes: z.array(z.string()).describe('Specific, ordered edits that would most improve the draft'),
});

/**
 * @typedef {object} TailorResult
 * @property {'scaffold'|'complete'} status
 * @property {string} university   Resolved display name.
 * @property {string} tone
 * @property {string} prompt       Fully assembled generation prompt.
 * @property {string} promptPath   Where the prompt was saved.
 * @property {string|null} draft   Final tailored statement.
 * @property {string|null} outputPath
 * @property {number|null} wordCount
 * @property {z.infer<typeof CritiqueSchema> | null} critique  Critique of the first draft.
 * @property {string[]} warnings
 */

const SYSTEM = `You are the SOP Tailor in Study-Ops. You adapt one student's master personal statement for a specific UK university programme.

Non-negotiable:
- Use only facts from the student profile, the master statement and the programme page. Never invent grades, employers, awards, numbers, modules or faculty names.
- British English spelling.
- Write in the student's voice, in the first person. No clichés ("since childhood", "passion for", "in today's fast-paced world"), no flattery of the university.`;

/**
 * Assemble the task prompt. Pure function, easy to snapshot-test.
 *
 * @param {object} input
 * @param {string} input.universityName
 * @param {string} input.tone
 * @param {string} [input.programme]
 * @param {number} [input.wordLimit]
 * @param {string} [input.pageText]    Programme page text, if fetched.
 * @returns {string}
 */
export function buildTaskPrompt({ universityName, tone, programme, wordLimit, pageText }) {
  return [
    `Rewrite the master personal statement for ${universityName}${programme ? `, programme: ${programme}` : ''}.`,
    '',
    `Target tone: ${tone}`,
    wordLimit ? `Length: at most ${wordLimit} words.` : 'Length: around 800 words unless the programme page states a limit.',
    pageText
      ? 'If the programme page sets its own statement questions or limits, answer those questions in order and follow those limits. Reference modules or research groups only if they appear on the page.'
      : 'Do not name specific modules or faculty; no programme page was provided.',
    '',
    pageText ? `<programme_page>\n${pageText}\n</programme_page>` : '',
    '',
    'Return only the statement in Markdown, with no preamble or commentary.',
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

/**
 * Standalone prompt for offline use (no provider): system rules, inputs and
 * task in one Markdown file you can paste into any model.
 */
export function buildTailorPrompt({ universityName, tone, master, profileRaw, programme, wordLimit, pageText }) {
  return [
    '# Instructions',
    SYSTEM,
    '',
    '## Student profile',
    '```markdown',
    profileRaw.trim(),
    '```',
    '',
    '## Master personal statement',
    '```markdown',
    master.trim(),
    '```',
    '',
    '# Task',
    buildTaskPrompt({ universityName, tone, programme, wordLimit, pageText }),
  ].join('\n');
}

/** @param {string} text */
export function countWords(text) {
  return text.replace(/[#>*_`-]/g, ' ').split(/\s+/).filter(Boolean).length;
}

/**
 * Tailor the master statement for one university.
 *
 * @param {object} input
 * @param {string} input.university        Name or key, e.g. "LSE", "imperial".
 * @param {string} [input.programme]
 * @param {number} [input.wordLimit]
 * @param {string} [input.url]             Programme page to ground the draft.
 * @param {string} [input.masterPath]      Defaults to data/personal_statement.md.
 * @param {string} [input.profilePath]
 * @param {(stage: string) => void} [input.onProgress]
 * @param {typeof fetch} [input.fetchImpl]
 * @returns {Promise<TailorResult>}
 */
export async function tailorPersonalStatement({
  university, programme, wordLimit, url, masterPath = PATHS.personalStatement, profilePath, onProgress = () => {}, fetchImpl,
}) {
  if (!(await exists(masterPath))) {
    throw new Error(`No master statement at ${masterPath}. Run \`study-ops init\` and write your long-form statement first.`);
  }
  const [master, profile, uni] = await Promise.all([
    fs.readFile(masterPath, 'utf8'),
    loadProfile(profilePath),
    findUniversity(university),
  ]);

  const universityName = uni?.name ?? university;
  const tone = uni?.tone ?? DEFAULT_TONE;
  const slug = (uni?.key ?? university).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  /** @type {string[]} */
  const warnings = [];

  let pageText;
  if (url) {
    onProgress('Fetching programme page');
    const page = await fetchPageText(url, { fetchImpl });
    pageText = page.text;
    if (page.truncated) warnings.push('Programme page was very long; only the first 200,000 characters were used.');
  }

  await fs.mkdir(PATHS.sopOutput, { recursive: true });
  const prompt = buildTailorPrompt({ universityName, tone, master, profileRaw: profile.raw, programme, wordLimit, pageText });
  const promptPath = path.join(PATHS.sopOutput, `${slug}.prompt.md`);
  await fs.writeFile(promptPath, prompt, 'utf8');

  const base = { university: universityName, tone, prompt, promptPath, warnings };
  if (!isConfigured()) {
    return { ...base, status: 'scaffold', draft: null, outputPath: null, wordCount: null, critique: null };
  }

  // Stable context first: cached across the three calls below.
  const system = [
    SYSTEM,
    `<student_profile>\n${profile.raw}\n</student_profile>\n\n<master_statement>\n${master}\n</master_statement>`,
  ];
  const task = buildTaskPrompt({ universityName, tone, programme, wordLimit, pageText });

  onProgress('Drafting');
  const firstDraft = await generate({ system, prompt: task, effort: 'high' });

  onProgress('Critiquing draft');
  const critique = await structured({
    system,
    schema: CritiqueSchema,
    effort: 'medium',
    prompt: [
      'Critique this draft against the rubric below. Score each criterion from 1 to 5 and list unsupported claims, clichés and the highest-impact fixes.',
      ...Object.entries(RUBRIC).map(([k, v]) => `- ${k}: ${v}`),
      `Target tone: ${tone}`,
      wordLimit ? `Word limit: ${wordLimit} (draft has ${countWords(firstDraft)}).` : '',
      `<draft>\n${firstDraft}\n</draft>`,
    ].filter(Boolean).join('\n'),
  });

  onProgress('Revising');
  const draft = await generate({
    system,
    effort: 'high',
    prompt: [
      task,
      '',
      'Here is your first draft and a reviewer critique. Produce the improved final version: remove every unsupported claim and cliché, apply the fixes, keep what already works.',
      `<draft>\n${firstDraft}\n</draft>`,
      `<critique>\n${JSON.stringify(critique, null, 2)}\n</critique>`,
    ].join('\n'),
  });

  const wordCount = countWords(draft);
  if (wordLimit && wordCount > wordLimit) warnings.push(`Final draft is ${wordCount} words, over the ${wordLimit}-word limit. Trim before submitting.`);

  const outputPath = path.join(PATHS.sopOutput, `${slug}.md`);
  await fs.writeFile(outputPath, renderOutput({ draft, universityName, programme, wordCount, critique }), 'utf8');

  return { ...base, status: 'complete', draft, outputPath, wordCount, critique };
}

/** Markdown saved to output/sop/: the statement, then review notes. */
function renderOutput({ draft, universityName, programme, wordCount, critique }) {
  return [
    `<!-- study-ops · ${universityName}${programme ? ` · ${programme}` : ''} · ${new Date().toISOString().slice(0, 10)} · ${wordCount} words -->`,
    '',
    draft,
    '',
    '---',
    '',
    '## Review notes (first draft, before revision)',
    '',
    '| Criterion | Score |',
    '|---|---|',
    ...Object.entries(critique.scores).map(([k, v]) => `| ${k} | ${v}/5 |`),
    '',
    critique.unsupported_claims.length ? `**Unsupported claims removed:**\n${critique.unsupported_claims.map((c) => `- ${c}`).join('\n')}\n` : '',
    critique.fixes.length ? `**Fixes applied:**\n${critique.fixes.map((c) => `- ${c}`).join('\n')}` : '',
    '',
    '> Check every sentence before submitting. You are the final editor.',
    '',
  ].join('\n');
}
