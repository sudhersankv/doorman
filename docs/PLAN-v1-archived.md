# Doorman — Hackathon Plan (Sun Oct 11, 2026)

> **Every website needs a doorman for AI agents.**
> One script tag maps a site into tools for visiting agents, makes each decision in ~400 ms with a
> System 1 model (Jev), learns recipes in MongoDB Atlas so the next agent is faster, and shows the
> owner what agents came for and where they got stuck.

Event: MongoDB "Harness Engineering & Model Wrangling" hackathon, Embarcadero SF, 9 AM–8 PM (Tech Week + Partiful say 8 PM; Cerebral Valley says 10 PM — assume 8).
Theme: memory, persistence, self-evolving systems, governance. Must build on Atlas; Agent Engine encouraged.
Judges: Steffan Mejia (MongoDB), Jackson Ferrigno (Raindrop), Bosco Albuquerque (AWS), Aram S. (Modelence).

---

## 0. On arrival (first 30 min) — do these before any code

- [ ] **Deadline.** Listings disagree (8 PM vs 10 PM end; "due Oct 12 UTC" may mean **5 PM Pacific**). Confirm the exact submission time. Until then: **freeze at 5 PM, no reliance on any evening buffer.**
- [ ] **Demo format.** Live? Recorded? Length? (NYC edition: finalists recorded on site.)
- [ ] **Prizes.** Is the $3K Raindrop self-improvement prize separate from the top 3? Does it require Raindrop's product?
- [ ] **Rules on prior code.** We start the Doorman code fresh today; .env/tests from last night are setup, not product.
- [ ] **Agent Engine question for a MongoDB mentor (45-min timebox):** "Can we store per-site recipes as procedural
      memory in Atlas Agent Engine and retrieve them by similarity? What's the simplest API path?" If it's not
      working in 45 min → plain Atlas collections + Vector Search (already tested), and we explain the mapping.
- [ ] Wi-Fi + `node test-connection.js` + `node test-ai.js` from the venue. If Jev/Neon fail on venue Wi-Fi → phone hotspot.
- [ ] Eat. Fill water. Charger plugged in.

---

## 1. What we're building (locked)

**Doorman = `doorman.js` on the site + a backend on Atlas + an owner dashboard.**

```
Visiting agent ──► window.doorman.do(goal)   (also WebMCP tools + /.well-known/doorman.json)
                        │
                        ▼  page state (from the site map) + goal + history
                 POST /api/decide  ──► Tier 0: specific tool called → no decision
                        │              Tier 1: recipe match (Atlas Vector Search) → Jev fills blanks
                        │              Tier 1: no recipe → Jev loop, one decision per step (~400 ms)
                        │              Tier 2: Jev confidence < 0.7 → LLM (Neon) decides that step
                        ▼
                 doorman.js executes action on the DOM  ──► repeat until done / failed
                        │
                        ▼
                 Jev verifies outcome + classifies failure reason ──► visit log in Atlas
                 success ──► saved as recipe (procedural memory)   ──► next visitor is faster
                        │
                        ▼
                 /dashboard: speed & cost, no-LLM share over time, intents, failures, unmet demand
```

**Security boundaries (non-negotiable in code):** no API keys in `doorman.js` — Jev/Atlas/LLM are called only by the server; every recipe/visit query is filtered by `siteId`; `checkout`/`submit`/`delete` require confirmation via a **hard-coded allowlist in `engine.js`** — Jev's `needs_confirmation` is advisory only.
**Agent Engine note:** its procedural memories are **private by default**; Doorman's recipes must be shared per site, so if we use it, scope deliberately. Plain Atlas collections avoid this.

**Memory mapping (say this to the MongoDB judge):**
- `site_maps` = how the site works (procedural)
- `recipes` = learned step sequences per goal type (procedural, self-improving)
- `visits` = every agent visit with goal/outcome/failure (episodic)
- intent clusters over `visits.goal_embedding` (semantic)

**Models:** Jev `jev-latest` (decisions, verification, classification) · Neon `gpt-5-4-mini` (fallback + baseline agent)
· Neon `claude-sonnet-5` (generate goals once) · Voyage `voyage-4-lite` 1024-d (embeddings, Atlas Vector Search).

---

## 2. Repo layout (plain Node, CommonJS, no framework — zero build step)

```
D:\mongodb-hackathon\
  .env                      (done, all 4 services tested)
  package.json
  server.js                 Express: /shop, /api/*, /dashboard, /.well-known/doorman.json, /snippet
  src/
    db.js                   Atlas client, collections, ensureIndexes()
    embeddings.js           Voyage embed(texts, 'query'|'document')
    jev.js                  TypeSafe client + question builders (nextAction, pickItem, feasible, confirm, verify)
    llm.js                  Neon client + token budget (150k TPM) + spend meter ($15/day stop) + 429 backoff
    doorman/
      engine.js             decide(): recipe → Jev loop → LLM fallback; confidence thresholds
      recipes.js            find(goal) via $vectorSearch, save(goal, steps), markBroken()
      visits.js             log(visit), classifyFailure()
    sim/
      goals.js              generate 60 goals + answer key (claude-sonnet-5) → goals.json + Atlas
      baseline-agent.js     Playwright: trimmed a11y list → LLM picks element → act (≤15 steps)
      doorman-agent.js      Playwright: window.doorman.do(goal)
      verify.js             ground truth: inspect shop state vs answer key (no LLM judge)
      run.js                parallel runner (concurrency 4), writes `runs` to Atlas
      jev-vs-llm.js         100 decisions, same question to Jev and gpt-5-4-mini; accuracy/latency/cost
  public/
    doorman.js              THE SCRIPT TAG: mapper, executor, window.doorman, WebMCP registration, reporter
    shop/                   mock shop "Trailhead Outfitters" (static HTML + JS, state in localStorage)
    dashboard/              index.html + Chart.js (cdnjs)
  scripts/setup-db.js       create collections + 2 vector indexes (recipes, visits)
  Dockerfile, fly.toml      Playwright base image; secrets from .env
  PLAN.md LEARN.md PITCH.md DEMO.md
```

