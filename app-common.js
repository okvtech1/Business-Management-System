// ===== OKV Business Management System — Phase 2 shared helpers =====

// Paste your Apps Script Web App /exec URL here after deployment.
const API_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';

// ---------- plan catalog (shared by pricing.html, signup.html, dashboard.html) ----------
// These are only the fallback shown before loadLiveSettings() pulls the real, Super-Admin-
// editable catalog. Prices are illustrative placeholders in that fallback.
const PLAN_CATALOG_DEFAULT = [
  { id: 'starter-monthly', tier: 'Starter', cycle: 'Monthly', amount: 4500, priceLabel: '₦4,500/mo', billedNote: 'Billed monthly',
    suited: 'Solo shop owners, single-till kiosks, and campus vendors just starting out.',
    features: ['1 Admin + up to 2 team members', 'Sales, expense & purchase recording', 'Cashier & Sales/POS roles', 'Offline-first app with auto-sync', 'Email support'] },
  { id: 'pro-monthly', tier: 'Pro', cycle: 'Monthly', amount: 9500, priceLabel: '₦9,500/mo', billedNote: 'Billed monthly',
    suited: 'Growing retail shops and multi-staff businesses that need full role separation and reporting.',
    features: ['1 Admin + up to 10 team members', 'All 8 role types (Sales, Inventory, Purchasing, Accountant, Auditor…)', 'Advanced reports & audit trail', 'Offline-first app with auto-sync', 'Priority support'] },
  { id: 'starter-biannual', tier: 'Starter', cycle: 'Bi-Annual', amount: 24000, priceLabel: '₦24,000 / 6 months', billedNote: '≈₦4,000/mo · Save 11%',
    suited: 'Solo shop owners and small vendors who want a better rate for committing 6 months.',
    features: ['1 Admin + up to 2 team members', 'Sales, expense & purchase recording', 'Cashier & Sales/POS roles', 'Offline-first app with auto-sync', 'Email support'] },
  { id: 'pro-biannual', tier: 'Pro', cycle: 'Bi-Annual', amount: 51000, priceLabel: '₦51,000 / 6 months', billedNote: '≈₦8,500/mo · Save 11%',
    suited: 'Growing multi-staff businesses ready to commit 6 months for a lower rate.',
    features: ['1 Admin + up to 10 team members', 'All 8 role types (Sales, Inventory, Purchasing, Accountant, Auditor…)', 'Advanced reports & audit trail', 'Offline-first app with auto-sync', 'Priority support'] },
  { id: 'starter-yearly', tier: 'Starter', cycle: 'Yearly', amount: 43000, priceLabel: '₦43,000 / year', billedNote: '≈₦3,583/mo · Save 20%',
    suited: 'Established solo businesses that know they\'ll be using the system long-term.',
    features: ['1 Admin + up to 2 team members', 'Sales, expense & purchase recording', 'Cashier & Sales/POS roles', 'Offline-first app with auto-sync', 'Email support'] },
  { id: 'pro-yearly', tier: 'Pro', cycle: 'Yearly', amount: 91000, priceLabel: '₦91,000 / year', billedNote: '≈₦7,583/mo · Save 20%',
    suited: 'Established multi-staff businesses that want the best rate and full features year-round.',
    features: ['1 Admin + up to 10 team members', 'All 8 role types (Sales, Inventory, Purchasing, Accountant, Auditor…)', 'Advanced reports & audit trail', 'Offline-first app with auto-sync', 'Priority support'] }
];
let PLAN_CATALOG = PLAN_CATALOG_DEFAULT;
function getPlanById(id) { return PLAN_CATALOG.find(p => p.id === id) || null; }
// Looks up a plan by its stored display label (e.g. "Pro · Yearly") rather than reconstructing
// an id by slugifying the label — safe for any tier name, including ones with spaces.
function getPlanByLabel(label) { return PLAN_CATALOG.find(p => (p.tier + ' · ' + p.cycle) === label) || null; }

// Escapes untrusted text before it's interpolated into an innerHTML template string. Anything
// that ultimately came from a public form (signup's business/full name, a team member's typed
// product/customer name, a chat message body, etc.) must go through this before rendering —
// otherwise a malicious signup could inject a script that runs in another user's browser
// (including the Super Admin's) the moment that data is displayed.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function planDisplayName(planStr) {
  // planStr as stored on the Users row, e.g. "Starter · Monthly"
  return planStr || 'Starter · Monthly';
}

