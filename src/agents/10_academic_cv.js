/**
 * @file Agent 10: Academic CV Converter.
 *
 * Turns a job-search resume into an academic CV for UK postgraduate
 * applications: education and research first, then projects, papers and
 * quantified impact, with work experience reframed for what it shows about
 * the student as a future researcher or analyst.
 *
 * Pipeline
 *  1. Read the resume (`data/resume.md`, or `--resume <file>`) and the profile.
 *  2. Claude restructures it into a fixed academic-CV schema. It may reorder,
 *     regroup and rephrase, but not add facts. Where impact isn't quantified
 *     it writes a question for the student instead of a number.
 *  3. Code checks: every number and every publication title must appear in
 *     the resume or profile. Anything else is listed for review.
 *  4. Render consistent Markdown to `output/cv/academic_cv.md`, applying UK
 *     conventions: reverse-chronological, roughly two pages, and no photo,
 *     date of birth, marital status, religion or parents' names (common on
 *     Indian resumes, not expected in the UK).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { PATHS } from '../lib/paths.js';
import { exists } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { countWords, mentions, unsupportedNumbers } from '../lib/factcheck.js';
import { isConfigured, structured } from '../llm/claude.js';

/** About two A4 pages of CV text. */
export const TARGET_WORDS = 900;

const Entry = z.object({
  title: z.string(),
  organisation: z.string().nullable(),
  dates: z.string().nullable(),
  bullets: z.array(z.string()).describe('Action + method + quantified result where the source has numbers'),
});

export const AcademicCvSchema = z.object({
  header: z.object({
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    location: z.string().nullable(),
    links: z.array(z.string()).describe('LinkedIn, GitHub, Google Scholar, portfolio'),
  }),
  research_interests: z.array(z.string()).describe('Only if supported by the resume or profile'),
  education: z.array(z.object({
    degree: z.string(),
    institution: z.string(),
    dates: z.string().nullable(),
    grade: z.string().nullable().describe('As stated in the source; no conversion'),
    thesis: z.string().nullable(),
    highlights: z.array(z.string()).describe('Relevant modules, rank, scholarships'),
  })),
  research_experience: z.array(Entry),
  publications: z.array(z.object({
    citation: z.string().describe('Formatted citation, using only details in the source'),
    title: z.string().describe('Exact title from the source'),
    status: z.enum(['published', 'accepted', 'under_review', 'in_preparation', 'conference', 'poster', 'preprint']),
  })),
  projects: z.array(Entry),
  professional_experience: z.array(Entry).describe('Reframed for analytical and research skills'),
  skills: z.array(z.object({ category: z.string(), items: z.array(z.string()) })),
  awards: z.array(z.object({ name: z.string(), year: z.string().nullable(), detail: z.string().nullable() })),
  leadership: z.array(Entry),
  certifications: z.array(z.string()),
  removed_personal_details: z.array(z.string()).describe('Personal details dropped per UK convention, e.g. "Date of birth"'),
  quantify_prompts: z.array(z.string()).describe('Questions to the student where a bullet would be stronger with a real number'),
});

const SYSTEM = `You convert job-search resumes into academic CVs for UK postgraduate applications in Study-Ops.

Rules:
- Use only facts in the resume and profile. You may reorder, regroup, merge and rephrase; you may not add achievements, numbers, tools, dates, publications or titles.
- Lead with what an admissions tutor values: education, research, projects, publications, quantitative results.
- Bullets: strong verb + what was done + method/tool + result. Keep numbers exactly as in the source. If a result isn't quantified, keep it qualitative and add a question to quantify_prompts.
- Drop personal details UK CVs don't include (photo, date of birth, age, gender, marital status, religion, nationality unless relevant to visa, parents' names, full address) and list them in removed_personal_details.
- British English; dates as "Mon YYYY – Mon YYYY".`;

/**
 * Render the CV deterministically so formatting is identical every run.
 * @param {z.infer<typeof AcademicCvSchema>} cv
 */
