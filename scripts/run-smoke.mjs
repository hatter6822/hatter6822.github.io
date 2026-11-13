#!/usr/bin/env node
/**
 * Headless-Chromium smoke probe for run.html (Tier 3/4).
 *
 * run-runtime.test.mjs boots run.js in a DOM shim, which cannot measure. This
 * renders the page in a browser and walks every scenario through every step,
 * every scene it offers and both readings of the step (before and after), in
 * every locale, asserting what only layout can show: each scene is drawn at
 * 1:1, no label runs past the edge of its SVG or of the box it sits in, the
 * page never scrolls sideways (on a phone the stage scrolls inside its own
 * shell), the transport stays in reach while the page scrolls, both themes
 * paint, the tabs, the before/after toggle and the step keys answer the
 * keyboard, each scene carries a text alternative, the sandbox's
 * perturbations break the invariant they name and say so beside the stage,
 * and no request leaves the origin.
 *
 * Requirements (not repository dependencies):
 *   npm install --no-save playwright-core       # or any directory on NODE_PATH
 *   python3 -m http.server 4175 --bind 127.0.0.1   # from the repository root
 *
 * Environment:
 *   RUN_SMOKE_BASE        server origin               (default http://127.0.0.1:4175)
 *   PLAYWRIGHT_CHROMIUM   Chromium executable path    (default: Playwright's own lookup)
 *   RUN_SMOKE_CHANNEL     browser channel, e.g. chrome (uses the machine's Chrome; CI does this)
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed; see the header of this script.');
  process.exit(2);
}

const ROOT = new URL('../', import.meta.url);
const TRACES = JSON.parse(readFileSync(new URL('data/execution-traces.json', ROOT), 'utf8'));
const ES = JSON.parse(readFileSync(new URL('locales/es.json', ROOT), 'utf8'));
const BASE = process.env.RUN_SMOKE_BASE || 'http://127.0.0.1:4175';
const ORIGIN = new URL(BASE).origin;

const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
else if (process.env.RUN_SMOKE_CHANNEL) launchOptions.channel = process.env.RUN_SMOKE_CHANNEL;
const browser = await chromium.launch(launchOptions);

let failures = 0;
function check(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures += 1;
}

async function open(width, height, { theme = 'dark', query = '', locale = 'en', intercept = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale });
  await context.addInitScript(([t, l]) => {
    try { localStorage.setItem('sele4n-theme', t); } catch (e) {}
    try { localStorage.setItem('sele4n-locale-v1', l); } catch (e) {}
  }, [theme, locale]);
  /* What the browser itself reports while the page loads: layout shifts not
     caused by input, and anything the Content-Security-Policy refused. */
  await context.addInitScript(() => {
    window.__layoutShift = 0;
    window.__cspViolations = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__layoutShift += entry.value;
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const page = await context.newPage();
  if (intercept) await page.route(intercept[0], intercept[1]);
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (request) => errors.push(`requestfailed: ${request.url()}`));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('data:') && new URL(url).origin !== ORIGIN) errors.push(`cross-origin request: ${url}`);
  });
  await page.goto(`${BASE}/run.html${query}`, { waitUntil: 'networkidle' });
  if (!intercept) await page.waitForSelector('#theater-stage svg');
  return { context, page, errors };
}

