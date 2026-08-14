#!/usr/bin/env node
/**
 * Sync the Simulator trace snapshot from the upstream kernel repo.
 *
 * The kernel's trace harness is the source of truth: once it emits a structured
 * `docs/execution-traces.json` (see docs/SIMULATOR_SPEC.md §6), this
 * script fetches it, validates it against the schema + a full fold dry-run, and
 * writes the bundled `data/execution-traces.json`.
 *
 * Until that upstream artifact exists, the fetch 404s and the script leaves the
 * hand-authored reference fixture in place — the site keeps working with
 * `source: "fixture"`.
 */
import { writeFile } from 'node:fs/promises';
import { validateTraceDataObject, scenarioStates } from './lib/trace-analysis.mjs';

const REPO = 'hatter6822/seLe4n';
const REF = 'main';
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/${REF}/`;
const UPSTREAM_PATH = 'docs/execution-traces.json';
const OUT_FILE = new URL('../data/execution-traces.json', import.meta.url);
const TIMEOUT_MS = 9000;

function signal() {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
}

/** Prefer the raw endpoint; fall back to the contents API (base64). Returns null on a clean 404. */
async function fetchUpstream() {
  try {
    const res = await fetch(`${RAW}${UPSTREAM_PATH}`, { signal: signal() });
    if (res.ok) return res.json();
    if (res.status !== 404) throw new Error(`raw HTTP ${res.status}`);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('raw fetch timed out');
    // fall through to the contents API
  }
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`${API}/contents/${UPSTREAM_PATH}?ref=${REF}`, {
    headers,
    signal: signal()
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`contents API HTTP ${res.status}`);
  const payload = await res.json();
  if (!payload || payload.encoding !== 'base64' || !payload.content) return null;
  return JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8'));
}

let upstream;
try {
  upstream = await fetchUpstream();
} catch (e) {
  console.error(`❌ Could not fetch ${UPSTREAM_PATH}: ${e.message}`);
  process.exitCode = 1;
}

if (upstream === null) {
  console.warn(`⚠️  ${REPO}:${UPSTREAM_PATH} does not exist yet — keeping the bundled reference fixture. Re-run once the kernel trace harness emits it.`);
} else if (upstream) {
  const errors = validateTraceDataObject(upstream);
  if (errors.length) {
    console.error('❌ Upstream trace data failed validation; refusing to overwrite the bundled snapshot:');
    for (const m of errors) console.error(`   - ${m}`);
    process.exitCode = 1;
  } else {
    let steps = 0;
    for (const sc of upstream.scenarios) steps += scenarioStates(sc).length; // fold dry-run must not throw
    await writeFile(OUT_FILE, JSON.stringify(upstream, null, 2) + '\n', 'utf8');
    console.log(`✅ Wrote data/execution-traces.json from ${REPO}:${UPSTREAM_PATH} — ${upstream.scenarios.length} scenario(s), ${steps} step(s), source=${upstream.source}`);
  }
}
