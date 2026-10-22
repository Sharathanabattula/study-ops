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

**Phase 1: Strategic profiling & shortlisting** (what a study-abroad consultancy does at intake)

- **🧮 Profile Auditor**: converts an Indian 10-point CGPA or percentage to an estimated UK classification and a reference US GPA. It also audits backlogs, and checks IELTS/PTE against the UKVI B2 minimum, the common Russell Group tiers and test validity at intake.
- **🎯 Safe / Target / Reach Matrix**: searches each Russell Group university's own site for programmes in your subject, reads their entry requirements and places each in Safe, Target or Reach, with the reasoning shown.
- **💷 Cost & ROI Mapper**: the all-in cost of attendance (tuition, inner London / outer London / outside-London living costs, visa fee, health surcharge, flights) against your budget, plus payback on your salary uplift.
- **📚 Syllabus Matcher**: maps your undergraduate modules to a programme's prerequisites (met, partial or missing) and suggests a bridging plan for the gaps.

**Phase 2: The positioning engine** (documents)

- **🧭 Master SOP Architect**: plans a central thesis and a causal arc (past academics → turning point → motivation → goals). It asks you questions where the profile is thin instead of inventing, then drafts, critiques and revises for academic rigour.
- **🎓 Elite SOP Engine** (`generate-sop`): writes each university's statement from your raw material under the Elite SOP Constraints. It opens in media res, uses evidence instead of adjectives ("passionate", "fascinated" and similar are banned), and ends with a "Why this university" paragraph naming one module, one professor and one lab. Code checks enforce these rules, not just the prompt.
- **✍️ Master-based SOP Tailor** (`tailor-sop`): rewrites about 30% of the master for each university, measured in code, and weaves in real modules, faculty and labs. A name is used only if it appears on an official page Study-Ops fetched itself.
- **🤝 LOR Drafter**: plans 2–3 letters with different angles (research, leadership, technical…), gives each its own evidence, and checks the drafts against each other so they don't sound alike. Each is a briefing and draft for the recommender to rewrite and submit.
- **📄 Academic CV**: turns a job-search resume into a UK academic CV (education and research first, publications, quantified projects) and drops details UK CVs leave out (DOB, photo, marital status).

**Phase 3: Application execution**

- **🧾 Application Data Auditor** (`check-application`): validates passport format and expiry against course + visa leave, date order, gaps, contact formats, English scores against your profile, referee emails and declared refusals before you touch a portal.
- **🗂️ Portal Manager** (`portals`, `portal set/open`): one dashboard of every portal, account, deadline, document and upload, with the single next action for each. UCAS deadlines are shown for undergraduate applicants.
- **⌨️ Form Filler** (`fill`, `portal open`): opens the portal in your own browser window and fills fields from `data/applicant.yaml` (UK date formats, split day/month/year, phone country codes, country lists). **You sign in, review and submit**; it never submits, pays or answers declarations.
- **🎤 Interview Prep** (`interview`, `interview-practice`): question banks for credibility/pre-CAS, Kira-style timed, technical finance, technical CS and academic panel interviews, plus a timed mock interview that scores typed answers and flags anything that contradicts your application.

**Phase 4: Financial engineering & scholarships**

