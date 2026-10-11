# doorman — demo video & live script (final)

The submission video is produced by code from real recordings: `video/record.js` and `video/record-ab.js` capture
the live site (`https://doorman-trailhead.fly.dev`) with an isolated 1920×1080 Playwright Chromium; `video/build.py`
assembles it with FFmpeg. Every caption that states a number is read from `video/raw/scenes.json`,
`video/raw/ab.json` or `data/compare.json`; `video/out/claims.json` lists each on-screen claim with its source.
Sped-up segments carry an on-screen label. There is no voice track; the narration below can be read over it.

Outputs: `video/out/doorman-demo.mp4` (≈2.5 min) and `video/out/doorman-demo-short.mp4` (≈1 min).

## Storyboard and narration

| # | Scene | What is on screen | Narration (read over it) |
|---|---|---|---|
| 1 | title | doorman wordmark, one-line description | "doorman: a self-improving harness at your website's door. One script tag." |
| 2 | problem | card | "Today an AI agent re-reads your page on every step and calls an LLM each time. Seconds per step, a call per step — and you never learn what it wanted." |
| 3 | the site | Trailhead Outfitters, scroll | "Our test site: a mock shop with four planted flaws as the answer key." |
| 4 | the handoff layer | HUD → tools panel, `size(9)`, `add_to_cart()` called directly | "doorman maps the page into tools and exposes them: WebMCP when the browser has it, a well-known manifest, a page object. An agent can call a tool directly — zero inference — or hand off a goal." |
| 5 | A/B intro + split screen | ordinary LLM agent (left) vs doorman (right), live timers | "Same goal, same fresh cart. Left: an ordinary LLM browser agent reading the DOM. Right: the goal handed to doorman." |
| 6 | A/B result card | measured table | "[read the numbers on the card]. Both verified from the shop's own state." |
| 7 | 23-goal benchmark | aggregate table | "Across 23 held-out goals: [read]. And one honest row: neither agent declines the impossible goals yet." |
| 8 | vague goal | HUD run, outcome as measured | "A vague goal is where it struggles: [read outcome]." |
| 9 | specific goal | HUD run | "A specific goal: three Jev decisions, [ms]." |
| 10 | memory | second run on a fresh cart | "Every visit is remembered in Atlas; successful paths become recipes." [read whether a recipe hit] |
| 11 | owner analytics | dashboard scroll | "The owner's side: what agents came for, where the site stopped them, what to fix first — all from the visits collection." |
| 12 | evolution intro | card | "Then the harness tries to improve itself: an editor LLM proposes a patch to its own config, code validates it, held-out goals decide." |
| 13 | evolution page | version chain, patches, verdicts | "[read the verdicts]. It measured — and refused to keep what didn't help." |
| 14 | close | card | "Any website. One script tag. A door for agents, intent for owners." |

## Live judging (3 min) — see PITCH.md §"3 minutes"

Tabs: `/shop/` (HUD) · `/dashboard/` · `/evolution/` · GitHub README. Backup: the MP4 on laptop and phone.

## Re-producing the video
```
node video/record-ab.js                      # A/B clips + ab.json           (laptop, real services)
npm run compare -- --base <url>              # data/compare.json             (laptop, real services)
node video/record.js [--only a,b]            # scenes + scenes.json          (laptop)
python3 video/build.py                       # video/out/*.mp4 + claims.json (anywhere with ffmpeg + PIL)
```
