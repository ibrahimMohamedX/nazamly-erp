/**
 * shared/auth-guard.js — Page Auth Protection
 *
 * Every protected page calls:
 *   AuthGuard.protect({ adminOnly: true, onReady: user => initPage(user) });
 *
 * Race-condition proof: checks dual readiness signals AND uses a
 * safety timeout so pages never freeze waiting for a missed event.
 */
(function (window) {
  'use strict';

  /* Ready timeout (ms) — fallback if vision-ready never fires */
  var _READY_TIMEOUT = 6000;

  /* ── Redirect loop guard ── */
  function _isLoginPage() {
    try {
      var p = window.location.pathname.split('/').pop().toLowerCase();
      return p === 'login.html' || p === 'login';
    } catch (_) { return false; }
  }

  /* ── Race-proof ready check ── */
  function _whenReady(fn) {
    /* Dual-signal: brand token OR VisionAuth object present */
    var ready = typeof window.CLIENT_BRAND !== 'undefined'
             || typeof window.VisionAuth !== 'undefined';

    if (ready) {
      /* Already initialized — schedule microtask */
      Promise.resolve().then(fn);
      return;
    }

    /* Wait for event with safety timeout */
    var done = false;
    var handler = function () {
      if (done) return;
      done = true;
      clearTimeout(safety);
      fn();
    };

    var safety = setTimeout(function () {
      if (done) return;
      done = true;
      window.removeEventListener('vision-ready', handler);
      console.warn('[AuthGuard] vision-ready timeout — using fallback');
      fn();
    }, _READY_TIMEOUT);

    window.addEventListener('vision-ready', handler, { once: true });
  }

  /* ── Public API ── */

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
    var loginPage = options.redirect || 'login.html';

    /* Prevent redirect loops */
    if (_isLoginPage()) {
      if (typeof options.onReady === 'function') options.onReady(null);
      return;
    }

    _whenReady(function () {
      /* Primary path: VisionAuth available */
      if (window.VisionAuth) {
        try {
          var user = window.VisionAuth.getUser();

          if (!user) {
            window.location.replace(loginPage);
            return;
          }

          if (options.adminOnly && !window.VisionAuth.isAdmin()) {
            window.location.replace('orders.html');
            return;
          }

          if (typeof options.onReady === 'function') {
            options.onReady(user);
          }
        } catch (err) {
          console.error('[AuthGuard] VisionAuth error:', err);
          window.location.replace(loginPage);
        }
        return;
      }

      /* Fallback: direct Firebase auth */
      if (typeof firebase !== 'undefined' && firebase.auth) {
        var unsub = firebase.auth().onAuthStateChanged(function (fbUser) {
          unsub();
          if (!fbUser) { window.location.replace(loginPage); return; }
          /* No role data in fallback — deny admin-only pages */
          if (options.adminOnly) { window.location.replace('orders.html'); return; }
          if (typeof options.onReady === 'function') options.onReady(fbUser);
        });
        return;
      }

      /* No auth mechanism — redirect */
      window.location.replace(loginPage);
    });
  }

  window.AuthGuard = { protect };
  console.info('[AuthGuard] ready');

})(window);