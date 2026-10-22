import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditFunds,
  buildFundsTimeline,
  calculateProofOfFunds,
  checkBalanceHistory,
  loadUkviRules,
  normaliseLocation,
  parseDate,
} from '../src/agents/3_ukvi_compliance_engine.js';
import { scoreToGrade, weightedScore } from '../src/agents/1_university_evaluator.js';

const rules = await loadUkviRules();

test('inner and outer London both resolve to the London rate', () => {
  assert.equal(normaliseLocation('inner'), 'london');
  assert.equal(normaliseLocation('outer'), 'london');
  assert.equal(normaliseLocation('outside'), 'outside-london');
  assert.throws(() => normaliseLocation('mars'), RangeError);
});

test('London, 12-month MSc: maintenance capped at 9 months, deposit deducted', () => {
  const f = calculateProofOfFunds({
    location: 'london', courseMonths: 12, tuitionFirstYear: 38_000, tuitionPaid: 5_000,
    applicationDate: parseDate('2026-10-22'), rules,
  });
  assert.equal(f.monthsCounted, 9);
  assert.equal(f.monthlyRate, 1529);
  assert.equal(f.maintenance, 13_761);
  assert.equal(f.tuitionOutstanding, 33_000);
  assert.equal(f.total, 46_761);
});

test('announced rate applies to applications on/after its effective date', () => {
  const f = calculateProofOfFunds({
    location: 'outside', courseMonths: 6.5, tuitionFirstYear: 20_000,
    applicationDate: parseDate('2026-11-30'), rules,
  });
  assert.equal(f.monthlyRate, 1203);
  assert.equal(f.monthsCounted, 7); // part months round up
  assert.equal(f.rateStatus, 'announced');
});

test('timeline: 28 days inclusive, statement end within 31 days', () => {
  const t = buildFundsTimeline({
    applicationDate: parseDate('2027-07-01'), courseStart: parseDate('2027-09-28'),
    casIssuedOn: parseDate('2027-06-15'), rules,
  });
  assert.equal(t.holdMustStartBy, '2027-06-04');
  assert.equal(t.statementEndEarliest, '2027-05-31');
  assert.equal(t.earliestApplyDate, '2027-03-28');
  assert.equal(t.casExpiresOn, '2027-12-15');
});

test('balance history: a single dip breaks the 28-day run', () => {
  const applicationDate = parseDate('2027-07-01');
  const days = Array.from({ length: 40 }, (_, i) => {
    const d = new Date(applicationDate.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    return { date: d, balance: 50_000 };
  });
  assert.equal(checkBalanceHistory({ balances: days, required: 46_761, applicationDate, rules }).compliant, true);

  days[10].balance = 40_000; // dip 10 days before applying
  days[20].balance = 40_000; // and again 20 days before
  const res = checkBalanceHistory({ balances: days, required: 46_761, applicationDate, rules });
  assert.equal(res.compliant, false);
});

test('auditFunds reports shortfall and upcoming rate rise', async () => {
  const a = await auditFunds({
    location: 'london', durationMonths: 12, tuition: 38_000, balance: 40_000,
    applicationDate: parseDate('2026-10-22'), rules,
  });
  assert.equal(a.position.shortfall, 51_761 - 40_000);
  assert.ok(a.warnings.some((w) => w.includes('2026-11-30')));
});

test('grading bands', () => {
  assert.equal(scoreToGrade(4.6).grade, 'A');
  assert.equal(scoreToGrade(3.0).grade, 'C');
  assert.equal(scoreToGrade(1.0).grade, 'F');
  assert.equal(weightedScore([{ score: 5, weight: 0.5 }, { score: null, weight: 0.5 }]), 5);
});
