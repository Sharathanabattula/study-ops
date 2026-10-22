/**
 * @file Thin, dependency-light helpers for the Markdown + YAML state layer.
 *
 * Study-Ops keeps no database. State is plain files you can read, diff and
 * edit by hand:
 *   - `*.yaml` holds structured state (tracker, rules).
 *   - `*.md` holds a YAML front-matter block (machine facts) followed by a
 *     Markdown body (human narrative).
 */
import fs from 'node:fs/promises';
import YAML from 'yaml';
import { marked } from 'marked';

/** Matches a leading `---\n...\n---` YAML front-matter block. */
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Check whether a file exists.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse a YAML file.
 * @template T
 * @param {string} filePath
 * @returns {Promise<T>}
 */
export async function readYaml(filePath) {
  return YAML.parse(await fs.readFile(filePath, 'utf8'));
}

/**
 * Serialise and write a YAML file.
 * @param {string} filePath
 * @param {unknown} value
 */
export async function writeYaml(filePath, value) {
  await fs.writeFile(filePath, YAML.stringify(value), 'utf8');
}

/**
 * Split a Markdown document into its front-matter data and body.
 * @param {string} source Raw Markdown text.
 * @returns {{ data: Record<string, any>, body: string }}
 */
export function parseFrontMatter(source) {
  const match = source.match(FRONT_MATTER_RE);
  if (!match) return { data: {}, body: source };
  return { data: YAML.parse(match[1]) ?? {}, body: source.slice(match[0].length) };
}

/**
 * Index a Markdown body by its `##` headings so agents can pull one section
 * (e.g. "Core Narrative") without re-parsing the whole document. Emoji and
 * punctuation are stripped from keys.
 * @param {string} body
 * @returns {Record<string, string>} Map of normalised heading → section text.
 */
export function sectionsByHeading(body) {
  /** @type {Record<string, string>} */
  const sections = {};
  let current = null;
  for (const token of marked.lexer(body)) {
    if (token.type === 'heading' && token.depth === 2) {
      current = normaliseHeading(token.text);
      sections[current] = '';
    } else if (current) {
      sections[current] += token.raw;
    }
  }
  for (const key of Object.keys(sections)) sections[key] = stripComments(sections[key]).trim();
  return sections;
}

/**
 * @param {string} text
 * @returns {string} e.g. "🧭 Core Narrative" → "core narrative"
 */
export function normaliseHeading(text) {
  return text
    .replace(/[^\p{L}\p{N}\s&-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** @param {string} text */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}
