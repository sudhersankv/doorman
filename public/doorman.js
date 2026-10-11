/* Doorman — the script tag. Generic page mapper + executor for visiting AI agents.
 *
 * Public API (CONTRACTS §11):
 *   window.doorman = { version, siteId, map(), do(goal, opts), tools(), act(key, params), lastSnapshot }
 *
 * This file knows nothing about any particular site. It only understands the DOM:
 * interactive elements, repeated structures, live regions and form fields.
 * ES2020, zero dependencies, never throws into the host page.
 */
(function () {
  'use strict';
  if (window.doorman) return;

  const VERSION = '0.1.0';
  const SETTLE_QUIET_MS = 150;
  const SETTLE_MAX_MS = 1500;

  /* ------------------------------------------------------------------ */
  /* Bootstrap: siteId + apiBase from our own <script> tag               */
  /* ------------------------------------------------------------------ */
  const scriptEl = document.currentScript || Array.from(document.scripts).find((s) => /doorman\.js/.test(s.src || ''));
  const siteId = (scriptEl && scriptEl.getAttribute('data-site')) || location.hostname || 'unknown';
  const defaultApiBase = (scriptEl && scriptEl.getAttribute('data-api')) || location.origin;

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                        */
  /* ------------------------------------------------------------------ */
  const text = (el) => ((el && (el.innerText != null ? el.innerText : el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const attr = (el, n) => (el && el.getAttribute(n)) || '';
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'));
  const attrQuote = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** FNV-1a 32-bit hash → 6 hex chars. */
  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0').slice(0, 6);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden],[aria-hidden="true"]')) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkVisibilityCSS: true })) return false;
    } else if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  const isEnabled = (el) => !el.disabled && attr(el, 'aria-disabled') !== 'true' && !el.closest('fieldset:disabled');

  /* ------------------------------------------------------------------ */
  /* Accessible name, role, kind                                         */
  /* ------------------------------------------------------------------ */
  function accessibleName(el) {
    const al = attr(el, 'aria-label').trim();
    if (al) return al;
    const lb = attr(el, 'aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => text(document.getElementById(id))).filter(Boolean).join(' ');
      if (t) return t;
    }
    if (el.id) {
      const lab = document.querySelector('label[for=' + cssEscape(el.id) + ']');
      if (lab && text(lab)) return text(lab);
    }
    const wrap = el.closest('label');
    if (wrap) {
      // Wrapping label: its text minus the text of the control(s) inside it.
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll('input,select,textarea,button').forEach((c) => c.remove());
      const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    const ph = attr(el, 'placeholder').trim(); if (ph) return ph;
    const ti = attr(el, 'title').trim(); if (ti) return ti;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && /^(submit|button|reset)$/.test(el.type) && el.value) return el.value;
    const t = text(el); if (t) return t;
    const img = el.querySelector('img[alt]'); if (img && img.alt.trim()) return img.alt.trim();
    const alt = attr(el, 'alt').trim(); if (alt) return alt;
    if (tag === 'input' && el.name) return el.name;
    return '';
  }

  function roleOf(el) {
    const r = attr(el, 'role'); if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (el.isContentEditable) return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'search') return 'searchbox';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'number' || t === 'range') return 'spinbutton';
      if (/^(submit|button|reset|image)$/.test(t)) return 'button';
      return 'textbox';
    }
    return 'generic';
  }

  /** kind ∈ click | link | type | select | check | submit */
  function kindOf(el, role) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'textarea' || el.isContentEditable) return 'type';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return 'check';
      if (t === 'submit' || t === 'image') return 'submit';
      if (t === 'button' || t === 'reset') return 'click';
      return 'type';
    }
    if (tag === 'button') return (el.type === 'submit' && el.form) ? 'submit' : 'click';
    if (role === 'link') return 'link';
    if (role === 'textbox' || role === 'combobox' || role === 'searchbox') return 'type';
    if (role === 'checkbox') return 'check';
    return 'click';
  }

  /* ------------------------------------------------------------------ */
  /* Selectors                                                            */
  /* ------------------------------------------------------------------ */
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur.nodeType === 1) {
      if (cur.id) { parts.unshift('#' + cssEscape(cur.id)); break; }
      const tag = cur.tagName.toLowerCase();
      const sameTag = Array.from(cur.parentNode ? cur.parentNode.children : []).filter((c) => c.tagName === cur.tagName);
      parts.unshift(sameTag.length > 1 ? tag + ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')' : tag);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function selectorFor(el) {
    const tag = el.tagName.toLowerCase();
    const candidates = [];
    if (el.id) candidates.push('#' + cssEscape(el.id));
    if (el.dataset && el.dataset.testid) candidates.push('[data-testid=' + attrQuote(el.dataset.testid) + ']');
    if (attr(el, 'aria-label')) candidates.push(tag + '[aria-label=' + attrQuote(attr(el, 'aria-label')) + ']');
    if (el.name && /^(input|select|textarea)$/.test(tag)) candidates.push(tag + '[name=' + attrQuote(el.name) + ']');
    for (const c of candidates) if (unique(c)) return c;
    return cssPath(el);
  }

  /* ------------------------------------------------------------------ */
  /* Numbers with units  (CONTRACTS §1)                                  */
  /* ------------------------------------------------------------------ */
  // Keys: currency symbol ("$", "€", "£") or unit; "star"/"stars" normalised to "★"; bare numbers → "#".
  // Clock times ("9:30 AM", "14:05", "9 pm") → attrs.time as decimal hours (24h). First occurrence of a key wins.
  const TIME_RE = /(?<![\w.:])(\d{1,2}):(\d{2})\s*(am|pm)?(?![\w:])/gi;
  const NUM_RE = /(?<![\w.])([$€£])?(\d+(?:\.\d+)?)(?:\s*(%|★|stars?|mi|km|kg|lb|min|h|am|pm|°)(?![a-z]))?/gi;
  function extractAttrs(str) {
    const attrs = {};
    const put = (k, v) => { if (!(k in attrs)) attrs[k] = v; };
    const toHours = (h, m, ap) => {
      h = Number(h); m = Number(m || 0);
      if (ap) { ap = ap.toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
      return h + m / 60;
    };
    const rest = str.replace(TIME_RE, (_, h, m, ap) => { put('time', toHours(h, m, ap)); return ' '; });
    for (const m of rest.matchAll(NUM_RE)) {
      const [, cur, num, unit] = m;
      const n = Number(num);
      if (cur) put(cur, n);
      else if (unit && /^(am|pm)$/i.test(unit)) put('time', toHours(n, 0, unit));
      else if (unit) put(/^stars?$/i.test(unit) ? '★' : unit.toLowerCase() === '°' ? '°' : unit.toLowerCase(), n);
      else put('#', n);
    }
    return attrs;
  }

  /* ------------------------------------------------------------------ */
  /* Template hash: tag+role skeleton, values stripped, repeats collapsed */
  /* ------------------------------------------------------------------ */
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META']);
  function skeleton(el) {
    const kids = [];
    for (const c of el.children) {
      if (SKIP_TAGS.has(c.tagName)) continue;
      const s = skeleton(c);
      // Collapse runs of identical siblings so 3 cards and 12 cards hash the same.
      if (kids.length && kids[kids.length - 1] === s) continue;
      kids.push(s);
    }
    const role = attr(el, 'role');
    return el.tagName.toLowerCase() + (role ? '[' + role + ']' : '') + (kids.length ? '(' + kids.join(',') + ')' : '');
  }
  const templateHash = () => fnv(skeleton(document.body || document.documentElement));

  /* ------------------------------------------------------------------ */
  /* Snapshot                                                             */
  /* ------------------------------------------------------------------ */
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=textbox], [role=combobox], [role=checkbox], [contenteditable=""], [contenteditable=true]';
  const TEXTY = (el) => (el.tagName === 'INPUT' && !/^(checkbox|radio|submit|button|reset|image|file)$/.test(el.type)) || el.tagName === 'TEXTAREA' || el.isContentEditable;

  function submitSelectorFor(el) {
    const form = el.form || el.closest('form');
    if (!form) return undefined;
    const btn = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
    return btn && isVisible(btn) ? selectorFor(btn) : undefined;
  }

  function collectActions() {
    const actions = [];
    const seen = new Map(); // selector → action
    const keys = new Map(); // key → count
    const els = [];
    document.querySelectorAll(INTERACTIVE).forEach((el) => {
      if (!isVisible(el) || !isEnabled(el)) return;
      const selector = selectorFor(el);
      if (seen.has(selector)) return;
      const role = roleOf(el);
      const kind = kindOf(el, role);
      const name = accessibleName(el) || (kind + ' ' + el.tagName.toLowerCase());
      let key = slug(name) || kind;
      if (keys.has(key)) { const n = keys.get(key) + 1; keys.set(key, n); key = key + '_' + n; } else keys.set(key, 1);
      const a = { key, kind, name, role, selector };
      if (el.tagName === 'SELECT') a.options = Array.from(el.options).map((o) => ({ value: o.value, label: text(o) || o.label || o.value }));
      if (kind === 'type' && TEXTY(el)) { const s = submitSelectorFor(el); if (s) a.submit = s; }
      if (kind === 'link') a.href = attr(el, 'href');
      actions.push(a); seen.set(selector, a); els.push(el);
    });
    return { actions, els };
  }

  // Repeated sibling structures: >= 3 siblings sharing tag + class signature → items.
  // Tags that are never item roots: controls, inline text, table cells (their row is the item).
  const NOT_ITEM = new Set(['OPTION', 'LABEL', 'TD', 'TH', 'BR', 'HR', 'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'IMG']);
  const sig = (el) => el.tagName + '.' + Array.from(el.classList).sort().join('.');
  function collectItems(actions, els) {
    const items = [];
    const chosen = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      const el = node; node = walker.nextNode();
      if (SKIP_TAGS.has(el.tagName) || NOT_ITEM.has(el.tagName)) continue;
      if (chosen.some((c) => c.contains(el))) continue; // already inside an item
      const parent = el.parentElement; if (!parent) continue;
      const s = sig(el);
      const group = Array.from(parent.children).filter((c) => sig(c) === s && isVisible(c) && text(c));
      if (group.length < 3 || group[0] !== el) continue;
      for (const g of group) {
        chosen.push(g);
        const t = text(g);
        items.push({
          key: 'item_' + (items.length + 1),
          text: t.length > 160 ? t.slice(0, 157) + '…' : t,
          attrs: extractAttrs(t),
          actionKeys: actions.filter((a, i) => g.contains(els[i])).map((a) => a.key),
        });
      }
    }
    return items;
  }

  // Live regions and error/success boxes. Large aria-live regions (> 240 chars) are page containers, not messages.
  function collectMessages() {
    const cands = [];
    document.querySelectorAll('[role=alert],[role=status],[aria-live],[class*=error],[class*=success],[class*=alert],[id*=error],[id*=success],[id*=alert]').forEach((el) => {
      if (!isVisible(el) || attr(el, 'aria-live') === 'off') return;
      const t = text(el); if (!t) return;
      if (!attr(el, 'role') && t.length > 240) return;
      // A live region that contains controls is a page region (a <main aria-live>), not a message.
      if (!attr(el, 'role') && el.querySelector('a,button,input,select,textarea,[role=button],[role=link]')) return;
      const role = attr(el, 'role') || (/error|alert/i.test(el.className + ' ' + el.id) ? 'alert' : 'status');
      cands.push({ el, role, text: t.length > 300 ? t.slice(0, 297) + '…' : t });
    });
    const inner = cands.filter((c) => !cands.some((o) => o !== c && c.el.contains(o.el)));
    const out = []; const seen = new Set();
    for (const c of inner) { const k = c.role + '|' + c.text; if (!seen.has(k)) { seen.add(k); out.push({ role: c.role, text: c.text }); } }
    return out;
  }

  function collectFields(actions, els) {
    const fields = [];
    actions.forEach((a, i) => {
      const el = els[i];
      if (a.kind === 'type') fields.push({ key: a.key, kind: a.kind, name: a.name, selector: a.selector, value: el.isContentEditable ? text(el) : String(el.value || '') });
      else if (a.kind === 'select') fields.push({ key: a.key, kind: a.kind, name: a.name, selector: a.selector, value: String(el.value) });
      else if (a.kind === 'check') fields.push({ key: a.key, kind: a.kind, name: a.name, selector: a.selector, value: !!el.checked });
    });
    return fields;
  }

  /** Build the page snapshot (CONTRACTS §1). */
  function map() {
    const { actions, els } = collectActions();
    const items = collectItems(actions, els);
    const snap = {
      siteId, url: location.href, title: document.title, templateHash: templateHash(),
      actions, items, messages: collectMessages(), fields: collectFields(actions, els),
      counts: { actions: actions.length, items: items.length },
    };
    api.lastSnapshot = snap;
    return snap;
  }

  /* ------------------------------------------------------------------ */
  /* Executor                                                             */
  /* ------------------------------------------------------------------ */
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  const fire = (el, type, init) => el.dispatchEvent(new Event(type, Object.assign({ bubbles: true, cancelable: true }, init || {})));
  const fireKey = (el, type) => el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));

  /** Wait for the DOM to go quiet (no mutations for SETTLE_QUIET_MS, cap SETTLE_MAX_MS). */
  function settle(waitHash) {
    return new Promise((resolve) => {
      let timer, done = false;
      const finish = () => { if (done) return; done = true; mo.disconnect(); clearTimeout(timer); clearTimeout(cap); window.removeEventListener('hashchange', onHash); resolve(); };
      const bump = () => { clearTimeout(timer); timer = setTimeout(finish, SETTLE_QUIET_MS); };
      const onHash = () => bump();
      const mo = new MutationObserver(bump);
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const cap = setTimeout(finish, SETTLE_MAX_MS);
      if (waitHash) window.addEventListener('hashchange', onHash);
      bump();
    });
  }

  function performStep(action, params) {
    const el = document.querySelector(action.selector);
    if (!el) throw new Error('element not found: ' + action.selector);
    params = params || {};
    const value = params.value != null ? params.value : params.text;
    switch (action.kind) {
      case 'type': {
        if (el.isContentEditable) { el.textContent = String(value == null ? '' : value); fire(el, 'input', { cancelable: false }); }
        else { el.focus(); setNativeValue(el, String(value == null ? '' : value)); fire(el, 'input', { cancelable: false }); fire(el, 'change', { cancelable: false }); }
        if (action.submit) { const b = document.querySelector(action.submit); if (b) { b.click(); break; } }
        const prevented = !fireKey(el, 'keydown'); fireKey(el, 'keypress'); fireKey(el, 'keyup');
        if (!prevented && el.form && params.submit !== false) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
        break;
      }
      case 'select': {
        const opts = Array.from(el.options || []);
        const hit = opts.find((o) => o.value === String(value)) || opts.find((o) => text(o).toLowerCase() === String(value).toLowerCase()) || opts.find((o) => text(o).toLowerCase().includes(String(value).toLowerCase()));
        if (!hit) throw new Error('option not found: ' + value);
        setNativeValue(el, hit.value); fire(el, 'input', { cancelable: false }); fire(el, 'change', { cancelable: false });
        break;
      }
      case 'check': {
        if (typeof value === 'boolean' || value === 'true' || value === 'false') { if (!!el.checked !== (value === true || value === 'true')) el.click(); }
        else el.click();
        break;
      }
      default: // click | link | submit
        el.click();
    }
    return action.kind === 'link' && /#/.test(action.href || '');
  }

  /**
   * Execute one action by key against the current page, settle, re-snapshot.
   * @returns {Promise<{action,params,outcome,error?,messagesAfter,page}>}
   */
  async function act(key, params, meta) {
    const snap = api.lastSnapshot || map();
    const action = snap.actions.find((a) => a.key === key);
    const rec = Object.assign({ action: key, params: params || {} }, meta || {});
    let waitHash = false;
    try {
      if (!action) throw new Error('unknown action: ' + key);
      waitHash = performStep(action, params);
      rec.outcome = 'ok';
    } catch (e) { rec.outcome = 'error'; rec.error = String(e && e.message || e); }
    await settle(waitHash);
    const page = map();
    rec.messagesAfter = page.messages;
    rec.page = page;
    return rec;
  }

  /* ------------------------------------------------------------------ */
  /* The decide / visit loop                                              */
  /* ------------------------------------------------------------------ */
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
    return r.json();
  }
  const emit = (detail) => { try { window.dispatchEvent(new CustomEvent('doorman:step', { detail })); } catch {} };

  /**
   * Run a goal: ask /api/decide for each step, execute it, report to /api/visit.
   * Never throws — resolves { ok:false, error } on transport failure.
   */
  async function doGoal(goal, opts) {
    const o = Object.assign({ autoConfirm: false, maxSteps: 10, onStep: null, apiBase: defaultApiBase }, opts || {});
    const base = String(o.apiBase).replace(/\/$/, '');
    const t0 = Date.now();
    const history = [];
    const tierCounts = {};
    let visitId = o.visitId || null, done = false, impossible = false, needsConfirmation = false, failureReason = null;
    try {
      let page = map();
      for (let i = 0; i < o.maxSteps; i++) {
        const res = await post(base + '/api/decide', { siteId, goal, page, history, visitId });
        visitId = res.visitId || visitId;
        const step = res.step || {};
        if (step.tier) tierCounts[step.tier] = (tierCounts[step.tier] || 0) + 1;
        if (step.done) { done = true; emit({ index: i, step, page }); break; }
        if (step.impossible) { impossible = true; emit({ index: i, step, page }); break; }
        if (step.needsConfirmation) {
          const rec = { action: step.action || null, params: step.params || {}, tier: step.tier, confidence: step.confidence, outcome: 'ok', messagesAfter: page.messages, needsConfirmation: true };
          if (!o.autoConfirm) { needsConfirmation = true; history.push(rec); emit({ index: i, step, page, record: rec }); break; }
          rec.confirmed = true; history.push(rec);
          emit({ index: i, step, page, record: rec, confirmed: true });
          continue; // the next decide returns the confirmed action to execute
        }
        if (!step.action) { failureReason = 'other'; break; }
        const rec = await act(step.action, step.params, { tier: step.tier, confidence: step.confidence });
        page = rec.page; delete rec.page;
        history.push(rec);
        const detail = { index: i, step, record: rec, page };
        emit(detail);
        if (typeof o.onStep === 'function') { try { await o.onStep(detail); } catch {} }
      }
      const finalPage = page;
      let visit = null;
      try {
        const v = await post(base + '/api/visit', { visitId, siteId, goal, history, finalPage, agentReported: { done, impossible } });
        visit = v && v.visit || null;
      } catch (e) { failureReason = failureReason || 'visit_unreported'; }
      if (visit && visit.failureReason) failureReason = visit.failureReason;
      return { ok: true, done, impossible, needsConfirmation, steps: history, ms: Date.now() - t0, tierCounts, visitId, failureReason, visit };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), done, impossible, needsConfirmation, steps: history, ms: Date.now() - t0, tierCounts, visitId, failureReason };
    }
  }

  /* ------------------------------------------------------------------ */
  /* WebMCP-style tools                                                   */
  /* ------------------------------------------------------------------ */
  function tools() {
    const snap = map();
    const list = snap.actions.map((a) => {
      const props = {};
      if (a.kind === 'type') props.text = { type: 'string', description: 'Text to enter' };
      if (a.kind === 'select') props.value = { type: 'string', enum: (a.options || []).map((x) => x.value), description: 'Option value' };
      if (a.kind === 'check') props.value = { type: 'boolean', description: 'Desired checked state' };
      return {
        name: a.key,
        description: a.kind + ' "' + a.name + '"' + (a.kind === 'select' ? ' — options: ' + (a.options || []).map((x) => x.label).join(', ') : ''),
        inputSchema: { type: 'object', properties: props, required: Object.keys(props) },
        execute: (input) => act(a.key, input || {}, { tier: 'T0_tool' }).then((r) => ({ outcome: r.outcome, error: r.error, messages: r.messagesAfter })),
      };
    });
    list.push({
      name: 'doorman_do',
      description: 'Ask the site to carry out a natural-language goal on your behalf.',
      inputSchema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
      execute: (input) => doGoal(input && input.goal || '', { autoConfirm: false }),
    });
    return list;
  }

  let toolsAbort = null;
  function registerTools() {
    try {
      const mc = document.modelContext;
      if (!mc || typeof mc.registerTool !== 'function') return;
      if (toolsAbort) toolsAbort.abort();
      toolsAbort = typeof AbortController === 'function' ? new AbortController() : null;
      for (const t of tools()) {
        try { mc.registerTool(Object.assign({}, t, toolsAbort ? { signal: toolsAbort.signal } : {})); } catch {}
      }
    } catch {}
  }

  /* ------------------------------------------------------------------ */
  /* Expose                                                               */
  /* ------------------------------------------------------------------ */
  const api = { version: VERSION, siteId, map, do: doGoal, tools, act, lastSnapshot: null };
  window.doorman = api;

  const boot = () => { try { map(); registerTools(); } catch {} };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('hashchange', () => settle(false).then(registerTools));
})();
