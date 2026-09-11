#!/usr/bin/env node
/**
 * The website's data pipeline. One acquisition, one revision, three snapshots.
 *
 *   git clone --depth 1 seLe4n@main
 *     └─ docs/codebase_map.json  ─┬─→ data/site-data.json      (landing page)
 *        Lean sources            ─┤   data/map-data.json       (code map)
 *        rust/ workspace         ─┘     └─ #rust: crate inventory
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
 * The Rust workspace is outside the artifact's scope entirely (its digest covers
 * Lean sources only), so the code map's crate inventory is read from the same
 * pinned checkout by `lib/rust-analysis.mjs` and bundled as `map-data.json#rust`.
 * It is descriptive — files, items, visibility, `unsafe` usage, manifests — and
 * feeds no landing-page statistic.
 *
 * Reproducible regeneration: `SELE4N_REF=<40-hex commit>` pins the checkout to
 * that revision instead of the tip of `main`, so a data change can be
 * regenerated and reviewed against one known upstream commit. The snapshot
 * still records `sourceRef: main`; `commitSha` names the exact revision. A
 * pinned run regenerates at the requested revision or not at all: when that
 * revision's Lean sources are not the ones its bundled artifact describes, the
 * run fails and names the artifact's generation commit, instead of quietly
 * checking that commit out the way the unpinned sync recovers.
 *
 * Network shape: one shallow clone, plus one commit fetch on the rare path
 * where upstream has committed Lean changes without regenerating the artifact.
 * No REST calls, so no anonymous rate limit and no token.
 */
import { writeFile, readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalCrossChecks,
  canonicalMetricsIssues,
  productionLocReproduction,
  canonicalSourceDigest,
  canonicalSourcePaths,
  externBridgeSize,
  syscallSurfaceSize,
  nonInterferenceCoverage,
  productionModules,
  siteMetricsFromCodebaseMap,
  subsystemMetricsFromCodebaseMap,
  symbolsFromDeclarations,
  theoremDeclarationCount
} from './lib/canonical-map.mjs';
import { collectSourceAnchors, resolveSourceAnchors } from './lib/source-anchors.mjs';
import { extractImportTokens, inductiveConstructors } from './lib/lean-analysis.mjs';
import { buildRustInventory } from './lib/rust-analysis.mjs';
import { validateTraceDataObject, scenarioStates } from './lib/trace-analysis.mjs';

const REPO = 'hatter6822/seLe4n';
const SOURCE_REF = 'main';
const REF = process.env.SELE4N_REF || SOURCE_REF;
const PINNED_COMMIT = /^[0-9a-f]{40}$/i.test(REF) ? REF.toLowerCase() : '';
const CLONE_URL = `https://github.com/${REPO}.git`;
const METRICS_PATH = 'docs/codebase_map.json';
const MANIFEST_PATH = 'lakefile.toml';
const TRACES_PATH = 'docs/execution-traces.json';
/* The user-space crate whose wrappers the landing page says cover the whole syscall surface. */
const WRAPPER_CRATE = 'sele4n-sys';

