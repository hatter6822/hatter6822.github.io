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
import { anchorTraceRefs, checkTraceKernelFacts, collectTraceRefs, requiredRightTable } from './trace-anchors.mjs';

const ref = (name, module = 'SeLe4n.Kernel.Demo') => ({ name, module });

function minimalScenario() {
  return {
    id: 'demo',
    title: 'Demo',
    summary: 'A minimal scenario.',
    properties: ['p1'],
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
      { index: 0, kind: 'boot', title: 'boot', traceTag: 'T0', outcome: { status: 'ok' }, sourceRefs: [], guarantees: [], delta: { ops: [] }, invariants: { preserved: [] } },
      {
        index: 1, kind: 'syscall', title: 'send', traceTag: 'T1',
        syscall: { id: 'send', requiredRight: 'write' },
        path: [
          { stage: 'entry', label: 'entry', ref: ref('entry'), result: 'pass' },
          { stage: 'lookup', label: 'lookup', ref: ref('lookup'), result: 'pass' },
          { stage: 'rights', label: 'rights', result: 'pass' },
          { stage: 'operation', label: 'send', ref: ref('send'), result: 'pass' }
        ],
        outcome: { status: 'ok' },
        sourceRefs: [ref('send')],
        guarantees: ['p1'],
        delta: { ops: [
          { op: 'epDequeue', endpoint: 'ep', queue: 'receiveQ', thread: 'b' },
          { op: 'threadPatch', id: 'b', set: { ipcState: 'ready', threadState: 'Ready' } },
          { op: 'rqInsert', core: 0, thread: 'b' }
        ] },
        invariants: { preserved: ['inv1'] }
      }
    ]
  };
}

function minimalData(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'fixture',
    generatedAt: '2026-06-22T00:00:00Z',
    propertyCatalog: [
      { id: 'p1', label: 'Prop one', statement: 'Holds.', theorems: [ref('p1_thm')], invariants: ['inv1'] }
    ],
    invariantCatalog: [
      { id: 'inv1', label: 'Inv one', subsystem: 'ipc', meaning: 'Means.', predicate: ref('inv1'), preservedBy: [ref('send_preserves_inv1')] }
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

test('validateTraceDataObject flags unknown invariant and property ids', () => {
  const data = minimalData();
  data.scenarios[0].steps[0].invariants.preserved = ['nope'];
  data.scenarios[0].steps[1].guarantees = ['ghost'];
  data.scenarios[0].properties = ['missing'];
  data.propertyCatalog[0].invariants = ['absent'];
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('unknown invariant nope')));
  assert.ok(errors.some((m) => m.includes('unknown property ghost')));
  assert.ok(errors.some((m) => m.includes('unknown property missing')));
  assert.ok(errors.some((m) => m.includes('unknown invariant absent')));
});

test('validateTraceDataObject requires every invariant to name its predicate and a preserving theorem', () => {
  const data = minimalData();
  data.invariantCatalog[0].preservedBy = [];
  delete data.invariantCatalog[0].predicate;
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('preservedBy must name at least 1')));
  assert.ok(errors.some((m) => m.includes('predicate must be a { name, module } reference')));
});

test('a refused step may not change state: an error returns no successor state', () => {
  const data = minimalData();
  const step = data.scenarios[0].steps[1];
  step.outcome = { status: 'error', error: 'illegalAuthority' };
  step.path[2] = { ...step.path[2], result: 'fail', error: 'illegalAuthority' };
  step.path[3] = { ...step.path[3], result: 'skip' };
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('changes state, but the step was refused')), errors.join('\n'));
  step.delta.ops = [{ op: 'note', text: 'refused' }];
  assert.deepEqual(validateTraceDataObject(data), []);
});

test('a syscall path names exactly the stage that refused, and skips the rest', () => {
  const data = minimalData();
  const step = data.scenarios[0].steps[1];
  step.delta.ops = [];
  step.outcome = { status: 'error', error: 'illegalAuthority' };
  let errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('exactly one refusing stage')));
  step.path[2] = { ...step.path[2], result: 'fail', error: 'invalidCapability' };
  errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('must match the step\'s outcome error')));
  assert.ok(errors.some((m) => m.includes('must be "skip"')));
  step.path[2].error = 'illegalAuthority';
  step.path[3].result = 'skip';
  assert.deepEqual(validateTraceDataObject(data), []);
  step.path.reverse();
  assert.ok(validateTraceDataObject(data).some((m) => m.includes('out of order')));
});

test('validateTraceDataObject detects duplicate run-queue entries', () => {
  const data = minimalData();
  data.scenarios[0].initialState.runQueue['0'] = ['a', 'a'];
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('a appears in more than one run-queue')));
});

