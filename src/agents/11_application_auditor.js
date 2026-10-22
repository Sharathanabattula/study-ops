/**
 * @file Agent 11: Application Data Auditor ("flawless" before any portal).
 *
 * Deterministic, no LLM. It validates `data/applicant.yaml` and cross-checks
 * it with `data/student_profile.md`, catching the mistakes that bounce
 * applications or cause visa problems later:
 *
 *  - Identity: names present and passport-shaped, plausible date of birth.
 *  - Passport: number format, issue < expiry, still valid with margin for
 *    the course plus visa leave.
 *  - Contact: email and international phone format.
 *  - Education and employment: date order, most-recent-first, unexplained gaps.
 *  - English test: scores match the profile, valid at the course start.
 *  - Referees: at least two, institutional email for academic referees.
 *  - Immigration: refusals declared with details.
 *  - UCAS ID format (undergraduate only).
 */
import { loadApplicant } from '../lib/applicant.js';
import { loadProfile } from '../lib/profile.js';

const DAY = 86_400_000;
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|live|icloud|rediffmail|proton(mail)?)\./i;

/**
 * @typedef {{ level: 'error'|'warn'|'ok', field: string, message: string }} Finding
 */

/** @param {string} s */
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
/** @param {string} s */
const d = (s) => new Date(`${s}T00:00:00Z`);
/** @param {Date} a @param {Date} b */
const months = (a, b) => (b - a) / (DAY * 30.44);

/**
 * Validate applicant data. Pure function given its inputs.
 * @param {Record<string, any>} a           applicant.yaml
 * @param {Record<string, any>} [profile]   student_profile.md front-matter
 * @param {Date} [today]
 * @returns {Finding[]}
 */
