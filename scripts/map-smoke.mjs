#!/usr/bin/env node
/**
 * Headless-Chromium smoke probe for map.html (Tier 3/4).
 *
 * Opens the code map against a local static server and asserts what the unit
 * tests cannot see: that the page lays out and behaves as promised in a real
 * browser. The checks that matter most are the ones that once let a broken
 * build through — the flow chart is drawn at 1:1 at every desktop width (a
 * fixed 1180px minimum was being scaled to 58–86% beside the sidebar), the
 * declaration sidebar sits beside the chart only from 1440px and fits a
 * 720px-tall viewport while pinned, no viewport scrolls sideways, and the
 * console stays clean — at desktop, laptop, tablet and phone widths, in both
 * themes, and through a Spanish deep link.
 *
 * Live GitHub refreshes are blocked inside the page so the run is deterministic
 * and equivalent to an offline visit.
 *
 * Requirements (not repository dependencies):
 *   npm install --no-save playwright-core       # or any directory on NODE_PATH
 *   python3 -m http.server 4173 --bind 127.0.0.1   # from the repository root
 *
 * Environment:
 *   MAP_SMOKE_BASE        server origin               (default http://127.0.0.1:4173)
 *   PLAYWRIGHT_CHROMIUM   Chromium executable path    (default: Playwright's own lookup)
 *   MAP_SMOKE_CHANNEL     browser channel, e.g. chrome (uses the machine's Chrome; CI does this)
 *   MAP_SMOKE_SHOTS       directory for screenshots   (default: none)
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
else if (process.env.MAP_SMOKE_CHANNEL) launchOptions.channel = process.env.MAP_SMOKE_CHANNEL;
const browser = await chromium.launch(launchOptions);

let failures = 0;
function check(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures += 1;
}

async function open(width, height, { theme = 'dark', query = '', locale = 'en', holdLocaleMs = 0 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale });
  await context.addInitScript(([t, l]) => {
    try { localStorage.setItem('sele4n-theme', t); } catch (e) {}
    try { localStorage.setItem('sele4n-locale-v1', l); } catch (e) {}
    const origFetch = window.fetch;
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && /github/.test(url)) return Promise.reject(new Error('blocked by map-smoke'));
      return origFetch.call(this, url, opts);
    };
  }, [theme, locale]);
  const page = await context.newPage();
  // Hold the locale JSON back so it lands after the snapshot has painted.
  if (holdLocaleMs) {
    await page.route(/\/locales\/[a-z-]+\.json(\?.*)?$/i, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, holdLocaleMs));
      await route.continue();
    });
  }
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
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom) };
    };
    const svg = document.querySelector('.flowchart-svg');
    const wrap = document.getElementById('flowchart-wrap');
    return {
      url: location.search,
      search: document.getElementById('module-search').value,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      wrap: rect('#flowchart-wrap'),
      sidebar: rect('.declaration-explorer'),
      chart: svg ? {
        attr: Number(svg.getAttribute('width')),
        rendered: svg.getBoundingClientRect().width,
        wrapClient: wrap.clientWidth,
        wrapScroll: wrap.scrollWidth
      } : null,
      laneGroups: document.querySelectorAll('.flow-node.lane-group').length,
      tabs: Array.from(document.querySelectorAll('.interior-menu-tab')).map((t) => t.getAttribute('aria-selected')),
      declarationItems: document.querySelectorAll('.interior-menu-item').length,
      stats: Array.from(document.querySelectorAll('[data-map]')).map((el) => `${el.getAttribute('data-map')}=${el.textContent}`),
      // @cards-start
      crates: document.querySelectorAll('.rust-crate').length,
      crateStrip: Boolean(document.querySelector('.rust-dependency-svg')),
      inventoryGroups: Array.from(document.querySelectorAll('.inventory-group')).map((g) => g.dataset.group + (g.open ? '(open)' : '')),
      // @cards-end
      h2s: Array.from(document.querySelectorAll('h2')).map((h) => h.textContent)
    };
  });
}

/* The chart is drawn at 1:1 when its rendered width equals its `width`
   attribute; anything else means CSS scaled it to fit its column. */
