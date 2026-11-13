/**
 * Trace schema v4: the shared engine (assets/js/trace-engine.js), the
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
  checkEngineTables,
  checkTraceKernelFacts,
  collectTraceRefs,
  matchArmTable,
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

test('the bundled traces are schema v4, valid, grounded and fold cleanly', () => {
  assert.equal(BUNDLED.schemaVersion, 4);
  assert.equal(engine.SCHEMA_VERSION, 4);
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
  data.schemaVersion = 3;
  data.source = 'live';
  hasError(data, 'schemaVersion must be 4');
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
  for (const retired of ['untypedRevoke', 'ifPolicyAdd', 'ifPolicyRemove', 'servicePatch', 'cdtRevoke', 'scPatch']) {
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
  // The free index is the capability's: with it at 0, every child is above it.
  s.cnodes[0].slots['1'].freeIndex = 0;
  assert.ok(violations(s).includes('untypedWatermark'));
  s.cnodes[0].slots['1'].freeIndex = u.size + 1;
  assert.ok(engine.checkState(s).some((v) => v.id === 'untypedWatermark' && /past/.test(v.message)));
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
    'notificationWaiters', 'replyWaiters', 'budgetWithinBounds', 'refillsSound', 'cdtLinksAgree', 'cdtAcyclic', 'untypedWatermark', 'untypedNonOverlap',
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

test('securityFlowsTo: confidentiality only rises, and only a destination at least as trusted is reached', () => {
  // The kernel's own theorems, `InformationFlow/Policy.lean`: public →
  // kernelTrusted is allowed, kernelTrusted → public is not, and lowTrusted →
  // highUntrusted is denied on integrity alone. The engine had the integrity
  // order backwards (Biba's), which the fixture never noticed because every
  // label it used was untrusted.
  const L = (conf, integ) => ({ conf, integ });
  assert.equal(engine.flowsTo(L('low', 'untrusted'), L('high', 'trusted')), true);
  assert.equal(engine.flowsTo(L('low', 'untrusted'), L('low', 'trusted')), true);
  assert.equal(engine.flowsTo(L('low', 'trusted'), L('high', 'untrusted')), false);
  assert.equal(engine.flowsTo(L('high', 'trusted'), L('low', 'untrusted')), false);
  assert.equal(engine.flowsTo(L('high', 'trusted'), L('low', 'trusted')), false);
  assert.equal(engine.flowsTo(L('high', 'untrusted'), L('high', 'untrusted')), true);
});

test('msgInfoWord packs length | extraCaps << 7 | capsUnwrapped << 9 | label << 12', () => {
  assert.equal(engine.msgInfoWord({ length: 2, extraCaps: 1, label: 7 }), 2 + 128 + 7 * 4096);
  assert.equal(engine.msgInfoWord({ length: 1, capsUnwrapped: 5 }), 1 + 5 * 512);
  assert.equal(engine.msgInfoWord({}), 0);
  assert.equal(engine.MSG_LIMITS.label, 2 ** 41 - 1);
});

test('a missing right is an invalid capability on the IPC syscalls and illegal authority elsewhere', () => {
  for (const id of ['send', 'call', 'receive', 'replyRecv', 'notificationSignal', 'notificationWait', 'declassifySignal']) {
    assert.equal(engine.missingRightError(id), 'invalidCapability', id);
  }
  for (const id of ['cspaceMint', 'untypedRetype', 'vspaceMap', 'tcbSetAffinity', 'reply']) {
    assert.equal(engine.missingRightError(id), 'illegalAuthority', id);
  }
  // The validator holds a step to it: the fixture's refused send says so.
  const refused = step(BUNDLED, 'capability-gate', 1);
  assert.equal(refused.outcome.error, 'invalidCapability');
  const mutated = structuredClone(BUNDLED);
  const bad = scenario(mutated, 'capability-gate').steps[1];
  bad.outcome.error = 'illegalAuthority';
  bad.path.find((p) => p.stage === 'rights').error = 'illegalAuthority';
  assert.ok(validateTraceDataObject(mutated).some((e) => /syscallMissingRightError/.test(e)));
});

test('capDelete splices children up to the parent; capRevoke keeps the capability and empties its subtree', () => {
  const s = cloneState(scenario(BUNDLED, 'capability-derivation').initialState);
  const cap = (rights) => ({ kind: 'endpoint', target: 'ep.log', rights });
  applyOp(s, { op: 'capInsert', slot: 'cn.sup/4', parent: 'cn.sup/1', cap: cap(['write']) });
  applyOp(s, { op: 'capInsert', slot: 'cn.sup/5', parent: 'cn.sup/4', cap: cap(['write']) });
  applyOp(s, { op: 'capInsert', slot: 'cn.sup/6', parent: 'cn.sup/4', cap: cap(['write']) });
  applyOp(s, { op: 'capDelete', slot: 'cn.sup/4' });
  // The children take the deleted slot's place in their own order
  // (`linkSpliceNode`): 6 was linked last, so it is first.
  assert.deepEqual(engine.cdtChildren(s, 'cn.sup/1'), ['cn.sup/6', 'cn.sup/5']);
  assert.deepEqual(engine.revokeOrder(s, 'cn.sup/1').length, 2);
  applyOp(s, { op: 'capRevoke', slot: 'cn.sup/1' });
  assert.ok(engine.capAt(s, 'cn.sup/1'), 'the revoked capability stays');
  assert.equal(engine.capAt(s, 'cn.sup/5'), null);
  assert.deepEqual(engine.cdtChildren(s, 'cn.sup/1'), []);
  assert.throws(() => applyOp(s, { op: 'capInsert', slot: 'cn.sup/1', cap: cap([]) }), /occupied/);
});

test('untypedCarve carves at the capability\'s free index, aligned; a reset waits for the revoke', () => {
  const s = cloneState(scenario(BUNDLED, 'untyped-retype').initialState);
  const u = s.untyped[0];
  const via = 'cn.mgr/1';
  const frameCap = (target) => ({ kind: 'frame', target, rights: ['read', 'write', 'grant'], derivation: 'retype' });
  // The carve and the reset are invoked through a capability, and the free
  // index is that capability's: an op that names no slot is not a kernel step.
  assert.throws(() => applyOp(s, { op: 'untypedCarve', untyped: u.id, child: { id: 'k0', kind: 'frame', size: 4096 } }), /holds no capability/);
  applyOp(s, { op: 'untypedCarve', untyped: u.id, slot: via, child: { id: 'k1', kind: 'frame', size: 4096 } });
  applyOp(s, { op: 'capInsert', slot: 'cn.mgr/2', parent: via, cap: frameCap('k1') });
  const cap = s.cnodes[0].slots['1'];
  assert.equal(u.children[0].offset, 0);
  assert.equal(cap.freeIndex, 4096);
  // `alignedCarveIndex`: an 8 KiB untyped starts on a multiple of 8 KiB.
  applyOp(s, { op: 'untypedCarve', untyped: u.id, slot: via, child: { id: 'k2', kind: 'untyped', size: 8192 } });
  applyOp(s, { op: 'capInsert', slot: 'cn.mgr/3', parent: via, cap: { kind: 'untyped', target: 'k2', rights: ['retype'], derivation: 'retype' } });
  assert.equal(u.children[0].offset, 8192);
  assert.equal(cap.freeIndex, 16384);
  assert.throws(() => applyOp(s, { op: 'untypedCarve', untyped: u.id, slot: via, child: { id: 'big', kind: 'frame', size: 4096 } }), /untypedRegionExhausted/);
  // `untypedResetSlot` refuses while the slot has a derivation child.
  assert.throws(() => applyOp(s, { op: 'untypedReset', untyped: u.id, slot: via }), /revocationRequired/);
  // Revoking deletes the last capability to each carved object, which retires
  // it (`retireCarvedObject`); only then is the reset one write.
  applyOp(s, { op: 'capRevoke', slot: via });
  assert.deepEqual(u.children, []);
  assert.equal(cap.freeIndex, 16384, 'the revoke does not move the free index');
  applyOp(s, { op: 'untypedReset', untyped: u.id, slot: via });
  assert.equal(cap.freeIndex, 0);
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

test('matchArmTable reads multi-pattern arms that run over lines, and a wildcard', () => {
  const src = [
    '/-- | .fake => 9 -/',
    'def truncationMinimum : SyscallId → Nat',
    '  | .untypedRetype | .vspaceMap => 4',
    '  | .cspaceDelete | .cspaceRevoke',
    '  | .tcbSetAffinity => 1',
    '  | _ => 0',
    '',
    'def kind? : SyscallId → Option K',
    '  | .send | .receive => some .endpoint',
    '  | .yield => none'
  ].join('\n');
  assert.deepEqual(matchArmTable(src, 'truncationMinimum'), { untypedRetype: '4', vspaceMap: '4', cspaceDelete: '1', cspaceRevoke: '1', tcbSetAffinity: '1', _: '0' });
  assert.deepEqual(matchArmTable(src, 'kind?'), { send: 'endpoint', receive: 'endpoint', yield: 'none' });
  assert.equal(matchArmTable(src, 'kind'), undefined, 'a name is matched whole');
  assert.equal(matchArmTable(src, 'absent'), undefined);
});

test('checkEngineTables compares the engine\'s gate tables with the kernel\'s, entry for entry', () => {
  const read = (path) => ({
    'SeLe4n/Model/Object/Types.lean': 'inductive SyscallId where\n  | send\n  | cspaceMint\n  | reply\n  | yield\n  deriving Repr\n',
    'SeLe4n/Kernel/API.lean': [
      'def syscallObjectKind? : SyscallId → Option KernelObjectType',
      '  | .send => some .endpoint', '  | .cspaceMint => some .cnode', '  | .reply | .yield => none', '',
      'def syscallTargetAccepted (sid : SyscallId) (cap : Capability) : Bool :=',
      '  match cap.target with', '  | .object id =>', '      match syscallObjectKind? sid with',
      '      | some kind => objectKindIs st id kind', '      | none => sid == .declassify',
      '  | .replyCap _ => sid == .reply', '  | .irqControl _ => sid == .irqControlGet',
      '  | .irqHandler _ =>', '      sid == .irqHandlerAck || sid == .irqHandlerSetNotification || sid == .irqHandlerClear',
      '  | .cnodeSlotWord word => false', '',
      'def syscallMissingRightError : SyscallId → KernelError',
      '  | .send => .invalidCapability', '  | .cspaceMint | .reply | .yield => .illegalAuthority', ''
    ].join('\n'),
    'SeLe4n/Kernel/Architecture/SyscallArgDecode.lean': 'def truncationMinimum : SyscallId → Nat\n  | .cspaceMint => 5\n  | _ => 0\n',
    'SeLe4n/Kernel/Architecture/RegisterDecode.lean': 'def syscallReadsOverflow : SyscallId → Bool\n  | .send | .reply | .cspaceMint => true\n  | .yield => false\n'
  })[path];
  assert.deepEqual(checkEngineTables(engine, read), []);
  const drifted = { ...engine, truncationMinimum: (id) => (id === 'send' ? 1 : engine.truncationMinimum(id)), SYSCALL_OBJECT_KIND: { ...engine.SYSCALL_OBJECT_KIND, send: 'notification' } };
  const issues = checkEngineTables(drifted, read);
  assert.ok(issues.some((m) => m.includes('truncationMinimum .send is 0')));
  assert.ok(issues.some((m) => m.includes('syscallObjectKind? .send is endpoint')));
  assert.ok(checkEngineTables(engine, () => undefined).length >= 1);
});

/* ── Schema v4: the type gate, the arm's stages, whole entries ── */

