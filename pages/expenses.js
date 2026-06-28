/**
 * pages/expenses.js — Expenses Controller
 *
 * Financial integrity strategy:
 *   All monetary values are stored in Firestore as `amountCents`
 *   (integer, value × 100). All arithmetic operates on integers.
 *   Only the final display step divides by 100.
 *   This eliminates IEEE-754 float drift entirely (0.1+0.2 problem).
 *
 * Data sync strategy:
 *   - expenses    → onSnapshot (real-time, filtered by period window)
 *   - recurring   → onSnapshot (real-time, small collection)
 *   - categories  → onSnapshot (real-time, tiny collection)
 *   All three listeners are debounced into a single _render() call.
 */
(function (window) {
  'use strict';

  /* ──────────────────────────────────────
     DEFAULT CATEGORIES (seed if empty)
     ────────────────────────────────────── */

  const DEFAULT_CATEGORIES = [
    { name: 'إيجار',      color: '#F59E0B', icon: 'fa-building' },
    { name: 'مرتبات',     color: '#8B5CF6', icon: 'fa-users' },
    { name: 'تسويق',      color: '#3B82F6', icon: 'fa-bullhorn' },
    { name: 'شحن',        color: '#06B6D4', icon: 'fa-truck' },
    { name: 'تشغيل',      color: '#10B981', icon: 'fa-cogs' },
    { name: 'أخرى',       color: '#64748B', icon: 'fa-ellipsis' },
  ];

  /* ──────────────────────────────────────
     INTEGER-CENTS MATH
     Prevents all floating-point drift.
     ────────────────────────────────────── */

  /* Parse any user input → safe integer cents */
  const _toCents = v =>
    Math.round(parseFloat(String(v ?? 0).replace(/[^0-9.]/g, '')) * 100) || 0;

  /* Cents → display string with 2 decimal places */
  const _fmtCents = c =>
    (c / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج.م';

  /* Cents → compact display (no decimals for whole numbers) */
  const _fmtCentsCompact = c => {
    const v = c / 100;
    return v.toLocaleString('ar-EG', {
      minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
      maximumFractionDigits: 2,
    }) + ' ج.م';
  };

  /* ──────────────────────────────────────
     STATE
     ────────────────────────────────────── */

  const Store = {
    expenses:   [],
    recurring:  [],
    categories: [],
  };

  /* Period window for the Firestore query */
  let _period = _buildPeriod('this_month');

  /* UI filter state (applied in-memory after load) */
  const Filters = { search: '', category: '', payment: '' };

  /* Pagination */
  let _page     = 1;
  const PAGE_SIZE = 30;

  /* Active tab */
  let _tab = 'overview';

  /* Chart instances */
  const _charts = {};

  /* Firestore listeners */
  const _unsubs = [];

  /* Debounce render across all three snapshot sources */
  let _renderTimer = null;

  /* ──────────────────────────────────────
     PERIOD HELPERS
     ────────────────────────────────────── */

  function _buildPeriod(key, from, to) {
    const now   = new Date();
    const y     = now.getFullYear();
    const m     = now.getMonth();
    switch (key) {
      case 'this_month':  return { from: new Date(y, m, 1),       to: now };
      case 'last_month':  return { from: new Date(y, m - 1, 1),   to: new Date(y, m, 0, 23, 59, 59) };
      case '30d':         return { from: new Date(now - 30 * 86400000), to: now };
      case '90d':         return { from: new Date(now - 90 * 86400000), to: now };
      case 'ytd':         return { from: new Date(y, 0, 1),        to: now };
      case 'custom':      return { from: from || new Date(y, m, 1), to: to || now };
      default:            return { from: new Date(y, m, 1),         to: now };
    }
  }

  function _inPeriod(exp) {
    const d = exp.date?.toDate ? exp.date.toDate() : (exp.date ? new Date(exp.date) : null);
    return d && d >= _period.from && d <= _period.to;
  }

  function _fmtPeriodLabel() {
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    return `${_period.from.toLocaleDateString('ar-EG', opts)} — ${_period.to.toLocaleDateString('ar-EG', opts)}`;
  }

  /* ──────────────────────────────────────
     HELPERS
     ────────────────────────────────────── */

  const _el      = id => document.getElementById(id);
  const _setText = (id, v) => { const e = _el(id); if (e) e.textContent = v; };
  const _setHtml = (id, v) => { const e = _el(id); if (e) e.innerHTML   = v; };

  function _fmtDate(ts) {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('ar-EG', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function _catColor(name) {
    return Store.categories.find(c => c.name === name)?.color || '#64748B';
  }

  function _scheduleRender() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(_render, 60);
  }

  /* ──────────────────────────────────────
     FILTERING
     ────────────────────────────────────── */

  function _applyFilters() {
    const search = Filters.search.toLowerCase();
    return Store.expenses.filter(e => {
      if (!_inPeriod(e)) return false;
      if (search) {
        const hay = [e.description, e.category, e.paymentMethod, e.notes]
          .join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      if (Filters.category && e.category !== Filters.category) return false;
      if (Filters.payment  && e.paymentMethod !== Filters.payment) return false;
      return true;
    });
  }

  /* ──────────────────────────────────────
     MAIN RENDER ORCHESTRATOR
     ────────────────────────────────────── */

  function _render() {
    const periodFiltered = Store.expenses.filter(_inPeriod);
    const listFiltered   = _applyFilters();

    _renderMetrics(periodFiltered);
    _renderInsights(periodFiltered);
    _renderCategoryPills();
    _renderFilterSelects();

    if (_tab === 'overview')  _renderOverview(periodFiltered);
    if (_tab === 'list')      _renderList(listFiltered);
    if (_tab === 'recurring') _renderRecurring();
    if (_tab === 'analysis')  _renderAnalysis();

    /* Dismiss skeleton */
    const skel = _el('skeletonLoader');
    if (skel) skel.classList.add('hidden');
  }

  /* ──────────────────────────────────────
     METRICS
     ────────────────────────────────────── */

  function _renderMetrics(expenses) {
    /* Integer sum — no float errors */
    const totalCents = expenses.reduce((s, e) => s + (e.amountCents || 0), 0);

    /* This calendar month (always, regardless of period) */
    const now = new Date();
    const thisMonthExp = Store.expenses.filter(e => {
      const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
      return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    const thisMonthCents = thisMonthExp.reduce((s, e) => s + (e.amountCents || 0), 0);

    /* Previous month */
    const prevMonthExp = Store.expenses.filter(e => {
      const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
      const pm = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      const py = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
      return d && d.getMonth() === pm && d.getFullYear() === py;
    });
    const prevMonthCents = prevMonthExp.reduce((s, e) => s + (e.amountCents || 0), 0);
    const monthDiff = prevMonthCents
      ? Math.round((thisMonthCents - prevMonthCents) / prevMonthCents * 100)
      : null;

    /* Recurring monthly total */
    const recurringCents = Store.recurring
      .filter(r => r.active !== false)
      .reduce((s, r) => s + (r.amountCents || 0), 0);

    /* Top category */
    const catMap = {};
    expenses.forEach(e => {
      catMap[e.category] = (catMap[e.category] || 0) + (e.amountCents || 0);
    });
    const topCat = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];

    _setText('metricTotal',           _fmtCentsCompact(totalCents));
    _setText('metricTotalCount',      `${expenses.length} سجل`);
    _setText('metricThisMonth',       _fmtCentsCompact(thisMonthCents));
    _setText('metricMonthVsPrev',
      monthDiff !== null
        ? `${monthDiff >= 0 ? '▲' : '▼'} ${Math.abs(monthDiff)}% عن الشهر الماضي`
        : 'لا توجد بيانات مقارنة');
    _setText('metricRecurring',       _fmtCentsCompact(recurringCents));
    _setText('metricRecurringCount',  `${Store.recurring.filter(r => r.active !== false).length} عنصر نشط`);
    _setText('metricTopCategory',     topCat?.[0] || '—');
    _setText('metricTopCategoryAmount', topCat ? _fmtCentsCompact(topCat[1]) : '');

    /* Period label */
    _setText('periodLabel', _fmtPeriodLabel());
    _setText('overviewPeriodLabel', _fmtPeriodLabel());

    /* Recurring tab badge */
    const badge = _el('recurringBadge');
    if (badge) {
      badge.textContent = Store.recurring.length;
      badge.hidden      = Store.recurring.length === 0;
    }
    _setText('recurringMonthlyTotal', `${_fmtCentsCompact(recurringCents)} / شهر`);
  }

  /* ──────────────────────────────────────
     INSIGHTS
     ────────────────────────────────────── */

  function _renderInsights(expenses) {
    const el = _el('insightsSection'); if (!el) return;
    const insights = [];

    /* Month-over-month spike */
    const now = new Date();
    const thisM = Store.expenses.filter(e => {
      const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
      return d?.getMonth() === now.getMonth() && d?.getFullYear() === now.getFullYear();
    });
    const prevM = Store.expenses.filter(e => {
      const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
      const pm = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      const py = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
      return d?.getMonth() === pm && d?.getFullYear() === py;
    });
    const thisCents = thisM.reduce((s, e) => s + (e.amountCents || 0), 0);
    const prevCents = prevM.reduce((s, e) => s + (e.amountCents || 0), 0);
    if (prevCents > 0) {
      const pct = Math.round((thisCents - prevCents) / prevCents * 100);
      if (pct > 15) {
        insights.push({ type: 'up', icon: 'fa-arrow-trend-up',
          title: `ارتفاع مصاريف الشهر الحالي بنسبة ${pct}%`,
          text: `مقارنة بالشهر السابق (${_fmtCentsCompact(prevCents)})` });
      } else if (pct < -10) {
        insights.push({ type: 'down', icon: 'fa-arrow-trend-down',
          title: `انخفاض مصاريف الشهر الحالي بنسبة ${Math.abs(pct)}%`,
          text: `مقارنة بالشهر السابق — أداء جيد!` });
      }
    }

    /* Upcoming recurring (due within 5 days) */
    const today = now.getDate();
    const upcoming = Store.recurring.filter(r => {
      if (r.active === false) return false;
      const day = Number(r.dayOfMonth || 1);
      const diff = day - today;
      return diff >= 0 && diff <= 5;
    });
    if (upcoming.length) {
      insights.push({ type: 'warn', icon: 'fa-bell',
        title: `${upcoming.length} مصروف متكرر مستحق خلال 5 أيام`,
        text: upcoming.map(r => r.name).join('، ') });
    }

    /* Top category if it's > 40% of total */
    const catMap = {};
    expenses.forEach(e => { catMap[e.category] = (catMap[e.category] || 0) + (e.amountCents || 0); });
    const totalCents = expenses.reduce((s, e) => s + (e.amountCents || 0), 0);
    const topCat = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];
    if (topCat && totalCents && topCat[1] / totalCents > 0.40) {
      insights.push({ type: 'info', icon: 'fa-chart-pie',
        title: `تصنيف "${topCat[0]}" يستهلك ${Math.round(topCat[1]/totalCents*100)}% من الإنفاق`,
        text: _fmtCentsCompact(topCat[1]) });
    }

    if (!insights.length) { el.innerHTML = ''; return; }

    el.innerHTML = insights.map(i => `
      <div class="insight-card insight-card--${i.type}">
        <i class="insight-icon fas ${i.icon}" aria-hidden="true"></i>
        <div class="insight-text">
          <strong>${i.title}</strong>
          ${i.text}
        </div>
      </div>`).join('');
  }

  /* ──────────────────────────────────────
     OVERVIEW TAB
     ────────────────────────────────────── */

  function _renderOverview(expenses) {
    const el = _el('categoryBreakdown'); if (!el) return;

    /* Group by category using integer sums */
    const catMap = new Map();
    expenses.forEach(e => {
      const key = e.category || 'غير محدد';
      catMap.set(key, (catMap.get(key) || 0) + (e.amountCents || 0));
    });
    const totalCents = expenses.reduce((s, e) => s + (e.amountCents || 0), 0);
    const sorted = [...catMap.entries()].sort((a, b) => b[1] - a[1]);

    if (!sorted.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-chart-pie"></i></div><div class="empty-state-title">لا توجد مصاريف في هذه الفترة</div></div>`;
      return;
    }

    const countMap = {};
    expenses.forEach(e => { const k = e.category || 'غير محدد'; countMap[k] = (countMap[k] || 0) + 1; });

    el.innerHTML = sorted.map(([cat, cents]) => {
      const color = _catColor(cat);
      const pct   = totalCents ? Math.round(cents / totalCents * 100) : 0;
      return `
        <div class="category-row" data-cat="${cat}">
          <div class="cat-color-dot" style="background:${color};" aria-hidden="true"></div>
          <div class="cat-label">${cat}</div>
          <div class="cat-count">${countMap[cat] || 0} سجل</div>
          <div class="cat-bar-wrap" aria-hidden="true">
            <div class="cat-bar-fill" style="width:${pct}%;background:${color};"></div>
          </div>
          <div class="cat-pct">${pct}%</div>
          <div class="cat-amount">${_fmtCentsCompact(cents)}</div>
        </div>`;
    }).join('');

    /* Category row → jump to filtered list */
    el.querySelectorAll('.category-row').forEach(row => {
      row.addEventListener('click', () => {
        Filters.category = row.dataset.cat;
        _switchTab('list');
        _renderCategoryPills();
        _scheduleRender();
      });
    });
  }

  /* ──────────────────────────────────────
     LIST TAB
     ────────────────────────────────────── */

  function _renderFilterSelects() {
    const catSel = _el('filterCategory'); if (!catSel) return;
    const current = catSel.value;
    catSel.innerHTML = '<option value="">كل التصنيفات</option>' +
      Store.categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
    if (current) catSel.value = current;
  }

  function _renderCategoryPills() {
    const container = _el('categoryPills'); if (!container) return;
    const pills = [{ name: '', label: 'الكل' }, ...Store.categories];
    container.innerHTML = pills.map(c => {
      const active = Filters.category === c.name;
      const style  = active && c.color ? `background:${c.color};border-color:${c.color};` : c.color ? `border-color:${c.color}44;color:${c.color};` : '';
      return `<button class="cat-pill ${active ? 'active' : ''}" data-cat="${c.name}"
        style="${active ? style : ''}">${c.label || c.name}</button>`;
    }).join('');
    container.querySelectorAll('.cat-pill').forEach(pill =>
      pill.addEventListener('click', () => {
        Filters.category = pill.dataset.cat;
        _page = 1;
        _renderCategoryPills();
        _scheduleRender();
      })
    );
  }

  function _renderList(expenses) {
    const tbody = _el('expensesTableBody');
    const empty = _el('emptyExpenses');
    _setText('listCount', `${expenses.length} سجل`);

    const maxPage  = Math.max(1, Math.ceil(expenses.length / PAGE_SIZE));
    if (_page > maxPage) _page = maxPage;
    const start  = (_page - 1) * PAGE_SIZE;
    const rows   = expenses.slice(start, start + PAGE_SIZE);

    if (!rows.length) {
      if (tbody) tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      _renderPagination('expPagination', expenses.length);
      return;
    }
    if (empty) empty.hidden = true;

    if (tbody) {
      tbody.innerHTML = rows.map(exp => {
        const color = _catColor(exp.category);
        return `<tr data-id="${exp.id}">
          <td class="text-sm text-muted">${_fmtDate(exp.date)}</td>
          <td>
            <span class="cat-badge" style="background:${color}22;color:${color};border:1px solid ${color}44;">
              ${exp.category || '—'}
            </span>
          </td>
          <td class="td-primary">${exp.description || '—'}</td>
          <td><span class="amount-cell">− ${_fmtCentsCompact(exp.amountCents || 0)}</span></td>
          <td><span class="payment-badge">${exp.paymentMethod || '—'}</span></td>
          <td class="text-sm text-muted">${exp.createdBy || '—'}</td>
          <td style="text-align:center;">
            <div class="row-actions" style="justify-content:center;">
              <button class="btn btn-secondary btn-icon btn-sm" data-action="edit"   data-id="${exp.id}" title="تعديل"><i class="fas fa-pen" aria-hidden="true"></i></button>
              <button class="btn btn-danger    btn-icon btn-sm" data-action="delete" data-id="${exp.id}" title="حذف"><i class="fas fa-trash" aria-hidden="true"></i></button>
            </div>
          </td>
        </tr>`;
      }).join('');

      tbody.querySelectorAll('[data-action="edit"]').forEach(b =>
        b.addEventListener('click', () => _openExpenseModal(b.dataset.id))
      );
      tbody.querySelectorAll('[data-action="delete"]').forEach(b =>
        b.addEventListener('click', () => _deleteExpense(b.dataset.id))
      );
    }
    _renderPagination('expPagination', expenses.length);
  }

  function _renderPagination(containerId, total) {
    const bar = _el(containerId); if (!bar) return;
    const pages = Math.ceil(total / PAGE_SIZE) || 1;
    if (pages <= 1) { bar.innerHTML = ''; return; }
    let html = `<button class="pagination-btn" data-p="${Math.max(1,_page-1)}" ${_page<=1?'disabled':''}><i class="fas fa-chevron-right"></i></button>`;
    for (let p = 1; p <= pages; p++) {
      if (pages > 7 && Math.abs(p - _page) > 2 && p !== 1 && p !== pages) {
        if (p === 2 || p === pages - 1) html += `<span class="pagination-btn" style="opacity:0.4;pointer-events:none;">…</span>`;
        continue;
      }
      html += `<button class="pagination-btn ${p===_page?'active':''}" data-p="${p}">${p}</button>`;
    }
    html += `<button class="pagination-btn" data-p="${Math.min(pages,_page+1)}" ${_page>=pages?'disabled':''}><i class="fas fa-chevron-left"></i></button>`;
    bar.innerHTML = html;
    bar.querySelectorAll('[data-p]').forEach(b =>
      b.addEventListener('click', () => { _page = Number(b.dataset.p); _scheduleRender(); })
    );
  }

  /* ──────────────────────────────────────
     RECURRING TAB
     ────────────────────────────────────── */

  function _renderRecurring() {
    const el    = _el('recurringList');
    const empty = _el('emptyRecurring');
    if (!el) return;
    if (!Store.recurring.length) { el.innerHTML = ''; if (empty) empty.hidden = false; return; }
    if (empty) empty.hidden = true;

    el.innerHTML = Store.recurring.map(rec => {
      const color    = _catColor(rec.category);
      const inactive = rec.active === false;
      return `
        <div class="recurring-item ${inactive ? 'recurring-item--inactive' : ''}" data-id="${rec.id}">
          <div class="rec-icon" style="background:${color}22;color:${color};">
            <i class="fas fa-rotate" aria-hidden="true"></i>
          </div>
          <div class="rec-info">
            <div class="rec-name">${rec.name || '—'}</div>
            <div class="rec-meta">
              <span class="cat-badge" style="background:${color}22;color:${color};border:1px solid ${color}33;">${rec.category || '—'}</span>
              ${rec.notes ? `<span style="margin-right:var(--space-2);">${rec.notes}</span>` : ''}
            </div>
          </div>
          <div class="rec-day-badge">يوم ${rec.dayOfMonth || 1}</div>
          <div class="rec-amount">− ${_fmtCentsCompact(rec.amountCents || 0)}</div>
          <div style="display:flex;gap:var(--space-2);">
            <button class="btn btn-secondary btn-icon btn-sm" data-action="edit-rec"   data-id="${rec.id}" title="تعديل"><i class="fas fa-pen" aria-hidden="true"></i></button>
            <button class="btn ${inactive?'btn-success':'btn-secondary'} btn-icon btn-sm"
              data-action="toggle-rec" data-id="${rec.id}"
              title="${inactive?'تفعيل':'إيقاف'}">
              <i class="fas ${inactive?'fa-play':'fa-pause'}" aria-hidden="true"></i>
            </button>
            <button class="btn btn-danger btn-icon btn-sm" data-action="delete-rec" data-id="${rec.id}" title="حذف"><i class="fas fa-trash" aria-hidden="true"></i></button>
          </div>
        </div>`;
    }).join('');

    el.querySelectorAll('[data-action="edit-rec"]').forEach(b =>
      b.addEventListener('click', () => _openRecurringModal(b.dataset.id))
    );
    el.querySelectorAll('[data-action="toggle-rec"]').forEach(b =>
      b.addEventListener('click', () => _toggleRecurring(b.dataset.id))
    );
    el.querySelectorAll('[data-action="delete-rec"]').forEach(b =>
      b.addEventListener('click', () => _deleteRecurring(b.dataset.id))
    );
  }

  /* ──────────────────────────────────────
     ANALYSIS TAB
     ────────────────────────────────────── */

  function _destroyChart(id) {
    if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
  }

  const _chartOpts = (overrides) => ({
    responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
    plugins: {
      legend: { labels: { color: '#94A3B8', font: { family: 'Cairo', size: 12 } } },
      tooltip: {
        backgroundColor: '#1E293B', titleColor: '#F8FAFC', bodyColor: '#94A3B8',
        borderColor: '#334155', borderWidth: 1,
        titleFont: { family: 'Cairo', weight: '700' },
        bodyFont:  { family: 'Cairo', size: 12 },
        callbacks: {
          /* Display as currency in tooltips */
          label: ctx => ` ${_fmtCentsCompact(Math.round(ctx.raw * 100))}`,
        },
      },
    },
    scales: {
      x: { ticks: { color: '#64748B', font: { family: 'Cairo', size: 11 } }, grid: { color: '#1E293B' } },
      y: { ticks: { color: '#64748B', font: { family: 'Cairo', size: 11 }, callback: v => _fmtCentsCompact(Math.round(v * 100)) }, grid: { color: '#1E293B' } },
    },
    ...overrides,
  });

  function _renderAnalysis() {
    /* Monthly totals — last 12 months */
    const now = new Date();
    const months = new Map();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.set(d.toLocaleDateString('ar-EG', { month: 'short', year: '2-digit' }), 0);
    }
    Store.expenses.forEach(e => {
      const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
      if (!d) return;
      const k = d.toLocaleDateString('ar-EG', { month: 'short', year: '2-digit' });
      if (months.has(k)) months.set(k, months.get(k) + (e.amountCents || 0));
    });

    /* Monthly bar chart */
    _destroyChart('monthlyChart');
    const mc = _el('monthlyChart');
    if (mc) {
      _charts['monthlyChart'] = new Chart(mc, {
        type: 'bar',
        data: {
          labels: [...months.keys()],
          datasets: [{
            label: 'المصاريف الشهرية',
            /* Divide by 100 only for chart display */
            data: [...months.values()].map(c => c / 100),
            backgroundColor: 'rgba(239,68,68,0.65)',
            borderRadius: 6, borderSkipped: false,
          }],
        },
        options: _chartOpts({}),
      });
    }

    /* Category donut */
    const catMap = new Map();
    Store.expenses.filter(_inPeriod).forEach(e => {
      const k = e.category || 'غير محدد';
      catMap.set(k, (catMap.get(k) || 0) + (e.amountCents || 0));
    });
    const catEntries = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
    _destroyChart('categoryChart');
    const cc = _el('categoryChart');
    if (cc && catEntries.length) {
      _charts['categoryChart'] = new Chart(cc, {
        type: 'doughnut',
        data: {
          labels: catEntries.map(e => e[0]),
          datasets: [{
            data: catEntries.map(e => e[1] / 100),
            backgroundColor: catEntries.map(e => _catColor(e[0])),
            borderColor: '#111827', borderWidth: 3, hoverOffset: 8,
          }],
        },
        options: _chartOpts({ scales: undefined, cutout: '65%' }),
      });
    }

    /* Category trend — multi-line per category, last 6 months */
    const trendMonths = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      trendMonths.push({ key: d.toLocaleDateString('ar-EG', { month: 'short', year: '2-digit' }), year: d.getFullYear(), month: d.getMonth() });
    }
    const topCats = catEntries.slice(0, 5).map(e => e[0]);
    const datasets = topCats.map((cat, idx) => {
      const colors = ['rgb(239,68,68)','rgb(245,158,11)','rgb(59,130,246)','rgb(139,92,246)','rgb(16,185,129)'];
      return {
        label: cat,
        data: trendMonths.map(m => {
          const cents = Store.expenses
            .filter(e => {
              const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
              return d && d.getMonth() === m.month && d.getFullYear() === m.year && e.category === cat;
            })
            .reduce((s, e) => s + (e.amountCents || 0), 0);
          return cents / 100;
        }),
        borderColor: colors[idx % colors.length],
        backgroundColor: 'transparent',
        borderWidth: 2.5, tension: 0.4, pointRadius: 3,
      };
    });
    _destroyChart('trendChart');
    const tc = _el('trendChart');
    if (tc && datasets.length) {
      _charts['trendChart'] = new Chart(tc, {
        type: 'line',
        data: { labels: trendMonths.map(m => m.key), datasets },
        options: _chartOpts({}),
      });
    }
  }

  /* ──────────────────────────────────────
     EXPENSE MODAL
     ────────────────────────────────────── */

  function _populateCategorySelects() {
    const opts = Store.categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
    ['expCategory','recCategory'].forEach(id => {
      const sel = _el(id); if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = opts;
      if (cur) sel.value = cur;
    });
  }

  function _openExpenseModal(expId) {
    _populateCategorySelects();
    const overlay  = _el('expenseModalOverlay'); if (!overlay) return;
    const titleEl  = _el('expenseModalTitle');
    const iconEl   = _el('expenseModalIcon');
    const editId   = _el('editingExpenseId');

    if (expId) {
      const exp = Store.expenses.find(e => e.id === expId); if (!exp) return;
      if (titleEl) titleEl.textContent = 'تعديل المصروف';
      if (iconEl)  iconEl.className = 'fas fa-pen-to-square';
      if (editId)  editId.value = expId;
      /* Pre-fill — display stored cents as decimal */
      const amountEl = _el('expAmount');
      if (amountEl) amountEl.value = ((exp.amountCents || 0) / 100).toFixed(2);
      const catEl = _el('expCategory'); if (catEl) catEl.value = exp.category || '';
      const descEl = _el('expDescription'); if (descEl) descEl.value = exp.description || '';
      const pmEl  = _el('expPaymentMethod'); if (pmEl) pmEl.value = exp.paymentMethod || 'نقدي';
      const notesEl = _el('expNotes'); if (notesEl) notesEl.value = exp.notes || '';
      /* Date */
      if (exp.date) {
        const d = exp.date.toDate ? exp.date.toDate() : new Date(exp.date);
        const local = new Date(d - d.getTimezoneOffset() * 60000).toISOString().split('T')[0];
        const dateEl = _el('expDate'); if (dateEl) dateEl.value = local;
      }
    } else {
      if (titleEl) titleEl.textContent = 'إضافة مصروف';
      if (iconEl)  iconEl.className = 'fas fa-plus-circle';
      if (editId)  editId.value = '';
      /* Reset */
      ['expAmount','expDescription','expNotes'].forEach(id => { const e = _el(id); if (e) e.value = ''; });
      const today = new Date().toISOString().split('T')[0];
      const dateEl = _el('expDate'); if (dateEl) dateEl.value = today;
    }

    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    _el('expAmount')?.focus();
  }

  function _closeExpenseModal() {
    _el('expenseModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  async function _saveExpense() {
    /* Convert to integer cents — single source of truth */
    const amountCents = _toCents(_el('expAmount')?.value);
    const category    = _el('expCategory')?.value?.trim();
    const description = _el('expDescription')?.value?.trim();
    const dateVal     = _el('expDate')?.value;
    const payment     = _el('expPaymentMethod')?.value || 'نقدي';
    const notes       = _el('expNotes')?.value?.trim() || '';
    const editId      = _el('editingExpenseId')?.value || null;

    /* Validate before any network call */
    if (amountCents <= 0) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال مبلغ صحيح أكبر من صفر' });
      _el('expAmount')?.focus(); return;
    }
    if (!category) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى اختيار التصنيف' });
      return;
    }
    if (!description) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال وصف المصروف' });
      _el('expDescription')?.focus(); return;
    }
    if (!dateVal) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى تحديد التاريخ' });
      return;
    }

    const saveBtn = _el('saveExpenseBtn');
    const spinner = _el('saveExpenseSpinner');
    const text    = _el('saveExpenseText');
    if (saveBtn) saveBtn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (text)    text.textContent = 'جاري الحفظ...';

    const user = window.VisionAuth?.getUser();
    const payload = {
      amountCents,                          /* integer — safe */
      amount: amountCents / 100,            /* convenience float for display only */
      category,
      categoryColor: _catColor(category),
      description,
      date: window.db.Timestamp.fromDate(new Date(dateVal)),
      paymentMethod: payment,
      notes,
      createdBy:    user?.displayName || user?.email?.split('@')[0] || 'مدير',
      createdByUid: user?.uid || '',
    };

    try {
      const db = window.db;
      if (editId) {
        await db.collection('expenses').doc(editId)
          .update({ ...payload, updatedAt: window.db.FieldValue.serverTimestamp() });
        window.VisionOverlays?.toast({ type: 'success', message: 'تم تحديث المصروف بنجاح' });
      } else {
        payload.createdAt = window.db.FieldValue.serverTimestamp();
        await db.collection('expenses').add(payload);
        window.VisionOverlays?.toast({ type: 'success', message: `تم إضافة مصروف بقيمة ${_fmtCentsCompact(amountCents)}` });
      }
      _closeExpenseModal();
    } catch (err) {
      console.error('[Expenses] save error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الحفظ' });
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (text)    text.textContent = 'حفظ المصروف';
    }
  }

  async function _deleteExpense(expId) {
    const confirmed = await window.VisionOverlays?.modal({
      title: 'تأكيد الحذف',
      body:  'هل أنت متأكد من حذف هذا المصروف؟ لا يمكن التراجع.',
      buttons: [
        { label: 'حذف', value: 'delete', primary: true },
        { label: 'إلغاء', value: null },
      ],
    });
    if (confirmed !== 'delete') return;
    try {
      await window.db.collection('expenses').doc(expId).delete();
      window.VisionOverlays?.toast({ type: 'success', message: 'تم حذف المصروف' });
    } catch (err) {
      console.error('[Expenses] delete error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر الحذف' });
    }
  }

  /* ──────────────────────────────────────
     RECURRING MODAL
     ────────────────────────────────────── */

  function _openRecurringModal(recId) {
    _populateCategorySelects();
    const overlay = _el('recurringModalOverlay'); if (!overlay) return;
    const titleEl = _el('recurringModalTitle');
    const editId  = _el('editingRecurringId');

    if (recId) {
      const rec = Store.recurring.find(r => r.id === recId); if (!rec) return;
      if (titleEl) titleEl.textContent = 'تعديل المصروف المتكرر';
      if (editId)  editId.value = recId;
      const nameEl = _el('recName');   if (nameEl)  nameEl.value = rec.name || '';
      const catEl  = _el('recCategory'); if (catEl) catEl.value  = rec.category || '';
      const amtEl  = _el('recAmount'); if (amtEl)   amtEl.value  = ((rec.amountCents || 0) / 100).toFixed(2);
      const dayEl  = _el('recDayOfMonth'); if (dayEl) dayEl.value = String(rec.dayOfMonth || 1);
      const notesEl= _el('recNotes');  if (notesEl) notesEl.value = rec.notes || '';
    } else {
      if (titleEl) titleEl.textContent = 'إضافة مصروف متكرر';
      if (editId)  editId.value = '';
      ['recName','recAmount','recNotes'].forEach(id => { const e = _el(id); if (e) e.value = ''; });
    }
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function _closeRecurringModal() {
    _el('recurringModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  async function _saveRecurring() {
    const name        = _el('recName')?.value.trim();
    const category    = _el('recCategory')?.value;
    const amountCents = _toCents(_el('recAmount')?.value);
    const dayOfMonth  = Number(_el('recDayOfMonth')?.value) || 1;
    const notes       = _el('recNotes')?.value.trim() || '';
    const editId      = _el('editingRecurringId')?.value || null;

    if (!name)           { window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم المصروف' }); return; }
    if (amountCents <= 0){ window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال مبلغ صحيح' }); return; }

    const saveBtn = _el('saveRecurringBtn');
    const spinner = _el('saveRecurringSpinner');
    const text    = _el('saveRecurringText');
    if (saveBtn) saveBtn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (text)    text.textContent = 'جاري الحفظ...';

    const payload = { name, category, amountCents, amount: amountCents / 100, dayOfMonth, notes, active: true };
    try {
      const db = window.db;
      if (editId) {
        await db.collection('recurring_expenses').doc(editId).update(payload);
      } else {
        payload.createdAt = window.db.FieldValue.serverTimestamp();
        await db.collection('recurring_expenses').add(payload);
      }
      window.VisionOverlays?.toast({ type: 'success', message: 'تم الحفظ بنجاح' });
      _closeRecurringModal();
    } catch (err) {
      console.error('[Expenses] recurring save error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الحفظ' });
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (text)    text.textContent = 'حفظ';
    }
  }

  async function _toggleRecurring(recId) {
    const rec = Store.recurring.find(r => r.id === recId); if (!rec) return;
    const newActive = rec.active === false ? true : false;
    try {
      await firebase.firestore().collection('recurring_expenses').doc(recId).update({ active: newActive });
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر التحديث' });
    }
  }

  async function _deleteRecurring(recId) {
    const confirmed = await window.VisionOverlays?.modal({
      title: 'حذف المصروف المتكرر',
      body:  'هل تريد حذف هذا المصروف المتكرر؟',
      buttons: [{ label: 'حذف', value: 'delete', primary: true }, { label: 'إلغاء', value: null }],
    });
    if (confirmed !== 'delete') return;
    try {
      await firebase.firestore().collection('recurring_expenses').doc(recId).delete();
      window.VisionOverlays?.toast({ type: 'success', message: 'تم الحذف' });
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر الحذف' });
    }
  }

  /* ──────────────────────────────────────
     CATEGORIES MANAGER
     ────────────────────────────────────── */

  function _renderCatManagerList() {
    const el = _el('catManagerList'); if (!el) return;
    if (!Store.categories.length) { el.innerHTML = '<p class="text-muted text-sm" style="text-align:center;padding:var(--space-5);">لا توجد تصنيفات — أضف تصنيفاً باستخدام الزر أعلاه</p>'; return; }
    el.innerHTML = Store.categories.map(cat => `
      <div class="cat-manager-item" data-id="${cat.id}">
        <div class="cat-manager-swatch" style="background:${cat.color};"></div>
        <div class="cat-manager-name">${cat.name}</div>
        <div class="cat-manager-actions">
          <input type="color" class="cat-color-picker" data-id="${cat.id}" value="${cat.color}"
            style="width:28px;height:28px;border:none;background:none;cursor:pointer;padding:0;" title="تغيير اللون" />
          <button class="btn btn-danger btn-icon btn-sm cat-delete-btn" data-id="${cat.id}" title="حذف">
            <i class="fas fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
      </div>`).join('');

    /* Color picker — debounced Firestore update */
    let _colorTimer = null;
    el.querySelectorAll('.cat-color-picker').forEach(picker => {
      picker.addEventListener('input', e => {
        clearTimeout(_colorTimer);
        _colorTimer = setTimeout(async () => {
          try {
            await firebase.firestore().collection('expense_categories').doc(picker.dataset.id)
              .update({ color: e.target.value });
          } catch (err) { console.error('[Categories] color update:', err); }
        }, 600);
      });
    });

    el.querySelectorAll('.cat-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => _deleteCategory(btn.dataset.id));
    });
  }

  async function _saveNewCategory() {
    const name  = _el('newCatName')?.value.trim();
    const color = _el('newCatColor')?.value || '#64748B';
    if (!name) { window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم التصنيف' }); return; }
    if (Store.categories.find(c => c.name === name)) {
      window.VisionOverlays?.toast({ type: 'error', message: 'هذا التصنيف موجود بالفعل' }); return;
    }
    try {
      await firebase.firestore().collection('expense_categories').add({
        name, color, order: Store.categories.length,
        createdAt: window.db.FieldValue.serverTimestamp(),
      });
      const nameEl = _el('newCatName'); if (nameEl) nameEl.value = '';
      _el('newCategoryForm').hidden = true;
      window.VisionOverlays?.toast({ type: 'success', message: `تم إضافة تصنيف "${name}"` });
    } catch (err) {
      console.error('[Categories] add error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الإضافة' });
    }
  }

  async function _deleteCategory(catId) {
    const cat = Store.categories.find(c => c.id === catId); if (!cat) return;
    const inUse = Store.expenses.filter(e => e.category === cat.name).length;
    const body  = inUse
      ? `هذا التصنيف مستخدم في ${inUse} مصروف. لن تتأثر المصاريف الموجودة بعد الحذف.`
      : `هل تريد حذف تصنيف "${cat.name}"؟`;
    const confirmed = await window.VisionOverlays?.modal({
      title: 'حذف التصنيف', body,
      buttons: [{ label: 'حذف', value: 'delete', primary: true }, { label: 'إلغاء', value: null }],
    });
    if (confirmed !== 'delete') return;
    try {
      await firebase.firestore().collection('expense_categories').doc(catId).delete();
      window.VisionOverlays?.toast({ type: 'success', message: 'تم حذف التصنيف' });
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر الحذف' });
    }
  }

  /* ──────────────────────────────────────
     DATA LOADING
     ────────────────────────────────────── */

  async function _seedCategories(db) {
    /* Only seed if the collection is empty */
    const snap = await db.collection('expense_categories').limit(1).get();
    if (!snap.empty) return;
    const batch = db.batch();
    DEFAULT_CATEGORIES.forEach((cat, i) => {
      const ref = db.collection('expense_categories').doc();
      batch.set(ref, { ...cat, order: i, createdAt: window.db.FieldValue.serverTimestamp() });
    });
    await batch.commit();
  }

  function _loadData() {
    const db = window.db;

    /* Expenses — load last 13 months to cover all period options */
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 13);
    _unsubs.push(
      db.collection('expenses')
        .where('date', '>=', firebase.firestore.Timestamp.fromDate(cutoff))
        .orderBy('date', 'desc')
        .onSnapshot(
          snap => { Store.expenses = snap.docs.map(d => ({ id: d.id, ...d.data() })); _scheduleRender(); },
          err  => { console.error('[Expenses] listener:', err); }
        )
    );

    /* Recurring expenses */
    _unsubs.push(
      db.collection('recurring_expenses').orderBy('createdAt', 'desc')
        .onSnapshot(
          snap => { Store.recurring = snap.docs.map(d => ({ id: d.id, ...d.data() })); _scheduleRender(); },
          err  => { console.error('[Expenses] recurring listener:', err); }
        )
    );

    /* Categories */
    _unsubs.push(
      db.collection('expense_categories').orderBy('order')
        .onSnapshot(
          snap => {
            Store.categories = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            _populateCategorySelects();
            _renderCatManagerList();
            _scheduleRender();
          },
          err => { console.error('[Expenses] categories listener:', err); }
        )
    );

    /* Seed default categories if first run */
    _seedCategories(db).catch(err => console.warn('[Expenses] seed skipped:', err));
  }

  /* ──────────────────────────────────────
     PERIOD BINDING
     ────────────────────────────────────── */

  function _bindPeriod() {
    const sel = _el('periodSelect'); if (!sel) return;
    sel.addEventListener('change', e => {
      const customBox = _el('customDateRange');
      if (e.target.value === 'custom') {
        if (customBox) customBox.hidden = false;
      } else {
        if (customBox) customBox.hidden = true;
        _period = _buildPeriod(e.target.value);
        _reloadExpenses();
        _scheduleRender();
      }
    });

    /* Custom date range */
    const applyCustom = () => {
      const from = _el('dateFrom')?.value;
      const to   = _el('dateTo')?.value;
      if (!from || !to) return;
      _period = _buildPeriod('custom', new Date(from), new Date(to + 'T23:59:59'));
      _reloadExpenses();
      _scheduleRender();
    };
    _el('dateFrom')?.addEventListener('change', applyCustom);
    _el('dateTo')?.addEventListener('change', applyCustom);
  }

  /* Re-attach Firestore listener with new date window */
  function _reloadExpenses() {
    /* Detach old expenses listener */
    if (_unsubs[0]) { try { _unsubs[0](); } catch (_) {} }
    const db      = firebase.firestore();
    const cutoff  = new Date(Math.min(_period.from.getTime(), Date.now() - 13 * 30 * 86400000));
    _unsubs[0] = db.collection('expenses')
      .where('date', '>=', firebase.firestore.Timestamp.fromDate(cutoff))
      .orderBy('date', 'desc')
      .onSnapshot(
        snap => { Store.expenses = snap.docs.map(d => ({ id: d.id, ...d.data() })); _scheduleRender(); },
        err  => console.error('[Expenses] reload listener:', err)
      );
  }

  /* ──────────────────────────────────────
     TAB SWITCHING
     ────────────────────────────────────── */

  function _switchTab(tabKey) {
    document.querySelectorAll('.exp-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tabKey);
      b.setAttribute('aria-selected', b.dataset.tab === tabKey ? 'true' : 'false');
    });
    document.querySelectorAll('.exp-panel').forEach(p =>
      p.classList.toggle('active', p.dataset.panel === tabKey)
    );
    _tab = tabKey;
  }

  function _bindTabs() {
    document.querySelectorAll('.exp-tab[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        _switchTab(btn.dataset.tab);
        _scheduleRender();
      });
    });
  }

  /* ──────────────────────────────────────
     EVENT BINDINGS
     ────────────────────────────────────── */

  function _bindEvents() {
    /* Expense modal */
    _el('addExpenseBtn')?.addEventListener('click', () => _openExpenseModal(null));
    _el('emptyAddBtn')?.addEventListener('click',   () => _openExpenseModal(null));
    _el('closeExpenseModal')?.addEventListener('click',  _closeExpenseModal);
    _el('cancelExpenseModal')?.addEventListener('click', _closeExpenseModal);
    _el('saveExpenseBtn')?.addEventListener('click',     _saveExpense);
    _el('expenseModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('expenseModalOverlay')) _closeExpenseModal();
    });

    /* Recurring modal */
    const openRec = () => _openRecurringModal(null);
    _el('addRecurringBtn')?.addEventListener('click',  openRec);
    _el('addRecurringBtn2')?.addEventListener('click', openRec);
    _el('closeRecurringModal')?.addEventListener('click',  _closeRecurringModal);
    _el('cancelRecurringModal')?.addEventListener('click', _closeRecurringModal);
    _el('saveRecurringBtn')?.addEventListener('click',     _saveRecurring);
    _el('recurringModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('recurringModalOverlay')) _closeRecurringModal();
    });

    /* Categories manager */
    const openCats  = () => { _renderCatManagerList(); _el('categoriesModalOverlay')?.classList.add('active'); document.body.style.overflow = 'hidden'; };
    const closeCats = () => { _el('categoriesModalOverlay')?.classList.remove('active'); document.body.style.overflow = ''; };
    _el('manageCategoriesBtn')?.addEventListener('click', openCats);
    _el('closeCategoriesModal')?.addEventListener('click',    closeCats);
    _el('closeCategoriesModalBtn')?.addEventListener('click', closeCats);
    _el('categoriesModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('categoriesModalOverlay')) closeCats();
    });
    _el('addCategoryInlineBtn')?.addEventListener('click', () => {
      _el('newCategoryForm').hidden = false;
      _el('newCatName')?.focus();
    });
    _el('cancelNewCat')?.addEventListener('click', () => { _el('newCategoryForm').hidden = true; });
    _el('saveNewCatBtn')?.addEventListener('click', _saveNewCategory);

    /* List filters */
    _el('searchInput')?.addEventListener('input', e => { Filters.search = e.target.value; _page = 1; _scheduleRender(); });
    _el('filterCategory')?.addEventListener('change', e => { Filters.category = e.target.value; _page = 1; _scheduleRender(); });
    _el('filterPayment')?.addEventListener('change',  e => { Filters.payment  = e.target.value; _page = 1; _scheduleRender(); });
    _el('resetListFilters')?.addEventListener('click', () => {
      Object.assign(Filters, { search: '', category: '', payment: '' });
      ['searchInput','filterCategory','filterPayment'].forEach(id => { const e = _el(id); if (e) e.value = ''; });
      _page = 1; _scheduleRender();
    });

    window.addEventListener('beforeunload', () => {
      _unsubs.forEach(u => { try { u(); } catch (_) {} });
      Object.keys(_charts).forEach(k => { try { _charts[k].destroy(); } catch (_) {} });
    });
  }

  /* ──────────────────────────────────────
     INIT
     ────────────────────────────────────── */

  function _init() {
    AuthGuard.protect({
      adminOnly: true,
      onReady: () => {
        Sidebar.init({ activePage: 'expenses' });
        Topbar.init({ title: 'المصاريف' });
        _bindPeriod();
        _bindTabs();
        _bindEvents();
        _loadData();
      },
    });
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);
