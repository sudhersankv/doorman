# Doorman — Module Contracts (read before touching any module)

Rules for every module:
- **Generic.** No shop vocabulary in `public/doorman.js`, `src/harness/`, `src/lib/`. Words like cart, product, price, checkout
  may appear only in `public/shop/`, `src/sim/` (the benchmark rig) and test fixtures. `grep -ri "cart\|checkout\|product" src/harness src/lib public/doorman.js` must return nothing.
- **Zero runtime deps** except `mongodb` (server) and `playwright` (sim/tests). Server uses `node:http`. Tests use `node:test`.
- **Keys stay server-side.** `public/doorman.js` carries only a public `siteId`.
- **Every external service has an interface + a fake** in `src/lib/`. Modules take `deps` (`{jev, embed, llm, db, log}`) — never import a client directly.
- **CommonJS**, `'use strict'`, small files, JSDoc on exported functions. Tests next to the module in `test/unit/<module>.test.js`.

## 1. Page snapshot (doorman.js → server)  — THE central contract
```js
{
  siteId: "trailhead",            // public id from the script tag's data-site
  url: "http://host/shop/#/product/road-racer",
  title: "Trailhead Outfitters",
  templateHash: "a91f3c",         // hash of tag/role skeleton with text removed; same for all pages of one template
  actions: [                      // visible, interactive, deduplicated
    { key: "size", kind: "select", name: "Size", role: "combobox", selector: "#size",
      options: [{ value: "9", label: "9" }, { value: "10", label: "10 — out of stock" }] },
    { key: "add_to_cart", kind: "click", name: "Add to cart", role: "button", selector: "#add" },
    { key: "search", kind: "type", name: "Search products", role: "searchbox", selector: "#search", submit: "#search-form button" },
    { key: "view_road_racer", kind: "link", name: "View Road Racer", role: "link", selector: "a[aria-label='View Road Racer']", href: "#/product/road-racer" }
  ],
  items: [                        // repeated structures on the page (cards, rows, slots), with numbers+units extracted
    { key: "item_2", text: "Road Racer $72.00 shoes View", attrs: { "$": 72 }, actionKeys: ["view_road_racer"] }
  ],
  messages: [{ role: "alert", text: "Sorry, size 10 is out of stock." }],   // role=alert|status, visible only
  fields: [{ key: "zip", kind: "text", name: "ZIP code", selector: "#zip", value: "" }], // form inputs (subset of actions, with current value)
  counts: { actions: 9, items: 12 }
}
```
`key` = slug of the accessible name (unique on the page; suffix `_2` on collision). `kind` ∈ click | link | type | select | check | submit.
Numbers with units: any token matching `(\$|€|£)?\d+(\.\d+)?\s*(%|★|stars?|mi|km|kg|lb|min|h|am|pm|°)?` → `attrs[unit] = number` (currency symbol or unit as the key; bare numbers under `"#"`).

## 2. /api/decide  (POST)
Request: `{ siteId, goal, page: <snapshot>, history: [<step>], visitId? }`
Response:
```js
{ visitId, step: {
    action: "add_to_cart" | null,            // key from page.actions, or null when done/impossible/needsConfirmation
    params: { value?: "9", text?: "running shoes" },
    tier: "T0_tool" | "T1_recipe" | "T1_jev" | "T2_llm",
    confidence: 0.91,
    done: false, impossible: false, needsConfirmation: false,
    reason: "..." },
  trace: { jevMs, llmMs, recipeId?, configVersion } }
```
Step record (goes into history): `{ action, params, tier, confidence, outcome: "ok"|"error", messagesAfter: [...] }`.
Loop ends when `done`, `impossible`, `needsConfirmation`, or `history.length >= config.guardrails.maxSteps`.

## 3. /api/visit (POST)  — end of a visit
`{ visitId, siteId, goal, history, finalPage, agentReported: { done, impossible } }` → `{ ok, visit: { outcome: "success"|"failed"|"impossible", failureReason, ms, tierCounts, recipeSaved } }`
Server runs `engine.verifyOutcome` (Jev) and writes `visits`; saves a recipe on success.

## 4. Harness config (src/harness/config.js)
```js
DEFAULT_CONFIG = { siteId, version: 1, parent: null, active: true, createdBy: "seed",
  tools: {},                         // key → { exposed: true, description?: string, precondition?: string }  (keys = action keys; unknown keys ignored)
  context: { includeMessages: true, includeItems: true, maxItems: 12, historySteps: 4, recipesTopK: 3 },
  jev: { nextInstructions: "Choose the single action that moves closest to completing the goal on THIS page. Choose `done` only if the goal is clearly already achieved.", confidenceThreshold: 0.70 },
  guardrails: { confirm: [], maxSteps: 8, impossibleThreshold: 0.80 },   // confirm = action keys needing confirmation (append-only); seed from action names matching /pay|order|purchase|submit|delete|book|confirm/i
  rules: [],                          // plain strings injected into Jev context
  eval: null, patch: null, verdict: null, createdAt }
```
`validatePatch(patch, config)` → `{ ok, errors[] }`. Patch = JSON-Patch subset `[{op:"replace"|"add"|"remove", path, value}]`.
Allowed paths: `/tools/<key>/(description|exposed|precondition)`, `/context/(includeMessages|includeItems|maxItems|historySteps|recipesTopK)`,
`/jev/nextInstructions`, `/jev/confidenceThreshold` ∈ [0.5,0.95], `/guardrails/maxSteps` ∈ [4,12], `/guardrails/impossibleThreshold` ∈ [0.6,0.95],
`/guardrails/confirm/-` (add only; remove never allowed), `/rules/-` and `/rules/<i>` (replace/remove ok). Max 3 ops. Anything else → error.
`applyPatch(config, patch)` → new config object with `version+1`, `parent`, `patch`, `createdBy:"editor"`.