test('the type gate is recomputed: a capability of the wrong type is refused before any right', () => {
  const refused = step(BUNDLED, 'irq-delivery', 11);
  assert.equal(refused.path.find((s) => s.stage === 'type').result, 'fail');
  assert.equal(refused.outcome.error, 'invalidCapability');
  const data = bundled();
  const st = step(data, 'irq-delivery', 11);
  st.path.find((s) => s.stage === 'type').result = 'pass';
  hasError(data, 'does not invoke (syscallTargetAccepted)');
  const ok = bundled();
  step(ok, 'ipc-call-reply', 1).path.find((s) => s.stage === 'type').result = 'fail';
  hasError(ok, 'but the type stage says fail');
  assert.equal(engine.targetAccepted('send', { kind: 'endpoint' }), true);
  assert.equal(engine.targetAccepted('send', { kind: 'notification' }), false);
  assert.equal(engine.targetAccepted('declassify', { kind: 'cnode' }), true);
  assert.equal(engine.targetAccepted('reply', { kind: 'reply' }), true);
  assert.equal(engine.targetAccepted('reply', { kind: 'endpoint' }), false);
  assert.equal(engine.targetAccepted('irqHandlerAck', { kind: 'irqHandler' }), true);
  assert.equal(engine.targetAccepted('yield', { kind: 'endpoint' }), false);
});

