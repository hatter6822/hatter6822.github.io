(function () {
  "use strict";

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

  function setupBasicNav() {
    var toggle = document.getElementById("nav-toggle");
    var links = document.getElementById("nav-links");

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
        items[i].addEventListener("click", function () {
          setNavState(false);
        });
      }

      document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        setNavState(false);
      });
    }

    var nav = document.getElementById("nav");
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

  window.SeLe4nUI = {
    setTheme: setTheme,
    setupTheme: setupTheme,
    setupBasicNav: setupBasicNav,
    hardenExternalLinks: hardenExternalLinks
  };
})();
