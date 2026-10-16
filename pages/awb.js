/**
 * pages/awb.js — Shipping Label Print Controller
 * Refactored: modern UX, bug fixes, KPIs, error states, keyboard shortcuts
 */
(function (window) {
  'use strict';

  /* ── SETTINGS ── */
  const SETTINGS_KEY = 'awb_settings';

  function _loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function _saveSettings(obj) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
  }

  /* ── STATE ── */
  let _orders    = [];
  let _employees = [];
  let _statuses  = [];
  let _shipping  = [];
  let _period    = _buildPeriod('today');
  let _tab       = 'unprinted';
  let _selected  = new Set();
  let _labelSize = '100x150';
  let _page      = 1;
  let _isLoading = true;        /* start in loading state until data resolves */
  let _hasError  = false;
  const PAGE_SIZE = 50;
  let _unsubOrders = null;
  let _renderTimer = null;
  let _filtersPopulated = false;

  /* ── HELPERS ── */
  const _el      = id => document.getElementById(id);
  const _setText = (id, v) => { const e = _el(id); if (e) e.textContent = v; };

  function _fmtDate(ts) {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('ar-EG', { day: '2-digit', month: 'short' });
  }

  /* FIX (audit #33): HTML-escape user-typed values before innerHTML
     interpolation (customer name/address/notes/items are all typed by
     employees and were injected raw — stored XSS). */
  const _esc = v => String(v ?? '')
    .replace(/&/g, '&#38;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;');

  function _fmtCurrency(n) {
    return (Number(n) || 0).toLocaleString('ar-EG', { minimumFractionDigits: 0 }) + ' ج.م';
  }

  function _fmtCompact(n) {
    const num = Number(n) || 0;
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000)    return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString('ar-EG');
  }

  /* ── PERIOD ── */
  function _buildPeriod(key, from, to) {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    /* FIX (audit #29): "now"-ending periods are OPEN-ENDED — a print station
       kept open all day must see orders created after page load. */
    switch (key) {
      case 'today':     return { from: today, to: now, openEnded: true };
      case 'yesterday': {
        const y  = new Date(today); y.setDate(y.getDate() - 1);
        const ye = new Date(y);     ye.setHours(23, 59, 59, 999);
        return { from: y, to: ye };
      }
      case '7d':  return { from: new Date(today.getTime() - 6  * 86400000), to: now, openEnded: true };
      case '30d': return { from: new Date(today.getTime() - 29 * 86400000), to: now, openEnded: true };
      case 'custom': return { from: from || today, to: to || now };
      default:    return { from: today, to: now, openEnded: true };
    }
  }

  function _inPeriod(order) {
    const d = order.createdAt?.toDate ? order.createdAt.toDate()
      : (order.createdAt ? new Date(order.createdAt) : null);
    if (!d) return false;
    /* FIX (audit #29): live clock for open-ended periods. */
    const end = _period.openEnded ? new Date() : _period.to;
    return d >= _period.from && d <= end;
  }

  /* ── FILTERING ── */
  const Filters = { search: '', status: '', gov: '', shipping: '', employee: '' };

  function _applyFilters() {
    const search = Filters.search.toLowerCase();
    return _orders.filter(o => {
      if (!_inPeriod(o)) return false;
      if (_tab === 'unprinted' && o.printed)  return false;
      if (_tab === 'printed'   && !o.printed) return false;
      if (Filters.status   && o.status              !== Filters.status)   return false;
      if (Filters.gov      && o.governorate          !== Filters.gov)      return false;
      if (Filters.shipping && (o.shippingCompanyName || o.shippingCompanyId) !== Filters.shipping) return false;
      if (Filters.employee && o.employeeId           !== Filters.employee)  return false;
      if (search) {
        const hay = [o.customerName, o.customerPhone, o.trackingNumber, o.id]
          .join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }

  function _scheduleRender() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(_render, 50);
  }

  /* ── RENDER ── */
  function _render() {
    const all       = _orders.filter(_inPeriod);
    const unprinted = all.filter(o => !o.printed);
    const printed   = all.filter(o =>  o.printed);
    const filtered  = _applyFilters();

    /* KPIs */
    _setText('kpiUnprinted', _fmtCompact(unprinted.length));
    _setText('kpiPrinted',   _fmtCompact(printed.length));
    _setText('kpiTotal',     _fmtCompact(all.length));
    const totalRevenue = all.reduce((sum, o) => sum + (o.totalCents || 0), 0) / 100;
    _setText('kpiRevenue',   _fmtCompact(totalRevenue));

    /* Tab counts */
    _setText('cntUnprinted', unprinted.length);
    _setText('cntPrinted',   printed.length);
    _setText('cntAll',       all.length);
    _setText('filteredCount', filtered.length);

    /* Populate filters once */
    if (!_filtersPopulated) {
      _populateFilterSelects(all);
      _filtersPopulated = true;
    }

    _renderTable(filtered);

    const skel = _el('skeletonLoader');
    if (skel) skel.classList.add('hidden');
  }

  function _populateFilterSelects(orders) {
    const statusSel = _el('statusFilter');
    if (statusSel && statusSel.options.length <= 1) {
      const statuses = [...new Set(orders.map(o => o.status).filter(Boolean))];
      statuses.forEach(s => statusSel.add(new Option(s, s)));
    }
    const govSel = _el('govFilter');
    if (govSel && govSel.options.length <= 1) {
      const govs = [...new Set(orders.map(o => o.governorate).filter(Boolean))].sort();
      govs.forEach(g => govSel.add(new Option(g, g)));
    }
    const shipSel = _el('shippingFilter');
    if (shipSel && shipSel.options.length <= 1) {
      const companies = [...new Set(orders.map(o => o.shippingCompanyName || o.shippingCompanyId).filter(Boolean))];
      companies.forEach(c => shipSel.add(new Option(c, c)));
    }
    const empSel = _el('employeeFilter');
    if (empSel && empSel.options.length <= 1) {
      _employees.forEach(e => empSel.add(new Option(e.name, e.id)));
    }
  }

  function _renderTable(filtered) {
    const tbody   = _el('awbTableBody');
    const empty   = _el('awbEmpty');
    const error   = _el('awbError');
    const loading = _el('awbLoading');
    const table   = _el('awbTable');

    /* ────────── PANIC-ALARM STATE MACHINE ──────────
     * Exactly ONE of {loading, error, empty, data-rows}
     * must be visible at any moment.  Every branch:
     *   1. chooses the ONE element to show
     *   2. FORCE-HIDES the other three
     *   3. returns immediately
     * ──────────────────────────────────────────────── */

    /* Force-hide helpers — called from EVERY branch to
     * guarantee no overlap regardless of DOM state */
    function _showOnly(el) {
      /* blanket: hide all four candidates first */
      if (loading) { loading.hidden = true; loading.style.display = 'none'; }
      if (error)   { error.hidden   = true; error.style.display   = 'none'; }
      if (empty)   { empty.hidden   = true; empty.style.display   = 'none'; }
      if (table)   { table.style.display = 'none'; }
      if (tbody)   tbody.innerHTML = '';
      /* then unhide ONLY the chosen one */
      if (el) {
        if (el === table) { el.style.display = ''; }
        else              { el.hidden = false;  el.style.display = ''; }
      }
    }

    /* ── BRANCH 1: LOADING ── */
    if (_isLoading) {
      _showOnly(loading);
      _renderPagination(0);
      _updateSelectionUI();
      return;
    }

    /* ── BRANCH 2: ERROR ── */
    if (_hasError) {
      _showOnly(error);
      _renderPagination(0);
      _updateSelectionUI();
      return;
    }

    /* ── BRANCH 3: EMPTY ── */
    const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (_page > maxPage) _page = maxPage;
    const start   = (_page - 1) * PAGE_SIZE;
    const rows    = filtered.slice(start, start + PAGE_SIZE);

    if (!rows.length) {
      _showOnly(empty);
      _renderPagination(0);
      _updateSelectionUI();
      return;
    }

    /* ── BRANCH 4: DATA ROWS ── */
    _showOnly(table);

    tbody.innerHTML = rows.map((o, i) => {
      const sel   = _selected.has(o.id);
      const items = (o.items || []).slice(0, 2).map(it => _esc(it.name)).join('، ');
      const more  = (o.items || []).length > 2 ? ` (+${o.items.length - 2})` : '';
      return `<tr class="${sel ? 'selected' : ''}" data-id="${o.id}">
        <td style="text-align:center;">
          <input type="checkbox" class="awb-row-chk" data-id="${o.id}" ${sel ? 'checked' : ''} aria-label="تحديد الطلب ${_esc(o.customerName || '')}" />
        </td>
        <td class="text-muted" style="text-align:center;">${start + i + 1}</td>
        <td class="text-sm text-muted" style="text-align:center;">${_fmtDate(o.createdAt)}</td>
        <td>
          <div class="td-primary">${_esc(o.customerName) || '—'}</div>
          <div class="text-xs text-muted" dir="ltr">${_esc(o.customerPhone) || ''}</div>
        </td>
        <td class="text-sm text-muted" style="text-align:center;">${_esc(o.governorate) || '—'}</td>
        <td class="text-xs text-muted truncate" style="max-width:180px;" title="${items}${more}">${items}${more || '—'}</td>
        <td class="font-bold text-warning" style="text-align:center;">${_fmtCurrency((o.totalCents || 0) / 100)}</td>
        <td style="text-align:center;">
          <span class="tracking-num">${_esc(o.trackingNumber) || '—'}</span>
        </td>
        <td style="text-align:center;">
          <span class="printed-badge ${o.printed ? 'printed-yes' : 'printed-no'}">
            <i class="fas ${o.printed ? 'fa-check' : 'fa-clock'}" aria-hidden="true"></i>
            ${o.printed ? 'مطبوع' : 'لم يُطبع'}
          </span>
        </td>
      </tr>`;
    }).join('');

    /* Checkbox events */
    tbody.querySelectorAll('.awb-row-chk').forEach(chk => {
      chk.addEventListener('change', () => {
        if (chk.checked) _selected.add(chk.dataset.id);
        else             _selected.delete(chk.dataset.id);
        _updateSelectionUI();
      });
    });

    /* Row click toggles checkbox */
    tbody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', e => {
        if (e.target.closest('.awb-row-chk')) return;
        const chk = tr.querySelector('.awb-row-chk');
        if (chk) {
          chk.checked = !chk.checked;
          chk.dispatchEvent(new Event('change'));
        }
      });
    });

    _renderPagination(filtered.length);
    _updateSelectionUI();
  }

  function _renderPagination(total) {
    const bar = _el('awbPagination'); if (!bar) return;
    const pages = Math.ceil(total / PAGE_SIZE) || 1;
    if (pages <= 1) { bar.innerHTML = ''; return; }

    let html = `<button class="pagination-btn" data-p="${Math.max(1, _page - 1)}" ${_page <= 1 ? 'disabled' : ''} aria-label="الصفحة السابقة">
      <i class="fas fa-chevron-right"></i></button>`;

    for (let p = 1; p <= pages; p++) {
      if (pages > 7 && Math.abs(p - _page) > 2 && p !== 1 && p !== pages) {
        if (p === 2 || p === pages - 1) html += `<span class="pagination-btn" style="opacity:.4;pointer-events:none;cursor:default;">…</span>`;
        continue;
      }
      html += `<button class="pagination-btn ${p === _page ? 'active' : ''}" data-p="${p}" aria-label="صفحة ${p}">${p}</button>`;
    }

    html += `<button class="pagination-btn" data-p="${Math.min(pages, _page + 1)}" ${_page >= pages ? 'disabled' : ''} aria-label="الصفحة التالية">
      <i class="fas fa-chevron-left"></i></button>`;

    bar.innerHTML = html;
    bar.querySelectorAll('[data-p]').forEach(b =>
      b.addEventListener('click', () => { _page = Number(b.dataset.p); _scheduleRender(); })
    );
  }

  function _updateSelectionUI() {
    const n = _selected.size;
    _setText('selectedCount',  n);
    _setText('selectedDisplay', n);
    const printBtn = _el('printBtn'); if (printBtn) printBtn.disabled = n === 0;
    const markBtn  = _el('markPrintedBtn');   if (markBtn)  markBtn.disabled  = n === 0;
    const unmarkBtn = _el('markUnprintedBtn'); if (unmarkBtn) unmarkBtn.disabled = n === 0;
    const selectAllChk = _el('selectAllChk');
    if (selectAllChk) {
      const visible = _applyFilters().slice((_page - 1) * PAGE_SIZE, _page * PAGE_SIZE);
      selectAllChk.checked       = visible.length > 0 && visible.every(o => _selected.has(o.id));
      selectAllChk.indeterminate = !selectAllChk.checked && visible.some(o => _selected.has(o.id));
    }
  }

  /* ── MARK PRINTED / UNPRINTED ── */
  async function _markPrinted(printed) {
    const ids = [..._selected]; if (!ids.length) return;
    try {
      /* FIX (audit #34): _selected survives page navigation — large
         selections exceeded Firestore's 500-op batch limit and the whole
         commit failed. Commit in chunks of 400. */
      const CHUNK = 400;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = firebase.firestore().batch();
        ids.slice(i, i + CHUNK).forEach(id => batch.update(firebase.firestore().collection('orders').doc(id), {
          printed,
          printedAt: printed ? firebase.firestore.FieldValue.serverTimestamp() : null,
        }));
        await batch.commit();
      }
      _selected.clear();
      window.VisionOverlays?.toast({
        type: 'success',
        message: `${printed ? 'تم تمييز' : 'تم إلغاء تمييز'} ${ids.length} طلب`,
      });
    } catch (err) {
      console.error('[AWB] mark printed error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء التحديث' });
    }
  }

  /* ── LABEL HTML BUILDER ── */
  function _buildLabelHtml(order, settings, size) {
    const items    = (order.items || []).map(i => `${_esc(i.name)} (${i.qty || 1})`).join('، ');
    const cod      = _fmtCurrency((order.totalCents || 0) / 100);
    const tracking = _esc(order.trackingNumber) || '—';
    const sizeClass = `awb-${size}`;
    const logoHtml = settings.logoUrl
      ? `<img src="${settings.logoUrl}" alt="logo" style="height:20px;max-width:60px;object-fit:contain;" />`
      : '';
    const note = [order.notes, settings.defaultNote].filter(Boolean).map(_esc).join(' · ');

    return `
      <div class="awb-label ${sizeClass}">
        <div class="box-section">
          <div class="flex-row" style="align-items:center;">
            <div>
              <div class="box-header">من / FROM</div>
              <div class="box-content">
                <strong>${_esc(settings.companyName) || 'Nazamly'}</strong><br/>
                ${settings.companyPhone ? `📞 ${_esc(settings.companyPhone)}<br/>` : ''}
                ${_esc(settings.companyAddress) || ''}
              </div>
            </div>
            ${logoHtml}
          </div>
        </div>
        <div class="box-section">
          <div class="box-header">إلى / TO</div>
          <div class="box-content">
            <strong style="font-size:1.1em;">${_esc(order.customerName) || '—'}</strong><br/>
            📞 ${_esc(order.customerPhone) || '—'}
            ${order.customerPhone2 ? ` / ${_esc(order.customerPhone2)}` : ''}<br/>
            📍 ${_esc(order.governorate) || ''} — ${_esc(order.address) || ''}
          </div>
        </div>
        <div class="box-section">
          <div class="box-header">رقم التتبع / TRACKING</div>
          <div class="tracking-display">${tracking}</div>
        </div>
        <div class="box-section">
          <div class="box-header">تفاصيل الطلب</div>
          <div class="box-content">
            ${order.id ? `# ${order.id.substring(0, 8).toUpperCase()}<br/>` : ''}
            ${items || '—'}
            ${note ? `<br/><em style="font-size:0.85em;">📌 ${note}</em>` : ''}
          </div>
        </div>
        <div class="cod-box">
          <div class="cod-label">المبلغ المطلوب تحصيله / CASH ON DELIVERY</div>
          <div class="cod-amount">${cod}</div>
        </div>
      </div>`;
  }

  /* ── PRINT FLOW ── */
  function _openPrintModal() {
    const n = _selected.size;
    if (n === 0) return;

    const alreadyPrinted = [..._selected].filter(id => {
      const o = _orders.find(x => x.id === id);
      return o?.printed;
    }).length;

    const warnBox  = _el('printedWarningBox');
    const warnText = _el('printedWarningText');
    if (alreadyPrinted > 0 && warnBox && warnText) {
      warnText.textContent = `${alreadyPrinted} من الطلبات المختارة تمت طباعتها من قبل`;
      warnBox.hidden = false;
    } else if (warnBox) {
      warnBox.hidden = true;
    }

    _setText('printSelectedCount', n);
    document.querySelectorAll('.awb-size-card').forEach(c =>
      c.classList.toggle('active', c.dataset.size === _labelSize)
    );
    const confirmBtn = _el('confirmPrintBtn');
    if (confirmBtn) confirmBtn.disabled = false;

    _el('printModalOverlay')?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function _closePrintModal() {
    _el('printModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  function _executePrint() {
    const settings  = _loadSettings();
    const printArea = _el('printArea'); if (!printArea) return;
    const selected  = _orders.filter(o => _selected.has(o.id));

    printArea.innerHTML = selected
      .map(o => _buildLabelHtml(o, settings, _labelSize))
      .join('');

    _closePrintModal();

    setTimeout(() => {
      window.print();
      setTimeout(async () => {
        const unprinted = selected.filter(o => !o.printed).length;
        if (unprinted > 0) {
          const confirm = await window.VisionOverlays?.modal({
            title: 'تمييز كمطبوع',
            body:  `تم إرسال ${selected.length} بوليصة للطباعة. هل تريد تمييزها كمطبوعة؟`,
            buttons: [
              { label: 'نعم، تمييز كمطبوعة', value: 'yes', primary: true },
              { label: 'لا', value: null },
            ],
          });
          if (confirm === 'yes') await _markPrinted(true);
        }
      }, 800);
    }, 100);
  }

  /* ── SETTINGS MODAL ── */
  function _openSettingsModal() {
    const s = _loadSettings();
    const fields = {
      setCompanyName:    s.companyName    || '',
      setLogoUrl:        s.logoUrl        || '',
      setCompanyPhone:   s.companyPhone   || '',
      setCompanyAddress: s.companyAddress || '',
      setDefaultNote:    s.defaultNote    || '',
    };
    Object.entries(fields).forEach(([id, val]) => {
      const e = _el(id); if (e) e.value = val;
    });
    _el('settingsModalOverlay')?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function _closeSettingsModal() {
    _el('settingsModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  function _doSaveSettings() {
    _saveSettings({
      companyName:    (_el('setCompanyName')?.value    || '').trim(),
      logoUrl:        (_el('setLogoUrl')?.value        || '').trim(),
      companyPhone:   (_el('setCompanyPhone')?.value   || '').trim(),
      companyAddress: (_el('setCompanyAddress')?.value || '').trim(),
      defaultNote:    (_el('setDefaultNote')?.value    || '').trim(),
    });
    _closeSettingsModal();
    window.VisionOverlays?.toast({ type: 'success', message: 'تم حفظ إعدادات البوليصة' });
  }

  /* ── DATA LOADING ── */
  function _attachOrdersListener() {
    if (_unsubOrders) { try { _unsubOrders(); } catch (_) {} }
    const cutoff = new Date(Math.min(_period.from.getTime(), Date.now() - 32 * 86400000));

    _isLoading = true;
    _hasError  = false;
    _scheduleRender();

    try {
      _unsubOrders = firebase.firestore().collection('orders')
        .where('createdAt', '>=', firebase.firestore.Timestamp.fromDate(cutoff))
        .orderBy('createdAt', 'desc')
        .onSnapshot(
          snap => {
            _orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            _isLoading = false;
            _hasError  = false;
            _filtersPopulated = false;
            _scheduleRender();
          },
          err  => {
            console.error('[AWB] orders listener:', err);
            _isLoading = false;
            _hasError  = true;
            _scheduleRender();
            window.VisionOverlays?.toast({ type: 'error', message: 'فشل تحميل الطلبات' });
          }
        );
    } catch (err) {
      console.error('[AWB] _attachOrdersListener setup:', err);
      _isLoading = false;
      _hasError  = true;
      _scheduleRender();
      window.VisionOverlays?.toast({ type: 'error', message: 'فشل الاتصال بقاعدة البيانات' });
    }
  }

  function _loadStaticData() {
    try {
      Promise.all([
        firebase.firestore().collection('employees').get(),
        firebase.firestore().collection('statuses').get(),
      ]).then(([empSnap, stSnap]) => {
        _employees = empSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        _statuses  = stSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        _filtersPopulated = false;
      }).catch(err => {
        console.error('[AWB] static load:', err);
        window.VisionOverlays?.toast({ type: 'error', message: 'تعذر تحميل بيانات الموظفين والحالات' });
      });
    } catch (err) {
      console.error('[AWB] _loadStaticData setup:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء تحميل البيانات الثابتة' });
    }
  }

  /* ── KEYBOARD SHORTCUTS ── */
  function _handleKeydown(e) {
    /* Ctrl/Cmd + P → open print modal if selection exists */
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
      /* FIX (audit #35): ALWAYS intercept — with no selection the native
         print dialog printed a blank page (all UI is print-hidden). Give
         feedback instead. */
      e.preventDefault();
      const overlay = _el('printModalOverlay');
      if (overlay && !overlay.classList.contains('active') && _selected.size > 0) {
        _openPrintModal();
      } else {
        window.VisionOverlays?.toast({ type: 'info', message: 'اختر طلباً واحداً على الأقل للطباعة' });
      }
    }
    /* Escape → close any open modal */
    if (e.key === 'Escape') {
      _closePrintModal();
      _closeSettingsModal();
    }
    /* Ctrl/Cmd + A → select all visible */
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      const overlay = _el('printModalOverlay');
      const settingsOverlay = _el('settingsModalOverlay');
      if ((!overlay || !overlay.classList.contains('active')) &&
          (!settingsOverlay || !settingsOverlay.classList.contains('active'))) {
        e.preventDefault();
        const visible = _applyFilters().slice((_page - 1) * PAGE_SIZE, _page * PAGE_SIZE);
        visible.forEach(o => _selected.add(o.id));
        _updateSelectionUI();
        _scheduleRender();
      }
    }
  }

  /* ── EVENT BINDINGS ── */
  function _bindEvents() {
    /* Tabs */
    document.querySelectorAll('.awb-tab[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.awb-tab').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        _tab = btn.dataset.tab;
        _page = 1;
        _scheduleRender();
      });
    });

    /* Period chips */
    document.querySelectorAll('.awb-chip[data-period]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.awb-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const customBox = _el('customDateBox');
        if (btn.dataset.period === 'custom') {
          if (customBox) customBox.hidden = false;
          return;
        }
        if (customBox) customBox.hidden = true;
        _period = _buildPeriod(btn.dataset.period);
        _attachOrdersListener();
      });
    });

    /* Custom date */
    _el('applyCustomDate')?.addEventListener('click', () => {
      const from = _el('dateFrom')?.value;
      const to   = _el('dateTo')?.value;
      if (!from || !to) {
        window.VisionOverlays?.toast({ type: 'warning', message: 'يرجى اختيار التواريخ' });
        return;
      }
      /* FIX (audit #8): anchor to LOCAL midnight (date-only = UTC otherwise). */
      _period = _buildPeriod('custom', new Date(from + 'T00:00:00'), new Date(to + 'T23:59:59'));
      _attachOrdersListener();
    });

    /* Filters */
    _el('searchInput')?.addEventListener('input',  e => { Filters.search   = e.target.value; _page = 1; _scheduleRender(); });
    _el('statusFilter')?.addEventListener('change', e => { Filters.status   = e.target.value; _page = 1; _scheduleRender(); });
    _el('govFilter')?.addEventListener('change',    e => { Filters.gov      = e.target.value; _page = 1; _scheduleRender(); });
    _el('shippingFilter')?.addEventListener('change', e => { Filters.shipping = e.target.value; _page = 1; _scheduleRender(); });
    _el('employeeFilter')?.addEventListener('change', e => { Filters.employee = e.target.value; _page = 1; _scheduleRender(); });

    /* Select all */
    _el('selectAllChk')?.addEventListener('change', e => {
      const visible = _applyFilters().slice((_page - 1) * PAGE_SIZE, _page * PAGE_SIZE);
      visible.forEach(o => e.target.checked ? _selected.add(o.id) : _selected.delete(o.id));
      _scheduleRender();
    });

    /* Bulk mark */
    _el('markPrintedBtn')?.addEventListener('click',   () => _markPrinted(true));
    _el('markUnprintedBtn')?.addEventListener('click', () => _markPrinted(false));

    /* Print flow */
    _el('printBtn')?.addEventListener('click', _openPrintModal);
    _el('closePrintModal')?.addEventListener('click', _closePrintModal);
    _el('cancelPrintModal')?.addEventListener('click', _closePrintModal);
    _el('confirmPrintBtn')?.addEventListener('click', _executePrint);
    _el('printModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('printModalOverlay')) _closePrintModal();
    });

    /* Size card selection */
    document.querySelectorAll('.awb-size-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.awb-size-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        _labelSize = card.dataset.size;
        const confirmBtn = _el('confirmPrintBtn');
        if (confirmBtn) confirmBtn.disabled = false;
      });
    });

    /* Settings modal */
    _el('settingsBtn')?.addEventListener('click', _openSettingsModal);
    _el('closeSettingsModal')?.addEventListener('click',  _closeSettingsModal);
    _el('cancelSettingsModal')?.addEventListener('click', _closeSettingsModal);
    _el('saveSettingsBtn')?.addEventListener('click',     _doSaveSettings);
    _el('settingsModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('settingsModalOverlay')) _closeSettingsModal();
    });

    /* Retry button */
    _el('retryLoadBtn')?.addEventListener('click', () => {
      _attachOrdersListener();
    });

    /* Keyboard shortcuts */
    document.addEventListener('keydown', _handleKeydown);

    /* Cleanup on unload */
    window.addEventListener('beforeunload', () => {
      if (_unsubOrders) { try { _unsubOrders(); } catch (_) {} }
    });
  }

  /* ── INIT ── */
  function _init() {
    AuthGuard.protect({
      adminOnly: false,
      onReady: () => {
        Sidebar.init({ activePage: 'awb' });
        Topbar.init({ title: 'طباعة البوليصات' });
        _bindEvents();
        _loadStaticData();
        _attachOrdersListener();
      },
    });
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);
