(function () {
  "use strict";

  /**
   * Statistics shown on this page have exactly one source: data/site-data.json,
   * which scripts/sync-site-data.mjs projects from the kernel's canonical
   * docs/codebase_map.json and CI validates before publishing.
   *
   * This runtime deliberately derives nothing. It previously refreshed the
   * figures from five GitHub endpoints and reconstructed them here — a README
   * table parse, a `GET /languages` bytes-per-line estimate, a tree scan that
   * counted only SeLe4n/Kernel, a build-job count invented as modules × 2.
   * Each was a second opinion the kernel never gave, so whenever one of those
   * requests won a race or the canonical fetch failed, the page published a
   * number no upstream source asserts — and cached it for thirty days. The
   * projection now happens once, offline, where it is reviewed and tested;
   * the browser only renders the result.
   */
  var DATA_ENDPOINT = "data/site-data.json";

  var NAV_INTENT_KEY = "sele4n-nav-intent-v1";
  var NAV_INTENT_MAX_AGE_MS = 60 * 1000;

  // Cache key of the retired live-refresh layer. Nothing reads it now; it is
  // purged on load so a returning visitor stops carrying a stored snapshot of
  // the heuristics above.
  var LEGACY_LIVE_CACHE_KEY = "sele4n-live-v2";

  var FETCH_TIMEOUT_MS = 8000;
  var FETCH_OPTIONS = {
    credentials: "omit",
    cache: "no-store",
    // Same-origin by construction: the only fetch this file makes is the
    // bundled snapshot. Stated here so a cross-origin URL fails loudly rather
    // than quietly reintroducing a second source of truth.
    mode: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer"
  };

  var LIVE_NODE_CACHE = Object.create(null);
  var lastAppliedData = null;

  function update(key, value) {
    if (value === undefined || value === null || value === "") return;
    var els = LIVE_NODE_CACHE[key];
    if (!els) {
      els = document.querySelectorAll('[data-live="' + key + '"]');
      LIVE_NODE_CACHE[key] = els;
    }

    // Counts arrive as numbers and are grouped here; `lines` arrives
    // pre-grouped as a string. Both must render exactly like the literal that
    // scripts/apply-static-values.mjs stamps into the markup, or hydration
    // visibly rewrites the figure.
    var rendered = typeof value === "number" ? formatNumber(value) : String(value);

    for (var i = 0; i < els.length; i++) {
      var next = rendered;
      if (els[i].textContent !== next) els[i].textContent = next;

      if (els[i].tagName === "TIME") {
        els[i].dateTime = value;
      }
    }
  }

  /**
   * Hydrate the architecture diagram's per-subsystem figures.
   *
   * Addressed as `subsystem.<key>.<field>` so one span says which subsystem it
   * counts. scripts/lib/static-values.mjs stamps the same keys into the
   * markup; a key the snapshot does not carry keeps the stamped literal,
   * which is the correct fallback rather than a blank.
   */
  function updateSubsystems(subsystems) {
    if (!subsystems || typeof subsystems !== "object") return;

    for (var key in subsystems) {
      if (!Object.prototype.hasOwnProperty.call(subsystems, key)) continue;
      var entry = subsystems[key];
      if (!entry || typeof entry !== "object") continue;
      update("subsystem." + key + ".modules", entry.modules);
      update("subsystem." + key + ".theorems", entry.theorems);
    }
  }

  function updateMetadata(data) {
    if (!data.theorems) return;

    var i18nSummary = window.sele4nI18n && window.sele4nI18n.t("meta.index_description");
    var summary = (i18nSummary && i18nSummary !== "meta.index_description") ? i18nSummary : "seLe4n is a formally verified microkernel written in Lean 4 with machine-checked proofs and safe Rust syscall wrappers. Zero sorry, zero axiom. Targeting Raspberry Pi 5.";
    var i18nOgSummary = window.sele4nI18n && window.sele4nI18n.t("meta.index_og_description");
    var ogSummary = (i18nOgSummary && i18nOgSummary !== "meta.index_og_description") ? i18nOgSummary : "Formally verified microkernel with machine-checked proofs and safe Rust syscall wrappers. Zero sorry, zero axiom. Targeting Raspberry Pi 5.";
    var targets = [
      { selector: 'meta[name="description"]', value: summary },
      { selector: 'meta[property="og:description"]', value: ogSummary },
      { selector: 'meta[name="twitter:description"]', value: ogSummary }
    ];

    for (var i = 0; i < targets.length; i++) {
      var el = document.querySelector(targets[i].selector);
      if (!el) continue;
      el.setAttribute("content", targets[i].value);
    }
  }

  function applyData(data) {
    lastAppliedData = data;
    update("version", data.version);
    update("lean-version", data.leanVersion);
    update("modules", data.modules);
    update("lines", data.lines);
    update("theorems", data.theorems);
    update("syscalls", data.syscalls);
    update("externs", data.externs);
    update("ni-steps", data.niSteps);
    update("ni-cross-core", data.niCrossCore);
    update("enforcement-ops", data.enforcementOps);
    update("enforcement-ops-per-core", data.enforcementOpsPerCore);
    update("frozen-syscalls", data.frozenSyscalls);
    update("scripts", data.scripts);
    update("docs", data.docs);
    update("admitted", data.admitted);
    update("commit-sha", data.commitSha);
    updateSubsystems(data.subsystems);

    if (data.updatedAt) {
      var updatedDate = new Date(data.updatedAt);
      if (!Number.isNaN(updatedDate.getTime())) {
        var updatedNodes = document.querySelectorAll('[data-live="updated-at"]');
        var localeHint = (window.sele4nI18n && window.sele4nI18n.locale()) || undefined;
        var displayDate = updatedDate.toLocaleDateString(localeHint, {
          year: "numeric",
          month: "short",
          day: "numeric"
        });

        for (var i = 0; i < updatedNodes.length; i++) {
          updatedNodes[i].textContent = displayDate;
          if (updatedNodes[i].tagName === "TIME") updatedNodes[i].dateTime = updatedDate.toISOString();
        }
      }
    }

    updateMetadata(data);

    if (!data.version) return;
    var ld = document.querySelector('script[type="application/ld+json"]');
    if (!ld) return;

    try {
      var obj = JSON.parse(ld.textContent);
      obj.version = data.version;
      if (data.updatedAt) obj.dateModified = data.updatedAt;
      ld.textContent = JSON.stringify(obj, null, 2);
    } catch (e) {}
  }

  /**
   * Keys the page renders, in the shape data/site-data.json publishes them.
   *
   * Listing them explicitly means a field the snapshot stops carrying shows up
   * as a missing number rather than as a stale one left over from whatever was
   * applied before.
   */
  function normalizeBundledData(data) {
    if (!data || typeof data !== "object") return null;

    return {
      version: data.version,
      leanVersion: data.leanVersion,
      modules: data.modules,
      lines: data.lines,
      theorems: data.theorems,
      syscalls: data.syscalls,
      externs: data.externs,
      niSteps: data.niSteps,
      niCrossCore: data.niCrossCore,
      enforcementOps: data.enforcementOps,
      enforcementOpsPerCore: data.enforcementOpsPerCore,
      frozenSyscalls: data.frozenSyscalls,
      scripts: data.scripts,
      docs: data.docs,
      admitted: data.admitted,
      subsystems: data.subsystems,
      commitSha: data.commitSha,
      updatedAt: data.updatedAt
    };
  }

  function formatNumber(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function fetchWithTimeout(url) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;

    if (controller) {
      timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    }

    var options = Object.assign({}, FETCH_OPTIONS);
    if (controller) options.signal = controller.signal;

    return fetch(url, options).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  function fetchJSON(url) {
    return fetchWithTimeout(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      var contentType = r.headers.get("content-type") || "";
      if (contentType.indexOf("application/json") === -1) throw new Error("Unexpected content type");
      return r.json();
    });
  }

  /**
   * Load the bundled snapshot and render it.
   *
   * On failure the markup keeps the literals apply-static-values.mjs stamped
   * from the very same snapshot at build time, so a failed fetch degrades to
   * the correct figures rather than to a guess at them.
   */
  function loadBundledData() {
    return fetchJSON(DATA_ENDPOINT).then(function (payload) {
      var data = normalizeBundledData(payload);
      if (!data) throw new Error("Invalid bundled data");
      applyData(data);
    }).catch(function (err) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[seLe4n] bundled data fetch failed, using static values:", err);
      }
    });
  }

  function purgeLegacyLiveCache() {
    try {
      localStorage.removeItem(LEGACY_LIVE_CACHE_KEY);
    } catch (e) {}
  }

  purgeLegacyLiveCache();

  window.addEventListener("sele4n:locale-changed", function () {
    for (var k in LIVE_NODE_CACHE) delete LIVE_NODE_CACHE[k];
    if (lastAppliedData) applyData(lastAppliedData);
  });

  // The i18n bootstrap translateDOM replaces data-i18n-html contents without
  // firing sele4n:locale-changed; drop cached nodes so live spans re-resolve.
  if (window.sele4nI18n) window.sele4nI18n.onReady(function () {
    for (var k in LIVE_NODE_CACHE) delete LIVE_NODE_CACHE[k];
    if (lastAppliedData) applyData(lastAppliedData);
  });

  // Safe to defer: the markup already carries this snapshot's values, stamped
  // at build time from the same file, so the fetch only refreshes them in the
  // window between a data sync and the next deploy.
  if (typeof requestIdleCallback === "function") requestIdleCallback(loadBundledData);
  else setTimeout(loadBundledData, 1);
})();
