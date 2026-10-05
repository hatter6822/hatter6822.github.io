import test from 'node:test';
import assert from 'node:assert/strict';

import { validateMapDataObject, validateSiteDataObject, validateCallGraphDataObject, validateCrossFile } from './data-validation.mjs';
import { SITE_SUBSYSTEMS } from './canonical-map.mjs';

/**
 * A well-formed site-data.json, including the provenance fields that make
 * "this came from docs/codebase_map.json" a checkable claim. The landing page
 * once shipped README-parsed and byte-estimated figures while the schema
 * validated cleanly, because nothing recorded where the numbers came from.
 */
function siteData(overrides = {}) {
  return {
    version: '0.1.0',
    leanVersion: '4.28.0',
    modules: 23,
    lines: '25,648',
    theorems: 734,
    syscalls: 31,
    externs: 64,
    niSteps: 29,
    niCrossCore: 31,
    enforcementOps: 40,
    enforcementOpsPerCore: 55,
    frozenSyscalls: 18,
    scripts: 17,
    docs: 97,
    admitted: 0,
    // Every subsystem the landing page paints a span for. A missing key is an
    // error, not a blank: the markup would keep the literal last stamped there.
    subsystems: Object.fromEntries(
      SITE_SUBSYSTEMS.map(({ key }) => [key, { modules: 0, theorems: 0 }])
    ),
    commitSha: 'abc1234',
    updatedAt: '',
    generatedAt: '2026-03-03T00:00:00Z',
    sourceRepo: 'hatter6822/seLe4n',
    sourceRef: 'main',
    metricsSource: 'docs/codebase_map.json',
    metricsScope: 'production',
    schemaVersion: '1.0.0',
    sourceDigest: 'a'.repeat(64),
    ...overrides
  };
}

/**
 * A well-formed map-data.json. `metricsSource` and `sourceDigest` are what let
 * validateCrossFile prove both snapshots came from one pipeline run — they used
 * to be produced by separate scripts and drifted to different commits.
 */
function mapData(overrides = {}) {
  return {
    files: [],
    modules: [],
    moduleMap: {},
    moduleMeta: {},
    importsFrom: {},
    externalImportsFrom: {},
    commitSha: '',
    generatedAt: '',
    metricsSource: 'docs/codebase_map.json',
    sourceDigest: 'a'.repeat(64),
    ...overrides
  };
}

test('validateSiteDataObject accepts valid payload', () => {
  const errors = validateSiteDataObject(siteData());

  assert.deepEqual(errors, []);
});

test('validateSiteDataObject rejects invalid timestamps', () => {
  const errors = validateSiteDataObject(siteData({ updatedAt: 'yesterday', generatedAt: 'not-a-date' }));

  assert.ok(errors.some((msg) => msg.includes('generatedAt')));
  assert.ok(errors.some((msg) => msg.includes('updatedAt')));
});

test('validateMapDataObject checks module coverage', () => {
  const errors = validateMapDataObject({
    files: [],
    modules: ['A.Core', 'A.Util'],
    moduleMap: { 'A.Core': 'A/Core.lean' },
    moduleMeta: { 'A.Core': { symbols: {} }, 'A.Util': { symbols: {} } },
    importsFrom: { 'A.Core': ['A.Util'] },
    externalImportsFrom: {},
    commitSha: 'abc',
    generatedAt: '2026-03-03T00:00:00Z'
  });

  assert.ok(errors.some((msg) => msg.includes('moduleMap missing entry for A.Util')));
});

test('validateMapDataObject accepts minimal empty snapshot', () => {
  assert.deepEqual(validateMapDataObject(mapData()), []);
});

test('validateMapDataObject requires canonical provenance', () => {
  assert.ok(validateMapDataObject(mapData({ metricsSource: 'README.md' }))
    .some((msg) => msg.includes('metricsSource')));
  assert.ok(validateMapDataObject(mapData({ sourceDigest: 'short' }))
    .some((msg) => msg.includes('sourceDigest')));

  const missing = mapData();
  delete missing.sourceDigest;
  assert.ok(validateMapDataObject(missing).some((msg) => msg.includes('sourceDigest')));
});


