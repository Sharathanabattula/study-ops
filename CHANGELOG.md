# Changelog

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
