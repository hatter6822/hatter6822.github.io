/**
 * The contract with seLe4n's canonical codebase map.
 *
 * `docs/codebase_map.json` is the single source of truth for every statistic
 * this website publishes. The kernel's own `scripts/generate_codebase_map.py`
 * emits it, and the kernel's README "Current state" table is rendered from the
 * same `readme_sync` block, so reading the artifact is what keeps the site and
 * the kernel from contradicting each other.
 *
 * Schema targeted (`schema_version` 1.0.0):
 *
 *   schema_version                        "1.0.0"
 *   repository.head.commit_sha            the commit the generator ran at
 *   source_sync.source_digest             sha256 over the Lean sources in scope
 *   summary.module_count                      381   production + test modules
 *   summary.declaration_count              19,039
 *   readme_sync.version                  "0.34.56"
 *   readme_sync.lean_toolchain            "v4.28.0"
 *   readme_sync.production_files              311
 *   readme_sync.production_loc            330,569
 *   readme_sync.proved_theorem_lemma_decls 11,000   (see the note below)
 *   modules[]           { module, path, declaration_count, declarations[] }
 *   modules[].declarations[]      { kind, name, line, called[] }
 *
 * Scope: the site reports *production* Lean — every module outside `tests/`.
 *
 * Substitution rule: a metric may fall back to another key of the same
 * artifact, never to a source outside it. An earlier revision of this
 * projection guessed at key names the artifact has never carried
 * (`lean_version`, `build_jobs`, `stats.*`, `files[]`); the misses fell through
 * to heuristics — a README table parse, a `GET /languages` byte estimate, a
 * `modules × 2` build-job invention — and the page published figures no
 * upstream source asserts. `canonicalMetricsIssues()` now fails the sync when a
 * required key goes missing, so a schema change surfaces as a red build.
 *
 * ── Why the theorem count does not come from `readme_sync` ──────────────────
 *
 * The artifact states its declaration inventory twice, by two different
 * methods, and they disagree by 63:
 *
 *   modules[].declarations (kind theorem/lemma, production)   10,937
 *   readme_sync.proved_theorem_lemma_decls                    11,000
 *
 * The inventory is built by `_parse_declaration_headers`, which tracks nested
 * `/- -/` depth and strips string literals. `proved_theorem_lemma_decls` is a
 * bare per-line regex over raw lines with no comment handling and only
 * `private` among the declaration modifiers. Reconciled against the sources at
 * the artifact's own commit, the difference is exactly:
 *
 *   +78  prose lines inside doc comments, where a sentence wraps onto a line
 *        beginning "theorem is retained for backward compatibility…" or
 *        "lemma tracked for AN12-B. -/"
 *   -15  real declarations the regex misses (`protected`/`noncomputable`
 *        theorems, multi-line attributes)
 *
 *   10,937 + 78 - 15 = 11,000
 *
 * So the site publishes the comment-aware inventory. It is the accurate figure,
 * it comes from the same canonical artifact, and it is the only one the code
 * map can also produce — which is what lets both pages quote one number.
 */
import { INTERIOR_KIND_GROUPS } from './lean-analysis.mjs';

const ALL_INTERIOR_KINDS = Object.freeze([
  ...INTERIOR_KIND_GROUPS.object,
  ...INTERIOR_KIND_GROUPS.extension,
  ...INTERIOR_KIND_GROUPS.contextInit
]);

/** Required canonical keys, as dotted paths, with what each one feeds. */
const CANONICAL_KEYS = Object.freeze([
  ['schema_version', 'snapshot provenance'],
  ['repository.head.commit_sha', 'the revision to pin to when the artifact lags its branch'],
  ['source_sync.source_digest', 'the digest that proves artifact and sources are one corpus'],
  ['readme_sync.version', 'version'],
  ['readme_sync.lean_toolchain', 'leanVersion'],
  ['readme_sync.production_loc', 'lines'],
  ['readme_sync.production_files', 'the modules cross-check'],
  ['summary.module_count', 'the module inventory cross-check']
]);

