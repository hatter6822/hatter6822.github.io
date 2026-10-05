#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateMapDataObject, validateSiteDataObject, validateCallGraphDataObject, validateCrossFile } from './lib/data-validation.mjs';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

let siteData, mapData, callGraphData;

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

async function validateCallGraphDataAndCapture() {
  const raw = await readFile(new URL('../data/map-callgraph.json', import.meta.url), 'utf8');
  try { callGraphData = JSON.parse(raw); } catch (e) { return fail(`map-callgraph.json: invalid JSON — ${e.message}`); }
  const errors = validateCallGraphDataObject(callGraphData);
  for (const message of errors) fail(message);
}

await validateSiteDataAndCapture();
await validateMapDataAndCapture();
await validateCallGraphDataAndCapture();

// Cross-file disagreement is fatal, not advisory: it means the snapshots did
// not come from one pipeline run, which is exactly how the landing page and the
// code map ended up quoting different counts for the same kernel.
if (siteData && mapData) {
  if (!callGraphData) fail('map-callgraph.json: missing or unreadable — the declaration view has no call graph');
  for (const message of validateCrossFile(siteData, mapData, callGraphData)) fail(message);
}

if (!process.exitCode) {
  console.log('✅ Data files validated');
}
