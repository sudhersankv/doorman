'use strict';
/** One tiny call to each external service (Jev, Voyage, Neon, Atlas). Prints OK/FAILED + ms per service; exit 1 on any failure. */
require('../src/lib/env');
const { makeDeps } = require('../src/lib');

async function timed(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`OK      ${name.padEnd(7)} ${String(Date.now() - t0).padStart(6)} ms${detail ? '  ' + detail : ''}`);
    return true;
  } catch (e) {
    console.log(`FAILED  ${name.padEnd(7)} ${String(Date.now() - t0).padStart(6)} ms  ${(e && e.message) || e}`);
    return false;
  }
}

async function main() {
  const deps = await makeDeps(process.env);
  const results = [];
  try {
    results.push(await timed('atlas', async () => {
      const r = await deps.db.raw.command({ ping: 1 });
      if (r.ok !== 1) throw new Error('ping returned ' + JSON.stringify(r));
      return `db=${process.env.MONGODB_DB || 'doorman'}`;
    }));
    results.push(await timed('jev', async () => {
      const { answers } = await deps.jev.decide(
        { goal: 'turn the light on', page: { actions: ['light_on', 'light_off'] } },
        { next: { type: 'choice', instructions: 'Pick the action that achieves the goal.', criteria: { light_on: 'turn the light on', light_off: 'turn the light off' } } },
      );
      const a = answers && answers.next;
      if (!a || !a.choice) throw new Error('no choice in answers: ' + JSON.stringify(answers).slice(0, 200));
      return `choice=${a.choice} confidence=${a.confidence ?? '?'}`;
    }));
    results.push(await timed('voyage', async () => {
      const [vec] = await deps.embed.embed(['hello from the door'], 'query');
      if (!Array.isArray(vec) || !vec.length) throw new Error('empty embedding');
      return `dims=${vec.length}`;
    }));
    results.push(await timed('neon', async () => {
      const { text } = await deps.llm.chat([{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 5, tag: 'check' });
      if (!/OK/i.test(text)) throw new Error('unexpected reply: ' + JSON.stringify(text).slice(0, 80));
      return `model=${deps.llm.model}`;
    }));
  } finally { await deps.db.close(); }
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} service(s) FAILED` : '\nall services OK');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FAILED', e.message || e); process.exit(1); });
