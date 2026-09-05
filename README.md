# OKV Business Management System — Phase 2 (Online / Subscribe)

Multi-tenant online version, fronted by a full marketing site, with messaging, a self-service
user manual, and a manual payment/upgrade flow. No automated payment gateway yet — upgrades are
confirmed by editing a Sheet, and the org's dashboard updates automatically once you do.

**OKV Technology Consults contact info** (used throughout the app — update in one place if it changes):
- Email: **technologyokv@gmail.com**
- Phone: **+234 810 414 1138**
- Website: **www.okvtechnology.com**

**Payment account** (shown on every org's Subscription tab):
- Account number: **8104141138**
- Bank: **OPay MFB**
- Account name: **Olasile Kehinde Victor**

---

## Architecture note (read first)

Google Apps Script Web Apps **cannot cleanly serve an installable PWA** — there's no stable
root path for `manifest.json` / `service-worker.js`, and Apps Script wraps pages in a sandboxed
iframe that breaks `beforeinstallprompt` and `Add to Home Screen`.

So this is split in two, which is also how you'd want it in production:

- **Backend = Google Apps Script** (`Code.gs`), bound to your Google Sheet, deployed as a Web App.
  It only serves JSON — no HTML.
- **Frontend = static files** (`frontend/` folder) hosted anywhere that serves plain HTML over
  HTTPS: GitHub Pages, Netlify, Firebase Hosting, or your own domain. All free. The frontend
  talks to the Apps Script Web App URL over `fetch()`.

## A note on how the pages are packaged

Every page in `frontend/` is **fully self-contained** — the shared CSS and JavaScript
(`style.css` and `app-common.js`, still included separately for reference/editing) are inlined
directly into each page's own `<style>`/`<script>` block. That means any single `.html` file works
correctly if it's opened or shared on its own. If you edit shared styling or logic, either edit
`style.css` / `app-common.js` and re-inline the change into each page, or edit the inlined copies
directly (in practice, `dashboard.html` is the primary source now — `app-common.js`/`style.css`
were last refreshed from it).

---

## The site map

| Page | Purpose |
|---|---|
| `index.html` | The page visitors land on. Marketing/sales page: logo, mobile-friendly icon nav that scroll-jumps to sections, "Start 7-day free trial" top-right, About, offline/online explainer, laptop/tablet/mobile section, Features, Why choose us, FAQ, footer (with contact info), CTAs throughout, 30-day money-back guarantee, "View live demo" button. |
| `demo.html` | The **real dashboard**, sandboxed — same code as `dashboard.html`, same topbar/tabs, but login and every backend call are swapped for dummy data via a shim. Products/Scan/POS/Records/Team chat are actually interactive against a private throwaway database; Team/Subscription/Account/outbound-customer-messaging actions are blocked with a message. A "Get started now" popup appears after ~8 seconds. |
| `pricing.html` | Monthly / Bi-Annual / Yearly toggle, each showing **Starter** and **Pro** tiers with features and a "best for" line, "Start for free" on each tier, contact info in the footer. |
| `signup.html` | Plan shown at the top from the URL. Fields: business name, full name, email (doubles as login username), phone, password. Create Account / Back to Pricing. |
| `install.html` | Post-signup / invite-link landing spot — install instructions only, no login form. |
| `login.html` | Login only — install button + iOS instructions, requires connectivity, forgot-password link. |
| `reset-password.html` | Validates the reset token before showing the new-password form. |
| `dashboard.html` | The actual app. Tabs: Team, Invite link, Products, Scan barcode, Point of sale, Records, Messages, Subscription, User manual, Account (Admin); or Products/Scan/POS/Records/Messages/User manual/Account (everyone else). Log out is in the topbar on every dashboard. Redirects a Super Admin session straight to `super-admin.html`. |
| `super-admin.html` | **New.** A separate dashboard for you (OKV Technology Consults), reached by logging in at `login.html` with the Super Admin account. Tabs: Organizations (every org's contact + subscription details, edit or suspend without opening the Sheet), Payments (confirm/reject any org's submission in one click), Announcements (email/WhatsApp/SMS to org admins individually or in bulk), Settings (edit the contact + bank payment details shown everywhere), Account (change your password). |

---

## What's new in this update

### 1. Messaging
- **Team chat** (Messages tab, everyone): broadcast to the whole org or message one teammate
  directly. Backed by a new `Messages` sheet.
- **Customers & suppliers** (Messages tab, Admin + Business Manager / Sales-POS Officer /
  Accountant-Finance Officer): pick contacts (add them as Records with type `Customer` or
  `Supplier` — name/email/phone/note), then message them individually or all at once.
  - **Email** — fully working via `MailApp`, one send per recipient, `{name}` merge tag for
    personalization.
  - **WhatsApp** — no API key needed: generates a `wa.me` click-to-chat link per recipient with
    your message pre-filled. True one-tap *bulk* WhatsApp sending isn't possible without the
    paid WhatsApp Business API, so this gives one button per recipient instead — still fast, no
    extra typing.
  - **SMS** — left as an honest stub. It returns a clear "not configured yet" message rather than
    pretending to send anything. Wire up a gateway (Termii, Africa's Talking, Twilio, etc.) in
    `handleSendSmsMessage()` in `Code.gs` when you're ready — the UI is already built for it.

### 2. User manual tab
Every dashboard (Admin and every role) gets a **User manual** tab, auto-filtered to what's
relevant: sections that apply to everyone, admin-only sections (team management, invite link,
subscription/upgrading), and role-specific sections (Cashier, Inventory/Store Officer, Purchasing
Officer, Accountant/Finance Officer, Auditor/Report Viewer). A **Download manual (.txt)** button
generates a plain-text copy of exactly what's shown, ready to keep or hand to a new hire.

### 3. Payment / upgrade submission (Subscription tab)
The Subscription tab now shows the payment account details above, plus a form:
- Instructions at the top (pay → fill form → wait for a status email → auto-upgrade on confirm).
- Business name / email / phone **auto-filled from the signed-in admin's account, editable**.
- Plan/tier dropdown (from the same catalog as the pricing page).
- Payment screenshot upload (compressed client-side before upload).
- **Submit** → saves to a new `PaymentSubmissions` sheet and emails your support address (see
  Settings below) with the details and the screenshot attached.
- A submission history table shows pending/confirmed/rejected status for that org.
- Once confirmed, the tab automatically shows the new **start date**, **due date**, and time
  remaining in a friendly days/weeks/months format (e.g. "23 days (about 3 weeks) remaining").

### 4. Automatic trial/subscription reminders — twice a month, not disruptive
- **Dashboard**: every time an Admin opens their dashboard, the bell icon badges and a banner
  appears once they're within a Super-Admin-configurable number of days (default 3) of their
  trial ending or subscription due date — live, computed on every page load, no setup needed.
- **Email**: a daily time-driven trigger (`sendSubscriptionReminders` — see the Triggers step
  below) checks every Admin, but only actually emails roughly **twice a month** (every 15 days by
  default, tunable) — never more often than that per organization, so it never feels spammy. Each
  email states the admin's current plan and exactly what it costs to continue on it, pulled live
  from the plan catalog so the price is always accurate. Both the cadence and the "how close to
  due before it starts" window are editable from the Super Admin dashboard's Settings tab.

### 5. Super Admin dashboard
You now have your own login and dashboard — `super-admin.html` — instead of only managing things
by opening the Sheet:
- **Organizations tab**: every org in one table (business, admin contact, team size, plan, status),
  with **Edit** (contact details, plan/tier, billing state, expiry) and **Suspend/Reactivate**
  (suspending locks out every user in that org immediately).
- **Payments tab**: every org's payment submissions, with one-click **Confirm**/**Reject** —
  the org admin is emailed automatically either way, exactly like editing the Sheet's status
  column, just without opening the Sheet.
- **Announcements tab**: message org admins individually or in bulk, by Email (real) or WhatsApp
  (`wa.me` links, same one-tap-per-recipient approach as org-level customer messaging). SMS is an
  honest stub until a gateway is configured.
- **Settings tab** — everything below is editable live, no code changes, ever:
  - *Contact & branding*: support email/phone/website, primary/accent color pickers, a logo URL,
    and a tagline. Colors apply instantly everywhere via CSS custom properties; the logo replaces
    every brand icon across the whole app the next time each page loads its settings.
  - *Email, SMS & WhatsApp*: the outbound email "from name" and reply-to; an SMS gateway API
    key + sender ID (just paste it in — SMS starts working the moment a key is present, no code
    changes); a WhatsApp Business API token + phone number ID (same — enables automatic WhatsApp
    the moment both are filled in, instead of the one-tap `wa.me` fallback).
  - *Manual payment methods*: add as many bank-transfer options as you like (label, bank, account
    number, account name, extra instructions), edit or delete any of them, and toggle each on/off
    without deleting it. Every enabled method shows on every org's Subscription tab.
  - *Payment gateways*: enable **Paystack** with a public + secret key and it's live immediately —
    admins get a real "Pay with card" button, checkout happens on Paystack's page, and the
    subscription is confirmed and extended automatically the moment payment succeeds (no manual
    review needed for card payments). **Flutterwave** and **Remita** have the same key/enable
    fields ready to fill in, but their checkout flow isn't wired yet — see the note in "out of
    scope" below.
  - *Pricing plans*: add, edit, or delete any plan/tier — tier name, billing cycle, price (both
    the raw Naira amount used for card charges and the display label/note), who it's "best for",
    and its feature list. Changes show up immediately on the pricing page, the signup page, every
    dashboard's upgrade cards, and reminder emails.
  - *Trial & reminders*: how many days the free trial lasts, how often (in days) reminder emails
    repeat, and how many days before due the dashboard's "due soon" warning starts showing.
- **Account tab**: change your password (see the default below — change it on first login).

### 6. Settings are now data, not hardcoded text
Contact info, branding, payment methods, gateway credentials, and the plan catalog used to be
constants in the code. They now live in a `Settings` sheet (key/value rows) that the Super Admin
dashboard edits directly. Every page that shows this info — the landing page footer, pricing page,
signup page, and every dashboard's Subscription tab — pulls the live values on load via a
`getPublicSettings` call, falling back to sensible defaults if offline. Secrets (API keys, the
Paystack *secret* key) are never included in that public call — only `superAdminGetSettings`
(Super-Admin-authenticated) returns those, to populate the Settings tab's edit form.

---

## 1. Set up the Sheet

**You no longer need to create any tabs or type any headers by hand.** Create a blank Google
Sheet, paste in `Code.gs` (see step 2 below), reload the Sheet, and a new
**⚙️ OKV System Setup** menu appears at the top. Click **▶ Run full setup (tabs + Super Admin +
triggers)** and it will, in one go:

1. Create all six Master Sheet tabs (`Users`, `Messages`, `PaymentSubmissions`, `Settings`,
   `Registry`, `CapacityHistory`) with the exact header row each already bolded and frozen.
2. Create your **Super Admin account** (`technologyokv@gmail.com` / `OKV Business Management System557`
   — change this from the Super Admin dashboard's Account tab right after your first login) and
   pop up the login details.
3. Install both required triggers (`handleSheetEdit` on-edit, `sendSubscriptionReminders` daily).

It's **safe to run again any time** — existing tabs, data, and your account are never wiped;
only whatever's missing gets (re)created. The reference tables below are just documentation of
what gets created — you don't need to build them by hand. **This spreadsheet is now the
MASTER/CONTROL spreadsheet** — see [Multi-tenant architecture](#multi-tenant-architecture--per-org-spreadsheets)
further down for how transactional business data (`Data`) lives in a dedicated spreadsheet per
organization instead of here.

If the menu doesn't appear right after pasting the code, open **Extensions → Apps Script**, run
any function once (e.g. `onOpen`) to grant permissions, then reload the Sheet tab. From then on
the menu appears automatically every time you open this spreadsheet.

Two extra one-time items still need doing manually from the Apps Script editor, since they're
either optional or only relevant once you have real data — see step 2 below for exactly where:
running `migrateExistingDataToPerTenant` (**only if upgrading** an existing deployment that
already has data in a shared `Data` tab), and `createCapacityMonitoringTrigger` (the weekly
per-tenant storage check — only useful once you have real tenant spreadsheets to check).

### `Users` tab

| orgId | userId | username | email | phone | businessName | fullName | passwordHash | roles | isAdmin | isSuperAdmin | status | orgSuspended | subscriptionStatus | subscriptionPlan | billingState | subscriptionStartDate | subscriptionExpiry | reminderSentAt | resetToken | resetTokenExpiry | authToken | createdAt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

- `username` — for public signups this is set to their email address (they log in with it).
- `roles` — JSON array string, e.g. `["Cashier","Sales / POS Officer"]`. Empty until the admin assigns roles.
- `isAdmin` — `TRUE`/`FALSE`. Signups always create `TRUE`. Blank/`FALSE` for the Super Admin row.
- `isSuperAdmin` — `TRUE` only on your own row (see `seedSuperAdmin()` below). Everyone else is blank/`FALSE`.
- `status` — `active` / `suspended` (per-user, set by an org's Admin).
- `orgSuspended` — `TRUE`/`FALSE`, **only meaningful on the Admin's own row**; set by you from the
  Super Admin dashboard's Organizations tab (or by hand here) to lock out an entire org at once.
- `subscriptionStatus` / `subscriptionPlan` / `billingState` / `subscriptionStartDate` /
  `subscriptionExpiry` — **only meaningful on the Admin's own row**; the whole org is gated off
  the Admin's row. On signup: `subscriptionStatus=active`, `billingState=trial`,
  `subscriptionPlan` = the tier/cycle picked on pricing, `subscriptionStartDate`=now,
  `subscriptionExpiry`=7 days out. These are updated **automatically** when you confirm a payment
  submission (from the Sheet or the Super Admin dashboard) — you shouldn't normally need to touch
  them by hand, but you can for manual overrides.
- `reminderSentAt` — set automatically by the daily reminder trigger (see step 7) so it only
  emails each admin once per day; cleared automatically whenever a payment is confirmed.
- `resetToken` / `resetTokenExpiry` — used only for the admin email-reset flow; blank otherwise.
- `authToken` — regenerated on every login; blanked out when suspended (per-user or whole org).
- `createdAt` — set once; shown in the dashboard's Team tab.

### `Data` tab — legacy, pre-migration only

| orgId | recordId | userId | type | payload | updatedAt | deleted | createdAt |
|---|---|---|---|---|---|---|---|

**If you're setting this up fresh, skip this tab entirely** — new orgs get their transactional
data in their own per-tenant spreadsheet automatically (see below). This tab only matters if
you're upgrading an existing deployment that already has a shared `Data` tab full of records —
in that case, keep it as-is until you've run the one-time migration described in
[Multi-tenant architecture](#multi-tenant-architecture--per-org-spreadsheets); the migration
reads from whichever of `type`, `payload` etc. you already have (`Sale`, `Expense`, `Purchase`,
`Income`, `Note`, `Product`, `Customer` / `Supplier`) and copies it into each org's new spreadsheet.

### `Registry` tab — new

| orgId | businessName | spreadsheetId | spreadsheetUrl | createdAt | cellsUsed | cellLimit | pctUsed | growthCellsPerDay | estDaysRemaining | estReadableRemaining | statusFlag | recommendedAction | lastCheckedAt | actionAlertSentAt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

The master tenant registry — one row per organization, mapping its `orgId` to the ID/URL of its
own dedicated spreadsheet. **Never edit `spreadsheetId` by hand** — everything past `createdAt` is
written automatically by `createTenantSpreadsheet()` (on signup) and `checkAllTenantCapacities()`
(the capacity-check trigger). This sheet holds no transactional data, only registry + capacity
metadata, so it stays tiny no matter how big your tenants' own spreadsheets get.

### `CapacityHistory` tab — new

| orgId | checkedAt | cellsUsed |
|---|---|---|

A lightweight log — one row per org per capacity check — used only to compute a growth rate
(cells added per day, over the last 90 days). Auto-trimmed to the last ~180 days by the capacity
checker, so it never grows unbounded either.

### `Messages` tab

| orgId | messageId | fromUserId | fromUsername | toUserId | toLabel | body | createdAt |
|---|---|---|---|---|---|---|---|

Internal team chat. `toUserId` blank = broadcast to the whole org; otherwise a direct message
(visible to sender, recipient, and — since `getInternalMessages` also returns anything the
current user sent — no one else).

### `PaymentSubmissions` tab

| orgId | submissionId | submittedByUserId | businessName | email | phone | planRequested | screenshotDataUrl | status | submittedAt | decidedAt | decisionNote |
|---|---|---|---|---|---|---|---|---|---|---|---|

- `status` starts at `pending`. Confirm or reject either by typing `confirmed`/`rejected` directly
  into this column for that row (see step 6), **or** from the Super Admin dashboard's Payments
  tab — both do exactly the same thing.
- `decisionNote` is optional — fill it in (e.g. "screenshot unreadable, please resend") before
  rejecting if you want that reason included in their email (the dashboard's Reject button also
  prompts for this).
- `screenshotDataUrl` holds the compressed image as a data URL — view it via the dashboard's
  Payments tab **View** link, by pasting the cell's value into a browser address bar, or the
  emailed attachment.

### `Settings` tab

| key | value |
|---|---|

Row 1 is the header; every row after that is one setting. Leave it empty to start — the app falls
back to sensible defaults (from `DEFAULT_SETTINGS` in `Code.gs`) until you save something from the
Super Admin dashboard's Settings tab, which creates/updates these rows for you — you never need to
add rows here by hand. The keys it uses:

- **Contact**: `supportEmail`, `supportPhone`, `supportWebsite`
- **Branding**: `brandPrimaryColor`, `brandAccentColor`, `brandLogoUrl`, `brandTagline`
- **Email**: `emailFromName`, `emailReplyTo`
- **SMS**: `smsProvider`, `smsApiKey`, `smsSenderId`
- **WhatsApp**: `whatsappToken`, `whatsappPhoneId`
- **Manual payment methods**: `manualPaymentMethods` — a JSON array, e.g.
  `[{"id":"...","label":"Bank transfer","bank":"OPay MFB","accountNumber":"...","accountName":"...","instructions":"","enabled":true}]`
- **Payment gateways**: `paystackEnabled`/`paystackPublicKey`/`paystackSecretKey`,
  `flutterwaveEnabled`/`flutterwavePublicKey`/`flutterwaveSecretKey`,
  `remitaEnabled`/`remitaMerchantId`/`remitaApiKey`
- **Plans**: `planCatalog` — a JSON array of plan objects (tier, cycle, amount, priceLabel,
  billedNote, suited, features)
- **Tuning**: `trialDays`, `reminderIntervalDays`, `reminderDaysBeforeDue`

You'll never need to hand-edit JSON in these cells — the Settings tab's Payment methods and
Pricing plans sections have full add/edit/delete UI that writes the JSON for you.

## Multi-tenant architecture — per-org spreadsheets

Each organization's transactional data now lives in **its own Google Spreadsheet**, created
automatically the moment they sign up. The master spreadsheet (this one) never holds that
data — it only holds the `Registry` tab mapping `orgId → spreadsheet ID`, plus `Users`,
`Messages`, `PaymentSubmissions`, and `Settings`, which stay put because they're small,
per-user/per-org account and config data rather than the kind of thing that grows toward
Sheets' 10,000,000-cell limit.

**How it resolves at runtime**: every backend function that needs an org's business data calls
`getOrgSpreadsheet(orgId)` — this is the *only* place that ever opens a tenant spreadsheet, and
it always reads the ID from the `Registry` tab rather than assuming "the active spreadsheet."
If an org somehow has no `Registry` row yet (a fresh signup mid-creation, or an org from before
this architecture that hasn't been migrated), `getOrgSpreadsheet()` self-heals: it creates the
tenant spreadsheet on the spot and copies over any matching rows still sitting in the legacy
`Data` tab, so nothing ever breaks waiting on a manual migration.

**One-time setup after pasting the new `Code.gs`:**

1. Add the `Registry` and `CapacityHistory` tabs to this spreadsheet (headers above).
2. If you have an **existing deployment with real data already in the shared `Data` tab**, run
   `migrateExistingDataToPerTenant` once from the Apps Script editor (function dropdown → select
   it → Run). It creates a spreadsheet per existing org, copies their rows over, and renames the
   old `Data` tab to `Data_Legacy_Archived_<date>` so it's kept for reference but nothing reads
   from it going forward. Safe to re-run — orgs that already migrated are skipped. If you have a
   lot of organizations and hit Apps Script's 6-minute execution limit, just click Run again.
   **If you're starting fresh (no existing data), skip this step** — new signups create their
   tenant spreadsheet automatically.
3. Run `createCapacityMonitoringTrigger` once (same way) to install the **weekly** automatic
   cell-usage check for every tenant. Open the function and change `everyDays(7)` to
   `everyDays(1)` first if you'd rather it run daily.
4. Re-authorize the script when prompted — creating spreadsheets needs Drive/Sheets scopes
   beyond what the original single-spreadsheet version needed.

**Super Admin dashboard → Storage tab**: shows every org's usage (% of the 10M-cell limit),
estimated time remaining until ~90% at current growth, a status flag (**Healthy** under 70%,
**Monitor** at 70%+, **Action Needed** at 85%+) with a recommended next step, a link to open
that org's spreadsheet directly, and a "Check now" button to force an immediate refresh instead
of waiting for the weekly trigger. This tab is Super-Admin-only — org Admins and Users never see
capacity data, on this or any other screen. You also get an email (to `supportEmail`) the moment
any tenant first crosses into "Action Needed" — not on every subsequent weekly check, just the
transition, so it's informative rather than noisy.

## 2. Deploy the Apps Script backend

1. In the Sheet: **Extensions → Apps Script**.
2. Delete the default `Code.gs` content, paste in this project's `Code.gs`.
3. Save, then reload the Google Sheet tab in your browser — the **⚙️ OKV System Setup** menu
   should now appear next to Help. Click **▶ Run full setup** and approve the permission
   prompts (Sheets/Drive access, Gmail send access for `MailApp`, and trigger-management access)
   — this replaces the old "create tabs by hand, seed the admin, add two triggers manually" steps
   entirely (see step 1 above for exactly what it does).
4. **Deploy → New deployment → Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the `/exec` URL you're given.

Prefer doing it by hand, or need to fix just one piece? The menu also has **1. Create Master
Sheet tabs only**, **2. Create/reset Super Admin account only**, and **3. Install/repair triggers
only** — each does just that one step and is safe to re-run. And if you ever need to run these
from the Apps Script editor's function dropdown instead of the Sheet's menu, the underlying
functions are `setupMasterSpreadsheet`, `seedSuperAdmin`, and `installAllTriggers` — same
behavior either way.

## 3. Configure and host the frontend

1. Open `frontend/app-common.js`, set `API_URL` to the `/exec` URL from step 2. (It's inlined into
   every page — update the inlined copy in each `.html` file too, or re-inline from this file.)
2. **Edit plan prices/features** in `PLAN_CATALOG` (inside `app-common.js`, inlined into every
   page) if you want to change them from the placeholders.
3. Contact info and payment details **no longer need editing in code** — `DEFAULT_SETTINGS` in
   `Code.gs` and the matching defaults in `app-common.js` are just the fallback shown before the
   `Settings` sheet has values (or if a page loads offline). Edit the real, live values any time
   from the Super Admin dashboard's Settings tab instead.
4. Upload the whole `frontend/` folder to your static host (GitHub Pages / Netlify / Firebase
   Hosting) so it's served over HTTPS at a stable URL.
5. Replace the placeholder icons in `frontend/icons/` with your real logo if you want proper branding.

## 4. Testing walkthrough

**A. Marketing site → demo → pricing → signup** — unchanged from before: `index.html` nav/CTAs,
`demo.html` live demo, `pricing.html` plan cards, `signup.html` with the plan pre-filled.

**B. Signup, trial, isolated orgs, products/barcode/POS, timestamps** — unchanged from before.

**C. Messaging**
1. As an Admin, go to **Records** and add two `Customer` records (name + email + phone) and one
   `Supplier`.
2. Go to **Messages → Customers & suppliers**, select one or more contacts (or leave none selected
   to target everyone), write a subject/body with `{name}` in it, choose **Email**, and send —
   check the recipient's inbox for the personalized message.
3. Switch the channel to **WhatsApp** and send — confirm a "Send to <name>" button appears per
   recipient and opens `wa.me` with your message pre-filled.
4. Switch to **SMS** and send — confirm you get the "not configured yet" message instead of a
   fake success.
5. Go to **Messages → Team chat**, send a broadcast, then log in as a team member and confirm they
   see it; send a direct message to one teammate and confirm only that person (and you) see it.

**D. User manual**
1. Open **User manual** as the Admin — confirm admin-only sections (Team, Invite link,
   Subscription) appear, plus general sections.
2. Log in as a Cashier — confirm only general sections plus "For Cashiers" appear (no admin
   sections). Click **Download manual (.txt)** and confirm the file matches what's on screen.

**E. Payment submission and auto-upgrade**
1. As Admin, go to **Subscription** — confirm the account number/bank/name block shows the OPay
   details, and the form is pre-filled with the admin's business name/email/phone (editable).
2. Pick a plan, upload any image as the "screenshot," and submit. Confirm: a row appears in
   `PaymentSubmissions` with `status=pending`, an email lands at your support address with the
   details and the image attached, and the dashboard's submission history shows "pending."
3. In the Sheet, type `confirmed` into that row's `status` cell. Within moments: the org admin
   gets a confirmation email with the new due date, and reloading the dashboard's Subscription tab
   shows `billingState=paid`, a real **start date**, **due date**, and "X days (about Y
   weeks/months) remaining."
4. Submit a second payment, then type `rejected` (optionally filling `decisionNote` first) — the
   admin should get a rejection email with your note, and the subscription should be unchanged.

**F. Everything else (roles, invite link, password resets, offline sync, receipts, subscription
alerts)** — unchanged from before.

**G. Super Admin dashboard**
1. Log in at `login.html` with `technologyokv@gmail.com` and the default password above — you
   land on `super-admin.html` (an org admin session never can, and a Super Admin session bounces
   off `dashboard.html` back here too).
2. **Organizations tab** — every org you've signed up in testing shows up here. Click **Edit** on
   one, change its business name or extend its expiry date, Save — refresh and confirm it stuck.
3. Click **Suspend** on a test org — log in as that org's admin in another window: blocked with
   "This organization has been suspended." **Reactivate** it — login works again.
4. **Payments tab** — submit a test payment from an org's Subscription tab, then come back here
   and **Confirm** it — check that org's dashboard: subscription extended, no need to touch the
   Sheet at all. Try **Reject** on another submission with a note — confirm the org gets the
   rejection email with your note included.
5. **Announcements tab** — select two orgs, send an Email announcement, confirm both admins
   receive it. Try WhatsApp — confirm it renders one `wa.me` link per selected org with a phone
   number.
6. **Settings tab** — try each section:
   - Change the support email and pick new colors, Save. Reload `index.html`'s footer,
     `pricing.html`'s footer, and an org's Subscription tab — confirm all three now show the new
     contact info and colors.
   - Add a second manual payment method, Save — confirm it now shows on an org's Subscription tab
     alongside the first. Disable one — confirm it disappears from the org's view but stays in
     your list here.
   - Enter test Paystack keys and enable it, Save — reload an org's Subscription tab and confirm a
     "Pay with card via Paystack" button now appears above the bank transfer options.
   - Edit a plan's price and Save — reload `pricing.html` and confirm the new price shows.
7. **Account tab** — change your password, log out, log back in with the new one.

**H. Trial/subscription reminder email**
1. In the Sheet, set a test org's `subscriptionExpiry` to 2 days from now.
2. Run `sendSubscriptionReminders` manually from the Apps Script editor (function dropdown → Run)
   — confirm that org's admin receives a reminder email, and `reminderSentAt` on their row is now
   set to today.
3. Run it again — confirm no second email is sent (already reminded today).
4. Confirm the dashboard already showed the "due soon" banner even before this email went out —
   that half is live/automatic and needs no trigger.

## Notes on what's intentionally out of scope here

- **Paystack is fully wired** (real checkout + auto-confirm) once you add your keys and enable it
  from the Settings tab. **Flutterwave and Remita are not** — their key/enable fields are captured
  and stored, ready for the same treatment, but nothing calls their APIs yet. Wiring either follows
  the same pattern as `handleInitPaystackPayment`/`handlePaystackCallback` in `Code.gs`: initialize
  a transaction server-side with the secret key, redirect the browser to the gateway's checkout
  page, verify the transaction when it calls back, then extend the org's subscription the same way
  the Paystack callback does. Say the word when you're ready for either.
- SMS sending is a stub until an SMS gateway API key is added from the Settings tab — the code path
  (`sendSmsViaProvider` in `Code.gs`) is Termii-shaped by default; swap it for a different
  provider's API if you use something else.
- Bulk WhatsApp sending is one-tap-per-recipient rather than a single "send all" button *unless*
  you add a WhatsApp Business API token + phone number ID from the Settings tab, at which point
  `sendWhatsappViaProvider` sends automatically instead.
- If you enable Paystack, its checkout needs to redirect back to your Apps Script Web App URL —
  that's automatic (`handlePaystackCallback` is wired to `?paystackCallback=1` on the same `/exec`
  URL you already deployed), no extra configuration needed beyond the keys themselves.
- The demo page (`demo.html`) never calls the real backend — every network action is mocked, and
  the record/chat data it lets you play with lives in its own separate offline database
  (`okv_biztrack_demo`), so it's safe to make public and never mixes with a real account's data.
- The Records tab (Sale/Expense/Purchase/Income/Note/Customer/Supplier) is a generic, working
  example of the offline-first sync mechanism rather than a full re-build of every Phase 1
  module — those can be layered onto the same `Data` sheet by adding more `type` values and forms.
- **Getting found on Google:** `frontend/robots.txt` and `frontend/sitemap.xml` are already set up
  for the public marketing pages, along with title/description/Open Graph tags on `index.html`,
  `pricing.html`, and `demo.html`, and `noindex` on every private/app page. See
  `GOOGLE_INDEXING_GUIDE.md` in the project root for the short one-time setup (swap in your real
  domain, verify ownership in Google Search Console, submit the sitemap).
