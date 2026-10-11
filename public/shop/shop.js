// Trailhead Outfitters — mock shop for the Doorman benchmark.
// Four planted flaws (the benchmark's answer key):
//  A OUT_OF_STOCK     Trail Runner size 10 is always out of stock
//  B VALIDATION_ERROR checkout rejects ZIP codes starting with 9 ("Invalid ZIP code")
//  C LOGIN_REQUIRED   order tracking needs sign-in; the only sign-in link is buried in the footer
//  D NOT_FOUND        no kids' sizes, no vegan / leather-free line
(function () {
  const PRODUCTS = [
    { id: 'trail-runner', name: 'Trail Runner', category: 'shoes', price: 95, sizes: [7,8,9,10,11,12], oos: [10], desc: 'Grippy trail running shoe with a rock plate.' },
    { id: 'road-racer', name: 'Road Racer', category: 'shoes', price: 72, sizes: [7,8,9,10,11,12], oos: [], desc: 'Light road running shoe for daily miles.' },
    { id: 'featherlight', name: 'Featherlight Racer', category: 'shoes', price: 118, sizes: [7,8,9,10,11], oos: [], desc: 'Carbon-plated race-day running shoe.' },
    { id: 'summit-hiker', name: 'Summit Hiker', category: 'boots', price: 140, sizes: [8,9,10,11,12], oos: [], desc: 'Waterproof leather hiking boot.' },
    { id: 'rain-boot', name: 'Rain Boot', category: 'boots', price: 60, sizes: [7,8,9,10,11], oos: [], desc: 'Rubber boot for wet trails and puddles.' },
    { id: 'canvas-sneaker', name: 'Canvas Sneaker', category: 'shoes', price: 45, sizes: [6,7,8,9,10,11], oos: [], desc: 'Everyday canvas sneaker, leather trim.' },
    { id: 'leather-loafer', name: 'Leather Loafer', category: 'shoes', price: 85, sizes: [8,9,10,11], oos: [], desc: 'Full-grain leather loafer.' },
    { id: 'camp-sandal', name: 'Camp Sandal', category: 'shoes', price: 55, sizes: [7,8,9,10,11,12], oos: [], desc: 'Strappy sandal for camp and rivers.' },
    { id: 'rain-shell', name: 'Rain Shell Jacket', category: 'apparel', price: 129, sizes: ['S','M','L','XL'], oos: [], desc: 'Packable 2.5-layer waterproof shell.' },
    { id: 'trail-shorts', name: 'Trail Shorts', category: 'apparel', price: 38, sizes: ['S','M','L','XL'], oos: [], desc: 'Quick-dry shorts with zip pocket.' },
    { id: 'wool-socks', name: 'Wool Hiking Socks', category: 'accessories', price: 18, sizes: ['S','M','L'], oos: [], desc: 'Merino blend, cushioned.' },
    { id: 'bottle', name: 'Insulated Bottle', category: 'accessories', price: 28, sizes: null, oos: [], desc: '750 ml, keeps cold 24 h.' },
  ];
  const SEED_ORDERS = [{ id: '1042', items: [{ id: 'road-racer', name: 'Road Racer', size: 9, qty: 1, price: 72 }], status: 'Shipped — arriving Oct 14', total: 72 }];

  // ---------- state (localStorage, exposed for the verifier) ----------
  const KEY = 'trailhead_state_v1';
  const fresh = () => ({ cart: [], orders: SEED_ORDERS.slice(), loggedIn: false, viewedOrders: [], lastError: null, events: [] });
  let S; try { S = JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch { S = fresh(); }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };
  const log = (type, data) => { S.events.push({ t: Date.now(), type, ...data }); if (S.events.length > 200) S.events.shift(); save(); };
  const setError = (code, message) => { S.lastError = code ? { code, message, at: location.hash } : null; save(); };
  window.shopState = () => JSON.parse(JSON.stringify(S));
  window.shopReset = () => { S = fresh(); save(); location.hash = '#/'; render(); };
  window.shopProducts = PRODUCTS;

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');
  const money = (n) => `$${n.toFixed(2)}`;
  const byId = (id) => PRODUCTS.find((p) => p.id === id);
  const updateCartCount = () => { $('#cart-count').textContent = S.cart.reduce((a, i) => a + i.qty, 0); };

  // ---------- decorative product art (inline SVG, offline; no text nodes so it never leaks into the page map) ----------
  const ART_COLORS = {
    'trail-runner': ['#3b6d4a', '#e2b250', '#1f2a24'], 'road-racer': ['#2f5f9e', '#eef2f6', '#1c2430'], 'featherlight': ['#e8622c', '#fff4ea', '#1c2430'],
    'canvas-sneaker': ['#e6dfcc', '#6b5e45', '#3b3630'], 'leather-loafer': ['#6b3f24', '#3a2214', '#2a1a10'], 'camp-sandal': ['#2f6b3a', '#1f3d27', '#3a3a3a'],
    'summit-hiker': ['#7a4a2a', '#c9892c', '#2a1f18'], 'rain-boot': ['#d8a23c', '#b57f1f', '#2a2a2a'],
    'rain-shell': ['#2e6b8a', '#1d4a60', ''], 'trail-shorts': ['#4b5a4b', '#2d382d', ''], 'wool-socks': ['#8a7a66', '#4b4036', ''], 'bottle': ['#2f6b3a', '#1f3d27', ''],
  };
  const ART_SHAPES = {
    shoe: (a, b, s) => `<path d="M14 104C30 84 58 80 82 62 96 52 108 36 128 40c18 4 28 22 44 32 12 7 18 16 14 28Z" fill="${a}"/><path d="M14 104l172-4c2 10-4 16-16 16H24c-10 0-14-6-10-12z" fill="${s}"/><path d="M18 103l166-4" stroke="#fff" stroke-width="4" opacity=".65" stroke-linecap="round"/><path d="M60 86c20-14 36-22 58-38" stroke="${b}" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M96 60l10 8M106 54l10 8M116 48l10 8" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".8"/>`,
    loafer: (a, b, s) => `<path d="M16 100c12-14 34-16 60-26 20-8 36-22 56-20 20 2 32 16 44 26 10 8 14 16 10 24Z" fill="${a}"/><path d="M14 104l172-4c2 10-4 16-16 16H24c-10 0-14-6-10-12z" fill="${s}"/><path d="M18 103l166-4" stroke="#fff" stroke-width="4" opacity=".65" stroke-linecap="round"/><path d="M98 64c14-6 30-6 44 6" stroke="${b}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
    sandal: (a, b, s) => `<path d="M20 100c4-16 40-22 80-24 40-2 76 4 84 20l2 12c0 8-8 10-26 10H30c-12 0-16-8-10-18z" fill="${s}"/><path d="M60 96c20-28 60-28 80 0" stroke="${a}" stroke-width="9" fill="none" stroke-linecap="round"/><path d="M110 92c10-16 40-22 60 0" stroke="${b}" stroke-width="7" fill="none" stroke-linecap="round"/>`,
    boot: (a, b, s) => `<path d="M62 22h52v58c18 4 34 12 56 24 10 6 10 18-2 20H62Z" fill="${a}"/><path d="M54 118h122c6 0 8 10 0 12H54c-8 0-8-12 0-12z" fill="${s}"/><path d="M70 32h36M70 44h36M70 56h36" stroke="${b}" stroke-width="3" stroke-linecap="round"/><path d="M114 80c18 4 34 12 56 24" stroke="${b}" stroke-width="3" fill="none"/>`,
    jacket: (a, b) => `<path d="M100 18c-14 0-24 9-28 20L48 50 30 96l26 9 6-18v45h76v-45l6 18 26-9-18-46-24-12c-4-11-14-20-28-20z" fill="${a}"/><path d="M100 40v92" stroke="${b}" stroke-width="4"/><path d="M86 38c6 10 22 10 28 0" stroke="${b}" stroke-width="4" fill="none"/><circle cx="100" cy="26" r="10" fill="${b}"/>`,
    shorts: (a, b) => `<path d="M52 36h96l8 86h-42l-14-52-14 52H44z" fill="${a}"/><path d="M52 36h96v12H52z" fill="${b}"/><path d="M118 60l6 24" stroke="${b}" stroke-width="3"/>`,
    sock: (a, b) => `<path d="M78 24h42v58c0 10 6 16 16 22 14 8 20 22 10 32-10 8-26 4-40-4L78 112Z" fill="${a}"/><path d="M78 24h42v16H78z" fill="${b}"/><path d="M82 52h34M82 64h34" stroke="${b}" stroke-width="3" stroke-linecap="round"/>`,
    bottle: (a, b) => `<rect x="76" y="40" width="48" height="96" rx="14" fill="${a}"/><rect x="84" y="22" width="32" height="22" rx="6" fill="${b}"/><rect x="76" y="70" width="48" height="30" fill="${b}" opacity=".5"/><path d="M86 50v70" stroke="#fff" stroke-width="4" opacity=".4" stroke-linecap="round"/>`,
  };
  const ART_SHAPE = { 'leather-loafer': 'loafer', 'camp-sandal': 'sandal', 'summit-hiker': 'boot', 'rain-boot': 'boot', 'rain-shell': 'jacket', 'trail-shorts': 'shorts', 'wool-socks': 'sock', 'bottle': 'bottle' };
  const art = (p) => {
    const [a, b, s] = ART_COLORS[p.id] || ['#2f6b3a', '#1f3d27', '#222'];
    return `<svg viewBox="0 0 200 150" aria-hidden="true" focusable="false">${ART_SHAPES[ART_SHAPE[p.id] || 'shoe'](a, b, s)}</svg>`;
  };
  const HERO_ART = `<svg viewBox="0 0 520 200" aria-hidden="true" focusable="false"><circle cx="430" cy="52" r="24" fill="rgba(241,201,122,.55)"/><path d="M0 200 90 90l50 50 70-100 80 90 60-50 80 70 90-90v140Z" fill="rgba(255,255,255,.08)"/><path d="M0 200l70-50 60 20 70-60 80 60 80-40 80 50 80-60v80Z" fill="rgba(255,255,255,.13)"/><path d="M196 54l14-14 14 14-7 2-7-7-7 7z" fill="rgba(255,255,255,.5)"/></svg>`;

  // ---------- views ----------
  function listing(params) {
    const q = (params.get('q') || '').toLowerCase().trim();
    const cat = params.get('category') || '';
    const max = Number(params.get('max') || 0);
    const sort = params.get('sort') || '';
    let items = PRODUCTS.filter((p) => (!q || (p.name + ' ' + p.desc + ' ' + p.category).toLowerCase().includes(q))
      && (!cat || p.category === cat) && (!max || p.price <= max));
    if (sort === 'price-asc') items.sort((a, b) => a.price - b.price);
    if (sort === 'price-desc') items.sort((a, b) => b.price - a.price);
    if (q) log('search', { q, results: items.length });
    if (q && !items.length) setError('NOT_FOUND', `No products match "${q}"`);
    app.innerHTML = `
      <section class="hero">
        <p class="eyebrow">${q ? 'Search results' : 'Fall 2026 collection'}</p>
        <h1>${q ? `Results for "${q}"` : 'All gear'}</h1>
        <p class="lede">${q ? 'Everything in the store that matches your search.' : 'Running shoes, hiking boots, rain shells and the small things that make a long day outside feel short.'}</p>
        <p class="perks"><span>Free returns within 30 days</span><span>Ships in 1–2 business days</span><span>Fit clinic every Saturday</span></p>
        ${HERO_ART}
      </section>
      <div class="toolbar">
      <div class="filters">
        <label>Category <select id="f-category" aria-label="Category">
          ${['', 'shoes', 'boots', 'apparel', 'accessories'].map((c) => `<option value="${c}" ${c === cat ? 'selected' : ''}>${c || 'All'}</option>`).join('')}
        </select></label>
        <label>Max price <select id="f-max" aria-label="Max price">
          ${[0, 50, 80, 100, 150].map((m) => `<option value="${m}" ${m === max ? 'selected' : ''}>${m ? 'Under $' + m : 'Any'}</option>`).join('')}
        </select></label>
        <label>Sort <select id="f-sort" aria-label="Sort">
          <option value="">Featured</option><option value="price-asc" ${sort === 'price-asc' ? 'selected' : ''}>Price: low to high</option>
          <option value="price-desc" ${sort === 'price-desc' ? 'selected' : ''}>Price: high to low</option>
        </select></label>
      </div>
      <p class="count">${items.length} of ${PRODUCTS.length} products</p>
      </div>
      ${items.length ? '' : `<p class="error" role="alert">No products match your search.</p>`}
      <div class="grid">${items.map((p) => `
        <article class="card" data-product="${p.id}">
          <div class="art ${p.category}">${art(p)}</div>
          <h2>${p.name}</h2>
          <span class="price">${money(p.price)}</span>
          <span class="badge">${p.category}${p.oos.length ? ' · some sizes out of stock' : ''}</span>
          <a class="btn" href="#/product/${p.id}" aria-label="View ${p.name}">View</a>
        </article>`).join('')}</div>`;
    const go = () => {
      const np = new URLSearchParams();
      if (q) np.set('q', q);
      if ($('#f-category').value) np.set('category', $('#f-category').value);
      if ($('#f-max').value !== '0') np.set('max', $('#f-max').value);
      if ($('#f-sort').value) np.set('sort', $('#f-sort').value);
      location.hash = '#/?' + np.toString();
    };
    ['#f-category', '#f-max', '#f-sort'].forEach((s) => $(s).addEventListener('change', go));
  }

  function product(id) {
    const p = byId(id);
    if (!p) { setError('NOT_FOUND', 'Product not found'); app.innerHTML = `<p class="error" role="alert">Product not found.</p>`; return; }
    log('view_product', { id });
    app.innerHTML = `
      <a href="#/" class="back">← Back to all gear</a>
      <div class="pdp">
        <div class="pdp-art art ${p.category}">${art(p)}</div>
        <div class="pdp-info">
          <span class="badge">${p.category}</span>
          <h1>${p.name}</h1><p class="price">${money(p.price)}</p><p class="desc">${p.desc}</p>
          <div class="buy">
          ${p.sizes ? `<label>Size <select id="size" aria-label="Size"><option value="">Choose a size</option>
            ${p.sizes.map((s) => `<option value="${s}">${s}${p.oos.includes(s) ? ' — out of stock' : ''}</option>`).join('')}</select></label>` : ''}
          <label>Quantity <input id="qty" type="number" min="1" max="5" value="1" aria-label="Quantity"></label>
          </div>
          <div id="pmsg"></div>
          <button id="add" type="button">Add to cart</button>
          <p class="notes">Free returns within 30 days · Ships in 1–2 business days from Bend, Oregon</p>
        </div>
      </div>`;
    $('#add').addEventListener('click', () => {
      const msg = $('#pmsg');
      const size = p.sizes ? $('#size').value : null;
      const qty = Math.max(1, Math.min(5, Number($('#qty').value) || 1));
      if (p.sizes && !size) { setError('SIZE_REQUIRED', 'Please choose a size'); msg.innerHTML = `<p class="error" role="alert">Please choose a size.</p>`; return; }
      const sz = p.sizes && typeof p.sizes[0] === 'number' ? Number(size) : size;
      if (p.oos.includes(sz)) { // FLAW A
        setError('OUT_OF_STOCK', `${p.name} size ${sz} is out of stock`); log('oos', { id, size: sz });
        msg.innerHTML = `<p class="error oos" role="alert">Sorry, size ${sz} is out of stock.</p>`; return;
      }
      const existing = S.cart.find((i) => i.id === id && i.size === sz);
      if (existing) existing.qty += qty; else S.cart.push({ id, name: p.name, size: sz, qty, price: p.price });
      setError(null); log('add_to_cart', { id, size: sz, qty }); updateCartCount();
      msg.innerHTML = `<p class="ok" role="status">Added to cart.</p>`;
    });
  }

  function cart() {
    const total = S.cart.reduce((a, i) => a + i.price * i.qty, 0);
    app.innerHTML = `<h1>Your cart</h1>
      ${S.cart.length ? `<div class="two-col"><div class="table-wrap"><table><tr><th>Item</th><th>Size</th><th>Qty</th><th>Price</th><th></th></tr>
        ${S.cart.map((i, n) => `<tr><td><strong>${i.name}</strong></td><td>${i.size ?? '—'}</td><td>${i.qty}</td><td><span class="price">${money(i.price * i.qty)}</span></td>
          <td><button class="secondary" data-remove="${n}" aria-label="Remove ${i.name}">Remove</button></td></tr>`).join('')}</table></div>
        <div class="panel summary"><h2>Order summary</h2><p class="line"><span>Subtotal</span><span>${money(total)}</span></p><p class="line"><span>Shipping</span><span>Free</span></p>
        <p class="price total"><span>Total</span><span>${money(total)}</span></p><a class="btn" href="#/checkout">Checkout</a></div></div>` : '<div class="panel empty"><p>Your cart is empty.</p></div>'}`;
    app.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
      const [r] = S.cart.splice(Number(b.dataset.remove), 1); log('remove_from_cart', { id: r.id }); save(); updateCartCount(); cart();
    }));
  }

  function checkout() {
    if (!S.cart.length) { app.innerHTML = `<div class="panel empty"><p>Your cart is empty. <a href="#/">Keep shopping</a></p></div>`; return; }
    const total = S.cart.reduce((a, i) => a + i.price * i.qty, 0);
    app.innerHTML = `<h1>Checkout</h1>
      <div class="two-col">
      <form id="co" class="panel">
        <h2>Shipping details</h2>
        <label>Full name <input id="name" required aria-label="Full name"></label>
        <label>Street address <input id="address" required aria-label="Street address"></label>
        <label>ZIP code <input id="zip" required inputmode="numeric" aria-label="ZIP code"></label>
        <div id="comsg"></div>
        <div class="actions"><button type="submit" id="place-order">Place order</button></div>
        <p class="hint">Pay on delivery · Free shipping · Free returns within 30 days</p>
      </form>
      <div class="panel summary"><h2>Order summary</h2>
        ${S.cart.map((i) => `<p class="line"><span>${i.name}${i.size ? ' · size ' + i.size : ''} × ${i.qty}</span><span>${money(i.price * i.qty)}</span></p>`).join('')}
        <p class="total"><span>Total</span><span>${money(total)}</span></p></div>
      </div>`;
    $('#co').addEventListener('submit', (e) => {
      e.preventDefault();
      const zip = $('#zip').value.trim(); const msg = $('#comsg');
      if (!$('#name').value.trim() || !$('#address').value.trim()) { setError('VALIDATION_ERROR', 'Name and address required'); msg.innerHTML = `<p class="error" role="alert">Name and address are required.</p>`; return; }
      if (!/^\d{5}$/.test(zip) || zip.startsWith('9')) { // FLAW B: rejects valid West-coast ZIPs
        setError('VALIDATION_ERROR', `Invalid ZIP code ${zip}`); log('checkout_error', { zip });
        msg.innerHTML = `<p class="error" role="alert">Invalid ZIP code.</p>`; return;
      }
      const id = String(1043 + S.orders.length - 1);
      S.orders.push({ id, items: S.cart.slice(), status: 'Processing', total, zip });
      log('order_placed', { id, total }); S.cart = []; setError(null); updateCartCount();
      app.innerHTML = `<div class="thanks"><h1>Thank you!</h1><p class="ok" role="status">Order #${id} placed.</p><p class="hint">We will email you when it ships. Free returns within 30 days.</p></div>`;
    });
  }

  function orders() {
    if (!S.loggedIn) { // FLAW C: no link here; sign-in is only in the footer
      setError('LOGIN_REQUIRED', 'Sign in to see your orders'); log('orders_blocked', {});
      app.innerHTML = `<h1>Your orders</h1><div class="panel"><p class="error" role="alert">Please sign in to view your orders.</p></div>`; return;
    }
    app.innerHTML = `<h1>Your orders</h1><div class="table-wrap"><table><tr><th>Order</th><th>Status</th><th>Total</th></tr>
      ${S.orders.map((o) => `<tr><td><a href="#/order/${o.id}">#${o.id}</a></td><td><span class="status">${o.status}</span></td><td><span class="price">${money(o.total)}</span></td></tr>`).join('')}</table></div>`;
  }

  function order(id) {
    if (!S.loggedIn) return orders();
    const o = S.orders.find((x) => x.id === id);
    if (!o) { setError('NOT_FOUND', `Order ${id} not found`); app.innerHTML = `<p class="error" role="alert">Order not found.</p>`; return; }
    if (!S.viewedOrders.includes(id)) S.viewedOrders.push(id); setError(null); log('view_order', { id });
    app.innerHTML = `<h1>Order #${o.id}</h1><p>Status: <strong>${o.status}</strong></p>
      <div class="panel"><h2>Items</h2><ul class="order-items">${o.items.map((i) => `<li>${i.name} ${i.size ? '(size ' + i.size + ')' : ''} × ${i.qty}</li>`).join('')}</ul>
      <p class="total"><span>Total</span><span>${money(o.total)}</span></p></div>`;
  }

  function login() {
    app.innerHTML = `<div class="login-wrap"><h1>Member sign-in</h1><form id="li" class="panel">
      <label>Email <input id="email" type="email" required aria-label="Email"></label>
      <div class="actions"><button type="submit">Sign in</button></div>
      <p class="hint">Members can track orders and start returns.</p></form></div>`;
    $('#li').addEventListener('submit', (e) => {
      e.preventDefault(); if (!$('#email').value.includes('@')) return;
      S.loggedIn = true; setError(null); log('login', {}); location.hash = '#/orders';
    });
  }

  function help() {
    app.innerHTML = `<h1>Help</h1><div class="panel help"><p>Track an order under <a href="#/orders">Your orders</a>. Returns are free within 30 days.</p>
      <p>We carry adult sizes only. Our boots and loafers use leather.</p></div>`;
  }

  // ---------- router ----------
  function render() {
    const [path, qs] = (location.hash.slice(1) || '/').split('?');
    const params = new URLSearchParams(qs || '');
    const parts = path.split('/').filter(Boolean);
    updateCartCount();
    if (!parts.length) return listing(params);
    if (parts[0] === 'product') return product(parts[1]);
    if (parts[0] === 'cart') return cart();
    if (parts[0] === 'checkout') return checkout();
    if (parts[0] === 'orders') return orders();
    if (parts[0] === 'order') return order(parts[1]);
    if (parts[0] === 'login') return login();
    if (parts[0] === 'help') return help();
    listing(params);
  }
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#search').value.trim(); location.hash = '#/?' + new URLSearchParams(q ? { q } : {}).toString(); });
  // header links for orders/help (orders is visible; sign-in is NOT)
  const nav = document.createElement('nav'); nav.innerHTML = `<a href="#/orders">Your orders</a> · <a href="#/help">Help</a>`;
  document.querySelector('.top').appendChild(nav);
  window.addEventListener('hashchange', render);
  render();
})();
