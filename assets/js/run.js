/**
 * seLe4n Execution Theater — browser runtime.
 *
 * Replays deterministic kernel execution traces and renders the kernel "in
 * action": threads moving between the CPU, run queue, and IPC wait queues, with
 * the machine-checked invariants shown holding at every step.
 *
 * Design constraints (match the rest of the site):
 *   - Vanilla ES5-style IIFE, no frameworks, strict CSP (no inline/eval).
 *   - Local-first data load with graceful live refresh + localStorage cache.
 *   - Theme / i18n / nav / background are owned by the shared scripts; this file
 *     mirrors map.js for the theme + background-animation toggles.
 *
 * The embedded fold engine is a faithful re-implementation of
 * scripts/lib/trace-analysis.mjs (which the Node tests pin down). It applies the
 * effects a trace already recorded; it never re-implements kernel semantics.
 */
(function () {
  "use strict";

  /* ── i18n helper (returns "" so callers can || a literal fallback) ── */
  function t(key, vars) {
    if (window.sele4nI18n && typeof window.sele4nI18n.t === "function") {
      var result = window.sele4nI18n.t(key, vars);
      if (result && result !== key) return result;
    }
    return "";
  }
  function tt(key, fallback, vars) { return t(key, vars) || fallback; }

  var REPO = "hatter6822/seLe4n";
  var REF = "main";
  var DATA_ENDPOINT = "data/execution-traces.json";
  var CANONICAL_RAW = "https://raw.githubusercontent.com/" + REPO + "/" + REF + "/docs/execution-traces.json";

  var FETCH_OPTIONS = {
    credentials: "omit",
    cache: "no-store",
    mode: "cors",
    redirect: "error",
    referrerPolicy: "no-referrer"
  };
  var FETCH_TIMEOUT_MS = 9000;

  var CACHE_KEY = "sele4n-exec-traces-v1";
  var CACHE_SCHEMA_VERSION = 1;
  var CACHE_TTL_MS = 60 * 60 * 1000;
  var CACHE_MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;
  var BG_ANIMATION_KEY = "sele4n-bg-animation-paused-v1";
  var SCHEMA_VERSION = 1;

  var PLAY_INTERVAL_MS = 1100;
  var ALLOWED_OPS = ["setCurrent", "threadPatch", "epEnqueue", "epDequeue", "rqInsert", "rqRemove", "notifPatch", "message", "note"];

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
    DOM.rail = document.getElementById("invariant-rail");
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
      default:
        return state; // message / note are event-only
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
    var threads = {}, endpoints = {}, notifications = {};
    var ops = (delta && Array.isArray(delta.ops)) ? delta.ops : [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.op === "setCurrent" && op.thread) threads[op.thread] = 1;
      else if (op.op === "threadPatch" && op.id) threads[op.id] = 1;
      else if ((op.op === "epEnqueue" || op.op === "epDequeue")) { if (op.endpoint) endpoints[op.endpoint] = 1; if (op.thread) threads[op.thread] = 1; }
      else if ((op.op === "rqInsert" || op.op === "rqRemove") && op.thread) threads[op.thread] = 1;
      else if (op.op === "notifPatch" && op.id) notifications[op.id] = 1;
      else if (op.op === "message") { if (op.from) threads[op.from] = 1; if (op.to) threads[op.to] = 1; if (op.endpoint) endpoints[op.endpoint] = 1; }
    }
    return { threads: threads, endpoints: endpoints, notifications: notifications };
  }

  /* Lightweight client-side validation — guard against malformed remote data. */
  function isValidTraceData(data) {
    if (!data || typeof data !== "object") return false;
    if (data.schemaVersion !== SCHEMA_VERSION) return false;
    if (!Array.isArray(data.scenarios) || !data.scenarios.length) return false;
    for (var i = 0; i < data.scenarios.length; i++) {
      var sc = data.scenarios[i];
      if (!sc || !sc.initialState || !Array.isArray(sc.steps) || !sc.steps.length) return false;
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
    var th = findThread(viewState(), id);
    if (th && th.label) return th.label;
    var meta = objectMeta(id);
    if (meta && meta.label) return meta.label;
    return id;
  }
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
    var state = viewState();
    if (!state) return;
    var step = currentStep();
    var touched = step ? touchedEntities(step.delta) : { threads: {}, endpoints: {}, notifications: {} };
    var positions = {}; // id -> {x,y} center, for message animation

    var root = svg("svg", { "class": "theater-svg", xmlns: SVG_NS });
    root.setAttribute("role", "img");
    root.setAttribute("aria-label", tt("run.stage_aria", "Kernel system state visualization"));

    // Determine which threads are "in a queue" (endpoint/notification) so the
    // off-queue blocked lane only shows reply/call-blocked threads.
    var placedInQueue = {};
    (state.endpoints || []).forEach(function (ep) {
      (ep.receiveQ || []).forEach(function (id) { placedInQueue[id] = 1; });
      (ep.sendQ || []).forEach(function (id) { placedInQueue[id] = 1; });
    });
    (state.notifications || []).forEach(function (n) { (n.waiters || []).forEach(function (id) { placedInQueue[id] = 1; }); });

    var current = state.current && state.current.thread;
    var core = (state.current && state.current.core) || 0;
    var rq = (state.runQueue && state.runQueue[String(core)]) || [];
    var rqSet = {}; rq.forEach(function (id) { rqSet[id] = 1; });

    var offQueue = (state.threads || []).filter(function (th) {
      return isBlocked(th) && !placedInQueue[th.id] && th.id !== current && !rqSet[th.id];
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
          current: th.id === current,
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

    var curThread = current ? findThread(state, current) : null;
    y = placeBox(leftX, y, tt("run.cpu", "CPU · core " + core), "running", curThread ? [curThread] : [], tt("run.cpu_idle", "— no current —"));
    var rqThreads = rq.map(function (id) { return findThread(state, id) || { id: id, label: id, threadState: "Ready", priority: "?", ipcState: "ready" }; });
    y = placeBox(leftX, y, tt("run.runqueue", "Run queue"), "ready", rqThreads, tt("run.runqueue_empty", "— no ready threads —"));
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
    root.setAttribute("viewBox", "0 0 " + width + " " + height);
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));
    DOM.stage.appendChild(root);

    // Message envelope animation for the current step.
    if (step && !prefersReducedMotion()) animateMessages(root, step, positions);
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
     Invariant rail
     ════════════════════════════════════════════════════════════ */

  // Client-side structural checks for the sandbox (UNVERIFIED, illustrative only).
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
    results.schedulerRunQueueUnique = !dupRunQueue;
    var cur = current ? findThread(state, current) : null;
    results.currentThreadValid = !!(cur && cur.threadState === "Running" && !inRunQueue[current]);
    results.schedulerQueueCurrentConsistent = !current || !inRunQueue[current];
    var blockedRunnable = (state.threads || []).some(function (th) { return isBlocked(th) && inRunQueue[th.id]; });
    results.blockedOnReceiveNotRunnable = !blockedRunnable;
    results.blockedOnSendNotRunnable = !blockedRunnable;
    return results;
  }

  function renderRail() {
    if (!DOM.rail) return;
    clear(DOM.rail);
    var catalog = (app.data && app.data.invariantCatalog) || [];
    var step = currentStep();
    var checkedSet = {};
    if (step && step.invariants && step.invariants.checked) step.invariants.checked.forEach(function (id) { checkedSet[id] = 1; });
    var sandboxResults = app.sandbox ? jsChecks(viewState()) : null;
    var anyViolation = false;

    catalog.forEach(function (inv) {
      var status = "holds";          // holds (per proof) / verified (this step) / violated (sandbox)
      if (sandboxResults && Object.prototype.hasOwnProperty.call(sandboxResults, inv.id)) {
        status = sandboxResults[inv.id] ? "holds" : "violated";
        if (!sandboxResults[inv.id]) anyViolation = true;
      } else if (checkedSet[inv.id]) {
        status = "verified";
      }
      var href = "map.html?module=" + encodeURIComponent(inv.mapModule);
      var item = el("li", { "class": "rail-item", dataset: { status: status, subsystem: inv.subsystem || "" } }, [
        el("span", { "class": "rail-mark", "aria-hidden": "true", text: status === "violated" ? "✕" : "✓" }),
        el("a", { "class": "rail-link", href: href, title: inv.check + " — " + inv.module }, [
          el("span", { "class": "rail-label", text: inv.label }),
          el("span", { "class": "rail-check", text: inv.check })
        ])
      ]);
      DOM.rail.appendChild(item);
    });

    var summary = document.getElementById("rail-summary");
    if (summary) {
      if (app.sandbox) {
        summary.textContent = anyViolation
          ? tt("run.rail_violated", "Sandbox: a structural check is violated (this is exactly what the Lean proofs forbid).")
          : tt("run.rail_sandbox_ok", "Sandbox: client-side structural checks pass (unverified).");
        summary.dataset.tone = anyViolation ? "bad" : "warn";
      } else {
        summary.textContent = tt("run.rail_ok", "All machine-checked invariants hold at this step.");
        summary.dataset.tone = "good";
      }
    }
  }

  /* ════════════════════════════════════════════════════════════
     Inspector (step detail + selected object)
     ════════════════════════════════════════════════════════════ */

  function humanizeOp(op) {
    switch (op.op) {
      case "setCurrent": return "Context switch → " + (op.thread ? labelOf(op.thread) : "none");
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
      case "message": return "Message " + labelOf(op.from) + " → " + labelOf(op.to) + " (" + (op.registers || 0) + " regs" + (op.caps ? ", " + op.caps + " caps" : "") + ")";
      case "note": return op.text || "";
      default: return op.op;
    }
  }

  function renderInspector() {
    if (!DOM.inspector) return;
    clear(DOM.inspector);
    var step = currentStep();
    if (!step) return;

    var kindEl = el("span", { "class": "insp-kind", dataset: { kind: step.kind }, text: step.kind });
    var head = el("div", { "class": "insp-head" }, [
      kindEl,
      el("code", { "class": "insp-tag", text: step.traceTag }),
      step.actor ? el("span", { "class": "insp-actor", text: tt("run.actor", "actor") + ": " + labelOf(step.actor) }) : null
    ]);
    DOM.inspector.appendChild(head);
    DOM.inspector.appendChild(el("h3", { "class": "insp-title", text: step.title }));
    if (step.narrative) DOM.inspector.appendChild(el("p", { "class": "insp-narrative", text: step.narrative }));

    if (step.syscall) {
      var sc = step.syscall;
      var rows = [
        ["syscall", sc.id],
        ["gate", sc.gate],
        ["required right", sc.requiredRight],
        ["cap path", sc.capPath]
      ];
      var dl = el("dl", { "class": "insp-grid" });
      rows.forEach(function (r) {
        if (!r[1]) return;
        dl.appendChild(el("dt", { text: r[0] }));
        dl.appendChild(el("dd", {}, [el("code", { text: String(r[1]) })]));
      });
      if (sc.args) {
        dl.appendChild(el("dt", { text: "args" }));
        dl.appendChild(el("dd", {}, [el("code", { text: JSON.stringify(sc.args) })]));
      }
      DOM.inspector.appendChild(el("div", { "class": "insp-section" }, [el("h4", { text: tt("run.syscall", "Syscall") }), dl]));
    }

    var ops = (step.delta && step.delta.ops) || [];
    if (ops.length) {
      var ul = el("ul", { "class": "insp-effects" });
      ops.forEach(function (op) { ul.appendChild(el("li", { dataset: { op: op.op }, text: humanizeOp(op) })); });
      DOM.inspector.appendChild(el("div", { "class": "insp-section" }, [el("h4", { text: tt("run.effects", "Effects") }), ul]));
    }

    if (step.sourceRefs && step.sourceRefs.length) {
      var refs = el("ul", { "class": "insp-refs" });
      step.sourceRefs.forEach(function (ref) {
        var href = "map.html?module=" + encodeURIComponent(ref.module);
        refs.appendChild(el("li", {}, [
          el("a", { href: href, title: ref.module }, [el("code", { text: ref.label })]),
          el("span", { "class": "insp-ref-mod", text: ref.module })
        ]));
      });
      DOM.inspector.appendChild(el("div", { "class": "insp-section" }, [el("h4", { text: tt("run.source", "Source") }), refs]));
    }

    // Selected object detail.
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
      if (ep) { title = "Endpoint · " + (labelOf(id)); fields.push(["receiveQ", (ep.receiveQ || []).map(labelOf).join(", ") || "—"]); fields.push(["sendQ", (ep.sendQ || []).map(labelOf).join(", ") || "—"]); }
      else if (n) { title = "Notification · " + (labelOf(id)); fields.push(["state", n.state]); fields.push(["waiters", (n.waiters || []).map(labelOf).join(", ") || "—"]); fields.push(["badge", n.badge == null ? "—" : n.badge]); }
      else return;
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
        dataset: { kind: step.kind, active: active ? "true" : "false" },
        onclick: function () { setStep(i); }
      }, [
        el("code", { "class": "log-tag", text: step.traceTag }),
        el("span", { "class": "log-kind", text: step.kind }),
        el("span", { "class": "log-title", text: step.title })
      ]);
      if (active) line.setAttribute("aria-current", "step");
      DOM.log.appendChild(line);
    });
    var activeLine = DOM.log.querySelector('[data-active="true"]');
    if (activeLine && activeLine.scrollIntoView) {
      try { activeLine.scrollIntoView({ block: "nearest" }); } catch (e) {}
    }
  }

  /* ════════════════════════════════════════════════════════════
     Transport
     ════════════════════════════════════════════════════════════ */

  function render() {
    if (!app.scenario) return;
    renderStage();
    renderRail();
    renderInspector();
    renderLog();
    updateTransport();
  }

  function updateTransport() {
    var step = currentStep();
    var total = app.scenario ? app.scenario.steps.length : 0;
    if (DOM.scrubber) { DOM.scrubber.max = String(Math.max(0, total - 1)); DOM.scrubber.value = String(app.stepIndex); }
    if (DOM.stepLabel) DOM.stepLabel.textContent = (app.stepIndex + 1) + " / " + total;
    if (DOM.caption && step) DOM.caption.textContent = step.title;
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
    app.scene = sc.primaryScene || "system";
    if (!keepStep) app.stepIndex = 0;
    app.stepIndex = Math.max(0, Math.min(app.scenario.steps.length - 1, app.stepIndex));
    app.selectedObject = "";
    app.sandboxState = null;
    if (DOM.scenarioSelect) DOM.scenarioSelect.value = sc.id;
    render();
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
    if (app.selectedObject) params.push("object=" + encodeURIComponent(app.selectedObject));
    if (app.sandbox) params.push("sandbox=1");
    var qs = "?" + params.join("&");
    try { window.history.replaceState(null, "", qs); } catch (e) {}
  }

  function applyUrlState() {
    var q = parseQuery();
    if (q.scenario) app.scenarioId = q.scenario;
    if (q.step != null && q.step !== "") { var n = parseInt(q.step, 10); if (!isNaN(n)) app.stepIndex = n; }
    if (q.object) app.selectedObject = q.object;
    if (q.sandbox === "1") app.sandbox = true;
  }

  /* ════════════════════════════════════════════════════════════
     Data loading (local-first + graceful live refresh)
     ════════════════════════════════════════════════════════════ */

  function safeFetchJson(url) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS) : null;
    var opts = ctrl ? Object.assign({}, FETCH_OPTIONS, { signal: ctrl.signal }) : FETCH_OPTIONS;
    return fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).catch(function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  function getCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed.schema !== CACHE_SCHEMA_VERSION || !parsed.data) return null;
      if (Math.max(0, Date.now() - Number(parsed.ts || 0)) > CACHE_MAX_STALE_MS) return null;
      return parsed.data;
    } catch (e) { return null; }
  }
  function putCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: CACHE_SCHEMA_VERSION, ts: Date.now(), data: data })); } catch (e) {}
  }
  function newer(a, b) {
    if (!a) return false; if (!b) return true;
    return new Date(a.generatedAt || 0).getTime() > new Date(b.generatedAt || 0).getTime();
  }

  function adoptData(data, label) {
    if (!isValidTraceData(data)) return false;
    app.data = data;
    buildScenarioOptions();
    updateSourceBadge();
    loadScenario(app.scenarioId || (data.scenarios[0] && data.scenarios[0].id), true);
    setStatus(tt("run.ready", "Ready — replaying " + label, { label: label }) || ("Ready — " + label));
    return true;
  }

  function bootstrapData() {
    setStatus(tt("run.loading", "Loading kernel traces…"));
    var cached = getCache();
    safeFetchJson(DATA_ENDPOINT).then(function (bundled) {
      var best = bundled;
      if (cached && newer(cached, bundled)) best = cached;
      if (!adoptData(best, best === cached ? "cached snapshot" : "bundled snapshot")) {
        if (!adoptData(bundled, "bundled snapshot") && !(cached && adoptData(cached, "cached snapshot"))) {
          setStatus(tt("run.invalid", "Bundled trace data is invalid."), true);
          return;
        }
      }
      // Best-effort live refresh (upstream artifact may not exist yet → silent fallback).
      liveRefresh();
    }).catch(function () {
      if (cached && adoptData(cached, "cached snapshot")) { liveRefresh(); return; }
      setStatus(tt("run.offline", "Could not load trace data."), true);
    });
  }

  function liveRefresh() {
    safeFetchJson(CANONICAL_RAW).then(function (remote) {
      if (isValidTraceData(remote) && newer(remote, app.data)) {
        putCache(remote);
        adoptData(remote, "live kernel export");
      }
    }).catch(function () { /* offline / 404 — keep local data */ });
  }

  function buildScenarioOptions() {
    if (!DOM.scenarioSelect) return;
    clear(DOM.scenarioSelect);
    (app.data.scenarios || []).forEach(function (sc) {
      DOM.scenarioSelect.appendChild(el("option", { value: sc.id, text: sc.title }));
    });
  }

  function updateSourceBadge() {
    if (!DOM.sourceBadge || !app.data) return;
    var isKernel = app.data.source === "kernel";
    DOM.sourceBadge.dataset.source = app.data.source;
    DOM.sourceBadge.textContent = isKernel
      ? tt("run.source_kernel", "verified kernel export · " + (app.data.kernelVersion || ""))
      : tt("run.source_fixture", "reference fixture · schema v" + (app.data.schemaVersion || 1));
    DOM.sourceBadge.title = app.data.disclaimer || "";
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

  function setupBackgroundAnimationToggle() {
    var button = document.getElementById("bg-animation-toggle");
    if (!button) return;
    function readPaused() { try { return localStorage.getItem(BG_ANIMATION_KEY) === "1"; } catch (e) { return false; } }
    function applyState(paused) {
      button.classList.toggle("is-paused", paused);
      button.setAttribute("aria-pressed", paused ? "true" : "false");
      var resume = tt("nav.resume_bg", "Resume background animation");
      var pause = tt("nav.pause_bg", "Pause background animation");
      button.setAttribute("aria-label", paused ? resume : pause);
      button.title = paused ? resume : pause;
      document.documentElement.setAttribute("data-bg-animation", paused ? "paused" : "running");
      window.dispatchEvent(new CustomEvent("sele4n:bg-animation-toggle", { detail: { paused: paused } }));
    }
    applyState(readPaused());
    button.addEventListener("click", function () {
      var nextPaused = button.getAttribute("aria-pressed") !== "true";
      try { localStorage.setItem(BG_ANIMATION_KEY, nextPaused ? "1" : "0"); } catch (e) {}
      applyState(nextPaused);
    });
    window.addEventListener("storage", function (e) { if (e.key === BG_ANIMATION_KEY) applyState(readPaused()); });
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

    window.addEventListener("sele4n:locale-changed", function () { if (app.scenario) { updateSourceBadge(); render(); } });
    document.addEventListener("visibilitychange", function () { if (document.hidden) stopPlay(); });
  }

  function init() {
    cacheDom();
    setupTheme();
    setupBackgroundAnimationToggle();
    hardenExternalLinks();
    wireControls();
    applyUrlState();
    if (app.sandbox) setSandbox(true);
    bootstrapData();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