function chartAtScale(m) {
  return Boolean(m.chart) && Math.abs(m.chart.rendered - m.chart.attr) <= 1;
}
function chartSummary(m) {
  return m.chart ? `layout ${m.chart.attr}px, rendered ${Math.round(m.chart.rendered)}px in a ${m.chart.wrapClient}px frame` : 'no chart';
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
  check(m.scrollWidth <= m.innerWidth, 'no horizontal page overflow');
  check(m.sidebar && m.sidebar.left > m.wrap.left + m.wrap.width - 5, 'sidebar sits beside the chart at 1440');
  check(chartAtScale(m), `flow chart drawn at 1:1 (${chartSummary(m)})`);
  check(m.wrap.top < 900, `chart starts inside the first viewport (top=${m.wrap.top})`);
  // @cards-start
  check(m.crates === 4 && m.crateStrip, 'four Rust crate cards and the dependency strip rendered');
  check(m.inventoryGroups.join(',') === 'lean(open),rust(open),tests,scripts,docs,project', `inventory groups in order, production open (${m.inventoryGroups.join(',')})`);
  const testSubgroups = await page.evaluate(() => Array.from(document.querySelectorAll('.inventory-group[data-group="tests"] .inventory-subgroup-key')).map((el) => el.textContent.trim()));
  check(['rust/sele4n-abi/tests', 'rust/sele4n-hal/tests'].every((key) => testSubgroups.some((text) => text.indexOf(key) !== -1)), `the crates' integration tests are filed under Tests (${testSubgroups.filter((text) => /rust\//.test(text)).join(', ') || 'none'})`);
  check(m.stats.some((s) => s === 'rustCrates=4'), 'Rust crates stat = 4');
  // @cards-end
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

  // @cards-start
  await page.click('.inventory-group[data-group="lean"] .inventory-subgroup summary');
  await page.waitForTimeout(200);
  await page.click('.inventory-module-btn');
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

  const cardHeights = await page.evaluate(() => Array.from(document.querySelectorAll('.rust-crate'), (c) => Math.round(c.getBoundingClientRect().height)));
  check(cardHeights.length === 4 && Math.max(...cardHeights) <= 1400, `crate cards are bounded in height (${cardHeights.join(', ')})`);

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
  const rustFacts = await page.evaluate(() => ({
    abiUnsafeCell: (document.querySelector('#crate-sele4n-abi .rust-stat-unsafe dd') || {}).textContent || '',
    halUnsafeCell: (document.querySelector('#crate-sele4n-hal .rust-stat-unsafe dd') || {}).textContent || '',
    abiStripNode: (document.querySelector('a[href="#crate-sele4n-abi"] .rust-dependency-node') || { getAttribute: () => '' }).getAttribute('class') || '',
    lintFacts: Array.from(document.querySelectorAll('.rust-crate-facts')).filter((p) => /deny\(unsafe_code\)/.test(p.textContent)).length,
    halFacts: (document.querySelector('#crate-sele4n-hal .rust-crate-facts') || {}).textContent || '',
    supportLinks: document.querySelectorAll('.inventory-crate-support .inventory-file-link').length,
    singular: Array.from(document.querySelectorAll('.inventory-subgroup-meta, .rust-crate-facts, .rust-stat-unsafe dd')).map((el) => el.textContent).filter((text) => /\b1 (files|modules|theorems|blocks|impls|crates)\b|\b0 (impl|impls|blocks|fn)\b/.test(text))
  }));
  check(/3 sites/.test(rustFacts.abiUnsafeCell) && /rust-unsafe/.test(rustFacts.abiStripNode), `sele4n-abi shows its three counted sites despite its deny lint ${JSON.stringify(rustFacts.abiUnsafeCell)}`);
  check(/99 sites/.test(rustFacts.halUnsafeCell), `sele4n-hal shows its production sites only (${JSON.stringify(rustFacts.halUnsafeCell)})`);
  check(rustFacts.lintFacts === 3, `three crates state #![deny(unsafe_code)] as a separate fact (${rustFacts.lintFacts})`);
  check(/cfg\(loom\)/.test(rustFacts.halFacts) && !/external/.test(rustFacts.halFacts), `loom is shown under its cfg, not as an external dependency (${JSON.stringify(rustFacts.halFacts)})`);
  check(rustFacts.supportLinks >= 4, `crate support files are linked from the inventory (${rustFacts.supportLinks})`);
  check(rustFacts.singular.length === 0, `count labels are pluralized ${JSON.stringify(rustFacts.singular)}`);

  // A locale switch and a live refresh both repaint the sections; whatever the
  // reader had open must survive the repaint.
  await page.click('.inventory-group[data-group="tests"] > summary');
  await page.waitForTimeout(200);
  const openBefore = await page.evaluate(() => ({
    tests: document.querySelector('.inventory-group[data-group="tests"]').open,
    subgroups: document.querySelectorAll('.inventory-subgroup[open]').length,
    files: document.querySelectorAll('#crate-sele4n-sys .rust-file-details[open]').length
  }));
  await page.evaluate(() => window.dispatchEvent(new Event('sele4n:locale-changed')));
  await page.waitForTimeout(500);
  const openAfter = await page.evaluate(() => ({
    tests: document.querySelector('.inventory-group[data-group="tests"]').open,
    subgroups: document.querySelectorAll('.inventory-subgroup[open]').length,
    files: document.querySelectorAll('#crate-sele4n-sys .rust-file-details[open]').length,
    pressed: document.querySelector('#crate-sele4n-sys .rust-tests-toggle').getAttribute('aria-pressed')
  }));
  check(openBefore.tests && openAfter.tests && openAfter.subgroups === openBefore.subgroups && openAfter.files === openBefore.files && openAfter.pressed === 'true', `open groups, subgroups and files survive a re-render ${JSON.stringify({ openBefore, openAfter })}`);
  // @cards-end
  check(errors.length === 0, `still no console errors after interactions ${JSON.stringify(errors)}`);
  await context.close();
}