// ---------- OKV Technology Consults contact + payment details ----------
// These are defaults shown until loadLiveSettings() (below) pulls the real, editable
// values from the Settings sheet — which the Super Admin dashboard can update any time.
const SUPPORT_EMAIL_DEFAULT = 'technologyokv@gmail.com';
const SUPPORT_PHONE_DEFAULT = '+2348104141138';
const SUPPORT_WEBSITE_DEFAULT = 'www.okvtechnology.com';
const MANUAL_PAYMENT_METHODS_DEFAULT = [
  { id: 'default', label: 'Bank transfer', bank: 'OPay MFB', accountNumber: '8104141138', accountName: 'Olasile Kehinde Victor', instructions: '', enabled: true }
];
let SUPPORT_EMAIL = SUPPORT_EMAIL_DEFAULT;
let SUPPORT_PHONE = SUPPORT_PHONE_DEFAULT;
let SUPPORT_WEBSITE = SUPPORT_WEBSITE_DEFAULT;
let MANUAL_PAYMENT_METHODS = MANUAL_PAYMENT_METHODS_DEFAULT;
let PAYSTACK_ENABLED = false;
let PAYSTACK_PUBLIC_KEY = '';
let FLUTTERWAVE_ENABLED = false;
let REMITA_ENABLED = false;
let SMS_ENABLED = false;
let WHATSAPP_ENABLED = false;
let BRAND_PRIMARY_COLOR = '';
let BRAND_ACCENT_COLOR = '';
let BRAND_LOGO_URL = '';
let BRAND_TAGLINE = '';
let REMINDER_DAYS_BEFORE_DUE = 3; // dashboard's "due soon" badge/banner threshold, Super-Admin-editable

// Pulls every live, Super-Admin-editable value (contact info, payment methods, gateway
// availability, plan catalog, branding) — falls back to the defaults above if offline or the
// Settings sheet is empty. Call once on page load before rendering anything that depends on
// these; safe to call again any time to refresh. Also applies branding (colors/logo) to the page.
async function loadLiveSettings() {
  if (!navigator.onLine) return false;
  try {
    const res = await apiCall('getPublicSettings', {});
    if (res.ok && res.settings) {
      const s = res.settings;
      SUPPORT_EMAIL = s.supportEmail || SUPPORT_EMAIL_DEFAULT;
      SUPPORT_PHONE = s.supportPhone || SUPPORT_PHONE_DEFAULT;
      SUPPORT_WEBSITE = s.supportWebsite || SUPPORT_WEBSITE_DEFAULT;
      MANUAL_PAYMENT_METHODS = (Array.isArray(s.manualPaymentMethods) && s.manualPaymentMethods.length) ? s.manualPaymentMethods : MANUAL_PAYMENT_METHODS_DEFAULT;
      PLAN_CATALOG = (Array.isArray(s.planCatalog) && s.planCatalog.length) ? s.planCatalog : PLAN_CATALOG_DEFAULT;
      PAYSTACK_ENABLED = !!s.paystackEnabled;
      PAYSTACK_PUBLIC_KEY = s.paystackPublicKey || '';
      FLUTTERWAVE_ENABLED = !!s.flutterwaveEnabled;
      REMITA_ENABLED = !!s.remitaEnabled;
      SMS_ENABLED = !!s.smsEnabled;
      WHATSAPP_ENABLED = !!s.whatsappEnabled;
      BRAND_PRIMARY_COLOR = s.brandPrimaryColor || '';
      BRAND_ACCENT_COLOR = s.brandAccentColor || '';
      BRAND_LOGO_URL = s.brandLogoUrl || '';
      BRAND_TAGLINE = s.brandTagline || '';
      REMINDER_DAYS_BEFORE_DUE = Number(s.reminderDaysBeforeDue) || 3;
      applyBranding();
      return true;
    }
  } catch (e) { /* keep defaults */ }
  return false;
}

