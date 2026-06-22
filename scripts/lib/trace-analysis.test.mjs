import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  validateTraceDataObject,
  reconstructState,
  scenarioStates,
  applyOp,
  applyDelta,
  touchedEntities,
  cloneState,
  SCHEMA_VERSION
} from './trace-analysis.mjs';

function minimalScenario() {
  return {
    id: 'demo',
    title: 'Demo',
    summary: 'A minimal scenario.',
    initialState: {
      current: { thread: 'a', core: 0 },
      threads: [
        { id: 'a', label: 'a', priority: 200, threadState: 'Running', ipcState: 'ready' },
        { id: 'b', label: 'b', priority: 180, threadState: 'Blocked', ipcState: 'blockedOnReceive:ep' }
      ],
      endpoints: [{ id: 'ep', label: 'ep', sendQ: [], receiveQ: ['b'] }],
      notifications: [],
      runQueue: { 0: [] }
    },
    steps: [
      { index: 0, kind: 'boot', title: 'boot', traceTag: 'T0', delta: { ops: [] }, invariants: { allHold: true, checked: [], failed: [] } },
      {
        index: 1, kind: 'syscall', title: 'send', traceTag: 'T1',
        delta: { ops: [
          { op: 'epDequeue', endpoint: 'ep', queue: 'receiveQ', thread: 'b' },
          { op: 'threadPatch', id: 'b', set: { ipcState: 'ready', threadState: 'Ready' } },
          { op: 'rqInsert', core: 0, thread: 'b' }
        ] },
        invariants: { allHold: true, checked: [], failed: [] }
      }
    ]
  };
}

function minimalData(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'fixture',
    generatedAt: '2026-06-22T00:00:00Z',
    invariantCatalog: [
      { id: 'inv1', label: 'Inv one', check: 'inv1B', module: 'M', mapModule: 'M' }
    ],
    scenarios: [minimalScenario()],
    ...overrides
  };
}

/* ── Validation ─────────────────────────────────────────────── */

test('validateTraceDataObject accepts a minimal valid payload', () => {
  assert.deepEqual(validateTraceDataObject(minimalData()), []);
});

test('validateTraceDataObject rejects wrong schemaVersion and source', () => {
  const errors = validateTraceDataObject(minimalData({ schemaVersion: 99, source: 'guess' }));
  assert.ok(errors.some((m) => m.includes('schemaVersion')));
  assert.ok(errors.some((m) => m.includes('source')));
});

test('validateTraceDataObject rejects non-sequential step indices', () => {
  const data = minimalData();
  data.scenarios[0].steps[1].index = 5;
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('index must equal 1')));
});

test('validateTraceDataObject flags dangling op references', () => {
  const data = minimalData();
  data.scenarios[0].steps[1].delta.ops.push({ op: 'rqInsert', core: 0, thread: 'ghost' });
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('unknown thread ghost')));
});

test('validateTraceDataObject flags unknown invariant ids in checked', () => {
  const data = minimalData();
  data.scenarios[0].steps[0].invariants.checked = ['nope'];
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('unknown invariant nope')));
});

test('validateTraceDataObject flags allHold/failed contradiction', () => {
  const data = minimalData();
  data.scenarios[0].steps[0].invariants.failed = ['inv1'];
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('allHold is true but failed is non-empty')));
});

test('validateTraceDataObject detects duplicate run-queue entries', () => {
  const data = minimalData();
  data.scenarios[0].initialState.runQueue['0'] = ['a', 'a'];
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('duplicate a')));
});

/* ── Fold engine ────────────────────────────────────────────── */

test('reconstructState folds deltas through a step', () => {
  const sc = minimalScenario();
  const after = reconstructState(sc, 1);
  const b = after.threads.find((t) => t.id === 'b');
  assert.equal(b.ipcState, 'ready');
  assert.deepEqual(after.endpoints[0].receiveQ, []);
  assert.deepEqual(after.runQueue['0'], ['b']);
});

test('scenarioStates returns one state per step and does not mutate input', () => {
  const sc = minimalScenario();
  const snapshot = JSON.stringify(sc.initialState);
  const states = scenarioStates(sc);
  assert.equal(states.length, sc.steps.length);
  // initial state object must be untouched (fold works on clones)
  assert.equal(JSON.stringify(sc.initialState), snapshot);
  assert.deepEqual(states[0].endpoints[0].receiveQ, ['b']); // boot step = no change
  assert.deepEqual(states[1].runQueue['0'], ['b']);
});

test('rqInsert keeps run queue ordered by descending priority and is idempotent', () => {
  const state = {
    current: { thread: null, core: 0 },
    threads: [
      { id: 'lo', priority: 100 },
      { id: 'hi', priority: 250 },
      { id: 'mid', priority: 175 }
    ],
    endpoints: [],
    notifications: [],
    runQueue: { 0: [] }
  };
  applyOp(state, { op: 'rqInsert', core: 0, thread: 'lo' });
  applyOp(state, { op: 'rqInsert', core: 0, thread: 'hi' });
  applyOp(state, { op: 'rqInsert', core: 0, thread: 'mid' });
  applyOp(state, { op: 'rqInsert', core: 0, thread: 'hi' }); // duplicate ignored
  assert.deepEqual(state.runQueue['0'], ['hi', 'mid', 'lo']);
});

test('applyOp throws on dangling references', () => {
  const state = cloneState(minimalScenario().initialState);
  assert.throws(() => applyOp(state, { op: 'threadPatch', id: 'ghost', set: {} }), /unknown thread ghost/);
  assert.throws(() => applyOp(state, { op: 'epEnqueue', endpoint: 'ghost', queue: 'sendQ', thread: 'a' }), /unknown endpoint ghost/);
  assert.throws(() => applyOp(state, { op: 'epEnqueue', endpoint: 'ep', queue: 'bogus', thread: 'a' }), /bad queue bogus/);
});

test('message and note ops do not change state', () => {
  const state = cloneState(minimalScenario().initialState);
  const before = JSON.stringify(state);
  applyDelta(state, { ops: [{ op: 'message', from: 'a', to: 'b', endpoint: 'ep', registers: 2 }, { op: 'note', text: 'hi' }] });
  assert.equal(JSON.stringify(state), before);
});

test('touchedEntities collects referenced ids by category', () => {
  const touched = touchedEntities({ ops: [
    { op: 'setCurrent', thread: 'a' },
    { op: 'threadPatch', id: 'b', set: {} },
    { op: 'epEnqueue', endpoint: 'ep', queue: 'receiveQ', thread: 'b' },
    { op: 'notifPatch', id: 'n', set: {} },
    { op: 'message', from: 'a', to: 'b', endpoint: 'ep' }
  ] });
  assert.deepEqual(touched.threads.sort(), ['a', 'b']);
  assert.deepEqual(touched.endpoints, ['ep']);
  assert.deepEqual(touched.notifications, ['n']);
});

/* ── Bundled fixture ────────────────────────────────────────── */

test('bundled data/execution-traces.json is valid and folds cleanly', async () => {
  const raw = await readFile(new URL('../../data/execution-traces.json', import.meta.url), 'utf8');
  const data = JSON.parse(raw);
  assert.deepEqual(validateTraceDataObject(data), []);
  for (const sc of data.scenarios) {
    const states = scenarioStates(sc);
    assert.equal(states.length, sc.steps.length);
  }
});
