(function () {
  "use strict";

  /* i18n helper — returns translated string or empty string for fallback
     chaining. Until the first locale has loaded every lookup falls back to
     English, so the helper also records that something was painted from
     fallbacks: the ready callback registered by setupLocaleReady() repaints
     the generated sections once, and only when that happened. */
  var localeReady = false;
  var paintedBeforeLocale = false;
  function t(key, vars) {
    if (!localeReady) paintedBeforeLocale = true;
    if (window.sele4nI18n && typeof window.sele4nI18n.t === "function") {
      var result = window.sele4nI18n.t(key, vars);
      if (result && result !== key) return result;
    }
    return ""; // callers use: t("key") || "English fallback"
  }

  /* Source links point into the kernel repository at the snapshot's commit.
     Nothing is fetched from it: the page renders the bundled snapshot and
     nothing else (see "Runtime data strategy" in CLAUDE.md), and map.html's
     CSP holds connect-src at 'self' so that stays true. The snapshot is kept
     current by the weekly sync workflow, which runs the one pipeline. */
  var REPO = "hatter6822/seLe4n";
  var REF = "main";
  var DATA_ENDPOINT = "data/map-data.json";

  /* Same-origin only, through the ordinary HTTP cache: the snapshot changes
     when the site is redeployed, and the server's validators decide whether a
     revisit downloads it again. */
  var FETCH_OPTIONS = {
    credentials: "same-origin",
    mode: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer"
  };

  /* Bounds the wait for response headers only; the body is not timed, so a
     slow link still finishes the download. */
  var FETCH_TIMEOUT_MS = 20000;

  /* Storage keys of the retired live-refresh layer: the snapshot cache (which
     never fit the quota) and the sync cooldown. Nothing reads them now; they
     are purged on load so a returning visitor stops carrying them, as
     site.js does for the landing page's retired cache. */
  var LEGACY_STORAGE_KEYS = ["sele4n-code-map-v9", "sele4n-code-map-live-sync-meta-v1"];
  var NAV_INTENT_KEY = "sele4n-nav-intent-v1";
  var NODE_CACHE = Object.create(null);
  var LABEL_WRAP_CACHE = new Map();
  var LABEL_WRAP_CACHE_LIMIT = 1200;
  var LABEL_WRAP_CACHE_EVICT_BATCH = 120;
  var ASSURANCE_CACHE = Object.create(null);

  /* The module the workspace opens on when the URL carries no `module=`: the
     kernel's syscall surface, which every other subsystem composes into. */
  var DEFAULT_MODULE = "SeLe4n.Kernel.API";

  /* Rust item kinds reuse the Lean declaration palette so one colour means one
     thing across both halves of the production code. */
  var RUST_ITEM_COLOR_MAP = {
    fn: "#82f0b0",
    struct: "#72d5ff",
    "enum": "#8ecbff",
    union: "#ff9fb0",
    trait: "#6ae3d8",
    type: "#8be4cb",
    "const": "#ffd782",
    "static": "#ffcb6b",
    mod: "#d0b7ff",
    impl: "#9ec5ff",
    macro: "#63ccff"
  };
  var RUST_ITEM_KIND_ORDER = ["mod", "trait", "struct", "enum", "union", "type", "fn", "const", "static", "impl", "macro"];

  /* The three scopes the workspace can be read in. `lean` is the Lean kernel
     alone, `rust` the Rust workspace alone, and `both` the two together with
     the boundary between them drawn (see BRIDGE_RELATIONS). The scope rides
     the URL as `scope=`, so a reading is linkable. */
  var SCOPES = ["lean", "both", "rust"];
  var DEFAULT_SCOPE = "both";

  /* Where a crate sits relative to the Lean kernel. This is the one editorial
     fact the boundary model needs, and it only ever decides how a matched
     *function* pair is labelled — never whether a pair exists. The four
     entries restate what the crates' own manifests say of themselves ("Safe
     high-level syscall wrappers", "ARM64 register ABI layer", "ARM64 Hardware
     Abstraction Layer", "Core types"). A crate the table does not name is
     "shared": it gets no direction rather than a guessed one. */
  var RUST_CRATE_STRATUM = {
    "sele4n-types": "shared",
    "sele4n-abi": "boundary",
    "sele4n-sys": "userspace",
    "sele4n-hal": "hardware"
  };

  /* Lean declaration kinds that name a thing (as opposed to opening a scope).
     Only these take part in the boundary match: a `namespace ThreadId` is not
     a second declaration of ThreadId. */
  var BRIDGE_LEAN_KINDS = {
    inductive: true, structure: true, "class": true, def: true, theorem: true,
    lemma: true, example: true, instance: true, opaque: true, abbrev: true,
    axiom: true, constant: true
  };

  /* Lean kinds with no Lean body: the declaration exists, the implementation
     is somewhere else. Paired with a Rust `fn` of the same name this is the
     foreign-function seam, and its direction is not a guess. */
  var BRIDGE_FOREIGN_LEAN_KINDS = { opaque: true, axiom: true };

  /* Rust item kinds that can carry a boundary match. `impl` blocks and `mod`
     declarations are named after other things, so they are listed in the
     sidebar but never matched. */
  var BRIDGE_RUST_KINDS = {
    fn: true, struct: true, "enum": true, union: true, trait: true,
    type: true, "const": true, "static": true
  };

  /* The four relations a matched declaration pair can stand in, with the
     direction each implies and the colour that carries it through the chart.
       implements — Lean declares it `opaque`, Rust defines it: the kernel
                    calls down into the HAL.            Lean → Rust
       invokes    — Lean implements it, a user-space crate names the same
                    operation: the wrapper calls up.    Rust → Lean
       mirrors    — Lean implements it and the HAL carries a routine of the
                    same name across the seam: specification and machine
                    code side by side, not a call.      undirected
       shares     — the same type or constant named on both sides: the data
                    that crosses the boundary.          undirected */
  var BRIDGE_RELATIONS = ["implements", "invokes", "mirrors", "shares"];
  var BRIDGE_COLORS = {
    implements: "#ff9068",
    invokes: "#5ed3c0",
    mirrors: "#7f9cf5",
    shares: "#a08bd4"
  };

  /* `implements` and `invokes` are calls and are drawn with an arrowhead.
     `mirrors` and `shares` are not: one is the same routine written either
     side of the seam, the other a definition both sides hold. Drawing either
     with an arrow asserts a call that does not exist, so this is the one place
     that says which relations carry direction. */
  var BRIDGE_UNDIRECTED = { mirrors: true, shares: true };

  /* Rust declaration groups for the sidebar, mirroring the Lean grouping.
     Test items are bucketed under a "test:" kind prefix so one group holds
     them all without a second control. */
  var RUST_KIND_GROUPS = {
    rustTypes: ["struct", "enum", "union", "trait", "type"],
    rustFunctions: ["fn", "const", "static"],
    rustStructure: ["impl", "mod", "macro"]
  };
  var RUST_KIND_GROUP_ORDER = ["rustTypes", "rustFunctions", "rustStructure", "rustTests"];
  var RUST_TEST_KIND_PREFIX = "test:";
  RUST_KIND_GROUPS.rustTests = RUST_ITEM_KIND_ORDER.map(function (kind) { return RUST_TEST_KIND_PREFIX + kind; });
  var RUST_KIND_GROUP_LABELS_EN = {
    rustTypes: "Types",
    rustFunctions: "Functions",
    rustStructure: "Impls/Mods",
    rustTests: "Tests"
  };
  var ALL_RUST_KINDS = (function () {
    var out = [];
    for (var i = 0; i < RUST_KIND_GROUP_ORDER.length; i++) {
      var kinds = RUST_KIND_GROUPS[RUST_KIND_GROUP_ORDER[i]] || [];
      for (var j = 0; j < kinds.length; j++) out.push(kinds[j]);
    }
    return out;
  })();

  /* Cached DOM element references — populated once on boot to avoid repeated getElementById calls */
  var DOM = {
    flowchartWrap: null,
    moduleSearch: null,
    moduleSearchOptions: null,
    moduleSearchFeedback: null,
    moduleSearchLabel: null,
    flowNodeInteriorMenu: null,
    mapStatus: null,
    mainContent: null,
    moduleResults: null,
    scopeToggle: null,
    workspaceBadge: null
  };

  function cacheDomElements() {
    DOM.flowchartWrap = document.getElementById("flowchart-wrap");
    DOM.moduleSearch = document.getElementById("module-search");
    DOM.moduleSearchOptions = document.getElementById("module-search-options");
    DOM.moduleSearchFeedback = document.getElementById("module-search-feedback");
    DOM.moduleSearchLabel = document.querySelector('label[for="module-search"]');
    DOM.flowNodeInteriorMenu = document.getElementById("flow-node-interior-menu");
    DOM.mapStatus = document.getElementById("map-status");
    DOM.mainContent = document.getElementById("main-content");
    DOM.moduleResults = document.getElementById("module-results");
    DOM.scopeToggle = document.getElementById("map-scope-toggle");
    DOM.workspaceBadge = document.getElementById("workspace-scope-badge");
  }

  var DETAIL_PRESETS = {
    compact: { neighborLimit: 8, impactRadius: 1 },
    balanced: { neighborLimit: 12, impactRadius: 2 },
    expanded: { neighborLimit: 16, impactRadius: 3 }
  };

  var INTERIOR_KIND_GROUPS = {
    object: ["inductive", "structure", "class", "def", "theorem", "lemma", "example", "instance", "opaque", "abbrev", "axiom", "constant", "constants"],
    extension: ["declare_syntax_cat", "syntax_cat", "syntax", "macro", "macro_rules", "notation", "infix", "infixl", "infixr", "prefix", "postfix", "elab", "elab_rules", "term_elab", "command_elab", "tactic"],
    contextInit: ["universe", "universes", "variable", "variables", "parameter", "parameters", "section", "namespace", "end", "initialize"]
  };
  var INTERIOR_KIND_GROUP_ORDER = ["object", "contextInit", "extension"];
  var INTERIOR_KIND_GROUP_LABELS_EN = {
    object: "Objects",
    extension: "Extensions",
    contextInit: "Contexts/Inits"
  };
  function interiorKindGroupLabel(key) {
    var i18nKey = "map.kind_" + key;
    return t(i18nKey) || INTERIOR_KIND_GROUP_LABELS_EN[key] || key;
  }
  var INTERIOR_KIND_ALL_VALUE = "__all__";
  var INTERIOR_KIND_COLOR_MAP = {
    inductive: "#8ecbff",
    structure: "#72d5ff",
    class: "#6ae3d8",
    def: "#82f0b0",
    theorem: "#ffd782",
    lemma: "#ffcb6b",
    example: "#ffc79e",
    instance: "#d0b7ff",
    opaque: "#9ec5ff",
    abbrev: "#8be4cb",
    axiom: "#ff9fb0",
    constant: "#f7b0ff",
    declare_syntax_cat: "#83e3ff",
    syntax_cat: "#6cd9ff",
    syntax: "#63ccff",
    macro: "#5ab8ff",
    macro_rules: "#4eabff",
    notation: "#8ba6ff",
    infix: "#9c97ff",
    infixl: "#a38dff",
    infixr: "#ab84ff",
    prefix: "#b57cff",
    postfix: "#be73ff",
    elab: "#67d5ff",
    elab_rules: "#56cbff",
    term_elab: "#47bdff",
    command_elab: "#39afff",
    tactic: "#2ba1ff",
    universe: "#ffd4f0",
    universes: "#ffcaea",
    variable: "#ffbee2",
    variables: "#ffb2d9",
    parameter: "#ffa6d0",
    parameters: "#ff9bc7",
    section: "#ff90bf",
    namespace: "#ff84b6",
    end: "#ff79ae",
    initialize: "#ff6ea6"
  };
  var ALL_INTERIOR_KINDS = (function () {
    var out = [];
    for (var i = 0; i < INTERIOR_KIND_GROUP_ORDER.length; i++) {
      var group = INTERIOR_KIND_GROUP_ORDER[i];
      var kinds = INTERIOR_KIND_GROUPS[group] || [];
      for (var j = 0; j < kinds.length; j++) out.push(kinds[j]);
    }
    return out;
  })();
  var BUSY_STATUS_RE = /loading/i;

  var state = {
    modules: [], moduleMap: Object.create(null), moduleMeta: Object.create(null),
    importsTo: Object.create(null), importsFrom: Object.create(null), externalImportsFrom: Object.create(null),
    theoremPairs: [], proofPairMap: Object.create(null), degreeMap: Object.create(null),
    selectedModule: null, activeLayerFilter: "all",
    neighborLimit: 8, impactRadius: 1, proofLinkedOnly: false,
    flowShowAll: false, contextListKey: "", contextList: [],
    contextOptionsKey: "", searchIndex: Object.create(null),
    searchVisibleOptions: [],
    searchActiveOption: -1,
    searchDeclSuggestions: [],
    declarationSearchList: [],
    declarationSearchByModule: Object.create(null),
    filteredModulesKey: "", filteredModulesList: [], filteredModulesValid: false,
    contextListValid: false,
    interiorMenuModule: "",
    interiorMenuQuery: "",
    interiorMenuSelections: Object.create(null),
    commitSha: "",
    generatedAt: "",
    flowScrollTarget: "",
    flowContext: "module",
    selectedDeclaration: "",
    selectedDeclarationModule: "",
    declarationGraph: Object.create(null),
    declarationReverseGraph: Object.create(null),
    declarationReverseModules: Object.create(null),
    declarationIndex: Object.create(null),
    declarationsByModule: Object.create(null),
    declarationModulesByName: Object.create(null),
    declarationLanesExpanded: false,
    /* The Rust crate inventory, from the same snapshot (and so the same
       commit) as the Lean graph. */
    rust: null,
    /* Which languages the workspace is read in, and the two models projected
       from the Rust inventory: the module graph the chart draws, and the
       declaration-level boundary between the two languages. */
    scope: DEFAULT_SCOPE,
    rustGraph: null,
    bridge: null,
    interiorMenuGroup: "object",
    /* Empty rather than "rustTypes": a crate root declares only modules, so a
       fixed first tab would open on an empty list. Unset means "the first
       group that has anything", and the reader's own choice sticks after that
       exactly as it does on the Lean side. */
    rustInteriorMenuGroup: "",
    laneGroupsExpanded: { imports: Object.create(null), importers: Object.create(null) }
  };

  var renderScheduled = false;
  var interiorMenuRenderScheduled = false;

  function safeScrollTo(top, behavior) {
    var targetTop = Math.max(0, Number(top) || 0);
    var mode = behavior || "auto";

    try {
      window.scrollTo({ top: targetTop, behavior: mode });
    } catch (e) {
      window.scrollTo(0, targetTop);
    }
  }

  function queryParamStateFromSearch(search) {
    var out = Object.create(null);
    var raw = typeof search === "string" ? search : "";
    if (!raw) return out;
    if (raw.charAt(0) === "?") raw = raw.slice(1);
    if (!raw) return out;

    var parts = raw.split("&");
    for (var i = 0; i < parts.length; i++) {
      var entry = parts[i];
      if (!entry) continue;
      var eq = entry.indexOf("=");
      var keyPart = eq >= 0 ? entry.slice(0, eq) : entry;
      if (!keyPart) continue;
      var valuePart = eq >= 0 ? entry.slice(eq + 1) : "";
      var key = keyPart;
      var value = valuePart;

      try { key = decodeURIComponent(keyPart.replace(/\+/g, " ")); } catch (e) {}
      try { value = decodeURIComponent(valuePart.replace(/\+/g, " ")); } catch (e) {}

      if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
    }

    return out;
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(function () {
      renderScheduled = false;
      renderAll();
    });
  }

  function normalizeCaretRange(value, start, end) {
    var length = String(value || "").length;
    var normalizedStart = typeof start === "number" && isFinite(start) ? Math.max(0, Math.min(length, Math.floor(start))) : length;
    var normalizedEnd = typeof end === "number" && isFinite(end) ? Math.max(normalizedStart, Math.min(length, Math.floor(end))) : normalizedStart;
    return { start: normalizedStart, end: normalizedEnd };
  }

  var pendingInteriorRenderArgs = null;
  function scheduleInteriorMenuRender(selected, caretRange, shouldRefocus) {
    /* Always record the newest args so a burst of input events within one
       rAF interval restores the latest caret, not the first one captured. */
    pendingInteriorRenderArgs = { selected: selected, caretRange: caretRange, shouldRefocus: shouldRefocus };
    if (interiorMenuRenderScheduled) return;
    interiorMenuRenderScheduled = true;
    window.requestAnimationFrame(function () {
      interiorMenuRenderScheduled = false;
      var args = pendingInteriorRenderArgs;
      pendingInteriorRenderArgs = null;
      renderFlowNodeInteriorMenu(args.selected);
      if (!args.shouldRefocus) return;
      var queryInput = document.getElementById("interior-symbol-filter");
      if (!queryInput) return;
      queryInput.focus();
      if (!args.caretRange || typeof queryInput.setSelectionRange !== "function") return;
      queryInput.setSelectionRange(args.caretRange.start, args.caretRange.end);
    });
  }


  function invalidateDerivedCaches() {
    state.contextListKey = "";
    state.contextOptionsKey = "";
    state.contextListValid = false;
    state.filteredModulesKey = "";
    state.filteredModulesList = [];
    state.filteredModulesValid = false;
  }
  function getFilteredAndSortedModules() {
    var list = filteredModules();
    sortModules(list);
    return list;
  }

  function updateModuleResults(count) {
    var node = DOM.moduleResults || document.getElementById("module-results");
    if (!node) return;
    /* The total is the active scope's, not the Lean module count: in the
       combined scope a reader is choosing among both languages. */
    var total = scopeNodes().length;
    var msg = t("map.modules_shown", { count: count, total: total });
    node.textContent = msg || (String(count) + " modules shown" + (total ? " (" + total + " total)" : ""));
  }

  function setStatus(text, isError) {
    var el = DOM.mapStatus || document.getElementById("map-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", Boolean(isError));

    var main = DOM.mainContent || document.getElementById("main-content");
    if (main) main.setAttribute("aria-busy", BUSY_STATUS_RE.test(text) ? "true" : "false");
  }

  /* The status line after boot says one of two things: the snapshot is shown
     (and at which commit), or it could not be loaded. It is remembered so a
     locale that lands later repaints it with the chart. */
  var loadStatus = { kind: "", detail: "" };
  function loadStatusText(kind, detail) {
    if (kind === "error") {
      var failed = t("map.status_load_failed") || "Unable to load the codebase map snapshot.";
      return detail ? failed + " (" + detail + ")" : failed;
    }
    var ready = t("map.status_ready_integrated") || "Map ready. Integrated dependency/proof flow graph loaded.";
    var commit = String(state.commitSha || "").slice(0, 7);
    if (!commit) return ready;
    return ready + " " + (t("map.status_snapshot_commit", { commit: commit }) || ("Snapshot of commit " + commit + "."));
  }

  function paintLoadStatus(kind, detail) {
    if (kind) loadStatus = { kind: kind, detail: detail || "" };
    if (!loadStatus.kind) return;
    setStatus(loadStatusText(loadStatus.kind, loadStatus.detail), loadStatus.kind === "error");
  }

  function updateMetric(key, value) {
    var els = NODE_CACHE[key];
    if (!els) {
      els = document.querySelectorAll('[data-map="' + key + '"]');
      NODE_CACHE[key] = els;
    }
    var text = typeof value === "number" ? formatCount(value) : String(value);
    for (var i = 0; i < els.length; i++) els[i].textContent = text;
  }

  function formatGeneratedAt(value) {
    if (!value) return "-";
    var date = new Date(value);
    if (isNaN(date.getTime())) return "-";
    try {
      return dateFormatFor(undefined).format(date);
    } catch (e) {
      return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    }
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

  /* Node names come off the URL, so the whitelist is tight: Lean modules are
     dotted identifiers and Rust nodes add `::` and the hyphen a crate name may
     carry. Nothing else — no slash, no space, no angle bracket. */
  function sanitizeModuleName(value) {
    return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : "";
  }

  /* Fold arbitrary text into the node-name whitelist, so anything built into a
     node name can round-trip through `module=` in the URL. Runs of rejected
     characters collapse to one `-`; a path separator is one of them. */
  function urlSafeNodeSegment(value) {
    return String(value || "").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function sanitizeScope(value) {
    return SCOPES.indexOf(String(value || "")) === -1 ? "" : String(value);
  }

  function normalizeSearchValue(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  /* Both languages' nodes are indexed regardless of the active scope: the
     scope decides which list the chooser searches, not what the index knows,
     so switching scope needs no rebuild. */
  function buildSearchIndex() {
    var index = Object.create(null);
    function add(name, path) {
      index[name] = {
        nameLower: name.toLowerCase(),
        pathLower: path.toLowerCase(),
        nameTokens: normalizeSearchValue(name).split(/\s+/).filter(Boolean),
        pathTokens: normalizeSearchValue(path).split(/\s+/).filter(Boolean)
      };
    }
    for (var i = 0; i < state.modules.length; i++) {
      add(state.modules[i], state.moduleMap[state.modules[i]] || "");
    }
    if (state.rustGraph) {
      for (var j = 0; j < state.rustGraph.nodes.length; j++) {
        var rustName = state.rustGraph.nodes[j];
        add(rustName, state.rustGraph.byName[rustName].path);
      }
    }
    state.searchIndex = index;
    buildDeclarationSearchIndex();
  }

  /* One entry per (module, name): a name two modules declare is findable in
     both. Falls back to the name-keyed index when no per-module index exists
     (a hand-built test state). */
  function buildDeclarationSearchIndex() {
    var declIndex = [];
    /* The same entries grouped by module, so a search scoped to one module
       reads that module's few hundred entries rather than all ~24k. */
    var byModuleEntries = Object.create(null);
    function push(declName, moduleName) {
      var qualifiedName = moduleName + "." + declName;
      var entry = {
        name: declName,
        nameLower: declName.toLowerCase(),
        module: moduleName,
        qualifiedName: qualifiedName,
        qualifiedLower: qualifiedName.toLowerCase()
      };
      declIndex.push(entry);
      (byModuleEntries[moduleName] || (byModuleEntries[moduleName] = [])).push(entry);
    }
    var byModule = state.declarationsByModule;
    var hasByModule = false;
    if (byModule) {
      for (var moduleName in byModule) {
        if (!Object.prototype.hasOwnProperty.call(byModule, moduleName)) continue;
        hasByModule = true;
        for (var name in byModule[moduleName]) {
          if (Object.prototype.hasOwnProperty.call(byModule[moduleName], name)) push(name, moduleName);
        }
      }
    }
    if (!hasByModule) {
      for (var declName in state.declarationIndex) {
        if (!Object.prototype.hasOwnProperty.call(state.declarationIndex, declName)) continue;
        var entry = state.declarationIndex[declName];
        if (entry && entry.module) push(declName, entry.module);
      }
    }
    state.declarationSearchList = declIndex;
    state.declarationSearchByModule = byModuleEntries;
  }

  function declarationSearchEntriesIn(moduleName) {
    var byModule = state.declarationSearchByModule;
    if (byModule) return byModule[moduleName] || [];
    var all = state.declarationSearchList || [];
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].module === moduleName) out.push(all[i]);
    }
    return out;
  }

  function setSearchFeedback(message, isError) {
    var node = DOM.moduleSearchFeedback || document.getElementById("module-search-feedback");
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("error", Boolean(isError));
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

  /* The namespace a module is filed under, capped at three segments so deep
     trees still group at the subsystem level:
       SeLe4n.Kernel.IPC.Invariant.Defs → SeLe4n.Kernel.IPC
       SeLe4n.Kernel.API                → SeLe4n.Kernel
       SeLe4n.Prelude                   → SeLe4n
       Main                             → Main */
  function moduleSubsystem(moduleName) {
    var parts = String(moduleName || "").split(".").filter(Boolean);
    if (parts.length <= 1) return parts[0] || "";
    return parts.slice(0, Math.min(parts.length - 1, 3)).join(".");
  }

  function defaultModuleName() {
    if (state.moduleMap[DEFAULT_MODULE]) return DEFAULT_MODULE;
    return state.modules[0] || null;
  }

  function formatCount(value) {
    if (typeof value !== "number" || !isFinite(value)) return String(value === null || value === undefined ? "" : value);
    var rounded = Math.round(value);
    try { return numberFormatFor(documentLocale()).format(rounded); } catch (e) {}
    return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function documentLocale() {
    var root = typeof document !== "undefined" && document ? document.documentElement : null;
    return (root && root.lang) || "en";
  }

  /* Comparison and formatting objects are built once and reused. Constructing
     an Intl object is the expensive part of a comparison: `localeCompare`
     with options builds a collator per call, which made sorting a 509-item
     sidebar 37x slower than one cached collator. A collator built with the
     same (default) locale and options orders exactly as localeCompare does. */
  function makeComparer(options) {
    try {
      var collator = new Intl.Collator(undefined, options);
      return function (a, b) { return collator.compare(a, b); };
    } catch (e) {
      return function (a, b) { return String(a).localeCompare(String(b)); };
    }
  }
  /* a.localeCompare(b) */
  var compareText = makeComparer(undefined);
  /* a.localeCompare(b, undefined, { sensitivity: "base" }) */
  var compareTextBase = makeComparer({ sensitivity: "base" });

  /* Number and date formatters per locale: the locale can change at runtime
     (the language switcher), so the cache is keyed by it rather than built
     once. */
  var NUMBER_FORMATS = Object.create(null);
  var DATE_FORMATS = Object.create(null);
  function numberFormatFor(locale) {
    if (!NUMBER_FORMATS[locale]) NUMBER_FORMATS[locale] = new Intl.NumberFormat(locale);
    return NUMBER_FORMATS[locale];
  }
  function dateFormatFor(locale) {
    var key = locale || "";
    if (!DATE_FORMATS[key]) {
      DATE_FORMATS[key] = new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      });
    }
    return DATE_FORMATS[key];
  }

  function normalizeSymbolName(name) {
    return String(name || "").replace(/`/g, "").trim();
  }

  function normalizeDeclarationKind(kind) {
    var normalized = String(kind || "").trim().toLowerCase();
    if (!normalized) return "";
    if (normalized === "constants") return "constant";
    return normalized;
  }

  function normalizeSymbolEntry(entry) {
    if (!entry) return null;
    if (typeof entry === "string") {
      var normalizedName = normalizeSymbolName(entry);
      return normalizedName ? { name: normalizedName, line: 0 } : null;
    }

    var name = normalizeSymbolName(entry.name);
    if (!name) return null;
    var line = Number(entry.line || 0);
    return { name: name, line: Number.isFinite(line) && line > 0 ? Math.floor(line) : 0 };
  }

  function normalizeSymbolList(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var normalized = normalizeSymbolEntry(list[i]);
      if (!normalized) continue;
      out.push(normalized);
    }
    return out;
  }

  function symbolListsFromRaw(rawSymbols) {
    var symbols = rawSymbols && typeof rawSymbols === "object" ? rawSymbols : {};
    var byKindSource = symbols.byKind || symbols.by_kind || symbols.kinds || {};
    var kinds = allInteriorKinds();
    var byKind = Object.create(null);

    for (var i = 0; i < kinds.length; i++) {
      var kind = kinds[i];
      var candidates = [kind];
      if (kind === "constant") candidates.push("constants");
      var list = [];
      for (var c = 0; c < candidates.length; c++) {
        var key = candidates[c];
        if (Array.isArray(byKindSource[key])) {
          list = byKindSource[key];
          break;
        }
      }
      byKind[kind] = list;
    }

    return {
      byKind: byKind,
      theorems: Array.isArray(symbols.theorems) ? symbols.theorems : [],
      functions: Array.isArray(symbols.functions) ? symbols.functions : []
    };
  }

  function allInteriorKinds() {
    return ALL_INTERIOR_KINDS.slice();
  }

  function interiorGroupItemCount(interior, kinds) {
    var total = 0;
    for (var i = 0; i < kinds.length; i++) {
      total += ((interior.byKind || {})[kinds[i]] || []).length;
    }
    return total;
  }

  function pickInteriorDefaultKind(interior, groupKinds, remembered) {
    if (remembered === INTERIOR_KIND_ALL_VALUE) return INTERIOR_KIND_ALL_VALUE;
    if (remembered && groupKinds.indexOf(remembered) !== -1) return remembered;
    return INTERIOR_KIND_ALL_VALUE;
  }

  function compareByNameThenLine(a, b) {
    var byName = compareTextBase(String((a && a.name) || ""), String((b && b.name) || ""));
    if (byName !== 0) return byName;
    return ((a && a.line) || 0) - ((b && b.line) || 0);
  }

  /* The sorted list for one (group, kind) selection is memoized on the
     interior object it was built from — interiors are themselves cached per
     module, and replaced when the module's symbols are — so a keystroke in
     the sidebar filter only filters, and re-selecting a module re-sorts
     nothing. Callers read the result and never mutate it. */
  function sortedInteriorItems(interior, groupKinds, selectedKind) {
    var key = selectedKind + "\u0000" + groupKinds.join(",");
    var memo = interior.__sortedItems;
    if (!memo || memo.byKind !== interior.byKind) {
      memo = { byKind: interior.byKind, lists: Object.create(null) };
      try { Object.defineProperty(interior, "__sortedItems", { value: memo, writable: true, configurable: true, enumerable: false }); } catch (e) { interior.__sortedItems = memo; }
    }
    if (memo.lists[key]) return memo.lists[key];

    var byKind = interior.byKind || {};
    var out = [];
    var kinds = selectedKind === INTERIOR_KIND_ALL_VALUE ? groupKinds : [selectedKind];
    for (var i = 0; i < kinds.length; i++) {
      var kindItems = byKind[kinds[i]] || [];
      for (var j = 0; j < kindItems.length; j++) {
        out.push(Object.assign({}, kindItems[j], { __kind: kinds[i] }));
      }
    }
    out.sort(compareByNameThenLine);
    memo.lists[key] = out;
    return out;
  }

  function interiorItemsForSelection(interior, groupKinds, selectedKind, query) {
    var q = String(query || "").trim().toLowerCase();
    var sorted = sortedInteriorItems(interior || {}, groupKinds, selectedKind);
    if (!q) return sorted;
    return sorted.filter(function (entry) {
      return String((entry && entry.name) || "").toLowerCase().indexOf(q) !== -1;
    });
  }


  function parseHexColor(hex) {
    var h = String(hex || "").replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return isNaN(n) ? { r: 143, g: 163, b: 191 } : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function blendHexColor(a, b, t) {
    /* Linearly blend two hex colors. t=0 returns a, t=1 returns b. */
    var ca = parseHexColor(a);
    var cb = parseHexColor(b);
    var r = Math.round(ca.r + (cb.r - ca.r) * t);
    var g = Math.round(ca.g + (cb.g - ca.g) * t);
    var bl = Math.round(ca.b + (cb.b - ca.b) * t);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  /* Lean kinds first, then the Rust palette: the two share no kind name except
     `macro`, which means the same thing on both sides. A `test:` prefix takes
     the colour of the kind it wraps. */
  function interiorKindColor(kind) {
    var k = String(kind || "");
    if (k.indexOf(RUST_TEST_KIND_PREFIX) === 0) k = k.slice(RUST_TEST_KIND_PREFIX.length);
    return INTERIOR_KIND_COLOR_MAP[k]
      || INTERIOR_KIND_COLOR_MAP[normalizeDeclarationKind(k)]
      || RUST_ITEM_COLOR_MAP[k]
      || "#8fa3bf";
  }

  function applyInteriorKindColor(node, kind, includeBackground) {
    if (!node) return;
    var color = interiorKindColor(kind);
    node.dataset.kind = String(kind || "");
    node.style.setProperty("--interior-kind-color", color);
    if (includeBackground) {
      node.style.backgroundColor = "color-mix(in oklab, " + color + " 18%, var(--surface) 82%)";
    }
  }

  function makeEmptyInteriorSymbols() {
    var byKind = Object.create(null);
    for (var i = 0; i < ALL_INTERIOR_KINDS.length; i++) byKind[ALL_INTERIOR_KINDS[i]] = [];
    return { byKind: byKind, theorems: [], functions: [] };
  }

  function symbolKindLabel(kind) {
    return String(kind || "")
      .split("_")
      .map(function (part) { return part ? part.charAt(0).toUpperCase() + part.slice(1) : ""; })
      .join(" ");
  }

  function hasCompleteSymbolLines(symbols) {
    if (!symbols || typeof symbols !== "object") return false;
    var byKind = symbols.byKind || {};
    var allKinds = allInteriorKinds();

    for (var i = 0; i < allKinds.length; i++) {
      var list = byKind[allKinds[i]];
      if (!Array.isArray(list)) return false;
      for (var j = 0; j < list.length; j++) {
        if (!list[j] || !(list[j].line > 0)) return false;
      }
    }

    return true;
  }

  function interiorCodeForModule(name) {
    var meta = state.moduleMeta[name] || {};
    if (meta.__interiorCache && meta.__interiorCacheSource === meta.symbols) return meta.__interiorCache;
    var symbols = symbolListsFromRaw(meta.symbols || {});

    var kinds = allInteriorKinds();
    var byKind = Object.create(null);
    var total = 0;
    for (var i = 0; i < kinds.length; i++) {
      var kind = kinds[i];
      byKind[kind] = normalizeSymbolList((symbols.byKind || {})[kind]);
      total += byKind[kind].length;
    }

    var theoremList = normalizeSymbolList(symbols.theorems);
    var functionList = normalizeSymbolList(symbols.functions);

    var normalized = {
      byKind: byKind,
      theorems: theoremList.length ? theoremList : (byKind.theorem || []).concat(byKind.lemma || []),
      functions: functionList.length ? functionList : (byKind.def || []).concat(byKind.abbrev || [], byKind.opaque || [], byKind.instance || []),
      total: total
    };

    meta.__interiorCacheSource = meta.symbols;
    meta.__interiorCache = normalized;
    return normalized;
  }

  function normalizeImportsFromIndex() {
    for (var moduleName in state.importsFrom) {
      if (!Object.prototype.hasOwnProperty.call(state.importsFrom, moduleName)) continue;
      if (!state.moduleMap[moduleName]) {
        delete state.importsFrom[moduleName];
        continue;
      }

      var deps = Array.isArray(state.importsFrom[moduleName]) ? state.importsFrom[moduleName] : [];
      var normalized = [];
      var seen = Object.create(null);
      for (var i = 0; i < deps.length; i++) {
        var dep = sanitizeModuleName(deps[i]);
        if (!dep || !state.moduleMap[dep] || seen[dep]) continue;
        seen[dep] = true;
        normalized.push(dep);
      }
      state.importsFrom[moduleName] = normalized;
    }
  }

  function rebuildImportsToIndex() {
    normalizeImportsFromIndex();

    var reverse = Object.create(null);
    for (var moduleName in state.importsFrom) {
      if (!Object.prototype.hasOwnProperty.call(state.importsFrom, moduleName)) continue;
      var deps = state.importsFrom[moduleName] || [];
      for (var i = 0; i < deps.length; i++) {
        var dep = deps[i];
        if (!dep) continue;
        if (!reverse[dep]) reverse[dep] = [];
        reverse[dep].push(moduleName);
      }
    }

    state.importsTo = reverse;
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

  function objectDeclarationCount(interior) {
    /* Count only object-group declarations (defs, theorems, structures, etc.)
       which represent provable/verifiable surface area.  Context-init kinds
       (namespace, section, variable, etc.) are scaffolding — not proof targets. */
    var objectKinds = INTERIOR_KIND_GROUPS.object || [];
    var count = 0;
    for (var i = 0; i < objectKinds.length; i++) {
      count += ((interior.byKind || {})[objectKinds[i]] || []).length;
    }
    return count;
  }

  function extensionDeclarationCount(interior) {
    /* Count extension-group declarations (syntax, macros, notations, tactics, etc.)
       which represent language-extension surface area — meaningful for assurance. */
    var extKinds = INTERIOR_KIND_GROUPS.extension || [];
    var count = 0;
    for (var i = 0; i < extKinds.length; i++) {
      count += ((interior.byKind || {})[extKinds[i]] || []).length;
    }
    return count;
  }

  function verifiableSurfaceArea(interior) {
    /* Compute the verifiable surface area: object declarations are the primary
       coverage denominator, but extension declarations also contribute (at half
       weight) since they represent meaningful language-level commitments. */
    var objCount = objectDeclarationCount(interior);
    var extCount = extensionDeclarationCount(interior);
    return objCount + Math.floor(extCount * 0.5);
  }

  function assuranceForModule(name) {
    if (ASSURANCE_CACHE[name]) return ASSURANCE_CACHE[name];

    var pair = findProofPair(name);
    var degree = moduleDegree(name);
    var interior = interiorCodeForModule(name);
    var totalDeclarations = interior.total || 0;
    var objectDecls = objectDeclarationCount(interior);
    var extDecls = extensionDeclarationCount(interior);
    var verifiableArea = verifiableSurfaceArea(interior);
    var result;

    /* Theorem density: ratio of theorems to verifiable surface area */
    var theoremRatio = verifiableArea > 0
      ? Math.min(1, degree.theorems / Math.max(1, verifiableArea))
      : 0;

    if (pair && pair.invariantImportsOperations) {
      var pairTheorems = pair.operationsTheorems + pair.invariantTheorems;

      /* Pair-wide coverage: compute verifiable surface area across both modules */
      var opsInterior = pair.operationsModule ? interiorCodeForModule(pair.operationsModule) : { total: 0 };
      var invInterior = pair.invariantModule ? interiorCodeForModule(pair.invariantModule) : { total: 0 };
      var pairObjectDecls = (pair.operationsModule ? objectDeclarationCount(opsInterior) : 0)
        + (pair.invariantModule ? objectDeclarationCount(invInterior) : 0);
      var pairExtDecls = (pair.operationsModule ? extensionDeclarationCount(opsInterior) : 0)
        + (pair.invariantModule ? extensionDeclarationCount(invInterior) : 0);
      var pairVerifiable = pairObjectDecls + Math.floor(pairExtDecls * 0.5);
      var pairTotalDeclarations = (opsInterior.total || 0) + (invInterior.total || 0);
      var pairCoverage = pairVerifiable > 0
        ? Math.min(1, pairTheorems / Math.max(1, pairVerifiable))
        : 0;

      /* Strength thresholds — calibrated for real Lean projects:
         - strong:     >=40% pair coverage AND at least 3 theorems across the pair
         - moderate:   >=15% pair coverage OR at least 2 theorems
         - emerging:   linked with some theorems but below moderate threshold
         - scaffolded: structurally linked but no theorems — convention met, no proofs */
      var strengthLabel = pairTheorems === 0
        ? "scaffolded"
        : (pairCoverage >= 0.4 && pairTheorems >= 3) ? "strong"
        : (pairCoverage >= 0.15 || pairTheorems >= 2) ? "moderate"
        : "emerging";
      var densityBonus = pairTheorems > 0 ? pairTheorems * 2 : 0;
      result = {
        level: "linked",
        label: "Linked proof chain (" + strengthLabel + ")",
        detail: pairTheorems > 0
          ? "Operations \u2194 Invariant linked with " + pairTheorems + " theorem" + (pairTheorems === 1 ? "" : "s") + " across " + pairVerifiable + " verifiable declaration" + (pairVerifiable === 1 ? "" : "s") + " (" + Math.round(pairCoverage * 100) + "% coverage). Obligations trace from transitions to safety claims."
          : "Operations \u2194 Invariant structurally linked but no theorems declared. Proof pair convention is established; proof obligations are not yet formalized.",
        score: degree.score + densityBonus,
        theoremDensity: pairTheorems,
        coverage: pairCoverage,
        pairDeclarations: pairTotalDeclarations,
        objectDeclarations: pairObjectDecls,
        verifiableDeclarations: pairVerifiable,
        strength: strengthLabel
      };
    } else if (pair) {
      var partialTheorems = (pair.operationsTheorems || 0) + (pair.invariantTheorems || 0);
      var missingHalf = !pair.operationsModule ? "Operations"
        : !pair.invariantModule ? "Invariant"
        : "import link";

      /* Partial coverage: compute verifiable surface area for existing pair modules */
      var partialPairDecl = 0;
      var partialObjectDecl = 0;
      var partialVerifiable = 0;
      if (pair.operationsModule) {
        var opsInt = interiorCodeForModule(pair.operationsModule);
        partialPairDecl += (opsInt.total || 0);
        partialObjectDecl += objectDeclarationCount(opsInt);
        partialVerifiable += verifiableSurfaceArea(opsInt);
      }
      if (pair.invariantModule) {
        var invInt = interiorCodeForModule(pair.invariantModule);
        partialPairDecl += (invInt.total || 0);
        partialObjectDecl += objectDeclarationCount(invInt);
        partialVerifiable += verifiableSurfaceArea(invInt);
      }
      var partialCoverage = partialVerifiable > 0
        ? Math.min(1, partialTheorems / Math.max(1, partialVerifiable))
        : theoremRatio;

      /* Partial strength: "disconnected" when both modules exist but import is
         missing (fixable); "incomplete" when a half is absent (needs creation) */
      var partialStrength = missingHalf === "import link" ? "disconnected" : "incomplete";
      if (partialTheorems === 0) partialStrength = "weak";

      result = {
        level: "partial",
        label: "Partial proof context (" + partialStrength + ")",
        detail: "Proof pair " + (missingHalf === "import link"
          ? "exists but Invariant does not import Operations"
          : "is incomplete \u2014 " + missingHalf + " module is absent")
          + (partialTheorems > 0 ? ". " + partialTheorems + " theorem" + (partialTheorems === 1 ? "" : "s") + " across " + partialVerifiable + " verifiable declaration" + (partialVerifiable === 1 ? "" : "s") + " (" + Math.round(partialCoverage * 100) + "% coverage)" : "")
          + ". " + (missingHalf === "import link"
            ? "Add an import from Invariant to Operations to complete the proof chain."
            : "Create the " + missingHalf + " module to establish the proof pair."),
        score: degree.score + partialTheorems,
        theoremDensity: partialTheorems,
        coverage: partialCoverage,
        pairDeclarations: partialPairDecl,
        objectDeclarations: partialObjectDecl,
        verifiableDeclarations: partialVerifiable,
        strength: partialStrength
      };
    } else if (degree.theorems > 0) {
      /* Local strength thresholds use absolute counts alongside ratios to
         avoid misleading labels on very small modules */
      var localStrength = (theoremRatio >= 0.5 && degree.theorems >= 2) ? "well-covered"
        : theoremRatio >= 0.2 ? "moderate"
        : "sparse";
      result = {
        level: "local",
        label: "Local theorems (" + localStrength + ")",
        detail: degree.theorems + " theorem" + (degree.theorems === 1 ? "" : "s") + " across " + verifiableArea + " verifiable declaration" + (verifiableArea === 1 ? "" : "s") + " (" + Math.round(theoremRatio * 100) + "% coverage). No Operations/Invariant pair mapping.",
        score: degree.score,
        theoremDensity: degree.theorems,
        coverage: theoremRatio,
        objectDeclarations: objectDecls,
        verifiableDeclarations: verifiableArea,
        strength: localStrength
      };
    } else {
      /* Distinguish modules by their declaration composition:
         - unverified: has object declarations (defs, theorems, etc.) but no proofs
         - extension-only: only has extension declarations (syntax, macros, etc.)
         - scaffold-only: only context-init declarations (namespace, section, etc.)
         - empty: no declarations at all */
      var hasObjectDecls = objectDecls > 0;
      var hasExtensions = extDecls > 0;
      var hasDeclarations = totalDeclarations > 0;
      var noneStrength = hasObjectDecls ? "unverified"
        : hasExtensions ? "extension-only"
        : hasDeclarations ? "scaffold-only"
        : "empty";
      result = {
        level: "none",
        label: hasObjectDecls
          ? "Unverified (" + objectDecls + " obj, " + totalDeclarations + " total)"
          : hasExtensions
            ? "Extensions only (" + extDecls + " ext, " + totalDeclarations + " total)"
          : hasDeclarations
            ? "Scaffold only (" + totalDeclarations + " decl)"
            : "No declarations",
        detail: hasObjectDecls
          ? objectDecls + " object declaration" + (objectDecls === 1 ? "" : "s") + " (" + totalDeclarations + " total) with no theorem coverage and no proof-pair mapping."
          : hasExtensions
            ? extDecls + " extension declaration" + (extDecls === 1 ? "" : "s") + " (syntax, macros, notations) with " + totalDeclarations + " total declarations. Language extension module with no proof obligations."
          : hasDeclarations
            ? totalDeclarations + " context/init declaration" + (totalDeclarations === 1 ? "" : "s") + " (namespace, section, variable, etc.) \u2014 structural scaffolding only, no provable surface area."
            : "No declarations or proof-pair mapping detected.",
        score: degree.score,
        theoremDensity: 0,
        coverage: 0,
        objectDeclarations: hasObjectDecls ? objectDecls : 0,
        verifiableDeclarations: verifiableArea,
        strength: noneStrength
      };
    }

    ASSURANCE_CACHE[name] = result;
    return result;
  }

  /* Every declaration lookup takes an optional module. Without one it answers
     by name alone, as the name-keyed indexes always have; with one it answers
     for that module's declaration of the name, which is what a deep link, a
     sidebar row or a lane node actually means. */

  /* The entry for `declName` as declared in `moduleName`, or null. */
  function declarationEntryIn(declName, moduleName) {
    if (!moduleName) return null;
    var perModule = state.declarationsByModule && state.declarationsByModule[moduleName];
    if (perModule) return perModule[declName] || null;
    var indexed = state.declarationIndex[declName];
    return indexed && indexed.module === moduleName ? indexed : null;
  }

  function declarationExistsIn(declName, moduleName) {
    if (declarationEntryIn(declName, moduleName)) return true;
    var entry = state.declarationGraph[declName];
    return Boolean(entry && entry.module === moduleName);
  }

  /* The module a bare name refers to when written in `contextModule`: its own
     declaration first, then one in a module it imports directly, then the
     first module that declares the name. A call target is recorded
     unqualified, so this is how a callee is placed and how a caller is
     attributed to the right declaration. */
  function resolveDeclarationModule(declName, contextModule) {
    if (contextModule && declarationExistsIn(declName, contextModule)) return contextModule;
    var candidates = state.declarationModulesByName ? state.declarationModulesByName[declName] : null;
    if (candidates && candidates.length > 1 && contextModule) {
      var imports = state.importsFrom[contextModule] || [];
      for (var i = 0; i < candidates.length; i++) {
        if (imports.indexOf(candidates[i]) !== -1) return candidates[i];
      }
    }
    if (candidates && candidates.length) return candidates[0];
    return declarationModuleOf(declName);
  }

  function declarationCalls(declName, moduleName) {
    if (moduleName) {
      var meta = state.moduleMeta[moduleName];
      var callGraph = meta && meta.symbols && meta.symbols.callGraph;
      if (callGraph && Array.isArray(callGraph[declName])) return callGraph[declName].slice();
      var owned = state.declarationGraph[declName];
      return owned && owned.module === moduleName && Array.isArray(owned.calls) ? owned.calls.slice() : [];
    }
    var entry = state.declarationGraph[declName];
    return entry && Array.isArray(entry.calls) ? entry.calls.slice() : [];
  }

  /* The callers of `declName`, as { name, module } pairs. With a module, only
     the callers whose bare reference resolves to that module's declaration. */
  function declarationCallerRefs(declName, moduleName) {
    var reverse = state.declarationReverseGraph[declName];
    if (!Array.isArray(reverse)) return [];
    var modules = state.declarationReverseModules ? state.declarationReverseModules[declName] : null;
    var out = [];
    for (var i = 0; i < reverse.length; i++) {
      var callerModule = modules && modules[i] ? modules[i] : declarationModuleOf(reverse[i]);
      if (moduleName && resolveDeclarationModule(declName, callerModule) !== moduleName) continue;
      out.push({ name: reverse[i], module: callerModule });
    }
    return out;
  }

  /* The callees of `declName` in `moduleName`, each placed by the module the
     bare reference resolves to from there. */
  function declarationCalleeRefs(declName, moduleName) {
    var calls = declarationCalls(declName, moduleName);
    var out = [];
    for (var i = 0; i < calls.length; i++) {
      out.push({ name: calls[i], module: resolveDeclarationModule(calls[i], moduleName) });
    }
    return out;
  }

  function declarationCalledBy(declName, moduleName) {
    if (!moduleName) {
      var reverse = state.declarationReverseGraph[declName];
      return Array.isArray(reverse) ? reverse.slice() : [];
    }
    return declarationCallerRefs(declName, moduleName).map(function (ref) { return ref.name; });
  }

  function declarationModuleOf(declName, moduleName) {
    if (moduleName && declarationExistsIn(declName, moduleName)) return moduleName;
    var entry = state.declarationGraph[declName];
    if (entry) return entry.module;
    var indexed = state.declarationIndex[declName];
    if (indexed) return indexed.module;
    return "";
  }

  function declarationKindOf(declName, moduleName) {
    var indexed = declarationEntryIn(declName, moduleName) || state.declarationIndex[declName];
    if (indexed) return indexed.kind;
    return "";
  }

  function declarationLineOf(declName, moduleName) {
    var indexed = declarationEntryIn(declName, moduleName) || state.declarationIndex[declName];
    if (indexed) return indexed.line || 0;
    return 0;
  }

  function declarationSourceHref(declName, moduleHint) {
    var moduleName = declarationModuleOf(declName, moduleHint);
    if (!moduleName || !state.moduleMap[moduleName]) return "";
    var ref = state.commitSha || REF;
    var path = state.moduleMap[moduleName];
    var encodedPath = path.split("/").map(encodeURIComponent).join("/");
    var line = declarationLineOf(declName, moduleName);
    var lineAnchor = line > 0 ? "#L" + line : "";
    return "https://github.com/" + REPO + "/blob/" + encodeURIComponent(ref) + "/" + encodedPath + lineAnchor;
  }

  function moduleSourceLink(name) {
    var path = nodePath(name);
    if (!name || !path) return null;
    var ref = nodeSourceRef(name);
    var encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return {
      href: "https://github.com/" + REPO + "/blob/" + encodeURIComponent(ref) + "/" + encodedPath,
      label: path,
      title: "Open " + name + " source on GitHub"
    };
  }

  function selectDeclaration(declName, moduleName) {
    var mod = moduleName || declarationModuleOf(declName);
    /* `nodeExists`, not `moduleMap`: a declaration resolves to a Lean module,
       which the Rust-only scope does not show. The search field accepts a
       typed or chosen declaration through here, so guarding only the URL path
       left the interactive one selecting a Lean module under a Rust badge. */
    if (!mod || !nodeExists(mod)) return false;
    /* The search field re-resolves its value on blur; when that value is the
       declaration already shown, there is nothing to re-render or re-scroll. */
    if (state.flowContext === "declaration" && state.selectedDeclaration === declName && state.selectedDeclarationModule === mod) return true;
    state.flowContext = "declaration";
    state.selectedDeclaration = declName;
    state.selectedDeclarationModule = mod;
    state.declarationLanesExpanded = false;
    if (state.selectedModule !== mod) {
      state.selectedModule = mod;
      state.interiorMenuModule = mod;
      state.interiorMenuQuery = "";
    }
    state.flowScrollTarget = declName;
    /* Sync the context search bar to reflect the selected declaration */
    var picker = DOM.moduleSearch || document.getElementById("module-search");
    if (picker && document.activeElement !== picker) {
      picker.value = mod + "." + declName;
    }
    syncUrlState();
    scheduleRender();
    return true;
  }

  function returnToModuleContext() {
    state.flowContext = "module";
    state.selectedDeclaration = "";
    state.selectedDeclarationModule = "";
    state.declarationLanesExpanded = false;
    state.flowScrollTarget = state.selectedModule || "";
    syncUrlState();
    scheduleRender();
  }

  function expandDeclarationLanes() {
    state.declarationLanesExpanded = true;
    scheduleRender();
  }

  function compactDeclarationLanes() {
    state.declarationLanesExpanded = false;
    scheduleRender();
  }

  function declarationFlowLegendItems() {
    return [
      { label: t("map.legend_selected_decl") || "Selected declaration", color: "#7c9cff", group: "edge" },
      { label: t("map.legend_calls") || "Calls (outgoing)", color: "#82f0b0", group: "edge" },
      { label: t("map.legend_called_by") || "Called by (incoming)", color: "#ffad42", group: "edge" },
      { separator: true },
      { label: t("map.legend_border_kind") || "Border = declaration kind", color: "#8fa3bf", group: "edge" },
      { label: t("map.legend_dashed_cross") || "Dashed = cross-module", color: "#8fa3bf", group: "edge" }
    ];
  }

  function findNearestLinkedPath(start, radius) {
    if (!start) return [];
    if (assuranceForModule(start).level === "linked") return [start];

    var maxRadius = Math.max(1, Math.min(3, radius || 1));
    var queue = [{ name: start, depth: 0 }];
    var visited = Object.create(null);
    var prev = Object.create(null);
    visited[start] = true;

    for (var cursor = 0; cursor < queue.length; cursor++) {
      var node = queue[cursor];
      if (node.depth >= maxRadius) continue;

      var neighbors = uniqueModules((state.importsFrom[node.name] || []).concat(state.importsTo[node.name] || []), node.name);
      for (var i = 0; i < neighbors.length; i++) {
        var next = neighbors[i];
        if (!next || visited[next]) continue;
        visited[next] = true;
        prev[next] = node.name;

        if (assuranceForModule(next).level === "linked") {
          var path = [next];
          var traceCursor = next;
          while (prev[traceCursor]) {
            traceCursor = prev[traceCursor];
            path.push(traceCursor);
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
    return moduleDegree(b).score - moduleDegree(a).score || compareText(a, b);
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

  /* The layer filter and the linked-pairs filter are properties of Lean
     modules, so in a scope that carries Rust the Rust nodes ride alongside
     rather than being filtered by criteria that do not apply to them. */
  function filteredModules() {
    var rustCount = state.rustGraph ? state.rustGraph.nodes.length : 0;
    var key = [state.scope, state.activeLayerFilter, state.proofLinkedOnly ? "1" : "0", state.modules.length, rustCount].join("|");
    if (key === state.filteredModulesKey && state.filteredModulesValid) return state.filteredModulesList.slice();

    var layer = state.activeLayerFilter;
    var list = [];
    if (scopeIncludesLean()) {
      list = state.modules.filter(function (name) {
        var meta = state.moduleMeta[name] || {};
        if (layer !== "all" && meta.layer !== layer) return false;
        if (state.proofLinkedOnly) {
          var pair = findProofPair(name);
          if (!pair || !pair.invariantImportsOperations) return false;
        }
        return true;
      });
    }
    if (scopeIncludesRust() && state.rustGraph) list = list.concat(state.rustGraph.nodes);

    state.filteredModulesKey = key;
    state.filteredModulesList = list.slice();
    state.filteredModulesValid = true;
    return list;
  }

  /* Lean modules rank by graph score; Rust nodes have no import degree, so
     they rank by their production surface and sort after the Lean list in a
     combined reading — the kernel stays the subject. */
  function nodeSortScore(name) {
    if (!isRustNode(name)) return moduleDegree(name).score;
    var node = rustNode(name);
    /* A crate root leads its crate; below it, the larger production surface
       comes first. Every Rust score is negative, so the Lean modules — whose
       scores are never below zero — stay ahead of them in a combined list. */
    if (node.isRoot) return -0.5;
    var items = Number((node.file || {}).productionItems) || 0;
    return -1 - 1 / (1 + items);
  }

  function sortModules(list) {
    list.sort(function (a, b) {
      var scoreDiff = nodeSortScore(b) - nodeSortScore(a);
      return scoreDiff || compareText(a, b);
    });
  }

  function prefersCompactViewport() {
    return window.matchMedia && window.matchMedia("(max-width: 900px)").matches;
  }

  var cachedMinFlowWidth = 0;
  var cachedMinFlowWidthTs = 0;
  function minimumFlowWidth() {
    var now = Date.now();
    if (cachedMinFlowWidth > 0 && now - cachedMinFlowWidthTs < 200) return cachedMinFlowWidth;
    var width = window.innerWidth || 1200;
    var result;
    /* The layout is laid out at max(this minimum, the chart column's width),
       and the SVG is never drawn below 1:1 — `.flowchart-svg` has
       `width: auto; min-width: 100%`, so a layout wider than its column
       scrolls sideways inside the frame instead of shrinking its text.

       On phones the minimum scales with the viewport (2.1–2.25×) so three
       lanes fit without overlapping while the reader pans about one viewport
       width. From 900px up the column decides: 900 is the narrowest width at
       which three lanes stay readable, and a fixed 1180 here once forced a
       0.58–0.86 scale-down at every desktop width once the declaration
       sidebar took its share of the row. */
    if (width <= 420) result = Math.max(720, Math.round(width * 2.25));
    else if (width <= 640) result = Math.max(820, Math.round(width * 2.1));
    else if (width <= 900) result = Math.max(920, Math.round(width * 1.4));
    else result = 900;
    cachedMinFlowWidth = result;
    cachedMinFlowWidthTs = now;
    return result;
  }

  function selectModule(name, preserveScroll) {
    if (!nodeExists(name)) return;
    if (state.selectedModule === name && state.flowContext === "module") {
      /* Re-selecting the current module only repaints the sidebar when it shows
         another module. An unconditional repaint here rebuilt the declaration
         list under the pointer: the search field's blur fires `change` →
         `choose()` → this branch on mousedown, so the button being clicked was
         replaced before mouseup and the click never landed. */
      if (state.interiorMenuModule !== name) renderFlowNodeInteriorMenu(name);
      return;
    }
    state.selectedModule = name;
    state.flowContext = "module";
    state.selectedDeclaration = "";
    state.selectedDeclarationModule = "";
    state.declarationLanesExpanded = false;
    state.laneGroupsExpanded = { imports: Object.create(null), importers: Object.create(null) };
    state.flowScrollTarget = preserveScroll ? "" : name;
    if (state.interiorMenuModule !== name) {
      state.interiorMenuModule = name;
      state.interiorMenuQuery = "";
    }
    syncUrlState();
    scheduleRender();
  }

  function contextList() {
    var rustCount = state.rustGraph ? state.rustGraph.nodes.length : 0;
    var key = [state.scope, state.activeLayerFilter, state.proofLinkedOnly ? "1" : "0", state.modules.length, rustCount].join("|");
    if (key === state.contextListKey && state.contextListValid) return state.contextList.slice();
    var list = getFilteredAndSortedModules();
    state.contextListKey = key;
    state.contextList = list.slice();
    state.contextListValid = true;
    return list;
  }

  function renderContextChooser() {
    var picker = DOM.moduleSearch || document.getElementById("module-search");
    if (!picker) return;

    var list = contextList();
    updateModuleResults(list.length);

    if (list.length && list.indexOf(state.selectedModule) === -1) {
      var fallback = defaultNodeName();
      state.selectedModule = fallback && list.indexOf(fallback) !== -1 ? fallback : list[0];
      syncUrlState();
    }

    var label = DOM.moduleSearchLabel || document.querySelector('label[for="module-search"]');
    var inDeclContext = state.flowContext === "declaration" && state.selectedDeclaration;

    if (!list.length) {
      picker.value = "";
      picker.placeholder = t("map.no_modules_matched") || "No modules matched current filters";
      if (label) label.textContent = t("map.context_search") || "Context search";
      closeModuleSearchOptions();
      return;
    }

    if (inDeclContext) {
      picker.placeholder = t("map.search_placeholder") || "Module or Module.declaration";
      if (label) label.textContent = t("map.search_declaration") || "Context search \u2014 declaration";
      if (document.activeElement !== picker) {
        picker.value = state.selectedDeclarationModule + "." + state.selectedDeclaration;
      }
    } else {
      picker.placeholder = t("map.search_placeholder") || "Module or Module.declaration";
      if (label) label.textContent = t("map.search_module") || "Context search \u2014 module";
      if (state.selectedModule && document.activeElement !== picker) picker.value = state.selectedModule;
    }
  }


  var ASSURANCE_COLORS = {
    linked: "#22b573",
    partial: "#c47adb",
    local: "#5ba8d4",
    none: "#8e8e9a"
  };

  var ASSURANCE_ICONS = {
    linked: "\u25C6",
    partial: "\u25C7",
    local: "\u25CB",
    none: "\u25AB"
  };

  function flowLegendItems() {
    return [
      /* Edge/lane roles — what lines and positions mean */
      { label: t("map.legend_selected_module") || "Selected module", color: "#7c9cff", group: "edge" },
      { label: t("map.legend_imports") || "Imports (dependencies)", color: "#35c98f", group: "edge" },
      { label: t("map.legend_impacted") || "Impacted (dependents)", color: "#ffad42", group: "edge" },
      { label: t("map.legend_proof_pair") || "Proof pair", color: "#d37cff", group: "edge" },
      { label: t("map.legend_linked_proof") || "Linked-proof path", color: "#6de2ff", group: "edge" },
      { label: t("map.legend_external") || "External imports", color: "#b9c0d0", group: "edge" },
      { separator: true },
      /* Assurance indicators — node left-border marks showing proof confidence */
      { label: ASSURANCE_ICONS.linked + " " + (t("map.assurance_linked") || "Linked (Ops\u2194Inv proof chain)"), color: ASSURANCE_COLORS.linked, group: "assurance", indicator: "bar" },
      { label: ASSURANCE_ICONS.partial + " " + (t("map.assurance_partial") || "Partial (pair incomplete/disconnected)"), color: ASSURANCE_COLORS.partial, group: "assurance", indicator: "bar" },
      { label: ASSURANCE_ICONS.local + " " + (t("map.assurance_local") || "Local (standalone theorems)"), color: ASSURANCE_COLORS.local, group: "assurance", indicator: "bar" },
      { label: ASSURANCE_ICONS.none + " " + (t("map.assurance_none") || "None (no proof coverage)"), color: ASSURANCE_COLORS.none, group: "assurance", indicator: "bar" }
    ].concat(bridgeLegendItems());
  }

  /* The boundary entries only appear in the scope that draws the boundary, so
     the Lean-only and Rust-only readings keep their original legends. */
  function bridgeLegendItems() {
    if (state.scope !== "both") return [];
    return [
      { separator: true },
      { label: t("map.legend_bridge_implements") || "Lean declares → Rust implements", color: BRIDGE_COLORS.implements, group: "bridge" },
      { label: t("map.legend_bridge_invokes") || "Rust wrapper → Lean operation", color: BRIDGE_COLORS.invokes, group: "bridge" },
      { label: t("map.legend_bridge_mirrors") || "Mirrored either side (no call)", color: BRIDGE_COLORS.mirrors, group: "bridge" },
      { label: t("map.legend_bridge_shares") || "Shared definition", color: BRIDGE_COLORS.shares, group: "bridge" }
    ];
  }

  function rustFlowLegendItems() {
    return [
      { label: t("map.rust_legend_selected") || "Selected Rust module", color: "#7c9cff", group: "edge" },
      { label: t("map.rust_legend_enclosing") || "Enclosing module path", color: "#35c98f", group: "edge" },
      { label: t("map.rust_legend_declares") || "Modules declared here", color: "#ffad42", group: "edge" },
      { label: t("map.rust_legend_siblings") || "Modules declared alongside", color: "#ffad42", group: "edge" },
      { label: t("map.rust_legend_dependencies") || "Crate dependencies", color: "#b9c0d0", group: "edge" }
    ].concat(bridgeLegendItems());
  }

  /* Import tokens the graph does not contain are external to the production
     corpus. Most are Lean/Std libraries; a few are in-repository modules the
     published scope leaves out — the SeLe4n library root and the
     SeLe4n.Testing framework — and saying "external dependency" of those
     would be wrong. */
  function isInRepoOutsideScope(name) {
    return /^SeLe4n(?:\.|$)/.test(String(name || ""));
  }

  function isLibraryRoot(name) {
    return String(name || "") === "SeLe4n";
  }

  function externalImportSubtitle(name) {
    if (isLibraryRoot(name)) return t("map.external_library_root") || "in-repo \u00B7 library root";
    return isInRepoOutsideScope(name)
      ? (t("map.external_in_repo") || "in-repo \u00B7 outside production scope")
      : (t("map.external_dependency") || "external dependency");
  }

  function externalImportTooltip(name, importer) {
    var role = isLibraryRoot(name)
      ? "The library root that re-exports the production modules: " + name
      : isInRepoOutsideScope(name)
        ? "In-repository module outside the published production scope: " + name
        : "External import: " + name;
    return role + "\nImported by " + importer;
  }

  function flowLaneLabelVisibility(options) {
    var source = options || {};
    var importsVisible = Number(source.importCount || 0) > 0;
    var impactedVisible = Number(source.importerCount || 0) > 0;
    var proofVisible = Number(source.proofCount || 0) > 0;
    var linkedPathVisible = Number(source.linkedPathLength || 0) > 1;
    var externalVisible = Number(source.externalCount || 0) > 0;
    var hasAuxiliaryContext = importsVisible || impactedVisible || proofVisible || linkedPathVisible || externalVisible;

    return {
      imports: importsVisible,
      selected: hasAuxiliaryContext,
      impacted: impactedVisible,
      proof: proofVisible,
      linkedPath: linkedPathVisible,
      external: externalVisible
    };
  }

  /* ------------------------------------------------------------------
     The declaration sidebar serves both languages

     `interiorForNode` hands the renderer the same shape either way — kinds
     bucketed by name, each item carrying a name and a line — so the tabs, the
     kind filter, the query field and the list are written once.
     ------------------------------------------------------------------ */

  function interiorForNode(name) {
    return isRustNode(name) ? rustInteriorForNode(name) : interiorCodeForModule(name);
  }

  function interiorGroupOrderForNode(name) {
    return isRustNode(name) ? RUST_KIND_GROUP_ORDER.slice() : INTERIOR_KIND_GROUP_ORDER.slice();
  }

  function interiorGroupKinds(name, groupKey) {
    var source = isRustNode(name) ? RUST_KIND_GROUPS : INTERIOR_KIND_GROUPS;
    return source[groupKey] || [];
  }

  function interiorGroupLabelForNode(name, groupKey) {
    return isRustNode(name) ? rustKindGroupLabel(groupKey) : interiorKindGroupLabel(groupKey);
  }

  function interiorKindLabelForNode(name, kind) {
    return isRustNode(name) ? rustKindLabel(kind) : symbolKindLabel(kind);
  }

  /* The open tab is remembered per language: a reader scanning theorems across
     Lean modules stays on Objects, and stays on Types across Rust modules. */
  function rememberedInteriorGroup(name) {
    return isRustNode(name) ? state.rustInteriorMenuGroup : state.interiorMenuGroup;
  }

  function rememberInteriorGroup(name, groupKey) {
    if (isRustNode(name)) state.rustInteriorMenuGroup = groupKey;
    else state.interiorMenuGroup = groupKey;
  }

  function interiorGroupsForNode(name, interior) {
    var order = interiorGroupOrderForNode(name);
    var groups = [];
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      var kinds = interiorGroupKinds(name, key);
      groups.push({
        key: key,
        label: interiorGroupLabelForNode(name, key),
        kinds: kinds,
        selectedKind: pickInteriorDefaultKind(interior, kinds, state.interiorMenuSelections[key] || ""),
        totalCount: interiorGroupItemCount(interior, kinds)
      });
    }
    return groups;
  }

  function interiorSummaryForNode(name, interior) {
    if (!isRustNode(name)) return interiorMenuSummary(name, interior);
    var node = rustNode(name);
    var parts = [rustNodeRoleLabel(node.role), node.crateName, rustNodeSummary(name)];
    return parts.filter(Boolean).join(" · ");
  }

  function pickInteriorMenuGroup(groups, remembered) {
    for (var i = 0; i < groups.length; i++) if (groups[i].key === remembered) return remembered;
    for (var j = 0; j < groups.length; j++) if (groups[j].totalCount > 0) return groups[j].key;
    return groups.length ? groups[0].key : "object";
  }

  function interiorMenuSummary(moduleName, interior) {
    var degree = moduleDegree(moduleName);
    var assurance = assuranceForModule(moduleName);
    var total = interior.total || 0;
    var theorems = degree.theorems || 0;
    var parts = [
      t("map.summary_declarations", { count: total }) || pluralEn(total, "declaration", "declarations"),
      t("map.summary_theorems", { count: theorems }) || pluralEn(theorems, "theorem", "theorems"),
      "←" + degree.incoming + " →" + degree.outgoing
    ];
    if (assurance && assurance.label) parts.push(assurance.label);
    return parts.join(" · ");
  }

  function renderFlowNodeInteriorMenu(selected) {
    var menu = DOM.flowNodeInteriorMenu || document.getElementById("flow-node-interior-menu");
    if (!menu) return;
    /* Preserve focus/caret across externally-triggered re-renders (locale
       repaint, window resize) that destroy the filter input mid-typing. */
    var prevInput = document.getElementById("interior-symbol-filter");
    var hadFocus = Boolean(prevInput && document.activeElement === prevInput);
    var savedCaret = hadFocus ? normalizeCaretRange(prevInput.value, prevInput.selectionStart, prevInput.selectionEnd) : null;
    menu.innerHTML = "";
    if (!selected) {
      menu.textContent = t("map.select_module") || "Select a module to inspect interior declarations.";
      return;
    }

    if (state.interiorMenuModule !== selected) {
      state.interiorMenuModule = selected;
      state.interiorMenuQuery = "";
      state.interiorMenuSelections = Object.create(null);
    }

    var interior = interiorForNode(selected);
    var query = (state.interiorMenuQuery || "").trim().toLowerCase();
    var groups = interiorGroupsForNode(selected, interior);
    /* One group is open at a time, remembered per language. */
    var activeKey = pickInteriorMenuGroup(groups, rememberedInteriorGroup(selected));
    rememberInteriorGroup(selected, activeKey);
    var group = groups[0];
    for (var gi = 0; gi < groups.length; gi++) if (groups[gi].key === activeKey) group = groups[gi];

    var head = document.createElement("div");
    head.className = "interior-menu-head";
    /* h3: the workspace section carries the h2, so the sidebar is one level below it. */
    var heading = document.createElement("h3");
    heading.className = "interior-menu-title";
    heading.textContent = t("map.declarations_title") || "Declarations";
    head.appendChild(heading);
    var moduleLine = document.createElement("div");
    moduleLine.className = "interior-menu-module";
    var moduleLabel = document.createElement("span");
    moduleLabel.className = "interior-menu-module-name";
    moduleLabel.textContent = selected;
    moduleLine.appendChild(moduleLabel);
    var sourceLink = moduleSourceLink(selected);
    if (sourceLink) {
      var sourceAnchor = document.createElement("a");
      sourceAnchor.className = "interior-menu-source";
      sourceAnchor.href = sourceLink.href;
      sourceAnchor.target = "_blank";
      sourceAnchor.rel = "noopener noreferrer";
      sourceAnchor.title = sourceLink.title;
      sourceAnchor.textContent = t("map.open_source") || "Source ↗";
      moduleLine.appendChild(sourceAnchor);
    }
    head.appendChild(moduleLine);
    var summaryLine = document.createElement("p");
    summaryLine.className = "interior-menu-summary";
    summaryLine.textContent = interiorSummaryForNode(selected, interior);
    head.appendChild(summaryLine);
    menu.appendChild(head);

    var controls = document.createElement("div");
    controls.className = "interior-menu-controls";
    var queryLabel = document.createElement("label");
    queryLabel.className = "sr-only";
    queryLabel.setAttribute("for", "interior-symbol-filter");
    queryLabel.textContent = t("map.filter_interior") || "Filter interior declarations";
    var queryInput = document.createElement("input");
    queryInput.id = "interior-symbol-filter";
    queryInput.className = "interior-menu-search";
    queryInput.type = "search";
    queryInput.placeholder = t("map.filter_placeholder") || "Filter declarations across all kinds…";
    queryInput.autocomplete = "off";
    queryInput.spellcheck = false;
    queryInput.value = state.interiorMenuQuery || "";
    queryInput.addEventListener("input", function () {
      state.interiorMenuQuery = this.value || "";
      var caret = normalizeCaretRange(this.value, this.selectionStart, this.selectionEnd);
      scheduleInteriorMenuRender(selected, caret, true);
    });
    controls.appendChild(queryLabel);
    controls.appendChild(queryInput);
    menu.appendChild(controls);

    var tabs = document.createElement("div");
    tabs.className = "interior-menu-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", t("map.declaration_groups") || "Declaration groups");
    var tabButtons = [];
    for (var ti = 0; ti < groups.length; ti++) {
      (function (entry) {
        var tab = document.createElement("button");
        tab.type = "button";
        tab.className = "interior-menu-tab";
        tab.id = "interior-menu-tab-" + entry.key;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", entry.key === activeKey ? "true" : "false");
        tab.setAttribute("aria-controls", "interior-menu-panel");
        tab.tabIndex = entry.key === activeKey ? 0 : -1;
        tab.dataset.group = entry.key;
        tab.appendChild(document.createTextNode(entry.label + " "));
        var count = document.createElement("span");
        count.className = "interior-menu-count";
        count.textContent = formatCount(entry.totalCount);
        tab.appendChild(count);
        tab.addEventListener("click", function () {
          if (rememberedInteriorGroup(selected) === entry.key) return;
          rememberInteriorGroup(selected, entry.key);
          renderFlowNodeInteriorMenu(selected);
          var next = document.getElementById("interior-menu-tab-" + entry.key);
          if (next) next.focus();
        });
        tabButtons.push(tab);
        tabs.appendChild(tab);
      })(groups[ti]);
    }
    tabs.addEventListener("keydown", function (event) {
      var key = event.key;
      if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
      var current = tabButtons.indexOf(document.activeElement);
      if (current === -1) return;
      var next = current;
      if (key === "ArrowRight") next = (current + 1) % tabButtons.length;
      else if (key === "ArrowLeft") next = (current - 1 + tabButtons.length) % tabButtons.length;
      else if (key === "Home") next = 0;
      else next = tabButtons.length - 1;
      event.preventDefault();
      tabButtons[next].click();
    });
    menu.appendChild(tabs);

    function symbolSourceHref(moduleName, entry) {
      var path = nodePath(moduleName);
      if (!moduleName || !path) return "";
      var ref = nodeSourceRef(moduleName);
      var encodedPath = path.split("/").map(encodeURIComponent).join("/");
      var lineAnchor = entry && entry.line > 0 ? "#L" + entry.line : "";
      return "https://github.com/" + REPO + "/blob/" + encodeURIComponent(ref) + "/" + encodedPath + lineAnchor;
    }

    var column = document.createElement("section");
    column.className = "interior-menu-column";
    column.id = "interior-menu-panel";
    column.setAttribute("role", "tabpanel");
    column.setAttribute("aria-labelledby", "interior-menu-tab-" + activeKey);

    var top = document.createElement("div");
    top.className = "interior-menu-column-top";

    var select = document.createElement("select");
    select.className = "interior-kind-select";
    select.setAttribute("aria-label", "Filter " + group.label + " by kind");
    var allOption = document.createElement("option");
    allOption.value = INTERIOR_KIND_ALL_VALUE;
    allOption.textContent = t("map.all_count", { count: group.totalCount }) || ("All (" + group.totalCount + ")");
    allOption.selected = group.selectedKind === INTERIOR_KIND_ALL_VALUE;
    select.appendChild(allOption);
    for (var i = 0; i < group.kinds.length; i++) {
      var kind = group.kinds[i];
      var kindCount = (interior.byKind[kind] || []).length;
      /* Rust files carry far more kinds than any one file uses; listing the
         empty ones would bury the two that matter. Lean keeps every kind so
         the absence of a kind stays visible. */
      if (!kindCount && isRustNode(selected)) continue;
      var option = document.createElement("option");
      option.value = kind;
      option.textContent = interiorKindLabelForNode(selected, kind) + " (" + kindCount + ")";
      applyInteriorKindColor(option, kind, true);
      if (kind === group.selectedKind) option.selected = true;
      select.appendChild(option);
    }

    function tintSelectToCurrentKind() {
      var activeOption = select.options[select.selectedIndex];
      var activeKind = activeOption && activeOption.value !== INTERIOR_KIND_ALL_VALUE ? activeOption.value : "";
      applyInteriorKindColor(select, activeKind, false);
    }

    tintSelectToCurrentKind();
    top.appendChild(select);
    column.appendChild(top);

    var list = document.createElement("ul");
    list.className = "interior-menu-items";
    /* One listener for every row's button rather than a closure per row: the
       largest module lists ~500 declarations and a filter keystroke repaints
       them all. */
    list.addEventListener("click", function (event) {
      var btn = event.target && event.target.closest ? event.target.closest(".interior-menu-item-btn") : null;
      if (!btn || !list.contains(btn)) return;
      var declName = btn.getAttribute("data-decl");
      if (declName) selectDeclaration(declName, selected);
    });

    var emptyNote = null;

    function showEmptyNote(message) {
      list.innerHTML = "";
      if (list.parentNode) list.parentNode.removeChild(list);
      if (!emptyNote) {
        emptyNote = document.createElement("p");
        emptyNote.className = "panel-note interior-menu-empty";
      }
      emptyNote.textContent = message;
      if (emptyNote.parentNode !== column) column.appendChild(emptyNote);
    }

    function ensureListAttached() {
      if (emptyNote && emptyNote.parentNode) emptyNote.parentNode.removeChild(emptyNote);
      if (list.parentNode !== column) column.appendChild(list);
    }

    function repaintList() {
      list.innerHTML = "";
      var activeKind = select.value;
      var items = interiorItemsForSelection(interior, group.kinds, activeKind, query);
      if (!items.length) {
        var msg = query
          ? (t("map.no_declarations_filter") || "No declarations match this filter.")
          : (activeKind === INTERIOR_KIND_ALL_VALUE
            ? (t("map.no_declarations_group") || "No declarations detected for this kind group.")
            : (t("map.no_declarations_kind") || "No declarations detected for this kind."));
        showEmptyNote(msg);
        return;
      }

      ensureListAttached();

      var listFragment = document.createDocumentFragment();
      for (var j = 0; j < items.length; j++) {
        var li = document.createElement("li");
        li.className = "interior-menu-item";
        var isSelectedDecl = state.flowContext === "declaration" && items[j].name === state.selectedDeclaration;
        if (isSelectedDecl) li.classList.add("interior-menu-item-active");
        li.dataset.kindLabel = interiorKindLabelForNode(selected, items[j].__kind || activeKind);
        if (items[j].visibility) li.dataset.visibility = items[j].visibility;
        applyInteriorKindColor(li, items[j].__kind || activeKind, false);
        /* Rust items have no call graph in the snapshot, so they resolve to
           their source line rather than to a declaration view. */
        var hasCallData = !isRustNode(selected)
          && (Boolean(state.declarationGraph[items[j].name]) || Boolean(state.declarationReverseGraph[items[j].name]));
        var isNavigable = hasCallData || Boolean(state.moduleMap[selected]);
        if (isNavigable) {
          li.classList.add("interior-menu-item-navigable");
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "interior-menu-item-btn";
          btn.textContent = items[j].name;
          btn.title = "View declaration call graph for " + items[j].name;
          btn.dataset.decl = items[j].name;
          li.appendChild(btn);
        } else {
          var linkHref = symbolSourceHref(selected, items[j]);
          if (linkHref) {
            var link = document.createElement("a");
            link.href = linkHref;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = items[j].name;
            link.title = items[j].line > 0 ? "Open declaration at line " + items[j].line : "Open declaration source";
            li.appendChild(link);
          } else {
            var nameSpan = document.createElement("span");
            nameSpan.textContent = items[j].name;
            li.appendChild(nameSpan);
          }
        }
        listFragment.appendChild(li);
      }
      list.appendChild(listFragment);
    }

    select.addEventListener("change", function () {
      state.interiorMenuSelections[group.key] = select.value;
      tintSelectToCurrentKind();
      repaintList();
    });
    column.appendChild(list);
    repaintList();
    menu.appendChild(column);

    if (hadFocus) {
      var newInput = document.getElementById("interior-symbol-filter");
      if (newInput) {
        newInput.focus();
        if (savedCaret && typeof newInput.setSelectionRange === "function") newInput.setSelectionRange(savedCaret.start, savedCaret.end);
      }
    }
  }

  function wrapLabelLines(text, width, minChars) {
    if (!text) return [];
    var cacheKey = String(text) + "\u0000" + String(width || 180) + "\u0000" + String(minChars || 10);
    if (LABEL_WRAP_CACHE.has(cacheKey)) {
      /* Move to end for true LRU: delete + re-insert preserves access recency */
      var cached = LABEL_WRAP_CACHE.get(cacheKey);
      LABEL_WRAP_CACHE.delete(cacheKey);
      LABEL_WRAP_CACHE.set(cacheKey, cached);
      return cached.slice();
    }

    /* Use a wider per-character estimate on mobile where CSS scales flow-node
       text up to 12–12.5px (vs. 11.5px desktop).  A 6.4px estimate works for
       11.5px monospace, but at 12px the actual glyph advance is ~7.0px, causing
       text to overflow node boundaries on compact viewports. */
    var charWidth = prefersCompactViewport() ? 7.0 : 6.4;
    var maxChars = Math.max(minChars || 10, Math.floor((width || 180) / charWidth));
    /* Split on common delimiters but prefer dots for Lean qualified names
       (e.g. SeLe4n.Kernel.Operations → ["SeLe4n", ".", "Kernel", ".", "Operations"]).
       Spaces split too, so prose subtitles ("12 modules · click to expand")
       wrap at word boundaries instead of being chunked mid-word. */
    var tokens = String(text).split(/([._/\-\s])/);
    var lines = [];
    var current = "";

    function pushTokenInChunks(token) {
      if (!token) return;
      if (token.length <= maxChars) {
        lines.push(token);
        return;
      }

      var start = 0;
      while (start < token.length) {
        lines.push(token.slice(start, start + maxChars));
        start += maxChars;
      }
    }

    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (!token) continue;

      if (token.length > maxChars && !current.length) {
        pushTokenInChunks(token);
        continue;
      }

      var next = current + token;
      if (next.length <= maxChars || !current.length) {
        current = next;
      } else {
        lines.push(current);

        if (token.length > maxChars) {
          pushTokenInChunks(token);
          current = "";
        } else {
          current = token.trim() ? token : "";
        }
      }
    }
    if (current.length) lines.push(current);

    if (LABEL_WRAP_CACHE.size >= LABEL_WRAP_CACHE_LIMIT) {
      /* Collect keys first, then delete — avoids iterator invalidation overhead */
      var evictKeys = [];
      var iter = LABEL_WRAP_CACHE.keys();
      for (var evicted = 0; evicted < LABEL_WRAP_CACHE_EVICT_BATCH; evicted++) {
        var oldest = iter.next();
        if (oldest.done || oldest.value === undefined) break;
        evictKeys.push(oldest.value);
      }
      for (var ek = 0; ek < evictKeys.length; ek++) {
        LABEL_WRAP_CACHE.delete(evictKeys[ek]);
      }
    }
    LABEL_WRAP_CACHE.set(cacheKey, lines.slice());

    return lines;
  }

  function nodeContentHeight(name, subtitle, width, compactHint, metaLinkLabel, hasAssurance) {
    /* Account for assurance bar (left) and icon (right) taking space — text area is narrower.
       Left: barWidth(5) + gap(9) = 14.  Right: iconMargin(22).  Total inset = 36px.
       Non-assurance nodes use a smaller inset: just left+right padding = 20px.
       Must match the wrap width used in buildFlowNodeGroup to prevent content overflow. */
    var textInset = hasAssurance ? 36 : 20;
    var textAreaWidth = width - textInset;
    var titleLines = wrapLabelLines(name, textAreaWidth, compactHint ? 14 : 12);
    var subtitleLines = subtitle ? wrapLabelLines(subtitle, textAreaWidth, 14) : [];
    /* Cap subtitle lines to prevent excessively tall nodes */
    var maxSubtitleLines = compactHint ? 2 : 3;
    if (subtitleLines.length > maxSubtitleLines) subtitleLines = subtitleLines.slice(0, maxSubtitleLines);
    var linkLines = metaLinkLabel ? wrapLabelLines(metaLinkLabel, textAreaWidth, 14) : [];
    var titleLineHeight = 14;
    var subtitleLineHeight = 12;
    /* topPad derived from buildFlowNodeGroup's titleBaseY:
       compact: titleBaseY=17, so visual text top ≈ 17 - fontAscent(~8) = 9.
       full:    titleBaseY=20, so visual text top ≈ 20 - fontAscent(~8) = 12. */
    var topPad = compactHint ? 8 : 11;
    var bottomPad = 9;
    var gap = (subtitleLines.length || linkLines.length) ? 6 : 0;
    var linkGap = (subtitleLines.length && linkLines.length) ? 3 : 0;
    var textHeight = titleLines.length * titleLineHeight + subtitleLines.length * subtitleLineHeight + gap + linkLines.length * subtitleLineHeight + linkGap;
    var minHeight = compactHint ? 36 : 46;
    return Math.max(minHeight, topPad + textHeight + bottomPad);
  }

  function createSvgNode(tag, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var key in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  function drawFlowEdge(layer, from, to, color, dashed, variant) {
    var opts = variant || {};
    if (from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h) return;
    var path = createSvgNode("path", {});
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

    /* Determine exit direction: prefer the axis with greater separation,
       but use an explicit hint when provided (e.g. vertical for proof edges). */
    var forceVertical = Boolean(opts.vertical);
    var horizontalBias = forceVertical ? false : Math.abs(dx) >= Math.abs(dy);
    /* Inset the endpoint slightly (4px) so the arrow marker doesn't
       visually pierce the rounded corners (rx=10) of the target node. */
    var endInset = 4;
    if (horizontalBias) {
      startX = dx >= 0 ? from.x + from.w : from.x;
      endX = dx >= 0 ? to.x + endInset : to.x + to.w - endInset;
    } else {
      startY = dy >= 0 ? from.y + from.h : from.y;
      endY = dy >= 0 ? to.y + endInset : to.y + to.h - endInset;
    }

    var distFactor = Math.sqrt(dx * dx + dy * dy);
    /* Scale control offset by axis context: vertical edges use a gentler curve
       to avoid the S-shape distortion on short vertical drops.
       For very short distances, use a smaller minimum to avoid overshooting. */
    var offsetRatio = horizontalBias ? 0.35 : 0.30;
    var minOffset = distFactor < 80 ? Math.max(20, distFactor * 0.4) : 40;
    var controlOffset = Math.max(minOffset, Math.min(160, distFactor * offsetRatio));
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
    /* An arrowhead is a claim about direction. Every lane edge makes one, but
       a boundary relation that the model calls undirected — a shared type, a
       routine mirrored either side of the seam — must not: an arrow there
       reads as a call that does not happen. */
    if (!opts.undirected) path.setAttribute("marker-end", "url(#flow-arrow)");
    layer.appendChild(path);
  }

  function createFlowSvg(flowWidth, flowHeight, ariaLabel) {
    var svg = createSvgNode("svg", {
      "class": "flowchart-svg",
      "width": flowWidth,
      "height": flowHeight,
      "viewBox": "0 0 " + flowWidth + " " + flowHeight,
      "role": "group",
      "aria-roledescription": "flowchart",
      "aria-label": ariaLabel
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

    /* Build layers in detached DocumentFragments so all DOM mutations during
       node/edge/label construction happen off-screen.  flush() assembles the
       final SVG in one reflow-free batch append. */
    var edgeFrag = document.createDocumentFragment();
    var nodeFrag = document.createDocumentFragment();
    var labelFrag = document.createDocumentFragment();

    var edgeLayer = createSvgNode("g", { "class": "flow-edge-layer", "aria-hidden": "true" });
    var nodeLayer = createSvgNode("g", { "class": "flow-node-layer" });
    var labelLayer = createSvgNode("g", { "class": "flow-label-layer" });

    return {
      svg: svg,
      edgeLayer: edgeLayer,
      nodeLayer: nodeLayer,
      labelLayer: labelLayer,
      /* Flush all pending layer children into the SVG in one batch.
         Call this after all nodes/edges/labels have been constructed
         to minimize DOM reflow during construction. */
      flush: function () {
        svg.appendChild(edgeLayer);
        svg.appendChild(nodeLayer);
        svg.appendChild(labelLayer);
      }
    };
  }

  function createFlowLegend(items, ariaLabel) {
    var legend = document.createElement("div");
    legend.className = "flowchart-legend flowchart-legend-corner";
    legend.setAttribute("role", "list");
    legend.setAttribute("aria-label", ariaLabel);
    for (var i = 0; i < items.length; i++) {
      if (items[i].separator) {
        var sep = document.createElement("span");
        sep.className = "legend-separator";
        sep.setAttribute("role", "separator");
        sep.setAttribute("aria-hidden", "true");
        legend.appendChild(sep);
        continue;
      }
      var chip = document.createElement("span");
      chip.className = "legend-item";
      if (items[i].group) chip.classList.add("legend-" + items[i].group);
      chip.setAttribute("role", "listitem");

      if (items[i].indicator === "bar") {
        /* Assurance items use a vertical bar swatch instead of a circle */
        var barSwatch = document.createElement("span");
        barSwatch.className = "legend-swatch legend-swatch-bar";
        barSwatch.setAttribute("aria-hidden", "true");
        barSwatch.style.backgroundColor = items[i].color;
        chip.appendChild(barSwatch);
      } else {
        var swatch = document.createElement("span");
        swatch.className = "legend-swatch";
        swatch.setAttribute("aria-hidden", "true");
        swatch.style.backgroundColor = items[i].color;
        chip.appendChild(swatch);
      }
      chip.appendChild(document.createTextNode(items[i].label));
      legend.appendChild(chip);
    }
    return legend;
  }

  /* "+38 more imports" — a budget cut, pluralised by the locale. The suffix
     argument is only the English fallback's noun; the locale string carries
     its own wording. */
  function laneMoreLabel(key, count, englishNoun) {
    var fallback = "+" + formatCount(count) + " more" + (englishNoun ? " " + englishNoun : "");
    return t(key, { count: count }) || fallback;
  }

  function flowLaneLabel(labelLayer, text, x, y, color) {
    var label = createSvgNode("text", { x: x, y: y, fill: color, "font-size": "12", "class": "flow-lane-label" });
    label.textContent = text;
    labelLayer.appendChild(label);
  }

  /* The frame's geometry, read once per render before anything is written
     (see renderAll). Reading `clientWidth` or `scrollLeft` after the chart
     has been cleared or appended forces a synchronous layout, and a render
     used to force two or three. The frame keeps `scrollbar-gutter: stable`,
     so its client size does not depend on the content about to replace it. */
  var flowFrame = null;
  function readFlowFrame(wrap) {
    if (!wrap) return null;
    return { clientWidth: wrap.clientWidth, clientHeight: wrap.clientHeight, scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop };
  }
  function flowFrameValue(wrap, key) {
    if (flowFrame) return flowFrame[key];
    return wrap ? wrap[key] : 0;
  }

  /* Scroll offsets are written without reading the scroll extent first: an
     assignment past the end is clamped by the browser, which is what the
     explicit Math.min did at the cost of a forced layout. */
  function setFlowScroll(wrap, left, top) {
    wrap.style.scrollBehavior = "auto";
    wrap.scrollLeft = left;
    wrap.scrollTop = top;
    wrap.style.removeProperty("scroll-behavior");
  }

  function applyFlowScrollTarget(wrap, targetName, centerX, centerY, centerW, centerH) {
    if (state.flowScrollTarget !== targetName) return false;
    var targetScrollLeft = Math.max(0, centerX + centerW / 2 - flowFrameValue(wrap, "clientWidth") / 2);
    var targetScrollTop = Math.max(0, centerY + centerH / 2 - flowFrameValue(wrap, "clientHeight") / 2);
    setFlowScroll(wrap, targetScrollLeft, targetScrollTop);
    state.flowScrollTarget = "";
    return true;
  }

  /* Puts back the scroll position a re-render should keep. The chart was
     replaced without a layout in between, so the frame still holds its old
     offset; when that is the one to keep there is nothing to write, and
     nothing to lay out synchronously. */
  function restoreFlowScroll(wrap, left, top) {
    if (flowFrame && flowFrame.scrollLeft === left && flowFrame.scrollTop === top) return;
    setFlowScroll(wrap, left, top);
  }

  var flowClipIdCounter = 0;
  function buildFlowNodeGroup(nodeLayer, className, focusable, ariaLabel, name, x, y, w, h, color, subtitle, tooltip, onActivate, metaLink) {
    var group = createSvgNode("g", { "class": className, tabindex: focusable ? "0" : "-1", role: onActivate ? "button" : "img", "aria-label": ariaLabel });
    if (focusable) group.setAttribute("focusable", "true");

    /* Clip text to the node boundary so long labels never overflow the rect */
    var clipId = "fc" + (++flowClipIdCounter);
    var clipPath = createSvgNode("clipPath", { id: clipId });
    var clipRect = createSvgNode("rect", { x: x, y: y, width: w, height: h, rx: 10, ry: 10 });
    clipPath.appendChild(clipRect);
    group.appendChild(clipPath);

    var rect = createSvgNode("rect", { x: x, y: y, width: w, height: h, fill: "var(--flow-node-bg)", stroke: color });
    var full = createSvgNode("title", {});
    full.textContent = tooltip || name;

    /* Extract assurance level from className for the bar indicator */
    var assuranceMatch = /assurance-(\w+)/.exec(className);
    var assuranceLevel = assuranceMatch ? assuranceMatch[1] : "";

    var barWidth = 5;
    var textOffsetX = assuranceLevel ? barWidth + 9 : 10;

    var compactNode = h < 46;
    /* Text wrapping inset must match nodeContentHeight:
       assurance nodes: barLeft(14) + iconRight(22) = 36px.
       non-assurance nodes: left(10) + right(10) = 20px. */
    var textInset = assuranceLevel ? 36 : 20;
    var textAreaWidth = w - textInset;
    var titleBaseY = compactNode ? 17 : 20;
    var title = createSvgNode("text", { x: x + textOffsetX, y: y + titleBaseY });
    var titleLines = wrapLabelLines(name, textAreaWidth, compactNode ? 14 : 12);
    for (var ll = 0; ll < titleLines.length; ll++) {
      var tspan = createSvgNode("tspan", { x: x + textOffsetX, dy: ll === 0 ? "0" : "14" });
      tspan.textContent = titleLines[ll];
      title.appendChild(tspan);
    }

    group.appendChild(full);
    group.appendChild(rect);

    /* Content group — clipped to the node rect so text never overflows */
    var contentGroup = createSvgNode("g", { "clip-path": "url(#" + clipId + ")" });

    /* Assurance bar: a thin vertical strip on the left edge of the node */
    if (assuranceLevel) {
      var barPad = 3;
      var barH = Math.max(12, h - barPad * 2);
      var bar = createSvgNode("rect", {
        x: x + 2, y: y + barPad, width: barWidth, height: barH,
        rx: 2, ry: 2, "class": "assurance-bar"
      });
      contentGroup.appendChild(bar);

      /* Small assurance icon in the top-right corner — positioned inside the
         rounded rect boundary.  Scale the Y offset with node height so that
         on compact nodes (h < 40) the icon sits closer to the vertical
         center rather than a fixed 14px from the top which can overlap
         with the title text baseline on very short nodes. */
      var iconChar = ASSURANCE_ICONS[assuranceLevel] || "";
      if (iconChar) {
        var iconY = h < 40 ? y + Math.max(12, Math.round(h * 0.42)) : y + 14;
        var icon = createSvgNode("text", {
          x: x + w - 10, y: iconY,
          "text-anchor": "end", "class": "assurance-icon"
        });
        icon.textContent = iconChar;
        contentGroup.appendChild(icon);
      }
    }

    contentGroup.appendChild(title);

    if ((subtitle || (metaLink && metaLink.label)) && h >= 34) {
      var subtitleLines = wrapLabelLines(subtitle, textAreaWidth, 14);
      /* Cap subtitle lines to prevent content overflow — must match nodeContentHeight.
         When lines are truncated, append an ellipsis to the last visible line so
         users can see that additional content was clipped. */
      var maxSubtitleLines = compactNode ? 2 : 3;
      var subtitleTruncated = subtitleLines.length > maxSubtitleLines;
      if (subtitleTruncated) subtitleLines = subtitleLines.slice(0, maxSubtitleLines);
      /* Position subtitle directly below the last title tspan:
         title baseline starts at y + titleBaseY, each additional line adds 14px */
      var subtitleStartY = y + titleBaseY + (Math.max(1, titleLines.length) - 1) * 14 + 14;
      var meta = createSvgNode("text", { x: x + textOffsetX, y: subtitleStartY, "class": "flow-meta" });
      for (var mm = 0; mm < subtitleLines.length; mm++) {
        var metaSpan = createSvgNode("tspan", { x: x + textOffsetX, dy: mm === 0 ? "0" : "12" });
        var lineText = subtitleLines[mm];
        if (subtitleTruncated && mm === subtitleLines.length - 1) lineText += "\u2026";
        metaSpan.textContent = lineText;
        meta.appendChild(metaSpan);
      }
      if (metaLink && metaLink.href && metaLink.label) {
        var link = createSvgNode("a", { href: metaLink.href, target: "_blank", rel: "noopener noreferrer", "aria-label": metaLink.title || ("Open source for " + name) });
        var linkLines = wrapLabelLines(metaLink.label, textAreaWidth, 14);
        for (var li = 0; li < linkLines.length; li++) {
          var linkSpan = createSvgNode("tspan", { x: x + textOffsetX, dy: (li === 0 && subtitleLines.length) ? "12" : (li === 0 ? "0" : "12"), "class": "flow-meta-link" });
          linkSpan.textContent = linkLines[li];
          link.appendChild(linkSpan);
        }
        meta.appendChild(link);
      }
      contentGroup.appendChild(meta);
    }

    group.appendChild(contentGroup);

    if (onActivate) {
      group.addEventListener("click", function (event) {
        /* Let clicks on the nested source link perform their own navigation */
        if (event.target && event.target.closest && event.target.closest("a")) return;
        onActivate();
      });
      group.addEventListener("keydown", function (event) {
        if (event.target && event.target.closest && event.target.closest("a")) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      });
    }

    nodeLayer.appendChild(group);
    return { name: name, x: x, y: y, w: w, h: h };
  }

  function computeFlowLayout() {
    var wrap = DOM.flowchartWrap || document.getElementById("flowchart-wrap");
    var wrapWidth = Math.max(0, (flowFrameValue(wrap, "clientWidth") || 0) - 8);
    var flowWidth = Math.max(minimumFlowWidth(), wrapWidth || 0);
    var compact = prefersCompactViewport();
    /* Scale padding and gaps for smaller canvases so more area is
       usable for actual node content rather than whitespace. */
    var framePad = compact ? Math.max(14, Math.round(flowWidth * 0.018)) : 34;
    var laneGap = compact ? Math.max(12, Math.round(flowWidth * 0.016)) : 24;
    /* Scale center width proportionally — ensure it can show full module summaries.
       On compact viewports, allow the center to be slightly narrower to give
       more room to side lanes, improving text readability. */
    var centerRatio = compact ? 0.30 : 0.28;
    var minCenter = compact ? 220 : 300;
    var centerWidth = Math.min(380, Math.max(minCenter, Math.floor(flowWidth * centerRatio)));
    /* Allocate remaining width evenly to side lanes */
    var availableSideWidth = Math.floor((flowWidth - framePad * 2 - centerWidth - laneGap * 2) / 2);
    var sideWidth = Math.min(360, Math.max(compact ? 200 : 240, availableSideWidth));
    var leftX = framePad;
    var centerX = leftX + sideWidth + laneGap;
    var rightX = centerX + centerWidth + laneGap;

    return {
      flowWidth: flowWidth,
      framePad: framePad,
      laneGap: laneGap,
      centerWidth: centerWidth,
      sideWidth: sideWidth,
      leftX: leftX,
      centerX: centerX,
      rightX: rightX,
      laneYStart: compact ? 52 : 62,
      laneGapY: compact ? 8 : 10
    };
  }

  function renderFlowchart() {
    var wrap = DOM.flowchartWrap || document.getElementById("flowchart-wrap");
    if (!wrap) return;
    var shouldPreserveScroll = !prefersCompactViewport() && !state.flowScrollTarget;
    var previousScrollLeft = shouldPreserveScroll ? flowFrameValue(wrap, "scrollLeft") : 0;
    var previousScrollTop = shouldPreserveScroll ? flowFrameValue(wrap, "scrollTop") : 0;
    wrap.innerHTML = "";
    flowClipIdCounter = 0;

    var selected = state.selectedModule;
    if (!selected) {
      renderFlowNodeInteriorMenu("");
      wrap.textContent = t("map.select_module_flow") || "Select a module to render interaction and proof flow.";
      return;
    }

    var allImports = (state.importsFrom[selected] || []).slice().sort(sortByScoreThenName);
    var allImporters = (state.importsTo[selected] || []).slice().sort(sortByScoreThenName);
    var allExternal = state.externalImportsFrom[selected] || [];
    /* Hub modules import far more than one lane can stack (SeLe4n.Kernel.API
       pulls in 46). Over budget, a lane groups its modules by subsystem instead
       of cutting the list at the budget, and each group opens in place. */
    var importLane = buildLaneEntries(allImports, "imports");
    var importerLane = buildLaneEntries(allImporters, "importers");
    var imports = importLane.visibleModules;
    var importers = importerLane.visibleModules;
    var externalBudget = state.flowShowAll ? allExternal.length : 12;
    var external = allExternal.slice(0, externalBudget);
    var proofRelated = relatedProofModules(selected);
    var linkedPath = findNearestLinkedPath(selected, state.impactRadius);
    var laneLabels = flowLaneLabelVisibility({
      importCount: allImports.length,
      importerCount: allImporters.length,
      proofCount: proofRelated.length,
      linkedPathLength: linkedPath.length,
      externalCount: allExternal.length
    });
    var contextCache = Object.create(null);
    var interiorCache = Object.create(null);

    function interiorFor(name) {
      if (!name) return makeEmptyInteriorSymbols();
      if (interiorCache[name]) return interiorCache[name];
      interiorCache[name] = interiorCodeForModule(name);
      return interiorCache[name];
    }

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
      var interior = interiorFor(name);
      var objCount = objectDeclarationCount(interior);
      var extCount = extensionDeclarationCount(interior);
      var vArea = verifiableSurfaceArea(interior);
      var parts = [];
      /* Show declaration breakdown: verifiable / total for clarity */
      if (vArea > 0 && vArea !== interior.total) {
        parts.push(vArea + " verif / " + interior.total + " total");
      } else if (objCount > 0 && objCount !== interior.total) {
        parts.push(objCount + " obj / " + interior.total + " total");
      } else {
        parts.push(interior.total + " decl");
      }
      if (ctx.degree.theorems > 0) parts.push(ctx.degree.theorems + " thm");
      if (extCount > 0 && objCount > 0) parts.push(extCount + " ext");
      parts.push("\u2190" + ctx.degree.incoming + " \u2192" + ctx.degree.outgoing);
      /* Always show assurance info — even "none" level is meaningful */
      var icon = ASSURANCE_ICONS[ctx.assurance.level] || ASSURANCE_ICONS.none;
      var covPct = ctx.assurance.coverage > 0 ? " " + Math.round(ctx.assurance.coverage * 100) + "%" : "";
      parts.push(icon + " " + ctx.assurance.strength + covPct);
      return parts.join(" \u00B7 ");
    }

    function nodeTooltip(name, roleLabel) {
      if (!state.moduleMap[name]) return roleLabel + ": " + name;
      var ctx = contextFor(name);
      var interior = interiorFor(name);
      var objCount = objectDeclarationCount(interior);
      var extCount = extensionDeclarationCount(interior);
      var vArea = verifiableSurfaceArea(interior);
      var topKinds = allInteriorKinds().map(function (kind) { return { kind: kind, count: (interior.byKind[kind] || []).length }; }).filter(function (item) { return item.count > 0; }).sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
      var kindPreview = topKinds.map(function (item) { return item.kind + "=" + item.count; }).join(", ");
      var coverageLine = ctx.assurance.coverage > 0
        ? "\ncoverage: " + Math.round(ctx.assurance.coverage * 100) + "% of " + (ctx.assurance.verifiableDeclarations || vArea) + " verifiable declarations"
        : "";
      var pairLine = "";
      var pairInfo = findProofPair(name);
      if (pairInfo) {
        var pairParts = [];
        if (pairInfo.operationsModule) pairParts.push("ops=" + pairInfo.operationsModule);
        if (pairInfo.invariantModule) pairParts.push("inv=" + pairInfo.invariantModule);
        pairLine = "\nproof pair: " + pairParts.join(", ") + (pairInfo.invariantImportsOperations ? " (linked)" : " (unlinked)");
      }
      return roleLabel + "\n" + name + "\npath: " + ctx.path + "\ntheorems: " + ctx.degree.theorems + " | obj: " + objCount + " | ext: " + extCount + " | verifiable: " + vArea + " | total: " + interior.total + " | fan-in: " + ctx.degree.incoming + " | fan-out: " + ctx.degree.outgoing + "\nactive kinds: " + (kindPreview || "none") + "\nassurance: " + ctx.assurance.label + coverageLine + pairLine;
    }

    var layout = computeFlowLayout();
    var flowWidth = layout.flowWidth;
    var framePad = layout.framePad;
    var centerWidth = layout.centerWidth;
    var sideWidth = layout.sideWidth;
    var leftX = layout.leftX;
    var centerX = layout.centerX;
    var rightX = layout.rightX;
    var laneYStart = layout.laneYStart;
    var laneGapY = layout.laneGapY;

    var laneNestIndent = 18;

    function laneGroupTitle(entry) {
      return (entry.expanded ? "\u25BE " : "\u25B8 ") + entry.label;
    }

    function laneGroupSummary(entry) {
      var theorems = 0;
      for (var gi = 0; gi < entry.members.length; gi++) theorems += moduleDegree(entry.members[gi]).theorems;
      var counts = t("map.lane_group_summary", { count: entry.members.length, theorems: formatCount(theorems) })
        || (entry.members.length + " modules \u00B7 " + formatCount(theorems) + " thm");
      var hint = entry.expanded
        ? (t("map.group_collapse") || "click to collapse")
        : (t("map.group_expand") || "click to expand");
      return counts + " \u00B7 " + hint;
    }

    function stackedLayout(entries, width, subtitleFn, compactHint, includeSourceLinks) {
      var nodes = [];
      var cursor = laneYStart;
      for (var ii = 0; ii < entries.length; ii++) {
        var entry = entries[ii];
        if (entry.type === "group") {
          var groupTitle = laneGroupTitle(entry);
          var groupSubtitle = laneGroupSummary(entry);
          var groupHeight = nodeContentHeight(groupTitle, groupSubtitle, width, true, "", false);
          nodes.push({ entry: entry, name: groupTitle, x: 0, w: width, y: cursor, h: groupHeight, subtitle: groupSubtitle, sourceLink: null });
          cursor += groupHeight + laneGapY;
          continue;
        }
        var indent = entry.nested ? laneNestIndent : 0;
        var nodeWidth = width - indent;
        var subtitleText = subtitleFn ? subtitleFn(entry.name) : "";
        var srcLink = includeSourceLinks ? moduleSourceLink(entry.name) : null;
        /* Module nodes always have assurance indicators */
        var height = nodeContentHeight(entry.name, subtitleText, nodeWidth, compactHint, srcLink ? srcLink.label : "", true);
        nodes.push({ entry: entry, name: entry.name, x: indent, w: nodeWidth, y: cursor, h: height, subtitle: subtitleText, sourceLink: srcLink });
        cursor += height + laneGapY;
      }
      return { nodes: nodes, bottom: entries.length ? (cursor - laneGapY) : laneYStart + 44 };
    }

    var importLayout = stackedLayout(importLane.entries, sideWidth, moduleSummary, false, true);
    var importerLayout = stackedLayout(importerLane.entries, sideWidth, moduleSummary, false, true);
    var laneBottom = Math.max(importLayout.bottom, importerLayout.bottom);

    var centerSourceLink = moduleSourceLink(selected);
    var centerHeight = nodeContentHeight(selected, moduleSummary(selected), centerWidth, false, centerSourceLink ? centerSourceLink.label : "", true) + 14;
    var laneContentHeight = Math.max(importLayout.bottom, importerLayout.bottom) - laneYStart;
    var idealCenterY = laneYStart + Math.floor((laneContentHeight - centerHeight) / 2);
    /* Anchor center node proportionally: when both lanes exist, center between
       them. When only one lane has nodes, anchor closer to it so the center
       stays visually connected. When both are empty, start near the top. */
    var hasLeftLane = importLayout.nodes.length > 0;
    var hasRightLane = importerLayout.nodes.length > 0;
    var minCenterY, maxCenterY;
    if (!hasLeftLane && !hasRightLane) {
      /* No side lanes — position center near top */
      minCenterY = laneYStart;
      maxCenterY = laneYStart + 40;
    } else if (hasLeftLane !== hasRightLane) {
      /* Single-sided — anchor center near the populated lane's visual center */
      var populatedBottom = hasLeftLane ? importLayout.bottom : importerLayout.bottom;
      var populatedHeight = populatedBottom - laneYStart;
      minCenterY = laneYStart + Math.min(10, Math.floor(populatedHeight * 0.1));
      maxCenterY = Math.max(minCenterY, laneYStart + Math.floor(populatedHeight * 0.45));
    } else {
      /* Both lanes populated — use proportional clamp */
      minCenterY = laneYStart + Math.min(20, Math.floor(laneContentHeight * 0.15));
      maxCenterY = Math.max(minCenterY, laneYStart + Math.floor(laneContentHeight * 0.5));
    }
    var centerY = Math.max(minCenterY, Math.min(maxCenterY, idealCenterY));
    var centerBottom = centerY + centerHeight;

    var sectionGap = prefersCompactViewport() ? 36 : 54;
    var lowerSectionTop = Math.max(laneBottom + sectionGap, centerBottom + sectionGap);
    var proofStartY = lowerSectionTop;
    var proofBottom = proofStartY;
    var proofHeights = [];
    var proofSourceLinks = [];
    for (var pr = 0; pr < proofRelated.length; pr++) {
      var prLink = moduleSourceLink(proofRelated[pr]);
      proofSourceLinks.push(prLink);
      var prH = nodeContentHeight(proofRelated[pr], moduleSummary(proofRelated[pr]), centerWidth, true, prLink ? prLink.label : "", true);
      proofHeights.push(prH);
      proofBottom += prH + 8;
    }
    proofBottom = Math.max(proofBottom, proofStartY + 42);
    var pathStartY = proofBottom + 54;

    var pathNodeWidth = 240;
    var pathGapX = 20;
    var pathGapY = 14;
    var pathStartX = Math.max(framePad, centerX - 180);
    var pathMaxX = Math.max(pathStartX, flowWidth - framePad - pathNodeWidth);
    var pathAvailableWidth = pathMaxX - pathStartX + pathNodeWidth;
    var pathPerRow = Math.max(1, Math.floor((pathAvailableWidth + pathGapX) / (pathNodeWidth + pathGapX)));
    var pathItems = [];
    var pathBlockBottom = pathStartY;
    if (linkedPath.length > 1) {
      var pathRowHeights = [];
      for (var lp = 1; lp < linkedPath.length; lp++) {
        var pathName = linkedPath[lp];
        var pathHeight = nodeContentHeight(pathName, moduleSummary(pathName), pathNodeWidth, true, "", true);
        var pathIndex = lp - 1;
        var pathRow = Math.floor(pathIndex / pathPerRow);
        var pathCol = pathIndex % pathPerRow;
        pathRowHeights[pathRow] = Math.max(pathRowHeights[pathRow] || 0, pathHeight);
        pathItems.push({
          name: pathName,
          col: pathCol,
          row: pathRow,
          h: pathHeight
        });
      }
      var pathRowY = [];
      var pathCursorY = pathStartY;
      for (var py = 0; py < pathRowHeights.length; py++) {
        pathRowY[py] = pathCursorY;
        pathCursorY += (pathRowHeights[py] || 0) + pathGapY;
      }
      for (var pi = 0; pi < pathItems.length; pi++) {
        pathItems[pi].x = Math.min(pathMaxX, pathStartX + pathItems[pi].col * (pathNodeWidth + pathGapX));
        pathItems[pi].y = pathRowY[pathItems[pi].row];
      }
      pathBlockBottom = Math.max(pathStartY + 42, pathCursorY - pathGapY);
    }

    var externalPerRow = Math.max(2, Math.min(6, Math.floor((flowWidth - framePad * 2) / 220)));
    var externalGapX = 12;
    var externalGapY = 12;
    var externalStartY = pathBlockBottom + (linkedPath.length > 1 ? 36 : 20);
    var externalWidth = Math.max(180, Math.floor((flowWidth - framePad * 2 - (externalPerRow - 1) * externalGapX) / externalPerRow));
    var externalItems = [];
    var externalBottom = externalStartY;
    if (external.length) {
      var externalRowHeights = [];
      var externalNodeHeights = [];
      for (var ex = 0; ex < external.length; ex++) {
        var exRow = Math.floor(ex / externalPerRow);
        var exH = nodeContentHeight(external[ex], externalImportSubtitle(external[ex]), externalWidth, true, "", false);
        externalNodeHeights.push(exH);
        externalRowHeights[exRow] = Math.max(externalRowHeights[exRow] || 0, exH);
      }
      var externalRowY = [];
      var externalCursorY = externalStartY;
      for (var er = 0; er < externalRowHeights.length; er++) {
        externalRowY[er] = externalCursorY;
        externalCursorY += (externalRowHeights[er] || 0) + externalGapY;
      }

      for (var ez = 0; ez < external.length; ez++) {
        var rowIndex = Math.floor(ez / externalPerRow);
        var colIndex = ez % externalPerRow;
        externalItems.push({
          name: external[ez],
          x: leftX + colIndex * (externalWidth + externalGapX),
          y: externalRowY[rowIndex],
          h: externalNodeHeights[ez]
        });
      }

      externalBottom = Math.max(externalBottom, externalCursorY - externalGapY);
      if (allExternal.length > external.length) {
        var moreRow = Math.floor(external.length / externalPerRow);
        var moreCol = external.length % externalPerRow;
        var moreY = typeof externalRowY[moreRow] === "number" ? externalRowY[moreRow] : externalCursorY;
        externalItems.push({
          name: "+" + (allExternal.length - external.length) + " more",
          x: leftX + moreCol * (externalWidth + externalGapX),
          y: moreY,
          h: 36
        });
        externalBottom = Math.max(externalBottom, moreY + 36);
      }
    } else {
      externalBottom = externalStartY + 36;
    }
    var hasExternalSection = external.length > 0;
    var hasPathSection = linkedPath.length > 1;
    var hasProofSection = proofRelated.length > 0;
    /* Compute effective bottom by finding the lowest section that has content */
    var lastSectionBottom = hasExternalSection ? externalBottom
      : hasPathSection ? pathBlockBottom
      : hasProofSection ? proofBottom
      : Math.max(laneBottom, centerBottom);

    /* The Rust boundary sits under everything Lean: a reader scrolls through
       the module's own context first and meets the other language last. */
    var bandRows = bridgeBandRows(selected);
    var bandLayout = layoutBridgeBands(bandRows, {
      startY: lastSectionBottom + (prefersCompactViewport() ? 40 : 58),
      leftX: leftX,
      width: externalWidth,
      perRow: externalPerRow
    });

    var effectiveBottom = bandRows.length ? bandLayout.bottom : lastSectionBottom;
    var minFlowHeight = prefersCompactViewport() ? 420 : 620;
    var flowHeight = Math.max(minFlowHeight, effectiveBottom + (hasExternalSection || bandRows.length ? 48 : 32));

    wrap.appendChild(createFlowLegend(flowLegendItems(), "Flow chart legend"));

    var svgAriaLabel = "Flow chart for " + selected + ": " + allImports.length + " import" + (allImports.length === 1 ? "" : "s") + ", " + allImporters.length + " impacted module" + (allImporters.length === 1 ? "" : "s") + (proofRelated.length ? ", " + proofRelated.length + " proof neighbor" + (proofRelated.length === 1 ? "" : "s") : "") + (external.length ? ", " + allExternal.length + " external import" + (allExternal.length === 1 ? "" : "s") : "");
    var flowSvg = createFlowSvg(flowWidth, flowHeight, svgAriaLabel);
    var svg = flowSvg.svg;
    var edgeLayer = flowSvg.edgeLayer;
    var nodeLayer = flowSvg.nodeLayer;
    var labelLayer = flowSvg.labelLayer;

    function laneLabel(text, x, y, color) {
      flowLaneLabel(labelLayer, text, x, y, color);
    }

    function createNode(name, x, y, w, h, color, subtitle, tooltip, active, isStatic, assuranceLevel, onActivate, metaLink, extraClass) {
      var className = "flow-node" + (active ? " active" : "") + (isStatic ? " static" : "");
      if (onActivate) className += " action";
      if (assuranceLevel && !isStatic) className += " assurance-" + assuranceLevel;
      if (extraClass) className += " " + extraClass;
      var interactive = !isStatic || Boolean(onActivate);
      var ariaLabel = interactive ? (onActivate ? name : ("Select module " + name)) : name;
      var activator = interactive ? (onActivate || function () { selectModule(name, false); }) : null;
      return buildFlowNodeGroup(nodeLayer, className, interactive, ariaLabel, name, x, y, w, h, color, subtitle, tooltip, activator, metaLink || null);
    }

    if (laneLabels.imports) laneLabel(t("map.lane_imports") || "Imports used by selected", leftX, 30, "#35c98f");
    if (laneLabels.selected) laneLabel(t("map.lane_selected") || "Selected module context", centerX, centerY - 12, "#7c9cff");
    if (laneLabels.impacted) laneLabel(t("map.lane_impacted") || "Modules impacted by selected", rightX, 30, "#ffad42");

    var center = createNode(selected, centerX, centerY, centerWidth, centerHeight, "#7c9cff", moduleSummary(selected), nodeTooltip(selected, "Selected module context"), true, false, contextFor(selected).assurance.level, null, centerSourceLink);

    function laneGroupTooltip(entry, roleLabel) {
      return roleLabel + "\n" + entry.label + "\n" + entry.members.length + " modules:\n" + entry.members.join("\n");
    }

    function renderLane(layout, laneX, color, laneKey, roleLabel, groupRoleLabel) {
      /* Returns the nodes that get an edge to the centre: group nodes and
         top-level module nodes. Opened members hang off their group on a
         guide line instead, so one expanded subsystem does not fan a dozen
         curves into the centre node. */
      var edgeNodes = [];
      var openGroup = null;
      var lastMember = null;

      function closeGroup() {
        if (openGroup && lastMember) drawLaneGuide(edgeLayer, openGroup, lastMember, color);
        openGroup = null;
        lastMember = null;
      }

      for (var li = 0; li < layout.nodes.length; li++) {
        var item = layout.nodes[li];
        if (item.entry.type === "group") {
          closeGroup();
          var groupNode = createNode(item.name, laneX + item.x, item.y, item.w, item.h, color, item.subtitle, laneGroupTooltip(item.entry, groupRoleLabel), false, true, "", toggleLaneGroup(laneKey, item.entry.key), null, "lane-group" + (item.entry.expanded ? " lane-group-open" : ""));
          edgeNodes.push(groupNode);
          if (item.entry.expanded) openGroup = groupNode;
          continue;
        }
        var moduleNode = createNode(item.name, laneX + item.x, item.y, item.w, item.h, color, item.subtitle, nodeTooltip(item.name, roleLabel), false, false, contextFor(item.name).assurance.level, null, item.sourceLink, item.entry.nested ? "lane-member" : "");
        if (item.entry.nested) {
          lastMember = moduleNode;
        } else {
          closeGroup();
          edgeNodes.push(moduleNode);
        }
      }
      closeGroup();
      return edgeNodes;
    }

    var importNodes = renderLane(importLayout, leftX, "#35c98f", "imports", "Imported dependency", "Imported subsystem");
    var importerNodes = renderLane(importerLayout, rightX, "#ffad42", "importers", "Impacted module", "Impacted subsystem");

    var hasHiddenImports = !importLane.grouped && allImports.length > imports.length;
    var hasHiddenImporters = !importerLane.grouped && allImporters.length > importers.length;
    var canMinimizeImports = state.flowShowAll && allImports.length > state.neighborLimit;
    var canMinimizeImporters = state.flowShowAll && allImporters.length > state.neighborLimit;

    if (hasHiddenImports) {
      createNode(laneMoreLabel("map.lane_more_imports", allImports.length - imports.length, "imports"), leftX, importLayout.bottom + laneGapY, sideWidth, 36, "#35c98f", t("map.switch_expanded") || "switch to Expanded mode", "Activate expanded mode", false, true, "", setExpandedFlowMode);
    } else if (canMinimizeImports) {
      createNode(t("map.return_compact") || "Return to Compact mode", leftX, importLayout.bottom + laneGapY, sideWidth, 36, "#35c98f", t("map.hide_extra_imports") || "hide extra imports", "Activate compact mode", false, true, "", setCompactFlowMode);
    }

    if (hasHiddenImporters) {
      createNode(laneMoreLabel("map.lane_more_impacted", allImporters.length - importers.length, "impacted modules"), rightX, importerLayout.bottom + laneGapY, sideWidth, 36, "#ffad42", t("map.switch_expanded") || "switch to Expanded mode", "Activate expanded mode", false, true, "", setExpandedFlowMode);
    } else if (canMinimizeImporters) {
      createNode(t("map.return_compact") || "Return to Compact mode", rightX, importerLayout.bottom + laneGapY, sideWidth, 36, "#ffad42", t("map.hide_extra_impacted") || "hide extra impacted modules", "Activate compact mode", false, true, "", setCompactFlowMode);
    }

    var importSpread = Math.min(64, Math.max(14, Math.round(14 + Math.sqrt(Math.max(1, importNodes.length)) * 6)));
    var importerSpread = Math.min(64, Math.max(14, Math.round(14 + Math.sqrt(Math.max(1, importerNodes.length)) * 6)));
    for (var k = 0; k < importNodes.length; k++) {
      drawFlowEdge(edgeLayer, importNodes[k], center, "#35c98f", false, { rank: k, total: importNodes.length, spread: importSpread });
    }
    for (var m = 0; m < importerNodes.length; m++) {
      drawFlowEdge(edgeLayer, center, importerNodes[m], "#ffad42", false, { rank: m, total: importerNodes.length, spread: importerSpread });
    }

    if (proofRelated.length) {
      if (laneLabels.proof) laneLabel(t("map.lane_proof") || "Proof pair context", centerX, proofStartY - 16, "#d37cff");
      var proofY = proofStartY;
      for (var n = 0; n < proofRelated.length; n++) {
        var proofModName = proofRelated[n];
        var proofModKind = moduleKind(proofModName);
        var proofRoleLabel = proofModKind === "operations" ? "Operations module"
          : proofModKind === "invariant" ? "Invariant module"
          : "Proof-pair neighbor";
        var proofNode = createNode(proofModName, centerX, proofY, centerWidth, proofHeights[n], "#d37cff", moduleSummary(proofModName), nodeTooltip(proofModName, proofRoleLabel), false, false, contextFor(proofModName).assurance.level, null, proofSourceLinks[n]);
        drawFlowEdge(edgeLayer, center, proofNode, "#d37cff", true, { rank: n, total: proofRelated.length, spread: 18, vertical: true });
        proofY += proofHeights[n] + 8;
      }
    }

    if (linkedPath.length > 1) {
      if (laneLabels.linkedPath) laneLabel(t("map.lane_linked_path", { radius: state.impactRadius }) || ("Nearest linked-proof path (radius " + state.impactRadius + ")"), Math.max(framePad, centerX - 180), pathStartY - 14, "#6de2ff");
      var previousNode = center;
      for (var q = 0; q < pathItems.length; q++) {
        var pathItem = pathItems[q];
        var pathNode = createNode(pathItem.name, pathItem.x, pathItem.y, pathNodeWidth, pathItem.h, "#6de2ff", moduleSummary(pathItem.name), nodeTooltip(pathItem.name, "Linked-proof path step " + (q + 1)), false, false, contextFor(pathItem.name).assurance.level);
        var pathEdgeVertical = Math.abs((previousNode.x + previousNode.w / 2) - (pathNode.x + pathNodeWidth / 2)) < pathNodeWidth;
        drawFlowEdge(edgeLayer, previousNode, pathNode, "#6de2ff", true, { rank: q, total: Math.max(1, pathItems.length), spread: 12, vertical: pathEdgeVertical });
        previousNode = pathNode;
      }
    }

    if (laneLabels.external) {
      laneLabel(t("map.lane_external") || "External imports", leftX, externalStartY - 10, "#b9c0d0");
      var externalEdgeNodes = [];
      for (var z = 0; z < externalItems.length; z++) {
        var externalItem = externalItems[z];
        var isMorePlaceholder = externalItem.name.charAt(0) === "+";
        var extSubtitle = isMorePlaceholder ? "" : externalImportSubtitle(externalItem.name);
        var extNode = createNode(externalItem.name, externalItem.x, externalItem.y, externalWidth, externalItem.h, "#b9c0d0", extSubtitle, isMorePlaceholder ? "" : externalImportTooltip(externalItem.name, selected), false, true, "");
        if (!isMorePlaceholder) externalEdgeNodes.push(extNode);
      }
      /* Draw subtle edges from center to each external import node */
      for (var ze = 0; ze < externalEdgeNodes.length; ze++) {
        drawFlowEdge(edgeLayer, center, externalEdgeNodes[ze], "#b9c0d0", true, { rank: ze, total: externalEdgeNodes.length, spread: Math.min(40, externalEdgeNodes.length * 4), vertical: true });
      }
    }

    if (bandRows.length) {
      drawBridgeBands(bandLayout, {
        leftX: leftX,
        edgeLayer: edgeLayer,
        center: center,
        laneLabel: laneLabel,
        createNode: function (name, x, y, w, h, color, subtitle, tooltip) {
          return createNode(name, x, y, w, h, color, subtitle, tooltip, false, false, "", (function (target) {
            return function () { selectModule(target, false); };
          })(name), moduleSourceLink(name), "flow-node-rust flow-node-bridge");
        }
      });
    }

    flowSvg.flush();
    wrap.appendChild(svg);

    renderFlowNodeInteriorMenu(selected);

    if (!applyFlowScrollTarget(wrap, selected, center.x, center.y, center.w, center.h)) {
      restoreFlowScroll(wrap, previousScrollLeft, previousScrollTop);
    }
  }

  /* ------------------------------------------------------------------
     The boundary band

     Drawn under both charts in the combined scope. Three rows, each with its
     own direction: what the other language implements for this node, what it
     calls into this node, and the definitions the two sides share. The arrow
     carries the direction, so `outbound` is the only thing the caller states.
     ------------------------------------------------------------------ */

  function bridgeBandRows(name) {
    var bands = bridgeBandsFor(name);
    if (!bands.total) return [];
    var fromRust = isRustNode(name);
    var rows = [];
    function push(edges, relation, key, fallback, outbound) {
      if (!edges.length) return;
      rows.push({
        relation: relation,
        edges: edges,
        color: BRIDGE_COLORS[relation],
        label: t(key) || fallback,
        outbound: outbound,
        fromRust: fromRust
      });
    }
    if (fromRust) {
      push(bands.implements, "implements", "map.bridge_declared_in_lean", "Declared in Lean · implemented here", false);
      push(bands.invokes, "invokes", "map.bridge_kernel_operations", "Kernel operations this wrapper calls", true);
      push(bands.mirrors, "mirrors", "map.bridge_mirrored", "Written on both sides of the seam", false);
      push(bands.shared, "shares", "map.bridge_shared", "Definitions shared across the boundary", false);
    } else {
      push(bands.invokes, "invokes", "map.bridge_called_from_rust", "Called from Rust user space", false);
      push(bands.implements, "implements", "map.bridge_implemented_in_rust", "Declared here · implemented in Rust", true);
      push(bands.mirrors, "mirrors", "map.bridge_mirrored", "Written on both sides of the seam", false);
      push(bands.shared, "shares", "map.bridge_shared", "Definitions shared across the boundary", false);
    }
    return rows;
  }

  function layoutBridgeBands(rows, options) {
    var opts = options || {};
    var perRow = Math.max(1, Number(opts.perRow) || 3);
    var width = Math.max(180, Number(opts.width) || 220);
    var gapX = Number(opts.gapX) || 12;
    var gapY = Number(opts.gapY) || 12;
    var cursor = Number(opts.startY) || 0;
    var out = [];

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var labelY = cursor;
      cursor += 18;
      var items = [];
      var rowHeights = [];
      for (var i = 0; i < row.edges.length; i++) {
        var edge = row.edges[i];
        var label = bridgeCounterpartName(edge, row.fromRust);
        var subtitle = bridgeEdgeSubtitle(edge, row.fromRust);
        var height = nodeContentHeight(label, subtitle, width, true, "", false);
        var gridRow = Math.floor(i / perRow);
        rowHeights[gridRow] = Math.max(rowHeights[gridRow] || 0, height);
        items.push({ edge: edge, name: label, subtitle: subtitle, h: height, col: i % perRow, row: gridRow });
      }
      var rowY = [];
      for (var g = 0; g < rowHeights.length; g++) {
        rowY[g] = cursor;
        cursor += rowHeights[g] + gapY;
      }
      for (var k = 0; k < items.length; k++) {
        items[k].x = (Number(opts.leftX) || 0) + items[k].col * (width + gapX);
        items[k].y = rowY[items[k].row];
      }
      out.push({ row: row, labelY: labelY, items: items, width: width });
      cursor += 10;
    }

    return { bands: out, bottom: Math.max(Number(opts.startY) || 0, cursor - gapY - 10) };
  }

  function drawBridgeBands(layout, context) {
    for (var b = 0; b < layout.bands.length; b++) {
      var band = layout.bands[b];
      context.laneLabel(band.row.label, context.leftX, band.labelY, band.row.color);
      var drawn = [];
      for (var i = 0; i < band.items.length; i++) {
        var item = band.items[i];
        var node = context.createNode(
          item.name,
          item.x,
          item.y,
          band.width,
          item.h,
          band.row.color,
          item.subtitle,
          bridgeEdgeTooltip(item.edge, band.row.fromRust),
          item.edge
        );
        drawn.push(node);
      }
      var undirected = Boolean(BRIDGE_UNDIRECTED[band.row.relation]);
      for (var d = 0; d < drawn.length; d++) {
        var variant = {
          rank: d, total: drawn.length, spread: Math.min(40, drawn.length * 5),
          vertical: true, undirected: undirected
        };
        if (band.row.outbound) {
          drawFlowEdge(context.edgeLayer, context.center, drawn[d], band.row.color, undirected, variant);
        } else {
          drawFlowEdge(context.edgeLayer, drawn[d], context.center, band.row.color, undirected, variant);
        }
      }
    }
  }

  /* ------------------------------------------------------------------
     The Rust chart

     Same three-lane frame as the Lean chart, read in Rust's own terms: the
     module path that reaches this file on the left, the modules it declares
     on the right, its crate's dependency context below, and — in the combined
     scope — the boundary band under that.
     ------------------------------------------------------------------ */

  function rustAncestorChain(name) {
    var chain = [];
    var seen = Object.create(null);
    var cursor = rustNode(name);
    while (cursor && cursor.parent && !seen[cursor.parent]) {
      seen[cursor.parent] = true;
      chain.push(cursor.parent);
      cursor = rustNode(cursor.parent);
    }
    /* Root first, immediate parent last, so the column reads downwards as the
       module path does: sele4n-abi → args → (selected) args::cspace. */
    return chain.reverse();
  }

  /* A leaf module declares nothing, which would leave the right lane empty and
     the crate unbrowsable from it. Its siblings — the modules its own parent
     declares alongside it — go there instead, and the edges come from that
     parent rather than from the centre, because that is who declares them. */
  function rustSiblings(name) {
    var node = rustNode(name);
    if (!node || !node.parent) return [];
    var parent = rustNode(node.parent);
    if (!parent) return [];
    var out = [];
    for (var i = 0; i < parent.children.length; i++) {
      if (parent.children[i] !== name) out.push(parent.children[i]);
    }
    return out;
  }

  function renderRustFlowchart() {
    var wrap = DOM.flowchartWrap || document.getElementById("flowchart-wrap");
    if (!wrap) return;
    var shouldPreserveScroll = !prefersCompactViewport() && !state.flowScrollTarget;
    var previousScrollLeft = shouldPreserveScroll ? flowFrameValue(wrap, "scrollLeft") : 0;
    var previousScrollTop = shouldPreserveScroll ? flowFrameValue(wrap, "scrollTop") : 0;
    wrap.innerHTML = "";
    flowClipIdCounter = 0;

    var selected = state.selectedModule;
    var node = rustNode(selected);
    if (!node) {
      wrap.textContent = t("map.select_module_flow") || "Select a module to render interaction and proof flow.";
      renderFlowNodeInteriorMenu("");
      return;
    }

    var ancestors = rustAncestorChain(selected);
    /* The right lane holds what this module declares; a leaf has nothing to
       declare, so it holds what its parent declares alongside it instead. */
    var declaresChildren = node.children.length > 0;
    var allKin = declaresChildren ? node.children.slice() : rustSiblings(selected);
    var kinBudget = state.flowShowAll ? allKin.length : Math.max(state.neighborLimit, 8);
    var kin = allKin.slice(0, kinBudget);
    var dependencies = rustCrateDependencies(node.crate);

    var layout = computeFlowLayout();
    var flowWidth = layout.flowWidth;
    var framePad = layout.framePad;
    var centerWidth = layout.centerWidth;
    var sideWidth = layout.sideWidth;
    var leftX = layout.leftX;
    var centerX = layout.centerX;
    var rightX = layout.rightX;
    var laneYStart = layout.laneYStart;
    var laneGapY = layout.laneGapY;

    function stack(names, width) {
      var out = [];
      var cursor = laneYStart;
      for (var i = 0; i < names.length; i++) {
        var subtitle = rustNodeSummary(names[i]);
        var link = moduleSourceLink(names[i]);
        var height = nodeContentHeight(names[i], subtitle, width, false, link ? link.label : "", false);
        out.push({ name: names[i], y: cursor, h: height, subtitle: subtitle, sourceLink: link });
        cursor += height + laneGapY;
      }
      return { nodes: out, bottom: names.length ? cursor - laneGapY : laneYStart + 44 };
    }

    var ancestorLayout = stack(ancestors, sideWidth);
    var kinLayout = stack(kin, sideWidth);
    var laneBottom = Math.max(ancestorLayout.bottom, kinLayout.bottom);

    var centerSubtitle = node.isRoot
      ? rustCrateSummary(node.crate)
      : rustNodeSummary(selected);
    var centerSourceLink = moduleSourceLink(selected);
    var centerHeight = nodeContentHeight(selected, centerSubtitle, centerWidth, false, centerSourceLink ? centerSourceLink.label : "", false) + 14;
    var laneContentHeight = laneBottom - laneYStart;
    var centerY = Math.max(laneYStart, laneYStart + Math.floor(Math.max(0, laneContentHeight - centerHeight) / 2));
    centerY = Math.min(centerY, laneYStart + Math.max(0, Math.floor(laneContentHeight * 0.5)));
    var centerBottom = centerY + centerHeight;

    var sectionGap = prefersCompactViewport() ? 36 : 54;
    var depStartY = Math.max(laneBottom, centerBottom) + sectionGap;
    var depPerRow = Math.max(2, Math.min(6, Math.floor((flowWidth - framePad * 2) / 220)));
    var depWidth = Math.max(180, Math.floor((flowWidth - framePad * 2 - (depPerRow - 1) * 12) / depPerRow));
    var depItems = [];
    var depBottom = depStartY;
    if (dependencies.length) {
      var depRowHeights = [];
      for (var di = 0; di < dependencies.length; di++) {
        var depRow = Math.floor(di / depPerRow);
        var depHeight = nodeContentHeight(dependencies[di].name, dependencies[di].label, depWidth, true, "", false);
        depRowHeights[depRow] = Math.max(depRowHeights[depRow] || 0, depHeight);
        depItems.push({ dep: dependencies[di], h: depHeight, col: di % depPerRow, row: depRow });
      }
      var depRowY = [];
      var depCursor = depStartY;
      for (var dr = 0; dr < depRowHeights.length; dr++) {
        depRowY[dr] = depCursor;
        depCursor += depRowHeights[dr] + 12;
      }
      for (var dz = 0; dz < depItems.length; dz++) {
        depItems[dz].x = leftX + depItems[dz].col * (depWidth + 12);
        depItems[dz].y = depRowY[depItems[dz].row];
      }
      depBottom = Math.max(depStartY, depCursor - 12);
    }

    var bandRows = bridgeBandRows(selected);
    var bandStartY = (dependencies.length ? depBottom : Math.max(laneBottom, centerBottom)) + sectionGap;
    var bandLayout = layoutBridgeBands(bandRows, {
      startY: bandStartY,
      leftX: leftX,
      width: depWidth,
      perRow: depPerRow
    });

    var effectiveBottom = bandRows.length ? bandLayout.bottom
      : dependencies.length ? depBottom
      : Math.max(laneBottom, centerBottom);
    var minFlowHeight = prefersCompactViewport() ? 420 : 620;
    var flowHeight = Math.max(minFlowHeight, effectiveBottom + 48);

    wrap.appendChild(createFlowLegend(rustFlowLegendItems(), "Rust flow chart legend"));

    var svgAriaLabel = "Rust module chart for " + selected + ": "
      + ancestors.length + " enclosing module" + (ancestors.length === 1 ? "" : "s") + ", "
      + allKin.length + (declaresChildren ? " declared module" : " sibling module") + (allKin.length === 1 ? "" : "s") + ", "
      + dependencies.length + " crate dependenc" + (dependencies.length === 1 ? "y" : "ies")
      + (bandRows.length ? ", " + bridgeBandsFor(selected).total + " Lean boundary edges" : "");
    var flowSvg = createFlowSvg(flowWidth, flowHeight, svgAriaLabel);
    var svg = flowSvg.svg;
    var edgeLayer = flowSvg.edgeLayer;
    var nodeLayer = flowSvg.nodeLayer;
    var labelLayer = flowSvg.labelLayer;

    function laneLabel(text, x, y, color) {
      flowLaneLabel(labelLayer, text, x, y, color);
    }

    function createNode(name, x, y, w, h, color, subtitle, tooltip, onActivate, metaLink, extraClass, active) {
      var className = "flow-node flow-node-rust" + (active ? " active" : "") + (onActivate ? " action" : "");
      if (!onActivate && !active) className += " static";
      if (extraClass) className += " " + extraClass;
      var interactive = Boolean(onActivate);
      return buildFlowNodeGroup(nodeLayer, className, interactive, name, name, x, y, w, h, color, subtitle, tooltip, onActivate || null, metaLink || null);
    }

    if (ancestors.length) laneLabel(t("map.rust_lane_enclosing") || "Module path", leftX, 30, "#35c98f");
    if (kin.length) {
      laneLabel(declaresChildren
        ? (t("map.rust_lane_declares") || "Modules declared here")
        : (t("map.rust_lane_siblings", { module: node.parent }) || ("Declared alongside, in " + node.parent)),
        rightX, 30, "#ffad42");
    }
    laneLabel(rustNodeRoleLabel(node.role) + " · " + node.crateName, centerX, centerY - 12, "#7c9cff");

    var center = createNode(selected, centerX, centerY, centerWidth, centerHeight, "#7c9cff", centerSubtitle, rustNodeTooltip(selected, t("map.rust_role_selected") || "Selected Rust module"), null, centerSourceLink, "", true);

    function laneNodes(entries, laneX, color, roleLabel) {
      var drawn = [];
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        drawn.push(createNode(
          entry.name, laneX, entry.y, sideWidth, entry.h, color, entry.subtitle,
          rustNodeTooltip(entry.name, roleLabel),
          (function (target) { return function () { selectModule(target, false); }; })(entry.name),
          entry.sourceLink
        ));
      }
      return drawn;
    }

    var ancestorNodes = laneNodes(ancestorLayout.nodes, leftX, "#35c98f", t("map.rust_role_enclosing") || "Enclosing module");
    var kinNodes = laneNodes(kinLayout.nodes, rightX, "#ffad42",
      declaresChildren ? (t("map.rust_role_child") || "Declared module") : (t("map.rust_role_sibling") || "Sibling module"));

    if (!state.flowShowAll && allKin.length > kin.length) {
      createNode(
        laneMoreLabel("map.lane_more", allKin.length - kin.length, ""),
        rightX, kinLayout.bottom + laneGapY, sideWidth, 36, "#ffad42",
        t("map.switch_expanded") || "switch to Expanded mode",
        "Activate expanded mode", setExpandedFlowMode
      );
    }

    /* The enclosing path is a chain, so draw it as one: root → … → parent →
       selected. Edging every ancestor straight to the centre said the crate
       root declares `sele4n-abi::args::cspace`, when `args` does — the lane is
       the module tree recorded in `parent`, not a set of loose relations. */
    for (var a = 0; a < ancestorNodes.length; a++) {
      var from = ancestorNodes[a];
      var to = a + 1 < ancestorNodes.length ? ancestorNodes[a + 1] : center;
      drawFlowEdge(edgeLayer, from, to, "#35c98f", false, { rank: a, total: ancestorNodes.length, spread: 20 });
    }
    /* Children hang off the centre; siblings hang off the parent that declares
       them, which is the last node in the ancestor column. */
    var kinSource = declaresChildren ? center : (ancestorNodes.length ? ancestorNodes[ancestorNodes.length - 1] : center);
    for (var ch = 0; ch < kinNodes.length; ch++) {
      drawFlowEdge(edgeLayer, kinSource, kinNodes[ch], "#ffad42", !declaresChildren, { rank: ch, total: kinNodes.length, spread: Math.min(64, 14 + kinNodes.length * 3) });
    }

    if (depItems.length) {
      laneLabel(t("map.rust_lane_dependencies", { crate: node.crateName }) || ("Crate dependencies of " + node.crateName), leftX, depStartY - 10, "#b9c0d0");
      for (var dep = 0; dep < depItems.length; dep++) {
        var item = depItems[dep];
        var targetRoot = item.dep.navigable && state.rustGraph ? state.rustGraph.crateRootOf[item.dep.name] : "";
        var activate = targetRoot ? (function (target) { return function () { selectModule(target, false); }; })(targetRoot) : null;
        var depNode = createNode(item.dep.name, item.x, item.y, depWidth, item.h, "#b9c0d0", item.dep.label, item.dep.name + "\n" + item.dep.label, activate);
        drawFlowEdge(edgeLayer, center, depNode, "#b9c0d0", true, { rank: dep, total: depItems.length, spread: Math.min(40, depItems.length * 4), vertical: true });
      }
    }

    if (bandRows.length) {
      drawBridgeBands(bandLayout, {
        leftX: leftX,
        edgeLayer: edgeLayer,
        center: center,
        laneLabel: laneLabel,
        createNode: function (name, x, y, w, h, color, subtitle, tooltip) {
          /* The counterparts here are Lean modules drawn inside the Rust
             chart, so they carry the Lean marker that undoes the mono face. */
          return createNode(name, x, y, w, h, color, subtitle, tooltip, (function (target) {
            return function () { selectModule(target, false); };
          })(name), moduleSourceLink(name), "flow-node-bridge flow-node-lean");
        }
      });
    }

    flowSvg.flush();
    wrap.appendChild(svg);

    renderFlowNodeInteriorMenu(selected);

    if (!applyFlowScrollTarget(wrap, selected, center.x, center.y, center.w, center.h)) {
      restoreFlowScroll(wrap, previousScrollLeft, previousScrollTop);
    }
  }

  function renderDeclarationFlowchart() {
    var wrap = DOM.flowchartWrap || document.getElementById("flowchart-wrap");
    if (!wrap) return;
    var shouldPreserveScroll = !prefersCompactViewport() && !state.flowScrollTarget;
    var previousScrollLeft = shouldPreserveScroll ? flowFrameValue(wrap, "scrollLeft") : 0;
    var previousScrollTop = shouldPreserveScroll ? flowFrameValue(wrap, "scrollTop") : 0;
    wrap.innerHTML = "";
    flowClipIdCounter = 0;

    var declName = state.selectedDeclaration;
    var moduleName = state.selectedDeclarationModule;
    if (!declName || !moduleName) {
      returnToModuleContext();
      return;
    }

    /* Lanes hold { name, module } pairs: a name alone is ambiguous when two
       modules declare it, and a lane node must say, link and navigate to the
       declaration it actually is. */
    var centerRef = { name: declName, module: moduleName };
    var calls = declarationCalleeRefs(declName, moduleName);
    var calledBy = declarationCallerRefs(declName, moduleName);

    var breadcrumb = document.createElement("nav");
    breadcrumb.className = "declaration-context-breadcrumb";
    breadcrumb.setAttribute("aria-label", "Declaration breadcrumb");
    var moduleLabel = document.createElement("button");
    moduleLabel.className = "btn btn-secondary declaration-breadcrumb-module";
    moduleLabel.type = "button";
    moduleLabel.textContent = moduleName;
    moduleLabel.title = t("map.return_to_module", { module: moduleName }) || ("Return to module context for " + moduleName);
    moduleLabel.addEventListener("click", returnToModuleContext);
    breadcrumb.appendChild(moduleLabel);
    var separator = document.createElement("span");
    separator.className = "breadcrumb-separator";
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = " \u203A ";
    breadcrumb.appendChild(separator);
    var declLabel = document.createElement("span");
    declLabel.className = "breadcrumb-current";
    declLabel.textContent = declName;
    breadcrumb.appendChild(declLabel);
    wrap.appendChild(breadcrumb);

    var layout = computeFlowLayout();
    var flowWidth = layout.flowWidth;
    var framePad = layout.framePad;
    var centerWidth = layout.centerWidth;
    var sideWidth = layout.sideWidth;
    var leftX = layout.leftX;
    var centerX = layout.centerX;
    var rightX = layout.rightX;
    var laneYStart = layout.laneYStart;
    var laneGapY = layout.laneGapY;

    function declSummary(ref) {
      var mod = ref.module;
      var kind = declarationKindOf(ref.name, mod);
      var line = declarationLineOf(ref.name, mod);
      var parts = [];
      if (kind) parts.push(symbolKindLabel(kind));
      if (mod) {
        var isCrossModule = mod !== moduleName;
        parts.push((isCrossModule ? "\u2192 " : "in ") + mod);
      }
      if (line > 0) parts.push("L" + line);
      var outgoing = declarationCalls(ref.name, mod).length;
      var incoming = mod ? declarationCallerRefs(ref.name, mod).length : 0;
      if (outgoing > 0 || incoming > 0) {
        parts.push("\u2190" + incoming + " \u2192" + outgoing);
      }
      /* Show assurance context for the containing module so users can see
         whether this declaration lives in a verified/proven module. */
      if (mod && state.moduleMap[mod]) {
        var modAssurance = assuranceForModule(mod);
        if (modAssurance && modAssurance.level !== "none") {
          var aIcon = ASSURANCE_ICONS[modAssurance.level] || "";
          parts.push(aIcon + " " + modAssurance.level);
        }
      }
      return parts.join(" \u00B7 ") || "declaration";
    }

    function declMetaLink(ref) {
      if (!ref.module) return null;
      var line = declarationLineOf(ref.name, ref.module);
      if (!(line > 0)) return null;
      var href = declarationSourceHref(ref.name, ref.module);
      if (!href) return null;
      return {
        href: href,
        label: "L" + line,
        title: "Open declaration source at line " + line
      };
    }

    function declTooltip(ref, roleLabel) {
      var mod = ref.module;
      var kind = declarationKindOf(ref.name, mod);
      var line = declarationLineOf(ref.name, mod);
      var callsList = declarationCalls(ref.name, mod);
      return roleLabel + "\n" + ref.name + (kind ? "\nkind: " + kind : "") + (mod ? "\nmodule: " + mod : "") + (line > 0 ? "\nline: " + line : "") + "\ncalls: " + (callsList.length || "none");
    }

    function declNodeColor(ref) {
      var kind = declarationKindOf(ref.name, ref.module);
      if (!kind) return "#8fa3bf";
      /* Use the kind-specific color for same-module declarations but
         desaturate slightly for cross-module ones so that visual weight
         emphasizes the local module's declarations. */
      var raw = INTERIOR_KIND_COLOR_MAP[kind] || "#8fa3bf";
      if (ref.module && ref.module !== moduleName) return blendHexColor(raw, "#8fa3bf", 0.45);
      return raw;
    }

    function sortByModuleRelevance(arr, referenceModule) {
      return arr.slice().sort(function (a, b) {
        var sameA = a.module === referenceModule ? 0 : 1;
        var sameB = b.module === referenceModule ? 0 : 1;
        if (sameA !== sameB) return sameA - sameB;
        return compareText(a.name.toLowerCase(), b.name.toLowerCase());
      });
    }

    var LANE_COLLAPSE_THRESHOLD = 12;
    var LANE_VISIBLE_LIMIT = 10;

    var sortedCalls = calls.length > LANE_COLLAPSE_THRESHOLD ? sortByModuleRelevance(calls, moduleName) : calls;
    var sortedCallers = calledBy.length > LANE_COLLAPSE_THRESHOLD ? sortByModuleRelevance(calledBy, moduleName) : calledBy;

    var visibleCalls = sortedCalls;
    var collapsedCallCount = 0;
    var visibleCallers = sortedCallers;
    var collapsedCallerCount = 0;

    if (!state.declarationLanesExpanded) {
      if (sortedCalls.length > LANE_COLLAPSE_THRESHOLD) {
        visibleCalls = sortedCalls.slice(0, LANE_VISIBLE_LIMIT);
        collapsedCallCount = sortedCalls.length - LANE_VISIBLE_LIMIT;
      }
      if (sortedCallers.length > LANE_COLLAPSE_THRESHOLD) {
        visibleCallers = sortedCallers.slice(0, LANE_VISIBLE_LIMIT);
        collapsedCallerCount = sortedCallers.length - LANE_VISIBLE_LIMIT;
      }
    }

    var canCompactCalls = state.declarationLanesExpanded && sortedCalls.length > LANE_COLLAPSE_THRESHOLD;
    var canCompactCallers = state.declarationLanesExpanded && sortedCallers.length > LANE_COLLAPSE_THRESHOLD;

    /* Looked up once and used for both the measurement and the painting: a
       translated label measured at its English width wraps wrongly. */
    var expandAllHint = t("map.expand_all") || "expand to show all";
    var compactLabel = t("map.return_compact_short") || "Return to Compact";
    var hideExtraCalls = t("map.hide_extra_calls") || "hide extra calls";
    var hideExtraCallers = t("map.hide_extra_callers") || "hide extra callers";

    var callLayout = [];
    var cursorLeft = laneYStart;
    for (var ci = 0; ci < visibleCalls.length; ci++) {
      var callMetaLink = declMetaLink(visibleCalls[ci]);
      var ch = nodeContentHeight(visibleCalls[ci].name, declSummary(visibleCalls[ci]), sideWidth, true, callMetaLink ? callMetaLink.label : "", false);
      callLayout.push({ name: visibleCalls[ci].name, ref: visibleCalls[ci], y: cursorLeft, h: ch, collapsed: false, expandable: false, compactControl: false, metaLink: callMetaLink });
      cursorLeft += ch + laneGapY;
    }
    if (collapsedCallCount > 0) {
      var collapsedCallLabel = laneMoreLabel("map.lane_more", collapsedCallCount, "");
      var cch = nodeContentHeight(collapsedCallLabel, expandAllHint, sideWidth, true, "", false);
      callLayout.push({ name: collapsedCallLabel, y: cursorLeft, h: cch, collapsed: true, expandable: true });
      cursorLeft += cch + laneGapY;
    }
    if (canCompactCalls) {
      var compactCallLabel = compactLabel;
      var compactCallH = nodeContentHeight(compactCallLabel, hideExtraCalls, sideWidth, true, "", false);
      callLayout.push({ name: compactCallLabel, y: cursorLeft, h: compactCallH, compactControl: true });
      cursorLeft += compactCallH + laneGapY;
    }
    var callBottom = callLayout.length ? cursorLeft - laneGapY : laneYStart + 44;

    var callerLayout = [];
    var cursorRight = laneYStart;
    for (var bi = 0; bi < visibleCallers.length; bi++) {
      var callerMetaLink = declMetaLink(visibleCallers[bi]);
      var bh = nodeContentHeight(visibleCallers[bi].name, declSummary(visibleCallers[bi]), sideWidth, true, callerMetaLink ? callerMetaLink.label : "", false);
      callerLayout.push({ name: visibleCallers[bi].name, ref: visibleCallers[bi], y: cursorRight, h: bh, collapsed: false, expandable: false, compactControl: false, metaLink: callerMetaLink });
      cursorRight += bh + laneGapY;
    }
    if (collapsedCallerCount > 0) {
      var collapsedCallerLabel = laneMoreLabel("map.lane_more", collapsedCallerCount, "");
      var ccbh = nodeContentHeight(collapsedCallerLabel, expandAllHint, sideWidth, true, "", false);
      callerLayout.push({ name: collapsedCallerLabel, y: cursorRight, h: ccbh, collapsed: true, expandable: true });
      cursorRight += ccbh + laneGapY;
    }
    if (canCompactCallers) {
      var compactCallerLabel = compactLabel;
      var compactCallerH = nodeContentHeight(compactCallerLabel, hideExtraCallers, sideWidth, true, "", false);
      callerLayout.push({ name: compactCallerLabel, y: cursorRight, h: compactCallerH, compactControl: true });
      cursorRight += compactCallerH + laneGapY;
    }
    var callerBottom = callerLayout.length ? cursorRight - laneGapY : laneYStart + 44;

    var centerMetaLink = declMetaLink(centerRef);
    var centerHeight = nodeContentHeight(declName, declSummary(centerRef), centerWidth, false, centerMetaLink ? centerMetaLink.label : "", false) + 14;
    var declLaneContentHeight = Math.max(callBottom, callerBottom) - laneYStart;
    var idealDeclCenterY = laneYStart + Math.floor((declLaneContentHeight - centerHeight) / 2);
    var minDeclCenterY = Math.max(laneYStart + 20, Math.min(170, laneYStart + Math.floor(declLaneContentHeight * 0.25)));
    var centerY = Math.max(minDeclCenterY, idealDeclCenterY);
    var declMinFlowHeight = prefersCompactViewport() ? 420 : 620;
    var flowHeight = Math.max(declMinFlowHeight, Math.max(callBottom, callerBottom, centerY + centerHeight) + 68);

    wrap.appendChild(createFlowLegend(declarationFlowLegendItems(), "Declaration flow chart legend"));

    var flowSvg = createFlowSvg(flowWidth, flowHeight, "Declaration flow chart for " + declName + ", calls " + calls.length + " declarations, called by " + calledBy.length + " declarations");
    var svg = flowSvg.svg;
    var edgeLayer = flowSvg.edgeLayer;
    var nodeLayer = flowSvg.nodeLayer;
    var labelLayer = flowSvg.labelLayer;

    function laneLabel(text, x, y, color) {
      flowLaneLabel(labelLayer, text, x, y, color);
    }

    /* `declModule` is the module of the declaration a node stands for, or ""
       for a lane control (expand, compact) whose name is only a label. */
    function createDeclNode(name, declModule, x, y, w, h, color, subtitle, tooltip, active, onActivate, metaLink) {
      var className = "flow-node" + (active ? " active" : "");
      if (onActivate) className += " action";
      if (declModule && declModule !== moduleName) className += " cross-module";
      var interactive = Boolean(onActivate);
      var focusable = interactive || active;
      var ariaLabel = interactive ? "Select declaration " + name : name;
      return buildFlowNodeGroup(nodeLayer, className, focusable, ariaLabel, name, x, y, w, h, color, subtitle, tooltip, onActivate || null, metaLink || null);
    }

    var hasCallees = calls.length > 0;
    var hasCallers = calledBy.length > 0;

    if (hasCallees) laneLabel(t("map.lane_calls") || "Calls (outgoing)", leftX, 30, "#82f0b0");
    laneLabel(t("map.lane_selected_decl") || "Selected declaration", centerX, centerY - 12, "#7c9cff");
    if (hasCallers) laneLabel(t("map.lane_called_by") || "Called by (incoming)", rightX, 30, "#ffad42");

    if (!hasCallees && !hasCallers) {
      var emptyHint = createSvgNode("text", { x: centerX, y: centerY + centerHeight + 28, fill: "#8fa3bf", "font-size": "12", "class": "flow-lane-label" });
      var kind = declarationKindOf(declName, moduleName);
      var hintMsg = kind
        ? "This " + kind + " has no detected internal call relationships."
        : "No internal call relationships detected for this declaration.";
      emptyHint.textContent = hintMsg;
      labelLayer.appendChild(emptyHint);
      var returnHint = createSvgNode("text", { x: centerX, y: centerY + centerHeight + 46, fill: "#6e7a91", "font-size": "11", "class": "flow-lane-label" });
      returnHint.textContent = t("map.breadcrumb_to_module") || "Use the breadcrumb above to return to module context.";
      labelLayer.appendChild(returnHint);
    }

    var center = createDeclNode(declName, moduleName, centerX, centerY, centerWidth, centerHeight, "#7c9cff", declSummary(centerRef), declTooltip(centerRef, "Selected declaration"), true, null, centerMetaLink);

    function isDeclNavigable(ref) {
      if (!ref.module) return false;
      return declarationCalls(ref.name, ref.module).length > 0 || Boolean(state.declarationReverseGraph[ref.name]);
    }

    function selectRef(ref) {
      return function () { selectDeclaration(ref.name, ref.module); };
    }

    var callNodes = [];
    for (var i = 0; i < callLayout.length; i++) {
      var callItem = callLayout[i];
      if (callItem.expandable) {
        var expandCallTooltip = "Expand to show all " + (collapsedCallCount + visibleCalls.length) + " called declarations";
        callNodes.push(createDeclNode(callItem.name, "", leftX, callItem.y, sideWidth, callItem.h, "#82f0b0", expandAllHint, expandCallTooltip, false, expandDeclarationLanes, null));
      } else if (callItem.compactControl) {
        callNodes.push(createDeclNode(callItem.name, "", leftX, callItem.y, sideWidth, callItem.h, "#82f0b0", hideExtraCalls, "Return to compact view", false, compactDeclarationLanes, null));
      } else {
        var callColor = declNodeColor(callItem.ref);
        var callNavigable = isDeclNavigable(callItem.ref);
        callNodes.push(createDeclNode(callItem.name, callItem.ref.module, leftX, callItem.y, sideWidth, callItem.h, callColor, declSummary(callItem.ref), declTooltip(callItem.ref, "Called declaration"), false, callNavigable ? selectRef(callItem.ref) : null, callItem.metaLink || null));
      }
    }

    var callerNodes = [];
    for (var j = 0; j < callerLayout.length; j++) {
      var callerItem = callerLayout[j];
      if (callerItem.expandable) {
        var expandCallerTooltip = "Expand to show all " + (collapsedCallerCount + visibleCallers.length) + " caller declarations";
        callerNodes.push(createDeclNode(callerItem.name, "", rightX, callerItem.y, sideWidth, callerItem.h, "#ffad42", expandAllHint, expandCallerTooltip, false, expandDeclarationLanes, null));
      } else if (callerItem.compactControl) {
        callerNodes.push(createDeclNode(callerItem.name, "", rightX, callerItem.y, sideWidth, callerItem.h, "#ffad42", hideExtraCallers, "Return to compact view", false, compactDeclarationLanes, null));
      } else {
        var callerColor = declNodeColor(callerItem.ref);
        var callerNavigable = isDeclNavigable(callerItem.ref);
        callerNodes.push(createDeclNode(callerItem.name, callerItem.ref.module, rightX, callerItem.y, sideWidth, callerItem.h, callerColor, declSummary(callerItem.ref), declTooltip(callerItem.ref, "Caller declaration"), false, callerNavigable ? selectRef(callerItem.ref) : null, callerItem.metaLink || null));
      }
    }

    var callEdgeCount = 0;
    for (var ce = 0; ce < callLayout.length; ce++) {
      if (!callLayout[ce].compactControl) callEdgeCount++;
    }
    var callerEdgeCount = 0;
    for (var cre = 0; cre < callerLayout.length; cre++) {
      if (!callerLayout[cre].compactControl) callerEdgeCount++;
    }
    var callSpread = Math.min(64, Math.max(14, Math.round(14 + Math.sqrt(Math.max(1, callEdgeCount)) * 6)));
    var callerSpread = Math.min(64, Math.max(14, Math.round(14 + Math.sqrt(Math.max(1, callerEdgeCount)) * 6)));
    var callEdgeIndex = 0;
    for (var k = 0; k < callNodes.length; k++) {
      if (callLayout[k].compactControl) continue;
      var callDashed = Boolean(callLayout[k].collapsed || callLayout[k].expandable);
      drawFlowEdge(edgeLayer, center, callNodes[k], "#82f0b0", callDashed, { rank: callEdgeIndex, total: callEdgeCount, spread: callSpread });
      callEdgeIndex++;
    }
    var callerEdgeIndex = 0;
    for (var m = 0; m < callerNodes.length; m++) {
      if (callerLayout[m].compactControl) continue;
      var callerDashed = Boolean(callerLayout[m].collapsed || callerLayout[m].expandable);
      drawFlowEdge(edgeLayer, callerNodes[m], center, "#ffad42", callerDashed, { rank: callerEdgeIndex, total: callerEdgeCount, spread: callerSpread });
      callerEdgeIndex++;
    }

    flowSvg.flush();
    wrap.appendChild(svg);

    renderFlowNodeInteriorMenu(moduleName);

    if (!applyFlowScrollTarget(wrap, declName, center.x, center.y, center.w, center.h)) {
      restoreFlowScroll(wrap, previousScrollLeft, previousScrollTop);
    }
  }

  /* ── Lane grouping ─────────────────────────────────────────────────────── */

  function groupLaneModules(names) {
    var buckets = Object.create(null);
    var order = [];
    for (var i = 0; i < names.length; i++) {
      var key = moduleSubsystem(names[i]);
      if (!buckets[key]) {
        buckets[key] = [];
        order.push(key);
      }
      buckets[key].push(names[i]);
    }
    var groups = [];
    for (var j = 0; j < order.length; j++) {
      groups.push({ key: order[j], label: order[j], members: buckets[order[j]].slice() });
    }
    /* Largest subsystems first; the input order (by score) is kept inside each group. */
    groups.sort(function (a, b) { return b.members.length - a.members.length || compareText(a.key, b.key); });
    return groups;
  }

  function buildLaneEntries(allNames, laneKey) {
    var names = Array.isArray(allNames) ? allNames : [];
    var limit = Math.max(1, Number(state.neighborLimit) || 8);
    var total = names.length;
    if (state.flowShowAll || total <= limit) {
      var visible = state.flowShowAll ? names.slice() : names.slice(0, limit);
      var flat = [];
      for (var i = 0; i < visible.length; i++) flat.push({ type: "module", name: visible[i], nested: false });
      return { grouped: false, entries: flat, visibleModules: visible, total: total, groups: [] };
    }

    var groups = groupLaneModules(names);
    var expanded = (state.laneGroupsExpanded && state.laneGroupsExpanded[laneKey]) || Object.create(null);
    var entries = [];
    var shown = [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      if (group.members.length === 1) {
        entries.push({ type: "module", name: group.members[0], nested: false });
        shown.push(group.members[0]);
        continue;
      }
      var isOpen = Boolean(expanded[group.key]);
      entries.push({ type: "group", key: group.key, label: group.label, members: group.members, expanded: isOpen });
      if (!isOpen) continue;
      for (var m = 0; m < group.members.length; m++) {
        entries.push({ type: "module", name: group.members[m], nested: true, groupKey: group.key });
        shown.push(group.members[m]);
      }
    }
    return { grouped: true, entries: entries, visibleModules: shown, total: total, groups: groups };
  }

  function toggleLaneGroup(laneKey, groupKey) {
    return function () {
      if (!state.laneGroupsExpanded[laneKey]) state.laneGroupsExpanded[laneKey] = Object.create(null);
      var lane = state.laneGroupsExpanded[laneKey];
      if (lane[groupKey]) delete lane[groupKey];
      else lane[groupKey] = true;
      /* Keep the scroll position: the group opens in place. */
      state.flowScrollTarget = "";
      scheduleRender();
    };
  }

  function drawLaneGuide(layer, groupNode, lastMember, color) {
    var x = groupNode.x + 9;
    var top = groupNode.y + groupNode.h;
    var bottom = lastMember.y + lastMember.h / 2;
    if (bottom <= top) return;
    var path = createSvgNode("path", {
      d: "M " + x + " " + top + " L " + x + " " + bottom + " L " + lastMember.x + " " + bottom,
      "class": "flow-line lane-guide",
      stroke: color
    });
    layer.appendChild(path);
  }

  function normalizeRustInventory(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.crates)) return null;
    var crates = [];
    for (var i = 0; i < raw.crates.length; i++) {
      var crate = raw.crates[i];
      if (!crate || typeof crate !== "object" || typeof crate.name !== "string" || !crate.name.trim()) continue;
      if (!Array.isArray(crate.files)) continue;
      crates.push(crate);
    }
    if (!crates.length) return null;
    return {
      root: typeof raw.root === "string" ? raw.root : "rust",
      workspaceManifest: typeof raw.workspaceManifest === "string" ? raw.workspaceManifest : "",
      members: Array.isArray(raw.members) ? raw.members.slice() : [],
      edition: typeof raw.edition === "string" ? raw.edition : "",
      version: typeof raw.version === "string" ? raw.version : "",
      rustVersion: typeof raw.rustVersion === "string" ? raw.rustVersion : "",
      workspaceFiles: Array.isArray(raw.workspaceFiles) ? raw.workspaceFiles.slice() : [],
      crates: crates
    };
  }

  /* ------------------------------------------------------------------
     The Rust module graph

     One node per production Rust source file, addressed by the Rust module
     path the file owns: `sele4n-abi::args::cspace`. A crate's library root is
     the bare crate name; a target that is its own crate root — a binary, the
     build script — carries that target as a path segment, and the node's
     subtitle says which it is, so the address is never mistaken for a module
     of the library. Test targets are left out: production code is the map's
     subject, and the crate root's summary still names the test surface.
     ------------------------------------------------------------------ */

  var RUST_TARGET_ROLES = { lib: true, bin: true, build: true, test: true };

  /* The target a root file belongs to, as cargo names it: `src/bin/x.rs` and
     `src/bin/x/main.rs` are both the binary `x`, `src/main.rs` the package's
     default binary, `tests/x.rs` the integration test `x`. */
  function rustTargetName(crate, file) {
    /* A manifest-declared target's name is the only place a nonconventional
       path's identity is written down — `[[bin]] name = "runner", path =
       "tool/entry.rs"` builds `runner` — so the snapshot records it and it
       wins. Deriving `tool_entry` from the path addresses a target Cargo does
       not have, in the chart and in the shareable URL alike. A snapshot
       predating the field falls back to the conventional reading below. */
    var declared = urlSafeNodeSegment(file && file.targetName);
    if (declared) return declared;
    var rel = String(file && file.relativePath || "");
    var nested = rel.match(/^(?:src\/bin|tests|benches|examples)\/([^/]+)\/main\.rs$/);
    if (nested) return nested[1];
    var flat = rel.match(/^(?:src\/bin|tests|benches|examples)\/([^/]+)\.rs$/);
    if (flat) return flat[1];
    if (rel === "src/main.rs") return String(crate && crate.name || "");
    return rel.replace(/\.rs$/, "").replace(/\//g, "_");
  }

  /* The node address for a crate file. Modules take their Rust module path;
     the roles that open a crate of their own take a segment naming the role,
     which `rustNodeRoleLabel` then spells out on the node itself. */
  function rustNodeName(crate, file) {
    var crateName = String(crate && crate.name || "");
    if (!crateName) return "";
    var modulePath = String(file && file.modulePath || "");
    if (modulePath) return crateName + "::" + modulePath;
    var role = String(file && file.role || "");
    if (role === "build") return crateName + "::build";
    if (role === "bin") return crateName + "::bin::" + rustTargetName(crate, file);
    if (role === "test") return crateName + "::tests::" + rustTargetName(crate, file);
    return crateName;
  }

  function rustNodeRoleLabel(role) {
    var key = "map.rust_role_" + String(role || "module");
    var fallback = {
      lib: "crate root",
      module: "module",
      bin: "binary target",
      build: "build script",
      test: "test target"
    };
    return t(key) || fallback[role] || fallback.module;
  }

  /* The module that declares this one: `args::cspace` hangs off `args`, a
     top-level module off the target root it belongs to. A module reached from
     a binary root keeps that binary as its root rather than the library. */
  function rustParentName(crate, file, byModulePath, rootsByRole, byRelativePath) {
    var modulePath = String(file && file.modulePath || "");
    if (!modulePath) return "";
    /* Keyed by target *and* module path. Two targets in one package can carry
       the same nested path — `src/args/cspace.rs` in the library and
       `src/bin/tool/args/cspace.rs` in a binary both reach `args::cspace` —
       and a path-only index holds one `args`, so one `cspace` hung off the
       other target's parent. */
    var target = String(file && file.target || "");
    var parts = modulePath.split("::");
    parts.pop();
    if (parts.length) {
      var parentPath = parts.join("::");
      var scoped = byModulePath[target + "\u0000" + parentPath];
      if (scoped) return scoped;
    }
    /* The file's own target root, when the snapshot names it: a module of
       `src/bin/tool/main.rs` hangs off that binary, not off the library that
       happens to exist alongside it. */
    if (target && byRelativePath[target]) return byRelativePath[target];
    return rootsByRole.lib || rootsByRole.bin || rootsByRole.build || "";
  }

  function buildRustGraph(rust) {
    var inventory = rust && Array.isArray(rust.crates) ? rust : null;
    if (!inventory) return null;

    var byName = Object.create(null);
    var nodes = [];
    var crateRoots = [];
    var crateRootOf = Object.create(null);

    for (var c = 0; c < inventory.crates.length; c++) {
      var crate = inventory.crates[c];
      var files = Array.isArray(crate.files) ? crate.files : [];
      var byModulePath = Object.create(null);
      var byRelativePath = Object.create(null);
      var rootsByRole = Object.create(null);
      var crateNodes = [];

      for (var f = 0; f < files.length; f++) {
        var file = files[f];
        if (!file || typeof file.path !== "string") continue;
        /* Test code is outside the production surface the map draws. `role`
           reads the pathname, so it calls `src/tests.rs` a module; the
           file-level flag is the one that knows `#[cfg(test)] mod tests;`
           makes that file — and every module it declares in turn — test-only.
           A snapshot predating the flag is judged on role alone, as before. */
        if (file.role === "test" || file.testOnly === true) continue;
        /* So is a file no Cargo target reaches: the scanner lists it (its
           items are real text) but it compiles into nothing, and drawing it
           would present stale or generated source as part of the module
           tree. `reachable` is compilation reachability, wider than the
           `exported` flag the boundary uses. A snapshot predating it says
           nothing, and everything it lists is drawn as before. */
        if (file.reachable === false) continue;
        var name = rustNodeName(crate, file);
        if (!name) continue;
        /* Two files can only collide when a crate declares a module named
           after one of its own targets; keep both by falling back to the
           path, so no file is silently dropped. The suffix has to survive
           sanitizeModuleName() — a node the URL cannot carry is a node whose
           selection is lost on reload and cannot be shared. */
        if (byName[name]) name = name + "::" + urlSafeNodeSegment(file.relativePath);
        if (byName[name]) continue;

        var record = {
          name: name,
          crateName: String(crate.name || ""),
          crate: crate,
          file: file,
          path: String(file.path || ""),
          relativePath: String(file.relativePath || ""),
          modulePath: String(file.modulePath || ""),
          role: String(file.role || "module"),
          isRoot: !file.modulePath && Boolean(RUST_TARGET_ROLES[file.role]),
          parent: "",
          children: []
        };
        byName[name] = record;
        nodes.push(name);
        crateNodes.push(record);
        byRelativePath[record.relativePath] = name;
        if (record.modulePath) byModulePath[String(file.target || "") + "\u0000" + record.modulePath] = name;
        else if (!rootsByRole[record.role]) rootsByRole[record.role] = name;
      }

      var libRoot = rootsByRole.lib || rootsByRole.bin || rootsByRole.build || "";
      if (libRoot) {
        crateRoots.push(libRoot);
        crateRootOf[String(crate.name || "")] = libRoot;
      }
      for (var n = 0; n < crateNodes.length; n++) {
        var node = crateNodes[n];
        node.parent = rustParentName(crate, node.file, byModulePath, rootsByRole, byRelativePath);
        if (node.parent === node.name) node.parent = "";
      }
    }

    for (var k = 0; k < nodes.length; k++) {
      var child = byName[nodes[k]];
      if (child.parent && byName[child.parent]) byName[child.parent].children.push(child.name);
    }
    for (var p = 0; p < nodes.length; p++) byName[nodes[p]].children.sort();
    nodes.sort();

    return {
      nodes: nodes,
      byName: byName,
      crateRoots: crateRoots,
      crateRootOf: crateRootOf,
      inventory: inventory
    };
  }

  function isRustNode(name) {
    return Boolean(state.rustGraph && state.rustGraph.byName[name]);
  }

  function rustNode(name) {
    return (state.rustGraph && state.rustGraph.byName[name]) || null;
  }

  function rustCrateStratum(crateName) {
    return RUST_CRATE_STRATUM[String(crateName || "")] || "shared";
  }

  /* ------------------------------------------------------------------
     The Lean ↔ Rust boundary

     Two declarations are the same declaration across the boundary when their
     names agree once case convention is normalised away: `ffiGicAcknowledge`
     and `ffi_gic_acknowledge`, `ThreadId` and `ThreadId`, `MAX_LABEL` and
     `maxLabel`. What that pair *means* follows from the Lean side's kind: a
     Lean `opaque` has no Lean body, so a Rust `fn` of the same name is its
     implementation and the kernel calls down into it. Everything softer than
     that is labelled as what it is and never as a call.
     ------------------------------------------------------------------ */

  function toBridgeKey(name) {
    var raw = String(name || "").replace(/^r#/, "");
    if (!raw || raw.charAt(0) === "<") return "";
    return raw
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .toLowerCase();
  }

  /* A cheap necessary condition for two names to share a bridge key:
     toBridgeKey only lowercases and inserts underscores, so equal keys mean
     equal names once case and underscores are dropped. Lean has ~20k
     declaration names and the Rust side ~4k exported items; screening with
     this first runs the three-regex key on the few hundred Lean names that
     can match instead of on all of them. */
  function bridgeScreenKey(name) {
    var raw = String(name || "").replace(/^r#/, "");
    if (!raw || raw.charAt(0) === "<") return "";
    return raw.toLowerCase().replace(/_/g, "");
  }

  function bridgeRelation(rustKind, leanKind, crateName) {
    if (rustKind !== "fn") return "shares";
    if (BRIDGE_FOREIGN_LEAN_KINDS[leanKind]) return "implements";
    var stratum = rustCrateStratum(crateName);
    if (stratum === "userspace") return "invokes";
    if (stratum === "hardware") return "mirrors";
    return "shares";
  }

  /* Lean declarations by normalised name. A name declared several times keeps
     every declaration: the same type can be named in a structure and restated
     in an abbreviation, and both are real. `screen`, when given, is the set of
     bridgeScreenKey values that can match at all; other names are skipped
     before their key is computed. */
  function leanDeclarationsByBridgeKey(screen) {
    var index = Object.create(null);
    for (var i = 0; i < state.modules.length; i++) {
      var moduleName = state.modules[i];
      var meta = state.moduleMeta[moduleName];
      var byKind = (meta && meta.symbols && meta.symbols.byKind) || null;
      if (!byKind) continue;
      for (var kind in byKind) {
        if (!Object.prototype.hasOwnProperty.call(byKind, kind)) continue;
        if (!BRIDGE_LEAN_KINDS[kind]) continue;
        var list = byKind[kind];
        if (!Array.isArray(list)) continue;
        for (var j = 0; j < list.length; j++) {
          var entry = list[j];
          var declName = entry && typeof entry === "object" ? entry.name : entry;
          if (screen && !screen[bridgeScreenKey(declName)]) continue;
          var key = toBridgeKey(declName);
          if (!key) continue;
          if (!index[key]) index[key] = [];
          index[key].push({
            module: moduleName,
            name: String(declName),
            kind: kind,
            line: (entry && entry.line) || 0
          });
        }
      }
    }
    return index;
  }

  /* One edge per (Rust module, Lean module, relation), carrying the matched
     declarations so a node can say which ones they are. */
  function buildBridgeIndex() {
    if (!state.rustGraph || !state.modules.length) {
      state.bridge = { byRust: Object.create(null), byLean: Object.create(null), links: 0, pairs: 0 };
      return state.bridge;
    }

    var byRust = Object.create(null);
    var byLean = Object.create(null);
    var edges = Object.create(null);
    var links = 0;

    /* Whether this snapshot knows about export reachability at all. The flag
       is emitted for every item, so its total absence — and only that — means
       an older bundle whose items can be judged on syntax alone. */
    var carriesExportFlag = false;
    for (var e = 0; e < state.rustGraph.nodes.length && !carriesExportFlag; e++) {
      var probeNode = state.rustGraph.byName[state.rustGraph.nodes[e]];
      var probeItems = (probeNode.file && Array.isArray(probeNode.file.items)) ? probeNode.file.items : [];
      for (var p = 0; p < probeItems.length; p++) {
        if (probeItems[p] && typeof probeItems[p].exported === "boolean") { carriesExportFlag = true; break; }
      }
    }

    /* The Rust side first: the items that may cross the boundary, and the
       screen their names give the Lean index. */
    var candidates = [];
    var screen = Object.create(null);
    for (var i = 0; i < state.rustGraph.nodes.length; i++) {
      var nodeName = state.rustGraph.nodes[i];
      var node = state.rustGraph.byName[nodeName];
      var items = (node.file && Array.isArray(node.file.items)) ? node.file.items : [];
      for (var j = 0; j < items.length; j++) {
        var item = items[j];
        if (!item || item.test) continue;
        /* `exported`, not `visibility`: a `pub` item inside a private module is
           crate-private, and matching it published a boundary link for an
           implementation detail — `sele4n-hal`'s `error_code::VM_FAULT` and
           `USER_EXCEPTION` both name Lean definitions and both are unreachable
           from outside the crate. A snapshot predating the flag carries it on
           no item at all, and falls back to the syntactic test rather than
           emptying the boundary (see carriesExportFlag). */
        if (!(carriesExportFlag ? item.exported === true : item.visibility === "pub")) continue;
        if (!BRIDGE_RUST_KINDS[item.kind]) continue;
        var screenKey = bridgeScreenKey(item.name);
        if (!screenKey) continue;
        screen[screenKey] = true;
        candidates.push({ nodeName: nodeName, node: node, item: item });
      }
    }

    var leanIndex = leanDeclarationsByBridgeKey(screen);
    for (var c = 0; c < candidates.length; c++) {
      nodeName = candidates[c].nodeName;
      node = candidates[c].node;
      item = candidates[c].item;
      var matches = leanIndex[toBridgeKey(item.name)];
      if (!matches) continue;
      for (var m = 0; m < matches.length; m++) {
        var lean = matches[m];
        var relation = bridgeRelation(item.kind, lean.kind, node.crateName);
        var edgeKey = nodeName + "\u0000" + lean.module + "\u0000" + relation;
        var edge = edges[edgeKey];
        if (!edge) {
          edge = edges[edgeKey] = {
            rustNode: nodeName,
            leanModule: lean.module,
            relation: relation,
            links: []
          };
          if (!byRust[nodeName]) byRust[nodeName] = [];
          if (!byLean[lean.module]) byLean[lean.module] = [];
          byRust[nodeName].push(edge);
          byLean[lean.module].push(edge);
        }
        edge.links.push({
          leanName: lean.name,
          leanKind: lean.kind,
          leanLine: lean.line,
          rustName: String(item.name),
          rustKind: String(item.kind),
          rustLine: item.line || 0
        });
        links += 1;
      }
    }

    var relationRank = Object.create(null);
    for (var r = 0; r < BRIDGE_RELATIONS.length; r++) relationRank[BRIDGE_RELATIONS[r]] = r;
    function sortEdges(list, labelOf) {
      list.sort(function (a, b) {
        var byRelation = relationRank[a.relation] - relationRank[b.relation];
        if (byRelation) return byRelation;
        var byLinks = b.links.length - a.links.length;
        return byLinks || compareText(labelOf(a), labelOf(b));
      });
      for (var s = 0; s < list.length; s++) {
        list[s].links.sort(function (a, b) { return compareText(a.rustName, b.rustName); });
      }
    }
    for (var rustKey in byRust) {
      if (Object.prototype.hasOwnProperty.call(byRust, rustKey)) {
        sortEdges(byRust[rustKey], function (edge) { return edge.leanModule; });
      }
    }
    for (var leanKey in byLean) {
      if (Object.prototype.hasOwnProperty.call(byLean, leanKey)) {
        sortEdges(byLean[leanKey], function (edge) { return edge.rustNode; });
      }
    }

    var pairs = 0;
    for (var key in edges) if (Object.prototype.hasOwnProperty.call(edges, key)) pairs += 1;

    state.bridge = { byRust: byRust, byLean: byLean, links: links, pairs: pairs };
    return state.bridge;
  }

  /* The boundary edges a node carries, grouped into the three bands the chart
     draws: what Rust implements for Lean, what Rust calls into Lean, and the
     definitions the two sides share. Empty in `lean` and `rust` scope — the
     boundary is what the combined reading adds. */
  function bridgeBandsFor(name) {
    var empty = { implements: [], invokes: [], mirrors: [], shared: [], total: 0 };
    if (state.scope !== "both" || !state.bridge) return empty;
    var edges = isRustNode(name) ? state.bridge.byRust[name] : state.bridge.byLean[name];
    if (!edges || !edges.length) return empty;
    var bands = { implements: [], invokes: [], mirrors: [], shared: [], total: 0 };
    for (var i = 0; i < edges.length; i++) {
      var edge = edges[i];
      /* `mirrors` keeps its own band. Folded into `shared` it was relabelled
         as a definition the two sides hold, which is the opposite of what it
         means: a HAL routine written once in Lean and once in Rust is two
         implementations of one contract, not one definition. */
      if (edge.relation === "implements") bands.implements.push(edge);
      else if (edge.relation === "invokes") bands.invokes.push(edge);
      else if (edge.relation === "mirrors") bands.mirrors.push(edge);
      else bands.shared.push(edge);
      bands.total += 1;
    }
    return bands;
  }

  function bridgeCounterpartName(edge, fromRust) {
    return fromRust ? edge.leanModule : edge.rustNode;
  }

  /* "ffiGicAcknowledge, ffiGicEoi +6 more" — the declarations behind an edge,
     named rather than counted, because the names are the evidence. */
  function bridgeEdgeSubtitle(edge, fromRust) {
    var shown = [];
    var limit = 3;
    for (var i = 0; i < edge.links.length && i < limit; i++) {
      shown.push(fromRust ? edge.links[i].leanName : edge.links[i].rustName);
    }
    var text = shown.join(", ");
    var extra = edge.links.length - shown.length;
    if (extra > 0) text += " " + (t("map.bridge_more", { count: extra }) || ("+" + formatCount(extra) + " more"));
    return text;
  }

  function bridgeRelationLabel(relation) {
    var fallback = {
      implements: "Lean declares · Rust defines",
      invokes: "Rust wrapper · Lean operation",
      mirrors: "Lean operation · Rust routine",
      shares: "same definition on both sides"
    };
    return t("map.bridge_relation_" + relation) || fallback[relation] || relation;
  }

  function bridgeEdgeTooltip(edge, fromRust) {
    var counterpart = bridgeCounterpartName(edge, fromRust);
    var lines = [bridgeRelationLabel(edge.relation), counterpart, ""];
    for (var i = 0; i < edge.links.length && i < 12; i++) {
      var link = edge.links[i];
      lines.push(link.leanKind + " " + link.leanName + "  ↔  " + link.rustKind + " " + link.rustName);
    }
    if (edge.links.length > 12) lines.push("… +" + (edge.links.length - 12));
    return lines.join("\n");
  }

  /* The crate-level lint and the counted sites are two facts, not one. A
     `#![deny(unsafe_code)]` crate can still carry sites under an item-level
     `#[allow(unsafe_code)]` — sele4n-abi does, for its syscall trap — so every
     surface reads both from here and none can call such a crate "no unsafe". */
  function unsafeCounts(source) {
    var counts = source && typeof source === "object" ? source : {};
    var fns = Number(counts.fns) || 0;
    var impls = Number(counts.impls) || 0;
    var blocks = Number(counts.blocks) || 0;
    return { fns: fns, impls: impls, blocks: blocks, sites: fns + impls + blocks };
  }

  /* `unsafe` holds the sites in production code and `testUnsafe` the sites in
     test code (the scanner attributes each by its enclosing item), so the
     card's headline is the production figure and the test figure is named
     separately — never one total that mixes the two. */
  function rustUnsafeSummary(crate) {
    var production = unsafeCounts(crate && crate.unsafe);
    var test = unsafeCounts(crate && crate.testUnsafe);
    var deniesUnsafe = Boolean(crate && crate.deniesUnsafe);
    return {
      fns: production.fns,
      impls: production.impls,
      blocks: production.blocks,
      sites: production.sites,
      testSites: test.sites,
      deniesUnsafe: deniesUnsafe,
      exceptions: deniesUnsafe && production.sites > 0
    };
  }

  /* English fallback for a count label when no locale string resolves. */
  function pluralEn(count, one, other) {
    return formatCount(count) + " " + (count === 1 ? one : other);
  }

  /* "2 fn · 1 block · under item-level allow · +20 in test code": only the
     counters that are non-zero, each pluralised by the locale. */
  function rustUnsafeDetail(summary) {
    var parts = [];
    if (summary.fns) parts.push(t("map.rust_unsafe_fn", { count: summary.fns }) || pluralEn(summary.fns, "fn", "fn"));
    if (summary.impls) parts.push(t("map.rust_unsafe_impl", { count: summary.impls }) || pluralEn(summary.impls, "impl", "impls"));
    if (summary.blocks) parts.push(t("map.rust_unsafe_block", { count: summary.blocks }) || pluralEn(summary.blocks, "block", "blocks"));
    if (summary.exceptions) parts.push(t("map.rust_unsafe_exceptions") || "under item-level allow");
    if (summary.testSites) parts.push(t("map.rust_unsafe_test", { count: summary.testSites }) || ("+" + formatCount(summary.testSites) + " in test code"));
    return parts.join(" \u00B7 ");
  }

  /* ------------------------------------------------------------------
     Scope-aware node accessors

     A node is either a Lean module or a Rust module; these are the handful of
     questions the chart, the chooser and the sidebar ask without caring which.
     ------------------------------------------------------------------ */

  function scopeIncludesLean() { return state.scope !== "rust"; }
  function scopeIncludesRust() { return state.scope !== "lean"; }

  function nodeExists(name) {
    if (!name) return false;
    if (scopeIncludesLean() && state.moduleMap[name]) return true;
    return scopeIncludesRust() && isRustNode(name);
  }

  function nodePath(name) {
    if (state.moduleMap[name]) return state.moduleMap[name];
    var node = rustNode(name);
    return node ? node.path : "";
  }

  /* Both halves come from one snapshot, so every source link names the
     commit that snapshot was taken at; a line number on `main` would be a
     line on a moving target. */
  function nodeSourceRef() {
    return state.commitSha || REF;
  }

  function scopeNodes() {
    var out = [];
    if (scopeIncludesLean()) out = out.concat(state.modules);
    if (scopeIncludesRust() && state.rustGraph) out = out.concat(state.rustGraph.nodes);
    return out;
  }

  /* The node the workspace opens on: the kernel's syscall surface in any scope
     that carries Lean, the first crate root otherwise. */
  function defaultNodeName() {
    if (scopeIncludesLean()) {
      var leanDefault = defaultModuleName();
      if (leanDefault) return leanDefault;
    }
    if (scopeIncludesRust() && state.rustGraph) {
      if (state.rustGraph.crateRoots.length) return state.rustGraph.crateRoots[0];
      if (state.rustGraph.nodes.length) return state.rustGraph.nodes[0];
    }
    return null;
  }

  /* ------------------------------------------------------------------
     Rust declarations for the sidebar
     ------------------------------------------------------------------ */

  /* A Rust kind is a keyword, so it reads the same in every locale: the
     fallback is the keyword itself, not a title-cased word. Only the "(test)"
     qualifier around it is prose. */
  function rustKindLabel(kind) {
    var raw = String(kind || "");
    var isTest = raw.indexOf(RUST_TEST_KIND_PREFIX) === 0;
    var bare = isTest ? raw.slice(RUST_TEST_KIND_PREFIX.length) : raw;
    var base = t("map.rust_kind_" + bare) || (bare === "macro" ? "macro_rules!" : bare);
    if (!isTest) return base;
    return (t("map.rust_kind_test", { kind: base }) || (base + " (test)"));
  }

  function rustKindGroupLabel(key) {
    return t("map.kind_" + key) || RUST_KIND_GROUP_LABELS_EN[key] || key;
  }

  /* The file's items bucketed by kind, with test items under a `test:` prefix
     so the sidebar's fourth tab holds them without a second control. The
     shapes match the Lean interior so one renderer serves both.

     `listed` and `tests` count what the sidebar shows, which is not the same
     quantity as the snapshot's `productionItems`: an `impl` block is listed
     but never counted as a declaration. The node summary quotes the
     snapshot's figure and this one stays inside the sidebar, so the two can
     never be mistaken for each other. */
  function rustInteriorForNode(name) {
    var node = rustNode(name);
    var byKind = Object.create(null);
    for (var i = 0; i < ALL_RUST_KINDS.length; i++) byKind[ALL_RUST_KINDS[i]] = [];
    var empty = { byKind: byKind, theorems: [], functions: [], total: 0, listed: 0, tests: 0 };
    if (!node) return empty;
    if (node.__interiorCache && node.__interiorCacheSource === node.file) return node.__interiorCache;

    var items = Array.isArray(node.file && node.file.items) ? node.file.items : [];
    var listed = 0;
    var tests = 0;
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      if (!item || !item.name) continue;
      var kind = String(item.kind || "");
      var key = item.test ? RUST_TEST_KIND_PREFIX + kind : kind;
      if (!byKind[key]) continue;
      byKind[key].push({
        name: String(item.name),
        line: item.line || 0,
        visibility: String(item.visibility || "private"),
        kind: kind,
        test: Boolean(item.test)
      });
      if (item.test) tests += 1; else listed += 1;
    }

    var normalized = {
      byKind: byKind,
      theorems: [],
      functions: (byKind.fn || []).slice(),
      total: listed + tests,
      listed: listed,
      tests: tests
    };
    node.__interiorCacheSource = node.file;
    node.__interiorCache = normalized;
    return normalized;
  }

  /* "18 items · 4 pub · 229 lines · 2 unsafe · 10 test" — the production
     surface first, the test surface named separately, never one mixed total. */
  function rustNodeSummary(name) {
    var node = rustNode(name);
    if (!node) return "";
    var file = node.file || {};
    var parts = [];
    var production = Number(file.productionItems) || 0;
    var publicItems = Number(file.publicItems) || 0;
    var testItems = Number(file.testItems) || 0;
    parts.push(t("map.rust_items", { count: production }) || pluralEn(production, "item", "items"));
    if (publicItems) parts.push(t("map.rust_public", { count: publicItems }) || (formatCount(publicItems) + " pub"));
    parts.push(t("map.rust_lines", { count: Number(file.lines) || 0 }) || pluralEn(Number(file.lines) || 0, "line", "lines"));
    var unsafeSites = unsafeCounts(file.unsafe).sites;
    if (unsafeSites) parts.push(t("map.rust_unsafe_sites", { count: unsafeSites }) || pluralEn(unsafeSites, "unsafe site", "unsafe sites"));
    if (testItems) parts.push(t("map.rust_tests", { count: testItems }) || pluralEn(testItems, "test", "tests"));
    return parts.join(" · ");
  }

  /* A crate root also answers for its crate, so its node says so. The unsafe
     line keeps the crate lint and the counted production sites apart, and
     names the test sites separately — never one total that mixes the two. */
  function rustCrateSummary(crate) {
    var parts = [];
    var sourceFiles = Number(crate && crate.sourceFiles) || 0;
    parts.push(t("map.rust_crate_files", { count: sourceFiles }) || pluralEn(sourceFiles, "file", "files"));
    parts.push(t("map.rust_items", { count: Number(crate && crate.items) || 0 }) || pluralEn(Number(crate && crate.items) || 0, "item", "items"));
    var summary = rustUnsafeSummary(crate);
    if (summary.sites) {
      var detail = rustUnsafeDetail(summary);
      parts.push((t("map.rust_unsafe_sites", { count: summary.sites }) || pluralEn(summary.sites, "unsafe site", "unsafe sites")) + (detail ? " (" + detail + ")" : ""));
    } else if (summary.deniesUnsafe) {
      parts.push(t("map.rust_denies_unsafe") || "denies unsafe");
    } else if (summary.testSites) {
      parts.push(t("map.rust_unsafe_test", { count: summary.testSites }) || ("+" + formatCount(summary.testSites) + " in test code"));
    }
    return parts.join(" · ");
  }

  function rustNodeTooltip(name, roleLabel) {
    var node = rustNode(name);
    if (!node) return roleLabel + ": " + name;
    var file = node.file || {};
    var lines = [
      roleLabel,
      name,
      rustNodeRoleLabel(node.role) + " · " + node.crateName,
      "path: " + node.path,
      "items: " + (Number(file.productionItems) || 0) + " production, " + (Number(file.publicItems) || 0) + " public, " + (Number(file.testItems) || 0) + " test",
      "unsafe: " + unsafeCounts(file.unsafe).sites + " production site(s), " + unsafeCounts(file.testUnsafe).sites + " in test code"
    ];
    if (node.parent) lines.push("declared in: " + node.parent);
    if (node.children.length) lines.push("declares: " + node.children.length + " module(s)");
    return lines.join("\n");
  }

  /* The crate-level dependency context a Rust node sits in, as a flat list of
     labelled chips. A target-scoped table keeps its cfg and a dev-dependency
     says it is test-only, exactly as the crate cards used to state it. */
  function rustCrateDependencies(crate) {
    var out = [];
    var seen = Object.create(null);
    /* A dependency is navigable when it names a workspace member, whichever
       table it came from: the HAL reaches sele4n-types only as a
       dev-dependency, and that edge is still worth following. */
    function push(names, label) {
      var list = Array.isArray(names) ? names : [];
      for (var i = 0; i < list.length; i++) {
        var name = String(list[i]);
        var key = name + "\u0000" + label;
        if (!name || seen[key]) continue;
        seen[key] = true;
        out.push({
          name: name,
          label: label,
          navigable: Boolean(state.rustGraph && state.rustGraph.crateRootOf[name])
        });
      }
    }
    push(crate && crate.internalDependencies, t("map.rust_dep_workspace") || "workspace crate");
    push(crate && crate.externalDependencies, t("map.rust_dep_external") || "external");
    var optional = Array.isArray(crate && crate.optionalDependencies) ? crate.optionalDependencies : [];
    for (var o = 0; o < optional.length; o++) {
      var entry = optional[o];
      /* The snapshot's shape is { package, internal, features } — reading
         `name`/`enablingFeatures` pushed the entry object itself and rendered
         a dependency called "[object Object]" with no feature label. No crate
         in the tree carries an optional dependency today, which is why it went
         unseen. */
      var featureList = entry && Array.isArray(entry.features) ? entry.features.join(", ") : "";
      push([entry && entry.package].filter(Boolean),
        (t("map.rust_dep_optional") || "optional") + (featureList ? " · " + featureList : ""));
    }
    var targeted = Array.isArray(crate && crate.targetDependencies) ? crate.targetDependencies : [];
    for (var g = 0; g < targeted.length; g++) {
      var table = targeted[g];
      push(table && table.names, t("map.rust_dep_target", { cfg: String(table && table.cfg || "") })
        || ("under " + String(table && table.cfg || "")));
    }
    push(crate && crate.devDependencies, t("map.rust_dep_dev") || "test-only");
    push(crate && crate.buildDependencies, t("map.rust_dep_build") || "build-time");
    return out;
  }

  function isTypingTarget(target) {
    if (!target || !target.tagName) return false;
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) return true;
    if (target.isContentEditable) return true;
    return false;
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
      /* Preserve first occurrence: skip if this base+kind slot is already claimed */
      if (!groups[meta.base][meta.kind]) groups[meta.base][meta.kind] = name;
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
      return diff || compareText(a.base, b.base);
    });

    for (var j = 0; j < pairs.length; j++) if (pairs[j].invariantImportsOperations) totals.linked += 1;
    totals.pairs = pairs.length;

    state.theoremPairs = pairs;
    state.proofPairMap = Object.create(null);
    state.degreeMap = Object.create(null);
    ASSURANCE_CACHE = Object.create(null);
    for (var k = 0; k < pairs.length; k++) state.proofPairMap[pairs[k].base] = pairs[k];
    for (var m = 0; m < state.modules.length; m++) moduleDegree(state.modules[m]);
    updateMetric("rustCrates", state.rust && Array.isArray(state.rust.crates) ? state.rust.crates.length : "\u2013");
    updateMetric("rustModules", state.rustGraph ? state.rustGraph.nodes.length : "\u2013");
    updateMetric("bridgeLinks", state.bridge ? state.bridge.links : "\u2013");
    updateMetric("leanModules", state.modules.length);
    updateMetric("importEdges", totals.importEdges);
    updateMetric("theorems", totals.theorems);
    updateMetric("proofPairs", totals.pairs);
    updateMetric("linkedPairs", totals.linked);
    updateMetric("generatedAt", formatGeneratedAt(state.generatedAt));

    /* Pre-warm assurance cache for all visible modules so the first render
       doesn't stall on assurance computation for each node.  This moves the
       cost to data-load time where the user is already waiting. */
    for (var warmIdx = 0; warmIdx < state.modules.length; warmIdx++) {
      assuranceForModule(state.modules[warmIdx]);
    }
  }

  function renderAll() {
    var wrap = DOM.flowchartWrap || document.getElementById("flowchart-wrap");
    /* Read before the first write below, so the one layout this costs is the
       render's only forced one until a scroll target is applied. */
    flowFrame = readFlowFrame(wrap);
    try {
      renderAllInFrame(wrap);
    } finally {
      flowFrame = null;
    }
  }

  function renderAllInFrame(wrap) {
    renderScopeToggle();
    renderContextChooser();
    if (state.flowContext === "declaration" && state.selectedDeclaration) {
      if (wrap) wrap.setAttribute("aria-label", "Declaration call graph for " + state.selectedDeclaration);
      renderDeclarationFlowchart();
    } else if (isRustNode(state.selectedModule)) {
      if (wrap) wrap.setAttribute("aria-label", "Rust module, crate dependency and Lean boundary chart");
      renderRustFlowchart();
    } else {
      if (wrap) wrap.setAttribute("aria-label", "Dependency and proof flow chart");
      renderFlowchart();
    }
  }


  function setupNav() {
    var toggle = document.getElementById("nav-toggle");
    var links = document.getElementById("nav-links");
    var nav = document.getElementById("nav");

    function normalizePagePath(pathname) {
      var normalized = String(pathname || "").replace(/\/+$/, "");
      normalized = normalized.replace(/\/index\.html$/i, "");
      if (!normalized) return "/";
      return normalized;
    }

    function resolveNavTarget(href) {
      if (!href) return null;
      var parsed;
      try {
        parsed = new URL(href, window.location.href);
      } catch (e) {
        return null;
      }

      var currentPath = normalizePagePath(window.location.pathname);
      var targetPath = normalizePagePath(parsed.pathname);
      var sameOrigin = parsed.origin === window.location.origin;

      return {
        href: href,
        url: parsed.href,
        path: targetPath,
        search: parsed.search || "",
        samePath: sameOrigin && currentPath === targetPath,
        sameOrigin: sameOrigin,
        hash: parsed.hash || ""
      };
    }

    function samePageHashTarget(href) {
      var targetInfo = resolveNavTarget(href);
      if (!targetInfo || !targetInfo.sameOrigin || !targetInfo.samePath || !targetInfo.hash || targetInfo.hash.charAt(0) !== "#") return null;
      var id = targetInfo.hash.slice(1);
      if (!id) return null;
      var target = document.getElementById(id);
      return target ? { hash: targetInfo.hash, target: target } : null;
    }

    function scrollToHash(hash, behavior) {
      var targetInfo = samePageHashTarget(hash);
      if (!targetInfo || !nav) return;
      var navOffset = Math.ceil((nav.getBoundingClientRect().height || 0) + 12);
      var targetTop = targetInfo.target.getBoundingClientRect().top + window.scrollY - navOffset;
      safeScrollTo(targetTop, behavior || "smooth");
    }

    function focusHashTarget(hash) {
      var targetInfo = samePageHashTarget(hash);
      if (!targetInfo || !targetInfo.target || typeof targetInfo.target.focus !== "function") return;

      var target = targetInfo.target;
      var shouldRestoreTabIndex = false;
      if (!target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
        shouldRestoreTabIndex = true;
      }

      try {
        target.focus({ preventScroll: true });
      } catch (e) {
        target.focus();
      }

      if (shouldRestoreTabIndex) {
        target.addEventListener("blur", function cleanupTabIndex() {
          target.removeAttribute("tabindex");
          target.removeEventListener("blur", cleanupTabIndex);
        });
      }
    }

    function storeCrossPageNavIntent(targetInfo) {
      if (!targetInfo || !targetInfo.hash || !targetInfo.path) return false;
      try {
        sessionStorage.setItem(NAV_INTENT_KEY, JSON.stringify({
          path: targetInfo.path,
          hash: targetInfo.hash,
          ts: Date.now()
        }));
        return true;
      } catch (e) {
        return false;
      }
    }

    function updateCurrentNavLink() {
      if (!links) return;

      var allLinks = links.querySelectorAll("a");
      var pageLinks = [];
      for (var i = 0; i < allLinks.length; i++) {
        var href = allLinks[i].getAttribute("href") || "";
        if (!href || href.charAt(0) === "#" || /^https?:\/\//i.test(href)) continue;
        pageLinks.push(allLinks[i]);
      }

      if (!pageLinks.length) return;

      var currentPath = normalizePagePath(window.location.pathname);
      for (var j = 0; j < pageLinks.length; j++) {
        var link = pageLinks[j];
        var href = link.getAttribute("href") || "";
        var normalizedHref = href.split("#")[0].replace(/^\.\//, "");
        var linkPath = normalizePagePath(("/" + normalizedHref).replace(/\/+/g, "/"));

        if (linkPath === currentPath) link.setAttribute("aria-current", "page");
        else if (link.hasAttribute("aria-current")) link.removeAttribute("aria-current");
      }
    }

    function syncNavMetrics() {
      if (!nav) return;
      var navHeight = Math.ceil(nav.getBoundingClientRect().height || 0);
      if (navHeight > 0) {
        document.documentElement.style.setProperty("--nav-height", navHeight + "px");
        document.documentElement.style.setProperty("--nav-scroll-offset", Math.ceil(navHeight + 12) + "px");
      }
    }

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
        items[i].addEventListener("click", function (event) {
          var href = event.currentTarget.getAttribute("href") || "";
          var target = resolveNavTarget(href);
          var targetInfo = samePageHashTarget(href);

          if (targetInfo) {
            event.preventDefault();
            scrollToHash(targetInfo.hash, "smooth");
            focusHashTarget(targetInfo.hash);
            if (window.location.hash !== targetInfo.hash) { try { history.pushState(null, "", targetInfo.hash); } catch (e) {} }
          } else if (target && target.samePath && !target.hash) {
            event.preventDefault();
            safeScrollTo(0, "smooth");
            if (window.location.pathname !== target.path || window.location.search || window.location.hash) {
              try { history.replaceState(null, "", target.path); } catch (e) {}
            }
          } else if (target && target.sameOrigin && !target.samePath && target.hash) {
            event.preventDefault();
            var storedIntent = storeCrossPageNavIntent(target);
            // Prefer intent-only navigation to avoid native hash jumps competing with the
            // landing page's offset-aware scroll/focus pass. If storage is unavailable,
            // fall back to hash navigation so deep links still work.
            if (storedIntent) window.location.assign(target.path + (target.search || ""));
            else window.location.assign(target.url || (target.path + (target.search || "") + target.hash));
          }

          setNavState(false);
        });
      }

      document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        setNavState(false);
      });

      document.addEventListener("click", function (event) {
        if (!links.classList.contains("open")) return;
        var target = event.target;
        if (toggle.contains(target) || links.contains(target)) return;
        setNavState(false);
      });

      window.addEventListener("resize", function () {
        if (window.innerWidth > 768) setNavState(false);
      }, { passive: true });
    }

    syncNavMetrics();
    updateCurrentNavLink();
    window.addEventListener("resize", syncNavMetrics, { passive: true });
    window.addEventListener("orientationchange", syncNavMetrics, { passive: true });

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

  /* A declaration is identified by its module and its name together. The
     artifact records short names, so one name can be declared in several
     modules (`leaves` in BarrierComposition and in TlbCacheComposition, 171
     names in the current snapshot); the name-keyed `declarationIndex` keeps
     the first module's entry for callers that know no module, and
     `declarationsByModule` answers for a named one. Collisions inside one
     module still collapse, as the data records them (see ARCHITECTURE.md,
     "Two details the data forced"). */
  function buildDeclarationIndexes(moduleMeta, moduleNames) {
    var declarationIndex = Object.create(null);
    var declarationsByModule = Object.create(null);
    var declarationModulesByName = Object.create(null);
    for (var m = 0; m < moduleNames.length; m++) {
      var moduleName = moduleNames[m];
      var perModule = Object.create(null);
      declarationsByModule[moduleName] = perModule;
      var meta = moduleMeta[moduleName];
      var byKind = meta && meta.symbols && meta.symbols.byKind;
      if (!byKind) continue;
      for (var kind in byKind) {
        if (!Object.prototype.hasOwnProperty.call(byKind, kind)) continue;
        var items = byKind[kind];
        if (!Array.isArray(items)) continue;
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (!item || !item.name || perModule[item.name]) continue;
          var entry = { module: moduleName, kind: kind, line: item.line || 0 };
          perModule[item.name] = entry;
          if (!declarationIndex[item.name]) declarationIndex[item.name] = entry;
          if (!declarationModulesByName[item.name]) declarationModulesByName[item.name] = [];
          declarationModulesByName[item.name].push(moduleName);
        }
      }
    }
    return {
      declarationIndex: declarationIndex,
      declarationsByModule: declarationsByModule,
      declarationModulesByName: declarationModulesByName
    };
  }

  /* The forward graph stays keyed by name for name-only callers (last module
     wins, as it always has); the module-aware lookups read each module's own
     `symbols.callGraph`. The reverse graph lists every caller of a name with
     the caller's module beside it (`declarationReverseModules`, index for
     index), so the callers of one module's `leaves` can be told apart from
     the callers of another's. */
  function buildCallGraphIndexes(moduleMeta, moduleNames) {
    var graph = Object.create(null);
    var reverse = Object.create(null);
    var reverseModules = Object.create(null);
    for (var m = 0; m < moduleNames.length; m++) {
      var moduleName = moduleNames[m];
      var meta = moduleMeta[moduleName];
      var callGraph = meta && meta.symbols && meta.symbols.callGraph;
      if (!callGraph) continue;
      for (var caller in callGraph) {
        if (!Object.prototype.hasOwnProperty.call(callGraph, caller)) continue;
        var calls = callGraph[caller];
        if (!Array.isArray(calls)) continue;
        graph[caller] = { module: moduleName, calls: calls };
        for (var c = 0; c < calls.length; c++) {
          var target = calls[c];
          if (!reverse[target]) {
            reverse[target] = [];
            reverseModules[target] = [];
          }
          reverse[target].push(caller);
          reverseModules[target].push(moduleName);
        }
      }
    }
    return { declarationGraph: graph, declarationReverseGraph: reverse, declarationReverseModules: reverseModules };
  }

  function normalizeMapData(data, options) {
    if (!data || typeof data !== "object") return null;
    var opts = options && typeof options === "object" ? options : {};
    var modulesInput = Array.isArray(data.modules) ? data.modules : [];
    var requireModulesArray = opts.requireModulesArray !== false;
    if (requireModulesArray && !modulesInput.length) return null;

    function isLikelyLeanModuleName(name) {
      var candidate = sanitizeModuleName(name);
      if (!candidate) return "";
      /* Branch-ref pseudo-modules reach us as lowercase git refs in legacy
         top-level payload maps. Match them case-sensitively: capitalisation is
         exactly what separates the kernel's own `Main` entry module from the
         `main` branch it lives on, and a case-insensitive test dropped `Main`
         from the graph while the landing page still counted it. */
      if (/^(?:main|master|trunk|refs|heads)$/.test(candidate)) return "";
      /* A dotless name is a module only if it reads like one. `Main` qualifies;
         a bare ref or path fragment does not. */
      if (!/\./.test(candidate) && !/^[A-Z][A-Za-z0-9_]*$/.test(candidate)) return "";
      return candidate;
    }

    function normalizeModulePath(path, moduleName) {
      var candidate = String(path || "").trim();
      if (!candidate) return moduleName.replace(/\./g, "/") + ".lean";
      if (/^https?:\/\//i.test(candidate)) return moduleName.replace(/\./g, "/") + ".lean";
      if (!/\.lean$/i.test(candidate)) return moduleName.replace(/\./g, "/") + ".lean";
      return candidate;
    }

    function readModuleName(raw) {
      if (typeof raw === "string") return isLikelyLeanModuleName(raw);
      if (!raw || typeof raw !== "object") return "";
      return isLikelyLeanModuleName(raw.name || raw.module || raw.id || "");
    }

    function readModulePath(raw, moduleName) {
      if (raw && typeof raw === "object") {
        var candidate = String(raw.path || raw.file || raw.modulePath || "").trim();
        if (candidate) return normalizeModulePath(candidate, moduleName);
      }
      var topLevelPath = String((data.moduleMap || Object.create(null))[moduleName] || "").trim();
      if (topLevelPath) return normalizeModulePath(topLevelPath, moduleName);
      return moduleName.replace(/\./g, "/") + ".lean";
    }

    function moduleRecordsFromArray() {
      var records = [];
      var seen = Object.create(null);

      for (var idx = 0; idx < modulesInput.length; idx++) {
        var raw = modulesInput[idx];
        var name = readModuleName(raw);
        if (!name || seen[name]) continue;
        seen[name] = true;
        records.push({
          name: name,
          path: readModulePath(raw, name),
          raw: raw && typeof raw === "object" ? raw : null
        });
      }

      records.sort(function (a, b) { return compareText(a.name, b.name); });
      return records;
    }

    function dependencyNameFromRaw(raw, moduleMap, modulePathToName) {
      var depName = "";
      var depPath = "";

      if (typeof raw === "string") {
        depName = sanitizeModuleName(raw);
        if (!depName) depPath = String(raw || "").trim();
      } else if (raw && typeof raw === "object") {
        depName = sanitizeModuleName(raw.name || raw.module || raw.id || "");
        depPath = String(raw.path || raw.file || raw.modulePath || raw.source || "").trim();
      }

      if (!depName && depPath) {
        var normalizedPath = depPath.replace(/^\/+/, "");
        if (/\.lean$/i.test(normalizedPath)) {
          depName = modulePathToName[normalizedPath] || sanitizeModuleName(normalizedPath.replace(/\.lean$/i, "").replace(/\//g, "."));
        }
      }

      if (depName && !moduleMap[depName] && depPath && /\.lean$/i.test(depPath)) {
        var normalizedDepPath = depPath.replace(/^\/+/, "");
        var pathName = modulePathToName[normalizedDepPath] || sanitizeModuleName(normalizedDepPath.replace(/\.lean$/i, "").replace(/\//g, "."));
        if (pathName) depName = pathName;
      }

      return depName;
    }

    function normalizeDependencyList(list, moduleMap, modulePathToName, moduleName, allowExternal) {
      var deps = Array.isArray(list) ? list : [];
      var out = [];
      var seen = Object.create(null);

      for (var i = 0; i < deps.length; i++) {
        var depName = dependencyNameFromRaw(deps[i], moduleMap, modulePathToName);
        if (!depName || depName === moduleName || seen[depName]) continue;

        var knownModule = Boolean(moduleMap[depName]);
        if (!allowExternal && !knownModule) continue;
        if (allowExternal && knownModule) continue;

        seen[depName] = true;
        out.push(depName);
      }

      return out;
    }

    function normalizeModuleSymbols(rawSymbols) {
      var source = rawSymbols || {};
      var callGraph = Object.create(null);
      /* The bundled snapshot ships symbols already in byKind form with a
         `callGraph` beside them: without this the declarations branch below
         is skipped and the call graph is lost. */
      var priorGraph = source && source.callGraph && typeof source.callGraph === "object" && !Array.isArray(source.callGraph) ? source.callGraph : null;
      if (priorGraph) {
        for (var pg in priorGraph) {
          if (!Object.prototype.hasOwnProperty.call(priorGraph, pg)) continue;
          if (Array.isArray(priorGraph[pg]) && priorGraph[pg].length) callGraph[pg] = priorGraph[pg].slice();
        }
      }
      if (Array.isArray(source.declarations) && !source.byKind && !source.by_kind) {
        var declarationKinds = Object.create(null);
        for (var decIdx = 0; decIdx < source.declarations.length; decIdx++) {
          var declaration = source.declarations[decIdx] || {};
          var kind = normalizeDeclarationKind(declaration.kind || "");
          var name = normalizeSymbolName(declaration.name || "");
          var line = Number(declaration.line || 0);
          if (!kind || !name) continue;
          if (!declarationKinds[kind]) declarationKinds[kind] = [];
          declarationKinds[kind].push({ name: name, line: line > 0 ? line : null });
          if (Array.isArray(declaration.called) && declaration.called.length) {
            callGraph[name] = declaration.called.map(function (c) { return String(c || "").trim(); }).filter(Boolean);
          }
        }
        source = { byKind: declarationKinds };
      }

      var symbols = symbolListsFromRaw(source);
      var byKind = Object.create(null);
      var kinds = allInteriorKinds();
      for (var idx = 0; idx < kinds.length; idx++) {
        var kind = kinds[idx];
        byKind[kind] = normalizeSymbolList((symbols.byKind || {})[kind]);
      }

      var theorems = normalizeSymbolList(symbols.theorems);
      var functions = normalizeSymbolList(symbols.functions);

      return {
        byKind: byKind,
        theorems: theorems.length ? theorems : (byKind.theorem || []).concat(byKind.lemma || []),
        functions: functions.length ? functions : (byKind.def || []).concat(byKind.abbrev || [], byKind.opaque || [], byKind.instance || []),
        callGraph: callGraph
      };
    }

    var moduleRecords = moduleRecordsFromArray();
    if (!moduleRecords.length) return null;

    var normalizedModules = [];
    var normalizedModuleMap = Object.create(null);
    var modulePathToName = Object.create(null);
    for (var rec = 0; rec < moduleRecords.length; rec++) {
      var record = moduleRecords[rec];
      normalizedModules.push(record.name);
      normalizedModuleMap[record.name] = record.path;
      modulePathToName[record.path] = record.name;
    }

    var normalizedModuleMeta = (function () {
      var rawMetaByModule = data.moduleMeta && typeof data.moduleMeta === "object" ? data.moduleMeta : Object.create(null);
      var normalized = Object.create(null);
      for (var idx = 0; idx < moduleRecords.length; idx++) {
        var moduleName = moduleRecords[idx].name;
        var moduleRaw = moduleRecords[idx].raw || {};
        var moduleMeta = moduleRaw.meta && typeof moduleRaw.meta === "object" ? moduleRaw.meta : moduleRaw;
        var meta = Object.assign({}, rawMetaByModule[moduleName] || {}, moduleMeta || {});
        var normalizedSymbols = normalizeModuleSymbols(meta.symbols || { declarations: moduleRaw.declarations || [] });
        var explicitTheorems = Number(meta.theorems || meta.theoremCount || ((meta.stats && meta.stats.theorems) || 0));
        var derivedTheorems = normalizedSymbols.theorems.length || (normalizedSymbols.byKind.theorem || []).length + (normalizedSymbols.byKind.lemma || []).length;
        normalized[moduleName] = {
          layer: meta.layer || classifyLayer(moduleName),
          kind: meta.kind || moduleKind(moduleName),
          base: meta.base || moduleBase(moduleName),
          theorems: explicitTheorems > 0 ? explicitTheorems : derivedTheorems,
          symbols: normalizedSymbols,
          symbolsLoaded: hasCompleteSymbolLines(normalizedSymbols)
        };
      }
      return normalized;
    })();

    var topLevelImports = data.importsFrom && typeof data.importsFrom === "object" ? data.importsFrom : Object.create(null);
    var normalizedImportsFrom = Object.create(null);
    for (var importIdx = 0; importIdx < moduleRecords.length; importIdx++) {
      var importModuleName = moduleRecords[importIdx].name;
      var importModuleRaw = moduleRecords[importIdx].raw || {};
      var importCandidates = importModuleRaw.imports || importModuleRaw.importsFrom || importModuleRaw.dependencies;
      var importList = Array.isArray(importCandidates) ? importCandidates : topLevelImports[importModuleName];
      normalizedImportsFrom[importModuleName] = normalizeDependencyList(importList, normalizedModuleMap, modulePathToName, importModuleName, false);
    }

    var normalizedExternalImportsFrom = (function () {
      var out = Object.create(null);
      var source = data.externalImportsFrom && typeof data.externalImportsFrom === "object" ? data.externalImportsFrom : Object.create(null);

      for (var idx = 0; idx < moduleRecords.length; idx++) {
        var moduleName = moduleRecords[idx].name;
        var moduleRaw = moduleRecords[idx].raw || {};
        var extCandidates = moduleRaw.externalImports || moduleRaw.externalImportsFrom || moduleRaw.externalDependencies;
        var extList = Array.isArray(extCandidates) ? extCandidates : source[moduleName];
        out[moduleName] = normalizeDependencyList(extList, normalizedModuleMap, modulePathToName, moduleName, true);
      }
      return out;
    })();

    var declarationIndexes = buildDeclarationIndexes(normalizedModuleMeta, normalizedModules);
    var callGraphIndexes = buildCallGraphIndexes(normalizedModuleMeta, normalizedModules);

    return {
      modules: normalizedModules,
      moduleMap: normalizedModuleMap,
      moduleMeta: normalizedModuleMeta,
      importsTo: Object.create(null),
      importsFrom: normalizedImportsFrom,
      externalImportsFrom: normalizedExternalImportsFrom,
      declarationGraph: callGraphIndexes.declarationGraph,
      declarationReverseGraph: callGraphIndexes.declarationReverseGraph,
      declarationReverseModules: callGraphIndexes.declarationReverseModules,
      declarationIndex: declarationIndexes.declarationIndex,
      declarationsByModule: declarationIndexes.declarationsByModule,
      declarationModulesByName: declarationIndexes.declarationModulesByName,
      rust: normalizeRustInventory(data.rust),
      commitSha: data.commitSha ? String(data.commitSha) : "",
      generatedAt: data.generatedAt ? String(data.generatedAt) : ""
    };
  }

  /* The bundled snapshot is the page's only data source. A failure rejects
     with the reason, so boot can say the map did not load rather than paint
     an empty workspace. */
  /* Resolves with `value` from a fresh task, so the work on either side of it
     is two tasks rather than one long one. */
  function yieldToBrowser(value) {
    return new Promise(function (resolve) {
      window.setTimeout(function () { resolve(value); }, 0);
    });
  }

  function fetchBundledMapData() {
    return safeFetch(DATA_ENDPOINT, false).then(function (payload) {
      var normalized = normalizeMapData(payload);
      if (!normalized) throw new Error("snapshot has no modules");
      return normalized;
    });
  }

  function applyData(data) {
    state.rust = data.rust || null;
    state.modules = data.modules || [];
    state.moduleMap = data.moduleMap || Object.create(null);
    state.moduleMeta = data.moduleMeta || Object.create(null);
    state.importsTo = data.importsTo || Object.create(null);
    state.importsFrom = data.importsFrom || Object.create(null);
    state.externalImportsFrom = data.externalImportsFrom || Object.create(null);
    state.declarationGraph = data.declarationGraph || Object.create(null);
    state.declarationReverseGraph = data.declarationReverseGraph || Object.create(null);
    state.declarationReverseModules = data.declarationReverseModules || Object.create(null);
    state.declarationIndex = data.declarationIndex || Object.create(null);
    state.declarationsByModule = data.declarationsByModule || Object.create(null);
    state.declarationModulesByName = data.declarationModulesByName || Object.create(null);
    invalidateDerivedCaches();
    state.contextList = [];
    state.commitSha = data.commitSha || "";
    state.generatedAt = data.generatedAt || "";
    LABEL_WRAP_CACHE.clear();
    rebuildImportsToIndex();
    /* Order matters: the Rust graph feeds the search index, and the boundary
       is matched against both halves once they exist. */
    state.rustGraph = buildRustGraph(state.rust);
    buildSearchIndex();
    buildBridgeIndex();

    buildPairs();
    if (!nodeExists(state.selectedModule)) state.selectedModule = defaultNodeName();
    if (state.flowContext === "declaration" && state.selectedDeclaration) {
      /* A declaration resolves to a Lean module, so it can only be restored in
         a scope that carries Lean — `nodeExists`, not `moduleMap`. A URL
         pairing `scope=rust` with a Lean `decl=` otherwise pulled the Lean
         module into the selection while the toggle and badge still read Rust. */
      /* The URL's `module=` names which declaration of the name it means;
         only when that module does not declare it does the name decide. */
      var resolvedModule = declarationModuleOf(state.selectedDeclaration, state.selectedDeclarationModule);
      if (resolvedModule && nodeExists(resolvedModule)) {
        state.selectedDeclarationModule = resolvedModule;
        if (state.selectedModule !== resolvedModule) {
          state.selectedModule = resolvedModule;
          state.interiorMenuModule = resolvedModule;
        }
      } else if (!state.selectedDeclarationModule || !nodeExists(state.selectedDeclarationModule)) {
        state.flowContext = "module";
        state.selectedDeclaration = "";
        state.selectedDeclarationModule = "";
      }
    }
    renderAll();
  }

  function detailLevelFromState() {
    var levels = Object.keys(DETAIL_PRESETS);
    for (var i = 0; i < levels.length; i++) {
      var name = levels[i];
      var preset = DETAIL_PRESETS[name];
      if (state.neighborLimit === preset.neighborLimit && state.impactRadius === preset.impactRadius) return name;
    }
    return "compact";
  }

  function applyDetailLevel(level) {
    var key = Object.prototype.hasOwnProperty.call(DETAIL_PRESETS, level) ? level : "compact";
    var preset = DETAIL_PRESETS[key];
    state.neighborLimit = preset.neighborLimit;
    state.impactRadius = preset.impactRadius;
  }


  function setExpandedFlowMode() {
    applyDetailLevel("expanded");
    state.flowShowAll = true;
    syncUrlState();
    scheduleRender();
  }

  function setCompactFlowMode() {
    applyDetailLevel("compact");
    state.flowShowAll = false;
    syncUrlState();
    scheduleRender();
  }

  function updateDetailPillState(level) {
    var pills = document.querySelectorAll(".detail-pill[data-detail]");
    for (var i = 0; i < pills.length; i++) {
      var pill = pills[i];
      var active = pill.getAttribute("data-detail") === level;
      pill.classList.toggle("is-active", active);
      pill.setAttribute("aria-checked", active ? "true" : "false");
      pill.tabIndex = active ? 0 : -1;
    }
  }

  /* A declaration lives in a Lean module, so a scope that shows no Lean has
     none to find. Filtering here rather than at the point of selection is what
     keeps the search control honest: the earlier guard refused the selection
     but every caller still overwrote the input, closed the suggestions and
     announced "Declaration: …", so the control claimed to be showing Lean
     content while the Rust chart stayed put. */
  function declarationSearchAvailable() {
    return scopeIncludesLean();
  }

  function declarationSearchMatch(query) {
    if (!declarationSearchAvailable()) return null;
    var value = (query || "").trim();
    if (!value || value.indexOf(".") === -1) return null;

    var parts = value.split(".");

    // Strategy 1: Try progressively shorter dot-separated prefixes as exact module candidates.
    // E.g. "SeLe4n.Kernel.API.apiInvariantBundle" splits to find module "SeLe4n.Kernel.API"
    // with declaration suffix "apiInvariantBundle".
    for (var splitAt = parts.length - 1; splitAt >= 1; splitAt--) {
      var moduleCandidate = parts.slice(0, splitAt).join(".");
      if (!state.moduleMap[moduleCandidate]) continue;

      var declSuffix = parts.slice(splitAt).join(".").toLowerCase();
      if (!declSuffix) continue;

      var result = searchDeclarationsInModule(moduleCandidate, declSuffix);
      if (result) return result;
    }

    // Strategy 2: Search all declarations across all modules using the pre-built index.
    // This handles cases where the query is a qualified name but the module prefix is partial,
    // or when the query matches a declaration's qualified name (module.declaration).
    var queryLower = value.toLowerCase();
    var declList = state.declarationSearchList || [];
    var bestGlobal = null;
    var bestGlobalScore = -1;

    for (var gi = 0; gi < declList.length; gi++) {
      var entry = declList[gi];
      var score = -1;

      // Exact qualified match: "SeLe4n.Kernel.API.apiInvariantBundle"
      if (entry.qualifiedLower === queryLower) {
        return { module: entry.module, declaration: entry.name, exact: true };
      }
      // Qualified name starts with query
      if (entry.qualifiedLower.indexOf(queryLower) === 0) {
        score = 1800 - entry.qualifiedLower.length;
      }
      // Query starts with qualified name (query is more specific, shouldn't match)
      // Qualified name contains query as substring
      else if (entry.qualifiedLower.indexOf(queryLower) !== -1) {
        score = 1200 - entry.qualifiedLower.indexOf(queryLower);
      }
      // Declaration name alone matches the last dot-segment of the query
      else {
        var lastDot = queryLower.lastIndexOf(".");
        var querySuffix = lastDot >= 0 ? queryLower.slice(lastDot + 1) : "";
        if (querySuffix && entry.nameLower === querySuffix) {
          score = 1600;
        } else if (querySuffix && entry.nameLower.indexOf(querySuffix) === 0) {
          score = 1400 - entry.nameLower.length;
        } else if (querySuffix && entry.nameLower.indexOf(querySuffix) !== -1) {
          score = 1000 - entry.nameLower.indexOf(querySuffix);
        }
      }

      if (score > bestGlobalScore) {
        bestGlobalScore = score;
        bestGlobal = { module: entry.module, declaration: entry.name, exact: false };
      }
    }

    return bestGlobal;
  }

  function searchDeclarationsInModule(moduleName, declSuffixLower) {
    // Search interior declarations (from moduleMeta symbols)
    var interior = interiorCodeForModule(moduleName);
    var bestMatch = null;
    /* Track match quality (1 = prefix, 2 = substring) so a later prefix match
       upgrades an earlier substring match — keeping resolution consistent with
       the dropdown ranking in declarationSearchMatches. */
    var bestClass = 3;

    if (interior && interior.byKind) {
      var kinds = allInteriorKinds();
      for (var k = 0; k < kinds.length; k++) {
        var items = interior.byKind[kinds[k]];
        if (!Array.isArray(items)) continue;
        for (var j = 0; j < items.length; j++) {
          if (!items[j] || !items[j].name) continue;
          var itemLower = items[j].name.toLowerCase();
          if (itemLower === declSuffixLower) {
            return { module: moduleName, declaration: items[j].name, exact: true };
          } else if (itemLower.indexOf(declSuffixLower) === 0) {
            if (bestClass > 1) {
              bestClass = 1;
              bestMatch = { module: moduleName, declaration: items[j].name, exact: false };
            }
          } else if (itemLower.indexOf(declSuffixLower) !== -1) {
            if (bestClass > 2) {
              bestClass = 2;
              bestMatch = { module: moduleName, declaration: items[j].name, exact: false };
            }
          }
        }
      }
    }

    // Also check declarationIndex for declarations that may not appear in interior
    var declList = declarationSearchEntriesIn(moduleName);
    for (var di = 0; di < declList.length; di++) {
      var entry = declList[di];
      if (entry.nameLower === declSuffixLower) {
        return { module: moduleName, declaration: entry.name, exact: true };
      } else if (entry.nameLower.indexOf(declSuffixLower) === 0) {
        if (bestClass > 1) {
          bestClass = 1;
          bestMatch = { module: moduleName, declaration: entry.name, exact: false };
        }
      }
    }

    return bestMatch;
  }

  function declarationSearchMatches(query, limit) {
    if (!declarationSearchAvailable()) return [];
    var value = (query || "").trim();
    if (!value || value.indexOf(".") === -1) return [];
    var queryLower = value.toLowerCase();
    var parts = value.split(".");
    var maxResults = Math.max(1, limit || 5);

    var scored = [];

    // Strategy 1: Check exact module prefix splits
    for (var splitAt = parts.length - 1; splitAt >= 1; splitAt--) {
      var moduleCandidate = parts.slice(0, splitAt).join(".");
      if (!state.moduleMap[moduleCandidate]) continue;

      var declSuffix = parts.slice(splitAt).join(".").toLowerCase();
      if (!declSuffix) continue;

      var interior = interiorCodeForModule(moduleCandidate);
      if (!interior || !interior.byKind) continue;

      var kinds = allInteriorKinds();
      for (var k = 0; k < kinds.length; k++) {
        var items = interior.byKind[kinds[k]];
        if (!Array.isArray(items)) continue;
        for (var j = 0; j < items.length; j++) {
          if (!items[j] || !items[j].name) continue;
          var itemLower = items[j].name.toLowerCase();
          var score = -1;
          if (itemLower === declSuffix) score = 2000;
          else if (itemLower.indexOf(declSuffix) === 0) score = 1600 - itemLower.length;
          else if (itemLower.indexOf(declSuffix) !== -1) score = 1200 - itemLower.indexOf(declSuffix);
          if (score >= 0) {
            scored.push({ module: moduleCandidate, declaration: items[j].name, exact: score >= 2000, score: score });
          }
        }
      }
      // If we found results in an exact module, prefer them
      if (scored.length) break;
    }

    // Strategy 2: Search across all declarations via the pre-built index
    if (!scored.length) {
      var declList = state.declarationSearchList || [];
      for (var gi = 0; gi < declList.length; gi++) {
        var entry = declList[gi];
        var score2 = -1;
        if (entry.qualifiedLower === queryLower) score2 = 2000;
        else if (entry.qualifiedLower.indexOf(queryLower) === 0) score2 = 1800 - entry.qualifiedLower.length;
        else if (entry.qualifiedLower.indexOf(queryLower) !== -1) score2 = 1200 - entry.qualifiedLower.indexOf(queryLower);
        else {
          var lastDot = queryLower.lastIndexOf(".");
          var querySuffix = lastDot >= 0 ? queryLower.slice(lastDot + 1) : "";
          if (querySuffix && entry.nameLower === querySuffix) score2 = 1600;
          else if (querySuffix && entry.nameLower.indexOf(querySuffix) === 0) score2 = 1400 - entry.nameLower.length;
          else if (querySuffix && entry.nameLower.indexOf(querySuffix) !== -1) score2 = 1000 - entry.nameLower.indexOf(querySuffix);
        }
        if (score2 >= 0) {
          scored.push({ module: entry.module, declaration: entry.name, exact: score2 >= 2000, score: score2 });
        }
      }
    }

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return compareText(a.declaration, b.declaration);
    });

    // Deduplicate by module+declaration
    var seen = Object.create(null);
    var out = [];
    for (var ri = 0; ri < scored.length && out.length < maxResults; ri++) {
      var key = scored[ri].module + "\0" + scored[ri].declaration;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(scored[ri]);
    }
    return out;
  }

  function moduleSearchMatches(query, list) {
    var value = (query || "").trim();
    if (!value) return list.slice(0, 10);

    var lower = value.toLowerCase();
    var normalized = normalizeSearchValue(value);
    var queryTokens = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
    var scored = [];

    for (var i = 0; i < list.length; i++) {
      var name = list[i];
      var idx = state.searchIndex[name] || {
        nameLower: name.toLowerCase(),
        pathLower: (state.moduleMap[name] || "").toLowerCase(),
        nameTokens: [],
        pathTokens: []
      };

      var score = -1;
      if (idx.nameLower === lower || idx.pathLower === lower) {
        score = 2000;
      } else if (idx.nameLower.indexOf(lower) === 0) {
        score = 1600 - idx.nameLower.length;
      } else if (idx.pathLower.indexOf(lower) === 0) {
        score = 1500 - idx.pathLower.length;
      } else if (idx.nameLower.indexOf(lower) !== -1) {
        score = 1200 - idx.nameLower.indexOf(lower);
      } else if (idx.pathLower.indexOf(lower) !== -1) {
        score = 1100 - idx.pathLower.indexOf(lower);
      }

      if (score < 0 && queryTokens.length) {
        var tokenHits = 0;
        var nameJoined = idx.nameTokens.join(" ");
        var pathJoined = idx.pathTokens.join(" ");
        for (var q = 0; q < queryTokens.length; q++) {
          var token = queryTokens[q];
          if (nameJoined.indexOf(token) !== -1 || pathJoined.indexOf(token) !== -1) tokenHits += 1;
        }
        if (tokenHits) score = 700 + tokenHits * 45;
      }

      if (score >= 0) {
        score += Math.max(0, 25 - Math.floor(moduleDegree(name).score / 10));
        scored.push({ name: name, score: score });
      }
    }

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return compareText(a.name, b.name);
    });

    var out = [];
    for (var j = 0; j < scored.length && j < 10; j++) out.push(scored[j].name);
    return out;
  }

  function closeModuleSearchOptions() {
    var search = DOM.moduleSearch || document.getElementById("module-search");
    var options = DOM.moduleSearchOptions || document.getElementById("module-search-options");
    if (!options) return;
    options.hidden = true;
    options.innerHTML = "";
    state.searchVisibleOptions = [];
    state.searchActiveOption = -1;
    state.searchDeclSuggestions = [];
    if (search) {
      search.setAttribute("aria-expanded", "false");
      search.removeAttribute("aria-activedescendant");
    }
  }

  function openModuleSearchOptions(matches) {
    var search = DOM.moduleSearch || document.getElementById("module-search");
    var options = DOM.moduleSearchOptions || document.getElementById("module-search-options");
    if (!search || !options || !matches || !matches.length) {
      closeModuleSearchOptions();
      return;
    }

    options.innerHTML = "";
    var declSuggestionMap = Object.create(null);
    for (var ds = 0; ds < (state.searchDeclSuggestions || []).length; ds++) {
      declSuggestionMap[state.searchDeclSuggestions[ds].hint] = state.searchDeclSuggestions[ds];
    }
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < matches.length; i++) {
      var name = matches[i];
      var item = document.createElement("li");
      item.id = "module-search-option-" + i;
      item.className = "module-search-option";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", i === 0 ? "true" : "false");
      var declSuggestion = declSuggestionMap[name];
      if (declSuggestion) {
        item.setAttribute("data-module", declSuggestion.module);
        item.setAttribute("data-declaration", declSuggestion.declaration);
        item.textContent = t("map.decl_in_module", { declaration: declSuggestion.declaration, module: declSuggestion.module }) || (declSuggestion.declaration + " \u2014 declaration in " + declSuggestion.module);
        item.className += " module-search-option-decl";
      } else {
        item.setAttribute("data-module", name);
        var desc = state.moduleMap[name] || "";
        item.textContent = (desc && t("map.module_desc", { name: name, description: desc })) || (name + (desc ? " \u2014 " + desc : ""));
      }
      fragment.appendChild(item);
    }
    options.appendChild(fragment);

    options.hidden = false;
    state.searchVisibleOptions = matches.slice();
    state.searchActiveOption = 0;
    search.setAttribute("aria-expanded", "true");
    search.setAttribute("aria-activedescendant", "module-search-option-0");
  }

  function setActiveModuleSearchOption(index) {
    var search = DOM.moduleSearch || document.getElementById("module-search");
    var options = DOM.moduleSearchOptions || document.getElementById("module-search-options");
    if (!search || !options) return;
    var len = state.searchVisibleOptions.length;
    if (!len) return;
    var next = index;
    if (next < 0) next = len - 1;
    if (next >= len) next = 0;
    state.searchActiveOption = next;

    for (var i = 0; i < len; i++) {
      var el = document.getElementById("module-search-option-" + i);
      if (!el) continue;
      var active = i === next;
      el.setAttribute("aria-selected", active ? "true" : "false");
      if (active && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    }

    search.setAttribute("aria-activedescendant", "module-search-option-" + next);
  }

  function setupFilters() {
    var toolbar = document.getElementById("map-toolbar");
    var search = DOM.moduleSearch || document.getElementById("module-search");
    var options = DOM.moduleSearchOptions || document.getElementById("module-search-options");
    var selectedDetail = "compact";
    var reset = document.getElementById("reset-view");

    if (toolbar) {
      toolbar.addEventListener("submit", function (event) {
        event.preventDefault();
      });
    }

    function apply() {
      state.activeLayerFilter = "all";
      applyDetailLevel(selectedDetail);
      updateDetailPillState(selectedDetail);
      state.flowShowAll = false;
      state.proofLinkedOnly = false;
      invalidateDerivedCaches();
      syncUrlState();
      scheduleRender();
    }

    if (search) {
      function listHasModule(list, name) {
        if (!name) return false;
        for (var i = 0; i < list.length; i++) {
          if (list[i] === name) return true;
        }
        return false;
      }

      function matchModule(query, list) {
        var value = (query || "").trim();
        if (!value) return "";

        /* `nodeExists`, not `moduleMap`: the third site of the same mistake.
           In `scope=rust` an exactly-typed Lean module was accepted here, the
           caller closed the suggestions and left the field showing it, and
           only `selectModule` refused — so the control disagreed with the
           chart. The scope-aware predicate belongs at every acceptance point. */
        var direct = sanitizeModuleName(value);
        if (direct && nodeExists(direct)) return direct;

        var matches = moduleSearchMatches(value, list);
        return matches.length ? matches[0] : "";
      }

      function tryDeclarationSearch(value) {
        var declMatch = declarationSearchMatch(value);
        if (!declMatch) return false;
        search.value = declMatch.module + "." + declMatch.declaration;
        selectDeclaration(declMatch.declaration, declMatch.module);
        closeModuleSearchOptions();
        setSearchFeedback("Declaration: " + declMatch.declaration + " in " + declMatch.module, false);
        return true;
      }

      var choose = function () {
        setSearchFeedback("", false);
        if (typeof search.setCustomValidity === "function") search.setCustomValidity("");

        /* Resolve exact declaration matches before the fuzzy module match:
           every module shares the "sele4n" token, so qualified declaration
           queries would otherwise always fuzzy-match a module and kick the
           user out of declaration context on Enter/blur. */
        var trimmedValue = (search.value || "").trim();
        if (trimmedValue.indexOf(".") !== -1) {
          var exactDecl = declarationSearchMatch(trimmedValue);
          if (exactDecl && exactDecl.exact) {
            search.value = exactDecl.module + "." + exactDecl.declaration;
            selectDeclaration(exactDecl.declaration, exactDecl.module);
            closeModuleSearchOptions();
            setSearchFeedback("Declaration: " + exactDecl.declaration + " in " + exactDecl.module, false);
            return;
          }
        }

        var list = contextList();
        var match = matchModule(search.value, list);
        if (match) {
          if (search.value !== match) search.value = match;
          selectModule(match, false);
          closeModuleSearchOptions();
          return;
        }

        // Try dot-append declaration search (e.g. SeLe4n.Kernel.API.apiInvariantBundle)
        if (tryDeclarationSearch(search.value)) return;

        if ((search.value || "").trim()) {
          var message = "No module or declaration match in current filter scope. Try broader terms or reset filters.";
          setSearchFeedback(message, true);
          if (typeof search.setCustomValidity === "function") search.setCustomValidity(message);
          if (typeof search.reportValidity === "function") search.reportValidity();
        }
      };

      function chooseExactFromCurrentValue() {
        var direct = sanitizeModuleName(search.value);
        if (!direct) return false;
        var list = contextList();
        if (!listHasModule(list, direct)) {
          // Try declaration search for dot-appended queries
          var declMatch = declarationSearchMatch(search.value);
          if (declMatch && declMatch.exact) {
            search.value = declMatch.module + "." + declMatch.declaration;
            selectDeclaration(declMatch.declaration, declMatch.module);
            closeModuleSearchOptions();
            setSearchFeedback("Declaration: " + declMatch.declaration + " in " + declMatch.module, false);
            return true;
          }
          return false;
        }
        if (search.value !== direct) search.value = direct;
        selectModule(direct, false);
        closeModuleSearchOptions();
        return true;
      }

      function refreshSuggestions() {
        var list = contextList();
        var matches = moduleSearchMatches(search.value, list);
        // Also check for declaration-scoped suggestions via dot-append search
        var queryValue = (search.value || "").trim();
        var declSuggestions = [];
        if (queryValue.indexOf(".") !== -1) {
          var declResults = declarationSearchMatches(queryValue, 5);
          for (var ds = 0; ds < declResults.length; ds++) {
            var dr = declResults[ds];
            var declHint = dr.module + "." + dr.declaration;
            if (matches.indexOf(declHint) === -1) {
              matches.push(declHint);
              declSuggestions.push({ hint: declHint, module: dr.module, declaration: dr.declaration });
            }
          }
          // Move declaration suggestions to the front if module search found nothing
          if (declSuggestions.length && matches.length === declSuggestions.length) {
            // All matches are declaration suggestions — they're already in order
          } else if (declSuggestions.length) {
            // Interleave: put top declaration suggestion first, then modules, then rest
            var declHints = [];
            for (var dh = 0; dh < declSuggestions.length; dh++) declHints.push(declSuggestions[dh].hint);
            var moduleOnly = [];
            for (var mo = 0; mo < matches.length; mo++) {
              if (declHints.indexOf(matches[mo]) === -1) moduleOnly.push(matches[mo]);
            }
            matches = declHints.concat(moduleOnly);
          }
        }
        /* An exactly typed module leads, so Enter on the default highlight
           takes what was typed rather than a declaration suggestion. */
        var typedModule = sanitizeModuleName(search.value);
        if (typedModule && listHasModule(list, typedModule)) {
          var typedAt = matches.indexOf(typedModule);
          if (typedAt > 0) matches.splice(typedAt, 1);
          if (typedAt !== 0) matches.unshift(typedModule);
        }
        state.searchDeclSuggestions = declSuggestions;
        if (matches.length) openModuleSearchOptions(matches);
        else closeModuleSearchOptions();
      }

      /* Typing only refreshes the suggestions. It used to select and render
         every prefix that happened to name a module (`SeLe4n.Kernel` on the
         way to `SeLe4n.Kernel.API`), a full chart render per keystroke; the
         selection is taken on change, Enter, blur or a picked suggestion. */
      var searchDebounceTimer = null;
      search.addEventListener("input", function () {
        setSearchFeedback("", false);
        if (typeof search.setCustomValidity === "function") search.setCustomValidity("");
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(function () {
          searchDebounceTimer = null;
          refreshSuggestions();
        }, 90);
      });
      search.addEventListener("focus", refreshSuggestions);
      search.addEventListener("change", choose);
      search.addEventListener("blur", function () {
        window.setTimeout(function () {
          chooseExactFromCurrentValue();
          closeModuleSearchOptions();
        }, 80);
      });
      search.addEventListener("search", choose);
      search.addEventListener("keydown", function (event) {
        if (event.isComposing) return;
        if (event.key === "Escape") {
          if (state.selectedModule) search.value = state.selectedModule;
          setSearchFeedback("", false);
          if (typeof search.setCustomValidity === "function") search.setCustomValidity("");
          closeModuleSearchOptions();
          event.preventDefault();
          return;
        }
        if (event.key === "ArrowDown") {
          setActiveModuleSearchOption(state.searchActiveOption + 1);
          event.preventDefault();
          return;
        }
        if (event.key === "ArrowUp") {
          setActiveModuleSearchOption(state.searchActiveOption - 1);
          event.preventDefault();
          return;
        }
        if (event.key !== "Enter") return;
        /* Suggestions still pending describe an earlier prefix: resolve what
           is in the field now instead of a stale highlight. */
        if (searchDebounceTimer) {
          clearTimeout(searchDebounceTimer);
          searchDebounceTimer = null;
          closeModuleSearchOptions();
        }
        if (state.searchVisibleOptions.length && state.searchActiveOption >= 0) {
          var selected = state.searchVisibleOptions[state.searchActiveOption];
          if (selected) {
            search.value = selected;
            // Check if the selected option is a declaration suggestion
            var optionEl = document.getElementById("module-search-option-" + state.searchActiveOption);
            var optionDecl = optionEl ? optionEl.getAttribute("data-declaration") : "";
            var optionMod = optionEl ? optionEl.getAttribute("data-module") : "";
            if (optionDecl && optionMod) {
              search.value = optionMod + "." + optionDecl;
              selectDeclaration(optionDecl, optionMod);
              closeModuleSearchOptions();
              setSearchFeedback("Declaration: " + optionDecl + " in " + optionMod, false);
            } else {
              chooseExactFromCurrentValue();
              closeModuleSearchOptions();
            }
            event.preventDefault();
            return;
          }
        }
        choose();
        event.preventDefault();
      });

      if (options) {
        options.addEventListener("mousedown", function (event) {
          var node = event.target && event.target.closest ? event.target.closest(".module-search-option") : null;
          if (!node) return;
          var declName = node.getAttribute("data-declaration") || "";
          var moduleName = node.getAttribute("data-module") || "";
          if (!moduleName) return;
          if (declName) {
            search.value = moduleName + "." + declName;
            selectDeclaration(declName, moduleName);
            closeModuleSearchOptions();
            setSearchFeedback("Declaration: " + declName + " in " + moduleName, false);
          } else {
            search.value = moduleName;
            chooseExactFromCurrentValue();
            closeModuleSearchOptions();
          }
          event.preventDefault();
        });
      }
    }
    if (reset) {
      reset.addEventListener("click", function () {
        /* Restore the page to its original first-visit state */

        /* Return to module context if currently viewing a declaration */
        if (state.flowContext === "declaration") {
          returnToModuleContext();
        }

        /* Reset to the same module a first visit opens on */
        var firstModule = defaultNodeName();
        state.selectedModule = firstModule;
        state.laneGroupsExpanded = { imports: Object.create(null), importers: Object.create(null) };

        /* Clear interior menu state */
        state.interiorMenuModule = "";
        state.interiorMenuQuery = "";
        state.interiorMenuSelections = Object.create(null);

        /* Reset search field to match the initial module */
        if (search) search.value = firstModule || "";
        setSearchFeedback("", false);
        if (search && typeof search.setCustomValidity === "function") search.setCustomValidity("");
        closeModuleSearchOptions();

        /* Reset detail level to compact */
        selectedDetail = "compact";

        /* Auto-center the flowchart on the reset module */
        state.flowScrollTarget = firstModule || "";

        /* Reset all filters and re-render */
        apply();
      });
    }
  }


  function readUrlState() {
    var nativeParams = typeof URLSearchParams === "function" ? new URLSearchParams(window.location.search) : null;
    var fallbackParams = nativeParams ? null : queryParamStateFromSearch(window.location.search);
    function getParam(name) {
      if (nativeParams) {
        var value = nativeParams.get(name);
        return value === null ? "" : value;
      }
      return fallbackParams[name] || "";
    }

    var scopeParam = sanitizeScope(getParam("scope"));
    if (scopeParam) state.scope = scopeParam;

    var moduleParam = sanitizeModuleName(getParam("module"));
    if (moduleParam) state.selectedModule = moduleParam;

    var layer = getParam("layer") || "all";
    if (/^(all|model|kernel|security|platform|other)$/.test(layer)) state.activeLayerFilter = layer;

    var detail = getParam("detail") || "";
    if (/^(compact|balanced|expanded)$/.test(detail)) {
      applyDetailLevel(detail);
    } else {
      var neighbors = Number(getParam("neighbors") || "8");
      if (neighbors >= 4 && neighbors <= 20) state.neighborLimit = neighbors;

      var radius = Number(getParam("radius") || "1");
      if (radius >= 1 && radius <= 3) state.impactRadius = radius;

      var mode = getParam("mode") || "";
      if (mode === "imports") applyDetailLevel("compact");
      else if (mode === "impact") applyDetailLevel("expanded");
    }

    state.proofLinkedOnly = getParam("linked") === "1";
    state.flowShowAll = getParam("fullflow") === "1";

    var declParam = getParam("decl");
    if (declParam) {
      state.flowContext = "declaration";
      state.selectedDeclaration = declParam;
      state.selectedDeclarationModule = state.selectedModule || "";
    }
  }

  function syncUrlState() {
    if (typeof URLSearchParams !== "function") return;
    var params = new URLSearchParams(window.location.search);
    if (state.scope && state.scope !== DEFAULT_SCOPE) params.set("scope", state.scope); else params.delete("scope");
    if (state.selectedModule) params.set("module", state.selectedModule); else params.delete("module");
    if (state.activeLayerFilter && state.activeLayerFilter !== "all") params.set("layer", state.activeLayerFilter); else params.delete("layer");
    var detailLevel = detailLevelFromState();
    if (detailLevel !== "compact") params.set("detail", detailLevel); else params.delete("detail");
    params.delete("neighbors");
    params.delete("radius");

    if (state.proofLinkedOnly) params.set("linked", "1"); else params.delete("linked");
    if (state.flowShowAll) params.set("fullflow", "1"); else params.delete("fullflow");

    if (state.flowContext === "declaration" && state.selectedDeclaration) {
      params.set("decl", state.selectedDeclaration);
    } else {
      params.delete("decl");
    }

    params.delete("sort");
    params.delete("mode");

    var next = params.toString();
    var target = window.location.pathname + (next ? "?" + next : "");
    if (target === window.location.pathname + window.location.search) return;
    try { window.history.replaceState(null, "", target); } catch (e) {}
  }

  /* ------------------------------------------------------------------
     Scope toggle
     ------------------------------------------------------------------ */

  function scopeLabel(scope) {
    var fallback = { lean: "Lean", both: "Lean + Rust", rust: "Rust" };
    return t("map.scope_" + scope) || fallback[scope] || scope;
  }

  function scopeDescription(scope) {
    var fallback = {
      lean: "The Lean kernel alone: imports, dependents and proof pairs.",
      both: "Both languages, with the declaration-level boundary between them drawn.",
      rust: "The Rust workspace alone: crates, module trees and dependencies."
    };
    return t("map.scope_" + scope + "_desc") || fallback[scope] || "";
  }

  /* Switching scope keeps the selection when the node survives it — the Lean
     module you were reading is still there in the combined scope — and falls
     back to that scope's default when it does not. */
  function setScope(scope) {
    var next = sanitizeScope(scope);
    if (!next || next === state.scope) return;
    state.scope = next;
    invalidateDerivedCaches();
    if (!nodeExists(state.selectedModule)) {
      state.selectedModule = defaultNodeName();
      state.flowContext = "module";
      state.selectedDeclaration = "";
      state.selectedDeclarationModule = "";
      state.interiorMenuModule = "";
      /* Centre the replacement rather than clearing the target: an empty one
         means "keep the scroll you had" on desktop, which left the fallback
         node off-screen after scrolling down a band and narrowing the scope. */
      state.flowScrollTarget = state.selectedModule;
    }
    state.laneGroupsExpanded = { imports: Object.create(null), importers: Object.create(null) };
    closeModuleSearchOptions();
    syncUrlState();
    scheduleRender();
  }

  function renderScopeToggle() {
    var toggle = DOM.scopeToggle || document.getElementById("map-scope-toggle");
    if (toggle) {
      var buttons = toggle.querySelectorAll("[data-scope]");
      for (var i = 0; i < buttons.length; i++) {
        var button = buttons[i];
        var scope = button.dataset.scope;
        var active = scope === state.scope;
        button.setAttribute("aria-checked", active ? "true" : "false");
        button.tabIndex = active ? 0 : -1;
        button.classList.toggle("is-active", active);
        button.textContent = scopeLabel(scope);
        button.title = scopeDescription(scope);
        /* A scope with no Rust to show is offered but not selectable — except
           when it is already the active one, because a checked radio that is
           also disabled reads as broken. Until the snapshot lands, `both`
           simply degrades to the Lean reading. */
        var unavailable = scope !== "lean" && !(state.rustGraph && state.rustGraph.nodes.length);
        button.disabled = Boolean(unavailable) && !active;
      }
    }
    var badge = DOM.workspaceBadge || document.getElementById("workspace-scope-badge");
    if (badge) {
      var languages = { lean: "Lean 4", both: "Lean 4 + Rust", rust: "Rust" }[state.scope] || "";
      badge.textContent = (t("map.production_badge") || "production") + (languages ? " · " + languages : "");
    }
  }

  function setupScopeToggle() {
    var toggle = DOM.scopeToggle || document.getElementById("map-scope-toggle");
    if (!toggle) return;
    toggle.addEventListener("click", function (event) {
      var button = event.target && event.target.closest ? event.target.closest("[data-scope]") : null;
      if (!button || button.disabled) return;
      setScope(button.dataset.scope);
    });
    /* Radio-group semantics: arrows move the choice, not just the focus. */
    toggle.addEventListener("keydown", function (event) {
      var key = event.key;
      if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "ArrowUp" && key !== "ArrowDown" && key !== "Home" && key !== "End") return;
      var index = SCOPES.indexOf(state.scope);
      if (index === -1) return;
      var next = index;
      if (key === "ArrowRight" || key === "ArrowDown") next = (index + 1) % SCOPES.length;
      else if (key === "ArrowLeft" || key === "ArrowUp") next = (index - 1 + SCOPES.length) % SCOPES.length;
      else if (key === "Home") next = 0;
      else next = SCOPES.length - 1;
      var target = toggle.querySelector('[data-scope="' + SCOPES[next] + '"]');
      if (target && target.disabled) return;
      event.preventDefault();
      setScope(SCOPES[next]);
      if (target) target.focus();
    });
    renderScopeToggle();
  }

  function hydrateFilterControls() {
    var search = DOM.moduleSearch || document.getElementById("module-search");
    if (search && state.selectedModule) search.value = state.selectedModule;
    updateDetailPillState(detailLevelFromState());
    setSearchFeedback("", false);
  }

  function setupKeyboardNavigation() {
    document.addEventListener("keydown", function (event) {
      var target = event.target;
      if (event.isComposing) return;

      var key = (event.key || "").toLowerCase();

      /* "/" focuses the search field from anywhere — standard convention */
      if (key === "/" && !isTypingTarget(target)) {
        var search = DOM.moduleSearch || document.getElementById("module-search");
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }

      if (isTypingTarget(target)) return;

      if (key !== "j" && key !== "k") return;
      var list = contextList();
      if (!list.length) return;

      var currentIndex = Math.max(0, list.indexOf(state.selectedModule));
      var nextIndex = key === "j" ? Math.min(list.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
      selectModule(list[nextIndex], false);
      event.preventDefault();
    });
  }

  /* Everything below the hero is rendered from data with t() lookups at
     render time, so a locale change only needs a repaint. */
  function repaintForLocale() {
    LABEL_WRAP_CACHE.clear();
    paintLoadStatus();
    scheduleRender();
  }

  function setupLocaleRerender() {
    window.addEventListener("sele4n:locale-changed", repaintForLocale);
  }

  /* The first locale load dispatches no event: i18n.js translates the static
     DOM and runs its ready callbacks. A non-English locale can land after the
     bundled snapshot has painted, which would leave every generated label —
     crate cards, inventory, count labels — in its English fallback. So the
     ready callback repaints once, and only if a lookup fell back before it.
     It is registered first thing at boot: when the locale is already loaded
     the callback runs at once, before anything is painted, and nothing
     repaints. */
  function handleLocaleReady(repaint) {
    localeReady = true;
    if (!paintedBeforeLocale) return false;
    paintedBeforeLocale = false;
    repaint();
    return true;
  }

  function setupLocaleReady() {
    var i18n = window.sele4nI18n;
    if (i18n && typeof i18n.onReady === "function") {
      i18n.onReady(function () { handleLocaleReady(repaintForLocale); });
    } else {
      localeReady = true;
    }
  }

  function setupFlowchartResize() {
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      /* Debounce resize events: clear stale width cache on every resize,
         but defer the expensive re-render until the user has stopped resizing
         for 150ms.  This prevents janky mid-resize re-renders on drag-resize
         windows while still responding promptly when resizing finishes. */
      cachedMinFlowWidth = 0;
      cachedMinFlowWidthTs = 0;
      LABEL_WRAP_CACHE.clear();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        scheduleRender();
      }, 150);
    }, { passive: true });
  }


  function purgeLegacyStorage() {
    for (var i = 0; i < LEGACY_STORAGE_KEYS.length; i++) {
      try { localStorage.removeItem(LEGACY_STORAGE_KEYS[i]); } catch (e) {}
    }
  }

  function boot() {
    setupLocaleReady();
    cacheDomElements();
    setupTheme();
    if (typeof window.sele4nSetupHeaderNav !== "function") setupNav();
    hardenExternalLinks();
    readUrlState();
    setupFilters();
    setupScopeToggle();
    setupKeyboardNavigation();
    setupFlowchartResize();
    setupLocaleRerender();
    hydrateFilterControls();
    purgeLegacyStorage();

    /* One request, one revision: the bundled snapshot is fetched, normalized
       and rendered, and nothing replaces it afterwards. */
    fetchBundledMapData().then(yieldToBrowser).then(function (data) {
      applyData(data);
      hardenExternalLinks();
      paintLoadStatus("ready");
    }).catch(function (error) {
      paintLoadStatus("error", error && error.message ? error.message : "");
    });
  }

  if (window && window.__SELE4N_MAP_DISABLE_BOOT__) {
    window.__SELE4N_MAP_TEST_HOOKS__ = {
      normalizeMapData: normalizeMapData,
      hasCompleteSymbolLines: hasCompleteSymbolLines,
      symbolListsFromRaw: symbolListsFromRaw,
      makeEmptyInteriorSymbols: makeEmptyInteriorSymbols,
      interiorKindGroupOrder: function () { return INTERIOR_KIND_GROUP_ORDER.slice(); },
      interiorGroupItemCount: interiorGroupItemCount,
      pickInteriorDefaultKind: pickInteriorDefaultKind,
      interiorItemsForSelection: interiorItemsForSelection,
      interiorKindColor: interiorKindColor,
      normalizeDeclarationKind: normalizeDeclarationKind,
      assuranceColors: function () { return Object.assign({}, ASSURANCE_COLORS); },
      assuranceIcons: function () { return Object.assign({}, ASSURANCE_ICONS); },
      flowLegendItems: flowLegendItems,
      flowLaneLabelVisibility: flowLaneLabelVisibility,
      normalizeCaretRange: normalizeCaretRange,
      declarationFlowLegendItems: declarationFlowLegendItems,
      declarationCalls: declarationCalls,
      declarationCalledBy: declarationCalledBy,
      declarationCallerRefs: declarationCallerRefs,
      declarationCalleeRefs: declarationCalleeRefs,
      resolveDeclarationModule: resolveDeclarationModule,
      applyData: applyData,
      readUrlState: readUrlState,
      declarationModuleOf: declarationModuleOf,
      declarationKindOf: declarationKindOf,
      declarationLineOf: declarationLineOf,
      declarationSourceHref: declarationSourceHref,
      declarationSearchMatch: declarationSearchMatch,
      declarationSearchMatches: declarationSearchMatches,
      moduleSearchMatches: moduleSearchMatches,
      buildSearchIndex: buildSearchIndex,
      declarationSearchEntriesIn: declarationSearchEntriesIn,
      declarationLaneCollapseThreshold: function () { return 12; },
      declarationLaneVisibleLimit: function () { return 10; },
      objectDeclarationCount: objectDeclarationCount,
      extensionDeclarationCount: extensionDeclarationCount,
      verifiableSurfaceArea: verifiableSurfaceArea,
      assuranceForModule: assuranceForModule,
      relatedProofModules: relatedProofModules,
      findNearestLinkedPath: findNearestLinkedPath,
      buildPairs: buildPairs,
      defaultModuleName: defaultModuleName,
      defaultModule: function () { return DEFAULT_MODULE; },
      moduleSubsystem: moduleSubsystem,
      groupLaneModules: groupLaneModules,
      buildLaneEntries: buildLaneEntries,
      normalizeRustInventory: normalizeRustInventory,
      isInRepoOutsideScope: isInRepoOutsideScope,
      rustUnsafeSummary: rustUnsafeSummary,
      rustUnsafeDetail: rustUnsafeDetail,
      pickInteriorMenuGroup: pickInteriorMenuGroup,
      formatCount: formatCount,
      loadStatusText: loadStatusText,
      pluralEn: pluralEn,
      isLibraryRoot: isLibraryRoot,
      externalImportSubtitle: externalImportSubtitle,
      /* Scope, the Rust graph and the Lean ↔ Rust boundary */
      scopes: function () { return SCOPES.slice(); },
      defaultScope: function () { return DEFAULT_SCOPE; },
      sanitizeScope: sanitizeScope,
      sanitizeModuleName: sanitizeModuleName,
      setScope: setScope,
      currentScope: function () { return state.scope; },
      scopeNodes: scopeNodes,
      defaultNodeName: defaultNodeName,
      nodeExists: nodeExists,
      nodePath: nodePath,
      nodeSortScore: nodeSortScore,
      buildRustGraph: buildRustGraph,
      rustNodeName: rustNodeName,
      rustTargetName: rustTargetName,
      rustAncestorChain: rustAncestorChain,
      isRustNode: isRustNode,
      rustNode: rustNode,
      rustCrateStratum: rustCrateStratum,
      rustInteriorForNode: rustInteriorForNode,
      rustNodeSummary: rustNodeSummary,
      rustCrateSummary: rustCrateSummary,
      rustCrateDependencies: rustCrateDependencies,
      rustKindGroupOrder: function () { return RUST_KIND_GROUP_ORDER.slice(); },
      rustKindGroups: function () { return JSON.parse(JSON.stringify(RUST_KIND_GROUPS)); },
      rustFlowLegendItems: rustFlowLegendItems,
      bridgeLegendItems: bridgeLegendItems,
      toBridgeKey: toBridgeKey,
      bridgeScreenKey: bridgeScreenKey,
      bridgeRelation: bridgeRelation,
      buildBridgeIndex: buildBridgeIndex,
      bridgeIndex: function () { return state.bridge; },
      bridgeBandsFor: bridgeBandsFor,
      bridgeBandRows: bridgeBandRows,
      bridgeUndirected: function () { return JSON.parse(JSON.stringify(BRIDGE_UNDIRECTED)); },
      selectDeclaration: selectDeclaration,
      declarationSearchMatch: declarationSearchMatch,
      declarationSearchMatches: declarationSearchMatches,
      urlSafeNodeSegment: urlSafeNodeSegment,
      flowScrollTarget: function () { return state.flowScrollTarget; },
      selectionState: function () {
        return {
          module: state.selectedModule,
          context: state.flowContext,
          declaration: state.selectedDeclaration,
          declarationModule: state.selectedDeclarationModule
        };
      },
      bridgeEdgeSubtitle: bridgeEdgeSubtitle,
      interiorForNode: interiorForNode,
      interiorGroupsForNode: interiorGroupsForNode,
      interiorKindLabelForNode: interiorKindLabelForNode,
      translate: t,
      handleLocaleReady: handleLocaleReady,
      localePaintState: function () { return { ready: localeReady, painted: paintedBeforeLocale }; },
      applyTestState: function (patch) {
        if (patch.declarationGraph) state.declarationGraph = patch.declarationGraph;
        if (patch.declarationReverseGraph) {
          state.declarationReverseGraph = patch.declarationReverseGraph;
          state.declarationReverseModules = patch.declarationReverseModules || null;
        }
        if (patch.declarationIndex) {
          state.declarationIndex = patch.declarationIndex;
          state.declarationsByModule = patch.declarationsByModule || null;
          state.declarationModulesByName = patch.declarationModulesByName || null;
        }
        if (patch.moduleMeta) state.moduleMeta = patch.moduleMeta;
        if (patch.moduleMap) state.moduleMap = patch.moduleMap;
        if (patch.modules) state.modules = patch.modules;
        if (patch.importsFrom) state.importsFrom = patch.importsFrom;
        if (patch.importsTo) state.importsTo = patch.importsTo;
        if (patch.externalImportsFrom) state.externalImportsFrom = patch.externalImportsFrom;
        if (patch.proofPairMap) state.proofPairMap = patch.proofPairMap;
        if (patch.clearAssuranceCache) ASSURANCE_CACHE = Object.create(null);
        if (patch.clearDegreeMap) state.degreeMap = Object.create(null);
        if (typeof patch.declarationLanesExpanded === "boolean") state.declarationLanesExpanded = patch.declarationLanesExpanded;
        if (typeof patch.flowContext === "string") state.flowContext = patch.flowContext;
        if (typeof patch.selectedDeclaration === "string") state.selectedDeclaration = patch.selectedDeclaration;
        if (typeof patch.selectedModule === "string") state.selectedModule = patch.selectedModule;
        if (typeof patch.neighborLimit === "number") state.neighborLimit = patch.neighborLimit;
        if (typeof patch.flowShowAll === "boolean") state.flowShowAll = patch.flowShowAll;
        if (patch.laneGroupsExpanded) state.laneGroupsExpanded = patch.laneGroupsExpanded;
        if ("rust" in patch) {
          state.rust = patch.rust;
          state.rustGraph = buildRustGraph(state.rust);
        }
        if (typeof patch.scope === "string") state.scope = patch.scope;
        if (typeof patch.commitSha === "string") state.commitSha = patch.commitSha;
        if (patch.buildBridge) buildBridgeIndex();
        // Rebuild the declaration indexes from moduleMeta when moduleMeta is patched
        if (patch.moduleMeta && !patch.declarationIndex) {
          var rebuilt = buildDeclarationIndexes(state.moduleMeta, Object.keys(state.moduleMeta));
          state.declarationIndex = rebuilt.declarationIndex;
          state.declarationsByModule = rebuilt.declarationsByModule;
          state.declarationModulesByName = rebuilt.declarationModulesByName;
        }
      }
    };
    return;
  }

  boot();
})();
