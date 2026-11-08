#!/usr/bin/env node
/**
 * 後端記下來的成本要對得上 Anthropic 的帳單（2026-09-18 拿帳單 CSV 對帳後新增）
 *
 * 對帳結果：後端記的輸入、輸出、快取讀取都只有帳單的 50%～80%，快取寫入是 0。
 * 查出三個「付了錢卻沒記」的地方，全部不報錯：
 *
 *   1. usageTotals 沒有 cache_creation_input_tokens 這一欄——快取寫入從來沒記過
 *   2. 一次請求分好幾批翻，某一批失敗就直接 return 502——前面幾批已付的錢跟著消失
 *   3. 模型拒答（stop_reason: refusal）也收費，但 callModel 直接丟例外，usage 沒帶出來
 *
 * （另外一個來源是統計緩衝在 isolate 記憶體裡、被回收時帶走——那是既知的「下限」，
 *   這支測不到；對帳要靠後台的「匯入帳單 CSV」。）
 *
 * 用法：node tools/check-cost-recording.js
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

function run(plan, opt) {
  opt = opt || {};
  const keys = [];
  // plan：每一次模型呼叫的回應 { refusal?: true }
  let call = 0;
  const kv = new Map();
  const sandbox = {
    crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
    Response: class {
      constructor(b, i) { this.body = b; this.status = 200; Object.assign(this, i || {}); this.ok = this.status < 300; }
      async json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
    },
    Request: class {}, URL, console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Map, Set, Promise, RegExp, Error,
    Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
    caches: { default: { async match() { return undefined; }, async put() {}, async delete() {} } },
    fetch: async (url, init) => {
      if (!String(url).includes('anthropic')) throw new Error('未預期的網路呼叫：' + url);
      keys.push(init.headers['x-api-key']);
      const p = plan[call++] || {};
      const text = JSON.stringify(JSON.parse(init.body).messages);
      const nums = [...text.matchAll(/(\d+)\.\s/g)].map((m) => Number(m[1]));
      const n = nums.length ? Math.max(...nums) : 1;
      const usage = { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 };
      return {
        ok: true, status: 200,
        async json() {
          return p.refusal
            ? { content: [], stop_reason: 'refusal', usage }
            : { content: [{ type: 'text', text: Array.from({ length: n }, (_, i) => `${i + 1}. 中文譯文${i + 1}`).join('\n') }], stop_reason: 'end_turn', usage };
        },
      };
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__api = { handleTranslate, flushStats, statsKey };', sandbox);
  const A = sandbox.__api;
  const env = {
    TOKEN_SECRET: 'test', ANTHROPIC_API_KEY: 'sk-test', DAILY_USD_CAP: '999', ...(opt.env || {}),
    SUBS: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
      list: async () => ({ keys: [], list_complete: true }),
    },
  };
  const lines = Array.from({ length: 25 }, (_, i) => `Line number ${i} is about the tyres`);   // 25 句＝兩批（BATCH_MAX 20）
  const req = { headers: { get: () => null }, async json() { return { cid: '9900000001', lines, urgent: false }; } };
  return (async () => {
    const res = await A.handleTranslate(req, env, '1.2.3.4', opt.auth || { ok: true, installId: 'test', legacy: true });
    await A.flushStats(env);
    const day = JSON.parse(kv.get(A.statsKey()) || '{}');
    return { status: res.status, calls: call, row: day['9900000001'] || null, keys };
  })();
}

(async () => {
  // ---- 1. 正常翻完兩批：四種 token 都要記 ----
  {
    const r = await run([{}, {}]);
    const w = r.row;
    w && w.in === 200 && w.out === 400 && w.cacheRead === 8000 && w.cacheWrite === 600
      ? ok('兩批都成功：輸入、輸出、快取讀取、快取寫入四種都記到（與帳單同一組分類）')
      : bad(`記到的 token 不完整：${JSON.stringify(w)}（應該是 in 200／out 400／cacheRead 8000／cacheWrite 600）`
        + ' —— 快取寫入沒記的話，後台成本會系統性地比帳單低');
  }

  // ---- 2. 第二批被拒答：第一批與拒答那一次都付過錢，都要記 ----
  {
    const r = await run([{}, { refusal: true }]);
    const w = r.row;
    r.status === 502 && w && w.in === 200 && w.cacheWrite === 600
      ? ok('第二批被拒答（502）：前一批與拒答那一次的費用都有記下來')
      : bad(`失敗時已付的錢沒有記（狀態 ${r.status}、記到 ${JSON.stringify(w)}，模型被呼叫 ${r.calls} 次）`
        + ' —— 失敗的那個請求在統計裡完全消失，帳單上卻照收');
  }

  // ---- 3. 收割端用自己的金鑰（2026-10-27，另一個 Console workspace，帳單分得開）----
  {
    const H = { ok: true, installId: 'harvest', legacy: true, harvest: true };
    const a = await run([{}, {}], { auth: H, env: { ANTHROPIC_API_KEY_HARVEST: 'sk-harvest' } });
    const b = await run([{}, {}], { env: { ANTHROPIC_API_KEY_HARVEST: 'sk-harvest' } });
    const c = await run([{}, {}], { auth: H });
    a.keys.length === 2 && a.keys.every((k) => k === 'sk-harvest') && b.keys.every((k) => k === 'sk-test') && c.keys.every((k) => k === 'sk-test')
      && a.row && a.row.in === 200
      ? ok('收割權杖用 ANTHROPIC_API_KEY_HARVEST、觀眾用原本那把；沒設定收割金鑰時退回原本那把；成本照樣記')
      : bad(`金鑰分流不對：收割 ${JSON.stringify(a.keys)}、觀眾 ${JSON.stringify(b.keys)}、沒設定時 ${JSON.stringify(c.keys)}`);
  }

  console.log('');
  if (failed) { console.log(`❌ 成本記錄有 ${failed} 項未通過`); process.exit(1); }
  console.log('✅ 後端記下的成本與帳單的計費項目一致');
})();
