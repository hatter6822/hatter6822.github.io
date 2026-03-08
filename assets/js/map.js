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
  var ASSURANCE_CACHE = Object.create(null);

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
    constants: "#f7b0ff",
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
      if (!res.ok) throw new Error("HTTP " + res.status);
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
    var node = document.getElementById("module-search-feedback");
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

  function interiorKindColor(kind) {
    return INTERIOR_KIND_COLOR_MAP[String(kind || "")] || "#8fa3bf";
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

    for (var i = 0; i < kinds.length; i++) {
      seenByKind[kinds[i]] = Object.create(null);
      byKind[kinds[i]] = [];
    }

    var match;
    while ((match = declarationPattern.exec(sourceText)) !== null) {
      var kind = String(match[1] || "").trim();
      if (!kind || !Object.prototype.hasOwnProperty.call(byKind, kind)) continue;
      var line = declarationLineFromMatch(match, lineNumberForIndex);
      var rawName = normalizeSymbolName(match[2]);
      var name = rawName || "<" + kind + "@L" + line + ">";
      if (seenByKind[kind][name]) continue;
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

  function assuranceForModule(name) {
    if (ASSURANCE_CACHE[name]) return ASSURANCE_CACHE[name];

    var pair = findProofPair(name);
    var degree = moduleDegree(name);
    var result;

    if (pair && pair.invariantImportsOperations) {
      result = {
        level: "linked",
        label: "Linked proof chain",
        detail: "Operations and Invariant modules are connected; obligations can be traced from transitions to safety claims.",
        score: degree.score + pair.operationsTheorems + pair.invariantTheorems
      };
    } else if (pair) {
      result = {
        level: "partial",
        label: "Partial proof context",
        detail: "A proof pair exists but is not explicitly linked by imports; review assumptions before reusing results.",
        score: degree.score
      };
    } else if (degree.theorems > 0) {
      result = {
        level: "local",
        label: "Local theorem coverage",
        detail: "This module declares theorems but has no Operations/Invariant pair mapping.",
        score: degree.score
      };
    } else {
      result = {
        level: "none",
        label: "No explicit proof evidence",
        detail: "No theorem declarations or proof-pair mapping detected for this module.",
        score: degree.score
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
      { label: "Selected declaration", color: "#7c9cff" },
      { label: "Calls (outgoing)", color: "#82f0b0" },
      { label: "Called by (incoming)", color: "#ffad42" },
      { label: "Color = declaration kind", color: "#8fa3bf" }
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
    if (width <= 640) result = 900;
    else if (width <= 900) result = 980;
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
    var picker = document.getElementById("module-search");
    if (!picker) return;

    var list = contextList();
    updateModuleResults(list.length);

    if (list.length && list.indexOf(state.selectedModule) === -1) {
      state.selectedModule = list[0];
      syncUrlState();
    }

    var label = document.querySelector('label[for="module-search"]');
    var inDeclContext = state.flowContext === "declaration" && state.selectedDeclaration;

    if (!list.length) {
      picker.value = "";
      picker.placeholder = "No modules matched current filters";
      if (label) label.textContent = "Current module context";
      closeModuleSearchOptions();
      return;
    }

    if (inDeclContext) {
      picker.placeholder = "Type module/path to switch context";
      if (label) label.textContent = "Current declaration context";
      if (document.activeElement !== picker) {
        picker.value = state.selectedModule + " \u203A " + state.selectedDeclaration;
      }
    } else {
      picker.placeholder = "Type module/path to switch context";
      if (label) label.textContent = "Current module context";
      if (state.selectedModule && document.activeElement !== picker) picker.value = state.selectedModule;
    }
  }


  function flowLegendItems() {
    return [
      { label: "Selected module", color: "#7c9cff" },
      { label: "Imports used by selected", color: "#35c98f" },
      { label: "Modules impacted by selected", color: "#ffad42" },
      { label: "Proof pair relation", color: "#d37cff" },
      { label: "Nearest linked-proof path", color: "#6de2ff" },
      { label: "External dependency", color: "#b9c0d0" },
      { label: "Node tint = assurance level", color: "#8fa3bf" }
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
    var menu = document.getElementById("flow-node-interior-menu");
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

    menu.appendChild(grid);
  }

  function wrapLabelLines(text, width, minChars) {
    if (!text) return [];
    var cacheKey = String(text) + "\u0000" + String(width || 180) + "\u0000" + String(minChars || 10);
    if (LABEL_WRAP_CACHE.has(cacheKey)) return LABEL_WRAP_CACHE.get(cacheKey).slice();

    var maxChars = Math.max(minChars || 10, Math.floor((width || 180) / 6.6));
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
      var iter = LABEL_WRAP_CACHE.keys();
      var oldest = iter.next();
      if (!oldest.done && oldest.value !== undefined) LABEL_WRAP_CACHE.delete(oldest.value);
    }
    LABEL_WRAP_CACHE.set(cacheKey, lines.slice());

    return lines;
  }

  function nodeContentHeight(name, subtitle, width, compactHint, metaLinkLabel) {
    var titleLines = wrapLabelLines(name, width - 18, compactHint ? 14 : 12);
    var subtitleLines = subtitle ? wrapLabelLines(subtitle, width - 18, 14) : [];
    var linkLines = metaLinkLabel ? wrapLabelLines(metaLinkLabel, width - 18, 14) : [];
    var titleLineHeight = 13;
    var subtitleLineHeight = 12;
    var topPad = compactHint ? 8 : 10;
    var bottomPad = 8;
    var gap = (subtitleLines.length || linkLines.length) ? 5 : 0;
    var textHeight = titleLines.length * titleLineHeight + (subtitleLines.length + linkLines.length) * subtitleLineHeight + gap;
    var minHeight = compactHint ? 34 : 44;
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

  function createFlowSvg(flowWidth, flowHeight, ariaLabel) {
    var svg = createSvgNode("svg", {
      "class": "flowchart-svg",
      "viewBox": "0 0 " + flowWidth + " " + flowHeight,
      "role": "img",
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

    return { svg: svg, edgeLayer: edgeLayer, nodeLayer: nodeLayer, labelLayer: labelLayer };
  }

  function createFlowLegend(items, ariaLabel) {
    var legend = document.createElement("div");
    legend.className = "flowchart-legend flowchart-legend-corner";
    legend.setAttribute("role", "list");
    legend.setAttribute("aria-label", ariaLabel);
    for (var i = 0; i < items.length; i++) {
      var chip = document.createElement("span");
      chip.className = "legend-item";
      chip.setAttribute("role", "listitem");
      var swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.setAttribute("aria-hidden", "true");
      swatch.style.backgroundColor = items[i].color;
      chip.appendChild(swatch);
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
    var previousBehavior = wrap.style.scrollBehavior;
    wrap.style.scrollBehavior = "auto";
    wrap.scrollLeft = Math.min(maxScrollLeft, targetScrollLeft);
    wrap.scrollTop = Math.min(maxScrollTop, targetScrollTop);
    wrap.style.scrollBehavior = previousBehavior;
    state.flowScrollTarget = "";
    return true;
  }

  function buildFlowNodeGroup(nodeLayer, className, focusable, ariaLabel, name, x, y, w, h, color, subtitle, tooltip, onActivate, metaLink) {
    var group = createSvgNode("g", { "class": className, tabindex: focusable ? "0" : "-1", role: onActivate ? "button" : "img", "aria-label": ariaLabel });
    if (focusable) group.setAttribute("focusable", "true");

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
      var subtitleStartY = y + 22 + Math.max(1, titleLines.length) * 13 + 3;
      var meta = createSvgNode("text", { x: x + 10, y: subtitleStartY, "class": "flow-meta" });
      for (var mm = 0; mm < subtitleLines.length; mm++) {
        var metaSpan = createSvgNode("tspan", { x: x + 10, dy: mm === 0 ? "0" : "12" });
        metaSpan.textContent = subtitleLines[mm];
        meta.appendChild(metaSpan);
      }
      if (metaLink && metaLink.href && metaLink.label) {
        var link = createSvgNode("a", { href: metaLink.href, target: "_blank", rel: "noopener noreferrer", "aria-label": metaLink.title || ("Open source for " + name) });
        var linkSpan = createSvgNode("tspan", { x: x + 10, dy: subtitleLines.length ? "12" : "0", "class": "flow-meta-link" });
        linkSpan.textContent = metaLink.label;
        link.appendChild(linkSpan);
        meta.appendChild(link);
      }
      group.appendChild(meta);
    }

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
    var wrap = document.getElementById("flowchart-wrap");
    var wrapWidth = Math.max(0, ((wrap && wrap.clientWidth) || 0) - 8);
    var flowWidth = Math.max(minimumFlowWidth(), wrapWidth || 0);
    var framePad = 34;
    var laneGap = 24;
    var centerWidth = Math.min(360, Math.max(300, Math.floor(flowWidth * 0.27)));
    var sideWidth = Math.min(360, Math.max(240, Math.floor((flowWidth - framePad * 2 - centerWidth - laneGap * 2) / 2)));
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
      laneYStart: 62,
      laneGapY: 10
    };
  }

  function renderFlowchart() {
    var wrap = document.getElementById("flowchart-wrap");
    if (!wrap) return;
    var shouldPreserveScroll = !prefersCompactViewport() && !state.flowScrollTarget;
    var previousScrollLeft = shouldPreserveScroll ? wrap.scrollLeft : 0;
    var previousScrollTop = shouldPreserveScroll ? wrap.scrollTop : 0;
    wrap.innerHTML = "";

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
      return "decl " + interior.total + " · thm " + ctx.degree.theorems + " · in " + ctx.degree.incoming + " · out " + ctx.degree.outgoing;
    }

    function nodeTooltip(name, roleLabel) {
      if (!state.moduleMap[name]) return roleLabel + ": " + name;
      var ctx = contextFor(name);
      var interior = interiorFor(name);
      var topKinds = allInteriorKinds().map(function (kind) { return { kind: kind, count: (interior.byKind[kind] || []).length }; }).filter(function (item) { return item.count > 0; }).sort(function (a, b) { return b.count - a.count; }).slice(0, 3);
      var kindPreview = topKinds.map(function (item) { return item.kind + "=" + item.count; }).join(", ");
      return roleLabel + "\n" + name + "\npath: " + ctx.path + "\ntheorems: " + ctx.degree.theorems + " | declarations: " + interior.total + " | fan-in: " + ctx.degree.incoming + " | fan-out: " + ctx.degree.outgoing + "\nactive kinds: " + (kindPreview || "none") + "\nassurance: " + ctx.assurance.label;
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

    var centerHeight = nodeContentHeight(selected, moduleSummary(selected), centerWidth, false, "") + 14;
    var centerY = Math.max(170, laneYStart + Math.floor((Math.max(importLayout.bottom, importerLayout.bottom) - laneYStart - centerHeight) / 2));
    var centerBottom = centerY + centerHeight;

    var lowerSectionTop = Math.max(laneBottom + 54, centerBottom + 54);
    var proofStartY = lowerSectionTop;
    var proofBottom = proofStartY;
    var proofHeights = [];
    for (var pr = 0; pr < proofRelated.length; pr++) {
      var prH = nodeContentHeight(proofRelated[pr], moduleSummary(proofRelated[pr]), centerWidth, true, "");
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
        var pathHeight = nodeContentHeight(pathName, moduleSummary(pathName), pathNodeWidth, true, "");
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
        var exH = nodeContentHeight(external[ex], "", externalWidth, true, "");
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
    var effectiveBottom = hasExternalSection ? externalBottom : pathBlockBottom;
    var flowHeight = Math.max(620, effectiveBottom + (hasExternalSection ? 68 : 40));

    wrap.appendChild(createFlowLegend(flowLegendItems(), "Flow chart legend"));

    var flowSvg = createFlowSvg(flowWidth, flowHeight, "Flow chart for selected module interactions and proof links: " + selected + ", imports " + allImports.length + ", impacted modules " + allImporters.length + ", proof neighbors " + proofRelated.length);
    var svg = flowSvg.svg;
    var edgeLayer = flowSvg.edgeLayer;
    var nodeLayer = flowSvg.nodeLayer;
    var labelLayer = flowSvg.labelLayer;

    function laneLabel(text, x, y, color) {
      flowLaneLabel(labelLayer, text, x, y, color);
    }

    function createNode(name, x, y, w, h, color, subtitle, tooltip, active, isStatic, assuranceLevel, onActivate) {
      var className = "flow-node" + (active ? " active" : "") + (isStatic ? " static" : "");
      if (onActivate) className += " action";
      if (assuranceLevel && !isStatic) className += " assurance-" + assuranceLevel;
      var interactive = !isStatic || Boolean(onActivate);
      var ariaLabel = interactive ? (onActivate ? name : ("Select module " + name)) : name;
      var activator = interactive ? (onActivate || function () { selectModule(name, false); }) : null;
      return buildFlowNodeGroup(nodeLayer, className, interactive, ariaLabel, name, x, y, w, h, color, subtitle, tooltip, activator, null);
    }

    if (laneLabels.imports) laneLabel("Imports used by selected", leftX, 30, "#35c98f");
    if (laneLabels.selected) laneLabel("Selected module context", centerX, centerY - 12, "#7c9cff");
    if (laneLabels.impacted) laneLabel("Modules impacted by selected", rightX, 30, "#ffad42");

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

    var importSpread = Math.min(52, Math.max(14, importNodes.length * 2));
    var importerSpread = Math.min(52, Math.max(14, importerNodes.length * 2));
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
        var proofNode = createNode(proofRelated[n], centerX, proofY, centerWidth, proofHeights[n], "#d37cff", moduleSummary(proofRelated[n]), nodeTooltip(proofRelated[n], "Proof-pair neighbor"), false, false, contextFor(proofRelated[n]).assurance.level);
        drawFlowEdge(edgeLayer, center, proofNode, "#d37cff", true, { rank: n, total: proofRelated.length, spread: 18 });
        proofY += proofHeights[n] + 8;
      }
    }

    if (linkedPath.length > 1) {
      if (laneLabels.linkedPath) laneLabel("Nearest linked-proof path (radius " + state.impactRadius + ")", Math.max(framePad, centerX - 180), pathStartY - 14, "#6de2ff");
      var previousNode = center;
      for (var q = 0; q < pathItems.length; q++) {
        var pathItem = pathItems[q];
        var pathNode = createNode(pathItem.name, pathItem.x, pathItem.y, pathNodeWidth, pathItem.h, "#6de2ff", moduleSummary(pathItem.name), nodeTooltip(pathItem.name, "Linked-proof path step " + (q + 1)), false, false, contextFor(pathItem.name).assurance.level);
        drawFlowEdge(edgeLayer, previousNode, pathNode, "#6de2ff", true, { rank: q, total: Math.max(1, pathItems.length), spread: 12 });
        previousNode = pathNode;
      }
    }

    if (laneLabels.external) {
      laneLabel("External imports", leftX, externalStartY - 10, "#b9c0d0");
      for (var z = 0; z < externalItems.length; z++) {
        var externalItem = externalItems[z];
        createNode(externalItem.name, externalItem.x, externalItem.y, externalWidth, externalItem.h, "#b9c0d0", "", "", false, true, "");
      }
    }

    wrap.appendChild(svg);

    renderFlowNodeInteriorMenu(selected);

    if (!applyFlowScrollTarget(wrap, selected, center.x, center.y, center.w, center.h)) {
      var prevBehavior = wrap.style.scrollBehavior;
      wrap.style.scrollBehavior = "auto";
      wrap.scrollLeft = previousScrollLeft;
      wrap.scrollTop = previousScrollTop;
      wrap.style.scrollBehavior = prevBehavior;
    }
  }

  function renderDeclarationFlowchart() {
    var wrap = document.getElementById("flowchart-wrap");
    if (!wrap) return;
    var shouldPreserveScroll = !prefersCompactViewport() && !state.flowScrollTarget;
    var previousScrollLeft = shouldPreserveScroll ? wrap.scrollLeft : 0;
    var previousScrollTop = shouldPreserveScroll ? wrap.scrollTop : 0;
    wrap.innerHTML = "";

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
      var parts = [];
      if (kind) parts.push(symbolKindLabel(kind));
      if (mod) parts.push("in " + mod);
      return parts.join(" · ") || "declaration";
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
      return kind ? (INTERIOR_KIND_COLOR_MAP[kind] || "#8fa3bf") : "#8fa3bf";
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
      var ch = nodeContentHeight(visibleCalls[ci], declSummary(visibleCalls[ci]), sideWidth, true, callMetaLink ? callMetaLink.label : "");
      callLayout.push({ name: visibleCalls[ci], y: cursorLeft, h: ch, collapsed: false, expandable: false, compactControl: false, metaLink: callMetaLink });
      cursorLeft += ch + laneGapY;
    }
    if (collapsedCallCount > 0) {
      var collapsedCallLabel = "+" + collapsedCallCount + " more";
      var cch = nodeContentHeight(collapsedCallLabel, "expand to show all", sideWidth, true);
      callLayout.push({ name: collapsedCallLabel, y: cursorLeft, h: cch, collapsed: true, expandable: true });
      cursorLeft += cch + laneGapY;
    }
    if (canCompactCalls) {
      var compactCallLabel = "Return to Compact";
      var compactCallH = nodeContentHeight(compactCallLabel, "hide extra calls", sideWidth, true);
      callLayout.push({ name: compactCallLabel, y: cursorLeft, h: compactCallH, compactControl: true });
      cursorLeft += compactCallH + laneGapY;
    }
    var callBottom = callLayout.length ? cursorLeft - laneGapY : laneYStart + 44;

    var callerLayout = [];
    var cursorRight = laneYStart;
    for (var bi = 0; bi < visibleCallers.length; bi++) {
      var callerMetaLink = declMetaLink(visibleCallers[bi]);
      var bh = nodeContentHeight(visibleCallers[bi], declSummary(visibleCallers[bi]), sideWidth, true, callerMetaLink ? callerMetaLink.label : "");
      callerLayout.push({ name: visibleCallers[bi], y: cursorRight, h: bh, collapsed: false, expandable: false, compactControl: false, metaLink: callerMetaLink });
      cursorRight += bh + laneGapY;
    }
    if (collapsedCallerCount > 0) {
      var collapsedCallerLabel = "+" + collapsedCallerCount + " more";
      var ccbh = nodeContentHeight(collapsedCallerLabel, "expand to show all", sideWidth, true);
      callerLayout.push({ name: collapsedCallerLabel, y: cursorRight, h: ccbh, collapsed: true, expandable: true });
      cursorRight += ccbh + laneGapY;
    }
    if (canCompactCallers) {
      var compactCallerLabel = "Return to Compact";
      var compactCallerH = nodeContentHeight(compactCallerLabel, "hide extra callers", sideWidth, true);
      callerLayout.push({ name: compactCallerLabel, y: cursorRight, h: compactCallerH, compactControl: true });
      cursorRight += compactCallerH + laneGapY;
    }
    var callerBottom = callerLayout.length ? cursorRight - laneGapY : laneYStart + 44;

    var centerMetaLink = declMetaLink(declName);
    var centerHeight = nodeContentHeight(declName, declSummary(declName), centerWidth, false, centerMetaLink ? centerMetaLink.label : "") + 14;
    var centerY = Math.max(170, laneYStart + Math.floor((Math.max(callBottom, callerBottom) - laneYStart - centerHeight) / 2));
    var flowHeight = Math.max(620, Math.max(callBottom, callerBottom, centerY + centerHeight) + 68);

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
      emptyHint.textContent = "No internal call relationships detected for this declaration.";
      labelLayer.appendChild(emptyHint);
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
    var callSpread = Math.min(52, Math.max(14, callEdgeCount * 2));
    var callerSpread = Math.min(52, Math.max(14, callerEdgeCount * 2));
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
      var prevBehavior = wrap.style.scrollBehavior;
      wrap.style.scrollBehavior = "auto";
      wrap.scrollLeft = previousScrollLeft;
      wrap.scrollTop = previousScrollTop;
      wrap.style.scrollBehavior = prevBehavior;
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
  }

  function renderAll() {
    renderContextChooser();
    var wrap = document.getElementById("flowchart-wrap");
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
      window.setTimeout(function () {
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
    var search = document.getElementById("module-search");
    var options = document.getElementById("module-search-options");
    if (!options) return;
    options.hidden = true;
    options.innerHTML = "";
    state.searchVisibleOptions = [];
    state.searchActiveOption = -1;
    if (search) {
      search.setAttribute("aria-expanded", "false");
      search.removeAttribute("aria-activedescendant");
    }
  }

  function openModuleSearchOptions(matches) {
    var search = document.getElementById("module-search");
    var options = document.getElementById("module-search-options");
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
    var search = document.getElementById("module-search");
    var options = document.getElementById("module-search-options");
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
    var search = document.getElementById("module-search");
    var options = document.getElementById("module-search-options");
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

      search.addEventListener("input", function () {
        setSearchFeedback("", false);
        if (typeof search.setCustomValidity === "function") search.setCustomValidity("");
        if (!chooseExactFromCurrentValue()) refreshSuggestions();
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
        if (search && state.selectedModule) search.value = state.selectedModule;
        setSearchFeedback("", false);
        if (search && typeof search.setCustomValidity === "function") search.setCustomValidity("");
        closeModuleSearchOptions();
        selectedDetail = "compact";
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
    var search = document.getElementById("module-search");
    if (search && state.selectedModule) search.value = state.selectedModule;
    updateDetailPillState(detailLevelFromState());
    setSearchFeedback("", false);
  }

  function setupKeyboardNavigation() {
    document.addEventListener("keydown", function (event) {
      var target = event.target;
      if (isTypingTarget(target)) return;

      if (event.isComposing) return;

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
      refreshMapDataWithPolicy(cachedCommitSha, hasLocalData, { force: true, reason: "boot" }).catch(function (error) {
        var message = error && error.message ? error.message : "Unknown error";
        if (!hasLocalData) setStatus("Unable to load codebase map. " + message, true);
        else setStatus("Refresh failed; showing cached data. " + message, true);
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
