/**
 * veins.js —— 流動金屬背景（可同時掛在多個區塊上）
 *
 * 參考使用者指定的效果（getdesign.md 的 mercury-veins）。
 * ⚠️ 原件是商業 starter kit 裡的 React 元件（.tsx）。這個專案是靜態 HTML、
 *    無框架、無建置、無相依，所以**不是移植，是自己寫一份**：
 *    純 WebGL1 + GLSL，自架在同網域，沒有新增任何第三方請求。
 *
 * 用法：在區塊上加 data-veins，值是強度（0~1，預設 1）。
 *   <section data-veins>            最後的 CTA 區，完整強度
 *   <figure  data-veins="0.45">     首頁 Hero，壓低——它後面還有車與彈幕
 *
 * ⚠️ 滑鼠互動掛在**最近的區塊**（section/figure 的容器）上，不是 canvas 上。
 *    canvas 被內容蓋住，指標事件根本到不了它；掛在容器上才能整塊都能攪動。
 *    **圖片背景的區塊不加 data-veins**，所以它們沒有互動——那是刻意的，
 *    照片不該被攪。
 *
 * 刻意的取捨：
 *  · 離開視窗就停、分頁隱藏就停。永遠在跑的 shader 是純粹的耗電。
 *  · DPR 封頂 1.5：2560 螢幕上以原生 DPR 算等於多畫四倍像素，看不出差別。
 *
 * 降級（三層，每一層都看得過去）：
 *  1. prefers-reduced-motion → 0.25 倍速（2026-10-02 起；以前是一張靜止的，見下方）
 *  2. 沒有 WebGL / shader 編譯失敗 → 什麼都不做，CSS 的底仍在，不會變空白
 *  3. JS 沒載入 → 同上
 */
