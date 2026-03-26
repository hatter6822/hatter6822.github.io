#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateMapDataObject, validateSiteDataObject, validateCrossFile } from './lib/data-validation.mjs';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

let siteData, mapData;

async function validateSiteDataAndCapture() {
  const raw = await readFile(new URL('../data/site-data.json', import.meta.url), 'utf8');
  try { siteData = JSON.parse(raw); } catch (e) { return fail(`site-data.json: invalid JSON — ${e.message}`); }
  const errors = validateSiteDataObject(siteData);
  for (const message of errors) fail(message);
}

async function validateMapDataAndCapture() {
  const raw = await readFile(new URL('../data/map-data.json', import.meta.url), 'utf8');
  try { mapData = JSON.parse(raw); } catch (e) { return fail(`map-data.json: invalid JSON — ${e.message}`); }
  const errors = validateMapDataObject(mapData);
  for (const message of errors) fail(message);
}

await validateSiteDataAndCapture();
await validateMapDataAndCapture();

if (siteData && mapData) {
  const crossErrors = validateCrossFile(siteData, mapData);
  for (const message of crossErrors) {
    console.warn(`⚠️  ${message}`);
  }
}

if (!process.exitCode) {
  console.log('✅ Data files validated');
}