// Applies the live color palette + logo to this page. Colors are CSS custom properties, so this
// is instant and needs no page-specific markup; the logo replaces every ".mark" brand icon found.
function applyBranding() {
  const root = document.documentElement.style;
  if (BRAND_PRIMARY_COLOR) { root.setProperty('--teal', BRAND_PRIMARY_COLOR); root.setProperty('--teal-2', BRAND_PRIMARY_COLOR); }
  if (BRAND_ACCENT_COLOR) root.setProperty('--gold', BRAND_ACCENT_COLOR);
  if (BRAND_LOGO_URL) {
    document.querySelectorAll('.mark').forEach(el => {
      el.innerHTML = '';
      el.style.background = 'transparent';
      const img = document.createElement('img');
      img.src = BRAND_LOGO_URL;
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:inherit';
      el.appendChild(img);
    });
  }
}

// ---------- friendly "time remaining" formatting ----------
function friendlyDuration(days) {
  if (days === null || days === undefined) return '—';
  if (days < 0) return Math.abs(days) + ' day' + (Math.abs(days) === 1 ? '' : 's') + ' overdue';
  if (days === 0) return 'due today';
  if (days < 14) return days + ' day' + (days === 1 ? '' : 's') + ' remaining';
  if (days < 60) { const w = Math.round(days / 7); return days + ' days (about ' + w + ' week' + (w === 1 ? '' : 's') + ') remaining'; }
  const m = Math.round(days / 30);
  return days + ' days (about ' + m + ' month' + (m === 1 ? '' : 's') + ') remaining';
}

// ---------- modal helper: dimmed, click-outside-to-close, keyboard-safe on mobile ----------
function openModal(innerHtml) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal-card">${innerHtml}</div>`;
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdrop); });
  document.body.appendChild(backdrop);
  return backdrop;
}
function closeModal(backdrop) { if (backdrop && backdrop.parentNode) backdrop.remove(); }

// ---------- optional image upload: resize/compress before storing ----------
// Keeps product photos small enough for IndexedDB + a Google Sheets cell (which caps
// around 50,000 characters), and keeps sync payloads light on slow connections.
function compressImageToDataUrl(file, maxDim, quality) {
  maxDim = maxDim || 320; quality = quality || 0.7;
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- barcode scanning ----------
// Two ways in, both feed the same onCode(code) callback:
// 1) A text input that a USB/Bluetooth laser scanner can "type" into (scanners act as a
//    keyboard and send the code + Enter) — works on every device, no camera needed.
// 2) The browser's built-in BarcodeDetector for camera scanning on phones/tablets —
//    supported on Chrome/Android; not on iOS Safari, which is why option 1 always ships too.
function wireHardwareScannerInput(inputEl, onCode) {
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && inputEl.value.trim()) {
      e.preventDefault();
      const code = inputEl.value.trim();
      inputEl.value = '';
      onCode(code);
    }
  });
}
function barcodeDetectorSupported() { return 'BarcodeDetector' in window; }
let _scanStream = null;
async function startCameraScan(videoEl, onCode, onError) {
  try {
    _scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    videoEl.srcObject = _scanStream;
    await videoEl.play();
    const detector = new BarcodeDetector();
    let stop = false;
    videoEl._stopScan = () => { stop = true; };
    (async function loop() {
      while (!stop) {
        try {
          const codes = await detector.detect(videoEl);
          if (codes.length) { onCode(codes[0].rawValue); break; }
        } catch (e) { /* ignore single-frame errors */ }
        await new Promise(r => setTimeout(r, 250));
      }
    })();
  } catch (e) {
    if (onError) onError(e);
  }
}
function stopCameraScan(videoEl) {
  if (videoEl && videoEl._stopScan) videoEl._stopScan();
  if (_scanStream) { _scanStream.getTracks().forEach(t => t.stop()); _scanStream = null; }
}

// ---------- products (stored as records of type 'Product') ----------
async function getProducts() {
  const all = await idbGetAll('records');
  return all.filter(r => r.type === 'Product' && !r.deleted).map(r => ({ ...r, data: JSON.parse(r.payload || '{}') }));
}
async function findProductByBarcode(barcode) {
  const products = await getProducts();
  return products.find(p => p.data.barcode === barcode) || null;
}
async function saveProduct(data, existingRecordId) {
  return saveLocalRecord('Product', data, existingRecordId);
}

// ---------- crypto ----------
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- API ----------
async function apiCall(action, params) {
  const body = Object.assign({ action }, params || {});
  const session = getSession();
  if (session && !body.userId) { body.userId = session.userId; body.authToken = session.authToken; }
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight on Apps Script
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: 'network', offline: true };
  }
}

