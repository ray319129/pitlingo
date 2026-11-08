#!/usr/bin/env node
/**
 * 補上官方漏掉的字幕 —— 行為測試
 *
 * ⚠️ **為什麼要獨立一支，而不是塞進 smoke-extension：**
 *    smoke-extension 把 setInterval 換成空函式（避免無窮迴圈），
 *    所以**輪詢主迴圈在那裡從來沒有跑過**。補字幕只在「影片播放中、
 *    原生字幕空白」時觸發——在 smoke 裡它一行都不會執行，測試照樣綠。
 *
 *    這裡把輪詢函式攔下來手動呼叫，並用一個可以控制播放位置的假 video
 *    與一個可以控制內容的假字幕容器，**一步一步推著時間走**。
 *
 * 驗的是使用者看得到的結果：畫面上那一格有沒有出現那句中文、何時收起。
 *
 * 用法：node tools/check-gapfill.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

let failed = 0;
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { failed++; console.log('❌ ' + m); };

// ---- 先載一份 normalize 算快取鍵（與擴充功能用的是同一支檔案）----
const pre = { self: {} };
pre.self = pre;
vm.createContext(pre);
vm.runInContext(fs.readFileSync(path.join(root, 'extension/src/shared/normalize.js'), 'utf8'), pre);
const normKey = pre.PL.normKey;

const CUES = [
  { s: '00:00:10.000', e: '00:00:12.000', en: 'Box this lap, box this lap.', zh: '這圈進站，這圈進站。' },
  { s: '00:00:12.500', e: '00:00:14.500', en: 'Copy that, boxing now.', zh: '收到，現在進站。' },
  { s: '00:00:15.000', e: '00:00:17.000', en: 'Watch the tyres into turn one.', zh: '進一號彎注意輪胎。' },
  { s: '00:00:17.500', e: '00:00:19.500', en: 'He is closing fast behind you.', zh: '他在你後面快速逼近。' },
];
const VTT = 'WEBVTT\n\n' + CUES.map((c) => `${c.s} --> ${c.e}\n${c.en}\n`).join('\n');

/**
 * 建立一個全新的擴充功能執行環境。每個情境各自一份，互不污染。
 * `withLines` 決定共用快取裡有哪幾句的譯文。
 */
