#!/usr/bin/env node
/**
 * Headless-Chromium smoke probe for index.html (Tier 3/4).
 *
 * The landing page states about a hundred figures, and as of 0.32.0 every one
 * of them is a `data-live` span stamped from `data/site-data.json`. The unit
 * tests prove the stamping is right in the file; this proves it is right on
 * the screen — that hydration renders the same literal the markup ships (a
 * mismatch rewrites a number in front of the reader), that the architecture
 * diagram's labels still fit now that each carries nested spans, and that a
 * locale arriving after the snapshot keeps the figures rather than replacing
 * them with a translator's copy.
 *
 * It also holds the two guarantees that are easy to break from a stylesheet:
 * no viewport scrolls sideways, and the console stays clean. The kernel logo
 * is served from raw.githubusercontent.com (the CSP allows exactly that host
 * for images), so a run without outbound network reports those two requests as
 * failures; they are ignored here rather than masking a real error.
 *
 * Requirements (not repository dependencies):
 *   npm install --no-save playwright-core       # or any directory on NODE_PATH
 *   python3 -m http.server 4173 --bind 127.0.0.1   # from the repository root
 *
 * Environment:
 *   INDEX_SMOKE_BASE      server origin               (default http://127.0.0.1:4173)
 *   PLAYWRIGHT_CHROMIUM   Chromium executable path    (default: Playwright's own lookup)
 *   INDEX_SMOKE_CHANNEL   browser channel, e.g. chrome (uses the machine's Chrome; CI does this)
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

/* Expectations come from the bundled snapshot, never from numbers typed into
   this file: every upstream refresh moves them, and a probe that has to be
   hand-edited on each refresh stops being run. */
const ROOT = new URL('../', import.meta.url);
const SITE_DATA = JSON.parse(readFileSync(new URL('data/site-data.json', ROOT), 'utf8'));

const BASE = process.env.INDEX_SMOKE_BASE || 'http://127.0.0.1:4173';

/** Requests that cannot succeed without outbound network, and say nothing about the page. */
const EXTERNAL = /^https:\/\/raw\.githubusercontent\.com\//;

const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
else if (process.env.INDEX_SMOKE_CHANNEL) launchOptions.channel = process.env.INDEX_SMOKE_CHANNEL;
const browser = await chromium.launch(launchOptions);

let failures = 0;
function check(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures += 1;
}

/** Render a count exactly as assets/js/site.js renders it. */
const group = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** What `data-live="<key>"` must show, or null when the page owns the value. */
function expected(key) {
  const subsystem = /^subsystem\.(.+)\.(modules|theorems)$/.exec(key);
  if (subsystem) {
    const entry = SITE_DATA.subsystems?.[subsystem[1]];
    return entry ? group(entry[subsystem[2]]) : null;
  }
  const scalars = {
    version: SITE_DATA.version,
    'lean-version': SITE_DATA.leanVersion,
    modules: SITE_DATA.modules,
    lines: SITE_DATA.lines,
    theorems: SITE_DATA.theorems,
    syscalls: SITE_DATA.syscalls,
    externs: SITE_DATA.externs,
    'ni-steps': SITE_DATA.niSteps,
    'ni-cross-core': SITE_DATA.niCrossCore,
    'enforcement-ops': SITE_DATA.enforcementOps,
    'enforcement-ops-per-core': SITE_DATA.enforcementOpsPerCore,
    scripts: SITE_DATA.scripts,
    docs: SITE_DATA.docs,
    admitted: SITE_DATA.admitted,
    'commit-sha': SITE_DATA.commitSha
  };
  if (!(key in scalars)) return null;                 // updated-at renders a locale date
  const value = scalars[key];
  return typeof value === 'number' ? group(value) : String(value);
}

