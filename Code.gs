/**
 * OKV Business Management System — Phase 2 (Online / Subscribe) backend.
 * Deploy as Web App. This spreadsheet (the one this script is bound to) is the
 * MASTER/CONTROL spreadsheet. Its sheets: "Users", "Messages", "PaymentSubmissions",
 * "Settings", "Registry", "CapacityHistory".
 *
 * MULTI-TENANT ARCHITECTURE (per-tenant spreadsheets):
 * Each org's transactional business data ("Data" tab — Products/Sales/Records/
 * Customers/Suppliers) lives in its OWN spreadsheet, created automatically at signup.
 * This master spreadsheet never holds that transactional data — it only holds the
 * "Registry" sheet mapping orgId -> that tenant spreadsheet's ID/URL, plus capacity
 * stats. Backend code never assumes "the active spreadsheet" for tenant data — it
 * always resolves a tenant's spreadsheet dynamically via getOrgSpreadsheet(orgId).
 * See the "MULTI-TENANT SPREADSHEETS" section below for the mechanics, and README.md
 * for one-time setup (creating the Registry/CapacityHistory sheets, running the
 * migration, and installing the weekly capacity-check trigger).
 *
 * All requests are POST with JSON body: { action: "...", ...params }
 * Response is always JSON: { ok: true, ... } or { ok: false, error: "..." }
 */

const SS = SpreadsheetApp.getActiveSpreadsheet();
const USERS_SHEET = 'Users';
const DATA_SHEET = 'Data'; // legacy: the master spreadsheet's OLD single shared Data tab (pre-migration). Read-only, used only by the migration helpers below.
const MESSAGES_SHEET = 'Messages';
const PAYMENTS_SHEET = 'PaymentSubmissions';
const SETTINGS_SHEET = 'Settings';
const REGISTRY_SHEET = 'Registry';
const CAPACITY_HISTORY_SHEET = 'CapacityHistory';
const TENANT_DATA_SHEET = 'Data'; // the name of the Data tab INSIDE each per-tenant spreadsheet
const CELL_LIMIT = 10000000; // Google Sheets' hard per-file cell limit, summed across all tabs

// ---- OKV Technology Consults contact + payment details are now stored in the Settings
// sheet and editable from the Super Admin dashboard — see getSettings() below and
// DEFAULT_SETTINGS above, which is only the fallback used before the sheet has values.

// ---- Column headers (source of truth — column index is derived, never hand-counted) ----
const USER_HEADERS = [
  'orgId', 'userId', 'username', 'email', 'phone', 'businessName', 'fullName', 'passwordHash',
  'roles', 'isAdmin', 'isSuperAdmin', 'status', 'orgSuspended',
  'subscriptionStatus', 'subscriptionPlan', 'billingState', 'subscriptionStartDate', 'subscriptionExpiry',
  'reminderSentAt', 'resetToken', 'resetTokenExpiry', 'authToken', 'createdAt'
];
const DATA_HEADERS = ['orgId', 'recordId', 'userId', 'type', 'payload', 'updatedAt', 'deleted', 'createdAt']; // legacy master "Data" tab shape (pre-migration) — still used to read old rows during migration
const MESSAGE_HEADERS = ['orgId', 'messageId', 'fromUserId', 'fromUsername', 'toUserId', 'toLabel', 'body', 'createdAt'];
const PAYMENT_HEADERS = [
  'orgId', 'submissionId', 'submittedByUserId', 'businessName', 'email', 'phone',
  'planRequested', 'screenshotDataUrl', 'status', 'submittedAt', 'decidedAt', 'decisionNote'
];
const SETTINGS_HEADERS = ['key', 'value'];

// Per-tenant spreadsheet's "Data" tab shape — no orgId column, since each tenant
// spreadsheet belongs to exactly one org already (one less column = less cell usage).
const TENANT_DATA_HEADERS = ['recordId', 'userId', 'type', 'payload', 'updatedAt', 'deleted', 'createdAt'];

// Master "Registry" sheet — the ONLY place that maps an orgId to its tenant spreadsheet,
// plus the capacity stats the Super Admin dashboard's Storage tab reads.
const REGISTRY_HEADERS = [
  'orgId', 'businessName', 'spreadsheetId', 'spreadsheetUrl', 'createdAt',
  'cellsUsed', 'cellLimit', 'pctUsed', 'growthCellsPerDay', 'estDaysRemaining',
  'estReadableRemaining', 'statusFlag', 'recommendedAction', 'lastCheckedAt', 'actionAlertSentAt'
];
// Master "CapacityHistory" sheet — one row per tenant per capacity check, used only to
// compute a growth rate (rows added per day) from recent checks. Self-trims to ~180 days.
const CAPACITY_HISTORY_HEADERS = ['orgId', 'checkedAt', 'cellsUsed'];

function colMap(headers) { const m = {}; headers.forEach((h, i) => m[h] = i + 1); return m; }
const U = colMap(USER_HEADERS);
const D = colMap(DATA_HEADERS);
const TD = colMap(TENANT_DATA_HEADERS);
const M = colMap(MESSAGE_HEADERS);
const P = colMap(PAYMENT_HEADERS);
const ST = colMap(SETTINGS_HEADERS);
const R = colMap(REGISTRY_HEADERS);

// Default settings — used until the Settings sheet has rows (or as fallback if a value is
// blank there). The Super Admin dashboard's Settings tab edits the live values. Anything here
// that is a *secret* (API keys/tokens) is NEVER returned by handleGetPublicSettings — only by
// handleSuperAdminGetSettings, which requires Super Admin auth. See PUBLIC_SETTINGS_KEYS below.
const DEFAULT_SETTINGS = {
  // Contact
  supportEmail: 'technologyokv@gmail.com',
  supportPhone: '+2348104141138',
  supportWebsite: 'www.okvtechnology.com',
  // Branding
  brandPrimaryColor: '#0f3d3e',
  brandAccentColor: '#c98a2c',
  brandLogoUrl: '',
  brandTagline: 'Track sales, stock, and staff — online or off.',
  // Outbound email display name/reply-to for emails OKV Technology Consults itself sends to
  // org admins (payment confirmations, reminders, password resets, announcements) — MailApp
  // still sends from the script owner's Google account, so this only controls the display name
  // and reply-to. NEVER used for an org admin's own emails to their customers — see
  // sendOrgEmail() in Code.gs, which uses that org's own business name instead. Edit these two
  // any time from this Settings tab if your management-system name or contact email changes.
  emailFromName: 'OKV Business Management System',
  emailReplyTo: 'technologyokv@gmail.com',
  // SMS gateway (Termii-shaped by default; swap sendSmsViaProvider() for a different provider)
  smsProvider: 'termii',
  smsApiKey: '',
  smsSenderId: 'OKVBMS',
  // WhatsApp (Meta Cloud API)
  whatsappToken: '',
  whatsappPhoneId: '',
  // Manual payment methods — JSON array of { id, label, bank, accountNumber, accountName, instructions, enabled }
  manualPaymentMethods: JSON.stringify([
    { id: 'default', label: 'Bank transfer', bank: 'OPay MFB', accountNumber: '8104141138', accountName: 'Olasile Kehinde Victor', instructions: '', enabled: true }
  ]),
  // Payment gateways — enter keys to enable. Only Paystack has a working checkout+verify flow
  // wired in this build; Flutterwave/Remita keys are captured and stored ready for the same
  // treatment (see README).
  paystackEnabled: false, paystackPublicKey: '', paystackSecretKey: '',
  flutterwaveEnabled: false, flutterwavePublicKey: '', flutterwaveSecretKey: '',
  remitaEnabled: false, remitaMerchantId: '', remitaApiKey: '',
  // Plans shown on pricing.html / signup.html / dashboard upgrade cards. `amount` is the raw
  // Naira price (used by the Paystack gateway to compute kobo) — priceLabel/billedNote are just
  // for display and can say whatever you like (e.g. "Save 20%").
  planCatalog: JSON.stringify([
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
  ]),
  // Other tunables the Super Admin can control without touching code
  trialDays: 7,
  reminderIntervalDays: 15, // "twice a month" cadence for the reminder email
  reminderDaysBeforeDue: 3
};

