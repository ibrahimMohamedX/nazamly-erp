/**
 * pages/index.js — Home Portal Controller
 *
 * Scope: today's stats + last 10 orders live feed.
 * Intentionally lightweight — full analytics live in dashboard.html.
 * Two Firestore listeners only; both cleaned up on unload.
 */
(function (window) {
  'use strict';

  /* ──────────────────────────────────────
     HELPERS
     ────────────────────────────────────── */

  const _el      = id => document.getElementById(id);
  const _setText = (id, v) => { const e = _el(id); if (e) e.textContent = v; };

  const _fmtCurrency = n =>
    (Number(n) || 0).toLocaleString('ar-EG', { maximumFractionDigits: 0 }) + ' ج.م';

  const _fmtTime = ts => {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  /* Status classification — keyword-based fallback */
  function _isDelivered(status) {
    return /تسليم|مسلم|delivered/i.test(status || '');
  }
  function _isCancelled(status) {
    return /ملغي|مرتجع|cancelled|returned|رفض/i.test(status || '');
  }

  /* ──────────────────────────────────────
     GREETING & DATE
     ────────────────────────────────────── */

  function _renderGreeting(userName) {
    const hour = new Date().getHours();
    let greeting = 'أهلاً';
    if (hour >= 5  && hour < 12) greeting = 'صباح الخير';
    if (hour >= 12 && hour < 17) greeting = 'مساء الخير';
    if (hour >= 17 && hour < 21) greeting = 'مساء النور';
    if (hour >= 21 || hour < 5)  greeting = 'مرحباً';

    _setText('heroGreeting', greeting);
    _setText('heroUserName', userName || 'مدير');
    _setText('heroBrandName', window.CLIENT_BRAND || 'Nazamly ERP');

    const now = new Date();
    const dateStr = now.toLocaleDateString('ar-EG', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    _setText('heroDate', dateStr);
  }

  /* ──────────────────────────────────────
     SUBSCRIPTION STATUS CARD
     Reads from VisionLicensing real-time cache.
     Falls back gracefully when licensing data
     is not yet available.
     ────────────────────────────────────── */

  let _unsubLicensing = null;

  /** Days remaining word in Arabic */
  function _daysWord(n) {
    const absN = Math.abs(n);
    if (absN === 1) return 'يوم';
    if (absN === 2) return 'يومان';
    if (absN >= 3 && absN <= 10) return 'أيام';
    return 'يوماً';
  }

  function _renderSubStatus(status) {
    if (!status) {
      // No licensing data yet — show loading/unknown state
      const icon = _el('subStatusIcon');
      /* FIX (audit #25): guard the icon query — this branch didn't null-check
         like its sibling at :109 (latent TypeError if the <i> was removed). */
      if (icon) {
        icon.className = 'sub-status-icon';
        const i = icon.querySelector('i');
        if (i) i.className = 'fas fa-shield-halved';
      }
      _setText('subStatusValue', 'جاري التحميل…');
      _setText('subStatusDetail', '');
      const daysEl = _el('subStatusDays');
      if (daysEl) daysEl.className = 'sub-status-days';
      _setText('subStatusDaysNum', '—');
      _setText('subStatusDaysLabel', '');
      const fill = _el('subStatusBarFill');
      if (fill) { fill.className = 'sub-status-bar-fill'; fill.style.width = '0%'; }
      return;
    }

    const isActive  = status.isActive === true;
    const endDate   = status.endDate ? new Date(status.endDate) : null;
    const now       = Date.now();
    const daysLeft  = endDate ? Math.ceil((endDate.getTime() - now) / 86_400_000) : null;

    // Determine state class suffix
    let stateClass = 'active';   // green: system running, plenty of time
    if (!isActive) {
      stateClass = 'expired';    // red: system paused/expired
    } else if (daysLeft !== null && daysLeft <= 7) {
      stateClass = 'expiring';   // yellow: ≤7 days remaining
    }

    // ── Icon ──
    const icon = _el('subStatusIcon');
    if (icon) {
      icon.className = 'sub-status-icon sub-status-icon--' + stateClass;
      const i = icon.querySelector('i');
      if (i) {
        if (stateClass === 'active')    i.className = 'fas fa-circle-check';
        else if (stateClass === 'expiring') i.className = 'fas fa-circle-exclamation';
        else                             i.className = 'fas fa-circle-xmark';
      }
    }

    // ── Value text ──
    if (!isActive) {
      _setText('subStatusValue', 'النظام متوقف');
      _setText('subStatusDetail', endDate
        ? 'انتهى الاشتراك منذ ' + Math.abs(daysLeft) + ' ' + _daysWord(daysLeft)
        : 'تم تعليق النظام من قبل المالك');
    } else if (daysLeft === null) {
      _setText('subStatusValue', 'النظام نشط');
      _setText('subStatusDetail', 'اشتراك مفتوح (بدون تاريخ انتهاء)');
    } else if (daysLeft <= 0) {
      _setText('subStatusValue', 'النظام متوقف');
      _setText('subStatusDetail', 'انتهت صلاحية الاشتراك اليوم');
    } else if (daysLeft <= 7) {
      _setText('subStatusValue', 'النظام نشط — تنتهي الصلاحية قريباً');
      _setText('subStatusDetail', 'تاريخ الانتهاء: ' + endDate.toLocaleDateString('ar-EG', {
        year: 'numeric', month: 'long', day: 'numeric'
      }));
    } else {
      _setText('subStatusValue', 'النظام نشط');
      _setText('subStatusDetail', 'تاريخ الانتهاء: ' + endDate.toLocaleDateString('ar-EG', {
        year: 'numeric', month: 'long', day: 'numeric'
      }));
    }

    // ── Days badge ──
    const daysEl = _el('subStatusDays');
    if (daysEl) {
      daysEl.className = 'sub-status-days sub-status-days--' + stateClass;
      if (daysLeft === null) {
        /* FIX (audit #23): "∞ مفتوح" only makes sense for an ACTIVE
           open-ended subscription — a PAUSED system with no endDate used to
           claim it was open while the value said "النظام متوقف". */
        if (!isActive) {
          _setText('subStatusDaysNum', '—');
          _setText('subStatusDaysLabel', 'متوقف');
        } else {
          _setText('subStatusDaysNum', '∞');
          _setText('subStatusDaysLabel', 'مفتوح');
        }
      } else if (daysLeft <= 0) {
        _setText('subStatusDaysNum', Math.abs(daysLeft).toLocaleString('ar-EG'));
        _setText('subStatusDaysLabel', 'منذ');
      } else {
        _setText('subStatusDaysNum', daysLeft.toLocaleString('ar-EG'));
        _setText('subStatusDaysLabel', _daysWord(daysLeft));
      }
    }

    // ── Progress bar ──
    const fill = _el('subStatusBarFill');
    if (fill) {
      fill.className = 'sub-status-bar-fill sub-status-bar-fill--' + stateClass;
      if (!isActive) {
        fill.style.width = '100%';
      } else if (daysLeft === null) {
        fill.style.width = '100%'; // indefinite = full green bar
      } else {
        // Show proportion of 30-day window remaining (clamped 0–100%)
        const pct = Math.max(0, Math.min(100, Math.round((daysLeft / 30) * 100)));
        fill.style.width = pct + '%';
      }
    }
  }

  function _loadSubStatus() {
    // Check if VisionLicensing is available
    if (window.VisionLicensing && typeof window.VisionLicensing.onStatusChanged === 'function') {
      _unsubLicensing = window.VisionLicensing.onStatusChanged(function (status) {
        _renderSubStatus(status);
      });
    } else if (window.VisionConfig) {
      // Fallback: read cached licensing from VisionConfig
      var lic = window.VisionConfig.get('licensing');
      _renderSubStatus(lic || null);
    } else {
      // No licensing data source — show loading state
      _renderSubStatus(null);
    }
  }

  /* ──────────────────────────────────────
     TODAY'S KPIs
     Scoped query: createdAt >= start of today
     ────────────────────────────────────── */

  let _unsubToday = null;

  function _loadTodayStats(db) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = firebase.firestore.Timestamp.fromDate(today);

    _unsubToday = db.collection('orders')
      .where('createdAt', '>=', todayTs)
      .onSnapshot(snap => {
        const orders    = snap.docs.map(d => d.data());
        const delivered = orders.filter(o => _isDelivered(o.status));
        const pending   = orders.filter(o => !_isDelivered(o.status) && !_isCancelled(o.status));
        const revenue   = delivered.reduce((s, o) => s + (o.totalCents || 0), 0) / 100;

        _setText('statTodayOrders',    orders.length);
        _setText('statTodayDelivered', delivered.length);
        _setText('statTodayRevenue',   _fmtCurrency(revenue));
        _setText('statTodayPending',   pending.length);
      }, err => {
        console.error('[Home] today stats:', err);
      });
  }

  /* ──────────────────────────────────────
     RECENT ORDERS LIVE FEED
     Last 10 orders, any date — real-time
     ────────────────────────────────────── */

  let _unsubRecent = null;

  function _loadRecentOrders(db) {
    _unsubRecent = db.collection('orders')
      .orderBy('createdAt', 'desc')
      .limit(10)
      .onSnapshot(snap => {
        _renderRecentOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, err => {
        console.error('[Home] recent orders:', err);
      });
  }

  function _renderRecentOrders(orders) {
    const tbody = _el('recentOrdersBody'); if (!tbody) return;

    if (!orders.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align:center;padding:var(--space-8);color:var(--color-text-muted);">
            لا توجد طلبات بعد
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = orders.map(o => {
      /* Status badge color */
      const isDel = _isDelivered(o.status);
      const isCan = _isCancelled(o.status);
      const badgeClass = isDel ? 'badge-success' : isCan ? 'badge-error' : 'badge-warning';

      return `<tr>
        <td>
          <div class="td-primary">${o.customerName || '—'}</div>
          <div class="text-xs text-muted" dir="ltr">${o.customerPhone || ''}</div>
        </td>
        <td>
          <span class="badge badge-dot ${badgeClass}">${o.status || 'بدون حالة'}</span>
        </td>
        <td class="font-bold" style="font-variant-numeric:tabular-nums;">
          ${_fmtCurrency((o.totalCents || 0) / 100)}
        </td>
        <td class="text-xs text-muted" style="font-variant-numeric:tabular-nums;">
          ${_fmtTime(o.createdAt)}
        </td>
      </tr>`;
    }).join('');
  }

  /* ──────────────────────────────────────
     SIDEBAR ROUTING FIX
     Update the active page to 'index'
     so الرئيسية is highlighted correctly
     ────────────────────────────────────── */

  /* ──────────────────────────────────────
     INIT
     ────────────────────────────────────── */

  function _init() {
    const user     = window.VisionAuth?.getUser();
    const userName = user?.displayName
      || localStorage.getItem('employeeName')
      || '';

    _renderGreeting(userName);

    /* Start subscription status listener early — it doesn't need auth */
    _loadSubStatus();

    AuthGuard.protect({
      adminOnly: true,
      onReady: () => {
        Sidebar.init({ activePage: 'index' });
        Topbar.init({ title: 'الرئيسية' });

        const db = firebase.firestore();
        _loadTodayStats(db);
        _loadRecentOrders(db);

        /* Hide skeleton after first render */
        const skel = _el('skeletonLoader');
        if (skel) skel.classList.add('hidden');
      },
    });

    /* Cleanup all listeners on unload */
    window.addEventListener('beforeunload', () => {
      if (_unsubToday)      { try { _unsubToday();      } catch (_) {} }
      if (_unsubRecent)     { try { _unsubRecent();     } catch (_) {} }
      if (_unsubLicensing)  { try { _unsubLicensing();  } catch (_) {} }
    });
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);
