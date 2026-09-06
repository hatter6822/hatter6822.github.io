#!/usr/bin/env node
/**
 * Regenerate data/site-data.json from the seLe4n canonical codebase map.
 *
 * Every statistic the landing page displays is projected here, offline, from
 * `docs/codebase_map.json` — the artifact the kernel generates and from which
 * its own README table is rendered. The browser never re-derives a metric; it
 * renders this snapshot. Concentrating the projection in one reviewed, tested,
 * CI-run place is what keeps the page and the kernel from disagreeing.
 *
 * The one thing the canonical map does not describe is the repository's
 * non-Lean inventory, so the shell-script and documentation counts come from
 * the git tree. Those are exact file counts, not estimates; nothing else on
 * the page comes from outside the artifact.
 *
 * Network shape: one raw file download plus one blobless shallow clone
 * (~200 KB, trees only). No REST calls, so no 60/hr anonymous quota and no
 * token requirement — the same reasoning that moved sync-map-data.mjs off the
 * REST API, and it also sidesteps the tree endpoint's `truncated` cliff.
 */
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalMetricsIssues,
  canonicalProvenance,
  siteMetricsFromCodebaseMap
} from './lib/lean-analysis.mjs';

const REPO = 'hatter6822/seLe4n';
const REF = 'main';
const METRICS_PATH = 'docs/codebase_map.json';
const RAW = `https://raw.githubusercontent.com/${REPO}/${REF}/`;
const OUT_FILE = new URL('../data/site-data.json', import.meta.url);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** List every tracked path at REF without downloading a single blob. */
async function listRepositoryFiles() {
  const work = await mkdtemp(join(tmpdir(), 'sele4n-tree-'));
  try {
    execFileSync('git', [
      'clone', '--filter=blob:none', '--no-checkout', '--depth', '1',
      '--branch', REF, `https://github.com/${REPO}.git`, work
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const listing = execFileSync('git', ['-C', work, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
    return listing.split('\n').filter(Boolean);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const [codebaseMap, files] = await Promise.all([
  fetchJson(`${RAW}${METRICS_PATH}`),
  listRepositoryFiles()
]);

// Fail loudly rather than publishing a partial projection. A missing key means
// the upstream schema moved; every earlier silent miss became a fabricated
// number on the landing page.
const issues = canonicalMetricsIssues(codebaseMap);
if (issues.length) {
  throw new Error(`canonical metrics unavailable:\n  ${issues.join('\n  ')}`);
}

const metrics = siteMetricsFromCodebaseMap(codebaseMap);
const provenance = canonicalProvenance(codebaseMap);

const data = {
  version: metrics.version,
  leanVersion: metrics.leanVersion,
  modules: metrics.modules,
  lines: formatNumber(metrics.lines),
  theorems: metrics.theorems,
  scripts: files.filter((path) => /^scripts\/.*\.sh$/.test(path)).length,
  docs: files.filter((path) => /^docs\/.*\.(md|txt)$/.test(path)).length,
  admitted: metrics.admitted,
  commitSha: provenance.commitSha,
  updatedAt: provenance.updatedAt,
  sourceRepo: REPO,
  sourceRef: REF,
  metricsSource: METRICS_PATH,
  // Production Lean only — see the scope note in lib/lean-analysis.mjs.
  metricsScope: 'production',
  schemaVersion: provenance.schemaVersion,
  sourceDigest: provenance.sourceDigest,
  generatedAt: new Date().toISOString()
};

await writeFile(OUT_FILE, JSON.stringify(data, null, 2) + '\n');
console.log(
  `Updated ${new URL(OUT_FILE).pathname} — v${data.version} @ ${data.commitSha}: ` +
  `${data.theorems} theorems, ${data.lines} lines, ${data.modules} modules, ${data.admitted} admitted`
);
