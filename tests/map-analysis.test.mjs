import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLayer, extractImportTokens, extractInteriorCodeItems, moduleBase, moduleFromPath, moduleKind, theoremCount } from '../scripts/lib/map-analysis.mjs';

test('module helpers classify modules correctly', () => {
  assert.equal(moduleFromPath('SeLe4n/Kernel/Foo/Bar.lean'), 'SeLe4n.Kernel.Foo.Bar');
  assert.equal(classifyLayer('SeLe4n.Kernel.IPC.Endpoint'), 'kernel');
  assert.equal(classifyLayer('SeLe4n.Hardware.Timer'), 'platform');
  assert.equal(moduleKind('SeLe4n.Kernel.IPC.Operations'), 'operations');
  assert.equal(moduleKind('SeLe4n.Kernel.IPC.Invariant'), 'invariant');
  assert.equal(moduleBase('SeLe4n.Kernel.IPC.Invariant'), 'SeLe4n.Kernel.IPC');
});

test('extractImportTokens parses multiline imports and strips comments', () => {
  const source = `import SeLe4n.Kernel.Init -- comment\nimport\n  SeLe4n.Kernel.IPC.Endpoint\n  Mathlib.Data.List.Basic\n\n def x := 1`;
  assert.deepEqual(extractImportTokens(source), [
    'SeLe4n.Kernel.Init',
    'SeLe4n.Kernel.IPC.Endpoint',
    'Mathlib.Data.List.Basic'
  ]);
});

test('extractInteriorCodeItems and theoremCount discover symbols', () => {
  const source = `theorem foo.bar : True := by trivial\nprivate lemma helper : True := by trivial\nnoncomputable def solve := 1\ninstance autoInst : Inhabited Nat := ⟨0⟩`;
  const symbols = extractInteriorCodeItems(source);
  assert.deepEqual(symbols.theorems, ['foo.bar', 'helper']);
  assert.deepEqual(symbols.functions, ['solve', 'autoInst']);
  assert.equal(theoremCount(source), 2);
});
