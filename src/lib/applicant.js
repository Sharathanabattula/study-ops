/**
 * @file Applicant data: the canonical facts behind every application form.
 *
 * `data/applicant.yaml` holds passport, contact, education, employment,
 * referee and immigration details. It is read only by code on this machine.
 * Values from it are never placed in an LLM prompt. When a form is mapped,
 * Claude sees field labels and the catalog keys below, nothing else.
 */
import fs from 'node:fs/promises';
import YAML from 'yaml';
import { PATHS } from './paths.js';
import { exists } from './files.js';

/** How many repeated blocks (education, employment, referees) forms usually offer. */
const MAX_REPEATS = 3;

/**
 * Canonical fields. `synonyms` drive the offline matcher; `kind` drives formatting.
 * `{n}` expands to education.0, education.1, …
 * @type {ReadonlyArray<{ key: string, label: string, synonyms: string[], kind?: 'date'|'phone'|'bool'|'email'|'country'|'number' }>}
 */
const BASE_CATALOG = [
  { key: 'personal.title', label: 'Title', synonyms: ['title', 'salutation', 'honorific'] },
  { key: 'personal.given_names', label: 'Given / first names', synonyms: ['first name', 'given name', 'forename', 'given names', 'first names', 'forenames'] },
  { key: 'personal.family_name', label: 'Family name / surname', synonyms: ['surname', 'family name', 'last name', 'lastname'] },
  { key: 'personal.full_name', label: 'Full name', synonyms: ['full name', 'name as in passport', 'name'] },
  { key: 'personal.preferred_name', label: 'Preferred name', synonyms: ['preferred name', 'known as', 'preferred first name'] },
  { key: 'personal.previous_names', label: 'Previous names', synonyms: ['previous name', 'former name', 'maiden name', 'other names'] },
  { key: 'personal.date_of_birth', label: 'Date of birth', synonyms: ['date of birth', 'dob', 'birth date', 'birthdate'], kind: 'date' },
  { key: 'personal.sex', label: 'Sex as in passport', synonyms: ['sex', 'legal sex', 'sex as shown on passport'] },
  { key: 'personal.country_of_birth', label: 'Country of birth', synonyms: ['country of birth', 'birth country'], kind: 'country' },
  { key: 'personal.city_of_birth', label: 'Town / city of birth', synonyms: ['place of birth', 'city of birth', 'town of birth'] },
  { key: 'personal.nationality', label: 'Nationality', synonyms: ['nationality', 'citizenship', 'country of nationality'], kind: 'country' },
  { key: 'personal.second_nationality', label: 'Second nationality', synonyms: ['second nationality', 'dual nationality', 'other nationality'], kind: 'country' },
  { key: 'passport.number', label: 'Passport number', synonyms: ['passport number', 'passport no', 'travel document number'] },
  { key: 'passport.issue_date', label: 'Passport issue date', synonyms: ['passport issue date', 'date of issue', 'issue date'], kind: 'date' },
  { key: 'passport.expiry_date', label: 'Passport expiry date', synonyms: ['passport expiry', 'expiry date', 'date of expiry', 'expiration date', 'valid until'], kind: 'date' },
  { key: 'passport.issuing_country', label: 'Passport issuing country', synonyms: ['issuing country', 'country of issue', 'issuing authority'], kind: 'country' },
  { key: 'passport.place_of_issue', label: 'Passport place of issue', synonyms: ['place of issue'] },
  { key: 'contact.email', label: 'Email address', synonyms: ['email', 'e-mail', 'email address'], kind: 'email' },
  { key: 'contact.phone', label: 'Phone / mobile number', synonyms: ['phone', 'mobile', 'telephone', 'contact number', 'mobile number', 'phone number'], kind: 'phone' },
  { key: 'contact.alternate_phone', label: 'Alternative phone', synonyms: ['alternative phone', 'secondary phone', 'other phone', 'home phone'], kind: 'phone' },
  { key: 'address.line1', label: 'Address line 1', synonyms: ['address line 1', 'address 1', 'street address', 'house number and street', 'address'] },
  { key: 'address.line2', label: 'Address line 2', synonyms: ['address line 2', 'address 2', 'locality'] },
  { key: 'address.city', label: 'Town / city', synonyms: ['city', 'town', 'town/city', 'city/town'] },
  { key: 'address.state', label: 'State / county / region', synonyms: ['state', 'county', 'province', 'region'] },
  { key: 'address.postcode', label: 'Postcode / PIN', synonyms: ['postcode', 'postal code', 'zip', 'pin code', 'zip code'] },
  { key: 'address.country', label: 'Country of residence', synonyms: ['country', 'country of residence', 'country of domicile', 'domicile'], kind: 'country' },
  { key: 'correspondence_address_same', label: 'Correspondence address same as home', synonyms: ['correspondence address same', 'same as permanent address', 'postal address same'], kind: 'bool' },
  { key: 'emergency_contact.name', label: 'Emergency contact name', synonyms: ['emergency contact name', 'next of kin name'] },
  { key: 'emergency_contact.relationship', label: 'Emergency contact relationship', synonyms: ['emergency contact relationship', 'next of kin relationship'] },
  { key: 'emergency_contact.phone', label: 'Emergency contact phone', synonyms: ['emergency contact phone', 'emergency contact number', 'next of kin phone'], kind: 'phone' },
  { key: 'emergency_contact.email', label: 'Emergency contact email', synonyms: ['emergency contact email', 'next of kin email'], kind: 'email' },
  { key: 'education.{n}.institution', label: 'Institution', synonyms: ['institution', 'university', 'college', 'school name', 'institution name'] },
  { key: 'education.{n}.country', label: 'Country of study', synonyms: ['country of study', 'country of institution'], kind: 'country' },
  { key: 'education.{n}.qualification', label: 'Qualification / degree', synonyms: ['qualification', 'degree', 'award', 'qualification title', 'degree title'] },
  { key: 'education.{n}.subject', label: 'Subject / major', synonyms: ['subject', 'major', 'course studied', 'discipline', 'field of study'] },
  { key: 'education.{n}.start_date', label: 'Education start date', synonyms: ['start date', 'from', 'date started'], kind: 'date' },
  { key: 'education.{n}.end_date', label: 'Education end date', synonyms: ['end date', 'to', 'date completed', 'completion date', 'graduation date'], kind: 'date' },
  { key: 'education.{n}.grade', label: 'Grade / result', synonyms: ['grade', 'result', 'cgpa', 'gpa', 'percentage', 'final mark', 'overall result', 'classification'] },
  { key: 'education.{n}.grading_scale', label: 'Grading scale', synonyms: ['grading scale', 'grading system', 'out of', 'maximum grade'] },
  { key: 'education.{n}.language_of_instruction', label: 'Language of instruction', synonyms: ['language of instruction', 'medium of instruction', 'language taught in'] },
  { key: 'education.{n}.completed', label: 'Qualification completed', synonyms: ['completed', 'have you completed', 'awarded'], kind: 'bool' },
  { key: 'english_test.test', label: 'English test taken', synonyms: ['english test', 'english language test', 'test type', 'english qualification'] },
  { key: 'english_test.test_date', label: 'English test date', synonyms: ['test date', 'date of test', 'date taken'], kind: 'date' },
  { key: 'english_test.reference_number', label: 'English test reference / TRF', synonyms: ['trf', 'test report form', 'candidate number', 'score report', 'reference number'] },
  { key: 'english_test.overall', label: 'English overall score', synonyms: ['overall score', 'overall band', 'overall'], kind: 'number' },
  { key: 'english_test.listening', label: 'Listening score', synonyms: ['listening'], kind: 'number' },
  { key: 'english_test.reading', label: 'Reading score', synonyms: ['reading'], kind: 'number' },
  { key: 'english_test.writing', label: 'Writing score', synonyms: ['writing'], kind: 'number' },
  { key: 'english_test.speaking', label: 'Speaking score', synonyms: ['speaking'], kind: 'number' },
  { key: 'employment.{n}.employer', label: 'Employer', synonyms: ['employer', 'company', 'organisation', 'organization', 'employer name'] },
  { key: 'employment.{n}.job_title', label: 'Job title', synonyms: ['job title', 'position', 'role', 'designation'] },
  { key: 'employment.{n}.start_date', label: 'Employment start date', synonyms: ['start date', 'from'], kind: 'date' },
  { key: 'employment.{n}.end_date', label: 'Employment end date', synonyms: ['end date', 'to'], kind: 'date' },
  { key: 'employment.{n}.duties', label: 'Duties / responsibilities', synonyms: ['duties', 'responsibilities', 'description of role', 'main duties'] },
  { key: 'referees.{n}.name', label: 'Referee name', synonyms: ['referee name', 'name of referee', 'recommender name'] },
  { key: 'referees.{n}.title', label: 'Referee position / title', synonyms: ['referee position', 'referee title', 'referee job title'] },
  { key: 'referees.{n}.organisation', label: 'Referee organisation', synonyms: ['referee institution', 'referee organisation', 'referee organization'] },
  { key: 'referees.{n}.email', label: 'Referee email', synonyms: ['referee email', 'recommender email'], kind: 'email' },
  { key: 'referees.{n}.phone', label: 'Referee phone', synonyms: ['referee phone', 'referee telephone'], kind: 'phone' },
  { key: 'referees.{n}.relationship', label: 'Relationship to referee', synonyms: ['relationship to referee', 'how does the referee know you', 'capacity'] },
  { key: 'immigration.requires_visa', label: 'Requires a visa to study in the UK', synonyms: ['require a visa', 'need a visa', 'student visa required', 'require a student visa'], kind: 'bool' },
  { key: 'immigration.previously_studied_in_uk', label: 'Previously studied in the UK', synonyms: ['previously studied in the uk', 'studied in the uk before'], kind: 'bool' },
  { key: 'immigration.previous_uk_visas', label: 'Previous UK visas', synonyms: ['previous uk visa', 'previous visas', 'visa history'] },
  { key: 'immigration.visa_refusals', label: 'Ever refused a visa', synonyms: ['refused a visa', 'visa refusal', 'been refused'], kind: 'bool' },
  { key: 'immigration.visa_refusal_details', label: 'Visa refusal details', synonyms: ['refusal details', 'details of refusal'] },
  { key: 'funding.source', label: 'Source of funding', synonyms: ['source of funding', 'how will you fund', 'funding', 'fee payer'] },
  { key: 'funding.sponsor_name', label: 'Sponsor name', synonyms: ['sponsor name', 'sponsor'] },
  { key: 'ucas.personal_id', label: 'UCAS personal ID', synonyms: ['ucas personal id', 'ucas id', 'ucas number'] },
];

