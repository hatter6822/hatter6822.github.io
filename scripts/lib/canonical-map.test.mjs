/**
 * Tests for the contract with seLe4n's canonical codebase map.
 *
 * The projection these cover was once written against a schema that does not
 * exist (`lean_version`, `build_jobs`, `stats.*`, a top-level `files[]`), and
 * its tests passed because their fixtures were built in the same invented
 * shape. Keep every fixture here shaped like the real artifact: if upstream
 * renames a key, the failure belongs in this file, not on the website.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  SITE_SUBSYSTEMS,
  admittedCountFromCodebaseMap,
  artifactProductionModules,
  canonicalCrossChecks,
  canonicalMetricsIssues,
  canonicalSourceDigest,
  canonicalSourcePaths,
  compareCanonicalPaths,
  crossCoreNonInterferenceCount,
  enforcementBoundarySize,
  excludedFrameworkModules,
  isArtifactProductionModule,
  isProductionModule,
  nonInterferenceCoverage,
  productionLocReproduction,
  productionModules,
  resolveDeclarationName,
  siteMetricsFromCodebaseMap,
  subsystemMetricsFromCodebaseMap,
  symbolsFromDeclarations,
  theoremDeclarationCount,
} from './canonical-map.mjs';

/**
 * The symbol maps are null-prototype objects — their keys are arbitrary Lean
 * identifiers, and a declaration named `toString` or `constructor` must not
 * collide with Object.prototype. deepEqual compares prototypes, so spread
 * before asserting.
 */
const plain = (value) => ({ ...value });

/** A faithful miniature of docs/codebase_map.json at schema_version 1.0.0. */
function canonicalMap(overrides = {}) {
  return {
    schema_version: '1.0.0',
    repository: {
      name: 'hatter6822/seLe4n',
      head: {
        branch: 'main',
        commit_sha: 'bb61196fad5baa8e189ade361570f7547b0cfaa6',
        committed_at_utc: '2026-09-05T15:04:11+00:00'
      }
    },
    source_sync: {
      scope: ['SeLe4n/**/*.lean', 'Main.lean', 'tests/**/*.lean'],
      digest_algorithm: 'sha256',
      source_digest: 'b'.repeat(64)
    },
    summary: { module_count: 3, declaration_count: 5 },
    readme_sync: {
      version: '0.34.56',
      lean_toolchain: 'v4.28.0',
      production_files: 2,
      production_loc: 330569,
      test_files: 1,
      test_loc: 68907,
      proved_theorem_lemma_decls: 11000
    },
    modules: [
      {
        module: 'SeLe4n.Kernel.API',
        path: 'SeLe4n/Kernel/API.lean',
        declaration_count: 3,
        declarations: [
          { kind: 'theorem', name: 'apiInvariantBundle_default', line: 155, called: ['default'] },
          { kind: 'def', name: 'dispatch', line: 200, called: [] },
          { kind: 'namespace', name: 'SeLe4n.Kernel', line: 141, called: [] }
        ]
      },
      {
        module: 'Main',
        path: 'Main.lean',
        declaration_count: 1,
        declarations: [{ kind: 'def', name: 'main', line: 10, called: [] }]
      },
      {
        module: 'Tests.Smoke',
        path: 'tests/Smoke.lean',
        declaration_count: 1,
        declarations: [{ kind: 'theorem', name: 'smoke', line: 5, called: [] }]
      }
    ],
    ...overrides
  };
}

test('siteMetricsFromCodebaseMap projects the production corpus', () => {
  assert.deepEqual(siteMetricsFromCodebaseMap(canonicalMap()), {
    version: '0.34.56',
    // lean_toolchain carries the toolchain tag; the page renders a bare version.
    leanVersion: '4.28.0',
    lines: 330569,
    // Production only: the tests/ theorem is not counted.
    theorems: 1,
    modules: 2,
    admitted: 0
  });
});

test('siteMetricsFromCodebaseMap invents no metric the artifact does not carry', () => {
  const metrics = siteMetricsFromCodebaseMap(canonicalMap());
  // buildJobs was published for months as modules x 2. Nothing upstream states
  // a build-job count, so nothing here may produce one.
  assert.equal('buildJobs' in metrics, false);
  assert.deepEqual(
    Object.keys(metrics).sort(),
    ['admitted', 'leanVersion', 'lines', 'modules', 'theorems', 'version']
  );
});

