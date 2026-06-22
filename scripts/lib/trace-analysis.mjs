/**
 * seLe4n Execution Theater — trace analysis library.
 *
 * Pure, dependency-free helpers shared by the Node tooling (validator + tests).
 * The browser runtime (assets/js/run.js) carries a faithful re-implementation of
 * the same fold engine and op vocabulary; this module is the canonical reference
 * that the unit tests pin down, so the two cannot silently drift.
 *
 * The trace schema models the kernel as a deterministic state machine: a scenario
 * has one `initialState` and an ordered list of `steps`, each carrying a `delta`
 * (a list of structured ops) that transforms the projected SystemState. Replaying
 * = folding the deltas. Nothing here re-implements kernel *semantics*; it only
 * applies the already-decided effects that a trace records.
 */

export const SCHEMA_VERSION = 1;

export const ALLOWED_SOURCES = ['kernel', 'fixture'];

export const ALLOWED_STEP_KINDS = ['boot', 'syscall', 'schedule', 'timer', 'ipc', 'fault', 'interrupt'];

export const ALLOWED_OPS = [
  'setCurrent',
  'threadPatch',
  'epEnqueue',
  'epDequeue',
  'rqInsert',
  'rqRemove',
  'notifPatch',
  'cdtInsert',
  'cdtRemove',
  'cdtPatch',
  'untypedRetype',
  'untypedRevoke',
  'flowCheck',
  'ifPolicyAdd',
  'ifPolicyRemove',
  'message',
  'note'
];

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const QUEUE_NAMES = ['sendQ', 'receiveQ'];

/* ── State folding ──────────────────────────────────────────── */

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function findThread(state, id) {
  return (state.threads || []).find((t) => t.id === id) || null;
}

function findEndpoint(state, id) {
  return (state.endpoints || []).find((e) => e.id === id) || null;
}

function findNotification(state, id) {
  return (state.notifications || []).find((n) => n.id === id) || null;
}

function findCdtNode(state, id) {
  return ((state.cdt && state.cdt.nodes) || []).find((n) => n.id === id) || null;
}

/** All transitive descendants of a CDT node (following parent→child edges). */
function cdtDescendants(cdt, rootId) {
  const out = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    (cdt.edges || []).forEach((e) => { if (e[0] === id && !out.has(e[1])) { out.add(e[1]); stack.push(e[1]); } });
  }
  return out;
}

function findUntyped(state, id) {
  return (state.untyped || []).find((u) => u.id === id) || null;
}

function rqInsertOrdered(state, core, threadId) {
  const key = String(core);
  if (!state.runQueue) state.runQueue = {};
  if (!Array.isArray(state.runQueue[key])) state.runQueue[key] = [];
  const queue = state.runQueue[key];
  if (queue.indexOf(threadId) !== -1) return; // idempotent: never duplicate
  const t = findThread(state, threadId);
  const prio = t ? Number(t.priority) || 0 : 0;
  let i = 0;
  for (; i < queue.length; i++) {
    const other = findThread(state, queue[i]);
    const otherPrio = other ? Number(other.priority) || 0 : 0;
    if (otherPrio < prio) break;
  }
  queue.splice(i, 0, threadId);
}

/**
 * Apply a single op to a state object, mutating it in place.
 * Throws on dangling references so the validator can surface them.
 */
