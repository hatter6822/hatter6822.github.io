#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateTraceDataObject, scenarioStates } from './lib/trace-analysis.mjs';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

let traceData;

async function validateTraceDataAndCapture() {
  const raw = await readFile(new URL('../data/execution-traces.json', import.meta.url), 'utf8');
  try { traceData = JSON.parse(raw); } catch (e) { return fail(`execution-traces.json: invalid JSON — ${e.message}`); }
  const errors = validateTraceDataObject(traceData);
  for (const message of errors) fail(message);
}

/**
 * Every module a trace links to — invariant-rail proof targets (`mapModule`)
 * and inspector source links (`sourceRefs[].module`) — must resolve to a module
 * present in the bundled map snapshot. `map.js` falls back to the first module
 * for an unknown `?module=`, so an unresolved link silently lands users on the
 * wrong code-map context instead of the proof it advertises.
 */
async function validateMapLinks() {
  if (!traceData || process.exitCode) return;
  let mapData;
  try {
    mapData = JSON.parse(await readFile(new URL('../data/map-data.json', import.meta.url), 'utf8'));
  } catch {
    console.warn('ℹ️  map-data.json unavailable — skipping trace→map link resolution check.');
    return;
  }
  const known = new Set();
  (mapData.modules || []).forEach((m) => known.add(m.name || m.module || m.id));
  if (mapData.moduleMeta) Object.keys(mapData.moduleMeta).forEach((k) => known.add(k));
  if (mapData.moduleMap) Object.keys(mapData.moduleMap).forEach((k) => known.add(k));

  const refs = new Map(); // module → first place it's referenced (for a useful error)
  const note = (mod, where) => { if (mod && !refs.has(mod)) refs.set(mod, where); };
  (traceData.invariantCatalog || []).forEach((inv) => note(inv.mapModule, `invariant "${inv.id}".mapModule`));
  (traceData.scenarios || []).forEach((sc) => (sc.steps || []).forEach((st, i) => (st.sourceRefs || []).forEach((r) => {
    note(r.module, `scenario "${sc.id}" step ${i} sourceRef "${r.label || r.module}".module`);
    note(r.mapModule, `scenario "${sc.id}" step ${i} sourceRef "${r.label || r.mapModule}".mapModule`);
  })));
  for (const [mod, where] of refs) {
    if (!known.has(mod)) fail(`trace ${where} → "${mod}" does not resolve to a module in data/map-data.json (the proof link would land on the wrong code-map context)`);
  }
}

await validateTraceDataAndCapture();
await validateMapLinks();

if (traceData && !process.exitCode) {
  let stepCount = 0;
  for (const sc of traceData.scenarios) {
    // Folding here is a second integrity gate: it must not throw.
    stepCount += scenarioStates(sc).length;
  }
  console.log(`✅ execution-traces.json validated — ${traceData.scenarios.length} scenario(s), ${stepCount} step(s), source=${traceData.source}`);
  if (traceData.source !== 'kernel') {
    console.warn('⚠️  source is not "kernel" — these traces are illustrative fixtures, not a replay of a machine-checked kernel run.');
  }
}
