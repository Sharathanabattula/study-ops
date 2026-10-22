#!/usr/bin/env node
/**
 * @file Study-Ops CLI entry point.
 *
 * Thin routing layer: parse flags with commander, call an agent, render the
 * result through the shared theme. No business logic lives here.
 */
import 'dotenv/config';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Command, InvalidArgumentError } from 'commander';

import { initWorkspace, printWelcome } from '../src/commands/init.js';
import { evaluateUniversity } from '../src/agents/1_university_evaluator.js';
import { generateTailoredSOP, tailorPersonalStatement } from '../src/agents/2_sop_tailor.js';
import { auditFunds, loadUkviRules, parseDate } from '../src/agents/3_ukvi_compliance_engine.js';
import { auditProfile } from '../src/agents/4_profile_auditor.js';
import { buildShortlist } from '../src/agents/5_shortlist_matrix.js';
import { budgetFit, costOfAttendance, estimateRoi } from '../src/agents/6_cost_roi_mapper.js';
import { matchSyllabus } from '../src/agents/7_syllabus_matcher.js';
import { buildMasterSop } from '../src/agents/8_master_sop.js';
import { MAX_OVERLAP, draftLors } from '../src/agents/9_lor_drafter.js';
import { buildAcademicCv } from '../src/agents/10_academic_cv.js';
import { checkApplication } from '../src/agents/11_application_auditor.js';
import { assistedFillSession, formPack } from '../src/agents/12_form_filler.js';
import { portalDashboard, portalOpen, portalSet } from '../src/agents/13_portal_manager.js';
import { TYPES as INTERVIEW_TYPES, generateInterviewBank, practiceSession } from '../src/agents/14_interview_prep.js';
import { matchScholarships } from '../src/agents/15_scholarship_matcher.js';
import { buildLoanDocket } from '../src/agents/16_loan_docket.js';
import { casReport, casSet } from '../src/agents/17_cas_tracker.js';
import { auditStatements } from '../src/agents/18_statement_auditor.js';
import { visaChecklist, visaOpen } from '../src/agents/19_visa_filing.js';
import { findAccommodation, writeArrivalChecklist } from '../src/agents/20_arrival_planner.js';
import { formatHome, getRate, toHome } from '../src/lib/fx.js';
import { readYaml } from '../src/lib/files.js';
import { PATHS } from '../src/lib/paths.js';
import { getProgramme, totalTuition, yearOneTuition } from '../src/lib/programme.js';
import { loadProfile } from '../src/lib/profile.js';
import { explainError, model } from '../src/llm/claude.js';
import { banner, color, fail, gbp, heading, note, panel, row, success, warn } from '../src/ui/theme.js';

const pkg = createRequire(import.meta.url)('../package.json');

/* ─────────────────────────────── option parsers ─────────────────────────────── */

