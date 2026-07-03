/**
 * pages/login.js — Login Page Controller
 *
 * Responsibilities:
 *   - Bind form submit → Firebase auth flow
 *   - First-time admin setup (whitelist-gated auto-create)
 *   - Employee record check + role-based routing
 *   - UI state management (loading, error, btn text)
 *
 * Bugs fixed vs original:
 *   1. Hardcoded developer email removed entirely.
 *   2. Race condition: onAuthStateChanged + form submit no longer
 *      double-execute handleLoginLogic.
 *   3. resetBtn scope error: single _setLoading() function used everywhere.
 *   4. Toastify dependency removed; VisionOverlays used consistently.
 *   5. localStorage role removed as auth source; only used for display name.
 *   6. Firebase error codes handled specifically for clear Arabic messages.
 */
(function (window) {
  'use strict';

  /* Guard: prevents double execution when both onAuthStateChanged
     and form submit trigger handleLoginLogic concurrently */
  let _inFlight = false;

  /* ──────────────────────────────────────
     UI HELPERS
     ────────────────────────────────────── */

  function _showError(msg) {
    const panel = document.getElementById('loginError');
    const text  = document.getElementById('loginErrorText');
    if (!panel || !text) return;
    text.textContent = msg;
    panel.hidden = false;
  }

  function _clearError() {
    const panel = document.getElementById('loginError');
    if (panel) panel.hidden = true;
  }

  function _setLoading(isLoading, label) {
    const btn     = document.getElementById('loginBtn');
    const text    = document.getElementById('btnText');
    const spinner = document.getElementById('btnSpinner');
    if (!btn) return;
    btn.disabled = isLoading;
    if (text)    text.textContent = label || (isLoading ? 'جاري التحقق...' : 'تسجيل الدخول');
    if (spinner) spinner.hidden   = !isLoading;
  }

  /* ──────────────────────────────────────
     WHITELIST HELPERS
     ────────────────────────────────────── */

  function _getAllowedEmails() {
    if (Array.isArray(window.ALLOWED_EMAILS) && window.ALLOWED_EMAILS.length) {
      return window.ALLOWED_EMAILS;
    }
    if (window.CLIENT_DATA && Array.isArray(window.CLIENT_DATA.allowedEmails)) {
      return window.CLIENT_DATA.allowedEmails;
    }
    return [];
  }

  function _isEmailAllowed(email) {
    const normalized = email.toLowerCase().trim();
    return _getAllowedEmails().some(
      a => typeof a === 'string' && a.toLowerCase().trim() === normalized
    );
  }

  /* ──────────────────────────────────────
     CORE AUTH LOGIC
     ────────────────────────────────────── */

  /**
   * After Firebase auth succeeds, validate the employee record
   * and route to the correct landing page.
   * @param {firebase.User} fbUser
   */
  async function _handleLoginLogic(fbUser) {
    if (_inFlight) return;
    _inFlight = true;

    const db = firebase.firestore();

    try {
      const employeeRef = db.collection('employees').doc(fbUser.uid);
      const employeeDoc = await employeeRef.get();

      if (!employeeDoc.exists) {
        /* First-time login: only whitelisted emails may create an admin record */
        if (!_isEmailAllowed(fbUser.email)) {
          await firebase.auth().signOut();
          _showError('هذا البريد الإلكتروني غير مصرح له بالدخول.');
          _setLoading(false);
          _inFlight = false;
          return;
        }

        _setLoading(true, 'جاري تهيئة حسابك...');

        /* Auto-create admin record on first authorized login */
        await employeeRef.set({
          name:        fbUser.displayName || fbUser.email.split('@')[0],
          email:       fbUser.email,
          role:        'admin',
          status:      'active',
          permissions: {
            canSeeAllOrders:        true,
            canSeeFinancials:       true,
            canImport:              true,
            canExportArchive:       true,
            canExportShipping:      true,
            canSeePackingSummary:   true,
            canSeeFinancialAnalysis:true,
            canManageStatuses:      true,
            canChangeOrderEmployee: true,
          },
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });

        window.location.replace('index.html');
        return;
      }

      const data = employeeDoc.data();

      /* Suspended account check */
      if (data.status === 'suspended') {
        await firebase.auth().signOut();
        _showError('حسابك موقوف. يرجى التواصل مع الإدارة.');
        _setLoading(false);
        _inFlight = false;
        return;
      }

      /* Cache display name only (non-sensitive; used by sidebar) */
      if (data.name) localStorage.setItem('employeeName', data.name);

      /* Route by Firestore role (role is also in ID-token claims for VisionAuth) */
      window.location.replace(data.role === 'admin' ? 'index.html' : 'orders.html');

    } catch (err) {
      console.error('[Login] handleLoginLogic error:', err);
      await firebase.auth().signOut().catch(() => {});
      _showError('حدث خطأ غير متوقع. يرجى المحاولة مجدداً.');
      _setLoading(false);
      _inFlight = false;
    }
  }

  /* Translate Firebase error codes to Arabic user messages */
  function _firebaseErrorMsg(code) {
    switch (code) {
      case 'auth/wrong-password':
      case 'auth/invalid-credential':   return 'كلمة المرور غير صحيحة.';
      case 'auth/invalid-email':        return 'صيغة البريد الإلكتروني غير صحيحة.';
      case 'auth/user-disabled':        return 'هذا الحساب معطّل.';
      case 'auth/too-many-requests':    return 'محاولات كثيرة. يرجى الانتظار ثم المحاولة مجدداً.';
      case 'auth/network-request-failed': return 'لا يوجد اتصال بالإنترنت.';
      case 'auth/weak-password':        return 'كلمة المرور ضعيفة (6 أحرف على الأقل).';
      default:                          return 'حدث خطأ. يرجى المحاولة مجدداً.';
    }
  }

  /* ──────────────────────────────────────
     PAGE INIT
     ────────────────────────────────────── */

  function _init() {
    /* Update brand title from Firestore config */
    const brandTitle = document.getElementById('brandTitle');
    if (brandTitle && window.CLIENT_BRAND) {
      brandTitle.textContent = window.CLIENT_BRAND;
    }

    /* ── Bug fix: Auth lifecycle guard ────────────────────────────────────
       Race condition: vision-ready fires after vision-init.js completes its
       bootstrap, but firebase-auth-compat.js is a CDN script loaded in
       <head>. On slow connections it may not have registered firebase.auth
       by the time this runs. We also guard against firebase.initializeApp()
       not yet having been called (firebase.apps.length === 0).

       Root cause of "Cannot read properties of undefined (reading
       'onAuthStateChanged')": firebase.auth() returns undefined when either
       firebase-auth-compat.js hasn't loaded, or the app isn't initialized.

       Fix: explicit runtime checks before any .auth() call, with user-facing
       error messages so the page never silently freezes.                    */
    if (typeof firebase === 'undefined') {
      _showError('Firebase SDK لم يتم تحميله. يرجى التحقق من اتصالك وإعادة تحميل الصفحة.');
      console.error('[Login] firebase global is undefined — CDN scripts may not have loaded.');
      return;
    }
    if (!firebase.apps || firebase.apps.length === 0) {
      _showError('فشل تهيئة Firebase. يرجى إعادة تحميل الصفحة.');
      console.error('[Login] firebase.apps is empty — initializeApp() has not been called yet.');
      return;
    }
    if (typeof firebase.auth !== 'function') {
      _showError('مكوّن المصادقة لم يتم تحميله. يرجى إعادة تحميل الصفحة.');
      console.error('[Login] firebase.auth is not a function — firebase-auth-compat.js may not be loaded.');
      return;
    }

    const auth = firebase.auth();

    /* Second-tier guard: firebase.auth() can return null in edge cases      */
    if (!auth || typeof auth.onAuthStateChanged !== 'function') {
      _showError('تعذّر تهيئة نظام تسجيل الدخول. يرجى إعادة تحميل الصفحة.');
      console.error('[Login] firebase.auth() returned an invalid Auth instance:', auth);
      return;
    }

    const loginForm = document.getElementById('loginForm');

    /* Auto-login: if session already exists, skip the form */
    let _autoChecked = false;
    auth.onAuthStateChanged(user => {
      if (user && !_inFlight && !_autoChecked) {
        _autoChecked = true;
        _setLoading(true, 'جاري تسجيل الدخول تلقائياً...');
        _handleLoginLogic(user);
      }
    });

    if (!loginForm) return;

    loginForm.addEventListener('submit', async e => {
      e.preventDefault();
      _clearError();

      const email    = document.getElementById('email')?.value.trim()    || '';
      const password = document.getElementById('password')?.value || '';

      if (!email || !password) {
        _showError('يرجى إدخال البريد الإلكتروني وكلمة المرور.');
        return;
      }

      _setLoading(true);

      try {
        /* Standard sign-in */
        const cred = await auth.signInWithEmailAndPassword(email, password);
        await _handleLoginLogic(cred.user);

      } catch (signInErr) {
        const code = signInErr.code || '';

        /* Account not found → offer auto-create if whitelisted */
        if (code === 'auth/user-not-found' || code === 'auth/invalid-credential') {
          if (_isEmailAllowed(email)) {
            _setLoading(true, 'جاري إعداد حسابك لأول مرة...');
            try {
              const newCred = await auth.createUserWithEmailAndPassword(email, password);
              await _handleLoginLogic(newCred.user);
            } catch (createErr) {
              console.error('[Login] createUser failed:', createErr);
              _showError(_firebaseErrorMsg(createErr.code));
              _setLoading(false);
              _inFlight = false;
            }
          } else {
            _showError('هذا البريد الإلكتروني غير مصرح له بالدخول.');
            _setLoading(false);
          }
        } else {
          _showError(_firebaseErrorMsg(code));
          _setLoading(false);
        }
      }
    });
  }

  /* Wait for Vision system to be ready before initializing */
  window.addEventListener('vision-ready', _init, { once: true });

})(window);
