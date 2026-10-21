/**
 * Trace schema v3: the shared engine (assets/js/trace-engine.js), the
 * validator that re-runs every gate a step claims, and the grounding helpers.
 *
 * Most validator tests start from the bundled document and break one thing,
 * so each test says which lie the validator catches on real data rather than
 * on a toy that might not exercise the check at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  validateTraceDataObject,
  reconstructState,
  scenarioStates,
  applyOp,
  cloneState,
  engine,
  SCENES
} from './trace-analysis.mjs';
import {
  anchorTraceRefs,
  checkTraceKernelFacts,
  collectTraceRefs,
  requiredRightTable,
  syscallNumberTable
} from './trace-anchors.mjs';

const BUNDLED = JSON.parse(readFileSync(new URL('../../data/execution-traces.json', import.meta.url), 'utf8'));
const bundled = () => structuredClone(BUNDLED);
const scenario = (data, id) => data.scenarios.find((s) => s.id === id);
const step = (data, id, i) => scenario(data, id).steps[i];
const errorsOf = (data) => validateTraceDataObject(data);
const hasError = (data, fragment) => {
  const errors = errorsOf(data);
  assert.ok(errors.some((m) => m.includes(fragment)), `expected an error containing "${fragment}", got:\n${errors.join('\n') || '(none)'}`);
};

/* ── The bundled document ───────────────────────────────────── */

test('the bundled traces are schema v3, valid, grounded and fold cleanly', () => {
  assert.equal(BUNDLED.schemaVersion, 3);
  assert.equal(engine.SCHEMA_VERSION, 3);
  assert.deepEqual(errorsOf(bundled()), []);
  assert.match(BUNDLED.sourceRef, /^[0-9a-f]{40}$/);
  for (const sc of BUNDLED.scenarios) {
    assert.equal(scenarioStates(sc).length, sc.steps.length, `${sc.id} folds one state per step`);
    if (sc.focus !== undefined) assert.ok(SCENES.includes(sc.focus));
  }
});

test('every syscall step carries the registers the kernel decodes', () => {
  for (const sc of BUNDLED.scenarios) for (const st of sc.steps) {
    if (st.kind !== 'syscall') continue;
    assert.ok(Number.isInteger(st.syscall.number), `${sc.id}/${st.index} has an x7 value`);
    assert.ok(st.syscall.msgInfo && Number.isInteger(st.syscall.msgInfo.length), `${sc.id}/${st.index} has a msgInfo`);
    st.syscall.args.forEach((a, i) => assert.equal(a.reg, engine.REGISTERS.msgRegs[i]));
  }
});

/* ── Document shape ─────────────────────────────────────────── */

test('the validator rejects another schema version and an unknown source', () => {
  const data = bundled();
  data.schemaVersion = 2;
  data.source = 'live';
  hasError(data, 'schemaVersion must be 3');
  hasError(data, 'source must be one of kernel, fixture');
});

test('step indices are sequential and the first step is the boot state', () => {
  const data = bundled();
  scenario(data, 'ipc-call-reply').steps[2].index = 7;
  hasError(data, 'steps[2].index must equal 2');
  const boot = bundled();
  step(boot, 'ipc-call-reply', 0).delta.ops.push({ op: 'note', text: 'x' });
  hasError(boot, 'the boot step changes nothing');
});

test('ops the kernel has no path for are rejected by name', () => {
  for (const retired of ['untypedRevoke', 'ifPolicyAdd', 'ifPolicyRemove', 'servicePatch', 'cdtRevoke']) {
    const data = bundled();
    step(data, 'ipc-call-reply', 1).delta.ops.push({ op: retired });
    hasError(data, `.op must be one of`);
  }
});

test('catalogue references must resolve', () => {
  const data = bundled();
  step(data, 'ipc-call-reply', 1).guarantees.push('no-such-property');
  step(data, 'ipc-call-reply', 1).invariants.preserved.push('noSuchInvariant');
  hasError(data, 'references unknown property no-such-property');
  hasError(data, 'references unknown invariant noSuchInvariant');
  const failed = bundled();
  step(failed, 'ipc-call-reply', 1).invariants.failed = ['runQueueUnique'];
  hasError(failed, 'a kernel trace never records a failing invariant');
});

