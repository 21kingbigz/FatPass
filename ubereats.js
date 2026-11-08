// FatPass Uber Eats script: runs on ubereats.com, pulls past orders with the user's own session.
(() => {
  if (window.__fatPassUberLoaded) return;
  window.__fatPassUberLoaded = true;

  const API = 'https://www.ubereats.com/_p/api/getPastOrdersV1';
  let running = false;

  async function page(cursor) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(API, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' },
          body: JSON.stringify({ lastWorkflowUUID: cursor || '' })
        });
        if (r.status === 401 || r.status === 403) return { loggedOut: true };
        if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.status && j.status !== 'success') return { loggedOut: true };
        return j.data || {};
      } catch (e) {
        if (i === 2) throw e;
        await new Promise((res) => setTimeout(res, 700 * (i + 1)));
      }
    }
  }

  // Uber reports money as cents in some fields and dollars in others; normalise to cents.
  const cents = (v) => {
    if (v == null) return 0;
    if (typeof v === 'object') return cents(v.amountE5 != null ? v.amountE5 / 1000 : v.amount ?? v.value ?? v.rawValue);
    if (typeof v === 'string') { const d = Number(v.replace(/[^0-9.-]/g, '')); return isFinite(d) ? Math.round(d * 100) : 0; }
    const n = Number(v);
    if (!isFinite(n)) return 0;
    return Number.isInteger(n) ? n : Math.round(n * 100); // whole numbers are already cents
  };
  const dollarsToCents = (v) => Math.round((Number(v) || 0) * 100);

  function classify(label, type) {
    const l = `${label || ''} ${type || ''}`.toLowerCase();
    if (/subtotal/.test(l)) return 'subtotal';
    if (/tip|gratuity/.test(l)) return 'tip';
    if (/tax/.test(l)) return 'tax';
    if (/delivery/.test(l)) return 'delivery';
    if (/service/.test(l)) return 'service';
    if (/promo|discount|offer|saving|credit|uber one|membership benefit|off\b/.test(l)) return 'discount';
    if (/fee|small order|ca driver|regulatory/.test(l)) return 'otherFees';
    if (/total/.test(l)) return 'total';
    return 'other';
  }

  function toDate(v) {
    if (!v) return null;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
    const d = new Date(v);
    return isNaN(d) ? null : d.toISOString();
  }

  function normalize(uuid, o) {
    const base = o.baseEaterOrder || o.order || {};
    const store = o.storeInfo || base.storeInfo || {};
    const fare = o.fareInfo || {};
    const cartItems = base.shoppingCart?.items || o.shoppingCart?.items || [];
    const items = cartItems.map((it) => ({
      name: it.title || it.name || 'Item',
      qty: it.quantity || 1,
      price: it.price != null ? cents(it.price) / (it.quantity || 1) : 0
    }));
    const fees = { subtotal: 0, delivery: 0, service: 0, otherFees: 0, tax: 0, feesTax: 0, tip: 0, discount: 0, saved: 0 };
    const lines = [];
    for (const li of fare.checkoutInfo || []) {
      const k = classify(li.label, li.type);
      let amt = li.rawValue != null ? dollarsToCents(li.rawValue) : cents(li.value);
      if (k === 'discount') amt = -Math.abs(amt);
      if (k in fees) fees[k] += amt;
      if (k !== 'total') lines.push({ label: li.label || li.type, amount: amt });
    }
    let total = fare.totalPrice != null ? cents(fare.totalPrice) : 0;
    if (!total) total = lines.reduce((s, l) => s + l.amount, 0);
    if (!fees.subtotal) fees.subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    return {
      platform: 'ubereats', id: 'ue_' + uuid, uuid,
      date: toDate(base.completedAt || base.lastStateChangeAt || base.createdAt || o.completedAt) || new Date().toISOString(),
      fulfilledAt: toDate(base.completedAt),
      cancelled: !!(base.isCancelled || /cancel/i.test(base.orderState || base.status || '')),
      pickup: /pickup|take_?away/i.test(base.diningMode || base.fulfillmentType || ''),
      group: !!(base.isGroupOrder || o.isGroupOrder), gift: false, alcohol: false,
      store: store.title || store.name || 'Unknown', storeId: store.uuid || '', brand: '',
      total, currency: fare.currencyCode || 'USD', card: '', address: base.deliveryAddress?.address1 || '',
      items, fees, lines, hasReceipt: lines.length > 0
    };
  }

  const setStatus = (s) => chrome.storage.local.set({ syncStatus: { ...s, at: Date.now() } });

  async function sync(full) {
    if (running) return { status: 'busy' };
    running = true;
    try {
      const { orders: all = [] } = await chrome.storage.local.get('orders');
      const others = all.filter((o) => o.platform !== 'ubereats');
      const known = new Map(full ? [] : all.filter((o) => o.platform === 'ubereats').map((o) => [o.id, o]));
      const before = known.size;
      setStatus({ state: 'listing', done: 0, total: 0 });
      let cursor = '', added = 0;
      for (let n = 0; n < 500; n++) {
        const d = await page(cursor);
        if (d.loggedOut) { running = false; return { status: 'logged_out' }; }
        const uuids = d.orderUuids || Object.keys(d.ordersMap || {});
        let hitKnown = false;
        for (const u of uuids) {
          const raw = d.ordersMap?.[u];
          if (!raw) continue;
          if (known.has('ue_' + u)) { hitKnown = true; continue; }
          known.set('ue_' + u, normalize(u, raw)); added++;
        }
        setStatus({ state: 'listing', done: 0, total: known.size - before });
        cursor = d.paginationData?.nextCursor || uuids[uuids.length - 1];
        if (!uuids.length || !cursor || hitKnown || d.paginationData?.nextCursor === null) break;
      }
      const merged = [...known.values(), ...others].sort((a, b) => new Date(b.date) - new Date(a.date));
      await chrome.storage.local.set({ orders: merged, lastSync: Date.now() });
      setStatus({ state: 'done', done: added, total: merged.length });
      return { status: 'success', added, total: merged.length };
    } catch (e) {
      setStatus({ state: 'error', error: e.message });
      return { status: 'error', error: e.message };
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.action === 'ping') { reply({ ok: true, loggedIn: true, running }); return; }
    if (msg.action === 'sync') { sync(!!msg.full).then(reply); return true; }
  });
})();
