#!/usr/bin/env node
/**
 * 直播多人同時觀看的並發模擬。
 *
 * **存在的理由**：直播是這個專案最大的未知數（AUDIT 的 U1），而它最貴的
 * 失敗模式——「N 個觀眾同時送同一批句子去翻，付 N 倍的錢」——
 * 需要多個使用者才會發生，而開發者只有一台電腦。
 *
 * 這支不需要第二台電腦，也不需要真的直播：直接把 `handleTranslate` 載進來，
 * 用假的 KV 與假的模型，讓 N 個請求**同時**打同一批句子，然後數
 * **模型實際被呼叫幾次**。那個數字就是成本倍率。
 *
 * 判定：
 *   1. 非急件（前瞻預譯）：N 個並發只該有 1 次模型呼叫
 *   2. 急件（畫面上就要用）：**不可以讓路**，每個人都要拿到譯文
 *   3. 讓路的人一定要拿得到 `pendingElsewhere`，不能靜靜地回空的
 *   4. 認領機制壞掉時要放行（降級成重複翻），不可以變成沒有字幕
 *
 * 用法：node tools/check-live-concurrency.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const vm = require('vm');
const root = path.join(__dirname, '..');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const fail = (m, d) => { errors.push(m + (d ? '：' + d : '')); console.log('❌ ' + m + (d ? '：' + d : '')); };

// ⚠️ **後端一定要以嚴格模式載入。** 真正的 Worker 是 ESM（＝嚴格），
//    但 vm.runInContext 跑的是 script（＝非嚴格）。差別會吃掉一整類 bug：
//    對未宣告的變數賦值在這裡只是建立一個全域，在 Worker 上是 ReferenceError。
//    實際發生過——`let hasWeekPurchase` 被刪掉、`hasWeekPurchase = true` 留著，
//    node --check 與所有檢查工具**全部放行**，線上頁面才炸（坑 #22 的變形）。
let src = "'use strict';\n" + readBackend();
// ⚠️ 兩種 export 都要剝：`export default {...}`（Worker 入口）
//    與 `export class SubtitleRoom`（Durable Object）。
//    只剝前者的話，沙箱會在 `export class` 那行語法錯誤——
//    而錯誤訊息指向的是 index.js 的行號，看起來像後端壞掉。
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

// --- 假環境 ---------------------------------------------------------------
let modelCalls = 0;                 // ← 這個數字就是成本倍率
const kv = new Map();
const cacheStore = new Map();

function makeSandbox(opts) {
  const o = opts || {};
  const sandbox = {
    crypto: require('crypto').webcrypto,
    TextEncoder, TextDecoder, btoa, atob,
    // ⚠️ **`ok` 不可以省。** 真的 Response 在 2xx 時 `ok === true`，
    //    而 `claimViaDO` 就是靠 `if (!res.ok) return null` 判斷 DO 能不能用。
    //    少了它，DO 那條路在測試裡**永遠走不到**，所有結論都只反映
    //    Cache API 的退路——而線上跑的是 DO。
    Response: class {
      constructor(b, i) {
        this.body = b;
        this.status = 200;
        Object.assign(this, i || {});
        if (this.ok === undefined) this.ok = this.status >= 200 && this.status < 300;
      }
      async json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
    },
    Request: class {},
    URL, console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Map, Set, Promise, RegExp, Error,
    Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite,
    // 急件的「認領但不放棄」會等一小段時間再重讀快取，沒有這個會 ReferenceError
    setTimeout, clearTimeout,
    // Cache API：認領機制用的。`broken` 模式用來驗降級行為。
    caches: o.broken ? undefined : {
      default: {
        async match(u) { return cacheStore.has(u) ? { ok: true } : undefined; },
        async put(u) { cacheStore.set(u, 1); },
      },
    },
    // 模型：每次呼叫就記一筆。這是整支測試的核心量測。
    fetch: async (url, init) => {
      if (String(url).includes('anthropic')) {
        modelCalls++;
        const body = JSON.parse(init.body);
        const text = JSON.stringify(body.messages || body);
        // 回應格式必須與 `translateBatch` 的解析一致：「N. 譯文」每行一句。
        // 格式不對的話，模型呼叫次數量得到，但「有沒有拿到譯文」全部是 0，
        // 那些斷言就變成量不到東西——**測試看起來在跑，其實什麼都沒驗**。
        const nums = [...text.matchAll(/(\d+)\.\s/g)].map((m) => Number(m[1]));
        const n = nums.length ? Math.max(...nums) : 1;
        const out = Array.from({ length: n }, (_, i) => `${i + 1}. 中文譯文${i + 1}`).join('\n');
        return {
          ok: true, status: 200,
          async json() {
            // ⚠️ **`type: 'text'` 不可以省。** callModel 會
            //    `.filter((b) => b.type === 'text')`——少了它，文字整個被濾掉，
            //    於是「模型呼叫幾次」量得到，而「有沒有人拿到字幕」**永遠是 0**。
            //    這支測試就這樣壞了一段時間都沒人發現（它當時不在 check-all 裡）。
            return {
              content: [{ type: 'text', text: out }],
              usage: { input_tokens: 10, output_tokens: 10 },
            };
          },
        };
      }
      throw new Error('未預期的網路呼叫：' + url);
    },
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

const sandbox = makeSandbox({});
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { handleTranslate, SubtitleRoom };', sandbox);
const A = sandbox.__api;

/**
 * 假的 Durable Object namespace。
 *
 * 真的 DO 是單執行緒的——同一個 id 的請求會排隊。這裡用一條 Promise 鏈
 * 重現那個特性：**每個請求都要等前一個做完才開始**。
 * 不模擬排隊的話這支測試會通過，但線上仍然會 race。
 */
