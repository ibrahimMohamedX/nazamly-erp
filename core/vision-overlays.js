/**
 * VisionOverlays — UI Engine
 * ===========================
 * Renders all visual overlay components into the DOM using the exact
 * CSS class names and data attributes defined in the project's stylesheet.
 *
 * Components
 * ──────────
 *  toast()          – 7 types, 6 positions, progress bar, action buttons
 *  showMaintenance()– Full-screen blocker with countdown timer
 *  showSpinner()    – Full-screen loading overlay
 *  modal()          – Promise-based dialog with focus-trap
 *  banner()         – Inline banner injected into any container
 *
 * CSS Contract (classes that must exist in the project stylesheet)
 * ──────────────────────────────────────────────────────────────────
 *  .vision-overlay-container  .vision-overlay-backdrop
 *  .vision-maintenance-overlay .vision-maintenance-icon
 *  .vision-maintenance-title  .vision-maintenance-message
 *  .vision-maintenance-timer  .vo-timer-unit .vo-timer-value .vo-timer-label
 *  .vision-toast-container    .vision-toast
 *  .vision-toast-icon         .vision-toast-content
 *  .vision-toast-title        .vision-toast-message
 *  .vision-toast-actions      .vision-toast-btn
 *  .vision-toast-btn-primary  .vision-toast-btn-secondary
 *  .vision-toast-close        .vision-toast-progress
 *  .vision-banner             .vision-banner-icon
 *  .vision-banner-content     .vision-banner-title
 *  .vision-banner-text        .vision-banner-close
 *  .vision-spinner-overlay    .vision-spinner .vision-spinner-text
 *  .vision-modal-overlay      .vision-modal
 *  .vision-modal-header       .vision-modal-title
 *  .vision-modal-close        .vision-modal-body .vision-modal-footer
 */
