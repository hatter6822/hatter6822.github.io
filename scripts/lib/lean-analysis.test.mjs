import test from 'node:test';
import assert from 'node:assert/strict';

import {
  admittedCountFromCodebaseMap,
  canonicalMetricsIssues,
  canonicalProvenance,
  extractImportTokens,
  extractInteriorCodeItems,
  INTERIOR_KIND_GROUPS,
  isLikelyModuleToken,
  normalizeSymbolName,
  siteMetricsFromCodebaseMap,
  theoremCount,
  theoremCountFromCodebaseMap,
  tokenizeImportSegment
} from './lean-analysis.mjs';

/**
 * A faithful miniature of docs/codebase_map.json at schema_version 1.0.0.
 *
 * The projection these tests cover was previously written against a guessed
 * schema (`lean_version`, `build_jobs`, `stats.*`, `files[]`) and its tests
 * used fixtures in that same invented shape, so every one of them passed while
 * the real artifact matched none of it and the landing page published
 * heuristics instead. Keep this fixture shaped like the artifact: if upstream
 * renames a key, the failure belongs here, not on the website.
 */
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
    source_sync: { source_digest: 'b'.repeat(64) },
    summary: { module_count: 4, declaration_count: 6 },
    readme_sync: {
      version: '0.34.56',
      lean_toolchain: 'v4.28.0',
      production_files: 3,
      production_loc: 330569,
      test_files: 1,
      test_loc: 68907,
      proved_theorem_lemma_decls: 11000
    },
    modules: [
      {
        module: 'SeLe4n.Kernel.API',
        path: 'SeLe4n/Kernel/API.lean',
        declaration_count: 2,
        declarations: [
          { kind: 'theorem', name: 'a', line: 10, called: ['b'] },
          { kind: 'def', name: 'b', line: 20, called: [] }
        ]
      },
      {
        module: 'Tests.Smoke',
        path: 'tests/Smoke.lean',
        declaration_count: 1,
        declarations: [{ kind: 'lemma', name: 'c', line: 5, called: [] }]
      }
    ],
    ...overrides
  };
}

