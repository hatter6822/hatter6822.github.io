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
    var hashNavigationEpoch = 0;
    var prefersReducedMotion = false;
    try {
      var motionMql = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
      if (motionMql) {
        prefersReducedMotion = motionMql.matches;
        if (motionMql.addEventListener) motionMql.addEventListener("change", function (e) { prefersReducedMotion = e.matches; });
      }
    } catch (e) {}

    function beginHashNavigation() {
      hashNavigationEpoch += 1;
      return hashNavigationEpoch;
    }

    function isCurrentHashNavigation(epoch) {
      return epoch === hashNavigationEpoch;
    }

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
      if (prefersReducedMotion) return "auto";
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
      var navEpoch = options && typeof options.navEpoch === "number" ? options.navEpoch : hashNavigationEpoch;
      if (!scrollToHash(hash, behavior, options)) return;
      window.requestAnimationFrame(function () {
        if (!isCurrentHashNavigation(navEpoch)) return;
        scrollToHash(hash, behavior, options);
      });
      window.setTimeout(function () {
        if (!isCurrentHashNavigation(navEpoch)) return;
        var target = hashTarget(hash);
        if (!target) return;
        var top = target.getBoundingClientRect().top;
        var offset = navOffset(options && options.includeGap === false ? 0 : 12);
        if (top >= offset && top <= offset + 24) return;
        scrollToHash(hash, "instant", options);
      }, 220);
    }

    function settleHashNavigation(hash, navEpoch) {
      if (!hash) return;
      var epoch = typeof navEpoch === "number" ? navEpoch : hashNavigationEpoch;
      var attempts = 0;
      var maxAttempts = 8;
      function runAttempt() {
        if (!isCurrentHashNavigation(epoch)) return;
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
      window.addEventListener("load", function onLoad() {
        if (!isCurrentHashNavigation(epoch)) return;
        runAttempt();
      }, { once: true });
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
      var activeIndex = -1;
      var pendingIndex = -1;
      var pendingObservations = 0;
      var geometryRefreshRafId = 0;
      var geometryRefreshTimeoutId = 0;
      var sectionTops = [];
      var hysteresisPx = 36;
      var selectionLock = {
        index: -1,
        hash: "",
        expiresAt: 0,
        timeoutId: 0,
        isUserInterrupted: false,
        startedAt: 0,
        lastScrollAt: 0,
        mismatchSince: 0,
        epoch: 0,
        idleHoldMs: 180,
        mismatchReleaseMs: 140,
        maxHoldMs: 1800
      };

      for (var i = 0; i < samePageLinks.length; i++) {
        var sameTarget = resolveNavTarget(samePageLinks[i].getAttribute("href") || "");
        if (!sameTarget || !sameTarget.sameOrigin || !sameTarget.samePath || !sameTarget.hash) continue;
        var hash = sameTarget.hash;
        var section = hashTarget(hash);
        if (!section) continue;
        sectionEntries.push({ hash: hash, section: section, link: samePageLinks[i] });
      }

      if (!sectionEntries.length) return;

      function sectionIndexForHash(hash) {
        if (!hash) return -1;
        for (var i = 0; i < sectionEntries.length; i++) {
          if (sectionEntries[i].hash === hash) return i;
        }
        return -1;
      }

      function updateSectionTops() {
        sectionTops = [];
        for (var i = 0; i < sectionEntries.length; i++) {
          sectionTops.push(Math.max(0, Math.round(sectionEntries[i].section.getBoundingClientRect().top + window.scrollY)));
        }
      }

      function midBoundary(leftIndex, rightIndex) {
        if (leftIndex < 0 || rightIndex < 0) return null;
        if (leftIndex >= sectionTops.length || rightIndex >= sectionTops.length) return null;
        return Math.round((sectionTops[leftIndex] + sectionTops[rightIndex]) / 2);
      }

      function markActiveIndex(index) {
        if (index < 0 || index >= sectionEntries.length) return;
        activeIndex = index;
        pendingIndex = -1;
        pendingObservations = 0;

        for (var i = 0; i < sectionEntries.length; i++) {
          if (i === index) sectionEntries[i].link.setAttribute("aria-current", "true");
          else sectionEntries[i].link.removeAttribute("aria-current");
        }
      }

      function markCandidateIndex(index, options) {
        if (index < 0 || index >= sectionEntries.length) return;
        if (index === activeIndex) {
          pendingIndex = -1;
          pendingObservations = 0;
          return;
        }

        if (options && options.immediate) {
          markActiveIndex(index);
          return;
        }

        if (pendingIndex !== index) {
          pendingIndex = index;
          pendingObservations = 1;
          return;
        }

        pendingObservations += 1;
        if (pendingObservations >= 2) markActiveIndex(index);
      }

      function clearSelectionLock() {
        if (selectionLock.timeoutId) {
          window.clearTimeout(selectionLock.timeoutId);
          selectionLock.timeoutId = 0;
        }
        selectionLock.index = -1;
        selectionLock.hash = "";
        selectionLock.expiresAt = 0;
        selectionLock.isUserInterrupted = false;
        selectionLock.startedAt = 0;
        selectionLock.lastScrollAt = 0;
        selectionLock.mismatchSince = 0;
      }

      function focusedSectionIndex() {
        var navTop = navOffset(0);
        var minTop = navTop - 8;
        var maxTop = navTop + 96;

        for (var i = 0; i < sectionEntries.length; i++) {
          var top = Math.round(sectionEntries[i].section.getBoundingClientRect().top);
          if (top >= minTop && top <= maxTop) return i;
        }

        return -1;
      }

      function startSelectionLock(hash) {
        var index = sectionIndexForHash(hash);
        if (index === -1) return;

        clearSelectionLock();
        selectionLock.index = index;
        selectionLock.hash = hash;
        selectionLock.isUserInterrupted = false;
        selectionLock.startedAt = Date.now();
        selectionLock.lastScrollAt = selectionLock.startedAt;
        selectionLock.mismatchSince = 0;
        selectionLock.epoch += 1;
        var currentEpoch = selectionLock.epoch;
        selectionLock.expiresAt = selectionLock.startedAt + selectionLock.maxHoldMs;
        markActiveIndex(index);

        selectionLock.timeoutId = window.setTimeout(function () {
          if (selectionLock.index === -1 || selectionLock.epoch !== currentEpoch) return;
          clearSelectionLock();
          detectActiveHash();
        }, selectionLock.maxHoldMs + 20);
      }

      function shouldKeepSelectionLock() {
        if (selectionLock.index === -1) return false;
        if (selectionLock.isUserInterrupted) return false;

        var now = Date.now();
        if (now >= selectionLock.expiresAt) return false;

        var focusIndex = focusedSectionIndex();
        if (focusIndex === selectionLock.index) {
          selectionLock.mismatchSince = 0;
          return (now - selectionLock.lastScrollAt) < selectionLock.idleHoldMs;
        }

        if (focusIndex !== -1 && focusIndex !== selectionLock.index) {
          if (!selectionLock.mismatchSince) selectionLock.mismatchSince = now;
          var mismatchElapsed = now - selectionLock.mismatchSince;
          var idleElapsed = now - selectionLock.lastScrollAt;
          if (mismatchElapsed >= selectionLock.mismatchReleaseMs && idleElapsed >= 40) return false;
          return true;
        }

        selectionLock.mismatchSince = 0;
        return true;
      }

      function preferredIndexFromScrollPosition() {
        if (!sectionEntries.length) return -1;

        var navTop = navOffset(0);
        var scrollAnchor = Math.max(0, Math.round(window.scrollY + navTop));
        var candidate = 0;

        for (var i = 0; i < sectionTops.length; i++) {
          if (scrollAnchor >= sectionTops[i]) candidate = i;
          else break;
        }

        var documentHeight = Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0);
        var viewportBottom = Math.round(window.scrollY + (window.innerHeight || document.documentElement.clientHeight || 0));
        if (viewportBottom >= documentHeight - 4) candidate = sectionEntries.length - 1;

        if (activeIndex === -1 || activeIndex === candidate) return candidate;

        if (candidate > activeIndex) {
          var forwardBoundary = midBoundary(activeIndex, Math.min(sectionEntries.length - 1, activeIndex + 1));
          if (typeof forwardBoundary === "number" && scrollAnchor < forwardBoundary + hysteresisPx) return activeIndex;
          return candidate;
        }

        var backwardBoundary = midBoundary(Math.max(0, activeIndex - 1), activeIndex);
        if (typeof backwardBoundary === "number" && scrollAnchor > backwardBoundary - hysteresisPx) return activeIndex;
        return candidate;
      }

      function detectActiveHash() {
        if (!sectionEntries.length) return;

        if (shouldKeepSelectionLock()) {
          markActiveIndex(selectionLock.index);
          return;
        }

        if (selectionLock.index !== -1) clearSelectionLock();

        var hashIndex = sectionIndexForHash(window.location.hash || "");
        if (hashIndex !== -1) {
          var navTop = navOffset(0);
          var hashTop = Math.round(sectionEntries[hashIndex].section.getBoundingClientRect().top);
          if (hashTop >= navTop - 20 && hashTop <= navTop + 120) {
            markCandidateIndex(hashIndex, { immediate: true });
            return;
          }
        }

        markCandidateIndex(preferredIndexFromScrollPosition());
      }

      function scheduleGeometryRefresh() {
        if (geometryRefreshRafId) return;
        geometryRefreshRafId = window.requestAnimationFrame(function () {
          geometryRefreshRafId = 0;
          updateSectionTops();
          detectActiveHash();
        });
      }

      var scrollTicking = false;
      function handleScrollAria() {
        if (scrollTicking) return;
        if (selectionLock.index !== -1) selectionLock.lastScrollAt = Date.now();
        scrollTicking = true;
        window.requestAnimationFrame(function () {
          detectActiveHash();
          scrollTicking = false;
        });
      }

      function interruptSelectionLock(event) {
        if (event && event.isTrusted && selectionLock.index !== -1) selectionLock.isUserInterrupted = true;
      }

      detectActiveHash();
      window.addEventListener("scroll", handleScrollAria, { passive: true });
      window.addEventListener("resize", function () {
        scheduleGeometryRefresh();
      }, { passive: true });
      window.addEventListener("orientationchange", function () {
        scheduleGeometryRefresh();
      }, { passive: true });
      window.addEventListener("load", function () {
        scheduleGeometryRefresh();
      });
      window.addEventListener("hashchange", function () {
        if (window.location.hash) startSelectionLock(window.location.hash);
        detectActiveHash();
      });

      window.addEventListener("wheel", interruptSelectionLock, { passive: true });
      window.addEventListener("touchstart", interruptSelectionLock, { passive: true });
      window.addEventListener("keydown", function (event) {
        var key = event && event.key;
        if (!key) return;
        if (key.indexOf("Arrow") === 0 || key === "PageDown" || key === "PageUp" || key === "Home" || key === "End" || key === " ") {
          interruptSelectionLock({ isTrusted: true });
        }
      });

      links.addEventListener("click", function (event) {
        var link = event.target;
        if (!link || typeof link.closest !== "function") return;
        var activeLink = link.closest("a");
        if (!activeLink) return;

        var activeTarget = resolveNavTarget(activeLink.getAttribute("href") || "");
        if (!activeTarget || !activeTarget.sameOrigin || !activeTarget.samePath || !activeTarget.hash) return;

        startSelectionLock(activeTarget.hash);
        detectActiveHash();
      });

      if ("onscrollend" in window) {
        window.addEventListener("scrollend", function () {
          detectActiveHash();
        }, { passive: true });
      }

      if (typeof MutationObserver === "function") {
        var mutationObserver = new MutationObserver(function () {
          if (geometryRefreshTimeoutId) window.clearTimeout(geometryRefreshTimeoutId);
          geometryRefreshTimeoutId = window.setTimeout(function () {
            geometryRefreshTimeoutId = 0;
            scheduleGeometryRefresh();
          }, 50);
        });

        mutationObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["style", "class", "hidden", "open", "aria-expanded"]
        });
      }

      if (typeof ResizeObserver === "function") {
        var sectionResizeObserver = new ResizeObserver(function () {
          scheduleGeometryRefresh();
        });
        for (var sectionIndex = 0; sectionIndex < sectionEntries.length; sectionIndex++) {
          sectionResizeObserver.observe(sectionEntries[sectionIndex].section);
        }
      }

      updateSectionTops();
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
          var selectionEpoch = beginHashNavigation();
          runPostCloseNavigation(function () {
            scheduleHashScroll(target.hash, "smooth", { includeGap: false, navEpoch: selectionEpoch });
            settleHashNavigation(target.hash, selectionEpoch);
            focusHashTarget(target.hash);
            if (window.location.hash !== target.hash) history.pushState(null, "", target.hash);
            refreshCurrentPageAria();
          });
        } else if (target.samePath && !target.hash) {
          event.preventDefault();
          beginHashNavigation();
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
        var initialHashEpoch = beginHashNavigation();
        scheduleHashScroll(window.location.hash, "auto", { includeGap: false, navEpoch: initialHashEpoch });
        settleHashNavigation(window.location.hash, initialHashEpoch);
        focusHashTarget(window.location.hash);
      });
    } else {
      var storedHash = consumeStoredNavIntent();
      if (storedHash) {
        window.requestAnimationFrame(function () {
          var storedHashEpoch = beginHashNavigation();
          scheduleHashScroll(storedHash, "auto", { includeGap: false, navEpoch: storedHashEpoch });
          settleHashNavigation(storedHash, storedHashEpoch);
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
