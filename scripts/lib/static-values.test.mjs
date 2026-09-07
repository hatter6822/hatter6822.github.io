/**
 * Regression tests for the static fallback rewriter.
 *
 * The sync workflow previously duplicated this substitution logic as sed
 * one-liners in YAML, where it drifted from the .mjs pipeline unnoticed.
 * These tests pin the mapping so index.html's no-JS fallbacks, JSON-LD,
 * <time> stamp, and every locale's translated HTML all track
 * data/site-data.json exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { applyStaticValues, applyLocaleStaticValues } from './static-values.mjs';

const SAMPLE = [
  '<script type="application/ld+json">{"version": "0.0.1"}</script>',
  '<span data-live="theorems">1</span>',
  '<span data-live="lines">2</span>',
  '<span data-live="modules">3</span>',
  '<span data-live="scripts">4</span>',
  '<span data-live="docs">5</span>',
  '<span data-live="admitted">0</span>',
  '<span data-live="version">0.0.1</span> and <strong data-live="version">0.0.1</strong>',
  '<span data-live="lean-version">4.0.0</span>',
  '<span data-live="commit-sha">main</span>',
  '<time data-live="updated-at" datetime="2020-01-01T00:00:00Z">live from repository</time>'
].join('\n');

const DATA = {
  version: '0.33.6',
  leanVersion: '4.28.0',
  theorems: 8472,
  lines: '255,085',
  modules: 273,
  scripts: 61,
  docs: 245,
  admitted: 0,
  updatedAt: '2026-08-13T12:24:09Z'
};

test('rewrites every mapped data-live fallback', () => {
  const out = applyStaticValues(SAMPLE, DATA);
  assert.match(out, /data-live="theorems">8,472</);
  assert.match(out, /data-live="lines">255,085</);
  assert.match(out, /data-live="modules">273</);
  assert.match(out, /data-live="scripts">61</);
  assert.match(out, /data-live="docs">245</);
  assert.match(out, /data-live="lean-version">4.28.0</);
});

test('stamps the admitted-proof count, which is no longer a constant', () => {
  // admitted is derived from the artifact (axiom declarations plus anything
  // reaching sorry). Unstamped, a no-JS view would keep claiming zero on the
  // day the kernel reports otherwise.
  const out = applyStaticValues('<span data-live="admitted">0</span>', { admitted: 3 });
  assert.match(out, /data-live="admitted">3</);
});

test('renders counts exactly as assets/js/site.js renders them', () => {
  // site.js groups numeric metrics on hydration. If the stamped literal is not
  // grouped identically the figure visibly rewrites itself on load.
  const out = applyStaticValues('<span data-live="theorems">x</span>', { theorems: 11000 });
  assert.match(out, /data-live="theorems">11,000</);
  // `lines` is published pre-grouped as a string and must pass through.
  assert.match(
    applyStaticValues('<span data-live="lines">x</span>', { lines: '330,569' }),
    /data-live="lines">330,569</
  );
});

test('rewrites every version site: spans, JSON-LD, and time datetime', () => {
  const out = applyStaticValues(SAMPLE, DATA);
  assert.equal((out.match(/data-live="version">0\.33\.6</g) || []).length, 2);
  assert.match(out, /"version": "0\.33\.6"/);
  assert.match(out, /datetime="2026-08-13T12:24:09Z"/);
});

test('leaves unmapped fallbacks and missing keys untouched', () => {
  const out = applyStaticValues(SAMPLE, { theorems: 9000 });
  assert.match(out, /data-live="theorems">9,000</);
  assert.match(out, /data-live="commit-sha">main</); // never rewritten: JS-only value
  assert.match(out, /data-live="modules">3</); // key absent → untouched
  assert.match(out, /"version": "0\.0\.1"/);
});

test('is idempotent', () => {
  const once = applyStaticValues(SAMPLE, DATA);
  assert.equal(applyStaticValues(once, DATA), once);
});

test('values containing $ survive replacement verbatim', () => {
  const out = applyStaticValues('<span data-live="lines">1</span>', { lines: "1$'2" });
  assert.match(out, /data-live="lines">1\$'2</);
});

test('applies cleanly to the real index.html and hits every mapped span', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const data = JSON.parse(await readFile(new URL('../../data/site-data.json', import.meta.url), 'utf8'));
  const out = applyStaticValues(html, data);
  for (const key of ['version', 'lean-version', 'theorems', 'modules', 'scripts', 'docs', 'lines', 'admitted']) {
    const spans = out.match(new RegExp(`data-live="${key}">([^<]*)<`, 'g')) || [];
    assert.ok(spans.length > 0, `index.html has no data-live="${key}" span`);
  }
  // Committed tree must already be in sync — a diff here means someone
  // edited site-data.json without re-running scripts/apply-static-values.mjs.
  assert.equal(out, html, 'index.html static fallbacks are out of sync with data/site-data.json — run: node scripts/apply-static-values.mjs');
});

test('rewrites metric literals baked into escaped locale JSON', () => {
  // data-i18n-html swaps an element's innerHTML wholesale, so each locale
  // carries its own copy of the spans — and once carried "546 build jobs"
  // while index.html said 574.
  const locale = '{"a":"All <span data-live=\\"theorems\\">1</span> of <span data-live=\\"modules\\">2</span>"}';
  const out = applyLocaleStaticValues(locale, { theorems: 11000, modules: 311 });
  assert.equal(JSON.parse(out).a, 'All <span data-live="theorems">11,000</span> of <span data-live="modules">311</span>');
});

test('locale rewriting leaves translator-authored text alone', () => {
  // Deliberately narrower than applyStaticValues: no JSON-LD or <time> rules.
  const locale = '{"version":"keep me","when":"datetime=\\"2020-01-01T00:00:00Z\\""}';
  assert.equal(applyLocaleStaticValues(locale, { version: '9.9.9', updatedAt: '2026-01-01T00:00:00Z' }), locale);
});

test('every locale bundle is in sync with data/site-data.json', async () => {
  const root = new URL('../../', import.meta.url);
  const data = JSON.parse(await readFile(new URL('data/site-data.json', root), 'utf8'));
  const dir = new URL('locales/', root);

  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.json'))) {
    const json = await readFile(new URL(name, dir), 'utf8');
    assert.equal(
      applyLocaleStaticValues(json, data), json,
      `locales/${name} metric literals are out of sync with data/site-data.json — run: node scripts/apply-static-values.mjs`
    );
  }
});
