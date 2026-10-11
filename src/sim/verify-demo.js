// Exercises the shop with Playwright and proves the 4 planted flaws + the verifier. Run: npm run verify:demo (server must be up)
require('dotenv').config();
const { chromium } = require('playwright');
const { verify } = require('./verify');
const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const state = () => p.evaluate(() => window.shopState());
  const go = async (h) => { await p.goto(`${BASE}/shop/${h}`); await p.waitForTimeout(150); };
  const results = [];
  const check = (name, r, expectSuccess) => { const pass = r.success === expectSuccess; results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} -> ${JSON.stringify(r)}`); };

  await go('#/'); await p.evaluate(() => window.shopReset());
  // happy path: Road Racer 9 → cart
  await go('#/product/road-racer'); await p.selectOption('#size', '9'); await p.click('#add');
  check('add Road Racer 9', verify({ kind: 'add_to_cart', productId: 'road-racer', size: 9 }, await state()), true);
  // flaw A: Trail Runner 10 out of stock
  await go('#/product/trail-runner'); await p.selectOption('#size', '10'); await p.click('#add');
  check('flaw A oos (agent silent)', verify({ kind: 'add_to_cart', productId: 'trail-runner', size: 10, flaw: 'A' }, await state(), false), false);
  check('flaw A oos (agent reports impossible)', verify({ kind: 'add_to_cart', productId: 'trail-runner', size: 10, flaw: 'A' }, await state(), true), true);
  // flaw B: ZIP starting with 9
  await go('#/checkout'); await p.fill('#name', 'Sam Trail'); await p.fill('#address', '1 Ferry Bldg'); await p.fill('#zip', '94111'); await p.click('#place-order');
  check('flaw B zip 94111 rejected', verify({ kind: 'place_order', productId: 'road-racer', flaw: 'B' }, await state(), false), false);
  await p.fill('#zip', '10001'); await p.click('#place-order');
  check('order with zip 10001', verify({ kind: 'place_order', productId: 'road-racer' }, await state()), true);
  // flaw C: orders need login; sign-in only in footer
  await go('#/orders');
  check('flaw C orders blocked', verify({ kind: 'view_order', orderId: '1042', flaw: 'C' }, await state()), false);
  await p.click('a.tiny'); await p.fill('#email', 'sam@example.com'); await p.click('#li button'); await go('#/order/1042');
  check('flaw C solved via footer sign-in', verify({ kind: 'view_order', orderId: '1042', flaw: 'C' }, await state()), true);
  // flaw D: no kids sizes
  await go('#/?q=kids');
  check('flaw D kids not found (reported)', verify({ kind: 'impossible', flaw: 'D' }, await state(), true), true);
  console.log(results.every(Boolean) ? `\nALL ${results.length} CHECKS PASS` : `\n${results.filter((x) => !x).length} FAILED`);
  await b.close(); process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('verify-demo error:', e.message); process.exit(1); });
