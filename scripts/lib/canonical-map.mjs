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
 * Scope: the site reports *production* Lean. The artifact's own production
 * definition is every module outside `tests/`; the site narrows it by one
 * directory, `SeLe4n/Testing/`, the in-tree testing framework (harness,
 * fixtures, invariant checks, state builders). Those eight modules are
 * framework code that ships in the library tree, and the map, the landing
 * page and every published figure leave them out together: `modules` and
 * `theorems` are counted over the narrowed inventory, and `lines` is the
 * artifact's `production_loc` minus the framework files' physical lines,
 * measured on the digest-verified sources (see siteMetricsFromCodebaseMap).
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
import {
  INTERIOR_KIND_GROUPS,
  countInductiveConstructors,
  countExternDeclarations,
  inductiveConstructors,
  stripLeanComments
} from './lean-analysis.mjs';

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

/**
 * The in-tree testing framework. Production by the artifact's definition
 * (it is not under `tests/`), test code by the site's: the site publishes
 * nothing about it and the map does not graph it.
 */
export const IN_TREE_TEST_FRAMEWORK_PREFIX = 'SeLe4n/Testing/';

/** True when the module is production by the artifact's own definition (everything outside tests/). */
export function isArtifactProductionModule(moduleInfo) {
  return !String(moduleInfo?.path ?? '').startsWith('tests/');
}

/**
 * True when the module belongs to the corpus the site publishes: the
 * artifact's production set minus the in-tree testing framework.
 */
export function isProductionModule(moduleInfo) {
  return isArtifactProductionModule(moduleInfo)
    && !String(moduleInfo?.path ?? '').startsWith(IN_TREE_TEST_FRAMEWORK_PREFIX);
}

/** The artifact's production modules (outside tests/), in artifact order. */
export function artifactProductionModules(codebaseMap) {
  const modules = codebaseMap?.modules;
  return Array.isArray(modules) ? modules.filter(isArtifactProductionModule) : [];
}

/** The modules the site publishes, in artifact order. */
export function productionModules(codebaseMap) {
  const modules = codebaseMap?.modules;
  return Array.isArray(modules) ? modules.filter(isProductionModule) : [];
}

