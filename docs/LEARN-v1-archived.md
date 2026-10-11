# Doorman — Learn it A to Z (read alongside the build blocks in PLAN.md)

Each section: the idea in plain words → where it lives in the code → a judge question → something to try.

## 1. How AI agents browse websites today (B1)
- Loop: look at page → LLM decides one step → act → look again. 10–30 steps per task, 1–3 s each = minutes.
- Three ways to "look": screenshots (Operator, computer use), accessibility tree / DOM (browser-use, Stagehand,
  Playwright MCP), or both. Text is cheaper and more precise than pixels.
- Nothing is remembered between visits; every agent relearns every site.
- Code: `src/sim/baseline-agent.js` is exactly this loop. Judge Q: "How is this different from Stagehand's cache?"
  → theirs is per-agent, on the agent's machine; ours is per-site, shared by every visitor, approved by the owner.
- Try: run the baseline agent in headed mode (`HEADED=1`) and watch it click.

## 2. The accessibility tree and the site map (B1–B2)
- Every element has a *role* (button, link, textbox) and a *name* (its label). That's what screen readers use
  and what our mapper reads — far smaller than HTML.
- Mapper: find interactive elements → drop hidden ones → build an action record {key, description, role, name,
  selectors[]} → group raw elements into real actions (search box + button = `search(query)`).
- Page template fingerprint = hash of the role/tag skeleton (text removed) → all product pages share one map.
- Code: `public/doorman.js` → `mapPage()`. Try: DevTools → Elements → Accessibility → "full tree" on the shop.

## 3. WebMCP, discovery, and why Doorman doesn't depend on it (B2)
- WebMCP: `await document.modelContext.registerTool({name, description, inputSchema, execute})` (Chrome docs,
  updated Sept 2026; older posts say `navigator.modelContext`). Experimental, origin trial. Always feature-detect:
  `if (document.modelContext?.registerTool) { ... }` and fall back to `window.doorman`.
- Doorman exposes tools 3 ways: `window.doorman` (works everywhere today), `/.well-known/doorman.json` manifest
  + `<meta>` tag (pre-WebMCP pattern, like ChatGPT plugins 2023), and WebMCP registration when present.
- The hard problem is agents *looking*, not sites exposing. WebMCP is the industry's bet on where to look.
- Code: `registerTools()` in `doorman.js`; `server.js` serves the manifest. Judge Q: see PITCH.md Q&A.

## 4. System 1 vs System 2, and what Jev actually is (B2)
- LLMs reason token by token (System 2): slow, expensive, needed when choices are open-ended.
- Jev (TypeSafe AI) is a "System One" model: you send `state` + typed `questions` (choice / score / noul), it
  returns a probability over options you defined, all questions answered in parallel in one pass. ~100–500 ms,
  $0.042 per 1M input tokens, output free. Calibrated confidence (trained so 0.8 ≈ right 80% of the time).
- It cannot generate text, plan, count, compare numbers/dates, or read large noisy input.
- **The key insight:** the site map turns an open-ended page into a closed menu of ~30 actions. Choosing from
  a menu is classification, not reasoning. The map makes System 1 viable; System 1 makes Doorman fast.
- Research backing: Mind2Web (2023) — a small model shortlists elements, then multiple-choice selection beats
  generating the answer (43.6% vs 20.2% at equal size). Doorman = shortlist (map + vector search) + choice (Jev).
- Code: `src/jev.js`. Try: run `node test-ai.js` and read the request body; change the goal and re-run.

## 5. What we send Jev, and the decision loop (B2)
- State (compact JSON, ~1–2k tokens, never the raw tree): `{goal, page:{type, visible_items, filters, cart},
  actions:[...from map...], recipes:[top-5], history:[steps so far]}`.
- Questions per step: `next` (choice over this page's actions + done), item/value slots (choice over candidates
  on the page), `feasible` (noul), `needs_confirmation` (noul). After the action: `goal_satisfied` (noul),
  `failure_reason` (choice: out_of_stock / validation_error / not_found / login_required / other).
- Free text (a search query) → code extracts 3–5 candidate phrases from the goal, Jev picks one.
  Numbers ("under $80") → code filters candidates *before* Jev. Known weak spot handled in code.
- Confidence < 0.7 on `next` → that one step goes to the LLM (Tier 2). Loop max 6 steps.
- Code: `src/doorman/engine.js`. Judge Q: "Why did Jev say 0.5 on next-action last night?" → two valid actions
  (open_product vs add_to_cart) split the probability; calibration working. Fix = cleaner per-page action lists.

