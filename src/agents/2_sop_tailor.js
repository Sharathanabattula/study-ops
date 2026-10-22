/**
 * @file Agent 2: SOP / Personal Statement Tailor (the generator).
 *
 * Takes the master personal statement (`data/personal_statement.md`) plus the
 * student profile, and rewrites it for one UK university and programme:
 * LSE's argument-driven register is not Imperial's evidence-first one.
 *
 * Intended pipeline:
 *  1. Resolve the university from the Russell Group registry to get its
 *     tone heuristic and location.
 *  2. Optionally ingest the programme page to extract the official prompt(s),
 *     word or character limit and named modules or faculty to reference.
 *  3. Build a constrained prompt ({@link buildTailorPrompt}) that:
 *       - only uses facts present in the profile or master statement (no
 *         invented achievements, grades or employers);
 *       - matches the target tone and answers the official prompts in order;
 *       - respects the word limit with a ±5% tolerance.
 *  4. Generate, then self-critique against a rubric (specificity, evidence,
 *     "why this programme", "why the UK", clichés) and revise once.
 *  5. Write `output/sop/<uni>.md` and record the version in tracker.yaml.
 *
 * Until an LLM provider is wired in, the agent still runs steps 1 and 3 and
 * saves the prompt to `output/sop/<uni>.prompt.md`. Paste it into any model
 * you trust; nothing is sent anywhere automatically.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../lib/paths.js';
import { exists } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { findUniversity } from '../lib/universities.js';

/** Applied when a university has no tone entry in the registry. */
export const DEFAULT_TONE =
  'Clear, specific and evidence-led. Show why this programme, why now and why the UK, grounded in concrete experience.';

/**
 * @typedef {object} TailorResult
 * @property {'scaffold'|'complete'} status
 * @property {string} university   Resolved display name.
 * @property {string} tone
 * @property {string} prompt       Fully assembled generation prompt.
 * @property {string} promptPath   Where the prompt was saved.
 * @property {string|null} draft   Tailored statement (null until LLM wiring).
 */

/**
 * Assemble the generation prompt. Pure function, easy to snapshot-test.
 *
 * @param {object} input
 * @param {string} input.universityName
 * @param {string} input.tone
 * @param {string} input.master        Master personal statement Markdown.
 * @param {string} input.profileRaw    Full student_profile.md.
 * @param {string} [input.programme]
 * @param {number} [input.wordLimit]
 * @returns {string}
 */
export function buildTailorPrompt({ universityName, tone, master, profileRaw, programme, wordLimit }) {
  return [
    `# Task`,
    `Rewrite the master personal statement for **${universityName}**${programme ? `, programme: **${programme}**` : ''}.`,
    '',
    `## Target tone`,
    tone,
    '',
    `## Hard constraints`,
    `- Use ONLY facts in the profile or master statement. Never invent grades, employers, awards or numbers.`,
    `- ${wordLimit ? `Stay within ${wordLimit} words (±5%).` : 'Default to around 800 words unless the programme states otherwise.'}`,
    `- British English spelling.`,
    `- Make "why this programme" specific: name modules, research groups or faculty only if they appear in the inputs.`,
    `- No clichés ("since childhood", "passion for", "in today's fast-paced world").`,
    '',
    `## Student profile`,
    '```markdown',
    profileRaw.trim(),
    '```',
    '',
    `## Master personal statement`,
    '```markdown',
    master.trim(),
    '```',
    '',
    `## Output`,
    `Return only the final statement in Markdown, then a short "Changes made" list.`,
  ].join('\n');
}

/**
 * Tailor the master statement for one university.
 *
 * @param {object} input
 * @param {string} input.university        Name or key, e.g. "LSE", "imperial".
 * @param {string} [input.programme]
 * @param {number} [input.wordLimit]
 * @param {string} [input.masterPath]      Defaults to data/personal_statement.md.
 * @param {string} [input.profilePath]
 * @returns {Promise<TailorResult>}
 */
export async function tailorPersonalStatement({ university, programme, wordLimit, masterPath = PATHS.personalStatement, profilePath }) {
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
  const prompt = buildTailorPrompt({ universityName, tone, master, profileRaw: profile.raw, programme, wordLimit });

  const slug = (uni?.key ?? university).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await fs.mkdir(PATHS.sopOutput, { recursive: true });
  const promptPath = path.join(PATHS.sopOutput, `${slug}.prompt.md`);
  await fs.writeFile(promptPath, prompt, 'utf8');

  // TODO(phase-1.1): generate → critique → revise via configured LLM provider.
  return { status: 'scaffold', university: universityName, tone, prompt, promptPath, draft: null };
}
