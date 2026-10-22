/**
 * @file Agent 14: Interview Prep. Question banks plus timed mock practice.
 *
 * Interview types
 *  - credibility       University pre-CAS / UKVI credibility interview: course
 *                      knowledge, why this university and the UK, finances,
 *                      plans after study. Answers must match the application
 *                      exactly, so this type is checked against your files.
 *  - kira              Kira Talent-style timed video/written responses
 *                      (behavioural and motivation questions under a clock).
 *  - technical-finance Corporate finance, valuation, markets, maths, with worked answers.
 *  - technical-cs      Algorithms, data structures, systems, ML basics, with worked answers.
 *  - academic          Panel or supervisor interview: research interests, projects, reading.
 *  - general           Motivation and fit.
 *
 * Personal answers are outlines built only from the profile, raw material,
 * SOP and programme page, never invented. Technical model answers may use
 * general subject knowledge.
 *
 * Practice mode asks the questions with prep/answer countdowns, takes typed
 * answers (a stand-in for speaking), scores each against a rubric, flags
 * claims that contradict your files (a red flag in credibility interviews),
 * and logs the session to outputs/interview/.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import YAML from 'yaml';
import { PATHS } from '../lib/paths.js';
import { exists } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { findUniversity } from '../lib/universities.js';
import { getProgramme, totalTuition, yearOneTuition } from '../lib/programme.js';
import { countWords, unsupportedNumbers } from '../lib/factcheck.js';
import { loadFramework } from '../lib/sop_framework.js';
import { isConfigured, structured } from '../llm/claude.js';
import { sopFileName } from './2_sop_tailor.js';
import { auditFunds } from './3_ukvi_compliance_engine.js';

/**
 * Timings are typical defaults; every school and platform configures its own.
 * Check your invitation and pass --prep / --answer to match it.
 */
export const TYPES = Object.freeze({
  credibility: { label: 'Credibility / pre-CAS interview', prep: 0, answer: 120, technical: false, focus: 'course content and structure, why this university over others, why the UK rather than home, finances and who pays, accommodation, plans after study and ties to home, consistency with the application' },
  kira: { label: 'Kira Talent-style timed assessment', prep: 45, answer: 90, technical: false, focus: 'behavioural (STAR) questions, motivation, teamwork, failure, ethics, why this programme; one short written response' },
  'technical-finance': { label: 'Technical finance round', prep: 30, answer: 180, technical: true, focus: 'DCF and valuation, WACC, CAPM, bond pricing and duration, accounting links between statements, options basics, probability and mental maths, market awareness' },
  'technical-cs': { label: 'Technical CS round', prep: 30, answer: 240, technical: true, focus: 'complexity analysis, arrays/hash maps/trees/graphs, recursion and DP, SQL, system design basics, ML fundamentals, the student’s own projects' },
  academic: { label: 'Academic panel interview', prep: 0, answer: 180, technical: false, focus: 'research interests, methods in the student’s projects, a paper or idea they engaged with, why this supervisor/group, how they handle being wrong' },
  general: { label: 'General admissions interview', prep: 0, answer: 120, technical: false, focus: 'motivation, fit, goals, strengths and weaknesses' },
});

export const BankSchema = z.object({
  questions: z.array(z.object({
    category: z.string(),
    question: z.string(),
    why_asked: z.string().describe('What the interviewer is really testing'),
    answer_outline: z.array(z.string()).describe('3–6 bullets in the student’s voice, using only their real facts'),
    evidence_used: z.array(z.string()),
    model_answer: z.string().nullable().describe('Technical questions only: the worked solution. Null otherwise.'),
    pitfalls: z.array(z.string()),
    follow_ups: z.array(z.string()),
  })),
});

