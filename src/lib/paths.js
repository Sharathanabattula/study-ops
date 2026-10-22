/**
 * @file Canonical filesystem locations for Study-Ops.
 *
 * Everything is local-first: user state lives in `data/` (git-ignored), shipped
 * defaults live in `templates/` and `config/`. Set `STUDY_OPS_HOME` to keep
 * your data somewhere else (e.g. an encrypted volume).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the installed package root. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Workspace root that holds `data/`, `reports/` and `outputs/`. */
export const HOME = process.env.STUDY_OPS_HOME
  ? path.resolve(process.env.STUDY_OPS_HOME)
  : PACKAGE_ROOT;

export const PATHS = Object.freeze({
  data: path.join(HOME, 'data'),
  profile: path.join(HOME, 'data', 'student_profile.md'),
  tracker: path.join(HOME, 'data', 'tracker.yaml'),
  personalStatement: path.join(HOME, 'data', 'personal_statement.md'),
  outcomes: path.join(HOME, 'data', 'outcomes.yaml'),
  sopInterview: path.join(HOME, 'data', 'sop_interview.md'),
  masterRaw: path.join(HOME, 'data', 'master_sop_raw.md'),
  eliteFramework: path.join(HOME, 'data', 'templates', 'elite_sop_framework.md'),
  recommenders: path.join(HOME, 'data', 'recommenders.yaml'),
  resume: path.join(HOME, 'data', 'resume.md'),
  applicant: path.join(HOME, 'data', 'applicant.yaml'),
  finance: path.join(HOME, 'data', 'finance.yaml'),
  visa: path.join(HOME, 'data', 'visa.yaml'),
  formMappings: path.join(HOME, 'data', 'forms'),
  browserProfiles: path.join(HOME, 'data', 'browser'),
  reports: path.join(HOME, 'reports'),
  sopOutput: path.join(HOME, 'outputs', 'sops'),
  lorOutput: path.join(HOME, 'outputs', 'lor'),
  cvOutput: path.join(HOME, 'outputs', 'cv'),
  formsOutput: path.join(HOME, 'outputs', 'forms'),
  interviewOutput: path.join(HOME, 'outputs', 'interview'),
  financeOutput: path.join(HOME, 'outputs', 'finance'),
  visaOutput: path.join(HOME, 'outputs', 'visa'),
  arrivalOutput: path.join(HOME, 'outputs', 'arrival'),
  templates: path.join(PACKAGE_ROOT, 'templates'),
  config: path.join(PACKAGE_ROOT, 'config'),
  ukviRules: path.join(PACKAGE_ROOT, 'config', 'ukvi_rules.yaml'),
  universities: path.join(PACKAGE_ROOT, 'config', 'uk_universities.yaml'),
  portals: path.join(PACKAGE_ROOT, 'config', 'portals.yaml'),
  scholarships: path.join(PACKAGE_ROOT, 'config', 'scholarships.yaml'),
  lenders: path.join(PACKAGE_ROOT, 'config', 'lenders.yaml'),
});
