# Changelog

## 0.8.0 · 2026-10-22

Run on your Claude subscription, career-ops style.

- New provider `src/llm/claude_code.js`: every AI step can run through the signed-in Claude Code CLI (`claude -p --output-format json`, `--json-schema` for structured output, `--system-prompt-file`, prompt on stdin, `--tools ""` for writing and WebSearch/WebFetch for searches, `--no-session-persistence`, temp working directory). API-key variables are removed from the child environment so the subscription is used. Zod validation of every answer. Verified live.
- Automatic provider choice: API key → API; otherwise installed `claude` → subscription. `STUDY_OPS_PROVIDER=claude-code|api|off` to force.
- `study-ops doctor`: Node, Claude Code version, sign-in status, API key, active provider, Playwright.
- `CLAUDE.md`, `.claude/skills/study-ops/SKILL.md` and `.claude/settings.json` (deny rules for passport, finance, visa, statements, browser profiles, `.env`) for using Study-Ops conversationally inside Claude Code.
- Elite SOP: forbids bracketed notes inside the essay and flags any that remain.
- CI runs on Windows as well as Ubuntu; portable `npm test`; PowerShell setup guide.

## 0.7.0 · 2026-10-22

Phases 4–6: money, visa and landing.

- `scholarships` (agent 15): code-checked eligibility for Chevening, GREAT (India) and Commonwealth Master's (India) with dated windows (checked 22 Oct 2026). University awards come from web search on the university's own domain, kept only when the award page confirms the name and any stated amount.
- `loan-docket` (agent 16): funding gap in GBP/INR; Credila, SBI and Prodigy dockets by loan type and co-applicant employment; tick-off from `data/finance.yaml`; UKVI loan-letter checks; correct Section 80E note (old tax regime only). Fully offline.
- `cas status/set` (agent 17): offer → firm → deposit → ATAS → pre-CAS docs → finance check → credibility interview → CAS, with working-day ATAS estimate, CAS expiry, earliest visa date and TB validity.
- `audit-funds --fx/--buffer/--statements` (agent 18): INR proof of funds with a buffer for OANDA movement; bank CSV parser (header detection, Indian date and amount formats, newest-first files, rejects malformed rows); carry-forward daily balances; multi-account sums; dips, large credits and stale statements flagged.
- `visa checklist/open` (agent 19): documents with status (TB, ATAS, parental consent, loan letter), £558 fee + IHS for the full visa length, date gates, steps through VFS biometrics to eVisa; assisted gov.uk session.
- `housing` and `arrival` (agent 20): verified halls/PBSA with stated prices against the living budget and tenancy safeguards; dated arrival checklist reflecting eVisas (no BRPs) and the removal of police registration.
- Credibility interview focus covers modules, campus location and funding sources.
- New config: `scholarships.yaml`, `lenders.yaml`; `ukvi_rules.yaml` adds FX, TB, ATAS, eVisa and work-hour rules. New templates: `finance.yaml`, `visa.yaml`; tracker gains offer/pre-CAS/ATAS fields.

## 0.6.0 · 2026-10-22

Phase 3: application execution.

- `templates/applicant.yaml` → `data/applicant.yaml`: passport, contact, address, education, English test, employment, referees, immigration and UCAS fields. Read only by local code.
- `check-application` (agent 11): deterministic validation and cross-checks with the profile: passport format and expiry vs course + visa leave, ISO dates and ordering, unexplained gaps, email/phone formats, English scores vs profile and validity, referee count and institutional emails, refusal details, UCAS ID.
- `fill <url>` / `portal open <id>` (agent 12): assisted Chromium session with a persistent per-site profile; DOM field extraction; offline synonym matcher plus Claude mapping of **labels only** (cached per form); local filling with UK date formats, split dates, phone parts and option matching; never submits, never overwrites, never fills declarations, criminal-record, health, equality-monitoring, password or consent fields; blue/amber highlighting.
- `form-pack`: UK-formatted copy-paste sheet for portals that block automation.
- `portals`, `portal set` (agent 13): dashboard of accounts, deadlines, documents, uploads and the next action per application; UCAS cycle deadlines for undergraduates; passwords refused.
- `interview`, `interview-practice` (agent 14): credibility/pre-CAS, Kira-style, technical finance, technical CS, academic and general banks with answer outlines from the student's files; timed practice with rubric scores, consistency flags, pacing and filler checks; session logs.
- Playwright as an optional dependency (`STUDY_OPS_CHROMIUM` to reuse a local browser); CI installs Chromium and runs a real-browser fill test plus a privacy test that no applicant value reaches any LLM request.

## 0.5.0 · 2026-10-22

Elite SOP engine.

