/**
 * @file Agent 8: Master SOP Architect.
 *
 * Builds the central narrative every tailored statement is cut from: past
 * academics → the turning point → current motivation → future goals, argued
 * with academic rigour rather than enthusiasm.
 *
 * Pipeline
 *  0. Rules: the Elite SOP Constraints (data/templates/elite_sop_framework.md)
 *     lead the system prompt; raw material comes from data/master_sop_raw.md.
 *  1. Plan: Claude reads the profile, raw material and any existing master, and proposes
 *     a central thesis and a beat-by-beat arc. Every beat cites evidence from
 *     the profile. Where evidence is missing it asks questions instead of
 *     filling the gap.
 *  2. Interview: if there are open questions without answers, they are
 *     written to `data/sop_interview.md` and the run stops. The student
 *     answers there and re-runs. `--skip-interview` drafts anyway.
 *  3. Draft → critique (rubric incl. academic rigour) → code checks (numbers
 *     not in any source) → revise.
 *  4. Save to `outputs/sops/master.md`. `--adopt` makes it the master in
 *     `data/personal_statement.md`, backing up the old one first.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { PATHS } from '../lib/paths.js';
import { exists } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { countWords, unsupportedNumbers } from '../lib/factcheck.js';
import { eliteViolations, loadFramework, rawIsFilled } from '../lib/sop_framework.js';
import { generate, isConfigured, structured } from '../llm/claude.js';

export const MASTER_RUBRIC = Object.freeze({
  central_thesis: 'One clear intellectual question or problem runs through the whole essay',
  academic_rigour: 'Engages with ideas, methods or debates in the field, not just enthusiasm for it',
  coherence: 'Past academics → motivation → goals connect causally, not just chronologically',
  evidence: 'Every claim about ability is backed by a specific example from the profile',
  goals: 'Short- and long-term goals are concrete and follow from the story',
  voice: 'Sounds like the student, with no clichés or filler',
});

export const PlanSchema = z.object({
  central_thesis: z.string().describe('The one question or problem the student is driven by, in one sentence'),
  arc: z.array(z.object({
    section: z.enum(['hook', 'academic_foundation', 'turning_point', 'professional_proof', 'why_this_field_now', 'why_uk', 'goals', 'close']),
    beat: z.string().describe('What this part argues'),
    evidence: z.array(z.string()).describe('Facts from the profile that support it, quoted or closely paraphrased'),
  })),
  open_questions: z.array(z.object({
    question: z.string(),
    why: z.string().describe('Which beat it strengthens'),
    critical: z.boolean().describe('True if the essay would be generic without the answer'),
  })),
});

const MasterCritiqueSchema = z.object({
  scores: z.object(Object.fromEntries(Object.keys(MASTER_RUBRIC).map((k) => [k, z.number().describe('1 to 5')]))),
  unsupported_claims: z.array(z.string()),
  cliches: z.array(z.string()),
  fixes: z.array(z.string()),
});

const SYSTEM = `You are the Master SOP Architect in Study-Ops. You help one student write the central statement of purpose that every university-specific version is adapted from.

Principles:
- Academic rigour over enthusiasm: show the student thinking about a real problem in the field, with the methods and ideas they have actually used.
- Causal arc: past academics lead to a turning point, which explains the current motivation, which makes the goals credible.
- Use only facts from the profile, the existing statement and the student's interview answers. When something important is missing, ask; never invent experiences, numbers, grades or outcomes.
- British English. First person. No clichés ("since childhood", "passion for", "in today's fast-paced world").`;

/**
 * Parse `data/sop_interview.md` into question/answer pairs.
 * @param {string} md
 * @returns {Array<{ question: string, answer: string }>}
 */
export function parseInterview(md) {
  return md.split(/^## /m).slice(1).map((block) => {
    const [heading, ...rest] = block.split('\n');
    const answer = rest
      .filter((l) => !/^_.*_$/.test(l.trim()) && !/^<!--.*-->$/.test(l.trim()))
      .join('\n')
      .trim();
    return { question: heading.replace(/^\d+\.\s*/, '').trim(), answer };
  });
}

/** @param {Array<{ question: string, why: string, critical: boolean, answer?: string }>} questions */
export function renderInterview(questions) {
  return [
    '# SOP interview',
    '',
    'Answer under each question in your own words: specific moments, numbers you can verify, what you actually did.',
    'Leave a question blank if it does not apply. Then run `study-ops master-sop` again.',
    '',
    ...questions.flatMap((q, i) => [`## ${i + 1}. ${q.question}`, `_${q.critical ? 'Important. ' : ''}${q.why}_`, '', q.answer || '<!-- your answer -->', '']),
  ].join('\n');
}

/**
 * @param {object} [input]
 * @param {number} [input.words=1100]
 * @param {boolean} [input.adopt]          Replace data/personal_statement.md (backed up first).
 * @param {boolean} [input.skipInterview]  Draft even if questions are unanswered.
 * @param {(stage: string) => void} [input.onProgress]
 */
