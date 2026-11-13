/**
 * seLe4n Simulator — scenes.
 *
 * Seven lenses on one folded state, each drawn as an SVG at 1:1:
 *
 *   path       the trap, the registers the kernel decodes (x1 bit by bit), the
 *              CPtr walked through guard and radix bits, every gate in the
 *              order the kernel runs it, and the scheduling decision; for a
 *              tick, a reschedule and an interrupt, the entry's own mechanism
 *   ipc        endpoint and notification queues, the message and capability a
 *              rendezvous moves, and each thread's state transition
 *   scheduler  per-core run queues (insertion order and priority buckets),
 *              eligibility, the next pick and why, scheduling contexts with
 *              their head and pending refills, and the release queues
 *   cspace     CNode slots and the derivation tree, with what a delete or a
 *              revoke removed
 *   memory     untyped regions to scale, aligned carves, each capability's
 *              free index, address-space mappings and the TLB
 *   infoflow   the label lattice with the flows `securityFlowsTo` admits, the
 *              step's flow checks, and the declassification audit log
 *   irq        interrupt lines, their node slots, the notifications they
 *              signal and the threads those wake
 *
 * This file draws; it decides nothing. Every fact it shows is read off the
 * state or asked of the trace engine (`window.sele4nTraceEngine`): the
 * capability walk, the type gate, the selection, the refill arithmetic, the
 * carve placement and the interrupt binding are the engine's functions, the
 * same ones the validator checks the trace with.
 *
 * `window.sele4nRunScenes(env)` returns `{ SCENES, available, render, legend }`.
 * `render(id, model)` returns the `<svg>`. All styling is by class and data
 * attribute (the page's CSP refuses inline style).
 */
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var SCENES = ["path", "ipc", "scheduler", "cspace", "memory", "infoflow", "irq"];
  var M = 16;          /* outer margin */
  var W = 880;         /* content width: the scene is M + W + M wide at least */
  var RIGHT_ABBR = { read: "R", write: "W", grant: "G", grantReply: "GR", retype: "RT" };

  function svg(tag, attrs, text) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  /* Condense an SVG <text> so it never paints past `maxWidth`: SVG text neither
     wraps nor clips. `clip` cuts it with an ellipsis and keeps the whole string
     as the tooltip. A no-op where text cannot be measured (the test shim). */
  function measure(node) {
    if (!node || typeof node.getComputedTextLength !== "function") return NaN;
    try { return node.getComputedTextLength(); } catch (e) { return NaN; }
  }
  function fitText(node, maxWidth, clip, len) {
    if (!node || !(maxWidth > 0)) return;
    try {
      if (len === undefined) len = measure(node);
      if (!(isFinite(len) && len > maxWidth)) return;
      if (clip) {
        var full = node.textContent;
        node.appendChild(svg("title", null, full));
        var keep = Math.max(1, Math.floor(full.length * maxWidth / len) - 1);
        node.firstChild.nodeValue = full.slice(0, keep) + "…";
        /* The cut is a proportion, and glyphs are not all one width: trim
           until what is left fits. Only clipped labels pay for the re-measure. */
        for (var guard = 0; guard < 12 && keep > 1 && measure(node) > maxWidth; guard++) {
          keep -= 1;
          node.firstChild.nodeValue = full.slice(0, keep).replace(/\s+$/, "") + "…";
        }
        return;
      }
      node.setAttribute("textLength", String(Math.round(maxWidth)));
      node.setAttribute("lengthAdjust", "spacingAndGlyphs");
    } catch (e) { /* not measurable yet */ }
  }

  window.sele4nRunScenes = function (env) {
    var E = env.engine;
    var tt = env.tt;
    var fmt = env.fmtNum;
    function L(key, fallback, vars) { return tt("run." + key, fallback, vars); }

    /* ── Canvas ─────────────────────────────────────────────── */

    var TONES = ["muted", "accent", "ok", "bad", "warn", "purple"];
    function Canvas(label, selected) {
      /* A group, not an image: the objects inside are buttons of their own. */
      this.root = svg("svg", { "class": "theater-svg", role: "group", "aria-label": label });
      this.defs = svg("defs");
      this.root.appendChild(this.defs);
      this.edges = svg("g", { "class": "scene-edges" });
      this.body = svg("g", { "class": "scene-body" });
      this.root.appendChild(this.edges);
      this.root.appendChild(this.body);
      this.w = W + M;
      this.h = 0;
      this.fits = [];
      this.selected = selected || "";
      for (var i = 0; i < TONES.length; i++) {
        var mk = svg("marker", { id: "mk-" + TONES[i], viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
        mk.appendChild(svg("path", { d: "M0,0 L10,5 L0,10 z", "class": "mk", "data-tone": TONES[i] }));
        this.defs.appendChild(mk);
      }
      var hatch = svg("pattern", { id: "hatch", width: "6", height: "6", patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
      hatch.appendChild(svg("line", { x1: "0", y1: "0", x2: "0", y2: "6", "class": "hatch-line" }));
      this.defs.appendChild(hatch);
    }
    Canvas.prototype.extend = function (x, y) { if (x > this.w) this.w = x; if (y > this.h) this.h = y; };
    /* Text. `opts.max` bounds its width (condensed, or clipped with `clip`). */
    Canvas.prototype.text = function (x, y, str, cls, opts) {
      opts = opts || {};
      var node = svg("text", { x: x, y: y, "class": "tx " + (cls || ""), "text-anchor": opts.anchor || null, "data-tone": opts.tone || null }, str);
      (opts.parent || this.body).appendChild(node);
      if (opts.max) this.fits.push([node, opts.max, opts.clip !== false]);
      this.extend(opts.anchor ? 0 : x, y + 6);
      return node;
    };
    Canvas.prototype.box = function (x, y, w, h, tone, attrs, parent) {
      var a = { x: x, y: y, width: w, height: h, rx: 6, "class": "bx", "data-tone": tone || null };
      if (attrs) for (var k in attrs) a[k] = attrs[k];
      var node = svg("rect", a);
      (parent || this.body).appendChild(node);
      this.extend(x + w, y + h);
      return node;
    };
    Canvas.prototype.line = function (d, tone, opts) {
      opts = opts || {};
      var p = svg("path", { d: d, "class": "ed", "data-tone": tone || "muted", "data-dash": opts.dash ? "true" : null, "data-weight": opts.weight || null, "marker-end": opts.arrow === false ? null : "url(#mk-" + (tone || "muted") + ")" });
      (opts.parent || this.edges).appendChild(p);
      return p;
    };
    /* A group the inspector can select. */
    Canvas.prototype.object = function (id, label, changed) {
      var g = svg("g", { "class": "theater-obj", tabindex: "0", role: "button", "aria-label": label, "data-object": id });
      if (this.selected === id) g.setAttribute("data-selected", "true");
      if (changed) g.setAttribute("data-changed", "true");
      this.body.appendChild(g);
      return g;
    };
    /* A numbered section heading; returns the y below it. */
    Canvas.prototype.section = function (y, n, title, note) {
      var g = svg("g", { "class": "scene-section" });
      this.body.appendChild(g);
      g.appendChild(svg("circle", { cx: M + 9, cy: y + 9, r: 9, "class": "sec-dot" }));
      this.text(M + 9, y + 13, String(n), "sec-num", { anchor: "middle", parent: g });
      this.text(M + 26, y + 13, title, "sec-title", { parent: g, max: note ? 430 : W - 30 });
      if (note) this.text(M + W, y + 13, note, "tx-small", { anchor: "end", parent: g, max: W - 470 });
      this.extend(M + W, y + 20);
      return y + 30;
    };
    Canvas.prototype.finish = function () {
      var w = Math.ceil(this.w + M), h = Math.ceil(this.h + M);
      this.root.setAttribute("viewBox", "0 0 " + w + " " + h);
      this.root.setAttribute("width", String(w));
      this.root.setAttribute("height", String(h));
      return this.root;
    };
    /* Measure everything, then write: one layout for the scene, not one per label. */
    Canvas.prototype.fit = function () {
      var lens = [], i;
      for (i = 0; i < this.fits.length; i++) lens.push(measure(this.fits[i][0]));
      for (i = 0; i < this.fits.length; i++) fitText(this.fits[i][0], this.fits[i][1], this.fits[i][2], lens[i]);
    };

    /* ── Shared facts ───────────────────────────────────────── */

    var COLLECTIONS = ["threads", "endpoints", "notifications", "replies", "schedContexts", "cnodes", "untyped", "vspaces", "labels"];
    function findAny(s, id) {
      for (var i = 0; i < COLLECTIONS.length; i++) { var o = E.byId(s[COLLECTIONS[i]], id); if (o) return o; }
      return null;
    }
    function nameOf(s, id) {
      if (id === null || id === undefined) return "";
      var o = findAny(s, id);
      return o && o.name ? o.name : String(id);
    }
    function hex(n) { return "0x" + Number(n || 0).toString(16); }
    function bin(n, width) {
      var out = Number(n || 0).toString(2);
      while (out.length < width) out = "0" + out;
      return out;
    }
    function bytes(n) {
      n = Number(n) || 0;
      if (n >= 1024 && n % 1024 === 0) return L("kib", "{{n}} KiB", { n: fmt(n / 1024) });
      return L("bytes", "{{n}} B", { n: fmt(n) });
    }
    function rightsText(rights) { return (rights || []).map(function (r) { return RIGHT_ABBR[r] || r; }).join(" "); }
    function stepOps(step) { return (step && step.delta && Array.isArray(step.delta.ops)) ? step.delta.ops : []; }
    function isRefused(step) { return !!(step && step.outcome && step.outcome.status === "error"); }
    function stageOf(step, name) {
      var path = (step && step.path) || [];
      for (var i = 0; i < path.length; i++) if (path[i].stage === name) return path[i];
      return null;
    }
    /* The state just before op `index` of the step applies. */
    function stateBeforeOp(pre, step, index) {
      var s = E.clone(pre);
      var ops = stepOps(step);
      for (var i = 0; i < index && i < ops.length; i++) E.applyOp(s, ops[i]);
      return s;
    }
    function opIndex(step, name, from) {
      var ops = stepOps(step);
      for (var i = from || 0; i < ops.length; i++) if (ops[i].op === name) return i;
      return -1;
    }
    function ipcState(th) { return (th && th.ipc && th.ipc.state) || "ready"; }
    var IPC_KEYS = { ready: ["ipc_ready", "ready"], blockedOnSend: ["ipc_send", "blocked on send"], blockedOnReceive: ["ipc_receive", "blocked on receive"], blockedOnCall: ["ipc_call", "blocked on call"], blockedOnReply: ["ipc_reply", "blocked on reply"], blockedOnNotification: ["ipc_notification", "blocked on notification"], inactive: ["ipc_inactive", "inactive"] };
    var STATUS_KEYS = { running: ["legend_running", "Running"], ready: ["legend_ready", "Ready"], blocked: ["legend_blocked", "Blocked"], inactive: ["legend_inactive", "Inactive"] };
    function statusOf(s, th) { return E.threadStatus(s, th).toLowerCase(); }
    /* What a thread is doing, in one phrase: where it runs, or what it waits on. */
    function threadPhase(s, th) {
      var st = statusOf(s, th);
      if (st === "running") return L("phase_running", "running on core {{core}}", { core: E.currentCoreOf(s, th.id) });
      if (st === "ready") return L("phase_ready", "ready, queued on core {{core}}", { core: E.queuedOn(s, th.id)[0] });
      var k = IPC_KEYS[ipcState(th)] || IPC_KEYS.inactive;
      var base = L(k[0], k[1]);
      return th.ipc && th.ipc.object ? base + " · " + nameOf(s, th.ipc.object) : base;
    }
    var KIND_KEYS = {
      endpoint: ["kind_endpoint", "endpoint"], notification: ["kind_notification", "notification"], cnode: ["kind_cnode", "CNode"],
      untyped: ["kind_untyped", "untyped"], frame: ["kind_frame", "frame"], vspace: ["kind_vspace", "address space"],
      pageTable: ["kind_page_table", "page table"], reply: ["kind_reply", "reply"], tcb: ["kind_tcb", "thread"],
      schedContext: ["kind_sched_context", "scheduling context"], irqControl: ["kind_irq_control", "interrupt control"], irqHandler: ["kind_irq_handler", "interrupt handler"]
    };
    function kindName(kind) { var k = KIND_KEYS[kind]; return k ? L(k[0], k[1]) : String(kind || ""); }
    function capTarget(s, cap) {
      if (!cap) return "";
      if (cap.kind === "irqHandler") return L("irq_line_n", "line {{n}}", { n: cap.line });
      if (cap.kind === "irqControl") return L("irq_all_lines", "all lines");
      return nameOf(s, cap.target);
    }
    var STAGE_KEYS = { entry: "entry", decode: "decode", lookup: "lookup", type: "type", rights: "rights", args: "arguments", flow: "flow", operation: "operation" };
    function stageName(stage) { return L("stage_" + stage, STAGE_KEYS[stage] || stage); }

    /* ── Shared widgets ─────────────────────────────────────── */

    /* A thread, as a selectable chip: status stripe, name, a second line. */
    function threadChip(c, s, id, x, y, w, opts) {
      opts = opts || {};
      var th = E.byId(s.threads, id);
      var st = th ? statusOf(s, th) : "inactive";
      var g = c.object(id, nameOf(s, id) + " — " + (th ? threadPhase(s, th) : ""), opts.changed);
      c.box(x, y, w, opts.h || 38, null, { "class": "bx chip", "data-status": st, "data-dim": opts.dim ? "true" : null, "data-mark": opts.mark || null }, g);
      g.appendChild(svg("rect", { x: x, y: y, width: 4, height: opts.h || 38, rx: 2, "class": "chip-stripe", "data-status": st }));
      c.text(x + 11, y + 15, nameOf(s, id), "tx-title", { parent: g, max: w - (opts.right ? 62 : 18) });
      if (opts.right) c.text(x + w - 7, y + 15, opts.right, "tx-small", { anchor: "end", parent: g, max: 50 });
      c.text(x + 11, y + 30, opts.sub !== undefined ? opts.sub : (th ? L("prio_short", "prio {{p}}", { p: th.priority }) : ""), "tx-small", { parent: g, max: w - 18, tone: opts.subTone });
      return g;
    }
    /* A capability card: kind → target, rights, badge. `need` rings a right. */
    function capCard(c, s, cap, key, x, y, w, opts) {
      opts = opts || {};
      var g = key ? c.object(key, key + " — " + kindName(cap.kind) + " → " + capTarget(s, cap), opts.changed) : svg("g");
      if (!key) c.body.appendChild(g);
      c.box(x, y, w, 62, opts.tone || "accent", { "data-kind": cap.kind, "data-ghost": opts.ghost ? "true" : null }, g);
      c.text(x + 9, y + 16, kindName(cap.kind), "tx-label", { parent: g, max: w - 18 });
      c.text(x + 9, y + 33, capTarget(s, cap), "tx-title", { parent: g, max: w - 18 });
      var rx = x + 9;
      E.RIGHTS.forEach(function (r) {
        var held = E.capHasRight(cap, r);
        var wide = RIGHT_ABBR[r].length > 1 ? 24 : 17;
        g.appendChild(svg("rect", { x: rx, y: y + 41, width: wide, height: 14, rx: 3, "class": "right-pill", "data-held": held ? "true" : "false", "data-need": opts.need === r ? (held ? "ok" : "missing") : null }));
        c.text(rx + wide / 2, y + 52, RIGHT_ABBR[r], "right-text", { anchor: "middle", parent: g });
        rx += wide + 3;
      });
      var extra = cap.badge !== undefined && cap.badge !== null ? L("badge_short", "badge {{b}}", { b: cap.badge })
        : cap.kind === "untyped" ? L("free_index_short", "free index {{n}}", { n: hex(cap.freeIndex || 0) }) : "";
      if (extra) c.text(x + w - 8, y + 52, extra, "tx-small", { anchor: "end", parent: g, tone: "purple", max: w - (rx - x) - 12 });
      return g;
    }
    /* A row of small cells: one bit, one tick, one queue place. */
    function cells(c, x, y, values, size, attrsFor, parent) {
      for (var i = 0; i < values.length; i++) {
        var a = attrsFor ? attrsFor(i) : {};
        var base = { x: x + i * size, y: y, width: size - 2, height: 20, rx: 3, "class": "cell" };
        for (var k in a) base[k] = a[k];
        (parent || c.body).appendChild(svg("rect", base));
        if (values[i] !== null && values[i] !== undefined) c.text(x + i * size + (size - 2) / 2, y + 14, values[i], "cell-text", { anchor: "middle", parent: parent });
      }
      c.extend(x + values.length * size, y + 20);
    }
    function lead(c, y, lines) {
      for (var i = 0; i < lines.length; i++) c.text(M, y + i * 20, lines[i], i ? "tx-note" : "scene-lead", { max: W });
      return y + lines.length * 20 + 6;
    }
    function empty(c, x, y, w, text) {
      c.box(x, y, w, 30, "muted", { "data-ghost": "true" });
      c.text(x + w / 2, y + 19, text, "tx-note", { anchor: "middle", max: w - 12 });
      return y + 30;
    }

    /* ── Scheduling contexts and selection (path + scheduler) ── */

    var REASONS = {
      first: ["why_first", "first eligible in the bucket"], priority: ["why_priority", "higher priority"], deadline: ["why_deadline", "earlier deadline"],
      lowerPriority: ["why_lower", "lower priority"], laterDeadline: ["why_later", "later deadline"], fifo: ["why_fifo", "queued behind an equal (FIFO)"],
      budget: ["why_budget", "no budget left: ineligible"], domain: ["why_domain", "another domain: ineligible"], missing: ["why_missing", "not a thread"]
    };
    function reasonText(r) { var e = REASONS[r]; return e ? L(e[0], e[1]) : r; }
    /* A row's reason as the selection that produced it reads: a thread found
       by the full-queue fallback was not the first of the top bucket. */
    function rowReason(row, pick) {
      if (row && row.reason === "first" && pick.fallback && row.bucket !== pick.maxPrio) return L("why_first_scan", "first eligible in the whole queue");
      return reasonText(row ? row.reason : "first");
    }

    /* A scheduling context's head and pending refills: the head as one cell
       per tick of budget (filled while it remains), then each pending refill as
       `amount @ release time`. Returns the x after the last thing drawn. */
    function drawRefills(c, sc, x, y, now, parent) {
      var budget = Number(sc.budget) || 0;
      var vals = [];
      for (var i = 0; i < budget; i++) vals.push(null);
      cells(c, x, y, vals, 16, function (i) { return { "data-role": i < sc.remaining ? "budget" : "spent" }; }, parent);
      var rx = x + budget * 16 + 10;
      (sc.refills || []).forEach(function (r) {
        var due = r.at <= now;
        var label = L("refill_at", "{{n}} @ t={{t}}", { n: r.amount, t: r.at });
        (parent || c.body).appendChild(svg("rect", { x: rx, y: y, width: 74, height: 20, rx: 3, "class": "cell", "data-role": due ? "due" : "refill" }));
        c.text(rx + 37, y + 14, label, "cell-text", { anchor: "middle", parent: parent, max: 68 });
        rx += 78;
      });
      c.extend(rx, y + 20);
      return rx;
    }

    /* The candidates `chooseThreadEffectiveOnCore` weighs, in scan order, each
       with its verdict; the chosen one marked. */
    function drawSelection(c, s, coreId, y, chosen) {
      var pick = E.selectOnCore(s, coreId);
      if (!pick.candidates.length) {
        c.text(M, y + 14, L("sel_empty", "The run queue is empty."), "tx-note", { max: W });
        return y + 26;
      }
      c.text(M, y + 12, pick.maxPrio === null ? "" : L("sel_head", "Core {{core}} picks the next thread from the priority-{{p}} bucket", { core: coreId, p: pick.maxPrio }), "tx-note", { max: W });
      y += 22;
      pick.candidates.forEach(function (row, i) {
        var isPick = row.thread === pick.thread;
        var g = svg("g", { "class": "sel-row", "data-pick": isPick ? "true" : null, "data-eligible": row.eligible ? "true" : "false" });
        c.body.appendChild(g);
        c.box(M, y, W, 26, isPick ? "ok" : row.eligible ? null : "muted", { "data-ghost": row.eligible ? null : "true" }, g);
        c.text(M + 10, y + 17, String(i + 1), "tx-small", { parent: g });
        c.text(M + 34, y + 17, nameOf(s, row.thread), "tx-title", { parent: g, max: 170 });
        c.text(M + 214, y + 17, L("prio_short", "prio {{p}}", { p: row.prio === undefined ? row.bucket : row.prio }), "tx-mono", { parent: g, max: 90 });
        c.text(M + 312, y + 17, row.deadline ? L("deadline_short", "deadline {{d}}", { d: row.deadline }) : L("no_deadline", "no deadline"), "tx-mono", { parent: g, max: 130 });
        c.text(M + W - 10, y + 17, (isPick ? L("chosen", "chosen") + " · " : "") + rowReason(row, pick), "tx-mono", { anchor: "end", parent: g, tone: isPick ? "ok" : row.eligible ? null : "bad", max: 400 });
        y += 30;
      });
      if (pick.fallback) { c.text(M, y + 12, L("sel_fallback", "No eligible thread in the top bucket, so the whole queue was scanned."), "tx-note", { max: W }); y += 22; }
      if (chosen === null && !pick.thread) { c.text(M, y + 12, L("sel_idle", "Core {{core}} has no runnable thread: it idles", { core: coreId }), "tx-note", { max: W }); y += 22; }
      return y + 4;
    }

    /* A scheduling context before and after one op, as two refill rows. */
    function scBeforeAfter(c, y, before, after, now, changed) {
      var g = c.object(after.id, after.name || after.id, changed);
      c.box(M, y, W, 62, null, null, g);
      c.text(M + 10, y + 17, after.name || after.id, "tx-title", { parent: g, max: 170 });
      c.text(M + 10, y + 34, L("sc_params", "budget {{b}} per period {{p}}", { b: after.budget, p: after.period }), "tx-small", { parent: g, max: 170 });
      c.text(M + 10, y + 50, before.deadline === after.deadline ? L("deadline_short", "deadline {{d}}", { d: after.deadline }) : L("deadline_moves", "deadline {{a}} → {{b}}", { a: before.deadline, b: after.deadline }), "tx-small", { parent: g, max: 170, tone: before.deadline === after.deadline ? null : "accent" });
      c.text(M + 196, y + 22, L("view_before", "Before"), "tx-small", { parent: g, max: 60 });
      drawRefills(c, before, M + 262, y + 8, now, g);
      c.text(M + 196, y + 46, L("view_after", "After"), "tx-small", { parent: g, max: 60 });
      drawRefills(c, after, M + 262, y + 32, now, g);
      return y + 70;
    }

    /* The selection as it stood just before the step's dispatch on `coreId`. */
    function drawDispatch(c, y, pre, step, n) {
      var ops = stepOps(step);
      for (var i = 0; i < ops.length; i++) {
        if (ops[i].op !== "dispatch") continue;
        y = c.section(y, n, L("sec_selection", "Core {{core}} chooses what runs next", { core: ops[i].core }), "chooseThreadEffectiveOnCore");
        y = drawSelection(c, stateBeforeOp(pre, step, i), ops[i].core, y, ops[i].thread);
        return y + 8;
      }
      return y;
    }

    /* ── Interrupt delivery (path + irq) ─────────────────────── */

    var IRQ_BOX = 200, IRQ_GAP = 26;
    /* What each column of an interrupt row is. */
    function irqHeads(c, y) {
      [L("irq_col_line", "device line"), L("irq_col_slot", "capability in its node slot"), L("irq_col_ntfn", "notification it signals"), L("irq_col_waiter", "thread waiting on it")].forEach(function (label, i) {
        c.text(M + i * (IRQ_BOX + IRQ_GAP), y + 10, label, "tx-label", { max: IRQ_BOX });
      });
      return y + 18;
    }
    function irqRow(c, s, line, y, changed, live) {
      var x = M;
      var key = E.irqNodeSlot(s, line.line);
      var cap = key ? E.capAt(s, key) : null;
      var bind = E.irqBinding(s, line.line);
      var g = c.object("irq:" + line.line, L("irq_line_n", "line {{n}}", { n: line.line }) + " " + (line.name || ""), changed["irq:" + line.line]);
      c.box(x, y, IRQ_BOX, 62, line.masked ? "warn" : line.active ? "accent" : "muted", null, g);
      c.text(x + 9, y + 16, L("irq_line_n", "line {{n}}", { n: line.line }), "tx-label", { parent: g, max: IRQ_BOX - 18 });
      c.text(x + 9, y + 33, line.name || "", "tx-title", { parent: g, max: IRQ_BOX - 18 });
      c.text(x + 9, y + 51, (line.active ? L("irq_signal", "handler issued") : L("irq_inactive", "no handler issued")) + " · " + (line.masked ? L("irq_masked", "masked") : L("irq_unmasked", "unmasked")), "tx-small", { parent: g, max: IRQ_BOX - 18, tone: line.masked ? "warn" : null });
      var x2 = x + IRQ_BOX + IRQ_GAP;
      c.line("M" + (x + IRQ_BOX) + "," + (y + 31) + " L" + (x2 - 2) + "," + (y + 31), live ? (bind ? "ok" : "bad") : "muted", { dash: !line.active });
      if (cap) capCard(c, s, cap, key, x2, y, IRQ_BOX, { changed: changed[key], tone: bind ? "accent" : "muted" });
      else {
        var ge = key ? c.object(key, key, changed[key]) : c.body;
        c.box(x2, y, IRQ_BOX, 62, "muted", { "data-ghost": "true" }, ge);
        c.text(x2 + 9, y + 16, L("irq_node", "interrupt node slot"), "tx-label", { parent: ge, max: IRQ_BOX - 18 });
        c.text(x2 + 9, y + 36, L("slot_empty", "empty"), "tx-note", { parent: ge, max: IRQ_BOX - 18 });
      }
      var x3 = x2 + IRQ_BOX + IRQ_GAP, x4 = x3 + IRQ_BOX + IRQ_GAP;
      if (!bind) {
        c.text(x3, y + 36, L("irq_unbound", "names no notification: a firing is delivered to no one"), "tx-note", { max: IRQ_BOX * 2 + IRQ_GAP });
        return y + 74;
      }
      var n = E.byId(s.notifications, bind.notification);
      c.line("M" + (x2 + IRQ_BOX) + "," + (y + 31) + " L" + (x3 - 2) + "," + (y + 31), live ? "ok" : "muted");
      var gn = c.object(n.id, n.name || n.id, changed[n.id]);
      c.box(x3, y, IRQ_BOX, 62, "purple", null, gn);
      c.text(x3 + 9, y + 16, kindName("notification"), "tx-label", { parent: gn, max: IRQ_BOX - 18 });
      c.text(x3 + 9, y + 33, n.name || n.id, "tx-title", { parent: gn, max: IRQ_BOX - 18 });
      c.text(x3 + 9, y + 51, n.pending === null || n.pending === undefined ? L("ntfn_no_pending", "nothing pending") : L("ntfn_pending", "pending 0b{{bits}}", { bits: bin(n.pending, 8) }), "tx-small", { parent: gn, max: IRQ_BOX - 18, tone: "purple" });
      var waiter = n.waiters && n.waiters.length ? n.waiters[0] : null;
      if (waiter) {
        c.line("M" + (x3 + IRQ_BOX) + "," + (y + 31) + " L" + (x4 - 2) + "," + (y + 31), live ? "ok" : "muted");
        threadChip(c, s, waiter, x4, y + 12, IRQ_BOX, { changed: changed[waiter], sub: L("irq_waiting", "waiting: a signal wakes it") });
      } else c.text(x4, y + 36, L("irq_no_waiter", "no thread is waiting on it now"), "tx-note", { max: IRQ_BOX });
      return y + 74;
    }
    /* What `handleInterruptOnCore` does with a firing of `lineNo`, in order,
       decided on the state the interrupt arrived in. */
    function irqDeliverySteps(c, s, lineNo, y) {
      var line = E.irqLine(s, lineNo);
      var bind = E.irqBinding(s, lineNo);
      var rows = [[L("irq_step_ack", "The controller acknowledges line {{n}} and the kernel signals end of interrupt.", { n: lineNo }), null]];
      if (!bind) {
        rows.push([!line || !line.active ? L("irq_step_unissued", "No handler capability was issued for the line, so it names no notification.")
          : L("irq_step_unbound", "The line's node slot holds no notification capability with the write right."), "bad"]);
        rows.push([L("irq_step_nothing", "Nothing is signalled and no thread is woken."), null]);
      } else {
        var n = E.byId(s.notifications, bind.notification);
        rows.push([L("irq_step_bound", "The node slot's capability names {{name}} with badge {{badge}}.", { name: n.name || n.id, badge: bind.badge }), "ok"]);
        if (n.waiters && n.waiters.length) rows.push([L("irq_step_wake", "{{thread}} is waiting: it leaves the queue, receives badge {{badge}} and becomes ready.", { thread: nameOf(s, n.waiters[0]), badge: bind.badge }), "ok"]);
        else {
          var had = n.pending === null || n.pending === undefined ? 0 : n.pending;
          rows.push([L("irq_step_latch", "No thread waits: the badge is OR-ed into the pending word, {{a}} | {{b}} = {{c}}.", { a: "0b" + bin(had, 8), b: "0b" + bin(bind.badge, 8), c: "0b" + bin(E.orBits(had, bind.badge), 8) }), "purple"]);
        }
      }
      rows.push([L("irq_step_mask", "The line is masked until its handler acknowledges it (irqHandlerAck)."), "warn"]);
      rows.forEach(function (r, i) {
        c.body.appendChild(svg("circle", { cx: M + 9, cy: y + 9, r: 8, "class": "step-dot", "data-tone": r[1] || "muted" }));
        c.text(M + 9, y + 13, String(i + 1), "sec-num", { anchor: "middle" });
        c.text(M + 26, y + 13, r[0], "tx-note", { max: W - 30, tone: r[1] === "bad" ? "bad" : null });
        y += 24;
      });
      return y + 4;
    }

    /* ── Scene: the path through the kernel ──────────────────── */

    var MSG_ROLE = { length: "f-length", extraCaps: "f-extra", capsUnwrapped: "f-unwrapped" };
    var CELL = 22;

    function pathSyscall(c, m, y) {
      var step = m.step, pre = m.pre, call = step.syscall;
      var mi = call.msgInfo || {};
      var hasCap = call.capPtr !== undefined && call.capPtr !== null;
      var n = 1;
      y = c.section(y, n++, L("sec_trap", "{{thread}} traps into the kernel on core {{core}}", { thread: nameOf(pre, step.actor), core: step.core }), "svc #0");
      /* x0 … x7 as the trap frame holds them. */
      var regs = [];
      regs.push(["x0", hasCap ? hex(call.capPtr) : "—", hasCap ? L("reg_cptr", "capability address") : L("reg_unread", "not read"), hasCap ? "accent" : "muted"]);
      regs.push(["x1", hex(E.msgInfoWord(mi)), L("reg_msginfo", "message info"), "purple"]);
      E.REGISTERS.msgRegs.forEach(function (reg) {
        var a = null;
        (call.args || []).forEach(function (arg) { if (arg.reg === reg) a = arg; });
        regs.push([reg, a ? (a.value >= 4096 ? hex(a.value) : fmt(a.value)) : "—", a ? a.name : L("reg_unread", "not read"), a ? null : "muted"]);
      });
      regs.push(["x6", "—", L("reg_unused", "unused"), "muted"]);
      regs.push(["x7", String(call.number), call.id, "ok"]);
      var pitch = W / 8;
      regs.forEach(function (r, i) {
        var x = M + i * pitch;
        c.box(x, y, pitch - 4, 50, r[3], { "data-ghost": r[3] === "muted" ? "true" : null });
        c.text(x + 8, y + 17, r[0], "tx-label");
        c.text(x + pitch - 12, y + 17, r[1], "tx-mono", { anchor: "end", max: pitch - 44 });
        c.text(x + 8, y + 38, r[2], "tx-small", { max: pitch - 18 });
      });
      y += 64;
      /* x1, field by field at the bit positions `MessageInfo.encode` uses. */
      var fields = E.msgInfoFields(mi);
      var word = E.msgInfoWord(mi);
      c.text(M, y + 14, L("msginfo_bits", "x1 decoded (MessageInfo)"), "tx-label", { max: 190 });
      var labelF = fields[3];
      var bx = M + 200;
      c.box(bx, y, 190, 20, "muted", { "class": "bx cellbox" });
      c.text(bx + 95, y + 14, L("msginfo_label", "label = {{v}} · bits 63–12", { v: labelF.value }), "cell-text", { anchor: "middle", max: 182 });
      var cx = bx + 196;
      var vals = [], roles = [];
      for (var bit = 11; bit >= 0; bit--) {
        vals.push(String(E.bitsAt(word, bit, 1)));
        var role = "";
        for (var f = 0; f < 3; f++) if (bit >= fields[f].lo && bit < fields[f].lo + fields[f].width) role = MSG_ROLE[fields[f].name];
        roles.push(role);
      }
      cells(c, cx, y, vals, CELL, function (i) { return { "data-role": roles[i] }; });
      [fields[2], fields[1], fields[0]].forEach(function (fd) {
        var x0 = cx + (11 - (fd.lo + fd.width - 1)) * CELL;
        var wpx = fd.width * CELL - 2;
        c.line("M" + x0 + "," + (y + 25) + " L" + (x0 + wpx) + "," + (y + 25), fd.name === "length" ? "accent" : fd.name === "extraCaps" ? "purple" : "muted", { arrow: false, parent: c.body });
        /* The two narrow fields sit side by side: one label per row. */
        var ty = fd.name === "extraCaps" ? y + 51 : y + 38;
        c.text(x0 + wpx / 2, ty, fd.name + " = " + fd.value, "tx-small", { anchor: fd.name === "capsUnwrapped" ? "end" : "middle", tone: fd.name === "length" ? "accent" : fd.name === "extraCaps" ? "purple" : null });
      });
      /* Under the row's own label, where the line has room in every locale;
         beside the bit cells it was cut to an ellipsis. */
      c.text(M, y + 38, L("msginfo_length_note", "x2–x5 carry the first four message words"), "tx-note", { max: cx - M - 90 });
      y += 60;
      (call.ipcBuffer || []).forEach(function (wd, i) {
        c.text(M, y + 12, L("ipcbuf_word", "IPC buffer, message word {{n}}: {{name}} = {{value}}", { n: 4 + i, name: wd.name, value: wd.value }), "tx-note", { max: W });
        y += 20;
      });
      if ((call.extraCaps || []).length) {
        c.text(M, y + 12, L("extra_caps_line", "Extra capability addresses (IPC buffer): {{list}}", { list: call.extraCaps.map(hex).join(", ") }), "tx-note", { max: W, tone: "purple" });
        y += 20;
      }
      y += 6;

      var r = hasCap ? E.resolveCapSlot(pre, step.actor, call.capPtr) : null;
      if (r) {
        y = c.section(y, n++, L("sec_walk", "x0 is walked through {{thread}}'s CSpace", { thread: nameOf(pre, step.actor) }), "resolveCapAddress");
        var depth = r.levels.length ? r.levels[0].bits : 0;
        var bvals = [], broles = [];
        for (var b = depth - 1; b >= 0; b--) {
          bvals.push(String(E.bitsAt(call.capPtr, b, 1)));
          var br = "rest";
          r.levels.forEach(function (lv) {
            if (b >= lv.shift && b < lv.shift + lv.radixWidth) br = "radix";
            else if (b >= lv.shift + lv.radixWidth && b < lv.shift + lv.radixWidth + lv.guardWidth) br = lv.guardOk ? "guard" : "guard-bad";
          });
          broles.push(br);
        }
        cells(c, M, y, bvals, CELL, function (i) { return { "data-role": broles[i] }; });
        var ly = y + 34;
        r.levels.forEach(function (lv) {
          var gx = M + (depth - (lv.shift + lv.radixWidth + lv.guardWidth)) * CELL;
          var rx = M + (depth - (lv.shift + lv.radixWidth)) * CELL;
          if (lv.guardWidth) c.text(gx + lv.guardWidth * CELL / 2, ly, lv.guardOk ? L("walk_guard_ok", "guard {{g}} = {{v}}", { g: lv.guard, v: lv.guardValue }) : L("walk_guard_bad", "guard {{g}} ≠ {{v}}", { g: lv.guard, v: lv.guardValue }), "tx-small", { anchor: "middle", tone: lv.guardOk ? "ok" : "bad" });
          if (lv.radixWidth && lv.guardOk) c.text(rx + lv.radixWidth * CELL / 2, ly, L("walk_slot", "slot {{n}}", { n: lv.slot }), "tx-small", { anchor: "middle", tone: "accent" });
          ly += 14;
        });
        var last = r.levels[r.levels.length - 1];
        var nx = M + Math.max(depth * CELL, 176) + 44;
        if (last) {
          var cn = E.byId(pre.cnodes, last.cnode);
          c.line("M" + (M + depth * CELL + 4) + "," + (y + 10) + " L" + (nx - 4) + "," + (y + 10), last.guardOk ? "accent" : "bad");
          c.box(nx, y - 6, 220, 62, last.guardOk ? null : "bad");
          c.text(nx + 9, y + 10, kindName("cnode"), "tx-label", { max: 200 });
          c.text(nx + 9, y + 27, cn ? (cn.name || cn.id) : last.cnode, "tx-title", { max: 200 });
          c.text(nx + 9, y + 45, L("cnode_shape", "{{g}} guard bits · {{r}} radix bits · {{n}} slots", { g: last.guardWidth, r: last.radixWidth, n: cn ? E.slotCount(cn) : 0 }), "tx-small", { max: 204 });
          var kx = nx + 220 + 40;
          if (r.cap) {
            c.line("M" + (nx + 220) + "," + (y + 25) + " L" + (kx - 4) + "," + (y + 25), "accent");
            capCard(c, pre, r.cap, null, kx, y - 6, W + M - kx, { need: call.requiredRight });
            c.text(kx, y + 72, L("walk_found", "slot {{slot}} holds this capability", { slot: r.slot }), "tx-small", { max: W + M - kx });
          } else {
            c.line("M" + (nx + 220) + "," + (y + 25) + " L" + (kx - 4) + "," + (y + 25), "bad", { dash: true });
            c.box(kx, y - 6, W + M - kx, 62, "bad", { "data-ghost": "true" });
            var why = r.reason === "guard" ? L("walk_fail_guard", "the guard bits do not match: the walk stops") : r.slot ? L("walk_fail_empty", "slot {{slot}} is empty", { slot: r.slot }) : L("walk_fail_other", "the address does not resolve");
            c.text(kx + 10, y + 20, why, "tx-note", { max: W + M - kx - 20, tone: "bad" });
            c.text(kx + 10, y + 40, r.error || "invalidCapability", "tx-mono", { max: W + M - kx - 20, tone: "bad" });
          }
        }
        y = Math.max(y + 84, ly + 6);
      }

      y = c.section(y, n++, L("sec_gates", "Every gate, in the order the kernel runs them"), L("gates_note", "the first refusal ends the call"));
      var path = step.path || [];
      var passedLookup = !!(r && r.cap);
      var failAt = -1;
      path.forEach(function (st, i) { if (st.result === "fail" && failAt < 0) failAt = i; });
      path.forEach(function (st, i) {
        var tone = st.result === "pass" ? "ok" : st.result === "fail" ? "bad" : "muted";
        var fact = "";
        if (st.stage === "type" && passedLookup) fact = L("gate_type_fact", "invokes {{want}} · found {{got}}", { want: kindName(E.expectedKind(call.id)), got: kindName(r.cap.kind) });
        else if (st.stage === "rights" && passedLookup && call.requiredRight && st.result !== "skip") fact = L("gate_rights_fact", "requires {{need}} · holds {{held}}", { need: RIGHT_ABBR[call.requiredRight] || call.requiredRight, held: rightsText(r.cap.rights) || "—" });
        else if (st.stage === "args" && E.truncationMinimum(call.id) > 0) fact = L("gate_args_fact", "length {{n}} · needs at least {{min}}", { n: mi.length || 0, min: E.truncationMinimum(call.id) });
        else if (st.ref && st.ref.name) fact = st.ref.name;
        var verdict = st.result === "pass" ? L("result_pass", "pass") : st.result === "fail" ? ((step.outcome && step.outcome.error) || L("result_fail", "refused")) : L("result_skip", "not reached");
        /* Two lines a gate: what the stage does, then the fact it decided on. */
        c.box(M, y, W, 44, tone === "muted" ? "muted" : null, { "class": "bx gate", "data-result": st.result, "data-ghost": st.result === "skip" ? "true" : null });
        c.body.appendChild(svg("circle", { cx: M + 16, cy: y + 16, r: 8, "class": "step-dot", "data-tone": tone }));
        c.text(M + 16, y + 20, String(i + 1), "sec-num", { anchor: "middle" });
        c.text(M + 34, y + 20, stageName(st.stage), "tx-title", { max: 92 });
        c.text(M + 132, y + 19, st.label || "", "tx-note", { max: W - 132 - 190 });
        c.text(M + 132, y + 36, fact, "tx-mono", { max: W - 132 - 190, tone: st.result === "fail" ? "bad" : null });
        c.text(M + W - 10, y + 27, verdict, st.result === "fail" ? "tx-mono" : "tx-small", { anchor: "end", tone: tone === "muted" ? null : tone, max: 170 });
        y += 48;
      });
      y += 6;

      y = c.section(y, n++, L("sec_outcome", "Outcome"));
      var refused = isRefused(step);
      c.box(M, y, W, 34, refused ? "bad" : "ok");
      c.text(M + 12, y + 22, refused ? L("outcome_refused_long", "Refused with {{error}}. An error carries no state: nothing changed.", { error: step.outcome.error })
        : L("outcome_committed", "Committed. {{count}} recorded effects, applied in order.", { count: stepOps(step).length }), "tx-title", { max: W - 24, tone: refused ? "bad" : "ok" });
      y += 46;
      return drawDispatch(c, y, pre, step, n);
    }

    function pathTimer(c, m, y) {
      var step = m.step, pre = m.pre, ops = stepOps(step);
      var coreId = step.core || 0;
      var ticked = opIndex(step, "clockTick") !== -1;
      var now = (Number(pre.time) || 0) + (ticked ? 1 : 0);
      var n = 1;
      y = c.section(y, n++, L("sec_clock", "The timer fires on core {{core}}", { core: coreId }), "timerTickOnCore");
      var gk = c.object("clock", L("clock", "clock"), ticked);
      c.box(M, y, W, 34, ticked ? "accent" : "muted", null, gk);
      c.text(M + 12, y + 22, ticked ? L("clock_advance", "The boot core advances the clock: t = {{a}} → {{b}}", { a: pre.time || 0, b: now })
        : L("clock_hold", "Only the boot core advances the clock: t stays {{a}}", { a: pre.time || 0 }), "tx-title", { parent: gk, max: W - 24 });
      y += 46;

      y = c.section(y, n++, L("sec_release", "Refills that have come due are released"), "processReplenishmentsDueOnCore");
      var any = false;
      ops.forEach(function (op, i) {
        if (op.op !== "scRelease") return;
        any = true;
        var before = E.byId(stateBeforeOp(pre, step, i).schedContexts, op.sc);
        var after = E.byId(stateBeforeOp(pre, step, i + 1).schedContexts, op.sc);
        y = scBeforeAfter(c, y, before, after, now, true);
        /* `refillWakeOnCore`: a context that went from nothing to something
           makes its thread eligible again, and the core's choice stale. */
        var woke = null;
        if (before.remaining === 0 && after.remaining > 0) (pre.threads || []).forEach(function (th) { if (th.sc === op.sc) woke = th.id; });
        c.text(M + 10, y + 6, woke ? L("release_wake", "Its budget went from 0 to {{n}}: {{thread}} is eligible again, and the core must choose again.", { n: after.remaining, thread: nameOf(pre, woke) })
          : L("release_no_wake", "Its head refill is now {{n}}.", { n: after.remaining }), "tx-note", { max: W - 20 });
        y += 24;
      });
      if (!any) {
        var q = (pre.releaseQueues && pre.releaseQueues[String(coreId)]) || [];
        var headSc = q.length ? E.byId(pre.schedContexts, q[0]) : null;
        var key = headSc ? E.scReleaseKey(headSc) : null;
        c.text(M, y + 12, headSc && key !== null ? L("release_not_due", "Nothing is due: the earliest release, {{name}}, is at t = {{t}}.", { name: headSc.name || headSc.id, t: key })
          : L("release_empty", "The release queue is empty: nothing to release."), "tx-note", { max: W });
        y += 28;
      }

      y = c.section(y, n++, L("sec_charge", "The running thread is charged one tick"), "timerTickBudgetOnCore");
      var coreObj = E.byId(pre.cores, coreId);
      var curId = coreObj ? coreObj.current : null;
      var ci = opIndex(step, "scCharge");
      if (curId === null || curId === undefined) {
        c.text(M, y + 12, L("charge_idle", "The core is idle: there is no thread to charge."), "tx-note", { max: W });
        y += 28;
      } else if (ci !== -1) {
        var sb = stateBeforeOp(pre, step, ci);
        var b4 = E.byId(sb.schedContexts, ops[ci].sc);
        var aft = E.byId(stateBeforeOp(pre, step, ci + 1).schedContexts, ops[ci].sc);
        var spent = E.scTickExhausts(b4, now - 1);
        y = scBeforeAfter(c, y, b4, aft, now, true);
        var rk = E.scReleaseKey(aft);
        c.text(M + 10, y + 6, spent ? L("charge_exhausted", "{{thread}} used its last tick: the budget is spent, its refill is scheduled for t = {{t}}, and it goes to the back of its queue.", { thread: nameOf(pre, curId), t: rk === null ? "—" : rk })
          : L("charge_spent", "{{thread}} used one tick of {{n}}; it keeps the core.", { thread: nameOf(pre, curId), n: b4.remaining }), "tx-note", { max: W - 20, tone: spent ? "warn" : null });
        y += 24;
      } else {
        var th = E.byId(pre.threads, curId);
        var slice = th ? Number(th.timeSlice) || 0 : 0;
        var expired = slice <= 1;
        var gs = c.object(curId, nameOf(pre, curId), true);
        c.box(M, y, W, 40, expired ? "warn" : null, null, gs);
        c.text(M + 10, y + 25, nameOf(pre, curId), "tx-title", { parent: gs, max: 170 });
        var sv = [];
        for (var k = 0; k < E.DEFAULT_TIME_SLICE; k++) sv.push(null);
        cells(c, M + 196, y + 10, sv, 16, function (i) { return { "data-role": i < slice ? "budget" : "spent" }; }, gs);
        c.text(M + 196 + E.DEFAULT_TIME_SLICE * 16 + 12, y + 25, expired ? L("slice_reset","time slice {{a}} → expired: reset to {{d}}, back of its queue", { a: slice, d: E.DEFAULT_TIME_SLICE })
          : L("slice_spent", "time slice {{a}} → {{b}} (no scheduling context: round-robin)", { a: slice, b: slice - 1 }), "tx-note", { parent: gs, max: W - 300, tone: expired ? "warn" : null });
        y += 52;
      }
      var before = y;
      y = drawDispatch(c, y, pre, step, n);
      if (y === before) {
        y = c.section(y, n, L("sec_sched_point", "Scheduling point"), "rescheduleIfPendingOnCore");
        c.text(M, y + 12, curId === null || curId === undefined ? L("keep_idle", "Nothing became runnable: the core stays idle.") : L("keep_core", "{{thread}} keeps the core: nothing asked for a new choice.", { thread: nameOf(pre, curId) }), "tx-note", { max: W });
        y += 28;
      }
      return y;
    }

    function pathSchedule(c, m, y) {
      var step = m.step, pre = m.pre;
      var coreId = step.core || 0;
      var coreObj = E.byId(pre.cores, coreId);
      var cur = coreObj && coreObj.current !== null && coreObj.current !== undefined ? E.byId(pre.threads, coreObj.current) : null;
      var pick = E.selectOnCore(pre, coreId);
      var cand = pick.thread ? E.byId(pre.threads, pick.thread) : null;
      y = c.section(y, 1, L("sec_resched", "Core {{core}} reaches a scheduling point", { core: coreId }), "handleRescheduleOnCoreState");
      c.text(M, y + 12, L("resched_current", "Running now"), "tx-label", { max: 200 });
      c.text(M + 330, y + 12, L("resched_candidate", "Best eligible candidate"), "tx-label", { max: 200 });
      y += 20;
      if (cur) threadChip(c, pre, cur.id, M, y, 250, { right: L("prio_short", "prio {{p}}", { p: cur.priority }), sub: threadPhase(pre, cur) });
      else empty(c, M, y + 4, 250, L("core_idle", "idle"));
      var verdict, tone = "ok";
      if (!cand) { verdict = cur ? L("resched_none_keep", "No eligible candidate: the current thread keeps the core.") : L("resched_none_idle", "No eligible candidate: the core idles."); tone = "muted"; }
      else {
        threadChip(c, pre, cand.id, M + 330, y, 250, { right: L("prio_short", "prio {{p}}", { p: cand.priority }), sub: threadPhase(pre, cand) });
        if (!cur) verdict = L("resched_take_idle", "The core is idle, so the candidate takes it.");
        else {
          var cp = E.effectiveParams(pre, cur), np = E.effectiveParams(pre, cand);
          var outside = (Number(cur.domain) || 0) !== (Number(coreObj.domain) || 0);
          if (outside) verdict = L("resched_domain", "The current thread is outside the active domain: the candidate takes the core.");
          else if (E.isBetterCandidate(cp.prio, cp.deadline, np.prio, np.deadline)) verdict = np.prio > cp.prio ? L("resched_outranks_prio", "Priority {{a}} outranks {{b}}: the candidate preempts, and the outgoing thread goes to the back of its queue.", { a: np.prio, b: cp.prio })
            : L("resched_outranks_deadline", "Equal priority, earlier deadline ({{a}} before {{b}}): the candidate preempts.", { a: np.deadline, b: cp.deadline || "—" });
          else { verdict = L("resched_keeps", "The candidate does not outrank the current thread, which keeps the core."); tone = "muted"; }
        }
      }
      c.line("M" + (M + 254) + "," + (y + 19) + " L" + (M + 326) + "," + (y + 19), tone === "ok" ? "ok" : "muted", { dash: tone !== "ok", arrow: false });
      c.text(M + 290, y + 14, L("resched_vs", "vs"), "tx-small", { anchor: "middle" });
      y += 50;
      c.text(M, y + 12, verdict, "tx-note", { max: W, tone: tone === "ok" ? "ok" : null });
      y += 30;
      y = c.section(y, 2, L("sec_selection", "Core {{core}} chooses what runs next", { core: coreId }), "chooseThreadEffectiveOnCore");
      return drawSelection(c, pre, coreId, y, pick.thread);
    }

    function pathInterrupt(c, m, y) {
      var lineNo = m.step.irq ? m.step.irq.line : null;
      var line = E.irqLine(m.pre, lineNo);
      y = c.section(y, 1, L("sec_irq_fire", "Line {{n}} fires on core {{core}}", { n: lineNo, core: m.step.core || 0 }), "interruptDispatchSequence");
      if (line) y = irqRow(c, m.pre, line, irqHeads(c, y), {}, true);
      y = c.section(y, 2, L("sec_irq_handle", "What the kernel does with it"), "handleInterruptOnCore");
      return irqDeliverySteps(c, m.pre, lineNo, y);
    }

    /* The starting state: who runs where, and who is queued behind them. */
    function pathBoot(c, m, y) {
      var s = m.state;
      y = lead(c, y + 14, [L("boot_lead", "This is the state the scenario starts from."), L("boot_hint", "Step forward to watch the kernel act on it; each step shows its own path here.")]);
      (s.cores || []).forEach(function (co) {
        c.text(M, y + 24, L("core_n", "Core {{core}}", { core: co.id }), "tx-title", { max: 80 });
        var x = M + 90;
        if (co.current !== null && co.current !== undefined) threadChip(c, s, co.current, x, y, 180, { sub: L("legend_running", "Running") });
        else empty(c, x, y + 4, 180, L("core_idle", "idle"));
        x += 196;
        ((s.runQueues && s.runQueues[String(co.id)]) || []).slice(0, 3).forEach(function (e) {
          threadChip(c, s, e.thread, x, y, 180, { sub: L("queued_prio", "queued · prio {{p}}", { p: e.prio }) });
          x += 190;
        });
        y += 48;
      });
      return y;
    }

    function scenePath(m) {
      var step = m.step;
      var c = new Canvas(L("path_aria", "The path this step takes through the kernel"), m.selected);
      var y = M;
      if (!step || step.kind === "boot") y = pathBoot(c, m, y);
      else if (step.kind === "syscall" && step.syscall) y = pathSyscall(c, m, y);
      else if (step.kind === "timer") y = pathTimer(c, m, y);
      else if (step.kind === "schedule") y = pathSchedule(c, m, y);
      else if (step.kind === "interrupt") y = pathInterrupt(c, m, y);
      else y = lead(c, y + 14, [step.title || ""]);
      c.extend(M + W, y);
      return c;
    }

    /* ── Scene: IPC ──────────────────────────────────────────── */

    function queueRow(c, s, ids, x, y, label, changed, w) {
      c.text(x, y + 24, label, "tx-small", { max: 96 });
      var qx = x + 100;
      if (!ids.length) { c.text(qx, y + 24, L("queue_empty", "empty"), "tx-note", { max: 120 }); return; }
      ids.slice(0, 3).forEach(function (id, i) {
        threadChip(c, s, id, qx, y, 142, { changed: changed[id], sub: i === 0 ? L("queue_head", "head: served first") : L("queue_place", "place {{n}}", { n: i + 1 }) });
        if (i > 0) c.line("M" + (qx - 2) + "," + (y + 19) + " L" + (qx - 8) + "," + (y + 19), "muted");
        qx += 152;
      });
      if (ids.length > 3) c.text(qx, y + 24, L("queue_more", "+{{count}} more", { count: ids.length - 3 }), "tx-small", { max: w - (qx - x) });
    }

    function sceneIpc(m) {
      var s = m.state, pre = m.pre, post = m.post, step = m.step;
      var c = new Canvas(L("ipc_aria", "Threads, endpoint and notification queues, and what this step moved between them"), m.selected);
      var ch = E.touched(stepOps(step));
      var LW = 270, RX = M + 300, RW = W - 300;
      var y = c.section(M, 1, L("sec_ipc_state", "Threads and the objects they meet at"), m.view === "before" ? L("view_before_note", "as the step found them") : L("view_after_note", "as the step left them"));
      var ly = y, ry = y;
      (s.threads || []).forEach(function (th) {
        var a = E.byId(pre.threads, th.id), b = E.byId(post.threads, th.id);
        var moved = a && b && (ipcState(a) !== ipcState(b) || statusOf(pre, a) !== statusOf(post, b));
        threadChip(c, s, th.id, M, ly, LW, { changed: ch[th.id], right: L("prio_short", "prio {{p}}", { p: th.priority }), sub: threadPhase(s, th), subTone: moved ? "accent" : null });
        ly += 46;
      });
      (s.endpoints || []).forEach(function (ep) {
        var g = c.object(ep.id, ep.name || ep.id, ch[ep.id]);
        c.box(RX, ry, RW, 118, "accent", null, g);
        c.text(RX + 10, ry + 17, kindName("endpoint"), "tx-label", { parent: g, max: 120 });
        c.text(RX + 110, ry + 17, ep.name || ep.id, "tx-title", { parent: g, max: RW - 120 });
        queueRow(c, s, ep.send || [], RX + 10, ry + 26, L("ep_send_queue", "send queue"), ch, RW - 20);
        queueRow(c, s, ep.recv || [], RX + 10, ry + 70, L("ep_recv_queue", "receive queue"), ch, RW - 20);
        ry += 128;
      });
      (s.notifications || []).forEach(function (nt) {
        var g = c.object(nt.id, nt.name || nt.id, ch[nt.id]);
        c.box(RX, ry, RW, 104, "purple", null, g);
        c.text(RX + 10, ry + 17, kindName("notification"), "tx-label", { parent: g, max: 120 });
        c.text(RX + 110, ry + 17, nt.name || nt.id, "tx-title", { parent: g, max: RW - 120 });
        c.text(RX + 10, ry + 42, L("ntfn_word", "pending word"), "tx-small", { parent: g, max: 96 });
        var has = !(nt.pending === null || nt.pending === undefined);
        var bits = bin(has ? nt.pending : 0, 8).split("");
        cells(c, RX + 110, ry + 28, bits, 20, function (i) { return { "data-role": bits[i] === "1" ? "f-extra" : "spent" }; }, g);
        c.text(RX + 284, ry + 42, has ? L("ntfn_latched","active: the next wait returns {{v}} at once", { v: nt.pending }) : L("ntfn_unlatched","nothing latched"), "tx-note", { parent: g, max: RW - 294 });
        queueRow(c, s, nt.waiters || [], RX + 10, ry + 58, L("ntfn_waiters", "waiting"), ch, RW - 20);
        ry += 114;
      });
      (s.replies || []).forEach(function (rp) {
        var g = c.object(rp.id, rp.name || rp.id, ch[rp.id]);
        c.box(RX, ry, RW, 34, rp.caller ? "ok" : "muted", null, g);
        c.text(RX + 10, ry + 21, kindName("reply"), "tx-label", { parent: g, max: 96 });
        c.text(RX + 110, ry + 21, rp.name || rp.id, "tx-title", { parent: g, max: 190 });
        c.text(RX + RW - 10, ry + 21, rp.caller ? L("reply_holds", "holds the reply to {{thread}}", { thread: nameOf(s, rp.caller) }) : L("reply_unused","no caller waiting"), "tx-note", { anchor: "end", parent: g, max: RW - 320 });
        ry += 44;
      });
      y = Math.max(ly, ry) + 10;

      y = c.section(y, 2, L("sec_ipc_moved", "What this step moved"));
      var ops = stepOps(step), drew = false;
      ops.forEach(function (op) {
        if (op.op !== "message") return;
        drew = true;
        threadChip(c, post, op.from, M, y, 190, { sub: L("msg_sender", "sender") });
        threadChip(c, post, op.to, M + W - 190, y, 190, { sub: L("msg_receiver", "receiver") });
        c.line("M" + (M + 194) + "," + (y + 19) + " L" + (M + W - 194) + "," + (y + 19), "accent", { weight: "heavy" });
        var px = M + 230, pw = W - 460;
        c.box(px, y - 2, pw, 42, "accent", { "class": "bx payload" });
        var words = (op.words || []).map(function (wv) { return fmt(wv); }).join(", ");
        c.text(px + pw / 2, y + 14, L("msg_payload", "words [{{words}}] · label {{label}}", { words: words || "—", label: op.label || 0 }), "tx-mono", { anchor: "middle", max: pw - 16 });
        c.text(px + pw / 2, y + 31, (op.badge !== undefined && op.badge !== null ? L("badge_short", "badge {{b}}", { b: op.badge }) + " · " : "") + L("msg_via", "through {{name}}", { name: nameOf(post, op.via) }), "tx-small", { anchor: "middle", max: pw - 16, tone: "purple" });
        y += 52;
        var call = step.syscall;
        if (call && (call.extraCaps || []).length && step.actor === op.from) {
          var rc = E.resolveCap(pre, step.actor, call.capPtr);
          var plan = E.transferPlan(pre, step.actor, rc.cap, op.via, call.extraCaps, op.to);
          if (!plan.granted) {
            c.box(M, y, W, 30, "warn");
            c.text(M + 12, y + 20, L("xfer_no_grant", "The endpoint capability lacks the grant right: no capability travels, and the extra addresses are never looked up."), "tx-note", { max: W - 24, tone: "warn" });
            y += 40;
          }
          plan.results.forEach(function (res) {
            if (res.kind === "installed") {
              capCard(c, pre, res.cap, null, M, y, 230, {});
              c.text(M, y + 76, L("xfer_from", "from {{slot}}", { slot: res.from }), "tx-small", { max: 230 });
              c.line("M" + (M + 234) + "," + (y + 31) + " L" + (M + W - 234) + "," + (y + 31), "purple", { weight: "heavy" });
              c.text(M + W / 2, y + 24, L("xfer_same_cap", "the same capability, installed as a derivation child (ipcTransfer)"), "tx-small", { anchor: "middle", max: W - 490 });
              c.text(M + W / 2, y + 46, L("xfer_slot_used", "the receive slot is used up by it"), "tx-small", { anchor: "middle", max: W - 490 });
              capCard(c, pre, res.cap, null, M + W - 230, y, 230, { tone: "ok" });
              c.text(M + W - 230, y + 76, L("xfer_to", "into {{slot}}", { slot: res.to }), "tx-small", { max: 230, tone: "ok" });
              y += 88;
            } else {
              c.text(M, y + 14, L("xfer_unwrapped", "{{slot}} names the endpoint itself: it is unwrapped to badge {{badge}} instead of being installed.", { slot: res.from, badge: res.badge }), "tx-note", { max: W });
              y += 24;
            }
          });
          if (plan.granted && plan.reason) {
            c.text(M, y + 14, plan.reason === "noReceiveSlot" ? L("xfer_no_slot", "The receiver offers no free receive slot: the transfer stops there.") : plan.reason === "revocationRequired" ? L("xfer_untyped", "An untyped capability with children cannot be transferred: the transfer stops there.") : L("xfer_lookup", "An extra address does not resolve: nothing is transferred."), "tx-note", { max: W, tone: "warn" });
            y += 24;
          }
        }
      });
      (pre.threads || []).forEach(function (a) {
        var b = E.byId(post.threads, a.id);
        if (!b) return;
        var pa = threadPhase(pre, a), pb = threadPhase(post, b);
        if (pa === pb) return;
        drew = true;
        c.text(M, y + 14, nameOf(post, a.id), "tx-title", { max: 190 });
        c.box(M + 200, y, 280, 22, "muted", { "class": "bx cellbox" });
        c.text(M + 340, y + 15, pa, "cell-text", { anchor: "middle", max: 270 });
        c.line("M" + (M + 484) + "," + (y + 11) + " L" + (M + 516) + "," + (y + 11), "accent");
        c.box(M + 520, y, W - 520, 22, "accent", { "class": "bx cellbox" });
        c.text(M + 520 + (W - 520) / 2, y + 15, pb, "cell-text", { anchor: "middle", max: W - 530 });
        y += 28;
      });
      if (!drew) { c.text(M, y + 12, isRefused(step) ? L("ipc_refused", "The step was refused: nothing moved.") : L("ipc_nothing", "No message moved and no thread changed state in this step."), "tx-note", { max: W }); y += 24; }
      c.extend(M + W, y);
      return c;
    }

    /* ── Scene: scheduler ────────────────────────────────────── */

    function schedSub(s, th) {
      var sc = th.sc ? E.byId(s.schedContexts, th.sc) : null;
      if (sc) return L("sched_sc_sub", "budget {{r}}/{{b}} · deadline {{d}}", { r: sc.remaining, b: sc.budget, d: sc.deadline });
      return L("sched_slice_sub", "time slice {{n}}/{{d}}", { n: th.timeSlice === undefined ? E.DEFAULT_TIME_SLICE : th.timeSlice, d: E.DEFAULT_TIME_SLICE });
    }

    function sceneScheduler(m) {
      var s = m.state, step = m.step;
      var c = new Canvas(L("scheduler_aria", "Per-core run queues by priority, scheduling contexts and release queues"), m.selected);
      var ch = E.touched(stepOps(step));
      var y = M, n = 1;
      if (s.time !== undefined) {
        var gk = c.object("clock", L("clock", "clock"), ch.clock);
        c.box(M, y, 150, 28, "accent", null, gk);
        c.text(M + 75, y + 19, L("clock_now", "t = {{t}}", { t: s.time }), "tx-title", { anchor: "middle", parent: gk, max: 140 });
        c.text(M + 164, y + 19, L("clock_note", "kernel time in ticks; only the boot core advances it"), "tx-note", { max: W - 170 });
        y += 40;
      }
      (s.cores || []).forEach(function (co) {
        var pick = E.selectOnCore(s, co.id);
        var verdict = {};
        pick.candidates.forEach(function (r) { verdict[r.thread] = r; });
        y = c.section(y, n++, L("core_n", "Core {{core}}", { core: co.id }), L("core_domain", "active domain {{d}}", { d: co.domain || 0 }));
        var gc = c.object("core:" + co.id, L("core_n", "Core {{core}}", { core: co.id }), ch["core:" + co.id]);
        c.box(M, y, 236, 62, "ok", { "class": "bx cpu" }, gc);
        c.text(M + 10, y + 16, L("cpu_running", "on the CPU"), "tx-label", { parent: gc, max: 200 });
        var cur = co.current !== null && co.current !== undefined ? E.byId(s.threads, co.current) : null;
        if (cur) threadChip(c, s, cur.id, M + 8, y + 20, 220, { changed: ch[cur.id], right: L("prio_short", "prio {{p}}", { p: cur.priority }), sub: schedSub(s, cur) });
        else c.text(M + 118, y + 44, L("core_idle", "idle"), "tx-note", { anchor: "middle", parent: gc });
        /* Buckets, highest priority first; FIFO left to right within one. */
        var rq = (s.runQueues && s.runQueues[String(co.id)]) || [];
        var prios = [];
        rq.forEach(function (e) { if (prios.indexOf(e.prio) === -1) prios.push(e.prio); });
        prios.sort(function (a, b) { return b - a; });
        var bx = M + 256, by = y;
        if (!prios.length) { c.text(bx, by + 36, L("sel_empty", "The run queue is empty."), "tx-note", { max: W - 260 }); by += 62; }
        prios.forEach(function (p) {
          c.box(bx, by, W - 256, 46, p === pick.maxPrio ? "accent" : "muted", { "class": "bx bucket" });
          c.text(bx + 8, by + 18, L("bucket", "priority {{p}}", { p: p }), "tx-label", { max: 84 });
          c.text(bx + 8, by + 34, L("bucket_fifo", "FIFO →"), "tx-small", { max: 84 });
          var tx = bx + 96;
          rq.filter(function (e) { return e.prio === p; }).slice(0, 3).forEach(function (e) {
            var th = E.byId(s.threads, e.thread);
            var v = verdict[e.thread];
            var isNext = pick.thread === e.thread;
            threadChip(c, s, e.thread, tx, by + 4, 170, { changed: ch[e.thread], dim: v && !v.eligible, mark: isNext ? "next" : null, right: isNext ? L("next_mark","next") : null,
              sub: v && !v.eligible ? reasonText(v.reason) : th ? schedSub(s, th) : "", subTone: v && !v.eligible ? "bad" : null });
            tx += 176;
          });
          by += 50;
        });
        y = Math.max(y + 62, by) + 6;
        var rel = (s.releaseQueues && s.releaseQueues[String(co.id)]) || [];
        if (s.releaseQueues) {
          var gr = c.object("release:" + co.id, L("release_queue", "Release queue"), ch["release:" + co.id]);
          c.box(M, y, W, 30, "warn", { "data-ghost": rel.length ? null : "true" }, gr);
          c.text(M + 10, y + 20, L("release_queue", "Release queue"), "tx-label", { parent: gr, max: 130 });
          var qx = M + 150;
          if (!rel.length) c.text(qx, y + 20, L("release_none", "no context is waiting for a refill"), "tx-note", { parent: gr, max: W - 160 });
          rel.forEach(function (id) {
            var sc = E.byId(s.schedContexts, id);
            var key = sc ? E.scReleaseKey(sc) : null;
            c.box(qx, y + 5, 230, 20, "warn", { "class": "bx cellbox" }, gr);
            c.text(qx + 115, y + 19, L("release_entry", "{{name}} · due t = {{t}}", { name: sc ? sc.name || id : id, t: key === null ? "—" : key }), "cell-text", { anchor: "middle", parent: gr, max: 222 });
            qx += 236;
          });
          y += 40;
        }
        if (pick.thread) {
          var pv = verdict[pick.thread];
          c.text(M, y + 10, L("next_pick_line", "If this core chose now it would take {{thread}}: {{why}}.", { thread: nameOf(s, pick.thread), why: rowReason(pv, pick) }), "tx-note", { max: W });
          y += 24;
        }
        y += 4;
      });
      if ((s.schedContexts || []).length) {
        y = c.section(y, n++, L("sec_contexts", "Scheduling contexts"), L("contexts_note", "head refill, then refills still to be released"));
        s.schedContexts.forEach(function (sc) {
          var bound = null;
          (s.threads || []).forEach(function (th) { if (th.sc === sc.id) bound = th; });
          var g = c.object(sc.id, sc.name || sc.id, ch[sc.id]);
          c.box(M, y, W, 44, sc.remaining > 0 ? null : "warn", null, g);
          c.text(M + 10, y + 17, sc.name || sc.id, "tx-title", { parent: g, max: 180 });
          c.text(M + 10, y + 34, L("sc_params", "budget {{b}} per period {{p}}", { b: sc.budget, p: sc.period }) + " · " + L("deadline_short", "deadline {{d}}", { d: sc.deadline }), "tx-small", { parent: g, max: 250 });
          var end = drawRefills(c, sc, M + 276, y + 12, s.time || 0, g);
          c.text(M + W - 10, y + 27, sc.remaining > 0 ? (bound ? L("sc_bound", "runs {{thread}}", { thread: bound.name || bound.id }) : "") : L("sc_exhausted", "exhausted: its thread is ineligible"), "tx-small", { anchor: "end", parent: g, max: Math.max(60, M + W - 20 - end), tone: sc.remaining > 0 ? null : "warn" });
          y += 50;
        });
      }
      c.extend(M + W, y);
      return c;
    }

    /* ── Scene: capability spaces ────────────────────────────── */

    var CARD_W = 208, CARD_GAP = 16;
    var DERIVATION_KEYS = { mint: ["deriv_mint", "minted from"], copy: ["deriv_copy", "copied from"], retype: ["deriv_retype", "retyped from"], ipcTransfer: ["deriv_ipc", "transferred from"], issue: ["deriv_issue", "issued by"] };
    function derivationText(d) { var k = DERIVATION_KEYS[d]; return k ? L(k[0], k[1]) : L("deriv_other", "derived from"); }
    function slotNumbers(cn) { return Object.keys(cn.slots || {}).map(Number).sort(function (a, b) { return a - b; }); }

    function sceneCspace(m) {
      var s = m.state, other = m.view === "before" ? null : m.pre, step = m.step;
      var c = new Canvas(L("cspace_aria", "CNode slots and the capability derivation tree"), m.selected);
      var ch = E.touched(stepOps(step));
      var y = M, n = 1;
      (s.cnodes || []).forEach(function (cn) {
        var shape = cn.irqNode !== undefined ? L("cnode_irq_node", "the kernel's node for interrupt line {{n}}: no capability names it", { n: cn.irqNode })
          : L("cnode_shape_full", "guard {{g}} bits = {{v}} · radix {{r}} bits · {{n}} slots", { g: cn.guardWidth, v: cn.guardValue, r: cn.radixWidth, n: E.slotCount(cn) });
        y = c.section(y, n++, cn.name || cn.id, shape);
        var was = other ? E.byId(other.cnodes, cn.id) : null;
        var nums = slotNumbers(cn);
        if (was) slotNumbers(was).forEach(function (k) { if (nums.indexOf(k) === -1) nums.push(k); });
        nums.sort(function (a, b) { return a - b; });
        if (!nums.length) { y = empty(c, M, y, W, L("cnode_empty", "every slot is empty")) + 12; return; }
        nums.forEach(function (k, i) {
          var col = i % 4, x = M + col * (CARD_W + CARD_GAP);
          if (col === 0 && i) y += 92;
          var key = E.slotKey(cn.id, k);
          var cap = (cn.slots || {})[String(k)];
          var gone = !cap;
          if (gone) cap = was.slots[String(k)];
          var parent = gone ? E.cdtParent(other, key) : E.cdtParent(s, key);
          c.text(x, y + 11, L("slot_n", "slot {{n}}", { n: k }) + (gone ? " · " + L("slot_removed", "removed by this step") : parent ? " · " + derivationText(cap.derivation) + " " + parent : ""), "tx-small", { max: CARD_W, tone: gone ? "bad" : null });
          capCard(c, gone ? other : s, cap, key, x, y + 16, CARD_W, { changed: ch[key], ghost: gone, tone: gone ? "bad" : "accent" });
        });
        y += 100;
      });

      y = c.section(y, n++, L("sec_cdt", "Derivation tree"), L("cdt_note", "revoking a capability removes everything below it and keeps the capability"));
      var cdt = s.cdt || {};
      var roots = Object.keys(cdt).filter(function (k) { return (cdt[k] || []).length && !E.cdtParent(s, k); }).sort();
      if (!roots.length) { c.text(M, y + 12, L("cdt_empty", "No derivation is recorded: every capability here is an original."), "tx-note", { max: W }); y += 26; }
      function node(key, depth, parentY) {
        var cap = E.capAt(s, key);
        var x = M + depth * 30;
        var g = c.object(key, key, ch[key]);
        c.box(x, y, 330, 26, depth ? "accent" : "ok", { "class": "bx tree-node" }, g);
        c.text(x + 9, y + 17, key, "tx-mono", { parent: g, max: 110 });
        c.text(x + 126, y + 17, cap ? kindName(cap.kind) + " → " + capTarget(s, cap) : L("slot_empty", "empty"), "tx-small", { parent: g, max: 150 });
        if (cap) c.text(x + 322, y + 17, rightsText(cap.rights), "right-text", { anchor: "end", parent: g, max: 50 });
        if (depth) {
          c.line("M" + (x - 16) + "," + parentY + " L" + (x - 16) + "," + (y + 13) + " L" + (x - 2) + "," + (y + 13), "accent");
          if (cap) c.text(x + 342, y + 17, derivationText(cap.derivation) + " " + E.cdtParent(s, key), "tx-small", { max: W - (x + 342 - M), tone: "accent" });
        } else c.text(x + 342, y + 17, L("cdt_root", "original"), "tx-small", { max: 200 });
        var myY = y + 26;
        y += 32;
        E.cdtChildren(s, key).forEach(function (k) { node(k, depth + 1, myY); });
      }
      roots.forEach(function (k) { node(k, 0, 0); y += 6; });
      if (other) {
        var lost = [];
        Object.keys(other.cdt || {}).forEach(function (k) {
          (other.cdt[k] || []).forEach(function (kid) { if (!E.cdtParent(s, kid) && lost.indexOf(kid) === -1) lost.push(kid); });
        });
        if (lost.length) {
          c.text(M, y + 12, L("cdt_lost", "Left the tree in this step: {{list}}", { list: lost.join(", ") }), "tx-note", { max: W, tone: "bad" });
          y += 26;
        }
      }
      c.extend(M + W, y);
      return c;
    }

    /* ── Scene: memory ───────────────────────────────────────── */

    var KIND_TONE = { frame: "ok", untyped: "purple", cnode: "accent", endpoint: "accent", notification: "purple", tcb: "warn" };

    function sceneMemory(m) {
      var s = m.state, pre = m.pre, step = m.step;
      var c = new Canvas(L("memory_aria", "Untyped memory to scale and address-space mappings"), m.selected);
      var ch = E.touched(stepOps(step));
      var y = M, n = 1;
      var call = step && step.kind === "syscall" ? step.syscall : null;
      var res = call && call.id === "untypedRetype" ? E.resolveCap(pre, step.actor, call.capPtr) : null;
      (s.untyped || []).forEach(function (ut) {
        y = c.section(y, n++, ut.name || ut.id, L("untyped_extent", "{{size}} at {{base}}", { size: bytes(ut.size), base: hex(ut.base) }));
        var scale = W / ut.size;
        function px(off) { return M + Math.round(off * scale); }
        /* The request this step makes of this region, placed by the engine. */
        var req = null, place = null;
        if (res && res.cap && res.cap.kind === "untyped" && res.cap.target === ut.id) {
          var ci = opIndex(step, "untypedCarve");
          req = ci !== -1 ? stepOps(step)[ci].child : E.retypeRequest(call.args && call.args[0] ? call.args[0].value : 0);
          if (req && req.kind) place = E.carvePlacement(pre, res.slot, { kind: req.kind, size: req.size });
        }
        if (place && place.at !== undefined) {
          var fits = !place.error;
          /* A request that runs past the region is drawn up to its end: the
             note below says how far past it would have gone. */
          var x1 = Math.min(px(place.end), M + W), x0 = Math.min(px(place.at), M + W - 10);
          var wide = x1 - x0 >= 240;
          c.box(x0, y, Math.max(10, x1 - x0), 22, fits ? "ok" : "bad", { "class": "bx request", "data-ghost": fits ? null : "true" });
          c.text(wide ? x0 + 8 : x0 > M + W / 2 ? x0 - 8 : x1 + 8, y + 15, L("carve_request", "request: {{kind}}, {{size}}", { kind: kindName(req.kind), size: bytes(req.size) }), "cell-text", { anchor: !wide && x0 > M + W / 2 ? "end" : null, max: wide ? x1 - x0 - 16 : 300 });
          y += 28;
        }
        var g = c.object(ut.id, ut.name || ut.id, ch[ut.id]);
        c.box(M, y, W, 54, "muted", { "class": "bx region" }, g);
        /* Bytes below a free index that no object occupies were skipped for
           alignment: they stay unusable until the region is reset. */
        var top = 0;
        (s.cnodes || []).forEach(function (cn) { slotNumbers(cn).forEach(function (k) { var cap = cn.slots[String(k)]; if (cap.kind === "untyped" && cap.target === ut.id && (cap.freeIndex || 0) > top) top = cap.freeIndex; }); });
        if (top > 0) g.appendChild(svg("rect", { x: M, y: y, width: px(Math.min(top, ut.size)) - M, height: 54, "class": "hatched" }));
        (ut.children || []).forEach(function (kid) {
          var kx = px(kid.offset), kw = Math.max(6, px(kid.offset + kid.size) - kx - 2);
          var gk = c.object(kid.id, kid.id, ch[kid.id]);
          c.box(kx + 1, y + 3, kw, 48, KIND_TONE[kid.kind] || "accent", { "class": "bx carved" }, gk);
          c.text(kx + 8, y + 22, kid.id, "tx-title", { parent: gk, max: kw - 14 });
          c.text(kx + 8, y + 40, kindName(kid.kind) + " · " + bytes(kid.size), "tx-small", { parent: gk, max: kw - 14 });
        });
        var pages = Math.floor(ut.size / E.PAGE_BYTES);
        if (pages <= 64) for (var p = 0; p <= pages; p++) {
          var tx = px(p * E.PAGE_BYTES);
          c.line("M" + tx + "," + (y + 54) + " L" + tx + "," + (y + 60), "muted", { arrow: false, parent: c.body });
          if (pages <= 8) c.text(Math.min(tx, M + W), y + 73, "+" + hex(p * E.PAGE_BYTES), "tx-small", { anchor: p === 0 ? null : p === pages ? "end" : "middle" });
        }
        y += 82;
        /* Each capability to the region carries its own free index. */
        (s.cnodes || []).forEach(function (cn) {
          slotNumbers(cn).forEach(function (k) {
            var cap = cn.slots[String(k)];
            if (cap.kind !== "untyped" || cap.target !== ut.id) return;
            var key = E.slotKey(cn.id, k);
            var fx = px(Math.min(cap.freeIndex || 0, ut.size));
            var gf = c.object(key, key, ch[key]);
            gf.appendChild(svg("path", { d: "M" + fx + "," + y + " l-6,10 l12,0 z", "class": "marker", "data-tone": "purple" }));
            var right = fx > M + W / 2;
            c.text(right ? fx - 12 : fx + 12, y + 10, L("free_index_of", "{{slot}} · free index {{n}}", { slot: key, n: hex(cap.freeIndex || 0) }), "tx-mono", { anchor: right ? "end" : null, parent: gf, max: 360, tone: "purple" });
            c.text(right ? fx - 12 : fx + 12, y + 25, E.cdtChildren(s, key).length ? L("free_index_live", "the next carve starts here") : L("free_index_reset", "no derivation child: the next carve starts again at 0"), "tx-small", { anchor: right ? "end" : null, parent: gf, max: 360 });
            y += 34;
          });
        });
        if (place) {
          var note;
          if (place.error) note = place.error === "revocationRequired" ? L("carve_needs_revoke", "Refused: the region still records carved objects, and the capability has no derivation child to carry on from.")
            : L("carve_no_room", "Refused: {{size}} at offset {{at}} would end at {{end}}, past the region's {{total}}.", { size: bytes(req.size), at: hex(place.at), end: hex(place.end), total: hex(ut.size) });
          else note = (place.reset ? L("carve_from_zero", "The capability has no derivation child, so the carve starts at 0.") : L("carve_from_index", "The carve starts at the capability's free index, {{from}}.", { from: hex(place.from) }))
            + " " + (place.skipped ? L("carve_aligned_skip", "Rounded up to a {{align}} boundary: {{skip}} skipped, object at {{at}}–{{end}}.", { align: bytes(place.align), skip: bytes(place.skipped), at: hex(place.at), end: hex(place.end) })
              : L("carve_aligned", "Already on a {{align}} boundary: object at {{at}}–{{end}}.", { align: bytes(place.align), at: hex(place.at), end: hex(place.end) }));
          c.text(M, y + 10, note, "tx-note", { max: W, tone: place.error ? "bad" : "ok" });
          y += 26;
        }
        y += 6;
      });

      (s.vspaces || []).forEach(function (vs) {
        y = c.section(y, n++, vs.name || vs.id, L("vspace_asid", "ASID {{n}}", { n: vs.asid }));
        c.text(M + 10, y + 10, L("col_vaddr", "virtual address"), "tx-label", { max: 180 });
        c.text(M + 230, y + 10, L("col_frame", "frame"), "tx-label", { max: 160 });
        c.text(M + 460, y + 10, L("col_perms", "permissions"), "tx-label", { max: 110 });
        c.text(M + 600, y + 10, L("col_tlb", "TLB"), "tx-label", { max: 200 });
        y += 18;
        var rows = (vs.mappings || []).map(function (mp) { return { mp: mp, state: "live" }; });
        if (m.view !== "before") {
          var was = E.byId(pre.vspaces, vs.id);
          ((was && was.mappings) || []).forEach(function (mp) {
            if (!(vs.mappings || []).some(function (x) { return x.vaddr === mp.vaddr; })) rows.push({ mp: mp, state: "gone" });
          });
        }
        stepOps(step).forEach(function (op) { if (op.op === "vspaceReject" && op.vspace === vs.id) rows.push({ mp: { vaddr: op.vaddr, perms: op.perms, frame: null }, state: "refused" }); });
        if (!rows.length) { y = empty(c, M, y, W, L("vspace_empty", "nothing is mapped")) + 6; }
        rows.forEach(function (row) {
          var mp = row.mp, id = vs.id + "@" + mp.vaddr;
          var g = c.object(id, id, ch[id]);
          var live = row.state === "live";
          c.box(M, y, W, 30, live ? null : row.state === "refused" ? "bad" : "muted", { "data-ghost": live ? null : "true" }, g);
          c.text(M + 10, y + 20, String(mp.vaddr), "tx-mono", { parent: g, max: 200 });
          if (mp.frame) { c.line("M" + (M + 150) + "," + (y + 15) + " L" + (M + 222) + "," + (y + 15), live ? "accent" : "muted", { dash: !live, parent: g }); c.text(M + 230, y + 20, String(mp.frame), "tx-title", { parent: g, max: 210 }); }
          var perms = String(mp.perms || "---").split("");
          cells(c, M + 460, y + 5, ["r", "w", "x"], 24, function (i) { return { "data-role": perms[i] && perms[i] !== "-" ? (i === 2 ? "f-extra" : "budget") : "spent" }; }, g);
          var cached = (vs.tlb || []).indexOf(mp.vaddr) !== -1;
          c.text(M + 600, y + 20, row.state === "refused" ? L("map_refused", "refused: writable and executable at once (W^X)") : row.state === "gone" ? L("map_gone", "unmapped by this step; its TLB entry is flushed") : cached ? L("tlb_cached", "translation cached") : L("tlb_uncached", "not cached"), "tx-small", { parent: g, max: W - 610, tone: row.state === "refused" ? "bad" : row.state === "gone" ? "warn" : null });
          y += 34;
        });
        y += 8;
      });
      c.extend(M + W, y);
      return c;
    }

    /* ── Scene: information flow ─────────────────────────────── */

    function sceneInfoflow(m) {
      var s = m.state, pre = m.pre, step = m.step;
      var c = new Canvas(L("infoflow_aria", "The label lattice, the flows the policy admits and this step's checks"), m.selected);
      var ch = E.touched(stepOps(step));
      var y = c.section(M, 1, L("sec_lattice", "Labels, and every flow the policy admits between them"), "securityFlowsTo");
      var BW = 290, BH = 88, X0 = M + 120, GX = 180, GY = 84;
      var top = y + 22;
      function cellX(lb) { return X0 + (lb.integ === "trusted" ? BW + GX : 0); }
      function cellY(lb) { return top + (lb.conf === "high" ? 0 : BH + GY); }
      c.text(X0 + BW / 2, y + 12, L("axis_untrusted", "integrity: untrusted"), "tx-label", { anchor: "middle" });
      c.text(X0 + BW + GX + BW / 2, y + 12, L("axis_trusted", "integrity: trusted"), "tx-label", { anchor: "middle" });
      c.text(M, top + BH / 2 - 4, L("axis_conf", "confidentiality"), "tx-label", { max: 114 });
      c.text(M, top + BH / 2 + 12, L("axis_high", "high"), "tx-title", { max: 114 });
      c.text(M, top + BH + GY + BH / 2 - 4, L("axis_conf", "confidentiality"), "tx-label", { max: 114 });
      c.text(M, top + BH + GY + BH / 2 + 12, L("axis_low", "low"), "tx-title", { max: 114 });
      var labels = s.labels || [];
      var stack = {};
      var pos = {};
      labels.forEach(function (lb) {
        var k = lb.conf + "/" + lb.integ;
        var idx = stack[k] || 0;
        stack[k] = idx + 1;
        pos[lb.id] = { x: cellX(lb) + idx * 10, y: cellY(lb) + idx * 10 };
      });
      function anchor(a, b) {
        var pa = pos[a.id], pb = pos[b.id];
        var ax = pa.x + BW / 2, ay = pa.y + BH / 2, bx = pb.x + BW / 2, by = pb.y + BH / 2;
        var dx = bx - ax, dy = by - ay;
        var sx = dx > 1 ? 1 : dx < -1 ? -1 : 0, sy = dy > 1 ? 1 : dy < -1 ? -1 : 0;
        /* Offset the two directions of a pair so both arrows show. */
        var ox = sy * 9, oy = -sx * 9;
        return "M" + (ax + sx * BW / 2 + ox) + "," + (ay + sy * BH / 2 + oy) + " L" + (bx - sx * BW / 2 + ox) + "," + (by - sy * BH / 2 + oy);
      }
      var checks = stepOps(step).filter(function (op) { return op.op === "flowCheck"; });
      labels.forEach(function (a) {
        labels.forEach(function (b) {
          if (a.id === b.id || !E.flowsTo(a, b)) return;
          c.line(anchor(a, b), "muted");
        });
      });
      checks.forEach(function (op) {
        var a = E.labelOf(pre, op.from), b = E.labelOf(pre, op.to);
        if (!a || !b || a.id === b.id || !pos[a.id] || !pos[b.id]) return;
        var okFlow = E.flowsTo(a, b);
        c.line(anchor(a, b), okFlow ? "ok" : "bad", { weight: "heavy", dash: !okFlow });
      });
      labels.forEach(function (lb) {
        var p = pos[lb.id];
        var g = c.object(lb.id, lb.name || lb.id, ch[lb.id]);
        c.box(p.x, p.y, BW, BH, lb.conf === "high" ? "purple" : "accent", { "class": "bx label-box" }, g);
        c.text(p.x + 10, p.y + 20, lb.name || lb.id, "tx-title", { parent: g, max: BW - 20 });
        c.text(p.x + 10, p.y + 38, L("label_levels", "{{conf}} confidentiality · {{integ}}", { conf: lb.conf === "high" ? L("axis_high", "high") : L("axis_low", "low"), integ: lb.integ === "trusted" ? L("integ_trusted", "trusted") : L("integ_untrusted", "untrusted") }), "tx-small", { parent: g, max: BW - 20 });
        var who = [];
        ["threads", "endpoints", "notifications"].forEach(function (col) { (s[col] || []).forEach(function (o) { if (o.label === lb.id) who.push(o.name || o.id); }); });
        c.text(p.x + 10, p.y + 58, L("label_carriers", "carried by"), "tx-label", { parent: g, max: BW - 20 });
        c.text(p.x + 10, p.y + 75, who.join(", ") || "—", "tx-small", { parent: g, max: BW - 20 });
      });
      y = top + 2 * BH + GY + 24;
      c.text(M, y, L("lattice_rule", "A flow is admitted when confidentiality does not fall and the destination is at least as trusted as the source."), "tx-note", { max: W });
      y += 18;

      y = c.section(y, 2, L("sec_flow_checks", "Flows this step asked the policy about"));
      if (!checks.length) { c.text(M, y + 12, L("flow_none", "This step crossed no label boundary that the policy gates."), "tx-note", { max: W }); y += 26; }
      checks.forEach(function (op) {
        var a = E.labelOf(pre, op.from), b = E.labelOf(pre, op.to);
        var okFlow = E.flowsTo(a, b);
        /* The two halves of the rule, each asked of the engine on its own. */
        var confOk = a && b && E.flowsTo({ conf: a.conf, integ: "untrusted" }, { conf: b.conf, integ: "trusted" });
        var integOk = a && b && E.flowsTo({ conf: "low", integ: a.integ }, { conf: "high", integ: b.integ });
        c.box(M, y, W, 50, okFlow ? "ok" : "bad");
        c.text(M + 10, y + 19, nameOf(pre, op.from) + " → " + nameOf(pre, op.to), "tx-title", { max: 300 });
        c.text(M + 10, y + 38, (a ? a.name || a.id : "?") + " → " + (b ? b.name || b.id : "?"), "tx-small", { max: 300 });
        c.text(M + 330, y + 19, (confOk ? L("flow_conf_ok", "confidentiality does not fall") : L("flow_conf_bad", "confidentiality would fall")), "tx-small", { max: 360, tone: confOk ? "ok" : "bad" });
        c.text(M + 330, y + 38, (integOk ? L("flow_integ_ok", "destination is trusted enough") : L("flow_integ_bad", "a trusted source may not reach an untrusted destination")), "tx-small", { max: 360, tone: integOk ? "ok" : "bad" });
        c.text(M + W - 10, y + 29, okFlow ? L("flow_admitted", "admitted") : L("flow_denied", "denied"), "tx-title", { anchor: "end", max: 160, tone: okFlow ? "ok" : "bad" });
        y += 58;
      });

      y = c.section(y, 3, L("sec_audit", "Declassification audit log"), L("audit_note", "a declassification is recorded; it never edits the policy"));
      var ga = c.object("audit", L("sec_audit", "Declassification audit log"), ch.audit);
      var audit = s.audit || [];
      if (!audit.length) { c.box(M, y, W, 30, "muted", { "data-ghost": "true" }, ga); c.text(M + W / 2, y + 19, L("audit_none","no declassification has been recorded"), "tx-note", { anchor: "middle", parent: ga, max: W - 12 }); y += 36; }
      audit.forEach(function (e, i) {
        c.box(M, y, W, 28, "warn", null, ga);
        c.text(M + 10, y + 18, "#" + (i + 1), "tx-mono", { parent: ga });
        c.text(M + 50, y + 18, L("audit_row","{{actor}} released {{from}} → {{to}} into {{target}} on core {{core}}", { actor: nameOf(s, e.actor), from: nameOf(s, e.from), to: nameOf(s, e.to), target: nameOf(s, e.target), core: e.core }), "tx-note", { parent: ga, max: W - 60 });
        y += 32;
      });
      c.extend(M + W, y);
      return c;
    }

    /* ── Scene: interrupts ───────────────────────────────────── */

    function sceneIrq(m) {
      var s = m.state, step = m.step;
      var c = new Canvas(L("irq_aria", "Interrupt lines, the notifications they signal and the threads those wake"), m.selected);
      var ch = E.touched(stepOps(step));
      var fired = step && step.kind === "interrupt" && step.irq ? step.irq.line : null;
      var y = c.section(M, 1, L("sec_irq_lines", "From a device line to a thread"), L("irq_chain_note", "line → node slot → notification → waiter"));
      y = irqHeads(c, y);
      (s.irqs || []).forEach(function (line) { y = irqRow(c, s, line, y, ch, fired === line.line); });
      var n = 2;
      if (fired !== null) {
        y = c.section(y, n++, L("sec_irq_delivery", "Line {{n}} fired: the delivery, in order", { n: fired }), "handleInterruptOnCore");
        y = irqDeliverySteps(c, m.pre, fired, y);
      }
      y = c.section(y, n++, L("sec_irq_authority", "Who holds authority over the lines"), L("irq_authority_note", "one handler capability per line, issued by the control capability"));
      var i = 0;
      (s.cnodes || []).forEach(function (cn) {
        slotNumbers(cn).forEach(function (k) {
          var cap = cn.slots[String(k)];
          if (cap.kind !== "irqControl" && cap.kind !== "irqHandler") return;
          var col = i % 4, x = M + col * (CARD_W + CARD_GAP);
          if (col === 0 && i) y += 92;
          var key = E.slotKey(cn.id, k);
          c.text(x, y + 11, key, "tx-small", { max: CARD_W });
          capCard(c, s, cap, key, x, y + 16, CARD_W, { changed: ch[key], tone: cap.kind === "irqControl" ? "ok" : "accent" });
          i++;
        });
      });
      if (!i) { c.text(M, y + 12, L("irq_no_caps", "No capability names an interrupt line yet."), "tx-note", { max: W }); y += 26; }
      else y += 92;
      c.extend(M + W, y);
      return c;
    }

    /* ── API ─────────────────────────────────────────────────── */

    var DRAW = { path: scenePath, ipc: sceneIpc, scheduler: sceneScheduler, cspace: sceneCspace, memory: sceneMemory, infoflow: sceneInfoflow, irq: sceneIrq };

    /* The scenes a scenario's state has something to show in. */
    function available(scenario) {
      var s = (scenario && scenario.initialState) || {};
      var out = ["path"];
      if ((s.endpoints || []).length || (s.notifications || []).length || (s.replies || []).length) out.push("ipc");
      if ((s.cores || []).length) out.push("scheduler");
      if ((s.cnodes || []).length) out.push("cspace");
      if ((s.untyped || []).length || (s.vspaces || []).length) out.push("memory");
      if ((s.labels || []).length > 1) out.push("infoflow");
      if ((s.irqs || []).length) out.push("irq");
      return out;
    }

    /* model: { step, pre, post, view: "before" | "after", selected }. The scene
       shows `pre` or `post` by `view`; mechanism panels always read `pre`,
       the state the kernel decided on. */
    function render(id, model) {
      var m = { step: model.step, pre: model.pre, post: model.post, view: model.view === "before" ? "before" : "after", selected: model.selected || "" };
      m.state = m.view === "before" ? m.pre : m.post;
      var c = (DRAW[id] || scenePath)(m);
      var root = c.finish();
      root.setAttribute("data-scene", id);
      return { svg: root, fit: function () { c.fit(); } };
    }

    /* Legend rows: [kind of swatch, tone or role, text]. */
    function legend(id, step) {
      var thread = [["status", "running", L("legend_running", "Running")], ["status", "ready", L("legend_ready", "Ready")], ["status", "blocked", L("legend_blocked", "Blocked")], ["status", "inactive", L("legend_inactive", "Inactive")]];
      var changed = [["changed", "", L("legend_changed", "changed by this step")]];
      var budget = [["role", "budget", L("legend_budget", "budget left")], ["role", "spent", L("legend_spent", "spent")], ["role", "refill", L("legend_refill", "refill waiting")], ["role", "due", L("legend_due", "refill due")]];
      /* The path scene draws a different mechanism per kind of entry: its
         legend names only what that mechanism uses. */
      if (id === "path" && step && step.kind !== "syscall") {
        if (step.kind === "timer") return budget.concat(changed);
        if (step.kind === "interrupt") return legend("irq");
        if (step.kind === "boot") return [];
        return thread.concat(changed);
      }
      switch (id) {
        case "path": return [["tone", "ok", L("legend_pass", "gate passed")], ["tone", "bad", L("legend_fail", "refused here")], ["tone", "muted", L("legend_skip", "not reached")], ["role", "guard", L("legend_guard", "guard bits")], ["role", "radix", L("legend_radix", "slot index bits")]];
        case "ipc": return thread.concat([["tone", "accent", L("kind_endpoint", "endpoint")], ["tone", "purple", L("kind_notification", "notification")]], changed);
        case "scheduler": return thread.concat([["role", "budget", L("legend_budget", "budget left")], ["role", "spent", L("legend_spent", "spent")], ["role", "refill", L("legend_refill", "refill waiting")], ["role", "due", L("legend_due", "refill due")]], changed);
        case "cspace": return [["tone", "accent", L("legend_cap", "capability")], ["tone", "ok", L("cdt_root", "original")], ["ghost", "bad", L("slot_removed", "removed by this step")]].concat(changed);
        case "memory": return [["tone", "ok", L("kind_frame", "frame")], ["tone", "purple", L("kind_untyped", "untyped")], ["hatch", "", L("legend_skipped", "below a free index, unused")], ["ghost", "bad", L("legend_refused", "refused request")]].concat(changed);
        case "infoflow": return [["tone", "muted", L("legend_flow", "admitted flow")], ["tone", "ok", L("legend_flow_ok", "checked and admitted")], ["tone", "bad", L("legend_flow_bad", "checked and denied")]].concat(changed);
        case "irq": return [["tone", "accent", L("irq_signal", "handler issued")], ["tone", "warn", L("irq_masked", "masked")], ["tone", "muted", L("irq_inactive", "no handler issued")]].concat(changed);
        default: return [];
      }
    }

    return { SCENES: SCENES, available: available, render: render, legend: legend, fitText: fitText };
  };
})();