test('validateTraceDataObject rejects a thread enqueued on two cores', () => {
  const data = minimalData();
  // remove-before-insert across cores must keep run queues globally unique;
  // a thread left in the source core and inserted into the destination must fail.
  data.scenarios[0].initialState.runQueue = { '0': ['a'], '1': ['a'] };
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('a appears in more than one run-queue')), 'cross-core duplicate is rejected');
});

test('validateTraceDataObject rejects a dangling initial current thread', () => {
  const data = minimalData();
  data.scenarios[0].initialState.current.thread = 'ghost'; // not in threads[]
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('current.thread ghost is not a declared thread')));
});

test('validateTraceDataObject accepts a null (idle) current thread', () => {
  const data = minimalData();
  data.scenarios[0].initialState.current.thread = null;
  assert.deepEqual(validateTraceDataObject(data), []);
});

test('validateTraceDataObject rejects a cyclic CDT', () => {
  const data = minimalData();
  data.scenarios[0].initialState.cdt = {
    nodes: [{ id: 'cap.root' }, { id: 'cap.app' }],
    edges: [['cap.root', 'cap.app'], ['cap.app', 'cap.root']]
  };
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('cycle')), 'cyclic CDT is rejected');
});

test('validateTraceDataObject accepts an acyclic CDT', () => {
  const data = minimalData();
  data.scenarios[0].initialState.cdt = {
    nodes: [{ id: 'cap.root' }, { id: 'cap.app' }, { id: 'cap.log' }],
    edges: [['cap.root', 'cap.app'], ['cap.root', 'cap.log']]
  };
  assert.deepEqual(validateTraceDataObject(data), []);
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

/* ── Capability derivation tree ops ─────────────────────────── */

test('cdtRemove prunes a node and all its descendants', () => {
  const state = { current: { thread: null }, threads: [], endpoints: [], notifications: [], runQueue: {}, cdt: { nodes: [{ id: 'root' }], edges: [] } };
  applyOp(state, { op: 'cdtInsert', node: { id: 'a' }, parent: 'root' });
  applyOp(state, { op: 'cdtInsert', node: { id: 'b' }, parent: 'a' });
  applyOp(state, { op: 'cdtInsert', node: { id: 'c' }, parent: 'root' });
  applyOp(state, { op: 'cdtRemove', node: 'a' });
  assert.deepEqual(state.cdt.nodes.map((n) => n.id).sort(), ['c', 'root']);
  assert.deepEqual(state.cdt.edges, [['root', 'c']]);
});

test('cdtInsert is idempotent on the parent edge and throws on a dangling parent', () => {
  const state = { cdt: { nodes: [{ id: 'root' }], edges: [] } };
  applyOp(state, { op: 'cdtInsert', node: { id: 'a' }, parent: 'root' });
  applyOp(state, { op: 'cdtInsert', node: { id: 'a' }, parent: 'root' }); // repeat
  assert.equal(state.cdt.edges.length, 1);
  assert.throws(() => applyOp(state, { op: 'cdtInsert', node: { id: 'x' }, parent: 'ghost' }), /unknown parent ghost/);
});

test('validateTraceDataObject flags a CDT edge referencing a missing node', () => {
  const data = minimalData();
  data.scenarios[0].initialState.cdt = { nodes: [{ id: 'root' }], edges: [['root', 'ghost']] };
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('cdt edge[0] child ghost is not a node')));
});

test('touchedEntities collects CDT node ids', () => {
  const touched = touchedEntities({ ops: [
    { op: 'cdtInsert', node: { id: 'child' }, parent: 'root' },
    { op: 'cdtRemove', node: 'old' },
    { op: 'cdtPatch', id: 'p', set: {} }
  ] });
  assert.deepEqual(touched.cdt.sort(), ['child', 'old', 'p', 'root'].sort());
});

/* ── Untyped memory ops ─────────────────────────────────────── */

test('untypedRetype advances the watermark and untypedReset reclaims it', () => {
  const state = { untyped: [{ id: 'ut', label: 'RAM', regionBase: 0, regionSize: 1024, watermark: 0, children: [] }] };
  applyOp(state, { op: 'untypedRetype', untyped: 'ut', child: { id: 'o1', type: 'TCB', size: 256 } });
  applyOp(state, { op: 'untypedRetype', untyped: 'ut', child: { id: 'o2', type: 'CNode', size: 128 } });
  assert.equal(state.untyped[0].watermark, 384);
  assert.equal(state.untyped[0].children.length, 2);
  applyOp(state, { op: 'untypedReset', untyped: 'ut' });
  assert.equal(state.untyped[0].watermark, 0);
  assert.deepEqual(state.untyped[0].children, []);
  assert.throws(() => applyOp(state, { op: 'untypedReset', untyped: 'ghost' }), /unknown untyped ghost/);
});