test('every syscall but the yield runs lookup, type and rights, and ends at the operation', () => {
  for (const sc of BUNDLED.scenarios) for (const st of sc.steps) {
    if (st.kind !== 'syscall') continue;
    const stages = st.path.map((s) => s.stage);
    if (st.syscall.id === 'yield') assert.deepEqual(stages, ['entry', 'decode', 'operation']);
    else assert.deepEqual(stages.slice(0, 5), ['entry', 'decode', 'lookup', 'type', 'rights'], `${sc.id} step ${st.index}`);
    assert.equal(stages[stages.length - 1], 'operation');
  }
  const data = bundled();
  const path = step(data, 'ipc-call-reply', 1).path;
  path.splice(path.findIndex((s) => s.stage === 'type'), 1);
  hasError(data, 'must have a type stage');
});

test('the arm\'s stages may come in the arm\'s order, but not before the rights or twice', () => {
  const data = bundled();
  const path = step(data, 'capability-derivation', 1).path; // … rights, args, flow, operation
  const a = path.findIndex((s) => s.stage === 'args');
  [path[a], path[a + 1]] = [path[a + 1], path[a]];
  assert.deepEqual(errorsOf(data).filter((m) => m.includes('out of order')), []);
  const early = bundled();
  const p2 = step(early, 'capability-derivation', 1).path;
  const r = p2.findIndex((s) => s.stage === 'rights');
  [p2[r], p2[r + 1]] = [p2[r + 1], p2[r]];
  hasError(early, 'is out of order');
});

