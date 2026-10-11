# Doorman — Learn it A to Z (v2: the self-improving site-side harness)
Each section: the idea → where it lives in the code → a judge question → something to try.

## 1. What a harness is (B1)
Everything around a model that turns it into a working agent: the loop (observe→decide→act→check), tools,
context policy (what the model sees), memory, guardrails, routing/fallbacks, verification. Claude Code is a
harness around Claude. Doorman is a harness around Jev — but it runs on the *website*, serving every agent
that visits. Judge Q: "Why site-side?" → the site knows itself, can set its own guardrails, and learns from
*all* visitors instead of one agent relearning alone.

## 2. How agents browse today, and how they fail (B1)
Loop: look → LLM picks a step → act → look again; 10–30 steps, minutes. On real sites (Online-Mind2Web, 2025),
the best agents completed ~56–61% of tasks; most others ~30%. Top failure causes: filters/sorting mistakes,
missed number/date constraints, navigation errors, repeating or stopping early, ~2.6× more steps than a human.
Three kinds of failure: possible-but-agent-failed · possible-but-site-made-it-hard · impossible on this site.
Doorman fixes the first two and answers the third fast. Code: `src/sim/verify.js` labels which kind.

## 3. The site map (B1–B2)
Accessibility tree: every element has a *role* and a *name*. Mapper: interactive + visible → group into actions
(search box + button = `search(query)`) → template hash (roles/tags, text removed) → one map per page template,
keyed `siteId + templateHash` in `site_maps`. Exact key, no vectors. Try: DevTools → Accessibility → full tree.

## 4. Exposure and WebMCP (B2)
`window.doorman.do(goal)` + `/.well-known/doorman.json` work everywhere today. WebMCP:
`await document.modelContext.registerTool({name, description, inputSchema, execute})` (Chrome docs updated
Sept 2026; older posts say `navigator.modelContext`). Experimental → feature-detect, fall back. The hard problem
is agents *looking*; WebMCP is the industry's bet on where. Judge Q: PITCH.md Q&A.

## 5. System 1 vs System 2, and Jev (B2)
Jev (TypeSafe): send `state` + typed `questions` (choice/score/noul) → probability over options you define,
all in one parallel pass. ~100–500 ms, $0.042/M input tokens, calibrated confidence. Can't generate text, plan,
count, compare numbers. **The map turns an open-ended page into a closed menu — that's what makes System 1
viable.** Research: Mind2Web — choose-from-shortlist beats generate (43.6% vs 20.2% at equal size).
Code: `src/jev.js`. Try: `node test-ai.js`, change the goal.

## 6. The decision loop and what Jev sees (B2)
State (compact JSON, never the raw tree): `{goal, page:{type, items, filters, cart}, actions, recipes[top-3],
history}`. Questions: `next` (choice over this page's actions + done), slot fills (choice over candidates),
`feasible`, `needs_confirmation`; after the action: `goal_satisfied`, `failure_reason` (fixed list).
Free text → code extracts 3–5 phrases, Jev picks. Numbers → code filters first. Confidence < threshold →
that step goes to the LLM. **Which fields, which threshold, which instructions all come from the harness
config** — that's what the loop later edits. Code: `src/harness/engine.js`.

## 7. The harness config: behavior as data (B3)
Nothing about Doorman's behavior is hard-coded. `harness_configs` holds tools (exposed, description,
precondition), context policy (fields, history length, top-k), Jev instructions + threshold, guardrails
(confirm list, maxSteps), rules, and eval numbers. The engine reads the *active* version every step.
"Rewriting itself" = writing version v+1. Code: `src/harness/config.js`. Judge Q: "Why MongoDB?" → a config
is a nested document that varies per site; versions with parent links; vectors next to data; one DB.

## 8. Memory types and the collections (B3)
`site_maps` + `recipes` + `harness_configs` = procedural · `visits` = episodic · intent groups over visit
embeddings = semantic. Agent Engine's procedural memory is private by default; ours must be shared per site
(scope deliberately or use plain collections). Atlas Vector Search: index `{vector 1024 cosine + filter siteId}`,
`$vectorSearch` then `$meta: vectorSearchScore`. Last night: 119 ms; add-to-cart 0.709 vs checkout 0.649 →
good at narrowing, Jev makes the final pick.

## 9. Recipes (B3)
A saved step sequence for a goal *type* with blanks. New goal → vector search → Jev fills blanks → steps run
back to back. No recipe → Jev loop. Success → saved. Failure on a recipe step → `brokenAt`, relearned later.
Same goal twice = caching; the 20 held-out goals (reworded, new situations) = generalization. Research:
Agent Workflow Memory (ICML 2025) +24.6% Mind2Web, +51.1% WebArena.

## 10. Honest simulation (B4)
Answer key: 4 planted flaws; 60 goals tagged possible/impossible + flaw. Objective verification by inspecting
shop state (cart, orders, error banners) — no LLM judge. 40 train / 20 held-out. Report kinds separately:
success on possible goals · fast-correct-"no" on impossible · median ms · LLM-fallback rate. Rate limits:
Neon 200k TPM, 20k output TPM, ~$20/day; Jev 80 rps. Guards in `src/llm.js`.

## 11. The improvement loop — the heart of Statement 1 (B5)
1. Run train goals with config vN; every visit stores a trace (page, Jev answers + confidence, outcome, reason).
2. Editor LLM gets: current config + 10 worst traces + metrics. Asks for ≤3 edits as a JSON patch.
3. Code validates the patch: allowed paths only, bounded values, confirm list append-only, checkout never
   removable. Reject anything else. → config vN+1 (parent vN).
4. Run **held-out** goals on vN+1. Keep if success-on-possible ↑ (or ms ↓ with success not ↓); else roll back.
   Both the patch and the verdict are stored. 3 generations.
Why held-out: otherwise the editor could just memorize the training goals. Why code-validated: an LLM editing
its own guardrails must not be able to loosen them. Judge Q: "Isn't this just prompt tuning?" → it edits tools,
context, thresholds and rules too, each change is tested, and rollbacks are kept as evidence.
Code: `src/harness/editor.js`. Try: read one patch + verdict doc in Atlas.

## 12. The evolution view (B6)
One page: version chain v1→v4, each edit in plain words with kept/rolled back, and the metric curve.
Not a dashboard (banned as main feature) — it's the evidence for the loop, shown last.
