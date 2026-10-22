/**
 * @file Agent 18: Bank Statement Auditor (the 28-day rule, on real statements).
 *
 * Reads CSV exports from net banking (SBI, HDFC, ICICI, Axis… column names
 * vary), rebuilds the closing balance for every calendar day, adds up
 * accounts, and proves or disproves an unbroken 28-day run at or above the
 * required amount ending within 31 days of the visa application.
 *
 * Bank statements only list days with transactions. A day with no rows keeps
 * the previous day's closing balance, so balances are carried forward. Not
 * doing this is the most common way spreadsheets get the 28-day rule wrong.
 *
 * Also flags:
 *  - every day the total dips below the requirement, with the amount;
 *  - large credits inside the window (a lump sum just before applying invites
 *    questions about where the money came from);
 *  - statements that end too early to cover the window.
 *
 * Deterministic. Statements never leave the machine.
 */
import fs from 'node:fs/promises';
import { checkBalanceHistory, loadUkviRules, parseDate, toIsoDate } from './3_ukvi_compliance_engine.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Parse a statement date in common Indian bank formats.
 * @param {string} s  "14/05/2026", "14-05-26", "14 May 2026", "14-May-2026", "2026-05-14"
 * @returns {string|null} YYYY-MM-DD
 */
export function parseBankDate(s) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = t.match(/^(\d{1,2})[\s-]([A-Za-z]{3,4})[a-z]*[\s,.-]*(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** "1,23,456.78 Cr" → 123456.78; "Dr" or a leading minus is negative. */
export function parseAmount(s) {
  const t = String(s ?? '').trim();
  if (!t || t === '-') return null;
  const neg = /dr\b/i.test(t) || /^-/.test(t) || /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && /\d/.test(t) ? (neg ? -n : n) : null;
}

/** Minimal CSV split that respects quotes. */
function splitCsv(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === delim && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * Parse a statement CSV into rows. Finds the header row (banks put account
 * details above it) and the date/balance/credit columns by name.
 * @param {string} text
 * @returns {{ rows: Array<{ date: string, balance: number, credit: number|null }>, columns: Record<string, string> }}
 */
export function parseStatementCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const delim = [',', ';', '\t', '|'].map((d) => [d, (lines.slice(0, 40).join('\n').match(new RegExp(`\\${d}`, 'g')) ?? []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const headerIdx = lines.findIndex((l) => /date/i.test(l) && /balance/i.test(l));
  if (headerIdx === -1) throw new Error('Could not find a header row with "Date" and "Balance" columns. Export the statement as CSV from net banking.');
  const header = splitCsv(lines[headerIdx], delim).map((h) => h.toLowerCase());
  const find = (...res) => header.findIndex((h) => res.some((re) => re.test(h)));
  const dateCol = find(/^(txn|tran|transaction|value)?\s*date$/, /^date/, /date/);
  const balCol = find(/closing balance/, /^balance/, /balance/);
  const creditCol = find(/^(deposit|credit)/, /credit amount|deposit amt|cr amount/, /^cr$/);
  if (dateCol < 0 || balCol < 0) throw new Error('Date or balance column not recognised.');

  const rows = [];
  const malformed = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const cells = splitCsv(line, delim);
    // A transaction row with the wrong number of columns usually means an
    // unquoted "1,00,000". Guessing would silently corrupt balances, so stop.
    if (cells.length !== header.length && parseBankDate(cells[dateCol])) { malformed.push(line); continue; }
    const date = parseBankDate(cells[dateCol]);
    const balance = parseAmount(cells[balCol]);
    if (!date || balance === null) continue; // footer, totals, blank lines
    rows.push({ date, balance, credit: creditCol >= 0 ? parseAmount(cells[creditCol]) : null });
  }
  if (malformed.length) {
    throw new Error(`${malformed.length} row(s) have more or fewer columns than the header, e.g. "${malformed[0].slice(0, 60)}". Amounts with commas must be quoted; re-export the CSV or save it from Excel as "CSV UTF-8".`);
  }
  if (!rows.length) throw new Error('No transaction rows found.');
  return { rows, columns: { date: header[dateCol], balance: header[balCol], credit: creditCol >= 0 ? header[creditCol] : '' } };
}

/**
 * Closing balance for every calendar day from first to last row, carrying
 * the balance forward over days without transactions.
 * @param {Array<{ date: string, balance: number }>} rows  in file order
 * @returns {Map<string, number>}
 */
export function dailyBalances(rows) {
  // Statements may be newest-first; the closing balance of a day is the
  // balance after its last transaction in chronological order.
  const chronological = rows[0].date <= rows.at(-1).date ? rows : [...rows].reverse();
  const closing = new Map();
  for (const r of chronological) closing.set(r.date, r.balance);
  const days = new Map();
  let d = parseDate(chronological[0].date);
  const end = parseDate(chronological.at(-1).date);
  let last = closing.get(chronological[0].date);
  while (d <= end) {
    const iso = toIsoDate(d);
    if (closing.has(iso)) last = closing.get(iso);
    days.set(iso, last);
    d = new Date(d.getTime() + 86_400_000);
  }
  return days;
}

/**
 * Sum several accounts' daily balances. Days not covered by every account are dropped.
 * @param {Array<Map<string, number>>} accounts
 */
export function combineAccounts(accounts) {
  const out = new Map();
  for (const [date] of accounts[0]) {
    if (accounts.every((a) => a.has(date))) out.set(date, accounts.reduce((s, a) => s + a.get(date), 0));
  }
  return out;
}

/**
 * Audit statements against a requirement.
 * @param {object} input
 * @param {string[]} [input.files]            CSV paths
 * @param {string[]} [input.texts]            CSV contents (tests)
 * @param {number} input.required             in the statements' currency
 * @param {Date} input.applicationDate
 * @param {number} [input.largeCreditShare=0.3]  flag credits ≥ this share of the requirement
 * @param {any} [input.rules]
 */
export async function auditStatements({ files = [], texts, required, applicationDate, largeCreditShare = 0.3, rules }) {
  rules ??= await loadUkviRules();
  const raw = texts ?? (await Promise.all(files.map((f) => fs.readFile(f, 'utf8'))));
  if (!raw.length) throw new Error('Pass at least one statement CSV (--statements a.csv,b.csv).');
  const parsed = raw.map(parseStatementCsv);
  const daily = combineAccounts(parsed.map((p) => dailyBalances(p.rows)));
  const balances = [...daily].map(([date, balance]) => ({ date, balance }));
  const result = checkBalanceHistory({ balances, required, applicationDate, rules });

  const appIso = toIsoDate(applicationDate);
  const windowStart = toIsoDate(new Date(applicationDate.getTime() - (rules.funds_holding.max_days_end_before_application + rules.funds_holding.consecutive_days) * 86_400_000));
  const inWindow = balances.filter((b) => b.date >= windowStart && b.date <= appIso);
  const dips = inWindow.filter((b) => b.balance < required).map((b) => ({ ...b, short: Math.round((required - b.balance) * 100) / 100 }));
  const lastDate = balances.at(-1)?.date ?? null;
  const largeCredits = parsed.flatMap((p) => p.rows)
    .filter((r) => r.credit && r.credit >= required * largeCreditShare && r.date >= windowStart && r.date <= appIso);

  const notes = [];
  if (lastDate && lastDate < toIsoDate(new Date(applicationDate.getTime() - rules.funds_holding.max_days_end_before_application * 86_400_000))) {
    notes.push(`Statements end ${lastDate}, more than 31 days before ${appIso}. Download a newer statement.`);
  }
  if (largeCredits.length) notes.push(`${largeCredits.length} large credit(s) inside the window (${largeCredits.map((c) => `${c.date}: ${c.credit.toLocaleString('en-IN')}`).join(', ')}). Be ready to show where the money came from.`);
  if (parsed.length > 1) notes.push(`${parsed.length} accounts combined; days not covered by every statement were excluded.`);

  return {
    ...result,
    required,
    coverage: { from: balances[0]?.date ?? null, to: lastDate, days: balances.length },
    dips,
    largeCredits,
    notes,
    headroom: result.lowestBalance !== null ? Math.round((result.lowestBalance - required) * 100) / 100 : null,
  };
}