test('a message shorter than the arm\'s minimum is refused as truncated, and only then', () => {
  const data = bundled();
  const st = step(data, 'untyped-retype', 1);
  st.syscall.msgInfo.length = 3;
  st.syscall.args.pop();
  hasError(data, 'is refused with truncatedMessage at the args stage');
  assert.equal(engine.truncationMinimum('untypedRetype'), 4);
  assert.equal(engine.truncationMinimum('send'), 0);
});

test('message words past x5 come from the IPC buffer, for the syscalls that read it', () => {
  const mint = step(BUNDLED, 'capability-derivation', 1);
  assert.equal(mint.syscall.msgInfo.length, 5);
  assert.equal(mint.syscall.args.length, 4);
  assert.equal(mint.syscall.ipcBuffer.length, 1);
  const data = bundled();
  delete step(data, 'capability-derivation', 1).syscall.ipcBuffer;
  hasError(data, 'reads 1 word(s) from the IPC buffer');
  const copy = bundled();
  step(copy, 'capability-derivation', 4).syscall.ipcBuffer = [{ name: 'x', value: 1 }];
  hasError(copy, 'reads no message word past x5');
});

test('a timer tick is recomputed whole: the clock, the releases, the charge, the scheduling point', () => {
  const sc = scenario(BUNDLED, 'budget-edf');
  let state = cloneState(sc.initialState);
  for (const st of sc.steps) {
    if (st.kind === 'timer') assert.deepEqual(st.delta.ops, engine.timerTickOps(state, st.core), `step ${st.index}`);
    for (const op of st.delta.ops) applyOp(state, op);
  }
  const data = bundled();
  step(data, 'budget-edf', 1).delta.ops.pop(); // drop the dispatch
  hasError(data, 'perCoreTimerTickStep on core 0 writes');
  const lie = bundled();
  const ops = step(lie, 'budget-edf', 5).delta.ops; // the release that preempts
  ops[ops.length - 1].thread = 'gamma';
  hasError(lie, 'perCoreTimerTickStep on core 0 writes');
});

