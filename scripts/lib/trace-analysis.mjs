/**
 * seLe4n Simulator — trace analysis library (schema v4).
 *
 * The fold, the scheduler's selection rule, CPtr resolution, the flow lattice
 * and the structural invariant checks live in one file,
 * `assets/js/trace-engine.js`, which the page loads as a script. This module
 * evaluates that same text, so the validator and the browser cannot disagree
 * about what a trace means: there is no second implementation to drift.
 *
 * What is validated here, beyond shape:
 *
 *   - **Refusals change nothing.** A kernel transition is
 *     `σ → Except ε (α × σ)`; a refused step carries event ops only, and its
 *     path names exactly one failing stage, matching the outcome's error.
 *   - **The gates are recomputed, not believed.** For every syscall step the
 *     capability lookup is re-run from the step's x0 against the caller's
 *     CSpace (`resolveCapAddress`), the rights check against the capability it
 *     finds (`syscallLookupCap`), and each recorded flow check against the
 *     labels (`securityFlowsTo`). A step whose path says otherwise fails.
 *     The type gate between them (`syscallTargetAccepted`) and the arm's
 *     length check (`truncationMinimum`) are recomputed the same way.
 *   - **The scheduler's choice is recomputed.** Every `dispatch` op must name
 *     the thread `chooseBestInBucketEffective` picks from the state at that
 *     point of the step.
 *   - **A kernel entry that takes no argument is recomputed whole.** A timer
 *     tick, a reschedule and a device interrupt are functions of the state
 *     alone, so the step's ops must be exactly the ones the engine writes out
 *     for it (`timerTickOps`, `rescheduleOps`, `interruptOps`).
 *   - **Capabilities move only as the kernel moves them.** A capability
 *     installed by an IPC transfer must be the one `transferPlan` installs,
 *     in the receiver's receive slot, under the slot it came from; an
 *     interrupt handler is issued, bound, acknowledged and masked only by the
 *     step that does it.
 *   - **Derivations attenuate.** A minted or copied capability names its
 *     parent's object with a subset of its rights (`capAttenuates`).
 *   - **Every state satisfies the structural invariants** the catalogue names
 *     (`checkState`), from the initial state through every step.
 *
 * What the kernel *is* (the syscall numbers, required rights and error names a
 * step restates) is checked against the pinned checkout by trace-anchors.mjs.
 */
import { readFileSync } from 'node:fs';

const ENGINE_SOURCE = readFileSync(new URL('../../assets/js/trace-engine.js', import.meta.url), 'utf8');

/** Evaluate the browser engine in this realm and return its API. */
export function loadEngine(source = ENGINE_SOURCE) {
  const host = {};
  // eslint-disable-next-line no-new-func -- the engine is our own file, evaluated as the browser does
  new Function('window', source)(host);
  if (!host.sele4nTraceEngine) throw new Error('trace-engine.js did not define window.sele4nTraceEngine');
  return host.sele4nTraceEngine;
}

export const engine = loadEngine();

export const {
  SCHEMA_VERSION, STEP_KINDS, OPS, EVENT_OPS, PATH_STAGES, PATH_RESULTS, RIGHTS, IPC_STATES,
  REGISTERS, MSG_LIMITS, CAP_KINDS
} = engine;

export const ALLOWED_SOURCES = ['kernel', 'fixture'];

/** The stage views the page offers; a scenario may name one as its focus. */
export const SCENES = ['path', 'ipc', 'scheduler', 'cspace', 'memory', 'infoflow', 'irq'];

/** Order-insensitive structural equality of two plain values. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
function sameOps(a, b) { return canonical(a) === canonical(b); }
function describeOps(ops) { return ops.map((o) => canonical(o)).join(' ') || '(nothing)'; }

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ID_RE = /^[A-Za-z0-9_.:-]+$/;

export const cloneState = engine.clone;
export const applyOp = engine.applyOp;
export const scenarioStates = engine.scenarioStates;

export function applyDelta(state, delta) {
  return engine.applyOps(state, delta && Array.isArray(delta.ops) ? delta.ops : []);
}

/** Fold the scenario's deltas through step `stepIndex` (inclusive). */
export function reconstructState(scenario, stepIndex) {
  const state = engine.clone(scenario.initialState);
  const steps = scenario.steps || [];
  const limit = Math.min(stepIndex, steps.length - 1);
  for (let i = 0; i <= limit; i++) applyDelta(state, steps[i].delta);
  return state;
}

/* ── Shape helpers ──────────────────────────────────────────── */

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isString(v) { return typeof v === 'string'; }
function isNonNegInt(v) { return Number.isInteger(v) && v >= 0; }

/**
 * A declaration reference: `{ name, module }`, plus the `line` the sync stamps
 * once it has found the declaration in the checkout. The file is the
 * module's (`engine.modulePath`); a stored copy could only disagree with it.
 */
function checkRef(ref, path, errors) {
  if (!isObject(ref)) { errors.push(`${path} must be a { name, module } reference`); return; }
  if (!isString(ref.name) || !ref.name) errors.push(`${path}.name must be a non-empty string`);
  if (!isString(ref.module) || !engine.modulePath(ref.module)) errors.push(`${path}.module must be a Lean module name`);
  if (ref.path !== undefined) errors.push(`${path}.path was a v3 field; a declaration's file is its module's`);
  if (ref.line !== undefined && !(Number.isInteger(ref.line) && ref.line > 0)) errors.push(`${path}.line must be a positive integer when present`);
}

function checkRefList(list, path, errors, min) {
  if (!Array.isArray(list)) { errors.push(`${path} must be an array`); return; }
  if (list.length < min) errors.push(`${path} must name at least ${min} declaration(s)`);
  list.forEach((ref, i) => checkRef(ref, `${path}[${i}]`, errors));
}

function checkIdList(list, path, errors) {
  if (!Array.isArray(list)) { errors.push(`${path} must be an array`); return []; }
  const seen = new Set();
  list.forEach((item, i) => {
    if (!isObject(item) || !isString(item.id) || !ID_RE.test(item.id)) errors.push(`${path}[${i}].id must be an identifier`);
    else if (seen.has(item.id)) errors.push(`${path}[${i}].id duplicate ${item.id}`);
    else seen.add(item.id);
  });
  return [...seen];
}