export const FeedbackSchema = z.object({
  scores: z.object({
    structure: z.number().describe('1–5: clear point, evidence, link back'),
    specificity: z.number().describe('1–5: concrete facts over generalities'),
    relevance: z.number().describe('1–5: answers the actual question'),
    consistency: z.number().describe('1–5: consistent with the student’s application files'),
    concision: z.number().describe('1–5: fits the time without padding'),
  }),
  inconsistencies: z.array(z.string()).describe('Claims that contradict or go beyond the application files'),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  stronger_answer: z.array(z.string()).describe('Outline of a better answer using only real facts'),
});

/** Speaking pace used to size typed answers to the clock. */
export const WORDS_PER_MINUTE = 140;

const SYSTEM = `You are the Interview Coach in Study-Ops, preparing one student for UK university interviews.

Rules:
- Personal answers use only facts in the student's files (profile, raw material, statement, programme page, computed figures). Never invent experiences, numbers or plans. Where the files are thin, say what the student should prepare.
- In credibility interviews, consistency with the application matters more than polish: flag anything that would contradict it.
- Answers are outlines to internalise, not scripts to memorise.
- Technical model answers may use general subject knowledge; show the working.`;

/** @param {string} university @param {string} type */
function bankPath(university, type) {
  const slug = `${university}-${type}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { md: path.join(PATHS.interviewOutput, `${slug}.md`), yaml: path.join(PATHS.interviewOutput, `${slug}.yaml`) };
}

/** Gather the student's files and computed facts used as interview context. */
async function gatherContext({ university, course, url, profile }) {
  const parts = [`<student_profile>\n${profile.raw}\n</student_profile>`];
  const sources = [profile.raw];
  if (await exists(PATHS.masterRaw)) {
    const raw = await fs.readFile(PATHS.masterRaw, 'utf8');
    parts.push(`<raw_material>\n${raw}\n</raw_material>`);
    sources.push(raw);
  }
  const uni = await findUniversity(university);
  for (const name of [university, uni?.name].filter(Boolean)) {
    const sop = path.join(PATHS.sopOutput, sopFileName(name));
    if (await exists(sop)) {
      const text = (await fs.readFile(sop, 'utf8')).split('\n---\n')[0];
      parts.push(`<statement_submitted>\n${text}\n</statement_submitted>`);
      sources.push(text);
      break;
    }
  }
  let prog = null;
  if (url) {
    prog = await getProgramme({ url, nationality: profile.facts.identity?.nationality });
    parts.push(`<programme_page url="${url}">\n${prog.pageText}\n</programme_page>`);
    sources.push(prog.pageText);
    const tuition = yearOneTuition(prog.requirements);
    if (tuition != null) {
      const location = prog.ukviLocation ?? 'london';
      const audit = await auditFunds({ location, durationMonths: prog.requirements.duration_months ?? 12, tuition });
      const facts = [
        `Course: ${prog.requirements.programme_title ?? course}, ${prog.requirements.duration_months ?? '?'} months.`,
        `Tuition: £${totalTuition(prog.requirements)?.toLocaleString('en-GB')} (${prog.requirements.tuition_basis}).`,
        `UKVI funds to show: £${audit.funds.total.toLocaleString('en-GB')} (tuition outstanding £${audit.funds.tuitionOutstanding.toLocaleString('en-GB')} + living £${audit.funds.maintenance.toLocaleString('en-GB')}).`,
      ];
      parts.push(`<computed_facts>\n${facts.join('\n')}\n</computed_facts>`);
      sources.push(facts.join('\n'));
    }
  }
  return { context: parts.join('\n\n'), sources, universityName: uni?.name ?? university };
}

/**
 * Generate a question bank.
 * @param {object} input
 * @param {string} input.university
 * @param {string} input.course
 * @param {keyof typeof TYPES} input.type
 * @param {string} [input.url]
 * @param {number} [input.count=12]
 * @param {(stage: string) => void} [input.onProgress]
 */
export async function generateInterviewBank({ university, course, type, url, count = 12, onProgress = () => {} }) {
  if (!TYPES[type]) throw new Error(`Unknown interview type "${type}". Use: ${Object.keys(TYPES).join(', ')}`);
  if (!isConfigured()) throw new Error('Interview prep uses Claude. Add ANTHROPIC_API_KEY to .env first.');
  const profile = await loadProfile();
  const t = TYPES[type];
  const { context, sources, universityName } = await gatherContext({ university, course, url, profile });

  onProgress(`Writing ${count} ${t.label.toLowerCase()} questions`);
  const bank = await structured({
    system: [SYSTEM, context],
    schema: BankSchema,
    effort: t.technical ? 'high' : 'medium',
    prompt: `Write ${count} likely questions for a ${t.label} for ${course} at ${universityName}.\nCover: ${t.focus}.\nOrder from most to least likely. ${t.technical ? 'Include worked model answers and at least two questions on the student’s own projects.' : 'model_answer must be null.'}`,
  });

  const warnings = [];
  for (const q of bank.questions) {
    if (t.technical && q.model_answer) continue;
    const stray = unsupportedNumbers(q.answer_outline.join('\n'), sources);
    if (stray.length) warnings.push(`"${q.question.slice(0, 60)}…": numbers not in your files (${stray.join(', ')}). Check before you rely on them.`);
  }

  const files = bankPath(university, type);
  await fs.mkdir(PATHS.interviewOutput, { recursive: true });
  await fs.writeFile(files.yaml, YAML.stringify({ university: universityName, course, type, url: url ?? null, generated: new Date().toISOString(), questions: bank.questions }), 'utf8');
  await fs.writeFile(files.md, [
    `# ${t.label}: ${course}, ${universityName}`,
    '',
    `Typical timing: ${t.prep ? `${t.prep}s to prepare, ` : ''}${t.answer}s to answer. Check your invitation; each school sets its own.`,
    '',
    ...bank.questions.flatMap((q, i) => [
      `## ${i + 1}. ${q.question}`,
      '',
      `*${q.category}. Testing: ${q.why_asked}*`,
      '',
      ...q.answer_outline.map((b) => `- ${b}`),
      ...(q.model_answer ? ['', '**Worked answer**', '', q.model_answer] : []),
      ...(q.pitfalls.length ? ['', `**Avoid:** ${q.pitfalls.join('; ')}`] : []),
      ...(q.follow_ups.length ? ['', `**Likely follow-ups:** ${q.follow_ups.join(' · ')}`] : []),
      '',
    ]),
    ...(warnings.length ? ['---', '', ...warnings.map((w) => `> ⚠️ ${w}`), ''] : []),
    `Practise: \`study-ops interview-practice --uni "${university}" --type ${type}\``,
    '',
  ].join('\n'), 'utf8');

  return { ...bank, outputPath: files.md, bankPath: files.yaml, warnings };
}

