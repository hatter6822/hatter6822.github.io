(function () {
  "use strict";

  var REPO = "hatter6822/seLe4n";
  var REF = "main";
  var API = "https://api.github.com/repos/" + REPO;
  var RAW = "https://raw.githubusercontent.com/" + REPO + "/" + REF + "/";

  var FETCH_OPTIONS = {
    credentials: "omit",
    cache: "no-store",
    mode: "cors",
    redirect: "error",
    referrerPolicy: "no-referrer"
  };

  var CACHE_KEY = "sele4n-code-map-v5";
  var CACHE_TTL_MS = 60 * 60 * 1000;
  var FETCH_CONCURRENCY = 8;
  var FETCH_TIMEOUT_MS = 9000;
  var NODE_CACHE = Object.create(null);

  var state = {
    files: [], directories: [], modules: [], moduleMap: Object.create(null), moduleMeta: Object.create(null),
    importsTo: Object.create(null), importsFrom: Object.create(null), externalImportsFrom: Object.create(null),
    theoremPairs: [], selectedModule: null, selectedPair: null, activeFilterText: "", activeLayerFilter: "all", activeSort: "hotspot",
    trail: [], selectedLens: "summary", neighborLimit: 12
  };

  function setStatus(text, isError) {
    var el = document.getElementById("map-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", Boolean(isError));
  }

  function updateMetric(key, value) {
    var els = NODE_CACHE[key];
    if (!els) {
      els = document.querySelectorAll('[data-map="' + key + '"]');
      NODE_CACHE[key] = els;
    }
    for (var i = 0; i < els.length; i++) els[i].textContent = String(value);
  }

  function safeFetch(url, asText) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    var opts = ctrl ? Object.assign({}, FETCH_OPTIONS, { signal: ctrl.signal }) : FETCH_OPTIONS;

    return fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return asText ? res.text() : res.json();
    }).catch(function (error) {
      if (timer) clearTimeout(timer);
      throw error;
    });
  }

  function sanitizeModuleName(value) {
    return /^[A-Za-z0-9_.]+$/.test(value) ? value : "";
  }

  function moduleFromPath(path) {
    return path.replace(/\.lean$/, "").replace(/\//g, ".");
  }

  function classifyLayer(moduleName) {
    if (/\.Model\./.test(moduleName)) return "model";
    if (/\.Kernel\./.test(moduleName)) return "kernel";
    if (/\.Security\./.test(moduleName) || /\.IFC\./.test(moduleName)) return "security";
    if (/\.Platform\./.test(moduleName) || /\.Hardware\./.test(moduleName)) return "platform";
    return "other";
  }

  function moduleKind(moduleName) {
    if (/\.Operations$/.test(moduleName)) return "operations";
    if (/\.Invariant$/.test(moduleName)) return "invariant";
    return "other";
  }

  function moduleBase(moduleName) {
    return moduleName.replace(/\.(Operations|Invariant)$/, "");
  }

  function theoremCount(text) {
    var matches = text.match(/^\s*(?:theorem|lemma)\s+[\w'.`]+/gm);
    return matches ? matches.length : 0;
  }

  function parseModule(name, sourceText) {
    var lines = sourceText.split(/\r?\n/);
    var seenInternal = Object.create(null);
    var seenExternal = Object.create(null);
    var imports = [];
    var external = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf("import ") !== 0) continue;
      var depLine = line.slice(7).split("--")[0].trim();
      if (!depLine) continue;
      var deps = depLine.split(/\s+/);
      for (var j = 0; j < deps.length; j++) {
        var dep = sanitizeModuleName(deps[j]);
        if (!dep) continue;
        if (Object.prototype.hasOwnProperty.call(state.moduleMap, dep)) {
          if (!seenInternal[dep]) {
            seenInternal[dep] = true;
            imports.push(dep);
          }
        } else if (!seenExternal[dep]) {
          seenExternal[dep] = true;
          external.push(dep);
        }
      }
    }

    state.importsFrom[name] = imports;
    state.externalImportsFrom[name] = external;
    for (var k = 0; k < imports.length; k++) {
      if (!state.importsTo[imports[k]]) state.importsTo[imports[k]] = [];
      state.importsTo[imports[k]].push(name);
    }

    state.moduleMeta[name] = {
      layer: classifyLayer(name),
      kind: moduleKind(name),
      base: moduleBase(name),
      theorems: theoremCount(sourceText)
    };
  }

  function moduleDegree(name) {
    var incoming = (state.importsTo[name] || []).length;
    var outgoing = (state.importsFrom[name] || []).length;
    var theorems = (state.moduleMeta[name] || {}).theorems || 0;
    var score = incoming * 2 + outgoing + theorems * 3;
    return { incoming: incoming, outgoing: outgoing, total: incoming + outgoing, theorems: theorems, score: score };
  }

  function appendList(panel, title, items, limit) {
    var h = document.createElement("h3");
    h.className = "section-title-sm";
    h.textContent = title;
    panel.appendChild(h);

    var ul = document.createElement("ul");
    ul.className = "detail-list";
    var max = Math.min(items.length, limit || items.length);

    if (!items.length) {
      var empty = document.createElement("li");
      empty.textContent = "(none)";
      ul.appendChild(empty);
    } else {
      for (var i = 0; i < max; i++) {
        var li = document.createElement("li");
        li.textContent = items[i];
        ul.appendChild(li);
      }
      if (items.length > max) {
        var more = document.createElement("li");
        more.textContent = "… and " + (items.length - max) + " more";
        ul.appendChild(more);
      }
    }

    panel.appendChild(ul);
  }

  function relatedProofModules(name) {
    var base = moduleBase(name);
    var out = [];
    var ops = base + ".Operations";
    var inv = base + ".Invariant";
    if (state.moduleMap[ops] && ops !== name) out.push(ops);
    if (state.moduleMap[inv] && inv !== name) out.push(inv);
    return out;
  }

  function filteredModules() {
    var q = state.activeFilterText.trim().toLowerCase();
    var layer = state.activeLayerFilter;
    return state.modules.filter(function (name) {
      var meta = state.moduleMeta[name] || {};
      var path = state.moduleMap[name] || "";
      if (layer !== "all" && meta.layer !== layer) return false;
      if (!q) return true;
      return name.toLowerCase().indexOf(q) !== -1 || path.toLowerCase().indexOf(q) !== -1;
    });
  }

  function sortModules(list) {
    list.sort(function (a, b) {
      if (state.activeSort === "name") return a.localeCompare(b);
      if (state.activeSort === "theorems") {
        var theoremDiff = moduleDegree(b).theorems - moduleDegree(a).theorems;
        return theoremDiff || moduleDegree(b).score - moduleDegree(a).score;
      }
      var scoreDiff = moduleDegree(b).score - moduleDegree(a).score;
      return scoreDiff || a.localeCompare(b);
    });
  }

  function rememberTrail(name) {
    if (!name) return;
    if (state.trail[state.trail.length - 1] === name) return;
    state.trail.push(name);
    if (state.trail.length > 10) state.trail.shift();
  }

  function selectModule(name, fromTrail) {
    if (!name || !state.moduleMap[name]) return;
    state.selectedModule = name;
    if (!fromTrail) rememberTrail(name);
    renderDetails(name);
    syncUrlState();
    renderAll();
  }

  function computeContextShift(name) {
    if (state.trail.length < 2) return null;
    var previous = state.trail[state.trail.length - 2];
    if (!previous || previous === name) return null;
    var previousImports = state.importsFrom[previous] || [];
    var currentImports = state.importsFrom[name] || [];
    var shared = currentImports.filter(function (item) { return previousImports.indexOf(item) !== -1; });
    var newDeps = currentImports.filter(function (item) { return previousImports.indexOf(item) === -1; });
    return { previous: previous, shared: shared, newDeps: newDeps };
  }

  function renderDetails(name) {
    var panel = document.getElementById("details-panel");
    if (!panel || !name) return;

    var meta = state.moduleMeta[name] || {};
    var degree = moduleDegree(name);
    var modulePath = state.moduleMap[name] || "Unknown";
    var coupling = degree.incoming * degree.outgoing;
    var shift = computeContextShift(name);

    panel.innerHTML = "<h2 class=\"section-title-sm\">Context drawer</h2>";

    var title = document.createElement("p");
    title.className = "core-name";
    title.textContent = name;
    panel.appendChild(title);

    var grid = document.createElement("div");
    grid.className = "metric-grid";
    var metrics = [
      ["Layer", meta.layer || "other"],
      ["Kind", meta.kind || "other"],
      ["Theorems", String(degree.theorems)],
      ["Hotspot", String(degree.score)],
      ["Fan-in", String(degree.incoming)],
      ["Coupling", String(coupling)]
    ];

    for (var i = 0; i < metrics.length; i++) {
      var box = document.createElement("div");
      box.className = "metric-box";
      box.innerHTML = "<span></span><strong></strong>";
      box.children[0].textContent = metrics[i][0];
      box.children[1].textContent = metrics[i][1];
      grid.appendChild(box);
    }
    panel.appendChild(grid);

    var pathNode = document.createElement("p");
    pathNode.className = "panel-note";
    pathNode.textContent = "Path: " + modulePath;
    panel.appendChild(pathNode);

    if (shift) {
      var shiftNode = document.createElement("p");
      shiftNode.className = "panel-note";
      shiftNode.textContent = "Shift from " + shift.previous + ": shared dependencies=" + shift.shared.length + ", new dependencies=" + shift.newDeps.length + ".";
      panel.appendChild(shiftNode);
    }

    appendList(panel, "Proof neighbors", relatedProofModules(name), 4);
    appendList(panel, "Imports (inner band)", state.importsFrom[name] || [], 10);
    appendList(panel, "Imported by (outer band)", state.importsTo[name] || [], 10);
    appendList(panel, "External imports", state.externalImportsFrom[name] || [], 8);
  }

  function renderWalkCards() {
    var wrap = document.getElementById("graph-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    var list = filteredModules();
    sortModules(list);

    if (!list.length) {
      wrap.textContent = "No modules matched the current filters.";
      return;
    }

    var limit = Math.min(list.length, 110);
    for (var i = 0; i < limit; i++) {
      var name = list[i];
      var meta = state.moduleMeta[name] || {};
      var degree = moduleDegree(name);
      var card = document.createElement("button");
      card.type = "button";
      card.className = "walk-card" + (state.selectedModule === name ? " selected" : "");

      var h = document.createElement("h3");
      h.textContent = name;
      var info = document.createElement("p");
      info.className = "walk-meta";
      info.textContent = meta.layer + " · " + meta.kind + " · thm=" + degree.theorems;
      var score = document.createElement("p");
      score.className = "walk-score";
      score.textContent = "score=" + degree.score + " in=" + degree.incoming + " out=" + degree.outgoing;

      card.appendChild(h);
      card.appendChild(info);
      card.appendChild(score);
      card.addEventListener("click", (function (moduleName) {
        return function () { selectModule(moduleName, false); };
      })(name));
      wrap.appendChild(card);
    }
  }

  function createPill(moduleName, mode) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "dep-pill" + (mode === "out" ? " imported-by" : "");
    button.textContent = moduleName;
    button.addEventListener("click", function () { selectModule(moduleName, false); });
    return button;
  }

  function renderConstellation() {
    var wrap = document.getElementById("constellation-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";
    var selected = state.selectedModule;

    if (!selected) {
      wrap.textContent = "Select a module to render local relationship bands.";
      return;
    }

    var degree = moduleDegree(selected);
    var core = document.createElement("div");
    core.className = "constellation-core";
    core.innerHTML = "<p class=\"core-name\"></p><p class=\"panel-note\"></p>";
    core.children[0].textContent = selected;
    core.children[1].textContent = "fan-in=" + degree.incoming + " · fan-out=" + degree.outgoing + " · theorem-density=" + degree.theorems;
    wrap.appendChild(core);

    function renderBand(title, modules, mode) {
      var band = document.createElement("div");
      band.className = "band";
      var titleNode = document.createElement("p");
      titleNode.className = "band-title";
      titleNode.textContent = title;
      band.appendChild(titleNode);

      var row = document.createElement("div");
      row.className = "pill-row";
      var slice = modules.slice(0, state.neighborLimit);
      if (!slice.length) {
        var empty = document.createElement("span");
        empty.className = "panel-note";
        empty.textContent = "None";
        row.appendChild(empty);
      } else {
        for (var i = 0; i < slice.length; i++) row.appendChild(createPill(slice[i], mode));
      }
      band.appendChild(row);
      wrap.appendChild(band);
    }

    renderBand("Imported modules", state.importsFrom[selected] || [], "in");
    renderBand("Importing modules", state.importsTo[selected] || [], "out");
  }

  function recommendNextModules() {
    var selected = state.selectedModule;
    if (!selected) return [];

    var neighborPool = (state.importsFrom[selected] || []).concat(state.importsTo[selected] || []).concat(relatedProofModules(selected));
    var unique = [];
    var seen = Object.create(null);

    for (var i = 0; i < neighborPool.length; i++) {
      var candidate = neighborPool[i];
      if (!candidate || seen[candidate] || candidate === selected) continue;
      seen[candidate] = true;
      unique.push(candidate);
    }

    unique.sort(function (a, b) {
      return moduleDegree(b).score - moduleDegree(a).score || a.localeCompare(b);
    });

    return unique.slice(0, 6);
  }

  function renderTrail() {
    var wrap = document.getElementById("trail-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    if (!state.trail.length) {
      wrap.textContent = "Start selecting modules to build a contextual walk.";
      return;
    }

    for (var i = 0; i < state.trail.length; i++) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "trail-chip";
      chip.textContent = (i + 1) + ". " + state.trail[i];
      chip.addEventListener("click", (function (moduleName) {
        return function () { selectModule(moduleName, true); };
      })(state.trail[i]));
      wrap.appendChild(chip);
    }
  }

  function renderRecommendations() {
    var wrap = document.getElementById("recommend-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    var recs = recommendNextModules();
    if (!recs.length) {
      wrap.textContent = "No local recommendations available.";
      return;
    }

    for (var i = 0; i < recs.length; i++) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "trail-chip";
      chip.textContent = recs[i];
      chip.addEventListener("click", (function (moduleName) {
        return function () { selectModule(moduleName, false); };
      })(recs[i]));
      wrap.appendChild(chip);
    }
  }

  function lensSummary(panel, selected) {
    var degree = moduleDegree(selected);
    var related = relatedProofModules(selected);
    var lines = [
      "Hotspot score = " + degree.score + " (2×fan-in + fan-out + 3×theorems).",
      "Proof-adjacent modules = " + related.length + ".",
      "External imports = " + (state.externalImportsFrom[selected] || []).length + "."
    ];
    for (var i = 0; i < lines.length; i++) {
      var p = document.createElement("p");
      p.className = "lens-metric";
      p.textContent = lines[i];
      panel.appendChild(p);
    }
  }

  function lensDependencies(panel, selected) {
    var importers = state.importsTo[selected] || [];
    var imports = state.importsFrom[selected] || [];
    var highRisk = importers.concat(imports).sort(function (a, b) {
      return moduleDegree(b).score - moduleDegree(a).score;
    }).slice(0, 5);

    var p = document.createElement("p");
    p.className = "lens-metric";
    p.textContent = "Highest-impact adjacent modules:";
    panel.appendChild(p);

    var row = document.createElement("div");
    row.className = "pill-row";
    for (var i = 0; i < highRisk.length; i++) row.appendChild(createPill(highRisk[i], "in"));
    if (!highRisk.length) row.textContent = "No adjacent modules.";
    panel.appendChild(row);
  }

  function lensProof(panel, selected) {
    var related = relatedProofModules(selected);
    var base = moduleBase(selected);
    var pair = null;
    for (var i = 0; i < state.theoremPairs.length; i++) {
      if (state.theoremPairs[i].base === base) {
        pair = state.theoremPairs[i];
        break;
      }
    }

    var p = document.createElement("p");
    p.className = "lens-metric";
    if (!pair) p.textContent = "No Operations/Invariant pair detected for this module base.";
    else p.textContent = "Proof pair status: theorems=" + (pair.operationsTheorems + pair.invariantTheorems) + ", linked=" + (pair.invariantImportsOperations ? "yes" : "no") + ".";
    panel.appendChild(p);

    var row = document.createElement("div");
    row.className = "pill-row";
    for (var j = 0; j < related.length; j++) row.appendChild(createPill(related[j], "out"));
    if (!related.length) row.textContent = "No proof-neighbor modules.";
    panel.appendChild(row);
  }

  function renderLensPanel() {
    var panel = document.getElementById("lens-panel");
    if (!panel) return;
    panel.innerHTML = "";

    if (!state.selectedModule) {
      panel.textContent = "Select a module to activate context lenses.";
      return;
    }

    if (state.selectedLens === "summary") lensSummary(panel, state.selectedModule);
    else if (state.selectedLens === "dependencies") lensDependencies(panel, state.selectedModule);
    else lensProof(panel, state.selectedModule);
  }

  function renderModuleTable() {
    var tbody = document.getElementById("module-rows");
    if (!tbody) return;
    tbody.innerHTML = "";
    var list = filteredModules();
    sortModules(list);

    for (var i = 0; i < list.length; i++) {
      var name = list[i];
      var meta = state.moduleMeta[name] || {};
      var degree = moduleDegree(name);

      var tr = document.createElement("tr");
      tr.setAttribute("data-module", name);
      if (state.selectedModule === name) tr.className = "selected-row";
      tr.innerHTML = "<td></td><td></td><td></td><td></td><td></td>";
      tr.children[0].textContent = name;
      tr.children[1].textContent = meta.layer || "other";
      tr.children[2].textContent = String(degree.theorems);
      tr.children[3].textContent = String(degree.incoming);
      tr.children[4].textContent = String(degree.outgoing);
      tr.addEventListener("click", (function (moduleName) {
        return function () { selectModule(moduleName, false); };
      })(name));
      tbody.appendChild(tr);
    }
  }

  function renderProofTrace() {
    var panel = document.getElementById("proof-trace-panel");
    if (!panel) return;
    panel.innerHTML = "<h2 class=\"section-title-sm\">Proof trace explainer</h2>";

    if (!state.selectedPair) {
      var hint = document.createElement("p");
      hint.className = "panel-note";
      hint.textContent = "Select a row in the proof relationship table to display a guided trace.";
      panel.appendChild(hint);
      return;
    }

    var pair = state.selectedPair;
    var p1 = document.createElement("p");
    p1.className = "panel-note";
    p1.textContent = "Subsystem: " + pair.base;
    panel.appendChild(p1);

    var p2 = document.createElement("p");
    p2.className = "panel-note";
    p2.textContent = "Operations theorems=" + pair.operationsTheorems + ", Invariant theorems=" + pair.invariantTheorems + ", linked=" + (pair.invariantImportsOperations ? "yes" : "no");
    panel.appendChild(p2);

    var steps = [];
    if (pair.operationsModule) steps.push("1) Start with " + pair.operationsModule + " to inspect executable transitions.");
    if (pair.invariantModule) steps.push("2) Move to " + pair.invariantModule + " and validate proof obligations.");
    steps.push("3) Use recommendations to continue outward through supporting assumptions.");
    appendList(panel, "Walkthrough steps", steps, steps.length);
  }

  function buildPairs() {
    var groups = Object.create(null);
    var totals = { theorems: 0, pairs: 0, linked: 0, importEdges: 0 };

    for (var i = 0; i < state.modules.length; i++) {
      var name = state.modules[i];
      var meta = state.moduleMeta[name] || {};
      totals.theorems += meta.theorems || 0;
      totals.importEdges += (state.importsFrom[name] || []).length;
      if (meta.kind !== "operations" && meta.kind !== "invariant") continue;
      if (!groups[meta.base]) groups[meta.base] = {};
      groups[meta.base][meta.kind] = name;
    }

    var pairs = [];
    for (var base in groups) {
      var ops = groups[base].operations || "";
      var inv = groups[base].invariant || "";
      if (!ops && !inv) continue;
      var linked = ops && inv && (state.importsFrom[inv] || []).indexOf(ops) !== -1;
      pairs.push({
        base: base,
        operationsModule: ops,
        invariantModule: inv,
        operationsTheorems: ops && state.moduleMeta[ops] ? state.moduleMeta[ops].theorems : 0,
        invariantTheorems: inv && state.moduleMeta[inv] ? state.moduleMeta[inv].theorems : 0,
        invariantImportsOperations: Boolean(linked)
      });
    }

    pairs.sort(function (a, b) {
      var diff = (b.operationsTheorems + b.invariantTheorems) - (a.operationsTheorems + a.invariantTheorems);
      return diff || a.base.localeCompare(b.base);
    });

    for (var j = 0; j < pairs.length; j++) if (pairs[j].invariantImportsOperations) totals.linked += 1;
    totals.pairs = pairs.length;

    state.theoremPairs = pairs;
    updateMetric("files", state.files.length);
    updateMetric("leanModules", state.modules.length);
    updateMetric("importEdges", totals.importEdges);
    updateMetric("theorems", totals.theorems);
    updateMetric("proofPairs", totals.pairs);
    updateMetric("linkedPairs", totals.linked);
  }

  function renderProofTable() {
    var tbody = document.getElementById("proof-rows");
    if (!tbody) return;
    tbody.innerHTML = "";

    for (var i = 0; i < state.theoremPairs.length; i++) {
      var pair = state.theoremPairs[i];
      var tr = document.createElement("tr");
      var columns = [
        pair.base,
        pair.operationsModule || "—",
        pair.invariantModule || "—",
        String(pair.operationsTheorems + pair.invariantTheorems),
        pair.invariantImportsOperations ? "Linked" : "Check"
      ];

      for (var c = 0; c < columns.length; c++) {
        var td = document.createElement("td");
        td.textContent = columns[c];
        if (c === 4) td.className = pair.invariantImportsOperations ? "proof-good" : "proof-warn";
        tr.appendChild(td);
      }

      tr.addEventListener("click", (function (selectedPair) {
        return function () {
          state.selectedPair = selectedPair;
          if (selectedPair.operationsModule) selectModule(selectedPair.operationsModule, false);
          renderProofTrace();
        };
      })(pair));

      tbody.appendChild(tr);
    }
  }

  function renderDirectoryTree() {
    var wrap = document.getElementById("tree-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    var root = { children: Object.create(null), files: [] };
    for (var i = 0; i < state.files.length; i++) {
      var parts = state.files[i].split("/");
      var node = root;
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        if (j === parts.length - 1) node.files.push(part);
        else {
          if (!node.children[part]) node.children[part] = { children: Object.create(null), files: [] };
          node = node.children[part];
        }
      }
    }

    function renderNode(name, node, depth) {
      var details = document.createElement("details");
      if (depth < 1) details.open = true;
      var summary = document.createElement("summary");
      summary.textContent = name;
      details.appendChild(summary);

      var folders = Object.keys(node.children).sort();
      for (var f = 0; f < folders.length; f++) details.appendChild(renderNode(folders[f], node.children[folders[f]], depth + 1));

      node.files.sort();
      for (var k = 0; k < node.files.length; k++) {
        var leaf = document.createElement("div");
        leaf.className = "tree-leaf";
        leaf.textContent = node.files[k];
        details.appendChild(leaf);
      }
      return details;
    }

    var top = Object.keys(root.children).sort();
    for (var t = 0; t < top.length; t++) wrap.appendChild(renderNode(top[t], root.children[top[t]], 0));
  }

  function renderAll() {
    renderWalkCards();
    renderConstellation();
    renderLensPanel();
    renderTrail();
    renderRecommendations();
    renderModuleTable();
    renderProofTable();
    renderProofTrace();
  }

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
      var rel = links[i].getAttribute("rel") || "";
      var tokens = rel.split(/\s+/).filter(Boolean);
      if (tokens.indexOf("noopener") === -1) tokens.push("noopener");
      if (tokens.indexOf("noreferrer") === -1) tokens.push("noreferrer");
      links[i].setAttribute("rel", tokens.join(" "));
    }
  }

  function runInPool(items, worker) {
    var index = 0;

    function runner() {
      if (index >= items.length) return Promise.resolve();
      var current = index++;
      return Promise.resolve(worker(items[current])).then(runner);
    }

    var workers = [];
    for (var i = 0; i < Math.min(FETCH_CONCURRENCY, items.length); i++) workers.push(runner());
    return Promise.all(workers);
  }

  function getCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
      return parsed.data;
    } catch (e) {
      return null;
    }
  }

  function setCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) {}
  }

  function applyData(data) {
    state.files = data.files || [];
    state.directories = data.directories || [];
    state.modules = data.modules || [];
    state.moduleMap = data.moduleMap || Object.create(null);
    state.moduleMeta = data.moduleMeta || Object.create(null);
    state.importsTo = data.importsTo || Object.create(null);
    state.importsFrom = data.importsFrom || Object.create(null);
    state.externalImportsFrom = data.externalImportsFrom || Object.create(null);

    buildPairs();
    renderDirectoryTree();
    if (!state.selectedModule || !state.moduleMap[state.selectedModule]) state.selectedModule = state.modules[0] || null;
    if (state.selectedModule) {
      rememberTrail(state.selectedModule);
      renderDetails(state.selectedModule);
    }
    renderAll();
  }

  function fetchAndBuildData() {
    setStatus("Loading repository tree…", false);

    return safeFetch(API + "/git/trees/" + REF + "?recursive=1", false).then(function (payload) {
      var tree = payload && payload.tree ? payload.tree : [];
      var files = tree.filter(function (entry) { return entry.type === "blob"; }).map(function (entry) { return entry.path; });
      var directories = tree.filter(function (entry) { return entry.type === "tree"; }).map(function (entry) { return entry.path; });
      var leanFiles = files.filter(function (path) { return /^SeLe4n\/.*\.lean$/.test(path); });

      state.files = files;
      state.directories = directories;
      state.modules = leanFiles.map(moduleFromPath);
      state.moduleMap = Object.create(null);
      state.moduleMeta = Object.create(null);
      state.importsTo = Object.create(null);
      state.importsFrom = Object.create(null);
      state.externalImportsFrom = Object.create(null);

      for (var i = 0; i < state.modules.length; i++) state.moduleMap[state.modules[i]] = leanFiles[i];

      setStatus("Analyzing Lean modules and theorem declarations…", false);

      return runInPool(leanFiles, function (path) {
        var moduleName = moduleFromPath(path);
        return safeFetch(RAW + path, true).then(function (text) {
          parseModule(moduleName, text);
        }).catch(function () {
          state.importsFrom[moduleName] = [];
          state.externalImportsFrom[moduleName] = [];
          state.moduleMeta[moduleName] = {
            layer: classifyLayer(moduleName),
            kind: moduleKind(moduleName),
            base: moduleBase(moduleName),
            theorems: 0
          };
        });
      });
    }).then(function () {
      buildPairs();
      renderDirectoryTree();
      if (!state.selectedModule || !state.moduleMap[state.selectedModule]) state.selectedModule = state.modules[0] || null;
      if (state.selectedModule) {
        rememberTrail(state.selectedModule);
        renderDetails(state.selectedModule);
      }
      renderAll();
      syncUrlState();
      setStatus("Map ready. Adaptive context lenses loaded.", false);
      setCache({
        files: state.files,
        directories: state.directories,
        modules: state.modules,
        moduleMap: state.moduleMap,
        moduleMeta: state.moduleMeta,
        importsTo: state.importsTo,
        importsFrom: state.importsFrom,
        externalImportsFrom: state.externalImportsFrom
      });
    });
  }

  function setupFilters() {
    var search = document.getElementById("module-search");
    var focus = document.getElementById("focus-select");
    var sort = document.getElementById("sort-select");
    var neighborLimit = document.getElementById("neighbor-limit");
    var reset = document.getElementById("reset-view");

    var layers = ["model", "kernel", "security", "platform", "other"];
    for (var i = 0; i < layers.length; i++) {
      var option = document.createElement("option");
      option.value = layers[i];
      option.textContent = layers[i][0].toUpperCase() + layers[i].slice(1);
      focus.appendChild(option);
    }

    function apply() {
      state.activeFilterText = search ? search.value : "";
      state.activeLayerFilter = focus ? focus.value : "all";
      state.activeSort = sort ? sort.value : "hotspot";
      state.neighborLimit = neighborLimit ? Math.max(4, Math.min(20, Number(neighborLimit.value) || 12)) : 12;
      syncUrlState();
      renderAll();
    }

    if (search) search.addEventListener("input", apply);
    if (focus) focus.addEventListener("change", apply);
    if (sort) sort.addEventListener("change", apply);
    if (neighborLimit) neighborLimit.addEventListener("change", apply);

    if (reset) {
      reset.addEventListener("click", function () {
        if (search) search.value = "";
        if (focus) focus.value = "all";
        if (sort) sort.value = "hotspot";
        if (neighborLimit) neighborLimit.value = "12";
        state.selectedPair = null;
        apply();
      });
    }
  }

  function setupLensTabs() {
    var tabs = document.querySelectorAll("[data-lens]");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        state.selectedLens = this.getAttribute("data-lens") || "summary";
        for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove("active");
        this.classList.add("active");
        renderLensPanel();
      });
    }
  }

  function setupKeyboardNavigation() {
    document.addEventListener("keydown", function (event) {
      var target = event.target;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.key !== "j" && event.key !== "k") return;
      var list = filteredModules();
      sortModules(list);
      if (!list.length) return;

      var currentIndex = Math.max(0, list.indexOf(state.selectedModule));
      var nextIndex = event.key === "j" ? Math.min(list.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
      selectModule(list[nextIndex], false);
      event.preventDefault();
    });
  }

  function readUrlState() {
    var params = new URLSearchParams(window.location.search);
    var moduleParam = sanitizeModuleName(params.get("module") || "");
    if (moduleParam) state.selectedModule = moduleParam;

    var layer = params.get("layer") || "all";
    if (/^(all|model|kernel|security|platform|other)$/.test(layer)) state.activeLayerFilter = layer;

    var sort = params.get("sort") || "hotspot";
    if (/^(hotspot|theorems|name)$/.test(sort)) state.activeSort = sort;

    var query = (params.get("q") || "").slice(0, 80);
    state.activeFilterText = query.replace(/[^\w./\-\s]/g, "");
  }

  function syncUrlState() {
    var params = new URLSearchParams(window.location.search);
    if (state.selectedModule) params.set("module", state.selectedModule); else params.delete("module");
    if (state.activeLayerFilter && state.activeLayerFilter !== "all") params.set("layer", state.activeLayerFilter); else params.delete("layer");
    if (state.activeSort && state.activeSort !== "hotspot") params.set("sort", state.activeSort); else params.delete("sort");
    if (state.activeFilterText) params.set("q", state.activeFilterText); else params.delete("q");

    var next = params.toString();
    var target = window.location.pathname + (next ? "?" + next : "");
    window.history.replaceState(null, "", target);
  }

  function hydrateFilterControls() {
    var search = document.getElementById("module-search");
    var focus = document.getElementById("focus-select");
    var sort = document.getElementById("sort-select");
    if (search) search.value = state.activeFilterText;
    if (focus) focus.value = state.activeLayerFilter;
    if (sort) sort.value = state.activeSort;
  }

  function boot() {
    setupTheme();
    hardenExternalLinks();
    readUrlState();
    setupFilters();
    setupLensTabs();
    setupKeyboardNavigation();
    hydrateFilterControls();

    var cached = getCache();
    if (cached) {
      applyData(cached);
      setStatus("Showing cached map while refreshing…", false);
    }

    fetchAndBuildData().catch(function (error) {
      var message = error && error.message ? error.message : "Unknown error";
      if (!cached) setStatus("Unable to load codebase map. " + message, true);
      else setStatus("Refresh failed; showing cached data. " + message, true);
    });
  }

  boot();
})();