## 6. Embeddings and Atlas Vector Search (B3)
- An embedding turns text into a 1024-number vector; similar meaning → nearby vectors (cosine similarity).
- Voyage `voyage-4-lite` via MongoDB's endpoint; `input_type: 'document'` when storing, `'query'` when searching.
- Index definition: `{type:'vector', path:'embedding', numDimensions:1024, similarity:'cosine'}` + filter fields.
  Query: `$vectorSearch {index, path, queryVector, numCandidates, limit, filter}` then `$meta: 'vectorSearchScore'`.
- Last night: "put the running shoes in my basket" → add-to-cart 0.709, checkout 0.649. Good at *narrowing*,
  not precise enough for the final pick → that's why Jev decides from the top few.
- Code: `src/embeddings.js`, `src/doorman/recipes.js`, `scripts/setup-db.js`. Try: Atlas UI → Search Indexes.

## 7. Memory types and the Atlas collections (B3)
- Agent Engine names four memories. Doorman's mapping: **procedural** = `site_maps` + `recipes`;
  **episodic** = `visits`; **semantic** = intent clusters over visit goals; (taxonomic = goal categories).
- Governance = keys stay server-side (the script tag has only a public site id); every query filtered by siteId;
  consequential actions (checkout/submit/delete) need confirmation via a hard-coded allowlist in code — Jev's
  prediction is advisory. Agent Engine procedural memory is private by default; ours must be shared per site.
  Say "governance" out loud; it's the event theme.
- Judge Q: "Why MongoDB, not Postgres?" → documents match the shape (a map is a nested doc; recipes vary per
  site), vector search is built in, and one database holds maps, recipes, visits and vectors together.

## 8. Recipes: what they are and why they're optional (B3)
- A recipe = saved step sequence for a *type* of goal on one site, with blanks: `search(query:_) →
  open_product(item:_) → add_to_cart → checkout(confirm)`.
- New goal → vector search finds the closest recipe → one Jev call fills the blanks → steps run back to back.
- No recipe → the Jev loop decides step by step (slower, still no LLM). Success → saved as a recipe.
- Failure on a recipe step → `markBroken()`; relearned on the next success. That's self-healing.
- Recipes don't change the no-LLM share (the Jev loop is already LLM-free). They cut latency and Jev calls per goal
  and reduce low-confidence steps (fewer LLM fallbacks). Report those separately. Running the *same* goal twice
  shows caching; the 20 held-out goals (new wording, new situations) show whether recipes *generalize*.
- Research: Agent Workflow Memory (ICML 2025): learned workflows gave +24.6% (Mind2Web) and +51.1% (WebArena).

## 9. Designing an honest benchmark (B4)
- **Answer key:** 4 planted flaws, 60 goals tagged with expected outcome + flaw. The dashboard must find the
  flaws without being told. That's a test with ground truth.
- **Objective verification:** `verify.js` inspects shop state (cart, orders, error banners) — no LLM judging.
- **Fairness:** the same LLM (gpt-5-4-mini) drives the baseline and Doorman's fallback; Doorman *additionally*
  uses Jev. Say it that way. Same goals, same shop, same verification.
- **Train/test:** 40 goals build recipes, 20 held-out goals measure whether recipes generalize.
- **Repeat:** run twice; report both. Two similar runs beat one big run.
- Jev-vs-LLM: 100 identical decision questions to both; accuracy vs ground truth, latency, cost.
- Judge Q: "Isn't this a best case?" → yes, we built the site; we say so; real sites will score lower.

## 10. Rate limits, budget, parallelism (B4/B6)
- Neon: 200k tokens/min account-wide, 20k *output* tokens/min upstream (reasoning tokens count!), ~$20/day cap.
  Jev: 80 req/s — irrelevant. Baseline agent is the heavy one (~3k tokens/step).
- Guards: shared token budget, `Retry-After` backoff, spend meter, trimmed page view (~1.5k tokens),
  minimal reasoning effort. Concurrency 4 → ~12–18 min per full run.
- Code: `src/llm.js`. Try: watch the spend meter print during a run.

## 11. The dashboard: one design for any site (B5)
- Every panel reads fields Doorman logs identically on every site: goal, category, tool, outcome,
  failure_reason, step_index, tier, ms, cost. Nothing shop-specific.
- Panels: speed & cost · no-LLM share over time · what visitors wanted (clusters + categories) ·
  where they failed (reason × step) · unmet demand (infeasible goals) · snippet page ("Add your site").
- Line for Raindrop's judge: "Raindrop shows agent builders where their agents fail; Doorman shows websites
  where visiting agents fail."

## 12. Deployment (B6)
- Fly.io: Dockerfile from `mcr.microsoft.com/playwright` image; `fly secrets set` from `.env`; same pattern as
  Kevin (`D:\kevin\kevin\fly.toml`). The event explicitly rewards "gets to deployment".
- Run the benchmark locally; deploy shop + dashboard + API; dashboard reads the runs from Atlas.
