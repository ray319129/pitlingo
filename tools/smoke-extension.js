#!/usr/bin/env node
/**
 * 擴充功能 content script 煙霧測試
 *
 * 為什麼需要這支：
 * `node --check` 只驗語法。刪掉一行 `let manifests = []` 之後語法完全合法，
 * 但一執行就 `ReferenceError: manifests is not defined`——v0.4.0 就是這樣
 * 交出去的（見 handoff 坑 #22）。
 *
 * 這支在 Node 裡用假的 DOM／chrome API 把 main.js 真的跑一遍，並主動觸發
 * 幾條實際用得到的路徑。目標不是驗證行為正確，而是**確保每條路徑上的識別字
 * 都存在**——那正是 `--check` 抓不到的那一類錯。
 *
 * 用法：node tools/smoke-extension.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const FAKE_CONFIG = {
  version: 1,
  sites: [{
    host: 'f1tv.formula1.com',
    captionRoot: ['.tm-subtitle-region-container'],
    captionLabel: ['.tm-ui-subtitle-label'],
    contentIdPattern: '/detail/(\d+)',
    hideCss: '.tm-subtitle-region-container{opacity:0 !important}',
  }],
};

const errors = [];
// 擴充功能對「頁面的 Console」講過的每一句話。見 sandbox.console。
const consoleOut = [];
const calls = { sendMessage: [], listeners: {} };

// boot() 是 async——裡面的 ReferenceError 不會往上拋，會變成未處理的 rejection
// （使用者在 Console 看到的正是 `Uncaught (in promise) ReferenceError`）。
// 不攔這個的話，最先炸掉的那一處反而測不到。
process.on('unhandledRejection', (e) => {
  errors.push(`未處理的 rejection：${(e && e.message) || e}`);
});

// --- 假 DOM ------------------------------------------------------------
// ⚠️ 這個假 DOM **刻意很笨**，只做被測到的那幾件事。
//    但「笨」與「假裝有做」是兩回事：`querySelector` 原本一律回 null，
//    於是任何「建好元素再找回來填內容」的程式碼在這裡都會**安靜地什麼都不做**，
//    測試照樣綠——即時狀態面板整塊就是這樣一行都沒被執行到。
//    所以下面補上 append / 依類別查找 / contains / getElementById，
//    剛好夠驗「面板真的產生了內容」。
function fakeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: '',
    style: { cssText: '', setProperty(k, v) { this[k] = v; } }, dataset: {}, children: [], textContent: '', className: '',
    title: '', type: '', onclick: null,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    // `isConnected` 一定要模擬出來。真的 DOM 靠它判斷「這個元素還在頁面上嗎」，
    // 假的 DOM 沒有的話，任何「已經掛上去就不要重建」的程式碼都會每次重建，
    // 而那在離線測試裡看起來完全正常。
    isConnected: false,
    appendChild(c) { this.children.push(c); c.parent = this; c.isConnected = true; return c; },
    append(...cs) { for (const c of cs) { this.children.push(c); c.parent = this; } },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      c.isConnected = false; c.parent = null;
      return c;
    },
    remove() { if (this.parent) this.parent.removeChild(this); else this.isConnected = false; },
    setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {},
    // 只支援 `.class` 與 `tag`，深度優先。夠用就好，不要假裝是真的選擇器。
    querySelector(sel) {
      const want = String(sel || '');
      const hit = (e) => (want.startsWith('.')
        ? String(e.className || '').split(/\s+/).includes(want.slice(1))
        : e.tagName === want.toUpperCase());
      const walk = (e) => {
        for (const c of e.children || []) {
          if (hit(c)) return c;
          const d = walk(c);
          if (d) return d;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 1280, height: 720, top: 0, left: 0, bottom: 720, right: 1280 }),
    contains(c) {
      const walk = (e) => (e.children || []).some((x) => x === c || walk(x));
      return walk(this);
    },
    closest: () => null,
    firstElementChild: null,
  };
  return el;
}

const documentStub = {
  visibilityState: 'visible',
  documentElement: fakeEl('html'),
  head: fakeEl('head'),
  body: fakeEl('body'),
  createElement: (t) => fakeEl(t),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener(type, fn) { (calls.listeners[type] = calls.listeners[type] || []).push(fn); },
  removeEventListener() {},
  getElementById(id) {
    const walk = (e) => {
      for (const c of e.children || []) {
        if (c.id === id) return c;
        const d = walk(c);
        if (d) return d;
      }
      return null;
    };
    return walk(documentStub.documentElement) || walk(documentStub.body);
  },
};

const windowListeners = {};
const sandbox = {
  // ⚠️ **不要用 no-op 假裝有 console。** 一般使用者按 F12 時必須看到
  //    完全乾淨的畫面，而那是可以量的：把每一次輸出記下來，
  //    然後斷言「正常載入的全程是 0 次」。
  console: {
    log(...a) { consoleOut.push(a.join(' ')); },
    warn(...a) { consoleOut.push(a.join(' ')); },
    error(...a) { consoleOut.push(a.join(' ')); },
  },
  document: documentStub,
  location: {
    href: 'https://f1tv.formula1.com/detail/1000010267/post-race-show-monaco?action=play',
    pathname: '/detail/1000010267/post-race-show-monaco',
    hostname: 'f1tv.formula1.com',
    origin: 'https://f1tv.formula1.com',
  },
  performance: {
    getEntriesByType: () => ([
      { name: 'https://f1tv.formula1.com/2.0/R/ENG/WEB_HLS/ALL/CONTENT/PLAY?contentId=1000010267&channelId=0' },
    ]),
    setResourceTimingBufferSize() {},
    now: () => Date.now(),
  },
  MutationObserver: class { observe() {} disconnect() {} },
  // 計時器全部吃掉，避免測試自己跑成無窮迴圈
  setTimeout: () => 0,
  setInterval: () => 0,
  // 量測「到上畫面」用得到。回呼直接吃掉——這裡沒有真的繪製，
  // 目的只是確認那條路徑上的識別字都存在。
  requestAnimationFrame: () => 0,
  clearTimeout() {}, clearInterval() {},
  Date, Math, JSON, Map, Set, Promise, RegExp, URL, Error, Object, Array, String, Number, Boolean,
  TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : class {},
  isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
  chrome: {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '0.0.0-test' }),
      sendMessage(msg, cb) {
        calls.sendMessage.push(msg && msg.type);
        // 每次都回「內容相同但物件是新的」——這正是真實情況：
        // SW 每次回應都會經過訊息序列化，content script 拿到的永遠是新物件。
        // 設定的比對邏輯必須靠內容判斷，不能靠參考。
        const config = JSON.parse(JSON.stringify(FAKE_CONFIG));
        if (cb) cb({ ok: true, config, settings: {}, bundle: { lines: {} }, result: {}, text: '' });
      },
      onMessage: { addListener() {} },
    },
    storage: { onChanged: { addListener() {} }, local: { get(_, cb) { cb && cb({}); }, set() {} } },
  },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.addEventListener = (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); };
sandbox.window.removeEventListener = () => {};
sandbox.window.postMessage = () => {};
sandbox.addEventListener = sandbox.window.addEventListener;

const ctx = vm.createContext(sandbox);

// ⚠️ **送進去的訊息，source 一定要用 context 內部看到的全域物件。**
//
//    Node 的 vm 在 context 內部看到的全域是一個代理，與外面的 `sandbox`
//    **不是同一個參照**。這裡原本傳 `sandbox.window`，於是 main.js 的
//    `if (ev.source !== window) return;` 永遠成立——**manifest、VTT、注入通知
//    三條橋接測試從來沒有真的把訊息送進去過**，只驗了「沒有丟例外」。
//    （2026-09-16 寫補字幕的行為測試時才發現：VTT 送了卻一句都沒收到。）
//    下面「VTT 橋接」那一項現在會斷言真的收到了，這個錯不會再靜默發生。
const INNER = vm.runInContext("this", ctx);

// --- 載入三支 content script（順序照 manifest）--------------------------
const FILES = [
  'extension/src/shared/normalize.js',
  'extension/src/shared/defaults.js',
  'extension/src/shared/live-delay.js',
  'extension/src/content/main.js',
];
for (const f of FILES) {
  try {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
  } catch (e) {
    errors.push(`載入 ${f} 失敗：${e.message}`);
  }
}

// --- 主動觸發實際路徑 ---------------------------------------------------
// 這些是 v0.4.0 真正炸掉的地方：訊息橋接與影片切換。
/**
 * ⚠️ **async 的區塊一定要 `await run(...)`。**
 *
 * 舊版只對回傳的 promise 掛 `.catch`，不等它——於是 async 區塊裡丟出來的
 * 錯誤會變成**延後的 rejection**，而最後那行 `if (errors.length)` 可能已經
 *跑完了。症狀是：**測試明明失敗卻回報通過**。
 *
 * 實際踩到：把「詳細日誌模式」改成 async 之後，回種「把 console.log 整個刪掉」
 * 這個 bug，測試照樣是綠的。我一度以為是斷言寫錯，追了三輪才發現
 * 錯的是這個 helper——**而它影響的是每一個 async 區塊，不只那一個**。
 */
