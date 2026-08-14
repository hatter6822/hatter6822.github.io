/**
 * Regression tests for the static fallback rewriter.
 *
 * The sync workflow previously duplicated this substitution logic as sed
 * one-liners in YAML, where it drifted from the .mjs pipeline unnoticed.
 * These tests pin the mapping so index.html's no-JS fallbacks, JSON-LD, and
 * <time> stamp all track data/site-data.json exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyStaticValues } from './static-values.mjs';

const SAMPLE = [
  '<script type="application/ld+json">{"version": "0.0.1"}</script>',
  '<span data-live="theorems">1</span>',
  '<span data-live="lines">2</span>',
  '<span data-live="modules">3</span>',
  '<span data-live="scripts">4</span>',
  '<span data-live="docs">5</span>',
  '<span data-live="build-jobs">6</span>',
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
  buildJobs: 546,
  updatedAt: '2026-08-13T12:24:09Z'
};

test('rewrites every mapped data-live fallback', () => {
  const out = applyStaticValues(SAMPLE, DATA);
  assert.match(out, /data-live="theorems">8472</);
  assert.match(out, /data-live="lines">255,085</);
  assert.match(out, /data-live="modules">273</);
  assert.match(out, /data-live="scripts">61</);
  assert.match(out, /data-live="docs">245</);
  assert.match(out, /data-live="build-jobs">546</);
  assert.match(out, /data-live="lean-version">4.28.0</);
});

test('rewrites every version site: spans, JSON-LD, and time datetime', () => {
  const out = applyStaticValues(SAMPLE, DATA);
  assert.equal((out.match(/data-live="version">0\.33\.6</g) || []).length, 2);
  assert.match(out, /"version": "0\.33\.6"/);
  assert.match(out, /datetime="2026-08-13T12:24:09Z"/);
});

test('leaves unmapped fallbacks and missing keys untouched', () => {
  const out = applyStaticValues(SAMPLE, { theorems: 9000 });
  assert.match(out, /data-live="theorems">9000</);
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
  for (const key of ['version', 'lean-version', 'theorems', 'modules', 'scripts', 'docs', 'build-jobs', 'lines']) {
    const spans = out.match(new RegExp(`data-live="${key}">([^<]*)<`, 'g')) || [];
    assert.ok(spans.length > 0, `index.html has no data-live="${key}" span`);
  }
  // Committed tree must already be in sync — a diff here means someone
  // edited site-data.json without re-running scripts/apply-static-values.mjs.
  assert.equal(out, html, 'index.html static fallbacks are out of sync with data/site-data.json — run: node scripts/apply-static-values.mjs');
});
