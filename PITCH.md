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

## Numbers (final run, real Jev; held-out = 23 goals: 14 possible, 9 impossible; 40 train goals per generation)
| Metric | v1 cold | v1 warm (recipes) | v4 active (kept) | note |
|---|---|---|---|---|
| Success on possible goals | 93% | 86–93% (run-to-run) | **93%** (from 86% same-conditions baseline) | +1 goal on held-out |
| Median time per goal | 4.0 s | 2.4–4.9 s | **2.8 s** | recipes + edits; variance is mostly LLM latency |
| Steps decided by the LLM | 30% | 32% | **28%** | the rest by Jev (~400 ms each) and recipes |
| Recipe hits (held-out) | 0% | 13% | 17% | learned on train goals, reused on reworded held-out goals |
| Impossible goals refused fast | 33% | 22% | 22% | out-of-stock refused in 1 step; search-no-results and the ZIP bug still run to the limit |
| Generations | 3 | | 1 kept, 2 rolled back | both rollbacks stored with patch + metrics |
| LLM spend, whole loop | $0.003 | | | editor + fallbacks |

**What the editor did (kept, v4):** rewrote the fast model's instructions, added `checkout` to the confirmation list (guardrail got stricter), added a rule to validate common form formats before submitting.
**Rolled back:** raising the Jev threshold (more LLM steps, slower); a search-synonyms description + lower threshold (faster but one more failure).

**Three honest lines:** (1) simulated agents on our own mock shop; (2) the success gain is one held-out goal, the speed gain is recipes plus edits; (3) two planted flaws (no-results search, ZIP bug) still aren't refused fast; the editor can tune `impossibleThreshold` but didn't find it in three generations.
