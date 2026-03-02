/**
 * background-pattern.js
 *
 * Animated mathematical background using evolving Clifford strange attractors.
 * Renders overlapping attractor density clouds on a tall canvas that scrolls
 * with the page, creating a living, depth-aware backdrop.
 *
 * Features:
 *   - 5 attractor clusters distributed vertically for scroll-aware visuals
 *   - Smooth proportional scroll-following (background drifts with the page)
 *   - Organic Lissajous drift animation (x / y / rotation / scale)
 *   - Dual-canvas crossfade for seamless pattern morphing (every 6 s)
 *   - Off-thread rendering via inline Web Worker
 *   - Theme-aware coloring (dark / light)
 *   - Accessibility: respects prefers-reduced-motion
 *   - Responsive: adapts to resize and theme changes
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     Configuration
     ═══════════════════════════════════════════════════════════ */
  var HEIGHT_SCALE      = 3;       // Canvas is rendered 3× viewport tall
  var RES_SCALE         = 0.4;     // 40 % of native res (soft, performant)
  var MOVER_CSS_HEIGHT  = 3.5;     // Matches CSS height: 350 %
  var EVOLVE_INTERVAL   = 6000;    // Morph cycle (ms)

  /* ═══════════════════════════════════════════════════════════
     DOM references
     ═══════════════════════════════════════════════════════════ */
  var canvasA = document.getElementById('math-bg-a');
  var canvasB = document.getElementById('math-bg-b');
  var mover   = document.getElementById('bg-canvas-mover');
  if (!canvasA || !canvasB || !mover) return;

  var ctxA = canvasA.getContext('2d');
  var ctxB = canvasB.getContext('2d');

  /* ═══════════════════════════════════════════════════════════
     State
     ═══════════════════════════════════════════════════════════ */
  var w = 0, h = 0;                // canvas pixel dimensions
  var activeSlot     = 'a';
  var pendingRender  = false;
  var worker         = null;
  var evolutionTimer = null;
  var resizeTimer    = null;
  var startTime      = performance.now();
  var smoothScrollY  = 0;          // spring-smoothed scroll offset
  var scrollVel      = 0;          // scroll spring velocity

  var prefersReduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ═══════════════════════════════════════════════════════════
     Inline Web Worker — computes attractors off the main thread
     ═══════════════════════════════════════════════════════════ */
  var workerCode = function () {
    self.onmessage = function (e) {
      var d = e.data;
      var w = d.w, h = d.h, isDark = d.isDark, time = d.time;
      var heightScale = d.heightScale;
      var size = w * h;

      // Accumulation buffers (one per colour channel)
      var bR = new Float32Array(size);
      var bG = new Float32Array(size);
      var bB = new Float32Array(size);

      var cx   = w * 0.5;
      var viewH = h / heightScale;               // one viewport in pixels
      var sc   = Math.min(w, viewH) * 0.24;      // base attractor scale
      var t    = time / 1000;

      /* ── 5 attractor clusters, spread vertically ─────────── */
      var clusters = [
        { cy: h * 0.10, a: -1.4, b:  1.6, c:  1.0, d:  0.7, n: 90000, sm: 1.00 },
        { cy: h * 0.30, a:  1.5, b: -1.8, c:  1.6, d:  0.9, n: 82000, sm: 0.95 },
        { cy: h * 0.50, a: -2.0, b: -2.0, c: -1.2, d:  2.0, n: 82000, sm: 1.05 },
        { cy: h * 0.70, a:  1.7, b:  1.2, c: -1.4, d: -1.6, n: 78000, sm: 0.92 },
        { cy: h * 0.90, a: -1.1, b:  1.9, c:  0.8, d: -1.3, n: 68000, sm: 1.00 }
      ];

      /* Per-cluster oscillation frequencies and amplitudes */
      var freqs = [
        { a: 0.083, b: 0.097, c: 0.071, d: 0.061 },
        { a: 0.073, b: 0.089, c: 0.067, d: 0.079 },
        { a: 0.091, b: 0.077, c: 0.059, d: 0.103 },
        { a: 0.069, b: 0.101, c: 0.083, d: 0.071 },
        { a: 0.079, b: 0.063, c: 0.097, d: 0.087 }
      ];
      var amps = [
        { a: 0.15, b: 0.12, c: 0.10, d: 0.08 },
        { a: 0.12, b: 0.15, c: 0.10, d: 0.08 },
        { a: 0.13, b: 0.14, c: 0.11, d: 0.09 },
        { a: 0.14, b: 0.10, c: 0.13, d: 0.07 },
        { a: 0.11, b: 0.13, c: 0.09, d: 0.12 }
      ];

      /* Theme-aware palette (3 colours cycled across 5 clusters) */
      var palette = [
        { r: isDark ? 91 : 43,   g: isDark ? 160 : 111, b: isDark ? 245 : 208 },
        { r: isDark ? 78 : 22,   g: isDark ? 201 : 128, b: isDark ? 137 : 75  },
        { r: isDark ? 198 : 124, g: isDark ? 120 : 58,  b: isDark ? 221 : 237 }
      ];

      var colorPhase = t * 0.03;

      /* ── Iterate each cluster ────────────────────────────── */
      for (var cl = 0; cl < clusters.length; cl++) {
        var C = clusters[cl], F = freqs[cl], A = amps[cl];
        var col     = palette[cl % palette.length];
        var localSc = sc * C.sm;

        // Evolving Clifford parameters
        var a  = C.a + Math.sin(t * F.a) * A.a;
        var b  = C.b + Math.cos(t * F.b) * A.b;
        var c  = C.c + Math.sin(t * F.c) * A.c;
        var dd = C.d + Math.cos(t * F.d) * A.d;

        // Colour shift
        var shift = Math.sin(colorPhase + cl * 1.257) * 0.14;
        var cr = Math.max(0, Math.min(255, col.r * (1 + shift)));
        var cg = Math.max(0, Math.min(255, col.g * (1 - shift * 0.5)));
        var cb = Math.max(0, Math.min(255, col.b * (1 + shift * 0.3)));

        // Per-cluster horizontal wander
        var ox = Math.sin(cl * 2.4 + t * 0.013) * w * 0.07;

        var n = C.n;
        var x = 0.1, y = 0.1;
        for (var i = 0; i < n; i++) {
          var nx = Math.sin(a * y) + c * Math.cos(a * x);
          var ny = Math.sin(b * x) + dd * Math.cos(b * y);
          x = nx; y = ny;
          if (i < 50) continue;                     // skip transient

          var px = (cx + ox + x * localSc) | 0;
          var py = (C.cy + y * localSc) | 0;

          if (px >= 0 && px < w && py >= 0 && py < h) {
            var idx = py * w + px;
            bR[idx] += cr;
            bG[idx] += cg;
            bB[idx] += cb;
          }
        }
      }

      /* ── Log-scale normalisation + gamma correction ──────── */
      var maxV = 0;
      for (var i = 0; i < size; i++) {
        var v = bR[i] + bG[i] + bB[i];
        if (v > maxV) maxV = v;
      }
      if (maxV === 0) { self.postMessage({ pixels: null }); return; }

      var pixels = new Uint8ClampedArray(size * 4);
      var alpha  = isDark ? 0.85 : 0.55;
      var logMax = Math.log(1 + maxV);

      for (var i = 0; i < size; i++) {
        var total = bR[i] + bG[i] + bB[i];
        if (total > 0) {
          var t2 = Math.pow(Math.log(1 + total) / logMax, 0.6);
          var j  = i * 4;
          pixels[j]     = Math.min(255, (bR[i] / total * 255 * t2 + 0.5) | 0);
          pixels[j + 1] = Math.min(255, (bG[i] / total * 255 * t2 + 0.5) | 0);
          pixels[j + 2] = Math.min(255, (bB[i] / total * 255 * t2 + 0.5) | 0);
          pixels[j + 3] = Math.min(255, (t2 * 255 * alpha + 0.5) | 0);
        }
      }

      self.postMessage({ pixels: pixels.buffer, w: w, h: h }, [pixels.buffer]);
    };
  };

  /* Create worker from inline function (Blob URL) */
  try {
    var blob    = new Blob(['(' + workerCode.toString() + ')()'], { type: 'text/javascript' });
    var blobUrl = URL.createObjectURL(blob);
    worker      = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);
  } catch (e) { worker = null; }

  /* ═══════════════════════════════════════════════════════════
     Canvas sizing — half-res × HEIGHT_SCALE
     ═══════════════════════════════════════════════════════════ */
  function setupCanvases() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, Math.floor(window.innerWidth  * dpr * RES_SCALE));
    h = Math.max(1, Math.floor(window.innerHeight * dpr * RES_SCALE * HEIGHT_SCALE));
    canvasA.width  = w; canvasA.height = h;
    canvasB.width  = w; canvasB.height = h;
  }

  /* ═══════════════════════════════════════════════════════════
     Render attractor to a canvas slot
     ═══════════════════════════════════════════════════════════ */
  function renderSlot(slot, time, cb) {
    var ctx    = slot === 'a' ? ctxA : ctxB;
    var isDark = document.documentElement.getAttribute('data-theme') !== 'light';

    if (worker) {
      worker.onmessage = function (e) {
        if (e.data.pixels) {
          var arr = new Uint8ClampedArray(e.data.pixels);
          ctx.putImageData(new ImageData(arr, e.data.w, e.data.h), 0, 0);
        }
        if (cb) cb();
      };
      worker.postMessage({ w: w, h: h, isDark: isDark, time: time, heightScale: HEIGHT_SCALE });
    } else {
      renderFallback(ctx, time, isDark);
      if (cb) cb();
    }
  }

  /* ═══════════════════════════════════════════════════════════
     Main-thread fallback (browsers without Worker support)
     ═══════════════════════════════════════════════════════════ */
  function renderFallback(ctx, time, isDark) {
    var size = w * h;
    var bR = new Float32Array(size);
    var bG = new Float32Array(size);
    var bB = new Float32Array(size);

    var cx   = w * 0.5;
    var viewH = h / HEIGHT_SCALE;
    var sc   = Math.min(w, viewH) * 0.24;
    var t    = time / 1000;

    var clusters = [
      { cy: h * 0.10, a: -1.4, b:  1.6, c:  1.0, d:  0.7, n: 90000, sm: 1.00 },
      { cy: h * 0.30, a:  1.5, b: -1.8, c:  1.6, d:  0.9, n: 82000, sm: 0.95 },
      { cy: h * 0.50, a: -2.0, b: -2.0, c: -1.2, d:  2.0, n: 82000, sm: 1.05 },
      { cy: h * 0.70, a:  1.7, b:  1.2, c: -1.4, d: -1.6, n: 78000, sm: 0.92 },
      { cy: h * 0.90, a: -1.1, b:  1.9, c:  0.8, d: -1.3, n: 68000, sm: 1.00 }
    ];
    var freqs = [
      { a: 0.083, b: 0.097, c: 0.071, d: 0.061 },
      { a: 0.073, b: 0.089, c: 0.067, d: 0.079 },
      { a: 0.091, b: 0.077, c: 0.059, d: 0.103 },
      { a: 0.069, b: 0.101, c: 0.083, d: 0.071 },
      { a: 0.079, b: 0.063, c: 0.097, d: 0.087 }
    ];
    var amps = [
      { a: 0.15, b: 0.12, c: 0.10, d: 0.08 },
      { a: 0.12, b: 0.15, c: 0.10, d: 0.08 },
      { a: 0.13, b: 0.14, c: 0.11, d: 0.09 },
      { a: 0.14, b: 0.10, c: 0.13, d: 0.07 },
      { a: 0.11, b: 0.13, c: 0.09, d: 0.12 }
    ];
    var palette = [
      { r: isDark ? 91 : 43,   g: isDark ? 160 : 111, b: isDark ? 245 : 208 },
      { r: isDark ? 78 : 22,   g: isDark ? 201 : 128, b: isDark ? 137 : 75  },
      { r: isDark ? 198 : 124, g: isDark ? 120 : 58,  b: isDark ? 221 : 237 }
    ];
    var colorPhase = t * 0.03;

    for (var cl = 0; cl < clusters.length; cl++) {
      var C = clusters[cl], F = freqs[cl], A = amps[cl];
      var col     = palette[cl % palette.length];
      var localSc = sc * C.sm;

      var a  = C.a + Math.sin(t * F.a) * A.a;
      var b  = C.b + Math.cos(t * F.b) * A.b;
      var c  = C.c + Math.sin(t * F.c) * A.c;
      var dd = C.d + Math.cos(t * F.d) * A.d;

      var shift = Math.sin(colorPhase + cl * 1.257) * 0.14;
      var cr = Math.max(0, Math.min(255, col.r * (1 + shift)));
      var cg = Math.max(0, Math.min(255, col.g * (1 - shift * 0.5)));
      var cb = Math.max(0, Math.min(255, col.b * (1 + shift * 0.3)));

      var ox = Math.sin(cl * 2.4 + t * 0.013) * w * 0.07;
      var n  = C.n;
      var x  = 0.1, y = 0.1;
      for (var i = 0; i < n; i++) {
        var nx = Math.sin(a * y) + c * Math.cos(a * x);
        var ny = Math.sin(b * x) + dd * Math.cos(b * y);
        x = nx; y = ny;
        if (i < 50) continue;
        var px = (cx + ox + x * localSc) | 0;
        var py = (C.cy + y * localSc) | 0;
        if (px >= 0 && px < w && py >= 0 && py < h) {
          var idx = py * w + px;
          bR[idx] += cr; bG[idx] += cg; bB[idx] += cb;
        }
      }
    }

    var maxV = 0;
    for (var i = 0; i < size; i++) {
      var v = bR[i] + bG[i] + bB[i];
      if (v > maxV) maxV = v;
    }
    if (maxV === 0) return;

    var img    = ctx.createImageData(w, h);
    var d      = img.data;
    var alpha  = isDark ? 0.85 : 0.55;
    var logMax = Math.log(1 + maxV);
    for (var i = 0; i < size; i++) {
      var total = bR[i] + bG[i] + bB[i];
      if (total > 0) {
        var t2 = Math.pow(Math.log(1 + total) / logMax, 0.6);
        var j  = i * 4;
        d[j]     = Math.min(255, (bR[i] / total * 255 * t2 + 0.5) | 0);
        d[j + 1] = Math.min(255, (bG[i] / total * 255 * t2 + 0.5) | 0);
        d[j + 2] = Math.min(255, (bB[i] / total * 255 * t2 + 0.5) | 0);
        d[j + 3] = Math.min(255, (t2 * 255 * alpha + 0.5) | 0);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ═══════════════════════════════════════════════════════════
     Crossfade between canvas slots
     ═══════════════════════════════════════════════════════════ */
  function showSlot(slot) {
    var show = slot === 'a' ? canvasA : canvasB;
    var hide = slot === 'a' ? canvasB : canvasA;
    show.classList.add('active');
    hide.classList.remove('active');
  }

  /* ═══════════════════════════════════════════════════════════
     Evolution cycle — re-render with evolved params, crossfade
     ═══════════════════════════════════════════════════════════ */
  function evolve() {
    if (pendingRender || prefersReduced) return;
    pendingRender = true;
    var nextSlot = activeSlot === 'a' ? 'b' : 'a';
    renderSlot(nextSlot, performance.now(), function () {
      showSlot(nextSlot);
      activeSlot  = nextSlot;
      pendingRender = false;
    });
  }

  /* ═══════════════════════════════════════════════════════════
     Animation loop — organic drift + scroll-following
     ═══════════════════════════════════════════════════════════ */
  function animate(now) {
    if (prefersReduced) return;

    var elapsed = (now - startTime) / 1000;
    var scrollY = window.scrollY || window.pageYOffset;

    /* ── Organic Lissajous drift ────────────────────────────
       Two sine waves per axis for natural, non-repeating motion.
       Rotation and breathing add an extra layer of subtle life. */
    var driftX   = Math.sin(elapsed * 0.067) * 16 + Math.sin(elapsed * 0.031) * 8;
    var driftY   = Math.cos(elapsed * 0.053) * 10 + Math.cos(elapsed * 0.019) * 5;
    var driftRot = Math.sin(elapsed * 0.023) * 1.2;
    var driftSc  = 1 + Math.sin(elapsed * 0.037) * 0.025;

    /* ── Scroll-proportional mapping ────────────────────────
       Maps page scroll position to canvas translation so the
       background pattern genuinely follows the user down the
       page.  Uses a spring-damper for buttery smoothness.

       The CSS mover is 350 % viewport tall with a -15 % top
       offset, giving (350 - 100) % = 250 % of extra height.
       We use 82 % of that as usable travel (rest is buffer). */
    var docH      = document.documentElement.scrollHeight;
    var viewH     = window.innerHeight;
    var maxScroll = Math.max(1, docH - viewH);

    var scrollFraction = Math.min(1, scrollY / maxScroll);
    var usableTravel   = viewH * (MOVER_CSS_HEIGHT - 1) * 0.82;
    var targetScrollY  = -scrollFraction * usableTravel;

    // Spring-damper: 80 % damping, 10 % spring constant
    scrollVel    = scrollVel * 0.80 + (targetScrollY - smoothScrollY) * 0.10;
    smoothScrollY += scrollVel;

    /* ── Compose transform ──────────────────────────────────
       GPU-accelerated via translate3d.  Drift + scroll + rotate + scale. */
    mover.style.transform =
      'translate3d(' + driftX.toFixed(1) + 'px,' +
      (driftY + smoothScrollY).toFixed(1) + 'px,0) ' +
      'rotate(' + driftRot.toFixed(2) + 'deg) ' +
      'scale(' + driftSc.toFixed(4) + ')';

    requestAnimationFrame(animate);
  }

  /* ═══════════════════════════════════════════════════════════
     Initialisation
     ═══════════════════════════════════════════════════════════ */
  setupCanvases();
  renderSlot('a', performance.now(), function () {
    showSlot('a');
    if (!prefersReduced) {
      evolutionTimer = setInterval(evolve, EVOLVE_INTERVAL);
    }
  });
  if (!prefersReduced) {
    requestAnimationFrame(animate);
  }

  /* ═══════════════════════════════════════════════════════════
     Resize — debounced re-render at new dimensions
     ═══════════════════════════════════════════════════════════ */
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      setupCanvases();
      renderSlot(activeSlot, performance.now());
    }, 250);
  });

  /* ═══════════════════════════════════════════════════════════
     Theme change — re-render with updated colour palette
     ═══════════════════════════════════════════════════════════ */
  new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].attributeName === 'data-theme') {
        renderSlot(activeSlot, performance.now());
        return;
      }
    }
  }).observe(document.documentElement, { attributes: true });

})();
