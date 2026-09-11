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
 * Since 0.31.0 it also drives the scope toggle: the Rust chart has to hold the
 * same 1:1 guarantee as the Lean one, the Lean/Rust boundary band has to
 * appear in the combined scope and vanish in the single-language ones, and a
 * boundary node has to carry the reader across into the other language.
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
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProductionGraphFile } from './lib/rust-analysis.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed; see the header of this script.');
  process.exit(2);
}

/* Expectations come from the bundled snapshots, not from numbers typed into
   this file: every upstream data refresh moves them, and a probe that has to
   be hand-edited on each refresh stops being run. What is asserted is the
   relationship between the page and its own data. */
const ROOT = new URL('../', import.meta.url);
const MAP_DATA = JSON.parse(readFileSync(new URL('data/map-data.json', ROOT), 'utf8'));
const SITE_DATA = JSON.parse(readFileSync(new URL('data/site-data.json', ROOT), 'utf8'));
const LEAN_MODULES = MAP_DATA.modules.length;
/* The same predicate the runtime draws with — a test target, a test-only
   module and an unreachable orphan are all inventory entries the graph leaves
   out, and counting only the first would fail this probe the day an upstream
   refresh legitimately carries one of the others. */
const RUST_MODULES = MAP_DATA.rust.crates.reduce(
  (total, crate) => total + crate.files.filter(isProductionGraphFile).length, 0);
const BOTH_NODES = LEAN_MODULES + RUST_MODULES;
const BRIDGE_SEAM = { lean: 'SeLe4n.Platform.FFI', rust: 'sele4n-hal::ffi' };

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
      results: (document.getElementById('module-results') || {}).textContent || '',
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
      tabLabels: Array.from(document.querySelectorAll('.interior-menu-tab')).map((t) => t.textContent.trim()),
      declarationItems: document.querySelectorAll('.interior-menu-item').length,
      clippedItems: Array.from(document.querySelectorAll('.interior-menu-item')).filter((li) => li.scrollHeight > li.clientHeight + 1).length,
      /* The `pub` chip is generated content, so it contributes nothing to
         scrollHeight: the clipped reading above stayed green through a release
         in which the chip was an absolutely positioned 6px box — the card's
         prose bullet reaching this list — with the word painted across the
         row's corner. So measure the chip itself: in flow, sized by its own
         text, and the name starting clear of it. */
      pubChips: (function () {
        const rows = Array.from(document.querySelectorAll('.interior-menu-item[data-visibility="pub"]'));
        const broken = rows.filter((li) => {
          const chip = window.getComputedStyle(li, '::before');
          if (chip.content !== '"pub"' || chip.position !== 'static') return true;
          const size = parseFloat(chip.fontSize);
          const width = parseFloat(chip.width);
          const height = parseFloat(chip.height);
          if (!(width >= size * 2 && height >= size)) return true;
          const name = li.firstElementChild;
          if (!name) return false;
          const row = li.getBoundingClientRect();
          const label = name.getBoundingClientRect();
          /* Either the name sits after the chip on the chip's line, or it
             wrapped to a line of its own below it. */
          return label.left - row.left < width && label.top - row.top < height;
        });
        return { total: rows.length, broken: broken.length };
      })(),
      stats: Array.from(document.querySelectorAll('[data-map]')).map((el) => `${el.getAttribute('data-map')}=${el.textContent}`),
      scope: (document.querySelector('.map-scope-option.is-active') || {}).dataset?.scope || '',
      scopeOptions: Array.from(document.querySelectorAll('.map-scope-option')).map((b) => `${b.dataset.scope}:${b.textContent.trim()}`),
      scopeHeights: Array.from(document.querySelectorAll('.map-scope-option'), (b) => Math.round(b.getBoundingClientRect().height)),
      badge: (document.getElementById('workspace-scope-badge') || {}).textContent || '',
      rustNodes: document.querySelectorAll('.flow-node-rust').length,
      bridgeNodes: document.querySelectorAll('.flow-node-bridge').length,
      legend: Array.from(document.querySelectorAll('.legend-item')).map((el) => el.textContent.trim()),
      laneLabels: Array.from(document.querySelectorAll('.flow-lane-label')).map((el) => el.textContent.trim()),
      sections: document.querySelectorAll('main .map-section').length,
      h2s: Array.from(document.querySelectorAll('h2')).map((h) => h.textContent)
    };
  });
}

