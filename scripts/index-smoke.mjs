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
 * no viewport scrolls sideways, no card grid runs uneven or past the screen,
 * and the console stays clean. Every request
 * the page makes is same-origin (the logo is self-hosted and the CSP names no
 * other origin), so any failed request or console error is a real one.
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
    'frozen-syscalls': SITE_DATA.frozenSyscalls,
    scripts: SITE_DATA.scripts,
    docs: SITE_DATA.docs,
    admitted: SITE_DATA.admitted,
    'commit-sha': SITE_DATA.commitSha
  };
  if (!(key in scalars)) return null;                 // updated-at renders a locale date
  const value = scalars[key];
  return typeof value === 'number' ? group(value) : String(value);
}

async function open(width, height, { theme = 'dark', query = '', locale = 'en', holdLocaleMs = 0, poison = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale });
  await context.addInitScript(([t, l]) => {
    try { localStorage.setItem('sele4n-theme', t); } catch (e) {}
    try { localStorage.setItem('sele4n-locale-v1', l); } catch (e) {}
  }, [theme, locale]);
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const page = await context.newPage();
  if (poison) {
    // Serve the real locale with some of its strings replaced, as a tampered
    // or mistranslated bundle would arrive.
    await page.route(/\/locales\/[a-z-]+\.json(\?.*)?$/i, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const [key, value] of Object.entries(poison)) {
        const parts = key.split('.');
        let at = body;
        for (const part of parts.slice(0, -1)) at = at[part];
        at[parts[parts.length - 1]] = value;
      }
      await route.fulfill({ response, json: body });
    });
  }
  if (holdLocaleMs) {
    await page.route(/\/locales\/[a-z-]+\.json(\?.*)?$/i, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, holdLocaleMs));
      await route.continue();
    });
  }
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (request) => {
    errors.push(`requestfailed: ${request.url()}`);
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

/**
 * Card grids whose columns are uneven or whose cards run past the viewport.
 * `overflow-x: hidden` on the page hides a too-wide card from the sideways
 * check above — the card is simply cut off — so the cards are measured
 * themselves. A bare `1fr` track sized one column to its longest unbreakable
 * run: 521 / 267 / 267 at 1440px, and 454px cards on a 390px phone.
 */
function cardGridDefects(page) {
  return page.$$eval('.grid, .features-grid', (grids) => {
    const viewport = document.documentElement.clientWidth;
    const out = [];
    for (const grid of grids) {
      const where = grid.closest('section')?.id || grid.className;
      const widths = [...grid.children].map((c) => c.getBoundingClientRect().width);
      if (widths.length > 1 && Math.max(...widths) - Math.min(...widths) > 2) {
        out.push(`#${where} columns ${widths.map(Math.round).join('/')}`);
      }
      for (const card of grid.children) {
        const right = card.getBoundingClientRect().right;
        if (right > viewport + 0.5) out.push(`#${where} card ends at ${Math.round(right)} of ${viewport}px`);
      }
    }
    return out;
  });
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
  const cards = await cardGridDefects(page);
  check(cards.length === 0, `card grids have even columns inside the viewport${cards.length ? ` — ${cards.slice(0, 4).join(' | ')}` : ''}`);
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

  const anchored = await page.$$eval('a[href*="/blob/"]', (links) =>
    links.map((link) => {
      const anchor = /\/blob\/([^/]+)\/([^#]+)#L(\d+)$/.exec(link.getAttribute('href'));
      const code = link.querySelector('code');
      return anchor && code ? [anchor[1], anchor[2], code.textContent.trim(), Number(anchor[3])] : null;
    }).filter(Boolean));

  const stale = anchored.filter(([, path, label, line]) => SITE_DATA.sourceAnchors?.[path]?.[label] !== line);
  check(anchored.length > 20, `the page carries its deep links (${anchored.length})`);
  check(stale.length === 0,
    `every anchor matches the resolved inventory${stale.length ? ` — ${stale.slice(0, 4).map(([, p, l, n]) => `${p}#L${n} (${l})`).join(', ')}` : ''}`);

  // A line number only means anything against a fixed revision, so an anchored
  // link names the commit its line was resolved at rather than a branch.
  const wrongRef = anchored.filter(([ref]) => ref !== SITE_DATA.sourceAnchorRef);
  check(wrongRef.length === 0,
    `every anchored link names the resolved revision${wrongRef.length ? ` — ${[...new Set(wrongRef.map(([r]) => r))].join(', ')}` : ''}`);

  const overflow = await sideways(page);
  check(overflow <= 0, `no sideways overflow in light theme (${overflow}px)`);
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await context.close();
}

{
  // The locale sanitizer against markup it must not let through. A locale is
  // same-origin and reviewed, so this is defence in depth — but it is the one
  // place the site turns a string into markup, and the pieces below are the
  // ones that break sanitizers: a parse that differs the second time round
  // (the nodes are adopted, never re-parsed), names that are allowed in HTML
  // and mean something else in SVG or MathML, and URLs the parser rewrites.
  const battery = [
    '<img src=x onerror="window.__pwned=1">',
    '<svg onload="window.__pwned=2"><a href="javascript:window.__pwned=3">svg-a</a><style><a title="</style><img src=x onerror=window.__pwned=4>"></style></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=x onerror=window.__pwned=5&gt;">',
    '<noscript><p title="</noscript><img src=x onerror=window.__pwned=6>"></noscript>',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=window.__pwned=7>',
    '<a href="javascript:window.__pwned=8" onclick="window.__pwned=9" id="x" title="t" tabindex="0">js</a>',
    '<a href="/\t/evil.example/">tab</a><a href="//evil.example/">rel</a><a href="/\\evil.example/">back</a>',
    '<a href=" javascript:window.__pwned=10">lead</a><a href="data:text/html,<script>window.__pwned=11</script>">data</a>',
    '<script>window.__pwned=12</script><iframe srcdoc="<script>parent.__pwned=13</script>"></iframe>',
    '<template><img src=x onerror=window.__pwned=14></template><base href="https://evil.example/">',
    '<object data="https://evil.example/x"></object><embed src="https://evil.example/x"><link rel=stylesheet href="https://evil.example/x.css">',
    '<!-- comment --><span id="kept-id" class="kept-class" data-live="modules">0</span>',
    '<a href="/map.html" target="_blank" rel="opener">kept</a> <strong>strong</strong> <code>code</code>'
  ].join(' ');
  // No style="…" in the battery: the parser reports a style attribute to the
  // policy as it parses, inert document or not, so one would be refused (and
  // logged) by style-src before the sanitizer removes it. Everything above is
  // stopped by the sanitizer alone, which is what the violation check proves.
  const { context, page, errors } = await open(1440, 900, { poison: { 'security.ifc_text': battery } });
  console.log('\n[a poisoned locale string through the sanitizer]');

  const report = await page.$eval('[data-i18n-html="security.ifc_text"]', (el) => {
    const allowed = new Set(['a', 'br', 'code', 'em', 'span', 'strong', 'wbr']);
    const all = [...el.querySelectorAll('*')];
    return {
      strangers: all.filter((node) => node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !allowed.has(node.localName))
        .map((node) => node.localName),
      attributes: [...new Set(all.flatMap((node) => [...node.attributes].map((attr) => attr.name)))].sort(),
      hrefs: all.filter((node) => node.localName === 'a').map((node) => node.getAttribute('href')),
      offOrigin: all.filter((node) => node.localName === 'a' && node.hasAttribute('href') && node.origin !== location.origin)
        .map((node) => node.href),
      rels: [...new Set(all.filter((node) => node.localName === 'a').map((node) => node.getAttribute('rel')))],
      comments: document.createTreeWalker(el, NodeFilter.SHOW_COMMENT).nextNode() !== null,
      live: el.querySelector('span.kept-class[data-live="modules"]')?.textContent,
      text: el.textContent,
      pwned: window.__pwned,
      violations: window.__cspViolations,
      bases: document.querySelectorAll('base').length
    };
  });
  check(report.pwned === undefined, `no payload ran (window.__pwned = ${report.pwned})`);
  check(report.strangers.length === 0, `only allowlisted HTML elements reached the page${report.strangers.length ? ` — ${report.strangers.join(', ')}` : ''}`);
  check(report.attributes.every((name) => ['class', 'data-i18n', 'data-live', 'href', 'rel', 'target'].includes(name)),
    `only allowlisted attributes survive (${report.attributes.join(', ')})`);
  check(report.hrefs.filter(Boolean).join(' ') === '/map.html', `one href survives, the same-origin one (${JSON.stringify(report.hrefs)})`);
  check(report.offOrigin.length === 0, `no link resolves off the origin${report.offOrigin.length ? ` — ${report.offOrigin.join(', ')}` : ''}`);
  check(report.rels.length === 1 && report.rels[0] === 'noopener noreferrer', `every link is rel="noopener noreferrer" (${report.rels.join(' | ')})`);
  check(!report.comments && report.bases === 0, 'no comment and no <base> came through');
  check(report.text.includes('strong') && report.text.includes('kept'), 'allowed content is kept');
  check(report.live === group(SITE_DATA.modules), `a data-live span in a locale string is hydrated from the snapshot (${report.live})`);
  check(report.violations.length === 0, `no policy violation was needed to stop it${report.violations.length ? ` — ${report.violations.join(' | ')}` : ''}`);
  check(errors.length === 0, `clean console${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);

  // And the policy underneath: a string cannot reach an HTML sink at all, and
  // page code cannot mint itself a policy to get round that.
  const enforced = await page.evaluate(() => {
    const out = {};
    try { document.createElement('div').innerHTML = '<b>x</b>'; out.sink = 'accepted'; } catch (e) { out.sink = e.name; }
    try { window.trustedTypes.createPolicy('other', { createHTML: (x) => x }); out.policy = 'created'; } catch (e) { out.policy = e.name; }
    try { window.trustedTypes.createPolicy('sele4n-i18n', { createHTML: (x) => x }); out.duplicate = 'created'; } catch (e) { out.duplicate = e.name; }
    return out;
  });
  check(enforced.sink === 'TypeError', `Trusted Types refuses a string at an HTML sink (${enforced.sink})`);
  check(enforced.policy === 'TypeError' && enforced.duplicate === 'TypeError',
    `and refuses a second policy, by a new name or the sanitizer's own (${enforced.policy}, ${enforced.duplicate})`);
  await context.close();
}

await browser.close();
console.log(failures ? `\nindex-smoke: ${failures} check(s) failed` : '\nindex-smoke: all checks passed');
process.exit(failures ? 1 : 0);
