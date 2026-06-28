/**
 * VisionConfig — Central State Management
 * =========================================
 * Single source of truth for the entire ERP overlay system.
 * Provides a dot-notation key/value store, a typed event bus,
 * a notification queue, and helpers for maintenance / subscription state.
 *
 * Usage:
 *   VisionConfig.set('system.status', 'maintenance');
 *   VisionConfig.get('subscription.tier');
 *   const off = VisionConfig.on('notification:added', n => console.log(n));
 *   off(); // unsubscribe
 */
(function (window) {
    'use strict';

    /* ─────────────────────────────────────────────
     * INTERNAL STORE
     * ───────────────────────────────────────────── */
    const _store = {
        notifications: [],
        maintenance: {
            enabled:       false,
            startTime:     null,   // ISO string or null
            endTime:       null,   // ISO string or null
            message:       '',
            bypassAllowed: true,
            countdownTarget: null
        },
        subscription: {
            tier:         'free',
            expiryDate:   null,    // ISO string or null
            features:     [],
            isActive:     false,
            userId:       null,
            daysRemaining: null
        },
        system: {
            status:      'operational', // operational | maintenance | degraded | emergency
            lastUpdated: null,
            message:     ''
        },
        user:        null,
        role:        null,
        permissions: {},
        settings:    {}
    };

    // Listener registry: { 'event': [fn, fn, …] }
    const _listeners = {};

    /* ─────────────────────────────────────────────
     * PATH UTILITIES
     * ───────────────────────────────────────────── */

    /** Read a value at dot-notation path, e.g. 'system.status' */
    function _read(obj, path) {
        return path.split('.').reduce((acc, key) =>
            (acc !== null && acc !== undefined) ? acc[key] : undefined, obj);
    }

    /** Write a value at dot-notation path, creating intermediate objects */
    function _write(obj, path, value) {
        const keys    = path.split('.');
        const lastKey = keys.pop();
        const target  = keys.reduce((acc, key) => {
            if (acc[key] === undefined || acc[key] === null || typeof acc[key] !== 'object') {
                acc[key] = {};
            }
            return acc[key];
        }, obj);
        target[lastKey] = value;
    }

    /* ─────────────────────────────────────────────
     * PUBLIC API — STORE
     * ───────────────────────────────────────────── */

    /**
     * Get a value from the store.
     * @param {string} [path] – Dot-notation path. Omit to get full store snapshot.
     * @returns {*}
     */
    function get(path) {
        if (!path) return JSON.parse(JSON.stringify(_store));
        return _read(_store, path);
    }

    /**
     * Set a value in the store and emit change events.
     * @param {string} path
     * @param {*}      value
     */
    function set(path, value) {
        if (!path) { console.warn('[VisionConfig] set() requires a path'); return; }
        const oldValue = _read(_store, path);
        _write(_store, path, value);
        emit('change',         { path, oldValue, newValue: value });
        emit('change:' + path, { oldValue, newValue: value });
    }

    /**
     * Shallow-merge an object into the value at path.
     * @param {string} path
     * @param {Object} obj
     */
    function merge(path, obj) {
        if (typeof obj !== 'object' || obj === null) {
            console.warn('[VisionConfig] merge() requires a plain object');
            return;
        }
        const current = _read(_store, path) || {};
        set(path, Object.assign({}, current, obj));
    }

    /* ─────────────────────────────────────────────
     * PUBLIC API — EVENTS
     * ───────────────────────────────────────────── */

    /**
     * Subscribe to an event.
     * @param {string}   event
     * @param {Function} callback
     * @returns {Function} Unsubscribe function
     */
    function on(event, callback) {
        if (!_listeners[event]) _listeners[event] = [];
        _listeners[event].push(callback);
        return function unsubscribe() {
            _listeners[event] = (_listeners[event] || []).filter(cb => cb !== callback);
        };
    }

    /**
     * Emit an event to all registered listeners.
     * @param {string} event
     * @param {*}      [data]
     */
    function emit(event, data) {
        (_listeners[event] || []).forEach(cb => {
            try { cb(data); } catch (e) {
                console.error('[VisionConfig] Error in listener for "' + event + '":', e);
            }
        });
    }

    /* ─────────────────────────────────────────────
     * PUBLIC API — NOTIFICATIONS QUEUE
     * ───────────────────────────────────────────── */

    /**
     * Add a notification. Skips duplicates by id.
     * @param {Object} notification
     * @returns {string} Assigned id
     */
    function addNotification(notification) {
        const id = notification.id || _genId();
        const exists = _store.notifications.find(n => n.id === id);
        if (exists) return id;

        const entry = Object.assign({
            id,
            type:       'info',
            title:      '',
            message:    '',
            severity:   'low',
            read:       false,
            persistent: false,
            timestamp:  Date.now()
        }, notification, { id });

        _store.notifications.unshift(entry);
        emit('notification:added', entry);
        return id;
    }

    /**
     * Remove a notification by id.
     * @param {string} id
     */
    function removeNotification(id) {
        const idx = _store.notifications.findIndex(n => n.id === id);
        if (idx === -1) return;
        const removed = _store.notifications.splice(idx, 1)[0];
        emit('notification:removed', removed);
    }

    /**
     * Mark a notification as read.
     * @param {string} id
     */
    function markAsRead(id) {
        const n = _store.notifications.find(n => n.id === id);
        if (!n) return;
        n.read = true;
        emit('notification:read', n);
    }

    /**
     * Get notifications, optionally filtered.
     * @param {Object} [filter] – { type, read, severity }
     * @returns {Array}
     */
    function getNotifications(filter) {
        let list = _store.notifications.slice();
        if (!filter) return list;
        if (filter.type     !== undefined) list = list.filter(n => n.type     === filter.type);
        if (filter.read     !== undefined) list = list.filter(n => n.read     === filter.read);
        if (filter.severity !== undefined) list = list.filter(n => n.severity === filter.severity);
        return list;
    }

    /* ─────────────────────────────────────────────
     * PUBLIC API — MAINTENANCE
     * ───────────────────────────────────────────── */

    /**
     * Returns true when maintenance mode is active right now.
     * Respects startTime / endTime windows.
     */
    function isMaintenanceMode() {
        const m = _store.maintenance;
        if (!m.enabled) return false;
        const now   = Date.now();
        const start = m.startTime ? new Date(m.startTime).getTime() : null;
        const end   = m.endTime   ? new Date(m.endTime).getTime()   : null;
        if (start && now < start) return false;
        if (end   && now > end)   return false;
        return true;
    }

    /* ─────────────────────────────────────────────
     * HELPERS
     * ───────────────────────────────────────────── */
    function _genId() {
        try {
            const arr = new Uint8Array(8);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (_) {
            return 'vc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        }
    }

    /* ─────────────────────────────────────────────
     * EXPORT
     * ───────────────────────────────────────────── */
    window.VisionConfig = {
        get,
        set,
        merge,
        on,
        emit,
        addNotification,
        removeNotification,
        markAsRead,
        getNotifications,
        isMaintenanceMode,
        /** Deep-cloned snapshot of the full store */
        snapshot() { return JSON.parse(JSON.stringify(_store)); }
    };

    console.info('[VisionConfig] ready');

})(window);
