/**
 * VisionLicensing — SaaS Licensing & Subscription Control
 * =========================================================
 * Manages the Firestore document at `system_status/config` that
 * controls the commercial single-tenant SaaS subscription state.
 *
 * Two-Tier Role Hierarchy:
 *   super_admin  — root owner; bypasses ALL subscription locks
 *   admin        — client/tenant; subject to system subscription limits
 *
 * Firestore document: /system_status/config
 *   {
 *     isActive:             boolean,
 *     startDate:            timestamp,
 *     endDate:              timestamp,
 *     subscriptionHistory:  [{ action, date, durationMonths, by }],
 *     usageCaps:            { maxEmployees: number, maxProducts: number }
 *   }
 *
 * Usage:
 *   VisionLicensing.init()                // called during bootstrap
 *   VisionLicensing.startSync()           // begin real-time listener
 *   VisionLicensing.isSystemActive()      // synchronous check
 *   VisionLicensing.getWarningDays()      // null | days ≤ 3
 *   VisionLicensing.getUsageCaps()        // { maxEmployees, maxProducts }
 *   VisionLicensing.renew(12)             // extend by 12 months
 *   VisionLicensing.togglePause(false)    // pause the system
 *   VisionLicensing.updateUsageCaps({...})
 *   VisionLicensing.onStatusChanged(cb)   // subscribe to real-time changes
 */

