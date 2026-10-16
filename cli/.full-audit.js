// Full-project consistency audit — safe to delete.
// Cross-references: DOM ids, script srcs, page links, module loads.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

const PAGES = ['index.html','login.html','dashboard.html','orders.html','inventory.html',
  'employees.html','purchases.html','expenses.html','awb.html','recovery.html',
  'shipping-settings.html','suspended.html'];

const findings = [];
function report(severity, area, msg) { findings.push({ severity, area, msg }); }

/* ── 1. Syntax check all project JS ── */
const { execSync } = require('child_process');
const jsDirs = ['core', 'pages', 'shared'];
for (const dir of jsDirs) {
  for (const f of fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js'))) {
    try {
      execSync(`node --check "${path.join(root, dir, f)}"`, { stdio: 'pipe' });
    } catch (e) {
      report('ERROR', 'syntax', `${dir}/${f}: ${String(e.stderr).split('\n')[0]}`);
    }
  }
}

/* ── 2. Per-page: script srcs exist? ids referenced by loaded JS exist? duplicate ids? ── */
function pageJsFor(htmlName) {
  const base = htmlName.replace('.html', '');
  const map = { dashboard: 'dashboard', orders: 'orders', inventory: 'inventory',
    employees: 'employees', purchases: 'purchases', expenses: 'expenses',
    awb: 'awb', 'shipping-settings': 'shipping', index: 'index', login: null,
    recovery: null, suspended: null };
  return map[base] ? `pages/${map[base]}.js` : null;
}

const globalIds = new Set(); // union across pages
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(root, page), 'utf-8');

  // ids defined
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  for (const id of ids) globalIds.add(id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupIds.length) report('ERROR', 'duplicate-id', `${page}: duplicate ids: ${[...new Set(dupIds)].join(', ')}`);

  // script srcs exist?
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const src = m[1];
    if (src.startsWith('http') || src.startsWith('{{')) continue;
    if (!fs.existsSync(path.join(root, src))) report('ERROR', 'missing-file', `${page}: <script src="${src}"> — file not found`);
  }
  // css links exist?
  for (const m of html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) {
    if (m[1].startsWith('http')) continue;
    if (!fs.existsSync(path.join(root, m[1]))) report('ERROR', 'missing-file', `${page}: <link href="${m[1]}"> — file not found`);
  }
  // internal page links exist?
  for (const m of html.matchAll(/href="([a-zA-Z0-9-]+\.html)"/g)) {
    if (!fs.existsSync(path.join(root, m[1]))) report('ERROR', 'missing-file', `${page}: href="${m[1]}" — target page not found`);
  }

  // ids referenced by the page-specific JS
  const jsPath = pageJsFor(page);
  if (jsPath && fs.existsSync(path.join(root, jsPath))) {
    const js = fs.readFileSync(path.join(root, jsPath), 'utf-8');
    const refs = new Set();
    for (const m of js.matchAll(/_el\(\s*['"]([^'"]+)['"]/g)) refs.add(m[1]);
    for (const m of js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) refs.add(m[1]);
    const pageIds = new Set(ids);
    for (const ref of refs) {
      if (!pageIds.has(ref)) {
        const optional = new RegExp(`_el\\(\\s*['"]${ref}['"]\\s*\\)\\s*\\?`).test(js);
        report(optional ? 'WARN' : 'ERROR', 'missing-id',
          `${page}: ${jsPath} references id "${ref}" — not in page HTML${optional ? ' (optional-chained)' : ''}`);
      }
    }
  } else if (jsPath && !fs.existsSync(path.join(root, jsPath))) {
    report('ERROR', 'missing-file', `${page}: expected page script ${jsPath} not found`);
  }
}

/* ── 3. shared/*.js — loaded by any page? ── */
for (const f of fs.readdirSync(path.join(root, 'shared')).filter(f => f.endsWith('.js'))) {
  const loaded = PAGES.some(p => fs.readFileSync(path.join(root, p), 'utf-8').includes(`shared/${f}`));
  if (!loaded) report('WARN', 'orphan-file', `shared/${f} is not loaded by any page`);
}

