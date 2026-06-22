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

await validateTraceDataAndCapture();

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
