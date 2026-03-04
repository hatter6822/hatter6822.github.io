import test from 'node:test';
import assert from 'node:assert/strict';
import { countTheorems, formatNumber, parseCurrentStateMetrics } from '../scripts/lib/site-metrics.mjs';

test('formatNumber inserts separators', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
});

test('countTheorems counts theorem declarations', () => {
  const source = 'theorem alpha : True := by trivial\nprivate theorem beta : True := by trivial\ndef f := 1';
  assert.equal(countTheorems(source), 2);
});

test('parseCurrentStateMetrics reads markdown table values', () => {
  const readme = `| Metric | Value |\n| --- | --- |\n| Version | 0.15.2 |\n| Production LOC | 12,345 |\n| Theorem Count | 678 |\n| Build Jobs | 120 |`;
  assert.deepEqual(parseCurrentStateMetrics(readme), {
    version: '0.15.2',
    lines: '12,345',
    theorems: 678,
    buildJobs: 120
  });
});