export function applyOp(state, op) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
    throw new Error('op must be an object with a string "op" field');
  }
  switch (op.op) {
    case 'setCurrent': {
      if (!state.current) state.current = {};
      if ('thread' in op) {
        if (op.thread !== null && !findThread(state, op.thread)) {
          throw new Error(`setCurrent: unknown thread ${op.thread}`);
        }
        state.current.thread = op.thread;
      }
      if (op.core !== undefined && op.core !== null) state.current.core = op.core;
      return state;
    }
    case 'threadPatch': {
      const t = findThread(state, op.id);
      if (!t) throw new Error(`threadPatch: unknown thread ${op.id}`);
      Object.assign(t, op.set || {});
      return state;
    }
    case 'epEnqueue': {
      const ep = findEndpoint(state, op.endpoint);
      if (!ep) throw new Error(`epEnqueue: unknown endpoint ${op.endpoint}`);
      if (QUEUE_NAMES.indexOf(op.queue) === -1) throw new Error(`epEnqueue: bad queue ${op.queue}`);
      if (!findThread(state, op.thread)) throw new Error(`epEnqueue: unknown thread ${op.thread}`);
      if (!Array.isArray(ep[op.queue])) ep[op.queue] = [];
      if (ep[op.queue].indexOf(op.thread) === -1) ep[op.queue].push(op.thread);
      return state;
    }
    case 'epDequeue': {
      const ep = findEndpoint(state, op.endpoint);
      if (!ep) throw new Error(`epDequeue: unknown endpoint ${op.endpoint}`);
      if (QUEUE_NAMES.indexOf(op.queue) === -1) throw new Error(`epDequeue: bad queue ${op.queue}`);
      ep[op.queue] = (ep[op.queue] || []).filter((id) => id !== op.thread);
      return state;
    }
    case 'rqInsert': {
      if (!findThread(state, op.thread)) throw new Error(`rqInsert: unknown thread ${op.thread}`);
      rqInsertOrdered(state, op.core || 0, op.thread);
      return state;
    }
    case 'rqRemove': {
      const key = String(op.core || 0);
      if (state.runQueue && Array.isArray(state.runQueue[key])) {
        state.runQueue[key] = state.runQueue[key].filter((id) => id !== op.thread);
      }
      return state;
    }
    case 'notifPatch': {
      const n = findNotification(state, op.id);
      if (!n) throw new Error(`notifPatch: unknown notification ${op.id}`);
      Object.assign(n, op.set || {});
      return state;
    }
    case 'cdtInsert': {
      if (!state.cdt) state.cdt = { nodes: [], edges: [] };
      const node = op.node;
      if (!node || typeof node.id !== 'string') throw new Error('cdtInsert: node.id required');
      if (!findCdtNode(state, node.id)) state.cdt.nodes.push(node);
      if (op.parent !== undefined && op.parent !== null) {
        if (!findCdtNode(state, op.parent)) throw new Error(`cdtInsert: unknown parent ${op.parent}`);
        const exists = (state.cdt.edges || []).some((e) => e[0] === op.parent && e[1] === node.id);
        if (!exists) state.cdt.edges.push([op.parent, node.id]);
      }
      return state;
    }
    case 'cdtRemove': {
      if (!state.cdt) return state;
      if (!findCdtNode(state, op.node)) throw new Error(`cdtRemove: unknown node ${op.node}`);
      const doomed = cdtDescendants(state.cdt, op.node);
      doomed.add(op.node);
      state.cdt.nodes = (state.cdt.nodes || []).filter((n) => !doomed.has(n.id));
      state.cdt.edges = (state.cdt.edges || []).filter((e) => !doomed.has(e[0]) && !doomed.has(e[1]));
      return state;
    }
    case 'cdtPatch': {
      const cn = findCdtNode(state, op.id);
      if (!cn) throw new Error(`cdtPatch: unknown cdt node ${op.id}`);
      Object.assign(cn, op.set || {});
      return state;
    }
    case 'untypedRetype': {
      const ut = findUntyped(state, op.untyped);
      if (!ut) throw new Error(`untypedRetype: unknown untyped ${op.untyped}`);
      const child = op.child;
      if (!child || typeof child.id !== 'string') throw new Error('untypedRetype: child.id required');
      if (!Array.isArray(ut.children)) ut.children = [];
      if (!ut.children.some((c) => c.id === child.id)) ut.children.push(child);
      ut.watermark = (Number(ut.watermark) || 0) + (Number(child.size) || 0);
      return state;
    }
    case 'untypedRevoke': {
      const utr = findUntyped(state, op.untyped);
      if (!utr) throw new Error(`untypedRevoke: unknown untyped ${op.untyped}`);
      utr.children = [];
      utr.watermark = 0;
      return state;
    }
    case 'ifPolicyAdd': {
      if (!state.infoflow) throw new Error('ifPolicyAdd: no infoflow state');
      const dom = new Set((state.infoflow.domains || []).map((d) => d.id));
      if (!dom.has(op.from)) throw new Error(`ifPolicyAdd: unknown domain ${op.from}`);
      if (!dom.has(op.to)) throw new Error(`ifPolicyAdd: unknown domain ${op.to}`);
      if (!Array.isArray(state.infoflow.policy)) state.infoflow.policy = [];
      if (!state.infoflow.policy.some((e) => e[0] === op.from && e[1] === op.to)) state.infoflow.policy.push([op.from, op.to]);
      return state;
    }
    case 'ifPolicyRemove': {
      if (state.infoflow && Array.isArray(state.infoflow.policy)) {
        state.infoflow.policy = state.infoflow.policy.filter((e) => !(e[0] === op.from && e[1] === op.to));
      }
      return state;
    }
    case 'flowCheck':
    case 'message':
    case 'note':
      return state; // event-only ops carry no persistent state change
    default:
      throw new Error(`unknown op "${op.op}"`);
  }
}

