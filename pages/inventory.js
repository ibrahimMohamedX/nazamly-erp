/**
 * pages/inventory.js — Inventory Management Controller
 *
 * Financial integrity:
 *   All prices and costs stored as integer cents (× 100).
 *   Profit = priceCents - costCents, computed on save — never stored as float.
 *
 * Collections:
 *   products          — product records
 *   product_categories — category names
 */
(function (window) {
  'use strict';

  /* ──────────────────────────────────────
     INTEGER-CENTS MATH
     ────────────────────────────────────── */

  const _toCents     = v => Math.round(parseFloat(String(v ?? 0).replace(/[^0-9.]/g, '')) * 100) || 0;
  const _fmtCents    = c => (c / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج.م';
  const _fmtCentsC   = c => {                                      /* compact — no trailing zeros */
    const v = c / 100;
    return v.toLocaleString('ar-EG', { maximumFractionDigits: v % 1 === 0 ? 0 : 2 }) + ' ج.م';
  };

  /* ──────────────────────────────────────
     STATE
     ────────────────────────────────────── */

  const Store = { products: [], categories: [] };

  const Filters = { search: '', category: 'all', stock: 'all' };

  let _page    = 1;
  const PAGE_SIZE = 30;

  let _isAdmin = false;
  const _unsubs = [];
  let _renderTimer = null;

  /* ──────────────────────────────────────
     HELPERS
     ────────────────────────────────────── */

  const _el      = id => document.getElementById(id);
  const _setText = (id, v) => { const e = _el(id); if (e) e.textContent = v; };

  function _stockStatus(product) {
    const qty   = Number(product.quantity) || 0;
    const alert = Number(product.alertThreshold) || 5;
    if (qty <= 0)     return 'out_of_stock';
    if (qty <= alert) return 'low_stock';
    return 'in_stock';
  }

  function _stockBadgeHtml(product) {
    const qty    = Number(product.quantity) || 0;
    const status = _stockStatus(product);
    const map = {
      in_stock:     { cls: 'badge-success', label: 'متوفر' },
      low_stock:    { cls: 'badge-warning', label: 'أوشك على النفاذ' },
      out_of_stock: { cls: 'badge-error',   label: 'نفذ' },
    };
    const { cls, label } = map[status];
    return `<span class="badge badge-dot ${cls}">${label}</span>`;
  }

  function _scheduleRender() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(_render, 50);
  }

  /* ──────────────────────────────────────
     FILTERING
     ────────────────────────────────────── */

  function _applyFilters() {
    const search = Filters.search.toLowerCase();
    return Store.products.filter(p => {
      if (search) {
        const hay = [p.name, p.description, p.category].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      if (Filters.category !== 'all' && p.category !== Filters.category) return false;
      if (Filters.stock    !== 'all' && _stockStatus(p) !== Filters.stock) return false;
      return true;
    });
  }

  /* ──────────────────────────────────────
     RENDER
     ────────────────────────────────────── */

  function _render() {
    const filtered = _applyFilters();
    _renderStats();
    _renderTable(filtered);
    _populateCategoryFilters();
    const skel = _el('skeletonLoader');
    if (skel) skel.classList.add('hidden');
  }

  function _renderStats() {
    /* Use integer sums throughout */
    const totalItems       = Store.products.length;
    const totalValueCents  = Store.products.reduce((s, p) =>
      s + (p.priceCents || 0) * (Number(p.quantity) || 0), 0);
    const totalProfitCents = Store.products.reduce((s, p) =>
      s + (p.profitCents || 0) * (Number(p.quantity) || 0), 0);
    const lowStock         = Store.products.filter(p =>
      _stockStatus(p) === 'low_stock' || _stockStatus(p) === 'out_of_stock').length;

    _setText('statTotalItems',   totalItems);
    _setText('statTotalValue',   _fmtCentsC(totalValueCents));
    _setText('statTotalProfit',  _fmtCentsC(totalProfitCents));
    _setText('statLowStock',     lowStock);
    _setText('countLabel',       `${_applyFilters().length} منتج`);
  }

  function _renderTable(filtered) {
    const tbody = _el('productsTableBody');
    const empty = _el('invEmpty');
    const table = _el('invTable');

    const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (_page > maxPage) _page = maxPage;
    const start = (_page - 1) * PAGE_SIZE;
    const rows  = filtered.slice(start, start + PAGE_SIZE);

    if (!rows.length) {
      if (tbody) tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      if (table) table.style.display = 'none';
      _renderPagination(0);
      return;
    }
    if (empty) empty.hidden = true;
    if (table) table.style.display = '';

    tbody.innerHTML = rows.map(p => {
      const profitCents  = p.profitCents || 0;
      const qty          = Number(p.quantity) || 0;
      const profitClass  = profitCents >= 0 ? 'text-success' : 'text-error';
      const adminCells   = _isAdmin
        ? `<td data-label="التكلفة / الربح">
             <div>${_fmtCentsC(p.costCents || 0)}</div>
             <div class="${profitClass} text-xs">${_fmtCentsC(profitCents)} ربح</div>
           </td>`
        : '<td></td>';
      const actionCell   = _isAdmin
        ? `<td data-label="إجراءات" style="text-align:center;">
             <div style="display:flex;gap:var(--space-1);justify-content:center;">
               <button class="btn btn-secondary btn-icon btn-sm" data-action="edit"   data-id="${p.id}" title="تعديل"><i class="fas fa-pen" aria-hidden="true"></i></button>
               <button class="btn btn-danger    btn-icon btn-sm" data-action="delete" data-id="${p.id}" title="حذف"><i class="fas fa-trash" aria-hidden="true"></i></button>
             </div>
           </td>`
        : '<td></td>';

      return `<tr data-id="${p.id}">
        <td data-label="المنتج">
          <div class="td-primary">${p.name || '—'}</div>
          ${p.description ? `<div class="text-xs text-muted">${p.description}</div>` : ''}
        </td>
        <td data-label="الفئة">
          <span class="badge badge-muted">${p.category || 'عام'}</span>
        </td>
        <td data-label="سعر البيع">
          <span class="font-bold">${_fmtCentsC(p.priceCents || 0)}</span>
        </td>
        ${adminCells}
        <td data-label="الكمية المتاحة" style="text-align:center;">
          <div style="display:flex;flex-direction:column;align-items:center;gap:var(--space-1);">
            <span class="font-bold" style="font-size:var(--font-size-lg);${qty<=0?'color:var(--color-error)':qty<=(p.alertThreshold||5)?'color:var(--color-warning)':'color:var(--color-text)'}">${qty}</span>
            ${_stockBadgeHtml(p)}
          </div>
        </td>
        <td data-label="المباع" style="text-align:center;">
          <span class="text-muted">${Number(p.sold) || 0}</span>
        </td>
        ${actionCell}
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'edit')   _openProductModal(btn.dataset.id);
        if (btn.dataset.action === 'delete') _deleteProduct(btn.dataset.id);
      });
    });

    _renderPagination(filtered.length);
  }

  function _renderPagination(total) {
    const bar = _el('invPagination'); if (!bar) return;
    const pages = Math.ceil(total / PAGE_SIZE) || 1;
    if (pages <= 1) { bar.innerHTML = ''; return; }
    let html = `<button class="pagination-btn" data-p="${Math.max(1,_page-1)}" ${_page<=1?'disabled':''}><i class="fas fa-chevron-right"></i></button>`;
    for (let p = 1; p <= pages; p++) {
      if (pages > 7 && Math.abs(p-_page) > 2 && p !== 1 && p !== pages) {
        if (p === 2 || p === pages-1) html += `<span class="pagination-btn" style="opacity:.4;pointer-events:none;">…</span>`;
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

  function _populateCategoryFilters() {
    /* Filter select */
    const fsel = _el('categoryFilter');
    if (fsel) {
      const cur = fsel.value;
      fsel.innerHTML = '<option value="all">كل الفئات</option>' +
        Store.categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
      if (cur && cur !== 'all') fsel.value = cur;
    }
    /* Product form select */
    const psel = _el('prodCategory');
    if (psel) {
      const cur = psel.value;
      psel.innerHTML = '<option value="">بدون فئة</option>' +
        Store.categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
      if (cur) psel.value = cur;
    }
  }

  /* ──────────────────────────────────────
     PROFIT PREVIEW
     ────────────────────────────────────── */

  function _updateProfitPreview() {
    const priceCents = _toCents(_el('prodPrice')?.value || 0);
    const costCents  = _toCents(_el('prodCost')?.value  || 0);
    const profitCents = priceCents - costCents;
    const el = _el('profitPerUnit');
    if (!el) return;
    el.textContent = _fmtCents(profitCents);
    el.style.color = profitCents >= 0 ? 'var(--color-success)' : 'var(--color-error)';
  }

  /* ──────────────────────────────────────
     PRODUCT MODAL
     ────────────────────────────────────── */

  function _openProductModal(productId) {
    _populateCategoryFilters();
    const overlay = _el('productModalOverlay'); if (!overlay) return;
    const titleEl = _el('productModalTitle');
    const iconEl  = _el('productModalIcon');
    const editId  = _el('editingProductId');

    if (productId) {
      const p = Store.products.find(x => x.id === productId); if (!p) return;
      if (titleEl) titleEl.textContent = `تعديل: ${p.name}`;
      if (iconEl)  iconEl.className = 'fas fa-pen-to-square';
      if (editId)  editId.value = productId;
      _el('prodName').value     = p.name            || '';
      _el('prodDesc').value     = p.description     || '';
      _el('prodQuantity').value = p.quantity         ?? 0;
      _el('prodPrice').value    = p.priceCents ? (p.priceCents / 100).toFixed(2) : '';
      _el('prodCost').value     = p.costCents  ? (p.costCents  / 100).toFixed(2) : '';
      _el('prodAlert').value    = p.alertThreshold   ?? 5;
      const catEl = _el('prodCategory'); if (catEl) catEl.value = p.category || '';
    } else {
      if (titleEl) titleEl.textContent = 'إضافة منتج جديد';
      if (iconEl)  iconEl.className = 'fas fa-box';
      if (editId)  editId.value = '';
      ['prodName','prodDesc','prodPrice','prodCost'].forEach(id => { const e = _el(id); if (e) e.value = ''; });
      const qEl = _el('prodQuantity'); if (qEl) qEl.value = '0';
      const aEl = _el('prodAlert');    if (aEl) aEl.value = '5';
    }

    _updateProfitPreview();
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    _el('prodName')?.focus();
  }

  function _closeProductModal() {
    _el('productModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  async function _saveProduct() {
    const name     = _el('prodName')?.value.trim();
    const editId   = _el('editingProductId')?.value || null;

    if (!name) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم المنتج' });
      _el('prodName')?.focus(); return;
    }

    const priceCents = _toCents(_el('prodPrice')?.value || 0);
    const costCents  = _toCents(_el('prodCost')?.value  || 0);

    if (priceCents <= 0) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال سعر بيع صحيح' });
      _el('prodPrice')?.focus(); return;
    }

    /* ── Usage cap check for NEW products only (Phase 4) ── */
    if (!editId) {
      var maxProducts = 200; /* sensible default */
      if (window.VisionLicensing && typeof window.VisionLicensing.getUsageCaps === 'function') {
        var caps = window.VisionLicensing.getUsageCaps();
        maxProducts = caps.maxProducts || maxProducts;
      } else if (window.VisionConfig) {
        var lic = window.VisionConfig.get('licensing');
        if (lic && lic.usageCaps && lic.usageCaps.maxProducts) {
          maxProducts = lic.usageCaps.maxProducts;
        }
      }
      if (Store.products.length >= maxProducts) {
        window.VisionOverlays?.modal({
          title: 'الحد الأقصى للمنتجات',
          body: '<div style="text-align:right;line-height:1.8;">' +
            '<p style="color:var(--color-warning);font-weight:bold;margin-bottom:8px;">' +
            '<i class="fas fa-triangle-exclamation" style="margin-left:6px;"></i>' +
            'تم الوصول للحد الأقصى لعدد المنتجات (' + maxProducts + ').</p>' +
            '<p style="color:var(--color-text-secondary);">' +
            'يرجى ترقية الاشتراك لإضافة المزيد من المنتجات. تواصل مع مالك النظام.</p>' +
            '</div>',
          buttons: [{ label: 'حسناً', value: true, primary: true }]
        });
        return;
      }
    }

    const saveBtn = _el('saveProductBtn');
    const spinner = _el('saveProductSpinner');
    const text    = _el('saveProductText');
    if (saveBtn) saveBtn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (text)    text.textContent = 'جاري الحفظ...';

    const payload = {
      name,
      description:    _el('prodDesc')?.value.trim() || '',
      category:       _el('prodCategory')?.value    || '',
      quantity:       Number(_el('prodQuantity')?.value) || 0,
      alertThreshold: Number(_el('prodAlert')?.value)    || 5,
      priceCents,
      price: priceCents / 100,
      costCents,
      cost: costCents / 100,
      profitCents: priceCents - costCents,
      profit: (priceCents - costCents) / 100,
    };

    try {
      const db = window.db;
      if (editId) {
        await firebase.firestore().collection('products').doc(editId)
          .update({ ...payload, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        window.VisionOverlays?.toast({ type: 'success', message: 'تم تحديث المنتج' });
      } else {
        payload.sold      = 0;
        payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        await firebase.firestore().collection('products').add(payload);
        window.VisionOverlays?.toast({ type: 'success', message: `تم إضافة "${name}"` });
      }
      _closeProductModal();
    } catch (err) {
      console.error('[Inventory] save product:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الحفظ' });
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (text)    text.textContent = 'حفظ المنتج';
    }
  }

  async function _deleteProduct(id) {
    const p = Store.products.find(x => x.id === id);
    const confirmed = await window.VisionOverlays?.modal({
      title: 'حذف المنتج',
      body:  `هل تريد حذف "${p?.name || 'المنتج'}"؟ لن تتأثر الطلبات الموجودة.`,
      buttons: [{ label: 'حذف', value: 'delete', primary: true }, { label: 'إلغاء', value: null }],
    });
    if (confirmed !== 'delete') return;
    try {
      await firebase.firestore().collection('products').doc(id).delete();
      window.VisionOverlays?.toast({ type: 'success', message: 'تم الحذف' });
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر الحذف' });
    }
  }

  /* ──────────────────────────────────────
     CATEGORY MODAL
     ────────────────────────────────────── */

  function _renderCategoriesList() {
    const el = _el('categoriesList'); if (!el) return;
    if (!Store.categories.length) {
      el.innerHTML = '<p class="text-sm text-muted" style="text-align:center;padding:var(--space-5);">لا توجد فئات بعد</p>';
      return;
    }
    el.innerHTML = Store.categories.map(c => `
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3);background:var(--color-surface-raised);border:1px solid var(--color-border-light);border-radius:var(--radius-md);margin-bottom:var(--space-2);">
        <span style="flex:1;font-size:var(--font-size-sm);font-weight:var(--font-weight-semibold);">${c.name}</span>
        <span class="text-xs text-muted">${Store.products.filter(p => p.category === c.name).length} منتج</span>
        <button class="btn btn-danger btn-icon btn-sm" data-action="del-cat" data-id="${c.id}" title="حذف"><i class="fas fa-xmark" aria-hidden="true"></i></button>
      </div>`).join('');

    el.querySelectorAll('[data-action="del-cat"]').forEach(btn => {
      btn.addEventListener('click', () => _deleteCategory(btn.dataset.id));
    });
  }

  function _openCategoryModal() {
    _renderCategoriesList();
    const input = _el('newCategoryInput'); if (input) input.value = '';
    _el('editingCategoryId').value = '';
    _el('categoryModalOverlay')?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function _closeCategoryModal() {
    _el('categoryModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  async function _saveCategory() {
    const name   = _el('newCategoryInput')?.value.trim();
    const editId = _el('editingCategoryId')?.value || null;
    if (!name) { window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم الفئة' }); return; }
    if (!editId && Store.categories.find(c => c.name === name)) {
      window.VisionOverlays?.toast({ type: 'warning', message: 'هذه الفئة موجودة بالفعل' }); return;
    }
    try {
      const db = window.db;
      if (editId) {
        await firebase.firestore().collection('product_categories').doc(editId).update({ name });
      } else {
        await firebase.firestore().collection('product_categories').add({
          name, order: Store.categories.length,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
      const input = _el('newCategoryInput'); if (input) input.value = '';
      _el('editingCategoryId').value = '';
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ' });
    }
  }

  async function _deleteCategory(id) {
    const cat = Store.categories.find(c => c.id === id);
    const inUse = Store.products.filter(p => p.category === cat?.name).length;
    const body  = inUse
      ? `هذه الفئة مستخدمة في ${inUse} منتج. سيتم إزالة الفئة منهم بعد الحذف.`
      : `هل تريد حذف فئة "${cat?.name}"؟`;
    const confirmed = await window.VisionOverlays?.modal({
      title: 'حذف الفئة', body,
      buttons: [{ label: 'حذف', value: 'delete', primary: true }, { label: 'إلغاء', value: null }],
    });
    if (confirmed !== 'delete') return;
    try {
      await firebase.firestore().collection('product_categories').doc(id).delete();
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر الحذف' });
    }
  }

  /* ──────────────────────────────────────
     EXCEL IMPORT
     ────────────────────────────────────── */

  async function _handleExcelImport(file) {
    const progressEl = _el('importProgress');
    if (progressEl) { progressEl.hidden = false; progressEl.textContent = 'جاري قراءة الملف...'; }

    try {
      const data  = await file.arrayBuffer();
      const wb    = XLSX.read(data, { type: 'array' });
      const ws    = wb.Sheets[wb.SheetNames[0]];
      const rows  = XLSX.utils.sheet_to_json(ws, { defval: '' });

      if (!rows.length) {
        window.VisionOverlays?.toast({ type: 'warning', message: 'الملف فارغ' }); return;
      }

      const db    = firebase.firestore();
      const batch = db.batch();
      let   count = 0;

      rows.forEach(row => {
        const name = String(row['الاسم'] || row['name'] || '').trim();
        if (!name) return;
        const priceCents = _toCents(row['السعر']  || row['price'] || 0);
        const costCents  = _toCents(row['التكلفة'] || row['cost']  || 0);
        const ref = firebase.firestore().collection('products').doc();
        batch.set(ref, {
          name,
          description:    String(row['الوصف']   || row['description'] || ''),
          category:       String(row['الفئة']   || row['category']    || ''),
          quantity:       Number(row['الكمية']   || row['quantity']    || 0),
          alertThreshold: Number(row['التنبيه'] || row['alert']       || 5),
          priceCents, price: priceCents / 100,
          costCents,  cost:  costCents  / 100,
          profitCents: priceCents - costCents,
          profit:      (priceCents - costCents) / 100,
          sold: 0,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        count++;
        /* Batch limit = 500 writes */
        if (count % 490 === 0) batch.commit();
      });

      if (progressEl) progressEl.textContent = `جاري استيراد ${count} منتج...`;
      await batch.commit();

      window.VisionOverlays?.toast({ type: 'success', message: `تم استيراد ${count} منتج بنجاح` });
      _el('importModalOverlay')?.classList.remove('active');
      document.body.style.overflow = '';
    } catch (err) {
      console.error('[Inventory] import error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر قراءة الملف. تأكد من صحة التنسيق.' });
    } finally {
      if (progressEl) progressEl.hidden = true;
      const fileInput = _el('excelFileInput'); if (fileInput) fileInput.value = '';
    }
  }

  /* ──────────────────────────────────────
     CSV EXPORT
     ────────────────────────────────────── */

  function _exportCSV() {
    const filtered = _applyFilters();
    const headers  = ['المنتج','الوصف','الفئة','سعر البيع','التكلفة','الربح','الكمية','المباع','حالة المخزون'];
    const rows     = filtered.map(p => [
      p.name || '',
      p.description || '',
      p.category || '',
      (p.priceCents  || 0) / 100,
      (p.costCents   || 0) / 100,
      (p.profitCents || 0) / 100,
      p.quantity || 0,
      p.sold || 0,
      { in_stock: 'متوفر', low_stock: 'أوشك على النفاذ', out_of_stock: 'نفذ' }[_stockStatus(p)],
    ]);
    const csv  = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url; a.download = `inventory_${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  /* ──────────────────────────────────────
     DATA LOADING
     ────────────────────────────────────── */

  function _loadData() {
    const db = window.db;
    _unsubs.push(
      firebase.firestore().collection('products').orderBy('name')
        .onSnapshot(
          snap => { Store.products = snap.docs.map(d => ({ id: d.id, ...d.data() })); _scheduleRender(); },
          err  => console.error('[Inventory] products:', err)
        )
    );
    _unsubs.push(
      firebase.firestore().collection('product_categories').orderBy('order')
        .onSnapshot(
          snap => { Store.categories = snap.docs.map(d => ({ id: d.id, ...d.data() })); _scheduleRender(); },
          err  => console.error('[Inventory] categories:', err)
        )
    );
  }

  /* ──────────────────────────────────────
     EVENT BINDINGS
     ────────────────────────────────────── */

  function _bindEvents() {
    /* Product modal */
    _el('addProductBtn')?.addEventListener('click',    () => _openProductModal(null));
    _el('emptyAddBtn')?.addEventListener('click',      () => _openProductModal(null));
    _el('closeProductModal')?.addEventListener('click',  _closeProductModal);
    _el('cancelProductModal')?.addEventListener('click', _closeProductModal);
    _el('saveProductBtn')?.addEventListener('click',     _saveProduct);
    _el('productModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('productModalOverlay')) _closeProductModal();
    });
    /* Live profit preview */
    ['prodPrice','prodCost'].forEach(id => _el(id)?.addEventListener('input', _updateProfitPreview));

    /* Category modal */
    _el('manageCategoriesBtn')?.addEventListener('click', _openCategoryModal);
    _el('closeCategoryModal')?.addEventListener('click',    _closeCategoryModal);
    _el('closeCategoryModalBtn')?.addEventListener('click', _closeCategoryModal);
    _el('saveCategoryBtn')?.addEventListener('click', _saveCategory);
    _el('newCategoryInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') _saveCategory(); });

    /* Filters */
    _el('searchInput')?.addEventListener('input',  e => { Filters.search   = e.target.value; _page = 1; _scheduleRender(); });
    _el('categoryFilter')?.addEventListener('change',e => { Filters.category = e.target.value; _page = 1; _scheduleRender(); });
    _el('stockFilter')?.addEventListener('change',  e => { Filters.stock    = e.target.value; _page = 1; _scheduleRender(); });
    _el('resetFiltersBtn')?.addEventListener('click', () => {
      Object.assign(Filters, { search: '', category: 'all', stock: 'all' });
      ['searchInput','categoryFilter','stockFilter'].forEach(id => {
        const e = _el(id); if (e) e.value = id === 'searchInput' ? '' : (id === 'categoryFilter' ? 'all' : 'all');
      });
      _page = 1; _scheduleRender();
    });

    /* Export */
    _el('exportBtn')?.addEventListener('click', _exportCSV);

    /* Import modal */
    _el('importExcelBtn')?.addEventListener('click', () => {
      _el('importModalOverlay')?.classList.add('active');
      document.body.style.overflow = 'hidden';
    });
    _el('closeImportModal')?.addEventListener('click', () => {
      _el('importModalOverlay')?.classList.remove('active');
      document.body.style.overflow = '';
    });
    _el('cancelImportModal')?.addEventListener('click', () => {
      _el('importModalOverlay')?.classList.remove('active');
      document.body.style.overflow = '';
    });
    _el('chooseFileBtn')?.addEventListener('click', () => _el('excelFileInput')?.click());
    _el('excelFileInput')?.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) _handleExcelImport(file);
    });

    window.addEventListener('beforeunload', () =>
      _unsubs.forEach(u => { try { u(); } catch (_) {} })
    );
  }

  /* ──────────────────────────────────────
     INIT
     ────────────────────────────────────── */

  function _init() {
    AuthGuard.protect({
      adminOnly: false,
      onReady: () => {
        _isAdmin = window.VisionAuth?.isAdmin() || false;

        /* Show admin-only UI elements */
        if (_isAdmin) {
          document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
        }

        Sidebar.init({ activePage: 'inventory' });
        Topbar.init({ title: 'إدارة المخزون' });
        _bindEvents();
        _loadData();
      },
    });
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);