/* ── Refusals ───────────────────────────────────────────────── */

test('a refused step may not change state: an error returns no successor state', () => {
  const data = bundled();
  const refused = step(data, 'capability-gate', 1);
  assert.equal(refused.outcome.status, 'error');
  refused.delta.ops.push({ op: 'threadPatch', id: refused.actor, set: { priority: 1 } });
  hasError(data, '(threadPatch) changes state, but the step was refused');
});

test('a syscall path names exactly the stage that refused, and skips the rest', () => {
  const data = bundled();
  const refused = step(data, 'capability-gate', 1);
  const failAt = refused.path.findIndex((s) => s.result === 'fail');
  refused.path[failAt + 1].result = 'pass';
  hasError(data, 'follows the refusing stage, so it must be "skip"');
  const wrongError = bundled();
  step(wrongError, 'capability-gate', 1).path[failAt].error = 'flowDenied';
  hasError(wrongError, 'error must match the step\'s outcome error');
});

/* ── Gates recomputed from the state ────────────────────────── */

test('a rights stage that disagrees with the capability is caught', () => {
  const data = bundled();
  const st = step(data, 'capability-gate', 1); // send with a read-only cap → illegalAuthority
  const rights = st.path.find((s) => s.stage === 'rights');
  assert.equal(rights.result, 'fail');
  scenario(data, 'capability-gate').initialState.cnodes[0].slots['1'].rights.push('write');
  hasError(data, 'carries write, but the rights stage says fail');
});

test('a lookup the CSpace would refuse is caught (guard bits)', () => {
  const data = bundled();
  // 0x81 sets a guard bit the CNode's guard 0000 does not have.
  step(data, 'ipc-call-reply', 3).syscall.capPtr = 0x81;
  hasError(data, 'does not resolve in client\'s CSpace (invalidCapability, guard)');
});

test('a dispatch the selection rule would not make is caught', () => {
  const data = bundled();
  const st = scenario(data, 'scheduler-buckets').steps.find((s) => s.delta.ops.some((o) => o.op === 'dispatch' && o.thread));
  const op = st.delta.ops.find((o) => o.op === 'dispatch');
  const other = scenario(data, 'scheduler-buckets').initialState.threads.find((t) => t.id !== op.thread).id;
  op.thread = other;
  hasError(data, 'but the selection rule picks');
});

test('a flow check that disagrees with the lattice is caught', () => {
  const data = bundled();
  const st = scenario(data, 'information-flow').steps.find((s) => s.delta.ops.some((o) => o.op === 'flowCheck'));
  const fc = st.delta.ops.find((o) => o.op === 'flowCheck');
  fc.allowed = !fc.allowed;
  hasError(data, 'securityFlowsTo');
});

test('a derived capability may not gain a right its parent lacks (capAttenuates)', () => {
  const data = bundled();
  const st = scenario(data, 'capability-derivation').steps.find((s) => s.delta.ops.some((o) => o.op === 'capInsert' && o.cap && o.cap.derivation === 'copy'));
  const ins = st.delta.ops.find((o) => o.op === 'capInsert');
  ins.cap.rights = ['read', 'write', 'grant'];
  hasError(data, '(capAttenuates)');
});

test('only a ready thread may be put on a run queue', () => {
  const data = bundled();
  const sc = scenario(data, 'ipc-call-reply');
  const blocked = sc.initialState.threads.find((t) => t.ipc.state !== 'ready') ||
    reconstructState(sc, 1).threads.find((t) => t.ipc.state !== 'ready');
  assert.ok(blocked, 'the scenario blocks a thread');
  const at = sc.steps.findIndex((s, i) => i > 0 && reconstructState(sc, i - 1).threads.find((t) => t.id === blocked.id).ipc.state !== 'ready');
  sc.steps[at].delta.ops.unshift({ op: 'enqueue', thread: blocked.id, core: 0, prio: blocked.priority });
  hasError(data, `enqueue of ${blocked.id}`);
});

/* ── checkState: the executable mirrors the sandbox breaks ───── */

const base = () => cloneState(scenario(BUNDLED, 'ipc-call-reply').initialState);
const violations = (s) => engine.checkState(s).map((v) => v.id);

