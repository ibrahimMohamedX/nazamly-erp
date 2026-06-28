/**
 * VisionSecurity — XSS Protection & Validation
 * ==============================================
 * Provides HTML entity encoding, URL sanitisation, DOM-parser
 * based HTML whitelisting, notification payload validation, and
 * a cryptographically-safe ID generator.
 *
 * Usage:
 *   VisionSecurity.escapeHtml('<script>alert(1)</script>');
 *   VisionSecurity.sanitizeUrl('javascript:alert(1)'); // → null
 *   const id = VisionSecurity.generateId(12);
 */
(function (window) {
    'use strict';

    /* ─────────────────────────────────────────────
     * CONSTANTS
     * ───────────────────────────────────────────── */
    const ESCAPE_MAP = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '`': '&#x60;',
        '=': '&#x3D;',
        '/': '&#x2F;'
    };

    /** Blocked URL protocols – block dangerous inline execution */
    const BLOCKED_PROTO = /^(javascript|data|vbscript|file|blob)\s*:/i;

    /** Whitelist of tags that survive sanitizeHtml() */
    const ALLOWED_TAGS = new Set([
        'b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'span', 'div',
        'a', 'ul', 'ol', 'li',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
    ]);

    /** Whitelist of attributes that survive sanitizeHtml() */
    const ALLOWED_ATTRS = new Set(['href', 'title', 'target', 'class', 'dir', 'lang']);

    /** Valid notification type strings */
    const VALID_TYPES = new Set([
        'info', 'success', 'warning', 'error', 'alert', 'update', 'maintenance'
    ]);

    /** Valid notification severity strings */
    const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

    const MAX_TITLE   = 200;
    const MAX_MESSAGE = 1000;
    const MAX_ACTION  = 100;

    /* ─────────────────────────────────────────────
     * PUBLIC API
     * ───────────────────────────────────────────── */

    /**
     * Encode characters that could start HTML injection.
     * Covers:  &  <  >  "  '  `  =  /
     * @param {*} text  – anything; coerced to string
     * @returns {string}
     */
    function escapeHtml(text) {
        if (typeof text !== 'string') text = String(text == null ? '' : text);
        return text.replace(/[&<>"'`=\/]/g, ch => ESCAPE_MAP[ch] || ch);
    }

    /**
     * Sanitize a URL string.
     * Blocks javascript:, data:, vbscript:, file:, blob: schemes.
     * Relative URLs, http(s):, mailto:, tel: are allowed.
     *
     * @param {string} url
     * @returns {string|null}  Safe URL or null if blocked
     */
    function sanitizeUrl(url) {
        if (!url || typeof url !== 'string') return null;
        const trimmed = url.trim();
        if (!trimmed) return null;

        // Decode percent-encoding before checking to foil obfuscation
        let decoded = trimmed;
        try { decoded = decodeURIComponent(trimmed.replace(/\s/g, '')); } catch (_) { /* keep trimmed */ }

        if (BLOCKED_PROTO.test(decoded)) return null;

        // Allow relative URLs (#, /, ?), http(s), mailto, tel
        if (/^(https?:|mailto:|tel:|\/|#|\?|\.\.)/.test(trimmed)) return trimmed;

        // If the scheme is unknown, block it
        if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return null;

        // Looks like a bare relative path – allow
        return trimmed;
    }

    /**
     * Sanitize an HTML string using DOMParser and a strict whitelist.
     * Unknown tags are unwrapped (children kept); unknown attributes are dropped.
     *
     * @param {string} html
     * @returns {string}
     */
    function sanitizeHtml(html) {
        if (!html || typeof html !== 'string') return '';
        try {
            const parser = new DOMParser();
            const doc    = parser.parseFromString(html, 'text/html');

            function sanitizeNode(node) {
                // Text nodes are safe as-is
                if (node.nodeType === Node.TEXT_NODE) return node.cloneNode(false);
                if (node.nodeType !== Node.ELEMENT_NODE) return null;

                const tag = node.tagName.toLowerCase();

                if (!ALLOWED_TAGS.has(tag)) {
                    // Unwrap: recurse into children and return a fragment
                    const frag = document.createDocumentFragment();
                    node.childNodes.forEach(child => {
                        const sanitized = sanitizeNode(child);
                        if (sanitized) frag.appendChild(sanitized);
                    });
                    return frag;
                }

                const el = document.createElement(tag);

                // Copy whitelisted attributes
                node.attributes && Array.from(node.attributes).forEach(attr => {
                    const name = attr.name.toLowerCase();
                    if (!ALLOWED_ATTRS.has(name)) return;

                    if (name === 'href') {
                        const safe = sanitizeUrl(attr.value);
                        if (safe) el.setAttribute('href', safe);
                    } else {
                        el.setAttribute(name, attr.value);
                    }
                });

                // Anchor: rel="noopener noreferrer" if target="_blank"
                if (tag === 'a' && el.getAttribute('target') === '_blank') {
                    el.setAttribute('rel', 'noopener noreferrer');
                }

                // Recurse children
                node.childNodes.forEach(child => {
                    const sanitized = sanitizeNode(child);
                    if (sanitized) el.appendChild(sanitized);
                });

                return el;
            }

            const wrapper = document.createElement('div');
            doc.body.childNodes.forEach(child => {
                const s = sanitizeNode(child);
                if (s) wrapper.appendChild(s);
            });
            return wrapper.innerHTML;

        } catch (e) {
            console.error('[VisionSecurity] sanitizeHtml error:', e);
            return escapeHtml(html);
        }
    }

    /**
     * Validate and sanitize a raw notification data object.
     *
     * @param {Object} data
     * @returns {{ valid: boolean, errors: string[], sanitized: Object|null }}
     */
    function validateNotification(data) {
        const errors    = [];
        const sanitized = {};

        if (!data || typeof data !== 'object') {
            return { valid: false, errors: ['Notification data must be an object'], sanitized: null };
        }

        // ── type ──────────────────────────────────────────────────────────
        if (data.type && !VALID_TYPES.has(data.type)) {
            errors.push('Invalid type "' + data.type + '". Defaulting to "info"');
        }
        sanitized.type = VALID_TYPES.has(data.type) ? data.type : 'info';

        // ── severity ──────────────────────────────────────────────────────
        if (data.severity && !VALID_SEVERITIES.has(data.severity)) {
            errors.push('Invalid severity "' + data.severity + '". Defaulting to "low"');
        }
        sanitized.severity = VALID_SEVERITIES.has(data.severity) ? data.severity : 'low';

        // ── title ─────────────────────────────────────────────────────────
        if (data.title) {
            const t = typeof data.title === 'string' ? data.title : String(data.title);
            if (t.length > MAX_TITLE) errors.push('Title exceeds ' + MAX_TITLE + ' chars');
            sanitized.title = escapeHtml(t.substring(0, MAX_TITLE));
        } else {
            sanitized.title = '';
        }

        // ── message ───────────────────────────────────────────────────────
        if (data.message) {
            const m = typeof data.message === 'string' ? data.message : String(data.message);
            if (m.length > MAX_MESSAGE) errors.push('Message exceeds ' + MAX_MESSAGE + ' chars');
            const truncated = m.substring(0, MAX_MESSAGE);
            sanitized.message = containsHtml(truncated) ? sanitizeHtml(truncated) : escapeHtml(truncated);
        } else {
            sanitized.message = '';
        }

        // ── duration ──────────────────────────────────────────────────────
        sanitized.duration = (typeof data.duration === 'number' && data.duration > 0)
            ? Math.min(data.duration, 300_000) : undefined;

        // ── flags ─────────────────────────────────────────────────────────
        sanitized.persistent  = !!data.persistent;
        sanitized.dismissible = data.dismissible !== false;

        // ── actions ───────────────────────────────────────────────────────
        if (Array.isArray(data.actions)) {
            sanitized.actions = data.actions
                .filter(a => a && typeof a === 'object')
                .map(a => ({
                    label:    escapeHtml(String(a.label || '').substring(0, MAX_ACTION)),
                    primary:  !!a.primary,
                    callback: typeof a.callback === 'function' ? a.callback : null
                }))
                .filter(a => a.label);
        } else {
            sanitized.actions = [];
        }

        // ── passthrough ───────────────────────────────────────────────────
        if (data.id)        sanitized.id        = String(data.id).replace(/[^a-zA-Z0-9_-]/g, '');
        if (data.timestamp) sanitized.timestamp = data.timestamp;
        if (data.position)  sanitized.position  = data.position;

        return { valid: errors.length === 0, errors, sanitized };
    }

    /**
     * Generate a cryptographically safe random hex string.
     * @param {number} [byteLength=8]  – bytes; output length = byteLength × 2
     * @returns {string}
     */
    function generateId(byteLength) {
        const len = Math.max(4, Math.min(byteLength || 8, 64));
        try {
            const arr = new Uint8Array(len);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (_) {
            return 'vs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 2 + len);
        }
    }

    /**
     * Quick check: does the string contain HTML tags?
     * @param {string} str
     * @returns {boolean}
     */
    function containsHtml(str) {
        return typeof str === 'string' && /<[a-z][\s\S]*>/i.test(str);
    }

    /* ─────────────────────────────────────────────
     * EXPORT
     * ───────────────────────────────────────────── */
    window.VisionSecurity = {
        escapeHtml,
        sanitizeUrl,
        sanitizeHtml,
        validateNotification,
        generateId,
        containsHtml
    };

    console.info('[VisionSecurity] ready');

})(window);
