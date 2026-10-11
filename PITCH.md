# Doorman — Pitch & Q&A (v2). Fill [N] from `/evolution` after B5. Never say an unmeasured number.

## 30 seconds
AI agents are visiting websites and failing: on real sites the best ones complete about 60% of tasks, and they
take minutes to do it. Doorman is a self-improving harness at the website's door. One script tag. It maps the
site into tools, a System 1 model makes each decision in about 400 ms, and every visit is remembered in Atlas.
Then it rewrites itself: after each batch of visits it edits its own tools, context, guardrails and rules, tests
the new version on held-out goals, and keeps only what works. Over [N] generations, success on possible goals
went from [N]% to [N]% and the harness learned [example rule] on its own.

## 3 minutes (judging round)
1. **Problem (20 s).** Agents fail possible tasks and waste minutes on impossible ones; sites see "clicked checkout, left."
2. **Live (60 s).** `doorman.do("buy running shoes under $80")` → steps + ms counter. Then a *reworded* goal →
   `tier: recipe`, faster. "Each decision is one Jev call; the harness config in Atlas tells it what to see and when to stop."
3. **It rewrites itself (60 s).** `/evolution`: v1→v4. Point at one kept edit ("added: select size before add to cart")
   and one rolled-back edit. "An LLM proposes, code validates, held-out goals decide. Guardrails can only get stricter."
4. **Numbers (30 s).** Success on possible goals [N]→[N]%; impossible goals answered 'no' in [N] s; LLM fallback [N]→[N]%.
5. **Honesty + next (10 s).** Simulated agents, mock shop, best case. Next: real site traffic, Agent Engine procedural memory.

## Judge angles
- **MongoDB (Steffan):** config versions with parent links, recipes + visits + vectors in one DB, memory-type mapping, sandbox cluster.
- **Raindrop (Jackson):** this *is* recursive self-improvement with evidence: patch, verdict, rollback, held-out. Jev classifies failures ~400 ms like Raindrop's signals.
- **AWS (Bosco):** cost/goal, latency, stateless API, one service for all sites.
- **Modelence (Aram):** one tag to install, plain Node, no framework.

## Q&A
**"What exactly evolves?"** Tools (exposed/description/preconditions), context policy (fields, history), guardrails
(confirm list, max steps, threshold), rules and recipes. All in one versioned config document.
**"How does it rewrite itself?"** The harness's behavior is data in Atlas. An editor LLM reads the worst traces and
proposes ≤3 JSON edits; code validates paths and bounds; the new version runs on held-out goals; kept or rolled back.
**"Can it make itself unsafe?"** No. Confirm list is append-only in code, checkout can never be removed, thresholds
are bounded, and the LLM never executes anything — it only proposes a patch.
**"Isn't this prompt tuning?"** It also changes tool access, context and guardrails, every change is measured on
goals it didn't see, and rollbacks are stored as evidence.
**"Is a dashboard the main feature?"** No — the harness and its loop are. `/evolution` is a 10-second evidence page.
**"Why Jev / System 1?"** Map → closed menu → classification. ~400 ms, calibrated confidence we threshold on. Fallback rate is measured.
**"WebMCP?"** We expose `window.doorman` + manifest today; register `document.modelContext` tools where supported.
**"Stagehand caching?"** Per-agent, agent-side. Ours is per-site, shared, owner-governed, self-improving.
**"Real traffic?"** No — simulated LLM agents on a mock shop with planted flaws (an answer key). Say so first.
**"What's new today?"** Everything in the repo. Setup scripts and keys from last night are not the product.
**"Why MongoDB not Postgres?"** Nested per-site config, version chains, vectors next to data, one DB.
**"Business?"** Free script, paid insight for owners; later a no-install agent-side version.

## Numbers (run 2, real Jev, held-out 23 goals: 14 possible, 9 impossible) — replace with run 3 if better
| Metric | v1 (seed) | v4 (active, kept) | note |
|---|---|---|---|
| Success on possible goals | 79% (11/14) | 79% (11/14) | the same 3 goals fail every version: two need the footer sign-in, one is an 8-step order |
| Median time per goal | 4.7 s | 3.8 s | kept on the latency rule (−18%) |
| Steps needing the LLM | 1.5% | 1.5% | everything else decided by Jev |
| Impossible goals answered "no" fast | 22% (2/9) | 22% | out-of-stock refused in 1 step; search-no-results and ZIP-bug still run to the step limit |
| Generations | 4 | | 1 kept, 3 rolled back (slower, no success gain) |
| LLM spend for 4 generations | $0.003 | | editor + fallbacks; Jev did the rest |
| Jev decisions per goal | ~5 | | ~1.3 s of Jev time per goal |

What the editor actually did (kept): added descriptions for the sign-in and orders tools ("requires authentication … will show 'Please sign in'"), raised the Jev threshold to 0.78. Rolled back: a search precondition + reworded instructions (slower), a required-option precondition on add (slower), another instruction rewrite (slower).

Honest reading: on this shop the loop found speed, not success; the stuck goals need a longer multi-page recipe (sign in → orders → order) which only forms once a visit succeeds. That's the next step and we say so.
