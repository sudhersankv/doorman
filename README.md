# Doorman

**A self-improving harness at a website's door.**

One script tag maps a site into tools for visiting AI agents. A System 1 model (Jev) makes each decision in a few
hundred milliseconds. Every visit is remembered in MongoDB Atlas. And the harness **rewrites itself**: after a batch
of visits it edits its own tools, context policy, guardrails and rules, tests the new version on held-out goals, and
keeps only the changes that measurably help. Every version, patch and verdict is stored.

Built in one day at the MongoDB *Harness Engineering & Model Wrangling* hackathon (SF Tech Week, Oct 11 2026),
for **Problem Statement 1: Recursive Harnessing**. Everything in this repository was written during the event.

## What evolves

| Statement 1 asks for | In the harness config (`harness_configs`, one versioned document per site) |
|---|---|
| rules | `rules[]`, learned recipes, the fast model's instructions, when to hand a step to the LLM |
| context policies | which page fields the model sees, how much history, how many recipes |
| guardrails | the confirmation list (append-only), max steps, confidence thresholds |
| tool access | which page actions are exposed, their descriptions, preconditions |

The engine reads the active version on every step. "Rewriting itself" means writing version *n+1* with a parent link.
The code never changes.

## How a visit works

```
agent ─ doorman.do(goal) ─► doorman.js (page snapshot: actions, items with numbers+units, messages)
                                   │  POST /api/decide
                                   ▼
                       engine: T0 requested tool → T1 recipe (Atlas Vector Search) → T1 Jev (one decision / step)
                               → T2 LLM only when Jev's confidence is below the configured threshold
                               confirmation gate for consequential actions enforced in code
                                   │  next action + params
                                   ▼
                       doorman.js executes on the DOM, waits for the page to settle, re-snapshots … repeat
                                   │  POST /api/visit
                                   ▼
                       Jev verifies the outcome + classifies the failure → visits (episodic memory)
                       success → recipe (procedural memory)
```

## How it improves itself

```
run training goals on config vN ─► worst traces + metrics ─► editor LLM proposes ≤3 JSON-patch edits
        ─► code validates (allowed paths, bounds, confirm list append-only, checkout never removable)
        ─► config vN+1 ─► run held-out goals ─► kept (becomes active) or rolled back ─► both stored
```

Held-out goals are reworded and include situations not in training, so a kept change is generalization, not memorization.

## Generic by construction

`public/doorman.js`, `src/harness/` and `src/lib/` contain no site vocabulary. The mapper reads the accessibility
tree (roles and names), groups repeated structures into items, and extracts numbers with their units (`$72`, `4.7 ★`,
`9:30 AM`). Constraints like "under $80" or "after 2pm" are parsed generically and applied by unit. The same script
runs unchanged on the second fixture site (a clinic booking page, `test/fixtures/clinic.html`).

## Benchmark (honest by design)

- Mock shop *Trailhead Outfitters* with four planted flaws (the answer key): an out-of-stock size, a ZIP validation
  bug, a sign-in link buried in the footer, and product lines the shop doesn't carry.
- 60 goals from templates (objective truth) with LLM-written phrasings in several voices; 40 train / 20 held-out.
- Outcomes verified by inspecting the shop's own state, never by an LLM judge.
- Three kinds of failure reported separately: possible-but-agent-failed, possible-but-site-made-it-hard, impossible.
- Metrics: success on possible goals, fast correct "no" on impossible goals, median time, LLM-fallback rate, recipe hits.

Traffic is simulated (Playwright agents) on a site we built. Real sites will score lower; the next step is real agent traffic.

## Results (final run, real services, held-out goals)

| | v1 cold | v4 active |
|---|---|---|
| Success on possible goals | 93% | 93% (from an 86% same-conditions baseline) |
| Median time per goal | 4.0 s | 2.8 s |
| Steps decided by the LLM | 30% | 28% (the rest by Jev and recipes) |
| Generations | 3: 1 kept, 2 rolled back, $0.003 of LLM | |

Kept edit (v4): rewrote the fast model's instructions, added `checkout` to the confirmation list, added a form-validation rule.
Rolled back: raising the confidence threshold (slower), a search-synonyms description with a lower threshold (one more failure).

## Run it

```
npm install                      # mongodb + playwright only; the server is node:http
cp .env.example .env             # Atlas (hackathon sandbox), Voyage, Jev, Neon AI Gateway
npm run setup-db                 # collections + two vector indexes
npm run check                    # one call to each service
npm run goals                    # 60 goals with LLM phrasings (data/goals.json + Atlas)
npm run dev                      # http://localhost:3000/shop/   and   /evolution/
npm run bench -- --split heldout --config 1
npm run evolve -- --site trailhead --generations 3
npm test                         # 70 tests, all offline against fakes
```

`run-pipeline.bat` runs all of the above in order on Windows.

## Layout

```
public/doorman.js        the script tag: mapper, executor, window.doorman, WebMCP registration (feature-detected)
public/shop/             mock shop with planted flaws (benchmark rig, not part of the harness)
public/evolution/        the evidence page: versions, patches, verdicts, metrics
server.js                node:http — /api/decide, /api/visit, /api/map, /api/config, /api/evolution, /.well-known/doorman.json
src/lib/                 service interfaces + fakes: Jev, Voyage embeddings, Neon LLM (budget, backoff), Atlas
src/harness/config.js    versioned config, validatePatch, applyPatch
src/harness/engine.js    decision tiers, state builder, confirm gate, repeat guard, alert hint, outcome verification
src/harness/constraints.js  generic numeric constraints and free-text candidates
src/harness/recipes.js   learned step sequences (Atlas Vector Search)
src/harness/visits.js    episodic memory, worst traces, metrics
src/harness/editor.js    the improvement loop; evolve.js is its CLI
src/sim/                 goal templates + paraphrases, Playwright agent, runner, metrics, verifier
test/                    unit tests per module, e2e with the real doorman.js in Chromium
CONTRACTS.md             the module contracts every part was built against
```

## Security boundaries

The page holds only a public site id; all keys stay on the server. Every query is filtered by site. Consequential
actions (pay, order, submit, book, delete) always stop for confirmation; the editor can add to that list but never
remove from it, and thresholds are bounded. The editor only proposes patches; code validates and the benchmark decides.
