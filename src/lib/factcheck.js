/**
 * @file Deterministic fabrication guards shared by every document agent.
 *
 * Models are good writers and unreliable witnesses. These checks run in code
 * after generation, so a document can't quietly gain a number, a professor or
 * a publication the student never gave us.
 */

const NUMBER_RE = /(?<![\w.])(?:£|\$|₹|€)?\d[\d,]*(?:\.\d+)?\s?(?:%|k|K|m|M|x|×)?(?![\w])/g;

/** Numbers that read as structure, not claims (list markers, "one or two"). */
const TRIVIAL = new Set(['0', '1', '2', '3']);

/**
 * Canonicalise a numeric token: drop currency, commas and spaces, and
 * lower-case units.
 * @param {string} token
 */
export function normaliseNumber(token) {
  return token.replace(/[£$₹€,\s]/g, '').replace(/×/g, 'x').toLowerCase();
}

/**
 * Numbers in `text` that appear in none of the `sources`.
 * @param {string} text
 * @param {string[]} sources
 * @returns {string[]} Distinct unsupported tokens, as written.
 */
export function unsupportedNumbers(text, sources) {
  const known = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(NUMBER_RE)) {
      const n = normaliseNumber(m[0]);
      known.add(n);
      known.add(n.replace(/[%kmx]$/, '')); // "18%" in a source supports "18" in the output
    }
  }
  const out = new Map();
  for (const m of text.matchAll(NUMBER_RE)) {
    const n = normaliseNumber(m[0]);
    const bare = n.replace(/[%kmx]$/, '');
    if (TRIVIAL.has(bare) || known.has(n) || known.has(bare)) continue;
    out.set(n, m[0].trim());
  }
  return [...out.values()];
}

/**
 * Lower-case and strip titles/punctuation so "Prof. Jane Smith" matches "Jane Smith".
 * @param {string} name
 */
export function normaliseName(name) {
  return name
    .toLowerCase()
    .replace(/\b(prof(essor)?|dr|mr|ms|mrs|sir|dame)\.?\s+/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does `name` appear (normalised) in `text`?
 * @param {string} name
 * @param {string} text
 */
export function mentions(text, name) {
  const n = normaliseName(name);
  return n.length > 2 && normaliseName(text).includes(n);
}

/**
 * Split references into verified and unverified against an allow-list.
 * @param {string[]} references   Names the draft mentions (people, labs, modules).
 * @param {string[]} verified     Names confirmed from official pages.
 */
export function checkReferences(references, verified) {
  const allowed = verified.map(normaliseName);
  const ok = [];
  const unverified = [];
  for (const ref of references) {
    const r = normaliseName(ref);
    (allowed.some((v) => v === r || v.includes(r) || r.includes(v)) ? ok : unverified).push(ref);
  }
  return { ok, unverified };
}

/** @param {string} text */
function words(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Share of `revised` that is new relative to `original`, 0–1, from the
 * word-level longest common subsequence. 0.3 means about 30% rewritten.
 * @param {string} original
 * @param {string} revised
 */
export function changeRatio(original, revised) {
  const a = words(original);
  const b = words(revised);
  if (!b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let curr = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return Math.round((1 - prev[b.length] / b.length) * 100) / 100;
}

/**
 * Jaccard similarity of word n-grams; used to keep LORs from sounding alike.
 * @param {string} a
 * @param {string} b
 * @param {number} [n=4]
 */
export function ngramOverlap(a, b, n = 4) {
  const grams = (t) => {
    const w = words(t);
    const s = new Set();
    for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' '));
    return s;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return Math.round((shared / (ga.size + gb.size - shared)) * 1000) / 1000;
}

/** @param {string} text */
export function countWords(text) {
  return text.replace(/[#>*_`|-]/g, ' ').split(/\s+/).filter(Boolean).length;
}
