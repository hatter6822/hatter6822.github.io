(function () {
  "use strict";

  var STATIC_FALLBACK = {
    admitted: 0
  };

  var DATA_ENDPOINT = "data/site-data.json";

  var REPO = "hatter6822/seLe4n";
  var API = "https://api.github.com/repos/" + REPO;
  var RAW = "https://raw.githubusercontent.com/" + REPO + "/";
  var REF = "main";
  var CACHE_KEY = "sele4n-live-v2";
  var CACHE_TTL = 6 * 60 * 60 * 1000;
  var CACHE_MAX_STALE = 30 * 24 * 60 * 60 * 1000;
  var DATA_SCHEMA_VERSION = 4;
  var NAV_INTENT_KEY = "sele4n-nav-intent-v1";
  var NAV_INTENT_MAX_AGE_MS = 60 * 1000;

  var FETCH_TIMEOUT_MS = 8000;
  var FETCH_OPTIONS = {
    credentials: "omit",
    cache: "no-store",
    mode: "cors",
    redirect: "error",
    referrerPolicy: "no-referrer"
  };

  var LIVE_NODE_CACHE = Object.create(null);


  function normalizePagePath(pathname, options) {
    var allowEmpty = options && options.allowEmpty;
    var normalized = String(pathname || "").replace(/\/+$/, "");
    if (!normalized) return allowEmpty ? "" : "/";
    if (normalized === "/index.html") return "/";
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

    for (var i = 0; i < els.length; i++) {
      var next = String(value);
      if (els[i].textContent !== next) els[i].textContent = next;

      if (els[i].tagName === "TIME") {
        els[i].dateTime = value;
      }
    }
  }

  function updateMetadata(data) {
    if (!data.theorems) return;

    var summary = "Formally verified microkernel with " + data.theorems + " machine-checked theorems. Zero sorry, zero axiom. Targeting Raspberry Pi 5.";
    var selectors = [
      'meta[name="description"]',
      'meta[property="og:description"]',
      'meta[name="twitter:description"]'
    ];

    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (!el) continue;
      el.setAttribute("content", summary);
    }
  }

  function applyData(data) {
    update("version", data.version);
    update("lean-version", data.leanVersion);
    update("modules", data.modules);
    update("lines", data.lines);
    update("theorems", data.theorems);
    update("scripts", data.scripts);
    update("docs", data.docs);
    update("build-jobs", data.buildJobs);
    update("admitted", data.admitted);
    update("commit-sha", data.commitSha);

    if (data.updatedAt) {
      var updatedDate = new Date(data.updatedAt);
      if (!Number.isNaN(updatedDate.getTime())) {
        var updatedNodes = document.querySelectorAll('[data-live="updated-at"]');
        var displayDate = updatedDate.toLocaleDateString(undefined, {
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

  function setTheme(theme) {
    var root = document.documentElement;
    var themeColorMeta = document.getElementById("theme-color-meta");

    root.setAttribute("data-theme", theme);
    try { localStorage.setItem("sele4n-theme", theme); } catch (e) {}

    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", theme === "light" ? "#f8f9fc" : "#0a0e17");
    }
  }

  function setupTheme() {
    var root = document.documentElement;
    var themeToggle = document.getElementById("theme-toggle");
    if (!root.getAttribute("data-theme")) setTheme("dark");

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
        if (!saved) setTheme(e.matches ? "light" : "dark");
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
            history.pushState(null, "", href);
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
    window.addEventListener("resize", syncScrollOffset, { passive: true });
    window.addEventListener("orientationchange", syncScrollOffset, { passive: true });

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
          link.setAttribute("aria-current", "page");
        }
      }, { rootMargin: "-30% 0px -60% 0px", threshold: 0.01 });

      for (var id in sectionMap) {
        var section = document.getElementById(id);
        if (section) observer.observe(section);
      }
    }
  }

  function getCached() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (obj.schema !== DATA_SCHEMA_VERSION) return null;
      if (!obj.data || typeof obj.data !== "object") return null;

      var age = Date.now() - Number(obj.ts || 0);
      if (age > CACHE_MAX_STALE) return null;

      return {
        data: obj.data,
        age: age,
        isFresh: age <= CACHE_TTL
      };
    } catch (e) {
      return null;
    }
  }

  function setCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: DATA_SCHEMA_VERSION, ts: Date.now(), data: data }));
    } catch (e) {}
  }

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
      buildJobs: data.buildJobs,
      admitted: data.admitted,
      commitSha: data.commitSha,
      updatedAt: data.updatedAt,
      generatedAt: data.generatedAt
    };
  }

  function formatNumber(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function mergeData(base, patch) {
    var out = {};
    var key;

    for (key in base) out[key] = base[key];
    for (key in patch) {
      if (patch[key] === undefined || patch[key] === null || patch[key] === "") continue;
      out[key] = patch[key];
    }

    return out;
  }

  function getDataTimestamp(data) {
    var value = data && (data.generatedAt || data.updatedAt);
    if (!value) return 0;
    var ts = new Date(value).getTime();
    return Number.isNaN(ts) ? 0 : ts;
  }

  function fetchBundledData() {
    return fetchJSON(DATA_ENDPOINT).then(function (payload) {
      var normalized = normalizeBundledData(payload);
      if (!normalized) throw new Error("Invalid bundled data");
      return normalized;
    });
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

  function parseCurrentStateMetrics(readmeText) {
    if (!readmeText) return {};

    var metrics = {};
    var rows = readmeText.split(/\r?\n/);
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].split('|');
      if (cells.length < 3) continue;

      var metric = (cells[1] || '').toLowerCase();
      var value = (cells[2] || '').trim();

      if (metric.indexOf('version') !== -1) {
        var version = value.match(/\d+\.\d+\.\d+/);
        if (version) metrics.version = version[0];
      }

      if (metric.indexOf('production loc') !== -1) {
        var lines = value.match(/\d[\d,]*/);
        if (lines) metrics.lines = lines[0];
      }

      if (metric.indexOf('theorem') !== -1) {
        var theorems = value.match(/\d[\d,]*/);
        if (theorems) metrics.theorems = Number(theorems[0].replace(/,/g, ''));
      }

      if (metric.indexOf('build job') !== -1) {
        var buildJobs = value.match(/\d[\d,]*/);
        if (buildJobs) metrics.buildJobs = Number(buildJobs[0].replace(/,/g, ''));
      }
    }

    return metrics;
  }

  function fetchText(url) {
    return fetchWithTimeout(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    });
  }

  function fetchLiveData() {
    var data = {};

    var tasks = [
      fetchJSON(API + "/commits/" + REF).then(function (commit) {
        if (!commit) return;
        if (commit.sha) data.commitSha = commit.sha.slice(0, 7);
        if (commit.commit && commit.commit.author && commit.commit.author.date) {
          data.updatedAt = commit.commit.author.date;
        }
      }).catch(function () {}),
      fetchJSON(API + "/git/trees/" + REF + "?recursive=1").then(function (treePayload) {
        var tree = treePayload && treePayload.tree;
        if (!Array.isArray(tree)) return;

        var modules = 0;
        var scripts = 0;
        var docs = 0;
        for (var i = 0; i < tree.length; i++) {
          var item = tree[i];
          if (!item || item.type !== "blob") continue;
          var path = item.path || "";
          if (/^SeLe4n\/Kernel\/.*\.lean$/.test(path)) modules += 1;
          if (/^scripts\/.*\.sh$/.test(path)) scripts += 1;
          if (/^docs\/.*\.(md|txt)$/.test(path)) docs += 1;
        }

        data.modules = modules;
        data.scripts = scripts;
        data.docs = docs;
      }).catch(function () {}),
      fetchJSON(API + "/languages").then(function (langs) {
        if (!langs || typeof langs.Lean !== "number") return;
        data.lines = formatNumber(Math.round(langs.Lean / 38));
      }).catch(function () {}),
      fetchText(RAW + REF + "/README.md").then(function (readmeText) {
        var metrics = parseCurrentStateMetrics(readmeText);
        if (metrics.version) data.version = metrics.version;
        if (metrics.lines) data.lines = metrics.lines;
        if (typeof metrics.theorems === "number" && metrics.theorems > 0) data.theorems = metrics.theorems;
        if (typeof metrics.buildJobs === "number" && metrics.buildJobs > 0) data.buildJobs = metrics.buildJobs;
      }).catch(function () {}),
      fetchText(RAW + REF + "/lean-toolchain").then(function (toolchainText) {
        var toolchainMatch = toolchainText && toolchainText.match(/(\d+\.\d+\.\d+)/);
        if (toolchainMatch) data.leanVersion = toolchainMatch[1];
      }).catch(function () {}),
      fetchText(RAW + REF + "/lakefile.toml").then(function (lakefileText) {
        if (data.version) return;
        var versionMatch = lakefileText && lakefileText.match(/version\s*=\s*"([^"]+)"/);
        if (versionMatch) data.version = versionMatch[1];
      }).catch(function () {})
    ];

    return Promise.all(tasks).then(function () { return data; });
  }

  function refreshLiveData() {
    var baseline = STATIC_FALLBACK;
    var cachedRecord = getCached();
    if (cachedRecord) {
      baseline = mergeData(baseline, cachedRecord.data);
      applyData(baseline);
    }

    fetchBundledData().then(function (bundled) {
      var bundledTs = getDataTimestamp(bundled);
      var cachedTs = getDataTimestamp(cachedRecord && cachedRecord.data);
      if (cachedTs && bundledTs && bundledTs < cachedTs) {
        return;
      }

      baseline = mergeData(baseline, bundled);
      setCache(baseline);
      applyData(baseline);
    }).catch(function () {});

    fetchLiveData().then(function (data) {
      baseline = mergeData(baseline, data);
      setCache(baseline);
      applyData(baseline);
    }).catch(function () {});
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

  applyData(STATIC_FALLBACK);
  setupTheme();
  setupNav();
  hardenExternalLinks();

  if (typeof requestIdleCallback === "function") requestIdleCallback(refreshLiveData);
  else setTimeout(refreshLiveData, 1);
})();
