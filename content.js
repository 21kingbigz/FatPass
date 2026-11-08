// FatPass content script: runs on doordash.com, pulls orders with the user's own session.
(() => {
  if (window.__biteStatsLoaded) return;
  window.__biteStatsLoaded = true;

  const PAGE_SIZE = 25;       // orders per list request
  const RECEIPT_WORKERS = 6;  // parallel receipt requests
  let running = false;

  const cookie = (n) => {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };
  const isLoggedIn = () => cookie('dd_cx_logged_in') !== null;

  const headers = () => ({
    'accept': '*/*',
    'content-type': 'application/json',
    'apollographql-client-name': '@doordash/app-consumer-production-ssr-client',
    'apollographql-client-version': '3.0',
    'x-channel-id': 'marketplace',
    'x-experience-id': 'doordash',
    'x-csrftoken': cookie('csrf_token') || ''
  });

  async function gql(op, query, variables, tries = 3) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(`https://www.doordash.com/graphql/${op}?operation=${op}`, {
          method: 'POST', credentials: 'include', headers: headers(),
          body: JSON.stringify({ operationName: op, variables, query })
        });
        if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.errors && !j.data) throw new Error(j.errors[0]?.message || 'GraphQL error');
        return j.data;
      } catch (e) {
        if (i === tries - 1) throw e;
        await new Promise((res) => setTimeout(res, 600 * (i + 1)));
      }
    }
  }

  const ORDERS_Q = `query getConsumerOrdersWithDetails($offset: Int!, $limit: Int!, $includeCancelled: Boolean) {
    getConsumerOrdersWithDetails(offset: $offset, limit: $limit, includeCancelled: $includeCancelled) {
      id orderUuid createdAt submittedAt cancelledAt fulfilledAt isGroup isGift isPickup containsAlcohol fulfillmentType
      deliveryAddress { formattedAddress }
      orders { creator { id firstName } items { name quantity originalItemPrice } }
      paymentCard { last4 type }
      grandTotal { unitAmount currency decimalPlaces }
      store { id name business { name } }
    }
  }`;

  const RECEIPT_Q = `query getConsumerOrderReceipt($orderCartId: ID!) {
    getConsumerOrderReceipt(orderCartId: $orderCartId) {
      lineItems { label finalMoney { unitAmount displayString } originalMoney { unitAmount } }
      orders { orderItemsList { quantity item { name } unitPriceMonetaryFields { unitAmount } } }
    }
  }`;

  function classify(label) {
    const l = (label || '').toLowerCase();
    if (/subtotal/.test(l)) return 'subtotal';
    if (/tip/.test(l)) return 'tip';
    if (/tax/.test(l) && /fee/.test(l)) return 'feesTax';
    if (/tax/.test(l)) return 'tax';
    if (/delivery/.test(l) && /fee/.test(l)) return 'delivery';
    if (/service/.test(l)) return 'service';
    if (/small order|regulatory|expanded range|long distance|priority|express|fee/.test(l)) return 'otherFees';
    if (/discount|promo|offer|saving|credit|dashpass|off\b|coupon|reward/.test(l)) return 'discount';
    if (/total/.test(l)) return 'total';
    return 'other';
  }

  function money(m) {
    if (!m) return 0;
    let v = Number(m.unitAmount) || 0;
    if (m.displayString && /^\s*-|\(/.test(m.displayString) && v > 0) v = -v;
    return v;
  }

  function normalize(o, receipt) {
    const items = [];
    const rItems = receipt?.orders?.flatMap((x) => x.orderItemsList || []) || [];
    if (rItems.length) {
      for (const it of rItems) items.push({ name: it.item?.name || 'Item', qty: it.quantity || 1, price: it.unitPriceMonetaryFields?.unitAmount || 0 });
    } else {
      for (const sub of o.orders || []) for (const it of sub.items || [])
        items.push({ name: it.name, qty: it.quantity || 1, price: it.originalItemPrice || 0 });
    }
    const fees = { subtotal: 0, delivery: 0, service: 0, otherFees: 0, tax: 0, feesTax: 0, tip: 0, discount: 0, saved: 0 };
    const lines = [];
    for (const li of receipt?.lineItems || []) {
      const k = classify(li.label);
      let amt = money(li.finalMoney);
      if (k === 'discount') amt = -Math.abs(amt);
      // savings hidden in fee lines (e.g. DashPass $0 delivery, original $3.99)
      const orig = li.originalMoney?.unitAmount;
      if (k !== 'discount' && orig && orig > Math.abs(amt)) fees.saved += (orig - Math.abs(amt));
      if (k in fees) fees[k] += amt;
      if (k !== 'total') lines.push({ label: li.label, amount: amt });
    }
    const total = o.grandTotal?.unitAmount || 0;
    if (!fees.subtotal) fees.subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    return {
      platform: 'doordash', id: String(o.id), uuid: o.orderUuid,
      date: o.submittedAt || o.createdAt,
      fulfilledAt: o.fulfilledAt || null,
      cancelled: !!o.cancelledAt,
      pickup: !!o.isPickup, group: !!o.isGroup, gift: !!o.isGift, alcohol: !!o.containsAlcohol,
      store: o.store?.name || 'Unknown', storeId: o.store?.id || '', brand: o.store?.business?.name || '',
      total, currency: o.grandTotal?.currency || 'USD',
      card: o.paymentCard?.last4 ? `${o.paymentCard.type || 'Card'} •${o.paymentCard.last4}` : '',
      address: o.deliveryAddress?.formattedAddress || '',
      items, fees, lines, hasReceipt: !!receipt
    };
  }

  const setStatus = (s) => chrome.storage.local.set({ syncStatus: { ...s, at: Date.now() } });

  async function sync(full) {
    if (running) return { status: 'busy' };
    if (!isLoggedIn()) return { status: 'logged_out' };
    running = true;
    try {
      const { orders: all = [], account } = await chrome.storage.local.get(['orders', 'account']);
      const others = all.filter((o) => (o.platform || 'doordash') !== 'doordash');
      const existing = all.filter((o) => (o.platform || 'doordash') === 'doordash');
      const me = cookie('dd_cx_logged_in');
      // different DoorDash account (or full re-sync) => start clean so old orders don't mix in
      const fresh0 = full || (account && account !== me);
      await chrome.storage.local.set({ account: me });
      const known = new Map(fresh0 ? [] : existing.map((o) => [o.id, o]));
      setStatus({ state: 'listing', done: 0, total: 0 });

      // 1) page through order list, stop early once we hit already-synced orders
      const fresh = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const d = await gql('getConsumerOrdersWithDetails', ORDERS_Q, { offset, limit: PAGE_SIZE, includeCancelled: true });
        const page = d?.getConsumerOrdersWithDetails || [];
        let hitKnown = false;
        for (const o of page) {
          const k = known.get(String(o.id));
          if (k && k.hasReceipt) { hitKnown = true; continue; }
          fresh.push(o);
        }
        setStatus({ state: 'listing', done: 0, total: fresh.length });
        if (page.length < PAGE_SIZE || hitKnown) break;
      }

      // 2) receipts in parallel
      const out = new Array(fresh.length);
      let next = 0, done = 0;
      async function worker() {
        while (next < fresh.length) {
          const i = next++;
          let receipt = null;
          try { receipt = (await gql('getConsumerOrderReceipt', RECEIPT_Q, { orderCartId: fresh[i].orderUuid }))?.getConsumerOrderReceipt; } catch (_) {}
          out[i] = normalize(fresh[i], receipt);
          done++;
          if (done % 3 === 0 || done === fresh.length) setStatus({ state: 'receipts', done, total: fresh.length });
        }
      }
      await Promise.all(Array.from({ length: RECEIPT_WORKERS }, worker));

      for (const o of out) known.set(o.id, o);
      const merged = [...known.values(), ...others].sort((a, b) => new Date(b.date) - new Date(a.date));
      await chrome.storage.local.set({ orders: merged, lastSync: Date.now() });
      setStatus({ state: 'done', done: out.length, total: merged.length });
      return { status: 'success', added: out.length, total: merged.length };
    } catch (e) {
      setStatus({ state: 'error', error: e.message });
      return { status: 'error', error: e.message };
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.action === 'ping') { reply({ ok: true, loggedIn: isLoggedIn(), running }); return; }
    if (msg.action === 'sync') { sync(!!msg.full).then(reply); return true; }
  });
})();
