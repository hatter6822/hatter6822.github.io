/**
 * seLe4n Simulator — trace engine (schema v3).
 *
 * One implementation, two consumers. The browser loads this file before
 * run.js and reads `window.sele4nTraceEngine`; the Node tooling
 * (scripts/lib/trace-analysis.mjs) evaluates the same text and validates the
 * bundled traces with it. Before schema v3 the page and the validator each
 * carried their own copy of the fold, and nothing but a test kept them equal.
 *
 * What it does, and what it deliberately does not:
 *
 *   - **fold**: apply the effects a trace records (`applyOp`). A trace says
 *     what the kernel did; the fold never decides it.
 *   - **decide what the kernel decides**, where the decision is a pure function
 *     of the projected state and the step's registers, so a trace can be
 *     checked against it rather than believed:
 *       `selectOnCore`   the scheduler's choice (`chooseBestInBucketEffective`:
 *                        highest bucket first, EDF within a priority, FIFO on a
 *                        tie, domain and budget eligibility, full-scan fallback)
 *       `resolveCap`     a CPtr walked through guard and radix bits
 *                        (`resolveCapAddress`), one level per CNode
 *       `flowsTo`        `securityFlowsTo` over (confidentiality, integrity)
 *       `msgInfoWord`    the x1 encoding (`MessageInfo.encode`)
 *   - **check the state**: `checkState` evaluates executable mirrors of the
 *     invariants the catalogue names. They are structural approximations used
 *     to reject a malformed trace and to drive the sandbox; the proofs are the
 *     Lean theorems the catalogue links, not these functions.
 *
 * Plain ES5 in an IIFE, no dependencies, no DOM: it must evaluate unchanged
 * under the page's CSP and inside Node's `Function` constructor.
 */
