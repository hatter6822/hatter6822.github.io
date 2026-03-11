import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractImportTokens,
  extractInteriorCodeItems,
  INTERIOR_KIND_GROUPS,
  isLikelyModuleToken,
  normalizeSymbolName,
  parseCurrentStateMetrics,
  theoremCount,
  theoremCountFromCodebaseMap,
  tokenizeImportSegment
} from './lean-analysis.mjs';

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

test('parseCurrentStateMetrics extracts dashboard values from markdown table', () => {
  const readme = `
| Metric | Value |
| --- | --- |
| Version | 1.2.3 |
| Production LOC | 12,345 |
| Theorems | 789 |
| Build Jobs | 22 |
`;

  assert.deepEqual(parseCurrentStateMetrics(readme), {
    version: '1.2.3',
    lines: '12,345',
    theorems: 789,
    buildJobs: 22
  });
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

test('parseCurrentStateMetrics tolerates unrelated table rows', () => {
  const readme = `
| Metric | Value |
| --- | --- |
| Coverage | n/a |
| Version | 2.3.4-alpha |
| Production LOC | 55,001 lines |
| Theorems | 1,250 total |
| Build Jobs | 18 pipelines |
`;

  assert.deepEqual(parseCurrentStateMetrics(readme), {
    version: '2.3.4',
    lines: '55,001',
    theorems: 1250,
    buildJobs: 18
  });
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

test('parseCurrentStateMetrics returns empty object for missing table', () => {
  assert.deepEqual(parseCurrentStateMetrics('No metrics here'), {});
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

test('parseCurrentStateMetrics returns empty metrics for non-numeric value cells', () => {
  const readme = `
| Metric | Value |
| --- | --- |
| Theorems | unknown count |
| Build Jobs | pending |
`;
  assert.deepEqual(parseCurrentStateMetrics(readme), {});
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
