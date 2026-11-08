/**
 * 彈幕 —— 畫面（**只存在於測試版**，2026-10-28 Ray：先做好、不發行，handoff 9.1 #23）
 *
 * 由測試版 manifest 在 main.js 之後注入，用 main.js 的 `window.__plTest.api` 拿影片編號、
 * 直播與否、影片的位置。連線在 service worker（sw.js 的 dm*），這裡只負責畫面。
 *
 * ⚠️ **彈幕對齊影片時間軸**：每一則記「發在影片第幾毫秒」，播放位置走到那裡才飛出來。
 *    位置讀 `.tm-ui-seekbar` 的 aria-valuenow（鐵則 63；video.currentTime 在直播是假象）。
 *    所以重播不會被劇透，直播時發的彈幕之後看重播的人也看得到。
 * ⚠️ **只走畫面上方，避開字幕區**（字幕是主打賣點）。顯示區域最大 3/4，不提供全螢幕。
 * ⚠️ **預設關閉**，一鍵開關。不顯示任何身分。
 * ⚠️ **未付費看得到、不能發**（2026-10-28 Ray）：輸入框只在伺服器給了「可發言」時出現。
 * ⚠️ **即時推來的彈幕有 LIVE_GRACE_MS 的寬容**（2026-10-28 Ray）：每個人落後直播邊緣的秒數不同，
 *    跑在最前面的人播放位置已經超過別人發言的位置——只照位置對齊的話，他永遠看不到任何人的彈幕。
 *    所以「剛推來、而且只比我現在的位置早不到 30 秒」的彈幕當場飛；更早的照舊等倒回去才飛。
 * ⚠️ 控制列與設定面板放在**另一層（ctl，貼著視窗）**，不放在影片那一層（root 有 overflow:hidden、
 *    跟著影片框）：F1TV 的設定按鈕貼著視窗右下角，影片框則會隨視窗比例縮放置中——
 *    放在影片那一層時，改視窗大小控制列就被夾到影片框底下（2026-10-28 Ray 回報）。
 *
 * 設定面板（2026-10-28 Ray：「給他一個獨立 GUI，參考 bilibili」）：
 *   不透明度、顯示區域、速度、字型大小、粗體、描邊、密度、合併重複、屏蔽詞、恢復預設。
 *   全部存在 chrome.storage.local（只影響這台），讀回來一律過 cleanPrefs——壞掉的值退回預設。
 */