// ---------- session ----------
const SESSION_KEY = 'okv_session';
function saveSession(authToken, user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ authToken, ...user }));
}
function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
}
function clearSession() { localStorage.removeItem(SESSION_KEY); }
function requireSession(redirectTo) {
  const s = getSession();
  if (!s) { window.location.href = redirectTo || 'login.html'; return null; }
  return s;
}

// ---------- toast ----------
function toast(msg, kind) {
  let el = document.getElementById('okv-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'okv-toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'background:#0f2f3c;color:#fff;padding:12px 18px;border-radius:10px;font:14px system-ui;' +
      'z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:90vw;text-align:center;transition:opacity .3s';
    document.body.appendChild(el);
  }
  el.style.background = kind === 'error' ? '#7a2222' : (kind === 'ok' ? '#1c5f43' : '#0f2f3c');
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 3200);
}

// ---------- connectivity ----------
function isOnline() { return navigator.onLine; }
function onConnectivityChange(cb) {
  window.addEventListener('online', () => cb(true));
  window.addEventListener('offline', () => cb(false));
}

// ---------- IndexedDB (offline record cache + outbox) ----------
const DB_NAME = 'okv_biztrack_online';
const DB_VERSION = 1;
let _dbPromise = null;
function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        const store = db.createObjectStore('records', { keyPath: 'recordId' });
        store.createIndex('type', 'type');
        store.createIndex('dirty', 'dirty');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}
async function idbPut(storeName, val) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(val);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGetAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGetOne(storeName, key) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}
async function idbGetMeta(key) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => resolve(null);
  });
}
async function idbSetMeta(key, value) { return idbPut('meta', { key, value }); }

// Save a record locally and mark it dirty (queued for push).
async function saveLocalRecord(type, payloadObj, existingRecordId) {
  const recordId = existingRecordId || ('rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  const existing = existingRecordId ? await idbGetOne('records', existingRecordId) : null;
  const now = new Date().toISOString();
  const rec = {
    recordId, type, payload: JSON.stringify(payloadObj),
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now, deleted: false, dirty: true
  };
  await idbPut('records', rec);
  return recordId;
}
async function deleteLocalRecord(recordId, type) {
  const existing = await idbGetOne('records', recordId);
  const rec = {
    recordId, type, payload: '{}',
    createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(), deleted: true, dirty: true
  };
  await idbPut('records', rec);
}

// ---------- CSV helpers (export/import/backup — shared by every data list) ----------
// Escapes one value for CSV: wraps in quotes (doubling any internal quotes) whenever the
// value contains a comma, quote, or newline — otherwise left plain, matching how Excel/
// Google Sheets/Numbers write CSV, so round-tripping through any of them works cleanly.
function csvEscape(v) {
  if (v === undefined || v === null) v = '';
  v = String(v);
  if (/[",\n\r]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
  return v;
}
// Parses CSV text (RFC4180-ish: quoted fields, escaped "" quotes, commas/newlines inside
// quotes) into an array of row-arrays. Works for anything exported by Excel, Google Sheets,
// or this app's own Export CSV buttons.
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* ignore — \n (or the loop end) closes the row */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}
// Triggers a browser download of in-memory text as a file — used for CSV/JSON exports,
// templates, and backups. No server round-trip; works fully offline.
function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- sync engine ----------
async function syncNow(silent) {
  const session = getSession();
  if (!session) return { ok: false, error: 'not-logged-in' };
  if (!isOnline()) { if (!silent) toast('You are offline — will sync when reconnected.', 'error'); return { ok: false, offline: true }; }

  // 1) push dirty local records
  const all = await idbGetAll('records');
  const dirty = all.filter(r => r.dirty);
  if (dirty.length) {
    const res = await apiCall('syncPush', { records: dirty.map(({ recordId, type, payload, deleted, createdAt }) => ({ recordId, type, payload, deleted, createdAt })) });
    if (res.ok) {
      for (const applied of res.applied) {
        const rec = dirty.find(d => d.recordId === applied.recordId);
        if (rec) { rec.dirty = false; rec.updatedAt = applied.updatedAt; await idbPut('records', rec); }
      }
    } else if (!res.offline) {
      if (!silent) toast('Sync push failed: ' + (res.error || 'unknown error'), 'error');
    }
  }

  // 2) pull changes since last cursor
  const since = (await idbGetMeta('lastSync')) || '1970-01-01T00:00:00.000Z';
  const pullRes = await apiCall('syncPull', { since });
  if (pullRes.ok) {
    for (const r of pullRes.records) {
      await idbPut('records', { ...r, dirty: false });
    }
    await idbSetMeta('lastSync', pullRes.serverTime);
    if (!silent && (dirty.length || pullRes.records.length)) {
      notify('Synced', dirty.length + ' change(s) sent, ' + pullRes.records.length + ' received.');
    }
    // Lets whichever page is open react to new/changed data — e.g. the dashboard re-computing
    // its stat cards and charts — even from a silent background sync, since that's exactly what
    // makes it feel "realtime" instead of only updating after a manual refresh or re-navigation.
    if ((dirty.length || pullRes.records.length) && typeof window.onOkvDataChanged === 'function') {
      try { window.onOkvDataChanged({ pushed: dirty.length, pulled: pullRes.records.length }); } catch (e) { /* never let a page's hook break sync itself */ }
    }
    return { ok: true, pushed: dirty.length, pulled: pullRes.records.length };
  } else if (!pullRes.offline && !silent) {
    toast('Sync pull failed: ' + (pullRes.error || 'unknown error'), 'error');
  }
  return { ok: false };
}

function notify(title, body) {
  toast(title + ': ' + body, 'ok');
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icons/icon-192.png' }); } catch (e) {}
  }
}
async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch (e) {}
  }
}

