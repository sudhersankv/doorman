'use strict';
/**
 * Numeric constraints and free-text candidates extracted from a goal. Generic: only units, never field names.
 *   parse(goal)                  -> [{ unit, op, value }]   unit ∈ '$' | '€' | '£' | '★' | 'time' | 'mi' | 'km' | 'kg' | 'lb' | '%' | 'min' | 'h' | '#'
 *   filterItems(items, cons)     -> items whose attrs satisfy every constraint (missing attr -> keep)
 *   candidatePhrases(goal)       -> 3..5 short noun-ish phrases for a `type` field
 */

const LE_WORDS = '(?:under|below|less than|at most|max(?:imum)?|no more than|up to|not more than|cheaper than|within)';
const GE_WORDS = '(?:over|above|more than|at least|min(?:imum)?|no less than|not less than|greater than)';
const CUR = '[$€£]';
const NUM = '\\d+(?:[.,]\\d+)?';
const UNIT_WORDS = '(?:stars?|★|mi(?:les?)?|km|kilomet(?:er|re)s?|kg|lbs?|%|percent|min(?:ute)?s?|h(?:ours?|rs?)?)';
const UNIT_MAP = { star: '★', stars: '★', '★': '★', mi: 'mi', mile: 'mi', miles: 'mi', km: 'km', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km', kg: 'kg', lb: 'lb', lbs: 'lb', '%': '%', percent: '%', min: 'min', mins: 'min', minute: 'min', minutes: 'min', h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h' };
const TIME = `(\\d{1,2}:\\d{2}|${NUM})\\s*(am|pm|a\\.m\\.|p\\.m\\.)?`;

const toNum = (s) => Number(String(s).replace(',', '.'));
const normUnit = (u) => (u ? UNIT_MAP[u.toLowerCase()] || null : null);

