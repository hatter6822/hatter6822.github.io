#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateMapDataObject, validateSiteDataObject } from './lib/data-validation.mjs';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

async function validateSiteData() {
  const raw = await readFile(new URL('../data/site-data.json', import.meta.url), 'utf8');
  const data = JSON.parse(raw);
  const errors = validateSiteDataObject(data);
  for (const message of errors) fail(message);
}

async function validateMapData() {
  const raw = await readFile(new URL('../data/map-data.json', import.meta.url), 'utf8');
  const data = JSON.parse(raw);
  const errors = validateMapDataObject(data);
  for (const message of errors) fail(message);
}

await validateSiteData();
await validateMapData();

if (!process.exitCode) {
  console.log('✅ Data files validated');
}