async function setScope(page, scope) {
  await page.click(`.map-scope-option[data-scope="${scope}"]`);
  await page.waitForTimeout(450);
  return metrics(page);
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
  check(m.sections === 1, `the page is one section (${m.sections})`);
  check(new RegExp(`\\b${BOTH_NODES}\\b`).test(m.results), `the results note counts the whole active scope (${BOTH_NODES}), not just the Lean half (${JSON.stringify(m.results)})`);
  check(m.scope === 'both' && m.scopeOptions.join(' ') === 'lean:Lean both:Lean + Rust rust:Rust', `scope toggle offers all three readings, opening on Lean + Rust (${m.scopeOptions.join(' ')})`);
  check(/Lean 4 \+ Rust/.test(m.badge), `the workspace badge names the active scope (${JSON.stringify(m.badge)})`);
  const bridgeLinks = Number((m.stats.find((s) => s.startsWith('bridgeLinks=')) || '').split('=')[1]);
  check(m.stats.some((s) => s === `rustCrates=${MAP_DATA.rust.crates.length}`)
    && m.stats.some((s) => s === `rustModules=${RUST_MODULES}`)
    && bridgeLinks > 100,
    `hero stats carry the Rust and boundary figures (${m.stats.filter((s) => /^(rust|bridge)/.test(s)).join(', ')})`);
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
  await page.waitForTimeout(200);
  /* The workspace is one `.card`, and this page's two list widgets are `ul`s
     inside it: whatever style.css paints on a card's list items lands on them
     unless each undoes it property by property. The listbox is the cheaper of
     the two to read — its rows keep their own inset rather than a prose
     indent, and carry no marker. Read it before Enter closes it. */
  const listbox = await page.evaluate(() => Array.from(document.querySelectorAll('.module-search-option'), (li) => {
    const row = window.getComputedStyle(li);
    return {
      marker: window.getComputedStyle(li, '::before').content,
      padLeft: Math.round(parseFloat(row.paddingLeft)),
      padRight: Math.round(parseFloat(row.paddingRight))
    };
  }));
  check(listbox.length > 0 && listbox.every((row) => row.marker === 'none' && row.padLeft <= row.padRight + 1),
    `the search listbox rows are the listbox's own (${listbox.length} option(s), first ${JSON.stringify(listbox[0] || null)})`);
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

  /* The foreign-function seam, from the Lean side. SeLe4n.Platform.FFI
     declares the opaque functions the HAL defines, so the combined scope has
     to draw a boundary band there and nowhere else on this page. */
  await page.click('#module-search', { clickCount: 3 });
  await page.keyboard.type(BRIDGE_SEAM.lean);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const seam = await metrics(page);
  check(seam.bridgeNodes >= 1, `the Lean chart draws the boundary band in the combined scope (${seam.bridgeNodes} node(s))`);
  check(seam.laneLabels.some((label) => /implemented in Rust/i.test(label)), `the band says which way the boundary points (${JSON.stringify(seam.laneLabels)})`);
  check(seam.legend.some((item) => /Lean declares/.test(item)), 'the legend gains the boundary entries in the combined scope');
  check(chartAtScale(seam), `the chart is still drawn at 1:1 with the band (${chartSummary(seam)})`);
  check(seam.scrollWidth <= seam.innerWidth, 'the band adds no sideways overflow');

  /* Crossing over: a boundary node carries the reader into the other language,
     and the Rust chart takes over. */
  await page.click('.flow-node-bridge');
  await page.waitForTimeout(500);
  const crossed = await metrics(page);
  check(crossed.search === BRIDGE_SEAM.rust, `a boundary node crosses into the other language (${crossed.search})`);
  check(/module=sele4n-hal%3A%3Affi|module=sele4n-hal::ffi/.test(crossed.url), `the Rust node is linkable (${crossed.url})`);
  check(crossed.rustNodes > 0 && crossed.bridgeNodes >= 1, `the Rust chart renders, boundary included (${crossed.rustNodes} Rust nodes, ${crossed.bridgeNodes} boundary)`);
  const ffiFile = MAP_DATA.rust.crates.flatMap((c) => c.files).find((f) => f.path.endsWith('sele4n-hal/src/ffi.rs'));
  /* The Functions tab is fn + const + static, as RUST_KIND_GROUPS defines it;
     counting only `fn` here would silently pass until a const appeared. */
  const functionKinds = new Set(['fn', 'const', 'static']);
  const ffiFns = ffiFile.items.filter((i) => !i.test && functionKinds.has(i.kind)).length;
  check(crossed.tabs.length === 4
    && crossed.tabLabels.map((label) => label.replace(/\s+[\d,]+$/, '')).join(',') === 'Types,Functions,Impls/Mods,Tests'
    && crossed.tabLabels.some((label) => label === `Functions ${ffiFns.toLocaleString('en-US')}`),
    `the sidebar switches to the Rust groups and counts them from the snapshot (${crossed.tabLabels.join(', ')})`);
  check(chartAtScale(crossed), `the Rust chart holds the same 1:1 guarantee (${chartSummary(crossed)})`);
  check(crossed.scrollWidth <= crossed.innerWidth, 'the Rust chart adds no sideways overflow');

  /* Narrowing to Rust drops the boundary; narrowing to Lean drops the Rust
     node with it and falls back to the scope's own default. */
  const rustOnly = await setScope(page, 'rust');
  check(rustOnly.scope === 'rust' && /scope=rust/.test(rustOnly.url), `the scope rides the URL (${rustOnly.url})`);
  check(rustOnly.laneLabels.some((label) => /Declared alongside, in sele4n-hal/.test(label)),
    `a leaf module browses its crate through its siblings (${JSON.stringify(rustOnly.laneLabels)})`);
  const openTab = rustOnly.tabLabels[rustOnly.tabs.indexOf('true')] || '';
  check(/ [1-9]/.test(openTab), `the Rust sidebar opens on a group that has something in it (open: ${openTab}; all: ${rustOnly.tabLabels.join(', ')})`);
  check(rustOnly.search === BRIDGE_SEAM.rust, 'a Rust node survives the narrowing to the Rust scope');
  check(rustOnly.bridgeNodes === 0 && !rustOnly.legend.some((item) => /Lean declares/.test(item)), 'the Rust-only reading draws no boundary');
  check(/production · Rust/.test(rustOnly.badge), `the badge follows the scope (${JSON.stringify(rustOnly.badge)})`);
  check(chartAtScale(rustOnly) && rustOnly.scrollWidth <= rustOnly.innerWidth, `Rust-only chart at 1:1 with no overflow (${chartSummary(rustOnly)})`);

  const leanOnly = await setScope(page, 'lean');
  check(leanOnly.scope === 'lean' && /scope=lean/.test(leanOnly.url), 'the Lean scope rides the URL too');
  check(leanOnly.search === 'SeLe4n.Kernel.API', `a Rust selection falls back to the Lean default (${leanOnly.search})`);
  check(leanOnly.rustNodes === 0 && leanOnly.bridgeNodes === 0, 'no Rust node survives into the Lean-only reading');
  check(leanOnly.tabs.length === 3, 'the sidebar returns to the Lean groups');
  check(new RegExp(`\\b${LEAN_MODULES}\\b`).test(leanOnly.results) && !new RegExp(`\\b${BOTH_NODES}\\b`).test(leanOnly.results),
    `and the results note follows the scope (${JSON.stringify(leanOnly.results)})`);

  const back = await setScope(page, 'both');
  check(back.scope === 'both' && !/scope=/.test(back.url), 'the default scope leaves the URL clean again');

  check(errors.length === 0, `still no console errors after interactions ${JSON.stringify(errors)}`);
  await context.close();
}

