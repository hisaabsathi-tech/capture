/* HisaabSathi Capture — background service worker
   Storage model:
     drafts  -> chrome.storage.session  (in-memory, never written to disk;
                                          gone on browser close or page refresh)
     orders  -> IndexedDB               (only after Create Shipment / Confirm
                                          Booking, stamped with captured_at)
   Rows are deleted on export — the downloaded spreadsheet is the record. */

const DEFAULT_SETTINGS = { enabled: true };
const DB_NAME = 'hisaabsathi-db';
const DB_VERSION = 4;
const DRAFT_NS = 'draft:';

function supported(url = '') {
  return url.startsWith('https://app.elite.ekartlogistics.in/ship/forward')
      || url.startsWith('https://bookings.innofulfill.com/credit-booking');
}
function filesFor(url = '') {
  if (url.startsWith('https://app.elite.ekartlogistics.in/ship/forward')) return ['lib/common.js', 'adapters/ekart.js'];
  if (url.startsWith('https://bookings.innofulfill.com/credit-booking')) return ['lib/common.js', 'adapters/shree-maruti.js'];
  return [];
}
function sessionKey(tabId, suffix) { return `${String(tabId)}::${String(suffix || '')}`; }

/* ---------------- IndexedDB: completed orders only ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('orders')) {
        const s = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
        s.createIndex('order_date', 'order_date');
        s.createIndex('courier', 'courier');
        s.createIndex('captured_at', 'captured_at');
      }
      // drafts no longer live on disk; drop the old store if it exists
      if (db.objectStoreNames.contains('drafts')) db.deleteObjectStore('drafts');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
  });
}
async function idbAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
  });
}
async function idbPut(store, v) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(v);
    tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
  });
}
async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
  });
}
async function idbClear(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
  });
}


/* ---------------- session drafts (memory only) ---------------- */

async function draftGet(key) {
  const r = await chrome.storage.session.get(DRAFT_NS + key);
  return r[DRAFT_NS + key] || null;
}
async function draftPut(key, v) {
  await chrome.storage.session.set({ [DRAFT_NS + key]: v });
}
async function draftDelete(key) {
  await chrome.storage.session.remove(DRAFT_NS + key);
}
async function draftAll() {
  const all = await chrome.storage.session.get(null);
  return Object.keys(all).filter(k => k.startsWith(DRAFT_NS)).map(k => all[k]);
}
async function draftClear() {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(DRAFT_NS));
  if (keys.length) await chrome.storage.session.remove(keys);
}

/* ---------------- content script plumbing ---------------- */

async function ensureContentScript(tabId, url) {
  if (!tabId || !supported(url)) return false;
  try { const p = await chrome.tabs.sendMessage(tabId, { type: 'HS_PING' }); if (p?.ok) return true; } catch { }
  const files = filesFor(url);
  if (!files.length) return false;
  try { await chrome.scripting.executeScript({ target: { tabId }, files }); return true; } catch { return false; }
}
async function configureTab(tabId, url) {
  const ok = supported(url);
  await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: ok }).catch(() => { });
  if (ok) await ensureContentScript(tabId, url);
}

function enableActionOpensPanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  await openDB();
  const s = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ enabled: s.enabled !== false });
  enableActionOpensPanel();
});
enableActionOpensPanel();
chrome.runtime.onStartup.addListener(async () => { await openDB(); await draftClear(); });