export function auditApplicant(a, profile = {}, today = new Date()) {
  /** @type {Finding[]} */
  const out = [];
  const err = (field, message) => out.push({ level: 'error', field, message });
  const warn = (field, message) => out.push({ level: 'warn', field, message });
  const ok = (field, message) => out.push({ level: 'ok', field, message });

  // ── Identity ──
  const p = a.personal ?? {};
  for (const f of ['given_names', 'date_of_birth', 'nationality', 'country_of_birth']) if (!p[f]) err(`personal.${f}`, 'Required on every application.');
  if (!p.family_name) warn('personal.family_name', 'No family name. If your passport shows a single name, portals usually want it in the family-name field; follow each portal’s guidance and keep it identical everywhere.');
  for (const f of ['given_names', 'family_name']) {
    if (p[f] && /[\d@#$%^&*_=+<>]/.test(p[f])) err(`personal.${f}`, 'Contains characters a passport name cannot have.');
  }
  const fullName = profile.identity?.full_name;
  if (fullName && p.given_names && !fullName.toLowerCase().includes(String(p.given_names).split(/\s+/)[0].toLowerCase())) {
    warn('personal.given_names', `Does not match the profile name "${fullName}". Use your passport spelling everywhere.`);
  }
  if (p.date_of_birth) {
    if (!isIso(p.date_of_birth)) err('personal.date_of_birth', 'Use YYYY-MM-DD.');
    else {
      const age = months(d(p.date_of_birth), today) / 12;
      if (age < 16 || age > 70) err('personal.date_of_birth', `Gives an age of ${Math.floor(age)}. Check the year.`);
    }
  }
  if (p.sex && !/^(M|F|X)$/i.test(p.sex)) warn('personal.sex', 'Use the marker in your passport: M, F or X.');

  // ── Passport ──
  const pp = a.passport ?? {};
  if (!pp.number) err('passport.number', 'Required for international applicants and the CAS.');
  else {
    const n = String(pp.number).toUpperCase().replace(/\s+/g, '');
    const india = /india/i.test(pp.issuing_country ?? p.nationality ?? '');
    if (india && !/^[A-Z][0-9]{7}$/.test(n)) err('passport.number', 'Indian passport numbers are 1 letter + 7 digits (e.g. K1234567).');
    else if (!/^[A-Z0-9]{6,12}$/.test(n)) err('passport.number', 'Unusual format. Copy it exactly from the photo page.');
    if (n !== pp.number) warn('passport.number', `Write it as "${n}" (upper case, no spaces).`);
  }
  for (const f of ['issue_date', 'expiry_date']) if (pp[f] && !isIso(pp[f])) err(`passport.${f}`, 'Use YYYY-MM-DD.');
  if (isIso(pp.issue_date) && d(pp.issue_date) > today) err('passport.issue_date', 'Is in the future.');
  if (isIso(pp.issue_date) && isIso(pp.expiry_date) && d(pp.expiry_date) <= d(pp.issue_date)) err('passport.expiry_date', 'Is before the issue date.');
  if (!pp.expiry_date) err('passport.expiry_date', 'Required.');
  else if (isIso(pp.expiry_date)) {
    const exp = d(pp.expiry_date);
    const intake = /^\d{4}-\d{2}$/.test(profile.target?.intake ?? '') ? d(`${profile.target.intake}-01`) : null;
    if (exp <= today) err('passport.expiry_date', 'Your passport has expired. Renew it before applying.');
    else if (intake) {
      const course = profile.target?.level && /phd|dphil/i.test(profile.target.level) ? 48 : 12;
      const needed = new Date(intake);
      needed.setUTCMonth(needed.getUTCMonth() + course + 4);
      if (exp < needed) warn('passport.expiry_date', `Expires ${pp.expiry_date}, before the end of a ${course}-month course plus visa leave (~${needed.toISOString().slice(0, 7)}). Renewing first avoids updating your visa record later.`);
      else ok('passport.expiry_date', 'Valid beyond course + visa leave.');
    }
  }

  // ── Contact ──
  const c = a.contact ?? {};
  if (!c.email) err('contact.email', 'Required.');
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email)) err('contact.email', 'Not a valid email address.');
  if (!c.phone) err('contact.phone', 'Required.');
  else if (!/^\+\d{1,3}[\d\s-]{6,15}$/.test(String(c.phone).trim())) err('contact.phone', 'Use international format with country code, e.g. +91 98765 43210.');
  const addr = a.address ?? {};
  for (const f of ['line1', 'city', 'country']) if (!addr[f]) err(`address.${f}`, 'Required.');
  if (addr.postcode && /india/i.test(addr.country ?? '') && !/^\d{6}$/.test(String(addr.postcode).replace(/\s/g, ''))) warn('address.postcode', 'Indian PIN codes are 6 digits.');

  // ── Education ──
  const edu = (a.education ?? []).filter((e) => e?.institution);
  if (!edu.length) err('education', 'Add at least your most recent degree.');
  edu.forEach((e, i) => {
    const f = `education.${i}`;
    for (const k of ['qualification', 'subject', 'start_date', 'grade']) if (!e[k]) err(`${f}.${k}`, 'Required.');
    for (const k of ['start_date', 'end_date']) if (e[k] && !isIso(e[k])) err(`${f}.${k}`, 'Use YYYY-MM-DD.');
    if (isIso(e.start_date) && isIso(e.end_date) && d(e.end_date) < d(e.start_date)) err(`${f}.end_date`, 'Ends before it starts.');
    if (i > 0 && isIso(e.start_date) && isIso(edu[i - 1].start_date) && d(e.start_date) > d(edu[i - 1].start_date)) warn(f, 'List education most recent first; most portals expect that order.');
  });
  const cgpa = profile.academics?.cgpa;
  if (typeof cgpa === 'number' && edu[0]?.grade && !String(edu[0].grade).includes(String(cgpa))) {
    warn('education.0.grade', `Profile CGPA is ${cgpa}; this says "${edu[0].grade}". Use the transcript figure in both.`);
  }

  // ── Employment + gaps ──
  const jobs = (a.employment ?? []).filter((j) => j?.employer);
  jobs.forEach((j, i) => {
    const f = `employment.${i}`;
    for (const k of ['start_date', 'end_date']) if (j[k] && !isIso(j[k])) err(`${f}.${k}`, 'Use YYYY-MM-DD.');
    if (isIso(j.start_date) && isIso(j.end_date) && d(j.end_date) < d(j.start_date)) err(`${f}.end_date`, 'Ends before it starts.');
  });
  const lastStudy = edu.map((e) => e.end_date).filter(isIso).sort().at(-1);
  if (lastStudy) {
    const periods = jobs.filter((j) => isIso(j.start_date)).map((j) => [d(j.start_date), isIso(j.end_date) ? d(j.end_date) : today]).sort((x, y) => x[0] - y[0]);
    let cursor = d(lastStudy);
    for (const [s, e] of periods) {
      if (months(cursor, s) > 6) warn('employment', `About ${Math.round(months(cursor, s))} months unaccounted for from ${cursor.toISOString().slice(0, 7)}. Be ready to explain it.`);
      if (e > cursor) cursor = e;
    }
    if (months(cursor, today) > 6) warn('employment', `Nothing recorded since ${cursor.toISOString().slice(0, 7)}. Add what you've been doing.`);
  }

  // ── English test ──
  const t = a.english_test ?? {};
  const pe = profile.english ?? {};
  if (!t.test) warn('english_test.test', 'No English test recorded. Needed unless you qualify for a waiver.');
  else {
    if (t.test_date && !isIso(t.test_date)) err('english_test.test_date', 'Use YYYY-MM-DD.');
    if (!t.reference_number) warn('english_test.reference_number', 'Most portals ask for the TRF/score report number.');
    for (const k of ['overall', 'listening', 'reading', 'writing', 'speaking']) {
      const mine = k === 'overall' ? pe.overall : pe.bands?.[k];
      if (typeof t[k] === 'number' && typeof mine === 'number' && t[k] !== mine) err(`english_test.${k}`, `${t[k]} here but ${mine} in your profile. Use the score on the certificate.`);
    }
    if (isIso(t.test_date) && /^\d{4}-\d{2}$/.test(profile.target?.intake ?? '')) {
      const validTo = d(t.test_date);
      validTo.setUTCFullYear(validTo.getUTCFullYear() + 2);
      if (validTo < d(`${profile.target.intake}-01`)) warn('english_test.test_date', `Expires ${validTo.toISOString().slice(0, 10)}, before your intake. Many universities and UKVI need it valid at CAS/visa stage.`);
    }
  }

  // ── Referees ──
  const refs = (a.referees ?? []).filter((r) => r?.name);
  if (refs.length < 2) warn('referees', `${refs.length} referee(s). Most programmes ask for two.`);
  refs.forEach((r, i) => {
    if (!r.email) err(`referees.${i}.email`, 'Portals email referees directly; an address is required.');
    else if (FREE_MAIL.test(r.email)) warn(`referees.${i}.email`, 'Personal email address. Universities prefer an institutional or company address, and some reject personal ones.');
  });

  // ── Immigration ──
  const im = a.immigration ?? {};
  if (im.visa_refusals === true && !im.visa_refusal_details) err('immigration.visa_refusal_details', 'You declared a refusal; give the country, date and reason. Nondisclosure can lead to a refusal and a ban.');
  if (im.previously_studied_in_uk === true && !im.previous_uk_visas) warn('immigration.previous_uk_visas', 'Add previous UK visa details; universities check study time limits.');

  // ── UCAS ──
  const ucasId = a.ucas?.personal_id;
  if (ucasId && String(ucasId).replace(/\D/g, '').length !== 10) err('ucas.personal_id', 'UCAS Personal IDs have 10 digits.');

  if (!out.some((f) => f.level === 'error')) ok('all', 'No blocking errors.');
  return out;
}

/** Load both files and audit. */
export async function checkApplication({ today } = {}) {
  const [applicant, profile] = await Promise.all([loadApplicant(), loadProfile().catch(() => ({ facts: {} }))]);
  return auditApplicant(applicant, profile.facts, today);
}
