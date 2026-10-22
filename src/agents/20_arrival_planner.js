/**
 * @file Agent 20: Arrival Planner. Accommodation and first-weeks checklist.
 *
 * Accommodation
 *  Claude searches the university's own accommodation pages and the major
 *  purpose-built student accommodation (PBSA) operators for places near the
 *  campus. Each listing page is fetched locally and kept only if the
 *  property name appears there; a weekly price is shown only if that figure
 *  appears on the page too. Prices change daily, so every listing carries
 *  the date checked. Weekly rent × contract length is compared with your
 *  living-cost budget.
 *
 * Arrival checklist (deterministic, dated from your course start)
 *  Current rules: BRPs are no longer issued (you get an eVisa via a UKVI
 *  account), and police registration was abolished in August 2022. What
 *  remains: eVisa and "View and prove" share codes, university enrolment and
 *  right-to-study check, GP registration, bank account, council tax
 *  exemption, work-hour limits, and keeping your UKVI account up to date.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { PATHS } from '../lib/paths.js';
import { readYaml } from '../lib/files.js';
import { findUniversity } from '../lib/universities.js';
import { fetchPageText } from '../lib/web.js';
import { mentions, unsupportedNumbers } from '../lib/factcheck.js';
import { isConfigured, structuredWithSearch } from '../llm/claude.js';
import { loadLivingCosts, normaliseZone } from './6_cost_roi_mapper.js';

/** Major UK PBSA operators searched alongside the university's own halls. */
export const PBSA_DOMAINS = Object.freeze([
  'unite-students.com', 'iqstudentaccommodation.com', 'chapter-living.com', 'vitastudent.com',
  'homesforstudents.co.uk', 'studentroost.co.uk', 'scape.com', 'crm-students.com',
]);

const ListingsSchema = z.object({
  listings: z.array(z.object({
    name: z.string().describe('Property or hall name exactly as on its page'),
    operator: z.string().describe('University or company running it'),
    kind: z.enum(['university_halls', 'pbsa', 'private']),
    weekly_price: z.string().nullable().describe('As stated on the page, e.g. "from £289 per week"'),
    contract_weeks: z.number().nullable(),
    distance_or_travel: z.string().nullable().describe('As stated, e.g. "8 minutes walk to campus"'),
    url: z.string().describe("The property's own page"),
  })),
});

/**
 * Find and verify accommodation near a campus.
 * @param {object} input
 * @param {string} input.university
 * @param {string} [input.campus]           e.g. "Mile End", "South Kensington"
 * @param {number} [input.maxWeekly]        your ceiling, GBP per week
 * @param {(s: string) => void} [input.onProgress]
 * @param {typeof fetch} [input.fetchImpl]
 */
export async function findAccommodation({ university, campus, maxWeekly, onProgress = () => {}, fetchImpl }) {
  if (!isConfigured()) throw new Error('Accommodation search uses Claude web search. Sign in to Claude Code with your Claude subscription, or add ANTHROPIC_API_KEY to .env.');
  const uni = await findUniversity(university);
  if (!uni) throw new Error(`"${university}" is not in the registry.`);
  const where = campus ? `${uni.name}, ${campus} campus` : uni.name;

  onProgress(`Searching accommodation near ${where}`);
  const found = await structuredWithSearch({
    system: ['You find student accommodation for Study-Ops. Only return properties whose own pages you saw during this search, with their exact names, URLs and stated prices.'],
    schema: ListingsSchema,
    allowedDomains: [...uni.domains, ...PBSA_DOMAINS],
    maxSearches: 5,
    prompt: `Find up to 10 accommodation options for an international postgraduate student at ${where} in ${uni.city}: the university's own halls first, then purpose-built student accommodation within easy reach of the campus.${maxWeekly ? ` Prefer options at or under £${maxWeekly} per week.` : ''}`,
  });

  const verified = [];
  const dropped = [];
  const checked = new Date().toISOString().slice(0, 10);
  for (const l of found.listings) {
    let text = '';
    try {
      text = (await fetchPageText(l.url, { fetchImpl })).text;
    } catch {
      dropped.push(l.name);
      continue;
    }
    if (!mentions(text, l.name)) { dropped.push(l.name); continue; }
    const priceOk = l.weekly_price && !unsupportedNumbers(l.weekly_price, [text]).length;
    const weekly = priceOk ? Number((l.weekly_price.match(/£\s?([\d,]+(?:\.\d+)?)/) ?? [])[1]?.replace(/,/g, '')) || null : null;
    verified.push({ ...l, weekly_price: priceOk ? l.weekly_price : null, weekly, checked });
  }

  const zone = uni.ukvi_location === 'london' ? 'inner' : 'outside';
  const living = await loadLivingCosts();
  const monthlyBudget = living.monthly[normaliseZone(zone)];
  const rows = verified.map((v) => {
    const weeks = v.contract_weeks ?? 51;
    const total = v.weekly ? v.weekly * weeks : null;
    const share = v.weekly ? Math.round(((v.weekly * 52) / 12 / monthlyBudget) * 100) : null;
    return { ...v, weeks, total, shareOfLiving: share, overCeiling: maxWeekly && v.weekly ? v.weekly > maxWeekly : false };
  }).sort((a, b) => (a.weekly ?? 1e9) - (b.weekly ?? 1e9));

  const md = [
    `# Accommodation near ${where}`,
    '',
    `Checked ${checked}. Prices and availability change daily, so confirm on each page before booking.`,
    '',
    '| Name | Type | Price (as stated) | Contract | Travel | Rent as % of living budget |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| [${r.name}](${r.url}) · ${r.operator} | ${r.kind.replace('_', ' ')} | ${r.weekly_price ?? '_see page_'}${r.overCeiling ? ' ⚠️' : ''} | ${r.contract_weeks ? `${r.contract_weeks} wks` : '–'} | ${r.distance_or_travel ?? '–'} | ${r.shareOfLiving != null ? `${r.shareOfLiving}%` : '–'} |`),
    '',
    `Living budget used: £${monthlyBudget.toLocaleString('en-GB')}/month (config/living_costs.yaml). Rent above about 60% of it leaves little for food, transport and books.`,
    '',
    ...(dropped.length ? [`_Not confirmed on their own pages, so left out: ${dropped.join(', ')}_`, ''] : []),
    '## Before you pay anything',
    '',
    '- Book university halls and PBSA through the official website only. Never pay a deposit by bank transfer to an individual for a place you have not verified.',
    '- Private lets in England: your deposit must be protected in a government-approved scheme (DPS, TDS or mydeposits) and the landlord must give you the details.',
    '- Landlords check your **Right to Rent**. Share it with an eVisa share code from your UKVI account ("View and prove").',
    '- Many private landlords want a UK guarantor. Without one, expect to pay rent upfront or use a guarantor service; university halls usually don’t need one.',
    '- Read the contract length: 51-week contracts cost more than term-time-only lets but cover the summer of a 12-month master’s.',
    '- Full-time students are exempt from council tax. Get the exemption certificate from your university.',
    '',
  ].join('\n');

  await fs.mkdir(PATHS.arrivalOutput, { recursive: true });
  const outputPath = path.join(PATHS.arrivalOutput, `accommodation-${uni.key}.md`);
  await fs.writeFile(outputPath, md, 'utf8');
  return { listings: rows, dropped, outputPath, monthlyBudget };
}

