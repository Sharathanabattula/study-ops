/**
 * @file The Elite SOP framework: loading the rules and enforcing them in code.
 *
 * `data/templates/elite_sop_framework.md` (copied from templates/ by `init`)
 * is used verbatim as the system prompt for every statement Study-Ops writes.
 * Its "Banned openings" and "Banned words" lists are also parsed here, so the
 * rules the model is given and the rules the code enforces cannot drift apart.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './paths.js';
import { exists } from './files.js';
import { mentions } from './factcheck.js';

/**
 * @typedef {object} Framework
 * @property {string} text              Full Markdown, used as the system prompt.
 * @property {string[]} bannedOpenings  Lower-case phrases a statement may not open with.
 * @property {string[]} bannedWords     Lower-case words/phrases banned anywhere.
 * @property {string} path              File actually loaded.
 */

/**
 * Load the student's copy, falling back to the shipped template.
 * @param {string} [frameworkPath]
 * @returns {Promise<Framework>}
 */
export async function loadFramework(frameworkPath = PATHS.eliteFramework) {
  const file = (await exists(frameworkPath)) ? frameworkPath : path.join(PATHS.templates, 'elite_sop_framework.md');
  const text = await fs.readFile(file, 'utf8');
  return {
    text: text.replace(/<!--[\s\S]*?-->/g, '').trim(),
    bannedOpenings: listUnder(text, 'Banned openings'),
    bannedWords: listUnder(text, 'Banned words'),
    path: file,
  };
}

/**
 * Backticked bullet items under a `## Heading`.
 * @param {string} md
 * @param {string} heading
 */
export function listUnder(md, heading) {
  const section = md.split(/^## /m).find((s) => s.toLowerCase().startsWith(heading.toLowerCase()));
  if (!section) return [];
  return [...section.matchAll(/^\s*-\s+`([^`]+)`/gm)].map((m) => m[1].trim().toLowerCase());
}

/**
 * Body paragraphs of a Markdown statement (headings and HTML comments removed).
 * @param {string} text
 */
export function paragraphs(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p) && !/^---+$/.test(p));
}

/**
 * Check a draft against the Elite constraints.
 *
 * @param {string} text
 * @param {Framework} framework
 * @param {{ module?: string, professor?: string, lab?: string }} [required]
 *   University details that must appear in the final body paragraph.
 * @returns {string[]} Human-readable violations; empty when compliant.
 */
export function eliteViolations(text, framework, required = {}) {
  const issues = [];
  const paras = paragraphs(text);
  const opening = (paras[0] ?? '').toLowerCase().replace(/^[*_"'“‘\s]+/, '');

  const badOpen = framework.bannedOpenings.find((p) => opening.startsWith(p));
  if (badOpen) issues.push(`Rule 1: the statement opens with "${badOpen}". Open in media res with a concrete milestone.`);

  const lower = text.toLowerCase();
  for (const word of framework.bannedWords) {
    const re = new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u');
    if (re.test(lower)) issues.push(`Rule 2: remove "${word}" and show the evidence instead.`);
  }

  // Rule 3: the final body paragraph is the one before the conclusion.
  const finalBody = paras.length >= 3 ? paras[paras.length - 2] : paras.at(-1) ?? '';
  for (const [kind, name] of Object.entries(required)) {
    if (name && !mentions(finalBody, name)) {
      issues.push(`Rule 3: the final body paragraph must name the ${kind} "${name}" and connect it to the student's work.`);
    }
  }
  return issues;
}

/**
 * Has the student actually filled in `data/master_sop_raw.md`?
 * @param {string} md
 */
export function rawIsFilled(md) {
  return md.replace(/<!--[\s\S]*?-->/g, '').replace(/^#.*$/gm, '').trim().length >= 300;
}