test('validateMapDataObject validates symbols.byKind entries when present', () => {
  const errors = validateMapDataObject({
    files: [],
    modules: ['A.Core'],
    moduleMap: { 'A.Core': 'A/Core.lean' },
    moduleMeta: {
      'A.Core': {
        symbols: {
          byKind: {
            theorem: [{ name: 'x', line: 2 }],
            macro: [{}]
          }
        }
      }
    },
    importsFrom: {},
    externalImportsFrom: {},
    commitSha: 'abc',
    generatedAt: '2026-03-03T00:00:00Z'
  });

  assert.ok(errors.some((msg) => msg.includes('symbols.byKind.macro')));
});

test('validateSiteDataObject accepts payload with undefined updatedAt', () => {
  const payload = siteData();
  delete payload.updatedAt;
  const errors = validateSiteDataObject(payload);

  assert.ok(!errors.some((msg) => msg.includes('updatedAt')));
});

test('validateSiteDataObject accepts payload with valid ISO updatedAt', () => {
  const errors = validateSiteDataObject(siteData({ updatedAt: '2026-03-05T12:00:00Z' }));

  assert.deepEqual(errors, []);
});

test('validateSiteDataObject rejects null and non-object root', () => {
  assert.ok(validateSiteDataObject(null).length > 0);
  assert.ok(validateSiteDataObject('string').length > 0);
  assert.ok(validateSiteDataObject(42).length > 0);
});

test('validateMapDataObject rejects null and non-object root', () => {
  assert.ok(validateMapDataObject(null).length > 0);
  assert.ok(validateMapDataObject(undefined).length > 0);
});

test('validateSiteDataObject rejects wrong types on numeric fields', () => {
  const errors = validateSiteDataObject(siteData({ modules: '23', theorems: 'many' }));

  assert.ok(errors.some((msg) => msg.includes('modules')));
  assert.ok(errors.some((msg) => msg.includes('theorems')));
});

test('validateMapDataObject rejects non-string entries in modules array', () => {
  const errors = validateMapDataObject({
    files: [],
    modules: [123, null, 'A.Core'],
    moduleMap: { 'A.Core': 'A/Core.lean' },
    moduleMeta: { 'A.Core': { symbols: {} } },
    importsFrom: {},
    externalImportsFrom: {},
    commitSha: 'abc',
    generatedAt: '2026-03-03T00:00:00Z'
  });

  assert.ok(errors.some((msg) => msg.includes('non-empty strings')));
});

test('validateMapDataObject detects duplicate modules', () => {
  const errors = validateMapDataObject({
    files: [],
    modules: ['A.Core', 'A.Core'],
    moduleMap: { 'A.Core': 'A/Core.lean' },
    moduleMeta: { 'A.Core': { symbols: {} } },
    importsFrom: {},
    externalImportsFrom: {},
    commitSha: 'abc',
    generatedAt: '2026-03-03T00:00:00Z'
  });

  assert.ok(errors.some((msg) => msg.includes('duplicate')));
});

test('validateMapDataObject detects orphaned moduleMeta entries', () => {
  const errors = validateMapDataObject({
    files: [],
    modules: ['A.Core'],
    moduleMap: { 'A.Core': 'A/Core.lean' },
    moduleMeta: {
      'A.Core': { symbols: {} },
      'A.Ghost': { symbols: {} }
    },
    importsFrom: {},
    externalImportsFrom: {},
    commitSha: 'abc',
    generatedAt: '2026-03-03T00:00:00Z'
  });

  assert.ok(errors.some((msg) => msg.includes('orphaned entry A.Ghost')));
});

test('validateCrossFile accepts snapshots from one pipeline run', () => {
  assert.deepEqual(validateCrossFile(
    siteData({ commitSha: 'dcbd1dd', modules: 2, theorems: 7 }),
    mapData({
      commitSha: 'dcbd1dd30d0e5447e89b693708d73d7102021893',
      sourceDigest: 'a'.repeat(64),
      modules: ['A', 'B'],
      moduleMeta: { A: { theorems: 3 }, B: { theorems: 4 } }
    })
  ), []);
});