let _autoSyncTimer = null;
function startAutoSync(intervalMs) {
  stopAutoSync();
  onConnectivityChange((online) => { if (online) syncNow(false); });
  _autoSyncTimer = setInterval(() => syncNow(true), intervalMs || 60000);
  if (isOnline()) syncNow(true);
}
function stopAutoSync() { if (_autoSyncTimer) clearInterval(_autoSyncTimer); }

// ---------- PWA install prompt ----------
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  document.dispatchEvent(new CustomEvent('okv-install-available'));
});
async function triggerInstall() {
  if (!_deferredInstallPrompt) return false;
  _deferredInstallPrompt.prompt();
  const choice = await _deferredInstallPrompt.userChoice;
  _deferredInstallPrompt = null;
  return choice.outcome === 'accepted';
}
function isIos() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// ---------- password show/hide toggle ----------
// Wraps a <input type="password"> in a positioned container and adds an eye icon button
// that flips it to type="text" and back. Call once per password field after it's in the
// DOM, e.g. wirePasswordToggle(document.getElementById('password')). Safe to call more
// than once on the same input — it no-ops if already wired.
function wirePasswordToggle(input) {
  if (!input || input._pwToggleWired) return;
  input._pwToggleWired = true;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.style.paddingRight = '42px';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Show password');
  btn.tabIndex = -1;
  btn.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);' +
    'background:none;border:none;padding:6px;width:30px;height:30px;display:flex;' +
    'align-items:center;justify-content:center;cursor:pointer;color:#736b5a;border-radius:8px;';
  const eyeOpen = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeOff = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.6 21.6 0 0 1 5.06-5.94M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 7 11 7a21.6 21.6 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  btn.innerHTML = eyeOpen;
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.innerHTML = showing ? eyeOpen : eyeOff;
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
  wrap.appendChild(btn);
}
// Wires every password field currently on the page — safe to run on any page, including
// ones with no password fields.
function wireAllPasswordToggles() {
  document.querySelectorAll('input[type=password]').forEach(wirePasswordToggle);
}
// Auto-wires the eye icon onto every password field on every page automatically — including
// ones added later by dashboard.html/super-admin.html's dynamic tab/modal rendering (Add team
// member, Set user password, Change password, etc.) — so no page or render function needs to
// remember to call this itself.
(function () {
  function start() {
    wireAllPasswordToggles();
    new MutationObserver((mutations) => {
      mutations.forEach((m) => m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches && node.matches('input[type=password]')) wirePasswordToggle(node);
        if (node.querySelectorAll) node.querySelectorAll('input[type=password]').forEach(wirePasswordToggle);
      }));
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
