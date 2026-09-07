#!/usr/bin/env node
/**
 * Headless-Chromium smoke probe for map.html (Tier 3/4, optional).
 *
 * Opens the code map against a local static server and asserts the behaviour
 * the redesign promises: the workspace opens on SeLe4n.Kernel.API with no URL
 * state, over-budget lanes are grouped by subsystem and open in place, the
 * declaration sidebar drives declaration context, the Rust crate cards and the
 * repository inventory render from the bundled snapshot, no viewport scrolls
 * horizontally, and the console stays clean — at desktop, tablet and phone
 * widths, in both themes, and through a Spanish deep link.
 *
 * Live GitHub refreshes are blocked inside the page so the run is deterministic
 * and equivalent to an offline visit.
 *
 * Requirements (not repository dependencies):
 *   npm install playwright-core            # any directory on NODE_PATH, or next to this script
 *   python3 -m http.server 4173 --bind 127.0.0.1   # from the repository root
 *
 * Environment:
 *   MAP_SMOKE_BASE        server origin           (default http://127.0.0.1:4173)
 *   PLAYWRIGHT_CHROMIUM   Chromium executable     (default: Playwright's own lookup)
 *   MAP_SMOKE_SHOTS       directory for screenshots (default: none)
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed; see the header of this script.');
  process.exit(2);
}

const BASE = process.env.MAP_SMOKE_BASE || 'http://127.0.0.1:4173';
const SHOTS = process.env.MAP_SMOKE_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(launchOptions);

let failures = 0;
const DEBUG = Boolean(process.env.MAP_SMOKE_DEBUG);
async function trace(page, label) {
  if (!DEBUG) return;
  const snapshot = await page.evaluate(() => ({
    search: document.getElementById('module-search').value,
    url: location.search,
    active: document.activeElement ? `${document.activeElement.tagName}#${document.activeElement.id}.${document.activeElement.className}` : null,
    scrollY: Math.round(window.scrollY),
    openSubgroups: document.querySelectorAll('.inventory-subgroup[open]').length,
    moduleButtons: document.querySelectorAll('.inventory-module-btn').length
  }));
  console.log(`    trace ${label.padEnd(24)} ${JSON.stringify(snapshot)}`);
}
function check(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures += 1;
}

async function open(width, height, { theme = 'dark', query = '', locale = 'en' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale });
  await context.addInitScript(([t, l]) => {
    try { localStorage.setItem('sele4n-theme', t); } catch (e) {}
    try { localStorage.setItem('sele4n-locale', l); } catch (e) {}
    const origFetch = window.fetch;
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && /github/.test(url)) return Promise.reject(new Error('blocked by map-smoke'));
      return origFetch.call(this, url, opts);
    };
  }, [theme, locale]);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  await page.goto(`${BASE}/map.html${query}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const status = document.getElementById('map-status');
    return status && !/Loading codebase map/.test(status.textContent);
  }, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  return { context, page, errors };
}

function metrics(page) {
  return page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
    };
    return {
      url: location.search,
      search: document.getElementById('module-search').value,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      wrap: rect('#flowchart-wrap'),
      sidebar: rect('.declaration-explorer'),
      laneGroups: document.querySelectorAll('.flow-node.lane-group').length,
      tabs: Array.from(document.querySelectorAll('.interior-menu-tab')).map((t) => t.getAttribute('aria-selected')),
      declarationItems: document.querySelectorAll('.interior-menu-item').length,
      stats: Array.from(document.querySelectorAll('[data-map]')).map((el) => `${el.getAttribute('data-map')}=${el.textContent}`),
      crates: document.querySelectorAll('.rust-crate').length,
      crateStrip: Boolean(document.querySelector('.rust-dependency-svg')),
      inventoryGroups: Array.from(document.querySelectorAll('.inventory-group')).map((g) => g.dataset.group + (g.open ? '(open)' : '')),
      h2s: Array.from(document.querySelectorAll('h2')).map((h) => h.textContent)
    };
  });
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

{
  console.log('\n[desktop 1440x900 dark]');
  const { context, page, errors } = await open(1440, 900);
  const m = await metrics(page);
  check(m.search === 'SeLe4n.Kernel.API', 'workspace opens on SeLe4n.Kernel.API');
  check(m.url === '' || /module=SeLe4n\.Kernel\.API/.test(m.url), 'first-load URL is clean or names the default module');
  check(m.laneGroups >= 5, `over-budget lanes are grouped by subsystem (${m.laneGroups} groups)`);
  check(m.tabs.length === 3 && m.tabs[0] === 'true', 'declaration sidebar shows three tabs with Objects selected');
  check(m.declarationItems > 100, `declaration list populated (${m.declarationItems})`);
  check(m.crates === 4 && m.crateStrip, 'four Rust crate cards and the dependency strip rendered');
  check(m.inventoryGroups.join(',') === 'lean(open),rust(open),tests,scripts,docs,project', `inventory groups in order, production open (${m.inventoryGroups.join(',')})`);
  check(m.scrollWidth <= m.innerWidth, 'no horizontal page overflow');
  check(m.sidebar && m.sidebar.left > m.wrap.left + m.wrap.width - 5, 'sidebar sits beside the chart');
  check(m.wrap.top < 900, `chart starts inside the first viewport (top=${m.wrap.top})`);
  check(m.stats.some((s) => s === 'rustCrates=4'), 'Rust crates stat = 4');
  check(errors.length === 0, `no console errors ${JSON.stringify(errors)}`);
  await shot(page, 'desktop-dark');

  const before = await page.evaluate(() => document.querySelectorAll('.flow-node-layer .flow-node').length);
  await page.click('.flow-node.lane-group');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    nodes: document.querySelectorAll('.flow-node-layer .flow-node').length,
    open: document.querySelectorAll('.flow-node.lane-group-open').length,
    members: document.querySelectorAll('.flow-node.lane-member').length
  }));
  check(after.open === 1 && after.members > 1 && after.nodes > before, `a subsystem group opens in place ${JSON.stringify(after)}`);

  await page.click('.flow-node.lane-member');
  await page.waitForTimeout(300);
  check((await metrics(page)).search !== 'SeLe4n.Kernel.API', 'clicking an opened member selects that module');

  await page.click('#module-search', { clickCount: 3 });
  await page.keyboard.type('SeLe4n.Kernel.API');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.click('.interior-menu-item-btn');
  await page.waitForTimeout(400);
  const decl = await page.evaluate(() => ({
    breadcrumb: Boolean(document.querySelector('.declaration-context-breadcrumb')),
    active: document.querySelectorAll('.interior-menu-item-active').length,
    url: location.search
  }));
  check(decl.breadcrumb && decl.active === 1 && /decl=/.test(decl.url), 'a sidebar declaration click enters declaration context right after a search');

  await page.click('#reset-view');
  await page.waitForTimeout(400);
  const reset = await metrics(page);
  check(reset.search === 'SeLe4n.Kernel.API' && !/decl=/.test(reset.url), 'reset returns to the default module view');
  await trace(page, 'after reset');

  await page.click('.inventory-group[data-group="lean"] .inventory-subgroup summary');
  await page.waitForTimeout(200);
  await trace(page, 'after subgroup open');
  await page.click('.inventory-module-btn');
  await trace(page, 'after module click');
  let scrolled = false;
  try {
    await page.waitForFunction(() => document.getElementById('module-graph').getBoundingClientRect().top < 200, null, { timeout: 4000 });
    // The scroll must also settle there: scroll anchoring once dragged the
    // viewport back to the inventory after the workspace had been reached.
    await page.waitForTimeout(900);
    scrolled = await page.evaluate(() => document.getElementById('module-graph').getBoundingClientRect().top < 200);
  } catch {}
  const afterInventory = await metrics(page);
  const workspaceTop = await page.evaluate(() => Math.round(document.getElementById('module-graph').getBoundingClientRect().top));
  check(scrolled && afterInventory.search !== 'SeLe4n.Kernel.API', `an inventory module opens in the workspace and the scroll settles there (module=${afterInventory.search}, workspace top=${workspaceTop})`);

  await page.click('#crate-sele4n-sys .rust-file-summary');
  await page.waitForTimeout(200);
  const productionItems = await page.evaluate(() => document.querySelectorAll('#crate-sele4n-sys .rust-item').length);
  check(productionItems > 0, 'a crate file expands into its item list');
  check((await page.evaluate(() => document.querySelectorAll('#crate-sele4n-sys .rust-item-test').length)) === 0, 'test items are hidden by default');
  await page.click('#crate-sele4n-sys .rust-tests-toggle');
  await page.waitForTimeout(300);
  // The crate root has no test code; open a module file that does.
  await page.click('#crate-sele4n-sys .rust-file[data-role="module"] .rust-file-summary');
  await page.waitForTimeout(300);
  const toggled = await page.evaluate(() => ({
    pressed: document.querySelector('#crate-sele4n-sys .rust-tests-toggle').getAttribute('aria-pressed'),
    open: document.querySelectorAll('#crate-sele4n-sys .rust-file-details[open]').length,
    items: document.querySelectorAll('#crate-sele4n-sys .rust-item').length,
    testItems: document.querySelectorAll('#crate-sele4n-sys .rust-item-test').length
  }));
  check(toggled.pressed === 'true' && toggled.open === 2 && toggled.items > productionItems && toggled.testItems > 0, `the test-item toggle keeps the open file open and lists flagged test items ${JSON.stringify(toggled)}`);
  check(errors.length === 0, `still no console errors after interactions ${JSON.stringify(errors)}`);
  await context.close();
}

{
  console.log('\n[desktop 1440x900 light]');
  const { context, page, errors } = await open(1440, 900, { theme: 'light' });
  check((await metrics(page)).search === 'SeLe4n.Kernel.API', 'default module (light)');
  check(errors.length === 0, 'no console errors (light)');
  await shot(page, 'desktop-light');
  await context.close();
}

{
  console.log('\n[tablet 1024x768]');
  const { context, page, errors } = await open(1024, 768);
  const m = await metrics(page);
  check(m.scrollWidth <= m.innerWidth, 'no horizontal overflow at 1024');
  check(m.sidebar && m.sidebar.top >= m.wrap.top + m.wrap.height - 2, 'sidebar stacks below the chart at 1024');
  check(errors.length === 0, 'no console errors (tablet)');
  await shot(page, 'tablet');
  await context.close();
}

{
  console.log('\n[phone 390x844]');
  const { context, page, errors } = await open(390, 844);
  const m = await metrics(page);
  check(m.scrollWidth <= m.innerWidth, 'no horizontal page overflow at 390');
  check(m.search === 'SeLe4n.Kernel.API', 'default module (phone)');
  check(errors.length === 0, 'no console errors (phone)');
  await shot(page, 'phone');
  await context.close();
}

{
  console.log('\n[deep link, es]');
  const { context, page, errors } = await open(1440, 900, { query: '?module=SeLe4n.Model.State&decl=SystemState', locale: 'es' });
  const m = await metrics(page);
  check(m.search === 'SeLe4n.Model.State.SystemState', 'deep link restores declaration context');
  check(m.h2s.some((h) => /Espacio de trabajo/.test(h)), 'section headings translated');
  check(errors.length === 0, 'no console errors (es)');
  await context.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nmap-smoke: all checks passed');
process.exit(failures ? 1 : 0);
