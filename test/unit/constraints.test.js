'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, filterItems, candidatePhrases } = require('../../src/harness/constraints');

test('parse: currency upper bounds', () => {
  assert.deepEqual(parse('find trail shoes under $80'), [{ unit: '$', op: '<=', value: 80 }]);
  assert.deepEqual(parse('rooms at most €120'), [{ unit: '€', op: '<=', value: 120 }]);
  assert.deepEqual(parse('no more than £15.50'), [{ unit: '£', op: '<=', value: 15.5 }]);
  assert.deepEqual(parse('max $30 please'), [{ unit: '$', op: '<=', value: 30 }]);
  assert.deepEqual(parse('up to $45'), [{ unit: '$', op: '<=', value: 45 }]);
  assert.deepEqual(parse('less than 50 dollars'), [{ unit: '$', op: '<=', value: 50 }]);
});

test('parse: rating lower bounds, stars and ★', () => {
  assert.deepEqual(parse('a clinic with at least 4 stars'), [{ unit: '★', op: '>=', value: 4 }]);
  assert.deepEqual(parse('over 4.5★'), [{ unit: '★', op: '>=', value: 4.5 }]);
  assert.deepEqual(parse('minimum 3 star rating'), [{ unit: '★', op: '>=', value: 3 }]);
  assert.deepEqual(parse('4+ stars'), [{ unit: '★', op: '>=', value: 4 }]);
});

test('parse: time, distance, bare numbers', () => {
  assert.deepEqual(parse('book a slot before 10am'), [{ unit: 'time', op: '<=', value: 10 }]);
  assert.deepEqual(parse('before 10:30'), [{ unit: 'time', op: '<=', value: 10.5 }]);
  assert.deepEqual(parse('after 2pm'), [{ unit: 'time', op: '>=', value: 14 }]);
  assert.deepEqual(parse('within 5 mi'), [{ unit: 'mi', op: '<=', value: 5 }]);
  assert.deepEqual(parse('within 12 km of here'), [{ unit: 'km', op: '<=', value: 12 }]);
  assert.deepEqual(parse('under 80'), [{ unit: '#', op: '<=', value: 80 }]);
  assert.deepEqual(parse('nothing numeric here'), []);
  assert.deepEqual(parse(''), []);
});

test('parse: several constraints in one goal', () => {
  const c = parse('find a dentist with at least 4 stars within 5 mi under $200');
  assert.deepEqual(c, [{ unit: '★', op: '>=', value: 4 }, { unit: 'mi', op: '<=', value: 5 }, { unit: '$', op: '<=', value: 200 }]);
});

test('filterItems keeps matching items and items lacking the attr', () => {
  const items = [
    { key: 'a', attrs: { $: 72 } },
    { key: 'b', attrs: { $: 95 } },
    { key: 'c', attrs: {} },
    { key: 'd', attrs: { '★': 4.5, $: 60 } },
    { key: 'e', attrs: { '★': 3, $: 50 } },
  ];
  assert.deepEqual(filterItems(items, parse('under $80')).map((i) => i.key), ['a', 'c', 'd', 'e']);
  assert.deepEqual(filterItems(items, parse('at least 4 stars under $80')).map((i) => i.key), ['a', 'c', 'd']);
  assert.deepEqual(filterItems(items, []).map((i) => i.key), ['a', 'b', 'c', 'd', 'e']);
  // '#' matches any numeric attr
  assert.deepEqual(filterItems(items, parse('under 55')).map((i) => i.key), ['c', 'd', 'e']);
  assert.deepEqual(filterItems(undefined, parse('under $5')), []);
});

test('candidatePhrases strips verbs, stop words and constraints; 3..5 phrases; never empty', () => {
  const p = candidatePhrases('please find me trail running shoes under $80');
  assert.ok(p.length >= 3 && p.length <= 5, JSON.stringify(p));
  assert.equal(p[0], 'trail running shoes');
  assert.ok(p.includes('running shoes'));
  assert.ok(p.every((x) => !/\$80|under|please|find/.test(x)));
  assert.equal(new Set(p).size, p.length);
  const q = candidatePhrases('book a clinic appointment before 10am');
  assert.equal(q[0], 'clinic appointment');
  assert.ok(q.includes('clinic appointments'));
  assert.deepEqual(candidatePhrases(''), ['search']);
  assert.ok(candidatePhrases('under 80').length >= 1);
});
