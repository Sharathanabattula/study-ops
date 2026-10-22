/**
 * @file `study-ops init`: scaffold the local workspace from templates.
 *
 * Copies `templates/*` into `data/` without overwriting anything that already
 * exists (unless `--force`), then prints the onboarding guide.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../lib/paths.js';
import { exists } from '../lib/files.js';
import { banner, color, heading, note, panel, success, warn } from '../ui/theme.js';

const SCAFFOLD = [
  { template: 'student_profile.md', target: PATHS.profile },
  { template: 'tracker.yaml', target: PATHS.tracker },
  { template: 'personal_statement.md', target: PATHS.personalStatement },
];

/**
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ created: string[], skipped: string[] }>}
 */
export async function initWorkspace({ force = false } = {}) {
  await Promise.all([PATHS.data, PATHS.reports, PATHS.sopOutput].map((d) => fs.mkdir(d, { recursive: true })));
  const created = [];
  const skipped = [];
  for (const { template, target } of SCAFFOLD) {
    if (!force && (await exists(target))) {
      skipped.push(target);
      continue;
    }
    await fs.copyFile(path.join(PATHS.templates, template), target);
    created.push(target);
  }
  return { created, skipped };
}

/** Print the onboarding guide shown after `init`. */
export function printWelcome({ created, skipped }) {
  banner();
  const rel = (p) => path.relative(process.cwd(), p) || p;
  for (const f of created) success(`Created ${color.bold(rel(f))}`);
  for (const f of skipped) warn(`Kept existing ${color.bold(rel(f))} ${color.muted('(use --force to reset)')}`);
  console.log();

  heading('Fill out your profile: the single source of truth');
  panel('data/student_profile.md', [
    `${color.brand('1')}  ${color.bold('YAML front-matter')}  ${color.muted('hard facts every agent reads')}`,
    `   ${color.muted('academics')}   cgpa + cgpa_scale, degree, institution, backlogs`,
    `   ${color.muted('english')}     IELTS/PTE overall ${color.bold('and')} every band (UKVI checks bands)`,
    `   ${color.muted('budget')}      max_tuition and max_total_year_one in GBP`,
    `   ${color.muted('target')}      level, subjects, intake, study_location, shortlist`,
    `   ${color.muted('experience')}  roles with quantified highlights`,
    '',
    `${color.brand('2')}  ${color.bold('Markdown narrative')}  ${color.muted('the story only you can tell')}`,
    `   Core Narrative · Career Goals · Signature Achievements`,
    `   Why the UK · Gaps & Red Flags ${color.muted('(be honest; agents pre-empt them)')}`,
    '',
    `${color.brand('3')}  ${color.bold('data/personal_statement.md')}  ${color.muted('your long-form master SOP')}`,
  ], { tint: color.brand });

  heading('Then run');
  const cmd = (text, desc = '') => `${color.accent(text.padEnd(44))}${color.muted(desc)}`;
  panel('commands', [
    cmd('study-ops evaluate <programme-url>', 'A–F fit report'),
    cmd('study-ops generate-sop --uni LSE', 'tailored statement'),
    cmd('study-ops audit-funds --location london \\', 'UKVI proof of funds'),
    cmd('    --duration 12 --tuition 38000'),
  ]);

  note('Privacy: data/, reports/ and output/ are git-ignored and never leave this machine.');
  console.log();
}
