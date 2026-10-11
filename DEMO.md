# Doorman — Demo (final): 60-second submission video + 3-minute live judging

Everything shown is live on `http://localhost:3000` with the real services (Atlas sandbox, Jev, Voyage, Neon).
Keep `run-server.bat` open. Numbers come from `logs/11-bench-v1.log` and `logs/12-evolve.log` of the final run.

## Submission video (60 s)
Record 1080p (Win+G), mic on, browser zoom 125%, dark terminal hidden. Two takes, keep the better.

| Time | Screen | Say |
|---|---|---|
| 0–8 s | `/shop/` with the Doorman box bottom-right | "Trailhead Outfitters: a mock shop with four planted flaws. Doorman is one script tag." (show `data-site="trailhead" data-hud` in view-source for 2 s) |
| 8–25 s | Type `buy running shoes under $80` → Go | "A System 1 model, Jev, picks each step in a few hundred milliseconds from the site's own actions. Every decision and its confidence are right there." Then `Trail Runner size 10 to my cart` → "not possible here" in one step: "and it refuses impossible goals fast." |
| 25–50 s | `/evolution/` | "After each batch of visits the harness rewrites itself: an LLM proposes edits to its tools, context and guardrails, code validates them, held-out goals decide. v2 was kept: 26% faster. The rest were rolled back, and they're stored as evidence." Point at one patch line. |
| 50–60 s | README on GitHub | "Generic code, site-specific memory, everything in MongoDB Atlas. Built today." |

## Live judging (3 min + Q&A)
Tabs ready: `/shop/` (HUD visible) · `/evolution/` · Atlas → `harness_configs` · GitHub README. Backup: the video on laptop and phone.

1. **Problem (20 s).** Agents fail ~40% of realistic tasks on real sites and take minutes; owners see "clicked, left".
2. **Live (60 s).** HUD: `buy running shoes under $80` (3 steps, ~3 s, all Jev). Then `Trail Runner size 10 to my cart` → refused in 1 step. Then a reworded goal → `recipe` tier.
3. **It rewrites itself (60 s).** `/evolution/`: version chain, one kept edit read aloud, rolled-back ones. "Guardrails can only get stricter. Held-out goals decide. Rollbacks are kept."
4. **Numbers (30 s).** From PITCH.md table.
5. **Honesty + next (10 s).** Simulated agents, mock shop, best case. Next: real traffic, Agent Engine procedural memory, the no-install agent-side version.

Rehearse 3× against a timer; leave 30 s spare.

## Pre-flight
- [ ] server up; HUD goal works; refusal works; `/evolution/` shows the final run
- [ ] PITCH.md numbers filled from the final logs
- [ ] repo pushed (`git push -u origin main`), public
- [ ] notifications off, charger, mic test
