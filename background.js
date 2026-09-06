/* HisaabSathi Capture — background service worker
   Storage model:
     drafts  -> chrome.storage.session  (in-memory, never written to disk;
                                          gone on browser close or page refresh)
     orders  -> IndexedDB               (only after Create Shipment / Confirm
                                          Booking, stamped with captured_at;
                                          unique on awb_no — same AWB upserts)
   Rows are deleted on export — the downloaded spreadsheet is the record. */

const DEFAULT_SETTINGS = { enabled: true };
const DB_NAME = 'hisaabsathi-db';
const DB_VERSION = 5;
const DRAFT_NS = 'draft:';

function courierFor(url = '') {
  if (url.startsWith('https://app.elite.ekartlogistics.in/ship/forward')) return 'EKART';
  if (url.startsWith('https://bookings.innofulfill.com/credit-booking')) return 'SHREE MARUTI';
  return '';
}
function supported(url = '') {
  return !!courierFor(url);
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
    r.onupgradeneeded = (event) => {
      const db = r.result;
      const tx = r.transaction;
      let orders;
      if (!db.objectStoreNames.contains('orders')) {
        orders = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
        orders.createIndex('order_date', 'order_date');
        orders.createIndex('courier', 'courier');
        orders.createIndex('captured_at', 'captured_at');
      } else {
        orders = tx.objectStore('orders');
      }
      // drafts no longer live on disk; drop the old store if it exists
      if (db.objectStoreNames.contains('drafts')) db.deleteObjectStore('drafts');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });

      // unique awb_no — dedupe then create / recreate the index
      if (orders && (event.oldVersion < 5 || !orders.indexNames.contains('awb_no'))) {
        const req = orders.getAll();
        req.onsuccess = () => {
          const all = req.result || [];
          const best = new Map();
          for (const o of all) {
            const awb = String(o.awb_no || '').trim();
            if (!awb) continue;
            const prev = best.get(awb);
            if (!prev || Number(o.captured_at || 0) >= Number(prev.captured_at || 0)) best.set(awb, o);
          }
          for (const o of all) {
            const awb = String(o.awb_no || '').trim();
            if (!awb) continue;
            const keep = best.get(awb);
            if (keep && keep.id !== o.id) orders.delete(o.id);
          }
          if (orders.indexNames.contains('awb_no')) orders.deleteIndex('awb_no');
          orders.createIndex('awb_no', 'awb_no', { unique: true });
        };
      }
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
async function idbGetByIndex(store, indexName, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).index(indexName).get(key);
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


/** Find every saved order with this AWB (index first, then full scan fallback). */
async function findOrdersByAwb(awb) {
  const key = String(awb || '').trim();
  if (!key) return [];
  try {
    const one = await idbGetByIndex('orders', 'awb_no', key);
    if (one) return [one];
  } catch { /* index may be missing on older DBs */ }
  const all = await idbAll('orders');
  return all.filter(o => String(o.awb_no || '').trim() === key);
}

/** Upsert by awb_no so Create Shipment / test submit never duplicates the same AWB. */
async function upsertOrder(order) {
  const awb = String(order.awb_no || '').trim();
  if (awb) {
    const matches = await findOrdersByAwb(awb);
    if (matches.length) {
      matches.sort((a, b) => Number(b.captured_at || 0) - Number(a.captured_at || 0));
      const keep = matches[0];
      for (const extra of matches.slice(1)) {
        if (extra.id != null) await idbDelete('orders', extra.id);
      }
      const locked = { ...(keep._locked || {}), ...(order._locked || {}) };
      const merged = { ...keep, ...order, id: keep.id, awb_no: awb, _locked: locked };
      await idbPut('orders', merged);
      return { upserted: true, id: keep.id };
    }
  }
  const fresh = { ...order };
  delete fresh.id;
  if (awb) fresh.awb_no = awb;
  await idbPut('orders', fresh);
  return { upserted: false };
}

/** Remove any accidental duplicate AWB rows left from older builds. */
async function dedupeOrdersByAwb() {
  const all = await idbAll('orders');
  const best = new Map();
  for (const o of all) {
    const awb = String(o.awb_no || '').trim();
    if (!awb) continue;
    const prev = best.get(awb);
    if (!prev || Number(o.captured_at || 0) >= Number(prev.captured_at || 0)) best.set(awb, o);
  }
  let removed = 0;
  for (const o of all) {
    const awb = String(o.awb_no || '').trim();
    if (!awb) continue;
    const keep = best.get(awb);
    if (keep && keep.id !== o.id) {
      await idbDelete('orders', o.id);
      removed++;
    }
  }
  return removed;
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

/* ---------------- API key + customer id resolve ---------------- */

const SERVER_URL = 'https://server.hisaabsathi.in';

async function getApiKey() {
  const r = await chrome.storage.local.get({ apiKey: '' });
  return String(r.apiKey || '').trim();
}

async function setApiKey(value) {
  const next = String(value || '').trim();
  if (!next) return getApiKey();
  await chrome.storage.local.set({ apiKey: next });
  return next;
}

function readErrorMessage(text) {
  if (!text) return '';
  try {
    const body = JSON.parse(text);
    return String(body?.error?.message || body?.message || '').trim();
  } catch {
    return text.slice(0, 160).trim();
  }
}

async function resolveCustomerId(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { ok: false, customerId: null, error: 'empty name' };
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, customerId: null, error: 'missing api key' };

  try {
    const url = new URL(`${SERVER_URL}/api/v1/orders/customer-id`);
    url.searchParams.set('name', trimmed);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-Api-Key': apiKey,
      },
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = readErrorMessage(text);
      return {
        ok: false,
        customerId: null,
        error: detail || `HTTP ${res.status}`,
        status: res.status,
      };
    }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    const customerId = body?.data?.customerId
      ?? body?.data?.customer_id
      ?? body?.customerId
      ?? body?.customer_id
      ?? null;
    if (customerId == null || String(customerId).trim() === '') {
      return { ok: true, customerId: null };
    }
    return { ok: true, customerId: String(customerId).trim() };
  } catch (e) {
    return { ok: false, customerId: null, error: String(e?.message || e) };
  }
}