/** @param {string} v */
const positiveNumber = (v) => {
  const n = Number(String(v).replace(/[£,_\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError('Must be a non-negative number.');
  return n;
};

/** @param {string} v */
const isoDate = (v) => {
  try {
    return parseDate(v);
  } catch (e) {
    throw new InvalidArgumentError(e.message);
  }
};

/** Print a pipeline stage as it starts. */
const progress = (stage) => note(`${color.accent('›')} ${stage}…`);

/** Wrap an action so errors render nicely instead of as stack traces. */
const run = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (raw) {
    const err = explainError(raw);
    console.log();
    fail(err.message);
    if (process.env.STUDY_OPS_DEBUG) console.error(raw);
    console.log();
    process.exitCode = 1;
  }
};

/* ────────────────────────────────── program ────────────────────────────────── */

const program = new Command()
  .name('study-ops')
  .description('Local-first AI agents for the UK study-abroad pipeline.')
  .version(pkg.version, '-v, --version')
  .configureHelp({ sortSubcommands: false, showGlobalOptions: false })
  .addHelpText('beforeAll', () => {
    banner();
    return '';
  })
  .showHelpAfterError(color.muted('(run study-ops --help for usage)'));

program
  .command('init')
  .description('Scaffold data/student_profile.md, tracker.yaml and your master statement')
  .option('-f, --force', 'overwrite existing files with fresh templates')
  .action(run(async ({ force }) => {
    printWelcome(await initWorkspace({ force }));
  }));

/* ─────────────── Phase 1 · Strategic profiling & shortlisting ─────────────── */

program
  .command('audit-profile')
  .description('Standardise your grades (UK class, US GPA), audit backlogs and English scores')
  .action(run(async () => {
    banner('Profile Auditor');
    const a = await auditProfile();
    const g = a.grades;

    heading('Academics');
    panel('grades', [
      row('Percentage', g.percentage === null ? color.err('missing') : color.bold(`${g.percentage}%`)),
      row('Method', color.muted(g.percentageSource)),
      row('UK equivalent (est.)', g.ukClassLabel ? `${color.bold(g.ukClassLabel)} ${color.muted(`tier ${g.tier}`)}` : '–'),
      ...(g.marginToNextClass !== null ? [row('To next class', `${g.marginToNextClass} points`)] : []),
      row('US GPA (reference)', g.usGpa === null ? '–' : `${g.usGpa.toFixed(1)} / 4.0 ${color.muted('WES-style, aggregate')}`),
      row('Backlogs', `${a.backlogs.active} active · ${a.backlogs.cleared} cleared ${color.muted(`(${a.backlogs.level})`)}`),
    ], { tint: color.brand });

    heading('English');
    const e = a.english;
    panel('test', [
      row('Test', e.test ?? color.err('missing')),
      row('Overall', e.overall === null ? '–' : color.bold(String(e.overall))),
      row('Bands', Object.entries(e.bands).map(([k, v]) => `${k} ${v}`).join(' · ') || '–'),
      row('UKVI B2 (5.5 each)', e.meetsUkviB2 === null ? '–' : e.meetsUkviB2 ? color.ok('meets') : color.err('below')),
      row('RG tiers met', e.tiersMet.length ? e.tiersMet.join(', ') : '–'),
      row('Valid until', e.validUntil ? `${e.validUntil}${e.validAtIntake === false ? color.err('  expires before intake') : ''}` : '–'),
    ]);

    for (const f of a.flags) (f.level === 'ok' ? success : f.level === 'risk' ? fail : warn)(f.message);
    console.log();
    note('Conversions are heuristics (config/grade_equivalence.yaml). A university’s own country table always wins.');
    console.log();
  }));

program
  .command('shortlist')
  .description('Build a Safe / Target / Reach matrix for a subject across the Russell Group')
  .requiredOption('-s, --subject <subject>', 'e.g. "Finance", "Data Science"')
  .option('-l, --level <level>', 'award level', 'MSc')
  .option('-u, --unis <keys>', 'comma-separated registry keys, e.g. lse,ucl,warwick (default: profile shortlist, else all 24)')
  .option('--urls <urls>', 'comma-separated programme URLs to classify instead of searching')
  .option('-m, --max-per-uni <n>', 'programmes per university', positiveNumber, 2)
  .option('--refresh', 'ignore cached searches and pages')
  .action(run(async (opts) => {
    banner('Shortlist Matrix');
    const split = (s) => s?.split(',').map((x) => x.trim()).filter(Boolean);
    const { rows, warnings, reportPath } = await buildShortlist({
      subject: opts.subject, level: opts.level, universities: split(opts.unis), urls: split(opts.urls),
      maxPerUniversity: opts.maxPerUni, refresh: opts.refresh, onProgress: progress,
    });
    console.log();
    const tint = { safe: color.ok, target: color.warn, reach: color.err };
    for (const cat of ['safe', 'target', 'reach']) {
      const list = rows.filter((r) => r.classification.category === cat);
      if (!list.length) continue;
      panel(`${cat.toUpperCase()} · ${list.length}`, list.map(({ programme: p, classification: c, cost, budget }) => {
        const name = `${p.universityKey?.toUpperCase() ?? p.universityName} ${p.requirements.programme_title ?? ''}`.slice(0, 44).padEnd(44);
        const margin = c.margin == null ? '   ?' : `${c.margin >= 0 ? '+' : ''}${c.margin}`.padStart(5);
        const money = cost ? gbp(cost.total).padStart(9) : '        –';
        const fit = budget?.status === 'over' ? color.err('over') : budget?.status === 'stretch' ? color.warn('stretch') : budget?.status === 'within' ? color.ok('within') : color.muted('?');
        return `${name} ${margin}  ${money}  ${fit}`;
      }), { tint: tint[cat] });
    }
    for (const w of warnings) warn(w);
    success(`Matrix saved to ${color.bold(path.relative(process.cwd(), reportPath))}`);
    note('Margin = your % minus the minimum. Cost = all-in cost of attendance.');
    console.log();
  }));

program
  .command('cost')
  .description('Total cost of attendance (tuition + living + visa + IHS) vs your budget, with ROI')
  .argument('[url]', 'programme page (reads tuition and duration from it)')
  .option('-t, --tuition <amount>', 'whole-course tuition in GBP (instead of a URL)', positiveNumber)
  .option('-d, --duration <months>', 'course length in months', positiveNumber)
  .option('-z, --zone <inner|outer|outside>', 'where you will live (inner/outer London or outside London)')
  .option('--course-start <YYYY-MM-DD>', 'course start, for the Graduate Route length', isoDate)
  .action(run(async (url, opts) => {
    banner('Cost & ROI Mapper');
    const profile = await loadProfile();
    let tuitionTotal = opts.tuition;
    let tuitionYearOne;
    let months = opts.duration;
    let zone = opts.zone;
    let title = 'Custom';
    if (url) {
      progress('Reading programme page');
      const prog = await getProgramme({ url, nationality: profile.facts.identity?.nationality });
      tuitionTotal ??= totalTuition(prog.requirements) ?? undefined;
      tuitionYearOne = yearOneTuition(prog.requirements) ?? undefined;
      months ??= prog.requirements.duration_months ?? undefined;
      zone ??= prog.ukviLocation === 'outside-london' ? 'outside' : profile.facts.target?.living_zone;
      title = `${prog.universityName} · ${prog.requirements.programme_title ?? ''}`;
      console.log();
    }
    if (tuitionTotal == null) throw new Error('Tuition unknown. Pass --tuition <amount>.');
    months ??= 12;

    const cost = await costOfAttendance({ tuitionTotal, tuitionYearOne, courseMonths: months, zone, flightsAndSetup: profile.facts.budget?.flights_and_setup_gbp ?? 0 });
    const fit = budgetFit(cost, profile.facts.budget);
    const intake = profile.facts.target?.intake;
    const courseStart = opts.courseStart ?? (/^\d{4}-\d{2}$/.test(intake ?? '') ? parseDate(`${intake}-01`) : undefined);
    const roi = await estimateRoi({ cost, career: profile.facts.career, budget: profile.facts.budget, courseStart });
    const fx = profile.facts.budget?.fx_gbp_to_home;

    heading(title);
    panel('cost of attendance', [
      ...cost.lines.map((l) => row(l.label, gbp(l.amount), 46)),
      '',
      row('TOTAL (whole course)', color.bold(gbp(cost.total)), 46),
      row('Due in year one', gbp(cost.yearOneTotal), 46),
      ...(typeof fx === 'number' ? [row(`In home currency (× ${fx})`, Math.round(cost.total * fx).toLocaleString('en-IN'), 46)] : []),
    ], { tint: color.brand });

    const fitText = { within: color.ok('Within budget'), stretch: color.warn('Stretch (≤10% over)'), over: color.err('Over budget'), unknown: color.muted('No budget set') }[fit.status];
    panel('budget', [
      row('Status', fitText, 16),
      ...(fit.limit !== null ? [row('Limit', `${gbp(fit.limit)} ${color.muted(fit.basis)}`, 16), row(fit.headroom >= 0 ? 'Headroom' : 'Shortfall', gbp(Math.abs(fit.headroom)), 16)] : []),
    ]);

    panel('ROI (pre-tax)', [
      ...(roi.graduateRouteNote ? [row('Graduate Route', roi.graduateRouteNote, 16)] : []),
      row('Annual uplift', roi.annualUpliftGbp === null ? '–' : gbp(roi.annualUpliftGbp), 16),
      row('Salary forgone', roi.forgoneSalaryGbp === null ? '–' : gbp(roi.forgoneSalaryGbp), 16),
      row('Payback', roi.paybackYears === null ? '–' : `${roi.paybackYears} years`, 16),
      row('5-year multiple', roi.fiveYearMultiple === null ? '–' : `${roi.fiveYearMultiple}×`, 16),
    ]);
    for (const n of roi.notes) note(n);
    note('Living costs: config/living_costs.yaml (defaults are the UKVI minimum; set your real estimate).');
    console.log();
  }));

program
  .command('match-syllabus')
  .description('Compare your undergraduate modules with a programme’s prerequisites')
  .argument('<url>', 'programme page URL')
  .option('--extra-url <url>', 'separate entry-requirements or module-catalogue page')
  .option('--modules-file <path>', 'free-text transcript to use instead of academics.modules')
  .option('--refresh', 're-fetch the programme page')
  .action(run(async (url, opts) => {
    banner('Syllabus Matcher');
    const r = await matchSyllabus({ url, extraUrl: opts.extraUrl, modulesFile: opts.modulesFile, refresh: opts.refresh, onProgress: progress });
    console.log();
    const icon = { met: color.ok('✓'), partial: color.warn('◐'), missing: color.err('✕'), unclear: color.muted('?') };
    const byId = new Map(r.prerequisites.map((p) => [p.id, p]));
    panel(`${r.programme.universityName} · ${r.programme.requirements.programme_title ?? ''}`, r.matches.map((m) => {
      const req = (byId.get(m.prerequisite_id)?.requirement ?? m.prerequisite_id).slice(0, 40).padEnd(40);
      return `${icon[m.status]} ${req} ${color.muted(m.matched_modules.join(', ').slice(0, 40) || '–')}`;
    }));
    const tint = { strong: color.ok, adequate: color.ok, weak: color.err }[r.overall] ?? color.warn;
    success(`Overall fit: ${tint.bold(r.overall.replace('_', ' '))} · ${r.gaps} gap(s)`);
    note(r.summary);
    for (const b of r.bridging.slice(0, 3)) warn(`${b.gap}: ${b.action}`);
    if (r.droppedModules.length) warn(`Ignored modules not in your profile: ${[...new Set(r.droppedModules)].join(', ')}`);
    success(`Report saved to ${color.bold(path.relative(process.cwd(), r.reportPath))}`);
    console.log();
  }));

/* ─────────────── Programme evaluation ─────────────── */

program
  .command('evaluate')
  .description('Score a programme against your profile (A–F, 1.0–5.0)')
  .argument('<url>', 'programme page URL')
  .action(run(async (url) => {
    banner('University Evaluator');
    const report = await evaluateUniversity({ url, onProgress: progress });
    if (report.status === 'complete') console.log();

    const uniLine = report.university
      ? `${report.university.name} ${color.muted(`· ${report.university.city} · Russell Group`)}`
      : color.warn('Not in Russell Group registry (Phase 1 is RG-only)');
    panel('target', [
      row('University', uniLine, 12),
      ...(report.requirements?.programme_title ? [row('Programme', report.requirements.programme_title, 12)] : []),
      row('URL', color.muted(report.url), 12),
    ]);

    panel('scorecard', report.dimensions.map((d) =>
      row(d.label, `${d.score?.toFixed(1) ?? color.muted('–.–')}  ${color.muted(`${Math.round(d.weight * 100)}%`)}`, 22)));

    if (report.grade) {
      const tint = { A: color.ok, B: color.ok, C: color.warn }[report.grade] ?? color.err;
      success(`Grade ${tint.bold(report.grade)} · ${report.score}/5.0 · ${report.verdict}`);
      if (report.summary) note(report.summary);
      console.log();
      for (const r of report.risks.slice(0, 3)) warn(r);
      success(`Report saved to ${color.bold(path.relative(process.cwd(), report.reportPath))}`);
      if (report.tracker === 'created' || report.tracker === 'updated') success(`Tracker ${report.tracker}: ${color.bold(report.id)}`);
    } else {
      warn('Scaffold mode: add ANTHROPIC_API_KEY to .env to enable scoring.');
    }
    if (report.missingProfileFields.length) {
      warn(`Profile gaps: ${report.missingProfileFields.map((f) => color.bold(f)).join(', ')}`);
    }
    console.log();
  }));

/* ─────────────── Phase 2 · Positioning engine (documents) ─────────────── */

program
  .command('master-sop')
  .description('Build your master statement of purpose: narrative plan, interview, draft, revise')
  .option('-w, --words <n>', 'target length', positiveNumber, 1100)
  .option('--adopt', 'make it your master in data/personal_statement.md (old one is backed up)')
  .option('--skip-interview', 'draft even if important questions are unanswered')
  .action(run(async (opts) => {
    banner('Master SOP Architect');
    const r = await buildMasterSop({ words: opts.words, adopt: opts.adopt, skipInterview: opts.skipInterview, onProgress: progress });
    console.log();
    panel('central thesis', [r.plan.central_thesis.length > 76 ? `${r.plan.central_thesis.slice(0, 75)}…` : r.plan.central_thesis], { tint: color.brand });
    if (r.status === 'needs_answers') {
      warn(`${r.questions.length} question(s) need your answers before a strong draft is possible:`);
      for (const q of r.questions.slice(0, 5)) note(`${color.accent('•')} ${q.question}`);
      success(`Answer them in ${color.bold(path.relative(process.cwd(), r.interviewPath))}, then run ${color.bold('study-ops master-sop')} again.`);
      console.log();
      return;
    }
    panel('first-draft review', Object.entries(r.critique.scores).map(([k, v]) => row(k.replace(/_/g, ' '), `${v}/5`, 18)));
    success(`Master statement (${r.wordCount} words) saved to ${color.bold(path.relative(process.cwd(), r.outputPath))}`);
    if (r.adopted) success(`Adopted as data/personal_statement.md${r.backupPath ? ` (previous saved to ${path.basename(r.backupPath)})` : ''}`);
    else note('Review it, then run with --adopt to make it your master.');
    for (const w of r.warnings) warn(w);
    console.log();
  }));

program
  .command('generate-sop')
  .description('Elite SOP: write a university-specific statement from data/master_sop_raw.md under the Elite constraints')
  .requiredOption('-u, --uni <name>', 'target university, e.g. "Imperial College London"')
  .requiredOption('-c, --course <name>', 'target course, e.g. "MSc Business Analytics"')
  .option('--prof <name>', 'professor whose research aligns with yours (Rule 3)')
  .option('--module <name>', 'module you want to take (Rule 3)')
  .option('--lab <name>', 'lab, research group or campus facility (Rule 3)')
  .option('--notes <text>', 'anything else you researched about the university')
  .option('--url <url>', 'programme page: verifies names and fills missing Rule 3 items from official pages')
  .option('--research-urls <urls>', 'comma-separated faculty or lab pages')
  .option('--find-faculty', 'search the university’s site for faculty and labs (verified)')
  .option('-w, --words <n>', 'word limit', positiveNumber)
  .option('--refresh', 're-fetch pages and specifics')
  .action(run(async (opts) => {
    banner('Elite SOP Engine');
    const r = await generateTailoredSOP(opts.uni, opts.course, {
      professor: opts.prof, module: opts.module, lab: opts.lab, notes: opts.notes, url: opts.url,
      researchUrls: opts.researchUrls?.split(',').map((s) => s.trim()).filter(Boolean), findFaculty: opts.findFaculty,
    }, { wordLimit: opts.words, refresh: opts.refresh, onProgress: progress });
    if (r.status === 'complete') console.log();

    const tag = (k) => (r.details[k] ? `${r.details[k]} ${color.muted(`(${r.detailSources[k]})`)}` : color.warn('not supplied'));
    panel(`${r.university} · ${r.course}`, [row('Module', tag('module'), 10), row('Professor', tag('professor'), 10), row('Lab', tag('lab'), 10)], { tint: color.brand });

    if (r.status === 'complete') {
      panel('elite review (first draft)', Object.entries(r.critique.scores).map(([k, v]) => row(k.replace(/_/g, ' '), `${v}/5`, 16)));
      if (r.violations.length) for (const v of r.violations) fail(v);
      else success('All Elite rule checks pass on the final text.');
      success(`${r.wordCount} words saved to ${color.bold(path.relative(process.cwd(), r.outputPath))}`);
    } else {
      success(`Prompt saved to ${color.bold(path.relative(process.cwd(), r.outputPath))}`);
      note('Scaffold mode: add ANTHROPIC_API_KEY to .env to generate the statement directly.');
    }
    for (const w of r.warnings) warn(w);
    console.log();
  }));

program
  .command('tailor-sop')
  .description('Tailor ≈30% of your master statement to one university, with verified faculty, labs and modules')
  .requiredOption('-u, --uni <name>', 'university name or key, e.g. LSE, imperial, ucl')
  .option('--url <url>', 'programme page (enables real modules and the page’s own prompts)')
  .option('--research-urls <urls>', 'comma-separated faculty or lab pages to draw names from')
  .option('--find-faculty', 'search the university’s site for relevant faculty and labs (verified)')
  .option('-p, --programme <name>', 'programme title, e.g. "MSc Finance"')
  .option('-w, --words <n>', 'word limit', positiveNumber)
  .option('--refresh', 're-fetch pages and specifics')
  .action(run(async (opts) => {
    banner('SOP Tailor (from master)');
    const result = await tailorPersonalStatement({
      university: opts.uni, programme: opts.programme, wordLimit: opts.words, url: opts.url,
      researchUrls: opts.researchUrls?.split(',').map((s) => s.trim()).filter(Boolean), findFaculty: opts.findFaculty,
      refresh: opts.refresh, onProgress: progress,
    });
    if (result.status === 'complete') console.log();
    panel(result.university, [row('Tone', result.tone.length > 70 ? `${result.tone.slice(0, 69)}…` : result.tone, 6)]);

    if (result.status === 'complete') {
      const s = result.specifics;
      panel('tailoring', [
        row('Rewritten vs master', `${Math.round(result.changeRatio * 100)}% ${color.muted('(target ≈ 30%)')}`, 20),
        row('Verified specifics', s ? `${s.modules.length} modules · ${s.people.length} faculty · ${s.labs.length} labs` : '–', 20),
        row('Final word count', String(result.wordCount), 20),
      ]);
      panel('first-draft review', Object.entries(result.critique.scores).map(([k, v]) => row(k.replace(/_/g, ' '), `${v}/5`, 20)));
      success(`Tailored statement saved to ${color.bold(path.relative(process.cwd(), result.outputPath))}`);
      note(`Drafted, critiqued and revised with ${model()}.`);
    } else {
      success(`Prompt saved to ${color.bold(path.relative(process.cwd(), result.promptPath))}`);
      note('Scaffold mode: add ANTHROPIC_API_KEY to .env to generate the statement directly.');
    }
    for (const w of result.warnings) warn(w);
    console.log();
  }));

program
  .command('lor')
  .description('Draft 2–3 distinct recommendation letters for your recommenders to edit and submit')
  .option('--only <ids>', 'comma-separated recommender ids to draft')
  .option('-p, --programme <name>', 'target programme, for the suitability paragraph')
  .action(run(async (opts) => {
    banner('LOR Drafter');
    const r = await draftLors({ only: opts.only?.split(',').map((s) => s.trim()), programme: opts.programme, onProgress: progress });
    console.log();
    panel('letters', r.letters.map((L) => {
      const worst = Math.max(0, ...L.overlaps.map((o) => o.score));
      const distinct = worst > MAX_OVERLAP ? color.warn(`overlap ${worst}`) : color.ok(`distinct ${worst}`);
      return `${L.recommender.name.slice(0, 24).padEnd(24)} ${L.plan.primary_angle.padEnd(14)} ${String(L.wordCount).padStart(4)} words  ${distinct}`;
    }), { tint: color.brand });
    for (const L of r.letters) success(`${color.bold(path.relative(process.cwd(), L.outputPath))}`);
    for (const w of r.warnings) warn(w);
    note('These are drafts for your recommenders to rewrite in their own words and submit themselves.');
    console.log();
  }));

program
  .command('academic-cv')
  .description('Convert your job-search resume into a UK academic CV')
  .option('-r, --resume <path>', 'resume file (default: data/resume.md)')
  .action(run(async (opts) => {
    banner('Academic CV');
    const r = await buildAcademicCv({ resumePath: opts.resume, onProgress: progress });
    console.log();
    const c = r.cv;
    panel(c.header.name, [
      row('Education', String(c.education.length), 22),
      row('Research experience', String(c.research_experience.length), 22),
      row('Publications', String(c.publications.length), 22),
      row('Projects', String(c.projects.length), 22),
      row('Professional', String(c.professional_experience.length), 22),
      row('Length', `${r.wordCount} words ${color.muted('(≈2 pages ≈ 900)')}`, 22),
    ], { tint: color.brand });
    if (c.removed_personal_details.length) note(`Removed for UK convention: ${c.removed_personal_details.join(', ')}`);
    if (c.quantify_prompts.length) warn(`${c.quantify_prompts.length} bullet(s) would be stronger with real numbers (listed in the file).`);
    for (const w of r.warnings) warn(w);
    success(`Saved to ${color.bold(path.relative(process.cwd(), r.outputPath))}`);
    console.log();
  }));

/* ─────────────── Phase 3 · Application execution ─────────────── */

program
  .command('check-application')
  .description('Validate data/applicant.yaml (passport, dates, contacts, scores) before any portal')
  .action(run(async () => {
    banner('Application Data Auditor');
    const findings = await checkApplication();
    const errors = findings.filter((f) => f.level === 'error');
    const warns = findings.filter((f) => f.level === 'warn');
    for (const f of errors) fail(`${color.bold(f.field)}  ${f.message}`);
    for (const f of warns) warn(`${color.bold(f.field)}  ${f.message}`);
    for (const f of findings.filter((x) => x.level === 'ok')) success(`${color.bold(f.field)}  ${f.message}`);
    console.log();
    note(`${errors.length} error(s), ${warns.length} warning(s). Fix errors before filling any portal.`);
    console.log();
    if (errors.length) process.exitCode = 1;
  }));

program
  .command('portals')
  .description('Dashboard of every application portal: accounts, deadlines, documents, next action')
  .action(run(async () => {
    banner('Portal Manager');
    const { rows, ucas } = await portalDashboard();
    if (!rows.length) {
      warn('No applications in data/tracker.yaml yet. Run study-ops shortlist, or add entries by hand.');
      console.log();
      return;
    }
    for (const r of rows) {
      const when = r.daysLeft === null ? color.muted('no deadline set') : r.daysLeft < 0 ? color.err(`deadline passed (${r.deadline})`) : (r.urgent ? color.err : color.ok)(`${r.daysLeft} days · ${r.deadline}`);
      const tick = (v) => (v ? color.ok('✓') : color.muted('·'));
      panel(`${r.university} · ${r.programme ?? ''}`.slice(0, 70), [
        row('Status', `${r.status ?? '–'}${r.applicantId ? color.muted(`  ID ${r.applicantId}`) : ''}`, 10),
        row('Deadline', when, 10),
        row('Ready', `${tick(r.account)} account  ${tick(r.docs.sop)} SOP  ${tick(r.docs.lors >= 2)} LORs (${r.docs.lors})  ${tick(r.docs.cv)} CV`, 10),
        row('Next', color.accent(r.next), 10),
      ], { tint: r.urgent ? color.err : color.brand });
    }
    if (ucas) {
      panel(ucas.name, ucas.deadlines.map((d) => row(d.label.slice(0, 44), d.daysLeft < 0 ? color.muted('passed') : `${d.daysLeft} days`, 46)));
      note(ucas.personal_statement);
    }
    console.log();
  }));

const portal = program.command('portal').description('Update or open one application’s portal');

portal
  .command('set')
  .description('Record portal details (never passwords) for an application in the tracker')
  .argument('<id>', 'application id from data/tracker.yaml')
  .option('--url <url>', 'login / application page')
  .option('--registration-url <url>', 'account-creation page')
  .option('--name <name>', 'portal name')
  .option('--username <username>', 'login username or email')
  .option('--applicant-id <id>', 'applicant/reference number from the portal')
  .option('--account-created', 'mark the account as created')
  .option('--fee-paid', 'mark the application fee as paid')
  .option('--status <status>', 'e.g. drafting, submitted, interview')
  .option('--deadline <YYYY-MM-DD>', 'application deadline')
  .option('--uploaded <items>', 'comma-separated: sop, cv, passport, english, transcripts')
  .action(run(async (id, o) => {
    banner('Portal Manager');
    const app = await portalSet(id, { ...o, uploaded: o.uploaded?.split(',').map((s) => s.trim()), feePaid: o.feePaid });
    success(`Updated ${color.bold(id)}: ${app.portal?.url ?? 'no URL'} · account ${app.portal?.account_created ? 'created' : 'not yet'}`);
    console.log();
  }));

portal
  .command('open')
  .description('Open the portal in your own browser window and fill pages on request (you submit)')
  .argument('<id>', 'application id from data/tracker.yaml')
  .option('--register', 'open the registration page to create your account')
  .action(run(async (id, o) => {
    banner('Assisted Portal Session');
    note('A browser window opens. Sign in, solve any CAPTCHA, and navigate yourself. Study-Ops fills fields; it never submits.');
    const r = await portalOpen(id, { register: o.register, onReport: printFillReport });
    if (r.hint) note(r.hint);
    console.log();
  }));

program
  .command('fill')
  .description('Open any application form and fill it from data/applicant.yaml (you review and submit)')
  .argument('<url>', 'form or portal URL')
  .option('--overwrite', 'replace values already in the form')
  .action(run(async (url, o) => {
    banner('Form Filler');
    note('Values come from data/applicant.yaml and are filled locally. Claude only sees field labels.');
    await assistedFillSession(url, { overwrite: o.overwrite, onReport: printFillReport });
    console.log();
  }));

program
  .command('form-pack')
  .description('Copy-paste sheet of every application value, UK-formatted (for portals that block autofill)')
  .option('-n, --name <name>', 'file name', 'applicant')
  .action(run(async (o) => {
    banner('Form Pack');
    const out = await formPack({ name: o.name });
    success(`Saved to ${color.bold(path.relative(process.cwd(), out))}`);
    warn('Contains passport data. Keep it local and delete it when done.');
    console.log();
  }));

program
  .command('interview')
  .description('Generate likely interview questions with answer outlines (credibility, Kira, technical…)')
  .requiredOption('-u, --uni <name>', 'university')
  .requiredOption('-c, --course <name>', 'course')
  .requiredOption('-t, --type <type>', `one of: ${Object.keys(INTERVIEW_TYPES).join(', ')}`)
  .option('--url <url>', 'programme page, for course facts and fees')
  .option('-n, --count <n>', 'number of questions', positiveNumber, 12)
  .action(run(async (o) => {
    banner('Interview Prep');
    const r = await generateInterviewBank({ university: o.uni, course: o.course, type: o.type, url: o.url, count: o.count, onProgress: progress });
    console.log();
    panel(INTERVIEW_TYPES[o.type].label, r.questions.slice(0, 8).map((q, i) => `${String(i + 1).padStart(2)}. ${q.question.length > 72 ? `${q.question.slice(0, 71)}…` : q.question}`), { tint: color.brand });
    for (const w of r.warnings) warn(w);
    success(`${r.questions.length} questions saved to ${color.bold(path.relative(process.cwd(), r.outputPath))}`);
    note(`Practise: study-ops interview-practice --uni "${o.uni}" --type ${o.type}`);
    console.log();
  }));

program
  .command('interview-practice')
  .description('Timed mock interview: answer by typing, get scored feedback')
  .requiredOption('-u, --uni <name>', 'university (as used with `interview`)')
  .requiredOption('-t, --type <type>', `one of: ${Object.keys(INTERVIEW_TYPES).join(', ')}`)
  .option('-n, --count <n>', 'questions this session', positiveNumber, 5)
  .option('--prep <seconds>', 'preparation time', positiveNumber)
  .option('--answer <seconds>', 'answer time', positiveNumber)
  .action(run(async (o) => {
    banner('Mock Interview');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const countdown = async (seconds, label) => {
      for (let s = seconds; s > 0; s--) {
        process.stdout.write(`\r  ${color.muted(`${label}: ${s}s `)}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      process.stdout.write('\r\x1b[K');
    };
    try {
      const { results, logPath } = await practiceSession({
        university: o.uni, type: o.type, count: o.count, prep: o.prep, answer: o.answer,
        io: { ask: (q) => rl.question(`  ${q}`), print: (s) => console.log(`  ${s}`), countdown },
      });
      console.log();
      success(`${results.length} answers reviewed. Log saved to ${color.bold(path.relative(process.cwd(), logPath))}`);
    } finally {
      rl.close();
    }
    console.log();
  }));

/** Print what one fill pass did. */
function printFillReport(r) {
  console.log();
  success(`Filled ${r.filled.length} field(s) ${color.muted('(blue outline)')}`);
  if (r.protectedFields.length) warn(`Answer yourself: ${r.protectedFields.map((f) => f.label).join(' · ').slice(0, 160)}`);
  for (const f of r.review.slice(0, 8)) warn(`${f.label || f.id}: ${f.reason}`);
  if (r.unmapped.length) note(`Not recognised: ${r.unmapped.map((f) => f.label || f.id).join(' · ').slice(0, 160)}`);
  note('Check every amber field and each value, then save or submit in the portal yourself.');
}

/* ─────────────── Visa ─────────────── */

program
  .command('audit-funds')
  .description('Calculate UKVI Proof of Funds and your 28-day bank statement timeline')
  .requiredOption('-l, --location <london|outside>', 'study location (inner/outer London both use the London rate)')
  .requiredOption('-d, --duration <months>', 'course length in months', positiveNumber)
  .requiredOption('-t, --tuition <amount>', 'first-year tuition in GBP (per CAS)', positiveNumber)
  .option('--deposit <amount>', 'tuition already paid to the university', positiveNumber, 0)
  .option('--balance <amount>', 'funds you currently hold, to show any shortfall', positiveNumber)
  .option('--apply-date <YYYY-MM-DD>', 'planned visa application date (default: today)', isoDate)
  .option('--course-start <YYYY-MM-DD>', 'course start date (checks the 6-month apply window)', isoDate)
  .option('--cas-issued <YYYY-MM-DD>', 'CAS issue date (checks 6-month CAS validity)', isoDate)
  .option('--fx <rate>', 'GBP→INR rate to use (default: live ECB reference rate)', positiveNumber)
  .option('--no-inr', 'skip the INR conversion')
  .option('--buffer <share>', 'extra margin for exchange-rate moves, e.g. 0.05 = 5%', Number)
  .option('--statements <files>', 'comma-separated bank statement CSVs to audit against the 28-day rule')
  .option('--statement-currency <code>', 'currency of the statements', 'INR')
  .action(run(async (opts) => {
    banner('UKVI Compliance Engine');
    const audit = await auditFunds({
      location: opts.location,
      durationMonths: opts.duration,
      tuition: opts.tuition,
      deposit: opts.deposit,
      balance: opts.balance,
      applicationDate: opts.applyDate,
      courseStart: opts.courseStart,
      casIssuedOn: opts.casIssued,
    });
    const { funds, timeline, position } = audit;
    const where = funds.location === 'london' ? 'London' : 'Outside London';

    heading('Proof of Funds');
    panel('breakdown', [
      row('Tuition (year one)', gbp(funds.tuitionFirstYear)),
      row('Less deposit paid', `− ${gbp(funds.tuitionPaid)}`),
      row('Tuition outstanding', color.bold(gbp(funds.tuitionOutstanding))),
      '',
      row('Living costs', `${gbp(funds.monthlyRate)}/mo × ${funds.monthsCounted} ${color.muted(`(${where}, max 9)`)}`),
      row('Maintenance', color.bold(gbp(funds.maintenance))),
      '',
      row('TOTAL TO SHOW', color.ok.bold(gbp(funds.total))),
      ...(position
        ? [row('You hold', gbp(position.balance)),
           row('Shortfall', position.shortfall ? color.err.bold(gbp(position.shortfall)) : color.ok('None'))]
        : []),
    ], { tint: color.brand });

    heading('28-day timeline');
    panel('bank statement', [
      row('Visa application', color.bold(timeline.applicationDate)),
      row('Funds in place by', `${color.bold(timeline.holdMustStartBy)} ${color.muted('at the latest')}`),
      row('Statement end date', `${timeline.statementEndEarliest} → ${timeline.statementEndLatest}`),
      ...(timeline.earliestApplyDate ? [row('Earliest you can apply', timeline.earliestApplyDate)] : []),
      ...(timeline.casExpiresOn ? [row('CAS expires', timeline.casExpiresOn)] : []),
      '',
      color.muted('Balance must never dip below the total on any of the 28 days.'),
    ]);

    // ── INR conversion (UKVI converts with OANDA on the application date) ──
    let rate = null;
    if (opts.inr !== false) {
      try {
        rate = await getRate({ override: opts.fx });
        const rules = await loadUkviRules();
        const buffer = opts.buffer ?? rules.fx.default_buffer;
        heading('In Indian rupees');
        panel('proof of funds (INR)', [
          row('Exchange rate', `£1 = ₹${rate.rate} ${color.muted(`${rate.source}, ${rate.date}`)}`),
          row('Exact requirement', formatHome(toHome(funds.total, rate.rate, 0, 1))),
          row(`With ${Math.round(buffer * 100)}% FX buffer`, color.ok.bold(formatHome(toHome(funds.total, rate.rate, buffer)))),
          '',
          color.muted('UKVI converts with OANDA’s rate on the day you submit, so hold the buffered amount.'),
        ], { tint: color.brand });
      } catch (err) {
        warn(err.message);
      }
    }

    // ── 28-day audit on real statements ──
    if (opts.statements) {
      const inGbp = opts.statementCurrency.toUpperCase() === 'GBP';
      if (!inGbp && !rate) throw new Error('Statements are in INR but no exchange rate is available. Pass --fx.');
      const required = inGbp ? funds.total : funds.total * rate.rate;
      const res = await auditStatements({ files: opts.statements.split(',').map((f) => f.trim()), required, applicationDate: opts.applyDate ?? new Date() });
      heading('28-day statement audit');
      const fmt = (n) => `${n < 0 ? '−' : ''}${inGbp ? gbp(Math.abs(n)) : formatHome(Math.abs(n))}`;
      panel(res.compliant ? 'PASS' : 'FAIL', [
        row('Required (exact)', fmt(required)),
        row('Coverage', `${res.coverage.from} → ${res.coverage.to} (${res.coverage.days} days)`),
        row('Result', res.compliant ? color.ok(`${res.window.start} → ${res.window.end}`) : color.err(res.reason)),
        row('Lowest balance', res.lowestBalance === null ? '–' : `${fmt(res.lowestBalance)} ${res.headroom >= 0 ? color.ok(`(+${fmt(res.headroom)} spare)`) : color.err(`(${fmt(res.headroom)} short)`)}`),
        row('Days below', res.dips.length ? color.err(`${res.dips.length}: ${res.dips.slice(0, 3).map((d) => d.date).join(', ')}${res.dips.length > 3 ? '…' : ''}`) : color.ok('none')),
      ], { tint: res.compliant ? color.ok : color.err });
      for (const n of res.notes) warn(n);
    }

    for (const w of audit.warnings) warn(w);
    console.log();
    note(`Rules: config/ukvi_rules.yaml · verify at ${audit.source}`);
    note('Decision support only, not immigration advice.');
    console.log();
  }));


/* ─────────────── Phase 4 · Financial engineering & scholarships ─────────────── */

program
  .command('scholarships')
  .description('Match external schemes (Chevening, GREAT, Commonwealth) and verified university awards')
  .option('-u, --unis <keys>', 'registry keys to search for university awards (default: tracked applications)')
  .option('--no-internal', 'external schemes only (no web search)')
  .option('--months <n>', 'course length in months', positiveNumber)
  .option('--refresh', 'ignore cached university searches')
  .action(run(async (o) => {
    banner('Scholarship Matcher');
    const r = await matchScholarships({ universities: o.unis?.split(',').map((s) => s.trim()), internal: o.internal, courseMonths: o.months, refresh: o.refresh, onProgress: progress });
    console.log();
    const tint = { eligible: color.ok, check: color.warn, ineligible: color.err };
    for (const m of r.external) {
      const w = m.window;
      const when = w.status === 'open' ? color.ok(`open · closes ${w.closes}${w.daysLeft != null ? ` (${w.daysLeft} days)` : ''}`) : w.status === 'closed' ? color.err(`closed for ${w.cycle}`) : color.muted(`${w.cycle ?? ''} not announced`);
      panel(`${m.name} · ${m.eligibility.toUpperCase()}`, [
        row('Window', when, 10),
        ...m.rules.filter((x) => x.status !== 'pass').slice(0, 4).map((x) => row(x.status === 'fail' ? '✕' : '?', `${x.rule}: ${x.detail}`.slice(0, 80), 10)),
        ...(w.note ? [color.muted(w.note.slice(0, 90))] : []),
      ], { tint: tint[m.eligibility] });
    }
    for (const u of r.internal) success(`${u.university}: ${u.awards.length} verified award(s)${u.dropped?.length ? color.muted(` · ${u.dropped.length} unconfirmed dropped`) : ''}`);
    for (const w of r.warnings) warn(w);
    success(`Report saved to ${color.bold(path.relative(process.cwd(), r.reportPath))}`);
    console.log();
  }));

program
  .command('loan-docket')
  .description('Funding plan + the exact document docket for Credila, SBI or Prodigy Finance')
  .requiredOption('-l, --lender <id>', 'credila | sbi | prodigy')
  .option('--app <id>', 'tracker application (uses its tuition)')
  .option('-t, --tuition <amount>', 'whole-course tuition in GBP', positiveNumber)
  .option('-d, --duration <months>', 'course length in months', positiveNumber, 12)
  .option('-z, --zone <inner|outer|outside>', 'where you will live')
  .option('--fx <rate>', 'GBP→INR rate (default: data/finance.yaml, else live)', positiveNumber)
  .action(run(async (o) => {
    banner('Loan Docket');
    let tuition = o.tuition;
    if (tuition == null && o.app) {
      const tracker = await readYaml(PATHS.tracker);
      tuition = tracker.applications?.find((a) => a.id === o.app)?.fees?.tuition_year_one ?? undefined;
      if (tuition == null) throw new Error(`No tuition recorded for ${o.app}. Pass --tuition.`);
    }
    const r = await buildLoanDocket({ lender: o.lender, tuitionTotal: tuition, courseMonths: o.duration, zone: o.zone, fx: o.fx });
    console.log();
    panel(r.lender.name, [
      row('Cost of attendance', `${gbp(r.plan.costTotal)}  ${color.muted(formatHome(toHome(r.plan.costTotal, r.rate.rate, 0, 1)))}`, 20),
      row('Own funds + awards', `− ${gbp(r.plan.own + r.plan.scholarships)}`, 20),
      row('Loan needed', color.bold(`${gbp(r.plan.gap)}  ${formatHome(toHome(r.plan.gap, r.rate.rate, 0, 1))}`), 20),
      row('Documents ready', `${r.docket.total - r.docket.missing.length}/${r.docket.total}`, 20),
    ], { tint: color.brand });
    if (r.docket.missing.length) warn(`Still to collect: ${r.docket.missing.slice(0, 6).map((d) => d.label.split(' (')[0]).join(' · ')}${r.docket.missing.length > 6 ? '…' : ''}`);
    for (const c of r.letter.filter((x) => x.ok === false)) fail(c.message);
    success(`Docket saved to ${color.bold(path.relative(process.cwd(), r.outputPath))}`);
    note('Typical list; confirm the final checklist with your loan officer.');
    console.log();
  }));

/* ─────────────── Phase 5 · UKVI visa compliance ─────────────── */

const casCmd = program.command('cas').description('CAS tracking: every gate between your offer and your CAS');

casCmd
  .command('status')
  .description('Show CAS gates, dates and the next action for an application')
  .argument('<id>', 'application id from data/tracker.yaml')
  .action(run(async (id) => {
    banner('CAS Tracker');
    printCas(await casReport(id));
  }));

casCmd
  .command('set')
  .description('Record CAS progress for an application')
  .argument('<id>', 'application id')
  .option('--offer-type <type>', 'conditional | unconditional')
  .option('--condition <text>', 'add an offer condition')
  .option('--condition-met <text>', 'mark a condition as met')
  .option('--firm <YYYY-MM-DD>', 'date you firmly accepted')
  .option('--deposit-amount <gbp>', 'deposit required', positiveNumber)
  .option('--deposit-paid <gbp>', 'deposit paid so far', positiveNumber)
  .option('--atas-required <yes|no>', 'whether the course needs ATAS')
  .option('--atas-applied <YYYY-MM-DD>')
  .option('--atas-issued <YYYY-MM-DD>')
  .option('--pre-cas-docs', 'pre-CAS documents uploaded')
  .option('--finance-check', 'university finance check passed')
  .option('--interview <YYYY-MM-DD>', 'credibility interview date')
  .option('--interview-passed', 'credibility interview passed')
  .option('--cas-requested <YYYY-MM-DD>')
  .option('--cas-issued <YYYY-MM-DD>')
  .option('--cas-number <ref>')
  .option('--course-start <YYYY-MM-DD>')
  .option('--course-end <YYYY-MM-DD>')
  .action(run(async (id, o) => {
    banner('CAS Tracker');
    printCas(await casSet(id, o));
  }));

function printCas(r) {
  const icon = { done: color.ok('✓'), pending: color.warn('◐'), todo: color.err('✕'), check: color.muted('?'), 'n/a': color.muted('–') };
  panel(`${r.app.short_name ?? r.app.university ?? r.app.id} · ${r.app.programme ?? ''}`.slice(0, 70), r.gates.map((g) => `${icon[g.status]} ${g.label.padEnd(26)} ${color.muted(g.detail.slice(0, 60))}`), { tint: color.brand });
  const d = r.dates;
  if (Object.keys(d).length) {
    panel('dates', [
      ...(d.atasExpected ? [row('ATAS expected ≈', d.atasExpected, 24)] : []),
      ...(d.casExpires ? [row('CAS expires', d.casExpires, 24)] : []),
      ...(d.earliestVisaApplication ? [row('Earliest visa application', d.earliestVisaApplication, 24)] : []),
      ...(d.tbValidUntil ? [row('TB certificate valid until', d.tbValidUntil, 24)] : []),
    ]);
  }
  for (const w of r.warnings) warn(w);
  success(`Next: ${color.bold(r.next)}`);
  console.log();
}

const visaCmd = program.command('visa').description('Student visa filing: checklist, fees, dates, assisted application');

visaCmd
  .command('checklist')
  .description('Documents, fees (incl. IHS), dates and steps for your visa application')
  .argument('[id]', 'application id (default: application_for in data/visa.yaml)')
  .action(run(async (id) => {
    banner('Visa Filing');
    const r = await visaChecklist({ id });
    const tick = (ok) => (ok === true ? color.ok('✓') : ok === false ? color.err('✕') : color.muted('?'));
    panel('fees', [
      row('Application fee', gbp(r.fees.application), 30),
      row(`Health surcharge (${r.fees.visaMonths}-mo visa)`, gbp(r.fees.ihs), 30),
      row('Total, paid in the application', color.bold(gbp(r.fees.total)), 30),
    ], { tint: color.brand });
    panel('documents', r.docs.map((d) => `${tick(d.ok)} ${d.item.slice(0, 84)}`));
    if (r.timeline.length) panel('dates', r.timeline.map((t) => `${tick(t.ok)} ${t.label.slice(0, 60).padEnd(60)} ${t.date}`));
    for (const b of r.blocking) fail(b);
    success(`Filing pack saved to ${color.bold(path.relative(process.cwd(), r.outputPath))}`);
    note('Not immigration advice. Ask your university’s advisers or an IAA-regulated adviser about your case.');
    console.log();
  }));

visaCmd
  .command('open')
  .description('Open the official gov.uk application in your browser; Study-Ops fills, you answer and submit')
  .action(run(async () => {
    banner('Assisted Visa Application');
    note('Immigration history and declarations are always left for you to answer.');
    await visaOpen({ onReport: printFillReport });
    console.log();
  }));

/* ─────────────── Phase 6 · Post-arrival landing ─────────────── */

program
  .command('housing')
  .description('Find verified university halls and PBSA near your campus, priced against your budget')
  .requiredOption('-u, --uni <name>', 'university')
  .option('--campus <name>', 'campus, e.g. "Mile End", "South Kensington"')
  .option('--max-weekly <gbp>', 'weekly rent ceiling', positiveNumber)
  .action(run(async (o) => {
    banner('Accommodation');
    const r = await findAccommodation({ university: o.uni, campus: o.campus, maxWeekly: o.maxWeekly, onProgress: progress });
    console.log();
    panel(`${r.listings.length} verified options`, r.listings.slice(0, 10).map((l) => `${l.name.slice(0, 34).padEnd(34)} ${(l.weekly_price ?? 'see page').slice(0, 22).padEnd(22)} ${color.muted((l.distance_or_travel ?? '').slice(0, 26))}`), { tint: color.brand });
    if (r.dropped.length) note(`${r.dropped.length} unconfirmed listing(s) left out.`);
    success(`Saved to ${color.bold(path.relative(process.cwd(), r.outputPath))}`);
    console.log();
  }));

program
  .command('arrival')
  .description('Dated landing checklist: eVisa, enrolment, GP, bank, council tax, work rules')
  .option('--course-start <YYYY-MM-DD>', 'course start date')
  .action(run(async (o) => {
    banner('Arrival Planner');
    const r = await writeArrivalChecklist({ courseStart: o.courseStart });
    for (const s of r.sections) panel(`${s.phase}${s.when ? ` · by ${s.when}` : ''}`, s.items.map((i) => `☐ ${i.length > 84 ? `${i.slice(0, 83)}…` : i}`));
    note('No BRP and no police registration any more: your status is an eVisa in your UKVI account.');
    success(`Saved to ${color.bold(path.relative(process.cwd(), r.outputPath))}`);
    console.log();
  }));

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  await program.parseAsync();
}
