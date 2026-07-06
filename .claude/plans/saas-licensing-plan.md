# SaaS Licensing & Multi-Tier Subscription Control Plan

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│                    Firestore                                │
│  /system_status/config  (NEW — single doc)                 │
│    ├─ isActive: boolean                                    │
│    ├─ startDate: timestamp                                  │
│    ├─ endDate: timestamp                                    │
│    ├─ subscriptionHistory: [{action,date,duration,by}]     │
│    └─ usageCaps: { maxEmployees, maxProducts }             │
│                                                            │
│  /employees/{uid}                                          │
│    └─ role: 'super_admin' | 'admin' | 'user'              │
└────────────────────────────────────────────────────────────┘

Roles: super_admin (root owner) > admin (tenant) > user (employee)
  - super_admin: bypasses ALL subscription locks, INVISIBLE in employees list
  - admin: subject to subscription limits, can manage tenant data
  - user/guest: normal employees
```

## Phase 1: DB State & Ghost Mode

### 1A. Firestore Document Initialization
**File:** `core/vision-init.js` (modify `startSyncs()`)
**New File:** `core/vision-licensing.js` (new module)

Create a new module `vision-licensing.js` that:
1. Exposes `window.VisionLicensing` with methods:
   - `init()` — Called during bootstrap, sets up a real-time listener on `system_status/config`
   - `getStatus()` — Returns cached status object synchronously
   - `isSystemActive()` — Returns `true` if `isActive === true` AND `endDate` is in the future
   - `getWarningDays()` — Returns days remaining before endDate (null if > 3)
   - `getUsageCaps()` — Returns `{ maxEmployees, maxProducts }`
   - `renew(durationMonths)` — Admin write: extends endDate, appends history entry
   - `togglePause(resume)` — Admin write: sets isActive to true/false
   - `updateUsageCaps(caps)` — Admin write: updates usageCaps
   - `onStatusChanged(callback)` — Subscribe to real-time status changes

2. On init, creates a real-time Firestore listener on `system_status/config`:
   - The doc path is `system_status/config` (separate collection from existing `system/status`)
   - Reads `{ isActive, startDate, endDate, subscriptionHistory, usageCaps }`
   - Caches the data and emits change events via VisionConfig

3. **Initialization script** (run once manually or via bootstrap):
   If the doc does not exist on first read, seed it with defaults:
   ```
   {
     isActive: true,
     startDate: serverTimestamp(),
     endDate: serverTimestamp() + 14 days,      // 14-day trial
     subscriptionHistory: [{ action: 'created', date: serverTimestamp(), by: 'system' }],
     usageCaps: { maxEmployees: 5, maxProducts: 200 }
   }
   ```

### 1B. Add vision-licensing.js to Bootstrap
**File:** `core/vision-init.js`

Insert `vision-licensing.js` into the module load list (after `vision-firebase.js`):
```
"vision-licensing.js"   // needs VisionFirebase, VisionConfig, VisionAuth
```

In `initModules()`, call `window.VisionLicensing.init()`.

In `startSyncs()`, call `window.VisionLicensing.startSync()` to begin the real-time listener.

### 1C. Ghost Mode — Hide super_admin in Employees List
**File:** `pages/employees.js`

Modify the `_render()` and `_renderStats()` functions:
1. Filter out employees where `role === 'super_admin'` BEFORE counting stats and rendering rows.
2. Add a helper `_visibleEmployees()` that returns `_employees.filter(e => e.role !== 'super_admin')`.
3. Replace all references to `_employees` for display purposes with `_visibleEmployees()`.

**File:** `shared/sidebar.js`

Add a `super_admin` role label:
```
ROLE_LABEL = { super_admin: 'المالك', admin: 'مدير النظام', user: 'موظف', guest: 'ضيف' };
```

Also ensure `super_admin` users see ALL nav items (including admin-only ones). The current `isAdmin()` check in sidebar's init already handles this since `VisionAuth.isAdmin()` returns true for `super_admin`. No sidebar code change needed for nav visibility.

---

## Phase 2: Lockdown Mechanism

### 2A. Update AuthGuard with Subscription Check
**File:** `shared/auth-guard.js`

Insert a new check AFTER the Firebase auth listener confirms a user exists and VisionAuth has synced, but BEFORE calling `onReady`:

New function `_checkSystemLockdown(user)`:
```
1. If VisionAuth.isSuperAdmin() → return true (always bypass)
2. Read VisionLicensing.getStatus():
   a. If !status.isActive → redirect to suspended.html
   b. If status.endDate < Date.now() → redirect to suspended.html
   c. Otherwise → return true (proceed to onReady)
