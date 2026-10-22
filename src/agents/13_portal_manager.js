/**
 * @file Agent 13: Portal Manager.
 *
 * One view of every application portal: account status, deadlines, which
 * documents are ready and uploaded, and the single next action for each.
 * Data comes from `data/tracker.yaml` plus files Study-Ops has generated.
 *
 * Accounts are created by the student, never automatically. `portal open
 * --register` opens the registration page in the assisted browser and
 * pre-fills it; the student sets a password (in their password manager),
 * completes any CAPTCHA or email check and clicks create. Study-Ops never
 * stores passwords.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME, PATHS } from '../lib/paths.js';
import { exists, readYaml } from '../lib/files.js';
import { loadProfile } from '../lib/profile.js';
import { upsertApplication } from '../lib/tracker.js';
import { sopFileName } from './2_sop_tailor.js';
import { assistedFillSession } from './12_form_filler.js';

const DAY = 86_400_000;
const SUBMITTED = new Set(['submitted', 'interview', 'offer_conditional', 'offer_unconditional', 'rejected', 'withdrawn', 'firm_accepted', 'deposit_paid', 'cas_requested', 'cas_issued', 'visa_submitted', 'visa_granted', 'visa_refused', 'enrolled']);

/** @returns {Promise<Array<Record<string, any>>>} */
async function loadApplications() {
  if (!(await exists(PATHS.tracker))) throw new Error('No data/tracker.yaml. Run `study-ops init`.');
  return ((await readYaml(PATHS.tracker))?.applications ?? []).filter((a) => a?.id && !String(a.id).startsWith('example-'));
}

/**
 * Pure: derive the dashboard row for one application.
 * @param {Record<string, any>} app
 * @param {{ sopExists: boolean, cvExists: boolean, lorCount: number, today?: Date }} ctx
 */
export function portalRow(app, { sopExists, cvExists, lorCount, today = new Date() }) {
  const portal = app.portal ?? {};
  const docs = app.documents ?? {};
  const deadline = app.deadlines?.application;
  const daysLeft = /^\d{4}-\d{2}-\d{2}$/.test(String(deadline ?? '')) ? Math.ceil((Date.parse(`${deadline}T23:59:59Z`) - today) / DAY) : null;
  const uploads = { SOP: docs.sop_uploaded, CV: docs.cv_uploaded, passport: docs.passport_uploaded, 'English test': docs.english_test_uploaded, transcripts: docs.transcripts_uploaded };
  const missingUploads = Object.entries(uploads).filter(([, v]) => !v).map(([k]) => k);
  const submitted = SUBMITTED.has(app.status);

  let next;
  if (submitted) next = app.status === 'submitted' ? 'Wait for decision; watch your email and portal messages' : '—';
  else if (!portal.url) next = `Add the portal URL: study-ops portal set ${app.id} --url <login-page>`;
  else if (!portal.account_created) next = `Create your account: study-ops portal open ${app.id} --register`;
  else if (!sopExists) next = 'Write the SOP: study-ops generate-sop';
  else if (lorCount < 2) next = 'Brief your referees: study-ops lor';
  else if (!cvExists) next = 'Build your CV: study-ops academic-cv';
  else if (missingUploads.length) next = `Upload: ${missingUploads.join(', ')}`;
  else if (!portal.application_fee_paid) next = 'Pay the application fee (in the portal, yourself)';
  else next = 'Review every page, then submit in the portal';

  return {
    id: app.id,
    university: app.short_name || app.university,
    programme: app.programme,
    status: app.status,
    account: Boolean(portal.account_created),
    applicantId: portal.applicant_id || null,
    deadline: deadline ?? null,
    daysLeft,
    urgent: daysLeft !== null && daysLeft <= 14 && !submitted,
    docs: { sop: sopExists, cv: cvExists, lors: lorCount, uploadsMissing: missingUploads },
    next,
  };
}