/** The projected kernel state's shape. Consistency is `checkState`'s job. */
function validateStateShape(state, path, errors) {
  if (!isObject(state)) { errors.push(`${path} must be an object`); return; }
  const cores = checkIdListNumeric(state.cores, `${path}.cores`, errors);
  if (!cores.length) errors.push(`${path}.cores must declare at least one core`);
  const threads = checkIdList(state.threads, `${path}.threads`, errors);
  (state.threads || []).forEach((t, i) => {
    if (!isObject(t)) return;
    if (!Number.isInteger(t.priority) || t.priority < 0 || t.priority > 255) errors.push(`${path}.threads[${i}].priority must be 0–255`);
    if (!isNonNegInt(t.domain)) errors.push(`${path}.threads[${i}].domain must be a non-negative integer`);
    if (!isObject(t.ipc) || IPC_STATES.indexOf(t.ipc.state) === -1) errors.push(`${path}.threads[${i}].ipc.state must be one of ${IPC_STATES.join(', ')}`);
  });
  (state.cores || []).forEach((c, i) => {
    if (!isObject(c)) return;
    if (c.current !== null && threads.indexOf(c.current) === -1) errors.push(`${path}.cores[${i}].current ${c.current} is not a declared thread`);
    if (!isNonNegInt(c.domain)) errors.push(`${path}.cores[${i}].domain must be a non-negative integer`);
  });
  if (!isObject(state.runQueues)) errors.push(`${path}.runQueues must be an object keyed by core`);
  else Object.entries(state.runQueues).forEach(([k, q]) => {
    if (!cores.includes(Number(k))) errors.push(`${path}.runQueues.${k} names no declared core`);
    if (!Array.isArray(q)) errors.push(`${path}.runQueues.${k} must be an array`);
    else q.forEach((e, j) => {
      if (!isObject(e) || threads.indexOf(e.thread) === -1) errors.push(`${path}.runQueues.${k}[${j}] must name a declared thread`);
      else if (!Number.isInteger(e.prio)) errors.push(`${path}.runQueues.${k}[${j}].prio must be an integer`);
    });
  });
  for (const key of ['endpoints', 'notifications', 'replies', 'schedContexts', 'cnodes', 'untyped', 'vspaces', 'labels']) {
    if (state[key] !== undefined) checkIdList(state[key], `${path}.${key}`, errors);
  }
  (state.cnodes || []).forEach((cn, i) => {
    if (!isObject(cn)) return;
    for (const f of ['depth', 'guardWidth', 'guardValue', 'radixWidth']) if (!isNonNegInt(cn[f])) errors.push(`${path}.cnodes[${i}].${f} must be a non-negative integer`);
    if (cn.radixWidth > 8) errors.push(`${path}.cnodes[${i}].radixWidth above 8 would not draw`);
    if (cn.guardValue >= 2 ** cn.guardWidth) errors.push(`${path}.cnodes[${i}].guardValue does not fit its guard (guardBounded)`);
    if (!isObject(cn.slots)) errors.push(`${path}.cnodes[${i}].slots must be an object`);
    else Object.entries(cn.slots).forEach(([slot, cap]) => checkCap(cap, `${path}.cnodes[${i}].slots.${slot}`, errors));
  });
  if (state.cdt !== undefined && !isObject(state.cdt)) errors.push(`${path}.cdt must be an object of parent → children`);
  if (state.time !== undefined && !isNonNegInt(state.time)) errors.push(`${path}.time must be the timer's tick count`);
  const scIds = (state.schedContexts || []).filter(isObject).map((sc) => sc.id);
  (state.schedContexts || []).forEach((sc, i) => {
    if (!isObject(sc)) return;
    for (const f of ['budget', 'period', 'remaining', 'deadline', 'periodStart']) if (!isNonNegInt(sc[f])) errors.push(`${path}.schedContexts[${i}].${f} must be a non-negative integer`);
    if (!(sc.period > 0)) errors.push(`${path}.schedContexts[${i}].period must be positive`);
    if (!Array.isArray(sc.refills)) errors.push(`${path}.schedContexts[${i}].refills must be an array of { amount, at }`);
    else sc.refills.forEach((r, j) => {
      if (!isObject(r) || !isNonNegInt(r.amount) || !isNonNegInt(r.at)) errors.push(`${path}.schedContexts[${i}].refills[${j}] must be { amount, at }`);
      else if (j && sc.refills[j - 1].at > r.at) errors.push(`${path}.schedContexts[${i}].refills must be oldest first`);
    });
    if (sc.refillIn !== undefined) errors.push(`${path}.schedContexts[${i}].refillIn was a v3 field; a refill's release time is its refills[].at`);
  });
  if (state.releaseQueues !== undefined) {
    if (!isObject(state.releaseQueues)) errors.push(`${path}.releaseQueues must be an object keyed by core`);
    else Object.entries(state.releaseQueues).forEach(([k, q]) => {
      if (!cores.includes(Number(k))) errors.push(`${path}.releaseQueues.${k} names no declared core`);
      if (!Array.isArray(q) || q.some((id) => !scIds.includes(id))) errors.push(`${path}.releaseQueues.${k} must list declared scheduling contexts`);
    });
  }
  (state.untyped || []).forEach((u, i) => {
    if (!isObject(u)) return;
    if (u.watermark !== undefined) errors.push(`${path}.untyped[${i}].watermark was a v3 field; the free index is the untyped capability's (freeIndex)`);
    if (!isNonNegInt(u.base) || !(Number.isInteger(u.size) && u.size > 0)) errors.push(`${path}.untyped[${i}] needs a base address and a size`);
  });
  if (state.irqs !== undefined) {
    if (!Array.isArray(state.irqs)) errors.push(`${path}.irqs must be an array`);
    else state.irqs.forEach((l, i) => {
      if (!isObject(l) || !isNonNegInt(l.line) || l.line >= 320) { errors.push(`${path}.irqs[${i}].line must be an interrupt id below 320`); return; }
      if (l.line < 32) errors.push(`${path}.irqs[${i}].line ${l.line} is no device line (SPIs start at 32)`);
      if (typeof l.active !== 'boolean' || typeof l.masked !== 'boolean') errors.push(`${path}.irqs[${i}] needs boolean active and masked`);
      if (!isString(l.name) || !l.name) errors.push(`${path}.irqs[${i}].name must say what the line is`);
      if (!engine.irqNodeSlot(state, l.line)) errors.push(`${path}.irqs[${i}]: line ${l.line} has no interrupt node (a CNode with irqNode: ${l.line})`);
    });
  }
  (state.threads || []).forEach((t, i) => {
    if (!isObject(t) || t.recvSlot === undefined) return;
    if (!isString(t.recvSlot) || !engine.parseSlot(t.recvSlot)) errors.push(`${path}.threads[${i}].recvSlot must be a "<cnode>/<slot>" address`);
  });
  (state.labels || []).forEach((l, i) => {
    if (!isObject(l)) return;
    if (engine.LABEL_CONF.indexOf(l.conf) === -1) errors.push(`${path}.labels[${i}].conf must be low or high`);
    if (engine.LABEL_INTEG.indexOf(l.integ) === -1) errors.push(`${path}.labels[${i}].integ must be untrusted or trusted`);
  });
}

function checkIdListNumeric(list, path, errors) {
  if (!Array.isArray(list)) { errors.push(`${path} must be an array`); return []; }
  const ids = [];
  list.forEach((c, i) => {
    if (!isObject(c) || !isNonNegInt(c.id)) errors.push(`${path}[${i}].id must be a core number`);
    else if (ids.includes(c.id)) errors.push(`${path}[${i}].id duplicate core ${c.id}`);
    else ids.push(c.id);
  });
  return ids;
}