export function renderCv(cv) {
  const h = cv.header;
  const entry = (e) => [`**${e.title}**${e.organisation ? `, ${e.organisation}` : ''}${e.dates ? ` · ${e.dates}` : ''}`, ...e.bullets.map((b) => `- ${b}`), ''];
  const section = (title, body) => (body.length ? [`## ${title}`, '', ...body] : []);
  return [
    `# ${h.name}`,
    '',
    [h.email, h.phone, h.location, ...h.links].filter(Boolean).join(' · '),
    '',
    ...section('Research Interests', cv.research_interests.length ? [cv.research_interests.join(' · '), ''] : []),
    ...section('Education', cv.education.flatMap((e) => [
      `**${e.degree}**, ${e.institution}${e.dates ? ` · ${e.dates}` : ''}`,
      ...(e.grade ? [`- Grade: ${e.grade}`] : []),
      ...(e.thesis ? [`- Thesis: ${e.thesis}`] : []),
      ...e.highlights.map((x) => `- ${x}`),
      '',
    ])),
    ...section('Research Experience', cv.research_experience.flatMap(entry)),
    ...section('Publications & Presentations', cv.publications.length ? [...cv.publications.map((p, i) => `${i + 1}. ${p.citation}${['under_review', 'in_preparation', 'preprint'].includes(p.status) ? ` *(${p.status.replace('_', ' ')})*` : ''}`), ''] : []),
    ...section('Projects', cv.projects.flatMap(entry)),
    ...section('Professional Experience', cv.professional_experience.flatMap(entry)),
    ...section('Leadership & Activities', cv.leadership.flatMap(entry)),
    ...section('Awards & Scholarships', cv.awards.length ? [...cv.awards.map((a) => `- **${a.name}**${a.year ? ` (${a.year})` : ''}${a.detail ? `: ${a.detail}` : ''}`), ''] : []),
    ...section('Skills', cv.skills.length ? [...cv.skills.map((s) => `- **${s.category}:** ${s.items.join(', ')}`), ''] : []),
    ...section('Certifications', cv.certifications.length ? [...cv.certifications.map((c) => `- ${c}`), ''] : []),
    '## References',
    '',
    'Available on request.',
    '',
  ].join('\n');
}

/**
 * @param {object} [input]
 * @param {string} [input.resumePath]
 * @param {(stage: string) => void} [input.onProgress]
 */
export async function buildAcademicCv({ resumePath = PATHS.resume, onProgress = () => {} } = {}) {
  if (!isConfigured()) throw new Error('CV conversion uses Claude. Add ANTHROPIC_API_KEY to .env first.');
  if (!(await exists(resumePath))) throw new Error(`No resume at ${resumePath}. Paste your current resume into data/resume.md (plain text or Markdown).`);
  const resume = (await fs.readFile(resumePath, 'utf8')).trim();
  if (resume.replace(/^#.*$|^>.*$|<!--[\s\S]*?-->/gm, '').trim().length < 200) {
    throw new Error(`${path.basename(resumePath)} looks empty. Paste your current resume into it first.`);
  }
  const profile = await loadProfile();

  onProgress('Restructuring into an academic CV');
  const cv = await structured({
    system: [SYSTEM],
    schema: AcademicCvSchema,
    effort: 'high',
    prompt: `Convert this resume into an academic CV.\n\n<resume>\n${resume}\n</resume>\n\n<student_profile>\n${profile.raw}\n</student_profile>`,
  });

  const markdown = renderCv(cv);
  const sources = [resume, profile.raw];
  const strayNumbers = unsupportedNumbers(markdown, sources);
  const strayPublications = cv.publications.filter((p) => !sources.some((s) => mentions(s, p.title))).map((p) => p.title);
  const wordCount = countWords(markdown);
  const warnings = [
    ...(strayNumbers.length ? [`Numbers not in your resume or profile: ${strayNumbers.join(', ')}. Remove or confirm.`] : []),
    ...(strayPublications.length ? [`Publications not found in your resume: ${strayPublications.join('; ')}. Remove them unless real.`] : []),
    ...(wordCount > TARGET_WORDS * 1.3 ? [`About ${wordCount} words, likely over two pages. Trim older or less relevant items.`] : []),
  ];

  await fs.mkdir(PATHS.cvOutput, { recursive: true });
  const outputPath = path.join(PATHS.cvOutput, 'academic_cv.md');
  await fs.writeFile(outputPath, [
    markdown, '---', '',
    '## Review notes (delete before sending)', '',
    ...(cv.removed_personal_details.length ? [`**Removed (not used on UK CVs):** ${cv.removed_personal_details.join(', ')}`, ''] : []),
    ...(cv.quantify_prompts.length ? ['**Add real numbers where you have them:**', ...cv.quantify_prompts.map((q) => `- [ ] ${q}`), ''] : []),
    ...warnings.map((w) => `> ⚠️ ${w}`),
    '',
  ].join('\n'), 'utf8');

  return { cv, markdown, outputPath, wordCount, warnings };
}