## 5. Engine (src/harness/engine.js)
`decide({ goal, page, history, config, deps })` → step (see §2). Order: T0 if `history[0]?.tool` given → T1 recipe (deps.recipes.find) → T1 Jev → T2 LLM when `confidence < config.jev.confidenceThreshold`.
`buildState({ goal, page, history, config, recipes })` → compact JSON for Jev, honoring config.context. Never include selectors.
`verifyOutcome({ goal, finalPage, history, deps })` → `{ satisfied: 0..1, failureReason: "not_found"|"validation_error"|"login_required"|"unavailable"|"blocked"|"other"|null }`.
Confirmation: if chosen action key ∈ `config.guardrails.confirm` → return `needsConfirmation: true` without executing (code rule).
Numbers: `src/harness/constraints.js` — `parse(goal)` → `[{ unit:"$", op:"<=", value:80 }]` from phrases like "under/below/at most/max $80", "over/at least/min 4 stars", "before 10am"; `filterItems(items, constraints)` keeps items whose `attrs[unit]` satisfy all. Generic: no field names, only units.
Free text: `candidatePhrases(goal)` → 3–5 noun-ish phrases (strip verbs/stopwords/constraints) for Jev to pick a `type` value.

## 6. Jev (src/lib/jev.js)
`makeJev({ apiKey, url, model, fetch })` → `{ decide(state, questions) → { answers, usage, ms } }`.
Questions object as TypeSafe expects: `{ id: { type:"choice", instructions, criteria:{opt:desc|null} } | { type:"noul", instructions } | { type:"score", instructions, criteria:[...] } }`.
Answers: choice → `{ choice, probabilities, confidence }`; noul → `{ noul }`; score → `{ score, confidence }`.
`makeFakeJev()` — deterministic heuristic oracle for tests (token overlap between goal/instructions and option descriptions; noul from keywords in state.messages). Must never throw.

## 7. Embeddings / LLM / DB (src/lib/)
`makeEmbed({ apiKey, baseUrl, model, dims, fetch })` → `embed(texts, inputType:"query"|"document") → number[][]`; `makeFakeEmbed(dims)` deterministic (hash-based, cosine-meaningful enough: shared tokens → closer).
`makeLlm({ baseUrl, token, model, fetch, budget })` → `{ chat(messages, { json?: true, maxTokens }) → { text, usage, ms }, spentUsd(), calls() }` with 429 backoff (honor Retry-After), 150k tokens/min budget, stop at `budget.maxUsd` (default 15). `makeFakeLlm(handlers)` returns canned JSON by prompt tag.
`makeDb({ uri, dbName })` → `{ col(name), vectorSearch(col, { vector, filter, limit, index }), ensureIndexes(), close() }` (real Mongo, lazy require).
`makeFakeDb()` in-memory: `col(name)` supports insertOne/insertMany/find({...}).toArray()/findOne/updateOne/updateMany/deleteMany/countDocuments on flat equality + `$in`; `vectorSearch` = brute-force cosine.
Collections: `harness_configs`, `site_maps`, `recipes`, `visits`, `runs`, `goals`. Vector indexes: `recipes.goalEmbedding`, `visits.goalEmbedding` (1024, cosine, filter siteId).

## 8. Recipes / visits
`recipes.find({ siteId, goalVector, topK, deps })` → `[{ _id, goalPattern, steps:[{action, params:{value?:"$BLANK"}}], score, successes, failures }]` (skip `brokenAt` set).
`recipes.saveFromHistory({ siteId, goal, goalVector, history, deps })` → blanks any free-text/select values. `recipes.markBroken(id)`.
`visits.log({ siteId, goal, goalVector, history, outcome, failureReason, ms, tierCounts, configVersion, deps })`.

## 9. Editor (src/harness/editor.js) + evolve.js
`proposePatch({ config, worstVisits, metrics, deps })` → `{ patch, rationale }` (LLM, JSON mode; prompt lists allowed paths; ≤3 ops).
`evolveOnce({ siteId, deps, runGoals })` → `{ from, to, patch, verdict:"kept"|"rolled_back", before:{...}, after:{...} }` where `runGoals(split, configVersion)` runs the simulator and returns metrics `{ successPossible, impossibleHandled, medianMs, llmFallbackRate, recipeHitRate }`.
Keep rule: `after.successPossible > before.successPossible + 0.02` OR (`after.successPossible >= before.successPossible - 0.02` AND `after.medianMs < before.medianMs * 0.9`).

## 10. Simulator (src/sim/)
`goals.js`: templates (objective answer key) × LLM paraphrases (many voices). Output `goals.json` + `goals` collection: `{ id, text, kind, params, possible, flaw, split:"train"|"heldout" }`.
`agent.js`: Playwright: open page, reset site state, `window.doorman.do(goal, { autoConfirm: true })`, then `verify()`.
`run.js --split train|heldout|all --config <version>` → writes `runs` docs, prints metrics JSON. `metrics.js` pure.

## 11. doorman.js public API
`window.doorman = { version, siteId, map(): snapshot, do(goal, { autoConfirm?, maxSteps?, onStep? }): Promise<{ ok, done, impossible, needsConfirmation, steps, ms, tierCounts, visitId }>, tools(): [{name, description, inputSchema}] }`.
Registers WebMCP tools via `document.modelContext?.registerTool` when present (feature-detected; never throws). Executor handles React-style inputs (native value setter + input event), selects, clicks, links (hash + href), form submit. After each action: wait for DOM to settle (MutationObserver quiet 150 ms, max 1500 ms) then re-snapshot.
