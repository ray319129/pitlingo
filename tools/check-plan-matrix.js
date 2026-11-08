#!/usr/bin/env node
/**
 * 方案組合矩陣。
 *
 * 把**每一個方案單買、每兩個方案搭配、以及各種數量與跳著買**都跑一遍，
 * 檢查金額、主方案、效期、比賽週區間有沒有算錯。
 *
 * 為什麼需要：方案之間會互相影響（折抵、附贈、區間、主方案的選法），
 * 而那些交互作用**沒有一個會報錯**——只會讓某個組合收錯錢或發錯授權。
 * 第一次跑就抓到兩個實際會收錯錢的 bug：
 *
 *   1. **賽季票 + 比賽週通行證 → 賽季票被截成一週。**
 *      授權帶著比賽週的區間，而續期只簽到「現在這一段」的結束。
 *      客人付了 NT$338 買一整季，拿到的是兩週，比賽週之外完全不能用。
 *
 *   2. **同一場買兩次收兩次錢**，但區間合併後只有一段——第二筆是純損失。
 *
 * 用法：node tools/check-plan-matrix.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { readBackend, withoutFreeSeason } = require('./lib/backend-src');
// ⚠️ **一定要加 'use strict'。** 後端是 ESM（＝嚴格模式），但 vm.runInContext
//    跑的是 script（＝非嚴格）。差別會吃掉一整類 bug：對未宣告的變數賦值
//    在這裡只是建立一個全域，在真正的 Worker 上是 ReferenceError。
//    實際發生過——`let hasWeekPurchase` 被刪掉、`hasWeekPurchase = true` 留著，
//    node --check 與這裡的矩陣測試**全部放行**，直播頁面上才炸。
// 購買流程在「本賽季免費體驗」關掉的世界裡驗（withoutFreeSeason 的說明）
let src = "'use strict';\n" + withoutFreeSeason(readBackend())
  .replace(/export default \{[\s\S]*?\n\};\r?\n/, '')
  .replace(/\bexport\s+class\s+/g, 'class ');
const sb = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
  Response: class { constructor(b, i) { this.body = b; Object.assign(this, i); } },
  Request: class {}, URL, console, Date, Math, JSON, Map, Set, Promise, RegExp, Error,
  Array, Object, String, Number, Boolean, setTimeout, clearTimeout, parseInt, parseFloat,
  isNaN, fetch: () => {}, Intl,
};
sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(src + '\n;this.__api={PLANS,quoteCart,gpList,gpId,gpWindow,gpStatus,gpSellable,WEEKEND_PRICE,planExpiry,'
  + 'entitlementUntil,currentWindow,seasonPriceNow,planPrice,opsConfig,mergeWindows,racesLeft,NEXT_SEASON_MIN_WEEKENDS,planLock};', ctx);
const A = sb.__api;

const store = new Map();
const env = { SUBS: {
  get: async (k) => (store.has(k) ? store.get(k) : null),
  put: async (k, v) => { store.set(k, v); },
  delete: async (k) => { store.delete(k); },
  list: async () => ({ keys: [], list_complete: true }),
} };

const NOW = Date.now();
// ⚠️ **一定要用 gpSellable，不可以用 `!== 'finished'`。**
//    正賽跑完、區間還沒結束的那一站狀態是 `replay`：還有效，但已經停售。
//    挑到它的話，下面每一組購物車都會回「不再販售」，
//    而報出來的問題會是「主方案是 undefined」——跟真正的原因毫無關係。
const gps = A.gpList().filter((g) => A.gpSellable(g, NOW)).map((g) => A.gpId(g));
// 單場牌價。**不可以寫死**：這份檔案以前整排都是 39。
const W = A.WEEKEND_PRICE;
const GP1 = gps[0], GP2 = gps[1], GP3 = gps[2], GPLAST = gps[gps.length - 1];

const problems = [];
const P = (sev, what, detail) => problems.push({ sev, what, detail });

const money = (n) => 'NT$' + n;
async function q(items, opts) { return A.quoteCart(env, items, opts || {}); }

/** 用購物車模擬 webhook 會發出什麼樣的授權，然後檢查它合不合理 */
function simulateLicense(quote) {
  const plan = quote.primary;
  const wins = quote.windows || [];
  return {
    plan,
    windows: wins.length ? wins : null,
    expiresAt: wins.length ? Math.max(...wins.map((w) => w[1])) : A.planExpiry(plan),
    startsAt: wins.length ? Math.min(...wins.map((w) => w[0])) : null,
  };
}

