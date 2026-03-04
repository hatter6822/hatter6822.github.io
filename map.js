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

  var CACHE_KEY = "sele4n-code-map-v7";
  var CACHE_TTL_MS = 60 * 60 * 1000;
  var FETCH_CONCURRENCY = 8;
  var FETCH_TIMEOUT_MS = 9000;
  var NODE_CACHE = Object.create(null);

  var state = {
    files: [], modules: [], moduleMap: Object.create(null), moduleMeta: Object.create(null),
    importsTo: Object.create(null), importsFrom: Object.create(null), externalImportsFrom: Object.create(null),
    theoremPairs: [], proofPairMap: Object.create(null), degreeMap: Object.create(null),
    selectedModule: null, activeLayerFilter: "all", activeSort: "hotspot",
    trail: [], neighborLimit: 12, impactRadius: 2, proofLinkedOnly: false,
    flowMode: "balanced", flowShowAll: false, contextListKey: "", contextList: []
  };

  var renderScheduled = false;

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(function () {
      renderScheduled = false;
      renderAll();
    });
  }

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

  function isLikelyModuleToken(token) {
    return /^[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*$/.test(token || "");
  }

  function tokenizeImportSegment(segment) {
    var out = [];
    var raw = (segment || "").split(/[\s,]+/);
    for (var i = 0; i < raw.length; i++) {
      var candidate = (raw[i] || "").replace(/^[()]+|[()]+$/g, "").trim();
      if (!candidate || !isLikelyModuleToken(candidate)) continue;
      out.push(candidate);
    }
    return out;
  }

  function extractImportTokens(sourceText) {
    var tokens = [];
    var lines = sourceText.split(/\r?\n/);

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i] || "";
      var withoutComment = raw.split("--")[0] || "";
      var trimmed = withoutComment.trim();
      if (!/^import(?:\s|$)/.test(trimmed)) continue;

      var inline = trimmed.replace(/^import\s*/, "");
      var headTokens = tokenizeImportSegment(inline);
      for (var j = 0; j < headTokens.length; j++) tokens.push(headTokens[j]);

      var cursor = i + 1;
      while (cursor < lines.length) {
        var continuationRaw = lines[cursor] || "";
        if (!/^\s/.test(continuationRaw)) break;

        var continuation = (continuationRaw.split("--")[0] || "").trim();
        if (!continuation) {
          cursor += 1;
          continue;
        }

        var contTokens = tokenizeImportSegment(continuation);
        if (!contTokens.length) break;
        for (var k = 0; k < contTokens.length; k++) tokens.push(contTokens[k]);
        cursor += 1;
      }

      i = cursor - 1;
    }

    return tokens;
  }

  function parseModule(name, sourceText) {
    var seenInternal = Object.create(null);
    var seenExternal = Object.create(null);
    var imports = [];
    var external = [];

    var deps = extractImportTokens(sourceText);
    for (var i = 0; i < deps.length; i++) {
      var dep = sanitizeModuleName(deps[i]);
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

    state.importsFrom[name] = imports;
    state.externalImportsFrom[name] = external;
    for (var j = 0; j < imports.length; j++) {
      if (!state.importsTo[imports[j]]) state.importsTo[imports[j]] = [];
      state.importsTo[imports[j]].push(name);
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
    var layer = state.activeLayerFilter;
    return state.modules.filter(function (name) {
      var meta = state.moduleMeta[name] || {};
      if (layer !== "all" && meta.layer !== layer) return false;
      if (state.proofLinkedOnly) {
        var pair = findProofPair(name);
        if (!pair || !pair.invariantImportsOperations) return false;
      }
      return true;
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
    var assurance = assuranceForModule(name);

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

    var notes = [
      "Path: " + modulePath,
      "Assurance: " + assurance.label + ".",
      "Use the flow chart as the canonical source for dependencies, impact, and proof reachability."
    ];

    if (proofPair) notes.push("Proof pair theorems: " + (proofPair.operationsTheorems + proofPair.invariantTheorems) + " (linked=" + (proofPair.invariantImportsOperations ? "yes" : "no") + ").");
    if (shift) notes.push("Traversal shift from " + shift.previous + ": shared dependencies=" + shift.shared.length + ", new dependencies=" + shift.newDeps.length + ".");

    for (var j = 0; j < notes.length; j++) {
      var note = document.createElement("p");
      note.className = "panel-note";
      note.textContent = notes[j];
      panel.appendChild(note);
    }
  }

  function contextList() {
    var key = [state.activeLayerFilter, state.activeSort, state.proofLinkedOnly ? "1" : "0", state.modules.length].join("|");
    if (key === state.contextListKey && state.contextList.length) return state.contextList.slice();
    var list = getFilteredAndSortedModules();
    state.contextListKey = key;
    state.contextList = list.slice();
    return list;
  }

  function renderContextChooser() {
    var picker = document.getElementById("module-search");
    var options = document.getElementById("context-options");
    if (!picker || !options) return;

    var list = contextList();
    updateModuleResults(list.length);

    if (list.length && list.indexOf(state.selectedModule) === -1) {
      state.selectedModule = list[0];
      rememberTrail(state.selectedModule);
      renderDetails(state.selectedModule);
      syncUrlState();
    }

    options.innerHTML = "";
    if (!list.length) {
      picker.value = "";
      picker.placeholder = "No modules matched current filters";
      return;
    }

    picker.placeholder = "Type module/path to switch context";
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      var name = list[i];
      var opt = document.createElement("option");
      opt.value = name;
      opt.label = (state.moduleMap[name] || "") + " · score " + moduleDegree(name).score;
      fragment.appendChild(opt);
    }
    options.appendChild(fragment);

    if (state.selectedModule && document.activeElement !== picker) picker.value = state.selectedModule;
  }

  function renderFlowchartLegend() {
    var legend = document.getElementById("flowchart-legend");
    if (!legend) return;
    if (legend.childNodes.length) return;

    var items = [
      { label: "Selected module", color: "#7c9cff" },
      { label: "Imports used by selected", color: "#35c98f" },
      { label: "Modules impacted by selected", color: "#ffad42" },
      { label: "Proof pair relation", color: "#d37cff" },
      { label: "Nearest linked-proof path", color: "#6de2ff" },
      { label: "External dependency", color: "#b9c0d0" },
      { label: "Node tint = assurance level", color: "#8fa3bf" }
    ];

    for (var i = 0; i < items.length; i++) {
      var chip = document.createElement("span");
      chip.className = "legend-item";
      var swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.backgroundColor = items[i].color;
      chip.appendChild(swatch);
      chip.appendChild(document.createTextNode(items[i].label));
      legend.appendChild(chip);
    }
  }

  function wrapLabelLines(text, width, minChars) {
    if (!text) return [];
    var maxChars = Math.max(minChars || 10, Math.floor((width || 180) / 6.6));
    var tokens = String(text).split(/([._/\-])/);
    var lines = [];
    var current = "";

    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (!token) continue;
      var next = current + token;
      if (next.length <= maxChars || !current.length) {
        current = next;
      } else {
        lines.push(current);
        current = token.trim() ? token : "";
      }
    }
    if (current.length) lines.push(current);
    return lines;
  }

  function nodeContentHeight(name, subtitle, width, compactHint) {
    var titleLines = wrapLabelLines(name, width - 18, compactHint ? 14 : 12);
    var subtitleLines = subtitle ? wrapLabelLines(subtitle, width - 18, 14) : [];
    var titleLineHeight = 13;
    var subtitleLineHeight = 12;
    var topPad = compactHint ? 8 : 10;
    var bottomPad = 8;
    var gap = subtitleLines.length ? 5 : 0;
    var textHeight = titleLines.length * titleLineHeight + subtitleLines.length * subtitleLineHeight + gap;
    var minHeight = compactHint ? 34 : 44;
    return Math.max(minHeight, topPad + textHeight + bottomPad);
  }

  function createSvgNode(tag, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  function drawFlowEdge(layer, from, to, color, dashed, variant) {
    var path = createSvgNode("path", {});
    var opts = variant || {};
    var fromCenterX = from.x + from.w / 2;
    var fromCenterY = from.y + from.h / 2;
    var toCenterX = to.x + to.w / 2;
    var toCenterY = to.y + to.h / 2;
    var dx = toCenterX - fromCenterX;
    var dy = toCenterY - fromCenterY;
    var startX = fromCenterX;
    var startY = fromCenterY;
    var endX = toCenterX;
    var endY = toCenterY;

    var horizontalBias = Math.abs(dx) >= Math.abs(dy);
    if (horizontalBias) {
      startX = dx >= 0 ? from.x + from.w : from.x;
      endX = dx >= 0 ? to.x : to.x + to.w;
    } else {
      startY = dy >= 0 ? from.y + from.h : from.y;
      endY = dy >= 0 ? to.y : to.y + to.h;
    }

    var controlOffset = Math.max(56, Math.min(180, Math.abs(dx) * 0.45 + Math.abs(dy) * 0.2));
    var spread = Math.max(0, Number(opts.spread) || 0);
    var rank = Math.max(0, Number(opts.rank) || 0);
    var total = Math.max(1, Number(opts.total) || 1);
    var normalizedRank = total > 1 ? (rank / (total - 1)) * 2 - 1 : 0;
    var bend = spread * normalizedRank;
    var c1x = startX;
    var c1y = startY;
    var c2x = endX;
    var c2y = endY;

    if (horizontalBias) {
      c1x = startX + (dx >= 0 ? controlOffset : -controlOffset);
      c2x = endX - (dx >= 0 ? controlOffset : -controlOffset);
      c1y += bend;
      c2y += bend;
    } else {
      c1y = startY + (dy >= 0 ? controlOffset : -controlOffset);
      c2y = endY - (dy >= 0 ? controlOffset : -controlOffset);
      c1x += bend;
      c2x += bend;
    }

    path.setAttribute("d", "M " + startX + " " + startY + " C " + c1x + " " + c1y + ", " + c2x + " " + c2y + ", " + endX + " " + endY);
    path.setAttribute("class", "flow-line" + (dashed ? " proof-link" : ""));
    path.setAttribute("stroke", color);
    path.style.color = color;
    path.setAttribute("marker-end", "url(#flow-arrow)");
    layer.appendChild(path);
  }

  function renderFlowchart() {
    renderFlowchartLegend();
    var wrap = document.getElementById("flowchart-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    var selected = state.selectedModule;
    if (!selected) {
      wrap.textContent = "Select a module to render interaction and proof flow.";
      return;
    }

    var allImports = (state.importsFrom[selected] || []).slice().sort(sortByScoreThenName);
    var allImporters = (state.importsTo[selected] || []).slice().sort(sortByScoreThenName);
    var allExternal = state.externalImportsFrom[selected] || [];
    var importBudget = state.flowShowAll ? allImports.length : state.neighborLimit;
    var impactBudget = state.flowShowAll ? allImporters.length : state.neighborLimit;
    if (!state.flowShowAll && state.flowMode === "imports") {
      importBudget = Math.min(20, state.neighborLimit + 4);
      impactBudget = Math.max(4, state.neighborLimit - 4);
    } else if (!state.flowShowAll && state.flowMode === "impact") {
      importBudget = Math.max(4, state.neighborLimit - 4);
      impactBudget = Math.min(20, state.neighborLimit + 4);
    }
    var imports = allImports.slice(0, importBudget);
    var importers = allImporters.slice(0, impactBudget);
    var externalBudget = state.flowShowAll ? allExternal.length : 12;
    var external = allExternal.slice(0, externalBudget);
    var proofRelated = relatedProofModules(selected);
    var linkedPath = findNearestLinkedPath(selected, state.impactRadius);
    var contextCache = Object.create(null);

    function contextFor(name) {
      if (!name) return { degree: { incoming: 0, outgoing: 0, theorems: 0, score: 0 }, assurance: { label: "Unknown" }, path: "" };
      if (contextCache[name]) return contextCache[name];
      contextCache[name] = {
        degree: moduleDegree(name),
        assurance: assuranceForModule(name),
        path: state.moduleMap[name] || ""
      };
      return contextCache[name];
    }

    function moduleSummary(name) {
      var ctx = contextFor(name);
      return "thm " + ctx.degree.theorems + " · in " + ctx.degree.incoming + " · out " + ctx.degree.outgoing + " · " + ctx.assurance.label.toLowerCase();
    }

    function nodeTooltip(name, roleLabel) {
      if (!state.moduleMap[name]) return roleLabel + ": " + name;
      var ctx = contextFor(name);
      return roleLabel + "\n" + name + "\npath: " + ctx.path + "\ntheorems: " + ctx.degree.theorems + " | fan-in: " + ctx.degree.incoming + " | fan-out: " + ctx.degree.outgoing + "\nassurance: " + ctx.assurance.label;
    }

    var wrapWidth = Math.max(0, (wrap.clientWidth || 0) - 8);
    var flowWidth = Math.max(1180, wrapWidth || 0);
    var framePad = 34;
    var laneGap = 24;

    var centerWidth = Math.min(360, Math.max(300, Math.floor(flowWidth * 0.27)));
    var sideWidth = Math.min(360, Math.max(240, Math.floor((flowWidth - framePad * 2 - centerWidth - laneGap * 2) / 2)));

    var leftX = framePad;
    var centerX = leftX + sideWidth + laneGap;
    var rightX = centerX + centerWidth + laneGap;

    var laneYStart = 62;
    var laneGapY = 10;

    function stackedLayout(names, width, subtitleFn, compactHint) {
      var nodes = [];
      var cursor = laneYStart;
      for (var ii = 0; ii < names.length; ii++) {
        var subtitleText = subtitleFn ? subtitleFn(names[ii]) : "";
        var height = nodeContentHeight(names[ii], subtitleText, width, compactHint);
        nodes.push({ name: names[ii], y: cursor, h: height, subtitle: subtitleText });
        cursor += height + laneGapY;
      }
      return { nodes: nodes, bottom: names.length ? (cursor - laneGapY) : laneYStart + 44 };
    }

    var importLayout = stackedLayout(imports, sideWidth, moduleSummary, false);
    var importerLayout = stackedLayout(importers, sideWidth, moduleSummary, false);
    var laneBottom = Math.max(importLayout.bottom, importerLayout.bottom);

    var centerHeight = nodeContentHeight(selected, moduleSummary(selected), centerWidth, false) + 14;
    var centerY = Math.max(170, laneYStart + Math.floor((Math.max(importLayout.bottom, importerLayout.bottom) - laneYStart - centerHeight) / 2));
    var centerBottom = centerY + centerHeight;

    var lowerSectionTop = Math.max(laneBottom + 54, centerBottom + 54);
    var proofStartY = lowerSectionTop;
    var proofBottom = proofStartY;
    for (var pr = 0; pr < proofRelated.length; pr++) {
      proofBottom += nodeContentHeight(proofRelated[pr], moduleSummary(proofRelated[pr]), centerWidth, true) + 8;
    }
    proofBottom = Math.max(proofBottom, proofStartY + 42);
    var pathStartY = proofBottom + 54;

    var externalPerRow = Math.max(2, Math.min(6, Math.floor((flowWidth - framePad * 2) / 220)));
    var externalRows = Math.max(1, Math.ceil(external.length / externalPerRow));
    var externalStartY = pathStartY + (linkedPath.length > 1 ? 74 : 20);
    var flowHeight = Math.max(620, externalStartY + externalRows * 56 + 68);

    var svg = createSvgNode("svg", {
      "class": "flowchart-svg",
      "viewBox": "0 0 " + flowWidth + " " + flowHeight,
      "role": "img",
      "aria-label": "Flow chart for selected module interactions and proof links: " + selected + ", imports " + allImports.length + ", impacted modules " + allImporters.length + ", proof neighbors " + proofRelated.length
    });

    var defs = createSvgNode("defs", {});
    var marker = createSvgNode("marker", {
      id: "flow-arrow",
      viewBox: "0 0 10 10",
      refX: "9",
      refY: "5",
      markerWidth: "6",
      markerHeight: "6",
      orient: "auto-start-reverse"
    });
    marker.appendChild(createSvgNode("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "currentColor" }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    var edgeLayer = createSvgNode("g", { "class": "flow-edge-layer" });
    var nodeLayer = createSvgNode("g", { "class": "flow-node-layer" });
    var labelLayer = createSvgNode("g", { "class": "flow-label-layer" });
    svg.appendChild(edgeLayer);
    svg.appendChild(nodeLayer);
    svg.appendChild(labelLayer);

    function laneLabel(text, x, y, color) {
      var label = createSvgNode("text", { x: x, y: y, fill: color, "font-size": "12", "class": "flow-lane-label" });
      label.textContent = text;
      labelLayer.appendChild(label);
    }

    function createNode(name, x, y, w, h, color, subtitle, tooltip, active, isStatic, assuranceLevel) {
      var className = "flow-node" + (active ? " active" : "") + (isStatic ? " static" : "");
      if (assuranceLevel && !isStatic) className += " assurance-" + assuranceLevel;
      var group = createSvgNode("g", { "class": className, tabindex: isStatic ? "-1" : "0", role: isStatic ? "note" : "button", "aria-label": isStatic ? name : ("Select module " + name) });
      if (!isStatic) group.setAttribute("focusable", "true");

      var rect = createSvgNode("rect", { x: x, y: y, width: w, height: h, fill: "var(--flow-node-bg)", stroke: color });
      var full = createSvgNode("title", {});
      full.textContent = tooltip || name;

      var compactNode = h < 44;
      var title = createSvgNode("text", { x: x + 10, y: y + (compactNode ? 20 : 19) });
      var titleLines = wrapLabelLines(name, w - 18, compactNode ? 14 : 12);
      for (var ll = 0; ll < titleLines.length; ll++) {
        var tspan = createSvgNode("tspan", { x: x + 10, dy: ll === 0 ? "0" : "13" });
        tspan.textContent = titleLines[ll];
        title.appendChild(tspan);
      }

      group.appendChild(full);
      group.appendChild(rect);
      group.appendChild(title);

      if (subtitle && h >= 40) {
        var subtitleLines = wrapLabelLines(subtitle, w - 18, 14);
        var subtitleStartY = y + (compactNode ? 22 : 22) + Math.max(1, titleLines.length) * 13 + 3;
        var meta = createSvgNode("text", { x: x + 10, y: subtitleStartY, "class": "flow-meta" });
        for (var mm = 0; mm < subtitleLines.length; mm++) {
          var metaSpan = createSvgNode("tspan", { x: x + 10, dy: mm === 0 ? "0" : "12" });
          metaSpan.textContent = subtitleLines[mm];
          meta.appendChild(metaSpan);
        }
        group.appendChild(meta);
      }

      if (!isStatic) {
        group.addEventListener("click", function () { selectModule(name, false); });
        group.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectModule(name, false);
          }
        });
      }

      nodeLayer.appendChild(group);
      return { name: name, x: x, y: y, w: w, h: h };
    }

    laneLabel("Imports used by selected", leftX, 30, "#35c98f");
    laneLabel("Selected module context", centerX, centerY - 12, "#7c9cff");
    laneLabel("Modules impacted by selected", rightX, 30, "#ffad42");

    var center = createNode(selected, centerX, centerY, centerWidth, centerHeight, "#7c9cff", moduleSummary(selected), nodeTooltip(selected, "Selected module context"), true, false, contextFor(selected).assurance.level);

    var importNodes = [];
    for (var i = 0; i < importLayout.nodes.length; i++) {
      var importItem = importLayout.nodes[i];
      importNodes.push(createNode(importItem.name, leftX, importItem.y, sideWidth, importItem.h, "#35c98f", importItem.subtitle, nodeTooltip(importItem.name, "Imported dependency"), false, false, contextFor(importItem.name).assurance.level));
    }

    var importerNodes = [];
    for (var j = 0; j < importerLayout.nodes.length; j++) {
      var importerItem = importerLayout.nodes[j];
      importerNodes.push(createNode(importerItem.name, rightX, importerItem.y, sideWidth, importerItem.h, "#ffad42", importerItem.subtitle, nodeTooltip(importerItem.name, "Impacted module"), false, false, contextFor(importerItem.name).assurance.level));
    }

    if (allImports.length > imports.length) {
      createNode("+" + (allImports.length - imports.length) + " more imports", leftX, importLayout.bottom + laneGapY, sideWidth, 36, "#35c98f", "enable full-flow or increase neighbor budget", "", false, true, "");
    }
    if (allImporters.length > importers.length) {
      createNode("+" + (allImporters.length - importers.length) + " more impacted modules", rightX, importerLayout.bottom + laneGapY, sideWidth, 36, "#ffad42", "enable full-flow or increase neighbor budget", "", false, true, "");
    }

    var importSpread = Math.min(52, Math.max(14, importNodes.length * 2));
    var importerSpread = Math.min(52, Math.max(14, importerNodes.length * 2));
    for (var k = 0; k < importNodes.length; k++) {
      drawFlowEdge(edgeLayer, importNodes[k], center, "#35c98f", false, { rank: k, total: importNodes.length, spread: importSpread });
    }
    for (var m = 0; m < importerNodes.length; m++) {
      drawFlowEdge(edgeLayer, center, importerNodes[m], "#ffad42", false, { rank: m, total: importerNodes.length, spread: importerSpread });
    }

    if (proofRelated.length) {
      laneLabel("Proof pair context", centerX, proofStartY - 16, "#d37cff");
      var proofY = proofStartY;
      for (var n = 0; n < proofRelated.length; n++) {
        var proofHeight = nodeContentHeight(proofRelated[n], moduleSummary(proofRelated[n]), centerWidth, true);
        var proofNode = createNode(proofRelated[n], centerX, proofY, centerWidth, proofHeight, "#d37cff", moduleSummary(proofRelated[n]), nodeTooltip(proofRelated[n], "Proof-pair neighbor"), false, false, contextFor(proofRelated[n]).assurance.level);
        drawFlowEdge(edgeLayer, center, proofNode, "#d37cff", true, { rank: n, total: proofRelated.length, spread: 18 });
        proofY += proofHeight + 8;
      }
    }

    if (linkedPath.length > 1) {
      laneLabel("Nearest linked-proof path (radius " + state.impactRadius + ")", Math.max(framePad, centerX - 180), pathStartY - 14, "#6de2ff");
      var previousNode = center;
      for (var q = 1; q < linkedPath.length; q++) {
        var maxPathX = Math.max(framePad, flowWidth - framePad - 220);
        var pathX = Math.min(maxPathX, Math.max(framePad, centerX - 180) + (q - 1) * 230);
        var pathHeight = nodeContentHeight(linkedPath[q], moduleSummary(linkedPath[q]), 240, true);
        var pathNode = createNode(linkedPath[q], pathX, pathStartY, 240, pathHeight, "#6de2ff", moduleSummary(linkedPath[q]), nodeTooltip(linkedPath[q], "Linked-proof path step " + q), false, false, contextFor(linkedPath[q]).assurance.level);
        drawFlowEdge(edgeLayer, previousNode, pathNode, "#6de2ff", true, { rank: q - 1, total: Math.max(1, linkedPath.length - 1), spread: 12 });
        previousNode = pathNode;
      }
    }

    laneLabel("External imports", leftX, externalStartY - 10, "#b9c0d0");
    if (!external.length) {
      createNode("No external imports detected", leftX, externalStartY, sideWidth, 36, "#b9c0d0", "", "", false, true, "");
    } else {
      var externalWidth = Math.max(180, Math.floor((flowWidth - framePad * 2 - (externalPerRow - 1) * 12) / externalPerRow));
      for (var z = 0; z < external.length; z++) {
        var row = Math.floor(z / externalPerRow);
        var col = z % externalPerRow;
        var externalX = leftX + col * (externalWidth + 12);
        var externalHeight = nodeContentHeight(external[z], "", externalWidth, true);
        createNode(external[z], externalX, externalStartY + row * 56, externalWidth, externalHeight, "#b9c0d0", "", "", false, true, "");
      }
      if (allExternal.length > external.length) {
        createNode("+" + (allExternal.length - external.length) + " more", leftX, externalStartY + externalRows * 56, externalWidth, 36, "#b9c0d0", "", "", false, true, "");
      }
    }

    wrap.appendChild(svg);

    var insightRow = document.createElement("div");
    insightRow.className = "flowchart-insight-row";
    insightRow.setAttribute("role", "list");
    var insightItems = [
      "Imports shown " + imports.length + "/" + allImports.length,
      "Impacted shown " + importers.length + "/" + allImporters.length,
      "Proof neighbors " + proofRelated.length,
      "Linked path steps " + Math.max(0, linkedPath.length - 1),
      "External shown " + external.length + "/" + allExternal.length
    ];
    for (var aa = 0; aa < insightItems.length; aa++) {
      var badge = document.createElement("span");
      badge.className = "flowchart-insight";
      badge.setAttribute("role", "listitem");
      badge.textContent = insightItems[aa];
      insightRow.appendChild(badge);
    }
    wrap.appendChild(insightRow);

    var summary = document.createElement("p");
    summary.className = "panel-note flowchart-summary";
    summary.textContent = "Flow summary (" + state.flowMode + " mode" + (state.flowShowAll ? ", full-flow" : "") + "): imports=" + allImports.length + ", impacted modules=" + allImporters.length + ", proof neighbors=" + proofRelated.length + ", linked-path length=" + (linkedPath.length || 0) + ", external imports=" + allExternal.length + ". Hover any node for module path + theorem/fan-in/fan-out metadata. Node tint conveys assurance state.";
    wrap.appendChild(summary);
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
    renderContextChooser();
    renderFlowchart();
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
      scheduleRender();
      syncUrlState();
      setStatus("Map ready. Integrated dependency/proof flow graph loaded.", false);
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
    var flowMode = document.getElementById("flow-mode");
    var flowShowAll = document.getElementById("flow-show-all");
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
      state.activeLayerFilter = focus ? focus.value : "all";
      state.activeSort = sort ? sort.value : "hotspot";
      state.neighborLimit = neighborLimit ? Math.max(4, Math.min(20, Number(neighborLimit.value) || 12)) : 12;
      state.impactRadius = impactRadius ? Math.max(1, Math.min(3, Number(impactRadius.value) || 2)) : 2;
      state.flowMode = flowMode && /^(balanced|imports|impact)$/.test(flowMode.value) ? flowMode.value : "balanced";
      state.flowShowAll = flowShowAll ? flowShowAll.checked : false;
      state.proofLinkedOnly = proofLinkedOnly ? proofLinkedOnly.checked : false;
      syncUrlState();
      scheduleRender();
      if (state.selectedModule) renderDetails(state.selectedModule);
    }

    if (search) {
      function matchModule(query, list) {
        var value = (query || "").trim();
        if (!value) return "";
        var direct = sanitizeModuleName(value);
        if (direct && state.moduleMap[direct]) return direct;
        var lower = value.toLowerCase();
        for (var i = 0; i < list.length; i++) {
          var name = list[i];
          var path = state.moduleMap[name] || "";
          if (name.toLowerCase().indexOf(lower) === 0 || path.toLowerCase().indexOf(lower) !== -1) return name;
        }
        return "";
      }

      var choose = function () {
        var list = contextList();
        var match = matchModule(search.value, list);
        if (match) selectModule(match, false);
      };

      search.addEventListener("change", choose);
      search.addEventListener("keydown", function (event) {
        if (event.key !== "Enter") return;
        choose();
        event.preventDefault();
      });
      search.addEventListener("input", function () {
        var list = contextList();
        var match = matchModule(search.value, list);
        if (match && match !== state.selectedModule) selectModule(match, false);
      });
    }
    if (focus) focus.addEventListener("change", apply);
    if (sort) sort.addEventListener("change", apply);
    if (neighborLimit) neighborLimit.addEventListener("change", apply);
    if (impactRadius) impactRadius.addEventListener("change", apply);
    if (flowMode) flowMode.addEventListener("change", apply);
    if (flowShowAll) flowShowAll.addEventListener("change", apply);
    if (proofLinkedOnly) proofLinkedOnly.addEventListener("change", apply);

    if (reset) {
      reset.addEventListener("click", function () {
        if (search && state.selectedModule) search.value = state.selectedModule;
        if (focus) focus.value = "all";
        if (sort) sort.value = "hotspot";
        if (neighborLimit) neighborLimit.value = "12";
        if (impactRadius) impactRadius.value = "2";
        if (flowMode) flowMode.value = "balanced";
        if (flowShowAll) flowShowAll.checked = false;
        if (proofLinkedOnly) proofLinkedOnly.checked = false;
        apply();
      });
    }
  }

  function setupKeyboardNavigation() {
    document.addEventListener("keydown", function (event) {
      var target = event.target;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      var key = (event.key || "").toLowerCase();
      if (key !== "j" && key !== "k") return;
      var list = contextList();
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

    var radius = Number(params.get("radius") || "2");
    if (radius >= 1 && radius <= 3) state.impactRadius = radius;

    var mode = params.get("mode") || "balanced";
    if (/^(balanced|imports|impact)$/.test(mode)) state.flowMode = mode;

    state.proofLinkedOnly = params.get("linked") === "1";
    state.flowShowAll = params.get("fullflow") === "1";
  }

  function syncUrlState() {
    var params = new URLSearchParams(window.location.search);
    if (state.selectedModule) params.set("module", state.selectedModule); else params.delete("module");
    if (state.activeLayerFilter && state.activeLayerFilter !== "all") params.set("layer", state.activeLayerFilter); else params.delete("layer");
    if (state.activeSort && state.activeSort !== "hotspot") params.set("sort", state.activeSort); else params.delete("sort");
    if (state.impactRadius && state.impactRadius !== 2) params.set("radius", String(state.impactRadius)); else params.delete("radius");
    if (state.flowMode && state.flowMode !== "balanced") params.set("mode", state.flowMode); else params.delete("mode");
    if (state.proofLinkedOnly) params.set("linked", "1"); else params.delete("linked");
    if (state.flowShowAll) params.set("fullflow", "1"); else params.delete("fullflow");

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
    var mode = document.getElementById("flow-mode");
    var flowShowAll = document.getElementById("flow-show-all");
    var linked = document.getElementById("proof-linked-only");
    if (search && state.selectedModule) search.value = state.selectedModule;
    if (focus) focus.value = state.activeLayerFilter;
    if (sort) sort.value = state.activeSort;
    if (radius) radius.value = String(state.impactRadius);
    if (mode) mode.value = state.flowMode;
    if (flowShowAll) flowShowAll.checked = Boolean(state.flowShowAll);
    if (linked) linked.checked = Boolean(state.proofLinkedOnly);
  }

  function setupFlowchartResize() {
    var queued = false;
    window.addEventListener("resize", function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(function () {
        queued = false;
        scheduleRender();
      });
    }, { passive: true });
  }


  function boot() {
    setupTheme();
    setupNav();
    hardenExternalLinks();
    readUrlState();
    setupFilters();
    setupKeyboardNavigation();
    setupFlowchartResize();
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
