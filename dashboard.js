// FatPass dashboard — plain JS, no external libs (Edge MV3 CSP safe).
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (c) => { const d = Math.abs(c) / 100; return (c < 0 ? '-' : '') + '$' + (d >= 1000 ? (d / 1000).toFixed(1) + 'k' : d.toFixed(0)); };
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COLORS = ['#7c5cff', '#ff5c93', '#33d1ff', '#3ee08f', '#ffb547', '#a78bfa', '#c45cff', '#8b8ba7'];

let ALL = [], VIEW = [], tab = 'overview';
const sortState = {};

// ---------- data ----------
async function load() {
  const { orders = [] } = await chrome.storage.local.get('orders');
  ALL = orders.map((o) => ({ ...o, d: new Date(o.date) }));
  const stores = [...new Set(ALL.map((o) => o.store))].sort();
  $('#store').innerHTML = '<option value="">All restaurants</option>' + stores.map((s) => `<option>${esc(s)}</option>`).join('');
  const active = $('.presets .on')?.dataset.p;
  if (active) setPreset(active); else applyFilters();
}

function applyFilters() {
  const from = $('#from').value ? new Date($('#from').value + 'T00:00') : null;
  const to = $('#to').value ? new Date($('#to').value + 'T23:59:59') : null;
  const store = $('#store').value, type = $('#type').value, inclC = $('#cancelled').checked;
  VIEW = ALL.filter((o) =>
    (!from || o.d >= from) && (!to || o.d <= to) && (!store || o.store === store) && (inclC || !o.cancelled) &&
    (!type || (type === 'pickup' ? o.pickup : type === 'group' ? o.group : !o.pickup)));
  render();
}

