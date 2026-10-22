/**
 * @file Read/write `data/tracker.yaml` without losing your comments.
 *
 * Uses the YAML Document API so hand-written notes and the header block
 * survive when agents update an entry.
 */
import fs from 'node:fs/promises';
import YAML from 'yaml';
import { PATHS } from './paths.js';
import { exists } from './files.js';

/**
 * Create or update one application entry by `id`. Only the fields you pass are
 * touched. Nested objects are merged key by key.
 *
 * @param {Record<string, any> & { id: string }} entry
 * @param {object} [opts]
 * @param {Record<string, any>} [opts.defaults]  Fields set only when the entry is new
 *   (e.g. `status: shortlisted`), so progress you've recorded is never overwritten.
 * @param {string} [opts.trackerPath]
 * @returns {Promise<'created' | 'updated' | 'skipped'>} `skipped` if there is no tracker file.
 */
export async function upsertApplication(entry, { defaults = {}, trackerPath = PATHS.tracker } = {}) {
  if (!(await exists(trackerPath))) return 'skipped';
  const doc = YAML.parseDocument(await fs.readFile(trackerPath, 'utf8'));
  if (!doc.has('applications')) doc.set('applications', doc.createNode([]));

  const apps = doc.get('applications');
  const index = apps.items.findIndex((item) => item.get?.('id') === entry.id);

  if (index === -1) {
    doc.addIn(['applications'], doc.createNode({ id: entry.id, ...defaults, ...entry }));
  } else {
    for (const [path, value] of leafPaths(entry)) doc.setIn(['applications', index, ...path], value);
  }
  await fs.writeFile(trackerPath, doc.toString(), 'utf8');
  return index === -1 ? 'created' : 'updated';
}

/**
 * Flatten `{ a: { b: 1 }, c: [2] }` to `[[['a','b'], 1], [['c'], [2]]]`.
 * Arrays and null are leaves.
 * @param {Record<string, any>} obj
 * @param {string[]} [prefix]
 * @returns {Array<[string[], any]>}
 */
function leafPaths(obj, prefix = []) {
  return Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? leafPaths(value, [...prefix, key])
      : [[[...prefix, key], value]],
  );
}
