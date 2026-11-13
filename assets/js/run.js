/**
 * seLe4n Simulator — page controller.
 *
 * Replays kernel scenarios. For every step the page says what the kernel was
 * asked (the narrative), shows the mechanism (a scene, drawn by
 * `assets/js/run-scenes.js`), lists the checked path with each stage's Lean
 * declaration, the effects in order and the state they changed, and names the
 * security properties and invariants that make the step safe.
 *
 * This file decides nothing about the kernel. The fold, the selection, the
 * capability walk, the gates and the invariant mirrors are
 * `assets/js/trace-engine.js` — the same file the validator runs — so the page
 * cannot show a decision the build did not check. Every name is grounded: the
 * sync resolves each `{ name, module }` in the pinned kernel checkout and
 * stamps `path` and `line`; a link is built from those fields only, at
 * `data.sourceRef` (`scripts/lib/trace-anchors.mjs`).
 *
 * Constraints (as on the rest of the site): a plain IIFE, no framework, strict
 * CSP (no inline style or script, no eval). Bundle-only: one fetch of
 * `data/execution-traces.json`, no cache, no other request.
 */
(function () {
  "use strict";

  var E = window.sele4nTraceEngine;

  /* ── i18n ──────────────────────────────────────────────────
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

  var SCENES = (E && typeof window.sele4nRunScenes === "function") ? window.sele4nRunScenes({ engine: E, tt: tt, fmtNum: fmtNum }) : null;

  var REPO = "hatter6822/seLe4n";
  var DATA_ENDPOINT = "data/execution-traces.json";
  var FETCH_OPTIONS = { credentials: "same-origin", cache: "no-cache", redirect: "error" };
  var PLAY_INTERVAL_MS = 2400;
  var ID_RE = /^[A-Za-z0-9_.:@\/-]{1,80}$/;

  var DOM = {};
  function cacheDom() {
    ["theater-status", "theater-stage", "theater-stage-shell", "theater-scenes", "theater-view", "theater-alt", "theater-step-head",
      "guarantee-grid", "guarantee-summary", "invariant-list", "invariant-summary", "scenario-summary", "scenario-properties",
      "theater-provenance", "theater-inspector", "theater-log", "theater-scrubber", "theater-step-label", "scenario-select",
      "theater-play", "theater-prev", "theater-next", "sandbox-toggle", "sandbox-panel", "sandbox-verdict", "theater-source",
      "main-content", "theater-legend", "invariant-details"].forEach(function (id) {
      DOM[id.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] = document.getElementById(id);
    });
  }

  var app = {
    data: null,
    scenario: null,
    scenarioId: "",
    states: [],            /* states[i] = the folded state after step i */
    stepIndex: 0,
    playing: false,
    playTimer: null,
    scene: "",
    view: "after",         /* which side of the step the scene shows */
    selected: "",
    sandbox: false,
    sandboxState: null,    /* a perturbed copy of the trace state (null = the trace) */
    urlScene: "",
    urlObject: ""
  };

  /* ── DOM helpers ─────────────────────────────────────────── */

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
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function setStatus(text, isError) {
    if (!DOM.theaterStatus) return;
    DOM.theaterStatus.textContent = text;
    DOM.theaterStatus.classList.toggle("error", Boolean(isError));
    if (DOM.mainContent) DOM.mainContent.setAttribute("aria-busy", text && !isError ? "true" : "false");
  }

  /* Reveal `item` inside its scroll strip without scrolling the window. */
  function keepWithin(container, item) {
    if (!container || !item || typeof item.getBoundingClientRect !== "function") return;
    try {
      var c = container.getBoundingClientRect();
      var l = item.getBoundingClientRect();
      if (l.left < c.left) container.scrollLeft -= (c.left - l.left) + 8;
      else if (l.right > c.right) container.scrollLeft += (l.right - c.right) + 8;
    } catch (e) { /* not measurable */ }
  }

  /* ── The step on show ────────────────────────────────────── */

  function currentStep() { return app.scenario ? app.scenario.steps[app.stepIndex] : null; }
  function traceState() { return app.states[app.stepIndex] || null; }
  function preState() { return app.states[Math.max(0, app.stepIndex - 1)] || null; }
  /* What the invariants and the scene judge: the perturbed copy, or the trace. */
  function viewState() { return (app.sandbox && app.sandboxState) || traceState(); }
  function stepOps(step) { return (step && step.delta && Array.isArray(step.delta.ops)) ? step.delta.ops : []; }
  function isRefused(step) { return !!(step && step.outcome && step.outcome.status === "error"); }
  function refusingStage(step) {
    var path = (step && step.path) || [];
    for (var i = 0; i < path.length; i++) if (path[i].result === "fail") return path[i];
    return null;
  }
  function availableScenes(sc) { return SCENES ? SCENES.available(sc) : []; }

  var COLLECTIONS = ["threads", "endpoints", "notifications", "replies", "schedContexts", "cnodes", "untyped", "vspaces", "labels"];
  function findAny(s, id) {
    for (var i = 0; i < COLLECTIONS.length; i++) { var o = E.byId(s[COLLECTIONS[i]], id); if (o) return { kind: COLLECTIONS[i], obj: o }; }
    return null;
  }
  function nameOf(s, id) {
    if (id === null || id === undefined) return "—";
    var hit = s ? findAny(s, id) : null;
    return hit && hit.obj.name ? hit.obj.name : String(id);
  }
  var RIGHT_ABBR = { read: "R", write: "W", grant: "G", grantReply: "GR", retype: "RT" };
  function rightsText(rights) { return (rights || []).map(function (r) { return RIGHT_ABBR[r] || r; }).join(" ") || "—"; }
  function bytes(n) {
    n = Number(n) || 0;
    if (n >= 1024 && n % 1024 === 0) return tt("run.kib", "{{n}} KiB", { n: fmtNum(n / 1024) });
    return tt("run.bytes", "{{n}} B", { n: fmtNum(n) });
  }

  function kindLabel(kind) {
    switch (kind) {
      case "boot": return tt("run.kind_boot", "boot");
      case "syscall": return tt("run.kind_syscall", "syscall");
      case "schedule": return tt("run.kind_schedule", "schedule");
      case "timer": return tt("run.kind_timer", "timer");
      case "interrupt": return tt("run.kind_interrupt", "interrupt");
      case "fault": return tt("run.kind_fault", "fault");
      default: return kind || "";
    }
  }
  var STAGE_FALLBACK = { entry: "entry", decode: "decode", lookup: "lookup", type: "type", rights: "rights", args: "arguments", flow: "flow", operation: "operation" };
  function stageName(stage) { return tt("run.stage_" + stage, STAGE_FALLBACK[stage] || stage); }
  function sceneLabel(id) {
    switch (id) {
      case "path": return tt("run.scene_path", "Kernel path");
      case "ipc": return tt("run.scene_ipc", "IPC");
      case "scheduler": return tt("run.scene_scheduler", "Scheduler");
      case "cspace": return tt("run.scene_cspace", "Capabilities");
      case "memory": return tt("run.scene_memory", "Memory");
      case "infoflow": return tt("run.scene_infoflow", "Information flow");
      case "irq": return tt("run.scene_irq", "Interrupts");
      default: return id;
    }
  }

  /* ── Links: stamped fields only ──────────────────────────── */

  var SHA_RE = /^[0-9a-f]{40}$/;
  var LEAN_PATH_RE = /^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.lean$/;
  function sourceHref(ref) {
    var sha = app.data && app.data.sourceRef;
    if (!ref || !SHA_RE.test(String(sha || "")) || !LEAN_PATH_RE.test(String(ref.path || ""))) return "";
    var line = Number(ref.line);
    if (!(line > 0) || Math.floor(line) !== line) return "";
    return "https://github.com/" + REPO + "/blob/" + sha + "/" + ref.path + "#L" + line;
  }
  /* The code map draws production modules only; the testing framework is outside it. */
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

  /* ════════════════════════════════════════════════════════════
     Stage: step header, scene tabs, before/after, scene, legend
     ════════════════════════════════════════════════════════════ */

  function renderStepHead() {
    if (!DOM.theaterStepHead) return;
    clear(DOM.theaterStepHead);
    var step = currentStep();
    if (!step) return;
    var refused = isRefused(step);
    var total = app.scenario.steps.length;
    DOM.theaterStepHead.appendChild(el("div", { "class": "step-meta" }, [
      el("span", { "class": "step-count", text: tt("run.step_of", "Step {{n}} of {{total}}", { n: fmtNum(app.stepIndex + 1), total: fmtNum(total) }) }),
      el("span", { "class": "step-kind", dataset: { kind: step.kind }, text: kindLabel(step.kind) }),
      el("code", { "class": "step-tag", text: step.traceTag }),
      el("span", { "class": "step-outcome", dataset: { outcome: refused ? "error" : "ok" }, text: refused
        ? tt("run.outcome_refused", "refused · {{error}}", { error: step.outcome.error || "" })
        : tt("run.outcome_ok", "completed") }),
      step.actor ? el("span", { "class": "step-actor", text: tt("run.actor", "actor") + ": " + nameOf(preState(), step.actor) }) : null,
      typeof step.core === "number" && (traceState().cores || []).length > 1 ? el("span", { "class": "step-actor", text: tt("run.core", "Core {{n}}", { n: step.core }) }) : null
    ]));
    DOM.theaterStepHead.appendChild(el("h2", { "class": "step-title", id: "theater-step-title", text: step.title }));
    if (step.narrative) DOM.theaterStepHead.appendChild(el("p", { "class": "step-narrative", text: step.narrative }));
  }

  function renderSceneTabs() {
    if (!DOM.theaterScenes) return;
    clear(DOM.theaterScenes);
    availableScenes(app.scenario).forEach(function (id) {
      var active = id === app.scene;
      DOM.theaterScenes.appendChild(el("button", {
        "class": "scene-tab", type: "button", role: "tab", id: "scene-tab-" + id,
        "aria-selected": active ? "true" : "false", "aria-controls": "theater-stage-shell", tabindex: active ? "0" : "-1",
        dataset: { scene: id, active: active ? "true" : "false" },
        text: sceneLabel(id),
        onclick: function () { setScene(id); }
      }));
    });
  }

  /* Before and after are the same picture on the first step and while a
     perturbed copy is on show, so the toggle steps aside there. */
  function viewLocked() { return app.stepIndex <= 0 || !!(app.sandbox && app.sandboxState); }
  function effectiveView() { return viewLocked() ? "after" : app.view; }
  function renderViewToggle() {
    if (!DOM.theaterView || !DOM.theaterView.querySelectorAll) return;
    var buttons = DOM.theaterView.querySelectorAll("[data-view]");
    var locked = viewLocked();
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute("data-view") === effectiveView();
      buttons[i].setAttribute("aria-checked", on ? "true" : "false");
      buttons[i].setAttribute("tabindex", on ? "0" : "-1");
      buttons[i].disabled = locked;
    }
  }

  /* What the step did, in words: the scene's text alternative. */
  function describeStep() {
    var step = currentStep();
    if (!step) return "";
    var parts = [sceneLabel(app.scene) + ".", step.title + "."];
    if (isRefused(step)) parts.push(tt("run.alt_refused", "The kernel refused with {{error}} and changed nothing.", { error: step.outcome.error || "" }));
    var ops = stepOps(step);
    var pre = preState();
    ops.forEach(function (op, i) { parts.push(humanizeOp(stateBefore(pre, ops, i), op) + "."); });
    if (!ops.length && !isRefused(step) && step.kind !== "boot") parts.push(tt("run.no_change", "None: the kernel state after this step equals the state before it."));
    return parts.join(" ");
  }

  function renderStage() {
    if (!DOM.theaterStage) return;
    clear(DOM.theaterStage);
    renderSceneTabs();
    renderViewToggle();
    var step = currentStep();
    if (!SCENES || !step) return;
    var out;
    try {
      out = SCENES.render(app.scene, { step: step, pre: preState(), post: viewState(), view: effectiveView(), selected: app.selected });
    } catch (e) {
      /* A perturbed state can be one no scene was written for; say so. */
      DOM.theaterStage.appendChild(el("p", { "class": "stage-fallback", text: tt("run.scene_unavailable", "This scene cannot draw the state on show.") }));
      return;
    }
    out.svg.setAttribute("aria-describedby", "theater-alt");
    DOM.theaterStage.appendChild(out.svg);
    out.fit();
    if (DOM.theaterStageShell) DOM.theaterStageShell.setAttribute("aria-labelledby", "scene-tab-" + app.scene);
    if (DOM.theaterAlt) DOM.theaterAlt.textContent = describeStep();
    if (DOM.theaterLegend) {
      clear(DOM.theaterLegend);
      SCENES.legend(app.scene, currentStep()).forEach(function (row) {
        DOM.theaterLegend.appendChild(el("li", {}, [el("span", { "class": "swatch", dataset: { swatch: row[0], tone: row[1] } }), row[2]]));
      });
    }
    renderSandboxVerdict();
  }

  function setScene(id) {
    if (availableScenes(app.scenario).indexOf(id) === -1) return;
    app.scene = id;
    renderStage();
    syncUrl();
  }
  function setView(v) {
    if (viewLocked() || (v !== "before" && v !== "after")) return;
    app.view = v;
    renderStage();
    syncUrl();
  }

  /* ════════════════════════════════════════════════════════════
     Guarantees and invariants
     ════════════════════════════════════════════════════════════ */

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
        el("span", { text: prop.label }),
        inStep ? el("span", { "class": "prop-here", text: tt("run.prop_here", "at work in this step") }) : null
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

  /* In the sandbox the engine's mirrors judge the perturbed state. */
  function sandboxViolations() {
    var out = {};
    if (app.sandbox) E.checkState(viewState()).forEach(function (v) { (out[v.id] = out[v.id] || []).push(v.message); });
    return out;
  }

  function renderInvariants() {
    if (!DOM.invariantList) return;
    clear(DOM.invariantList);
    var catalog = (app.data && app.data.invariantCatalog) || [];
    var step = currentStep();
    var preserved = stepPreserved(step);
    var violations = sandboxViolations();
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
     Inspector: checked path · effects · state changes · why it is safe
     ════════════════════════════════════════════════════════════ */

  function queueName(q) { return q === "send" ? tt("run.ep_send_queue", "send queue") : tt("run.ep_recv_queue", "receive queue"); }
  function stateBefore(pre, ops, index) {
    var s = E.clone(pre);
    for (var i = 0; i < index && i < ops.length; i++) E.applyOp(s, ops[i]);
    return s;
  }

  /* One effect in words. `s` is the state the op is applied to. */
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
      case "ntfnPatch": case "replyPatch": {
        var parts = [];
        for (var f in op.set) if (Object.prototype.hasOwnProperty.call(op.set, f)) parts.push(f + " = " + fmtValue(s, op.set[f]));
        return n(op.id) + ": " + parts.join(", ");
      }
      case "clockTick": return tt("run.op_clock", "The clock advances to t = {{t}}", { t: (Number(s.time) || 0) + 1 });
      case "scCharge": case "scRelease": {
        var before = E.byId(s.schedContexts, op.sc);
        var w = E.clone(s);
        E.applyOp(w, op);
        var after = E.byId(w.schedContexts, op.sc);
        return tt(op.op === "scCharge" ? "run.op_sc_charge" : "run.op_sc_release",
          op.op === "scCharge" ? "{{sc}} is charged one tick: {{a}} → {{b}} left" : "{{sc}}'s due refill is released: {{a}} → {{b}} available",
          { sc: n(op.sc), a: before ? before.remaining : "—", b: after ? after.remaining : "—" });
      }
      case "irqPatch": {
        var set = op.set || {};
        if (set.active === true) return tt("run.op_irq_issue", "Line {{n}} now has a handler (IRQSignal)", { n: op.line });
        if (set.active === false) return tt("run.op_irq_retire", "Line {{n}} has no handler any more", { n: op.line });
        return set.masked ? tt("run.op_irq_mask", "Line {{n}} is masked", { n: op.line }) : tt("run.op_irq_unmask", "Line {{n}} is unmasked", { n: op.line });
      }
      case "capInsert": return tt("run.op_cap_insert", "{{slot}} ← {{kind}} → {{target}} [{{rights}}]{{parent}}", { slot: op.slot, kind: op.cap.kind, target: op.cap.kind === "irqHandler" ? tt("run.irq_line_n", "line {{n}}", { n: op.cap.line }) : n(op.cap.target), rights: rightsText(op.cap.rights), parent: op.parent ? " · " + tt("run.child_of", "child of {{p}}", { p: op.parent }) : "" });
      case "capDelete": return tt("run.op_cap_delete", "Delete {{slot}}; its children move up to its parent", { slot: op.slot });
      case "capRevoke": return tt("run.op_cap_revoke", "Revoke everything derived from {{slot}} (the slot stays)", { slot: op.slot });
      case "untypedCarve": return tt("run.op_carve", "Carve {{kind}} {{id}} ({{size}}) from {{ut}}", { kind: op.child.kind, id: op.child.id, size: bytes(op.child.size), ut: n(op.untyped) });
      case "untypedReset": return tt("run.op_reset", "Reset {{ut}}: free index to 0", { ut: n(op.untyped) });
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

  /* Field-level before → after for everything this step changed. */
  function computeDiffRows() {
    if (app.stepIndex <= 0) return [];
    var prev = preState(), next = traceState();
    var rows = [];
    function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function cmp(label, a, b) {
      var keys = {};
      Object.keys(a || {}).concat(Object.keys(b || {})).forEach(function (k) { keys[k] = true; });
      Object.keys(keys).forEach(function (k) {
        if (k === "id" || k === "name" || k === "slots" || k === "line") return;
        var av = a ? a[k] : undefined, bv = b ? b[k] : undefined;
        if (same(av, bv)) return;
        /* A list of records (mappings, refills, carved children) is shown as
           what left it and what joined it, not as two whole lists. */
        if (Array.isArray(av) && Array.isArray(bv) && av.concat(bv).some(function (x) { return x && typeof x === "object"; })) {
          var gone = av.filter(function (x) { return !bv.some(function (y) { return same(x, y); }); });
          var came = bv.filter(function (x) { return !av.some(function (y) { return same(x, y); }); });
          var parts = gone.map(function (x) { return "− " + fmtValue(next, x); }).concat(came.map(function (x) { return "+ " + fmtValue(next, x); }));
          if (parts.length) { rows.push([label, k, parts.join("   ")]); return; }
        }
        rows.push([label, k, fmtValue(next, av === undefined ? null : av) + " → " + fmtValue(next, bv === undefined ? null : bv)]);
      });
    }
    if (prev.time !== next.time) rows.push([tt("run.clock", "clock"), "t", fmtValue(next, prev.time) + " → " + fmtValue(next, next.time)]);
    COLLECTIONS.forEach(function (col) {
      (next[col] || []).forEach(function (b) { cmp(b.name || b.id, E.byId(prev[col], b.id), b); });
    });
    (next.cores || []).forEach(function (c) {
      var a = E.byId(prev.cores, c.id);
      var core = tt("run.core", "Core {{n}}", { n: c.id });
      if (a && a.current !== c.current) rows.push([core, tt("run.running", "running"), nameOf(next, a.current) + " → " + nameOf(next, c.current)]);
      var qa = ((prev.runQueues || {})[String(c.id)] || []).map(function (e) { return e.thread; });
      var qb = ((next.runQueues || {})[String(c.id)] || []).map(function (e) { return e.thread; });
      if (!same(qa, qb)) rows.push([core, tt("run.run_queue_short", "run queue"), fmtValue(next, qa) + " → " + fmtValue(next, qb)]);
      var ra = (prev.releaseQueues || {})[String(c.id)] || [], rb = (next.releaseQueues || {})[String(c.id)] || [];
      if (!same(ra, rb)) rows.push([core, tt("run.release_queue", "Release queue"), fmtValue(next, ra) + " → " + fmtValue(next, rb)]);
    });
    (next.irqs || []).forEach(function (b) { cmp(tt("run.irq_line_n", "line {{n}}", { n: b.line }), E.irqLine(prev, b.line), b); });
    (next.cnodes || []).forEach(function (cn) {
      var a = E.byId(prev.cnodes, cn.id);
      var keys = {};
      Object.keys((a && a.slots) || {}).concat(Object.keys(cn.slots || {})).forEach(function (k) { keys[k] = true; });
      Object.keys(keys).forEach(function (k) {
        var ca = a && a.slots && a.slots[k], cb = cn.slots && cn.slots[k];
        if (same(ca, cb)) return;
        function show(cap) { return cap ? cap.kind + " " + rightsText(cap.rights) + (cap.freeIndex !== undefined ? " · " + tt("run.free_index_short", "free index {{n}}", { n: "0x" + Number(cap.freeIndex).toString(16) }) : "") : "—"; }
        rows.push([(cn.name || cn.id) + " [" + k + "]", tt("run.capability", "capability"), show(ca) + " → " + show(cb)]);
      });
    });
    Object.keys(next.cdt || {}).concat(Object.keys(prev.cdt || {})).filter(function (k, i, arr) { return arr.indexOf(k) === i; }).forEach(function (k) {
      var a = (prev.cdt || {})[k] || [], b = (next.cdt || {})[k] || [];
      if (!same(a, b)) rows.push([k, tt("run.children", "children"), "[" + a.join(", ") + "] → [" + b.join(", ") + "]"]);
    });
    if ((prev.audit || []).length !== (next.audit || []).length) rows.push([tt("run.audit_log", "Declassification audit log"), tt("run.entries", "entries"), (prev.audit || []).length + " → " + (next.audit || []).length]);
    return rows;
  }

  function section(title, cls) { return el("section", { "class": "insp-section" + (cls ? " " + cls : "") }, [el("h3", { text: title })]); }

  function renderInspector() {
    if (!DOM.theaterInspector) return;
    clear(DOM.theaterInspector);
    var step = currentStep();
    if (!step) return;
    var refused = isRefused(step);
    var pre = preState();

    if (app.selected) renderSelectedObject();

    if (step.path && step.path.length) {
      var path = section(tt("run.kernel_path", "Kernel path"));
      if (step.syscall) {
        var sc = step.syscall;
        path.appendChild(el("p", { "class": "insp-syscall" }, [
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
            result === "fail" && step.outcome && step.outcome.error ? el("span", { "class": "path-error" }, [tt("run.returns", "returns") + " ", el("code", { text: "." + step.outcome.error })]) : null,
            result === "skip" ? el("span", { "class": "path-skip", text: tt("run.not_reached", "not reached") }) : null
          ])
        ]));
      });
      path.appendChild(strip);
      DOM.theaterInspector.appendChild(path);
    }

    var ops = stepOps(step);
    var diffRows = computeDiffRows();
    if (step.kind !== "boot") {
      var what = section(tt("run.changes", "State changes"));
      if (refused) what.appendChild(el("p", { "class": "insp-atomic", text: tt("run.atomic_note", "A kernel transition has type σ → Except ε (α × σ): an error carries no state, so a refused call cannot leave a partial change behind.") }));
      if (ops.length) {
        var ul = el("ol", { "class": "insp-effects" });
        ops.forEach(function (op, i) { ul.appendChild(el("li", { dataset: { op: op.op, event: E.EVENT_OPS.indexOf(op.op) !== -1 ? "true" : "false" }, text: humanizeOp(stateBefore(pre, ops, i), op) })); });
        what.appendChild(el("p", { "class": "insp-subhead", text: tt("run.effects", "Effects, in order") }));
        what.appendChild(ul);
      }
      if (diffRows.length) {
        var dlist = el("ul", { "class": "insp-diff" });
        diffRows.forEach(function (r) {
          dlist.appendChild(el("li", {}, [
            el("span", { "class": "diff-entity", text: r[0] }),
            el("span", { "class": "diff-field", text: r[1] }),
            el("span", { "class": "diff-change", text: r[2] })
          ]));
        });
        what.appendChild(el("p", { "class": "insp-subhead", text: tt("run.before_after", "Before → after") }));
        what.appendChild(dlist);
      } else {
        what.appendChild(el("p", { "class": "insp-nochange", text: tt("run.no_change", "None: the kernel state after this step equals the state before it.") }));
      }
      DOM.theaterInspector.appendChild(what);
    } else {
      DOM.theaterInspector.appendChild(el("p", { "class": "insp-boot", text: tt("run.insp_boot", "Nothing has run yet. Step forward to see the path the kernel takes, the state it changes and why that is safe. Select anything in the scene to inspect it.") }));
    }

    var guarantees = stepGuarantees(step);
    var preserved = stepPreserved(step);
    if (guarantees.length || preserved.length) {
      var why = section(tt("run.why_safe", "Why it's safe"), "insp-why");
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

    if (step.sourceRefs && step.sourceRefs.length) {
      var refs = el("ul", { "class": "insp-refs" });
      step.sourceRefs.forEach(function (ref) {
        var map = mapHref(ref.module);
        refs.appendChild(el("li", {}, [
          refLink(ref),
          map ? el("a", { "class": "insp-ref-mod", href: map, title: tt("run.open_in_map", "Open in the code map"), text: ref.module }) : el("span", { "class": "insp-ref-mod", text: ref.module })
        ]));
      });
      var src = section(tt("run.source", "Source"));
      src.appendChild(refs);
      DOM.theaterInspector.appendChild(src);
    }
  }

  function renderSelectedObject() {
    var s = effectiveView() === "before" ? preState() : viewState();
    var id = app.selected;
    var fields = [];
    var title;
    var cap = E.parseSlot(id) && E.capAt(s, id);
    var m;
    if (cap) {
      title = tt("run.capability", "capability") + " · " + id;
      fields.push(["kind", cap.kind], ["target", cap.kind === "irqHandler" ? tt("run.irq_line_n", "line {{n}}", { n: cap.line }) : nameOf(s, cap.target)], ["rights", (cap.rights || []).join(", ") || "—"]);
      if (cap.badge !== undefined && cap.badge !== null) fields.push(["badge", cap.badge]);
      if (cap.freeIndex !== undefined) fields.push([tt("run.free_index_label", "free index"), "0x" + Number(cap.freeIndex).toString(16)]);
      if (cap.derivation) fields.push(["derivation", cap.derivation]);
      fields.push([tt("run.derived_from", "derived from"), E.cdtParent(s, id) || "—"]);
      fields.push([tt("run.children", "children"), E.cdtChildren(s, id).join(", ") || "—"]);
      fields.push([tt("run.descendants", "descendants"), E.cdtDescendants(s, id).length]);
    } else if ((m = /^irq:(\d+)$/.exec(id)) && E.irqLine(s, Number(m[1]))) {
      var line = E.irqLine(s, Number(m[1]));
      var bind = E.irqBinding(s, line.line);
      title = tt("run.irq_line_n", "line {{n}}", { n: line.line }) + " · " + (line.name || "");
      fields.push(["active", String(!!line.active)], ["masked", String(!!line.masked)], [tt("run.irq_signals", "signals"), bind ? nameOf(s, bind.notification) + " · " + tt("run.badge_short", "badge {{b}}", { b: bind.badge }) : "—"]);
    } else if ((m = /^core:(\d+)$/.exec(id)) && E.byId(s.cores, Number(m[1]))) {
      var co = E.byId(s.cores, Number(m[1]));
      title = tt("run.core", "Core {{n}}", { n: co.id });
      fields.push([tt("run.running", "running"), nameOf(s, co.current)], ["domain", co.domain || 0],
        [tt("run.run_queue_short", "run queue"), fmtValue(s, ((s.runQueues || {})[String(co.id)] || []).map(function (e) { return e.thread; }))]);
    } else {
      var hit = findAny(s, id);
      if (!hit) {
        /* An object carved from untyped memory lives in its region's list. */
        (s.untyped || []).forEach(function (u) { (u.children || []).forEach(function (kid) { if (kid.id === id) hit = { kind: "carved", obj: kid }; }); });
      }
      if (!hit) return;
      var o = hit.obj;
      title = o.name || o.id;
      for (var k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k) || k === "name" || k === "slots") continue;
        fields.push([k, fmtValue(s, o[k])]);
      }
      if (hit.kind === "threads") {
        fields.push([tt("run.status", "status"), E.threadStatus(s, o)]);
        var lbl = E.labelOf(s, o.id);
        if (lbl) fields.push([tt("run.security_label", "security label"), lbl.name + " (" + lbl.conf + ", " + lbl.integ + ")"]);
      }
      if (hit.kind === "cnodes") fields.push([tt("run.occupied", "occupied slots"), Object.keys(o.slots || {}).length + " / " + E.slotCount(o)]);
      if (hit.kind === "schedContexts") fields.push([tt("run.release_key", "next release"), E.scReleaseKey(o) === null ? "—" : "t = " + E.scReleaseKey(o)]);
    }
    var dl = el("dl", { "class": "insp-grid" });
    fields.forEach(function (r) { dl.appendChild(el("dt", { text: r[0] })); dl.appendChild(el("dd", {}, [el("code", { text: String(r[1]) })])); });
    var box = section(tt("run.selected", "Selected") + ": " + title, "insp-object");
    box.appendChild(dl);
    box.appendChild(el("button", { "class": "btn btn-secondary insp-clear", type: "button", text: tt("run.clear_selection", "Clear selection"), onclick: function () { selectObject(""); } }));
    DOM.theaterInspector.appendChild(box);
  }

  /* ════════════════════════════════════════════════════════════
     Step strip and transport
     ════════════════════════════════════════════════════════════ */

  function renderLog() {
    if (!DOM.theaterLog) return;
    clear(DOM.theaterLog);
    if (!app.scenario) return;
    var activeChip = null;
    app.scenario.steps.forEach(function (step, i) {
      var active = i === app.stepIndex;
      var chip = el("button", {
        "class": "step-chip", type: "button", title: step.title,
        dataset: { kind: step.kind, active: active ? "true" : "false", outcome: isRefused(step) ? "error" : "ok" },
        onclick: function () { stopPlay(); setStep(i); }
      }, [
        el("span", { "class": "chip-num", text: fmtNum(i + 1) }),
        el("span", { "class": "chip-body" }, [
          el("span", { "class": "chip-kind", text: kindLabel(step.kind) + (isRefused(step) ? " · " + tt("run.result_fail", "refused") : "") }),
          el("span", { "class": "chip-title", text: step.title })
        ])
      ]);
      if (active) { chip.setAttribute("aria-current", "step"); activeChip = chip; }
      DOM.theaterLog.appendChild(el("li", {}, [chip]));
    });
    if (activeChip) keepWithin(DOM.theaterLog, activeChip);
  }

  function render() {
    if (!app.scenario) return;
    renderStepHead();
    renderStage();
    renderInspector();
    renderGuarantees();
    renderInvariants();
    renderLog();
    renderSandboxActions();
    updateTransport();
  }

  function updateTransport() {
    var total = app.scenario ? app.scenario.steps.length : 0;
    if (DOM.theaterScrubber) { DOM.theaterScrubber.max = String(Math.max(0, total - 1)); DOM.theaterScrubber.value = String(app.stepIndex); }
    if (DOM.theaterStepLabel) DOM.theaterStepLabel.textContent = (app.stepIndex + 1) + " / " + total;
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
    app.sandboxState = null;   /* stepping returns the sandbox to the trace */
    app.view = "after";
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
    renderStage();
    renderInspector();
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
    if (!initial) { app.stepIndex = 0; app.view = "after"; }
    app.stepIndex = Math.max(0, Math.min(sc.steps.length - 1, app.stepIndex));
    /* A deep-linked selection survives the first load only. */
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
     Sandbox: perturb a copy, let the engine's mirrors judge it
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

  /* The verdict sits with the scene it is about. */
  function renderSandboxVerdict() {
    if (!DOM.sandboxVerdict) return;
    clear(DOM.sandboxVerdict);
    DOM.sandboxVerdict.hidden = !app.sandbox;
    if (!app.sandbox) return;
    var violations = sandboxViolations();
    var ids = Object.keys(violations);
    DOM.sandboxVerdict.dataset.tone = ids.length ? "bad" : "warn";
    DOM.sandboxVerdict.appendChild(el("p", { "class": "verdict-line", text: !app.sandboxState
      ? tt("run.sb_verdict_idle", "Sandbox on: this is still the trace's state. Pick a perturbation below.")
      : ids.length ? tt("run.sb_verdict_broken", "Perturbed state: {{count}} invariants no longer hold.", { count: ids.length })
        : tt("run.sb_verdict_holds", "Perturbed state: every executable check still passes.") }));
    if (!ids.length) return;
    var list = el("ul", { "class": "verdict-list" });
    ids.forEach(function (id) {
      var inv = invariantById(id);
      list.appendChild(el("li", {}, [
        el("a", { href: "#invariant-" + id, text: inv ? inv.label : id }),
        el("span", { "class": "verdict-why", text: violations[id].join(" · ") })
      ]));
    });
    DOM.sandboxVerdict.appendChild(list);
  }

  function setSandbox(on) {
    app.sandbox = on;
    app.sandboxState = null;
    if (DOM.sandboxPanel) DOM.sandboxPanel.hidden = !on;
    if (DOM.sandboxToggle) { DOM.sandboxToggle.setAttribute("aria-pressed", on ? "true" : "false"); DOM.sandboxToggle.dataset.on = on ? "true" : "false"; }
    /* The sandbox's effect is a broken invariant, so show the list it breaks. */
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
    var out = Object.create(null);   /* a "__proto__" parameter is just a key */
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
    if (effectiveView() === "before") params.push("view=before");
    if (app.selected) params.push("object=" + encodeURIComponent(app.selected));
    if (app.sandbox) params.push("sandbox=1");
    try { window.history.replaceState(null, "", "?" + params.join("&")); } catch (e) { /* file:// or sandboxed */ }
  }

  function applyUrlState() {
    var q = parseQuery();
    if (q.scenario && ID_RE.test(q.scenario)) app.scenarioId = q.scenario;
    if (/^\d{1,4}$/.test(q.step || "")) app.stepIndex = parseInt(q.step, 10);
    if (SCENES && SCENES.SCENES.indexOf(q.scene) !== -1) app.urlScene = q.scene;
    if (q.view === "before") app.view = "before";
    if (q.object && ID_RE.test(q.object)) app.urlObject = q.object;
    if (q.sandbox === "1") app.sandbox = true;
  }

  /* ════════════════════════════════════════════════════════════
     Data loading (bundle-only) and the adoption gate
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
    if (!E || !SCENES) { setStatus(tt("run.offline", "Could not load trace data."), true); return; }
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

  function attrFromEvent(e, name) {
    var node = e.target && e.target.closest && e.target.closest("[" + name + "]");
    return node ? node.getAttribute(name) : "";
  }

  /* A row of options that is one tab stop: the arrow keys move within it. */
  function rove(container, e, ids, current, choose, selector) {
    var i = ids.indexOf(current);
    var next = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : null;
    if (next === null || !ids.length) return;
    e.preventDefault();
    e.stopPropagation();
    choose(ids[(next + ids.length) % ids.length]);
    var on = container.querySelector && container.querySelector(selector);
    if (on) on.focus();
  }

  function wireControls() {
    if (DOM.theaterPlay) DOM.theaterPlay.addEventListener("click", togglePlay);
    if (DOM.theaterPrev) DOM.theaterPrev.addEventListener("click", function () { stopPlay(); setStep(app.stepIndex - 1); });
    if (DOM.theaterNext) DOM.theaterNext.addEventListener("click", function () { stopPlay(); setStep(app.stepIndex + 1); });
    if (DOM.theaterScrubber) DOM.theaterScrubber.addEventListener("input", function () { stopPlay(); setStep(parseInt(DOM.theaterScrubber.value, 10) || 0); });
    if (DOM.scenarioSelect) DOM.scenarioSelect.addEventListener("change", function () { loadScenario(DOM.scenarioSelect.value, false); syncUrl(); });
    if (DOM.sandboxToggle) DOM.sandboxToggle.addEventListener("click", function () { setSandbox(!app.sandbox); });
    /* One delegated handler selects whatever object the scene drew. */
    if (DOM.theaterStage) {
      DOM.theaterStage.addEventListener("click", function (e) { var id = attrFromEvent(e, "data-object"); if (id) selectObject(id); });
      DOM.theaterStage.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        var id = attrFromEvent(e, "data-object");
        if (id) { e.preventDefault(); e.stopPropagation(); selectObject(id); }
      });
    }
    if (DOM.theaterScenes) {
      DOM.theaterScenes.addEventListener("keydown", function (e) {
        rove(DOM.theaterScenes, e, availableScenes(app.scenario), app.scene, setScene, '[data-active="true"]');
      });
    }
    if (DOM.theaterView) {
      DOM.theaterView.addEventListener("click", function (e) { var v = attrFromEvent(e, "data-view"); if (v) setView(v); });
      DOM.theaterView.addEventListener("keydown", function (e) {
        if (viewLocked()) return;
        rove(DOM.theaterView, e, ["before", "after"], effectiveView(), setView, '[aria-checked="true"]');
      });
    }
    /* Following a link to an invariant opens the catalogue that holds it. */
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href^="#invariant-"]');
      if (a && DOM.invariantDetails && !DOM.invariantDetails.open) DOM.invariantDetails.open = true;
    });
    if (DOM.sandboxPanel) {
      DOM.sandboxPanel.addEventListener("click", function (e) {
        var kind = attrFromEvent(e, "data-perturb");
        if (kind) { perturb(kind); return; }
        if (e.target.closest && e.target.closest("[data-sandbox-reset]")) { app.sandboxState = null; render(); }
      });
    }
    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target && e.target.closest && e.target.closest("[data-object]")) return;
      /* A focused control keeps the keys that are its own: Space and Enter
         press it, and a tab list or radio group roves on the arrows. The
         step keys still work from the transport button just clicked. */
      var control = tag === "BUTTON" || tag === "A" || tag === "SUMMARY";
      if (control && (e.key === " " || e.key === "Enter")) return;
      if (e.target && e.target.closest && e.target.closest("#nav, footer")) return;
      if (e.target && e.target.closest && e.target.closest('[role="tablist"], [role="radiogroup"]') && /^(Arrow|Home|End)/.test(e.key)) return;
      /* The stage scrolls sideways on a narrow screen: its arrows are its own. */
      var inStage = e.target && e.target.closest && e.target.closest("#theater-stage-shell");
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowRight" && !inStage) { stopPlay(); setStep(app.stepIndex + 1); }
      else if (e.key === "ArrowLeft" && !inStage) { stopPlay(); setStep(app.stepIndex - 1); }
      else if (e.key === "Home" && !inStage) { stopPlay(); setStep(0); }
      else if (e.key === "End" && !inStage) { stopPlay(); setStep(app.scenario ? app.scenario.steps.length - 1 : 0); }
      else if (e.key === "b" || e.key === "B") setView("before");
      else if (e.key === "a" || e.key === "A") setView("after");
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
