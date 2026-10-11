# doorman — pitch & Q&A (final). Every number below is measured and has a file behind it.

## What it is, in one breath
A handoff layer at a website's door. One script tag maps the page into **tools** and exposes them to visiting AI
agents three ways (WebMCP `document.modelContext`, a `/.well-known/doorman.json` manifest, `window.doorman`). The
agent decides: call a tool directly with zero inference, or hand off a goal in plain language and let the harness
drive — one Jev decision per step in a few hundred milliseconds, LLM only as a fallback. Everything — maps,
visits, steps, recipes, benchmarks, harness versions — lives in MongoDB Atlas, and the owner gets intent analytics
out of it. On top sits the optional recursive loop: the harness edits its own config, tests it on held-out goals,
and keeps only what measures better.

## 30 seconds
AI agents visiting websites re-read the page on every step and call an LLM every time, and the site owner never
learns what they wanted. doorman is a script tag that turns the page into tools, lets an agent call them directly or
hand off a goal, remembers every visit in Atlas, and shows the owner the intent. Same goal, same fresh cart, live:
an ordinary LLM browser agent took 6.1 s and 4 LLM calls; doorman took 1.6 s and zero. Across 23 held-out goals
doorman made 4× fewer LLM calls at 1.6× the speed. And it tries to improve itself — honestly: every candidate it
proposed today was benchmarked and rolled back, and that record is in the database.

## Measured numbers (sources in brackets)
- **Live A/B, one goal** [`video/raw/ab.json`]: ordinary LLM agent reached the goal in 6.1 s, 4 steps, 4 LLM calls,
  $0.0010 measured; doorman reached it in 1.6 s, 3 steps, 0 LLM calls, 4 Jev calls, ~$0.0003 estimated.
- **Matched benchmark, 23 held-out goals, both agents** [`data/compare.json`, Atlas `comparisons`]: possible goals
  reached — baseline 100% (14/14), doorman 93% (13/14); median 8.0 s vs 4.9 s; mean steps 7.0 vs 4.6; LLM calls
  161 vs 39; cost $0.045 measured vs $0.038 estimated. **Neither agent declines the 9 impossible goals** (0% / 0%):
  both loop to their step limit. That is the first thing to fix.
- **Owner analytics** [`/api/analytics`, Atlas `visits`]: 51 visits at recording time, 64% of decided visits
  succeeded, median 2.4 s, Jev decided 64% of steps, LLM 32%, recipes 4%.
- **External-agent test** [`docs/EXTERNAL-AGENT-TEST.md`]: with no hint, Claude's browser agent bypassed doorman
  and used the DOM; told to look for capabilities, it found `window.doorman` and delegated — one vague goal failed,
  one specific goal succeeded. WebMCP-native discovery could not be tested (no browser exposes it yet).
- **Recursive evolution** [`/evolution`, Atlas `harness_configs`]: see the final table in README.md. Rolled-back
  versions are kept as evidence.

## 3 minutes (judging round)
1. **Problem (20 s).** Agents re-read the page every step; owners see nothing.
2. **The handoff layer (40 s).** `/shop/` → HUD → *tools*: 35 tools exposed from this page, discovery paths listed.
   Call `size(9)` and `add_to_cart()` directly: zero inference, cart verified. Then hand off a goal: three Jev steps, 1.5 s.
3. **A/B (40 s).** The split-screen: same goal, fresh cart, ordinary LLM agent vs doorman, live timers. Then the
   23-goal table — including the row where both score 0%.
4. **Memory + analytics (30 s).** `/dashboard/`: what agents asked for, where the site stopped them, what to fix first.
5. **Recursive evolution (40 s).** `/evolution/`: editor proposes a JSON patch, code validates, held-out goals decide.
   Today's verdicts. "It measured, and refused to keep what didn't help."
6. **Honesty + next (10 s).** Mock shop, simulated plus one real external agent, best case. Next: decline impossible
   goals, WebMCP-native agents, real traffic.

## Judge angles
- **MongoDB:** six collections, one database: `site_maps`, `visits`, `recipes` (Vector Search, voyage-4-lite),
  `runs`, `harness_configs` (versioned, parent links), `comparisons`. Sandbox cluster.
- **Raindrop / recursive self-improvement:** real loop, real verdicts, rollbacks stored, a regression test that
  proves candidates are actually executed (`test/e2e/version-selection.test.js`).
- **Typesafe / Jev:** one typed decision per step, calibrated confidence gates the LLM fallback.
- **Generic by construction:** no site vocabulary in `doorman.js`, `src/harness/`, `src/lib/`; a clinic fixture runs unchanged.

## Likely questions
- *Why not just WebMCP?* We register with it when present; no shipping browser exposes it yet, so the manifest and
  page object are the discovery paths that work today.
- *Isn't the baseline weak?* It is a competent generic agent (100% on possible goals). doorman wins on speed and LLM
  calls, not on success rate — and we say so.
- *Did evolution improve anything?* Not today. The loop ran for real; the seed held. We show that as regression
  protection, because a loop that only ever "improves" is the one to distrust.
- *Cost numbers?* Baseline cost is measured from token usage. doorman's is an estimate from step counts, labelled
  as such everywhere it appears.
