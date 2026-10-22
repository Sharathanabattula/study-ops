/**
 * @file Agent 9: LOR Drafter.
 *
 * Prepares 2–3 recommendation letters that each show a different side of the
 * student (research, leadership, technical depth…) so they read as three
 * people, not one template.
 *
 * A reference is the recommender's own testimony. Study-Ops therefore
 * produces a **briefing plus a starting draft for the recommender**, built
 * only from what that person actually observed (`evidence` in
 * `data/recommenders.yaml`) and facts in the profile. The recommender should
 * rewrite it in their own words, confirm every statement and submit it
 * themselves. Many UK universities collect references directly from referees,
 * and some ask that applicants not draft them, so check each programme's rules.
 *
 * Pipeline
 *  1. Plan (one call across all recommenders): a distinct primary angle per
 *     letter, evidence allocated so no anecdote appears twice, and a
 *     different structure and opening for each.
 *  2. Draft each letter in its recommender's register (academic vs
 *     professional), following UK reference conventions: capacity and length
 *     of acquaintance, specific evidence, a comparative assessment (only if
 *     the recommender supplied one) and suitability for postgraduate study.
 *  3. Code checks: 4-gram overlap between every pair of letters, plus numbers
 *     that appear in no source. Letters that overlap too much or invent
 *     figures are revised once.
 *  4. Write `outputs/lor/<id>.md` (briefing + draft).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import YAML from 'yaml';
import { PATHS } from '../lib/paths.js';
import { exists } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { countWords, ngramOverlap, unsupportedNumbers } from '../lib/factcheck.js';
import { generate, isConfigured, structured } from '../llm/claude.js';

/** Pairwise 4-gram Jaccard above this is treated as "sounds the same". */
export const MAX_OVERLAP = 0.06;

export const FOCI = Object.freeze(['research', 'leadership', 'technical', 'teamwork', 'initiative', 'communication', 'resilience']);

export const LorPlanSchema = z.object({
  letters: z.array(z.object({
    recommender_id: z.string(),
    primary_angle: z.enum(FOCI),
    secondary_angle: z.enum(FOCI).nullable(),
    evidence: z.array(z.string()).describe("Items from THIS recommender's evidence list, plus profile facts they could know"),
    structure: z.string().describe('Paragraph plan, different from the other letters'),
    opening: z.string().describe('How this letter opens, unlike the others'),
  })),
});

const SYSTEM = `You prepare draft recommendation letters in Study-Ops for recommenders to review, rewrite and submit themselves.

Rules:
- Write as the recommender, in the first person, about what they personally observed. Use only that recommender's evidence and profile facts they would plausibly know.
- Never invent anecdotes, rankings, numbers or comparisons. Include a comparative statement only if the recommender supplied one.
- UK reference conventions: how and how long they have known the student, specific evidence, an honest assessment, suitability for postgraduate study. Academic referees comment on intellectual ability; professional referees on work performance and growth.
- Each letter must sound like a different person: different structure, opening and vocabulary.
- British English. No clichés ("I have no hesitation", "one of a kind", "a pleasure to recommend") unless the recommender used them.`;

/**
 * @typedef {object} Recommender
 * @property {string} id
 * @property {string} name
 * @property {string} title
 * @property {string} organisation
 * @property {'academic'|'professional'} type
 * @property {string} relationship
 * @property {string} [known_since]
 * @property {string} focus
 * @property {string[]} evidence
 * @property {string} [comparative_statement]
 * @property {number} [word_limit]
 */

/** @returns {Promise<Recommender[]>} */
export async function loadRecommenders() {
  if (!(await exists(PATHS.recommenders))) throw new Error('No data/recommenders.yaml. Run `study-ops init` and describe 2–3 recommenders.');
  const list = (YAML.parse(await fs.readFile(PATHS.recommenders, 'utf8'))?.recommenders ?? [])
    .filter((r) => r?.id && r?.name);
  if (!list.length) throw new Error('data/recommenders.yaml has no recommenders with an id and name.');
  for (const r of list) {
    r.evidence = (r.evidence ?? []).filter(Boolean);
    if (!r.evidence.length) throw new Error(`Recommender "${r.id}" has no evidence. Add things they actually observed; the letter is built only from these.`);
  }
  return list;
}

/** @param {Recommender} r */
function describe(r) {
  return [
    `<recommender id="${r.id}">`,
    `Name: ${r.name}; ${r.title}, ${r.organisation} (${r.type})`,
    `Relationship: ${r.relationship}${r.known_since ? ` since ${r.known_since}` : ''}`,
    `Preferred focus: ${r.focus}`,
    `Evidence they observed:\n${r.evidence.map((e) => `- ${e}`).join('\n')}`,
    r.comparative_statement ? `Comparative statement they agreed to: ${r.comparative_statement}` : 'No comparative statement supplied.',
    `Word limit: ${r.word_limit ?? 500}`,
    '</recommender>',
  ].join('\n');
}

/**
 * @param {object} [input]
 * @param {string[]} [input.only]           Recommender ids to (re)draft.
 * @param {string} [input.programme]        e.g. "MSc Finance", to make suitability specific.
 * @param {(stage: string) => void} [input.onProgress]
 */