export function applyDelta(state, delta) {
  const ops = (delta && Array.isArray(delta.ops)) ? delta.ops : [];
  for (const op of ops) applyOp(state, op);
  return state;
}

/** Fold the scenario's deltas through step `stepIndex` (inclusive). */
export function reconstructState(scenario, stepIndex) {
  let state = cloneState(scenario.initialState);
  const steps = scenario.steps || [];
  const limit = Math.min(stepIndex, steps.length - 1);
  for (let i = 0; i <= limit; i++) applyDelta(state, steps[i].delta);
  return state;
}

/** Pre-compute the state after every step (states[i] = state after step i). */
export function scenarioStates(scenario) {
  const out = [];
  let state = cloneState(scenario.initialState);
  const steps = scenario.steps || [];
  for (let i = 0; i < steps.length; i++) {
    applyDelta(state, steps[i].delta);
    out.push(cloneState(state));
  }
  return out;
}

/** Entities referenced by a delta's ops — used to highlight what changed. */
export function touchedEntities(delta) {
  const threads = new Set();
  const endpoints = new Set();
  const notifications = new Set();
  const cdt = new Set();
  const untyped = new Set();
  const ops = (delta && Array.isArray(delta.ops)) ? delta.ops : [];
  for (const op of ops) {
    switch (op.op) {
      case 'setCurrent': if (op.thread) threads.add(op.thread); break;
      case 'threadPatch': if (op.id) threads.add(op.id); break;
      case 'epEnqueue':
      case 'epDequeue': if (op.endpoint) endpoints.add(op.endpoint); if (op.thread) threads.add(op.thread); break;
      case 'rqInsert':
      case 'rqRemove': if (op.thread) threads.add(op.thread); break;
      case 'notifPatch': if (op.id) notifications.add(op.id); break;
      case 'cdtInsert': if (op.node && op.node.id) cdt.add(op.node.id); if (op.parent) cdt.add(op.parent); break;
      case 'cdtRemove': if (op.node) cdt.add(op.node); break;
      case 'cdtPatch': if (op.id) cdt.add(op.id); break;
      case 'untypedRetype':
      case 'untypedRevoke': if (op.untyped) untyped.add(op.untyped); break;
      case 'message': if (op.from) threads.add(op.from); if (op.to) threads.add(op.to); if (op.endpoint) endpoints.add(op.endpoint); break;
      default: break;
    }
  }
  return { threads: [...threads], endpoints: [...endpoints], notifications: [...notifications], cdt: [...cdt], untyped: [...untyped] };
}

/* ── Validation ─────────────────────────────────────────────── */

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isString(v) { return typeof v === 'string'; }
function isNonNegInt(v) { return Number.isInteger(v) && v >= 0; }

