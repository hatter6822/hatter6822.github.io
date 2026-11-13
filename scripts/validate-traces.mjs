#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateTraceDataObject, scenarioStates, checkProofCoverage } from './lib/trace-analysis.mjs';
import { collectTraceRefs, modulePath } from './lib/trace-anchors.mjs';

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
 * Every declaration a trace names must be grounded at the code map's revision.
 *
 * The sync resolves each `{ name, module }` reference to the line it is
 * declared on in its module's file (scripts/lib/trace-anchors.mjs) and records the commit as
 * `sourceRef`. Here that is checked against the other snapshot from the same
 * pipeline: the revision must be map-data's, every reference must carry its
 * stamp, and wherever the code map lists the module's declarations, the name
 * must be one of them on the stamped line. A hand edit that renames a
 * declaration, or a stale fixture from an older sync, fails here instead of
 * shipping a link to the wrong line.
 */
async function validateGrounding() {
  if (!traceData || process.exitCode) return;
  let mapData;
  try {
    mapData = JSON.parse(await readFile(new URL('../data/map-data.json', import.meta.url), 'utf8'));
  } catch {
    console.warn('ℹ️  map-data.json unavailable — skipping trace grounding check.');
    return;
  }
  if (traceData.sourceRef !== mapData.commitSha) {
    fail(`execution-traces.json sourceRef ${traceData.sourceRef} is not map-data.json's commit ${mapData.commitSha} — re-run scripts/sync-upstream.mjs so both are grounded at one revision`);
  }

  const lines = new Map(); // module → Map(name → Set(line))
  for (const [module, meta] of Object.entries(mapData.moduleMeta || {})) {
    const byName = new Map();
    for (const items of Object.values(meta?.symbols?.byKind || {})) {
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || !item.name) continue;
        if (!byName.has(item.name)) byName.set(item.name, new Set());
        byName.get(item.name).add(item.line);
      }
    }
    lines.set(module, byName);
  }

  let grounded = 0;
  for (const { ref, where } of collectTraceRefs(traceData)) {
    if (!modulePath(ref.module) || !Number.isInteger(ref.line)) {
      fail(`trace ${where}: ${ref.name} (${ref.module}) carries no source anchor — run scripts/sync-upstream.mjs`);
      continue;
    }
    const byName = lines.get(ref.module);
    if (!byName) continue; // outside the code map's production scope (e.g. SeLe4n.Testing, SeLe4n.Prelude)
    const last = ref.name.split('.').pop();
    const seen = byName.get(ref.name) || byName.get(last);
    if (!seen) fail(`trace ${where}: ${ref.name} is not a declaration of ${ref.module} in data/map-data.json`);
    else if (!seen.has(ref.line)) fail(`trace ${where}: ${ref.name} is declared at ${[...seen].join('/')} in ${ref.module}, not line ${ref.line}`);
    else grounded += 1;
  }
  if (!process.exitCode) console.log(`   ${grounded} declaration reference(s) agree with data/map-data.json at ${String(mapData.commitSha).slice(0, 7)}`);
}

/**
 * Every theorem an invariant cites must be about the transition it is cited
 * for. The catalogue says which function each theorem is about (`subject`) and
 * which steps that function is (`covers`); the kernel's call graph, bundled
 * from the same commit, says whether that is so (`checkProofCoverage`). This
 * is what a line anchor cannot catch: `timerTick_preserves_…` resolved, and
 * was cited for every step, while the dispatched path runs `timerTickOnCore`.
 */
async function validateProofCoverage() {
  if (!traceData || process.exitCode) return;
  let graph;
  try {
    graph = JSON.parse(await readFile(new URL('../data/map-callgraph.json', import.meta.url), 'utf8'));
  } catch (e) {
    // The call graph is bundled beside the traces; without it the claim that a
    // theorem covers a step is unchecked, which is a failure and not a skip.
    fail(`map-callgraph.json could not be read, so proof coverage is unchecked — ${e.message}`);
    return;
  }
  if (graph.commitSha !== traceData.sourceRef) {
    fail(`map-callgraph.json is at ${graph.commitSha}, execution-traces.json at ${traceData.sourceRef} — re-run scripts/sync-upstream.mjs`);
    return;
  }
  const issues = checkProofCoverage(traceData, graph.callGraph);
  for (const issue of issues) fail(`proof coverage — ${issue}`);
  if (!issues.length) {
    const proofs = traceData.invariantCatalog.reduce((n, inv) => n + (inv.preservedBy || []).length, 0);
    console.log(`   ${proofs} preservation theorem(s) are about the transitions they are cited for (data/map-callgraph.json)`);
  }
}

await validateTraceDataAndCapture();
await validateGrounding();
await validateProofCoverage();

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