test('the refill algebra: charge, merge, exhaust, release and the deadline rule', () => {
  const sc = { id: 's', budget: 3, period: 20, deadline: 20, remaining: 3, periodStart: 0, refills: [] };
  // Three consecutive ticks from t = 10: each tick returns one period after
  // the head it came from was released, and consecutive ticks merge.
  const t1 = engine.scChargeBudget(sc, 10, 1, 11);
  assert.deepEqual([t1.remaining, t1.periodStart, t1.refills], [2, 11, [{ amount: 1, at: 30 }]]);
  const t2 = engine.scChargeBudget(t1, 11, 1, 12);
  assert.deepEqual([t2.remaining, t2.periodStart, t2.refills], [1, 12, [{ amount: 2, at: 30 }]]);
  assert.equal(engine.scTickExhausts(t1, 11), false);
  assert.equal(engine.scTickExhausts(t2, 12), true);
  const t3 = engine.scChargeBudget(t2, 12, 1, 13);
  assert.deepEqual([t3.remaining, t3.refills], [0, [{ amount: 3, at: 30 }]]);
  assert.equal(engine.scReleaseKey(t3), 30);
  assert.equal(engine.scReleaseKey(t2), null, 'a context with budget has no place on a release queue');
  // Not due: nothing changes. Due: the refill becomes the head, released then.
  assert.deepEqual(engine.scReleaseReadyHead(t3, 29).remaining, 0);
  const back = engine.cbsUpdateDeadline(engine.scReleaseReadyHead(t3, 30), 30, true);
  assert.deepEqual([back.remaining, back.periodStart, back.refills, back.deadline], [3, 30, [], 50]);
  // A gap splits the refills: one tick, a pause, then another.
  const g1 = engine.scChargeBudget(sc, 0, 1, 1);
  const g2 = engine.scChargeBudget(g1, 5, 1, 6);
  assert.deepEqual(g2.refills, [{ amount: 1, at: 20 }, { amount: 1, at: 25 }]);
  // A pending refill that would merge into the head keeps the tick from exhausting it.
  assert.equal(engine.scTickExhausts({ ...sc, remaining: 1, periodStart: 0, refills: [{ amount: 2, at: 4 }] }, 5), false);
  assert.equal(sc.remaining, 3, 'the functions return new contexts');
});

