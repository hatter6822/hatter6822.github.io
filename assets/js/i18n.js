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

  function applyTranslation(el, key, setter) {
    var translated = t(key);
    if (translated && translated !== key) setter(el, translated);
  }

  function translateDOM() {
    // data-i18n → textContent (plain text elements)
    var elements = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < elements.length; i++) {
      applyTranslation(elements[i], elements[i].getAttribute("data-i18n"), function (el, v) {
        el.textContent = v;
      });
    }

    // data-i18n-html → innerHTML (elements containing inline markup)
    var htmlEls = document.querySelectorAll("[data-i18n-html]");
    for (var h = 0; h < htmlEls.length; h++) {
      applyTranslation(htmlEls[h], htmlEls[h].getAttribute("data-i18n-html"), function (el, v) {
        el.innerHTML = v;
      });
    }

    // data-i18n-placeholder
    var placeholders = document.querySelectorAll("[data-i18n-placeholder]");
    for (var j = 0; j < placeholders.length; j++) {
      applyTranslation(placeholders[j], placeholders[j].getAttribute("data-i18n-placeholder"), function (el, v) {
        el.setAttribute("placeholder", v);
      });
    }

    // data-i18n-aria-label
    var ariaLabels = document.querySelectorAll("[data-i18n-aria-label]");
    for (var k = 0; k < ariaLabels.length; k++) {
      applyTranslation(ariaLabels[k], ariaLabels[k].getAttribute("data-i18n-aria-label"), function (el, v) {
        el.setAttribute("aria-label", v);
      });
    }

    // data-i18n-title
    var titles = document.querySelectorAll("[data-i18n-title]");
    for (var m = 0; m < titles.length; m++) {
      applyTranslation(titles[m], titles[m].getAttribute("data-i18n-title"), function (el, v) {
        el.title = v;
      });
    }

    // data-i18n-content (meta tags)
    var metaTags = document.querySelectorAll("[data-i18n-content]");
    for (var n = 0; n < metaTags.length; n++) {
      applyTranslation(metaTags[n], metaTags[n].getAttribute("data-i18n-content"), function (el, v) {
        el.setAttribute("content", v);
      });
    }

    // Update html lang attribute
    var htmlLang = currentLocale;
    if (htmlLang === "zh-CN") htmlLang = "zh-Hans";
    document.documentElement.setAttribute("lang", htmlLang);

    // Update page title from <html data-i18n-title>
    var pageTitleKey = document.documentElement.getAttribute("data-i18n-title");
    if (pageTitleKey) {
      var pageTitleVal = t(pageTitleKey);
      if (pageTitleVal && pageTitleVal !== pageTitleKey) {
        document.title = pageTitleVal;
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
    xhr.timeout = 8000;

    xhr.ontimeout = function () {
      if (locale !== DEFAULT_LOCALE) {
        loadLocale(DEFAULT_LOCALE, callback);
        return;
      }
      callback(new Error("Timeout loading locale: " + locale));
    };

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
        li.setAttribute("tabindex", "-1");
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

    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        openMenu();
        focusItem(0);
      }
    });

    document.addEventListener("click", function (e) {
      if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) {
        closeMenu();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) {
        closeMenu();
        btn.focus();
      }
    });

    menu.addEventListener("keydown", function (e) {
      var items = menu.querySelectorAll("li[role='option']");
      if (!items.length) return;
      var idx = Array.prototype.indexOf.call(items, document.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusItem(idx < items.length - 1 ? idx + 1 : 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusItem(idx > 0 ? idx - 1 : items.length - 1);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (idx >= 0) items[idx].click();
      } else if (e.key === "Tab") {
        closeMenu();
      }
    });

    function focusItem(idx) {
      var items = menu.querySelectorAll("li[role='option']");
      if (items[idx]) items[idx].focus();
    }

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
    if (!err) translateDOM();
    firePendingCallbacks();
  });

  // Initialize language switcher when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLanguageSwitcher);
  } else {
    initLanguageSwitcher();
  }
})();
