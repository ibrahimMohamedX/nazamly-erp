/**
 * pages/employees.js — Employees Management Controller
 *
 * Key architectural decisions:
 *   1. New accounts are created via a secondary Firebase App instance
 *      so the admin's own auth session is never disrupted.
 *   2. Permissions are stored on the Firestore employee doc.
 *      VisionAuth reads them from ID-token claims on sign-in.
 *   3. Orders are loaded once (getDocs) for performance stats;
 *      employees use onSnapshot for live updates.
 */
(function (window) {
  'use strict';

  /* ──────────────────────────────────────
     PERMISSION DEFINITIONS
     ────────────────────────────────────── */

  const PERMISSIONS = [
    { key: 'canSeeAllOrders',        label: 'رؤية كل الطلبات',        icon: 'fa-eye' },
    { key: 'canSeeFinancials',       label: 'رؤية البيانات المالية',  icon: 'fa-chart-pie' },
    { key: 'canImport',              label: 'استيراد البيانات',        icon: 'fa-file-import' },
    { key: 'canExportArchive',       label: 'تصدير الأرشيف',          icon: 'fa-file-export' },
    { key: 'canExportShipping',      label: 'تصدير بيانات الشحن',     icon: 'fa-truck' },
    { key: 'canSeePackingSummary',   label: 'ملخص التعبئة',           icon: 'fa-boxes-stacked' },
    { key: 'canSeeFinancialAnalysis',label: 'التحليل المالي',         icon: 'fa-chart-line' },
    { key: 'canManageStatuses',      label: 'إدارة الحالات',          icon: 'fa-tags' },
    { key: 'canChangeOrderEmployee', label: 'تغيير موظف الطلب',       icon: 'fa-user-tag' },
  ];

  /* ──────────────────────────────────────
     STATE
     ────────────────────────────────────── */

  let _employees = [];
  let _orders    = [];          /* for performance stats */
  let _search    = '';
  let _perfChart = null;
  const _unsubs  = [];

  /* ──────────────────────────────────────
     HELPERS
     ────────────────────────────────────── */

  const _el  = id => document.getElementById(id);
  const _setText = (id, v) => { const e = _el(id); if (e) e.textContent = v; };
  const _fmtCurrency = n => (Number(n)||0).toLocaleString('ar-EG', { maximumFractionDigits: 0 }) + ' ج.م';

  /* Status type from orders (mirrors dashboard logic) */
  function _isDelivered(o) {
    const lc = (o.status || '').toLowerCase();
    return /تسليم|مسلم|delivered/.test(lc);
  }

  /* Per-employee order stats */
  function _empStats(empId) {
    const empOrders = _orders.filter(o => o.employeeId === empId);
    const delivered = empOrders.filter(_isDelivered);
    const revenue   = delivered.reduce((s, o) => s + (Number(o.total) || 0), 0);
    return { total: empOrders.length, delivered: delivered.length, revenue };
  }

  /* ──────────────────────────────────────
     RENDER
     ────────────────────────────────────── */

  function _render() {
    const filtered = _search
      ? _employees.filter(e =>
          (e.name  || '').toLowerCase().includes(_search) ||
          (e.email || '').toLowerCase().includes(_search))
      : _employees;

    _renderStats();
    _renderTable(filtered);
    _renderChart(filtered);

    const skel = _el('skeletonLoader');
    if (skel) skel.classList.add('hidden');
  }

  function _renderStats() {
    const total     = _employees.length;
    const active    = _employees.filter(e => e.status !== 'suspended').length;
    const suspended = total - active;

    /* Top seller by delivered order count */
    let topEmp = null, topCount = 0;
    _employees.forEach(e => {
      const { delivered } = _empStats(e.id);
      if (delivered > topCount) { topCount = delivered; topEmp = e; }
    });
    const topRevenue = topEmp ? _empStats(topEmp.id).revenue : 0;

    _setText('statTotalEmployees',    total);
    _setText('statActiveEmployees',   active);
    _setText('statSuspendedEmployees',suspended);
    _setText('statTopSeller',    topEmp?.name || '—');
    _setText('statTopSellerAmount', topEmp ? _fmtCurrency(topRevenue) : '');
    _setText('empCount', `${_employees.length} موظف`);
  }

  function _renderTable(employees) {
    const tbody = _el('employeesTableBody'); if (!tbody) return;
    const empty = _el('empEmpty');

    if (!employees.length) {
      tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    tbody.innerHTML = employees.map(emp => {
      const stats     = _empStats(emp.id);
      const roleClass = emp.role === 'admin' ? 'role-admin' : 'role-user';
      const roleLabel = emp.role === 'admin' ? 'مدير' : 'موظف';
      const stClass   = emp.status === 'suspended' ? 'status-suspended' : 'status-active';
      const stLabel   = emp.status === 'suspended' ? 'موقوف' : 'نشط';
      const initials  = (emp.name || 'M').split(' ').map(w => w[0] || '').join('').slice(0,2);

      return `<tr data-id="${emp.id}">
        <td>
          <div class="emp-cell">
            <div class="emp-avatar">${initials}</div>
            <div>
              <div class="emp-name">${emp.name || '—'}</div>
              <div class="emp-email">${emp.email || ''}</div>
            </div>
          </div>
        </td>
        <td><span class="badge ${roleClass}">${roleLabel}</span></td>
        <td style="text-align:center;">
          <span class="badge badge-dot ${stClass}">${stLabel}</span>
        </td>
        <td style="text-align:center;">
          <strong class="text-success">${stats.delivered}</strong>
          <span class="text-muted text-xs"> / ${stats.total}</span>
        </td>
        <td class="text-success font-bold">${_fmtCurrency(stats.revenue)}</td>
        <td style="text-align:center;">
          <div style="display:flex;gap:var(--space-2);justify-content:center;">
            <button class="btn btn-secondary btn-icon btn-sm" data-action="edit"    data-id="${emp.id}" title="تعديل الصلاحيات">
              <i class="fas fa-pen" aria-hidden="true"></i>
            </button>
            <button class="btn ${emp.status==='suspended'?'btn-success':'btn-danger'} btn-icon btn-sm"
              data-action="toggle-status" data-id="${emp.id}"
              title="${emp.status==='suspended'?'تفعيل الحساب':'تعليق الحساب'}">
              <i class="fas ${emp.status==='suspended'?'fa-user-check':'fa-user-slash'}" aria-hidden="true"></i>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');

    /* Table event delegation */
    tbody.querySelectorAll('[data-action="edit"]').forEach(b =>
      b.addEventListener('click', () => _openEditModal(b.dataset.id))
    );
    tbody.querySelectorAll('[data-action="toggle-status"]').forEach(b =>
      b.addEventListener('click', () => _toggleStatus(b.dataset.id))
    );
  }

  function _renderChart(employees) {
    const canvas = _el('performanceChart'); if (!canvas) return;
    if (_perfChart) { _perfChart.destroy(); _perfChart = null; }

    const top = employees
      .map(e => ({ name: e.name || 'موظف', ...(_empStats(e.id)) }))
      .sort((a, b) => b.delivered - a.delivered)
      .slice(0, 10);

    if (!top.length) return;

    _perfChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: top.map(e => e.name),
        datasets: [{
          label: 'طلبات مسلمة',
          data: top.map(e => e.delivered),
          backgroundColor: 'rgba(59,130,246,0.75)',
          borderRadius: 6,
          borderSkipped: false,
        }, {
          label: 'إجمالي الطلبات',
          data: top.map(e => e.total),
          backgroundColor: 'rgba(59,130,246,0.18)',
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 450 },
        plugins: {
          legend: { labels: { color: '#94A3B8', font: { family: 'Cairo', size: 12 } } },
          tooltip: {
            backgroundColor: '#1E293B', titleColor: '#F8FAFC', bodyColor: '#94A3B8',
            borderColor: '#334155', borderWidth: 1,
            titleFont: { family: 'Cairo', weight: '700' },
            bodyFont:  { family: 'Cairo', size: 12 },
          },
        },
        scales: {
          x: { ticks: { color: '#64748B', font: { family: 'Cairo', size: 11 } }, grid: { color: '#1E293B' } },
          y: { ticks: { color: '#64748B', font: { family: 'Cairo', size: 11 } }, grid: { color: '#1E293B' }, beginAtZero: true },
        },
      },
    });
  }

  /* ──────────────────────────────────────
     ADD EMPLOYEE MODAL
     ────────────────────────────────────── */

  function _openAddModal() {
    ['addEmpName','addEmpEmail','addEmpPassword'].forEach(id => { const e = _el(id); if (e) e.value = ''; });
    const roleEl = _el('addEmpRole'); if (roleEl) roleEl.value = 'user';
    _el('addEmpOverlay')?.classList.add('active');
    document.body.style.overflow = 'hidden';
    _el('addEmpName')?.focus();
  }

  function _closeAddModal() {
    _el('addEmpOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  /* Creates employee via secondary Firebase App so admin stays signed in */
  async function _saveNewEmployee() {
    const name     = _el('addEmpName')?.value.trim();
    const email    = _el('addEmpEmail')?.value.trim();
    const password = _el('addEmpPassword')?.value;
    const role     = _el('addEmpRole')?.value || 'user';

    if (!name || !email || !password) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى تعبئة جميع الحقول المطلوبة' });
      return;
    }
    if (password.length < 6) {
      window.VisionOverlays?.toast({ type: 'error', message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
      return;
    }

    const saveBtn = _el('saveAddEmpBtn');
    const spinner = _el('addEmpSpinner');
    const text    = _el('addEmpBtnText');
    if (saveBtn) saveBtn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (text)    text.textContent = 'جاري الإنشاء...';

    let secondaryApp = null;
    try {
      /* Secondary app — avoids disrupting the admin's auth session */
      secondaryApp = firebase.initializeApp(
        firebase.app().options,
        'employee-creation-' + Date.now()
      );
      const tempAuth = secondaryApp.auth();
      const cred     = await tempAuth.createUserWithEmailAndPassword(email, password);
      const uid      = cred.user.uid;
      await tempAuth.signOut();

      /* Write employee doc with default permissions */
      await window.firebase.firestore().collection('employees').doc(uid).set({
        name,
        email,
        role,
        status: 'active',
        permissions: role === 'admin'
          ? Object.fromEntries(PERMISSIONS.map(p => [p.key, true]))
          : Object.fromEntries(PERMISSIONS.map(p => [p.key, false])),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      window.VisionOverlays?.toast({ type: 'success', title: 'تم الإنشاء', message: `تم إنشاء حساب ${name} بنجاح` });
      _closeAddModal();
    } catch (err) {
      console.error('[Employees] create error:', err);
      const msg = err.code === 'auth/email-already-in-use'
        ? 'البريد الإلكتروني مستخدم بالفعل'
        : 'حدث خطأ أثناء الإنشاء. يرجى المحاولة مجدداً.';
      window.VisionOverlays?.toast({ type: 'error', message: msg });
    } finally {
      /* Always delete secondary app to free resources */
      if (secondaryApp) secondaryApp.delete().catch(() => {});
      if (saveBtn) saveBtn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (text)    text.textContent = 'إنشاء الحساب';
    }
  }

  /* ──────────────────────────────────────
     EDIT EMPLOYEE MODAL
     ────────────────────────────────────── */

  function _openEditModal(empId) {
    const emp = _employees.find(e => e.id === empId); if (!emp) return;

    _el('editEmpId').value   = empId;
    _el('editEmpName').value  = emp.name  || '';
    _el('editEmpEmail').value = emp.email || '';
    const roleEl   = _el('editEmpRole');   if (roleEl)   roleEl.value   = emp.role   || 'user';
    const statusEl = _el('editEmpStatus'); if (statusEl) statusEl.value = emp.status || 'active';

    /* Build permissions grid */
    _renderPermissionsGrid(emp.permissions || {}, emp.role);

    /* Hide permissions for admin (they have all) */
    const section = _el('permissionsSection');
    if (section) section.style.display = emp.role === 'admin' ? 'none' : '';

    _el('editEmpOverlay')?.classList.add('active');
    document.body.style.overflow = 'hidden';

    /* Re-hide permissions if role changes */
    roleEl?.addEventListener('change', e => {
      if (section) section.style.display = e.target.value === 'admin' ? 'none' : '';
    }, { once: true });
  }

  function _closeEditModal() {
    _el('editEmpOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
  }

  function _renderPermissionsGrid(currentPerms, role) {
    const grid = _el('permissionsGrid'); if (!grid) return;
    grid.innerHTML = PERMISSIONS.map(p => `
      <label class="permission-toggle" title="${p.label}">
        <input type="checkbox" name="perm" data-key="${p.key}"
          ${currentPerms[p.key] || role === 'admin' ? 'checked' : ''} />
        <div class="perm-label">
          <i class="fas ${p.icon}" aria-hidden="true"></i>
          ${p.label}
        </div>
        <div class="toggle-switch" aria-hidden="true">
          <div class="toggle-switch-track"></div>
          <div class="toggle-switch-thumb"></div>
        </div>
      </label>`).join('');
  }

  async function _saveEditEmployee() {
    const empId  = _el('editEmpId')?.value; if (!empId) return;
    const name   = _el('editEmpName')?.value.trim();
    const role   = _el('editEmpRole')?.value   || 'user';
    const status = _el('editEmpStatus')?.value || 'active';

    if (!name) {
      window.VisionOverlays?.toast({ type: 'error', message: 'يرجى إدخال اسم الموظف' });
      return;
    }

    /* Collect permissions from grid */
    const permissions = {};
    document.querySelectorAll('#permissionsGrid input[data-key]').forEach(chk => {
      permissions[chk.dataset.key] = chk.checked;
    });
    /* Admins always get all permissions */
    if (role === 'admin') PERMISSIONS.forEach(p => { permissions[p.key] = true; });

    const saveBtn = _el('saveEditEmpBtn');
    const spinner = _el('editEmpSpinner');
    const text    = _el('editEmpBtnText');
    if (saveBtn) saveBtn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (text)    text.textContent = 'جاري الحفظ...';

    try {
      await window.firebase.firestore().collection('employees').doc(empId).update({
        name, role, status, permissions,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      window.VisionOverlays?.toast({ type: 'success', message: 'تم تحديث بيانات الموظف بنجاح' });
      _closeEditModal();
    } catch (err) {
      console.error('[Employees] edit error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء الحفظ.' });
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (text)    text.textContent = 'حفظ التعديلات';
    }
  }

  /* ──────────────────────────────────────
     SUSPEND / ACTIVATE
     ────────────────────────────────────── */

  async function _toggleStatus(empId) {
    const emp = _employees.find(e => e.id === empId); if (!emp) return;
    const isSuspended = emp.status === 'suspended';
    const action  = isSuspended ? 'تفعيل' : 'تعليق';
    const newStatus = isSuspended ? 'active' : 'suspended';

    const confirmed = await window.VisionOverlays?.modal({
      title: `${action} حساب الموظف`,
      body:  `هل تريد ${action} حساب ${emp.name || 'الموظف'}؟`,
      buttons: [
        { label: action, value: 'confirm', primary: true },
        { label: 'إلغاء', value: null },
      ],
    });
    if (confirmed !== 'confirm') return;

    try {
      await window.firebase.firestore().collection('employees').doc(empId).update({
        status: newStatus,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      window.VisionOverlays?.toast({
        type: isSuspended ? 'success' : 'warning',
        message: `تم ${action} حساب ${emp.name || 'الموظف'}`,
      });
    } catch (err) {
      console.error('[Employees] toggle status error:', err);
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ. يرجى المحاولة مجدداً.' });
    }
  }

  /* ──────────────────────────────────────
     DATA LOADING
     ────────────────────────────────────── */

  function _loadData() {
    try {
      /* Real-time employees listener */
      _unsubs.push(
        firebase.firestore().collection('employees').onSnapshot(
          snap => {
            _employees = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            _render();
          },
          err => {
            console.error('[Employees] listener:', err);
            const skel = document.getElementById('skeletonLoader');
            if (skel) skel.classList.add('hidden');
          }
        )
      );

      /* One-time orders load for performance stats */
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 3);
      firebase.firestore().collection('orders')
        .where('createdAt', '>=', firebase.firestore.Timestamp.fromDate(cutoff))
        .get()
        .then(snap => {
          _orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          _render();
        })
        .catch(err => {
          console.error('[Employees] orders load:', err);
          const skel = document.getElementById('skeletonLoader');
          if (skel) skel.classList.add('hidden');
          window.VisionOverlays?.toast({ type: 'error', message: 'تعذر تحميل بيانات الطلبات للإحصائيات' });
        });
    } catch (err) {
      console.error('[Employees] _loadData fatal:', err);
      const skel = document.getElementById('skeletonLoader');
      if (skel) skel.classList.add('hidden');
      window.VisionOverlays?.toast({ type: 'error', message: 'حدث خطأ أثناء تحميل بيانات الموظفين' });
    }
  }

  /* ──────────────────────────────────────
     EVENT BINDINGS
     ────────────────────────────────────── */

  function _bindEvents() {
    /* Add modal */
    _el('addEmployeeBtn')?.addEventListener('click', _openAddModal);
    _el('closeAddEmp')?.addEventListener('click', _closeAddModal);
    _el('cancelAddEmp')?.addEventListener('click', _closeAddModal);
    _el('saveAddEmpBtn')?.addEventListener('click', _saveNewEmployee);
    _el('addEmpOverlay')?.addEventListener('click', e => {
      if (e.target === _el('addEmpOverlay')) _closeAddModal();
    });

    /* Edit modal */
    _el('closeEditEmp')?.addEventListener('click', _closeEditModal);
    _el('cancelEditEmp')?.addEventListener('click', _closeEditModal);
    _el('saveEditEmpBtn')?.addEventListener('click', _saveEditEmployee);
    _el('editEmpOverlay')?.addEventListener('click', e => {
      if (e.target === _el('editEmpOverlay')) _closeEditModal();
    });

    /* Search */
    _el('searchInput')?.addEventListener('input', e => {
      _search = e.target.value.toLowerCase().trim();
      _render();
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
        Sidebar.init({ activePage: 'employees' });
        Topbar.init({ title: 'إدارة الموظفين' });
        _bindEvents();
        _loadData();
      },
    });
  }

  window.addEventListener('vision-ready', _init, { once: true });

})(window);