// Keys handleGetPublicSettings is allowed to return, unauthenticated. Secrets (API keys/tokens/
// the Paystack *secret* key) are deliberately excluded — only handleSuperAdminGetSettings
// (Super Admin auth required) returns those, for the Settings tab's edit form.
const PUBLIC_SETTINGS_KEYS = [
  'supportEmail', 'supportPhone', 'supportWebsite',
  'brandPrimaryColor', 'brandAccentColor', 'brandLogoUrl', 'brandTagline',
  'manualPaymentMethods', 'planCatalog', 'trialDays', 'reminderDaysBeforeDue',
  'paystackEnabled', 'paystackPublicKey', // Paystack's *public* key is meant to be client-side
  'flutterwaveEnabled', 'flutterwavePublicKey',
  'remitaEnabled'
];
const RESET_TOKEN_TTL_MIN = 30;
const VALID_ROLES = [
  'Business Owner / Super Admin', 'Business Manager', 'Sales / POS Officer',
  'Inventory / Store Officer', 'Purchasing Officer', 'Accountant / Finance Officer',
  'Cashier', 'Auditor / Report Viewer'
];
// Roles allowed to message customers/suppliers on the org's behalf, besides the Admin.
const CUSTOMER_MESSAGING_ROLES = ['Business Manager', 'Sales / POS Officer', 'Accountant / Finance Officer'];

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ ok: false, error: 'Bad request body' });
  }
  const action = body.action;
  try {
    switch (action) {
      case 'signup': return jsonOut(handleSignup(body));
      case 'login': return jsonOut(handleLogin(body));
      case 'forgotPassword': return jsonOut(handleForgotPassword(body));
      case 'validateResetToken': return jsonOut(handleValidateResetToken(body));
      case 'resetPassword': return jsonOut(handleResetPassword(body));
      case 'changePassword': return jsonOut(handleChangePassword(body));
      case 'adminCreateUser': return jsonOut(handleAdminCreateUser(body));
      case 'adminEditUser': return jsonOut(handleAdminEditUser(body));
      case 'adminDeleteUser': return jsonOut(handleAdminDeleteUser(body));
      case 'adminSetUserPassword': return jsonOut(handleAdminSetUserPassword(body));
      case 'adminSetUserStatus': return jsonOut(handleAdminSetUserStatus(body));
      case 'getUsers': return jsonOut(handleGetUsers(body));
      case 'getTeamNames': return jsonOut(handleGetTeamNames(body));
      case 'getSubscriptionStatus': return jsonOut(handleGetSubscriptionStatus(body));
      case 'syncPull': return jsonOut(handleSyncPull(body));
      case 'syncPush': return jsonOut(handleSyncPush(body));
      case 'sendEmailMessage': return jsonOut(handleSendEmailMessage(body));
      case 'sendSmsMessage': return jsonOut(handleSendSmsMessage(body));
      case 'sendWhatsappMessage': return jsonOut(handleSendWhatsappMessage(body));
      case 'sendInternalMessage': return jsonOut(handleSendInternalMessage(body));
      case 'getInternalMessages': return jsonOut(handleGetInternalMessages(body));
      case 'submitPaymentProof': return jsonOut(handleSubmitPaymentProof(body));
      case 'getPaymentSubmissions': return jsonOut(handleGetPaymentSubmissions(body));
      case 'getPublicSettings': return jsonOut(handleGetPublicSettings(body));
      case 'superAdminListOrgs': return jsonOut(handleSuperAdminListOrgs(body));
      case 'superAdminUpdateOrg': return jsonOut(handleSuperAdminUpdateOrg(body));
      case 'superAdminSetOrgSuspended': return jsonOut(handleSuperAdminSetOrgSuspended(body));
      case 'superAdminListPayments': return jsonOut(handleSuperAdminListPayments(body));
      case 'superAdminDecidePayment': return jsonOut(handleSuperAdminDecidePayment(body));
      case 'superAdminUpdateSettings': return jsonOut(handleSuperAdminUpdateSettings(body));
      case 'superAdminGetSettings': return jsonOut(handleSuperAdminGetSettings(body));
      case 'initPaystackPayment': return jsonOut(handleInitPaystackPayment(body));
      case 'superAdminSendAnnouncement': return jsonOut(handleSuperAdminSendAnnouncement(body));
      case 'superAdminGetCapacity': return jsonOut(handleSuperAdminGetCapacity(body));
      case 'superAdminRunCapacityCheckNow': return jsonOut(handleSuperAdminRunCapacityCheckNow(body));
      default: return jsonOut({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.paystackCallback) return handlePaystackCallback(params);
  return jsonOut({ ok: true, message: 'OKV Business Management System API is live.' });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------- sheet helpers ----------------

function usersSheet() { return SS.getSheetByName(USERS_SHEET); }
function messagesSheet() { return SS.getSheetByName(MESSAGES_SHEET); }
function paymentsSheet() { return SS.getSheetByName(PAYMENTS_SHEET); }
function settingsSheet() { return SS.getSheetByName(SETTINGS_SHEET); }
function registrySheet() { return SS.getSheetByName(REGISTRY_SHEET); }
function capacityHistorySheet() { return SS.getSheetByName(CAPACITY_HISTORY_SHEET); }
// Legacy master "Data" tab (pre-migration, single shared sheet). Only ever read from,
// only by the migration helpers below — never written to, never used to serve live sync.
function legacyMasterDataSheet() { return SS.getSheetByName(DATA_SHEET); }

// ============================================================================
// MULTI-TENANT SPREADSHEETS — per-org "Data" tab lives in its own spreadsheet.
// getOrgSpreadsheet(orgId) is the ONE place all backend code goes to resolve it;
// nothing else should hardcode or assume "the active spreadsheet" for tenant data.
// ============================================================================

function findRegistryRow(orgId) {
  const sh = registrySheet();
  if (!sh) return null;
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (vals[i][R.orgId - 1] === orgId) return { row: i + 1, data: vals[i] };
  }
  return null;
}

// Central helper every backend function uses to reach a tenant's spreadsheet. Resolves
// the spreadsheet ID from the Registry — never hardcoded. Self-healing: if an orgId has
// no Registry entry yet (a brand-new signup where tenant-spreadsheet creation is still
// pending, or any org that predates this architecture and hasn't been migrated), it
// creates the tenant spreadsheet on the spot (copying over any legacy rows found in the
// old master Data tab) so callers never have to special-case a missing registry row.
function getOrgSpreadsheet(orgId) {
  if (!orgId) throw new Error('Missing orgId — cannot resolve a tenant spreadsheet.');
  const existing = findRegistryRow(orgId);
  const spreadsheetId = existing ? existing.data[R.spreadsheetId - 1] : migrateOrgToTenantSpreadsheet(orgId);
  if (!spreadsheetId) throw new Error('No tenant spreadsheet is registered for this organization.');
  return SpreadsheetApp.openById(spreadsheetId);
}

// Creates a brand-new per-tenant spreadsheet, sets up its Data tab, and registers it.
// Called at signup, and by migrateOrgToTenantSpreadsheet() as a fallback/migration path.
function createTenantSpreadsheet(orgId, businessName) {
  const ss = SpreadsheetApp.create('OKV Business Management System Data — ' + (businessName || orgId));
  const dataSh = ss.getSheets()[0];
  dataSh.setName(TENANT_DATA_SHEET);
  dataSh.appendRow(TENANT_DATA_HEADERS);
  dataSh.setFrozenRows(1);
  const reg = registrySheet();
  if (!reg) throw new Error('The master spreadsheet is missing its "Registry" sheet — see README.');
  reg.appendRow([
    orgId, businessName || '', ss.getId(), ss.getUrl(), nowIso(),
    0, CELL_LIMIT, 0, 0, '', '', 'Healthy', 'No action needed.', '', ''
  ]);
  return ss;
}

// Reads any rows for this orgId out of the OLD single shared master Data tab (whatever
// it's currently named — active "Data" or an already-archived "Data_Legacy_Archived_*"),
// and reshapes them to the tenant Data tab's column order (dropping the now-redundant
// orgId column). Returns [] if there's no legacy sheet or no matching rows.
function readLegacyDataRowsForOrg(orgId) {
  const legacy = findLegacyMasterDataSheet();
  if (!legacy) return [];
  const vals = legacy.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (r[D.orgId - 1] !== orgId) continue;
    out.push([
      r[D.recordId - 1], r[D.userId - 1], r[D.type - 1], r[D.payload - 1],
      r[D.updatedAt - 1], r[D.deleted - 1], r[D.createdAt - 1]
    ]);
  }
  return out;
}

// Finds the legacy master Data sheet whether it's still named "Data" or has already
// been renamed to an archived name by migrateExistingDataToPerTenant().
function findLegacyMasterDataSheet() {
  const direct = legacyMasterDataSheet();
  if (direct) return direct;
  const archived = SS.getSheets().find(sh => sh.getName().indexOf('Data_Legacy_Archived') === 0);
  return archived || null;
}

// Idempotent: creates (and registers) a tenant spreadsheet for this org if one doesn't
// already exist, migrating over any rows still sitting in the legacy master Data tab.
// Returns the tenant spreadsheet's ID either way.
function migrateOrgToTenantSpreadsheet(orgId) {
  const existing = findRegistryRow(orgId);
  if (existing) return existing.data[R.spreadsheetId - 1];
  const adminRec = findOrgAdmin(orgId);
  const businessName = adminRec ? adminRec.data[U.businessName - 1] : orgId;
  const ss = createTenantSpreadsheet(orgId, businessName);
  const legacyRows = readLegacyDataRowsForOrg(orgId);
  if (legacyRows.length) {
    const dataSh = ss.getSheetByName(TENANT_DATA_SHEET);
    dataSh.getRange(dataSh.getLastRow() + 1, 1, legacyRows.length, TENANT_DATA_HEADERS.length).setValues(legacyRows);
  }
  return ss.getId();
}

// ---------------- one-time migration: move existing single-sheet data into per-tenant spreadsheets ----------------
// Run this ONCE from the Apps Script editor (select migrateExistingDataToPerTenant in the
// function dropdown, click Run) after creating the "Registry" and "CapacityHistory" sheets
// (see README). Safe to re-run — orgs that already have a Registry entry are skipped.
// At the end, it renames the old master "Data" tab to "Data_Legacy_Archived_<date>" so it's
// kept for reference/audit but nothing in the app reads from it anymore. If you have a LOT
// of organizations, Apps Script's 6-minute execution limit may require running this more
// than once (it's safe to just click Run again — completed orgs are skipped).
function migrateExistingDataToPerTenant() {
  const vals = usersSheet().getDataRange().getValues();
  const orgIds = {};
  for (let i = 1; i < vals.length; i++) { const o = vals[i][U.orgId - 1]; if (o) orgIds[o] = true; }
  let migrated = 0, skipped = 0;
  Object.keys(orgIds).forEach(orgId => {
    if (findRegistryRow(orgId)) { skipped++; return; }
    migrateOrgToTenantSpreadsheet(orgId);
    migrated++;
  });
  const legacy = legacyMasterDataSheet();
  if (legacy) {
    legacy.setName('Data_Legacy_Archived_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyyMMdd_HHmmss'));
  }
  Logger.log('Migration complete. Migrated ' + migrated + ' organization(s), skipped ' + skipped + ' (already had a tenant spreadsheet).');
}

// Reads the Settings sheet (key/value rows) into an object, falling back to
// DEFAULT_SETTINGS for any key that's blank or missing. Cheap enough to call per-request.
function getSettings() {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  const sh = settingsSheet();
  if (!sh) return out;
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    const key = vals[i][ST.key - 1];
    const value = vals[i][ST.value - 1];
    if (key && value !== '' && value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

// Parses a settings value that's stored as JSON text back into an object/array — used for
// manualPaymentMethods and planCatalog, which the Settings sheet stores as JSON strings.
function settingsJson(value, fallback) {
  try { const v = JSON.parse(value); return v; } catch (e) { return fallback; }
}

// Every outbound email that OKV Technology Consults itself sends — payment confirmations,
// subscription reminders, password resets, account-created notices, capacity alerts — goes
// through this, so the "from name" and reply-to configured in Super Admin → Settings apply
// everywhere without touching every call site individually. MailApp still sends from the
// script owner's Google account — Apps Script can't change the actual From address, only the
// display name and reply-to. IMPORTANT: this is only for emails OKV itself sends to org
// admins about their account/subscription. It must never be used for an org admin's own
// emails to their customers/suppliers — see sendOrgEmail() below for that path.
function sendAppEmail(to, subject, plainBody, htmlBody, attachments) {
  const settings = getSettings();
  const options = { to: to, subject: subject, name: settings.emailFromName || 'OKV Business Management System' };
  if (settings.emailReplyTo) options.replyTo = settings.emailReplyTo;
  if (htmlBody) options.htmlBody = htmlBody; else options.body = plainBody || '';
  if (attachments && attachments.length) options.attachments = attachments;
  MailApp.sendEmail(options);
}

// Looks up the org's own BusinessSettings record (name/logo/address — set from that org's own
// Settings tab) directly from their tenant spreadsheet. Returns {} if they haven't set one yet.
function getOrgBusinessSettings(orgId) {
  try {
    const sh = getOrgSpreadsheet(orgId).getSheetByName(TENANT_DATA_SHEET);
    const vals = sh.getDataRange().getValues();
    for (let i = vals.length - 1; i >= 1; i--) { // walk backwards — the newest BusinessSettings row wins if there are ever duplicates
      const r = vals[i];
      if (r[TD.type - 1] === 'BusinessSettings' && !(r[TD.deleted - 1] === true || r[TD.deleted - 1] === 'TRUE')) {
        try { return JSON.parse(r[TD.payload - 1] || '{}'); } catch (e) { return {}; }
      }
    }
  } catch (e) { /* org spreadsheet missing/unreadable — fall back to defaults below */ }
  return {};
}

// Sends an email on behalf of an ORG ADMIN to THEIR OWN customer/supplier — deliberately
// separate from sendAppEmail() above. This must carry that organization's own business name
// (never "OKV Business Management System") and, if they've set a contact email in their
// Settings tab, reply-to that — never OKV's own reply-to address. A customer receiving an
// invoice reminder should see it as coming from the business they buy from, not from OKV.
function sendOrgEmail(orgId, to, subject, plainBody, htmlBody) {
  const biz = getOrgBusinessSettings(orgId);
  const options = { to: to, subject: subject, name: biz.name || 'Your Supplier' };
  if (biz.contactEmail) options.replyTo = biz.contactEmail;
  if (htmlBody) options.htmlBody = htmlBody; else options.body = plainBody || '';
  MailApp.sendEmail(options);
}

function genId(prefix) { return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
function nowIso() { return new Date().toISOString(); }

function appendUserRow(fields) {
  usersSheet().appendRow(USER_HEADERS.map(h => (fields[h] !== undefined ? fields[h] : '')));
}
function setUserField(row, field, value) { usersSheet().getRange(row, U[field]).setValue(value); }

function findUserRow(username) {
  const sh = usersSheet();
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][U.username - 1]).toLowerCase() === String(username).toLowerCase()) return { row: i + 1, data: vals[i] };
  }
  return null;
}
function findUserById(userId) {
  const sh = usersSheet();
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][U.userId - 1]) === String(userId)) return { row: i + 1, data: vals[i] };
  }
  return null;
}
function findUserByEmail(email) {
  const sh = usersSheet();
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][U.email - 1]).toLowerCase() === String(email).toLowerCase()) return { row: i + 1, data: vals[i] };
  }
  return null;
}
function findUserByResetToken(token) {
  if (!token) return null;
  const sh = usersSheet();
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][U.resetToken - 1]) === String(token)) return { row: i + 1, data: vals[i] };
  }
  return null;
}
function findOrgAdmin(orgId) {
  const vals = usersSheet().getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (r[U.orgId - 1] === orgId && (r[U.isAdmin - 1] === true || r[U.isAdmin - 1] === 'TRUE')) return { row: i + 1, data: r };
  }
  return null;
}