/**
 * Deterministic checks on a typed practice answer.
 * @param {string} answer
 * @param {number} answerSeconds
 * @param {{ bannedWords: string[] }} framework
 */
export function answerChecks(answer, answerSeconds, framework) {
  const words = countWords(answer);
  const max = Math.round((answerSeconds / 60) * WORDS_PER_MINUTE);
  const notes = [];
  if (words > max * 1.15) notes.push(`About ${words} words; at a speaking pace that runs over ${answerSeconds}s (≈${max} words).`);
  if (words < max * 0.3) notes.push(`Only ${words} words; you have time for a fuller answer (≈${max}).`);
  const banned = framework.bannedWords.filter((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'iu').test(answer));
  if (banned.length) notes.push(`Swap ${banned.map((b) => `"${b}"`).join(', ')} for evidence.`);
  const fillers = (answer.match(/\b(basically|actually|like|you know|kind of|sort of|i mean)\b/gi) ?? []).length;
  if (fillers >= 3) notes.push(`${fillers} filler phrases.`);
  return { words, maxWords: max, notes };
}

/**
 * Timed mock interview.
 * @param {object} input
 * @param {string} input.university
 * @param {keyof typeof TYPES} input.type
 * @param {number} [input.count=5]
 * @param {number} [input.prep]     seconds; overrides the type default
 * @param {number} [input.answer]   seconds; overrides the type default
 * @param {{ ask: (prompt: string) => Promise<string>, print: (s: string) => void, countdown?: (seconds: number, label: string) => Promise<void> }} input.io
 */
