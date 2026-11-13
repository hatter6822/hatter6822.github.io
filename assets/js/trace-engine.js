/**
 * seLe4n Simulator — trace engine (schema v4).
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
 *       `targetAccepted` the type gate (`syscallTargetAccepted`)
 *       `scTickExhausts`, `scChargeBudget`, `scReleaseReadyHead` the sporadic
 *                        refill algebra a tick and a release run
 *                        (`SchedContext.tickExhausts`, `.chargeBudget`,
 *                        `.releaseReadyHead`, `cbsUpdateDeadline`)
 *       `carvePlacement` where a retype carves (`retypeFreeIndex`,
 *                        `alignedCarveIndex`)
 *       `irqBinding`     what an interrupt line signals (`irqBinding?`)
 *       `transferPlan`   what an IPC rendezvous does with the sender's extra
 *                        capabilities (`resolveExtraCaps`, `ipcUnwrapCaps`)
 *   - **compute an effect that is a function of the state**: a budget charge
 *     (`scCharge`), a refill release (`scRelease`) and a carve's offset are
 *     arithmetic over the state the op meets, so the fold does the arithmetic
 *     and a trace names only which context or object it happened to.
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

  var SCHEMA_VERSION = 4;

  var STEP_KINDS = ["boot", "syscall", "schedule", "timer", "interrupt", "fault"];

  var OPS = [
    "dispatch", "deschedule", "enqueue",
    "threadPatch", "message",
    "epEnqueue", "epPopHead",
    "ntfnEnqueue", "ntfnPopHead", "ntfnPatch",
    "replyPatch",
    "clockTick", "scCharge", "scRelease",
    "irqPatch",
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

  /* The stages of the checked syscall path. `syscallEntryChecked` runs entry
     and decode; `syscallInvokeTyped` resolves x0 (lookup), checks the
     capability's type against the syscall (`syscallTargetAccepted`), then its
     right; the arm then decodes its own arguments and gates the information
     flow, in an order that is the arm's own (a send checks the flow after its
     bounds, a receive before anything else), and runs the operation. So the
     first five and the last are ordered, and `args` and `flow` sit between
     them in whichever order the arm has. */
  var PATH_STAGES = ["entry", "decode", "lookup", "type", "rights", "args", "flow", "operation"];
  var PATH_FIXED_PREFIX = ["entry", "decode", "lookup", "type", "rights"];
  var PATH_ARM_STAGES = ["args", "flow"];
  var PATH_RESULTS = ["pass", "fail", "skip"];

  /* `AccessRight`, in `toBit` order. */
  var RIGHTS = ["read", "write", "grant", "grantReply", "retype"];

  /* `ThreadIpcState`, by the kernel's constructor names. */
  var IPC_STATES = ["ready", "blockedOnSend", "blockedOnReceive", "blockedOnCall", "blockedOnReply", "blockedOnNotification", "inactive"];

  /* `SyscallRegisterLayout` on ARM64 (`arm64DefaultLayout`). */
  var REGISTERS = { capPtr: "x0", msgInfo: "x1", msgRegs: ["x2", "x3", "x4", "x5"], syscallNum: "x7" };

  /* `MessageInfo` bounds (`maxMessageRegisters`, `maxExtraCaps`, `maxLabel`).
     The kernel's label is 52 bits wide (seL4's `seL4_MessageInfo_t`); the
     engine admits the labels whose x1 word, shifted twelve bits up, a double
     still holds exactly, so `msgInfoWord` never rounds. */
  var MSG_LIMITS = { length: 120, extraCaps: 3, label: 2199023255551 };

  /* `syscallMissingRightError`: the answer to a capability of the syscall's
     type that lacks its right. seL4 refuses an endpoint or notification
     capability without `CanSend` or `CanReceive` as an invalid capability, and
     so does the kernel; every other missing right is `illegalAuthority`. */
  var MISSING_RIGHT_INVALID = ["send", "call", "notificationSignal", "declassifySignal", "receive", "notificationWait", "replyRecv"];
  function missingRightError(syscallId) {
    return MISSING_RIGHT_INVALID.indexOf(syscallId) !== -1 ? "invalidCapability" : "illegalAuthority";
  }

  /* `carveAlignment`: a frame, an address-space root and a page table are
     carved on a page; every other kind, a child untyped included, on a
     multiple of its own size. */
  var PAGE_BYTES = 4096;
  var PAGE_ALIGNED_KINDS = ["frame", "vspace", "pageTable"];

  var CAP_KINDS = ["endpoint", "notification", "cnode", "untyped", "frame", "vspace", "pageTable", "reply", "tcb", "schedContext", "irqControl", "irqHandler"];

  /* `syscallObjectKind?`: the kind of object a syscall's `.object` capability
     must name, by the engine's capability kinds (`vspace` is the kernel's
     `vspaceRoot`). A syscall absent from this table and from
     `SYSCALL_TARGET_KIND` invokes no object capability. */
  var SYSCALL_OBJECT_KIND = {
    send: "endpoint", receive: "endpoint", call: "endpoint", replyRecv: "endpoint",
    serviceRegister: "endpoint", serviceRevoke: "endpoint", serviceQuery: "endpoint",
    notificationSignal: "notification", notificationWait: "notification", declassifySignal: "notification",
    cspaceMint: "cnode", cspaceCopy: "cnode", cspaceMove: "cnode", cspaceDelete: "cnode", cspaceRevoke: "cnode", mintReplyCap: "cnode",
    untypedRetype: "untyped", untypedReset: "untyped",
    vspaceMap: "vspace", vspaceUnmap: "vspace", vspaceUnifyInstruction: "vspace",
    schedContextBind: "schedContext", schedContextUnbind: "schedContext", schedContextConsumed: "schedContext", schedContextYieldTo: "schedContext",
    tcbSuspend: "tcb", tcbResume: "tcb", tcbSetPriority: "tcb", tcbSetMCPriority: "tcb", tcbSetIPCBuffer: "tcb",
    tcbSetAffinity: "tcb", tcbBindNotification: "tcb", tcbUnbindNotification: "tcb", tcbSetSpace: "tcb", tcbSetFaultHandler: "tcb",
    pageTableMap: "pageTable", pageTableUnmap: "pageTable"
  };
  /* The non-object arms of `syscallTargetAccepted`: a capability whose
     `CapTarget` is not `.object` is accepted by exactly these syscalls. */
  var SYSCALL_TARGET_KIND = {
    reply: "reply",
    irqControlGet: "irqControl",
    irqHandlerAck: "irqHandler", irqHandlerSetNotification: "irqHandler", irqHandlerClear: "irqHandler"
  };
  var NON_OBJECT_KINDS = ["reply", "irqControl", "irqHandler"];

  /* `truncationMinimum`: the message length below which the arm's decode
     answers `truncatedMessage` (`requireMessageLength`). Unlisted: 0. */
  var TRUNCATION_MIN = {
    untypedRetype: 4, vspaceMap: 4, cspaceCopy: 4, cspaceMove: 4,
    irqControlGet: 3, auditRead: 3,
    mintReplyCap: 2, vspaceUnmap: 2, vspaceUnifyInstruction: 2, tcbSetSpace: 2, pageTableMap: 2,
    cspaceDelete: 1, cspaceRevoke: 1, schedContextBind: 1, tcbBindNotification: 1, tcbSetPriority: 1,
    tcbSetMCPriority: 1, tcbSetIPCBuffer: 1, tcbSetAffinity: 1, tcbSetFaultHandler: 1,
    irqHandlerSetNotification: 1, auditDrain: 1,
    schedContextConfigure: 5, serviceRegister: 5, cspaceMint: 5
  };
  /* `syscallReadsOverflow`: the syscalls whose message words past x5 are read
     from the caller's IPC buffer. */
  var READS_OVERFLOW = ["send", "call", "reply", "replyRecv", "schedContextConfigure", "serviceRegister", "cspaceMint"];

  /* `maxReplenishments`: the pending refills a scheduling context holds. */
  var MAX_REFILLS = 8;
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
     new child the first child; `cdtSplice` takes a slot out with its children
     taking its place among its siblings, in their own order
     (`linkSpliceNode`); with no parent the children become roots. */

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
    if (parent) {
      var siblings = cdtChildren(s, parent);
      var at = siblings.indexOf(key);
      s.cdt[parent] = siblings.slice(0, at).concat(kids, siblings.slice(at + 1));
    }
    delete s.cdt[key];
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
    var gone = cn.slots[String(ref.slot)];
    delete cn.slots[String(ref.slot)];
    retireIfFinal(s, gone);
  }
  /* seL4's `finaliseCap` on the last capability to an object: a carved object
     leaves the store with its final capability, and the untyped that recorded
     it forgets it (`retireCarvedObject`, `retireUnrecord`). The projection
     keeps carved objects only as their untyped's child records, so that record
     is what goes. */
  function retireIfFinal(s, cap) {
    if (!cap || !cap.target) return;
    var named = (s.cnodes || []).some(function (cn) {
      var slots = cn.slots || {};
      for (var k in slots) if (hasOwn(slots, k) && slots[k] && slots[k].target === cap.target) return true;
      return false;
    });
    if (named) return;
    (s.untyped || []).forEach(function (u) {
      u.children = (u.children || []).filter(function (ch) { return ch.id !== cap.target; });
    });
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

  /* The slot of the untyped capability a carve or a reset is invoked through:
     the free index is that capability's (seL4's `capFreeIndex`), and whether
     its slot has derivation children decides where a carve starts. */
  function untypedAuthority(s, op, name) {
    var cap = capAt(s, op.slot);
    if (!cap || cap.kind !== "untyped" || cap.target !== op.untyped) throw new Error(name + ": slot " + op.slot + " holds no capability to " + op.untyped);
    return op.slot;
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
      case "replyPatch": {
        var obj = op.op === "ntfnPatch" ? notification(s, op.id) : reply(s, op.id);
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
        var via = untypedAuthority(s, op, "untypedCarve");
        if (!Array.isArray(ut.children)) ut.children = [];
        /* `retypeFreeIndex`: the capability's own free index while its slot
           has a derivation child, and 0 otherwise — a childless untyped
           capability is reset by the carve (seL4's `decodeUntypedInvocation`),
           which refuses while the region still records a carved object. */
        var place = carvePlacement(s, via, child);
        if (place.error) throw new Error("untypedCarve: " + place.message + " (" + place.error + ")");
        ut.children.unshift({ id: child.id, kind: child.kind, offset: place.at, size: child.size });
        /* `setCapFreeIndex`: the authority capability's own word, in its slot. */
        capAt(s, via).freeIndex = place.at + child.size;
        return s;
      }
      case "untypedReset": {
        var ur = untyped(s, op.untyped);
        if (!ur) throw new Error("untypedReset: unknown untyped " + op.untyped);
        var rv = untypedAuthority(s, op, "untypedReset");
        /* `untypedResetSlot`: refused while the slot has a derivation child or
           the region records a carved object; otherwise one word, the
           capability's free index, is written 0. Nothing is erased here: the
           carved objects left with their final capabilities. */
        if (cdtChildren(s, rv).length || (ur.children || []).length) throw new Error("untypedReset: " + op.untyped + " still has carved objects or derived capabilities (revocationRequired)");
        capAt(s, rv).freeIndex = 0;
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
      case "clockTick": {
        /* `tickClockedState`: the boot core's tick advances the one timer. */
        s.time = (Number(s.time) || 0) + 1;
        return s;
      }
      case "scCharge": {
        /* `timerTickBudgetOnCore` on a bound thread: one tick, run from
           `now - 1` to `now`. A tick that uses the head up takes the spend's
           arm (`spendBudgetOnCore`: the charge, the deadline rule, the context
           placed on the core's release queue); any other tick is the charge
           alone. Which arm is the state's to say (`tickExhausts`). */
        var cs = schedContext(s, op.sc);
        if (!cs) throw new Error("scCharge: unknown scheduling context " + op.sc);
        var cc = core(s, op.core);
        if (!cc) throw new Error("scCharge: unknown core " + op.core);
        var runner = cc.current === null || cc.current === undefined ? null : thread(s, cc.current);
        if (!runner || runner.sc !== op.sc) throw new Error("scCharge: core " + op.core + " is not running a thread bound to " + op.sc);
        var nowC = Number(s.time) || 0;
        if (nowC < 1) throw new Error("scCharge: no tick has elapsed");
        var exhausted = scTickExhausts(cs, nowC - 1);
        var charged = scChargeBudget(cs, nowC - 1, 1, nowC);
        if (exhausted) charged = cbsUpdateDeadline(charged, nowC, true);
        replaceSc(s, charged);
        if (exhausted) releasePlace(s, op.core, op.sc);
        return s;
      }
      case "scRelease": {
        /* One turn of `drainDueOnCore`: the head of the core's release queue,
           released by now, is refilled (`refillSchedContext`) and placed again
           by the refills it has left (`releasePlace`). */
        var rq2 = releaseQueue(s, op.core);
        if (rq2[0] !== op.sc) throw new Error("scRelease: " + op.sc + " is not the head of core " + op.core + "'s release queue");
        var rs = schedContext(s, op.sc);
        if (!rs) throw new Error("scRelease: unknown scheduling context " + op.sc);
        var nowR = Number(s.time) || 0;
        var key = scReleaseKey(rs);
        if (key === null || key > nowR) throw new Error("scRelease: " + op.sc + " is not released until " + key + " (now " + nowR + ")");
        replaceSc(s, cbsUpdateDeadline(scReleaseReadyHead(rs, nowR), nowR, true));
        releasePlace(s, op.core, op.sc);
        return s;
      }
      case "irqPatch": {
        var line = irqLine(s, op.line);
        if (!line) throw new Error("irqPatch: unknown interrupt line " + op.line);
        var is = op.set || {};
        for (var ik in is) {
          if (!hasOwn(is, ik)) continue;
          if (ik !== "active" && ik !== "masked") throw new Error("irqPatch: only active and masked are written");
          line[ik] = !!is[ik];
        }
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
    var r = resolveCapSlot(s, threadId, cptr);
    if (r.error) return r;
    if (!r.cap) return { error: "invalidCapability", reason: "empty", slot: r.slot, levels: r.levels };
    return r;
  }
  /* `resolveCapAddress` alone: the slot an address names, occupied or not. */
  function resolveCapSlot(s, threadId, cptr) {
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
      if (shift === 0) return { slot: key, cap: cap, levels: levels };
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

  /* `securityFlowsTo`: confidentiality may only rise, and the destination must
     be at least as trusted as the source (`integrityFlowsTo dst src`). This is
     the kernel's authority order, deliberately not Biba's: an untrusted source
     may reach a trusted destination, a trusted one may not reach an untrusted. */
  function labelOf(s, entityId) {
    var ent = thread(s, entityId) || endpoint(s, entityId) || notification(s, entityId) || cnode(s, entityId) || vspace(s, entityId) || untyped(s, entityId);
    return ent && ent.label ? label(s, ent.label) : label(s, entityId);
  }
  function flowsTo(src, dst) {
    if (!src || !dst) return false;
    var conf = src.conf === "low" || dst.conf === "high";
    var integ = dst.integ === "trusted" || src.integ === "untrusted";
    return conf && integ;
  }

  /* `MessageInfo.encode`: length | extraCaps << 7 | capsUnwrapped << 9 |
     label << 12 (seL4's `seL4_MessageInfo_t`). A caller sends capsUnwrapped 0;
     the kernel fills it for a receiver. */
  function msgInfoWord(mi) {
    mi = mi || {};
    return (Number(mi.length) || 0) + (Number(mi.extraCaps) || 0) * 128 + (Number(mi.capsUnwrapped) || 0) * 512 + (Number(mi.label) || 0) * 4096;
  }

  /* ── The type gate (`syscallTargetAccepted`) ─────────────── */

  /* A capability is of the syscall's type when its target constructor is the
     one the syscall invokes and, for an object capability, the object is of
     the syscall's kind. `declassify` releases into any object. The yield
     invokes no capability and accepts none. */
  function targetAccepted(syscallId, cap) {
    if (!cap) return false;
    if (NON_OBJECT_KINDS.indexOf(cap.kind) !== -1) return SYSCALL_TARGET_KIND[syscallId] === cap.kind;
    if (hasOwn(SYSCALL_OBJECT_KIND, syscallId)) return SYSCALL_OBJECT_KIND[syscallId] === cap.kind;
    return syscallId === "declassify";
  }
  function expectedKind(syscallId) {
    if (hasOwn(SYSCALL_OBJECT_KIND, syscallId)) return SYSCALL_OBJECT_KIND[syscallId];
    if (hasOwn(SYSCALL_TARGET_KIND, syscallId)) return SYSCALL_TARGET_KIND[syscallId];
    return null;
  }
  function truncationMinimum(syscallId) { return hasOwn(TRUNCATION_MIN, syscallId) ? TRUNCATION_MIN[syscallId] : 0; }
  function readsOverflow(syscallId) { return READS_OVERFLOW.indexOf(syscallId) !== -1; }

  /* The fields of x1, at the positions `MessageInfo.encode` puts them. */
  function msgInfoFields(mi) {
    mi = mi || {};
    return [
      { name: "length", lo: 0, width: 7, value: Number(mi.length) || 0 },
      { name: "extraCaps", lo: 7, width: 2, value: Number(mi.extraCaps) || 0 },
      { name: "capsUnwrapped", lo: 9, width: 3, value: Number(mi.capsUnwrapped) || 0 },
      { name: "label", lo: 12, width: 52, value: Number(mi.label) || 0 }
    ];
  }

  /* ── Untyped memory (`retypeFromUntyped`) ────────────────── */

  /* Where a carve of `child` through the untyped capability in `slotKeyStr`
     lands. `retypeFreeIndex`: the capability's own free index while its slot
     has a derivation child, and 0 otherwise — a childless untyped capability
     is reset by the carve (seL4's `decodeUntypedInvocation`), which refuses
     while the region still records a carved object (`retypeResetAdmitted`).
     `alignedCarveIndex`: rounded up so the carve's base is on its boundary. */
  function carvePlacement(s, slotKeyStr, child) {
    var cap = capAt(s, slotKeyStr);
    var ut = cap && cap.kind === "untyped" ? untyped(s, cap.target) : null;
    if (!ut) return { error: "untypedTypeMismatch", message: slotKeyStr + " holds no untyped capability" };
    var derived = cdtChildren(s, slotKeyStr).length > 0;
    if (!derived && (ut.children || []).length) return { error: "revocationRequired", message: ut.id + " still records carved objects" };
    var from = derived ? (Number(cap.freeIndex) || 0) : 0;
    var align = PAGE_ALIGNED_KINDS.indexOf(child.kind) !== -1 ? PAGE_BYTES : child.size;
    var base = Number(ut.base) || 0;
    var at = Math.ceil((base + from) / align) * align - base;
    var out = { from: from, reset: !derived, align: align, at: at, end: at + child.size, skipped: at - from };
    if (at + child.size > ut.size) { out.error = "untypedRegionExhausted"; out.message = child.size + " bytes do not fit at free index " + at; }
    return out;
  }

  /* What x2 of an `untypedRetype` asks for (`decodeUntypedRetypeArgs`): the
     object type tag in the low byte (`KernelObjectType.ofNat?`) and the size
     exponent above it. `carveRequestOf` gives the two kinds the scenarios
     carve a size: a frame is one page and takes sizeBits 0; an untyped is
     2^sizeBits bytes. `kind` is null for a tag this projection does not
     model, and for a size the kernel would refuse. */
  var RETYPE_TAG_FRAME = 8;
  var RETYPE_TAG_UNTYPED = 5;
  function retypeRequest(word) {
    var w = Number(word) || 0;
    var out = { tag: w % 256, sizeBits: Math.floor(w / 256), kind: null, size: null };
    if (out.tag === RETYPE_TAG_FRAME && out.sizeBits === 0) { out.kind = "frame"; out.size = PAGE_BYTES; }
    else if (out.tag === RETYPE_TAG_UNTYPED && out.sizeBits > 0) { out.kind = "untyped"; out.size = pow2(out.sizeBits); }
    return out;
  }

  /* ── Sporadic refills (`SchedContext/Budget.lean`) ───────────
     A context's head refill is `remaining` ticks released at `periodStart`;
     `refills` are the pending ones behind it, oldest first, each
     `{ amount, at }`. Every function returns a new context. */

  function scCopy(sc) {
    var c = clone(sc);
    c.remaining = Number(c.remaining) || 0;
    c.periodStart = Number(c.periodStart) || 0;
    c.refills = Array.isArray(c.refills) ? c.refills : [];
    return c;
  }
  /* `scheduleUsed`: the amount used returns one period after the head it came
     from was released. It joins the last pending refill when the two touch,
     is forced into it when the list is full, and is a new refill otherwise. */
  function scScheduleUsed(sc, amount, at) {
    var n = sc.refills.length;
    if (n) {
      var last = sc.refills[n - 1];
      if (at <= last.at + last.amount) last.amount += amount;
      else if (n >= MAX_REFILLS) { var la = last.amount; last.amount = la + amount; last.at = at - la; }
      else sc.refills.push({ amount: amount, at: at });
    } else sc.refills.push({ amount: amount, at: at });
    return sc;
  }
  /* `refillUnblockCheck`: a head released by `t` is moved to `t`, and the
     pending refills it now overlaps merge into it (`mergeOverlapping`). */
  function scUnblockCheck(sc, t) {
    if (!(sc.remaining > 0 && sc.periodStart <= t)) return sc;
    sc.periodStart = t;
    while (sc.refills.length && sc.refills[0].at <= sc.periodStart + sc.remaining) sc.remaining += sc.refills.shift().amount;
    return sc;
  }
  /* `refillBudgetCheck`: charge `usage` to the head. */
  function scBudgetCheck(sc, usage) {
    var b = sc.remaining;
    var used = sc.periodStart + (Number(sc.period) || 0);
    if (usage === 0 || b === 0) return sc;
    if (b <= usage) { sc.remaining = 0; return scScheduleUsed(sc, b, used); }
    sc.remaining = b - usage;
    sc.periodStart = sc.periodStart + usage;
    return scScheduleUsed(sc, usage, used);
  }
  /* `releaseReadyHead`: while the head is used up and the first pending refill
     is released by `now`, that refill becomes the head. */
  function scReleaseReadyHead(sc, now) {
    var out = scCopy(sc);
    for (var fuel = 0; fuel < MAX_REFILLS; fuel++) {
      if (!(out.remaining === 0 && out.refills.length && out.refills[0].at <= now)) break;
      var r = out.refills.shift();
      out.remaining = r.amount;
      out.periodStart = r.at;
    }
    return out;
  }
  /* `chargeBudget`: `usage` run from `start` to `now`. */
  function scChargeBudget(sc, start, usage, now) {
    var out = scReleaseReadyHead(scBudgetCheck(scUnblockCheck(scCopy(sc), start), usage), now);
    out.consumed = (Number(out.consumed) || 0) + (now - start);
    return out;
  }
  /* `tickExhausts`: this tick uses the head up, and no pending refill would
     merge into it first. */
  function scTickExhausts(sc, start) {
    var c = scCopy(sc);
    var merges = c.remaining > 0 && c.periodStart <= start && c.refills.length > 0 &&
      c.refills[0].at <= start + c.remaining && c.refills[0].amount > 0;
    return c.remaining <= 1 && !merges;
  }
  /* `cbsUpdateDeadline`: a context that was exhausted and holds budget again
     gets a new deadline one period from now. */
  function cbsUpdateDeadline(sc, now, wasExhausted) {
    var out = scCopy(sc);
    if (wasExhausted && out.remaining > 0) out.deadline = now + (Number(out.period) || 0);
    return out;
  }
  /* `releaseKey?`: a context's place on a release queue — its first pending
     refill's release time while its head is used up. */
  function scReleaseKey(sc) {
    var c = scCopy(sc);
    return c.remaining === 0 && c.refills.length ? c.refills[0].at : null;
  }
  function replaceSc(s, next) {
    var list = s.schedContexts || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === next.id) list[i] = next;
  }
  function releaseQueue(s, coreId) {
    if (!s.releaseQueues) s.releaseQueues = {};
    var key = String(coreId);
    if (!Array.isArray(s.releaseQueues[key])) s.releaseQueues[key] = [];
    return s.releaseQueues[key];
  }
  function releaseCoreOf(s, scId) {
    var rqs = s.releaseQueues || {};
    for (var k in rqs) if (hasOwn(rqs, k) && (rqs[k] || []).indexOf(scId) !== -1) return Number(k);
    return null;
  }
  /* `releasePlace`: off the core's queue, then linked in at its place, behind
     every entry released no later (`ReplenishQueue.insert`) — or left off when
     it has no place. A context linked on another core's queue is left alone
     (`releaseFreeFor`). */
  function releasePlace(s, coreId, scId) {
    var on = releaseCoreOf(s, scId);
    if (on !== null && on !== coreId) return;
    var q = releaseQueue(s, coreId).filter(function (id) { return id !== scId; });
    var sc = schedContext(s, scId);
    var key = sc ? scReleaseKey(sc) : null;
    if (key !== null) {
      var at = q.length;
      for (var i = 0; i < q.length; i++) {
        var other = schedContext(s, q[i]);
        var ok = other ? scReleaseKey(other) : null;
        if (ok !== null && ok > key) { at = i; break; }
      }
      q.splice(at, 0, scId);
    }
    s.releaseQueues[String(coreId)] = q;
  }

  /* ── Interrupt lines (`Architecture/InterruptMask.lean`) ─── */

  function irqLine(s, lineNo) {
    var lines = s.irqs || [];
    for (var i = 0; i < lines.length; i++) if (lines[i].line === lineNo) return lines[i];
    return null;
  }
  /* The line's interrupt node: a one-slot CNode at a reserved id that no
     capability names (`irqNodeId`). */
  function irqNodeSlot(s, lineNo) {
    var cns = s.cnodes || [];
    for (var i = 0; i < cns.length; i++) if (cns[i].irqNode === lineNo) return slotKey(cns[i].id, 0);
    return null;
  }
  /* `irqBinding?`: a line at IRQSignal whose node slot holds a notification
     capability with the send right signals that notification with the
     capability's badge. Anything else is delivered to no one. */
  function irqBinding(s, lineNo) {
    var line = irqLine(s, lineNo);
    if (!line || !line.active) return null;
    var key = irqNodeSlot(s, lineNo);
    var cap = key ? capAt(s, key) : null;
    if (!cap || cap.kind !== "notification" || !capHasRight(cap, "write") || !notification(s, cap.target)) return null;
    return { notification: cap.target, badge: Number(cap.badge) || 0, slot: key };
  }

  /* ── Capability transfer at an IPC rendezvous ─────────────
     `resolveExtraCaps`: a sender without the grant right transfers nothing
     and its addresses are not looked up; with it the lookup is all or nothing,
     and the capabilities are the slots' contents up to the first empty one.
     `ipcUnwrapCapsLoop`: a capability to the endpoint the message was sent on
     is unwrapped to its badge; the first other one is installed in the
     receiver's receive slot, which that uses up; the loop stops at the first
     capability it cannot place. `ipcTransferSingleCap` installs the same
     capability (minus any mapping record) as a derivation child of the slot
     it came from, and refuses an untyped whose slot has children. */
  function transferPlan(s, senderId, endpointCap, endpointId, extraCaps, receiverId) {
    var out = { granted: capHasRight(endpointCap, "grant"), results: [], resolved: [] };
    if (!out.granted) { out.reason = "noGrant"; return out; }
    var caps = [];
    var i;
    for (i = 0; i < (extraCaps || []).length; i++) {
      var r = resolveCapSlot(s, senderId, extraCaps[i]);
      if (r.error) { out.reason = "lookupFailed"; out.resolved = []; return out; }
      out.resolved.push(r.slot);
      caps.push({ slot: r.slot, cap: capAt(s, r.slot) });
    }
    var firstEmpty = caps.length;
    for (i = 0; i < caps.length; i++) if (!caps[i].cap) { firstEmpty = i; break; }
    caps = caps.slice(0, firstEmpty);
    var recv = thread(s, receiverId);
    var slot = recv && recv.recvSlot && parseSlot(recv.recvSlot) && cnode(s, parseSlot(recv.recvSlot).cnode) && !capAt(s, recv.recvSlot) ? recv.recvSlot : null;
    for (i = 0; i < caps.length; i++) {
      var c = caps[i];
      if (c.cap.kind !== "reply" && NON_OBJECT_KINDS.indexOf(c.cap.kind) === -1 && c.cap.target === endpointId) {
        out.results.push({ kind: "unwrapped", from: c.slot, badge: Number(c.cap.badge) || 0 });
        continue;
      }
      if (!slot) { out.reason = "noReceiveSlot"; break; }
      if (c.cap.kind === "untyped" && cdtChildren(s, c.slot).length) { out.reason = "revocationRequired"; break; }
      out.results.push({ kind: "installed", from: c.slot, to: slot, cap: c.cap });
      slot = null;
    }
    return out;
  }

  /* ── Whole kernel entries that take no argument ───────────
     A timer tick, a reschedule and a device interrupt are total functions of
     the state: nothing a caller passes can change what they do. So the engine
     writes out the ops each one consists of, and a trace's step of that kind
     is checked against the list rather than believed. */

  var DEFAULT_TIME_SLICE = 5;   /* `SchedulerState.configDefaultTimeSlice` */
  var BOOT_CORE = 0;            /* `bootCoreId` */

  /* `handleRescheduleOnCoreState`: the best eligible candidate takes the core
     only when the core is idle, its current thread is outside the active
     domain, or the candidate outranks it in the selector's own order
     (`isBetterCandidate` on the effective parameters). The outgoing thread
     goes back on the queue's tail (`preemptCurrentOnCore`). */
  function rescheduleOps(s, coreId) {
    var c = core(s, coreId);
    var ops = [];
    if (!c) return ops;
    var pick = selectOnCore(s, coreId);
    var cur = c.current === null || c.current === undefined ? null : thread(s, c.current);
    /* Nothing eligible: a running thread keeps the core, and an empty core
       takes the idle fallback, which the projection writes as `null`. */
    if (!pick.thread) return cur ? ops : [{ op: "dispatch", core: coreId, thread: null }];
    if (cur) {
      var cp = effectiveParams(s, cur);
      var np = effectiveParams(s, thread(s, pick.thread));
      var outside = (Number(cur.domain) || 0) !== (Number(c.domain) || 0);
      if (!outside && !isBetterCandidate(cp.prio, cp.deadline, np.prio, np.deadline)) return ops;
      ops.push({ op: "enqueue", thread: cur.id, core: coreId, prio: cp.prio });
    }
    ops.push({ op: "dispatch", core: coreId, thread: pick.thread });
    return ops;
  }

  /* `perCoreTimerTickStep`: the clock (boot core only), the core's due
     releases, the charge to the thread it runs, and the scheduling point. */
  function timerTickOps(s, coreId) {
    var w = clone(s);
    var ops = [];
    function emit(op) { ops.push(op); applyOp(w, op); }
    var c = core(w, coreId);
    if (!c) return ops;
    if (coreId === BOOT_CORE) emit({ op: "clockTick" });
    var now = Number(w.time) || 0;
    var flagged = false;
    /* `processReplenishmentsDueOnCore`. */
    for (var fuel = releaseQueue(w, coreId).length; fuel > 0; fuel--) {
      var headId = releaseQueue(w, coreId)[0];
      var head = headId ? schedContext(w, headId) : null;
      var key = head ? scReleaseKey(head) : null;
      if (key === null || key > now) break;
      var wasExhausted = head.remaining === 0;
      emit({ op: "scRelease", sc: headId, core: coreId });
      var after = schedContext(w, headId);
      if (wasExhausted && after.remaining > 0) {
        /* `refillWakeOnCore`: the bound thread, runnable and running nowhere,
           is queued on its home core unless it already is, and that core's
           decision is stale either way. */
        var bound = null;
        (w.threads || []).forEach(function (th) { if (th.sc === headId) bound = th; });
        if (bound && ((bound.ipc && bound.ipc.state) || "ready") === "ready" && currentCoreOf(w, bound.id) === null) {
          var home = Number(bound.core) || 0;
          if (!queuedOn(w, bound.id).length) emit({ op: "enqueue", thread: bound.id, core: home, prio: Number(bound.priority) || 0 });
          if (home === coreId) flagged = true;
        }
      }
    }
    var cur = c.current === null || c.current === undefined ? null : thread(w, c.current);
    var redispatch = false;
    if (cur) {
      var prio = Number(cur.priority) || 0;
      if (cur.sc && schedContext(w, cur.sc)) {
        var spent = scTickExhausts(schedContext(w, cur.sc), now - 1);
        emit({ op: "scCharge", sc: cur.sc, core: coreId });
        if (spent) { emit({ op: "enqueue", thread: cur.id, core: coreId, prio: prio }); redispatch = true; }
      } else if (!cur.sc) {
        if ((Number(cur.timeSlice) || 0) <= 1) {
          emit({ op: "threadPatch", id: cur.id, set: { timeSlice: DEFAULT_TIME_SLICE } });
          emit({ op: "enqueue", thread: cur.id, core: coreId, prio: prio });
          redispatch = true;
        } else emit({ op: "threadPatch", id: cur.id, set: { timeSlice: cur.timeSlice - 1 } });
      }
    }
    if (redispatch) {
      /* `scheduleEffectiveOnCoreState`: the outgoing thread is already queued;
         the best eligible one runs, or the core idles. */
      emit({ op: "dispatch", core: coreId, thread: selectOnCore(w, coreId).thread });
    } else if (flagged) {
      rescheduleOps(w, coreId).forEach(emit);
    }
    return ops;
  }

  function orBits(a, b) {
    var out = 0;
    for (var bit = 1; bit <= a || bit <= b; bit *= 2) if (Math.floor(a / bit) % 2 || Math.floor(b / bit) % 2) out += bit;
    return out;
  }

  /* `handleInterruptOnCore`: a bound line signals its notification with the
     node capability's badge — the head waiter woken with the badge, or the
     badge OR-ed into the pending word — and is masked until the handler
     acknowledges it; an unbound line is masked and reaches no one. */
  function interruptOps(s, lineNo) {
    var ops = [];
    var b = irqBinding(s, lineNo);
    if (b) {
      var n = notification(s, b.notification);
      var waiter = n.waiters && n.waiters.length ? thread(s, n.waiters[0]) : null;
      if (waiter) {
        ops.push({ op: "ntfnPopHead", notification: n.id, thread: waiter.id });
        ops.push({ op: "threadPatch", id: waiter.id, set: { ipc: { state: "ready" }, msg: { from: null, via: n.id, words: [], label: 0, badge: b.badge } } });
        ops.push({ op: "enqueue", thread: waiter.id, core: Number(waiter.core) || 0, prio: Number(waiter.priority) || 0 });
      } else {
        var had = n.pending === null || n.pending === undefined ? 0 : Number(n.pending) || 0;
        ops.push({ op: "ntfnPatch", id: n.id, set: { pending: orBits(had, b.badge) } });
      }
    }
    ops.push({ op: "irqPatch", line: lineNo, set: { masked: true } });
    return ops;
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
        case "ntfnPatch": case "replyPatch": add(op.id); break;
        case "clockTick": add("clock"); break;
        case "scCharge": case "scRelease": add(op.sc); add("release:" + op.core); break;
        case "irqPatch": add("irq:" + op.line); break;
        case "capInsert": add(op.slot); add(op.parent); break;
        case "capDelete": case "capRevoke": add(op.slot); break;
        case "untypedCarve": add(op.untyped); add(op.slot); if (op.child) add(op.child.id); break;
        case "untypedReset": add(op.untyped); add(op.slot); break;
        case "vspaceMap": add(op.vspace); if (op.mapping) add(op.vspace + "@" + op.mapping.vaddr); break;
        case "vspaceUnmap": case "vspaceReject": add(op.vspace); add(op.vspace + "@" + op.vaddr); break;
        case "auditAppend": add("audit"); break;
        case "flowCheck": add(op.from); add(op.to); break;
        default: break;
      }
    });
    return out;
  }

  /* ── Which proofs speak for a step ───────────────────────── */

  /* A step is one kernel transition: a syscall's arm, or an entry that takes
     no argument. Its key is what a catalogue theorem's `covers` names. */
  var ANY_SYSCALL = "syscall";
  function transitionKey(step) {
    if (!step) return "";
    return step.kind === "syscall" && step.syscall ? String(step.syscall.id) : String(step.kind || "");
  }
  /* The `preservedBy` theorems of an invariant that are about the transition
     this step is. A refused step is no transition (an error carries no
     state), and neither is the initial state, so nothing covers them. The
     build checks each `covers` claim against the kernel's call graph
     (`scripts/validate-traces.mjs`); nothing here is believed for itself. */
  function proofsCovering(inv, step) {
    if (!inv || !step || step.kind === "boot") return [];
    if (step.outcome && step.outcome.status === "error") return [];
    var key = transitionKey(step);
    return (inv.preservedBy || []).filter(function (p) {
      var covers = (p && p.covers) || [];
      return covers.indexOf(key) !== -1 || (step.kind === "syscall" && covers.indexOf(ANY_SYSCALL) !== -1);
    });
  }
  /* `SeLe4n.Kernel.API` → `SeLe4n/Kernel/API.lean`: a module is its file. */
  function modulePath(module) {
    var m = String(module === null || module === undefined ? "" : module);
    return /^[A-Z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(m) ? m.replace(/\./g, "/") + ".lean" : "";
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
      /* `currentThreadValidOnCore` says only that the current thread resolves;
         that it is not blocked is `blockedNotRunnable`'s to say, below. */
      if (!th) { fail("currentThreadValid", "core " + c.id + " runs unknown thread " + c.current); return; }
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

    var releasedOn = {};
    var rlq = s.releaseQueues || {};
    for (var rk in rlq) {
      if (!hasOwn(rlq, rk)) continue;
      var lastKey = null;
      (rlq[rk] || []).forEach(function (scId) {
        var qsc = schedContext(s, scId);
        var qk = qsc ? scReleaseKey(qsc) : null;
        if (releasedOn[scId] !== undefined) fail("refillsSound", scId + " is on two release queues (cores " + releasedOn[scId] + " and " + rk + ")");
        releasedOn[scId] = rk;
        if (qk === null) { fail("refillsSound", "core " + rk + "'s release queue holds " + scId + ", which has no refill to wait for"); return; }
        if (lastKey !== null && qk < lastKey) fail("refillsSound", "core " + rk + "'s release queue is out of order at " + scId);
        lastKey = qk;
        if (!threads.some(function (th) { return th.sc === scId; })) fail("refillsSound", scId + " is queued for release but bound to no thread");
      });
    }
    (s.schedContexts || []).forEach(function (sc) {
      if (!(sc.remaining >= 0 && sc.remaining <= sc.budget)) fail("budgetWithinBounds", sc.id + " has " + sc.remaining + " of a " + sc.budget + "-tick budget");
      var pending = 0;
      (sc.refills || []).forEach(function (r) { pending += Number(r.amount) || 0; });
      if (sc.budget > sc.period) fail("budgetWithinBounds", sc.id + " has a " + sc.budget + "-tick budget in a " + sc.period + "-tick period");
      /* `refillsConserved`: the head and the pending refills sum to the
         budget, exactly — what makes the one-budget-per-period bound exact. */
      if ((Number(sc.remaining) || 0) + pending !== sc.budget) fail("refillsSound", sc.id + " holds " + ((Number(sc.remaining) || 0) + pending) + " ticks in its head and refills; its budget is " + sc.budget);
      if ((sc.refills || []).length > MAX_REFILLS) fail("refillsSound", sc.id + " holds more than " + MAX_REFILLS + " pending refills");
      var bound = threads.some(function (th) { return th.sc === sc.id && ((th.ipc && th.ipc.state) || "ready") !== "inactive"; });
      if (bound && scReleaseKey(sc) !== null && releasedOn[sc.id] === undefined) fail("refillsSound", sc.id + " is used up with a refill pending, but on no release queue: nothing would ever release it");
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
      /* The free index is the capability's (seL4's `capFreeIndex`). Every
         carved object lies below the highest one a capability to the region
         records, and none passes the region's end. */
      var top = 0;
      (s.cnodes || []).forEach(function (cn) {
        var slots = cn.slots || {};
        for (var sk in slots) {
          if (!hasOwn(slots, sk) || !slots[sk] || slots[sk].kind !== "untyped" || slots[sk].target !== u.id) continue;
          var fi = Number(slots[sk].freeIndex) || 0;
          if (fi > u.size) fail("untypedWatermark", cn.id + "/" + sk + " records free index " + fi + ", past " + u.id + "'s " + u.size + " bytes");
          if (fi > top) top = fi;
        }
      });
      var kids = (u.children || []).slice().sort(function (a, b) { return a.offset - b.offset; });
      kids.forEach(function (ch, i) {
        if (ch.offset + ch.size > top) fail("untypedWatermark", ch.id + " ends above every free index a capability to " + u.id + " records");
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
    PATH_FIXED_PREFIX: PATH_FIXED_PREFIX,
    PATH_ARM_STAGES: PATH_ARM_STAGES,
    SYSCALL_OBJECT_KIND: SYSCALL_OBJECT_KIND,
    SYSCALL_TARGET_KIND: SYSCALL_TARGET_KIND,
    TRUNCATION_MIN: TRUNCATION_MIN,
    READS_OVERFLOW: READS_OVERFLOW,
    MISSING_RIGHT_INVALID: MISSING_RIGHT_INVALID,
    MAX_REFILLS: MAX_REFILLS,
    PAGE_BYTES: PAGE_BYTES,
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
    resolveCapSlot: resolveCapSlot,
    targetAccepted: targetAccepted,
    expectedKind: expectedKind,
    truncationMinimum: truncationMinimum,
    readsOverflow: readsOverflow,
    msgInfoFields: msgInfoFields,
    bitsAt: bitsAt,
    carvePlacement: carvePlacement,
    retypeRequest: retypeRequest,
    scTickExhausts: scTickExhausts,
    scChargeBudget: scChargeBudget,
    scReleaseReadyHead: scReleaseReadyHead,
    scReleaseKey: scReleaseKey,
    cbsUpdateDeadline: cbsUpdateDeadline,
    releaseCoreOf: releaseCoreOf,
    effectiveParams: effectiveParams,
    irqLine: irqLine,
    irqNodeSlot: irqNodeSlot,
    irqBinding: irqBinding,
    transferPlan: transferPlan,
    DEFAULT_TIME_SLICE: DEFAULT_TIME_SLICE,
    BOOT_CORE: BOOT_CORE,
    rescheduleOps: rescheduleOps,
    timerTickOps: timerTickOps,
    interruptOps: interruptOps,
    orBits: orBits,
    capHasRight: capHasRight,
    missingRightError: missingRightError,
    rightsMask: rightsMask,
    labelOf: labelOf,
    flowsTo: flowsTo,
    msgInfoWord: msgInfoWord,
    threadStatus: threadStatus,
    notificationState: notificationState,
    touched: touched,
    ANY_SYSCALL: ANY_SYSCALL,
    transitionKey: transitionKey,
    proofsCovering: proofsCovering,
    modulePath: modulePath,
    checkState: checkState
  };

  root.sele4nTraceEngine = api;
})(typeof window !== "undefined" ? window : this);
