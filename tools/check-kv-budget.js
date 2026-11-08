#!/usr/bin/env node
/**
 * KV 寫入預算（2026-09-23，R15 直播實測前新增）
 *
 * **免費方案每天只有 1,000 次 KV 寫入**（坑 #10，已經撞過一次）。
 * 直播時 `/v1/translate` 每批只有 3 句左右（提前量短、批次湊不大），
 * 而以前**每個有新句子的請求就寫一次**：一小時約 370 次、兩小時的正賽單人超過 700 次。
 * 撞牆之後所有寫入回 429——使用者自己看得到字幕，**但譯文存不進共用快取**，
 * 下一個人要重新付費，而且完全不報錯。
 *
 * 所以寫入改成合併：同一支影片累積滿 60 句或超過 15 秒才寫一次。
 * 這支測試釘住三件事：
 *
 *   1. 直播那種「每次 3 句」的請求，KV 寫入次數要遠低於請求次數
 *   2. **還在緩衝裡的句子不可以被重翻**——那會用「省 KV」換來更貴的模型費用
 *   3. 翻譯失敗時，已經翻好的要立刻寫出去（那個請求已經出錯，不要再賭下一次）
 *
 * 用法：node tools/check-kv-budget.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const vm = require('vm');
const root = path.join(__dirname, '..');

let failed = 0;
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { failed++; console.log('❌ ' + m); };

let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

function makeEnv(opts) {
  const o = opts || {};
  const kv = new Map();
  // 依 key 前綴分開算。整體 put 數含「速率限制的取樣寫入」（每 10 次請求隨機寫 1 次），
  // 那是有意的取樣、每次跑都不一樣——混在一起算會讓這支測試時綠時紅。
  const counts = { put: 0, get: 0, list: 0, bundle: 0, rate: 0, stats: 0 };
  // 模擬 KV 寫入失敗（配額用完就是這樣）。設成正則就讓符合的鍵一律丟例外。
  let failPut = o.failPut || null;
  let NOW = Date.parse('2026-09-24T12:00:00Z');
  let modelCalls = 0;
  let translatedLines = 0;
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  }
  const sandbox = {
    crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
    Response: class {
      constructor(b, i) { this.body = b; this.status = 200; Object.assign(this, i || {}); this.ok = this.status < 300; }
      async json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
    },
    Request: class {}, URL, console: { log() {}, warn() {}, error() {} },
    Date: FakeDate, Math, JSON, Map, Set, Promise, RegExp, Error,
    Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
    caches: { default: { async match() { return undefined; }, async put() {}, async delete() {} } },
    fetch: async (url, init) => {
      if (!String(url).includes('anthropic')) throw new Error('未預期的網路呼叫：' + url);
      modelCalls++;
      const body = JSON.parse(init.body);
      const text = JSON.stringify(body.messages);
      const nums = [...text.matchAll(/(\d+)\.\s/g)].map((m) => Number(m[1]));
      const n = nums.length ? Math.max(...nums) : 1;
      translatedLines += n;
      if (o.failAt && modelCalls >= o.failAt) {
        return { ok: false, status: 529, async text() { return 'overloaded'; }, async json() { return {}; } };
      }
      return {
        ok: true, status: 200,
        async json() {
          return {
            content: [{ type: 'text', text: Array.from({ length: n }, (_, i) => `${i + 1}. 中文譯文${i + 1}`).join('\n') }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 50, output_tokens: 60, cache_read_input_tokens: 4800, cache_creation_input_tokens: 0 },
          };
        },
      };
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__api = { handleTranslate, bundleKey, flushStats, statsSummary, statsKey, withMeter, listBundleMeta };', sandbox);
  const env = {
    TOKEN_SECRET: 'test', ANTHROPIC_API_KEY: 'sk-test', DAILY_USD_CAP: '999',
    SUBS: {
      get: async (k) => { counts.get++; return kv.has(k) ? kv.get(k) : null; },
      put: async (k, v) => {
        if (failPut && failPut.test(k)) throw new Error('KV put failed: daily limit exceeded');
        counts.put++;
        if (k.startsWith('bundle:')) counts.bundle++;
        else if (k.startsWith('rl:') || k.startsWith('rate:')) counts.rate++;
        else if (k.startsWith('stats:') || k.startsWith('ustats:')) counts.stats++;
        kv.set(k, v);
      },
      delete: async (k) => { kv.delete(k); },
      list: async (opt) => {
        counts.list++;
        const pre = (opt && opt.prefix) || '';
        return {
          keys: [...kv.keys()].filter((k) => k.startsWith(pre)).map((name) => ({ name, metadata: {} })),
          list_complete: true,
        };
      },
    },
  };
  return {
    api: sandbox.__api, env, kv, counts, modelCalls: () => modelCalls, translatedLines: () => translatedLines,
    advance: (ms) => { NOW += ms; },
    setFailPut: (re) => { failPut = re; },
    // 直播的形狀：每次請求 3 句，而且句子都是新的
    async translate(cid, lines, envOverride) {
      const req = { headers: { get: () => null }, async json() { return { cid, lines, urgent: true, slug: '/detail/' + cid + '/2026-azerbaijan-grand-prix' }; } };
      return sandbox.__api.handleTranslate(req, envOverride || env, '1.2.3.4', { ok: true, installId: 'viewer', legacy: true });
    },
  };
}

// 最後一批還留在緩衝裡是正常的（下一個請求或時間到才會寫出去）
const BUF_TOLERANCE = 130;

(async () => {
  // ---- 1. 直播的寫入量 ----
  {
    const E = makeEnv();
    const N = 60;                      // 60 次請求 × 3 句 ＝ 180 句（約 10 分鐘的直播）
    for (let i = 0; i < N; i++) {
      await E.translate('9000000015', [`Live line ${i} A`, `Live line ${i} B`, `Live line ${i} C`]);
    }
    // 每 60 句寫一次 → 180 句約 3 次
    E.counts.bundle <= 5
      ? ok(`直播 ${N} 次請求（180 句）只寫了 ${E.counts.bundle} 次 bundle（其餘 ${E.counts.put - E.counts.bundle} 次是統計與速率限制的取樣寫入）`)
      : bad(`直播 ${N} 次請求就寫了 ${E.counts.bundle} 次 bundle —— 兩小時的正賽會超過免費方案的每日上限（1,000 次），`
        + '撞牆之後譯文存不進共用快取而且不報錯');
    // 總量也要看：取樣寫入本身也算在同一個額度裡
    E.counts.put <= 25
      ? ok(`同一段時間的 KV 寫入總量 ${E.counts.put} 次（含取樣），一場兩小時的正賽外推約 ${Math.round(E.counts.put * 12)} 次`)
      : bad(`KV 寫入總量 ${E.counts.put} 次偏高，外推一場正賽約 ${Math.round(E.counts.put * 12)} 次`);
  }

  // ---- 2. 還在緩衝裡的句子不可以被重翻 ----
  {
    const E = makeEnv();
    const lines = ['Same line one', 'Same line two', 'Same line three'];
    await E.translate('9000000016', lines);
    const after1 = E.modelCalls();
    await E.translate('9000000016', lines);          // 另一個觀眾送同樣的句子
    const after2 = E.modelCalls();
    after1 === 1 && after2 === 1
      ? ok('還沒寫進 KV 的句子，第二個請求直接從緩衝拿到（沒有重翻）')
      : bad(`緩衝裡的句子被重翻了（第一次 ${after1} 次呼叫、第二次 ${after2} 次）`
        + ' —— 省了 KV 卻多付模型的錢，比原本更糟');
  }

  // ---- 3. 時間到就要寫出去（不是無限期留在記憶體） ----
  //  ⚠️ 門檻從原始碼讀，不要寫死——調整門檻時這一項才會跟著動
  {
    const maxMs = Number((readBackend()
      .match(/const BUNDLE_BUF_MAX_MS = (\d+);/) || [])[1]);
    const E = makeEnv();
    await E.translate('9000000017', ['Tick line a', 'Tick line b']);
    const before = E.counts.put;
    E.advance(maxMs + 5000);
    await E.translate('9000000017', ['Tick line c']);
    const wrote = E.counts.put > before;
    const saved = JSON.parse(E.kv.get('bundle:9000000017') || '{}');
    wrote && Object.keys(saved.lines || {}).length >= 2
      ? ok(`超過 ${maxMs / 1000} 秒就寫出去（不會無限期留在記憶體裡，isolate 被回收最多丟這麼多）`)
      : bad(`超過 ${maxMs / 1000} 秒仍沒有寫出去（寫入 ${E.counts.put - before} 次、KV 裡 ${Object.keys(saved.lines || {}).length} 句）`);
  }

  // ---- 4. 翻譯失敗時，已經翻好的要立刻寫出去 ----
  {
    const E = makeEnv({ failAt: 2 });                  // 第二批失敗
    const many = Array.from({ length: 25 }, (_, i) => `Fail case line ${i}`);   // 兩批（BATCH_MAX 20）
    const res = await E.translate('9000000018', many);
    const saved = JSON.parse(E.kv.get('bundle:9000000018') || '{}');
    res.status === 502 && Object.keys(saved.lines || {}).length >= 20
      ? ok(`翻譯中途失敗（502）：已經翻好的 ${Object.keys(saved.lines).length} 句立刻寫進 KV，沒有留在記憶體裡賭下一次`)
      : bad(`失敗時已經翻好的句子沒有寫出去（狀態 ${res.status}、KV 裡 ${Object.keys(saved.lines || {}).length} 句）`);
  }

  // ---- 5. 一整場直播的寫入量（**時鐘要真的走**）----
  //
  // ⚠️ 2026-09-23 亞塞拜然暖身實測：40 分鐘寫了 390 次 KV，其中約 340 次是 bundle。
  //    上面第 1 項完全沒抓到——它在固定時鐘下連續送 60 個請求，只驗到「滿 N 句才寫」，
  //    而真正的主因是「超過 N 秒就寫」：直播每 3~4 秒一個請求，那條規則幾乎每幾個請求就觸發一次。
  //    **量測要模擬真實的節奏，不能只模擬真實的量。**
  {
    const E = makeEnv();
    const GAP_MS = 4000;                 // 直播大約每 4 秒一批
    const MINUTES = 40;
    const N = Math.round((MINUTES * 60000) / GAP_MS);
    for (let i = 0; i < N; i++) {
      await E.translate('9000000019', [`Race line ${i} A`, `Race line ${i} B`, `Race line ${i} C`]);
      E.advance(GAP_MS);
    }
    // 單一 isolate 的預期：40 分鐘 ÷ 90 秒 ≈ 27 次。線上會再乘上 isolate 數（實測約 2）
    const perRace = Math.round((E.counts.bundle / MINUTES) * 120 * 2);   // 外推兩小時、兩個 isolate
    E.counts.bundle <= 40
      ? ok(`${MINUTES} 分鐘的直播只寫 ${E.counts.bundle} 次 bundle（外推一場兩小時正賽、兩個 isolate 約 ${perRace} 次）`)
      : bad(`${MINUTES} 分鐘的直播寫了 ${E.counts.bundle} 次 bundle，外推一場正賽約 ${perRace} 次`
        + ' —— 免費方案每天只有 1,000 次，這樣會撞牆而且不報錯');
    const saved = JSON.parse(E.kv.get('bundle:9000000019') || '{}');
    Object.keys(saved.lines || {}).length >= N * 3 - BUF_TOLERANCE
      ? ok(`譯文有確實寫進 KV（${Object.keys(saved.lines).length} 句，最後一批還在緩衝裡是正常的）`)
      : bad(`寫進 KV 的句子只有 ${Object.keys(saved.lines || {}).length} 句，應該接近 ${N * 3} 句 —— 合併緩衝把譯文弄丟了`);
  }

  // ---- 6. 計量器不可以餵自己（2026-09-24 實測後新增） ----
  //
  // 實測：整天沒有人看直播，KV 仍以每分鐘約一次爬升（411 分鐘 381 次），
  // 當天 21:17 撞到 1,000 的天花板。原因是「後台讀之前先落地」→ 落地自己寫一次 KV
  // → 那次寫入被自己的計量器算到 → 下一次輪詢看到「還有事要做」→ 再落地……
  //
  // ⚠️ 這支一定要用 withMeter 包過的 env。用原始 env 跑，kvOps 永遠是 0，
  //    程式再怎麼壞這支都是綠的（這正是 9/24 另外兩個假綠燈的同一種錯）。
  {
    const E = makeEnv();
    const menv = E.api.withMeter(E.env);
    await E.translate('9000000020', ['Meter test A', 'Meter test B', 'Meter test C'], menv);
    await E.api.flushStats(menv);
    const base = E.counts.put;

    const MIN = 30;
    for (let i = 0; i < MIN; i++) { E.advance(60000); await E.api.flushStats(menv); }
    const idle = E.counts.put - base;
    idle === 0
      ? ok(`完全沒有活動的 ${MIN} 分鐘，後台輪詢 ${MIN} 次一共寫了 0 次 KV`)
      : bad(`完全沒有活動的 ${MIN} 分鐘，光是後台輪詢就寫了 ${idle} 次 KV`
        + `（外推一整天 ${Math.round((idle / MIN) * 1440)} 次／上限 1,000）—— 計量器在餵自己`);

    // ⚠️ 但帳要記得準。**不可以用「不計自己的寫入」來止血**——
    //    那是讓計量器說謊，後台會顯示一個永遠偏低的數字，而這個專案的天花板就是它。
    await E.translate('9000000020', ['Meter test D', 'Meter test E', 'Meter test F'], menv);
    await E.api.flushStats(menv);
    const day = JSON.parse(E.kv.get(E.api.statsKey()) || '{}');
    const rec = (day.__kv && day.__kv.put) || 0;
    // 最後一次落地自己的那幾次還在 carry 裡等下一輪記帳，所以容許差 2
    rec >= E.counts.put - 2
      ? ok(`KV 計數仍然誠實（記了 ${rec} 次，實際 ${E.counts.put} 次，差的是還沒記帳的最後一次落地）`)
      : bad(`KV 計數少記了：記 ${rec} 次、實際 ${E.counts.put} 次 —— 用「不計自己」止血等於讓計量器說謊`);
  }

  // ---- 7. 後台開著「即時」分頁，不可以把額度刷爆（2026-09-24 實測後新增） ----
  //
  // 後台每 15 秒自動更新一次，而「讀之前先落地」每次都是一次 KV 寫入。
  // 第 6 項（carry_）解掉的是「完全沒有活動時也在寫」；**直播當下是真的有新資料的**，
  // 那條路徑照樣每 15 秒寫一次 —— 一場兩小時的正賽光是有人看著後台就 480 次。
  {
    const E = makeEnv();
    const menv = E.api.withMeter(E.env);
    await E.translate('9000000021', ['Dash A', 'Dash B', 'Dash C'], menv);
    const before = E.counts.put;
    const TICKS = 40;                 // 40 × 15 秒 = 10 分鐘，與後台的 LV_TICK_MS 一致
    for (let i = 0; i < TICKS; i++) { E.advance(15000); await E.api.statsSummary(menv, 1); }
    const w = E.counts.put - before;
    const perRace = Math.round((w / 10) * 120 * 2);   // 外推兩小時、兩個 isolate
    w === 0
      ? ok(`後台每 15 秒刷新一次、刷了 ${TICKS} 次（10 分鐘），KV 寫入 0 次`)
      : bad(`後台每 15 秒刷新一次，10 分鐘就寫了 ${w} 次（外推一場正賽、兩個 isolate 約 ${perRace} 次）`
        + ' —— 光是把後台開著就會把每日額度刷爆');

    // 而且要看得到還沒落地的那一段，否則「不寫」是靠犧牲正確性換來的
    const sum = await E.api.statsSummary(menv, 1);
    sum.total.translated >= 3
      ? ok(`不落地也看得到最新的量（讀到 ${sum.total.translated} 句，含記憶體裡還沒寫出去的）`)
      : bad(`讀到的句數是 ${sum.total.translated} —— 不寫是做到了，但數字變成舊的`);
  }

  // ---- 8. list 也有每日 1,000 次，同樣不可以被後台刷爆（2026-09-25 稽核） ----
  //
  // 第 7 項修好了「讀取觸發寫入」，但同一條路徑（liveSnapshot → harvestCoverage →
  // listBundleMeta）每次還會列舉整個 bundle: 前綴。9/24 實測 1,596 次／上限 1,000。
  // **修一種資源的用量時要把同一條路徑上的其他資源一起看。**
  {
    const E = makeEnv();
    const menv = E.api.withMeter(E.env);
    await E.translate('9000000022', ['List A', 'List B', 'List C'], menv);
    const before = E.counts.list;
    const TICKS = 40;                       // 40 × 15 秒 = 10 分鐘
    for (let i = 0; i < TICKS; i++) { E.advance(15000); await E.api.listBundleMeta(menv); }
    const n = E.counts.list - before;
    const perDay = Math.round((n / 10) * 1440);
    n <= 3
      ? ok(`後台每 15 秒刷新、刷了 ${TICKS} 次（10 分鐘），只列舉 ${n} 次（外推一天 ${perDay} 次）`)
      : bad(`後台每 15 秒刷新，10 分鐘就列舉 ${n} 次（外推一天 ${perDay} 次／上限 1,000）`
        + ' —— list 的額度會被後台刷爆');
  }

  // ---- 9. KV 寫入失敗，已經付過錢的資料不可以就這樣消失（2026-09-25 稽核） ----
  //
  // 實證：9/24 撞到上限那天，stats 記 4,381 句、ustats 記 5,575 句，差了 1,194 句。
  // 原因是兩者都「先清空再寫入」，寫失敗時清掉的那一段就永遠沒了。
  {
    const E = makeEnv({ failPut: /^stats:/ });
    const menv = E.api.withMeter(E.env);
    await E.translate('9000000023', ['Lost A', 'Lost B', 'Lost C'], menv);
    try { await E.api.flushStats(menv); } catch (e) { /* 預期會丟 */ }
    E.setFailPut(null);                     // 隔天額度重算
    await E.api.flushStats(menv);
    const day = JSON.parse(E.kv.get(E.api.statsKey()) || '{}');
    const t = Object.entries(day).filter(([c]) => c !== '__kv')
      .reduce((a, [, r]) => a + (r.translated || 0), 0);
    t >= 3
      ? ok(`KV 寫入失敗後資料有留著，額度恢復時補記回去（${t} 句）`)
      : bad(`KV 寫入失敗，那 3 句就永遠消失了（最後只記到 ${t} 句）—— 那是已經付過錢的模型呼叫`);

    // ⚠️ **KV 計數也要一起還原，而且要單獨驗。**（2026-09-25）
    //    第一版的還原程式碼把快照取在歸零之後，抓到的永遠是 0——
    //    看起來有還原、實際上什麼都沒還，而上面那條只驗句數所以是綠的。
    //    「撞牆那天到底寫了幾次」正是撞牆時最需要的數字。
    const kvPut = (day.__kv && day.__kv.put) || 0;
    kvPut > 0
      ? ok(`寫入失敗期間的 KV 計數也還原了（記到 ${kvPut} 次）`)
      : bad('寫入失敗後 KV 計數是 0 —— 還原程式碼把快照取在歸零之後，等於什麼都沒還');
  }

  // ---- 10. 寫共用快取失敗，不可以讓使用者的翻譯請求跟著失敗（2026-09-25 稽核） ----
  //
  // 譯文已經翻好、錢已經付了，使用者要的東西就在手上。快取寫不進去只是
  // 「下一個人要重付」，不該升級成「這個人現在就看不到字幕」。
  // 9/24 21:17 撞到上限之後，這條路徑真的會回 500。
  {
    const E = makeEnv({ failPut: /^bundle:/ });
    const menv = E.api.withMeter(E.env);
    let last = null;
    let threw = null;
    try {
      // ⚠️ 要用「少量請求、每次多句」湊滿緩衝：同一分鐘內送幾十個請求會先被
      //    速率限制擋掉（E32），那時測到的是限流、不是我們要驗的東西。
      for (let i = 0; i < 6; i++) {         // 6 × 25 = 150 句 > 120，一定會觸發緩衝寫出
        const lines = Array.from({ length: 25 }, (_, j) => `Fail ${i} line ${j}`);
        last = await E.translate('9000000024', lines, menv);
        E.advance(20000);
      }
    } catch (e) { threw = e; }
    let body = null;
    try { body = JSON.parse(last && last.body); } catch (e) { body = null; }
    // 成功的回應是 { cid, lines, requested, cached, translated, … }，沒有 ok 欄位
    !threw && body && body.lines && Object.keys(body.lines).length >= 3
      ? ok('共用快取寫不進去時，使用者仍然拿得到這一批譯文（不會變成 500）')
      : bad(`共用快取寫不進去就讓整個請求失敗了（${threw ? '丟出 ' + threw.message : '回應 ' + JSON.stringify(body).slice(0, 80)}）`
        + ' —— 模型成功了，使用者卻看不到字幕');
  }

  console.log('');
  if (failed) { console.log(`❌ KV 寫入預算有 ${failed} 項未通過`); process.exit(1); }
  console.log('✅ KV 寫入量在免費方案的預算內，而且沒有因此多花模型的錢');
})();