function checkCap(cap, path, errors) {
  if (!isObject(cap)) { errors.push(`${path} must be a capability object`); return; }
  if (CAP_KINDS.indexOf(cap.kind) === -1) errors.push(`${path}.kind must be one of ${CAP_KINDS.join(', ')}`);
  if (!isString(cap.target) || !cap.target) errors.push(`${path}.target must name an object`);
  if (!Array.isArray(cap.rights) || cap.rights.some((r) => RIGHTS.indexOf(r) === -1)) errors.push(`${path}.rights must be a list of ${RIGHTS.join(', ')}`);
  if (cap.badge !== undefined && cap.badge !== null && !isNonNegInt(cap.badge)) errors.push(`${path}.badge must be a non-negative integer`);
  if (cap.freeIndex !== undefined && (cap.kind !== 'untyped' || !isNonNegInt(cap.freeIndex))) errors.push(`${path}.freeIndex belongs on an untyped capability and is a byte offset`);
  if (cap.kind === 'irqHandler' && !isNonNegInt(cap.line)) errors.push(`${path}.line must name the handler's interrupt line`);
}

/* ── Syscall register block ─────────────────────────────────── */

function stageOf(step, name) { return (step.path || []).find((s) => s && s.stage === name) || null; }

function validateSyscallShape(step, stp, errors) {
  const call = step.syscall;
  if (!isObject(call) || !isString(call.id) || !call.id) { errors.push(`${stp}.syscall.id must be a non-empty string`); return; }
  if (!isNonNegInt(call.number)) errors.push(`${stp}.syscall.number must be the x7 value`);
  const needsCap = !!stageOf(step, 'lookup');
  if (needsCap && !isNonNegInt(call.capPtr)) errors.push(`${stp}.syscall.capPtr must be the x0 value the lookup resolves`);
  if (!!stageOf(step, 'rights') !== (call.requiredRight !== undefined)) errors.push(`${stp}.syscall.requiredRight must be present exactly when the path has a rights stage`);
  const mi = call.msgInfo;
  // The yield invokes no capability (`dispatchSyscallChecked` answers it
  // before any lookup); every other syscall runs lookup, type and rights.
  const stages = (step.path || []).filter(isObject).map((s) => s.stage);
  const want = call.id === 'yield' ? [] : ['lookup', 'type', 'rights'];
  for (const s of ['lookup', 'type', 'rights']) {
    if (want.includes(s) !== stages.includes(s)) errors.push(`${stp}.path ${want.includes(s) ? 'must have' : 'must not have'} a ${s} stage (${call.id})`);
  }
  if (stages.length && stages[stages.length - 1] !== 'operation') errors.push(`${stp}.path must end at the operation stage`);
  if (!stages.includes('decode')) errors.push(`${stp}.path must have a decode stage`);
  if (call.ipcBuffer !== undefined) {
    if (!Array.isArray(call.ipcBuffer) || call.ipcBuffer.some((w) => !isObject(w) || !isString(w.name) || !w.name || !isNonNegInt(w.value))) errors.push(`${stp}.syscall.ipcBuffer must list { name, value } message words past x5`);
    else if (!engine.readsOverflow(call.id)) errors.push(`${stp}.syscall.ipcBuffer: ${call.id} reads no message word past x5 (syscallReadsOverflow)`);
  }
  if (isObject(mi) && Array.isArray(call.args)) {
    const inline = Math.min(mi.length, REGISTERS.msgRegs.length);
    if (call.args.length !== inline) errors.push(`${stp}.syscall.args: a message of length ${mi.length} carries ${inline} inline word(s), the step lists ${call.args.length}`);
    const overflow = Math.max(0, mi.length - REGISTERS.msgRegs.length);
    const listed = Array.isArray(call.ipcBuffer) ? call.ipcBuffer.length : 0;
    if (engine.readsOverflow(call.id) ? listed !== overflow : listed !== 0) errors.push(`${stp}.syscall.ipcBuffer: a ${call.id} of length ${mi.length} reads ${engine.readsOverflow(call.id) ? overflow : 0} word(s) from the IPC buffer, the step lists ${listed}`);
  }
  if (call.extraCaps !== undefined) {
    if (!Array.isArray(call.extraCaps) || call.extraCaps.some((c) => !isNonNegInt(c))) errors.push(`${stp}.syscall.extraCaps must list the capability addresses the sender names`);
    else if (['send', 'call', 'reply', 'replyRecv'].indexOf(call.id) === -1) errors.push(`${stp}.syscall.extraCaps: ${call.id} transfers no capability`);
  }
  if (isObject(mi) && (Array.isArray(call.extraCaps) ? call.extraCaps.length : 0) !== mi.extraCaps) errors.push(`${stp}.syscall.extraCaps must list msgInfo.extraCaps (${mi.extraCaps}) addresses`);
  if (call.requiredRight !== undefined && RIGHTS.indexOf(call.requiredRight) === -1) errors.push(`${stp}.syscall.requiredRight must be one of ${RIGHTS.join(', ')}`);
  if (!isObject(mi)) errors.push(`${stp}.syscall.msgInfo must be { length, extraCaps, label }`);
  else {
    for (const f of ['length', 'extraCaps', 'label']) {
      if (!isNonNegInt(mi[f]) || mi[f] > MSG_LIMITS[f]) errors.push(`${stp}.syscall.msgInfo.${f} must be 0–${MSG_LIMITS[f]} (MessageInfo.decode)`);
    }
  }
  if (!Array.isArray(call.args)) errors.push(`${stp}.syscall.args must be an array`);
  else {
    if (call.args.length > REGISTERS.msgRegs.length) errors.push(`${stp}.syscall.args: only ${REGISTERS.msgRegs.length} message registers are inline`);
    call.args.forEach((a, i) => {
      if (!isObject(a) || a.reg !== REGISTERS.msgRegs[i]) errors.push(`${stp}.syscall.args[${i}].reg must be ${REGISTERS.msgRegs[i]}`);
      if (!isObject(a) || !isString(a.name) || !a.name) errors.push(`${stp}.syscall.args[${i}].name must say what the register carries`);
      if (!isObject(a) || !isNonNegInt(a.value)) errors.push(`${stp}.syscall.args[${i}].value must be a non-negative integer`);
    });
  }
}

/**
 * Re-run the gates a syscall step claims, against the state before it: the
 * caller must be current on the executing core, and the lookup and rights
 * stages must say what `resolveCap` and the capability's rights say.
 */
