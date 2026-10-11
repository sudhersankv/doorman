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
      <h1>${q ? `Results for "${q}"` : 'All gear'}</h1>
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
      ${items.length ? '' : `<p class="error" role="alert">No products match your search.</p>`}
      <div class="grid">${items.map((p) => `
        <article class="card" data-product="${p.id}">
          <h2 style="margin:0;font-size:16px">${p.name}</h2>
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
      <a href="#/">← Back to all gear</a>
      <h1>${p.name}</h1><p class="price">${money(p.price)}</p><p>${p.desc}</p>
      ${p.sizes ? `<label>Size <select id="size" aria-label="Size"><option value="">Choose a size</option>
        ${p.sizes.map((s) => `<option value="${s}">${s}${p.oos.includes(s) ? ' — out of stock' : ''}</option>`).join('')}</select></label>` : ''}
      <label>Quantity <input id="qty" type="number" min="1" max="5" value="1" aria-label="Quantity"></label>
      <div id="pmsg"></div>
      <button id="add" type="button">Add to cart</button>`;
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
      ${S.cart.length ? `<table><tr><th>Item</th><th>Size</th><th>Qty</th><th>Price</th><th></th></tr>
        ${S.cart.map((i, n) => `<tr><td>${i.name}</td><td>${i.size ?? '—'}</td><td>${i.qty}</td><td>${money(i.price * i.qty)}</td>
          <td><button class="secondary" data-remove="${n}" aria-label="Remove ${i.name}">Remove</button></td></tr>`).join('')}</table>
        <p class="price">Total ${money(total)}</p><a class="btn" href="#/checkout">Checkout</a>` : '<p>Your cart is empty.</p>'}`;
    app.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
      const [r] = S.cart.splice(Number(b.dataset.remove), 1); log('remove_from_cart', { id: r.id }); save(); updateCartCount(); cart();
    }));
  }

  function checkout() {
    if (!S.cart.length) { app.innerHTML = `<p>Your cart is empty. <a href="#/">Keep shopping</a></p>`; return; }
    const total = S.cart.reduce((a, i) => a + i.price * i.qty, 0);
    app.innerHTML = `<h1>Checkout</h1><p>Total ${money(total)}</p>
      <form id="co">
        <label>Full name <input id="name" required aria-label="Full name"></label>
        <label>Street address <input id="address" required aria-label="Street address"></label>
        <label>ZIP code <input id="zip" required inputmode="numeric" aria-label="ZIP code"></label>
        <div id="comsg"></div>
        <button type="submit" id="place-order">Place order</button>
      </form>`;
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
      app.innerHTML = `<h1>Thank you!</h1><p class="ok" role="status">Order #${id} placed.</p>`;
    });
  }

  function orders() {
    if (!S.loggedIn) { // FLAW C: no link here; sign-in is only in the footer
      setError('LOGIN_REQUIRED', 'Sign in to see your orders'); log('orders_blocked', {});
      app.innerHTML = `<h1>Your orders</h1><p class="error" role="alert">Please sign in to view your orders.</p>`; return;
    }
    app.innerHTML = `<h1>Your orders</h1><table><tr><th>Order</th><th>Status</th><th>Total</th></tr>
      ${S.orders.map((o) => `<tr><td><a href="#/order/${o.id}">#${o.id}</a></td><td>${o.status}</td><td>${money(o.total)}</td></tr>`).join('')}</table>`;
  }

  function order(id) {
    if (!S.loggedIn) return orders();
    const o = S.orders.find((x) => x.id === id);
    if (!o) { setError('NOT_FOUND', `Order ${id} not found`); app.innerHTML = `<p class="error" role="alert">Order not found.</p>`; return; }
    if (!S.viewedOrders.includes(id)) S.viewedOrders.push(id); setError(null); log('view_order', { id });
    app.innerHTML = `<h1>Order #${o.id}</h1><p>Status: <strong>${o.status}</strong></p>
      <ul>${o.items.map((i) => `<li>${i.name} ${i.size ? '(size ' + i.size + ')' : ''} × ${i.qty}</li>`).join('')}</ul>`;
  }

  function login() {
    app.innerHTML = `<h1>Member sign-in</h1><form id="li">
      <label>Email <input id="email" type="email" required aria-label="Email"></label>
      <button type="submit">Sign in</button></form>`;
    $('#li').addEventListener('submit', (e) => {
      e.preventDefault(); if (!$('#email').value.includes('@')) return;
      S.loggedIn = true; setError(null); log('login', {}); location.hash = '#/orders';
    });
  }

  function help() {
    app.innerHTML = `<h1>Help</h1><p>Track an order under <a href="#/orders">Your orders</a>. Returns are free within 30 days.</p>
      <p>We carry adult sizes only. Our boots and loafers use leather.</p>`;
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
