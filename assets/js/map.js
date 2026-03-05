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
  var INTERIOR_KIND_GROUP_ORDER = ["object", "extension", "contextInit"];
  var INTERIOR_KIND_GROUP_LABELS = {
    object: "Objects",
    extension: "Extensions",
    contextInit: "Contexts/Inits"
  };
  var INTERIOR_KIND_ALL_VALUE = "__all__";
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
    neighborLimit: 12, impactRadius: 2, proofLinkedOnly: false,
    flowShowAll: false, contextListKey: "", contextList: [],
    contextOptionsKey: "", searchIndex: Object.create(null),
    filteredModulesKey: "", filteredModulesList: [], filteredModulesValid: false,
    contextListValid: false,
    interiorMenuModule: "",
    interiorMenuQuery: "",
    interiorMenuSelections: { object: "", extension: "", contextInit: "" },
    commitSha: "",
    generatedAt: "",
    flowScrollTarget: ""
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
    var items = [];

    if (selectedKind === INTERIOR_KIND_ALL_VALUE) {
      for (var i = 0; i < groupKinds.length; i++) {
        var kindItems = (interior.byKind || {})[groupKinds[i]] || [];
        for (var j = 0; j < kindItems.length; j++) items.push(kindItems[j]);
      }
    } else {
      items = ((interior.byKind || {})[selectedKind] || []).slice();
    }

    if (!q) return items;
    return items.filter(function (entry) { return entry.name.toLowerCase().indexOf(q) !== -1; });
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

  function minimumFlowWidth() {
    var width = window.innerWidth || 1200;
    if (width <= 640) return 900;
    if (width <= 900) return 980;
    return 1180;
  }

  function selectModule(name, preserveScroll) {
    if (!name || !state.moduleMap[name]) return;
    if (state.selectedModule === name) {
      renderFlowNodeInteriorMenu(name);
      return;
    }
    state.selectedModule = name;
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
    var options = document.getElementById("context-options");
    if (!picker || !options) return;

    var list = contextList();
    updateModuleResults(list.length);

    if (list.length && list.indexOf(state.selectedModule) === -1) {
      state.selectedModule = list[0];
      syncUrlState();
    }

    var signature = state.contextListKey + "::" + list.join("\u001f");
    if (signature !== state.contextOptionsKey) {
      options.innerHTML = "";
      var fragment = document.createDocumentFragment();
      for (var i = 0; i < list.length; i++) {
        var name = list[i];
        var opt = document.createElement("option");
        opt.value = name;
        opt.label = (state.moduleMap[name] || "") + " · score " + moduleDegree(name).score;
        fragment.appendChild(opt);
      }
      options.appendChild(fragment);
      state.contextOptionsKey = signature;
    }

    if (!list.length) {
      picker.value = "";
      picker.placeholder = "No modules matched current filters";
      return;
    }

    picker.placeholder = "Type module/path to switch context";

    if (state.selectedModule && document.activeElement !== picker) picker.value = state.selectedModule;
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

    var header = document.createElement("div");
    header.className = "interior-menu-header";
    header.innerHTML = "<h3 class=\"interior-menu-title\"></h3><span class=\"interior-menu-count\"></span>";
    header.children[0].textContent = "Interior code for " + selected;
    header.children[1].textContent = interior.total + " declarations across " + allInteriorKinds().length + " kinds";
    menu.appendChild(header);

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
          if (kind === group.selectedKind) option.selected = true;
          select.appendChild(option);
        }
        top.appendChild(select);
        column.appendChild(top);

        var list = document.createElement("ul");
        list.className = "interior-menu-items";

        function repaintList() {
          list.innerHTML = "";
          var activeKind = select.value;
          var items = interiorItemsForSelection(interior, group.kinds, activeKind, query);
          if (!items.length) {
            var empty = document.createElement("p");
            empty.className = "panel-note";
            empty.style.margin = "0";
            empty.textContent = query ? "No declarations match this filter." : (activeKind === INTERIOR_KIND_ALL_VALUE ? "No declarations detected for this kind group." : "No declarations detected for this kind.");
            list.replaceWith(empty);
            return;
          }

          if (list.parentNode !== column) {
            for (var c = 0; c < column.children.length; c++) {
              if (column.children[c].className === "panel-note") {
                column.removeChild(column.children[c]);
                break;
              }
            }
            column.appendChild(list);
          }

          for (var j = 0; j < items.length; j++) {
            var li = document.createElement("li");
            li.className = "interior-menu-item";
            var link = document.createElement("a");
            link.href = symbolSourceHref(selected, items[j]);
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = items[j].name;
            link.title = items[j].line > 0 ? "Open declaration at line " + items[j].line : "Open declaration source";
            li.appendChild(link);
            list.appendChild(li);
          }
        }

        select.addEventListener("change", function () {
          state.interiorMenuSelections[group.key] = select.value;
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
      var oldestKey = LABEL_WRAP_CACHE.keys().next().value;
      if (oldestKey) LABEL_WRAP_CACHE.delete(oldestKey);
    }
    LABEL_WRAP_CACHE.set(cacheKey, lines.slice());

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
    for (var key in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      node.setAttribute(key, attrs[key]);
    }
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

    var wrapWidth = Math.max(0, (wrap.clientWidth || 0) - 8);
    var flowWidth = Math.max(minimumFlowWidth(), wrapWidth || 0);
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
        var pathHeight = nodeContentHeight(pathName, moduleSummary(pathName), pathNodeWidth, true);
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
      for (var ex = 0; ex < external.length; ex++) {
        var exRow = Math.floor(ex / externalPerRow);
        externalRowHeights[exRow] = Math.max(externalRowHeights[exRow] || 0, nodeContentHeight(external[ex], "", externalWidth, true));
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
          h: nodeContentHeight(external[ez], "", externalWidth, true)
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

    var legend = document.createElement("div");
    legend.className = "flowchart-legend flowchart-legend-corner";
    legend.setAttribute("aria-label", "Flow chart legend");
    var legendItems = flowLegendItems();
    for (var li = 0; li < legendItems.length; li++) {
      var chip = document.createElement("span");
      chip.className = "legend-item";
      var swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.backgroundColor = legendItems[li].color;
      chip.appendChild(swatch);
      chip.appendChild(document.createTextNode(legendItems[li].label));
      legend.appendChild(chip);
    }
    wrap.appendChild(legend);

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
      if (laneLabels.proof) laneLabel("Proof pair context", centerX, proofStartY - 16, "#d37cff");
      var proofY = proofStartY;
      for (var n = 0; n < proofRelated.length; n++) {
        var proofHeight = nodeContentHeight(proofRelated[n], moduleSummary(proofRelated[n]), centerWidth, true);
        var proofNode = createNode(proofRelated[n], centerX, proofY, centerWidth, proofHeight, "#d37cff", moduleSummary(proofRelated[n]), nodeTooltip(proofRelated[n], "Proof-pair neighbor"), false, false, contextFor(proofRelated[n]).assurance.level);
        drawFlowEdge(edgeLayer, center, proofNode, "#d37cff", true, { rank: n, total: proofRelated.length, spread: 18 });
        proofY += proofHeight + 8;
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

    if (state.flowScrollTarget === selected) {
      var targetScrollLeft = Math.max(0, center.x + center.w / 2 - wrap.clientWidth / 2);
      var targetScrollTop = Math.max(0, center.y + center.h / 2 - wrap.clientHeight / 2);
      var maxScrollLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      var maxScrollTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
      wrap.scrollLeft = Math.min(maxScrollLeft, targetScrollLeft);
      wrap.scrollTop = Math.min(maxScrollTop, targetScrollTop);
      state.flowScrollTarget = "";
      return;
    }

    wrap.scrollLeft = previousScrollLeft;
    wrap.scrollTop = previousScrollTop;
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
    renderFlowchart();
  }


  function setupNav() {
    var toggle = document.getElementById("nav-toggle");
    var links = document.getElementById("nav-links");
    var nav = document.getElementById("nav");

    function resolveNavTarget(href) {
      if (!href) return null;
      var parsed;
      try {
        parsed = new URL(href, window.location.href);
      } catch (e) {
        return null;
      }

      var currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
      var targetPath = parsed.pathname.replace(/\/+$/, "") || "/";
      if (currentPath === "/index.html") currentPath = "/";
      if (targetPath === "/index.html") targetPath = "/";

      return {
        href: href,
        path: targetPath,
        samePath: currentPath === targetPath,
        hash: parsed.hash || ""
      };
    }

    function samePageHashTarget(href) {
      var targetInfo = resolveNavTarget(href);
      if (!targetInfo || !targetInfo.samePath || !targetInfo.hash || targetInfo.hash.charAt(0) !== "#") return null;
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
      if (!targetInfo || !targetInfo.hash || !targetInfo.path) return;
      try {
        sessionStorage.setItem(NAV_INTENT_KEY, JSON.stringify({
          path: targetInfo.path,
          hash: targetInfo.hash,
          ts: Date.now()
        }));
      } catch (e) {}
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

      var currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
      for (var j = 0; j < pageLinks.length; j++) {
        var link = pageLinks[j];
        var href = link.getAttribute("href") || "";
        var normalizedHref = href.split("#")[0].replace(/^\.\//, "").replace(/\/+$/, "");
        var linkPath = ("/" + normalizedHref).replace(/\/+/g, "/") || "/";
        if (linkPath === "/index.html") linkPath = "/";
        if (currentPath === "/index.html") currentPath = "/";

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
          } else if (target && !target.samePath && target.hash) {
            storeCrossPageNavIntent(target);
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
        functions: functions.length ? functions : (byKind.def || []).concat(byKind.abbrev || [], byKind.opaque || [], byKind.instance || [])
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

    return {
      files: normalizeFiles(data.files, normalizedModuleMap),
      modules: normalizedModules,
      moduleMap: normalizedModuleMap,
      moduleMeta: normalizedModuleMeta,
      importsTo: Object.create(null),
      importsFrom: normalizedImportsFrom,
      externalImportsFrom: normalizedExternalImportsFrom,
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
          symbols: emptySymbols()
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
    invalidateDerivedCaches();
    state.contextList = [];
    state.commitSha = data.commitSha || "";
    state.generatedAt = data.generatedAt || "";
    LABEL_WRAP_CACHE.clear();
    rebuildImportsToIndex();
    buildSearchIndex();

    buildPairs();
    if (!state.selectedModule || !state.moduleMap[state.selectedModule]) state.selectedModule = state.modules[0] || null;
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
    return "balanced";
  }

  function applyDetailLevel(level) {
    var key = Object.prototype.hasOwnProperty.call(DETAIL_PRESETS, level) ? level : "balanced";
    var preset = DETAIL_PRESETS[key];
    state.neighborLimit = preset.neighborLimit;
    state.impactRadius = preset.impactRadius;
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

  function setupFilters() {
    var toolbar = document.getElementById("map-toolbar");
    var search = document.getElementById("module-search");
    var selectedDetail = detailLevelFromState();
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
      function matchModule(query, list) {
        var value = (query || "").trim();
        if (!value) return "";

        var direct = sanitizeModuleName(value);
        if (direct && state.moduleMap[direct]) return direct;

        var lower = value.toLowerCase();
        var normalized = normalizeSearchValue(value);
        var queryTokens = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
        var best = "";
        var bestScore = -1;

        for (var i = 0; i < list.length; i++) {
          var name = list[i];
          var idx = state.searchIndex[name] || {
            nameLower: name.toLowerCase(),
            pathLower: (state.moduleMap[name] || "").toLowerCase(),
            nameTokens: [],
            pathTokens: []
          };

          if (idx.nameLower === lower) return name;
          if (idx.pathLower === lower) return name;

          var score = 0;
          if (idx.nameLower.indexOf(lower) === 0) score = Math.max(score, 1200 - idx.nameLower.length);
          if (idx.pathLower.indexOf(lower) === 0) score = Math.max(score, 1000 - idx.pathLower.length);
          if (idx.nameLower.indexOf(lower) !== -1) score = Math.max(score, 800 - idx.nameLower.indexOf(lower));
          if (idx.pathLower.indexOf(lower) !== -1) score = Math.max(score, 700 - idx.pathLower.indexOf(lower));

          if (queryTokens.length) {
            var tokenHits = 0;
            var nameJoined = idx.nameTokens.join(" ");
            var pathJoined = idx.pathTokens.join(" ");
            for (var q = 0; q < queryTokens.length; q++) {
              var token = queryTokens[q];
              if (nameJoined.indexOf(token) !== -1 || pathJoined.indexOf(token) !== -1) tokenHits += 1;
            }
            if (tokenHits) score = Math.max(score, 400 + tokenHits * 35);
          }

          score += Math.max(0, 20 - Math.floor(moduleDegree(name).score / 10));

          if (score > bestScore) {
            best = name;
            bestScore = score;
          }
        }

        return bestScore > 0 ? best : "";
      }

      var choose = function () {
        setSearchFeedback("", false);
        if (typeof search.setCustomValidity === "function") search.setCustomValidity("");

        var list = contextList();
        var match = matchModule(search.value, list);
        if (match) {
          if (search.value !== match) search.value = match;
          selectModule(match, false);
          return;
        }

        if ((search.value || "").trim()) {
          var message = "No module match in current filter scope. Try broader terms or reset filters.";
          setSearchFeedback(message, true);
          if (typeof search.setCustomValidity === "function") search.setCustomValidity(message);
          if (typeof search.reportValidity === "function") search.reportValidity();
        }
      };

      search.addEventListener("input", function () {
        setSearchFeedback("", false);
        if (typeof search.setCustomValidity === "function") search.setCustomValidity("");
      });
      search.addEventListener("change", choose);
      search.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          if (state.selectedModule) search.value = state.selectedModule;
          setSearchFeedback("", false);
          if (typeof search.setCustomValidity === "function") search.setCustomValidity("");
          event.preventDefault();
          return;
        }
        if (event.key !== "Enter") return;
        choose();
        event.preventDefault();
      });
    }
    var detailPills = document.querySelectorAll(".detail-pill[data-detail]");
    var detailOrder = ["compact", "balanced", "expanded"];
    var detailNodes = Object.create(null);
    for (var d = 0; d < detailPills.length; d++) {
      var detailName = detailPills[d].getAttribute("data-detail") || "";
      if (detailName) detailNodes[detailName] = detailPills[d];
      detailPills[d].addEventListener("click", function () {
        selectedDetail = this.getAttribute("data-detail") || "balanced";
        apply();
      });
      detailPills[d].addEventListener("keydown", function (event) {
        var key = event.key;
        if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
        event.preventDefault();
        var current = detailOrder.indexOf(selectedDetail);
        if (current < 0) current = 1;
        if (key === "Home") selectedDetail = detailOrder[0];
        else if (key === "End") selectedDetail = detailOrder[detailOrder.length - 1];
        else {
          var next = current + ((key === "ArrowLeft" || key === "ArrowUp") ? -1 : 1);
          if (next < 0) next = detailOrder.length - 1;
          if (next >= detailOrder.length) next = 0;
          selectedDetail = detailOrder[next];
        }
        apply();
        var nextNode = detailNodes[selectedDetail];
        if (nextNode) nextNode.focus();
      });
    }
    if (reset) {
      reset.addEventListener("click", function () {
        if (search && state.selectedModule) search.value = state.selectedModule;
        setSearchFeedback("", false);
        if (search && typeof search.setCustomValidity === "function") search.setCustomValidity("");
        selectedDetail = "balanced";
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
      var neighbors = Number(getParam("neighbors") || "12");
      if (neighbors >= 4 && neighbors <= 20) state.neighborLimit = neighbors;

      var radius = Number(getParam("radius") || "2");
      if (radius >= 1 && radius <= 3) state.impactRadius = radius;

      var mode = getParam("mode") || "";
      if (mode === "imports") applyDetailLevel("compact");
      else if (mode === "impact") applyDetailLevel("expanded");
    }

    state.proofLinkedOnly = getParam("linked") === "1";
    state.flowShowAll = getParam("fullflow") === "1";
  }

  function syncUrlState() {
    var params = new URLSearchParams(window.location.search);
    if (state.selectedModule) params.set("module", state.selectedModule); else params.delete("module");
    if (state.activeLayerFilter && state.activeLayerFilter !== "all") params.set("layer", state.activeLayerFilter); else params.delete("layer");
    var detailLevel = detailLevelFromState();
    if (detailLevel !== "balanced") params.set("detail", detailLevel); else params.delete("detail");
    params.delete("neighbors");
    params.delete("radius");

    if (state.proofLinkedOnly) params.set("linked", "1"); else params.delete("linked");
    if (state.flowShowAll) params.set("fullflow", "1"); else params.delete("fullflow");

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
    setupNav();
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
      interiorGroupItemCount: interiorGroupItemCount,
      pickInteriorDefaultKind: pickInteriorDefaultKind,
      interiorItemsForSelection: interiorItemsForSelection,
      flowLegendItems: flowLegendItems,
      flowLaneLabelVisibility: flowLaneLabelVisibility,
      normalizeCaretRange: normalizeCaretRange
    };
    return;
  }

  boot();
})();
