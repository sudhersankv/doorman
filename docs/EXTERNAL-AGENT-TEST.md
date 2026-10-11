# External-agent test (evidence log)

Goal: establish whether a browser agent that was **not** written against Doorman can discover and use it.

## Setup
- Site under test: Trailhead Outfitters served by Doorman (`/shop/`), local server (`http://localhost:3000`),
  real services (Atlas sandbox, Jev, Neon AI Gateway), active harness config v1. Run on 2026-10-11, ~2:05–2:11 PM PT.
- External agent: **Claude, operating the Claude desktop app's built-in browser** through generic browser tools
  (navigate, read the page's accessibility tree, find elements, click, type, run JavaScript). None of these tools
  know anything about Doorman; the agent sees exactly what any DOM-reading browser agent sees. The agent is not
  the Playwright benchmark agent in `src/sim/` and shares no code with it.
- What this is **not**: a WebMCP-native agent. `document.modelContext` was `undefined` in the test browser, so
  genuine WebMCP discovery could not be exercised (see Limitations).

## Test A — automatic discovery (no mention of Doorman)
Instruction given to the agent: *"Find running shoes under $80 and add an appropriate pair to my cart."* plus the URL.

Result: **ordinary DOM browsing — Doorman bypassed.**
The agent read the catalog page, found the Road Racer ($72) product card, opened it, selected size 9 and clicked
"Add to cart" on the DOM directly (~0.5 s). It never looked for agent tools, never called `window.doorman`, and
never hit `/api/decide`. Nothing was logged in `visits`; the owner's analytics did not change.
This is the expected behaviour for today's browser agents: they succeed on an easy page without needing the
harness, and the owner learns nothing about the visit.

## Discovery inspection (what an agent *can* find)
Checked from the page context before Test B:
- `window.doorman` — present, an object exposing `do(goal)`, `tools` (`trailhead_outfitters`, `search_products`,
  `search`, `cart_1`, …), `map()`, `manifest`.
- `/.well-known/doorman.json` — served; `endpoints` present; `toolCount: 0` until the first `map()` runs on a page.
- `<meta name="agent-tools">` — present in `/shop/index.html`.
- `document.modelContext` — **undefined** (no native WebMCP in this browser).

## Test B — explicit discovery
Instruction: same goal, plus *"inspect the website for any available agent tools or capabilities and use them if present."*

Result: **manifest / page-object discovery (explicit-discovery grade).** The agent found `window.doorman` and
delegated in natural language via `window.doorman.do(goal)`. Two runs:

| Goal | Outcome | Time | Steps | Tiers | visitId |
|---|---|---|---|---|---|
| "Find running shoes under $80 and add an appropriate pair to my cart." | **failed** (`not_found`) | 15.2 s | 10 | 9 × T2_llm, 1 × T1_jev | `cf427ab9-…` |
| "Add the Road Racer in size 9 to my cart." | **success** | 1.5–1.6 s | 3 | 3 × T1_jev (conf 0.94–1.00) | `d466d7a5-…` |

- Run 1 is a real failure, kept in the record: the vague goal ("appropriate pair", "under $80") made Jev's confidence
  drop below threshold on every step, each step fell to the LLM, and the agent looped on the search box instead of
  opening a product. The verifier correctly reported `failed / not_found` (the cart was unchanged).
- Run 2 is the harness working as designed: a specific goal, three System-1 decisions, no LLM calls, cart verified
  from shop state to contain Road Racer size 9, outcome `success`, and a recipe written for the goal.
- Individual tools (`doorman.tools.*`) were listed but not invoked; the agent chose natural-language delegation.

## Test C — owner analytics
Queried `GET /api/analytics?site=trailhead` after the visits.

Result: **captured.** `visits.n` went 19 → 21. Both external visits appear in `recent` with goal text, outcome,
failure reason, latency, step count and `configVersion: 1`:
- `Add the Road Racer in size 9 to my cart.` — success, 1469 ms, 3 steps, 21:10:31Z
- `Find running shoes under $80 …` — failed / `not_found`, 15206 ms, 10 steps, 21:10:16Z

The failed goal also surfaces in `unmet` (unmet-demand list) and in `failures.byReason.not_found`. The `/dashboard/`
page reads this same endpoint, so the owner sees the external visit without any extra wiring.

Headline numbers at that moment (observed, not estimated): success 68% (n=19 possible), median 2.1 s, p90 6.2 s.
These include earlier benchmark visits on the same site; see Limitations.

## Classification
- **genuine WebMCP discovery** — *not demonstrated.* `document.modelContext` is unavailable in the test browser and
  no public agent speaks WebMCP yet. `doorman.js` feature-detects it and registers tools when present, but that path
  has only been exercised by the unit test with a fake `modelContext`.
- **manifest / page-object discovery** — *demonstrated* (Test B). An agent told to look for capabilities found
  `window.doorman` and used `do()`. This is explicit-discovery grade, not a custom integration: no Doorman-specific
  code was given to the agent.
- **ordinary DOM browsing** — *demonstrated* (Test A). Without a hint, the agent bypassed Doorman entirely.

## Limitations to disclose
1. The "external agent" is Claude driving a generic browser; it is not a third-party product. It is external to the
   benchmark code, not external to the author.
2. Visits are not tagged by origin. External and benchmark visits share the `visits` collection and are distinguished
   here by timestamp and goal text, not by a `source` field. (Easy to add; not done today.)
3. Only two external runs; one failed. The vague-goal failure is a real weakness of the current config, not noise.
4. WebMCP-native discovery is untested outside unit tests.
5. The sign-in / checkout flows were not exercised by the external agent.