function checkSyscallGates(step, pre, stp, errors) {
  const call = step.syscall;
  const coreId = Number.isInteger(step.core) ? step.core : 0;
  const c = engine.byId(pre.cores, coreId);
  if (!c || c.current !== step.actor) {
    errors.push(`${stp}: ${step.actor} is not current on core ${coreId}, so dispatchSyscallChecked would refuse with illegalState`);
    return;
  }
  const lookup = stageOf(step, 'lookup');
  if (!lookup || lookup.result === 'skip') return;
  const r = engine.resolveCap(pre, step.actor, call.capPtr);
  if (r.error) {
    if (lookup.result !== 'fail') errors.push(`${stp}: x0 = ${call.capPtr} does not resolve in ${step.actor}'s CSpace (${r.error}, ${r.reason || 'lookup'}), but the lookup stage says ${lookup.result}`);
    else if (step.outcome && step.outcome.error !== r.error) errors.push(`${stp}: the lookup refuses with ${r.error}, not ${step.outcome.error}`);
    return;
  }
  if (lookup.result === 'fail') { errors.push(`${stp}: x0 = ${call.capPtr} resolves to ${r.slot}, but the lookup stage says fail`); return; }
  // `syscallTargetAccepted`: the capability's type, before any right.
  const type = stageOf(step, 'type');
  if (!type || type.result === 'skip') return;
  const accepted = engine.targetAccepted(call.id, r.cap);
  if (accepted && type.result === 'fail') errors.push(`${stp}: ${r.slot} holds a ${r.cap.kind} capability, which ${call.id} accepts, but the type stage says fail`);
  if (!accepted) {
    if (type.result !== 'fail') errors.push(`${stp}: ${r.slot} holds a ${r.cap.kind} capability, which ${call.id} does not invoke (syscallTargetAccepted), but the type stage says ${type.result}`);
    else if (step.outcome && step.outcome.error !== 'invalidCapability') errors.push(`${stp}: a capability of the wrong type is refused with invalidCapability, not ${step.outcome.error}`);
    return;
  }
  const rights = stageOf(step, 'rights');
  if (!rights || rights.result === 'skip') return;
  const has = engine.capHasRight(r.cap, call.requiredRight);
  if (has && rights.result === 'fail') errors.push(`${stp}: the capability in ${r.slot} carries ${call.requiredRight}, but the rights stage says fail`);
  if (!has && rights.result !== 'fail') errors.push(`${stp}: the capability in ${r.slot} lacks ${call.requiredRight}, but the rights stage says ${rights.result}`);
  // `syscallMissingRightError`: an IPC syscall answers a missing right as an
  // invalid capability, every other syscall as illegal authority.
  const refusal = engine.missingRightError(call.id);
  if (!has && step.outcome && step.outcome.error !== refusal) errors.push(`${stp}: ${call.id} without ${call.requiredRight} is refused with ${refusal} (syscallMissingRightError), not ${step.outcome.error}`);
  if (!has) return;
  // `requireMessageLength`: the arm's decode refuses a short message before
  // it reads a word of it.
  const min = engine.truncationMinimum(call.id);
  const short = isObject(call.msgInfo) && call.msgInfo.length < min;
  const args = stageOf(step, 'args');
  const truncated = !!(args && args.result === 'fail' && args.error === 'truncatedMessage');
  if (short && !truncated) errors.push(`${stp}: a ${call.id} of length ${call.msgInfo.length} is shorter than its ${min} word(s) and is refused with truncatedMessage at the args stage`);
  if (!short && truncated) errors.push(`${stp}: a ${call.id} of length ${call.msgInfo.length} meets its ${min} word(s); it is not truncated`);
  if (min > 0 && !args) errors.push(`${stp}: ${call.id} decodes ${min} argument word(s); its path needs an args stage`);
  checkArmEffects(step, pre, r, stp, errors);
}

/**
 * What an arm writes, where the engine can say so from the state and the
 * registers: capabilities an IPC rendezvous transfers, and the interrupt
 * syscalls.
 */
function checkArmEffects(step, pre, r, stp, errors) {
  const call = step.syscall;
  const ops = (isObject(step.delta) && Array.isArray(step.delta.ops) ? step.delta.ops : []).filter(isObject);
  const ok = isObject(step.outcome) && step.outcome.status === 'ok';
  const transfers = ops.filter((o) => o.op === 'capInsert' && o.cap && o.cap.derivation === 'ipcTransfer');
  if (call.id === 'send' || call.id === 'call') {
    const ep = engine.byId(pre.endpoints, r.cap.target);
    const receiver = ep && Array.isArray(ep.recv) && ep.recv.length ? ep.recv[0] : null;
    let expect = [];
    if (ok && receiver && Array.isArray(call.extraCaps) && call.extraCaps.length) {
      expect = engine.transferPlan(pre, step.actor, r.cap, r.cap.target, call.extraCaps, receiver).results.filter((x) => x.kind === 'installed');
    }
    const want = expect.map((x) => ({ slot: x.to, parent: x.from, kind: x.cap.kind, target: x.cap.target, rights: (x.cap.rights || []).slice().sort(), badge: x.cap.badge === undefined ? null : x.cap.badge }));
    const got = transfers.map((o) => ({ slot: o.slot, parent: o.parent, kind: o.cap.kind, target: o.cap.target, rights: (o.cap.rights || []).slice().sort(), badge: o.cap.badge === undefined ? null : o.cap.badge }));
    if (!sameOps(want, got)) errors.push(`${stp}: the rendezvous installs ${describeOps(want)} (resolveExtraCaps, ipcUnwrapCaps), the step records ${describeOps(got)}`);
  } else if (transfers.length) {
    errors.push(`${stp}: ${call.id} transfers no capability, but the step records an ipcTransfer install`);
  }

  /* A retype carves the object x2 asks for: its type tag and size exponent
     (`decodeUntypedRetypeArgs`), where the engine models the kind. */
  if (call.id === 'untypedRetype' && ok) {
    const req = engine.retypeRequest(call.args && call.args[0] ? call.args[0].value : 0);
    const carve = ops.find((o) => o.op === 'untypedCarve');
    if (!carve || !isObject(carve.child)) errors.push(`${stp}: a successful untypedRetype carves an object`);
    else if (req.kind && (carve.child.kind !== req.kind || carve.child.size !== req.size)) {
      errors.push(`${stp}: x2 asks for a ${req.kind} of ${req.size} bytes (decodeUntypedRetypeArgs), the step carves a ${carve.child.kind} of ${carve.child.size}`);
    }
  }

  const irqOps = ops.filter((o) => o.op === 'irqPatch');
  if (call.id === 'irqControlGet') {
    const lineNo = call.args && call.args[0] ? call.args[0].value : null;
    const line = engine.irqLine(pre, lineNo);
    const refusal = !line ? 'invalidIrq' : line.active ? 'revocationRequired' : null;
    if (refusal && (ok || step.outcome.error !== refusal)) errors.push(`${stp}: irqControlGet of line ${lineNo} is refused with ${refusal} (irqControlLineRefusal)`);
    if (ok && !refusal) {
      const insert = ops.find((o) => o.op === 'capInsert');
      const wantIrq = [{ op: 'irqPatch', line: lineNo, set: { active: true } }];
      if (!sameOps(irqOps, wantIrq)) errors.push(`${stp}: irqControlGet puts line ${lineNo} at IRQSignal and writes nothing else of it`);
      if (!insert || insert.parent !== r.slot || !insert.cap || insert.cap.kind !== 'irqHandler' || insert.cap.line !== lineNo || !sameOps((insert.cap.rights || []).slice().sort(), ['write'])) {
        errors.push(`${stp}: irqControlGet installs a write-only handler capability for line ${lineNo} as a derivation child of ${r.slot}`);
      }
    }
  } else if (call.id === 'irqHandlerAck') {
    if (ok && !sameOps(irqOps, [{ op: 'irqPatch', line: r.cap.line, set: { masked: false } }])) errors.push(`${stp}: irqHandlerAck unmasks line ${r.cap.line} and writes nothing else`);
  } else if (call.id === 'irqHandlerSetNotification') {
    if (irqOps.length) errors.push(`${stp}: irqHandlerSetNotification writes the line's node slot, not its state`);
    if (ok) {
      const node = engine.irqNodeSlot(pre, r.cap.line);
      const src = call.args && call.args[0] ? engine.resolveCap(pre, step.actor, call.args[0].value) : { error: 'invalidCapability' };
      const insert = ops.find((o) => o.op === 'capInsert');
      if (src.error || src.cap.kind !== 'notification' || !engine.capHasRight(src.cap, 'write')) errors.push(`${stp}: x2 must name a notification capability with the send right (irqNotificationCapAdmitted)`);
      else if (!insert || insert.slot !== node || insert.parent !== src.slot || !insert.cap || insert.cap.target !== src.cap.target || !sameOps((insert.cap.rights || []).slice().sort(), (src.cap.rights || []).slice().sort()) || (insert.cap.badge || 0) !== (src.cap.badge || 0)) {
        errors.push(`${stp}: irqHandlerSetNotification copies ${src.slot} whole into ${node}, as its derivation child`);
      }
    }
  } else if (irqOps.length) {
    errors.push(`${stp}: ${call.id} writes no interrupt line`);
  }
}