test('untypedRetype throws on an unknown region', () => {
  const state = { untyped: [] };
  assert.throws(() => applyOp(state, { op: 'untypedRetype', untyped: 'ghost', child: { id: 'x', size: 1 } }), /unknown untyped ghost/);
});

test('validateTraceDataObject flags an untyped watermark exceeding its region', () => {
  const data = minimalData();
  data.scenarios[0].initialState.untyped = [{ id: 'ut', regionSize: 100, watermark: 200, children: [] }];
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('watermark 200 exceeds region size 100')));
});

test('the retired ops are rejected: the kernel has no untypedRevoke, policy edits or services', () => {
  for (const op of ['untypedRevoke', 'ifPolicyAdd', 'ifPolicyRemove', 'servicePatch']) {
    const data = minimalData();
    data.scenarios[0].steps[1].delta.ops.push({ op });
    assert.ok(validateTraceDataObject(data).some((m) => m.includes(op)), op);
  }
});

/* ── Capability revocation ──────────────────────────────────── */

test('cdtRevoke destroys the derivations and keeps the revoked capability', () => {
  const state = {
    cdt: {
      nodes: [{ id: 'root' }, { id: 'mid' }, { id: 'leaf' }, { id: 'other' }],
      edges: [['root', 'mid'], ['mid', 'leaf'], ['root', 'other']]
    }
  };
  applyOp(state, { op: 'cdtRevoke', node: 'mid' });
  assert.deepEqual(state.cdt.nodes.map((n) => n.id), ['root', 'mid', 'other']);
  assert.deepEqual(state.cdt.edges, [['root', 'mid'], ['root', 'other']]);
  assert.throws(() => applyOp(state, { op: 'cdtRevoke', node: 'ghost' }), /unknown node ghost/);
});

/* ── Information-flow ops ───────────────────────────────────── */

test('auditAppend records a declassification; flowCheck is event-only; the policy never changes', () => {
  const state = { infoflow: { domains: [{ id: 'lo' }, { id: 'hi' }], policy: [['lo', 'hi']] } };
  applyOp(state, { op: 'flowCheck', from: 'hi', to: 'lo', allowed: false });
  applyOp(state, { op: 'auditAppend', entry: { from: 'hi', to: 'lo', label: 'release' } });
  assert.deepEqual(state.infoflow.policy, [['lo', 'hi']]);
  assert.deepEqual(state.infoflow.audit, [{ from: 'hi', to: 'lo', label: 'release' }]);
});

test('auditAppend throws on an unknown domain; validator flags dangling policy edges', () => {
  assert.throws(() => applyOp({ infoflow: { domains: [{ id: 'lo' }], policy: [] } }, { op: 'auditAppend', entry: { from: 'ghost', to: 'lo' } }), /two known domains/);
  assert.throws(() => applyOp({}, { op: 'auditAppend', entry: { from: 'a', to: 'b' } }), /no infoflow state/);
  const data = minimalData();
  data.scenarios[0].initialState.infoflow = { domains: [{ id: 'lo' }], policy: [['lo', 'ghost']] };
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('infoflow policy[0] to ghost is not a domain')));
});

/* ── Grounding (trace-anchors) ──────────────────────────────── */

const DEMO_SOURCES = {
  'SeLe4n/Kernel/Demo.lean': [
    '/-- `def send` in a doc comment is not a declaration. -/',
    'namespace Demo',
    'def entry : Nat := 0',
    '',
    'def lookup : Nat := 1',
    'theorem p1_thm : True := trivial',
    'def inv1 : Prop := True',
    'theorem send_preserves_inv1 : True := trivial',
    'def send : Nat := 2',
    'end Demo'
  ].join('\n'),
  'SeLe4n/Model/Object/Types.lean': 'inductive SyscallId where\n  | send\n  | receive\n  deriving Repr\n',
  'SeLe4n/Model/KernelError.lean': 'inductive KernelError where\n  | illegalAuthority\n  | invalidCapability\n  deriving Repr\n',
  'SeLe4n/Kernel/API.lean': 'def syscallRequiredRight : SyscallId → AccessRight\n  | .send => .write\n  | .receive => .read\n\ndef other := 0\n'
};
const readDemo = (path) => DEMO_SOURCES[path];

test('collectTraceRefs finds every reference: catalog theorems, predicates, step refs and path stages', () => {
  const names = collectTraceRefs(minimalData()).map(({ ref }) => ref.name).sort();
  assert.deepEqual(names, ['entry', 'inv1', 'lookup', 'p1_thm', 'send', 'send', 'send_preserves_inv1'].sort());
});

