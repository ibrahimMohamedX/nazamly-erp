/**
 * pages/orders.js — Orders Page Controller  (Phase 2: Backend-First Rewrite)
 *
 * ════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE — read before editing
 * ════════════════════════════════════════════════════════════════════════
 *
 * NO FULL-COLLECTION READS. The `orders` collection is unbounded and
 * grows forever — it is NEVER pulled into a local array. Every list view
 * is a live Firestore query: where() + orderBy() + limit() + startAfter().
 *
 * SMALL REFERENCE COLLECTIONS (employees, statuses, platforms,
 * shippingCompanies, products) ARE loaded in full via onSnapshot. This is
 * intentional and correct — these collections are bounded by business
 * reality (a company has dozens of employees, not millions) and are used
 * only to populate <select> filters and resolve id → display-name labels.
 *
 * STATS (Total / Delivered / Cancelled / Pending / Revenue) use the
 * Firestore "Distributed Counter" pattern: a single tiny document at
 * stats/orderSummary holds running totals, updated atomically inside the
 * SAME transaction that writes/edits/deletes an order. The UI subscribes
 * to this one document via onSnapshot — real-time, and exactly ONE
 * document read regardless of how many orders exist. Aggregate sum()
 * queries were deliberately avoided here because that API surface is not
 * guaranteed available on every Firestore compat SDK version; transactions
 * and onSnapshot on a single doc are 100% stable on all versions.
 *
 * "TOTAL MATCHING RESULTS" count (for the pagination label) DOES use a
 * Firestore count() aggregate query — that API has been stable since SDK
 * 9.18.0 (this project loads 9.23.0). It is fetched ONCE per filter
 * change, never per keystroke, never per snapshot tick.
 *
 * FIRESTORE QUERY-COMBINATION RULE (this drives _buildBaseQuery below):
 * Firestore allows unlimited equality (==) filters in one query, but only
 * ONE field may have a range condition (>=, <=, <, >) and that same field
 * must be the first orderBy(). Consequences:
 *   - Searching by NAME uses a prefix-range filter on customerName, which
 *     becomes the query's one allowed range field. The date-range filter
 *     is therefore DISABLED while a name search is active (UI shows a
 *     warning). This is a genuine Firestore constraint, not a bug.
 *   - Searching by PHONE or TRACKING uses an equality filter, which frees
 *     up the date range to be used normally alongside it.
 *
 * REQUIRED FIRESTORE COMPOSITE INDEXES (Firestore will print a direct
 * "create index" console link the first time each query combination
 * runs — click it once per combination during testing. Conceptually:
 *   1. orders: status ==, employeeId ==, platform ==, governorate ==,
 *      isCOD ==, createdAt range + orderBy(createdAt desc)
 *   2. orders: status ==, employeeId ==, platform ==, governorate ==,
 *      isCOD ==, customerName range + orderBy(customerName asc)
 *
 * RECOMMENDED FIRESTORE SECURITY RULES (not enforced client-side — write
 * these in firestore.rules before going to production):
 *   - orders: allow create/update only when statusType, isCOD, and the
 *     cents fields (subTotalCents, discountCents, shippingCostCents,
 *     totalCents, costCents, profitCents) are present and
 *     totalCents == subTotalCents - discountCents + shippingCostCents.
 *   - orders: non-admin writes should be restricted to
 *     request.resource.data.employeeId == request.auth.uid if your
 *     business rules require employees to only manage their own orders.
 *   - stats/orderSummary: deny all direct client writes; only allow writes
 *     that originate from the same transaction as an orders/** write
 *     (Firestore rules can't easily express "same transaction", so in
 *     practice this means: trust the transactional logic in this file,
 *     and consider migrating counter updates to a Cloud Function trigger
 *     for a stronger guarantee once the project adds a backend).
 * ════════════════════════════════════════════════════════════════════════
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

  const STATS_DOC_PATH = 'stats/orderSummary';
  const PAGE_SIZE_DEFAULT = 25;
  const SEARCH_DEBOUNCE_MS = 400;

  /* ──────────────────────────────────────
     INTEGER-CENTS MATH
     Consistent with expenses.js / purchases.js / inventory.js
     ────────────────────────────────────── */

  const _toCents  = v => Math.round(parseFloat(String(v ?? 0).replace(/[^0-9.]/g, '')) * 100) || 0;
  const _fmtCents = c => (c / 100).toLocaleString('ar-EG', { maximumFractionDigits: c % 100 === 0 ? 0 : 2 }) + ' ج.م';

  /* ──────────────────────────────────────
     REFERENCE DATA STORE
     Small, bounded collections only.
     ────────────────────────────────────── */

  const Ref = {
    employees:         [],
    statuses:           [],
    platforms:          [],
    shippingCompanies: [],
    products:           [],
  };

  /* ──────────────────────────────────────
     QUERY / FILTER STATE
     ────────────────────────────────────── */

  const Filters = {
    searchField: 'name',   /* 'name' | 'phone' | 'tracking' */
    searchValue: '',
    status:      '',       /* exact status name, from pills */
    employeeId:  '',
    platform:    '',
    governorate: '',
    isCOD:       '',       /* '' | 'true' | 'false' */
    dateFrom:    null,
    dateTo:      null,
  };

  let _pageSize = PAGE_SIZE_DEFAULT;

  /* ──────────────────────────────────────
     PAGINATION STATE (cursor-based)
     ────────────────────────────────────── */

  let _currentPage      = 1;
  let _pageCursors       = [null];   /* _pageCursors[n] = startAfter doc for page n+1 */
  let _lastVisibleDoc    = null;
  let _lastPageWasFull   = true;     /* false => no next page exists */
  let _currentPageOrders = [];       /* only the currently-rendered page, never the full set */
  let _selected          = new Set();

  /* ──────────────────────────────────────
     EDITING STATE
     ────────────────────────────────────── */

  let _editingId      = null;
  let _editingOriginal = null;   /* snapshot of the order BEFORE edit, for stats delta */
  let _productRowIdx  = 0;

  /* Live listeners — all cleaned up on unload */
  const _unsubs = [];
  let _unsubOrdersPage = null;
  let _unsubStats      = null;

  let _searchDebounceTimer = null;

  /* ──────────────────────────────────────
     DOM HELPERS
     ────────────────────────────────────── */

  const _el      = id => document.getElementById(id);
  const _setText = (id, v) => { const e = _el(id); if (e) e.textContent = v; };
  const _setHtml = (id, v) => { const e = _el(id); if (e) e.innerHTML   = v; };

  function _fmtDate(ts) {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('ar-EG', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function _empName(id) {
    return Ref.employees.find(e => e.id === id)?.name || '—';
  }
  function _statusColor(name) {
    return Ref.statuses.find(s => s.name === name)?.color || '#64748B';
  }
  /* statusType is denormalized onto the order at write-time; this is the
     write-time lookup only — never used as a runtime query filter */
  function _lookupStatusType(statusName) {
    return Ref.statuses.find(s => s.name === statusName)?.type || 'active';
  }

  /* ──────────────────────────────────────
     QUERY BUILDER
     Encodes the Firestore single-range-field rule documented above.
     ────────────────────────────────────── */

  /** Base query: equality + (at most one) range filter + orderBy. No limit. */
  function _buildBaseQuery() {
    const db = firebase.firestore();
    let q = db.collection('orders');

    /* Equality filters — combine freely */
    if (Filters.status)      q = q.where('status',      '==', Filters.status);
    if (Filters.employeeId)  q = q.where('employeeId',  '==', Filters.employeeId);
    if (Filters.platform)    q = q.where('platform',    '==', Filters.platform);
    if (Filters.governorate) q = q.where('governorate', '==', Filters.governorate);
    if (Filters.isCOD !== '') q = q.where('isCOD', '==', Filters.isCOD === 'true');

    const isNameSearch = Filters.searchField === 'name' && Filters.searchValue;

    if (isNameSearch) {
      /* Name search consumes the ONE allowed range slot.
         Date range is intentionally skipped here — see header comment. */
      q = q.where('customerName', '>=', Filters.searchValue)
           .where('customerName', '<=', Filters.searchValue + '\uf8ff')
           .orderBy('customerName');
    } else {
      /* Equality search (phone / tracking) frees the range slot for dates */
      if (Filters.searchField === 'phone' && Filters.searchValue) {
        q = q.where('customerPhone', '==', Filters.searchValue);
      }
      if (Filters.searchField === 'tracking' && Filters.searchValue) {
        q = q.where('trackingNumber', '==', Filters.searchValue);
      }
      if (Filters.dateFrom) q = q.where('createdAt', '>=', firebase.firestore.Timestamp.fromDate(Filters.dateFrom));
      if (Filters.dateTo)   q = q.where('createdAt', '<=', firebase.firestore.Timestamp.fromDate(Filters.dateTo));
      q = q.orderBy('createdAt', 'desc');
    }

    return q;
  }

  /** Paged query: base query + limit + cursor. */
  function _buildPagedQuery(cursor) {
    let q = _buildBaseQuery().limit(_pageSize);
    if (cursor) q = q.startAfter(cursor);
    return q;
  }

  /* ──────────────────────────────────────
     TOTAL MATCHING COUNT
     One count() aggregate read per filter change — not per keystroke,
     not per onSnapshot tick. Stable API since Firestore SDK 9.18.0.
     ────────────────────────────────────── */

  async function _fetchTotalCount() {
    /* Bug fix: .count() is a Modular SDK v9 feature. The Firebase Compat SDK
       (firebase-firestore-compat.js) does NOT expose it on the Query prototype
       in all versions. We check at runtime and fall back to a capped .get()
       so the init sequence never throws regardless of SDK version.           */
    try {
      const q = _buildBaseQuery();

      if (typeof q.count === 'function') {
        /* Compat SDK >= 9.17 or Modular SDK — use the native aggregate API */
        const countSnap = await q.count().get();
        const n = countSnap.data().count;
        _setText('totalCount', Number(n).toLocaleString('ar-EG'));
      } else {
        /* Compat SDK fallback: cap at 1000 to avoid reading the full collection.
           Exceeding 1000 shows "+999" to signal "many results exist".        */
        const snap = await q.limit(1001).get();
        const display = snap.size > 1000
          ? '+999'
          : snap.size.toLocaleString('ar-EG');
        _setText('totalCount', display);
      }
    } catch (err) {
      /* Silently degrade — the count label is informational only.
         An index error here must NEVER block rendering or auth flow.         */
      console.warn('[Orders] _fetchTotalCount:', err.code || err.message);
      _setText('totalCount', '—');

      if (err.code === 'failed-precondition') {
        /* Firestore prints the direct index-creation URL to the console */
        window.VisionOverlays?.toast({
          type: 'warning',
          title: 'يتطلب إعداد فهرس',
          message: 'افتح الـ Console وانقر الرابط لإنشاء الفهرس المطلوب.',
          duration: 8000,
        });
      }
    }
  }

  /* ──────────────────────────────────────
     STATS — Distributed Counter Pattern
     Single doc, onSnapshot, real-time, O(1) reads regardless of
     collection size.
     ────────────────────────────────────── */

  function _attachStatsListener() {
    if (_unsubStats) { try { _unsubStats(); } catch (_) {} }
    _unsubStats = firebase.firestore().doc(STATS_DOC_PATH).onSnapshot(
      doc => {
        const d = doc.exists ? doc.data() : { total: 0, delivered: 0, cancelled: 0, pending: 0, totalRevenueCents: 0 };
        _setText('statTotal',     d.total     || 0);
        _setText('statDelivered', d.delivered || 0);
        _setText('statCancelled', d.cancelled || 0);
        _setText('statPending',   d.pending   || 0);
        _setText('statRevenue',   _fmtCents(d.totalRevenueCents || 0));
      },
      err => console.error('[Orders] stats listener:', err)
    );
  }

  /** Apply a delta to the bucket matching a statusType, inside an open transaction. */
  function _applyStatsDelta(tx, statsRef, statsSnap, delta) {
    const cur = statsSnap.exists ? statsSnap.data() : { total: 0, delivered: 0, cancelled: 0, pending: 0, totalRevenueCents: 0 };
    const next = {
      total:             (cur.total             || 0) + (delta.total             || 0),
      delivered:         (cur.delivered         || 0) + (delta.delivered         || 0),
      cancelled:         (cur.cancelled         || 0) + (delta.cancelled         || 0),
      pending:           (cur.pending           || 0) + (delta.pending           || 0),
      totalRevenueCents: (cur.totalRevenueCents || 0) + (delta.totalRevenueCents || 0),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    tx.set(statsRef, next, { merge: true });
  }

  /** Build a { delivered:1/0, cancelled:1/0, pending:1/0 } bucket key for a statusType. */
  function _bucketDelta(statusType, sign) {
    const d = { delivered: 0, cancelled: 0, pending: 0 };
    if (statusType === 'delivered') d.delivered = sign;
    else if (statusType === 'cancelled') d.cancelled = sign;
    else d.pending = sign;
    return d;
  }

  /* ──────────────────────────────────────
     PAGINATION CONTROL
     ────────────────────────────────────── */

  function _resetPagination() {
    _currentPage    = 1;
    _pageCursors     = [null];
    _lastVisibleDoc  = null;
    _lastPageWasFull = true;
    _selected.clear();
  }

  function _attachOrdersListener() {
    if (_unsubOrdersPage) { try { _unsubOrdersPage(); } catch (_) {} }

    const cursor = _pageCursors[_currentPage - 1];
    const query  = _buildPagedQuery(cursor);

    _unsubOrdersPage = query.onSnapshot(
      snap => {
        _currentPageOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _lastVisibleDoc     = snap.docs[snap.docs.length - 1] || null;
        _lastPageWasFull    = snap.docs.length === _pageSize;
        _renderTable(_currentPageOrders);
        _renderPaginationControls();
        const skel = _el('skeletonLoader');
        if (skel) skel.classList.add('hidden');
      },
      err => {
        console.error('[Orders] page listener error:', err);
        if (err.code === 'failed-precondition') {
          window.VisionOverlays?.toast({
            type: 'error',
            title: 'يتطلب إعداد فهرس',
            message: 'يرجى إنشاء الفهرس المطلوب من رابط الخطأ في Console.',
          });
        }
      }
    );
  }

  function _goNextPage() {
    if (!_lastPageWasFull || !_lastVisibleDoc) return;
    _pageCursors[_currentPage] = _lastVisibleDoc;
    _currentPage++;
    _attachOrdersListener();
  }

  function _goPrevPage() {
    if (_currentPage <= 1) return;
    _currentPage--;
    _attachOrdersListener();
  }

  function _onFiltersChanged() {
    _resetPagination();
    _fetchTotalCount();
    _attachOrdersListener();
    _updateBulkBar();
  }

  /* ──────────────────────────────────────
     RENDER — TABLE
     Operates strictly on _currentPageOrders (the loaded page window)
     ────────────────────────────────────── */

  function _renderTable(rows) {
    const tbody = _el('ordersTableBody');
    const empty = _el('emptyState');
    const table = _el('ordersTable');
    const isAdmin = window.VisionAuth?.isAdmin();

    _setText('shownCount', rows.length);

    if (!rows.length) {
      if (tbody) tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      if (table) table.style.display = 'none';
      return;
    }
    if (empty) empty.hidden = true;
    if (table) table.style.display = '';

    tbody.innerHTML = rows.map((o, i) => {
      const items    = o.items || [];
      const color    = _statusColor(o.status);
      const selected = _selected.has(o.id);

      const productPills = items.map(it =>
        `<span class="product-pill"><span class="product-pill-qty">${it.qty || 1}</span> ${it.name || ''}</span>`
      ).join('');

      return `<tr class="${selected ? 'selected' : ''}" data-id="${o.id}">
        <td><input type="checkbox" class="row-chk" data-id="${o.id}" ${selected ? 'checked' : ''} aria-label="تحديد الطلب" /></td>
        <td class="text-muted">${(_currentPage - 1) * _pageSize + i + 1}</td>
        <td>
          <div class="td-primary">${o.customerName || '—'}</div>
          <div class="text-xs text-muted" dir="ltr">${o.customerPhone || ''}</div>
          <div class="text-xs text-muted">${o.governorate || ''}</div>
        </td>
        <td><div class="product-pills">${productPills || '—'}</div></td>
        <td>
          <div class="td-primary font-bold">${_fmtCents(o.totalCents || 0)}</div>
          <div class="text-xs text-success">${o.profitCents ? _fmtCents(o.profitCents) : ''}</div>
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
          <div class="row-actions" style="display:flex;gap:var(--space-2);">
            <button class="btn btn-secondary btn-icon btn-sm" data-action="edit"   data-id="${o.id}" title="تعديل"><i class="fas fa-pen" aria-hidden="true"></i></button>
            <button class="btn btn-secondary btn-icon btn-sm" data-action="status" data-id="${o.id}" title="تغيير الحالة"><i class="fas fa-tags" aria-hidden="true"></i></button>
            <button class="btn btn-danger btn-icon btn-sm"    data-action="delete" data-id="${o.id}" title="حذف"><i class="fas fa-trash" aria-hidden="true"></i></button>
          </div>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action="edit"]').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); _openOrderModal(b.dataset.id); })
    );
    tbody.querySelectorAll('[data-action="status"]').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); _openStatusModal(b.dataset.id); })
    );
    tbody.querySelectorAll('[data-action="delete"]').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); _confirmDelete([b.dataset.id]); })
    );
    tbody.querySelectorAll('.row-chk').forEach(chk =>
      chk.addEventListener('change', () => {
        if (chk.checked) _selected.add(chk.dataset.id);
        else             _selected.delete(chk.dataset.id);
        _updateBulkBar();
      })
    );
  }

  /* ──────────────────────────────────────
     RENDER — PAGINATION (Prev / Next, cursor-based)
     ────────────────────────────────────── */

  function _renderPaginationControls() {
    const bar = _el('paginationBar'); if (!bar) return;
    _setText('pageNumberLabel', _currentPage);

    bar.innerHTML = `
      <button class="pagination-btn" id="prevPageBtn" ${_currentPage <= 1 ? 'disabled' : ''}>
        <i class="fas fa-chevron-right" aria-hidden="true"></i> السابق
      </button>
      <span class="pagination-btn active" style="pointer-events:none;">${_currentPage}</span>
      <button class="pagination-btn" id="nextPageBtn" ${!_lastPageWasFull ? 'disabled' : ''}>
        التالي <i class="fas fa-chevron-left" aria-hidden="true"></i>
      </button>`;

    _el('prevPageBtn')?.addEventListener('click', _goPrevPage);
    _el('nextPageBtn')?.addEventListener('click', _goNextPage);
  }

  /* ──────────────────────────────────────
     STATUS PILLS (built from the small, fully-loaded statuses collection)
     ────────────────────────────────────── */

  function _buildStatusPills() {
    const container = _el('statusPills'); if (!container) return;
    const pills = [{ name: '', label: 'الكل' }, ...Ref.statuses.map(s => ({ name: s.name, label: s.name, color: s.color }))];
    container.innerHTML = pills.map(s => `
      <button class="status-pill ${Filters.status === s.name ? 'active' : ''}"
        data-status="${s.name}"
        style="${s.color && Filters.status === s.name ? `background:${s.color};border-color:${s.color};` : s.color ? `border-color:${s.color}44;color:${s.color};` : ''}">
        ${s.label}
      </button>`).join('');
    container.querySelectorAll('.status-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        Filters.status = pill.dataset.status;
        _buildStatusPills();
        _onFiltersChanged();
      });
    });
  }

  /* ──────────────────────────────────────
     FILTER SELECTS
     ────────────────────────────────────── */

  function _populateFilters() {
    const empSel = _el('filterEmployee');
    if (empSel) empSel.innerHTML = '<option value="">كل الموظفين</option>' +
      Ref.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');

    const platSel = _el('filterPlatform');
    if (platSel) platSel.innerHTML = '<option value="">كل المنصات</option>' +
      Ref.platforms.map(p => `<option value="${p.name}">${p.name}</option>`).join('');

    const govSel = _el('filterGov');
    if (govSel) govSel.innerHTML = '<option value="">كل المحافظات</option>' +
      EGYPT_GOVERNORATES.map(g => `<option value="${g}">${g}</option>`).join('');

    _buildStatusPills();
  }

  /* ──────────────────────────────────────
     BULK SELECTION
     ────────────────────────────────────── */

  function _updateBulkBar() {
    const bar = _el('bulkBar'); if (!bar) return;
    const n = _selected.size;
    bar.classList.toggle('visible', n > 0);
    _setText('bulkCount', `${n} ${n === 1 ? 'طلب محدد' : 'طلبات محددة'}`);
  }

  /* ──────────────────────────────────────
     ORDER FORM MODAL
     ────────────────────────────────────── */

  function _populateFormSelects() {
    const statusSel = _el('orderStatus');
    if (statusSel) statusSel.innerHTML = Ref.statuses.map(s => `<option value="${s.name}">${s.name}</option>`).join('');

    const empSel = _el('orderEmployee');
    if (empSel) empSel.innerHTML = '<option value="">غير محدد</option>' +
      Ref.employees.filter(e => e.status === 'active' || !e.status).map(e => `<option value="${e.id}">${e.name}</option>`).join('');

    const platSel = _el('salesPlatform');
    if (platSel) platSel.innerHTML = '<option value="">غير محدد</option>' +
      Ref.platforms.map(p => `<option value="${p.name}">${p.name}</option>`).join('');

    const shipSel = _el('orderShippingCompany');
    if (shipSel) shipSel.innerHTML = '<option value="">بدون شركة</option>' +
      Ref.shippingCompanies.map(s => `<option value="${s.id}" data-cost="${s.costCents || 0}">${s.name}</option>`).join('');

    const govSel = _el('customerGov');
    if (govSel) govSel.innerHTML = '<option value="">اختر المحافظة</option>' +
      EGYPT_GOVERNORATES.map(g => `<option value="${g}">${g}</option>`).join('');
  }

  function _openOrderModal(orderId) {
    _editingId = orderId || null;
    _editingOriginal = null;
    _populateFormSelects();
    _clearProductRows();

    const overlay = _el('orderModalOverlay');
    const titleEl  = _el('orderModalTitle');
    const iconEl   = _el('orderModalIcon');
    if (!overlay) return;

    if (_editingId) {
      /* Editing requires the single source-of-truth doc, fetched once.
         This is a single targeted get() by ID — not a collection scan. */
      titleEl.textContent = 'تعديل الطلب';
      iconEl.className = 'fas fa-pen';
      firebase.firestore().collection('orders').doc(_editingId).get().then(doc => {
        if (!doc.exists) { _closeOrderModal(); return; }
        _editingOriginal = { id: doc.id, ...doc.data() };
        _fillOrderForm(_editingOriginal);
      });
    } else {
      titleEl.textContent = 'إضافة طلب جديد';
      iconEl.className = 'fas fa-cart-plus';
      _resetOrderForm();
      _addProductRow();
    }

    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    _el('customerName')?.focus();
  }

  function _closeOrderModal() {
    _el('orderModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
    _editingId = null;
    _editingOriginal = null;
  }

  function _resetOrderForm() {
    ['customerName','customerPhone','customerPhone2','customerAddress',
     'trackingNumber','orderNotes'].forEach(id => { const e = _el(id); if (e) e.value = ''; });
    ['chkFreeShipping','chkPrepaidShipping','chkPaidInAdvance','chkIntentConfirmed']
      .forEach(id => { const e = _el(id); if (e) e.checked = false; });
    const discount = _el('orderDiscount'); if (discount) discount.value = '0';
    const now = new Date();
    const localDT = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const dateEl = _el('orderDate'); if (dateEl) dateEl.value = localDT;
    _updateCOD();
  }

  function _fillOrderForm(order) {
    _el('editingOrderId').value   = order.id;
    _el('customerName').value     = order.customerName    || '';
    _el('customerPhone').value    = order.customerPhone   || '';
    _el('customerPhone2').value   = order.customerPhone2  || '';
    _el('customerAddress').value  = order.address          || '';
    _el('trackingNumber').value   = order.trackingNumber   || '';
    _el('orderNotes').value       = order.notes            || '';
    _el('orderDiscount').value    = ((order.discountCents || 0) / 100).toString();
    _el('chkFreeShipping').checked    = !!order.freeShipping;
    _el('chkPrepaidShipping').checked = !!order.prepaidShipping;
    _el('chkPaidInAdvance').checked   = !!order.paidInAdvance;
    _el('chkIntentConfirmed').checked = !!order.intentConfirmed;

    const setSelect = (id, val) => { const e = _el(id); if (e && val) e.value = val; };
    setSelect('customerGov',          order.governorate);
    setSelect('salesPlatform',        order.platform);
    setSelect('customerGender',       order.gender);
    setSelect('orderStatus',          order.status);
    setSelect('orderEmployee',        order.employeeId);
    setSelect('orderShippingCompany', order.shippingCompanyId);

    if (order.createdAt) {
      const d = order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
      const local = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      _el('orderDate').value = local;
    }

    (order.items || []).forEach(item => _addProductRow(item));
    if (!(order.items || []).length) _addProductRow();
    _updateCOD();
  }

  /* ──────────────────────────────────────
     PRODUCT ROWS
     ────────────────────────────────────── */

  function _clearProductRows() {
    const c = _el('productsContainer'); if (c) c.innerHTML = '';
    _productRowIdx = 0;
  }

  function _addProductRow(item) {
    const container = _el('productsContainer'); if (!container) return;
    const idx = _productRowIdx++;
    const row = document.createElement('div');
    row.className = 'product-row';
    row.dataset.idx = idx;

    const productOpts = Ref.products.map(p =>
      `<option value="${p.id}" data-price="${(p.priceCents||0)/100}" data-cost="${(p.costCents||0)/100}">${p.name}</option>`
    ).join('');

    row.innerHTML = `
      <select class="form-input prod-name" data-idx="${idx}" aria-label="المنتج">
        <option value="">اختر منتجاً</option>
        ${productOpts}
        <option value="__custom__">منتج مخصص...</option>
      </select>
      <input type="number" class="form-input prod-qty" value="${item?.qty || 1}" min="1" step="1" aria-label="الكمية" />
      <input type="number" class="form-input prod-price" value="${item ? (item.priceCents||0)/100 : ''}" min="0" step="0.5" placeholder="السعر" aria-label="السعر" />
      <input type="number" class="form-input prod-cost product-cost-col" value="${item ? (item.costCents||0)/100 : ''}" min="0" step="0.5" placeholder="التكلفة" aria-label="التكلفة" />
      <button type="button" class="product-row-remove" aria-label="حذف المنتج"><i class="fas fa-xmark" aria-hidden="true"></i></button>`;

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
    row.querySelector('.product-row-remove')?.addEventListener('click', () => { row.remove(); _updateCOD(); });

    container.appendChild(row);
    const emptyMsg = _el('productsEmpty'); if (emptyMsg) emptyMsg.hidden = true;
    _updateCOD();
  }

  function _switchToCustomInput(row, defaultName) {
    const sel = row.querySelector('.prod-name'); if (!sel) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input prod-name';
    input.placeholder = 'اسم المنتج المخصص';
    input.value = defaultName || '';
    sel.replaceWith(input);
    input.focus();
  }

  /* ──────────────────────────────────────
     COD CALCULATION (integer cents throughout)
     ────────────────────────────────────── */

  function _updateCOD() {
    const rows = document.querySelectorAll('.product-row');
    let subTotalCents = 0;
    rows.forEach(row => {
      const priceCents = _toCents(row.querySelector('.prod-price')?.value || 0);
      const qty        = Number(row.querySelector('.prod-qty')?.value) || 1;
      subTotalCents += priceCents * qty;
    });

    const discountCents = _toCents(_el('orderDiscount')?.value || 0);
    const shipSel        = _el('orderShippingCompany');
    const shipCostCents  = Number(shipSel?.selectedOptions[0]?.dataset?.cost ? _toCents(shipSel.selectedOptions[0].dataset.cost) : 0);
    const freeShip       = _el('chkFreeShipping')?.checked;
    const prepaidShip    = _el('chkPrepaidShipping')?.checked;
    const paidInAdv      = _el('chkPaidInAdvance')?.checked;

    let codCents = subTotalCents - discountCents;
    if (!freeShip && !prepaidShip) codCents += shipCostCents;
    if (paidInAdv) codCents = 0;
    codCents = Math.max(0, codCents);

    _setText('codAmount', _fmtCents(codCents));
    const breakdown = `(${_fmtCents(subTotalCents)} منتجات${discountCents?' − '+_fmtCents(discountCents)+' خصم':''}${!freeShip&&!prepaidShip&&shipCostCents?' + '+_fmtCents(shipCostCents)+' شحن':''})`;
    _setText('codBreakdown', paidInAdv ? 'الطلب مدفوع بالكامل' : breakdown);
  }

  /* ──────────────────────────────────────
     PHONE DUPLICATE CHECK
     Single equality query — not a collection scan
     ────────────────────────────────────── */

  let _phoneTimer = null;
  function _checkDuplicatePhone(phone) {
    clearTimeout(_phoneTimer);
    const warn = _el('phoneWarning');
    const text = _el('phoneWarningText');
    if (!phone || phone.length < 10 || !warn) return;
    _phoneTimer = setTimeout(async () => {
      try {
        const snap = await firebase.firestore().collection('orders')
          .where('customerPhone', '==', phone)
          .limit(5)
          .get();
        const matches = snap.docs.filter(d => d.id !== _editingId);
        if (matches.length) {
          text.textContent = `هذا الرقم موجود في ${matches.length}${matches.length===5?'+':''} طلب سابق`;
          warn.hidden = false;
        } else {
          warn.hidden = true;
        }
      } catch (err) {
        console.error('[Orders] duplicate phone check:', err);
      }
    }, 400);
  }

  /* ──────────────────────────────────────
     COLLECT ORDER DATA (integer cents + statusType + isCOD)
     ────────────────────────────────────── */

  function _collectOrderData() {
    const items = [];
    document.querySelectorAll('.product-row').forEach(row => {
      const nameEl  = row.querySelector('.prod-name');
      const name    = nameEl?.tagName === 'SELECT' ? (nameEl.selectedOptions[0]?.text || '') : (nameEl?.value || '');
      const prodId  = nameEl?.tagName === 'SELECT' && nameEl.value !== '__custom__' ? nameEl.value : null;
      const priceCents = _toCents(row.querySelector('.prod-price')?.value || 0);
      const costCents  = _toCents(row.querySelector('.prod-cost')?.value  || 0);
      const qty        = Number(row.querySelector('.prod-qty')?.value)    || 1;
      if (name && priceCents) items.push({
        productId: prodId, name, qty,
        priceCents, costCents,
        profitCents: (priceCents - costCents) * qty,
      });
    });

    const subTotalCents = items.reduce((s, i) => s + i.priceCents * i.qty, 0);
    const totalCostCents = items.reduce((s, i) => s + i.costCents  * i.qty, 0);
    const discountCents  = _toCents(_el('orderDiscount')?.value || 0);
    const shipSel        = _el('orderShippingCompany');
    const shipCostCents  = shipSel?.selectedOptions[0]?.dataset?.cost ? _toCents(shipSel.selectedOptions[0].dataset.cost) : 0;
    const freeShip       = _el('chkFreeShipping')?.checked;
    const prepaid        = _el('chkPrepaidShipping')?.checked;
    const paidAdv         = _el('chkPaidInAdvance')?.checked;

    const totalCents  = Math.max(0, subTotalCents - discountCents + (!freeShip && !prepaid ? shipCostCents : 0));
    const profitCents = totalCents - totalCostCents - shipCostCents;

    const status     = _el('orderStatus')?.value || '';
    const statusType = _lookupStatusType(status);
    /* isCOD: false only when the order is fully prepaid */
    const isCOD = !paidAdv;

    const dateEl = _el('orderDate');
    const createdAt = dateEl?.value
      ? firebase.firestore.Timestamp.fromDate(new Date(dateEl.value))
      : firebase.firestore.FieldValue.serverTimestamp();

    return {
      customerName:      _el('customerName')?.value.trim()    || '',
      customerPhone:     _el('customerPhone')?.value.trim()   || '',
      customerPhone2:    _el('customerPhone2')?.value.trim()  || '',
      address:           _el('customerAddress')?.value.trim() || '',
      governorate:       _el('customerGov')?.value            || '',
      platform:          _el('salesPlatform')?.value          || '',
      gender:            _el('customerGender')?.value         || '',
      status, statusType, isCOD,
      employeeId:        _el('orderEmployee')?.value          || '',
      shippingCompanyId: shipSel?.value                       || '',
      shippingCompanyName: shipSel?.selectedOptions[0]?.text  || '',
      trackingNumber:    _el('trackingNumber')?.value.trim()  || '',
      notes:             _el('orderNotes')?.value.trim()      || '',
      freeShipping:      !!freeShip,
      prepaidShipping:   !!prepaid,
      paidInAdvance:     !!paidAdv,
      intentConfirmed:   !!_el('chkIntentConfirmed')?.checked,
      items,
      subTotalCents, discountCents, shippingCostCents: shipCostCents,
      totalCents, costCents: totalCostCents, profitCents,
      createdAt,
    };
  }

  /* ──────────────────────────────────────
     SAVE ORDER — Transactional
     Writes the order doc AND adjusts stats/orderSummary atomically,
     so the counter document can never drift from reality.
     ────────────────────────────────────── */

  async function _saveOrder() {
    const data    = _collectOrderData();
    const saveBtn = _el('saveOrderBtn');
    const spinner = _el('saveOrderSpinner');
    const text    = _el('saveOrderText');

    if (!data.customerName || !data.customerPhone) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم ورقم هاتف العميل' });
      return;
    }
    if (!data.items.length) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إضافة منتج واحد على الأقل' });
      return;
    }

    // Quantity-inventory check: warn if ordered quantity exceeds stock (new orders only)
    if (!_editingId) {
      const lowStock = data.items
        .filter(item => item.productId)
        .map(item => {
          const prod = Ref.products.find(p => p.id === item.productId);
          const stock = (prod && prod.quantity) || 0;
          return { name: item.name, needed: item.qty, stock };
        })
        .filter(item => item.stock < item.needed);

      if (lowStock.length) {
        const msg = lowStock
          .map(i => `${i.name}: المطلوب ${i.needed} والمتوفر ${i.stock} فقط`)
          .join(' | ');
        window.VisionOverlays?.toast({
          type: 'warning',
          title: 'تحذير: الكمية غير كافية',
          message: msg,
          duration: 0,
        });
      }
    }

    if (saveBtn) saveBtn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (text)    text.textContent = 'جاري الحفظ...';

    const db = firebase.firestore();
    const statsRef = db.doc(STATS_DOC_PATH);

    try {
      if (_editingId) {
        const orderRef = db.collection('orders').doc(_editingId);

        await db.runTransaction(async tx => {
          /* ── Phase 1: ALL reads (Firestore rule) ── */
          const [orderSnap, statsSnap] = await Promise.all([tx.get(orderRef), tx.get(statsRef)]);
          if (!orderSnap.exists) throw new Error('order-not-found');
          const before = orderSnap.data();

          /* Determine which product docs we need to read before any write */
          const beforeItems = before.items || [];
          const afterItems  = data.items || [];

          const beforeMap = new Map();
          for (const it of beforeItems) { if (it.productId) beforeMap.set(it.productId, it.qty || 0); }
          const afterMap  = new Map();
          for (const it of afterItems)  { if (it.productId) afterMap.set(it.productId, it.qty || 0); }

          const allIds = new Set([...beforeMap.keys(), ...afterMap.keys()]);
          const prodSnaps = new Map(); // pid → DocumentSnapshot
          for (const pid of allIds) {
            const oldQty = beforeMap.get(pid) || 0;
            const newQty = afterMap.get(pid) || 0;
            if (newQty - oldQty === 0) continue; // no change for this product
            prodSnaps.set(pid, await tx.get(db.collection('products').doc(pid)));
          }

          /* ── Phase 2: ALL writes ── */
          tx.update(orderRef, { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

          /* Stats delta: remove old bucket/revenue, add new bucket/revenue */
          const oldBucket = _bucketDelta(before.statusType, -1);
          const newBucket = _bucketDelta(data.statusType, 1);
          const revenueDelta =
            (before.statusType === 'delivered' ? -(before.totalCents || 0) : 0) +
            (data.statusType   === 'delivered' ?  (data.totalCents   || 0) : 0);

          _applyStatsDelta(tx, statsRef, statsSnap, {
            total: 0, /* edit doesn't change total count */
            delivered: oldBucket.delivered + newBucket.delivered,
            cancelled: oldBucket.cancelled + newBucket.cancelled,
            pending:   oldBucket.pending   + newBucket.pending,
            totalRevenueCents: revenueDelta,
          });

          /* Inventory: apply computed deltas from Phase 1 snapshots */
          for (const [pid, prodSnap] of prodSnaps) {
            if (!prodSnap.exists) continue;
            const oldQty = beforeMap.get(pid) || 0;
            const newQty = afterMap.get(pid)  || 0;
            const delta  = newQty - oldQty;
            const cur     = prodSnap.data();
            tx.update(db.collection('products').doc(pid), {
              quantity: Math.max(0, (cur.quantity || 0) - delta),
              sold:     Math.max(0, (cur.sold     || 0) + delta),
            });
          }
        });

        window.VisionOverlays?.toast({ type: 'success', title: 'تم التعديل', message: 'تم تحديث بيانات الطلب بنجاح' });
      } else {
        const orderRef = db.collection('orders').doc();

        await db.runTransaction(async tx => {
          /* ── Phase 1: ALL reads (Firestore rule) ── */
          const statsSnap = await tx.get(statsRef);

          // Read all product docs before any write
          const prodSnaps = new Map(); // productId → DocumentSnapshot
          for (const item of data.items) {
            if (!item.productId) continue; // skip custom/manual entries
            prodSnaps.set(item.productId, await tx.get(db.collection('products').doc(item.productId)));
          }

          /* ── Phase 2: ALL writes ── */
          tx.set(orderRef, { ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

          const bucket = _bucketDelta(data.statusType, 1);
          _applyStatsDelta(tx, statsRef, statsSnap, {
            total: 1,
            delivered: bucket.delivered,
            cancelled: bucket.cancelled,
            pending:   bucket.pending,
            totalRevenueCents: data.statusType === 'delivered' ? (data.totalCents || 0) : 0,
          });

          /* Inventory: decrement quantity, increment sold (using pre-read snapshots) */
          for (const item of data.items) {
            if (!item.productId) continue;
            const prodSnap = prodSnaps.get(item.productId);
            if (!prodSnap || !prodSnap.exists) continue;
            const cur = prodSnap.data();
            const newQty  = Math.max(0, (cur.quantity || 0) - item.qty);
            const newSold = (cur.sold || 0) + item.qty;
            tx.update(db.collection('products').doc(item.productId), { quantity: newQty, sold: newSold });
          }
        });

        window.VisionOverlays?.toast({ type: 'success', title: 'تمت الإضافة', message: 'تم إضافة الطلب الجديد بنجاح' });
      }
      _closeOrderModal();
      _fetchTotalCount();
    } catch (err) {
      console.error('[Orders] save error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الحفظ. يرجى المحاولة مجدداً.' });
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (text)    text.textContent = 'حفظ الطلب';
    }
  }

  /* ──────────────────────────────────────
     STATUS MODAL — Transactional quick change
     ────────────────────────────────────── */

  function _openStatusModal(orderId) {
    const order = _currentPageOrders.find(o => o.id === orderId); if (!order) return;
    const overlay = _el('statusModalOverlay'); if (!overlay) return;
    _el('statusModalOrderId').value = orderId;
    _setText('statusModalOrderInfo', `تغيير حالة طلب: ${order.customerName || ''}`);
    const sel = _el('newStatusSelect');
    if (sel) sel.innerHTML = Ref.statuses.map(s =>
      `<option value="${s.name}" ${s.name === order.status ? 'selected' : ''}>${s.name}</option>`).join('');
    overlay.classList.add('vision-modal-overlay--visible');
  }

  function _closeStatusModal() {
    _el('statusModalOverlay')?.classList.remove('vision-modal-overlay--visible');
  }

  async function _applyStatusChange() {
    const orderId   = _el('statusModalOrderId')?.value; if (!orderId) return;
    const newStatus = _el('newStatusSelect')?.value;    if (!newStatus) return;
    const notes     = _el('statusNotes')?.value.trim();
    const newType   = _lookupStatusType(newStatus);

    const db = firebase.firestore();
    const orderRef = db.collection('orders').doc(orderId);
    const statsRef = db.doc(STATS_DOC_PATH);

    try {
      await db.runTransaction(async tx => {
        const [orderSnap, statsSnap] = await Promise.all([tx.get(orderRef), tx.get(statsRef)]);
        if (!orderSnap.exists) throw new Error('order-not-found');
        const before = orderSnap.data();

        const update = {
          status: newStatus,
          statusType: newType,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        if (notes) update.lastStatusNote = notes;
        tx.update(orderRef, update);

        if (before.statusType !== newType) {
          const oldBucket = _bucketDelta(before.statusType, -1);
          const newBucket = _bucketDelta(newType, 1);
          const revenueDelta =
            (before.statusType === 'delivered' ? -(before.totalCents || 0) : 0) +
            (newType            === 'delivered' ?  (before.totalCents || 0) : 0);

          _applyStatsDelta(tx, statsRef, statsSnap, {
            total: 0,
            delivered: oldBucket.delivered + newBucket.delivered,
            cancelled: oldBucket.cancelled + newBucket.cancelled,
            pending:   oldBucket.pending   + newBucket.pending,
            totalRevenueCents: revenueDelta,
          });
        }
      });

      window.VisionOverlays?.toast({ type: 'success', message: `تم تغيير الحالة إلى: ${newStatus}` });
      _closeStatusModal();
    } catch (err) {
      console.error('[Orders] status change error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر تغيير الحالة.' });
    }
  }

  /* ──────────────────────────────────────
     DELETE — Transactional
     ────────────────────────────────────── */

  async function _confirmDelete(ids) {
    if (!ids.length) return;
    const label = ids.length === 1 ? 'هذا الطلب' : `${ids.length} طلبات`;
    const confirmed = await window.VisionOverlays?.modal({
      title: 'تأكيد الحذف',
      body: `هل أنت متأكد من حذف ${label}؟ لا يمكن التراجع عن هذا الإجراء.`,
      buttons: [{ label: 'حذف', value: 'delete', primary: true }, { label: 'إلغاء', value: null }],
    });
    if (confirmed !== 'delete') return;

    const db = firebase.firestore();
    const statsRef = db.doc(STATS_DOC_PATH);

    try {
      /* Each delete is its own transaction — reads the doc to know
         which stats bucket to decrement, then deletes it atomically. */
      for (const id of ids) {
        const orderRef = db.collection('orders').doc(id);
        await db.runTransaction(async tx => {
          const [orderSnap, statsSnap] = await Promise.all([tx.get(orderRef), tx.get(statsRef)]);
          if (!orderSnap.exists) return;
          const o = orderSnap.data();
          tx.delete(orderRef);

          const bucket = _bucketDelta(o.statusType, -1);
          _applyStatsDelta(tx, statsRef, statsSnap, {
            total: -1,
            delivered: bucket.delivered,
            cancelled: bucket.cancelled,
            pending:   bucket.pending,
            totalRevenueCents: o.statusType === 'delivered' ? -(o.totalCents || 0) : 0,
          });
        });
      }
      _selected.clear();
      _updateBulkBar();
      _fetchTotalCount();
      window.VisionOverlays?.toast({ type: 'success', message: `تم حذف ${label}` });
    } catch (err) {
      console.error('[Orders] delete error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الحذف.' });
    }
  }

  /* ──────────────────────────────────────
     EXPORT — Explicit, one-time, paginated fetch
     Only runs on user click. Loops via cursor until the FILTERED
     result set is exhausted. Not a background or per-render scan.
     ────────────────────────────────────── */

  async function _exportCSV() {
    const exportBtn = _el('exportBtn');
    if (exportBtn) { exportBtn.disabled = true; exportBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> جاري التصدير...'; }

    const headers = ['رقم الطلب','العميل','الهاتف','المحافظة','المنتجات','الإجمالي','الحالة','الموظف','التاريخ','التتبع'];
    const allRows = [];
    let cursor = null;
    const BATCH = 500;

    try {
      while (true) {
        let q = _buildBaseQuery().limit(BATCH);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) break;

        snap.docs.forEach(d => {
          const o = d.data();
          allRows.push([
            d.id, o.customerName || '', o.customerPhone || '', o.governorate || '',
            (o.items || []).map(i => `${i.name} (${i.qty})`).join(' | '),
            (o.totalCents || 0) / 100, o.status || '', _empName(o.employeeId),
            _fmtDate(o.createdAt), o.trackingNumber || '',
          ]);
        });

        cursor = snap.docs[snap.docs.length - 1];
        if (snap.docs.length < BATCH) break;
      }

      const csv  = [headers, ...allRows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `orders_${Date.now()}.csv`; a.click();
      URL.revokeObjectURL(url);

      window.VisionOverlays?.toast({ type: 'success', message: `تم تصدير ${allRows.length} طلب` });
    } catch (err) {
      console.error('[Orders] export error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر التصدير' });
    } finally {
      if (exportBtn) { exportBtn.disabled = false; exportBtn.innerHTML = '<i class="fas fa-file-export"></i> تصدير'; }
    }
  }

  /* ──────────────────────────────────────
     REFERENCE DATA LOADING
     Small, bounded collections — fully loaded, real-time.
     ────────────────────────────────────── */

  function _loadReferenceData() {
    const db = firebase.firestore();

    _unsubs.push(db.collection('statuses').orderBy('order')
      .onSnapshot(s => { Ref.statuses = s.docs.map(d => ({ id: d.id, ...d.data() })); _buildStatusPills(); _populateFormSelects(); },
        err => console.error('[Orders] statuses ref:', err)));

    _unsubs.push(db.collection('employees')
      .onSnapshot(s => { Ref.employees = s.docs.map(d => ({ id: d.id, ...d.data() })); _populateFilters(); _populateFormSelects(); },
        err => console.error('[Orders] employees ref:', err)));

    _unsubs.push(db.collection('platforms').orderBy('order')
      .onSnapshot(s => { Ref.platforms = s.docs.map(d => ({ id: d.id, ...d.data() })); _populateFilters(); _populateFormSelects(); },
        err => console.error('[Orders] platforms ref:', err)));

    _unsubs.push(db.collection('shippingCompanies').orderBy('name')
      .onSnapshot(s => { Ref.shippingCompanies = s.docs.map(d => ({ id: d.id, ...d.data() })); _populateFormSelects(); },
        err => console.error('[Orders] shipping ref:', err)));

    _unsubs.push(db.collection('products').orderBy('name')
      .onSnapshot(s => { Ref.products = s.docs.map(d => ({ id: d.id, ...d.data() })); },
        err => console.error('[Orders] products ref:', err)));
  }

  /* ──────────────────────────────────────
     EVENT BINDINGS
     ────────────────────────────────────── */

  function _bindEvents() {
    _el('addOrderBtn')?.addEventListener('click', () => _openOrderModal(null));
    _el('emptyAddBtn')?.addEventListener('click', () => _openOrderModal(null));
    _el('closeOrderModal')?.addEventListener('click', _closeOrderModal);
    _el('cancelOrderModal')?.addEventListener('click', _closeOrderModal);
    _el('orderModalOverlay')?.addEventListener('click', e => { if (e.target === _el('orderModalOverlay')) _closeOrderModal(); });
    _el('saveOrderBtn')?.addEventListener('click', _saveOrder);

    _el('addProductRowBtn')?.addEventListener('click', () => _addProductRow());
    ['orderShippingCompany','orderDiscount','chkFreeShipping','chkPrepaidShipping','chkPaidInAdvance']
      .forEach(id => _el(id)?.addEventListener('change', _updateCOD));
    _el('customerPhone')?.addEventListener('input', e => _checkDuplicatePhone(e.target.value.trim()));

    _el('closeStatusModal')?.addEventListener('click', _closeStatusModal);
    _el('cancelStatusModal')?.addEventListener('click', _closeStatusModal);
    _el('confirmStatusBtn')?.addEventListener('click', _applyStatusChange);

    /* Search field + value — debounced, server-side, field-scoped */
    _el('searchField')?.addEventListener('change', e => {
      Filters.searchField = e.target.value;
      const warn = _el('searchDateConflictWarning');
      if (warn) warn.hidden = !(Filters.searchField === 'name' && Filters.searchValue);
      _onFiltersChanged();
    });
    _el('searchInput')?.addEventListener('input', e => {
      clearTimeout(_searchDebounceTimer);
      const val = e.target.value.trim();
      _searchDebounceTimer = setTimeout(() => {
        Filters.searchValue = val;
        const warn = _el('searchDateConflictWarning');
        if (warn) warn.hidden = !(Filters.searchField === 'name' && val);
        _onFiltersChanged();
      }, SEARCH_DEBOUNCE_MS);
    });

    _el('filterEmployee')?.addEventListener('change', e => { Filters.employeeId  = e.target.value; _onFiltersChanged(); });
    _el('filterPlatform')?.addEventListener('change', e => { Filters.platform    = e.target.value; _onFiltersChanged(); });
    _el('filterGov')?.addEventListener('change',      e => { Filters.governorate = e.target.value; _onFiltersChanged(); });
    _el('filterIsCOD')?.addEventListener('change',    e => { Filters.isCOD       = e.target.value; _onFiltersChanged(); });
    _el('dateFrom')?.addEventListener('change', e => { Filters.dateFrom = e.target.value ? new Date(e.target.value) : null; _onFiltersChanged(); });
    _el('dateTo')?.addEventListener('change',   e => { Filters.dateTo   = e.target.value ? new Date(e.target.value + 'T23:59:59') : null; _onFiltersChanged(); });

    _el('resetFiltersBtn')?.addEventListener('click', () => {
      Object.assign(Filters, { searchField: 'name', searchValue: '', status: '', employeeId: '', platform: '', governorate: '', isCOD: '', dateFrom: null, dateTo: null });
      ['searchInput','filterEmployee','filterPlatform','filterGov','filterIsCOD','dateFrom','dateTo']
        .forEach(id => { const e = _el(id); if (e) e.value = ''; });
      const sf = _el('searchField'); if (sf) sf.value = 'name';
      const warn = _el('searchDateConflictWarning'); if (warn) warn.hidden = true;
      _buildStatusPills();
      _onFiltersChanged();
    });

    _el('pageSizeSelect')?.addEventListener('change', e => {
      _pageSize = Number(e.target.value);
      _onFiltersChanged();
    });

    _el('selectPageChk')?.addEventListener('change', e => {
      _currentPageOrders.forEach(o => { e.target.checked ? _selected.add(o.id) : _selected.delete(o.id); });
      _renderTable(_currentPageOrders);
      _updateBulkBar();
    });

    _el('bulkDeleteBtn')?.addEventListener('click', () => _confirmDelete([..._selected]));
    _el('bulkClearBtn')?.addEventListener('click', () => { _selected.clear(); _renderTable(_currentPageOrders); _updateBulkBar(); });
    _el('bulkStatusBtn')?.addEventListener('click', () => {
      if (_selected.size === 1) _openStatusModal([..._selected][0]);
      else window.VisionOverlays?.toast({ type: 'info', message: 'اختر طلباً واحداً لتغيير الحالة' });
    });

    _el('exportBtn')?.addEventListener('click', _exportCSV);

    window.addEventListener('beforeunload', () => {
      _unsubs.forEach(u => { try { u(); } catch (_) {} });
      if (_unsubOrdersPage) { try { _unsubOrdersPage(); } catch (_) {} }
      if (_unsubStats)      { try { _unsubStats();      } catch (_) {} }
    });
  }

  /* ──────────────────────────────────────
     INIT
     ────────────────────────────────────── */

  function _init() {
    AuthGuard.protect({
      adminOnly: false,
      onReady: () => {
        const isAdmin = window.VisionAuth?.isAdmin();
        if (!isAdmin) document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');

        Sidebar.init({ activePage: 'orders' });
        Topbar.init({ title: 'الطلبات والعملاء' });
        _bindEvents();
        _loadReferenceData();
        _attachStatsListener();
        _fetchTotalCount();
        _attachOrdersListener();
      },
    });
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);