(async () => {
  const sellable = Object.entries(A.PLANS)
    .filter(([, v]) => v.price > 0 && !v.internal)
    .map(([k]) => k);
  console.log('可販售方案：' + sellable.join('、'));
  console.log('可購買場次：' + gps.length + ' 場（' + GP1 + ' … ' + GPLAST + '）\n');

  const needGp = (k) => A.PLANS[k].weekBound || A.PLANS[k].svcWeekend;
  const item = (k, gp, qty) => (needGp(k) ? { key: k, gp: gp || GP1, qty: qty || 1 } : { key: k, qty: qty || 1 });

  /* ---------- 1. 每一個方案單買 ---------- */
  console.log('── 單買 ──');
  for (const k of sellable) {
    const r = await q([item(k)]);
    if (r.error) { const locked = A.PLANS[k].nextSeasonOnly || A.PLANS[k].offSeasonOnly;
      if (!locked) P('高', '單買 ' + k + ' 失敗', r.error);
      console.log('  ' + (locked ? '🔒' : '❌') + ' ' + k + '：' + r.error); continue; }
    const lic = simulateLicense(r);
    const days = lic.expiresAt ? ((lic.expiresAt - NOW / 1000) / 86400).toFixed(1) : '—';
    console.log('  ✅ ' + k.padEnd(16) + money(r.total).padEnd(9)
      + ' 主方案 ' + String(lic.plan).padEnd(12) + ' 效期 ' + days + ' 天');
    if (r.total !== A.PLANS[k].price && !A.PLANS[k].untilSeasonEnd) {
      P('高', k + ' 的金額與牌價不符', r.total + ' vs ' + A.PLANS[k].price);
    }
    if (lic.expiresAt == null) P('高', k + ' 算出「無期限」授權', 'expiresAt = null');
  }

  /* ---------- 2. 兩兩搭配 ---------- */
  console.log('\n── 兩兩搭配 ──');
  for (let i = 0; i < sellable.length; i++) {
    for (let j = i + 1; j < sellable.length; j++) {
      const a = sellable[i], b = sellable[j];
      // 兩個都要指定場次時，用不同場次比較有代表性
      const items = [item(a, GP1), item(b, needGp(b) ? GP2 : undefined)];
      const r = await q(items);
      if (r.error) { console.log('  ⛔ ' + a + ' + ' + b + '：' + r.error); continue; }
      const lic = simulateLicense(r);
      const sum = items.reduce((n, it) => n + (A.PLANS[it.key].untilSeasonEnd
        ? A.seasonPriceNow(A.PLANS[it.key].price).price : A.PLANS[it.key].price) * it.qty, 0);
      const adj = (r.adjustments || []).reduce((n, x) => n + x.amount, 0);
      if (r.total !== sum + adj) {
        P('高', a + ' + ' + b + ' 金額對不上', r.total + ' ≠ ' + sum + ' + ' + adj);
      }
      // **關鍵檢查**：主方案是賽季票時，授權不可以被綁進比賽週區間
      const isSeason = A.PLANS[lic.plan] && A.PLANS[lic.plan].untilSeasonEnd;
      if (isSeason && lic.windows) {
        P('高', a + ' + ' + b + '：賽季票被綁進比賽週區間',
          '主方案 ' + lic.plan + '，但 windows 有 ' + lic.windows.length + ' 段');
      }
      if (isSeason) {
        const seasonEnd = A.planExpiry(lic.plan);
        if (lic.expiresAt && seasonEnd && lic.expiresAt < seasonEnd - 86400) {
          P('高', a + ' + ' + b + '：賽季票的效期被截短',
            new Date(lic.expiresAt * 1000).toISOString().slice(0, 10)
            + ' 而不是 ' + new Date(seasonEnd * 1000).toISOString().slice(0, 10));
        }
      }
      console.log('  ' + (isSeason && lic.windows ? '⚠️' : '✅') + ' '
        + (a + ' + ' + b).padEnd(36) + money(r.total).padEnd(9)
        + ' 主 ' + String(lic.plan).padEnd(12)
        + (r.adjustments && r.adjustments.length ? ' 折抵 ' + adj : ''));
    }
  }

  /* ---------- 3. 附贈不可以再變成折抵 ---------- */
  //
  // ⚠️ **這裡以前有一行「代訂已附贈一週，折抵 −39」。**
  //    附贈現在是購物車裡 NT$0 的商品列，折抵已經拿掉。
  //    若有人把它加回來就會**折兩次**——附贈免費一次、折抵再免費一次。
  console.log('\n── 附贈不可以再變成折抵 ──');
  {
    const r = await q([{ key: 'svc_prem_1m_own', qty: 1, gifts: [GP2] }, item('week', GP1)]);
    const adj = (r.adjustments || []).filter((x) => /附贈/.test(x.label));
    console.log('  代訂 + 自費 1 張　總計 ' + money(r.total)
      + '　附贈折抵 ' + (adj.length ? JSON.stringify(adj) : '無（正確）'));
    if (adj.length) P('高', '附贈又被折抵了一次（會折兩次）', JSON.stringify(adj));
    if (r.total !== 699 + W) P('高', '代訂 + 自費 1 張的金額不對', String(r.total));
  }

  /* ---------- 4. 多張比賽週通行證 ---------- */
  console.log('\n── 多張通行證 ──');
  {
    const r = await q([item('week', GP1), item('week', GP2), item('week', GP3)]);
    const lic = simulateLicense(r);
    console.log('  連續三場　' + money(r.total) + '　區間 ' + (r.windows || []).length + ' 段');
    if (r.total !== W * 3) P('高', '三場的金額不對', String(r.total));
    if ((r.windows || []).length !== 1) P('中', '連續三場沒有合併成一段', JSON.stringify(r.windows));
  }
  {
    const r = await q([item('week', GP1), item('week', GPLAST)]);
    console.log('  跳著買（第一場 + 最後一場）　' + money(r.total) + '　區間 ' + (r.windows || []).length + ' 段');
    if ((r.windows || []).length !== 2) P('高', '跳著買沒有產生兩段區間', JSON.stringify(r.windows));
  }
  {
    const r = await q([item('week', GP1), item('week', GP1)]);
    console.log('  同一場買兩次　' + money(r.total) + '　列數 ' + r.lines.length
      + '　區間 ' + (r.windows || []).length + ' 段');
    if (r.total > W) P('高', '同一場買兩次收了兩次錢', money(r.total) + '（應為 ' + money(W) + ' 或直接拒絕）');
  }

  /* ---------- 5. 賽季票 + 通行證：必須整組擋下 ---------- */
  //
  // ⚠️ **這一組曾經放行，而且完全不報錯。** 發出去的賽季票帶著比賽週的區間，
  //    續期只簽到「現在這一段」的結束——一整季被截成一週。
  //    現在應該在算錢之前就被擋下；**放行本身就是錯**，不必再看金額。
  console.log('\n── 賽季票 + 通行證 ──');
  {
    const r = await q([{ key: 'season', qty: 1 }, item('week', GP2)]);
    console.log('  ' + (r.error ? '✅ 擋下：' + r.error : '❌ 竟然放行　' + money(r.total)));
    if (!r.error) {
      const lic = simulateLicense(r);
      P('高', '賽季票 + 通行證竟然放行', '主方案 ' + lic.plan
        + '，區間 ' + ((lic.windows || []).length) + ' 段（賽季票會被截成一週）');
    }
  }

  /* ---------- 5b. 代訂附贈的比賽週 ---------- */
  //
  // ⚠️ **附贈是唯一一條「不收錢卻要發出權利」的路徑。**
  //    多送不會報錯，只會少賺；漏送也不會報錯，只會變成一封客訴信。
  //    兩邊都必須有人守著。
  console.log('\n── 代訂附贈的比賽週 ──');
  {
    const giftOf = (r) => (r.lines || []).filter((l) => l.gift);
    const chk = (why, items, want) => {
      return q(items).then((r) => {
        if (want === 'error') {
          console.log('  ' + (r.error ? '✅ 擋下' : '❌ 竟然放行') + '　' + why
            + (r.error ? '' : '　→ ' + money(r.total)));
          if (!r.error) P('高', '附贈應擋下卻放行：' + why, JSON.stringify(items));
          return;
        }
        if (r.error) { P('高', '附贈情境失敗：' + why, r.error); console.log('  ⛔ ' + why + '：' + r.error); return; }
        const g = giftOf(r);
        const ok = g.length === want.n && r.total === want.total && r.weekPaid === want.paid
          && g.every((l) => l.sum === 0);
        if (!ok) {
          P('高', '附贈算錯：' + why,
            g.length + ' 張／應 ' + want.n + '，總計 ' + r.total + '／應 ' + want.total
            + '，通行證實付 ' + r.weekPaid + '／應 ' + want.paid);
        }
        console.log('  ' + (ok ? '✅' : '❌') + ' ' + why.padEnd(34)
          + '附贈 ' + g.length + ' 張　' + money(r.total).padEnd(9)
          + ' 通行證實付 ' + money(r.weekPaid) + '　主 ' + r.primary);
      });
    };
    await chk('代訂 1 月 ×1（未指定，自動補）', [{ key: 'svc_prem_1m_own', qty: 1 }],
      { n: 1, total: 699, paid: 0 });
    // 一個月的代訂一次只賣 1 份（2026-10-30 Ray：代理商沒辦法一次訂一個月分三次）
    await chk('❗代訂 1 月 ×3（一次只能買 1 份）',
      [{ key: 'svc_prem_1m_own', qty: 3, gifts: [GP1, GP2, GP3] }], 'error');
    await chk('代訂 1 年（3 張）',
      [{ key: 'svc_prem_1y_own', qty: 1, gifts: [GP1, GP2, GP3] }],
      { n: 3, total: 4799, paid: 0 });
    await chk('代訂 1 月 + 自費 1 張（不同場）',
      [{ key: 'svc_prem_1m_own', qty: 1, gifts: [GP1] }, { key: 'week', gp: GP2, qty: 1 }],
      { n: 1, total: 699 + W, paid: W });
    await chk('五天共用帳號（不附贈）', [{ key: 'svc_pro_5d', gp: GP1, qty: 1 }],
      { n: 0, total: 79, paid: 0 });
    await chk('賽季票 + 代訂（附贈已含於賽季票）',
      [{ key: 'season', qty: 1 }, { key: 'svc_prem_1y_own', qty: 1 }],
      { n: 1, total: A.seasonPriceNow(A.PLANS.season.price).price + 4799, paid: 0 });
    // ⚠️ 這三個一定要擋。放行任何一個都等於白送一站。
    await chk('❗附贈與自費撞號',
      [{ key: 'svc_prem_1m_own', qty: 1, gifts: [GP1] }, { key: 'week', gp: GP1, qty: 1 }], 'error');
    await chk('❗指定超過附贈張數',
      [{ key: 'svc_prem_1m_own', qty: 1, gifts: [GP1, GP2] }], 'error');
    await chk('❗附贈指定已結束的場次',
      [{ key: 'svc_prem_1m_own', qty: 1, gifts: [A.gpId(A.gpList()[0])] }], 'error');
  }
  {
    // 附贈的張數必須跟著方案走（一年 3 張）。寫死成 1 的話，商品卡上寫著「隨附 3 張」卻只送一張。
    // （一個月的代訂 2026-10-30 起一次只賣 1 份，「份數 × 張數」改用一年方案驗）
    const r = await q([{ key: 'svc_prem_1y_own', qty: 1, gifts: [GP1, GP2, GP3] }]);
    const n = (r.lines || []).filter((l) => l.gift).length;
    if (n !== 3) P('高', '附贈張數沒有跟著方案走', '一年方案只送了 ' + n + ' 張');
  }
  {
    // ⚠️ **哪幾站是附贈的，必須跟著訂單一起記下來。**
    //    現在沒有人讀 giftGpIds——但日後若要讓附贈的通行證可以送人
    //    （發成獨立的授權碼），就得知道哪幾站原本是附贈的，
    //    而那個資訊**只有結帳當下有**。少記一次就永遠補不回來，
    //    屆時只能對這段期間的訂單特殊處理。記它是零成本，漏它是不可逆的。
    const r = await q([{ key: 'svc_prem_1y_own', qty: 1, gifts: [GP1, GP2, GP3] },
      { key: 'week', gp: GPLAST, qty: 1 }]);
    const g = (r.giftGpIds || []).slice().sort().join(',');
    const want = [GP1, GP2, GP3].slice().sort().join(',');
    const ok = g === want && (r.gpIds || []).length === 4;
    if (!ok) P('高', '附贈的站別沒有被記錄', 'giftGpIds=' + JSON.stringify(r.giftGpIds)
      + '，應為 ' + want + '；gpIds ' + ((r.gpIds || []).length) + ' 站（應 4）');
    console.log('  ' + (ok ? '✅' : '❌') + ' 附贈站別有記進訂單　giftGpIds '
      + ((r.giftGpIds || []).length) + ' 站 / 共 ' + ((r.gpIds || []).length) + ' 站');
  }

  /* ---------- 6. 不該成立的組合 ---------- */
  console.log('\n── 不該成立的 ──');
  const bad = [
    [[{ key: 'week', qty: 1 }], '通行證沒指定場次'],
    [[{ key: 'svc_pro_5d', qty: 1 }], '共用帳號代訂沒指定場次'],
    [[{ key: 'week_svc', gp: GP1, qty: 1 }], '內部方案 week_svc'],
    [[{ key: 'svc_none', qty: 1 }], '內部方案 svc_none'],
    [[{ key: 'trial', qty: 1 }], '免費層 trial'],
    [[{ key: 'comp', qty: 1 }], '客服補償 comp'],
    [[{ key: '不存在的方案', qty: 1 }], '不存在的方案'],
  ];
  for (const [items, why] of bad) {
    const r = await q(items);
    console.log('  ' + (r.error ? '✅ 擋下' : '❌ 竟然放行') + '　' + why
      + (r.error ? '' : '　→ ' + money(r.total)));
    if (!r.error) P('高', '應該擋下卻放行：' + why, JSON.stringify(items));
  }

  /* ---------- 下一賽季票：依「剩幾個週末」開放 ---------- */
  // ⚠️ 以前寫死在「不該成立」清單裡——那是一顆定時炸彈：剩下的週末少於 8 個那天
  //    （2026-10-05）它真的開賣了，測試就跟著紅。規則本身要兩邊都驗：還早的時候擋、時候到了要賣得出去。
  console.log('\n── 下一賽季票 ──');
  {
    const realNow = Date.now;
    const races = A.gpList();
    const early = races.length ? Date.parse(races[0].start + 'T00:00:00Z') - 86400000 : NOW;     // 開季前一天：一定還很多站
    const late = races.length ? Date.parse(races[races.length - 1].start + 'T00:00:00Z') - 3 * 86400000 : NOW;  // 最後一站前三天
    for (const [t, label] of [[early, '開季前（應該擋）'], [late, '最後一站前（應該開放）']]) {
      Date.now = () => t;
      const left = A.racesLeft(t);     // 毫秒（與 planLock 傳進來的一樣）
      const r = await q([{ key: 'season_next', qty: 1 }]);
      Date.now = realNow;
      const shouldOpen = left < A.NEXT_SEASON_MIN_WEEKENDS;
      console.log('  ' + ((!!r.error) !== shouldOpen ? '✅' : '❌') + '　' + label + '：剩 ' + left + ' 個週末，'
        + (r.error ? '擋下' : '放行 ' + money(r.total)));
      if (shouldOpen && r.error) P('高', '剩 ' + left + ' 個週末卻買不到下一賽季票', r.error);
      if (!shouldOpen && !r.error) P('高', '剩 ' + left + ' 個週末卻已經能買下一賽季票', label);
    }
  }

  // 下一賽季票在本賽季結束後才生效、一張訂單只發一組碼：跟本季的票同單會被吃掉（以前「本季＋下一季」付 898 只發本季票）
  // 2026-10-30 起可以同單結帳：一張訂單發兩組碼（本賽季那組是主授權、下一季票在 extra）。
  // 驗「另一張沒有被吃掉」：主授權不是下一季票、extra 剛好一組下一季票、兩組的實付加起來等於總價。
  console.log('\n── 下一賽季票＋本賽季的東西：同單發兩組碼 ──');
  // season_early 換季前也是下一賽季的票（2026-11-03 起賣 2027），跟 season_next 互斥——見下面那一項
  for (const other of ['season', 'week', 'svc_pro_1m_own', 'svc_prem_1y_own']) {
    const r = await q([item('season_next'), item(other)]);
    const ex = r.extra || [];
    const ok = !r.error && r.primary !== 'season_next' && ex.length === 1 && ex[0].plan === 'season_next'
      && ex[0].paid === (r.lines.find((l) => l.key === 'season_next') || {}).sum
      && (A.PLANS[r.primary].weekBound ? r.weekPaid : r.primaryPaid) + ex[0].paid <= r.total;
    console.log('  ' + (ok ? '✅' : '❌') + '　season_next + ' + other + '：'
      + (r.error ? '擋下：' + r.error : '主 ' + r.primary + '＋' + ex.map((x) => x.plan).join(',') + '　' + money(r.total)));
    if (!ok) P('高', 'season_next + ' + other + ' 同單結帳', r.error ? '被擋下（應該發兩組碼）' : '沒有分成兩組碼：' + JSON.stringify([r.primary, ex]));
  }
  // 只有下一季票：一組碼就是它，沒有 extra
  {
    const r = await q([item('season_next')]);
    if (r.error || r.primary !== 'season_next' || (r.extra || []).length) P('高', '只買下一季票', JSON.stringify([r.error, r.primary, r.extra]));
  }

  /* ---------- 結果 ---------- */
  console.log('\n════════ 問題彙總 ════════');
  if (!problems.length) console.log('沒有發現問題');
  else problems.forEach((p, i) => console.log((i + 1) + '. [' + p.sev + '] ' + p.what + '\n      ' + p.detail));
  process.exit(problems.some((p) => p.sev === '高') ? 1 : 0);
})();