test('validateCrossFile rejects snapshots built from different checkouts', () => {
  // The defect this replaces: site-data generated at one commit, map-data at
  // another, each re-deriving the same quantities by its own method.
  const site = siteData({ commitSha: 'dcbd1dd', modules: 2, theorems: 7 });
  const map = mapData({
    commitSha: 'dcbd1dd30d0e5447e89b693708d73d7102021893',
    modules: ['A', 'B'],
    moduleMeta: { A: { theorems: 3 }, B: { theorems: 4 } }
  });

  assert.ok(validateCrossFile(siteData({ commitSha: '5c2616f' }), map)
    .some((msg) => msg.includes('commitSha')));
  assert.ok(validateCrossFile({ ...site, sourceDigest: 'b'.repeat(64) }, map)
    .some((msg) => msg.includes('source digests')));
  assert.ok(validateCrossFile({ ...site, metricsSource: 'README.md' }, map)
    .some((msg) => msg.includes('metrics sources')));
  assert.ok(validateCrossFile({ ...site, modules: 287 }, map)
    .some((msg) => msg.includes('287 modules but map-data graphs 2')));
  assert.ok(validateCrossFile({ ...site, theorems: 9698 }, map)
    .some((msg) => msg.includes('9698 theorems but map-data modules sum to 7')));
});


test('validateSiteDataObject rejects float values in numeric fields', () => {
  const errors = validateSiteDataObject(siteData({ modules: 23.5 }));
  assert.ok(errors.some((msg) => msg.includes('integer')));
});

test('validateSiteDataObject rejects a snapshot not sourced from the canonical map', () => {
  // This is the check that would have caught the shipped defect: metrics that
  // came from a README table and a bytes-per-line estimate, in a file whose
  // every type was correct.
  for (const [key, wrong] of [
    ['metricsSource', 'README.md'],
    ['metricsScope', 'repository'],
    ['sourceRepo', 'someone/else'],
    ['sourceRef', 'develop']
  ]) {
    const errors = validateSiteDataObject(siteData({ [key]: wrong }));
    assert.ok(errors.some((msg) => msg.includes(key)), `expected ${key} to be rejected`);
  }

  for (const key of ['metricsSource', 'metricsScope', 'schemaVersion', 'sourceDigest']) {
    const payload = siteData();
    delete payload[key];
    assert.ok(validateSiteDataObject(payload).length > 0, `expected a missing ${key} to be rejected`);
  }
});

test('validateSiteDataObject rejects malformed provenance and metric formatting', () => {
  assert.ok(validateSiteDataObject(siteData({ commitSha: 'main' }))
    .some((msg) => msg.includes('commitSha')));
  assert.ok(validateSiteDataObject(siteData({ sourceDigest: 'abc' }))
    .some((msg) => msg.includes('sourceDigest')));
  // `lines` is the one metric published pre-grouped so the no-JS fallback and
  // the hydrated value render identically.
  assert.ok(validateSiteDataObject(siteData({ lines: '330569' }))
    .some((msg) => msg.includes('lines')));
  assert.ok(validateSiteDataObject(siteData({ lines: '33,05,69' }))
    .some((msg) => msg.includes('lines')));
  assert.deepEqual(validateSiteDataObject(siteData({ lines: '330,569' })), []);
  assert.deepEqual(validateSiteDataObject(siteData({ lines: '999' })), []);
});

/**
 * The call graph ships in its own file, split from map-data in the same run.
 * Its shape and provenance are checked alone; whether its callers are
 * declarations of the snapshot is checked against map-data.
 */
function callGraphData(overrides = {}) {
  return {
    commitSha: 'dcbd1dd',
    metricsSource: 'docs/codebase_map.json',
    sourceDigest: 'a'.repeat(64),
    generatedAt: '',
    callGraph: { A: { a: ['x'] } },
    ...overrides
  };
}

test('validateCallGraphDataObject checks provenance and shape', () => {
  assert.deepEqual(validateCallGraphDataObject(callGraphData()), []);
  assert.ok(validateCallGraphDataObject(callGraphData({ sourceDigest: 'short' })).some((m) => m.includes('sourceDigest')));
  assert.ok(validateCallGraphDataObject(callGraphData({ commitSha: '' })).some((m) => m.includes('commitSha')));
  assert.ok(validateCallGraphDataObject(callGraphData({ metricsSource: 'README.md' })).some((m) => m.includes('metricsSource')));
  assert.ok(validateCallGraphDataObject(callGraphData({ callGraph: [] })).some((m) => m.includes('callGraph must be an object')));
  // Without it the map still renders modules and imports, so the regression
  // would only surface when someone opened a declaration.
  assert.ok(validateCallGraphDataObject(callGraphData({ callGraph: {} })).some((m) => m.includes('declaration call graph is missing')));
});