- `templates/elite_sop_framework.md` (copied to `data/templates/` by `init`): the Elite SOP Constraints (anti-childhood opening, show-don't-tell, the "Why this university" formula, understated academic tone) plus a truthfulness rule. It is used verbatim as the system prompt for every SOP command.
- `templates/master_sop_raw.md` → `data/master_sop_raw.md`: structured raw material (milestone, academics, projects, work, turning point, interests, why UK, goals, gaps).
- `generateTailoredSOP(universityName, targetCourse, universitySpecificDetails)` in `src/agents/2_sop_tailor.js`: draft → elite critique → code checks (banned openings/words parsed from the framework, Rule 3 names in the final body paragraph, unsupported numbers, unsupplied people) → revise → re-check. Output goes to `outputs/sops/SOP_<University>.md`.
- `study-ops generate-sop --uni --course --prof --module [--lab] [--url] [--find-faculty]` now runs the Elite engine. The previous master-based ≈30% tailoring is `study-ops tailor-sop`, and it and `master-sop` also run under the framework.
- Generated documents moved from `output/` to `outputs/` (both git-ignored).

## 0.4.0 · 2026-10-22

Phase 2: the positioning engine (documents).

- `master-sop` (agent 8): narrative plan (central thesis + causal arc with cited evidence), interview questions written to `data/sop_interview.md` when evidence is missing, draft → rubric critique (incl. academic rigour) → revise, `--adopt` with automatic backup.
- `generate-sop` (agent 2, rewritten): targets ≈30% rewrite measured by word-level LCS against the master. Specifics from the programme page (modules), `--research-urls` and `--find-faculty` (web search on official domains); every name is verified on a locally fetched page. Unverified references and numbers are fed back into the revision and re-checked on the final text.
- `lor` (agent 9): one planning call assigns distinct angles and non-overlapping evidence; drafts follow UK reference conventions; pairwise 4-gram overlap and number checks trigger revisions. Output is a briefing plus a draft for the recommender to rewrite and submit.
- `academic-cv` (agent 10): structured conversion of `data/resume.md` into a UK academic CV, rendered deterministically, with checks for unsupported numbers and publication titles, removal of DOB/photo/marital status, and prompts to quantify impact.
- New shared guards in `src/lib/factcheck.js`; specifics researcher in `src/lib/specifics.js`.
- Templates: `recommenders.yaml`, `resume.md`; profile gains `target.research_interests`.

## 0.3.0 · 2026-10-22

Phase 1 intake: strategic profiling and university shortlisting.

- `audit-profile` (agent 4): CGPA → percentage (AICTE / CBSE / ×10 / custom), percentage → estimated UK classification by institution tier, reference US GPA, backlog audit (active vs cleared), English vs UKVI B2 and Russell Group tiers, test validity at intake, study-gap flag.
- `shortlist` (agent 5): per-university programme discovery via Claude web search limited to official domains, cached requirement extraction, deterministic Safe/Target/Reach classification with stated basis and confidence, optional historical-outcomes override from `data/outcomes.yaml`, cost of attendance per programme, Markdown matrix and tracker entries.
- `cost` (agent 6): whole-course cost of attendance with inner/outer/outside-London living costs, £558 visa fee, IHS for the full visa length, budget fit, ROI payback and the Graduate Route length (18 months for applications from 1 Jan 2027).
- `match-syllabus` (agent 7): prerequisites with source quotes, module-by-module match, bridging plan and statement points. Module names not in the profile are dropped.
- Shared programme catalog (`src/lib/programme.js`) with a 30-day cache. The evaluator now uses it, along with the profile audit.
- Profile template: institution tier, CGPA conversion, backlogs object, modules, living zone, career/salary block, whole-course budget and FX rate.
- New config: `grade_equivalence.yaml`, `living_costs.yaml`; visa costs and Graduate Route in `ukvi_rules.yaml`; selectivity in the registry.

## 0.2.0 · 2026-10-22

Claude is now connected as the LLM provider.

- `src/llm/claude.js`: Anthropic SDK client (`claude-opus-5-5` by default, override with `STUDY_OPS_MODEL`), structured outputs via Zod, prompt caching, server-side refusal fallbacks and readable API errors.
- `evaluate`: fetches the programme page locally, extracts requirements (null when not stated), runs deterministic IELTS/budget/UKVI checks, scores five dimensions, writes `reports/<id>.md` and upserts `data/tracker.yaml` with comments preserved.
- `generate-sop`: draft → rubric critique → revision, with a new `--url` flag to ground the draft in the programme page. Output goes to `output/sop/<uni>.md` with review notes.
- Without an API key, both commands fall back to scaffold mode.
- Tests: SDK request shape, refusal handling and both pipelines end to end against a recorded HTTP layer.

## 0.1.0 · 2026-10-22

Initial UK Phase 1 scaffold.

- CLI: `init`, `evaluate`, `generate-sop`, `audit-funds`.
- UKVI Compliance Engine: date-aware proof-of-funds calculation (London / outside London, 9-month cap, deposit deduction), 28-day bank statement timeline, 31-day end-date window, CAS validity and 6-month apply window, daily balance-history checker.
- University Evaluator: Russell Group resolution by domain, A–F grading bands, weighted 1.0–5.0 scoring framework (LLM scoring pending).
- SOP Tailor: per-university tone registry and constrained prompt builder (LLM generation pending).
- Markdown + YAML state layer, plus templates for the student profile, application tracker and master statement.
