/**
 * @file Loader for `data/student_profile.md`, the single source of truth.
 */
import fs from 'node:fs/promises';
import { PATHS } from './paths.js';
import { exists, parseFrontMatter, sectionsByHeading } from './files.js';

/**
 * @typedef {object} StudentProfile
 * @property {Record<string, any>} facts    Parsed YAML front-matter (CGPA, IELTS, budget, ...).
 * @property {Record<string, string>} narrative Markdown sections keyed by normalised `##` heading.
 * @property {string} raw                   Full original file, for passing to an LLM verbatim.
 * @property {string} path                  Absolute path the profile was read from.
 */

/**
 * Load and parse the student profile.
 * @param {string} [profilePath] Defaults to `data/student_profile.md`.
 * @returns {Promise<StudentProfile>}
 * @throws {Error} With `code = 'PROFILE_MISSING'` when `study-ops init` has not been run.
 */
export async function loadProfile(profilePath = PATHS.profile) {
  if (!(await exists(profilePath))) {
    const err = new Error(`No student profile at ${profilePath}. Run \`study-ops init\` first.`);
    err.code = 'PROFILE_MISSING';
    throw err;
  }
  const raw = await fs.readFile(profilePath, 'utf8');
  const { data, body } = parseFrontMatter(raw);
  return { facts: data, narrative: sectionsByHeading(body), raw, path: profilePath };
}

/**
 * List required profile fields that are still empty, so commands can nudge
 * the student before spending LLM tokens on a half-filled profile.
 * @param {StudentProfile} profile
 * @returns {string[]} Dotted paths of missing fields, e.g. `["academics.cgpa"]`.
 */
export function missingCoreFields(profile) {
  const required = [
    'identity.full_name',
    'identity.nationality',
    'target.level',
    'target.subjects',
    'academics.degree',
    'academics.cgpa',
    'english.test',
    'english.overall',
    'budget.max_tuition',
  ];
  return required.filter((dotted) => {
    const value = dotted.split('.').reduce((obj, key) => obj?.[key], profile.facts);
    return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  });
}
