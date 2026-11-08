#!/usr/bin/env node
/**
 * 共用快取的寫入緩衝搬進房間（SubtitleRoom，2026-10-26，A15）。
 *
 * 為什麼需要：以前每個 isolate 各有一份 bundle 緩衝（bundleBuf），滿 120 句或 90 秒才寫 KV，
 * 而且要**同一個 isolate 再收到請求**才會檢查。R18 排位後節目：收割端翻了約 280 句，
 * 晚 9.5 分鐘加入的 B 從共用快取（KV）只拿到 1 句，全部自己重翻。
 * 現在房間（每支影片一份、強一致、存 storage）用 alarm 每 90 秒寫一次 KV，全站只有一份。
 *
 *   1. 舊路徑（isolate 緩衝）的問題重現：兩個 isolate 各翻一段、之後沒有新請求 → KV 一句都沒有
 *   2. 房間接手：done 帶 buffer:true → 回報接手的句子、排 90 秒後的鬧鐘
 *   3. 鬧鐘：兩個 isolate 交來的句子一次寫進 KV（含 slug），寫入次數由下一個 done 帶回 isolate 記帳
 *   4. 沒有新句子的鬧鐘不寫 KV（鐵則 10）
 *   5. 休眠後（新實例、同一份 storage）只寫新的那一段
 *   6. KV 寫失敗：不推進 flushedAt、2 分鐘後再試，恢復後全部補上（鐵則 48）
 *   7. 舊版用戶端（沒帶 buffer）照舊自己緩衝（buffered 為 null）
 *   8. 晚加入的觀眾 GET /v1/subs：KV 還沒有的，房間 15 分鐘內的也給他；重播（bundle 很久沒動）不問房間
 *   9. roomPublish：房間代寫的 KV 次數記進 isolate 的計量器
 *
 * 用法：node tools/check-room-flush.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const vm = require('vm');
const root = path.join(__dirname, '..');

let failed = 0;
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { failed++; console.log('❌ ' + m); };
const check = (c, m, extra) => (c ? ok(m) : bad(m + (extra ? '：' + extra : '')));

let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

let NOW = Date.parse('2026-11-01T20:30:00Z');
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
function load() {
  const sandbox = {
    crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
    Response: class {
      constructor(b, i) { this.body = b; this.status = 200; Object.assign(this, i || {}); this.ok = this.status < 300; }
      async json() { return JSON.parse(this.body); }
    },
    Request: class {}, URL, URLSearchParams, console: { log() {}, warn() {}, error() {} },
    Date: FakeDate, Math, JSON, Map, Set, Promise, RegExp, Error,
    Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
    fetch: async () => { throw new Error('不應該有網路呼叫'); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__api = { SubtitleRoom, bufferBundleLines, bufferedLines, readBundle, roomPublish, handleGetSubs, getKvOps: () => kvOps };', sandbox);
  return sandbox.__api;
}

function fakeKV() {
  const m = new Map();
  const kv = {
    m, puts: 0, fail: false,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { if (kv.fail) throw new Error('KV put failed: daily limit exceeded'); kv.puts++; m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
  return kv;
}
function fakeStorage() {
  const m = new Map();
  const st = {
    m, alarm: null,
    async get(k) { if (Array.isArray(k)) { const o = new Map(); for (const x of k) if (m.has(x)) o.set(x, m.get(x)); return o; } return m.get(k); },
    async put(k, v) { if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, b); } else m.set(k, v); },
    async delete(k) { if (Array.isArray(k)) { let n = 0; for (const x of k) n += m.delete(x) ? 1 : 0; return n; } return m.delete(k); },
    async list(o) { const pre = (o && o.prefix) || ''; return new Map([...m].filter(([k]) => String(k).startsWith(pre))); },
    async getAlarm() { return st.alarm; },
    async setAlarm(t) { st.alarm = t; },
  };
  return st;
}
const lines = (pre, n) => { const o = {}; for (let i = 0; i < n; i++) o[`${pre} line ${i}`] = `${pre}譯文${i}`; return o; };

(async () => {
  const CID = '1000010420';
  const SLUG = '/detail/1000010420/2026-mexico-city-grand-prix';

  // 1. 舊路徑：兩個 isolate 各自緩衝，之後沒有新請求 → 什麼都沒寫
  {
    const A = load(); const Bi = load();
    const kv = fakeKV();
    A.bufferBundleLines(CID, lines('a', 30), SLUG);
    Bi.bufferBundleLines(CID, lines('b', 30), SLUG);
    NOW += 10 * 60000;
    const b = await A.readBundle({ SUBS: kv }, CID);
    check(Object.keys(b.lines).length === 0 && kv.puts === 0, '1  舊路徑重現：兩個 isolate 各翻 30 句、之後沒有新請求 → 10 分鐘後 KV 一句都沒有（A15 的成因）');
  }

  const A = load();
  const kv = fakeKV();
  const env = { SUBS: kv };
  const st = fakeStorage();
  const room = () => new A.SubtitleRoom({ storage: st }, env);
  const call = async (r, b) => (await r.fetch({ async json() { return b; } })).json();

  // 2. 接手
  const r1 = await call(room(), { op: 'done', lines: lines('a', 30), leader: true, buffer: true, cid: CID, slug: SLUG });
  check(Array.isArray(r1.buffered) && r1.buffered.length === 30 && st.alarm === NOW + 90000, '2a 房間接手 30 句、排 90 秒後的鬧鐘', JSON.stringify({ n: r1.buffered && r1.buffered.length, alarm: st.alarm && st.alarm - NOW }));
  NOW += 5000;
  const r2 = await call(room(), { op: 'done', lines: lines('b', 30), buffer: true, cid: CID, slug: SLUG });   // 另一個 isolate、房間休眠過
  check(r2.buffered.length === 30 && st.alarm === NOW - 5000 + 90000, '2b 第二個 isolate 交來的也接手，不重排鬧鐘');

  // 3. 鬧鐘
  NOW = st.alarm;
  await room().alarm();
  let b = await A.readBundle(env, CID);
  check(Object.keys(b.lines).length === 60 && b.slug === SLUG && kv.puts === 1, '3a 鬧鐘一次把兩個 isolate 的 60 句寫進 KV（含 slug）', JSON.stringify({ n: Object.keys(b.lines).length, slug: b.slug, puts: kv.puts }));
  const r3 = await call(room(), { op: 'done', lines: {}, buffer: true, cid: CID });
  const r3b = await call(room(), { op: 'done', lines: {}, buffer: true, cid: CID });
  check(r3.kvPuts === 1 && r3b.kvPuts === 0, '3b 房間寫了幾次 KV，由下一個 done 帶回 isolate 記帳（只帶一次）', JSON.stringify([r3.kvPuts, r3b.kvPuts]));

  // 4. 沒有新句子
  NOW += 90000;
  await room().alarm();
  check(kv.puts === 1, '4  沒有新句子的鬧鐘不寫 KV');

  // 5. 休眠後只寫新的
  NOW += 30000;
  await call(room(), { op: 'done', lines: lines('c', 10), buffer: true, cid: CID, slug: SLUG });
  NOW = st.alarm;
  const before = kv.m.get('bundle:' + CID) || kv.m.get([...kv.m.keys()].find((k) => k.includes(CID)));
  await room().alarm();
  b = await A.readBundle(env, CID);
  check(Object.keys(b.lines).length === 70 && kv.puts === 2 && before, '5  休眠後（新實例）只把新的 10 句併進去，舊的 60 句還在');

  // 6. KV 寫失敗
  NOW += 10000;
  await call(room(), { op: 'done', lines: lines('d', 5), buffer: true, cid: CID, slug: SLUG });
  NOW = st.alarm;
  kv.fail = true;
  await room().alarm();
  const retryIn = st.alarm - NOW;
  kv.fail = false;
  NOW = st.alarm;
  await room().alarm();
  b = await A.readBundle(env, CID);
  check(retryIn === 120000 && Object.keys(b.lines).length === 75, '6  KV 寫失敗：2 分鐘後再試，恢復後那 5 句補上（沒有丟）', JSON.stringify({ retryIn, n: Object.keys(b.lines).length }));

  // 7. 舊版用戶端
  const r7 = await call(room(), { op: 'done', lines: lines('e', 3) });
  check(r7.buffered === null, '7  沒帶 buffer 的（舊版後端）房間不接手，isolate 照舊自己緩衝');

  // 8. 晚加入的觀眾
  {
    const A2 = load();
    const kv2 = fakeKV();
    const st2 = fakeStorage();
    const R = new A2.SubtitleRoom({ storage: st2 }, { SUBS: kv2 });
    const env2 = {
      SUBS: kv2,
      ROOM: { idFromName: (n) => ({ name: n }), get: () => ({ fetch: (u, init) => R.fetch({ async json() { return JSON.parse(init.body); } }) }) },
    };
    await R.fetch({ async json() { return { op: 'done', lines: lines('live', 40), leader: true, buffer: true, cid: '1000010419', slug: '/detail/1000010419/post-race-show-mexico' }; } });
    const res = await A2.handleGetSubs({}, env2, new URL('https://api.pitlingo.com/v1/subs?cid=1000010419'), { paid: true });
    const body = JSON.parse(res.body);
    check(body.count === 40, '8a 直播中晚加入：KV 還沒有，房間裡的 40 句照樣拿得到', String(body.count));
    // 重播：bundle 一天前寫的
    await kv2.put('bundle:1000010418', JSON.stringify({ v: 1, cid: '1000010418', updatedAt: new Date(NOW - 86400000).toISOString(), segCount: 0, lines: { x: '叉' } }));
    let asked = 0;
    const env3 = Object.assign({}, env2, { ROOM: { idFromName: (n) => ({ name: n }), get: () => ({ fetch: () => { asked++; return Promise.resolve({ ok: true, async json() { return { lines: {} }; } }); } }) } });
    const keyFn = [...kv2.m.keys()].find((k) => k.includes('1000010418'));
    const res3 = await A2.handleGetSubs({}, env3, new URL('https://api.pitlingo.com/v1/subs?cid=1000010418'), { paid: true });
    check(keyFn && JSON.parse(res3.body).count === 1 && asked === 0, '8b 重播（bundle 一天沒動）不問房間，不多一次 DO 請求');
  }

  // 9. roomPublish 記帳
  {
    const A3 = load();
    const env4 = { ROOM: { idFromName: (n) => ({ name: n }), get: () => ({ fetch: async () => ({ ok: true, async json() { return { ok: true, buffered: ['k1'], kvPuts: 3 }; } }) }) } };
    const before4 = A3.getKvOps().put;
    const owned = await A3.roomPublish(env4, CID, { k1: '一', k2: '二' }, false, SLUG);
    check(owned && owned.has('k1') && !owned.has('k2') && A3.getKvOps().put === before4 + 3, '9  roomPublish：回報房間接手的句子（沒接手的照舊自己緩衝）、房間的 KV 寫入記進計量器');
  }

  console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