/** Expanded catalog with repeated blocks: education.0…, employment.0… */
export const CATALOG = Object.freeze(BASE_CATALOG.flatMap((f) => (f.key.includes('{n}')
  ? Array.from({ length: MAX_REPEATS }, (_, n) => ({ ...f, key: f.key.replace('{n}', String(n)), label: `${f.label} (#${n + 1})` }))
  : [f])));

export const CATALOG_KEYS = Object.freeze(CATALOG.map((f) => f.key));

/**
 * Fields Study-Ops never fills, whatever they map to: legal declarations,
 * sensitive monitoring questions, credentials and consent. The applicant
 * answers these personally.
 */
export const PROTECTED_PATTERNS = Object.freeze([
  /criminal|conviction|offen[cs]e|cautions?\b/i,
  /disab|health condition|medical|special (educational )?needs|adjustments/i,
  /declar|i confirm|i certify|i agree|i understand|consent|terms and conditions|privacy (notice|policy)|true and complete/i,
  /password|passcode|captcha|security (question|answer)|memorable/i,
  /signature|sign here/i,
  /ethnic|religio|belief|sexual orientation|gender identity|trans\b|care leaver|estranged/i,
  /marketing|newsletter|contact me about/i,
]);

/**
 * @typedef {object} FieldDescriptor  What the browser extracts. Never contains a value.
 * @property {string} id         Stable handle for the field on this page.
 * @property {string} label
 * @property {string} [name]
 * @property {string} [placeholder]
 * @property {string} [section]  Nearest fieldset legend or heading.
 * @property {string} type       text | email | tel | date | number | select | radio | checkbox | textarea | password | file
 * @property {string[]} [options]
 * @property {boolean} [required]
 */