function requireAuth(body) {
  const rec = findUserById(body.userId);
  if (!rec) throw new Error('Invalid session, please log in again.');
  if (!body.authToken || rec.data[U.authToken - 1] !== body.authToken) throw new Error('Session expired, please log in again.');
  if (rec.data[U.status - 1] !== 'active') throw new Error('Account suspended.');
  const isSuperAdmin = rec.data[U.isSuperAdmin - 1] === true || rec.data[U.isSuperAdmin - 1] === 'TRUE';
  if (!isSuperAdmin) {
    const orgId = rec.data[U.orgId - 1];
    const adminRec = findOrgAdmin(orgId);
    const orgSuspended = adminRec && (adminRec.data[U.orgSuspended - 1] === true || adminRec.data[U.orgSuspended - 1] === 'TRUE');
    if (orgSuspended) throw new Error('This organization has been suspended. Contact support.');
  }
  return rec;
}
function requireAdmin(body) {
  const rec = requireAuth(body);
  if (rec.data[U.isAdmin - 1] !== true && rec.data[U.isAdmin - 1] !== 'TRUE') throw new Error('Admin access required.');
  return rec;
}
function requireSuperAdmin(body) {
  const rec = requireAuth(body);
  if (rec.data[U.isSuperAdmin - 1] !== true && rec.data[U.isSuperAdmin - 1] !== 'TRUE') throw new Error('Super Admin access required.');
  return rec;
}
function canMessageCustomers(rec) {
  const isAdmin = rec.data[U.isAdmin - 1] === true || rec.data[U.isAdmin - 1] === 'TRUE';
  const isSuperAdmin = rec.data[U.isSuperAdmin - 1] === true || rec.data[U.isSuperAdmin - 1] === 'TRUE';
  if (isAdmin || isSuperAdmin) return true;
  const roles = safeParseArr(rec.data[U.roles - 1]);
  return roles.some(r => CUSTOMER_MESSAGING_ROLES.indexOf(r) !== -1);
}

function subscriptionInfo(adminRow) {
  const status = adminRow[U.subscriptionStatus - 1];
  const plan = adminRow[U.subscriptionPlan - 1] || 'Starter · Monthly';
  const billingState = adminRow[U.billingState - 1] || 'trial';
  const startDate = adminRow[U.subscriptionStartDate - 1] || '';
  const expiry = adminRow[U.subscriptionExpiry - 1];
  const expiryMs = expiry ? new Date(expiry).getTime() : null;
  const now = Date.now();
  const expired = expiryMs !== null && expiryMs < now;
  const active = status === 'active' && !expired;
  const daysLeft = expiryMs !== null ? Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000)) : null;
  return { active, plan, billingState, startDate, expiry, daysLeft, expired };
}

function userPublic(row) {
  return {
    orgId: row[U.orgId - 1], userId: row[U.userId - 1], username: row[U.username - 1],
    email: row[U.email - 1], phone: row[U.phone - 1], businessName: row[U.businessName - 1], fullName: row[U.fullName - 1],
    roles: safeParseArr(row[U.roles - 1]),
    isAdmin: row[U.isAdmin - 1] === true || row[U.isAdmin - 1] === 'TRUE',
    isSuperAdmin: row[U.isSuperAdmin - 1] === true || row[U.isSuperAdmin - 1] === 'TRUE',
    status: row[U.status - 1],
    subscriptionStatus: row[U.subscriptionStatus - 1], subscriptionPlan: row[U.subscriptionPlan - 1],
    billingState: row[U.billingState - 1], subscriptionStartDate: row[U.subscriptionStartDate - 1],
    subscriptionExpiry: row[U.subscriptionExpiry - 1], createdAt: row[U.createdAt - 1]
  };
}
function safeParseArr(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function cycleDaysForPlan(planStr) {
  const p = String(planStr || '');
  if (/yearly/i.test(p)) return 365;
  if (/bi-annual/i.test(p)) return 182;
  return 30; // monthly
}

// ---------------- auth actions ----------------

function handleSignup(body) {
  const businessName = (body.businessName || '').trim();
  const fullName = (body.fullName || '').trim();
  const email = (body.email || '').trim();
  const phone = (body.phone || '').trim();
  const passwordHash = body.passwordHash;
  const username = email; // public signups log in with their email
  if (!businessName || !fullName || !email || !phone || !passwordHash) return { ok: false, error: 'All fields are required.' };
  if (findUserRow(username)) return { ok: false, error: 'An account with that email already exists.' };

  const orgId = genId('org');
  const userId = genId('usr');
  const settings = getSettings();
  const trialDays = Number(settings.trialDays) || 7;
  const trialExpiry = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();
  appendUserRow({
    orgId, userId, username, email, phone, businessName, fullName, passwordHash,
    roles: JSON.stringify(['Business Owner / Super Admin']), isAdmin: true, status: 'active',
    subscriptionStatus: 'active', subscriptionPlan: body.plan || 'Starter · Monthly', billingState: 'trial',
    subscriptionStartDate: nowIso(), subscriptionExpiry: trialExpiry, createdAt: nowIso()
  });

  // Every org gets its own dedicated spreadsheet for transactional data, created right
  // away so the first sync after login has somewhere to write to. A failure here (e.g. a
  // transient Drive error) shouldn't block the signup itself — getOrgSpreadsheet() will
  // retry creating it lazily on first sync if this doesn't succeed now.
  try { migrateOrgToTenantSpreadsheet(orgId); } catch (e) { Logger.log('Tenant spreadsheet creation failed for ' + orgId + ': ' + e); }

  try {
    sendAppEmail(email,
      'Welcome to OKV Business Management System — your ' + trialDays + '-day free trial has started',
      null,
      'Hi ' + fullName + ',<br><br>' +
        'Your organization <strong>' + businessName + '</strong> is set up on OKV Business Management System.<br>' +
        'Plan selected: <strong>' + (body.plan || 'Starter · Monthly') + '</strong><br>' +
        'Your free trial runs for ' + trialDays + ' days, until <strong>' + new Date(trialExpiry).toDateString() + '</strong>.<br><br>' +
        'Next: install the app and log in with this email and the password you chose.<br><br>' +
        settings.supportEmail + ' · ' + settings.supportPhone + ' · ' + settings.supportWebsite
    );
  } catch (e) { /* signup still succeeds even if the welcome email fails to send */ }

  return { ok: true, orgId, userId, message: 'Account created. You can now log in.' };
}

function handleLogin(body) {
  const username = (body.username || '').trim();
  const rec = findUserRow(username);
  if (!rec) return { ok: false, error: 'Incorrect username or password.' };
  const row = rec.data;
  if (row[U.passwordHash - 1] !== body.passwordHash) return { ok: false, error: 'Incorrect username or password.' };
  if (row[U.status - 1] !== 'active') return { ok: false, error: 'This account has been suspended. Contact your admin.' };
  const isSuperAdmin = row[U.isSuperAdmin - 1] === true || row[U.isSuperAdmin - 1] === 'TRUE';
  let sub = null;
  if (!isSuperAdmin) {
    const orgId = row[U.orgId - 1];
    const adminRec = findOrgAdmin(orgId);
    const orgSuspended = adminRec && (adminRec.data[U.orgSuspended - 1] === true || adminRec.data[U.orgSuspended - 1] === 'TRUE');
    if (orgSuspended) return { ok: false, error: 'This organization has been suspended. Contact support.' };
    sub = adminRec ? subscriptionInfo(adminRec.data) : { active: false };
    if (!sub.active) return { ok: false, error: 'This organization\'s subscription has expired. Contact your admin to renew.' };
  }
  const authToken = genId('tok');
  const sh = usersSheet();
  sh.getRange(rec.row, U.authToken).setValue(authToken);
  const updatedRow = row.slice(); updatedRow[U.authToken - 1] = authToken;
  const pub = userPublic(updatedRow); pub.subscription = sub;
  return { ok: true, authToken, user: pub };
}

function handleForgotPassword(body) {
  const username = (body.username || '').trim();
  const rec = findUserRow(username);
  if (!rec) return { ok: true, message: 'If that account exists, a reset link has been sent.' };
  const row = rec.data;
  const isAdmin = row[U.isAdmin - 1] === true || row[U.isAdmin - 1] === 'TRUE';
  if (!isAdmin) return { ok: false, error: 'Only admins can reset via email. Ask your admin to reset your password.' };
  const email = row[U.email - 1];
  if (!email) return { ok: false, error: 'No email on file for this account. Contact support.' };

  const token = Utilities.getUuid();
  const expiry = new Date(Date.now() + RESET_TOKEN_TTL_MIN * 60 * 1000).toISOString();
  setUserField(rec.row, 'resetToken', token);
  setUserField(rec.row, 'resetTokenExpiry', expiry);

  const resetUrl = (body.resetBaseUrl || 'https://YOUR-FRONTEND-URL/reset-password.html') + '?token=' + token;
  const settings = getSettings();
  sendAppEmail(email, 'Reset your OKV Business Management System password', null,
    'Hi ' + row[U.username - 1] + ',<br><br>A password reset was requested for your admin account.<br>' +
    'This link expires in ' + RESET_TOKEN_TTL_MIN + ' minutes and can only be used once:<br><br>' +
    '<a href="' + resetUrl + '">' + resetUrl + '</a><br><br>If you did not request this, ignore this email.<br><br>' +
    settings.supportEmail + ' · ' + settings.supportPhone + ' · ' + settings.supportWebsite
  );
  return { ok: true, message: 'If that account exists, a reset link has been sent.' };
}

function handleValidateResetToken(body) {
  const rec = findUserByResetToken(body.token);
  if (!rec) return { ok: false, error: 'This reset link is invalid or has already been used.' };
  const expiry = rec.data[U.resetTokenExpiry - 1];
  if (!expiry || new Date(expiry).getTime() < Date.now()) return { ok: false, error: 'This reset link has expired. Request a new one.' };
  return { ok: true, username: rec.data[U.username - 1] };
}

function handleResetPassword(body) {
  const rec = findUserByResetToken(body.token);
  if (!rec) return { ok: false, error: 'This reset link is invalid or has already been used.' };
  const expiry = rec.data[U.resetTokenExpiry - 1];
  if (!expiry || new Date(expiry).getTime() < Date.now()) return { ok: false, error: 'This reset link has expired. Request a new one.' };
  if (!body.newPasswordHash) return { ok: false, error: 'New password is required.' };
  setUserField(rec.row, 'passwordHash', body.newPasswordHash);
  setUserField(rec.row, 'resetToken', '');
  setUserField(rec.row, 'resetTokenExpiry', '');
  return { ok: true, message: 'Password reset. You can now log in.' };
}

function handleChangePassword(body) {
  const rec = requireAuth(body);
  if (rec.data[U.passwordHash - 1] !== body.currentPasswordHash) return { ok: false, error: 'Current password is incorrect.' };
  if (!body.newPasswordHash) return { ok: false, error: 'New password is required.' };
  setUserField(rec.row, 'passwordHash', body.newPasswordHash);
  return { ok: true, message: 'Password changed.' };
}

// ---------------- admin: user management ----------------

function handleAdminCreateUser(body) {
  const admin = requireAdmin(body);
  const orgId = admin.data[U.orgId - 1];
  const username = (body.username || '').trim();
  if (!username || !body.passwordHash) return { ok: false, error: 'Username and password are required.' };
  if (findUserRow(username)) return { ok: false, error: 'That username is already taken.' };
  const roles = Array.isArray(body.roles) ? body.roles.filter(r => VALID_ROLES.indexOf(r) !== -1) : [];
  const userId = genId('usr');
  appendUserRow({
    orgId, userId, username, email: (body.email || '').trim(), passwordHash: body.passwordHash,
    roles: JSON.stringify(roles), isAdmin: false, status: 'active', createdAt: nowIso()
  });
  return { ok: true, userId, message: 'User created.' };
}

function handleAdminEditUser(body) {
  const admin = requireAdmin(body);
  const orgId = admin.data[U.orgId - 1];
  const rec = findUserById(body.userId);
  if (!rec || rec.data[U.orgId - 1] !== orgId) return { ok: false, error: 'User not found in your organization.' };
  if (body.email !== undefined) setUserField(rec.row, 'email', body.email);
  if (Array.isArray(body.roles)) setUserField(rec.row, 'roles', JSON.stringify(body.roles.filter(r => VALID_ROLES.indexOf(r) !== -1)));
  return { ok: true, message: 'User updated.' };
}

function handleAdminDeleteUser(body) {
  const admin = requireAdmin(body);
  const orgId = admin.data[U.orgId - 1];
  const rec = findUserById(body.userId);
  if (!rec || rec.data[U.orgId - 1] !== orgId) return { ok: false, error: 'User not found in your organization.' };
  if (rec.data[U.userId - 1] === admin.data[U.userId - 1]) return { ok: false, error: 'You cannot delete your own admin account.' };
  usersSheet().deleteRow(rec.row);
  return { ok: true, message: 'User deleted.' };
}

function handleAdminSetUserPassword(body) {
  const admin = requireAdmin(body);
  const orgId = admin.data[U.orgId - 1];
  const rec = findUserById(body.userId);
  if (!rec || rec.data[U.orgId - 1] !== orgId) return { ok: false, error: 'User not found in your organization.' };
  if (!body.newPasswordHash) return { ok: false, error: 'New password is required.' };
  setUserField(rec.row, 'passwordHash', body.newPasswordHash);
  return { ok: true, message: 'Password updated for that user.' };
}

function handleAdminSetUserStatus(body) {
  const admin = requireAdmin(body);
  const orgId = admin.data[U.orgId - 1];
  const rec = findUserById(body.userId);
  if (!rec || rec.data[U.orgId - 1] !== orgId) return { ok: false, error: 'User not found in your organization.' };
  const status = body.status === 'suspended' ? 'suspended' : 'active';
  setUserField(rec.row, 'status', status);
  if (status === 'suspended') setUserField(rec.row, 'authToken', '');
  return { ok: true, message: 'User is now ' + status + '.' };
}

function handleGetUsers(body) {
  const admin = requireAdmin(body);
  const orgId = admin.data[U.orgId - 1];
  const vals = usersSheet().getDataRange().getValues();
  const list = [];
  for (let i = 1; i < vals.length; i++) if (vals[i][U.orgId - 1] === orgId) list.push(userPublic(vals[i]));
  return { ok: true, users: list };
}

function handleGetTeamNames(body) {
  const me = requireAuth(body);
  const orgId = me.data[U.orgId - 1];
  const vals = usersSheet().getDataRange().getValues();
  const names = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (r[U.orgId - 1] === orgId && r[U.status - 1] === 'active') names.push({ userId: r[U.userId - 1], username: r[U.username - 1], roles: safeParseArr(r[U.roles - 1]) });
  }
  return { ok: true, names };
}

