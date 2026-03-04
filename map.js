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

  var CACHE_KEY = "sele4n-code-map-v2";
  var CACHE_TTL_MS = 60 * 60 * 1000;
  var CACHE_SCHEMA = 2;
  var FETCH_CONCURRENCY = 8;

  var LIVE_NODE_CACHE = Object.create(null);

  var state = {
    files: [],
    directories: [],
    modules: [],
    moduleMap: Object.create(null),
    moduleMeta: Object.create(null),
    importsTo: Object.create(null),
    importsFrom: Object.create(null),
    externalImportsFrom: Object.create(null),
    theoremPairs: [],
    theoremTotals: {
      totalTheorems: 0,
      theoremModules: 0,
      pairCount: 0,
      linkedPairCount: 0
    },
    selectedModule: null,
    activeFilterText: "",
    activeLayerFilter: "all"
  };

  function updateMapMetric(key, value) {
    var nodes = LIVE_NODE_CACHE[key];
    if (!nodes) {
      nodes = document.querySelectorAll('[data-map="' + key + '"]');
      LIVE_NODE_CACHE[key] = nodes;
    }
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = String(value);
  }

  function updateStatus(message, isError) {
    var status = document.getElementById("map-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
  }

  function safeFetchJSON(url) {
    return fetch(url, FETCH_OPTIONS).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function safeFetchText(url) {
    return fetch(url, FETCH_OPTIONS).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    });
  }

  function setTheme(theme) {
    var root = document.documentElement;
    var themeColorMeta = document.getElementById("theme-color-meta");
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem("sele4n-theme", theme); } catch (e) {}
    if (themeColorMeta) themeColorMeta.setAttribute("content", theme === "light" ? "#f8f9fc" : "#0a0e17");
  }

  function setupTheme() {
    var root = document.documentElement;
    var toggle = document.getElementById("theme-toggle");
    if (!root.getAttribute("data-theme")) setTheme("dark");

    if (toggle) {
      toggle.addEventListener("click", function () {
        var current = root.getAttribute("data-theme") || "dark";
        setTheme(current === "dark" ? "light" : "dark");
      });
    }
  }

  function hardenExternalLinks() {
    var anchors = document.querySelectorAll('a[target="_blank"]');
    for (var i = 0; i < anchors.length; i++) {
      var isExternal = false;
      try {
        var parsed = new URL(anchors[i].href, window.location.href);
        isExternal = parsed.origin !== window.location.origin;
      } catch (e) {}
      if (!isExternal) continue;

      var rel = anchors[i].getAttribute("rel") || "";
      var tokens = rel.split(/\s+/).filter(Boolean);
      if (tokens.indexOf("noopener") === -1) tokens.push("noopener");
      if (tokens.indexOf("noreferrer") === -1) tokens.push("noreferrer");
      anchors[i].setAttribute("rel", tokens.join(" "));
    }
  }

  function classifyLayer(moduleName) {
    if (/\.Model\./.test(moduleName)) return "model";
    if (/\.Kernel\./.test(moduleName)) return "kernel";
    if (/\.Security\./.test(moduleName) || /\.IFC\./.test(moduleName)) return "security";
    if (/\.Platform\./.test(moduleName) || /\.Hardware\./.test(moduleName)) return "platform";
    return "other";
  }

  function moduleFromPath(path) {
    return path.replace(/\.lean$/, "").replace(/\//g, ".");
  }

  function isInternalModule(moduleName) {
    return Object.prototype.hasOwnProperty.call(state.moduleMap, moduleName);
  }

  function detectModuleKind(moduleName) {
    if (/\.Operations$/.test(moduleName)) return "operations";
    if (/\.Invariant$/.test(moduleName)) return "invariant";
    return "other";
  }

  function moduleBaseName(moduleName) {
    return moduleName.replace(/\.(Operations|Invariant)$/, "");
  }

  function parseImportTokens(line) {
    var importLine = line.slice(7).split("--")[0].trim();
    if (!importLine) return [];
    return importLine.split(/\s+/).filter(Boolean);
  }

  function countTheoremDecls(sourceText) {
    var matches = sourceText.match(/^\s*(?:theorem|lemma)\s+[\w'.`]+/gm);
    return matches ? matches.length : 0;
  }

  function parseModule(moduleName, sourceText) {
    var imports = [];
    var seenInternal = Object.create(null);
    var seenExternal = Object.create(null);
    var externalImports = [];
    var lines = sourceText.split(/\r?\n/);

    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (trimmed.indexOf("import ") !== 0) continue;

      var deps = parseImportTokens(trimmed);
      for (var j = 0; j < deps.length; j++) {
        var dep = deps[j];
        if (isInternalModule(dep)) {
          if (seenInternal[dep]) continue;
          seenInternal[dep] = true;
          imports.push(dep);
        } else {
          if (seenExternal[dep]) continue;
          seenExternal[dep] = true;
          externalImports.push(dep);
        }
      }
    }

    state.importsFrom[moduleName] = imports;
    state.externalImportsFrom[moduleName] = externalImports;

    for (var k = 0; k < imports.length; k++) {
      var target = imports[k];
      if (!state.importsTo[target]) state.importsTo[target] = [];
      state.importsTo[target].push(moduleName);
    }

    var kind = detectModuleKind(moduleName);
    var base = moduleBaseName(moduleName);
    var theoremCount = countTheoremDecls(sourceText);
    var meta = state.moduleMeta[moduleName] || {};
    meta.layer = classifyLayer(moduleName);
    meta.kind = kind;
    meta.base = base;
    meta.theorems = theoremCount;
    state.moduleMeta[moduleName] = meta;
  }

  function countImports(moduleName) {
    var outgoing = state.importsFrom[moduleName] || [];
    var incoming = state.importsTo[moduleName] || [];
    return {
      incoming: incoming.length,
      outgoing: outgoing.length,
      total: incoming.length + outgoing.length
    };
  }

  function computeTheoremPairs() {
    var groups = Object.create(null);
    var totals = {
      totalTheorems: 0,
      theoremModules: 0,
      pairCount: 0,
      linkedPairCount: 0
    };

    for (var i = 0; i < state.modules.length; i++) {
      var moduleName = state.modules[i];
      var meta = state.moduleMeta[moduleName] || {};
      var theoremCount = meta.theorems || 0;
      totals.totalTheorems += theoremCount;
      if (theoremCount > 0) totals.theoremModules += 1;

      if (meta.kind !== "operations" && meta.kind !== "invariant") continue;
      if (!groups[meta.base]) groups[meta.base] = {};
      groups[meta.base][meta.kind] = moduleName;
    }

    var pairs = [];
    for (var base in groups) {
      var operationsModule = groups[base].operations || "";
      var invariantModule = groups[base].invariant || "";
      if (!operationsModule && !invariantModule) continue;

      var invImportsOps = false;
      if (invariantModule && operationsModule) {
        var deps = state.importsFrom[invariantModule] || [];
        invImportsOps = deps.indexOf(operationsModule) !== -1;
      }

      pairs.push({
        base: base,
        operationsModule: operationsModule,
        invariantModule: invariantModule,
        operationsPath: operationsModule ? state.moduleMap[operationsModule] : "",
        invariantPath: invariantModule ? state.moduleMap[invariantModule] : "",
        operationsTheorems: operationsModule && state.moduleMeta[operationsModule] ? state.moduleMeta[operationsModule].theorems : 0,
        invariantTheorems: invariantModule && state.moduleMeta[invariantModule] ? state.moduleMeta[invariantModule].theorems : 0,
        invariantImportsOperations: invImportsOps
      });
    }

    pairs.sort(function (a, b) {
      var ta = (a.operationsTheorems || 0) + (a.invariantTheorems || 0);
      var tb = (b.operationsTheorems || 0) + (b.invariantTheorems || 0);
      if (tb !== ta) return tb - ta;
      return a.base.localeCompare(b.base);
    });

    totals.pairCount = pairs.length;
    for (var j = 0; j < pairs.length; j++) {
      if (pairs[j].operationsModule && pairs[j].invariantModule && pairs[j].invariantImportsOperations) totals.linkedPairCount += 1;
    }

    state.theoremPairs = pairs;
    state.theoremTotals = totals;
  }

  function updateStats() {
    var importEdges = 0;
    for (var i = 0; i < state.modules.length; i++) {
      importEdges += (state.importsFrom[state.modules[i]] || []).length;
    }

    updateMapMetric("files", state.files.length);
    updateMapMetric("directories", state.directories.length);
    updateMapMetric("leanModules", state.modules.length);
    updateMapMetric("importEdges", importEdges);
    updateMapMetric("theorems", state.theoremTotals.totalTheorems || 0);
    updateMapMetric("proofPairs", state.theoremTotals.pairCount || 0);
    updateMapMetric("linkedPairs", state.theoremTotals.linkedPairCount || 0);
  }

  function renderFocusOptions() {
    var select = document.getElementById("focus-select");
    if (!select) return;

    while (select.options.length > 1) select.remove(1);

    var options = ["model", "kernel", "security", "platform", "other"];
    for (var i = 0; i < options.length; i++) {
      var opt = document.createElement("option");
      opt.value = options[i];
      opt.textContent = options[i][0].toUpperCase() + options[i].slice(1);
      select.appendChild(opt);
    }
  }

  function appendList(panel, titleText, items, maxItems) {
    var title = document.createElement("h3");
    title.className = "section-title-sm";
    title.textContent = titleText;
    panel.appendChild(title);

    var list = document.createElement("ul");
    list.className = "detail-list";

    if (!items.length) {
      var empty = document.createElement("li");
      empty.textContent = "(none)";
      list.appendChild(empty);
    } else {
      var limit = Math.min(maxItems || items.length, items.length);
      for (var i = 0; i < limit; i++) {
        var li = document.createElement("li");
        li.textContent = items[i];
        list.appendChild(li);
      }
      if (items.length > limit) {
        var more = document.createElement("li");
        more.textContent = "… and " + (items.length - limit) + " more";
        list.appendChild(more);
      }
    }

    panel.appendChild(list);
  }

  function relatedProofModules(moduleName) {
    var meta = state.moduleMeta[moduleName] || {};
    var base = meta.base || moduleBaseName(moduleName);
    var operationsModule = base + ".Operations";
    var invariantModule = base + ".Invariant";
    var list = [];

    if (isInternalModule(operationsModule) && operationsModule !== moduleName) list.push(operationsModule);
    if (isInternalModule(invariantModule) && invariantModule !== moduleName) list.push(invariantModule);

    return list;
  }

  function renderDetails(moduleName) {
    var panel = document.getElementById("details-panel");
    if (!panel || !moduleName) return;

    state.selectedModule = moduleName;

    var outgoing = state.importsFrom[moduleName] || [];
    var incoming = state.importsTo[moduleName] || [];
    var external = state.externalImportsFrom[moduleName] || [];
    var modulePath = state.moduleMap[moduleName] || "Unknown path";
    var meta = state.moduleMeta[moduleName] || {};
    var related = relatedProofModules(moduleName);

    panel.innerHTML = "";

    var title = document.createElement("h2");
    title.className = "section-title-sm";
    title.textContent = moduleName;

    var path = document.createElement("p");
    path.className = "panel-note";
    path.textContent = modulePath;

    var metaInfo = document.createElement("p");
    metaInfo.className = "panel-note";
    metaInfo.textContent = "Layer: " + (meta.layer || "other") + " | Kind: " + (meta.kind || "other") + " | Theorem declarations: " + (meta.theorems || 0);

    var fan = document.createElement("p");
    fan.className = "panel-note";
    fan.textContent = "Fan-in: " + incoming.length + " | Fan-out: " + outgoing.length + " | External imports: " + external.length;

    panel.appendChild(title);
    panel.appendChild(path);
    panel.appendChild(metaInfo);
    panel.appendChild(fan);

    appendList(panel, "Related proof modules", related, 8);
    appendList(panel, "Imports (internal)", outgoing, 60);
    appendList(panel, "Imported by", incoming, 60);
    appendList(panel, "External imports", external, 30);
  }

  function renderGraph() {
    var wrap = document.getElementById("graph-wrap");
    if (!wrap) return;

    var query = (state.activeFilterText || "").trim().toLowerCase();
    var layerFilter = state.activeLayerFilter || "all";

    wrap.innerHTML = "";

    var grid = document.createElement("div");
    grid.className = "bubble-grid";

    var ranked = state.modules.slice().sort(function (a, b) {
      return countImports(b).total - countImports(a).total;
    });

    for (var i = 0; i < ranked.length; i++) {
      var moduleName = ranked[i];
      var meta = state.moduleMeta[moduleName] || {};
      var layer = meta.layer || classifyLayer(moduleName);
      var modulePath = state.moduleMap[moduleName] || "";

      if (layerFilter !== "all" && layer !== layerFilter) continue;
      if (query && moduleName.toLowerCase().indexOf(query) === -1 && modulePath.toLowerCase().indexOf(query) === -1) continue;

      var degree = countImports(moduleName);
      var bubble = document.createElement("button");
      bubble.type = "button";
      bubble.className = "bubble layer-" + layer + (state.selectedModule === moduleName ? " selected" : "");
      bubble.style.minHeight = Math.min(10.5, 4.7 + degree.total * 0.17) + "rem";
      bubble.textContent = moduleName.split(".").slice(-1)[0] + " (" + degree.total + ")";
      bubble.title = moduleName;
      bubble.setAttribute("aria-label", moduleName + ", total degree " + degree.total + ", theorems " + (meta.theorems || 0));
      bubble.addEventListener("click", (function (name) {
        return function () {
          renderDetails(name);
          renderAll();
        };
      })(moduleName));
      grid.appendChild(bubble);
    }

    if (!grid.children.length) {
      wrap.textContent = "No modules matched the current filters.";
      return;
    }

    wrap.appendChild(grid);
  }

  function renderModuleTable() {
    var tbody = document.getElementById("module-rows");
    if (!tbody) return;

    tbody.innerHTML = "";

    var query = (state.activeFilterText || "").trim().toLowerCase();
    var layerFilter = state.activeLayerFilter || "all";

    var rows = state.modules.slice().sort(function (a, b) {
      return countImports(b).total - countImports(a).total;
    });

    for (var i = 0; i < rows.length; i++) {
      var moduleName = rows[i];
      var meta = state.moduleMeta[moduleName] || {};
      var layer = meta.layer || classifyLayer(moduleName);
      var modulePath = state.moduleMap[moduleName] || "";

      if (layerFilter !== "all" && layer !== layerFilter) continue;
      if (query && moduleName.toLowerCase().indexOf(query) === -1 && modulePath.toLowerCase().indexOf(query) === -1) continue;

      var degree = countImports(moduleName);
      var tr = document.createElement("tr");
      tr.setAttribute("data-module", moduleName);
      if (state.selectedModule === moduleName) tr.className = "selected-row";

      var tdName = document.createElement("td");
      tdName.textContent = moduleName;
      var tdLayer = document.createElement("td");
      tdLayer.textContent = layer;
      var tdIn = document.createElement("td");
      tdIn.textContent = String(degree.incoming);
      var tdOut = document.createElement("td");
      tdOut.textContent = String(degree.outgoing);

      tr.appendChild(tdName);
      tr.appendChild(tdLayer);
      tr.appendChild(tdIn);
      tr.appendChild(tdOut);

      tr.addEventListener("click", (function (name) {
        return function () {
          renderDetails(name);
          renderAll();
        };
      })(moduleName));

      tbody.appendChild(tr);
    }
  }

  function renderProofTable() {
    var tbody = document.getElementById("proof-rows");
    if (!tbody) return;
    tbody.innerHTML = "";

    for (var i = 0; i < state.theoremPairs.length; i++) {
      var row = state.theoremPairs[i];
      var tr = document.createElement("tr");

      var tdBase = document.createElement("td");
      tdBase.textContent = row.base;

      var tdOps = document.createElement("td");
      tdOps.textContent = row.operationsModule ? row.operationsModule : "—";

      var tdInv = document.createElement("td");
      tdInv.textContent = row.invariantModule ? row.invariantModule : "—";

      var tdTheo = document.createElement("td");
      tdTheo.textContent = String((row.operationsTheorems || 0) + (row.invariantTheorems || 0));

      var tdLink = document.createElement("td");
      tdLink.textContent = row.invariantImportsOperations ? "linked" : "unlinked";
      tdLink.className = row.invariantImportsOperations ? "proof-good" : "proof-warn";

      tr.appendChild(tdBase);
      tr.appendChild(tdOps);
      tr.appendChild(tdInv);
      tr.appendChild(tdTheo);
      tr.appendChild(tdLink);

      tbody.appendChild(tr);
    }
  }

  function buildTree(paths) {
    var root = {};

    for (var i = 0; i < paths.length; i++) {
      var parts = paths[i].split("/");
      var cursor = root;
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        if (!cursor[part]) cursor[part] = {};
        cursor = cursor[part];
        if (j === parts.length - 1) cursor.__file = true;
      }
    }

    return root;
  }

  function renderTreeNode(name, node, depth) {
    var container = document.createElement("div");
    container.style.paddingLeft = Math.min(depth * 0.55, 2.2) + "rem";

    var keys = Object.keys(node).filter(function (key) { return key !== "__file"; }).sort();

    if (!keys.length) {
      container.className = "tree-leaf";
      container.textContent = name;
      return container;
    }

    var details = document.createElement("details");
    if (depth < 1) details.open = true;

    var summary = document.createElement("summary");
    summary.textContent = name;
    details.appendChild(summary);

    for (var i = 0; i < keys.length; i++) {
      details.appendChild(renderTreeNode(keys[i], node[keys[i]], depth + 1));
    }

    container.appendChild(details);
    return container;
  }

  function renderDirectoryTree() {
    var wrap = document.getElementById("tree-wrap");
    if (!wrap) return;

    wrap.innerHTML = "";
    var tree = buildTree(state.files);
    var rootKeys = Object.keys(tree).sort();

    for (var i = 0; i < rootKeys.length; i++) {
      wrap.appendChild(renderTreeNode(rootKeys[i], tree[rootKeys[i]], 0));
    }
  }

  function renderAll() {
    renderGraph();
    renderModuleTable();
    renderProofTable();
  }

  function getCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (cached.schema !== CACHE_SCHEMA) return null;
      if (Date.now() - cached.ts > CACHE_TTL_MS) return null;
      return cached.data;
    } catch (e) {
      return null;
    }
  }

  function setCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: CACHE_SCHEMA, ts: Date.now(), data: data }));
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

    computeTheoremPairs();
    updateStats();
    renderFocusOptions();
    renderDirectoryTree();

    if (state.modules.length > 0) {
      state.selectedModule = state.selectedModule && isInternalModule(state.selectedModule) ? state.selectedModule : state.modules[0];
      renderDetails(state.selectedModule);
    }

    renderAll();
  }

  function runInPool(items, worker, maxConcurrent) {
    var index = 0;

    function launch() {
      if (index >= items.length) return Promise.resolve();
      var current = index;
      index += 1;
      return Promise.resolve(worker(items[current], current)).then(launch);
    }

    var runners = [];
    var runnerCount = Math.min(maxConcurrent, items.length);
    for (var i = 0; i < runnerCount; i++) runners.push(launch());
    return Promise.all(runners);
  }

  function fetchAndBuildData() {
    updateStatus("Loading repository tree…", false);

    return safeFetchJSON(API + "/git/trees/" + REF + "?recursive=1").then(function (treePayload) {
      var tree = treePayload && treePayload.tree ? treePayload.tree : [];
      var files = tree.filter(function (entry) { return entry.type === "blob"; }).map(function (entry) { return entry.path; });
      var directories = tree.filter(function (entry) { return entry.type === "tree"; }).map(function (entry) { return entry.path; });
      var leanFiles = files.filter(function (path) { return /^SeLe4n\/.*\.lean$/.test(path); });
      var modules = leanFiles.map(moduleFromPath);
      var moduleMap = Object.create(null);
      var moduleMeta = Object.create(null);

      for (var i = 0; i < modules.length; i++) {
        moduleMap[modules[i]] = leanFiles[i];
        moduleMeta[modules[i]] = {
          layer: classifyLayer(modules[i]),
          kind: detectModuleKind(modules[i]),
          base: moduleBaseName(modules[i]),
          theorems: 0
        };
      }

      state.files = files;
      state.directories = directories;
      state.modules = modules;
      state.moduleMap = moduleMap;
      state.moduleMeta = moduleMeta;
      state.importsTo = Object.create(null);
      state.importsFrom = Object.create(null);
      state.externalImportsFrom = Object.create(null);

      updateStatus("Analyzing " + leanFiles.length + " Lean modules and proof declarations…", false);

      return runInPool(leanFiles, function (path) {
        var moduleName = moduleFromPath(path);
        return safeFetchText(RAW + path).then(function (text) {
          parseModule(moduleName, text);
        }).catch(function () {
          state.importsFrom[moduleName] = [];
          state.externalImportsFrom[moduleName] = [];
        });
      }, FETCH_CONCURRENCY);
    }).then(function () {
      computeTheoremPairs();
      updateStats();
      renderFocusOptions();
      renderDirectoryTree();

      if (!state.selectedModule || !isInternalModule(state.selectedModule)) {
        state.selectedModule = state.modules.length ? state.modules[0] : null;
      }
      if (state.selectedModule) renderDetails(state.selectedModule);

      renderAll();
      updateStatus("Map ready. Full module and proof relationship data loaded.", false);

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
    var reset = document.getElementById("reset-view");

    function apply() {
      state.activeFilterText = search ? search.value : "";
      state.activeLayerFilter = focus ? focus.value : "all";
      renderAll();
    }

    if (search) search.addEventListener("input", apply);
    if (focus) focus.addEventListener("change", apply);
    if (reset) {
      reset.addEventListener("click", function () {
        if (search) search.value = "";
        if (focus) focus.value = "all";
        apply();
      });
    }
  }

  function boot() {
    setupTheme();
    hardenExternalLinks();
    setupFilters();

    var cached = getCache();
    if (cached) {
      applyData(cached);
      updateStatus("Showing cached map while refreshing…", false);
    }

    fetchAndBuildData().catch(function (error) {
      if (!cached) updateStatus("Unable to load codebase map from GitHub API: " + error.message, true);
      else updateStatus("Refresh failed; showing cached data. " + error.message, true);
    });
  }

  boot();
})();