test('siteMetricsFromCodebaseMap counts the inventory, not readme_sync', () => {
  // readme_sync.proved_theorem_lemma_decls is a bare per-line regex with no
  // comment handling: on the real artifact it counts 78 prose lines inside doc
  // comments and misses 15 protected/noncomputable declarations. The
  // comment-aware inventory is what ships.
  const map = canonicalMap();
  assert.equal(map.readme_sync.proved_theorem_lemma_decls, 11000);
  assert.equal(siteMetricsFromCodebaseMap(map).theorems, 1);
});

test('siteMetricsFromCodebaseMap omits metrics the artifact does not supply', () => {
  assert.deepEqual(siteMetricsFromCodebaseMap({ readme_sync: {} }), {});
  assert.deepEqual(siteMetricsFromCodebaseMap(null), {});
  assert.deepEqual(siteMetricsFromCodebaseMap('nonsense'), {});
});

/** The base fixture plus the in-tree testing framework module. */
function mapWithFramework() {
  const map = canonicalMap();
  map.modules.splice(2, 0, {
    module: 'SeLe4n.Testing.Helpers',
    path: 'SeLe4n/Testing/Helpers.lean',
    declaration_count: 2,
    declarations: [
      { kind: 'theorem', name: 'helper_sound', line: 3, called: [] },
      { kind: 'def', name: 'mkState', line: 8, called: [] }
    ]
  });
  map.summary.module_count = 4;
  map.readme_sync.production_files = 3;
  map.readme_sync.production_loc = 1000;
  return map;
}

/** Physical line counts for the fixture's files, the way the sync script supplies them. */
const FIXTURE_LINES = { 'SeLe4n/Kernel/API.lean': 700, 'SeLe4n/Testing/Helpers.lean': 120, 'Main.lean': 180, 'tests/Smoke.lean': 40 };
const lineCount = (path) => FIXTURE_LINES[path];

test('the site scope is the artifact scope minus the in-tree testing framework', () => {
  const map = mapWithFramework();
  assert.equal(isArtifactProductionModule({ path: 'SeLe4n/Testing/Helpers.lean' }), true, 'production by the artifact\'s definition');
  assert.equal(isProductionModule({ path: 'SeLe4n/Testing/Helpers.lean' }), false, 'test code by the site\'s');
  assert.deepEqual(artifactProductionModules(map).map((m) => m.module), ['SeLe4n.Kernel.API', 'Main', 'SeLe4n.Testing.Helpers']);
  assert.deepEqual(productionModules(map).map((m) => m.module), ['SeLe4n.Kernel.API', 'Main']);
  assert.deepEqual(excludedFrameworkModules(map).map((m) => m.module), ['SeLe4n.Testing.Helpers']);
  assert.deepEqual(excludedFrameworkModules(canonicalMap()), []);
});

test('siteMetricsFromCodebaseMap subtracts the framework files from production_loc', () => {
  const map = mapWithFramework();
  const metrics = siteMetricsFromCodebaseMap(map, { lineCount });
  assert.equal(metrics.modules, 2, 'the framework module is not published');
  assert.equal(metrics.theorems, 1, 'nor is its theorem');
  assert.equal(metrics.lines, 880, 'production_loc 1000 minus the 120-line framework file');

  const withoutSources = siteMetricsFromCodebaseMap(map);
  assert.equal('lines' in withoutSources, false, 'no line counter: lines is omitted, never published over the wrong scope');
  assert.equal(withoutSources.modules, 2);

  const unreadable = siteMetricsFromCodebaseMap(map, { lineCount: () => undefined });
  assert.equal('lines' in unreadable, false, 'an unreadable framework file omits lines too');

  // The subtraction mixes two methods unless the physical count reproduces
  // production_loc over the artifact's own files; then lines is withheld.
  map.readme_sync.production_loc = 999;
  const mixed = siteMetricsFromCodebaseMap(map, { lineCount });
  assert.equal('lines' in mixed, false, 'production_loc 999 against 1000 counted lines: lines is withheld, not 999 - 120');
  assert.deepEqual(productionLocReproduction(map, lineCount), { checked: true, matches: false, counted: 1000, stated: 999 });
  map.readme_sync.production_loc = 1000;
  assert.deepEqual(productionLocReproduction(map, lineCount), { checked: true, matches: true, counted: 1000, stated: 1000 });
  assert.equal(productionLocReproduction(map, null).checked, false, 'no counter, no check');
  assert.equal(productionLocReproduction(map, () => undefined).checked, false, 'an unreadable file leaves the check open');

  // With nothing to exclude, production_loc is published as is and needs no sources.
  assert.equal(siteMetricsFromCodebaseMap(canonicalMap()).lines, 330569);
});

