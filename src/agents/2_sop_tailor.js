/**
 * @file Agent 2: University-Specific SOP Tailor.
 *
 * Copies the master statement and rewrites about 30% of it for one
 * university: the "why this programme" and "goals" passages, with real
 * modules, faculty and labs. Everything else stays recognisably the
 * student's master statement.
 *
 * Pipeline
 *  1. Resolve the university (tone heuristic, domains).
 *  2. Specifics (`--url`): modules from the programme page, people and labs
 *     from `--research-urls` and/or `--find-faculty` web search. Only names
 *     confirmed on an official page are kept (src/lib/specifics.js).
 *  3. Draft: keep ~70% of the master, rewrite the rest around 2–4 verified
 *     specifics that genuinely connect to the student's background.
 *  4. Critique: rubric scores, plus every named person, lab and module the
 *     draft mentions.
 *  5. Code checks: references not on the verified list, numbers not in the
 *     profile or master statement.
 *  6. Revise once with all of the above. The change ratio against the master
 *     is measured in code, not estimated.
 *  7. Write `output/sop/<uni>.md` with review notes; record it in the tracker.
 *
 * Without a provider, the agent saves the assembled prompt to
 * `output/sop/<uni>.prompt.md` for use with any model.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { HOME, PATHS } from '../lib/paths.js';
import { exists } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { findUniversity } from '../lib/universities.js';
import { getProgramme, programmeId } from '../lib/programme.js';
import { gatherSpecifics, verifiedNames } from '../lib/specifics.js';
import { changeRatio, checkReferences, countWords, unsupportedNumbers } from '../lib/factcheck.js';
import { upsertApplication } from '../lib/tracker.js';
import { generate, isConfigured, structured } from '../llm/claude.js';

export { countWords };

/** Applied when a university has no tone entry in the registry. */
export const DEFAULT_TONE =
  'Clear, specific and evidence-led. Show why this programme, why now and why the UK, grounded in concrete experience.';

/** Target share of the master to rewrite, and the band that counts as on target. */
export const TARGET_CHANGE = Object.freeze({ goal: 0.3, min: 0.2, max: 0.45 });

/** Rubric the critique pass scores against (1–5 each). */
export const RUBRIC = Object.freeze({
  specificity: 'Concrete details and numbers rather than generic claims',
  programme_fit: 'Why this programme specifically, tied to real modules, faculty or labs',
  evidence: 'Each claim about ability is backed by an example from the inputs',
  tone_match: 'Matches the target tone',
  why_uk_and_goals: 'Clear reasons for the UK and a credible career plan',
  voice: 'Sounds like a person, with no clichés or filler',
});

export const CritiqueSchema = z.object({
  scores: z.object(Object.fromEntries(Object.keys(RUBRIC).map((k) => [k, z.number().describe('1 to 5')]))),
  references: z.array(z.object({ name: z.string(), kind: z.enum(['person', 'lab', 'module', 'other']) }))
    .describe('Every named professor, lab, centre or module the draft mentions'),
  unsupported_claims: z.array(z.string()).describe('Quotes from the draft not supported by the profile, master statement or specifics'),
  cliches: z.array(z.string()),
  fixes: z.array(z.string()).describe('Specific, ordered edits that would most improve the draft'),
});

const SYSTEM = `You are the SOP Tailor in Study-Ops. You adapt one student's master statement for a specific UK university programme.

Non-negotiable:
- Use only facts from the student profile, the master statement and the verified university specifics. Never invent grades, employers, awards, numbers, modules, people or labs.
- Mention a professor or lab only if it is in <verified_specifics>, and only to say why their work connects to the student's interests. Never claim the student has contacted, met or been accepted by anyone.
- British English spelling. First person. No clichés ("since childhood", "passion for", "in today's fast-paced world"), no flattery of the university.`;

/**
 * @typedef {object} TailorResult
 * @property {'scaffold'|'complete'} status
 * @property {string} university
 * @property {string} tone
 * @property {string} prompt
 * @property {string} promptPath
 * @property {string|null} draft
 * @property {string|null} outputPath
 * @property {number|null} wordCount
 * @property {number|null} changeRatio       Share of the final text that is new vs the master.
 * @property {import('../lib/specifics.js').Specifics | null} specifics
 * @property {z.infer<typeof CritiqueSchema> | null} critique
 * @property {string[]} warnings
 */

