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
import { tailorPersonalStatement } from '../src/agents/2_sop_tailor.js';
import { auditFunds, parseDate } from '../src/agents/3_ukvi_compliance_engine.js';
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

program
  .command('generate-sop')
  .description('Tailor your master personal statement to one university')
  .requiredOption('-u, --uni <name>', 'university name or key, e.g. LSE, imperial, ucl')
  .option('-p, --programme <name>', 'programme title, e.g. "MSc Finance"')
  .option('-w, --words <n>', 'word limit', positiveNumber)
  .option('--url <url>', 'programme page, so the draft can reference real modules and prompts')
  .action(run(async ({ uni, programme, words, url }) => {
    banner('SOP Tailor');
    const result = await tailorPersonalStatement({ university: uni, programme, wordLimit: words, url, onProgress: progress });
    if (result.status === 'complete') console.log();
    panel(result.university, [row('Tone', result.tone.length > 70 ? `${result.tone.slice(0, 69)}…` : result.tone, 6)]);

    if (result.status === 'complete') {
      const scores = Object.entries(result.critique.scores).map(([k, v]) => row(k.replace(/_/g, ' '), `${v}/5`, 18));
      panel('first-draft review', [
        ...scores,
        '',
        row('unsupported claims', String(result.critique.unsupported_claims.length), 18),
        row('final word count', String(result.wordCount), 18),
      ]);
      success(`Final statement saved to ${color.bold(path.relative(process.cwd(), result.outputPath))}`);
      note(`Drafted, critiqued and revised with ${model()}.`);
    } else {
      success(`Prompt saved to ${color.bold(path.relative(process.cwd(), result.promptPath))}`);
      note('Scaffold mode: add ANTHROPIC_API_KEY to .env to generate the statement directly.');
    }
    for (const w of result.warnings) warn(w);
    console.log();
  }));

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
