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
  assert.deepEqual(items.theorems.map((item) => item.name).slice().sort(), ['quoted.name', 't1']);
  assert.deepEqual(items.functions.map((item) => item.name), ['helper', 'helper2', 'instThing']);
  const helperEntry = items.functions.find((item) => item.name === "helper");
  assert.equal(helperEntry?.line, 4);
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
