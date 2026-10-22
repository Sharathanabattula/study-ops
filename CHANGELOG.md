# Changelog

## 0.1.0 · 2026-10-22

Initial UK Phase 1 scaffold.

- CLI: `init`, `evaluate`, `generate-sop`, `audit-funds`.
- UKVI Compliance Engine: date-aware proof-of-funds calculation (London / outside London, 9-month cap, deposit deduction), 28-day bank statement timeline, 31-day end-date window, CAS validity and 6-month apply window, daily balance-history checker.
- University Evaluator: Russell Group resolution by domain, A–F grading bands, weighted 1.0–5.0 scoring framework (LLM scoring pending).
- SOP Tailor: per-university tone registry and constrained prompt builder (LLM generation pending).
- Markdown + YAML state layer, plus templates for the student profile, application tracker and master statement.
