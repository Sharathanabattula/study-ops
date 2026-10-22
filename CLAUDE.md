# Study-Ops: instructions for Claude Code

This repo is a local-first CLI that runs a student's UK study-abroad pipeline, from profile audit to arrival. When a student opens this folder in Claude Code, help them run it and work on their files.

## How to run things

- Run commands with `node bin/study-ops.js <command>` from the repo root. Run `node bin/study-ops.js doctor` first if anything seems off.
- AI steps automatically use the student's **Claude subscription** through the `claude` CLI (`claude -p`), or an API key if `.env` sets one. Don't ask for an API key.
- Prefer the CLI commands over writing documents yourself. The commands enforce the truthfulness checks: numbers must come from the student's files, professors and labs must be verified on official pages, and the Elite SOP rules are checked in code.
- Before a large command such as a full 24-university `shortlist`, tell the student it uses a fair share of their plan's usage, and suggest `--unis` to narrow it.

## Command map

| Phase | Commands |
|---|---|
| Setup | `init`, `doctor` |
| 1 Profile & shortlist | `audit-profile`, `shortlist --subject …`, `cost <url>`, `match-syllabus <url>`, `evaluate <url>` |
| 2 Documents | `master-sop`, `generate-sop --uni … --course … --prof … --module … --lab …`, `tailor-sop`, `lor`, `academic-cv` |
| 3 Applications | `check-application`, `portals`, `portal set/open <id>`, `fill <url>`, `form-pack`, `interview --type …`, `interview-practice` |
| 4 Money | `scholarships`, `loan-docket --lender credila\|sbi\|prodigy` |
| 5 Visa | `cas status/set <id>`, `audit-funds … --fx … --statements …`, `visa checklist`, `visa open` |
| 6 Arrival | `housing --uni …`, `arrival --course-start …` |

## Privacy rules (strict)

- **Never read, print, summarise or edit** `data/applicant.yaml`, `data/finance.yaml`, `data/visa.yaml`, anything under `data/statements/`, `data/browser/` or `outputs/forms/`, or `.env`. They hold passport, family-finance and bank data. The CLI reads them locally; you don't need to. `.claude/settings.json` denies these reads. If the student asks you to fill one in, explain the fields from `templates/` instead and let them type the values.
- You may read and help edit `data/student_profile.md`, `data/master_sop_raw.md`, `data/resume.md`, `data/recommenders.yaml` and generated files under `outputs/sops`, `outputs/lor`, `outputs/cv` and `reports/`, because the student is asking you to.

## Writing rules

- Never invent facts, numbers, people, modules, labs, awards or outcomes. If something is missing, ask the student.
- SOPs follow `data/templates/elite_sop_framework.md`.
- LORs are drafts for recommenders to rewrite and submit themselves.
- Not immigration advice. For case-specific advice, point to the university's international advisers or an IAA-regulated adviser.
