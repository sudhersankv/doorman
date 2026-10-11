# Doorman — Demo (v2): 1-min submission video + 3-min live judging

## Submission video (60 s, required)
Record 1080p (Win+G or OBS), mic on, browser at 125%. Everything live. Two takes, keep the better.
- **0–8 s** Shop page. "Trailhead Outfitters, a mock shop with four planted flaws. One script tag." Show the tag.
- **8–25 s** Console: `doorman.do("buy running shoes under $80")`. Steps + ms counter. Then reworded goal → `tier: recipe`.
- **25–50 s** `/evolution`: version chain v1→v4, one kept edit read aloud, one rolled-back edit, metric curve.
  "An LLM proposes, code validates, held-out goals decide. Built today, in the Atlas sandbox."
- **50–60 s** "Doorman: a self-improving harness at the website's door." Repo URL on screen.

## Live judging (3 min + Q&A)
Pre-load three tabs: shop with console open · Atlas `harness_configs` · `/evolution`. Backup: the video on laptop + phone.
Script = PITCH.md "3 minutes". If Jev/Neon is down: play the video, say "live services; recorded 20 min ago."
Rehearse 3× with a timer. Leave 30 s spare.

## Pre-flight
- [ ] `npm run dev` up; `doorman.do()` works once; a reworded goal hits a recipe
- [ ] ≥2 generations in Atlas with one kept + one rolled-back edit
- [ ] `/evolution` loads with real numbers; numbers copied into PITCH.md
- [ ] repo public, README has: what it is, what evolves, how to run, what was built today
- [ ] notifications off, mic test, charger