/** Artifact-production modules the site scope leaves out: the in-tree testing framework. */
export function excludedFrameworkModules(codebaseMap) {
  return artifactProductionModules(codebaseMap).filter((moduleInfo) => !isProductionModule(moduleInfo));
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
  } else {
    // Every production module, not merely one: a module without a declarations
    // array contributes zero theorems and zero admitted proofs, and both
    // snapshots inherit the same undercount, so cross-file validation would
    // still pass. A truncated or partially generated artifact has to fail here
    // rather than publish a plausible total.
    const withoutInventory = modules.filter((moduleInfo) => !Array.isArray(moduleInfo.declarations));
    if (withoutInventory.length) {
      const named = withoutInventory.slice(0, 3).map((moduleInfo) => moduleInfo.module || moduleInfo.path).join(', ');
      const rest = withoutInventory.length > 3 ? ` (+${withoutInventory.length - 3} more)` : '';
      issues.push(`docs/codebase_map.json: ${withoutInventory.length} production module(s) carry no declaration inventory: ${named}${rest}`);
    }
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
 *
 * `options.lineCount(path)` returns the physical line count of a source file
 * at the artifact's revision. It is needed for `lines` only when the site scope
 * excludes artifact-production modules (the in-tree testing framework): the
 * artifact records `production_loc` for its own scope and nothing per module,
 * so the excluded files' lines are subtracted from that canonical figure. The
 * subtraction is measured on the digest-verified sources — the corpus the
 * artifact describes — and `canonicalCrossChecks` confirms the same count
 * reproduces `production_loc` exactly, so the anchor and the subtraction use
 * one method. Without `lineCount`, `lines` is omitted rather than published
 * over the wrong scope.
 */
/**
 * Does a physical line count over the artifact's own production files
 * reproduce `readme_sync.production_loc`? The site publishes `lines` as
 * `production_loc` minus the framework files' physical lines, which is sound
 * only while both figures come from the same method; when they stop agreeing
 * the metric is withheld rather than published over mixed methods.
 *
 * Returns `{ checked, matches, counted, stated }`: `checked` is false when
 * there is no line counter, no `production_loc`, or an unreadable file.
 */
export function productionLocReproduction(codebaseMap, lineCount) {
  const stated = positiveInteger(codebaseMap?.readme_sync?.production_loc);
  const counter = typeof lineCount === 'function' ? lineCount : null;
  if (!counter || stated === undefined) return { checked: false, matches: false, counted: undefined, stated };
  let counted = 0;
  for (const moduleInfo of artifactProductionModules(codebaseMap)) {
    const count = positiveInteger(counter(moduleInfo.path));
    if (count === undefined) return { checked: false, matches: false, counted: undefined, stated };
    counted += count;
  }
  return { checked: true, matches: counted === stated, counted, stated };
}

/**
 * The syscall surface, counted rather than retyped.
 *
 * The artifact locates the declaration — it lists `SyscallId` as an
 * `inductive` with its module and path — and the digest-verified source says
 * how many constructors it has. Neither half guesses: a rename upstream makes
 * this return `undefined` and the sync fails, instead of the page keeping a
 * number that three sentences and six locale files had to agree on by hand.
 * It said 30 for the eight releases after the surface reached 31.
 */
export function syscallSurfaceSize(codebaseMap, sourceText) {
  if (typeof sourceText !== 'function') return undefined;
  for (const moduleInfo of productionModules(codebaseMap)) {
    const declarations = Array.isArray(moduleInfo.declarations) ? moduleInfo.declarations : [];
    const declaresSyscallId = declarations.some(
      (declaration) => declaration?.name === 'SyscallId' && declaration?.kind === 'inductive'
    );
    if (!declaresSyscallId) continue;
    let source;
    try { source = sourceText(moduleInfo.path); } catch { return undefined; }
    const count = countInductiveConstructors(source, 'SyscallId');
    if (count !== undefined && count > 0) return count;
  }
  return undefined;
}

/**
 * The Lean side of the foreign-function bridge: `@[extern …]` declarations
 * across the production sources. The artifact records declarations but not
 * their attributes, so this is counted over the same verified sources `lines`
 * is measured on. Returns `undefined` when a source cannot be read, so an
 * unreadable tree fails the sync rather than publishing a short count.
 */
export function externBridgeSize(codebaseMap, sourceText) {
  if (typeof sourceText !== 'function') return undefined;
  const modules = productionModules(codebaseMap);
  if (!modules.length) return undefined;
  let total = 0;
  for (const moduleInfo of modules) {
    let source;
    try { source = sourceText(moduleInfo.path); } catch { return undefined; }
    if (typeof source !== 'string') return undefined;
    total += countExternDeclarations(source);
  }
  return total;
}

/** Declarations of a kind, over one module's inventory. */
function declarationNames(moduleInfo, kinds) {
  const declarations = Array.isArray(moduleInfo?.declarations) ? moduleInfo.declarations : [];
  return declarations
    .filter((declaration) => kinds.has(String(declaration?.kind ?? '').toLowerCase()))
    .map((declaration) => String(declaration?.name ?? ''));
}

const THEOREM_KINDS = new Set(['theorem', 'lemma']);

/**
 * Non-interference coverage: does every kernel step have its own proof?
 *
 * `NonInterferenceStep` names one step per constructor and the site states
 * that each has a per-core non-interference theorem. That is a correspondence,
 * not a total, so it is checked as one: every constructor must have a
 * `nonInterference_perCore_<step>` theorem. Twelve constructors are the `High`
 * variant of a step whose theorem carries the base name
 * (`endpointReceiveDualHigh` ← `nonInterference_perCore_endpointReceiveDual`),
 * which is the one spelling difference the correspondence allows.
 *
 * Returns `{ steps, covered, missing }`, or `undefined` when the inductive is
 * not in the tree. `missing` non-empty means the page's claim has stopped
 * being true — the sync says so rather than publishing the weaker total.
 */
export function nonInterferenceCoverage(codebaseMap, sourceText) {
  if (typeof sourceText !== 'function') return undefined;

  const modules = productionModules(codebaseMap);
  const owner = modules.find((moduleInfo) =>
    declarationNames(moduleInfo, new Set(['inductive'])).includes('NonInterferenceStep'));
  if (!owner) return undefined;

  let source;
  try { source = sourceText(owner.path); } catch { return undefined; }
  const steps = inductiveConstructors(source, 'NonInterferenceStep');
  if (!Array.isArray(steps) || !steps.length) return undefined;

  const proofs = new Set();
  for (const moduleInfo of modules) {
    for (const name of declarationNames(moduleInfo, THEOREM_KINDS)) {
      if (name.startsWith('nonInterference_perCore_')) proofs.add(name.slice('nonInterference_perCore_'.length));
    }
  }

  const missing = steps.filter((step) => !proofs.has(step) && !(step.endsWith('High') && proofs.has(step.slice(0, -4))));
  return { steps: steps.length, covered: steps.length - missing.length, missing };
}

/**
 * Cross-core non-interference theorems: the SMP half of the same surface.
 *
 * Counted by the naming convention the kernel uses for them
 * (`<operation>_crossCoreNonInterference`) over the module that holds them, so
 * the figure moves with the proofs rather than with a sentence.
 */
export function crossCoreNonInterferenceCount(codebaseMap) {
  const owner = productionModules(codebaseMap)
    .find((moduleInfo) => moduleInfo?.module === 'SeLe4n.Kernel.InformationFlow.NonInterferenceCrossCore');
  if (!owner) return undefined;
  return declarationNames(owner, THEOREM_KINDS).filter((name) => name.includes('crossCoreNonInterference')).length;
}

/**
 * The size of an enforcement-boundary table, read from the theorem that pins it.
 *
 * The kernel classifies each operation by enforcement level in a list, and
 * proves its length: `theorem enforcementBoundaryExtended_count :
 * enforcementBoundaryExtended.length = 44 := by rfl`. Upstream's own docstring
 * says the count "is **not** restated here … a number repeated in prose goes
 * stale the first time an entry lands" — and the site was doing exactly that,
 * quoting 38 through six expansions. So the figure comes off the machine-
 * checked statement, which is as close to the truth as a published number gets.
 */
export function enforcementBoundarySize(codebaseMap, sourceText, theoremName) {
  if (typeof sourceText !== 'function') return undefined;

  for (const moduleInfo of productionModules(codebaseMap)) {
    if (!declarationNames(moduleInfo, THEOREM_KINDS).includes(theoremName)) continue;
    let source;
    try { source = sourceText(moduleInfo.path); } catch { return undefined; }
    if (typeof source !== 'string') return undefined;
    const statement = new RegExp(
      `\\b${theoremName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b[^]{0,400}?\\.length\\s*=\\s*(\\d+)`
    ).exec(stripLeanComments(source));
    if (statement) return Number(statement[1]);
  }

  return undefined;
}

export function siteMetricsFromCodebaseMap(codebaseMap, options = {}) {
  const map = codebaseMap && typeof codebaseMap === 'object' ? codebaseMap : null;
  if (!map) return {};

  const sync = map.readme_sync && typeof map.readme_sync === 'object' ? map.readme_sync : {};
  const lineCount = typeof options?.lineCount === 'function' ? options.lineCount : null;
  const metrics = {};

  // The project declares its version in lakefile.toml; `readme_sync.version`
  // and the README badge are both copies of it, and the Rust workspace says so
  // in a comment ("Version tracks the Lean lakefile.toml version"). The caller
  // reads the declaration from the same pinned checkout and passes it here, so
  // the site publishes the source of truth rather than a README mirror.
  // Without it the artifact's copy still serves, which keeps this function
  // usable on an artifact alone.
  const projectVersion = typeof options?.projectVersion === 'string' ? options.projectVersion.trim() : '';
  if (projectVersion) metrics.version = projectVersion;
  else if (typeof sync.version === 'string' && sync.version.trim()) metrics.version = sync.version.trim();

  // `lean_toolchain` carries the toolchain tag ("v4.28.0"); the page renders a
  // bare version after the word "Lean".
  if (typeof sync.lean_toolchain === 'string' && sync.lean_toolchain.trim()) {
    metrics.leanVersion = sync.lean_toolchain.trim().replace(/^v/i, '');
  }

  // Physical lines of production Lean. A mechanical count with no parsing in
  // it, unlike proved_theorem_lemma_decls — see the note at the top of this
  // file. The artifact counts its own production scope; the framework files
  // the site leaves out are subtracted, measured on the verified sources.
  const productionLoc = positiveInteger(sync.production_loc);
  if (productionLoc !== undefined) {
    const excluded = excludedFrameworkModules(map);
    if (!excluded.length) {
      metrics.lines = productionLoc;
    } else if (lineCount && productionLocReproduction(map, lineCount).matches) {
      // Subtract only when the same count reproduces production_loc over the
      // artifact's own files; otherwise `lines` stays absent and the sync
      // refuses to publish (see productionLocReproduction).
      let subtracted = 0;
      let complete = true;
      for (const moduleInfo of excluded) {
        const count = positiveInteger(lineCount(moduleInfo.path));
        if (count === undefined) { complete = false; break; }
        subtracted += count;
      }
      if (complete && subtracted <= productionLoc) metrics.lines = productionLoc - subtracted;
    }
  }

  const modules = productionModules(map);
  if (modules.length) {
    metrics.modules = modules.length;
    metrics.theorems = modules.reduce((total, moduleInfo) => total + theoremDeclarationCount(moduleInfo.declarations), 0);
  }

  const admitted = admittedCountFromCodebaseMap(map);
  if (admitted !== undefined) metrics.admitted = admitted;

  // Counted off the digest-verified sources, like `lines`.
  const sourceText = typeof options?.sourceText === 'function' ? options.sourceText : null;
  if (sourceText) {
    const syscalls = syscallSurfaceSize(map, sourceText);
    if (syscalls !== undefined) metrics.syscalls = syscalls;
    const externs = externBridgeSize(map, sourceText);
    if (externs !== undefined) metrics.externs = externs;

    // The security card's two specific claims. Both were typed into the page
    // and both had gone stale: 80 non-interference theorems against a
    // 35-constructor inductive, and 38 classified operations against a table
    // the kernel proves has 44 entries.
    const coverage = nonInterferenceCoverage(map, sourceText);
    if (coverage && !coverage.missing.length) metrics.niSteps = coverage.steps;

    const crossCore = crossCoreNonInterferenceCount(map);
    if (crossCore !== undefined) metrics.niCrossCore = crossCore;

    const enforcementOps = enforcementBoundarySize(map, sourceText, 'enforcementBoundaryExtended_count');
    if (enforcementOps !== undefined) metrics.enforcementOps = enforcementOps;

    const enforcementOpsPerCore = enforcementBoundarySize(map, sourceText, 'enforcementBoundaryPerCore_count');
    if (enforcementOpsPerCore !== undefined) metrics.enforcementOpsPerCore = enforcementOpsPerCore;
  }

  return metrics;
}

/**
 * The subsystems the landing page states a size for.
 *
 * The architecture diagram labels each layer with "N files &middot; N thms".
 * Those were hand-written, and by 0.31.0 ten of the twelve were wrong: the
 * scheduler had grown from 46 modules to 49, IPC from 52 to 66, information
 * flow from 14 to 24 and from 801 theorems to 1,680. A figure a person types
 * into markup is a figure that stops being true at the next kernel release,
 * which is exactly why no other published metric is written that way.
 *
 * So the diagram's figures are projected from the canonical artifact like
 * every other one. `key` is the `data-live` suffix the markup carries; the
 * inventory is the production modules whose name is `namespace` or sits under
 * it. A leaf namespace is a single module, which is how a layer can quote one
 * module's theorem count beside its subsystem's module count (FrozenOps
 * labels itself with the 19 commutativity proofs, not its 47 theorems).
 *
 * Adding a layer to the diagram means adding it here; `validate-data.mjs`
 * rejects a `data-live="subsystem.…"` key the snapshot does not carry.
 */
export const SITE_SUBSYSTEMS = Object.freeze([
  { key: 'scheduler', namespace: 'SeLe4n.Kernel.Scheduler' },
  { key: 'capability', namespace: 'SeLe4n.Kernel.Capability' },
  { key: 'ipc', namespace: 'SeLe4n.Kernel.IPC' },
  { key: 'lifecycle', namespace: 'SeLe4n.Kernel.Lifecycle' },
  { key: 'service', namespace: 'SeLe4n.Kernel.Service' },
  { key: 'frozen-ops', namespace: 'SeLe4n.Kernel.FrozenOps' },
  { key: 'frozen-ops-commutativity', namespace: 'SeLe4n.Kernel.FrozenOps.Commutativity' },
  { key: 'radix-tree', namespace: 'SeLe4n.Kernel.RadixTree' },
  { key: 'sched-context', namespace: 'SeLe4n.Kernel.SchedContext' },
  { key: 'concurrency', namespace: 'SeLe4n.Kernel.Concurrency' },
  { key: 'information-flow', namespace: 'SeLe4n.Kernel.InformationFlow' },
  { key: 'architecture', namespace: 'SeLe4n.Kernel.Architecture' },
  { key: 'register-decode', namespace: 'SeLe4n.Kernel.Architecture.RegisterDecode' },
  { key: 'syscall-arg-decode', namespace: 'SeLe4n.Kernel.Architecture.SyscallArgDecode' },
  { key: 'robin-hood', namespace: 'SeLe4n.Kernel.RobinHood' },
  { key: 'robin-hood-bridge', namespace: 'SeLe4n.Kernel.RobinHood.Bridge' },
  { key: 'robin-hood-lookup', namespace: 'SeLe4n.Kernel.RobinHood.Invariant.Lookup' },
  { key: 'robin-hood-preservation', namespace: 'SeLe4n.Kernel.RobinHood.Invariant.Preservation' },
  { key: 'ipc-structural', namespace: 'SeLe4n.Kernel.IPC.Invariant.Structural' },
  { key: 'ipc-endpoint-preservation', namespace: 'SeLe4n.Kernel.IPC.Invariant.EndpointPreservation' },
  { key: 'ipc-cap-transfer', namespace: 'SeLe4n.Kernel.IPC.Operations.CapTransfer' },
  { key: 'model-object', namespace: 'SeLe4n.Model.Object' },
  { key: 'model-state', namespace: 'SeLe4n.Model.State' }
]);

/** True when `moduleName` is `namespace` itself or a module under it. */
function inNamespace(moduleName, namespace) {
  const name = String(moduleName ?? '');
  return name === namespace || name.startsWith(`${namespace}.`);
}

/**
 * Per-subsystem module and theorem counts, over the same production corpus and
 * the same declaration inventory as the headline `modules` and `theorems`.
 *
 * Every layer in SITE_SUBSYSTEMS gets an entry. A namespace that matches
 * nothing reports zeros rather than going missing, so a renamed subsystem
 * shows up as a visible "0 files" on the page instead of silently keeping the
 * last number that was stamped there.
 */
export function subsystemMetricsFromCodebaseMap(codebaseMap) {
  const modules = productionModules(codebaseMap);
  const metrics = {};

  for (const { key, namespace } of SITE_SUBSYSTEMS) {
    const members = modules.filter((moduleInfo) => inNamespace(moduleInfo?.module, namespace));
    metrics[key] = {
      modules: members.length,
      theorems: members.reduce((total, moduleInfo) => total + theoremDeclarationCount(moduleInfo.declarations), 0)
    };
  }

  return metrics;
}

/**
 * Cross-check the artifact's own summary fields against what we derived from
 * its inventory. Divergence is not fatal — the inventory is what the site
 * publishes — but it is worth surfacing, since it is how the
 * `proved_theorem_lemma_decls` miscount was found.
 */
export function canonicalCrossChecks(codebaseMap, options = {}) {
  const sync = codebaseMap?.readme_sync ?? {};
  const derived = siteMetricsFromCodebaseMap(codebaseMap, options);
  const notes = [];

  // The artifact's own definition of production (outside tests/), so the
  // check reads the artifact against itself; the site's narrower scope is a
  // documented subtraction, not a disagreement.
  const statedModules = positiveInteger(sync.production_files);
  const artifactModules = artifactProductionModules(codebaseMap).length;
  if (statedModules !== undefined && artifactModules && statedModules !== artifactModules) {
    notes.push(`readme_sync.production_files says ${statedModules}; the module inventory has ${artifactModules}`);
  }

  // `lines` is published as production_loc minus the framework files, so the
  // mechanical count must reproduce production_loc over the artifact's scope —
  // otherwise the anchor and the subtraction would use different methods.
  const reproduction = productionLocReproduction(codebaseMap, options?.lineCount);
  if (reproduction.checked && !reproduction.matches) {
    notes.push(`readme_sync.production_loc says ${reproduction.stated}; the sources at this revision count ${reproduction.counted} physical lines over the same files — lines is withheld until the artifact is regenerated`);
  }

  // Same principle for theorems: the regex tally covers the artifact's own
  // production scope, so it is reconciled against the inventory over that
  // scope (10,937 + 78 - 15 = 11,000 on the current artifact), not against the
  // narrower figure the site publishes.
  const statedTheorems = positiveInteger(sync.proved_theorem_lemma_decls);
  const artifactTheorems = artifactProductionModules(codebaseMap)
    .reduce((total, moduleInfo) => total + theoremDeclarationCount(moduleInfo.declarations), 0);
  if (statedTheorems !== undefined && derived.theorems !== undefined && statedTheorems !== artifactTheorems) {
    notes.push(
      `readme_sync.proved_theorem_lemma_decls says ${statedTheorems}; the comment-aware ` +
      `declaration inventory has ${artifactTheorems} (difference ${statedTheorems - artifactTheorems}) — ` +
      `publishing the inventory${derived.theorems !== artifactTheorems ? ` (${derived.theorems} over the site scope)` : ''}`
    );
  }

  // The published version comes from lakefile.toml; the artifact carries its
  // own copy. They disagree only when the artifact was generated at a revision
  // whose version differed — worth saying out loud, since `source_digest`
  // covers the Lean sources and not the build manifest.
  const projectVersion = typeof options?.projectVersion === 'string' ? options.projectVersion.trim() : '';
  if (projectVersion && typeof sync.version === 'string' && sync.version.trim() && sync.version.trim() !== projectVersion) {
    notes.push(
      `lakefile.toml declares version ${projectVersion}; readme_sync.version says ${sync.version.trim()} — ` +
      `publishing the lakefile's, which is the declaration the artifact's copy mirrors`
    );
  }

  const statedTotal = positiveInteger(codebaseMap?.summary?.module_count);
  const actualTotal = Array.isArray(codebaseMap?.modules) ? codebaseMap.modules.length : undefined;
  if (statedTotal !== undefined && actualTotal !== undefined && statedTotal !== actualTotal) {
    notes.push(`summary.module_count says ${statedTotal}; modules[] has ${actualTotal}`);
  }

  return notes;
}
