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

    function navOffset() {
      return Math.ceil((nav.getBoundingClientRect().height || 0) + 12);
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

    function scrollToHash(hash, behavior) {
      var target = hashTarget(hash);
      if (!target) return false;
      var targetTop = target.getBoundingClientRect().top + window.scrollY - navOffset();
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
      var fallbackTop = maintainOffset ? target.getBoundingClientRect().top + window.scrollY - navOffset() : null;
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

    function scheduleHashScroll(hash, behavior) {
      if (!scrollToHash(hash, behavior)) return;
      window.requestAnimationFrame(function () { scrollToHash(hash, behavior); });
      window.setTimeout(function () {
        var target = hashTarget(hash);
        if (!target) return;
        var top = target.getBoundingClientRect().top;
        var offset = navOffset();
        if (top >= offset && top <= offset + 24) return;
        scrollToHash(hash, "instant");
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
        var offset = navOffset();
        var top = target.getBoundingClientRect().top;
        if (top >= offset && top <= offset + 24) return;
        scrollToHash(hash, "instant");
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
            scheduleHashScroll(target.hash, "smooth");
            settleHashNavigation(target.hash);
            focusHashTarget(target.hash);
            if (window.location.hash !== target.hash) history.pushState(null, "", target.hash);
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

    if (window.location.hash) {
      window.requestAnimationFrame(function () {
        scheduleHashScroll(window.location.hash, "auto");
        settleHashNavigation(window.location.hash);
        focusHashTarget(window.location.hash);
      });
    } else {
      var storedHash = consumeStoredNavIntent();
      if (storedHash) {
        window.requestAnimationFrame(function () {
          scheduleHashScroll(storedHash, "auto");
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

    if (typeof IntersectionObserver === "function") {
      var samePageLinks = nav.querySelectorAll('a[href*="#"]');
      var sectionMap = Object.create(null);
      for (var j = 0; j < samePageLinks.length; j++) {
        var sameTarget = resolveNavTarget(samePageLinks[j].getAttribute("href") || "");
        if (!sameTarget || !sameTarget.sameOrigin || !sameTarget.samePath || !sameTarget.hash) continue;
        sectionMap[sameTarget.hash.slice(1)] = samePageLinks[j];
      }

      var observer = new IntersectionObserver(function (entries) {
        for (var k = 0; k < entries.length; k++) {
          if (!entries[k].isIntersecting) continue;
          var active = sectionMap[entries[k].target.id];
          if (!active) continue;
          var keys = Object.keys(sectionMap);
          for (var m = 0; m < keys.length; m++) sectionMap[keys[m]].removeAttribute("aria-current");
          active.setAttribute("aria-current", "page");
        }
      }, { rootMargin: "-30% 0px -60% 0px", threshold: 0.01 });

      var ids = Object.keys(sectionMap);
      for (var n = 0; n < ids.length; n++) {
        var section = document.getElementById(ids[n]);
        if (section) observer.observe(section);
      }
    }
  }

  window.sele4nSetupHeaderNav = setupHeaderNav;
  setupHeaderNav();
})();