test('siteMetricsFromCodebaseMap projects the canonical readme_sync block', () => {
  assert.deepEqual(siteMetricsFromCodebaseMap(canonicalMap()), {
    version: '0.34.56',
    // lean_toolchain carries the toolchain tag; the page renders a bare version.
    leanVersion: '4.28.0',
    lines: 330569,
    theorems: 11000,
    // production_files, not summary.module_count (4) — the headline figures
    // all describe the production corpus.
    modules: 3,
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

test('siteMetricsFromCodebaseMap prefers the artifact tally over its own declaration scan', () => {
  // The declaration scan counts 2 (theorem + lemma, tests included); the
  // artifact states 11000 over production files. The artifact wins.
  assert.equal(theoremCountFromCodebaseMap(canonicalMap()), 2);
  assert.equal(siteMetricsFromCodebaseMap(canonicalMap()).theorems, 11000);
});

test('siteMetricsFromCodebaseMap falls back within the artifact, never outside it', () => {
  const map = canonicalMap();
  delete map.readme_sync.proved_theorem_lemma_decls;
  delete map.readme_sync.production_files;

  const metrics = siteMetricsFromCodebaseMap(map);
  assert.equal(metrics.theorems, 2);           // the declaration scan
  assert.equal(metrics.modules, 4);            // summary.module_count
  assert.equal(metrics.lines, 330569);         // untouched
});

test('siteMetricsFromCodebaseMap omits metrics the artifact does not supply', () => {
  assert.deepEqual(siteMetricsFromCodebaseMap({ readme_sync: {} }), {});
  assert.deepEqual(siteMetricsFromCodebaseMap(null), {});
  assert.deepEqual(siteMetricsFromCodebaseMap('nonsense'), {});
});

test('canonicalMetricsIssues accepts a well-formed artifact', () => {
  assert.deepEqual(canonicalMetricsIssues(canonicalMap()), []);
});

test('canonicalMetricsIssues names every missing key and the statistic it feeds', () => {
  for (const [path, metric] of [
    ['readme_sync.version', 'version'],
    ['readme_sync.lean_toolchain', 'leanVersion'],
    ['readme_sync.production_files', 'modules'],
    ['readme_sync.production_loc', 'lines'],
    ['readme_sync.proved_theorem_lemma_decls', 'theorems'],
    ['repository.head.commit_sha', 'commitSha'],
    ['repository.head.committed_at_utc', 'updatedAt']
  ]) {
    const map = canonicalMap();
    const segments = path.split('.');
    let node = map;
    for (const segment of segments.slice(0, -1)) node = node[segment];
    delete node[segments[segments.length - 1]];

    const issues = canonicalMetricsIssues(map);
    assert.equal(issues.length, 1, `expected exactly one issue for a missing ${path}`);
    assert.match(issues[0], new RegExp(`missing ${path.replace(/\./g, '\\.')}`));
    assert.match(issues[0], new RegExp(`"${metric}"`));
  }
});

test('canonicalMetricsIssues rejects an artifact with no module inventory', () => {
  const issues = canonicalMetricsIssues(canonicalMap({ modules: [] }));
  assert.deepEqual(issues, [
    'docs/codebase_map.json: modules[] is empty — cannot verify the admitted-proof count'
  ]);
  assert.deepEqual(canonicalMetricsIssues(null), ['docs/codebase_map.json: expected a JSON object']);
});

test('admittedCountFromCodebaseMap counts axioms and sorry-reaching declarations', () => {
  const map = canonicalMap();
  map.modules[0].declarations.push({ kind: 'axiom', name: 'assumed', line: 30, called: [] });
  map.modules[1].declarations.push({ kind: 'theorem', name: 'todo', line: 9, called: ['sorryAx'] });
  map.modules[1].declarations.push({ kind: 'theorem', name: 'todo2', line: 11, called: ['sorry'] });
  assert.equal(admittedCountFromCodebaseMap(map), 3);
});

test('admittedCountFromCodebaseMap reports zero only when it inspected declarations', () => {
  assert.equal(admittedCountFromCodebaseMap(canonicalMap()), 0);
  // No inventory is not evidence of zero — the caller must not publish one.
  assert.equal(admittedCountFromCodebaseMap({ modules: [{ module: 'A' }] }), undefined);
  assert.equal(admittedCountFromCodebaseMap({ modules: [] }), undefined);
  assert.equal(admittedCountFromCodebaseMap(null), undefined);
});

test('canonicalProvenance records the commit the statistics were measured at', () => {
  assert.deepEqual(canonicalProvenance(canonicalMap()), {
    schemaVersion: '1.0.0',
    commitSha: 'bb61196',
    // The generator writes an offset timestamp; site-data.json wants a Z instant.
    updatedAt: '2026-09-05T15:04:11.000Z',
    sourceDigest: 'b'.repeat(64)
  });
});

test('canonicalProvenance drops malformed provenance rather than publishing it', () => {
  const map = canonicalMap();
  map.repository.head.commit_sha = 'not-a-sha';
  map.repository.head.committed_at_utc = 'whenever';
  map.source_sync.source_digest = 'short';

  assert.deepEqual(canonicalProvenance(map), { schemaVersion: '1.0.0' });
  assert.deepEqual(canonicalProvenance(null), {});
});

test('extractImportTokens handles inline and indented continuations', () => {
  const source = `
import SeLe4n.Kernel.Core, Std.Data.HashMap -- keep both
import SeLe4n.Security.Policy
  SeLe4n.Platform.Board
  -- ignored comment-only continuation

def x := 1
`;

  assert.deepEqual(extractImportTokens(source), [
    'SeLe4n.Kernel.Core',
    'Std.Data.HashMap',
    'SeLe4n.Security.Policy',
    'SeLe4n.Platform.Board'
  ]);
});

test('extractInteriorCodeItems returns kind-indexed declarations with legacy theorem/function projections', () => {
  const source = `
@[simp] theorem t1 : True := by trivial
lemma ` + "`quoted.name`" + ` : True := by trivial
private def helper := 1
noncomputable abbrev helper2 := helper
instance instThing : Inhabited Nat := ⟨0⟩
macro "m" : term => \`(Nat.zero)
namespace Demo
initialize
private theorem t1 : True := by trivial
`;

  const items = extractInteriorCodeItems(source);
  assert.deepEqual(items.theorems.map((item) => item.name).slice().sort(), ['quoted.name', 't1']);
  assert.deepEqual(items.functions.map((item) => item.name), ['helper', 'helper2', 'instThing']);
  assert.equal(items.byKind.macro[0]?.name, '"m"');
  assert.equal(items.byKind.namespace[0]?.name, 'Demo');
  assert.match(items.byKind.initialize[0]?.name || '', /<initialize@L\d+>/);
  assert.ok(items.theorems.every((item) => item.line > 0));
});


test('extractInteriorCodeItems reports stable line numbers with CRLF newlines', () => {
  const source = [
    'theorem alpha : True := by trivial',
    'def beta := 1',
    'instance gamma : Inhabited Nat := ⟨0⟩',
    'lemma delta : True := by trivial'
  ].join('\r\n');

  const items = extractInteriorCodeItems(source);
  assert.deepEqual(items.theorems.map((item) => [item.name, item.line]), [
    ['alpha', 1],
    ['delta', 4]
  ]);
  assert.deepEqual(items.functions.map((item) => [item.name, item.line]), [
    ['beta', 2],
    ['gamma', 3]
  ]);
});

test('theoremCount includes theorem and lemma declarations', () => {
  const source = `
 theorem a : True := by trivial
 lemma b : True := by trivial
 def c := 0
`;
  assert.equal(theoremCount(source), 2);
});


test('theoremCount supports attributed/private/protected theorem declarations', () => {
  const source = `
@[simp] theorem a : True := by trivial
private theorem b : True := by trivial
protected lemma c : True := by trivial
def notCounted := 0
`;
  assert.equal(theoremCount(source), 3);
});

test('theoremCount supports noncomputable theorem declarations', () => {
  const source = `
noncomputable theorem a : True := by trivial
@[simp] noncomputable theorem b : True := by trivial
private noncomputable lemma c : True := by trivial
noncomputable def notCounted := 0
`;
  assert.equal(theoremCount(source), 3);
});

test('extractImportTokens stops continuation when non-module tokens appear', () => {
  const source = `
import SeLe4n.Kernel.Core
  Foo.bar
  SeLe4n.Model.State
`;

  assert.deepEqual(extractImportTokens(source), [
    'SeLe4n.Kernel.Core'
  ]);
});


test('extractInteriorCodeItems provides all supported kind buckets', () => {
  const items = extractInteriorCodeItems('def x := 1');
  const allKinds = [
    ...INTERIOR_KIND_GROUPS.object,
    ...INTERIOR_KIND_GROUPS.extension,
    ...INTERIOR_KIND_GROUPS.contextInit
  ];

  for (const kind of allKinds) {
    assert.ok(Array.isArray(items.byKind[kind]), `missing array for ${kind}`);
  }
});

test('normalizeSymbolName removes backticks and trims whitespace', () => {
  assert.equal(normalizeSymbolName('  `Foo.bar`  '), 'Foo.bar');
  assert.equal(normalizeSymbolName('plainName'), 'plainName');
});

test('tokenizeImportSegment extracts valid module-like tokens only', () => {
  assert.deepEqual(tokenizeImportSegment('SeLe4n.Kernel.Core, Std.Data.HashMap (Mathlib.Data.Set)'), [
    'SeLe4n.Kernel.Core',
    'Std.Data.HashMap',
    'Mathlib.Data.Set'
  ]);
  assert.deepEqual(tokenizeImportSegment('foo.bar _Hidden lower.case'), []);
});


test('theoremCountFromCodebaseMap derives from module-level data before top-level aggregates', () => {
  assert.equal(theoremCountFromCodebaseMap({ theorems: 987, moduleMeta: { A: { theorems: 1 } } }), 1);
});

test('theoremCountFromCodebaseMap falls back to stats aggregate theorem count', () => {
  assert.equal(theoremCountFromCodebaseMap({ stats: { theorems: 222 } }), 222);
});

test('theoremCountFromCodebaseMap counts declaration-centric modules payloads', () => {
  const codebaseMap = {
    modules: [
      {
        name: 'Core',
        declarations: [
          { kind: 'theorem', name: 'core_ok' },
          { kind: 'lemma', name: 'core_safe' },
          { kind: 'def', name: 'helper' }
        ]
      },
      {
        name: 'Sched',
        symbols: {
          byKind: {
            theorem: [{ name: 'sched_ok' }]
          }
        }
      }
    ],
    theorems: 999
  };

  assert.equal(theoremCountFromCodebaseMap(codebaseMap), 3);
});

test('theoremCountFromCodebaseMap prefers declaration counts over explicit stale per-module values', () => {
  const codebaseMap = {
    moduleMeta: {
      Core: {
        theorems: 12,
        declarations: [
          { kind: 'theorem', name: 'core_ok' },
          { kind: 'lemma', name: 'core_safe' }
        ]
      }
    }
  };

  assert.equal(theoremCountFromCodebaseMap(codebaseMap), 2);
});

test('theoremCountFromCodebaseMap derives theorem totals from module meta and symbols', () => {
  const codebaseMap = {
    moduleMeta: {
      Core: { theorems: 3 },
      API: { theoremCount: 4 },
      Model: { stats: { theorems: 5 } },
      Sched: {
        symbols: {
          theorems: [{ name: 'a' }, { name: 'b' }]
        }
      },
      Device: {
        symbols: {
          byKind: {
            theorem: [{ name: 'c' }],
            lemma: [{ name: 'd' }, { name: 'e' }]
          }
        }
      }
    }
  };

  assert.equal(theoremCountFromCodebaseMap(codebaseMap), 17);
});

test('isLikelyModuleToken accepts valid module paths and rejects invalid ones', () => {
  assert.ok(isLikelyModuleToken('SeLe4n.Kernel.Core'));
  assert.ok(isLikelyModuleToken('Std'));
  assert.ok(isLikelyModuleToken('A.B.C'));
  assert.ok(!isLikelyModuleToken('lowercase'));
  assert.ok(!isLikelyModuleToken('foo.bar'));
  assert.ok(!isLikelyModuleToken(''));
  assert.ok(!isLikelyModuleToken(null));
  assert.ok(!isLikelyModuleToken('A..B'));
  assert.ok(!isLikelyModuleToken('.A'));
});

test('theoremCount returns zero for source with no theorems', () => {
  assert.equal(theoremCount('def x := 1\nstructure S where'), 0);
  assert.equal(theoremCount(''), 0);
  assert.equal(theoremCount(null), 0);
});

test('theoremCountFromCodebaseMap deduplicates modules appearing in both modules[] and moduleMeta', () => {
  const codebaseMap = {
    modules: [
      { name: 'Core', declarations: [{ kind: 'theorem', name: 't1' }] }
    ],
    moduleMeta: {
      Core: { declarations: [{ kind: 'theorem', name: 't1' }] }
    }
  };
  assert.equal(theoremCountFromCodebaseMap(codebaseMap), 1);
});

test('theoremCountFromCodebaseMap returns zero for null or non-object input', () => {
  assert.equal(theoremCountFromCodebaseMap(null), 0);
  assert.equal(theoremCountFromCodebaseMap(undefined), 0);
  assert.equal(theoremCountFromCodebaseMap('string'), 0);
});

test('extractImportTokens returns empty array for source with no imports', () => {
  assert.deepEqual(extractImportTokens('def x := 1'), []);
  assert.deepEqual(extractImportTokens(''), []);
});

test('theoremCountFromCodebaseMap returns zero for module with empty declarations array', () => {
  const codebaseMap = {
    modules: [{ name: 'Empty', declarations: [] }]
  };
  assert.equal(theoremCountFromCodebaseMap(codebaseMap), 0);
});

test('extractImportTokens handles comment-only continuation lines', () => {
  const source = `
import SeLe4n.Kernel.Core
  SeLe4n.Kernel.Helper
  -- just a comment
  SeLe4n.Kernel.Utils
`;
  assert.deepEqual(extractImportTokens(source), [
    'SeLe4n.Kernel.Core',
    'SeLe4n.Kernel.Helper',
    'SeLe4n.Kernel.Utils'
  ]);
});
