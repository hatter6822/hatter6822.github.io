/**
 * background-pattern.js
 *
 * GPU-accelerated fractal sphere background — WebGL fragment shader with:
 *
 *   1. Ray-marched amorphous sphere    — SDF sphere with multi-scale
 *      simplex noise displacement for organic, fractal geometry that
 *      constantly morphs and breathes.
 *
 *   2. Cosine colour palettes          — smooth, endless cycling through
 *      blues, teals, purples and greens.  Palette shifts with time.
 *
 *   3. Integrated sparkle layer        — high-frequency noise peaks on
 *      the sphere surface create twinkling bright points.
 *
 *   4. Mouse reactivity                — sphere surface bulges toward
 *      the cursor with exponentially smoothed tracking.
 *
 *   5. Scroll interaction              — fractal pattern rotates with
 *      exponentially smoothed scroll offset for depth.
 *
 *   6. Atmospheric glow                — soft radial falloff around
 *      the sphere for an ethereal, floating appearance.
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
  var RES_SCALE     = 0.4;    // fraction of native resolution
  var SCROLL_SMOOTH = 7;      // exponential smoothing rate (Hz)
  var MOUSE_SMOOTH  = 5;      // mouse smoothing rate (Hz)

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

  /* Fragment shader — ray-marched fractal sphere with cosine
     colour palette, sparkle overlay, and atmospheric glow.
     Every visual element evolves continuously with u_time.      */
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
    'uniform vec2 u_mouse;',

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
       Scene SDF — fractal sphere
       Sphere with multi-scale noise displacement, breathing
       radius, scroll-driven rotation, and mouse-reactive bulge.
       ───────────────────────────────────────────────────────── */
    'float map(vec3 pos){',
    '  float r=length(pos);',
    '  float t=u_time;',

    /* Breathing radius — slow multi-harmonic pulse */
    '  float radius=0.9+sin(t*0.15)*0.05+sin(t*0.08)*0.03;',
    '  float sph=r-radius;',

    '  vec3 n=pos/max(r,0.001);',

    /* Rotate noise coordinates by time + scroll for
       continuous pattern evolution and scroll reactivity */
    '  float ay=t*0.05+u_scroll*1.0;',
    '  float ax=sin(t*0.03)*0.2+u_scroll*0.4;',
    '  float cy=cos(ay),sy=sin(ay),cx=cos(ax),sx=sin(ax);',
    '  vec3 rn=vec3(n.x*cy+n.z*sy,n.y,-n.x*sy+n.z*cy);',
    '  rn=vec3(rn.x,rn.y*cx-rn.z*sx,rn.y*sx+rn.z*cx);',

    /* Multi-scale fractal displacement — two octaves of
       simplex noise at different scales and speeds */
    '  float d=snoise(rn*2.0+t*0.12)*0.30',
    '         +snoise(rn*4.5+t*0.18)*0.12;',

    /* Mouse bulge — surface reaches toward cursor.
       pow(_, 5) keeps the bulge localised. */
    '  vec2 ms=(u_mouse-0.5)*2.0;',
    '  ms.x*=u_res.x/u_res.y;',
    '  vec3 md=normalize(vec3(ms,-1.0));',
    '  d+=pow(max(0.0,dot(n,md)),5.0)*0.25;',

    '  return sph-d;',
    '}',

    /* ─────────────────────────────────────────────────────────
       Normal via central differences  (6 map evaluations)
       ───────────────────────────────────────────────────────── */
    'vec3 calcN(vec3 p){',
    '  float e=0.003;',
    '  return normalize(vec3(',
    '    map(p+vec3(e,0,0))-map(p-vec3(e,0,0)),',
    '    map(p+vec3(0,e,0))-map(p-vec3(0,e,0)),',
    '    map(p+vec3(0,0,e))-map(p-vec3(0,0,e))));',
    '}',

    /* ─────────────────────────────────────────────────────────
       Main
       ───────────────────────────────────────────────────────── */
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/u_res;',
    '  float asp=u_res.x/u_res.y;',
    '  float t=u_time;',

    /* Ray setup — perspective camera looking at origin */
    '  vec2 p=(uv-0.5)*vec2(asp,1.0);',
    '  vec3 ro=vec3(0.0,0.0,-3.5);',
    '  vec3 rd=normalize(vec3(p,1.2));',

    /* Bounding sphere test — skip ray march for rays
       that clearly miss (closest approach > 2.0) */
    '  float tb=dot(-ro,rd);',
    '  vec3 cp=ro+rd*tb;',
    '  float cdist=length(cp);',

    '  vec3 col=vec3(0.0);',
    '  float alpha=0.0;',
    '  bool hit=false;',
    '  float td=0.0;',

    '  if(cdist<2.0){',
    '    td=max(0.0,tb-2.0);',
    '    for(int i=0;i<48;i++){',
    '      float d=map(ro+rd*td);',
    '      if(d<0.001){hit=true;break;}',
    '      if(td>8.0)break;',
    '      td+=d*0.7;',
    '    }',
    '  }',

    '  if(hit){',
    '    vec3 pos=ro+rd*td;',
    '    vec3 nor=calcN(pos);',
    '    vec3 sn=normalize(pos);',

    /* Rotated coordinates for colour and sparkle —
       same rotation as in map() for consistency */
    '    float ay=t*0.05+u_scroll*1.0;',
    '    float ax=sin(t*0.03)*0.2+u_scroll*0.4;',
    '    float cy=cos(ay),sy=sin(ay),cx=cos(ax),sx=sin(ax);',
    '    vec3 rn=vec3(sn.x*cy+sn.z*sy,sn.y,-sn.x*sy+sn.z*cy);',
    '    rn=vec3(rn.x,rn.y*cx-rn.z*sx,rn.y*sx+rn.z*cx);',

    /* Dual-light setup — key + fill */
    '    vec3 l1=normalize(vec3(0.6,0.8,-0.5));',
    '    vec3 l2=normalize(vec3(-0.4,-0.3,-0.7));',
    '    float dif1=max(dot(nor,l1),0.0);',
    '    float dif2=max(dot(nor,l2),0.0);',

    /* Specular highlights */
    '    vec3 h1=normalize(l1-rd);',
    '    float sp1=pow(max(dot(nor,h1),0.0),48.0);',
    '    vec3 h2=normalize(l2-rd);',
    '    float sp2=pow(max(dot(nor,h2),0.0),32.0);',

    /* Sparkle — high-frequency noise peaks on surface
       create twinkling bright points that cluster organically */
    '    float spk=snoise(rn*25.0+t*4.0);',
    '    spk=smoothstep(0.72,0.95,spk);',
    '    spk*=smoothstep(-0.2,0.5,snoise(rn*8.0+t*0.8));',

    /* Colour — cosine palette driven by fractal pattern
       and elapsed time for continuous colour shifting.
       Dark palette:  deep blue → teal → purple
       Light palette: softer / more pastel variant       */
    '    float ci=fbm(rn*2.0+t*0.04)*0.55+t*0.015;',

    '    vec3 dc=pal(ci,',
    '      vec3(0.30,0.40,0.60),',
    '      vec3(0.30,0.30,0.30),',
    '      vec3(0.70,0.80,1.00),',
    '      vec3(0.55,0.65,0.75));',

    '    vec3 lc=pal(ci,',
    '      vec3(0.45,0.52,0.55),',
    '      vec3(0.22,0.22,0.25),',
    '      vec3(0.70,0.80,1.00),',
    '      vec3(0.55,0.65,0.75));',

    '    vec3 bc=mix(dc,lc,u_theme);',

    /* Compose lighting */
    '    col=bc*(0.25+dif1*0.5+dif2*0.2);',
    '    col+=sp1*mix(vec3(0.7,0.85,1.0),vec3(0.9,0.95,1.0),u_theme)*0.4;',
    '    col+=sp2*mix(vec3(0.5,0.6,0.9),vec3(0.7,0.75,0.85),u_theme)*0.2;',
    '    col+=spk*vec3(1.0,0.97,0.92)*0.7;',

    /* Fresnel rim glow — ethereal edge lighting */
    '    float fres=pow(1.0-max(dot(nor,-rd),0.0),3.0);',
    '    col+=fres*mix(vec3(0.3,0.5,0.8),vec3(0.5,0.6,0.7),u_theme)*0.5;',

    '    alpha=smoothstep(8.0,2.0,td)*mix(0.7,0.45,u_theme);',
    '  }',

    /* Atmospheric glow — soft radial falloff for rays that
       miss the sphere but pass close.  Cubic falloff + faint
       scattered sparkles in the glow region.                   */
    '  if(!hit&&cdist<3.0){',
    '    float glow=smoothstep(3.0,0.5,cdist);',
    '    glow=glow*glow*glow;',
    '    vec3 gc=mix(vec3(0.15,0.25,0.50),vec3(0.30,0.35,0.45),u_theme);',
    '    col+=gc*glow*0.4;',
    '    alpha+=glow*mix(0.20,0.12,u_theme);',

    '    float gs=snoise(vec3(uv*40.0,t*2.5));',
    '    gs=smoothstep(0.85,0.98,gs)*glow;',
    '    col+=gs*mix(vec3(0.6,0.75,1.0),vec3(0.8,0.85,0.9),u_theme)*0.3;',
    '    alpha+=gs*0.1;',
    '  }',

    /* ── Final — premultiplied alpha for CSS compositing ──── */
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
  var uMouse  = gl.getUniformLocation(prog, 'u_mouse');

  /* ═══════════════════════════════════════════════════════════
     State
     ═══════════════════════════════════════════════════════════ */
  var startTime = performance.now();
  var prevTime  = startTime;
  var cw = 0, ch = 0;

  /* Initialise smooth scroll to current position so there is
     no jarring jump if the page loads mid-scroll. */
  var initScrollY  = window.scrollY || window.pageYOffset || 0;
  var initDocH     = document.documentElement.scrollHeight;
  var initViewH    = window.innerHeight;
  var initMaxScr   = Math.max(1, initDocH - initViewH);
  var smoothScrollY = Math.max(0, Math.min(1, initScrollY / initMaxScr));

  /* Mouse state — default to centre so the sphere has a
     subtle forward bulge even before the cursor moves. */
  var mouseX = 0.5, mouseY = 0.5;
  var smoothMouseX = 0.5, smoothMouseY = 0.5;

  var resizeTimer = null;
  var running     = !prefersReduced;

  /* ═══════════════════════════════════════════════════════════
     Canvas sizing
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
    gl.uniform2f(uMouse, 0.5, 0.5);
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

    /* ── Exponential-smoothed scroll fraction ──────────────── */
    var scrollY  = window.scrollY || window.pageYOffset || 0;
    var docH     = document.documentElement.scrollHeight;
    var viewH    = window.innerHeight;
    var maxScr   = Math.max(1, docH - viewH);
    var scrollFr = Math.max(0, Math.min(1, scrollY / maxScr));
    var k        = 1 - Math.exp(-SCROLL_SMOOTH * dt);
    smoothScrollY += (scrollFr - smoothScrollY) * k;

    /* ── Exponential-smoothed mouse position ──────────────── */
    var km = 1 - Math.exp(-MOUSE_SMOOTH * dt);
    smoothMouseX += (mouseX - smoothMouseX) * km;
    smoothMouseY += (mouseY - smoothMouseY) * km;

    /* ── Uniforms ─────────────────────────────────────────── */
    gl.uniform2f(uRes, cw, ch);
    gl.uniform1f(uTime, elapsed);
    gl.uniform1f(uScroll, smoothScrollY);
    gl.uniform1f(uTheme, getTheme());
    gl.uniform2f(uMouse, smoothMouseX, smoothMouseY);

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
     Theme change
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
     Mouse / touch tracking
     Normalised to [0, 1] with Y flipped for GL coordinates.
     ═══════════════════════════════════════════════════════════ */
  document.addEventListener('mousemove', function (e) {
    mouseX = e.clientX / window.innerWidth;
    mouseY = 1.0 - e.clientY / window.innerHeight;
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (e.touches.length > 0) {
      mouseX = e.touches[0].clientX / window.innerWidth;
      mouseY = 1.0 - e.touches[0].clientY / window.innerHeight;
    }
  }, { passive: true });

  document.addEventListener('touchend', function () {
    mouseX = 0.5;
    mouseY = 0.5;
  }, { passive: true });

  /* ═══════════════════════════════════════════════════════════
     WebGL context loss / restore
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
    uMouse  = gl.getUniformLocation(prog, 'u_mouse');

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