/** @param {import('../lib/specifics.js').Specifics | null} s */
function specificsBlock(s) {
  if (!s || (!s.modules.length && !s.people.length && !s.labs.length)) return '';
  return [
    '<verified_specifics>',
    ...s.modules.map((m) => `- Module (${m.type}): ${m.name}${m.summary ? ` (${m.summary})` : ''}`),
    ...s.people.map((p) => `- Person: ${p.name}${p.role ? `, ${p.role}` : ''}. Research: ${p.research_focus}`),
    ...s.labs.map((l) => `- Lab/centre: ${l.name}. Focus: ${l.focus}`),
    '</verified_specifics>',
  ].join('\n');
}

/**
 * Assemble the task prompt. Pure function.
 * @param {object} input
 * @param {string} input.universityName
 * @param {string} input.tone
 * @param {string} [input.programme]
 * @param {number} [input.wordLimit]
 * @param {import('../lib/specifics.js').Specifics | null} [input.specifics]
 * @param {string} [input.pageText]
 */
export function buildTaskPrompt({ universityName, tone, programme, wordLimit, specifics, pageText }) {
  const spec = specificsBlock(specifics ?? null);
  return [
    `Tailor the master statement for ${universityName}${programme ? `, programme: ${programme}` : ''}.`,
    '',
    `Rewrite about ${Math.round(TARGET_CHANGE.goal * 100)}% of it and keep the rest close to the original wording. Concentrate the rewrite on "why this programme and university" and "future goals". Keep the student's story, examples and voice.`,
    `Target tone: ${tone}`,
    wordLimit ? `Length: at most ${wordLimit} words.` : 'Length: about the same as the master unless the programme page states a limit.',
    spec
      ? 'Weave in 2–4 of the verified specifics where they genuinely connect to the student’s background. Fewer, well-argued links beat a list of names.'
      : 'No verified modules, faculty or labs are available, so do not name any.',
    pageText ? 'If the programme page sets its own statement questions or limits, answer those questions in order and follow those limits.' : '',
    '',
    spec,
    pageText ? `<programme_page>\n${pageText}\n</programme_page>` : '',
    '',
    'Return only the statement in Markdown, with no preamble or commentary.',
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

/** Standalone prompt for offline use (no provider). */
export function buildTailorPrompt({ universityName, tone, master, profileRaw, programme, wordLimit, specifics, pageText }) {
  return [
    '# Instructions', SYSTEM, '',
    '## Student profile', '```markdown', profileRaw.trim(), '```', '',
    '## Master statement', '```markdown', master.trim(), '```', '',
    '# Task', buildTaskPrompt({ universityName, tone, programme, wordLimit, specifics, pageText }),
  ].join('\n');
}

/**
 * "Professor Jane Smith" / "Dr J. Smith" mentions in a text, for a final
 * code-level check that no unverified person slipped into the revision.
 * @param {string} text
 */
export function namedPeople(text) {
  return [...text.matchAll(/\b(?:Professor|Prof\.?|Dr\.?)\s+((?:[A-Z][\p{L}'’-]+\.?\s?){1,3})/gu)].map((m) => m[1].trim().replace(/[.,;:]+$/, ''));
}

/**
 * Tailor the master statement for one university.
 *
 * @param {object} input
 * @param {string} input.university        Name or key, e.g. "LSE", "imperial".
 * @param {string} [input.programme]
 * @param {number} [input.wordLimit]
 * @param {string} [input.url]             Programme page: enables module specifics.
 * @param {string[]} [input.researchUrls]  Faculty or lab pages to draw people/labs from.
 * @param {boolean} [input.findFaculty]    Search the university's site for relevant faculty and labs.
 * @param {string} [input.masterPath]
 * @param {string} [input.profilePath]
 * @param {boolean} [input.refresh]
 * @param {(stage: string) => void} [input.onProgress]
 * @param {typeof fetch} [input.fetchImpl]
 * @returns {Promise<TailorResult>}
 */
export async function tailorPersonalStatement({
  university, programme, wordLimit, url, researchUrls = [], findFaculty = false,
  masterPath = PATHS.personalStatement, profilePath, refresh = false, onProgress = () => {}, fetchImpl,
}) {
  if (!(await exists(masterPath))) {
    throw new Error(`No master statement at ${masterPath}. Run \`study-ops master-sop\` or write your own first.`);
  }
  const [master, profile, uni] = await Promise.all([fs.readFile(masterPath, 'utf8'), loadProfile(profilePath), findUniversity(university)]);
  const universityName = uni?.name ?? university;
  const tone = uni?.tone ?? DEFAULT_TONE;
  const slug = (uni?.key ?? university).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  /** @type {string[]} */
  const warnings = [];
  await fs.mkdir(PATHS.sopOutput, { recursive: true });
  const promptPath = path.join(PATHS.sopOutput, `${slug}.prompt.md`);

  if (!isConfigured()) {
    const prompt = buildTailorPrompt({ universityName, tone, master, profileRaw: profile.raw, programme, wordLimit });
    await fs.writeFile(promptPath, prompt, 'utf8');
    return { status: 'scaffold', university: universityName, tone, prompt, promptPath, draft: null, outputPath: null, wordCount: null, changeRatio: null, specifics: null, critique: null, warnings };
  }

  let prog = null;
  let specifics = null;
  if (url) {
    onProgress('Reading programme page');
    prog = await getProgramme({ url, nationality: profile.facts.identity?.nationality, refresh, fetchImpl });
    specifics = await gatherSpecifics({
      programme: prog, university: uni, interests: profile.facts.target?.research_interests ?? profile.facts.target?.subjects ?? [],
      researchUrls, findFaculty, refresh, onProgress, fetchImpl,
    });
    if (specifics.dropped.length) warnings.push(`Dropped ${specifics.dropped.length} name(s) that could not be confirmed on an official page: ${specifics.dropped.slice(0, 5).join(', ')}${specifics.dropped.length > 5 ? '…' : ''}`);
    if (!specifics.people.length && !specifics.labs.length) warnings.push('No verified faculty or labs. Pass --research-urls or --find-faculty to name them.');
  } else {
    warnings.push('No --url given: tailoring by tone only, without real modules, faculty or labs.');
  }

  const programmeTitle = programme ?? prog?.requirements.programme_title ?? undefined;
  const task = buildTaskPrompt({ universityName, tone, programme: programmeTitle, wordLimit, specifics, pageText: prog?.pageText });
  await fs.writeFile(promptPath, buildTailorPrompt({ universityName, tone, master, profileRaw: profile.raw, programme: programmeTitle, wordLimit, specifics, pageText: prog?.pageText }), 'utf8');

  // Stable context first: cached across the three calls below.
  const system = [SYSTEM, `<student_profile>\n${profile.raw}\n</student_profile>\n\n<master_statement>\n${master}\n</master_statement>`];
  const factSources = [profile.raw, master, prog?.pageText ?? ''];
  const allowed = specifics ? verifiedNames(specifics) : [];

  onProgress('Drafting');
  const firstDraft = await generate({ system, prompt: task, effort: 'high' });

  onProgress('Critiquing draft');
  const critique = await structured({
    system,
    schema: CritiqueSchema,
    effort: 'medium',
    prompt: [
      'Critique this tailored draft against the rubric. Score each criterion 1–5. List every named person, lab, centre and module it mentions, any unsupported claims, clichés, and the highest-impact fixes.',
      ...Object.entries(RUBRIC).map(([k, v]) => `- ${k}: ${v}`),
      `Target tone: ${tone}`,
      wordLimit ? `Word limit: ${wordLimit} (draft has ${countWords(firstDraft)}).` : '',
      specificsBlock(specifics),
      `<draft>\n${firstDraft}\n</draft>`,
    ].filter(Boolean).join('\n'),
  });

  const refs = checkReferences(critique.references.filter((r) => r.kind !== 'other').map((r) => r.name), allowed);
  const badNumbers = unsupportedNumbers(firstDraft, factSources);
  const firstRatio = changeRatio(master, firstDraft);
  const issues = [
    ...critique.fixes,
    ...refs.unverified.map((n) => `Remove "${n}": it is not in the verified specifics.`),
    ...badNumbers.map((n) => `The number "${n}" does not appear in the profile or master statement. Remove it or use the real figure.`),
    ...critique.unsupported_claims.map((c) => `Unsupported claim: "${c}". Remove or rephrase with real evidence.`),
    firstRatio < TARGET_CHANGE.min ? `Only ${Math.round(firstRatio * 100)}% differs from the master; rewrite more of the programme-fit and goals sections.` : '',
    firstRatio > TARGET_CHANGE.max ? `${Math.round(firstRatio * 100)}% differs from the master; keep more of the original wording outside the programme-fit and goals sections.` : '',
  ].filter(Boolean);

  onProgress('Revising');
  const draft = await generate({
    system,
    effort: 'high',
    prompt: [
      task, '',
      'Here is your first draft and a list of required changes. Produce the final version: apply every change, keep what already works.',
      `<draft>\n${firstDraft}\n</draft>`,
      `<required_changes>\n${issues.map((i) => `- ${i}`).join('\n')}\n</required_changes>`,
    ].join('\n'),
  });

  // Final code-level checks on what will actually be saved.
  const ratio = changeRatio(master, draft);
  const wordCount = countWords(draft);
  const strayPeople = namedPeople(draft).filter((n) => !checkReferences([n], allowed).ok.length);
  const strayNumbers = unsupportedNumbers(draft, factSources);
  if (strayPeople.length) warnings.push(`Unverified people still named: ${strayPeople.join(', ')}. Check or remove before submitting.`);
  if (strayNumbers.length) warnings.push(`Numbers not found in your profile or master: ${strayNumbers.join(', ')}. Confirm they're real.`);
  if (ratio < TARGET_CHANGE.min || ratio > TARGET_CHANGE.max) warnings.push(`${Math.round(ratio * 100)}% of the final text differs from the master (target ≈ ${Math.round(TARGET_CHANGE.goal * 100)}%).`);
  if (wordLimit && wordCount > wordLimit) warnings.push(`Final draft is ${wordCount} words, over the ${wordLimit}-word limit.`);

  const outputPath = path.join(PATHS.sopOutput, `${slug}.md`);
  await fs.writeFile(outputPath, renderOutput({ draft, universityName, programme: programmeTitle, wordCount, ratio, critique, specifics, issues }), 'utf8');
  if (prog) {
    await upsertApplication({ id: programmeId(prog.universityKey, prog.requirements.programme_title, prog.url), documents: { sop_version: path.relative(HOME, outputPath) } });
  }

  return { status: 'complete', university: universityName, tone, prompt: task, promptPath, draft, outputPath, wordCount, changeRatio: ratio, specifics, critique, warnings };
}

function renderOutput({ draft, universityName, programme, wordCount, ratio, critique, specifics, issues }) {
  const cited = specifics ? verifiedNames(specifics).filter((n) => draft.toLowerCase().includes(n.toLowerCase())) : [];
  const sourceOf = (name) => [...(specifics?.people ?? []), ...(specifics?.labs ?? []), ...(specifics?.modules ?? [])].find((x) => x.name === name)?.source;
  return [
    `<!-- study-ops · ${universityName}${programme ? ` · ${programme}` : ''} · ${new Date().toISOString().slice(0, 10)} · ${wordCount} words · ${Math.round(ratio * 100)}% tailored -->`,
    '', draft, '', '---', '',
    '## Review notes',
    '',
    `**${Math.round(ratio * 100)}%** of this text differs from your master statement.`,
    '',
    ...(cited.length ? ['**University specifics used (verify each before submitting):**', ...cited.map((n) => `- ${n}: ${sourceOf(n) ?? ''}`), ''] : []),
    '| Criterion (first draft) | Score |', '|---|---|',
    ...Object.entries(critique.scores).map(([k, v]) => `| ${k} | ${v}/5 |`),
    '',
    issues.length ? `**Changes applied in revision:**\n${issues.map((c) => `- ${c}`).join('\n')}` : '',
    '',
    '> You are the final editor. Read every sentence, and check that each named person still works there.',
    '',
  ].join('\n');
}