/* ── 4. vision module loads: modules referenced by vision-init.js exist? ── */
const visionInit = fs.readFileSync(path.join(root, 'core', 'vision-init.js'), 'utf-8');
for (const m of visionInit.matchAll(/"(vision-[a-z-]+\.js)"/g)) {
  if (!fs.existsSync(path.join(root, 'core', m[1]))) report('ERROR', 'missing-file', `vision-init.js loads core/${m[1]} — not found`);
}

/* ── 5. vision-*.js DOM refs: classes/ids they query exist somewhere? ── */
const cssAll = ['variables','base','components','overlays','light-theme']
  .map(f => fs.readFileSync(path.join(root, 'styles', f + '.css'), 'utf-8')).join('\n')
  + fs.readdirSync(path.join(root, 'styles', 'pages')).map(f => fs.readFileSync(path.join(root, 'styles', 'pages', f), 'utf-8')).join('\n');
const htmlAll = PAGES.map(p => fs.readFileSync(path.join(root, p), 'utf-8')).join('\n');
for (const f of fs.readdirSync(path.join(root, 'core')).filter(f => f.startsWith('vision-'))) {
  const js = fs.readFileSync(path.join(root, 'core', f), 'utf-8');
  for (const m of js.matchAll(/querySelector(?:All)?\(\s*['"]\.([a-zA-Z0-9_-]+)/g)) {
    const cls = m[1];
    if (!htmlAll.includes(cls) && !cssAll.includes('.' + cls) && !js.includes('className') && !js.includes("classList.add('" + cls)) {
      report('WARN', 'unstyled-ref', `${f}: queries .${cls} — not found in HTML or CSS`);
    }
  }
}

/* ── 6. inline onclick handlers reference defined functions? ── */
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(root, page), 'utf-8');
  const jsPath = pageJsFor(page);
  let js = '';
  if (jsPath && fs.existsSync(path.join(root, jsPath))) js += fs.readFileSync(path.join(root, jsPath), 'utf-8');
  // inline scripts
  for (const m of html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) js += '\n' + m[1];
  for (const m of html.matchAll(/\sonclick="([a-zA-Z_$][\w$]*)\(/g)) {
    const fn = m[1];
    const defined = new RegExp(`(function\\s+${fn}\\b|const\\s+${fn}\\b|let\\s+${fn}\\b|var\\s+${fn}\\b|window\\.${fn}\\s*=|${fn}\\s*\\([^)]*\\)\\s*\\{)`, 'm').test(js);
    if (!defined) report('ERROR', 'undefined-handler', `${page}: onclick="${fn}(...)" — function not defined in page JS or inline scripts`);
  }
}

/* ── 7. console.error / known-crash patterns in page JS ── */
for (const f of fs.readdirSync(path.join(root, 'pages')).filter(f => f.endsWith('.js'))) {
  const js = fs.readFileSync(path.join(root, 'pages', f), 'utf-8');
  // bare (non-optional) _el(...).member access — crash if id missing
  for (const m of js.matchAll(/_el\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*[a-zA-Z_[]/g)) {
    const id = m[1];
    const pageFor = { 'orders.js': 'orders.html', 'inventory.js': 'inventory.html', 'expenses.js': 'expenses.html',
      'employees.js': 'employees.html', 'purchases.js': 'purchases.html', 'dashboard.js': 'dashboard.html',
      'index.js': 'index.html', 'shipping.js': 'shipping-settings.html', 'awb.js': 'awb.html' }[f];
    if (!pageFor) continue;
    const html = fs.readFileSync(path.join(root, pageFor), 'utf-8');
    if (!html.includes(`id="${id}"`)) {
      report('ERROR', 'unsafe-ref', `pages/${f}: _el('${id}').… without optional chaining — id not in ${pageFor}`);
    }
  }
}

/* ── Report ── */
const order = { ERROR: 0, WARN: 1 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);
let errs = 0, warns = 0;
for (const f of findings) {
  const icon = f.severity === 'ERROR' ? '✖' : '⚠';
  console.log(`${icon} [${f.area}] ${f.msg}`);
  if (f.severity === 'ERROR') errs++; else warns++;
}
console.log(`\n=== ${errs} errors, ${warns} warnings ===`);
process.exit(errs ? 1 : 0);
