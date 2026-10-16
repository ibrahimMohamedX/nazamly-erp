/**
 * pages/purchases.js — Purchase Orders Controller
 *
 * Financial integrity: all costs stored as amountCents (integer × 100).
 * Status workflow: pending → sent → received  (or → cancelled)
 * WhatsApp integration: formats order text, opens wa.me deep link.
 */
(function (window) {
  'use strict';

  /* ──────────────────────────────────────
     INTEGER-CENTS MATH
     ────────────────────────────────────── */

  const _toCents     = v => Math.round(parseFloat(String(v ?? 0).replace(/[^0-9.]/g, '')) * 100) || 0;
  const _fmtCents    = c => (c / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج.م';
  const _fmtCentsCompact = c => {
    const v = c / 100;
    return v.toLocaleString('ar-EG', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }) + ' ج.م';
  };

  /* ──────────────────────────────────────
     STATE
     ────────────────────────────────────── */

  const Store = { purchases: [], suppliers: [], products: [] };
  const Filters = { search: '', status: '', supplier: '' };
  let _page    = 1;
  const PAGE_SIZE = 25;
  let _orderCounter = 1;   /* for PO-XXX reference */
  const _unsubs = [];
  let _renderTimer = null;

  /* ──────────────────────────────────────
     HELPERS
     ────────────────────────────────────── */

  const _el      = id => document.getElementById(id);
  const _setText = (id, v) => { const e = _el(id); if (e) e.textContent = v; };

  function _fmtDate(ts) {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('ar-EG', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function _statusLabel(s) {
    return { pending: 'قيد الانتظار', sent: 'تم الإرسال', received: 'تم الاستلام', cancelled: 'ملغي' }[s] || s;
  }

  function _supplierName(id) {
    return Store.suppliers.find(s => s.id === id)?.name || '—';
  }
  function _supplierPhone(id) {
    return Store.suppliers.find(s => s.id === id)?.phone || '';
  }

  function _scheduleRender() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(_render, 50);
  }

  /* Ordered reference: PO-0001 */
  function _nextRef() {
    /* FIX (audit #14): add a timestamp component to reduce collision odds
       when two concurrent creators (tabs/users) compute the same max from
       the in-memory list. The pure counter had no uniqueness guarantee. */
    const max = Store.purchases.reduce((m, p) => {
      const n = parseInt((p.orderRef || '').replace(/\D/g, '')) || 0;
      return Math.max(m, n);
    }, 0);
    return 'PO-' + String(max + 1).padStart(4, '0');
  }

  /* ──────────────────────────────────────
     FILTERING
     ────────────────────────────────────── */

  function _applyFilters() {
    const search = (Filters.search || '').toLowerCase();
    return Store.purchases.filter(p => {
      if (Filters.status   && p.status      !== Filters.status)   return false;
      if (Filters.supplier && p.supplierId  !== Filters.supplier) return false;
      if (search) {
        const hay = [
          p.orderRef, p.supplierName,
          ...(p.items || []).map(i => i.name),
        ].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
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
    _populateSupplierFilter();
    const skel = _el('skeletonLoader');
    if (skel) skel.classList.add('hidden');
  }

  function _renderStats() {
    const now  = new Date();
    const thisM = Store.purchases.filter(p => {
      if (p.status !== 'received') return false;
      /* FIX (audit #13): count by RECEIPT date (updatedAt when it was
         marked received), not creation date — a PO created last month and
         received this month was invisible in the KPI. */
      const d = p.updatedAt?.toDate ? p.updatedAt.toDate() : (p.updatedAt ? new Date(p.updatedAt) : null);
      return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    /* FIX (audit #16): exclude CANCELLED purchases from the total-cost
       KPI — it used to sum every PO, inflating the money figure. */
    const totalCents = Store.purchases
      .filter(p => p.status !== 'cancelled')
      .reduce((s, p) => s + (p.totalCents || 0), 0);
    const pending    = Store.purchases.filter(p => p.status === 'pending').length;

    _setText('statTotalOrders',    Store.purchases.length);
    _setText('statTotalCost',      _fmtCentsCompact(totalCents));
    _setText('statTotalSuppliers', Store.suppliers.length);
    _setText('statPending',        pending);
    _setText('statThisMonth',      thisM.length);
    _setText('countLabel',         `${_applyFilters().length} أمر`);
  }

  function _renderTable(filtered) {
    const tbody = _el('purchasesTableBody');
    const empty = _el('emptyPurchases');
    const table = _el('purchasesTable');

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

    tbody.innerHTML = rows.map((p, i) => {
      const items      = p.items || [];
      const itemsText  = items.slice(0, 2).map(it => `${it.name} (${it.qty})`).join('، ') + (items.length > 2 ? ` +${items.length - 2}` : '');
      const initials   = (p.supplierName || 'M').split(' ').map(w => w[0] || '').join('').slice(0,2);
      return `<tr data-id="${p.id}">
        <td class="text-muted">${start + i + 1}</td>
        <td><span class="order-ref">${p.orderRef || '—'}</span></td>
        <td>
          <div class="supplier-cell">
            <div class="supplier-avatar">${initials}</div>
            <div>
              <div class="supplier-name">${p.supplierName || '—'}</div>
              <div class="supplier-co">${Store.suppliers.find(s => s.id === p.supplierId)?.company || ''}</div>
            </div>
          </div>
        </td>
        <td class="text-sm text-muted">${itemsText || '—'}</td>
        <td><span class="cost-cell">${_fmtCentsCompact(p.totalCents || 0)}</span></td>
        <td class="text-sm text-muted">${_fmtDate(p.expectedDate)}</td>
        <td>
          <span class="badge status-${p.status || 'pending'}">${_statusLabel(p.status)}</span>
        </td>
        <td style="text-align:center;">
          <div class="row-actions" style="justify-content:center;">
            <button class="btn btn-secondary btn-icon btn-sm" data-action="view"   data-id="${p.id}" title="عرض"><i class="fas fa-eye" aria-hidden="true"></i></button>
            <button class="btn btn-secondary btn-icon btn-sm" data-action="send"   data-id="${p.id}" title="إرسال" ${p.status==='received'||p.status==='cancelled'?'disabled':''}><i class="fas fa-paper-plane" aria-hidden="true"></i></button>
            <button class="btn btn-secondary btn-icon btn-sm" data-action="edit"   data-id="${p.id}" title="تعديل" ${p.status==='received'?'disabled':''}><i class="fas fa-pen" aria-hidden="true"></i></button>
            <button class="btn btn-danger    btn-icon btn-sm" data-action="delete" data-id="${p.id}" title="حذف"><i class="fas fa-trash" aria-hidden="true"></i></button>
          </div>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const { action, id } = btn.dataset;
        if (action === 'view')   _openViewModal(id);
        if (action === 'send')   _openSendModal(id);
        if (action === 'edit')   _openPurchaseModal(id);
        if (action === 'delete') _deletePurchase(id);
      });
    });

    _renderPagination(filtered.length);
  }

  function _renderPagination(total) {
    const bar = _el('purPagination'); if (!bar) return;
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

  function _populateSupplierFilter() {
    const sel = _el('supplierFilter'); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">كل الموردين</option>' +
      Store.suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    if (cur) sel.value = cur;
    /* Also populate purchase modal supplier select */
    const modalSel = _el('supplierId');
    if (modalSel) {
      const mCur = modalSel.value;
      modalSel.innerHTML = '<option value="">اختر المورد</option>' +
        Store.suppliers.map(s => `<option value="${s.id}">${s.name}${s.company?' — '+s.company:''}</option>`).join('');
      if (mCur) modalSel.value = mCur;
    }
  }

  /* ──────────────────────────────────────
     PURCHASE FORM MODAL
     ────────────────────────────────────── */

  function _openPurchaseModal(purchaseId) {
    _populateSupplierFilter();
    const overlay = _el('purchaseModalOverlay'); if (!overlay) return;
    const titleEl = _el('purchaseModalTitle');
    const editId  = _el('editingPurchaseId');

    _clearProductRows();

    if (purchaseId) {
      const p = Store.purchases.find(x => x.id === purchaseId); if (!p) return;
      if (titleEl) titleEl.textContent = 'تعديل أمر الشراء';
      if (editId)  editId.value = purchaseId;
      const supEl = _el('supplierId'); if (supEl) supEl.value = p.supplierId || '';
      if (p.expectedDate) {
        const d = p.expectedDate.toDate ? p.expectedDate.toDate() : new Date(p.expectedDate);
        const local = new Date(d - d.getTimezoneOffset()*60000).toISOString().split('T')[0];
        const dateEl = _el('expectedDate'); if (dateEl) dateEl.value = local;
      }
      const notesEl = _el('purchaseNotes'); if (notesEl) notesEl.value = p.notes || '';
      (p.items || []).forEach(item => _addProductRow(item));
    } else {
      if (titleEl) titleEl.textContent = 'أمر شراء جديد';
      if (editId)  editId.value = '';
      ['expectedDate','purchaseNotes'].forEach(id => { const e = _el(id); if (e) e.value = ''; });
      /* FIX (audit #12): reset the supplier select too — it previously kept
         the last-edited PO's supplier, pre-filling new POs with it. */
      const supSel = _el('supplierId'); if (supSel) supSel.value = '';
      _addProductRow(null);
    }

    _updateTotal();
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function _closePurchaseModal() {
    _el('purchaseModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  /* ──────────────────────────────────────
     PRODUCT ROWS
     ────────────────────────────────────── */

  let _rowIdx = 0;

  function _clearProductRows() {
    const c = _el('productsList'); if (c) c.innerHTML = '';
    _rowIdx = 0;
    _updateTotal();
  }

  function _addProductRow(item, fromInventory) {
    const container = _el('productsList'); if (!container) return;
    const idx = _rowIdx++;
    const row = document.createElement('div');
    row.className = 'pur-product-row';
    row.dataset.idx = idx;

    const isInventory = fromInventory || (item && item.productId);
    const nameHtml = isInventory
      ? `<select class="form-input prod-name" data-idx="${idx}" aria-label="المنتج">
           <option value="">اختر منتجاً</option>
           ${Store.products.map(p => `<option value="${p.id}" data-cost="${p.cost||0}">${p.name}</option>`).join('')}
         </select>`
      : `<input type="text" class="form-input prod-name" placeholder="اسم المنتج" value="${item?.name||''}" aria-label="المنتج" />`;

    row.innerHTML = `
      ${nameHtml}
      <input type="number" class="form-input prod-qty"  value="${item?.qty  || 1}"    min="1"   step="1"   placeholder="الكمية"    aria-label="الكمية" />
      <input type="number" class="form-input prod-cost pur-unit-cost" value="${item ? (item.unitCostCents||0)/100 : ''}" min="0" step="0.01" placeholder="سعر الوحدة" aria-label="التكلفة" />
      <button type="button" class="pur-row-remove" aria-label="حذف"><i class="fas fa-xmark" aria-hidden="true"></i></button>`;

    if (isInventory && item?.productId) {
      const sel = row.querySelector('.prod-name');
      if (sel) sel.value = item.productId;
    }

    /* Auto-fill cost from inventory */
    const nameSel = row.querySelector('.prod-name');
    if (nameSel?.tagName === 'SELECT') {
      nameSel.addEventListener('change', e => {
        const opt = e.target.selectedOptions[0];
        if (opt?.dataset.cost) {
          row.querySelector('.prod-cost').value = (parseFloat(opt.dataset.cost) || 0).toFixed(2);
        }
        _updateTotal();
      });
    }
    row.querySelector('.prod-qty')?.addEventListener('input', _updateTotal);
    row.querySelector('.prod-cost')?.addEventListener('input', _updateTotal);
    row.querySelector('.pur-row-remove')?.addEventListener('click', () => { row.remove(); _updateTotal(); });

    const emptyMsg = _el('purProductsEmpty');
    if (emptyMsg) emptyMsg.hidden = true;

    container.appendChild(row);
    _updateTotal();
  }

  function _updateTotal() {
    let totalCents = 0;
    document.querySelectorAll('.pur-product-row').forEach(row => {
      const qty        = Number(row.querySelector('.prod-qty')?.value)  || 0;
      const unitCents  = _toCents(row.querySelector('.prod-cost')?.value || 0);
      totalCents += qty * unitCents;
    });
    _setText('purchaseTotal', _fmtCentsCompact(totalCents));
  }

  function _collectPurchaseData() {
    const items = [];
    document.querySelectorAll('.pur-product-row').forEach(row => {
      const nameEl      = row.querySelector('.prod-name');
      const name        = nameEl?.tagName === 'SELECT'
        ? (nameEl.selectedOptions[0]?.text || '')
        : (nameEl?.value || '');
      const productId   = nameEl?.tagName === 'SELECT' ? nameEl.value : null;
      const qty         = Number(row.querySelector('.prod-qty')?.value) || 1;
      const unitCostCents = _toCents(row.querySelector('.prod-cost')?.value || 0);
      if (name) items.push({ productId, name, qty, unitCostCents, totalCents: qty * unitCostCents });
    });
    /* Sum with integer arithmetic */
    const totalCents = items.reduce((s, i) => s + i.totalCents, 0);
    const supEl      = _el('supplierId');
    const supId      = supEl?.value || '';
    const supName    = supEl?.selectedOptions[0]?.text?.split('—')[0].trim() || '';
    const dateVal    = _el('expectedDate')?.value;
    return {
      supplierId:   supId,
      supplierName: supName,
      supplierPhone: _supplierPhone(supId),
      items, totalCents,
      amount: totalCents / 100,   /* convenience float for display */
      notes:  _el('purchaseNotes')?.value?.trim() || '',
      expectedDate: dateVal
        ? firebase.firestore.Timestamp.fromDate(new Date(dateVal))
        : null,
    };
  }

  async function _savePurchase() {
    const data     = _collectPurchaseData();
    const editId   = _el('editingPurchaseId')?.value || null;
    const saveBtn  = _el('savePurchaseBtn');
    const spinner  = _el('savePurchaseSpinner');
    const text     = _el('savePurchaseText');

    if (!data.supplierId) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى اختيار المورد' }); return;
    }
    if (!data.items.length) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إضافة منتج واحد على الأقل' }); return;
    }
    if (data.totalCents <= 0) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال تكلفة للمنتجات' }); return;
    }

    if (saveBtn) saveBtn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (text)    text.textContent = 'جاري الحفظ...';

    const user    = window.VisionAuth?.getUser();
    const payload = {
      ...data,
      createdBy:    user?.displayName || user?.email?.split('@')[0] || 'مدير',
      createdByUid: user?.uid || '',
    };

    try {
      if (editId) {
        await firebase.firestore().collection('purchases').doc(editId)
          .update({ ...payload, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        window.VisionOverlays?.toast({ type: 'success', message: 'تم تحديث أمر الشراء' });
      } else {
        payload.orderRef   = _nextRef();
        payload.status     = 'pending';
        payload.createdAt  = firebase.firestore.FieldValue.serverTimestamp();
        await firebase.firestore().collection('purchases').add(payload);
        window.VisionOverlays?.toast({ type: 'success', message: `تم إنشاء ${payload.orderRef}` });
      }
      _closePurchaseModal();
    } catch (err) {
      console.error('[Purchases] save error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الحفظ' });
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (text)    text.textContent = 'حفظ الأمر';
    }
  }

  async function _deletePurchase(id) {
    const confirmed = await window.VisionOverlays?.modal({
      title: 'حذف أمر الشراء',
      body:  'هل أنت متأكد من حذف هذا الأمر؟ لا يمكن التراجع.',
      buttons: [{ label: 'حذف', value: 'delete', primary: true }, { label: 'إلغاء', value: null }],
    });
    if (confirmed !== 'delete') return;
    try {
      const db = window.firebase.firestore();

      /* FIX (audit #15 companion): deleting a RECEIVED purchase must reverse
         the inventory increment its receipt applied — stock used to stay
         permanently inflated after such deletions. */
      const snap = await db.collection('purchases').doc(id).get();
      if (snap.exists && snap.data().status === 'received') {
        const results = await Promise.allSettled(
          (snap.data().items || [])
            .filter(it => it.productId)
            .map(it => db.collection('products').doc(it.productId).update({
              quantity: firebase.firestore.FieldValue.increment(-(it.qty || 0)),
            }))
        );
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed) console.error('[Purchases] stock reversal failed for', failed, 'items');
      }

      await db.collection('purchases').doc(id).delete();
      window.VisionOverlays?.toast({ type: 'success', message: 'تم حذف الأمر' });
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر الحذف' });
    }
  }

  /* ──────────────────────────────────────
     SEND ORDER MODAL
     ────────────────────────────────────── */

  function _formatOrderText(p) {
    const lines = [
      `📦 أمر شراء — ${p.orderRef || ''}`,
      `التاريخ: ${new Date().toLocaleDateString('ar-EG')}`,
      ``,
      `المنتجات:`,
      ...(p.items || []).map(i => `• ${i.name}  الكمية: ${i.qty}  سعر الوحدة: ${_fmtCentsCompact(i.unitCostCents)}`),
      ``,
      `الإجمالي: ${_fmtCentsCompact(p.totalCents)}`,
      p.notes ? `\nملاحظات: ${p.notes}` : '',
      ``,
      `— Nazamly ERP`,
    ];
    return lines.filter(l => l !== undefined).join('\n');
  }

  function _openSendModal(purchaseId) {
    const p = Store.purchases.find(x => x.id === purchaseId); if (!p) return;
    _el('sendingPurchaseId').value = purchaseId;
    _setText('sendModalTitle', `إرسال ${p.orderRef || 'الأمر'}`);
    _setText('sendModalInfo', `المورد: ${p.supplierName || '—'}  |  الإجمالي: ${_fmtCentsCompact(p.totalCents)}`);

    const text = _formatOrderText(p);
    const phone = p.supplierPhone || _supplierPhone(p.supplierId);
    const waHref = phone
      ? `https://wa.me/${phone.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    const waBtn = _el('sendWhatsAppBtn');
    if (waBtn) waBtn.href = waHref;

    const copyBtn = _el('copyOrderBtn');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(text);
          window.VisionOverlays?.toast({ type: 'success', message: 'تم النسخ!' });
        } catch (_) {
          window.VisionOverlays?.toast({ type: 'info', message: 'يرجى النسخ يدوياً' });
        }
      };
    }

    _el('sendModalOverlay')?.classList.add('active');
    document.body.style.overflow = 'hidden';

    /* Mark as sent after WhatsApp click
       FIX (audit #11): clone-replace the anchor first — every modal open
       used to ADD another {once:true} listener, and stale ones survived to
       mark a PREVIOUSLY viewed purchase as 'sent' on the next click. */
    if (waBtn) {
      const freshBtn = waBtn.cloneNode(true);
      waBtn.parentNode.replaceChild(freshBtn, waBtn);
      freshBtn.addEventListener('click', async () => {
        if (p.status === 'pending') {
          try {
            await window.firebase.firestore().collection('purchases').doc(purchaseId)
              .update({ status: 'sent', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
          } catch (_) {}
        }
      }, { once: true });
    }
  }

  function _closeSendModal() {
    _el('sendModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  /* ──────────────────────────────────────
     VIEW PURCHASE MODAL
     ────────────────────────────────────── */

  function _openViewModal(purchaseId) {
    const p = Store.purchases.find(x => x.id === purchaseId); if (!p) return;
    const content = _el('viewPurchaseContent');
    const footer  = _el('viewPurchaseFooter');
    _setText('viewModalTitle', p.orderRef || 'تفاصيل الأمر');

    if (content) {
      const itemsHtml = (p.items || []).map(i =>
        `<div class="view-row">
          <span class="view-row-label">${i.name} × ${i.qty}</span>
          <span class="view-row-value">${_fmtCentsCompact(i.totalCents)}</span>
        </div>`).join('');

      content.innerHTML = `
        <div class="view-section">
          <div class="view-section-title">معلومات الأمر</div>
          <div class="view-row"><span class="view-row-label">رقم الأمر</span><span class="view-row-value order-ref">${p.orderRef||'—'}</span></div>
          <div class="view-row"><span class="view-row-label">المورد</span><span class="view-row-value">${p.supplierName||'—'}</span></div>
          <div class="view-row"><span class="view-row-label">الحالة</span><span class="view-row-value"><span class="badge status-${p.status}">${_statusLabel(p.status)}</span></span></div>
          <div class="view-row"><span class="view-row-label">التاريخ المتوقع</span><span class="view-row-value">${_fmtDate(p.expectedDate)}</span></div>
          <div class="view-row"><span class="view-row-label">أُنشئ في</span><span class="view-row-value">${_fmtDate(p.createdAt)}</span></div>
        </div>
        <div class="view-section">
          <div class="view-section-title">المنتجات</div>
          ${itemsHtml}
          <div class="view-row" style="border-top:2px solid var(--color-border);margin-top:var(--space-2);padding-top:var(--space-3);">
            <span class="view-row-label" style="font-weight:var(--font-weight-bold);">الإجمالي</span>
            <span class="view-row-value" style="color:var(--color-warning);">${_fmtCentsCompact(p.totalCents||0)}</span>
          </div>
        </div>
        ${p.notes ? `<div class="view-section"><div class="view-section-title">ملاحظات</div><p class="text-sm text-muted">${p.notes}</p></div>` : ''}`;
    }

    /* Footer: status advancement buttons */
    if (footer) {
      const nextStatus = { pending: 'sent', sent: 'received' };
      const nextLabel  = { pending: 'تعليم كـ"تم الإرسال"', sent: 'تعليم كـ"تم الاستلام"' };
      const next = nextStatus[p.status];
      footer.innerHTML = `
        <button class="btn btn-secondary" id="closeViewModalBtn">إغلاق</button>
        ${next ? `<button class="btn btn-primary" id="advanceStatusBtn" data-id="${p.id}" data-next="${next}">${nextLabel[p.status]}</button>` : ''}
        ${p.status !== 'received' && p.status !== 'cancelled' ? `<button class="btn btn-danger btn-sm" id="cancelPurchaseBtn" data-id="${p.id}">إلغاء الأمر</button>` : ''}`;

      footer.querySelector('#closeViewModalBtn')?.addEventListener('click', _closeViewModal);
      footer.querySelector('#advanceStatusBtn')?.addEventListener('click', async e => {
        await _updateStatus(e.target.dataset.id, e.target.dataset.next);
        _closeViewModal();
      });
      footer.querySelector('#cancelPurchaseBtn')?.addEventListener('click', async e => {
        await _updateStatus(e.target.dataset.id, 'cancelled');
        _closeViewModal();
      });
    }

    _el('viewModalOverlay')?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function _closeViewModal() {
    _el('viewModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  async function _updateStatus(purchaseId, newStatus) {
    try {
      const db = window.firebase.firestore();
      const user = window.VisionAuth?.getUser();

      /* FIX (audit #15): read BEFORE writing and refuse invalid transitions —
         a double-clicked "تعليم كـ تم الاستلام" used to pass the status
         write twice and run the inventory increment twice, permanently
         inflating stock. */
      const snap = await db.collection('purchases').doc(purchaseId).get();
      if (!snap.exists) return;
      const current = snap.data().status;
      const validNext = { pending: ['sent', 'cancelled'], sent: ['received', 'cancelled'], received: [], cancelled: [] };
      if (!(validNext[current] || []).includes(newStatus)) {
        window.VisionOverlays?.toast({ type: 'warning', message: 'لا يمكن تطبيق الحالة — ربما تغيرت بالفعل' });
        return;
      }

      await db.collection('purchases').doc(purchaseId)
        .update({ status: newStatus, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      window.VisionOverlays?.toast({ type: 'success', message: `الحالة: ${_statusLabel(newStatus)}` });

      /* When goods are received, update product inventory
         (uses the doc already read above — no second fetch) */
      if (newStatus === 'received') {
        const items = snap.data().items || [];

        // Separate existing products (with productId) from new products (without)
        const existingItems = items.filter(it => it.productId);
        const newItems       = items.filter(it => !it.productId && it.name);

        // Increment each existing product's quantity in parallel
        const incrementOps = existingItems.map(it =>
          db.collection('products').doc(it.productId).update({
            quantity: firebase.firestore.FieldValue.increment(it.qty || 0),
          })
        );

        // Create new products for items that don't exist in inventory yet
        /* FIX (audit #10): write BOTH fields to match inventory's schema —
           costCents is the source of truth (integer) and cost is the
           display float in POUNDS. Writing raw cents into `cost` inflated
           subsequent PO unit costs 100×. */
        const createOps = newItems.map(it =>
          db.collection('products').add({
            name: it.name,
            quantity: it.qty || 0,
            costCents: it.unitCostCents || 0,
            cost: (it.unitCostCents || 0) / 100,
            price: 0,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: user?.displayName || user?.email?.split('@')[0] || 'مدير',
            createdByUid: user?.uid || '',
          })
        );

        const results = await Promise.allSettled([...incrementOps, ...createOps]);

        // Log any failures but don't block the UI — the status update already succeeded
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length) {
          console.error('[Purchases] inventory update failures:', failed.map(f => f.reason));
        }

        const created = newItems.length;
        if (created) {
          window.VisionOverlays?.toast({ type: 'success', message: `تمت إضافة ${created} منتجات جديدة للمخزون` });
        }
      }
    } catch (err) {
      console.error('[Purchases] status update:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر تحديث الحالة' });
    }
  }

  /* ──────────────────────────────────────
     SUPPLIERS MANAGER
     ────────────────────────────────────── */

  function _openSuppliersModal() {
    _renderSuppliersList();
    _el('suppliersModalOverlay')?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function _closeSuppliersModal() {
    _el('suppliersModalOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
    _el('supplierForm').hidden = true;
  }
  function _openSupplierForm(supplierId) {
    const form   = _el('supplierForm');
    const titleEl = _el('supplierFormTitle');
    const editId = _el('editingSupplierId');
    if (!form) return;

    if (supplierId) {
      const s = Store.suppliers.find(x => x.id === supplierId); if (!s) return;
      if (titleEl) titleEl.textContent = 'تعديل المورد';
      if (editId)  editId.value = supplierId;
      _el('supplierName').value    = s.name    || '';
      _el('supplierPhone').value   = s.phone   || '';
      _el('supplierCompany').value = s.company || '';
      _el('supplierNotes').value   = s.notes   || '';
    } else {
      if (titleEl) titleEl.textContent = 'مورد جديد';
      if (editId)  editId.value = '';
      ['supplierName','supplierPhone','supplierCompany','supplierNotes']
        .forEach(id => { const e = _el(id); if (e) e.value = ''; });
    }
    form.hidden = false;
    _el('supplierName')?.focus();
  }

  function _renderSuppliersList() {
    const el = _el('suppliersList'); if (!el) return;
    if (!Store.suppliers.length) {
      el.innerHTML = '<p class="text-sm text-muted" style="text-align:center;padding:var(--space-5);">لا يوجد موردون بعد</p>';
      return;
    }
    el.innerHTML = Store.suppliers.map(s => `
      <div class="supplier-item">
        <div class="supplier-avatar">${(s.name||'M').split(' ').map(w=>w[0]||'').join('').slice(0,2)}</div>
        <div class="supplier-item-info">
          <div class="supplier-item-name">${s.name || '—'}</div>
          ${s.company ? `<div class="supplier-item-co">${s.company}</div>` : ''}
          ${s.phone   ? `<div class="supplier-item-phone" dir="ltr">${s.phone}</div>` : ''}
        </div>
        <div class="supplier-item-actions">
          <button class="btn btn-secondary btn-icon btn-sm" data-action="edit-sup" data-id="${s.id}" title="تعديل"><i class="fas fa-pen" aria-hidden="true"></i></button>
          <button class="btn btn-danger    btn-icon btn-sm" data-action="del-sup"  data-id="${s.id}" title="حذف"><i class="fas fa-trash" aria-hidden="true"></i></button>
        </div>
      </div>`).join('');

    el.querySelectorAll('[data-action="edit-sup"]').forEach(b =>
      b.addEventListener('click', () => _openSupplierForm(b.dataset.id))
    );
    el.querySelectorAll('[data-action="del-sup"]').forEach(b =>
      b.addEventListener('click', () => _deleteSupplier(b.dataset.id))
    );
  }

  async function _saveSupplier() {
    const name    = _el('supplierName')?.value.trim();
    const phone   = _el('supplierPhone')?.value.trim();
    const company = _el('supplierCompany')?.value.trim();
    const notes   = _el('supplierNotes')?.value.trim();
    const editId  = _el('editingSupplierId')?.value || null;
    if (!name) { window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم المورد' }); return; }

    const saveBtn = _el('saveSupplierBtn');
    const spinner = _el('saveSupplierSpinner');
    const text    = _el('saveSupplierText');
    if (saveBtn) saveBtn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (text)    text.textContent = 'جاري الحفظ...';

    const payload = { name, phone, company, notes };
    try {
      if (editId) {
        await firebase.firestore().collection('suppliers').doc(editId).update(payload);
      } else {
        payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        await firebase.firestore().collection('suppliers').add(payload);
      }
      _el('supplierForm').hidden = true;
      _renderSuppliersList();
      window.VisionOverlays?.toast({ type: 'success', message: `تم حفظ "${name}"` });
    } catch (err) {
      console.error('[Purchases] save supplier:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الحفظ' });
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (text)    text.textContent = 'حفظ المورد';
    }
  }

  async function _deleteSupplier(supId) {
    const inUse = Store.purchases.filter(p => p.supplierId === supId).length;
    const body  = inUse
      ? `هذا المورد مرتبط بـ ${inUse} أوامر شراء. هل تريد الحذف؟`
      : 'هل تريد حذف هذا المورد؟';
    const confirmed = await window.VisionOverlays?.modal({
      title: 'حذف المورد', body,
      buttons: [{ label: 'حذف', value: 'delete', primary: true }, { label: 'إلغاء', value: null }],
    });
    if (confirmed !== 'delete') return;
    try {
      await window.firebase.firestore().collection('suppliers').doc(supId).delete();
      _renderSuppliersList();
    } catch (err) {
      window.VisionOverlays?.toast({ type: 'error', message: 'تعذّر الحذف' });
    }
  }

  /* ──────────────────────────────────────
     DATA LOADING
     ────────────────────────────────────── */

  function _loadData() {
    try {
      _unsubs.push(
        firebase.firestore().collection('purchases').orderBy('createdAt', 'desc')
          .onSnapshot(
            snap => { Store.purchases = snap.docs.map(d => ({ id: d.id, ...d.data() })); _scheduleRender(); },
            err  => {
              console.error('[Purchases] listener:', err);
              const skel = document.getElementById('skeletonLoader');
              if (skel) skel.classList.add('hidden');
              window.VisionOverlays?.toast({ type: 'error', message: 'تعذر تحميل أوامر الشراء' });
            }
          )
      );
      _unsubs.push(
        firebase.firestore().collection('suppliers').orderBy('name')
          .onSnapshot(
            snap => { Store.suppliers = snap.docs.map(d => ({ id: d.id, ...d.data() })); _scheduleRender(); },
            err  => {
              console.error('[Purchases] suppliers listener:', err);
              window.VisionOverlays?.toast({ type: 'error', message: 'تعذر تحميل الموردين' });
            }
          )
      );
      // Live products update so newly added products appear immediately in the modal
      const _productsUnsub = firebase.firestore().collection('products').orderBy('name').onSnapshot(
        snap => { Store.products = snap.docs.map(d => ({ id: d.id, ...d.data() })); _scheduleRender(); }
      );
      _unsubs.push(_productsUnsub);
    } catch (err) {
      console.error('[Purchases] _loadData fatal:', err);
      const skel = document.getElementById('skeletonLoader');
      if (skel) skel.classList.add('hidden');
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء تحميل بيانات المشتريات' });
    }
  }

  /* ──────────────────────────────────────
     EVENT BINDINGS
     ────────────────────────────────────── */

  function _bindEvents() {
    /* Purchase modal */
    _el('addPurchaseBtn')?.addEventListener('click',   () => _openPurchaseModal(null));
    _el('emptyAddBtn')?.addEventListener('click',      () => _openPurchaseModal(null));
    _el('closePurchaseModal')?.addEventListener('click',  _closePurchaseModal);
    _el('cancelPurchaseModal')?.addEventListener('click', _closePurchaseModal);
    _el('savePurchaseBtn')?.addEventListener('click',     _savePurchase);
    _el('purchaseModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('purchaseModalOverlay')) _closePurchaseModal();
    });
    _el('addInventoryProductBtn')?.addEventListener('click', () => _addProductRow(null, true));
    _el('addCustomProductBtn')?.addEventListener('click',    () => _addProductRow(null, false));
    _el('quickAddSupplierBtn')?.addEventListener('click', () => {
      _closePurchaseModal();
      _openSuppliersModal();
      _openSupplierForm(null);
    });

    /* Suppliers modal */
    _el('manageSuppliersBtn')?.addEventListener('click', _openSuppliersModal);
    _el('closeSuppliersModal')?.addEventListener('click',    _closeSuppliersModal);
    _el('closeSuppliersModalBtn')?.addEventListener('click', _closeSuppliersModal);
    _el('suppliersModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('suppliersModalOverlay')) _closeSuppliersModal();
    });
    _el('showAddSupplierFormBtn')?.addEventListener('click', () => _openSupplierForm(null));
    _el('cancelSupplierForm')?.addEventListener('click', () => { _el('supplierForm').hidden = true; });
    _el('saveSupplierBtn')?.addEventListener('click', _saveSupplier);

    /* Send modal */
    _el('closeSendModal')?.addEventListener('click', _closeSendModal);
    _el('sendModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('sendModalOverlay')) _closeSendModal();
    });

    /* View modal */
    _el('closeViewModal')?.addEventListener('click', _closeViewModal);
    _el('viewModalOverlay')?.addEventListener('click', e => {
      if (e.target === _el('viewModalOverlay')) _closeViewModal();
    });

    /* Filters */
    _el('searchInput')?.addEventListener('input',  e => { Filters.search   = e.target.value; _page = 1; _scheduleRender(); });
    _el('statusFilter')?.addEventListener('change',e => { Filters.status   = e.target.value; _page = 1; _scheduleRender(); });
    _el('supplierFilter')?.addEventListener('change',e=>{ Filters.supplier = e.target.value; _page = 1; _scheduleRender(); });
    _el('resetFiltersBtn')?.addEventListener('click', () => {
      Object.assign(Filters, { search: '', status: '', supplier: '' });
      ['searchInput','statusFilter','supplierFilter'].forEach(id => { const e = _el(id); if (e) e.value = ''; });
      _page = 1; _scheduleRender();
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
      adminOnly: true,
      onReady: () => {
        Sidebar.init({ activePage: 'purchases' });
        Topbar.init({ title: 'المشتريات' });
        _bindEvents();
        _loadData();
      },
    });
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);
