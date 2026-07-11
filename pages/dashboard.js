/**
 * pages/dashboard.js — Analytics Dashboard Controller
 *
 * Architecture:
 *   DataStore  → holds all loaded Firestore data in memory
 *   _loaded    → Set tracking which sources are ready
 *   _unsubs    → all onSnapshot unsubscribers (cleaned up on unload)
 *   _charts    → Chart.js instance registry (destroyed before re-render)
 *   _period    → currently selected date window { from, to, key }
 *   _tab       → active tab identifier
 *
 * Race condition fix:
 *   Multiple simultaneous onSnapshot callbacks call _scheduleRender(),
 *   which debounces all renders into a single 60ms-delayed _render()
 *   call. _render() exits early unless ALL required sources are loaded.
 */
(function (window) {
  'use strict';

  /* ──────────────────────────────────────
     CONSTANTS
     ────────────────────────────────────── */

  /* Chart color palette (matches design tokens) */
  const C = {
    primary: 'rgb(59,130,246)',
    success: 'rgb(16,185,129)',
    warning: 'rgb(245,158,11)',
    error:   'rgb(239,68,68)',
    alert:   'rgb(139,92,246)',
    cyan:    'rgb(6,182,212)',
    pink:    'rgb(236,72,153)',
    orange:  'rgb(249,115,22)',
  };
  const PALETTE = [C.primary, C.success, C.warning, C.alert, C.error, C.cyan, C.pink, C.orange];

  /* All sources that must load before first render */
  const REQUIRED_SOURCES = ['orders','expenses','employees','statuses','products','platforms','shippingCompanies'];

  const ARABIC_DAYS = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];

  /* ──────────────────────────────────────
     DATA STORE
     ────────────────────────────────────── */

  const Store = {
    orders:           [],
    expenses:         [],
    employees:        [],
    statuses:         [],
    products:         [],
    platforms:        [],
    shippingCompanies:[],
    goals:            null,
  };

  /* Tracks which sources have received their first snapshot */
  const _loaded = new Set();

  /* ──────────────────────────────────────
     LIFECYCLE REGISTRIES
     ────────────────────────────────────── */

  const _unsubs  = [];   /* Firestore unsubscribers */
  const _charts  = {};   /* Chart.js instances by canvas ID */

  /* ──────────────────────────────────────
     PAGE STATE
     ────────────────────────────────────── */

  let _period = null;        /* { from:Date, to:Date, key:string } */
  let _tab    = 'overview';

  /* Render debounce timer */
  let _renderTimer = null;

  /* ──────────────────────────────────────
     PERIOD UTILITIES
     ────────────────────────────────────── */

  function _buildPeriod(key) {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (key) {
      case 'today':     return { from: today, to: now, key };
      case 'yesterday': {
        const y  = new Date(today); y.setDate(y.getDate() - 1);
        const ye = new Date(y);     ye.setHours(23, 59, 59, 999);
        return { from: y, to: ye, key };
      }
      case '7d':   return { from: new Date(today.getTime() - 6  * 86400000), to: now, key };
      case '30d':  return { from: new Date(today.getTime() - 29 * 86400000), to: now, key };
      case '90d':  return { from: new Date(today.getTime() - 89 * 86400000), to: now, key };
      case 'month':return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now, key };
      case 'ytd':  return { from: new Date(now.getFullYear(), 0, 1), to: now, key };
      default:     return { from: new Date(today.getTime() - 29 * 86400000), to: now, key: '30d' };
    }
  }

  /* Compute the immediately preceding period of equal length (for trend comparisons) */
  function _prevPeriod() {
    if (!_period) return null;
    const span = _period.to.getTime() - _period.from.getTime();
    return {
      from: new Date(_period.from.getTime() - span - 1),
      to:   new Date(_period.from.getTime() - 1),
    };
  }

  /* ──────────────────────────────────────
     STATUS CLASSIFICATION
     ────────────────────────────────────── */

  /* Classify an order status string using the statuses collection,
     with keyword fallback for when the collection isn't yet loaded */
  function _statusType(name) {
    const rec = Store.statuses.find(s => s.name === name);
    if (rec && rec.type) return rec.type;
    /* Keyword fallback */
    const lc = (name || '').toLowerCase();
    if (/تسليم|مسلم|delivered|تسلم/.test(lc))            return 'delivered';
    if (/ملغي|مرتجع|cancelled|returned|رفض|return/.test(lc)) return 'cancelled';
    return 'active';
  }

  const _isDelivered = o => _statusType(o.status) === 'delivered';
  const _isCancelled = o => _statusType(o.status) === 'cancelled';

  /* ──────────────────────────────────────
     PERIOD FILTERING
     ────────────────────────────────────── */

  function _toDate(ts) {
    if (!ts) return null;
    return ts.toDate ? ts.toDate() : new Date(ts);
  }

  function _inWindow(ts, from, to) {
    const d = _toDate(ts);
    return d && d >= from && d <= to;
  }

  function _filteredOrders(from, to) {
    const f = from || _period?.from;
    const t = to   || _period?.to;
    if (!f || !t) return Store.orders;
    return Store.orders.filter(o => _inWindow(o.createdAt, f, t));
  }

  function _filteredExpenses(from, to) {
    const f = from || _period?.from;
    const t = to   || _period?.to;
    if (!f || !t) return Store.expenses;
    return Store.expenses.filter(e => _inWindow(e.date, f, t));
  }

  /* ──────────────────────────────────────
     KPI COMPUTATION
     ────────────────────────────────────── */

  function _computeKPIs(orders, expenses) {
    const delivered = orders.filter(_isDelivered);
    const cancelled = orders.filter(_isCancelled);

    const totalRevenue  = delivered.reduce((s, o) => s + (Number(o.total)       || 0), 0);
    const shippingCosts = delivered.reduce((s, o) => s + (Number(o.shippingCost)|| 0), 0);
    const grossProfit   = delivered.reduce((s, o) => s + (Number(o.profit)      || 0), 0);
    const productCost   = delivered.reduce((s, o) => s + (Number(o.cost)        || 0), 0);
    const totalExpenses = expenses.reduce ((s, e) => s + (Number(e.amount)      || 0), 0);
    const netProfit     = grossProfit - totalExpenses;
    const aov           = delivered.length ? totalRevenue / delivered.length : 0;
    const deliveryRate  = orders.length    ? Math.round(delivered.length / orders.length * 100) : 0;
    const uniqueCustomers = new Set(orders.map(o => o.customerPhone).filter(Boolean)).size;

    return {
      total: orders.length, delivered: delivered.length,
      cancelled: cancelled.length,
      active: orders.length - delivered.length - cancelled.length,
      totalRevenue, shippingCosts, productCost,
      grossProfit, totalExpenses, netProfit,
      aov, deliveryRate, uniqueCustomers,
    };
  }

  /* ──────────────────────────────────────
     FORMATTING HELPERS
     ────────────────────────────────────── */

  const _fmt = (n, dec = 0) =>
    (typeof n === 'number' && !isNaN(n))
      ? n.toLocaleString('ar-EG', { maximumFractionDigits: dec, minimumFractionDigits: dec })
      : '0';

  const _fmtCurrency = n =>
    (typeof n === 'number' && !isNaN(n))
      ? n.toLocaleString('ar-EG', { maximumFractionDigits: 0 }) + ' ج.م'
      : '0 ج.م';

  const _pct = (v, t) => (t ? Math.round((v / t) * 100) : 0);

  /* Trend badge HTML (positive = up = good) */
  function _trendHtml(curr, prev) {
    if (!prev || prev === 0) return '';
    const diff = curr - prev;
    const pct  = Math.abs(_pct(diff, prev));
    const up   = diff >= 0;
    return `<span class="kpi-trend kpi-trend--${up ? 'up' : 'down'}">
      <i class="fas fa-arrow-${up ? 'up' : 'down'}"></i>${pct}%
    </span>`;
  }

  /* ──────────────────────────────────────
     DOM HELPERS
     ────────────────────────────────────── */

  const _el   = id  => document.getElementById(id);
  const _setText = (id, v) => { const e = _el(id); if (e) e.textContent = v; };
  const _setHtml = (id, v) => { const e = _el(id); if (e) e.innerHTML   = v; };

  /* ──────────────────────────────────────
     CHART UTILITIES
     ────────────────────────────────────── */

  /* Always destroy before re-creating to prevent canvas reuse errors */
  function _resetChart(id) {
    if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
  }

  /* Shared dark-mode Chart.js defaults */
  const _cDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 450 },
    plugins: {
      legend: { labels: { color: '#94A3B8', font: { family: 'Cairo', size: 12 }, padding: 16 } },
      tooltip: {
        backgroundColor: '#1E293B', titleColor: '#F8FAFC', bodyColor: '#94A3B8',
        borderColor: '#334155', borderWidth: 1, padding: 10,
        titleFont: { family: 'Cairo', weight: '700' },
        bodyFont:  { family: 'Cairo', size: 12 },
      },
    },
    scales: {
      x: { ticks: { color: '#64748B', font: { family: 'Cairo', size: 11 } }, grid: { color: '#1E293B' } },
      y: { ticks: { color: '#64748B', font: { family: 'Cairo', size: 11 } }, grid: { color: '#1E293B' } },
    },
  };

  /* Merge options without losing nested defaults */
  function _opts(overrides) {
    return {
      ..._cDefaults,
      ...overrides,
      plugins: { ..._cDefaults.plugins, ...(overrides.plugins || {}) },
      scales:  overrides.scales !== undefined ? overrides.scales : _cDefaults.scales,
    };
  }

  /* Group delivered orders by day within period, accumulate a numeric field */
  function _groupByDay(orders, field) {
    if (!_period) return { labels: [], values: [] };
    const span = Math.ceil((_period.to - _period.from) / 86400000) + 1;
    const map  = new Map();
    for (let i = 0; i < span; i++) {
      const d = new Date(_period.from);
      d.setDate(d.getDate() + i);
      map.set(d.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' }), 0);
    }
    orders.forEach(o => {
      const d   = _toDate(o.createdAt);
      if (!d) return;
      const key = d.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' });
      if (map.has(key)) map.set(key, map.get(key) + (Number(o[field]) || 0));
    });
    return { labels: [...map.keys()], values: [...map.values()] };
  }

  /* ──────────────────────────────────────
     CHART RENDERS
     ────────────────────────────────────── */

  function _drawRevenue(orders) {
    const id = 'revenueChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    const del = orders.filter(_isDelivered);
    const { labels, values } = _groupByDay(del, 'total');
    _charts[id] = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{
        label: 'الإيرادات', data: values,
        borderColor: C.primary, backgroundColor: 'rgba(59,130,246,0.08)',
        borderWidth: 2.5, tension: 0.45, fill: true, pointRadius: 3, pointHoverRadius: 6,
      }] },
      options: _opts({ plugins: { ..._cDefaults.plugins, legend: { display: false } } }),
    });
  }

  function _drawStatus(orders) {
    const id = 'statusChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    const counts = {};
    orders.forEach(o => { const k = o.status || 'غير محدد'; counts[k] = (counts[k] || 0) + 1; });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    _charts[id] = new Chart(canvas, {
      type: 'doughnut',
      data: { labels: entries.map(e => e[0]), datasets: [{
        data: entries.map(e => e[1]),
        backgroundColor: PALETTE.slice(0, entries.length),
        borderColor: '#111827', borderWidth: 3, hoverOffset: 8,
      }] },
      options: _opts({ scales: undefined, cutout: '68%' }),
    });
  }

  function _drawMonthly(orders) {
    const id = 'monthlyChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    /* Last 6 calendar months */
    const now = new Date();
    const months = new Map();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.set(d.toLocaleDateString('ar-EG', { month: 'short', year: '2-digit' }), 0);
    }
    /* Use ALL Store.orders (not period-filtered) for monthly history */
    Store.orders.filter(_isDelivered).forEach(o => {
      const d = _toDate(o.createdAt); if (!d) return;
      const k = d.toLocaleDateString('ar-EG', { month: 'short', year: '2-digit' });
      if (months.has(k)) months.set(k, months.get(k) + (Number(o.total) || 0));
    });
    _charts[id] = new Chart(canvas, {
      type: 'bar',
      data: { labels: [...months.keys()], datasets: [{
        label: 'الإيرادات', data: [...months.values()],
        backgroundColor: 'rgba(59,130,246,0.7)',
        borderRadius: 6, borderSkipped: false,
      }] },
      options: _opts({}),
    });
  }

  function _drawFinancialDaily(orders, expenses) {
    const id = 'financialDailyChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    const del = orders.filter(_isDelivered);
    const { labels, values: revenue } = _groupByDay(del, 'total');
    const profit = _groupByDay(del, 'profit').values;
    /* Map expenses to same labels */
    const expMap = new Map(labels.map(l => [l, 0]));
    expenses.forEach(e => {
      const d = _toDate(e.date); if (!d) return;
      const k = d.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' });
      if (expMap.has(k)) expMap.set(k, expMap.get(k) + (Number(e.amount) || 0));
    });
    _charts[id] = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'الإيرادات', data: revenue,                    borderColor: C.primary, borderWidth: 2, tension: 0.4, fill: 'origin', backgroundColor: 'rgba(59,130,246,0.04)' },
        { label: 'الأرباح',   data: profit,                    borderColor: C.success, borderWidth: 2, tension: 0.4 },
        { label: 'المصاريف',  data: labels.map(l => expMap.get(l) || 0), borderColor: C.error, borderWidth: 2, tension: 0.4 },
      ] },
      options: _opts({}),
    });
  }

  function _drawAovTrend(orders) {
    const id = 'aovTrendChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    if (!_period) return;
    const del  = orders.filter(_isDelivered);
    const span = Math.ceil((_period.to - _period.from) / 86400000) + 1;
    const map  = new Map();
    for (let i = 0; i < span; i++) {
      const d = new Date(_period.from); d.setDate(d.getDate() + i);
      map.set(d.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' }), { sum: 0, n: 0 });
    }
    del.forEach(o => {
      const d = _toDate(o.createdAt); if (!d) return;
      const k = d.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' });
      if (map.has(k)) { const e = map.get(k); e.sum += Number(o.total) || 0; e.n++; }
    });
    _charts[id] = new Chart(canvas, {
      type: 'line',
      data: { labels: [...map.keys()], datasets: [{
        label: 'متوسط قيمة الطلب',
        data: [...map.values()].map(e => e.n ? Math.round(e.sum / e.n) : 0),
        borderColor: C.alert, backgroundColor: 'rgba(139,92,246,0.06)',
        borderWidth: 2.5, tension: 0.4, fill: true, pointRadius: 3,
      }] },
      options: _opts({ plugins: { ..._cDefaults.plugins, legend: { display: false } } }),
    });
  }

  function _drawTopGovernorates(orders) {
    const id = 'topGovernoratesChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    const counts = {};
    orders.filter(_isDelivered).forEach(o => {
      const g = o.governorate || 'غير محدد';
      counts[g] = (counts[g] || 0) + 1;
    });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    _charts[id] = new Chart(canvas, {
      type: 'bar',
      data: { labels: top.map(e => e[0]), datasets: [{
        label: 'الطلبات المسلمة', data: top.map(e => e[1]),
        backgroundColor: PALETTE, borderRadius: 6, borderSkipped: false,
      }] },
      options: _opts({ indexAxis: 'y' }),
    });
  }

  function _drawGender(orders) {
    const id = 'genderChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    const male   = orders.filter(o => o.gender === 'male').length;
    const female = orders.filter(o => o.gender === 'female').length;
    const other  = orders.length - male - female;
    _charts[id] = new Chart(canvas, {
      type: 'doughnut',
      data: { labels: ['ذكور', 'إناث', 'غير محدد'], datasets: [{
        data: [male, female, other],
        backgroundColor: [C.primary, C.pink, '#334155'],
        borderColor: '#111827', borderWidth: 3, hoverOffset: 6,
      }] },
      options: _opts({ scales: undefined, cutout: '65%' }),
    });
  }

  function _drawCustomerType(orders) {
    const id = 'customerTypeChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    const ret  = orders.filter(o => o.customerType === 'returning').length;
    const newC = orders.length - ret;
    _charts[id] = new Chart(canvas, {
      type: 'doughnut',
      data: { labels: ['عملاء جدد', 'عملاء عائدون'], datasets: [{
        data: [newC, ret],
        backgroundColor: [C.cyan, C.alert],
        borderColor: '#111827', borderWidth: 3, hoverOffset: 6,
      }] },
      options: _opts({ scales: undefined, cutout: '65%' }),
    });
  }

  function _drawPayment(orders) {
    const id = 'paymentTypeChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    const cod    = orders.filter(o => /cod|كاش|استلام/i.test(o.paymentType || '')).length;
    const online = orders.length - cod;
    _charts[id] = new Chart(canvas, {
      type: 'doughnut',
      data: { labels: ['كاش عند الاستلام', 'دفع إلكتروني'], datasets: [{
        data: [cod, online],
        backgroundColor: [C.warning, C.success],
        borderColor: '#111827', borderWidth: 3, hoverOffset: 6,
      }] },
      options: _opts({ scales: undefined, cutout: '65%' }),
    });
  }

  function _drawShippingDistribution(orders) {
    const id = 'shippingDistributionChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    const counts = {};
    orders.forEach(o => {
      const s = o.shippingCompanyName || o.shippingCompanyId || 'غير محدد';
      counts[s] = (counts[s] || 0) + 1;
    });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    _charts[id] = new Chart(canvas, {
      type: 'doughnut',
      data: { labels: entries.map(e => e[0]), datasets: [{
        data: entries.map(e => e[1]),
        backgroundColor: PALETTE.slice(0, entries.length),
        borderColor: '#111827', borderWidth: 3, hoverOffset: 6,
      }] },
      options: _opts({ scales: undefined, cutout: '60%' }),
    });
  }

  function _drawPlatforms(orders) {
    const id = 'platformsChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    const counts = {};
    orders.forEach(o => { const p = o.platform || 'مباشر'; counts[p] = (counts[p] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    _charts[id] = new Chart(canvas, {
      type: 'bar',
      data: { labels: top.map(e => e[0]), datasets: [{
        label: 'عدد الطلبات', data: top.map(e => e[1]),
        backgroundColor: PALETTE, borderRadius: 6, borderSkipped: false,
      }] },
      options: _opts({}),
    });
  }

  function _drawEmployeeDelivery(orders) {
    const id = 'employeeDeliveryChart'; _resetChart(id);
    const canvas = _el(id); if (!canvas) return;
    const map = new Map();
    orders.forEach(o => {
      const eid = o.employeeId || 'unknown';
      if (!map.has(eid)) map.set(eid, { del: 0, total: 0 });
      const e = map.get(eid);
      e.total++;
      if (_isDelivered(o)) e.del++;
    });
    const top = [...map.entries()]
      .map(([eid, e]) => {
        const emp  = Store.employees.find(x => x.id === eid || x.uid === eid);
        return { name: emp?.name || eid, rate: _pct(e.del, e.total) };
      })
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 8);
    _charts[id] = new Chart(canvas, {
      type: 'bar',
      data: { labels: top.map(e => e.name), datasets: [{
        label: 'نسبة التسليم %', data: top.map(e => e.rate),
        backgroundColor: top.map(e => e.rate >= 70 ? C.success : e.rate >= 50 ? C.warning : C.error),
        borderRadius: 6, borderSkipped: false,
      }] },
      options: _opts({ scales: { ..._cDefaults.scales, y: { ..._cDefaults.scales.y, max: 100 } } }),
    });
  }

  /* ──────────────────────────────────────
     WIDGET RENDERS
     ────────────────────────────────────── */

  function _renderPnL(orders, expenses) {
    const el = _el('profitLossStatement'); if (!el) return;
    const del       = orders.filter(_isDelivered);
    const revenue   = del.reduce((s, o) => s + (Number(o.total)       || 0), 0);
    const shipCost  = del.reduce((s, o) => s + (Number(o.shippingCost)|| 0), 0);
    const prodCost  = del.reduce((s, o) => s + (Number(o.cost)        || 0), 0);
    const gross     = del.reduce((s, o) => s + (Number(o.profit)      || 0), 0);
    const totalExp  = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const net       = gross - totalExp;
    const margin    = revenue ? Math.round((net / revenue) * 100) : 0;

    const row = (lbl, val, cls = '') =>
      `<div class="pnl-row">
        <span class="pnl-row-label">${lbl}</span>
        <span class="pnl-row-value ${cls}">${_fmtCurrency(val)}</span>
      </div>`;

    el.innerHTML = `
      <div class="pnl-grid" style="margin-bottom:var(--space-5);">
        <div class="pnl-item"><div class="pnl-label">إجمالي الإيرادات</div><div class="pnl-value">${_fmtCurrency(revenue)}</div></div>
        <div class="pnl-item"><div class="pnl-label">مجمل الربح</div><div class="pnl-value pnl-value--${gross>=0?'positive':'negative'}">${_fmtCurrency(gross)}</div></div>
        <div class="pnl-item"><div class="pnl-label">صافي الربح</div><div class="pnl-value pnl-value--${net>=0?'positive':'negative'}">${_fmtCurrency(net)}</div></div>
        <div class="pnl-item"><div class="pnl-label">هامش الربح الصافي</div><div class="pnl-value pnl-value--${margin>=0?'positive':'negative'}">${margin}%</div></div>
      </div>
      <div class="card"><div class="card-body">
        ${row('إجمالي الإيرادات', revenue)}
        ${row('(−) تكلفة الشحن',  shipCost, 'text-warning')}
        ${row('(−) تكلفة المنتجات', prodCost, 'text-warning')}
        <div class="pnl-divider"></div>
        ${row('= مجمل الربح', gross, gross>=0?'text-success':'text-error')}
        ${row('(−) إجمالي المصاريف', totalExp, 'text-error')}
        <div class="pnl-divider"></div>
        ${row('= صافي الربح', net, net>=0?'text-success':'text-error')}
      </div></div>`;
  }

  function _renderGoals(kpis) {
    const el = _el('goalsContainer'); if (!el) return;
    if (!Store.goals) {
      el.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-bullseye"></i></div><div class="empty-state-title">لم يتم تحديد أهداف</div><div class="empty-state-desc">يمكن تحديد الأهداف من إعدادات النظام</div></div>`;
      return;
    }
    const goals = Store.goals;
    const items = [
      { label: 'هدف الإيرادات', target: goals.revenue,      current: kpis.totalRevenue },
      { label: 'هدف الطلبات',   target: goals.orders,       current: kpis.total },
      { label: 'هدف نسبة التسليم', target: goals.deliveryRate, current: kpis.deliveryRate, isPct: true },
      { label: 'هدف الربح الصافي', target: goals.netProfit,  current: kpis.netProfit },
    ].filter(g => g.target > 0);
    if (!items.length) { el.innerHTML = `<p class="text-muted" style="text-align:center;padding:var(--space-6);">لا توجد أهداف محددة بعد.</p>`; return; }

    el.innerHTML = `<div class="goals-grid">${items.map(g => {
      const pct = Math.min(Math.round((g.current / g.target) * 100), 100);
      const cls = pct >= 100 ? 'met' : pct >= 70 ? 'close' : 'far';
      return `<div class="goal-item">
        <div class="goal-header"><span class="goal-label">${g.label}</span><span class="goal-pct goal-pct--${cls}">${pct}%</span></div>
        <div class="goal-progress-track"><div class="goal-progress-bar goal-progress-bar--${cls}" style="width:${pct}%"></div></div>
        <div class="goal-meta"><span>${g.isPct ? g.current + '%' : _fmtCurrency(g.current)}</span><span>${g.isPct ? g.target + '%' : _fmtCurrency(g.target)}</span></div>
      </div>`;
    }).join('')}</div>`;
  }

  function _renderLeaderboard(orders) {
    const el = _el('employeesLeaderboard'); if (!el) return;
    const map = new Map();
    orders.filter(_isDelivered).forEach(o => {
      const id = o.employeeId || 'unknown';
      if (!map.has(id)) map.set(id, { id, n: 0, rev: 0 });
      const e = map.get(id); e.n++; e.rev += Number(o.total) || 0;
    });
    const sorted = [...map.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    if (!sorted.length) { el.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-users"></i></div><div class="empty-state-title">لا توجد بيانات</div></div>`; return; }
    const rankCls = i => ['lb-rank--1','lb-rank--2','lb-rank--3'][i] || 'lb-rank--n';
    el.innerHTML = `<div class="leaderboard">${sorted.map((item, i) => {
      const emp  = Store.employees.find(e => e.id === item.id || e.uid === item.id);
      const name = emp?.name || 'موظف';
      const init = name.split(' ').map(w => w[0] || '').join('').slice(0, 2);
      const total = orders.filter(o => (o.employeeId || 'unknown') === item.id).length;
      return `<div class="leaderboard-item">
        <div class="lb-rank ${rankCls(i)}">${i + 1}</div>
        <div class="lb-avatar">${init}</div>
        <div class="lb-info">
          <div class="lb-name">${name}</div>
          <div class="lb-meta">نسبة التسليم: ${_pct(item.n, total)}%</div>
        </div>
        <div class="lb-stats">
          <div class="lb-orders">${_fmt(item.n)} طلب</div>
          <div class="lb-revenue">${_fmtCurrency(item.rev)}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  function _renderEmployeeTable(orders) {
    const tbody = _el('employeesDetailTableBody'); if (!tbody) return;
    const map = new Map();
    orders.forEach(o => {
      const id = o.employeeId || 'unknown';
      if (!map.has(id)) map.set(id, { id, total: 0, del: 0, can: 0, rev: 0 });
      const e = map.get(id); e.total++;
      if (_isDelivered(o))  { e.del++; e.rev += Number(o.total) || 0; }
      if (_isCancelled(o))  e.can++;
    });
    const rows = [...map.values()].sort((a, b) => b.del - a.del);
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty-state-title" style="text-align:center;padding:var(--space-8);">لا توجد بيانات للفترة المحددة</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => {
      const emp  = Store.employees.find(e => e.id === r.id || e.uid === r.id);
      const rate = _pct(r.del, r.total);
      return `<tr>
        <td class="td-primary">${emp?.name || r.id}</td>
        <td class="td-numeric">${_fmt(r.total)}</td>
        <td class="td-numeric text-success">${_fmt(r.del)}</td>
        <td class="td-numeric text-error">${_fmt(r.can)}</td>
        <td><span class="badge badge-dot ${rate>=70?'badge-success':rate>=50?'badge-warning':'badge-error'}">${rate}%</span></td>
        <td class="td-numeric text-success">${_fmtCurrency(r.rev)}</td>
      </tr>`;
    }).join('');
  }

  function _renderBestDays(orders) {
    const el = _el('bestDaysContainer'); if (!el) return;
    const counts = [0,0,0,0,0,0,0];
    orders.forEach(o => { const d = _toDate(o.createdAt); if (d) counts[d.getDay()]++; });
    const max  = Math.max(...counts, 1);
    const best = counts.indexOf(Math.max(...counts));
    el.innerHTML = `<div class="best-days-grid">${ARABIC_DAYS.map((name, i) => `
      <div class="day-cell ${i===best?'day-cell--best':''}">
        <div class="day-name">${name}</div>
        <div class="day-count">${_fmt(counts[i])}</div>
        <div class="day-bar"><div class="day-bar-fill" style="width:${Math.round(counts[i]/max*100)}%"></div></div>
      </div>`).join('')}</div>`;
  }

  function _renderTopProducts(orders) {
    const el = _el('topProductsContainer'); if (!el) return;
    const map = new Map();
    orders.filter(_isDelivered).forEach(o => {
      (o.items || []).forEach(item => {
        const id = item.productId || item.name || 'unknown';
        if (!map.has(id)) map.set(id, { name: item.name || id, qty: 0, rev: 0, profit: 0 });
        const p = map.get(id);
        const qty = Number(item.qty) || 1;
        p.qty    += qty;
        p.rev    += (Number(item.price || 0)) * qty;
        p.profit += (Number(item.profit || 0)) * qty;
      });
    });
    const top = [...map.values()].sort((a, b) => b.rev - a.rev).slice(0, 10);
    if (!top.length) { el.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-box"></i></div><div class="empty-state-title">لا توجد بيانات</div></div>`; return; }
    el.innerHTML = `<div class="table-wrapper"><table class="table">
      <thead><tr><th>المنتج</th><th>الكمية</th><th>الإيرادات</th><th>الأرباح</th></tr></thead>
      <tbody>${top.map((p, i) => `<tr>
        <td class="td-primary">${i+1}. ${p.name}</td>
        <td class="td-numeric">${_fmt(p.qty)}</td>
        <td class="td-numeric text-brand">${_fmtCurrency(p.rev)}</td>
        <td class="td-numeric text-success">${_fmtCurrency(p.profit)}</td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  /* ──────────────────────────────────────
     MAIN RENDER ORCHESTRATOR
     ────────────────────────────────────── */

  function _render() {
    /* Exit until all sources loaded — prevents partial renders */
    if (!REQUIRED_SOURCES.every(k => _loaded.has(k))) return;

    const orders   = _filteredOrders();
    const expenses = _filteredExpenses();
    const prev     = _prevPeriod();
    const prevKpis = prev ? _computeKPIs(_filteredOrders(prev.from, prev.to), _filteredExpenses(prev.from, prev.to)) : {};
    const kpis     = _computeKPIs(orders, expenses);

    /* KPI cards */
    _setText('kpiTotalOrders',     _fmt(kpis.total));
    _setText('kpiDelivered',       _fmt(kpis.delivered));
    _setText('kpiDeliveryRate',    'نسبة التسليم: ' + kpis.deliveryRate + '%');
    _setText('kpiCancelled',       _fmt(kpis.cancelled));
    _setText('kpiRevenue',         _fmtCurrency(kpis.totalRevenue));
    _setText('kpiNetProfit',       _fmtCurrency(kpis.netProfit));
    _setText('kpiAOV',             _fmtCurrency(kpis.aov));
    _setText('kpiExpenses',        _fmtCurrency(kpis.totalExpenses));
    _setText('kpiActiveCustomers', _fmt(kpis.uniqueCustomers));

    /* Trend badges (comparison with prior period) */
    _setHtml('kpiRevenueTrend',  _trendHtml(kpis.totalRevenue,  prevKpis.totalRevenue));
    _setHtml('kpiOrdersTrend',   _trendHtml(kpis.total,         prevKpis.total));
    _setHtml('kpiDeliveryTrend', _trendHtml(kpis.deliveryRate,  prevKpis.deliveryRate));
    _setHtml('kpiProfitTrend',   _trendHtml(kpis.netProfit,     prevKpis.netProfit));

    /* Charts always shown in overview */
    _drawRevenue(orders);
    _drawStatus(orders);
    _drawMonthly(orders);

    /* Tab-specific renders — avoids wasted work off-screen */
    if (_tab === 'financial')  { _drawFinancialDaily(orders, expenses); _renderPnL(orders, expenses); _renderGoals(kpis); }
    if (_tab === 'orders')     { _drawAovTrend(orders); _renderBestDays(orders); _renderTopProducts(orders); }
    if (_tab === 'customers')  { _drawGender(orders); _drawCustomerType(orders); _drawTopGovernorates(orders); }
    if (_tab === 'shipping')   { _drawShippingDistribution(orders); _drawPayment(orders); }
    if (_tab === 'marketing')  { _drawPlatforms(orders); }
    if (_tab === 'employees')  { _renderLeaderboard(orders); _renderEmployeeTable(orders); _drawEmployeeDelivery(orders); }

    /* Dismiss skeleton on first successful render */
    const skel = _el('skeletonLoader');
    if (skel && !skel.classList.contains('hidden')) skel.classList.add('hidden');
  }

  /* Debounced render entry point */
  function _scheduleRender() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(_render, 60);
  }

  /* ──────────────────────────────────────
     DATA LOADING
     ────────────────────────────────────── */

  function _markLoaded(key, data) {
    Store[key] = data;
    _loaded.add(key);
    _scheduleRender();
  }

  /**
   * Defensive Timestamp constructor. firebase.firestore is a namespace
   * object attached by firebase-firestore-compat.js — normally guaranteed
   * present by the time this runs (AuthGuard.protect()'s onReady only
   * fires after Firebase has fully resolved, per the auth-guard.js v2
   * fix). This guard is a second line of defense against any edge case
   * (e.g. a corrupted CDN cache) that could leave the namespace missing,
   * so a single bad load can degrade gracefully instead of throwing an
   * uncaught TypeError that halts the entire dashboard render.
   * @param {Date} date
   * @returns {firebase.firestore.Timestamp|Date} a real Timestamp, or the
   *   raw Date as a fallback (Firestore query operators also accept Date
   *   objects directly, so queries still function, just less precisely).
   */
  function _safeTimestamp(date) {
    try {
      if (
        typeof firebase !== 'undefined' &&
        firebase.firestore &&
        firebase.firestore.Timestamp &&
        typeof firebase.firestore.Timestamp.fromDate === 'function'
      ) {
        return firebase.firestore.Timestamp.fromDate(date);
      }
      console.warn('[Dashboard] firebase.firestore.Timestamp unavailable — falling back to raw Date.');
      return date;
    } catch (e) {
      console.warn('[Dashboard] _safeTimestamp failed, using raw Date fallback:', e);
      return date;
    }
  }

  function _loadData() {
    /* Defensive guard: firebase.firestore() itself must resolve before
       any query can be built. If this throws, mark every source loaded
       with empty data so _render()'s REQUIRED_SOURCES gate is satisfied
       and the page shows an empty (not frozen) dashboard, with a visible
       error toast so the failure is never silent. */
    let db;
    try {
      db = firebase.firestore();
    } catch (e) {
      console.error('[Dashboard] firebase.firestore() failed:', e);
      window.VisionOverlays?.toast({
        type: 'error',
        title: 'تعذّر الاتصال بقاعدة البيانات',
        message: 'يرجى إعادة تحميل الصفحة. إذا استمرت المشكلة تواصل مع الدعم الفني.',
      });
      REQUIRED_SOURCES.forEach(k => _markLoaded(k, []));
      return;
    }

    /* Load last 13 months so all period options are covered */
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 13);
    const cutoffTs = _safeTimestamp(cutoff);

    /* Real-time: orders */
    _unsubs.push(
      db.collection('orders')
        .where('createdAt', '>=', cutoffTs)
        .orderBy('createdAt', 'desc')
        .onSnapshot(
          snap => _markLoaded('orders', snap.docs.map(d => ({ id: d.id, ...d.data() }))),
          err  => { console.error('[Dashboard] orders:', err); _markLoaded('orders', []); }
        )
    );

    /* Real-time: expenses */
    _unsubs.push(
      db.collection('expenses')
        .where('date', '>=', cutoffTs)
        .onSnapshot(
          snap => _markLoaded('expenses', snap.docs.map(d => ({ id: d.id, ...d.data() }))),
          err  => { console.error('[Dashboard] expenses:', err); _markLoaded('expenses', []); }
        )
    );

    /* One-time static reference collections (batched for efficiency) */
    Promise.all([
      db.collection('statuses').get(),
      db.collection('employees').get(),
      db.collection('products').get(),
      db.collection('platforms').get(),
      db.collection('shippingCompanies').get(),
    ]).then(([st, em, pr, pl, sh]) => {
      _markLoaded('statuses',          st.docs.map(d => ({ id: d.id, ...d.data() })));
      _markLoaded('employees',         em.docs.map(d => ({ id: d.id, ...d.data() })));
      _markLoaded('products',          pr.docs.map(d => ({ id: d.id, ...d.data() })));
      _markLoaded('platforms',         pl.docs.map(d => ({ id: d.id, ...d.data() })));
      _markLoaded('shippingCompanies', sh.docs.map(d => ({ id: d.id, ...d.data() })));
    }).catch(err => {
      console.error('[Dashboard] static collections:', err);
      ['statuses','employees','products','platforms','shippingCompanies']
        .forEach(k => _markLoaded(k, []));
    });

    /* Goals: silent failure is acceptable */
    db.collection('goals').doc('main').get()
      .then(doc => { Store.goals = doc.exists ? doc.data() : null; })
      .catch(() => { Store.goals = null; });
  }

  /* ──────────────────────────────────────
     PERIOD & TAB BINDINGS
     ────────────────────────────────────── */

  function _bindPeriodBar() {
    document.querySelectorAll('.period-btn[data-period]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _period = _buildPeriod(btn.dataset.period);
        _scheduleRender();
      });
    });

    /* Custom date range */
    const fromEl = _el('periodFrom');
    const toEl   = _el('periodTo');
    if (fromEl && toEl) {
      const apply = () => {
        if (!fromEl.value || !toEl.value) return;
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        _period = {
          from: new Date(fromEl.value),
          to:   new Date(toEl.value + 'T23:59:59'),
          key:  'custom',
        };
        _scheduleRender();
      };
      fromEl.addEventListener('change', apply);
      toEl.addEventListener('change', apply);
    }
  }

  function _bindTabs() {
    document.querySelectorAll('.dash-tab[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dash-tab').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
        document.querySelectorAll('.dash-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        const panel = document.querySelector(`.dash-panel[data-panel="${btn.dataset.tab}"]`);
        if (panel) panel.classList.add('active');
        _tab = btn.dataset.tab;
        _scheduleRender();
      });
    });
  }

  /* ──────────────────────────────────────
     SUPER ADMIN & DANGER ZONE
     ────────────────────────────────────── */

  /* ── Super Admin Panel: Subscription Control ── */

  /* Map action codes to Arabic labels */
  const ACTION_LABELS = {
    created:      'إنشاء',
    renewed:      'تجديد',
    paused:       'تعليق',
    resumed:      'استئناف',
    caps_updated: 'تحديث الحدود'
  };

  /* Map action codes to icons */
  const ACTION_ICONS = {
    created:      'fa-star',
    renewed:      'fa-rotate',
    paused:       'fa-pause-circle',
    resumed:      'fa-play-circle',
    caps_updated: 'fa-sliders'
  };

  /**
   * Reveal the super admin control panel for subscription management.
   *
   * Uses VisionAuth.isSuperAdmin() to gate visibility. Subscribes
   * to VisionLicensing.onStatusChanged() for real-time updates.
   */
  function _setupSuperAdminPanel() {
    if (!window.VisionAuth || !window.VisionAuth.isSuperAdmin()) return;

    var panel = _el('superAdminPanel');
    if (!panel) return;
    panel.style.display = '';

    /* Bind UI interactions */
    _bindSubscriptionPanel();

    /* Subscribe to real-time licensing changes */
    if (window.VisionLicensing && typeof window.VisionLicensing.onStatusChanged === 'function') {
      var unsubLicensing = window.VisionLicensing.onStatusChanged(function (status) {
        _updateSubscriptionUI(status);
      });
      _unsubs.push(unsubLicensing);
    } else {
      /* Fallback: read once from cache */
      var status = window.VisionLicensing
        ? window.VisionLicensing.getStatus()
        : (window.VisionConfig ? window.VisionConfig.get('licensing') : null);
      if (status) _updateSubscriptionUI(status);
    }
  }

  /**
   * Update all subscription panel UI elements from a status object.
   * @param {Object} status — { isActive, startDate, endDate, subscriptionHistory, usageCaps }
   */
  function _updateSubscriptionUI(status) {
    if (!status) return;

    var now = Date.now();
    var endMs   = status.endDate ? new Date(status.endDate).getTime() : null;
    var startMs = status.startDate ? new Date(status.startDate).getTime() : null;
    var daysRemaining = endMs ? Math.ceil((endMs - now) / 86_400_000) : null;

    /* ── Status badge ── */
    var badge = _el('saStatusBadge');
    if (badge) {
      if (!status.isActive) {
        badge.textContent = 'معطل';
        badge.className   = 'sub-status-badge sub-status-badge--paused';
      } else if (daysRemaining !== null && daysRemaining <= 0) {
        badge.textContent = 'منتهي';
        badge.className   = 'sub-status-badge sub-status-badge--expired';
      } else {
        badge.textContent = 'نشط';
        badge.className   = 'sub-status-badge sub-status-badge--active';
      }
    }

    /* ── Countdown ── */
    var countdownVal  = _el('saCountdownValue');
    var countdownUnit = _el('saCountdownUnit');
    var countdown     = _el('saCountdown');
    if (countdownVal && countdownUnit) {
      if (daysRemaining === null) {
        countdownVal.textContent = '—';
        countdownUnit.textContent = '';
      } else {
        var absDays = Math.abs(daysRemaining);
        countdownVal.textContent = _fmt(absDays);
        countdownUnit.textContent = absDays === 1 ? 'يوم' : 'يوم';

        /* Color coding */
        if (countdown) {
          countdown.className = 'sub-countdown' +
            (daysRemaining <= 0 ? ' sub-countdown--expired' :
             daysRemaining <= 3 ? ' sub-countdown--critical' :
             daysRemaining <= 7 ? ' sub-countdown--warning' : '');
        }
      }
    }

    /* ── Dates ── */
    _setText('saStartDate', startMs
      ? new Date(startMs).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' })
      : '—');
    _setText('saEndDate', endMs
      ? new Date(endMs).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' })
      : '—');

    /* ── Pause/Resume toggle ── */
    var toggleBtn  = _el('saTogglePauseBtn');
    var toggleIcon = toggleBtn ? toggleBtn.querySelector('i') : null;
    var toggleSpan = _el('saTogglePauseLabel');
    if (toggleBtn && toggleSpan) {
      if (status.isActive) {
        toggleSpan.textContent = 'تعليق النظام';
        if (toggleIcon) { toggleIcon.className = 'fas fa-pause-circle'; }
        toggleBtn.className = 'btn btn-lg btn-warning';
      } else {
        toggleSpan.textContent = 'استئناف النظام';
        if (toggleIcon) { toggleIcon.className = 'fas fa-play-circle'; }
        toggleBtn.className = 'btn btn-lg btn-success';
      }
    }

    /* ── Usage caps inputs ── */
    var empInput  = _el('saMaxEmployees');
    var prodInput = _el('saMaxProducts');
    if (empInput)  empInput.value  = status.usageCaps ? (status.usageCaps.maxEmployees || 5) : 5;
    if (prodInput) prodInput.value = status.usageCaps ? (status.usageCaps.maxProducts  || 200) : 200;

    /* ── Current counts ── */
    _setText('saCurrentEmployees', 'الحالي: ' + Store.employees.length + ' موظف');
    _setText('saCurrentProducts',  'الحالي: ' + Store.products.length + ' منتج');

    /* ── History table ── */
    _renderHistoryTable(status.subscriptionHistory || []);
  }

  /**
   * Render the subscription history table.
   * Entries are displayed in reverse chronological order.
   * @param {Array} history
   */
  function _renderHistoryTable(history) {
    var tbody = _el('saHistoryTableBody');
    if (!tbody) return;

    if (!history.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:var(--space-6);color:var(--color-text-muted);">لا توجد عمليات مسجلة</td></tr>';
      return;
    }

    /* Sort newest first */
    var sorted = history.slice().sort(function (a, b) {
      var da = a.date ? (a.date.seconds ? a.date.seconds * 1000 : new Date(a.date).getTime()) : 0;
      var db = b.date ? (b.date.seconds ? b.date.seconds * 1000 : new Date(b.date).getTime()) : 0;
      return db - da;
    });

    tbody.innerHTML = sorted.map(function (entry) {
      var dateStr = '—';
      if (entry.date) {
        var d = entry.date.seconds
          ? new Date(entry.date.seconds * 1000)
          : new Date(entry.date);
        if (!isNaN(d.getTime())) {
          dateStr = d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }) +
            ' — ' + d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        }
      }

      var actionLabel = ACTION_LABELS[entry.action] || entry.action || '—';
      var actionIcon  = ACTION_ICONS[entry.action]  || 'fa-circle';
      var duration    = entry.durationMonths
        ? entry.durationMonths + ' ' + (entry.durationMonths === 1 ? 'شهر' : 'أشهر')
        : '—';
      var by = entry.by || '—';

      return '<tr>' +
        '<td class="td-muted">' + dateStr + '</td>' +
        '<td><span class="history-action"><i class="fas ' + actionIcon + '" aria-hidden="true"></i> ' + actionLabel + '</span></td>' +
        '<td class="td-numeric">' + duration + '</td>' +
        '<td class="td-muted">' + by + '</td>' +
        '</tr>';
    }).join('');
  }

  /**
   * Bind event listeners for the subscription panel.
   * Pause/resume toggle, renewal buttons, and caps save.
   */
  function _bindSubscriptionPanel() {
    /* ── Pause / Resume toggle ── */
    var toggleBtn = _el('saTogglePauseBtn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        var status = window.VisionLicensing
          ? window.VisionLicensing.getStatus()
          : (window.VisionConfig ? window.VisionConfig.get('licensing') : null);
        if (!status) return;

        var currentlyActive = status.isActive;

        /* Confirm before pausing */
        if (currentlyActive) {
          if (!window.VisionOverlays) return;
          window.VisionOverlays.modal({
            title: 'تأكيد تعليق النظام',
            body: '<div style="text-align:right;line-height:1.8;">' +
              '<p style="color:var(--color-warning);font-weight:bold;margin-bottom:12px;">' +
              '<i class="fas fa-triangle-exclamation" style="margin-left:6px;"></i>' +
              'هل أنت متأكد من تعليق النظام؟</p>' +
              '<p style="color:var(--color-text-secondary);">' +
              'لن يتمكن أي موظف أو عميل من الوصول إلى النظام حتى تقوم باستئنافه. ' +
              'حساب المالك فقط سيبقى قادراً على الدخول.</p>' +
              '</div>',
            buttons: [
              { label: 'إلغاء', value: false },
              { label: 'تعليق النظام', value: true, primary: true }
            ]
          }).then(function (confirmed) {
            if (confirmed && window.VisionLicensing) {
              window.VisionLicensing.togglePause(false).catch(function (e) {
                console.error('[Dashboard] togglePause failed:', e);
              });
            }
          });
        } else {
          /* Resume — no confirmation needed */
          if (window.VisionLicensing) {
            window.VisionLicensing.togglePause(true).catch(function (e) {
              console.error('[Dashboard] togglePause failed:', e);
            });
          }
        }
      });
    }

    /* ── Renewal buttons ── */
    document.querySelectorAll('.renewal-btn[data-months]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var months = parseInt(btn.dataset.months, 10);
        if (!months || months <= 0) return;

        if (!window.VisionOverlays) return;

        /* Compute the new end date for the confirmation message */
        var status = window.VisionLicensing
          ? window.VisionLicensing.getStatus()
          : (window.VisionConfig ? window.VisionConfig.get('licensing') : null);
        var base = status && status.endDate
          ? new Date(status.endDate)
          : new Date();
        if (base.getTime() < Date.now()) base.setTime(Date.now());
        base.setMonth(base.getMonth() + months);
        var newEndStr = base.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });

        window.VisionOverlays.modal({
          title: 'تأكيد تجديد الاشتراك',
          body: '<div style="text-align:right;line-height:1.8;">' +
            '<p style="color:var(--color-text-secondary);margin-bottom:8px;">' +
            'سيتم تمديد الاشتراك بمقدار <strong>' + months + ' ' + (months === 1 ? 'شهر' : 'أشهر') + '</strong>.</p>' +
            '<p style="color:var(--color-text-secondary);margin-bottom:12px;">' +
            'تاريخ الانتهاء الجديد: <strong style="color:var(--color-success);">' + newEndStr + '</strong></p>' +
            '<p style="color:var(--color-text-muted);font-size:0.85rem;">' +
            'سيتم تفعيل النظام تلقائياً إذا كان معلقاً.</p>' +
            '</div>',
          buttons: [
            { label: 'إلغاء', value: false },
            { label: 'تأكيد التجديد', value: true, primary: true }
          ]
        }).then(function (confirmed) {
          if (confirmed && window.VisionLicensing) {
            window.VisionLicensing.renew(months).catch(function (e) {
              console.error('[Dashboard] renew failed:', e);
              if (window.VisionOverlays) {
                window.VisionOverlays.toast({
                  type: 'error',
                  title: 'فشل التجديد',
                  message: 'حدث خطأ أثناء تجديد الاشتراك. يرجى المحاولة مرة أخرى.',
                });
              }
            });
          }
        });
      });
    });

    /* ── Custom date renewal ── */
    var customDateInput = _el('saCustomEndDate');
    var customRenewBtn  = _el('saCustomRenewBtn');
    var customHint      = _el('saCustomRenewHint');
    if (customDateInput && customRenewBtn) {
      /* Set min date to tomorrow */
      var tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      customDateInput.min = tomorrow.toISOString().split('T')[0];

      customDateInput.addEventListener('change', function () {
        var selected = customDateInput.value;
        if (!selected) {
          if (customHint) customHint.textContent = '';
          return;
        }
        var target = new Date(selected);
        var now = new Date();
        var diffDays = Math.ceil((target.getTime() - now.getTime()) / 86_400_000);
        var diffMonths = (diffDays / 30).toFixed(1);
        if (customHint) {
          customHint.textContent = 'المدة المتبقية بعد التمديد: ~' +
            diffDays + ' يوم (' + diffMonths + ' شهر)';
        }
      });

      customRenewBtn.addEventListener('click', function () {
        var selected = customDateInput.value;
        if (!selected) {
          if (window.VisionOverlays) {
            window.VisionOverlays.toast({
              type: 'error',
              message: 'يرجى اختيار تاريخ أولاً.',
            });
          }
          return;
        }

        var targetDate = new Date(selected);
        var now = new Date();
        if (targetDate.getTime() <= now.getTime()) {
          if (window.VisionOverlays) {
            window.VisionOverlays.toast({
              type: 'error',
              message: 'يجب أن يكون التاريخ في المستقبل.',
            });
          }
          return;
        }

        /* Confirm */
        var targetStr = targetDate.toLocaleDateString('ar-EG', {
          year: 'numeric', month: 'long', day: 'numeric'
        });
        var diffDays = Math.ceil((targetDate.getTime() - now.getTime()) / 86_400_000);

        if (!window.VisionOverlays) return;
        window.VisionOverlays.modal({
          title: 'تأكيد تمديد الاشتراك',
          body: '<div style="text-align:right;line-height:1.8;">' +
            '<p style="color:var(--color-text-secondary);margin-bottom:8px;">' +
            'سيتم تمديد الاشتراك حتى تاريخ:</p>' +
            '<p style="color:var(--color-success);font-weight:bold;font-size:1.1rem;margin-bottom:12px;">' +
            targetStr + '</p>' +
            '<p style="color:var(--color-text-muted);font-size:0.85rem;">' +
            'المدة المضافة: ~' + diffDays + ' يوم</p>' +
            '</div>',
          buttons: [
            { label: 'إلغاء', value: false },
            { label: 'تأكيد التمديد', value: true, primary: true }
          ]
        }).then(function (confirmed) {
          if (!confirmed || !window.VisionLicensing) return;

          customRenewBtn.disabled = true;
          window.VisionLicensing.extendToDate(targetDate.toISOString()).then(function () {
            customRenewBtn.disabled = false;
            customDateInput.value = '';
            if (customHint) customHint.textContent = '';
          }).catch(function (e) {
            console.error('[Dashboard] extendToDate failed:', e);
            customRenewBtn.disabled = false;
            if (window.VisionOverlays) {
              window.VisionOverlays.toast({
                type: 'error',
                title: 'فشل التمديد',
                message: 'حدث خطأ أثناء تمديد الاشتراك. يرجى المحاولة مرة أخرى.',
              });
            }
          });
        });
      });
    }

    /* ── Save usage caps ── */
    var saveCapsBtn = _el('saSaveCapsBtn');
    if (saveCapsBtn) {
      saveCapsBtn.addEventListener('click', function () {
        var empVal  = parseInt(_el('saMaxEmployees')?.value, 10);
        var prodVal = parseInt(_el('saMaxProducts')?.value, 10);

        if (!empVal || empVal < 1 || !prodVal || prodVal < 10) {
          if (window.VisionOverlays) {
            window.VisionOverlays.toast({
              type: 'error',
              message: 'يرجى إدخال قيم صحيحة (الموظفون: 1-500، المنتجات: 10-10000)',
            });
          }
          return;
        }

        if (window.VisionLicensing) {
          saveCapsBtn.disabled = true;
          window.VisionLicensing.updateUsageCaps({
            maxEmployees: empVal,
            maxProducts:  prodVal
          }).then(function () {
            saveCapsBtn.disabled = false;
          }).catch(function (e) {
            console.error('[Dashboard] updateUsageCaps failed:', e);
            saveCapsBtn.disabled = false;
            if (window.VisionOverlays) {
              window.VisionOverlays.toast({
                type: 'error',
                title: 'فشل الحفظ',
                message: 'حدث خطأ أثناء حفظ حدود الاستخدام.',
              });
            }
          });
        }
      });
    }
  }

  /* ── Danger Zone ── */

  /**
   * Reveal the danger zone section for super admins and bind
   * the wipe-all-data button with a two-step confirmation flow.
   *
   * Uses VisionAuth.isSuperAdmin() which checks if the employee
   * record has role === 'super_admin'.
   */
  function _setupDangerZone() {
    if (!window.VisionAuth || !window.VisionAuth.isSuperAdmin()) return;

    var zone = _el('dangerZone');
    if (!zone) return;
    zone.style.display = '';

    var btn = _el('btnWipeAllData');
    if (!btn) return;

    btn.addEventListener('click', function () {
      _confirmWipeAllData();
    });
  }

  /**
   * Two-step confirmation for wiping all data.
   *
   * Step 1: General warning modal explaining the scope.
   * Step 2: Type-to-confirm modal — user must type a specific
   *         Arabic phrase to prove they understand the gravity.
   * Step 3: Execute the wipe with spinner feedback.
   */
  function _confirmWipeAllData() {
    if (!window.VisionOverlays) return;

    /* ── Step 1: Initial warning ── */
    window.VisionOverlays.modal({
      title: 'تحذير: حذف جميع بيانات النظام',
      body: '<div style="text-align:right;line-height:1.8;">' +
        '<p style="color:var(--color-error);font-weight:bold;font-size:1.1rem;margin-bottom:12px;">' +
        '<i class="fas fa-triangle-exclamation" style="margin-left:6px;"></i>' +
        'هذا الإجراء خطير ولا يمكن التراجع عنه!</p>' +
        '<p style="color:var(--color-text-secondary);margin-bottom:8px;">' +
        'سيتم حذف <strong>جميع</strong> البيانات من المجموعات التالية:</p>' +
        '<ul style="color:var(--color-text-secondary);padding-right:20px;margin-bottom:12px;">' +
        '<li>الطلبات (Orders)</li>' +
        '<li>المصاريف (Expenses)</li>' +
        '<li>المنتجات (Products)</li>' +
        '<li>الموظفون (Employees)</li>' +
        '<li>المشتريات (Purchases)</li>' +
        '<li>الموردين (Suppliers)</li>' +
        '<li>شركات الشحن (Shipping Companies)</li>' +
        '<li>المنصات (Platforms)</li>' +
        '<li>الحالات (Statuses)</li>' +
        '<li>الأهداف (Goals)</li>' +
        '</ul>' +
        '<p style="color:var(--color-text-muted);font-size:0.85rem;">' +
        'النظام نفسه (إعدادات، صلاحيات، هيكل) لن يتأثر. سيتم حذف البيانات التشغيلية فقط.</p>' +
        '</div>',
      buttons: [
        { label: 'إلغاء', value: false },
        { label: 'متابعة', value: true, primary: true }
      ]
    }).then(function (proceed) {
      if (!proceed) return;

      /* ── Step 2: Type-to-confirm ── */
      var confirmPhrase = 'أوافق على حذف جميع البيانات';

      /*
       * Build the body as a DOM fragment, NOT an HTML string.
       * This bypasses VisionSecurity.sanitizeHtml() entirely, so
       * attributes like id, type, placeholder are preserved.
       */
      var frag = document.createDocumentFragment();

      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'text-align:right;line-height:1.8;';

      var heading = document.createElement('p');
      heading.style.cssText = 'color:var(--color-error);font-weight:bold;margin-bottom:12px;';
      heading.innerHTML = '<i class="fas fa-skull-crossbones" style="margin-left:6px;"></i>' +
        'التأكيد النهائي — آخر فرصة للتراجع';
      wrapper.appendChild(heading);

      var instr = document.createElement('p');
      instr.style.cssText = 'color:var(--color-text-secondary);margin-bottom:12px;';
      instr.textContent = 'للمتابعة، اكتب العبارة التالية بالضبط في الحقل أدناه:';
      wrapper.appendChild(instr);

      var phraseBox = document.createElement('div');
      phraseBox.style.cssText = 'background:var(--color-surface-raised);border:1px solid var(--color-border);' +
        'border-radius:var(--radius-md);padding:12px;text-align:center;' +
        'font-weight:bold;color:var(--color-error);font-size:1rem;margin-bottom:16px;' +
        'font-family:monospace;direction:rtl;user-select:none;';
      phraseBox.textContent = confirmPhrase;
      wrapper.appendChild(phraseBox);

      var input = document.createElement('input');
      input.type = 'text';
      input.id   = 'wipeConfirmInput';
      input.className = 'form-input';
      input.setAttribute('placeholder', 'اكتب العبارة هنا...');
      input.style.cssText = 'direction:rtl;width:100%;';
      input.setAttribute('autocomplete', 'off');
      wrapper.appendChild(input);

      var errEl = document.createElement('div');
      errEl.id = 'wipeConfirmError';
      errEl.style.cssText = 'color:var(--color-error);font-size:0.8rem;margin-top:8px;display:none;';
      errEl.textContent = 'العبارة غير متطابقة. حاول مرة أخرى.';
      wrapper.appendChild(errEl);

      frag.appendChild(wrapper);

      /*
       * Pass the DOM fragment as body. VisionOverlays.modal() detects
       * it's an HTMLElement/DocumentFragment and appends it directly
       * without running through the HTML sanitizer.
       */
      var step2Promise = window.VisionOverlays.modal({
        title: 'تأكيد نهائي',
        body: frag,
        buttons: [
          { label: 'إلغاء', value: false },
          { label: 'تأكيد الحذف النهائي', value: true, primary: true }
        ],
        closeOnBackdrop: false
      });

      /*
       * Dialog is now in the DOM. Find the confirm button (last button
       * in the footer) and wire up input validation. The confirm button
       * starts DISABLED — only becomes clickable when the user types the
       * exact confirmation phrase.
       *
       * We use the input reference we already have (created above) rather
       * than querying by ID, since the node is the same one now appended
       * to the modal's DOM.
       */
      (function _wireConfirmInput() {
        var dialogs = document.querySelectorAll('.vision-modal');
        var targetDialog = dialogs[dialogs.length - 1];
        if (!targetDialog) return;

        var footerBtns = targetDialog.querySelectorAll('.vision-modal-footer button');
        var confirmBtn = footerBtns[footerBtns.length - 1];
        if (!confirmBtn) return;

        /* Start disabled */
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
        confirmBtn.style.cursor = 'not-allowed';

        /* input and errEl are already in the DOM via the fragment.
           Query them inside the dialog as a safety check, but they
           should be the same nodes we created above. */
        var inputInDom = targetDialog.querySelector('#wipeConfirmInput');
        var errInDom   = targetDialog.querySelector('#wipeConfirmError');
        if (!inputInDom) return;

        inputInDom.addEventListener('input', function () {
          var matches = inputInDom.value.trim() === confirmPhrase;
          confirmBtn.disabled = !matches;
          confirmBtn.style.opacity = matches ? '' : '0.5';
          confirmBtn.style.cursor = matches ? '' : 'not-allowed';
          if (errInDom) errInDom.style.display = matches ? 'none' : '';
        });

        setTimeout(function () { inputInDom.focus(); }, 100);
      })();

      step2Promise.then(function (confirmed) {
        if (!confirmed) return;

        /*
         * IMPORTANT: By the time this .then() runs, the modal's DOM has
         * already been removed (overlay.remove() happens before resolve()).
         * So we CANNOT use document.getElementById() to check the input.
         *
         * However, the confirm button was only enabled when the input
         * matched the phrase (via the 'input' event listener). The fact
         * that the button was clickable means the phrase matched.
         * So we can proceed directly.
         *
         * Step 2 modal takes 300ms to animate out (vision-overlays line
         * 652). We add a matching delay so the overlay is fully gone
         * before showing the wipe spinner.
         */
        setTimeout(function () {
          _executeWipeAllData();
        }, 350);
      });
    });
  }

  /**
   * Delete all documents from all operational Firestore collections.
   *
   * Strategy: Batch-delete in parallel using Promise.all on individual
   * document deletes. Shows a spinner during the operation and reports
   * results via toast.
   */
  function _executeWipeAllData() {
    var overlays = window.VisionOverlays;
    if (!overlays) {
      console.error('[Dashboard] _executeWipeAllData: VisionOverlays not available');
      return;
    }

    overlays.showSpinner({ text: 'جاري حذف جميع البيانات...' });

    var db;
    try {
      db = firebase.firestore();
    } catch (e) {
      console.error('[Dashboard] Firestore access failed:', e);
      overlays.hideSpinner();
      overlays.toast({
        type: 'error',
        title: 'فشل الاتصال بقاعدة البيانات',
        message: 'تعذر الوصول إلى Firestore. يرجى المحاولة مرة أخرى.'
      });
      return;
    }

    /*
     * IMPORTANT: Capture the current super_admin's UID BEFORE any
     * deletion starts. The super_admin account must survive the wipe
     * — they are the root owner and must never be affected by system
     * operations. We'll skip their employee document during deletion.
     */
    var superAdminUid = null;
    if (window.VisionAuth && window.VisionAuth.isSuperAdmin()) {
      var saUser = window.VisionAuth.getUser();
      if (saUser) superAdminUid = saUser.uid;
    }

    /* All operational collections to wipe */
    var collections = [
      'orders',
      'expenses',
      'products',
      'employees',
      'shippingCompanies',
      'platforms',
      'statuses',
      'goals',
      'purchases',
      'suppliers'
    ];

    /**
     * Helper: Delete all documents in a collection.
     * Fetches all doc IDs first, then deletes in batches.
     * For the 'employees' collection, the super_admin's own document
     * is preserved — all other employee docs are deleted.
     *
     * @param {string} colName
     * @returns {Promise<{name:string, count:number, skipped:number, error:string|null}>}
     */
    function _deleteCollection(colName) {
      return db.collection(colName).get().then(function (snap) {
        if (snap.empty) return { name: colName, count: 0, skipped: 0, error: null };

        var docs = snap.docs;

        /* Exclude super_admin's own employee doc from wipe */
        var skipped = 0;
        if (colName === 'employees' && superAdminUid) {
          var before = docs.length;
          docs = docs.filter(function (doc) {
            return doc.id !== superAdminUid;
          });
          skipped = before - docs.length;
        }

        if (!docs.length) {
          return { name: colName, count: 0, skipped: skipped, error: null };
        }

        /*
         * Firestore batches can hold up to 500 operations, but if any
         * single operation fails (e.g. security rules, missing doc),
         * the ENTIRE batch fails. We wrap each batch commit in its own
         * catch so one bad batch doesn't kill the whole collection.
         * We also delete documents individually for small collections
         * to avoid cascading failures.
         */
        var totalDeleted = 0;
        var deletePromises = [];

        /*
         * Strategy: use individual deletions. While slower than batches,
         * this ensures each document deletion succeeds or fails
         * independently — a single problematic doc won't block
         * the rest of the collection.
         *
         * Firestore allows deleting documents even if they have
         * subcollections (the subcollections become orphaned and
         * inaccessible through the console, but are still stored).
         * So subcollections won't block deletion.
         */
        docs.forEach(function (doc) {
          deletePromises.push(
            doc.ref.delete().then(function () {
              totalDeleted++;
            }).catch(function (err) {
              console.warn('[Dashboard] Failed to delete doc ' +
                colName + '/' + doc.id + ':', err.message || err);
              /* Continue — don't let one failure block others */
            })
          );
        });

        return Promise.all(deletePromises).then(function () {
          return { name: colName, count: totalDeleted, skipped: skipped, error: null };
        });
      }).catch(function (err) {
        console.error('[Dashboard] Failed to wipe collection ' + colName + ':', err);
        return { name: colName, count: 0, skipped: 0, error: err.message || 'Unknown error' };
      });
    }

    /* Execute all collection deletions in parallel */
    Promise.all(collections.map(_deleteCollection)).then(function (results) {
      overlays.hideSpinner();

      var totalDeleted = results.reduce(function (s, r) { return s + r.count; }, 0);
      var totalSkipped = results.reduce(function (s, r) { return s + (r.skipped || 0); }, 0);
      var failures = results.filter(function (r) { return r.error; });

      if (failures.length === 0) {
        var successMsg = 'تم حذف ' + totalDeleted + ' مستند من ' + results.length + ' مجموعات. النظام نظيف الآن.';
        if (totalSkipped > 0) {
          successMsg += ' (تم الحفاظ على ' + totalSkipped + ' مستند لمالك النظام)';
        }
        overlays.toast({
          type: 'success',
          title: 'تم حذف جميع البيانات بنجاح',
          message: successMsg,
          duration: 8000
        });
      } else if (totalDeleted > 0) {
        overlays.toast({
          type: 'warning',
          title: 'تم الحذف جزئياً',
          message: 'تم حذف ' + totalDeleted + ' مستند. فشل في ' + failures.length + ' مجموعات: ' +
            failures.map(function (f) { return f.name; }).join('، ') + '.',
          duration: 0
        });
      } else {
        overlays.toast({
          type: 'error',
          title: 'فشل حذف البيانات',
          message: 'لم يتم حذف أي مستند. فشلت جميع العمليات: ' +
            failures.map(function (f) { return f.name + ': ' + f.error; }).join('؛ ') + '.',
          duration: 0
        });
      }

      /* Reload the dashboard with fresh (empty) data */
      _scheduleRender();
    }).catch(function (err) {
      overlays.hideSpinner();
      console.error('[Dashboard] _executeWipeAllData fatal error:', err);
      overlays.toast({
        type: 'error',
        title: 'خطأ غير متوقع',
        message: 'حدث خطأ أثناء حذف البيانات: ' + (err.message || 'خطأ غير معروف'),
        duration: 0
      });
    });
  }

  /* ──────────────────────────────────────
     CLEANUP
     ────────────────────────────────────── */

  function _destroy() {
    _unsubs.forEach(u => { try { u(); } catch (_) {} });
    Object.keys(_charts).forEach(k => { try { _charts[k].destroy(); } catch (_) {} });
    clearTimeout(_renderTimer);
  }

  /* ──────────────────────────────────────
     INIT
     ────────────────────────────────────── */

  function _init() {
    /* Set Chart.js global defaults once */
    if (window.Chart) {
      Chart.defaults.color       = '#94A3B8';
      Chart.defaults.borderColor = '#1E293B';
      Chart.defaults.font.family = 'Cairo, sans-serif';
    }

    _period = _buildPeriod('30d');

    AuthGuard.protect({
      adminOnly: true,
      onReady: () => {
        Sidebar.init({ activePage: 'dashboard' });
        Topbar.init({ title: 'لوحة التحكم' });
        _bindPeriodBar();
        _bindTabs();
        _loadData();
        _setupDangerZone();
        _setupSuperAdminPanel();
      },
    });

    window.addEventListener('beforeunload', _destroy);
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);
