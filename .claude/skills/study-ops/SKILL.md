---
name: study-ops
description: Run the Study-Ops study-abroad pipeline (UK). Use when the student asks to audit their profile, shortlist universities, write or tailor an SOP, draft LORs or a CV, fill portals, prepare for interviews, match scholarships, prepare a loan docket, track their CAS, check proof of funds or bank statements, file the visa, or plan arrival.
---

# Study-Ops

1. If this is a first run, run `node bin/study-ops.js doctor`, then `node bin/study-ops.js init`.
2. Work out which phase the student is in and run the matching command from the table in CLAUDE.md. Show them the key output and the file it saved.
3. If a command reports missing data, tell the student which file and field to fill:
   - You can help edit the profile, raw SOP material, resume and recommenders.
   - Never open `data/applicant.yaml`, `data/finance.yaml`, `data/visa.yaml` or bank statements. Explain the fields and let the student type the values.
4. For documents, run the generator command (it checks truthfulness), then offer to walk through the review notes with the student.
5. End each turn with the single next step, e.g. "Next: `node bin/study-ops.js cas status ucl-msc-finance`".

Examples:
- "Where do I stand?" → `audit-profile`, then `portals`.
- "Write my Imperial SOP" → ask for course, professor, module and lab (or a programme URL), then `generate-sop`.
- "Are my bank statements OK for the visa?" → `audit-funds -l <london|outside> -d <months> -t <tuition> --apply-date <date> --fx <rate> --statements <csv files>`. The student supplies the file paths; you don't open them.
