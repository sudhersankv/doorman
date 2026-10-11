// Objective outcome verification. Reads the shop's own state (window.shopState()) — no LLM judging.
// A goal spec: { kind: 'add_to_cart'|'place_order'|'view_order'|'find'|'impossible', ... }
// Returns { success, failureKind, reason, detail }
//   failureKind: 'possible-agent' | 'possible-site' | 'impossible' | null
const FLAWS = {
  A: { code: 'OUT_OF_STOCK', kind: 'impossible', label: 'Trail Runner size 10 always out of stock' },
  B: { code: 'VALIDATION_ERROR', kind: 'impossible', label: 'checkout rejects ZIPs starting with 9' },
  C: { code: 'LOGIN_REQUIRED', kind: 'possible-site', label: 'order tracking needs sign-in; link buried in footer' },
  D: { code: 'NOT_FOUND', kind: 'impossible', label: 'no kids sizes / no vegan line' },
};

function verify(goal, state, agentSaidImpossible = false) {
  const err = state.lastError;
  const has = (id, size) => state.cart.some((i) => i.id === id && (size == null || String(i.size) === String(size)));
  const placed = (id) => state.orders.some((o) => o.status === 'Processing' && (!id || o.items.some((i) => i.id === id)));

  if (goal.kind === 'add_to_cart') {
    if (has(goal.productId, goal.size)) return ok();
    if (goal.flaw === 'A' && err?.code === 'OUT_OF_STOCK') return impossibleHandled(agentSaidImpossible, 'OUT_OF_STOCK');
    return fail(goal, err);
  }
  if (goal.kind === 'place_order') {
    if (placed(goal.productId)) return ok();
    if (goal.flaw === 'B' && err?.code === 'VALIDATION_ERROR') return impossibleHandled(agentSaidImpossible, 'VALIDATION_ERROR');
    return fail(goal, err);
  }
  if (goal.kind === 'view_order') {
    if (state.viewedOrders.includes(String(goal.orderId))) return ok();
    return fail(goal, err); // flaw C is possible: the agent should find the footer sign-in
  }
  if (goal.kind === 'find') {
    if (state.events.some((e) => e.type === 'view_product' && e.id === goal.productId)) return ok();
    return fail(goal, err);
  }
  if (goal.kind === 'impossible') { // e.g. kids sizes, vegan line
    return impossibleHandled(agentSaidImpossible, 'NOT_FOUND');
  }
  return fail(goal, err);

  function ok() { return { success: true, failureKind: null, reason: null }; }
  function impossibleHandled(said, code) {
    return { success: said, failureKind: 'impossible', reason: code, detail: said ? 'correctly reported impossible' : 'did not report impossible' };
  }
  function fail(g, e) {
    const kind = g.flaw && FLAWS[g.flaw] ? FLAWS[g.flaw].kind : 'possible-agent';
    return { success: false, failureKind: kind, reason: e?.code || 'INCOMPLETE', detail: e?.message || 'goal not reached' };
  }
}
module.exports = { verify, FLAWS };
