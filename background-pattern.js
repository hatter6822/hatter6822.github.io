/**
 * background-pattern.js
 *
 * Animated mathematical background — Clifford strange attractors with shimmer.
 *
 * Layer 1 — Attractor pattern  (heavy, off-thread, re-rendered every 6 s)
 *           5 clusters distributed vertically on a 3× tall canvas.
 *           Dual-canvas crossfade for seamless morphing.
 *
 * Layer 2 — Shimmer overlay  (lightweight, 60 fps, main thread)
 *           Soft glowing particles that twinkle across the viewport.
 *           Reacts to scroll velocity for subtle responsiveness.
 *
 * Motion is frame-rate-independent via exponential smoothing, so scroll-
 * following and drift feel identically smooth at 30, 60, or 120 fps.
 *
 * Supports dark/light themes, prefers-reduced-motion, resize, theme change.
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     Configuration
     ═══════════════════════════════════════════════════════════ */
  var HEIGHT_SCALE     = 3;        // attractor canvas: 3× viewport tall
  var RES_SCALE        = 0.4;      // 40 % of native (soft + performant)
  var MOVER_CSS_HEIGHT = 3.5;      // matches CSS height: 350 %
  var EVOLVE_INTERVAL  = 6000;     // attractor morph cycle (ms)
  var SCROLL_SMOOTH    = 7;        // exponential smoothing rate (Hz)
  var SHIMMER_COUNT    = 65;       // number of sparkle particles

  /* ═══════════════════════════════════════════════════════════
     DOM
     ═══════════════════════════════════════════════════════════ */
  var wrap    = document.getElementById('bg-canvas-wrap');
  var canvasA = document.getElementById('math-bg-a');
  var canvasB = document.getElementById('math-bg-b');
  var mover   = document.getElementById('bg-canvas-mover');
  if (!wrap || !canvasA || !canvasB || !mover) return;

  var ctxA = canvasA.getContext('2d');
  var ctxB = canvasB.getContext('2d');

  /* ═══════════════════════════════════════════════════════════
     State
     ═══════════════════════════════════════════════════════════ */
  var w = 0, h = 0;                  // attractor canvas pixel size
  var activeSlot     = 'a';
  var pendingRender  = false;
  var worker         = null;
  var evolutionTimer = null;
  var resizeTimer    = null;
  var startTime      = performance.now();
  var prevTime       = startTime;
  var smoothScrollY  = 0;
  var lastRawScrollY = 0;

  var prefersReduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* shimmer */
  var shimmerCanvas, shimmerCtx;
  var sW = 0, sH = 0;               // shimmer viewport dimensions
  var particles = [];

  /* ═══════════════════════════════════════════════════════════
     Inline Web Worker — computes attractor off the main thread
     ═══════════════════════════════════════════════════════════ */
  var workerCode = function () {
    self.onmessage = function (e) {
      var d = e.data;
      var w = d.w, h = d.h, isDark = d.isDark, time = d.time;
      var heightScale = d.heightScale;
      var size = w * h;

      var bR = new Float32Array(size);
      var bG = new Float32Array(size);
      var bB = new Float32Array(size);

      var cx    = w * 0.5;
      var viewH = h / heightScale;
      var sc    = Math.min(w, viewH) * 0.24;
      var t     = time / 1000;

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
            bR[idx] += cr;
            bG[idx] += cg;
            bB[idx] += cb;
          }
        }
      }

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

  try {
    var blob    = new Blob(['(' + workerCode.toString() + ')()'], { type: 'text/javascript' });
    var blobUrl = URL.createObjectURL(blob);
    worker      = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);
  } catch (e) { worker = null; }

  /* ═══════════════════════════════════════════════════════════
     Canvas sizing
     ═══════════════════════════════════════════════════════════ */
  function setupCanvases() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, Math.floor(window.innerWidth  * dpr * RES_SCALE));
    h = Math.max(1, Math.floor(window.innerHeight * dpr * RES_SCALE * HEIGHT_SCALE));
    canvasA.width  = w; canvasA.height = h;
    canvasB.width  = w; canvasB.height = h;
  }

  /* ═══════════════════════════════════════════════════════════
     Shimmer canvas sizing  (viewport-sized, crisp DPI)
     ═══════════════════════════════════════════════════════════ */
  function setupShimmer() {
    if (!shimmerCanvas) {
      shimmerCanvas = document.createElement('canvas');
      shimmerCanvas.id = 'shimmer-layer';
      wrap.appendChild(shimmerCanvas);
      shimmerCtx = shimmerCanvas.getContext('2d');
    }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    sW = window.innerWidth;
    sH = window.innerHeight;
    shimmerCanvas.width  = Math.floor(sW * dpr);
    shimmerCanvas.height = Math.floor(sH * dpr);
    shimmerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ═══════════════════════════════════════════════════════════
     Shimmer particle system
     ═══════════════════════════════════════════════════════════ */
  function spawnParticle(stagger) {
    var p = {
      x:     Math.random() * sW,
      y:     Math.random() * sH,
      r:     0.5 + Math.random() * 2.0,        // radius 0.5–2.5 px
      phase: Math.random() * 6.2832,            // random twinkle phase
      freq:  1.2 + Math.random() * 3.0,         // twinkle Hz
      vx:    (Math.random() - 0.5) * 0.2,       // slow horizontal drift
      vy:    (Math.random() - 0.5) * 0.12,      // slow vertical drift
      ci:    Math.floor(Math.random() * 3),      // colour index
      life:  0,
      ttl:   3 + Math.random() * 5              // 3–8 s lifetime
    };
    if (stagger) p.life = Math.random() * p.ttl; // stagger at init
    return p;
  }

  function initParticles() {
    particles = [];
    for (var i = 0; i < SHIMMER_COUNT; i++) {
      particles.push(spawnParticle(true));
    }
  }

  function renderShimmer(elapsed, dt, scrollDelta) {
    shimmerCtx.clearRect(0, 0, sW, sH);

    var isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    var colors = isDark
      ? ['91,160,245', '78,201,137', '198,120,221']
      : ['43,111,208', '22,128,75',  '124,58,237'];
    var peak = isDark ? 0.65 : 0.40;

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.life += dt;

      // respawn expired particles
      if (p.life >= p.ttl) { particles[i] = spawnParticle(false); continue; }

      // smooth bell-curve fade envelope  (0 → 1 → 0  over lifetime)
      var envelope = Math.sin(p.life / p.ttl * 3.1416);

      // high-freq twinkle with slight non-linearity for sparkle character
      var raw     = 0.5 + 0.5 * Math.sin(elapsed * p.freq * 6.2832 + p.phase);
      var twinkle = 0.3 + 0.7 * raw * raw;

      var alpha = envelope * twinkle * peak;
      if (alpha < 0.008) continue;

      // drift + gentle scroll reaction
      p.x += p.vx + scrollDelta * -0.02;
      p.y += p.vy;

      // viewport wrap
      if (p.x < -10) p.x += sW + 20;
      else if (p.x > sW + 10) p.x -= sW + 20;
      if (p.y < -10) p.y += sH + 20;
      else if (p.y > sH + 10) p.y -= sH + 20;

      var c = colors[p.ci];

      // core sparkle dot
      shimmerCtx.globalAlpha = alpha;
      shimmerCtx.fillStyle = 'rgb(' + c + ')';
      shimmerCtx.beginPath();
      shimmerCtx.arc(p.x, p.y, p.r, 0, 6.2832);
      shimmerCtx.fill();

      // soft glow halo  (only on brighter / larger particles)
      if (alpha > 0.12 && p.r > 0.8) {
        shimmerCtx.globalAlpha = alpha * 0.10;
        shimmerCtx.beginPath();
        shimmerCtx.arc(p.x, p.y, p.r * 4, 0, 6.2832);
        shimmerCtx.fill();
      }
    }
    shimmerCtx.globalAlpha = 1;
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
     Main-thread fallback  (same algorithm as worker)
     ═══════════════════════════════════════════════════════════ */
  function renderFallback(ctx, time, isDark) {
    var size = w * h;
    var bR = new Float32Array(size);
    var bG = new Float32Array(size);
    var bB = new Float32Array(size);

    var cx    = w * 0.5;
    var viewH = h / HEIGHT_SCALE;
    var sc    = Math.min(w, viewH) * 0.24;
    var t     = time / 1000;

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
      activeSlot    = nextSlot;
      pendingRender = false;
    });
  }

  /* ═══════════════════════════════════════════════════════════
     Animation loop — drift + scroll-following + shimmer
     All motion uses delta-time for frame-rate independence.
     ═══════════════════════════════════════════════════════════ */
  function animate(now) {
    if (prefersReduced) return;

    var dt      = Math.min(0.1, (now - prevTime) / 1000);   // cap 100 ms
    prevTime    = now;
    var elapsed = (now - startTime) / 1000;
    var scrollY = window.scrollY || window.pageYOffset;
    var scrollDelta = scrollY - lastRawScrollY;
    lastRawScrollY  = scrollY;

    /* ── Organic Lissajous drift — 3 harmonics per axis ────
       Slower frequencies + 3rd harmonic make the motion feel
       deeper and more natural than a simple 2-sine wobble.  */
    var driftX = Math.sin(elapsed * 0.061) * 12
               + Math.sin(elapsed * 0.029) * 6
               + Math.sin(elapsed * 0.011) * 3;
    var driftY = Math.cos(elapsed * 0.047) * 8
               + Math.cos(elapsed * 0.019) * 4
               + Math.cos(elapsed * 0.007) * 2;
    var driftRot = Math.sin(elapsed * 0.021) * 0.8;
    var driftSc  = 1 + Math.sin(elapsed * 0.033) * 0.015;

    /* ── Scroll-following — exponential smoothing ──────────
       Uses  smooth += (target - smooth) * (1 - e^(-rate*dt))
       which is critically damped and frame-rate independent.
       At SCROLL_SMOOTH = 7 Hz the response reaches ~99 % of
       target in ≈ 0.66 s — responsive yet buttery.          */
    var docH      = document.documentElement.scrollHeight;
    var viewH     = window.innerHeight;
    var maxScroll = Math.max(1, docH - viewH);
    var scrollFrac   = Math.min(1, scrollY / maxScroll);
    var usableTravel = viewH * (MOVER_CSS_HEIGHT - 1) * 0.82;
    var targetScrollY = -scrollFrac * usableTravel;

    var smoothing = 1 - Math.exp(-SCROLL_SMOOTH * dt);
    smoothScrollY += (targetScrollY - smoothScrollY) * smoothing;

    /* ── Compose GPU-accelerated transform ─────────────── */
    mover.style.transform =
      'translate3d(' + driftX.toFixed(1) + 'px,' +
      (driftY + smoothScrollY).toFixed(1) + 'px,0) ' +
      'rotate(' + driftRot.toFixed(2) + 'deg) ' +
      'scale(' + driftSc.toFixed(4) + ')';

    /* ── Shimmer ────────────────────────────────────────── */
    renderShimmer(elapsed, dt, scrollDelta);

    requestAnimationFrame(animate);
  }

  /* ═══════════════════════════════════════════════════════════
     Initialisation
     ═══════════════════════════════════════════════════════════ */
  setupCanvases();

  if (!prefersReduced) {
    setupShimmer();
    initParticles();
  }

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
     Resize — debounced, re-renders attractor + shimmer
     ═══════════════════════════════════════════════════════════ */
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      setupCanvases();
      if (!prefersReduced) setupShimmer();
      renderSlot(activeSlot, performance.now());
    }, 250);
  });

  /* ═══════════════════════════════════════════════════════════
     Theme change — re-render with updated palette
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