```

The `protect()` function flow becomes:
```
auth.onAuthStateChanged(fbUser)
  → if !fbUser: redirect login.html
  → _waitForVisionAuthUser(fbUser.uid)
    → if adminOnly && !isAdmin: redirect orders.html
    → _checkSystemLockdown(enrichedUser)
      → if locked: redirect suspended.html
      → else: call onReady(enrichedUser)
```

### 2B. Build suspended.html
**New File:** `suspended.html`
**New File (CSS):** `styles/pages/suspended.css`

Design:
- Full-page centered lock screen with the Nazamly logo
- Large lock icon (fa-lock)
- Arabic title: "النظام معلق حالياً"
- Message: "انتهت فترة الاشتراك أو تم تعليق النظام من قبل المالك. يرجى التواصل لاستئناف الخدمة."
- WhatsApp contact button (green, with fa-whatsapp icon) — link to a configurable phone number
- Below button: text "إذا كنت مالك النظام، يرجى تسجيل الدخول بحساب المالك للوصول."
- Small "تسجيل دخول" link at the bottom for super_admin bypass

The page loads the full Vision bootstrap (vision-init.js) so it can:
1. Check if the current visitor is super_admin via VisionAuth
2. If super_admin → auto-redirect to dashboard.html (locked only for tenants)
3. Otherwise → show the suspended UI

CSS: Dark theme matching the existing auth.css style, with a red/amber accent for the lock icon.

---

## Phase 3: The Control Panel

### 3A. Dashboard HTML — Super Admin Panel Section
**File:** `dashboard.html`

Add a new section AFTER the existing `.page-content` main area, wrapped in a div that defaults to `display:none`:
```
<div id="superAdminPanel" style="display:none;">
  <!-- Subscription Status Card -->
  <div class="dash-panel" data-panel="subscription">
    <div class="panel-header">الاشتراك وصلاحيات النظام</div>
    <div class="panel-body">
      <!-- Active/Inactive status badge -->
      <!-- Countdown timer: "X أيام متبقية" -->
      <!-- Start/End dates display -->
      <!-- Pause/Resume toggle button -->
    </div>
  </div>

  <!-- Renewal Card -->
  <div class="dash-panel" data-panel="renewal">
    <div class="panel-header">تجديد الاشتراك</div>
    <div class="panel-body">
      <!-- 4 duration buttons: 1, 3, 6, 12 months -->
      <!-- Each button triggers VisionLicensing.renew(months) -->
    </div>
  </div>

  <!-- Usage Caps Card -->
  <div class="dash-panel" data-panel="usage-caps">
    <div class="panel-header">حدود الاستخدام</div>
    <div class="panel-body">
      <!-- maxEmployees input -->
      <!-- maxProducts input -->
      <!-- Save button -->
    </div>
  </div>

  <!-- Subscription History Table -->
  <div class="dash-panel" data-panel="history">
    <div class="panel-header">سجل الاشتراك</div>
    <div class="panel-body">
      <!-- Table: date, action, duration, performed by -->
    </div>
  </div>
</div>
```

### 3B. Dashboard JS — Super Admin Panel Logic
**File:** `pages/dashboard.js`

Extend `_setupDangerZone()` or create a companion `_setupSuperAdminPanel()`:

1. **Visibility gate:** Show `#superAdminPanel` only if `VisionAuth.isSuperAdmin()`.
2. **Real-time subscription data:** Subscribe via `VisionLicensing.onStatusChanged()` to update the countdown, status badge, and history table whenever the Firestore doc changes.
3. **Pause/Resume toggle:**
   - Button shows "تعليق النظام" if active, "استئناف النظام" if paused.
   - Calls `VisionLicensing.togglePause(!currentlyActive)`.
   - On success: show toast confirmation.
4. **Renewal buttons:**
   - Each button (1, 3, 6, 12 months) calls `VisionLicensing.renew(months)`.
   - Calculates new endDate from current endDate (or now if expired).
   - On success: show toast with new expiry date.
5. **Usage caps form:**
   - Pre-fill inputs from `VisionLicensing.getUsageCaps()`.
   - Save button calls `VisionLicensing.updateUsageCaps({ maxEmployees, maxProducts })`.
6. **History table:** Iterate `subscriptionHistory` array from the cached status, render in reverse chronological order.

