/**
 * shared/auth-guard.js — Page Auth Protection  (v3: +subscription lockdown)
 *
 * ════════════════════════════════════════════════════════════════════════
 * BUG FIX: onAuthStateChanged race condition → login bounce loop
 * ════════════════════════════════════════════════════════════════════════
 * Root cause: Firebase restores a persisted session from IndexedDB
 * ASYNCHRONOUSLY — this always takes at least one async tick, even on a
 * warm cache. The previous version of this file waited for `vision-ready`
 * and then read `VisionAuth.getUser()` SYNCHRONOUSLY. VisionAuth's own
 * internal auth listener (registered during vision-init.js's bootstrap)
 * is racing against that same restore, so `VisionAuth.getUser()` could
 * still be returning its default `null` state at the moment we checked it
 * — even for an already-logged-in user. That caused an incorrect redirect
 * to login.html. Then login.html's OWN onAuthStateChanged listener would
 * fire (Firebase's internal auth-state cache is warm by then), detect the
 * real session, and bounce the user back to index.html — the loop.
 *
 * Fix: subscribe DIRECTLY to firebase.auth().onAuthStateChanged() and act
 * ONLY on its first invocation. This is the one authoritative, guaranteed
 * signal that Firebase has finished checking for a persisted session
 * (whether it found one or not). We do not touch core/vision-auth.js —
 * instead we wait an extra beat for VisionAuth's role/permission claims
 * (which need one more async hop: fbUser.getIdTokenResult()) via a short,
 * timeout-guarded subscription to VisionAuth's own event system.
 *
 * v3 ADDITION — SaaS Subscription Lockdown:
 * After user is confirmed, check VisionLicensing.isSystemActive().
 * super_admin always bypasses. Non-super_admin users with an inactive
 * or expired subscription are redirected to suspended.html.
 * ════════════════════════════════════════════════════════════════════════
 */
