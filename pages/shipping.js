/**
 * pages/shipping.js — Shipping Settings Controller
 *
 * Manages three Firestore collections live:
 *   shippingCompanies · statuses · platforms
 *
 * Financial note: all shipping costs stored as amountCents (integer).
 * COD preview uses integer math throughout.
 */
(function (window) {
  'use strict';

  /* ──────────────────────────────────────
     CONSTANTS
     ────────────────────────────────────── */

  const EGYPT_GOVERNORATES = [
    'القاهرة','الجيزة','الإسكندرية','الدقهلية','البحيرة','المنوفية',
    'القليوبية','الشرقية','الغربية','كفر الشيخ','دمياط','بورسعيد',
    'الإسماعيلية','السويس','شمال سيناء','جنوب سيناء','الأقصر','أسوان',
    'قنا','سوهاج','أسيوط','المنيا','الفيوم','بني سويف','مطروح',
    'الوادي الجديد','البحر الأحمر',
  ];

  const DEFAULT_STATUSES = [
    { name: 'طلب جديد',           type: 'active',    color: '#3B82F6', order: 1 },
    { name: 'جاري التجهيز',        type: 'active',    color: '#F59E0B', order: 2 },
    { name: 'خرج للتسليم',         type: 'active',    color: '#8B5CF6', order: 3 },
    { name: 'تم التسليم',           type: 'delivered', color: '#10B981', order: 4 },
    { name: 'محاولة تسليم',         type: 'active',    color: '#06B6D4', order: 5 },
    { name: 'مرتجع للمخزن',         type: 'cancelled', color: '#EF4444', order: 6 },
    { name: 'ملغي',                type: 'cancelled', color: '#64748B', order: 7 },
    { name: 'مفقود',              type: 'cancelled', color: '#7C3AED', order: 8 },
  ];

  const DEFAULT_PLATFORMS = [
    { name: 'فيسبوك',   color: '#1877F2', order: 1 },
    { name: 'إنستاجرام',color: '#E1306C', order: 2 },
    { name: 'تيك توك',  color: '#000000', order: 3 },
    { name: 'واتساب',   color: '#25D366', order: 4 },
    { name: 'موقع',     color: '#3B82F6', order: 5 },
    { name: 'مباشر',    color: '#64748B', order: 6 },
  ];

  /* ──────────────────────────────────────
     INTEGER-CENTS MATH
     ────────────────────────────────────── */

  const _toCents     = v => Math.round(parseFloat(String(v ?? 0).replace(/[^0-9.]/g,'')) * 100) || 0;
  const _fmtCents    = c => (c/100).toLocaleString('ar-EG',{ minimumFractionDigits:0, maximumFractionDigits:2 }) + ' ج.م';

  /* ──────────────────────────────────────
     STATE
     ────────────────────────────────────── */

  const Store = { companies: [], statuses: [], platforms: [] };
  let _companySearch = '';
  let _companyStatusFilter = '';
  const _unsubs = [];
  let _renderTimer = null;
  let _searchTimer = null;
  let _dataLoaded = { companies: false, statuses: false, platforms: false };

  /* ──────────────────────────────────────
     HELPERS
     ────────────────────────────────────── */

  const _el      = id => document.getElementById(id);
  const _setText = (id, v) => { const e = _el(id); if (e) e.textContent = v; };

  function _scheduleRender() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(_renderAll, 60);
  }

  /* Check all collections loaded */
  function _checkInitialLoad() {
    if (_dataLoaded.companies && _dataLoaded.statuses && _dataLoaded.platforms) {
      const skel = _el('skeletonLoader');
      if (skel) skel.classList.add('hidden');
    }
  }

  /* ──────────────────────────────────────
     MASTER RENDER
     ────────────────────────────────────── */

  function _renderAll() {
    _renderCompanies();
    _renderStatuses();
    _renderPlatforms();
  }

  /* ──────────────────────────────────────
     COMPANIES RENDER
     ────────────────────────────────────── */

  function _renderCompanies() {
    const grid  = _el('companiesGrid');
    const empty = _el('emptyCompanies');
    const errEl = _el('errorCompanies');
    if (!grid) return;

    const search = _companySearch.toLowerCase();
    const filtered = Store.companies.filter(c => {
      if (search && !(c.name || '').toLowerCase().includes(search)) return false;
      if (_companyStatusFilter === 'active'   && !c.active)  return false;
      if (_companyStatusFilter === 'inactive' &&  c.active)  return false;
      return true;
    });

    _setText('totalCompanies', filtered.length);
    if (!filtered.length) {
      grid.innerHTML = '';
      if (empty) empty.hidden = false;
      if (errEl) errEl.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (errEl) errEl.hidden = true;

    grid.innerHTML = filtered.map(c => {
      const costDisplay = c.costCents ? _fmtCents(c.costCents) : 'بدون تكلفة';
      return `
        <div class="company-card ${c.active ? '' : 'company-card--inactive'} ${c.isDefault ? 'company-card--default' : ''}">
          <div class="company-card-strip"></div>
          <div class="company-card-header">
            <div class="company-card-icon"><i class="fas fa-truck" aria-hidden="true"></i></div>
            <div>
              ${c.isDefault ? '<span class="default-badge"><i class="fas fa-star"></i> افتراضي</span>' : ''}
              ${!c.active   ? '<span class="badge badge-muted" style="font-size:0.6rem;">غير نشط</span>' : ''}
            </div>
          </div>
          <div class="company-name">${c.name || '—'}</div>
          <div class="company-cost">${costDisplay}</div>
          ${c.phone ? `<div class="company-phone" dir="ltr">${c.phone}</div>` : ''}
          <div class="company-tags">
            ${c.freeShipping ? '<span class="badge badge-success" style="font-size:0.6rem;">شحن مجاني</span>' : ''}
            ${/* FIX (audit #26): test the field being displayed — legacy docs having only courierFeeCents used to hide the badge */ ''}
            ${(c.courierFeeCents || c.courierFee) ? `<span class="badge badge-alert"   style="font-size:0.6rem;">عمولة: ${_fmtCents(c.courierFeeCents||0)}</span>` : ''}
          </div>
          <div class="company-actions">
            <button class="btn btn-secondary btn-icon btn-sm" data-action="edit"   data-id="${c.id}" title="تعديل"><i class="fas fa-pen" aria-hidden="true"></i></button>
            <button class="btn ${c.active ? 'btn-secondary' : 'btn-success'} btn-icon btn-sm"
              data-action="toggle" data-id="${c.id}"
              title="${c.active ? 'تعطيل' : 'تفعيل'}">
              <i class="fas ${c.active ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i>
            </button>
            <button class="btn btn-danger btn-icon btn-sm" data-action="delete" data-id="${c.id}" title="حذف"><i class="fas fa-trash" aria-hidden="true"></i></button>
          </div>
        </div>`;
    }).join('');

    /* Bind card actions */
    grid.querySelectorAll('[data-action]').forEach(btn => {
      const { action, id } = btn.dataset;
      btn.addEventListener('click', () => {
        if (action === 'edit')   _openCompanyModal(id);
        if (action === 'toggle') _toggleCompany(id);
        if (action === 'delete') _deleteCompany(id);
      });
    });
  }

  /* ──────────────────────────────────────
     STATUSES RENDER
     ────────────────────────────────────── */

  function _renderStatuses() {
    const list = _el('statusesList'); if (!list) return;
    const sorted = [...Store.statuses].sort((a, b) => (a.order || 0) - (b.order || 0));

    if (!sorted.length) {
      list.innerHTML = `<p class="text-sm text-muted" style="text-align:center;padding:var(--space-5);">لا توجد حالات بعد — انقر "إضافة حالة"</p>`;
      return;
    }

    list.innerHTML = sorted.map(s => {
      const typeLabel = { delivered: 'مسلم',      cancelled: 'ملغي / مرتجع', active: 'قيد التنفيذ' }[s.type] || s.type;
      const typeClass = { delivered: 'type-delivered', cancelled: 'type-cancelled', active: 'type-active' }[s.type] || 'type-active';
      return `
        <div class="status-item" data-id="${s.id}">
          <span class="status-drag-handle"><i class="fas fa-grip-vertical" aria-hidden="true"></i></span>
          <input type="color" class="status-color-swatch" value="${s.color || '#64748B'}"
            data-id="${s.id}" title="تغيير اللون" style="background:${s.color||'#64748B'};" />
          <span class="status-name">${s.name}</span>
          <span class="status-type-badge ${typeClass}">${typeLabel}</span>
          <div class="status-actions">
            <button class="btn btn-danger btn-icon btn-sm" data-action="del-status" data-id="${s.id}" title="حذف">
              <i class="fas fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </div>`;
    }).join('');

    /* Color picker — debounced update */
    let _colorTimer = null;
    list.querySelectorAll('.status-color-swatch').forEach(picker => {
      picker.addEventListener('input', e => {
        /* Live preview */
        picker.style.background = e.target.value;
        clearTimeout(_colorTimer);
        _colorTimer = setTimeout(async () => {
          try {
            await firebase.firestore().collection('statuses').doc(picker.dataset.id)
              .update({ color: e.target.value });
          } catch (err) { console.error('[Shipping] color update:', err); }
        }, 500);
      });
    });

    list.querySelectorAll('[data-action="del-status"]').forEach(btn => {
      btn.addEventListener('click', () => _deleteStatus(btn.dataset.id));
    });
  }

  /* ──────────────────────────────────────
     PLATFORMS RENDER
     ────────────────────────────────────── */

  function _renderPlatforms() {
    const list = _el('platformsList'); if (!list) return;
    const sorted = [...Store.platforms].sort((a, b) => (a.order||0) - (b.order||0));

    if (!sorted.length) {
      list.innerHTML = `<p class="text-sm text-muted" style="text-align:center;padding:var(--space-4);">لا توجد منصات بعد</p>`;
      return;
    }

    list.innerHTML = sorted.map(p => `
      <div class="platform-item">
        <div class="platform-color-dot" style="background:${p.color||'#64748B'};"></div>
        <span class="platform-name">${p.name}</span>
        <div class="platform-actions">
          <button class="btn btn-danger btn-icon btn-sm" data-action="del-plat" data-id="${p.id}" title="حذف">
            <i class="fas fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-action="del-plat"]').forEach(btn => {
      btn.addEventListener('click', () => _deletePlatform(btn.dataset.id));
    });
  }

  /* ──────────────────────────────────────
     COMPANY MODAL
     ────────────────────────────────────── */

  function _buildPricingGrid(existingPricing) {
    const grid = _el('pricingGrid'); if (!grid) return;
    grid.innerHTML = EGYPT_GOVERNORATES.map(gov => {
      const existing = existingPricing?.[gov];
      const displayVal = existing ? (existing / 100).toFixed(0) : '';
      return `
        <div class="pricing-row">
          <span class="pricing-gov-name">${gov}</span>
          <input type="number" class="pricing-input"
            data-gov="${gov}" value="${displayVal}"
            min="0" step="1" placeholder="افتراضي" aria-label="${gov}" />
        </div>`;
    }).join('');
  }

  function _openCompanyModal(companyId) {
    const overlay = _el('companyModalOverlay'); if (!overlay) return;
    const titleEl = _el('companyModalTitle');
    const editId  = _el('editingCompanyId');

    /* Switch to basics tab */
    _switchCompanyTab('basics');

    if (companyId) {
      const c = Store.companies.find(x => x.id === companyId); if (!c) return;
      if (titleEl) titleEl.textContent = `تعديل: ${c.name}`;
      if (editId)  editId.value = companyId;
      _el('companyName').value    = c.name    || '';
      _el('companyPhone').value   = c.phone   || '';
      _el('companyCost').value    = c.costCents ? (c.costCents/100).toFixed(0) : '';
      _el('companyNotes').value   = c.notes   || '';
      _el('companyActive').checked     = c.active !== false;
      _el('companyIsDefault').checked  = !!c.isDefault;
      _el('companyFreeShipping').checked = !!c.freeShipping;
      _el('courierFee').value          = c.courierFeeCents ? (c.courierFeeCents/100).toFixed(0) : '0';
      _el('courierFeeApplies').value   = c.courierFeeApplies || 'never';
      _el('floorCOD').checked          = c.floorCOD !== false;
      _buildPricingGrid(c.pricing || {});
    } else {
      if (titleEl) titleEl.textContent = 'إضافة شركة شحن';
      if (editId)  editId.value = '';
      ['companyName','companyPhone','companyCost','companyNotes'].forEach(id => {
        const e = _el(id); if (e) e.value = '';
      });
      _el('companyActive').checked      = true;
      _el('companyIsDefault').checked   = false;
      _el('companyFreeShipping').checked= false;
      _el('courierFee').value           = '0';
      _el('courierFeeApplies').value    = 'never';
      _el('floorCOD').checked           = true;
      _buildPricingGrid({});
    }

    /* Clear validation state */
    _el('companyName')?.classList.remove('form-input--error');

    _updateCODPreview();
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    /* Delayed focus for animation */
    requestAnimationFrame(() => _el('companyName')?.focus());
  }

  function _closeCompanyModal() {
    const overlay = _el('companyModalOverlay');
    if (!overlay || !overlay.classList.contains('active')) return;
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  function _switchCompanyTab(tabKey) {
    document.querySelectorAll('.company-modal-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.ctab === tabKey)
    );
    document.querySelectorAll('.company-tab-panel').forEach(p =>
      p.classList.toggle('active', p.dataset.cpanel === tabKey)
    );
  }

  /* Collect per-gov pricing as integers */
  function _collectPricing() {
    const pricing = {};
    document.querySelectorAll('.pricing-input').forEach(input => {
      const val = _toCents(input.value);
      if (val > 0) pricing[input.dataset.gov] = val;
    });
    return pricing;
  }

  async function _saveCompany() {
    const nameEl = _el('companyName');
    const name        = nameEl?.value.trim();
    const editId      = _el('editingCompanyId')?.value || null;

    /* Validate with visual feedback */
    if (!name) {
      nameEl?.classList.add('form-input--error');
      nameEl?.focus();
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم الشركة' });
      return;
    }
    nameEl?.classList.remove('form-input--error');

    const costCents        = _toCents(_el('companyCost')?.value || 0);
    const courierFeeCents  = _toCents(_el('courierFee')?.value  || 0);
    const isDefault        = _el('companyIsDefault')?.checked || false;

    /* Loading state */
    const saveBtn = _el('saveCompanyBtn');
    const spinner = _el('saveCompanySpinner');
    const text    = _el('saveCompanyText');
    if (saveBtn) saveBtn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (text)    text.textContent = 'جاري الحفظ...';

    const payload = {
      name,
      phone:             _el('companyPhone')?.value.trim()       || '',
      notes:             _el('companyNotes')?.value.trim()       || '',
      costCents,
      cost: costCents / 100,
      active:            _el('companyActive')?.checked    ?? true,
      isDefault,
      freeShipping:      _el('companyFreeShipping')?.checked || false,
      courierFeeCents,
      courierFee: courierFeeCents / 100,
      courierFeeApplies: _el('courierFeeApplies')?.value || 'never',
      floorCOD:          _el('floorCOD')?.checked ?? true,
      pricing:           _collectPricing(),
    };

    try {
      const db = firebase.firestore();

      /* FIX (audit #27): save the company FIRST, then unset other defaults —
         the old order cleared the flag from everyone and THEN saved, so a
         failed save left the system with NO default company at all. */
      if (editId) {
        await db.collection('shippingCompanies').doc(editId).update({ ...payload, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      } else {
        payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection('shippingCompanies').add(payload);
      }

      if (isDefault) {
        const batch = db.batch();
        Store.companies.forEach(c => {
          if (c.isDefault && c.id !== editId) {
            batch.update(db.collection('shippingCompanies').doc(c.id), { isDefault: false });
          }
        });
        await batch.commit();
      }

      window.VisionOverlays?.toast({ type: 'success', message: `تم حفظ "${name}"` });
      _closeCompanyModal();
    } catch (err) {
      console.error('[Shipping] save company:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الحفظ' });
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (text)    text.textContent = 'حفظ الشركة';
    }
  }

  async function _toggleCompany(id) {
    const c = Store.companies.find(x => x.id === id); if (!c) return;
    try {
      await firebase.firestore().collection('shippingCompanies').doc(id)
        .update({ active: !c.active });
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر التحديث' });
    }
  }

  async function _deleteCompany(id) {
    const confirmed = await window.VisionOverlays?.modal({
      title: 'حذف شركة الشحن',
      body:  'هل تريد حذف هذه الشركة؟ لن تؤثر على الطلبات الموجودة.',
      buttons: [{ label: 'حذف', value: 'delete', primary: true }, { label: 'إلغاء', value: null }],
    });
    if (confirmed !== 'delete') return;
    try {
      await firebase.firestore().collection('shippingCompanies').doc(id).delete();
      window.VisionOverlays?.toast({ type: 'success', message: 'تم الحذف' });
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر الحذف' });
    }
  }

  /* ──────────────────────────────────────
     COD PREVIEW CALCULATOR
     ────────────────────────────────────── */

  function _updateCODPreview() {
    const sampleProductsCents = 35000;
    const sampleShippingCents = 5500;
    const feeApplies   = _el('courierFeeApplies')?.value || 'never';
    const feeCents     = _toCents(_el('courierFee')?.value || 0);
    const floor        = _el('floorCOD')?.checked;
    const feeRow       = _el('previewFeeRow');
    const feeVal       = _el('previewFeeVal');
    const codEl        = _el('previewCOD');

    let codCents = sampleProductsCents + sampleShippingCents;
    const addFee = feeApplies === 'always' || feeApplies === 'cod';
    if (addFee) codCents += feeCents;
    if (floor)  codCents = Math.floor(codCents / 100) * 100;

    if (feeRow) feeRow.hidden = !addFee || feeCents === 0;
    if (feeVal) feeVal.textContent = `+ ${_fmtCents(feeCents)}`;
    if (codEl)  codEl.textContent  = _fmtCents(codCents);
  }

  /* ──────────────────────────────────────
     STATUSES CRUD
     ────────────────────────────────────── */

  async function _saveNewStatus() {
    const nameInput = _el('newStatusName');
    const name  = nameInput?.value.trim();
    const type  = _el('newStatusType')?.value  || 'active';
    const color = _el('newStatusColor')?.value || '#64748B';
    if (!name) {
      nameInput?.classList.add('form-input--error');
      nameInput?.focus();
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم الحالة' });
      return;
    }
    nameInput?.classList.remove('form-input--error');
    try {
      await firebase.firestore().collection('statuses').add({
        name, type, color,
        order: Store.statuses.length + 1,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      if (nameInput) nameInput.value = '';
      _el('newStatusColor') && (_el('newStatusColor').value = '#F59E0B');
      _el('addStatusForm').hidden = true;
    } catch (err) {
      console.error('[Shipping] add status:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ' });
    }
  }

  async function _deleteStatus(id) {
    const confirmed = await window.VisionOverlays?.modal({
      title: 'حذف الحالة',
      body:  'هل تريد حذف هذه الحالة؟ الطلبات التي تستخدمها لن تتأثر.',
      buttons: [{ label: 'حذف', value: 'delete', primary: true }, { label: 'إلغاء', value: null }],
    });
    if (confirmed !== 'delete') return;
    try {
      await firebase.firestore().collection('statuses').doc(id).delete();
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر الحذف' });
    }
  }

  /* ──────────────────────────────────────
     PLATFORMS CRUD
     ────────────────────────────────────── */

  async function _addPlatform() {
    const nameInput = _el('newPlatformName');
    const name  = nameInput?.value.trim();
    const color = _el('newPlatformColor')?.value || '#64748B';
    if (!name) {
      nameInput?.classList.add('form-input--error');
      nameInput?.focus();
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم المنصة' });
      return;
    }
    nameInput?.classList.remove('form-input--error');
    try {
      await firebase.firestore().collection('platforms').add({
        name, color,
        order: Store.platforms.length + 1,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      if (nameInput) nameInput.value = '';
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ' });
    }
  }

  async function _deletePlatform(id) {
    const confirmed = await window.VisionOverlays?.modal({
      title: 'حذف المنصة', body: 'هل تريد حذف هذه المنصة؟',
      buttons: [{ label: 'حذف', value: 'delete', primary: true }, { label: 'إلغاء', value: null }],
    });
    if (confirmed !== 'delete') return;
    try { await firebase.firestore().collection('platforms').doc(id).delete(); }
    catch (err) { window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر الحذف' }); }
  }

  /* ──────────────────────────────────────
     DATA SEEDING (first-run)
     ────────────────────────────────────── */

  async function _seedIfEmpty(db) {
    const [stSnap, plSnap] = await Promise.all([
      db.collection('statuses').limit(1).get(),
      db.collection('platforms').limit(1).get(),
    ]);

    const batchSt = db.batch();
    if (stSnap.empty) {
      DEFAULT_STATUSES.forEach(s => batchSt.set(db.collection('statuses').doc(), {
        ...s, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      }));
      await batchSt.commit();
    }

    const batchPl = db.batch();
    if (plSnap.empty) {
      DEFAULT_PLATFORMS.forEach(p => batchPl.set(db.collection('platforms').doc(), {
        ...p, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      }));
      await batchPl.commit();
    }
  }

  /* ──────────────────────────────────────
     DATA LOADING
     ────────────────────────────────────── */

  function _loadData() {
    const db = firebase.firestore();
    _unsubs.push(
      db.collection('shippingCompanies').orderBy('name')
        .onSnapshot(s => {
          Store.companies = s.docs.map(d => ({ id: d.id, ...d.data() }));
          _dataLoaded.companies = true;
          _checkInitialLoad();
          _scheduleRender();
        }, err => {
          console.error('[Shipping] companies:', err);
          _dataLoaded.companies = true;
          _checkInitialLoad();
          const errEl = _el('errorCompanies');
          if (errEl) errEl.hidden = false;
        })
    );
    _unsubs.push(
      db.collection('statuses').orderBy('order')
        .onSnapshot(s => {
          Store.statuses = s.docs.map(d => ({ id: d.id, ...d.data() }));
          _dataLoaded.statuses = true;
          _checkInitialLoad();
          _scheduleRender();
        }, err => console.error('[Shipping] statuses:', err))
    );
    _unsubs.push(
      db.collection('platforms').orderBy('order')
        .onSnapshot(s => {
          Store.platforms = s.docs.map(d => ({ id: d.id, ...d.data() }));
          _dataLoaded.platforms = true;
          _checkInitialLoad();
          _scheduleRender();
        }, err => console.error('[Shipping] platforms:', err))
    );
    _seedIfEmpty(db).catch(err => console.warn('[Shipping] seed skipped:', err));
  }

  /* ──────────────────────────────────────
     EVENT BINDINGS
     ────────────────────────────────────── */

  function _bindEvents() {
    /* Company modal open/close */
    _el('addCompanyBtn')?.addEventListener('click',     () => _openCompanyModal(null));
    _el('closeCompanyModal')?.addEventListener('click',  _closeCompanyModal);
    _el('cancelCompanyModal')?.addEventListener('click', _closeCompanyModal);
    _el('saveCompanyBtn')?.addEventListener('click',     _saveCompany);

    /* Backdrop click to close */
    _el('companyModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('companyModalOverlay')) _closeCompanyModal();
    });

    /* Escape key to close modal */
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') _closeCompanyModal();
    });

    /* Modal inner tabs */
    document.querySelectorAll('.company-modal-tab[data-ctab]').forEach(btn => {
      btn.addEventListener('click', () => _switchCompanyTab(btn.dataset.ctab));
    });

    /* COD preview live update */
    ['courierFee','courierFeeApplies','floorCOD'].forEach(id => {
      _el(id)?.addEventListener('input',  _updateCODPreview);
      _el(id)?.addEventListener('change', _updateCODPreview);
    });

    /* Clear validation on input */
    _el('companyName')?.addEventListener('input', function() {
      this.classList.remove('form-input--error');
    });
    _el('newStatusName')?.addEventListener('input', function() {
      this.classList.remove('form-input--error');
    });
    _el('newPlatformName')?.addEventListener('input', function() {
      this.classList.remove('form-input--error');
    });

    /* Company search — debounced */
    _el('searchCompanies')?.addEventListener('input', e => {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => {
        _companySearch = e.target.value;
        _renderCompanies();
      }, 180);
    });

    /* Company status filter — immediate */
    _el('filterCompanyStatus')?.addEventListener('change', e => {
      _companyStatusFilter = e.target.value;
      _renderCompanies();
    });

    /* Status section */
    _el('addStatusBtn')?.addEventListener('click', () => {
      const form = _el('addStatusForm');
      if (form) {
        const wasHidden = form.hidden;
        form.hidden = !wasHidden;
        if (wasHidden) {
          _el('newStatusName')?.focus();
          _el('newStatusName')?.classList.remove('form-input--error');
        }
      }
    });
    _el('saveNewStatusBtn')?.addEventListener('click', _saveNewStatus);
    _el('cancelAddStatusBtn')?.addEventListener('click', () => {
      _el('addStatusForm').hidden = true;
      _el('newStatusName')?.classList.remove('form-input--error');
    });
    _el('newStatusName')?.addEventListener('keydown', e => { if (e.key === 'Enter') _saveNewStatus(); });

    /* Platforms section */
    _el('addPlatformBtn')?.addEventListener('click', _addPlatform);
    _el('newPlatformName')?.addEventListener('keydown', e => { if (e.key === 'Enter') _addPlatform(); });

    /* Cleanup on unload */
    window.addEventListener('beforeunload', () => _unsubs.forEach(u => { try { u(); } catch (_) {} }));
  }

  /* ──────────────────────────────────────
     INIT
     ────────────────────────────────────── */

  function _init() {
    AuthGuard.protect({
      adminOnly: true,
      onReady: () => {
        Sidebar.init({ activePage: 'shipping' });
        Topbar.init({ title: 'إعدادات الشحن' });
        _bindEvents();
        _loadData();
      },
    });
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);