test('canonicalCrossChecks reads the artifact against its own scope and checks the line method', () => {
  const map = mapWithFramework();
  map.readme_sync.proved_theorem_lemma_decls = 2;
  assert.deepEqual(canonicalCrossChecks(map, { lineCount }), [], 'production_files 3 and 2 theorems match the artifact scope; 700 + 120 + 180 reproduces production_loc');

  map.readme_sync.proved_theorem_lemma_decls = 3;
  const theoremNote = canonicalCrossChecks(map, { lineCount });
  assert.equal(theoremNote.length, 1);
  assert.match(theoremNote[0], /says 3; the comment-aware declaration inventory has 2 \(difference 1\) — publishing the inventory \(1 over the site scope\)/);
  map.readme_sync.proved_theorem_lemma_decls = 2;

  map.readme_sync.production_loc = 999;
  const notes = canonicalCrossChecks(map, { lineCount });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /production_loc says 999; the sources at this revision count 1000 physical lines over the same files — lines is withheld/);

  assert.deepEqual(canonicalCrossChecks(map), [], 'without a line counter the line method is not checked');
});

test('productionModules excludes the tests/ corpus', () => {
  assert.deepEqual(productionModules(canonicalMap()).map((m) => m.module), ['SeLe4n.Kernel.API', 'Main']);
  assert.equal(isProductionModule({ path: 'tests/Smoke.lean' }), false);
  assert.equal(isProductionModule({ path: 'SeLe4n/Kernel/API.lean' }), true);
  assert.deepEqual(productionModules(null), []);
});

test('canonicalMetricsIssues accepts a well-formed artifact', () => {
  assert.deepEqual(canonicalMetricsIssues(canonicalMap()), []);
});

test('canonicalMetricsIssues names every missing key and what it feeds', () => {
  for (const path of [
    'schema_version',
    'repository.head.commit_sha',
    'source_sync.source_digest',
    'readme_sync.version',
    'readme_sync.lean_toolchain',
    'readme_sync.production_loc',
    'readme_sync.production_files',
    'summary.module_count'
  ]) {
    const map = canonicalMap();
    const segments = path.split('.');
    let node = map;
    for (const segment of segments.slice(0, -1)) node = node[segment];
    delete node[segments[segments.length - 1]];

    const issues = canonicalMetricsIssues(map);
    assert.equal(issues.length, 1, `expected exactly one issue for a missing ${path}`);
    assert.match(issues[0], new RegExp(`missing ${path.replace(/\./g, '\\.')} \\(feeds `));
  }
});

test('canonicalMetricsIssues rejects an artifact with no usable inventory', () => {
  assert.deepEqual(canonicalMetricsIssues(canonicalMap({ modules: [] })), [
    'docs/codebase_map.json: no production modules in modules[]'
  ]);
  assert.deepEqual(
    canonicalMetricsIssues(canonicalMap({ modules: [{ module: 'A', path: 'SeLe4n/A.lean' }] })),
    ['docs/codebase_map.json: 1 production module(s) carry no declaration inventory: A']
  );
  assert.deepEqual(canonicalMetricsIssues(null), ['docs/codebase_map.json: expected a JSON object']);
});

test('canonicalMetricsIssues rejects a partial declaration inventory', () => {
  // One module keeping its declarations is not enough. A module without the
  // array contributes zero theorems and zero admitted proofs, both snapshots
  // inherit the same undercount, and cross-file validation still passes — so a
  // truncated artifact would publish a plausible wrong total.
  const map = canonicalMap();
  delete map.modules[1].declarations;

  const issues = canonicalMetricsIssues(map);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /1 production module\(s\) carry no declaration inventory: Main/);

  // A module with an empty array is a real, inventoried module — 20 such
  // import-only files exist upstream — and must stay valid.
  map.modules[1].declarations = [];
  assert.deepEqual(canonicalMetricsIssues(map), []);
});