test('validateMapDataObject refuses an inline call graph', () => {
  const errors = validateMapDataObject(mapData({
    modules: ['A'],
    moduleMap: { A: 'A.lean' },
    moduleMeta: { A: { symbols: { byKind: { theorem: [{ name: 'a', line: 1 }] }, callGraph: { a: ['x'] } } } },
    importsFrom: { A: [] }
  }));
  assert.ok(errors.some((m) => m.includes('symbols.callGraph belongs in map-callgraph.json')));
});

test('validateCrossFile holds the call graph to the snapshot it was split from', () => {
  const site = siteData({ commitSha: 'dcbd1dd', modules: 1, theorems: 1 });
  const map = mapData({
    commitSha: 'dcbd1dd',
    modules: ['A'],
    moduleMap: { A: 'A.lean' },
    moduleMeta: { A: { theorems: 1, symbols: { byKind: { theorem: [{ name: 'a', line: 1 }] } } } },
    importsFrom: { A: [] }
  });
  const graphErrors = (overrides) => validateCrossFile(site, map, callGraphData(overrides)).filter((m) => m.includes('callgraph') || m.includes('map-callgraph'));

  assert.deepEqual(graphErrors({}), []);
  assert.ok(graphErrors({ commitSha: 'abc1234' }).some((m) => m.includes('map-callgraph commitSha abc1234 does not match')));
  assert.ok(graphErrors({ sourceDigest: 'b'.repeat(64) }).some((m) => m.includes('different canonical source digests')));
  assert.ok(graphErrors({ callGraph: { Ghost: { a: ['x'] } } }).some((m) => m.includes('names module Ghost')));
  assert.ok(graphErrors({ callGraph: { A: { a: [] } } }).some((m) => m.includes('must be a non-empty array')));
  assert.ok(graphErrors({ callGraph: { A: { a: ['ok', ''] } } }).some((m) => m.includes('non-empty declaration names')));
  assert.ok(graphErrors({ callGraph: { A: 'nope' } }).some((m) => m.includes('must be an object')));
  // The invariant that matters: a caller the module's symbol lists do not
  // carry means the two projections drifted, and every lookup through it dies.
  assert.ok(graphErrors({ callGraph: { A: { ghost: ['x'] } } })
    .some((m) => m.includes("callGraph.A.ghost is not a declaration in map-data.json's symbol lists for A")));
});

test('validateMapDataObject rejects modules outside the published production scope', () => {
  const errors = validateMapDataObject(mapData({
    modules: ['SeLe4n.Kernel.API', 'SeLe4n.Testing.Helpers', 'Tests.Smoke'],
    moduleMap: {
      'SeLe4n.Kernel.API': 'SeLe4n/Kernel/API.lean',
      'SeLe4n.Testing.Helpers': 'SeLe4n/Testing/Helpers.lean',
      'Tests.Smoke': 'tests/Smoke.lean'
    },
    moduleMeta: {
      'SeLe4n.Kernel.API': { symbols: { byKind: {} } },
      'SeLe4n.Testing.Helpers': {},
      'Tests.Smoke': {}
    }
  }));
  assert.ok(errors.some((m) => m.includes('SeLe4n.Testing.Helpers (SeLe4n/Testing/Helpers.lean) lies outside the production scope')), errors.join('\n'));
  assert.ok(errors.some((m) => m.includes('Tests.Smoke (tests/Smoke.lean) lies outside the production scope')), errors.join('\n'));
  assert.ok(!errors.some((m) => m.includes('SeLe4n.Kernel.API (')), 'the production module is not flagged');
});

/**
 * A minimal, self-consistent `rust` block: one crate, one file, one item.
 * Tests mutate a copy to produce each inconsistency.
 */