(function (window) {
  'use strict';

  /* ─────────────────────────────────────────────
   * INTERNAL STATE
   * ───────────────────────────────────────────── */

  const _state = {
    initialized: false,
    syncing:     false,
    docData:     null,          // raw Firestore document data
    cached: {
      isActive:            true,
      startDate:           null,
      endDate:             null,
      subscriptionHistory: [],
      usageCaps:           { maxEmployees: 5, maxProducts: 200 }
    },
    callbacks:   [],           // onStatusChanged listeners
    unsubFn:     null          // Firestore listener unsubscribe
  };

  /* Default seed document used when system_status/config doesn't exist */
  const DEFAULT_DOC = {
    isActive:            true,
    startDate:           null,  // set as serverTimestamp on creation
    endDate:             null,  // computed: now + 14 days
    subscriptionHistory: [{ action: 'created', date: null, durationMonths: null, by: 'system' }],
    usageCaps:           { maxEmployees: 5, maxProducts: 200 }
  };

  /* ─────────────────────────────────────────────
   * HELPERS
   * ───────────────────────────────────────────── */

  function _log(msg) {
    console.log('[VisionLicensing] ' + msg);
  }
  function _err(msg, e) {
    console.error('[VisionLicensing] ' + msg, e || '');
  }

  /** Convert a Firestore Timestamp or ISO string to a JS Date */
  function _toDate(v) {
    if (!v) return null;
    if (typeof v === 'string') return new Date(v);
    if (typeof v.toDate === 'function') return v.toDate();
    if (v.seconds) return new Date(v.seconds * 1000);
    return null;
  }

  /** 1-month trial seed: now → +14 days */
  function _trialEndDate() {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d;
  }

  /** Ensure Firestore is available */
  function _dbAvailable() {
    return typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore();
  }

  /** Check if the current user is super_admin (bypasses all locks) */
  function _isSuperAdmin() {
    return window.VisionAuth && window.VisionAuth.isSuperAdmin();
  }

  /* ─────────────────────────────────────────────
   * CACHE UPDATE & NOTIFY
   * ───────────────────────────────────────────── */

  function _updateCache(docData) {
    if (!docData) return;

    const endDate    = docData.endDate ? _toDate(docData.endDate) : null;
    const startDate  = docData.startDate ? _toDate(docData.startDate) : null;
    const history    = Array.isArray(docData.subscriptionHistory) ? docData.subscriptionHistory : [];
    const usageCaps  = docData.usageCaps || { maxEmployees: 5, maxProducts: 200 };

    /*
     * Auto-expiry: if the system is still marked active but the
     * endDate has passed, automatically set isActive to false.
     * This ensures the subscription lockdown takes effect even
     * if the super_admin never manually pauses the system.
     *
     * We compare against the raw docData.isActive (the DB value)
     * and only write when the DB still says true. This prevents
     * repeated writes on every subsequent sync.
     */
    var now = Date.now();
    var endMs = endDate ? endDate.getTime() : null;
    var isDbActive = docData.isActive === true;
    var isExpired  = endMs !== null && now > endMs;

    if (isDbActive && isExpired) {
      _log('auto-expiry triggered: endDate=' + endDate.toISOString() +
        ' is in the past — setting isActive=false');
      /* Fire-and-forget — don't block the cache update */
      _autoExpireSystem();
      /* Update the cached isActive immediately so the real-time
         lockdown check below fires without waiting for the write
         to round-trip through Firestore */
      _state.cached = {
        isActive:            false,
        startDate:           startDate ? startDate.toISOString() : null,
        endDate:             endDate ? endDate.toISOString() : null,
        subscriptionHistory: history,
        usageCaps:           {
          maxEmployees: Number(usageCaps.maxEmployees) || 5,
          maxProducts:  Number(usageCaps.maxProducts)  || 200
        }
      };
    } else {
      _state.cached = {
        isActive:            isDbActive,
        startDate:           startDate ? startDate.toISOString() : null,
        endDate:             endDate ? endDate.toISOString() : null,
        subscriptionHistory: history,
        usageCaps:           {
          maxEmployees: Number(usageCaps.maxEmployees) || 5,
          maxProducts:  Number(usageCaps.maxProducts)  || 200
        }
      };
    }

    // Push key data into VisionConfig for cross-module access
    if (window.VisionConfig) {
      window.VisionConfig.set('licensing', _state.cached);
    }

    // Notify listeners
    _state.callbacks.forEach(cb => {
      try { cb(_state.cached); } catch (e) {
        _err('callback error', e);
      }
    });

    /* Check if warning banner should be shown/hidden */
    _checkBanner();

    /*
     * Real-time lockdown: if the system became inactive and the current
     * user is NOT super_admin, immediately redirect them to the suspended
     * lock screen. Without this, already-logged-in users would stay in
     * the app even after the super_admin pauses the system.
     *
     * Skip on login.html and suspended.html — those pages don't need
     * protection (login hasn't confirmed a user yet; suspended IS the
     * target page).
     */
    if (_state.cached.isActive === false) {
      var currentPage = (window.location.pathname || '').split('/').pop().toLowerCase();
      if (currentPage !== 'suspended.html' && currentPage !== 'login.html') {
        /* FIX (audit core #2): the licensing snapshot can resolve BEFORE
           VisionAuth finishes its async role chain — the raw _isSuperAdmin()
           check wrongly locked the owner out of dashboard.html (which holds
           the resume control) and could ping-pong suspended↔dashboard.
           Enforce only once the auth role has settled. */
        _enforceLockdownWhenAuthSettled();
      }
    }
  }

  /**
   * Wait (up to ~4s, matching auth-guard's budget) for VisionAuth to
   * resolve the current user + role, then redirect to suspended.html if
   * the system is still inactive and the user is not super_admin.
   */
  function _enforceLockdownWhenAuthSettled() {
    if (_isSuperAdmin()) { _log('system inactive — super_admin, staying put'); return; }
    if (_state.lockdownPending) return; // one timer at most
    _state.lockdownPending = true;

    var attempts = 0;
    var timer = setInterval(function () {
      attempts++;
      /* System reactivated while we were waiting — stand down. */
      if (_state.cached.isActive !== false) {
        clearInterval(timer);
        _state.lockdownPending = false;
        return;
      }
      if (_isSuperAdmin()) {
        clearInterval(timer);
        _state.lockdownPending = false;
        _log('system inactive — super_admin resolved, staying put');
        return;
      }
      var user = window.VisionAuth ? window.VisionAuth.getUser() : null;
      if (user || attempts >= 20) { // role chain done (or ~4s budget spent)
        clearInterval(timer);
        _state.lockdownPending = false;
        if (_state.cached.isActive === false && !_isSuperAdmin()) {
          _log('system inactive — redirecting non-super_admin to suspended.html');
          setTimeout(function () {
            window.location.replace('suspended.html');
          }, 100);
        }
      }
    }, 200);
  }

  /* ─────────────────────────────────────────────
   * WARNING BANNER (≤3 days expiry, non-super_admin)
   * ───────────────────────────────────────────── */

  /** Persisted dismiss key for localStorage — changes daily */
  function _bannerDismissKey() {
    var today = new Date();
    return 'subWarningDismissed_' +
      today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');
  }

  function _removeBanner() {
    var existing = document.getElementById('vision-sub-warning-banner');
    if (existing) existing.remove();
  }

  function _checkBanner() {
    /* Only inject banner on pages that have a .vision-app-root or .app-main
       (i.e. not on login.html or suspended.html itself) */
    var mount = document.querySelector('.app-main') || document.querySelector('.vision-app-root');
    if (!mount) return;

    var days = getWarningDays();

    /* No warning needed: either > 3 days, super_admin, or no endDate */
    if (days === null || days > 3) {
      _removeBanner();
      return;
    }

    /* Already expired or paused — the auth-guard lockdown handles this case;
       don't show a banner since non-super_admin users won't reach this page */
    if (days <= 0 && !_state.cached.isActive) {
      _removeBanner();
      return;
    }

    /* User dismissed this banner today */
    if (localStorage.getItem(_bannerDismissKey()) === '1') {
      _removeBanner();
      return;
    }

    /* Already injected */
    if (document.getElementById('vision-sub-warning-banner')) return;

    /* Build banner */
    var banner = document.createElement('div');
    banner.id = 'vision-sub-warning-banner';
    banner.className = 'vision-banner vision-banner--warning';
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-live', 'polite');

    var absDays = Math.abs(days);
    var dayWord = absDays === 1 ? 'يوم' : 'أيام';
    var statusWord = days > 0
      ? 'تنتهي صلاحية الاشتراك'
      : 'انتهت صلاحية الاشتراك منذ';

    banner.innerHTML =
      '<div class="vision-banner__body">' +
        '<i class="fas fa-triangle-exclamation vision-banner__icon" aria-hidden="true"></i>' +
        '<span class="vision-banner__text">' +
          statusWord + ' <strong>' + absDays + ' ' + dayWord + '</strong>. ' +
          (days > 0
            ? 'يرجى التواصل مع مالك النظام للتجديد.'
            : 'تم تعطيل الوصول. يرجى التواصل مع مالك النظام لاستئناف الخدمة.') +
        '</span>' +
      '</div>' +
      '<button class="vision-banner__dismiss" title="إغلاق" aria-label="إغلاق التنبيه">' +
        '<i class="fas fa-times" aria-hidden="true"></i>' +
      '</button>';

    /* Dismiss handler */
    banner.querySelector('.vision-banner__dismiss').addEventListener('click', function () {
      localStorage.setItem(_bannerDismissKey(), '1');
      _removeBanner();
    });

    /* Insert at top of mounting element */
    mount.insertBefore(banner, mount.firstChild);

    _log('warning banner injected (' + days + ' days)');
  }

  /* ─────────────────────────────────────────────
   * FIRESTORE WRITE HELPERS
   * ───────────────────────────────────────────── */

  function _assertWriteReady(fnName) {
    if (!_dbAvailable()) {
      throw new Error('[VisionLicensing] ' + fnName + ': Firestore not available');
    }
  }

  /**
   * Build a history entry for the subscription log.
   * @param {string} action - 'created' | 'renewed' | 'paused' | 'resumed' | 'caps_updated'
   * @param {number|null} durationMonths
   * @param {string} by - email or 'system'
   * @returns {Object}
   */
  /**
   * Fire-and-forget: set isActive=false with an 'expired' history entry.
   * Only called from _updateCache() when endDate has passed but DB still
   * says isActive=true. We use a concrete Timestamp, not serverTimestamp(),
   * because arrayUnion() does not accept sentinel tokens.
   */
  function _autoExpireSystem() {
    _assertWriteReady('_autoExpireSystem');
    var db  = firebase.firestore();
    var ref = db.collection('system_status').doc('config');

    var entry = _historyEntry('expired', null, 'system (auto-expire)');

    ref.update({
      isActive: false,
      subscriptionHistory: firebase.firestore.FieldValue.arrayUnion(entry)
    }).then(function () {
      _log('auto-expire write confirmed');
    }).catch(function (err) {
      console.error('[VisionLicensing] auto-expire write failed:', err);
    });
  }

  function _historyEntry(action, durationMonths, by) {
    /* Firestore does NOT support FieldValue.serverTimestamp() inside arrays
       or within arrayUnion() payloads. Use a client-side Timestamp.fromDate()
       instead — it's a concrete Timestamp value, not a sentinel token. */
    return {
      action,
      date: firebase.firestore.Timestamp.fromDate(new Date()),
      durationMonths: durationMonths || null,
      by: by || (window.VisionAuth && window.VisionAuth.getUser()
        ? window.VisionAuth.getUser().email
        : 'system')
    };
  }

  /**
   * Seed the system_status/config document if it doesn't exist.
   * Called once on first sync.
   */
  async function _seedDocument() {
    _assertWriteReady('_seedDocument');
    const db  = firebase.firestore();
    const ref = db.collection('system_status').doc('config');

    /* serverTimestamp() cannot be used inside arrays — use concrete Timestamps */
    const nowDate  = new Date();
    const nowTS    = firebase.firestore.Timestamp.fromDate(nowDate);
    const trialEnd = firebase.firestore.Timestamp.fromDate(_trialEndDate());

    await ref.set({
      isActive:            true,
      startDate:           nowTS,
      endDate:             trialEnd,
      subscriptionHistory: [{
        action:         'created',
        date:           nowTS,
        durationMonths: null,
        by:             'system'
      }],
      usageCaps: { maxEmployees: 5, maxProducts: 200 }
    });

    _log('seeded system_status/config with 14-day trial');
  }

  /* ─────────────────────────────────────────────
   * PUBLIC API
   * ───────────────────────────────────────────── */

  /**
   * Initialize the licensing module.
   * Must be called after Firebase and VisionAuth are ready.
   * Does NOT start the listener — call startSync() separately.
   */
  function init() {
    if (_state.initialized) {
      _log('already initialized');
      return;
    }

    if (!_dbAvailable()) {
      console.warn('[VisionLicensing] Firestore not available — operating with defaults');
      _state.initialized = true;
      return;
    }

    _state.initialized = true;
    _log('initialized');
  }

  /**
   * Start the real-time Firestore listener on system_status/config.
   * If the document doesn't exist, seeds it with a 14-day trial.
   */
  function startSync() {
    if (!_state.initialized) {
      console.warn('[VisionLicensing] startSync called before init() — initializing now');
      init();
    }

    if (_state.syncing) {
      _log('sync already active');
      return;
    }

    if (!_dbAvailable()) {
      console.warn('[VisionLicensing] Firestore not available — sync skipped');
      return;
    }

    _state.syncing = true;

    try {
      const ref = firebase.firestore().collection('system_status').doc('config');

      const unsub = ref.onSnapshot(
        async (doc) => {
          if (!doc.exists) {
            _log('document does not exist — seeding with defaults');
            try {
              await _seedDocument();
              // The snapshot will fire again after seeding
            } catch (e) {
              _err('seed failed', e);
            }
            return;
          }

          _state.docData = doc.data();
          _log('sync received: isActive=' + _state.docData.isActive);
          _updateCache(_state.docData);
        },
        (error) => {
          _err('sync listener error', error);

          /* FIX (audit core #4): reset the sync flag on error so the next
             startSync() call can retry — _state.syncing used to stay true
             forever, permanently disabling any retry path. */
          _state.syncing = false;

          // Keep operating with last-known-good cached state
          if (window.VisionOverlays && typeof window.VisionOverlays.toast === 'function') {
            window.VisionOverlays.toast({
              type: 'warning',
              title: 'تحذير: مشكلة في الاتصال',
              message: 'تعذر التحقق من حالة الاشتراك. النظام يعمل بالبيانات المحلية.',
              duration: 8000,
            });
          }

          /* FIX (audit core #4): retry once after 15s — permanent listener
             failures used to leave enforcement dead for the whole session. */
          setTimeout(function () {
            if (!_state.syncing && !_state.unsubFn) {
              _log('retrying licensing sync after error...');
              startSync();
            }
          }, 15000);
        }
      );

      _state.unsubFn = unsub;
      _log('sync started');
    } catch (e) {
      _err('startSync setup error', e);
      _state.syncing = false;
    }
  }

  /**
   * Check if the system is currently active for the given role.
   * super_admin always returns true.
   *
   * @returns {boolean}
   */
  function isSystemActive() {
    if (_isSuperAdmin()) return true;

    const c = _state.cached;
    if (!c.isActive) return false;

    if (c.endDate) {
      const end = new Date(c.endDate).getTime();
      if (Date.now() > end) return false;
    }

    return true;
  }

  /**
   * Get the number of days remaining before subscription expiry.
   * Returns null if more than 3 days remain or if the user is super_admin.
   * Returns 0 or negative if already expired.
   *
   * @returns {number|null}
   */
  function getWarningDays() {
    if (_isSuperAdmin()) return null;

    const c = _state.cached;
    if (!c.endDate) return null;

    const end  = new Date(c.endDate).getTime();
    const days = Math.ceil((end - Date.now()) / 86_400_000);

    // Only return when within 3-day warning window or already expired
    if (days <= 3) return days;
    return null;
  }

  /**
   * Get the full cached status object.
   * @returns {Object} { isActive, startDate, endDate, subscriptionHistory, usageCaps }
   */
  function getStatus() {
    return JSON.parse(JSON.stringify(_state.cached));
  }

  /**
   * Get the current usage caps.
   * @returns {Object} { maxEmployees, maxProducts }
   */
  function getUsageCaps() {
    return {
      maxEmployees: _state.cached.usageCaps.maxEmployees || 5,
      maxProducts:  _state.cached.usageCaps.maxProducts  || 200
    };
  }

  /**
   * Register a callback that fires whenever the subscription status changes.
   * Immediately called with the current cached state.
   *
   * @param {Function} callback — called with status object
   * @returns {Function} Unsubscribe
   */
  function onStatusChanged(callback) {
    _state.callbacks.push(callback);
    try { callback(_state.cached); } catch (_) { /* ignore */ }
    return () => {
      _state.callbacks = _state.callbacks.filter(c => c !== callback);
    };
  }

  /* ─────────────────────────────────────────────
   * ADMIN WRITE METHODS
   * (super_admin only — guard enforced at Firestore
   *  security rules level; UI checks via isSuperAdmin())
   * ───────────────────────────────────────────── */

  /**
   * Extend the subscription by a number of months.
   * Appends a 'renewed' entry to subscriptionHistory.
   *
   * @param {number} months — 1, 3, 6, or 12
   * @returns {Promise<void>}
   */
  async function renew(months) {
    _assertWriteReady('renew');

    if (!months || months <= 0) {
      throw new Error('[VisionLicensing] renew: months must be a positive number');
    }

    const db  = firebase.firestore();
    const ref = db.collection('system_status').doc('config');

    // Calculate new endDate from current endDate (or now if expired/missing)
    const base = _state.cached.endDate
      ? new Date(_state.cached.endDate)
      : new Date();
    if (base.getTime() < Date.now()) {
      base.setTime(Date.now());
    }

    /* FIX (audit core #6): setMonth overflows at month-ends (Jan 31 + 1
       month → Mar 3), silently granting/shortening days. Clamp to the
       last day of the target month. */
    const targetDay   = base.getDate();
    const targetMonth = base.getMonth() + months;
    base.setMonth(targetMonth);
    /* setMonth rolled over to the next month if the day doesn't exist there */
    if (base.getMonth() !== ((targetMonth % 12) + 12) % 12) {
      base.setDate(0); // last day of the previous month
    } else {
      base.setDate(targetDay);
    }

    const newEndDate = firebase.firestore.Timestamp.fromDate(base);
    const entry = _historyEntry('renewed', months);

    try {
      await ref.update({
        isActive: true,
        endDate:  newEndDate,
        subscriptionHistory: firebase.firestore.FieldValue.arrayUnion(entry)
      });

      _log('renewed by ' + months + ' months → new endDate: ' + base.toISOString());

      if (window.VisionOverlays && typeof window.VisionOverlays.toast === 'function') {
        window.VisionOverlays.toast({
          type: 'success',
          title: 'تم التجديد',
          message: 'تم تمديد الاشتراك ' + months + ' أشهر. تاريخ الانتهاء الجديد: ' +
            base.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' }),
          duration: 6000,
        });
      }
    } catch (e) {
      _err('renew failed', e);
      throw e;
    }
  }

  /**
   * Extend the subscription to a specific end date.
   * Used for custom-date renewal from the super admin panel.
   *
   * @param {string} isoDate — ISO date string for the new endDate
   * @returns {Promise<void>}
   */
  async function extendToDate(isoDate) {
    _assertWriteReady('extendToDate');

    if (!isoDate) {
      throw new Error('[VisionLicensing] extendToDate: isoDate required');
    }

    var targetDate = new Date(isoDate);
    if (isNaN(targetDate.getTime())) {
      throw new Error('[VisionLicensing] extendToDate: invalid date string');
    }

    if (targetDate.getTime() <= Date.now()) {
      throw new Error('[VisionLicensing] extendToDate: date must be in the future');
    }

    var db  = firebase.firestore();
    var ref = db.collection('system_status').doc('config');

    /* Calculate approximate duration months for the history entry */
    var base = _state.cached.endDate
      ? new Date(_state.cached.endDate)
      : new Date();
    if (base.getTime() < Date.now()) base.setTime(Date.now());
    var diffMonths = Math.round((targetDate.getTime() - base.getTime()) / (30 * 86_400_000) * 10) / 10;

    var newEndDate = firebase.firestore.Timestamp.fromDate(targetDate);
    var entry = _historyEntry('renewed', diffMonths);

    try {
      await ref.update({
        isActive: true,
        endDate:  newEndDate,
        subscriptionHistory: firebase.firestore.FieldValue.arrayUnion(entry)
      });

      _log('extended to ' + targetDate.toISOString() + ' (~' + diffMonths + ' months)');

      if (window.VisionOverlays && typeof window.VisionOverlays.toast === 'function') {
        window.VisionOverlays.toast({
          type: 'success',
          title: 'تم التمديد',
          message: 'تم تمديد الاشتراك حتى ' +
            targetDate.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' }),
          duration: 6000,
        });
      }
    } catch (e) {
      _err('extendToDate failed', e);
      throw e;
    }
  }

  /**
   * Toggle the system pause/resume state.
   *
   * @param {boolean} activate — true to resume, false to pause
   * @returns {Promise<void>}
   */
  async function togglePause(activate) {
    _assertWriteReady('togglePause');

    const db  = firebase.firestore();
    const ref = db.collection('system_status').doc('config');
    const action = activate ? 'resumed' : 'paused';
    const entry = _historyEntry(action, null);

    try {
      await ref.update({
        isActive: activate,
        subscriptionHistory: firebase.firestore.FieldValue.arrayUnion(entry)
      });

      _log('system ' + (activate ? 'resumed' : 'paused'));

      if (window.VisionOverlays && typeof window.VisionOverlays.toast === 'function') {
        window.VisionOverlays.toast({
          type: activate ? 'success' : 'warning',
          title: activate ? 'تم الاستئناف' : 'تم التعليق',
          message: activate
            ? 'النظام نشط الآن ويمكن للموظفين الوصول إليه.'
            : 'تم تعليق النظام. لن يتمكن الموظفون من الوصول حتى يتم استئنافه.',
          duration: 6000,
        });
      }
    } catch (e) {
      _err('togglePause failed', e);
      throw e;
    }
  }

  /**
   * Update the usage caps.
   *
   * @param {Object} caps — { maxEmployees?: number, maxProducts?: number }
   * @returns {Promise<void>}
   */
  async function updateUsageCaps(caps) {
    _assertWriteReady('updateUsageCaps');

    if (!caps || typeof caps !== 'object') {
      throw new Error('[VisionLicensing] updateUsageCaps: caps object required');
    }

    const db  = firebase.firestore();
    const ref = db.collection('system_status').doc('config');

    const newCaps = {
      maxEmployees: caps.maxEmployees !== undefined
        ? Number(caps.maxEmployees) || 5
        : _state.cached.usageCaps.maxEmployees,
      maxProducts: caps.maxProducts !== undefined
        ? Number(caps.maxProducts) || 200
        : _state.cached.usageCaps.maxProducts,
    };

    const entry = _historyEntry('caps_updated', null);

    try {
      await ref.update({
        usageCaps: newCaps,
        subscriptionHistory: firebase.firestore.FieldValue.arrayUnion(entry)
      });

      _log('usage caps updated: maxEmployees=' + newCaps.maxEmployees +
        ', maxProducts=' + newCaps.maxProducts);

      if (window.VisionOverlays && typeof window.VisionOverlays.toast === 'function') {
        window.VisionOverlays.toast({
          type: 'success',
          title: 'تم التحديث',
          message: 'تم تحديث حدود الاستخدام بنجاح.',
          duration: 4000,
        });
      }
    } catch (e) {
      _err('updateUsageCaps failed', e);
      throw e;
    }
  }

  /**
   * Unsubscribe the Firestore listener.
   */
  function disconnect() {
    if (_state.unsubFn) {
      try { _state.unsubFn(); } catch (e) { _err('disconnect error', e); }
      _state.unsubFn = null;
    }
    _state.syncing = false;
    _state.callbacks = [];
    _log('disconnected');
  }

  /* ─────────────────────────────────────────────
   * EXPORT
   * ───────────────────────────────────────────── */

  window.VisionLicensing = {
    init,
    startSync,
    isSystemActive,
    getWarningDays,
    getStatus,
    getUsageCaps,
    onStatusChanged,
    renew,
    extendToDate,
    togglePause,
    updateUsageCaps,
    disconnect
  };

  console.info('[VisionLicensing] ready');

})(window);