test('checkState accepts every bundled state', () => {
  for (const sc of BUNDLED.scenarios) {
    for (const s of scenarioStates(sc)) assert.deepEqual(engine.checkState(s), [], sc.id);
  }
});

test('checkState catches a doubled or running run-queue entry', () => {
  const s = base();
  const cur = s.cores[0].current;
  s.runQueues['0'].push({ thread: cur, prio: 1 });
  assert.ok(violations(s).includes('queueCurrentConsistent'));
  const d = base();
  const t = d.threads.find((x) => x.id !== d.cores[0].current && x.ipc.state === 'ready') || d.threads[0];
  d.runQueues['0'].push({ thread: t.id, prio: 1 }, { thread: t.id, prio: 1 });
  assert.ok(violations(d).includes('runQueueUnique'));
});

test('checkState catches a blocked thread on a run queue', () => {
  const s = reconstructState(scenario(BUNDLED, 'ipc-call-reply'), 1);
  const blocked = s.threads.find((t) => t.ipc.state !== 'ready');
  s.runQueues['0'].push({ thread: blocked.id, prio: blocked.priority });
  assert.ok(violations(s).includes('blockedNotRunnable'));
});

test('checkState catches W+X, a stale TLB entry and a reused ASID', () => {
  const s = cloneState(scenario(BUNDLED, 'vspace-wx').initialState);
  s.vspaces[0].mappings = [{ vaddr: '0x1000', frame: 'f', perms: 'rwx' }];
  s.vspaces[0].tlb = ['0x2000'];
  s.vspaces.push({ ...structuredClone(s.vspaces[0]), id: 'vs.twin', mappings: [], tlb: [] });
  const ids = violations(s);
  for (const id of ['wxExclusive', 'tlbConsistent', 'vspaceAsidUnique']) assert.ok(ids.includes(id), id);
});

test('checkState catches an overspent budget', () => {
  const s = cloneState(scenario(BUNDLED, 'budget-edf').initialState);
  s.schedContexts[0].remaining = s.schedContexts[0].budget + 1;
  assert.ok(violations(s).includes('budgetWithinBounds'));
});

test('checkState catches overlapping children and a child above the watermark', () => {
  const s = reconstructState(scenario(BUNDLED, 'untyped-retype'), 2);
  const u = s.untyped.find((x) => x.children.length);
  const ch = u.children[0];
  u.children.push({ id: 'dup', kind: 'frame', offset: ch.offset, size: ch.size });
  assert.ok(violations(s).includes('untypedNonOverlap'));
  u.watermark = 0;
  assert.ok(violations(s).includes('untypedWatermark'));
});

test('checkState catches a derivation link to an empty slot and a cycle', () => {
  const s = cloneState(scenario(BUNDLED, 'capability-derivation').initialState);
  s.cdt = { 'cn.sup/1': ['cn.sup/9'] };
  assert.ok(violations(s).includes('cdtLinksAgree'));
  const c = cloneState(scenario(BUNDLED, 'capability-derivation').initialState);
  c.cdt = { 'cn.sup/0': ['cn.sup/1'], 'cn.sup/1': ['cn.sup/0'] };
  assert.ok(violations(c).includes('cdtAcyclic'));
});

