# Doorman

**A self-improving harness at a website's door.** One script tag maps a site into tools for visiting AI agents,
a System 1 model (Jev) makes each decision in ~400 ms, every visit is remembered in MongoDB Atlas, and the harness
rewrites its own rules, context policy, guardrails and tool access from what visitors got stuck on — keeping only
the changes that measurably help on held-out goals.

Built at the MongoDB Harness Engineering & Model Wrangling hackathon, SF Tech Week, Oct 11 2026 (Problem Statement 1: Recursive Harnessing).

- `PLAN.md` — architecture, build order, decisions
- `LEARN.md` — the concepts, section by section
- `PITCH.md`, `DEMO.md` — judging material

## Run
```
npm install
cp .env.example .env   # fill in Atlas (hackathon sandbox), Voyage, Jev, Neon
npm run dev            # http://localhost:3000/shop/
npm run verify:demo    # proves the mock shop's 4 planted flaws + the verifier
```