/** Parse "10:30pm" | "10am" | "14" -> decimal hours, or null. */
function toHours(numStr, ampm) {
  let h, m = 0;
  if (numStr.includes(':')) { const [a, b] = numStr.split(':'); h = Number(a); m = Number(b); } else h = toNum(numStr);
  if (!Number.isFinite(h) || h > 24) return null;
  const ap = (ampm || '').replace(/\./g, '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h + m / 60;
}

/** Like parse() but each constraint carries the matched `span` text (used to strip phrases). */
function parseWithSpans(goal) {
  const text = String(goal || '').toLowerCase();
  const out = [];
  const push = (c) => { if (Number.isFinite(c.value) && !out.some((o) => o.unit === c.unit && o.op === c.op && o.value === c.value)) out.push(c); };

  // time: before 10am / before 10:30 / after 2pm / by 5pm / until 6pm
  const timeRe = new RegExp(`\\b(before|by|until|no later than|after|from|starting(?: at)?|not before)\\s+${TIME}\\b`, 'g');
  for (const m of text.matchAll(timeRe)) {
    const num = m[2];
    if (!m[3] && !num.includes(':') && toNum(num) > 24) continue;
    const v = toHours(num, m[3]); if (v == null) continue;
    push({ unit: 'time', op: /^(after|from|starting|not before)/.test(m[1]) ? '>=' : '<=', value: v, span: m[0] });
  }

  // "<cmp words> $80" | "<cmp words> 4 stars" | "<cmp words> 80 dollars" | "<cmp words> 80"
  const cmpRe = new RegExp(`\\b(${LE_WORDS}|${GE_WORDS})\\s+(${CUR})?\\s*(${NUM})\\s*(${UNIT_WORDS})?(?:\\s*(dollars?|euros?|pounds?|bucks))?(?![a-z0-9])`, 'g');
  for (const m of text.matchAll(cmpRe)) {
    const word = m[1];
    const op = new RegExp(`^${GE_WORDS}$`).test(word) ? '>=' : '<=';
    let unit = m[2] || normUnit(m[4]);
    if (!unit && m[5]) unit = /^doll|^buck/.test(m[5]) ? '$' : /^euro/.test(m[5]) ? '€' : '£';
    if (!unit) unit = '#';
    if (unit === 'time') continue;
    push({ unit, op, value: toNum(m[3]), span: m[0] });
  }

  // "$80 max" / "4 stars minimum" / "4+ stars" / "4-star or better"
  for (const m of text.matchAll(new RegExp(`(${CUR})?(${NUM})\\s*(\\+)?\\s*-?\\s*(${UNIT_WORDS})?\\s*(max(?:imum)?|or less|or under|or below|tops|min(?:imum)?|or more|or better|or higher|and up|\\+)(?![a-z0-9])`, 'g'))) {
    if (m[1] == null && m[4] == null && !m[3]) continue;
    const unit = m[1] || normUnit(m[4]) || '#';
    const op = /^(max|or less|or under|or below|tops)/.test(m[5]) ? '<=' : '>=';
    push({ unit, op, value: toNum(m[2]), span: m[0] });
  }
  for (const m of text.matchAll(new RegExp(`(${NUM})\\+\\s*(${UNIT_WORDS})`, 'g'))) push({ unit: normUnit(m[2]) || '#', op: '>=', value: toNum(m[1]), span: m[0] });

  return out;
}

/**
 * Extract numeric constraints from a goal sentence.
 * @param {string} goal
 * @returns {Array<{unit:string, op:'<='|'>=', value:number}>}
 */
function parse(goal) { return parseWithSpans(goal).map(({ unit, op, value }) => ({ unit, op, value })); }

const cmp = (v, op, target) => (op === '<=' ? v <= target : v >= target);

/**
 * Keep items whose numeric attrs satisfy all constraints. Missing attr -> keep. '#' matches any numeric attr (keep if any satisfies).
 * @param {Array<{attrs?:object}>} items
 * @param {Array<{unit:string, op:string, value:number}>} constraints
 */
function filterItems(items, constraints) {
  const list = Array.isArray(items) ? items : [];
  if (!constraints || !constraints.length) return list.slice();
  return list.filter((it) => {
    const attrs = (it && it.attrs) || {};
    return constraints.every((c) => {
      if (c.unit === '#') {
        const nums = Object.values(attrs).filter((v) => typeof v === 'number');
        return !nums.length || nums.some((v) => cmp(v, c.op, c.value));
      }
      const v = attrs[c.unit];
      return typeof v !== 'number' || cmp(v, c.op, c.value);
    });
  });
}

/** True when a page option label/value carries a number that satisfies the constraints (or carries none). */
function optionAllowed(label, constraints) {
  if (!constraints || !constraints.length) return true;
  const s = String(label || '');
  return constraints.every((c) => {
    const re = c.unit === '$' || c.unit === '€' || c.unit === '£' ? new RegExp(`\\${c.unit}\\s*(${NUM})`) : c.unit === '#' ? new RegExp(`(${NUM})`) : c.unit === 'time' ? null : new RegExp(`(${NUM})\\s*${c.unit === '★' ? '(?:★|stars?)' : c.unit}`);
    if (!re) return true;
    const m = s.match(re); if (!m) return true;
    return cmp(toNum(m[1]), c.op, c.value);
  });
}

const LEAD_VERBS = /^(?:(?:please|can you|could you|i(?:'d| would) like to|i want to|i need to|i want|i need|help me|let's|lets)\s+)*(?:buy|find|get|book|search for|search|show me|show|add|order|look for|look up|browse|purchase|reserve|schedule|open|go to|read|see|locate|pick|choose|select|grab|fetch)\s+/i;
const STOP = new Set('the a an to of in on for with and or my me i want need please get it this that is are be at by from into some any that\'s thats one ones something anything here there now today tomorrow nearby near with without'.split(' '));

/**
 * 3..5 short phrases a free-text field could be filled with. Never empty (fallback: the goal itself).
 * @param {string} goal
 * @returns {string[]}
 */
function candidatePhrases(goal) {
  const raw = String(goal || '').trim();
  let s = raw.toLowerCase();
  for (const c of parseWithSpans(s)) if (c.span) s = s.replace(c.span, ' ');
  s = s.replace(/[$€£]\s*\d+(?:[.,]\d+)?/g, ' ').replace(/\b\d+(?:[.,]\d+)?\s*(?:★|stars?|mi|km|kg|lbs?|%|am|pm)\b/g, ' ');
  s = s.replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(LEAD_VERBS, '');
  // cut at trailing clauses ("for ...", "that ...", "which ...", "with ...") only if something remains before them
  const cut = s.split(/\s+(?:that|which|who|so that|because)\s+/)[0];
  if (cut.trim()) s = cut;
  const words = s.split(' ').filter((w) => w && !STOP.has(w));
  const out = [];
  const add = (p) => { p = String(p || '').trim(); if (p && !out.includes(p)) out.push(p); };
  const full = words.join(' ');
  add(full);
  if (words.length >= 2) add(words.slice(-2).join(' '));
  // longest run of noun-ish words (not ending with -ly/-ing, length > 2)
  const nounish = (w) => w.length > 2 && !/ly$/.test(w) && !/^(very|really|quite|just|also|only|with|without|about)$/.test(w);
  let best = [], cur = [];
  for (const w of words) { if (nounish(w)) { cur.push(w); if (cur.length > best.length) best = cur.slice(); } else cur = []; }
  if (best.length) add(best.join(' '));
  if (words.length) {
    const last = words[words.length - 1];
    const head = words.slice(0, -1).join(' ');
    const alt = /s$/.test(last) && !/ss$/.test(last) ? last.replace(/ies$/, 'y').replace(/s$/, '') : /y$/.test(last) && !/[aeiou]y$/.test(last) ? last.replace(/y$/, 'ies') : last + 's';
    add((head ? head + ' ' : '') + alt);
    add(last);
  }
  if (out.length < 3 && s.trim()) add(s.trim());
  if (out.length < 3 && raw) add(raw);
  if (!out.length) add('search');
  return out.slice(0, 5);
}

module.exports = { parse, filterItems, candidatePhrases, optionAllowed, toHours };