test('admittedCountFromCodebaseMap counts axioms and sorry-reaching declarations', () => {
  const map = canonicalMap();
  map.modules[0].declarations.push({ kind: 'axiom', name: 'assumed', line: 30, called: [] });
  map.modules[0].declarations.push({ kind: 'theorem', name: 'todo', line: 40, called: ['sorryAx'] });
  map.modules[1].declarations.push({ kind: 'theorem', name: 'todo2', line: 11, called: ['sorry'] });
  assert.equal(admittedCountFromCodebaseMap(map), 3);
});

test('admittedCountFromCodebaseMap reports zero only when it inspected declarations', () => {
  assert.equal(admittedCountFromCodebaseMap(canonicalMap()), 0);
  // No inventory is not evidence of zero — the caller must not publish one.
  assert.equal(admittedCountFromCodebaseMap({ modules: [{ module: 'A', path: 'SeLe4n/A.lean' }] }), undefined);
  assert.equal(admittedCountFromCodebaseMap({ modules: [] }), undefined);
  assert.equal(admittedCountFromCodebaseMap(null), undefined);
});

test('theoremDeclarationCount counts theorem and lemma kinds only', () => {
  assert.equal(theoremDeclarationCount([
    { kind: 'theorem' }, { kind: 'lemma' }, { kind: 'def' }, { kind: 'example' }
  ]), 2);
  assert.equal(theoremDeclarationCount(undefined), 0);
});

test('compareCanonicalPaths orders by component, as Python PurePath does', () => {
  // Load-bearing for the digest: a flat string compare puts "SeLe4n/Kernel.lean"
  // first ('.' is 0x2E, '/' is 0x2F); PurePath compares the parts tuple, so the
  // directory wins. Get this wrong and every digest mismatches plausibly.
  assert.ok(compareCanonicalPaths('SeLe4n/Kernel/API.lean', 'SeLe4n/Kernel.lean') < 0);
  assert.ok('SeLe4n/Kernel.lean' < 'SeLe4n/Kernel/API.lean', 'the flat compare disagrees, which is the point');
  assert.ok(compareCanonicalPaths('SeLe4n/A.lean', 'SeLe4n/B.lean') < 0);
  assert.equal(compareCanonicalPaths('SeLe4n/A.lean', 'SeLe4n/A.lean'), 0);
});

test('canonicalSourcePaths mirrors the generator scope and ordering', () => {
  assert.deepEqual(canonicalSourcePaths([
    'tests/Smoke.lean',
    'README.md',
    'SeLe4n/Kernel.lean',
    'SeLe4n.lean',
    'Main.lean',
    'SeLe4n/Kernel/API.lean',
    'rust/src/lib.rs'
  ]), [
    // SeLe4n/** first, component-ordered; then Main.lean; then tests/**.
    // Top-level SeLe4n.lean is outside the generator's scope.
    'SeLe4n/Kernel/API.lean',
    'SeLe4n/Kernel.lean',
    'Main.lean',
    'tests/Smoke.lean'
  ]);
});

test('canonicalSourceDigest hashes path and bytes with NUL separators', () => {
  const files = { 'SeLe4n/A.lean': Buffer.from('theorem a := rfl\n') };
  const digest = canonicalSourceDigest(createHash('sha256'), ['SeLe4n/A.lean'], (p) => files[p]);

  const expected = createHash('sha256');
  expected.update(Buffer.from('SeLe4n/A.lean', 'utf8'));
  expected.update(Buffer.from([0]));
  expected.update(files['SeLe4n/A.lean']);
  expected.update(Buffer.from([0]));

  assert.equal(digest, expected.digest('hex'));
});