export async function practiceSession({ university, type, count = 5, prep, answer, io }) {
  if (!isConfigured()) throw new Error('Practice feedback uses Claude. Add ANTHROPIC_API_KEY to .env first.');
  const files = bankPath(university, type);
  if (!(await exists(files.yaml))) throw new Error(`No question bank yet. Run: study-ops interview --uni "${university}" --course "<course>" --type ${type}`);
  const bank = YAML.parse(await fs.readFile(files.yaml, 'utf8'));
  const t = TYPES[type];
  const prepS = prep ?? t.prep;
  const answerS = answer ?? t.answer;
  const profile = await loadProfile();
  const { context, sources } = await gatherContext({ university, course: bank.course, url: bank.url ?? undefined, profile });
  const framework = await loadFramework();

  const log = [`# Practice · ${t.label} · ${bank.university} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, ''];
  const results = [];
  for (const q of bank.questions.slice(0, count)) {
    io.print(`\nQ${results.length + 1}. ${q.question}`);
    if (prepS && io.countdown) await io.countdown(prepS, 'prepare');
    const started = Date.now();
    const text = (await io.ask(`Your answer (${answerS}s): `)).trim();
    const seconds = Math.round((Date.now() - started) / 1000);
    if (!text) { io.print('Skipped.'); continue; }

    const checks = answerChecks(text, answerS, framework);
    const stray = t.technical ? [] : unsupportedNumbers(text, sources);
    const fb = await structured({
      system: [SYSTEM, context],
      schema: FeedbackSchema,
      effort: 'medium',
      prompt: `Assess this practice answer for a ${t.label}. Score 1–5 on each criterion. List any claims that contradict or go beyond the student's files.\n\nQuestion: ${q.question}\nWhat it tests: ${q.why_asked}\n${q.model_answer ? `Reference answer: ${q.model_answer}\n` : ''}\n<answer>\n${text}\n</answer>`,
    });
    if (stray.length) fb.inconsistencies.push(`Numbers not in your files: ${stray.join(', ')}`);
    results.push({ question: q.question, answer: text, seconds, checks, feedback: fb });

    const avg = Object.values(fb.scores).reduce((s, v) => s + v, 0) / 5;
    io.print(`Score ${avg.toFixed(1)}/5 · ${checks.words} words${seconds > answerS ? ` · took ${seconds}s (limit ${answerS}s)` : ''}`);
    for (const n of [...fb.inconsistencies, ...checks.notes, ...fb.improvements.slice(0, 2)]) io.print(`  • ${n}`);
    log.push(`## ${q.question}`, '', `> ${text.replace(/\n/g, '\n> ')}`, '', `**Score ${avg.toFixed(1)}/5** (${Object.entries(fb.scores).map(([k, v]) => `${k} ${v}`).join(', ')}) · ${checks.words} words · ${seconds}s`, '',
      ...(fb.inconsistencies.length ? ['**Inconsistencies:**', ...fb.inconsistencies.map((x) => `- ${x}`), ''] : []),
      '**Improve:**', ...[...checks.notes, ...fb.improvements].map((x) => `- ${x}`), '',
      '**Stronger answer:**', ...fb.stronger_answer.map((x) => `- ${x}`), '');
  }

  await fs.mkdir(PATHS.interviewOutput, { recursive: true });
  const logPath = path.join(PATHS.interviewOutput, `practice-${path.basename(files.yaml, '.yaml')}-${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(logPath, log.join('\n'), 'utf8');
  return { results, logPath };
}