function rustInventory(overrides = {}) {
  const file = {
    path: 'rust/sele4n-sys/src/lib.rs',
    relativePath: 'src/lib.rs',
    modulePath: '',
    role: 'lib',
    lines: 3,
    items: [{ kind: 'fn', name: 'endpoint_send', line: 2, visibility: 'pub' }],
    productionItems: 1,
    publicItems: 1,
    testItems: 0,
    unsafe: { fns: 0, impls: 0, blocks: 0 },
    testUnsafe: { fns: 0, impls: 0, blocks: 0 }
  };
  const crate = {
    name: 'sele4n-sys',
    path: 'rust/sele4n-sys',
    manifest: 'rust/sele4n-sys/Cargo.toml',
    description: 'Safe wrappers',
    edition: '2021',
    version: '0.1.0',
    dependencies: [],
    internalDependencies: [],
    externalDependencies: [],
    devDependencies: [],
    buildDependencies: [],
    targetDependencies: [],
    optionalDependencies: [],
    features: [],
    deniesUnsafe: true,
    files: [file],
    sourceFiles: 1,
    lines: 3,
    items: 1,
    publicItems: 1,
    testItems: 0,
    unsafe: { fns: 0, impls: 0, blocks: 0 },
    testUnsafe: { fns: 0, impls: 0, blocks: 0 }
  };
  return {
    root: 'rust',
    workspaceManifest: 'rust/Cargo.toml',
    members: ['sele4n-sys'],
    edition: '2021',
    version: '0.1.0',
    rustVersion: '1.94',
    workspaceFiles: ['rust/Cargo.toml'],
    crates: [crate],
    ...overrides
  };
}

const RUST_FILES = ['rust/Cargo.toml', 'rust/sele4n-sys/Cargo.toml', 'rust/sele4n-sys/src/lib.rs'];

test('validateMapDataObject accepts a snapshot without a rust block and one with a consistent block', () => {
  assert.deepEqual(validateMapDataObject(mapData({ modules: [] })), []);
  assert.deepEqual(validateMapDataObject(mapData({ files: RUST_FILES, rust: rustInventory() })), []);
});

test('validateMapDataObject reconciles flagged test items and counted kinds with the counts', () => {
  const rust = rustInventory();
  const file = rust.crates[0].files[0];
  file.items.push({ kind: 'fn', name: 'roundtrip', line: 30, visibility: 'private', test: true });
  file.items.push({ kind: 'impl', name: 'Send for X', line: 40, visibility: 'private' });
  file.testItems = 1;
  rust.crates[0].testItems = 1;
  assert.deepEqual(validateMapDataObject(mapData({ files: RUST_FILES, rust })), [], 'a flagged item counts as test once; an impl block is listed but not counted');

  file.testItems = 0;
  rust.crates[0].testItems = 0;
  const errors = validateMapDataObject(mapData({ files: RUST_FILES, rust }));
  assert.ok(errors.some((m) => m.includes('testItems says 0 but 1 item(s) are flagged test')), errors.join('\n'));

  file.productionItems = 2;
  const counted = validateMapDataObject(mapData({ files: RUST_FILES, rust }));
  assert.ok(counted.some((m) => m.includes('productionItems says 2 but 1 counted item(s)')), counted.join('\n'));

  file.items[1].test = 'yes';
  const typed = validateMapDataObject(mapData({ files: RUST_FILES, rust }));
  assert.ok(typed.some((m) => m.includes('.test must be true when present')), typed.join('\n'));
});

test('validateMapDataObject reconciles unsafe counters between files and crate, production and test apart', () => {
  const rust = rustInventory();
  const file = rust.crates[0].files[0];
  file.unsafe = { fns: 1, impls: 0, blocks: 2 };
  file.testUnsafe = { fns: 0, impls: 1, blocks: 0 };
  rust.crates[0].unsafe = { fns: 1, impls: 0, blocks: 2 };
  rust.crates[0].testUnsafe = { fns: 0, impls: 1, blocks: 0 };
  assert.deepEqual(validateMapDataObject(mapData({ files: RUST_FILES, rust })), []);

  rust.crates[0].unsafe = { fns: 1, impls: 1, blocks: 2 };
  rust.crates[0].testUnsafe = { fns: 0, impls: 0, blocks: 0 };
  const errors = validateMapDataObject(mapData({ files: RUST_FILES, rust }));
  assert.ok(errors.some((m) => m.includes('unsafe.impls says 1 but files sum to 0')), errors.join('\n'));
  assert.ok(errors.some((m) => m.includes('testUnsafe.impls says 0 but files sum to 1')), errors.join('\n'));

  delete file.testUnsafe;
  const missing = validateMapDataObject(mapData({ files: RUST_FILES, rust }));
  assert.ok(missing.some((m) => m.includes('files[0].testUnsafe must carry integer fns/impls/blocks counts')), missing.join('\n'));
});

