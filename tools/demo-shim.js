// ===== DEMO SHIM — sandboxes this page from any real login/session/backend =====
// Nothing below ever touches a real signed-in session, a real Google Sheet, or the
// real app's offline storage — it's a fully separate, in-browser sandbox. Loaded
// after app-common.js so these definitions simply override the real ones.
const DEMO_SESSION = {
  userId: 'demo_admin', orgId: 'demo_org', username: 'admin@sunnystores.demo',
  businessName: 'Sunny Stores', fullName: 'Ada Admin', phone: '',
  isAdmin: true, isSuperAdmin: false, roles: [], status: 'active',
  subscriptionStatus: 'active', subscriptionPlan: 'Pro \u00b7 Monthly', billingState: 'trial',
  subscriptionStartDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  subscriptionExpiry: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
  createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
};
function getSession() { return DEMO_SESSION; }
function requireSession() { return DEMO_SESSION; }
function saveSession() { /* demo: no real session is ever stored */ }
function clearSession() { /* demo: nothing to clear -- never touches real login state */ }

const DEMO_USERS = [
  { orgId: 'demo_org', userId: 'demo_admin', username: 'admin@sunnystores.demo', email: 'admin@sunnystores.demo',
    roles: [], isAdmin: true, status: 'active', createdAt: DEMO_SESSION.createdAt },
  { orgId: 'demo_org', userId: 'demo_u1', username: 'chidinma', email: 'chidinma@sunnystores.demo',
    roles: ['Cashier'], isAdmin: false, status: 'active', createdAt: new Date(Date.now() - 20 * 86400000).toISOString() },
  { orgId: 'demo_org', userId: 'demo_u2', username: 'tunde', email: 'tunde@sunnystores.demo',
    roles: ['Inventory / Store Officer', 'Purchasing Officer'], isAdmin: false, status: 'active', createdAt: new Date(Date.now() - 14 * 86400000).toISOString() },
  { orgId: 'demo_org', userId: 'demo_u3', username: 'blessing', email: 'blessing@sunnystores.demo',
    roles: ['Accountant / Finance Officer', 'Auditor / Report Viewer'], isAdmin: false, status: 'suspended', createdAt: new Date(Date.now() - 9 * 86400000).toISOString() }
];

const DEMO_BLOCKED = 'This is a live demo \u2014 start your free trial to do this for real.';
let DEMO_CHAT = [
  { messageId: 'm1', fromUserId: 'demo_u1', fromUsername: 'chidinma', toUserId: '', toLabel: 'Everyone', body: 'Till 2 is out of small change again \ud83d\ude05', createdAt: new Date(Date.now() - 3 * 3600000).toISOString() },
  { messageId: 'm2', fromUserId: 'demo_admin', fromUsername: 'admin@sunnystores.demo', toUserId: '', toLabel: 'Everyone', body: 'Noted, sending change over now.', createdAt: new Date(Date.now() - 3 * 3600000 + 60000).toISOString() }
];

// Replaces the real network client entirely -- every "backend" action below is mocked,
// so this page never calls the real Apps Script API.
async function apiCall(action, params) {
  await new Promise((r) => setTimeout(r, 200)); // feel like a real round trip
  switch (action) {
    case 'getUsers': return { ok: true, users: DEMO_USERS };
    case 'getPublicSettings': return { ok: true, settings: {
        supportEmail: SUPPORT_EMAIL_DEFAULT, supportPhone: SUPPORT_PHONE_DEFAULT, supportWebsite: SUPPORT_WEBSITE_DEFAULT,
        manualPaymentMethods: MANUAL_PAYMENT_METHODS_DEFAULT, planCatalog: PLAN_CATALOG_DEFAULT, trialDays: 7, reminderDaysBeforeDue: 3,
        paystackEnabled: false, paystackPublicKey: '', flutterwaveEnabled: false, flutterwavePublicKey: '', remitaEnabled: false,
        smsEnabled: false, whatsappEnabled: false,
        brandPrimaryColor: '', brandAccentColor: '', brandLogoUrl: '', brandTagline: ''
      } };
    case 'getTeamNames': return { ok: true, names: DEMO_USERS.map(u => ({ userId: u.userId, username: u.username, roles: u.roles })) };
    case 'getSubscriptionStatus': return { ok: true, subscription: { active: true, plan: DEMO_SESSION.subscriptionPlan, billingState: 'trial', startDate: DEMO_SESSION.subscriptionStartDate, expiry: DEMO_SESSION.subscriptionExpiry, daysLeft: 4, expired: false } };
    case 'syncPull': return { ok: true, records: [], serverTime: new Date().toISOString() };
    case 'syncPush': return { ok: true, applied: (params.records || []).map(r => ({ recordId: r.recordId, updatedAt: new Date().toISOString() })), serverTime: new Date().toISOString() };
    case 'getInternalMessages': return { ok: true, messages: DEMO_CHAT };
    case 'sendInternalMessage':
      DEMO_CHAT.push({ messageId: 'm' + (DEMO_CHAT.length + 1), fromUserId: DEMO_SESSION.userId, fromUsername: DEMO_SESSION.username, toUserId: params.toUserId || '', toLabel: params.toUserId ? (DEMO_USERS.find(u => u.userId === params.toUserId) || {}).username : 'Everyone', body: params.body, createdAt: new Date().toISOString() });
      return { ok: true };
    case 'sendEmailMessage': case 'sendSmsMessage': case 'sendWhatsappMessage':
    case 'adminCreateUser': case 'adminEditUser': case 'adminDeleteUser':
    case 'adminSetUserPassword': case 'adminSetUserStatus': case 'changePassword':
    case 'submitPaymentProof': case 'initPaystackPayment':
      return { ok: false, error: DEMO_BLOCKED };
    case 'getPaymentSubmissions':
      return { ok: true, submissions: [] };
    default:
      return { ok: false, error: DEMO_BLOCKED };
  }
}

