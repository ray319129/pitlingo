#!/usr/bin/env node
/**
 * 逐句紀錄（2026-10-31，Ray：「要有真正的數據紀錄所有事，不要再用推測的」）。
 *
 * 後台「逐句紀錄」的每一個數字都來自這套紀錄——紀錄本身錯了，就是一份看起來很真的錯數字。
 * 這支驗四件事：
 *   1. lineHash 穩定（同一句永遠同一個雜湊、不同句不撞）而且紀錄裡沒有原文
 *   2. 每一個請求都留下一筆，每一句都有去向（c／r／w／m／x／d 加起來＝這個請求的不重複句數）
 *   3. handleTranslate 在 finish 定義之後的每一個 return 都包著 finish（漏一個就是那條路的請求不記）
 *   4. plogSummary 的「重複翻」：race（同時在翻）與 late（第一份翻好了還再翻）分得對，誰 → 誰算得對
 *
 * 用法：node tools/check-line-log.js
 */
const path = require('path');
const vm = require('vm');
const { readBackend } = require('./lib/backend-src');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const fail = (m, d) => { errors.push(m); console.log('❌ ' + m + (d ? '：' + d : '')); };

// 嚴格模式載入（鐵則 25）；剝掉兩種 export
const raw = readBackend();
let src = "'use strict';\n" + raw;
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

let modelCalls = 0;
const sandbox = {
  crypto: require('crypto').webcrypto,
  TextEncoder, TextDecoder, btoa, atob,
  Response: class {
    constructor(b, i) { this.body = b; this.status = 200; Object.assign(this, i || {}); if (this.ok === undefined) this.ok = this.status >= 200 && this.status < 300; }
    async json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
  },
  Request: class {},
  URL, console: { log() {}, warn() {}, error() {} },
  Date, Math, JSON, Map, Set, Promise, RegExp, Error,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite,
  setTimeout, clearTimeout,
  caches: { default: { async match() { return undefined; }, async put() {} } },
  fetch: async (url, init) => {
    if (String(url).includes('anthropic')) {
      modelCalls++;
      const text = JSON.stringify(JSON.parse(init.body).messages || '');
      const nums = [...text.matchAll(/(\d+)\.\s/g)].map((m) => Number(m[1]));
      const n = nums.length ? Math.max(...nums) : 1;
      const out = Array.from({ length: n }, (_, i) => `${i + 1}. 中文譯文${i + 1}`).join('\n');
      return { ok: true, status: 200, async json() { return { content: [{ type: 'text', text: out }], usage: { input_tokens: 10, output_tokens: 10 } }; } };
    }
    throw new Error('未預期的網路呼叫：' + url);
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { handleTranslate, SubtitleRoom, lineHash, plogSummary, normKey, PLOG_SRC };', sandbox);
const A = sandbox.__api;

/** DO storage：list 照真的一樣支援 prefix／start／end（字典序）／limit */
function fakeStorage() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.get(k); },
    async put(k, v) { if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, b); } else m.set(k, v); },
    async delete(k) { for (const x of [].concat(k)) m.delete(x); },
    async list(o) {
      const pre = (o && o.prefix) || '';
      let rows = [...m].filter(([k]) => k.startsWith(pre)
        && (!o.start || k >= o.start) && (!o.end || k < o.end)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (o && o.limit) rows = rows.slice(0, o.limit);
      return new Map(rows);
    },
    async getAlarm() { return 1; }, async setAlarm() {},
  };
}
const rooms = new Map();
const kv = new Map();
const env = {
  TOKEN_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'sk-test', DAILY_USD_CAP: '999',
  SUBS: {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  },
};
env.ROOM = {
  idFromName: (n) => ({ name: n, toString: () => n }),
  get(id) {
    const key = String(id.name);
    if (!rooms.has(key)) { const storage = fakeStorage(); rooms.set(key, { storage, inst: new A.SubtitleRoom({ storage }, env), q: Promise.resolve() }); }
    const r = rooms.get(key);
    return { fetch(url, init) { const n = r.q.then(() => r.inst.fetch({ async json() { return JSON.parse(init.body); } })); r.q = n.catch(() => {}); return n; } };
  },
};
const req = (body) => ({ headers: { get: () => null }, async json() { return body; } });
// waitUntil：收集起來，檢查前全部等完（線上是 Worker 在回應後繼續跑）
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const plogs = (cid) => [...((rooms.get(cid) || {}).storage || { m: new Map() }).m].filter(([k]) => k.startsWith('plog:')).map(([, v]) => v);