test('validateMapDataObject checks target-scoped dependency tables', () => {
  const rust = rustInventory();
  rust.crates[0].targetDependencies = [{ cfg: 'cfg(loom)', table: 'dependencies', names: ['loom'] }];
  assert.deepEqual(validateMapDataObject(mapData({ files: RUST_FILES, rust })), []);

  rust.crates[0].targetDependencies = [{ cfg: '', table: 'deps', names: 'loom' }];
  const errors = validateMapDataObject(mapData({ files: RUST_FILES, rust }));
  for (const fragment of ['targetDependencies[0].cfg must be a non-empty string', 'targetDependencies[0].table must name a dependency table', 'targetDependencies[0].names must be an array of strings']) {
    assert.ok(errors.some((m) => m.includes(fragment)), `expected ${fragment}:\n${errors.join('\n')}`);
  }
  rust.crates[0].targetDependencies = 'none';
  assert.ok(validateMapDataObject(mapData({ files: RUST_FILES, rust })).some((m) => m.includes('targetDependencies must be an array')));
});

test('validateMapDataObject checks optional dependencies and their enabling features', () => {
  const rust = rustInventory();
  rust.crates[0].optionalDependencies = [{ package: 'serde', internal: false, features: ['std'] }];
  assert.deepEqual(validateMapDataObject(mapData({ files: RUST_FILES, rust })), []);

  rust.crates[0].optionalDependencies = [{ package: '', internal: 'no', features: 'std' }];
  const errors = validateMapDataObject(mapData({ files: RUST_FILES, rust }));
  for (const fragment of ['optionalDependencies[0].package must be a non-empty string', 'optionalDependencies[0].internal must be a boolean', 'optionalDependencies[0].features must be an array of strings']) {
    assert.ok(errors.some((m) => m.includes(fragment)), `expected ${fragment}:\n${errors.join('\n')}`);
  }
  rust.crates[0].optionalDependencies = undefined;
  assert.ok(validateMapDataObject(mapData({ files: RUST_FILES, rust })).some((m) => m.includes('optionalDependencies must be an array')));
});

test('validateMapDataObject rejects crate files the snapshot tree does not list', () => {
  const rust = rustInventory();
  rust.crates[0].files[0].path = 'rust/sele4n-sys/src/ghost.rs';
  const errors = validateMapDataObject(mapData({ files: RUST_FILES, rust }));
  assert.ok(errors.some((message) => message.includes('ghost.rs is not in files[]')), errors.join('\n'));
});

test('validateMapDataObject rejects crate totals that disagree with the per-file scans', () => {
  const rust = rustInventory();
  rust.crates[0].items = 5;
  rust.crates[0].publicItems = 0;
  const errors = validateMapDataObject(mapData({ files: RUST_FILES, rust }));
  assert.ok(errors.some((message) => message.includes('items says 5 but files sum to 1')), errors.join('\n'));
  assert.ok(errors.some((message) => message.includes('publicItems says 0 but files sum to 1')), errors.join('\n'));

  const overPublic = rustInventory();
  overPublic.crates[0].files[0].publicItems = 3;
  overPublic.crates[0].publicItems = 3;
  const errs = validateMapDataObject(mapData({ files: RUST_FILES, rust: overPublic }));
  assert.ok(errs.some((message) => message.includes('publicItems says 3 but only 1 production item(s) exist')), errs.join('\n'));
});

test('validateMapDataObject rejects malformed rust items, roles, visibilities and internal dependencies', () => {
  const rust = rustInventory();
  rust.crates[0].files[0].role = 'header';
  rust.crates[0].files[0].items[0].kind = 'closure';
  rust.crates[0].files[0].items[0].visibility = 'public';
  rust.crates[0].files[0].items[0].line = 0;
  rust.crates[0].internalDependencies = ['sele4n-nope'];
  const errors = validateMapDataObject(mapData({ files: RUST_FILES, rust }));
  for (const fragment of ['role "header"', 'kind "closure"', 'visibility "public"', 'line must be a positive integer', 'unknown crate sele4n-nope']) {
    assert.ok(errors.some((message) => message.includes(fragment)), `expected an error mentioning ${fragment}:\n${errors.join('\n')}`);
  }
});