function nonBlank(v) { return v !== undefined && v !== null && String(v).trim() !== ''; }
function mergeFields(existing, incoming, fields, authoritative) {
  const out = { ...(existing || {}) };
  const locked = (existing?._locked) || {};
  for (const k of fields) {
    if (locked[k]) continue;
    if (!(k in incoming)) continue;
    const v = incoming[k];
    if (authoritative || nonBlank(v) || !(k in out)) out[k] = v;
  }
  return out;
}
const notify = msg => chrome.runtime.sendMessage(msg).catch(() => { });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = sender.tab?.id;

    if (msg?.type === 'ENSURE_CONTENT_SCRIPT') {
      sendResponse({ ok: tabId != null ? await ensureContentScript(tabId, sender.tab.url || '') : false });
      return;
    }

    // live draft — memory only, never touches IndexedDB
    if (msg?.type === 'DRAFT_UPDATED' && tabId != null) {
      const key = sessionKey(tabId, msg.session_suffix);
      const existing = await draftGet(key);
      const fields = Array.isArray(msg.captured_fields) ? msg.captured_fields : Object.keys(msg.order || {});
      const merged = mergeFields(existing, msg.order || {}, fields, msg.authoritative === true);
      merged.courier = msg.order?.courier || existing?.courier || '';
      merged.session_key = key;
      merged.tab_id = tabId;
      merged.status = 'draft';
      merged.order_date = merged.order_date || new Date().toISOString().slice(0, 10);
      merged.updated_at = Date.now();
      await draftPut(key, merged);
      notify({ type: 'DRAFT_UPDATED' });
      sendResponse({ ok: true });
      return;
    }

    // submitted — this is the only path that writes to IndexedDB
    if (msg?.type === 'ORDER_CAPTURED' && tabId != null) {
      const key = sessionKey(tabId, msg.session_suffix);
      const existing = await draftGet(key);
      const fields = Array.isArray(msg.captured_fields) ? msg.captured_fields : Object.keys(msg.order || {});
      const order = mergeFields(existing, msg.order || {}, fields, msg.authoritative === true);
      order.courier = msg.order?.courier || existing?.courier || '';
      order.session_key = key;
      order.tab_id = tabId;
      order.status = 'complete';
      order.order_date = order.order_date || new Date().toISOString().slice(0, 10);
      order.captured_at = Date.now();
      delete order.id;
      await idbPut('orders', order);
      await draftDelete(key);
      notify({ type: 'ORDER_CAPTURED' });
      chrome.tabs.sendMessage(tabId, { type: 'RESET_ORDER_SESSION' }).catch(() => { });
      sendResponse({ ok: true });
      return;
    }

    // page load or refresh: that row's in-progress data goes
    if (msg?.type === 'CLEAR_SESSION_DRAFT' && tabId != null) {
      await draftDelete(sessionKey(tabId, msg.session_suffix));
      notify({ type: 'DRAFT_UPDATED' });
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === 'FIELD_FOCUS' && tabId != null) {
      notify({ type: 'FIELD_FOCUS', field: msg.field || '', session_key: sessionKey(tabId, msg.session_suffix) });
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === 'GET_DATA') {
      const [orders, drafts] = await Promise.all([idbAll('orders'), draftAll()]);
      sendResponse({
        ok: true,
        orders,
        drafts,
        enabled: (await chrome.storage.local.get(DEFAULT_SETTINGS)).enabled !== false
      });
      return;
    }

    // exported rows are deleted outright: the spreadsheet is now the record
    if (msg?.type === 'DELETE_EXPORTED') {
      const ids = Array.isArray(msg.ids) ? msg.ids : [];
      for (const id of ids) await idbDelete('orders', id);
      notify({ type: 'ORDER_CAPTURED' });
      sendResponse({ ok: true, removed: ids.length });
      return;
    }

    if (msg?.type === 'EDIT_DRAFT') {
      const d = await draftGet(msg.session_key);
      if (d) { d[msg.key] = msg.value; d._locked = { ...(d._locked || {}), [msg.key]: true }; d.updated_at = Date.now(); await draftPut(msg.session_key, d); }
      sendResponse({ ok: true }); return;
    }
    if (msg?.type === 'EDIT_ORDER') {
      const o = await idbGet('orders', msg.id);
      if (o) { o[msg.key] = msg.value; o.updated_at = Date.now(); await idbPut('orders', o); }
      sendResponse({ ok: true }); return;
    }
    if (msg?.type === 'DELETE_DRAFT') { await draftDelete(msg.session_key); sendResponse({ ok: true }); return; }
    if (msg?.type === 'DELETE_ORDER') { await idbDelete('orders', msg.id); sendResponse({ ok: true }); return; }

    // delete = wipe everything saved but not yet exported. Live rows untouched.
    if (msg?.type === 'CLEAR_HISTORY') {
      await idbClear('orders');
      sendResponse({ ok: true }); return;
    }

    if (msg?.type === 'GET_CURRENT_TAB') {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse({ ok: true, tab: tabs[0] || null }); return;
    }

    sendResponse({ ok: true });
  })().catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) await configureTab(tabId, tab.url || changeInfo.url || '');
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t) await configureTab(tabId, t.url || '');
});
// a closed tab's in-progress row is gone
chrome.tabs.onRemoved.addListener(async tabId => {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(DRAFT_NS + tabId + '::'));
  if (keys.length) { await chrome.storage.session.remove(keys); notify({ type: 'DRAFT_UPDATED' }); }
});