const ROOT = new URL('../', import.meta.url);
const SITE_FILE = new URL('data/site-data.json', ROOT);
const MAP_FILE = new URL('data/map-data.json', ROOT);
const TRACE_FILE = new URL('data/execution-traces.json', ROOT);
const LOCALES_DIR = new URL('locales/', ROOT);

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function moduleFromPath(path) {
  return path.replace(/\.lean$/, '').replace(/\//g, '.');
}

/**
 * Physical lines the way `wc -l` counts them, plus one for an unterminated
 * last line. Reproduces the artifact's `production_loc` exactly over its own
 * files (canonicalCrossChecks says so if it ever stops), which is what makes
 * subtracting the framework files from that figure sound.
 */
function physicalLineCount(buffer) {
  if (!buffer.length) return 0;
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  return buffer[buffer.length - 1] === 0x0a ? count : count + 1;
}

/**
 * The project's declared version, read from the Lean build manifest.
 *
 * This is the one published figure that does not come from the canonical
 * artifact, and it is deliberate: `lakefile.toml` is where the version is
 * *declared*, and `readme_sync.version`, the README badge and the Rust
 * workspace are all copies of it — rust/Cargo.toml says so in a comment. The
 * artifact carries no version outside its README-mirroring block, so taking it
 * from there made the site quote a mirror of a mirror. `canonicalCrossChecks`
 * reports any disagreement between the two, so a stale artifact is visible
 * rather than silent.
 */
function readProjectVersion(work) {
  const manifestPath = join(work, MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    throw new Error(`${REPO}@${REF} has no ${MANIFEST_PATH}; the published version is declared there`);
  }
  const manifest = readFileSync(manifestPath, 'utf8');
  // The package version, not a dependency's: take the first `version = "…"`
  // that appears before any `[[require]]`/`[lean_lib …]` sub-table.
  const head = manifest.split(/^\s*\[\[?(?:require|lean_lib|lean_exe)/m)[0];
  const match = /^[^\S\n]*version[^\S\n]*=[^\S\n]*"([^"]+)"/m.exec(head);
  if (!match) throw new Error(`${MANIFEST_PATH} declares no package version`);
  return match[1].trim();
}

function sourceReader(work) {
  return (path) => readFileSync(join(work, path), 'utf8');
}

/**
 * Resolve the line anchors on the page's deep links against this checkout.
 *
 * Reads the committed surfaces to learn which links exist — adding one to the
 * page is enough, nothing here needs editing — and reports anything it cannot
 * place instead of guessing. An unresolvable label means the declaration
 * changed name or left its file, which is an editorial call: see the note at
 * the top of lib/source-anchors.mjs.
 */
async function buildSourceAnchors(work) {
  const surfaces = [
    new URL('index.html', ROOT),
    ...(await readdir(LOCALES_DIR)).filter((name) => name.endsWith('.json')).sort()
      .map((name) => new URL(name, LOCALES_DIR))
  ];

  const anchors = [];
  for (const file of surfaces) anchors.push(...collectSourceAnchors(await readFile(file, 'utf8')));

  const { resolved, unresolved } = resolveSourceAnchors(anchors, (path) => {
    try { return readFileSync(join(work, path), 'utf8'); } catch { return undefined; }
  });

  for (const entry of unresolved) {
    console.warn(`   anchor      ${entry.path}#L${entry.line} (${entry.label}): ${entry.reason} — left as written`);
  }

  return resolved;
}

/**
 * The page says the Rust wrappers cover *all* the syscalls. Check it.
 *
 * `syscalls` counts constructors of Lean's `SyscallId` and knows nothing about
 * `sele4n-sys`, so on its own it would let a new Lean syscall land before its
 * wrapper and have the next sync silently upgrade the page's claim to complete
 * coverage. The prose it replaced said "27 of 30", which is the proof that
 * these two surfaces can and do lag each other.
 *
 * So the coverage is verified rather than assumed, the way `niSteps` is: every
 * constructor must be named in the wrapper crate's production sources. This is
 * a gate on publishing a figure, not a figure of its own — the landing page
 * still states nothing the Rust inventory derives, which is the rule in
 * lib/canonical-map.mjs.
 */
function assertSyscallWrapperCoverage(codebaseMap, work, rust, published) {
  const owner = productionModules(codebaseMap).find((moduleInfo) =>
    (moduleInfo.declarations || []).some((d) => d?.name === 'SyscallId' && d?.kind === 'inductive'));
  if (!owner) throw new Error('syscall wrapper coverage: no production module declares `inductive SyscallId`');

  const constructors = inductiveConstructors(readFileSync(join(work, owner.path), 'utf8'), 'SyscallId') || [];
  if (constructors.length !== published) {
    throw new Error(
      `syscall wrapper coverage: the snapshot publishes ${published} syscalls but \`SyscallId\` has ` +
      `${constructors.length} constructors`
    );
  }

  const crate = (rust?.crates || []).find((entry) => entry.name === WRAPPER_CRATE);
  if (!crate) throw new Error(`syscall wrapper coverage: ${WRAPPER_CRATE} is not in the Rust inventory`);

  // The two sides spell a syscall differently — Lean `cspaceMint`, Rust
  // `SyscallId::CSpaceMint` — so the comparison folds case and separators, the
  // same normalization the code map's boundary matcher uses. Matching the Lean
  // spelling literally is what this check got wrong first, and the gate caught
  // it: it reported 19 of 35 missing against a crate that names all 35.
  const fold = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

  let text = '';
  for (const file of crate.files || []) {
    if (file.role === 'test') continue;
    try { text += `\n${readFileSync(join(work, file.path), 'utf8')}`; } catch { /* listed but unreadable */ }
  }

  const wrapped = new Set(
    [...text.matchAll(/\bSyscallId::([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => fold(match[1]))
  );

  const missing = constructors.filter((name) => !wrapped.has(fold(name)));
  if (missing.length) {
    throw new Error(
      `syscall wrapper coverage: ${missing.length} of ${constructors.length} syscalls have no wrapper in ` +
      `${WRAPPER_CRATE} (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}). The landing page ` +
      `claims the wrappers cover all of them — correct the prose or wait for the wrappers.`
    );
  }
}

function lineCounter(work) {
  return (path) => {
    try {
      return physicalLineCount(readFileSync(join(work, path)));
    } catch {
      return undefined;
    }
  };
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
  try {
    return await acquireInto(work);
  } catch (error) {
    // The caller's finally block only runs once acquire() has returned, so
    // without this a failed clone, a malformed artifact or a digest mismatch
    // would strand a ~64 MB checkout in the system temp directory.
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

async function acquireInto(work) {
  if (PINNED_COMMIT) {
    // A pinned revision: shallow-clone the default branch, then fetch the
    // commit by SHA (GitHub serves reachable commits) and check it out.
    execFileSync('git', ['clone', '--quiet', '--depth', '1', CLONE_URL, work],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('git', ['-C', work, 'fetch', '--quiet', '--depth', '1', 'origin', PINNED_COMMIT],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    git(work, ['checkout', '--quiet', 'FETCH_HEAD']);
  } else {
    execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', REF, CLONE_URL, work],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  }

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
    if (PINNED_COMMIT) {
      throw new Error(
        `SELE4N_REF=${PINNED_COMMIT.slice(0, 7)} carries Lean sources its bundled ${METRICS_PATH} does not describe ` +
        `(source_digest mismatch); that artifact was generated at ${generatedAt.slice(0, 7)}. A pinned sync regenerates ` +
        `at the requested revision or not at all — pin ${generatedAt.slice(0, 7)} instead, or run unpinned to recover to it.`
      );
    }
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

function buildSiteData(codebaseMap, head, sourceDigest, work, sourceAnchors) {
  const projectVersion = readProjectVersion(work);
  const metrics = siteMetricsFromCodebaseMap(codebaseMap, {
    lineCount: lineCounter(work),
    sourceText: sourceReader(work),
    projectVersion
  });
  if (metrics.lines === undefined) {
    // Either the framework files could not be counted, or the physical count
    // over the artifact's own production files no longer reproduces
    // production_loc — then the subtraction would mix two counting methods,
    // and no figure is better than a wrong one.
    const check = productionLocReproduction(codebaseMap, lineCounter(work));
    if (check.checked && !check.matches) {
      throw new Error(
        `lines could not be projected: readme_sync.production_loc says ${check.stated} but the sources count ` +
        `${check.counted} physical lines over the artifact's production files, so subtracting the framework files ` +
        `would mix two counting methods. Upstream must regenerate the artifact.`
      );
    }
    throw new Error('lines could not be projected: the framework files to subtract from readme_sync.production_loc were not readable');
  }
  // Both are counted off the verified sources and both are published as prose
  // the page states in three places. A missing one means the declaration moved
  // or the tree is unreadable; publishing the previous number instead is
  // exactly the drift this pass is undoing.
  if (metrics.syscalls === undefined) {
    throw new Error(
      'syscalls could not be counted: the artifact lists no production `inductive SyscallId`, or its source was ' +
      'unreadable. The syscall surface is published on the landing page and must not fall back to a stale figure.'
    );
  }
  if (metrics.externs === undefined) {
    throw new Error('externs could not be counted: a production Lean source was unreadable');
  }
  // The security card states these four as facts about the kernel, so a figure
  // that cannot be derived stops the sync rather than leaving the last one in
  // place. `niSteps` is the sharpest: it is published only while every
  // constructor of `NonInterferenceStep` actually has its own proof, because
  // that correspondence — not the total — is what the page claims.
  if (metrics.niSteps === undefined) {
    const coverage = nonInterferenceCoverage(codebaseMap, sourceReader(work));
    const missing = coverage?.missing ?? [];
    throw new Error(
      missing.length
        ? `non-interference coverage is incomplete: ${missing.length} of ${coverage.steps} NonInterferenceStep ` +
          `constructor(s) have no nonInterference_perCore_ theorem (${missing.slice(0, 5).join(', ')}` +
          `${missing.length > 5 ? ', …' : ''}). The security card claims one proof per step.`
        : 'non-interference coverage could not be derived: no production module declares `inductive NonInterferenceStep`'
    );
  }
  if (metrics.niCrossCore === undefined) {
    throw new Error('cross-core non-interference theorems could not be counted: NonInterferenceCrossCore is not in the production inventory');
  }
  for (const [key, theorem] of [['enforcementOps', 'enforcementBoundaryExtended_count'], ['enforcementOpsPerCore', 'enforcementBoundaryPerCore_count']]) {
    if (metrics[key] === undefined) {
      throw new Error(`${key} could not be read: no production module proves \`${theorem}\` with a \`.length = N\` statement`);
    }
  }
  return {
    version: metrics.version,
    leanVersion: metrics.leanVersion,
    modules: metrics.modules,
    lines: formatNumber(metrics.lines),
    theorems: metrics.theorems,
    syscalls: metrics.syscalls,
    externs: metrics.externs,
    niSteps: metrics.niSteps,
    niCrossCore: metrics.niCrossCore,
    enforcementOps: metrics.enforcementOps,
    enforcementOpsPerCore: metrics.enforcementOpsPerCore,
    scripts: head.files.filter((path) => /^scripts\/.*\.sh$/.test(path)).length,
    docs: head.files.filter((path) => /^docs\/.*\.(md|txt)$/.test(path)).length,
    admitted: metrics.admitted,
    // The architecture diagram's per-layer figures, over the same corpus and
    // the same declaration inventory as `modules` and `theorems` above. Typed
    // into the markup until 0.32.0, where ten of twelve had gone stale.
    subsystems: subsystemMetricsFromCodebaseMap(codebaseMap),
    // Where each deep link's declaration is written in this revision, so the
    // page's `#L` anchors are stamped rather than maintained by hand. The
    // revision goes with them: the unpinned sync falls back to the artifact's
    // generation commit when upstream has moved ahead of it, and a line
    // resolved there is not a line on `main`.
    sourceAnchors,
    sourceAnchorRef: head.commitSha,
    commitSha: head.commitSha.slice(0, 7),
    updatedAt: head.committedAt,
    sourceRepo: REPO,
    sourceRef: SOURCE_REF,
    metricsSource: METRICS_PATH,
    // Production Lean only: the artifact's production scope minus the in-tree
    // testing framework — see the scope note in lib/canonical-map.mjs.
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
    // The production Rust crates, from the same checkout: the map renders them
    // beside the Lean modules as the other half of the production code.
    rust: buildRustInventory(head.files, (path) => readFileSync(join(work, path), 'utf8')),
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
  for (const note of canonicalCrossChecks(codebaseMap, {
    lineCount: lineCounter(work),
    sourceText: sourceReader(work),
    projectVersion: readProjectVersion(work)
  })) console.warn(`⚠️  ${note}`);

  const sourceAnchors = await buildSourceAnchors(work);
  const siteData = buildSiteData(codebaseMap, head, sourceDigest, work, sourceAnchors);
  const mapData = buildMapData(codebaseMap, head, sourceDigest, work);
  assertSyscallWrapperCoverage(codebaseMap, work, mapData.rust, siteData.syscalls);

  await writeFile(SITE_FILE, JSON.stringify(siteData, null, 2) + '\n');
  // Written compact: this snapshot is the dominant payload on map.html, and
  // indenting it costs roughly 100 KB of gzipped transfer for a generated file
  // no one reads as text. site-data.json and execution-traces.json stay
  // indented; they are small and people do read them.
  await writeFile(MAP_FILE, JSON.stringify(mapData) + '\n');
  await writeTraces(work);

  const edges = Object.values(mapData.importsFrom).reduce((total, deps) => total + deps.length, 0);
  console.log(`Synced ${REPO}@${head.commitSha.slice(0, 7)}${PINNED_COMMIT ? ' (SELE4N_REF)' : currentWithRef ? ` (${REF})` : ' (pinned to the artifact\'s commit)'}`);
  console.log(`   site-data   v${siteData.version} · ${formatNumber(siteData.theorems)} theorems · ${siteData.lines} lines · ${siteData.modules} modules · ${siteData.admitted} admitted`);
  console.log(`   map-data    ${mapData.modules.length} modules · ${edges} import edges · ${mapData.files.length} files`);
  const rustFiles = mapData.rust.crates.reduce((total, crate) => total + crate.sourceFiles, 0);
  console.log(`   rust        ${mapData.rust.crates.length} crate(s) · ${rustFiles} source files · ${mapData.rust.crates.map((crate) => crate.name).join(', ')}`);
  const anchorCount = Object.values(sourceAnchors).reduce((total, labels) => total + Object.keys(labels).length, 0);
  console.log(`   anchors     ${anchorCount} deep link(s) resolved across ${Object.keys(sourceAnchors).length} source file(s)`);
} finally {
  await rm(work, { recursive: true, force: true });
}