const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** The drawn scene: its scale, and every text that runs past the SVG's edge. */
const measureStage = (page) => page.evaluate(() => {
  const svg = document.querySelector('#theater-stage svg');
  const box = svg.getBoundingClientRect();
  const w = Number(svg.getAttribute('width'));
  const h = Number(svg.getAttribute('height'));
  const out = [];
  const boxed = [];
  for (const t of svg.querySelectorAll('text')) {
    if (!t.textContent.trim()) continue;
    const b = t.getBBox();
    if (b.x < -1 || b.y < -1 || b.x + b.width > w + 1 || b.y + b.height > h + 1) out.push(t.textContent.slice(0, 40));
    /* A label drawn inside a box stays inside it: the nearest rect of the
       text's own group that contains the text's start must contain its end. */
    const group = t.parentNode;
    let host = null;
    for (const r of group.children) {
      if (r.tagName !== 'rect' || !/\b(bx|cell)\b/.test(r.getAttribute('class') || '')) continue;
      const rb = r.getBBox();
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      if (cx >= rb.x && cx <= rb.x + rb.width && cy >= rb.y && cy <= rb.y + rb.height && (!host || rb.width * rb.height < host.width * host.height)) host = rb;
    }
    if (host && (b.x < host.x - 1 || b.x + b.width > host.x + host.width + 1)) boxed.push(t.textContent.slice(0, 40));
  }
  const shell = document.getElementById('theater-stage-shell');
  const alt = document.getElementById(svg.getAttribute('aria-describedby') || '');
  return {
    scene: svg.getAttribute('data-scene'), scale: box.width / w, overflow: out, boxed,
    scrolls: shell.scrollWidth > shell.clientWidth,
    described: !!(alt && alt.textContent.trim().length > 10),
    fallback: !!document.querySelector('#theater-stage .stage-fallback')
  };
});

/** Every scenario, step, scene and reading the page offers, measured. */
async function walk(page, { stageFits }) {
  let drawn = 0;
  const bad = [];
  for (const sc of TRACES.scenarios) {
    await page.selectOption('#scenario-select', sc.id);
    for (let i = 0; i < sc.steps.length; i++) {
      if (i) await page.click('#theater-next');
      const tabs = await page.$$eval('#theater-scenes .scene-tab', (els) => els.map((e) => e.dataset.scene));
      for (const scene of tabs) {
        await page.click(`#theater-scenes .scene-tab[data-scene="${scene}"]`);
        for (const view of i ? ['before', 'after'] : ['after']) {
          if (i) await page.click(`#theater-view [data-view="${view}"]`);
          const m = await measureStage(page);
          const at = `${sc.id}/${i}/${scene}/${view}`;
          drawn += 1;
          if (m.fallback) bad.push(`${at}: the scene failed to draw`);
          if (m.scene !== scene) bad.push(`${at}: tab shows ${m.scene}`);
          if (Math.abs(m.scale - 1) > 0.01) bad.push(`${at}: drawn at ${m.scale.toFixed(2)}`);
          if (stageFits && m.scrolls) bad.push(`${at}: wider than the stage`);
          if (m.overflow.length) bad.push(`${at}: past the edge — ${m.overflow.slice(0, 2).join(' | ')}`);
          if (m.boxed.length) bad.push(`${at}: out of its box — ${m.boxed.slice(0, 2).join(' | ')}`);
          if (!m.described) bad.push(`${at}: no text alternative`);
        }
      }
    }
  }
  return { drawn, bad };
}
const RENDERS = TRACES.scenarios.reduce((n, s) => n + s.steps.length, 0);