(function (window) {
    'use strict';

    /* ─────────────────────────────────────────────
     * CONSTANTS
     * ───────────────────────────────────────────── */
    const TOAST_TYPES     = new Set(['info', 'success', 'warning', 'error', 'alert', 'update', 'maintenance']);
    const VALID_POSITIONS = ['top-right', 'top-left', 'top-center', 'bottom-right', 'bottom-left', 'bottom-center'];

    /** Default auto-dismiss durations (ms). 0 = persistent. */
    const DEFAULT_DURATION = {
        info: 5000, success: 4000, warning: 7000,
        error: 0, alert: 0, update: 6000, maintenance: 0
    };

    /** Font-Awesome icon class per type */
    const FA = {
        info:        'fa-circle-info',
        success:     'fa-circle-check',
        warning:     'fa-triangle-exclamation',
        error:       'fa-circle-xmark',
        alert:       'fa-bell',
        update:      'fa-arrow-up-right-dots',
        maintenance: 'fa-wrench'
    };

    /* ─────────────────────────────────────────────
     * STATE
     * ───────────────────────────────────────────── */
    const _toastContainers  = {};     // keyed by position string
    const _activeToasts     = new Map();
    let   _maintenanceEl    = null;
    let   _maintenanceTimer = null;
    let   _spinnerEl        = null;
    let   _bodyLockCount    = 0;     // overflow:hidden reference counter
    const _modalStack       = [];     // for Escape-key priority

    /* ─────────────────────────────────────────────
     * ACCESSIBILITY HELPERS
     * ───────────────────────────────────────────── */
    function _reducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    function _highContrast() {
        return window.matchMedia && window.matchMedia('(prefers-contrast: high)').matches;
    }

    /** Create a <i class="fas fa-…"> icon wrapped in a typed span */
    function _makeIcon(type, wrapClass) {
        const span = document.createElement('span');
        span.className = wrapClass || 'vision-toast-icon';
        const i = document.createElement('i');
        i.className = 'fas ' + (FA[type] || 'fa-circle-info');
        span.appendChild(i);
        return span;
    }

    /** Lock body scroll (reference-counted). Safe to call multiple times. */
    function _lockBody() {
        _bodyLockCount++;
        if (_bodyLockCount === 1) {
            document.body.style.overflow = 'hidden';
        }
    }
    /** Unlock body scroll. When count reaches 0, overflow is restored. */
    function _unlockBody() {
        if (_bodyLockCount > 0) _bodyLockCount--;
        if (_bodyLockCount === 0) {
            document.body.style.overflow = '';
        }
    }

    /** Run a requestAnimationFrame double-tick (forces a paint before class add) */
    function _nextPaint(fn) {
        requestAnimationFrame(() => requestAnimationFrame(fn));
    }

    /* ═══════════════════════════════════════════════
     * TOAST SYSTEM
     * ═══════════════════════════════════════════════ */

    function _getContainer(position) {
        if (_toastContainers[position]) return _toastContainers[position];
        const c = document.createElement('div');
        c.className = 'vision-toast-container';
        c.setAttribute('data-position', position);
        c.setAttribute('aria-live', 'polite');
        c.setAttribute('aria-atomic', 'false');
        document.body.appendChild(c);
        _toastContainers[position] = c;
        return c;
    }

    /**
     * Show a toast notification.
     *
     * @param {Object|string} options
     *   type        – 'info' | 'success' | 'warning' | 'error' | 'alert' | 'update' | 'maintenance'
     *   title       – string
     *   message     – string (may contain sanitized HTML)
     *   duration    – ms; 0 = persistent
     *   position    – one of VALID_POSITIONS (default 'top-left', RTL-friendly)
     *   dismissible – boolean (default true)
     *   actions     – [{ label, primary, callback, closeOnClick }]
     *   id          – override auto-generated id
     *   onClose     – callback when dismissed
     * @returns {string} Toast id
     */
    function toast(options) {
        if (typeof options === 'string') options = { message: options };
        options = options || {};

        const type       = TOAST_TYPES.has(options.type) ? options.type : 'info';
        const position   = VALID_POSITIONS.includes(options.position) ? options.position : 'top-left';
        const duration   = options.duration !== undefined ? options.duration : DEFAULT_DURATION[type];
        const dismissible = options.dismissible !== false;
        const actions    = Array.isArray(options.actions) ? options.actions : [];
        const id         = options.id || (window.VisionSecurity
            ? window.VisionSecurity.generateId(8)
            : 'vt_' + Date.now());

        const container = _getContainer(position);

        // Build element
        const el = document.createElement('div');
        el.className  = 'vision-toast';
        el.setAttribute('data-type', type);
        el.setAttribute('data-id', id);
        el.setAttribute('role', 'alert');
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('tabindex', '0');
        if (_highContrast()) el.style.borderWidth = '2px';

        // Icon
        el.appendChild(_makeIcon(type, 'vision-toast-icon'));

        // Content
        const content = document.createElement('div');
        content.className = 'vision-toast-content';

        if (options.title) {
            const titleEl = document.createElement('div');
            titleEl.className   = 'vision-toast-title';
            titleEl.textContent = options.title;
            content.appendChild(titleEl);
        }

        if (options.message) {
            const msgEl = document.createElement('div');
            msgEl.className = 'vision-toast-message';
            const sec = window.VisionSecurity;
            if (sec && sec.containsHtml(options.message)) {
                msgEl.innerHTML = sec.sanitizeHtml(options.message);
            } else {
                msgEl.textContent = options.message;
            }
            content.appendChild(msgEl);
        }

        // Action buttons
        if (actions.length) {
            const actRow = document.createElement('div');
            actRow.className = 'vision-toast-actions';
            actions.forEach(action => {
                const btn       = document.createElement('button');
                btn.className   = 'vision-toast-btn ' +
                    (action.primary ? 'vision-toast-btn-primary' : 'vision-toast-btn-secondary');
                btn.textContent = action.label || '';
                btn.addEventListener('click', () => {
                    if (typeof action.callback === 'function') action.callback();
                    if (action.closeOnClick !== false) _dismiss(id);
                });
                actRow.appendChild(btn);
            });
            content.appendChild(actRow);
        }

        el.appendChild(content);

        // Dismiss button
        if (dismissible) {
            const close = document.createElement('button');
            close.className = 'vision-toast-close';
            close.setAttribute('aria-label', 'إغلاق الإشعار');
            close.innerHTML = '&times;';
            close.addEventListener('click', () => _dismiss(id));
            el.appendChild(close);
        }

        // Progress bar (auto-dismiss only, reduced-motion respected)
        if (duration > 0 && !_reducedMotion()) {
            const bar = document.createElement('div');
            bar.className = 'vision-toast-progress';
            bar.style.animationDuration = duration + 'ms';
            el.appendChild(bar);
        }

        // Keyboard: Escape dismisses focused toast
        el.addEventListener('keydown', e => { if (e.key === 'Escape') _dismiss(id); });

        container.appendChild(el);
        if (!_reducedMotion()) _nextPaint(() => el.classList.add('vision-toast--visible'));
        else el.classList.add('vision-toast--visible');

        // Auto-dismiss timer
        let timerId = null;
        if (duration > 0) {
            timerId = setTimeout(() => _dismiss(id), duration);
        }

        _activeToasts.set(id, { el, timerId, onClose: options.onClose });
        return id;
    }

    /** Dismiss a specific toast */
    function _dismiss(id) {
        const entry = _activeToasts.get(id);
        if (!entry) return;
        clearTimeout(entry.timerId);
        if (typeof entry.onClose === 'function') entry.onClose();

        const { el } = entry;
        if (!_reducedMotion()) {
            el.classList.add('vision-toast--exit');
            // Fallback removal after transition
            const cleanup = () => { if (el.parentNode) el.remove(); };
            el.addEventListener('animationend', cleanup, { once: true });
            setTimeout(cleanup, 600);
        } else {
            el.remove();
        }
        _activeToasts.delete(id);
    }

    /** Dismiss all active toasts */
    function dismissAllToasts() {
        _activeToasts.forEach((_, id) => _dismiss(id));
    }

    /* ═══════════════════════════════════════════════
     * MAINTENANCE OVERLAY
     * ═══════════════════════════════════════════════ */

    /**
     * Show the full-screen maintenance mode blocker.
     *
     * @param {Object} options
     *   title        – heading text
     *   message      – body text
     *   endTime      – ISO date string (for countdown timer)
     *   adminBypass  – show "enter as admin" button
     *   onAdminBypass– callback when bypass button clicked
     */
    function showMaintenance(options) {
        options = options || {};

        // If already visible, update content in-place (handles Firestore sync updates)
        if (_maintenanceEl) {
            var existingTitleEl = _maintenanceEl.querySelector('.vision-maintenance-title');
            if (existingTitleEl) existingTitleEl.textContent = options.title || existingTitleEl.textContent;
            var existingMsgEl = _maintenanceEl.querySelector('.vision-maintenance-message');
            if (existingMsgEl) existingMsgEl.textContent = options.message || existingMsgEl.textContent;
            if (options.endTime) {
                // Create timer if it doesn't exist yet
                var contentCard = _maintenanceEl.querySelector('.vision-maintenance-content');
                var existingTimer = _maintenanceEl.querySelector('.vision-maintenance-timer');
                if (!existingTimer && contentCard) {
                    contentCard.appendChild(_buildTimerElement(options.endTime));
                }
                _stopCountdown();
                _startCountdown(options.endTime);
            }
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'vision-overlay-container vision-maintenance-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', options.title || 'وضع الصيانة');

        // Backdrop
        const backdrop = document.createElement('div');
        backdrop.className = 'vision-overlay-backdrop';
        overlay.appendChild(backdrop);

        // Content card
        const card = document.createElement('div');
        card.className = 'vision-maintenance-content';

        // Icon
        const iconWrap = document.createElement('div');
        iconWrap.className = 'vision-maintenance-icon';
        iconWrap.innerHTML = '<i class="fas fa-wrench"></i>';
        card.appendChild(iconWrap);

        // Title
        const titleEl = document.createElement('h2');
        titleEl.className   = 'vision-maintenance-title';
        titleEl.textContent = options.title || 'النظام تحت الصيانة';
        card.appendChild(titleEl);

        // Message
        const msgEl = document.createElement('p');
        msgEl.className   = 'vision-maintenance-message';
        msgEl.textContent = options.message || 'نعمل على تحسين النظام لخدمتك بشكل أفضل. سنعود قريباً.';
        card.appendChild(msgEl);

        // Countdown timer
        if (options.endTime) {
            card.appendChild(_buildTimerElement(options.endTime));
            _startCountdown(options.endTime);
        }

        // Admin bypass button
        if (options.adminBypass) {
            const bypassBtn = document.createElement('button');
            bypassBtn.className   = 'vision-maintenance-bypass-btn';
            bypassBtn.textContent = 'دخول كمدير';
            bypassBtn.setAttribute('aria-label', 'تجاوز وضع الصيانة كمدير');
            bypassBtn.addEventListener('click', () => {
                if (typeof options.onAdminBypass === 'function') {
                    options.onAdminBypass();
                } else if (window.VisionAuth && typeof window.VisionAuth.promptAdminLogin === 'function') {
                    window.VisionAuth.promptAdminLogin();
                }
            });
            card.appendChild(bypassBtn);
        }

        overlay.appendChild(card);
        document.body.appendChild(overlay);
        _lockBody();

        if (!_reducedMotion()) {
            _nextPaint(() => overlay.classList.add('active'));
        } else {
            overlay.classList.add('active');
        }

        _maintenanceEl = overlay;
    }

    /** Remove the maintenance overlay */
    function hideMaintenance() {
        if (!_maintenanceEl) return;
        _stopCountdown();

        const el = _maintenanceEl;
        const cleanup = () => {
            if (el.parentNode) el.remove();
            if (_maintenanceEl === el) _maintenanceEl = null;
            _unlockBody();
        };

        if (!_reducedMotion()) {
            el.classList.add('vision-maintenance-overlay--exit');
            setTimeout(cleanup, 400);
        } else {
            cleanup();
        }
    }

    /** Build the reusable countdown timer DOM element */
    function _buildTimerElement(endTime) {
        var timerEl = document.createElement('div');
        timerEl.className = 'vision-maintenance-timer';
        timerEl.id = 'vo-maintenance-timer';

        var units  = ['days', 'hours', 'minutes', 'seconds'];
        var labels = { days: 'يوم', hours: 'ساعة', minutes: 'دقيقة', seconds: 'ثانية' };

        units.forEach(function (unit) {
            var unitDiv  = document.createElement('div');
            unitDiv.className = 'vo-timer-unit';

            var valEl  = document.createElement('div');
            valEl.className = 'vo-timer-value';
            valEl.id = 'vo-timer-' + unit;
            valEl.textContent = '00';

            var labelEl  = document.createElement('div');
            labelEl.className   = 'vo-timer-label';
            labelEl.textContent = labels[unit];

            unitDiv.appendChild(valEl);
            unitDiv.appendChild(labelEl);
            timerEl.appendChild(unitDiv);
        });

        return timerEl;
    }

    function _startCountdown(endTime) {
        const target = new Date(endTime).getTime();
        const update = () => {
            const diff = target - Date.now();
            if (diff <= 0) { _stopCountdown(); return; }

            const d = Math.floor(diff / 86_400_000);
            const h = Math.floor((diff % 86_400_000) / 3_600_000);
            const m = Math.floor((diff % 3_600_000)  / 60_000);
            const s = Math.floor((diff % 60_000)     / 1_000);

            const pad = n => String(n).padStart(2, '0');
            const set = (id, v) => {
                const el = document.getElementById('vo-timer-' + id);
                if (el) el.textContent = pad(v);
            };
            set('days', d); set('hours', h); set('minutes', m); set('seconds', s);
        };
        update();
        _maintenanceTimer = setInterval(update, 1000);
    }

    function _stopCountdown() {
        if (_maintenanceTimer) { clearInterval(_maintenanceTimer); _maintenanceTimer = null; }
    }

    /* ═══════════════════════════════════════════════
     * LOADING SPINNER
     * ═══════════════════════════════════════════════ */

    /**
     * Show the full-screen loading spinner.
     * Calling again while visible updates the text only.
     * @param {Object} [options]
     *   text – loading text (default: 'جاري التحميل...')
     */
    function showSpinner(options) {
        options = options || {};
        const text = options.text || 'جاري التحميل...';

        if (_spinnerEl) {
            const t = _spinnerEl.querySelector('.vision-spinner-text');
            if (t) t.textContent = text;
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'vision-spinner-overlay';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-label', text);
        overlay.setAttribute('aria-live', 'polite');

        const spinner = document.createElement('div');
        spinner.className = 'vision-spinner' + (_reducedMotion() ? ' vision-spinner--no-motion' : '');

        const textEl = document.createElement('div');
        textEl.className   = 'vision-spinner-text';
        textEl.textContent = text;

        overlay.appendChild(spinner);
        overlay.appendChild(textEl);
        document.body.appendChild(overlay);
        _lockBody();
        _spinnerEl = overlay;
    }

    /** Hide the loading spinner */
    function hideSpinner() {
        if (!_spinnerEl) return;
        _spinnerEl.remove();
        _spinnerEl = null;
        _unlockBody();
    }

    /* ═══════════════════════════════════════════════
     * MODAL DIALOG
     * ═══════════════════════════════════════════════ */

    /**
     * Show a modal dialog. Returns a Promise that resolves with the
     * value of the clicked button (or null when closed without choice).
     *
     * @param {Object} options
     *   title          – heading text
     *   body           – string or HTMLElement
     *   buttons        – [{ label, value, primary }]  (default: OK + Cancel)
     *   closeable      – show × button (default true)
     *   closeOnBackdrop– click outside to close (default true)
     * @returns {Promise<*>}
     */
    function modal(options) {
        return new Promise(resolve => {
            options = options || {};
            const {
                title           = '',
                body            = '',
                buttons         = [{ label: 'موافق', value: true, primary: true }, { label: 'إلغاء', value: false }],
                closeable       = true,
                closeOnBackdrop = true
            } = options;

            const overlay = document.createElement('div');
            overlay.className = 'vision-modal-overlay';
            overlay.setAttribute('role', 'presentation');

            const dialog = document.createElement('div');
            dialog.className = 'vision-modal';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('tabindex', '-1');
            if (title) dialog.setAttribute('aria-labelledby', 'vm-title-' + Date.now());
            if (_highContrast()) dialog.style.borderWidth = '2px';

            /* ── Header ── */
            const header = document.createElement('div');
            header.className = 'vision-modal-header';

            if (title) {
                const titleEl = document.createElement('h3');
                titleEl.className   = 'vision-modal-title';
                titleEl.id          = dialog.getAttribute('aria-labelledby') || '';
                titleEl.textContent = title;
                header.appendChild(titleEl);
            }

            if (closeable) {
                const closeBtn = document.createElement('button');
                closeBtn.className = 'vision-modal-close';
                closeBtn.setAttribute('aria-label', 'إغلاق');
                closeBtn.innerHTML = '&times;';
                closeBtn.addEventListener('click', () => close(null));
                header.appendChild(closeBtn);
            }

            dialog.appendChild(header);

            /* ── Body ── */
            const bodyEl = document.createElement('div');
            bodyEl.className = 'vision-modal-body';

            if (typeof body === 'string') {
                const sec = window.VisionSecurity;
                if (sec && sec.containsHtml(body)) {
                    bodyEl.innerHTML = sec.sanitizeHtml(body);
                } else {
                    bodyEl.textContent = body;
                }
            } else if (body instanceof HTMLElement || body instanceof DocumentFragment) {
                bodyEl.appendChild(body);
            }

            dialog.appendChild(bodyEl);

            /* ── Footer ── */
            if (buttons && buttons.length) {
                const footer = document.createElement('div');
                footer.className = 'vision-modal-footer';
                buttons.forEach(btn => {
                    const el      = document.createElement('button');
                    el.className  = 'vision-toast-btn ' +
                        (btn.primary ? 'vision-toast-btn-primary' : 'vision-toast-btn-secondary');
                    el.textContent = btn.label || '';
                    el.addEventListener('click', () => close(btn.value !== undefined ? btn.value : btn.label));
                    footer.appendChild(el);
                });
                dialog.appendChild(footer);
            }

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            _modalStack.push({ overlay, close });

            /* ── Backdrop click ── */
            if (closeOnBackdrop) {
                overlay.addEventListener('click', e => {
                    if (e.target === overlay) close(null);
                });
            }

            /* ── Escape key (top modal only) ── */
            function handleEsc(e) {
                if (e.key !== 'Escape') return;
                const top = _modalStack[_modalStack.length - 1];
                if (top && top.overlay === overlay) { e.stopPropagation(); close(null); }
            }
            document.addEventListener('keydown', handleEsc, true);

            /* ── Focus trap ── */
            function getFocusable() {
                return Array.from(dialog.querySelectorAll(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                ));
            }
            dialog.addEventListener('keydown', e => {
                if (e.key !== 'Tab') return;
                const focusable = getFocusable();
                if (!focusable.length) { e.preventDefault(); return; }
                const first = focusable[0], last = focusable[focusable.length - 1];
                if (e.shiftKey) {
                    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
                } else {
                    if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
                }
            });

            /* ── Animate in then focus ── */
            if (!_reducedMotion()) {
                _nextPaint(() => {
                    overlay.classList.add('vision-modal-overlay--visible');
                    dialog.classList.add('vision-modal--visible');
                    dialog.focus();
                });
            } else {
                dialog.focus();
            }

            function close(value) {
                document.removeEventListener('keydown', handleEsc, true);
                const idx = _modalStack.findIndex(m => m.overlay === overlay);
                if (idx !== -1) _modalStack.splice(idx, 1);

                if (!_reducedMotion()) {
                    overlay.classList.add('vision-modal-overlay--exit');
                    dialog.classList.add('vision-modal--exit');
                    setTimeout(() => { overlay.remove(); resolve(value); }, 300);
                } else {
                    overlay.remove();
                    resolve(value);
                }
            }
        });
    }

    /* ═══════════════════════════════════════════════
     * INLINE BANNER
     * ═══════════════════════════════════════════════ */

    /**
     * Inject an inline banner at the top of a container element.
     *
     * @param {HTMLElement|string} container – element or CSS selector
     * @param {Object} options
     *   type        – 'info' | 'success' | 'warning' | 'error' | 'maintenance'
     *   title       – string
     *   message     – string
     *   dismissible – boolean (default true)
     *   onClose     – callback
     * @returns {HTMLElement|null}
     */
    function banner(container, options) {
        const target = typeof container === 'string'
            ? document.querySelector(container)
            : container;

        if (!(target instanceof Element)) {
            console.warn('[VisionOverlays] banner(): container not found:', container);
            return null;
        }

        options = options || {};
        const type = TOAST_TYPES.has(options.type) ? options.type : 'info';

        const el = document.createElement('div');
        el.className = 'vision-banner';
        el.setAttribute('data-type', type);
        el.setAttribute('role', 'alert');

        el.appendChild(_makeIcon(type, 'vision-banner-icon'));

        const contentEl = document.createElement('div');
        contentEl.className = 'vision-banner-content';

        if (options.title) {
            const t = document.createElement('div');
            t.className   = 'vision-banner-title';
            t.textContent = options.title;
            contentEl.appendChild(t);
        }

        if (options.message) {
            const m = document.createElement('div');
            m.className = 'vision-banner-text';
            const sec = window.VisionSecurity;
            if (sec && sec.containsHtml(options.message)) {
                m.innerHTML = sec.sanitizeHtml(options.message);
            } else {
                m.textContent = options.message;
            }
            contentEl.appendChild(m);
        }

        el.appendChild(contentEl);

        if (options.dismissible !== false) {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'vision-banner-close';
            closeBtn.setAttribute('aria-label', 'إغلاق');
            closeBtn.innerHTML = '&times;';
            closeBtn.addEventListener('click', () => {
                el.remove();
                if (typeof options.onClose === 'function') options.onClose();
            });
            el.appendChild(closeBtn);
        }

        target.insertAdjacentElement('afterbegin', el);
        return el;
    }

    /* ─────────────────────────────────────────────
     * EXPORT
     * ───────────────────────────────────────────── */
    window.VisionOverlays = {
        // Toast
        toast,
        dismissToast:    _dismiss,
        dismissAllToasts,

        // Maintenance
        showMaintenance,
        hideMaintenance,

        // Spinner
        showSpinner,
        hideSpinner,

        // Modal
        modal,

        // Banner
        banner,

        // Convenience wrappers
        info:        opts => toast(Object.assign({ type: 'info' },        _str(opts))),
        success:     opts => toast(Object.assign({ type: 'success' },     _str(opts))),
        warning:     opts => toast(Object.assign({ type: 'warning' },     _str(opts))),
        error:       opts => toast(Object.assign({ type: 'error' },       _str(opts))),
        alert:       opts => toast(Object.assign({ type: 'alert' },       _str(opts))),
        update:      opts => toast(Object.assign({ type: 'update' },      _str(opts))),
        maintenance: opts => toast(Object.assign({ type: 'maintenance' }, _str(opts)))
    };

    function _str(o) { return typeof o === 'string' ? { message: o } : (o || {}); }

    console.info('[VisionOverlays] ready');

})(window);