function handleGetSubscriptionStatus(body) {
  const me = requireAuth(body);
  const adminRec = findOrgAdmin(me.data[U.orgId - 1]);
  if (!adminRec) return { ok: false, error: 'No admin found for this organization.' };
  return { ok: true, subscription: subscriptionInfo(adminRec.data), serverTime: nowIso() };
}

// ---------------- data sync (Products, Sales, Records, Customers, Suppliers — generic) ----------------

function handleSyncPull(body) {
  const rec = requireAuth(body);
  const orgId = rec.data[U.orgId - 1];
  const since = body.since ? new Date(body.since).getTime() : 0;
  const sh = getOrgSpreadsheet(orgId).getSheetByName(TENANT_DATA_SHEET);
  const vals = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (new Date(r[TD.updatedAt - 1]).getTime() > since) {
      out.push({
        recordId: r[TD.recordId - 1], userId: r[TD.userId - 1], type: r[TD.type - 1], payload: r[TD.payload - 1],
        updatedAt: r[TD.updatedAt - 1], deleted: r[TD.deleted - 1] === true || r[TD.deleted - 1] === 'TRUE', createdAt: r[TD.createdAt - 1]
      });
    }
  }
  return { ok: true, records: out, serverTime: nowIso() };
}

function handleSyncPush(body) {
  const rec = requireAuth(body);
  const orgId = rec.data[U.orgId - 1];
  const userId = rec.data[U.userId - 1];
  const records = Array.isArray(body.records) ? body.records : [];
  const sh = getOrgSpreadsheet(orgId).getSheetByName(TENANT_DATA_SHEET);
  const vals = sh.getDataRange().getValues();
  const indexByRecordId = {};
  for (let i = 1; i < vals.length; i++) indexByRecordId[vals[i][TD.recordId - 1]] = i + 1;
  const applied = []; const now = nowIso();
  records.forEach(rcd => {
    const recordId = rcd.recordId || genId('rec');
    const existingRow = indexByRecordId[recordId];
    if (existingRow) {
      sh.getRange(existingRow, TD.type).setValue(rcd.type);
      sh.getRange(existingRow, TD.payload).setValue(rcd.payload);
      sh.getRange(existingRow, TD.updatedAt).setValue(now);
      sh.getRange(existingRow, TD.deleted).setValue(!!rcd.deleted);
    } else {
      sh.appendRow([recordId, userId, rcd.type, rcd.payload, now, !!rcd.deleted, rcd.createdAt || now]);
    }
    applied.push({ recordId, updatedAt: now });
  });
  return { ok: true, applied, serverTime: now };
}

// ---------------- customer / supplier messaging (email + SMS + WhatsApp) ----------------

function handleSendEmailMessage(body) {
  const rec = requireAuth(body);
  if (!canMessageCustomers(rec)) return { ok: false, error: 'You don\'t have permission to message customers or suppliers.' };
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  const subject = (body.subject || '').trim();
  const message = (body.body || '').trim();
  if (!recipients.length || !subject || !message) return { ok: false, error: 'Recipients, subject and message are all required.' };
  const orgId = rec.data[U.orgId - 1];

  let sent = 0; const failed = [];
  recipients.forEach(r => {
    if (!r.email) { failed.push(r.name || r.email || 'unknown'); return; }
    try {
      const personalized = message.replace(/\{name\}/gi, r.name || 'there');
      sendOrgEmail(orgId, r.email, subject, personalized); // this org's own name/reply-to — never OKV's
      sent++;
    } catch (e) { failed.push(r.name || r.email); }
  });
  return { ok: true, sent, failed, total: recipients.length };
}

// ---------------- SMS / WhatsApp provider wiring ----------------
// Both check the Super Admin's Settings (SMS/WhatsApp tab) and send for real once configured —
// "just by inputting" credentials there, no code changes needed. Before that, they return a
// clear, honest "not configured yet" error rather than a fake success.

// Termii-shaped by default (a common Nigerian SMS gateway) — settings.smsProvider is stored for
// future providers, but only Termii's request shape is implemented here right now.
function sendSmsViaProvider(toPhone, message) {
  const settings = getSettings();
  if (!settings.smsApiKey) return { ok: false, error: 'SMS isn\'t configured yet — add an SMS API key from the Super Admin dashboard\'s Settings tab.' };
  try {
    const res = UrlFetchApp.fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({
        to: String(toPhone).replace(/[^0-9]/g, ''), from: settings.smsSenderId || 'OKVBMS',
        sms: message, type: 'plain', channel: 'generic', api_key: settings.smsApiKey
      })
    });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return { ok: true };
    return { ok: false, error: 'SMS gateway returned an error (HTTP ' + code + ').' };
  } catch (e) { return { ok: false, error: 'SMS send failed: ' + e }; }
}

// Meta's WhatsApp Cloud API — needs a phone number ID + permanent access token, both entered
// from the Super Admin dashboard's Settings tab.
function sendWhatsappViaProvider(toPhone, message) {
  const settings = getSettings();
  if (!settings.whatsappToken || !settings.whatsappPhoneId) {
    return { ok: false, error: 'WhatsApp isn\'t configured yet — add a WhatsApp Business API token and phone number ID from the Super Admin dashboard\'s Settings tab.' };
  }
  try {
    const url = 'https://graph.facebook.com/v19.0/' + settings.whatsappPhoneId + '/messages';
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + settings.whatsappToken },
      payload: JSON.stringify({ messaging_product: 'whatsapp', to: String(toPhone).replace(/[^0-9]/g, ''), type: 'text', text: { body: message } })
    });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return { ok: true };
    return { ok: false, error: 'WhatsApp API returned an error (HTTP ' + code + ').' };
  } catch (e) { return { ok: false, error: 'WhatsApp send failed: ' + e }; }
}

function handleSendSmsMessage(body) {
  const rec = requireAuth(body);
  if (!canMessageCustomers(rec)) return { ok: false, error: 'You don\'t have permission to message customers or suppliers.' };
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  const message = (body.body || '').trim();
  if (!recipients.length || !message) return { ok: false, error: 'Recipients and message are required.' };
  let sent = 0; const failed = []; let lastError = '';
  recipients.forEach(r => {
    if (!r.phone) { failed.push(r.name || 'unknown'); return; }
    const personalized = message.replace(/\{name\}/gi, r.name || 'there');
    const res = sendSmsViaProvider(r.phone, personalized);
    if (res.ok) sent++; else { failed.push(r.name || r.phone); lastError = res.error; }
  });
  if (!sent && lastError) return { ok: false, error: lastError };
  return { ok: true, sent, failed, total: recipients.length };
}