function makeRoomNamespace(Cls, env) {
  const rooms = new Map();
  return {
    idFromName: (n) => ({ name: n, toString: () => n }),
    get(id) {
      const key = String(id.name);
      if (!rooms.has(key)) {
        rooms.set(key, { inst: new Cls({ storage: new Map() }, env), queue: Promise.resolve() });
      }
      const r = rooms.get(key);
      return {
        fetch(url, init) {
          // 排隊：DO 一次只處理一個請求
          const next = r.queue.then(() => r.inst.fetch({
            async json() { return JSON.parse(init.body); },
          }));
          r.queue = next.catch(() => {});
          return next;
        },
      };
    },
  };
}

const env = {
  TOKEN_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'sk-test', DAILY_USD_CAP: '999',
  SUBS: {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  },
};
// DO binding。名稱要與 wrangler.toml 的 `name = "ROOM"` 一致。
env.ROOM = makeRoomNamespace(A.SubtitleRoom, env);

// 已授權的安裝，避免免費層額度干擾這裡要量的東西
const auth = { ok: true, installId: 'test-install', legacy: true };

function req(body) {
  return {
    headers: { get: () => null },
    async json() { return body; },
  };
}

const LINES = ['Box box box Max', 'He is closing in fast', 'That is a great move'];

// ⚠️ **每一輪都要用不同的 cid。**
//    DO 會把翻好的結果留著（那正是新設計的重點：立刻交給等待者），
//    而 `kv.clear()` 清不到 DO 的記憶體。沿用同一個 cid 的話，
//    第二輪的等待者會撿到第一輪的結果 → 模型呼叫 0 次 →
//    **看起來是完美的去重，其實那一輪根本沒測到東西。**
let round = 0;

async function fire(n, urgent) {
  modelCalls = 0;
  kv.clear();
  cacheStore.clear();
  round++;
  // **同時**送出，不 await 前一個 —— 這正是直播現場會發生的事
  const rs = await Promise.all(Array.from({ length: n }, (_, i) =>
    // cid 一定要是數字：F1TV 的 contentId 都是數字，非數字（例如 'misc'）後端不做去重、不寫快取
    A.handleTranslate(req({ cid: String(9000000000 + round), lines: LINES, urgent }), env, '1.2.3.4',
      { ...auth, installId: 'install-' + i })));
  const bodies = await Promise.all(rs.map((r) => r.json()));
  return { calls: modelCalls, bodies };
}