/**
 * A timer tick, a reschedule and a device interrupt take no argument: the
 * step's state-changing ops must be exactly what the engine writes out.
 */
function checkEntryStep(step, pre, stp, errors) {
  const ops = (isObject(step.delta) && Array.isArray(step.delta.ops) ? step.delta.ops : []).filter((o) => isObject(o) && EVENT_OPS.indexOf(o.op) === -1);
  const coreId = Number.isInteger(step.core) ? step.core : 0;
  let want = null;
  let rule = '';
  if (step.kind === 'timer') { want = engine.timerTickOps(pre, coreId); rule = 'perCoreTimerTickStep'; }
  else if (step.kind === 'schedule') { want = engine.rescheduleOps(pre, coreId); rule = 'handleRescheduleOnCoreState'; }
  else if (step.kind === 'interrupt') {
    const lineNo = isObject(step.irq) ? step.irq.line : null;
    const line = engine.irqLine(pre, lineNo);
    if (!line) { errors.push(`${stp}.irq.line must name a declared interrupt line`); return; }
    if (line.masked) errors.push(`${stp}: line ${lineNo} is masked at the controller, so it raises no interrupt`);
    want = engine.interruptOps(pre, lineNo);
    rule = 'handleInterruptOnCore';
  }
  if (want && !sameOps(ops, want)) errors.push(`${stp}: ${rule} on core ${coreId} writes ${describeOps(want)}; the step records ${describeOps(ops)}`);
  if (step.kind !== 'interrupt' && step.irq !== undefined) errors.push(`${stp}.irq belongs on an interrupt step`);
}

/* ── Document validation ────────────────────────────────────── */

