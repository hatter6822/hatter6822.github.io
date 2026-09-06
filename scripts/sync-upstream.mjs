#!/usr/bin/env node
/**
 * The website's data pipeline. One acquisition, one revision, three snapshots.
 *
 *   git clone --depth 1 seLe4n@main
 *     └─ docs/codebase_map.json  ─┬─→ data/site-data.json      (landing page)
 *        Lean sources            ─┤   data/map-data.json       (code map)
 *        docs/execution-traces.json ─→ data/execution-traces.json (simulator)
 *
 * There used to be three scripts, each fetching upstream independently. They
 * drifted: site-data was generated at one commit and map-data at another, and
 * the two re-derived the same quantities by different methods, so the landing
 * page and the code map quoted different module and theorem counts for the same
 * kernel. Everything now comes from one checkout at one revision, and the
 * snapshots record the same `commitSha` and `sourceDigest` so
 * `validate-data.mjs` can prove it.
 *
 * The canonical artifact is the source of truth for every published statistic.
 * The Lean sources supply exactly one thing it does not record — import edges —
 * and `source_sync.source_digest` proves the sources we parse are the corpus
 * the artifact describes, rather than a later revision that merely sits in the
 * same tree.
 *
 * Network shape: one shallow clone, plus one commit fetch on the rare path
 * where upstream has committed Lean changes without regenerating the artifact.
 * No REST calls, so no anonymous rate limit and no token.
 */
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalCrossChecks,
  canonicalMetricsIssues,
  canonicalSourceDigest,
  canonicalSourcePaths,
  productionModules,
  siteMetricsFromCodebaseMap,
  symbolsFromDeclarations,
  theoremDeclarationCount
} from './lib/canonical-map.mjs';
import { extractImportTokens } from './lib/lean-analysis.mjs';
import { validateTraceDataObject, scenarioStates } from './lib/trace-analysis.mjs';

const REPO = 'hatter6822/seLe4n';
const REF = 'main';
const CLONE_URL = `https://github.com/${REPO}.git`;
const METRICS_PATH = 'docs/codebase_map.json';
const TRACES_PATH = 'docs/execution-traces.json';