function setPreset(p) {
  $$('.presets button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
  const now = new Date(), iso = (d) => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  if (p === 'all') {
    const pool = ALL.filter((o) => !o.cancelled && o.total > 0 && !isNaN(o.d));
    const first = pool.length ? new Date(Math.min(...pool.map((o) => o.d))) : now;
    $('#from').value = iso(first); $('#to').value = iso(now);
  }
  else if (p === 'ytd') { $('#from').value = `${now.getFullYear()}-01-01`; $('#to').value = iso(now); }
  else { $('#from').value = iso(new Date(now - p * 864e5)); $('#to').value = iso(now); }
  applyFilters();
}

const live = () => VIEW.filter((o) => !o.cancelled);
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
function groupBy(a, key) { const m = new Map(); for (const x of a) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
const feeTotal = (o) => o.fees.delivery + o.fees.service + o.fees.otherFees + o.fees.feesTax;

// ---------- charts ----------
let gid = 0;
const GRAD_STOPS = '<stop offset="0" stop-color="#7c5cff"/><stop offset=".55" stop-color="#c45cff"/><stop offset="1" stop-color="#ff5c93"/>';
function axis(W, h, pad, max, fmt) {
  let s = '';
  for (let i = 0; i <= 4; i++) { const y = h - (h - 14) * i / 4; s += `<line class="gridline" x1="${pad}" x2="${W}" y1="${y}" y2="${y}"/><text x="0" y="${y + 4}">${fmt(max * i / 4)}</text>`; }
  return s;
}
function barChart(data, { h = 220, fmt = short } = {}) {
  if (!data.length) return '<p class="roast">No data in this range.</p>';
  const id = 'g' + gid++, W = Math.max(640, data.length * 30), pad = 40, max = Math.max(1, ...data.map((d) => d.v));
  const bw = (W - pad) / data.length, step = Math.ceil(data.length / 12);
  let s = `<svg viewBox="0 0 ${W} ${h + 24}" width="100%"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c5cff" stop-opacity=".35"/></linearGradient>
    <linearGradient id="${id}h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5c93"/><stop offset="1" stop-color="#c45cff" stop-opacity=".5"/></linearGradient></defs>` + axis(W, h, pad, max, fmt);
  const top = data.reduce((m, d, i) => (d.v > data[m].v ? i : m), 0);
  data.forEach((d, i) => {
    const bh = Math.max(d.v ? 4 : 0, (h - 14) * d.v / max), x = pad + i * bw, rw = Math.min(26, Math.max(4, bw * 0.55));
    s += `<rect class="bar" x="${x + (bw - rw) / 2}" y="${h - bh}" width="${rw}" height="${bh}" rx="${Math.min(8, rw / 2)}" fill="url(#${id}${i === top ? 'h' : ''})"><title>${esc(d.l)}: ${fmt === short ? money(d.v) : fmt(d.v)}</title></rect>`;
    if (i % step === 0) s += `<text x="${x + bw / 2}" y="${h + 17}" text-anchor="middle">${esc(d.l)}</text>`;
  });
  return s + '</svg>';
}
function smooth(pts) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], mx = (x0 + x1) / 2; d += `C${mx},${y0} ${mx},${y1} ${x1},${y1}`; }
  return d;
}
function lineChart(data, { h = 220, fmt = money } = {}) {
  if (data.length < 2) return barChart(data);
  const id = 'g' + gid++, W = 700, pad = 44, max = Math.max(1, ...data.map((d) => d.v)) * 1.08;
  const pts = data.map((d, i) => [pad + 8 + i * (W - pad - 16) / (data.length - 1), h - (h - 14) * d.v / max]);
  let s = `<svg viewBox="0 0 ${W} ${h + 24}" width="100%"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c5cff" stop-opacity=".45"/><stop offset="1" stop-color="#7c5cff" stop-opacity="0"/></linearGradient>
    <linearGradient id="${id}s" x1="0" x2="1">${GRAD_STOPS}</linearGradient></defs>` + axis(W, h, pad, max, short);
  const path = smooth(pts);
  s += `<path d="${path}L${pts[pts.length - 1][0]},${h}L${pts[0][0]},${h}Z" fill="url(#${id})"/><path d="${path}" fill="none" stroke="url(#${id}s)" stroke-width="3" stroke-linecap="round"/>`;
  const step = Math.ceil(data.length / 10);
  data.forEach((d, i) => {
    if (i % step === 0 || i === data.length - 1) s += `<text x="${pts[i][0]}" y="${h + 17}" text-anchor="middle">${esc(d.l)}</text>`;
    s += `<circle cx="${pts[i][0]}" cy="${pts[i][1]}" class="hit" r="7" fill="var(--card)" stroke="#a78bfa" stroke-width="3"><title>${esc(d.l)}: ${fmt(d.v)}</title></circle>`;
  });
  const last = pts[pts.length - 1];
  s += `<circle cx="${last[0]}" cy="${last[1]}" r="6" fill="#ff5c93" stroke="var(--card)" stroke-width="3"/>`;
  return s + '</svg>';
}
function sparkArea(vals) {
  if (vals.length < 2) return '';
  const W = 300, H = 80, max = Math.max(1, ...vals);
  const pts = vals.map((v, i) => [i * W / (vals.length - 1), H - 6 - (H - 16) * v / max]);
  const p = smooth(pts);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="spk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
    <path d="${p}L${W},${H}L0,${H}Z" fill="url(#spk)"/><path d="${p}" fill="none" stroke="#fff" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>`;
}
function ring(frac, label, color = 'url(#ringg)', size = 150) {
  const r = 58, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, frac || 0));
  return `<svg width="${size}" height="${size}" viewBox="0 0 150 150"><defs><linearGradient id="ringg" x1="0" y1="0" x2="1" y2="1">${GRAD_STOPS}</linearGradient></defs>
    <circle cx="75" cy="75" r="${r}" fill="none" stroke="var(--card2)" stroke-width="14"/>
    <circle cx="75" cy="75" r="${r}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${c * f} ${c}" transform="rotate(-90 75 75)"/>
    <text x="75" y="84" text-anchor="middle" style="font:800 26px Manrope;fill:var(--fg)">${label}</text></svg>`;
}
function donut(parts) {
  parts = parts.filter((p) => p.v > 0);
  const tot = sum(parts, (p) => p.v);
  if (!tot) return '<p class="roast">No receipt details in this range.</p>';
  const r = 70, c = 2 * Math.PI * r, gap = parts.length > 1 ? 6 : 0;
  let off = 0, s = `<svg width="190" height="190" viewBox="0 0 190 190"><circle cx="95" cy="95" r="${r}" fill="none" stroke="var(--card2)" stroke-width="18"/>`;
  parts.forEach((p, i) => {
    const len = Math.max(0.1, c * p.v / tot - gap);
    s += `<circle cx="95" cy="95" r="${r}" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="18" stroke-linecap="round" stroke-dasharray="${len} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 95 95)"><title>${esc(p.l)}: ${money(p.v)}</title></circle>`;
    off += c * p.v / tot;
  });
  s += `<text x="95" y="94" text-anchor="middle" style="font:800 22px Manrope;fill:var(--fg)">${short(tot)}</text><text x="95" y="114" text-anchor="middle">total</text></svg>`;
  return `<div class="donut">${s}<div class="legend">${parts.map((p, i) => `<div><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(p.l)} <b>${money(p.v)}</b> · ${pct(p.v, tot)}</div>`).join('')}</div></div>`;
}

const hbars = (rows, fmt = money) => { const m = Math.max(1, ...rows.map((r) => r.v)); return rows.map((r) => `<div class="hb" title="${esc(r.l)}: ${esc(fmt(r.v))}"><span class="nm">${esc(r.l)}</span><span class="tr"><span class="fl" style="display:block;width:${100 * r.v / m}%"></span></span><span class="vl">${fmt(r.v)}</span></div>`).join(''); };
const kpi = (l, v, s = '') => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
const card = (t, body, extra = '') => `<div class="card" ${extra}><h3>${t}</h3>${body}</div>`;

function monthly(arr, f = (o) => o.total) {
  if (!arr.length) return [];
  const m = new Map(); const ds = arr.map((o) => o.d).sort((a, b) => a - b);
  for (let d = new Date(ds[0].getFullYear(), ds[0].getMonth(), 1); d <= ds[ds.length - 1]; d.setMonth(d.getMonth() + 1)) m.set(`${d.getFullYear()}-${d.getMonth()}`, { l: d.toLocaleString(undefined, { month: 'short', year: '2-digit' }), v: 0 });
  for (const o of arr) { const k = `${o.d.getFullYear()}-${o.d.getMonth()}`; if (m.has(k)) m.get(k).v += f(o); }
  return [...m.values()];
}

// ---------- sortable table ----------
function table(id, cols, rows, { onRow } = {}) {
  const st = sortState[id] || { k: cols.find((c) => c.def)?.k || cols[0].k, dir: -1 };
  sortState[id] = st;
  rows = [...rows].sort((a, b) => { const x = a[st.k], y = b[st.k]; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * st.dir; });
  const head = cols.map((c) => `<th data-tbl="${id}" data-k="${c.k}" class="${c.n ? 'n' : ''}">${c.l}${st.k === c.k ? (st.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');
  const body = rows.map((r, i) => `<tr class="${onRow ? 'clk' : ''}" data-i="${esc(r._key ?? i)}">${cols.map((c) => `<td class="${c.n ? 'n' : ''}">${c.f ? c.f(r[c.k], r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('');
  return `<table id="${id}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---------- tabs ----------
const TABS = {
  overview() {
    const L = live(), total = sum(L, (o) => o.total), n = L.length;
    const days = n ? Math.max(1, (Math.max(...L.map((o) => o.d)) - Math.min(...L.map((o) => o.d))) / 864e5) : 1;
    const items = sum(L, (o) => sum(o.items, (i) => i.qty));
    const big = L.reduce((m, o) => (o.total > (m?.total || 0) ? o : m), null);
    const fees = sum(L, feeTotal), tips = sum(L, (o) => o.fees.tip), tax = sum(L, (o) => o.fees.tax), food = sum(L, (o) => o.fees.subtotal);
    const disc = -sum(L, (o) => o.fees.discount) + sum(L, (o) => o.fees.saved);
    const stores = groupBy(L, (o) => o.store);
    const fav = [...stores].sort((a, b) => b[1].length - a[1].length)[0];
    const mon = monthly(L);
    const allR = ALL.filter((o) => !o.cancelled && o.total > 0).sort((a, b) => a.d - b.d);
    const fd = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `<section class="hero">
      <div class="card big"><img class="mascot" src="icons/fatpass-full.png" alt="">
        <div class="l">Total spent</div><div class="v">${money(total)}</div>
        <div class="s">${n.toLocaleString()} orders · ${money(total / days * 30)} a month</div>
        ${sparkArea(mon.map((m) => m.v))}
      </div>
      <div class="card ringcard"><h3 style="align-self:stretch">Money that was food</h3>
        ${ring(total ? food / total : 0, total ? Math.round(100 * food / total) + '%' : '—')}
        <div class="cap"><b>${money(fees + tips + tax)}</b> went to fees, tax and tips</div></div>
      <div class="card ringcard"><h3 style="align-self:stretch">Top spot</h3>
        ${ring(fav ? fav[1].length / n : 0, fav ? fav[1].length + '×' : '—', '#33d1ff')}
        <div class="cap">${fav ? `<b>${esc(fav[0])}</b> · ${pct(fav[1].length, n)} of your orders` : 'No orders yet'}</div>
        <div class="roast">${esc(roast(L, total, fees, tips, fav, days))}</div></div>
    </section>
    <div class="kpis">
      ${kpi('Avg order', money(n ? total / n : 0), `usually ~${money(median(L.map((o) => o.total)))}`)}
      ${kpi('Fees paid', money(fees), pct(fees, total) + ' of spend')}
      ${kpi('Tips given', money(tips), `${money(n ? tips / n : 0)} per order`)}
      ${kpi('Saved', money(disc), 'promos + DashPass')}
      ${kpi('Items ordered', items.toLocaleString(), `${(n ? items / n : 0).toFixed(1)} per order`)}
      ${kpi('Restaurants', stores.size, VIEW.length - n ? `${VIEW.length - n} cancelled orders` : 'places tried')}
      ${kpi('Biggest order', big ? money(big.total) : '—', big ? esc(big.store) : '')}
      ${kpi('Order every', n > 1 ? (days / (n - 1)).toFixed(1) + ' days' : '—', 'on average')}
      ${allR.length ? kpi('First order ever', fd(allR[0].d), `${esc(allR[0].store)} · ${money(allR[0].total)}`) + kpi('Latest order', fd(allR[allR.length - 1].d), esc(allR[allR.length - 1].store)) : ''}
    </div>
    ${card('Spending over time', lineChart(mon))}
    <div class="grid2">${card('Top restaurants', hbars([...stores].map(([l, a]) => ({ l, v: sum(a, (o) => o.total) })).sort((a, b) => b.v - a.v).slice(0, 7)))}
    ${card('Where your money goes', donut(breakdown(L)))}</div>`;
  },

  restaurants() {
    const rows = [...groupBy(live(), (o) => o.store)].map(([store, a]) => {
      const spend = sum(a, (o) => o.total), last = a.reduce((m, o) => (o.d > m ? o.d : m), a[0].d), first = a.reduce((m, o) => (o.d < m ? o.d : m), a[0].d);
      return { store, _key: store, orders: a.length, spend, avg: spend / a.length, fees: sum(a, feeTotal), tips: sum(a, (o) => o.fees.tip), first: +first, last: +last };
    });
    return `<div class="grid2">${card('Most ordered from', hbars(rows.map((r) => ({ l: r.store, v: r.orders })).sort((a, b) => b.v - a.v).slice(0, 10), (v) => v + ' orders'))}
      ${card('Highest average order', hbars(rows.filter((r) => r.orders > 1).map((r) => ({ l: r.store, v: r.avg })).sort((a, b) => b.v - a.v).slice(0, 10)))}</div>` +
      card(`All restaurants (${rows.length}) <span class="pill">click a row to filter</span>`, table('tRest', [
        { k: 'store', l: 'Restaurant' }, { k: 'orders', l: 'Orders', n: 1 }, { k: 'spend', l: 'Spent', n: 1, f: money, def: 1 },
        { k: 'avg', l: 'Avg', n: 1, f: money }, { k: 'fees', l: 'Fees', n: 1, f: money }, { k: 'tips', l: 'Tips', n: 1, f: money },
        { k: 'first', l: 'First', f: (v) => new Date(v).toLocaleDateString() }, { k: 'last', l: 'Last', f: (v) => new Date(v).toLocaleDateString() }
      ], rows, { onRow: true }));
  },

  items() {
    const m = new Map();
    for (const o of live()) for (const i of o.items) {
      const k = i.name.trim(); const e = m.get(k) || { name: k, _key: k, qty: 0, spend: 0, orders: 0, stores: new Set() };
      e.qty += i.qty; e.spend += i.price * i.qty; e.orders++; e.stores.add(o.store); m.set(k, e);
    }
    const q = ($('#itemQ')?.value || '').toLowerCase();
    const rows = [...m.values()].map((e) => ({ ...e, avg: e.qty ? e.spend / e.qty : 0, stores: [...e.stores].join(', ') })).filter((r) => !q || r.name.toLowerCase().includes(q) || r.stores.toLowerCase().includes(q));
    return `<div class="grid2">${card('Most ordered items', hbars(rows.map((r) => ({ l: r.name, v: r.qty })).sort((a, b) => b.v - a.v).slice(0, 10), (v) => v + '×'))}
      ${card('Most spent on', hbars(rows.map((r) => ({ l: r.name, v: r.spend })).sort((a, b) => b.v - a.v).slice(0, 10)))}</div>` +
      card(`Items (${rows.length})`, `<div class="toolbar"><input id="itemQ" placeholder="Search items or restaurants…" value="${esc(q)}"></div>` + table('tItems', [
        { k: 'name', l: 'Item' }, { k: 'qty', l: 'Qty', n: 1, def: 1 }, { k: 'orders', l: 'Orders', n: 1 }, { k: 'spend', l: 'Spent', n: 1, f: money },
        { k: 'avg', l: 'Avg price', n: 1, f: money }, { k: 'stores', l: 'From' }], rows));
  },

  fees() {
    const L = live(), withR = L.filter((o) => o.hasReceipt), total = sum(withR, (o) => o.total);
    const f = (k) => sum(withR, (o) => o.fees[k]);
    const allFees = sum(withR, feeTotal);
    const tipRows = withR.filter((o) => o.fees.tip > 0 && o.fees.subtotal > 0);
    return `<div class="kpis">
      ${kpi('Food subtotal', money(f('subtotal')), pct(f('subtotal'), total) + ' of spend')}
      ${kpi('Delivery fees', money(f('delivery')))}${kpi('Service fees', money(f('service')))}
      ${kpi('Other fees', money(f('otherFees') + f('feesTax')))}${kpi('Taxes', money(f('tax')))}
      ${kpi('Tips', money(f('tip')), tipRows.length ? `avg ${pct(sum(tipRows, (o) => o.fees.tip), sum(tipRows, (o) => o.fees.subtotal))} of food` : '')}
      ${kpi('Promos & credits', money(-f('discount')))}${kpi('DashPass / fee savings', money(f('saved')))}
      ${kpi('Markup over food', pct(total - f('subtotal'), f('subtotal')), 'fees+tax+tip vs food')}
    </div>
    ${withR.length < L.length ? `<p class="warn">${L.length - withR.length} orders have no receipt details; run a Full re-sync to fill them in.</p>` : ''}
    <div class="grid2">${card('Breakdown', donut(breakdown(withR)))}
    ${card('Fees + tax + tip per month', barChart(monthly(withR, (o) => feeTotal(o) + o.fees.tax + o.fees.tip)))}</div>
    ${card('Fees by restaurant', table('tFees', [{ k: 'store', l: 'Restaurant' }, { k: 'orders', l: 'Orders', n: 1 }, { k: 'fees', l: 'Fees', n: 1, f: money, def: 1 }, { k: 'avgFee', l: 'Avg fee', n: 1, f: money }, { k: 'tips', l: 'Tips', n: 1, f: money }, { k: 'feePct', l: 'Fee %', n: 1, f: (v) => v.toFixed(1) + '%' }],
      [...groupBy(withR, (o) => o.store)].map(([store, a]) => { const fe = sum(a, feeTotal), t = sum(a, (o) => o.total); return { store, orders: a.length, fees: fe, avgFee: fe / a.length, tips: sum(a, (o) => o.fees.tip), feePct: t ? 100 * fe / t : 0 }; })))}`;
  },

  trends() {
    const L = live().slice().sort((a, b) => a.d - b.d);
    let run = 0; const cum = monthly(L).map((m) => ({ l: m.l, v: (run += m.v) }));
    const years = [...groupBy(L, (o) => o.d.getFullYear())].sort((a, b) => a[0] - b[0]);
    const yrRows = years.map(([y, a]) => ({ y, orders: a.length, spend: sum(a, (o) => o.total), avg: sum(a, (o) => o.total) / a.length, stores: new Set(a.map((o) => o.store)).size }));
    return card('Cumulative spend', lineChart(cum)) +
      `<div class="grid2">${card('Orders per month', barChart(monthly(L, () => 1), { fmt: (v) => Math.round(v) }))}
      ${card('Average order value per month', lineChart(monthly(L).map((m, i, arr) => { const c = monthly(L, () => 1)[i].v; return { l: m.l, v: c ? m.v / c : 0 }; })))}</div>` +
      card('Year over year', table('tYears', [{ k: 'y', l: 'Year', def: 1 }, { k: 'orders', l: 'Orders', n: 1 }, { k: 'spend', l: 'Spent', n: 1, f: money }, { k: 'avg', l: 'Avg', n: 1, f: money }, { k: 'stores', l: 'Restaurants', n: 1 }], yrRows));
  },

  habits() {
    const L = live();
    const dow = DAYS.map((l, i) => ({ l, v: L.filter((o) => o.d.getDay() === i).length }));
    const hr = Array.from({ length: 24 }, (_, h) => ({ l: (h % 12 || 12) + (h < 12 ? 'a' : 'p'), v: L.filter((o) => o.d.getHours() === h).length }));
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0)); L.forEach((o) => grid[o.d.getDay()][o.d.getHours()]++);
    const gm = Math.max(1, ...grid.flat());
    const heat = `<div class="heat"><span></span>${hr.map((h, i) => `<span>${i % 3 ? '' : h.l}</span>`).join('')}${grid.map((r, d) => `<span>${DAYS[d]}</span>` + r.map((c, h) => `<div title="${DAYS[d]} ${hr[h].l}: ${c} order${c === 1 ? "" : "s"}" style="opacity:${c ? 0.18 + 0.82 * c / gm : 0.06}"></div>`).join('')).join('')}</div>`;
    const meal = (o) => { const h = o.d.getHours(); return h < 11 ? 'Breakfast' : h < 15 ? 'Lunch' : h < 17 ? 'Afternoon' : h < 22 ? 'Dinner' : 'Late night'; };
    const meals = [...groupBy(L, meal)].map(([l, a]) => ({ l, v: sum(a, (o) => o.total) }));
    const wk = L.filter((o) => [0, 6].includes(o.d.getDay()));
    const cards = [...groupBy(L.filter((o) => o.card), (o) => o.card)].map(([l, a]) => ({ l, v: sum(a, (o) => o.total) }));
    const addr = [...groupBy(L.filter((o) => o.address && !o.pickup), (o) => o.address)].map(([l, a]) => ({ l, v: a.length })).sort((a, b) => b.v - a.v).slice(0, 6);
    return `<div class="kpis">${kpi('Weekend orders', pct(wk.length, L.length))}${kpi('Pickup orders', L.filter((o) => o.pickup).length)}${kpi('Group orders', L.filter((o) => o.group).length)}${kpi('Busiest day', dow.reduce((m, d) => (d.v > m.v ? d : m), dow[0]).l)}${kpi('Busiest hour', hr.reduce((m, d) => (d.v > m.v ? d : m), hr[0]).l)}</div>
      ${card('When you order (day × hour)', heat)}
      <div class="grid2">${card('Orders by weekday', barChart(dow, { fmt: (v) => Math.round(v) }))}${card('Orders by hour', barChart(hr, { fmt: (v) => Math.round(v) }))}</div>
      <div class="grid2">${card('Spend by meal', donut(meals))}${card('Payment cards', cards.length ? hbars(cards) : 'No card info')}</div>
      ${card('Top delivery addresses', addr.length ? hbars(addr, (v) => v + ' orders') : 'None')}`;
  },

  orders() {
    const q = ($('#orderQ')?.value || '').toLowerCase();
    const rows = VIEW.filter((o) => !q || o.store.toLowerCase().includes(q) || o.items.some((i) => i.name.toLowerCase().includes(q)))
      .map((o) => ({ _key: o.id, date: +o.d, store: o.store, items: sum(o.items, (i) => i.qty), sub: o.fees.subtotal, fee: feeTotal(o), tip: o.fees.tip, total: o.total, cancelled: o.cancelled, pickup: o.pickup }));
    return card(`Orders (${rows.length}) <span class="pill">click for receipt</span>`, `<div class="toolbar"><input id="orderQ" placeholder="Search restaurant or item…" value="${esc(q)}"></div>` + table('tOrders', [
      { k: 'date', l: 'Date', def: 1, f: (v) => new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) },
      { k: 'store', l: 'Restaurant', f: (v, r) => esc(v) + (r.cancelled ? '<span class="pill warn">cancelled</span>' : '') + (r.pickup ? '<span class="pill">pickup</span>' : '') },
      { k: 'items', l: 'Items', n: 1 }, { k: 'sub', l: 'Food', n: 1, f: money }, { k: 'fee', l: 'Fees', n: 1, f: money }, { k: 'tip', l: 'Tip', n: 1, f: money }, { k: 'total', l: 'Total', n: 1, f: money }
    ], rows, { onRow: true }));
  }
};

function roast(L, total, fees, tips, fav, days) {
  const n = L.length; if (!n) return "Nothing here. Did you... cook?";
  const late = L.filter((o) => o.d.getHours() >= 22 || o.d.getHours() < 4).length;
  const lines = [];
  if (fav && fav[1].length / n > 0.25) lines.push(`${fav[0]} again? That's ${fav[1].length} times. They know your name.`);
  if (n > 1 && days / (n - 1) < 3) lines.push(`One order every ${(days / (n - 1)).toFixed(1)} days. The kitchen is just decoration at this point.`);
  if (fees + tips > total * 0.25) lines.push(`${money(fees + tips)} went to fees and tips. Not one bite of that was food.`);
  if (late > n * 0.15) lines.push(`${late} orders after 10pm. Midnight snacks hit different, huh.`);
  if (total > 100000) lines.push(`That's ${Math.floor(total / 1500)} grocery-store rotisserie chickens. Just saying.`);
  lines.push(`${money(total / n)} a meal. Could be worse. Could be better.`);
  return lines[Math.floor(Date.now() / 864e5) % lines.length];
}
function median(a) { if (!a.length) return 0; a = [...a].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function breakdown(L) {
  return [{ l: 'Food', v: sum(L, (o) => o.fees.subtotal + Math.min(0, o.fees.discount)) }, { l: 'Delivery fee', v: sum(L, (o) => o.fees.delivery) },
    { l: 'Service fee', v: sum(L, (o) => o.fees.service) }, { l: 'Other fees', v: sum(L, (o) => o.fees.otherFees + o.fees.feesTax) },
    { l: 'Tax', v: sum(L, (o) => o.fees.tax) }, { l: 'Tip', v: sum(L, (o) => o.fees.tip) }];
}

function wireTips() {
  $$('#main svg title').forEach((t) => { t.parentNode.setAttribute('data-tip', t.textContent); t.remove(); });
  $$('#main [title]').forEach((el) => { el.setAttribute('data-tip', el.getAttribute('title')); el.removeAttribute('title'); });
}
const tip = document.createElement('div');
tip.className = 'tip'; tip.hidden = true; document.body.appendChild(tip);
document.addEventListener('mousemove', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) { tip.hidden = true; return; }
  const [a, b] = el.getAttribute('data-tip').split(': ');
  tip.innerHTML = b !== undefined ? `<span>${esc(a)}</span><b>${esc(b)}</b>` : `<b>${esc(a)}</b>`;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY - r.height - 12;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y < 8) y = e.clientY + 18;
  tip.style.transform = `translate(${x}px,${y}px)`;
});
document.addEventListener('scroll', () => (tip.hidden = true), true);

function render() {
  $('#empty').hidden = ALL.length > 0;
  $('#main').hidden = !ALL.length;
  if (!ALL.length) return;
  const focus = document.activeElement?.id, pos = document.activeElement?.selectionStart;
  $('#main').innerHTML = TABS[tab]();
  $('#title').textContent = $(`.tabs [data-t=${tab}]`).textContent.trim();
  wireTips();
  $('#rangeLabel').textContent = $('#from').value && $('#to').value ? `${$('#from').value} → ${$('#to').value}` : 'All time';
  if (focus && $('#' + focus) && $('#' + focus).tagName === 'INPUT' && $('#main').contains($('#' + focus))) { const el = $('#' + focus); el.focus(); el.setSelectionRange(pos, pos); }
}

// ---------- events ----------
$$('.tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.t; $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); render(); }));
$$('.presets button').forEach((b) => (b.onclick = () => setPreset(b.dataset.p)));
$('#apply').onclick = () => { $$('.presets button').forEach((b) => b.classList.remove('on')); applyFilters(); };
$('#reset').onclick = () => { $('#store').value = ''; $('#type').value = ''; $('#cancelled').checked = false; setPreset('all'); };
['#store', '#type', '#cancelled'].forEach((s) => ($(s).onchange = applyFilters));

let debounce;
$('#main').addEventListener('input', (e) => { if (['itemQ', 'orderQ'].includes(e.target.id)) { clearTimeout(debounce); debounce = setTimeout(render, 150); } });
$('#main').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-tbl]');
  if (th) { const st = sortState[th.dataset.tbl]; st.dir = st.k === th.dataset.k ? -st.dir : -1; st.k = th.dataset.k; render(); return; }
  const tr = e.target.closest('tr.clk');
  if (!tr) return;
  const tbl = tr.closest('table').id, key = tr.dataset.i;
  if (tbl === 'tRest') { $('#store').value = key; applyFilters(); return; }
  if (tbl === 'tOrders') {
    if (tr.nextElementSibling?.classList.contains('detail')) { tr.nextElementSibling.remove(); return; }
    const o = ALL.find((x) => x.id === key);
    const lines = o.lines.length ? o.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="n">${money(l.amount)}</td></tr>`).join('') : '';
    tr.insertAdjacentHTML('afterend', `<tr class="detail"><td colspan="7"><div class="grid2"><div><b>Items</b><table>${o.items.map((i) => `<tr><td>${i.qty}× ${esc(i.name)}</td><td class="n">${money(i.price * i.qty)}</td></tr>`).join('')}</table></div>
      <div><b>Receipt</b><table>${lines}<tr><td><b>Total</b></td><td class="n"><b>${money(o.total)}</b></td></tr></table>
      <p>${esc(o.card)} ${o.address ? '· ' + esc(o.address) : ''}</p><a href="https://www.doordash.com/orders/${esc(o.uuid)}" target="_blank">Open on DoorDash ↗</a></div></div></td></tr>`);
  }
});

function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
$('#exportCsv').onclick = () => {
  const cols = ['date', 'store', 'cancelled', 'pickup', 'items', 'subtotal', 'delivery', 'service', 'otherFees', 'tax', 'tip', 'discount', 'total'];
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = VIEW.map((o) => [o.d.toISOString(), o.store, o.cancelled, o.pickup, o.items.map((i) => `${i.qty}x ${i.name}`).join('; '),
    ...['subtotal', 'delivery', 'service'].map((k) => o.fees[k] / 100), (o.fees.otherFees + o.fees.feesTax) / 100, o.fees.tax / 100, o.fees.tip / 100, o.fees.discount / 100, o.total / 100].map(q).join(','));
  download('fatpass-doordash.csv', [cols.join(','), ...rows].join('\n'), 'text/csv');
};
$('#exportJson').onclick = () => download('fatpass-doordash.json', JSON.stringify(ALL.map(({ d, ...o }) => o), null, 1), 'application/json');
$('#importJson').onchange = async (e) => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(data)) throw new Error('Expected an array of orders');
    const m = new Map(ALL.map(({ d, ...o }) => [o.id, o])); data.forEach((o) => o.id && m.set(o.id, o));
    await chrome.storage.local.set({ orders: [...m.values()] }); load();
  } catch (err) { alert('Import failed: ' + err.message); }
};
$('#clear').onclick = async () => { if (confirm('Delete all saved order data from this browser?')) { await chrome.storage.local.remove(['orders', 'lastSync']); load(); } };
$('#theme').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; themeLabel(); chrome.storage.local.set({ theme: t }); };

chrome.storage.local.get('theme').then(({ theme }) => { document.documentElement.dataset.theme = theme || 'dark'; themeLabel(); });
function themeLabel() { $('#theme span').textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode'; }
chrome.storage.onChanged.addListener((c) => { if (c.orders) load(); });
load();
