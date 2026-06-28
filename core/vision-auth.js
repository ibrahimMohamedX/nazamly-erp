/**
 * VisionAuth — Authentication Module
 * ====================================
 * Firebase Auth integration with role/permission management.
 * Also supports non-Firebase "custom auth" for offline scenarios.
 *
 * Roles (ascending privilege): guest < user < admin
 *
 * Usage:
 *   VisionAuth.init({ firebase: true });
 *   const user = await VisionAuth.signIn('e@example.com', 'pass');
 *   if (VisionAuth.isAdmin()) { … }
 *   VisionAuth.onAuthStateChanged(user => console.log(user));
 */
(function (window) {
    'use strict';

    /* ─────────────────────────────────────────────
     * INTERNAL STATE
     * ───────────────────────────────────────────── */
    const _state = {
        initialized:  false,
        useFirebase:  false,
        user:         null,   // plain object { uid, email, displayName, … }
        role:         null,   // 'admin' | 'user' | 'guest'
        permissions:  {},     // { canSeeFinancials: true, … }
        token:        null,
        tokenExpiry:  null,
        callbacks:    [],     // auth-state-change listeners
        customAuth:   null    // set via setCustomAuth()
    };

    const ROLE_RANK = { admin: 3, user: 2, guest: 1 };

    /* ─────────────────────────────────────────────
     * FIREBASE HELPERS
     * ───────────────────────────────────────────── */

    function _firebaseAvailable() {
        return typeof firebase !== 'undefined' && firebase.auth && window.auth;
    }

    /** Sync user data from a Firebase Auth user object + ID-token claims */
    async function _syncFirebaseUser(fbUser) {
        try {
            const result = await fbUser.getIdTokenResult();
            const claims = result.claims || {};

            _state.user = {
                uid:           fbUser.uid,
                email:         fbUser.email,
                displayName:   fbUser.displayName || fbUser.email.split('@')[0],
                emailVerified: fbUser.emailVerified,
                photoURL:      fbUser.photoURL || null,
                metadata: {
                    creationTime:  fbUser.metadata && fbUser.metadata.creationTime,
                    lastSignInTime: fbUser.metadata && fbUser.metadata.lastSignInTime
                }
            };

            // Role: prefer custom claim, then localStorage (set by login.html), then default
            _state.role        = claims.role || localStorage.getItem('userRole') || 'user';
            _state.permissions = claims.permissions || {};
            _state.token       = result.token;
            _state.tokenExpiry = result.expirationTime
                ? new Date(result.expirationTime).getTime()
                : null;

            _pushToConfig();
        } catch (e) {
            console.error('[VisionAuth] _syncFirebaseUser error:', e);
        }
    }

    /** Write current auth state into VisionConfig */
    function _pushToConfig() {
        if (!window.VisionConfig) return;
        window.VisionConfig.set('user', _state.user);
        window.VisionConfig.set('role', _state.role);
        window.VisionConfig.set('permissions', _state.permissions);
    }

    function _clearState() {
        _state.user        = null;
        _state.role        = null;
        _state.permissions = {};
        _state.token       = null;
        _state.tokenExpiry = null;
        if (window.VisionConfig) {
            window.VisionConfig.set('user', null);
            window.VisionConfig.set('role', null);
            window.VisionConfig.set('permissions', {});
        }
    }

    function _notify(user) {
        _state.callbacks.forEach(cb => {
            try { cb(user); } catch (e) {
                console.error('[VisionAuth] callback error:', e);
            }
        });
    }

    /* ─────────────────────────────────────────────
     * PUBLIC API
     * ───────────────────────────────────────────── */

    /**
     * Initialize the auth module.
     * @param {Object} options – { firebase: true }
     */
    function init(options) {
        options = options || {};
        _state.initialized = true;
        _state.useFirebase = !!options.firebase;

        if (_state.useFirebase) {
            if (!_firebaseAvailable()) {
                console.warn('[VisionAuth] Firebase SDK not loaded — will retry on signIn()');
                return;
            }
            window.auth.onAuthStateChanged(async fbUser => {
                if (fbUser) {
                    await _syncFirebaseUser(fbUser);
                    _notify(_state.user);
                } else {
                    _clearState();
                    _notify(null);
                }
            });
        }
    }

    /**
     * Sign in with email and password.
     * @param {string} email
     * @param {string} password
     * @returns {Promise<Object>} User object
     */
    async function signIn(email, password) {
        if (!_firebaseAvailable()) throw new Error('[VisionAuth] Firebase not available');
        const cred = await window.auth.signInWithEmailAndPassword(email, password);
        await _syncFirebaseUser(cred.user);
        _notify(_state.user);
        return _state.user;
    }

    /**
     * Sign in with a custom Firebase token.
     * @param {string} token
     * @returns {Promise<Object>}
     */
    async function signInWithToken(token) {
        if (!_firebaseAvailable()) throw new Error('[VisionAuth] Firebase not available');
        const cred = await window.auth.signInWithCustomToken(token);
        await _syncFirebaseUser(cred.user);
        _notify(_state.user);
        return _state.user;
    }

    /**
     * Sign out the current user.
     * @returns {Promise<void>}
     */
    async function signOut() {
        if (_state.useFirebase && _firebaseAvailable()) {
            await window.auth.signOut();
        }
        _clearState();
        _notify(null);
    }

    /**
     * Register an auth-state-change listener.
     * Immediately called with the current state.
     * @param {Function} callback – called with user object or null
     * @returns {Function} Unsubscribe
     */
    function onAuthStateChanged(callback) {
        _state.callbacks.push(callback);
        try { callback(_state.user); } catch (_) { /* ignore */ }
        return () => {
            _state.callbacks = _state.callbacks.filter(c => c !== callback);
        };
    }

    /** @returns {boolean} */
    function isAuthenticated() { return _state.user !== null; }

    /** @returns {boolean} */
    function isAdmin() {
        return _state.role === 'admin' || (ROLE_RANK[_state.role] || 0) >= ROLE_RANK['admin'];
    }

    /**
     * Check a specific permission key.
     * Admins always return true.
     * @param {string} permission
     * @returns {boolean}
     */
    function hasPermission(permission) {
        if (isAdmin()) return true;
        return !!_state.permissions[permission];
    }

    /** @returns {Object|null} Shallow copy of the user object */
    function getUser()  { return _state.user ? Object.assign({}, _state.user) : null; }

    /** @returns {string|null} */
    function getRole()  { return _state.role; }

    /**
     * Get a (possibly refreshed) Firebase ID token.
     * @param {boolean} [forceRefresh=false]
     * @returns {Promise<string|null>}
     */
    async function getToken(forceRefresh) {
        if (!_firebaseAvailable()) return null;
        const fbUser = firebase.auth().currentUser;
        if (!fbUser) return null;
        try {
            const token = await fbUser.getIdToken(!!forceRefresh);
            _state.token = token;
            return token;
        } catch (e) {
            console.error('[VisionAuth] getToken error:', e);
            return null;
        }
    }

    /**
     * Show a modal login form for maintenance bypass.
     * Resolves true only if the user signs in and has the admin role.
     * @returns {Promise<boolean>}
     */
    function promptAdminLogin() {
        return new Promise(resolve => {
            if (!window.VisionOverlays) { resolve(false); return; }

            // Build a small login form as an HTMLElement
            const form = document.createElement('div');
            form.style.cssText = 'display:flex;flex-direction:column;gap:14px;';

            function field(type, id, placeholder) {
                const input = document.createElement('input');
                input.type        = type;
                input.id          = id;
                input.placeholder = placeholder;
                input.dir         = 'ltr';
                input.style.cssText =
                    'width:100%;padding:10px 12px;border-radius:8px;' +
                    'border:1px solid #334155;background:#0F172A;' +
                    'color:#fff;font-family:inherit;font-size:14px;';
                return input;
            }

            form.appendChild(field('email',    'va-email', 'البريد الإلكتروني'));
            form.appendChild(field('password', 'va-pass',  '••••••••'));

            const errEl = document.createElement('div');
            errEl.style.cssText = 'color:#ef4444;font-size:13px;display:none;';
            form.appendChild(errEl);

            window.VisionOverlays.modal({
                title:           'دخول المدير',
                body:            form,
                closeable:       true,
                closeOnBackdrop: false,
                buttons: [
                    { label: 'تسجيل الدخول', value: 'login', primary: true },
                    { label: 'إلغاء',         value: null }
                ]
            }).then(async result => {
                if (result !== 'login') { resolve(false); return; }

                const emailEl = document.getElementById('va-email');
                const passEl  = document.getElementById('va-pass');
                const email   = emailEl ? emailEl.value.trim() : '';
                const pass    = passEl  ? passEl.value         : '';

                if (!email || !pass) {
                    if (errEl) { errEl.textContent = 'يرجى إدخال البيانات'; errEl.style.display = 'block'; }
                    resolve(false);
                    return;
                }

                try {
                    await signIn(email, pass);
                    if (isAdmin()) {
                        resolve(true);
                    } else {
                        if (errEl) {
                            errEl.textContent = 'هذا الحساب ليس له صلاحيات مدير';
                            errEl.style.display = 'block';
                        }
                        await signOut();
                        resolve(false);
                    }
                } catch (_) {
                    if (errEl) {
                        errEl.textContent = 'بيانات الدخول غير صحيحة';
                        errEl.style.display = 'block';
                    }
                    resolve(false);
                }
            });
        });
    }

    /**
     * Set a custom (non-Firebase) auth object.
     * @param {Object} authData – { user, role, permissions, token }
     */
    function setCustomAuth(authData) {
        if (!authData || typeof authData !== 'object') return;
        _state.customAuth  = authData;
        _state.user        = authData.user        || null;
        _state.role        = authData.role        || 'guest';
        _state.permissions = authData.permissions || {};
        _state.token       = authData.token       || null;
        _pushToConfig();
        _notify(_state.user);
    }

    /** Clear custom auth state */
    function clearAuth() {
        _state.customAuth = null;
        _clearState();
        _notify(null);
    }

    /* ─────────────────────────────────────────────
     * EXPORT
     * ───────────────────────────────────────────── */
    window.VisionAuth = {
        init,
        signIn,
        signInWithToken,
        signOut,
        onAuthStateChanged,
        isAuthenticated,
        isAdmin,
        hasPermission,
        getUser,
        getRole,
        getToken,
        promptAdminLogin,
        setCustomAuth,
        clearAuth
    };

    console.info('[VisionAuth] ready');

})(window);
