#!/usr/bin/env node
/**
 * 翻譯統計（stats:／ustats:）在多個 isolate 之下不會互相蓋掉（2026-10-26，A11）。
 *
 * 為什麼需要：R18 正賽實測，觀眾的累計從 1,317 倒退成 1,297、B 的 `last` 停在 03:59 但 B 一直在翻。
 * 原因是每個 isolate 各自「讀 KV → 加上自己的 → 整份寫回」，KV 最終一致，前後腳的兩個 isolate
 * 讀到同一份舊值，後寫的就把先寫的蓋掉（鐵則 16）。現在加法搬進 AuthGuard（DO，一次一個請求）。
 *
 * 這裡用**兩份獨立載入的後端**當兩個 isolate（各自的模組狀態），共用同一個假 KV 與同一個 AuthGuard。
 * 假 KV 的 get 有延遲，讓兩邊的讀→寫真的交錯（鐵則 55：假的 KV 沒有延遲，並發測試永遠是綠的）。
 *
 *   1. 舊做法（沒有 AuthGuard）在這個情境下真的會掉數字——證明測試抓得到問題
 *   2. 新做法：兩個 isolate 並發落地，KV 快照與 DO 正本都是 10＋7＝17 句，`last` 取最新
 *   3. DO 連不上：增量放回緩衝、不丟；恢復後下一輪補上
 *   4. DO 寫 KV 失敗（額度用完）：正本不掉，下一輪的快照把前一輪一起補上
 *   5. 部署當天：DO 正本是空的，以 KV 上現有的快照當起點，不會把當天前半段歸零
 *   6. KV 寫入次數照算（DO 的 env.SUBS 沒有計量器，自己加進 __kv）
 *
 * 用法：node tools/check-stats-merge.js
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

let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

const DAY = '2026-10-25';
const NOW = Date.parse(DAY + 'T21:00:00Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一個 isolate：獨立的模組狀態（pending_、upending_、kvOps…） */
function isolate() {
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  }
  const sandbox = {
    crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
    Response: class {
      constructor(b, i) { this.body = b; this.status = 200; Object.assign(this, i || {}); this.ok = this.status < 300; }
      async json() { return JSON.parse(this.body); }
    },
    Request: class {}, URL, console: { log() {}, warn() {}, error() {} },
    Date: FakeDate, Math, JSON, Map, Set, Promise, RegExp, Error,
    Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
    fetch: async () => { throw new Error('不應該有網路呼叫'); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__api = { recordUsage, recordUserUsage, flushStats, statsKey, ustatsKey, AuthGuard, withMeter };', sandbox);
  return sandbox.__api;
}

/** 有延遲的 KV：讀到的是「讀的那一刻」的值，寫要過一會兒才落地——兩個 isolate 的讀→寫才會交錯 */
function fakeKV(opts) {
  const o = opts || {};
  const m = new Map();
  const counts = { put: 0, get: 0 };
  return {
    m, counts,
    setFail(re) { o.failPut = re; },
    async get(k) { counts.get++; const v = m.has(k) ? m.get(k) : null; await sleep(5); return v; },
    async put(k, v) {
      await sleep(5);
      if (o.failPut && o.failPut.test(k)) throw new Error('KV put failed: daily limit exceeded');
      counts.put++; m.set(k, v);
    },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
}

function fakeDOStorage() {
  const m = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    _map: m,
    async get(k) { return clone(m.get(k)); },
    async put(k, v) { m.set(k, clone(v)); },
    async delete(k) { for (const x of [].concat(k)) m.delete(x); },
    async list() { return new Map([...m.entries()].map(([k, v]) => [k, clone(v)])); },
    async getAlarm() { return 1; },
    async setAlarm() {},
  };
}

/** AUTH 綁定：真的 AuthGuard、一次只處理一個請求（DO 的語意）。down() 模擬連不上 */
function fakeAuthNS(AuthGuard, kv) {
  const storage = fakeDOStorage();
  const guard = new AuthGuard({ storage }, { SUBS: kv });
  let chain = Promise.resolve();
  let down = false;
  const stub = {
    fetch(url, init) {
      if (down) return Promise.reject(new Error('DO unavailable'));
      const p = chain.then(() => guard.fetch({ json: async () => JSON.parse(init.body) }));
      chain = p.catch(() => {});
      return p.then((resp) => ({ json: async () => JSON.parse(resp.body) }));
    },
  };
  return { idFromName: () => 'auth-v1', get: () => stub, storage, setDown(v) { down = v; } };
}

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
function feed(api, translated, last) {
  api.recordUsage('1000010409', usage, translated, 0);
  api.recordUserUsage('dabe3f17viewer', 'week', usage, translated, 0);
  return last;
}
const kvJson = (kv, k) => { try { return JSON.parse(kv.m.get(k) || '{}'); } catch (e) { return {}; } };

(async () => {
  // 1. 舊做法會掉數字
  {
    const kv = fakeKV();
    const A = isolate(), B = isolate();
    const envA = A.withMeter({ SUBS: kv }), envB = B.withMeter({ SUBS: kv });
    feed(A, 10); feed(B, 7);
    await Promise.all([A.flushStats(envA), B.flushStats(envB)]);
    const got = (kvJson(kv, 'stats:' + DAY)['1000010409'] || {}).translated || 0;
    got < 17 ? ok(`舊做法（讀 KV→加→寫回）兩個 isolate 並發會掉數字：10＋7 只剩 ${got}——測試抓得到 A11`)
      : bad(`舊做法沒有重現掉數字（${got}）——假 KV 的延遲沒有讓讀寫交錯，這支測試證明不了任何事`);
  }

  // 2. 新做法：不掉
  const kv = fakeKV();
  const A = isolate(), B = isolate();
  const auth = fakeAuthNS(A.AuthGuard, kv);
  const envA = A.withMeter({ SUBS: kv, AUTH: auth }), envB = B.withMeter({ SUBS: kv, AUTH: auth });
  feed(A, 10); feed(B, 7);
  await Promise.all([A.flushStats(envA), B.flushStats(envB)]);
  {
    const s = kvJson(kv, 'stats:' + DAY)['1000010409'] || {};
    const u = kvJson(kv, 'ustats:' + DAY).dabe3f17viewer || {};
    const doS = ((await auth.storage.get('s:stats:' + DAY)) || {})['1000010409'] || {};
    s.translated === 17 && u.translated === 17 && doS.translated === 17 && u.calls === 2 && u.plan === 'week' && u.last > 0
      ? ok('兩個 isolate 並發落地：KV 快照、使用者統計、DO 正本都是 17 句，calls／plan／last 都對')
      : bad(`並發落地掉了：stats ${s.translated}、ustats ${u.translated}、DO ${doS.translated}、calls ${u.calls}`);
  }

  // 3. DO 連不上：放回緩衝，恢復後補上
  {
    feed(A, 5);
    auth.setDown(true);
    let threw = false;
    try { await A.flushStats(envA); } catch (e) { threw = true; }
    auth.setDown(false);
    feed(A, 1);
    await A.flushStats(envA);
    const s = kvJson(kv, 'stats:' + DAY)['1000010409'] || {};
    threw && s.translated === 23
      ? ok('DO 連不上：那一輪丟例外、增量放回緩衝；恢復後一起落地（17＋5＋1＝23）')
      : bad(`DO 連不上時掉了數字：${s.translated}（應為 23），丟例外 ${threw}`);
  }

  // 4. DO 寫 KV 失敗：正本不掉，下一輪補上
  {
    kv.setFail(/^stats:/);
    feed(B, 4);
    await B.flushStats(envB);
    const mid = (kvJson(kv, 'stats:' + DAY)['1000010409'] || {}).translated;
    const doMid = (((await auth.storage.get('s:stats:' + DAY)) || {})['1000010409'] || {}).translated;
    kv.setFail(null);
    feed(B, 2);
    await B.flushStats(envB);
    const s = kvJson(kv, 'stats:' + DAY)['1000010409'] || {};
    mid === 23 && doMid === 27 && s.translated === 29
      ? ok('KV 額度用完：快照停在舊值、DO 正本照加（27）；恢復後快照一次補齊（29）')
      : bad(`KV 寫失敗後：快照 ${mid}（應為 23）、DO ${doMid}（應為 27）、恢復後 ${s.translated}（應為 29）`);
  }

  // 5. 部署當天：以 KV 現有快照當起點
  {
    const kv2 = fakeKV();
    kv2.m.set('stats:' + DAY, JSON.stringify({ '1000010407': { calls: 50, translated: 1769, cached: 1234 }, __kv: { put: 197, del: 0, get: 0, list: 0 } }));
    kv2.m.set('ustats:' + DAY, JSON.stringify({ dabe3f17viewer: { calls: 30, translated: 600, cached: 900, plan: 'week', last: 1 } }));
    const C = isolate();
    const auth2 = fakeAuthNS(C.AuthGuard, kv2);
    const envC = C.withMeter({ SUBS: kv2, AUTH: auth2 });
    feed(C, 3);
    await C.flushStats(envC);
    const s = kvJson(kv2, 'stats:' + DAY), u = kvJson(kv2, 'ustats:' + DAY);
    (s['1000010407'] || {}).translated === 1769 && (s['1000010409'] || {}).translated === 3 && (u.dabe3f17viewer || {}).translated === 603 && s.__kv.put >= 199
      ? ok('部署當天：DO 正本是空的時候以 KV 現有快照當起點（1,769 句與 197 次寫入都還在）')
      : bad('部署當天把既有統計歸零了：' + JSON.stringify({ a: s['1000010407'], b: s['1000010409'], u: u.dabe3f17viewer, kv: s.__kv }));
  }

  // 6. KV 寫入次數照算：DO 寫的那幾次要進 __kv
  {
    const s = kvJson(kv, 'stats:' + DAY);
    // 成功落地 5 輪、每輪 stats＋ustats 兩次；KV 額度用完那一輪也算（嘗試過就算）
    s.__kv && s.__kv.put >= 10
      ? ok(`DO 自己寫的快照有記進 __kv（${s.__kv.put} 次）——計量器沒有因為搬家而變瞎`)
      : bad('DO 寫的快照沒有記進 __kv：' + JSON.stringify(s.__kv));
  }

  console.log(failed ? `\n❌ ${failed} 項未通過` : '\n✅ 翻譯統計在多個 isolate 之下不會互相蓋掉');
  process.exit(failed ? 1 : 0);
})();
