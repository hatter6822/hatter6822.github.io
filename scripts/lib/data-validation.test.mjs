import test from 'node:test';
import assert from 'node:assert/strict';

import { validateMapDataObject, validateSiteDataObject } from './data-validation.mjs';

test('validateSiteDataObject accepts valid payload', () => {
  const errors = validateSiteDataObject({
    version: '0.1.0',
    leanVersion: '4.28.0',
    modules: 23,
    lines: '25,648',
    theorems: 734,
    scripts: 17,
    docs: 97,
    buildJobs: 84,
    admitted: 0,
    commitSha: 'abc1234',
    updatedAt: '',
    generatedAt: '2026-03-03T00:00:00Z'
  });

  assert.deepEqual(errors, []);
});

test('validateSiteDataObject rejects invalid timestamps', () => {
  const errors = validateSiteDataObject({
    version: '0.1.0',
    leanVersion: '4.28.0',
    modules: 23,
    lines: '25,648',
    theorems: 734,
    scripts: 17,
    docs: 97,
    buildJobs: 84,
    admitted: 0,
    commitSha: 'abc1234',
    updatedAt: 'yesterday',
    generatedAt: 'not-a-date'
  });

  assert.ok(errors.some((msg) => msg.includes('generatedAt')));
  assert.ok(errors.some((msg) => msg.includes('updatedAt')));
});

test('validateMapDataObject checks edge symmetry and module coverage', () => {
  const errors = validateMapDataObject({
    files: [],
    modules: ['A.Core', 'A.Util'],
    moduleMap: { 'A.Core': 'A/Core.lean' },
    moduleMeta: { 'A.Core': { symbols: { theorems: [], functions: [] } }, 'A.Util': { symbols: { theorems: [], functions: [] } } },
    importsTo: { 'A.Util': [] },
    importsFrom: { 'A.Core': ['A.Util'] },
    externalImportsFrom: {},
    commitSha: 'abc',
    generatedAt: '2026-03-03T00:00:00Z'
  });

  assert.ok(errors.some((msg) => msg.includes('moduleMap missing entry for A.Util')));
  assert.ok(errors.some((msg) => msg.includes('importsTo.A.Util missing reverse edge to A.Core')));
});

test('validateMapDataObject accepts minimal empty snapshot', () => {
  const errors = validateMapDataObject({
    files: [],
    modules: [],
    moduleMap: {},
    moduleMeta: {},
    importsTo: {},
    importsFrom: {},
    externalImportsFrom: {},
    commitSha: '',
    generatedAt: ''
  });

  assert.deepEqual(errors, []);
});
