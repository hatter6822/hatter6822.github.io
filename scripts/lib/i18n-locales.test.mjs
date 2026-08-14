/**
 * Locale completeness guard.
 *
 * en.json is the reference surface: every locale must carry exactly the same
 * key set. This has silently broken before — four locales shipped without the
 * entire simulator (run.*) surface, so those pages fell back to English for
 * most visitors. Key-set parity is checkable at build time; check it here.
 *
 * Values are also sanity-checked: no empty strings, and every data-i18n key
 * referenced by the HTML pages must exist in en.json.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const ROOT = new URL('../../', import.meta.url);
const LOCALES_DIR = new URL('locales/', ROOT);
const PAGES = ['index.html', 'map.html', 'run.html'];

function flattenKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...flattenKeys(v, key));
    else keys.push(key);
  }
  return keys;
}

function flattenEntries(obj, prefix = '') {
  const entries = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) entries.push(...flattenEntries(v, key));
    else entries.push([key, v]);
  }
  return entries;
}

const localeFiles = (await readdir(LOCALES_DIR)).filter((f) => f.endsWith('.json')).sort();
const en = JSON.parse(await readFile(new URL('en.json', LOCALES_DIR), 'utf8'));
const enKeys = new Set(flattenKeys(en));

test('en.json exists and has a non-trivial key surface', () => {
  assert.ok(enKeys.size > 100, `en.json has only ${enKeys.size} keys`);
});

for (const file of localeFiles) {
  if (file === 'en.json') continue;
  test(`${file} has exact key parity with en.json`, async () => {
    const locale = JSON.parse(await readFile(new URL(file, LOCALES_DIR), 'utf8'));
    const keys = new Set(flattenKeys(locale));
    const missing = [...enKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !enKeys.has(k));
    assert.deepEqual(missing, [], `${file} is missing ${missing.length} key(s): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`);
    assert.deepEqual(extra, [], `${file} has ${extra.length} extra key(s): ${extra.slice(0, 10).join(', ')}${extra.length > 10 ? ', …' : ''}`);
  });
}

for (const file of localeFiles) {
  test(`${file} has no empty or non-string leaf values`, async () => {
    const locale = JSON.parse(await readFile(new URL(file, LOCALES_DIR), 'utf8'));
    const bad = flattenEntries(locale).filter(([, v]) => typeof v !== 'string' || v.trim() === '');
    assert.deepEqual(bad.map(([k]) => k), [], `${file} has empty/non-string values`);
  });
}

test('every data-i18n key referenced by the HTML pages exists in en.json', async () => {
  const attrs = ['data-i18n', 'data-i18n-html', 'data-i18n-content', 'data-i18n-title', 'data-i18n-aria-label', 'data-i18n-placeholder'];
  const missing = new Set();
  for (const page of PAGES) {
    const html = await readFile(new URL(page, ROOT), 'utf8');
    for (const attr of attrs) {
      for (const m of html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))) {
        if (!enKeys.has(m[1])) missing.add(`${page}: ${attr}="${m[1]}"`);
      }
    }
  }
  assert.deepEqual([...missing], [], `HTML references ${missing.size} key(s) absent from en.json`);
});
