---
# ─────────────────────────────────────────────────────────────────────────────
#  STUDY-OPS · STUDENT PROFILE  (single source of truth)
#  The YAML block is machine-read by every agent. The Markdown below it is the
#  narrative the SOP Tailor and Evaluator reason over. Keep both honest.
#  This file never leaves your machine unless you send it to an LLM provider.
# ─────────────────────────────────────────────────────────────────────────────
schema_version: 1

identity:
  full_name: ""                # As on passport
  nationality: ""              # ISO country name, e.g. "India"
  passport_expiry: ""          # YYYY-MM-DD; must outlast the course + visa leave
  date_of_birth: ""            # YYYY-MM-DD
  email: ""

target:
  country: "United Kingdom"
  level: "MSc"                 # MSc | MA | MRes | MBA | LLM | PhD | BSc
  intake: "2027-09"            # YYYY-MM
  subjects: []                 # e.g. ["Finance", "Data Science"]
  research_interests: []       # e.g. ["biotech venture financing", "asset pricing"]; used to find relevant faculty
  study_location: "london"     # london | outside-london (drives UKVI maintenance)
  living_zone: "inner"         # inner | outer: where in London you'd live (cost of attendance)
  shortlist: []                # e.g. ["LSE", "Imperial", "UCL", "Warwick"]

academics:
  degree: ""                   # e.g. "B.Tech Biotechnology"
  institution: ""
  institution_tier: null       # 1 | 2 | 3. Many UK universities publish tiered India lists; 1 = IIT/NIT/top NIRF
  graduation_year: null
  cgpa: null                   # e.g. 8.4
  cgpa_scale: 10               # 4 | 5 | 10 | 100
  percentage: null             # Official % if your transcript states one (overrides conversion)
  cgpa_conversion: null        # aicte ((CGPA−0.75)×10) | cbse (×9.5) | x10 | custom
  cgpa_conversion_custom: { multiply: null, add: null }
  uk_equivalent: ""            # Fill once verified via a university's own India page
  backlogs: { active: 0, cleared: 0 }
  modules:                     # Undergraduate modules, used by `study-ops match-syllabus`
    - { name: "", grade: "", credits: null, description: "" }

english:
  test: ""                     # IELTS Academic UKVI | PTE Academic UKVI | TOEFL | Waiver
  overall: null
  bands: { listening: null, reading: null, writing: null, speaking: null }
  test_date: ""                # YYYY-MM-DD (most are valid 2 years)

standardised_tests:
  gmat: null
  gre: { verbal: null, quant: null, awa: null }

experience:
  total_months: 0
  roles:
    - title: ""
      organisation: ""
      start: ""                # YYYY-MM
      end: ""                  # YYYY-MM or "present"
      highlights: []           # Quantified wins: "Cut assay cost 18% across 3 labs"

budget:
  currency: "GBP"
  max_tuition: null            # Annual tuition ceiling
  max_total_year_one: null     # Tuition + living + visa + IHS + flights
  max_total_course: null       # Whole-course all-in ceiling (used before max_total_year_one)
  flights_and_setup_gbp: null  # Flights, deposits, setup
  fx_gbp_to_home: null         # e.g. 112 (INR per GBP) to show costs in your currency
  funding_sources: []          # e.g. ["Family savings", "Education loan", "Chevening"]
  loan_sanctioned: false

career:                        # For ROI. Study-Ops has no salary data; use real figures you trust.
  current_salary_annual: null
  current_salary_currency: "INR"
  expected_salary_annual_gbp: null   # UK role after graduating (programme employment report)
  expected_home_salary_annual: null  # Alternative if you plan to return home (same currency as current)

documents:
  transcripts: false
  degree_certificate: false
  passport_scan: false
  cv: false
  references: 0                # count secured
  master_personal_statement: "data/personal_statement.md"
---

# 🎓 Student Profile

> **How to use this file:** Fill the YAML block above with hard facts. Use the
> sections below for the story only you can tell. Agents quote from here
> verbatim, so write in your own voice.

---

## 🧭 Core Narrative

_In 3–5 sentences: who are you, what problem do you care about, and why does
a UK postgraduate degree come next?_

<!-- Example: "I spent two years scaling wet-lab assays at a Hyderabad CRO and kept
hitting the same wall: great science that didn't get funded. I want to sit at the
intersection of biotech and capital allocation..." -->

## 🎯 Career Goals

| Horizon | Goal | Why the UK degree unlocks it |
|---|---|---|
| Short term (0–2 yrs) | | |
| Long term (5+ yrs) | | |

## 🏆 Signature Achievements

1. **[Achievement]**: _context → action → measurable result_
2. **[Achievement]**:
3. **[Achievement]**:

## 🔬 Academic Highlights

- Relevant modules and grades:
- Thesis / capstone:
- Publications / conferences:

## 💼 Professional Experience: Narrative

_Describe the work behind the YAML roles above. What did you own? What changed
because you were there?_

## 🌍 Why the UK, and Why Now

- Why the UK over the US, Canada or Australia:
- Why this intake:
- Post-study plan (Graduate Route, return home, PhD):

## ⚠️ Gaps & Red Flags (be honest; agents use this to pre-empt objections)

- Study gaps:
- Low grades / backlogs:
- Previous visa refusals (any country):

## 🧩 Extracurriculars & Leadership

-

## 📝 Notes for the Agents

_Tone preferences, things to never claim, phrases you hate, etc._
