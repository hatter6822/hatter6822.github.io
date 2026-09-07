#!/usr/bin/env node
/**
 * Rewrite the landing page's static fallback values from data/site-data.json.
 *
 * Run after scripts/sync-site-data.mjs so the no-JS fallbacks, the JSON-LD
 * block, and the metric literals baked into every locale's translated HTML all
 * stay in lockstep with the bundled snapshot. Idempotent: re-running with
 * unchanged data produces byte-identical output.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { applyStaticValues, applyLocaleStaticValues } from './lib/static-values.mjs';

const ROOT = new URL('../', import.meta.url);
const DATA_FILE = new URL('data/site-data.json', ROOT);
const HTML_FILE = new URL('index.html', ROOT);
const LOCALES_DIR = new URL('locales/', ROOT);

const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
const updated = [];

const html = await readFile(HTML_FILE, 'utf8');
const nextHtml = applyStaticValues(html, data);
if (nextHtml !== html) {
  await writeFile(HTML_FILE, nextHtml);
  updated.push('index.html');
}

for (const name of (await readdir(LOCALES_DIR)).filter((f) => f.endsWith('.json')).sort()) {
  const file = new URL(name, LOCALES_DIR);
  const json = await readFile(file, 'utf8');
  const next = applyLocaleStaticValues(json, data);
  if (next === json) continue;
  JSON.parse(next); // a substitution must never break the locale bundle
  await writeFile(file, next);
  updated.push(`locales/${name}`);
}

if (updated.length) console.log(`Updated static fallback values in ${updated.join(', ')}`);
else console.log('Static fallback values already in sync');