async function makeEnv(withLines) {
  const lines = {};
  for (const i of withLines) lines[normKey(CUES[i].en)] = CUES[i].zh;

  let captionText = '';
  const created = [];
  const intervals = [];
  const listeners = {};

  function el(tag) {
    const cls = new Set();
    const e = {
      tagName: String(tag || 'div').toUpperCase(),
      style: { setProperty(k, v) { this[k] = v; } }, dataset: {}, children: [], textContent: '', className: '', id: '',
      isConnected: false, firstElementChild: null,
      classList: {
        add: (c) => cls.add(c), remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c), toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)),
      },
      appendChild(c) { this.children.push(c); c.isConnected = true; return c; },
      append(...cs) { cs.forEach((c) => this.appendChild(c)); },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      remove() {},
      setAttribute() {}, getAttribute: () => null,
      addEventListener() {}, removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 1280, height: 720, top: 0, left: 0, bottom: 720, right: 1280 }),
      contains: () => true, closest: () => null,
      __cls: cls,
    };
    created.push(e);
    return e;
  }

  // 字幕容器：label 底下一個 span，內容由 captionText 控制
  const span = { firstElementChild: null, get textContent() { return captionText; } };
  const label = {
    firstElementChild: span,
    querySelectorAll: (sel) => (sel === '*' && captionText ? [span] : []),
    get textContent() { return captionText; },
  };
  const container = {
    querySelectorAll: (sel) => (sel === '.tm-ui-subtitle-label' && captionText ? [label] : []),
    getBoundingClientRect: () => ({ width: 1280, height: 200, top: 500, left: 0, bottom: 700, right: 1280 }),
    get textContent() { return captionText; },
    firstElementChild: null,
    parentElement: null,
  };

  const video = {
    currentTime: 0, paused: false, ended: false, readyState: 4, duration: 3600, playbackRate: 1,
    videoWidth: 1920, videoHeight: 1080,
    seekable: { length: 0 }, buffered: { length: 0 },
    getBoundingClientRect: () => ({ width: 1280, height: 720, top: 0, left: 0, bottom: 720, right: 1280 }),
    parentElement: null,
  };

  const document = {
    visibilityState: 'visible',
    documentElement: el('html'), head: el('head'), body: el('body'),
    createElement: (t) => el(t),
    querySelector: (sel) => (sel === 'video' ? video : null),
    querySelectorAll: (sel) => (sel === '.tm-subtitle-region-container' ? [container] : sel === 'video' ? [video] : []),
    addEventListener() {}, removeEventListener() {},
    getElementById: () => null,
  };

  const path0 = '/detail/1000010267/2026-monaco-grand-prix';
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document,
    location: {
      href: 'https://f1tv.formula1.com' + path0 + '?action=play', pathname: path0,
      hostname: 'f1tv.formula1.com', origin: 'https://f1tv.formula1.com',
    },
    performance: {
      getEntriesByType: () => ([{ name: 'https://f1tv.formula1.com/2.0/R/ENG/WEB_HLS/ALL/CONTENT/PLAY?contentId=1000010267&channelId=0' }]),
      setResourceTimingBufferSize() {}, now: () => Date.now(),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 0,
    // ⚠️ 這一行是整支測試的關鍵：把輪詢攔下來，之後手動推
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    requestAnimationFrame: () => 0,
    clearTimeout() {}, clearInterval() {},
    Date, Math, JSON, Map, Set, Promise, RegExp, URL, Error, Object, Array, String, Number, Boolean,
    TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : class {},
    isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    chrome: {
      runtime: {
        lastError: null,
        getManifest: () => ({ version: '0.0.0-test' }),
        sendMessage(msg, cb) {
          const config = {
            version: 1,
            sites: [{
              host: 'f1tv.formula1.com',
              captionRoot: ['.tm-subtitle-region-container'],
              captionLabel: ['.tm-ui-subtitle-label'],
              contentIdPattern: '/detail/(\\d+)',
              hideCss: '',
            }],
          };
          if (cb) cb({ ok: true, config, settings: {}, bundle: { lines }, result: {}, text: '' });
        },
        onMessage: { addListener() {} },
      },
      storage: { onChanged: { addListener() {} }, local: { get(_, cb) { cb && cb({}); }, set() {} } },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.postMessage = () => {};

  const ctx = vm.createContext(sandbox);
  for (const f of ['extension/src/shared/normalize.js', 'extension/src/shared/defaults.js', 'extension/src/shared/live-delay.js', 'extension/src/content/main.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
  }
  for (let i = 0; i < 40; i++) await Promise.resolve();

  // 輪詢主迴圈 = 間隔最短的那一個（POLL_MS）
  const poll = intervals.slice().sort((a, b) => a.ms - b.ms)[0];
  if (!poll) throw new Error('沒有攔到任何 setInterval —— boot() 可能沒跑完');

  // 送一份 VTT 進去（走真正的橋接路徑）
  (listeners.message || []).forEach((h) => h({
    // ⚠️ **source 一定要用 context 內部的全域物件，不可以用外面的 sandbox。**
    //    Node 的 vm 在 context 內看到的全域是代理，與外面的 sandbox 不是同一個參照，
    //    所以 `ev.source !== window` 永遠成立，訊息會被當成外人發的而丟掉——
    //    **不報錯，VTT 就是沒進去**。smoke-extension 的橋接測試就是這樣
    //    從來沒有真的把 VTT 送進去過。
    source: vm.runInContext('this', ctx), data: { __pitlingo_vtt__: true, kind: 'vtt', url: 'https://x/seg1.vtt', vtt: VTT },
  }));

  /** 推進到某個播放位置、設定原生字幕的內容，然後跑一次輪詢。 */
  function step(t, native) {
    video.currentTime = t;
    captionText = native || '';
    poll.fn();
  }
  /** 疊字現在畫著什麼（沒有顯示就回空字串）。 */
  function shown() {
    const box = created.find((e) => e.__cls.has('on') && e.children.length);
    if (!box) return '';
    const hit = created.find((e) => CUES.some((c) => c.zh === e.textContent));
    return hit ? hit.textContent : '';
  }
  /** 某段文字有沒有出現在任何疊字元素上（中文或英文都算）。 */
  function drew(text) { return created.some((e) => e.textContent === text); }
  return { step, shown, drew, video, api: sandbox.__pitlingo, sandbox };
}

(async () => {
  // ---- 1. 官方漏掉第二句 → 我們補上，時段結束就收 ----
  {
    const E = await makeEnv([0, 1, 2, 3]);
    if (!E.api || !E.api.state || E.api.state.memo < 4) {
      bad(`測試環境沒有載入譯文（memo=${E.api && E.api.state && E.api.state.memo}）—— 以下結果無效`);
    }
    // 播放位置刻意用 50 秒——與 VTT 的 10 秒完全對不上，
    // 證明補字幕**不依賴**絕對時間對齊。
    // （不能再大：未授權的遊客重播只有前 180 秒免費，超過就整個停掉。）
    E.step(50.0, CUES[0].en);                       // 原生畫出第一句 → 錨點
    E.step(50.9, '');                               // 原生清空；第二句要到 +2.5s 才該出現
    E.shown() === CUES[1].zh
      ? bad('第二句還沒到時間就被補上了')
      : ok('還沒到時間不會搶先補');

    E.step(53.4, '');                               // +3.4s：已過 2.5+0.8 的寬限，第二句時段內
    E.shown() === CUES[1].zh
      ? ok('官方漏掉的那一句，在它該出現的時段被補上了')
      : bad(`官方漏掉的那一句沒有被補上（畫面上是「${E.shown()}」）`);

    E.step(54.6, '');                               // +4.6s：第二句的結束時間（+4.5s）已過
    E.shown() === CUES[1].zh
      ? bad('補上的那一句過了結束時間還賴在畫面上')
      : ok('補上的那一句在它的結束時間收起');

    E.step(55.1, CUES[2].en);                       // 原生正常畫出第三句
    const d = E.api.diag();
    /官方漏掉　：1 句/.test(d) && /我們補上　：1 句/.test(d)
      ? ok('診斷報告記得「官方漏了 1 句、我們補了 1 句」')
      : bad('診斷報告的補字幕統計不對：' + (d.match(/官方漏掉.*|我們補上.*/g) || ['（找不到）']).join(' / '));
  }

  // ---- 2. 官方自己有畫 → 不補，也不算漏 ----
  {
    const E = await makeEnv([0, 1, 2, 3]);
    E.step(50.0, CUES[0].en);
    E.step(52.6, CUES[1].en);                       // 原生準時畫出第二句
    E.step(54.6, '');
    E.step(55.1, CUES[2].en);
    const d = E.api.diag();
    /官方漏掉　：0 句/.test(d) && /我們補上　：0 句/.test(d)
      ? ok('官方沒有漏的時候，不補也不誤報')
      : bad('官方沒有漏卻被記成漏掉或補了：' + (d.match(/官方漏掉.*|我們補上.*/g) || []).join(' / '));
  }

  // ---- 3. 暫停中不補 ----
  {
    const E = await makeEnv([0, 1, 2, 3]);
    E.step(50.0, CUES[0].en);
    E.video.paused = true;
    E.step(53.4, '');
    E.shown() === CUES[1].zh
      ? bad('暫停中竟然補字幕')
      : ok('暫停中不補');
  }

  // ---- 4. 往回拖進度條 → 錨點作廢，不可以補出錯的句子 ----
  {
    const E = await makeEnv([0, 1, 2, 3]);
    E.step(50.0, CUES[0].en);
    E.step(20.0, '');                                // 往回拖 30 秒
    E.step(23.4, '');
    E.shown() === CUES[1].zh
      ? bad('拖過進度條之後補出了不相干的句子')
      : ok('拖過進度條後錨點作廢，不會補出錯的句子');
  }

  // ---- 5. 沒有譯文 → 不畫英文佔位，只排急件 ----
  {
    const E = await makeEnv([0, 2, 3]);              // 第二句沒有譯文
    E.step(50.0, CUES[0].en);
    E.step(53.4, '');
    // ⚠️ 不能用 shown() === ''：測試環境的計時器是空的，第一句永遠不會被收起。
    //    要驗的是「沒有譯文的那一句」本身有沒有被畫出來——中文與英文都不可以。
    !E.drew(CUES[1].zh) && !E.drew(CUES[1].en)
      ? ok('沒有譯文時不補（不畫「翻譯中…」也不畫英文佔位）')
      : bad('沒有譯文卻把那一句畫出來了');
    // ⚠️ 這裡**刻意不驗**「有沒有排進翻譯佇列」。
    //    那一句在 VTT 送進來時就已經被 ingestVtt 排進去了，
    //    補字幕那段排隊邏輯就算整個刪掉，`pending >= 1` 照樣成立——
    //    寫了就是一個什麼都沒驗到卻是綠的檢查。
  }

  console.log('');
  if (failed) {
    console.log(`❌ 補字幕有 ${failed} 項未通過`);
    process.exit(1);
  }
  console.log('✅ 補上官方漏掉的字幕：五個情境全部正確');
})().catch((e) => { console.log('❌ 測試環境崩潰：' + (e && e.stack || e)); process.exit(1); });
