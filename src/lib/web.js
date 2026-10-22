/**
 * @file Fetch a programme page from this machine and reduce it to plain text.
 *
 * Pages are fetched locally rather than by the model, so you see exactly
 * what the agents read and nothing leaves your machine besides the text.
 */

/** Roughly 50k tokens. Longer pages are cut and the cut is reported. */
const MAX_CHARS = 200_000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', ndash: '–', mdash: '—' };

/**
 * Convert HTML to readable text, keeping headings, list items and table
 * cells on their own lines so requirements tables survive.
 * @param {string} html
 */
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ url: string, title: string | null, text: string, truncated: boolean }>}
 */
export async function fetchPageText(url, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'user-agent': 'study-ops/0.6 (+https://github.com/Sharathanabattula/study-ops)', accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`Could not fetch ${url}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Fetching ${url} returned HTTP ${res.status}.`);

  const html = await res.text();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const full = htmlToText(html);
  if (full.length < 200) {
    throw new Error(`${url} returned almost no readable text. It may need JavaScript to render. Try the programme's printable or PDF page.`);
  }
  const truncated = full.length > MAX_CHARS;
  return { url: res.url || url, title, text: truncated ? full.slice(0, MAX_CHARS) : full, truncated };
}
