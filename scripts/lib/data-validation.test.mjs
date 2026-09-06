import test from 'node:test';
import assert from 'node:assert/strict';

import { validateMapDataObject, validateSiteDataObject, validateCrossFile } from './data-validation.mjs';

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
    scripts: 17,
    docs: 97,
    admitted: 0,
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

test('validateSiteDataObject accepts valid payload', () => {
  const errors = validateSiteDataObject(siteData());

  assert.deepEqual(errors, []);
});

test('validateSiteDataObject rejects invalid timestamps', () => {
  const errors = validateSiteDataObject(siteData({ updatedAt: 'yesterday', generatedAt: 'not-a-date' }));

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


test('validateMapDataObject validates symbols.byKind entries when present', () => {
  const errors = validateMapDataObject({
    files: [],
    modules: ['A.Core'],
    moduleMap: { 'A.Core': 'A/Core.lean' },
    moduleMeta: {
      'A.Core': {
        symbols: {
          theorems: [],
          functions: [],
          byKind: {
            theorem: [{ name: 'x', line: 2 }],
            macro: [{}]
          }
        }
      }
    },
    importsTo: {},
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
    moduleMeta: { 'A.Core': { symbols: { theorems: [], functions: [] } } },
    importsTo: {},
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
    moduleMeta: { 'A.Core': { symbols: { theorems: [], functions: [] } } },
    importsTo: {},
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
      'A.Core': { symbols: { theorems: [], functions: [] } },
      'A.Ghost': { symbols: { theorems: [], functions: [] } }
    },
    importsTo: {},
    importsFrom: {},
    externalImportsFrom: {},
    commitSha: 'abc',
    generatedAt: '2026-03-03T00:00:00Z'
  });

  assert.ok(errors.some((msg) => msg.includes('orphaned entry A.Ghost')));
});

test('validateCrossFile warns on stale data gap', () => {
  const errors = validateCrossFile(
    { generatedAt: '2026-03-26T00:00:00Z' },
    { generatedAt: '2026-02-01T00:00:00Z' }
  );
  assert.ok(errors.some((msg) => msg.includes('differ by')));
});

test('validateCrossFile passes for close timestamps', () => {
  const errors = validateCrossFile(
    { generatedAt: '2026-03-26T00:00:00Z' },
    { generatedAt: '2026-03-20T00:00:00Z' }
  );
  assert.deepEqual(errors, []);
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
