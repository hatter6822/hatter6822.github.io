import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractImportTokens,
  extractInteriorCodeItems,
  parseCurrentStateMetrics,
  theoremCount
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

test('extractInteriorCodeItems returns deduplicated theorem/function names', () => {
  const source = `
@[simp] theorem t1 : True := by trivial
lemma ` + "`quoted.name`" + ` : True := by trivial
private def helper := 1
noncomputable abbrev helper2 := helper
instance instThing : Inhabited Nat := ⟨0⟩
private theorem t1 : True := by trivial
`;

  const items = extractInteriorCodeItems(source);
  assert.deepEqual(items.theorems.slice().sort(), ['quoted.name', 't1']);
  assert.deepEqual(items.functions, ['helper', 'helper2', 'instThing']);
});

test('theoremCount includes theorem and lemma declarations', () => {
  const source = `
 theorem a : True := by trivial
 lemma b : True := by trivial
 def c := 0
`;
  assert.equal(theoremCount(source), 2);
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