function readPath(root, dottedPath) {
  let node = root;
  for (const segment of dottedPath.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return node;
}

function positiveInteger(value) {
  const number = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

/**
 * Order two repository paths the way Python's `PurePath` orders them —
 * component by component, not as flat strings.
 *
 * This is load-bearing for the digest. A flat compare puts
 * "SeLe4n/Kernel.lean" before "SeLe4n/Kernel/API.lean" ('.' is 0x2E, '/' is
 * 0x2F); `PurePath` compares the parts tuple, so "Kernel" < "Kernel.lean" and
 * the directory comes first. Get this wrong and every digest mismatches while
 * looking plausible.
 */
export function compareCanonicalPaths(a, b) {
  const left = String(a).split('/');
  const right = String(b).split('/');
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * Select and order the Lean sources the artifact's digest covers, mirroring the
 * generator's `lean_files()`: sorted `SeLe4n/**\/*.lean`, then `Main.lean`,
 * then sorted `tests/**\/*.lean`.
 */
export function canonicalSourcePaths(paths) {
  const lean = (prefix) => paths
    .filter((path) => path.startsWith(prefix) && path.endsWith('.lean'))
    .sort(compareCanonicalPaths);

  return [
    ...lean('SeLe4n/'),
    ...(paths.includes('Main.lean') ? ['Main.lean'] : []),
    ...lean('tests/')
  ];
}

/**
 * Reproduce `source_fingerprint()`: sha256 over `path\0bytes\0` for each source
 * in scope, in order. `readBytes` takes a repository-relative path and returns
 * a Buffer.
 */
export function canonicalSourceDigest(hash, paths, readBytes) {
  const NUL = Buffer.from([0]);
  for (const path of paths) {
    hash.update(Buffer.from(path, 'utf8'));
    hash.update(NUL);
    hash.update(readBytes(path));
    hash.update(NUL);
  }
  return hash.digest('hex');
}

/** True when the module belongs to the production corpus (everything outside tests/). */
export function isProductionModule(moduleInfo) {
  return !String(moduleInfo?.path ?? '').startsWith('tests/');
}

/** The artifact's production modules, in artifact order. */
export function productionModules(codebaseMap) {
  const modules = codebaseMap?.modules;
  return Array.isArray(modules) ? modules.filter(isProductionModule) : [];
}

/**
 * Report every canonical key the site needs but the artifact lacks.
 *
 * Callers must treat a non-empty result as fatal: publishing a partially
 * projected snapshot is how the page drifted from the artifact in the first
 * place.
 */
export function canonicalMetricsIssues(codebaseMap) {
  if (!codebaseMap || typeof codebaseMap !== 'object') {
    return ['docs/codebase_map.json: expected a JSON object'];
  }

  const issues = [];
  for (const [path, purpose] of CANONICAL_KEYS) {
    const value = readPath(codebaseMap, path);
    if (value === undefined || value === null || value === '') {
      issues.push(`docs/codebase_map.json: missing ${path} (feeds ${purpose})`);
    }
  }

  const modules = productionModules(codebaseMap);
  if (!modules.length) {
    issues.push('docs/codebase_map.json: no production modules in modules[]');
  } else if (!modules.some((moduleInfo) => Array.isArray(moduleInfo.declarations))) {
    issues.push('docs/codebase_map.json: modules[] carries no declaration inventory');
  }

  return issues;
}

/** Count theorem and lemma declarations in one module's inventory. */
export function theoremDeclarationCount(declarations) {
  if (!Array.isArray(declarations)) return 0;
  let total = 0;
  for (const declaration of declarations) {
    const kind = String(declaration?.kind ?? '').toLowerCase();
    if (kind === 'theorem' || kind === 'lemma') total += 1;
  }
  return total;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recover a declaration's full identifier from its own source line.
 *
 * The artifact is authoritative about *which* lines are declarations — its
 * parser tracks nested block-comment depth and strips string literals, so it
 * never mistakes prose for code. Its *names*, though, are cut short:
 * `_extract_names` splits the head at the first `:` and tokenises with a
 * character class that excludes `?`, so `ofErrorLabel?_zero` and
 * `ofErrorLabel?_none_of_lt_base` are both recorded as `ofErrorLabel`. That
 * affects 229 of 10,937 production theorems (2.1%), and it collapses distinct
 * declarations onto one name, which breaks the map's interior explorer, its
 * search index, and its line anchors.
 *
 * Reading the identifier back from the source line fixes it, because the digest
 * has already proved these sources are the corpus the artifact describes.
 *
 * The recovered name is adopted only when it *extends* the recorded one. That
 * guard keeps this from ever rewriting a name it merely failed to re-parse, and
 * it leaves multi-name declarations (`variable x y z`, one entry per name)
 * alone: the line yields `x`, which extends neither `y` nor `z`.
 */
export function resolveDeclarationName(declaration, sourceLine) {
  const recorded = String(declaration?.name ?? '').trim();
  const kind = String(declaration?.kind ?? '').toLowerCase();
  if (!recorded || !kind || typeof sourceLine !== 'string') return recorded;

  const match = new RegExp(`(?:^|[\\s\\]])${escapeRegExp(kind)}\\b[ \\t]*([^\\s:(\\[{=]+)`).exec(sourceLine);
  const found = match && match[1] ? match[1].trim() : '';
  return found.length > recorded.length && found.startsWith(recorded) ? found : recorded;
}

/**
 * Project a module's declarations into the shape the code map renders: one
 * array per interior kind, the theorem and function shortcuts, and the
 * declaration call graph.
 *
 * `sourceText` is the module's own Lean source, used only to recover truncated
 * identifiers; the declaration set itself always comes from the artifact.
 * Entries are keyed by name *and* line, so two genuinely distinct declarations
 * are both listed — deduplicating by name alone hid 145 production theorems.
 *
 * `callGraph` maps a declaration to the identifiers it references, which is
 * what drives the map's declaration-context flowchart (outgoing calls, and
 * incoming callers via the reverse index the runtime builds from it). It is
 * keyed by the same recovered names as the symbol lists, so a lookup from one
 * always lands in the other.
 *
 * The graph is stored inline rather than in an interned table. Measured on the
 * real corpus — 119,973 edges over 10,112 distinct targets — interning halves
 * the raw file (2.60 MB → 1.09 MB of added JSON) but saves only 23 KB gzipped,
 * because gzip already captures the repetition. That is not worth a bespoke
 * format and a decoder in the runtime, especially since `symbols.callGraph` is
 * a shape `assets/js/map.js` already reads in three places.
 */
export function symbolsFromDeclarations(declarations, sourceText) {
  const lines = typeof sourceText === 'string' ? sourceText.split(/\r?\n/) : [];
  const byKind = Object.create(null);
  const seen = Object.create(null);
  const callGraph = Object.create(null);
  for (const kind of ALL_INTERIOR_KINDS) {
    byKind[kind] = [];
    seen[kind] = Object.create(null);
  }

  for (const declaration of Array.isArray(declarations) ? declarations : []) {
    const kind = String(declaration?.kind ?? '').toLowerCase();
    if (!kind) continue;
    if (!byKind[kind]) {
      // A kind the interior UI does not group. Keep it rather than drop it: the
      // artifact is the inventory, and an unrecognised kind is upstream news.
      byKind[kind] = [];
      seen[kind] = Object.create(null);
    }

    const line = Number(declaration?.line);
    const hasLine = Number.isInteger(line) && line > 0;
    const name = resolveDeclarationName(declaration, hasLine ? lines[line - 1] : undefined)
      || `<${kind}@L${hasLine ? line : 0}>`;

    const key = `${name} ${hasLine ? line : ''}`;
    if (seen[kind][key]) continue;
    seen[kind][key] = true;

    byKind[kind].push(hasLine ? { name, line } : { name });

    // Recorded after the de-duplication check, so every call-graph key is a
    // name the symbol lists above also carry — an invariant validate-data.mjs
    // asserts, because a drift between the two would break every lookup.
    //
    // Later declarations win a name collision. The artifact records short
    // names, so `refl` in three namespaces of one file is three entries under
    // one key (177 such collisions across the corpus). The runtime keys its
    // merged graph by bare name globally and collapses them the same way, and
    // its own live path assigns last-wins too — so this matches what the map
    // does either way. Qualifying the names is not an option: the `called`
    // targets are recorded unqualified as well, and every lookup would miss.
    const called = Array.isArray(declaration?.called)
      ? declaration.called.map((target) => String(target ?? '').trim()).filter(Boolean)
      : [];
    if (called.length) callGraph[name] = called;
  }

  return {
    byKind,
    theorems: [...byKind.theorem, ...byKind.lemma],
    functions: [...byKind.def, ...byKind.abbrev, ...byKind.opaque, ...byKind.instance],
    callGraph
  };
}

/**
 * Count admitted proofs recorded by the artifact.
 *
 * Two declaration shapes qualify: an `axiom` (a proposition asserted rather
 * than proved) and any declaration whose extracted call list reaches `sorry` or
 * `sorryAx`. Both are recorded per declaration, which turns the hero's
 * "Admitted Proofs" tile from a hand-written `0` into a figure the artifact
 * supports.
 *
 * Returns `undefined` when there is no declaration inventory to inspect — an
 * absent inventory is not evidence of zero, and the caller must not publish one
 * as if it were.
 */
export function admittedCountFromCodebaseMap(codebaseMap) {
  const modules = productionModules(codebaseMap);
  if (!modules.length) return undefined;

  let admitted = 0;
  let inspected = false;

  for (const moduleInfo of modules) {
    const declarations = moduleInfo?.declarations;
    if (!Array.isArray(declarations)) continue;
    inspected = true;

    for (const declaration of declarations) {
      if (String(declaration?.kind ?? '').toLowerCase() === 'axiom') {
        admitted += 1;
        continue;
      }
      const called = declaration?.called;
      if (!Array.isArray(called)) continue;
      if (called.some((name) => /^sorry(?:Ax)?$/.test(String(name ?? '')))) admitted += 1;
    }
  }

  return inspected ? admitted : undefined;
}

/**
 * Project the landing page's statistics from the canonical map.
 *
 * Returns only what the artifact supports; a caller needing a complete set must
 * check `canonicalMetricsIssues()` first rather than filling gaps from
 * elsewhere.
 */
export function siteMetricsFromCodebaseMap(codebaseMap) {
  const map = codebaseMap && typeof codebaseMap === 'object' ? codebaseMap : null;
  if (!map) return {};

  const sync = map.readme_sync && typeof map.readme_sync === 'object' ? map.readme_sync : {};
  const metrics = {};

  if (typeof sync.version === 'string' && sync.version.trim()) metrics.version = sync.version.trim();

  // `lean_toolchain` carries the toolchain tag ("v4.28.0"); the page renders a
  // bare version after the word "Lean".
  if (typeof sync.lean_toolchain === 'string' && sync.lean_toolchain.trim()) {
    metrics.leanVersion = sync.lean_toolchain.trim().replace(/^v/i, '');
  }

  // Physical lines of production Lean. A mechanical count with no parsing in
  // it, unlike proved_theorem_lemma_decls — see the note at the top of this file.
  const lines = positiveInteger(sync.production_loc);
  if (lines !== undefined) metrics.lines = lines;

  const modules = productionModules(map);
  if (modules.length) {
    metrics.modules = modules.length;
    metrics.theorems = modules.reduce((total, moduleInfo) => total + theoremDeclarationCount(moduleInfo.declarations), 0);
  }

  const admitted = admittedCountFromCodebaseMap(map);
  if (admitted !== undefined) metrics.admitted = admitted;

  return metrics;
}

/**
 * Cross-check the artifact's own summary fields against what we derived from
 * its inventory. Divergence is not fatal — the inventory is what the site
 * publishes — but it is worth surfacing, since it is how the
 * `proved_theorem_lemma_decls` miscount was found.
 */
export function canonicalCrossChecks(codebaseMap) {
  const sync = codebaseMap?.readme_sync ?? {};
  const derived = siteMetricsFromCodebaseMap(codebaseMap);
  const notes = [];

  const statedModules = positiveInteger(sync.production_files);
  if (statedModules !== undefined && derived.modules !== undefined && statedModules !== derived.modules) {
    notes.push(`readme_sync.production_files says ${statedModules}; the module inventory has ${derived.modules}`);
  }

  const statedTheorems = positiveInteger(sync.proved_theorem_lemma_decls);
  if (statedTheorems !== undefined && derived.theorems !== undefined && statedTheorems !== derived.theorems) {
    notes.push(
      `readme_sync.proved_theorem_lemma_decls says ${statedTheorems}; the comment-aware ` +
      `declaration inventory has ${derived.theorems} (difference ${statedTheorems - derived.theorems}) — ` +
      'publishing the inventory'
    );
  }

  const statedTotal = positiveInteger(codebaseMap?.summary?.module_count);
  const actualTotal = Array.isArray(codebaseMap?.modules) ? codebaseMap.modules.length : undefined;
  if (statedTotal !== undefined && actualTotal !== undefined && statedTotal !== actualTotal) {
    notes.push(`summary.module_count says ${statedTotal}; modules[] has ${actualTotal}`);
  }

  return notes;
}