test('anchorTraceRefs stamps path and line, skips comments, and reports what it cannot place', () => {
  const data = minimalData();
  assert.deepEqual(anchorTraceRefs(data, readDemo), []);
  const send = data.scenarios[0].steps[1].sourceRefs[0];
  assert.equal(send.path, 'SeLe4n/Kernel/Demo.lean');
  assert.equal(send.line, 9);
  assert.equal(data.propertyCatalog[0].theorems[0].line, 6);

  const missing = minimalData();
  missing.scenarios[0].steps[1].sourceRefs = [ref('gone'), ref('x', 'SeLe4n.Nowhere')];
  const unresolved = anchorTraceRefs(missing, readDemo);
  assert.equal(unresolved.length, 2);
  assert.match(unresolved[0], /gone in SeLe4n\.Kernel\.Demo/);
  assert.match(unresolved[1], /no such file/);
  assert.equal(missing.scenarios[0].steps[1].sourceRefs[0].line, undefined);
});

test('requiredRightTable reads syscallRequiredRight arms and stops at the next declaration', () => {
  assert.deepEqual(requiredRightTable(DEMO_SOURCES['SeLe4n/Kernel/API.lean']), { send: 'write', receive: 'read' });
  assert.equal(requiredRightTable('def unrelated := 0'), undefined);
});

test('checkTraceKernelFacts rejects an unknown syscall, a wrong required right and an unknown error', () => {
  assert.deepEqual(checkTraceKernelFacts(minimalData(), readDemo), []);
  const data = minimalData();
  data.scenarios[0].steps[1].syscall.requiredRight = 'grant';
  data.scenarios[0].steps.push({ index: 2, kind: 'syscall', syscall: { id: 'declassifyStore', requiredRight: 'write' }, outcome: { status: 'error', error: 'noSuchError' } });
  const issues = checkTraceKernelFacts(data, readDemo);
  assert.ok(issues.some((m) => m.includes('send requires "write"')));
  assert.ok(issues.some((m) => m.includes('"declassifyStore" is not a SyscallId constructor')));
  assert.ok(issues.some((m) => m.includes('"noSuchError" is not a KernelError constructor')));
  assert.ok(checkTraceKernelFacts(minimalData(), () => undefined).length >= 3);
});


/* ── VSpace / W^X ops ───────────────────────────────────────── */

test('vspaceMap/Unmap mutate mappings; vspaceReject is event-only', () => {
  const state = { vspace: [{ id: 'vs', asid: 1, mappings: [] }] };
  applyOp(state, { op: 'vspaceMap', vspace: 'vs', mapping: { vaddr: '0x1000', paddr: '0x80000', perms: 'rx', wx: false } });
  applyOp(state, { op: 'vspaceReject', vspace: 'vs', mapping: { vaddr: '0x3000', perms: 'rwx', wx: true } });
  assert.equal(state.vspace[0].mappings.length, 1); // a rejected map is never stored
  applyOp(state, { op: 'vspaceUnmap', vspace: 'vs', vaddr: '0x1000' });
  assert.equal(state.vspace[0].mappings.length, 0);
});

test('validateTraceDataObject flags a stored W^X violation and duplicate ASIDs', () => {
  const data = minimalData();
  data.scenarios[0].initialState.vspace = [{ id: 'a', asid: 1, mappings: [{ vaddr: '0x1', perms: 'rwx', wx: true }] }, { id: 'b', asid: 1, mappings: [] }];
  const errors = validateTraceDataObject(data);
  assert.ok(errors.some((m) => m.includes('violates W^X')));
  assert.ok(errors.some((m) => m.includes('reuses ASID 1')));
});

test('vspaceMap caches a TLB entry; vspaceUnmap shoots it down; validator flags stale TLB', () => {
  const state = { vspace: [{ id: 'vs', asid: 1, mappings: [], tlb: [] }] };
  applyOp(state, { op: 'vspaceMap', vspace: 'vs', mapping: { vaddr: '0x1000', paddr: '0x80000', perms: 'rx', wx: false } });
  assert.deepEqual(state.vspace[0].tlb, ['0x1000']);
  applyOp(state, { op: 'vspaceUnmap', vspace: 'vs', vaddr: '0x1000' });
  assert.deepEqual(state.vspace[0].tlb, []);
  const data = minimalData();
  data.scenarios[0].initialState.vspace = [{ id: 'vs', asid: 1, mappings: [], tlb: ['0xdead'] }];
  assert.ok(validateTraceDataObject(data).some((m) => m.includes('stale (missing shootdown)')));
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
