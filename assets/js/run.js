/**
 * seLe4n Simulator — browser runtime.
 *
 * Replays kernel execution traces and shows, for every step, three things a
 * developer needs: what the kernel did (the state change, drawn), how it got
 * there (the checked syscall path, stage by stage, with the stage that refused
 * a call), and why that is safe (the security properties the step relies on
 * and the invariants it preserves, each linked to the Lean declaration that
 * states or proves it).
 *
 * Every name the page shows is grounded: `scripts/sync-upstream.mjs` resolves
 * each `{ name, module }` in the trace against the pinned kernel checkout and
 * stamps `path` and `line`, and `data.sourceRef` names that commit. A link is
 * built from those fields only, so it always opens the revision its line was
 * read from (`scripts/lib/trace-anchors.mjs`).
 *
 * Design constraints (match the rest of the site):
 *   - Vanilla ES5-style IIFE, no frameworks, strict CSP (no inline/eval).
 *   - Bundle-only: the page reads `data/execution-traces.json` and nothing
 *     else (`connect-src 'self'`). There is no live refresh and no cache: the
 *     kernel exports no JSON traces, and a remote document could not have been
 *     grounded against the revision the bundle was.
 *
 * The embedded fold engine is a faithful re-implementation of
 * scripts/lib/trace-analysis.mjs (which the Node tests pin down). It applies the
 * effects a trace already recorded; it never re-implements kernel semantics.
 */