function handleSendWhatsappMessage(body) {
  const rec = requireAuth(body);
  if (!canMessageCustomers(rec)) return { ok: false, error: 'You don\'t have permission to message customers or suppliers.' };
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  const message = (body.body || '').trim();
  if (!recipients.length || !message) return { ok: false, error: 'Recipients and message are required.' };
  let sent = 0; const failed = []; let lastError = '';
  recipients.forEach(r => {
    if (!r.phone) { failed.push(r.name || 'unknown'); return; }
    const personalized = message.replace(/\{name\}/gi, r.name || 'there');
    const res = sendWhatsappViaProvider(r.phone, personalized);
    if (res.ok) sent++; else { failed.push(r.name || r.phone); lastError = res.error; }
  });
  if (!sent && lastError) return { ok: false, error: lastError };
  return { ok: true, sent, failed, total: recipients.length };
}

// ---------------- internal team chat (Admin ↔ Users) ----------------

function handleSendInternalMessage(body) {
  const me = requireAuth(body);
  const orgId = me.data[U.orgId - 1];
  const text = (body.body || '').trim();
  if (!text) return { ok: false, error: 'Message can\'t be empty.' };
  const toUserId = body.toUserId || ''; // blank = broadcast to whole org
  let toLabel = 'Everyone';
  if (toUserId) {
    const target = findUserById(toUserId);
    if (!target || target.data[U.orgId - 1] !== orgId) return { ok: false, error: 'Recipient not found in your organization.' };
    toLabel = target.data[U.username - 1];
  }
  messagesSheet().appendRow([orgId, genId('msg'), me.data[U.userId - 1], me.data[U.username - 1], toUserId, toLabel, text, nowIso()]);
  return { ok: true };
}

function handleGetInternalMessages(body) {
  const me = requireAuth(body);
  const orgId = me.data[U.orgId - 1];
  const myId = me.data[U.userId - 1];
  const vals = messagesSheet().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (r[M.orgId - 1] !== orgId) continue;
    const toUserId = r[M.toUserId - 1];
    // Visible if: broadcast to everyone, sent by me, or sent directly to me.
    if (toUserId === '' || r[M.fromUserId - 1] === myId || toUserId === myId) {
      out.push({
        messageId: r[M.messageId - 1], fromUserId: r[M.fromUserId - 1], fromUsername: r[M.fromUsername - 1],
        toUserId: toUserId, toLabel: r[M.toLabel - 1], body: r[M.body - 1], createdAt: r[M.createdAt - 1]
      });
    }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { ok: true, messages: out };
}

// ---------------- payment submissions (manual upgrade/renewal confirmation) ----------------

function handleSubmitPaymentProof(body) {
  const admin = requireAdmin(body);
  const orgId = admin.data[U.orgId - 1];
  const businessName = (body.businessName || '').trim();
  const email = (body.email || '').trim();
  const phone = (body.phone || '').trim();
  const plan = (body.plan || '').trim();
  const screenshotDataUrl = body.screenshotDataUrl || '';
  if (!businessName || !email || !phone || !plan) return { ok: false, error: 'Business name, email, phone and plan are all required.' };

  const submissionId = genId('pay');
  paymentsSheet().appendRow([orgId, submissionId, admin.data[U.userId - 1], businessName, email, phone, plan, screenshotDataUrl, 'pending', nowIso(), '', '']);

  const attachments = [];
  if (screenshotDataUrl.indexOf('base64,') !== -1) {
    try {
      const parts = screenshotDataUrl.split('base64,');
      const meta = parts[0]; // e.g. "data:image/jpeg;"
      const mime = (meta.match(/data:([^;]+);/) || [, 'image/jpeg'])[1];
      const bytes = Utilities.base64Decode(parts[1]);
      attachments.push(Utilities.newBlob(bytes, mime, 'payment-proof.jpg'));
    } catch (e) { /* attach nothing if decoding fails — submission is still recorded */ }
  }

  sendAppEmail(getSettings().supportEmail,
    'Payment submitted — ' + businessName + ' (' + plan + ')',
    'New payment submission:\n\n' +
      'Business: ' + businessName + '\nAdmin email: ' + email + '\nPhone: ' + phone + '\nPlan requested: ' + plan +
      '\nOrg ID: ' + orgId + '\nSubmission ID: ' + submissionId + '\n\n' +
      'Confirm or reject it from the Super Admin dashboard\'s Payments tab, or by opening the ' +
      'PaymentSubmissions sheet, finding this row, and setting its "status" column to "confirmed" or ' +
      '"rejected" (optionally add a decisionNote). The org is upgraded and the admin is emailed automatically either way.',
    null, attachments
  );

  return { ok: true, submissionId, message: 'Submitted. You\'ll get a status email within the hour.' };
}

function handleGetPaymentSubmissions(body) {
  const admin = requireAdmin(body);
  const orgId = admin.data[U.orgId - 1];
  const vals = paymentsSheet().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (r[P.orgId - 1] !== orgId) continue;
    out.push({
      submissionId: r[P.submissionId - 1], plan: r[P.planRequested - 1], status: r[P.status - 1],
      submittedAt: r[P.submittedAt - 1], decidedAt: r[P.decidedAt - 1], decisionNote: r[P.decisionNote - 1]
    });
  }
  out.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return { ok: true, submissions: out };
}

// ---------------- shared: apply a confirm/reject decision to a payment submission ----------------
// Used by both the Sheet-edit trigger below and the Super Admin dashboard's Confirm/Reject
// buttons, so the two ways of deciding a payment always behave identically.
function applyPaymentDecision(row, status, note) {
  const sheet = paymentsSheet();
  const rowVals = sheet.getRange(row, 1, 1, PAYMENT_HEADERS.length).getValues()[0];
  const alreadyDecided = rowVals[P.decidedAt - 1];
  if (alreadyDecided) return { ok: false, error: 'This submission was already decided.' };
  if (status !== 'confirmed' && status !== 'rejected') return { ok: false, error: 'Status must be confirmed or rejected.' };

  const orgId = rowVals[P.orgId - 1];
  const email = rowVals[P.email - 1];
  const businessName = rowVals[P.businessName - 1];
  const plan = rowVals[P.planRequested - 1];
  const decidedAt = nowIso();
  const settings = getSettings();
  sheet.getRange(row, P.decidedAt).setValue(decidedAt);
  sheet.getRange(row, P.status).setValue(status);
  if (note) sheet.getRange(row, P.decisionNote).setValue(note);

  if (status === 'confirmed') {
    const adminRec = findOrgAdmin(orgId);
    if (adminRec) {
      const currentExpiry = adminRec.data[U.subscriptionExpiry - 1];
      const base = currentExpiry && new Date(currentExpiry).getTime() > Date.now() ? new Date(currentExpiry).getTime() : Date.now();
      const newExpiry = new Date(base + cycleDaysForPlan(plan) * 24 * 60 * 60 * 1000).toISOString();
      setUserField(adminRec.row, 'subscriptionStatus', 'active');
      setUserField(adminRec.row, 'subscriptionPlan', plan);
      setUserField(adminRec.row, 'billingState', 'paid');
      setUserField(adminRec.row, 'subscriptionStartDate', nowIso());
      setUserField(adminRec.row, 'subscriptionExpiry', newExpiry);
      setUserField(adminRec.row, 'reminderSentAt', ''); // reset so a fresh reminder can fire before the new due date
      try {
        sendAppEmail(email, 'Payment confirmed — ' + businessName + ' is upgraded', null,
          'Good news! Your payment for the ' + plan + ' plan has been confirmed.<br><br>' +
          'Your access now runs until <strong>' + new Date(newExpiry).toDateString() + '</strong>.<br>' +
          'This will show automatically on your dashboard next time you open it.<br><br>' +
          settings.supportEmail + ' · ' + settings.supportPhone + ' · ' + settings.supportWebsite
        );
      } catch (e) { /* subscription is still upgraded even if the email fails */ }
    }
  } else {
    const finalNote = note || rowVals[P.decisionNote - 1] || 'We couldn\'t verify this payment. Please contact us or resubmit with clearer proof.';
    try {
      sendAppEmail(email, 'Payment not confirmed — ' + businessName, null,
        'We could not confirm your recent payment submission for the ' + plan + ' plan.<br><br>' +
        finalNote + '<br><br>Reach us at ' + settings.supportEmail + ' or ' + settings.supportPhone + ' to sort this out — ' + settings.supportWebsite
      );
    } catch (e) { /* decision is still recorded even if the email fails */ }
  }
  return { ok: true };
}

// ---------------- Paystack: real automatic gateway checkout ----------------
// Only Paystack has a working checkout+verify flow in this build (its REST API is simple enough
// to call directly from Apps Script with no SDK). Flutterwave/Remita keys are captured and
// stored by the Super Admin's Settings tab, ready for the same treatment — say the word and
// I'll wire either in following this exact pattern.

function handleInitPaystackPayment(body) {
  const admin = requireAdmin(body);
  const settings = getSettings();
  if (!settings.paystackEnabled || !settings.paystackSecretKey || !settings.paystackPublicKey) {
    return { ok: false, error: 'Card payment isn\'t enabled yet. Use the bank transfer option below, or ask support to enable it.' };
  }
  const plans = settingsJson(settings.planCatalog, []);
  const planObj = plans.find(p => (p.tier + ' · ' + p.cycle) === body.plan || p.id === body.planId);
  if (!planObj || !planObj.amount) return { ok: false, error: 'Pick a valid plan.' };

  const orgId = admin.data[U.orgId - 1];
  const email = admin.data[U.email - 1];
  const amountKobo = Math.round(Number(planObj.amount) * 100);
  const callbackUrl = ScriptApp.getService().getUrl() + '?paystackCallback=1';

  try {
    const res = UrlFetchApp.fetch('https://api.paystack.co/transaction/initialize', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + settings.paystackSecretKey },
      payload: JSON.stringify({
        email: email, amount: amountKobo, currency: 'NGN', callback_url: callbackUrl,
        metadata: { orgId: orgId, plan: planObj.tier + ' · ' + planObj.cycle }
      })
    });
    const data = JSON.parse(res.getContentText());
    if (!data.status) return { ok: false, error: data.message || 'Could not start payment with Paystack.' };
    return { ok: true, authorizationUrl: data.data.authorization_url };
  } catch (e) { return { ok: false, error: 'Could not reach Paystack: ' + e }; }
}