- **🏅 Scholarship Matcher** (`scholarships`): checks Chevening, GREAT and Commonwealth rules in code (nationality, level, course length, work experience, grades, prior UK master's) and reports each window as open, closed or unannounced. University awards are found on each university's own site, and an award is kept only if its page confirms it.
- **🏦 Loan Docket** (`loan-docket`): works out the loan you need (cost of attendance − own funds − awards, in GBP and INR) and builds the exact document list for Credila, SBI or Prodigy Finance, adjusted for secured or unsecured loans and salaried or self-employed co-applicants. It also checks a sanction letter against UKVI's loan-letter conditions.

**Phase 5: UKVI visa compliance**

- **🎫 CAS Tracker** (`cas status/set`): every gate from offer to CAS (conditions, firm acceptance, deposit, ATAS, pre-CAS documents, finance check, credibility interview), with the blocking one as your next action and the dates that follow (ATAS ≈ 30 working days, CAS expiry, earliest visa date, TB validity).
- **💱 Proof of funds in INR** (`audit-funds --fx/--statements`): the exact GBP requirement converted to INR with an exchange-rate buffer (UKVI uses OANDA on the day you apply), then a **28-day audit of your real bank statement CSVs**. Balances are carried forward over days without transactions, accounts are summed, dips are listed day by day, and large credits inside the window are flagged.
- **🛂 Visa Filing** (`visa checklist/open`): documents with status, £558 fee + IHS for the full visa length (both paid inside the online application, so there's no separate IHS link), date gates, VFS biometrics steps, and the gov.uk application opened in your assisted browser.
- **🎤 Credibility prep**: `interview --type credibility` now drills modules, campus location, exactly who funds you, and consistency with your CAS.

**Phase 6: Post-arrival landing**

- **🏠 Accommodation** (`housing`): university halls and PBSA (Unite, iQ, Chapter, Vita, Homes for Students, Student Roost, Scape, CRM) near your campus. A listing is kept only if its own page confirms it, and a price only if the page states it. Each is priced against your living budget, with deposit-protection, guarantor and Right to Rent notes.
- **🛬 Arrival** (`arrival`): a dated checklist for the current rules. **BRPs are no longer issued** (your status is an eVisa in your UKVI account) and **police registration was abolished in August 2022**. What's left: enrolment and right-to-study check, GP, bank, council tax exemption, work-hour limits.

**Evaluation & visa**

- **🏛️ University Evaluator**: grades any Russell Group programme A–F (1.0–5.0) on admission probability, budget fit, ROI, programme fit and career outcomes.
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
# Claude access: sign in to Claude Code with your subscription (or set an API key, see below)
study-ops doctor
```

### On Windows (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS Git.Git        # once; then open a NEW PowerShell window
git clone https://github.com/Sharathanabattula/study-ops.git
cd study-ops
npm install
npx playwright install chromium                 # for portal / form filling
node bin/study-ops.js init
irm https://claude.ai/install.ps1 | iex          # installs the `claude` command (or: winget install Anthropic.ClaudeCode)
claude                                          # once: sign in with your Claude Pro/Max account, then type /exit
node bin/study-ops.js doctor                    # should say: AI steps use your Claude subscription
```

- Multi-line examples in this README use `\` at line ends (macOS/Linux). In PowerShell, use a backtick `` ` `` instead, or put the whole command on one line.
- If `npm` says *running scripts is disabled*, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use Command Prompt.
- `npm link` makes `study-ops` a command; otherwise run `node bin/study-ops.js …` from the folder.

Fill in `data/student_profile.md`, then:

| Command | Agent | Status |
|---|---|---|
| `study-ops doctor` | Setup check: Claude subscription / API key, Playwright | ✅ Ready |
| `study-ops init [--force]` | Workspace scaffold | ✅ Ready |
| `study-ops audit-profile` | 4 · Profile Auditor | ✅ Ready (offline) |
| `study-ops shortlist --subject <s> [--unis lse,ucl] [--urls …] [--max-per-uni 2]` | 5 · Safe / Target / Reach matrix → `reports/shortlist-<subject>.md` | ✅ Ready (needs API key) |
| `study-ops cost [url] [--tuition] [--duration] [--zone inner\|outer\|outside]` | 6 · Cost of attendance + ROI | ✅ Ready (offline with `--tuition`) |
| `study-ops match-syllabus <url> [--extra-url] [--modules-file]` | 7 · Syllabus Matcher → `reports/syllabus-<id>.md` | ✅ Ready (needs API key) |
| `study-ops evaluate <url>` | 1 · University Evaluator: A–F grade, 1.0–5.0 score, report in `reports/`, tracker updated | ✅ Ready (needs API key) |
| `study-ops master-sop [--words 1100] [--adopt] [--skip-interview]` | 8 · Master SOP → `outputs/sops/master.md` | ✅ Ready (needs API key) |
| `study-ops generate-sop --uni <name> --course <name> [--prof] [--module] [--lab] [--url] [--find-faculty]` | 2 · **Elite SOP** from `data/master_sop_raw.md` → `outputs/sops/SOP_<University>.md` | ✅ Ready (needs API key) |
| `study-ops tailor-sop --uni <name> --url <page> [--research-urls …] [--find-faculty] [--words]` | 2 · ≈30% rewrite of your master SOP with verified specifics → `outputs/sops/<uni>.md` | ✅ Ready (needs API key) |
| `study-ops lor [--only ids] [--programme]` | 9 · LOR drafts from `data/recommenders.yaml` → `outputs/lor/<id>.md` | ✅ Ready (needs API key) |
| `study-ops academic-cv [--resume file]` | 10 · Resume → `outputs/cv/academic_cv.md` | ✅ Ready (needs API key) |
| `study-ops check-application` | 11 · Application Data Auditor | ✅ Ready (offline) |
| `study-ops portals` · `portal set <id> …` · `portal open <id> [--register]` | 13 · Portal Manager | ✅ Ready (open needs Playwright) |
| `study-ops fill <url> [--overwrite]` · `form-pack` | 12 · Form Filler (assisted browser) / copy-paste sheet | ✅ Ready (Playwright; labels-only AI mapping) |
| `study-ops interview --uni --course --type <credibility\|kira\|technical-finance\|technical-cs\|academic\|general>` | 14 · Interview question bank → `outputs/interview/` | ✅ Ready (needs API key) |
| `study-ops interview-practice --uni --type [--count] [--prep] [--answer]` | 14 · Timed mock interview with feedback | ✅ Ready (needs API key) |
| `study-ops scholarships [--unis …] [--no-internal]` | 15 · Scholarship Matcher → `reports/scholarships.md` | ✅ Ready (university search needs API key) |
| `study-ops loan-docket --lender <credila\|sbi\|prodigy> [--app id \| --tuition]` | 16 · Funding plan + docket → `outputs/finance/` | ✅ Ready (offline) |
| `study-ops cas status <id>` · `cas set <id> …` | 17 · CAS gates and dates | ✅ Ready (offline) |
| `study-ops audit-funds … --fx <rate> --statements a.csv,b.csv` | 3 + 18 · PoF in INR + 28-day statement audit | ✅ Ready (offline) |
| `study-ops visa checklist [id]` · `visa open` | 19 · Visa filing pack → `outputs/visa/checklist.md` | ✅ Ready (open needs Playwright) |
| `study-ops housing --uni <name> [--campus] [--max-weekly]` | 20 · Verified accommodation → `outputs/arrival/` | ✅ Ready (needs API key) |
| `study-ops arrival [--course-start]` | 20 · Dated arrival checklist | ✅ Ready (offline) |
| `study-ops audit-funds --location <london\|outside> --duration <months> --tuition <gbp>` | 3 · UKVI Compliance Engine | ✅ Ready (deterministic) |

Without an API key, `evaluate`, `generate-sop` and `tailor-sop` still run in scaffold mode. The SOP commands then save a ready-to-paste prompt for any model.

### How Safe / Target / Reach is decided

For each programme, the **margin** is your percentage minus the minimum, in percentage points:

1. If the page states a minimum for your country (e.g. "65% from Indian universities"), that minimum is used. Confidence: high.
2. Otherwise the page's UK classification (e.g. 2:1) is converted to an estimated percentage for your institution tier. Confidence: medium.
3. The margin needed depends on the university's selectivity (`config/uk_universities.yaml`):

   | Selectivity | Safe | Target | Reach |
   |---|---|---|---|
   | standard | ≥ +8 | ≥ 0 | below minimum |
   | high (e.g. UCL, Warwick) | ≥ +12 | ≥ 0 | below minimum |
   | very high (Oxford, Cambridge, Imperial, LSE) | never | ≥ +5 | below +5 |

4. An English gap or active backlogs caps a programme at Target. A heavy backlog history moves selective programmes down one level.

**About "historical acceptance rates".** UK universities don't publish admit rates by applicant profile, and Study-Ops doesn't invent them. Consultancies rely on their own case history, and `data/outcomes.yaml` is where that goes. Once a university has **5 or more past applicants within ±5 points of your grade**, their admit rate decides the category instead (≥ 70% Safe, 40–69% Target, < 40% Reach), and the report says so.

**Grade conversion is a heuristic.** Indian CGPA → percentage uses the formula you set (`aicte`, `cbse`, `x10` or a custom formula from your transcript). Percentage → UK class uses editable tier bands in `config/grade_equivalence.yaml`. A university's own India table always overrides both.

### How the documents stay truthful

Admissions tutors notice invented details: a professor who isn't on the staff list, a metric that's too neat, a referee describing things they never saw. Every Phase 2 agent therefore writes from your files only, and code (not the model) checks the result:

| Check | Where | What happens |
|---|---|---|
| **Numbers**: every figure must appear in your profile, statement, interview answers, recommender evidence or resume | all four | Flagged and sent back for revision; anything left is listed in the output |
| **Names**: professors, labs and modules must appear on an official page Study-Ops fetched | SOP commands | Unconfirmed names are dropped before drafting and flagged if they reappear |
| **Elite rules**: banned openings/words (from the framework file), Rule 3 names present in the final body paragraph | all SOP commands | Sent back for revision; anything left is listed in the output |
| **Tailoring ratio**: word-level diff against the master, aiming for ≈30% (20–45% band) | tailor-sop | Revised if outside the band; the final ratio is printed |
| **Distinctness**: 4-gram overlap between every pair of LORs | LOR drafter | Letters that sound alike are rewritten |
| **Publications**: each title must be in your resume | Academic CV | Listed for removal |

**The Elite SOP Constraints** live in `data/templates/elite_sop_framework.md`, copied from `templates/` by `init`. The file is used verbatim as the system prompt for `generate-sop`, `tailor-sop` and `master-sop`. Its **Banned openings** and **Banned words** lists are parsed by code, so editing the file changes both what the model is told and what the checker enforces. Rule 3 needs a module, a professor and a lab or facility. Pass them with `--module`, `--prof` and `--lab`, or give `--url` (plus `--find-faculty`) and Study-Ops fills any gaps from names confirmed on official pages. If one is missing, the statement leaves it out and tells you, rather than inventing one.

Put your raw story (milestone, projects, work, turning point, goals) in `data/master_sop_raw.md`. Write facts, not prose: every number in the final essay must come from there or from your profile.

**The master SOP interviews you.** `master-sop` first plans the narrative. If an essential piece is missing (the moment you noticed the problem, what you actually did), it writes the questions to `data/sop_interview.md` and stops. Answer them there and run it again.

**About LORs.** A reference is the recommender's own testimony. Study-Ops gives each recommender a briefing and a starting draft built only from the `evidence` you list for them. They should rewrite it in their own words, correct anything inexact, and submit it themselves. Many UK universities collect references directly from referees, and some ask applicants not to draft them, so check each programme.

### How portals and forms work (Phase 3)

Study-Ops is an assistant in your browser, not a bot acting for you.

1. `study-ops check-application` must show **0 errors** first. Fix `data/applicant.yaml` until it does.
2. `study-ops portal set <id> --url <login> --registration-url <signup>` stores the portal (never a password).
3. `study-ops portal open <id> --register` opens a real Chromium window with its own saved profile for that site. Study-Ops pre-fills the sign-up form. **You** choose the password (in your password manager), solve the CAPTCHA, verify your email and click create. Then run `portal set <id> --account-created --applicant-id …`.
4. `study-ops portal open <id>`: sign in, go to a form page, press Enter in the terminal. Fields are filled and outlined **blue**. Fields that need you (declarations, criminal record, health, equality monitoring, unsure matches, anything already filled) are outlined **amber**. Repeat page by page. **You** check every value and submit.

**Your data stays local.** Claude maps form labels to keys in a fixed catalog (`Passport number` → `passport.number`). It never sees the values, which are filled by code on your machine; a test enforces this. Mappings are cached per form in `data/forms/`, so repeat visits don't call Claude at all. For portals that block automation, `study-ops form-pack` writes a copy-paste sheet in UK formats.

Install the browser once: `npm install playwright && npx playwright install chromium`. To use an existing Chrome, set `STUDY_OPS_CHROMIUM=/path/to/chrome`.

**Interviews.** `interview` writes likely questions with answer outlines built from your files, plus worked answers for technical rounds. Timings are typical defaults (Kira-style: 45s to prepare, 90s to answer). Every school configures its own, so match your invitation with `--prep` / `--answer`. In credibility interviews, consistency with your application matters most, so practice feedback flags any claim or figure that isn't in your files.

### Money and visa: what's checked, and how fresh it is

| Topic | Source of truth | Last checked |
|---|---|---|
| Scholarship rules and windows | `config/scholarships.yaml` | 22 Oct 2026. Chevening 2027-28 closed 6 Oct 2026; GREAT 2026-27 closed; Commonwealth (India) closes mid-Oct via the Ministry of Education |
| Lender documents | `config/lenders.yaml` | Typical lists; confirm with your loan officer |
| Visa fee £558, IHS £776/yr, TB test, ATAS, eVisa | `config/ukvi_rules.yaml` | 22 Oct 2026 |
| Exchange rate | `--fx`, else the live ECB reference rate | UKVI uses OANDA on your application date, so keep the buffer |

**The 28-day audit runs on your real statements.** Export CSVs from net banking (SBI, HDFC, ICICI and Axis formats are recognised by column name) and run:

```bash
study-ops audit-funds -l london -d 12 -t 38000 --deposit 5000 --apply-date 2027-07-01 \
  --fx 112 --statements data/statements/sbi.csv,data/statements/hdfc-fd.csv
```

A CSV row whose amounts contain unquoted commas stops the audit with an error rather than being guessed. In a funds check, a wrong number is worse than no number.

**Not immigration advice.** Study-Ops is a self-service tool. For advice on your case, use your university's international student advisers or an adviser regulated by the Immigration Advice Authority (IAA).

### Connecting Claude: subscription or API key

**Option A: your Claude subscription (Pro/Max), the career-ops way. No API key needed.**

1. Install the Claude Code command line (`irm https://claude.ai/install.ps1 | iex` on Windows, `curl -fsSL https://claude.ai/install.sh | bash` on macOS/Linux), run `claude` once and sign in. Claude Code needs a **Pro, Max, Team or Enterprise** plan; the free plan doesn't include it. The desktop app alone isn't enough: Study-Ops calls the `claude` command.
2. Leave `ANTHROPIC_API_KEY` unset. Run `study-ops doctor`, which should report *AI steps use: your Claude subscription*.

Every AI step then runs through `claude -p` (Claude Code's headless mode) and counts against your plan's usage limits instead of API billing. Study-Ops runs it from a temporary folder with no session history; writing calls get no tools, and search calls get only WebSearch/WebFetch. Every name, URL and number still passes the same local verification. A full 24-university shortlist uses a fair share of a plan's limits, so use `--unis` to batch it.

**Use it inside Claude Code, like career-ops.** Open this folder in Claude Code (desktop or terminal) and ask in plain English: *"audit my profile"*, *"shortlist finance programmes at LSE, UCL and Warwick"*, *"write my Imperial SOP"*. Claude Code follows `CLAUDE.md` and the `/study-ops` skill to run the right commands. `.claude/settings.json` stops it from reading `data/applicant.yaml`, `data/finance.yaml`, `data/visa.yaml`, bank statements and `.env`; the CLI reads those locally.

> Use your subscription for your own applications. If you run Study-Ops for other people (for example as a consultancy), each person should sign in with their own account, or you should use an API key.

**Option B: an API key (pay per use).** Create one at <https://platform.claude.com/settings/keys>, `cp .env.example .env` and set `ANTHROPIC_API_KEY=sk-ant-...`. Optional: `STUDY_OPS_MODEL` (default `claude-opus-5-5`). If both are available the key wins; set `STUDY_OPS_PROVIDER=claude-code` to prefer the subscription.

How the API integration behaves:
- **Pages are fetched on your machine.** Only the page text, your profile and your statement are sent to Anthropic.
- **Structured outputs.** Requirements, scores and critiques come back validated against Zod schemas, so they can't be malformed.
- **The arithmetic isn't the model's.** IELTS band gaps, tuition vs budget and UKVI living costs are computed in code and handed to Claude as facts.
- **Prompt caching.** Your profile and master statement are cached across the SOP draft → critique → revise calls.
- **Server-side fallbacks** are on (`fallbacks: "default"`). If a request is declined, the API retries it on Anthropic's recommended fallback model. A request declined by every model shows a clear error.

On a subscription these count toward your plan's usage limits rather than costing money. With an API key, rough cost on Opus 5.5 ($4 / $20 per million tokens), depending on page length, is: **about $0.05–0.25 per evaluation**, **$0.10–0.25 per syllabus match**, **$0.20–0.50 for the master SOP**, **$0.30–0.80 per tailored SOP with `--find-faculty`**, **$0.20–0.50 for a set of 3 LORs**, **$0.05–0.15 per CV**, **$0.05–0.20 per interview bank** and **about $0.02–0.05 per practice answer**, **under $0.01 to map a new form** (cached after the first time), **$0.10–0.40 per university awards search** and **$0.15–0.50 per accommodation search** (web search included), and **roughly $5–12 for a full 24-university shortlist** at 2 programmes each. That last figure includes web search at $10 per 1,000 searches. These are estimates, not measurements. Page extractions are cached for 30 days, so re-runs cost much less. Use `--unis` to keep a shortlist small.

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
  2_sop_tailor.js                generateTailoredSOP (Elite engine) + master-based ≈30% tailoring
  3_ukvi_compliance_engine.js    funds, 28-day rule, CAS guardrails (pure functions)
  4_profile_auditor.js           CGPA → % → UK class / US GPA, backlogs, English (pure)
  5_shortlist_matrix.js          discover → extract → Safe/Target/Reach → report + tracker
  6_cost_roi_mapper.js           cost of attendance, budget fit, payback (pure)
  7_syllabus_matcher.js          UG modules vs programme prerequisites
  8_master_sop.js                narrative plan → interview → draft → critique → revise
  9_lor_drafter.js               distinct-angle LOR briefings + drafts, overlap check
  10_academic_cv.js              resume → UK academic CV, fact checks
  11_application_auditor.js      applicant.yaml validation + profile cross-checks (pure)
  12_form_filler.js              DOM field extraction → labels-only mapping → local fill
  13_portal_manager.js           portal dashboard, next actions, assisted sessions
  14_interview_prep.js           question banks + timed practice with feedback
  15_scholarship_matcher.js      external scheme rules + verified university awards
  16_loan_docket.js              funding gap, lender dockets, UKVI loan-letter checks (pure)
  17_cas_tracker.js              offer → CAS gates and dates (pure)
  18_statement_auditor.js        bank CSV parsing, carry-forward balances, 28-day audit (pure)
  19_visa_filing.js              visa documents, fees, date gates, assisted gov.uk session
  20_arrival_planner.js          verified accommodation + dated arrival checklist
src/llm/claude.js                the only module that calls an LLM: picks subscription or API
src/llm/claude_code.js           subscription provider: headless `claude -p` with JSON schemas
CLAUDE.md, .claude/              Claude Code project instructions, /study-ops skill, privacy deny rules
src/lib/programme.js             shared, cached programme-page extraction (data/programmes/)
src/lib/specifics.js             modules, faculty and labs, verified on official pages
src/lib/factcheck.js             number, name, overlap and change-ratio guards
src/lib/sop_framework.js         loads the Elite framework; enforces its rules in code
src/lib/                         paths, Markdown/YAML state, profile, registry, tracker, page fetcher
src/ui/theme.js                  terminal design system (palette, panels, rows)
src/commands/init.js             workspace scaffold + onboarding
config/ukvi_rules.yaml           dated UKVI financial rules (edit when gov.uk changes)
config/uk_universities.yaml      24 Russell Group members: domains, UKVI location, selectivity, SOP tone
config/grade_equivalence.yaml    CGPA formulas, UK class bands by tier, US GPA, English tiers
config/living_costs.yaml         monthly living costs: inner / outer / outside London
config/portals.yaml              application routes; UCAS cycle deadlines
config/scholarships.yaml         Chevening / GREAT / Commonwealth rules and dated windows
config/lenders.yaml              Credila / SBI / Prodigy document dockets
templates/                       pristine copies used by `init` (incl. elite_sop_framework.md)
data/                            YOUR state (git-ignored)
reports/, outputs/                agent output (git-ignored)
```

**State model**
- `data/student_profile.md`: YAML front-matter holds machine-read facts (CGPA, IELTS bands, budget, shortlist). The Markdown body holds your narrative. Agents parse both: `##` sections are indexed by heading.
- `data/master_sop_raw.md`: raw material for every statement.
- `data/templates/elite_sop_framework.md`: your editable copy of the Elite SOP Constraints.
- `data/recommenders.yaml`: 2–3 recommenders, each with the evidence they personally observed.
- `data/resume.md`: your current resume, pasted as text.
- `data/applicant.yaml`: 🔒 passport, contact, education, employment, referees, immigration history. Local code only.
- `data/finance.yaml`: 🔒 own funds, awards, co-applicants, collateral, loan sanction, documents collected, proof-of-funds accounts.
- `data/visa.yaml`: 🔒 TB test, parental funds, application references (GWF, IHS), VFS appointment, arrival status.
- `data/browser/`, `data/forms/`: assisted-browser profiles (signed-in sessions) and cached form mappings.
- `data/sop_interview.md`: questions from `master-sop`, answered by you.
- `data/outcomes.yaml`: past admission results (anonymous) that turn the matrix into a data-driven one.
- `data/tracker.yaml`: one entry per programme, with a status lifecycle running from `researching` through `cas_issued`, `visa_granted` and `enrolled`.

**Privacy.** `data/`, `reports/` and `outputs/` are git-ignored. Set `STUDY_OPS_HOME` to keep them somewhere else, such as an encrypted volume. Nothing is sent to an LLM until you add an API key, and then only for `shortlist`, `evaluate`, `match-syllabus`, `cost <url>` and the Phase 2 document commands. `audit-profile`, `audit-funds` and `cost --tuition` never leave your machine.

## Development

```bash
npm test            # node:test: rules engines, conversions, matrix, and every LLM pipeline against a recorded HTTP layer
STUDY_OPS_DEBUG=1   # print stack traces
```

## Roadmap

- ~~**0.2** Claude provider, evaluator extraction and scoring, SOP generate → critique → revise.~~ ✅
- ~~**0.3** Phase 1 intake: profile audit, Safe/Target/Reach matrix, cost & ROI, syllabus matching.~~ ✅
- ~~**0.8** Run on a Claude subscription via Claude Code (no API key); CLAUDE.md + /study-ops skill; Windows CI.~~ ✅
- ~~**0.7** Phases 4–6: scholarships, loan dockets, CAS gates, INR proof of funds, statement audit, visa filing, accommodation, arrival.~~ ✅
- ~~**0.6** Phase 3 execution: application auditor, portal manager, assisted form filling, interview prep.~~ ✅
- ~~**0.5** Elite SOP engine: framework-as-system-prompt, `generate-sop --prof --module --lab`, rule checks in code.~~ ✅
- ~~**0.4** Phase 2 positioning: master SOP, ≈30% tailoring with verified specifics, distinct LORs, academic CV.~~ ✅
- **1.2** `study-ops tracker` (status board, deadline alerts), CAS checklist agent.
- **2.x** More countries (Canada, Australia, Germany), dependants and sponsor modelling.

## License

MIT © Sharath Chandra Anabattula

---

Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). For privacy and vulnerability reporting, see [SECURITY.md](SECURITY.md).
