/**
 * shared/sidebar.js — Sidebar Component
 *
 * Renders the navigation sidebar into #sidebar-mount.
 *
 * Usage (in each page's <script>):
 *   Sidebar.init({ activePage: 'orders' });
 *
 * activePage values: 'index' | 'dashboard' | 'orders' | 'inventory' |
 *                    'purchases' | 'expenses' | 'employees' | 'awb' | 'shipping'
 */
(function (window) {
  'use strict';

  /* Navigation item definitions */
  var NAV_SECTIONS = [
    {
      label: 'الرئيسية',
      items: [
        { id: 'index',     href: 'index.html',     icon: 'fa-house',           label: 'الرئيسية',         adminOnly: true },
        { id: 'dashboard', href: 'dashboard.html',  icon: 'fa-chart-line',      label: 'لوحة التحكم',      adminOnly: true },
      ]
    },
    {
      label: 'العمليات',
      items: [
        { id: 'orders',    href: 'orders.html',    icon: 'fa-cart-shopping',    label: 'الطلبات والعملاء', adminOnly: false },
        { id: 'inventory', href: 'inventory.html', icon: 'fa-boxes-stacked',    label: 'المخزون',          adminOnly: false },
        { id: 'awb',       href: 'awb.html',       icon: 'fa-plane-departure',  label: 'بوليصات الشحن',    adminOnly: false },
      ]
    },
    {
      label: 'الإدارة',
      items: [
        { id: 'purchases', href: 'purchases.html', icon: 'fa-truck-ramp-box',  label: 'المشتريات',        adminOnly: true },
        { id: 'expenses',  href: 'expenses.html',  icon: 'fa-receipt',          label: 'المصاريف',         adminOnly: true },
        { id: 'employees', href: 'employees.html', icon: 'fa-users',            label: 'الموظفون',         adminOnly: true },
        { id: 'shipping',  href: 'shipping-settings.html', icon: 'fa-gears',     label: 'إعدادات الشحن',    adminOnly: true },
      ]
    }
  ];

  /* Role display map */
  var ROLE_LABEL = { super_admin: 'المالك', admin: 'مدير النظام', user: 'موظف', guest: 'ضيف' };

  /* Stored cleanup references */
  var _cleanupFns = [];

  /* ──────────────────────────────────────
     HTML TEMPLATE
     ────────────────────────────────────── */

  function _buildNavSections(activePage, isAdmin) {
    return NAV_SECTIONS.map(function (section) {
      var visibleItems = section.items.filter(function (item) {
        return !item.adminOnly || isAdmin;
      });
      if (!visibleItems.length) return '';

      var itemsHtml = visibleItems.map(function (item) {
        var isActive = item.id === activePage;
        return '<a href="' + item.href + '"'
          + ' class="sidebar-item' + (isActive ? ' active' : '') + '"'
          + ' data-page="' + item.id + '"'
          + ' aria-current="' + (isActive ? 'page' : 'false') + '">'
          + '<i class="fas ' + item.icon + ' sidebar-icon" aria-hidden="true"></i>'
          + '<span class="sidebar-text">' + item.label + '</span>'
          + '</a>';
      }).join('');

      return '<div class="section-label sidebar-text" aria-hidden="true">' + section.label + '</div>'
        + itemsHtml;
    }).join('');
  }

  function _buildHtml(activePage, isAdmin, userName, userRole, brand) {
    var roleDisplay = ROLE_LABEL[userRole] || userRole;
    return ''
      + '<nav id="sidebar" class="sidebar custom-scroll" role="navigation" aria-label="القائمة الرئيسية">'
      +   '<div class="sidebar-header">'
      +     '<div class="sidebar-brand">'
      +       '<img src="nazamly.png" alt="Nazamly" class="sidebar-logo" width="36" height="36" />'
      +       '<span class="sidebar-brand-name sidebar-text">' + _esc(brand) + '</span>'
      +     '</div>'
      +     '<button id="sidebarToggleBtn" class="sidebar-toggle-btn" aria-label="طي القائمة" title="طي القائمة">'
      +       '<i class="fas fa-chevron-right" aria-hidden="true"></i>'
      +     '</button>'
      +   '</div>'
      +   '<div class="sidebar-nav">' + _buildNavSections(activePage, isAdmin) + '</div>'
      +   '<div class="sidebar-footer">'
      +     '<div class="sidebar-user">'
      +       '<div class="sidebar-user-avatar"><i class="fas fa-user-tie" aria-hidden="true"></i></div>'
      +       '<div class="sidebar-user-info sidebar-text">'
      +         '<div class="sidebar-user-name" id="sidebarUserName">' + _esc(userName) + '</div>'
      +         '<div class="sidebar-user-role" id="sidebarUserRole">' + _esc(roleDisplay) + '</div>'
      +       '</div>'
      +     '</div>'
      +     '<button class="sidebar-item sidebar-text" id="sidebarSignOutBtn" aria-label="تسجيل الخروج" title="تسجيل الخروج">'
      +       '<i class="fas fa-arrow-right-from-bracket sidebar-icon" aria-hidden="true"></i>'
      +       '<span class="sidebar-text">خروج</span>'
      +     '</button>'
      +   '</div>'
      + '</nav>';
  }

  /* Minimal HTML escape */
  function _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ──────────────────────────────────────
     COLLAPSE PERSISTENCE
     ────────────────────────────────────── */

  function _restoreCollapseState(sidebar, appMain, topbar) {
    /* Only restore on desktop — ignore saved state on narrow viewports */
    if (window.innerWidth < 768) return;
    var isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
    if (isCollapsed) {
      sidebar.classList.add('sidebar-collapsed');
      if (appMain) appMain.classList.add('sidebar-collapsed-main');
      if (topbar)  topbar.classList.add('sidebar-collapsed-header');
    }
  }

  function _bindToggle(sidebar, appMain, topbar) {
    var btn = document.getElementById('sidebarToggleBtn');
    if (!btn) return;

    var handler = function () {
      var collapsed = sidebar.classList.toggle('sidebar-collapsed');
      if (appMain) appMain.classList.toggle('sidebar-collapsed-main', collapsed);
      if (topbar)  topbar.classList.toggle('sidebar-collapsed-header', collapsed);
      localStorage.setItem('sidebarCollapsed', String(collapsed));
      btn.setAttribute('aria-label', collapsed ? 'توسيع القائمة' : 'طي القائمة');
      btn.title = collapsed ? 'توسيع القائمة' : 'طي القائمة';
    };

    btn.addEventListener('click', handler);
    _cleanupFns.push(function () { btn.removeEventListener('click', handler); });
  }

  /* ──────────────────────────────────────
     MOBILE OVERLAY
     ────────────────────────────────────── */

  function _closeMobileSidebar(sidebar, overlay) {
    sidebar.classList.remove('sidebar-mobile-open');
    if (overlay) overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  function _openMobileSidebar(sidebar, overlay) {
    sidebar.classList.add('sidebar-mobile-open');
    if (overlay) overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function _bindMobileOverlay(sidebar) {
    /* Ensure overlay element exists */
    var overlay = document.getElementById('mobileSidebarOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'mobileSidebarOverlay';
      overlay.className = 'mobile-sidebar-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlay);
    }

    /* Overlay click closes sidebar */
    var overlayHandler = function () {
      _closeMobileSidebar(sidebar, overlay);
    };
    overlay.addEventListener('click', overlayHandler);
    _cleanupFns.push(function () { overlay.removeEventListener('click', overlayHandler); });

    /* Defer menu button binding — topbar.js may not have rendered it yet */
    requestAnimationFrame(function () {
      var menuBtn = document.getElementById('mobileMenuBtn');
      if (!menuBtn) return;

      var menuHandler = function () {
        if (sidebar.classList.contains('sidebar-mobile-open')) {
          _closeMobileSidebar(sidebar, overlay);
        } else {
          _openMobileSidebar(sidebar, overlay);
        }
      };

      menuBtn.addEventListener('click', menuHandler);
      _cleanupFns.push(function () { menuBtn.removeEventListener('click', menuHandler); });
    });

    /* Close on viewport resize to desktop */
    var resizeHandler = function () {
      if (window.innerWidth >= 768 && sidebar.classList.contains('sidebar-mobile-open')) {
        _closeMobileSidebar(sidebar, overlay);
      }
    };
    window.addEventListener('resize', resizeHandler);
    _cleanupFns.push(function () { window.removeEventListener('resize', resizeHandler); });
  }

  /* ──────────────────────────────────────
     SIGN-OUT
     ────────────────────────────────────── */

  function _bindSignOut() {
    var btn = document.getElementById('sidebarSignOutBtn');
    if (!btn) return;

    var handler = function () {
      btn.disabled = true;
      (window.VisionAuth ? window.VisionAuth.signOut()
        : (typeof firebase !== 'undefined' && firebase.auth ? firebase.auth().signOut() : Promise.resolve()))
        .catch(function (e) { console.error('[Sidebar] signOut error:', e); })
        .finally(function () {
          localStorage.removeItem('employeeName');
          window.location.replace('login.html');
        });
    };

    btn.addEventListener('click', handler);
    _cleanupFns.push(function () { btn.removeEventListener('click', handler); });
  }

  /* ──────────────────────────────────────
     PUBLIC API
     ────────────────────────────────────── */

  /**
   * Render sidebar and wire all interactions.
   * @param {Object} [options]
   * @param {string} [options.activePage] - Page ID to mark as active
   */
  function init(options) {
    options = options || {};

    /* Cleanup previous instance if any */
    destroy();

    var mount = document.getElementById('sidebar-mount');
    if (!mount) {
      console.warn('[Sidebar] #sidebar-mount not found');
      return;
    }

    /* Gather auth state */
    var isAdmin  = window.VisionAuth ? window.VisionAuth.isAdmin() : false;
    var authUser = window.VisionAuth ? window.VisionAuth.getUser() : null;
    var userName = (authUser && authUser.displayName)
                || localStorage.getItem('employeeName')
                || 'المستخدم';
    var userRole = window.VisionAuth ? (window.VisionAuth.getRole() || '') : '';
    var brand    = window.CLIENT_BRAND || 'Nazamly';

    mount.innerHTML = _buildHtml(options.activePage || '', isAdmin, userName, userRole, brand);

    /* Layout references */
    var sidebar = document.getElementById('sidebar');
    var appMain = document.querySelector('.app-main');
    var topbar  = document.querySelector('.topbar');

    if (!sidebar) return;

    _restoreCollapseState(sidebar, appMain, topbar);
    _bindToggle(sidebar, appMain, topbar);
    _bindMobileOverlay(sidebar);
    _bindSignOut();
  }

  /**
   * Update user display name at runtime.
   * @param {string} name
   * @param {string} [role]
   */
  function updateUser(name, role) {
    var nameEl = document.getElementById('sidebarUserName');
    var roleEl = document.getElementById('sidebarUserRole');
    if (nameEl && name) nameEl.textContent = name;
    if (roleEl && role) roleEl.textContent = ROLE_LABEL[role] || role;
  }

  /** Cleanup all listeners and remove injected overlay */
  function destroy() {
    _cleanupFns.forEach(function (fn) { try { fn(); } catch (_) {} });
    _cleanupFns = [];

    /* Remove injected overlay */
    var overlay = document.getElementById('mobileSidebarOverlay');
    if (overlay && overlay.parentNode === document.body) {
      overlay.parentNode.removeChild(overlay);
    }

    /* Restore body scroll */
    document.body.style.overflow = '';
  }

  window.Sidebar = { init: init, updateUser: updateUser, destroy: destroy };
  console.info('[Sidebar] ready');

})(window);