test('every check checkState can report has a catalogue entry', () => {
  const ids = new Set(BUNDLED.invariantCatalog.map((i) => i.id));
  const reported = ['runQueueUnique', 'currentThreadValid', 'queueCurrentConsistent', 'blockedNotRunnable', 'dualQueue', 'queueNoDup',
    'notificationWaiters', 'replyWaiters', 'budgetWithinBounds', 'cdtLinksAgree', 'cdtAcyclic', 'untypedWatermark', 'untypedNonOverlap',
    'vspaceAsidUnique', 'wxExclusive', 'tlbConsistent'];
  const source = readFileSync(new URL('../../assets/js/trace-engine.js', import.meta.url), 'utf8');
  const named = [...source.slice(source.indexOf('function checkState')).matchAll(/fail\("([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(named)].sort(), [...reported].sort());
  for (const id of reported) assert.ok(ids.has(id), `${id} is in the invariant catalogue`);
});

/* ── Engine semantics ───────────────────────────────────────── */

function schedState(entries, threads, scs = []) {
  return {
    cores: [{ id: 0, current: null, domain: 0 }],
    threads: threads.map((t) => ({ domain: 0, ipc: { state: 'ready' }, ...t })),
    runQueues: { 0: entries },
    schedContexts: scs
  };
}

test('selectOnCore: the highest bucket first, then the earliest deadline, then FIFO', () => {
  const s = schedState(
    [{ thread: 'a', prio: 10 }, { thread: 'b', prio: 50 }, { thread: 'c', prio: 50 }, { thread: 'd', prio: 50 }],
    [{ id: 'a', priority: 10 }, { id: 'b', priority: 50, deadline: 30 }, { id: 'c', priority: 50, deadline: 20 }, { id: 'd', priority: 50, deadline: 20 }]
  );
  const pick = engine.selectOnCore(s, 0);
  assert.equal(pick.thread, 'c');
  assert.equal(pick.maxPrio, 50);
  assert.deepEqual(pick.candidates.map((r) => r.reason), ['first', 'deadline', 'fifo']);
});

test('selectOnCore: a thread without budget or in another domain is ineligible; the scan falls back', () => {
  const s = schedState(
    [{ thread: 'x', prio: 90 }, { thread: 'y', prio: 90 }, { thread: 'z', prio: 5 }],
    [{ id: 'x', priority: 90, sc: 'sc.x' }, { id: 'y', priority: 90, domain: 1 }, { id: 'z', priority: 5 }],
    [{ id: 'sc.x', budget: 3, remaining: 0, period: 10, deadline: 10 }]
  );
  const pick = engine.selectOnCore(s, 0);
  assert.equal(pick.thread, 'z');
  assert.equal(pick.fallback, true);
  assert.deepEqual(pick.candidates.slice(0, 2).map((r) => r.reason), ['budget', 'domain']);
});

test('resolveCap walks guard then radix bits and names why a lookup fails', () => {
  const s = cloneState(scenario(BUNDLED, 'capability-gate').initialState);
  const actor = step(BUNDLED, 'capability-gate', 1).actor;
  const ok = engine.resolveCap(s, actor, 1);
  assert.equal(ok.slot.endsWith('/1'), true);
  assert.equal(ok.levels[0].guardOk, true);
  assert.equal(engine.resolveCap(s, actor, 0x80 | 1).reason, 'guard');
  assert.equal(engine.resolveCap(s, actor, 0x0f).reason, 'empty');
});

test('securityFlowsTo: confidentiality only rises, integrity only falls', () => {
  const L = (conf, integ) => ({ conf, integ });
  assert.equal(engine.flowsTo(L('low', 'trusted'), L('high', 'untrusted')), true);
  assert.equal(engine.flowsTo(L('high', 'trusted'), L('low', 'trusted')), false);
  assert.equal(engine.flowsTo(L('low', 'untrusted'), L('low', 'trusted')), false);
  assert.equal(engine.flowsTo(L('high', 'untrusted'), L('high', 'untrusted')), true);
});

test('msgInfoWord packs length | extraCaps << 7 | label << 9', () => {
  assert.equal(engine.msgInfoWord({ length: 2, extraCaps: 1, label: 7 }), 2 + 128 + 7 * 512);
  assert.equal(engine.msgInfoWord({}), 0);
});

test('capDelete splices children up to the parent; capRevoke keeps the capability and empties its subtree', () => {
  const s = cloneState(scenario(BUNDLED, 'capability-derivation').initialState);
  const cap = (rights) => ({ kind: 'endpoint', target: 'ep.log', rights });
  applyOp(s, { op: 'capInsert', slot: 'cn.sup/4', parent: 'cn.sup/1', cap: cap(['write']) });
  applyOp(s, { op: 'capInsert', slot: 'cn.sup/5', parent: 'cn.sup/4', cap: cap(['write']) });
  applyOp(s, { op: 'capInsert', slot: 'cn.sup/6', parent: 'cn.sup/4', cap: cap(['write']) });
  applyOp(s, { op: 'capDelete', slot: 'cn.sup/4' });
  assert.deepEqual([...engine.cdtChildren(s, 'cn.sup/1')].sort(), ['cn.sup/5', 'cn.sup/6']);
  assert.deepEqual(engine.revokeOrder(s, 'cn.sup/1').length, 2);
  applyOp(s, { op: 'capRevoke', slot: 'cn.sup/1' });
  assert.ok(engine.capAt(s, 'cn.sup/1'), 'the revoked capability stays');
  assert.equal(engine.capAt(s, 'cn.sup/5'), null);
  assert.deepEqual(engine.cdtChildren(s, 'cn.sup/1'), []);
  assert.throws(() => applyOp(s, { op: 'capInsert', slot: 'cn.sup/1', cap: cap([]) }), /occupied/);
});

test('untypedCarve allocates at the watermark and refuses an overrun; untypedReset reclaims', () => {
  const s = cloneState(scenario(BUNDLED, 'untyped-retype').initialState);
  const u = s.untyped[0];
  applyOp(s, { op: 'untypedCarve', untyped: u.id, child: { id: 'k1', kind: 'frame', size: 4096 } });
  assert.equal(u.children[0].offset, 0);
  assert.equal(u.watermark, 4096);
  assert.throws(() => applyOp(s, { op: 'untypedCarve', untyped: u.id, child: { id: 'big', kind: 'untyped', size: u.size } }), /untypedRegionExhausted/);
  applyOp(s, { op: 'untypedReset', untyped: u.id });
  assert.equal(u.watermark, 0);
  assert.deepEqual(u.children, []);
});

test('vspaceMap caches when asked; vspaceUnmap shoots the entry down; vspaceReject is an event', () => {
  const s = cloneState(scenario(BUNDLED, 'vspace-wx').initialState);
  const v = s.vspaces[0].id;
  const before = (s.vspaces[0].mappings || []).length;
  applyOp(s, { op: 'vspaceMap', vspace: v, mapping: { vaddr: '0x9000', frame: 'f', perms: 'r--' }, cache: true });
  assert.ok(s.vspaces[0].tlb.includes('0x9000'));
  applyOp(s, { op: 'vspaceReject', vspace: v, vaddr: '0xa000', perms: 'rwx' });
  assert.equal(s.vspaces[0].mappings.length, before + 1);
  applyOp(s, { op: 'vspaceUnmap', vspace: v, vaddr: '0x9000' });
  assert.ok(!s.vspaces[0].tlb.includes('0x9000'));
  assert.ok(engine.EVENT_OPS.includes('vspaceReject'));
});

test('ops name what they touch, so the page can mark it', () => {
  const t = engine.touched([
    { op: 'dispatch', core: 0, thread: 'a' },
    { op: 'capInsert', slot: 'cn/1', parent: 'cn/0' },
    { op: 'vspaceMap', vspace: 'vs', mapping: { vaddr: '0x1' } },
    { op: 'auditAppend', entry: {} }
  ]);
  for (const id of ['a', 'core:0', 'cn/1', 'cn/0', 'vs', 'vs@0x1', 'audit']) assert.ok(t[id], id);
});

test('applyOp throws on dangling references and unknown ops', () => {
  const s = base();
  assert.throws(() => applyOp(s, { op: 'dispatch', core: 0, thread: 'ghost' }));
  assert.throws(() => applyOp(s, { op: 'epEnqueue', endpoint: 'ghost', thread: s.threads[0].id, queue: 'send' }));
  assert.throws(() => applyOp(s, { op: 'teleport' }), /unknown op/);
});

/* ── Grounding (trace-anchors) ──────────────────────────────── */

const ref = (name, module = 'SeLe4n.Kernel.Demo') => ({ name, module });
function anchorDoc() {
  return {
    propertyCatalog: [{ id: 'p1', theorems: [ref('p1_thm')] }],
    invariantCatalog: [{ id: 'inv1', predicate: ref('inv1'), preservedBy: [ref('send_preserves_inv1')] }],
    scenarios: [{
      id: 'demo',
      steps: [
        { index: 0, kind: 'boot', outcome: { status: 'ok' } },
        {
          index: 1, kind: 'syscall', sourceRefs: [ref('send')],
          syscall: { id: 'send', number: 0, requiredRight: 'write' },
          path: [{ stage: 'entry', ref: ref('entry') }, { stage: 'lookup', ref: ref('lookup') }, { stage: 'operation', ref: ref('send') }],
          outcome: { status: 'error', error: 'illegalAuthority' }
        }
      ]
    }]
  };
}

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
  'SeLe4n/Model/Object/Types.lean': [
    'inductive SyscallId where', '  | send', '  | receive', '  deriving Repr', '',
    'namespace SyscallId', 'def toNat : SyscallId → Nat', '  | .send => 0', '  | .receive => 1', '', 'end SyscallId'
  ].join('\n'),
  'SeLe4n/Model/KernelError.lean': 'inductive KernelError where\n  | illegalAuthority\n  | invalidCapability\n  deriving Repr\n',
  'SeLe4n/Kernel/API.lean': 'def syscallRequiredRight : SyscallId → AccessRight\n  | .send => .write\n  | .receive => .read\n\ndef other := 0\n'
};
const readDemo = (path) => DEMO_SOURCES[path];

test('collectTraceRefs finds every reference: catalogue theorems, predicates, step refs and path stages', () => {
  const names = collectTraceRefs(anchorDoc()).map(({ ref: r }) => r.name).sort();
  assert.deepEqual(names, ['entry', 'inv1', 'lookup', 'p1_thm', 'send', 'send', 'send_preserves_inv1'].sort());
  assert.ok(collectTraceRefs(BUNDLED).length > 100, 'the bundle cites its declarations');
});

test('anchorTraceRefs stamps path and line, skips comments, and reports what it cannot place', () => {
  const data = anchorDoc();
  assert.deepEqual(anchorTraceRefs(data, readDemo), []);
  const send = data.scenarios[0].steps[1].sourceRefs[0];
  assert.equal(send.path, 'SeLe4n/Kernel/Demo.lean');
  assert.equal(send.line, 9);
  assert.equal(data.propertyCatalog[0].theorems[0].line, 6);

  const missing = anchorDoc();
  missing.scenarios[0].steps[1].sourceRefs = [ref('gone'), ref('x', 'SeLe4n.Nowhere')];
  const unresolved = anchorTraceRefs(missing, readDemo);
  assert.equal(unresolved.length, 2);
  assert.match(unresolved[0], /gone in SeLe4n\.Kernel\.Demo/);
  assert.match(unresolved[1], /no such file/);
  assert.equal(missing.scenarios[0].steps[1].sourceRefs[0].line, undefined);
});

test('requiredRightTable and syscallNumberTable read the kernel\'s own match arms', () => {
  assert.deepEqual(requiredRightTable(DEMO_SOURCES['SeLe4n/Kernel/API.lean']), { send: 'write', receive: 'read' });
  assert.equal(requiredRightTable('def unrelated := 0'), undefined);
  assert.deepEqual(syscallNumberTable(DEMO_SOURCES['SeLe4n/Model/Object/Types.lean']), { send: 0, receive: 1 });
  assert.equal(syscallNumberTable('def unrelated := 0'), undefined);
});

test('checkTraceKernelFacts rejects an unknown syscall, a wrong x7, a wrong right and an unknown error', () => {
  assert.deepEqual(checkTraceKernelFacts(anchorDoc(), readDemo), []);
  const data = anchorDoc();
  data.scenarios[0].steps[1].syscall.requiredRight = 'grant';
  data.scenarios[0].steps[1].syscall.number = 5;
  data.scenarios[0].steps.push({ index: 2, kind: 'syscall', syscall: { id: 'declassifyStore', requiredRight: 'write' }, outcome: { status: 'error', error: 'noSuchError' } });
  const issues = checkTraceKernelFacts(data, readDemo);
  assert.ok(issues.some((m) => m.includes('send requires "write"')));
  assert.ok(issues.some((m) => m.includes('x7 = 5, but SyscallId.toNat .send = 0')));
  assert.ok(issues.some((m) => m.includes('"declassifyStore" is not a SyscallId constructor')));
  assert.ok(issues.some((m) => m.includes('"noSuchError" is not a KernelError constructor')));
  assert.ok(checkTraceKernelFacts(anchorDoc(), () => undefined).length >= 3);
});
