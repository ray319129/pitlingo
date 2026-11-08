#!/usr/bin/env node
/**
 * 代訂自營（RESELL-OPS.md）第 1 階段：帳號庫存、交付用密碼、成本、採購區、事件、全域查詢。
 *
 * ⚠️ **D1 用的是真的 SQLite（node:sqlite），schema 直接執行 backend/migrations/ 底下的正式檔案。**
 *    另外抄一份 schema 給測試用，兩邊遲早會漂——那就變成測試在驗一個不存在的資料庫。
 *    假的 D1 也照 D1 的規矩：bind 給 undefined 直接丟例外（真的 D1 是 D1_TYPE_ERROR）。
 *
 * 這裡每一條規則拿掉，功能都還「能用」，只是變得不安全或不準：
 *    清單帶出 pw_enc        → 後台每次打開代訂分頁，所有密文都在 ADMIN_TOKEN 的頁面上
 *    沒 RESELL_KEY 存明文    → 「加密存放」的承諾（條款草稿）是假的
 *    AAD 沒綁信箱           → 兩列密文對調，A 帳號的密碼交給 B 的客戶，而且不報錯
 *    看密碼不記事件         → 「我沒收到」與「誰看過」都查不到
 *    查詢走 5 分鐘快取       → 使用者明說要「最新資訊」，剛付款的訂單查不到
 *    LIKE 不跳脫            → 搜「f1_」把整個庫存列出來
 *
 * 用法：node tools/check-resell.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const root = path.join(__dirname, '..');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const fail = (m, d) => { errors.push(m); console.log('❌ ' + m + (d ? '：' + d : '')); };
const check = (cond, m, d) => (cond ? ok(m) : fail(m, d));

const rawSrc = readBackend();
let src = "'use strict';\n" + rawSrc;
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

const sandbox = {
  crypto: require('crypto').webcrypto,
  TextEncoder, TextDecoder, btoa, atob, Uint8Array, Uint32Array, URLSearchParams, AbortSignal,
  Response: class { constructor(b, i) { this.body = b; this.status = 200; Object.assign(this, i || {}); } async text() { return this.body; } },
  Request: class {},
  URL, console, Date, Math, JSON, Map, Set, Promise, RegExp, Error,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, setTimeout,
  fetch: async (u) => { throw new Error('未預期的網路呼叫：' + u); },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { routeAdmin, accountView, orderRows, RESELL_ACCOUNT_COLS, quoteCart, resellHoldShared, resellSyncOrder, gpList, gpSellable, gpId, gpById, gpHandoverSec, PLANS, customerF1, customerF1Reveal, resellExpire, resellPeriod };', sandbox);
const A = sandbox.__api;

// ---------------------------------------------------------------------------
// 假的 KV 與 D1
// ---------------------------------------------------------------------------
function fakeKV() {
  const store = new Map();
  const meta = new Map();
  let lists = 0;
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, o) { store.set(k, v); if (o && o.metadata) meta.set(k, o.metadata); },
    async delete(k) { store.delete(k); meta.delete(k); },
    async list({ prefix }) {
      lists++;
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix || '')).map((name) => ({ name, metadata: meta.get(name) || {} })), list_complete: true };
    },
    _store: store, get _lists() { return lists; },
  };
}

const MIGRATIONS = path.join(root, 'backend/migrations');
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
  const plain = (r) => (r ? Object.assign({}, r) : r);
  // ⚠️ 每個查詢之前隨機等一下：沒有延遲的話並發的請求根本不會交錯，
  //    「同時搶最後一席」的測試永遠是綠的（坑 #55：測試用的假儲存要有延遲）。
  const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
  const runSync = (sql, params) => { const r = db.prepare(sql).run(...params); return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; };
  const allSync = (sql, params) => ({ success: true, results: db.prepare(sql).all(...params).map(plain), meta: {} });
  const stmt = (sql, params) => ({
    _sql: sql, _params: params,
    bind(...a) {
      a.forEach((v, i) => { if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value at ${i + 1}`); });
      return stmt(sql, a);
    },
    async first(col) { await jitter(); const r = db.prepare(sql).get(...params); if (r === undefined) return null; return col ? r[col] : plain(r); },
    async all() { await jitter(); return allSync(sql, params); },
    async run() { await jitter(); return runSync(sql, params); },
  });
  return {
    prepare: (sql) => stmt(sql, []),
    // D1 的 batch＝一個交易：中間不會有別的請求插進來，任何一句失敗就整批回滾
    async batch(list) {
      await jitter();
      db.exec('BEGIN');
      try {
        const out = list.map((s) => (/^\s*SELECT/i.test(s._sql) ? allSync(s._sql, s._params) : runSync(s._sql, s._params)));
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    _db: db,
  };
}

const KEY = Buffer.alloc(32, 7).toString('base64');
const newEnv = (o) => Object.assign({ SUBS: fakeKV(), RESELL_DB: fakeD1(), RESELL_KEY: KEY }, o || {});

async function call(env, method, p, body) {
  const url = new URL('https://api.test' + p);
  const req = { method, json: async () => (body === undefined ? null : JSON.parse(JSON.stringify(body))) };
  const res = await A.routeAdmin(url.pathname, req, env, url);
  if (!res) return { status: 404, data: { error: 'not routed' } };
  return { status: res.status || 200, data: JSON.parse(res.body) };
}
const post = (env, p, b) => call(env, 'POST', p, b);
const get = (env, p) => call(env, 'GET', p);

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const advanceDays = (d) => { offset += d * 86400000; };

const PW = 'Sup3r-Secret-PW!';
const base = { login_email: 'f1-001@pitlingo.test', region: 'br', tier: 'premium', billing: 'monthly', status: 'shared' };

(async () => {
  // 1) migration 本身
  {
    const env = newEnv();
    const t = env.RESELL_DB._db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    const want = ['f1_accounts', 'f1_costs', 'f1_events', 'f1_regions'];
    check(want.every((x) => t.includes(x)), '1 正式 migration 在 SQLite 上執行成功，建出 4 張表', t.join(','));
  }

  // 2) 沒有綁 D1：讀回 configured:false、寫一律拒絕、不碰 KV
  {
    const env = newEnv({ RESELL_DB: undefined });
    const r = await get(env, '/v1/admin/resell');
    const w = await post(env, '/v1/admin/resell/account', Object.assign({ password: PW }, base));
    check(r.status === 200 && r.data.configured && r.data.configured.db === false && w.status === 503 && env.SUBS._store.size === 0,
      '2 沒有 RESELL_DB：讀取回「未建立」，寫入 503，不退回存 KV', JSON.stringify([r.status, w.status, env.SUBS._store.size]));
  }

  // 3) 沒有 RESELL_KEY：拒絕存密碼，而且整筆都不寫（不會留下一列沒有密碼、讓人以為存好了）
  {
    const env = newEnv({ RESELL_KEY: '' });
    const w = await post(env, '/v1/admin/resell/account', Object.assign({ password: PW }, base));
    const n = env.RESELL_DB._db.prepare('SELECT COUNT(*) AS n FROM f1_accounts').get().n;
    const w2 = await post(env, '/v1/admin/resell/account', Object.assign({}, base, { login_email: 'f1-002@pitlingo.test' }));
    check(w.status === 503 && n === 0 && w2.status === 200,
      '3 沒有 RESELL_KEY：帶密碼的新增整筆拒絕（不存明文、不留半筆）；不帶密碼的照常新增', JSON.stringify([w.status, n, w2.status]));
  }

  // 4～8) 正常流程
  const env = newEnv();
  const add = await post(env, '/v1/admin/resell/account', Object.assign({ password: PW, vault_ref: 'F1 BR 001', card_ref: 'Visa *4242', renews_at: Math.floor(Date.now() / 1000) + 3 * 86400 }, base));
  const id = add.data.id;
  {
    const row = env.RESELL_DB._db.prepare('SELECT * FROM f1_accounts WHERE id = ?').get(id);
    check(add.status === 200 && row && row.region === 'BR' && /^v1\./.test(row.pw_enc) && !row.pw_enc.includes(PW) && row.pw_set_at > 0,
      '4 新增帳號：國碼轉大寫、密碼以 v1 密文存放（資料庫裡找不到明文）', JSON.stringify(add.data));
  }
  {
    const ov = await get(env, '/v1/admin/resell');
    const txt = JSON.stringify(ov.data);
    const a = ov.data.accounts.find((x) => x.id === id);
    check(ov.status === 200 && a && a.has_pw === true && !txt.includes('pw_enc') && !txt.includes('v1.') && !txt.includes(PW),
      '5 代訂總覽：只有 has_pw，不帶 pw_enc、不帶密文、不帶密碼');
    check(ov.data.summary.renewingSoon.includes(id) && ov.data.summary.byStatus.shared === 1,
      '5b 總覽的摘要：3 天後扣款的帳號列在「即將」、狀態計數正確', JSON.stringify(ov.data.summary));
  }
  {
    const before = env.RESELL_DB._db.prepare("SELECT COUNT(*) AS n FROM f1_events WHERE kind = 'pw_reveal'").get().n;
    const rv = await post(env, '/v1/admin/resell/reveal', { id });
    const after = env.RESELL_DB._db.prepare("SELECT COUNT(*) AS n FROM f1_events WHERE kind = 'pw_reveal'").get().n;
    check(rv.status === 200 && rv.data.password === PW && after === before + 1,
      '6 顯示密碼：解密正確，而且每看一次記一筆 pw_reveal', JSON.stringify([rv.status, before, after]));
  }
  {
    // AAD：把兩列的密文對調，解密一定要失敗（不可以把 A 的密碼交給 B）
    const b2 = await post(env, '/v1/admin/resell/account', Object.assign({}, base, { login_email: 'f1-003@pitlingo.test', password: 'other-pw-123' }));
    const db = env.RESELL_DB._db;
    const e1 = db.prepare('SELECT pw_enc FROM f1_accounts WHERE id = ?').get(id).pw_enc;
    const e2 = db.prepare('SELECT pw_enc FROM f1_accounts WHERE id = ?').get(b2.data.id).pw_enc;
    db.prepare('UPDATE f1_accounts SET pw_enc = ? WHERE id = ?').run(e2, id);
    const rv = await post(env, '/v1/admin/resell/reveal', { id });
    const logged = db.prepare("SELECT COUNT(*) AS n FROM f1_events WHERE kind = 'pw_reveal_fail' AND account_id = ?").get(id).n;
    db.prepare('UPDATE f1_accounts SET pw_enc = ? WHERE id = ?').run(e1, id);
    check(rv.status === 500 && !rv.data.password && logged === 1,
      '7 密文綁著登入信箱：兩列密文對調後解密失敗（而且記一筆失敗），不會交出別人的密碼', JSON.stringify(rv));
  }
  {
    // 改信箱不給新密碼 → 拒絕；給了 → 可以，而且新密文解得開
    const r1 = await post(env, '/v1/admin/resell/account', Object.assign({}, base, { id, login_email: 'f1-001b@pitlingo.test' }));
    const r2 = await post(env, '/v1/admin/resell/account', Object.assign({}, base, { id, login_email: 'f1-001b@pitlingo.test', password: PW + '2' }));
    const rv = await post(env, '/v1/admin/resell/reveal', { id });
    // 只改備註：密碼與設定時間都不動
    const setAt = env.RESELL_DB._db.prepare('SELECT pw_set_at FROM f1_accounts WHERE id = ?').get(id).pw_set_at;
    const r3 = await post(env, '/v1/admin/resell/account', Object.assign({}, base, { id, login_email: 'f1-001b@pitlingo.test', note: '試單帳號' }));
    const rv2 = await post(env, '/v1/admin/resell/reveal', { id });
    const setAt2 = env.RESELL_DB._db.prepare('SELECT pw_set_at FROM f1_accounts WHERE id = ?').get(id).pw_set_at;
    check(r1.status === 400 && r2.status === 200 && rv.data.password === PW + '2' && r3.status === 200 && rv2.data.password === PW + '2' && setAt === setAt2,
      '8 改登入信箱要重新輸入密碼；只改備註時密碼與設定時間都不動', JSON.stringify([r1.status, r2.status, r3.status, setAt, setAt2]));
  }

  // 9) 輸入的防呆
  {
    const full = await post(env, '/v1/admin/resell/account', Object.assign({}, base, { login_email: 'f1-009@pitlingo.test', card_ref: '4242 4242 4242 4242' }));
    const pro = await post(env, '/v1/admin/resell/account', Object.assign({}, base, { login_email: 'f1-010@pitlingo.test', tier: 'pro' }));
    const dup = await post(env, '/v1/admin/resell/account', Object.assign({}, base, { login_email: 'F1-003@pitlingo.test' }));
    const reg = await post(env, '/v1/admin/resell/account', Object.assign({}, base, { login_email: 'f1-011@pitlingo.test', region: 'Brazil' }));
    check(full.status === 400 && pro.status === 400 && dup.status === 400 && /已經在庫存/.test(dup.data.error) && reg.status === 400,
      '9 不收完整卡號、共用帳號不能用 Pro、同一個信箱（不分大小寫）不能重複、國碼要兩碼',
      JSON.stringify([full.status, pro.status, dup.status, dup.data.error, reg.status]));
  }

  // 10) 成本
  {
    const now = Math.floor(Date.now() / 1000);
    const c1 = await post(env, '/v1/admin/resell/cost', { account_id: id, period_from: now, period_until: now + 30 * 86400, amount_local: 28.9, currency: 'brl', amount_twd: 172 });
    const bad = await post(env, '/v1/admin/resell/cost', { account_id: id, period_from: now, period_until: now - 1, amount_twd: 172 });
    const ghost = await post(env, '/v1/admin/resell/cost', { account_id: 9999, period_from: now, period_until: now + 1, amount_twd: 1 });
    const ov = await get(env, '/v1/admin/resell');
    const c = ov.data.costs.find((x) => x.account_id === id);
    check(c1.status === 200 && bad.status === 400 && ghost.status === 404 && c && c.twd === 172 && c.n === 1,
      '10 成本：記實扣台幣、期間顛倒拒絕、不存在的帳號拒絕、總覽加總正確', JSON.stringify([c1.status, bad.status, ghost.status, c]));
  }

  // 11) 採購區：存一次就更新核對日期，超過 30 天標成過期
  {
    const r = await post(env, '/v1/admin/resell/region', { region: 'br', currency: 'BRL', prem_month: 28.9, price_basis: 'local' });
    let ov = await get(env, '/v1/admin/resell');
    const fresh = ov.data.regions.find((x) => x.region === 'BR');
    advanceDays(31);
    ov = await get(env, '/v1/admin/resell');
    const stale = ov.data.regions.find((x) => x.region === 'BR');
    const r2 = await post(env, '/v1/admin/resell/region', { region: 'BR', currency: 'BRL', prem_month: 29.9, price_basis: 'local' });
    ov = await get(env, '/v1/admin/resell');
    const again = ov.data.regions.find((x) => x.region === 'BR');
    advanceDays(-31);
    check(r.status === 200 && fresh && !fresh.stale && stale.stale && ov.data.summary && r2.status === 200 && !again.stale && again.prem_month === 29.9,
      '11 採購區價格：31 天沒核對標成過期、重新存一次就恢復（核對日期＝最後一次親眼看結帳頁）',
      JSON.stringify([fresh && fresh.stale, stale && stale.stale, again && again.stale]));
  }

  // 12) 全域查詢：一定要拿到最新的訂單（不走 5 分鐘快取）
  {
    const kv = env.SUBS;
    const at = Math.floor(Date.now() / 1000);
    await kv.put('ord:PL24A001', JSON.stringify({ no: 'PL24A001', email: 'Fan@Example.com', status: 'paid', price: 699 }),
      { metadata: { s: 'paid', at, t: 699, e: 'fan@example.com', l: 'F1TV Premium 代訂 1 個月', n: 1, m: 1 } });
    await A.orderRows(env);                         // 暖快取（這時只有第一筆）
    await kv.put('ord:PL24A002', JSON.stringify({ no: 'PL24A002', email: 'fan@example.com', status: 'paid', price: 49 }),
      { metadata: { s: 'paid', at: at + 1, t: 49, e: 'fan@example.com', l: '比賽週通行證', m: 1 } });
    const cached = await A.accountView(env, 'fan@example.com');
    const s = await get(env, '/v1/admin/search?q=fan@example.com');
    const nos = (s.data.customer && s.data.customer.purchases || []).map((p) => p.no);
    check(cached.purchases.length === 1 && s.status === 200 && nos.includes('PL24A002') && nos.includes('PL24A001'),
      '12 全域查詢不走快取：快取裡還沒有的新訂單，查詢查得到（一般的帳號頁仍走快取，鐵則 47）',
      JSON.stringify([cached.purchases.length, nos]));
  }
  {
    // 用訂單編號查，推得出客戶；用授權碼查也一樣
    await env.SUBS.put('lic:PLABCD2345EFGH', JSON.stringify({ plan: 'week', acct: 'fan@example.com', email: 'fan@example.com', orderId: 'PL24A002', devices: [] }));
    const byOrder = await get(env, '/v1/admin/search?q=pl24a001');
    const byLic = await get(env, '/v1/admin/search?q=PL-ABCD-2345-EFGH');
    check(byOrder.data.order && byOrder.data.customer && byOrder.data.customer.account === 'fan@example.com'
      && byLic.data.license && byLic.data.customer && byLic.data.customer.account === 'fan@example.com',
      '13 用訂單編號（不分大小寫）或授權碼查，都推得出同一個客戶',
      JSON.stringify([!!byOrder.data.order, byLic.data.license && byLic.data.license.licenseKey]));
  }
  {
    const s = await get(env, '/v1/admin/search?q=f1-003');
    const like = await get(env, '/v1/admin/search?q=f1_');
    const txt = JSON.stringify(s.data);
    const ev = await get(env, '/v1/admin/resell/events?account_id=' + id);
    check(s.data.f1Accounts.length === 1 && s.data.f1Accounts[0].login_email === 'f1-003@pitlingo.test' && !txt.includes('pw_enc') && !txt.includes(PW)
      && like.data.f1Accounts.length === 0,
      '14 查 F1TV 帳號：找得到、不帶密碼；「f1_」的底線當字面比對，不會把整個庫存列出來',
      JSON.stringify([s.data.f1Accounts.length, like.data.f1Accounts.length]));
    check(ev.status === 200 && ev.data.events.length >= 4 && ev.data.events.every((e) => !String(e.detail || '').includes(PW)),
      '15 事件紀錄：新增、改、設密碼、看密碼、成本都有記，而且沒有任何一筆含密碼', String(ev.data.events.length));
  }

  // 16) 靜態：pw_enc 只出現在允許的地方；後台回應一律 no-store
  {
    const mod = rawSrc.slice(rawSrc.indexOf('const RESELL_TIERS'), rawSrc.indexOf('/** 管理端路由'));
    const selects = [...mod.matchAll(/SELECT[^`'"]*?FROM f1_accounts/g)].map((m) => m[0]);
    // SELECT * 或 pw_enc（COUNT(*) 不算）
    const leaking = selects.filter((s2) => /^SELECT \*|\bpw_enc\b(?! IS NOT NULL)/.test(s2) && !/^SELECT (login_email, pw_enc|id, login_email, pw_enc, pw_set_at) FROM/.test(s2));
    // JOIN 進來的帳號表也一樣：不准 f.* 或 f.pw_enc
    const joins = [...mod.matchAll(/SELECT[^`'"]*?JOIN f1_accounts (\w+)/g)]
      .filter((m) => new RegExp('\\b' + m[1] + '\\.(\\*|pw_enc)').test(m[0]));
    leaking.push(...joins.map((m) => m[0]));
    check(selects.length >= 4 && !leaking.length,
      `16 讀 f1_accounts 的 ${selects.length} 個 SELECT 裡，只有「顯示密碼」與「存檔前比對」讀 pw_enc，沒有 SELECT *`, leaking.join(' | '));
    check(/'cache-control': 'no-store'[^\n]*ADMIN_CORS/.test(rawSrc),
      '16b 後台的每一個回應都帶 cache-control: no-store（密碼揭露、客戶資料不可以被任何一層快取）');
  }

  // =========================================================================
  // 第 2 階段：指派、席次、保留名額、帳號模式
  // =========================================================================
  const sellable = A.gpList().filter((g) => A.gpSellable(g));
  const GP = A.gpId(sellable[0]);
  const GP2 = sellable[1] ? A.gpId(sellable[1]) : GP;
  const at0 = Math.floor(Date.now() / 1000);
  let seq = 0;
  /** 放一筆已付款的訂單到 KV（webhook 寫完的樣子），回傳訂單編號。 */
  async function paidOrder(env2, services, email) {
    const no = 'PLT' + String(++seq).padStart(6, '0');
    const o = { no, email: email || `c${seq}@example.com`, status: 'paid', price: 1, services };
    await env2.SUBS.put('ord:' + no, JSON.stringify(o),
      { metadata: { s: 'paid', at: at0 + seq, t: 1, e: o.email, l: 'x', n: 1, m: 1 } });
    return no;
  }
  const svc = (key, extra) => Object.assign({ key, qty: 1, label: key, status: 'pending' }, extra || {});
  const asgOf = (env2, no) => env2.RESELL_DB._db.prepare('SELECT * FROM f1_assignments WHERE order_no = ? ORDER BY line_idx').all(no).map((r) => Object.assign({}, r));
  async function addAcc(env2, email, extra) {
    const r = await post(env2, '/v1/admin/resell/account', Object.assign({ login_email: email, region: 'BR', tier: 'premium', billing: 'monthly', status: 'available' }, extra || {}));
    return r.data.id;
  }

  // 20) migration 0002
  {
    const t = newEnv().RESELL_DB._db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    check(['f1_assignments', 'f1_seats', 'f1_holds', 'f1_settings'].every((x) => t.includes(x)), '20 migration 0002 建出指派、席次、保留、設定四張表', t.join(','));
  }

  // 21) 同步：付款的訂單變成待處理指派；重跑不重複；舊訂單沒記模式就用方案預設；年方案＝自備
  const e2 = newEnv();
  {
    const no = await paidOrder(e2, [svc('svc_prem_1m_own', { qty: 3 }), svc('svc_pro_1y_own'), svc('svc_pro_5d', { gp: GP })]);
    const n1 = await A.resellSyncOrder(e2, no);
    const n2 = await A.resellSyncOrder(e2, no);
    const rows = asgOf(e2, no);
    check(n1 === 3 && n2 === 0 && rows.length === 3
      && rows[0].mode === 'ours' && rows[0].months === 3 && rows[1].mode === 'byo' && rows[1].months === 12
      && rows[2].mode === 'shared' && rows[2].gp_id === GP && rows.every((r) => r.status === 'pending' && r.cust_acct.endsWith('@example.com')),
      '21 付款訂單同步成待處理指派：一個月×3＝我們提供 3 個月、年方案＝自備 12 個月、週末＝共用並記場次；重跑不重複',
      JSON.stringify(rows.map((r) => [r.mode, r.months, r.gp_id])));
  }
  {
    // 補同步：webhook 當下沒寫進 D1 的訂單，後台按同步會補上；未付款的不碰
    const no = await paidOrder(e2, [svc('svc_pro_1m_own')]);
    await e2.SUBS.put('ord:PLTUNPAID', JSON.stringify({ no: 'PLTUNPAID', status: 'created', services: [svc('svc_pro_1m_own')] }),
      { metadata: { s: 'created', at: at0, e: 'u@example.com', n: 1 } });
    const r = await post(e2, '/v1/admin/resell/sync', {});
    check(r.status === 200 && asgOf(e2, no).length === 1 && asgOf(e2, 'PLTUNPAID').length === 0,
      '22 後台「同步」補上漏掉的已付款訂單，不碰未付款的', JSON.stringify(r.data));
  }

  // 23) 自備帳號不可以指派我方帳號；資料庫本身也擋（CHECK）
  {
    const no = await paidOrder(e2, [svc('svc_prem_1y_own')]);
    await A.resellSyncOrder(e2, no);
    const a = asgOf(e2, no)[0];
    const acc = await addAcc(e2, 'byo-test@pitlingo.test');
    const r = await post(e2, '/v1/admin/resell/assign', { id: a.id, account_id: acc });
    let dbBlocked = false;
    try { e2.RESELL_DB._db.prepare('UPDATE f1_assignments SET account_id = ? WHERE id = ?').run(acc, a.id); } catch (x) { dbBlocked = true; }
    check(r.status === 400 && dbBlocked, '23 自備帳號不連結任何 F1TV 帳號：指派被拒，直接改資料庫也被 CHECK 擋下');
  }

  // 24) 專屬帳號：方案等級要對；同一個帳號同時被兩筆訂單搶，只有一筆成功
  {
    const accPro = await addAcc(e2, 'pro-1@pitlingo.test', { tier: 'pro' });
    const accPrem = await addAcc(e2, 'prem-1@pitlingo.test');
    const no1 = await paidOrder(e2, [svc('svc_prem_1m_own')]);
    const no2 = await paidOrder(e2, [svc('svc_prem_1m_own')]);
    await A.resellSyncOrder(e2, no1); await A.resellSyncOrder(e2, no2);
    const a1 = asgOf(e2, no1)[0]; const a2 = asgOf(e2, no2)[0];
    const wrong = await post(e2, '/v1/admin/resell/assign', { id: a1.id, account_id: accPro });
    const both = await Promise.all([
      post(e2, '/v1/admin/resell/assign', { id: a1.id, account_id: accPrem }),
      post(e2, '/v1/admin/resell/assign', { id: a2.id, account_id: accPrem }),
    ]);
    const okN = both.filter((x) => x.status === 200).length;
    const st = e2.RESELL_DB._db.prepare('SELECT status FROM f1_accounts WHERE id = ?').get(accPrem).status;
    const holders = e2.RESELL_DB._db.prepare("SELECT COUNT(*) AS n FROM f1_assignments WHERE account_id = ? AND status IN ('pending','active')").get(accPrem).n;
    check(wrong.status === 400 && okN === 1 && st === 'assigned' && holders === 1,
      '24 專屬帳號：Pro 帳號不能給 Premium 訂單；同一個帳號被兩筆同時搶，只有一筆拿到',
      JSON.stringify([wrong.status, both.map((x) => x.status), st, holders]));
  }

  // 25) 共用帳號：1 個帳號、6 筆訂單同時搶同一場 → 剛好 4 筆有位子；第 2 個帳號開出來後再 4 席
  const e3 = newEnv();
  {
    await addAcc(e3, 'share-1@pitlingo.test', { status: 'shared' });
    const nos = [];
    for (let i = 0; i < 6; i++) { const no = await paidOrder(e3, [svc('svc_pro_5d', { gp: GP })]); await A.resellSyncOrder(e3, no); nos.push(no); }
    const ids = nos.map((no) => asgOf(e3, no)[0].id);
    const res = await Promise.all(ids.map((id) => post(e3, '/v1/admin/resell/assign', { id })));
    const okN = res.filter((x) => x.status === 200).length;
    const seats = e3.RESELL_DB._db.prepare('SELECT seat_no FROM f1_seats WHERE gp_id = ? ORDER BY seat_no').all(GP).map((r) => r.seat_no);
    const full = res.find((x) => x.status === 409);
    let fifth = false;
    try { e3.RESELL_DB._db.prepare('INSERT INTO f1_seats (gp_id, account_id, seat_no, assignment_id, created_at) VALUES (?, 1, 5, 999, 0)').run(GP); } catch (x) { fifth = true; }
    check(okN === 4 && seats.join() === '1,2,3,4' && full && /席次已滿/.test(full.data.error) && fifth,
      '25 共用帳號：6 筆同時搶同一場，剛好 4 筆拿到第 1～4 席，其餘回「已滿」；資料庫的 CHECK 也插不進第 5 席',
      JSON.stringify([okN, seats, res.map((x) => x.status)]));
    await addAcc(e3, 'share-2@pitlingo.test', { status: 'shared' });
    const rest = await Promise.all(ids.filter((id, i) => res[i].status !== 200).map((id) => post(e3, '/v1/admin/resell/assign', { id })));
    const per = e3.RESELL_DB._db.prepare('SELECT account_id, COUNT(*) AS n FROM f1_seats WHERE gp_id = ? GROUP BY account_id').all(GP).map((r) => r.n);
    check(rest.every((x) => x.status === 200) && per.join() === '4,2',
      '25b 加第 2 個共用帳號後，剩下的 2 筆排進第 2 個帳號（先塞滿第一個）', JSON.stringify(per));
    // 違規收回釋出席次，可以再賣；正常結束不釋出（那一場已經過了）
    const first = ids[0];
    const rv = await post(e3, '/v1/admin/resell/assignment', { id: first, action: 'revoke', note: '擅改密碼' });
    const left = e3.RESELL_DB._db.prepare('SELECT COUNT(*) AS n FROM f1_seats WHERE gp_id = ?').get(GP).n;
    const ev = e3.RESELL_DB._db.prepare("SELECT COUNT(*) AS n FROM f1_events WHERE kind = 'violation'").get().n;
    check(rv.status === 200 && left === 5 && ev === 1, '25c 違規收回：席次釋出（6 → 5）、記一筆違規事件', JSON.stringify([rv.status, left, ev]));
  }

  // 26) 開通的期間：一個月×3＝三個月後；共用＝那個週末週五 00:00（台灣）到正賽後 3 小時
  {
    const no = await paidOrder(e2, [svc('svc_pro_1m_own', { qty: 3 })]);
    await A.resellSyncOrder(e2, no);
    const a = asgOf(e2, no)[0];
    const accPro2 = await addAcc(e2, 'pro-2@pitlingo.test', { tier: 'pro' });
    const early = await post(e2, '/v1/admin/resell/assignment', { id: a.id, action: 'activate' });
    await post(e2, '/v1/admin/resell/assign', { id: a.id, account_id: accPro2 });
    const start = Date.UTC(2026, 9, 15) / 1000;
    const act = await post(e2, '/v1/admin/resell/assignment', { id: a.id, action: 'activate', starts_at: start });
    const order = JSON.parse(e2.SUBS._store.get('ord:' + no));
    const shared = (await (async () => {
      const no2 = await paidOrder(e3, [svc('svc_pro_5d', { gp: GP2 })]);
      await A.resellSyncOrder(e3, no2);
      const s2 = asgOf(e3, no2)[0];
      await post(e3, '/v1/admin/resell/assign', { id: s2.id });
      return (await post(e3, '/v1/admin/resell/assignment', { id: s2.id, action: 'activate' })).data;
    })());
    const g2 = A.gpById(GP2);
    check(early.status === 400 && act.status === 200 && act.data.ends_at === Date.UTC(2027, 0, 15) / 1000
      && order.services[0].status === 'done'
      && shared.ends_at === A.gpHandoverSec(g2) && shared.starts_at < shared.ends_at,
      '26 開通：沒指派帳號不能開通；一個月×3 從 10/15 到 1/15；訂單的「代訂待處理」跟著結案；共用帳號到正賽後 3 小時',
      JSON.stringify([early.status, act.data, order.services[0].status, shared]));
    // 到期 → 帳號進「回收中」（要先改密碼才能再用）
    const end = await post(e2, '/v1/admin/resell/assignment', { id: a.id, action: 'end' });
    const st = e2.RESELL_DB._db.prepare('SELECT status FROM f1_accounts WHERE id = ?').get(accPro2).status;
    check(end.status === 200 && st === 'recovering', '26b 到期：帳號進「回收中」，不會直接回到可指派（要先改密碼）', st);
  }

  // 27) 退款：還沒處理的指派自動取消，帳號回到可指派
  {
    const acc = await addAcc(e2, 'refund-1@pitlingo.test');
    const no = await paidOrder(e2, [svc('svc_prem_1m_own')]);
    await A.resellSyncOrder(e2, no);
    const a = asgOf(e2, no)[0];
    await post(e2, '/v1/admin/resell/assign', { id: a.id, account_id: acc });
    const o = JSON.parse(e2.SUBS._store.get('ord:' + no)); o.status = 'refunded';
    await e2.SUBS.put('ord:' + no, JSON.stringify(o), { metadata: { s: 'refunded', at: at0, e: o.email } });
    await post(e2, '/v1/admin/resell/sync', {});
    const after = asgOf(e2, no)[0];
    const st = e2.RESELL_DB._db.prepare('SELECT status FROM f1_accounts WHERE id = ?').get(acc).status;
    check(after.status === 'cancelled' && st === 'available', '27 退款的訂單：同步時指派改成取消、沒交付過的帳號回到可指派', JSON.stringify([after.status, st]));
  }

  // 28) 結帳保留名額：上限關著不檢查；打開後 1 個共用帳號＝4 個名額，8 個人同時結帳只有 4 個成功；過期的不算
  {
    const e4 = newEnv();
    const off = await A.resellHoldShared(e4, 'PLH0', GP);
    await post(e4, '/v1/admin/resell/settings', { sharedCap: true });
    const zero = await A.resellHoldShared(e4, 'PLH00', GP);
    await addAcc(e4, 'hold-1@pitlingo.test', { status: 'shared' });
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => A.resellHoldShared(e4, 'PLH' + (i + 1), GP)));
    const okN = res.filter((x) => x.ok).length;
    const other = await A.resellHoldShared(e4, 'PLH9', GP2 === GP ? 'zz' : GP2);
    advanceDays(1);
    const later = await A.resellHoldShared(e4, 'PLH10', GP);
    advanceDays(-1);
    check(off.ok && off.skipped && !zero.ok && okN === 4 && other.ok && later.ok,
      '28 結帳保留名額：上限關著不檢查；打開後沒有共用帳號就是 0 個名額；8 人同時結帳剛好 4 人成功；別場不受影響；沒付款的保留 2 小時後釋出',
      JSON.stringify([off, zero.ok, okN, other.ok, later.ok]));
    // 付款後保留轉成指派：不可以算兩次（要從後端的 resellHoldShared 驗，不能用測試自己的 SQL）
    // 1 個共用帳號＝4 個名額；2 筆保留都付款轉成指派 → 應該還剩 2 個名額。重複計算的話一個都不剩。
    const e5 = newEnv();
    await post(e5, '/v1/admin/resell/settings', { sharedCap: true });
    await addAcc(e5, 'hold-2@pitlingo.test', { status: 'shared' });
    for (const no of ['PLK1', 'PLK2']) {
      await A.resellHoldShared(e5, no, GP);
      await e5.SUBS.put('ord:' + no, JSON.stringify({ no, email: no + '@example.com', status: 'paid', services: [svc('svc_pro_5d', { gp: GP })] }),
        { metadata: { s: 'paid', at: at0, e: no + '@example.com', n: 1 } });
      await A.resellSyncOrder(e5, no);
    }
    const more = await Promise.all(['PLK3', 'PLK4', 'PLK5'].map((no) => A.resellHoldShared(e5, no, GP)));
    const moreOk = more.filter((x) => x.ok).length;
    check(moreOk === 2, '28b 付款後保留轉成指派，不會同時算成保留又算成指派：2 筆轉成指派後還能再保留 2 筆（第 3 筆滿）', String(moreOk));
  }

  // 29) 結帳的帳號模式
  {
    const envOff = newEnv();
    const envOn = newEnv({ RESELL_BYO_MONTHLY: '1' });
    const q1 = await A.quoteCart(envOff, [{ key: 'svc_prem_1m_own', qty: 1 }]);
    const q2 = await A.quoteCart(envOff, [{ key: 'svc_prem_1m_own', qty: 1, acct: 'byo' }]);
    const q3 = await A.quoteCart(envOn, [{ key: 'svc_prem_1m_own', qty: 1, acct: 'byo' }]);
    const q4 = await A.quoteCart(envOn, [{ key: 'svc_prem_1m_own', qty: 2, acct: 'byo' }]);
    const q5 = await A.quoteCart(envOn, [{ key: 'svc_prem_1m_own', qty: 3, acct: 'ours' }]);
    const q6 = await A.quoteCart(envOn, [{ key: 'svc_prem_1y_own', qty: 1, acct: 'ours' }]);
    const l = (q) => (q.lines || []).find((x) => x.key === 'svc_prem_1m_own' || x.key === 'svc_prem_1y_own');
    check(!q1.error && l(q1).acctMode === 'ours' && q2.error && !q3.error && l(q3).acctMode === 'byo' && /自己的 F1TV 帳號/.test(l(q3).label)
      && q4.error && /1 (個月|份)/.test(q4.error) && q5.error && /1 份/.test(q5.error) && q6.error,
      '29 帳號模式：沒選＝我們提供；條款上線前（RESELL_BYO_MONTHLY 沒開）選自備被拒；開了之後可選、自備限 1 份、我們提供也限 1 份（2026-10-30 起）；年方案不能選我們提供',
      JSON.stringify([q1.error, q2.error, q3.error, q4.error, q5.error, q6.error]));
  }

  // 30) 靜態：付款到同步，模式與場次一路帶著
  {
    const checks = [
      [/items: quote\.lines\.map\(\(l\) => \(\{[^}]*acct: l\.acctMode/, '結帳暫存（pending.items）帶 acct'],
      [/services: quote\.lines\.filter[\s\S]{0,200}gp: l\.gp \|\| null, acctMode: l\.acctMode/, '訂單的 services 帶 gp 與 acctMode'],
      [/gp: s\.gp \|\| null, acctMode: s\.acct \|\| null/, 'webhook 覆寫的 services 帶 gp 與 acctMode'],
      [/try \{ await resellSyncOrder\(env, orderId\); \} catch/, 'webhook 付款後同步指派（包在 try 裡，失敗不擋發碼）'],
      [/try \{ h = await resellHoldShared\(env, no, l\.gp\); \} catch \(e\) \{ h = \{ ok: false, error: true \}; \}/, '結帳保留名額查不到時擋下（不知道有沒有位子就不收錢）'],
    ];
    const miss = checks.filter(([re]) => !re.test(rawSrc)).map(([, m]) => m);
    check(!miss.length, '30 付款流程的每一站都帶著帳號模式與場次；webhook 同步、結帳保留的失敗處理都在', miss.join('、'));
  }

  // =========================================================================
  // 代理商交付（backend v5.61，2026-10-23）
  // =========================================================================
  {
    const cols = newEnv().RESELL_DB._db.prepare('PRAGMA table_info(f1_accounts)').all().map((r) => r.name);
    const acols = newEnv().RESELL_DB._db.prepare('PRAGMA table_info(f1_assignments)').all().map((r) => r.name);
    check(['source', 'agent_sku', 'share'].every((c) => cols.includes(c)) && ['delivered_at', 'mail_status'].every((c) => acols.includes(c)),
      '40 migration 0003：庫存有來源／代理商品項／型態，指派有交付時間與寄信結果', cols.concat(acols).join(','));
  }
  const mails = [];
  sandbox.fetch = async (u, init) => { if (String(u).includes('resend.com')) { mails.push(JSON.parse(init.body)); return { ok: true, status: 200 }; } throw new Error('未預期的網路呼叫：' + u); };
  const e6 = newEnv({ RESEND_API_KEY: 're_test', MAIL_FROM: 'PitLingo <noreply@pitlingo.test>' });
  const AGPW = 'Agent-PW-8841';
  {
    const no = await paidOrder(e6, [svc('svc_prem_1m_own')], 'Buyer@Example.com');
    await A.resellSyncOrder(e6, no);
    const a = asgOf(e6, no)[0];
    const r = await post(e6, '/v1/admin/resell/deliver', { id: a.id, login_email: 'Agent-001@Mail.test', password: AGPW, agent_sku: '1个月Premium【独享】', cost_cny: 114.09, cost_twd: 505 });
    const db = e6.RESELL_DB._db;
    const acc = db.prepare('SELECT * FROM f1_accounts WHERE id = ?').get(r.data.account_id);
    const after = asgOf(e6, no)[0];
    const order = JSON.parse(e6.SUBS._store.get('ord:' + no));
    const cost = db.prepare('SELECT * FROM f1_costs WHERE account_id = ?').get(r.data.account_id);
    const m = mails[mails.length - 1];
    const span = after.ends_at - after.starts_at;
    check(r.status === 200 && acc.source === 'agent' && acc.share === 'solo' && acc.region === 'XX' && acc.status === 'assigned'
      && /^v1\./.test(acc.pw_enc) && !acc.pw_enc.includes(AGPW) && after.status === 'active' && after.delivered_at > 0
      && span >= 28 * 86400 && span <= 31 * 86400 && order.services[0].status === 'done'
      && cost && cost.amount_twd === 505 && cost.currency === 'CNY' && after.mail_status === 'sent',
      '41 代理商交付（一個月）：一個動作完成進庫存（加密、型態獨享）、綁訂單、開通一個月、訂單結案、記人民幣成本、寄信',
      JSON.stringify([r.status, r.data, acc && acc.share, after.status, span, cost && cost.amount_twd, after.mail_status]));
    check(m && m.to[0] === 'buyer@example.com' && !JSON.stringify(m).includes(AGPW) && !JSON.stringify(m).includes('agent-001@mail.test')
      && /\/account/.test(m.html) && /請勿更改/.test(m.html),
      '42 交付通知信：寄到購買信箱、**沒有密碼也沒有 F1TV 登入信箱**、只叫人登入我的帳號、提醒不可改密碼', m && m.subject);
    const view = await A.customerF1(e6, ['buyer@example.com']);
    const txt = JSON.stringify(view);
    const rv = await A.customerF1Reveal(e6, ['BUYER@example.com'], a.id, 'Mozilla/5.0 (iPhone)');
    const other = await A.customerF1Reveal(e6, ['someone@example.com'], a.id, '');
    const logs = db.prepare("SELECT * FROM f1_events WHERE kind = 'cust_reveal'").all();
    check(view.length === 1 && view[0].state === 'ready' && view[0].loginEmail === 'agent-001@mail.test' && view[0].canReveal && !txt.includes(AGPW)
      && rv.status === 200 && rv.body.password === AGPW && other.status === 404 && logs.length === 1 && logs[0].actor === 'customer' && logs[0].detail === '行動裝置',
      '43 我的帳號：清單不帶密碼；按顯示才解密、記一筆（客戶、裝置類型）；別人的帳號用同一個 id 拿不到',
      JSON.stringify([view, rv.status, other.status, logs.length]));
  }
  {
    const noB = await paidOrder(e6, [svc('svc_prem_1y_own')]); await A.resellSyncOrder(e6, noB);
    const byo = await post(e6, '/v1/admin/resell/deliver', { id: asgOf(e6, noB)[0].id, login_email: 'x@mail.test', password: AGPW });
    await addAcc(e6, 'self-1@pitlingo.test');
    const noS = await paidOrder(e6, [svc('svc_prem_1m_own')]); await A.resellSyncOrder(e6, noS);
    const aS = asgOf(e6, noS)[0];
    const self = await post(e6, '/v1/admin/resell/deliver', { id: aS.id, login_email: 'self-1@pitlingo.test', password: AGPW });
    const noP = await paidOrder(e6, [svc('svc_pro_1m_own')]); await A.resellSyncOrder(e6, noP);
    const tierBad = await post(e6, '/v1/admin/resell/deliver', { id: asgOf(e6, noP)[0].id, login_email: 'agent-001@mail.test', password: AGPW });
    const noPw = await post(e6, '/v1/admin/resell/deliver', { id: aS.id, login_email: 'agent-009@mail.test', password: '' });
    const twice = await post(e6, '/v1/admin/resell/deliver', { id: aS.id, login_email: 'agent-010@mail.test', password: AGPW });
    const again = await post(e6, '/v1/admin/resell/deliver', { id: aS.id, login_email: 'agent-011@mail.test', password: AGPW });
    check(byo.status === 400 && self.status === 400 && tierBad.status === 400 && noPw.status === 400 && twice.status === 200 && again.status === 400,
      '44 交付防呆：充值（自備）不交付帳密、自營帳號的信箱不能冒充代理商帳號、Pro／Premium 不符、沒密碼、同一筆不能交付兩次',
      JSON.stringify([byo.status, self.status, tierBad.status, noPw.status, twice.status, again.status]));
  }
  {
    const now = Math.floor(Date.now() / 1000);
    const fut = A.gpList().filter((g) => A.gpSellable(g)).map((g) => A.gpId(g))
      .find((g) => A.resellPeriod({ mode: 'shared', gp_id: g }).starts > now + 86400);
    if (!fut) { console.log('⚠️ 45 跳過：賽程裡沒有一天後才開始的可售場次'); } else {
      const n1 = await paidOrder(e6, [svc('svc_pro_5d', { gp: fut })], 'w1@example.com'); await A.resellSyncOrder(e6, n1);
      const n2 = await paidOrder(e6, [svc('svc_pro_5d', { gp: fut })], 'w2@example.com'); await A.resellSyncOrder(e6, n2);
      const d1 = await post(e6, '/v1/admin/resell/deliver', { id: asgOf(e6, n1)[0].id, login_email: 'wk-01@mail.test', password: AGPW, agent_sku: '单个比赛周末Premium【仅使用网页端】' });
      const m = mails[mails.length - 1];
      const d2 = await post(e6, '/v1/admin/resell/deliver', { id: asgOf(e6, n2)[0].id, login_email: 'WK-01@mail.test', password: AGPW + '2' });
      const db = e6.RESELL_DB._db;
      const rows = db.prepare("SELECT id, share FROM f1_accounts WHERE login_email = 'wk-01@mail.test'").all();
      const per = A.resellPeriod({ mode: 'shared', gp_id: fut });
      const early = await A.customerF1(e6, ['w1@example.com']);
      const earlyRv = await A.customerF1Reveal(e6, ['w1@example.com'], asgOf(e6, n1)[0].id, '');
      offset += (per.starts - now + 60) * 1000;
      const open = await A.customerF1(e6, ['w1@example.com']);
      const rv1 = await A.customerF1Reveal(e6, ['w1@example.com'], asgOf(e6, n1)[0].id, '');
      check(d1.status === 200 && d2.status === 200 && rows.length === 1 && rows[0].share === 'weekend'
        && early[0].state === 'scheduled' && early[0].loginEmail === null && earlyRv.status === 409 && /起出現/.test(m.html)
        && open[0].state === 'ready' && rv1.status === 200 && rv1.body.password === AGPW + '2',
        '45 單一比賽週末：同一個代理商帳號給兩位客戶只存一列（密碼以最新的為準）；週五 00:00 前帳號頁看不到、信裡講幾點出現；之後看得到',
        JSON.stringify([d1.status, d2.status, rows.length, early[0] && early[0].state, earlyRv.status, open[0] && open[0].state, rv1.status]));
      offset += (per.ends - per.starts + 60) * 1000;
      const late = await A.customerF1Reveal(e6, ['w1@example.com'], asgOf(e6, n1)[0].id, '');
      const n = await A.resellExpire(e6);
      const acc = db.prepare("SELECT status, pw_enc FROM f1_accounts WHERE login_email = 'wk-01@mail.test'").get();
      const ended = asgOf(e6, n1)[0].status;
      check(late.status === 409 && n >= 2 && acc.status === 'disabled' && acc.pw_enc === null && ended === 'ended',
        '46 結束後：帳號頁拿不到密碼；排程把指派收尾，兩位客戶都結束後才停用帳號並清掉密文',
        JSON.stringify([late.status, n, acc, ended]));
      offset = 0;
    }
  }
  {
    const e7 = newEnv();
    const nA = await paidOrder(e7, [svc('svc_prem_1m_own')]); await A.resellSyncOrder(e7, nA);
    const nB = await paidOrder(e7, [svc('svc_pro_5d', { gp: GP })]); await A.resellSyncOrder(e7, nB);
    await post(e7, '/v1/admin/resell/deliver', { id: asgOf(e7, nA)[0].id, login_email: 'mix@mail.test', password: AGPW, share: '6' });
    await post(e7, '/v1/admin/resell/deliver', { id: asgOf(e7, nB)[0].id, login_email: 'mix@mail.test', password: AGPW });
    await post(e7, '/v1/admin/resell/assignment', { id: asgOf(e7, nB)[0].id, action: 'cancel' });
    const acc = e7.RESELL_DB._db.prepare("SELECT status, pw_enc FROM f1_accounts WHERE login_email = 'mix@mail.test'").get();
    const remail = await post(e7, '/v1/admin/resell/remail', { id: asgOf(e7, nA)[0].id });
    check(acc.status === 'assigned' && acc.pw_enc && remail.status === 200 && remail.data.mail === 'not_configured',
      '47 合用帳號：其中一位取消時，另一位還在用就不停用、不清密文；重寄通知沒設寄信時照實回報',
      JSON.stringify([acc.status, !!acc.pw_enc, remail.data]));
  }
  {
    const need = [
      [/const SITE_CRED_PATHS = new Set\(\[[\s\S]*?'\/v1\/account\/f1\/reveal'[\s\S]*?\]\);/, '顯示密碼的端點可以帶登入 cookie'],
      [/customerF1Reveal\(env[^\n]*\n[^\n]*return json\(r\.body, r\.status, \{ 'cache-control': 'no-store' \}\)/, '顯示密碼的回應 no-store'],
      [/lifetimeTwd:[\s\S]{0,80}\}, 200, \{ 'cache-control': 'no-store' \}\)/, '帳號頁（含 F1TV 登入信箱）no-store'],
      [/if \(!csrfOk\(request, sess\)\) return err\('請求來源不符', 403, 'E57'\);\s*\r?\n\s*if \(await authLimited\(env, 'f1reveal'/, '顯示密碼要過 CSRF 與次數上限'],
      [/try \{ await resellExpire\(env\); \} catch/, '每日排程會收尾到期的代訂'],
    ];
    const miss = need.filter(([re]) => !re.test(rawSrc)).map(([, m2]) => m2);
    check(!miss.length, '48 帳號頁與顯示密碼：帶 cookie、CSRF、次數上限、no-store；排程收尾', miss.join('、'));
  }

  {
    // 交付時品項填錯：代理商帳號可以在「修改帳號」改品項與型態，密碼不動；自營帳號不收這兩欄
    const e8 = newEnv();
    const no = await paidOrder(e8, [svc('svc_pro_5d', { gp: GP })]); await A.resellSyncOrder(e8, no);
    const d = await post(e8, '/v1/admin/resell/deliver', { id: asgOf(e8, no)[0].id, login_email: 'fix@mail.test', password: AGPW, agent_sku: '单个比赛周末Premium【仅使用网页端】' });
    const fix = await post(e8, '/v1/admin/resell/account', { id: d.data.account_id, login_email: null, region: 'XX', tier: 'pro', billing: 'monthly', status: 'assigned', agent_sku: '1个月Pro【独享】', share: 'solo' });
    const row = e8.RESELL_DB._db.prepare('SELECT tier, agent_sku, share, pw_enc FROM f1_accounts WHERE id = ?').get(d.data.account_id);
    const rv = await post(e8, '/v1/admin/resell/reveal', { id: d.data.account_id });
    const badShare = await post(e8, '/v1/admin/resell/account', { id: d.data.account_id, login_email: null, region: 'XX', tier: 'pro', status: 'assigned', share: 'family' });
    const selfId = await addAcc(e8, 'self-9@pitlingo.test');
    const selfFix = await post(e8, '/v1/admin/resell/account', { id: selfId, region: 'BR', tier: 'premium', status: 'available', login_email: 'self-9@pitlingo.test', agent_sku: 'x' });
    check(fix.status === 200 && row.tier === 'pro' && row.agent_sku === '1个月Pro【独享】' && row.share === 'solo' && rv.data.password === AGPW
      && badShare.status === 400 && selfFix.status === 400,
      '49 交付時品項填錯可以改：代理商帳號改品項與型態、密碼不動；型態要合法；自營帳號不收這兩欄',
      JSON.stringify([fix.status, row.tier, row.agent_sku, row.share, badShare.status, selfFix.status]));
  }

  console.log(errors.length ? `\n❌ ${errors.length} 項失敗` : '\n全部通過');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