export function validateTraceDataObject(data) {
  const errors = [];
  if (!isObject(data)) { errors.push('root must be an object'); return errors; }

  if (data.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION} (got ${JSON.stringify(data.schemaVersion)})`);
  if (!isString(data.source) || ALLOWED_SOURCES.indexOf(data.source) === -1) errors.push(`source must be one of ${ALLOWED_SOURCES.join(', ')}`);
  if (!isString(data.generatedAt) || !ISO_RE.test(data.generatedAt)) errors.push('generatedAt must be an ISO-8601 timestamp');

  const catalogIds = new Set();
  if (!Array.isArray(data.invariantCatalog) || data.invariantCatalog.length === 0) {
    errors.push('invariantCatalog must be a non-empty array');
  } else {
    data.invariantCatalog.forEach((inv, i) => {
      const ip = `invariantCatalog[${i}]`;
      if (!isObject(inv)) { errors.push(`${ip} must be an object`); return; }
      for (const field of ['id', 'label', 'subsystem', 'meaning']) {
        if (!isString(inv[field]) || !inv[field]) errors.push(`${ip}.${field} must be a non-empty string`);
      }
      checkRef(inv.predicate, `${ip}.predicate`, errors);
      checkRefList(inv.preservedBy, `${ip}.preservedBy`, errors, 0);
      let covering = 0;
      (Array.isArray(inv.preservedBy) ? inv.preservedBy : []).forEach((proof, j) => {
        const pp = `${ip}.preservedBy[${j}]`;
        if (!isObject(proof)) return;
        // What the theorem is about, and the transitions that function is.
        checkRef(proof.subject, `${pp}.subject`, errors);
        if (!Array.isArray(proof.covers) || proof.covers.some((k) => !isString(k) || !ID_RE.test(k))) errors.push(`${pp}.covers must list the transitions the theorem's subject is (syscall ids, step kinds, or "${engine.ANY_SYSCALL}")`);
        else {
          if (new Set(proof.covers).size !== proof.covers.length) errors.push(`${pp}.covers repeats a transition`);
          if (proof.covers.length) covering += 1;
        }
        // A theorem that proves a bundle names the bundles between its
        // conclusion and the predicate, outermost first.
        if (proof.within !== undefined) checkRefList(proof.within, `${pp}.within`, errors, 1);
      });
      if (inv.scope !== undefined && (!isString(inv.scope) || !inv.scope)) errors.push(`${ip}.scope must be a non-empty string when present`);
      // An invariant some step is not proved to preserve says so in words.
      if (Array.isArray(inv.preservedBy) && (!covering || inv.preservedBy.some((p) => isObject(p) && Array.isArray(p.covers) && !p.covers.length)) && !inv.scope) {
        errors.push(`${ip}.scope must say what its proofs do not cover: ${covering ? 'a theorem here is about a function no step runs' : 'no theorem here is about a transition a step runs'}`);
      }
      if (inv.runtimeCheck !== undefined) checkRef(inv.runtimeCheck, `${ip}.runtimeCheck`, errors);
      if (isString(inv.id)) {
        if (catalogIds.has(inv.id)) errors.push(`invariantCatalog: duplicate id ${inv.id}`);
        catalogIds.add(inv.id);
      }
    });
  }

  const propertyIds = new Set();
  if (!Array.isArray(data.propertyCatalog) || data.propertyCatalog.length === 0) {
    errors.push('propertyCatalog must be a non-empty array');
  } else {
    data.propertyCatalog.forEach((prop, i) => {
      const pp = `propertyCatalog[${i}]`;
      if (!isObject(prop)) { errors.push(`${pp} must be an object`); return; }
      for (const field of ['id', 'label', 'statement']) {
        if (!isString(prop[field]) || !prop[field]) errors.push(`${pp}.${field} must be a non-empty string`);
      }
      if (prop.caveat !== undefined && (!isString(prop.caveat) || !prop.caveat)) errors.push(`${pp}.caveat must be a non-empty string when present`);
      checkRefList(prop.theorems, `${pp}.theorems`, errors, 1);
      if (!Array.isArray(prop.invariants)) errors.push(`${pp}.invariants must be an array`);
      else prop.invariants.forEach((id) => { if (!catalogIds.has(id)) errors.push(`${pp}.invariants references unknown invariant ${id}`); });
      if (isString(prop.id)) {
        if (propertyIds.has(prop.id)) errors.push(`propertyCatalog: duplicate id ${prop.id}`);
        propertyIds.add(prop.id);
      }
    });
  }

  if (!Array.isArray(data.scenarios) || data.scenarios.length === 0) {
    errors.push('scenarios must be a non-empty array');
    return errors;
  }

  const scenarioIds = new Set();
  data.scenarios.forEach((sc, si) => {
    const sp = `scenarios[${si}]`;
    if (!isObject(sc)) { errors.push(`${sp} must be an object`); return; }
    if (!isString(sc.id) || !ID_RE.test(sc.id)) errors.push(`${sp}.id must be an identifier`);
    else if (scenarioIds.has(sc.id)) errors.push(`${sp}.id duplicate ${sc.id}`);
    else scenarioIds.add(sc.id);
    if (!isString(sc.title) || !sc.title) errors.push(`${sp}.title must be a non-empty string`);
    if (!isString(sc.summary) || !sc.summary) errors.push(`${sp}.summary must be a non-empty string`);
    if (sc.focus !== undefined && SCENES.indexOf(sc.focus) === -1) errors.push(`${sp}.focus must be one of ${SCENES.join(', ')}`);
    if (!Array.isArray(sc.properties) || sc.properties.length === 0) errors.push(`${sp}.properties must be a non-empty array`);
    else sc.properties.forEach((id) => { if (!propertyIds.has(id)) errors.push(`${sp}.properties references unknown property ${id}`); });

    validateStateShape(sc.initialState, `${sp}.initialState`, errors);

    if (!Array.isArray(sc.steps) || sc.steps.length === 0) {
      errors.push(`${sp}.steps must be a non-empty array`);
      return;
    }

    sc.steps.forEach((step, idx) => validateStepShape(step, idx, `${sp}.steps[${idx}]`, { propertyIds, catalogIds }, errors));

    // Fold op by op: the state each gate sees is the state at that point.
    let state;
    try { state = engine.clone(sc.initialState); } catch (e) { errors.push(`${sp}: initialState is not plain data`); return; }
    for (const v of engine.checkState(state)) {
      errors.push(`${sp}.initialState: ${v.message} (${v.id})`);
      if (!catalogIds.has(v.id)) errors.push(`${sp}: invariant check ${v.id} has no catalogue entry`);
    }
    sc.steps.forEach((step, idx) => {
      const stp = `${sp}.steps[${idx}] (${step && step.traceTag})`;
      if (!isObject(step)) return;
      if (step.kind === 'syscall' && isObject(step.syscall)) checkSyscallGates(step, state, stp, errors);
      else checkEntryStep(step, state, stp, errors);
      const ops = isObject(step.delta) && Array.isArray(step.delta.ops) ? step.delta.ops : [];
      let flowSeen = null;
      for (const op of ops) {
        try {
          checkOpAgainstState(op, state, stp, errors);
          if (op && op.op === 'flowCheck') flowSeen = op;
          engine.applyOp(state, op);
        } catch (e) {
          errors.push(`${stp}: ${e.message}`);
          return;
        }
      }
      const flow = stageOf(step, 'flow');
      if (flow && flow.result !== 'skip') {
        if (!flowSeen) errors.push(`${stp}: the path has a flow stage but the step records no flowCheck`);
        else if ((flow.result === 'pass') !== !!flowSeen.allowed) errors.push(`${stp}: the flow stage says ${flow.result} but the flow check says ${flowSeen.allowed ? 'allowed' : 'denied'}`);
        if (flow.result === 'fail' && step.outcome && step.outcome.error !== 'flowDenied') errors.push(`${stp}: a denied flow is refused with flowDenied, not ${step.outcome.error}`);
      }
      for (const v of engine.checkState(state)) {
        errors.push(`${stp}: ${v.message} (${v.id})`);
        if (!catalogIds.has(v.id)) errors.push(`${stp}: invariant check ${v.id} has no catalogue entry`);
      }
    });
  });

  // A `covers` entry must be a transition some step makes: a claim about a
  // syscall no scenario runs has nothing here to be checked against.
  const made = new Set([engine.ANY_SYSCALL]);
  data.scenarios.forEach((sc) => (isObject(sc) && Array.isArray(sc.steps) ? sc.steps : []).forEach((step) => {
    if (isObject(step) && step.kind !== 'boot') made.add(engine.transitionKey(step));
  }));
  (Array.isArray(data.invariantCatalog) ? data.invariantCatalog : []).forEach((inv, i) => {
    (isObject(inv) && Array.isArray(inv.preservedBy) ? inv.preservedBy : []).forEach((proof, j) => {
      (isObject(proof) && Array.isArray(proof.covers) ? proof.covers : []).forEach((key) => {
        if (!made.has(key)) errors.push(`invariantCatalog[${i}].preservedBy[${j}].covers names "${key}", a transition no step makes`);
      });
    });
  });

  return errors;
}

/**
 * What a `covers` claim is checked against: for each transition key, the
 * declarations the steps that make it name as the operation they run — the
 * `operation` stage of a successful syscall step, and the `sourceRefs` of a
 * timer tick, a reschedule or an interrupt.
 */
export function transitionRoots(data) {
  const roots = new Map();
  const add = (key, ref) => {
    if (!isObject(ref) || !isString(ref.name) || !isString(ref.module)) return;
    if (!roots.has(key)) roots.set(key, new Map());
    roots.get(key).set(`${ref.module}#${ref.name}`, { name: ref.name, module: ref.module });
  };
  (Array.isArray(data && data.scenarios) ? data.scenarios : []).forEach((sc) => (Array.isArray(sc.steps) ? sc.steps : []).forEach((step) => {
    if (!isObject(step) || step.kind === 'boot' || (step.outcome && step.outcome.status === 'error')) return;
    const key = engine.transitionKey(step);
    if (step.kind === 'syscall') (step.path || []).forEach((stage) => { if (isObject(stage) && stage.stage === 'operation') add(key, stage.ref); });
    else (step.sourceRefs || []).forEach((ref) => add(key, ref));
  }));
  return new Map([...roots].map(([key, refs]) => [key, [...refs.values()]]));
}

