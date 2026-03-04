(function () {
  "use strict";

  var theme = null;
  try {
    theme = localStorage.getItem("sele4n-theme");
  } catch (e) {}

  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
    return;
  }

  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