function validateState(state, path, errors) {
  if (!isObject(state)) { errors.push(`${path} must be an object`); return; }
  if (!isObject(state.current) || !('thread' in state.current)) {
    errors.push(`${path}.current must have a thread field`);
  }
  if (!Array.isArray(state.threads)) errors.push(`${path}.threads must be an array`);
  else {
    const seen = new Set();
    state.threads.forEach((t, i) => {
      if (!isObject(t)) { errors.push(`${path}.threads[${i}] must be an object`); return; }
      if (!isString(t.id)) errors.push(`${path}.threads[${i}].id must be a string`);
      else if (seen.has(t.id)) errors.push(`${path}.threads[${i}].id duplicate ${t.id}`);
      else seen.add(t.id);
      if (typeof t.priority !== 'number') errors.push(`${path}.threads[${i}].priority must be a number`);
    });
  }
  if (state.endpoints !== undefined && !Array.isArray(state.endpoints)) errors.push(`${path}.endpoints must be an array`);
  if (state.notifications !== undefined && !Array.isArray(state.notifications)) errors.push(`${path}.notifications must be an array`);
  if (state.runQueue !== undefined && !isObject(state.runQueue)) errors.push(`${path}.runQueue must be an object`);
  if (state.cdt !== undefined) {
    if (!isObject(state.cdt)) errors.push(`${path}.cdt must be an object`);
    else {
      if (!Array.isArray(state.cdt.nodes)) errors.push(`${path}.cdt.nodes must be an array`);
      if (!Array.isArray(state.cdt.edges)) errors.push(`${path}.cdt.edges must be an array`);
    }
  }
  if (state.untyped !== undefined && !Array.isArray(state.untyped)) errors.push(`${path}.untyped must be an array`);
  if (state.infoflow !== undefined) {
    if (!isObject(state.infoflow)) errors.push(`${path}.infoflow must be an object`);
    else {
      if (!Array.isArray(state.infoflow.domains)) errors.push(`${path}.infoflow.domains must be an array`);
      if (state.infoflow.policy !== undefined && !Array.isArray(state.infoflow.policy)) errors.push(`${path}.infoflow.policy must be an array`);
    }
  }
}

/** Every information-flow policy edge must reference existing security domains. */
function checkInfoflow(state, path, errors) {
  if (!state.infoflow) return;
  const ids = new Set((state.infoflow.domains || []).map((d) => d.id));
  (state.infoflow.policy || []).forEach((e, i) => {
    if (!ids.has(e[0])) errors.push(`${path}: infoflow policy[${i}] from ${e[0]} is not a domain`);
    if (!ids.has(e[1])) errors.push(`${path}: infoflow policy[${i}] to ${e[1]} is not a domain`);
  });
}

/** Untyped watermark must stay within the region, and allocations within the watermark. */
function checkUntyped(state, path, errors) {
  (state.untyped || []).forEach((u, i) => {
    const region = Number(u.regionSize) || 0;
    const wm = Number(u.watermark) || 0;
    if (wm > region) errors.push(`${path}: untyped[${i}] watermark ${wm} exceeds region size ${region}`);
    const used = (u.children || []).reduce((a, c) => a + (Number(c.size) || 0), 0);
    if (used > wm) errors.push(`${path}: untyped[${i}] allocated ${used} exceeds watermark ${wm}`);
  });
}

/** Every CDT edge must reference existing nodes (a structural echo of childMapConsistent). */
function checkCdtRefs(state, path, errors) {
  if (!state.cdt) return;
  const ids = new Set((state.cdt.nodes || []).map((n) => n.id));
  (state.cdt.edges || []).forEach((e, i) => {
    if (!ids.has(e[0])) errors.push(`${path}: cdt edge[${i}] parent ${e[0]} is not a node`);
    if (!ids.has(e[1])) errors.push(`${path}: cdt edge[${i}] child ${e[1]} is not a node`);
  });
}

/** Run queues should never contain a duplicate thread id (mirrors schedulerRunQueueUniqueB). */
function checkRunQueueUnique(state, path, errors) {
  const rq = state.runQueue || {};
  for (const core of Object.keys(rq)) {
    const seen = new Set();
    for (const id of rq[core] || []) {
      if (seen.has(id)) errors.push(`${path}: run queue core ${core} contains duplicate ${id}`);
      seen.add(id);
    }
  }
}

