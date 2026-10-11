# Doorman — Plan v2 (Sun Oct 11, 2026) · Problem Statement 1: Recursive Harnessing

> **Doorman is a self-improving harness at a website's door.** It learns from every visiting AI agent —
> what they came to do and where they got stuck — and rewrites its own rules, context policy, guardrails
> and tool access so the next agent gets through faster. Every version lives in MongoDB Atlas.

Repo: https://github.com/sudhersankv/doorman (public). Local: `D:\mongodb-hackathon`.
Event: Shack15, hacking 10:45 → **submissions due 5:00 PM** (1-min video + public repo + demo link).
Judging: R1 ~3 min live demo + Q&A — Technical demo 35% · Difficulty 30% · Impact 20% · Creativity 15%. R2 top 6 on stage, equal weights.
Prizes: $7k/$5k/$3k + **Raindrop RSI prize $3k** (recursive self-improvement — this is us).

## 0. Rules that shape everything
- **Statement 1:** harness must evolve its own rules, context policies, guardrails, tool access. → the improvement loop is the core, not a stretch.
- **Finalists must build on the hackathon Atlas Sandbox cluster.** → swap `MONGODB_URI` to the sandbox before anything is stored. (In progress: need the sandbox cluster host.)
- **Public repo, new work only.** `.env`, `atlas-credentials.env`, test scripts = setup, never shown as the product. `.gitignore` covers secrets.
- **"Any project where a dashboard is the main feature" is banned.** → owner view = one small "evolution" page, shown last for 10 s.
- Demo must show only what was built today. Say so on camera.

## 1. What we build

```
Visiting agent ─ doorman.do(goal) ─► doorman.js (page) ─ page state ─► /api/decide (server)
                                                                            │
                               ┌─ harness_configs (active version) ◄────────┤  reads config every step
                               │  tools · context policy · guardrails ·     │
                               │  jev instructions · thresholds             ▼
                               │                                     Tier 0 specific tool → execute
                               │                                     Tier 1 recipe (vector) → Jev fills blanks
                               │                                     Tier 1 Jev loop, 1 decision / step (~400 ms)
                               │                                     Tier 2 Jev conf < threshold → LLM for that step
                               │                                            │
                               │                      execute on DOM ◄──────┘   confirm-allowlist in CODE
                               │                            │
                               │               Jev verify + failure_reason → visits (episodic)
                               │               success → recipes (procedural)
                               │
   IMPROVEMENT LOOP (batch) ───┘
   run N train goals → editor LLM reads worst traces + config → JSON patch → validated → config v+1
   → run held-out goals → keep if better, else roll back → every version + verdict stored in Atlas
```

**What evolves (Statement 1 mapping):**
| Statement 1 | In the harness config | Example edit the loop can make |
|---|---|---|
| rules | recipes, step-order rules, Jev `next` instructions, fallback policy | "select size before add_to_cart" · "payment steps → LLM" |
| context policies | which page fields Jev sees, history length, recipes top-k | add `stock_badge` · history 5→3 |
| guardrails | confirm list, maxSteps, confidence threshold | add `apply_coupon` to confirm · threshold 0.70→0.75 |
| tool access | which tools each page exposes, preconditions, descriptions | hide `track_order` until logged_in · reword size picker |

**Harness config document (one per site, versioned, in Atlas):**
```json
{ "siteId":"trailhead", "version":3, "parent":2, "active":true, "createdBy":"editor",
  "tools": { "select_size": {"exposed":true, "description":"Choose a shoe size. Do this before Add to cart."},
             "track_order": {"exposed":true, "precondition":"logged_in"} },
  "context": { "includeFields":["title","price","stock_badge"], "historySteps":3, "recipesTopK":3 },
  "jev": { "nextInstructions":"Pick the action that moves closest to the goal on THIS page.", "confidenceThreshold":0.70 },
  "guardrails": { "confirm":["checkout","place_order"], "maxSteps":8 },
  "rules": ["select_size before add_to_cart"],
  "eval": { "trainSuccess":0.62, "heldoutSuccess":0.70, "medianMs":1900, "llmFallbackRate":0.18 },
  "patch": [ {"op":"replace","path":"/tools/select_size/description","value":"..."} ],
  "verdict": "kept" }
```
**Editor contract (code-enforced, never trust the LLM):** allowed paths only (`/tools/*/description|exposed|precondition`, `/context/*`, `/jev/nextInstructions`, `/jev/confidenceThreshold`, `/guardrails/maxSteps`, `/guardrails/confirm` **append-only**, `/rules`) · threshold ∈ [0.5,0.95] · maxSteps ∈ [4,12] · ≤3 edits per generation · checkout/place_order can never leave the confirm list.