/**
 * Dated arrival checklist. Pure.
 * @param {object} input
 * @param {string} [input.courseStart]   YYYY-MM-DD
 * @param {any} input.rules              ukvi_rules.yaml
 */
export function arrivalChecklist({ courseStart, rules }) {
  const at = (days) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(courseStart ?? '')) return null;
    const d = new Date(`${courseStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return [
    { phase: 'Before you fly', when: at(-30), items: [
      'Create your UKVI account, link your passport and check that your eVisa details (name, dates, conditions) are correct. BRPs are no longer issued.',
      'Confirm your accommodation in writing and your arrival/check-in time.',
      'Hand luggage: passport, CAS, offer letter, accommodation confirmation, financial evidence, TB certificate and university contacts.',
      'Carry enough money for the first 2–3 weeks (card + some cash) until a UK bank account is open.',
      'Note your university’s airport pick-up or welcome dates, if offered.',
    ] },
    { phase: 'Arrival week', when: at(-7), items: [
      'At the border, your passport is linked to your eVisa. Keep your UKVI account details handy in case you are asked.',
      `Police registration is not required (abolished August 2022).`,
      'Enrol at the university and complete its right-to-study check. It may ask for an eVisa share code.',
      'Get a UK SIM so banks and the university can text you.',
    ] },
    { phase: 'First two weeks', when: at(7), items: [
      'Register with a GP (doctor) near where you live. Your Immigration Health Surcharge covers NHS care.',
      'Open a UK bank account. Many accept a university enrolment letter as proof of address.',
      'Get your council tax exemption certificate from the university and send it to the local council.',
      'Consider contents insurance and a 16-25 or 26-30 Railcard if you will travel by train.',
    ] },
    { phase: 'Ongoing', when: null, items: [
      `Work limit: up to ${rules.work.term_time_hours_per_week} hours per week during term time for degree-level study; no self-employment. Check your eVisa conditions.`,
      'Keep your UKVI account up to date. If you renew your passport, update it there.',
      'Tell your university promptly if your address or contact details change.',
      'Keep attending: universities report non-attendance to UKVI.',
    ] },
  ];
}

/** Write outputs/arrival/checklist.md. */
export async function writeArrivalChecklist({ courseStart } = {}) {
  const rules = await readYaml(PATHS.ukviRules);
  const sections = arrivalChecklist({ courseStart, rules });
  const md = [
    '# Arrival checklist',
    '',
    courseStart ? `Course starts ${courseStart}.` : 'Add --course-start YYYY-MM-DD for dates.',
    '',
    ...sections.flatMap((s) => [`## ${s.phase}${s.when ? ` (by ${s.when})` : ''}`, '', ...s.items.map((i) => `- [ ] ${i}`), '']),
    '> Sources: gov.uk eVisa guidance; Home Office (police registration removed Aug 2022). Rules change, so check gov.uk and your university’s arrival pages.',
    '',
  ].join('\n');
  await fs.mkdir(PATHS.arrivalOutput, { recursive: true });
  const outputPath = path.join(PATHS.arrivalOutput, 'checklist.md');
  await fs.writeFile(outputPath, md, 'utf8');
  return { sections, outputPath };
}
