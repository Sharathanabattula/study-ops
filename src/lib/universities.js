/**
 * @file Russell Group registry lookups backed by `config/uk_universities.yaml`.
 */
import { PATHS } from './paths.js';
import { readYaml } from './files.js';

/**
 * @typedef {object} University
 * @property {string} key
 * @property {string} name
 * @property {string[]} domains
 * @property {string} city
 * @property {'london'|'outside-london'} ukvi_location
 * @property {string} [tone] Editorial tone heuristic for the SOP Tailor.
 */

/** @type {University[] | null} */
let cache = null;

/** @returns {Promise<University[]>} */
export async function loadUniversities() {
  cache ??= (await readYaml(PATHS.universities)).universities;
  return cache;
}

/**
 * Resolve a university from a free-text name/key ("LSE", "imperial", "King's").
 * @param {string} query
 * @returns {Promise<University | undefined>}
 */
export async function findUniversity(query) {
  const q = query.trim().toLowerCase();
  const all = await loadUniversities();
  return (
    all.find((u) => u.key === q) ??
    all.find((u) => u.name.toLowerCase() === q) ??
    all.find((u) => u.name.toLowerCase().includes(q))
  );
}

/**
 * Resolve a university from any URL on its domain (subdomains included).
 * @param {string} url
 * @returns {Promise<University | undefined>}
 */
export async function findUniversityByUrl(url) {
  const host = new URL(url).hostname.toLowerCase();
  const all = await loadUniversities();
  return all.find((u) => u.domains.some((d) => host === d || host.endsWith(`.${d}`)));
}