async function open(width, height, { theme = 'dark', query = '', locale = 'en', holdLocaleMs = 0 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale });
  await context.addInitScript(([t, l]) => {
    try { localStorage.setItem('sele4n-theme', t); } catch (e) {}
    try { localStorage.setItem('sele4n-locale-v1', l); } catch (e) {}
  }, [theme, locale]);
  const page = await context.newPage();
  if (holdLocaleMs) {
    await page.route(/\/locales\/[a-z-]+\.json(\?.*)?$/i, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, holdLocaleMs));
      await route.continue();
    });
  }
  const errors = [];
  page.on('console', (msg) => {
    // A blocked image logs a console error whose text carries no URL; the
    // message's location does, which is what separates "the logo host is
    // unreachable" from a real page error.
    if (msg.type() !== 'error') return;
    if (EXTERNAL.test(msg.location()?.url || '')) return;
    errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (request) => {
    if (!EXTERNAL.test(request.url())) errors.push(`requestfailed: ${request.url()}`);
  });
  await page.goto(`${BASE}/index.html${query}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  return { context, page, errors };
}

/** Live spans whose rendered text differs from the snapshot. */
async function mismatchedSpans(page) {
  const rendered = await page.$$eval('[data-live]', (els) =>
    els.map((el) => [el.getAttribute('data-live'), el.textContent.trim()]));
  return rendered
    .map(([key, text]) => [key, text, expected(key)])
    .filter(([, text, want]) => want !== null && want !== text);
}

/** Labels whose content no longer fits the box, now that each carries nested spans. */
function clippedLabels(page) {
  return page.$$eval('.arch-stat, .arch-layer-stat, .hero-stat, .stat-value', (els) =>
    els.filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.textContent.trim().slice(0, 48)));
}

const sideways = (page) => page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const [width, height, label] of [
  [1920, 1080, 'desktop wide'], [1440, 900, 'desktop'], [1024, 768, 'tablet'], [390, 844, 'phone']
]) {
  const { context, page, errors } = await open(width, height);
  console.log(`\n[${label} ${width}x${height}]`);

  const spans = await page.$$eval('[data-live]', (els) => els.length);
  const wrong = await mismatchedSpans(page);
  check(spans > 80, `the page carries its live spans (${spans})`);
  check(wrong.length === 0,
    `all ${spans} live spans render the snapshot${wrong.length ? ` — ${wrong.slice(0, 4).map(([k, t, w]) => `${k}: ${t} ≠ ${w}`).join(', ')}` : ''}`);

  const clipped = await clippedLabels(page);
  check(clipped.length === 0, `no figure label is clipped${clipped.length ? ` — ${clipped.join(' | ')}` : ''}`);

  const overflow = await sideways(page);
  check(overflow <= 0, `no sideways overflow (${overflow}px)`);
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

{
  // A locale that lands after the snapshot must not carry its own stale copy
  // of a figure back onto the page: data-i18n-html replaces innerHTML
  // wholesale, which is exactly how "546 build jobs" once survived a refresh.
  const { context, page, errors } = await open(1440, 900, { locale: 'es', holdLocaleMs: 600 });
  console.log('\n[Spanish, locale held back until after the snapshot paints]');

  const wrong = await mismatchedSpans(page);
  check(wrong.length === 0,
    `the translated page still renders the snapshot${wrong.length ? ` — ${wrong.slice(0, 4).map(([k, t, w]) => `${k}: ${t} ≠ ${w}`).join(', ')}` : ''}`);

  const ifc = await page.$eval('[data-i18n-html="security.ifc_text"]', (el) => el.textContent.trim());
  check(ifc.includes(group(SITE_DATA.subsystems['information-flow'].theorems)),
    'the security card carries the live theorem count');
  check(!/\b(through|across)\b/.test(ifc), 'and is rendered in Spanish, not English');

  const clipped = await clippedLabels(page);
  check(clipped.length === 0, `nothing clipped in the translated layout${clipped.length ? ` — ${clipped.join(' | ')}` : ''}`);
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

{
  // Deep links into the kernel tree are stamped from the snapshot; a link on
  // the page that the sync never resolved is a hand-written line number.
  const { context, page, errors } = await open(1440, 900, { theme: 'light' });
  console.log('\n[light theme, deep links]');

  const unresolved = await page.$$eval('a[href*="/blob/main/"]', (links) =>
    links.map((link) => {
      const anchor = /\/blob\/main\/([^#]+)#L(\d+)$/.exec(link.getAttribute('href'));
      const code = link.querySelector('code');
      return anchor && code ? [anchor[1], code.textContent.trim(), Number(anchor[2])] : null;
    }).filter(Boolean));

  const stale = unresolved.filter(([path, label, line]) => SITE_DATA.sourceAnchors?.[path]?.[label] !== line);
  check(unresolved.length > 20, `the page carries its deep links (${unresolved.length})`);
  check(stale.length === 0,
    `every anchor matches the resolved inventory${stale.length ? ` — ${stale.slice(0, 4).map(([p, l, n]) => `${p}#L${n} (${l})`).join(', ')}` : ''}`);

  const overflow = await sideways(page);
  check(overflow <= 0, `no sideways overflow in light theme (${overflow}px)`);
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

await browser.close();
console.log(failures ? `\nindex-smoke: ${failures} check(s) failed` : '\nindex-smoke: all checks passed');
process.exit(failures ? 1 : 0);