// Paystack redirects the customer's browser here (GET) after checkout. Verifies the transaction
// server-side with the secret key, then upgrades the org and shows a plain result page — this is
// a real browser navigation, not an API call, so it returns HTML rather than JSON.
function handlePaystackCallback(params) {
  const reference = params.reference || params.trxref || '';
  const settings = getSettings();
  let html;
  try {
    if (!reference) throw new Error('Missing payment reference.');
    if (!settings.paystackSecretKey) throw new Error('Paystack is not configured.');
    const res = UrlFetchApp.fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
      method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + settings.paystackSecretKey }
    });
    const data = JSON.parse(res.getContentText());
    if (!data || !data.data || data.data.status !== 'success') throw new Error('This payment was not successful.');

    const meta = data.data.metadata || {};
    const orgId = meta.orgId, plan = meta.plan;
    if (!orgId || !plan) throw new Error('Missing order details on this transaction.');

    if (findPaymentBySubmissionId(reference)) {
      html = paystackResultHtml(true, 'Payment already confirmed earlier. You can close this tab and return to your dashboard.');
    } else {
      const adminRec = findOrgAdmin(orgId);
      if (!adminRec) throw new Error('Organization not found.');
      const amountNaira = (data.data.amount || 0) / 100;
      paymentsSheet().appendRow([
        orgId, reference, adminRec.data[U.userId - 1], adminRec.data[U.businessName - 1],
        adminRec.data[U.email - 1], adminRec.data[U.phone - 1], plan, '', 'confirmed',
        nowIso(), nowIso(), 'Paid via Paystack (₦' + amountNaira + ')'
      ]);
      const currentExpiry = adminRec.data[U.subscriptionExpiry - 1];
      const base = currentExpiry && new Date(currentExpiry).getTime() > Date.now() ? new Date(currentExpiry).getTime() : Date.now();
      const newExpiry = new Date(base + cycleDaysForPlan(plan) * 24 * 60 * 60 * 1000).toISOString();
      setUserField(adminRec.row, 'subscriptionStatus', 'active');
      setUserField(adminRec.row, 'subscriptionPlan', plan);
      setUserField(adminRec.row, 'billingState', 'paid');
      setUserField(adminRec.row, 'subscriptionStartDate', nowIso());
      setUserField(adminRec.row, 'subscriptionExpiry', newExpiry);
      setUserField(adminRec.row, 'reminderSentAt', '');
      try {
        sendAppEmail(adminRec.data[U.email - 1], 'Payment confirmed — your account is upgraded', null,
          'Your Paystack payment for the ' + plan + ' plan was successful.<br><br>' +
          'Your access now runs until <strong>' + new Date(newExpiry).toDateString() + '</strong>.<br><br>' +
          settings.supportEmail + ' · ' + settings.supportPhone + ' · ' + settings.supportWebsite
        );
      } catch (e2) { /* upgrade still applied even if the email fails */ }
      html = paystackResultHtml(true, 'Payment confirmed! Your subscription is now active until ' + new Date(newExpiry).toDateString() + '. Close this tab and return to your dashboard.');
    }
  } catch (err) {
    html = paystackResultHtml(false, 'We could not confirm this payment: ' + err + '. Contact ' + settings.supportEmail + ' if you were charged.');
  }
  return HtmlService.createHtmlOutput(html);
}

function findPaymentBySubmissionId(submissionId) {
  const vals = paymentsSheet().getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) if (vals[i][P.submissionId - 1] === submissionId) return { row: i + 1, data: vals[i] };
  return null;
}

function paystackResultHtml(success, message) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:system-ui,sans-serif;background:#f5f3ec;color:#132523;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}' +
    '.card{background:#fff;border-radius:14px;padding:28px;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,.12)}' +
    'h2{margin-top:0}a{color:#155452}</style></head><body><div class="card">' +
    '<h2>' + (success ? 'Payment received' : 'Payment issue') + '</h2><p>' + message + '</p>' +
    '</div></body></html>';
}

// ---------------- installable trigger: confirm/reject a payment by editing the Sheet ----------------
// This does NOT run automatically on its own — you must wire it up once as an installable
// trigger (Apps Script editor → Triggers → Add Trigger → function: handleSheetEdit,
// event: On edit, source: From spreadsheet). See README step 6. Simple triggers (the
// automatic kind) can't send email, which is why this needs to be installed manually once.
// You can also skip the Sheet entirely and confirm/reject from the Super Admin dashboard.
function handleSheetEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    if (sheet.getName() !== PAYMENTS_SHEET) return;
    if (e.range.getColumn() !== P.status) return;
    const row = e.range.getRow();
    if (row === 1) return; // header row
    const status = String(e.range.getValue()).trim().toLowerCase();
    if (status !== 'confirmed' && status !== 'rejected') return;
    applyPaymentDecision(row, status, '');
  } catch (err) { /* never let a trigger error block the sheet edit itself */ }
}

// ---------------- public settings (no auth — read by marketing pages + dashboard) ----------------
// CRITICAL: only ever return the PUBLIC_SETTINGS_KEYS whitelist here — never spread the full
// getSettings() object, or API keys/secrets would leak to anyone who calls this unauthenticated
// action. manualPaymentMethods/planCatalog are parsed from JSON text into real arrays for the
// frontend; enabled-flags for SMS/WhatsApp are derived booleans, never the underlying secret.

function handleGetPublicSettings(body) {
  const full = getSettings();
  const out = {};
  PUBLIC_SETTINGS_KEYS.forEach(k => { out[k] = full[k]; });
  out.manualPaymentMethods = (settingsJson(full.manualPaymentMethods, []) || []).filter(m => m.enabled);
  out.planCatalog = settingsJson(full.planCatalog, []);
  out.trialDays = Number(full.trialDays) || 7;
  out.reminderDaysBeforeDue = Number(full.reminderDaysBeforeDue) || 3;
  out.smsEnabled = !!full.smsApiKey;
  out.whatsappEnabled = !!(full.whatsappToken && full.whatsappPhoneId);
  out.paystackEnabled = !!(full.paystackEnabled && full.paystackPublicKey);
  out.flutterwaveEnabled = !!(full.flutterwaveEnabled && full.flutterwavePublicKey);
  out.remitaEnabled = !!(full.remitaEnabled);
  return { ok: true, settings: out };
}

// ---------------- Super Admin: organizations, payments, settings ----------------

// Returns one row per organization (i.e. per Admin user), with contact + subscription details,
// plus how many team members that org has.
function handleSuperAdminListOrgs(body) {
  requireSuperAdmin(body);
  const vals = usersSheet().getDataRange().getValues();
  const counts = {};
  for (let i = 1; i < vals.length; i++) {
    const orgId = vals[i][U.orgId - 1];
    if (orgId) counts[orgId] = (counts[orgId] || 0) + 1;
  }
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    const isAdmin = r[U.isAdmin - 1] === true || r[U.isAdmin - 1] === 'TRUE';
    const isSuperAdmin = r[U.isSuperAdmin - 1] === true || r[U.isSuperAdmin - 1] === 'TRUE';
    if (!isAdmin || isSuperAdmin) continue; // one row per org = its Admin
    const sub = subscriptionInfo(r);
    out.push({
      userId: r[U.userId - 1], orgId: r[U.orgId - 1], businessName: r[U.businessName - 1],
      fullName: r[U.fullName - 1], username: r[U.username - 1], email: r[U.email - 1], phone: r[U.phone - 1],
      status: r[U.status - 1], orgSuspended: r[U.orgSuspended - 1] === true || r[U.orgSuspended - 1] === 'TRUE',
      teamCount: counts[r[U.orgId - 1]] || 1,
      subscription: sub, createdAt: r[U.createdAt - 1]
    });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ok: true, orgs: out };
}

// Lets the Super Admin edit an org's contact details and subscription directly — an alternative
// to opening the Sheet. userId identifies the org's Admin row.
function handleSuperAdminUpdateOrg(body) {
  requireSuperAdmin(body);
  const rec = findUserById(body.userId);
  if (!rec) return { ok: false, error: 'Organization not found.' };
  const fields = ['businessName', 'fullName', 'email', 'phone', 'subscriptionStatus', 'subscriptionPlan', 'billingState', 'subscriptionExpiry'];
  fields.forEach(f => { if (body[f] !== undefined && body[f] !== null) setUserField(rec.row, f, body[f]); });
  return { ok: true, message: 'Organization updated.' };
}

function handleSuperAdminSetOrgSuspended(body) {
  requireSuperAdmin(body);
  const rec = findUserById(body.userId);
  if (!rec) return { ok: false, error: 'Organization not found.' };
  setUserField(rec.row, 'orgSuspended', !!body.suspended);
  if (body.suspended) setUserField(rec.row, 'authToken', ''); // kill the admin's own session too
  return { ok: true, message: body.suspended ? 'Organization suspended.' : 'Organization reactivated.' };
}

function handleSuperAdminListPayments(body) {
  requireSuperAdmin(body);
  const vals = paymentsSheet().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    out.push({
      row: i + 1, submissionId: r[P.submissionId - 1], orgId: r[P.orgId - 1], businessName: r[P.businessName - 1],
      email: r[P.email - 1], phone: r[P.phone - 1], plan: r[P.planRequested - 1],
      screenshotDataUrl: r[P.screenshotDataUrl - 1], status: r[P.status - 1],
      submittedAt: r[P.submittedAt - 1], decidedAt: r[P.decidedAt - 1], decisionNote: r[P.decisionNote - 1]
    });
  }
  out.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return { ok: true, submissions: out };
}

function handleSuperAdminDecidePayment(body) {
  requireSuperAdmin(body);
  const row = Number(body.row);
  const status = body.status === 'confirmed' ? 'confirmed' : (body.status === 'rejected' ? 'rejected' : null);
  if (!row || !status) return { ok: false, error: 'A row and a status of confirmed/rejected are required.' };
  return applyPaymentDecision(row, status, body.note || '');
}

function handleSuperAdminUpdateSettings(body) {
  requireSuperAdmin(body);
  const sh = settingsSheet();
  const vals = sh.getDataRange().getValues();
  const rowByKey = {};
  for (let i = 1; i < vals.length; i++) rowByKey[vals[i][ST.key - 1]] = i + 1;
  // Any key from DEFAULT_SETTINGS can be updated here — this action is Super-Admin-only, so it's
  // safe to accept the whole set (branding, email/SMS/WhatsApp config, payment methods, gateway
  // keys, plan catalog, trial/reminder tuning) in one call from the Settings tab's Save button.
  Object.keys(DEFAULT_SETTINGS).forEach(key => {
    if (body[key] === undefined) return; // only touch keys actually sent this time
    let value = body[key];
    if (typeof DEFAULT_SETTINGS[key] === 'boolean') value = !!value;
    if (rowByKey[key]) {
      sh.getRange(rowByKey[key], ST.value).setValue(value);
    } else {
      sh.appendRow([key, value]);
      rowByKey[key] = sh.getLastRow();
    }
  });
  return { ok: true, settings: getSettings() };
}

// Returns the FULL settings object, including secrets (API keys/tokens) — used only to populate
// the Settings tab's edit form. Super Admin auth required; never exposed via getPublicSettings.
function handleSuperAdminGetSettings(body) {
  requireSuperAdmin(body);
  return { ok: true, settings: getSettings() };
}

