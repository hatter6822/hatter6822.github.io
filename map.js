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

  var CACHE_KEY = "sele4n-code-map-v3";
  var CACHE_TTL_MS = 60 * 60 * 1000;
  var FETCH_CONCURRENCY = 8;
  var FETCH_TIMEOUT_MS = 9000;
  var NODE_CACHE = Object.create(null);

  var state = {
    files: [], directories: [], modules: [], moduleMap: Object.create(null), moduleMeta: Object.create(null),
    importsTo: Object.create(null), importsFrom: Object.create(null), externalImportsFrom: Object.create(null),
    theoremPairs: [], selectedModule: null, selectedPair: null, activeFilterText: "", activeLayerFilter: "all", activeSort: "hotspot"
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
    var meta = state.moduleMeta[name] || {};
    var theorems = meta.theorems || 0;
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
    var ops = base + ".Operations";
    var inv = base + ".Invariant";
    var out = [];
    if (state.moduleMap[ops] && ops !== name) out.push(ops);
    if (state.moduleMap[inv] && inv !== name) out.push(inv);
    return out;
  }

  function renderDetails(name) {
    var panel = document.getElementById("details-panel");
    if (!panel || !name) return;
    state.selectedModule = name;

    var meta = state.moduleMeta[name] || {};
    var degree = moduleDegree(name);
    var modulePath = state.moduleMap[name] || "Unknown";

    panel.innerHTML = "";
    var title = document.createElement("h2");
    title.className = "section-title-sm";
    title.textContent = name;
    panel.appendChild(title);

    var info = [
      "Path: " + modulePath,
      "Layer: " + (meta.layer || "other") + " | Kind: " + (meta.kind || "other"),
      "Theorems: " + degree.theorems + " | Fan-in: " + degree.incoming + " | Fan-out: " + degree.outgoing,
      "Walkthrough score: " + degree.score
    ];
    for (var i = 0; i < info.length; i++) {
      var p = document.createElement("p");
      p.className = "panel-note";
      p.textContent = info[i];
      panel.appendChild(p);
    }

    appendList(panel, "Related proof modules", relatedProofModules(name), 6);
    appendList(panel, "Imports (internal)", state.importsFrom[name] || [], 40);
    appendList(panel, "Imported by", state.importsTo[name] || [], 40);
    appendList(panel, "External imports", state.externalImportsFrom[name] || [], 20);
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
        var dt = moduleDegree(b).theorems - moduleDegree(a).theorems;
        return dt || moduleDegree(b).score - moduleDegree(a).score;
      }
      var d = moduleDegree(b).score - moduleDegree(a).score;
      return d || a.localeCompare(b);
    });
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

    var limit = Math.min(list.length, 90);
    for (var i = 0; i < limit; i++) {
      var name = list[i];
      var meta = state.moduleMeta[name] || {};
      var deg = moduleDegree(name);

      var card = document.createElement("button");
      card.type = "button";
      card.className = "walk-card" + (state.selectedModule === name ? " selected" : "");
      card.setAttribute("aria-label", name + " walkthrough score " + deg.score);

      var h = document.createElement("h3");
      h.textContent = name;
      var metaLine = document.createElement("p");
      metaLine.className = "walk-meta";
      metaLine.textContent = "layer=" + meta.layer + " | kind=" + meta.kind + " | theorems=" + deg.theorems;
      var degreeLine = document.createElement("p");
      degreeLine.className = "walk-score";
      degreeLine.textContent = "score=" + deg.score + " (in:" + deg.incoming + ", out:" + deg.outgoing + ")";

      card.appendChild(h);
      card.appendChild(metaLine);
      card.appendChild(degreeLine);
      card.addEventListener("click", (function (moduleName) {
        return function () {
          renderDetails(moduleName);
          syncUrlState();
          renderAll();
        };
      })(name));
      wrap.appendChild(card);
    }
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
      var deg = moduleDegree(name);

      var tr = document.createElement("tr");
      tr.setAttribute("data-module", name);
      if (state.selectedModule === name) tr.className = "selected-row";
      tr.innerHTML = "<td></td><td></td><td></td><td></td><td></td>";
      tr.children[0].textContent = name;
      tr.children[1].textContent = meta.layer || "other";
      tr.children[2].textContent = String(deg.theorems);
      tr.children[3].textContent = String(deg.incoming);
      tr.children[4].textContent = String(deg.outgoing);
      tr.addEventListener("click", (function (moduleName) {
        return function () {
          renderDetails(moduleName);
          syncUrlState();
          renderAll();
        };
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
    if (pair.operationsModule) steps.push("1) Inspect executable transitions in " + pair.operationsModule + ".");
    if (pair.invariantModule) steps.push("2) Inspect invariant statements and proofs in " + pair.invariantModule + ".");
    steps.push("3) Follow dependencies from module details to validate assumptions imported into proofs.");
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
      var linked = false;
      if (ops && inv) linked = (state.importsFrom[inv] || []).indexOf(ops) !== -1;
      pairs.push({
        base: base,
        operationsModule: ops,
        invariantModule: inv,
        operationsTheorems: ops && state.moduleMeta[ops] ? state.moduleMeta[ops].theorems : 0,
        invariantTheorems: inv && state.moduleMeta[inv] ? state.moduleMeta[inv].theorems : 0,
        invariantImportsOperations: linked
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
    updateMetric("directories", state.directories.length);
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
          if (selectedPair.operationsModule) renderDetails(selectedPair.operationsModule);
          syncUrlState();
          renderAll();
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
        if (j === parts.length - 1) {
          node.files.push(part);
        } else {
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
    var ix = 0;
    function runner() {
      if (ix >= items.length) return Promise.resolve();
      var cur = ix++;
      return Promise.resolve(worker(items[cur])).then(runner);
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
    } catch (e) { return null; }
  }

  function setCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data })); } catch (e) {}
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
    if (state.selectedModule) renderDetails(state.selectedModule);
    renderAll();
  }

  function fetchAndBuildData() {
    setStatus("Loading repository tree…", false);

    return safeFetch(API + "/git/trees/" + REF + "?recursive=1", false).then(function (payload) {
      var tree = payload && payload.tree ? payload.tree : [];
      var files = tree.filter(function (entry) { return entry.type === "blob"; }).map(function (entry) { return entry.path; });
      var directories = tree.filter(function (entry) { return entry.type === "tree"; }).map(function (entry) { return entry.path; });
      var leanFiles = files.filter(function (p) { return /^SeLe4n\/.*\.lean$/.test(p); });

      state.files = files;
      state.directories = directories;
      state.modules = leanFiles.map(moduleFromPath);
      state.moduleMap = Object.create(null);
      state.moduleMeta = Object.create(null);
      state.importsTo = Object.create(null);
      state.importsFrom = Object.create(null);
      state.externalImportsFrom = Object.create(null);

      for (var i = 0; i < state.modules.length; i++) {
        state.moduleMap[state.modules[i]] = leanFiles[i];
      }

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
      if (state.selectedModule) renderDetails(state.selectedModule);
      renderAll();
      syncUrlState();
      setStatus("Map ready. Walkthrough and proof-trace data loaded.", false);
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
      syncUrlState();
      renderAll();
    }

    if (search) search.addEventListener("input", apply);
    if (focus) focus.addEventListener("change", apply);
    if (sort) sort.addEventListener("change", apply);
    if (reset) {
      reset.addEventListener("click", function () {
        if (search) search.value = "";
        if (focus) focus.value = "all";
        if (sort) sort.value = "hotspot";
        state.selectedPair = null;
        apply();
      });
    }
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