export function validateTraceDataObject(data) {
  const errors = [];
  if (!isObject(data)) { errors.push('root must be an object'); return errors; }

  if (data.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION} (got ${JSON.stringify(data.schemaVersion)})`);
  }
  if (!isString(data.source) || ALLOWED_SOURCES.indexOf(data.source) === -1) {
    errors.push(`source must be one of ${ALLOWED_SOURCES.join(', ')}`);
  }
  if (!isString(data.generatedAt) || !ISO_RE.test(data.generatedAt)) {
    errors.push('generatedAt must be an ISO-8601 timestamp');
  }

  const catalogIds = new Set();
  if (!Array.isArray(data.invariantCatalog) || data.invariantCatalog.length === 0) {
    errors.push('invariantCatalog must be a non-empty array');
  } else {
    data.invariantCatalog.forEach((inv, i) => {
      if (!isObject(inv)) { errors.push(`invariantCatalog[${i}] must be an object`); return; }
      for (const field of ['id', 'label', 'check', 'module', 'mapModule']) {
        if (!isString(inv[field]) || !inv[field]) errors.push(`invariantCatalog[${i}].${field} must be a non-empty string`);
      }
      if (isString(inv.id)) {
        if (catalogIds.has(inv.id)) errors.push(`invariantCatalog: duplicate id ${inv.id}`);
        catalogIds.add(inv.id);
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
    if (!isString(sc.id) || !sc.id) errors.push(`${sp}.id must be a non-empty string`);
    else if (scenarioIds.has(sc.id)) errors.push(`${sp}.id duplicate ${sc.id}`);
    else scenarioIds.add(sc.id);
    if (!isString(sc.title) || !sc.title) errors.push(`${sp}.title must be a non-empty string`);
    if (!isString(sc.summary) || !sc.summary) errors.push(`${sp}.summary must be a non-empty string`);

    validateState(sc.initialState, `${sp}.initialState`, errors);

    if (!Array.isArray(sc.steps) || sc.steps.length === 0) {
      errors.push(`${sp}.steps must be a non-empty array`);
      return;
    }

    // Per-step shape + sequential indices.
    sc.steps.forEach((step, idx) => {
      const stp = `${sp}.steps[${idx}]`;
      if (!isObject(step)) { errors.push(`${stp} must be an object`); return; }
      if (step.index !== idx) errors.push(`${stp}.index must equal ${idx}`);
      if (ALLOWED_STEP_KINDS.indexOf(step.kind) === -1) errors.push(`${stp}.kind must be one of ${ALLOWED_STEP_KINDS.join(', ')}`);
      if (!isString(step.title) || !step.title) errors.push(`${stp}.title must be a non-empty string`);
      if (!isString(step.traceTag) || !step.traceTag) errors.push(`${stp}.traceTag must be a non-empty string`);
      if (!isObject(step.delta) || !Array.isArray(step.delta.ops)) errors.push(`${stp}.delta.ops must be an array`);
      else step.delta.ops.forEach((op, oi) => {
        if (!isObject(op) || ALLOWED_OPS.indexOf(op.op) === -1) errors.push(`${stp}.delta.ops[${oi}].op must be one of ${ALLOWED_OPS.join(', ')}`);
      });
      if (!isObject(step.invariants)) errors.push(`${stp}.invariants must be an object`);
      else {
        if (typeof step.invariants.allHold !== 'boolean') errors.push(`${stp}.invariants.allHold must be a boolean`);
        if (!Array.isArray(step.invariants.checked)) errors.push(`${stp}.invariants.checked must be an array`);
        else step.invariants.checked.forEach((id) => {
          if (catalogIds.size && !catalogIds.has(id)) errors.push(`${stp}.invariants.checked references unknown invariant ${id}`);
        });
        if (step.invariants.allHold === true && Array.isArray(step.invariants.failed) && step.invariants.failed.length > 0) {
          errors.push(`${stp}.invariants: allHold is true but failed is non-empty`);
        }
      }
    });

    // Fold the whole scenario to catch dangling references + duplicate run-queue entries.
    try {
      let state = cloneState(sc.initialState);
      checkRunQueueUnique(state, `${sp}.initialState`, errors);
      checkCdtRefs(state, `${sp}.initialState`, errors);
      checkUntyped(state, `${sp}.initialState`, errors);
      checkInfoflow(state, `${sp}.initialState`, errors);
      sc.steps.forEach((step, idx) => {
        try {
          applyDelta(state, step.delta);
        } catch (e) {
          errors.push(`${sp}.steps[${idx}] (${step && step.traceTag}): ${e.message}`);
        }
        checkRunQueueUnique(state, `${sp}.steps[${idx}]`, errors);
        checkCdtRefs(state, `${sp}.steps[${idx}]`, errors);
        checkUntyped(state, `${sp}.steps[${idx}]`, errors);
        checkInfoflow(state, `${sp}.steps[${idx}]`, errors);
      });
    } catch (e) {
      errors.push(`${sp}: failed to fold — ${e.message}`);
    }
  });

  return errors;
}

export default { validateTraceDataObject, reconstructState, scenarioStates, applyOp, applyDelta, touchedEntities, cloneState };
