/**
 * pages/orders.js — Orders Page Controller (Refactored)
 *
 * Data flow:
 *   Firestore onSnapshot → Store.orders → _applyFilters() → _render()
 *
 * Race condition guard:
 *   All state mutations go through _scheduleRender() which debounces
 *   into a single _render() call, preventing stacked snapshots from
 *   causing multiple simultaneous DOM writes.
 */
(function (window) {
  'use strict';

  /* ──────────────────────────────────────
     CONSTANTS
     ────────────────────────────────────── */

  const EGYPT_GOVERNORATES = [
    'القاهرة','الجيزة','الإسكندرية','الدقهلية','البحيرة','المنوفية','القليوبية',
    'الشرقية','الغربية','كفر الشيخ','دمياط','بورسعيد','الإسماعيلية','السويس',
    'شمال سيناء','جنوب سيناء','الأقصر','أسوان','قنا','سوهاج','أسيوط','المنيا',
    'الفيوم','بني سويف','مطروح','الوادي الجديد','البحر الأحمر',
  ];

  const PAGE_SIZE_DEFAULT = 25;

  /* ──────────────────────────────────────
     DATA STORE
     ────────────────────────────────────── */

  const Store = {
    orders:           [],
    employees:        [],
    statuses:         [],
    platforms:        [],
    shippingCompanies:[],
    products:         [],
  };

  /* ──────────────────────────────────────
     UI STATE
     ────────────────────────────────────── */

  const Filters = {
    search:   '',
    status:   '',
    employee: '',
    platform: '',
    gov:      '',
    payment:  '',
    dateFrom: null,
    dateTo:   null,
  };

  let _page      = 1;
  let _pageSize  = PAGE_SIZE_DEFAULT;
  let _editingId = null;       /* null = new order */
  let _selectedIds = new Set();
  let _dataReady = false;      /* true after first snapshot */

  /* Firestore listener cleanup */
  const _unsubs  = [];

  /* Render debounce */
  let _renderTimer = null;

  /* ──────────────────────────────────────
     HELPERS
     ────────────────────────────────────── */

  const _el    = id   => document.getElementById(id);
  const _setText = (id, v) => { const e = _el(id); if (e) e.textContent = v; };
  const _fmtCurrency = n  => (Number(n) || 0).toLocaleString('ar-EG', { maximumFractionDigits: 0 }) + ' ج.م';
  const _fmtDate = ts => {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('ar-EG', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  function _statusType(name) {
    const s = Store.statuses.find(s => s.name === name);
    if (s && s.type) return s.type;
    const lc = (name || '').toLowerCase();
    if (/تسليم|مسلم|delivered/.test(lc)) return 'delivered';
    if (/ملغي|مرتجع|cancelled|returned|رفض/.test(lc)) return 'cancelled';
    return 'active';
  }

  const _isDelivered = o => _statusType(o.status) === 'delivered';
  const _isCancelled = o => _statusType(o.status) === 'cancelled';

  function _statusColor(name) {
    const s = Store.statuses.find(s => s.name === name);
    return s?.color || '#64748B';
  }

  function _empName(id) {
    const e = Store.employees.find(e => e.id === id || e.uid === id);
    return e?.name || '—';
  }

  function _scheduleRender() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(_render, 50);
  }

  /* ──────────────────────────────────────
     FILTERING
     ────────────────────────────────────── */

  function _applyFilters() {
    const search = (Filters.search || '').trim().toLowerCase();
    return Store.orders.filter(o => {
      /* text search */
      if (search) {
        const hay = [
          o.customerName, o.customerPhone, o.customerPhone2,
          o.trackingNumber, o.governorate,
          ...(o.items || []).map(i => i.name),
        ].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      /* status pill */
      if (Filters.status && o.status !== Filters.status) return false;
      /* employee */
      if (Filters.employee && o.employeeId !== Filters.employee) return false;
      /* platform */
      if (Filters.platform && o.platform !== Filters.platform) return false;
      /* governorate */
      if (Filters.gov && o.governorate !== Filters.gov) return false;
      /* payment */
      if (Filters.payment) {
        const isCod = /cod|كاش|استلام/i.test(o.paymentType || '');
        if (Filters.payment === 'cod' && !isCod) return false;
        if (Filters.payment === 'online' && isCod) return false;
      }
      /* date range — normalize to compare dates only (ignore time) */
      if (Filters.dateFrom || Filters.dateTo) {
        const d = o.createdAt?.toDate ? o.createdAt.toDate() : (o.createdAt ? new Date(o.createdAt) : null);
        if (!d || isNaN(d.getTime())) return false;
        /* normalize to YYYY-MM-DD for pure date comparison */
        const orderDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        if (Filters.dateFrom) {
          const from = new Date(Filters.dateFrom.getFullYear(), Filters.dateFrom.getMonth(), Filters.dateFrom.getDate());
          if (orderDate < from) return false;
        }
        if (Filters.dateTo) {
          const to = new Date(Filters.dateTo.getFullYear(), Filters.dateTo.getMonth(), Filters.dateTo.getDate());
          if (orderDate > to) return false;
        }
      }
      return true;
    });
  }

  /* ──────────────────────────────────────
     MAIN RENDER
     ────────────────────────────────────── */

  function _render() {
    const filtered = _applyFilters();
    const total    = filtered.length;
    const maxPage  = Math.max(1, Math.ceil(total / _pageSize));
    if (_page > maxPage) _page = maxPage;
    const start    = (_page - 1) * _pageSize;
    const pageRows = filtered.slice(start, start + _pageSize);

    _renderSummary(filtered);
    _renderTable(pageRows, start);
    _renderMobileCards(pageRows, start);
    _renderPagination(total);
    _updateFilterChips();

    /* Counts */
    _setText('shownCount', pageRows.length);
    _setText('totalCount', total);

    /* Hide skeleton on first data */
    const skel = _el('skeletonLoader');
    if (skel) skel.classList.add('hidden');

    /* Hide table loading, show content */
    const loadingState = _el('tableLoadingState');
    const tableWrapper = _el('desktopTableWrapper');
    if (loadingState) loadingState.classList.add('hidden');
    if (tableWrapper) tableWrapper.style.display = '';

    /* Empty state */
    const empty = _el('emptyState');
    const table = _el('ordersTable');
    const cards = _el('ordersCards');
    if (empty) empty.hidden = total > 0;
    if (table) table.hidden = total === 0;
    if (cards) cards.style.display = total > 0 ? '' : 'none';

    /* Sync select-all checkbox state */
    const selectPageChk = _el('selectPageChk');
    if (selectPageChk && total > 0) {
      const allSelected = pageRows.length > 0 && pageRows.every(o => _selectedIds.has(o.id));
      selectPageChk.checked = allSelected;
    }
  }

  function _renderSummary(filtered) {
    const delivered = filtered.filter(_isDelivered);
    const cancelled = filtered.filter(_isCancelled);
    const pending   = filtered.filter(o => !_isDelivered(o) && !_isCancelled(o));
    const revenue   = delivered.reduce((s, o) => s + (Number(o.total) || 0), 0);
    _setText('statTotal',     filtered.length.toLocaleString('ar-EG'));
    _setText('statDelivered', delivered.length.toLocaleString('ar-EG'));
    _setText('statCancelled', cancelled.length.toLocaleString('ar-EG'));
    _setText('statPending',   pending.length.toLocaleString('ar-EG'));
    _setText('statRevenue',   _fmtCurrency(revenue));
  }

  /* ──────────────────────────────────────
     TABLE RENDER (desktop)
     ────────────────────────────────────── */

  function _renderTable(rows, startIdx) {
    const tbody = _el('ordersTableBody');
    if (!tbody) return;

    if (!rows.length) { tbody.innerHTML = ''; return; }

    const isAdmin = window.VisionAuth?.isAdmin();

    tbody.innerHTML = rows.map((o, i) => {
      const items     = (o.items || []);
      const color     = _statusColor(o.status);
      const selected  = _selectedIds.has(o.id);
      const sType     = _statusType(o.status);

      const productPills = items.map(it =>
        `<span class="product-pill">
          <span class="product-pill-qty">${it.qty || 1}</span> ${it.name || ''}
        </span>`
      ).join('');

      return `<tr class="${selected ? 'selected' : ''}" data-id="${o.id}">
        <td><input type="checkbox" class="row-chk" data-id="${o.id}" ${selected ? 'checked' : ''} aria-label="تحديد الطلب" /></td>
        <td class="text-muted">${startIdx + i + 1}</td>
        <td>
          <div class="td-primary">${o.customerName || '—'}</div>
          <div class="text-xs text-muted" dir="ltr">${o.customerPhone || ''}</div>
          <div class="text-xs text-muted">${o.governorate || ''}</div>
        </td>
        <td><div class="product-pills">${productPills || '—'}</div></td>
        <td>
          <div class="td-primary font-bold">${_fmtCurrency(o.total)}</div>
          <div class="text-xs text-success">${o.profit ? _fmtCurrency(o.profit) : ''}</div>
        </td>
        <td>
          <span class="status-badge" style="background:${color}22;color:${color};border:1px solid ${color}44;"
            data-action="status" data-id="${o.id}" title="اضغط لتغيير الحالة">
            ${o.status || 'بدون حالة'}
          </span>
        </td>
        <td class="text-sm text-muted">${_fmtDate(o.createdAt)}</td>
        ${isAdmin ? `<td class="text-sm text-muted">${_empName(o.employeeId)}</td>` : '<td></td>'}
        <td><span class="tracking-num">${o.trackingNumber || '—'}</span></td>
        <td>
          <div class="row-actions">
            <button class="btn btn-secondary btn-icon btn-sm" data-action="edit" data-id="${o.id}" title="تعديل"><i class="fas fa-pen" aria-hidden="true"></i></button>
            <button class="btn btn-secondary btn-icon btn-sm" data-action="status" data-id="${o.id}" title="تغيير الحالة"><i class="fas fa-tags" aria-hidden="true"></i></button>
            <button class="btn btn-danger btn-icon btn-sm" data-action="delete" data-id="${o.id}" title="حذف"><i class="fas fa-trash" aria-hidden="true"></i></button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  /* ──────────────────────────────────────
     MOBILE CARDS RENDER
     ────────────────────────────────────── */

  function _renderMobileCards(rows, startIdx) {
    const container = _el('ordersCards');
    if (!container) return;

    if (!rows.length) { container.innerHTML = ''; return; }

    const isAdmin = window.VisionAuth?.isAdmin();

    container.innerHTML = rows.map((o, i) => {
      const color    = _statusColor(o.status);
      const items    = (o.items || []);
      const itemStr  = items.map(it => `${it.name} (${it.qty || 1})`).join('، ');

      return `<div class="order-card-mobile" data-id="${o.id}">
        <div class="order-card__header">
          <div>
            <div class="order-card__customer">${o.customerName || '—'}</div>
            <span class="order-card__phone">${o.customerPhone || ''}</span>
          </div>
          <span class="status-badge" style="background:${color}22;color:${color};border:1px solid ${color}44;"
            data-action="status" data-id="${o.id}" title="اضغط لتغيير الحالة">
            ${o.status || 'بدون حالة'}
          </span>
        </div>
        <div class="order-card__body">
          <div class="order-card__row">
            <span class="order-card__label"><i class="fas fa-box" aria-hidden="true"></i> المنتجات</span>
            <span class="order-card__value">${itemStr || '—'}</span>
          </div>
          <div class="order-card__row">
            <span class="order-card__label"><i class="fas fa-money-bill" aria-hidden="true"></i> الإجمالي</span>
            <span class="order-card__value" style="color:var(--color-primary);font-weight:var(--font-weight-bold)">${_fmtCurrency(o.total)}</span>
          </div>
          ${o.profit ? `<div class="order-card__row">
            <span class="order-card__label"><i class="fas fa-chart-line" aria-hidden="true"></i> الربح</span>
            <span class="order-card__value" style="color:var(--color-success)">${_fmtCurrency(o.profit)}</span>
          </div>` : ''}
          <div class="order-card__row">
            <span class="order-card__label"><i class="fas fa-calendar" aria-hidden="true"></i> التاريخ</span>
            <span class="order-card__value">${_fmtDate(o.createdAt)}</span>
          </div>
          <div class="order-card__row">
            <span class="order-card__label"><i class="fas fa-map-marker-alt" aria-hidden="true"></i> المحافظة</span>
            <span class="order-card__value">${o.governorate || '—'}</span>
          </div>
          ${isAdmin ? `<div class="order-card__row">
            <span class="order-card__label"><i class="fas fa-user" aria-hidden="true"></i> الموظف</span>
            <span class="order-card__value">${_empName(o.employeeId)}</span>
          </div>` : ''}
          <div class="order-card__row">
            <span class="order-card__label"><i class="fas fa-barcode" aria-hidden="true"></i> التتبع</span>
            <span class="order-card__value"><span class="tracking-num">${o.trackingNumber || '—'}</span></span>
          </div>
        </div>
        <div class="order-card__actions">
          <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${o.id}"><i class="fas fa-pen"></i> تعديل</button>
          <button class="btn btn-secondary btn-sm" data-action="status" data-id="${o.id}"><i class="fas fa-tags"></i> الحالة</button>
          <button class="btn btn-danger btn-sm" data-action="delete" data-id="${o.id}"><i class="fas fa-trash"></i> حذف</button>
        </div>
      </div>`;
    }).join('');
  }

  /* ──────────────────────────────────────
     PAGINATION
     ────────────────────────────────────── */

  function _renderPagination(total) {
    const bar = _el('paginationBar');
    if (!bar) return;
    const pages = Math.ceil(total / _pageSize) || 1;
    if (pages <= 1) { bar.innerHTML = ''; return; }

    let html = `<button class="pagination-btn" data-p="${Math.max(1, _page - 1)}" ${_page <= 1 ? 'disabled' : ''}><i class="fas fa-chevron-right" aria-hidden="true"></i></button>`;
    for (let p = 1; p <= pages; p++) {
      if (pages > 9 && Math.abs(p - _page) > 2 && p !== 1 && p !== pages) {
        if (p === 2 || p === pages - 1) html += `<span class="pagination-btn" style="pointer-events:none;opacity:0.4;cursor:default;">…</span>`;
        continue;
      }
      html += `<button class="pagination-btn ${p === _page ? 'active' : ''}" data-p="${p}">${p}</button>`;
    }
    html += `<button class="pagination-btn" data-p="${Math.min(pages, _page + 1)}" ${_page >= pages ? 'disabled' : ''}><i class="fas fa-chevron-left" aria-hidden="true"></i></button>`;
    bar.innerHTML = html;
  }

  /* ──────────────────────────────────────
     FILTER CHIPS
     ────────────────────────────────────── */

  function _updateFilterChips() {
    const container = _el('activeFilterChips');
    if (!container) return;

    const chips = [];

    if (Filters.search) chips.push({ key: 'search', label: `بحث: "${Filters.search}"` });
    if (Filters.employee) chips.push({ key: 'employee', label: `موظف: ${_empName(Filters.employee)}` });
    if (Filters.platform) chips.push({ key: 'platform', label: `منصة: ${Filters.platform}` });
    if (Filters.gov) chips.push({ key: 'gov', label: `محافظة: ${Filters.gov}` });
    if (Filters.payment) chips.push({ key: 'payment', label: `دفع: ${Filters.payment === 'cod' ? 'كاش' : 'إلكتروني'}` });
    if (Filters.dateFrom) chips.push({ key: 'dateFrom', label: `من: ${Filters.dateFrom.toLocaleDateString('ar-EG')}` });
    if (Filters.dateTo) chips.push({ key: 'dateTo', label: `إلى: ${Filters.dateTo.toLocaleDateString('ar-EG')}` });

    container.innerHTML = chips.map(c =>
      `<span class="filter-chip">
        ${c.label}
        <button class="filter-chip-remove" data-chip="${c.key}" aria-label="إزالة ${c.label}"><i class="fas fa-xmark"></i></button>
      </span>`
    ).join('');

    container.querySelectorAll('.filter-chip-remove').forEach(btn => {
      btn.addEventListener('click', () => _removeFilterChip(btn.dataset.chip));
    });
  }

  function _removeFilterChip(key) {
    switch (key) {
      case 'search':
        Filters.search = '';
        const s = _el('searchInput'); if (s) s.value = '';
        break;
      case 'employee':
        Filters.employee = '';
        const e = _el('filterEmployee'); if (e) e.value = '';
        break;
      case 'platform':
        Filters.platform = '';
        const p = _el('filterPlatform'); if (p) p.value = '';
        break;
      case 'gov':
        Filters.gov = '';
        const g = _el('filterGov'); if (g) g.value = '';
        break;
      case 'payment':
        Filters.payment = '';
        const pm = _el('filterPayment'); if (pm) pm.value = '';
        break;
      case 'dateFrom':
        Filters.dateFrom = null;
        const df = _el('dateFrom'); if (df) df.value = '';
        break;
      case 'dateTo':
        Filters.dateTo = null;
        const dt = _el('dateTo'); if (dt) dt.value = '';
        break;
    }
    _page = 1;
    _scheduleRender();
  }

  /* ──────────────────────────────────────
     STATUS PILLS BUILD
     ────────────────────────────────────── */

  function _buildStatusPills() {
    const container = _el('statusPills');
    if (!container) return;
    const pills = [{ name: '', label: 'الكل' }, ...Store.statuses.map(s => ({ name: s.name, label: s.name, color: s.color }))];
    container.innerHTML = pills.map(s => `
      <button class="status-pill ${Filters.status === s.name ? 'active' : ''}"
        data-status="${s.name}"
        style="${s.color && Filters.status === s.name ? `background:${s.color};border-color:${s.color};` : s.color ? `border-color:${s.color}44;color:${s.color};` : ''}">
        ${s.label}
      </button>`).join('');
    container.querySelectorAll('.status-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        Filters.status = pill.dataset.status;
        _page = 1;
        _buildStatusPills();
        _scheduleRender();
      });
    });
  }

  /* ──────────────────────────────────────
     FILTER SELECTS POPULATION
     ────────────────────────────────────── */

  function _populateFilters() {
    /* Employees */
    const empSel = _el('filterEmployee');
    if (empSel) {
      const opts = Store.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
      empSel.innerHTML = '<option value="">كل الموظفين</option>' + opts;
    }
    /* Platforms */
    const platSel = _el('filterPlatform');
    if (platSel) {
      const opts = Store.platforms.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
      platSel.innerHTML = '<option value="">كل المنصات</option>' + opts;
    }
    /* Governorates */
    const govSel = _el('filterGov');
    if (govSel) {
      govSel.innerHTML = '<option value="">كل المحافظات</option>' +
        EGYPT_GOVERNORATES.map(g => `<option value="${g}">${g}</option>`).join('');
    }
    _buildStatusPills();
  }

  /* ──────────────────────────────────────
     ORDER FORM MODAL
     ────────────────────────────────────── */

  function _populateFormSelects() {
    /* Statuses */
    const statusSel = _el('orderStatus');
    if (statusSel) {
      statusSel.innerHTML = Store.statuses.map(s =>
        `<option value="${s.name}">${s.name}</option>`).join('');
    }
    /* Employees */
    const empSel = _el('orderEmployee');
    if (empSel) {
      empSel.innerHTML = '<option value="">غير محدد</option>' +
        Store.employees.filter(e => e.status === 'active' || !e.status).map(e =>
          `<option value="${e.id}">${e.name}</option>`).join('');
    }
    /* Platforms */
    const platSel = _el('salesPlatform');
    if (platSel) {
      platSel.innerHTML = '<option value="">غير محدد</option>' +
        Store.platforms.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
    }
    /* Shipping companies */
    const shipSel = _el('orderShippingCompany');
    if (shipSel) {
      shipSel.innerHTML = '<option value="">بدون شركة</option>' +
        Store.shippingCompanies.map(s =>
          `<option value="${s.id}" data-cost="${s.cost || 0}">${s.name}</option>`).join('');
    }
    /* Governorates */
    const govSel = _el('customerGov');
    if (govSel) {
      govSel.innerHTML = '<option value="">اختر المحافظة</option>' +
        EGYPT_GOVERNORATES.map(g => `<option value="${g}">${g}</option>`).join('');
    }
  }

  function _openOrderModal(orderId) {
    _editingId = orderId || null;
    _populateFormSelects();
    _clearProductRows();

    const overlay = _el('orderModalOverlay');
    const titleEl = _el('orderModalTitle');
    const iconEl  = _el('orderModalIcon');

    if (!overlay) return;

    if (_editingId) {
      /* Edit: pre-fill form */
      const order = Store.orders.find(o => o.id === _editingId);
      if (!order) return;
      titleEl.textContent = 'تعديل الطلب';
      iconEl.innerHTML = '<i class="fas fa-pen" aria-hidden="true"></i>';
      _fillOrderForm(order);
    } else {
      /* New order */
      titleEl.textContent = 'إضافة طلب جديد';
      iconEl.innerHTML = '<i class="fas fa-cart-plus" aria-hidden="true"></i>';
      _resetOrderForm();
      _addProductRow();
    }

    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    _el('customerName')?.focus();
  }

  function _closeOrderModal() {
    const overlay = _el('orderModalOverlay');
    if (overlay) overlay.classList.remove('active');
    document.body.style.overflow = '';
    _editingId = null;
  }

  function _resetOrderForm() {
    ['customerName','customerPhone','customerPhone2','customerAddress',
     'trackingNumber','orderNotes'].forEach(id => { const e = _el(id); if (e) e.value = ''; });
    ['chkFreeShipping','chkPrepaidShipping','chkPaidInAdvance','chkIntentConfirmed']
      .forEach(id => { const e = _el(id); if (e) e.checked = false; });
    const discount = _el('orderDiscount');
    if (discount) discount.value = '0';
    const now = new Date();
    const localDT = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const dateEl = _el('orderDate');
    if (dateEl) dateEl.value = localDT;
    /* Clear phone warning */
    const warn = _el('phoneWarning');
    if (warn) warn.hidden = true;
    _updateCOD();
  }

  function _fillOrderForm(order) {
    _el('editingOrderId').value = order.id;
    _el('customerName').value     = order.customerName    || '';
    _el('customerPhone').value    = order.customerPhone   || '';
    _el('customerPhone2').value   = order.customerPhone2  || '';
    _el('customerAddress').value  = order.address         || '';
    _el('trackingNumber').value   = order.trackingNumber  || '';
    _el('orderNotes').value       = order.notes           || '';
    _el('orderDiscount').value    = order.discount        || '0';
    _el('chkFreeShipping').checked     = !!order.freeShipping;
    _el('chkPrepaidShipping').checked  = !!order.prepaidShipping;
    _el('chkPaidInAdvance').checked    = !!order.paidInAdvance;
    _el('chkIntentConfirmed').checked  = !!order.intentConfirmed;
    /* Selects */
    const setSelect = (id, val) => { const e = _el(id); if (e && val) e.value = val; };
    setSelect('customerGov',          order.governorate);
    setSelect('salesPlatform',        order.platform);
    setSelect('customerGender',       order.gender);
    setSelect('orderStatus',          order.status);
    setSelect('orderEmployee',        order.employeeId);
    setSelect('orderShippingCompany', order.shippingCompanyId);
    /* Date */
    if (order.createdAt) {
      const d = order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
      const local = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      _el('orderDate').value = local;
    }
    /* Products */
    (order.items || []).forEach(item => _addProductRow(item));
    if (!(order.items || []).length) _addProductRow();
    _updateCOD();
  }

  /* ──────────────────────────────────────
     PRODUCT ROWS
     ────────────────────────────────────── */

  function _clearProductRows() {
    const c = _el('productsContainer');
    if (c) c.innerHTML = '';
  }

  let _productRowIdx = 0;

  function _addProductRow(item) {
    const container = _el('productsContainer');
    if (!container) return;
    const idx = _productRowIdx++;
    const row = document.createElement('div');
    row.className = 'product-row';
    row.dataset.idx = idx;

    const productOpts = Store.products.map(p =>
      `<option value="${p.id}" data-price="${p.price || 0}" data-cost="${p.cost || 0}">${p.name}</option>`
    ).join('');

    row.innerHTML = `
      <select class="form-input prod-name" data-idx="${idx}" aria-label="المنتج">
        <option value="">اختر منتجاً</option>
        ${productOpts}
        <option value="__custom__">منتج مخصص...</option>
      </select>
      <input type="number" class="form-input prod-qty" value="${item?.qty || 1}" min="1" step="1" aria-label="الكمية" />
      <input type="number" class="form-input prod-price" value="${item?.price || ''}" min="0" step="0.5" placeholder="السعر" aria-label="السعر" />
      <input type="number" class="form-input prod-cost product-cost-col" value="${item?.cost || ''}" min="0" step="0.5" placeholder="التكلفة" aria-label="التكلفة" />
      <button type="button" class="product-row-remove" aria-label="حذف المنتج"><i class="fas fa-xmark" aria-hidden="true"></i></button>`;

    /* Pre-select product if editing */
    if (item?.productId) {
      const sel = row.querySelector('.prod-name');
      if (sel) sel.value = item.productId;
    } else if (item?.name) {
      const sel = row.querySelector('.prod-name');
      if (sel) sel.value = '__custom__';
      _switchToCustomInput(row, item.name);
    }

    row.querySelector('.prod-name')?.addEventListener('change', e => {
      if (e.target.value === '__custom__') {
        _switchToCustomInput(row, '');
      } else {
        const opt = e.target.selectedOptions[0];
        if (opt) {
          row.querySelector('.prod-price').value = opt.dataset.price || '';
          row.querySelector('.prod-cost').value  = opt.dataset.cost  || '';
        }
      }
      _updateCOD();
    });
    row.querySelector('.prod-qty')?.addEventListener('input', _updateCOD);
    row.querySelector('.prod-price')?.addEventListener('input', _updateCOD);
    row.querySelector('.product-row-remove')?.addEventListener('click', () => {
      row.remove();
      _updateCOD();
      const remaining = container.querySelectorAll('.product-row');
      if (!remaining.length) _el('productsEmpty').hidden = false;
    });

    container.appendChild(row);
    _el('productsEmpty').hidden = true;
    _updateCOD();
  }

  function _switchToCustomInput(row, defaultName) {
    const sel = row.querySelector('.prod-name');
    if (!sel) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input prod-name';
    input.placeholder = 'اسم المنتج المخصص';
    input.value = defaultName || '';
    input.dataset.idx = sel.dataset.idx;
    input.setAttribute('aria-label', 'المنتج المخصص');
    sel.replaceWith(input);
    input.focus();
  }

  /* ──────────────────────────────────────
     COD CALCULATION
     ────────────────────────────────────── */

  function _updateCOD() {
    const rows = document.querySelectorAll('.product-row');
    let subTotal = 0;
    rows.forEach(row => {
      const price = Number(row.querySelector('.prod-price')?.value) || 0;
      const qty   = Number(row.querySelector('.prod-qty')?.value)   || 1;
      subTotal += price * qty;
    });

    const discount    = Number(_el('orderDiscount')?.value) || 0;
    const shipSel     = _el('orderShippingCompany');
    const shipCost    = Number(shipSel?.selectedOptions[0]?.dataset?.cost) || 0;
    const freeShip    = _el('chkFreeShipping')?.checked;
    const prepaidShip = _el('chkPrepaidShipping')?.checked;
    const paidInAdv   = _el('chkPaidInAdvance')?.checked;

    let cod = subTotal - discount;
    if (!freeShip && !prepaidShip) cod += shipCost;
    if (paidInAdv) cod = 0;
    cod = Math.max(0, cod);

    _setText('codAmount', _fmtCurrency(cod));
    const breakdown = `(${_fmtCurrency(subTotal)} منتجات${discount ? ' − ' + _fmtCurrency(discount) + ' خصم' : ''}${!freeShip && !prepaidShip && shipCost ? ' + ' + _fmtCurrency(shipCost) + ' شحن' : ''})`;
    _setText('codBreakdown', paidInAdv ? 'الطلب مدفوع بالكامل' : breakdown);
  }

  /* ──────────────────────────────────────
     PHONE DUPLICATE CHECK
     ────────────────────────────────────── */

  let _phoneTimer = null;

  function _checkDuplicatePhone(phone) {
    clearTimeout(_phoneTimer);
    const warn = _el('phoneWarning');
    const text = _el('phoneWarningText');
    if (!phone || phone.length < 10 || !warn) {
      if (warn) warn.hidden = true;
      return;
    }
    _phoneTimer = setTimeout(() => {
      const matches = Store.orders.filter(o =>
        o.customerPhone === phone && o.id !== _editingId
      );
      if (matches.length) {
        text.textContent = `هذا الرقم موجود في ${matches.length} طلب سابق`;
        warn.hidden = false;
      } else {
        warn.hidden = true;
      }
    }, 400);
  }

  /* ──────────────────────────────────────
     SAVE ORDER
     ────────────────────────────────────── */

  function _collectOrderData() {
    const items = [];
    document.querySelectorAll('.product-row').forEach(row => {
      const nameEl = row.querySelector('.prod-name');
      const name   = nameEl?.tagName === 'SELECT'
        ? nameEl.selectedOptions[0]?.text || ''
        : nameEl?.value || '';
      const prodId = nameEl?.tagName === 'SELECT' && nameEl.value !== '__custom__' ? nameEl.value : null;
      const price  = Number(row.querySelector('.prod-price')?.value) || 0;
      const cost   = Number(row.querySelector('.prod-cost')?.value)  || 0;
      const qty    = Number(row.querySelector('.prod-qty')?.value)   || 1;
      if (name && price) items.push({ productId: prodId, name, price, cost, qty, profit: (price - cost) * qty });
    });

    const subTotal  = items.reduce((s, i) => s + i.price * i.qty, 0);
    const totalCost = items.reduce((s, i) => s + i.cost  * i.qty, 0);
    const discount  = Number(_el('orderDiscount')?.value) || 0;
    const shipSel   = _el('orderShippingCompany');
    const shipCost  = Number(shipSel?.selectedOptions[0]?.dataset?.cost) || 0;
    const freeShip  = _el('chkFreeShipping')?.checked;
    const prepaid   = _el('chkPrepaidShipping')?.checked;
    const paidAdv   = _el('chkPaidInAdvance')?.checked;

    const total  = Math.max(0, subTotal - discount + (!freeShip && !prepaid ? shipCost : 0));
    const profit = total - totalCost - shipCost;

    const dateEl = _el('orderDate');
    const createdAt = dateEl?.value
      ? firebase.firestore.Timestamp.fromDate(new Date(dateEl.value))
      : firebase.firestore.FieldValue.serverTimestamp();

    return {
      customerName:        _el('customerName')?.value.trim()    || '',
      customerPhone:       _el('customerPhone')?.value.trim()   || '',
      customerPhone2:      _el('customerPhone2')?.value.trim()  || '',
      address:             _el('customerAddress')?.value.trim() || '',
      governorate:         _el('customerGov')?.value            || '',
      platform:            _el('salesPlatform')?.value          || '',
      gender:              _el('customerGender')?.value         || '',
      status:              _el('orderStatus')?.value            || '',
      employeeId:          _el('orderEmployee')?.value          || '',
      shippingCompanyId:   shipSel?.value                       || '',
      shippingCompanyName: shipSel?.selectedOptions[0]?.text    || '',
      trackingNumber:      _el('trackingNumber')?.value.trim()  || '',
      notes:               _el('orderNotes')?.value.trim()      || '',
      freeShipping:        !!freeShip,
      prepaidShipping:     !!prepaid,
      paidInAdvance:       !!paidAdv,
      intentConfirmed:     !!_el('chkIntentConfirmed')?.checked,
      discount,
      shippingCost: shipCost,
      items, subTotal, total, cost: totalCost, profit,
      createdAt,
    };
  }

  async function _saveOrder() {
    const data    = _collectOrderData();
    const saveBtn = _el('saveOrderBtn');
    const spinner = _el('saveOrderSpinner');
    const text    = _el('saveOrderText');

    /* Basic validation */
    if (!data.customerName || !data.customerPhone) {
      VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم ورقم هاتف العميل' });
      return;
    }
    if (!data.items.length) {
      VisionOverlays?.toast({ type: 'error', message: 'يرجى إضافة منتج واحد على الأقل' });
      return;
    }

    if (saveBtn) saveBtn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (text)    text.textContent = 'جاري الحفظ...';

    try {
      const db = window.db;
      await db.runTransaction(async (transaction) => {
        let oldOrder = null;
        if (_editingId) {
          const oldOrderDoc = await transaction.get(db.collection('orders').doc(_editingId));
          if (!oldOrderDoc.exists) {
            throw new Error('الطلب غير موجود للتحديث');
          }
          oldOrder = oldOrderDoc.data();
        }

        // Restore inventory from old order (if updating)
        if (oldOrder && oldOrder.items) {
          for (const item of oldOrder.items) {
            if (!item.productId) continue; // Skip custom products
            const productRef = db.collection('products').doc(item.productId);
            const productDoc = await transaction.get(productRef);
            if (!productDoc.exists) {
              console.warn(`Product ${item.productId} not found for restocking`);
              continue;
            }
            const productData = productDoc.data();
            const newQty = (productData.quantity || 0) + (item.qty || 0);
            transaction.update(productRef, { quantity: newQty });
          }
        }

        // Deduct inventory for new order
        for (const item of data.items) {
          if (!item.productId) continue; // Skip custom products
          const productRef = db.collection('products').doc(item.productId);
          const productDoc = await transaction.get(productRef);
          if (!productDoc.exists) {
            throw new Error(`المنتج غير موجود: ${item.productId}`);
          }
          const productData = productDoc.data();
          const availableQty = productData.quantity || 0;
          if (availableQty < item.qty) {
            throw new Error(`كمية غير كافية للمنتج ${productData.name || item.productId}. المتاح: ${availableQty}, المطلوب: ${item.qty}`);
          }
          const newQty = availableQty - item.qty;
          transaction.update(productRef, { quantity: newQty });
        }

        // Now save the order
        if (_editingId) {
          transaction.update(db.collection('orders').doc(_editingId), { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        } else {
          const newOrderRef = db.collection('orders').doc();
          transaction.set(newOrderRef, { ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        }
      });

      VisionOverlays?.toast({
        type: 'success',
        title: _editingId ? 'تم التعديل' : 'تمت الإضافة',
        message: _editingId ? 'تم تحديث بيانات الطلب بنجاح' : 'تم إضافة الطلب الجديد بنجاح'
      });
      _closeOrderModal();
    } catch (err) {
      console.error('[Orders] transaction error:', err);
      VisionOverlays?.toast({ type: 'error', message: err.message || 'حدث خطأ أثناء معالجة الطلب' });
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (text)    text.textContent = 'حفظ الطلب';
    }
  }

  /* ──────────────────────────────────────
     STATUS MODAL
     ────────────────────────────────────── */

  function _openStatusModal(orderId) {
    const order = Store.orders.find(o => o.id === orderId);
    if (!order) return;
    const overlay = _el('statusModalOverlay');
    if (!overlay) return;
    _el('statusModalOrderId').value = orderId;
    _setText('statusModalOrderInfo', `تغيير حالة طلب: ${order.customerName || ''} — ${_fmtCurrency(order.total)}`);
    const sel = _el('newStatusSelect');
    if (sel) {
      sel.innerHTML = Store.statuses.map(s =>
        `<option value="${s.name}" ${s.name === order.status ? 'selected' : ''}>${s.name}</option>`).join('');
    }
    _el('statusNotes').value = '';
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function _closeStatusModal() {
    const overlay = _el('statusModalOverlay');
    if (overlay) {
      overlay.classList.remove('active');
    }
    document.body.style.overflow = '';
  }

  async function _applyStatusChange() {
    const orderId   = _el('statusModalOrderId')?.value;
    if (!orderId) return;
    const newStatus = _el('newStatusSelect')?.value;
    if (!newStatus) return;
    const notes     = _el('statusNotes')?.value.trim();
    try {
      const update = { status: newStatus, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      if (notes) update.lastStatusNote = notes;
      await firebase.firestore().collection('orders').doc(orderId).update(update);
      VisionOverlays?.toast({ type: 'success', message: `تم تغيير الحالة إلى: ${newStatus}` });
      _closeStatusModal();
    } catch (err) {
      console.error('[Orders] status change error:', err);
      VisionOverlays?.toast({ type: 'error', message: 'تعذّر تغيير الحالة.' });
    }
  }

  /* ──────────────────────────────────────
     BULK EMPLOYEE MODAL
     ────────────────────────────────────── */

  function _openBulkEmployeeModal() {
    if (!_selectedIds.size) return;
    const overlay = _el('bulkEmployeeModalOverlay');
    if (!overlay) return;

    const sel = _el('bulkEmployeeSelect');
    if (sel) {
      sel.innerHTML = '<option value="">اختر موظفاً</option>' +
        Store.employees.filter(e => e.status === 'active' || !e.status).map(e =>
          `<option value="${e.id}">${e.name}</option>`).join('');
    }
    _setText('bulkEmployeeInfo', `تعيين موظف لـ ${_selectedIds.size} ${ _selectedIds.size === 1 ? 'طلب' : 'طلبات'}`);
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function _closeBulkEmployeeModal() {
    const overlay = _el('bulkEmployeeModalOverlay');
    if (overlay) overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  async function _applyBulkEmployee() {
    const employeeId = _el('bulkEmployeeSelect')?.value;
    if (!employeeId) {
      VisionOverlays?.toast({ type: 'warning', message: 'يرجى اختيار موظف' });
      return;
    }
    const ids = [..._selectedIds];
    try {
      const db = window.db;
      const batch = db.batch();
      ids.forEach(id => {
        batch.update(db.collection('orders').doc(id), {
          employeeId,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
      VisionOverlays?.toast({ type: 'success', message: `تم تعيين الموظف لـ ${ids.length} ${ids.length === 1 ? 'طلب' : 'طلبات'}` });
      _selectedIds.clear();
      _updateBulkBar();
      _closeBulkEmployeeModal();
    } catch (err) {
      console.error('[Orders] bulk employee error:', err);
      VisionOverlays?.toast({ type: 'error', message: 'تعذّر تعيين الموظف.' });
    }
  }

  /* ──────────────────────────────────────
     DELETE
     ────────────────────────────────────── */

  async function _confirmDelete(ids) {
    if (!ids.length) return;
    const label = ids.length === 1 ? 'هذا الطلب' : `${ids.length} طلبات`;
    const confirmed = await VisionOverlays?.modal({
      title: 'تأكيد الحذف',
      body: `هل أنت متأكد من حذف ${label}؟ لا يمكن التراجع عن هذا الإجراء.`,
      buttons: [
        { label: 'حذف', value: 'delete', primary: true },
        { label: 'إلغاء', value: null },
      ],
    });
    if (confirmed !== 'delete') return;

    const db = window.db;
    const batch = db.batch();
    ids.forEach(id => batch.delete(db.collection('orders').doc(id)));
    try {
      await batch.commit();
      _selectedIds.clear();
      _updateBulkBar();
      VisionOverlays?.toast({ type: 'success', message: `تم حذف ${label}` });
    } catch (err) {
      console.error('[Orders] delete error:', err);
      VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الحذف.' });
    }
  }

  /* ──────────────────────────────────────
     BULK ACTIONS
     ────────────────────────────────────── */

  function _updateBulkBar() {
    const bar = _el('bulkBar');
    if (!bar) return;
    const n = _selectedIds.size;
    bar.classList.toggle('visible', n > 0);
    _setText('bulkCount', `${n} ${n === 1 ? 'طلب محدد' : 'طلبات محددة'}`);
  }

  /* ──────────────────────────────────────
     IMPORT / EXPORT
     ────────────────────────────────────── */

  function _exportCSV() {
    const filtered = _applyFilters();
    const headers  = ['رقم الطلب','العميل','الهاتف','المحافظة','المنتجات','الإجمالي','الحالة','الموظف','التاريخ','التتبع'];
    const rows     = filtered.map(o => [
      o.id,
      o.customerName || '',
      o.customerPhone || '',
      o.governorate   || '',
      (o.items || []).map(i => `${i.name} (${i.qty})`).join(' | '),
      o.total || 0,
      o.status || '',
      _empName(o.employeeId),
      _fmtDate(o.createdAt),
      o.trackingNumber || '',
    ]);
    const csv  = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `orders_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    VisionOverlays?.toast({ type: 'success', message: `تم تصدير ${filtered.length} طلب` });
  }

  function _importOrders() {
    /* Placeholder: future Excel import */
    VisionOverlays?.toast({ type: 'info', message: 'ميزة الاستيراد قريباً — يمكنك التواصل مع الدعم الفني' });
  }

  /* ──────────────────────────────────────
     DATA LOADING
     ────────────────────────────────────── */

  function _loadData() {
    const db = window.db;

    /* Show loading state */
    const loadingState = _el('tableLoadingState');
    const tableWrapper = _el('desktopTableWrapper');
    if (loadingState) loadingState.classList.remove('hidden');
    if (tableWrapper) tableWrapper.style.display = 'none';

    /* Real-time orders */
    _unsubs.push(
      window.db.collection('orders').orderBy('createdAt', 'desc')
        .onSnapshot(
          snap => {
            Store.orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            _dataReady = true;
            _scheduleRender();
          },
          err  => {
            console.error('[Orders] listener:', err);
            if (loadingState) loadingState.classList.add('hidden');
            VisionOverlays?.toast({ type: 'error', message: 'فشل تحميل البيانات. تحقق من الاتصال.' });
          }
        )
    );

    /* Static references (one-time) */
    Promise.all([
      window.db.collection('statuses').orderBy('order').get().catch(() => window.db.collection('statuses').get()),
      window.db.collection('employees').get(),
      window.db.collection('platforms').get(),
      window.db.collection('shippingCompanies').get(),
      window.db.collection('products').orderBy('name').get().catch(() => window.db.collection('products').get()),
    ]).then(([st, em, pl, sh, pr]) => {
      Store.statuses          = st.docs.map(d => ({ id: d.id, ...d.data() }));
      Store.employees         = em.docs.map(d => ({ id: d.id, ...d.data() }));
      Store.platforms         = pl.docs.map(d => ({ id: d.id, ...d.data() }));
      Store.shippingCompanies = sh.docs.map(d => ({ id: d.id, ...d.data() }));
      Store.products          = pr.docs.map(d => ({ id: d.id, ...d.data() }));
      _populateFilters();
    }).catch(err => {
      console.error('[Orders] static load:', err);
      VisionOverlays?.toast({ type: 'error', message: 'فشل تحميل البيانات المساعدة.' });
    });
  }

  /* ──────────────────────────────────────
     EVENT DELEGATION
     ────────────────────────────────────── */

  function _delegateTableClicks() {
    /* Desktop table */
    const tbody = _el('ordersTableBody');
    if (tbody) {
      tbody.addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        e.stopPropagation();
        const action = btn.dataset.action;
        const id     = btn.dataset.id;
        if (action === 'edit')   _openOrderModal(id);
        if (action === 'status') _openStatusModal(id);
        if (action === 'delete') _confirmDelete([id]);
      });

      tbody.addEventListener('change', e => {
        const chk = e.target.closest('.row-chk');
        if (!chk) return;
        if (chk.checked) _selectedIds.add(chk.dataset.id);
        else             _selectedIds.delete(chk.dataset.id);
        _updateBulkBar();
      });
    }

    /* Mobile cards */
    const cards = _el('ordersCards');
    if (cards) {
      cards.addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        e.stopPropagation();
        const action = btn.dataset.action;
        const id     = btn.dataset.id;
        if (action === 'edit')   _openOrderModal(id);
        if (action === 'status') _openStatusModal(id);
        if (action === 'delete') _confirmDelete([id]);
      });
    }

    /* Pagination delegation */
    const pagBar = _el('paginationBar');
    if (pagBar) {
      pagBar.addEventListener('click', e => {
        const btn = e.target.closest('[data-p]');
        if (!btn || btn.disabled) return;
        _page = Number(btn.dataset.p);
        _scheduleRender();
      });
    }
  }

  /* ──────────────────────────────────────
     KEYBOARD HANDLERS
     ────────────────────────────────────── */

  function _handleKeydown(e) {
    if (e.key !== 'Escape') return;
    /* Close any open modal */
    const orderOverlay  = _el('orderModalOverlay');
    const statusOverlay = _el('statusModalOverlay');
    const bulkOverlay   = _el('bulkEmployeeModalOverlay');
    if (orderOverlay?.classList.contains('active'))  { _closeOrderModal(); return; }
    if (statusOverlay?.classList.contains('active')) { _closeStatusModal(); return; }
    if (bulkOverlay?.classList.contains('active'))   { _closeBulkEmployeeModal(); return; }
  }

  /* ──────────────────────────────────────
     EVENT BINDINGS
     ────────────────────────────────────── */

  function _bindEvents() {
    /* Table & card event delegation */
    _delegateTableClicks();

    /* Keyboard */
    document.addEventListener('keydown', _handleKeydown);

    /* Add order */
    _el('addOrderBtn')?.addEventListener('click', () => _openOrderModal(null));
    _el('emptyAddBtn')?.addEventListener('click', () => _openOrderModal(null));

    /* Order modal */
    _el('closeOrderModal')?.addEventListener('click', _closeOrderModal);
    _el('cancelOrderModal')?.addEventListener('click', _closeOrderModal);
    _el('orderModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('orderModalOverlay')) _closeOrderModal();
    });

    /* Save order */
    _el('saveOrderBtn')?.addEventListener('click', _saveOrder);

    /* Add product row */
    _el('addProductRowBtn')?.addEventListener('click', () => _addProductRow());

    /* Shipping/discount → recalculate COD */
    ['orderShippingCompany','orderDiscount','chkFreeShipping','chkPrepaidShipping','chkPaidInAdvance']
      .forEach(id => _el(id)?.addEventListener('change', _updateCOD));

    /* Phone duplicate check */
    _el('customerPhone')?.addEventListener('input', e => _checkDuplicatePhone(e.target.value.trim()));

    /* Status modal */
    _el('closeStatusModal')?.addEventListener('click', _closeStatusModal);
    _el('cancelStatusModal')?.addEventListener('click', _closeStatusModal);
    _el('confirmStatusBtn')?.addEventListener('click', _applyStatusChange);
    _el('statusModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('statusModalOverlay')) _closeStatusModal();
    });

    /* Bulk employee modal */
    _el('closeBulkEmployeeModal')?.addEventListener('click', _closeBulkEmployeeModal);
    _el('cancelBulkEmployeeModal')?.addEventListener('click', _closeBulkEmployeeModal);
    _el('confirmBulkEmployeeBtn')?.addEventListener('click', _applyBulkEmployee);
    _el('bulkEmployeeModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('bulkEmployeeModalOverlay')) _closeBulkEmployeeModal();
    });

    /* Filters */
    _el('searchInput')?.addEventListener('input', e => { Filters.search = e.target.value; _page = 1; _scheduleRender(); });
    _el('filterEmployee')?.addEventListener('change', e => { Filters.employee = e.target.value; _page = 1; _scheduleRender(); });
    _el('filterPlatform')?.addEventListener('change', e => { Filters.platform = e.target.value; _page = 1; _scheduleRender(); });
    _el('filterGov')?.addEventListener('change',      e => { Filters.gov      = e.target.value; _page = 1; _scheduleRender(); });
    _el('filterPayment')?.addEventListener('change',  e => { Filters.payment  = e.target.value; _page = 1; _scheduleRender(); });
    _el('dateFrom')?.addEventListener('change', e => {
      const v = e.target.value;
      if (v) {
        /* Parse as local date at midnight */
        const [y, m, d] = v.split('-').map(Number);
        Filters.dateFrom = new Date(y, m - 1, d);
      } else {
        Filters.dateFrom = null;
      }
      _page = 1; _scheduleRender();
    });
    _el('dateTo')?.addEventListener('change', e => {
      const v = e.target.value;
      if (v) {
        const [y, m, d] = v.split('-').map(Number);
        Filters.dateTo = new Date(y, m - 1, d, 23, 59, 59);
      } else {
        Filters.dateTo = null;
      }
      _page = 1; _scheduleRender();
    });
    _el('resetFiltersBtn')?.addEventListener('click', () => {
      Object.assign(Filters, { search:'', status:'', employee:'', platform:'', gov:'', payment:'', dateFrom:null, dateTo:null });
      ['searchInput','filterEmployee','filterPlatform','filterGov','filterPayment','dateFrom','dateTo']
        .forEach(id => { const el = _el(id); if (el) el.value = ''; });
      _buildStatusPills();
      _page = 1; _scheduleRender();
    });

    /* Page size */
    _el('pageSizeSelect')?.addEventListener('change', e => { _pageSize = Number(e.target.value); _page = 1; _scheduleRender(); });

    /* Select all on page */
    _el('selectPageChk')?.addEventListener('change', e => {
      const filtered = _applyFilters();
      const start    = (_page - 1) * _pageSize;
      const pageRows = filtered.slice(start, start + _pageSize);
      pageRows.forEach(o => { e.target.checked ? _selectedIds.add(o.id) : _selectedIds.delete(o.id); });
      _updateBulkBar();
      _scheduleRender();
    });

    /* Bulk actions */
    _el('bulkDeleteBtn')?.addEventListener('click', () => _confirmDelete([..._selectedIds]));
    _el('bulkClearBtn')?.addEventListener('click', () => { _selectedIds.clear(); _updateBulkBar(); _scheduleRender(); });
    _el('bulkStatusBtn')?.addEventListener('click', () => {
      if (_selectedIds.size === 1) { _openStatusModal([..._selectedIds][0]); }
      else { VisionOverlays?.toast({ type: 'info', message: 'اختر طلباً واحداً لتغيير الحالة' }); }
    });
    _el('bulkEmployeeBtn')?.addEventListener('click', _openBulkEmployeeModal);

    /* Export / Import */
    _el('exportBtn')?.addEventListener('click', _exportCSV);
    _el('importBtn')?.addEventListener('click', _importOrders);

    /* Cleanup */
    window.addEventListener('beforeunload', () => _unsubs.forEach(u => { try { u(); } catch(_) {} }));
  }

  /* ──────────────────────────────────────
     INIT
     ────────────────────────────────────── */

  function _init() {
    AuthGuard.protect({
      adminOnly: false,
      onReady: user => {
        const isAdmin = window.VisionAuth?.isAdmin();
        /* Hide admin-only elements for non-admins */
        if (!isAdmin) document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
        Sidebar.init({ activePage: 'orders' });
        Topbar.init({ title: 'الطلبات والعملاء' });
        _bindEvents();
        _loadData();
      },
    });
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);
