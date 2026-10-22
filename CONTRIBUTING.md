# Contributing to Study-Ops

Thanks for helping make studying abroad less painful.

## Ground rules

1. **Privacy first.** Never commit anything from `data/`, `reports/` or `outputs/`. Use made-up values in issues, tests and examples.
2. **No invented rules.** Every UKVI figure in `config/ukvi_rules.yaml` needs an official source (gov.uk or a Statement of Changes). Mark rates that are announced but not yet in force with `status: announced`.
3. **Deterministic where it matters.** Money, dates and visa rules belong in pure, tested functions, not in LLM prompts.
4. **Agents never fabricate.** The evaluator and SOP tailor may only use facts from the student's own files and the programme page.

## Setup

```bash
git clone https://github.com/Sharathanabattula/study-ops.git
cd study-ops
npm install
npm test
```

## Layout

- `src/agents/`: one file per agent, numbered in pipeline order, with an exported async entry point and JSDoc describing the intended logic.
- `config/`: data the agents read (UKVI rules, Russell Group registry). Edit these when the real world changes.
- `templates/`: pristine copies of user files used by `study-ops init`.

## Adding a new agent

1. Create `src/agents/<n>_<name>.js`, exporting an async function plus any pure helpers.
2. Register a command in `bin/study-ops.js`. Keep it to parsing and rendering only.
3. Add tests under `test/`.

## Commit style

Use short imperative subjects, e.g. `Add CAS checklist agent` or `Update UKVI rates for Nov 2026`.