export async function buildMasterSop({ words = 1100, adopt = false, skipInterview = false, onProgress = () => {} } = {}) {
  if (!isConfigured()) throw new Error('The master SOP is written with Claude. Add ANTHROPIC_API_KEY to .env first.');
  const profile = await loadProfile();
  const existing = (await exists(PATHS.personalStatement)) ? (await fs.readFile(PATHS.personalStatement, 'utf8')).trim() : '';
  const hasExisting = existing.replace(/^#.*$|^>.*$/gm, '').trim().length > 200; // ignore the empty template
  const interview = (await exists(PATHS.sopInterview)) ? parseInterview(await fs.readFile(PATHS.sopInterview, 'utf8')) : [];
  const answered = interview.filter((q) => q.answer);
  const framework = await loadFramework();
  const rawText = (await exists(PATHS.masterRaw)) ? await fs.readFile(PATHS.masterRaw, 'utf8') : '';
  const raw = rawIsFilled(rawText) ? rawText : '';

  const context = [
    `<student_profile>\n${profile.raw}\n</student_profile>`,
    raw ? `<raw_material>\n${raw}\n</raw_material>` : '',
    hasExisting ? `<existing_statement>\n${existing}\n</existing_statement>` : '',
    answered.length ? `<interview_answers>\n${answered.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join('\n\n')}\n</interview_answers>` : '',
  ].filter(Boolean).join('\n\n');
  // The Elite framework leads the system prompt; Rule 3 (named university details) is the tailors' job.
  const system = [framework.text, SYSTEM, context];
  const factSources = [profile.raw, raw, existing, ...answered.map((q) => q.answer)];

  onProgress('Planning the narrative');
  const plan = await structured({
    system,
    schema: PlanSchema,
    effort: 'high',
    prompt: `Plan the master statement. Propose the central thesis and the arc, with evidence for each beat. List open questions only where an answer would make the essay specific rather than generic${answered.length ? ', and do not repeat questions already answered' : ''}. At most 8 questions.`,
  });

  const unanswered = plan.open_questions.filter((q) => !answered.some((a) => a.question.toLowerCase() === q.question.toLowerCase()));
  if (unanswered.some((q) => q.critical) && !skipInterview) {
    const merged = [...answered.map((q) => ({ question: q.question, why: 'Answered', critical: false, answer: q.answer })), ...unanswered];
    await fs.writeFile(PATHS.sopInterview, renderInterview(merged), 'utf8');
    return { status: 'needs_answers', plan, questions: unanswered, interviewPath: PATHS.sopInterview };
  }

  const planText = [
    `Central thesis: ${plan.central_thesis}`,
    ...plan.arc.map((b) => `- ${b.section}: ${b.beat}\n  Evidence: ${b.evidence.join('; ')}`),
  ].join('\n');

  onProgress('Drafting');
  const task = `Write the master statement of purpose following this plan, in about ${words} words.\n\n<plan>\n${planText}\n</plan>\n\nReturn only the essay in Markdown, with no title and no commentary.`;
  const first = await generate({ system, prompt: task, effort: 'high' });

  onProgress('Critiquing draft');
  const critique = await structured({
    system,
    schema: MasterCritiqueSchema,
    effort: 'medium',
    prompt: [
      'Critique this master statement against the rubric. Score each criterion 1–5; list unsupported claims, clichés and the highest-impact fixes.',
      ...Object.entries(MASTER_RUBRIC).map(([k, v]) => `- ${k}: ${v}`),
      `<draft>\n${first}\n</draft>`,
    ].join('\n'),
  });
  const badNumbers = unsupportedNumbers(first, factSources);
  const changes = [
    ...eliteViolations(first, framework),
    ...critique.fixes,
    ...critique.unsupported_claims.map((c) => `Unsupported claim: "${c}". Remove it or ground it in the profile.`),
    ...critique.cliches.map((c) => `Cut the cliché "${c}".`),
    ...badNumbers.map((n) => `"${n}" is not in any source. Remove it or use the real figure.`),
  ];

  onProgress('Revising');
  const draft = await generate({
    system,
    effort: 'high',
    prompt: `${task}\n\nHere is your first draft and the required changes. Produce the final version.\n\n<draft>\n${first}\n</draft>\n\n<required_changes>\n${changes.map((c) => `- ${c}`).join('\n')}\n</required_changes>`,
  });

  const warnings = [];
  const stray = unsupportedNumbers(draft, factSources);
  if (stray.length) warnings.push(`Numbers not found in your profile or answers: ${stray.join(', ')}. Confirm they're real.`);
  warnings.push(...eliteViolations(draft, framework).map((v) => `Still breaks ${v}`));
  const wordCount = countWords(draft);

  await fs.mkdir(PATHS.sopOutput, { recursive: true });
  const outputPath = path.join(PATHS.sopOutput, 'master.md');
  await fs.writeFile(outputPath, [
    `<!-- study-ops · master SOP · ${new Date().toISOString().slice(0, 10)} · ${wordCount} words -->`, '', draft, '', '---', '',
    '## Narrative plan', '', `**Thesis:** ${plan.central_thesis}`, '', ...plan.arc.map((b) => `- **${b.section.replace(/_/g, ' ')}**: ${b.beat}`), '',
    '| Criterion (first draft) | Score |', '|---|---|', ...Object.entries(critique.scores).map(([k, v]) => `| ${k.replace(/_/g, ' ')} | ${v}/5 |`), '',
  ].join('\n'), 'utf8');

  let backupPath = null;
  if (adopt) {
    if (hasExisting) {
      backupPath = PATHS.personalStatement.replace(/\.md$/, `.backup-${new Date().toISOString().slice(0, 10)}.md`);
      await fs.copyFile(PATHS.personalStatement, backupPath);
    }
    await fs.writeFile(PATHS.personalStatement, `${draft}\n`, 'utf8');
  }

  return { status: 'complete', plan, draft, wordCount, critique, outputPath, adopted: adopt, backupPath, warnings };
}
