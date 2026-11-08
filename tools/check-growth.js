#!/usr/bin/env node
/**
 * 檢查後台「成長統計」（/v1/admin/growth，2026-11-04）
 *
 *   1. 起算日以前的帳號與訂單不算（Ray：「可以忽略11/3之前的 因為那之前都是我在測試」）
 *   2. 起算日是**台灣時間** 00:00：11/2 23:30（台灣）建的不算、11/3 00:10 建的算
 *   3. 「註冊後有付款」用帳號綁定的任一 email 對已付款訂單（大小寫不同也要對得上）
 *   4. 讀取不可以觸發寫入（坑 #46）：整支跑完 KV put 次數為 0
 *   5. 第二次查詢走記憶體快取，不再 list（坑 #47）；fresh=1 才重算
 *
 *   node tools/check-growth.js
 */
'use strict';
const vm = require('vm');
const { readBackend } = require('./lib/backend-src');

let failed = 0;
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { failed++; console.log('❌ ' + m); };
const expect = (c, m) => (c ? ok(m) : bad(m));

let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

const NOW = Date.parse('2026-11-05T04:00:00Z');
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const kv = new Map();
const counts = { put: 0, list: 0, get: 0 };
const SUBS = {
  async get(k) { counts.get++; const v = kv.get(k); return v ? v.value : null; },
  async put(k, v, o) { counts.put++; kv.set(k, { value: v, metadata: o && o.metadata }); },
  async delete(k) { kv.delete(k); },
  async list({ prefix }) {
    counts.list++;
    const keys = [...kv.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: kv.get(name).metadata }));
    return { keys, list_complete: true };
  },
};
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const seed = (k, v, metadata) => kv.set(k, { value: typeof v === 'string' ? v : JSON.stringify(v), metadata });

// 帳號：測試期 1 個、邊界前 1 個、期間內 3 個（Google 2、Email 1）
seed('acctg:t1', { sub: 't1', email: 'ray@x.com', emails: ['ray@x.com'], createdAt: sec('2026-10-01T00:00:00Z'), lastLogin: sec('2026-11-04T00:00:00Z') });
seed('acctg:b1', { sub: 'b1', email: 'b@x.com', emails: [], createdAt: sec('2026-11-02T23:30:00+08:00'), lastLogin: sec('2026-11-02T23:30:00+08:00') });
// Google 的 sub 是純數字；第二個是「先用 email 登入、後來改 Google」併過來的，via 會留著 'email'（不可以據此算成 email 帳號）
seed('acctg:109283746501', { sub: '109283746501', email: 'Buyer@X.com', emails: ['Buyer@X.com'], createdAt: sec('2026-11-03T00:10:00+08:00'), lastLogin: sec('2026-11-04T20:00:00+08:00') });
seed('acctg:115500000002', { sub: '115500000002', via: 'email', email: 'c@x.com', emails: ['c@x.com'], createdAt: sec('2026-11-04T10:00:00+08:00'), lastLogin: sec('2026-11-04T10:00:00+08:00') });
// email 帳號：sub 用真正的 emailSub() 產生（em＋HMAC，沒有冒號），sandbox 建好之後才 seed
// 訂單：測試期已付款 1、期間內已付款 1（buyer）、免費 1、失敗 1
seed('ord:1', '{}', { s: 'paid', at: sec('2026-10-23T00:00:00Z'), t: 299, e: 'ray@x.com' });
seed('ord:2', '{}', { s: 'paid', at: sec('2026-11-04T12:00:00+08:00'), t: 99, e: 'buyer@x.com' });
seed('ord:3', '{}', { s: 'paid', at: sec('2026-11-04T13:00:00+08:00'), t: 0, e: 'c@x.com' });
seed('ord:4', '{}', { s: 'failed', at: sec('2026-11-04T14:00:00+08:00'), t: 99, e: 'd@x.com' });
// 使用事件
seed('metric:2026-11-04', { 'session_start|sessionType=race|licensed=no|version=1.0.5': 5, 'license_activated|plan=free_season|version=1.0.5': 2 });
seed('metric:2026-10-20', { 'session_start|sessionType=race|licensed=no|version=1.0.4': 99 });

const sandbox = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
  Response: class { constructor(b, i) { this.body = b; Object.assign(this, i || {}); } },
  Request: class {}, URL, console: { log() {}, warn() {}, error() {} },
  Date: FakeDate, Math, JSON, Map, Set, Promise, RegExp, Error,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
  caches: { default: { async match() {}, async put() {}, async delete() {} } },
  fetch: async (u) => { throw new Error('未預期的網路呼叫：' + u); },
};
vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__h = handleGrowth; globalThis.__es = emailSub;', sandbox);

(async () => {
  const env = { SUBS };
  const esub = await sandbox.__es(env, 'd@x.com');
  expect(/^em/.test(esub) && !esub.startsWith('em:'), `真正的 email sub 是 em＋HMAC、沒有冒號（v5.91 寫成 'em:'，全部算成 Google）：${esub.slice(0, 4)}…`);
  seed('acctg:' + esub, { sub: esub, via: 'email', email: 'd@x.com', emails: ['d@x.com'], createdAt: sec('2026-11-04T11:00:00+08:00'), lastLogin: sec('2026-11-04T11:00:00+08:00') });
  const call = async (q) => JSON.parse((await sandbox.__h(env, new URL('https://x/v1/admin/growth' + q))).body);
  const d = await call('');
  const a = d.accounts;
  expect(d.since === '2026-11-03', '預設起算日 2026-11-03');
  expect(a.total === 3 && a.allTime === 5, `只算 11/3 以後的帳號（3 個，全部 5 個）：實得 ${a.total}／${a.allTime}`);
  expect(a.google === 2 && a.email === 1, `Google／Email 分得開：${a.google}／${a.email}`);
  expect(a.daily['2026-11-03'] === 1 && a.daily['2026-11-04'] === 2 && !a.daily['2026-11-02'], '台灣時間分日：11/2 23:30 不算、11/3 00:10 算');
  expect(a.buyers === 1, `註冊後有付費＝1（大小寫不同照樣對上；只有 NT$0 訂單的人不算）：實得 ${a.buyers}`);
  expect(a.returned === 1, `隔天以後還回來＝1：實得 ${a.returned}`);
  const o = d.orders;
  expect(o.created === 3 && o.paid === 2 && o.failed === 1 && o.revenueTwd === 99 && o.freeOrders === 1,
    `訂單只算期間內（建立 3、付款 2、失敗 1、營收 99、免費 1）：${o.created}／${o.paid}／${o.failed}／${o.revenueTwd}／${o.freeOrders}`);
  const e = d.events;
  expect(e.sessionFree === 5 && e.activations === 2 && e.activationsByPlan.free_season === 2, '使用事件只算期間內，啟用依方案分');
  expect(counts.put === 0, `讀取不寫 KV（坑 #46）：put ${counts.put} 次`);
  const lists = counts.list;
  await call('');
  expect(counts.list === lists, '第二次查詢走快取，不再 list（坑 #47）');
  await call('?fresh=1');
  expect(counts.list > lists, 'fresh=1 會重算');
  const d2 = await call('?since=2026-11-04');
  expect(d2.accounts.total === 2, `換起算日 11/4 → 2 個帳號：實得 ${d2.accounts.total}`);
  if (failed) { console.log(`\n❌ ${failed} 項未通過`); process.exit(1); }
  console.log('\n✅ 成長統計全部通過');
})().catch((e) => { console.log('❌ ' + (e.stack || e)); process.exit(1); });