**Three kinds of failure (measure separately — this is the honest version):**
1. possible, agent messed up → harness fixes · 2. possible, site made it hard (buried login) → harness learns a rule · 3. impossible (out of stock, no vegan line, ZIP bug) → harness says "not possible" fast + reports to owner.
Metrics: success on *possible* goals (train & held-out) · fast-correct-"no" rate on impossible goals · median ms · LLM-fallback rate · recipe-hit on held-out · edits kept vs rolled back.

**Mock shop "Trailhead Outfitters"** (static HTML+JS, localStorage state): listing, product, cart, checkout, orders, login.
Planted: (A) Trail Runner size 10 out of stock · (B) checkout rejects ZIPs starting with 9 · (C) order tracking needs login, link buried in footer · (D) no kids' sizes / no vegan line. (C) is kind 2 — the loop should visibly learn it. A/B/D are kind 3.
**Goals:** 60 generated (claude-sonnet-5) with answer key `{goal, category, possible, flaw}`; 40 train / 20 held-out (reworded + new situations).

**Models:** Jev `jev-latest` (decide/verify/classify) · Neon `gpt-5-4-mini` (fallback step + harness editor) · `claude-sonnet-5` (goals once) · Voyage `voyage-4-lite` 1024-d.

## 2. Repo layout (plain Node, CommonJS)
```
server.js                 Express: /shop, /api/map|decide|visit, /evolution, /.well-known/doorman.json
src/db.js embeddings.js jev.js llm.js        (token budget, spend meter $15/day, 429 backoff)
src/harness/config.js     load active config, save version, validatePatch(), applyPatch()
src/harness/engine.js     decide(): tiers, thresholds from config, confirm allowlist
src/harness/recipes.js    $vectorSearch by siteId · save · markBroken
src/harness/visits.js     log, classifyFailure
src/harness/editor.js     IMPROVEMENT LOOP: worstTraces → LLM → patch → validate → eval held-out → keep/rollback
src/sim/goals.js agent.js verify.js run.js   (Playwright; concurrency 4)
public/doorman.js         mapper · executor · window.doorman · WebMCP (document.modelContext, feature-detected)
public/shop/              mock shop        public/evolution/   one page: versions, edits, metrics
scripts/setup-db.js       collections + 2 vector indexes (recipes, visits)
PLAN.md LEARN.md PITCH.md DEMO.md README.md
```

## 3. Timeline (now → 5:00 PM)
| Time | Block | Milestone (test it yourself before moving on) | You, meanwhile |
|---|---|---|---|
| 11:00–11:45 | **B1** shop + 4 flaws + `verify.js` | shop works; verify detects cart/order/flaw states | LEARN §1–4; click every flaw yourself; sandbox URI + mentor Q |
| 11:45–1:00 | **B2** `doorman.js` + `/api/decide` Jev loop, config v1 hard-coded | `doorman.do("add trail runner size 9 to cart")` works live | LEARN §5–7; read one Jev request in the log |
| 1:00–1:45 | **B3** config v1 in Atlas (versioned) + visits + recipes | second, reworded goal hits `tier: recipe`; visit doc in Atlas | eat; LEARN §8–9 |
| 1:45–2:45 | **B4** simulator: goals, agent runner, metrics | 20 goals run; metrics printed | LEARN §10; watch one run headed |
| 2:45–3:45 | **B5** improvement loop, 3 generations | v1→v4 with patches, verdicts, held-out numbers in Atlas | draft README + PITCH numbers |
| 3:45–4:15 | **B6** `/evolution` page (small) + optional 10-goal baseline | page shows versions, edits, metric curve | rehearse 3-min demo |
| 4:15–4:45 | **B7** 1-min video, README, push | repo public, video done | — |
| 4:45–5:00 | **Submit** | form done, all members added | — |

**Cut lines:** behind at 1:45 → recipes by category (no vector) · behind at 2:45 → 20 goals, 2 generations · behind at 3:45 → `/evolution` = a table, no chart; skip baseline.
**Never cut:** live `doorman.do()` · at least 2 generations with a kept and a rolled-back edit · versions in Atlas · public repo + video.

## 4. Budget (assume $20/day Neon cap): goals $0.10 · fallback steps ~$0.50/run · editor ~$0.20/generation · baseline 10 goals ~$0.30 · total day **≈ $5**. Jev < $1. Spend meter stops at $15.

## 5. Honesty lines
Simulated agents on a mock shop (best case) · few agents speak WebMCP yet (we expose `window.doorman` + manifest) · Jev's accuracy claims are the vendor's; we report our own fallback rate · the editor is an LLM, but every edit is validated by code and proven on held-out goals before it's kept.