### 3C. Dashboard CSS — Super Admin Panel Styles
**File:** `styles/pages/dashboard.css`

Add styles for:
- `#superAdminPanel` — section divider, gold/amber accent border
- `.subscription-status` — active (green) / paused (red) badge
- `.countdown-timer` — large numeric display, amber when < 7 days, red when < 3 days
- `.renewal-btn-group` — flex row of duration buttons
- `.caps-form` — inline input + save button layout
- `.history-table` — compact table styling matching existing dashboard tables

---

## Phase 4: Enhancements

### 4A. Warning Banner (3-Day Countdown)
**Implementation location:** `shared/sidebar.js` or a dedicated `core/vision-licensing.js` method

When the sidebar initializes (or when VisionLicensing detects approaching expiry):
1. Check `VisionLicensing.getWarningDays()` — returns days remaining only if ≤ 3 and > 0.
2. If warning days exist AND user is not super_admin:
   - Inject a dismissible banner at the top of `.app-main` (before the `<main>` content).
   - Banner CSS class: `vision-banner` with type `warning` (yellow/amber).
   - Message: "تنتهي صلاحية الاشتراك خلال X أيام. يرجى التواصل مع مالك النظام للتجديد."
   - Dismiss button stores dismissal in `localStorage` with key `subWarningDismissed_<date>` — re-shows next day if still within warning window.

**Alternative approach (cleaner):**
Add a `_injectWarningBanner()` function in `vision-licensing.js` itself, called whenever the status listener fires and detects ≤3 days remaining. It checks `VisionAuth.isSuperAdmin()` and injects/dismisses the banner directly into the DOM. This keeps all licensing UI logic in one module.

**CSS additions in `styles/components.css`:**
- `.vision-banner--warning` variant with amber/yellow border and background

### 4B. Usage Caps Validation
**Files:** `pages/employees.js` (add employee), `pages/inventory.js` (add product)

1. **Employees cap:**
   - `pages/employees.js` — In the "Add Employee" handler, BEFORE creating the auth account:
     - Get `VisionLicensing.getUsageCaps().maxEmployees`
     - Count current visible employees (excluding super_admin)
     - If count >= maxEmployees → show modal error: "تم الوصول للحد الأقصى لعدد الموظفين ({max}). يرجى ترقية الاشتراك."
     - Block account creation.
   - Note: super_admin account itself does NOT count toward the cap.

2. **Products cap:**
   - `pages/inventory.js` — In the "Add Product" handler:
     - Get `VisionLicensing.getUsageCaps().maxProducts`
     - Count current products
     - If count >= maxProducts → show modal error: "تم الوصول للحد الأقصى لعدد المنتجات ({max}). يرجى ترقية الاشتراك."
     - Block product creation.

---

## File Change Summary

| Phase | File | Action |
|-------|------|--------|
| 1 | `core/vision-licensing.js` | **CREATE** — new licensing module |
| 1 | `core/vision-init.js` | **EDIT** — add vision-licensing.js to load order + init calls |
| 1 | `pages/employees.js` | **EDIT** — filter out super_admin from display |
| 1 | `shared/sidebar.js` | **EDIT** — add super_admin role label |
| 2 | `shared/auth-guard.js` | **EDIT** — add _checkSystemLockdown() |
| 2 | `suspended.html` | **CREATE** — suspension lock screen page |
| 2 | `styles/pages/suspended.css` | **CREATE** — suspension page styles |
| 3 | `dashboard.html` | **EDIT** — add #superAdminPanel section |
| 3 | `pages/dashboard.js` | **EDIT** — add _setupSuperAdminPanel() |
| 3 | `styles/pages/dashboard.css` | **EDIT** — add panel styles |
| 4 | `core/vision-licensing.js` | **EDIT** — add _injectWarningBanner() |
| 4 | `styles/components.css` | **EDIT** — add warning banner variant |
| 4 | `pages/employees.js` | **EDIT** — add maxEmployees cap check |
| 4 | `pages/inventory.js` | **EDIT** — add maxProducts cap check |

## Implementation Order
Phases MUST be implemented sequentially: 1 → 2 → 3 → 4.
Each phase builds on the previous one:
- Phase 2's auth-guard reads from Phase 1's VisionLicensing.getStatus()
- Phase 3's control panel writes via Phase 1's VisionLicensing methods
- Phase 4's caps validation reads Phase 1's usageCaps, warning banner reads Phase 1's getWarningDays()