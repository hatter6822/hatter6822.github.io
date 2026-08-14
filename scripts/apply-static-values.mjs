#!/usr/bin/env node
/**
 * Rewrite index.html's static fallback values from data/site-data.json.
 *
 * Run after scripts/sync-site-data.mjs so the no-JS fallbacks and JSON-LD
 * stay in lockstep with the bundled snapshot. Idempotent: re-running with
 * unchanged data produces byte-identical output.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { applyStaticValues } from './lib/static-values.mjs';

const DATA_FILE = new URL('../data/site-data.json', import.meta.url);
const HTML_FILE = new URL('../index.html', import.meta.url);

const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
const html = await readFile(HTML_FILE, 'utf8');
const next = applyStaticValues(html, data);

if (next === html) {
  console.log('index.html static values already in sync');
} else {
  await writeFile(HTML_FILE, next);
  console.log('Updated index.html static fallback values from data/site-data.json');
}