test('scCharge and scRelease do the arithmetic themselves; a release must be due and at the head', () => {
  const s = cloneState(scenario(BUNDLED, 'budget-edf').initialState);
  applyOp(s, { op: 'clockTick' });
  assert.equal(s.time, 3);
  applyOp(s, { op: 'scCharge', sc: 'sc.alpha', core: 0 });
  const alpha = s.schedContexts.find((c) => c.id === 'sc.alpha');
  assert.deepEqual([alpha.remaining, alpha.refills], [0, [{ amount: 2, at: 7 }]]);
  assert.deepEqual(s.releaseQueues['0'], ['sc.alpha']);
  assert.throws(() => applyOp(s, { op: 'scCharge', sc: 'sc.beta', core: 0 }), /not running a thread bound to sc.beta/);
  assert.throws(() => applyOp(s, { op: 'scRelease', sc: 'sc.alpha', core: 0 }), /not released until 7/);
  assert.throws(() => applyOp(s, { op: 'scRelease', sc: 'sc.beta', core: 0 }), /not the head/);
  s.time = 7;
  applyOp(s, { op: 'scRelease', sc: 'sc.alpha', core: 0 });
  const again = s.schedContexts.find((c) => c.id === 'sc.alpha');
  assert.deepEqual([again.remaining, again.periodStart, again.deadline, s.releaseQueues['0']], [2, 7, 13, []]);
});

test('checkState catches a stranded refill, a lost tick and a release queue out of order', () => {
  const s = reconstructState(scenario(BUNDLED, 'budget-edf'), 4); // three contexts queued
  assert.deepEqual(violations(s), []);
  const stranded = cloneState(s);
  stranded.releaseQueues['0'] = stranded.releaseQueues['0'].filter((id) => id !== 'sc.alpha');
  assert.ok(violations(stranded).includes('refillsSound'));
  const lost = cloneState(s);
  lost.schedContexts[0].refills[0].amount -= 1;
  assert.ok(violations(lost).includes('refillsSound'));
  const order = cloneState(s);
  order.releaseQueues['0'].reverse();
  assert.ok(violations(order).includes('refillsSound'));
  const wide = cloneState(s);
  wide.schedContexts[0].budget = wide.schedContexts[0].period + 1;
  assert.ok(violations(wide).includes('budgetWithinBounds'));
});

test('a reschedule switches only for a candidate that outranks the running thread', () => {
  const threads = [{ id: 'run', priority: 50 }, { id: 'same', priority: 50 }, { id: 'hi', priority: 60 }];
  const equal = schedState([{ thread: 'same', prio: 50 }], threads);
  equal.cores[0].current = 'run';
  assert.deepEqual(engine.rescheduleOps(equal, 0), [], 'an equal-priority arrival does not preempt');
  const higher = schedState([{ thread: 'same', prio: 50 }, { thread: 'hi', prio: 60 }], threads);
  higher.cores[0].current = 'run';
  assert.deepEqual(engine.rescheduleOps(higher, 0), [{ op: 'enqueue', thread: 'run', core: 0, prio: 50 }, { op: 'dispatch', core: 0, thread: 'hi' }]);
  const idle = schedState([], threads);
  assert.deepEqual(engine.rescheduleOps(idle, 0), [{ op: 'dispatch', core: 0, thread: null }]);
  const data = bundled();
  step(data, 'irq-delivery', 8).delta.ops = [];
  hasError(data, 'handleRescheduleOnCoreState on core 0 writes');
});

test('an interrupt signals what the line\'s node names, or masks an unbound line and reaches no one', () => {
  const sc = scenario(BUNDLED, 'irq-delivery');
  const boot = cloneState(sc.initialState);
  assert.equal(engine.irqBinding(boot, 33), null);
  assert.deepEqual(engine.interruptOps(boot, 33), [{ op: 'irqPatch', line: 33, set: { masked: true } }]);
  const bound = reconstructState(sc, 6);
  assert.deepEqual(engine.irqBinding(bound, 33), { notification: 'n.uart', badge: 4, slot: 'irqnode.33/0' });
  const ops = engine.interruptOps(bound, 33);
  assert.deepEqual(ops.map((o) => o.op), ['ntfnPopHead', 'threadPatch', 'enqueue', 'irqPatch']);
  assert.equal(ops[1].set.msg.badge, 4);
  // No waiter: the badge is OR-ed into the pending word.
  const pending = reconstructState(sc, 4);
  pending.notifications[0].pending = 1;
  assert.deepEqual(engine.interruptOps(pending, 33)[0], { op: 'ntfnPatch', id: 'n.uart', set: { pending: 5 } });
  // A capability without the send right binds nothing.
  bound.cnodes.find((c) => c.irqNode === 33).slots['0'].rights = ['read'];
  assert.equal(engine.irqBinding(bound, 33), null);
  const data = bundled();
  step(data, 'irq-delivery', 7).delta.ops.pop(); // forget to mask
  hasError(data, 'handleInterruptOnCore on core 0 writes');
  const masked = bundled();
  scenario(masked, 'irq-delivery').steps.splice(4, 1); // drop the acknowledge that unmasks
  scenario(masked, 'irq-delivery').steps.forEach((st, i) => { st.index = i; });
  hasError(masked, 'is masked at the controller, so it raises no interrupt');
});

