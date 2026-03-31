/**
 * background-pattern.js
 *
 * GPU-accelerated fractal diamond background — WebGL fragment shader with:
 *
 *   1. Ray-marched diamond sphere      — SDF sphere with ridged multi-scale
 *      simplex noise (abs-valued) for angular, crystalline geometry.
 *      Faceted surface normals simulate a cut gemstone.
 *
 *   2. Cosine colour palettes          — smooth, endless cycling through
 *      blues, teals, purples and greens.  Palette shifts with time.
 *
 *   3. Diamond scintillation           — facet-dependent flashing that
 *      varies with viewing angle, replacing smooth sparkle with the
 *      sharp on/off brilliance of a real diamond.
 *
 *   4. Chromatic dispersion (fire)     — prismatic rainbow shifts near
 *      edges and specular highlights, simulating diamond's high
 *      refractive index (n ≈ 2.42) splitting white light.
 *
 *   5. Adamantine specular             — three-light setup with very
 *      tight specular exponents (80–120) for diamond's characteristic
 *      brilliant, pinpoint reflections.
 *
 *   6. Internal crystalline lattice    — ridged noise product hints
 *      at depth and structure within the diamond substance.
 *
 *   7. Mouse reactivity                — sphere surface bulges toward
 *      the cursor with exponentially smoothed tracking.
 *
 *   8. Scroll interaction              — fractal pattern rotates with
 *      exponentially smoothed scroll offset for depth.
 *
 *   9. Quarter-alpha cap                — final alpha quartered (×0.25 ceiling)
 *      for a subtle, see-through crystalline background.
 *
 *  10. Cursor glow and sparkle         — the diamond surface brightens
 *      near the mouse with diffuse glow, amplified scintillation,
 *      and a cursor-directed specular flash.  Floating sparkle
 *      particles and a soft radial glow haze surround the cursor
 *      in all regions (surface, halo, and empty space).
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
  var ALPHA_SCALE   = 0.25;   // global opacity cap multiplier
  var SCROLL_SMOOTH = 7;      // exponential smoothing rate (Hz)
  var MOUSE_SMOOTH  = 5;      // mouse smoothing rate (Hz)
  var BG_ANIMATION_KEY = 'sele4n-bg-animation-paused-v1';

  /* ═══════════════════════════════════════════════════════════
     DOM
     ═══════════════════════════════════════════════════════════ */
  var wrap    = document.getElementById('bg-canvas-wrap');
  var canvasA = document.getElementById('math-bg-a');
  var mover   = document.getElementById('bg-canvas-mover');
  if (!wrap || !canvasA || !mover) return;

  function readManualPaused() {
    try { return localStorage.getItem(BG_ANIMATION_KEY) === '1'; }
    catch (e) { return false; }
  }

  var prefersReduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var prefersReducedData = window.matchMedia &&
    window.matchMedia('(prefers-reduced-data: reduce)').matches;
  var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  var saveData = !!(conn && conn.saveData);
  var lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 2;
  var compactViewport = Math.min(window.innerWidth, window.innerHeight) < 640;
  var coarsePointer = window.matchMedia &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  var mobileViewport = compactViewport || coarsePointer;

  /* Mobile browsers often fire resize events when the URL bar
     hides on first scroll, which can cause abrupt background
     rescaling. Keep a stable viewport baseline and only accept
     larger geometry changes (e.g. orientation shifts). */
  var stableViewW = window.innerWidth;
  var stableViewH = window.innerHeight;

  function getViewportSize() {
    var width = window.innerWidth;
    var height = window.innerHeight;

    if (!mobileViewport) {
      stableViewW = width;
      stableViewH = height;
      return { width: width, height: height };
    }

    var widthDelta = Math.abs(width - stableViewW);
    var heightDelta = Math.abs(height - stableViewH);
    var orientationChanged = (width > height) !== (stableViewW > stableViewH);

    if (orientationChanged || widthDelta > 80 || heightDelta > 160) {
      stableViewW = width;
      stableViewH = height;
    }

    return { width: stableViewW, height: stableViewH };
  }

  /* Mobile should still get the animated background; we only
     lower render resolution to keep GPU load manageable. */
  if (compactViewport) {
    RES_SCALE = 0.3;
    ALPHA_SCALE = 0.36;
  }

  if (lowMemory) {
    RES_SCALE = Math.min(RES_SCALE, 0.22);
    ALPHA_SCALE = Math.max(ALPHA_SCALE, 0.34);
  }

  if (prefersReduced || prefersReducedData || saveData) {
    canvasA.style.display = 'none';
    mover.style.background =
      'radial-gradient(ellipse 75% 55% at 50% 35%,' +
      'rgba(91,160,245,0.30) 0%,transparent 72%),' +
      'radial-gradient(ellipse 55% 40% at 30% 70%,' +
      'rgba(78,201,137,0.22) 0%,transparent 64%)';
    return;
  }

  /* ═══════════════════════════════════════════════════════════
     Reconfigure DOM for single-canvas WebGL
     ═══════════════════════════════════════════════════════════ */
  mover.style.cssText =
    'position:absolute;top:0;left:0;width:100%;height:100%;opacity:1;will-change:auto;';
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
    preserveDrawingBuffer: false,
    powerPreference: compactViewport ? 'low-power' : 'high-performance'
  });

  if (!gl) {
    gl = canvasA.getContext('experimental-webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: compactViewport ? 'low-power' : 'high-performance'
    });
  }

  if (!gl) {
    /* Graceful fallback — static CSS gradient (quartered alpha) */
    canvasA.style.display = 'none';
    mover.style.background =
      'radial-gradient(ellipse 80% 60% at 50% 40%,' +
      'rgba(91,160,245,0.28) 0%,transparent 72%),' +
      'radial-gradient(ellipse 60% 40% at 30% 70%,' +
      'rgba(78,201,137,0.2) 0%,transparent 64%)';
    return;
  }

  /* ═══════════════════════════════════════════════════════════
     Shader sources
     ═══════════════════════════════════════════════════════════ */

  var VERT = 'attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0,1);}';

  /* Fragment shader — ray-marched fractal diamond sphere with
     faceted normals, adamantine specular, chromatic dispersion,
     scintillation, internal lattice, and crystalline glow.
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
    'uniform float u_alpha_scale;',

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
       Ridged FBM — 4 octaves of abs(simplex noise).
       abs() folds the noise so zero-crossings become sharp
       ridges, naturally forming diamond-shaped geometry.
       ───────────────────────────────────────────────────────── */
    'float fbm(vec3 p){',
    '  float f=0.0,a=0.5;',
    '  for(int i=0;i<4;i++){f+=a*abs(snoise(p));p=p*2.17+0.31;a*=0.44;}',
    '  return f;',
    '}',

    /* ─────────────────────────────────────────────────────────
       Cosine colour palette  (Inigo Quilez technique)
       ───────────────────────────────────────────────────────── */
    'vec3 pal(float t,vec3 a,vec3 b,vec3 c,vec3 d){',
    '  return a+b*cos(6.28318*(c*t+d));',
    '}',

    /* ─────────────────────────────────────────────────────────
       Scene SDF — fractal diamond sphere
       Sphere with ridged multi-scale noise displacement for
       angular crystalline geometry.  Breathing radius, scroll-
       driven rotation, and mouse-reactive bulge.
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

    /* Multi-scale diamond displacement — abs() folds noise
       into angular ridged geometry; three octaves for fractal
       depth.  V-shaped valleys form the diamond lattice. */
    '  float d=abs(snoise(rn*2.0+t*0.10))*0.28',
    '         +abs(snoise(rn*4.5+t*0.15))*0.14',
    '         +abs(snoise(rn*9.0+t*0.08))*0.06;',

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

    /* Facet the surface normal — quantise into discrete planes
       to simulate the flat facets of a cut diamond.  Mix factor
       blends smooth and faceted normals for a refined finish. */
    '    vec3 qn=floor(nor*5.0+0.5)/5.0;',
    '    nor=normalize(mix(nor,qn,0.55));',

    /* Rotated coordinates for colour and scintillation —
       same rotation as in map() for consistency */
    '    float ay=t*0.05+u_scroll*1.0;',
    '    float ax=sin(t*0.03)*0.2+u_scroll*0.4;',
    '    float cy=cos(ay),sy=sin(ay),cx=cos(ax),sx=sin(ax);',
    '    vec3 rn=vec3(sn.x*cy+sn.z*sy,sn.y,-sn.x*sy+sn.z*cy);',
    '    rn=vec3(rn.x,rn.y*cx-rn.z*sx,rn.y*sx+rn.z*cx);',

    /* Triple-light setup — key, fill, and rim for
       diamond brilliance (adamantine luster) */
    '    vec3 l1=normalize(vec3(0.6,0.8,-0.5));',
    '    vec3 l2=normalize(vec3(-0.4,-0.3,-0.7));',
    '    vec3 l3=normalize(vec3(0.0,-0.7,-0.6));',
    '    float dif1=max(dot(nor,l1),0.0);',
    '    float dif2=max(dot(nor,l2),0.0);',
    '    float dif3=max(dot(nor,l3),0.0);',

    /* Diamond specular — very tight exponents (80–120)
       for the pinpoint brilliance of adamantine luster */
    '    vec3 h1=normalize(l1-rd);',
    '    float sp1=pow(max(dot(nor,h1),0.0),120.0);',
    '    vec3 h2=normalize(l2-rd);',
    '    float sp2=pow(max(dot(nor,h2),0.0),80.0);',
    '    vec3 h3=normalize(l3-rd);',
    '    float sp3=pow(max(dot(nor,h3),0.0),96.0);',

    /* Diamond scintillation — faceted flashing that depends on
       viewing angle and facet identity.  Each discrete cell in
       the 6³ grid flashes independently, like a real gemstone
       rotating under a light source.                           */
    '    vec3 fid=floor(rn*6.0)+0.5;',
    '    float facetSeed=snoise(fid);',
    '    float scint=sin(facetSeed*30.0+t*2.5+dot(nor,rd)*8.0);',
    '    scint=smoothstep(0.55,0.85,scint);',
    '    scint*=smoothstep(0.2,0.7,abs(snoise(rn*12.0)));',

    /* Colour — cosine palette driven by ridged fractal pattern.
       Ridged FBM creates sharp crystalline colour boundaries.
       Dark palette:  deep blue → teal → purple
       Light palette: softer / more pastel variant               */
    '    float ci=fbm(rn*2.0+t*0.04)*0.60+t*0.015;',

    '    vec3 dc=pal(ci,',
    '      vec3(0.30,0.40,0.60),',
    '      vec3(0.35,0.32,0.32),',
    '      vec3(0.70,0.80,1.00),',
    '      vec3(0.55,0.65,0.75));',

    '    vec3 lc=pal(ci,',
    '      vec3(0.45,0.52,0.55),',
    '      vec3(0.25,0.24,0.27),',
    '      vec3(0.70,0.80,1.00),',
    '      vec3(0.55,0.65,0.75));',

    '    vec3 bc=mix(dc,lc,u_theme);',

    /* Diamond fire — chromatic dispersion near edges.
       Prismatic rainbow shifts simulate a high refractive
       index (n ≈ 2.42) splitting white light into spectral
       colours.  Phase-shifted RGB sines for the rainbow. */
    '    float va=pow(1.0-max(dot(nor,-rd),0.0),2.5);',
    '    vec3 fire=vec3(',
    '      0.5+0.5*sin(va*12.0+t*0.5),',
    '      0.5+0.5*sin(va*12.0+t*0.5+2.094),',
    '      0.5+0.5*sin(va*12.0+t*0.5+4.189)',
    '    )*va*0.35;',

    /* Internal crystalline lattice — ridged noise product
       hints at depth and structure within the diamond.
       The product of two abs-noise octaves creates a web
       of bright lines where both octaves peak together. */
    '    float lattice=abs(snoise(pos*5.0+t*0.03));',
    '    lattice*=abs(snoise(pos*10.0-t*0.02));',

    /* Compose lighting — ambient, diffuse, specular, and
       scintillation for crystalline-substance rendering. */
    '    col=bc*(0.28+dif1*0.70+dif2*0.30+dif3*0.22);',
    '    col+=lattice*bc*0.20;',
    '    col+=fire;',
    '    col+=sp1*mix(vec3(0.8,0.9,1.0),vec3(0.95,0.97,1.0),u_theme)*0.80;',
    '    col+=sp2*mix(vec3(0.6,0.7,0.95),vec3(0.8,0.82,0.9),u_theme)*0.45;',
    '    col+=sp3*mix(vec3(0.7,0.8,0.95),vec3(0.85,0.88,0.92),u_theme)*0.50;',
    '    col+=scint*vec3(1.0,0.98,0.94)*1.2;',

    /* Fresnel rim — doubled for strong edge brilliance */
    '    float fres=pow(1.0-max(dot(nor,-rd),0.0),2.5);',
    '    col+=fres*mix(vec3(0.4,0.6,0.9),vec3(0.6,0.65,0.75),u_theme)*0.95;',

    /* ── Cursor-proximity surface glow ─────────────────────
       When the mouse is near a surface fragment the diamond
       brightens: diffuse glow, amplified scintillation, and
       a specular flash as if the cursor were a point light.  */
    '    vec2 cm=(uv-u_mouse)*vec2(asp,1.0);',
    '    float crd=length(cm);',
    '    float cpx=exp(-crd*crd*10.0);',
    /* Diffuse glow — soft warm brightening near cursor */
    '    vec3 cld=normalize(vec3(-cm,-0.5));',
    '    float cdif=max(dot(nor,cld),0.0);',
    '    col+=cdif*cpx*bc*0.35;',
    /* Amplify existing scintillation near cursor */
    '    col+=cpx*scint*vec3(1.0,0.98,0.94)*0.70;',
    /* Cursor specular — sharp pinpoint flash (half-vector) */
    '    vec3 ch=normalize(cld-rd);',
    '    float cks=pow(max(dot(nor,ch),0.0),80.0);',
    '    col+=cks*cpx*vec3(1.0,0.97,0.93)*0.70;',

    /* Alpha — distance-based fade; quartered below for transparency */
    '    alpha=smoothstep(8.0,2.0,td);',
    '  }',

    /* Crystalline halo — doubled glow intensity and alpha.
       Stronger scattering for thick diamond-substance atmosphere
       with brighter sparkle grains in the glow region. */
    '  if(!hit&&cdist<3.0){',
    '    float glow=smoothstep(3.0,0.5,cdist);',
    '    glow=glow*glow*glow;',
    '    vec3 gc=mix(vec3(0.18,0.28,0.55),vec3(0.32,0.38,0.48),u_theme);',
    '    col+=gc*glow*1.2;',
    '    alpha+=glow*mix(0.80,0.48,u_theme);',

    '    float gs=snoise(vec3(uv*40.0,t*2.5));',
    '    gs=smoothstep(0.82,0.96,gs)*glow;',
    '    col+=gs*mix(vec3(0.6,0.75,1.0),vec3(0.8,0.85,0.9),u_theme)*0.85;',
    '    alpha+=gs*0.36;',
    '  }',

    /* ── Cursor glow and sparkle ──────────────────────────
       Soft radial glow haze and high-frequency sparkle
       particles near the mouse.  Visible everywhere —
       on the surface, in the halo, and in empty space —
       so the cursor always trails light and sparkle. */
    '  vec2 cm2=(uv-u_mouse)*vec2(asp,1.0);',
    '  float cd2=length(cm2);',
    '  float cg2=exp(-cd2*cd2*12.0);',

    /* Glow haze — Gaussian² for soft radial falloff */
    '  vec3 chc=mix(vec3(0.30,0.50,0.90),vec3(0.55,0.60,0.75),u_theme);',
    '  col+=cg2*cg2*chc*0.45;',
    '  alpha+=cg2*cg2*mix(0.20,0.12,u_theme);',

    /* Sparkle particles — high-frequency noise masked by
       cursor proximity.  Only the top ~12 % of noise values
       produce bright points, giving sparse diamond dust. */
    '  float csk=snoise(vec3(uv*80.0,t*5.0));',
    '  csk=smoothstep(0.70,0.95,csk)*cg2;',
    '  col+=csk*vec3(1.0,0.97,0.90)*0.85;',
    '  alpha+=csk*0.32;',

    '  alpha=min(alpha,1.0)*u_alpha_scale;',

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
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return null;
    }
    var pg = gl.createProgram();
    gl.attachShader(pg, vs);
    gl.attachShader(pg, fs);
    gl.linkProgram(pg);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) {
      gl.deleteProgram(pg);
      return null;
    }
    return pg;
  }

  var prog = createProgram(VERT, FRAG);
  if (!prog) {
    /* Shader failed — static CSS gradient fallback (quartered alpha) */
    canvasA.style.display = 'none';
    mover.style.background =
      'radial-gradient(ellipse 80% 60% at 50% 40%,' +
      'rgba(91,160,245,0.24) 0%,transparent 70%)';
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
  var uAlpha  = gl.getUniformLocation(prog, 'u_alpha_scale');

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
  var initViewH    = getViewportSize().height;
  var initMaxScr   = Math.max(1, initDocH - initViewH);
  var smoothScrollY = Math.max(0, Math.min(1, initScrollY / initMaxScr));

  /* Mouse state — default to centre so the sphere has a
     subtle forward bulge even before the cursor moves. */
  var mouseX = 0.5, mouseY = 0.5;
  var smoothMouseX = 0.5, smoothMouseY = 0.5;

  var resizeTimer = null;
  var running     = !prefersReduced;
  var userPaused  = readManualPaused();
  var rafId       = 0;

  /* ═══════════════════════════════════════════════════════════
     Canvas sizing
     ═══════════════════════════════════════════════════════════ */
  function resize() {
    var viewport = getViewportSize();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = Math.max(1, Math.floor(viewport.width  * dpr * RES_SCALE));
    ch = Math.max(1, Math.floor(viewport.height * dpr * RES_SCALE));
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
    gl.uniform1f(uAlpha, ALPHA_SCALE);
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
    var viewH    = getViewportSize().height;
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
    gl.uniform1f(uAlpha, ALPHA_SCALE);

    /* ── Draw ─────────────────────────────────────────────── */
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    rafId = requestAnimationFrame(animate);
  }


  function startAnimation() {
    if (prefersReduced || userPaused || document.hidden || rafId) return;
    running = true;
    startTime = performance.now();
    prevTime = startTime;
    rafId = requestAnimationFrame(animate);
  }

  function stopAnimation() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function applyPausedState(paused) {
    userPaused = !!paused;
    if (userPaused) {
      stopAnimation();
      renderStatic();
      return;
    }
    startAnimation();
  }

  /* ═══════════════════════════════════════════════════════════
     Initialisation
     ═══════════════════════════════════════════════════════════ */
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  resize();

  if (prefersReduced || userPaused) {
    renderStatic();
  } else {
    startAnimation();
  }

  /* ═══════════════════════════════════════════════════════════
     Resize — debounced
     ═══════════════════════════════════════════════════════════ */
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      if (prefersReduced || userPaused) renderStatic();
    }, 200);
  });

  /* ═══════════════════════════════════════════════════════════
     Theme change
     ═══════════════════════════════════════════════════════════ */
  var themeObserver = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].attributeName === 'data-theme') {
        if (prefersReduced || userPaused) renderStatic();
        return;
      }
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true });

  window.addEventListener('pagehide', function () {
    clearTimeout(resizeTimer);
    themeObserver.disconnect();
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  });

  /* ═══════════════════════════════════════════════════════════
     Page visibility — pause rendering when tab is hidden
     ═══════════════════════════════════════════════════════════ */
  document.addEventListener('visibilitychange', function () {
    if (prefersReduced) return;
    if (document.hidden) {
      stopAnimation();
      return;
    }
    if (!userPaused) startAnimation();
  });


  window.addEventListener('sele4n:bg-animation-toggle', function (event) {
    var detail = event && event.detail;
    if (!detail || typeof detail.paused !== 'boolean') return;
    applyPausedState(detail.paused);
  });

  window.addEventListener('storage', function (event) {
    if (!event || event.key !== BG_ANIMATION_KEY) return;
    applyPausedState(readManualPaused());
  });

  /* ═══════════════════════════════════════════════════════════
     Mouse / touch tracking
     Normalised to [0, 1] with Y flipped for GL coordinates.
     ═══════════════════════════════════════════════════════════ */
  document.addEventListener('mousemove', function (e) {
    var viewport = getViewportSize();
    mouseX = Math.max(0, Math.min(1, e.clientX / viewport.width));
    mouseY = Math.max(0, Math.min(1, 1.0 - e.clientY / viewport.height));
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (e.touches.length > 0) {
      var viewport = getViewportSize();
      mouseX = Math.max(0, Math.min(1, e.touches[0].clientX / viewport.width));
      mouseY = Math.max(0, Math.min(1, 1.0 - e.touches[0].clientY / viewport.height));
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
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
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
    uAlpha  = gl.getUniformLocation(prog, 'u_alpha_scale');

    resize();
    running = !prefersReduced;
    if (!prefersReduced && !userPaused && !document.hidden) {
      startAnimation();
    } else {
      renderStatic();
    }
  });

})();
