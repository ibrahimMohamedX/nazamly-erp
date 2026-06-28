/**
 * VisionNotifications — Advanced Notification Helpers
 * =====================================================
 * High-level wrappers around VisionOverlays and VisionConfig
 * for common ERP notification patterns.
 *
 * Requires VisionOverlays and VisionConfig to be loaded first.
 *
 * Usage:
 *   VisionNotifications.alert({ title: 'تحذير', message: 'حدث خطأ ما' });
 *   VisionNotifications.update({ message: 'تحديث متاح', actionCallback: doUpdate });
 *   VisionNotifications.batch(notifArray, { delay: 300 });
 *   VisionNotifications.createNotificationCenter('#nc-widget');
 */
(function (window) {
    'use strict';

    /* ─────────────────────────────────────────────
     * HELPERS
     * ───────────────────────────────────────────── */

    /** Simple djb2-style hash for deduplication */
    function _hash(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
        return (h >>> 0).toString(36);
    }

    /** Relative-time label in Arabic */
    function _relTime(ts) {
        const diff = Date.now() - ts;
        const sec  = Math.floor(diff / 1000);
        if (sec < 60)  return 'منذ لحظات';
        const min  = Math.floor(sec / 60);
        if (min < 60)  return 'منذ ' + min + ' دقيقة';
        const hr   = Math.floor(min / 60);
        if (hr  < 24)  return 'منذ ' + hr  + ' ساعة';
        return 'منذ ' + Math.floor(hr / 24) + ' يوم';
    }

    /** Format an Arabic date-time string */
    function _fmtDate(date) {
        try {
            return date.toLocaleString('ar-EG', {
                year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        } catch (_) { return date.toISOString(); }
    }

    const FA = {
        info: 'fa-circle-info', success: 'fa-circle-check',
        warning: 'fa-triangle-exclamation', error: 'fa-circle-xmark',
        alert: 'fa-bell', update: 'fa-arrow-up-right-dots', maintenance: 'fa-wrench'
    };

    /* ─────────────────────────────────────────────
     * DEDUP HISTORY (alert type only)
     * ───────────────────────────────────────────── */
    const _alertHistory = new Set();

    /* ─────────────────────────────────────────────
     * PUBLIC API
     * ───────────────────────────────────────────── */

    /**
     * High-priority alert. Persistent by default.
     * Deduplicates by title+message hash for 10 minutes.
     *
     * @param {Object|string} options
     *   title, message, severity, persistent, modal (bool),
     *   dedup (bool, default true), position, actions
     * @returns {string|null} notification id
     */
    function alert(options) {
        const opts = typeof options === 'string' ? { message: options } : (options || {});
        const {
            title     = 'تنبيه',
            message   = '',
            severity  = 'high',
            persistent = true,
            modal     = false,
            dedup     = true,
            actions   = [],
            position  = 'top-left'
        } = opts;

        // Deduplication
        if (dedup) {
            const key = _hash(title + ':' + message);
            if (_alertHistory.has(key)) return null;
            _alertHistory.add(key);
            setTimeout(() => _alertHistory.delete(key), 10 * 60 * 1000);
        }

        let id = null;

        // Store in config
        if (window.VisionConfig) {
            id = window.VisionConfig.addNotification({
                type: 'alert', severity, title, message, persistent, timestamp: Date.now()
            });
        }

        if (modal && window.VisionOverlays) {
            window.VisionOverlays.modal({
                title,
                body: message,
                buttons: actions.length
                    ? actions.map(a => ({ label: a.label, value: a, primary: a.primary }))
                    : [{ label: 'حسناً', value: true, primary: true }]
            });
        } else if (window.VisionOverlays) {
            id = window.VisionOverlays.toast({
                id, type: 'alert', title, message,
                duration: persistent ? 0 : 10000,
                position, actions
            });
        }
        return id;
    }

    /**
     * Update-available notification with a primary action button.
     *
     * @param {Object|string} options
     *   title, message, actionLabel, actionCallback, duration, position
     * @returns {string|null}
     */
    function update(options) {
        const opts = typeof options === 'string' ? { message: options } : (options || {});
        const {
            title          = 'تحديث متاح',
            message        = '',
            actionLabel    = 'تحديث الآن',
            actionCallback,
            duration       = 8000,
            position       = 'top-left'
        } = opts;

        const actions = actionLabel
            ? [{ label: actionLabel, primary: true, callback: actionCallback || null }]
            : [];

        if (window.VisionConfig) {
            window.VisionConfig.addNotification({
                type: 'update', severity: 'medium', title, message, timestamp: Date.now()
            });
        }

        if (window.VisionOverlays) {
            return window.VisionOverlays.toast({ type: 'update', title, message, duration, position, actions });
        }
        return null;
    }

    /**
     * Warning toast with a longer default duration.
     *
     * @param {Object|string} options
     *   title, message, severity, duration, position
     * @returns {string|null}
     */
    function warning(options) {
        const opts = typeof options === 'string' ? { message: options } : (options || {});
        const {
            title    = 'تحذير',
            message  = '',
            severity = 'medium',
            duration = 10000,
            position = 'top-left'
        } = opts;

        if (window.VisionConfig) {
            window.VisionConfig.addNotification({
                type: 'warning', severity, title, message, timestamp: Date.now()
            });
        }

        if (window.VisionOverlays) {
            return window.VisionOverlays.toast({ type: 'warning', title, message, duration, position });
        }
        return null;
    }

    /**
     * Inline banner (announce) wrapper.
     *
     * @param {HTMLElement|string} container
     * @param {Object}             options
     * @returns {HTMLElement|null}
     */
    function announce(container, options) {
        if (!window.VisionOverlays) return null;
        return window.VisionOverlays.banner(container, options);
    }

    /**
     * Show multiple toasts with staggered delivery.
     *
     * @param {Array}  notifications – array of toast option objects
     * @param {Object} [options]     – { delay: ms, position }
     */
    function batch(notifications, options) {
        if (!Array.isArray(notifications)) return;
        const { delay = 350, position } = options || {};

        notifications.forEach((notif, idx) => {
            setTimeout(() => {
                if (!window.VisionOverlays) return;
                const merged = Object.assign({ position: position || 'top-left' }, notif);
                window.VisionOverlays.toast(merged);
            }, idx * delay);
        });
    }

    /**
     * Evaluate subscription state and show appropriate warnings.
     *
     * @param {Object} data – { isActive, tier, daysRemaining, expiryDate }
     */
    function subscriptionStatus(data) {
        if (!data || !window.VisionOverlays) return;
        const { isActive, tier, daysRemaining } = data;

        if (!isActive) {
            window.VisionOverlays.toast({
                type:       'error',
                title:      'الاشتراك منتهي',
                message:    'انتهى اشتراكك. يرجى التواصل مع الدعم لتجديده.',
                duration:   0,
                persistent: true
            });
            return;
        }

        if (typeof daysRemaining === 'number' && daysRemaining <= 7 && daysRemaining > 0) {
            window.VisionOverlays.toast({
                type:    'warning',
                title:   'تنبيه: الاشتراك على وشك الانتهاء',
                message: 'متبقي ' + daysRemaining + ' أيام على انتهاء اشتراكك' +
                         (tier ? ' (' + tier + ')' : '') + '.',
                duration: 0
            });
        }
    }

    /**
     * Show a scheduled-maintenance announcement.
     *
     * @param {Object} options – { title, message, startTime, endTime, position }
     * @returns {string|null}
     */
    function maintenanceNotice(options) {
        options = options || {};
        const {
            title     = 'صيانة مجدولة',
            startTime,
            endTime,
            message,
            position  = 'top-left'
        } = options;

        let body = message || 'سيكون النظام تحت الصيانة قريباً.';
        if (startTime) {
            body = 'الصيانة المجدولة ستبدأ في: ' + _fmtDate(new Date(startTime));
            if (endTime) body += ' — حتى ' + _fmtDate(new Date(endTime));
        }

        if (window.VisionConfig) {
            window.VisionConfig.addNotification({
                type: 'maintenance', severity: 'medium', title, message: body, timestamp: Date.now()
            });
        }

        if (window.VisionOverlays) {
            return window.VisionOverlays.toast({ type: 'maintenance', title, message: body, duration: 0, position });
        }
        return null;
    }

    /**
     * Render a notification-center widget inside a container.
     * Shows all queued notifications from VisionConfig with relative timestamps
     * and mark-as-read / dismiss controls.
     *
     * @param {HTMLElement|string} container
     * @returns {HTMLElement|null} The created widget root
     */
    function createNotificationCenter(container) {
        const target = typeof container === 'string'
            ? document.querySelector(container)
            : container;

        if (!(target instanceof Element)) {
            console.warn('[VisionNotifications] createNotificationCenter: container not found');
            return null;
        }

        const root = document.createElement('div');
        root.className = 'vision-notification-center';
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', 'مركز الإشعارات');

        /* ── Header ── */
        const header = document.createElement('div');
        header.className = 'vision-nc-header';

        const heading = document.createElement('h3');
        heading.className   = 'vision-nc-title';
        heading.textContent = 'الإشعارات';

        const markAllBtn = document.createElement('button');
        markAllBtn.className   = 'vision-nc-mark-all';
        markAllBtn.textContent = 'تحديد الكل كمقروء';
        markAllBtn.addEventListener('click', () => {
            if (!window.VisionConfig) return;
            window.VisionConfig.getNotifications().forEach(n =>
                window.VisionConfig.markAsRead(n.id));
            render();
        });

        header.appendChild(heading);
        header.appendChild(markAllBtn);
        root.appendChild(header);

        /* ── List ── */
        const list = document.createElement('div');
        list.className = 'vision-nc-list';
        list.setAttribute('role', 'list');
        root.appendChild(list);

        /* ── Render function ── */
        function render() {
            list.innerHTML = '';
            const notifications = window.VisionConfig
                ? window.VisionConfig.getNotifications()
                : [];

            if (!notifications.length) {
                const empty = document.createElement('div');
                empty.className   = 'vision-nc-empty';
                empty.textContent = 'لا توجد إشعارات';
                list.appendChild(empty);
                return;
            }

            notifications.forEach(notif => {
                const item = document.createElement('div');
                item.className = 'vision-nc-item' + (notif.read ? ' vision-nc-item--read' : '');
                item.setAttribute('role', 'listitem');
                item.setAttribute('data-type', notif.type || 'info');

                // Icon
                const iconEl = document.createElement('div');
                iconEl.className = 'vision-nc-item-icon';
                iconEl.innerHTML = '<i class="fas ' + (FA[notif.type] || 'fa-bell') + '"></i>';

                // Content
                const contentEl = document.createElement('div');
                contentEl.className = 'vision-nc-item-content';

                const titleEl   = document.createElement('div');
                titleEl.className   = 'vision-nc-item-title';
                titleEl.textContent = notif.title || '';

                const msgEl = document.createElement('div');
                msgEl.className   = 'vision-nc-item-message';
                msgEl.textContent = notif.message || '';

                const timeEl = document.createElement('div');
                timeEl.className   = 'vision-nc-item-time';
                timeEl.textContent = _relTime(notif.timestamp || Date.now());

                contentEl.appendChild(titleEl);
                contentEl.appendChild(msgEl);
                contentEl.appendChild(timeEl);

                // Dismiss
                const dismissBtn = document.createElement('button');
                dismissBtn.className = 'vision-nc-item-dismiss';
                dismissBtn.setAttribute('aria-label', 'حذف الإشعار');
                dismissBtn.textContent = '×';
                dismissBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    if (window.VisionConfig) window.VisionConfig.removeNotification(notif.id);
                    render();
                });

                item.appendChild(iconEl);
                item.appendChild(contentEl);
                item.appendChild(dismissBtn);

                // Click = mark as read
                item.addEventListener('click', () => {
                    if (window.VisionConfig) window.VisionConfig.markAsRead(notif.id);
                    item.classList.add('vision-nc-item--read');
                });

                list.appendChild(item);
            });
        }

        /* ── Subscribe to config events ── */
        if (window.VisionConfig) {
            window.VisionConfig.on('notification:added',   render);
            window.VisionConfig.on('notification:removed', render);
            window.VisionConfig.on('notification:read',    render);
        }

        render();
        target.appendChild(root);
        return root;
    }

    /* ─────────────────────────────────────────────
     * EXPORT
     * ───────────────────────────────────────────── */
    window.VisionNotifications = {
        alert,
        update,
        warning,
        announce,
        batch,
        subscriptionStatus,
        maintenanceNotice,
        createNotificationCenter
    };

    console.info('[VisionNotifications] ready');

})(window);