// Gives the demo its own private offline database (separate from the real app's), so
// trying products/scanning/POS/sales here feels completely real without ever touching
// a real signed-in user's actual data on the same device/browser.
let _demoDbPromise = null;
function openDb() {
  if (_demoDbPromise) return _demoDbPromise;
  _demoDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('okv_biztrack_demo', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        const store = db.createObjectStore('records', { keyPath: 'recordId' });
        store.createIndex('type', 'type');
        store.createIndex('dirty', 'dirty');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _demoDbPromise;
}

function requestNotificationPermission() { return Promise.resolve(); } // skip prompting in a demo

// Seeds a starter catalog + a few records once per browser, only into the demo's own database.
async function clearDemoDb() {
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction(['records', 'meta'], 'readwrite');
    tx.objectStore('records').clear(); tx.objectStore('meta').clear();
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function seedDemoData() {
  await clearDemoDb(); // every visit starts from the same clean sample business, dated relative to today
  const products = [
    { name: 'Rice (50kg bag)', barcode: '6001234500019', unit: 'bag', price: '45000', qty: 40, reorderLevel: 10, category: 'Groceries' },
    { name: 'Coca-Cola 50cl', barcode: '6001234500026', unit: 'bottle', price: '350', qty: 150, reorderLevel: 30, category: 'Beverages' },
    { name: 'Indomie Carton', barcode: '6001234500033', unit: 'carton', price: '8500', qty: 25, reorderLevel: 10, category: 'Groceries' },
    { name: 'Peak Milk Tin', barcode: '6001234500040', unit: 'tin', price: '1200', qty: 8, reorderLevel: 15, category: 'Groceries' },
    { name: 'Cooking Gas 12.5kg', barcode: '6001234500057', unit: 'refill', price: '13500', qty: 12, reorderLevel: 5, category: 'Household' }
  ];
  for (const p of products) await saveProduct(p);
  await saveLocalRecord('Sale', { date: todayStr(), customer: 'Grace Adeyemi', product: 'Coca-Cola 50cl', qty: 12, unitPrice: 350, total: 4200, paid: 4200, balance: 0, status: 'Paid', cashier: 'Chidinma' });
  await saveLocalRecord('Sale', { date: todayStr(), customer: 'Emeka Nwosu', product: 'Rice (50kg bag)', qty: 1, unitPrice: 45000, total: 45000, paid: 20000, balance: 25000, status: 'Partial', cashier: 'Chidinma' });
  await saveLocalRecord('Sale', { date: todayStr(-1), customer: 'Grace Adeyemi', product: 'Cooking Gas 12.5kg', qty: 1, unitPrice: 13500, total: 13500, paid: 0, balance: 13500, status: 'Unpaid', cashier: '' });
  await saveLocalRecord('Expense', { date: todayStr(), category: 'Transport', description: 'Delivery bike fuel', amount: 3000, paidBy: 'Cash' });
  await saveLocalRecord('Purchase', { date: todayStr(-2), supplier: 'CocaBev Distributors', product: 'Coca-Cola 50cl', qty: 100, unitPrice: 280, total: 28000, paid: 28000, balance: 0, status: 'Paid' });
  await saveLocalRecord('Customer', { name: 'Grace Adeyemi', email: 'grace.a@gmail.com', phone: '+2348011112222', note: 'Regular weekly restock buyer' });
  await saveLocalRecord('Customer', { name: 'Emeka Nwosu', email: '', phone: '+2348123334444', note: 'Pays on credit, settles weekly' });
  await saveLocalRecord('Supplier', { name: 'CocaBev Distributors', email: 'orders@cocabev.example', phone: '+2348033334444', note: 'Beverage supplier' });
}
const DEMO_READY = seedDemoData().catch(() => {});