/**
 * Hold every `preservedBy` claim to the kernel's own call graph.
 *
 * `callGraph` is `map-callgraph.json`'s `{ module: { declaration: [targets] } }`
 * at the trace's commit; a target is a bare name when the caller's module (or
 * exactly one module) declares it, else `Module#name`. For each proof:
 *
 *   - the theorem refers to its `subject` (it is a statement about it);
 *   - it reaches the invariant's predicate: directly, or through `within`,
 *     each bundle a direct reference of the one before it and the predicate a
 *     direct reference of the last (a conjunct, not something merely
 *     mentioned three definitions down);
 *   - for every transition in `covers`, each operation a step of that kind
 *     names is the subject, is reached from it, or reaches it;
 *   - a proof with no `covers` is about a function **no** step's operation
 *     reaches — otherwise it should have claimed the step.
 *
 * Returns the issues. Reachability is over references, so it can admit a
 * theorem about a helper deep inside an operation; choosing an operation-level
 * theorem is editorial. What it cannot admit is what shipped before: a theorem
 * about a function the dispatched path never runs.
 */
export function checkProofCoverage(data, callGraph) {
  const issues = [];
  if (!isObject(callGraph)) return ['the call graph is missing'];
  const declaredIn = new Map(); // bare name → [modules]
  for (const [module, decls] of Object.entries(callGraph)) {
    for (const name of Object.keys(decls)) {
      if (!declaredIn.has(name)) declaredIn.set(name, []);
      declaredIn.get(name).push(module);
    }
  }
  const idOf = (ref) => `${ref.module}#${ref.name}`;
  const lookup = (id) => { const at = id.indexOf('#'); const m = callGraph[id.slice(0, at)]; return m ? m[id.slice(at + 1)] : undefined; };
  // A trace reference may be written qualified (`SchedContext.chargeBudget`)
  // where the graph lists the name as declared in its namespace.
  const nodeOf = (ref) => {
    if (lookup(idOf(ref)) !== undefined) return idOf(ref);
    const last = ref.name.split('.').pop();
    return lookup(`${ref.module}#${last}`) !== undefined ? `${ref.module}#${last}` : null;
  };
  const targetsOf = (id) => {
    const module = id.slice(0, id.indexOf('#'));
    return (lookup(id) || []).map((t) => {
      if (t.indexOf('#') !== -1) return t;
      if (callGraph[module] && callGraph[module][t] !== undefined) return `${module}#${t}`;
      const homes = declaredIn.get(t) || [];
      return homes.length === 1 ? `${homes[0]}#${t}` : null;
    }).filter(Boolean);
  };
  const reachCache = new Map();
  const reach = (id) => {
    if (reachCache.has(id)) return reachCache.get(id);
    const seen = new Set();
    const queue = [id];
    while (queue.length) {
      const at = queue.pop();
      if (seen.has(at)) continue;
      seen.add(at);
      for (const t of targetsOf(at)) if (!seen.has(t)) queue.push(t);
    }
    reachCache.set(id, seen);
    return seen;
  };
  const related = (a, b) => a === b || reach(a).has(b) || reach(b).has(a);

  const roots = transitionRoots(data);
  const rootNodes = new Map();
  for (const [key, refs] of roots) {
    const nodes = [];
    for (const ref of refs) {
      const node = nodeOf(ref);
      if (!node) issues.push(`transition "${key}": ${ref.name} (${ref.module}) is not in the call graph`);
      else nodes.push(node);
    }
    rootNodes.set(key, nodes);
  }
  const syscallKeys = new Set();
  (data.scenarios || []).forEach((sc) => (sc.steps || []).forEach((step) => { if (step.kind === 'syscall') syscallKeys.add(engine.transitionKey(step)); }));

  (data.invariantCatalog || []).forEach((inv) => {
    const predicate = isObject(inv.predicate) ? nodeOf(inv.predicate) : null;
    if (!predicate) { issues.push(`invariant "${inv.id}": predicate ${inv.predicate && inv.predicate.name} is not in the call graph`); return; }
    (inv.preservedBy || []).forEach((proof) => {
      const at = `invariant "${inv.id}": ${proof.name}`;
      const theorem = nodeOf(proof);
      const subject = isObject(proof.subject) ? nodeOf(proof.subject) : null;
      if (!theorem) { issues.push(`${at} is not in the call graph`); return; }
      if (!subject) { issues.push(`${at}: its subject ${proof.subject && proof.subject.name} is not in the call graph`); return; }
      const direct = new Set(targetsOf(theorem));
      if (!direct.has(subject)) issues.push(`${at} does not refer to ${proof.subject.name}, so it is not a statement about it`);
      let holder = theorem;
      let holderName = proof.name;
      let chainOk = true;
      for (const bundle of proof.within || []) {
        const node = nodeOf(bundle);
        if (!node || !new Set(targetsOf(holder)).has(node)) { issues.push(`${at}: ${holderName} does not refer to ${bundle.name}`); chainOk = false; break; }
        holder = node;
        holderName = bundle.name;
      }
      if (chainOk && !new Set(targetsOf(holder)).has(predicate)) issues.push(`${at}: ${holderName} does not refer to ${inv.predicate.name}${(proof.within || []).length ? ', so the predicate is not one of its conjuncts' : ''}`);

      const covers = Array.isArray(proof.covers) ? proof.covers : [];
      const keys = [];
      covers.forEach((key) => { if (key === engine.ANY_SYSCALL) keys.push(...syscallKeys); else keys.push(key); });
      for (const key of keys) {
        for (const root of rootNodes.get(key) || []) {
          // A syscall names one operation; an entry step names every function
          // it cites, so the subject need only be related to one of them.
          if (syscallKeys.has(key) && !related(subject, root)) issues.push(`${at} is about ${proof.subject.name}, which the ${key} arm's ${root.slice(root.indexOf('#') + 1)} neither is, reaches, nor is reached from`);
        }
        if (!syscallKeys.has(key) && !(rootNodes.get(key) || []).some((root) => related(subject, root))) issues.push(`${at} is about ${proof.subject.name}, which no function a ${key} step cites is, reaches, or is reached from`);
      }
      if (!covers.length) {
        for (const [key, nodes] of rootNodes) {
          const hit = nodes.find((root) => subject === root || reach(root).has(subject));
          if (hit) { issues.push(`${at} claims no transition, but ${proof.subject.name} is reached from the ${key} step's ${hit.slice(hit.indexOf('#') + 1)}: say so in covers`); break; }
        }
      }
    });
  });
  return issues;
}