// Lets the Super Admin message org Admins individually or all at once — same email/WhatsApp
// pattern as the org-level customer messaging, personalized with {name} / {business}.
function handleSuperAdminSendAnnouncement(body) {
  requireSuperAdmin(body);
  const channel = body.channel === 'whatsapp' ? 'whatsapp' : (body.channel === 'sms' ? 'sms' : 'email');
  const subject = (body.subject || '').trim();
  const message = (body.body || '').trim();
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  if (!message) return { ok: false, error: 'Write a message first.' };
  if (!recipients.length) return { ok: false, error: 'Pick at least one organization, or choose "everyone".' };

  if (channel === 'sms' || channel === 'whatsapp') {
    const sendFn = channel === 'sms' ? sendSmsViaProvider : sendWhatsappViaProvider;
    let sent = 0; const failed = []; let lastError = '';
    recipients.forEach(r => {
      if (!r.phone) { failed.push(r.businessName || 'unknown'); return; }
      const personalized = message.replace(/\{name\}/gi, r.fullName || 'there').replace(/\{business\}/gi, r.businessName || 'your organization');
      const res = sendFn(r.phone, personalized);
      if (res.ok) sent++; else { failed.push(r.businessName || r.phone); lastError = res.error; }
    });
    if (!sent && lastError) return { ok: false, error: lastError };
    return { ok: true, sent, failed, total: recipients.length };
  }

  if (!subject) return { ok: false, error: 'Subject is required for email.' };
  let sent = 0; const failed = [];
  recipients.forEach(r => {
    if (!r.email) { failed.push(r.businessName || r.email || 'unknown'); return; }
    try {
      const personalized = message.replace(/\{name\}/gi, r.fullName || 'there').replace(/\{business\}/gi, r.businessName || 'your organization');
      sendAppEmail(r.email, subject, personalized);
      sent++;
    } catch (e) { failed.push(r.businessName || r.email); }
  });
  return { ok: true, sent, failed, total: recipients.length };
}

// ---------------- time-driven trigger: email admins whose trial/subscription needs attention ----------------
// Does NOT run on its own — wire it up once as an installable time-driven trigger (Apps Script
// editor → Triggers → Add Trigger → function: sendSubscriptionReminders → event source: Time-driven
// → Day timer, once a day — the function itself decides whether it's actually time to email each
// admin, so a daily-firing trigger is fine). See README.
//
// Cadence: at most once every `reminderIntervalDays` (Settings tab → default 15, i.e. about twice
// a month) per admin — not daily — so it's informative rather than "disturbing." Only sent to
// admins who actually have something to act on: still in trial, subscription due within 30 days,
// or already expired. A fully-paid-up admin with months of runway left hears nothing. Cleared
// automatically whenever a payment is confirmed (see applyPaymentDecision above), so the cadence
// restarts fresh from their next real due date.
function sendSubscriptionReminders() {
  const sh = usersSheet();
  const vals = sh.getDataRange().getValues();
  const settings = getSettings();
  const intervalDays = Number(settings.reminderIntervalDays) || 15;
  const plans = settingsJson(settings.planCatalog, []);
  const now = Date.now();

  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    const isAdmin = r[U.isAdmin - 1] === true || r[U.isAdmin - 1] === 'TRUE';
    const isSuperAdmin = r[U.isSuperAdmin - 1] === true || r[U.isSuperAdmin - 1] === 'TRUE';
    if (!isAdmin || isSuperAdmin) continue;

    const sub = subscriptionInfo(r);
    const isTrial = sub.billingState === 'trial';
    // Trials (short, every day matters) are always relevant. Paid subscriptions become relevant
    // once within 30 days of due — wide enough that, combined with the reminderIntervalDays
    // cadence below, an admin naturally gets reminded about twice before their due date.
    const relevant = isTrial || sub.expired || (sub.daysLeft !== null && sub.daysLeft <= 30);
    if (!relevant) continue; // plenty of runway left — don't email them at all

    const lastSent = r[U.reminderSentAt - 1];
    const daysSinceLast = lastSent ? (now - new Date(lastSent).getTime()) / 86400000 : Infinity;
    if (daysSinceLast < intervalDays) continue; // not due for another reminder yet

    const email = r[U.email - 1];
    if (!email) continue;

    // "Next plan/tier" — what they'd pay to continue on their current tier/cycle, looked up
    // from the live plan catalog so the price is always accurate.
    const nextPlan = plans.find(p => (p.tier + ' · ' + p.cycle) === sub.plan);
    const nextPlanLine = nextPlan
      ? 'To continue on <strong>' + nextPlan.tier + ' · ' + nextPlan.cycle + '</strong>: <strong>' + nextPlan.priceLabel + '</strong> (' + nextPlan.billedNote + ').'
      : 'Open the Subscription tab to see current plan pricing.';

    const subject = sub.expired
      ? (isTrial ? 'Your free trial has ended — OKV Business Management System' : 'Your subscription has expired — OKV Business Management System')
      : (isTrial ? 'Your free trial ends in ' + sub.daysLeft + ' day(s)' : 'Your subscription is due in ' + sub.daysLeft + ' day(s)');

    const statusLine = sub.expired
      ? 'Access for your whole team will be blocked at next login until you renew.'
      : 'You have ' + sub.daysLeft + ' day(s) left on your ' + (r[U.businessName - 1] || 'organization') + ' account.';

    try {
      sendAppEmail(email, subject, null,
        statusLine + '<br><br>' +
        nextPlanLine + '<br><br>' +
        'To renew: open the <strong>Subscription</strong> tab in your dashboard, pay to the account shown ' +
        '(or use a payment gateway if enabled), submit your proof, and you\'ll get a confirmation email — ' +
        'usually within the hour.<br><br>' +
        settings.supportEmail + ' · ' + settings.supportPhone + ' · ' + settings.supportWebsite
      );
      sh.getRange(i + 1, U.reminderSentAt).setValue(nowIso());
    } catch (e) { /* one failed email shouldn't stop reminders to everyone else */ }
  }
}

// ============================================================================
// CELL-CAPACITY MONITORING — per-tenant spreadsheet usage against the 10,000,000-
// cell Google Sheets limit. Runs on a time-based trigger (see
// createCapacityMonitoringTrigger() below), NOT on every page load / request.
// Results are stored in the Registry sheet and surfaced only on the Super Admin
// dashboard's Storage tab — org Admins/Users never see this.
// ============================================================================

// Sums actually-used cells (last row × last column with content) across every tab
// in a spreadsheet — not the default 1000x26 grid every new sheet/tab starts with.
function computeSpreadsheetCellUsage(ss) {
  let total = 0;
  ss.getSheets().forEach(sheet => {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow > 0 && lastCol > 0) total += lastRow * lastCol;
  });
  return total;
}

// Growth rate (cells/day) for one org, from CapacityHistory entries within the last
// `windowDays` (e.g. 30 or 90) — a simple slope between the oldest and newest check
// in that window. Returns 0 if there isn't at least two data points yet (first run).
function computeGrowthRate(orgId, historySh, windowDays) {
  const vals = historySh.getDataRange().getValues();
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const points = [];
  for (let i = 1; i < vals.length; i++) {
    if (vals[i][0] !== orgId) continue;
    const t = new Date(vals[i][1]).getTime();
    if (t >= cutoff) points.push({ t, cells: Number(vals[i][2]) || 0 });
  }
  if (points.length < 2) return 0;
  points.sort((a, b) => a.t - b.t);
  const first = points[0], last = points[points.length - 1];
  const daysBetween = (last.t - first.t) / (24 * 60 * 60 * 1000);
  if (daysBetween < 1) return 0;
  return (last.cells - first.cells) / daysBetween;
}

function readableDuration(days) {
  if (days === null || days === undefined || isNaN(days)) return '';
  if (days <= 0) return 'Already at/past 90%';
  if (days < 30) return Math.round(days) + ' day(s)';
  if (days < 365) return Math.round(days / 30) + ' month(s)';
  const yrs = Math.floor(days / 365);
  const remMonths = Math.round((days % 365) / 30);
  return yrs + ' year(s)' + (remMonths ? ' ' + remMonths + ' month(s)' : '');
}

// Keeps CapacityHistory from growing forever — trims entries older than ~180 days.
// The sheet is tiny (one row per org per check) so this is mostly good housekeeping.
function trimCapacityHistory() {
  const sh = capacityHistorySheet();
  if (!sh) return;
  const vals = sh.getDataRange().getValues();
  const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const rowsToDelete = [];
  for (let i = 1; i < vals.length; i++) {
    const t = new Date(vals[i][1]).getTime();
    if (t < cutoff) rowsToDelete.push(i + 1);
  }
  for (let i = rowsToDelete.length - 1; i >= 0; i--) sh.deleteRow(rowsToDelete[i]);
}

// The main check — wire this up as a daily or weekly time-driven trigger (see
// createCapacityMonitoringTrigger()). For every tenant in the Registry: measures
// current cell usage, logs it to CapacityHistory, derives a growth rate from the
// last 90 days of history, estimates time remaining to ~90% capacity, sets a
// status flag (Healthy / Monitor at 70%+ / Action Needed at 85%+) with a
// recommended next step, writes it all back to the Registry row, and emails the
// Super Admin once when a tenant newly crosses into "Action Needed" (not every run).
function checkAllTenantCapacities() {
  const sh = registrySheet();
  const historySh = capacityHistorySheet();
  if (!sh || !historySh) { Logger.log('Registry or CapacityHistory sheet is missing — see README.'); return; }
  const vals = sh.getDataRange().getValues();
  const settings = getSettings();

  for (let i = 1; i < vals.length; i++) {
    const orgId = vals[i][R.orgId - 1];
    const spreadsheetId = vals[i][R.spreadsheetId - 1];
    if (!orgId || !spreadsheetId) continue;

    let cellsUsed;
    try {
      const ss = SpreadsheetApp.openById(spreadsheetId);
      cellsUsed = computeSpreadsheetCellUsage(ss);
    } catch (e) {
      continue; // spreadsheet inaccessible/deleted this run — leave its last-known stats alone
    }

    const checkedAt = nowIso();
    historySh.appendRow([orgId, checkedAt, cellsUsed]);

    const growth = computeGrowthRate(orgId, historySh, 90);
    const pctUsed = cellsUsed / CELL_LIMIT;
    const target90 = CELL_LIMIT * 0.9;
    const estDaysRemaining = (growth > 0 && cellsUsed < target90) ? Math.round((target90 - cellsUsed) / growth) : null;

    const statusFlag = pctUsed >= 0.85 ? 'Action Needed' : (pctUsed >= 0.70 ? 'Monitor' : 'Healthy');
    const recommendedAction = statusFlag === 'Action Needed'
      ? 'Archive older records into a separate archive spreadsheet, or split this tenant\u2019s data across an additional spreadsheet soon.'
      : statusFlag === 'Monitor'
        ? 'Keep an eye on growth. Consider archiving older records in the next few months.'
        : 'No action needed.';

    const prevStatus = vals[i][R.statusFlag - 1];
    sh.getRange(i + 1, R.cellsUsed).setValue(cellsUsed);
    sh.getRange(i + 1, R.cellLimit).setValue(CELL_LIMIT);
    sh.getRange(i + 1, R.pctUsed).setValue(pctUsed);
    sh.getRange(i + 1, R.growthCellsPerDay).setValue(growth || 0);
    sh.getRange(i + 1, R.estDaysRemaining).setValue(estDaysRemaining === null ? '' : estDaysRemaining);
    sh.getRange(i + 1, R.estReadableRemaining).setValue(readableDuration(estDaysRemaining));
    sh.getRange(i + 1, R.statusFlag).setValue(statusFlag);
    sh.getRange(i + 1, R.recommendedAction).setValue(recommendedAction);
    sh.getRange(i + 1, R.lastCheckedAt).setValue(checkedAt);

    // Email alert only on the transition INTO "Action Needed" — not every run — so it's
    // informative rather than noisy. It naturally fires again if usage ever drops back
    // below 85% (e.g. after an archive) and then crosses 85% again later.
    if (statusFlag === 'Action Needed' && prevStatus !== 'Action Needed') {
      try {
        const businessName = vals[i][R.businessName - 1] || orgId;
        sendAppEmail(settings.supportEmail,
          'Action needed: ' + businessName + ' is nearing the Sheets cell limit',
          null,
          '<strong>' + businessName + '</strong> is at ' + Math.round(pctUsed * 100) + '% of the 10,000,000-cell ' +
          'Google Sheets limit for its tenant spreadsheet.<br><br>' +
          recommendedAction + '<br><br>' +
          'Estimated time to 90%: ' + (readableDuration(estDaysRemaining) || 'not enough growth history yet') + '.<br><br>' +
          'Full details are on the Super Admin dashboard\u2019s Storage tab.'
        );
        sh.getRange(i + 1, R.actionAlertSentAt).setValue(nowIso());
      } catch (e) { /* alert failure shouldn't block the rest of the check */ }
    }
  }
  trimCapacityHistory();
}

