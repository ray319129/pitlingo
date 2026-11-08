#!/usr/bin/env node
/**
 * 檢查翻譯清單的時間軸（2026-11-06，Ray：「翻譯清單能否有時間軸?」→「要做」）
 *
 * 管理版收割重播時，用「分段在清單裡的累計 EXTINF 秒數」算每句在影片裡第幾秒，
 * 蓋完整標記（POST /v1/subs）時一起送；後端存在 bundle.t，只給後台看。
 *
 *   1. mergeLineTimes：只收 bundle 裡有譯文的句子、鍵會 normKey、數字範圍與型別要對、取到 0.1 秒、
 *      譯文被刪掉的句子時間跟著清掉
 *   2. POST /v1/subs 帶 times → 同一次寫入就有 t（KV 寫入次數不變：1 次）；回應帶 timed
 *   3. GET /v1/subs（用戶端）**不回 t**；GET /v1/admin/bundle 回 t
 *   4. 擴充功能的 cueVideoSec：絕對時間、分段內相對時間、都不像（退回分段起點）三種情況
 *   5. 後台的 bnClock：分:秒、時:分:秒
 *
 *   node tools/check-line-times.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readBackend } = require('./lib/backend-src');

let failed = 0;
const expect = (c, m) => { if (c) console.log('✅ ' + m); else { failed++; console.log('❌ ' + m); } };

let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

const sandbox = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
  Response, Request, Headers, URL, console: { log() {}, warn() {}, error() {} },
  Date, Math, JSON, Map, Set, Promise, RegExp, Error, Object, Array, String, Number, Boolean,
  parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
  caches: { default: { async match() {}, async put() {}, async delete() {} } },
  fetch: async () => { throw new Error('這支檢查不該打網路'); },
};
vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__B = { mergeLineTimes, handlePostSubs, handleGetSubs, normKey, bundleKey };', sandbox);
const B = sandbox.__B;

function fakeKV() {
  const m = new Map();
  let puts = 0;
  return {
    m, get puts() { return puts; },
    async get(k) { return m.has(k) ? m.get(k).v : null; },
    async put(k, v, o) { puts++; m.set(k, { v, meta: o && o.metadata }); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
    async getWithMetadata(k) { return m.has(k) ? { value: m.get(k).v, metadata: m.get(k).meta } : { value: null, metadata: null }; },
  };
}

(async () => {
  // 1) mergeLineTimes
  {
    const b = { lines: { 'box box': '進站、進站', 'he is on the hard tyre': '他用硬胎', 'gone line': '刪掉的' }, t: { 'gone line': 5, 'old key': 9 } };
    delete b.lines['gone line'];
    const n = B.mergeLineTimes(b, {
      'Box, box!': 12.345,                 // 會 normKey 成 'box box'
      'he is on the hard tyre': 3600.04,
      'not in bundle': 50,                 // 沒有譯文 → 不收
      'he is on the hard tyre ': -1,        // 負數 → 不收（同一鍵，前一筆已收）
      bogus: '12',                          // 字串 → 不收
    });
    expect(n === 2, `收進 2 句（實際 ${n}）`);
    expect(b.t['box box'] === 12.3 && b.t['he is on the hard tyre'] === 3600, '鍵經過 normKey、取到 0.1 秒');
    expect(!('not in bundle' in b.t) && !('bogus' in b.t), '沒有譯文的鍵、型別不對的值都進不來');
    expect(!('gone line' in b.t) && !('old key' in b.t), '譯文已經不在的句子，時間一起清掉');
    const e = { lines: { a: '甲' } };
    B.mergeLineTimes(e, undefined);
    expect(!('t' in e), '沒有送時間就不新增 t 欄位');
    const big = { lines: { a: '甲' } };
    B.mergeLineTimes(big, { a: 90000 });
    expect(!('t' in big), '超過一天（86,400 秒）的不收');
    const arr = { lines: { a: '甲' } };
    B.mergeLineTimes(arr, [1, 2]);
    expect(!('t' in arr), '陣列不當成時間表');
  }

  // 2) POST /v1/subs 帶 times：同一次寫入
  const kv = fakeKV();
  const env = { SUBS: kv };
  const cid = '1000010420';
  {
    const body = {
      cid, segCount: 3, v: 'ext-1.0.5', slug: '/detail/1000010420/2026-mexico-city-grand-prix',
      lines: { 'look at the slipstream they re going to get': '看他們要借的尾流', 'down to turn number one': '進一號彎' },
      times: { 'look at the slipstream they re going to get': 29.5, 'down to turn number one': 19.2 },
    };
    const res = await B.handlePostSubs(new Request('https://x/v1/subs', { method: 'POST', body: JSON.stringify(body) }), env);
    const j = await res.json();
    const stored = JSON.parse(await kv.get(B.bundleKey(cid)));
    expect(j.ok && j.timed === 2, `回應 timed＝2（實際 ${j.timed}，error ${j.error || '—'}）`);
    expect(stored.t && stored.t['look at the slipstream they re going to get'] === 29.5 && stored.t['down to turn number one'] === 19.2, 'bundle.t 存進 KV');
    expect(kv.puts === 1, `KV 只寫 1 次（實際 ${kv.puts}）——時間搭蓋章那一次`);
  }

  // 3) 用戶端讀不到 t；後台讀得到
  {
    const res = await B.handleGetSubs(new Request('https://x/v1/subs?cid=' + cid), env, new URL('https://x/v1/subs?cid=' + cid), { paid: true });
    const j = await res.json();
    expect(j.count === 2 && !('t' in j), 'GET /v1/subs 不回時間軸（用戶端不需要）');
    const adm = src.match(/if \(path === '\/v1\/admin\/bundle' && m === 'GET'\) \{[\s\S]*?\n  \}/);
    expect(!!adm && /\bt: \(b\.t && typeof b\.t === 'object'\) \? b\.t : \{\}/.test(adm[0]), 'GET /v1/admin/bundle 回 t');
  }

  // 4) 擴充功能 cueVideoSec
  {
    const main = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'content', 'main.js'), 'utf8');
    const fn = main.match(/function cueVideoSec\(start, seg\) \{[\s\S]*?\n  \}/);
    expect(!!fn, 'main.js 有 cueVideoSec');
    if (fn) {
      const cueVideoSec = vm.runInNewContext('(' + fn[0] + ')', { Math });
      const seg = { at: 600, dur: 6 };
      expect(cueVideoSec(602.5, seg) === 602.5, '絕對時間（落在分段範圍內）直接用');
      expect(cueVideoSec(2.5, seg) === 602.5, '分段內相對時間＝分段起點＋cue 秒數');
      expect(cueVideoSec(5000, seg) === 600, '兩種都不像 → 退回分段起點');
      expect(cueVideoSec(1.2, { at: 0, dur: 6 }) === 1.2, '第一個分段（兩種解讀一樣）');
    }
    const admin = /\/\* @admin-only:start \*\/\s*\n\s*\/\*\*\s*\n\s*\* 一句 cue 在整支影片裡的秒數/.test(main.replace(/\r/g, ''));
    expect(admin, 'cueVideoSec 包在 @admin-only 裡（正式版不帶）');
    expect(/type: 'harvestStamp', cid, lines, times,/.test(main), '蓋章時帶上 times');
  }

  // 5) 後台 bnClock
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'legal', 'secret-pitstop.html'), 'utf8');
    const fn = html.match(/function bnClock\(sec\) \{[\s\S]*?\n\}/);
    expect(!!fn, '後台有 bnClock');
    if (fn) {
      const bnClock = vm.runInNewContext('(' + fn[0] + ')', { Math, String });
      expect(bnClock(29.5) === '0:29' && bnClock(754) === '12:34' && bnClock(3725) === '1:02:05', `時間格式（${bnClock(29.5)}／${bnClock(754)}／${bnClock(3725)}）`);
    }
  }

  console.log(failed ? `\n❌ ${failed} 項失敗` : '\n✅ 時間軸檢查全部通過');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