{
  const { context, page, errors } = await open(1440, 900, { theme: 'dark' });
  console.log('\n[every scenario, every step, every scene, before and after — 1440px dark]');
  const { drawn, bad } = await walk(page, { stageFits: true });
  check(drawn >= RENDERS * 4, `walked ${drawn} scene renders`);
  check(bad.length === 0, `every scene at 1:1 and inside the stage, nothing past its edge or out of its box, each described in words${bad.length ? ` — ${bad.length}: ${bad.slice(0, 6).join('; ')}` : ''}`);
  check(await sideways(page) <= 0, 'no sideways overflow');
  check(errors.length === 0, `clean console, same-origin only${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

for (const locale of ['es', 'fr', 'ja', 'uk', 'zh-CN']) {
  const { context, page, errors } = await open(1440, 900, { theme: 'light', locale });
  console.log(`\n[every scene of every step in ${locale} — 1440px light]`);
  // i18n.js writes zh-CN to <html lang> as the script tag it means, zh-Hans.
  await page.waitForFunction((l) => document.documentElement.lang === l, locale === 'zh-CN' ? 'zh-Hans' : locale);
  await page.waitForTimeout(300);
  const { drawn, bad } = await walk(page, { stageFits: true });
  check(drawn >= RENDERS * 4, `walked ${drawn} scene renders`);
  check(bad.length === 0, `translated labels stay inside the scene and inside their boxes${bad.length ? ` — ${bad.length}: ${bad.slice(0, 6).join('; ')}` : ''}`);
  check(await sideways(page) <= 0, 'no sideways overflow');
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

for (const width of [1920, 1024, 768]) {
  const { context, page, errors } = await open(width, 900, { theme: 'dark', query: '?scenario=budget-edf&step=3&scene=scheduler' });
  console.log(`\n[layout at ${width}px]`);
  const m = await measureStage(page);
  check(Math.abs(m.scale - 1) < 0.01, `the scene is drawn at 1:1 (${m.scale.toFixed(2)})`);
  check(await sideways(page) <= 0, `no sideways page overflow (${await sideways(page)}px)`);
  const beside = await page.evaluate(() => {
    const stage = document.querySelector('.stage-card').getBoundingClientRect();
    const insp = document.querySelector('.inspector-card').getBoundingClientRect();
    return insp.left >= stage.right - 1;
  });
  check(beside === (width > 1200), width > 1200 ? 'the step detail sits beside the stage' : 'the step detail stacks under the stage');
  await page.evaluate(() => window.scrollTo(0, document.querySelector('.stage-card').getBoundingClientRect().top + window.scrollY + 300));
  await page.waitForTimeout(100);
  const pinned = await page.evaluate(() => {
    const r = document.querySelector('.theater-transport').getBoundingClientRect();
    const nav = document.getElementById('nav').getBoundingClientRect();
    return r.top >= nav.bottom - 1 && r.bottom < window.innerHeight / 2;
  });
  check(pinned, 'the transport stays pinned under the navigation while the page scrolls');
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

{
  const { context, page, errors } = await open(1280, 800, { theme: 'light', query: '?scenario=ipc-call-reply&step=3&scene=path' });
  console.log('\n[keyboard, selection and sandbox — 1280px light]');
  await page.focus('#theater-scenes .scene-tab[data-active="true"]');
  await page.keyboard.press('ArrowRight');
  const scene = await page.$eval('#theater-stage svg', (s) => s.getAttribute('data-scene'));
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.dataset.scene);
  check(scene === 'ipc' && focused === 'ipc', `ArrowRight moves to the next scene and its tab (${scene}, focus ${focused})`);
  check(new URL(page.url()).searchParams.get('scene') === 'ipc', 'the URL carries the scene');

  const tabState = await page.$$eval('#theater-scenes .scene-tab', (els) => els.map((e) => [e.getAttribute('aria-selected'), e.tabIndex]));
  check(tabState.filter((t) => t[0] === 'true').length === 1 && tabState.filter((t) => t[1] === 0).length === 1, 'one tab is selected and it alone is in the tab order');
  check(await page.$eval('#theater-stage-shell', (s) => s.getAttribute('role') === 'tabpanel' && s.getAttribute('aria-labelledby') === 'scene-tab-ipc'), 'the stage is the tab panel the selected tab labels');

  /* Before / after: the radio group, its keys, and the URL. */
  const status = () => page.$eval('#theater-stage [data-object="client"] .chip', (e) => e.getAttribute('data-status'));
  check(await status() === 'blocked', 'after the call the caller is blocked');
  await page.focus('#theater-view [aria-checked="true"]');
  await page.keyboard.press('ArrowLeft');
  check(await status() === 'running' && new URL(page.url()).searchParams.get('view') === 'before', 'ArrowLeft on the toggle shows the state the step found, and the URL carries it');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('a');
  check(await status() === 'blocked' && !new URL(page.url()).searchParams.get('view'), 'the A key returns to the state the step left');
  check(await page.$$eval('#theater-stage [data-changed="true"]', (els) => els.length) > 0, 'what the step changed is marked on the scene');

  /* The step keys, from the page and from the transport button just pressed. */
  const label = () => page.$eval('#theater-step-label', (e) => e.textContent);
  const total = TRACES.scenarios.find((s) => s.id === 'ipc-call-reply').steps.length;
  await page.keyboard.press('ArrowRight');
  check(await label() === `5 / ${total}`, `ArrowRight steps forward (${await label()})`);
  await page.click('#theater-prev');
  await page.keyboard.press('ArrowLeft');
  check(await label() === `3 / ${total}`, `the arrows still step with the transport button focused (${await label()})`);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('End');
  check(await label() === `${total} / ${total}`, 'End goes to the last step');
  await page.keyboard.press('Home');
  check(await label() === `1 / ${total}`, 'Home goes to the first');
  check(await page.$$eval('#theater-view [data-view]', (els) => els.every((e) => e.disabled)), 'the initial state has no "before" to show');
  await page.click('#theater-log .step-chip >> nth=3');
  check(await label() === `4 / ${total}`, 'a chip in the step strip jumps to its step');
  check(await page.$$eval('#theater-log [aria-current="step"]', (els) => els.length) === 1, 'and exactly one chip is current');
  check((await page.$eval('#theater-step-head .step-title', (e) => e.textContent)).length > 0, 'the step is titled above the stage');

  await page.click('#theater-stage [data-object]');
  check(await page.$('#theater-inspector .insp-object') !== null, 'clicking an object on the stage opens it in the inspector');
  await page.focus('#theater-stage [data-object]');
  check(await page.evaluate(() => document.activeElement.hasAttribute('data-object')), 'an object on the stage takes keyboard focus');

  await page.click('#sandbox-toggle');
  const offered = await page.$$eval('#sandbox-panel [data-perturb]:not([hidden])', (els) => els.map((e) => e.dataset.perturb));
  check(offered.length > 0, `the sandbox offers what applies here (${offered.join(', ')})`);
  await page.click(`#sandbox-panel [data-perturb="${offered[0]}"]`);
  const violated = await page.$$eval('#invariant-list .inv-item[data-status="violated"]', (els) => els.length);
  check(violated > 0, `${offered[0]} breaks an invariant (${violated})`);
  check(await page.$eval('#sandbox-verdict', (v) => !v.hidden && v.dataset.tone === 'bad' && v.textContent.trim().length > 0), 'and the verdict beside the stage says so');
  check(await page.$eval('#invariant-details', (d) => d.open), 'the invariant list opens to show it');
  await page.click('#sandbox-panel [data-sandbox-reset]');
  check(await page.$$eval('#invariant-list .inv-item[data-status="violated"]', (els) => els.length) === 0, 'reset returns to the trace');
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

{
  // Every panel is rebuilt on each render. A control that is focused when it
  // is pressed must still be focused afterwards, or a keyboard user is put
  // back at <body> each time they act.
  const { context, page, errors } = await open(1280, 800, { query: '?scenario=ipc-call-reply&step=1&scene=ipc' });
  console.log('\n[keyboard focus survives a re-render — 1280px]');
  const focus = () => page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'body';
    return (a.id ? `#${a.id}` : a.tagName.toLowerCase()) + (a.getAttribute('aria-current') ? '[current]' : '') +
      (a.getAttribute('data-object') ? `[${a.getAttribute('data-object')}]` : '') + (a.classList.contains('insp-clear') ? '.insp-clear' : '');
  });
  await page.focus('#theater-log li:nth-child(3) .step-chip');
  await page.keyboard.press('Enter');
  check(await focus() === 'button[current]' && (await page.textContent('#theater-step-label')).startsWith('3 /'),
    `Enter on a step chip moves to that step and stays on its chip (${await focus()})`);
  await page.keyboard.press('Tab');
  check(/^button$/.test(await focus()) && await page.evaluate(() => document.activeElement.closest('#theater-log li') === document.querySelector('#theater-log li:nth-child(4)')),
    'and Tab goes on to the next chip');

  await page.focus('#theater-stage [data-object]');
  const object = await page.evaluate(() => document.activeElement.getAttribute('data-object'));
  await page.keyboard.press('Enter');
  check(await focus() === `g[${object}]` && await page.$$eval('#theater-inspector .insp-clear', (els) => els.length) === 1,
    `Enter on an object in the scene selects it and stays on it (${await focus()})`);
  await page.focus('#theater-inspector .insp-clear');
  await page.keyboard.press('Enter');
  check(await focus() === `g[${object}]` && await page.$$eval('#theater-inspector .insp-clear', (els) => els.length) === 0,
    `clearing the selection returns focus to the object (${await focus()})`);

  await page.focus('#guarantee-grid a[href]');
  const before = await page.evaluate(() => [...document.querySelectorAll('#guarantee-grid a[href], #guarantee-grid button, #guarantee-grid summary')].indexOf(document.activeElement));
  await page.keyboard.press('ArrowRight');
  const after = await page.evaluate(() => document.activeElement.closest('#guarantee-grid') ? 'guarantees' : document.activeElement.id || document.activeElement.tagName);
  check(after === 'guarantees' || after === 'theater-stage-shell',
    `stepping with the arrows from a link in a rebuilt panel leaves focus in the simulator (${after}, was link ${before})`);
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

{
  const { context, page, errors } = await open(390, 844, { theme: 'light', query: '?scenario=capability-gate&step=1&scene=path' });
  console.log('\n[phone, 390px]');
  check(await sideways(page) <= 0, `no sideways page overflow (${await sideways(page)}px)`);
  const m = await measureStage(page);
  check(Math.abs(m.scale - 1) < 0.01, `the scene is drawn at 1:1 (${m.scale.toFixed(2)})`);
  const shell = await page.$eval('#theater-stage-shell', (s) => s.scrollWidth > s.clientWidth);
  check(shell, 'the stage scrolls inside its own shell');
  const tabs = await page.$$eval('#theater-scenes .scene-tab', (els) => els.map((e) => e.getBoundingClientRect().height));
  check(tabs.every((h) => h >= 24), 'the scene tabs are tappable');
  const { drawn, bad } = await walk(page, { stageFits: false });
  check(drawn >= RENDERS * 4 && bad.length === 0, `all ${drawn} scene renders stay at 1:1 on a phone${bad.length ? ` — ${bad.length}: ${bad.slice(0, 4).join('; ')}` : ''}`);
  check(await sideways(page) <= 0, 'and the page never scrolls sideways along the way');
  const controls = await page.$$eval('.theater-transport button, #theater-view button, #theater-log .step-chip', (els) => els.filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().height));
  check(controls.length > 4 && controls.every((h) => h >= 24), 'the transport, the toggle and the step strip are tappable');
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

{
  const { context, page, errors } = await open(1440, 900, { theme: 'dark', locale: 'es', query: '?scenario=capability-gate&step=1&scene=path' });
  console.log('\n[Spanish]');
  await page.waitForFunction(() => document.documentElement.lang === 'es');
  await page.waitForTimeout(300);
  const tab = await page.$eval('#theater-scenes .scene-tab[data-scene="path"]', (e) => e.textContent);
  check(tab === ES.run.scene_path, `the scene tabs are translated ("${tab}")`);
  const legend = await page.$eval('#theater-legend', (e) => e.textContent);
  check(legend.includes(ES.run.legend_pass), 'the legend is translated');
  const svgText = await page.$eval('#theater-stage svg', (s) => s.textContent);
  check(svgText.includes(ES.run.sec_gates), 'the scene\'s own labels are translated');
  check((await page.$eval('#theater-view [data-view="before"]', (e) => e.textContent)) === ES.run.view_before, 'the before/after toggle is translated');
  const alt = await page.$eval('#theater-alt', (e) => e.textContent);
  check(alt.includes(ES.run.scene_path), 'and so is the scene\'s text alternative');
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

for (const [width, height, locale, bound] of [[1440, 900, 'en', 0.02], [1024, 768, 'en', 0.02], [390, 844, 'en', 0.02], [1440, 900, 'ja', 0.1]]) {
  // The whole simulator is drawn from the trace, which arrives after first
  // paint. The boxes it fills reserve their height while they are empty; when
  // they collapsed instead, the stage was drawn 80px above where it ended up
  // (a layout shift of 0.09 at 1440px and 0.33 on a phone, on every visit).
  // A translated page is held to the looser "good" bound, 0.1: the English
  // text is painted before the locale replaces it, and text of another length
  // wraps differently. That swap is what is left, and it is not zero.
  const { context, page, errors } = await open(width, height, { locale });
  console.log(`\n[first paint ${width}x${height}, ${locale}]`);
  await page.waitForTimeout(600);
  const shift = await page.evaluate(() => window.__layoutShift);
  check(shift < bound, `cumulative layout shift while loading is ${shift.toFixed(4)} (< ${bound})`);
  const violations = await page.evaluate(() => window.__cspViolations);
  check(violations.length === 0, `the policy refused nothing${violations.length ? ` — ${violations.join(' | ')}` : ''}`);
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

{
  console.log('\n[the trace cannot be loaded, or is not one the page can fold]');
  const refusedStep = JSON.parse(JSON.stringify(TRACES));
  {
    // A refused step that changes state: the kernel has no such transition,
    // so the adoption gate refuses the whole document.
    const EVENTS = ['flowCheck', 'vspaceReject', 'note'];
    const opsOf = (st) => (st.delta && st.delta.ops) || [];
    const scenario = refusedStep.scenarios.find((s) => s.steps.some((st) => st.outcome && st.outcome.status === 'error'));
    const step = scenario.steps.find((st) => st.outcome && st.outcome.status === 'error');
    const donor = scenario.steps.find((st) => st !== step && opsOf(st).some((op) => !EVENTS.includes(op.op)));
    step.delta = { ...(step.delta || {}), ops: opsOf(step).concat(opsOf(donor).filter((op) => !EVENTS.includes(op.op)).slice(0, 1)) };
  }
  for (const [label, want, handler] of [
    ['missing', 'Could not load trace data.', (route) => route.fulfill({ status: 404, body: 'not found' })],
    ['not JSON', 'Could not load trace data.', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>x</title>' })],
    ['an empty object', 'Bundled trace data is invalid.', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })],
    ['another schema version', 'Bundled trace data is invalid.', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...TRACES, schemaVersion: TRACES.schemaVersion - 1 }) })],
    ['a refused step that changes state', 'Bundled trace data is invalid.', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refusedStep) })]
  ]) {
    const { context, page, errors } = await open(1440, 900, { intercept: [/\/data\/execution-traces\.json(\?.*)?$/, handler] });
    await page.waitForFunction(() => document.getElementById('theater-status').classList.contains('error'), null, { timeout: 10000 }).catch(() => {});
    const status = await page.$eval('#theater-status', (el) => [el.classList.contains('error'), el.textContent]);
    const drawn = await page.$$eval('#theater-stage svg', (els) => els.length);
    const thrown = errors.filter((e) => /^pageerror/.test(e));
    check(status[0] && status[1] === want && drawn === 0 && thrown.length === 0,
      `${label}: "${status[1]}", nothing drawn${thrown.length ? ` — ${thrown[0]}` : ''}`);
    await context.close();
  }
}

await browser.close();
console.log(failures ? `\nrun-smoke: ${failures} check(s) failed` : '\nrun-smoke: all checks passed');
process.exit(failures ? 1 : 0);