test('validateMapDataObject rejects a rust block that is not an inventory', () => {
  assert.deepEqual(validateMapDataObject(mapData({ rust: 'yes' })), ['map-data.json: rust must be an object']);
  assert.deepEqual(validateMapDataObject(mapData({ rust: { crates: 'none' } })), ['map-data.json: rust.crates must be an array']);
});

test('validateSiteDataObject requires every subsystem the page paints', () => {
  // A dropped key is not a blank on the page: `data-live` spans keep whatever
  // literal was last stamped into them, so the diagram would go on quoting a
  // figure from a previous release with nothing to say it had.
  const { scheduler, ...rest } = siteData().subsystems;
  const errors = validateSiteDataObject(siteData({ subsystems: rest }));
  assert.ok(errors.some((e) => e.includes('subsystems.scheduler is missing')));
});

test('validateSiteDataObject rejects a subsystem the page does not name', () => {
  const errors = validateSiteDataObject(
    siteData({ subsystems: { ...siteData().subsystems, invented: { modules: 1, theorems: 1 } } })
  );
  assert.ok(errors.some((e) => e.includes('subsystems.invented is not a subsystem the page names')));
});

test('validateSiteDataObject rejects a line anchor that is not a line', () => {
  const errors = validateSiteDataObject(
    siteData({ sourceAnchors: { 'SeLe4n/Kernel/API.lean': { apiInvariantBundle: 0 } } })
  );
  assert.ok(errors.some((e) => e.includes('must be a 1-based line number')));
});

test('validateCrossFile reconciles each subsystem against the graphed modules', () => {
  // The landing page and the code map describe one kernel; a layer the diagram
  // calls three modules is three modules in the graph, or the snapshots were
  // not built from one checkout.
  const site = siteData({
    subsystems: { ...siteData().subsystems, scheduler: { modules: 3, theorems: 40 } }
  });
  const map = mapData({
    modules: ['SeLe4n.Kernel.Scheduler', 'SeLe4n.Kernel.Scheduler.RunQueue'],
    moduleMeta: {
      'SeLe4n.Kernel.Scheduler': { theorems: 10 },
      'SeLe4n.Kernel.Scheduler.RunQueue': { theorems: 12 }
    }
  });

  const errors = validateCrossFile(site, map);
  assert.ok(errors.some((e) => e.includes('3 modules under SeLe4n.Kernel.Scheduler but map-data graphs 2')));
  assert.ok(errors.some((e) => e.includes('40 theorems under SeLe4n.Kernel.Scheduler but map-data modules sum to 22')));
});

test('validateCrossFile does not read a sibling namespace as a member', () => {
  // `SeLe4n.Kernel.SchedulerX` is not under `SeLe4n.Kernel.Scheduler`; a prefix
  // test without the dot would count it and quietly inflate the layer.
  const site = siteData({
    subsystems: { ...siteData().subsystems, scheduler: { modules: 1, theorems: 10 } }
  });
  const map = mapData({
    modules: ['SeLe4n.Kernel.Scheduler', 'SeLe4n.Kernel.SchedulerX'],
    moduleMeta: {
      'SeLe4n.Kernel.Scheduler': { theorems: 10 },
      'SeLe4n.Kernel.SchedulerX': { theorems: 99 }
    }
  });

  const errors = validateCrossFile(site, map);
  assert.ok(!errors.some((e) => e.includes('SeLe4n.Kernel.Scheduler')),
    `sibling namespace counted as a member: ${errors.join(' | ')}`);
});

test('validateMapDataObject rejects the derived indexes the bundle no longer ships', () => {
  assert.ok(validateMapDataObject(mapData({ importsTo: {} })).some((msg) => msg.includes('importsTo is derived')));
  const withShortcuts = mapData({
    modules: ['A'],
    moduleMap: { A: 'A.lean' },
    moduleMeta: { A: { symbols: { theorems: [], functions: [], byKind: { def: [{ name: 'f', line: 1 }], lemma: [] } } } }
  });
  const errors = validateMapDataObject(withShortcuts);
  assert.ok(errors.some((msg) => msg.includes('symbols.theorems duplicates byKind')));
  assert.ok(errors.some((msg) => msg.includes('symbols.functions duplicates byKind')));
  assert.ok(errors.some((msg) => msg.includes('symbols.byKind.lemma is empty')));
});