test('resolveDeclarationName recovers identifiers the artifact truncates', () => {
  // _extract_names splits the head at the first ":" and drops "?", so distinct
  // theorems collapse onto one recorded name.
  assert.equal(
    resolveDeclarationName({ kind: 'theorem', name: 'ofErrorLabel', line: 1026 },
      'theorem ofErrorLabel?_zero : ofErrorLabel? 0 = none := by'),
    'ofErrorLabel?_zero'
  );
  assert.equal(
    resolveDeclarationName({ kind: 'theorem', name: 'ofErrorLabel', line: 1033 },
      'theorem ofErrorLabel?_none_of_lt_base (label : Nat) :'),
    'ofErrorLabel?_none_of_lt_base'
  );
  assert.equal(
    resolveDeclarationName({ kind: 'theorem', name: 'foo', line: 1 }, '@[simp] theorem foo_bar : True := trivial'),
    'foo_bar'
  );
});

test('resolveDeclarationName only ever extends the recorded name', () => {
  // A line it cannot re-parse, or a different name, must leave the record alone.
  assert.equal(resolveDeclarationName({ kind: 'theorem', name: 'foo', line: 1 }, 'theorem bar : True'), 'foo');
  assert.equal(resolveDeclarationName({ kind: 'theorem', name: 'foo', line: 1 }, ''), 'foo');
  assert.equal(resolveDeclarationName({ kind: 'theorem', name: 'foo', line: 1 }, undefined), 'foo');
  // Multi-name declarations record one entry per name; the line yields only the
  // first, which extends neither of the others.
  assert.equal(resolveDeclarationName({ kind: 'variable', name: 'y', line: 1 }, 'variable x y z'), 'y');
  assert.equal(resolveDeclarationName({ kind: 'variable', name: 'x', line: 1 }, 'variable x y z'), 'x');
});

test('symbolsFromDeclarations buckets by kind and recovers names from source', () => {
  const source = [
    'namespace SeLe4n',
    'theorem ofErrorLabel?_zero : True := trivial',
    'def dispatch : Nat := 0'
  ].join('\n');
  const symbols = symbolsFromDeclarations([
    { kind: 'namespace', name: 'SeLe4n', line: 1 },
    { kind: 'theorem', name: 'ofErrorLabel', line: 2 },
    { kind: 'def', name: 'dispatch', line: 3 }
  ], source);

  assert.deepEqual(symbols.theorems, [{ name: 'ofErrorLabel?_zero', line: 2 }]);
  assert.deepEqual(symbols.functions, [{ name: 'dispatch', line: 3 }]);
  assert.deepEqual(symbols.byKind.namespace, [{ name: 'SeLe4n', line: 1 }]);
  // Every interior kind the UI groups must exist, even when empty.
  for (const kind of ['theorem', 'lemma', 'def', 'abbrev', 'opaque', 'instance', 'structure', 'section']) {
    assert.ok(Array.isArray(symbols.byKind[kind]), `missing bucket for ${kind}`);
  }
});

test('symbolsFromDeclarations keeps distinct declarations that share a name', () => {
  // Deduplicating by name alone hid 145 production theorems, because the
  // artifact records truncated names that collide.
  const symbols = symbolsFromDeclarations([
    { kind: 'theorem', name: 'ledger_head', line: 877 },
    { kind: 'theorem', name: 'ledger_head', line: 1792 }
  ], '');
  assert.equal(symbols.theorems.length, 2);
  assert.deepEqual(symbols.theorems.map((s) => s.line), [877, 1792]);

  // A genuinely repeated (name, line) is still collapsed.
  assert.equal(symbolsFromDeclarations([
    { kind: 'theorem', name: 'a', line: 1 },
    { kind: 'theorem', name: 'a', line: 1 }
  ], '').theorems.length, 1);
});

test('symbolsFromDeclarations builds the call graph under recovered names', () => {
  // The graph and the symbol lists must agree on names: the runtime resolves a
  // declaration through byKind (declarationIndex) and its calls through
  // callGraph (declarationGraph), so a name in only one yields a dead lookup.
  const source = [
    'theorem ofErrorLabel?_zero : True := trivial',
    'def dispatch : Nat := 0',
    'namespace SeLe4n'
  ].join('\n');
  const symbols = symbolsFromDeclarations([
    { kind: 'theorem', name: 'ofErrorLabel', line: 1, called: ['trivial', 'True'] },
    { kind: 'def', name: 'dispatch', line: 2, called: [] },
    { kind: 'namespace', name: 'SeLe4n', line: 3 }
  ], source);

  assert.deepEqual(plain(symbols.callGraph), { 'ofErrorLabel?_zero': ['trivial', 'True'] });
  assert.equal(symbols.theorems[0].name, 'ofErrorLabel?_zero');
  // An empty or absent `called` produces no entry, matching what the map
  // runtime builds from the artifact directly.
  assert.equal('dispatch' in symbols.callGraph, false);
  assert.equal('SeLe4n' in symbols.callGraph, false);
});

