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

  var CACHE_KEY = "sele4n-code-map-v6";
  var CACHE_TTL_MS = 60 * 60 * 1000;
  var FETCH_CONCURRENCY = 8;
  var FETCH_TIMEOUT_MS = 9000;
  var NODE_CACHE = Object.create(null);

  var state = {
    files: [], modules: [], moduleMap: Object.create(null), moduleMeta: Object.create(null),
    importsTo: Object.create(null), importsFrom: Object.create(null), externalImportsFrom: Object.create(null),
    theoremPairs: [], proofPairMap: Object.create(null), degreeMap: Object.create(null),
    selectedModule: null, activeFilterText: "", activeLayerFilter: "all", activeSort: "hotspot",
    trail: [], selectedLens: "summary", neighborLimit: 12, impactRadius: 2, proofLinkedOnly: false
  };

  function getFilteredAndSortedModules() {
    var list = filteredModules();
    sortModules(list);
    return list;
  }

  function updateModuleResults(count) {
    var node = document.getElementById("module-results");
    if (!node) return;
    var total = state.modules.length;
    node.textContent = String(count) + " modules shown" + (total ? " (" + total + " total)" : "");
  }

  function setStatus(text, isError) {
    var el = document.getElementById("map-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", Boolean(isError));

    var main = document.getElementById("main-content");
    if (main) main.setAttribute("aria-busy", /loading|refreshing/i.test(text) ? "true" : "false");
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
    if (state.degreeMap[name]) return state.degreeMap[name];
    var incoming = (state.importsTo[name] || []).length;
    var outgoing = (state.importsFrom[name] || []).length;
    var theorems = (state.moduleMeta[name] || {}).theorems || 0;
    var score = incoming * 2 + outgoing + theorems * 3;
    var degree = { incoming: incoming, outgoing: outgoing, total: incoming + outgoing, theorems: theorems, score: score };
    state.degreeMap[name] = degree;
    return degree;
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

  function findProofPair(name) {
    return state.proofPairMap[moduleBase(name)] || null;
  }

  function assuranceForModule(name) {
    var pair = findProofPair(name);
    var degree = moduleDegree(name);
    if (pair && pair.invariantImportsOperations) {
      return {
        level: "linked",
        label: "Linked proof chain",
        detail: "Operations and Invariant modules are connected; obligations can be traced from transitions to safety claims.",
        score: degree.score + pair.operationsTheorems + pair.invariantTheorems
      };
    }
    if (pair) {
      return {
        level: "partial",
        label: "Partial proof context",
        detail: "A proof pair exists but is not explicitly linked by imports; review assumptions before reusing results.",
        score: degree.score
      };
    }
    if (degree.theorems > 0) {
      return {
        level: "local",
        label: "Local theorem coverage",
        detail: "This module declares theorems but has no Operations/Invariant pair mapping.",
        score: degree.score
      };
    }
    return {
      level: "none",
      label: "No explicit proof evidence",
      detail: "No theorem declarations or proof-pair mapping detected for this module.",
      score: degree.score
    };
  }

  function collectNeighborhood(name, radius) {
    var maxRadius = Math.max(1, Math.min(3, radius || 1));
    var visited = Object.create(null);
    var queue = [{ name: name, depth: 0 }];
    var out = [];
    visited[name] = true;

    while (queue.length) {
      var node = queue.shift();
      out.push(node);
      if (node.depth >= maxRadius) continue;
      var neighbors = (state.importsFrom[node.name] || []).concat(state.importsTo[node.name] || []);
      for (var i = 0; i < neighbors.length; i++) {
        var next = neighbors[i];
        if (!next || visited[next]) continue;
        visited[next] = true;
        queue.push({ name: next, depth: node.depth + 1 });
      }
    }
    return out;
  }

  function findNearestLinkedPath(start, radius) {
    if (!start) return [];
    if (assuranceForModule(start).level === "linked") return [start];

    var maxRadius = Math.max(1, Math.min(3, radius || 1));
    var queue = [{ name: start, depth: 0 }];
    var visited = Object.create(null);
    var prev = Object.create(null);
    visited[start] = true;

    while (queue.length) {
      var node = queue.shift();
      if (node.depth >= maxRadius) continue;

      var neighbors = uniqueModules((state.importsFrom[node.name] || []).concat(state.importsTo[node.name] || []), node.name);
      for (var i = 0; i < neighbors.length; i++) {
        var next = neighbors[i];
        if (!next || visited[next]) continue;
        visited[next] = true;
        prev[next] = node.name;

        if (assuranceForModule(next).level === "linked") {
          var path = [next];
          var cursor = next;
          while (prev[cursor]) {
            cursor = prev[cursor];
            path.push(cursor);
          }
          path.reverse();
          return path;
        }

        queue.push({ name: next, depth: node.depth + 1 });
      }
    }

    return [];
  }

  function sortByScoreThenName(a, b) {
    return moduleDegree(b).score - moduleDegree(a).score || a.localeCompare(b);
  }

  function uniqueModules(list, excluded) {
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var name = list[i];
      if (!name || seen[name] || (excluded && name === excluded)) continue;
      seen[name] = true;
      out.push(name);
    }
    return out;
  }

  function pathSegments(path) {
    if (!path) return [];
    var parts = path.split("/");
    if (parts.length <= 1) return parts;
    return parts.slice(0, parts.length - 1);
  }

  function filteredModules() {
    var q = state.activeFilterText.trim().toLowerCase();
    var layer = state.activeLayerFilter;
    return state.modules.filter(function (name) {
      var meta = state.moduleMeta[name] || {};
      var path = state.moduleMap[name] || "";
      if (layer !== "all" && meta.layer !== layer) return false;
      if (state.proofLinkedOnly) {
        var pair = findProofPair(name);
        if (!pair || !pair.invariantImportsOperations) return false;
      }
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
    var proofPair = findProofPair(name);

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

    var dirs = pathSegments(modulePath);
    if (dirs.length) {
      var dirNode = document.createElement("p");
      dirNode.className = "panel-note";
      dirNode.textContent = "Directory focus: /" + dirs.join("/") + " (depth " + dirs.length + ").";
      panel.appendChild(dirNode);
    }

    if (proofPair) {
      var proofNode = document.createElement("p");
      proofNode.className = "panel-note";
      proofNode.textContent = "Proof pair: total theorems=" + (proofPair.operationsTheorems + proofPair.invariantTheorems) + ", invariant imports operations=" + (proofPair.invariantImportsOperations ? "yes" : "no") + ".";
      panel.appendChild(proofNode);
    }

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
    renderAssuranceStrip(name);
  }

  function renderAssuranceStrip(name) {
    var strip = document.getElementById("assurance-strip");
    if (!strip || !name) return;
    strip.classList.add("assurance-strip");
    strip.innerHTML = "";

    var assurance = assuranceForModule(name);
    var neighborhood = collectNeighborhood(name, state.impactRadius);
    var proofReach = neighborhood.filter(function (item) {
      var pair = findProofPair(item.name);
      return pair && pair.invariantImportsOperations;
    });

    var summary = document.createElement("p");
    summary.className = "lens-metric";
    summary.textContent = "Assurance state: " + assurance.label + ". " + assurance.detail;
    strip.appendChild(summary);

    var depth = document.createElement("p");
    depth.className = "lens-metric";
    depth.textContent = "Within " + state.impactRadius + " hops: " + neighborhood.length + " reachable modules, " + proofReach.length + " with linked proof chains.";
    strip.appendChild(depth);

    var row = document.createElement("div");
    row.className = "pill-row";
    var topReach = proofReach.slice(0, 8).sort(function (a, b) {
      return moduleDegree(b.name).score - moduleDegree(a.name).score;
    });

    if (!topReach.length) {
      row.textContent = "No linked proof chains found in the current radius.";
    } else {
      for (var i = 0; i < topReach.length; i++) {
        var chip = createPill(topReach[i].name, "out", true);
        chip.setAttribute("title", "Depth " + topReach[i].depth + " from selected module");
        chip.appendChild(document.createTextNode(" · d" + topReach[i].depth));
        row.appendChild(chip);
      }
    }
    strip.appendChild(row);

    var path = findNearestLinkedPath(name, state.impactRadius);
    var pathLabel = document.createElement("p");
    pathLabel.className = "lens-metric";
    pathLabel.textContent = path.length ? "Nearest linked-proof path:" : "No linked-proof path found within current impact radius.";
    strip.appendChild(pathLabel);

    if (path.length) {
      var pathRow = document.createElement("div");
      pathRow.className = "pill-row";
      for (var j = 0; j < path.length; j++) pathRow.appendChild(createPill(path[j], "in", true));
      strip.appendChild(pathRow);
    }
  }

  function renderWalkCards() {
    var wrap = document.getElementById("graph-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    var list = getFilteredAndSortedModules();
    updateModuleResults(list.length);

    if (list.length && list.indexOf(state.selectedModule) === -1) {
      state.selectedModule = list[0];
      rememberTrail(state.selectedModule);
      renderDetails(state.selectedModule);
      syncUrlState();
    }

    if (!list.length) {
      wrap.textContent = "No modules matched the current filters.";
      return;
    }

    var fragment = document.createDocumentFragment();
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
      var pair = findProofPair(name);
      var pairStatus = pair ? (pair.invariantImportsOperations ? "proof-linked" : "proof-check") : "proof-na";
      var assurance = assuranceForModule(name);
      info.textContent = meta.layer + " · " + meta.kind + " · thm=" + degree.theorems + " · " + pairStatus + " · assurance=" + assurance.level;
      var score = document.createElement("p");
      score.className = "walk-score";
      score.textContent = "score=" + degree.score + " in=" + degree.incoming + " out=" + degree.outgoing;

      card.appendChild(h);
      card.appendChild(info);
      card.appendChild(score);
      card.addEventListener("click", (function (moduleName) {
        return function () { selectModule(moduleName, false); };
      })(name));
      fragment.appendChild(card);
    }
    wrap.appendChild(fragment);
  }

  function createPill(moduleName, mode, selectable) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "dep-pill" + (mode === "out" ? " imported-by" : "");
    button.textContent = moduleName;
    if (selectable === false) {
      button.disabled = true;
      button.classList.add("static");
    } else {
      button.addEventListener("click", function () { selectModule(moduleName, false); });
    }
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
        for (var i = 0; i < slice.length; i++) row.appendChild(createPill(slice[i], mode, mode !== "static"));
      }
      band.appendChild(row);
      wrap.appendChild(band);
    }

    renderBand("Imported modules", state.importsFrom[selected] || [], "in");
    renderBand("Importing modules", state.importsTo[selected] || [], "out");
    renderBand("Proof-neighbor modules", relatedProofModules(selected), "out");

    var modulePath = state.moduleMap[selected] || "";
    var segments = pathSegments(modulePath);
    if (segments.length) renderBand("Directory context", segments, "static");
  }

  function renderTrail() {
    var wrap = document.getElementById("trail-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    if (!state.trail.length) {
      wrap.textContent = "Start selecting modules to build a contextual walk.";
      return;
    }

    var fragment = document.createDocumentFragment();
    for (var i = 0; i < state.trail.length; i++) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "trail-chip";
      chip.textContent = (i + 1) + ". " + state.trail[i];
      chip.addEventListener("click", (function (moduleName) {
        return function () { selectModule(moduleName, true); };
      })(state.trail[i]));
      fragment.appendChild(chip);
    }
    wrap.appendChild(fragment);
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
    var highRisk = uniqueModules(importers.concat(imports), selected).sort(sortByScoreThenName).slice(0, 5);

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

  function lensAssurance(panel, selected) {
    var ring = collectNeighborhood(selected, state.impactRadius);
    var risks = [];

    for (var i = 0; i < ring.length; i++) {
      if (ring[i].name === selected) continue;
      var score = moduleDegree(ring[i].name).score;
      var assurance = assuranceForModule(ring[i].name);
      if (assurance.level === "linked") continue;
      risks.push({ name: ring[i].name, depth: ring[i].depth, score: score, assurance: assurance });
    }

    risks.sort(function (a, b) {
      return b.score - a.score || a.depth - b.depth || a.name.localeCompare(b.name);
    });

    var summary = document.createElement("p");
    summary.className = "lens-metric";
    summary.textContent = "Impact radius " + state.impactRadius + " discovers " + ring.length + " modules; " + risks.length + " require proof strengthening or trace review.";
    panel.appendChild(summary);

    var riskList = document.createElement("div");
    riskList.className = "risk-list";
    if (!risks.length) {
      var healthy = document.createElement("p");
      healthy.className = "lens-metric";
      healthy.textContent = "All reachable modules are proof-linked. This context has strong compositional evidence.";
      panel.appendChild(healthy);
    } else {
      for (var j = 0; j < Math.min(6, risks.length); j++) {
        var item = document.createElement("div");
        item.className = "risk-item";
        item.innerHTML = "<strong></strong>";
        item.children[0].textContent = risks[j].name;
        item.appendChild(document.createTextNode(" · d" + risks[j].depth + " · " + risks[j].assurance.label.toLowerCase() + " · score " + risks[j].score));
        riskList.appendChild(item);
      }
      panel.appendChild(riskList);
    }

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
    else lensAssurance(panel, state.selectedModule);
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
    state.proofPairMap = Object.create(null);
    state.degreeMap = Object.create(null);
    for (var k = 0; k < pairs.length; k++) state.proofPairMap[pairs[k].base] = pairs[k];
    for (var m = 0; m < state.modules.length; m++) moduleDegree(state.modules[m]);
    updateMetric("files", state.files.length);
    updateMetric("leanModules", state.modules.length);
    updateMetric("importEdges", totals.importEdges);
    updateMetric("theorems", totals.theorems);
    updateMetric("proofPairs", totals.pairs);
    updateMetric("linkedPairs", totals.linked);
  }

  function renderAll() {
    renderWalkCards();
    renderConstellation();
    renderLensPanel();
    renderTrail();
  }


  function setupNav() {
    var toggle = document.getElementById("nav-toggle");
    var links = document.getElementById("nav-links");

    function setNavState(open) {
      if (!toggle || !links) return;
      links.classList.toggle("open", open);
      toggle.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      document.body.classList.toggle("nav-open", open);
    }

    if (toggle && links) {
      toggle.addEventListener("click", function () {
        setNavState(!links.classList.contains("open"));
      });

      var items = links.querySelectorAll("a");
      for (var i = 0; i < items.length; i++) {
        items[i].addEventListener("click", function () {
          setNavState(false);
        });
      }

      document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        setNavState(false);
      });
    }

    var nav = document.getElementById("nav");
    if (!nav) return;

    if (nav.getAttribute("data-force-scrolled") === "true") {
      nav.classList.add("scrolled");
      return;
    }

    var applyScrolled = function () {
      nav.classList.toggle("scrolled", window.scrollY > 40);
    };

    applyScrolled();

    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      window.requestAnimationFrame(function () {
        applyScrolled();
        ticking = false;
      });
      ticking = true;
    }, { passive: true });
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
    state.modules = data.modules || [];
    state.moduleMap = data.moduleMap || Object.create(null);
    state.moduleMeta = data.moduleMeta || Object.create(null);
    state.importsTo = data.importsTo || Object.create(null);
    state.importsFrom = data.importsFrom || Object.create(null);
    state.externalImportsFrom = data.externalImportsFrom || Object.create(null);

    buildPairs();
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
      var files = [];
      var leanFiles = [];
      for (var i = 0; i < tree.length; i++) {
        var entry = tree[i];
        if (!entry || entry.type !== "blob") continue;
        files.push(entry.path);
        if (/^SeLe4n\/.*\.lean$/.test(entry.path)) leanFiles.push(entry.path);
      }

      state.files = files;
      state.modules = leanFiles.map(moduleFromPath);
      state.moduleMap = Object.create(null);
      state.moduleMeta = Object.create(null);
      state.importsTo = Object.create(null);
      state.importsFrom = Object.create(null);
      state.externalImportsFrom = Object.create(null);

      for (var j = 0; j < state.modules.length; j++) state.moduleMap[state.modules[j]] = leanFiles[j];

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
    var impactRadius = document.getElementById("impact-radius");
    var proofLinkedOnly = document.getElementById("proof-linked-only");
    var reset = document.getElementById("reset-view");

    var layers = ["model", "kernel", "security", "platform", "other"];
    if (focus) {
      for (var i = 0; i < layers.length; i++) {
        var option = document.createElement("option");
        option.value = layers[i];
        option.textContent = layers[i][0].toUpperCase() + layers[i].slice(1);
        focus.appendChild(option);
      }
    }

    function apply() {
      state.activeFilterText = search ? search.value : "";
      state.activeLayerFilter = focus ? focus.value : "all";
      state.activeSort = sort ? sort.value : "hotspot";
      state.neighborLimit = neighborLimit ? Math.max(4, Math.min(20, Number(neighborLimit.value) || 12)) : 12;
      state.impactRadius = impactRadius ? Math.max(1, Math.min(3, Number(impactRadius.value) || 2)) : 2;
      state.proofLinkedOnly = proofLinkedOnly ? proofLinkedOnly.checked : false;
      syncUrlState();
      renderAll();
      if (state.selectedModule) renderDetails(state.selectedModule);
    }

    if (search) search.addEventListener("input", apply);
    if (focus) focus.addEventListener("change", apply);
    if (sort) sort.addEventListener("change", apply);
    if (neighborLimit) neighborLimit.addEventListener("change", apply);
    if (impactRadius) impactRadius.addEventListener("change", apply);
    if (proofLinkedOnly) proofLinkedOnly.addEventListener("change", apply);

    if (reset) {
      reset.addEventListener("click", function () {
        if (search) search.value = "";
        if (focus) focus.value = "all";
        if (sort) sort.value = "hotspot";
        if (neighborLimit) neighborLimit.value = "12";
        if (impactRadius) impactRadius.value = "2";
        if (proofLinkedOnly) proofLinkedOnly.checked = false;
        apply();
      });
    }
  }

  function setupLensTabs() {
    var tabs = document.querySelectorAll("[data-lens]");
    var panel = document.getElementById("lens-panel");

    function activateTab(tab) {
      if (!tab) return;
      state.selectedLens = tab.getAttribute("data-lens") || "summary";
      for (var i = 0; i < tabs.length; i++) {
        var selected = tabs[i] === tab;
        tabs[i].classList.toggle("active", selected);
        tabs[i].setAttribute("aria-selected", selected ? "true" : "false");
        tabs[i].setAttribute("tabindex", selected ? "0" : "-1");
      }
      if (panel) panel.setAttribute("aria-labelledby", tab.id || "");
      renderLensPanel();
    }

    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        activateTab(this);
      });

      tabs[i].addEventListener("keydown", function (event) {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        var dir = event.key === "ArrowRight" ? 1 : -1;
        var current = Array.prototype.indexOf.call(tabs, this);
        var next = (current + dir + tabs.length) % tabs.length;
        tabs[next].focus();
        activateTab(tabs[next]);
        event.preventDefault();
      });
    }

    var active = document.querySelector('[data-lens="' + state.selectedLens + '"]') || tabs[0];
    activateTab(active);
  }

  function setupKeyboardNavigation() {
    document.addEventListener("keydown", function (event) {
      var target = event.target;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      var key = (event.key || "").toLowerCase();
      if (key !== "j" && key !== "k") return;
      var list = getFilteredAndSortedModules();
      if (!list.length) return;

      var currentIndex = Math.max(0, list.indexOf(state.selectedModule));
      var nextIndex = key === "j" ? Math.min(list.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
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

    var radius = Number(params.get("radius") || "2");
    if (radius >= 1 && radius <= 3) state.impactRadius = radius;

    state.proofLinkedOnly = params.get("linked") === "1";
  }

  function syncUrlState() {
    var params = new URLSearchParams(window.location.search);
    if (state.selectedModule) params.set("module", state.selectedModule); else params.delete("module");
    if (state.activeLayerFilter && state.activeLayerFilter !== "all") params.set("layer", state.activeLayerFilter); else params.delete("layer");
    if (state.activeSort && state.activeSort !== "hotspot") params.set("sort", state.activeSort); else params.delete("sort");
    if (state.activeFilterText) params.set("q", state.activeFilterText); else params.delete("q");
    if (state.impactRadius && state.impactRadius !== 2) params.set("radius", String(state.impactRadius)); else params.delete("radius");
    if (state.proofLinkedOnly) params.set("linked", "1"); else params.delete("linked");

    var next = params.toString();
    var target = window.location.pathname + (next ? "?" + next : "");
    if (target === window.location.pathname + window.location.search) return;
    window.history.replaceState(null, "", target);
  }

  function hydrateFilterControls() {
    var search = document.getElementById("module-search");
    var focus = document.getElementById("focus-select");
    var sort = document.getElementById("sort-select");
    var radius = document.getElementById("impact-radius");
    var linked = document.getElementById("proof-linked-only");
    if (search) search.value = state.activeFilterText;
    if (focus) focus.value = state.activeLayerFilter;
    if (sort) sort.value = state.activeSort;
    if (radius) radius.value = String(state.impactRadius);
    if (linked) linked.checked = Boolean(state.proofLinkedOnly);
  }

  function boot() {
    setupTheme();
    setupNav();
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