/** The checks one op needs from the state just before it applies. */
function checkOpAgainstState(op, state, stp, errors) {
  if (!isObject(op)) return;
  if (op.op === 'dispatch') {
    const pick = engine.selectOnCore(state, op.core);
    if (pick.thread !== op.thread) errors.push(`${stp}: dispatch picks ${op.thread} on core ${op.core}, but the selection rule picks ${pick.thread}`);
  } else if (op.op === 'flowCheck') {
    const src = engine.labelOf(state, op.from);
    const dst = engine.labelOf(state, op.to);
    if (!src || !dst) errors.push(`${stp}: flowCheck ${op.from} → ${op.to} names something without a security label`);
    else if (engine.flowsTo(src, dst) !== !!op.allowed) errors.push(`${stp}: securityFlowsTo ${src.id} → ${dst.id} is ${engine.flowsTo(src, dst)}, the trace says ${!!op.allowed}`);
  } else if (op.op === 'capInsert' && op.parent && (op.cap && (op.cap.derivation === 'mint' || op.cap.derivation === 'copy'))) {
    const parent = engine.capAt(state, op.parent);
    if (parent) {
      if (parent.target !== op.cap.target || parent.kind !== op.cap.kind) errors.push(`${stp}: a ${op.cap.derivation} names its parent's object (capAttenuates)`);
      const extra = (op.cap.rights || []).filter((r) => (parent.rights || []).indexOf(r) === -1);
      if (extra.length) errors.push(`${stp}: ${op.slot} gains ${extra.join(', ')} over ${op.parent} (capAttenuates)`);
    }
  } else if (op.op === 'enqueue') {
    const th = engine.byId(state.threads, op.thread);
    if (th && th.ipc && th.ipc.state !== 'ready') errors.push(`${stp}: enqueue of ${op.thread}, which is ${th.ipc.state}`);
  }
}

function validateStepShape(step, idx, stp, ids, errors) {
  if (!isObject(step)) { errors.push(`${stp} must be an object`); return; }
  if (step.index !== idx) errors.push(`${stp}.index must equal ${idx}`);
  if (STEP_KINDS.indexOf(step.kind) === -1) errors.push(`${stp}.kind must be one of ${STEP_KINDS.join(', ')}`);
  if (!isString(step.title) || !step.title) errors.push(`${stp}.title must be a non-empty string`);
  if (!isString(step.traceTag) || !step.traceTag) errors.push(`${stp}.traceTag must be a non-empty string`);
  if (!isString(step.narrative) || !step.narrative) errors.push(`${stp}.narrative must say what happened`);
  if (step.core !== undefined && !isNonNegInt(step.core)) errors.push(`${stp}.core must be a core number`);
  const ops = isObject(step.delta) && Array.isArray(step.delta.ops) ? step.delta.ops : null;
  if (!ops) errors.push(`${stp}.delta.ops must be an array`);
  else ops.forEach((op, oi) => {
    if (!isObject(op) || OPS.indexOf(op.op) === -1) errors.push(`${stp}.delta.ops[${oi}].op must be one of ${OPS.join(', ')}`);
  });
  if (idx === 0 && step.kind !== 'boot') errors.push(`${stp}: the first step is the boot state`);
  if (idx === 0 && ops && ops.length) errors.push(`${stp}: the boot step changes nothing; put the state in initialState`);

  const outcome = step.outcome;
  const refusedWith = isObject(outcome) && outcome.status === 'error' ? outcome.error : null;
  if (!isObject(outcome) || (outcome.status !== 'ok' && outcome.status !== 'error')) {
    errors.push(`${stp}.outcome.status must be "ok" or "error"`);
  } else if (outcome.status === 'error') {
    if (!isString(outcome.error) || !outcome.error) errors.push(`${stp}.outcome.error must name the KernelError`);
    if (ops) ops.forEach((op, oi) => {
      if (isObject(op) && EVENT_OPS.indexOf(op.op) === -1) errors.push(`${stp}.delta.ops[${oi}] (${op.op}) changes state, but the step was refused — an error returns no successor state`);
    });
  } else if (outcome.error !== undefined) {
    errors.push(`${stp}.outcome.error is only meaningful when status is "error"`);
  }

  if (step.kind === 'syscall') {
    if (!isString(step.actor)) errors.push(`${stp}.actor must name the calling thread`);
    if (!Array.isArray(step.path)) errors.push(`${stp}.path is required on a syscall`);
    validateSyscallShape(step, stp, errors);
  } else if (step.syscall !== undefined) {
    errors.push(`${stp}.syscall belongs on a syscall step`);
  }

  if (step.path !== undefined) {
    if (!Array.isArray(step.path) || step.path.length === 0) errors.push(`${stp}.path must be a non-empty array when present`);
    else {
      let lastStage = -1;
      let failures = 0;
      let afterFail = false;
      step.path.forEach((stage, pi) => {
        const pth = `${stp}.path[${pi}]`;
        if (!isObject(stage)) { errors.push(`${pth} must be an object`); return; }
        // The arm's own stages (`args`, `flow`) share one rank: their order
        // is the arm's, but neither may repeat.
        const arm = engine.PATH_ARM_STAGES.indexOf(stage.stage) !== -1;
        const order = arm ? engine.PATH_FIXED_PREFIX.length : PATH_STAGES.indexOf(stage.stage);
        if (PATH_STAGES.indexOf(stage.stage) === -1) errors.push(`${pth}.stage must be one of ${PATH_STAGES.join(', ')}`);
        else if (order < lastStage || (order === lastStage && !arm) || step.path.findIndex((s) => isObject(s) && s.stage === stage.stage) !== pi) errors.push(`${pth}.stage ${stage.stage} is out of order`);
        else lastStage = order;
        if (!isString(stage.label) || !stage.label) errors.push(`${pth}.label must be a non-empty string`);
        if (stage.ref !== undefined) checkRef(stage.ref, `${pth}.ref`, errors);
        if (PATH_RESULTS.indexOf(stage.result) === -1) errors.push(`${pth}.result must be one of ${PATH_RESULTS.join(', ')}`);
        if (afterFail && stage.result !== 'skip') errors.push(`${pth} follows the refusing stage, so it must be "skip"`);
        if (!afterFail && stage.result === 'skip') errors.push(`${pth} is skipped although no earlier stage refused`);
        if (stage.result === 'fail') {
          failures += 1;
          afterFail = true;
          if (stage.error !== refusedWith) errors.push(`${pth}.error must match the step's outcome error (${refusedWith})`);
        } else if (stage.error !== undefined) {
          errors.push(`${pth}.error is only meaningful on the refusing stage`);
        }
      });
      if (step.path[0] && step.path[0].stage !== 'entry') errors.push(`${stp}.path must start at the entry stage`);
      if (refusedWith && failures !== 1) errors.push(`${stp}.path must name exactly one refusing stage for a refused step`);
      if (!refusedWith && failures !== 0) errors.push(`${stp}.path names a refusing stage, but the step succeeded`);
    }
  }

  checkRefList(step.sourceRefs, `${stp}.sourceRefs`, errors, 0);
  if (!Array.isArray(step.guarantees)) errors.push(`${stp}.guarantees must be an array`);
  else step.guarantees.forEach((id) => { if (!ids.propertyIds.has(id)) errors.push(`${stp}.guarantees references unknown property ${id}`); });

  // Which invariants a step is proved to preserve is not the step's to say: it
  // follows from the catalogue's `covers` (`engine.proofsCovering`), which the
  // build checks against the kernel's call graph. A hand-kept list beside it
  // claimed `timerTick`'s theorem for an endpoint call.
  if (step.invariants !== undefined) errors.push(`${stp}.invariants was a v3 field; the proofs that cover a step are derived from invariantCatalog[].preservedBy[].covers`);
}

export default { validateTraceDataObject, reconstructState, scenarioStates, applyOp, applyDelta, cloneState, engine };
