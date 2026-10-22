# Security & Privacy

Study-Ops handles sensitive personal data: academic records, passport details and bank balances. The design is local-first:

- All user state lives in `data/`, `reports/` and `outputs/`, which are git-ignored.
- Nothing is sent to any network service unless you configure an LLM provider in `.env`.
- Set `STUDY_OPS_HOME` to keep your data on an encrypted volume.

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/Sharathanabattula/study-ops/security/advisories/new) instead.
