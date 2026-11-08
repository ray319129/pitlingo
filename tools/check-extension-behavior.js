#!/usr/bin/env node
/**
 * 擴充功能 —— 使用者看得到的行為（2026-09-17 全面檢視時新增）
 *
 * ⚠️ **為什麼要再一支：** smoke-extension 驗的是「每條路徑上的識別字都存在」，
 *    計時器是空函式、授權永遠是同一個狀態、storage 的變更事件從來不觸發——
 *    所以下面這些問題在那裡**一行都不會執行到**，測試照樣綠：
 *
 *      · 免費使用者看直播時，擴充功能從來不知道那是直播
 *        （isLive 只在「付費才跑」的整軌預抓裡設定）→ 免費額度用重播的規則算，
 *        直播的播放位置動輒幾千秒，額度一開始就是 0
 *      · 遠端總開關（killSwitch）與版本下限在**頁面載入時**就已經開著的話完全不生效
 *        （只有「開著分頁的期間版本號改變」才會判斷）
 *      · 免費額度用完 → 原生英文字幕還給使用者；之後只要改任何一個設定，
 *        原生字幕又被藏起來，而我們也不畫——畫面上一個字都沒有
 *      · 買完授權要等 60 秒才生效，而且原生英文字幕不會被重新隱藏（雙重英文）
 *      · 字幕長時間空白會被切成好幾段、每段都說「20 秒」（兩個檢查共用同一個計時變數）
 *
 * 這裡用可以控制的時鐘、影片、字幕容器、storage 事件與授權狀態，一步一步推著走。
 *
 * 用法：node tools/check-extension-behavior.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
// PL_EXT_ROOT：拿建置出來的版本來測（build-extension --check 用它驗正式版）
const EXT = process.env.PL_EXT_ROOT || path.join(root, 'extension');
// 正式版建置沒有 src/test/。原始碼與測試版都有——兩者都含 @test-only 的程式碼
const RELEASE = !fs.existsSync(path.join(EXT, 'src/test'));
// 含管理版程式碼（原始碼與管理版建置）：前導收割模式預設開，直播批次會等 20 秒。
// 一般觀眾的測試在這些版本上要先把前導模式關掉（storage 沒指定 plLeader 時），前導模式另外在 7e 測
const HAS_ADMIN = fs.existsSync(path.join(EXT, 'src/admin'));

let failed = 0;
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { failed++; console.log('❌ ' + m); };

const HIDE = '.tm-subtitle-region-container{opacity:0 !important}';

async function makeEnv(opts) {
  const o = Object.assign({
    path: '/detail/1000010267/2026-monaco-grand-prix',
    licensed: false, signedIn: false,
    config: {},
    currentTime: 30,
    storage: null,              // 載入前就在 chrome.storage.local 裡的資料
    // 播放中讓 video.currentTime 跟著推進的時間走。**預設關閉**：
    // 免費額度那幾個測試是拿固定的播放位置在算「前 N 分鐘」，讓它自己跑會改掉那些前提。
    // 需要「真的在播」的測試（自動診斷的計時）才打開。
    advanceVideo: false,
    // 自訂 SW 回應：回傳 undefined 就走預設（管理版收割用它模擬抓分段與蓋章）
    respond: null,
    // 含管理版程式碼時，預設替一般觀眾的測試把前導模式關掉（HAS_ADMIN）。true＝照管理版的真實預設（前導開），7e 用
    leaderDefault: false,
  }, opts || {});

  let NOW = Date.parse('2026-09-20T12:00:00Z');
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  }

  const errors = [];
  const timeouts = new Map();
  let tid = 0;
  const intervals = [];
  const winListeners = {};
  const msgListeners = [];
  const storageListeners = [];
  const store = Object.assign(HAS_ADMIN && !o.leaderDefault ? { plLeader: { on: false } } : {}, o.storage || {});
  const sent = [];
  const env = { licensed: o.licensed, signedIn: o.signedIn, config: o.config };

  let captionText = '';
  function el(tag) {
    const cls = new Set();
    const e = {
      tagName: String(tag || 'div').toUpperCase(),
      style: { setProperty(k, v) { this[k] = v; } }, dataset: {}, children: [], textContent: '', className: '', id: '',
      isConnected: false, firstElementChild: null, parent: null,
      classList: {
        add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
        toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)),
      },
      appendChild(c) { this.children.push(c); c.parent = this; c.isConnected = true; return c; },
      append(...cs) { cs.forEach((c) => this.appendChild(c)); },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.isConnected = false; c.parent = null; return c; },
      remove() { if (this.parent) this.parent.removeChild(this); },
      setAttribute() {}, getAttribute: () => null, addEventListener() {}, removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 1280, height: 720, top: 0, left: 0, bottom: 720, right: 1280 }),
      contains: () => true, closest: () => null, __cls: cls,
    };
    return e;
  }
  const span = { firstElementChild: null, get textContent() { return captionText; } };
  const label = { firstElementChild: span, querySelectorAll: (s) => (s === '*' && captionText ? [span] : []), get textContent() { return captionText; } };
  const container = {
    querySelectorAll: (s) => (s === '.tm-ui-subtitle-label' && captionText ? [label] : []),
    getBoundingClientRect: () => ({ width: 1280, height: 200, top: 500, left: 0, bottom: 700, right: 1280 }),
    get textContent() { return captionText; }, firstElementChild: null,
  };
  const video = {
    currentTime: o.currentTime, paused: false, ended: false, readyState: 4, duration: 7200,
    videoWidth: 1920, videoHeight: 1080, seekable: { length: 0 }, buffered: { length: 0 },
    getBoundingClientRect: () => ({ width: 1280, height: 720, top: 0, left: 0, bottom: 720, right: 1280 }),
  };
  // F1TV（Bitmovin Player UI）的字幕語言 <select>。o.cc = { options: [[value, 文字], …], selected, reject }
  // reject＝播放器不接受（模擬 F1TV 改版後 change 事件沒有作用）
  const cc = o.cc ? {
    options: o.cc.options.map(([value, textContent]) => ({ value, textContent })),
    selectedIndex: o.cc.selected || 0, changes: 0,
    get value() { const x = this.options[this.selectedIndex]; return x ? x.value : ''; },
    set value(v) { const i = this.options.findIndex((x) => x.value === v); if (i >= 0) this.selectedIndex = i; },
    dispatchEvent(e) { if (e && e.type === 'change') { this.changes++; if (o.cc.reject) this.selectedIndex = 0; } return true; },
  } : null;
  const head = el('head');
  const document = {
    visibilityState: 'visible', documentElement: el('html'), head, body: el('body'),
    createElement: (t) => el(t),
    // env.noVideo＝影片元素不存在（整頁載入時播放器還沒建好、或 F1TV 重建播放器）
    querySelector: (s) => (s === 'video' && !env.noVideo ? video : null),
    querySelectorAll: (s) => (s === '.tm-subtitle-region-container' ? [container] : s === 'video' ? (env.noVideo ? [] : [video]) : s === 'select.tm-ui-subtitleselectbox' && cc ? [cc]
      // F1TV 直播結束後的「Starts in N」自動播下一支倒數（管理版回首頁，7e）
      : s === 'button, a, div, span' && env.countdown ? [{ children: [], textContent: env.countdown }] : []),
    addEventListener() {}, removeEventListener() {}, getElementById: () => null,
  };

  function baseConfig() {
    return Object.assign({
      version: 1,
      sites: [{
        host: 'f1tv.formula1.com', captionRoot: ['.tm-subtitle-region-container'],
        captionLabel: ['.tm-ui-subtitle-label'], contentIdPattern: '/detail/(\\d+)', hideCss: HIDE,
      }],
      freeTier: { seconds: 900, guestSeconds: 180, exclude: ['post-race'], include: ['practice', 'qualifying', 'sprint', '-race$', 'grand-prix$'] },
    }, env.config);
  }

  const chrome = {
    runtime: {
      lastError: null,
      // env.dead＝擴充功能已被重新載入：Chrome 對舊的 content script 丟「Extension context invalidated」
      getManifest: () => { if (env.dead) throw new Error('Extension context invalidated.'); return { version: '0.25.0' }; },
      sendMessage(msg, cb) {
        sent.push(msg);
        const t = msg && msg.type;
        let r = { ok: true };
        if (t === 'getConfig' || t === 'refreshConfig') r = { ok: true, config: baseConfig() };
        else if (t === 'getSettings') r = { ok: true, settings: store.settings || {} };
        else if (t === 'accountStatus') r = { ok: true, result: { signedIn: env.signedIn } };
        else if (t === 'licenseStatus') r = { ok: true, license: { active: env.licensed } };
        else if (t === 'getBundle') r = { ok: true, bundle: { lines: {}, segCount: 0 } };
        else if (t === 'translate') {
          // 伺服器回的是 normKey 之後的鍵。這裡用同一套正規化（小寫、只留字母數字與中日韓）
          const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
          const out = {};
          for (const l of (msg.lines || [])) out[norm(l)] = '中文：' + l;
          r = { ok: true, result: { lines: out } };
        }
        if (o.respond) { const x = o.respond(msg); if (x !== undefined) r = x; }
        // 直播的翻譯要 1~3 秒才回來。延遲回應才測得到落後多久
        if (cb) {
          if (t === 'translate' && env.translateMs) timeouts.set(++tid, { at: NOW + env.translateMs, fn: () => cb(r) });
          else cb(r);
        }
      },
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
    },
    storage: {
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
      local: {
        get(keys, cb) {
          const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
          const out = {}; ks.forEach((k) => { if (k in store) out[k] = JSON.parse(JSON.stringify(store[k])); });
          if (cb) cb(out); return Promise.resolve(out);
        },
        set(obj, cb) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
          storageListeners.forEach((fn) => { try { fn(changes, 'local'); } catch (e) { errors.push('onChanged：' + e.message); } });
          if (cb) cb(); return Promise.resolve();
        },
      },
    },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document, chrome,
    location: { href: 'https://f1tv.formula1.com' + o.path, pathname: o.path, hostname: 'f1tv.formula1.com', origin: 'https://f1tv.formula1.com', assign(u) { this.assigned = u; } },
    performance: { getEntriesByType: () => [], setResourceTimingBufferSize() {}, now: () => NOW },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { tid++; timeouts.set(tid, { fn, at: NOW + (Number(ms) || 0) }); return tid; },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (fn, ms) => { intervals.push({ fn, ms, next: NOW + ms }); return intervals.length; },
    clearInterval() {},
    requestAnimationFrame: () => 0,
    Date: FakeDate, Math, JSON, Map, Set, Promise, RegExp, URL, Error, Object, Array, String, Number, Boolean,
    TextDecoder, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    navigator: { userAgent: 'node' },
    Event: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } },
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.addEventListener = (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.postMessage = () => {};

  const ctx = vm.createContext(sandbox);
  for (const f of ['src/shared/normalize.js', 'src/shared/defaults.js', 'src/shared/live-delay.js', 'src/content/main.js']) {
    // o.delayBehind：假裝延遲畫面已經生效、落後 N 秒（真的延遲要整套進度條與按鍵，check-live-delay 另外測）
    if (f === 'src/content/main.js' && o.delayBehind) {
      sandbox.PL.createLiveDelay = () => ({ setEnabled() {}, tick() {}, status: () => ({ enabled: true, active: true, behind: o.delayBehind, seconds: 45 }) });
    }
    vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f });
  }
  const INNER = vm.runInContext('this', ctx);
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  await settle();

  function safe(fn) { try { fn(); } catch (e) { errors.push(e.message); } }
  async function advance(ms) {
    const end = NOW + ms;
    while (NOW < end) {
      const step = Math.min(end, NOW + 100) - NOW;
      NOW += step;
      if (o.advanceVideo && !video.paused && !video.ended) video.currentTime += step / 1000;
      for (const it of intervals) { while (it.next <= NOW) { it.next += it.ms; safe(it.fn); } }
      const due = [...timeouts.entries()].filter(([, t]) => t.at <= NOW).sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) { timeouts.delete(id); safe(t.fn); }
      await settle();
    }
  }
  function post(data) { (winListeners.message || []).forEach((h) => h({ source: INNER, data: Object.assign({ __pitlingo_vtt__: true }, data) })); }
  function ask(type) {
    let out = null;
    msgListeners.forEach((fn) => fn({ type }, {}, (r) => { out = r; }));
    return out;
  }
  const hideCount = () => head.children.filter((c) => c.tagName === 'STYLE' && c.textContent === HIDE && c.isConnected).length;

  return {
    env, video, cc, store, sent, errors, advance, post, ask, hideCount, settle,
    fire: (t, ev) => (winListeners[t] || []).forEach((h) => h(Object.assign({ type: t }, ev))),
    location: sandbox.location,
    set caption(t) { captionText = t; },
    api: sandbox.__pitlingo, admin: sandbox.__plAdmin, setStorage: (obj) => chrome.storage.local.set(obj),
  };
}

// 免費範圍的正式規則（與後端 REMOTE_CONFIG.freeTier 相同，check-consistency 驗兩邊逐字一致）
const FREE_TIER_REAL = (() => {
  const src = fs.readFileSync(path.join(EXT, 'src/shared/defaults.js'), 'utf8');
  // 整行擷取：規則裡本身就有中括號（[a-z0-9-]），用 [^\]]* 會在中間截斷
  const ex = src.match(/^\s*exclude:\s*(\[.*\]),\s*$/m);
  const inc = src.match(/^\s*include:\s*(\[.*\]),\s*$/m);
  // eslint-disable-next-line no-eval
  return { seconds: 900, guestSeconds: 180, exclude: eval(ex[1]), include: eval(inc[1]) };
})();

const LIVE_SUB_PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1200\n#EXTINF:6.0,\nseg1200.vtt\n#EXTINF:6.0,\nseg1201.vtt\n';
const VOD_SUB_PLAYLIST = LIVE_SUB_PLAYLIST + '#EXT-X-ENDLIST\n';

(async () => {
  // ---- 1. 免費遊客看直播：要知道是直播，額度要用「實際觀看秒數」算 ----
  {
    const E = await makeEnv({ currentTime: 7200 });   // 直播的播放位置常常是好幾千秒
    E.post({ kind: 'manifest', url: 'https://ott-video-cf.formula1.com/x/sub_eng.m3u8', manifest: LIVE_SUB_PLAYLIST });
    await E.settle();
    E.api.state.isLive === true
      ? ok('免費使用者看直播：擴充功能知道這是直播')
      : bad('免費使用者看直播：擴充功能以為是重播（isLive 只在付費才跑的整軌預抓裡設定）');

    const q0 = E.ask('quickStatus');
    const left0 = q0 && q0.state && q0.state.freeLeft;
    left0 >= 170
      ? ok(`直播一開始的免費額度是完整的（剩 ${left0} 秒）`)
      : bad(`直播一開始免費額度就只剩 ${left0} 秒 —— 用了重播的規則（播放位置 7200 秒）`);

    await E.advance(60000);
    const left1 = E.ask('quickStatus').state.freeLeft;
    left1 >= 100 && left1 <= 140
      ? ok(`直播看了 60 秒，免費額度照實際觀看秒數扣（剩 ${left1} 秒）`)
      : bad(`直播看了 60 秒，免費額度是 ${left1} 秒（應該在 120 秒左右）`);

    E.post({ kind: 'vtt', url: 'https://x/seg1202.vtt', vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHe is pushing hard on the soft tyre\n' });
    await E.advance(3000);
    const tr = E.sent.filter((m) => m.type === 'translate');
    tr.length && tr.every((m) => m.urgent === true)
      ? ok('直播的翻譯請求一律標成急件（不讓路，避免字幕斷斷續續）')
      : bad(`直播的翻譯請求沒有標成急件（${tr.length} 批，urgent=${tr.map((m) => m.urgent).join(',')}）`);
  }

  // ---- 2. 重播：額度是「今天所有影片共用」，照實際觀看秒數扣，與播放位置無關 ----
  //  2026-09-18 以前重播看「是不是在前 N 分鐘」——每一支影片各送一份。使用者決定改成每日共用。
  const TODAY = '2026-09-20';            // 測試時鐘 2026-09-20T12:00Z ＝ 台灣時間 20:00
  {
    const E = await makeEnv({ currentTime: 4000 });   // 從影片中段開始看
    E.post({ kind: 'manifest', url: 'https://ott-video-fer-cf.formula1.com/x/sub_eng.m3u8', manifest: VOD_SUB_PLAYLIST });
    await E.settle();
    const left0 = E.ask('quickStatus').state.freeLeft;
    await E.advance(30000);
    const left1 = E.ask('quickStatus').state.freeLeft;
    E.api.state.isLive === false && left0 >= 175 && left1 >= 145 && left1 <= 155
      ? ok(`重播：額度照實際觀看秒數扣，與播放位置無關（位置 4000 秒開始剩 ${left0} 秒，看 30 秒後剩 ${left1} 秒）`)
      : bad(`重播的額度不對（isLive=${E.api.state.isLive}，開始剩 ${left0}、看 30 秒後剩 ${left1}）`
        + ' —— 仍在用播放位置判定，等於每支影片各送一份');
  }

  // ---- 2b. 換一支影片不可以重置：今天稍早在別支用掉的要算進來 ----
  {
    const E = await makeEnv({ path: '/detail/1000010366/2026-spanish-gp-practice-1',
      storage: { freeDaily: { day: TODAY, spent: 170 } } });
    await E.settle();
    const left = E.ask('quickStatus').state.freeLeft;
    left <= 10
      ? ok(`換一支影片：今天稍早用掉的 170 秒照樣算（剩 ${left} 秒）`)
      : bad(`換一支影片額度又回來了（剩 ${left} 秒）—— 等於每支影片各送一份`);
  }

  // ---- 2c. 隔天（台灣時間）重新開始；看的時候要寫回 storage 讓別的分頁知道 ----
  {
    const E = await makeEnv({ storage: { freeDaily: { day: '2026-09-19', spent: 999 } } });
    await E.settle();
    const left = E.ask('quickStatus').state.freeLeft;
    await E.advance(20000);
    const saved = E.store.freeDaily || {};
    left >= 175 && saved.day === TODAY && saved.spent >= 10 && saved.spent <= 25
      ? ok(`隔天重新開始（昨天用完，今天剩 ${left} 秒），看了 20 秒寫回 storage（${saved.spent} 秒）`)
      : bad(`每日重置或寫回不對（剩 ${left} 秒，storage=${JSON.stringify(saved)}）`);
  }

  // ---- 2d. 另一個分頁扣了額度，這個分頁要立刻跟著少 ----
  {
    const E = await makeEnv();
    await E.settle();
    await E.setStorage({ freeDaily: { day: TODAY, spent: 175 } });
    const left = E.ask('quickStatus').state.freeLeft;
    left <= 5
      ? ok(`另一個分頁用掉的額度即時同步（剩 ${left} 秒）`)
      : bad(`另一個分頁用掉的額度沒有同步過來（剩 ${left} 秒）`);
  }

  // ---- 2e. 不在免費範圍的影片：節目、舊賽季、支援賽事都不送 ----
  {
    const bad2 = [];
    for (const [pth, want] of [
      ['/detail/1/pre-qualifying-show-netherlands', false],
      ['/detail/2/2025-dutch-grand-prix', false],
      ['/detail/3/2026-canadian-gp-f1a-qualifying', false],
      ['/detail/4/2026-dutch-gp-sprint-qualifying', true],
    ]) {
      const E = await makeEnv({ path: pth, config: { freeTier: FREE_TIER_REAL } });
      await E.settle();
      const fs0 = E.ask('quickStatus').state.freeSession;
      if (fs0 !== want) bad2.push(`${pth} 應該${want ? '' : '不'}在免費範圍`);
    }
    bad2.length ? bad('免費範圍判斷不對：' + bad2.join('；'))
      : ok('免費範圍只有本季正式場次：節目、舊賽季、F1 Academy 都不算，衝刺排位賽算');
  }

  // ---- 2n. 沒有影片編號（2026-11-03，R19：觀眾的 Chrome 開了賽事頁，沒有 video 卻送了 281 句進 misc）----
  {
    const E = await makeEnv({ path: '/page/12332/mexico-city', licensed: true });
    E.env.noVideo = true;
    E.caption = 'Box this lap';
    await E.advance(30000);
    const none = E.sent.filter((m) => m.type === 'translate').length;
    none === 0 && /頁面沒有影片、沒送出 \d+ 句/.test(E.api.diag())
      ? ok('沒有影片編號、頁面也沒有影片：不送翻譯（不進 misc、不花觀眾的授權），診斷看得到丟了幾句')
      : bad(`沒有影片的頁面還是送了 ${none} 批翻譯`);

    const F = await makeEnv({ path: '/page/12332/mexico-city', licensed: true });
    F.caption = 'He is pushing hard on the soft tyre';
    await F.advance(30000);
    const tr = F.sent.filter((m) => m.type === 'translate');
    tr.length && !tr[0].cid
      ? ok('有影片但拿不到編號（從活動頁進去看）：照舊等 15 秒後送出，字幕不會消失')
      : bad(`有影片、沒有編號時沒有送翻譯（${tr.length} 批）——使用者會完全沒有字幕`);
  }

  // ---- 3. 免費額度用完後改設定：原生英文字幕不可以又被藏起來 ----
  let E3;
  {
    const E = await makeEnv({ storage: { freeDaily: { day: TODAY, spent: 400 } } });   // 遊客今天已用完
    E3 = E;
    E.caption = 'Box this lap';
    await E.advance(300);
    E.hideCount() === 0
      ? ok('免費額度用完：原生英文字幕還給使用者')
      : bad('免費額度用完後原生英文字幕仍被隱藏');
    await E.setStorage({ settings: { enabled: true, showEnglish: true, hideNativeCC: true, fontSize: 30, bottomPct: 8, subtitleOffset: 0 } });
    await E.advance(2000);
    E.hideCount() === 0
      ? ok('額度用完後改字級：原生英文字幕仍然看得到')
      : bad('額度用完後只是改了字級，原生英文字幕又被藏起來 —— 而我們不畫中文，畫面上一個字都沒有');

    const d = E.api.diag();
    /免費試看的 15 分鐘已結束/.test(d)
      ? bad('遊客（3 分鐘）額度用完，畫面訊息卻寫「15 分鐘已結束」')
      : ok('額度用完的訊息沒有寫錯分鐘數');
  }

  // ---- 3b. 中文落後英文多久：使用者定的 0.5 秒判準要量得到（2026-09-23 直播實測前補上）----
  //
  //  以前診斷只有「JS 耗時」與「到上畫面」——那量的是我們自己畫多快（命中快取時是幾毫秒），
  //  完全不含「這句還沒翻好、等譯文回來」的等待，而那正是直播時使用者感覺到的落後。
  {
    // 免費使用者（不跑整軌預抓）才走「逐句翻譯」這條路——付費的在等字幕清單時不送零星句子
    const E = await makeEnv();
    E.env.translateMs = 1800;                 // 直播的翻譯來回
    E.caption = 'Box this lap box this lap';
    await E.advance(900);                     // 英文已經在畫面上，中文還沒有
    const mid = E.ask('quickStatus').state.zhLag;
    await E.advance(3000);                    // 譯文回來，補顯示
    const z = E.ask('quickStatus').state.zhLag;
    // 同一句再出現一次：這次命中本機快取，落後應該接近 0
    E.caption = '';
    await E.advance(500);
    E.caption = 'Box this lap box this lap';
    await E.advance(500);
    const z2 = E.ask('quickStatus').state.zhLag;
    // ⚠️ **`seen` 必須存在而且是全場累計。**（2026-09-25）
    //    `ms` 是最近 400 筆的滾動視窗，`late`／`never` 卻是整場累計——
    //    少了 seen 就只能拿累計數去除視窗大小，得到一個看起來像百分比的假數字
    //    （9/24 就是這樣讀出「沒跟上 8%」與「未命中 1.3%」的假矛盾）。
    z2 && typeof z2.seen === 'number' && z2.seen >= 2
      ? ok(`中文落後有自己的全場分母（seen = ${z2.seen}），累計數不會被拿去除視窗大小`)
      : bad(`中文落後沒有全場分母（seen = ${z2 && z2.seen}）—— 累計的「沒跟上」會被拿去除滾動視窗，得到假的百分比`);
    (!mid || !mid.n) && z && z.n === 1 && z.p50 >= 1500 && z.late === 1 && z2 && z2.n === 2 && z2.late === 1
      ? ok(`中文落後英文量得到：等譯文那句 ${(z.p50 / 1000).toFixed(1)}s（記為超過 0.5 秒），命中快取那句接近 0`)
      : bad(`中文落後的量測不對（等譯文時 ${JSON.stringify(z)}、再看一次 ${JSON.stringify(z2)}）`
        + ' —— 這是「要不要做延遲畫面」的唯一判準，量錯就等於沒量');
  }

  // ---- 3c. 譯文回來時畫面已經換句：要記成「沒跟上」，不可以混進落後的中位數 ----
  {
    const E = await makeEnv();
    E.env.translateMs = 4000;
    E.caption = 'He is pushing hard on the soft tyre';
    await E.advance(600);
    E.caption = 'And that is the end of the lap';   // 畫面換句了
    await E.advance(6000);
    const z = E.ask('quickStatus').state.zhLag;
    z && z.never >= 1
      ? ok(`譯文回來時已經換句：記成「沒跟上」${z.never} 句，沒有混進落後的中位數`)
      : bad(`譯文回來得太慢、那一句根本沒顯示，卻沒有被記下來（${JSON.stringify(z)}）`);
  }

  // ---- 4. 買完授權：立刻生效，原生英文字幕重新隱藏 ----
  {
    const E = E3;
    E.env.licensed = true;
    await E.setStorage({ entitlement: 'signed.entitlement', entExp: 9999999999 });
    await E.advance(2000);
    const q = E.ask('quickStatus');
    q.state.licensed === true
      ? ok('啟用授權後 2 秒內就生效（不必等 60 秒的輪詢）')
      : bad('啟用授權後 2 秒仍是免費模式 —— 要等下一次 60 秒輪詢');
    E.hideCount() === 1
      ? ok('啟用授權後原生英文字幕重新隱藏（不會出現兩份英文）')
      : bad(`啟用授權後原生英文字幕沒有重新隱藏（隱藏樣式 ${E.hideCount()} 份）`);
  }

  // ---- 5. 遠端總開關：頁面載入時就開著也要生效 ----
  {
    const E = await makeEnv({ licensed: true, config: { killSwitch: true } });
    await E.advance(2000);
    const q = E.ask('quickStatus');
    q.state.killed === true && E.hideCount() === 0
      ? ok('killSwitch 在頁面載入前就開著：照樣停用，原生字幕看得到')
      : bad(`killSwitch 在頁面載入前就開著卻沒有生效（killed=${q.state.killed}，隱藏樣式 ${E.hideCount()} 份）`
        + ' —— 只有「開著分頁時版本號改變」才會判斷');
  }

  // ---- 6. 版本下限：頁面載入時就生效，且原生字幕要還給使用者 ----
  {
    const E = await makeEnv({ licensed: true, config: { minClientVersion: '99.0.0' } });
    await E.advance(2000);
    const q = E.ask('quickStatus');
    q.state.tooOld === true && E.hideCount() === 0
      ? ok('版本過舊：停止翻譯，原生英文字幕看得到')
      : bad(`版本過舊的處理不對（tooOld=${q.state.tooOld}，隱藏樣式 ${E.hideCount()} 份 —— 疊字停了、原生字幕又被藏著＝一片空白）`);
  }
  {
    // 分頁開著的期間才推版本下限
    const E = await makeEnv({ licensed: true });
    await E.advance(1000);
    E.env.config = { version: 2, minClientVersion: '99.0.0' };
    await E.advance(61000);
    E.hideCount() === 0
      ? ok('播放途中推了版本下限：原生英文字幕還給使用者')
      : bad('播放途中推了版本下限：疊字停了，原生字幕卻還是藏著');
  }

  // ---- 7. 長時間沒有字幕：只回報一次，不要切成好幾段 ----
  {
    const E = await makeEnv({ licensed: true });
    E.caption = 'Lights out and away we go';
    await E.advance(300);
    E.caption = '';
    await E.advance(70000);
    const d = E.api.diag();
    const n = (d.match(/字幕空白 \d+ 秒/g) || []).length;
    n === 1
      ? ok('70 秒沒有旁白：只回報一次')
      : bad(`70 秒沒有旁白被回報了 ${n} 次（兩個檢查共用 lastNonEmptyAt，缺漏被切成好幾段）`);
  }

  // ---- 7b. 串流加密：**只在測試版**記進診斷（2026-09-17 使用者決定；為語音辨識評估加的）----
  if (RELEASE) {
    const E = await makeEnv({ licensed: true });
    E.post({ kind: 'manifest', url: 'https://ott-video-fer-cf.formula1.com/x/audio.m3u8',
      manifest: '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n#EXTINF:6.0,\na1.m4s\n' });
    await E.settle();
    !/串流加密/.test(E.api.diag())
      ? ok('正式版的診斷報告沒有「串流加密」那一行（測試版才有）')
      : bad('正式版的診斷報告出現「串流加密」——那是測試版的診斷欄位，使用者沒有同意放進正式版');
  } else {
    const E = await makeEnv({ licensed: true });
    E.post({ kind: 'manifest', url: 'https://ott-video-fer-cf.formula1.com/x/audio.m3u8',
      manifest: '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n#EXTINF:6.0,\na1.m4s\n' });
    E.post({ kind: 'manifest', url: 'https://ott-video-fer-cf.formula1.com/x/sub.m3u8', manifest: VOD_SUB_PLAYLIST });
    await E.settle();
    const d = E.api.diag();
    /串流加密　：看過 2 份清單，其中 1 份有加密（SAMPLE-AES、Widevine）/.test(d)
      ? ok('診斷報告記下串流是否加密（Widevine 的 SAMPLE-AES 認得出來）')
      : bad('診斷報告沒有正確記下串流加密：' + ((d.match(/串流加密.*/) || ['（找不到這一行）'])[0]));
  }

  // ---- 7c. 詳細日誌與直播量測：Console 指令只在測試版，但資料兩個版本都要進診斷報告 ----
  //
  // 使用者 2026-09-17：「移到測試版，但正式版的使用者回報問題時也要能夠讓我看到詳細日誌跟直播時測量」。
  // 會默默壞掉的方向有兩個：指令跟著資料一起被拿掉（開發者看不到），或指令留在正式版（違反決定）。
  {
    const E = await makeEnv({ licensed: true });
    E.caption = 'Box box, this lap';
    await E.advance(1500);
    const d = E.api.diag();
    /──── 詳細日誌（最近 [1-9]\d* 行）────[\s\S]*偵測到字幕[^\n]*Box box/.test(d)
      ? ok(`${RELEASE ? '正式版' : '原始碼'}：診斷報告帶著詳細日誌（逐句字幕），不必先打開任何開關`)
      : bad(`${RELEASE ? '正式版' : '原始碼'}：診斷報告沒有詳細日誌——使用者回報問題時開發者看不到`,
        (d.match(/──── 詳細日誌[^\n]*\n[^\n]*/) || ['（找不到這一段）'])[0]);
    /──── 直播實測自動採樣 ────/.test(d)
      ? ok(`${RELEASE ? '正式版' : '原始碼'}：診斷報告帶著直播實測量測`)
      : bad(`${RELEASE ? '正式版' : '原始碼'}：診斷報告沒有直播實測量測`);
    const hasCmds = typeof E.api.debug === 'function' || typeof E.api.live === 'function';
    RELEASE
      ? (!hasCmds ? ok('正式版沒有 __pitlingo.debug／live 指令（只在測試版）')
        : bad('正式版還有 __pitlingo.debug 或 live 指令——使用者決定只放測試版'))
      : (typeof E.api.debug === 'function' && typeof E.api.live === 'function'
        ? ok('測試版保留 __pitlingo.debug／live 指令') : bad('測試版少了 __pitlingo.debug 或 live 指令'));
    // 上限：詳細日誌不可以無限長（直播開一整晚）
    for (let i = 0; i < 400; i++) { E.caption = 'line number ' + i + ' for the log cap'; await E.advance(300); }
    const d2 = E.api.diag();
    const m = d2.match(/──── 詳細日誌（最近 (\d+) 行）────/);
    m && Number(m[1]) <= 300
      ? ok(`詳細日誌有上限（最近 ${m[1]} 行），直播開一整晚也不會把報告撐爆`)
      : bad('詳細日誌沒有上限', m && m[1]);
  }

  // ---- 7e. 擴充功能被重新載入時，分頁裡舊的 content script 要停手（2026-10-12 Ray 回報） ----
  //  舊版的計時器照跑、chrome.runtime 已失效：自動診斷每輪丟 Extension context invalidated，
  //  而且畫面上會留一層再也不會更新的中文、原生英文字幕一直被藏著。
  {
    const E = await makeEnv({ licensed: true });
    E.caption = 'Box box, this lap';
    await E.advance(1500);
    E.api.autoDiag(1);
    const hiddenBefore = E.hideCount();
    E.env.dead = true;
    await E.advance(3 * 60000);
    E.caption = 'Push now, push now';
    await E.advance(2000);
    E.errors.length === 0
      ? ok('擴充功能被重新載入後，舊分頁的計時器不再丟例外（自動診斷不再呼叫失效的 chrome.runtime）')
      : bad('擴充功能被重新載入後舊分頁還在丟例外：' + E.errors.slice(0, 2).join('；'));
    hiddenBefore === 1 && E.hideCount() === 0
      ? ok('舊分頁停手時把原生英文字幕還回去（不會留一層不再更新的中文、也不會沒有字幕）')
      : bad(`舊分頁停手後原生字幕的狀態不對（之前藏 ${hiddenBefore} 層、之後 ${E.hideCount()} 層）`);
    /擴充功能已重新載入或停用/.test(E.api.diag())
      ? ok('事件時間軸記下「擴充功能已重新載入，請重新整理」')
      : bad('事件時間軸沒有記下舊分頁已停手');
  }

  // ---- 7d. 管理版收割（handoff 9.1 #26 第 3 階段；只有含 @admin-only 的版本才有） ----
  //
  // 會默默壞掉的方向：沒有授權的管理版被「免費模式」擋掉整軌預抓（收割一支都跑不起來）、
  // 翻譯還沒結束就蓋章（userscript 荷蘭站的坑）、不完整也蓋章（鐵則 37）、蓋章走 /v1/complete（只記參考值，坑 #95）。
  {
    const probe = await makeEnv();
    if (!probe.admin) {
      ok('這個版本沒有管理版收割（正式版／測試版），略過 7d');
    } else {
      const harvestEnv = async (opts) => {
        const stamps = [];
        const linesPerSeg = opts.linesPerSeg || 2;
        const E = await makeEnv({
          storage: opts.token ? { harvestToken: 'h-test' } : null,
          respond: (msg) => {
            if (msg.type === 'fetchText' && /\.vtt$/.test(msg.url)) {
              const n = (msg.url.match(/seg(\d+)/) || [])[1];
              let v = 'WEBVTT\n';
              for (let i = 0; i < linesPerSeg; i++) v += `\n00:00:0${i}.000 --> 00:00:0${i + 1}.000\nSegment ${n} line ${i} about the soft tyre\n`;
              return { ok: true, text: v };
            }
            if (msg.type === 'fetchText' && /\.m3u8$/.test(msg.url)) return { ok: true, text: VOD_SUB_PLAYLIST };
            if (msg.type === 'translate' && opts.noTranslate) return { ok: true, result: { lines: {} } };
            if (msg.type === 'getBundle' && opts.complete) return { ok: true, bundle: { lines: { 'segment 1200 line 0 about the soft tyre': '舊譯文' }, segCount: 2 } };
            if (msg.type === 'harvestStamp') {
              stamps.push(msg);
              return { ok: true, result: { ok: true, segCount: msg.segCount, total: Object.keys(msg.lines).length, added: 0, rejected: 0 } };
            }
            return undefined;
          },
        });
        E.post({ kind: 'manifest', url: 'https://ott-video-fer-cf.formula1.com/x/sub.m3u8', manifest: VOD_SUB_PLAYLIST });
        await E.advance(90000);
        return { E, stamps };
      };

      // 有收割權杖、沒有授權：照樣整軌收割，翻完才用收割身分蓋章（譯文＋分段數一起寫）
      {
        const { E, stamps } = await harvestEnv({ token: true });
        const s = E.admin.snapshot();
        s.segFetched === 2
          ? ok('管理版：有收割權杖就整軌收割，不被「免費模式」擋掉（沒有授權也一樣）')
          : bad(`管理版：有收割權杖卻沒有整軌收割（已抓 ${s.segFetched} 段）——收割一支都跑不起來`);
        const st = stamps[0] || {};
        stamps.length === 1 && st.segCount === 2 && /^ext-\d+\.\d+\.\d+$/.test(st.v) && Object.keys(st.lines || {}).length === 4
          ? ok('管理版：翻譯結束後蓋一次可信的完整標記（POST /v1/subs，帶 4 句譯文、2 段、ext- 版本）')
          : bad(`管理版：完整標記不對（送了 ${stamps.length} 次，${JSON.stringify({ seg: st.segCount, v: st.v, lines: st.lines && Object.keys(st.lines).length })}）`);
        !E.sent.some((m) => m.type === 'markComplete')
          ? ok('管理版：不走 /v1/complete（那只記參考值，收割佇列不信它）')
          : bad('管理版：還是送了 markComplete（/v1/complete）');
        s.stamp.state === 'ok' && s.stamp.cid === s.cid
          ? ok('管理版：收割佇列看得到「這一支已蓋章」（__plAdmin.snapshot）')
          : bad(`管理版：snapshot 的標記狀態是 ${JSON.stringify(s.stamp)}`);
        E.errors.length ? bad('管理版收割過程有例外：' + E.errors.slice(0, 3).join('；')) : ok('管理版收割過程沒有例外');
      }

      // 翻譯拿不到結果（超過容許比例）：不蓋章，記成不完整讓佇列記為失敗
      {
        const { E, stamps } = await harvestEnv({ token: true, linesPerSeg: 13, noTranslate: true });
        const s = E.admin.snapshot();
        stamps.length === 0 && s.stamp.state === 'incomplete'
          ? ok(`管理版：${s.missing} 句沒有譯文時不蓋完整標記，狀態記成「不完整」（佇列會記為失敗）`)
          : bad(`管理版：缺 ${s.missing} 句還是蓋了章（${stamps.length} 次，狀態 ${s.stamp.state}）——殘缺的快取會被當成完整`);
      }

      // 後端已完整 → 跳過；按「🎯 重收這一支」照樣整軌抓、翻完重新蓋章（＝userscript 的「立即整軌預抓」）
      {
        const { E, stamps } = await harvestEnv({ token: true, complete: true });
        const s0 = E.admin.snapshot();
        const before = stamps.length;
        const why = E.admin.forceHarvest();
        await E.advance(90000);
        const s = E.admin.snapshot();
        s0.bundleComplete && s0.harvestSkipped && before === 0 && stamps.length === 1 && why === '' && s.segFetched === 2 && s.stamp.state === 'ok'
          ? ok('管理版：已完整的影片照常跳過；「🎯 重收這一支」會整軌重抓並重新蓋章')
          : bad(`管理版重收不對（一開始已完整 ${s0.bundleComplete}、重收回 "${why}"、抓 ${s.segFetched} 段、標記 ${s.stamp.state}、蓋章 ${stamps.length} 次）`);
      }

      // 7e. 前導收割模式（2026-10-24 從測試版移進管理版）：預設開、不延遲畫面、直播批次等 20 秒並標 leader、
      //     每 30 秒送心跳；leader() 不帶參數只回狀態（測試版時代不帶參數＝關閉，R18 FP2 被這樣關掉過）
      {
        const E = await makeEnv({ storage: { harvestToken: 'h-test' }, currentTime: 7200, leaderDefault: true });
        E.post({ kind: 'manifest', url: 'https://ott-video-cf.formula1.com/x/sub_eng.m3u8', manifest: LIVE_SUB_PLAYLIST });
        await E.settle();
        const s0 = await E.api.leader();
        s0.leaderMode === true && s0.delayEnabled === false && s0.windowSec === 20
          ? ok('管理版：前導收割模式預設開、延遲畫面關、批次 20 秒（不必在 Console 打指令）')
          : bad(`管理版：前導收割模式預設狀態不對 ${JSON.stringify(s0)}`);
        E.post({ kind: 'vtt', url: 'https://x/seg1202.vtt', vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHe is pushing hard on the soft tyre\n' });
        await E.advance(33000);
        const tr = E.sent.filter((m) => m.type === 'translate');
        const beats = E.sent.filter((m) => m.type === 'leaderBeat');
        // （畫面上現在就要的句子照樣插隊——這裡不驗「等 20 秒」，那段在 scheduleFlush 沒有改）
        tr.length && tr.every((m) => m.leader === true && m.live === true)
          ? ok('管理版：直播翻譯批次標 leader＋live（後端據此把結果放進 SubtitleRoom、記前導端在）')
          : bad(`管理版：前導批次不對（${tr.length} 批，leader=${tr.map((m) => m.leader).join(',')}）`);
        beats.length >= 1 && beats.every((m) => /^\d+$/.test(String(m.cid)))
          ? ok(`管理版：直播中每 30 秒送前導心跳（${beats.length} 次，帶 cid）`)
          : bad(`管理版：沒有送前導心跳（${beats.length} 次）——觀眾端會一直顯示「前導收割端 不在」並寄告警信`);
        const s1 = await E.api.leader();
        s1.leaderMode === true ? ok('管理版：leader() 不帶參數只回狀態，不會把前導模式關掉') : bad('管理版：leader() 不帶參數把前導模式關掉了');
        // 關分頁（pagehide）：主動跟後端說「我走了」，觀眾那邊就不寄假告警（2026-10-24，R18 FP2 場次結束先關 A）
        E.fire('pagehide');
        const byes = E.sent.filter((m) => m.type === 'leaderBeat' && m.bye === true);
        byes.length === 1 && byes[0].cid === beats[0].cid
          ? ok('管理版：前導端關分頁時送一次 bye（帶 cid），後端據此不發「前導端不在」告警')
          : bad(`管理版：關分頁時沒有送 bye（${byes.length} 次）——場次結束先關前導端會收到假告警`);
        E.fire('pagehide');
        E.sent.filter((m) => m.type === 'leaderBeat' && m.bye === true).length === 1
          ? ok('管理版：已經說過 bye 之後不重送')
          : bad('管理版：bye 重送了（沒有清掉送過心跳的 cid）');
        const s2 = await E.api.leader(false);
        s2.leaderMode === false && s2.delayEnabled === false
          ? ok('管理版：leader(false) 關掉前導模式，但延遲畫面仍然不開（管理版不可以把自己拉到觀眾後面）')
          : bad(`管理版：leader(false) 之後狀態不對 ${JSON.stringify(s2)}`);
        E.errors.length ? bad('管理版前導模式有例外：' + E.errors.slice(0, 3).join('；')) : ok('管理版前導模式沒有例外');
      }
      // 7e2. 直播結束後 F1TV 自動播下一支推薦影片 → 管理版回首頁等下一場（2026-10-25 Ray，R18 FP3 播了 F1A 精華）
      {
        const HOME = 'https://f1tv.formula1.com/';
        const leaderLive = async () => {
          const E = await makeEnv({ storage: { harvestToken: 'h-test' }, currentTime: 7200, leaderDefault: true });
          E.post({ kind: 'manifest', url: 'https://ott-video-cf.formula1.com/x/sub_eng.m3u8', manifest: LIVE_SUB_PLAYLIST });
          await E.settle();
          await E.advance(31000);   // 送過一次心跳＝這一頁是前導端
          return E;
        };
        const goTo = (E, p) => { E.location.pathname = p; E.location.href = 'https://f1tv.formula1.com' + p; };

        // ① 倒數出現、影片已經不在播 → 回首頁，而且送 bye
        let E = await leaderLive();
        E.env.countdown = 'Starts in 5';
        await E.advance(2000);
        const stillPlaying = E.location.assigned;          // 影片還在播：不可以動
        E.video.paused = true;
        await E.advance(4000);
        const bye1 = E.sent.filter((m) => m.type === 'leaderBeat' && m.bye === true).length;
        !stillPlaying && E.location.assigned === HOME && bye1 === 1
          ? ok('管理版：直播結束出現「Starts in N」倒數 → 回 F1TV 首頁（送 bye；影片還在播時不動）')
          : bad(`管理版：倒數時沒有回首頁（播放中 ${stillPlaying}、暫停後 ${E.location.assigned}、bye ${bye1}）`);

        // ② 倒數字樣認不出來，但前導中的那一支被換掉、沒有人按 → 一樣回首頁，不收那一支
        E = await leaderLive();
        goTo(E, '/detail/1000078525/f1a-race-1-highlights-united-states');
        await E.advance(2000);
        const noHarvest = !E.sent.some((m) => m.type === 'translate' && String(m.cid) === '1000078525');
        E.location.assigned === HOME && noHarvest
          ? ok('管理版：前導中的直播被自動換成別支（沒有人按）→ 回首頁，不收割那一支')
          : bad(`管理版：自動換片後沒有回首頁（assigned=${E.location.assigned}、收了那一支=${!noHarvest}）`);

        // ③ 自己點了別支（真的點擊）→ 照常換片，不回首頁
        E = await leaderLive();
        E.fire('pointerdown', { isTrusted: true });
        goTo(E, '/detail/1000078525/f1a-race-1-highlights-united-states');
        await E.advance(2000);
        !E.location.assigned
          ? ok('管理版：自己點別支影片照常換片（不會被送回首頁）')
          : bad('管理版：自己點別支也被送回首頁');
        E.errors.length ? bad('管理版回首頁有例外：' + E.errors.slice(0, 3).join('；')) : ok('管理版回首頁沒有例外');
      }
      // 沒有收割權杖：管理版只有收割身分，不當前導端（翻譯在 SW 端擋下，build-extension --check 驗）
      {
        const E = await makeEnv({ currentTime: 7200, leaderDefault: true });
        E.post({ kind: 'manifest', url: 'https://ott-video-cf.formula1.com/x/sub_eng.m3u8', manifest: LIVE_SUB_PLAYLIST });
        await E.settle();
        await E.advance(31000);
        const s = await E.api.leader();
        s.leaderMode === false && s.delayEnabled === false && !E.sent.some((m) => m.type === 'leaderBeat')
          ? ok('管理版沒有收割權杖：不當前導端、不送心跳，延遲畫面照樣關')
          : bad(`管理版沒有收割權杖卻還是前導端 ${JSON.stringify(s)}`);
      }

      // 收割佇列接手（fastPace）：不讓路給影片、6 條並行。沿用觀眾版的退讓，正賽 15 分鐘只抓到 1/4（2026-10-12）。
      // 對照組是觀眾版的節奏（影片在等資料時讓路），兩組只差一個 fastPace()。
      {
        const N = 120;
        let big = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n';
        for (let i = 1; i <= N; i++) big += `#EXTINF:6.0,\nseg${i}.vtt\n`;
        big += '#EXT-X-ENDLIST\n';
        const run = async (fast) => {
          const E = await makeEnv({
            storage: { harvestToken: 'h-test' },
            respond: (msg) => {
              if (msg.type === 'fetchText' && /\.vtt$/.test(msg.url)) return { ok: true, text: 'WEBVTT\n' };
              if (msg.type === 'fetchText' && /\.m3u8$/.test(msg.url)) return { ok: true, text: big };
              return undefined;
            },
          });
          // 影片在等資料（readyState 2）＝觀眾版會暫停讓路、恢復後走 800ms 慢速——收割時播放器常常就是這樣
          E.video.readyState = 2;
          if (fast) E.admin.fastPace();
          E.post({ kind: 'manifest', url: 'https://ott-video-fer-cf.formula1.com/x/sub.m3u8', manifest: big });
          await E.advance(15000);
          return E.admin.snapshot().segFetched;
        };
        const slow = await run(false), fast = await run(true);
        fast === N && slow < N / 2
          ? ok(`管理版：收割佇列接手後全速抓取（15 秒：全速 ${fast}/${N} 段、觀眾版節奏 ${slow} 段）`)
          : bad(`管理版：全速沒有作用（15 秒：fastPace ${fast}/${N} 段、觀眾版 ${slow} 段）——大場次在佇列時限內抓不完`);
      }

      // 沒有收割權杖：跟一般使用者一樣（免費模式不整軌預抓、不蓋章）
      {
        const { E, stamps } = await harvestEnv({ token: false });
        const s = E.admin.snapshot();
        s.segFetched === 0 && stamps.length === 0 && s.harvestOn === false
          ? ok('管理版沒有收割權杖時就是一般使用者（免費模式不整軌預抓、不蓋章）')
          : bad(`管理版沒有收割權杖卻在收割（已抓 ${s.segFetched} 段、蓋章 ${stamps.length} 次）`);
      }
    }
  }

  // ---- 7f. 進入影片時自動開啟英文字幕（v0.38.0） ----
  //
  // 疊字跟著原生字幕走：CC 沒開中文就不會出現，而 F1TV 每支影片都重設成 None。
  // 會默默壞掉的方向：使用者自己關掉又被打開（每秒跟他搶）、本來選了別的語言被改掉、
  // 關掉設定還在動、播放器不接受時無限重送、字幕軌晚到就再也不開。
  {
    // F1TV 的實際值（2026-10-12 Ray 實機傾印）：不是 Bitmovin 原版的 'null'／軌道 id，而是 JSON。
    // ⚠️ 第一版的測試用的是我從 Bitmovin 原始碼猜的值——測試全綠、實機完全沒作用。
    const OFF = '{"trackId":null,"feedId":null}', EN = '{"trackId":0,"feedId":0}', ES = '{"trackId":1,"feedId":0}';
    const TRACKS = [[OFF, 'None'], [EN, 'English F1 Live'], [ES, 'Espanol F1 Live']];
    const sel = (E) => E.cc.options[E.cc.selectedIndex].value;

    {
      const E = await makeEnv({ cc: { options: TRACKS } });
      await E.advance(3000);
      const on = sel(E);
      E.cc.selectedIndex = 0;                       // 使用者自己關掉
      await E.advance(60000);
      on === EN && E.cc.changes === 1 && sel(E) === OFF
        ? ok('自動開啟英文字幕（English F1 Live），之後使用者自己關掉就不再打開')
        : bad(`自動開字幕不對（一開始 ${on}、使用者關掉後 ${sel(E)}、送了 ${E.cc.changes} 次 change）`);
    }
    {
      const E = await makeEnv({ cc: { options: TRACKS, selected: 2 } });
      await E.advance(10000);
      sel(E) === ES && E.cc.changes === 0
        ? ok('字幕本來就開著（別的語言）時不碰')
        : bad(`字幕本來是西班牙文卻被改成 ${sel(E)}`);
    }
    {
      const E = await makeEnv({ cc: { options: TRACKS }, storage: { settings: { autoEnableCC: false } } });
      const F = await makeEnv({ cc: { options: TRACKS }, storage: { settings: { enabled: false } } });
      await E.advance(10000); await F.advance(10000);
      E.cc.changes === 0 && F.cc.changes === 0
        ? ok('關掉「自動開啟英文字幕」或整個停用翻譯時不碰播放器')
        : bad(`設定關掉了還是動了字幕（自動開關 ${E.cc.changes} 次、停用翻譯 ${F.cc.changes} 次）`);
    }
    {
      const E = await makeEnv({ cc: { options: [[OFF, 'None']] } });
      await E.advance(20000);
      const early = E.cc.changes;
      E.cc.options.push({ value: EN, textContent: 'English F1 Live' });   // 直播：字幕軌晚到
      await E.advance(3000);
      early === 0 && sel(E) === EN
        ? ok('字幕軌晚到時等它出現再開')
        : bad(`字幕軌晚到就沒開（之前送 ${early} 次、之後 ${sel(E)}）`);
    }
    {
      // 2026-10-23 工單 PL-261023-WNZB：播放器三分多鐘才出來，舊版第 91 秒就放棄（選單還沒建出來）
      const E = await makeEnv({ cc: { options: [] } });
      E.env.noVideo = true;
      await E.advance(200000);
      E.cc.options.push({ value: OFF, textContent: 'None' }, { value: EN, textContent: 'English F1 Live' });
      E.env.noVideo = false;
      await E.advance(5000);
      sel(E) === EN && E.cc.changes === 1
        ? ok('播放器很晚才出來時，90 秒從播放器出現才開始算（不會在播放器出來前就放棄）')
        : bad(`播放器 200 秒後才出來，自動開字幕已經放棄（${sel(E)}、${E.cc.changes} 次）`);
    }
    {
      const E = await makeEnv({ cc: { options: TRACKS, reject: true } });
      await E.advance(120000);
      E.cc.changes === 3
        ? ok('播放器不接受時重試 3 次就放棄（不會每秒跟播放器搶）')
        : bad(`播放器不接受時送了 ${E.cc.changes} 次 change（應該剛好 3 次）`);
    }
    {
      const E = await makeEnv({ cc: { options: [[OFF, 'None'], [ES, 'Espanol F1 Live']] } });
      const N = await makeEnv();                     // 根本找不到選單
      await E.advance(120000); await N.advance(120000);
      E.cc.changes === 0 && sel(E) === OFF && !N.errors.length
        ? ok('沒有英文字幕軌時不亂開別的語言；找不到選單時安靜放棄')
        : bad(`沒有英文軌時開了 ${sel(E)}（${E.cc.changes} 次），或找不到選單時出錯：${N.errors.slice(0, 2).join('；')}`);
    }
    {
      const E = await makeEnv({ cc: { options: [['null', 'Off'], ['en-1', 'English']] } });
      await E.advance(3000);
      sel(E) === 'en-1' && E.cc.changes === 1
        ? ok('Bitmovin 原版的值（關閉＝字串 null）也認得')
        : bad(`Bitmovin 原版的值沒有作用（${sel(E)}）`);
    }
  }

  // ---- 7g. 整軌預抓不可以被「播放器還沒出現」或「播放器重建」打斷（v0.38.2） ----
  //
  // 2026-10-12 Ray 實測：收割佇列整頁載入每一支，影片元素要好幾秒才建出來，
  // 舊版把「還沒出現」當成「關掉了」——正賽 2416 段一啟動就「收割已中止（播放器已關閉），已抓 0」，
  // 佇列白等到逾時。正式版的付費使用者也一樣（從別的網站點連結進來的整頁載入）。
  {
    const big = (n) => {
      let m = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n';
      for (let i = 1; i <= n; i++) m += `#EXTINF:6.0,\nseg${i}.vtt\n`;
      return m + '#EXT-X-ENDLIST\n';
    };
    const mk = async (n, noVideo) => {
      const body = big(n);
      const E = await makeEnv({
        licensed: true,
        respond: (msg) => {
          if (msg.type === 'fetchText' && /\.vtt$/.test(msg.url)) return { ok: true, text: 'WEBVTT\n' };
          if (msg.type === 'fetchText' && /\.m3u8$/.test(msg.url)) return { ok: true, text: body };
          return undefined;
        },
      });
      E.env.noVideo = noVideo;
      return { E, body, vtt: () => E.sent.filter((m) => m.type === 'fetchText' && /\.vtt$/.test(m.url)).length };
    };

    // 整頁載入：影片元素 8 秒後才出現，字幕清單在那之前就攔到了
    {
      const { E, body, vtt } = await mk(120, true);
      await E.advance(6000);
      E.post({ kind: 'manifest', url: 'https://ott-video-fer-cf.formula1.com/x/sub.m3u8', manifest: body });
      await E.advance(2000);
      E.env.noVideo = false;
      await E.advance(60000);
      vtt() === 120
        ? ok('整頁載入、播放器還沒出現時攔到字幕清單：整軌預抓照樣抓完（不把「還沒出現」當成「關掉了」）')
        : bad(`播放器還沒出現就把整軌預抓中止了（只抓 ${vtt()}/120 段）——收割佇列每一支都會白等到逾時`);
    }
    // 播放中 F1TV 重建播放器（影片元素消失 8 秒）：中止後接著抓，已抓的不重抓
    {
      const { E, body, vtt } = await mk(600, false);
      E.post({ kind: 'manifest', url: 'https://ott-video-fer-cf.formula1.com/x/sub.m3u8', manifest: body });
      await E.advance(2000);
      const before = vtt();
      E.env.noVideo = true;
      await E.advance(8000);
      const stopped = vtt();
      E.env.noVideo = false;
      await E.advance(60000);
      const urls = E.sent.filter((m) => m.type === 'fetchText' && /\.vtt$/.test(m.url)).map((m) => m.url);
      before > 0 && stopped < 600 && urls.length === 600 && new Set(urls).size === 600
        ? ok(`播放器重建後接續整軌預抓（中止於 ${stopped} 段，之後補齊 600 段，沒有重抓）`)
        : bad(`播放器重建後沒有接續（中止前 ${before}、中止時 ${stopped}、最後 ${urls.length} 次請求／${new Set(urls).size} 段不重複）`);
    }
    // 等字幕清單的 45 秒裡播放器一直關著（2026-11-01 R19 賽後節目：換片後播放器關了 9 分鐘，B、C 整場沒有整軌預抓）：
    // 播放器回來、攔到清單之後要照樣抓
    {
      const { E, body, vtt } = await mk(120, false);
      await E.advance(1000);
      E.env.noVideo = true;
      await E.advance(60000);
      E.env.noVideo = false;
      await E.advance(2000);
      E.post({ kind: 'manifest', url: 'https://ott-video-fer-cf.formula1.com/x/sub.m3u8', manifest: body });
      await E.advance(60000);
      vtt() === 120
        ? ok('等字幕清單時播放器一直關著：播放器回來、攔到清單後照樣整軌預抓（不在 45 秒後就整場放棄）')
        : bad(`等字幕清單時播放器關著，回來之後沒有整軌預抓（抓了 ${vtt()}/120 段）`);
    }
  }

  // ---- 7h. 診斷報告的網址遮罩要涵蓋 Akamai 的授權段（2026-11-01 R19 排位重播走 f1prodlive.akamaized.net，
  //          路徑裡的 hdntl=…~hmac=<簽章> 原封不動進了診斷報告） ----
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'extension/src/content/main.js'), 'utf8');
    const i = mainSrc.indexOf('function maskUrl(u) {');
    const end = i > 0 ? mainSrc.slice(i).search(/\r?\n  \}\r?\n/) : -1;   // main.js 是 CRLF
    const fnSrc = end > 0 ? mainSrc.slice(i, i + end) + '\n  }' : '';
    let maskUrl = null;
    try { maskUrl = new Function(fnSrc + '\nreturn maskUrl;')(); } catch (e) { /* 下面會判失敗 */ }
    const ak = 'https://f1prodlive.akamaized.net/v2/hdntl=exp=1793574229~acl=%2fv2%2fx%2f*~id=1_ABC~data=hdntl~hmac=deadbeefcafe0123456789/x/out/v1/Main/index__SUBS_1.m3u8?a=1';
    const cf = 'https://ott-video-cf.formula1.com/v2/pa_' + 'Q'.repeat(60) + '/x/index.m3u8';
    const a = maskUrl ? maskUrl(ak) : '', c = maskUrl ? maskUrl(cf) : '';
    a && !/hmac|deadbeef|~id=/.test(a) && /已遮蔽/.test(a) && /index__SUBS_1\.m3u8/.test(a) && !/Q{20}/.test(c) && /已遮蔽/.test(c)
      ? ok('診斷報告的網址遮罩：F1TV 的 pa_ 與 Akamai 的 hdntl=…~hmac= 都遮掉，路徑結構保留')
      : bad(`診斷報告的網址遮罩漏了授權段：${a.slice(0, 120)}`);
  }

  // ---- 7i. 字幕檔案的白名單（2026-11-01 R19 排位重播：F1TV 分到 Akamai，整軌預抓「網址不在允許清單內」）----
  //          收 F1TV 自己的主機與 f1prodlive.akamaized.net；別人的 Akamai 主機、http、其他網域一律擋；manifest 要有對應的權限
  {
    const sw = fs.readFileSync(path.join(__dirname, '..', 'extension/src/background/sw.js'), 'utf8');
    const pick = (re) => (sw.match(re) || [''])[0];
    const i = sw.indexOf('function isAllowedFetch(url) {');
    const end = i > 0 ? sw.slice(i).search(/\r?\n\}\r?\n/) : -1;
    let allowed = null;
    try {
      allowed = new Function(pick(/const FETCH_ALLOW_RE = [^\n]+/) + '\n' + pick(/const FETCH_ALLOW_HOSTS = [^\n]+/) + '\n'
        + (end > 0 ? sw.slice(i, i + end) + '\n}' : '') + '\nreturn isAllowedFetch;')();
    } catch (e) { /* 下面會判失敗 */ }
    const man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension/manifest.base.json'), 'utf8'));
    const yes = ['https://ott-video-cf.formula1.com/v2/x.m3u8', 'https://ott-video-fer-cf.formula1.com/x.vtt',
      'https://f1prodlive.akamaized.net/v2/hdntl=exp=1~hmac=ab/x/index__SUBS_1.m3u8', 'https://F1PRODLIVE.akamaized.net/x.vtt'];
    const no = ['https://evil.akamaized.net/x.m3u8', 'https://f1prodlive.akamaized.net.evil.com/x', 'http://f1prodlive.akamaized.net/x',
      'https://formula1.com.evil.com/x', 'https://example.com/x'];
    allowed && yes.every(allowed) && !no.some(allowed) && (man.host_permissions || []).includes('https://f1prodlive.akamaized.net/*')
      && !(man.host_permissions || []).some((h) => /\*\.akamaized\.net/.test(h))
      ? ok('字幕檔案白名單：F1TV 主機＋f1prodlive.akamaized.net 放行，別人的 Akamai／http／其他網域擋下；manifest 有對應權限、沒有 *.akamaized.net')
      : bad('字幕檔案白名單不對：' + JSON.stringify({ ok: !!allowed, yes: allowed && yes.map(allowed), no: allowed && no.map(allowed), hp: man.host_permissions }));
  }

  // ---- 8. 擴充功能裡不可以寫死價格 ----
  {
    const hits = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((f) => {
      const p = path.join(d, f.name);
      if (f.isDirectory()) return walk(p);
      if (!/\.(js|html)$/.test(f.name)) return;
      const s = fs.readFileSync(p, 'utf8');
      const m = s.match(/NT\$\s?\d+/g);
      if (m) hits.push(path.relative(root, p) + '：' + [...new Set(m)].join('、'));
    });
    walk(path.join(EXT, 'src'));
    hits.length
      ? bad('擴充功能寫死了價格（調價之後不會跟著變）：' + hits.join('；'))
      : ok('擴充功能沒有寫死任何價格');
  }

  // ---- 9. service worker ----
  await swChecks();

  // ---- 10. 自動診斷回報（**預設關閉**） ----
  //
  // 為什麼一定要有測試：這是整個擴充功能裡**唯一**會在使用者沒按任何按鈕的情況下
  //   把資料送回我們這裡的路徑。隱私權政策寫的是「診斷資訊只在你按下傳送時才送出」，
  //   而「預設關閉」寫在註解裡不算數——哪天預設值被改成開著，條款當場破功，
  //   不會有任何人注意到（這個專案的 bug 幾乎都不報錯）。
  //
  // 另外兩件事也要擋：暫停時繼續累積（回來就噴一堆內容相同的報告），
  // 以及關掉之後還在送。
  {
    // ⚠️ advanceVideo：自動診斷是用**播放進度**計時的，影片不前進就等於沒在播。
    //    少了這一項，這一組測試會一直是紅的，而且紅得有道理。
    const E = await makeEnv({ licensed: true, advanceVideo: true });
    const reports = () => E.sent.filter((m) => m && m.type === 'sendReport');

    // ⚠️ 要**直接問狀態**，不可以只用「播 N 分鐘沒送」來推論——預設值若被改成
    //    大於 N 的間隔，那種斷言照樣全綠（2026-09-24 變異測試發現）。
    await E.advance(3 * 60000);
    /關閉/.test(String(E.api.autoDiag())) && reports().length === 0
      ? ok('自動診斷回報預設關閉（狀態是「關閉」，播了 3 分鐘也一份都沒送）')
      : bad(`自動診斷回報預設是開著的（${E.api.autoDiag()}，已送 ${reports().length} 份）—— 隱私權政策當場破功`);

    // ⚠️ 這一段要這樣排才抓得到「用牆上時鐘計時」：播 30 秒 → 暫停 5 分鐘 → 再播 20 秒。
    //    一路播下去的話，牆上時鐘與播放時間**完全一樣**，錯的實作照樣全綠
    //    （2026-09-24 第一版測試就是這樣，變異測試才發現）。
    E.api.autoDiag(1);
    await E.advance(30000);
    E.video.paused = true;
    await E.advance(5 * 60000);
    reports().length === 0
      ? ok('暫停的 5 分鐘不算播放時間（也還沒播夠久，不值得補一份）')
      : bad(`暫停期間就送了 ${reports().length} 份 —— 計時用的是牆上時鐘，不是播放時間`);

    E.video.paused = false;
    await E.advance(20000);
    reports().length === 0
      ? ok('播放時間累計 50 秒，還沒滿一個間隔，不送')
      : bad('播放時間還沒滿一個間隔就送了');

    await E.advance(20000);
    const r1 = reports();
    r1.length === 1 && r1[0].auto === true && /診斷報告/.test(String(r1[0].report))
      ? ok('播放滿一個間隔自動送出診斷，並標記 auto（後端據此不寄信、不混進客訴清單）')
      : bad(`滿一個間隔沒有送出正確的自動診斷（${r1.length} 份，auto=${r1[0] && r1[0].auto}）`);

    // 暫停：時間不可以繼續累積，但結束時要補送最後一份（最後幾分鐘的數字才完整）
    E.video.paused = true;
    await E.advance(10 * 60000);
    const r2 = reports();
    r2.length === 2 && /結束/.test(String(r2[1].note))
      ? ok('暫停後補送最後一份就停手（暫停的 10 分鐘不計入，不會噴出一堆一樣的報告）')
      : bad(`暫停後送了 ${r2.length} 份（應該剛好 2 份，且最後一份註明「結束」）`);

    E.api.autoDiag(0);
    E.video.paused = false;
    await E.advance(5 * 60000);
    reports().length === 2 ? ok('關掉之後就真的不再送') : bad('關掉之後還在送');
  }

  // ---- 11. 延遲中的觀眾：前導收割端在的時候，批次要等得比前導端久（2026-10-25，R18 FP3 共用率 47%）----
  //     付費觀眾的整軌預抓和前導端同一秒拿到新分段；前導端湊 20 秒，觀眾只等 10 秒就會先翻掉一半
  {
    const firstSentAt = async (leader) => {
      let t0 = 0;
      const E = await makeEnv({
        licensed: true, currentTime: 7200, delayBehind: 45,
        respond: (msg) => (msg.type === 'translate'
          ? { ok: true, result: { lines: Object.fromEntries((msg.lines || []).map((l) => [l.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), '中文'])), leader } }
          : undefined),
      });
      E.post({ kind: 'manifest', url: 'https://ott-video-cf.formula1.com/x/sub_eng.m3u8', manifest: LIVE_SUB_PLAYLIST });
      await E.settle();
      // 第一批：還不知道前導端在不在 → 照舊 10 秒；回應告訴我們在不在
      E.post({ kind: 'vtt', url: 'https://x/seg1300.vtt', vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nThe gap to the car ahead is closing\n' });
      await E.advance(15000);
      const n1 = E.sent.filter((m) => m.type === 'translate').length;
      E.post({ kind: 'vtt', url: 'https://x/seg1301.vtt', vtt: 'WEBVTT\n\n00:00:04.000 --> 00:00:06.000\nHe has to box this lap for hard tyres\n' });
      for (let s = 0; s < 40 && !t0; s++) {
        await E.advance(1000);
        if (E.sent.filter((m) => m.type === 'translate').length > n1) t0 = s + 1;
      }
      return { n1, t0, errors: E.errors };
    };
    const withLeader = await firstSentAt(true), noLeader = await firstSentAt(false);
    withLeader.n1 === 1 && withLeader.t0 >= 28 && withLeader.t0 <= 31
      ? ok(`延遲中的觀眾：前導收割端在 → 批次等 ${withLeader.t0} 秒（比前導端的 20 秒久，句子先由前導端翻）`)
      : bad(`延遲中的觀眾：前導端在時批次等了 ${withLeader.t0} 秒（應 28～31 秒；第一批 ${withLeader.n1}）——會跟前導端搶著翻`);
    noLeader.t0 >= 10 && noLeader.t0 <= 13
      ? ok(`延遲中的觀眾：前導收割端不在 → 照舊等 ${noLeader.t0} 秒（沒人會替他翻，不多等）`)
      : bad(`延遲中的觀眾：前導端不在時批次等了 ${noLeader.t0} 秒（應 10～13 秒）`);
    const errs = withLeader.errors.concat(noLeader.errors);
    errs.length ? bad('延遲批次測試有例外：' + errs.slice(0, 3).join('；')) : null;
  }

  console.log('');
  if (failed) { console.log(`❌ 擴充功能行為有 ${failed} 項未通過`); process.exit(1); }
  console.log('✅ 擴充功能行為全部正確');
})().catch((e) => { console.log('❌ 測試環境崩潰：' + (e && e.stack || e)); process.exit(1); });

