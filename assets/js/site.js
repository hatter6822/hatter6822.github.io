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


  function normalizePagePath(pathname, options) {
    var allowEmpty = options && options.allowEmpty;
    var normalized = String(pathname || "").replace(/\/+$/, "");
    normalized = normalized.replace(/\/index\.html$/i, "");
    if (!normalized) return allowEmpty ? "" : "/";
    return normalized;
  }

  function safeScrollTo(top, behavior) {
    var targetTop = Math.max(0, Number(top) || 0);
    var mode = behavior || "auto";

    try {
      window.scrollTo({ top: targetTop, behavior: mode });
    } catch (e) {
      window.scrollTo(0, targetTop);
    }
  }

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
    update("scripts", data.scripts);
    update("docs", data.docs);
    update("admitted", data.admitted);
    update("commit-sha", data.commitSha);

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

  function applyTheme(theme) {
    var root = document.documentElement;
    var themeColorMeta = document.getElementById("theme-color-meta");

    root.setAttribute("data-theme", theme);

    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", theme === "light" ? "#f8f9fc" : "#0a0e17");
    }
  }

  function setTheme(theme) {
    applyTheme(theme);
    try { localStorage.setItem("sele4n-theme", theme); } catch (e) {}
  }

  function setupTheme() {
    var root = document.documentElement;
    var themeToggle = document.getElementById("theme-toggle");
    var themeColorMeta = document.getElementById("theme-color-meta");
    var current = root.getAttribute("data-theme");
    if (!current) {
      setTheme("dark");
    } else if (themeColorMeta) {
      // theme-init.js already applied the theme; sync the browser-chrome
      // color without persisting a possibly system-derived theme.
      themeColorMeta.setAttribute("content", current === "light" ? "#f8f9fc" : "#0a0e17");
    }

    if (themeToggle) {
      themeToggle.addEventListener("click", function () {
        var current = root.getAttribute("data-theme") || "dark";
        setTheme(current === "dark" ? "light" : "dark");
      });
    }

    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: light)");
      var onChange = function (e) {
        var saved = null;
        try { saved = localStorage.getItem("sele4n-theme"); } catch (err) {}
        // Follow the system without persisting — persisting would pin the
        // user to whatever the OS happened to be at the first change event.
        if (!saved) applyTheme(e.matches ? "light" : "dark");
      };

      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }


  function setupNav() {
    var toggle = document.getElementById("nav-toggle");
    var links = document.getElementById("nav-links");
    var nav = document.getElementById("nav");

    function getNavOffset() {
      if (!nav) return 0;
      var navHeight = nav.getBoundingClientRect().height || 0;
      return Math.ceil(navHeight + 12);
    }

    function syncScrollOffset() {
      var navOffset = getNavOffset();
      document.documentElement.style.setProperty("--nav-scroll-offset", navOffset + "px");
      if (nav) {
        var navHeight = Math.ceil(nav.getBoundingClientRect().height || 0);
        if (navHeight > 0) document.documentElement.style.setProperty("--nav-height", navHeight + "px");
      }
    }

    function scrollToHash(hash, behavior) {
      if (!hash || hash === "#") return;

      var id = hash.charAt(0) === "#" ? hash.slice(1) : hash;
      try {
        id = decodeURIComponent(id);
      } catch (e) {}
      if (!id) return;

      var target = document.getElementById(id);
      if (!target) return;

      var targetTop = target.getBoundingClientRect().top + window.scrollY - getNavOffset();
      safeScrollTo(targetTop, behavior || "smooth");

      return target;
    }

    function focusHashTarget(hash) {
      if (!hash || hash === "#") return;

      var id = hash.charAt(0) === "#" ? hash.slice(1) : hash;
      try {
        id = decodeURIComponent(id);
      } catch (e) {}
      if (!id) return;

      var target = document.getElementById(id);
      if (!target || typeof target.focus !== "function") return;

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

    function readStoredNavIntent() {
      try {
        var raw = sessionStorage.getItem(NAV_INTENT_KEY);
        if (!raw) return null;
        sessionStorage.removeItem(NAV_INTENT_KEY);

        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.hash !== "string" || parsed.hash.charAt(0) !== "#") return null;
        if (Math.abs(Date.now() - Number(parsed.ts || 0)) > NAV_INTENT_MAX_AGE_MS) return null;

        var currentPath = normalizePagePath(window.location.pathname);
        var intentPath = normalizePagePath(parsed.path, { allowEmpty: true });
        if (intentPath && intentPath !== currentPath) return null;

        return parsed.hash;
      } catch (e) {
        return null;
      }
    }

    function scheduleHashScroll(hash, behavior) {
      var target = scrollToHash(hash, behavior);
      if (!target) return;

      window.requestAnimationFrame(function () {
        scrollToHash(hash, behavior);
      });

      window.setTimeout(function () {
        var targetTop = target.getBoundingClientRect().top;
        var navOffset = getNavOffset();
        if (targetTop >= navOffset && targetTop <= navOffset + 24) return;
        scrollToHash(hash, "auto");
      }, 220);
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
          var href = event.currentTarget.getAttribute("href");

          setNavState(false);

          if (!href || href.charAt(0) !== "#") return;

          event.preventDefault();
          scheduleHashScroll(href, "smooth");
          focusHashTarget(href);

          if (window.location.hash !== href) {
            try { history.pushState(null, "", href); } catch (e) {}
          }
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

    if (!nav) return;

    syncScrollOffset();
    var syncScrollRafId = 0;
    function debouncedSyncScrollOffset() {
      if (syncScrollRafId) return;
      syncScrollRafId = requestAnimationFrame(function () {
        syncScrollRafId = 0;
        syncScrollOffset();
      });
    }
    window.addEventListener("resize", debouncedSyncScrollOffset, { passive: true });
    window.addEventListener("orientationchange", debouncedSyncScrollOffset, { passive: true });

    window.addEventListener("hashchange", function () {
      scheduleHashScroll(window.location.hash, "smooth");
    });

    var applyScrolled = function () {
      nav.classList.toggle("scrolled", window.scrollY > 40);
    };

    applyScrolled();

    if (window.location.hash) {
      window.requestAnimationFrame(function () {
        scheduleHashScroll(window.location.hash, "auto");
        focusHashTarget(window.location.hash);
      });
    } else {
      var storedHash = readStoredNavIntent();
      if (storedHash) {
        window.requestAnimationFrame(function () {
          scheduleHashScroll(storedHash, "auto");
          focusHashTarget(storedHash);
          if (window.location.hash !== storedHash) {
            try {
              history.replaceState(null, "", storedHash);
            } catch (e) {}
          }
        });
      }
    }

    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      window.requestAnimationFrame(function () {
        applyScrolled();
        ticking = false;
      });
      ticking = true;
    }, { passive: true });

    if (typeof IntersectionObserver === "function") {
      var sectionLinks = nav.querySelectorAll('a[href^="#"]');
      var sectionMap = Object.create(null);

      for (var i = 0; i < sectionLinks.length; i++) {
        var href = sectionLinks[i].getAttribute("href");
        if (!href || href === "#") continue;
        sectionMap[href.slice(1)] = sectionLinks[i];
      }

      var observer = new IntersectionObserver(function (entries) {
        for (var j = 0; j < entries.length; j++) {
          var entry = entries[j];
          var link = sectionMap[entry.target.id];
          if (!link || !entry.isIntersecting) continue;

          for (var id in sectionMap) {
            sectionMap[id].removeAttribute("aria-current");
          }
          link.setAttribute("aria-current", "location");
        }
      }, { rootMargin: "-30% 0px -60% 0px", threshold: 0.01 });

      for (var id in sectionMap) {
        var section = document.getElementById(id);
        if (section) observer.observe(section);
      }
    }
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
      scripts: data.scripts,
      docs: data.docs,
      admitted: data.admitted,
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

  purgeLegacyLiveCache();
  setupTheme();
  if (typeof window.sele4nSetupHeaderNav !== "function") {
    window.requestAnimationFrame(function () {
      if (typeof window.sele4nSetupHeaderNav !== "function") setupNav();
    });
  }
  hardenExternalLinks();

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