function run(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.catch((e) => { errors.push(`${label}：${e.message}`); });
    }
  } catch (e) { errors.push(`${label}：${e.message}`); }
  return Promise.resolve();
}

// boot() 是 async，要讓 microtask 佇列跑完，橋接與監聽器才裝得上
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

main();
async function main() {
await settle();
const api = sandbox.__pitlingo || {};

// 3b) **一般使用者的 Console 必須是完全乾淨的。**
//
// ⚠️ 到這一行為止，跑過的是「安裝完打開 F1TV」的全程：載入、boot()、
//    讀設定、遠端設定、註冊 observer、第一次輪詢。一般使用者會經歷的就是這些。
//    在別人的網站上印東西是三件壞事：讓使用者以為是 F1TV 壞了、
//    把內部狀態（cid、快取命中、批次大小）攤在所有人面前、
//    以及把 F1TV 自己的錯誤訊息淹掉。
//
// ⚠️ **這一項是「兩個方向都要對」**：預設必須安靜，但管理員打開之後
//    必須真的印得出來——否則把 console.log 整個刪掉也會通過，
//    而那會讓你在直播現場完全瞎掉。另一半在「詳細日誌模式」那一段驗。
run('一般使用者的 Console 完全乾淨', () => {
  if (consoleOut.length) {
    throw new Error(`載入全程對 Console 印了 ${consoleOut.length} 次，第一句是：`
      + JSON.stringify(consoleOut[0].slice(0, 90)));
  }

  // ⚠️ **另一半（開啟後要印得出來）在這個環境測不出行為。**
  //    實測：boot() 跑完之後，prefetch／reloadConfig／注入通知／餵 VTT
  //    這四條路在假 DOM 下都不會再觸發 logEvent，所以「開啟 → 有輸出」
  //    沒有可觀測的訊號可以量。**我不假裝量得到。**
  //
  //    （追這件事的過程本身抓到一個更大的問題：`run()` 對 async 區塊
  //      只掛 .catch 不 await，所以**所有 async 區塊的失敗都被靜靜吞掉**。
  //      那個已經修好了，影響的不只這一項。）
  //
  //    退而求其次：用靜態斷言把那一行的形狀釘住。
  //    它證明得了「輸出有被守門、而且守門的是 debugOn」，
  //    證明不了「打開之後真的印得出來」——後者只能靠你在真的瀏覽器裡
  //    打一次 `__pitlingo.debug(true)` 確認。
  const mainSrc = fs.readFileSync(path.join(root, 'extension/src/content/main.js'), 'utf8');
  if (!/if \(debugOn\) console\.log\(`%c\[PitLingo\] \$\{msg\}`/.test(mainSrc)) {
    throw new Error('logEvent 的 Console 輸出沒有被 debugOn 守住（或守門的形狀被改了）');
  }
  // 反過來也要擋：不可以有人在 logEvent 之外直接印到使用者的 Console。
  //
  // ⚠️ **這裡以前是「最多允許 6 處」的計數。** 那是個假的檢查：
  //    每次新增一個 `__pitlingo.*` 指令就要把 6 改成 7，而改上限
  //    與「真的多印了一句給使用者看」在畫面上長得一模一樣——
  //    照著改幾次之後，這個檢查就只是一個會被順手調大的數字。
  //
  //    改成驗**位置**：
  //      · `const TESTING = {` 之後是「使用者自己打指令」的區域
  //        （__pitlingo.* 與測試工具），那裡本來就是要印給打指令的人看的
  //      · 在那之前的任何一句 console，都必須被 `debugOn` 守住
  //
  //    這樣新增指令不必動檢查，而在程式主體裡多印一句一定會紅。
  const lines = mainSrc.split('\n');
  const cmdStart = lines.findIndex((l) => /^\s*const TESTING = \{/.test(l));
  if (cmdStart < 0) {
    throw new Error('找不到 `const TESTING = {` —— Console 指令區的界線變了，這個檢查已經失效');
  }
  const leaks = lines
    .map((l, i) => [i + 1, l])
    .filter(([n]) => n <= cmdStart)                       // 指令區之後不管
    .filter(([, l]) => /(^|[^.\w])console\.(log|warn|error|info)\(/.test(l))
    .filter(([, l]) => !/^\s*(\/\/|\*)/.test(l))          // 註解不算
    // 守門可以在同一行（`if (debugOn) console.log(...)`），
    // 也可以在前兩行（`if (!debugOn) return;` 那種寫法）。
    .filter(([n]) => !lines.slice(Math.max(0, n - 3), n).some((x) => /debugOn/.test(x)));
  if (leaks.length) {
    throw new Error(`main.js 有 ${leaks.length} 處沒有被 debugOn 守住的 console`
      + `（在第 ${cmdStart + 1} 行的指令區之前）：`
      + leaks.slice(0, 3).map(([n, l]) => `第 ${n} 行 ${l.trim().slice(0, 50)}`).join('、'));
  }
});

// 1) MAIN world 送 manifest 過來（會走到 manifests.push）
run('inject 橋接 · manifest', () => {
  const handlers = windowListeners.message || [];
  if (!handlers.length) throw new Error('沒有註冊 message 監聽器，橋接可能沒安裝');
  const ev = {
    source: INNER,
    data: {
      __pitlingo_vtt__: true, kind: 'manifest',
      url: 'https://ott-video-fer-cf.formula1.com/v2/pa_TOKEN/h/h/index_13_0.m3u8',
      manifest: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="eng",URI="sub.m3u8"\n',
    },
  };
  handlers.forEach((h) => h(ev));
});

// 2) 送 VTT 過來（會走到 ingestVtt → scheduleFlush）
run('inject 橋接 · vtt', () => {
  const handlers = windowListeners.message || [];
  const ev = {
    source: INNER,
    data: {
      __pitlingo_vtt__: true, kind: 'vtt', url: 'https://x/seg1.vtt',
      vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nBox box box\n',
    },
  };
  const before = (sandbox.__pitlingo && sandbox.__pitlingo.state.workerVtt) || 0;
  handlers.forEach((h) => h(ev));
  const after = (sandbox.__pitlingo && sandbox.__pitlingo.state.workerVtt) || 0;
  // ⚠️ **一定要驗「真的收到了」，不是只驗「沒有丟例外」。**
  //    訊息被 source 檢查擋掉時什麼都不會發生，而「什麼都沒發生」也不會丟例外。
  if (after !== before + 1) {
    throw new Error(`VTT 送進去了但橋接沒有收到（workerVtt ${before} → ${after}）`
      + ' —— 通常是 source 不是 context 內部的全域物件');
  }
});

// 3) 注入成功通知
run('inject 橋接 · injected', () => {
  const handlers = windowListeners.message || [];
  handlers.forEach((h) => h({
    source: INNER,
    data: { __pitlingo_vtt__: true, kind: 'injected', bytes: 707103 },
  }));
});

// 4) 診斷報告（buildDiagnostics 會讀 manifests，v0.4.0 就是在這裡炸的）
run('匯出診斷', () => {
  if (typeof api.diag !== 'function') throw new Error('__pitlingo.diag 不存在');
  const out = api.diag();
  if (typeof out !== 'string' || out.length < 100) throw new Error('診斷內容異常短');
  // 診斷報告是唯一的回報管道，區塊被改壞了不會有其他徵兆。
  // 這裡釘住幾個「出問題時一定要看到」的欄位。
  const MUST = [
    '攔到的 manifest',        // 整軌預抓的入口
    '偵測來源',                // 顯示延遲的歸因
    '後端回寫查核',            // 譯文有沒有真的進共用快取
    '事件時間軸',
  ];
  const missing = MUST.filter((k) => out.indexOf(k) === -1);
  if (missing.length) throw new Error('診斷報告缺少欄位：' + missing.join('、'));
});

// 4b) 詳細日誌開啟後，各條路徑仍要跑得過（dbg 自己不能炸）
// ⚠️ 這一段**必須是 async**：橋接的處理是非同步的，同步量會永遠得到 0，
//    然後你會以為「開了詳細日誌也不印」而去修一段沒有壞的程式碼。
await run('詳細日誌模式', async () => {
  if (typeof api.debug !== 'function') throw new Error('__pitlingo.debug 不存在');
  api.debug(true);
  // ⚠️ **只能量這一段的「差額」。** 直接看 consoleOut.length 是不夠的——
  //    api.diag() 自己也會印，那一行會把差額蓋掉，於是「把 logEvent 的
  //    輸出整個刪掉」照樣通過。（回種驗證時就是這樣漏掉的。）
  const beforeFeed = consoleOut.length;
  const handlers = windowListeners.message || [];
  handlers.forEach((h) => h({
    source: INNER,
    data: {
      __pitlingo_vtt__: true, kind: 'vtt', url: 'https://x/seg2.vtt',
      vtt: 'WEBVTT\n\n00:00:04.000 --> 00:00:06.000\nHe is going for the undercut\n',
    },
  }));
  await settle();

  await settle();
  api.diag();

  api.debug(false);
  // 關掉之後要立刻恢復安靜，不能等下一次重整
  const after = consoleOut.length;
  const handlers2 = windowListeners.message || [];
  handlers2.forEach((h) => h({
    source: INNER,
    data: {
      __pitlingo_vtt__: true, kind: 'vtt', url: 'https://x/seg3.vtt',
      vtt: 'WEBVTT\n\n00:00:08.000 --> 00:00:10.000\nThat is a big lock up\n',
    },
  }));
  if (consoleOut.length !== after) {
    throw new Error('關掉詳細日誌之後 Console 還在輸出 —— 開關只有單向有效');
  }
});

// 5) 換影片。checkContentChange 沒有公開入口，改用 boot() 註冊在 window 的
//    focus handler——它會走 checkPollStall + pollCaption，而 structural 檢查
//    的那條路徑（含 manifests = []）由 prefetch 入口一併覆蓋。
run('切換影片 → 整軌預抓入口', () => {
  sandbox.location.pathname = '/detail/1000010243/post-race-show-miami';
  if (!api.t || typeof api.t.prefetch !== 'function') throw new Error('__pitlingo.t.prefetch 不存在');
  api.t.prefetch();
});

run('視窗事件（focus / resize）', () => {
  for (const t of ['focus', 'visibilitychange', 'resize', 'scroll']) {
    (windowListeners[t] || []).forEach((h) => h({ type: t }));
  }
});

// 5b) 遠端設定必須是冪等的。
//     實測踩到：內容完全沒變，卻每 60 秒判定「已更新 v1 → v1」並整組重掛
//     觀察者、清空去重狀態。三小時下來事件時間軸 150 筆全是同一行，
//     真正重要的紀錄全被擠掉——診斷報告是這個專案唯一的回報管道，
//     被洗版等於瞎了。（handoff 坑 #28）
await run('遠端設定冪等性', async () => {
  if (!api.t || typeof api.t.reloadConfig !== 'function') throw new Error('t.reloadConfig 不存在');
  await api.t.reloadConfig();                 // 第一次：可能真的有變
  await settle();
  const changed = await api.t.reloadConfig(); // 第二次：內容一樣，必須回 false
  if (changed) throw new Error('設定內容沒變，applyRemoteConfig 卻回報「已更新」——會每 60 秒重掛一次');
});

// 6) 正式版保留的入口
for (const name of ['peek', 'events', 'state']) {
  run(`__pitlingo.${name}`, () => {
    const v = api[name];
    if (typeof v === 'function') v();
  });
}

// 7) 測試工具全部跑一遍。上線前這整組會被刪掉，但在那之前它們必須是活的——
//    測試指令自己壞了卻沒人發現，等於測試階段少了一半的眼睛。
run('測試工具 __pitlingo.t.*', () => {
  const t = api.t;
  if (!t) throw new Error('__pitlingo.t 不存在');
  t.help();
  t.detect(); t.batches(); t.manifests(); t.memo(); t.pending();
  t.settings(); t.site();
  t.feed('Box box box, Max.');
  t.stall();
  t.dvr();
});

// 8) 即時狀態面板 ＋ 直播自動採樣
//
// ⚠️ **這兩樣平常只在直播當下執行。** 也就是說，它們壞掉的時候
//    正好是最沒有辦法重來的時候——「下次直播再看看」是不存在的選項。
//    所以這裡一定要在離線把它們真的跑一遍。
run('即時狀態面板 __pitlingo.hud()', () => {
  if (typeof api.hud !== 'function') throw new Error('__pitlingo.hud 不存在');

  const on = api.hud(true);
  if (on !== true) throw new Error('hud(true) 沒有回報開啟');

  const el = documentStub.getElementById('pitlingo-hud');
  if (!el) throw new Error('面板沒有被加進 DOM');

  const body = el.querySelector('.plHudBody');
  if (!body) throw new Error('找不到面板內容區（.plHudBody）');

  // ⚠️ **一定要驗內容不是空的。** 只驗「元素存在」的話，
  //    hudPaint 整個沒被執行也會通過——那正是這個檢查要擋的東西。
  const txt = String(body.textContent || '');
  for (const want of ['狀態', '提前量', '字幕', '批次', '畫面', '額度']) {
    if (!txt.includes(want)) {
      throw new Error(`面板少了「${want}」這一列（目前內容：${JSON.stringify(txt.slice(0, 80))}）`);
    }
  }
  if (/NaN|undefined/.test(txt)) {
    throw new Error(`面板印出了 NaN／undefined：${JSON.stringify(txt.slice(0, 120))}`);
  }

  // 收合之後也要有東西，不可以變成空白方塊
  el.querySelector('.plHudBody');
  api.hud(false);
  if (documentStub.getElementById('pitlingo-hud')) throw new Error('關閉之後面板還留在 DOM 裡');
});

run('直播自動採樣 __pitlingo.live()', () => {
  const s = api.live();
  if (!s) throw new Error('採樣沒有啟動 —— boot() 裡的 ltStart() 沒被呼叫到');
  for (const k of ['minutes', 'stalls', 'events']) {
    if (!(k in s)) throw new Error(`採樣摘要少了 ${k}`);
  }
});

// --- 結果 --------------------------------------------------------------
await settle();
if (errors.length) {
  console.log('❌ 煙霧測試失敗\n');
  errors.forEach((e) => console.log('   ' + e));
  console.log('\n這類錯誤 node --check 抓不到——它只驗語法，不驗識別字是否存在。');
  process.exit(1);
}
console.log('✅ content script 可載入，且下列路徑都跑得過：');
console.log('   manifest 橋接 / VTT 橋接 / 注入通知 / 匯出診斷 / 切換影片 / 公開入口');
console.log(`   （期間對 service worker 發出 ${calls.sendMessage.length} 則訊息：`
  + `${[...new Set(calls.sendMessage)].join(', ')}）`);
}
