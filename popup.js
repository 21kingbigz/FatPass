const $ = (id) => document.getElementById(id);
let tab = null, site = null;
const SITE_NAME = { doordash: 'DoorDash', ubereats: 'Uber Eats' };

function fmt(c) { return '$' + (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

async function showStats() {
  const { orders = [], lastSync } = await chrome.storage.local.get(['orders', 'lastSync']);
  const live = orders.filter((o) => !o.cancelled);
  $('tot').textContent = fmt(live.reduce((s, o) => s + o.total, 0));
  $('cnt').textContent = orders.length ? `${live.length.toLocaleString()} orders` : 'No orders yet';
  $('synced').textContent = lastSync ? `Synced ${new Date(lastSync).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not synced yet';
}
function status(text, kind = '') { $('msg').textContent = text; $('dot').className = 'dot ' + kind; }

async function ensureScript() {
  try { return await chrome.tabs.sendMessage(tab.id, { action: 'ping' }); }
  catch (_) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [site === 'ubereats' ? 'ubereats.js' : 'content.js'] });
    return chrome.tabs.sendMessage(tab.id, { action: 'ping' });
  }
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const u = tab?.url || '';
  site = u.startsWith('https://www.doordash.com') ? 'doordash' : u.startsWith('https://www.ubereats.com') ? 'ubereats' : null;
  showStats();
  if (!site) {
    status('Open DoorDash or Uber Eats while logged in to sync.');
    $('sync').textContent = 'Open DoorDash';
    $('sync').onclick = () => chrome.tabs.create({ url: 'https://www.doordash.com/orders/' });
    $('full').hidden = false; $('full').textContent = 'Open Uber Eats';
    $('full').onclick = () => chrome.tabs.create({ url: 'https://www.ubereats.com/orders' });
    $('dash').style.gridColumn = '1/-1';
    return;
  }
  const p = await ensureScript().catch(() => null);
  if (!p) { status(`Reload the ${SITE_NAME[site]} tab, then try again.`, 'bad'); return; }
  if (!p.loggedIn) { status(`Log in to ${SITE_NAME[site]} first.`, 'bad'); $('sync').disabled = $('full').disabled = true; return; }
  status(p.running ? 'Sync in progress…' : `Ready to sync ${SITE_NAME[site]}`, p.running ? 'busy' : 'ok');
  $('sync').textContent = `Sync ${SITE_NAME[site]} orders`;
  $('sync').onclick = () => run(false);
  $('full').onclick = () => run(true);
}

async function run(full) {
  $('sync').disabled = $('full').disabled = true;
  status('Syncing…', 'busy');
  const r = await chrome.tabs.sendMessage(tab.id, { action: 'sync', full }).catch((e) => ({ status: 'error', error: e.message }));
  $('sync').disabled = $('full').disabled = false;
  if (r.status === 'success') status(`Synced ${r.added} new ${SITE_NAME[site]} orders`, 'ok');
  else if (r.status === 'busy') status('Already syncing…', 'busy');
  else status(r.status === 'logged_out' ? `Log in to ${SITE_NAME[site]} first.` : 'Sync failed: ' + r.error, 'bad');
  showStats();
}

chrome.storage.onChanged.addListener((c) => {
  const s = c.syncStatus?.newValue;
  if (!s) return;
  if (s.state === 'listing') status(`Finding orders… ${s.total}`, 'busy');
  if (s.state === 'receipts') { status(`Reading receipts ${s.done}/${s.total}`, 'busy'); $('prog').style.width = (100 * s.done / s.total) + '%'; }
  if (s.state === 'done') $('prog').style.width = '100%';
});

$('dash').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
init();
