(function () {
  "use strict";

  var NAV_INTENT_KEY = "sele4n-nav-intent-v1";
  var NAV_INTENT_MAX_AGE_MS = 60 * 1000;

  function normalizePagePath(pathname, options) {
    var allowEmpty = options && options.allowEmpty;
    var normalized = String(pathname || "").replace(/\/+$/, "");
    normalized = normalized.replace(/\/index\.html$/i, "");
    if (!normalized) return allowEmpty ? "" : "/";
    return normalized;
  }

  function safeScrollTo(top, behavior) {
    var targetTop = Math.max(0, Number(top) || 0);
    if (behavior === "instant") {
      var html = document.documentElement;
      var previousBehavior = html.style.scrollBehavior;
      html.style.scrollBehavior = "auto";
      window.scrollTo(0, targetTop);
      window.requestAnimationFrame(function () { html.style.scrollBehavior = previousBehavior; });
      return;
    }

    try {
      window.scrollTo({ top: targetTop, behavior: behavior || "auto" });
    } catch (e) {
      window.scrollTo(0, targetTop);
    }
  }

  function setupHeaderNav() {
    var nav = document.getElementById("nav");
    var toggle = document.getElementById("nav-toggle");
    var links = document.getElementById("nav-links");
    if (!nav || !links) return;

    var supportsFocusPreventScroll = null;

    function shouldBypassClientNavigation(event, element) {
      if (!event || !element) return true;
      if (event.defaultPrevented) return true;
      if (event.button && event.button !== 0) return true;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true;
      if (element.hasAttribute("download")) return true;

      var targetAttr = (element.getAttribute("target") || "").toLowerCase();
      return Boolean(targetAttr && targetAttr !== "_self");
    }

    function preferredScrollBehavior(defaultBehavior) {
      if (defaultBehavior === "auto" || defaultBehavior === "instant") return defaultBehavior;
      try {
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "auto";
      } catch (e) {}
      return defaultBehavior || "smooth";
    }

    function navHeight() {
      return Math.ceil(nav.getBoundingClientRect().height || 0);
    }

    function navOffset(extraGap) {
      var gap = typeof extraGap === "number" ? extraGap : 0;
      return Math.ceil(navHeight() + Math.max(0, gap));
    }

    function syncNavMetrics() {
      var navHeight = Math.ceil(nav.getBoundingClientRect().height || 0);
      if (navHeight > 0) {
        document.documentElement.style.setProperty("--nav-height", navHeight + "px");
        document.documentElement.style.setProperty("--nav-scroll-offset", Math.ceil(navHeight + 12) + "px");
      }
    }

    function setNavState(open) {
      if (!toggle) return;
      links.classList.toggle("open", open);
      toggle.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      document.body.classList.toggle("nav-open", open);
    }

    function resolveNavTarget(href) {
      if (!href) return null;
      try {
        var parsed = new URL(href, window.location.href);
        var currentPath = normalizePagePath(window.location.pathname);
        var targetPath = normalizePagePath(parsed.pathname);
        var sameOrigin = parsed.origin === window.location.origin;
        return {
          url: parsed.href,
          path: targetPath,
          search: parsed.search || "",
          hash: parsed.hash || "",
          sameOrigin: sameOrigin,
          samePath: sameOrigin && currentPath === targetPath
        };
      } catch (e) {
        return null;
      }
    }

    function hashTarget(hash) {
      if (!hash || hash.charAt(0) !== "#") return null;
      var id = hash.slice(1);
      try { id = decodeURIComponent(id); } catch (e) {}
      if (!id) return null;

      var byId = document.getElementById(id);
      if (byId) return byId;

      if (typeof document.getElementsByName === "function") {
        var named = document.getElementsByName(id);
        if (named && named.length) {
          for (var i = 0; i < named.length; i++) {
            if (named[i] && named[i].nodeType === 1) return named[i];
          }
        }
      }

      return null;
    }

    function canFocusWithoutScroll() {
      if (supportsFocusPreventScroll !== null) return supportsFocusPreventScroll;
      supportsFocusPreventScroll = false;

      var root = document.body || document.documentElement;
      if (!root || typeof document.createElement !== "function") return supportsFocusPreventScroll;

      var probe = document.createElement("button");
      probe.type = "button";
      probe.style.cssText = "position:fixed;left:-9999px;top:0;";

      try {
        root.appendChild(probe);
        probe.focus({
          get preventScroll() {
            supportsFocusPreventScroll = true;
            return true;
          }
        });
      } catch (e) {
      } finally {
        if (probe.parentNode) probe.parentNode.removeChild(probe);
      }

      return supportsFocusPreventScroll;
    }

    function sectionTopForHash(hash, options) {
      var target = hashTarget(hash);
      if (!target) return null;
      var includeGap = !options || options.includeGap !== false;
      var gap = includeGap ? 12 : 0;
      return target.getBoundingClientRect().top + window.scrollY - navOffset(gap);
    }

    function scrollToHash(hash, behavior, options) {
      var targetTop = sectionTopForHash(hash, options);
      if (targetTop === null) return false;
      safeScrollTo(targetTop, preferredScrollBehavior(behavior || "smooth"));
      return true;
    }

    function focusHashTarget(hash, options) {
      var target = hashTarget(hash);
      if (!target || typeof target.focus !== "function") return;
      var shouldRestoreTabIndex = false;
      if (!target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
        shouldRestoreTabIndex = true;
      }
      var maintainOffset = !(options && options.maintainOffset === false);
      var supportsPreventScroll = canFocusWithoutScroll();
      var fallbackTop = maintainOffset ? sectionTopForHash(hash, { includeGap: false }) : null;
      try {
        if (supportsPreventScroll) target.focus({ preventScroll: true });
        else target.focus();
      } catch (e) {
        target.focus();
      }

      if (maintainOffset && fallbackTop !== null && !supportsPreventScroll) {
        safeScrollTo(fallbackTop, "instant");
      }

      if (shouldRestoreTabIndex) {
        target.addEventListener("blur", function cleanup() {
          target.removeAttribute("tabindex");
          target.removeEventListener("blur", cleanup);
        });
      }
    }

    function scheduleHashScroll(hash, behavior, options) {
      if (!scrollToHash(hash, behavior, options)) return;
      window.requestAnimationFrame(function () { scrollToHash(hash, behavior, options); });
      window.setTimeout(function () {
        var target = hashTarget(hash);
        if (!target) return;
        var top = target.getBoundingClientRect().top;
        var offset = navOffset(options && options.includeGap === false ? 0 : 12);
        if (top >= offset && top <= offset + 24) return;
        scrollToHash(hash, "instant", options);
      }, 220);
    }

    function settleHashNavigation(hash) {
      if (!hash) return;
      var attempts = 0;
      var maxAttempts = 8;
      function runAttempt() {
        attempts += 1;
        var target = hashTarget(hash);
        if (!target) return;
        var offset = navOffset(0);
        var top = target.getBoundingClientRect().top;
        if (top >= offset && top <= offset + 24) return;
        scrollToHash(hash, "instant", { includeGap: false });
        if (attempts < maxAttempts) window.setTimeout(runAttempt, attempts < 3 ? 90 : 220);
      }
      runAttempt();
      window.addEventListener("load", runAttempt, { once: true });
    }

    function storeCrossPageNavIntent(target) {
      if (!target || !target.hash || !target.path) return false;
      try {
        sessionStorage.setItem(NAV_INTENT_KEY, JSON.stringify({ path: target.path, hash: target.hash, ts: Date.now() }));
        return true;
      } catch (e) {
        return false;
      }
    }

    function consumeStoredNavIntent() {
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

    function refreshCurrentPageAria() {
      var allLinks = links.querySelectorAll("a");
      var currentPath = normalizePagePath(window.location.pathname);
      var currentHash = window.location.hash || "";
      for (var i = 0; i < allLinks.length; i++) {
        var link = allLinks[i];
        var target = resolveNavTarget(link.getAttribute("href") || "");
        if (!target || !target.sameOrigin) continue;
        var isCurrent = target.path === currentPath && (!target.hash || target.hash === currentHash);
        if (isCurrent) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    }

    function setupSectionAriaTracking() {
      var samePageLinks = links.querySelectorAll('a[href*="#"]');
      var sectionEntries = [];
      var sectionTops = [];
      var sectionBoundaries = [];
      var activeIndex = -1;
      var navSelectionSession = {
        hash: "",
        index: -1,
        startedAt: 0,
        expiresAt: 0,
        lastScrollAt: 0,
        mismatchSince: 0,
        releaseArmedAt: 0,
        userInterrupted: false,
        rafId: 0,
        timeoutId: 0,
        idleTimeoutId: 0,
        idleHoldMs: 180,
        maxHoldMs: 12000,
        idleGraceMs: 36
      };
      var boundaryHysteresisPx = 56;

      for (var i = 0; i < samePageLinks.length; i++) {
        var sameTarget = resolveNavTarget(samePageLinks[i].getAttribute("href") || "");
        if (!sameTarget || !sameTarget.sameOrigin || !sameTarget.samePath || !sameTarget.hash) continue;
        var hash = sameTarget.hash;
        var section = hashTarget(hash);
        if (!section) continue;
        sectionEntries.push({ hash: hash, section: section, link: samePageLinks[i] });
      }

      if (!sectionEntries.length) return;

      function findSectionEntryByHash(hash) {
        for (var i = 0; i < sectionEntries.length; i++) {
          if (sectionEntries[i].hash === hash) return sectionEntries[i];
        }
        return null;
      }

      function rebuildSectionGeometry() {
        sectionTops = [];
        sectionBoundaries = [];
        for (var i = 0; i < sectionEntries.length; i++) {
          sectionTops.push(Math.max(0, Math.round(sectionEntries[i].section.getBoundingClientRect().top + window.scrollY)));
        }

        for (var j = 0; j < sectionTops.length - 1; j++) {
          sectionBoundaries.push(Math.round((sectionTops[j] + sectionTops[j + 1]) / 2));
        }
      }

      function stopNavSelectionSession() {
        if (navSelectionSession.timeoutId) {
          window.clearTimeout(navSelectionSession.timeoutId);
          navSelectionSession.timeoutId = 0;
        }
        if (navSelectionSession.idleTimeoutId) {
          window.clearTimeout(navSelectionSession.idleTimeoutId);
          navSelectionSession.idleTimeoutId = 0;
        }
        if (navSelectionSession.rafId) {
          window.cancelAnimationFrame(navSelectionSession.rafId);
          navSelectionSession.rafId = 0;
        }

        navSelectionSession.hash = "";
        navSelectionSession.index = -1;
        navSelectionSession.startedAt = 0;
        navSelectionSession.expiresAt = 0;
        navSelectionSession.lastScrollAt = 0;
        navSelectionSession.mismatchSince = 0;
        navSelectionSession.releaseArmedAt = 0;
        navSelectionSession.userInterrupted = false;
      }

      function sectionIndexForHash(hash) {
        if (!hash) return -1;
        for (var i = 0; i < sectionEntries.length; i++) {
          if (sectionEntries[i].hash === hash) return i;
        }
        return -1;
      }

      function markActiveHash(hash) {
        for (var j = 0; j < sectionEntries.length; j++) {
          if (sectionEntries[j].hash === hash) sectionEntries[j].link.setAttribute("aria-current", "page");
          else sectionEntries[j].link.removeAttribute("aria-current");
        }
      }

      function markActiveIndex(index) {
        if (index < 0 || index >= sectionEntries.length) return;
        activeIndex = index;
        markActiveHash(sectionEntries[index].hash);
      }

      function armNavSelectionIdleRelease() {
        if (!navSelectionSession.hash) return;
        if (navSelectionSession.idleTimeoutId) window.clearTimeout(navSelectionSession.idleTimeoutId);
        navSelectionSession.idleTimeoutId = window.setTimeout(function () {
          navSelectionSession.idleTimeoutId = 0;
          if (!navSelectionSession.hash) return;
          detectActiveHash();
        }, navSelectionSession.idleHoldMs + 20);
      }

      function focusedSectionIndex() {
        if (!sectionEntries.length) return -1;

        var navTop = navOffset(0);
        var focusWindowMin = navTop - 8;
        var focusWindowMax = navTop + 84;

        for (var focusedIndex = 0; focusedIndex < sectionEntries.length; focusedIndex++) {
          var sectionTop = Math.round(sectionEntries[focusedIndex].section.getBoundingClientRect().top);
          if (sectionTop >= focusWindowMin && sectionTop <= focusWindowMax) return focusedIndex;
        }

        return -1;
      }

      function shouldReleaseSelectionSession() {
        if (!navSelectionSession.hash) return true;
        var now = Date.now();
        if (navSelectionSession.userInterrupted) return true;
        if (now >= navSelectionSession.expiresAt) return true;

        var focusedIndex = focusedSectionIndex();
        if (focusedIndex !== navSelectionSession.index) {
          if (!navSelectionSession.mismatchSince) navSelectionSession.mismatchSince = now;
          navSelectionSession.releaseArmedAt = 0;
          var mismatchIdle = navSelectionSession.lastScrollAt && now - navSelectionSession.lastScrollAt >= navSelectionSession.idleHoldMs + navSelectionSession.idleGraceMs;
          var mismatchHeldLongEnough = now - navSelectionSession.mismatchSince >= 140;
          if (mismatchIdle && mismatchHeldLongEnough) return true;
          return false;
        }

        navSelectionSession.mismatchSince = 0;

        if (!navSelectionSession.releaseArmedAt) navSelectionSession.releaseArmedAt = now;

        var idleSatisfied = navSelectionSession.lastScrollAt && now - navSelectionSession.lastScrollAt >= navSelectionSession.idleHoldMs + navSelectionSession.idleGraceMs;
        var armedSatisfied = now - navSelectionSession.releaseArmedAt >= navSelectionSession.idleHoldMs;
        return idleSatisfied && armedSatisfied;
      }

      function startNavSelectionSession(hash) {
        if (!hash) {
          stopNavSelectionSession();
          return;
        }

        var index = sectionIndexForHash(hash);
        if (index === -1) return;

        stopNavSelectionSession();
        navSelectionSession.hash = hash;
        navSelectionSession.index = index;
        navSelectionSession.startedAt = Date.now();
        navSelectionSession.expiresAt = navSelectionSession.startedAt + navSelectionSession.maxHoldMs;
        navSelectionSession.lastScrollAt = navSelectionSession.startedAt;
        navSelectionSession.mismatchSince = 0;
        navSelectionSession.releaseArmedAt = 0;
        navSelectionSession.userInterrupted = false;

        navSelectionSession.timeoutId = window.setTimeout(function () {
          stopNavSelectionSession();
          detectActiveHash();
        }, Math.max(0, navSelectionSession.expiresAt - Date.now()));

        function checkSessionSettlement() {
          navSelectionSession.rafId = 0;
          if (!navSelectionSession.hash || navSelectionSession.hash !== hash) return;

          if (shouldReleaseSelectionSession()) {
            stopNavSelectionSession();
            detectActiveHash();
            return;
          }

          navSelectionSession.rafId = window.requestAnimationFrame(checkSessionSettlement);
        }

        navSelectionSession.rafId = window.requestAnimationFrame(checkSessionSettlement);
      }

      function detectActiveIndexFromScroll() {
        if (!sectionEntries.length) return -1;

        var focusedIndex = focusedSectionIndex();
        if (focusedIndex !== -1) return focusedIndex;

        var navTop = navOffset(0);
        var currentScrollY = window.scrollY || 0;
        var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        var anchorTop = Math.max(0, Math.round(currentScrollY + navTop + Math.min(120, Math.max(28, viewportHeight * 0.2))));

        var candidateIndex = 0;
        for (var i = 0; i < sectionBoundaries.length; i++) {
          if (anchorTop < sectionBoundaries[i]) break;
          candidateIndex = i + 1;
        }

        if (activeIndex !== -1 && activeIndex !== candidateIndex) {
          var low = Math.min(activeIndex, candidateIndex);
          var high = Math.max(activeIndex, candidateIndex);
          if (high - low === 1) {
            var boundary = sectionBoundaries[low];
            if (typeof boundary === "number" && Math.abs(anchorTop - boundary) <= boundaryHysteresisPx) return activeIndex;
          }
        }

        return candidateIndex;
      }

      function detectActiveHash() {
        if (navSelectionSession.hash && !shouldReleaseSelectionSession() && findSectionEntryByHash(navSelectionSession.hash)) {
          markActiveIndex(navSelectionSession.index);
          return;
        }
        if (navSelectionSession.hash) stopNavSelectionSession();

        var hashIndex = sectionIndexForHash(window.location.hash || "");
        if (hashIndex !== -1) {
          var navTop = navOffset(0);
          var hashTop = Math.round(sectionEntries[hashIndex].section.getBoundingClientRect().top);
          if (hashTop >= navTop - 20 && hashTop <= navTop + 120) {
            markActiveIndex(hashIndex);
            return;
          }
        }

        markActiveIndex(detectActiveIndexFromScroll());
      }

      var scrollTicking = false;
      function handleScrollAria() {
        if (scrollTicking) return;
        if (navSelectionSession.hash) {
          navSelectionSession.lastScrollAt = Date.now();
          navSelectionSession.releaseArmedAt = 0;
          armNavSelectionIdleRelease();
        }
        scrollTicking = true;
        window.requestAnimationFrame(function () {
          detectActiveHash();
          scrollTicking = false;
        });
      }

      detectActiveHash();
      window.addEventListener("scroll", handleScrollAria, { passive: true });
      window.addEventListener("resize", function () {
        rebuildSectionGeometry();
        detectActiveHash();
      }, { passive: true });
      window.addEventListener("orientationchange", function () {
        rebuildSectionGeometry();
        detectActiveHash();
      }, { passive: true });
      window.addEventListener("load", function () {
        rebuildSectionGeometry();
        detectActiveHash();
      });
      window.addEventListener("hashchange", function () {
        if (window.location.hash) startNavSelectionSession(window.location.hash);
        detectActiveHash();
      });

      window.addEventListener("wheel", function (event) {
        if (event && event.isTrusted && navSelectionSession.hash) navSelectionSession.userInterrupted = true;
      }, { passive: true });
      window.addEventListener("touchstart", function (event) {
        if (event && event.isTrusted && navSelectionSession.hash) navSelectionSession.userInterrupted = true;
      }, { passive: true });
      window.addEventListener("keydown", function (event) {
        var key = event && event.key;
        if (!key) return;
        if (key.indexOf("Arrow") === 0 || key === "PageDown" || key === "PageUp" || key === "Home" || key === "End" || key === " ") {
          if (navSelectionSession.hash) navSelectionSession.userInterrupted = true;
        }
      });

      links.addEventListener("click", function (event) {
        var link = event.target;
        if (!link || typeof link.closest !== "function") return;
        var activeLink = link.closest("a");
        if (!activeLink) return;

        var activeTarget = resolveNavTarget(activeLink.getAttribute("href") || "");
        if (!activeTarget || !activeTarget.sameOrigin || !activeTarget.samePath || !activeTarget.hash) return;

        startNavSelectionSession(activeTarget.hash);
        detectActiveHash();
      });

      if ("onscrollend" in window) {
        window.addEventListener("scrollend", function () {
          if (!navSelectionSession.hash) return;
          if (navSelectionSession.rafId) window.cancelAnimationFrame(navSelectionSession.rafId);
          navSelectionSession.rafId = window.requestAnimationFrame(function () { detectActiveHash(); });
        }, { passive: true });
      }

      rebuildSectionGeometry();
      detectActiveHash();
    }

    if (toggle) toggle.addEventListener("click", function () { setNavState(!links.classList.contains("open")); });

    var items = links.querySelectorAll("a");
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener("click", function (event) {
        var link = event.currentTarget;
        if (shouldBypassClientNavigation(event, link)) {
          setNavState(false);
          return;
        }

        var target = resolveNavTarget(link.getAttribute("href") || "");
        if (!target || !target.sameOrigin) {
          setNavState(false);
          return;
        }

        var shouldDeferNavigation = links.classList.contains("open");
        if (shouldDeferNavigation) setNavState(false);

        function runPostCloseNavigation(action) {
          if (typeof action !== "function") return;
          if (shouldDeferNavigation) {
            window.requestAnimationFrame(function () {
              syncNavMetrics();
              action();
            });
            return;
          }

          action();
        }

        if (target.samePath && target.hash) {
          event.preventDefault();
          runPostCloseNavigation(function () {
            scheduleHashScroll(target.hash, "smooth", { includeGap: false });
            settleHashNavigation(target.hash);
            focusHashTarget(target.hash);
            if (window.location.hash !== target.hash) history.pushState(null, "", target.hash);
            refreshCurrentPageAria();
          });
        } else if (target.samePath && !target.hash) {
          event.preventDefault();
          runPostCloseNavigation(function () {
            safeScrollTo(0, "smooth");
            if (window.location.pathname !== target.path || window.location.search || window.location.hash) history.replaceState(null, "", target.path);
          });
        } else if (!target.samePath && target.hash) {
          event.preventDefault();
          if (storeCrossPageNavIntent(target)) window.location.assign(target.path + (target.search || ""));
          else window.location.assign(target.url);
        }

        if (!shouldDeferNavigation) setNavState(false);
      });
    }

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") setNavState(false);
    });

    document.addEventListener("click", function (event) {
      if (!links.classList.contains("open")) return;
      if ((toggle && toggle.contains(event.target)) || links.contains(event.target)) return;
      setNavState(false);
    });

    window.addEventListener("resize", function () {
      syncNavMetrics();
      if (window.innerWidth > 768) setNavState(false);
    }, { passive: true });
    window.addEventListener("orientationchange", syncNavMetrics, { passive: true });
    window.addEventListener("hashchange", refreshCurrentPageAria);

    syncNavMetrics();
    refreshCurrentPageAria();
    setupSectionAriaTracking();

    if (window.location.hash) {
      window.requestAnimationFrame(function () {
        scheduleHashScroll(window.location.hash, "auto", { includeGap: false });
        settleHashNavigation(window.location.hash);
        focusHashTarget(window.location.hash);
      });
    } else {
      var storedHash = consumeStoredNavIntent();
      if (storedHash) {
        window.requestAnimationFrame(function () {
          scheduleHashScroll(storedHash, "auto", { includeGap: false });
          settleHashNavigation(storedHash);
          focusHashTarget(storedHash);
          if (window.location.hash !== storedHash) {
            try { history.replaceState(null, "", storedHash); } catch (e) {}
          }
          refreshCurrentPageAria();
        });
      }
    }

    if (nav.getAttribute("data-force-scrolled") !== "true") {
      var applyScrolled = function () { nav.classList.toggle("scrolled", window.scrollY > 40); };
      applyScrolled();
      var ticking = false;
      window.addEventListener("scroll", function () {
        if (ticking) return;
        window.requestAnimationFrame(function () { applyScrolled(); ticking = false; });
        ticking = true;
      }, { passive: true });
    } else {
      nav.classList.add("scrolled");
    }

  }

  window.sele4nSetupHeaderNav = setupHeaderNav;
  setupHeaderNav();
})();
