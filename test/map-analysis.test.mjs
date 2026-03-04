import test from 'node:test';
import assert from 'node:assert/strict';
import {
  moduleFromPath,
  classifyLayer,
  moduleKind,
  moduleBase,
  theoremCount,
  extractInteriorCodeItems,
  extractImportTokens,
  tokenizeImportSegment
} from '../scripts/lib/map-analysis.mjs';

test('module path and classification helpers', () => {
  assert.equal(moduleFromPath('SeLe4n/Kernel/API.lean'), 'SeLe4n.Kernel.API');
  assert.equal(classifyLayer('SeLe4n.Model.State'), 'model');
  assert.equal(classifyLayer('SeLe4n.Kernel.IPC.Operations'), 'kernel');
  assert.equal(moduleKind('SeLe4n.Kernel.IPC.Operations'), 'operations');
  assert.equal(moduleKind('SeLe4n.Kernel.IPC.Invariant'), 'invariant');
  assert.equal(moduleBase('SeLe4n.Kernel.IPC.Invariant'), 'SeLe4n.Kernel.IPC');
});

test('extractImportTokens handles multiline imports and comments', () => {
  const source = `
import SeLe4n.Model.State SeLe4n.Kernel.API
import Mathlib.Data.List.Basic
  Mathlib.Tactic
  -- inline comment
import (SeLe4n.Kernel.IPC.Invariant) Foo.bar
`;

  assert.deepEqual(extractImportTokens(source), [
    'SeLe4n.Model.State',
    'SeLe4n.Kernel.API',
    'Mathlib.Data.List.Basic',
    'Mathlib.Tactic',
    'SeLe4n.Kernel.IPC.Invariant'
  ]);
  assert.deepEqual(tokenizeImportSegment('(A.B.C) x.y Z.Q'), ['A.B.C', 'Z.Q']);
});

test('symbol extraction and theorem counting are deterministic and deduplicated', () => {
  const source = `
private theorem foo_bar : True := by trivial
lemma baz : True := by trivial

@[simp] def f : Nat := 0
noncomputable def g : Nat := 1
instance instThing : Inhabited Nat := ⟨0⟩
instance instThing : Inhabited Nat := ⟨0⟩
`;

  assert.equal(theoremCount(source), 2);
  assert.deepEqual(extractInteriorCodeItems(source), {
    theorems: ['foo_bar', 'baz'],
    functions: ['f', 'g', 'instThing']
  });
});