{
  /* A Rust deep link has to reconstruct the whole reading from the URL alone. */
  console.log('\n[deep link, rust scope]');
  const { context, page, errors } = await open(1440, 900, { query: '?scope=rust&module=sele4n-abi%3A%3Aargs%3A%3Acspace' });
  const m = await metrics(page);
  check(m.scope === 'rust' && m.search === 'sele4n-abi::args::cspace', `a Rust deep link restores scope and node (${m.scope}, ${m.search})`);
  const deepTab = m.tabLabels[m.tabs.indexOf('true')] || '';
  check(/ [1-9]/.test(deepTab) && m.declarationItems > 0, `the Rust sidebar opens on a populated group (open: ${deepTab}; ${m.declarationItems} items)`);
  check(m.pubChips.total > 0 && m.pubChips.broken === 0 && m.clippedItems === 0,
    `public Rust items carry a chip of their own and nothing is clipped (${m.pubChips.total} pub of ${m.declarationItems}, ${m.pubChips.broken} misplaced, ${m.clippedItems} clipped)`);
  check(m.laneLabels.some((label) => /Module path/.test(label)), `the module path lane names the enclosing modules (${JSON.stringify(m.laneLabels)})`);
  check(chartAtScale(m), `Rust chart at 1:1 from a cold load (${chartSummary(m)})`);
  check(m.scrollWidth <= m.innerWidth, 'no horizontal overflow on a Rust deep link');
  check(errors.length === 0, `no console errors (rust deep link) ${JSON.stringify(errors)}`);
  await shot(page, 'rust-scope');
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
  check(m.scopeHeights.length === 3 && Math.min(...m.scopeHeights) >= 40, `scope options stay tappable at 390 (${m.scopeHeights.join(', ')}px)`);
  const rustPhone = await setScope(page, 'rust');
  check(rustPhone.scrollWidth <= rustPhone.innerWidth, 'the Rust chart adds no sideways overflow at 390');
  check(chartAtScale(rustPhone), `Rust chart at 1:1 on a phone (${chartSummary(rustPhone)})`);
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
  const theoremsEs = SITE_DATA.theorems.toLocaleString('es-ES');
  check(m.stats.some((s) => s === `theorems=${theoremsEs}`), `theorem count grouped the Spanish way, ${theoremsEs} (${m.stats.find((s) => /^theorems=/.test(s))})`);
  check(m.scopeOptions.join(' ') === 'lean:Lean both:Lean + Rust rust:Rust', `the scope labels are language names, the same in every locale (${m.scopeOptions.join(' ')})`);
  check(errors.length === 0, 'no console errors (es)');
  await context.close();
}

{
  console.log('\n[late locale, es]');
  // The locale JSON is held back until after the snapshot has painted. The
  // generated labels must still end up in Spanish: i18n.js dispatches no event
  // for its first load, so the map's ready callback has to repaint them.
  const { context, page, errors } = await open(1440, 900, { locale: 'es', holdLocaleMs: 2500 });
  const m = await metrics(page);
  check(m.laneLabels.some((label) => /Importaciones usadas/.test(label)) && !m.laneLabels.some((label) => /Imports used by/.test(label)),
    `chart lane labels repainted into the late locale (${JSON.stringify(m.laneLabels)})`);
  check(m.legend.some((item) => /Importaciones \(dependencias\)|Importaciones/.test(item)), `the legend repainted too (${JSON.stringify(m.legend.slice(0, 3))})`);
  check(m.h2s.some((h) => /Espacio de trabajo/.test(h)), 'static headings translated by the late locale');
  check(errors.length === 0, 'no console errors (late locale)');
  await context.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nmap-smoke: all checks passed');
process.exit(failures ? 1 : 0);