/* ---------------- content script plumbing ---------------- */

async function ensureContentScript(tabId, url) {
  if (!tabId || !supported(url)) return false;
  try { const p = await chrome.tabs.sendMessage(tabId, { type: 'HS_PING' }); if (p?.ok) return true; } catch { }
  const files = filesFor(url);
  if (!files.length) return false;
  try { await chrome.scripting.executeScript({ target: { tabId }, files }); return true; } catch { return false; }
}
// The panel stays enabled on every tab — it explains itself when the page is
// not a courier booking form, which beats an action button that does nothing.
async function configureTab(tabId, url) {
  await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true }).catch(() => { });
  if (supported(url)) await ensureContentScript(tabId, url);
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
const autoClientIds = new Map();

function rememberAutoClientId(sessionKey, name, customerId) {
  const n = String(name || '').trim();
  const id = String(customerId || '').trim();
  if (!sessionKey) return;
  if (!n || !id) { autoClientIds.delete(sessionKey); return; }
  autoClientIds.set(sessionKey, { name: n, customerId: id });
}

function applyAutoClientId(row, sessionKey) {
  if (!row) return row;
  const saved = autoClientIds.get(sessionKey);
  if (!saved) return row;
  const name = String(row.client_name || '').trim();
  if (name && name === saved.name && saved.customerId) row.client_id = saved.customerId;
  else if (name && name !== saved.name) autoClientIds.delete(sessionKey);
  return row;
}

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
      const awb = String(msg.order?.awb_no || '').trim();
      // Same AWB already saved → do not recreate a live row that looks like a duplicate
      if (awb) {
        const existingOrders = await findOrdersByAwb(awb);
        if (existingOrders.length) {
          await draftDelete(key);
          notify({ type: 'DRAFT_UPDATED' });
          sendResponse({ ok: true, suppressed: true });
          return;
        }
      }
      const existing = await draftGet(key);
      const fields = Array.isArray(msg.captured_fields) ? msg.captured_fields : Object.keys(msg.order || {});
      const merged = mergeFields(existing, msg.order || {}, fields, msg.authoritative === true);
      merged.courier = msg.order?.courier || existing?.courier || '';
      merged.session_key = key;
      merged.tab_id = tabId;
      merged.status = 'draft';
      merged.order_date = merged.order_date || new Date().toISOString().slice(0, 10);
      merged.updated_at = Date.now();
      applyAutoClientId(merged, key);
      await draftPut(key, merged);
      notify({ type: 'DRAFT_UPDATED' });
      sendResponse({ ok: true });
      return;
    }

    // submitted — only path that writes to IndexedDB; upsert by awb_no
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
      applyAutoClientId(order, key);
      const result = await upsertOrder(order);
      await draftDelete(key);
      notify({ type: 'ORDER_CAPTURED' });
      chrome.tabs.sendMessage(tabId, { type: 'RESET_ORDER_SESSION' }).catch(() => { });
      sendResponse({ ok: true, ...result });
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
      await dedupeOrdersByAwb().catch(() => 0);
      const [orders, drafts] = await Promise.all([idbAll('orders'), draftAll()]);
      const apiKey = await getApiKey();
      for (const d of drafts) applyAutoClientId(d, d.session_key);
      sendResponse({
        ok: true,
        orders,
        drafts,
        enabled: (await chrome.storage.local.get(DEFAULT_SETTINGS)).enabled !== false,
        hasApiKey: !!apiKey
      });
      return;
    }

    if (msg?.type === 'GET_API_KEY') {
      const apiKey = await getApiKey();
      sendResponse({ ok: true, apiKey, hasApiKey: !!apiKey });
      return;
    }

    if (msg?.type === 'SET_API_KEY') {
      const apiKey = await setApiKey(msg.apiKey);
      sendResponse({ ok: true, apiKey, hasApiKey: !!apiKey });
      return;
    }

    if (msg?.type === 'RESOLVE_CUSTOMER_ID') {
      try {
        const result = await resolveCustomerId(msg.name);
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, customerId: null, error: String(e?.message || e) });
      }
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
      if (d) {
        d[msg.key] = msg.value;
        if (msg.lock !== false) {
          d._locked = { ...(d._locked || {}), [msg.key]: true };
        } else if (msg.key === 'client_id') {
          const locked = { ...(d._locked || {}) };
          delete locked.client_id;
          d._locked = locked;
        }
        if (msg.key === 'client_id') rememberAutoClientId(msg.session_key, d.client_name, msg.value);
        if (msg.key === 'client_name' && String(msg.value || '').trim() !== String(autoClientIds.get(msg.session_key)?.name || '')) {
          autoClientIds.delete(msg.session_key);
        }
        d.updated_at = Date.now();
        await draftPut(msg.session_key, d);
      }
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

    // the panel asks this on every tab switch / navigation so it can show
    // whether capture is live on the page in front of the user. The URL rules
    // live here only, so the panel never has to match them a second time.
    if (msg?.type === 'CLASSIFY_URL') {
      const url = String(msg.url || '');
      sendResponse({ ok: true, supported: supported(url), courier: courierFor(url) });
      return;
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