for (const [width, height, beside] of [[1920, 900, true], [1536, 864, true], [1440, 900, true], [1366, 768, false], [1280, 900, false], [1200, 800, false]]) {
  console.log(`\n[desktop ${width}x${height}]`);
  const { context, page, errors } = await open(width, height);
  const m = await metrics(page);
  check(chartAtScale(m), `flow chart drawn at 1:1 (${chartSummary(m)})`);
  check(m.scrollWidth <= m.innerWidth, 'no horizontal page overflow');
  if (beside) check(m.sidebar && m.sidebar.left > m.wrap.left + m.wrap.width - 5, 'sidebar sits beside the chart');
  else check(m.sidebar && m.sidebar.top >= m.wrap.top + m.wrap.height - 2, 'sidebar stacks below the chart');
  check(errors.length === 0, `no console errors ${JSON.stringify(errors)}`);
  await context.close();
}

{
  console.log('\n[desktop 1440x720, sidebar pinned]');
  const { context, page, errors } = await open(1440, 720);
  await page.evaluate(() => {
    const top = document.getElementById('module-graph').getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, top + 260);
  });
  await page.waitForTimeout(300);
  const pinned = await page.evaluate(() => {
    const r = document.querySelector('.declaration-explorer').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), position: getComputedStyle(document.querySelector('.declaration-explorer')).position };
  });
  check(pinned.position === 'sticky' && pinned.bottom <= 720 + 1, `pinned sidebar fits a 720px viewport (top ${pinned.top}, bottom ${pinned.bottom})`);
  check(errors.length === 0, 'no console errors (720p)');
  await context.close();
}

{
  console.log('\n[desktop 1440x900 light]');
  const { context, page, errors } = await open(1440, 900, { theme: 'light' });
  const m = await metrics(page);
  check(m.search === 'SeLe4n.Kernel.API', 'default module (light)');
  check(chartAtScale(m), 'flow chart at 1:1 (light)');
  check(errors.length === 0, 'no console errors (light)');
  await shot(page, 'desktop-light');
  await context.close();
}

{
  console.log('\n[tablet 1024x768]');
  const { context, page, errors } = await open(1024, 768);
  const m = await metrics(page);
  check(m.scrollWidth <= m.innerWidth, 'no horizontal overflow at 1024');
  check(chartAtScale(m), `flow chart at 1:1, scrolling inside its frame if wider (${chartSummary(m)})`);
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
  check(chartAtScale(m), `flow chart at 1:1 on a phone (${chartSummary(m)})`);
  // @cards-start
  const strip = await page.evaluate(() => {
    const scroller = document.querySelector('.rust-dependency-scroll');
    const svg = document.querySelector('.rust-dependency-svg');
    if (!scroller || !svg) return null;
    return { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, svgWidth: Math.round(svg.getBoundingClientRect().width), svgAttr: Number(svg.getAttribute('width')) };
  });
  check(Boolean(strip) && strip.svgWidth >= strip.svgAttr - 1 && strip.scrollWidth > strip.clientWidth, `dependency strip keeps its width and scrolls sideways at 390 ${JSON.stringify(strip)}`);
  // @cards-end
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
  check(m.stats.some((s) => /^theorems=10\.929$/.test(s)), `theorem count grouped the Spanish way (${m.stats.find((s) => /^theorems=/.test(s))})`);
  const facts = await page.evaluate(() => Array.from(document.querySelectorAll('.rust-crate-facts')).map((el) => el.textContent));
  check(facts.length === 4 && facts.some((f) => /depende de/.test(f)), 'crate facts are in the active locale');
  check(errors.length === 0, 'no console errors (es)');
  await context.close();
}

{
  console.log('\n[late locale, es]');
  // The locale JSON is held back until after the snapshot has painted. The
  // generated labels must still end up in Spanish: i18n.js dispatches no event
  // for its first load, so the map's ready callback has to repaint them.
  const { context, page, errors } = await open(1440, 900, { locale: 'es', holdLocaleMs: 2500 });
  const facts = await page.evaluate(() => Array.from(document.querySelectorAll('.rust-crate-facts')).map((el) => el.textContent));
  check(facts.length === 4 && facts.some((f) => /depende de/.test(f)) && !facts.some((f) => /depends on|test-only/.test(f)), `crate facts repainted into the late locale (${facts.find((f) => /depende|depends/.test(f)) || facts[0]})`);
  const m = await metrics(page);
  check(m.h2s.some((h) => /Espacio de trabajo/.test(h)), 'static headings translated by the late locale');
  check(errors.length === 0, 'no console errors (late locale)');
  await context.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nmap-smoke: all checks passed');
process.exit(failures ? 1 : 0);