// One-time setup: run this ONCE from the Apps Script editor (function dropdown →
// createCapacityMonitoringTrigger → Run) to install the weekly automatic check. Safe to
// re-run — it removes any previous trigger for this function first. Switch everyDays(7)
// to everyDays(1) if you'd rather check daily.
function createCapacityMonitoringTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkAllTenantCapacities') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkAllTenantCapacities').timeBased().everyDays(7).atHour(2).create();
  Logger.log('Weekly cell-capacity check trigger installed (runs checkAllTenantCapacities ~2am).');
}

// ---------------- Super Admin: storage/capacity dashboard ----------------

function handleSuperAdminGetCapacity(body) {
  requireSuperAdmin(body);
  const sh = registrySheet();
  if (!sh) return { ok: true, orgs: [] };
  const vals = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (!r[R.orgId - 1]) continue;
    out.push({
      orgId: r[R.orgId - 1], businessName: r[R.businessName - 1], spreadsheetUrl: r[R.spreadsheetUrl - 1],
      cellsUsed: Number(r[R.cellsUsed - 1]) || 0, cellLimit: Number(r[R.cellLimit - 1]) || CELL_LIMIT,
      pctUsed: Number(r[R.pctUsed - 1]) || 0, estReadableRemaining: r[R.estReadableRemaining - 1] || '',
      statusFlag: r[R.statusFlag - 1] || 'Healthy', recommendedAction: r[R.recommendedAction - 1] || '',
      lastCheckedAt: r[R.lastCheckedAt - 1] || ''
    });
  }
  out.sort((a, b) => (b.pctUsed || 0) - (a.pctUsed || 0));
  return { ok: true, orgs: out };
}

// Lets the Super Admin trigger an immediate check from the dashboard instead of waiting
// for the weekly trigger — useful right after setup or when investigating a specific org.
// With a large number of tenants this can take a while; Apps Script's per-execution limit
// (6 minutes) applies same as any other function here.
function handleSuperAdminRunCapacityCheckNow(body) {
  requireSuperAdmin(body);
  checkAllTenantCapacities();
  return handleSuperAdminGetCapacity(body);
}

// ---------------- one-time setup: seed the Super Admin account ----------------
// ==================== ONE-CLICK SETUP (no manual tab-creation, ever) ====================
// Adds a menu to THIS spreadsheet (the master/control sheet) so first-time setup — and
// re-setup after pasting in a new Code.gs — never requires manually creating tabs, typing
// header rows by hand, or hunting through the Apps Script editor's function dropdown.
// The menu appears the next time you open (or refresh) this Google Sheet. If it doesn't
// show up right away, run any function once from the Apps Script editor (▶ Run) to grant
// permissions, then reload the Sheet.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚙️ OKV System Setup')
    .addItem('▶ Run full setup (tabs + Super Admin + triggers)', 'runFullMasterSetup')
    .addSeparator()
    .addItem('1. Create Master Sheet tabs only', 'setupMasterSpreadsheet')
    .addItem('2. Create / reset Super Admin account only', 'seedSuperAdminFromMenu')
    .addItem('3. Install / repair triggers only', 'installAllTriggers')
    .addSeparator()
    .addItem('Migrate legacy Data tab (upgrades only)', 'migrateExistingDataToPerTenant')
    .addToUi();
}

// The spec every Master Sheet tab is built from — headers pulled from the very same
// constants the rest of Code.gs reads/writes, so this can never drift out of sync with
// what the backend actually expects.
function masterSheetSpec() {
  return [
    { name: USERS_SHEET, headers: USER_HEADERS },
    { name: MESSAGES_SHEET, headers: MESSAGE_HEADERS },
    { name: PAYMENTS_SHEET, headers: PAYMENT_HEADERS },
    { name: SETTINGS_SHEET, headers: SETTINGS_HEADERS },
    { name: REGISTRY_SHEET, headers: REGISTRY_HEADERS },
    { name: CAPACITY_HISTORY_SHEET, headers: CAPACITY_HISTORY_HEADERS }
  ];
}

// Creates every tab this system needs — Users, Messages, PaymentSubmissions, Settings,
// Registry, CapacityHistory — with the exact header row each backend function expects:
// bolded, colored, frozen, auto-sized. SAFE TO RE-RUN ANY TIME: a tab that already exists
// is left completely alone (your data is never touched, never re-created) — only tabs that
// are genuinely missing get created. Also removes Google's blank default "Sheet1" tab, but
// only if it's still empty.
function setupMasterSpreadsheet() {
  const spec = masterSheetSpec();
  const created = [];
  const already = [];
  spec.forEach(function (tab) {
    const existing = SS.getSheetByName(tab.name);
    if (existing) { already.push(tab.name); return; }
    const sh = SS.insertSheet(tab.name);
    sh.getRange(1, 1, 1, tab.headers.length).setValues([tab.headers]);
    sh.getRange(1, 1, 1, tab.headers.length).setFontWeight('bold').setBackground('#0f3d3e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, tab.headers.length);
    created.push(tab.name);
  });
  ['Sheet1', 'Sheet', 'Sheet 1'].forEach(function (n) {
    const s = SS.getSheetByName(n);
    if (s && s.getLastRow() === 0 && s.getLastColumn() === 0 && SS.getSheets().length > 1) SS.deleteSheet(s);
  });
  const msg = (created.length ? 'Created: ' + created.join(', ') + '.\n' : 'Nothing to create — ') +
    (already.length ? 'Already existed (left untouched): ' + already.join(', ') + '.' : '');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Master Sheet setup complete', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* not run from the Sheet UI */ }
  return { created: created, already: already };
}

// Menu-only wrapper: makes sure the Users tab exists before seeding, then shows the login
// details as a popup instead of only a Logger.log line. seedSuperAdmin() itself is
// unchanged and still works fine run directly from the Apps Script editor.
function seedSuperAdminFromMenu() {
  if (!usersSheet()) setupMasterSpreadsheet();
  seedSuperAdmin();
  try {
    SpreadsheetApp.getUi().alert(
      'Super Admin account ready',
      'Login: technologyokv@gmail.com\nPassword: OKV Business Management System557\n\n' +
      'Log in at login.html and change this password from the Super Admin dashboard\'s Account tab right away.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) { /* not run from the Sheet UI */ }
}

// Installs (or repairs) the two installable triggers this system needs, without ever
// duplicating them: the on-edit watcher for PaymentSubmissions status changes, and the
// daily reminder-email check. SAFE TO RE-RUN — any existing trigger for these two
// functions is removed first, then recreated once. (The weekly per-tenant storage-capacity
// trigger is separate and optional — see createCapacityMonitoringTrigger() — since it's
// only useful once you have real tenant spreadsheets to check.)
function installAllTriggers() {
  ['handleSheetEdit', 'sendSubscriptionReminders'].forEach(function (fn) {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t);
    });
  });
  ScriptApp.newTrigger('handleSheetEdit').forSpreadsheet(SS).onEdit().create();
  ScriptApp.newTrigger('sendSubscriptionReminders').timeBased().everyDays(1).atHour(8).create();
  const msg = '"handleSheetEdit" (on edit) and "sendSubscriptionReminders" (daily, ~8am) triggers are installed.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Triggers installed', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* not run from the Sheet UI */ }
}

// ONE CLICK for everything README.md's "Set up the Sheet" + trigger steps used to require
// doing by hand: creates every Master Sheet tab, seeds the Super Admin account, and
// installs both triggers, in that order. Safe to re-run any time (e.g. after pasting an
// updated Code.gs) — existing tabs/data/account are never wiped, only what's missing gets
// (re)created. Run it from the "⚙️ OKV System Setup" menu at the top of this spreadsheet.
function runFullMasterSetup() {
  const sheetResult = setupMasterSpreadsheet();
  seedSuperAdmin();
  installAllTriggers();
  const msg =
    (sheetResult.created.length ? 'Created tabs: ' + sheetResult.created.join(', ') + '.\n' : 'All tabs already existed.\n') +
    'Super Admin: technologyokv@gmail.com / OKV Business Management System557 (change this after first login).\n' +
    'Triggers installed: handleSheetEdit (on edit), sendSubscriptionReminders (daily).\n\n' +
    'Still separate, and only needed once you actually have organizations signed up:\n' +
    '• "Migrate legacy Data tab" — only if upgrading a deployment that already has data.\n' +
    '• Weekly per-tenant storage check — run createCapacityMonitoringTrigger() once from the Apps Script editor when you\'re ready.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('OKV System — full setup complete', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* not run from the Sheet UI */ }
}

// Run this once from the Apps Script editor (select seedSuperAdmin in the function dropdown,
// click Run) after pasting in Code.gs — or just use the "⚙️ OKV System Setup" menu above,
// which is now the recommended way. It's safe to re-run — it updates the existing row instead
// of duplicating it. Default login: technologyokv@gmail.com / OKV Business Management System557
// — change the password from the Super Admin dashboard's Account tab after your first login.
function seedSuperAdmin() {
  if (!usersSheet()) setupMasterSpreadsheet(); // self-heal: never fail just because tabs weren't created yet
  const username = 'technologyokv@gmail.com';
  const defaultPassword = 'OKV Business Management System557';
  const passwordHash = sha256HexGas(defaultPassword);
  const existing = findUserRow(username);
  if (existing) {
    setUserField(existing.row, 'passwordHash', passwordHash);
    setUserField(existing.row, 'isSuperAdmin', true);
    setUserField(existing.row, 'status', 'active');
    Logger.log('Super Admin already existed — password reset to the default and access confirmed.');
    return;
  }
  appendUserRow({
    orgId: '', userId: genId('usr'), username: username, email: username, phone: '',
    businessName: 'OKV Technology Consults', fullName: 'Olasile Kehinde Victor', passwordHash: passwordHash,
    roles: '[]', isAdmin: false, isSuperAdmin: true, status: 'active',
    subscriptionStatus: '', subscriptionPlan: '', billingState: '', subscriptionExpiry: '',
    createdAt: nowIso()
  });
  Logger.log('Super Admin created: ' + username + ' / ' + defaultPassword);
}

// Matches the client's sha256Hex() exactly (lowercase hex, no separators) so a password set
// here logs in correctly from the browser.
function sha256HexGas(str) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return raw.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}