const ROOT = new URL('../', import.meta.url);
const SITE_FILE = new URL('data/site-data.json', ROOT);
const MAP_FILE = new URL('data/map-data.json', ROOT);
const TRACE_FILE = new URL('data/execution-traces.json', ROOT);

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function moduleFromPath(path) {
  return path.replace(/\.lean$/, '').replace(/\//g, '.');
}

function classifyLayer(moduleName) {
  if (/\.Model\./.test(moduleName)) return 'model';
  if (/\.Kernel\./.test(moduleName)) return 'kernel';
  if (/\.Security\./.test(moduleName) || /\.IFC\./.test(moduleName)) return 'security';
  if (/\.Platform\./.test(moduleName) || /\.Hardware\./.test(moduleName)) return 'platform';
  return 'other';
}

function moduleKind(moduleName) {
  if (/\.Operations$/.test(moduleName)) return 'operations';
  if (/\.Invariant$/.test(moduleName)) return 'invariant';
  return 'other';
}

function moduleBase(moduleName) {
  return moduleName.replace(/\.(Operations|Invariant)$/, '');
}

// ── Acquire one verified checkout ──────────────────────────────────────────

function checkoutHead(work) {
  return {
    commitSha: git(work, ['rev-parse', 'HEAD']).trim(),
    committedAt: new Date(git(work, ['show', '-s', '--format=%cI', 'HEAD']).trim()).toISOString(),
    files: git(work, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean)
  };
}

function digestOf(work, files) {
  return canonicalSourceDigest(createHash('sha256'), canonicalSourcePaths(files), (path) =>
    readFileSync(join(work, path)));
}

/**
 * Clone `main`, then make the checkout agree with the artifact it carries.
 *
 * The artifact is generated at one commit and committed at another, so the tree
 * it ships in can contain Lean sources it never saw. `source_digest` detects
 * exactly that, and upstream's generation commit is fetchable by SHA, so the
 * recovery is to pin the checkout to the revision the artifact describes.
 */
async function acquire() {
  const work = await mkdtemp(join(tmpdir(), 'sele4n-sync-'));
  execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', REF, CLONE_URL, work],
    { stdio: ['ignore', 'ignore', 'pipe'] });

  const mapPath = join(work, METRICS_PATH);
  if (!existsSync(mapPath)) throw new Error(`${REPO}@${REF} has no ${METRICS_PATH}`);
  const codebaseMap = JSON.parse(readFileSync(mapPath, 'utf8'));

  const issues = canonicalMetricsIssues(codebaseMap);
  if (issues.length) throw new Error(`canonical metrics unavailable:\n  ${issues.join('\n  ')}`);

  const expected = codebaseMap.source_sync.source_digest;
  let head = checkoutHead(work);
  let pinned = false;

  if (digestOf(work, head.files) !== expected) {
    const generatedAt = codebaseMap.repository.head.commit_sha;
    console.warn(
      `⚠️  ${REF} carries Lean sources the artifact has not been regenerated for; ` +
      `pinning to ${generatedAt.slice(0, 7)}, the commit it describes.`
    );
    execFileSync('git', ['-C', work, 'fetch', '--quiet', '--depth', '1', 'origin', generatedAt],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    git(work, ['checkout', '--quiet', 'FETCH_HEAD']);
    head = checkoutHead(work);

    if (digestOf(work, head.files) !== expected) {
      throw new Error(
        `${METRICS_PATH} describes no obtainable revision: its source_digest matches neither ` +
        `${REF} nor ${generatedAt.slice(0, 7)}, the commit it names. Upstream must regenerate it.`
      );
    }
  } else {
    pinned = true;
  }

  return { work, codebaseMap, head, sourceDigest: expected, currentWithRef: pinned };
}

// ── Snapshot builders ──────────────────────────────────────────────────────

function buildSiteData(codebaseMap, head, sourceDigest) {
  const metrics = siteMetricsFromCodebaseMap(codebaseMap);
  return {
    version: metrics.version,
    leanVersion: metrics.leanVersion,
    modules: metrics.modules,
    lines: formatNumber(metrics.lines),
    theorems: metrics.theorems,
    scripts: head.files.filter((path) => /^scripts\/.*\.sh$/.test(path)).length,
    docs: head.files.filter((path) => /^docs\/.*\.(md|txt)$/.test(path)).length,
    admitted: metrics.admitted,
    commitSha: head.commitSha.slice(0, 7),
    updatedAt: head.committedAt,
    sourceRepo: REPO,
    sourceRef: REF,
    metricsSource: METRICS_PATH,
    // Production Lean only — see the scope note in lib/canonical-map.mjs.
    metricsScope: 'production',
    schemaVersion: codebaseMap.schema_version,
    sourceDigest,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Build the code map over the same production corpus the landing page counts,
 * so both pages describe one module universe.
 *
 * Declarations come from the artifact; only the import graph is parsed here,
 * because only the import graph is missing from it.
 */
function buildMapData(codebaseMap, head, sourceDigest, work) {
  const modules = productionModules(codebaseMap);

  const moduleMap = Object.create(null);
  const moduleMeta = Object.create(null);
  const importsFrom = Object.create(null);
  const importsTo = Object.create(null);
  const externalImportsFrom = Object.create(null);

  for (const moduleInfo of modules) moduleMap[moduleInfo.module] = moduleInfo.path;

  for (const moduleInfo of modules) {
    const name = moduleInfo.module;
    const internal = [];
    const external = [];
    const seenInternal = Object.create(null);
    const seenExternal = Object.create(null);

    let source = '';
    try {
      source = readFileSync(join(work, moduleInfo.path), 'utf8');
    } catch {
      // The digest guarantees the file is present; treat a read failure as an
      // import-less module rather than losing the node from the graph.
    }

    for (const token of extractImportTokens(source)) {
      if (moduleMap[token]) {
        if (seenInternal[token]) continue;
        seenInternal[token] = true;
        internal.push(token);
      } else {
        if (seenExternal[token]) continue;
        seenExternal[token] = true;
        external.push(token);
      }
    }

    importsFrom[name] = internal;
    externalImportsFrom[name] = external;
    for (const dep of internal) {
      if (!importsTo[dep]) importsTo[dep] = [];
      importsTo[dep].push(name);
    }

    moduleMeta[name] = {
      layer: classifyLayer(name),
      kind: moduleKind(name),
      base: moduleBase(name),
      theorems: theoremDeclarationCount(moduleInfo.declarations),
      symbols: symbolsFromDeclarations(moduleInfo.declarations, source)
    };
  }

  return {
    files: head.files,
    modules: modules.map((moduleInfo) => moduleInfo.module),
    moduleMap,
    moduleMeta,
    importsTo,
    importsFrom,
    externalImportsFrom,
    commitSha: head.commitSha,
    metricsSource: METRICS_PATH,
    sourceDigest,
    generatedAt: new Date().toISOString()
  };
}

/** Adopt the upstream trace export once it exists; keep the fixture until then. */
async function writeTraces(work) {
  const path = join(work, TRACES_PATH);
  if (!existsSync(path)) {
    console.warn(`⚠️  ${REPO} has no ${TRACES_PATH} yet — keeping the bundled reference fixture.`);
    return;
  }

  const upstream = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateTraceDataObject(upstream);
  if (errors.length) {
    throw new Error(`upstream ${TRACES_PATH} failed validation; refusing to overwrite the bundled snapshot:\n  ${errors.join('\n  ')}`);
  }

  let steps = 0;
  for (const scenario of upstream.scenarios) steps += scenarioStates(scenario).length; // fold dry-run must not throw
  await writeFile(TRACE_FILE, JSON.stringify(upstream, null, 2) + '\n', 'utf8');
  console.log(`   traces      ${upstream.scenarios.length} scenario(s), ${steps} step(s), source=${upstream.source}`);
}

// ── Run ────────────────────────────────────────────────────────────────────

const { work, codebaseMap, head, sourceDigest, currentWithRef } = await acquire();

try {
  for (const note of canonicalCrossChecks(codebaseMap)) console.warn(`⚠️  ${note}`);

  const siteData = buildSiteData(codebaseMap, head, sourceDigest);
  const mapData = buildMapData(codebaseMap, head, sourceDigest, work);

  await writeFile(SITE_FILE, JSON.stringify(siteData, null, 2) + '\n');
  // Written compact: this snapshot is the dominant payload on map.html, and
  // indenting it costs roughly 100 KB of gzipped transfer for a generated file
  // no one reads as text. site-data.json and execution-traces.json stay
  // indented; they are small and people do read them.
  await writeFile(MAP_FILE, JSON.stringify(mapData) + '\n');
  await writeTraces(work);

  const edges = Object.values(mapData.importsFrom).reduce((total, deps) => total + deps.length, 0);
  console.log(`Synced ${REPO}@${head.commitSha.slice(0, 7)}${currentWithRef ? ` (${REF})` : ' (pinned to the artifact\'s commit)'}`);
  console.log(`   site-data   v${siteData.version} · ${formatNumber(siteData.theorems)} theorems · ${siteData.lines} lines · ${siteData.modules} modules · ${siteData.admitted} admitted`);
  console.log(`   map-data    ${mapData.modules.length} modules · ${edges} import edges · ${mapData.files.length} files`);
} finally {
  await rm(work, { recursive: true, force: true });
}