test('symbolsFromDeclarations trims call targets and drops empties', () => {
  const symbols = symbolsFromDeclarations([
    { kind: 'theorem', name: 'a', line: 1, called: ['  x  ', '', null, 'y'] },
    { kind: 'theorem', name: 'b', line: 2, called: ['', '   '] }
  ], '');
  assert.deepEqual(plain(symbols.callGraph), { a: ['x', 'y'] });
});

test('symbolsFromDeclarations collapses a name collision the way the runtime does', () => {
  // The artifact records short names, so `refl` in two namespaces of one file
  // is two declarations under one key. The runtime's merged graph is keyed by
  // bare name globally and collapses them identically; later wins.
  const symbols = symbolsFromDeclarations([
    { kind: 'theorem', name: 'refl', line: 1605, called: ['first'] },
    { kind: 'theorem', name: 'refl', line: 1846, called: ['second'] }
  ], '');
  assert.deepEqual(plain(symbols.callGraph), { refl: ['second'] });
  // Both declarations still appear in the symbol lists, keyed by line.
  assert.deepEqual(symbols.theorems.map((t) => t.line), [1605, 1846]);
});

test('symbolsFromDeclarations keeps a kind the interior UI does not group', () => {
  const symbols = symbolsFromDeclarations([{ kind: 'future_kind', name: 'x', line: 3 }], '');
  assert.deepEqual(symbols.byKind.future_kind, [{ name: 'x', line: 3 }]);
});

test('symbolsFromDeclarations tolerates a missing inventory', () => {
  const symbols = symbolsFromDeclarations(undefined, undefined);
  assert.deepEqual(symbols.theorems, []);
  assert.deepEqual(symbols.functions, []);
  assert.deepEqual(plain(symbols.callGraph), {});
});

test('canonicalCrossChecks reports the artifact disagreeing with itself', () => {
  // The fixture's readme_sync theorem tally is the real artifact's 11,000 while
  // its inventory holds one production theorem — the same shape of divergence
  // that exposed the proved_theorem_lemma_decls miscount upstream.
  const theoremNotes = canonicalCrossChecks(canonicalMap());
  assert.equal(theoremNotes.length, 1);
  assert.match(theoremNotes[0], /proved_theorem_lemma_decls says 11000; the comment-aware declaration inventory has 1 \(difference 10999\) — publishing the inventory/);

  const map = canonicalMap();
  map.readme_sync.production_files = 99;
  map.summary.module_count = 42;
  const notes = canonicalCrossChecks(map);
  assert.equal(notes.length, 3);
  assert.ok(notes.some((n) => /production_files says 99; the module inventory has 2/.test(n)));
  assert.ok(notes.some((n) => /summary\.module_count says 42; modules\[\] has 3/.test(n)));
});

test('canonicalCrossChecks is silent when the artifact agrees with itself', () => {
  const map = canonicalMap();
  map.readme_sync.proved_theorem_lemma_decls = 1;
  assert.deepEqual(canonicalCrossChecks(map), []);
});

test('subsystemMetricsFromCodebaseMap counts a namespace and its descendants', () => {
  const map = {
    modules: [
      { module: 'SeLe4n.Kernel.Scheduler', path: 'SeLe4n/Kernel/Scheduler.lean',
        declarations: [{ kind: 'theorem', name: 'a' }, { kind: 'def', name: 'b' }] },
      { module: 'SeLe4n.Kernel.Scheduler.RunQueue', path: 'SeLe4n/Kernel/Scheduler/RunQueue.lean',
        declarations: [{ kind: 'lemma', name: 'c' }] },
      // A sibling whose name merely starts the same way, and test code the
      // site scope leaves out — neither belongs to the layer.
      { module: 'SeLe4n.Kernel.SchedulerX', path: 'SeLe4n/Kernel/SchedulerX.lean',
        declarations: [{ kind: 'theorem', name: 'd' }] },
      { module: 'SeLe4n.Kernel.Scheduler.Spec', path: 'tests/Scheduler/Spec.lean',
        declarations: [{ kind: 'theorem', name: 'e' }] }
    ]
  };

  const metrics = subsystemMetricsFromCodebaseMap(map);
  assert.deepEqual(metrics.scheduler, { modules: 2, theorems: 2 });
});