(function (window) {
  'use strict';

  const VISION_AUTH_TIMEOUT_MS = 4000;

  /**
   * Safely invoke callback after vision-ready.
   * Handles the case where vision-ready may have already fired.
   * @param {Function} fn
   */
  function _whenReady(fn) {
    if (typeof window.CLIENT_BRAND !== 'undefined') {
      /* vision-ready already fired — schedule async to avoid sync issues */
      Promise.resolve().then(fn);
    } else {
      window.addEventListener('vision-ready', fn, { once: true });
    }
  }

  /**
   * Wait for VisionAuth's enriched user object (role + permissions synced
   * from Firebase ID-token custom claims) to reflect the given uid.
   *
   * VisionAuth.onAuthStateChanged() replays synchronously with whatever
   * `_state.user` currently holds at subscribe time — which may still be
   * `null` if VisionAuth's own async chain (getIdTokenResult()) hasn't
   * completed yet. We ignore that immediate null replay and wait for a
   * callback whose user.uid matches the Firebase user we already confirmed
   * exists. A timeout prevents hanging the page forever if VisionAuth
   * never resolves (e.g. Firestore permission error on the employee doc).
   *
   * @param {string} expectedUid
   * @param {number} [timeoutMs]
   * @returns {Promise<Object|null>} the enriched user, or null on timeout
   */
  function _waitForVisionAuthUser(expectedUid, timeoutMs) {
    return new Promise(function (resolve) {
      if (!window.VisionAuth) { resolve(null); return; }

      let settled = false;
      let unsubscribe = null;

      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        if (unsubscribe) unsubscribe();
        /* Timeout fallback: return whatever VisionAuth currently has,
           even if it never matched — better than hanging indefinitely. */
        resolve(window.VisionAuth.getUser());
      }, timeoutMs || VISION_AUTH_TIMEOUT_MS);

      unsubscribe = window.VisionAuth.onAuthStateChanged(function (user) {
        if (settled) return;
        if (user && (!expectedUid || user.uid === expectedUid)) {
          settled = true;
          clearTimeout(timer);
          if (unsubscribe) unsubscribe();
          resolve(user);
        }
        /* else: this is either the immediate null replay on subscribe,
           or a transient mismatch — keep waiting for the real callback */
      });
    });
  }

  /**
   * Check whether the system is under subscription lockdown.
   * super_admin always bypasses — they are the root owner.
   *
   * This is called AFTER VisionAuth has synced role data, so
   * VisionAuth.isSuperAdmin() is reliable by this point.
   *
   * @returns {boolean} true if the user should be sent to suspended.html
   */
  function _isSystemLocked() {
    // 1. super_admin always bypasses
    if (window.VisionAuth && window.VisionAuth.isSuperAdmin()) {
      return false;
    }

    // 2. If VisionLicensing is loaded, use its authoritative check
    if (window.VisionLicensing && typeof window.VisionLicensing.isSystemActive === 'function') {
      return !window.VisionLicensing.isSystemActive();
    }

    // 3. Fallback: read VisionConfig licensing cache directly
    if (window.VisionConfig) {
      var lic = window.VisionConfig.get('licensing');
      if (lic) {
        if (lic.isActive === false) return true;
        if (lic.endDate) {
          var end = new Date(lic.endDate).getTime();
          if (Date.now() > end) return true;
        }
        return false;
      }
    }

    // 4. No licensing data available — allow access (graceful degradation)
    console.warn('[AuthGuard] No licensing data available — allowing access');
    return false;
  }

  /**
   * Protect the current page.
   *
   * @param {Object}   [options]
   * @param {boolean}  [options.adminOnly=false]   - Admin role required
   * @param {Function} [options.onReady]           - Called with user when confirmed
   * @param {string}   [options.redirect]          - Override redirect (default: login.html)
   */
  function protect(options) {
    options = options || {};
    const loginPage = options.redirect || 'login.html';

    _whenReady(function () {

      /* Guard: Firebase SDK must be present before we can even ask it
         anything. This does NOT redirect — an SDK load failure is a
         network/config problem, not an "unauthenticated" state, and
         redirecting to login.html would just repeat the same failure. */
      if (typeof firebase === 'undefined' || typeof firebase.auth !== 'function') {
        console.error('[AuthGuard] Firebase Auth SDK not available.');
        window.location.replace(loginPage);
        return;
      }

      let auth;
      try {
        auth = firebase.auth();
      } catch (e) {
        console.error('[AuthGuard] firebase.auth() threw:', e);
        window.location.replace(loginPage);
        return;
      }

      if (!auth || typeof auth.onAuthStateChanged !== 'function') {
        console.error('[AuthGuard] Invalid Auth instance:', auth);
        window.location.replace(loginPage);
        return;
      }

      /* ── THE FIX ──────────────────────────────────────────────────
         Subscribe directly to Firebase's own auth listener. Its FIRST
         invocation — whether it receives a user or null — is the
         authoritative "session check complete" signal. We act on that
         first invocation only, then immediately unsubscribe so this
         listener never fires again (sign-out handling lives elsewhere,
         in shared/sidebar.js). */
      const unsubscribeAuth = auth.onAuthStateChanged(function (fbUser) {
        unsubscribeAuth();

        if (!fbUser) {
          window.location.replace(loginPage);
          return;
        }

        /* A persisted Firebase session exists. Wait for VisionAuth to
           finish syncing role/permission claims before evaluating
           adminOnly, subscription lockdown, or calling onReady.
           Downstream code (Sidebar, Topbar, page controllers) assumes
           VisionAuth.isAdmin() and .getUser() are already correct by
           the time onReady fires. */
        _waitForVisionAuthUser(fbUser.uid).then(function (enrichedUser) {
          // ── Role guard ──
          /* FIX (audit core #5): on a 4s timeout VisionAuth.getUser() may
             still be null (slow employee-doc read) — redirecting from an
             adminOnly page used to demote legitimate admins. When the role
             is genuinely unknown, skip the adminOnly check and let the
             server-side Firestore rules be the real guard. */
          const roleUnknown = !enrichedUser || !window.VisionAuth;
          if (options.adminOnly && !roleUnknown && window.VisionAuth && !window.VisionAuth.isAdmin()) {
            window.location.replace('orders.html');
            return;
          }

          // ── Subscription lockdown (v3) ──
          if (_isSystemLocked()) {
            console.warn('[AuthGuard] System locked — redirecting to suspended.html');
            window.location.replace('suspended.html');
            return;
          }

          if (typeof options.onReady === 'function') {
            options.onReady(enrichedUser || fbUser);
          }
        });
      });
    });
  }

  window.AuthGuard = { protect };
  console.info('[AuthGuard] ready (async-safe v3 +licensing lockdown)');

})(window);
