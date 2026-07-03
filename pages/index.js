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
        const revenue   = delivered.reduce((s, o) => s + (Number(o.total) || 0), 0);

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
          ${_fmtCurrency(o.total)}
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

    /* Cleanup both listeners on unload */
    window.addEventListener('beforeunload', () => {
      if (_unsubToday)  { try { _unsubToday();  } catch (_) {} }
      if (_unsubRecent) { try { _unsubRecent(); } catch (_) {} }
    });
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);
