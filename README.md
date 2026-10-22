<div align="center">

# 🎓 study·ops

**Local-first AI agents for the study-abroad pipeline.**

Phase 1: 🇬🇧 United Kingdom · Russell Group admissions · CAS tracking · UKVI Student visa compliance

[![CI](https://github.com/Sharathanabattula/study-ops/actions/workflows/ci.yml/badge.svg)](https://github.com/Sharathanabattula/study-ops/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Status](https://img.shields.io/badge/status-phase%201%20alpha-orange)
![Local-first](https://img.shields.io/badge/data-local--first-8AB4FF)

</div>

---

Applying to a UK master's means juggling a dozen university portals, rewriting the same personal statement for different tones, and then getting the UKVI bank statement rules exactly right, because one day below the threshold can mean a refusal.

**Study-Ops turns that into a pipeline.** Your whole application profile lives in one Markdown file. Specialised agents read it to grade universities, tailor your statement and audit your visa funds. A CLI ties them together.

Inspired by [`santifer/career-ops`](https://github.com/santifer/career-ops). There is no database and no cloud dependency, and your data never leaves your machine.

### ✨ What it does

**Phase 1: Strategic profiling & shortlisting** (what a study-abroad consultancy does at intake)

- **🧮 Profile Auditor**: converts an Indian 10-point CGPA or percentage to an estimated UK classification and a reference US GPA. It also audits backlogs, and checks IELTS/PTE against the UKVI B2 minimum, the common Russell Group tiers and test validity at intake.
- **🎯 Safe / Target / Reach Matrix**: searches each Russell Group university's own site for programmes in your subject, reads their entry requirements and places each in Safe, Target or Reach, with the reasoning shown.
- **💷 Cost & ROI Mapper**: the all-in cost of attendance (tuition, inner London / outer London / outside-London living costs, visa fee, health surcharge, flights) against your budget, plus payback on your salary uplift.
- **📚 Syllabus Matcher**: maps your undergraduate modules to a programme's prerequisites (met, partial or missing) and suggests a bridging plan for the gaps.

**Applications & visa**

- **🏛️ University Evaluator**: grades any Russell Group programme A–F (1.0–5.0) on admission probability, budget fit, ROI, programme fit and career outcomes.
- **✍️ SOP Tailor**: rewrites one master statement for each university's register, e.g. LSE's argument-driven style or Imperial's evidence-first one, without inventing facts.
- **🛂 UKVI Compliance Engine**: calculates exact proof of funds, the 28-day bank statement window and CAS deadlines. It is deterministic, tested and date-aware for rule changes.
- **📋 Tracker**: one YAML file follows every application from `researching` to `enrolled`.

```text
$ study-ops audit-funds --location london --duration 12 --tuition 38000 --deposit 5000 --apply-date 2027-07-01

  ╭─ breakdown ───────────────────────────────────────────╮
  │    Tuition outstanding  £33,000                       │
  │           Living costs  £1,570/mo × 9 (London, max 9) │
  │          TOTAL TO SHOW  £47,130                       │
  ╰───────────────────────────────────────────────────────╯
  ╭─ bank statement ──────────────────────────────────────────────╮
  │       Visa application  2027-07-01                            │
  │      Funds in place by  2027-06-04 at the latest              │
  │     Statement end date  2027-05-31 → 2027-07-01               │
  ╰───────────────────────────────────────────────────────────────╯
```

## Quick start

```bash
git clone https://github.com/Sharathanabattula/study-ops.git && cd study-ops
npm install
npm link            # optional: puts `study-ops` on your PATH
study-ops init      # scaffolds data/student_profile.md, tracker.yaml, personal_statement.md
cp .env.example .env   # then paste your Anthropic API key into .env
```

Fill in `data/student_profile.md`, then:

| Command | Agent | Status |
|---|---|---|
| `study-ops init [--force]` | Workspace scaffold | ✅ Ready |
| `study-ops audit-profile` | 4 · Profile Auditor | ✅ Ready (offline) |
| `study-ops shortlist --subject <s> [--unis lse,ucl] [--urls …] [--max-per-uni 2]` | 5 · Safe / Target / Reach matrix → `reports/shortlist-<subject>.md` | ✅ Ready (needs API key) |
| `study-ops cost [url] [--tuition] [--duration] [--zone inner\|outer\|outside]` | 6 · Cost of attendance + ROI | ✅ Ready (offline with `--tuition`) |
| `study-ops match-syllabus <url> [--extra-url] [--modules-file]` | 7 · Syllabus Matcher → `reports/syllabus-<id>.md` | ✅ Ready (needs API key) |
| `study-ops evaluate <url>` | 1 · University Evaluator: A–F grade, 1.0–5.0 score, report in `reports/`, tracker updated | ✅ Ready (needs API key) |
| `study-ops generate-sop --uni <name> [--programme] [--words] [--url]` | 2 · SOP Tailor: draft → critique → revise, saved to `output/sop/` | ✅ Ready (needs API key) |
| `study-ops audit-funds --location <london\|outside> --duration <months> --tuition <gbp>` | 3 · UKVI Compliance Engine | ✅ Ready (deterministic) |

Without an API key, `evaluate` and `generate-sop` still run in scaffold mode. `generate-sop` then saves a ready-to-paste prompt for any model.

### How Safe / Target / Reach is decided

For each programme, the **margin** is your percentage minus the minimum, in percentage points:

1. If the page states a minimum for your country (e.g. "65% from Indian universities"), that minimum is used. Confidence: high.
2. Otherwise the page's UK classification (e.g. 2:1) is converted to an estimated percentage for your institution tier. Confidence: medium.
3. The margin needed depends on the university's selectivity (`config/uk_universities.yaml`):

   | Selectivity | Safe | Target | Reach |
   |---|---|---|---|
   | standard | ≥ +8 | ≥ 0 | below minimum |
   | high (e.g. UCL, Warwick) | ≥ +12 | ≥ 0 | below minimum |
   | very high (Oxford, Cambridge, Imperial, LSE) | never | ≥ +5 | below +5 |

4. An English gap or active backlogs caps a programme at Target. A heavy backlog history moves selective programmes down one level.

**About "historical acceptance rates".** UK universities don't publish admit rates by applicant profile, and Study-Ops doesn't invent them. Consultancies rely on their own case history, and `data/outcomes.yaml` is where that goes. Once a university has **5 or more past applicants within ±5 points of your grade**, their admit rate decides the category instead (≥ 70% Safe, 40–69% Target, < 40% Reach), and the report says so.

**Grade conversion is a heuristic.** Indian CGPA → percentage uses the formula you set (`aicte`, `cbse`, `x10` or a custom formula from your transcript). Percentage → UK class uses editable tier bands in `config/grade_equivalence.yaml`. A university's own India table always overrides both.

### Connecting Claude

The two writing and judgement agents use [Anthropic's Claude](https://platform.claude.com) through the official `@anthropic-ai/sdk`.

1. Create an API key at <https://platform.claude.com/settings/keys>.
2. `cp .env.example .env` and set `ANTHROPIC_API_KEY=sk-ant-...`.
3. Optional: `STUDY_OPS_MODEL` picks the model. The default is `claude-opus-5-5`.

How the integration behaves:
- **Pages are fetched on your machine.** Only the page text, your profile and your statement are sent to Anthropic.
- **Structured outputs.** Requirements, scores and critiques come back validated against Zod schemas, so they can't be malformed.
- **The arithmetic isn't the model's.** IELTS band gaps, tuition vs budget and UKVI living costs are computed in code and handed to Claude as facts.
- **Prompt caching.** Your profile and master statement are cached across the SOP draft → critique → revise calls.
- **Server-side fallbacks** are on (`fallbacks: "default"`). If a request is declined, the API retries it on Anthropic's recommended fallback model. A request declined by every model shows a clear error.

Rough cost on Opus 5.5 ($4 / $20 per million tokens), depending on page length: **about $0.05–0.25 per evaluation**, **$0.10–0.30 per tailored statement**, **$0.10–0.25 per syllabus match**, and **roughly $5–12 for a full 24-university shortlist** at 2 programmes each. That last figure includes web search at $10 per 1,000 searches. These are estimates, not measurements. Page extractions are cached for 30 days, so re-runs cost much less. Use `--unis` to keep a shortlist small.

### `audit-funds` in detail

```bash
study-ops audit-funds --location london --duration 12 --tuition 38000 \
  --deposit 5000 --balance 40000 --apply-date 2027-07-01 --course-start 2027-09-28
```

- **Proof of Funds** = outstanding first-year tuition (tuition − deposit) + monthly living cost × min(⌈months⌉, 9).
- **Location**: UKVI's "London" is the City of London plus all 32 boroughs, inner *and* outer. `inner` and `outer` are accepted and both use the London rate. Use `outside` for everywhere else.
- **Rates are date-aware.** The engine picks the rate in force on your *application date* from `config/ukvi_rules.yaml`. That file includes the £1,570 / £1,203 rates announced for applications made on or after 30 Nov 2026.
- **28-day timeline**: the latest date funds must land, the acceptable statement end-date window (≤ 31 days before applying), the 6-month earliest-apply date and CAS expiry.
- `checkBalanceHistory()` (library API) checks a daily balance export for an unbroken 28-day run.

> ⚠️ Decision support, not immigration advice. Rules change, so re-verify at <https://www.gov.uk/student-visa/money> before applying.

## Architecture

```
bin/study-ops.js                 CLI routing (commander), rendering only
src/agents/
  1_university_evaluator.js      URL + profile → A–F report
  2_sop_tailor.js                master statement → university-specific SOP
  3_ukvi_compliance_engine.js    funds, 28-day rule, CAS guardrails (pure functions)
  4_profile_auditor.js           CGPA → % → UK class / US GPA, backlogs, English (pure)
  5_shortlist_matrix.js          discover → extract → Safe/Target/Reach → report + tracker
  6_cost_roi_mapper.js           cost of attendance, budget fit, payback (pure)
  7_syllabus_matcher.js          UG modules vs programme prerequisites
src/llm/claude.js                the only module that calls an LLM (model, caching, fallbacks, errors)
src/lib/programme.js             shared, cached programme-page extraction (data/programmes/)
src/lib/                         paths, Markdown/YAML state, profile, registry, tracker, page fetcher
src/ui/theme.js                  terminal design system (palette, panels, rows)
src/commands/init.js             workspace scaffold + onboarding
config/ukvi_rules.yaml           dated UKVI financial rules (edit when gov.uk changes)
config/uk_universities.yaml      24 Russell Group members: domains, UKVI location, selectivity, SOP tone
config/grade_equivalence.yaml    CGPA formulas, UK class bands by tier, US GPA, English tiers
config/living_costs.yaml         monthly living costs: inner / outer / outside London
templates/                       pristine copies used by `init`
data/                            YOUR state (git-ignored)
reports/, output/                agent output (git-ignored)
```

**State model**
- `data/student_profile.md`: YAML front-matter holds machine-read facts (CGPA, IELTS bands, budget, shortlist). The Markdown body holds your narrative. Agents parse both: `##` sections are indexed by heading.
- `data/outcomes.yaml`: past admission results (anonymous) that turn the matrix into a data-driven one.
- `data/tracker.yaml`: one entry per programme, with a status lifecycle running from `researching` through `cas_issued`, `visa_granted` and `enrolled`.

**Privacy.** `data/`, `reports/` and `output/` are git-ignored. Set `STUDY_OPS_HOME` to keep them somewhere else, such as an encrypted volume. Nothing is sent to an LLM until you add an API key, and then only for `shortlist`, `evaluate`, `match-syllabus`, `generate-sop` and `cost <url>`. `audit-profile`, `audit-funds` and `cost --tuition` never leave your machine.

## Development

```bash
npm test            # node:test: rules engines, conversions, matrix, and every LLM pipeline against a recorded HTTP layer
STUDY_OPS_DEBUG=1   # print stack traces
```

## Roadmap

- ~~**0.2** Claude provider, evaluator extraction and scoring, SOP generate → critique → revise.~~ ✅
- ~~**0.3** Phase 1 intake: profile audit, Safe/Target/Reach matrix, cost & ROI, syllabus matching.~~ ✅
- **1.2** `study-ops tracker` (status board, deadline alerts), CAS checklist agent.
- **2.x** More countries (Canada, Australia, Germany), dependants and sponsor modelling.

## License

MIT © Sharath Chandra Anabattula

---

Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). For privacy and vulnerability reporting, see [SECURITY.md](SECURITY.md).
