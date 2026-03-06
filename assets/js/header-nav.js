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
      var forcedHash = "";
      var forcedHashExpiresAt = 0;
      var forcedHashTimeoutId = 0;
      var forcedHashSettleRafId = 0;
      var settledHash = "";
      var settledHashLockUntil = 0;
      // Locks the selected nav hash while browser scroll settling is still in-flight.
      // This prevents random aria-current oscillation between adjacent sections,
      // especially during smooth-scroll timing differences across engines.
      var navSelectionLockHash = "";
      var navSelectionLockUntil = 0;
      var lastDetectedHash = "";
      var lastScrollYForDetection = window.scrollY || 0;
      var maxForceHashMs = 12000;
      var settleLockMs = 2200;

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

      function stopForcingHash() {
        if (forcedHashTimeoutId) {
          window.clearTimeout(forcedHashTimeoutId);
          forcedHashTimeoutId = 0;
        }
        if (forcedHashSettleRafId) {
          window.cancelAnimationFrame(forcedHashSettleRafId);
          forcedHashSettleRafId = 0;
        }
        forcedHash = "";
        forcedHashExpiresAt = 0;
      }

      function lockNavSelection(hash, durationMs) {
        if (!hash) return;
        navSelectionLockHash = hash;
        navSelectionLockUntil = Date.now() + Math.max(0, Number(durationMs) || 0);
      }

      function clearNavSelectionLock() {
        navSelectionLockHash = "";
        navSelectionLockUntil = 0;
      }

      function startForcingHash(hash) {
        if (!hash) {
          stopForcingHash();
          return;
        }

        if (!findSectionEntryByHash(hash)) return;
        stopForcingHash();
        forcedHash = hash;
        forcedHashExpiresAt = Date.now() + maxForceHashMs;
        lockNavSelection(hash, maxForceHashMs);
        settledHash = "";
        settledHashLockUntil = 0;
        forcedHashTimeoutId = window.setTimeout(function () {
          stopForcingHash();
          clearNavSelectionLock();
          detectActiveHash();
        }, maxForceHashMs);
      }

      function markActiveHash(hash) {
        for (var j = 0; j < sectionEntries.length; j++) {
          if (sectionEntries[j].hash === hash) sectionEntries[j].link.setAttribute("aria-current", "page");
          else sectionEntries[j].link.removeAttribute("aria-current");
        }
      }

      function sectionIndexForHash(hash) {
        if (!hash) return -1;
        for (var i = 0; i < sectionEntries.length; i++) {
          if (sectionEntries[i].hash === hash) return i;
        }
        return -1;
      }

      function detectActiveHashFromScroll() {
        var currentScrollY = window.scrollY || 0;
        var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        var anchorTop = Math.max(0, Math.round(currentScrollY + navOffset(0) + Math.min(120, Math.max(24, viewportHeight * 0.2))));
        var scrollYNow = currentScrollY;
        var direction = 0;
        if (scrollYNow > lastScrollYForDetection + 1) direction = 1;
        else if (scrollYNow < lastScrollYForDetection - 1) direction = -1;
        lastScrollYForDetection = scrollYNow;

        var bestHash = sectionEntries[0] ? sectionEntries[0].hash : null;
        var bestIndex = sectionEntries.length ? 0 : -1;
        var bestTop = -Infinity;
        var sectionTops = [];
        for (var i = 0; i < sectionEntries.length; i++) {
          var top = Math.max(0, Math.round(sectionEntries[i].section.getBoundingClientRect().top + window.scrollY));
          sectionTops.push(top);
          if (top <= anchorTop && top >= bestTop) {
            bestTop = top;
            bestHash = sectionEntries[i].hash;
            bestIndex = i;
          }
        }

        if (bestHash && lastDetectedHash && bestHash !== lastDetectedHash) {
          var lastIndex = sectionIndexForHash(lastDetectedHash);
          if (lastIndex !== -1 && bestIndex !== -1) {
            var hysteresisPx = 28;
            if (direction >= 0 && bestIndex > lastIndex) {
              if (anchorTop < sectionTops[bestIndex] + hysteresisPx) return lastDetectedHash;
            } else if (direction <= 0 && bestIndex < lastIndex) {
              if (anchorTop > sectionTops[lastIndex] - hysteresisPx) return lastDetectedHash;
            }
          }
        }

        return bestHash;
      }

      function lockActiveHash(hash, durationMs) {
        if (!hash) return;
        settledHash = hash;
        settledHashLockUntil = Date.now() + Math.max(0, Number(durationMs) || 0);
      }

      function clearActiveHashLock() {
        settledHash = "";
        settledHashLockUntil = 0;
      }

      function scheduleForcedHashSettleCheck(hash) {
        if (!hash || forcedHash !== hash) return;
        if (forcedHashSettleRafId) window.cancelAnimationFrame(forcedHashSettleRafId);

        var stablePasses = 0;
        var previousY = window.scrollY;
        var lastMovementAt = Date.now();
        var requiredIdleMs = 170;
        var requiredStablePasses = 2;

        function check() {
          forcedHashSettleRafId = 0;
          if (forcedHash !== hash) return;

          var entry = findSectionEntryByHash(hash);
          if (!entry) {
            stopForcingHash();
            detectActiveHash();
            return;
          }

          var currentY = window.scrollY;
          if (Math.abs(currentY - previousY) <= 1) {
            // no-op
          } else {
            lastMovementAt = Date.now();
          }
          previousY = currentY;

          var expectedTop = navOffset(0);
          var currentTop = Math.round(entry.section.getBoundingClientRect().top);
          var withinTarget = Math.abs(currentTop - expectedTop) <= 8;
          var idleLongEnough = Date.now() - lastMovementAt >= requiredIdleMs;

          if (withinTarget && idleLongEnough) stablePasses += 1;
          else stablePasses = 0;

          if (stablePasses >= requiredStablePasses) {
            lockActiveHash(hash, settleLockMs);
            lockNavSelection(hash, settleLockMs);
            stopForcingHash();
            detectActiveHash();
            return;
          }

          if (Date.now() >= forcedHashExpiresAt) {
            stopForcingHash();
            detectActiveHash();
            return;
          }

          forcedHashSettleRafId = window.requestAnimationFrame(check);
        }

        forcedHashSettleRafId = window.requestAnimationFrame(check);
      }

      function detectActiveHash() {
        if (navSelectionLockHash && Date.now() <= navSelectionLockUntil && findSectionEntryByHash(navSelectionLockHash)) {
          markActiveHash(navSelectionLockHash);
          lastDetectedHash = navSelectionLockHash;
          return;
        }
        if (navSelectionLockHash) clearNavSelectionLock();

        if (forcedHash && Date.now() <= forcedHashExpiresAt) {
          markActiveHash(forcedHash);
          lastDetectedHash = forcedHash;
          return;
        }
        if (forcedHash) stopForcingHash();

        if (settledHash && Date.now() <= settledHashLockUntil && findSectionEntryByHash(settledHash)) {
          markActiveHash(settledHash);
          lastDetectedHash = settledHash;
          return;
        }
        if (settledHash) clearActiveHashLock();

        var activeHash = detectActiveHashFromScroll();
        if (activeHash) {
          markActiveHash(activeHash);
          lastDetectedHash = activeHash;
        }
      }

      var scrollTicking = false;
      function handleScrollAria() {
        if (scrollTicking) return;
        scrollTicking = true;
        window.requestAnimationFrame(function () {
          detectActiveHash();
          scrollTicking = false;
        });
      }

      detectActiveHash();
      window.addEventListener("scroll", handleScrollAria, { passive: true });
      window.addEventListener("resize", function () {
        detectActiveHash();
      }, { passive: true });
      window.addEventListener("orientationchange", function () {
        detectActiveHash();
      }, { passive: true });
      window.addEventListener("load", function () {
        detectActiveHash();
      });
      window.addEventListener("hashchange", function () {
        if (window.location.hash) {
          startForcingHash(window.location.hash);
          if (forcedHash) {
            markActiveHash(forcedHash);
            lastDetectedHash = forcedHash;
            scheduleForcedHashSettleCheck(forcedHash);
          } else detectActiveHash();
        }
        else detectActiveHash();
      });

      window.addEventListener("wheel", function () {
        stopForcingHash();
        clearNavSelectionLock();
        clearActiveHashLock();
      }, { passive: true });
      window.addEventListener("touchstart", function () {
        stopForcingHash();
        clearNavSelectionLock();
        clearActiveHashLock();
      }, { passive: true });
      window.addEventListener("keydown", function (event) {
        var key = event && event.key;
        if (!key) return;
        if (key.indexOf("Arrow") === 0 || key === "PageDown" || key === "PageUp" || key === "Home" || key === "End" || key === " ") {
          stopForcingHash();
          clearNavSelectionLock();
          clearActiveHashLock();
        }
      });

      links.addEventListener("click", function (event) {
        var link = event.target;
        if (!link || typeof link.closest !== "function") return;
        var activeLink = link.closest("a");
        if (!activeLink) return;

        var activeTarget = resolveNavTarget(activeLink.getAttribute("href") || "");
        if (!activeTarget || !activeTarget.sameOrigin || !activeTarget.samePath || !activeTarget.hash) return;

        clearActiveHashLock();
        startForcingHash(activeTarget.hash);
        lockNavSelection(activeTarget.hash, maxForceHashMs);
        markActiveHash(activeTarget.hash);
        lastDetectedHash = activeTarget.hash;
        scheduleForcedHashSettleCheck(activeTarget.hash);
      });

      if ("onscrollend" in window) {
        window.addEventListener("scrollend", function () {
          if (!forcedHash) return;
          scheduleForcedHashSettleCheck(forcedHash);
        }, { passive: true });
      }
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
