# Security & Privacy

Study-Ops handles sensitive personal data: academic records, passport details and bank balances. The design is local-first:

- All user state lives in `data/`, `reports/` and `outputs/`, which are git-ignored.
- Nothing is sent to any network service unless you configure an LLM provider in `.env`.
- Set `STUDY_OPS_HOME` to keep your data on an encrypted volume.

## Application data and portals (Phase 3)

- `data/applicant.yaml` holds passport and immigration details. It is read only by local code and **never placed in an LLM prompt**: form mapping sends field labels only, and a test asserts that no applicant value appears in any request.
- `data/browser/<site>/` holds the assisted browser's profile, including your **signed-in portal sessions**. Treat it like a password. It is git-ignored; delete the folder to sign out everywhere.
- Study-Ops never stores passwords, never submits applications, never pays fees and never answers declarations (criminal record, health, equality monitoring, consent) on your behalf.
- `outputs/forms/*.md` (from `form-pack`) contains passport data. Delete it when you finish.

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/Sharathanabattula/study-ops/security/advisories/new) instead.
