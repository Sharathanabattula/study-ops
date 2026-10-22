# Changelog

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