(async () => {
  console.log('──── 10 位觀眾同時看同一場直播 ────\n');

  // 1. 前瞻預譯：應該只有一個人真的去翻
  {
    const { calls, bodies } = await fire(10, false);
    const yielded = bodies.filter((b) => b && b.pendingElsewhere).length;
    console.log(`   前瞻預譯（非急件）：模型呼叫 ${calls} 次，${yielded}/10 位讓路`);
    calls <= 2
      ? ok(`並發去重有效：10 位觀眾只花了 ${calls} 次翻譯的錢`)
      : fail(`並發去重失效：10 位觀眾花了 ${calls} 次的錢 —— 成本會隨在線人數等比放大`, '');
    // ⚠️ **不要驗「有幾位讓路」，要驗「沒有人拿到空的」。**
    //    以前寫 `yielded >= 8`。2026-09-17 把頻率限制的鍵改成雜湊（隱私權政策要求）之後，
    //    每個請求多了一次真正非同步的 crypto 運算，抵達順序跟著變：
    //    另外 9 位不再讓路，而是**直接拿到第一位剛翻好的結果**——
    //    模型仍然只呼叫 1 次、每個人都拿到字幕，對使用者更好（不必等 1.2 秒再讀）。
    //    讓路幾位取決於抵達時序，那不是這支測試要守的東西；
    //    要守的是：**每一位不是拿到全部譯文，就是拿到 pendingElsewhere**（不可以靜靜地回空的）。
    const silentEmpty = bodies.filter((b) => !(b && b.pendingElsewhere)
      && !LINES.every((l) => Object.values((b && b.lines) || {}).length >= LINES.length)).length;
    silentEmpty === 0
      ? ok(`每一位都有結果：${10 - yielded} 位直接拿到譯文、${yielded} 位收到 pendingElsewhere（沒有人靜靜地拿到空的）`)
      : fail('有人既沒有拿到譯文、也沒有收到 pendingElsewhere —— 會以為那些句子沒有譯文', `${silentEmpty} 位`);
  }

  // 2. 急件：**絕對不能讓路**
  //    直播字幕 3~4 秒換一句，讓路的人等回來時畫面早就換過了。
  {
    const { calls, bodies } = await fire(10, true);
    const yielded = bodies.filter((b) => b && b.pendingElsewhere).length;
    const gotAll = bodies.filter((b) => b && b.lines && Object.keys(b.lines).length === LINES.length).length;
    console.log(`   DOM 逐句（急件）　：模型呼叫 ${calls} 次，${yielded}/10 位讓路，${gotAll}/10 位拿到全部譯文`);
    yielded === 0
      ? ok('急件完全不讓路（畫面上正在顯示的句子不能等）')
      : fail('急件被要求讓路 —— 那些人的字幕會直接消失', `${yielded} 位`);
    gotAll === 10
      ? ok('10 位觀眾都拿到了完整譯文')
      : fail('有人沒拿到譯文', `只有 ${gotAll}/10`);
  }

  // 3. 認領機制壞掉時要降級成「重複翻」，不可以變成「沒有字幕」
  {
    const s2 = makeSandbox({ broken: true });
    vm.createContext(s2);
    vm.runInContext(src + '\n;this.__api = { handleTranslate };', s2);
    modelCalls = 0; kv.clear();
    // ⚠️ **兩個獨立的錯誤，都會讓這一項量到假的東西：**
    //
    //  1. 傳同一個 `env` → `env.ROOM` 還在 → DO 照常運作，
    //     於是這一項測的是「Cache API 壞了但 DO 正常」，
    //     而不是它宣稱的「認領機制不可用」。
    //  2. 沿用同一個 cid → 前兩個測試在 DO 裡留下的認領還沒過期（TTL 25 秒），
    //     於是三個人全部讓路、全部拿不到字幕，看起來像降級失敗。
    //
    // 真正要驗的是：**認領完全不可用時，沒有人會因此看不到字幕。**
    const envNoClaim = { ...env, ROOM: undefined };
    const rs = await Promise.all(Array.from({ length: 3 }, (_, i) =>
      s2.__api.handleTranslate(req({ cid: '9100000001', lines: LINES, urgent: false }), envNoClaim, '1.2.3.4',
        { ...auth, installId: 'x-' + i })));
    const bodies = await Promise.all(rs.map((r) => r.json()));
    const gotAll = bodies.filter((b) => b && b.lines && Object.keys(b.lines).length === LINES.length).length;
    console.log(`   Cache API 不可用　：${gotAll}/3 位仍拿到完整譯文`);
    gotAll === 3
      ? ok('認領機制不可用時放行（降級成多花錢，不是沒有字幕）')
      : fail('認領機制故障導致使用者拿不到字幕 —— 省錢的機制不可以製造功能性故障', `${gotAll}/3`);
  }

  // 4. 沒有影片編號（擴充功能在 contentId 解析出來之前送的批次，sw.js 補成 'misc'）
  //    ⚠️ 2026-09-17 實測：共用快取裡有一個叫 misc 的 bundle，混著好幾支影片的 956 句。
  {
    console.log('\n──── 沒有影片編號的請求 ────\n');
    kv.clear(); cacheStore.clear(); modelCalls = 0;
    const rs = await Promise.all(['misc', '', null].map((cid, i) =>
      A.handleTranslate(req({ cid, lines: LINES, urgent: i === 0 }), env, '1.2.3.4', { ...auth, installId: 'nocid-' + i })));
    const bodies = await Promise.all(rs.map((r) => r.json()));
    const gotAll = bodies.filter((b) => b && b.lines && Object.keys(b.lines).length === LINES.length).length;
    const yielded = bodies.filter((b) => b && b.pendingElsewhere).length;
    const wrote = [...kv.keys()].filter((k) => /misc|^sub|^bundle|^b:/i.test(k));
    gotAll === 3 && !yielded
      ? ok('沒有影片編號：每個人照樣拿到完整譯文，沒有人被要求讓路（不同影片不可以互相讓路）')
      : fail('沒有影片編號的請求拿不到譯文或被要求讓路', `${gotAll}/3、讓路 ${yielded}`);
    !wrote.length
      ? ok('沒有影片編號：譯文沒有寫進共用快取（不再產生 misc 這種混雜的 bundle）')
      : fail('沒有影片編號的譯文被寫進共用快取', wrote.join('、'));
  }

  console.log(errors.length ? `\n❌ ${errors.length} 項未通過` : '\n✅ 直播並發行為全部符合預期');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log('❌ 測試本身出錯：' + e.message); process.exit(1); });
