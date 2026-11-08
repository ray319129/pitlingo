#!/usr/bin/env node
/**
 * 折扣與促銷（2026-10-26，BUSINESS.md 第 0 節）。
 *
 * 會收錯錢的地方都在這裡驗——全部不會報錯，只會讓某個人多付或少付：
 *   1. 活動設定的防呆：超過 31 天（＝永久促銷）、0 折、代訂、沒有期限，一律不生效
 *   2. 只限通行證；早鳥不疊折扣；續訂只給下一季
 *   3. 兩種折扣不疊加，只取比較便宜的
 *   4. 報價（quoteCart）實際收的錢＝畫面上的折扣價，訂單記得折扣來源
 *   5. 續訂資格只算付了錢、沒被撤銷的賽季票
 *   6. /v1/plans 是公開快取——不可以帶續訂價（因人而異）
 *
 * 用法：node tools/check-promo.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { readBackend, withoutFreeSeason } = require('./lib/backend-src');

// 購買流程在「本賽季免費體驗」關掉的世界裡驗（withoutFreeSeason 的說明）
const SRC = withoutFreeSeason(readBackend());
// ⚠️ 'use strict'：見 check-plan-matrix 開頭的說明（坑 #37）
const src = "'use strict';\n" + SRC
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
vm.runInContext(src + '\n;this.__api={PLANS,quoteCart,gpList,gpId,gpSellable,normPromo,promoActive,discountFor,'
  + 'renewEligible,opsConfig,seasonPriceNow,PROMO_MAX_DAYS,RENEW_PCT,RENEW_ENABLED,choosePaymentFor,CREDIT_ONLY_MAX,'
  + 'resetOps:()=>{opsCache={at:0,data:null};}};', ctx);
const A = sb.__api;

const store = new Map();
const env = { SUBS: {
  get: async (k) => (store.has(k) ? store.get(k) : null),
  put: async (k, v) => { store.set(k, v); },
  delete: async (k) => { store.delete(k); },
  list: async () => ({ keys: [], list_complete: true }),
} };

const bad = [];
const ok = (cond, what) => { if (!cond) bad.push(what); };
const now = Math.floor(Date.now() / 1000);
const base = { name: '測試活動', pct: 90, keys: ['week', 'season', 'season_next'], from: now - 3600, until: now + 86400 };

async function setPromo(p) {
  store.set('ops:config', JSON.stringify(p ? { promo: p } : {}));
  A.resetOps();
  return A.opsConfig(env);
}

(async () => {
  // ---- 1. 設定防呆 ----
  ok(A.normPromo(base), '1a 正常的活動要生效');
  ok(!A.normPromo({ ...base, until: base.from + (A.PROMO_MAX_DAYS + 1) * 86400 }), '1b 超過 31 天（永久促銷）不可以生效');
  ok(!A.normPromo({ ...base, pct: 0 }), '1c 0 折不可以生效');
  ok(!A.normPromo({ ...base, pct: 30 }), '1d 低於 5 折不可以生效');
  ok(!A.normPromo({ ...base, pct: 100 }), '1e 100 折＝沒折扣，不生效');
  ok(!A.normPromo({ ...base, keys: ['svc_pro_1y_own'] }), '1f 只有代訂的活動不可以生效（只限通行證）');
  ok(!A.normPromo({ ...base, until: base.from }), '1g 沒有期間不可以生效');
  ok(!A.normPromo({ ...base, name: '' }), '1h 沒有名稱不可以生效');
  {
    const p = A.normPromo({ ...base, keys: ['week', 'svc_pro_5d', 'season_early'] });
    ok(p && p.keys.join() === 'week', '1i 代訂與早鳥要從適用範圍剔除');
  }

  // ---- 2／3. 單價 ----
  const ops = await setPromo(base);
  const d = (k, list, renew) => A.discountFor(k, list, ops, renew);
  ok(d('season', 599).unit === 539, '2a 本季 599 打 9 折＝539（floor）');
  ok(d('week', 49).unit === 44, '2b 比賽週 49 打 9 折＝44（floor）');
  ok(d('svc_pro_1y_own', 2399).unit === 2399 && !d('svc_pro_1y_own', 2399).promo, '2c 代訂不打折');
  ok(d('season_early', 399).unit === 399, '2d 早鳥不再疊折扣');
  ok(d('season', 599, true).promo.kind === 'campaign', '2e 續訂只給下一季，本季不適用');
  {
    const off = await setPromo(null);
    A.RENEW_ENABLED
      ? ok(A.discountFor('season_next', 599, off, true).unit === 539, '2f 續訂下一季 9 折')
      : ok(A.discountFor('season_next', 599, off, true).unit === 599, '2f 續訂折扣暫停中（Ray 2026-10-30）：老客戶也是原價');
    ok(A.discountFor('season_next', 599, off, false).unit === 599, '2g 沒資格就是原價');
  }
  {
    const o85 = await setPromo({ ...base, pct: 85 });
    const r = A.discountFor('season_next', 599, o85, true);
    ok(r.unit === 509 && r.promo.kind === 'campaign', '3a 活動 85 折＋續訂 9 折：不疊加，取便宜的 85 折');
    const o95 = await setPromo({ ...base, pct: 95 });
    const r2 = A.discountFor('season_next', 599, o95, true);
    A.RENEW_ENABLED
      ? ok(r2.unit === 539 && r2.promo.kind === 'renew', '3b 活動 95 折＋續訂 9 折：取續訂 9 折')
      : ok(r2.unit === 569 && r2.promo.kind === 'campaign', '3b 續訂折扣暫停中：只剩活動 95 折');
  }
  {
    const past = await setPromo({ ...base, from: now - 7200, until: now - 60 });
    ok(!A.promoActive(past) && A.discountFor('season', 599, past).unit === 599, '3c 活動結束後自動恢復原價');
    const future = await setPromo({ ...base, from: now + 3600, until: now + 7200 });
    ok(A.discountFor('season', 599, future).unit === 599, '3d 活動還沒開始是原價');
  }

  // ---- 4. 報價 ----
  await setPromo(base);
  const gps = A.gpList().filter((g) => A.gpSellable(g)).map((g) => A.gpId(g));
  if (gps.length) {
    const q = await A.quoteCart(env, [{ key: 'week', gp: gps[0], qty: 1 }], {});
    ok(!q.error && q.total === 44, `4a 比賽週報價要收折扣價 44（實際 ${q.error || q.total}）`);
    ok(q.lines && q.lines[0].promo && q.lines[0].promo.list === 49, '4b 訂單要記得原價與折扣來源');
    ok(q.weekPaid === 44, '4c 升級折抵用的 weekPaid 是實付 44，不是牌價');
    const s = await A.quoteCart(env, [{ key: 'svc_pro_5d', gp: gps[0], qty: 1 }], {});
    ok(!s.error && s.total === 79, `4d 代訂報價不受活動影響（實際 ${s.error || s.total}）`);
  }
  {
    const sp = A.seasonPriceNow(A.PLANS.season.price).price;
    const q = await A.quoteCart(env, [{ key: 'season', qty: 1 }], { renew: true });
    ok(!q.error && q.total === Math.floor(sp * 0.9), `4e 本季報價＝當期價 ${sp} 的 9 折（實際 ${q.error || q.total}）`);
  }
  await setPromo(null);

  // ---- 5. 續訂資格 ----
  const put = (k, lic) => store.set('lic:' + k, JSON.stringify(lic));
  store.set('licmail:a@x.com', JSON.stringify(['AAAA1111']));
  put('AAAA1111', { plan: 'season', paid: 599 });
  store.set('licmail:b@x.com', JSON.stringify(['BBBB2222']));
  put('BBBB2222', { plan: 'comp', paid: 0 });
  store.set('licmail:c@x.com', JSON.stringify(['CCCC3333']));
  put('CCCC3333', { plan: 'season', paid: 599, revoked: true });
  store.set('licmail:d@x.com', JSON.stringify(['DDDD4444']));
  put('DDDD4444', { plan: 'week', paid: 49 });
  store.set('licmail:e@x.com', JSON.stringify(['EEEE5555']));
  put('EEEE5555', { plan: 'season', paid: 0 });
  ok(await A.renewEligible(env, ['a@x.com']), '5a 付過錢的賽季票有資格');
  ok(!(await A.renewEligible(env, ['b@x.com'])), '5b 客服補償沒有資格');
  ok(!(await A.renewEligible(env, ['c@x.com'])), '5c 退款撤銷的沒有資格');
  ok(!(await A.renewEligible(env, ['d@x.com'])), '5d 只買過比賽週沒有資格');
  ok(!(await A.renewEligible(env, ['e@x.com'])), '5e 0 元發的賽季票沒有資格');

  // ---- 6. 原始碼契約 ----
  const plansBlock = SRC.slice(SRC.indexOf("if (path === '/v1/plans' && request.method === 'GET')"));
  const plansBody = plansBlock.slice(0, plansBlock.indexOf("'public, max-age=60'"));
  ok(!/discountFor\([^)]*true\)/.test(plansBody) && !/renewFor|renewEligible/.test(plansBody),
    '6a /v1/plans 有公開快取，不可以帶續訂價');
  ok(/'\/v1\/quote', '\/v1\/checkout',/.test(SRC.slice(SRC.indexOf('const SITE_CRED_PATHS'))),
    '6b 報價與結帳要允許帶登入 cookie（否則續訂折扣永遠不會生效）');
  ok(/mine\.includes\(accountKey\(email\)\)/.test(SRC), '6c 續訂資格要核對結帳信箱屬於登入的帳號');
  ok((SRC.match(/await renewFor\(env, request,/g) || []).length === 2, '6d 報價與結帳都要用 renewFor');

  // ---- 7. 小額訂單只開信用卡（2026-10-26：49 元走超商代碼，手續費約 32.6 元）----
  ok(A.CREDIT_ONLY_MAX === 130, '7a 門檻是 130（Ray 2026-10-27：130 以下都只能刷卡）');
  ok(A.choosePaymentFor(49, {}) === 'Credit' && A.choosePaymentFor(98, { choosePayment: 'ALL' }) === 'Credit' && A.choosePaymentFor(130, null) === 'Credit'
    && A.choosePaymentFor(44, { choosePayment: 'ATM' }) === 'Credit', '7b 130 元以下（含折扣後、兩張週通行證 98）一律只開信用卡，後台設定也蓋不過');
  ok(A.choosePaymentFor(131, {}) === 'ALL' && A.choosePaymentFor(599, { choosePayment: 'Credit' }) === 'Credit'
    && A.choosePaymentFor(329, null) === 'ALL', '7c 超過門檻照舊用後台設定（預設 ALL）');
  // 早鳥固定只收信用卡（名額只保留 30 分鐘，2026-11-03），其他照 choosePaymentFor
  ok(/ChoosePayment: hasEarly \? 'Credit' : choosePaymentFor\(price, ops\)/.test(SRC), '7d 結帳送給綠界的付款方式走 choosePaymentFor（早鳥只收信用卡）');

  if (bad.length) {
    console.log('❌ 折扣與促銷');
    for (const b of bad) console.log('   ❌ ' + b);
    process.exit(1);
  }
  console.log('✅ 折扣與促銷（只限通行證、不疊加、最長 31 天、續訂只給付過錢的、130 元以下只開信用卡）');
})().catch((e) => { console.log('❌ check-promo 執行失敗：' + (e && e.stack || e)); process.exit(1); });