/** Build the dashboard for every tracked application. */
export async function portalDashboard({ today = new Date() } = {}) {
  const apps = await loadApplications();
  const cvExists = await exists(path.join(PATHS.cvOutput, 'academic_cv.md'));
  const lorCount = (await exists(PATHS.lorOutput)) ? (await fs.readdir(PATHS.lorOutput)).filter((f) => f.endsWith('.md')).length : 0;
  const rows = [];
  for (const app of apps) {
    const sopPaths = [app.documents?.sop_version && path.join(HOME, app.documents.sop_version), path.join(PATHS.sopOutput, sopFileName(app.university ?? '')), app.short_name && path.join(PATHS.sopOutput, sopFileName(app.short_name))].filter(Boolean);
    let sopExists = false;
    for (const p of sopPaths) if (await exists(p)) { sopExists = true; break; }
    rows.push(portalRow(app, { sopExists, cvExists, lorCount, today }));
  }
  rows.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));

  // UCAS deadlines for undergraduate applicants
  let ucas = null;
  const profile = await loadProfile().catch(() => null);
  if (profile && /^(bsc|ba|beng|llb|mbbs|undergrad)/i.test(profile.facts.target?.level ?? '')) {
    const routes = await readYaml(PATHS.portals);
    const cycle = String(Number((profile.facts.target?.intake ?? '').slice(0, 4)) || '');
    const deadlines = routes.routes.undergraduate.cycles?.[cycle] ?? [];
    ucas = { ...routes.routes.undergraduate, deadlines: deadlines.map((d) => ({ ...d, daysLeft: Math.ceil((Date.parse(d.deadline) - today) / DAY) })) };
  }
  return { rows, ucas };
}

/**
 * Update portal fields for an application already in the tracker.
 * @param {string} id
 * @param {{ url?: string, registrationUrl?: string, name?: string, username?: string, applicantId?: string, accountCreated?: boolean, feePaid?: boolean, status?: string, deadline?: string, uploaded?: string[] }} changes
 */
export async function portalSet(id, changes) {
  const apps = await loadApplications();
  if (!apps.some((a) => a.id === id)) throw new Error(`No application "${id}" in data/tracker.yaml. Ids: ${apps.map((a) => a.id).join(', ') || 'none yet. Run study-ops shortlist or add one'}`);
  if (changes.password) throw new Error('Study-Ops never stores passwords. Keep them in a password manager.');
  const uploadKeys = { sop: 'sop_uploaded', cv: 'cv_uploaded', passport: 'passport_uploaded', english: 'english_test_uploaded', transcripts: 'transcripts_uploaded' };
  const docs = Object.fromEntries((changes.uploaded ?? []).map((u) => {
    const k = uploadKeys[u.toLowerCase()];
    if (!k) throw new Error(`Unknown upload "${u}". Use: ${Object.keys(uploadKeys).join(', ')}`);
    return [k, true];
  }));
  const portal = Object.fromEntries(Object.entries({
    url: changes.url, registration_url: changes.registrationUrl, name: changes.name, username: changes.username,
    applicant_id: changes.applicantId, account_created: changes.accountCreated, application_fee_paid: changes.feePaid,
  }).filter(([, v]) => v !== undefined));
  await upsertApplication({
    id,
    ...(Object.keys(portal).length ? { portal } : {}),
    ...(Object.keys(docs).length ? { documents: docs } : {}),
    ...(changes.status ? { status: changes.status } : {}),
    ...(changes.deadline ? { deadlines: { application: changes.deadline } } : {}),
  });
  return (await loadApplications()).find((a) => a.id === id);
}

/**
 * Open an application's portal in the assisted browser and fill pages on request.
 * @param {string} id
 * @param {{ register?: boolean, onReport?: Function }} [opts]
 */
export async function portalOpen(id, { register = false, onReport } = {}) {
  const app = (await loadApplications()).find((a) => a.id === id);
  if (!app) throw new Error(`No application "${id}" in data/tracker.yaml.`);
  const url = register ? app.portal?.registration_url || app.portal?.url : app.portal?.url;
  if (!url) throw new Error(`No portal URL for ${id}. Add it: study-ops portal set ${id} --url <login-page>${register ? ' --registration-url <signup-page>' : ''}`);
  await assistedFillSession(url, { onReport });
  if (register) return { hint: `When the account exists: study-ops portal set ${id} --account-created --username <email> --applicant-id <id>` };
  return {};
}