(function () {
  'use strict';
  const T = window.__plTest;
  if (!T || !window.PL || !PL.f1tvPlayer) return;   // 不是測試版（沒有掛鉤）就什麼都不做

  const player = PL.f1tvPlayer(document);
  const BUCKET = 30000;
  const KEY = 'pl_dm_prefs';

  // ---- 設定的選項（值→畫面上的字）----
  const AREAS = [[0.25, '1/4'], [0.33, '1/3'], [0.5, '1/2'], [0.75, '3/4']];
  const SPEEDS = [['xslow', '極慢'], ['slow', '慢'], ['mid', '適中'], ['fast', '快'], ['xfast', '極快']];
  const SPEED_PX = { xslow: 100, slow: 130, mid: 160, fast: 200, xfast: 250 };   // 每秒飛多少像素
  const DENSITY = [['low', '少'], ['mid', '適中'], ['high', '多']];
  // 同時在畫面上的上限（太多就略過，不排隊——排隊會越落越後面）
  const MAX_SHOWN = { low: 20, mid: 60, high: 120 };
  const STROKES = [['shadow', '陰影'], ['outline', '描邊'], ['heavy', '重墨']];
  const STROKE_CSS = {
    shadow: '0 0 3px #000,0 0 3px #000',
    outline: '-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000',
    heavy: '0 0 2px #000,0 0 4px #000,1px 1px 2px #000,-1px -1px 2px #000',
  };
  const LIVE_GRACE_MS = 30000;        // 即時推來的彈幕：比現在的位置早多少以內仍然當場飛
  const MERGE_MS = 8000;               // 合併重複：同一句 8 秒內只飛一次
  const BLOCK_MAX = 50;                // 屏蔽詞最多幾個
  const BLOCK_LEN = 20;                // 每個屏蔽詞最多幾個字
  const DEFAULTS = { opacity: 0.85, area: 0.25, speed: 'mid', size: 1, bold: true, stroke: 'shadow', density: 'mid', merge: true };
  const prefs = { on: false, collapsed: false, ...DEFAULTS, block: [] };

  /** 存起來的設定可能是舊版（例如以前的 lanes）或被改壞：一個一個驗，不合格的退回預設。 */
  function cleanPrefs(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const pick = (list, v, d) => (list.some(([k]) => k === v) ? v : d);
    const num = (v, lo, hi, d) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
    const block = [];
    for (const w of Array.isArray(r.block) ? r.block : []) {
      const t = String(w || '').trim().slice(0, BLOCK_LEN);
      if (t && !block.includes(t) && block.length < BLOCK_MAX) block.push(t);
    }
    return {
      on: r.on === true,
      collapsed: r.collapsed === true,
      opacity: num(r.opacity, 0.2, 1, DEFAULTS.opacity),
      area: pick(AREAS, r.area, DEFAULTS.area),
      speed: pick(SPEEDS, r.speed, DEFAULTS.speed),
      size: num(r.size, 0.6, 1.6, DEFAULTS.size),
      bold: typeof r.bold === 'boolean' ? r.bold : DEFAULTS.bold,
      stroke: pick(STROKES, r.stroke, DEFAULTS.stroke),
      density: pick(DENSITY, r.density, DEFAULTS.density),
      merge: typeof r.merge === 'boolean' ? r.merge : DEFAULTS.merge,
      block,
    };
  }

  const st = {
    cid: '', post: false, unpaid: false, toldView: false, denied: '', down: false, ctl: null, pendingReport: null, reportTimer: 0,
    items: new Map(),                  // id -> { id, pos, x, live, mine }
    buckets: new Set(),                // 已經拿過的 30 秒段
    shownIds: new Set(),
    lastPos: null, nextN: 1, pendingMine: new Map(),
    lanesFreeAt: [],
    recent: new Map(),                 // 合併重複用：正規化後的字 -> 上次飛出的時間
  };
  let root = null; let stage = null; let bar = null; let input = null; let tip = null; let sendBtn = null;
  let gear = null; let panel = null; let ctl = null;
  // 收合（2026-11-07 Ray：輸入框左邊一個箭頭；收起來時輸入框、送出、設定、彈幕開關全部藏起來，只剩一個小圓鈕，再按就展開）
  // ⚠️ 收合只藏控制列，不影響彈幕本身——彈幕開著就照樣飛。收合狀態存在 prefs（這台記得）。
  let colBtn = null; let bubble = null;
  // 控制列放在 F1TV 右下角原生「設定」按鈕的左邊（2026-10-28 Ray）。
  // ⚠️ class 名稱是 F1TV 2026-10 的版本；找不到就退回影片右下角，不會消失。
  const SETTINGS_SEL = ['.tm-ui-settingstogglebutton', '[class*="settingstogglebutton"]'];

  // ---- 偏好（存在 chrome.storage.local，只影響這台）----
  chrome.storage.local.get(KEY).then((r) => {
    Object.assign(prefs, cleanPrefs(r && r[KEY]));
    render();
  }).catch(() => render());
  const savePrefs = () => chrome.storage.local.set({ [KEY]: prefs }).catch(() => {});

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const fold = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const blocked = (x) => { const f = fold(x); return prefs.block.some((w) => f.includes(fold(w))); };

  // ---- 畫面 ----
  const PILL = 'all:unset;cursor:pointer;padding:6px 10px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;border:1px solid rgba(255,255,255,.35)';
  function host() { return document.fullscreenElement || document.body; }
  function build() {
    if (root && root.isConnected && root.parentNode === host() && ctl.parentNode === host()) return;
    if (!root) {
      root = document.createElement('div');
      root.id = 'pitlingo-dm';
      root.style.cssText = 'position:fixed;z-index:2147482980;pointer-events:none;overflow:hidden;';
      stage = document.createElement('div');
      stage.style.cssText = 'position:absolute;left:0;top:0;right:0;height:25%;';
      root.appendChild(stage);
      // 控制層：貼著視窗、不裁切（見檔頭）
      ctl = document.createElement('div');
      ctl.id = 'pitlingo-dm-ctl';
      ctl.style.cssText = 'position:fixed;inset:0;z-index:2147482981;pointer-events:none;';

      bar = document.createElement('div');
      bar.style.cssText = 'position:absolute;right:12px;bottom:64px;display:flex;gap:6px;align-items:center;pointer-events:auto;'
        + 'font:600 13px/1 "Noto Sans TC","Microsoft JhengHei",system-ui;';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.dm = 'toggle';
      btn.style.cssText = PILL;
      input = document.createElement('input');
      input.maxLength = 40;
      input.placeholder = '發彈幕（Enter 送出，最多 40 字）';
      input.style.cssText = 'all:unset;width:240px;padding:6px 10px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;border:1px solid rgba(255,255,255,.35);font:400 13px/1.2 system-ui';
      gear = document.createElement('button');
      gear.type = 'button';
      gear.dataset.dm = 'gear';
      gear.textContent = '⚙';
      gear.title = '彈幕設定';
      gear.style.cssText = PILL;
      tip = document.createElement('div');
      sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.dataset.dm = 'send';
      sendBtn.textContent = '送出';
      sendBtn.style.cssText = PILL;
      tip.style.cssText = 'position:absolute;right:12px;bottom:104px;max-width:320px;padding:6px 10px;border-radius:8px;background:rgba(0,0,0,.75);color:#ffd166;font:400 12px/1.4 system-ui;display:none;pointer-events:auto';
      colBtn = document.createElement('button');
      colBtn.type = 'button';
      colBtn.dataset.dm = 'collapse';
      colBtn.textContent = '▸';
      colBtn.title = '收合彈幕控制';
      colBtn.setAttribute('aria-label', '收合彈幕控制');
      colBtn.style.cssText = PILL + ';padding:4px 9px;font-size:16px;line-height:1';
      bubble = document.createElement('button');
      bubble.type = 'button';
      bubble.dataset.dm = 'expand';
      bubble.textContent = '彈';
      bubble.title = '展開彈幕控制';
      bubble.setAttribute('aria-label', '展開彈幕控制');
      bubble.style.cssText = 'all:unset;cursor:pointer;box-sizing:border-box;width:32px;height:32px;border-radius:50%;'
        + 'display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;'
        + 'border:1px solid rgba(255,255,255,.35);font:700 13px/1 "Noto Sans TC","Microsoft JhengHei",system-ui;';
      bar.append(colBtn, input, sendBtn, gear, btn, bubble);
      panel = buildPanel();
      ctl.append(bar, tip, panel);

      bar.addEventListener('click', onBarClick);
      // ⚠️ 打字時不可以讓播放器吃到按鍵（空白鍵暫停、方向鍵 seek）
      //    除了輸入框自己，也在 window 的捕獲階段攔一次（比 document／body 上的播放器快捷鍵早），
      //    Enter 在那裡就直接送出——播放器若在冒泡途中吃掉 Enter，輸入框自己的監聽器收不到。
      //    設定面板裡的按鍵（屏蔽詞輸入框、滑桿的方向鍵）同樣攔下；Esc 關面板。
      for (const ev of ['keydown', 'keyup', 'keypress']) {
        input.addEventListener(ev, (e) => e.stopPropagation(), true);
        addEventListener(ev, (e) => {
          if (e.target === input) {
            e.stopImmediatePropagation();
            if (ev === 'keydown' && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); say(); }
            return;
          }
          if (!panel || panel.style.display === 'none') return;
          if (ev === 'keydown' && e.key === 'Escape') { e.stopImmediatePropagation(); togglePanel(false); return; }
          if (!panel.contains(e.target)) return;
          e.stopImmediatePropagation();
          if (ev === 'keydown' && e.key === 'Enter' && !e.isComposing && e.target.dataset.dmset === 'blockInput') { e.preventDefault(); addBlock(); }
        }, true);
      }
      // 點面板外面就關（點齒輪本身交給 onBarClick 切換）
      addEventListener('pointerdown', (e) => {
        if (!panel || panel.style.display === 'none') return;
        const path = e.composedPath ? e.composedPath() : [];
        if (path.includes(panel) || path.includes(gear)) return;
        togglePanel(false);
      }, true);
      stage.addEventListener('click', onStageClick);
    }
    host().appendChild(root);
    host().appendChild(ctl);
  }

  // ---- 設定面板 ----
  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function row(label, ...kids) {
    const r = el('div', 'display:flex;align-items:center;gap:8px;margin:10px 0 0;');
    r.append(el('div', 'flex:0 0 64px;color:rgba(255,255,255,.7)', label), ...kids);
    return r;
  }
  /** 一排互斥的按鈕（顯示區域、速度、密度、描邊） */
  function seg(name, list) {
    const box = el('div', 'display:flex;flex:1;gap:4px;min-width:0;');   // 不換行：5 個速度要排在同一行
    for (const [v, label] of list) {
      const b = el('button', 'all:unset;cursor:pointer;flex:1;min-width:0;white-space:nowrap;text-align:center;padding:5px 2px;border-radius:6px;border:1px solid rgba(255,255,255,.25);', label);
      b.type = 'button';
      b.dataset.dmset = name;
      b.dataset.v = String(v);
      box.appendChild(b);
    }
    return box;
  }
  function slider(name, min, max, step) {
    const box = el('div', 'display:flex;flex:1;align-items:center;gap:8px;');
    const s = el('input', 'flex:1;accent-color:#e10600;cursor:pointer;');
    s.type = 'range'; s.min = min; s.max = max; s.step = step;
    s.dataset.dmset = name;
    const out = el('span', 'flex:0 0 38px;text-align:right;font-variant-numeric:tabular-nums;');
    out.dataset.dmout = name;
    box.append(s, out);
    return box;
  }
  function check(name, label) {
    const l = el('label', 'display:flex;align-items:center;gap:6px;cursor:pointer;');
    const c = el('input', 'accent-color:#e10600;cursor:pointer;margin:0;');
    c.type = 'checkbox';
    c.dataset.dmset = name;
    l.append(c, document.createTextNode(label));
    return l;
  }

  function buildPanel() {
    const p = el('div', 'position:absolute;right:12px;bottom:110px;width:320px;max-height:70vh;overflow:auto;pointer-events:auto;display:none;'
      + 'padding:12px 14px 14px;border-radius:10px;background:rgba(18,18,22,.94);color:#fff;border:1px solid rgba(255,255,255,.15);'
      + 'box-shadow:0 8px 24px rgba(0,0,0,.5);font:400 13px/1.3 "Noto Sans TC","Microsoft JhengHei",system-ui;');
    p.dataset.dmPanel = '1';
    const head = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:14px;');
    const x = el('button', 'all:unset;cursor:pointer;padding:0 4px;font-size:16px;', '✕');
    x.type = 'button';
    x.title = '關閉';
    x.dataset.dmset = 'close';
    head.append(el('span', '', '彈幕設定'), x);

    const checks = el('div', 'display:flex;gap:16px;flex:1;');
    checks.append(check('bold', '粗體'), check('merge', '合併重複彈幕'));

    const blockIn = el('input', 'all:unset;flex:1;min-width:0;padding:5px 8px;border-radius:6px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25);');
    blockIn.maxLength = BLOCK_LEN;
    blockIn.placeholder = '輸入要屏蔽的字詞';
    blockIn.dataset.dmset = 'blockInput';
    const addB = el('button', 'all:unset;cursor:pointer;padding:5px 10px;border-radius:6px;background:rgba(225,6,0,.8);', '加入');
    addB.type = 'button';
    addB.dataset.dmset = 'blockAdd';
    const chips = el('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;');
    chips.dataset.dmout = 'block';

    const reset = el('button', 'all:unset;cursor:pointer;display:block;margin:14px auto 0;padding:6px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.35);', '恢復預設');
    reset.type = 'button';
    reset.dataset.dmset = 'reset';
    reset.title = '開關與屏蔽詞會保留';

    p.append(head,
      row('不透明度', slider('opacity', 20, 100, 5)),
      row('顯示區域', seg('area', AREAS)),
      el('div', 'margin:4px 0 0 72px;color:rgba(255,255,255,.5);font-size:11px;', '從畫面上方算起；字幕所在的下方不會出現彈幕'),
      row('速度', seg('speed', SPEEDS)),
      row('字型大小', slider('size', 60, 160, 10)),
      row('描邊', seg('stroke', STROKES)),
      row('密度', seg('density', DENSITY)),
      row('', checks),
      row('屏蔽詞', blockIn, addB),
      chips,
      reset);

    p.addEventListener('click', onPanelClick);
    p.addEventListener('input', onPanelInput);
    return p;
  }

  function setPref(k, v) {
    prefs[k] = v;
    Object.assign(prefs, cleanPrefs(prefs));
    savePrefs();
    restyle();
    render();
    syncPanel();
  }

  function onPanelClick(e) {
    const b = e.target.closest('[data-dmset]');
    if (!b) return;
    const k = b.dataset.dmset;
    if (k === 'close') togglePanel(false);
    else if (k === 'area') setPref('area', Number(b.dataset.v));
    else if (k === 'speed' || k === 'density' || k === 'stroke') setPref(k, b.dataset.v);
    else if (k === 'blockAdd') addBlock();
    else if (k === 'blockDel') setPref('block', prefs.block.filter((w) => w !== b.dataset.v));
    else if (k === 'reset') {
      // 恢復預設：開關與屏蔽詞保留（屏蔽詞是使用者一個一個加的，清掉就找不回來）
      Object.assign(prefs, DEFAULTS);
      savePrefs();
      restyle();
      render();
      syncPanel();
    }
  }

  function onPanelInput(e) {
    const k = e.target.dataset.dmset;
    if (k === 'opacity') setPref('opacity', Number(e.target.value) / 100);
    else if (k === 'size') setPref('size', Number(e.target.value) / 100);
    else if (k === 'bold' || k === 'merge') setPref(k, !!e.target.checked);
  }

  function addBlock() {
    const i = panel.querySelector('[data-dmset="blockInput"]');
    const w = String(i.value || '').trim().slice(0, BLOCK_LEN);
    if (!w) return;
    if (prefs.block.length >= BLOCK_MAX) { hint('屏蔽詞最多 ' + BLOCK_MAX + ' 個', 3000); return; }
    i.value = '';
    if (!prefs.block.includes(w)) setPref('block', prefs.block.concat(w));
    // 已經在畫面上飛的也一起拿掉
    for (const n of stage.querySelectorAll('[data-dmid]')) if (!n.dataset.mine && blocked(n.textContent)) n.remove();
  }

  function togglePanel(open) {
    if (!panel) return;
    const show = open == null ? panel.style.display === 'none' : open;
    panel.style.display = show ? '' : 'none';
    if (show) syncPanel();
  }

  /** 面板上的每一個控制項對齊 prefs（只在面板開著時做） */
  function syncPanel() {
    if (!panel || panel.style.display === 'none') return;
    for (const b of panel.querySelectorAll('button[data-v]')) {
      const k = b.dataset.dmset;
      const on = String(prefs[k]) === b.dataset.v;
      b.style.background = on ? 'rgba(225,6,0,.85)' : 'transparent';
      b.style.borderColor = on ? 'rgba(225,6,0,.85)' : 'rgba(255,255,255,.25)';
    }
    for (const k of ['opacity', 'size']) {
      const s = panel.querySelector('input[data-dmset="' + k + '"]');
      const v = Math.round(prefs[k] * 100);
      if (document.activeElement !== s) s.value = String(v);
      panel.querySelector('[data-dmout="' + k + '"]').textContent = v + '%';
    }
    for (const k of ['bold', 'merge']) panel.querySelector('input[data-dmset="' + k + '"]').checked = !!prefs[k];
    const chips = panel.querySelector('[data-dmout="block"]');
    chips.textContent = '';
    for (const w of prefs.block) {
      const c = el('span', 'display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.12);');
      c.append(document.createTextNode(w));            // ⚠️ 只用 textNode，不用 innerHTML
      const x = el('button', 'all:unset;cursor:pointer;opacity:.7;', '✕');
      x.type = 'button';
      x.title = '移除';
      x.dataset.dmset = 'blockDel';
      x.dataset.v = w;
      c.appendChild(x);
      chips.appendChild(c);
    }
    if (!prefs.block.length) chips.appendChild(el('span', 'color:rgba(255,255,255,.45);font-size:12px;', '尚未加入屏蔽詞'));
  }

  /** 已經在畫面上的彈幕跟著新設定改（字型、描邊）；位置與速度只影響之後飛出來的 */
  function restyle() {
    if (!stage) return;
    for (const n of stage.children) n.style.font = fontCss();
    for (const n of stage.children) n.style.textShadow = STROKE_CSS[prefs.stroke];
  }
  const fontPx = () => Math.max(14, Math.round(24 * prefs.size));
  const fontCss = () => (prefs.bold ? 700 : 400) + ' ' + fontPx() + 'px/1.2 "Noto Sans TC","Microsoft JhengHei",system-ui';

  function settingsBtn() {
    for (const sel of SETTINGS_SEL) {
      for (const n of document.querySelectorAll(sel)) {
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return r;
      }
    }
    return null;
  }

  let lastBtnRect = null;
  function place() {
    if (!root) return;
    const r = (T.api.mainVideoRect && T.api.mainVideoRect()) || null;
    const box = r && r.width > 100 ? r : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    root.style.left = box.left + 'px';
    root.style.top = box.top + 'px';
    root.style.width = box.width + 'px';
    root.style.height = box.height + 'px';
    // 控制列跟著設定按鈕走，**以視窗右下角為基準記距離**（不是記絕對座標）：
    // 控制列自動隱藏時按鈕量不到，沿用上一次的距離——視窗大小改了，距離仍然對（按鈕貼著視窗右下角）。
    // 從來沒量到過按鈕：退回影片框的右下角。
    const s = settingsBtn();
    if (s) lastBtnRect = { r: innerWidth - s.left, b: innerHeight - (s.top + s.height / 2) };
    const right = lastBtnRect ? Math.max(0, lastBtnRect.r + 8) : Math.max(0, innerWidth - (box.left + box.width) + 12);
    const bottom = lastBtnRect ? Math.max(0, lastBtnRect.b - 16) : Math.max(0, innerHeight - (box.top + box.height) + 64);
    bar.style.right = right + 'px';
    bar.style.bottom = bottom + 'px';
    tip.style.right = right + 'px';
    tip.style.bottom = (bottom + 40) + 'px';
    panel.style.right = right + 'px';
    panel.style.bottom = (bottom + 42) + 'px';
  }

  function render() {
    build();
    place();
    const btn = bar.querySelector('[data-dm="toggle"]');
    btn.textContent = prefs.on ? '彈幕 開' : '彈幕 關';
    btn.style.background = prefs.on ? 'rgba(225,6,0,.75)' : 'rgba(0,0,0,.55)';
    const expanded = !prefs.collapsed;
    input.style.display = expanded && prefs.on && st.post && !st.denied ? '' : 'none';
    sendBtn.style.display = input.style.display;
    colBtn.style.display = expanded ? '' : 'none';
    gear.style.display = expanded ? '' : 'none';
    btn.style.display = expanded ? '' : 'none';
    bubble.style.display = expanded ? 'none' : 'flex';
    // 小圓鈕看得出彈幕是開是關（開＝紅邊）
    bubble.style.borderColor = prefs.on ? 'rgba(225,6,0,.9)' : 'rgba(255,255,255,.35)';
    stage.style.display = prefs.on ? '' : 'none';
    stage.style.opacity = String(prefs.opacity);
    stage.style.height = (prefs.area * 100) + '%';
    if (!prefs.on) stage.textContent = '';
    // ⚠️ 不在這裡 syncPanel：render 每 250 毫秒跑一次，重建屏蔽詞的 ✕ 會讓按到一半的點擊落空
  }

  function hint(text, ms) {
    if (!tip) return;
    tip.textContent = text;
    tip.style.display = text ? '' : 'none';
    clearTimeout(hint.t);
    if (text && ms) hint.t = setTimeout(() => { tip.style.display = 'none'; }, ms);
  }

  function onBarClick(e) {
    const b = e.target.closest('[data-dm]');
    if (!b) return;
    if (b.dataset.dm === 'toggle') {
      prefs.on = !prefs.on;
      savePrefs();
      if (prefs.on) { st.denied = ''; st.down = false; open(); } else { send({ type: 'dmClose', cid: st.cid }); hint(''); }
      render();
    } else if (b.dataset.dm === 'send') {
      say();
    } else if (b.dataset.dm === 'gear') {
      togglePanel();
    } else if (b.dataset.dm === 'collapse' || b.dataset.dm === 'expand') {
      prefs.collapsed = b.dataset.dm === 'collapse';
      if (prefs.collapsed) { togglePanel(false); if (document.activeElement === input) input.blur(); }
      savePrefs();
      render();
    }
  }

  function onStageClick(e) {
    const n = e.target.closest('[data-dmid]');
    if (!n || n.dataset.mine) return;
    // eslint-disable-next-line no-alert
    if (!confirm('檢舉這則彈幕？\n「' + n.textContent + '」')) return;
    const id = Number(n.dataset.dmid);
    // 檢舉的人當場就看不到這則（不必等後台處理）；倒回去也不會再飛
    n.remove();
    st.items.delete(id);
    st.shownIds.add(id);
    send({ type: 'dmReport', cid: st.cid, id }).then((r) => {
      if (!r || !r.ok) { hint('檢舉沒有送出（連線中斷），請稍後再試', 5000); return; }
      // 伺服器回「reported」才說收到了（2026-10-28 Ray：要讓人感覺我們收到了、會處理）
      st.pendingReport = id;
      clearTimeout(st.reportTimer);
      st.reportTimer = setTimeout(() => { if (st.pendingReport === id) hint('檢舉沒有回應（連線可能中斷），請稍後再試', 5000); }, 5000);
    });
  }

  /** 後台的暫停／慢速模式：變了才說一次 */
  function applyCtl(ctl) {
    const c = { paused: !!(ctl && ctl.paused), slow: Number(ctl && ctl.slow) || 0 };
    const prev = st.ctl || { paused: false, slow: 0 };
    st.ctl = c;
    if (c.paused && !prev.paused) hint('彈幕暫停中（管理員暫時關閉了這支影片的發言）', 6000);
    else if (!c.paused && prev.paused) hint('彈幕已恢復', 3000);
    else if (c.slow && c.slow !== prev.slow) hint('慢速模式：每 ' + c.slow + ' 秒最多一則', 5000);
  }

  // ---- 連線 ----
  /** 只能看的原因只說一次（open() 每 60 秒會再跑一次確認連線，不可以每次都跳提示） */
  function tellViewOnly() {
    if (st.post || st.toldView) return;
    st.toldView = true;
    hint(st.unpaid ? '目前只能看彈幕；付費後即可發送' : '目前只能看、不能發（帳號被限制發言）', 5000);
  }

  async function open() {
    if (!prefs.on || !st.cid || st.denied) return;
    const r = await send({ type: 'dmOpen', cid: st.cid });
    if (r && r.ok) { st.post = !!r.post; st.unpaid = !!r.unpaid; render(); tellViewOnly(); }
    else if (!st.denied) hint('彈幕連線失敗' + (r && r.error ? '：' + r.error : ''), 5000);
  }

  function say() {
    const x = input.value.trim();
    if (!x) return;
    const pos = player.pos();
    if (pos == null) { hint('找不到播放位置（進度條還沒出現）', 3000); return; }
    const n = st.nextN++;
    st.pendingMine.set(n, { x, pos });
    hint('送出中…');
    send({ type: 'dmSay', cid: st.cid, x, pos, live: !!T.api.isLive(), n }).then((r) => {
      if (!r || !r.ok) { st.pendingMine.delete(n); hint('連線還沒好，請稍後再試（' + (r && r.error ? r.error : '背景連線未建立') + '）', 5000); return; }
      // 伺服器 5 秒內沒有回 ack／err：說出來，不要讓人以為送出了
      setTimeout(() => { if (st.pendingMine.has(n)) { st.pendingMine.delete(n); hint('伺服器沒有回應（連線可能中斷，稍後再試）', 5000); } }, 5000);
    });
    input.value = '';
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'dmEvent') return false;
    const m = msg.data || {};
    if (m.t === 'hello') { st.post = !!m.post; st.unpaid = !!m.unpaid; render(); tellViewOnly(); applyCtl(m.ctl); }
    else if (m.t === 'm') { for (const it of m.items || []) add(it, false); flyLate(m.items || []); }
    else if (m.t === 'ack') {
      const p = st.pendingMine.get(m.n);
      st.pendingMine.delete(m.n);
      if (p) { const it = { id: m.id, pos: p.pos, x: p.x, mine: true }; add(it, true); fly(it); hint('已送出', 1500); }
    } else if (m.t === 'err') { st.pendingMine.delete(m.n); hint((m.msg || '送不出去') + (m.code ? '（' + m.code + '）' : ''), 5000); }
    else if (m.t === 'del') for (const id of m.ids || []) { st.items.delete(id); const n = stage && stage.querySelector('[data-dmid="' + id + '"]'); if (n) n.remove(); }
    else if (m.t === 'denied') {
      st.denied = m.code || 'denied';
      // E82＝尚未開放（不在白名單）：說一次就好，不是故障
      hint((m.code === 'E82' ? '彈幕尚未開放（不在白名單）' : (m.msg || '彈幕無法使用')) + (m.code ? '（' + m.code + '）' : ''), 8000);
      render();
    } else if (m.t === 'down') { st.down = true; hint('彈幕連線中斷，稍後會自動重試', 4000); }
    else if (m.t === 'reported') {
      if (st.pendingReport === m.id) { st.pendingReport = null; clearTimeout(st.reportTimer); }
      hint('已收到檢舉，我們會盡快檢查並處理。謝謝你！', 5000);
    } else if (m.t === 'muted') {
      const left = m.until ? Math.max(1, Math.round(m.until - Date.now() / 1000)) : 0;
      hint(left ? '你已被禁言 ' + left + ' 秒' : '你已被禁止發送彈幕', 6000);
    } else if (m.t === 'unmuted') hint('禁言已解除', 3000);
    else if (m.t === 'ctl') applyCtl(m.ctl);
    return false;
  });

  function add(it, mine) {
    if (!it || !it.id) return;
    const had = st.items.get(it.id);
    st.items.set(it.id, Object.assign({}, it, { mine: mine || (had && had.mine) }));
    if (mine) st.shownIds.add(it.id);   // 自己的那一則送出當下就飛過了
  }

  /**
   * 即時推來的彈幕：發言者的位置已經在我後面（我跑得比他前面），但差不到 LIVE_GRACE_MS → 當場飛。
   * 還在我前面的不動：播放位置走到那裡時主迴圈會飛。
   */
  function flyLate(items) {
    if (!prefs.on) return;
    const pos = player.pos();
    if (pos == null) return;
    for (const it of items) {
      if (!it || !it.id || st.shownIds.has(it.id)) continue;
      if (it.pos <= pos && pos - it.pos <= LIVE_GRACE_MS) { st.shownIds.add(it.id); fly(it); }
    }
  }

  async function loadBucket(b) {
    if (b < 0 || st.buckets.has(b) || !st.cid || st.denied) return;
    st.buckets.add(b);
    const r = await send({ type: 'dmRange', cid: st.cid, b });
    if (r && r.ok) for (const it of r.items) add(it, false);
    else st.buckets.delete(b);          // 下一輪再試（輪詢本身就是上限：每 250 毫秒最多一次）
  }

  // ---- 飛 ----
  function fly(it) {
    if (!prefs.on || !stage || stage.childElementCount >= MAX_SHOWN[prefs.density]) return;
    const now = performance.now();
    if (!it.mine) {
      if (blocked(it.x)) return;        // 屏蔽詞：自己發的不擋（不然會以為沒送出）
      if (prefs.merge) {
        const k = fold(it.x);
        if (now - (st.recent.get(k) || -Infinity) < MERGE_MS) return;
        st.recent.set(k, now);
        if (st.recent.size > 500) st.recent.clear();
      }
    }
    const W = stage.clientWidth || innerWidth;
    // 行數由「顯示區域的高度 ÷ 行高」決定：區域大、字小 → 行多
    const lh = Math.ceil(fontPx() * 1.35);
    const lanes = Math.max(1, Math.floor((stage.clientHeight || 200) / lh));
    st.lanesFreeAt.length = lanes;
    let lane = -1;
    for (let i = 0; i < lanes; i++) if (!(st.lanesFreeAt[i] > now)) { lane = i; break; }
    if (lane < 0) return;               // 每一行都滿了就略過（不排隊）
    const n = document.createElement('div');
    n.dataset.dmid = String(it.id);
    if (it.mine) n.dataset.mine = '1';
    n.textContent = it.x;
    n.style.cssText = 'position:absolute;white-space:nowrap;left:0;will-change:transform;pointer-events:auto;cursor:pointer;color:#fff;'
      + 'top:' + (lane * lh) + 'px;' + (it.mine ? 'border:1px solid #ffd166;border-radius:6px;padding:0 4px;' : '');
    n.style.font = fontCss();
    n.style.textShadow = STROKE_CSS[prefs.stroke];
    stage.appendChild(n);
    const w = n.offsetWidth;
    const px = SPEED_PX[prefs.speed];
    const dur = (W + w) / px * 1000;
    // 同一行下一則要等這一則的尾巴離開右邊緣
    st.lanesFreeAt[lane] = now + (w + 40) / px * 1000;
    const a = n.animate([{ transform: 'translateX(' + W + 'px)' }, { transform: 'translateX(' + (-w) + 'px)' }], { duration: dur, easing: 'linear' });
    a.onfinish = () => n.remove();
  }

  // ---- 主迴圈：每 250 毫秒看一次影片與位置 ----
  let lastEnsure = 0;
  function tick() {
    const cid = String((T.api.contentId && T.api.contentId()) || '');
    if (cid !== st.cid) {
      if (st.cid) send({ type: 'dmClose', cid: st.cid });
      Object.assign(st, { cid, denied: '', down: false, post: false, unpaid: false, toldView: false, lastPos: null, ctl: null });
      st.items.clear(); st.buckets.clear(); st.shownIds.clear(); st.recent.clear();
      if (stage) stage.textContent = '';
      if (cid && prefs.on) open();
    }
    // 離開影片（SPA 換頁回到列表）：整個彈幕層與控制列都藏起來，不然會留在網站頁面上。
    // ⚠️ 不能只看 cid：主程式離開影片時不會把 contentId 清掉（只在換到下一支時更新），
    //    所以還要看頁面上現在有沒有影片（mainVideoRect 只算寬 ≥100、高 ≥60 的 video）
    const vr = T.api.mainVideoRect && T.api.mainVideoRect();
    const onVideo = !!(cid && vr && vr.width >= 100 && vr.height >= 60);
    if (!onVideo) {
      if (root) root.style.display = 'none';
      if (ctl) ctl.style.display = 'none';
      if (panel) panel.style.display = 'none';
      return;
    }
    if (root) root.style.display = '';
    if (ctl) ctl.style.display = '';
    render();
    if (!prefs.on || st.denied) return;
    // 每 60 秒確認一次連線（SW 被回收、斷線後補回來；sw 那邊是冪等的）
    if (Date.now() - lastEnsure > 60000) { lastEnsure = Date.now(); open(); }
    const pos = player.pos();
    if (pos == null) return;
    const b = Math.floor(pos / BUCKET);
    loadBucket(b);
    loadBucket(b + 1);
    const prev = st.lastPos;
    st.lastPos = pos;
    // 跳轉（往回或往前超過 3 秒）：不補放中間的，從現在開始
    if (prev != null && pos < prev) st.shownIds.clear();   // 倒回去看：那一段的彈幕再飛一次
    if (prev == null || pos < prev || pos - prev > 3000) return;
    for (const it of st.items.values()) {
      if (it.pos > prev && it.pos <= pos && !st.shownIds.has(it.id)) { st.shownIds.add(it.id); fly(it); }
    }
  }
  setInterval(() => { try { tick(); } catch (e) { /* 彈幕壞掉不影響字幕 */ } }, 250);
  document.addEventListener('fullscreenchange', () => { try { build(); place(); } catch (e) { /* 下一輪再試 */ } });
  addEventListener('resize', () => { try { place(); } catch (e) { /* 下一輪再試 */ } });
})();