/** @param {FieldDescriptor} f */
export function isProtected(f) {
  if (f.type === 'password' || f.type === 'file') return true;
  const text = [f.label, f.name, f.placeholder, f.section].filter(Boolean).join(' ');
  return PROTECTED_PATTERNS.some((re) => re.test(text));
}

/** @returns {Promise<Record<string, any>>} */
export async function loadApplicant(file = PATHS.applicant) {
  if (!(await exists(file))) throw new Error('No data/applicant.yaml. Run `study-ops init` and fill it in exactly as on your passport.');
  return YAML.parse(await fs.readFile(file, 'utf8')) ?? {};
}

/**
 * Raw value for a catalog key (supports derived keys like personal.full_name).
 * @param {Record<string, any>} data
 * @param {string} key
 */
export function rawValue(data, key) {
  if (key === 'personal.full_name') {
    return [data.personal?.given_names, data.personal?.family_name].filter(Boolean).join(' ') || null;
  }
  const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
  return v === '' || v === undefined ? null : v;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Format a value for one specific field. Pure and deterministic.
 * @param {any} value
 * @param {{ kind?: string }} catalogEntry
 * @param {FieldDescriptor} field
 * @param {string|null} [part]   day | month | year | country_code | number
 * @returns {string|boolean|null}
 */
export function formatFor(value, catalogEntry, field, part = null) {
  if (value === null || value === undefined) return null;
  const kind = catalogEntry?.kind;

  if (kind === 'bool') {
    if (field.type === 'checkbox') return Boolean(value);
    return value ? 'Yes' : 'No';
  }

  if (kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [y, m, d] = String(value).split('-');
    if (part === 'day') return d;
    if (part === 'month') return field.type === 'select' ? MONTHS[Number(m) - 1] : m;
    if (part === 'year') return y;
    if (field.type === 'date') return `${y}-${m}-${d}`;
    const hint = `${field.placeholder ?? ''} ${field.label ?? ''}`.toLowerCase();
    if (/mm\s*\/\s*dd/.test(hint)) return `${m}/${d}/${y}`;
    if (/yyyy-mm-dd/.test(hint)) return `${y}-${m}-${d}`;
    return `${d}/${m}/${y}`; // UK default
  }

  if (kind === 'phone') {
    const s = String(value).trim();
    const m = s.match(/^(\+\d{1,3})\s*(.*)$/);
    if (part === 'country_code') return m ? m[1] : null;
    if (part === 'number') return (m ? m[2] : s).replace(/\D/g, '');
    return field.type === 'tel' || field.type === 'text' ? s.replace(/\s+/g, ' ') : s;
  }

  if (catalogEntry?.key === 'ucas.personal_id') {
    const digits = String(value).replace(/\D/g, '');
    return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : String(value);
  }

  return String(value);
}

/** Month names, for matching select options. */
export { MONTHS };
