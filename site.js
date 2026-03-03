(function () {
  'use strict';

  var FALLBACK = {
    version: '0.12.16',
    leanVersion: '4.28.0',
    modules: 35,
    lines: '21,641',
    theorems: 577,
    scripts: 17,
    docs: 97,
    buildJobs: 70,
    admitted: 0,
    syncedAt: '2026-02-16'
  };

  var REPO = 'hatter6822/seLe4n';
  var RAW = 'https://raw.githubusercontent.com/' + REPO + '/main/';
  var API = 'https://api.github.com/repos/' + REPO;
  var SEARCH = 'https://api.github.com/search/code';
  var CACHE_KEY = 'sele4n-live';
  var CACHE_TTL = 30 * 60 * 1000;

  function update(key, value) {
    var els = document.querySelectorAll('[data-live="' + key + '"]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].textContent !== String(value)) {
        els[i].textContent = value;
      }
    }
  }

  function applyData(d) {
    update('version', d.version);
    update('lean-version', d.leanVersion);
    update('modules', d.modules);
    update('lines', d.lines);
    update('theorems', d.theorems);
    update('scripts', d.scripts);
    update('docs', d.docs);
    update('build-jobs', d.buildJobs);
    update('admitted', d.admitted);

    var synced = document.getElementById('stats-synced-at');
    if (synced && d.syncedAt) {
      synced.textContent = d.syncedAt;
      synced.dateTime = d.syncedAt;
    }

    if (d.version) {
      var ld = document.querySelector('script[type="application/ld+json"]');
      if (ld) {
        try {
          var obj = JSON.parse(ld.textContent);
          obj.version = d.version;
          ld.textContent = JSON.stringify(obj, null, 2);
        } catch (e) {}
      }
    }
  }

  function formatNumber(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function setTheme(theme) {
    var root = document.documentElement;
    var themeColorMeta = document.getElementById('theme-color-meta');
    root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('sele4n-theme', theme);
    } catch (e) {}
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', theme === 'light' ? '#f8f9fc' : '#0a0e17');
    }
  }

  function setupTheme() {
    var root = document.documentElement;
    var themeToggle = document.getElementById('theme-toggle');
    var currentTheme = root.getAttribute('data-theme');
    if (!currentTheme) {
      setTheme('dark');
    }

    if (themeToggle) {
      themeToggle.addEventListener('click', function () {
        var current = root.getAttribute('data-theme') || 'dark';
        setTheme(current === 'dark' ? 'light' : 'dark');
      });
    }

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var onChange = function (e) {
        var saved = null;
        try { saved = localStorage.getItem('sele4n-theme'); } catch (err) {}
        if (!saved) setTheme(e.matches ? 'light' : 'dark');
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  function setupNav() {
    var toggle = document.getElementById('nav-toggle');
    var links = document.getElementById('nav-links');
    if (toggle && links) {
      toggle.addEventListener('click', function () {
        var open = links.classList.toggle('open');
        toggle.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open);
      });

      var items = links.querySelectorAll('a');
      for (var i = 0; i < items.length; i++) {
        items[i].addEventListener('click', function () {
          links.classList.remove('open');
          toggle.classList.remove('open');
          toggle.setAttribute('aria-expanded', 'false');
        });
      }
    }

    var nav = document.getElementById('nav');
    if (!nav) return;
    var applyScrolled = function () {
      nav.classList.toggle('scrolled', window.scrollY > 40);
    };
    applyScrolled();

    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      window.requestAnimationFrame(function () {
        applyScrolled();
        ticking = false;
      });
      ticking = true;
    }, { passive: true });
  }

  function getCached() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (Date.now() - obj.ts > CACHE_TTL) return null;
      return obj.data;
    } catch (e) {
      return null;
    }
  }

  function setCache(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) {}
  }

  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    });
  }

  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  function fetchLiveData() {
    var data = { syncedAt: new Date().toISOString().slice(0, 10), admitted: 0 };
    var tasks = [];

    tasks.push(fetchText(RAW + 'lean-toolchain').then(function (text) {
      var m = text.match(/(\d+\.\d+\.\d+)/);
      if (m) data.leanVersion = m[1];
    }).catch(function () {}));

    tasks.push(fetchText(RAW + 'lakefile.toml').then(function (text) {
      var m = text.match(/version\s*=\s*"([^"]+)"/);
      if (m) data.version = m[1];
    }).catch(function () {}));

    tasks.push(fetchJSON(API + '/git/trees/main?recursive=1').then(function (tree) {
      if (!tree.tree) return;
      var modules = 0, scripts = 0, docs = 0;
      for (var i = 0; i < tree.tree.length; i++) {
        var item = tree.tree[i];
        var p = item.path;
        if (item.type !== 'blob') continue;
        if (/^SeLe4n\/.*\.lean$/.test(p) && !/^SeLe4n\/Testing\//.test(p)) modules++;
        if (/^scripts\/.*\.sh$/.test(p)) scripts++;
        if (/^docs\/.*\.(md|txt)$/.test(p)) docs++;
      }
      data.modules = modules;
      data.scripts = scripts;
      data.docs = docs;
      data.buildJobs = modules * 2;
    }).catch(function () {}));

    tasks.push(fetchJSON(API + '/languages').then(function (langs) {
      if (langs && langs.Lean) {
        data.lines = formatNumber(Math.round(langs.Lean / 38));
      }
    }).catch(function () {}));

    tasks.push(fetchJSON(SEARCH + '?q=%22theorem+%22+repo:' + REPO + '+language:lean').then(function (res) {
      if (res && typeof res.total_count === 'number') data.theorems = res.total_count;
    }).catch(function () {}));

    return Promise.all(tasks).then(function () { return data; });
  }

  function maybeRefreshLiveData() {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.saveData) return;

    var cached = getCached();
    if (cached) {
      applyData(cached);
      return;
    }

    fetchLiveData().then(function (data) {
      var hasData = false;
      for (var k in data) {
        if (Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined) {
          hasData = true;
          break;
        }
      }
      if (!hasData) return;
      setCache(data);
      applyData(data);
    }).catch(function () {});
  }

  applyData(FALLBACK);
  setupTheme();
  setupNav();

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(maybeRefreshLiveData);
  } else {
    setTimeout(maybeRefreshLiveData, 1);
  }
})();
