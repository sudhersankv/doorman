# Doorman — Pitch & Q&A

Fill the **[N]** numbers from the dashboard after the benchmark (B6). Never say a number you haven't measured.

## 30 seconds (elevator / judge walk-by)
AI agents are visiting websites, and they're slow: dozens of LLM calls just to click through a page.
Website owners can't see what those agents wanted or where they failed.
Doorman is one script tag. It maps your site into tools, and a System 1 model makes each decision in
about 400 ms with no LLM. Every success becomes a recipe in MongoDB Atlas, so the next agent is faster.
Every failure is classified and shown on the owner's dashboard.
We simulated 60 agents on a shop with four planted flaws. Doorman was [N]× faster at 1/[M] the cost,
and its dashboard pinpointed all four: which step, how often, and why.

## 2 minutes (finalist demo intro)
1. **Problem (20 s).** Show a normal browser agent doing "buy running shoes under $80": [N] steps, [N] s,
   [N] LLM calls. Multiply by every agent visiting every site. And the site owner sees "clicked checkout, left."
2. **Doorman (30 s).** One script tag. It builds a map of the site's actions. A visiting agent hands over a goal.
   Jev — a System 1 model — picks the next action from the map in ~400 ms. Code executes it. Repeat.
   First time: ~[N] s. Second time: a recipe from Atlas, ~[N] s.
3. **Memory & governance (30 s).** Atlas holds the site map and recipes (procedural), every visit (episodic),
   and intent clusters (semantic). Purchases need confirmation. Keys are bound to the owner's domain.
4. **Evidence (30 s).** Benchmark: 60 goals, 4 planted flaws, the same LLM for the baseline and Doorman's fallback (Doorman adds Jev), objective verification.
   Doorman: [N]% success, [N] s median, [N]% handled with no LLM, $[N] per goal vs $[N]. Dashboard located 4/4 planted flaws (step + frequency + reason).
   Held-out goals: recipe-hit rate [N]%, latency −[N]% with a recipe.
   Jev matched the LLM on [N]% of decisions at [N]× the speed.
5. **What's next (10 s).** Real site with agent traffic; Agent Engine procedural memory; the no-install
   browser-side version.

## 5 minutes (if asked to go deeper)
Add: the tiered engine (Tier 0/1/2 with confidence thresholds) · why the map makes System 1 viable (Mind2Web:
choose-from-shortlist beats generate) · recipe learning (Agent Workflow Memory +25–51%) · the honesty section.

## Judge-specific angles
- **Steffan (MongoDB):** collections → memory types; Vector Search for recipes and intents; one DB for maps,
  recipes, visits and vectors; Agent Engine mapping (and what we tried with it today).
- **Jackson (Raindrop):** Jev classifies every outcome/failure in ~400 ms — same fast-classifier pattern Raindrop
  uses. Recipes = self-improvement from production traffic. "Raindrop shows agent builders where their agents
  fail; Doorman shows websites where visiting agents fail."
- **Bosco (AWS):** cost per goal, latency, rate-limit-aware runner, deployed URL, what scales (stateless API,
  Atlas does the memory).
- **Aram (Modelence):** install = one tag; snippet page; deployed, not a laptop demo; plain Node, no framework.

## Q&A

**"Isn't this just WebMCP?"** No. WebMCP is the doorway; Doorman is what stands behind it. WebMCP lets a site
expose tools, but someone still has to write them, keep them working, and the site learns nothing about what
agents wanted. Doorman generates the tools from the map, decides in milliseconds, learns recipes, and gives
the owner intent analytics. It registers with WebMCP where the browser supports it.

**"Does it depend on WebMCP?"** No. `window.doorman` + a manifest at `/.well-known/doorman.json` work in every
browser today. Very few agents speak WebMCP yet; we say that plainly.

**"How is this different from Stagehand's action caching / browser-use workflows?"** Those cache per agent, on
the agent's side. Doorman's memory is per site, shared by every visitor, approved by the owner, self-healing when
the site changes — and it produces owner analytics, which an agent-side cache can't.

**"Why Jev instead of a small LLM?"** It's non-autoregressive: all decisions in one pass, ~400 ms, calibrated
confidence we can threshold on, $0.042/M tokens. We don't take the vendor's word: we ran the same 100 decisions
through Jev and gpt-5-4-mini → [N]% agreement, [N]× faster, [M]× cheaper.

**"Where does Jev fail?"** Numbers, dates, free text, vague goals. We handle numbers and free text in code
(filter candidates first, extract phrases) and route the rest to the LLM. The tier share shows exactly how often.

**"Didn't you tell it the failure categories?"** The *categories* are generic (out of stock, validation error, not
found, login required) and work on any site. What Doorman found on its own is *which* flaws this site has, at which
step, how often, and for which goals — "Invalid ZIP at checkout step 4, 11 visitors". That's what an owner needs.

**"Is the traffic real?"** No — simulated LLM agents on a mock shop we built. That's why we planted flaws:
it gives the benchmark an answer key. Real sites will score lower; the next step is a real site with agent traffic.

**"Why MongoDB and not Postgres?"** The site map is a nested document; recipes vary per site; vectors live next
to the data; one database for maps, recipes, visits and search. Atlas Vector Search was tested at 119 ms.

**"Did you use Agent Engine?"** [Fill in: what we tried, what worked, how the collections map to its memory types.]

**"Prompt injection / a malicious site steering agents?"** Doorman exposes specific transparent tools the agent
chooses itself; the goal tool is optional; purchases and submissions always need confirmation; the agent never
hands over credentials. The site can't make the agent do more than the agent's user allowed.

**"Business model?"** Free script, paid analytics for owners (like Google Analytics → GA360). Later: a no-install
agent-side version.

**"What would you do with a week?"** Real-site pilot, Agent Engine memory, recipe self-healing with diffs,
remote MCP endpoint for headless agents, the self-rewriting improvement loop (train/test split).

## Numbers table (fill after B6)
| Metric | Baseline agent | Doorman |
|---|---|---|
| Success rate | | |
| Median s / goal | | |
| LLM calls / goal | | |
| $ / goal | | |
| Goals with no LLM | n/a | |
| Planted flaws located (step + reason) | n/a | /4 |
| Recipe-hit rate on held-out goals | n/a | |
| Median latency: recipe vs no recipe | n/a | |
| Jev vs LLM decision agreement | | |
