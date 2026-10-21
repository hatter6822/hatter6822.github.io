/* The one theme controller, loaded synchronously in every page's <head> so
   the first paint already carries the right theme. It also owns the toggle
   button and the browser-chrome colour: those used to be wired three times,
   once each in site.js, map.js and run.js, and the copies had drifted (only
   the landing page followed a system theme change). */
(function () {
  "use strict";

  var root = document.documentElement;
  var KEY = "sele4n-theme";

  function saved() {
    var value = null;
    try { value = localStorage.getItem(KEY); } catch (e) {}
    return value === "light" || value === "dark" ? value : null;
  }

  function systemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    var meta = document.getElementById("theme-color-meta");
    if (meta) meta.setAttribute("content", theme === "light" ? "#f8f9fc" : "#0a0e17");
  }

  apply(saved() || systemTheme());

  function wire() {
    // The meta tag sits after this script in <head>, so sync it once parsed.
    apply(root.getAttribute("data-theme") || "dark");
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
        apply(next);
        try { localStorage.setItem(KEY, next); } catch (e) {}
      });
    }
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: light)");
      // Follow the system until the visitor chooses; never persist the
      // system's value, or the first change event would pin it.
      var onChange = function (e) { if (!saved()) apply(e.matches ? "light" : "dark"); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
