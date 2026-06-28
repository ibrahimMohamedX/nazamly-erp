/**
 * shared/topbar.js — Topbar Component
 *
 * Renders into the existing .topbar element.
 * Wires: live clock, notification count, page title.
 * Mobile menu toggle is handled by sidebar.js — NOT here.
 *
 * Usage:
 *   Topbar.init({ title: 'لوحة التحكم' });
 */
(function (window) {
  'use strict';

  var _clockTimer = null;
  var _cleanupFns = [];

  /* ── Live clock ── */
  function _startClock() {
    var el = document.getElementById('topbarClock');
    if (!el) return;

    function tick() {
      el.textContent = new Date().toLocaleTimeString('ar-EG', {
        hour:   '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
    }
    tick();
    _clockTimer = setInterval(tick, 1000);
  }

  /* ── Notification badge count ── */
  function _updateBadge() {
    var badge = document.getElementById('topbarNotifBadge');
    if (!badge) return;
    if (!window.VisionConfig || typeof window.VisionConfig.getNotifications !== 'function') {
      badge.hidden = true;
      return;
    }
    try {
      var unread = window.VisionConfig.getNotifications({ read: false });
      badge.textContent = unread.length;
      badge.hidden = unread.length === 0;
    } catch (_) {
      badge.hidden = true;
    }
  }

  /* ── Wire notification panel toggle ── */
  function _bindNotifToggle() {
    var btn   = document.getElementById('topbarNotifBtn');
    var panel = document.getElementById('topbarNotifPanel');
    if (!btn || !panel) return;

    var toggleHandler = function (e) {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      if (!panel.hidden) _renderNotifPanel(panel);
    };

    var docHandler = function (e) {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) {
        panel.hidden = true;
      }
    };

    btn.addEventListener('click', toggleHandler);
    document.addEventListener('click', docHandler);
    _cleanupFns.push(function () {
      btn.removeEventListener('click', toggleHandler);
      document.removeEventListener('click', docHandler);
    });
  }

  /* ── Render notification dropdown ── */
  function _renderNotifPanel(panel) {
    if (!window.VisionConfig || typeof window.VisionConfig.getNotifications !== 'function') {
      panel.innerHTML = '<div class="vision-notification-center" style="min-width:300px;">'
        + '<div class="vision-nc-header"><h3 class="vision-nc-title">الإشعارات</h3></div>'
        + '<div class="vision-nc-empty">غير متاح</div></div>';
      return;
    }

    var notifications = [];
    try {
      notifications = (window.VisionConfig.getNotifications() || []).slice(0, 8);
    } catch (_) {
      notifications = [];
    }

    if (!notifications.length) {
      panel.innerHTML = '<div class="vision-notification-center" style="min-width:300px;">'
        + '<div class="vision-nc-header"><h3 class="vision-nc-title">الإشعارات</h3></div>'
        + '<div class="vision-nc-empty">لا توجد إشعارات جديدة</div></div>';
      return;
    }

    var typeIcon = {
      info: 'fa-circle-info',
      success: 'fa-circle-check',
      warning: 'fa-triangle-exclamation',
      error: 'fa-circle-xmark',
      maintenance: 'fa-wrench'
    };

    var itemsHtml = notifications.map(function (n) {
      return '<div class="vision-nc-item' + (n.read ? ' vision-nc-item--read' : '') + '" data-id="' + (n.id || '') + '">'
        + '<div class="vision-nc-item-icon" data-type="' + (n.type || 'info') + '">'
        + '<i class="fas ' + (typeIcon[n.type] || 'fa-bell') + '"></i></div>'
        + '<div class="vision-nc-item-content">'
        + '<div class="vision-nc-item-title">' + (n.title || '') + '</div>'
        + '<div class="vision-nc-item-message">' + (n.message || '') + '</div>'
        + '<div class="vision-nc-item-time">' + _relativeTime(n.timestamp) + '</div>'
        + '</div>'
        + '<button class="vision-nc-item-dismiss" data-id="' + (n.id || '') + '" title="رفض">\u00D7</button>'
        + '</div>';
    }).join('');

    panel.innerHTML = '<div class="vision-notification-center" style="min-width:320px;">'
      + '<div class="vision-nc-header">'
      + '<h3 class="vision-nc-title">الإشعارات</h3>'
      + '<button class="vision-nc-mark-all" id="markAllRead">تعليم كمقروء</button>'
      + '</div>'
      + '<div class="vision-nc-list">' + itemsHtml + '</div>'
      + '</div>';

    /* Mark all read */
    var markAllBtn = panel.querySelector('#markAllRead');
    if (markAllBtn) {
      var markAllHandler = function () {
        notifications.forEach(function (n) {
          try { window.VisionConfig.markAsRead(n.id); } catch (_) {}
        });
        _updateBadge();
        panel.hidden = true;
      };
      markAllBtn.addEventListener('click', markAllHandler);
    }

    /* Individual dismiss */
    panel.querySelectorAll('.vision-nc-item-dismiss').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        try { window.VisionConfig.removeNotification(btn.dataset.id); } catch (_) {}
        _updateBadge();
        _renderNotifPanel(panel);
      });
    });
  }

  /* ── Relative time label ── */
  function _relativeTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
    var m = Math.floor(diff / 60000);
    if (m < 1)  return 'الآن';
    if (m < 60) return 'منذ ' + m + ' دقيقة';
    var h = Math.floor(m / 60);
    if (h < 24) return 'منذ ' + h + ' ساعة';
    return 'منذ ' + Math.floor(h / 24) + ' يوم';
  }

  /* ── Inject dynamic elements into topbar ── */
  function _inject(title) {
    var bar = document.querySelector('.topbar');
    if (!bar) return;

    bar.innerHTML = ''
      /* Mobile menu toggle (sidebar.js binds the click) */
      + '<button class="topbar-mobile-menu" id="mobileMenuBtn" aria-label="فتح القائمة">'
      + '<i class="fas fa-bars" aria-hidden="true"></i>'
      + '</button>'

      /* Page title */
      + '<span class="topbar-title" id="topbarTitle">' + (title || '') + '</span>'

      /* Spacer */
      + '<div style="flex:1"></div>'

      /* Live indicator */
      + '<span class="live-dot" title="البيانات مباشرة" aria-hidden="true"></span>'

      /* Live clock */
      + '<span id="topbarClock" style="font-size:var(--font-size-xs);color:var(--color-text-muted);font-variant-numeric:tabular-nums;" aria-live="off"></span>'

      /* Notification button + dropdown */
      + '<div style="position:relative;">'
      +   '<button class="topbar-icon-btn" id="topbarNotifBtn" aria-label="الإشعارات" title="الإشعارات">'
      +     '<i class="fas fa-bell" aria-hidden="true"></i>'
      +     '<span id="topbarNotifBadge" class="topbar-badge" hidden aria-label="إشعارات غير مقروءة"></span>'
      +   '</button>'
      +   '<div id="topbarNotifPanel" hidden role="region" aria-label="قائمة الإشعارات"'
      +     ' style="position:fixed;top:56px;left:16px;z-index:9990;background:var(--color-surface);'
      +     'border:1px solid var(--color-border-light);border-radius:var(--radius-lg);'
      +     'box-shadow:0 8px 32px rgba(0,0,0,0.12);overflow:hidden;max-height:420px;overflow-y:auto;">'
      +   '</div>'
      + '</div>';
  }

  /* ── Subscribe to VisionConfig events ── */
  function _subscribeNotifications() {
    if (!window.VisionConfig) return;
    if (typeof window.VisionConfig.on === 'function') {
      window.VisionConfig.on('notification:added',   _updateBadge);
      window.VisionConfig.on('notification:removed', _updateBadge);
      window.VisionConfig.on('notification:read',    _updateBadge);
    }
  }

  /* ── Public API ── */

  /**
   * Initialize topbar.
   * @param {Object} [options]
   * @param {string} [options.title] — Page title text
   */
  function init(options) {
    options = options || {};
    destroy();
    _inject(options.title || '');
    _startClock();
    _updateBadge();
    /* Mobile menu binding removed — sidebar.js owns this exclusively */
    _bindNotifToggle();
    _subscribeNotifications();
  }

  /** Update title text after init */
  function setTitle(text) {
    var el = document.getElementById('topbarTitle');
    if (el) el.textContent = text;
  }

  /** Cleanup clock interval and listeners */
  function destroy() {
    _cleanupFns.forEach(function (fn) { try { fn(); } catch (_) {} });
    _cleanupFns = [];
    if (_clockTimer) { clearInterval(_clockTimer); _clockTimer = null; }
  }

  /* Auto-cleanup on page unload */
  window.addEventListener('beforeunload', destroy);

  window.Topbar = { init: init, setTitle: setTitle, destroy: destroy };
  console.info('[Topbar] ready');

})(window);