export async function draftLors({ only, programme, onProgress = () => {} } = {}) {
  if (!isConfigured()) throw new Error('LOR drafting uses Claude. Add ANTHROPIC_API_KEY to .env first.');
  const [profile, all] = await Promise.all([loadProfile(), loadRecommenders()]);
  const warnings = [];
  if (all.length < 2) warnings.push('Most programmes ask for two references. Add a second recommender.');
  if (!all.some((r) => r.type === 'academic')) warnings.push('No academic recommender. Most UK master’s programmes expect at least one.');

  const system = [SYSTEM, `<student_profile>\n${profile.raw}\n</student_profile>\n\n${all.map(describe).join('\n\n')}`];

  onProgress('Planning distinct angles');
  const plan = await structured({
    system,
    schema: LorPlanSchema,
    effort: 'high',
    prompt: `Plan one letter per recommender (${all.map((r) => r.id).join(', ')}). Give each a different primary angle, respecting their preferred focus where possible. Allocate evidence so no anecdote appears in two letters. Give each a different structure and opening.${programme ? ` The student is applying for ${programme}.` : ''}`,
  });

  const targets = all.filter((r) => !only?.length || only.includes(r.id));
  const letters = [];
  for (const r of targets) {
    const p = plan.letters.find((l) => l.recommender_id === r.id);
    if (!p) { warnings.push(`No plan returned for ${r.id}; skipped.`); continue; }
    onProgress(`Drafting letter from ${r.name}`);
    const prompt = letterPrompt(r, p, programme);
    letters.push({ recommender: r, plan: p, prompt, draft: await generate({ system, prompt, effort: 'high' }) });
  }

  // Code checks: overlap between letters, unsupported numbers.
  const factSources = (r) => [profile.raw, ...r.evidence, r.comparative_statement ?? '', r.known_since ?? '', r.relationship];
  for (let i = 0; i < letters.length; i++) {
    const L = letters[i];
    const overlaps = letters.filter((_, j) => j !== i).map((o) => ({ with: o.recommender.id, score: ngramOverlap(L.draft, o.draft) }));
    const tooClose = overlaps.filter((o) => o.score > MAX_OVERLAP);
    const badNumbers = unsupportedNumbers(L.draft, factSources(L.recommender));
    const words = countWords(L.draft);
    const limit = L.recommender.word_limit ?? 500;
    // Only later letters are rewritten for overlap, so the first one keeps its voice.
    const overlapFixes = i > 0 ? tooClose : [];
    const changes = [
      ...overlapFixes.map((o) => `This letter repeats phrasing from ${o.with}'s letter (overlap ${o.score}). Rephrase so it sounds like a different person.`),
      ...badNumbers.map((n) => `"${n}" is not in this recommender's evidence or the profile. Remove it.`),
      words > limit * 1.1 ? `Cut to ${limit} words (currently ${words}).` : '',
    ].filter(Boolean);
    if (changes.length) {
      onProgress(`Revising letter from ${L.recommender.name}`);
      L.draft = await generate({
        system,
        effort: 'medium',
        prompt: `${L.prompt}\n\nRevise this draft with the required changes.\n\n<draft>\n${L.draft}\n</draft>\n\n<required_changes>\n${changes.map((c) => `- ${c}`).join('\n')}\n</required_changes>`,
      });
    }
    L.overlaps = letters.filter((_, j) => j !== i).map((o) => ({ with: o.recommender.id, score: ngramOverlap(L.draft, o.draft) }));
    L.strayNumbers = unsupportedNumbers(L.draft, factSources(L.recommender));
    L.wordCount = countWords(L.draft);
  }

  await fs.mkdir(PATHS.lorOutput, { recursive: true });
  for (const L of letters) {
    L.outputPath = path.join(PATHS.lorOutput, `${L.recommender.id}.md`);
    await fs.writeFile(L.outputPath, renderLetter(L), 'utf8');
    if (L.strayNumbers.length) warnings.push(`${L.recommender.id}: numbers not in their evidence: ${L.strayNumbers.join(', ')}`);
    const close = L.overlaps.filter((o) => o.score > MAX_OVERLAP);
    if (close.length) warnings.push(`${L.recommender.id}: still similar to ${close.map((o) => o.with).join(', ')}. Ask the recommenders to personalise further.`);
  }
  return { plan, letters, warnings };
}

/** @param {Recommender} r @param {z.infer<typeof LorPlanSchema>['letters'][number]} p @param {string} [programme] */
function letterPrompt(r, p, programme) {
  return [
    `Draft the recommendation letter from ${r.name} (${r.id}).`,
    `Primary angle: ${p.primary_angle}${p.secondary_angle ? `; secondary: ${p.secondary_angle}` : ''}.`,
    `Use only this evidence:\n${p.evidence.map((e) => `- ${e}`).join('\n')}`,
    `Structure: ${p.structure}`,
    `Opening: ${p.opening}`,
    programme ? `Close with suitability for ${programme}.` : 'Close with suitability for postgraduate study in the UK.',
    `At most ${r.word_limit ?? 500} words. Return only the letter body in Markdown (no address block), signed with the recommender's name and title.`,
  ].join('\n');
}

function renderLetter(L) {
  const r = L.recommender;
  return [
    `# Draft reference: ${r.name}`,
    '',
    `> **For ${r.name}:** this is a starting draft built from the examples you shared. Please rewrite it in your own words, correct anything that isn't exactly right, add your own observations, and submit it yourself through the university's referee process.`,
    '',
    '## Briefing',
    '',
    `- **Angle:** ${L.plan.primary_angle}${L.plan.secondary_angle ? ` (with ${L.plan.secondary_angle})` : ''}`,
    `- **Evidence used:**`,
    ...L.plan.evidence.map((e) => `  - ${e}`),
    `- **Length:** ${L.wordCount} words`,
    `- **Distinctness:** ${L.overlaps.map((o) => `${o.with} ${o.score}`).join(' · ') || 'only letter'} (4-gram overlap; lower is more distinct)`,
    '',
    '## Draft',
    '',
    L.draft,
    '',
  ].join('\n');
}
