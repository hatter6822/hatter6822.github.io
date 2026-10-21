/**
 * seLe4n Simulator — browser runtime.
 *
 * Replays kernel scenarios and shows, for every step, what the kernel did
 * (the state change, drawn), how it got there (the registers it decoded, the
 * CPtr it walked, each gate on the checked syscall path and the scheduler's
 * choice) and why that is safe (the security properties the step relies on
 * and the invariants it preserves, each linked to the Lean declaration that
 * states or proves it).
 *
 * Every decision the page draws is computed, not drawn from the trace's say-so:
 * the CPtr walk is `resolveCap`, the scheduler's candidates are `selectOnCore`,
 * a flow arrow is `flowsTo`, all from `assets/js/trace-engine.js` — the same
 * file the validator runs, so the page cannot show a decision the build did not
 * check. Every name is grounded: the sync resolves each `{ name, module }` in the
 * pinned kernel checkout and stamps `path` and `line`; a link is built from
 * those fields only, at `data.sourceRef` (`scripts/lib/trace-anchors.mjs`).
 *
 * Design constraints (match the rest of the site):
 *   - Vanilla ES5-style IIFE, no frameworks, strict CSP (no inline style or
 *     script, no eval).
 *   - Bundle-only: the page reads `data/execution-traces.json` and nothing else
 *     (`connect-src 'self'`); there is no live refresh and no cache.
 */