(function (root) {
  "use strict";

  var SCHEMA_VERSION = 3;

  var STEP_KINDS = ["boot", "syscall", "schedule", "timer", "interrupt", "fault"];

  var OPS = [
    "dispatch", "deschedule", "enqueue",
    "threadPatch", "message",
    "epEnqueue", "epPopHead",
    "ntfnEnqueue", "ntfnPopHead", "ntfnPatch",
    "replyPatch", "scPatch",
    "capInsert", "capDelete", "capRevoke",
    "untypedCarve", "untypedReset",
    "vspaceMap", "vspaceUnmap",
    "auditAppend",
    "flowCheck", "vspaceReject", "note"
  ];

  /* Ops that record an event without changing state: the only ops a refused
     step may carry. A kernel transition is `σ → Except ε (α × σ)`, so an error
     returns no successor state. */
  var EVENT_OPS = ["flowCheck", "vspaceReject", "note"];

  /* The stages of the checked syscall path, in the order the kernel runs them:
     `syscallEntryChecked` decodes the registers, `dispatchSyscallChecked`
     resolves and rights-checks the capability, the arm gates the flow and runs
     the operation. */
  var PATH_STAGES = ["entry", "decode", "lookup", "rights", "flow", "operation"];
  var PATH_RESULTS = ["pass", "fail", "skip"];

  /* `AccessRight`, in `toBit` order. */
  var RIGHTS = ["read", "write", "grant", "grantReply", "retype"];

  /* `ThreadIpcState`, by the kernel's constructor names. */
  var IPC_STATES = ["ready", "blockedOnSend", "blockedOnReceive", "blockedOnCall", "blockedOnReply", "blockedOnNotification", "inactive"];

  /* `SyscallRegisterLayout` on ARM64 (`arm64DefaultLayout`). */
  var REGISTERS = { capPtr: "x0", msgInfo: "x1", msgRegs: ["x2", "x3", "x4", "x5"], syscallNum: "x7" };

  /* `MessageInfo` bounds (`maxMessageRegisters`, `maxExtraCaps`, `maxLabel`). */
  var MSG_LIMITS = { length: 120, extraCaps: 3, label: 1048575 };

  var CAP_KINDS = ["endpoint", "notification", "cnode", "untyped", "frame", "vspace", "pageTable", "reply", "tcb", "schedContext"];
  var LABEL_CONF = ["low", "high"];
  var LABEL_INTEG = ["untrusted", "trusted"];

  /* ── Small helpers ───────────────────────────────────────── */

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function byId(list, id) {
    list = list || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function pow2(n) { return Math.pow(2, n); }
  /* Bit fields of a word without 32-bit truncation (`CPtr.slotBits`). */
  function bitsAt(value, shift, width) { return Math.floor(value / pow2(shift)) % pow2(width); }

  function thread(s, id) { return byId(s.threads, id); }
  function endpoint(s, id) { return byId(s.endpoints, id); }
  function notification(s, id) { return byId(s.notifications, id); }
  function reply(s, id) { return byId(s.replies, id); }
  function schedContext(s, id) { return byId(s.schedContexts, id); }
  function cnode(s, id) { return byId(s.cnodes, id); }
  function untyped(s, id) { return byId(s.untyped, id); }
  function vspace(s, id) { return byId(s.vspaces, id); }
  function core(s, id) { return byId(s.cores, id); }
  function label(s, id) { return byId(s.labels, id); }

  /* `"cn.app/3"` → `{ cnode: "cn.app", slot: 3 }`. */
  function parseSlot(key) {
    var m = /^(.+)\/(\d+)$/.exec(String(key || ""));
    return m ? { cnode: m[1], slot: Number(m[2]) } : null;
  }
  function slotKey(cnodeId, slot) { return cnodeId + "/" + slot; }
  function slotCount(cn) { return pow2(Number(cn.radixWidth) || 0); }
  function capAt(s, key) {
    var ref = parseSlot(key);
    var cn = ref && cnode(s, ref.cnode);
    return cn && cn.slots && hasOwn(cn.slots, String(ref.slot)) ? cn.slots[String(ref.slot)] : null;
  }

  function runQueue(s, coreId) {
    if (!s.runQueues) s.runQueues = {};
    var key = String(coreId);
    if (!Array.isArray(s.runQueues[key])) s.runQueues[key] = [];
    return s.runQueues[key];
  }
  function queuedOn(s, threadId) {
    var out = [];
    var rqs = s.runQueues || {};
    for (var k in rqs) {
      if (!hasOwn(rqs, k)) continue;
      (rqs[k] || []).forEach(function (e) { if (e.thread === threadId) out.push(Number(k)); });
    }
    return out;
  }
  function currentCoreOf(s, threadId) {
    var cores = s.cores || [];
    for (var i = 0; i < cores.length; i++) if (cores[i].current === threadId) return cores[i].id;
    return null;
  }

  /* ── Derivation tree (seL4's mapping database, `SlotLinks.lean`) ──
     `cdt[parent]` lists its children first-child first. `linkAddChild` makes a
     new child the first child; `cdtSplice` unlinks a slot and adds each of its
     children, in order, as a first child of its parent — so they arrive in
     reverse; with no parent the children become roots. */

  function cdtChildren(s, key) { return (s.cdt && Array.isArray(s.cdt[key])) ? s.cdt[key] : []; }
  function cdtParent(s, key) {
    var cdt = s.cdt || {};
    for (var p in cdt) if (hasOwn(cdt, p) && (cdt[p] || []).indexOf(key) !== -1) return p;
    return null;
  }
  function cdtAddChild(s, parentKey, childKey) {
    if (!s.cdt) s.cdt = {};
    var kids = cdtChildren(s, parentKey).filter(function (k) { return k !== childKey; });
    kids.unshift(childKey);
    s.cdt[parentKey] = kids;
  }
  function cdtSplice(s, key) {
    if (!s.cdt) return;
    var parent = cdtParent(s, key);
    var kids = cdtChildren(s, key).slice();
    if (parent) s.cdt[parent] = cdtChildren(s, parent).filter(function (k) { return k !== key; });
    delete s.cdt[key];
    if (parent) kids.forEach(function (k) { cdtAddChild(s, parent, k); });
    if (parent && !s.cdt[parent].length) delete s.cdt[parent];
  }
  function cdtDescendants(s, key) {
    var out = [];
    var stack = cdtChildren(s, key).slice();
    while (stack.length) {
      var k = stack.shift();
      if (out.indexOf(k) !== -1) continue;
      out.push(k);
      stack = stack.concat(cdtChildren(s, k));
    }
    return out;
  }
  function clearSlot(s, key) {
    var ref = parseSlot(key);
    var cn = ref && cnode(s, ref.cnode);
    if (!cn || !cn.slots || !hasOwn(cn.slots, String(ref.slot))) throw new Error("no capability in slot " + key);
    delete cn.slots[String(ref.slot)];
  }
  /* `revokeFirstChildLoop`: delete the source's first child until it has none.
     Returns the deleted slots in the order the loop deletes them. */
  function revokeOrder(s, key) {
    var work = { cdt: clone(s.cdt || {}) };
    var order = [];
    var fuel = 1;
    for (var p in work.cdt) if (hasOwn(work.cdt, p)) fuel += work.cdt[p].length;
    while (fuel-- > 0) {
      var kids = cdtChildren(work, key);
      if (!kids.length) break;
      order.push(kids[0]);
      cdtSplice(work, kids[0]);
    }
    return order;
  }

  /* ── Fold ────────────────────────────────────────────────── */

  function requireThread(s, id, op) {
    var th = thread(s, id);
    if (!th) throw new Error(op + ": unknown thread " + id);
    return th;
  }

  function applyOp(s, op) {
    if (!op || typeof op !== "object" || typeof op.op !== "string") throw new Error("op must be an object with a string \"op\" field");
    switch (op.op) {
      case "dispatch": {
        var c = core(s, op.core);
        if (!c) throw new Error("dispatch: unknown core " + op.core);
        if (op.thread !== null) {
          requireThread(s, op.thread, "dispatch");
          var q = runQueue(s, op.core);
          s.runQueues[String(op.core)] = q.filter(function (e) { return e.thread !== op.thread; });
        }
        c.current = op.thread;
        return s;
      }
      case "deschedule": {
        requireThread(s, op.thread, "deschedule");
        var dc = core(s, op.core);
        if (!dc) throw new Error("deschedule: unknown core " + op.core);
        s.runQueues[String(op.core)] = runQueue(s, op.core).filter(function (e) { return e.thread !== op.thread; });
        if (dc.current === op.thread) dc.current = null;
        return s;
      }
      case "enqueue": {
        requireThread(s, op.thread, "enqueue");
        if (!core(s, op.core)) throw new Error("enqueue: unknown core " + op.core);
        if (typeof op.prio !== "number") throw new Error("enqueue: prio must be a number");
        var rq = runQueue(s, op.core);
        if (!rq.some(function (e) { return e.thread === op.thread; })) rq.push({ thread: op.thread, prio: op.prio });
        return s;
      }
      case "threadPatch": {
        var tp = requireThread(s, op.id, "threadPatch");
        var set = op.set || {};
        for (var k in set) if (hasOwn(set, k)) { if (set[k] === null) delete tp[k]; else tp[k] = set[k]; }
        return s;
      }
      case "message": {
        requireThread(s, op.from, "message");
        var to = requireThread(s, op.to, "message");
        to.msg = { from: op.from, via: op.via || null, words: (op.words || []).slice(), label: op.label || 0, badge: op.badge === undefined ? null : op.badge };
        return s;
      }
      case "epEnqueue":
      case "epPopHead": {
        var ep = endpoint(s, op.endpoint);
        if (!ep) throw new Error(op.op + ": unknown endpoint " + op.endpoint);
        if (op.queue !== "send" && op.queue !== "recv") throw new Error(op.op + ": queue must be send or recv");
        requireThread(s, op.thread, op.op);
        if (!Array.isArray(ep[op.queue])) ep[op.queue] = [];
        if (op.op === "epEnqueue") {
          if (ep[op.queue].indexOf(op.thread) !== -1) throw new Error("epEnqueue: " + op.thread + " is already queued on " + op.endpoint);
          ep[op.queue].push(op.thread);
        } else {
          if (ep[op.queue][0] !== op.thread) throw new Error("epPopHead: " + op.thread + " is not the head of " + op.endpoint + "." + op.queue);
          ep[op.queue].shift();
        }
        return s;
      }
      case "ntfnEnqueue":
      case "ntfnPopHead": {
        var n = notification(s, op.notification);
        if (!n) throw new Error(op.op + ": unknown notification " + op.notification);
        requireThread(s, op.thread, op.op);
        if (!Array.isArray(n.waiters)) n.waiters = [];
        if (op.op === "ntfnEnqueue") {
          if (n.waiters.indexOf(op.thread) !== -1) throw new Error("ntfnEnqueue: " + op.thread + " already waits on " + op.notification);
          n.waiters.push(op.thread);
        } else {
          if (n.waiters[0] !== op.thread) throw new Error("ntfnPopHead: " + op.thread + " is not the head of " + op.notification);
          n.waiters.shift();
        }
        return s;
      }
      case "ntfnPatch":
      case "replyPatch":
      case "scPatch": {
        var obj = op.op === "ntfnPatch" ? notification(s, op.id) : op.op === "replyPatch" ? reply(s, op.id) : schedContext(s, op.id);
        if (!obj) throw new Error(op.op + ": unknown object " + op.id);
        var ps = op.set || {};
        for (var pk in ps) if (hasOwn(ps, pk)) obj[pk] = ps[pk];
        return s;
      }
      case "capInsert": {
        var ref = parseSlot(op.slot);
        var cn = ref && cnode(s, ref.cnode);
        if (!cn) throw new Error("capInsert: unknown slot " + op.slot);
        if (ref.slot >= slotCount(cn)) throw new Error("capInsert: slot " + ref.slot + " is not addressable in a 2^" + cn.radixWidth + "-slot CNode");
        if (!cn.slots) cn.slots = {};
        if (hasOwn(cn.slots, String(ref.slot))) throw new Error("capInsert: slot " + op.slot + " is occupied (targetSlotOccupied)");
        if (!op.cap || typeof op.cap.kind !== "string") throw new Error("capInsert: cap.kind required");
        cn.slots[String(ref.slot)] = clone(op.cap);
        if (op.parent) {
          if (!capAt(s, op.parent)) throw new Error("capInsert: parent slot " + op.parent + " is empty");
          cdtAddChild(s, op.parent, op.slot);
        }
        return s;
      }
      case "capDelete": {
        clearSlot(s, op.slot);
        cdtSplice(s, op.slot);
        return s;
      }
      case "capRevoke": {
        if (!capAt(s, op.slot)) throw new Error("capRevoke: slot " + op.slot + " is empty");
        revokeOrder(s, op.slot).forEach(function (k) { clearSlot(s, k); cdtSplice(s, k); });
        return s;
      }
      case "untypedCarve": {
        var ut = untyped(s, op.untyped);
        if (!ut) throw new Error("untypedCarve: unknown untyped " + op.untyped);
        var child = op.child;
        if (!child || typeof child.id !== "string" || !(child.size > 0)) throw new Error("untypedCarve: child.id and child.size required");
        if (ut.watermark + child.size > ut.size) throw new Error("untypedCarve: " + child.size + " bytes do not fit above watermark " + ut.watermark + " (untypedRegionExhausted)");
        if (!Array.isArray(ut.children)) ut.children = [];
        ut.children.unshift({ id: child.id, kind: child.kind, offset: ut.watermark, size: child.size });
        ut.watermark += child.size;
        return s;
      }
      case "untypedReset": {
        var ur = untyped(s, op.untyped);
        if (!ur) throw new Error("untypedReset: unknown untyped " + op.untyped);
        ur.children = [];
        ur.watermark = 0;
        return s;
      }
      case "vspaceMap": {
        var vs = vspace(s, op.vspace);
        if (!vs) throw new Error("vspaceMap: unknown vspace " + op.vspace);
        var mp = op.mapping;
        if (!mp || typeof mp.vaddr !== "string") throw new Error("vspaceMap: mapping.vaddr required");
        if (!Array.isArray(vs.mappings)) vs.mappings = [];
        if (vs.mappings.some(function (m) { return m.vaddr === mp.vaddr; })) throw new Error("vspaceMap: " + mp.vaddr + " is already mapped");
        vs.mappings.push(clone(mp));
        /* The per-core map wrapper caches the fresh translation on the
           executing core (`vspaceMapPageCheckedWithShootdownFromStatePerCore`). */
        if (op.cache) {
          if (!Array.isArray(vs.tlb)) vs.tlb = [];
          if (vs.tlb.indexOf(mp.vaddr) === -1) vs.tlb.push(mp.vaddr);
        }
        return s;
      }
      case "vspaceUnmap": {
        var vu = vspace(s, op.vspace);
        if (!vu) throw new Error("vspaceUnmap: unknown vspace " + op.vspace);
        vu.mappings = (vu.mappings || []).filter(function (m) { return m.vaddr !== op.vaddr; });
        vu.tlb = (vu.tlb || []).filter(function (v) { return v !== op.vaddr; });
        return s;
      }
      case "auditAppend": {
        var e = op.entry;
        if (!e || !label(s, e.from) || !label(s, e.to)) throw new Error("auditAppend: entry must name two known labels");
        if (!Array.isArray(s.audit)) s.audit = [];
        s.audit.push(clone(e));
        return s;
      }
      case "flowCheck":
      case "vspaceReject":
      case "note":
        return s;
      default:
        throw new Error("unknown op \"" + op.op + "\"");
    }
  }

  function applyOps(s, ops) {
    (ops || []).forEach(function (op) { applyOp(s, op); });
    return s;
  }

  /* states[i] = the state after step i. */
  function scenarioStates(scenario) {
    var out = [];
    var s = clone(scenario.initialState);
    (scenario.steps || []).forEach(function (step) {
      applyOps(s, step.delta && step.delta.ops);
      out.push(clone(s));
    });
    return out;
  }

  /* ── What the kernel decides ─────────────────────────────── */

  /* `isBetterCandidate`: priority first; at equal priority a nonzero deadline
     beats none and an earlier one beats a later; otherwise the incumbent. */
  function isBetterCandidate(incPrio, incDl, chalPrio, chalDl) {
    if (chalPrio > incPrio) return true;
    if (chalPrio < incPrio) return false;
    if (!chalDl) return false;
    if (!incDl) return true;
    return chalDl < incDl;
  }

  function effectiveParams(s, th) {
    var sc = th.sc ? schedContext(s, th.sc) : null;
    return {
      prio: Number(th.priority) || 0,
      deadline: sc ? (Number(sc.deadline) || 0) : (Number(th.deadline) || 0),
      budgetOk: sc ? (Number(sc.remaining) || 0) > 0 : true
    };
  }

  /* `chooseThreadEffectiveOnCore` over the projected queue: the highest
     bucket first, every candidate the scan considers reported with its verdict,
     and the full queue scanned only when that bucket has no eligible thread. */
  function selectOnCore(s, coreId) {
    var c = core(s, coreId);
    var rq = (s.runQueues && s.runQueues[String(coreId)]) || [];
    var domain = c ? Number(c.domain) || 0 : 0;
    var maxPrio = null;
    rq.forEach(function (e) { if (maxPrio === null || e.prio > maxPrio) maxPrio = e.prio; });
    function scan(entries) {
      var best = null;
      var seen = [];
      entries.forEach(function (e) {
        var th = thread(s, e.thread);
        var row = { thread: e.thread, bucket: e.prio, eligible: false, reason: "" };
        if (!th) { row.reason = "missing"; seen.push(row); return; }
        var p = effectiveParams(s, th);
        row.prio = p.prio; row.deadline = p.deadline;
        if ((Number(th.domain) || 0) !== domain) row.reason = "domain";
        else if (!p.budgetOk) row.reason = "budget";
        else {
          row.eligible = true;
          if (!best || isBetterCandidate(best.prio, best.deadline, p.prio, p.deadline)) {
            row.reason = best ? (p.prio > best.prio ? "priority" : "deadline") : "first";
            best = { thread: e.thread, prio: p.prio, deadline: p.deadline };
          } else {
            row.reason = p.prio < best.prio ? "lowerPriority" : (best.deadline && (!p.deadline || p.deadline > best.deadline)) ? "laterDeadline" : "fifo";
          }
        }
        seen.push(row);
      });
      return { best: best, seen: seen };
    }
    var bucket = rq.filter(function (e) { return e.prio === maxPrio; });
    var first = scan(bucket);
    if (first.best) return { thread: first.best.thread, maxPrio: maxPrio, fallback: false, candidates: first.seen };
    var full = scan(rq);
    return { thread: full.best ? full.best.thread : null, maxPrio: maxPrio, fallback: rq.length > bucket.length, candidates: first.seen.concat(full.seen.filter(function (r) { return r.bucket !== maxPrio; })) };
  }

  /* `resolveCapAddress` + the slot lookup of `syscallResolveCap`. Each level
     takes guard and radix bits off the top of what remains; the leaf is the
     slot the last level names. */
  function resolveCap(s, threadId, cptr) {
    var th = thread(s, threadId);
    var levels = [];
    if (!th || !th.cspace) return { error: "objectNotFound", levels: levels };
    var cn = cnode(s, th.cspace);
    if (!cn) return { error: "objectNotFound", levels: levels };
    var bits = Number(cn.depth) || 0;
    var addr = Number(cptr) || 0;
    for (var guardFuel = 0; guardFuel < 16; guardFuel++) {
      var consumed = (Number(cn.guardWidth) || 0) + (Number(cn.radixWidth) || 0);
      if (bits === 0 || consumed === 0 || bits < consumed) return { error: "illegalState", levels: levels };
      var shift = bits - consumed;
      var slot = bitsAt(addr, shift, Number(cn.radixWidth) || 0);
      var guard = bitsAt(addr, shift + (Number(cn.radixWidth) || 0), Number(cn.guardWidth) || 0);
      var level = { cnode: cn.id, bits: bits, shift: shift, guardWidth: cn.guardWidth, radixWidth: cn.radixWidth, guard: guard, guardValue: cn.guardValue, slot: slot, guardOk: guard === (Number(cn.guardValue) || 0) };
      levels.push(level);
      if (!level.guardOk) return { error: "invalidCapability", reason: "guard", levels: levels };
      var key = slotKey(cn.id, slot);
      var cap = capAt(s, key);
      if (shift === 0) {
        if (!cap) return { error: "invalidCapability", reason: "empty", slot: key, levels: levels };
        return { slot: key, cap: cap, levels: levels };
      }
      if (!cap || cap.kind !== "cnode") return { error: "invalidCapability", reason: cap ? "notCNode" : "empty", slot: key, levels: levels };
      cn = cnode(s, cap.target);
      if (!cn) return { error: "objectNotFound", levels: levels };
      bits = shift;
    }
    return { error: "illegalState", levels: levels };
  }

  function capHasRight(cap, right) { return !!(cap && Array.isArray(cap.rights) && cap.rights.indexOf(right) !== -1); }
  function rightsMask(rights) {
    var m = 0;
    (rights || []).forEach(function (r) { var i = RIGHTS.indexOf(r); if (i !== -1) m += pow2(i); });
    return m;
  }

  /* `securityFlowsTo`: confidentiality may only rise, integrity may only fall. */
  function labelOf(s, entityId) {
    var ent = thread(s, entityId) || endpoint(s, entityId) || notification(s, entityId) || cnode(s, entityId) || vspace(s, entityId) || untyped(s, entityId);
    return ent && ent.label ? label(s, ent.label) : label(s, entityId);
  }
  function flowsTo(src, dst) {
    if (!src || !dst) return false;
    var conf = src.conf === "low" || dst.conf === "high";
    var integ = dst.integ === "untrusted" || src.integ === "trusted";
    return conf && integ;
  }

  /* `MessageInfo.encode`: length | extraCaps << 7 | label << 9. */
  function msgInfoWord(mi) {
    mi = mi || {};
    return (Number(mi.length) || 0) + (Number(mi.extraCaps) || 0) * 128 + (Number(mi.label) || 0) * 512;
  }

  /* ── Derived views ───────────────────────────────────────── */

  /* Running, Ready, Blocked or Inactive, from where the thread is, never from
     a field a trace could set inconsistently. */
  function threadStatus(s, th) {
    if (!th) return "Inactive";
    if (currentCoreOf(s, th.id) !== null) return "Running";
    var ipc = (th.ipc && th.ipc.state) || "ready";
    if (ipc === "inactive") return "Inactive";
    if (ipc !== "ready") return "Blocked";
    if (queuedOn(s, th.id).length) return "Ready";
    return "Inactive";
  }

  function notificationState(n) {
    if (n && n.waiters && n.waiters.length) return "waiting";
    if (n && n.pending !== null && n.pending !== undefined) return "active";
    return "idle";
  }

  /* Ids each op names, so a renderer can mark what a step changed. */
  function touched(ops) {
    var out = {};
    function add(id) { if (id !== undefined && id !== null && id !== "") out[String(id)] = true; }
    (ops || []).forEach(function (op) {
      if (!op) return;
      switch (op.op) {
        case "dispatch": case "deschedule": case "enqueue": add(op.thread); add("core:" + op.core); break;
        case "threadPatch": add(op.id); break;
        case "message": add(op.from); add(op.to); add(op.via); break;
        case "epEnqueue": case "epPopHead": add(op.endpoint); add(op.thread); break;
        case "ntfnEnqueue": case "ntfnPopHead": add(op.notification); add(op.thread); break;
        case "ntfnPatch": case "replyPatch": case "scPatch": add(op.id); break;
        case "capInsert": add(op.slot); add(op.parent); break;
        case "capDelete": case "capRevoke": add(op.slot); break;
        case "untypedCarve": add(op.untyped); if (op.child) add(op.child.id); break;
        case "untypedReset": add(op.untyped); break;
        case "vspaceMap": add(op.vspace); if (op.mapping) add(op.vspace + "@" + op.mapping.vaddr); break;
        case "vspaceUnmap": case "vspaceReject": add(op.vspace); add(op.vspace + "@" + op.vaddr); break;
        case "auditAppend": add("audit"); break;
        case "flowCheck": add(op.from); add(op.to); break;
        default: break;
      }
    });
    return out;
  }

  /* ── Executable mirrors of the catalogue's invariants ────── */

  /* Returns [{ id, message }], one per violated check, keyed by invariant id. */
  function checkState(s) {
    var out = [];
    function fail(id, message) { out.push({ id: id, message: message }); }
    var threads = s.threads || [];
    var queued = {};
    var rqs = s.runQueues || {};
    for (var k in rqs) {
      if (!hasOwn(rqs, k)) continue;
      (rqs[k] || []).forEach(function (e) {
        if (queued[e.thread] !== undefined) fail("runQueueUnique", e.thread + " is queued twice (cores " + queued[e.thread] + " and " + k + ")");
        queued[e.thread] = k;
        if (!thread(s, e.thread)) fail("runQueueUnique", "run queue " + k + " names unknown thread " + e.thread);
      });
    }
    (s.cores || []).forEach(function (c) {
      if (c.current === null || c.current === undefined) return;
      var th = thread(s, c.current);
      if (!th) { fail("currentThreadValid", "core " + c.id + " runs unknown thread " + c.current); return; }
      if (((th.ipc && th.ipc.state) || "ready") !== "ready") fail("currentThreadValid", "core " + c.id + " runs " + c.current + ", which is " + th.ipc.state);
      if (queued[c.current] !== undefined) fail("queueCurrentConsistent", c.current + " runs on core " + c.id + " and is still queued on core " + queued[c.current]);
    });
    threads.forEach(function (th) {
      var st = (th.ipc && th.ipc.state) || "ready";
      if (IPC_STATES.indexOf(st) === -1) fail("dualQueue", th.id + " has unknown IPC state " + st);
      if (st !== "ready" && queued[th.id] !== undefined) fail("blockedNotRunnable", th.id + " is " + st + " but queued to run");
      if (st !== "ready" && currentCoreOf(s, th.id) !== null) fail("blockedNotRunnable", th.id + " is " + st + " but running");
    });

    var inQueue = {};
    (s.endpoints || []).forEach(function (ep) {
      ["send", "recv"].forEach(function (qn) {
        (ep[qn] || []).forEach(function (tid) {
          if (inQueue[tid]) fail("queueNoDup", tid + " is on two endpoint queues (" + inQueue[tid] + ", " + ep.id + "." + qn + ")");
          inQueue[tid] = ep.id + "." + qn;
          var th = thread(s, tid);
          var st = th && th.ipc ? th.ipc.state : "ready";
          var ok = th && th.ipc && th.ipc.object === ep.id && (qn === "recv" ? st === "blockedOnReceive" : (st === "blockedOnSend" || st === "blockedOnCall"));
          if (!ok) fail("dualQueue", tid + " is on " + ep.id + "." + qn + " but its IPC state is " + st);
        });
      });
      if ((ep.send || []).length && (ep.recv || []).length) fail("dualQueue", ep.id + " has both senders and receivers waiting");
    });
    (s.notifications || []).forEach(function (n) {
      (n.waiters || []).forEach(function (tid) {
        if (inQueue[tid]) fail("queueNoDup", tid + " waits on " + n.id + " and on " + inQueue[tid]);
        inQueue[tid] = n.id;
        var th = thread(s, tid);
        if (!th || !th.ipc || th.ipc.state !== "blockedOnNotification" || th.ipc.object !== n.id) fail("notificationWaiters", tid + " waits on " + n.id + " but is not blockedOnNotification there");
      });
      if ((n.waiters || []).length && n.pending !== null && n.pending !== undefined) fail("notificationWaiters", n.id + " has waiters and a pending badge at once");
    });
    threads.forEach(function (th) {
      var st = th.ipc && th.ipc.state;
      if ((st === "blockedOnSend" || st === "blockedOnCall" || st === "blockedOnReceive") && !inQueue[th.id]) fail("dualQueue", th.id + " is " + st + " but on no endpoint queue");
      if (st === "blockedOnNotification" && !inQueue[th.id]) fail("notificationWaiters", th.id + " is blockedOnNotification but on no wait queue");
    });
    threads.forEach(function (th) {
      if (!th.ipc || th.ipc.state !== "blockedOnReply") return;
      if (!th.ipc.replyTo || !thread(s, th.ipc.replyTo) || th.ipc.replyTo === th.id) fail("replyWaiters", th.id + " waits for a reply from " + th.ipc.replyTo + ", which is no other thread");
    });
    (s.replies || []).forEach(function (r) {
      if (r.caller === null || r.caller === undefined) return;
      var th = thread(s, r.caller);
      if (!th || !th.ipc || th.ipc.state !== "blockedOnReply") fail("replyWaiters", r.id + " names " + r.caller + ", which is not blocked on a reply");
    });

    (s.schedContexts || []).forEach(function (sc) {
      if (!(sc.remaining >= 0 && sc.remaining <= sc.budget)) fail("budgetWithinBounds", sc.id + " has " + sc.remaining + " of a " + sc.budget + "-tick budget");
    });

    var cdt = s.cdt || {};
    var parentOf = {};
    for (var p in cdt) {
      if (!hasOwn(cdt, p)) continue;
      if (!capAt(s, p)) fail("cdtLinksAgree", "derivation parent " + p + " is an empty slot");
      (cdt[p] || []).forEach(function (c) {
        if (!capAt(s, c)) fail("cdtLinksAgree", "derivation child " + c + " is an empty slot");
        if (parentOf[c]) fail("cdtLinksAgree", c + " has two parents (" + parentOf[c] + ", " + p + ")");
        parentOf[c] = p;
      });
    }
    Object.keys(parentOf).forEach(function (c) {
      var seen = {};
      var at = c;
      while (parentOf[at]) {
        if (seen[at]) { fail("cdtAcyclic", "the derivation tree has a cycle through " + c); break; }
        seen[at] = true;
        at = parentOf[at];
      }
    });
    (s.cnodes || []).forEach(function (cn) {
      Object.keys(cn.slots || {}).forEach(function (k) {
        if (Number(k) >= slotCount(cn)) fail("cdtLinksAgree", cn.id + " holds slot " + k + " beyond its 2^" + cn.radixWidth + " slots");
      });
    });

    (s.untyped || []).forEach(function (u) {
      if (u.watermark > u.size) fail("untypedWatermark", u.id + " watermark " + u.watermark + " exceeds its " + u.size + " bytes");
      var kids = (u.children || []).slice().sort(function (a, b) { return a.offset - b.offset; });
      kids.forEach(function (ch, i) {
        if (ch.offset + ch.size > u.watermark) fail("untypedWatermark", ch.id + " ends above " + u.id + "'s watermark");
        if (i && kids[i - 1].offset + kids[i - 1].size > ch.offset) fail("untypedNonOverlap", kids[i - 1].id + " and " + ch.id + " overlap");
      });
    });

    var asids = {};
    (s.vspaces || []).forEach(function (v) {
      if (asids[v.asid]) fail("vspaceAsidUnique", v.id + " reuses ASID " + v.asid);
      asids[v.asid] = true;
      var mapped = {};
      (v.mappings || []).forEach(function (m) {
        mapped[m.vaddr] = true;
        var perms = String(m.perms || "");
        if (perms.indexOf("w") !== -1 && perms.indexOf("x") !== -1) fail("wxExclusive", v.id + " maps " + m.vaddr + " writable and executable");
      });
      (v.tlb || []).forEach(function (va) { if (!mapped[va]) fail("tlbConsistent", v.id + " caches " + va + ", which is not mapped"); });
    });
    return out;
  }

  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STEP_KINDS: STEP_KINDS,
    OPS: OPS,
    EVENT_OPS: EVENT_OPS,
    PATH_STAGES: PATH_STAGES,
    PATH_RESULTS: PATH_RESULTS,
    RIGHTS: RIGHTS,
    IPC_STATES: IPC_STATES,
    REGISTERS: REGISTERS,
    MSG_LIMITS: MSG_LIMITS,
    CAP_KINDS: CAP_KINDS,
    LABEL_CONF: LABEL_CONF,
    LABEL_INTEG: LABEL_INTEG,
    clone: clone,
    byId: byId,
    parseSlot: parseSlot,
    slotKey: slotKey,
    slotCount: slotCount,
    capAt: capAt,
    cdtChildren: cdtChildren,
    cdtParent: cdtParent,
    cdtDescendants: cdtDescendants,
    revokeOrder: revokeOrder,
    queuedOn: queuedOn,
    currentCoreOf: currentCoreOf,
    applyOp: applyOp,
    applyOps: applyOps,
    scenarioStates: scenarioStates,
    isBetterCandidate: isBetterCandidate,
    selectOnCore: selectOnCore,
    resolveCap: resolveCap,
    capHasRight: capHasRight,
    rightsMask: rightsMask,
    labelOf: labelOf,
    flowsTo: flowsTo,
    msgInfoWord: msgInfoWord,
    threadStatus: threadStatus,
    notificationState: notificationState,
    touched: touched,
    checkState: checkState
  };

  root.sele4nTraceEngine = api;
})(typeof window !== "undefined" ? window : this);
