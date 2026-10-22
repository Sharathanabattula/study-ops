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
| `study-ops evaluate <url>` | 1 · University Evaluator: A–F grade, 1.0–5.0 score, report in `reports/`, tracker updated | ✅ Ready (needs API key) |
| `study-ops generate-sop --uni <name> [--programme] [--words] [--url]` | 2 · SOP Tailor: draft → critique → revise, saved to `output/sop/` | ✅ Ready (needs API key) |
| `study-ops audit-funds --location <london\|outside> --duration <months> --tuition <gbp>` | 3 · UKVI Compliance Engine | ✅ Ready (deterministic) |

Without an API key, `evaluate` and `generate-sop` still run in scaffold mode. `generate-sop` then saves a ready-to-paste prompt for any model.

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

Rough cost on Opus 5.5 ($4 / $20 per million tokens): **about $0.05–0.25 per evaluation** and **$0.10–0.30 per tailored statement**, depending on page and statement length.

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
src/llm/claude.js                the only module that calls an LLM (model, caching, fallbacks, errors)
src/lib/                         paths, Markdown/YAML state, profile, registry, tracker, page fetcher
src/ui/theme.js                  terminal design system (palette, panels, rows)
src/commands/init.js             workspace scaffold + onboarding
config/ukvi_rules.yaml           dated UKVI financial rules (edit when gov.uk changes)
config/uk_universities.yaml      24 Russell Group members: domains, UKVI location, SOP tone
templates/                       pristine copies used by `init`
data/                            YOUR state (git-ignored)
reports/, output/                agent output (git-ignored)
```

**State model**
- `data/student_profile.md`: YAML front-matter holds machine-read facts (CGPA, IELTS bands, budget, shortlist). The Markdown body holds your narrative. Agents parse both: `##` sections are indexed by heading.
- `data/tracker.yaml`: one entry per programme, with a status lifecycle running from `researching` through `cas_issued`, `visa_granted` and `enrolled`.

**Privacy.** `data/`, `reports/` and `output/` are git-ignored. Set `STUDY_OPS_HOME` to keep them somewhere else, such as an encrypted volume. Nothing is sent to an LLM until you add an API key, and then only for `evaluate` and `generate-sop`. `audit-funds` never leaves your machine.

## Development

```bash
npm test            # node:test, covering the UKVI engine and grading bands
STUDY_OPS_DEBUG=1   # print stack traces
```

## Roadmap

- ~~**0.2** Claude provider, evaluator extraction and scoring, SOP generate → critique → revise.~~ ✅
- **1.2** `study-ops tracker` (status board, deadline alerts), CAS checklist agent.
- **2.x** More countries (Canada, Australia, Germany), dependants and sponsor modelling.

## License

MIT © Sharath Chandra Anabattula

---

Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). For privacy and vulnerability reporting, see [SECURITY.md](SECURITY.md).
