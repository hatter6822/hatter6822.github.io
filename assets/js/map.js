(function () {
  "use strict";

  var REPO = "hatter6822/seLe4n";
  var REF = "main";
  var API = "https://api.github.com/repos/" + REPO;
  var CODEBASE_MAP_PATH = "docs/codebase_map.json";
  var CODEBASE_MAP_API = API + "/contents/" + CODEBASE_MAP_PATH;
  var CODEBASE_MAP_RAW = "https://raw.githubusercontent.com/" + REPO + "/" + REF + "/" + CODEBASE_MAP_PATH;
  var DATA_ENDPOINT = "data/map-data.json";

  var FETCH_OPTIONS = {
    credentials: "omit",
    cache: "no-store",
    mode: "cors",
    redirect: "error",
    referrerPolicy: "no-referrer"
  };

  /* localStorage keys used by this page (map.html):
     - sele4n-code-map-v9           : cached map data snapshot (schema v3)
     - sele4n-code-map-live-sync-meta-v1 : sync cooldown/commit tracking
     - sele4n-nav-intent-v1         : cross-page hash navigation (sessionStorage)
     - sele4n-theme                 : theme preference (shared with index.html)
     See also site.js keys: sele4n-live-v2, sele4n-bg-animation-paused-v1 */
  var CACHE_KEY = "sele4n-code-map-v9";
  var CACHE_SCHEMA_VERSION = 3;
  var CACHE_TTL_MS = 60 * 60 * 1000;
  var LIVE_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
  var LIVE_SYNC_JITTER_MAX_MS = 45 * 1000;
  var LIVE_SYNC_POLL_INTERVAL_MS = 90 * 1000;
  var COMPARE_FILES_TRUNCATION_LIMIT = 300;
  var LIVE_SYNC_META_KEY = "sele4n-code-map-live-sync-meta-v1";
  var FETCH_CONCURRENCY = 8;
  var FETCH_TIMEOUT_MS = 9000;
  var NAV_INTENT_KEY = "sele4n-nav-intent-v1";
  var NODE_CACHE = Object.create(null);
  var LABEL_WRAP_CACHE = new Map();
  var LABEL_WRAP_CACHE_LIMIT = 1200;
  var LABEL_WRAP_CACHE_EVICT_BATCH = 120;
  var ASSURANCE_CACHE = Object.create(null);

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
    moduleResults: null
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
  var INTERIOR_KIND_GROUP_LABELS = {
    object: "Objects",
    extension: "Extensions",
    contextInit: "Contexts/Inits"
  };
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
  var BUSY_STATUS_RE = /loading|refreshing|checking|analyzing|syncing/i;

  var state = {
    files: [], modules: [], moduleMap: Object.create(null), moduleMeta: Object.create(null),
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
    filteredModulesKey: "", filteredModulesList: [], filteredModulesValid: false,
    contextListValid: false,
    interiorMenuModule: "",
    interiorMenuQuery: "",
    interiorMenuSelections: { object: "", extension: "", contextInit: "" },
    commitSha: "",
    generatedAt: "",
    flowScrollTarget: "",
    flowContext: "module",
    selectedDeclaration: "",
    selectedDeclarationModule: "",
    declarationGraph: Object.create(null),
    declarationReverseGraph: Object.create(null),
    declarationIndex: Object.create(null),
    declarationLanesExpanded: false
  };

  var renderScheduled = false;
  var renderEpoch = 0;
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
    var epoch = renderEpoch;
    window.requestAnimationFrame(function () {
      renderScheduled = false;
      if (epoch !== renderEpoch) return;
      renderAll();
    });
  }

  function normalizeCaretRange(value, start, end) {
    var length = String(value || "").length;
    var normalizedStart = typeof start === "number" && isFinite(start) ? Math.max(0, Math.min(length, Math.floor(start))) : length;
    var normalizedEnd = typeof end === "number" && isFinite(end) ? Math.max(normalizedStart, Math.min(length, Math.floor(end))) : normalizedStart;
    return { start: normalizedStart, end: normalizedEnd };
  }

  function scheduleInteriorMenuRender(selected, caretRange, shouldRefocus) {
    if (interiorMenuRenderScheduled) return;
    interiorMenuRenderScheduled = true;
    window.requestAnimationFrame(function () {
      interiorMenuRenderScheduled = false;
      renderFlowNodeInteriorMenu(selected);
      if (!shouldRefocus) return;
      var queryInput = document.getElementById("interior-symbol-filter");
      if (!queryInput) return;
      queryInput.focus();
      if (!caretRange || typeof queryInput.setSelectionRange !== "function") return;
      queryInput.setSelectionRange(caretRange.start, caretRange.end);
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
    var total = state.modules.length;
    node.textContent = String(count) + " modules shown" + (total ? " (" + total + " total)" : "");
  }

  function setStatus(text, isError) {
    var el = DOM.mapStatus || document.getElementById("map-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", Boolean(isError));

    var main = DOM.mainContent || document.getElementById("main-content");
    if (main) main.setAttribute("aria-busy", BUSY_STATUS_RE.test(text) ? "true" : "false");
  }

  function updateMetric(key, value) {
    var els = NODE_CACHE[key];
    if (!els) {
      els = document.querySelectorAll('[data-map="' + key + '"]');
      NODE_CACHE[key] = els;
    }
    for (var i = 0; i < els.length; i++) els[i].textContent = String(value);
  }

  function formatGeneratedAt(value) {
    if (!value) return "-";
    var date = new Date(value);
    if (isNaN(date.getTime())) return "-";
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
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
      if (!res.ok) {
        var errMsg = "HTTP " + res.status;
        /* Surface rate-limit info so status messages are actionable */
        if (res.status === 403 || res.status === 429) {
          var retryAfter = res.headers && res.headers.get ? res.headers.get("retry-after") : "";
          if (retryAfter) errMsg += " (retry after " + retryAfter + "s)";
          else errMsg += " (rate limited)";
        }
        throw new Error(errMsg);
      }
      return asText ? res.text() : res.json();
    }).catch(function (error) {
      if (timer) clearTimeout(timer);
      throw error;
    });
  }

  function decodeBlobBase64(content) {
    var normalized = String(content || "").replace(/\n/g, "");
    var binary = window.atob(normalized);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

    if (typeof TextDecoder === "function") {
      try {
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch (e) {}
    }

    var out = "";
    for (var j = 0; j < bytes.length; j++) out += String.fromCharCode(bytes[j]);
    try {
      return decodeURIComponent(escape(out));
    } catch (err) {
      return out;
    }
  }

  function sanitizeModuleName(value) {
    return /^[A-Za-z0-9_.]+$/.test(value) ? value : "";
  }

  function normalizeSearchValue(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function buildSearchIndex() {
    var index = Object.create(null);
    for (var i = 0; i < state.modules.length; i++) {
      var name = state.modules[i];
      var path = state.moduleMap[name] || "";
      index[name] = {
        nameLower: name.toLowerCase(),
        pathLower: path.toLowerCase(),
        nameTokens: normalizeSearchValue(name).split(/\s+/).filter(Boolean),
        pathTokens: normalizeSearchValue(path).split(/\s+/).filter(Boolean)
      };
    }
    state.searchIndex = index;
    buildDeclarationSearchIndex();
  }

  function buildDeclarationSearchIndex() {
    var declIndex = [];
    for (var declName in state.declarationIndex) {
      if (!Object.prototype.hasOwnProperty.call(state.declarationIndex, declName)) continue;
      var entry = state.declarationIndex[declName];
      if (!entry || !entry.module) continue;
      var qualifiedName = entry.module + "." + declName;
      declIndex.push({
        name: declName,
        nameLower: declName.toLowerCase(),
        module: entry.module,
        qualifiedName: qualifiedName,
        qualifiedLower: qualifiedName.toLowerCase()
      });
    }
    state.declarationSearchList = declIndex;
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

  function theoremCount(text) {
    var matches = text.match(/^\s*(?:@\[[^\]]+\]\s+|@[\w.]+\s+)*(?:private\s+|protected\s+)?(?:theorem|lemma)\s+[\w'.`]+/gm);
    return matches ? matches.length : 0;
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

  function createLineLocator(text) {
    var source = String(text || "");
    var lineStarts = [0];

    for (var i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) !== 10) continue;
      lineStarts.push(i + 1);
    }

    return function lineNumberForIndex(index) {
      var target = Math.max(0, Number(index) || 0);
      var low = 0;
      var high = lineStarts.length - 1;

      while (low <= high) {
        var mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] <= target) low = mid + 1;
        else high = mid - 1;
      }

      return Math.max(1, high + 1);
    };
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
      if (kind === "constants") candidates.push("constant");
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

  function interiorItemsForSelection(interior, groupKinds, selectedKind, query) {
    var q = String(query || "").trim().toLowerCase();

    function byNameThenLine(a, b) {
      var left = String((a && a.name) || "");
      var right = String((b && b.name) || "");
      var byName = left.localeCompare(right, undefined, { sensitivity: "base" });
      if (byName !== 0) return byName;
      return ((a && a.line) || 0) - ((b && b.line) || 0);
    }

    function filterByQuery(list) {
      if (!q) return list;
      return list.filter(function (entry) {
        return String((entry && entry.name) || "").toLowerCase().indexOf(q) !== -1;
      });
    }

    if (selectedKind === INTERIOR_KIND_ALL_VALUE) {
      var aggregated = [];
      for (var i = 0; i < groupKinds.length; i++) {
        var kindItems = ((interior.byKind || {})[groupKinds[i]] || []).slice();
        for (var j = 0; j < kindItems.length; j++) {
          aggregated.push(Object.assign({}, kindItems[j], { __kind: groupKinds[i] }));
        }
      }
      aggregated.sort(byNameThenLine);
      return filterByQuery(aggregated);
    }

    var selectedItems = ((interior.byKind || {})[selectedKind] || []).slice().sort(byNameThenLine).map(function (entry) {
      return Object.assign({}, entry, { __kind: selectedKind });
    });
    return filterByQuery(selectedItems);
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

  function interiorKindColor(kind) {
    var k = String(kind || "");
    return INTERIOR_KIND_COLOR_MAP[k] || INTERIOR_KIND_COLOR_MAP[normalizeDeclarationKind(k)] || "#8fa3bf";
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

  function declarationLineFromMatch(match, lineNumberForIndex) {
    var whole = String(match && match[0] || "");
    var leading = (whole.match(/^\s*/) || [""])[0].length;
    return lineNumberForIndex((match && typeof match.index === "number" ? match.index : 0) + leading);
  }

  function extractInteriorCodeItems(sourceText) {
    var lineNumberForIndex = createLineLocator(sourceText);
    var declarationPattern = /^\s*(?:@\[[^\]]+\]\s+|@[\w.]+\s+)*(?:private\s+|protected\s+)?(?:noncomputable\s+)?(inductive|structure|class|def|theorem|lemma|example|instance|opaque|abbrev|axiom|constants?|declare_syntax_cat|syntax_cat|syntax|macro_rules|macro|notation|infixl|infixr|infix|prefix|postfix|elab_rules|term_elab|command_elab|elab|tactic|universes?|variables?|parameters?|section|namespace|end|initialize)\b[ \t]*([^:\s\n(\[{:=\-]*)/gm;
    var kinds = allInteriorKinds();
    var seenByKind = Object.create(null);
    var byKind = Object.create(null);
    var anonCounters = Object.create(null);

    for (var i = 0; i < kinds.length; i++) {
      seenByKind[kinds[i]] = Object.create(null);
      byKind[kinds[i]] = [];
      anonCounters[kinds[i]] = 0;
    }

    var match;
    while ((match = declarationPattern.exec(sourceText)) !== null) {
      var kind = String(match[1] || "").trim();
      if (!kind || !Object.prototype.hasOwnProperty.call(byKind, kind)) continue;
      var line = declarationLineFromMatch(match, lineNumberForIndex);
      var rawName = normalizeSymbolName(match[2]);
      var name = rawName || "<" + kind + "@L" + line + ">";
      if (seenByKind[kind][name]) {
        /* Disambiguate collisions from unnamed declarations at the same line */
        anonCounters[kind] += 1;
        name = "<" + kind + "@L" + line + "#" + anonCounters[kind] + ">";
        if (seenByKind[kind][name]) continue;
      }
      seenByKind[kind][name] = true;
      byKind[kind].push({ name: name, line: line });
    }

    return {
      byKind: byKind,
      theorems: (byKind.theorem || []).concat(byKind.lemma || []),
      functions: (byKind.def || []).concat(byKind.abbrev || [], byKind.opaque || [], byKind.instance || [])
    };
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

    var interior = extractInteriorCodeItems(sourceText);
    state.moduleMeta[name] = {
      layer: classifyLayer(name),
      kind: moduleKind(name),
      base: moduleBase(name),
      theorems: theoremCount(sourceText),
      symbols: interior,
      symbolsLoaded: hasCompleteSymbolLines(interior)
    };
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

  function declarationCalls(declName) {
    var entry = state.declarationGraph[declName];
    return entry && Array.isArray(entry.calls) ? entry.calls.slice() : [];
  }

  function declarationCalledBy(declName) {
    var reverse = state.declarationReverseGraph[declName];
    return Array.isArray(reverse) ? reverse.slice() : [];
  }

  function declarationModuleOf(declName) {
    var entry = state.declarationGraph[declName];
    if (entry) return entry.module;
    var indexed = state.declarationIndex[declName];
    if (indexed) return indexed.module;
    return "";
  }

  function declarationKindOf(declName) {
    var indexed = state.declarationIndex[declName];
    if (indexed) return indexed.kind;
    return "";
  }

  function declarationLineOf(declName) {
    var indexed = state.declarationIndex[declName];
    if (indexed) return indexed.line || 0;
    return 0;
  }

  function declarationSourceHref(declName) {
    var moduleName = declarationModuleOf(declName);
    if (!moduleName || !state.moduleMap[moduleName]) return "";
    var ref = state.commitSha || REF;
    var path = state.moduleMap[moduleName];
    var encodedPath = path.split("/").map(encodeURIComponent).join("/");
    var line = declarationLineOf(declName);
    var lineAnchor = line > 0 ? "#L" + line : "";
    return "https://github.com/" + REPO + "/blob/" + encodeURIComponent(ref) + "/" + encodedPath + lineAnchor;
  }

  function moduleSourceLink(name) {
    if (!name || !state.moduleMap[name]) return null;
    var ref = state.commitSha || REF;
    var path = state.moduleMap[name];
    var encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return {
      href: "https://github.com/" + REPO + "/blob/" + encodeURIComponent(ref) + "/" + encodedPath,
      label: path,
      title: "Open " + name + " source on GitHub"
    };
  }

  function selectDeclaration(declName, moduleName) {
    var mod = moduleName || declarationModuleOf(declName);
    if (!mod || !state.moduleMap[mod]) return;
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
      { label: "Selected declaration", color: "#7c9cff", group: "edge" },
      { label: "Calls (outgoing)", color: "#82f0b0", group: "edge" },
      { label: "Called by (incoming)", color: "#ffad42", group: "edge" },
      { separator: true },
      { label: "Border = declaration kind", color: "#8fa3bf", group: "edge" },
      { label: "Dashed = cross-module", color: "#8fa3bf", group: "edge" }
    ];
  }

  function collectNeighborhood(name, radius) {
    var maxRadius = Math.max(1, Math.min(3, radius || 1));
    var visited = Object.create(null);
    var queue = [{ name: name, depth: 0 }];
    var out = [];
    visited[name] = true;

    for (var cursor = 0; cursor < queue.length; cursor++) {
      var node = queue[cursor];
      out.push(node);
      if (node.depth >= maxRadius) continue;
      var neighbors = (state.importsFrom[node.name] || []).concat(state.importsTo[node.name] || []);
      for (var i = 0; i < neighbors.length; i++) {
        var next = neighbors[i];
        if (!next || next === node.name || visited[next]) continue;
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

  function filteredModules() {
    var key = [state.activeLayerFilter, state.proofLinkedOnly ? "1" : "0", state.modules.length].join("|");
    if (key === state.filteredModulesKey && state.filteredModulesValid) return state.filteredModulesList.slice();

    var layer = state.activeLayerFilter;
    var list = state.modules.filter(function (name) {
      var meta = state.moduleMeta[name] || {};
      if (layer !== "all" && meta.layer !== layer) return false;
      if (state.proofLinkedOnly) {
        var pair = findProofPair(name);
        if (!pair || !pair.invariantImportsOperations) return false;
      }
      return true;
    });

    state.filteredModulesKey = key;
    state.filteredModulesList = list.slice();
    state.filteredModulesValid = true;
    return list;
  }

  function sortModules(list) {
    list.sort(function (a, b) {
      var scoreDiff = moduleDegree(b).score - moduleDegree(a).score;
      return scoreDiff || a.localeCompare(b);
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
    /* Scale SVG width proportionally so mobile devices don't get an
       excessively wide canvas.  On very small screens (≤420px) the old
       fixed 900px created ~2.4× horizontal scrolling; the new formula
       keeps the graph readable while limiting pan distance.
       The multiplier (2.15–2.35×) ensures three-lane layouts still fit
       without overlapping, but the user only scrolls ~1× viewport width
       instead of ~1.5×. */
    if (width <= 420) result = Math.max(720, Math.round(width * 2.25));
    else if (width <= 640) result = Math.max(820, Math.round(width * 2.1));
    else if (width <= 900) result = Math.max(920, Math.round(width * 1.4));
    else result = 1180;
    cachedMinFlowWidth = result;
    cachedMinFlowWidthTs = now;
    return result;
  }

  function selectModule(name, preserveScroll) {
    if (!name || !state.moduleMap[name]) return;
    if (state.selectedModule === name && state.flowContext === "module") {
      renderFlowNodeInteriorMenu(name);
      return;
    }
    state.selectedModule = name;
    state.flowContext = "module";
    state.selectedDeclaration = "";
    state.selectedDeclarationModule = "";
    state.declarationLanesExpanded = false;
    state.flowScrollTarget = preserveScroll ? "" : name;
    if (state.interiorMenuModule !== name) {
      state.interiorMenuModule = name;
      state.interiorMenuQuery = "";
    }
    syncUrlState();
    scheduleRender();
  }

  function contextList() {
    var key = [state.activeLayerFilter, state.proofLinkedOnly ? "1" : "0", state.modules.length].join("|");
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
      state.selectedModule = list[0];
      syncUrlState();
    }

    var label = DOM.moduleSearchLabel || document.querySelector('label[for="module-search"]');
    var inDeclContext = state.flowContext === "declaration" && state.selectedDeclaration;

    if (!list.length) {
      picker.value = "";
      picker.placeholder = "No modules matched current filters";
      if (label) label.textContent = "Context search";
      closeModuleSearchOptions();
      return;
    }

    if (inDeclContext) {
      picker.placeholder = "Module or Module.declaration";
      if (label) label.textContent = "Context search \u2014 declaration";
      if (document.activeElement !== picker) {
        picker.value = state.selectedDeclarationModule + "." + state.selectedDeclaration;
      }
    } else {
      picker.placeholder = "Module or Module.declaration";
      if (label) label.textContent = "Context search \u2014 module";
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
      { label: "Selected module", color: "#7c9cff", group: "edge" },
      { label: "Imports (dependencies)", color: "#35c98f", group: "edge" },
      { label: "Impacted (dependents)", color: "#ffad42", group: "edge" },
      { label: "Proof pair", color: "#d37cff", group: "edge" },
      { label: "Linked-proof path", color: "#6de2ff", group: "edge" },
      { label: "External imports", color: "#b9c0d0", group: "edge" },
      { separator: true },
      /* Assurance indicators — node left-border marks showing proof confidence */
      { label: ASSURANCE_ICONS.linked + " Linked (Ops\u2194Inv proof chain)", color: ASSURANCE_COLORS.linked, group: "assurance", indicator: "bar" },
      { label: ASSURANCE_ICONS.partial + " Partial (pair incomplete/disconnected)", color: ASSURANCE_COLORS.partial, group: "assurance", indicator: "bar" },
      { label: ASSURANCE_ICONS.local + " Local (standalone theorems)", color: ASSURANCE_COLORS.local, group: "assurance", indicator: "bar" },
      { label: ASSURANCE_ICONS.none + " None (no proof coverage)", color: ASSURANCE_COLORS.none, group: "assurance", indicator: "bar" }
    ];
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

  function renderFlowNodeInteriorMenu(selected) {
    var menu = DOM.flowNodeInteriorMenu || document.getElementById("flow-node-interior-menu");
    if (!menu) return;
    menu.innerHTML = "";
    if (!selected) {
      menu.textContent = "Select a module to inspect interior declarations.";
      return;
    }

    if (state.interiorMenuModule !== selected) {
      state.interiorMenuModule = selected;
      state.interiorMenuQuery = "";
      state.interiorMenuSelections = { object: "", extension: "", contextInit: "" };
    }

    var interior = interiorCodeForModule(selected);
    var query = (state.interiorMenuQuery || "").trim().toLowerCase();
    var groups = INTERIOR_KIND_GROUP_ORDER.map(function (groupKey) {
      var kinds = INTERIOR_KIND_GROUPS[groupKey] || [];
      return {
        key: groupKey,
        label: INTERIOR_KIND_GROUP_LABELS[groupKey] || groupKey,
        kinds: kinds,
        selectedKind: pickInteriorDefaultKind(interior, kinds, state.interiorMenuSelections[groupKey] || ""),
        totalCount: interiorGroupItemCount(interior, kinds)
      };
    });

    var controls = document.createElement("div");
    controls.className = "interior-menu-controls";
    var queryLabel = document.createElement("label");
    queryLabel.className = "sr-only";
    queryLabel.setAttribute("for", "interior-symbol-filter");
    queryLabel.textContent = "Filter interior declarations";
    var queryInput = document.createElement("input");
    queryInput.id = "interior-symbol-filter";
    queryInput.className = "interior-menu-search";
    queryInput.type = "search";
    queryInput.placeholder = "Filter declarations across all kinds…";
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

    var grid = document.createElement("div");
    grid.className = "interior-menu-grid";

    function symbolSourceHref(moduleName, entry) {
      if (!moduleName || !state.moduleMap[moduleName]) return "";
      var ref = state.commitSha || REF;
      var path = state.moduleMap[moduleName];
      var encodedPath = path.split("/").map(encodeURIComponent).join("/");
      var lineAnchor = entry && entry.line > 0 ? "#L" + entry.line : "";
      return "https://github.com/" + REPO + "/blob/" + encodeURIComponent(ref) + "/" + encodedPath + lineAnchor;
    }

    for (var g = 0; g < groups.length; g++) {
      (function (group) {
        var column = document.createElement("section");
        column.className = "interior-menu-column";

        var top = document.createElement("div");
        top.className = "interior-menu-column-top";

        var heading = document.createElement("h4");
        heading.textContent = group.label;
        top.appendChild(heading);

        var select = document.createElement("select");
        select.className = "interior-kind-select";
        select.setAttribute("aria-label", "Filter " + group.label + " by kind");
        var allOption = document.createElement("option");
        allOption.value = INTERIOR_KIND_ALL_VALUE;
        allOption.textContent = "All (" + group.totalCount + ")";
        allOption.selected = group.selectedKind === INTERIOR_KIND_ALL_VALUE;
        select.appendChild(allOption);
        for (var i = 0; i < group.kinds.length; i++) {
          var kind = group.kinds[i];
          var option = document.createElement("option");
          option.value = kind;
          option.textContent = symbolKindLabel(kind) + " (" + (interior.byKind[kind] || []).length + ")";
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

        var emptyNote = null;

        function showEmptyNote(message) {
          list.innerHTML = "";
          if (list.parentNode) list.parentNode.removeChild(list);
          if (!emptyNote) {
            emptyNote = document.createElement("p");
            emptyNote.className = "panel-note";
            emptyNote.style.margin = "0";
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
            var msg = query ? "No declarations match this filter." : (activeKind === INTERIOR_KIND_ALL_VALUE ? "No declarations detected for this kind group." : "No declarations detected for this kind.");
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
            li.dataset.kindLabel = symbolKindLabel(items[j].__kind || activeKind);
            applyInteriorKindColor(li, items[j].__kind || activeKind, false);
            var hasCallData = Boolean(state.declarationGraph[items[j].name]) || Boolean(state.declarationReverseGraph[items[j].name]);
            var isNavigable = hasCallData || Boolean(state.moduleMap[selected]);
            if (isNavigable) {
              li.classList.add("interior-menu-item-navigable");
              var btn = document.createElement("button");
              btn.type = "button";
              btn.className = "interior-menu-item-btn";
              btn.textContent = items[j].name;
              btn.title = "View declaration call graph for " + items[j].name;
              btn.dataset.decl = items[j].name;
              btn.addEventListener("click", (function (itemName) {
                return function () { selectDeclaration(itemName, selected); };
              })(items[j].name));
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
        grid.appendChild(column);
      })(groups[g]);
    }

    /* Batch-append the grid in a single DOM operation to minimize reflows */
    var gridFragment = document.createDocumentFragment();
    gridFragment.appendChild(grid);
    menu.appendChild(gridFragment);
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
       (e.g. SeLe4n.Kernel.Operations → ["SeLe4n", ".", "Kernel", ".", "Operations"]) */
    var tokens = String(text).split(/([._/\-])/);
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
    path.setAttribute("marker-end", "url(#flow-arrow)");
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

    var edgeLayer = createSvgNode("g", { "class": "flow-edge-layer", "aria-hidden": "true" });
    var nodeLayer = createSvgNode("g", { "class": "flow-node-layer" });
    var labelLayer = createSvgNode("g", { "class": "flow-label-layer" });
    svg.appendChild(edgeLayer);
    svg.appendChild(nodeLayer);
    svg.appendChild(labelLayer);

    return {
      svg: svg,
      edgeLayer: edgeLayer,
      nodeLayer: nodeLayer,
      labelLayer: labelLayer,
      /* Flush all pending layer children into the SVG in one batch.
         Call this after all nodes/edges/labels have been constructed
         to minimize DOM reflow during construction. */
      flush: function () {
        /* Layers are already appended to SVG; this is a no-op hook for
           future fragment-based construction if needed. */
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

  function flowLaneLabel(labelLayer, text, x, y, color) {
    var label = createSvgNode("text", { x: x, y: y, fill: color, "font-size": "12", "class": "flow-lane-label" });
    label.textContent = text;
    labelLayer.appendChild(label);
  }

  function applyFlowScrollTarget(wrap, targetName, centerX, centerY, centerW, centerH) {
    if (state.flowScrollTarget !== targetName) return false;
    var targetScrollLeft = Math.max(0, centerX + centerW / 2 - wrap.clientWidth / 2);
    var targetScrollTop = Math.max(0, centerY + centerH / 2 - wrap.clientHeight / 2);
    var maxScrollLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    var maxScrollTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    // Temporarily disable smooth scrolling for instant programmatic positioning
    wrap.style.scrollBehavior = "auto";
    wrap.scrollLeft = Math.min(maxScrollLeft, targetScrollLeft);
    wrap.scrollTop = Math.min(maxScrollTop, targetScrollTop);
    wrap.style.removeProperty("scroll-behavior");
    state.flowScrollTarget = "";
    return true;
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
      group.addEventListener("click", function () { onActivate(); });
      group.addEventListener("keydown", function (event) {
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
    var wrapWidth = Math.max(0, ((wrap && wrap.clientWidth) || 0) - 8);
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
    var previousScrollLeft = shouldPreserveScroll ? wrap.scrollLeft : 0;
    var previousScrollTop = shouldPreserveScroll ? wrap.scrollTop : 0;
    wrap.innerHTML = "";
    flowClipIdCounter = 0;

    var selected = state.selectedModule;
    if (!selected) {
      renderFlowNodeInteriorMenu("");
      wrap.textContent = "Select a module to render interaction and proof flow.";
      return;
    }

    var allImports = (state.importsFrom[selected] || []).slice().sort(sortByScoreThenName);
    var allImporters = (state.importsTo[selected] || []).slice().sort(sortByScoreThenName);
    var allExternal = state.externalImportsFrom[selected] || [];
    var importBudget = state.flowShowAll ? allImports.length : state.neighborLimit;
    var impactBudget = state.flowShowAll ? allImporters.length : state.neighborLimit;
    var imports = allImports.slice(0, importBudget);
    var importers = allImporters.slice(0, impactBudget);
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

    function stackedLayout(names, width, subtitleFn, compactHint, includeSourceLinks) {
      var nodes = [];
      var cursor = laneYStart;
      for (var ii = 0; ii < names.length; ii++) {
        var subtitleText = subtitleFn ? subtitleFn(names[ii]) : "";
        var srcLink = includeSourceLinks ? moduleSourceLink(names[ii]) : null;
        /* Module nodes always have assurance indicators */
        var height = nodeContentHeight(names[ii], subtitleText, width, compactHint, srcLink ? srcLink.label : "", true);
        nodes.push({ name: names[ii], y: cursor, h: height, subtitle: subtitleText, sourceLink: srcLink });
        cursor += height + laneGapY;
      }
      return { nodes: nodes, bottom: names.length ? (cursor - laneGapY) : laneYStart + 44 };
    }

    var importLayout = stackedLayout(imports, sideWidth, moduleSummary, false, true);
    var importerLayout = stackedLayout(importers, sideWidth, moduleSummary, false, true);
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
        var exH = nodeContentHeight(external[ex], "external dependency", externalWidth, true, "", false);
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
    var effectiveBottom = hasExternalSection ? externalBottom
      : hasPathSection ? pathBlockBottom
      : hasProofSection ? proofBottom
      : Math.max(laneBottom, centerBottom);
    var minFlowHeight = prefersCompactViewport() ? 420 : 620;
    var flowHeight = Math.max(minFlowHeight, effectiveBottom + (hasExternalSection ? 48 : 32));

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

    function createNode(name, x, y, w, h, color, subtitle, tooltip, active, isStatic, assuranceLevel, onActivate, metaLink) {
      var className = "flow-node" + (active ? " active" : "") + (isStatic ? " static" : "");
      if (onActivate) className += " action";
      if (assuranceLevel && !isStatic) className += " assurance-" + assuranceLevel;
      var interactive = !isStatic || Boolean(onActivate);
      var ariaLabel = interactive ? (onActivate ? name : ("Select module " + name)) : name;
      var activator = interactive ? (onActivate || function () { selectModule(name, false); }) : null;
      return buildFlowNodeGroup(nodeLayer, className, interactive, ariaLabel, name, x, y, w, h, color, subtitle, tooltip, activator, metaLink || null);
    }

    if (laneLabels.imports) laneLabel("Imports used by selected", leftX, 30, "#35c98f");
    if (laneLabels.selected) laneLabel("Selected module context", centerX, centerY - 12, "#7c9cff");
    if (laneLabels.impacted) laneLabel("Modules impacted by selected", rightX, 30, "#ffad42");

    var center = createNode(selected, centerX, centerY, centerWidth, centerHeight, "#7c9cff", moduleSummary(selected), nodeTooltip(selected, "Selected module context"), true, false, contextFor(selected).assurance.level, null, centerSourceLink);

    var importNodes = [];
    for (var i = 0; i < importLayout.nodes.length; i++) {
      var importItem = importLayout.nodes[i];
      importNodes.push(createNode(importItem.name, leftX, importItem.y, sideWidth, importItem.h, "#35c98f", importItem.subtitle, nodeTooltip(importItem.name, "Imported dependency"), false, false, contextFor(importItem.name).assurance.level, null, importItem.sourceLink));
    }

    var importerNodes = [];
    for (var j = 0; j < importerLayout.nodes.length; j++) {
      var importerItem = importerLayout.nodes[j];
      importerNodes.push(createNode(importerItem.name, rightX, importerItem.y, sideWidth, importerItem.h, "#ffad42", importerItem.subtitle, nodeTooltip(importerItem.name, "Impacted module"), false, false, contextFor(importerItem.name).assurance.level, null, importerItem.sourceLink));
    }

    var hasHiddenImports = allImports.length > imports.length;
    var hasHiddenImporters = allImporters.length > importers.length;
    var canMinimizeImports = state.flowShowAll && allImports.length > state.neighborLimit;
    var canMinimizeImporters = state.flowShowAll && allImporters.length > state.neighborLimit;

    if (hasHiddenImports) {
      createNode("+" + (allImports.length - imports.length) + " more imports", leftX, importLayout.bottom + laneGapY, sideWidth, 36, "#35c98f", "switch to Expanded mode", "Activate expanded mode", false, true, "", setExpandedFlowMode);
    } else if (canMinimizeImports) {
      createNode("Return to Compact mode", leftX, importLayout.bottom + laneGapY, sideWidth, 36, "#35c98f", "hide extra imports", "Activate compact mode", false, true, "", setCompactFlowMode);
    }

    if (hasHiddenImporters) {
      createNode("+" + (allImporters.length - importers.length) + " more impacted modules", rightX, importerLayout.bottom + laneGapY, sideWidth, 36, "#ffad42", "switch to Expanded mode", "Activate expanded mode", false, true, "", setExpandedFlowMode);
    } else if (canMinimizeImporters) {
      createNode("Return to Compact mode", rightX, importerLayout.bottom + laneGapY, sideWidth, 36, "#ffad42", "hide extra impacted modules", "Activate compact mode", false, true, "", setCompactFlowMode);
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
      if (laneLabels.proof) laneLabel("Proof pair context", centerX, proofStartY - 16, "#d37cff");
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
      if (laneLabels.linkedPath) laneLabel("Nearest linked-proof path (radius " + state.impactRadius + ")", Math.max(framePad, centerX - 180), pathStartY - 14, "#6de2ff");
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
      laneLabel("External imports", leftX, externalStartY - 10, "#b9c0d0");
      var externalEdgeNodes = [];
      for (var z = 0; z < externalItems.length; z++) {
        var externalItem = externalItems[z];
        var isMorePlaceholder = externalItem.name.charAt(0) === "+";
        var extSubtitle = isMorePlaceholder ? "" : "external dependency";
        var extNode = createNode(externalItem.name, externalItem.x, externalItem.y, externalWidth, externalItem.h, "#b9c0d0", extSubtitle, isMorePlaceholder ? "" : "External import: " + externalItem.name + "\nImported by " + selected, false, true, "");
        if (!isMorePlaceholder) externalEdgeNodes.push(extNode);
      }
      /* Draw subtle edges from center to each external import node */
      for (var ze = 0; ze < externalEdgeNodes.length; ze++) {
        drawFlowEdge(edgeLayer, center, externalEdgeNodes[ze], "#b9c0d0", true, { rank: ze, total: externalEdgeNodes.length, spread: Math.min(40, externalEdgeNodes.length * 4), vertical: true });
      }
    }

    wrap.appendChild(svg);

    renderFlowNodeInteriorMenu(selected);

    if (!applyFlowScrollTarget(wrap, selected, center.x, center.y, center.w, center.h)) {
      wrap.style.scrollBehavior = "auto";
      wrap.scrollLeft = previousScrollLeft;
      wrap.scrollTop = previousScrollTop;
      wrap.style.removeProperty("scroll-behavior");
    }
  }

  function renderDeclarationFlowchart() {
    var wrap = DOM.flowchartWrap || document.getElementById("flowchart-wrap");
    if (!wrap) return;
    var shouldPreserveScroll = !prefersCompactViewport() && !state.flowScrollTarget;
    var previousScrollLeft = shouldPreserveScroll ? wrap.scrollLeft : 0;
    var previousScrollTop = shouldPreserveScroll ? wrap.scrollTop : 0;
    wrap.innerHTML = "";
    flowClipIdCounter = 0;

    var declName = state.selectedDeclaration;
    var moduleName = state.selectedDeclarationModule;
    if (!declName || !moduleName) {
      returnToModuleContext();
      return;
    }

    var calls = declarationCalls(declName);
    var calledBy = declarationCalledBy(declName);

    var breadcrumb = document.createElement("nav");
    breadcrumb.className = "declaration-context-breadcrumb";
    breadcrumb.setAttribute("aria-label", "Declaration breadcrumb");
    var moduleLabel = document.createElement("button");
    moduleLabel.className = "btn btn-secondary declaration-breadcrumb-module";
    moduleLabel.type = "button";
    moduleLabel.textContent = moduleName;
    moduleLabel.title = "Return to module context for " + moduleName;
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

    function declSummary(name) {
      var kind = declarationKindOf(name);
      var mod = declarationModuleOf(name);
      var line = declarationLineOf(name);
      var parts = [];
      if (kind) parts.push(symbolKindLabel(kind));
      if (mod) {
        var isCrossModule = mod !== moduleName;
        parts.push((isCrossModule ? "\u2192 " : "in ") + mod);
      }
      if (line > 0) parts.push("L" + line);
      var outgoing = declarationCalls(name).length;
      var incoming = declarationCalledBy(name).length;
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

    function declMetaLink(name) {
      var line = declarationLineOf(name);
      if (!(line > 0)) return null;
      var href = declarationSourceHref(name);
      if (!href) return null;
      return {
        href: href,
        label: "L" + line,
        title: "Open declaration source at line " + line
      };
    }

    function declTooltip(name, roleLabel) {
      var kind = declarationKindOf(name);
      var mod = declarationModuleOf(name);
      var line = declarationLineOf(name);
      var callsList = declarationCalls(name);
      return roleLabel + "\n" + name + (kind ? "\nkind: " + kind : "") + (mod ? "\nmodule: " + mod : "") + (line > 0 ? "\nline: " + line : "") + "\ncalls: " + (callsList.length || "none");
    }

    function declNodeColor(name) {
      var kind = declarationKindOf(name);
      if (!kind) return "#8fa3bf";
      /* Use the kind-specific color for same-module declarations but
         desaturate slightly for cross-module ones so that visual weight
         emphasizes the local module's declarations. */
      var raw = INTERIOR_KIND_COLOR_MAP[kind] || "#8fa3bf";
      var declMod = declarationModuleOf(name);
      if (declMod && declMod !== moduleName) return blendHexColor(raw, "#8fa3bf", 0.45);
      return raw;
    }

    function sortByModuleRelevance(arr, referenceModule) {
      return arr.slice().sort(function (a, b) {
        var modA = declarationModuleOf(a);
        var modB = declarationModuleOf(b);
        var sameA = modA === referenceModule ? 0 : 1;
        var sameB = modB === referenceModule ? 0 : 1;
        if (sameA !== sameB) return sameA - sameB;
        return a.toLowerCase().localeCompare(b.toLowerCase());
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

    var callLayout = [];
    var cursorLeft = laneYStart;
    for (var ci = 0; ci < visibleCalls.length; ci++) {
      var callMetaLink = declMetaLink(visibleCalls[ci]);
      var ch = nodeContentHeight(visibleCalls[ci], declSummary(visibleCalls[ci]), sideWidth, true, callMetaLink ? callMetaLink.label : "", false);
      callLayout.push({ name: visibleCalls[ci], y: cursorLeft, h: ch, collapsed: false, expandable: false, compactControl: false, metaLink: callMetaLink });
      cursorLeft += ch + laneGapY;
    }
    if (collapsedCallCount > 0) {
      var collapsedCallLabel = "+" + collapsedCallCount + " more";
      var cch = nodeContentHeight(collapsedCallLabel, "expand to show all", sideWidth, true, "", false);
      callLayout.push({ name: collapsedCallLabel, y: cursorLeft, h: cch, collapsed: true, expandable: true });
      cursorLeft += cch + laneGapY;
    }
    if (canCompactCalls) {
      var compactCallLabel = "Return to Compact";
      var compactCallH = nodeContentHeight(compactCallLabel, "hide extra calls", sideWidth, true, "", false);
      callLayout.push({ name: compactCallLabel, y: cursorLeft, h: compactCallH, compactControl: true });
      cursorLeft += compactCallH + laneGapY;
    }
    var callBottom = callLayout.length ? cursorLeft - laneGapY : laneYStart + 44;

    var callerLayout = [];
    var cursorRight = laneYStart;
    for (var bi = 0; bi < visibleCallers.length; bi++) {
      var callerMetaLink = declMetaLink(visibleCallers[bi]);
      var bh = nodeContentHeight(visibleCallers[bi], declSummary(visibleCallers[bi]), sideWidth, true, callerMetaLink ? callerMetaLink.label : "", false);
      callerLayout.push({ name: visibleCallers[bi], y: cursorRight, h: bh, collapsed: false, expandable: false, compactControl: false, metaLink: callerMetaLink });
      cursorRight += bh + laneGapY;
    }
    if (collapsedCallerCount > 0) {
      var collapsedCallerLabel = "+" + collapsedCallerCount + " more";
      var ccbh = nodeContentHeight(collapsedCallerLabel, "expand to show all", sideWidth, true, "", false);
      callerLayout.push({ name: collapsedCallerLabel, y: cursorRight, h: ccbh, collapsed: true, expandable: true });
      cursorRight += ccbh + laneGapY;
    }
    if (canCompactCallers) {
      var compactCallerLabel = "Return to Compact";
      var compactCallerH = nodeContentHeight(compactCallerLabel, "hide extra callers", sideWidth, true, "", false);
      callerLayout.push({ name: compactCallerLabel, y: cursorRight, h: compactCallerH, compactControl: true });
      cursorRight += compactCallerH + laneGapY;
    }
    var callerBottom = callerLayout.length ? cursorRight - laneGapY : laneYStart + 44;

    var centerMetaLink = declMetaLink(declName);
    var centerHeight = nodeContentHeight(declName, declSummary(declName), centerWidth, false, centerMetaLink ? centerMetaLink.label : "", false) + 14;
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

    function createDeclNode(name, x, y, w, h, color, subtitle, tooltip, active, onActivate, metaLink) {
      var className = "flow-node" + (active ? " active" : "");
      if (onActivate) className += " action";
      var declMod = declarationModuleOf(name);
      if (declMod && declMod !== moduleName) className += " cross-module";
      var interactive = Boolean(onActivate);
      var focusable = interactive || active;
      var ariaLabel = interactive ? "Select declaration " + name : name;
      return buildFlowNodeGroup(nodeLayer, className, focusable, ariaLabel, name, x, y, w, h, color, subtitle, tooltip, onActivate || null, metaLink || null);
    }

    var hasCallees = calls.length > 0;
    var hasCallers = calledBy.length > 0;

    if (hasCallees) laneLabel("Calls (outgoing)", leftX, 30, "#82f0b0");
    laneLabel("Selected declaration", centerX, centerY - 12, "#7c9cff");
    if (hasCallers) laneLabel("Called by (incoming)", rightX, 30, "#ffad42");

    if (!hasCallees && !hasCallers) {
      var emptyHint = createSvgNode("text", { x: centerX, y: centerY + centerHeight + 28, fill: "#8fa3bf", "font-size": "12", "class": "flow-lane-label" });
      var kind = declarationKindOf(declName);
      var hintMsg = kind
        ? "This " + kind + " has no detected internal call relationships."
        : "No internal call relationships detected for this declaration.";
      emptyHint.textContent = hintMsg;
      labelLayer.appendChild(emptyHint);
      var returnHint = createSvgNode("text", { x: centerX, y: centerY + centerHeight + 46, fill: "#6e7a91", "font-size": "11", "class": "flow-lane-label" });
      returnHint.textContent = "Use the breadcrumb above to return to module context.";
      labelLayer.appendChild(returnHint);
    }

    var center = createDeclNode(declName, centerX, centerY, centerWidth, centerHeight, "#7c9cff", declSummary(declName), declTooltip(declName, "Selected declaration"), true, null, centerMetaLink);

    function isDeclNavigable(name) {
      return Boolean(state.declarationGraph[name]) || Boolean(state.declarationReverseGraph[name]);
    }

    var callNodes = [];
    for (var i = 0; i < callLayout.length; i++) {
      var callItem = callLayout[i];
      if (callItem.expandable) {
        var expandCallTooltip = "Expand to show all " + (collapsedCallCount + visibleCalls.length) + " called declarations";
        callNodes.push(createDeclNode(callItem.name, leftX, callItem.y, sideWidth, callItem.h, "#82f0b0", "expand to show all", expandCallTooltip, false, expandDeclarationLanes, null));
      } else if (callItem.compactControl) {
        callNodes.push(createDeclNode(callItem.name, leftX, callItem.y, sideWidth, callItem.h, "#82f0b0", "hide extra calls", "Return to compact view", false, compactDeclarationLanes, null));
      } else {
        var callColor = declNodeColor(callItem.name);
        var callNavigable = isDeclNavigable(callItem.name);
        callNodes.push(createDeclNode(callItem.name, leftX, callItem.y, sideWidth, callItem.h, callColor, declSummary(callItem.name), declTooltip(callItem.name, "Called declaration"), false, callNavigable ? (function (n) { return function () { selectDeclaration(n); }; })(callItem.name) : null, callItem.metaLink || null));
      }
    }

    var callerNodes = [];
    for (var j = 0; j < callerLayout.length; j++) {
      var callerItem = callerLayout[j];
      if (callerItem.expandable) {
        var expandCallerTooltip = "Expand to show all " + (collapsedCallerCount + visibleCallers.length) + " caller declarations";
        callerNodes.push(createDeclNode(callerItem.name, rightX, callerItem.y, sideWidth, callerItem.h, "#ffad42", "expand to show all", expandCallerTooltip, false, expandDeclarationLanes, null));
      } else if (callerItem.compactControl) {
        callerNodes.push(createDeclNode(callerItem.name, rightX, callerItem.y, sideWidth, callerItem.h, "#ffad42", "hide extra callers", "Return to compact view", false, compactDeclarationLanes, null));
      } else {
        var callerColor = declNodeColor(callerItem.name);
        var callerNavigable = isDeclNavigable(callerItem.name);
        callerNodes.push(createDeclNode(callerItem.name, rightX, callerItem.y, sideWidth, callerItem.h, callerColor, declSummary(callerItem.name), declTooltip(callerItem.name, "Caller declaration"), false, callerNavigable ? (function (n) { return function () { selectDeclaration(n); }; })(callerItem.name) : null, callerItem.metaLink || null));
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

    wrap.appendChild(svg);

    renderFlowNodeInteriorMenu(moduleName);

    if (!applyFlowScrollTarget(wrap, declName, center.x, center.y, center.w, center.h)) {
      wrap.style.scrollBehavior = "auto";
      wrap.scrollLeft = previousScrollLeft;
      wrap.scrollTop = previousScrollTop;
      wrap.style.removeProperty("scroll-behavior");
    }
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
      return diff || a.base.localeCompare(b.base);
    });

    for (var j = 0; j < pairs.length; j++) if (pairs[j].invariantImportsOperations) totals.linked += 1;
    totals.pairs = pairs.length;

    state.theoremPairs = pairs;
    state.proofPairMap = Object.create(null);
    state.degreeMap = Object.create(null);
    ASSURANCE_CACHE = Object.create(null);
    for (var k = 0; k < pairs.length; k++) state.proofPairMap[pairs[k].base] = pairs[k];
    for (var m = 0; m < state.modules.length; m++) moduleDegree(state.modules[m]);
    updateMetric("files", state.files.length);
    updateMetric("leanModules", state.modules.length);
    updateMetric("importEdges", totals.importEdges);
    updateMetric("theorems", totals.theorems);
    updateMetric("proofPairs", totals.pairs);
    updateMetric("linkedPairs", totals.linked);
    updateMetric("commit", state.commitSha ? state.commitSha.slice(0, 7) : "-");
    updateMetric("generatedAt", formatGeneratedAt(state.generatedAt));

    /* Pre-warm assurance cache for all visible modules so the first render
       doesn't stall on assurance computation for each node.  This moves the
       cost to data-load time where the user is already waiting. */
    for (var warmIdx = 0; warmIdx < state.modules.length; warmIdx++) {
      assuranceForModule(state.modules[warmIdx]);
    }
  }

  function renderAll() {
    renderContextChooser();
    var wrap = DOM.flowchartWrap || document.getElementById("flowchart-wrap");
    if (state.flowContext === "declaration" && state.selectedDeclaration) {
      if (wrap) wrap.setAttribute("aria-label", "Declaration call graph for " + state.selectedDeclaration);
      renderDeclarationFlowchart();
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
            if (window.location.hash !== targetInfo.hash) history.pushState(null, "", targetInfo.hash);
          } else if (target && target.samePath && !target.hash) {
            event.preventDefault();
            safeScrollTo(0, "smooth");
            if (window.location.pathname !== target.path || window.location.search || window.location.hash) {
              history.replaceState(null, "", target.path);
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
      if (parsed.schema !== CACHE_SCHEMA_VERSION) return null;
      var ageMs = Math.max(0, Date.now() - Number(parsed.ts || 0));
      parsed.isFresh = ageMs <= CACHE_TTL_MS;
      parsed.ageMs = ageMs;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function setCache(data, commitSha) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        schema: CACHE_SCHEMA_VERSION,
        ts: Date.now(),
        commitSha: commitSha || "",
        data: data
      }));
    } catch (e) {}
  }

  function getLiveSyncMeta() {
    try {
      var raw = localStorage.getItem(LIVE_SYNC_META_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return {
        nextAllowedAt: Number(parsed.nextAllowedAt) || 0,
        lastCheckedCommit: parsed.lastCheckedCommit ? String(parsed.lastCheckedCommit) : ""
      };
    } catch (e) {
      return null;
    }
  }

  function setLiveSyncMeta(lastCheckedCommit) {
    var jitter = Math.floor(Math.random() * LIVE_SYNC_JITTER_MAX_MS);
    var nextAllowedAt = Date.now() + LIVE_SYNC_MIN_INTERVAL_MS + jitter;
    try {
      localStorage.setItem(LIVE_SYNC_META_KEY, JSON.stringify({
        nextAllowedAt: nextAllowedAt,
        lastCheckedCommit: lastCheckedCommit || ""
      }));
    } catch (e) {}
    return nextAllowedAt;
  }

  function remainingSyncCooldownMs() {
    var meta = getLiveSyncMeta();
    if (!meta || !meta.nextAllowedAt) return 0;
    return Math.max(0, meta.nextAllowedAt - Date.now());
  }

  function persistCurrentMapCache() {
    setCache({
      files: state.files,
      modules: state.modules,
      moduleMap: state.moduleMap,
      moduleMeta: state.moduleMeta,
      importsTo: state.importsTo,
      importsFrom: state.importsFrom,
      externalImportsFrom: state.externalImportsFrom,
      commitSha: state.commitSha,
      generatedAt: state.generatedAt
    }, state.commitSha);
  }

  function fetchLatestCommitSha() {
    return safeFetch(API + "/commits/" + REF, false).then(function (payload) {
      return payload && payload.sha ? String(payload.sha) : "";
    }).catch(function () {
      return "";
    });
  }

  function fetchLatestMapCommitSha() {
    var url = API + "/commits?sha=" + encodeURIComponent(REF) + "&path=" + encodeURIComponent(CODEBASE_MAP_PATH) + "&per_page=1";
    return safeFetch(url, false).then(function (payload) {
      if (!Array.isArray(payload) || !payload.length) return "";
      var commit = payload[0] || {};
      return commit.sha ? String(commit.sha) : "";
    }).catch(function () {
      return "";
    });
  }

  function isLeanModulePath(path) {
    return /^SeLe4n\/.*\.lean$/.test(path || "");
  }

  function moduleInventoryFromTree(tree) {
    var files = [];
    var leanFiles = [];
    var leanShasByPath = Object.create(null);

    for (var i = 0; i < tree.length; i++) {
      var entry = tree[i];
      if (!entry || entry.type !== "blob") continue;
      files.push(entry.path);
      if (isLeanModulePath(entry.path)) {
        leanFiles.push(entry.path);
        leanShasByPath[entry.path] = entry.sha || "";
      }
    }

    return { files: files, leanFiles: leanFiles, leanShasByPath: leanShasByPath };
  }

  function removeModuleState(moduleName) {
    delete state.moduleMeta[moduleName];
    delete state.importsFrom[moduleName];
    delete state.externalImportsFrom[moduleName];
    if (state.selectedModule === moduleName) state.selectedModule = null;
    if (state.interiorMenuModule === moduleName) {
      state.interiorMenuModule = "";
      state.interiorMenuQuery = "";
    }
  }

  function applyTreeInventory(inventory) {
    state.files = inventory.files.slice();
    state.modules = inventory.leanFiles.map(moduleFromPath);
    state.moduleMap = Object.create(null);
    for (var i = 0; i < state.modules.length; i++) state.moduleMap[state.modules[i]] = inventory.leanFiles[i];
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
      if (!/\./.test(candidate)) return "";
      if (/^(?:main|master|trunk|refs|heads)$/i.test(candidate)) return "";
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

      records.sort(function (a, b) { return a.name.localeCompare(b.name); });
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

    function normalizeFiles(files, moduleMap) {
      var list = Array.isArray(files) ? files : [];
      var out = [];
      var seen = Object.create(null);

      for (var i = 0; i < list.length; i++) {
        var path = String(list[i] || "").trim();
        if (!path || seen[path]) continue;
        seen[path] = true;
        out.push(path);
      }

      for (var moduleName in moduleMap) {
        if (!Object.prototype.hasOwnProperty.call(moduleMap, moduleName)) continue;
        var modulePath = String(moduleMap[moduleName] || "").trim();
        if (!modulePath || seen[modulePath]) continue;
        seen[modulePath] = true;
        out.push(modulePath);
      }

      out.sort();
      return out;
    }

    function normalizeModuleSymbols(rawSymbols) {
      var source = rawSymbols || {};
      var callGraph = Object.create(null);
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

    var mergedDeclarationGraph = Object.create(null);
    var mergedReverseGraph = Object.create(null);
    var declarationIndex = Object.create(null);
    for (var dgIdx = 0; dgIdx < moduleRecords.length; dgIdx++) {
      var dgModule = moduleRecords[dgIdx].name;
      var dgSymbols = normalizedModuleMeta[dgModule] && normalizedModuleMeta[dgModule].symbols;
      var dgCallGraph = dgSymbols && dgSymbols.callGraph ? dgSymbols.callGraph : Object.create(null);
      for (var dgKey in dgCallGraph) {
        if (!Object.prototype.hasOwnProperty.call(dgCallGraph, dgKey)) continue;
        mergedDeclarationGraph[dgKey] = { module: dgModule, calls: dgCallGraph[dgKey] };
        for (var dgCalledIdx = 0; dgCalledIdx < dgCallGraph[dgKey].length; dgCalledIdx++) {
          var calledTarget = dgCallGraph[dgKey][dgCalledIdx];
          if (!mergedReverseGraph[calledTarget]) mergedReverseGraph[calledTarget] = [];
          mergedReverseGraph[calledTarget].push(dgKey);
        }
      }
      // Build fast declaration→{module,kind,line} index from moduleMeta symbols
      var dgMeta = normalizedModuleMeta[dgModule];
      if (dgMeta && dgMeta.symbols && dgMeta.symbols.byKind) {
        var dgByKind = dgMeta.symbols.byKind;
        for (var dgKind in dgByKind) {
          if (!Object.prototype.hasOwnProperty.call(dgByKind, dgKind)) continue;
          var dgItems = dgByKind[dgKind];
          if (!Array.isArray(dgItems)) continue;
          for (var diIdx = 0; diIdx < dgItems.length; diIdx++) {
            var diEntry = dgItems[diIdx];
            if (diEntry && diEntry.name && !declarationIndex[diEntry.name]) {
              declarationIndex[diEntry.name] = { module: dgModule, kind: dgKind, line: diEntry.line || 0 };
            }
          }
        }
      }
    }

    return {
      files: normalizeFiles(data.files, normalizedModuleMap),
      modules: normalizedModules,
      moduleMap: normalizedModuleMap,
      moduleMeta: normalizedModuleMeta,
      importsTo: Object.create(null),
      importsFrom: normalizedImportsFrom,
      externalImportsFrom: normalizedExternalImportsFrom,
      declarationGraph: mergedDeclarationGraph,
      declarationReverseGraph: mergedReverseGraph,
      declarationIndex: declarationIndex,
      commitSha: data.commitSha ? String(data.commitSha) : "",
      generatedAt: data.generatedAt ? String(data.generatedAt) : ""
    };
  }

  function enrichSparseMapData(data, options) {
    if (!data || !Array.isArray(data.modules) || !data.modules.length) return Promise.resolve(data);

    var modules = data.modules.slice();
    var moduleLookup = Object.create(null);
    for (var i = 0; i < modules.length; i++) moduleLookup[modules[i]] = true;

    var totalEdges = 0;
    for (var j = 0; j < modules.length; j++) totalEdges += (data.importsFrom[modules[j]] || []).length;
    if (totalEdges > 0) return Promise.resolve(data);

    var opts = options && typeof options === "object" ? options : {};
    if (!opts.silent) setStatus("Canonical map missing import edges; deriving imports from Lean source files…", false);

    return runInPool(modules, function (moduleName) {
      var path = String((data.moduleMap && data.moduleMap[moduleName]) || "").trim();
      if (!path) return;
      var url = "https://raw.githubusercontent.com/" + REPO + "/" + REF + "/" + path;
      return safeFetch(url, true).then(function (sourceText) {
        var imports = [];
        var external = [];
        var seenIn = Object.create(null);
        var seenOut = Object.create(null);
        var tokens = extractImportTokens(sourceText);

        for (var idx = 0; idx < tokens.length; idx++) {
          var dep = tokens[idx];
          if (!dep || dep === moduleName) continue;
          if (moduleLookup[dep]) {
            if (seenIn[dep]) continue;
            seenIn[dep] = true;
            imports.push(dep);
          } else {
            if (seenOut[dep]) continue;
            seenOut[dep] = true;
            external.push(dep);
          }
        }

        data.importsFrom[moduleName] = imports;
        data.externalImportsFrom[moduleName] = external;

        var meta = data.moduleMeta[moduleName] || (data.moduleMeta[moduleName] = {
          layer: classifyLayer(moduleName),
          kind: moduleKind(moduleName),
          base: moduleBase(moduleName),
          theorems: 0,
          symbols: makeEmptyInteriorSymbols()
        });
        if (!(meta.theorems > 0)) meta.theorems = theoremCount(sourceText);
      }).catch(function () {});
    }).then(function () {
      return data;
    });
  }

  function fetchBundledMapData() {
    return safeFetch(DATA_ENDPOINT, false).then(normalizeMapData).catch(function () {
      return null;
    });
  }

  function normalizeCanonicalPayload(payload, fallbackGeneratedAt) {
    function extractCanonicalMapPayload(input) {
      if (!input || typeof input !== "object") return null;

      var candidates = [input];
      for (var key in input) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
        var value = input[key];
        if (!value || typeof value !== "object") continue;
        candidates.push(value);
      }

      var best = null;
      var bestCount = -1;
      for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        if (!Array.isArray(candidate.modules)) continue;
        var normalizedCandidate = normalizeMapData(candidate, { requireModulesArray: true });
        var moduleCount = normalizedCandidate && Array.isArray(normalizedCandidate.modules) ? normalizedCandidate.modules.length : 0;
        if (moduleCount <= bestCount) continue;
        best = candidate;
        bestCount = moduleCount;
      }

      return best;
    }

    var canonicalPayload = extractCanonicalMapPayload(payload);
    var normalized = normalizeMapData(canonicalPayload, { requireModulesArray: true });
    if (!normalized) throw new Error("Canonical map payload invalid");
    if (!normalized.generatedAt) normalized.generatedAt = fallbackGeneratedAt || new Date().toISOString();
    return normalized;
  }

  function fetchCanonicalMapDataFromRaw() {
    var cacheBust = "?t=" + Date.now();
    return safeFetch(CODEBASE_MAP_RAW + cacheBust, false).then(function (payload) {
      return normalizeCanonicalPayload(payload);
    });
  }

  function fetchCanonicalMapDataFromContentsApi() {
    var cacheBust = "?ref=" + encodeURIComponent(REF) + "&t=" + Date.now();
    return safeFetch(CODEBASE_MAP_API + cacheBust, false).then(function (payload) {
      if (!payload || payload.encoding !== "base64" || !payload.content) {
        throw new Error("Canonical map payload missing base64 content");
      }

      var decoded = decodeBlobBase64(payload.content);
      var parsed = JSON.parse(decoded);
      var normalized = normalizeCanonicalPayload(parsed);

      if (!normalized.commitSha && payload.sha) normalized.commitSha = String(payload.sha);
      return normalized;
    });
  }

  function fetchCanonicalMapData() {
    return fetchCanonicalMapDataFromRaw().catch(function () {
      return fetchCanonicalMapDataFromContentsApi();
    });
  }

  function timestampFromIsoString(value) {
    if (!value) return 0;
    var ts = Date.parse(String(value));
    return isNaN(ts) ? 0 : ts;
  }

  function chooseBestLocalData(cachedData, bundledData) {
    if (!cachedData) return bundledData;
    if (!bundledData) return cachedData;

    var cachedTs = timestampFromIsoString(cachedData.generatedAt);
    var bundledTs = timestampFromIsoString(bundledData.generatedAt);

    if (bundledTs > cachedTs) return bundledData;
    return cachedData;
  }

  function applyData(data) {
    /* Advance render epoch so any pending scheduled render from the previous
       data state is skipped — applyData calls renderAll() synchronously below,
       making the stale frame redundant. */
    renderEpoch += 1;
    state.files = data.files || [];
    state.modules = data.modules || [];
    state.moduleMap = data.moduleMap || Object.create(null);
    state.moduleMeta = data.moduleMeta || Object.create(null);
    state.importsTo = data.importsTo || Object.create(null);
    state.importsFrom = data.importsFrom || Object.create(null);
    state.externalImportsFrom = data.externalImportsFrom || Object.create(null);
    state.declarationGraph = data.declarationGraph || Object.create(null);
    state.declarationReverseGraph = data.declarationReverseGraph || Object.create(null);
    state.declarationIndex = data.declarationIndex || Object.create(null);
    invalidateDerivedCaches();
    state.contextList = [];
    state.commitSha = data.commitSha || "";
    state.generatedAt = data.generatedAt || "";
    LABEL_WRAP_CACHE.clear();
    rebuildImportsToIndex();
    buildSearchIndex();

    buildPairs();
    if (!state.selectedModule || !state.moduleMap[state.selectedModule]) state.selectedModule = state.modules[0] || null;
    if (state.flowContext === "declaration" && state.selectedDeclaration) {
      var resolvedModule = declarationModuleOf(state.selectedDeclaration);
      if (resolvedModule && state.moduleMap[resolvedModule]) {
        state.selectedDeclarationModule = resolvedModule;
        if (state.selectedModule !== resolvedModule) {
          state.selectedModule = resolvedModule;
          state.interiorMenuModule = resolvedModule;
        }
      } else if (!state.selectedDeclarationModule || !state.moduleMap[state.selectedDeclarationModule]) {
        state.flowContext = "module";
        state.selectedDeclaration = "";
        state.selectedDeclarationModule = "";
      }
    }
    renderAll();
  }

  function applyEmptyModule(moduleName) {
    state.importsFrom[moduleName] = [];
    state.externalImportsFrom[moduleName] = [];
    state.moduleMeta[moduleName] = {
      layer: classifyLayer(moduleName),
      kind: moduleKind(moduleName),
      base: moduleBase(moduleName),
      theorems: 0,
      symbols: makeEmptyInteriorSymbols(),
      symbolsLoaded: true
    };
  }

  function shouldFallbackFromComparePayload(payload) {
    if (!payload || typeof payload !== "object") return true;
    if (payload.status && payload.status !== "ahead") return true;
    if (payload.files === null || typeof payload.files === "undefined") return true;

    var files = Array.isArray(payload.files) ? payload.files : [];
    var total = Number(payload.total_files || files.length || 0);
    if (files.length >= COMPARE_FILES_TRUNCATION_LIMIT && total > files.length) return true;

    return false;
  }

  function fetchAndApplyIncrementalChanges(knownCommitSha, latestCommitSha, inventory) {
    var compareUrl = API + "/compare/" + encodeURIComponent(knownCommitSha) + "..." + encodeURIComponent(latestCommitSha);
    return safeFetch(compareUrl, false).then(function (payload) {
      if (shouldFallbackFromComparePayload(payload)) throw new Error("incremental-compare-unavailable");
      var changedPaths = Object.create(null);
      var removedPaths = Object.create(null);
      var files = payload && Array.isArray(payload.files) ? payload.files : [];

      for (var i = 0; i < files.length; i++) {
        var file = files[i] || {};
        var filename = String(file.filename || "");
        if (!isLeanModulePath(filename)) continue;

        if (file.status === "removed") {
          removedPaths[filename] = true;
          continue;
        }

        if (file.status === "renamed" && file.previous_filename && isLeanModulePath(file.previous_filename)) {
          removedPaths[String(file.previous_filename)] = true;
        }

        changedPaths[filename] = true;
      }

      applyTreeInventory(inventory);

      var allModules = state.modules.slice();
      var removedList = Object.keys(removedPaths);
      for (var r = 0; r < removedList.length; r++) {
        var removedPath = removedList[r];
        var removedModule = moduleFromPath(removedPath);
        if (!state.moduleMap[removedModule]) removeModuleState(removedModule);
      }

      for (var m = 0; m < allModules.length; m++) {
        var moduleName = allModules[m];
        if (!state.importsFrom[moduleName]) state.importsFrom[moduleName] = [];
        if (!state.externalImportsFrom[moduleName]) state.externalImportsFrom[moduleName] = [];
      }

      var changedLeanFiles = Object.keys(changedPaths);
      if (!changedLeanFiles.length) return;

      setStatus("Applying incremental module sync (" + changedLeanFiles.length + " changed files)…", false);
      return runInPool(changedLeanFiles, function (path) {
        var moduleName = moduleFromPath(path);
        var blobSha = inventory.leanShasByPath[path] || "";
        if (!blobSha) {
          applyEmptyModule(moduleName);
          return;
        }

        return safeFetch(API + "/git/blobs/" + blobSha, false).then(function (blob) {
          if (!blob || blob.encoding !== "base64" || !blob.content) {
            applyEmptyModule(moduleName);
            return;
          }
          parseModule(moduleName, decodeBlobBase64(blob.content));
        }).catch(function () {
          applyEmptyModule(moduleName);
        });
      });
    });
  }

  function fetchAndBuildData(cachedCommitSha) {
    setStatus("Checking latest repository commit…", false);

    return fetchLatestCommitSha().then(function (latestCommitSha) {
      var knownCommit = state.commitSha || cachedCommitSha || "";
      setLiveSyncMeta(latestCommitSha || knownCommit);

      if (knownCommit && latestCommitSha && knownCommit === latestCommitSha) {
        setStatus("Map is already synced to " + latestCommitSha.slice(0, 7) + ".", false);
        return;
      }

      var treeRef = latestCommitSha || REF;
      setStatus("Loading repository tree…", false);

      return safeFetch(API + "/git/trees/" + treeRef + "?recursive=1", false).then(function (payload) {
        var tree = payload && payload.tree ? payload.tree : [];
        var inventory = moduleInventoryFromTree(tree);
        var known = state.commitSha || cachedCommitSha || "";
        var canIncremental = Boolean(known && latestCommitSha && state.modules.length);

        if (!canIncremental) {
          state.moduleMeta = Object.create(null);
          state.importsTo = Object.create(null);
          state.importsFrom = Object.create(null);
          state.externalImportsFrom = Object.create(null);
          applyTreeInventory(inventory);
          invalidateDerivedCaches();
          state.contextList = [];
          buildSearchIndex();

          setStatus("Analyzing Lean modules and theorem declarations…", false);
          return runInPool(inventory.leanFiles, function (path) {
            var moduleName = moduleFromPath(path);
            var blobSha = inventory.leanShasByPath[path];
            if (!blobSha) {
              applyEmptyModule(moduleName);
              return;
            }

            return safeFetch(API + "/git/blobs/" + blobSha, false).then(function (blob) {
              if (!blob || blob.encoding !== "base64" || !blob.content) {
                applyEmptyModule(moduleName);
                return;
              }
              parseModule(moduleName, decodeBlobBase64(blob.content));
            }).catch(function () {
              applyEmptyModule(moduleName);
            });
          });
        }

        return fetchAndApplyIncrementalChanges(known, latestCommitSha, inventory).catch(function () {
          state.moduleMeta = Object.create(null);
          state.importsFrom = Object.create(null);
          state.externalImportsFrom = Object.create(null);
          applyTreeInventory(inventory);
          setStatus("Incremental sync unavailable; rebuilding module index…", false);
          return runInPool(inventory.leanFiles, function (path) {
            var moduleName = moduleFromPath(path);
            var blobSha = inventory.leanShasByPath[path];
            if (!blobSha) {
              applyEmptyModule(moduleName);
              return;
            }

            return safeFetch(API + "/git/blobs/" + blobSha, false).then(function (blob) {
              if (!blob || blob.encoding !== "base64" || !blob.content) {
                applyEmptyModule(moduleName);
                return;
              }
              parseModule(moduleName, decodeBlobBase64(blob.content));
            }).catch(function () {
              applyEmptyModule(moduleName);
            });
          });
        }).then(function () {
          invalidateDerivedCaches();
          state.contextList = [];
          buildSearchIndex();
        });
      }).then(function () {
          rebuildImportsToIndex();
          state.commitSha = latestCommitSha || "";
          state.generatedAt = new Date().toISOString();
          buildPairs();
          if (!state.selectedModule || !state.moduleMap[state.selectedModule]) state.selectedModule = state.modules[0] || null;
          scheduleRender();
          syncUrlState();
          var statusSuffix = state.commitSha ? " Synced commit " + state.commitSha.slice(0, 7) + "." : "";
          setStatus("Map ready. Integrated dependency/proof flow graph loaded." + statusSuffix, false);
          persistCurrentMapCache();
      });
    });
  }

  function syncFromCanonicalMap(cachedCommitSha, options) {
    var opts = options || {};
    var silentNoChange = Boolean(opts.silentNoChange);
    if (!silentNoChange) setStatus("Syncing canonical codebase map from docs/codebase_map.json…", false);

    return fetchCanonicalMapData().then(function (canonicalData) {
      var knownCommit = state.commitSha || cachedCommitSha || "";
      var canonicalCommit = canonicalData.commitSha || "";
      setLiveSyncMeta(canonicalCommit || knownCommit);

      if (knownCommit && canonicalCommit && knownCommit === canonicalCommit) {
        if (!silentNoChange) setStatus("Map is already synced to " + canonicalCommit.slice(0, 7) + ".", false);
        return null;
      }

      return enrichSparseMapData(canonicalData, { silent: silentNoChange });
    }).then(function (canonicalData) {
      if (!canonicalData) return;
      var canonicalCommit = canonicalData.commitSha || "";
      applyData(canonicalData);
      persistCurrentMapCache();
      var statusSuffix = canonicalCommit ? " Synced commit " + canonicalCommit.slice(0, 7) + "." : "";
      setStatus("Map ready. Canonical seLe4n codebase map loaded." + statusSuffix, false);
    }).catch(function () {
      return fetchAndBuildData(cachedCommitSha);
    });
  }

  function refreshMapDataWithPolicy(cachedCommitSha, hasLocalData, options) {
    var opts = options || {};
    var reason = String(opts.reason || "");
    var bypassCooldown = Boolean(opts.force || reason === "manual" || reason === "visible" || reason === "focus" || reason === "online");
    var cooldown = remainingSyncCooldownMs();

    if (reason === "poll" && hasLocalData) {
      var knownCommit = state.commitSha || cachedCommitSha || "";
      return fetchLatestMapCommitSha().then(function (latestMapCommitSha) {
        if (!latestMapCommitSha) {
          if (cooldown > 0 && !opts.force) return;
          return syncFromCanonicalMap(cachedCommitSha, { silentNoChange: true });
        }

        if (knownCommit && knownCommit === latestMapCommitSha) {
          setLiveSyncMeta(latestMapCommitSha);
          return;
        }

        return syncFromCanonicalMap(cachedCommitSha, { silentNoChange: true });
      });
    }

    if (hasLocalData && cooldown > 0 && !bypassCooldown) {
      if (!opts.silentCooldown) {
        var mins = Math.max(1, Math.ceil(cooldown / 60000));
        setStatus("Using local snapshot. Next live sync check in about " + mins + " min.", false);
      }
      return Promise.resolve();
    }

    return syncFromCanonicalMap(cachedCommitSha, { silentNoChange: reason === "poll" });
  }

  var liveSyncPollTimerId = 0;

  function setupLiveSyncPolling() {
    var inFlight = false;

    function trigger(reason) {
      if (inFlight) return;
      if (document.hidden && reason === "poll") return;
      inFlight = true;
      var knownCommit = state.commitSha || "";
      var hasLocalData = Boolean(state.modules && state.modules.length);
      refreshMapDataWithPolicy(knownCommit, hasLocalData, { silentCooldown: reason !== "manual", reason: reason }).finally(function () {
        inFlight = false;
      });
    }

    function queueNextPoll() {
      var jitter = Math.floor(Math.random() * 15000);
      liveSyncPollTimerId = window.setTimeout(function () {
        liveSyncPollTimerId = 0;
        trigger("poll");
        queueNextPoll();
      }, LIVE_SYNC_POLL_INTERVAL_MS + jitter);
    }

    queueNextPoll();

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) trigger("visible");
    });
    window.addEventListener("focus", function () { trigger("focus"); });
    window.addEventListener("online", function () { trigger("online"); });

    /* Clean up polling timer on page teardown to prevent orphaned timers */
    window.addEventListener("pagehide", function () {
      if (liveSyncPollTimerId) {
        window.clearTimeout(liveSyncPollTimerId);
        liveSyncPollTimerId = 0;
      }
    });
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

  function declarationSearchMatch(query) {
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
          }
          if (!bestMatch && itemLower.indexOf(declSuffixLower) === 0) {
            bestMatch = { module: moduleName, declaration: items[j].name, exact: false };
          }
          if (!bestMatch && itemLower.indexOf(declSuffixLower) !== -1) {
            bestMatch = { module: moduleName, declaration: items[j].name, exact: false };
          }
        }
      }
    }

    // Also check declarationIndex for declarations that may not appear in interior
    var declList = state.declarationSearchList || [];
    for (var di = 0; di < declList.length; di++) {
      var entry = declList[di];
      if (entry.module !== moduleName) continue;
      if (entry.nameLower === declSuffixLower) {
        return { module: moduleName, declaration: entry.name, exact: true };
      }
      if (!bestMatch && entry.nameLower.indexOf(declSuffixLower) === 0) {
        bestMatch = { module: moduleName, declaration: entry.name, exact: false };
      }
    }

    return bestMatch;
  }

  function declarationSearchMatches(query, limit) {
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
      return a.declaration.localeCompare(b.declaration);
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
      return a.name.localeCompare(b.name);
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
        item.textContent = declSuggestion.declaration + " — declaration in " + declSuggestion.module;
        item.className += " module-search-option-decl";
      } else {
        item.setAttribute("data-module", name);
        item.textContent = name + " — " + (state.moduleMap[name] || "");
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

        var direct = sanitizeModuleName(value);
        if (direct && state.moduleMap[direct]) return direct;

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
        state.searchDeclSuggestions = declSuggestions;
        if (matches.length) openModuleSearchOptions(matches);
        else closeModuleSearchOptions();
      }

      var searchDebounceTimer = null;
      search.addEventListener("input", function () {
        setSearchFeedback("", false);
        if (typeof search.setCustomValidity === "function") search.setCustomValidity("");
        if (chooseExactFromCurrentValue()) return;
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
      search.addEventListener("compositionend", chooseExactFromCurrentValue);
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

        /* Reset selected module to the first module (same default as initial data load) */
        var firstModule = state.modules[0] || null;
        state.selectedModule = firstModule;

        /* Clear interior menu state */
        state.interiorMenuModule = "";
        state.interiorMenuQuery = "";
        state.interiorMenuSelections = { object: "", extension: "", contextInit: "" };

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
    window.history.replaceState(null, "", target);
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


  function boot() {
    cacheDomElements();
    setupTheme();
    if (typeof window.sele4nSetupHeaderNav !== "function") setupNav();
    hardenExternalLinks();
    readUrlState();
    setupFilters();
    setupKeyboardNavigation();
    setupFlowchartResize();
    setupLiveSyncPolling();
    hydrateFilterControls();

    var cached = getCache();
    var cachedData = cached && cached.data ? normalizeMapData(cached.data) : null;

    fetchBundledMapData().then(function (bundledData) {
      var localData = chooseBestLocalData(cachedData, bundledData);
      if (!localData) return;

      applyData(localData);
      if (localData === cachedData && cached && !cached.isFresh) {
        var minutes = Math.max(1, Math.round((cached.ageMs || 0) / 60000));
        setStatus("Loaded latest local snapshot (" + minutes + " min old) while refreshing…", false);
      } else if (localData === cachedData) {
        setStatus("Showing cached map while refreshing…", false);
      } else {
        setStatus("Loaded bundled map snapshot while checking live sync…", false);
      }
    }).finally(function () {
      var cachedCommitSha = cached && cached.commitSha ? String(cached.commitSha) : "";
      var hasLocalData = Boolean(state.modules && state.modules.length);
      refreshMapDataWithPolicy(cachedCommitSha, hasLocalData, { force: true, reason: "boot" }).then(function () {
        if (state.modules && state.modules.length) {
          hardenExternalLinks();
        }
      }).catch(function (error) {
        var message = error && error.message ? error.message : "Unknown error";
        /* Provide actionable guidance depending on the error type */
        var isRateLimit = /rate.limit|429|403/i.test(message);
        if (!hasLocalData) {
          setStatus(isRateLimit
            ? "GitHub API rate limit reached. Refresh later to load the map."
            : "Unable to load codebase map. " + message, true);
        } else {
          setStatus(isRateLimit
            ? "Live refresh rate-limited; showing cached data."
            : "Refresh failed; showing cached data. " + message, true);
        }
      });
    });
  }

  if (window && window.__SELE4N_MAP_DISABLE_BOOT__) {
    window.__SELE4N_MAP_TEST_HOOKS__ = {
      normalizeMapData: normalizeMapData,
      normalizeCanonicalPayload: normalizeCanonicalPayload,
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
      declarationModuleOf: declarationModuleOf,
      declarationKindOf: declarationKindOf,
      declarationLineOf: declarationLineOf,
      declarationSourceHref: declarationSourceHref,
      declarationSearchMatch: declarationSearchMatch,
      declarationSearchMatches: declarationSearchMatches,
      moduleSearchMatches: moduleSearchMatches,
      buildSearchIndex: buildSearchIndex,
      declarationLaneCollapseThreshold: function () { return 12; },
      declarationLaneVisibleLimit: function () { return 10; },
      objectDeclarationCount: objectDeclarationCount,
      extensionDeclarationCount: extensionDeclarationCount,
      verifiableSurfaceArea: verifiableSurfaceArea,
      assuranceForModule: assuranceForModule,
      relatedProofModules: relatedProofModules,
      findNearestLinkedPath: findNearestLinkedPath,
      buildPairs: buildPairs,
      applyTestState: function (patch) {
        if (patch.declarationGraph) state.declarationGraph = patch.declarationGraph;
        if (patch.declarationReverseGraph) state.declarationReverseGraph = patch.declarationReverseGraph;
        if (patch.declarationIndex) state.declarationIndex = patch.declarationIndex;
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
        // Rebuild declarationIndex from moduleMeta when moduleMeta is patched
        if (patch.moduleMeta && !patch.declarationIndex) {
          var idx = Object.create(null);
          for (var mod in state.moduleMeta) {
            if (!Object.prototype.hasOwnProperty.call(state.moduleMeta, mod)) continue;
            var meta = state.moduleMeta[mod];
            if (!meta || !meta.symbols || !meta.symbols.byKind) continue;
            var byKind = meta.symbols.byKind;
            for (var kind in byKind) {
              if (!Object.prototype.hasOwnProperty.call(byKind, kind)) continue;
              var items = byKind[kind];
              if (!Array.isArray(items)) continue;
              for (var ii = 0; ii < items.length; ii++) {
                if (items[ii] && items[ii].name && !idx[items[ii].name]) {
                  idx[items[ii].name] = { module: mod, kind: kind, line: items[ii].line || 0 };
                }
              }
            }
          }
          state.declarationIndex = idx;
        }
      }
    };
    return;
  }

  boot();
})();
