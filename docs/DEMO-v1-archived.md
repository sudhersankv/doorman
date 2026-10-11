# Doorman — Demo video & live demo plan

## Format
- **Length:** 2:30–3:00. Judges watch many; front-load the payoff.
- **Record:** 1080p, Windows Game Bar (Win+G) or OBS, mic on, browser zoomed to 125%. Dark terminal, light browser.
- **Everything shown is live** — no mock-ups. Pre-run the benchmark so the dashboard has data; the side-by-side is real.
- Record **twice**; keep the better take. Do a silent dry run first.

## Shot list (with timings)

**0:00–0:20 — The problem (screen: baseline agent, headed Chromium)**
"This is how AI agents use websites today." Start the baseline agent on: *buy running shoes under $80*.
Let it click for ~10 s, then speed up 4×. Overlay: steps · seconds · LLM calls · $.
Line: "Dozens of LLM calls, a minute, and the site owner sees nothing but 'clicked checkout, left'."

**0:20–0:40 — One script tag (screen: shop page source)**
Show `<script src="/doorman.js" data-site="trailhead">`. "That's the whole install."
Show the map briefly: DevTools console → `doorman.map()` → ~30 actions.

**0:40–1:10 — Side by side (screen: two browser windows)**
Left: baseline (already running from 0:00, still going). Right: `doorman.do("buy running shoes under $80")`.
Right finishes in seconds. Show the overlay: steps, ms, "Jev decisions: N, LLM calls: 0".
Line: "Each decision is one call to Jev, a System 1 model, about 400 milliseconds."

**1:10–1:30 — It learns (same window)**
Run a *reworded* goal: "I need cheap running shoes, max 80 bucks". Overlay shows `tier: recipe`, faster —
that's generalization, not caching. Switch to Atlas (Compass or web UI): open the
`recipes` document that was just created. Line: "That recipe lives in MongoDB Atlas. The next agent, from
anywhere, gets it."

**1:30–2:15 — The owner's dashboard (screen: /dashboard on the Fly URL)**
Panel by panel, 8–10 s each:
1. Speed & cost: baseline vs Doorman bars.
2. Recipe-hit rate and median latency over the run ("it gets faster as it learns").
3. What visitors wanted: intent clusters.
4. Where they failed: "Invalid ZIP at checkout step 4 — 11 visitors", "Trail Runner size 10 out of stock — 9".
5. Unmet demand: "6 agents wanted kids' sizes; you sell none."
Then the reveal: "We planted exactly four flaws in this shop. Doorman located all four — the step, the frequency,
the reason — from agent traffic alone."

**2:15–2:40 — Honesty + what's next (screen: PITCH numbers table)**
"Simulated agents, mock shop, best case — we say so. Same LLM for the baseline and our fallback, objective verification,
run twice. Jev matched the LLM on N% of decisions at N× the speed." Next: real site, Agent Engine memory.

**2:40–2:50 — Close (screen: landing / snippet page)**
"Every website needs a doorman for AI agents. Doorman: one tag, memory in Atlas, decisions in milliseconds,
and owners finally see why agents came." URL on screen.

## Live demo (if finalists present on stage)
- Have the side-by-side pre-loaded in two windows; press Enter in both at once.
- Dashboard open in a third tab on the Fly URL (not localhost — Wi-Fi may differ).
- Backup: the recorded video on the laptop and on your phone.
- If Jev or Neon is down on stage: run the recorded video, say "live services; here's the recording from 2 hours ago."
- Rehearse 3× against a timer. Keep total under 3 minutes; leave time for questions.

## Pre-flight (15 min before recording)
- [ ] `npm run dev` running; shop loads; `doorman.do()` works once
- [ ] Benchmark run finished; dashboard shows it; numbers copied into PITCH.md
- [ ] Fly URL loads shop + dashboard
- [ ] Atlas UI logged in, `recipes` collection open
- [ ] Baseline agent headed mode tested once (`HEADED=1`)
- [ ] Notifications off, phone silent, mic test