test('the interrupt syscalls write what the kernel writes, and a claimed line is refused', () => {
  const data = bundled();
  step(data, 'irq-delivery', 2).delta.ops[1].cap.rights.push('read');
  hasError(data, 'installs a write-only handler capability for line 33');
  const twice = bundled();
  const again = step(twice, 'irq-delivery', 10);
  assert.equal(again.outcome.error, 'revocationRequired');
  again.outcome.error = 'invalidIrq';
  again.path.find((s) => s.result === 'fail').error = 'invalidIrq';
  hasError(twice, 'is refused with revocationRequired (irqControlLineRefusal)');
  const bind = bundled();
  step(bind, 'irq-delivery', 3).delta.ops[0].cap.badge = 9;
  hasError(bind, 'copies cn.drv/2 whole into irqnode.33/0');
  const ack = bundled();
  step(ack, 'irq-delivery', 4).delta.ops.push({ op: 'irqPatch', line: 33, set: { active: false } });
  hasError(ack, 'irqHandlerAck unmasks line 33 and writes nothing else');
  const stray = bundled();
  step(stray, 'ipc-call-reply', 1).delta.ops.push({ op: 'irqPatch', line: 33, set: { masked: true } });
  hasError(stray, 'receive writes no interrupt line');
});

test('a capability crosses an endpoint only with the grant right, into the receive slot, under its source', () => {
  const sc = scenario(BUNDLED, 'cap-transfer');
  const pre = cloneState(sc.initialState);
  const noGrant = engine.transferPlan(pre, 'client', pre.cnodes[0].slots['2'], 'ep.svc', [3], 'server');
  assert.deepEqual([noGrant.granted, noGrant.results, noGrant.resolved], [false, [], []]);
  const granted = engine.transferPlan(pre, 'client', pre.cnodes[0].slots['1'], 'ep.svc', [3], 'server');
  assert.deepEqual(granted.results.map((r) => [r.kind, r.from, r.to]), [['installed', 'cn.cli/3', 'cn.srv/4']]);
  // A capability to the endpoint itself is unwrapped to its badge; the next one takes the slot.
  const both = engine.transferPlan(pre, 'client', pre.cnodes[0].slots['1'], 'ep.svc', [2, 3], 'server');
  assert.deepEqual(both.results.map((r) => r.kind), ['unwrapped', 'installed']);
  // One receive slot: a second capability to install stops the loop.
  pre.cnodes[0].slots['5'] = { kind: 'frame', target: 'fr.other', rights: ['read'] };
  assert.deepEqual(engine.transferPlan(pre, 'client', pre.cnodes[0].slots['1'], 'ep.svc', [3, 5], 'server').results.length, 1);
  // An address that does not resolve clears the whole list.
  assert.deepEqual(engine.transferPlan(pre, 'client', pre.cnodes[0].slots['1'], 'ep.svc', [3, 49], 'server').results, []);
  // The trace cannot install a capability the plan does not, nor omit one it does.
  const sneak = bundled();
  step(sneak, 'cap-transfer', 1).delta.ops.push({ op: 'capInsert', slot: 'cn.srv/4', parent: 'cn.cli/3', cap: { kind: 'frame', target: 'fr.buf', rights: ['read', 'write'], derivation: 'ipcTransfer' } });
  hasError(sneak, 'the rendezvous installs (nothing)');
  const dropped = bundled();
  step(dropped, 'cap-transfer', 5).delta.ops.pop();
  hasError(dropped, 'the step records (nothing)');
  const widened = bundled();
  const ins = step(widened, 'cap-transfer', 5).delta.ops;
  ins[ins.length - 1].cap.rights.push('grant');
  hasError(widened, 'the rendezvous installs');
  // Revoking the source reaches the copy in the other CSpace.
  const end = reconstructState(sc, sc.steps.length - 1);
  assert.equal(engine.capAt(end, 'cn.srv/4'), null);
  assert.ok(engine.capAt(end, 'cn.cli/3'));
});

