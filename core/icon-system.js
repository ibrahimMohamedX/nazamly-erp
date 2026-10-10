/**
 * core/icon-system.js — Icon System v3 (in-place Lucide rendering)
 * =============================================================
 * Upgrades Font Awesome (solid glyphs) to Lucide (modern stroke
 * icons) WITHOUT breaking page scripts:
 *
 *   1. Finds every <i class="fa-… fa-<name>"> element
 *   2. Looks up <name> in the FA→Lucide mapping table below
 *   3. Builds the Lucide SVG and injects it INSIDE the <i>
 *      — the <i> itself is NEVER replaced or removed.
 *
 * Why in-place (v3 — fixes the v1/v2 regression):
 *   lucide.createIcons() REPLACES the <i> with an <svg>. Page
 *   scripts hold references to those elements (getElementById,
 *   querySelector('i')) and re-class them dynamically:
 *     iconEl.className = 'fas fa-cart-plus'   // orders.js etc.
 *   SVGElement.className is a read-only getter, so that
 *   assignment THREW (TypeError) and modals stopped opening.
 *   With the <i> kept in the DOM:
 *     - className assignment works natively (HTMLElement)
 *     - getElementById references stay valid forever
 *     - a MutationObserver (attributeFilter: class) catches
 *       dynamic re-classing and swaps the inner SVG — dynamic
 *       icon changes keep working, now as Lucide shapes.
 *
 * Graceful degradation (built-in):
 *   - The FA classes stay on the <i>; the FA ::before glyph is
 *     suppressed via [data-lucide] (an attribute — survives
 *     className rewrites). If lucide.js fails to load or a name
 *     isn't mapped, the Font Awesome glyph keeps rendering.
 *
 * Exposes window.IconSystem = { refresh() } for manual re-scans.
 */
