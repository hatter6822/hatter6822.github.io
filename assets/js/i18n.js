/**
 * seLe4n i18n — lightweight internationalization runtime.
 *
 * Architecture:
 *   1. Detect preferred locale (URL param > localStorage > navigator.languages)
 *   2. Fetch the locale JSON bundle from /locales/<code>.json
 *   3. Walk the DOM translating elements with data-i18n / data-i18n-* attributes
 *   4. Expose window.sele4nI18n for JS-side translations (map.js, site.js)
 *
 * No third-party code. Public domain-equivalent (same license as the project).
 */
(function () {
  "use strict";

  var STORAGE_KEY = "sele4n-locale-v1";
  var DEFAULT_LOCALE = "en";
  var SUPPORTED_LOCALES = ["en", "es", "fr", "ja", "zh-CN"];
  var LOCALE_LABELS = {
    "en": "English",
    "es": "Espa\u00f1ol",
    "fr": "Fran\u00e7ais",
    "ja": "\u65e5\u672c\u8a9e",
    "zh-CN": "\u4e2d\u6587"
  };

  var currentLocale = DEFAULT_LOCALE;
  var strings = {};
  var pendingCallbacks = [];
  var ready = false;

  /* ── Locale resolution ────────────────────────────────── */

  function resolveLocale() {
    // 1. URL search param ?lang=xx
    try {
      var params = new URLSearchParams(window.location.search);
      var paramLang = params.get("lang");
      if (paramLang && isSupported(paramLang)) return paramLang;
    } catch (e) {}

    // 2. localStorage preference
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && isSupported(stored)) return stored;
    } catch (e) {}

    // 3. Browser languages
    var browserLangs = navigator.languages || [navigator.language || navigator.userLanguage || ""];
    for (var i = 0; i < browserLangs.length; i++) {
      var tag = normalizeLangTag(browserLangs[i]);
      if (isSupported(tag)) return tag;

      // Try base language (e.g. "es-MX" → "es")
      var base = tag.split("-")[0];
      if (isSupported(base)) return base;
    }

    return DEFAULT_LOCALE;
  }

  function normalizeLangTag(tag) {
    if (!tag) return "";
    // BCP 47: language-Script-REGION → lowercase language, titlecase script, uppercase region
    var parts = String(tag).trim().split(/[-_]/);
    if (parts.length === 1) return parts[0].toLowerCase();
    if (parts.length === 2) {
      // Could be lang-region (en-US) or lang-script (zh-Hans)
      if (parts[1].length === 4) {
        // Script subtag
        return parts[0].toLowerCase() + "-" + parts[1].charAt(0).toUpperCase() + parts[1].slice(1).toLowerCase();
      }
      return parts[0].toLowerCase() + "-" + parts[1].toUpperCase();
    }
    // lang-script-region
    return parts[0].toLowerCase() + "-" + parts[1].charAt(0).toUpperCase() + parts[1].slice(1).toLowerCase();
  }

  function isSupported(locale) {
    return SUPPORTED_LOCALES.indexOf(locale) !== -1;
  }

  /* ── String lookup with interpolation ─────────────────── */

  function t(key, vars) {
    var value = lookup(key);
    if (!value) return key;
    if (!vars) return value;

    return value.replace(/\{\{(\w+)\}\}/g, function (match, name) {
      return vars[name] !== undefined ? String(vars[name]) : match;
    });
  }

  function lookup(key) {
    if (!key) return "";
    // Support nested keys: "hero.title" → strings.hero.title
    var parts = key.split(".");
    var obj = strings;
    for (var i = 0; i < parts.length; i++) {
      if (obj === null || obj === undefined || typeof obj !== "object") return "";
      obj = obj[parts[i]];
    }
    return typeof obj === "string" ? obj : "";
  }

  /* ── DOM translation ──────────────────────────────────── */

  function translateDOM() {
    // Translate elements with data-i18n (sets textContent)
    var elements = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var key = el.getAttribute("data-i18n");
      var translated = t(key);
      if (translated && translated !== key) {
        el.textContent = translated;
      }
    }

    // Translate data-i18n-placeholder
    var placeholders = document.querySelectorAll("[data-i18n-placeholder]");
    for (var j = 0; j < placeholders.length; j++) {
      var ph = placeholders[j];
      var phKey = ph.getAttribute("data-i18n-placeholder");
      var phVal = t(phKey);
      if (phVal && phVal !== phKey) {
        ph.setAttribute("placeholder", phVal);
      }
    }

    // Translate data-i18n-aria-label
    var ariaLabels = document.querySelectorAll("[data-i18n-aria-label]");
    for (var k = 0; k < ariaLabels.length; k++) {
      var al = ariaLabels[k];
      var alKey = al.getAttribute("data-i18n-aria-label");
      var alVal = t(alKey);
      if (alVal && alVal !== alKey) {
        al.setAttribute("aria-label", alVal);
      }
    }

    // Translate data-i18n-title
    var titles = document.querySelectorAll("[data-i18n-title]");
    for (var m = 0; m < titles.length; m++) {
      var ti = titles[m];
      var tiKey = ti.getAttribute("data-i18n-title");
      var tiVal = t(tiKey);
      if (tiVal && tiVal !== tiKey) {
        ti.title = tiVal;
      }
    }

    // Translate data-i18n-content (for meta tags)
    var metaTags = document.querySelectorAll("[data-i18n-content]");
    for (var n = 0; n < metaTags.length; n++) {
      var mt = metaTags[n];
      var mtKey = mt.getAttribute("data-i18n-content");
      var mtVal = t(mtKey);
      if (mtVal && mtVal !== mtKey) {
        mt.setAttribute("content", mtVal);
      }
    }

    // Update html lang attribute
    var htmlLang = currentLocale;
    if (htmlLang === "zh-CN") htmlLang = "zh-Hans";
    document.documentElement.setAttribute("lang", htmlLang);

    // Update page title
    var titleKey = document.querySelector("title[data-i18n]");
    // If title has a data-i18n attr it's already been translated above.
    // Otherwise, check if there's a special meta key
    if (!titleKey) {
      var pageTitleKey = document.documentElement.getAttribute("data-i18n-title");
      if (pageTitleKey) {
        var pageTitleVal = t(pageTitleKey);
        if (pageTitleVal && pageTitleVal !== pageTitleKey) {
          document.title = pageTitleVal;
        }
      }
    }
  }

  /* ── Locale loading ───────────────────────────────────── */

  function loadLocale(locale, callback) {
    if (locale === DEFAULT_LOCALE) {
      // English is embedded via data-i18n attributes as fallback text;
      // still load the JSON for JS-side t() calls
    }

    var url = getLocaleUrl(locale);
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "json";

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        var data = xhr.response;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch (e) { data = null; }
        }
        if (data && typeof data === "object") {
          strings = data;
          callback(null);
          return;
        }
      }
      // Fallback: load English
      if (locale !== DEFAULT_LOCALE) {
        loadLocale(DEFAULT_LOCALE, callback);
        return;
      }
      callback(new Error("Failed to load locale: " + locale));
    };

    xhr.onerror = function () {
      if (locale !== DEFAULT_LOCALE) {
        loadLocale(DEFAULT_LOCALE, callback);
        return;
      }
      callback(new Error("Network error loading locale: " + locale));
    };

    xhr.send();
  }

  function getLocaleUrl(locale) {
    // Resolve relative to the page location
    var base = "";
    try {
      var pathname = window.location.pathname;
      var lastSlash = pathname.lastIndexOf("/");
      if (lastSlash > 0) base = pathname.substring(0, lastSlash);
    } catch (e) {}
    return base + "/locales/" + locale + ".json";
  }

  /* ── Language switching ───────────────────────────────── */

  function setLocale(locale) {
    if (!isSupported(locale)) return;
    currentLocale = locale;

    try { localStorage.setItem(STORAGE_KEY, locale); } catch (e) {}

    loadLocale(locale, function (err) {
      if (!err) {
        translateDOM();
        firePendingCallbacks();
        window.dispatchEvent(new CustomEvent("sele4n:locale-changed", {
          detail: { locale: locale }
        }));
      }
    });
  }

  function firePendingCallbacks() {
    ready = true;
    for (var i = 0; i < pendingCallbacks.length; i++) {
      try { pendingCallbacks[i](currentLocale); } catch (e) {}
    }
    pendingCallbacks = [];
  }

  /* ── Public API ───────────────────────────────────────── */

  var api = {
    t: t,
    locale: function () { return currentLocale; },
    setLocale: setLocale,
    supportedLocales: function () { return SUPPORTED_LOCALES.slice(); },
    localeLabels: function () {
      var copy = {};
      for (var k in LOCALE_LABELS) copy[k] = LOCALE_LABELS[k];
      return copy;
    },
    onReady: function (cb) {
      if (ready) { try { cb(currentLocale); } catch (e) {} return; }
      pendingCallbacks.push(cb);
    },
    translateDOM: translateDOM
  };

  window.sele4nI18n = api;

  /* ── Language switcher UI ───────────────────────────────── */

  function initLanguageSwitcher() {
    var btn = document.getElementById("lang-switcher-btn");
    var menu = document.getElementById("lang-switcher-menu");
    var label = document.getElementById("lang-switcher-label");
    if (!btn || !menu) return;

    function updateLabel() {
      if (label) label.textContent = currentLocale.split("-")[0].toUpperCase();
    }

    function buildMenu() {
      menu.innerHTML = "";
      for (var i = 0; i < SUPPORTED_LOCALES.length; i++) {
        var loc = SUPPORTED_LOCALES[i];
        var li = document.createElement("li");
        li.setAttribute("role", "option");
        li.setAttribute("data-locale", loc);
        li.textContent = LOCALE_LABELS[loc] || loc;
        if (loc === currentLocale) {
          li.setAttribute("aria-selected", "true");
          li.classList.add("active");
        }
        li.addEventListener("click", (function (locale) {
          return function () {
            setLocale(locale);
            closeMenu();
            updateLabel();
            buildMenu();
          };
        })(loc));
        menu.appendChild(li);
      }
    }

    function openMenu() {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }

    function closeMenu() {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }

    function toggleMenu() {
      if (menu.hidden) openMenu();
      else closeMenu();
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleMenu();
    });

    document.addEventListener("click", function (e) {
      if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) {
        closeMenu();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) closeMenu();
    });

    window.addEventListener("sele4n:locale-changed", function () {
      updateLabel();
      buildMenu();
    });

    updateLabel();
    buildMenu();
  }

  /* ── Bootstrap ────────────────────────────────────────── */

  currentLocale = resolveLocale();
  loadLocale(currentLocale, function (err) {
    if (!err && currentLocale !== DEFAULT_LOCALE) {
      translateDOM();
    }
    firePendingCallbacks();
  });

  // Initialize language switcher when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLanguageSwitcher);
  } else {
    initLanguageSwitcher();
  }
})();