(async () => {
  // ---- 1. lineHash ----
  {
    const a = A.lineHash(A.normKey('Box box box Max')), b = A.lineHash(A.normKey('Box box box Max'));
    const set = new Set(Array.from({ length: 5000 }, (_, i) => A.lineHash('line number ' + i)));
    if (a === b && /^[0-9a-f]{14}$/.test(a) && set.size === 5000) ok('lineHash 穩定、14 位十六進位、5,000 句不撞');
    else fail('lineHash 不穩定或撞了', `${a} ${b} ${set.size}`);
  }

  // ---- 2. 端對端：每個請求一筆、每一句都有去向 ----
  const LINES = ['Box box box Max', 'He is closing in fast', 'That is a great move', 'Box box box Max'];
  const auth = (id) => ({ ok: true, installId: id, legacy: true });
  const cid = '9200000001';
  modelCalls = 0;
  await A.handleTranslate(req({ cid, lines: LINES, urgent: true, live: true }), env, '1.2.3.4', auth('aaaaaaaa-1'), ctx);
  await settle();
  await A.handleTranslate(req({ cid, lines: LINES, urgent: true, live: true }), env, '1.2.3.4', auth('bbbbbbbb-2'), ctx);
  await settle();
  {
    const recs = plogs(cid);
    const uniq = new Set(LINES.map((l) => A.normKey(l))).size;
    // 每一個不重複的句子都至少有一個去向（同一句出現兩次就有兩個標記——那正是 same 要抓的）
    const allH = [...new Set(LINES.map((l) => A.lineHash(A.normKey(l))))];
    const per = recs.map((r) => allH.filter((h) => Object.keys(A.PLOG_SRC).some((s) => Array.isArray(r[s]) && r[s].includes(h))).length);
    const plain = JSON.stringify(recs);
    const leak = LINES.some((l) => plain.includes(l) || plain.includes(A.normKey(l)));
    const [ra, rb] = recs.sort((x, y) => x.t0 - y.t0);
    if (recs.length !== 2) fail('每一個翻譯請求都要留一筆逐句紀錄', `2 個請求、${recs.length} 筆`);
    else if (per.some((n) => n !== uniq)) fail('每一句都要有去向（各去向加起來＝不重複句數）', `${per.join('／')}，應為 ${uniq}`);
    else if (leak) fail('逐句紀錄裡有原文（只能存雜湊）');
    else if (ra.who !== 'aaaaaaaa' || ra.m.length !== LINES.length || rb.m.length !== 0 || rb.live !== true) fail('去向不對', JSON.stringify({ a: ra, b: rb }));
    else ok(`每個請求一筆、每一句都有去向、不存原文；第一個人自己翻 ${ra.m.length} 次（${uniq} 句，其中一句出現兩次），第二個人 0 次（${rb.c.length ? '共用快取' : rb.w.length ? '等到的' : '房間'}）`);
    // ⚠️ 同一個請求裡同一句出現兩次，translateBatch 會把它送給模型兩次（2026-10-31 這支檢查查到的）。
    //    紀錄要照實記兩次，彙整歸成 same——不是 race 也不是 late
    const s = A.plogSummary(recs, false);
    const m = s.model;
    if (m.translations !== LINES.length || m.unique !== uniq || m.extra !== 1 || m.same !== 1 || m.race !== 0 || m.late !== 0) fail('彙整的模型次數不對', JSON.stringify(m));
    else ok(`彙整：模型翻 ${m.translations} 次、不重複 ${m.unique} 句；同一個請求裡重複的 ${m.same} 次歸成 same，不算成兩人重複`);
  }

  // 沒有影片編號（misc）不記，也不可以壞
  {
    const r = await A.handleTranslate(req({ cid: 'misc', lines: ['Hello there'] }), env, '1.2.3.4', auth('cccccccc'), ctx);
    await settle();
    if (r.status === 200 && plogs('misc').length === 0) ok('沒有影片編號的請求照常回應、不記');
    else fail('misc 請求', `${r.status} ${plogs('misc').length}`);
  }

  // ---- 3. finish 包住每一個 return ----
  {
    const i = raw.indexOf('async function handleTranslate(');
    const end = raw.indexOf('\n}', i);
    const body = raw.slice(i, end);
    const f = body.indexOf('const finish = (resp) => {');
    const fEnd = body.indexOf('\n  };', f);
    const rest = body.slice(fEnd + 5);
    // 註解行不算；addUsage 是巢狀的小函式，它的 return 不是 handleTranslate 的出口
    const bad = rest.split(/\r?\n/).filter((l) => /\breturn\b/.test(l) && !/^\s*(\/\/|\*)/.test(l)
      && !/\breturn finish\(/.test(l) && l.trim() !== 'if (!u) return;');
    if (f < 0 || fEnd < 0) fail('找不到 handleTranslate 的 finish（改名了？這支檢查要跟著改）');
    else if (bad.length) fail('handleTranslate 有 return 沒有包 finish（那條路的請求不會被記）', bad.map((l) => l.trim()).join(' | '));
    else ok(`finish 之後的 ${(rest.match(/\breturn finish\(/g) || []).length} 個 return 全部包著 finish`);
  }

  // ---- 4. race／late 的判斷 ----
  {
    const H = 'h1', K = 'h2';
    const recs = [
      { who: 'harvest', t0: 1000, t1: 3000, m: [H, K] },
      { who: 'viewerB', t0: 2000, t1: 4000, m: [H] },     // 第一份還沒翻好（3000）就送出 → race
      { who: 'viewerC', t0: 5000, t1: 6000, m: [H, K] },  // 第一份 3000 就翻好了 → late ×2
      { who: 'viewerC', t0: 7000, t1: 7100, c: [H, K] },
      { who: 'viewerD', t0: 8000, t1: 9000, m: ['h3', 'h3'] }, // 同一個請求裡出現兩次 → same
    ];
    const s = A.plogSummary(recs, false);
    const m = s.model;
    const good = m.translations === 7 && m.unique === 3 && m.extra === 4 && m.same === 1 && m.race === 1 && m.late === 2
      && m.pairs['harvest → viewerB'] === 1 && m.pairs['harvest → viewerC'] === 2 && s.who.viewerC.req === 2 && s.who.viewerC.c === 2;
    good ? ok('重複翻分得出「同一個請求裡重複」「同時在翻」「翻好了還再翻」，誰 → 誰算得對')
      : fail('plogSummary 的重複翻判斷不對', JSON.stringify(m));
  }

  console.log(errors.length ? `\n❌ ${errors.length} 項未通過` : '\n✅ 全部通過');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log('❌ 執行失敗：' + (e && e.stack || e)); process.exit(1); });