(function (window, document) {
  'use strict';

  /* ══════════════════════════════════════════════
   * FA NAME → LUCIDE NAME MAPPING
   * ══════════════════════════════════════════════ */
  var MAPPING = {
    // General
    'check': 'check',
    'times': 'x',
    'xmark': 'x',
    'xmark-circle': 'circle-x',
    'circle-xmark': 'circle-x',
    'plus': 'plus',
    'plus-circle': 'circle-plus',
    'circle-notch': 'loader-circle',
    'copy': 'copy',
    'list': 'list',
    'table': 'table',
    'print': 'printer',
    'upload': 'upload',
    'rotate': 'refresh-cw',
    'rotate-left': 'rotate-ccw',
    'rotate-right': 'rotate-cw',
    'trash': 'trash-2',
    'trash-can': 'trash-2',
    'wrench': 'wrench',
    'sliders': 'sliders-horizontal',
    'palette': 'palette',
    'cog': 'settings',
    'gears': 'settings-2',
    'lock': 'lock',
    'shield-halved': 'shield-half',
    'skull-crossbones': 'skull',
    'pen': 'pen',
    'pen-to-square': 'square-pen',

    // People / roles
    'user': 'user',
    'users': 'users',
    'user-check': 'user-check',
    'user-pen': 'user-pen',
    'user-plus': 'user-plus',
    'user-shield': 'shield-check',
    'user-slash': 'user-x',
    'user-tie': 'briefcase',
    'address-book': 'book-user',
    'venus-mars': 'users',
    'handshake': 'handshake',

    // Communication
    'bell': 'bell',
    'bullhorn': 'megaphone',
    'envelope': 'mail',
    'paper-plane': 'send',
    'inbox': 'inbox',
    'whatsapp': 'message-circle',

    // Commerce / money
    'coins': 'coins',
    'money-bill-wave': 'banknote',
    'hand-holding-dollar': 'hand-coins',
    'credit-card': 'credit-card',
    'receipt': 'receipt',
    'file-invoice': 'receipt-text',
    'file-invoice-dollar': 'receipt',
    'cart-shopping': 'shopping-cart',
    'cart-plus': 'shopping-cart',
    'tag': 'tag',
    'tags': 'tags',
    'gift': 'gift',
    'crown': 'crown',
    'medal': 'medal',
    'trophy': 'trophy',
    'bullseye': 'target',
    'calculator': 'calculator',

    // Files
    'file': 'file',
    'file-excel': 'file-spreadsheet',
    'file-export': 'file-output',
    'file-import': 'file-input',
    'floppy-disk': 'save',

    // Charts / analytics
    'chart-area': 'chart-area',
    'chart-bar': 'chart-bar',
    'chart-line': 'chart-line',
    'chart-pie': 'chart-pie',
    'chart-donut': 'chart-pie',
    'arrow-trend-up': 'trending-up',
    'arrow-up-right-dots': 'arrow-up-right',
    'th-large': 'layout-grid',

    // Logistics
    'box': 'package',
    'boxes-stacked': 'boxes',
    'truck': 'truck',
    'truck-fast': 'truck',
    'truck-ramp-box': 'truck',
    'map-pin': 'map-pin',
    'globe': 'globe',

    // Calendar / time
    'clock': 'clock',
    'clock-rotate-left': 'history',
    'calendar-alt': 'calendar',
    'calendar-day': 'calendar-days',
    'calendar-days': 'calendar-days',
    'calendar-week': 'calendar-range',
    'calendar-check': 'calendar-check',

    // Status
    'check-circle': 'circle-check',
    'circle-check': 'circle-check',
    'circle-info': 'info',
    'info-circle': 'info',
    'circle-exclamation': 'circle-alert',
    'triangle-exclamation': 'triangle-alert',
    'pause-circle': 'circle-pause',
    'play-circle': 'play',

    // Navigation
    'arrow-left': 'arrow-left',
    'arrow-up': 'arrow-up',
    'arrow-down': 'arrow-down',
    'arrow-right-from-bracket': 'log-out',
    'bars': 'menu',
    'chevron-left': 'chevron-left',
    'chevron-right': 'chevron-right',
    'grip-vertical': 'grip-vertical',
    'magnifying-glass': 'search',
    'house': 'house',

    // Misc (page scripts)
    'arrow-trend-down': 'trending-down',
    'building': 'building',
    'circle': 'circle',
    'cogs': 'settings-2',
    'ellipsis': 'ellipsis',
    'eye': 'eye',
    'eye-slash': 'eye-off',
    'moon': 'moon',
    'sun': 'sun',
    'pause': 'pause',
    'play': 'play',
    'plane-departure': 'plane-takeoff',
    'star': 'star',
    'user-tag': 'user-round'
  };

  /* ══════════════════════════════════════════════
   * STATE
   * ══════════════════════════════════════════════ */
  var ICON_SELECTOR = 'i[class*="fa-"]';
  var pending = [];
  var queued = false;
  var observer = null;
  var started = false;

  /* ══════════════════════════════════════════════
   * HELPERS
   * ══════════════════════════════════════════════ */

  function lucideAvailable() {
    return typeof window.lucide === 'object' &&
      window.lucide !== null &&
      typeof window.lucide.icons === 'object';
  }

  function toPascalCase(kebab) {
    return kebab.replace(/(^|-)([a-z0-9])/g, function (_, p1, p2) {
      return p2.toUpperCase();
    });
  }

  /** Build an SVG element from a Lucide IconNode array
   *  (recursively): [tag, attrs, children]. */
  function buildSvgNode(node) {
    if (!Array.isArray(node) || typeof node[0] !== 'string') return null;
    var el = document.createElementNS('http://www.w3.org/2000/svg', node[0]);
    var attrs = node[1];
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          el.setAttribute(key, attrs[key]);
        }
      }
    }
    var children = node[2];
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i++) {
        var child = buildSvgNode(children[i]);
        if (child) el.appendChild(child);
      }
    }
    return el;
  }

  /** Create the Lucide <svg> for a kebab-case icon name. */
  function createLucideSvg(lucideName) {
    var icons = window.lucide.icons;
    var node = icons[toPascalCase(lucideName)];
    if (!node) return null;
    var svg = buildSvgNode(node);
    if (svg) {
      svg.classList.add('lucide');
      svg.setAttribute('aria-hidden', 'true');
    }
    return svg;
  }

  /** Extract the intended FA icon name from an element's classes.
   *  Iterates from the END so the most recently added class wins
   *  (matches how scripts re-class icons dynamically). */
  function resolveIcon(el) {
    var classes = el.classList;
    for (var i = classes.length - 1; i >= 0; i--) {
      var cls = classes[i];
      if (cls.indexOf('fa-') !== 0) continue;
      var name = cls.slice(3);
      if (Object.prototype.hasOwnProperty.call(MAPPING, name)) {
        return MAPPING[name];
      }
    }
    return null;
  }

  /** Convert / re-target an <i> IN PLACE.
   *  Returns true when the rendered icon changed. */
  function convert(el) {
    if (!el || el.tagName !== 'I') return false;
    var lucideName = resolveIcon(el);
    if (!lucideName) return false;

    var current = el.getAttribute('data-lucide');
    if (current === lucideName) return false; // already showing it

    var svg = createLucideSvg(lucideName);
    if (!svg) return false; // unmapped/missing icon → FA keeps rendering

    // Mark as converted (attribute — survives className rewrites)
    el.setAttribute('data-lucide', lucideName);

    // Drop any previous injected svg, keep other content (text etc.)
    var oldSvgs = el.querySelectorAll('svg');
    for (var i = 0; i < oldSvgs.length; i++) oldSvgs[i].remove();

    el.appendChild(svg);
    return true;
  }

  function processQueue() {
    if (!pending.length) return;
    for (var i = 0; i < pending.length; i++) {
      convert(pending[i]);
    }
    pending.length = 0;
    queued = false;
  }

  function queueEl(el) {
    pending.push(el);
    if (queued) return;
    queued = true;
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(processQueue);
    } else {
      setTimeout(processQueue, 16);
    }
  }

  /** Scan a root (document or added subtree) for convertible icons. */
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    var els = root.querySelectorAll(ICON_SELECTOR);
    for (var i = 0; i < els.length; i++) queueEl(els[i]);
  }

  /* ══════════════════════════════════════════════
   * MUTATION OBSERVER
   * - childList: converts dynamically injected icons (toasts,
   *   modals, table rows built by vision-*.js / page scripts)
   * - attributes(class): re-targets icons that scripts
   *   re-class dynamically (e.g. iconEl.className = 'fas fa-pen')
   * ══════════════════════════════════════════════ */
  function startObserver() {
    if (observer || typeof window.MutationObserver !== 'function') return;
    observer = new window.MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'attributes') {
          // Cheap filter first: only <i> elements matter here.
          if (m.target.tagName === 'I') queueEl(m.target);
          continue;
        }
        var added = m.addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue; // elements only
          if (node.tagName === 'I') {
            queueEl(node);
          } else if (node.querySelectorAll) {
            var els = node.querySelectorAll(ICON_SELECTOR);
            for (var k = 0; k < els.length; k++) queueEl(els[k]);
          }
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  /* ══════════════════════════════════════════════
   * INIT
   * ══════════════════════════════════════════════ */

  function start() {
    if (started) return;
    started = true;

    if (!lucideAvailable()) {
      if (window.console) console.info('[IconSystem] lucide not loaded — Font Awesome fallback stays active.');
      return; // FA keeps rendering everything; nothing else to do
    }

    scan(document);
    startObserver();
  }

  // lucide.js is loaded with `defer` BEFORE this file, so it is normally
  // available immediately. Guard against slow/failed CDNs anyway:
  if (lucideAvailable()) {
    start();
  } else {
    var attempts = 0;
    var retry = setInterval(function () {
      attempts++;
      if (lucideAvailable()) {
        clearInterval(retry);
        start();
      } else if (attempts >= 10) {
        clearInterval(retry);
        if (window.console) console.info('[IconSystem] lucide unavailable — Font Awesome fallback stays active.');
      }
    }, 500);
  }

  /* ══════════════════════════════════════════════
   * PUBLIC API
   * ══════════════════════════════════════════════ */
  window.IconSystem = {
    /** Manually re-scan the document and convert any new icons. */
    refresh: function () {
      scan(document);
      processQueue();
    },
    /** Exposed for debugging/extension. */
    mapping: MAPPING
  };
})(window, document);
