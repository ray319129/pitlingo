#!/usr/bin/env node
/**
 * 帳本（backend v5.65，migrations/0004_ledger.sql）。
 *
 * ⚠️ D1 用真的 SQLite（node:sqlite），schema 直接執行 backend/migrations/ 底下的正式檔案（同 check-resell）。
 *
 * 這裡每一條規則拿掉，帳本都還「看起來能用」，只是數字不再是真的：
 *    只從 KV 讀訂單        → 400 天後 KV 過期，收入從帳上消失（快照進 D1）
 *    用 UTC 分日分月        → 台灣早上 8 點以前的交易掉進前一天、前一個月
 *    沒有手續費就當 0       → 淨利高估，而且看不出來（要列出「缺手續費」）
 *    人工補登蓋過綠界通知   → 真實數字被手打的覆蓋
 *    可以刪                → 帳被改過看不出來（只能作廢、要寫原因、作廢的不算）
 *    付款通知沒存手續費     → 每一筆都要人工補
 *
 * 用法：node tools/check-ledger.js
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
vm.runInContext(src + '\n;this.__api = { routeAdmin, ledgerSyncOrders, ledgerDate };', sandbox);
const A = sandbox.__api;

function fakeKV() {
  const store = new Map();
  const meta = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, o) { store.set(k, v); if (o && o.metadata) meta.set(k, o.metadata); },
    async delete(k) { store.delete(k); meta.delete(k); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix || '')).map((name) => ({ name, metadata: meta.get(name) || {} })), list_complete: true };
    },
    _store: store,
  };
}
const MIGRATIONS = path.join(root, 'backend/migrations');
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  const plain = (r) => (r ? Object.assign({}, r) : r);
  const runSync = (sql, p) => { const r = db.prepare(sql).run(...p); return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; };
  const allSync = (sql, p) => ({ success: true, results: db.prepare(sql).all(...p).map(plain), meta: {} });
  const stmt = (sql, params) => ({
    _sql: sql, _params: params,
    bind(...a) { a.forEach((v, i) => { if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value at ${i + 1}`); }); return stmt(sql, a); },
    async first(col) { const r = db.prepare(sql).get(...params); if (r === undefined) return null; return col ? r[col] : plain(r); },
    async all() { return allSync(sql, params); },
    async run() { return runSync(sql, params); },
  });
  return {
    prepare: (sql) => stmt(sql, []),
    async batch(list) {
      db.exec('BEGIN');
      try { const out = list.map((s) => (/^\s*SELECT/i.test(s._sql) ? allSync(s._sql, s._params) : runSync(s._sql, s._params))); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    _db: db,
  };
}
const newEnv = (o) => Object.assign({ SUBS: fakeKV(), RESELL_DB: fakeD1() }, o || {});

async function call(env, method, p, body) {
  const url = new URL('https://api.test' + p);
  const req = { method, json: async () => (body === undefined ? null : JSON.parse(JSON.stringify(body))) };
  const res = await A.routeAdmin(url.pathname, req, env, url);
  if (!res) return { status: 404, data: { error: 'not routed' } };
  return { status: res.status || 200, data: JSON.parse(res.body) };
}
const post = (env, p, b) => call(env, 'POST', p, b);
const get = (env, p) => call(env, 'GET', p);

// 訂單照正式的樣子放進 KV：完整記錄＋列舉用的 metadata
async function putOrder(env, o) {
  await env.SUBS.put('ord:' + o.no, JSON.stringify(o), { metadata: { s: o.status, at: o.at, t: o.price, e: o.email || '', l: o.summary || '' } });
}
const utc = (s) => Math.floor(Date.parse(s) / 1000);

(async () => {
  // 1) migration
  {
    const t = newEnv().RESELL_DB._db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    check(['ledger_entries', 'ledger_orders'].every((x) => t.includes(x)), '1 migration 0004 建出帳本兩張表（與代訂共用同一個 D1）', t.join(','));
  }

  // 2) 沒有 D1：拒絕，不退回存 KV
  {
    const env = newEnv({ RESELL_DB: undefined });
    const r = await get(env, '/v1/admin/ledger');
    const w = await post(env, '/v1/admin/ledger/entry', { date: '2026-10-20', kind: 'expense', category: '網域', item: 'x', amount_twd: 100 });
    check(r.status === 503 && w.status === 503 && env.SUBS._store.size === 0, '2 沒有 D1：讀寫都 503，不退回存 KV', JSON.stringify([r.status, w.status]));
  }

  const env = newEnv();
  // 綠界通知有帶手續費的、沒帶的（v5.65 以前）、沒付款的、台灣時間跨月的
  await putOrder(env, { no: 'PLA1', status: 'paid', at: utc('2026-10-23T01:00:00Z'), paidAt: utc('2026-10-23T01:05:00Z'), price: 708, amount: 708, fee: 19.8, payType: 'Credit_CreditCard', tradeNo: 'T1', summary: 'Weekend Pass、代訂' });
  await putOrder(env, { no: 'PLA2', status: 'paid', at: utc('2026-10-24T03:00:00Z'), paidAt: utc('2026-10-24T03:00:00Z'), price: 49, summary: 'Weekend Pass' });
  await putOrder(env, { no: 'PLA3', status: 'created', at: utc('2026-10-24T04:00:00Z'), price: 999, summary: '沒付款' });
  await putOrder(env, { no: 'PLA4', status: 'paid', at: utc('2026-10-31T20:00:00Z'), paidAt: utc('2026-10-31T20:00:00Z'), price: 49, amount: 49, fee: 2, summary: '跨月' });

  // 3) 同步＋收入、手續費、缺手續費
  const r = await get(env, '/v1/admin/ledger');
  const inc = (r.data.lines || []).filter((l) => l.src === 'order').map((l) => l.ref).sort();
  const fee1 = (r.data.lines || []).find((l) => l.src === 'fee' && l.ref === 'PLA1');
  check(r.status === 200 && inc.join() === 'PLA1,PLA2,PLA4' && fee1 && fee1.amount === 19.8 && fee1.feeFrom === 'ecpay',
    '3 付款成功的訂單進帳（沒付款的不進）、綠界通知帶的手續費自動列為支出', JSON.stringify([r.status, inc, fee1]));
  check(JSON.stringify(r.data.missingFee) === JSON.stringify(['PLA2']),
    '4 沒帶手續費的訂單列在「缺手續費」，不當成 0', JSON.stringify(r.data.missingFee));

  // 5) 台灣時間分月：UTC 10/31 20:00＝台灣 11/01 04:00
  const l4 = r.data.lines.find((l) => l.ref === 'PLA4' && l.src === 'order');
  check(l4 && l4.date === '2026-11-01' && r.data.months.some((m) => m.ym === '2026-11' && m.income === 49),
    '5 用台灣時間分日分月（UTC 晚上 8 點以後的交易算隔天）', JSON.stringify(l4 && l4.date));

  // 6) 補登手續費：補得進去；綠界帶過的不能改；不在帳本的訂單 404
  const f1 = await post(env, '/v1/admin/ledger/fee', { order_no: 'PLA2', fee_twd: 2.45, note: '綠界對帳單' });
  const f2 = await post(env, '/v1/admin/ledger/fee', { order_no: 'PLA1', fee_twd: 0 });
  const f3 = await post(env, '/v1/admin/ledger/fee', { order_no: 'PLA3', fee_twd: 1 });
  const r2 = await get(env, '/v1/admin/ledger');
  const fee2 = r2.data.lines.find((l) => l.src === 'fee' && l.ref === 'PLA2');
  check(f1.status === 200 && f2.status === 409 && f3.status === 404 && fee2.amount === 2.45 && fee2.feeFrom === 'manual' && !r2.data.missingFee.length,
    '6 手續費人工補登；綠界通知帶的以通知為準不能改；沒付款的訂單不能補', JSON.stringify([f1.status, f2.status, f3.status, fee2]));

  // 7) 同步不覆寫人工補登
  //    （狀態一變就會重新 UPSERT 那一列——拿退款來觸發）
  const o2 = JSON.parse(env.SUBS._store.get('ord:PLA2'));
  await putOrder(env, Object.assign(o2, { status: 'refunded', refundedAt: utc('2026-10-24T05:00:00Z') }));
  const n7 = await A.ledgerSyncOrders(env, env.RESELL_DB);
  const fm = env.RESELL_DB._db.prepare("SELECT fee_manual, status FROM ledger_orders WHERE order_no = 'PLA2'").get();
  check(n7 === 1 && fm && fm.fee_manual === 2.45 && fm.status === 'refunded', '7 重新同步（狀態變了才重讀）不會洗掉人工補登的手續費', JSON.stringify([n7, fm]));

  // 8) 退款：同步成退款支出；金額整筆
  const o1 = JSON.parse(env.SUBS._store.get('ord:PLA1'));
  await putOrder(env, Object.assign(o1, { status: 'refunded', refundedAt: utc('2026-10-25T02:00:00Z') }));
  const r3 = await get(env, '/v1/admin/ledger');
  const rf = r3.data.lines.find((l) => l.src === 'refund' && l.ref === 'PLA1');
  check(rf && rf.amount === 708 && rf.dir === -1 && rf.date === '2026-10-25', '8 退款的訂單同步後列一筆退款（整筆、在退款那天）', JSON.stringify(rf));

  // 9) KV 的訂單過期之後，帳上還在
  env.SUBS._store.delete('ord:PLA4');
  const r4 = await get(env, '/v1/admin/ledger');
  check(r4.data.lines.some((l) => l.ref === 'PLA4' && l.src === 'order'), '9 KV 的訂單過期（400 天）之後，收入仍在帳上（D1 快照）');

  // 10) 人工記帳：驗證
  const bad = await Promise.all([
    post(env, '/v1/admin/ledger/entry', { date: '2026-02-30', kind: 'expense', category: '網域', item: 'x', amount_twd: 100 }),
    post(env, '/v1/admin/ledger/entry', { date: '2099-01-01', kind: 'expense', category: '網域', item: 'x', amount_twd: 100 }),
    post(env, '/v1/admin/ledger/entry', { date: '2026-10-20', kind: 'expense', category: '亂寫', item: 'x', amount_twd: 100 }),
    post(env, '/v1/admin/ledger/entry', { date: '2026-10-20', kind: 'expense', category: '網域', item: 'x', amount_twd: 99.5 }),
    post(env, '/v1/admin/ledger/entry', { date: '2026-10-20', kind: 'expense', category: '網域', item: '', amount_twd: 100 }),
    post(env, '/v1/admin/ledger/entry', { date: '2026-10-20', kind: 'income', category: '網域', item: 'x', amount_twd: 100 }),
  ]);
  check(bad.every((x) => x.status === 400), '10 記帳要合法日期（不收 2/30、不收未來）、分類要對、台幣整數、要寫項目、收入不能用支出分類', bad.map((x) => x.status).join(','));

  const e1 = await post(env, '/v1/admin/ledger/entry', { date: '2026-10-20', kind: 'expense', category: 'AI 翻譯（Anthropic）', item: 'Anthropic 儲值', amount_twd: 1650, amount_orig: 50, currency: 'usd', receipt: '信用卡 10 月帳單' });
  const e2 = await post(env, '/v1/admin/ledger/entry', { date: '2026-10-21', kind: 'expense', category: '網域', item: '打錯的', amount_twd: 9999 });
  const v0 = await post(env, '/v1/admin/ledger/void', { id: e2.data.id });
  const v1 = await post(env, '/v1/admin/ledger/void', { id: e2.data.id, reason: '金額打錯' });
  const v2 = await post(env, '/v1/admin/ledger/void', { id: e2.data.id, reason: '再一次' });
  const r5 = await get(env, '/v1/admin/ledger?from=2026-10&to=2026-10');
  const oct = r5.data.months.find((m) => m.ym === '2026-10');
  const voided = r5.data.lines.find((l) => l.src === 'entry' && l.ref === String(e2.data.id));
  const ant = r5.data.lines.find((l) => l.src === 'entry' && l.ref === String(e1.data.id));
  check(e1.status === 200 && v0.status === 400 && v1.status === 200 && v2.status === 404 && voided && voided.voided && voided.voidReason === '金額打錯'
    && !oct.byCat['網域'] && oct.byCat['AI 翻譯（Anthropic）'] === -1650 && ant.orig === '50 USD',
    '11 作廢要寫原因、不能作廢兩次；作廢的照樣列出來但不算進合計', JSON.stringify([e1.status, v0.status, v1.status, v2.status, oct && oct.byCat]));

  // 12) 月份範圍：11 月的不在 10 月的查詢裡；合計＝收入－支出
  const sum = (oct.income - oct.expense);
  check(!r5.data.lines.some((l) => l.date.startsWith('2026-11')) && Math.abs(oct.net - sum) < 0.01,
    '12 依月份篩選；每月淨額＝收入－支出', JSON.stringify(oct));

  // 13) 代訂採購（f1_costs）自動列為支出
  const db = env.RESELL_DB._db;
  db.prepare("INSERT INTO f1_accounts (login_email, region, tier, created_at, updated_at) VALUES ('f1-001@pitlingo.test', 'BR', 'pro', 1, 1)").run();
  db.prepare('INSERT INTO f1_costs (account_id, period_from, period_until, amount_local, currency, amount_twd, paid_at, created_at) VALUES (1, 1, 2, 19.9, ?, 120, ?, 1)').run('BRL', utc('2026-10-22T05:00:00Z'));
  const r6 = await get(env, '/v1/admin/ledger');
  const fc = r6.data.lines.find((l) => l.src === 'f1cost');
  check(fc && fc.amount === 120 && fc.dir === -1 && fc.category === '代訂採購（F1TV）', '13 代訂分頁記的 F1TV 採購成本自動列為支出', JSON.stringify(fc));

  // 14) 沒有刪除的端點；付款通知存手續費；每日排程會同步
  const del = await call(env, 'DELETE', '/v1/admin/ledger/entry', { id: e1.data.id });
  const need = [
    [/paidFields\.fee = fee/, '付款通知把 PaymentTypeChargeFee 存進訂單'],
    [/Number\(p\.PaymentTypeChargeFee\)/, '手續費讀的是綠界的 PaymentTypeChargeFee'],
    [/await ledgerSyncOrders\(env, db\); \} catch/, '每日排程同步帳本'],
  ];
  const miss = need.filter(([re]) => !re.test(rawSrc)).map(([, m]) => m);
  check(del.status === 404 && !miss.length, '14 帳本沒有刪除；付款通知存綠界手續費；每日排程會同步', miss.join('、') || String(del.status));

  // 15) 回應不快取（帳務資料）
  const raw = await A.routeAdmin('/v1/admin/ledger', { method: 'GET' }, env, new URL('https://api.test/v1/admin/ledger'));
  const cc = raw.headers && (raw.headers['cache-control'] || (raw.headers.get && raw.headers.get('cache-control')));
  check(/no-store/.test(String(cc || JSON.stringify(raw.headers || {}))), '15 帳本回應 no-store', JSON.stringify(raw.headers || {}));

  console.log(errors.length ? `\n❌ ${errors.length} 項失敗` : '\n全部通過');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
