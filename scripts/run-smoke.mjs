#!/usr/bin/env node
/**
 * Headless-Chromium smoke probe for run.html (Tier 3/4).
 *
 * run-runtime.test.mjs boots run.js in a DOM shim, which cannot measure. This
 * renders the page in a browser and walks every scenario through every step
 * and every scene it offers, asserting what only layout can show: each scene
 * is drawn at 1:1, no label runs past the edge of its SVG, the page never
 * scrolls sideways (on a phone the stage scrolls inside its own shell), both
 * themes and a translated locale paint, the scene tabs answer the keyboard,
 * the sandbox's perturbations break the invariant they name, and no request
 * leaves the origin.
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

async function open(width, height, { theme = 'dark', query = '', locale = 'en' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale });
  await context.addInitScript(([t, l]) => {
    try { localStorage.setItem('sele4n-theme', t); } catch (e) {}
    try { localStorage.setItem('sele4n-locale-v1', l); } catch (e) {}
  }, [theme, locale]);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (request) => errors.push(`requestfailed: ${request.url()}`));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('data:') && new URL(url).origin !== ORIGIN) errors.push(`cross-origin request: ${url}`);
  });
  await page.goto(`${BASE}/run.html${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#theater-stage svg');
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
  for (const t of svg.querySelectorAll('text')) {
    if (!t.textContent.trim()) continue;
    const b = t.getBBox();
    if (b.x < -1 || b.y < -1 || b.x + b.width > w + 1 || b.y + b.height > h + 1) out.push(t.textContent.slice(0, 40));
  }
  const shell = document.getElementById('theater-stage-shell');
  return { scene: svg.getAttribute('data-scene'), scale: box.width / w, overflow: out, scrolls: shell.scrollWidth > shell.clientWidth };
});

{
  const { context, page, errors } = await open(1440, 900, { theme: 'dark' });
  console.log('\n[every scenario, every step, every scene — 1440px dark]');
  let drawn = 0;
  const bad = [];
  for (const sc of TRACES.scenarios) {
    await page.selectOption('#scenario-select', sc.id);
    for (let i = 0; i < sc.steps.length; i++) {
      if (i) await page.click('#theater-next');
      const tabs = await page.$$eval('#theater-scenes .scene-tab', (els) => els.map((e) => e.dataset.scene));
      for (const scene of tabs) {
        await page.click(`#theater-scenes .scene-tab[data-scene="${scene}"]`);
        const m = await measureStage(page);
        drawn += 1;
        if (m.scene !== scene) bad.push(`${sc.id}/${i}/${scene}: tab shows ${m.scene}`);
        if (Math.abs(m.scale - 1) > 0.01) bad.push(`${sc.id}/${i}/${scene}: drawn at ${m.scale.toFixed(2)}`);
        if (m.scrolls) bad.push(`${sc.id}/${i}/${scene}: wider than the stage at 1440px`);
        if (m.overflow.length) bad.push(`${sc.id}/${i}/${scene}: past the edge — ${m.overflow.slice(0, 2).join(' | ')}`);
      }
    }
  }
  check(drawn >= TRACES.scenarios.reduce((n, s) => n + s.steps.length, 0) * 2, `walked ${drawn} scene renders`);
  check(bad.length === 0, `every scene at 1:1 and inside the stage, nothing past its edge${bad.length ? ` — ${bad.slice(0, 4).join('; ')}` : ''}`);
  check(await sideways(page) <= 0, 'no sideways overflow');
  check(errors.length === 0, `clean console, same-origin only${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
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

  await page.click('#theater-stage [data-object]');
  check(await page.$('#theater-inspector .insp-object') !== null, 'clicking an object on the stage opens it in the inspector');

  await page.click('#sandbox-toggle');
  const offered = await page.$$eval('#sandbox-panel [data-perturb]:not([hidden])', (els) => els.map((e) => e.dataset.perturb));
  check(offered.length > 0, `the sandbox offers what applies here (${offered.join(', ')})`);
  await page.click(`#sandbox-panel [data-perturb="${offered[0]}"]`);
  const violated = await page.$$eval('#invariant-list .inv-item[data-status="violated"]', (els) => els.length);
  check(violated > 0, `${offered[0]} breaks an invariant (${violated})`);
  check(await page.$eval('#invariant-details', (d) => d.open), 'the invariant list opens to show it');
  await page.click('#sandbox-panel [data-sandbox-reset]');
  check(await page.$$eval('#invariant-list .inv-item[data-status="violated"]', (els) => els.length) === 0, 'reset returns to the trace');
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
  check(svgText.includes(ES.run.pipeline), 'the scene\'s own labels are translated');
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

await browser.close();
console.log(failures ? `\nrun-smoke: ${failures} check(s) failed` : '\nrun-smoke: all checks passed');
process.exit(failures ? 1 : 0);