(function () {
  'use strict';

  var VERT = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';

  var FRAG = [
    'precision mediump float;',
    'uniform vec2 u_res;',
    'uniform float u_time;',
    'uniform float u_amp;',
    'uniform vec2 u_mouse;',   // 0..1，-1 代表指標不在上面
    '',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
    'float noise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),',
    '             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'float fbm(vec2 p){',
    '  float v = 0.0, a = 0.5;',
    '  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }',
    '  return v;',
    '}',
    '',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / u_res;',
    '  float asp = u_res.x / max(u_res.y, 1.0);',
    '  vec2 p = vec2(uv.x * asp, uv.y) * 2.4;',
    '  float t = u_time * 0.055;',
    '',
    '  vec2 stir = vec2(0.0);',
    '  if (u_mouse.x >= 0.0) {',
    '    vec2 m = vec2(u_mouse.x * asp, u_mouse.y) * 2.4;',
    '    vec2 d = p - m;',
    '    stir = normalize(d + 1e-5) * exp(-length(d) * 1.5) * 0.55;',
    '  }',
    '',
    // 兩層 domain warp：噪訊拿去扭曲噪訊自己，才會有金屬流動的感覺
    '  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));',
    '  vec2 r2 = vec2(fbm(p + 2.0 * q + vec2(1.7, 9.2) + t * 1.3),',
    '                 fbm(p + 2.0 * q + vec2(8.3, 2.8) - t * 1.1));',
    '  float f = fbm(p + 2.1 * r2 + stir);',
    '',
    // 脈絡＝把等值線抽出來：f 越接近 0.5 越亮，指數越高線越細
    '  float vein = pow(1.0 - abs(f * 2.0 - 1.0), 15.0);',
    '  float deep = smoothstep(0.30, 0.78, f);',
    '',
    '  vec3 base   = vec3(0.055, 0.055, 0.078);',
    '  vec3 silver = vec3(0.90, 0.91, 0.95);',
    '  vec3 ember  = vec3(0.86, 0.06, 0.02);',
    '',
    '  vec3 col = base;',
    '  col = mix(col, ember * 0.55, deep * 0.30);',
    '  col += silver * vein * 0.52;',
    '',
    // 邊緣淡出：讓它融進區塊，而不是一塊貼上去的矩形
    '  float edge = smoothstep(0.0, 0.26, uv.y) * smoothstep(1.0, 0.74, uv.y)',
    '             * smoothstep(0.0, 0.14, uv.x) * smoothstep(1.0, 0.86, uv.x);',
    '  gl_FragColor = vec4(col, edge * 0.70 * u_amp);',
    '}'
  ].join('\n');

  function init(host) {
    var amp = parseFloat(host.getAttribute('data-veins'));
    if (!(amp > 0)) amp = 1;

    var canvas = document.createElement('canvas');
    canvas.className = 'veins-canvas';
    canvas.setAttribute('aria-hidden', 'true');

    var gl;
    try {
      gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, powerPreference: 'low-power' })
        || canvas.getContext('experimental-webgl');
    } catch (e) { gl = null; }
    // ⚠️ 沒有 WebGL 就直接退場：CSS 的底本來就在，畫面不會缺一塊。
    if (!gl) return;

    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
      return sh;
    }
    var vs = compile(gl.VERTEX_SHADER, VERT);
    var fs = compile(gl.FRAGMENT_SHADER, FRAG);
    // ⚠️ 編譯失敗同樣退場，不要留一塊黑色 canvas 蓋住底下的漸層。
    if (!vs || !fs) return;

    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

    host.appendChild(canvas);
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    var uRes = gl.getUniformLocation(prog, 'u_res');
    var uTime = gl.getUniformLocation(prog, 'u_time');
    var uMouse = gl.getUniformLocation(prog, 'u_mouse');
    var uAmp = gl.getUniformLocation(prog, 'u_amp');

    var mouse = [-1, -1];
    var running = false, visible = false, raf = 0, t0 = performance.now();
    // ⚠️ 停下再開始時要**接續**原本的時間（2026-10-02 加暫停鍵時改的）。
    //    以前 start() 一律把時間設回 1 秒，捲走再捲回來、切分頁回來都會跳一下；
    //    有了暫停鍵之後，「按繼續 → 畫面整個換掉」會非常明顯。
    var elapsed = 1000, lastNow = 0;
    function motionPaused() { return document.documentElement.getAttribute('data-motion') === 'paused'; }
    // ⚠️ 減少動態效果時放慢，不停（2026-10-02）。以前是「只畫一張靜止的就收工」，
    //    使用者在動畫效果關著的 Windows 電腦上看到整頁不動，以為壞了。
    //    這是一層緩慢流動的環境光，不是大面積位移；0.25 倍速時幾乎只剩「它是活的」。
    var speed = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 0.25 : 1;

    function resize() {
      // ⚠️ DPR 封頂 1.5：這是一層模糊的流體，原生 DPR 多算四倍像素看不出差別。
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      var w = Math.max(1, Math.round(host.clientWidth * dpr));
      var h = Math.max(1, Math.round(host.clientHeight * dpr));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    function draw(now) {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (now - t0) / 1000 * speed);
      gl.uniform1f(uAmp, amp);
      gl.uniform2f(uMouse, mouse[0], mouse[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function frame(now) {
      if (!running) return;
      lastNow = now;
      resize(); draw(now);
      raf = requestAnimationFrame(frame);
    }
    function start() {
      if (running) return;
      t0 = performance.now() - elapsed;   // 接續上次停下的地方（第一次是 1 秒：不要從全白開始）
      // 暫停中：只畫一張就好，讓區塊不是空的；不進 rAF 迴圈
      if (motionPaused()) { resize(); draw(performance.now()); return; }
      running = true;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      if (running && lastNow) elapsed = lastNow - t0;
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    // 暫停鍵（motion.js）。停下時畫面留在最後一格——WebGL 的畫布在下一次繪製前會一直顯示它。
    document.addEventListener('pl-motion', function (e) {
      if (e.detail && e.detail.paused) stop();
      else if (visible && !document.hidden) start();
    });

    // ⚠️ 離開視窗就停。Hero 以外的那一層在頁面最底部，絕大多數時間不在畫面上。
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        visible = es[0].isIntersecting;
        if (visible && !document.hidden) start(); else stop();
      }, { rootMargin: '120px' }).observe(host);
    } else { visible = true; start(); }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else if (visible) start();
    });

    // ⚠️ 指標事件掛在**最近的區塊**，不是 canvas：canvas 被內容蓋住，
    //    事件到不了它。掛在容器上整塊才都能攪動。
    var zone = host.closest('section') || host;
    zone.addEventListener('pointermove', function (e) {
      var r = host.getBoundingClientRect();
      if (!r.width || !r.height) return;
      mouse[0] = (e.clientX - r.left) / r.width;
      mouse[1] = 1 - (e.clientY - r.top) / r.height;   // WebGL 的 y 是反的
    });
    zone.addEventListener('pointerleave', function () { mouse[0] = -1; mouse[1] = -1; });

    window.addEventListener('resize', function () { if (running) resize(); });
  }

  var hosts = document.querySelectorAll('[data-veins]');
  for (var i = 0; i < hosts.length; i++) init(hosts[i]);
}());