(function () {
  "use strict";

  /* ── i18n helper (returns "" so callers can || a literal fallback) ──
     The first locale load dispatches no `sele4n:locale-changed`, so a label
     painted before it arrived would stay English. `t()` records that it ran
     early, and the ready callback (setupLocaleReady) repaints once if so. */
  var localeReady = false;
  var paintedBeforeLocale = false;
  function t(key, vars) {
    if (!localeReady) paintedBeforeLocale = true;
    if (window.sele4nI18n && typeof window.sele4nI18n.t === "function") {
      var result = window.sele4nI18n.t(key, vars);
      if (result && result !== key) return result;
    }
    return "";
  }
  function tt(key, fallback, vars) {
    var out = t(key, vars);
    if (out) return out;
    if (!vars) return fallback;
    return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m; });
  }

  var REPO = "hatter6822/seLe4n";
  var DATA_ENDPOINT = "data/execution-traces.json";
  var FETCH_OPTIONS = { credentials: "same-origin", cache: "no-cache", redirect: "error" };
  var SCHEMA_VERSION = 2;

  var PLAY_INTERVAL_MS = 1400;
  var ALLOWED_OPS = ["setCurrent", "threadPatch", "epEnqueue", "epDequeue", "rqInsert", "rqRemove", "notifPatch", "cdtInsert", "cdtRemove", "cdtRevoke", "cdtPatch", "untypedRetype", "untypedReset", "auditAppend", "flowCheck", "vspaceMap", "vspaceUnmap", "vspaceReject", "message", "note"];
  /* Ops that record an event without changing state: the only ops a refused
     step may carry, because a refused transition returns no successor state. */
  var EVENT_OPS = ["flowCheck", "vspaceReject", "message", "note"];
  var PATH_STAGES = ["entry", "decode", "lookup", "rights", "flow", "operation"];

  /* Layout geometry for the SVG stage. */
  var BOX_W = 188;
  var CHIP_H = 46;
  var CHIP_GAP = 9;
  var BOX_HEADER = 26;
  var BOX_PAD = 10;
  var COL_GAP = 86;
  var ZONE_GAP = 18;
  var MARGIN = 16;

  var STATE_COLORS = {
    Running: "var(--green)",
    Ready: "var(--accent)",
    Blocked: "var(--yellow)",
    Inactive: "var(--text-muted)"
  };

  var DOM = {};
  function cacheDom() {
    DOM.status = document.getElementById("theater-status");
    DOM.stage = document.getElementById("theater-stage");
    DOM.sceneTabs = document.getElementById("theater-scenes");
    DOM.guarantees = document.getElementById("guarantee-grid");
    DOM.guaranteeSummary = document.getElementById("guarantee-summary");
    DOM.invariants = document.getElementById("invariant-list");
    DOM.invariantSummary = document.getElementById("invariant-summary");
    DOM.scenarioSummary = document.getElementById("scenario-summary");
    DOM.scenarioProps = document.getElementById("scenario-properties");
    DOM.provenance = document.getElementById("theater-provenance");
    DOM.inspector = document.getElementById("theater-inspector");
    DOM.log = document.getElementById("theater-log");
    DOM.caption = document.getElementById("theater-caption");
    DOM.scrubber = document.getElementById("theater-scrubber");
    DOM.stepLabel = document.getElementById("theater-step-label");
    DOM.scenarioSelect = document.getElementById("scenario-select");
    DOM.playBtn = document.getElementById("theater-play");
    DOM.prevBtn = document.getElementById("theater-prev");
    DOM.nextBtn = document.getElementById("theater-next");
    DOM.sandboxToggle = document.getElementById("sandbox-toggle");
    DOM.sandboxPanel = document.getElementById("sandbox-panel");
    DOM.sourceBadge = document.getElementById("theater-source");
    DOM.main = document.getElementById("main-content");
  }

  var app = {
    data: null,
    scenario: null,
    scenarioId: "",
    states: [],            // states[i] = folded state after step i
    stepIndex: 0,
    playing: false,
    playTimer: null,
    scene: "system",
    selectedObject: "",
    sandbox: false,
    sandboxState: null,    // overlay state when perturbed (null = mirror trace)
    sandboxLog: []
  };

  /* ════════════════════════════════════════════════════════════
     Fold engine (mirror of scripts/lib/trace-analysis.mjs)
     ════════════════════════════════════════════════════════════ */

  function cloneState(s) { return JSON.parse(JSON.stringify(s)); }
  function findThread(s, id) { for (var i = 0; i < (s.threads || []).length; i++) if (s.threads[i].id === id) return s.threads[i]; return null; }
  function findEndpoint(s, id) { for (var i = 0; i < (s.endpoints || []).length; i++) if (s.endpoints[i].id === id) return s.endpoints[i]; return null; }
  function findNotification(s, id) { for (var i = 0; i < (s.notifications || []).length; i++) if (s.notifications[i].id === id) return s.notifications[i]; return null; }
  function findCdtNode(s, id) { var ns = (s.cdt && s.cdt.nodes) || []; for (var i = 0; i < ns.length; i++) if (ns[i].id === id) return ns[i]; return null; }
  function cdtDescendants(cdt, rootId) { var out = {}; var stack = [rootId]; while (stack.length) { var id = stack.pop(); (cdt.edges || []).forEach(function (e) { if (e[0] === id && !out[e[1]]) { out[e[1]] = 1; stack.push(e[1]); } }); } return out; }
  function cdtDescendantCount(s, id) { return s && s.cdt ? Object.keys(cdtDescendants(s.cdt, id)).length : 0; }
  function findUntyped(s, id) { for (var i = 0; i < (s.untyped || []).length; i++) if (s.untyped[i].id === id) return s.untyped[i]; return null; }
  function findDomain(s, id) { var ds = (s.infoflow && s.infoflow.domains) || []; for (var i = 0; i < ds.length; i++) if (ds[i].id === id) return ds[i]; return null; }
  function findVspace(s, id) { for (var i = 0; i < (s.vspace || []).length; i++) if (s.vspace[i].id === id) return s.vspace[i]; return null; }

  function rqInsertOrdered(state, core, threadId) {
    var key = String(core);
    if (!state.runQueue) state.runQueue = {};
    if (!Array.isArray(state.runQueue[key])) state.runQueue[key] = [];
    var queue = state.runQueue[key];
    if (queue.indexOf(threadId) !== -1) return;
    var th = findThread(state, threadId);
    var prio = th ? Number(th.priority) || 0 : 0;
    var i = 0;
    for (; i < queue.length; i++) {
      var other = findThread(state, queue[i]);
      var otherPrio = other ? Number(other.priority) || 0 : 0;
      if (otherPrio < prio) break;
    }
    queue.splice(i, 0, threadId);
  }

  function applyOp(state, op) {
    if (!op || ALLOWED_OPS.indexOf(op.op) === -1) return state;
    switch (op.op) {
      case "setCurrent":
        if (!state.current) state.current = {};
        if ("thread" in op) state.current.thread = op.thread;
        if (op.core !== undefined && op.core !== null) state.current.core = op.core;
        return state;
      case "threadPatch": {
        var th = findThread(state, op.id);
        if (th) for (var k in op.set) if (Object.prototype.hasOwnProperty.call(op.set, k)) th[k] = op.set[k];
        return state;
      }
      case "epEnqueue": {
        var ep = findEndpoint(state, op.endpoint);
        if (ep) { if (!Array.isArray(ep[op.queue])) ep[op.queue] = []; if (ep[op.queue].indexOf(op.thread) === -1) ep[op.queue].push(op.thread); }
        return state;
      }
      case "epDequeue": {
        var ep2 = findEndpoint(state, op.endpoint);
        if (ep2 && Array.isArray(ep2[op.queue])) ep2[op.queue] = ep2[op.queue].filter(function (id) { return id !== op.thread; });
        return state;
      }
      case "rqInsert":
        rqInsertOrdered(state, op.core || 0, op.thread);
        return state;
      case "rqRemove": {
        var rkey = String(op.core || 0);
        if (state.runQueue && Array.isArray(state.runQueue[rkey])) state.runQueue[rkey] = state.runQueue[rkey].filter(function (id) { return id !== op.thread; });
        return state;
      }
      case "notifPatch": {
        var n = findNotification(state, op.id);
        if (n) for (var k2 in op.set) if (Object.prototype.hasOwnProperty.call(op.set, k2)) n[k2] = op.set[k2];
        return state;
      }
      case "cdtInsert": {
        if (!state.cdt) state.cdt = { nodes: [], edges: [] };
        var cnode = op.node;
        if (cnode && cnode.id) {
          if (!findCdtNode(state, cnode.id)) state.cdt.nodes.push(cnode);
          if (op.parent != null && findCdtNode(state, op.parent)) {
            var dup = (state.cdt.edges || []).some(function (e) { return e[0] === op.parent && e[1] === cnode.id; });
            if (!dup) state.cdt.edges.push([op.parent, cnode.id]);
          }
        }
        return state;
      }
      case "cdtRemove": {
        if (state.cdt && findCdtNode(state, op.node)) {
          var doomed = cdtDescendants(state.cdt, op.node); doomed[op.node] = 1;
          state.cdt.nodes = state.cdt.nodes.filter(function (nd) { return !doomed[nd.id]; });
          state.cdt.edges = state.cdt.edges.filter(function (e) { return !doomed[e[0]] && !doomed[e[1]]; });
        }
        return state;
      }
      case "cdtRevoke": {
        // Revocation destroys the node's derivations and keeps the node itself.
        if (state.cdt && findCdtNode(state, op.node)) {
          var revoked = cdtDescendants(state.cdt, op.node);
          state.cdt.nodes = state.cdt.nodes.filter(function (nd) { return !revoked[nd.id]; });
          state.cdt.edges = state.cdt.edges.filter(function (e) { return !revoked[e[0]] && !revoked[e[1]]; });
        }
        return state;
      }
      case "cdtPatch": {
        var cn = findCdtNode(state, op.id);
        if (cn) for (var k3 in op.set) if (Object.prototype.hasOwnProperty.call(op.set, k3)) cn[k3] = op.set[k3];
        return state;
      }
      case "untypedRetype": {
        var ut = findUntyped(state, op.untyped);
        if (ut && op.child && op.child.id) {
          if (!Array.isArray(ut.children)) ut.children = [];
          if (!ut.children.some(function (c) { return c.id === op.child.id; })) ut.children.push(op.child);
          ut.watermark = (Number(ut.watermark) || 0) + (Number(op.child.size) || 0);
        }
        return state;
      }
      case "untypedReset": {
        var utr = findUntyped(state, op.untyped);
        if (utr) { utr.children = []; utr.watermark = 0; }
        return state;
      }
      case "auditAppend": {
        // Declassification appends to the audit log; the flow policy never changes.
        if (state.infoflow && op.entry && findDomain(state, op.entry.from) && findDomain(state, op.entry.to)) {
          if (!Array.isArray(state.infoflow.audit)) state.infoflow.audit = [];
          state.infoflow.audit.push(op.entry);
        }
        return state;
      }
      case "vspaceMap": {
        var vs = findVspace(state, op.vspace);
        if (vs && op.mapping && op.mapping.vaddr) {
          if (!Array.isArray(vs.mappings)) vs.mappings = [];
          if (!vs.mappings.some(function (mm) { return mm.vaddr === op.mapping.vaddr; })) vs.mappings.push(op.mapping);
          if (Array.isArray(vs.tlb) && vs.tlb.indexOf(op.mapping.vaddr) === -1) vs.tlb.push(op.mapping.vaddr);
        }
        return state;
      }
      case "vspaceUnmap": {
        var vsu = findVspace(state, op.vspace);
        if (vsu) {
          vsu.mappings = (vsu.mappings || []).filter(function (mm) { return mm.vaddr !== op.vaddr; });
          if (Array.isArray(vsu.tlb)) vsu.tlb = vsu.tlb.filter(function (v) { return v !== op.vaddr; });
        }
        return state;
      }
      default:
        return state; // message / note / flowCheck / vspaceReject are event-only
    }
  }

  function applyDelta(state, delta) {
    var ops = (delta && Array.isArray(delta.ops)) ? delta.ops : [];
    for (var i = 0; i < ops.length; i++) applyOp(state, ops[i]);
    return state;
  }

  function scenarioStates(scenario) {
    var out = [];
    var state = cloneState(scenario.initialState);
    var steps = scenario.steps || [];
    for (var i = 0; i < steps.length; i++) { applyDelta(state, steps[i].delta); out.push(cloneState(state)); }
    return out;
  }

  function touchedEntities(delta) {
    var threads = {}, endpoints = {}, notifications = {}, cdt = {}, untyped = {}, vspace = {}, infoflow = false;
    var ops = (delta && Array.isArray(delta.ops)) ? delta.ops : [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.op === "setCurrent" && op.thread) threads[op.thread] = 1;
      else if (op.op === "threadPatch" && op.id) threads[op.id] = 1;
      else if ((op.op === "epEnqueue" || op.op === "epDequeue")) { if (op.endpoint) endpoints[op.endpoint] = 1; if (op.thread) threads[op.thread] = 1; }
      else if ((op.op === "rqInsert" || op.op === "rqRemove") && op.thread) threads[op.thread] = 1;
      else if (op.op === "notifPatch" && op.id) notifications[op.id] = 1;
      else if (op.op === "cdtInsert") { if (op.node && op.node.id) cdt[op.node.id] = 1; if (op.parent) cdt[op.parent] = 1; }
      else if (op.op === "cdtRemove" || op.op === "cdtRevoke") { if (op.node) cdt[op.node] = 1; }
      else if (op.op === "cdtPatch") { if (op.id) cdt[op.id] = 1; }
      else if (op.op === "untypedRetype" || op.op === "untypedReset") { if (op.untyped) untyped[op.untyped] = 1; }
      else if (op.op === "auditAppend") { infoflow = true; }
      else if (op.op === "vspaceMap" || op.op === "vspaceUnmap" || op.op === "vspaceReject") { if (op.vspace) vspace[op.vspace] = 1; }
      else if (op.op === "message") { if (op.from) threads[op.from] = 1; if (op.to) threads[op.to] = 1; if (op.endpoint) endpoints[op.endpoint] = 1; }
    }
    return { threads: threads, endpoints: endpoints, notifications: notifications, cdt: cdt, untyped: untyped, vspace: vspace, infoflow: infoflow };
  }

  /* Does an op's referenced entity exist in `state`? The render fold is
     deliberately lenient (it silently ignores dangling refs so a partial trace
     still draws), but the live-adoption gate must be strict — otherwise a
     corrupt upstream export the CLI validator would reject could be cached and
     shown as a "kernel" trace. This mirrors the throwing checks in
     scripts/lib/trace-analysis.mjs without changing render behavior. */
  function opRefsResolve(state, op) {
    switch (op.op) {
      case "setCurrent": return !op.thread || !!findThread(state, op.thread);
      case "threadPatch": return !!findThread(state, op.id);
      case "epEnqueue":
      case "epDequeue": return !!findEndpoint(state, op.endpoint) && (!op.thread || !!findThread(state, op.thread));
      case "rqInsert":
      case "rqRemove": return !!findThread(state, op.thread);
      case "notifPatch": return !!findNotification(state, op.id);
      case "cdtInsert": return !op.parent || !!findCdtNode(state, op.parent);
      case "cdtRemove":
      case "cdtRevoke":
      case "cdtPatch": return !!findCdtNode(state, op.node || op.id);
      case "untypedRetype":
      case "untypedReset": return !!findUntyped(state, op.untyped);
      case "auditAppend": return !!(state.infoflow && op.entry && findDomain(state, op.entry.from) && findDomain(state, op.entry.to));
      case "vspaceMap":
      case "vspaceUnmap":
      case "vspaceReject": return !!findVspace(state, op.vspace);
      default: return true; // message / note / flowCheck are event-only
    }
  }
  function scenarioRefsResolve(sc) {
    var state = cloneState(sc.initialState);
    var steps = sc.steps || [];
    for (var i = 0; i < steps.length; i++) {
      var ops = (steps[i].delta && Array.isArray(steps[i].delta.ops)) ? steps[i].delta.ops : [];
      for (var j = 0; j < ops.length; j++) {
        if (!opRefsResolve(state, ops[j])) return false;
        applyOp(state, ops[j]); // advance so later ops see the effects of earlier ones
      }
    }
    return true;
  }

  /* The adoption gate. The bundle was validated in CI (validate-traces.mjs),
     so this only refuses a document the page cannot render honestly: a
     schema it does not speak, a dangling op, or a refused step that changes
     state, which would draw a failure atomicity the kernel does not have. */
  function isValidStep(step) {
    if (!step || !step.outcome || (step.outcome.status !== "ok" && step.outcome.status !== "error")) return false;
    if (step.outcome.status === "error") {
      var ops = (step.delta && Array.isArray(step.delta.ops)) ? step.delta.ops : [];
      for (var i = 0; i < ops.length; i++) if (EVENT_OPS.indexOf(ops[i].op) === -1) return false;
    }
    if (step.path !== undefined) {
      if (!Array.isArray(step.path)) return false;
      for (var j = 0; j < step.path.length; j++) if (PATH_STAGES.indexOf(step.path[j] && step.path[j].stage) === -1) return false;
    }
    return true;
  }
  function isValidTraceData(data) {
    if (!data || typeof data !== "object") return false;
    if (data.schemaVersion !== SCHEMA_VERSION) return false;
    if (!Array.isArray(data.propertyCatalog) || !Array.isArray(data.invariantCatalog)) return false;
    if (!Array.isArray(data.scenarios) || !data.scenarios.length) return false;
    for (var i = 0; i < data.scenarios.length; i++) {
      var sc = data.scenarios[i];
      if (!sc || !sc.initialState || !Array.isArray(sc.steps) || !sc.steps.length) return false;
      for (var k = 0; k < sc.steps.length; k++) if (!isValidStep(sc.steps[k])) return false;
      // Reference integrity first (reject dangling ops), then the fold must not throw.
      if (!scenarioRefsResolve(sc)) return false;
      try { scenarioStates(sc); } catch (e) { return false; }
    }
    return true;
  }

  /* ════════════════════════════════════════════════════════════
     DOM helpers
     ════════════════════════════════════════════════════════════ */

  var SVG_NS = "http://www.w3.org/2000/svg";
  function el(tag, props, kids) {
    var node = document.createElement(tag);
    if (props) for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      if (k === "class") node.className = props[k];
      else if (k === "text") node.textContent = props[k];
      else if (k === "html") node.innerHTML = props[k];
      else if (k.indexOf("on") === 0 && typeof props[k] === "function") node.addEventListener(k.slice(2), props[k]);
      else if (k === "dataset") { for (var d in props[k]) node.dataset[d] = props[k][d]; }
      else node.setAttribute(k, props[k]);
    }
    if (kids) for (var i = 0; i < kids.length; i++) { var c = kids[i]; if (c == null) continue; node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
    return node;
  }
  function svg(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
    return node;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function setStatus(text, isError) {
    if (!DOM.status) return;
    DOM.status.textContent = text;
    DOM.status.classList.toggle("error", Boolean(isError));
    if (DOM.main) DOM.main.setAttribute("aria-busy", /loading|refreshing|syncing/i.test(text) ? "true" : "false");
  }

  function prefersReducedMotion() {
    try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }

  /* Grow an SVG scene's viewBox to enclose any content that paints past the
     geometric bounds the scene computed — e.g. a long object label or box title.
     The outer <svg> clips to its viewBox, so without this such text would be cut
     off at the viewport edge. Inert when content already fits (never shrinks);
     a no-op in the headless test shim, which has no getBBox. */
  function fitViewBox(root, dims) {
    if (!root || typeof root.getBBox !== "function") return;
    try {
      var bb = root.getBBox();
      if (!bb || !isFinite(bb.width) || !isFinite(bb.height)) return;
      var pad = 8;
      // Enclose both the computed [0..dims] box and the actual painted bbox —
      // including content that overshoots left/top (negative bb.x / bb.y), e.g. a
      // long centred domain label or a tall policy arc in the info-flow scene.
      // Shifting the viewBox origin moves all content uniformly, so chip and
      // message-animation coordinates stay aligned.
      var minX = bb.x < 0 ? Math.floor(bb.x - pad) : 0;
      var minY = bb.y < 0 ? Math.floor(bb.y - pad) : 0;
      var maxX = Math.max(dims.width, Math.ceil(bb.x + bb.width + pad));
      var maxY = Math.max(dims.height, Math.ceil(bb.y + bb.height + pad));
      var w = maxX - minX, h = maxY - minY;
      if (minX !== 0 || minY !== 0 || w !== dims.width || h !== dims.height) {
        root.setAttribute("viewBox", minX + " " + minY + " " + w + " " + h);
        root.setAttribute("width", String(w));
        root.setAttribute("height", String(h));
      }
    } catch (e) { /* getBBox throws when not renderable — keep the computed dims */ }
  }

  /* Condense an SVG <text> node so it never paints past `maxWidth` (in the
     element's own user units). SVG text neither wraps nor clips, so a long
     label is otherwise drawn at full width regardless of its box. We measure
     the rendered advance and, only when it overshoots, pin textLength +
     lengthAdjust="spacingAndGlyphs" so the glyphs squeeze to fit — text that
     already fits is left untouched (never stretched). No-op in the headless
     shim, which has no getComputedTextLength. */
  function fitText(node, maxWidth) {
    if (!node || !(maxWidth > 0) || typeof node.getComputedTextLength !== "function") return;
    try {
      var len = node.getComputedTextLength();
      if (isFinite(len) && len > maxWidth) {
        node.setAttribute("textLength", String(Math.round(maxWidth)));
        node.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
    } catch (e) { /* not measurable yet — leave the label intact */ }
  }

  /* Keep every chip label inside its chip's rounded rect. Run once, after the
     scene is attached (so text is measurable), over each rectangular chip (one
     carrying a .chip-rect — the wide bar-style chips have their own room). The
     label budget is the rect's inner width minus the label's own inset, derived
     from its text-anchor. Called before fitViewBox so condensed labels don't
     force the scene's viewBox to grow. No-op in the headless shim. */
  function fitChipText(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    var PAD = 8;
    var chips = root.querySelectorAll(".theater-chip");
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i];
      var rect = chip.querySelector && chip.querySelector(".chip-rect");
      if (!rect) continue;
      var boxW = parseFloat(rect.getAttribute("width"));
      var rectX = parseFloat(rect.getAttribute("x")) || 0;
      if (!isFinite(boxW)) continue;
      var labels = chip.querySelectorAll(".chip-name, .chip-sub");
      for (var j = 0; j < labels.length; j++) {
        var label = labels[j];
        var x = parseFloat(label.getAttribute("x")) || 0;
        var anchor = label.getAttribute("text-anchor");
        var budget;
        if (anchor === "middle") budget = boxW - 2 * PAD;          // centred on x
        else if (anchor === "end") budget = (x - rectX) - PAD;      // ends at x
        else budget = (rectX + boxW) - x - PAD;                     // starts at x
        fitText(label, budget);
      }
    }
  }

  /* Reveal `line` inside its scroll panel WITHOUT scrolling the window.
     Element.scrollIntoView() walks every scroll ancestor up to the viewport;
     since the log is the page's bottom card (and html{scroll-behavior:smooth}),
     that animated the whole window down/up on every replay step. Nudging only
     the panel's own scrollTop confines the motion to the panel. No-op in the
     headless shim, which has no getBoundingClientRect. */
  function keepLineWithin(container, line) {
    if (!container || !line || typeof line.getBoundingClientRect !== "function") return;
    try {
      var c = container.getBoundingClientRect();
      var l = line.getBoundingClientRect();
      if (l.top < c.top) container.scrollTop -= (c.top - l.top);
      else if (l.bottom > c.bottom) container.scrollTop += (l.bottom - c.bottom);
    } catch (e) { /* not measurable — leave the scroll position as-is */ }
  }

  /* ════════════════════════════════════════════════════════════
     Trace-state helpers
     ════════════════════════════════════════════════════════════ */

  function currentStep() { return app.scenario ? app.scenario.steps[app.stepIndex] : null; }
  function traceState() { return app.states[app.stepIndex] || (app.scenario ? app.scenario.initialState : null); }
  function viewState() { return (app.sandbox && app.sandboxState) ? app.sandboxState : traceState(); }

  function objectMeta(id) {
    var objs = app.scenario && app.scenario.objects;
    return (objs && objs[id]) || null;
  }
  function labelOf(id) {
    var state = viewState() || {};
    var th = findThread(state, id);
    if (th && th.label) return th.label;
    var meta = objectMeta(id);
    if (meta && meta.label) return meta.label;
    var obj = findEndpoint(state, id) || findNotification(state, id) || findUntyped(state, id) || findVspace(state, id);
    return (obj && obj.label) || id;
  }
  function cdtLabelOf(id) { var n = findCdtNode(viewState(), id); return (n && n.label) || id; }
  function flowName(id) { var d = findDomain(viewState(), id); return (d && d.label) || id; }
  function isBlocked(th) {
    if (!th) return false;
    return th.threadState === "Blocked" || /^blockedOn/.test(th.ipcState || "");
  }
  function ipcTarget(ipcState) {
    var idx = (ipcState || "").indexOf(":");
    return idx >= 0 ? ipcState.slice(idx + 1) : "";
  }

  /* ════════════════════════════════════════════════════════════
     Stage (SVG scene) rendering
     ════════════════════════════════════════════════════════════ */

  function buildChip(th, x, y, opts) {
    opts = opts || {};
    var g = svg("g", { "class": "theater-chip", transform: "translate(" + x + "," + y + ")", role: "button", tabindex: "0" });
    g.setAttribute("data-thread", th.id);
    var color = STATE_COLORS[th.threadState] || "var(--text-muted)";
    var rect = svg("rect", { width: BOX_W - 2 * BOX_PAD, height: CHIP_H, rx: 7, "class": "chip-rect" });
    rect.setAttribute("stroke", color);
    if (opts.selected) rect.setAttribute("data-selected", "true");
    if (opts.touched) rect.setAttribute("data-touched", "true");
    if (opts.current) rect.setAttribute("data-current", "true");
    g.appendChild(rect);

    var dot = svg("circle", { cx: 13, cy: CHIP_H / 2, r: 5, "class": "chip-dot" });
    dot.setAttribute("fill", color);
    g.appendChild(dot);

    var name = svg("text", { x: 26, y: 18, "class": "chip-name" });
    name.textContent = th.label || th.id;
    g.appendChild(name);

    var sub = svg("text", { x: 26, y: 34, "class": "chip-sub" });
    var ipc = th.ipcState && th.ipcState !== "ready" ? th.ipcState.split(":")[0] : th.threadState;
    sub.textContent = ipc + " · prio " + th.priority;
    g.appendChild(sub);

    if (th.pipBoost) {
      var boost = svg("text", { x: BOX_W - 2 * BOX_PAD - 8, y: 18, "class": "chip-badge", "text-anchor": "end" });
      boost.textContent = "⤴" + th.pipBoost;
      g.appendChild(boost);
    }

    g.addEventListener("click", function () { selectObject(th.id); });
    g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectObject(th.id); } });
    return g;
  }

  function buildBox(title, accent) {
    var g = svg("g", { "class": "theater-box" });
    var header = svg("text", { x: 0, y: -8, "class": "box-title" });
    header.textContent = title;
    if (accent) header.setAttribute("data-accent", accent);
    g.__header = header;
    g.appendChild(header);
    return g;
  }

  function renderStage() {
    if (!DOM.stage) return;
    clear(DOM.stage);
    renderSceneTabs();
    var state = viewState();
    if (!state) return;
    if (availableScenes(app.scenario).indexOf(app.scene) === -1) app.scene = "system";
    var step = currentStep();
    var touched = step ? touchedEntities(step.delta) : { threads: {}, endpoints: {}, notifications: {}, cdt: {} };

    var root = svg("svg", { "class": "theater-svg", xmlns: SVG_NS });
    // role="group" (not "img"): the scene contains focusable, interactive object
    // chips, which an "img" role would hide from assistive technology.
    root.setAttribute("role", "group");
    var dims = app.scene === "scheduler" ? renderSchedulerScene(root, state, step, touched)
      : app.scene === "capability" ? renderCapabilityScene(root, state, step, touched)
      : app.scene === "memory" ? renderMemoryScene(root, state, step, touched)
      : app.scene === "vspace" ? renderVspaceScene(root, state, step, touched)
      : app.scene === "infoflow" ? renderInfoflowScene(root, state, step, touched)
      : renderSystemScene(root, state, step, touched);
    root.setAttribute("aria-label", dims.aria || tt("run.stage_aria", "Kernel system state visualization"));
    root.setAttribute("viewBox", "0 0 " + dims.width + " " + dims.height);
    root.setAttribute("width", String(dims.width));
    root.setAttribute("height", String(dims.height));
    DOM.stage.appendChild(root);
    fitChipText(root);
    fitViewBox(root, dims);
    if (step && !prefersReducedMotion()) animateMessages(root, step, dims.positions || {});
  }

  function renderSystemScene(root, state, step, touched) {
    var positions = {}; // id -> {x,y} center, for message animation

    // Determine which threads are "in a queue" (endpoint/notification) so the
    // off-queue blocked lane only shows reply/call-blocked threads.
    var placedInQueue = {};
    (state.endpoints || []).forEach(function (ep) {
      (ep.receiveQ || []).forEach(function (id) { placedInQueue[id] = 1; });
      (ep.sendQ || []).forEach(function (id) { placedInQueue[id] = 1; });
    });
    (state.notifications || []).forEach(function (n) { (n.waiters || []).forEach(function (id) { placedInQueue[id] = 1; }); });

    var rqObj = state.runQueue || {};
    var runningById = {};
    (state.threads || []).forEach(function (th) { if (th.threadState === "Running") runningById[th.id] = 1; });
    var inAnyRq = {};
    Object.keys(rqObj).forEach(function (k) { (rqObj[k] || []).forEach(function (id) { inAnyRq[id] = 1; }); });

    // Cores present = run-queue cores ∪ cores of running threads (SMP-aware).
    var coreSet = {};
    Object.keys(rqObj).forEach(function (k) { coreSet[k] = 1; });
    (state.threads || []).forEach(function (th) { if (th.threadState === "Running") coreSet[String(Number(th.core || 0))] = 1; });
    var cores = Object.keys(coreSet).sort(function (a, b) { return Number(a) - Number(b); });
    if (!cores.length) cores = ["0"];
    var multiCore = cores.length > 1;

    var offQueue = (state.threads || []).filter(function (th) {
      return isBlocked(th) && !placedInQueue[th.id] && !runningById[th.id] && !inAnyRq[th.id];
    });

    /* ── Left column: CPU, run queue, off-queue blocked ── */
    var leftX = MARGIN;
    var y = MARGIN + BOX_HEADER;

    function placeBox(x, startY, title, accent, members, emptyText) {
      var box = buildBox(title, accent);
      DOM.stage; // noop ref
      box.setAttribute("transform", "translate(" + x + "," + startY + ")");
      var bodyH = Math.max(CHIP_H, members.length * (CHIP_H + CHIP_GAP) - (members.length ? CHIP_GAP : 0));
      var frame = svg("rect", { x: -BOX_PAD, y: -2, width: BOX_W, height: bodyH + 2 * BOX_PAD, rx: 9, "class": "box-frame" });
      if (accent) frame.setAttribute("data-accent", accent);
      box.insertBefore(frame, box.firstChild);
      var cy = BOX_PAD;
      if (!members.length) {
        var empty = svg("text", { x: BOX_W / 2 - BOX_PAD, y: bodyH / 2 + BOX_PAD, "class": "box-empty", "text-anchor": "middle" });
        empty.textContent = emptyText || tt("run.empty", "— empty —");
        box.appendChild(empty);
      }
      members.forEach(function (th) {
        var chip = buildChip(th, 0, cy, {
          touched: !!touched.threads[th.id],
          current: !!runningById[th.id],
          selected: th.id === app.selectedObject
        });
        chip.setAttribute("transform", "translate(0," + cy + ")");
        // store center for message animation (absolute coords)
        positions[th.id] = { x: x + (BOX_W - 2 * BOX_PAD) / 2, y: startY + cy + CHIP_H / 2 };
        box.appendChild(chip);
        cy += CHIP_H + CHIP_GAP;
      });
      root.appendChild(box);
      return startY + bodyH + 2 * BOX_PAD + BOX_HEADER + ZONE_GAP;
    }

    cores.forEach(function (core) {
      var running = (state.threads || []).filter(function (th) { return th.threadState === "Running" && Number(th.core || 0) === Number(core); });
      y = placeBox(leftX, y, "CPU · core " + core, "running", running, tt("run.cpu_idle", "— no current —"));
      var rqThreads = (rqObj[String(core)] || []).map(function (id) { return findThread(state, id) || { id: id, label: id, threadState: "Ready", priority: "?", ipcState: "ready" }; });
      y = placeBox(leftX, y, multiCore ? ("Run queue · core " + core) : tt("run.runqueue", "Run queue"), "ready", rqThreads, tt("run.runqueue_empty", "— no ready threads —"));
    });
    if (offQueue.length) {
      y = placeBox(leftX, y, tt("run.blocked", "Blocked (awaiting reply)"), "blocked", offQueue);
    }
    var leftBottom = y;

    /* ── Right column: endpoints + notifications ── */
    var rightX = leftX + BOX_W + COL_GAP;
    var ry = MARGIN + BOX_HEADER;

    (state.endpoints || []).forEach(function (ep) {
      var recv = (ep.receiveQ || []).map(function (id) { return findThread(state, id) || { id: id, label: id, threadState: "Blocked", priority: "?", ipcState: "blockedOnReceive" }; });
      var send = (ep.sendQ || []).map(function (id) { return findThread(state, id) || { id: id, label: id, threadState: "Blocked", priority: "?", ipcState: "blockedOnSend" }; });
      var members = recv.concat(send);
      var label = (objectMeta(ep.id) && objectMeta(ep.id).label) || ep.label || ep.id;
      var title = "▣ " + label + "  (recv " + recv.length + " · send " + send.length + ")";
      ry = placeBoxRight(ep.id, "endpoint", title, members, recv.length);
    });
    (state.notifications || []).forEach(function (n) {
      var waiters = (n.waiters || []).map(function (id) { return findThread(state, id) || { id: id, label: id, threadState: "Blocked", priority: "?", ipcState: "blockedOnNotification" }; });
      var label = (objectMeta(n.id) && objectMeta(n.id).label) || n.label || n.id;
      var title = "◉ " + label + "  (" + n.state + (n.badge ? " · badge " + n.badge : "") + ")";
      ry = placeBoxRight(n.id, "notification", title, waiters, waiters.length);
    });

    function placeBoxRight(objId, accent, title, members, recvCount) {
      var startY = ry;
      var touchedBox = !!(touched.endpoints[objId] || touched.notifications[objId]);
      var box = buildBox(title, accent);
      box.setAttribute("transform", "translate(" + rightX + "," + startY + ")");
      box.setAttribute("data-object", objId);
      var bodyH = Math.max(CHIP_H, members.length * (CHIP_H + CHIP_GAP) - (members.length ? CHIP_GAP : 0));
      var frame = svg("rect", { x: -BOX_PAD, y: -2, width: BOX_W, height: bodyH + 2 * BOX_PAD, rx: 9, "class": "box-frame" });
      frame.setAttribute("data-accent", accent);
      if (touchedBox) frame.setAttribute("data-touched", "true");
      box.insertBefore(frame, box.firstChild);
      box.addEventListener("click", function (e) { if (e.target === frame || e.target === box.__header) selectObject(objId); });
      var cy = BOX_PAD;
      if (!members.length) {
        var empty = svg("text", { x: BOX_W / 2 - BOX_PAD, y: bodyH / 2 + BOX_PAD, "class": "box-empty", "text-anchor": "middle" });
        empty.textContent = tt("run.empty", "— empty —");
        box.appendChild(empty);
      }
      members.forEach(function (th) {
        var chip = buildChip(th, 0, cy, { touched: !!touched.threads[th.id], selected: th.id === app.selectedObject });
        chip.setAttribute("transform", "translate(0," + cy + ")");
        positions[th.id] = { x: rightX + (BOX_W - 2 * BOX_PAD) / 2, y: startY + cy + CHIP_H / 2 };
        box.appendChild(chip);
        cy += CHIP_H + CHIP_GAP;
      });
      root.appendChild(box);
      return startY + bodyH + 2 * BOX_PAD + BOX_HEADER + ZONE_GAP;
    }

    var width = rightX + BOX_W + MARGIN;
    var height = Math.max(leftBottom, ry, 220) + MARGIN;
    return { width: width, height: height, positions: positions, aria: tt("run.stage_aria", "Kernel system state visualization") };
  }

  function animateMessages(root, step, positions) {
    var ops = (step.delta && step.delta.ops) || [];
    ops.forEach(function (op) {
      if (op.op !== "message") return;
      var from = positions[op.from], to = positions[op.to];
      if (!from || !to) return;
      var env = svg("rect", { width: 22, height: 15, rx: 3, "class": "msg-envelope" });
      env.setAttribute("x", String(from.x - 11));
      env.setAttribute("y", String(from.y - 7));
      root.appendChild(env);
      var flap = svg("path", { "class": "msg-flap", d: "M0 0 L11 8 L22 0" });
      flap.setAttribute("transform", "translate(" + (from.x - 11) + "," + (from.y - 7) + ")");
      root.appendChild(flap);
      try {
        var kf = [{ transform: "translate(0,0)" }, { transform: "translate(" + (to.x - from.x) + "px," + (to.y - from.y) + "px)" }];
        var timing = { duration: 620, easing: "cubic-bezier(.5,0,.3,1)", fill: "forwards" };
        env.animate(kf, timing);
        flap.animate([{ transform: "translate(" + (from.x - 11) + "px," + (from.y - 7) + "px)" }, { transform: "translate(" + (to.x - 11) + "px," + (to.y - 7) + "px)" }], timing);
        setTimeout(function () { if (env.parentNode) env.parentNode.removeChild(env); if (flap.parentNode) flap.parentNode.removeChild(flap); }, 720);
      } catch (e) {
        if (env.parentNode) env.parentNode.removeChild(env);
        if (flap.parentNode) flap.parentNode.removeChild(flap);
      }
    });
  }

  /* ════════════════════════════════════════════════════════════
     Scene switching + Scheduler scene
     ════════════════════════════════════════════════════════════ */

  var SCENES = ["system", "scheduler", "capability", "memory", "vspace", "infoflow"];

  // Scenes available for a scenario: System/Scheduler always; the rest only when the
  // scenario carries the matching state (CDT / untyped / vspace / flow policy).
  function availableScenes(scenario) {
    var out = ["system", "scheduler"];
    var init = scenario && scenario.initialState;
    if (init && init.cdt) out.push("capability");
    if (init && init.untyped) out.push("memory");
    if (init && init.vspace) out.push("vspace");
    if (init && init.infoflow) out.push("infoflow");
    return out;
  }

  function renderSceneTabs() {
    if (!DOM.sceneTabs) return;
    clear(DOM.sceneTabs);
    var labels = { system: tt("run.scene_system", "System"), scheduler: tt("run.scene_scheduler", "Scheduler"), capability: tt("run.scene_capability", "Capabilities"), memory: tt("run.scene_memory", "Memory"), vspace: tt("run.scene_vspace", "VSpace"), infoflow: tt("run.scene_infoflow", "Information flow") };
    availableScenes(app.scenario).forEach(function (id) {
      var active = app.scene === id;
      var b = el("button", { "class": "scene-tab", type: "button", role: "tab", dataset: { scene: id, active: active ? "true" : "false" }, text: labels[id], onclick: function () { setScene(id); } });
      b.setAttribute("aria-selected", active ? "true" : "false");
      DOM.sceneTabs.appendChild(b);
    });
  }

  function setScene(id) {
    if (availableScenes(app.scenario).indexOf(id) === -1 || app.scene === id) return;
    app.scene = id;
    render();
    syncUrl();
  }

  function renderSchedulerScene(root, state, step, touched) {
    var positions = {};
    var SBW = 248, SPAD = BOX_PAD, SW = SBW - 2 * SPAD, SCH = 58, SGAP = 9;

    function buildSchedChip(th, opts) {
      opts = opts || {};
      var g = svg("g", { "class": "theater-chip sched-chip", role: "button", tabindex: "0" });
      g.setAttribute("data-thread", th.id);
      var color = STATE_COLORS[th.threadState] || "var(--text-muted)";
      var rect = svg("rect", { width: SW, height: SCH, rx: 7, "class": "chip-rect" });
      rect.setAttribute("stroke", color);
      if (opts.selected) rect.setAttribute("data-selected", "true");
      if (opts.touched) rect.setAttribute("data-touched", "true");
      if (opts.current) rect.setAttribute("data-current", "true");
      if (opts.dim) rect.setAttribute("data-dim", "true");
      g.appendChild(rect);
      var dot = svg("circle", { cx: 13, cy: 16, r: 5, "class": "chip-dot" }); dot.setAttribute("fill", color); g.appendChild(dot);
      var name = svg("text", { x: 26, y: 18, "class": "chip-name" }); name.textContent = th.label || th.id; g.appendChild(name);
      var sub = svg("text", { x: 26, y: 33, "class": "chip-sub" });
      var dom = (th.domain !== undefined && th.domain !== null) ? (" · dom " + th.domain) : "";
      var dl = (th.deadline !== undefined && th.deadline !== null) ? (" · dl " + th.deadline) : "";
      sub.textContent = "prio " + th.priority + dom + dl;
      g.appendChild(sub);
      // CBS budget bar
      var max = Number(th.budgetMax) || 5;
      var cur = Number(th.timeSlice); if (isNaN(cur)) cur = max;
      var ratio = max ? Math.max(0, Math.min(1, cur / max)) : 0;
      var blab = svg("text", { x: 26, y: 50, "class": "chip-sub" }); blab.textContent = "budget " + cur + "/" + max; g.appendChild(blab);
      var barX = 100, barY = 43, barW = SW - barX - 8, barH = 7;
      var track = svg("rect", { x: barX, y: barY, width: barW, height: barH, rx: 3, "class": "budget-track" }); g.appendChild(track);
      var fill = svg("rect", { x: barX, y: barY, width: Math.max(0, barW * ratio), height: barH, rx: 3, "class": "budget-fill" });
      fill.setAttribute("data-empty", cur <= 0 ? "true" : "false");
      g.appendChild(fill);
      g.addEventListener("click", function () { selectObject(th.id); });
      g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectObject(th.id); } });
      return g;
    }

    function placeSchedBox(x, startY, title, accent, members, dim) {
      var box = buildBox(title, accent);
      box.setAttribute("transform", "translate(" + x + "," + startY + ")");
      var bodyH = Math.max(SCH, members.length * (SCH + SGAP) - (members.length ? SGAP : 0));
      var frame = svg("rect", { x: -SPAD, y: -2, width: SBW, height: bodyH + 2 * SPAD, rx: 9, "class": "box-frame" });
      if (accent) frame.setAttribute("data-accent", accent);
      box.insertBefore(frame, box.firstChild);
      var cy = SPAD;
      if (!members.length) {
        var empty = svg("text", { x: SBW / 2 - SPAD, y: bodyH / 2 + SPAD, "class": "box-empty", "text-anchor": "middle" });
        empty.textContent = tt("run.empty", "— empty —");
        box.appendChild(empty);
      }
      members.forEach(function (th) {
        var chip = buildSchedChip(th, { touched: !!touched.threads[th.id], current: th.threadState === "Running", selected: th.id === app.selectedObject, dim: dim });
        chip.setAttribute("transform", "translate(0," + cy + ")");
        positions[th.id] = { x: x + SW / 2, y: startY + cy + SCH / 2 };
        box.appendChild(chip);
        cy += SCH + SGAP;
      });
      root.appendChild(box);
      return startY + bodyH + 2 * SPAD + BOX_HEADER + ZONE_GAP;
    }

    // SMP-aware: one column per core (CPU + priority buckets), then a shared lane.
    var rqObj = state.runQueue || {};
    var coreSet = {};
    Object.keys(rqObj).forEach(function (k) { coreSet[k] = 1; });
    (state.threads || []).forEach(function (th) { if (th.threadState === "Running") coreSet[String(Number(th.core || 0))] = 1; });
    var cores = Object.keys(coreSet).sort(function (a, b) { return Number(a) - Number(b); });
    if (!cores.length) cores = ["0"];
    var COLGAP = 28, topY = MARGIN + BOX_HEADER, maxColBottom = topY;

    cores.forEach(function (coreKey, ci) {
      var x = MARGIN + ci * (SBW + COLGAP);
      var y = topY;
      var running = (state.threads || []).filter(function (th) { return th.threadState === "Running" && Number(th.core || 0) === Number(coreKey); });
      y = placeSchedBox(x, y, "CPU · core " + coreKey, "running", running, false);
      var rq = rqObj[String(coreKey)] || [];
      var buckets = {}, order = [];
      rq.forEach(function (id) {
        var th = findThread(state, id) || { id: id, label: id, priority: "?", threadState: "Ready" };
        var p = th.priority;
        if (!(p in buckets)) { buckets[p] = []; order.push(p); }
        buckets[p].push(th);
      });
      order.sort(function (a, b) { return Number(b) - Number(a); });
      if (!order.length) y = placeSchedBox(x, y, tt("run.runqueue", "Run queue"), "ready", [], false);
      else order.forEach(function (p) { y = placeSchedBox(x, y, tt("run.priority", "Priority") + " " + p, "ready", buckets[p], false); });
      maxColBottom = Math.max(maxColBottom, y);
    });

    // Threads the scheduler ignores (blocked / not runnable), shown dimmed below the columns.
    var blocked = (state.threads || []).filter(isBlocked);
    var bottom = maxColBottom;
    if (blocked.length) bottom = placeSchedBox(MARGIN, maxColBottom, tt("run.not_runnable", "Not runnable (blocked)"), "blocked", blocked, true);

    return { width: MARGIN + cores.length * (SBW + COLGAP) - COLGAP + MARGIN, height: Math.max(bottom, 220) + MARGIN - ZONE_GAP, positions: positions, aria: tt("run.scheduler_aria", "Kernel scheduler view: per-core CPU, priority buckets, and budgets") };
  }

  function renderCapabilityScene(root, state, step, touched) {
    var positions = {};
    var cdt = state.cdt || { nodes: [], edges: [] };
    var nodes = cdt.nodes || [];
    var edges = cdt.edges || [];
    var NW = 158, NH = 60, HGAP = 24, VGAP = 50;

    // Build the tree structure from parent→child edges.
    var childrenOf = {}, hasParent = {};
    nodes.forEach(function (n) { childrenOf[n.id] = []; });
    edges.forEach(function (e) { if (childrenOf[e[0]]) childrenOf[e[0]].push(e[1]); hasParent[e[1]] = 1; });
    var roots = nodes.filter(function (n) { return !hasParent[n.id]; }).map(function (n) { return n.id; });

    // Tidy layout: leaves take sequential x slots; internal nodes centre over children.
    var xIndex = {}, depth = {}, visited = {}, leaf = 0;
    function dfs(id, d) {
      if (visited[id]) return;
      visited[id] = 1; depth[id] = d;
      var kids = childrenOf[id] || [];
      if (!kids.length) { xIndex[id] = leaf++; return; }
      var sum = 0, count = 0;
      kids.forEach(function (c) { dfs(c, d + 1); if (xIndex[c] !== undefined) { sum += xIndex[c]; count++; } });
      xIndex[id] = count ? sum / count : leaf++;
    }
    roots.forEach(function (r) { dfs(r, 0); });
    nodes.forEach(function (n) { if (visited[n.id] === undefined) { visited[n.id] = 1; depth[n.id] = 0; xIndex[n.id] = leaf++; } });

    function px(id) { return MARGIN + xIndex[id] * (NW + HGAP); }
    function py(id) { return MARGIN + BOX_HEADER + depth[id] * (NH + VGAP); }

    // Derivation edges (drawn under the nodes).
    var edgeLayer = svg("g", { "class": "cdt-edges" });
    root.appendChild(edgeLayer);
    edges.forEach(function (e) {
      if (xIndex[e[0]] === undefined || xIndex[e[1]] === undefined) return;
      var x1 = px(e[0]) + NW / 2, y1 = py(e[0]) + NH, x2 = px(e[1]) + NW / 2, y2 = py(e[1]);
      var midY = (y1 + y2) / 2;
      edgeLayer.appendChild(svg("path", { "class": "cdt-edge", d: "M" + x1 + " " + y1 + " C " + x1 + " " + midY + " " + x2 + " " + midY + " " + x2 + " " + y2 }));
    });

    // Capability nodes.
    var maxX = 0, maxY = 0;
    nodes.forEach(function (n) {
      var x = px(n.id), y = py(n.id);
      maxX = Math.max(maxX, x + NW); maxY = Math.max(maxY, y + NH);
      var g = svg("g", { "class": "theater-chip cdt-node", transform: "translate(" + x + "," + y + ")", role: "button", tabindex: "0" });
      g.setAttribute("data-cdt", n.id);
      var rect = svg("rect", { width: NW, height: NH, rx: 8, "class": "chip-rect cdt-rect" });
      if (n.id === app.selectedObject) rect.setAttribute("data-selected", "true");
      if (touched.cdt && touched.cdt[n.id]) rect.setAttribute("data-touched", "true");
      g.appendChild(rect);
      var title = svg("text", { x: 11, y: 19, "class": "chip-name" }); title.textContent = n.label || n.id; g.appendChild(title);
      var tgt = svg("text", { x: 11, y: 35, "class": "chip-sub" }); tgt.textContent = "→ " + ((objectMeta(n.target) && objectMeta(n.target).label) || n.target || "?"); g.appendChild(tgt);
      var meta = svg("text", { x: 11, y: 50, "class": "chip-sub" });
      meta.textContent = "[" + (n.rights || "") + "]" + (n.badge != null ? " b" + n.badge : "") + (n.slot ? " · " + n.slot : "");
      g.appendChild(meta);
      g.addEventListener("click", function () { selectObject(n.id); });
      g.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectObject(n.id); } });
      positions[n.id] = { x: x + NW / 2, y: y + NH / 2 };
      root.appendChild(g);
    });

    if (!nodes.length) {
      var empty = svg("text", { x: MARGIN, y: MARGIN + BOX_HEADER + 16, "class": "box-empty" });
      empty.textContent = tt("run.no_caps", "— no capabilities —");
      root.appendChild(empty);
    }

    return { width: Math.max(maxX, 240) + MARGIN, height: Math.max(maxY, 220) + MARGIN, positions: positions, aria: tt("run.capability_aria", "Capability derivation tree") };
  }

  var MEM_TYPE_COLORS = { TCB: "var(--green)", CNode: "var(--accent)", Endpoint: "var(--purple)", Notification: "var(--yellow)", VSpace: "var(--accent)", Untyped: "var(--text-muted)" };

  function renderMemoryScene(root, state, step, touched) {
    var positions = {};
    var regions = state.untyped || [];
    var BARW = 520, BARH = 34, PAD = 12, REGION_GAP = 26;
    var y = MARGIN + BOX_HEADER;

    regions.forEach(function (ut) {
      var region = Number(ut.regionSize) || 1;
      var wm = Number(ut.watermark) || 0;
      var label = (objectMeta(ut.id) && objectMeta(ut.id).label) || ut.label || ut.id;
      var boxH = BARH + 46;
      var g = svg("g", { "class": "theater-chip mem-region", transform: "translate(" + MARGIN + "," + y + ")", role: "button", tabindex: "0" });
      g.setAttribute("data-untyped", ut.id);
      var frame = svg("rect", { x: -PAD, y: -2, width: BARW + 2 * PAD, height: boxH, rx: 9, "class": "box-frame mem-frame" });
      frame.setAttribute("data-accent", "memory");
      if (touched.untyped && touched.untyped[ut.id]) frame.setAttribute("data-touched", "true");
      if (ut.id === app.selectedObject) frame.setAttribute("data-selected", "true");
      g.appendChild(frame);
      var title = svg("text", { x: 0, y: 16, "class": "chip-name" });
      title.textContent = label + (ut.isDevice ? " (device)" : "");
      g.appendChild(title);
      var meta = svg("text", { x: BARW, y: 16, "class": "chip-sub", "text-anchor": "end" });
      meta.textContent = "watermark " + wm + " / " + region + "  (" + Math.round(wm / region * 100) + "% used)";
      g.appendChild(meta);

      var barY = 26;
      g.appendChild(svg("rect", { x: 0, y: barY, width: BARW, height: BARH, rx: 4, "class": "mem-track" }));
      var cx = 0;
      (ut.children || []).forEach(function (c) {
        var w = Math.max(2, (Number(c.size) || 0) / region * BARW);
        var seg = svg("rect", { x: cx, y: barY, width: w, height: BARH, rx: 3, "class": "mem-child" });
        seg.setAttribute("fill", MEM_TYPE_COLORS[c.type] || "var(--text-muted)");
        g.appendChild(seg);
        if (w > 30) {
          var lab = svg("text", { x: cx + w / 2, y: barY + BARH / 2 + 4, "class": "mem-child-label", "text-anchor": "middle" });
          lab.textContent = c.type;
          g.appendChild(lab);
        }
        cx += w;
      });
      var wmx = wm / region * BARW;
      g.appendChild(svg("line", { x1: wmx, y1: barY - 4, x2: wmx, y2: barY + BARH + 4, "class": "mem-watermark" }));

      g.addEventListener("click", function () { selectObject(ut.id); });
      g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectObject(ut.id); } });
      positions[ut.id] = { x: MARGIN + BARW / 2, y: y + barY + BARH / 2 };
      root.appendChild(g);
      y += boxH + REGION_GAP;
    });

    if (!regions.length) {
      var empty = svg("text", { x: MARGIN, y: MARGIN + BOX_HEADER + 16, "class": "box-empty" });
      empty.textContent = tt("run.no_untyped", "— no untyped memory —");
      root.appendChild(empty);
    }

    return { width: BARW + 2 * MARGIN + 2 * PAD, height: Math.max(y, 200) + MARGIN - REGION_GAP, positions: positions, aria: tt("run.memory_aria", "Untyped memory regions and allocations") };
  }

  function renderInfoflowScene(root, state, step, touched) {
    var positions = {};
    var iflow = state.infoflow || { domains: [], policy: [] };
    var domains = (iflow.domains || []).slice().sort(function (a, b) { return (Number(a.confidentiality) || 0) - (Number(b.confidentiality) || 0); });
    var policy = iflow.policy || [];
    var DOMW = 124, DOMH = 58, GAP = 74;
    var domainY = MARGIN + BOX_HEADER + 90;

    var defs = svg("defs", {});
    function marker(id, cls) {
      var m = svg("marker", { id: id, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
      m.appendChild(svg("path", { d: "M0 0 L10 5 L0 10 z", "class": cls }));
      return m;
    }
    defs.appendChild(marker("if-arrow-policy", "if-head-policy"));
    defs.appendChild(marker("if-arrow-allow", "if-head-allow"));
    defs.appendChild(marker("if-arrow-block", "if-head-block"));
    root.appendChild(defs);

    var idx = {}; domains.forEach(function (d, i) { idx[d.id] = i; });
    function dx(id) { return MARGIN + idx[id] * (DOMW + GAP); }
    function cxOf(id) { return dx(id) + DOMW / 2; }
    function domName(id) { for (var k = 0; k < domains.length; k++) if (domains[k].id === id) return domains[k].label || id; return id; }

    // Allowed-flow policy arcs above the row.
    var arcLayer = svg("g", { "class": "if-arcs" });
    root.appendChild(arcLayer);
    policy.forEach(function (e) {
      if (idx[e[0]] === undefined || idx[e[1]] === undefined) return;
      var x1 = cxOf(e[0]), x2 = cxOf(e[1]), topY = domainY - 6;
      var lift = 30 + Math.abs(idx[e[1]] - idx[e[0]]) * 24;
      arcLayer.appendChild(svg("path", { "class": "if-policy", "marker-end": "url(#if-arrow-policy)", d: "M" + x1 + " " + topY + " C " + x1 + " " + (topY - lift) + " " + x2 + " " + (topY - lift) + " " + x2 + " " + topY }));
    });

    // Domain nodes.
    domains.forEach(function (d) {
      var x = dx(d.id);
      var g = svg("g", { "class": "theater-chip if-domain", transform: "translate(" + x + "," + domainY + ")", role: "button", tabindex: "0" });
      g.setAttribute("data-domain", d.id);
      var rect = svg("rect", { width: DOMW, height: DOMH, rx: 9, "class": "chip-rect if-rect" });
      if (d.id === app.selectedObject) rect.setAttribute("data-selected", "true");
      g.appendChild(rect);
      var name = svg("text", { x: DOMW / 2, y: 24, "class": "chip-name", "text-anchor": "middle" }); name.textContent = d.label || d.id; g.appendChild(name);
      var lab = svg("text", { x: DOMW / 2, y: 42, "class": "chip-sub", "text-anchor": "middle" }); lab.textContent = "C" + (d.confidentiality != null ? d.confidentiality : "?") + " · I" + (d.integrity != null ? d.integrity : "?"); g.appendChild(lab);
      g.addEventListener("click", function () { selectObject(d.id); });
      g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectObject(d.id); } });
      positions[d.id] = { x: x + DOMW / 2, y: domainY + DOMH / 2 };
      root.appendChild(g);
    });

    // The current step's attempted flow (a flowCheck op).
    var flow = null;
    var ops = (step && step.delta && step.delta.ops) || [];
    for (var i = 0; i < ops.length; i++) if (ops[i].op === "flowCheck") { flow = ops[i]; break; }
    if (flow && idx[flow.from] !== undefined && idx[flow.to] !== undefined) {
      var fx = cxOf(flow.from), tx = cxOf(flow.to), fy = domainY + DOMH + 28;
      var allowed = flow.allowed !== false;
      var path = svg("path", { "class": "if-flow " + (allowed ? "if-flow-allow" : "if-flow-block"), "marker-end": allowed ? "url(#if-arrow-allow)" : "url(#if-arrow-block)", d: "M" + fx + " " + (domainY + DOMH) + " L " + fx + " " + fy + " L " + tx + " " + fy + " L " + tx + " " + (domainY + DOMH + 5) });
      root.appendChild(path);
      var badge = svg("text", { x: (fx + tx) / 2, y: fy + 18, "class": allowed ? "if-flow-label-allow" : "if-flow-label-block", "text-anchor": "middle" });
      badge.textContent = (allowed ? tt("run.allowed", "allowed") : tt("run.flow_blocked", "blocked")) + ": " + domName(flow.from) + " → " + domName(flow.to);
      root.appendChild(badge);
    }

    if (!domains.length) {
      var empty = svg("text", { x: MARGIN, y: MARGIN + BOX_HEADER + 16, "class": "box-empty" });
      empty.textContent = tt("run.no_domains", "— no security domains —");
      root.appendChild(empty);
    }

    var width = Math.max(MARGIN + domains.length * (DOMW + GAP) - GAP + MARGIN, 320);

    // The declassification audit log. Declassification never edits the policy
    // above; it is a separate, recorded release, and the log is its trace.
    var bottom = domainY + DOMH + 64;
    if (Array.isArray(iflow.audit)) {
      var audit = iflow.audit;
      var logY = bottom + BOX_HEADER;
      var rowH = 22, logW = width - 2 * MARGIN;
      var box = buildBox(tt("run.audit_log", "Declassification audit log"), "infoflow");
      box.setAttribute("transform", "translate(" + MARGIN + "," + logY + ")");
      var bodyH = Math.max(rowH, audit.length * rowH);
      var frame = svg("rect", { x: -BOX_PAD, y: -2, width: logW + 2 * BOX_PAD, height: bodyH + 2 * BOX_PAD, rx: 9, "class": "box-frame" });
      frame.setAttribute("data-accent", "infoflow");
      if (touched.infoflow) frame.setAttribute("data-touched", "true");
      box.insertBefore(frame, box.firstChild);
      if (!audit.length) {
        var none = svg("text", { x: logW / 2, y: BOX_PAD + 14, "class": "box-empty", "text-anchor": "middle" });
        none.textContent = tt("run.audit_empty", "— no declassifications —");
        box.appendChild(none);
      }
      audit.forEach(function (entry, i) {
        var row = svg("text", { x: 0, y: BOX_PAD + 14 + i * rowH, "class": "chip-sub audit-row" });
        row.textContent = (i + 1) + ". " + domName(entry.from) + " → " + domName(entry.to) + (entry.actor ? "  · " + labelOf(entry.actor) : "");
        box.appendChild(row);
      });
      root.appendChild(box);
      bottom = logY + bodyH + 2 * BOX_PAD;
    }
    return { width: width, height: bottom + MARGIN, positions: positions, aria: tt("run.infoflow_aria", "Security-domain flow policy, the current flow check and the declassification audit log") };
  }

  function renderVspaceScene(root, state, step, touched) {
    var positions = {};
    var spaces = state.vspace || [];
    var BOXW = 460, ROWH = 26, PAD = 12, HEADH = 26, GAP = 22;
    var rejectByVs = {}, shootdownByVs = {};
    var ops = (step && step.delta && step.delta.ops) || [];
    ops.forEach(function (op) {
      if (op.op === "vspaceReject" && op.vspace) rejectByVs[op.vspace] = op.mapping;
      if (op.op === "vspaceUnmap" && op.vspace) shootdownByVs[op.vspace] = op.vaddr;
    });

    var y = MARGIN + BOX_HEADER;
    spaces.forEach(function (vs) {
      var maps = vs.mappings || [];
      var reject = rejectByVs[vs.id];
      var rowCount = Math.max(1, maps.length + (reject ? 1 : 0) + (vs.tlb !== undefined ? 1 : 0));
      var bodyH = HEADH + rowCount * ROWH + PAD;
      var g = svg("g", { "class": "theater-chip vs-space", transform: "translate(" + MARGIN + "," + y + ")", role: "button", tabindex: "0" });
      g.setAttribute("data-vspace", vs.id);
      var frame = svg("rect", { x: -PAD, y: -2, width: BOXW + 2 * PAD, height: bodyH, rx: 9, "class": "box-frame vs-frame" });
      frame.setAttribute("data-accent", "memory");
      if (touched.vspace && touched.vspace[vs.id]) frame.setAttribute("data-touched", "true");
      if (vs.id === app.selectedObject) frame.setAttribute("data-selected", "true");
      g.appendChild(frame);
      var label = (objectMeta(vs.id) && objectMeta(vs.id).label) || vs.label || vs.id;
      var title = svg("text", { x: 0, y: 15, "class": "chip-name" });
      title.textContent = label + "  ·  ASID " + (vs.asid != null ? vs.asid : "?") + "  ·  " + maps.length + " page" + (maps.length === 1 ? "" : "s");
      g.appendChild(title);

      var ry = HEADH;
      function row(m, rejected) {
        var perms = String(m.perms || "");
        var violating = m.wx === true || (/w/.test(perms) && /x/.test(perms));
        var t1 = svg("text", { x: 4, y: ry + 16, "class": "vs-addr" }); t1.textContent = m.vaddr + " → " + (m.paddr || "?"); g.appendChild(t1);
        var pb = svg("text", { x: 200, y: ry + 16, "class": "vs-perms" }); pb.textContent = "[" + perms + "]"; g.appendChild(pb);
        var status = svg("text", { x: BOXW, y: ry + 16, "class": (rejected || violating) ? "vs-rejected" : "vs-ok", "text-anchor": "end" });
        status.textContent = rejected ? tt("run.wx_refused", "✕ refused (W^X)") : (violating ? "✕ W^X" : "✓ W^X");
        g.appendChild(status);
        ry += ROWH;
      }
      if (!maps.length && !reject) { var empty = svg("text", { x: 4, y: ry + 16, "class": "box-empty" }); empty.textContent = tt("run.no_mappings", "— no mappings —"); g.appendChild(empty); }
      maps.forEach(function (m) { row(m, false); });
      if (reject) row(reject, true);
      if (vs.tlb !== undefined) {
        var tlbText = svg("text", { x: 4, y: ry + 16, "class": "vs-tlb" });
        tlbText.textContent = "TLB: " + ((vs.tlb && vs.tlb.length) ? vs.tlb.join("  ") : "—");
        g.appendChild(tlbText);
        if (shootdownByVs[vs.id]) {
          var sd = svg("text", { x: BOXW, y: ry + 16, "class": "vs-shootdown", "text-anchor": "end" });
          sd.textContent = "⚡ shootdown " + shootdownByVs[vs.id];
          g.appendChild(sd);
        }
        ry += ROWH;
      }

      g.addEventListener("click", function () { selectObject(vs.id); });
      g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectObject(vs.id); } });
      positions[vs.id] = { x: MARGIN + BOXW / 2, y: y + bodyH / 2 };
      root.appendChild(g);
      y += bodyH + GAP;
    });

    if (!spaces.length) {
      var emptyS = svg("text", { x: MARGIN, y: MARGIN + BOX_HEADER + 16, "class": "box-empty" });
      emptyS.textContent = tt("run.no_vspace", "— no address spaces —");
      root.appendChild(emptyS);
    }

    return { width: BOXW + 2 * MARGIN + 2 * PAD, height: Math.max(y, 200) + MARGIN - GAP, positions: positions, aria: tt("run.vspace_aria", "Virtual address space page mappings and W^X status") };
  }

  /* ════════════════════════════════════════════════════════════
     Grounded links
     ════════════════════════════════════════════════════════════ */

  /* A link to kernel source is built from a reference's stamped `path` and
     `line` at the bundle's `sourceRef` commit, and from nothing else: a
     reference the sync did not stamp is shown as plain text. The patterns are
     a whitelist, so a malformed document cannot put an arbitrary URL on the
     page. */
  var SHA_RE = /^[0-9a-f]{40}$/;
  var LEAN_PATH_RE = /^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.lean$/;
  function sourceHref(ref) {
    var sha = app.data && app.data.sourceRef;
    if (!ref || !SHA_RE.test(String(sha || "")) || !LEAN_PATH_RE.test(String(ref.path || ""))) return "";
    var line = Number(ref.line);
    if (!(line > 0) || Math.floor(line) !== line) return "";
    return "https://github.com/" + REPO + "/blob/" + sha + "/" + ref.path + "#L" + line;
  }
  // The code map draws production modules only; the testing framework is outside it.
  function mapHref(module) {
    var m = String(module || "");
    if (!/^SeLe4n(\.[A-Za-z0-9_]+)*$/.test(m) || /^SeLe4n\.Testing(\.|$)/.test(m)) return "";
    return "map.html?module=" + encodeURIComponent(m);
  }
  function refLink(ref, cls) {
    var href = sourceHref(ref);
    var code = el("code", { text: ref.name });
    var klass = cls || "ref-link";
    if (!href) return el("span", { "class": klass + " ref-unlinked", title: ref.module }, [code]);
    return el("a", { "class": klass, href: href, target: "_blank", rel: "noopener noreferrer", title: ref.module + " · " + ref.path + ":" + ref.line }, [code]);
  }

  function catalogEntry(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function propertyById(id) { return catalogEntry(app.data && app.data.propertyCatalog, id); }
  function invariantById(id) { return catalogEntry(app.data && app.data.invariantCatalog, id); }
  function stepGuarantees(step) { return (step && Array.isArray(step.guarantees)) ? step.guarantees : []; }
  function stepPreserved(step) { return (step && step.invariants && Array.isArray(step.invariants.preserved)) ? step.invariants.preserved : []; }
  function stepFailed(step) { return (step && step.invariants && Array.isArray(step.invariants.failed)) ? step.invariants.failed : []; }
  function isRefused(step) { return !!(step && step.outcome && step.outcome.status === "error"); }
  function refusingStage(step) {
    var path = (step && step.path) || [];
    for (var i = 0; i < path.length; i++) if (path[i].result === "fail") return path[i];
    return null;
  }

  /* ════════════════════════════════════════════════════════════
     Guarantees band + invariant catalogue
     ════════════════════════════════════════════════════════════ */

  // Client-side structural checks for the sandbox (UNVERIFIED, illustrative
  // only), keyed by the invariant catalogue ids they approximate.
  function jsChecks(state) {
    var results = {};
    var current = state.current && state.current.thread;
    var inRunQueue = {};
    var dupRunQueue = false;
    var rq = state.runQueue || {};
    for (var core in rq) {
      if (!Object.prototype.hasOwnProperty.call(rq, core)) continue;
      var seen = {};
      (rq[core] || []).forEach(function (id) { if (seen[id]) dupRunQueue = true; seen[id] = 1; inRunQueue[id] = 1; });
    }
    results.runQueueUnique = !dupRunQueue;
    var cur = current ? findThread(state, current) : null;
    results.currentThreadValid = !current || !!(cur && cur.threadState === "Running");
    results.queueCurrentConsistent = !current || !inRunQueue[current];
    results.blockedNotRunnable = !(state.threads || []).some(function (th) { return isBlocked(th) && inRunQueue[th.id]; });
    return results;
  }

  var SUBSYSTEM_ORDER = ["ipc", "scheduler", "capability", "memory", "infoflow"];
  function subsystemLabel(sub) {
    switch (sub) {
      case "ipc": return tt("run.sub_ipc", "IPC");
      case "scheduler": return tt("run.sub_scheduler", "Scheduler");
      case "capability": return tt("run.sub_capability", "Capabilities");
      case "memory": return tt("run.sub_memory", "Memory");
      case "infoflow": return tt("run.sub_infoflow", "Information flow");
      default: return sub || tt("run.sub_other", "Other");
    }
  }

  /* The scenario's properties first, in the order it states them, then the
     rest of the catalogue: the cards keep their places as the step moves, so
     the highlight is the only thing that changes. */
  function orderedProperties() {
    var catalog = (app.data && app.data.propertyCatalog) || [];
    var own = (app.scenario && app.scenario.properties) || [];
    var first = own.map(propertyById).filter(Boolean);
    return first.concat(catalog.filter(function (p) { return own.indexOf(p.id) === -1; }));
  }

  function renderGuarantees() {
    if (!DOM.guarantees) return;
    clear(DOM.guarantees);
    var step = currentStep();
    var active = stepGuarantees(step);
    var preserved = stepPreserved(step);
    var own = (app.scenario && app.scenario.properties) || [];
    orderedProperties().forEach(function (prop) {
      var inStep = active.indexOf(prop.id) !== -1;
      var card = el("article", {
        "class": "prop-card",
        id: "property-" + prop.id,
        dataset: { active: inStep ? "true" : "false", scenario: own.indexOf(prop.id) !== -1 ? "true" : "false" }
      });
      card.appendChild(el("h3", { "class": "prop-title" }, [
        el("span", { "class": "prop-mark", "aria-hidden": "true", text: inStep ? "●" : "○" }),
        el("span", { text: prop.label })
      ]));
      card.appendChild(el("p", { "class": "prop-statement", text: prop.statement }));
      if (prop.caveat) {
        card.appendChild(el("p", { "class": "prop-caveat" }, [
          el("strong", { text: tt("run.caveat", "Scope") + ": " }),
          prop.caveat
        ]));
      }
      if (prop.theorems && prop.theorems.length) {
        var thms = el("ul", { "class": "prop-theorems", "aria-label": tt("run.proved_by", "Stated or proved by") });
        prop.theorems.forEach(function (ref) { thms.appendChild(el("li", {}, [refLink(ref)])); });
        card.appendChild(thms);
      }
      if (prop.invariants && prop.invariants.length) {
        var invs = el("ul", { "class": "prop-invariants", "aria-label": tt("run.rests_on", "Rests on") });
        prop.invariants.forEach(function (id) {
          var inv = invariantById(id);
          if (!inv) return;
          invs.appendChild(el("li", { dataset: { preserved: preserved.indexOf(id) !== -1 ? "true" : "false" } }, [
            el("a", { href: "#invariant-" + id, title: inv.meaning || "", text: inv.label })
          ]));
        });
        card.appendChild(invs);
      }
      DOM.guarantees.appendChild(card);
    });

    if (DOM.guaranteeSummary) {
      var tone = "good", text;
      if (isRefused(step)) {
        var stage = refusingStage(step);
        text = tt("run.summary_refused", "Refused with {{error}}{{at}}: the kernel returned no successor state, so nothing changed.", {
          error: step.outcome.error || "",
          at: stage ? " " + tt("run.summary_at", "at the {{stage}} stage", { stage: stage.stage }) : ""
        });
        tone = "refused";
      } else if (active.length) {
        text = tt("run.summary_relies", "This step relies on {{list}}.", { list: active.map(function (id) { var p = propertyById(id); return p ? p.label : id; }).join(" · ") });
      } else if (step && step.kind === "boot") {
        text = tt("run.summary_boot", "Initial state. Highlighted cards are what this scenario demonstrates; step forward to see each one at work.");
        tone = "neutral";
      } else {
        text = tt("run.summary_none", "This step is bookkeeping: it relies on no security property beyond the invariants it preserves.");
        tone = "neutral";
      }
      DOM.guaranteeSummary.textContent = text;
      DOM.guaranteeSummary.dataset.tone = tone;
    }
  }

  function renderInvariants() {
    if (!DOM.invariants) return;
    clear(DOM.invariants);
    var catalog = (app.data && app.data.invariantCatalog) || [];
    var step = currentStep();
    var preserved = stepPreserved(step);
    var failed = stepFailed(step);
    var sandboxResults = app.sandbox ? jsChecks(viewState()) : null;
    var anyViolation = false;

    var groups = {}, seen = [];
    catalog.forEach(function (inv) {
      var sub = inv.subsystem || "other";
      if (!groups[sub]) { groups[sub] = []; seen.push(sub); }
      groups[sub].push(inv);
    });
    var ordered = SUBSYSTEM_ORDER.filter(function (s) { return groups[s]; })
      .concat(seen.filter(function (s) { return SUBSYSTEM_ORDER.indexOf(s) === -1; }));

    ordered.forEach(function (sub) {
      var list = el("ul", { "class": "inv-list", role: "list" });
      groups[sub].forEach(function (inv) {
        // preserved: this step's transition is covered by a preservation theorem;
        // holds: the invariant is part of the kernel's proved state, untouched here;
        // violated: the sandbox broke it, or the trace records a failure.
        var status = "holds";
        if (sandboxResults && Object.prototype.hasOwnProperty.call(sandboxResults, inv.id)) {
          if (!sandboxResults[inv.id]) { status = "violated"; anyViolation = true; }
        } else if (failed.indexOf(inv.id) !== -1) {
          status = "violated";
          anyViolation = true;
        } else if (preserved.indexOf(inv.id) !== -1) {
          status = "preserved";
        }
        var rows = el("dl", { "class": "inv-refs" });
        if (inv.predicate) { rows.appendChild(el("dt", { text: tt("run.inv_predicate", "Predicate") })); rows.appendChild(el("dd", {}, [refLink(inv.predicate)])); }
        if (inv.preservedBy && inv.preservedBy.length) {
          rows.appendChild(el("dt", { text: tt("run.inv_preserved_by", "Preserved by") }));
          rows.appendChild(el("dd", {}, inv.preservedBy.map(function (ref) { return refLink(ref); })));
        }
        if (inv.runtimeCheck) {
          rows.appendChild(el("dt", { text: tt("run.inv_runtime", "Runtime check") }));
          rows.appendChild(el("dd", {}, [refLink(inv.runtimeCheck), el("span", { "class": "inv-note", text: tt("run.inv_runtime_note", "test harness, not a proof") })]));
        }
        var mark = status === "violated" ? "✕" : status === "preserved" ? "✓" : "·";
        list.appendChild(el("li", { "class": "inv-item", id: "invariant-" + inv.id, dataset: { status: status, subsystem: sub } }, [
          el("div", { "class": "inv-head" }, [
            el("span", { "class": "inv-mark", "aria-hidden": "true", text: mark }),
            el("strong", { "class": "inv-label", text: inv.label }),
            status === "preserved" ? el("span", { "class": "inv-badge", text: tt("run.inv_preserved_here", "preserved by this step") }) : null,
            status === "violated" ? el("span", { "class": "inv-badge", text: tt("run.inv_violated", "violated") }) : null
          ]),
          inv.meaning ? el("p", { "class": "inv-meaning", text: inv.meaning }) : null,
          rows
        ]));
      });
      DOM.invariants.appendChild(el("section", { "class": "inv-group" }, [
        el("h3", { "class": "inv-group-title" }, [
          el("span", { text: subsystemLabel(sub) }),
          el("span", { "class": "inv-group-count", "aria-hidden": "true", text: String(groups[sub].length) })
        ]),
        list
      ]));
    });

    if (DOM.invariantSummary) {
      var tone = "good", text;
      if (app.sandbox) {
        text = anyViolation
          ? tt("run.rail_violated", "Sandbox: a structural check is violated (this is exactly what the Lean proofs forbid).")
          : tt("run.rail_sandbox_ok", "Sandbox: client-side structural checks pass (unverified).");
        tone = anyViolation ? "bad" : "warn";
      } else if (failed.length) {
        text = tt("run.rail_failed", "Invariants recorded as failing at this step: {{count}}", { count: failed.length });
        tone = "bad";
      } else if (preserved.length) {
        text = tt("run.inv_summary_preserved", "{{count}} of {{total}} preserved by a theorem covering this step", { count: preserved.length, total: catalog.length });
      } else {
        text = tt("run.inv_summary_none", "This step changes no state these invariants constrain");
        tone = "neutral";
      }
      DOM.invariantSummary.textContent = text;
      DOM.invariantSummary.dataset.tone = tone;
    }
  }

  /* ════════════════════════════════════════════════════════════
     Inspector (what happened · kernel path · why it's safe)
     ════════════════════════════════════════════════════════════ */

  function humanizeOp(op) {
    switch (op.op) {
      case "setCurrent": return "Context switch → " + (op.thread ? labelOf(op.thread) : "idle");
      case "threadPatch": {
        var bits = [];
        for (var k in op.set) if (Object.prototype.hasOwnProperty.call(op.set, k)) bits.push(k + " = " + JSON.stringify(op.set[k]));
        return labelOf(op.id) + ": " + bits.join(", ");
      }
      case "epEnqueue": return labelOf(op.thread) + " → " + labelOf(op.endpoint) + "." + op.queue;
      case "epDequeue": return labelOf(op.thread) + " ← " + labelOf(op.endpoint) + "." + op.queue;
      case "rqInsert": return "Enqueue " + labelOf(op.thread) + " on run queue (core " + (op.core || 0) + ")";
      case "rqRemove": return "Dequeue " + labelOf(op.thread) + " from run queue (core " + (op.core || 0) + ")";
      case "notifPatch": return labelOf(op.id) + " updated";
      case "cdtInsert": return "Derive capability " + (op.node && (op.node.label || op.node.id)) + (op.parent ? " from " + cdtLabelOf(op.parent) : "");
      case "cdtRemove": return "Delete capability " + cdtLabelOf(op.node);
      case "cdtRevoke": return "Revoke every capability derived from " + cdtLabelOf(op.node) + " (it stays)";
      case "cdtPatch": return "Update capability " + cdtLabelOf(op.id);
      case "untypedRetype": return "Retype " + (op.child && op.child.type) + " (" + (op.child && op.child.size) + ") from " + labelOf(op.untyped);
      case "untypedReset": return "Reset " + labelOf(op.untyped) + ": watermark to 0, every carved object reclaimed";
      case "auditAppend": return "Audit log: declassify " + flowName(op.entry && op.entry.from) + " → " + flowName(op.entry && op.entry.to) + (op.entry && op.entry.actor ? " by " + labelOf(op.entry.actor) : "");
      case "flowCheck": return "Flow check " + flowName(op.from) + " → " + flowName(op.to) + (op.allowed === false ? ": denied" : ": allowed");
      case "vspaceMap": return "Map " + (op.mapping && op.mapping.vaddr) + " → " + (op.mapping && op.mapping.paddr) + " [" + (op.mapping && op.mapping.perms) + "]";
      case "vspaceUnmap": return "Unmap " + op.vaddr + " and shoot down its TLB entry";
      case "vspaceReject": return "Map " + (op.mapping && op.mapping.vaddr) + " [" + (op.mapping && op.mapping.perms) + "] refused: writable and executable";
      case "message": return "Message " + labelOf(op.from) + " → " + labelOf(op.to) + " (" + (op.registers || 0) + " regs" + (op.caps ? ", " + op.caps + " caps" : "") + ")";
      case "note": return op.text || "";
      default: return op.op;
    }
  }

  function diffName(state, id) {
    var t = findThread(state, id); if (t && t.label) return t.label;
    var m = objectMeta(id); if (m && m.label) return m.label;
    return id;
  }
  function diffFmt(v) {
    if (v === null || v === undefined) return "—";
    if (Array.isArray(v)) return v.length ? "[" + v.map(function (x) { return diffName(viewState(), x); }).join(", ") + "]" : "[]";
    return String(v);
  }

  // Field-level before→after changes for entities touched by the current trace step.
  function computeDiffRows() {
    if (app.sandbox || app.stepIndex <= 0) return [];
    var prev = app.states[app.stepIndex - 1], next = app.states[app.stepIndex];
    if (!prev || !next) return [];
    var touched = touchedEntities(currentStep().delta);
    var rows = [];
    function diff(label, a, b, fields) {
      fields.forEach(function (f) {
        if (a[f] === undefined && b[f] === undefined) return;
        if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) rows.push([label, f, diffFmt(a[f]) + " → " + diffFmt(b[f])]);
      });
    }
    // touchedEntities returns maps (id → 1) in the browser runtime.
    Object.keys(touched.threads || {}).forEach(function (id) {
      var a = findThread(prev, id), b = findThread(next, id);
      if (!a && b) { rows.push([diffName(next, id), "added", ""]); return; }
      if (a && !b) { rows.push([diffName(prev, id), "removed", ""]); return; }
      if (a && b) diff(b.label || id, a, b, ["threadState", "ipcState", "priority", "timeSlice", "core", "pipBoost", "replyObject", "pendingReceiveReply"]);
    });
    Object.keys(touched.endpoints || {}).forEach(function (id) {
      var a = findEndpoint(prev, id), b = findEndpoint(next, id);
      if (a && b) diff(b.label || id, a, b, ["receiveQ", "sendQ"]);
    });
    Object.keys(touched.notifications || {}).forEach(function (id) {
      var a = findNotification(prev, id), b = findNotification(next, id);
      if (a && b) diff(b.label || id, a, b, ["state", "badge", "waiters"]);
    });
    Object.keys(touched.cdt || {}).forEach(function (id) {
      var a = findCdtNode(prev, id), b = findCdtNode(next, id);
      var parentEdges = (next.cdt && next.cdt.edges) || [];
      if (!a && b) {
        var parent = parentEdges.filter(function (e) { return e[1] === id; }).map(function (e) { return e[0]; })[0];
        rows.push([b.label || id, "derived", "[" + (b.rights || "") + "]" + (parent ? " ← " + ((findCdtNode(next, parent) || {}).label || parent) : "")]);
      } else if (a && !b) rows.push([a.label || id, "destroyed", ""]);
      else if (a && b) {
        var before = cdtDescendantCount(prev, id), after = cdtDescendantCount(next, id);
        if (before !== after) rows.push([b.label || id, "derivations", before + " → " + after]);
        diff(b.label || id, a, b, ["rights", "badge"]);
      }
    });
    Object.keys(touched.untyped || {}).forEach(function (id) {
      var a = findUntyped(prev, id), b = findUntyped(next, id);
      if (a && b) {
        diff(b.label || id, a, b, ["watermark"]);
        if ((a.children || []).length !== (b.children || []).length) rows.push([b.label || id, "objects", (a.children || []).length + " → " + (b.children || []).length]);
      }
    });
    if (touched.infoflow && prev.infoflow && next.infoflow) {
      var na = (prev.infoflow.audit || []).length, nb = (next.infoflow.audit || []).length;
      if (na !== nb) rows.push([tt("run.audit_log", "Declassification audit log"), "entries", na + " → " + nb]);
    }
    Object.keys(touched.vspace || {}).forEach(function (id) {
      var a = findVspace(prev, id), b = findVspace(next, id);
      if (!a || !b) return;
      if ((a.mappings || []).length !== (b.mappings || []).length) rows.push([b.label || id, "mappings", (a.mappings || []).length + " → " + (b.mappings || []).length]);
      if (a.tlb !== undefined && b.tlb !== undefined && JSON.stringify(a.tlb) !== JSON.stringify(b.tlb)) rows.push([b.label || id, "TLB", (a.tlb.length || "—") + " → " + (b.tlb.length || "—") + " entries"]);
    });
    return rows;
  }

  function renderInspector() {
    if (!DOM.inspector) return;
    clear(DOM.inspector);
    var step = currentStep();
    if (!step) return;
    var refused = isRefused(step);

    DOM.inspector.appendChild(el("div", { "class": "insp-head" }, [
      el("span", { "class": "insp-kind", dataset: { kind: step.kind }, text: step.kind }),
      el("code", { "class": "insp-tag", text: step.traceTag }),
      el("span", { "class": "insp-outcome", dataset: { outcome: refused ? "error" : "ok" }, text: refused
        ? tt("run.outcome_refused", "refused · {{error}}", { error: step.outcome.error || "" })
        : tt("run.outcome_ok", "completed") }),
      step.actor ? el("span", { "class": "insp-actor", text: tt("run.actor", "actor") + ": " + labelOf(step.actor) }) : null
    ]));
    DOM.inspector.appendChild(el("h3", { "class": "insp-title", text: step.title }));
    if (step.narrative) DOM.inspector.appendChild(el("p", { "class": "insp-narrative", text: step.narrative }));

    /* ── How: the checked syscall path ── */
    if (step.syscall || (step.path && step.path.length)) {
      var section = el("div", { "class": "insp-section" }, [el("h4", { text: tt("run.kernel_path", "Kernel path") })]);
      if (step.syscall) {
        var sc = step.syscall;
        section.appendChild(el("p", { "class": "insp-syscall" }, [
          el("code", { "class": "insp-syscall-id", text: sc.id }),
          sc.requiredRight ? el("span", { "class": "insp-right" }, [tt("run.requires", "requires") + " ", el("code", { text: sc.requiredRight })]) : null,
          sc.capPath ? el("span", { "class": "insp-cappath", text: sc.capPath }) : null
        ]));
      }
      if (step.path && step.path.length) {
        var strip = el("ol", { "class": "path-strip" });
        step.path.forEach(function (stage) {
          var result = stage.result || "pass";
          strip.appendChild(el("li", { "class": "path-stage", dataset: { result: result, stage: stage.stage } }, [
            el("span", { "class": "path-mark", "aria-hidden": "true", text: result === "fail" ? "✕" : result === "skip" ? "–" : "✓" }),
            el("span", { "class": "path-body" }, [
              el("span", { "class": "path-label" }, [
                el("span", { "class": "path-stage-name", text: stage.stage }),
                stage.label
              ]),
              stage.ref ? refLink(stage.ref, "ref-link path-ref") : null,
              result === "fail" && stage.error ? el("span", { "class": "path-error" }, [tt("run.returns", "returns") + " ", el("code", { text: "." + stage.error })]) : null,
              result === "skip" ? el("span", { "class": "path-skip", text: tt("run.not_reached", "not reached") }) : null
            ])
          ]));
        });
        section.appendChild(strip);
      }
      DOM.inspector.appendChild(section);
    }

    /* ── Why it's safe ── */
    var guarantees = stepGuarantees(step);
    var preserved = stepPreserved(step);
    if (guarantees.length || preserved.length || refused) {
      var why = el("div", { "class": "insp-section insp-why" }, [el("h4", { text: tt("run.why_safe", "Why it's safe") })]);
      if (refused) {
        why.appendChild(el("p", { "class": "insp-atomic", text: tt("run.atomic_note", "A kernel transition has type σ → Except ε (α × σ): an error carries no state, so a refused call cannot leave a partial change behind.") }));
      }
      if (guarantees.length) {
        var gl = el("ul", { "class": "insp-guarantees" });
        guarantees.forEach(function (id) {
          var prop = propertyById(id);
          if (!prop) return;
          gl.appendChild(el("li", {}, [
            el("a", { href: "#property-" + id, "class": "insp-prop", text: prop.label }),
            prop.theorems && prop.theorems[0] ? refLink(prop.theorems[0]) : null
          ]));
        });
        why.appendChild(gl);
      }
      if (preserved.length) {
        var il = el("ul", { "class": "insp-preserved", "aria-label": tt("run.preserved", "Invariants preserved") });
        preserved.forEach(function (id) {
          var inv = invariantById(id);
          if (!inv) return;
          il.appendChild(el("li", {}, [
            el("a", { href: "#invariant-" + id, "class": "insp-inv", text: "✓ " + inv.label }),
            inv.preservedBy && inv.preservedBy[0] ? refLink(inv.preservedBy[0]) : null
          ]));
        });
        why.appendChild(el("p", { "class": "insp-subhead", text: tt("run.preserved", "Invariants preserved") }));
        why.appendChild(il);
      }
      DOM.inspector.appendChild(why);
    }

    /* ── What changed ── */
    var diffRows = computeDiffRows();
    var ops = (step.delta && step.delta.ops) || [];
    if (diffRows.length || ops.length || refused) {
      var what = el("div", { "class": "insp-section" }, [el("h4", { text: tt("run.changes", "State changes") })]);
      if (diffRows.length) {
        var dlist = el("ul", { "class": "insp-diff" });
        diffRows.forEach(function (r) {
          dlist.appendChild(el("li", {}, [
            el("span", { "class": "diff-entity", text: r[0] }),
            el("span", { "class": "diff-field", text: r[1] }),
            el("span", { "class": "diff-change", text: r[2] })
          ]));
        });
        what.appendChild(dlist);
      } else if (refused || step.kind !== "boot") {
        what.appendChild(el("p", { "class": "insp-nochange", text: tt("run.no_change", "None: the kernel state after this step equals the state before it.") }));
      }
      if (ops.length) {
        var ul = el("ul", { "class": "insp-effects" });
        ops.forEach(function (op) { ul.appendChild(el("li", { dataset: { op: op.op, event: EVENT_OPS.indexOf(op.op) !== -1 ? "true" : "false" }, text: humanizeOp(op) })); });
        what.appendChild(ul);
      }
      DOM.inspector.appendChild(what);
    }

    /* ── Source ── */
    if (step.sourceRefs && step.sourceRefs.length) {
      var refs = el("ul", { "class": "insp-refs" });
      step.sourceRefs.forEach(function (ref) {
        var map = mapHref(ref.module);
        refs.appendChild(el("li", {}, [
          refLink(ref),
          map ? el("a", { "class": "insp-ref-mod", href: map, title: tt("run.open_in_map", "Open in the code map"), text: ref.module }) : el("span", { "class": "insp-ref-mod", text: ref.module })
        ]));
      });
      DOM.inspector.appendChild(el("div", { "class": "insp-section" }, [el("h4", { text: tt("run.source", "Source") }), refs]));
    }

    if (app.selectedObject) renderSelectedObject();
  }

  function renderSelectedObject() {
    var state = viewState();
    var id = app.selectedObject;
    var th = findThread(state, id);
    var box, title, fields = [];
    if (th) {
      title = "TCB · " + (th.label || th.id);
      ["threadState", "ipcState", "priority", "domain", "timeSlice", "deadline", "schedContext", "cspaceRoot", "vspaceRoot", "boundNotification", "pipBoost", "replyObject", "pendingReceiveReply"].forEach(function (f) {
        if (th[f] !== undefined && th[f] !== null) fields.push([f, th[f]]);
      });
    } else {
      var ep = findEndpoint(state, id);
      var n = !ep ? findNotification(state, id) : null;
      var cn = (!ep && !n) ? findCdtNode(state, id) : null;
      if (ep) { title = "Endpoint · " + (labelOf(id)); fields.push(["receiveQ", (ep.receiveQ || []).map(labelOf).join(", ") || "—"]); fields.push(["sendQ", (ep.sendQ || []).map(labelOf).join(", ") || "—"]); }
      else if (n) { title = "Notification · " + (labelOf(id)); fields.push(["state", n.state]); fields.push(["waiters", (n.waiters || []).map(labelOf).join(", ") || "—"]); fields.push(["badge", n.badge == null ? "—" : n.badge]); }
      else if (cn) {
        title = "Capability · " + (cn.label || cn.id);
        fields.push(["target", (objectMeta(cn.target) && objectMeta(cn.target).label) || cn.target || "?"]);
        fields.push(["rights", cn.rights || "—"]);
        fields.push(["badge", cn.badge == null ? "—" : cn.badge]);
        fields.push(["slot", cn.slot || "—"]);
        var cedges = (state.cdt && state.cdt.edges) || [];
        var par = cedges.filter(function (e) { return e[1] === id; }).map(function (e) { return cdtLabelOf(e[0]); });
        var kids = cedges.filter(function (e) { return e[0] === id; }).map(function (e) { return cdtLabelOf(e[1]); });
        fields.push(["derived from", par.length ? par.join(", ") : "— (root)"]);
        fields.push(["children", kids.length ? kids.join(", ") : "—"]);
      }
      else {
        var ut = findUntyped(state, id);
        if (ut) {
          title = "Untyped · " + (ut.label || ut.id);
          var rs = Number(ut.regionSize) || 0, wmv = Number(ut.watermark) || 0;
          fields.push(["region size", rs]);
          fields.push(["watermark", wmv]);
          fields.push(["free", rs - wmv]);
          fields.push(["device", ut.isDevice ? "yes" : "no"]);
          fields.push(["objects", (ut.children || []).map(function (c) { return c.type + " (" + c.size + ")"; }).join(", ") || "—"]);
        } else {
          var dm = findDomain(state, id);
          if (dm) {
            title = "Security domain · " + (dm.label || dm.id);
            fields.push(["confidentiality", dm.confidentiality]);
            fields.push(["integrity", dm.integrity]);
            var pol = (state.infoflow && state.infoflow.policy) || [];
            var to = pol.filter(function (e) { return e[0] === id; }).map(function (e) { return flowName(e[1]); });
            var from = pol.filter(function (e) { return e[1] === id; }).map(function (e) { return flowName(e[0]); });
            fields.push(["may flow to", to.length ? to.join(", ") : "—"]);
            fields.push(["may receive from", from.length ? from.join(", ") : "—"]);
          } else {
            var vsp = findVspace(state, id);
            if (!vsp) return;
            title = "VSpace · " + (vsp.label || vsp.id);
            fields.push(["asid", vsp.asid]);
            fields.push(["mappings", (vsp.mappings || []).length]);
            (vsp.mappings || []).forEach(function (m) { fields.push([m.vaddr, "→ " + (m.paddr || "?") + " [" + (m.perms || "") + "]"]); });
            if (vsp.tlb !== undefined) fields.push(["TLB", (vsp.tlb && vsp.tlb.length) ? vsp.tlb.join(", ") : "—"]);
          }
        }
      }
    }
    var dl = el("dl", { "class": "insp-grid" });
    fields.forEach(function (r) { dl.appendChild(el("dt", { text: r[0] })); dl.appendChild(el("dd", {}, [el("code", { text: String(r[1]) })])); });
    box = el("div", { "class": "insp-section insp-object" }, [
      el("h4", {}, [el("span", { text: tt("run.selected", "Selected") + ": " }), el("strong", { text: title })]),
      dl,
      el("button", { "class": "btn btn-secondary insp-clear", type: "button", text: tt("run.clear_selection", "Clear selection"), onclick: function () { selectObject(""); } })
    ]);
    DOM.inspector.appendChild(box);
  }

  /* ════════════════════════════════════════════════════════════
     Event log
     ════════════════════════════════════════════════════════════ */

  function renderLog() {
    if (!DOM.log) return;
    clear(DOM.log);
    if (!app.scenario) return;
    app.scenario.steps.forEach(function (step, i) {
      var active = i === app.stepIndex;
      var line = el("button", {
        "class": "log-line",
        type: "button",
        dataset: { kind: step.kind, active: active ? "true" : "false", outcome: isRefused(step) ? "error" : "ok" },
        onclick: function () { setStep(i); }
      }, [
        el("code", { "class": "log-tag", text: step.traceTag }),
        el("span", { "class": "log-kind", text: step.kind }),
        el("span", { "class": "log-title", text: step.title }),
        isRefused(step) ? el("code", { "class": "log-error", text: step.outcome.error || "" }) : null
      ]);
      if (active) line.setAttribute("aria-current", "step");
      DOM.log.appendChild(line);
    });
    var activeLine = DOM.log.querySelector('[data-active="true"]');
    if (activeLine) keepLineWithin(DOM.log, activeLine);
  }

  /* ════════════════════════════════════════════════════════════
     Transport
     ════════════════════════════════════════════════════════════ */

  function render() {
    if (!app.scenario) return;
    renderStage();
    renderInspector();
    renderGuarantees();
    renderInvariants();
    renderLog();
    updateTransport();
  }

  function updateTransport() {
    var step = currentStep();
    var total = app.scenario ? app.scenario.steps.length : 0;
    if (DOM.scrubber) { DOM.scrubber.max = String(Math.max(0, total - 1)); DOM.scrubber.value = String(app.stepIndex); }
    if (DOM.stepLabel) DOM.stepLabel.textContent = (app.stepIndex + 1) + " / " + total;
    if (DOM.caption && step) DOM.caption.textContent = (app.stepIndex + 1) + ". " + step.title;
    if (DOM.prevBtn) DOM.prevBtn.disabled = app.stepIndex <= 0;
    if (DOM.nextBtn) DOM.nextBtn.disabled = app.stepIndex >= total - 1;
    if (DOM.playBtn) {
      DOM.playBtn.setAttribute("aria-pressed", app.playing ? "true" : "false");
      DOM.playBtn.dataset.playing = app.playing ? "true" : "false";
      DOM.playBtn.setAttribute("aria-label", app.playing ? tt("run.pause", "Pause") : tt("run.play", "Play"));
    }
  }

  function setStep(i) {
    if (!app.scenario) return;
    var total = app.scenario.steps.length;
    var next = Math.max(0, Math.min(total - 1, i));
    app.stepIndex = next;
    if (app.sandbox) { app.sandboxState = null; resetSandboxUi(); } // stepping clears perturbations
    render();
    syncUrl();
    if (app.playing && app.stepIndex >= total - 1) stopPlay();
  }

  function startPlay() {
    if (app.playing || !app.scenario) return;
    if (app.stepIndex >= app.scenario.steps.length - 1) app.stepIndex = 0;
    app.playing = true;
    app.playTimer = window.setInterval(function () { setStep(app.stepIndex + 1); }, PLAY_INTERVAL_MS);
    updateTransport();
  }
  function stopPlay() {
    app.playing = false;
    if (app.playTimer) { window.clearInterval(app.playTimer); app.playTimer = null; }
    updateTransport();
  }
  function togglePlay() { if (app.playing) stopPlay(); else startPlay(); }

  function selectObject(id) {
    app.selectedObject = (app.selectedObject === id) ? "" : id;
    render();
    syncUrl();
  }

  function loadScenario(id, keepStep) {
    var scenarios = (app.data && app.data.scenarios) || [];
    var sc = null;
    for (var i = 0; i < scenarios.length; i++) if (scenarios[i].id === id) { sc = scenarios[i]; break; }
    if (!sc) sc = scenarios[0];
    if (!sc) return;
    stopPlay();
    app.scenario = sc;
    app.scenarioId = sc.id;
    app.states = scenarioStates(sc);
    // On the first load, honor an explicit URL scene; on scenario switch, reset to the
    // scenario's preferred scene.
    if (keepStep) { app.scene = app._urlScene || sc.primaryScene || "system"; app._urlScene = null; }
    else { app.scene = sc.primaryScene || "system"; }
    if (availableScenes(sc).indexOf(app.scene) === -1) app.scene = "system";
    if (!keepStep) app.stepIndex = 0;
    app.stepIndex = Math.max(0, Math.min(app.scenario.steps.length - 1, app.stepIndex));
    // Preserve a deep-linked selection (?object=) on the initial load so shared/reloaded
    // links keep the highlighted chip + inspector; reset only on an actual scenario switch.
    app.selectedObject = keepStep ? (app._urlObject || "") : "";
    app._urlObject = null;
    app.sandboxState = null;
    if (DOM.scenarioSelect) DOM.scenarioSelect.value = sc.id;
    renderScenarioMeta();
    render();
  }

  /* What the scenario is for, and which guarantees it puts to work. */
  function renderScenarioMeta() {
    var sc = app.scenario;
    if (DOM.scenarioSummary) DOM.scenarioSummary.textContent = (sc && sc.summary) || "";
    if (!DOM.scenarioProps) return;
    clear(DOM.scenarioProps);
    ((sc && sc.properties) || []).forEach(function (id) {
      var prop = propertyById(id);
      if (!prop) return;
      DOM.scenarioProps.appendChild(el("li", {}, [el("a", { href: "#property-" + id, "class": "scenario-prop", text: prop.label })]));
    });
  }

  /* ════════════════════════════════════════════════════════════
     Sandbox (hybrid — clearly labeled, unverified)
     ════════════════════════════════════════════════════════════ */

  function setSandbox(on) {
    app.sandbox = on;
    app.sandboxState = null;
    if (DOM.sandboxPanel) DOM.sandboxPanel.hidden = !on;
    if (DOM.sandboxToggle) { DOM.sandboxToggle.setAttribute("aria-pressed", on ? "true" : "false"); DOM.sandboxToggle.dataset.on = on ? "true" : "false"; }
    document.documentElement.setAttribute("data-theater-sandbox", on ? "on" : "off");
    // The sandbox's effect is a broken invariant, so show the list it breaks.
    var details = document.getElementById("invariant-details");
    if (on && details) details.open = true;
    render();
    syncUrl();
  }

  function perturb(kind) {
    if (!app.sandbox) return;
    var state = cloneState(viewState());
    var current = state.current && state.current.thread;
    var core = (state.current && state.current.core) || 0;
    if (kind === "enqueue-current" && current) {
      rqInsertOrdered(state, core, current);
    } else if (kind === "dup-runqueue") {
      var rq = state.runQueue && state.runQueue[String(core)];
      if (rq && rq.length) rq.push(rq[0]);
      else if (current) { rqInsertOrdered(state, core, current); state.runQueue[String(core)].push(current); }
    } else if (kind === "wake-blocked") {
      var blocked = (state.threads || []).filter(isBlocked)[0];
      if (blocked) rqInsertOrdered(state, core, blocked.id);
    }
    app.sandboxState = state;
    app.sandboxLog.push(kind);
    render();
  }
  function resetSandbox() { app.sandboxState = null; render(); }
  function resetSandboxUi() { /* hook for future per-perturbation UI state */ }

  /* ════════════════════════════════════════════════════════════
     URL state
     ════════════════════════════════════════════════════════════ */

  function parseQuery() {
    var out = {};
    var raw = window.location.search || "";
    if (raw.charAt(0) === "?") raw = raw.slice(1);
    raw.split("&").forEach(function (entry) {
      if (!entry) return;
      var eq = entry.indexOf("=");
      var key = eq >= 0 ? entry.slice(0, eq) : entry;
      var val = eq >= 0 ? entry.slice(eq + 1) : "";
      try { key = decodeURIComponent(key.replace(/\+/g, " ")); } catch (e) {}
      try { val = decodeURIComponent(val.replace(/\+/g, " ")); } catch (e) {}
      if (key) out[key] = val;
    });
    return out;
  }

  function syncUrl() {
    var params = [];
    if (app.scenarioId) params.push("scenario=" + encodeURIComponent(app.scenarioId));
    params.push("step=" + app.stepIndex);
    if (app.scene && app.scene !== "system") params.push("scene=" + encodeURIComponent(app.scene));
    if (app.selectedObject) params.push("object=" + encodeURIComponent(app.selectedObject));
    if (app.sandbox) params.push("sandbox=1");
    var qs = "?" + params.join("&");
    try { window.history.replaceState(null, "", qs); } catch (e) {}
  }

  function applyUrlState() {
    var q = parseQuery();
    if (q.scenario) app.scenarioId = q.scenario;
    if (q.step != null && q.step !== "") { var n = parseInt(q.step, 10); if (!isNaN(n)) app.stepIndex = n; }
    if (q.scene && SCENES.indexOf(q.scene) !== -1) { app.scene = q.scene; app._urlScene = q.scene; }
    if (q.object) { app.selectedObject = q.object; app._urlObject = q.object; }
    if (q.sandbox === "1") app.sandbox = true;
  }

  /* ════════════════════════════════════════════════════════════
     Data loading (bundle-only)
     ════════════════════════════════════════════════════════════ */

  function fetchBundle() {
    return fetch(DATA_ENDPOINT, FETCH_OPTIONS).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function adoptData(data) {
    if (!isValidTraceData(data)) return false;
    app.data = data;
    buildScenarioOptions();
    updateSourceBadge();
    loadScenario(app.scenarioId || (data.scenarios[0] && data.scenarios[0].id), true);
    setStatus("");
    return true;
  }

  function bootstrapData() {
    setStatus(tt("run.loading", "Loading kernel traces…"));
    fetchBundle().then(function (data) {
      if (!adoptData(data)) setStatus(tt("run.invalid", "Bundled trace data is invalid."), true);
    }).catch(function () {
      setStatus(tt("run.offline", "Could not load trace data."), true);
    });
  }

  function buildScenarioOptions() {
    if (!DOM.scenarioSelect) return;
    clear(DOM.scenarioSelect);
    (app.data.scenarios || []).forEach(function (sc) {
      DOM.scenarioSelect.appendChild(el("option", { value: sc.id, text: sc.title }));
    });
  }

  /* Say what the traces are and which kernel revision their names were
     resolved at. The commit links to the tree the line anchors point into. */
  function updateSourceBadge() {
    if (!app.data) return;
    var isKernel = app.data.source === "kernel";
    var version = app.data.kernelVersion || "";
    if (DOM.sourceBadge) {
      DOM.sourceBadge.dataset.source = app.data.source;
      DOM.sourceBadge.textContent = isKernel
        ? tt("run.source_kernel", "kernel export · {{version}}", { version: version })
        : tt("run.source_fixture", "hand-written scenarios · names grounded in seLe4n {{version}}", { version: version });
    }
    if (DOM.provenance) {
      clear(DOM.provenance);
      var sha = String(app.data.sourceRef || "");
      if (SHA_RE.test(sha)) {
        DOM.provenance.appendChild(document.createTextNode(tt("run.grounded_at", "Every link opens the kernel at commit") + " "));
        DOM.provenance.appendChild(el("a", { href: "https://github.com/" + REPO + "/tree/" + sha, target: "_blank", rel: "noopener noreferrer" }, [el("code", { text: sha.slice(0, 7) })]));
        DOM.provenance.appendChild(document.createTextNode("."));
      }
    }
  }

  /* ════════════════════════════════════════════════════════════
     Chrome (theme / background toggle, mirroring map.js)
     ════════════════════════════════════════════════════════════ */

  function setupTheme() {
    var root = document.documentElement;
    var btn = document.getElementById("theme-toggle");
    if (!root.getAttribute("data-theme")) root.setAttribute("data-theme", "dark");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var next = (root.getAttribute("data-theme") || "dark") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("sele4n-theme", next); } catch (e) {}
      var meta = document.getElementById("theme-color-meta");
      if (meta) meta.setAttribute("content", next === "light" ? "#f8f9fc" : "#0a0e17");
    });
  }

  function hardenExternalLinks() {
    var links = document.querySelectorAll('a[target="_blank"]');
    for (var i = 0; i < links.length; i++) {
      var rel = (links[i].getAttribute("rel") || "").split(/\s+/).filter(Boolean);
      if (rel.indexOf("noopener") === -1) rel.push("noopener");
      if (rel.indexOf("noreferrer") === -1) rel.push("noreferrer");
      links[i].setAttribute("rel", rel.join(" "));
    }
  }

  /* ════════════════════════════════════════════════════════════
     Event wiring + bootstrap
     ════════════════════════════════════════════════════════════ */

  function wireControls() {
    if (DOM.playBtn) DOM.playBtn.addEventListener("click", togglePlay);
    if (DOM.prevBtn) DOM.prevBtn.addEventListener("click", function () { stopPlay(); setStep(app.stepIndex - 1); });
    if (DOM.nextBtn) DOM.nextBtn.addEventListener("click", function () { stopPlay(); setStep(app.stepIndex + 1); });
    if (DOM.scrubber) DOM.scrubber.addEventListener("input", function () { stopPlay(); setStep(parseInt(DOM.scrubber.value, 10) || 0); });
    if (DOM.scenarioSelect) DOM.scenarioSelect.addEventListener("change", function () { loadScenario(DOM.scenarioSelect.value, false); syncUrl(); });
    if (DOM.sandboxToggle) DOM.sandboxToggle.addEventListener("click", function () { setSandbox(!app.sandbox); });
    // Following an in-page link to a card or an invariant opens the catalogue
    // that holds it, so the anchor is never inside a closed <details>.
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href^="#invariant-"]');
      var details = document.getElementById("invariant-details");
      if (a && details && !details.open) details.open = true;
    });

    if (DOM.sandboxPanel) {
      DOM.sandboxPanel.addEventListener("click", function (e) {
        var btn = e.target.closest && e.target.closest("[data-perturb]");
        if (btn) { perturb(btn.getAttribute("data-perturb")); return; }
        if (e.target.closest && e.target.closest("[data-sandbox-reset]")) resetSandbox();
      });
    }

    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowRight" || e.key === "l") { stopPlay(); setStep(app.stepIndex + 1); }
      else if (e.key === "ArrowLeft" || e.key === "h") { stopPlay(); setStep(app.stepIndex - 1); }
      else if (e.key === "Home") { stopPlay(); setStep(0); }
      else if (e.key === "End") { stopPlay(); setStep(app.scenario ? app.scenario.steps.length - 1 : 0); }
    });

    window.addEventListener("sele4n:locale-changed", function () { if (app.scenario) { updateSourceBadge(); renderScenarioMeta(); render(); } });
    document.addEventListener("visibilitychange", function () { if (document.hidden) stopPlay(); });
  }

  function setupLocaleReady() {
    var i18n = window.sele4nI18n;
    if (!i18n || typeof i18n.onReady !== "function") { localeReady = true; return; }
    i18n.onReady(function () {
      localeReady = true;
      if (!paintedBeforeLocale || !app.scenario) return;
      paintedBeforeLocale = false;
      updateSourceBadge();
      renderScenarioMeta();
      render();
    });
  }

  function init() {
    cacheDom();
    setupLocaleReady();
    setupTheme();
    hardenExternalLinks();
    wireControls();
    applyUrlState();
    if (app.sandbox) setSandbox(true);
    bootstrapData();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