**Mock shop "Trailhead Outfitters"** — pages: listing (/shop), product, cart, checkout, orders, account.
**Planted flaws (the answer key):**
1. **OUT_OF_STOCK** — "Trail Runner" shoes size 10 always out of stock (many goals want it)
2. **VALIDATION_ERROR** — checkout rejects ZIP codes starting with 9 ("Invalid ZIP") — CA visitors hit it
3. **LOGIN_REQUIRED** — order tracking needs login; the login link is buried in the footer
4. **NOT_FOUND** — no kids' sizes and no vegan/leather-free line; goals asking for them are infeasible

**Goals (60):** ~30 clean successes, ~24 that hit a flaw (6 each), ~6 vague/impossible. Each has
`{goal, category, expected_outcome, expected_failure_reason, flaw_id}`. 40 train / 20 held-out for the recipe test.

**Metrics:** success rate · median s/goal · LLM calls/goal · $/goal · tier share (recipe / jev-loop / llm)
· failure-reason precision/recall vs planted flaws · Jev-vs-LLM decision accuracy.
**Learning metrics, reported separately (recipes do NOT change the no-LLM share — the Jev loop already uses no LLM):**
recipe-hit rate on the 20 held-out goals (generalization, not caching) · median latency with vs without recipe ·
LLM-fallback rate with vs without recipe · Jev calls per goal with vs without recipe.

---

## 3. Build order & timeline (freeze at 5 PM; event ends 8 PM)

| Time | Block | Milestone (must be true before moving on) | You, in parallel |
|---|---|---|---|
| 9:00–9:30 | Arrival checklist (§0) | Rules known, mentors asked, services reachable | — |
| 9:30–10:30 | **B1 Shop + flaws + verify.js** | Shop works in browser; `verify.js` detects cart/order/flaw states | LEARN §1–3. Click through the shop, hit all 4 flaws yourself |
| 10:30–12:00 | **B2 doorman.js + /api/decide (Jev loop, no recipes)** | `window.doorman.do("add trail runner size 9 to cart")` works live, ~1–2 s | LEARN §4–5. Watch the Jev requests in the server log; read one |
| 12:00–1:00 | **B3 Recipes + LLM fallback + visit logs** | Same goal twice: 2nd run shows `tier: recipe`, faster | LEARN §6–8. Open Atlas, look at `recipes` and `visits` docs |
| 1:00–2:30 | **B4 Simulator** (goals, baseline agent, doorman agent, runner) | 10 goals × both agents, results in Atlas `runs` | LEARN §9–10. Watch a baseline agent in headed mode once |
| 2:30–3:30 | **B5 Dashboard** (5 panels + snippet page) | Panels fed by the real 10-goal run | Draft README; start PITCH numbers table |
| 3:30–4:15 | **B6 Full benchmark** 60×2 agents, run twice; jev-vs-llm.js | Numbers in dashboard; cost < $6 | Deploy to Fly in parallel (`fly launch` from Kevin's pattern) |
| 4:15–5:00 | **B7 Record demo, README, submit** | Submitted with public URL + video | Record per DEMO.md |
| 5:00–8:00 | Buffer / polish / rehearse / present | Live demo rehearsed 3× | Agent Engine integration only if everything else is done |

**Cut lines (decide at the clock, not by feel):**
- Behind at **1:00** → recipes match by goal *category* (exact) instead of vector search; keep Vector Search for intents only.
- Behind at **2:30** → 30 goals, one run, concurrency 4.
- Behind at **3:30** → dashboard = 3 panels: speed/cost, failures-vs-flaws, no-LLM share.
- **Never cut:** live side-by-side demo · failures-vs-planted-flaws panel · public URL · honest numbers.

---

## 4. How we work together

- Claude writes code block by block; you run it, click it, break it. Every block ends with you testing the milestone in a browser.
- Ask "why" at every block — that's the learning (LEARN.md tracks the blocks).
- You own: README, pitch numbers, recording, Fly deploy, mentor conversations, food.
- One terminal for the server (`npm run dev`), one for scripts. Keep Atlas open in a browser tab.
- Commit after every milestone (`git add -A && git commit -m "B2: doorman loop works"`). Never commit `.env`.

---

## 5. Budget & limits (assume $20/day Neon cap)

| Item | Est. |
|---|---|
| Goal generation (claude-sonnet-5, once) | $0.10 |
| Baseline agent per run (~900 calls, gpt-5-4-mini, trimmed pages) | $1.5–2 |
| Doorman per run (fallback only) | $0.20 |
| Jev, whole day | < $1 (own $10 credit) |
| Two full runs + debugging | **~$12** |

Guards in code: shared 150k tokens/min budget, `Retry-After` backoff, spend meter stops at $15. Don't run Kevin today (shares the Neon branch).

---

## 6. Honesty lines (say them before a judge does)
- Traffic is **simulated** (LLM agents, Playwright). Next step: a real site with agent traffic.
- Almost no agents speak WebMCP yet; Doorman works via `window.doorman` + manifest today, registers WebMCP where supported.
- Mock site is a best case; on messy real sites the no-LLM share will be lower. The benchmark reports it either way.
- Jev's accuracy claims are the vendor's; **we measured it ourselves** (jev-vs-llm table).
