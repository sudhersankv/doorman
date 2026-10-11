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

## Numbers (final run, corrected evaluation; real Jev; held-out = 23 goals: 14 possible, 9 impossible)
| Metric | v1 seed (cold, with recipes off) | v1 warm (recipes on) | candidates v2–v4 |
|---|---|---|---|
| Success on possible goals | **93%** (13/14) | 86–93% run to run | 86% each → all rolled back |
| Median time per goal | 3.0–4.0 s | **2.4–2.8 s** | 3.4–6.2 s |
| Steps decided by the LLM | 28–29% | ~30% | 17% (v2, threshold 0.65) · 35% · 34% |
| Impossible goals refused fast | 22% | 22% | 22–33% |
| Recipe hits (held-out, warm) | — | 13–17% | — |
| Generations | 3 | | 0 kept, 3 rolled back, $0.004 of LLM |

**What the editor proposed and why each was rejected on unseen goals:**
- v2: tool descriptions + a ZIP precondition + Jev threshold 0.70→0.65. LLM steps fell 29%→17% (the candidate really ran), but one more goal failed. Rolled back.
- v3: instruction rewrite + a no-repeat rule + `checkout` added to confirm. Same success, slower. Rolled back.
- v4: search description/precondition + an address-validation rule. One more goal failed, much slower. Rolled back.

**The bug we caught, and say out loud:** our first evolution runs "kept" versions by noise: candidates were stored inactive and the decision endpoint always loaded the active config, so every candidate was measured as the old one. A reviewer flagged it; we traced it, threaded the version end to end, added a regression test that two stored versions decide differently, disabled recipe memory during held-out comparisons so configs are compared on equal footing, and re-ran. The corrected loop rejected all three. We'd rather show a loop that says no correctly than one that says yes by accident.

**Three honest lines:** simulated agents on our own shop · the seed config was already near the ceiling (13/14; the 14th is a multi-page sign-in flow) · two planted flaws (no-results search, ZIP bug) still aren't refused fast; `impossibleThreshold` is in the editor's reach but it didn't find it in three generations.
