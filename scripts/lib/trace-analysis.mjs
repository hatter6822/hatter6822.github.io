/**
 * seLe4n Simulator — trace analysis library (schema v3).
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
 *   - **The scheduler's choice is recomputed.** Every `dispatch` op must name
 *     the thread `chooseBestInBucketEffective` picks from the state at that
 *     point of the step.
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
export const SCENES = ['path', 'ipc', 'scheduler', 'cspace', 'memory', 'infoflow'];

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
 * A declaration reference: `{ name, module }`, plus the `path` and `line` the
 * sync stamps once it has found the declaration in the checkout.
 */
function checkRef(ref, path, errors) {
  if (!isObject(ref)) { errors.push(`${path} must be a { name, module } reference`); return; }
  if (!isString(ref.name) || !ref.name) errors.push(`${path}.name must be a non-empty string`);
  if (!isString(ref.module) || !/^[A-Z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(ref.module)) errors.push(`${path}.module must be a Lean module name`);
  if (ref.path !== undefined && !isString(ref.path)) errors.push(`${path}.path must be a string when present`);
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
  if (call.requiredRight !== undefined && RIGHTS.indexOf(call.requiredRight) === -1) errors.push(`${stp}.syscall.requiredRight must be one of ${RIGHTS.join(', ')}`);
  const mi = call.msgInfo;
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
  const rights = stageOf(step, 'rights');
  if (!rights || rights.result === 'skip') return;
  const has = engine.capHasRight(r.cap, call.requiredRight);
  if (has && rights.result === 'fail') errors.push(`${stp}: the capability in ${r.slot} carries ${call.requiredRight}, but the rights stage says fail`);
  if (!has && rights.result !== 'fail') errors.push(`${stp}: the capability in ${r.slot} lacks ${call.requiredRight}, but the rights stage says ${rights.result}`);
  if (!has && step.outcome && step.outcome.error !== 'illegalAuthority') errors.push(`${stp}: a missing right is refused with illegalAuthority, not ${step.outcome.error}`);
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
      checkRefList(inv.preservedBy, `${ip}.preservedBy`, errors, 1);
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

  return errors;
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
        const order = PATH_STAGES.indexOf(stage.stage);
        if (order === -1) errors.push(`${pth}.stage must be one of ${PATH_STAGES.join(', ')}`);
        else if (order <= lastStage) errors.push(`${pth}.stage ${stage.stage} is out of order`);
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

  if (!isObject(step.invariants) || !Array.isArray(step.invariants.preserved)) errors.push(`${stp}.invariants.preserved must be an array`);
  else step.invariants.preserved.forEach((id) => { if (!ids.catalogIds.has(id)) errors.push(`${stp}.invariants.preserved references unknown invariant ${id}`); });
  if (isObject(step.invariants) && step.invariants.failed !== undefined) errors.push(`${stp}.invariants.failed: a kernel trace never records a failing invariant`);
}

export default { validateTraceDataObject, reconstructState, scenarioStates, applyOp, applyDelta, cloneState, engine };
