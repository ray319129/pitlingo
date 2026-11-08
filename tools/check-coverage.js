#!/usr/bin/env node
/**
 * 分類、標題與收割覆蓋率的實測。
 *
 * 為什麼需要：這一整組的失敗全都是**靜默的**，而且我們已經各踩過一次——
 *
 *   1. `mergeWrite` 重讀一份乾淨的 bundle 再寫回，於是呼叫端在快照上設的
 *      `slug` 被丟掉。線上 11 場直播、24,127 句譯文全部分不了類，
 *      後台看起來完全正常（2026-09-14 查出來）。
 *   2. 比利時的關鍵字 `spa` 用 `includes` 會命中 `2025-spanish-grand-prix`，
 *      而 R10 排在 R14 前面——西班牙站的影片全部被歸進比利時。
 *      舊版註解就寫著「用 `usa` 會誤中 `usual`」，然後下面第十行做了同一件事。
 *
 * 兩個都不報錯、不影響任何使用者、也不會讓別的檢查變紅。
 *
 * 用法：node tools/check-coverage.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const vm = require('vm');
const root = path.join(__dirname, '..');

const errors = [];
const ok = (label) => console.log('✅ ' + label);
const fail = (label, detail) => {
  errors.push(label + (detail ? '：' + detail : ''));
  console.log('❌ ' + label + (detail ? '：' + detail : ''));
};

// ⚠️ **一定要以嚴格模式載入**（坑 #37）。vm.runInContext 跑的是 script＝非嚴格，
//    而真正的 Worker 是 ESM＝嚴格；對未宣告的變數賦值在這裡只會建立全域。
let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

const sandbox = {
  crypto: require('crypto').webcrypto,
  TextEncoder, TextDecoder, btoa, atob,
  Response: class { constructor(b, i) { this.body = b; Object.assign(this, i); } },
  Request: class {},
  URL, console, Date, Math, JSON, Map, Set, Promise, RegExp, Error,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite,
  fetch: async () => { throw new Error('測試不該打真的網路'); },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { slugKeyOf, slugMatchesGp, gpSlugHints, sessionTitle,'
  + ' sessionKind, harvestCoverage, harvestPlan, listBundleMeta, invalidateBundleMeta, mergeWrite, readBundle, writeBundle,'
  + ' gpList, gpId, REMOTE_CONFIG, MIN_LINES_PER_SEG, buildDigest, suspectMarked, verAtLeast, handlePostSubs,'
  + ' handleReportPatch, planLock };', ctx);
const A = sandbox.__api;
const CFG = A.REMOTE_CONFIG;

// ---------------------------------------------------------------------------
// 1) 每一站都要帶英文關鍵字
//
// ⚠️ 關鍵字現在長在賽事記錄上（`g.slugs`），不是另一張以輪次為鍵的表。
//    少一站不會報錯，只會讓那一站的影片整季歸不了類。
// ---------------------------------------------------------------------------
{
  const missing = A.gpList(CFG).filter((g) => !Array.isArray(g.slugs) || !g.slugs.length);
  missing.length
    ? fail('有賽事沒有英文關鍵字', missing.map((g) => 'R' + g.r + ' ' + g.name).join('、'))
    : ok(`${A.gpList(CFG).length} 站都帶了英文關鍵字（slugs）`);
}

// ---------------------------------------------------------------------------
// 2) 關鍵字不可以互相踩到
//
// 每一站用自己的關鍵字合成典型 slug，確認**只會**對到自己那一站。
// 這一項就是 `spa` / `spanish` 那個 bug 的守門：把比對改回 `includes`
// 會讓 `2026-spanish-grand-prix` 同時對到 R10 與 R14，這裡直接變紅。
// ---------------------------------------------------------------------------
{
  const races = A.gpList(CFG);
  const season = CFG.seasonYear;
  const bad = [];
  for (const g of races) {
    for (const kw of A.gpSlugHints(g)) {
      for (const shape of [`/detail/1/${season}-${kw}-grand-prix`, `/detail/1/${season}-${kw}-gp-practice-1`]) {
        const key = A.slugKeyOf(shape);
        const hits = races.filter((x) => A.slugMatchesGp(key, x));
        if (hits.length !== 1 || hits[0].r !== g.r) {
          bad.push(`${shape} → ${hits.length ? hits.map((h) => 'R' + h.r).join('+') : '沒對到'}（應該是 R${g.r}）`);
        }
      }
    }
  }
  bad.length
    ? fail('英文關鍵字互相踩到', bad.slice(0, 6).join('；'))
    : ok(`關鍵字彼此不衝突（${races.reduce((a, g) => a + A.gpSlugHints(g).length, 0)} 個關鍵字 × 2 種形態）`);
}

// ---------------------------------------------------------------------------
// 3) 實際踩過的那幾筆，逐筆釘住
//
// ⚠️ 這些是**線上真的存在的 slug**（2026-09-14 從後台抓的 126 支裡挑出來的），
//    不是想出來的例子。想出來的例子會漏掉真實資料的形狀。
// ---------------------------------------------------------------------------
{
  const CASES = [
    ['/detail/1000009032/2025-spanish-grand-prix', 14],   // ← 舊版被 `spa` 搶去 R10
    ['/detail/1000007866/2024-spanish-grand-prix', 14],   // ← 同上
    ['/detail/1000009078/2025-belgian-grand-prix', 10],
    ['/detail/1000010316/2026-belgian-gp-practice-1', 10],
    ['/detail/1000010185/2026-australian-grand-prix', 1],
    ['/detail/1000010283/2026-austrian-gp-practice-1', 8],
    ['/detail/1000010271/2026-barcelona-gp-practice-1', 7],
    ['/detail/1000010280/weekend-warm-up-barcelona-catalunya', 7],
    ['/detail/1000010366/2026-madrid-gp-practice-1', 14],
    ['/detail/1000010801/2026-austrian-gp-psc-practice', 8],
  ];
  const bad = [];
  for (const [slug, want] of CASES) {
    const key = A.slugKeyOf(slug);
    const hit = A.gpList(CFG).find((g) => A.slugMatchesGp(key, g));
    if (!hit || hit.r !== want) bad.push(`${slug} → ${hit ? 'R' + hit.r : '沒對到'}（應為 R${want}）`);
  }
  bad.length ? fail('線上真實 slug 分類錯誤', bad.join('；')) : ok(`${CASES.length} 筆線上真實 slug 都分對了`);
}

// ---------------------------------------------------------------------------
// 4) 中文場次名
//
// ⚠️ **標題不必向 F1TV 要**——slug 本身就是標題，而且用戶端每次請求都送上來。
//    線上 110 支有 slug 的影片只有 44 種形態、完全規則。
// ---------------------------------------------------------------------------
{
  const CASES = [
    ['/detail/1/2026-australian-gp-practice-1', '第一次自由練習'],
    ['/detail/1/2026-australian-gp-practice-2', '第二次自由練習'],
    ['/detail/1/2026-australian-gp-practice-3', '第三次自由練習'],
    ['/detail/1/2026-chinese-gp-sprint-qualifying', '衝刺排位賽'],
    ['/detail/1/2026-chinese-gp-sprint', '衝刺賽'],
    ['/detail/1/2026-chinese-gp-qualifying', '排位賽'],
    ['/detail/1/2026-australian-grand-prix', '正賽'],
    ['/detail/1/weekend-warm-up-australia', '賽前暖身'],
    ['/detail/1/2026-austrian-gp-psc-race', '保時捷超級盃・正賽'],
    ['/detail/1/2026-canadian-gp-f1a-feature-race', 'F1 Academy・主賽'],
    ['/detail/1/2026-chinese-gp-f1a-race-2', 'F1 Academy・第二回合'],
    ['/detail/1/2026-pre-season-testing-2-day-1-session-1', '季前測試 2・第 1 天・第 1 節'],
    ['/detail/1/2026-pre-season-testing-1-day-3', '季前測試 1・第 3 天'],
    // 舊賽季的重播要標出年份，否則後台會以為今年多翻了一堆
    ['/detail/1/2024-australian-grand-prix', '2024 正賽'],
    ['/detail/1/2025-japanese-grand-prix', '2025 正賽'],
  ];
  const bad = [];
  for (const [slug, want] of CASES) {
    const got = A.sessionTitle(slug, CFG.seasonYear);
    if (got !== want) bad.push(`${slug} → 「${got}」（應為「${want}」）`);
  }
  bad.length ? fail('中文場次名推導錯誤', bad.join('；')) : ok(`${CASES.length} 種 slug 形態都推得出中文場次名`);

  // 衝刺排位賽必須排在排位賽前面，否則會被認成排位賽（freeTier 也踩過同一件事）
  A.sessionTitle('/detail/1/2026-chinese-gp-sprint-qualifying', 2026) === '衝刺排位賽'
    ? ok('sprint-qualifying 沒有被 qualifying 先吃掉')
    : fail('sprint-qualifying 被 qualifying 先吃掉了');
}

// ---------------------------------------------------------------------------
// 5) 場次代碼要對得上賽程的字彙
//
// ⚠️ 賽程把衝刺賽週的唯一一場練習叫「唯一自由練習」，而 slug 一律是
//    `practice-1`——**用中文名去比對會漏**，所以覆蓋率用的是代碼不是名稱。
// ---------------------------------------------------------------------------
{
  const CASES = [
    ['/detail/1/2026-chinese-gp-practice-1', 'fp1'],
    ['/detail/1/2026-chinese-gp-sprint-qualifying', 'sq'],
    ['/detail/1/2026-chinese-gp-sprint', 'sprint'],
    ['/detail/1/2026-chinese-gp-qualifying', 'quali'],
    ['/detail/1/2026-chinese-grand-prix', 'race'],
    ['/detail/1/weekend-warm-up-china', 'warmup'],
    // 支援賽事與舊賽季重播都不算本季覆蓋率
    ['/detail/1/2026-austrian-gp-psc-race', ''],
    ['/detail/1/2026-canadian-gp-f1a-feature-race', ''],
    ['/detail/1/2024-australian-grand-prix', ''],
    ['/detail/1/2025-japanese-grand-prix', ''],
    // 節目與精華不是正式場次（2026-09-17：它們含 -qualifying-／-sprint-，以前被當成排位賽／衝刺賽）
    ['/detail/1000010347/pre-qualifying-show-netherlands', ''],
    ['/detail/1000010348/post-qualifying-show-netherlands', ''],
    ['/detail/1000010344/pre-sprint-show-netherlands', ''],
    ['/detail/1000010345/post-sprint-show-netherlands', ''],
    ['/detail/1000010350/pre-race-show-netherlands', ''],
    ['/detail/1000011072/qualifying-highlights-netherlands', ''],
    ['/detail/1000011067/sprint-qualifying-highlights-netherlands', ''],
    ['/detail/1000011069/sprint-highlights-netherlands', ''],
    ['/detail/1000011078/race-in-30-netherlands', ''],
    ['/detail/1000010205/post-qualifying-show-japan', ''],
    ['/detail/1000010343/2026-dutch-gp-sprint-qualifying', 'sq'],
  ];
  const bad = [];
  for (const [slug, want] of CASES) {
    const got = A.sessionKind(A.slugKeyOf(slug), 2026);
    if (got !== want) bad.push(`${slug} → 「${got}」（應為「${want || '（不算）'}」）`);
  }
  bad.length ? fail('場次代碼判斷錯誤', bad.join('；')) : ok(`${CASES.length} 種 slug 都對得上賽程的場次代碼`);

  // 賽程裡出現過的每一種 k，都要有辦法從 slug 判斷得出來——
  // 少一種就是那個場次永遠顯示「未收割」，而且不會報錯。
  const kinds = new Set();
  for (const g of A.gpList(CFG)) for (const s of g.sessions || []) kinds.add(s.k);
  const reachable = new Set(['fp1', 'fp2', 'fp3', 'quali', 'sq', 'sprint', 'race']);
  const unreachable = [...kinds].filter((k) => !reachable.has(k));
  unreachable.length
    ? fail('賽程有判斷不出來的場次代碼', unreachable.join('、') + ' —— 那些場次會永遠顯示未收割')
    : ok(`賽程用到的 ${kinds.size} 種場次代碼都判斷得出來`);
}

// ---------------------------------------------------------------------------
// 5.5) 每一個 mergeWrite 呼叫端都要把 slug 傳進去
//
// ⚠️ 下一項是直接呼叫 mergeWrite 驗行為，**抓不到「呼叫端忘了傳 slug」**——
//    而原本的 bug 正是這種形狀：函式本身沒問題，資料在呼叫端就掉了。
//    這裡用靜態掃描補上那個缺口。
// ---------------------------------------------------------------------------
{
  const calls = [...src.matchAll(/\bmergeWrite\(([^)]*)\)/g)]
    .map((m) => m[1].trim())
    .filter((a) => !a.startsWith('env, cid, added, slug'));   // 宣告那一行不算
  const bad = calls.filter((a) => a.split(',').length < 4);
  bad.length
    ? fail('有 mergeWrite 呼叫端沒有傳 slug', bad.join(' / ') + ' —— 那條路的影片會分不了類')
    : ok(`${calls.length} 個 mergeWrite 呼叫端都傳了 slug`);
}

// ---------------------------------------------------------------------------
// 6) mergeWrite 一定要把 slug 寫進 KV
//
// ⚠️ **這一項就是那個 bug 的守門。** 把 `if (needSlug) fresh.slug = want;`
//    拿掉、或把呼叫端的 `body.slug` 拿掉，這裡立刻變紅。
// ---------------------------------------------------------------------------
function fakeKV(initial) {
  // 新的 KV ＝ 新的 isolate。後端的 bundle 清單有 5 分鐘的記憶體快取，
  // 不清掉的話下一個情境會讀到上一個情境的資料（第一次加快取時就是這樣紅的）。
  A.invalidateBundleMeta();
  const store = new Map(Object.entries(initial || {}));
  const meta = new Map();
  return {
    puts: 0,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, opts) { this.puts++; store.set(k, v); meta.set(k, (opts && opts.metadata) || {}); },
    async list({ prefix, cursor }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix || ''))
        .map((name) => ({ name, metadata: meta.get(name) || {} }));
      return { keys, list_complete: true, cursor: null };
    },
    _raw: store,
    _meta: meta,
  };
}

(async () => {
  {
    const SUBS = fakeKV();
    const env = { SUBS };
    // 直播那條路：新影片、有新句子、帶著 slug
    await A.mergeWrite(env, '999', { a: '甲' }, '/detail/999/2026-dutch-grand-prix');
    const b = JSON.parse(await SUBS.get('bundle:999'));
    const md = SUBS._meta.get('bundle:999') || {};
    (b.slug === '/detail/999/2026-dutch-grand-prix' && md.slug === b.slug)
      ? ok('mergeWrite 會把 slug 寫進 bundle 與 KV metadata（直播那條路的分類靠它）')
      : fail('mergeWrite 沒有寫 slug', `bundle.slug=${JSON.stringify(b.slug)} metadata.slug=${JSON.stringify(md.slug)}`);

    // 全部命中快取（沒有新句子）時也要補得到 slug——那是最常見的情況
    const SUBS2 = fakeKV({ 'bundle:888': JSON.stringify({ lines: { a: '甲' }, segCount: 0 }) });
    await A.mergeWrite({ SUBS: SUBS2 }, '888', {}, '/detail/888/2026-italian-grand-prix');
    const b2 = JSON.parse(await SUBS2.get('bundle:888'));
    b2.slug === '/detail/888/2026-italian-grand-prix'
      ? ok('整批命中快取時也補得到 slug')
      : fail('整批命中快取時沒有補 slug', JSON.stringify(b2.slug));

    // 但已經有 slug、也沒有新句子時**不可以寫 KV**（寫入是天花板，坑 #10）
    const SUBS3 = fakeKV({ 'bundle:777': JSON.stringify({ lines: { a: '甲' }, slug: '/detail/777/x', segCount: 0 }) });
    await A.mergeWrite({ SUBS: SUBS3 }, '777', {}, '/detail/777/x');
    SUBS3.puts === 0
      ? ok('沒有新句子也沒有 slug 要補時不寫 KV')
      : fail('每次請求都寫了一次 KV', `puts=${SUBS3.puts} —— 1,000/天的額度會被吃光`);

    // 先到先得：已有的 slug 不可以被後來的覆蓋
    const SUBS4 = fakeKV({ 'bundle:666': JSON.stringify({ lines: {}, slug: '/detail/666/real', segCount: 0 }) });
    await A.mergeWrite({ SUBS: SUBS4 }, '666', { b: '乙' }, '/detail/666/fake');
    JSON.parse(await SUBS4.get('bundle:666')).slug === '/detail/666/real'
      ? ok('既有的 slug 不會被用戶端送的覆蓋（先到先得）')
      : fail('用戶端送的 slug 覆蓋了既有的', '那是可以偽造的欄位');
  }

  // -------------------------------------------------------------------------
  // 7) 覆蓋率算得對
  // -------------------------------------------------------------------------
  {
    const SUBS = fakeKV();
    // R13 義大利（非衝刺賽週，5 個場次）只有兩支，其中一支標記完整
    await SUBS.put('bundle:a', '{}', { metadata: { n: 1200, seg: 900, slug: '/detail/a/2026-italian-gp-practice-1', at: 'x' } });
    await SUBS.put('bundle:b', '{}', { metadata: { n: 900, seg: 0, slug: '/detail/b/2026-italian-grand-prix', at: 'x' } });
    // 舊賽季的重播不可以算進本季覆蓋率
    await SUBS.put('bundle:c', '{}', { metadata: { n: 700, seg: 500, slug: '/detail/c/2024-italian-gp-qualifying', at: 'x' } });
    // 支援賽事也不算
    await SUBS.put('bundle:d', '{}', { metadata: { n: 500, seg: 400, slug: '/detail/d/2026-italian-gp-psc-race', at: 'x' } });

    const cov = await A.harvestCoverage({ SUBS }, CFG);
    const r13 = cov.races.find((x) => x.round === 13);
    const bad = [];
    if (!r13) bad.push('找不到 R13');
    else {
      if (r13.need !== 5) bad.push(`need=${r13.need}（義大利是一般賽週，應為 5）`);
      if (r13.have !== 2) bad.push(`have=${r13.have}（應為 2，2024 的重播與保時捷盃都不算）`);
      if (r13.complete !== 1) bad.push(`complete=${r13.complete}（應為 1）`);
      const miss = r13.sessions.filter((s) => !s.lines).map((s) => s.kind).sort().join(',');
      if (miss !== 'fp2,fp3,quali') bad.push(`缺的場次是 ${miss}（應為 fp2,fp3,quali）`);
    }
    // 衝刺賽週的分母不同——寫死 5 的話這裡會紅
    const r2 = cov.races.find((x) => x.round === 2);
    if (r2 && r2.need !== 5) bad.push(`R2（衝刺賽週）need=${r2.need}`);
    if (r2 && !r2.sessions.some((s) => s.kind === 'sq')) bad.push('R2 沒有衝刺排位賽這個場次');

    bad.length ? fail('覆蓋率算錯', bad.join('；')) : ok('覆蓋率只算本季正規場次，分母取自賽程（衝刺賽週不同）');
  }

  // -------------------------------------------------------------------------
  // 7.5) 收割計畫：時機、順序、跳過
  //
  // ⚠️ 這一組全部要**控制時間**才驗得了。Date.now 直接換掉再還原——
  //    sandbox 與這支共用同一個 Date 物件，所以換一次兩邊都生效。
  // -------------------------------------------------------------------------
  {
    const realNow = Date.now;
    const at = (sec) => { Date.now = () => sec * 1000; };
    const restore = () => { Date.now = realNow; };

    // R14 西班牙（馬德里）的正賽時間，用來算「賽後一小時」
    const r14 = A.gpList(CFG).find((g) => g.r === 14);
    const race = r14.sessions.find((s) => s.k === 'race');
    const raceEnd = race.t + 7200;          // 正賽算兩小時
    const readyAt = raceEnd + 3600;         // 使用者指定：結束後一小時

    const bad = [];
    try {
      // (a) 還沒到時間：正賽不可以出現在待收割裡，要在「等待中」
      at(readyAt - 60);
      let p = await A.harvestPlan({ SUBS: fakeKV() }, CFG);
      let t14 = p.todo.find((t) => t.round === 14);
      if (t14 && t14.missing.includes('正賽')) bad.push('賽後未滿一小時就列進待收割');
      if (!(p.waiting || []).some((w) => w.round === 14 && w.label === '正賽')) {
        bad.push('賽後未滿一小時的正賽沒有列在「等待中」');
      }

      // (b) 到時間了：正賽要出現
      at(readyAt + 60);
      p = await A.harvestPlan({ SUBS: fakeKV() }, CFG);
      t14 = p.todo.find((t) => t.round === 14);
      if (!t14 || !t14.missing.includes('正賽')) bad.push('賽後超過一小時卻沒有列進待收割');

      // (c) 正在播：一律不可以收割
      at(race.t + 600);
      p = await A.harvestPlan({ SUBS: fakeKV() }, CFG);
      if (!p.liveNow) bad.push('場次正在播卻沒有擋下收割');
      else if (p.liveNow.label !== '正賽') bad.push('擋下了，但認錯場次：' + p.liveNow.label);

      // (c2) 開播前 15 分鐘也算——人已經在等著看了
      at(race.t - 600);
      p = await A.harvestPlan({ SUBS: fakeKV() }, CFG);
      if (!p.liveNow) bad.push('場次即將開播卻沒有擋下收割');

      // (d) 順序：正賽要排在練習賽前面（被打斷時留下的要是最有價值的）
      at(readyAt + 60);
      const paths = [
        '/detail/501/2026-madrid-gp-practice-1',
        '/detail/502/2026-madrid-grand-prix',
        '/detail/503/2026-madrid-gp-qualifying',
      ];
      p = await A.harvestPlan({ SUBS: fakeKV() }, CFG, paths);
      const got = (p.queue || []).map((x) => x.replace(/^\/detail\/\d+\/2026-madrid-/, ''));
      if (got.join(',') !== 'grand-prix,gp-qualifying,gp-practice-1') {
        bad.push('順序不是「正賽→排位→練習」：' + got.join(','));
      }

      // (e) 已經有完整快取的不可以再跑一次
      const SUBS = fakeKV();
      await SUBS.put('bundle:502', '{}', {
        metadata: { n: 2000, seg: 1200, slug: '/detail/502/2026-madrid-grand-prix', at: 'x' },
      });
      p = await A.harvestPlan({ SUBS }, CFG, paths);
      if ((p.queue || []).some((x) => x.includes('502'))) bad.push('已完整的影片還是排進了佇列');
      if ((p.skipped || {}).complete !== 1) bad.push('已完整的沒有被計為 complete');

      // (f) 舊賽季重播與支援賽事分開計數，兩者的處理方式不同
      p = await A.harvestPlan({ SUBS: fakeKV() }, CFG, [
        '/detail/601/2024-madrid-grand-prix',
        '/detail/602/2026-madrid-gp-psc-race',
      ]);
      if ((p.skipped || {}).otherSeason !== 1) bad.push('舊賽季沒有被計為 otherSeason');
      if ((p.skipped || {}).support !== 1) bad.push('支援賽事沒有被計為 support');
      if ((p.queue || []).length) bad.push('舊賽季／支援賽事被排進了佇列');
    } finally {
      restore();
    }

    bad.length
      ? fail('收割計畫錯誤', bad.join('；'))
      : ok('收割計畫：賽後一小時才收、播出期間不收、正賽優先、已完整與舊賽季不重跑');
  }

  // -------------------------------------------------------------------------
  // 8) 每日彙報不可以爆掉
  //
  // ⚠️ 它跑在 cron 裡，**沒有人會看到它的例外**。壞掉的症狀是「信突然不來了」，
  //    而那正好跟「一切正常」很難分辨——所以這裡要確認它在空資料庫上也活得下來。
  // -------------------------------------------------------------------------
  {
    try {
      const d = await A.buildDigest({ SUBS: fakeKV(), DAILY_USD_CAP: '5' }, CFG);
      const okShape = d && d.subject && Array.isArray(d.alerts) && Array.isArray(d.sections)
        && typeof d.text === 'string' && typeof d.html === 'string';
      okShape ? ok('每日彙報在空資料庫上也產得出來（cron 不會靜默死掉）')
        : fail('每日彙報的結構不完整', JSON.stringify(Object.keys(d || {})));
    } catch (e) {
      fail('每日彙報會丟出例外', String((e && e.message) || e));
    }
  }

  // -------------------------------------------------------------------------
  // 9) 標記完整、但句數明顯少於同類場次的影片要被抓出來，並排回收割佇列
  //
  // 2026-09-18 全季收割後檢查：本季 70 支正式場次，句／段中位數 2.12，
  // 5 支脫隊（澳洲 FP3 只有 0.70）。舊的絕對門檻 0.5 一支都沒抓到，
  // 彙報裡「句數偏低」列的反而是本來就安靜、也不算覆蓋率的舊賽季重播與保時捷盃。
  // -------------------------------------------------------------------------
  {
    const realNow = Date.now;
    const bad = [];
    try {
      const mk = async (SUBS, cid, slug, n, seg, mv) => SUBS.put('bundle:' + cid, JSON.stringify({ lines: {}, slug, segCount: seg }),
        { metadata: { n, seg, slug: '/detail/' + cid + '/' + slug, at: 'x', mv: mv || '' } });
      const build = async (lowMv) => {
        const SUBS = fakeKV();
        const kinds = ['gp-practice-1', 'gp-practice-2', 'gp-practice-3', 'gp-qualifying', 'grand-prix'];
        let id = 900;
        for (const gp of ['2026-italian-', '2026-madrid-']) {
          for (const k of kinds) await mk(SUBS, String(id++), gp + k, 2100, 1000);
        }
        await mk(SUBS, '951', '2026-dutch-gp-qualifying', 1700, 800);
        await mk(SUBS, '952', '2026-dutch-grand-prix', 2800, 1300);
        // 可疑的那一支：換掉義大利的 FP3（0.70 句／段）
        await mk(SUBS, '902', '2026-italian-gp-practice-3', 893, 1271, lowMv);
        // 這兩支本來就安靜，而且不算覆蓋率——**不可以**被當成可疑
        await mk(SUBS, '961', '2026-italian-gp-psc-race', 194, 582);
        await mk(SUBS, '962', '2025-italian-grand-prix', 246, 1320);
        return SUBS;
      };

      let cov = await A.harvestCoverage({ SUBS: await build('') }, CFG);
      if (JSON.stringify(cov.suspect) !== '["902"]') bad.push('可疑清單應該只有 902，實際是 ' + JSON.stringify(cov.suspect));
      const fp3 = cov.races.find((r) => r.round === 13).sessions.find((x) => x.kind === 'fp3');
      if (!fp3 || !fp3.suspect || !fp3.complete) bad.push('義大利 FP3 應該是「已完整但可疑」');

      // 收割計畫要把它排回佇列（時間放在賽季結束之後）
      Date.now = () => Date.parse('2026-12-31T00:00:00Z');
      const SUBS = await build('');
      const plan = await A.harvestPlan({ SUBS }, CFG, ['/detail/902/2026-italian-gp-practice-3', '/detail/904/2026-italian-grand-prix']);
      if (!(plan.queue || []).includes('/detail/902/2026-italian-gp-practice-3')) bad.push('可疑的影片沒有排回收割佇列');
      if ((plan.queue || []).some((x) => x.includes('/904/'))) bad.push('正常完整的影片也被排進佇列');
      Date.now = realNow;

      // 新版蓋過章的就不再懷疑（否則真的很安靜的場次會被永遠叫人重收）
      cov = await A.harvestCoverage({ SUBS: await build('4.13.1') }, CFG);
      if (cov.suspect.length) bad.push('v4.13.1 重新確認過的仍被列為可疑');
      cov = await A.harvestCoverage({ SUBS: await build('4.12.0') }, CFG);
      if (JSON.stringify(cov.suspect) !== '["902"]') bad.push('v4.12.0 蓋的章不該被信任');
      // 管理版擴充功能（handoff 9.1 #26）的章帶 ext- 前綴，用自己的門檻比——0.37 不可以拿去跟 4.13 比
      cov = await A.harvestCoverage({ SUBS: await build('ext-0.37.0') }, CFG);
      if (cov.suspect.length) bad.push('管理版 ext-0.37.0 重新確認過的仍被列為可疑（拿 userscript 的門檻比了）');
      cov = await A.harvestCoverage({ SUBS: await build('ext-0.36.0') }, CFG);
      if (JSON.stringify(cov.suspect) !== '["902"]') bad.push('管理版 ext-0.36.0（收割上線前的版本）蓋的章不該被信任');

      // /v1/subs：分段數相同也要能重新蓋章並記下版本
      const S2 = fakeKV({ 'bundle:902': JSON.stringify({ lines: {}, slug: '/detail/902/2026-italian-gp-practice-3', segCount: 1271 }) });
      const req = (b) => ({ json: async () => b });
      await A.handlePostSubs(req({ cid: '902', lines: {}, segCount: 1271, v: '4.13.1' }), { SUBS: S2 });
      const after = JSON.parse(S2._raw.get('bundle:902'));
      if (after.markV !== '4.13.1') bad.push('分段數相同時沒有記下蓋章版本（重新驗證永遠消不掉可疑）');
      if ((S2._meta.get('bundle:902') || {}).mv !== '4.13.1') bad.push('蓋章版本沒有寫進 metadata（清單讀不到）');
      await A.handlePostSubs(req({ cid: '902', lines: {}, segCount: 1271, v: '<script>' }), { SUBS: S2 });
      if (JSON.parse(S2._raw.get('bundle:902')).markV !== '4.13.1') bad.push('不合格式的版本字串被寫進去了');
      await A.handlePostSubs(req({ cid: '902', lines: {}, segCount: 1271, v: 'ext-0.37.0' }), { SUBS: S2 });
      if (JSON.parse(S2._raw.get('bundle:902')).markV !== 'ext-0.37.0') bad.push('管理版的 ext- 版本沒有被記下來');
    } catch (e) {
      bad.push('例外：' + ((e && e.stack) || e));
    } finally {
      Date.now = realNow;
    }
    bad.length ? fail('可疑的完整標記', bad.join('；'))
      : ok('可疑的完整標記：與同類場次比、排回收割佇列、新版蓋章後不再懷疑、舊賽季與支援賽事不誤判');
  }

  // -------------------------------------------------------------------------
  // 10) 每日彙報不可以對「還沒播的場次」發警告
  //
  // 以前 have < need 就警告，下週才開賽的站每天都掛在「需要注意」裡——
  // 那是不可能處理的警告，而不可能處理的警告會訓練人忽略整份彙報。
  // -------------------------------------------------------------------------
  {
    const realNow = Date.now;
    const bad = [];
    try {
      const r15 = A.gpList(CFG).find((g) => g.r === 15);
      const fp1 = r15.sessions.find((x) => x.k === 'fp1') || r15.sessions[0];
      Date.now = () => (fp1.t - 2 * 86400) * 1000;
      let d = await A.buildDigest({ SUBS: fakeKV(), DAILY_USD_CAP: '5' }, CFG);
      if (d.alerts.some((a) => /R15/.test(a))) bad.push('開賽前兩天就警告 R15 沒收割：' + d.alerts.filter((a) => /R15/.test(a)).join(' / '));
      Date.now = () => (fp1.t + 3600 + 3600 + 600) * 1000;
      d = await A.buildDigest({ SUBS: fakeKV(), DAILY_USD_CAP: '5' }, CFG);
      if (!d.alerts.some((a) => /R15/.test(a) && /1 個已播完/.test(a))) bad.push('FP1 播完一小時後沒有提醒收割：' + JSON.stringify(d.alerts));
    } catch (e) {
      bad.push('例外：' + ((e && e.message) || e));
    } finally {
      Date.now = realNow;
    }
    bad.length ? fail('每日彙報的收割警告', bad.join('；'))
      : ok('每日彙報：只對已經播完的場次提醒收割，未開賽的站不發警告');
  }

  // -------------------------------------------------------------------------
  // 11) 每日彙報的訊號要對得上事實（2026-10-02 全面檢查，坑 #73、#74）
  //
  // 四條都是「彙報每天寄出、內容卻是錯的」：
  //   (a) 工單：寫入與結案都沒帶 metadata → 未處理永遠＝總數（後台 3 張都結案了，彙報天天喊 3 張）
  //   (b) 直播看過的場次累積了部分句子 → 被當成「已收割」，賽後 VOD 沒人收也不警告（R15 五場）
  //   (c) 命中率：比賽週末全是直播，本來就不可能賽前收割 → 那條警報做不到
  //   (d) 無 slug：`misc` 與很久以前的那支永遠補不了 → 天天響、處理不掉
  // 每一條都對舊邏輯驗過是紅的。
  // -------------------------------------------------------------------------
  {
    const realNow = Date.now;
    const bad = [];
    try {
      // (a) 工單 ───────────────────────────────────────────────────────
      {
        // 舊資料：沒有 metadata、已結案 → 不可以算進未處理
        const SUBS = fakeKV({
          'report:OLD1': JSON.stringify({ id: 'OLD1', at: 1, resolved: true, report: '' }),
          'report:OLD2': JSON.stringify({ id: 'OLD2', at: 1, resolved: false, report: '' }),
        });
        let d = await A.buildDigest({ SUBS, DAILY_USD_CAP: '5' }, CFG);
        if (!d.alerts.some((a) => /有 1 張工單/.test(a))) bad.push('(a) 舊工單一張結案、一張未結，應該報 1 張：' + JSON.stringify(d.alerts.filter((a) => /工單/.test(a))));
        // 從後台結案：要寫回 metadata，結案後彙報就不再報
        await A.handleReportPatch({ json: async () => ({ id: 'OLD2', resolved: true }) }, { SUBS });
        if ((SUBS._meta.get('report:OLD2') || {}).resolved !== true) bad.push('(a) 結案時沒有寫 metadata（KV 的 put 不帶 metadata 會清掉舊的）');
        d = await A.buildDigest({ SUBS, DAILY_USD_CAP: '5' }, CFG);
        if (d.alerts.some((a) => /工單/.test(a))) bad.push('(a) 全部結案了還在報工單：' + JSON.stringify(d.alerts.filter((a) => /工單/.test(a))));
      }

      // (b) 直播時累積的部分資料不等於收割 ─────────────────────────────
      {
        const r15 = A.gpList(CFG).find((g) => g.r === 15);
        const fp1 = r15.sessions.find((x) => x.k === 'fp1') || r15.sessions[0];
        Date.now = () => (fp1.t + 3600 + 3600 + 600) * 1000;   // FP1 播完、過了 HARVEST_LAG
        const slug = '/detail/1000010371/2026-azerbaijan-gp-practice-1';
        const SUBS = fakeKV();
        // 直播看過：有 1,500 句、沒有完整標記（segCount 0）
        await SUBS.put('bundle:1000010371', JSON.stringify({ lines: {}, slug, segCount: 0 }),
          { metadata: { n: 1500, seg: 0, slug, at: new Date(Date.now()).toISOString() } });
        const d = await A.buildDigest({ SUBS, DAILY_USD_CAP: '5' }, CFG);
        if (!d.alerts.some((a) => /R15/.test(a) && /1 個已播完的場次還沒收完整/.test(a))) {
          bad.push('(b) 直播看過但沒收完整的 FP1 沒有提醒：' + JSON.stringify(d.alerts));
        }
        Date.now = realNow;
      }

      // (c) 命中率只看非比賽週末 ───────────────────────────────────────
      {
        Date.now = () => Date.parse('2026-09-30T12:00:00Z');       // R15 週末（09-23～09-27）之後的週三
        const row = (n) => JSON.stringify({ '1000010385': { calls: 100, translated: n, cached: 0, in: 0, out: 1, cacheRead: 100, cacheWrite: 0 } });
        let SUBS = fakeKV({ 'stats:2026-09-26': row(1000) });     // 正賽日：全是直播
        let d = await A.buildDigest({ SUBS, DAILY_USD_CAP: '5' }, CFG);
        if (d.alerts.some((a) => /共用快取命中率/.test(a))) bad.push('(c) 比賽週末的直播流量觸發了「收割漏了」：' + JSON.stringify(d.alerts.filter((a) => /命中率/.test(a))));
        SUBS = fakeKV({ 'stats:2026-09-26': row(1000), 'stats:2026-09-29': row(800) });  // 平日的重播也全付費
        d = await A.buildDigest({ SUBS, DAILY_USD_CAP: '5' }, CFG);
        if (!d.alerts.some((a) => /非比賽週末的共用快取命中率/.test(a))) bad.push('(c) 平日重播命中率 0% 沒有警告');
        Date.now = realNow;
      }

      // (d) 無 slug：只報處理得了的 ────────────────────────────────────
      {
        const recent = new Date().toISOString();
        const old = '2026-08-17T16:09:30.410Z';
        let SUBS = fakeKV();
        await SUBS.put('bundle:misc', '{}', { metadata: { n: 956, seg: 0, slug: '', at: recent } });
        await SUBS.put('bundle:1000004711', '{}', { metadata: { n: 926, seg: 877, slug: '', at: old } });
        let d = await A.buildDigest({ SUBS, DAILY_USD_CAP: '5' }, CFG);
        if (d.alerts.some((a) => /網址後綴/.test(a))) bad.push('(d) misc／很久以前的那支仍在警報裡：' + JSON.stringify(d.alerts.filter((a) => /網址後綴/.test(a))));
        if (!d.sections.some((x) => x.rows.some((r) => /沒有網址後綴（無法分類）：2 支/.test(r)))) bad.push('(d) 資料健康那一行不可以跟著消失（後台仍要看得到 2 支）');
        await SUBS.put('bundle:1000010999', '{}', { metadata: { n: 300, seg: 0, slug: '', at: recent } });
        A.invalidateBundleMeta();
        d = await A.buildDigest({ SUBS, DAILY_USD_CAP: '5' }, CFG);
        if (!d.alerts.some((a) => /最近 14 天有 1 支/.test(a))) bad.push('(d) 新出現的無 slug 影片沒有警告');
      }

      // (e) 下一賽季通行證的文案不可以自相矛盾 ─────────────────────────
      {
        const msg = A.planLock('season_next', Date.parse('2026-10-02T12:00:00Z'), CFG) || '';
        const m = /還有 (\d+) 個比賽週末.*剩下 (\d+) 個週末時開放/.exec(msg);
        if (!m) bad.push('(e) 下一賽季的鎖定文案格式不對：' + JSON.stringify(msg));
        else if (Number(m[1]) <= Number(m[2])) bad.push('(e) 文案自相矛盾：' + msg);
      }
    } catch (e) {
      bad.push('例外：' + ((e && e.stack) || e));
    } finally {
      Date.now = realNow;
    }
    bad.length ? fail('每日彙報的訊號', bad.join('；'))
      : ok('每日彙報：工單結案看得到、直播的部分資料不算收割、命中率排除比賽週末、無 slug 只報新的、下一季文案不矛盾');
  }

  console.log('');
  if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
  console.log('✅ 分類、標題與收割覆蓋率全部正確');
})();
