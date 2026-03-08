#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateMapDataObject, validateSiteDataObject } from './lib/data-validation.mjs';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

async function validateSiteData() {
  const raw = await readFile(new URL('../data/site-data.json', import.meta.url), 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch (e) { return fail(`site-data.json: invalid JSON — ${e.message}`); }
  const errors = validateSiteDataObject(data);
  for (const message of errors) fail(message);
}

async function validateMapData() {
  const raw = await readFile(new URL('../data/map-data.json', import.meta.url), 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch (e) { return fail(`map-data.json: invalid JSON — ${e.message}`); }
  const errors = validateMapDataObject(data);
  for (const message of errors) fail(message);
}

await validateSiteData();
await validateMapData();

if (!process.exitCode) {
  console.log('✅ Data files validated');
}