test('subsystemMetricsFromCodebaseMap reports a vanished namespace as zero, not as missing', () => {
  // A renamed subsystem must show up as a visible "0 files" on the page rather
  // than leaving the last stamped literal in place with nothing to flag it.
  const metrics = subsystemMetricsFromCodebaseMap({ modules: [] });
  for (const { key } of SITE_SUBSYSTEMS) {
    assert.deepEqual(metrics[key], { modules: 0, theorems: 0 }, key);
  }
});

test('nonInterferenceCoverage pairs every step with its own proof', () => {
  const map = {
    modules: [
      { module: 'M.Composition', path: 'M/Composition.lean',
        declarations: [{ kind: 'inductive', name: 'NonInterferenceStep' }] },
      { module: 'M.PerCore', path: 'M/PerCore.lean', declarations: [
        { kind: 'theorem', name: 'nonInterference_perCore_schedule' },
        // The `High` variant of a step is covered by the base-named theorem.
        { kind: 'theorem', name: 'nonInterference_perCore_endpointSendDual' }
      ] }
    ]
  };
  const source = [
    'inductive NonInterferenceStep where',
    '  | schedule',
    '  | endpointSendDualHigh'
  ].join('\n');

  assert.deepEqual(
    nonInterferenceCoverage(map, () => source),
    { steps: 2, covered: 2, missing: [] }
  );
});

test('nonInterferenceCoverage names the steps that have no proof', () => {
  const map = {
    modules: [
      { module: 'M.Composition', path: 'M/Composition.lean',
        declarations: [{ kind: 'inductive', name: 'NonInterferenceStep' }] },
      { module: 'M.PerCore', path: 'M/PerCore.lean',
        declarations: [{ kind: 'theorem', name: 'nonInterference_perCore_schedule' }] }
    ]
  };
  const source = 'inductive NonInterferenceStep where\n  | schedule\n  | timerTick';

  const coverage = nonInterferenceCoverage(map, () => source);
  assert.deepEqual(coverage, { steps: 2, covered: 1, missing: ['timerTick'] });
});

test('enforcementBoundarySize reads the length the kernel proves', () => {
  // Upstream's own docstring says the entry count "is **not** restated here:
  // it is pinned by `enforcementBoundaryExtended_count`". So the site reads
  // the theorem rather than a sentence about it.
  const map = {
    modules: [{ module: 'M.Soundness', path: 'M/Soundness.lean',
      declarations: [{ kind: 'theorem', name: 'enforcementBoundaryExtended_count' }] }]
  };
  const source = [
    '/-- A doc comment mentioning 33 entries, which is what went stale. -/',
    'theorem enforcementBoundaryExtended_count :',
    '    enforcementBoundaryExtended.length = 44 := by rfl'
  ].join('\n');

  assert.equal(enforcementBoundarySize(map, () => source, 'enforcementBoundaryExtended_count'), 44);
});

test('enforcementBoundarySize returns undefined when no module proves it', () => {
  assert.equal(enforcementBoundarySize({ modules: [] }, () => '', 'whatever_count'), undefined);
});

test('crossCoreNonInterferenceCount counts the SMP half by its naming convention', () => {
  const map = {
    modules: [{
      module: 'SeLe4n.Kernel.InformationFlow.NonInterferenceCrossCore',
      path: 'SeLe4n/Kernel/InformationFlow/NonInterferenceCrossCore.lean',
      declarations: [
        { kind: 'theorem', name: 'schedule_crossCoreNonInterference' },
        { kind: 'theorem', name: 'wakeThread_crossCoreNonInterference_of_visible_thread' },
        { kind: 'theorem', name: 'declassificationRelativeNonInterference' },
        { kind: 'def', name: 'notATheorem_crossCoreNonInterference' }
      ]
    }]
  };
  assert.equal(crossCoreNonInterferenceCount(map), 2);
});