test('carvePlacement says where a retype lands and why', () => {
  const s = cloneState(scenario(BUNDLED, 'untyped-retype').initialState);
  const first = engine.carvePlacement(s, 'cn.mgr/1', { kind: 'frame', size: 4096 });
  assert.deepEqual([first.from, first.reset, first.at, first.end], [0, true, 0, 4096]);
  applyOp(s, { op: 'untypedCarve', untyped: 'ut.pool', slot: 'cn.mgr/1', child: { id: 'f', kind: 'frame', size: 4096 } });
  applyOp(s, { op: 'capInsert', slot: 'cn.mgr/2', parent: 'cn.mgr/1', cap: { kind: 'frame', target: 'f', rights: ['read'], derivation: 'retype' } });
  const second = engine.carvePlacement(s, 'cn.mgr/1', { kind: 'untyped', size: 8192 });
  assert.deepEqual([second.from, second.reset, second.at, second.skipped], [4096, false, 8192, 4096]);
  assert.equal(engine.carvePlacement(s, 'cn.mgr/1', { kind: 'frame', size: 16384 }).error, 'untypedRegionExhausted');
  assert.equal(engine.carvePlacement(s, 'cn.mgr/2', { kind: 'frame', size: 4096 }).error, 'untypedTypeMismatch');
});

test('msgInfoFields places each field of x1 where MessageInfo.encode does', () => {
  const mi = { length: 5, extraCaps: 1, label: 3 };
  const fields = engine.msgInfoFields(mi);
  assert.deepEqual(fields.map((f) => [f.name, f.lo, f.width]), [['length', 0, 7], ['extraCaps', 7, 2], ['capsUnwrapped', 9, 3], ['label', 12, 52]]);
  let word = 0;
  for (const f of fields) word += f.value * 2 ** f.lo;
  assert.equal(word, engine.msgInfoWord(mi));
});

test('retypeRequest decodes x2 as decodeUntypedRetypeArgs does, and a carve must be what x2 asked for', () => {
  // type tag = x2 % 256 (KernelObjectType.ofNat?), sizeBits = x2 / 256.
  assert.deepEqual(engine.retypeRequest(8), { tag: 8, sizeBits: 0, kind: 'frame', size: engine.PAGE_BYTES });
  assert.deepEqual(engine.retypeRequest(5 + 13 * 256), { tag: 5, sizeBits: 13, kind: 'untyped', size: 8192 });
  // A kind the engine does not model is decoded but not sized: nothing is guessed.
  const tcb = engine.retypeRequest(0);
  assert.deepEqual([tcb.tag, tcb.kind, tcb.size], [0, null, null]);
  assert.equal(engine.retypeRequest(5).kind, null, 'an untyped needs a size exponent');
  assert.deepEqual(errorsOf(bundled()), []);
  const wrongSize = bundled();
  step(wrongSize, 'untyped-retype', 2).syscall.args[0].value = 5 + 12 * 256;
  hasError(wrongSize, 'x2 asks for a untyped of 4096 bytes');
  const wrongKind = bundled();
  step(wrongKind, 'untyped-retype', 1).syscall.args[0].value = 5 + 12 * 256;
  hasError(wrongKind, 'the step carves a frame of 4096');
});
