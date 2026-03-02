/**
 * background-pattern.js
 *
 * GPU-accelerated flowing background — WebGL fragment shader with:
 *
 *   1. Domain-warped 3D simplex noise   — deeply organic, continuously
 *      morphing shapes (ink-in-water / aurora borealis aesthetic).
 *
 *   2. Cosine colour palettes           — smooth, endless cycling through
 *      blues, teals, purples and greens. Palette shifts with time.
 *
 *   3. Integrated sparkle layer          — high-frequency noise peaks
 *      create twinkling bright points that cluster organically.
 *
 *   4. Scroll parallax                   — exponentially smoothed,
 *      frame-rate-independent scroll offset for depth.
 *
 *   5. Organic drift                     — multi-harmonic Lissajous
 *      coordinate offset computed entirely in the shader.
 *
 * Everything renders every frame on the GPU — no discrete steps,
 * no crossfade hacks, no separate shimmer canvas, no web worker.
 *
 * Supports dark/light themes, prefers-reduced-motion, resize,
 * theme toggle, and WebGL context loss/restore.
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     Configuration
     ═══════════════════════════════════════════════════════════ */
  var RES_SCALE    = 0.45;   // fraction of native resolution (soft + fast)
  var SCROLL_SMOOTH = 7;     // exponential smoothing rate (Hz)

  /* ═══════════════════════════════════════════════════════════
     DOM
     ═══════════════════════════════════════════════════════════ */
  var wrap    = document.getElementById('bg-canvas-wrap');
  var canvasA = document.getElementById('math-bg-a');
  var canvasB = document.getElementById('math-bg-b');
  var mover   = document.getElementById('bg-canvas-mover');
  if (!wrap || !canvasA || !canvasB || !mover) return;

  var prefersReduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ═══════════════════════════════════════════════════════════
     Reconfigure DOM for single-canvas WebGL
     — Neutralise the mover (no CSS transform animation needed)
     — Use canvas A as the WebGL surface
     — Hide canvas B (crossfade no longer needed)
     ═══════════════════════════════════════════════════════════ */
  mover.style.cssText =
    'position:absolute;top:0;left:0;width:100%;height:100%;opacity:1;will-change:auto;';
  canvasB.style.display = 'none';
  canvasA.style.transition = 'none';
  canvasA.style.opacity = '1';
  canvasA.style.willChange = 'auto';
  canvasA.classList.add('active');

  /* ═══════════════════════════════════════════════════════════
     WebGL context
     ═══════════════════════════════════════════════════════════ */
  var gl = canvasA.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false
  });

  if (!gl) {
    /* Graceful fallback — static CSS gradient */
    canvasA.style.display = 'none';
    mover.style.background =
      'radial-gradient(ellipse 80% 60% at 50% 40%,' +
      'rgba(91,160,245,0.12) 0%,transparent 70%),' +
      'radial-gradient(ellipse 60% 40% at 30% 70%,' +
      'rgba(78,201,137,0.08) 0%,transparent 60%)';
    return;
  }

  /* ═══════════════════════════════════════════════════════════
     Shader sources
     ═══════════════════════════════════════════════════════════ */

  var VERT = 'attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0,1);}';

  /* Fragment shader — domain-warped simplex noise with cosine
     colour palette and sparkle overlay.  Every visual element
     evolves continuously with u_time — zero discrete steps.    */
  var FRAG = [
    /* ── precision ── */
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',

    /* ── uniforms ── */
    'uniform vec2 u_res;',
    'uniform float u_time;',
    'uniform float u_scroll;',
    'uniform float u_theme;',

    /* ─────────────────────────────────────────────────────────
       3D Simplex Noise  (Ashima Arts — MIT licence)
       Compact, GPU-friendly, returns ≈ [−1, 1].
       ───────────────────────────────────────────────────────── */
    'vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 perm(vec4 x){return mod289(((x*34.0)+1.0)*x);}',
    'vec4 tis(vec4 r){return 1.79284291400159-0.85373472095314*r;}',

    'float snoise(vec3 v){',
    '  const vec2 C=vec2(1.0/6.0,1.0/3.0);',
    '  const vec4 D=vec4(0.0,0.5,1.0,2.0);',
    '  vec3 i=floor(v+dot(v,C.yyy));',
    '  vec3 x0=v-i+dot(i,C.xxx);',
    '  vec3 g=step(x0.yzx,x0.xyz);',
    '  vec3 l=1.0-g;',
    '  vec3 i1=min(g.xyz,l.zxy);',
    '  vec3 i2=max(g.xyz,l.zxy);',
    '  vec3 x1=x0-i1+C.xxx;',
    '  vec3 x2=x0-i2+C.yyy;',
    '  vec3 x3=x0-D.yyy;',
    '  i=mod289(i);',
    '  vec4 p=perm(perm(perm(',
    '    i.z+vec4(0.0,i1.z,i2.z,1.0))',
    '    +i.y+vec4(0.0,i1.y,i2.y,1.0))',
    '    +i.x+vec4(0.0,i1.x,i2.x,1.0));',
    '  float n_=0.142857142857;',
    '  vec3 ns=n_*D.wyz-D.xzx;',
    '  vec4 j=p-49.0*floor(p*ns.z*ns.z);',
    '  vec4 x_=floor(j*ns.z);',
    '  vec4 y_=floor(j-7.0*x_);',
    '  vec4 x=x_*ns.x+ns.yyyy;',
    '  vec4 y=y_*ns.x+ns.yyyy;',
    '  vec4 h=1.0-abs(x)-abs(y);',
    '  vec4 b0=vec4(x.xy,y.xy);',
    '  vec4 b1=vec4(x.zw,y.zw);',
    '  vec4 s0=floor(b0)*2.0+1.0;',
    '  vec4 s1=floor(b1)*2.0+1.0;',
    '  vec4 sh=-step(h,vec4(0.0));',
    '  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;',
    '  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;',
    '  vec3 p0=vec3(a0.xy,h.x);',
    '  vec3 p1=vec3(a0.zw,h.y);',
    '  vec3 p2=vec3(a1.xy,h.z);',
    '  vec3 p3=vec3(a1.zw,h.w);',
    '  vec4 norm=tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));',
    '  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;',
    '  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);',
    '  m=m*m;',
    '  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));',
    '}',

    /* ─────────────────────────────────────────────────────────
       FBM — 3 octaves of simplex noise
       ───────────────────────────────────────────────────────── */
    'float fbm(vec3 p){',
    '  float f=0.0,a=0.5;',
    '  for(int i=0;i<3;i++){f+=a*snoise(p);p=p*2.03+0.13;a*=0.47;}',
    '  return f;',
    '}',

    /* ─────────────────────────────────────────────────────────
       Cosine colour palette  (Inigo Quilez technique)
       ───────────────────────────────────────────────────────── */
    'vec3 pal(float t,vec3 a,vec3 b,vec3 c,vec3 d){',
    '  return a+b*cos(6.28318*(c*t+d));',
    '}',

    /* ─────────────────────────────────────────────────────────
       Main
       ───────────────────────────────────────────────────────── */
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/u_res;',
    '  float asp=u_res.x/u_res.y;',
    '  float t=u_time;',

    /* Coordinate space: aspect-corrected, centred, with scroll parallax.
       Pattern moves at 60 % of page scroll speed for depth.            */
    '  vec2 p=vec2((uv.x-0.5)*asp, uv.y-0.5+u_scroll*0.6);',

    /* Organic Lissajous drift — 2 harmonics per axis baked into coords
       so the pattern itself flows, not just the container.              */
    '  p+=vec2(sin(t*0.053)*0.12+sin(t*0.024)*0.06,',
    '          cos(t*0.041)*0.08+cos(t*0.017)*0.04);',

    /* ── Domain warping (two rounds) ──────────────────────────
       First warp: two FBM lookups offset the coordinate field.
       Second warp: use first-round output to distort further.
       Final FBM: the deeply warped result → organic flow.      */
    '  float q1=fbm(vec3(p*1.6, t*0.11));',
    '  float q2=fbm(vec3(p*1.6+5.2, t*0.09));',
    '  vec2 q=vec2(q1,q2);',

    '  float r1=fbm(vec3(p+3.2*q+vec2(1.7,9.2), t*0.07));',
    '  float r2=fbm(vec3(p+3.2*q+vec2(8.3,2.8), t*0.08));',
    '  float f=fbm(vec3(p+2.8*vec2(r1,r2), t*0.05));',

    /* ── Colour ───────────────────────────────────────────────
       Cosine palette input drifts with both pattern shape
       and elapsed time → continuous colour shifting.

       Dark  palette cycles:  deep blue → teal → purple
       Light palette:         softer / more pastel variant       */
    '  float ci=f*0.55+length(q)*0.2+t*0.012;',

    '  vec3 dc=pal(ci,',
    '    vec3(0.30,0.40,0.60),',
    '    vec3(0.30,0.30,0.30),',
    '    vec3(0.70,0.80,1.00),',
    '    vec3(0.55,0.65,0.75));',

    '  vec3 lc=pal(ci,',
    '    vec3(0.45,0.52,0.55),',
    '    vec3(0.22,0.22,0.25),',
    '    vec3(0.70,0.80,1.00),',
    '    vec3(0.55,0.65,0.75));',

    '  vec3 col=mix(dc,lc,u_theme);',

    /* ── Sparkles ─────────────────────────────────────────────
       High-frequency noise thresholded near its peaks creates
       small bright points that appear / disappear organically.
       A lower-frequency noise modulates clustering.             */
    '  float sp=snoise(vec3(uv*38.0, t*2.2));',
    '  sp=smoothstep(0.80,0.96,sp);',
    '  sp*=smoothstep(-0.3,0.5,snoise(vec3(uv*10.0, t*0.6)));',
    '  col+=sp*mix(vec3(0.7,0.85,1.0),vec3(0.9,0.95,1.0),sp)*0.45;',

    /* ── Intensity envelope ───────────────────────────────────
       Pattern density drives base intensity.  Edge fade prevents
       hard cuts; radial vignette adds subtle depth.              */
    '  float intensity=smoothstep(-0.5,0.7,f)*0.65+0.35;',

    '  float edge=smoothstep(0.0,0.15,',
    '    min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y)));',
    '  float vig=1.0-length(uv-0.5)*0.4;',
    '  intensity*=edge*vig;',

    /* ── Final alpha — premultiplied for CSS compositing ───── */
    '  float alpha=intensity*mix(0.65,0.38,u_theme);',
    '  gl_FragColor=vec4(col*alpha,alpha);',
    '}'
  ].join('\n');

  /* ═══════════════════════════════════════════════════════════
     Shader helpers
     ═══════════════════════════════════════════════════════════ */
  function compileShader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function createProgram(vSrc, fSrc) {
    var vs = compileShader(gl.VERTEX_SHADER, vSrc);
    var fs = compileShader(gl.FRAGMENT_SHADER, fSrc);
    if (!vs || !fs) return null;
    var pg = gl.createProgram();
    gl.attachShader(pg, vs);
    gl.attachShader(pg, fs);
    gl.linkProgram(pg);
    if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) {
      gl.deleteProgram(pg);
      return null;
    }
    return pg;
  }

  var prog = createProgram(VERT, FRAG);
  if (!prog) {
    /* Shader failed — static CSS gradient fallback */
    canvasA.style.display = 'none';
    mover.style.background =
      'radial-gradient(ellipse 80% 60% at 50% 40%,' +
      'rgba(91,160,245,0.12) 0%,transparent 70%)';
    return;
  }

  gl.useProgram(prog);

  /* ═══════════════════════════════════════════════════════════
     Geometry — fullscreen triangle (single draw, zero overdraw)
     A triangle with verts at (−1,−1), (3,−1), (−1,3) clips to
     a perfect viewport-filling quad — more efficient than a
     two-triangle quad because there is no shared diagonal edge.
     ═══════════════════════════════════════════════════════════ */
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  var aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  /* ═══════════════════════════════════════════════════════════
     Uniform locations
     ═══════════════════════════════════════════════════════════ */
  var uRes    = gl.getUniformLocation(prog, 'u_res');
  var uTime   = gl.getUniformLocation(prog, 'u_time');
  var uScroll = gl.getUniformLocation(prog, 'u_scroll');
  var uTheme  = gl.getUniformLocation(prog, 'u_theme');

  /* ═══════════════════════════════════════════════════════════
     State
     ═══════════════════════════════════════════════════════════ */
  var startTime = performance.now();
  var prevTime  = startTime;
  var cw = 0, ch = 0;

  /* Initialise smooth scroll to current position so there is
     no jarring jump if the page loads mid-scroll (back/forward). */
  var initScrollY  = window.scrollY || window.pageYOffset || 0;
  var initDocH     = document.documentElement.scrollHeight;
  var initViewH    = window.innerHeight;
  var initMaxScr   = Math.max(1, initDocH - initViewH);
  var smoothScrollY = Math.max(0, Math.min(1, initScrollY / initMaxScr));

  var resizeTimer = null;
  var running     = !prefersReduced;

  /* ═══════════════════════════════════════════════════════════
     Canvas sizing
     Render at a fraction of native resolution for a soft,
     dreamy quality while keeping shader cost low.
     ═══════════════════════════════════════════════════════════ */
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = Math.max(1, Math.floor(window.innerWidth  * dpr * RES_SCALE));
    ch = Math.max(1, Math.floor(window.innerHeight * dpr * RES_SCALE));
    canvasA.width  = cw;
    canvasA.height = ch;
    gl.viewport(0, 0, cw, ch);
  }

  /* ═══════════════════════════════════════════════════════════
     Theme helper — 0 = dark, 1 = light
     ═══════════════════════════════════════════════════════════ */
  function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light'
      ? 1.0 : 0.0;
  }

  /* ═══════════════════════════════════════════════════════════
     Render a single frame  (used for static / reduced-motion)
     ═══════════════════════════════════════════════════════════ */
  function renderStatic() {
    gl.uniform2f(uRes, cw, ch);
    gl.uniform1f(uTime, 0.0);
    gl.uniform1f(uScroll, smoothScrollY);
    gl.uniform1f(uTheme, getTheme());
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ═══════════════════════════════════════════════════════════
     Animation loop
     Frame-rate-independent via delta-time.
     ═══════════════════════════════════════════════════════════ */
  function animate(now) {
    if (!running) return;

    var dt      = Math.min(0.1, (now - prevTime) / 1000);
    prevTime    = now;
    var elapsed = (now - startTime) / 1000;

    /* ── Exponential-smoothed scroll fraction ────────────────
       Uses  s += (target − s) × (1 − e^(−rate × dt))
       which is frame-rate-independent and critically damped.
       At 7 Hz the response reaches 99 % in ≈ 0.66 s.         */
    var scrollY  = window.scrollY || window.pageYOffset || 0;
    var docH     = document.documentElement.scrollHeight;
    var viewH    = window.innerHeight;
    var maxScr   = Math.max(1, docH - viewH);
    var scrollFr = Math.max(0, Math.min(1, scrollY / maxScr));
    var k        = 1 - Math.exp(-SCROLL_SMOOTH * dt);
    smoothScrollY += (scrollFr - smoothScrollY) * k;

    /* ── Uniforms ─────────────────────────────────────────── */
    gl.uniform2f(uRes, cw, ch);
    gl.uniform1f(uTime, elapsed);
    gl.uniform1f(uScroll, smoothScrollY);
    gl.uniform1f(uTheme, getTheme());

    /* ── Draw ─────────────────────────────────────────────── */
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    requestAnimationFrame(animate);
  }

  /* ═══════════════════════════════════════════════════════════
     Initialisation
     ═══════════════════════════════════════════════════════════ */
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  resize();

  if (prefersReduced) {
    renderStatic();
  } else {
    requestAnimationFrame(animate);
  }

  /* ═══════════════════════════════════════════════════════════
     Resize — debounced
     ═══════════════════════════════════════════════════════════ */
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      if (prefersReduced) renderStatic();
    }, 200);
  });

  /* ═══════════════════════════════════════════════════════════
     Theme change — uniform updates on next frame automatically,
     but for reduced-motion we need an explicit re-render.
     ═══════════════════════════════════════════════════════════ */
  new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].attributeName === 'data-theme') {
        if (prefersReduced) renderStatic();
        return;
      }
    }
  }).observe(document.documentElement, { attributes: true });

  /* ═══════════════════════════════════════════════════════════
     WebGL context loss / restore
     Handles GPU driver resets gracefully.
     ═══════════════════════════════════════════════════════════ */
  canvasA.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    running = false;
  });

  canvasA.addEventListener('webglcontextrestored', function () {
    prog = createProgram(VERT, FRAG);
    if (!prog) return;
    gl.useProgram(prog);

    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    uRes    = gl.getUniformLocation(prog, 'u_res');
    uTime   = gl.getUniformLocation(prog, 'u_time');
    uScroll = gl.getUniformLocation(prog, 'u_scroll');
    uTheme  = gl.getUniformLocation(prog, 'u_theme');

    resize();
    running = !prefersReduced;
    if (running) {
      startTime = performance.now();
      prevTime  = startTime;
      requestAnimationFrame(animate);
    } else {
      renderStatic();
    }
  });

})();