(function () {
  "use strict";

  var E = window.sele4nTraceEngine;

  /* ── i18n (returns "" so callers can fall back to a literal) ──
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
  function fmtNum(n) {
    try { return new Intl.NumberFormat(document.documentElement.getAttribute("lang") || "en").format(n); } catch (e) { return String(n); }
  }

  var REPO = "hatter6822/seLe4n";
  var DATA_ENDPOINT = "data/execution-traces.json";
  var FETCH_OPTIONS = { credentials: "same-origin", cache: "no-cache", redirect: "error" };
  var PLAY_INTERVAL_MS = 1800;
  var SCENES = ["path", "ipc", "scheduler", "cspace", "memory", "infoflow"];
  var ID_RE = /^[A-Za-z0-9_.:\/-]{1,80}$/;
  /* `configDefaultTimeSlice`: the slice an expired or yielding thread is refilled to. */
  var DEFAULT_SLICE = 5;
  var MARGIN = 16;
  var SCENE_W = 760;

  var DOM = {};
  function cacheDom() {
    ["theater-status", "theater-stage", "theater-scenes", "guarantee-grid", "guarantee-summary", "invariant-list",
      "invariant-summary", "scenario-summary", "scenario-properties", "theater-provenance", "theater-inspector",
      "theater-log", "theater-caption", "theater-scrubber", "theater-step-label", "scenario-select", "theater-play",
      "theater-prev", "theater-next", "sandbox-toggle", "sandbox-panel", "theater-source", "main-content",
      "theater-legend", "invariant-details"].forEach(function (id) {
      DOM[id.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] = document.getElementById(id);
    });
  }

  var app = {
    data: null,
    scenario: null,
    scenarioId: "",
    states: [],            // states[i] = folded state after step i
    stepIndex: 0,
    playing: false,
    playTimer: null,
    scene: "",
    selected: "",
    sandbox: false,
    sandboxState: null,    // a perturbed copy of the trace state (null = mirror the trace)
    urlScene: "",
    urlObject: ""
  };

  /* ════════════════════════════════════════════════════════════
     DOM and SVG helpers
     ════════════════════════════════════════════════════════════ */

  var SVG_NS = "http://www.w3.org/2000/svg";
  function el(tag, props, kids) {
    var node = document.createElement(tag);
    if (props) for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k) || props[k] === undefined || props[k] === null) continue;
      if (k === "class") node.className = props[k];
      else if (k === "text") node.textContent = props[k];
      else if (k.indexOf("on") === 0 && typeof props[k] === "function") node.addEventListener(k.slice(2), props[k]);
      else if (k === "dataset") { for (var d in props[k]) node.dataset[d] = props[k][d]; }
      else node.setAttribute(k, props[k]);
    }
    if (kids) for (var i = 0; i < kids.length; i++) { var c = kids[i]; if (c == null) continue; node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
    return node;
  }
  function svg(tag, attrs, text) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function setStatus(text, isError) {
    if (!DOM.theaterStatus) return;
    DOM.theaterStatus.textContent = text;
    DOM.theaterStatus.classList.toggle("error", Boolean(isError));
    if (DOM.mainContent) DOM.mainContent.setAttribute("aria-busy", text && !isError ? "true" : "false");
  }

  /* Condense an SVG <text> so it never paints past `maxWidth`: SVG text neither
     wraps nor clips. Only text that overshoots is squeezed; a no-op in the
     headless test shim, which cannot measure. */
  function fitText(node, maxWidth, clip) {
    if (!node || !(maxWidth > 0) || typeof node.getComputedTextLength !== "function") return;
    try {
      var len = node.getComputedTextLength();
      if (!(isFinite(len) && len > maxWidth)) return;
      /* An identifier squeezed past legibility helps nobody: `clip` cuts it
         with an ellipsis and keeps the whole name as the tooltip. */
      if (clip) {
        var full = node.textContent;
        node.appendChild(svg("title", null, full));
        var keep = Math.max(1, Math.floor(full.length * maxWidth / len) - 1);
        node.firstChild.nodeValue = full.slice(0, keep) + "…";
        return;
      }
      node.setAttribute("textLength", String(Math.round(maxWidth)));
      node.setAttribute("lengthAdjust", "spacingAndGlyphs");
    } catch (e) { /* not measurable yet */ }
  }

  /* Reveal `line` inside its scroll panel without scrolling the window. */
  function keepLineWithin(container, line) {
    if (!container || !line || typeof line.getBoundingClientRect !== "function") return;
    try {
      var c = container.getBoundingClientRect();
      var l = line.getBoundingClientRect();
      if (l.top < c.top) container.scrollTop -= (c.top - l.top);
      else if (l.bottom > c.bottom) container.scrollTop += (l.bottom - c.bottom);
    } catch (e) { /* not measurable */ }
  }

  /* A scene canvas: an <svg> that grows to enclose what is drawn on it, plus
     the positions of every clickable object so edges can find them. */
  function Canvas(label) {
    this.root = svg("svg", { "class": "theater-svg", role: "img", "aria-label": label });
    this.defs = svg("defs");
    this.root.appendChild(this.defs);
    this.edges = svg("g", { "class": "scene-edges" });
    this.body = svg("g", { "class": "scene-body" });
    this.over = svg("g", { "class": "scene-over" });
    this.root.appendChild(this.edges);
    this.root.appendChild(this.body);
    this.root.appendChild(this.over);
    this.w = SCENE_W;
    this.h = 0;
    this.pos = {};
    this.fits = [];
    var markers = [["arrow", "mk-arrow"], ["arrow-ok", "mk-ok"], ["arrow-bad", "mk-bad"], ["arrow-msg", "mk-msg"], ["arrow-cdt", "mk-cdt"], ["arrow-muted", "mk-muted"]];
    for (var i = 0; i < markers.length; i++) {
      var m = svg("marker", { id: markers[i][0], viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
      m.appendChild(svg("path", { d: "M0,0 L10,5 L0,10 z", "class": markers[i][1] }));
      this.defs.appendChild(m);
    }
    var hatch = svg("pattern", { id: "hatch", width: "6", height: "6", patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
    hatch.appendChild(svg("line", { x1: "0", y1: "0", x2: "0", y2: "6", "class": "hatch-line" }));
    this.defs.appendChild(hatch);
  }
  Canvas.prototype.extend = function (x, y) { if (x > this.w) this.w = x; if (y > this.h) this.h = y; };
  Canvas.prototype.add = function (node, layer) { (layer || this.body).appendChild(node); return node; };
  Canvas.prototype.text = function (x, y, str, cls, opts) {
    opts = opts || {};
    var node = svg("text", { x: x, y: y, "class": cls, "text-anchor": opts.anchor || null }, str);
    (opts.parent || this.body).appendChild(node);
    if (opts.max) this.fits.push([node, opts.max, opts.clip]);
    this.extend(0, y + 6);   // the descender: a closing note must not be cut off
    return node;
  };
  Canvas.prototype.rect = function (x, y, w, h, cls, attrs, parent) {
    var a = { x: x, y: y, width: w, height: h, rx: 6, "class": cls };
    if (attrs) for (var k in attrs) a[k] = attrs[k];
    var node = svg("rect", a);
    (parent || this.body).appendChild(node);
    this.extend(x + w, y + h);
    return node;
  };
  Canvas.prototype.arrow = function (x1, y1, x2, y2, cls, marker, bend) {
    var d;
    if (bend) {
      var mx = (x1 + x2) / 2 + (bend.dx || 0), my = (y1 + y2) / 2 + (bend.dy || 0);
      d = "M" + x1 + "," + y1 + " Q" + mx + "," + my + " " + x2 + "," + y2;
    } else d = "M" + x1 + "," + y1 + " L" + x2 + "," + y2;
    var p = svg("path", { d: d, "class": cls, "marker-end": marker ? "url(#" + marker + ")" : null });
    this.edges.appendChild(p);
    return p;
  };
  Canvas.prototype.path = function (d, cls, marker, layer) {
    var p = svg("path", { d: d, "class": cls, "marker-end": marker ? "url(#" + marker + ")" : null });
    (layer || this.edges).appendChild(p);
    return p;
  };
  /* A clickable group that selects an object in the inspector. */
  Canvas.prototype.object = function (id, label, cls) {
    var g = svg("g", { "class": "theater-obj " + (cls || ""), tabindex: "0", role: "button", "aria-label": label, "data-object": id });
    if (app.selected === id) g.setAttribute("data-selected", "true");
    this.body.appendChild(g);
    return g;
  };
  Canvas.prototype.finish = function () {
    var w = Math.ceil(this.w + MARGIN), h = Math.ceil(this.h + MARGIN);
    this.root.setAttribute("viewBox", "0 0 " + w + " " + h);
    this.root.setAttribute("width", String(w));
    this.root.setAttribute("height", String(h));
    return this.root;
  };

  /* ════════════════════════════════════════════════════════════
     Trace-state helpers
     ════════════════════════════════════════════════════════════ */

  function currentStep() { return app.scenario ? app.scenario.steps[app.stepIndex] : null; }
  function traceState() { return app.states[app.stepIndex] || (app.scenario ? app.scenario.initialState : null); }
  function preState() { return app.stepIndex > 0 ? app.states[app.stepIndex - 1] : (app.scenario ? app.scenario.initialState : null); }
  function viewState() { return (app.sandbox && app.sandboxState) ? app.sandboxState : traceState(); }
  function stepOps(step) { return (step && step.delta && Array.isArray(step.delta.ops)) ? step.delta.ops : []; }
  function isRefused(step) { return !!(step && step.outcome && step.outcome.status === "error"); }
  function refusingStage(step) {
    var path = (step && step.path) || [];
    for (var i = 0; i < path.length; i++) if (path[i].result === "fail") return path[i];
    return null;
  }
  function stageOf(step, name) {
    var path = (step && step.path) || [];
    for (var i = 0; i < path.length; i++) if (path[i].stage === name) return path[i];
    return null;
  }
  /* What this step changed, by id: state-changing ops only, so a refused step
     highlights nothing. */
  function touchedNow() {
    var step = currentStep();
    if (!step || app.sandbox && app.sandboxState) return {};
    return E.touched(stepOps(step).filter(function (op) { return E.EVENT_OPS.indexOf(op.op) === -1; }));
  }

  var COLLECTIONS = ["threads", "endpoints", "notifications", "replies", "schedContexts", "cnodes", "untyped", "vspaces", "labels"];
  function findAny(s, id) {
    for (var i = 0; i < COLLECTIONS.length; i++) {
      var hit = E.byId(s && s[COLLECTIONS[i]], id);
      if (hit) return { kind: COLLECTIONS[i], obj: hit };
    }
    return null;
  }
  function nameOf(s, id) {
    if (id === null || id === undefined) return tt("run.idle", "idle");
    var ref = E.parseSlot(id);
    if (ref && E.byId(s.cnodes, ref.cnode)) return nameOf(s, ref.cnode) + " [" + ref.slot + "]";
    var hit = findAny(s, id);
    return (hit && hit.obj.name) || String(id);
  }
  function threadStatus(s, th) { return E.threadStatus(s, th).toLowerCase(); }
  function hex(n) { return "0x" + Number(n || 0).toString(16); }
  function bin(n, width) {
    var out = "";
    for (var i = width - 1; i >= 0; i--) out += Math.floor(Number(n) / Math.pow(2, i)) % 2;
    return out;
  }
  function bytes(n) {
    n = Number(n) || 0;
    if (n >= 1024 && n % 1024 === 0) return tt("run.kib", "{{n}} KiB", { n: fmtNum(n / 1024) });
    return tt("run.bytes", "{{n}} B", { n: fmtNum(n) });
  }
  var RIGHT_ABBR = { read: "R", write: "W", grant: "G", grantReply: "GR", retype: "RT" };
  function rightsText(rights) { return (rights || []).map(function (r) { return RIGHT_ABBR[r] || r; }).join(" ") || "—"; }
  function queueName(q) { return q === "send" ? tt("run.send_queue", "send queue") : tt("run.recv_queue", "receive queue"); }
  function ipcStateLabel(st) {
    switch (st) {
      case "ready": return tt("run.ipc_ready", "ready");
      case "blockedOnSend": return tt("run.ipc_send", "blocked on send");
      case "blockedOnReceive": return tt("run.ipc_receive", "blocked on receive");
      case "blockedOnCall": return tt("run.ipc_call", "blocked on call");
      case "blockedOnReply": return tt("run.ipc_reply", "blocked on reply");
      case "blockedOnNotification": return tt("run.ipc_notification", "blocked on notification");
      case "inactive": return tt("run.ipc_inactive", "inactive");
      default: return st || "";
    }
  }
  function statusLabel(st) {
    switch (st) {
      case "running": return tt("run.legend_running", "Running");
      case "ready": return tt("run.legend_ready", "Ready");
      case "blocked": return tt("run.legend_blocked", "Blocked");
      default: return tt("run.legend_inactive", "Inactive");
    }
  }
  function stageName(stage) {
    switch (stage) {
      case "entry": return tt("run.stage_entry", "entry");
      case "decode": return tt("run.stage_decode", "decode");
      case "lookup": return tt("run.stage_lookup", "lookup");
      case "rights": return tt("run.stage_rights", "rights");
      case "flow": return tt("run.stage_flow", "flow");
      case "operation": return tt("run.stage_operation", "operation");
      default: return stage;
    }
  }
  function kindLabel(kind) {
    switch (kind) {
      case "boot": return tt("run.kind_boot", "boot");
      case "syscall": return tt("run.kind_syscall", "syscall");
      case "schedule": return tt("run.kind_schedule", "schedule");
      case "timer": return tt("run.kind_timer", "timer");
      case "interrupt": return tt("run.kind_interrupt", "interrupt");
      case "fault": return tt("run.kind_fault", "fault");
      default: return kind;
    }
  }

  /* ════════════════════════════════════════════════════════════
     Shared SVG pieces
     ════════════════════════════════════════════════════════════ */

  /* A thread control block: name, priority, IPC state and its last message. */
  function threadChip(c, s, th, x, y, w, touched) {
    var status = threadStatus(s, th);
    var g = c.object(th.id, th.name + " · " + statusLabel(status), "theater-chip");
    var h = th.msg ? 58 : 44;
    c.rect(x, y, w, h, "chip-rect", { "data-status": status, "data-touched": touched[th.id] ? "true" : null }, g);
    c.rect(x, y + 6, 4, h - 12, "chip-stripe", { rx: 2, "data-status": status }, g);
    c.text(x + 12, y + 17, th.name, "chip-name", { parent: g, max: w - 60 });
    c.text(x + w - 8, y + 17, tt("run.prio_short", "prio {{p}}", { p: th.priority }), "chip-prio", { parent: g, anchor: "end" });
    var sub = statusLabel(status);
    if (th.ipc && th.ipc.state && th.ipc.state !== "ready") sub = ipcStateLabel(th.ipc.state) + (th.ipc.object ? " · " + nameOf(s, th.ipc.object) : "");
    c.text(x + 12, y + 33, sub, "chip-sub", { parent: g, max: w - 20 });
    if (th.msg) {
      var parts = [];
      if (th.msg.words && th.msg.words.length) parts.push("[" + th.msg.words.join(", ") + "]");
      if (th.msg.badge !== null && th.msg.badge !== undefined) parts.push(tt("run.badge_short", "badge {{b}}", { b: th.msg.badge }));
      if (th.msg.label) parts.push(tt("run.label_short", "label {{l}}", { l: th.msg.label }));
      c.text(x + 12, y + 49, "✉ " + (parts.join(" · ") || tt("run.empty_msg", "empty message")), "chip-msg", { parent: g, max: w - 20 });
    }
    c.pos[th.id] = { x: x, y: y, w: w, h: h };
    return h;
  }

  /* A compact thread token for queues: name, plus an optional note. */
  function miniChip(c, s, id, x, y, w, opts) {
    opts = opts || {};
    var th = E.byId(s.threads, id);
    var status = th ? threadStatus(s, th) : "inactive";
    var g = c.object(id, nameOf(s, id), "theater-chip mini-chip");
    var h = opts.note ? 32 : 24;
    c.rect(x, y, w, h, "chip-rect", { rx: 5, "data-status": status, "data-dim": opts.dim ? "true" : null, "data-touched": opts.touched ? "true" : null, "data-mark": opts.mark || null }, g);
    c.text(x + w / 2, y + 16, nameOf(s, id), "mini-name", { parent: g, anchor: "middle", max: w - 10 });
    if (opts.note) c.text(x + w / 2, y + 28, opts.note, "mini-note", { parent: g, anchor: "middle", max: w - 8 });
    c.pos[id] = c.pos[id] || { x: x, y: y, w: w, h: h };
    return h;
  }

  /* A FIFO chain of thread tokens joined head → tail. Returns the end x. */
  function chain(c, s, ids, x, y, w, gap, optsFor) {
    if (!ids.length) { c.text(x, y + 16, tt("run.empty", "— empty —"), "box-empty"); return x; }
    for (var i = 0; i < ids.length; i++) {
      var o = optsFor ? optsFor(ids[i], i) : {};
      miniChip(c, s, ids[i], x, y, w, o);
      if (i < ids.length - 1) c.arrow(x + w + 2, y + 12, x + w + gap - 3, y + 12, "queue-link", "arrow-muted");
      x += w + gap;
    }
    return x - gap;
  }

  function boxFrame(c, id, label, x, y, w, h, accent, touched) {
    var g = id ? c.object(id, label, "theater-box") : svg("g", { "class": "theater-box" });
    if (!id) c.body.appendChild(g);
    c.rect(x, y, w, h, "box-frame", { "data-accent": accent || null, "data-touched": touched ? "true" : null }, g);
    return g;
  }

  function message(c, lines, y) {
    var x = MARGIN;
    lines.forEach(function (line, i) { c.text(x, y + 18 + i * 20, line, i ? "scene-note" : "scene-lead", { max: SCENE_W - 2 * MARGIN }); });
    c.extend(SCENE_W, y + 18 + lines.length * 20);
    return y + 18 + lines.length * 20 + 8;
  }

  function sectionLabel(c, y, text) {
    c.text(MARGIN, y + 12, text, "section-label");
    return y + 22;
  }

  /* ════════════════════════════════════════════════════════════
     Scene: kernel path
     ════════════════════════════════════════════════════════════ */

  function renderPathScene(c, step) {
    var pre = preState();
    var y = MARGIN;
    if (!step || step.kind === "boot") {
      return message(c, [
        tt("run.path_boot", "The initial state. Nothing has run yet."),
        tt("run.path_boot_hint", "Step forward: each syscall shows the registers the kernel decodes, the CPtr it walks,"),
        tt("run.path_boot_hint2", "every gate it passes or fails, and each scheduling decision with the candidates it weighed.")
      ], y);
    }
    if (step.syscall) {
      y = drawRegisters(c, step, y);
      y = drawCapWalk(c, pre, step, y);
      y = drawPipeline(c, step, y);
    } else if (step.kind === "timer") {
      y = drawTick(c, pre, step, y);
    }
    if (dispatchOp(step)) y = drawSelection(c, pre, step, y);
    else if (!step.syscall && step.kind !== "timer") y = message(c, [step.title], y);
    return y;
  }

  function drawRegisters(c, step, y) {
    var call = step.syscall;
    y = sectionLabel(c, y, tt("run.registers", "Registers the kernel decodes ({{id}} = x7 {{n}})", { id: call.id, n: call.number }));
    var mi = call.msgInfo || {};
    var regs = [
      { reg: "x0", value: call.capPtr, cap: tt("run.reg_cptr", "CPtr"), used: call.capPtr !== undefined },
      { reg: "x1", value: E.msgInfoWord(mi), cap: tt("run.reg_msginfo", "msgInfo"), used: true }
    ];
    E.REGISTERS.msgRegs.forEach(function (r, i) {
      var a = (call.args || [])[i];
      regs.push({ reg: r, value: a ? a.value : undefined, cap: tt("run.reg_arg", "arg {{i}}", { i: i }), used: !!a });
    });
    regs.push({ reg: "x7", value: call.number, cap: call.id, used: true });
    var bw = 96, gap = 8, x = MARGIN;
    regs.forEach(function (r) {
      var g = svg("g", { "class": "reg", "data-used": r.used ? "true" : "false" });
      c.body.appendChild(g);
      c.rect(x, y, bw, 54, "reg-box", null, g);
      c.text(x + 8, y + 15, r.reg, "reg-name", { parent: g });
      c.text(x + bw / 2, y + 34, r.used ? hex(r.value) : "—", "reg-value", { parent: g, anchor: "middle", max: bw - 12 });
      c.text(x + bw / 2, y + 48, r.cap, "reg-cap", { parent: g, anchor: "middle", max: bw - 10 });
      x += bw + gap;
    });
    y += 66;
    var lines = [tt("run.msginfo_fields", "x1 = MessageInfo: length {{len}} | extraCaps {{caps}} << 7 | label {{label}} << 9", { len: mi.length || 0, caps: mi.extraCaps || 0, label: mi.label || 0 })];
    (call.args || []).forEach(function (a) { lines.push(a.reg + " = " + fmtNum(a.value) + " · " + a.name); });
    lines.forEach(function (line, i) { c.text(MARGIN, y + 12 + i * 17, line, "reg-legend", { max: SCENE_W - 2 * MARGIN }); });
    return y + lines.length * 17 + 14;
  }

  /* x0 walked through the caller's CSpace exactly as `resolveCapAddress`
     walks it: guard bits, then radix bits, one level per CNode. */
  function drawCapWalk(c, pre, step, y) {
    var call = step.syscall;
    var lookup = stageOf(step, "lookup");
    if (!lookup) {
      c.text(MARGIN, y + 14, tt("run.no_lookup", "{{id}} names no capability: x0 is not read and no rights are checked.", { id: call.id }), "scene-note", { max: SCENE_W - 2 * MARGIN });
      return y + 30;
    }
    var r = E.resolveCap(pre, step.actor, call.capPtr);
    var th = E.byId(pre.threads, step.actor);
    y = sectionLabel(c, y, tt("run.cap_walk", "x0 = {{cptr}} walked through {{who}}'s CSpace", { cptr: hex(call.capPtr), who: th ? th.name : step.actor }));
    var cell = 22;
    r.levels.forEach(function (lv) {
      var x = MARGIN;
      for (var i = 0; i < lv.bits; i++) {
        var bitPos = lv.bits - 1 - i;
        var role = i < lv.guardWidth ? "guard" : i < lv.guardWidth + lv.radixWidth ? "radix" : "rest";
        var bit = Math.floor(Number(call.capPtr) / Math.pow(2, bitPos)) % 2;
        c.rect(x + i * cell, y, cell - 2, 26, "bit-cell", { rx: 3, "data-role": role, "data-bad": role === "guard" && !lv.guardOk ? "true" : null });
        c.text(x + i * cell + (cell - 2) / 2, y + 18, String(bit), "bit-text", { anchor: "middle" });
      }
      var gx = x, gw = lv.guardWidth * cell - 2, rx = x + lv.guardWidth * cell, rw = lv.radixWidth * cell - 2;
      if (lv.guardWidth) {
        c.path("M" + gx + "," + (y + 31) + " L" + gx + "," + (y + 35) + " L" + (gx + gw) + "," + (y + 35) + " L" + (gx + gw) + "," + (y + 31), "bracket");
        c.text(gx + gw / 2, y + 49, tt("run.guard_check", "guard {{got}} {{op}} {{want}}", { got: bin(lv.guard, lv.guardWidth), op: lv.guardOk ? "=" : "≠", want: bin(lv.guardValue, lv.guardWidth) }), lv.guardOk ? "bit-note" : "bit-note bit-note-bad", { anchor: "middle" });
      }
      c.path("M" + rx + "," + (y + 31) + " L" + rx + "," + (y + 35) + " L" + (rx + rw) + "," + (y + 35) + " L" + (rx + rw) + "," + (y + 31), "bracket");
      c.text(rx + rw / 2, y + 49, tt("run.slot_index", "slot {{n}}", { n: lv.slot }), "bit-note", { anchor: "middle" });
      c.extend(x + lv.bits * cell, y + 52);

      // The CNode this level reads, its slots in a strip, the hit slot marked.
      var cn = E.byId(pre.cnodes, lv.cnode);
      var nx = MARGIN + lv.bits * cell + 34;
      c.arrow(MARGIN + lv.bits * cell + 4, y + 13, nx - 4, y + 13, "walk-arrow", "arrow");
      var slots = E.slotCount(cn || { radixWidth: lv.radixWidth });
      var sw = Math.min(16, Math.floor(240 / Math.max(1, Math.ceil(slots / 2))));
      var perRow = Math.ceil(slots / 2);
      for (var sI = 0; sI < slots; sI++) {
        var key = E.slotKey(lv.cnode, sI);
        var occupied = !!E.capAt(pre, key);
        var hit = sI === lv.slot && lv.guardOk;
        c.rect(nx + (sI % perRow) * (sw + 2), y + Math.floor(sI / perRow) * (sw / 1.2 + 2), sw, sw / 1.2, "slot-dot", { rx: 2, "data-occupied": occupied ? "true" : "false", "data-hit": hit ? (occupied ? "true" : "empty") : null });
      }
      c.text(nx, y + 2 * (sw / 1.2 + 2) + 12, (cn ? cn.name : lv.cnode), "walk-cnode", { max: perRow * (sw + 2) + 24 });
      var cx = nx + perRow * (sw + 2) + 30;
      if (!lv.guardOk) {
        c.text(cx, y + 18, tt("run.walk_guard_fail", "guard mismatch → invalidCapability"), "walk-fail");
        c.extend(cx + 240, y + 26);
      } else {
        var capHere = E.capAt(pre, E.slotKey(lv.cnode, lv.slot));
        c.arrow(cx - 26, y + 13, cx - 4, y + 13, "walk-arrow", "arrow");
        if (!capHere) {
          c.text(cx, y + 18, tt("run.walk_empty", "empty slot → invalidCapability"), "walk-fail");
          c.extend(cx + 240, y + 26);
        } else {
          drawCapCard(c, pre, capHere, E.slotKey(lv.cnode, lv.slot), cx, y - 6, call.requiredRight, step);
        }
      }
      y += 66;
    });
    if (r.error && !r.levels.length) {
      c.text(MARGIN, y + 14, r.error, "walk-fail");
      y += 26;
    }
    return y + 4;
  }

  function drawCapCard(c, s, cap, key, x, y, required, step) {
    var g = c.object(key, nameOf(s, key), "cap-card");
    var w = 230;
    c.rect(x, y, w, 52, "cap-rect", { "data-kind": cap.kind }, g);
    c.text(x + 10, y + 17, cap.kind + " → " + nameOf(s, cap.target), "cap-title", { parent: g, max: w - 20 });
    var rx = x + 10;
    E.RIGHTS.forEach(function (right) {
      var held = (cap.rights || []).indexOf(right) !== -1;
      var need = right === required;
      var label = RIGHT_ABBR[right];
      var bw = label.length > 1 ? 30 : 22;
      c.rect(rx, y + 26, bw, 18, "right-pill", { rx: 4, "data-held": held ? "true" : "false", "data-need": need ? (held ? "ok" : "missing") : null }, g);
      c.text(rx + bw / 2, y + 39, label, "right-text", { parent: g, anchor: "middle" });
      rx += bw + 4;
    });
    if (cap.badge !== undefined && cap.badge !== null) c.text(x + w - 10, y + 39, tt("run.badge_short", "badge {{b}}", { b: cap.badge }), "cap-badge", { parent: g, anchor: "end" });
    if (required) {
      var has = E.capHasRight(cap, required);
      var rights = stageOf(step, "rights");
      c.text(x + w + 10, y + 39, has ? tt("run.right_ok", "has {{r}} ✓", { r: required }) : tt("run.right_missing", "lacks {{r}} → illegalAuthority", { r: required }), has ? "walk-ok" : "walk-fail");
      if (rights && rights.result === "skip") c.text(x + w + 10, y + 22, tt("run.right_not_reached", "(rights check not reached)"), "scene-note");
    }
    c.extend(x + w + 220, y + 52);
  }

  function drawPipeline(c, step, y) {
    y = sectionLabel(c, y, tt("run.pipeline", "The checked path, stage by stage"));
    var x = MARGIN, pw = 92, gap = 20;
    var flowOp = null;
    stepOps(step).forEach(function (op) { if (op.op === "flowCheck") flowOp = op; });
    (step.path || []).forEach(function (stage, i) {
      var g = svg("g", { "class": "path-pill", "data-result": stage.result, "data-stage": stage.stage });
      c.body.appendChild(g);
      c.rect(x, y, pw, 46, "pill-rect", { rx: 8, "data-result": stage.result }, g);
      c.text(x + pw / 2, y + 19, (stage.result === "fail" ? "✕ " : stage.result === "skip" ? "– " : "✓ ") + stageName(stage.stage), "pill-name", { parent: g, anchor: "middle", max: pw - 8 });
      var sub = stage.result === "fail" ? "." + stage.error : stage.result === "skip" ? tt("run.not_reached", "not reached") : (stage.ref ? stage.ref.name : "");
      c.text(x + pw / 2, y + 36, sub, stage.result === "fail" ? "pill-sub pill-sub-bad" : "pill-sub", { parent: g, anchor: "middle", max: pw - 8, clip: true });
      if (stage.stage === "flow" && flowOp) {
        var s = preState();
        c.text(x + pw / 2, y + 62, nameOf(s, flowOp.from) + " → " + nameOf(s, flowOp.to), flowOp.allowed ? "flow-note" : "flow-note flow-note-bad", { anchor: "middle", max: pw + gap });
      }
      if (i < step.path.length - 1) c.arrow(x + pw + 2, y + 23, x + pw + gap - 2, y + 23, stage.result === "pass" ? "pipe-link" : "pipe-link pipe-link-off", "arrow-muted");
      x += pw + gap;
    });
    var refused = isRefused(step);
    var rw = 168;
    c.arrow(x - gap + 2, y + 23, x - 2, y + 23, "pipe-link", "arrow-muted");
    var rg = svg("g", { "class": "path-result", "data-outcome": refused ? "error" : "ok" });
    c.body.appendChild(rg);
    c.rect(x, y, rw, 46, "result-rect", { rx: 8, "data-outcome": refused ? "error" : "ok" }, rg);
    c.text(x + rw / 2, y + 19, refused ? "Except.error ." + step.outcome.error : "Except.ok (α, σ′)", "result-name", { parent: rg, anchor: "middle", max: rw - 10 });
    c.text(x + rw / 2, y + 36, refused ? tt("run.result_unchanged", "no successor state: σ unchanged") : tt("run.result_changed", "a new state σ′"), "result-sub", { parent: rg, anchor: "middle", max: rw - 10 });
    c.extend(x + rw, y + 70);
    return y + 80;
  }

  function dispatchOp(step) {
    var ops = stepOps(step);
    for (var i = 0; i < ops.length; i++) if (ops[i].op === "dispatch") return ops[i];
    return null;
  }

  /* The state just before the step's dispatch, so the selection drawn is the
     one `chooseThreadEffectiveOnCore` made. */
  function stateAtDispatch(pre, step) {
    var s = E.clone(pre);
    var ops = stepOps(step);
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].op === "dispatch") return { state: s, op: ops[i] };
      E.applyOp(s, ops[i]);
    }
    return null;
  }

  var REASONS = {
    first: ["run.why_first", "first eligible in the bucket"],
    priority: ["run.why_priority", "higher priority"],
    deadline: ["run.why_deadline", "earlier deadline"],
    lowerPriority: ["run.why_lower", "lower priority"],
    laterDeadline: ["run.why_later", "later deadline"],
    fifo: ["run.why_fifo", "queued behind an equal (FIFO)"],
    budget: ["run.why_budget", "no budget left: ineligible"],
    domain: ["run.why_domain", "another domain: ineligible"],
    missing: ["run.why_missing", "not a thread"]
  };
  function reasonText(r) { var e = REASONS[r]; return e ? tt(e[0], e[1]) : r; }

  function drawSelection(c, pre, step, y) {
    var at = stateAtDispatch(pre, step);
    if (!at) return y;
    var sel = E.selectOnCore(at.state, at.op.core);
    y = sectionLabel(c, y, sel.thread
      ? tt("run.sel_head", "Core {{core}} picks the next thread from the priority-{{p}} bucket", { core: at.op.core, p: sel.maxPrio })
      : tt("run.sel_idle", "Core {{core}} has no runnable thread: it idles", { core: at.op.core }));
    if (!sel.candidates.length) {
      c.text(MARGIN, y + 14, tt("run.sel_empty", "The run queue is empty."), "scene-note");
      return y + 30;
    }
    sel.candidates.forEach(function (row, i) {
      var chosen = row.thread === sel.thread;
      var x = MARGIN;
      miniChip(c, at.state, row.thread, x, y, 110, { mark: chosen ? "chosen" : null, dim: !row.eligible });
      c.text(x + 124, y + 16, tt("run.prio_short", "prio {{p}}", { p: row.bucket }), "sel-cell");
      c.text(x + 196, y + 16, row.deadline ? tt("run.deadline_short", "deadline {{d}}", { d: row.deadline }) : tt("run.no_deadline", "no deadline"), "sel-cell");
      c.text(x + 320, y + 16, (chosen ? "★ " + tt("run.chosen", "chosen") + " · " : "") + reasonText(row.reason), chosen ? "sel-why sel-why-chosen" : row.eligible ? "sel-why" : "sel-why sel-why-bad", { max: SCENE_W - 340 });
      c.extend(SCENE_W, y + 24);
      y += 30;
      if (i === sel.candidates.length - 1 && sel.fallback) {
        c.text(MARGIN, y + 12, tt("run.sel_fallback", "No eligible thread in the top bucket, so the whole queue was scanned."), "scene-note");
        y += 22;
      }
    });
    return y + 8;
  }

  /* A timer tick: what it charged, before and after. */
  function drawTick(c, pre, step, y) {
    var post = traceState();
    var cid = step.core || 0;
    var core = E.byId(pre.cores, cid);
    var th = core && E.byId(pre.threads, core.current);
    y = sectionLabel(c, y, tt("run.tick_head", "Timer tick on core {{core}}", { core: cid }));
    if (!th) return y + 10;
    var after = E.byId(post.threads, th.id);
    if (th.sc) {
      var a = E.byId(pre.schedContexts, th.sc), b = E.byId(post.schedContexts, th.sc);
      y = budgetRow(c, th.name + " · " + tt("run.budget_before", "budget before"), a, y);
      y = budgetRow(c, th.name + " · " + tt("run.budget_after", "after"), b, y);
      if (b && b.remaining === 0) c.text(MARGIN, y + 12, tt("run.budget_exhausted", "Budget exhausted: the thread is requeued but ineligible until its refill, {{n}} ticks out. Its deadline does not move.", { n: b.refillIn }), "scene-note", { max: SCENE_W - 2 * MARGIN });
      return y + 26;
    }
    y = sliceRow(c, th.name + " · " + tt("run.slice_before", "slice before"), th.timeSlice, y);
    y = sliceRow(c, th.name + " · " + tt("run.slice_after", "after"), after ? after.timeSlice : 0, y);
    if (after && after.timeSlice === DEFAULT_SLICE && th.timeSlice <= 1) c.text(MARGIN, y + 12, tt("run.slice_expired", "Slice expired: refilled to {{n}} and requeued at the tail of its bucket.", { n: DEFAULT_SLICE }), "scene-note", { max: SCENE_W - 2 * MARGIN });
    return y + 26;
  }
  function sliceRow(c, label, value, y) {
    c.text(MARGIN, y + 14, label, "bar-label", { max: 200 });
    for (var i = 0; i < DEFAULT_SLICE; i++) c.rect(MARGIN + 210 + i * 26, y + 2, 22, 16, "tick-cell", { rx: 3, "data-full": i < value ? "true" : "false" });
    c.text(MARGIN + 210 + DEFAULT_SLICE * 26 + 8, y + 15, tt("run.ticks_left", "{{n}} left", { n: value }), "bar-value");
    return y + 24;
  }
  function budgetRow(c, label, sc, y) {
    if (!sc) return y;
    c.text(MARGIN, y + 14, label, "bar-label", { max: 200 });
    var w = 160;
    c.rect(MARGIN + 210, y + 2, w, 16, "budget-track", { rx: 3 });
    c.rect(MARGIN + 210, y + 2, Math.max(0, w * sc.remaining / Math.max(1, sc.budget)), 16, "budget-fill", { rx: 3, "data-empty": sc.remaining === 0 ? "true" : "false" });
    c.text(MARGIN + 210 + w + 8, y + 15, tt("run.budget_value", "{{r}} / {{b}} · deadline {{d}}", { r: sc.remaining, b: sc.budget, d: sc.deadline }), "bar-value");
    return y + 24;
  }

  /* ════════════════════════════════════════════════════════════
     Scene: IPC
     ════════════════════════════════════════════════════════════ */

  function renderIpcScene(c, step) {
    var s = viewState();
    var touched = touchedNow();
    var y0 = MARGIN;
    c.text(MARGIN, y0 + 10, tt("run.col_threads", "Threads"), "section-label");
    // The gap between the columns is where a delivered message's tag sits.
    var objX = MARGIN + 200 + 130, objW = SCENE_W - objX;
    c.text(objX, y0 + 10, tt("run.col_objects", "IPC objects"), "section-label");
    var y = y0 + 22;
    (s.threads || []).forEach(function (th) { y += threadChip(c, s, th, MARGIN, y, 200, touched) + 10; });
    var ty = y;

    var oy = y0 + 22;
    var anchors = {};
    (s.endpoints || []).forEach(function (ep) {
      var h = 110;
      var g = boxFrame(c, ep.id, ep.name, objX, oy, objW, h, "endpoint", touched[ep.id]);
      c.text(objX + 12, oy + 18, tt("run.endpoint", "Endpoint") + " · " + ep.name, "box-title", { parent: g, max: objW - 24 }).setAttribute("data-accent", "endpoint");
      lane(c, s, g, objX, oy + 30, objW, tt("run.send_queue", "send queue"), ep.send || [], touched);
      lane(c, s, g, objX, oy + 70, objW, tt("run.recv_queue", "receive queue"), ep.recv || [], touched);
      anchors[ep.id] = { x: objX, y: oy, w: objW, h: h, lane: { send: oy + 44, recv: oy + 84 } };
      oy += h + 12;
    });
    (s.notifications || []).forEach(function (n) {
      var h = 110;
      var state = E.notificationState(n);
      var g = boxFrame(c, n.id, n.name, objX, oy, objW, h, "notification", touched[n.id]);
      c.text(objX + 12, oy + 18, tt("run.notification", "Notification") + " · " + n.name, "box-title", { parent: g, max: objW - 140 }).setAttribute("data-accent", "notification");
      c.text(objX + objW - 12, oy + 18, tt("run.ntfn_" + state, state), "ntfn-state", { parent: g, anchor: "end" }).setAttribute("data-state", state);
      c.text(objX + 12, oy + 46, tt("run.word", "word"), "lane-label", { parent: g });
      var word = n.pending === null || n.pending === undefined ? 0 : n.pending;
      for (var b = 7; b >= 0; b--) {
        var on = Math.floor(word / Math.pow(2, b)) % 2 === 1;
        var bx = objX + 110 + (7 - b) * 24;
        c.rect(bx, oy + 32, 20, 20, "badge-bit", { rx: 3, "data-on": on ? "true" : "false" }, g);
        c.text(bx + 10, oy + 46, on ? "1" : "0", "bit-text", { parent: g, anchor: "middle" });
      }
      c.text(objX + 110 + 8 * 24 + 8, oy + 46, (n.pending === null || n.pending === undefined) ? tt("run.no_pending", "nothing pending") : "= " + n.pending, "lane-note", { parent: g });
      lane(c, s, g, objX, oy + 70, objW, tt("run.waiters", "waiters"), n.waiters || [], touched);
      anchors[n.id] = { x: objX, y: oy, w: objW, h: h, lane: { wait: oy + 84 } };
      oy += h + 12;
    });
    (s.replies || []).forEach(function (r) {
      var h = 50;
      var g = boxFrame(c, r.id, r.name, objX, oy, objW, h, "reply", touched[r.id]);
      c.text(objX + 12, oy + 18, tt("run.reply_object", "Reply object") + " · " + r.name, "box-title", { parent: g, max: objW - 24 }).setAttribute("data-accent", "reply");
      c.text(objX + 12, oy + 38, r.caller ? tt("run.reply_caller", "caller: {{who}} (waiting for the answer)", { who: nameOf(s, r.caller) }) : tt("run.reply_free", "no caller: free"), "lane-note", { parent: g, max: objW - 24 });
      anchors[r.id] = { x: objX, y: oy, w: objW, h: h };
      oy += h + 12;
    });
    if (!(s.endpoints || []).length && !(s.notifications || []).length) c.text(objX, y0 + 40, tt("run.no_ipc", "— no IPC objects —"), "box-empty");

    // Who waits on what.
    (s.threads || []).forEach(function (th) {
      var p = c.pos[th.id];
      if (!p || !th.ipc) return;
      var target = th.ipc.state === "blockedOnReply" ? th.replyObject : th.ipc.object;
      var a = target && anchors[target];
      if (!a || th.ipc.state === "ready") return;
      var ty2 = th.ipc.state === "blockedOnReceive" ? a.lane && a.lane.recv : th.ipc.state === "blockedOnNotification" ? a.lane && a.lane.wait : th.ipc.state === "blockedOnReply" ? a.y + a.h / 2 : a.lane && a.lane.send;
      c.arrow(p.x + p.w, p.y + p.h / 2, a.x - 2, ty2 || a.y + 20, th.ipc.state === "blockedOnReply" ? "wait-edge wait-edge-reply" : "wait-edge", "arrow-muted", { dx: 0, dy: 0 });
    });
    (s.threads || []).forEach(function (th) {
      if (!th.pendingReply || !anchors[th.pendingReply] || !c.pos[th.id]) return;
      var p = c.pos[th.id], a = anchors[th.pendingReply];
      c.arrow(p.x + p.w, p.y + p.h - 6, a.x - 2, a.y + a.h / 2, "stash-edge", null, { dx: -20, dy: 10 });
    });

    // Messages this step delivered: sender → object → receiver.
    if (!(app.sandbox && app.sandboxState)) drawMessages(c, s, step, anchors);
    c.extend(SCENE_W, Math.max(ty, oy));
  }

  function lane(c, s, g, x, y, w, label, ids, touched) {
    c.text(x + 12, y + 16, label, "lane-label", { parent: g });
    chain(c, s, ids, x + 110, y + 2, 86, 22, function (id, i) { return { touched: touched[id], mark: i === 0 ? "head" : null }; });
  }

  function drawMessages(c, s, step, anchors) {
    stepOps(step).forEach(function (op) {
      var to = null, from = null, via = null, label = "";
      if (op.op === "message") {
        to = op.to; from = op.from; via = op.via;
        var parts = [];
        if (op.words && op.words.length) parts.push("[" + op.words.join(", ") + "]");
        if (op.badge !== undefined && op.badge !== null) parts.push(tt("run.badge_short", "badge {{b}}", { b: op.badge }));
        label = parts.join(" · ");
      } else if (op.op === "threadPatch" && op.set && op.set.msg && op.set.msg.via) {
        to = op.id; via = op.set.msg.via;
        label = tt("run.badge_short", "badge {{b}}", { b: op.set.msg.badge });
      } else return;
      var pt = c.pos[to], a = via && anchors[via];
      if (!pt) return;
      var endX = pt.x + pt.w, endY = pt.y + pt.h / 2;
      var midX = a ? a.x + 40 : endX + 60, midY = a ? a.y + 22 : endY;
      var d;
      if (from && c.pos[from]) {
        var pf = c.pos[from];
        d = "M" + (pf.x + pf.w) + "," + (pf.y + pf.h / 2) + " C" + (midX - 30) + "," + (pf.y + pf.h / 2) + " " + (midX - 30) + "," + midY + " " + midX + "," + midY +
            " C" + (midX - 30) + "," + midY + " " + (endX + 50) + "," + endY + " " + (endX + 3) + "," + endY;
      } else {
        d = "M" + midX + "," + midY + " C" + (midX - 40) + "," + midY + " " + (endX + 50) + "," + endY + " " + (endX + 3) + "," + endY;
      }
      c.path(d, "msg-path", "arrow-msg", c.over);
      // The tag rides the last leg, in the gap between receiver and object.
      var tw = Math.max(64, label.length * 6.2 + 26);
      var gapL = endX + 6, gapR = a ? a.x - 6 : endX + 126;
      var lx = Math.max(gapL, (gapL + gapR) / 2 - tw / 2), ly = (midY + endY) / 2 + 4;
      var tag = svg("g", { "class": "msg-tag" });
      c.over.appendChild(tag);
      c.rect(lx, ly - 13, tw, 20, "msg-tag-rect", { rx: 10 }, tag);
      c.text(lx + 10, ly + 1, "✉ " + label, "msg-tag-text", { parent: tag, max: tw - 16 });
    });
  }

  /* ════════════════════════════════════════════════════════════
     Scene: scheduler
     ════════════════════════════════════════════════════════════ */

  function renderSchedulerScene(c, step) {
    var s = viewState();
    var touched = touchedNow();
    var y = MARGIN;
    (s.cores || []).forEach(function (core) {
      var sel = E.selectOnCore(s, core.id);
      var rq = (s.runQueues && s.runQueues[String(core.id)]) || [];
      var prios = [];
      rq.forEach(function (e) { if (prios.indexOf(e.prio) === -1) prios.push(e.prio); });
      prios.sort(function (a, b) { return b - a; });
      var cur = core.current !== null && core.current !== undefined ? E.byId(s.threads, core.current) : null;
      // The running chip, its meter and the meter's caption, or one row per bucket.
      var h = Math.max(cur ? 48 + (cur.msg ? 58 : 44) + 6 + 34 : 110, 56 + Math.max(1, prios.length) * 42);
      var g = boxFrame(c, "core:" + core.id, tt("run.core", "Core {{n}}", { n: core.id }), MARGIN, y, SCENE_W - MARGIN, h, "core", touched["core:" + core.id]);
      c.text(MARGIN + 12, y + 18, tt("run.core_head", "Core {{n}} · domain {{d}}", { n: core.id, d: core.domain }), "box-title", { parent: g }).setAttribute("data-accent", "core");
      c.text(MARGIN + 12, y + 40, tt("run.running", "running"), "lane-label", { parent: g });
      if (cur) {
        threadChip(c, s, cur, MARGIN + 12, y + 48, 190, touched);
        drawThreadMeter(c, s, cur, MARGIN + 12, y + 48 + (cur.msg ? 58 : 44) + 6);
      } else {
        c.rect(MARGIN + 12, y + 48, 190, 44, "idle-rect", { rx: 6 });
        c.text(MARGIN + 107, y + 75, tt("run.idle_core", "idle"), "box-empty", { anchor: "middle" });
      }
      var qx = MARGIN + 240;
      c.text(qx, y + 40, tt("run.run_queue", "run queue, highest bucket first"), "lane-label", { parent: g });
      if (!prios.length) c.text(qx, y + 70, tt("run.runqueue_empty", "— no ready threads —"), "box-empty");
      prios.forEach(function (p, i) {
        var by = y + 50 + i * 42;
        c.text(qx, by + 20, tt("run.prio_short", "prio {{p}}", { p: p }), "bucket-label");
        var ids = rq.filter(function (e) { return e.prio === p; }).map(function (e) { return e.thread; });
        chain(c, s, ids, qx + 70, by, 96, 20, function (id) {
          var row = null;
          sel.candidates.forEach(function (r) { if (r.thread === id) row = r; });
          var chosen = sel.thread === id;
          return {
            touched: touched[id],
            mark: chosen ? "chosen" : null,
            dim: row && !row.eligible,
            note: chosen ? "▸ " + tt("run.next_pick", "next pick") : row && !row.eligible ? reasonText(row.reason).split(":")[0] : null
          };
        });
      });
      y += h + 14;
    });

    var blocked = (s.threads || []).filter(function (th) { var st = threadStatus(s, th); return st === "blocked" || st === "inactive"; });
    if (blocked.length) {
      y = sectionLabel(c, y, tt("run.not_runnable", "Not runnable"));
      var x = MARGIN;
      blocked.forEach(function (th) {
        if (x + 200 > SCENE_W) { x = MARGIN; y += 56; }
        threadChip(c, s, th, x, y, 190, touched);
        x += 200;
      });
      y += 58;
    }
    if ((s.schedContexts || []).length) {
      y = sectionLabel(c, y, tt("run.sched_contexts", "Scheduling contexts (budget per period, EDF deadline)"));
      (s.schedContexts || []).forEach(function (sc) {
        var owner = (s.threads || []).filter(function (th) { return th.sc === sc.id; })[0];
        var g = c.object(sc.id, sc.id, "sc-row");
        c.rect(MARGIN, y, SCENE_W - MARGIN, 30, "sc-rect", { rx: 5, "data-touched": touched[sc.id] ? "true" : null }, g);
        c.text(MARGIN + 10, y + 20, (owner ? owner.name : sc.id), "sc-name", { parent: g, max: 110 });
        var w = 180;
        c.rect(MARGIN + 130, y + 8, w, 14, "budget-track", { rx: 3 }, g);
        c.rect(MARGIN + 130, y + 8, Math.max(0, w * sc.remaining / Math.max(1, sc.budget)), 14, "budget-fill", { rx: 3, "data-empty": sc.remaining === 0 ? "true" : "false" }, g);
        c.text(MARGIN + 130 + w + 10, y + 20, tt("run.sc_line", "{{r}} / {{b}} ticks · period {{p}} · deadline {{d}}", { r: sc.remaining, b: sc.budget, p: sc.period, d: sc.deadline }) + (sc.refillIn ? " · " + tt("run.refill_in", "refill in {{n}}", { n: sc.refillIn }) : ""), "sc-text", { parent: g, max: SCENE_W - MARGIN - 340 });
        y += 36;
      });
    }
    c.extend(SCENE_W, y);
  }

  function drawThreadMeter(c, s, th, x, y) {
    if (th.sc) {
      var sc = E.byId(s.schedContexts, th.sc);
      if (!sc) return;
      c.rect(x, y, 190, 10, "budget-track", { rx: 3 });
      c.rect(x, y, Math.max(0, 190 * sc.remaining / Math.max(1, sc.budget)), 10, "budget-fill", { rx: 3, "data-empty": sc.remaining === 0 ? "true" : "false" });
      c.text(x, y + 24, tt("run.budget_value", "{{r}} / {{b}} · deadline {{d}}", { r: sc.remaining, b: sc.budget, d: sc.deadline }), "bar-value");
      return;
    }
    for (var i = 0; i < DEFAULT_SLICE; i++) c.rect(x + i * 38, y, 34, 10, "tick-cell", { rx: 3, "data-full": i < th.timeSlice ? "true" : "false" });
    c.text(x, y + 24, tt("run.slice_left", "time slice: {{n}} of {{max}} ticks left", { n: th.timeSlice, max: DEFAULT_SLICE }), "bar-value");
  }

  /* ════════════════════════════════════════════════════════════
     Scene: CSpace
     ════════════════════════════════════════════════════════════ */

  function renderCSpaceScene(c, step) {
    var s = viewState();
    var pre = preState();
    var touched = touchedNow();
    var y = MARGIN;
    var cols = 8, cw = 84, ch = 56, gap = 6;
    var cells = {};
    (s.cnodes || []).forEach(function (cn) {
      var slots = E.slotCount(cn);
      var rows = Math.ceil(slots / cols);
      var top = y + 64;
      var h = 64 + rows * (ch + gap) + 8;
      var g = boxFrame(c, cn.id, cn.name, MARGIN, y, SCENE_W - MARGIN, h, "cnode", touched[cn.id]);
      c.text(MARGIN + 12, y + 18, tt("run.cnode", "CNode") + " · " + cn.name, "box-title", { parent: g, max: SCENE_W - 60 }).setAttribute("data-accent", "cnode");
      var owners = (s.threads || []).filter(function (th) { return th.cspace === cn.id; }).map(function (th) { return th.name; });
      c.text(MARGIN + 12, y + 36, tt("run.cnode_geometry", "depth {{d}} = guard {{gw}} bits ({{gv}}) + radix {{r}} bits · {{n}} slots", { d: cn.depth, gw: cn.guardWidth, gv: bin(cn.guardValue, cn.guardWidth) || "–", r: cn.radixWidth, n: slots }) + (owners.length ? " · " + tt("run.cspace_of", "CSpace of {{who}}", { who: owners.join(", ") }) : ""), "box-sub", { parent: g, max: SCENE_W - 60 });
      for (var i = 0; i < slots; i++) {
        var key = E.slotKey(cn.id, i);
        var cx = MARGIN + 10 + (i % cols) * (cw + gap), cy = top + Math.floor(i / cols) * (ch + gap);
        var cap = E.capAt(s, key);
        var was = pre && E.capAt(pre, key);
        var gone = !cap && was && !isRefused(step) && !(app.sandbox && app.sandboxState);
        var cg = cap ? c.object(key, nameOf(s, key), "slot") : svg("g", { "class": "slot" });
        if (!cap) c.body.appendChild(cg);
        c.rect(cx, cy, cw, ch, "slot-rect", { rx: 5, "data-occupied": cap ? "true" : "false", "data-kind": cap ? cap.kind : null, "data-touched": touched[key] ? "true" : null, "data-gone": gone ? "true" : null }, cg);
        c.text(cx + 6, cy + 13, String(i), "slot-index", { parent: cg });
        if (cap) {
          c.text(cx + cw - 6, cy + 13, cap.kind, "slot-kind", { parent: cg, anchor: "end", max: cw - 22 });
          c.text(cx + 6, cy + 31, nameOf(s, cap.target), "slot-target", { parent: cg, max: cw - 12 });
          c.text(cx + 6, cy + 48, rightsText(cap.rights) + (cap.badge !== undefined && cap.badge !== null ? " · #" + cap.badge : ""), "slot-rights", { parent: cg, max: cw - 12 });
        } else if (gone) {
          c.text(cx + cw / 2, cy + 36, tt("run.deleted", "deleted"), "slot-gone", { parent: cg, anchor: "middle" });
        }
        cells[key] = { x: cx, y: cy, w: cw, h: ch };
      }
      y += h + 14;
    });
    // Derivation edges, parent → child, arched over the grid.
    var cdt = s.cdt || {};
    var k = 0;
    Object.keys(cdt).forEach(function (p) {
      (cdt[p] || []).forEach(function (child) {
        var a = cells[p], b = cells[child];
        if (!a || !b) return;
        var x1 = a.x + a.w / 2, y1 = a.y + 2, x2 = b.x + b.w / 2, y2 = b.y + 2;
        var lift = 18 + (k++ % 3) * 7 + Math.abs(x2 - x1) / 20;
        var top = Math.min(y1, y2) - lift;
        c.path("M" + x1 + "," + y1 + " C" + x1 + "," + top + " " + x2 + "," + top + " " + x2 + "," + (y2 - 1), "cdt-edge", "arrow-cdt", c.over).setAttribute("data-touched", touched[child] ? "true" : "false");
      });
    });
    if (!(s.cnodes || []).length) c.text(MARGIN, y + 20, tt("run.no_caps", "— no capabilities —"), "box-empty");
    c.extend(SCENE_W, y);
  }

  /* ════════════════════════════════════════════════════════════
     Scene: memory (untyped regions and address spaces)
     ════════════════════════════════════════════════════════════ */

  function renderMemoryScene(c, step) {
    var s = viewState();
    var pre = preState();
    var touched = touchedNow();
    var y = MARGIN;
    (s.untyped || []).forEach(function (u) {
      var h = 128;
      var g = boxFrame(c, u.id, u.name, MARGIN, y, SCENE_W - MARGIN, h, "memory", touched[u.id]);
      c.text(MARGIN + 12, y + 18, tt("run.untyped", "Untyped") + " · " + u.name, "box-title", { parent: g }).setAttribute("data-accent", "memory");
      c.text(MARGIN + 12, y + 36, tt("run.untyped_line", "{{size}} at {{base}} · watermark {{wm}} · {{free}} free", { size: bytes(u.size), base: hex(u.base), wm: fmtNum(u.watermark), free: bytes(u.size - u.watermark) }), "box-sub", { parent: g, max: SCENE_W - 60 });
      var bx = MARGIN + 14, bw = SCENE_W - MARGIN - 28, by = y + 50, bh = 40;
      var scale = bw / Math.max(1, u.size);
      c.rect(bx, by, bw, bh, "mem-track", { rx: 4 }, g);
      c.rect(bx + u.watermark * scale, by, (u.size - u.watermark) * scale, bh, "mem-free", { rx: 0 }, g);
      (u.children || []).forEach(function (ch) {
        var cg = svg("g", { "class": "mem-child-g" });
        g.appendChild(cg);
        c.rect(bx + ch.offset * scale, by, Math.max(2, ch.size * scale), bh, "mem-child", { rx: 0, "data-kind": ch.kind, "data-touched": touched[ch.id] ? "true" : null }, cg);
        c.text(bx + ch.offset * scale + 6, by + 17, ch.kind + " · " + ch.id, "mem-child-label", { parent: cg, max: ch.size * scale - 10 });
        c.text(bx + ch.offset * scale + 6, by + 32, bytes(ch.size), "mem-child-sub", { parent: cg, max: ch.size * scale - 10 });
      });
      var wx = bx + u.watermark * scale;
      c.path("M" + wx + "," + (by - 6) + " L" + wx + "," + (by + bh + 6), "mem-watermark", null, c.over);
      c.text(wx < bx + 80 ? Math.max(bx, wx - 4) : Math.min(wx, bx + bw - 4), by + bh + 20, "▲ " + tt("run.watermark", "watermark {{n}}", { n: fmtNum(u.watermark) }), "mem-wm-label", { anchor: wx > bx + bw - 80 ? "end" : wx < bx + 80 ? "start" : "middle" });
      c.text(bx, by + bh + 34, "0", "mem-scale");
      c.text(bx + bw, by + bh + 34, fmtNum(u.size), "mem-scale", { anchor: "end" });
      // A refused carve: the request drawn where it would have gone.
      if (step && isRefused(step) && step.syscall && step.syscall.id === "untypedRetype") {
        var req = retypeRequestSize(step.syscall);
        if (req) {
          // Drawn to scale up to the region's end; a request that overruns it
          // is cut there with a jagged edge, because the region has no more.
          var rx = wx, full = req * scale, rw = Math.min(full, bx + bw - wx);
          c.rect(rx, by - 4, rw, bh + 8, "mem-request", { rx: 3 }, c.over);
          if (full > rw) c.path("M" + (rx + rw) + "," + (by - 4) + " l6,8 l-6,8 l6,8 l-6,8 l6,8 l-6,8", "mem-overrun", null, c.over);
          c.text(bx + bw, by - 9, tt("run.request_refused", "{{req}} requested, {{free}} free → untypedRegionExhausted", { req: bytes(req), free: bytes(u.size - u.watermark) }), "mem-request-label", { parent: c.over, anchor: "end", max: bw });
        }
      }
      y += h + 14;
    });

    (s.vspaces || []).forEach(function (v) {
      var prev = pre && E.byId(pre.vspaces, v.id);
      var rejected = stepOps(step).filter(function (op) { return op.op === "vspaceReject" && op.vspace === v.id; });
      var gone = (prev && !(app.sandbox && app.sandboxState) ? prev.mappings || [] : []).filter(function (m) { return !(v.mappings || []).some(function (n) { return n.vaddr === m.vaddr; }); });
      var rows = (v.mappings || []).length + rejected.length + gone.length;
      var h = 64 + Math.max(1, rows) * 26 + 8;
      var g = boxFrame(c, v.id, v.name, MARGIN, y, SCENE_W - MARGIN, h, "vspace", touched[v.id]);
      c.text(MARGIN + 12, y + 18, tt("run.vspace", "Address space") + " · " + v.name + " · ASID " + v.asid, "box-title", { parent: g, max: SCENE_W - 60 }).setAttribute("data-accent", "vspace");
      var cols = [MARGIN + 14, MARGIN + 150, MARGIN + 300, MARGIN + 430, MARGIN + 560];
      [tt("run.vaddr", "virtual address"), tt("run.frame", "frame"), tt("run.perms", "permissions"), "W^X", tt("run.tlb", "TLB (this core)")].forEach(function (hd, i) { c.text(cols[i], y + 44, hd, "vs-head", { parent: g }); });
      var ry = y + 52;
      function row(m, kind) {
        var rg = svg("g", { "class": "vs-row", "data-kind": kind, "data-touched": touched[v.id + "@" + m.vaddr] ? "true" : null });
        g.appendChild(rg);
        c.rect(MARGIN + 8, ry, SCENE_W - MARGIN - 16, 22, "vs-row-rect", { rx: 4 }, rg);
        c.text(cols[0], ry + 15, m.vaddr, "vs-addr", { parent: rg });
        c.text(cols[1], ry + 15, m.frame ? nameOf(s, m.frame) : "—", "vs-frame", { parent: rg, max: 140 });
        var perms = String(m.perms || "---");
        for (var i = 0; i < 3; i++) {
          var ch = perms.charAt(i);
          c.text(cols[2] + i * 14, ry + 15, ch, "vs-perm", { parent: rg }).setAttribute("data-bit", ch === "-" ? "off" : ch);
        }
        var wxBad = perms.indexOf("w") !== -1 && perms.indexOf("x") !== -1;
        c.text(cols[3], ry + 15, kind === "rejected" ? "✕ " + tt("run.refused", "refused") : wxBad ? "✕" : "✓", wxBad || kind === "rejected" ? "vs-rejected" : "vs-ok", { parent: rg });
        var cached = (v.tlb || []).indexOf(m.vaddr) !== -1;
        c.text(cols[4], ry + 15, kind === "gone" ? tt("run.shot_down", "unmapped · shot down") : kind === "rejected" ? "—" : cached ? tt("run.cached", "cached") : "—", kind === "gone" ? "vs-shootdown" : cached ? "vs-tlb" : "vs-tlb vs-tlb-none", { parent: rg, max: SCENE_W - cols[4] - 20 });
        ry += 26;
      }
      (v.mappings || []).forEach(function (m) { row(m, "live"); });
      rejected.forEach(function (op) { row({ vaddr: op.vaddr, frame: null, perms: op.perms }, "rejected"); });
      gone.forEach(function (m) { row(m, "gone"); });
      if (!rows) c.text(cols[0], ry + 15, tt("run.no_mappings", "— no mappings —"), "box-empty");
      y += h + 14;
    });
    if (!(s.untyped || []).length && !(s.vspaces || []).length) c.text(MARGIN, y + 20, tt("run.no_memory", "— no untyped memory or address spaces —"), "box-empty");
    c.extend(SCENE_W, y);
  }

  /* x2 packs the type and size bits (`decodeUntypedRetypeArgs`); a frame is a page. */
  function retypeRequestSize(call) {
    var a = (call.args || [])[0];
    if (!a) return 0;
    var type = a.value % 256, sizeBits = Math.floor(a.value / 256);
    if (type === 5) return Math.pow(2, sizeBits);
    if (type === 8 || type === 9 || type === 4) return 4096;
    return 0;
  }

  /* ════════════════════════════════════════════════════════════
     Scene: information flow
     ════════════════════════════════════════════════════════════ */

  function renderInfoflowScene(c, step) {
    var s = viewState();
    var nw = 250, nh = 108, gx = 140, gy = 70;
    var x0 = MARGIN + 30, y0 = MARGIN + 36;
    function slot(conf, integ) { return { x: x0 + (conf === "high" ? nw + gx : 0), y: y0 + (integ === "untrusted" ? nh + gy : 0) }; }
    c.text(x0, MARGIN + 12, tt("run.lattice_axis", "confidentiality may only rise (→) and integrity may only fall (↓)"), "section-label");
    var byLabel = {};
    (s.labels || []).forEach(function (l) { byLabel[l.conf + "/" + l.integ] = l; });
    var nodes = {};
    [["low", "trusted"], ["high", "trusted"], ["low", "untrusted"], ["high", "untrusted"]].forEach(function (ci) {
      var p = slot(ci[0], ci[1]);
      var l = byLabel[ci[0] + "/" + ci[1]];
      var g = l ? c.object(l.id, l.name, "if-node") : svg("g", { "class": "if-node" });
      if (!l) c.body.appendChild(g);
      c.rect(p.x, p.y, nw, nh, "if-rect", { rx: 8, "data-unused": l ? null : "true", "data-conf": ci[0], "data-integ": ci[1] }, g);
      c.text(p.x + 12, p.y + 20, l ? l.name : tt("run.label_unused", "unused"), "if-name", { parent: g });
      c.text(p.x + nw - 12, p.y + 20, tt("run.conf_" + ci[0], ci[0]) + " · " + tt("run.integ_" + ci[1], ci[1]), "if-coords", { parent: g, anchor: "end" });
      if (l) {
        var members = [];
        ["threads", "endpoints", "notifications", "cnodes"].forEach(function (k) { (s[k] || []).forEach(function (o) { if (o.label === l.id) members.push(o); }); });
        members.slice(0, 4).forEach(function (o, i) {
          var mx = p.x + 12 + (i % 2) * 118, my = p.y + 34 + Math.floor(i / 2) * 24;
          c.rect(mx, my, 110, 20, "if-member", { rx: 10, "data-kind": E.byId(s.threads, o.id) ? "thread" : "object" }, g);
          c.text(mx + 55, my + 14, o.name, "if-member-text", { parent: g, anchor: "middle", max: 100 });
        });
        if (members.length > 4) c.text(p.x + nw - 12, p.y + nh - 8, "+" + (members.length - 4), "if-coords", { parent: g, anchor: "end" });
      }
      nodes[ci[0] + "/" + ci[1]] = p;
    });
    // The lattice's own order: low → high, trusted → untrusted.
    [["low/trusted", "high/trusted"], ["low/untrusted", "high/untrusted"], ["low/trusted", "low/untrusted"], ["high/trusted", "high/untrusted"]].forEach(function (e) {
      var a = nodes[e[0]], b = nodes[e[1]];
      if (a.y === b.y) c.arrow(a.x + nw + 4, a.y + nh / 2, b.x - 6, b.y + nh / 2, "if-order", "arrow-muted");
      else c.arrow(a.x + nw / 2, a.y + nh + 4, b.x + nw / 2, b.y - 6, "if-order", "arrow-muted");
    });
    function center(labelId) {
      var l = E.byId(s.labels, labelId);
      if (!l) return null;
      var p = nodes[l.conf + "/" + l.integ];
      return { x: p.x + nw / 2, y: p.y + nh / 2 };
    }
    /* Where the segment from a box's centre towards `to` leaves the box, so a
       flow is drawn edge to edge and never across the members inside. */
    function edge(from, to) {
      var dx = to.x - from.x, dy = to.y - from.y;
      var t = Math.min(dx ? (nw / 2 + 4) / Math.abs(dx) : Infinity, dy ? (nh / 2 + 4) / Math.abs(dy) : Infinity);
      return { x: from.x + dx * t, y: from.y + dy * t };
    }
    (s.declassify || []).forEach(function (d) {
      var a = center(d.from), b = center(d.to);
      if (!a || !b) return;
      var low = Math.max(a.y, b.y) + nh / 2;
      c.path("M" + (a.x - 30) + "," + (a.y + nh / 2 + 4) + " Q" + ((a.x + b.x) / 2) + "," + (low + 70) + " " + (b.x - 30) + "," + (b.y + nh / 2 + 6), "if-declass", "arrow-cdt", c.over);
      c.text((a.x + b.x) / 2, low + 46, tt("run.declass_policy", "declassification policy"), "if-declass-label", { anchor: "middle", parent: c.over });
    });
    // This step's flow checks, recomputed from the labels.
    var pre = preState();
    stepOps(step).forEach(function (op) {
      if (op.op !== "flowCheck") return;
      var src = E.labelOf(pre, op.from), dst = E.labelOf(pre, op.to);
      if (!src || !dst) return;
      var ok = E.flowsTo(src, dst);
      var a = center(src.id), b = center(dst.id);
      var label = nameOf(pre, op.from) + " → " + nameOf(pre, op.to) + (ok ? " ✓" : " ✕");
      if (src.id === dst.id) {
        c.text(a.x, a.y + nh / 2 - 8, label + " · " + tt("run.same_label", "same label"), "if-check if-check-ok", { anchor: "middle", parent: c.over });
        return;
      }
      // Shifted off the lattice's own order arrows, which join the centres.
      var p1 = edge(a, b), p2 = edge(b, a);
      var len = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)) || 1;
      var nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      if (ny < 0 || (ny === 0 && nx < 0)) { nx = -nx; ny = -ny; }
      p1 = { x: p1.x + nx * 22, y: p1.y + ny * 22 }; p2 = { x: p2.x + nx * 22, y: p2.y + ny * 22 };
      c.path("M" + p1.x + "," + p1.y + " L" + p2.x + "," + p2.y, ok ? "if-flow if-flow-allow" : "if-flow if-flow-block", ok ? "arrow-ok" : "arrow-bad", c.over);
      c.text((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 8, label, ok ? "if-check if-check-ok" : "if-check if-check-bad", { anchor: "middle", parent: c.over });
    });
    var y = y0 + 2 * nh + gy + ((s.declassify || []).length ? 70 : 30);
    y = sectionLabel(c, y, tt("run.audit_log", "Declassification audit log"));
    if (!(s.audit || []).length) { c.text(MARGIN, y + 14, tt("run.audit_empty", "— no declassifications —"), "box-empty"); y += 24; }
    (s.audit || []).forEach(function (e, i) {
      var g = svg("g", { "class": "audit-row" });
      c.body.appendChild(g);
      c.rect(MARGIN, y, SCENE_W - MARGIN, 24, "audit-rect", { rx: 4, "data-touched": (touchedNow().audit && i === s.audit.length - 1) ? "true" : null }, g);
      c.text(MARGIN + 10, y + 16, tt("run.audit_entry", "{{n}}. {{actor}} downgraded {{from}} → {{to}} (target {{target}}, core {{core}})", { n: i + 1, actor: nameOf(s, e.actor), from: nameOf(s, e.from), to: nameOf(s, e.to), target: nameOf(s, e.target), core: e.core }), "audit-text", { parent: g, max: SCENE_W - 40 });
      y += 30;
    });
    c.extend(x0 + 2 * nw + gx + 20, y);
  }

  /* ════════════════════════════════════════════════════════════
     Stage
     ════════════════════════════════════════════════════════════ */

  function availableScenes(sc) {
    var s = (sc && sc.initialState) || {};
    var hasSyscall = ((sc && sc.steps) || []).some(function (st) { return st.kind === "syscall" || dispatchOp(st); });
    var out = [];
    if (hasSyscall) out.push("path");
    if ((s.endpoints || []).length || (s.notifications || []).length) out.push("ipc");
    out.push("scheduler");
    if ((s.cnodes || []).length) out.push("cspace");
    if ((s.untyped || []).length || (s.vspaces || []).length) out.push("memory");
    if ((s.labels || []).length >= 2) out.push("infoflow");
    return out;
  }
  function sceneLabel(id) {
    switch (id) {
      case "path": return tt("run.scene_path", "Kernel path");
      case "ipc": return tt("run.scene_ipc", "IPC");
      case "scheduler": return tt("run.scene_scheduler", "Scheduler");
      case "cspace": return tt("run.scene_cspace", "CSpace");
      case "memory": return tt("run.scene_memory", "Memory");
      case "infoflow": return tt("run.scene_infoflow", "Information flow");
      default: return id;
    }
  }
  function sceneAria(id) {
    switch (id) {
      case "path": return tt("run.path_aria", "The step's registers, its capability lookup and every gate on the checked syscall path");
      case "ipc": return tt("run.ipc_aria", "Threads, endpoint and notification queues, reply objects and the messages delivered");
      case "scheduler": return tt("run.scheduler_aria", "Each core's running thread, its priority buckets and the scheduling contexts");
      case "cspace": return tt("run.cspace_aria", "CNode slots, the capabilities in them and the derivation tree");
      case "memory": return tt("run.memory_aria", "Untyped memory regions and address-space mappings with W^X and TLB state");
      case "infoflow": return tt("run.infoflow_aria", "The security-label lattice, this step's flow checks and the declassification audit log");
      default: return "";
    }
  }

  function renderSceneTabs() {
    if (!DOM.theaterScenes) return;
    clear(DOM.theaterScenes);
    availableScenes(app.scenario).forEach(function (id) {
      var active = id === app.scene;
      DOM.theaterScenes.appendChild(el("button", {
        "class": "scene-tab", type: "button", role: "tab",
        "aria-selected": active ? "true" : "false", tabindex: active ? "0" : "-1",
        dataset: { scene: id, active: active ? "true" : "false" },
        text: sceneLabel(id),
        onclick: function () { setScene(id); }
      }));
    });
  }
  function setScene(id) {
    if (availableScenes(app.scenario).indexOf(id) === -1) return;
    app.scene = id;
    renderStage();
    syncUrl();
  }

  var LEGENDS = {
    path: [["pass", "run.legend_pass", "Stage passed"], ["fail", "run.legend_fail", "Stage refused"], ["skip", "run.legend_skip", "Not reached"], ["guard", "run.legend_guard", "Guard bits"], ["radix", "run.legend_radix", "Slot (radix) bits"]],
    ipc: [["running", "run.legend_running", "Running"], ["ready", "run.legend_ready", "Ready"], ["blocked", "run.legend_blocked", "Blocked"], ["message", "run.legend_message", "Message delivered"], ["touched", "run.legend_touched", "Changed by this step"]],
    scheduler: [["running", "run.legend_running", "Running"], ["ready", "run.legend_ready", "Ready"], ["chosen", "run.legend_chosen", "Next pick"], ["dim", "run.legend_ineligible", "Ineligible"], ["touched", "run.legend_touched", "Changed by this step"]],
    cspace: [["cap", "run.legend_cap", "Capability"], ["cdt", "run.legend_cdt", "Derived from (parent → child)"], ["gone", "run.legend_deleted", "Deleted by this step"], ["touched", "run.legend_touched", "Changed by this step"]],
    memory: [["frame", "run.legend_frame", "Frame"], ["untyped", "run.legend_untyped", "Untyped"], ["free", "run.legend_free", "Free (above the watermark)"], ["bad", "run.legend_refused", "Refused"]],
    infoflow: [["order", "run.legend_order", "Lattice order"], ["ok", "run.legend_flow_ok", "Flow allowed"], ["bad", "run.legend_flow_bad", "Flow denied"], ["declass", "run.legend_declass", "Declassification policy"]]
  };
  function renderLegend() {
    if (!DOM.theaterLegend) return;
    clear(DOM.theaterLegend);
    (LEGENDS[app.scene] || []).forEach(function (row) {
      DOM.theaterLegend.appendChild(el("li", {}, [el("i", { dataset: { swatch: row[0] } }), " ", el("span", { text: tt(row[1], row[2]) })]));
    });
  }

  function renderStage() {
    if (!DOM.theaterStage) return;
    clear(DOM.theaterStage);
    renderSceneTabs();
    renderLegend();
    var step = currentStep();
    var c = new Canvas(sceneAria(app.scene));
    c.root.setAttribute("data-scene", app.scene);
    switch (app.scene) {
      case "path": renderPathScene(c, step); break;
      case "ipc": renderIpcScene(c, step); break;
      case "cspace": renderCSpaceScene(c, step); break;
      case "memory": renderMemoryScene(c, step); break;
      case "infoflow": renderInfoflowScene(c, step); break;
      default: renderSchedulerScene(c, step);
    }
    DOM.theaterStage.appendChild(c.finish());
    for (var i = 0; i < c.fits.length; i++) fitText(c.fits[i][0], c.fits[i][1], c.fits[i][2]);
  }

  /* ════════════════════════════════════════════════════════════
     Guarantees band + invariant catalogue
     ════════════════════════════════════════════════════════════ */

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

  function propertyById(id) { return E.byId(app.data && app.data.propertyCatalog, id); }
  function invariantById(id) { return E.byId(app.data && app.data.invariantCatalog, id); }
  function stepGuarantees(step) { return (step && Array.isArray(step.guarantees)) ? step.guarantees : []; }
  function stepPreserved(step) { return (step && step.invariants && Array.isArray(step.invariants.preserved)) ? step.invariants.preserved : []; }

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

  /* The scenario's properties first, in its order, then the rest of the
     catalogue: the cards keep their places as the step moves. */
  function orderedProperties() {
    var catalog = (app.data && app.data.propertyCatalog) || [];
    var own = (app.scenario && app.scenario.properties) || [];
    var first = own.map(propertyById).filter(Boolean);
    return first.concat(catalog.filter(function (p) { return own.indexOf(p.id) === -1; }));
  }

  function renderGuarantees() {
    if (!DOM.guaranteeGrid) return;
    clear(DOM.guaranteeGrid);
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
      if (prop.caveat) card.appendChild(el("p", { "class": "prop-caveat" }, [el("strong", { text: tt("run.caveat", "Scope") + ": " }), prop.caveat]));
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
      DOM.guaranteeGrid.appendChild(card);
    });

    if (DOM.guaranteeSummary) {
      var tone = "good", text;
      if (isRefused(step)) {
        var stage = refusingStage(step);
        text = tt("run.summary_refused", "Refused with {{error}}{{at}}: the kernel returned no successor state, so nothing changed.", {
          error: step.outcome.error || "",
          at: stage ? " " + tt("run.summary_at", "at the {{stage}} stage", { stage: stageName(stage.stage) }) : ""
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
    if (!DOM.invariantList) return;
    clear(DOM.invariantList);
    var catalog = (app.data && app.data.invariantCatalog) || [];
    var step = currentStep();
    var preserved = stepPreserved(step);
    // In the sandbox the executable mirrors judge the perturbed state.
    var violations = {};
    if (app.sandbox) E.checkState(viewState()).forEach(function (v) { (violations[v.id] = violations[v.id] || []).push(v.message); });
    var anyViolation = Object.keys(violations).length > 0;

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
        var status = violations[inv.id] ? "violated" : (!app.sandbox && preserved.indexOf(inv.id) !== -1) ? "preserved" : "holds";
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
          status === "violated" ? el("p", { "class": "inv-why", text: violations[inv.id].join(" · ") }) : null,
          rows
        ]));
      });
      DOM.invariantList.appendChild(el("section", { "class": "inv-group" }, [
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
          ? tt("run.rail_violated", "Sandbox: a structural check is violated — exactly what the Lean proofs forbid.")
          : tt("run.rail_sandbox_ok", "Sandbox: client-side structural checks pass (unverified).");
        tone = anyViolation ? "bad" : "warn";
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

  function humanizeOp(s, op) {
    var n = function (id) { return nameOf(s, id); };
    switch (op.op) {
      case "dispatch": return op.thread ? tt("run.op_dispatch", "Core {{core}} runs {{who}}", { core: op.core, who: n(op.thread) }) : tt("run.op_idle", "Core {{core}} idles", { core: op.core });
      case "deschedule": return tt("run.op_deschedule", "{{who}} leaves core {{core}}", { who: n(op.thread), core: op.core });
      case "enqueue": return tt("run.op_enqueue", "{{who}} joins the tail of core {{core}}'s priority-{{p}} bucket", { who: n(op.thread), core: op.core, p: op.prio });
      case "threadPatch": {
        var bits = [];
        for (var k in op.set) if (Object.prototype.hasOwnProperty.call(op.set, k)) bits.push(k + " = " + fmtValue(s, k === "ipc" && op.set[k] ? op.set[k].state : op.set[k]));
        return n(op.id) + ": " + bits.join(", ");
      }
      case "message": return tt("run.op_message", "{{from}} → {{to}}: {{words}}", { from: n(op.from), to: n(op.to), words: "[" + (op.words || []).join(", ") + "]" + (op.badge !== undefined && op.badge !== null ? " · " + tt("run.badge_short", "badge {{b}}", { b: op.badge }) : "") });
      case "epEnqueue": return tt("run.op_ep_enqueue", "{{who}} joins {{ep}}'s {{q}}", { who: n(op.thread), ep: n(op.endpoint), q: queueName(op.queue) });
      case "epPopHead": return tt("run.op_ep_pop", "{{who}} leaves the head of {{ep}}'s {{q}}", { who: n(op.thread), ep: n(op.endpoint), q: queueName(op.queue) });
      case "ntfnEnqueue": return tt("run.op_ntfn_enqueue", "{{who}} waits on {{n}}", { who: n(op.thread), n: n(op.notification) });
      case "ntfnPopHead": return tt("run.op_ntfn_pop", "{{who}} is woken by {{n}}", { who: n(op.thread), n: n(op.notification) });
      case "ntfnPatch": case "replyPatch": case "scPatch": {
        var parts = [];
        for (var f in op.set) if (Object.prototype.hasOwnProperty.call(op.set, f)) parts.push(f + " = " + fmtValue(s, op.set[f]));
        return n(op.id) + ": " + parts.join(", ");
      }
      case "capInsert": return tt("run.op_cap_insert", "{{slot}} ← {{kind}} → {{target}} [{{rights}}]{{parent}}", { slot: n(op.slot), kind: op.cap.kind, target: n(op.cap.target), rights: rightsText(op.cap.rights), parent: op.parent ? " · " + tt("run.child_of", "child of {{p}}", { p: n(op.parent) }) : "" });
      case "capDelete": return tt("run.op_cap_delete", "Delete {{slot}}; its children move up to its parent", { slot: n(op.slot) });
      case "capRevoke": return tt("run.op_cap_revoke", "Revoke everything derived from {{slot}} (the slot stays)", { slot: n(op.slot) });
      case "untypedCarve": return tt("run.op_carve", "Carve {{kind}} {{id}} ({{size}}) from {{ut}}", { kind: op.child.kind, id: op.child.id, size: bytes(op.child.size), ut: n(op.untyped) });
      case "untypedReset": return tt("run.op_reset", "Reset {{ut}}: watermark to 0", { ut: n(op.untyped) });
      case "vspaceMap": return tt("run.op_map", "Map {{va}} → {{frame}} [{{perms}}]", { va: op.mapping.vaddr, frame: n(op.mapping.frame), perms: op.mapping.perms });
      case "vspaceUnmap": return tt("run.op_unmap", "Unmap {{va}} and shoot down its TLB entry", { va: op.vaddr });
      case "vspaceReject": return tt("run.op_reject", "Mapping {{va}} [{{perms}}] refused: writable and executable", { va: op.vaddr, perms: op.perms });
      case "auditAppend": return tt("run.op_audit", "Audit log: {{actor}} downgrades {{from}} → {{to}}", { actor: n(op.entry.actor), from: n(op.entry.from), to: n(op.entry.to) });
      case "flowCheck": return tt(op.allowed ? "run.op_flow_ok" : "run.op_flow_bad", op.allowed ? "Flow check {{from}} → {{to}}: allowed" : "Flow check {{from}} → {{to}}: denied", { from: n(op.from), to: n(op.to) });
      case "note": return op.text || "";
      default: return op.op;
    }
  }
  function fmtValue(s, v) {
    if (v === null || v === undefined) return "—";
    if (Array.isArray(v)) return "[" + v.map(function (x) { return typeof x === "string" ? nameOf(s, x) : fmtValue(s, x); }).join(", ") + "]";
    if (typeof v === "object") {
      if (v.state) return v.state + (v.object ? " · " + nameOf(s, v.object) : "");
      var bits = [];
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k) && v[k] !== null && !(Array.isArray(v[k]) && !v[k].length)) bits.push(k + ": " + fmtValue(s, v[k]));
      return "{" + bits.join(", ") + "}";
    }
    if (typeof v === "string") return findAny(s, v) ? nameOf(s, v) : v;
    return String(v);
  }

  /* Field-level before → after for every object this step changed. */
  function computeDiffRows() {
    if (app.sandbox && app.sandboxState) return [];
    if (app.stepIndex <= 0) return [];
    var prev = preState(), next = traceState();
    var rows = [];
    function cmp(label, a, b) {
      var keys = {};
      Object.keys(a || {}).concat(Object.keys(b || {})).forEach(function (k) { keys[k] = true; });
      Object.keys(keys).forEach(function (k) {
        if (k === "id" || k === "name" || k === "slots") return;
        if (JSON.stringify(a ? a[k] : undefined) !== JSON.stringify(b ? b[k] : undefined)) rows.push([label, k, fmtValue(next, a ? a[k] : null) + " → " + fmtValue(next, b ? b[k] : null)]);
      });
    }
    COLLECTIONS.forEach(function (col) {
      (next[col] || []).forEach(function (b) { cmp(b.name || b.id, E.byId(prev[col], b.id), b); });
    });
    (next.cores || []).forEach(function (c) {
      var a = E.byId(prev.cores, c.id);
      if (a && a.current !== c.current) rows.push([tt("run.core", "Core {{n}}", { n: c.id }), tt("run.running", "running"), nameOf(next, a.current) + " → " + nameOf(next, c.current)]);
      var qa = ((prev.runQueues || {})[String(c.id)] || []).map(function (e) { return e.thread; });
      var qb = ((next.runQueues || {})[String(c.id)] || []).map(function (e) { return e.thread; });
      if (JSON.stringify(qa) !== JSON.stringify(qb)) rows.push([tt("run.core", "Core {{n}}", { n: c.id }), tt("run.run_queue_short", "run queue"), fmtValue(next, qa) + " → " + fmtValue(next, qb)]);
    });
    (next.cnodes || []).forEach(function (cn) {
      var a = E.byId(prev.cnodes, cn.id);
      var keys = {};
      Object.keys((a && a.slots) || {}).concat(Object.keys(cn.slots || {})).forEach(function (k) { keys[k] = true; });
      Object.keys(keys).forEach(function (k) {
        var ca = a && a.slots && a.slots[k], cb = cn.slots && cn.slots[k];
        if (JSON.stringify(ca) !== JSON.stringify(cb)) rows.push([cn.name + " [" + k + "]", tt("run.capability", "capability"), (ca ? ca.kind + " " + rightsText(ca.rights) : "—") + " → " + (cb ? cb.kind + " " + rightsText(cb.rights) : "—")]);
      });
    });
    if (JSON.stringify(prev.cdt || {}) !== JSON.stringify(next.cdt || {})) {
      Object.keys(next.cdt || {}).concat(Object.keys(prev.cdt || {})).filter(function (k, i, arr) { return arr.indexOf(k) === i; }).forEach(function (k) {
        var a = (prev.cdt || {})[k] || [], b = (next.cdt || {})[k] || [];
        if (JSON.stringify(a) !== JSON.stringify(b)) rows.push([nameOf(next, k), tt("run.children", "children"), fmtValue(next, a) + " → " + fmtValue(next, b)]);
      });
    }
    if ((prev.audit || []).length !== (next.audit || []).length) rows.push([tt("run.audit_log", "Declassification audit log"), tt("run.entries", "entries"), (prev.audit || []).length + " → " + (next.audit || []).length]);
    return rows;
  }

  function renderInspector() {
    if (!DOM.theaterInspector) return;
    clear(DOM.theaterInspector);
    var step = currentStep();
    if (!step) return;
    var refused = isRefused(step);
    var s = preState();

    DOM.theaterInspector.appendChild(el("div", { "class": "insp-head" }, [
      el("span", { "class": "insp-kind", dataset: { kind: step.kind }, text: kindLabel(step.kind) }),
      el("code", { "class": "insp-tag", text: step.traceTag }),
      el("span", { "class": "insp-outcome", dataset: { outcome: refused ? "error" : "ok" }, text: refused
        ? tt("run.outcome_refused", "refused · {{error}}", { error: step.outcome.error || "" })
        : tt("run.outcome_ok", "completed") }),
      step.actor ? el("span", { "class": "insp-actor", text: tt("run.actor", "actor") + ": " + nameOf(s, step.actor) }) : null,
      typeof step.core === "number" && (traceState().cores || []).length > 1 ? el("span", { "class": "insp-actor", text: tt("run.core", "Core {{n}}", { n: step.core }) }) : null
    ]));
    DOM.theaterInspector.appendChild(el("h3", { "class": "insp-title", text: step.title }));
    if (step.narrative) DOM.theaterInspector.appendChild(el("p", { "class": "insp-narrative", text: step.narrative }));

    if (step.path && step.path.length) {
      var section = el("div", { "class": "insp-section" }, [el("h4", { text: tt("run.kernel_path", "Kernel path") })]);
      if (step.syscall) {
        var sc = step.syscall;
        section.appendChild(el("p", { "class": "insp-syscall" }, [
          el("code", { "class": "insp-syscall-id", text: sc.id }),
          el("span", { text: "x7 = " + sc.number }),
          sc.requiredRight ? el("span", { "class": "insp-right" }, [tt("run.requires", "requires") + " ", el("code", { text: sc.requiredRight })]) : null
        ]));
      }
      var strip = el("ol", { "class": "path-strip" });
      step.path.forEach(function (stage) {
        var result = stage.result || "pass";
        strip.appendChild(el("li", { "class": "path-stage", dataset: { result: result, stage: stage.stage } }, [
          el("span", { "class": "path-mark", "aria-hidden": "true", text: result === "fail" ? "✕" : result === "skip" ? "–" : "✓" }),
          el("span", { "class": "path-body" }, [
            el("span", { "class": "path-label" }, [el("span", { "class": "path-stage-name", text: stageName(stage.stage) }), stage.label]),
            stage.ref ? refLink(stage.ref, "ref-link path-ref") : null,
            result === "fail" && stage.error ? el("span", { "class": "path-error" }, [tt("run.returns", "returns") + " ", el("code", { text: "." + stage.error })]) : null,
            result === "skip" ? el("span", { "class": "path-skip", text: tt("run.not_reached", "not reached") }) : null
          ])
        ]));
      });
      section.appendChild(strip);
      DOM.theaterInspector.appendChild(section);
    }

    var guarantees = stepGuarantees(step);
    var preserved = stepPreserved(step);
    if (guarantees.length || preserved.length || refused) {
      var why = el("div", { "class": "insp-section insp-why" }, [el("h4", { text: tt("run.why_safe", "Why it's safe") })]);
      if (refused) why.appendChild(el("p", { "class": "insp-atomic", text: tt("run.atomic_note", "A kernel transition has type σ → Except ε (α × σ): an error carries no state, so a refused call cannot leave a partial change behind.") }));
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
      DOM.theaterInspector.appendChild(why);
    }

    var diffRows = computeDiffRows();
    var ops = stepOps(step);
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
      } else if (step.kind !== "boot") {
        what.appendChild(el("p", { "class": "insp-nochange", text: tt("run.no_change", "None: the kernel state after this step equals the state before it.") }));
      }
      if (ops.length) {
        var ul = el("ul", { "class": "insp-effects" });
        ops.forEach(function (op) { ul.appendChild(el("li", { dataset: { op: op.op, event: E.EVENT_OPS.indexOf(op.op) !== -1 ? "true" : "false" }, text: humanizeOp(s, op) })); });
        what.appendChild(el("p", { "class": "insp-subhead", text: tt("run.effects", "Effects, in order") }));
        what.appendChild(ul);
      }
      DOM.theaterInspector.appendChild(what);
    }

    if (step.sourceRefs && step.sourceRefs.length) {
      var refs = el("ul", { "class": "insp-refs" });
      step.sourceRefs.forEach(function (ref) {
        var map = mapHref(ref.module);
        refs.appendChild(el("li", {}, [
          refLink(ref),
          map ? el("a", { "class": "insp-ref-mod", href: map, title: tt("run.open_in_map", "Open in the code map"), text: ref.module }) : el("span", { "class": "insp-ref-mod", text: ref.module })
        ]));
      });
      DOM.theaterInspector.appendChild(el("div", { "class": "insp-section" }, [el("h4", { text: tt("run.source", "Source") }), refs]));
    }

    if (app.selected) renderSelectedObject();
  }

  function renderSelectedObject() {
    var s = viewState();
    var id = app.selected;
    var fields = [];
    var title;
    var cap = E.parseSlot(id) && E.capAt(s, id);
    if (cap) {
      title = tt("run.capability", "capability") + " · " + nameOf(s, id);
      fields.push(["kind", cap.kind], ["target", nameOf(s, cap.target)], ["rights", (cap.rights || []).join(", ") || "—"]);
      if (cap.badge !== undefined && cap.badge !== null) fields.push(["badge", cap.badge]);
      if (cap.derivation) fields.push(["derivation", cap.derivation]);
      var parent = E.cdtParent(s, id);
      fields.push([tt("run.derived_from", "derived from"), parent ? nameOf(s, parent) : "—"]);
      fields.push([tt("run.children", "children"), E.cdtChildren(s, id).map(function (k) { return nameOf(s, k); }).join(", ") || "—"]);
      fields.push([tt("run.descendants", "descendants"), E.cdtDescendants(s, id).length]);
    } else {
      var hit = findAny(s, id);
      if (!hit) return;
      title = hit.obj.name || hit.obj.id;
      var o = hit.obj;
      for (var k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k) || k === "name" || k === "slots") continue;
        fields.push([k, fmtValue(s, o[k])]);
      }
      if (hit.kind === "threads") {
        fields.push([tt("run.status", "status"), statusLabel(threadStatus(s, o))]);
        var lbl = E.labelOf(s, o.id);
        if (lbl) fields.push([tt("run.security_label", "security label"), lbl.name + " (" + lbl.conf + ", " + lbl.integ + ")"]);
      }
      if (hit.kind === "cnodes") fields.push([tt("run.occupied", "occupied slots"), Object.keys(o.slots || {}).length + " / " + E.slotCount(o)]);
    }
    var dl = el("dl", { "class": "insp-grid" });
    fields.forEach(function (r) { dl.appendChild(el("dt", { text: r[0] })); dl.appendChild(el("dd", {}, [el("code", { text: String(r[1]) })])); });
    DOM.theaterInspector.appendChild(el("div", { "class": "insp-section insp-object" }, [
      el("h4", {}, [el("span", { text: tt("run.selected", "Selected") + ": " }), el("strong", { text: title })]),
      dl,
      el("button", { "class": "btn btn-secondary insp-clear", type: "button", text: tt("run.clear_selection", "Clear selection"), onclick: function () { selectObject(""); } })
    ]));
  }

  /* ════════════════════════════════════════════════════════════
     Step list
     ════════════════════════════════════════════════════════════ */

  function renderLog() {
    if (!DOM.theaterLog) return;
    clear(DOM.theaterLog);
    if (!app.scenario) return;
    app.scenario.steps.forEach(function (step, i) {
      var active = i === app.stepIndex;
      var line = el("button", {
        "class": "log-line", type: "button",
        dataset: { kind: step.kind, active: active ? "true" : "false", outcome: isRefused(step) ? "error" : "ok" },
        onclick: function () { stopPlay(); setStep(i); }
      }, [
        el("code", { "class": "log-tag", text: step.traceTag }),
        el("span", { "class": "log-kind", text: kindLabel(step.kind) }),
        el("span", { "class": "log-title", text: step.title }),
        isRefused(step) ? el("code", { "class": "log-error", text: step.outcome.error || "" }) : null
      ]);
      if (active) line.setAttribute("aria-current", "step");
      DOM.theaterLog.appendChild(line);
    });
    var activeLine = DOM.theaterLog.querySelector('[data-active="true"]');
    if (activeLine) keepLineWithin(DOM.theaterLog, activeLine);
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
    renderSandboxActions();
    updateTransport();
  }

  function updateTransport() {
    var step = currentStep();
    var total = app.scenario ? app.scenario.steps.length : 0;
    if (DOM.theaterScrubber) { DOM.theaterScrubber.max = String(Math.max(0, total - 1)); DOM.theaterScrubber.value = String(app.stepIndex); }
    if (DOM.theaterStepLabel) DOM.theaterStepLabel.textContent = (app.stepIndex + 1) + " / " + total;
    if (DOM.theaterCaption && step) DOM.theaterCaption.textContent = (app.stepIndex + 1) + ". " + step.title;
    if (DOM.theaterPrev) DOM.theaterPrev.disabled = app.stepIndex <= 0;
    if (DOM.theaterNext) DOM.theaterNext.disabled = app.stepIndex >= total - 1;
    if (DOM.theaterPlay) {
      DOM.theaterPlay.setAttribute("aria-pressed", app.playing ? "true" : "false");
      DOM.theaterPlay.dataset.playing = app.playing ? "true" : "false";
      DOM.theaterPlay.setAttribute("aria-label", app.playing ? tt("run.pause", "Pause") : tt("run.play", "Play"));
    }
  }

  function setStep(i) {
    if (!app.scenario) return;
    var total = app.scenario.steps.length;
    app.stepIndex = Math.max(0, Math.min(total - 1, i));
    app.sandboxState = null; // stepping returns the sandbox to the trace
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
    app.selected = (app.selected === id) ? "" : id;
    render();
    syncUrl();
  }

  function loadScenario(id, initial) {
    var scenarios = (app.data && app.data.scenarios) || [];
    var sc = E.byId(scenarios, id) || scenarios[0];
    if (!sc) return;
    stopPlay();
    app.scenario = sc;
    app.scenarioId = sc.id;
    app.states = E.scenarioStates(sc);
    var scenes = availableScenes(sc);
    var want = initial && app.urlScene ? app.urlScene : (sc.focus || scenes[0]);
    app.scene = scenes.indexOf(want) !== -1 ? want : scenes[0];
    if (!initial) app.stepIndex = 0;
    app.stepIndex = Math.max(0, Math.min(sc.steps.length - 1, app.stepIndex));
    // A deep-linked selection survives the first load only.
    app.selected = initial ? app.urlObject : "";
    app.urlScene = "";
    app.urlObject = "";
    app.sandboxState = null;
    if (DOM.scenarioSelect) DOM.scenarioSelect.value = sc.id;
    renderScenarioMeta();
    render();
  }

  function renderScenarioMeta() {
    var sc = app.scenario;
    if (DOM.scenarioSummary) DOM.scenarioSummary.textContent = (sc && sc.summary) || "";
    if (!DOM.scenarioProperties) return;
    clear(DOM.scenarioProperties);
    ((sc && sc.properties) || []).forEach(function (id) {
      var prop = propertyById(id);
      if (!prop) return;
      DOM.scenarioProperties.appendChild(el("li", {}, [el("a", { href: "#property-" + id, "class": "scenario-prop", text: prop.label })]));
    });
  }

  /* ════════════════════════════════════════════════════════════
     Sandbox: perturb a copy, let the executable mirrors judge it
     ════════════════════════════════════════════════════════════ */

  /* Each perturbation breaks one invariant the catalogue names, on a copy of
     the state. `applies` decides whether the button is offered. */
  var PERTURB = {
    "enqueue-current": {
      applies: function (s) { return (s.cores || []).some(function (c) { return c.current; }); },
      run: function (s) { var c = (s.cores || []).filter(function (k) { return k.current; })[0]; var th = E.byId(s.threads, c.current); s.runQueues[String(c.id)] = (s.runQueues[String(c.id)] || []).concat([{ thread: th.id, prio: th.priority }]); }
    },
    "dup-runqueue": {
      applies: function (s) { return Object.keys(s.runQueues || {}).some(function (k) { return (s.runQueues[k] || []).length; }); },
      run: function (s) { var k = Object.keys(s.runQueues).filter(function (q) { return s.runQueues[q].length; })[0]; s.runQueues[k].push(E.clone(s.runQueues[k][0])); }
    },
    "wake-blocked": {
      applies: function (s) { return (s.threads || []).some(function (th) { return th.ipc && th.ipc.state !== "ready" && th.ipc.state !== "inactive"; }); },
      run: function (s) { var th = (s.threads || []).filter(function (x) { return x.ipc && x.ipc.state !== "ready" && x.ipc.state !== "inactive"; })[0]; var k = String(th.core || 0); s.runQueues[k] = (s.runQueues[k] || []).concat([{ thread: th.id, prio: th.priority }]); }
    },
    "orphan-cdt": {
      applies: function (s) { return (s.cnodes || []).some(function (cn) { return Object.keys(cn.slots || {}).length && Object.keys(cn.slots || {}).length < E.slotCount(cn); }); },
      run: function (s) {
        var cn = (s.cnodes || []).filter(function (x) { return Object.keys(x.slots || {}).length; })[0];
        var occupied = E.slotKey(cn.id, Number(Object.keys(cn.slots)[0]));
        for (var i = E.slotCount(cn) - 1; i >= 0; i--) if (!cn.slots[String(i)]) { s.cdt = s.cdt || {}; s.cdt[occupied] = (s.cdt[occupied] || []).concat([E.slotKey(cn.id, i)]); return; }
      }
    },
    "map-wx": {
      applies: function (s) { return (s.vspaces || []).length > 0; },
      run: function (s) { s.vspaces[0].mappings = (s.vspaces[0].mappings || []).concat([{ vaddr: "0x0bad000", frame: "fr.sandbox", perms: "rwx" }]); }
    },
    "stale-tlb": {
      applies: function (s) { return (s.vspaces || []).length > 0; },
      run: function (s) { s.vspaces[0].tlb = (s.vspaces[0].tlb || []).concat(["0x0dead00"]); }
    },
    "overspend": {
      applies: function (s) { return (s.schedContexts || []).length > 0; },
      run: function (s) { s.schedContexts[0].remaining = s.schedContexts[0].budget + 2; }
    },
    "overlap": {
      applies: function (s) { return (s.untyped || []).some(function (u) { return (u.children || []).length; }); },
      run: function (s) { var u = (s.untyped || []).filter(function (x) { return (x.children || []).length; })[0]; var ch = u.children[u.children.length - 1]; u.children.unshift({ id: "sandbox.overlap", kind: "frame", offset: ch.offset, size: ch.size }); }
    }
  };

  function renderSandboxActions() {
    if (!DOM.sandboxPanel || !DOM.sandboxPanel.querySelectorAll) return;
    var s = traceState();
    var buttons = DOM.sandboxPanel.querySelectorAll("[data-perturb]");
    for (var i = 0; i < buttons.length; i++) {
      var p = PERTURB[buttons[i].getAttribute("data-perturb")];
      buttons[i].hidden = !(p && s && p.applies(s));
    }
  }

  function setSandbox(on) {
    app.sandbox = on;
    app.sandboxState = null;
    if (DOM.sandboxPanel) DOM.sandboxPanel.hidden = !on;
    if (DOM.sandboxToggle) { DOM.sandboxToggle.setAttribute("aria-pressed", on ? "true" : "false"); DOM.sandboxToggle.dataset.on = on ? "true" : "false"; }
    // The sandbox's effect is a broken invariant, so show the list it breaks.
    if (on && DOM.invariantDetails) DOM.invariantDetails.open = true;
    render();
    syncUrl();
  }

  function perturb(kind) {
    var p = PERTURB[kind];
    if (!app.sandbox || !p) return;
    var state = E.clone(viewState());
    if (!p.applies(state)) return;
    p.run(state);
    app.sandboxState = state;
    render();
  }

  /* ════════════════════════════════════════════════════════════
     URL state
     ════════════════════════════════════════════════════════════ */

  function parseQuery() {
    var out = Object.create(null);   // a "__proto__" parameter is just a key
    var raw = window.location.search || "";
    if (raw.charAt(0) === "?") raw = raw.slice(1);
    raw.split("&").forEach(function (entry) {
      if (!entry) return;
      var eq = entry.indexOf("=");
      var key = eq >= 0 ? entry.slice(0, eq) : entry;
      var val = eq >= 0 ? entry.slice(eq + 1) : "";
      try { key = decodeURIComponent(key.replace(/\+/g, " ")); } catch (e) { return; }
      try { val = decodeURIComponent(val.replace(/\+/g, " ")); } catch (e) { return; }
      if (key) out[key] = val;
    });
    return out;
  }

  function syncUrl() {
    var params = [];
    if (app.scenarioId) params.push("scenario=" + encodeURIComponent(app.scenarioId));
    params.push("step=" + app.stepIndex);
    if (app.scene) params.push("scene=" + encodeURIComponent(app.scene));
    if (app.selected) params.push("object=" + encodeURIComponent(app.selected));
    if (app.sandbox) params.push("sandbox=1");
    try { window.history.replaceState(null, "", "?" + params.join("&")); } catch (e) { /* file:// or sandboxed */ }
  }

  function applyUrlState() {
    var q = parseQuery();
    if (q.scenario && ID_RE.test(q.scenario)) app.scenarioId = q.scenario;
    if (/^\d{1,4}$/.test(q.step || "")) app.stepIndex = parseInt(q.step, 10);
    if (SCENES.indexOf(q.scene) !== -1) app.urlScene = q.scene;
    if (q.object && ID_RE.test(q.object)) app.urlObject = q.object;
    if (q.sandbox === "1") app.sandbox = true;
  }

  /* ════════════════════════════════════════════════════════════
     Data loading (bundle-only) and adoption gate
     ════════════════════════════════════════════════════════════ */

  function fetchBundle() {
    return fetch(DATA_ENDPOINT, FETCH_OPTIONS).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  /* The page draws nothing it cannot fold. A refused step that changes state
     would publish a failure atomicity the kernel does not have, so it refuses
     the whole document; the validator holds the bundle to far more. */
  function isValidTraceData(data) {
    if (!data || data.schemaVersion !== E.SCHEMA_VERSION || !Array.isArray(data.scenarios) || !data.scenarios.length) return false;
    if (!Array.isArray(data.propertyCatalog) || !Array.isArray(data.invariantCatalog)) return false;
    try {
      return data.scenarios.every(function (sc) {
        if (!sc || !ID_RE.test(String(sc.id)) || !sc.initialState || !Array.isArray(sc.steps) || !sc.steps.length) return false;
        var ok = sc.steps.every(function (step) {
          var ops = stepOps(step);
          if (!ops.every(function (op) { return E.OPS.indexOf(op && op.op) !== -1; })) return false;
          return !isRefused(step) || ops.every(function (op) { return E.EVENT_OPS.indexOf(op.op) !== -1; });
        });
        return ok && E.scenarioStates(sc).length === sc.steps.length;
      });
    } catch (e) {
      return false;
    }
  }

  function adoptData(data) {
    if (!isValidTraceData(data)) return false;
    app.data = data;
    buildScenarioOptions();
    updateSourceBadge();
    loadScenario(app.scenarioId || data.scenarios[0].id, true);
    setStatus("");
    return true;
  }

  function bootstrapData() {
    if (!E) { setStatus(tt("run.offline", "Could not load trace data."), true); return; }
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
    if (DOM.theaterSource) {
      DOM.theaterSource.dataset.source = app.data.source;
      DOM.theaterSource.textContent = isKernel
        ? tt("run.source_kernel", "kernel export · {{version}}", { version: version })
        : tt("run.source_fixture", "hand-written scenarios · names grounded in seLe4n {{version}}", { version: version });
    }
    if (DOM.theaterProvenance) {
      clear(DOM.theaterProvenance);
      var sha = String(app.data.sourceRef || "");
      if (SHA_RE.test(sha)) {
        DOM.theaterProvenance.appendChild(document.createTextNode(tt("run.grounded_at", "Every link opens the kernel at commit") + " "));
        DOM.theaterProvenance.appendChild(el("a", { href: "https://github.com/" + REPO + "/tree/" + sha, target: "_blank", rel: "noopener noreferrer" }, [el("code", { text: sha.slice(0, 7) })]));
        DOM.theaterProvenance.appendChild(document.createTextNode("."));
      }
    }
  }

  /* ════════════════════════════════════════════════════════════
     Event wiring + bootstrap
     ════════════════════════════════════════════════════════════ */

  function objectFromEvent(e) {
    var node = e.target && e.target.closest && e.target.closest("[data-object]");
    return node ? node.getAttribute("data-object") : "";
  }

  function wireControls() {
    if (DOM.theaterPlay) DOM.theaterPlay.addEventListener("click", togglePlay);
    if (DOM.theaterPrev) DOM.theaterPrev.addEventListener("click", function () { stopPlay(); setStep(app.stepIndex - 1); });
    if (DOM.theaterNext) DOM.theaterNext.addEventListener("click", function () { stopPlay(); setStep(app.stepIndex + 1); });
    if (DOM.theaterScrubber) DOM.theaterScrubber.addEventListener("input", function () { stopPlay(); setStep(parseInt(DOM.theaterScrubber.value, 10) || 0); });
    if (DOM.scenarioSelect) DOM.scenarioSelect.addEventListener("change", function () { loadScenario(DOM.scenarioSelect.value, false); syncUrl(); });
    if (DOM.sandboxToggle) DOM.sandboxToggle.addEventListener("click", function () { setSandbox(!app.sandbox); });
    // One delegated handler selects whatever object the scene drew.
    if (DOM.theaterStage) {
      DOM.theaterStage.addEventListener("click", function (e) { var id = objectFromEvent(e); if (id) selectObject(id); });
      DOM.theaterStage.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        var id = objectFromEvent(e);
        if (id) { e.preventDefault(); e.stopPropagation(); selectObject(id); }
      });
    }
    // The scene tabs are one tab stop; the arrow keys move between them.
    if (DOM.theaterScenes) {
      DOM.theaterScenes.addEventListener("keydown", function (e) {
        var scenes = availableScenes(app.scenario);
        var i = scenes.indexOf(app.scene);
        var next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? scenes.length - 1 : null;
        if (next === null || !scenes.length) return;
        e.preventDefault();
        e.stopPropagation();
        setScene(scenes[(next + scenes.length) % scenes.length]);
        var tab = DOM.theaterScenes.querySelector && DOM.theaterScenes.querySelector('[data-active="true"]');
        if (tab) tab.focus();
      });
    }
    // Following a link to an invariant opens the catalogue that holds it.
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href^="#invariant-"]');
      if (a && DOM.invariantDetails && !DOM.invariantDetails.open) DOM.invariantDetails.open = true;
    });
    if (DOM.sandboxPanel) {
      DOM.sandboxPanel.addEventListener("click", function (e) {
        var btn = e.target.closest && e.target.closest("[data-perturb]");
        if (btn) { perturb(btn.getAttribute("data-perturb")); return; }
        if (e.target.closest && e.target.closest("[data-sandbox-reset]")) { app.sandboxState = null; render(); }
      });
    }
    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target && e.target.closest && e.target.closest("[data-object]")) return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowRight") { stopPlay(); setStep(app.stepIndex + 1); }
      else if (e.key === "ArrowLeft") { stopPlay(); setStep(app.stepIndex - 1); }
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
    wireControls();
    applyUrlState();
    if (app.sandbox) setSandbox(true);
    bootstrapData();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
