import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countTheorems,
  extractImportTokens,
  formatNumber,
  moduleFromPath,
  parseCurrentStateMetrics
} from '../scripts/lib/parsers.mjs';

test('formatNumber groups thousands', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
});

test('moduleFromPath converts Lean path to module name', () => {
  assert.equal(moduleFromPath('SeLe4n/Kernel/IPC/Operations.lean'), 'SeLe4n.Kernel.IPC.Operations');
});

test('countTheorems counts theorem declarations with visibility modifiers', () => {
  const text = `
    theorem foo : True := by trivial
    private theorem bar : True := by trivial
    protected theorem baz : True := by trivial
    lemma ignoredLemma : True := by trivial
  `;
  assert.equal(countTheorems(text), 3);
});

test('parseCurrentStateMetrics parses dashboard metrics from README table', () => {
  const text = `
| Metric | Value |
| --- | --- |
| Version | 0.13.0 |
| Production LOC | 123,456 |
| Theorems | 789 |
| Build Jobs | 91 |
`;
  assert.deepEqual(parseCurrentStateMetrics(text), {
    version: '0.13.0',
    lines: '123,456',
    theorems: 789,
    buildJobs: 91
  });
});

test('extractImportTokens handles multiline imports and ignores comments', () => {
  const source = `
import SeLe4n.Kernel.Core, SeLe4n.Model.State
  SeLe4n.Platform.Board
-- import Fake.Module
import Mathlib.Data.List.Basic
`;
  assert.deepEqual(extractImportTokens(source), [
    'SeLe4n.Kernel.Core',
    'SeLe4n.Model.State',
    'SeLe4n.Platform.Board',
    'Mathlib.Data.List.Basic'
  ]);
});
