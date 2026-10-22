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
import { Command, InvalidArgumentError } from 'commander';

import { initWorkspace, printWelcome } from '../src/commands/init.js';
import { evaluateUniversity } from '../src/agents/1_university_evaluator.js';
import { generateTailoredSOP, tailorPersonalStatement } from '../src/agents/2_sop_tailor.js';
import { auditFunds, parseDate } from '../src/agents/3_ukvi_compliance_engine.js';
import { auditProfile } from '../src/agents/4_profile_auditor.js';
import { buildShortlist } from '../src/agents/5_shortlist_matrix.js';
import { budgetFit, costOfAttendance, estimateRoi } from '../src/agents/6_cost_roi_mapper.js';
import { matchSyllabus } from '../src/agents/7_syllabus_matcher.js';
import { buildMasterSop } from '../src/agents/8_master_sop.js';
import { MAX_OVERLAP, draftLors } from '../src/agents/9_lor_drafter.js';
import { buildAcademicCv } from '../src/agents/10_academic_cv.js';
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

    for (const w of audit.warnings) warn(w);
    console.log();
    note(`Rules: config/ukvi_rules.yaml · verify at ${audit.source}`);
    note('Decision support only, not immigration advice.');
    console.log();
  }));

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  await program.parseAsync();
}