async function swChecks() {
  const store = {};
  const fetches = [];
  let listener = null;
  let installed = null;
  const tabsOpened = [];
  let renewReply = null;
  let meReply = { ok: true, profile: { email: 'a@b.c' }, licenses: [] };
  let activateReply = { ok: true, entitlement: 'ENTA', exp: 9999999999, plan: 'season' };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Map, Set, Promise, RegExp, URL, Error, Object, Array, String, Number, Boolean,
    setTimeout, clearTimeout, crypto: require('crypto').webcrypto,
    fetch: async (url, init) => {
      fetches.push({ url, init });
      const u = String(url);
      const body = u.includes('/v1/license/renew') ? renewReply
        : u.includes('/v1/account/me') ? meReply
          : u.includes('/v1/license/activate') ? activateReply
            : { ok: true, token: 'iid-1234abcd.x.y', exp: 9999999999 };
      const status = (body && body.__status) || 200;
      return { ok: status < 400, status, json: async () => body };
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        onInstalled: { addListener: (fn) => { installed = fn; } },
      },
      storage: {
        onChanged: { addListener() {} },
        local: {
          get: async (keys) => {
            const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
            const out = {}; ks.forEach((k) => { if (k in store) out[k] = store[k]; }); return out;
          },
          set: async (obj) => { Object.assign(store, obj); },
          remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); },
        },
      },
      tabs: { create: async (o) => { tabsOpened.push(o && o.url); } },
    },
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f }));
  vm.runInContext(fs.readFileSync(path.join(EXT, 'src/background/sw.js'), 'utf8'), ctx, { filename: 'sw.js' });
  const call = (msg) => new Promise((resolve) => listener(msg, {}, resolve));

  // 9w. 第一次安裝開「安裝完成」頁；更新不開；管理版（收割端）一律不開
  {
    if (typeof installed !== 'function') bad('背景程式沒有註冊 onInstalled（安裝後不會打開安裝完成頁）');
    else {
      installed({ reason: 'update', previousVersion: '0.9.0' });
      installed({ reason: 'chrome_update' });
      const afterUpdate = tabsOpened.length;
      installed({ reason: 'install' });
      await new Promise((r) => setTimeout(r, 0));
      const want = HAS_ADMIN ? [] : ['https://pitlingo.com/welcome'];
      afterUpdate === 0 && JSON.stringify(tabsOpened) === JSON.stringify(want)
        ? ok(HAS_ADMIN ? '管理版：安裝時不開任何分頁（收割端）' : '第一次安裝打開 pitlingo.com/welcome（不帶參數）；更新版本、Chrome 更新都不開')
        : bad(`安裝／更新時開的分頁不對：更新後 ${afterUpdate} 個，全部 ${JSON.stringify(tabsOpened)}，應為 ${JSON.stringify(want)}`);
      tabsOpened.length = 0;
    }
  }

  // 9a. 關閉分頁時的最後一搏，要帶授權與登入憑證
  Object.assign(store, { installToken: 'iid-1234abcd.x.y', installExp: 9999999999, entitlement: 'ENT', accountToken: 'SESS' });
  await call({ type: 'translateKeepalive', cid: '123', lines: ['Box box'] });
  await new Promise((r) => setTimeout(r, 20));
  if (HAS_ADMIN) {
    // 管理版只有收割身分（2026-10-24）：沒有收割權杖就不送，不退回用個人授權；有權杖就帶權杖
    const none = !fetches.some((f) => String(f.url).includes('/v1/translate'));
    store.harvestToken = 'h-test';
    await call({ type: 'translateKeepalive', cid: '123', lines: ['Box box'] });
    await new Promise((r) => setTimeout(r, 20));
    const ka = fetches.find((f) => String(f.url).includes('/v1/translate'));
    const h = (ka && ka.init && ka.init.headers) || {};
    none && h['x-harvest-token'] === 'h-test'
      ? ok('管理版：關閉分頁前的最後一批沒有收割權杖就不送、有權杖就帶權杖（不退回用個人授權）')
      : bad(`管理版：關閉分頁前的最後一批身分不對（沒權杖時送了 ${!none}、有權杖時帶 ${h['x-harvest-token']}）`);
    delete store.harvestToken;
  } else {
    const ka = fetches.find((f) => String(f.url).includes('/v1/translate'));
    const h = (ka && ka.init && ka.init.headers) || {};
    h['x-entitlement'] === 'ENT' && h.authorization === 'Bearer SESS'
      ? ok('關閉分頁前送出的最後一批，帶著授權與登入憑證（付費使用者不會被當成遊客扣額度）')
      : bad('關閉分頁前送出的最後一批沒有帶授權／登入憑證 —— 付費使用者被當成遊客，吃掉免費額度或被拒');
  }

  // 9b. 續期要更新「有效期至」
  Object.assign(store, { licenseKey: 'PL-AAAA-BBBB-CCCC', licExpiresAt: 1000 });
  renewReply = { ok: true, entitlement: 'ENT2', exp: 9999999999, plan: 'week', planLabel: 'Weekend', expiresAt: 2000 };
  await call({ type: 'licenseStatus', force: true });
  store.licExpiresAt === 2000
    ? ok('續期後「有效期至」跟著伺服器更新（後台延期、賽程異動都看得到）')
    : bad(`續期後「有效期至」沒有更新（仍是 ${store.licExpiresAt}）—— 設定頁顯示的是啟用當下的日期`);

  // 9c. 在這台停用後，不可以還掛著上一次「已被停用」的原因
  store.licRevokedReason = '授權已停用';
  await call({ type: 'licenseClear' });
  const st = await call({ type: 'licenseStatus' });
  !(st.license && st.license.reason)
    ? ok('在這台停用授權後，不會殘留舊的停用原因')
    : bad(`在這台停用授權後，設定頁仍顯示舊的停用原因「${st.license.reason}」`);
  // installId 取自安裝權杖的第一段，而且必須是十六進位（getInstallId 的格式檢查）
  Object.assign(store, { installToken: 'abcdef12-3456-4789.x.y', licenseKey: 'PL-AAAA-BBBB-CCCC' });
  fetches.length = 0;
  await call({ type: 'licenseClear' });
  const dz = fetches.filter((f) => String(f.url).includes('/v1/license/deactivate'));
  dz.length === 1 && JSON.parse(dz[0].init.body).installId === 'abcdef12-3456-4789'
    ? ok('在這台停用時，也請伺服器把這台從裝置名單拿掉（名額會釋放）')
    : bad('在這台停用只清了本機，伺服器上的名額沒有釋放');

  // ---- 授權綁帳號（2026-10-04）----
  // 9d. 續期要帶登入權杖；伺服器換了新權杖要存起來
  Object.assign(store, { licenseKey: 'PL-AAAA-BBBB-CCCC', accountToken: 'OLDSESS', entitlement: 'E', entExp: 9999999999 });
  renewReply = { ok: true, entitlement: 'ENT3', exp: 9999999999, plan: 'season', accountToken: 'NEWSESS' };
  fetches.length = 0;
  await call({ type: 'licenseStatus', force: true });
  const rf = fetches.find((f) => String(f.url).includes('/v1/license/renew'));
  rf && rf.init.headers.authorization === 'Bearer OLDSESS' && store.accountToken === 'NEWSESS'
    ? ok('續期帶著登入權杖；伺服器換發的新權杖有存起來（30 天後不會被登出、授權不會跟著停）')
    : bad('續期沒帶登入權杖，或沒有存下伺服器換發的新權杖');

  // 9e. accountStatus 有快取：分頁每 60 秒問一次，不可以每次都打 /v1/account/me
  fetches.length = 0;
  await call({ type: 'accountStatus', force: true });
  await call({ type: 'accountStatus' });
  await call({ type: 'accountStatus' });
  const meCalls = () => fetches.filter((f) => String(f.url).includes('/v1/account/me')).length;
  const n1 = meCalls();
  await call({ type: 'accountStatus', force: true });
  n1 === 1 && meCalls() === 2
    ? ok('帳號狀態快取 10 分鐘：分頁的定時檢查不再每分鐘打一次伺服器；設定頁（force）仍拿最新的')
    : bad(`帳號狀態沒有快取（三次呼叫打了 ${n1} 次伺服器）——每個 F1TV 分頁每分鐘一次，會吃掉 KV 讀取額度`);

  // 9f. 登出帳號：這台的授權暫停，授權碼留著
  Object.assign(store, { entitlement: 'E', entExp: 9999999999 });
  await call({ type: 'accountLogout' });
  !store.entitlement && store.licenseKey && /登出/.test(store.licRevokedReason || '')
    ? ok('登出帳號時這台的授權暫停（授權碼留著，重新登入就恢復）')
    : bad('登出帳號之後授權還在用（授權綁帳號形同虛設），或授權碼被一起刪掉了');

  // 9g. 沒有通行證但記得授權碼：每小時自己再試一次續期（比賽週之間的空檔、重新登入後）
  Object.assign(store, { accountToken: 'S2', entCheckedAt: Date.now() - 2 * 3600 * 1000 });
  delete store.entitlement; delete store.entExp;
  renewReply = { ok: true, entitlement: 'ENT4', exp: 9999999999, plan: 'week' };
  fetches.length = 0;
  const s1 = await call({ type: 'licenseStatus' });
  const tried1 = fetches.filter((f) => String(f.url).includes('/v1/license/renew')).length;
  renewReply = { __status: 403, error: '下一站還沒開始' };
  delete store.entitlement; delete store.entExp;
  store.entCheckedAt = Date.now();
  fetches.length = 0;
  await call({ type: 'licenseStatus' });
  const tried2 = fetches.filter((f) => String(f.url).includes('/v1/license/renew')).length;
  tried1 === 1 && s1.license && s1.license.active && tried2 === 0
    ? ok('暫停中的授權每小時自己續一次（跳著買比賽週的人，下一站開始時不必先打開設定頁）；一小時內不重試')
    : bad(`暫停中的授權不會自己恢復（試了 ${tried1} 次、恢復 ${!!(s1.license && s1.license.active)}），或一小時內重試了 ${tried2} 次`);

  // 9h. 登入後把授權接回來（以帳號為準，2026-10-30）：記得的碼不是這個帳號的 → **不帶碼**再啟用一次，
  //     由伺服器從帳號裡挑；記住伺服器回的那一組（用戶端不再讀 /v1/account/me 自己挑）
  Object.assign(store, { licenseKey: 'PL-OTHE-RRRR-RRRR', accountToken: 'S3' });
  activateReply = { __status: 403, error: '不是這個帳號的', code: 'E75' };
  fetches.length = 0;
  const swapAct = () => { activateReply = { ok: true, entitlement: 'ENT5', exp: 9999999999, plan: 'season', licenseKey: 'PL-MINE-MMMM-MMMM' }; };
  const origFetch = sandbox.fetch;
  let actN = 0;
  sandbox.fetch = async (url, init) => {
    if (String(url).includes('/v1/license/activate') && ++actN === 2) swapAct();
    return origFetch(url, init);
  };
  const lr = await sandbox.licenseAfterLogin();
  sandbox.fetch = origFetch;
  const acts = fetches.filter((f) => String(f.url).includes('/v1/license/activate')).map((f) => JSON.parse(f.init.body).licenseKey);
  const meCalls9h = fetches.filter((f) => String(f.url).includes('/v1/account/me')).length;
  lr && lr.ok && acts.join(',') === 'PL-OTHE-RRRR-RRRR,' && store.licenseKey === 'PL-MINE-MMMM-MMMM' && meCalls9h === 0
    ? ok('登入後自動接回授權：記得的碼不是這個帳號的，就不帶碼啟用、由伺服器從帳號裡挑，並記住它挑的那組')
    : bad(`登入後沒有照「以帳號為準」接回授權（啟用順序：${acts.join(' → ') || '沒有'}；現在是 ${store.licenseKey}；讀了 account/me ${meCalls9h} 次）`);

  // 9h2. 續期時伺服器換了一組（本賽季票到期、下一賽季票接手）→ 記住新的那組；
  //      續期被拒時用戶端**不**自己去挑別組（被擁有者解除的裝置不可以自己登記回去，見後端 resolveAccountKey）
  Object.assign(store, { licenseKey: 'PL-OLDS-SSSS-SSSS', accountToken: 'S3' });
  renewReply = { ok: true, entitlement: 'ENT6', exp: 9999999999, plan: 'season_next', licenseKey: 'PL-NEXT-NNNN-NNNN' };
  await sandbox.licenseRenew();
  const switched = store.licenseKey === 'PL-NEXT-NNNN-NNNN';
  store.licenseKey = 'PL-KICK-KKKK-KKKK';
  renewReply = { __status: 403, error: '這台裝置尚未啟用此授權' };
  fetches.length = 0;
  const rk = await sandbox.licenseRenew();
  const after = fetches.filter((f) => /\/v1\/(license\/activate|account\/me)/.test(String(f.url))).length;
  switched && rk && !rk.ok && after === 0
    ? ok('續期時伺服器換了碼就記住新的；續期被拒時不自己挑別組（被解除的裝置不會自己登記回去）')
    : bad(`續期換碼不對（記住新碼 ${switched}；被拒後又打了 ${after} 次啟用／帳號）`);

  // 9h3. 登入了、還沒有任何碼（先登入後才買）：每小時的檢查不帶碼問一次帳號
  for (const k of ['licenseKey', 'entitlement', 'entExp']) delete store[k];
  Object.assign(store, { accountToken: 'S3', entCheckedAt: Date.now() - 2 * 3600 * 1000 });
  activateReply = { ok: true, entitlement: 'ENT7', exp: 9999999999, plan: 'week', licenseKey: 'PL-BUYL-ATER-AAAA' };
  fetches.length = 0;
  const s7 = await call({ type: 'licenseStatus' });
  const acts3 = fetches.filter((f) => String(f.url).includes('/v1/license/activate')).map((f) => JSON.parse(f.init.body).licenseKey);
  acts3.join(',') === '' && acts3.length === 1 && store.licenseKey === 'PL-BUYL-ATER-AAAA' && s7.license && s7.license.active
    ? ok('先登入、後來才買：每小時的檢查不帶碼問帳號，買完不必重新登入或貼碼')
    : bad(`先登入後買的人沒有自動啟用（啟用 ${JSON.stringify(acts3)}、現在 ${store.licenseKey}、${JSON.stringify(s7.license)}）`);

  // 9i. 配對確認碼在彈出視窗關掉之後還看得到（2026-10-06 使用者回報）
  //     開分頁的那一刻 Chrome 會關掉彈出視窗——確認碼要在工具列徽章上、也要留在 storage 給重新打開的視窗讀
  let badge = '';
  let atTab = null;
  sandbox.chrome.action = { setBadgeText: async ({ text }) => { badge = text; }, setBadgeBackgroundColor: async () => {} };
  sandbox.chrome.tabs.create = async () => { atTab = { badge, pending: store.linkPending && { ...store.linkPending } }; };
  const realST = sandbox.setTimeout;
  sandbox.setTimeout = (fn) => realST(fn, 1);   // 輪詢的 2 秒改成 1ms
  let polls = 0;
  let pollHook = null;
  sandbox.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/v1/auth/link/start')) return { ok: true, status: 200, json: async () => ({ ok: true, code: 'AB12' }) };
    if (u.includes('/v1/auth/link?')) {
      polls++;
      if (pollHook) pollHook(polls);
      return { ok: true, status: 200, json: async () => (polls >= 3 ? { ok: true, token: 'LINKED' } : { ok: true, pending: true }) };
    }
    return origFetch(url, init);
  };
  delete store.accountToken;
  const lk = await call({ type: 'accountLink' });
  const shownOk = atTab && atTab.badge === 'AB12' && atTab.pending && atTab.pending.code === 'AB12' && atTab.pending.until > Date.now();
  const cleanedOk = lk.ok && store.accountToken === 'LINKED' && !store.linkPending && badge === '';
  shownOk && cleanedOk
    ? ok('配對時確認碼顯示在工具列圖示上、也留在 storage（彈出視窗被關掉後重新打開還看得到）；完成後兩者都清掉')
    : bad(`彈出視窗關掉後確認碼就看不到了（開分頁時徽章「${atTab && atTab.badge}」、storage ${JSON.stringify(atTab && atTab.pending)}），或完成後沒清掉（徽章「${badge}」、linkPending ${JSON.stringify(store.linkPending)}）`);

  // 9j. 使用者按「重新產生」：舊的那一輪要自己停，而且不可以清掉新那一輪的確認碼
  polls = 0;
  delete store.accountToken;
  pollHook = (n) => { if (n === 1) { store.linkPending = { code: 'NEW9', id: 'otherrun', until: Date.now() + 60000 }; badge = 'NEW9'; } };
  const sup = await call({ type: 'accountLink' });
  pollHook = null;
  sup.ok && sup.result && sup.result.superseded && store.linkPending && store.linkPending.code === 'NEW9' && badge === 'NEW9' && !store.accountToken
    ? ok('重新產生確認碼時，舊的一輪會停下來，不會把新的確認碼與徽章清掉')
    : bad(`重新產生確認碼後，舊的一輪沒有停或清掉了新的確認碼（結果 ${JSON.stringify(sup.result)}、linkPending ${JSON.stringify(store.linkPending)}、徽章「${badge}」）`);
  sandbox.setTimeout = realST;
  sandbox.fetch = origFetch;
  delete store.linkPending;
}
