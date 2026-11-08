#!/usr/bin/env node
/**
 * 彈幕（2026-10-28，尚未發行，handoff 9.1 #23）。
 *
 * 用 Node 內建的 SQLite（node:sqlite）當 DO 的 ctx.storage.sql，實際跑 DanmakuRoom：
 *   1. 換憑證：收割端／未發行且不在白名單 → 拒絕；未付費（含沒登入）→ 只能看；付費 → 能發；禁言 → 不能發言
 *   2. 憑證：竄改、換影片、過期一律無效
 *   3. 發言：長度、網址、關鍵字（拆字加空白也抓得到）、控制字元、洗版
 *   4. 頻率：兩則間隔、每分鐘、每人每天、每支影片每天
 *   5. 合併廣播：0.4 秒內的多則一次送出；影子禁言只送回他自己
 *   6. 連線中被禁言：下一則就擋（不等重連）
 *   7. 刪除：廣播 del、重播拿不到；檢舉同一人只算一次、進索引房間
 *   8. 重播依位置排序、只拿那 30 秒
 *   9. Haiku 審核：關著不呼叫；打開時擋 N、記用量；服務壞掉放行
 *  10. 1,000 人同時在線：送出次數 ≪ 則數 × 人數；**整段發言路徑 KV 寫入 0 次**
 *  11. 原始碼契約：用 acceptWebSocket（Hibernation），不用 accept()；ops 預設關閉
 *
 * 用法：node tools/check-danmaku.js
 */
'use strict';
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const { readBackend } = require('./lib/backend-src');

let failed = 0;
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { failed++; console.log('❌ ' + m); };
const check = (c, m, extra) => (c ? ok(m) : bad(m + (extra !== undefined ? '：' + extra : '')));

const SRC = readBackend();
let src = "'use strict';\n" + SRC;
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

let NOW = Date.parse('2026-11-01T06:00:00Z');
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const timers = [];
let fetchImpl = async () => { throw new Error('不應該有網路呼叫'); };
const sb = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob, AbortController,
  Response: class {
    constructor(b, i) { this.body = b; this.status = 200; Object.assign(this, i || {}); this.ok = this.status < 300; }
    async json() { return JSON.parse(this.body); }
    static json(o) { return new sb.Response(JSON.stringify(o)); }
  },
  Request: class { constructor(u, i) { this.url = u; Object.assign(this, i || {}); } },
  Headers: Map, URL, URLSearchParams, console: { log() {}, warn() {}, error() {} },
  Date: FakeDate, Math, JSON, Map, Set, Promise, RegExp, Error, escape, unescape,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite,
  setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
  fetch: (...a) => fetchImpl(...a),
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src + '\n;this.__api = { DanmakuRoom, dmTicket, dmTicketVerify, dmTicketIssue, dmRoomName, dmRoomsLabeled, handleDanmakuAdmin, dmClean, dmBlocked, dmFold, normDanmaku, opsConfig,'
  + ' DM_PER_MIN, DM_PER_DAY, DM_ROOM_PER_DAY, DM_MAX_LEN, resetOps: () => { opsCache = { at: 0, data: null }; dmBansCache = { at: 0, data: null }; } };', sb);
const A = sb.__api;

// ---- 假的 KV 與 DO 環境 ----
const kv = new Map();
let kvPuts = 0;
const SUBS = {
  get: async (k) => (kv.has(k) ? kv.get(k) : null),
  put: async (k, v) => { kvPuts++; kv.set(k, v); },
  delete: async (k) => { kv.delete(k); },
  list: async () => ({ keys: [], list_complete: true }),
};
const rooms = new Map();
const env = { SUBS, TOKEN_SECRET: 'x'.repeat(40), ANTHROPIC_API_KEY: 'test' };
env.DM = {
  idFromName: (n) => n,
  get: (n) => ({
    fetch: async (u, init) => {
      const r = room(n);
      const out = await r.op(JSON.parse(init.body));
      return { ok: true, json: async () => out };
    },
  }),
};
function makeCtx() {
  const db = new DatabaseSync(':memory:');
  const store = new Map();
  const sockets = [];
  return {
    sockets,
    storage: {
      sql: {
        exec(q, ...args) {
          const st = db.prepare(q);
          const rows = /^\s*(select|pragma|insert[\s\S]*returning)/i.test(q) ? st.all(...args) : (st.run(...args), []);
          return { toArray: () => rows.map((r) => Object.assign({}, r)) };
        },
      },
      get: async (k) => store.get(k),
      put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) store.set(a, b); else store.set(k, v); },
      // 跟真的一樣：一個物件只有一個 alarm，setAlarm 會蓋掉前一個
      getAlarm: async () => (store.has('__alarm') ? store.get('__alarm') : null),
      setAlarm: async (t) => { store.set('__alarm', Number(t)); },
    },
    db,
    blockConcurrencyWhile: (fn) => fn(),
    acceptWebSocket: (ws) => sockets.push(ws),
    // 與真的 API 一樣依標籤過濾（acceptWebSocket 時給的標籤：後台＝'admin'，觀眾＝sub）
    getWebSockets: (tag) => (tag ? sockets.filter((ws) => (ws.att && ws.att.admin ? 'admin' : ws.att && ws.att.sub) === tag) : sockets),
  };
}
function room(name) {
  if (!rooms.has(name)) rooms.set(name, new A.DanmakuRoom(makeCtx(), env));
  return rooms.get(name);
}
let sends = 0;
function sock(sub, opts) {
  const ws = {
    sent: [], att: Object.assign({ sub, cid: '1000001', post: true, shadow: false }, opts || {}),
    send(s) { sends++; this.sent.push(JSON.parse(s)); },
    serializeAttachment(a) { this.att = a; }, deserializeAttachment() { return this.att; },
  };
  return ws;
}
const join = (r, ws) => { r.ctx.sockets.push(ws); return ws; };
const flushAll = () => { while (timers.length) timers.shift()(); };
const say = (r, ws, x, pos, n) => r.webSocketMessage(ws, JSON.stringify({ t: 'say', x, pos: pos == null ? 60000 : pos, n: n || 1 }));
const last = (ws) => ws.sent[ws.sent.length - 1] || {};
async function setOps(o) { kv.set('ops:config', JSON.stringify(o)); A.resetOps(); }

(async () => {
  // ---- 1. 換憑證的四道門 ----
  {
    const req = {};
    let sess = null; let gate = 'licensed'; let emails = ['fan@example.com'];
    sb.sessionOf = async () => sess;
    sb.checkEntitlement = async () => ({ reason: gate });
    sb.readGoogleAccount = async () => ({ emails });
    await setOps({});
    let r = await A.dmTicket(env, req, { ok: true, installId: 'i1' }, '1000001');
    check(r.code === 'E82', '1a 未發行時沒登入一律不在白名單（E82）', r.code);
    sess = { sub: 'g:111' }; gate = 'free';
    await setOps({ danmaku: { allow: ['fan@example.com'] } });
    r = await A.dmTicket(env, req, { ok: true, installId: 'i1' }, '1000001');
    check(r.ok && !r.post && r.unpaid, '1b 未付費（免費試用）看得到、不能發', JSON.stringify(r));
    await setOps({});
    gate = 'legacy';
    r = await A.dmTicket(env, req, { ok: true, installId: 'harvest', legacy: true }, '1000001');
    check(r.code === 'E81', '1c 收割權杖不行（收割端不是觀眾）', r.code);
    gate = 'licensed';
    r = await A.dmTicket(env, req, { ok: true, installId: 'i1' }, '1000001');
    check(r.code === 'E82', '1d 未發行（ops.danmaku 預設關）且不在白名單 → E82', r.code);
    await setOps({ danmaku: { allow: ['FAN@example.com'] } });
    r = await A.dmTicket(env, req, { ok: true, installId: 'i1' }, '1000001');
    check(r.ok && r.post, '1e 白名單（不分大小寫）可以連線、可以發言', JSON.stringify(r));
    await setOps({ danmaku: { on: true } });
    emails = ['other@example.com'];
    r = await A.dmTicket(env, req, { ok: true, installId: 'i1' }, '1000001');
    check(r.ok, '1f 開放之後所有付費者都可以');
    sess = null;
    r = await A.dmTicket(env, req, { ok: true, installId: 'i9' }, '1000001');
    const vAnon = r.ok && await A.dmTicketVerify(env, r.ticket, '1000001');
    check(r.ok && !r.post && r.unpaid && vAnon && vAnon.sub === 'i:i9' && vAnon.unpaid && !vAnon.post, '1f2 開放之後沒登入也看得到（身分＝安裝編號）、不能發', JSON.stringify(r));
    sess = { sub: 'g:111' }; gate = 'free';
    r = await A.dmTicket(env, req, { ok: true, installId: 'i1' }, '1000001');
    check(r.ok && !r.post && r.unpaid, '1f3 開放之後登入但沒付費：看得到、不能發');
    {
      const rm = room('dm:1000001:0');
      const ws = join(rm, sock('i:i9', { post: false, unpaid: true }));
      await say(rm, ws, '加油', 1000, 7);
      check(last(ws).t === 'err' && last(ws).code === 'E81' && last(ws).n === 7, '1f4 未付費的連線送彈幕 → E81（不是「被禁言」E83）', JSON.stringify(last(ws)));
      rm.ctx.sockets.length = 0;
    }
    gate = 'licensed';
    kv.set('dm:bans', JSON.stringify({ 'g:111': { mode: 'mute' } })); A.resetOps();
    r = await A.dmTicket(env, req, { ok: true, installId: 'i1' }, '1000001');
    check(r.ok && !r.post, '1g 被禁言的人看得到、不能發言');
    kv.delete('dm:bans'); A.resetOps();

    // ---- 2. 憑證 ----
    r = await A.dmTicket(env, req, { ok: true, installId: 'i1' }, '1000001');
    const v = await A.dmTicketVerify(env, r.ticket, '1000001');
    check(v && v.sub === 'g:111' && v.post, '2a 憑證驗得回同一個帳號');
    check(!(await A.dmTicketVerify(env, r.ticket, '1000002')), '2b 拿去別支影片無效');
    const parts = r.ticket.split('.');
    parts[5] = 'ps';
    check(!(await A.dmTicketVerify(env, parts.join('.'), '1000001')), '2c 竄改旗標無效（簽章對不上）');
    NOW += 61000;
    check(!(await A.dmTicketVerify(env, r.ticket, '1000001')), '2d 60 秒後過期');
    check(!r.ticket.includes('fan@') && !r.ticket.includes('other@'), '2e 憑證裡沒有信箱');
  }

  // ---- 3. 發言內容 ----
  check(A.dmClean('  加油  ') === '加油', '3a 前後空白拿掉');
  check(A.dmClean('a‮b​c') === 'abc', '3b 雙向控制與零寬字元拿掉');
  check(A.dmClean('x'.repeat(A.DM_MAX_LEN + 1)) === null, `3c 超過 ${A.DM_MAX_LEN} 字不收`);
  check(A.dmClean('哈'.repeat(12)) === null, '3d 同一個字連打十次以上（洗版）不收');
  check(A.dmBlocked('看這裡 www.example.com') === 'link' && A.dmBlocked('加我 @scammer01') === 'link', '3e 網址與帳號不收');
  check(A.dmBlocked('幹 你.娘') === 'word' && A.dmBlocked('ＷＴＦ 幹你娘') === 'word', '3f 拆字加空白／全形也擋得到');
  check(A.dmBlocked('Max 這圈太扯了') === null && A.dmBlocked('Box box!') === null, '3g 正常的比賽討論不擋');
  check(A.dmBlocked('什麼爛車', ['爛車']) === 'word', '3h 後台加的關鍵字有效');

  // ---- 4／5. 房間：頻率、廣播 ----
  await setOps({ danmaku: { on: true } });
  NOW = Date.parse('2026-11-01T06:00:00Z');
  const R = room('dm:1000001:0');
  const a = join(R, sock('g:a'));
  const b = join(R, sock('g:b'));
  // 影子禁言以名單為準（房間每則重查；連線時憑證上的旗標也是從同一份名單來的）
  kv.set('dm:bans', JSON.stringify({ 'g:sh': { mode: 'shadow' } })); A.resetOps();
  const sh = join(R, sock('g:sh', { shadow: true }));
  await say(R, a, 'Box box!', 60000, 7);
  check(last(a).t === 'ack' && last(a).n === 7, '4a 發言成功回 ack（帶回用戶端編號）', JSON.stringify(last(a)));
  NOW += 500;
  await say(R, a, '第二則', 60500, 8);
  check(last(a).code === 'E84', '4b 2 秒內第二則被擋（E84）', JSON.stringify(last(a)));
  await say(R, sh, '影子', 61000, 9);
  check(last(sh).t === 'ack', '5a 影子禁言的人照樣看到「成功」');
  const before = b.sent.length;
  flushAll();
  const got = b.sent.slice(before);
  check(got.length === 1 && got[0].t === 'm' && got[0].items.length === 1 && got[0].items[0].x === 'Box box!',
    '5b 合併廣播：別人收到一包，裡面沒有影子禁言的那則', JSON.stringify(got));
  const mine = sh.sent.filter((m) => m.t === 'm').pop();
  check(mine && mine.items.some((i) => i.x === '影子'), '5c 影子禁言的那則有送回他自己');
  check(!JSON.stringify(b.sent).includes('g:'), '5d 廣播裡沒有任何身分');

  for (let i = 0; i < A.DM_PER_MIN + 2; i++) { NOW += 2100; await say(R, b, '第' + i + '則', 70000 + i); }
  check(last(b).code === 'E84', `4c 一分鐘超過 ${A.DM_PER_MIN} 則被擋`, JSON.stringify(last(b)));

  // ---- 6. 連線中被禁言 ----
  kv.set('dm:bans', JSON.stringify({ 'g:a': { mode: 'mute' }, 'g:sh': { mode: 'shadow' } })); A.resetOps();
  NOW += 5000;
  await say(R, a, '我還能說嗎', 90000, 11);
  check(last(a).code === 'E83', '6a 連線中被禁言，下一則就擋（不等重連）', JSON.stringify(last(a)));
  kv.delete('dm:bans'); A.resetOps();

  // ---- 7. 刪除、檢舉 ----
  const firstId = R.one('SELECT MIN(id) AS id FROM dm').id;
  await R.webSocketMessage(b, JSON.stringify({ t: 'report', id: firstId }));
  await R.webSocketMessage(b, JSON.stringify({ t: 'report', id: firstId }));
  check(R.one('SELECT reports FROM dm WHERE id = ?', firstId).reports === 1, '7a 同一個人檢舉同一則只算一次');
  const idx = await room('__index').op({ op: 'reports' });
  check(idx.items.length === 1 && idx.items[0].cid === '1000001', '7b 檢舉進索引房間（後台看得到）');
  const r0 = await R.op({ op: 'range', from: 60000, to: 90000 });
  check(r0.items.some((i) => i.id === firstId), '7c 刪除前重播拿得到');
  await R.op({ op: 'state', id: firstId, state: 1 });
  check(b.sent.some((m) => m.t === 'del' && m.ids.includes(firstId)), '7d 刪除廣播給在線的人');
  const r1 = await R.op({ op: 'range', from: 60000, to: 90000 });
  check(!r1.items.some((i) => i.id === firstId) && !r1.items.some((i) => i.x === '影子'), '7e 刪除的與影子禁言的都不在重播裡');

  // ---- 8. 重播 ----
  check(r1.items.every((x, i, arr) => !i || arr[i - 1].pos <= x.pos), '8a 依影片位置排序');
  check(r1.items.every((x) => x.pos >= 60000 && x.pos < 90000), '8b 只拿那一段');

  // ---- 4d／4e 每日上限 ----
  {
    const Q = room('dm:1000009:0');
    const q = join(Q, sock('g:q', { cid: '1000009' }));
    const day = Date.parse('2026-11-01T00:00:00Z');
    for (let i = 0; i < A.DM_PER_DAY; i++) Q.sql.exec('INSERT INTO dm (pos, at, sub, text) VALUES (?, ?, ?, ?)', i, day + 1000 + i, 'g:q', 'x');
    NOW = Date.parse('2026-11-01T08:00:00Z');
    await say(Q, q, '還可以嗎', 1);
    check(last(q).code === 'E86', `4d 每人每天 ${A.DM_PER_DAY} 則`, JSON.stringify(last(q)));
    const Z = room('dm:1000010:0');
    const z = join(Z, sock('g:z', { cid: '1000010' }));
    Z.sql.exec(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${A.DM_ROOM_PER_DAY})
      INSERT INTO dm (pos, at, sub, text) SELECT i, ${day + 5000}, 'g:o' || i, 'x' FROM c`);
    await say(Z, z, '滿了嗎', 1);
    check(last(z).code === 'E86', `4e 每支影片每天 ${A.DM_ROOM_PER_DAY} 則（保險絲）`, JSON.stringify(last(z)));
  }

  // ---- 9. Haiku 審核 ----
  {
    let calls = 0;
    fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'N' }], usage: { input_tokens: 80, output_tokens: 1 } }) }; };
    const H = room('dm:1000020:0');
    const h = join(H, sock('g:h', { cid: '1000020' }));
    await setOps({ danmaku: { on: true } });
    NOW += 60000;
    await say(H, h, '普通的一句', 1);
    check(calls === 0 && last(h).t === 'ack', '9a 開關關著：不呼叫模型');
    await setOps({ danmaku: { on: true, aiMod: true } });
    NOW += 60000;
    await say(H, h, '變體髒話', 2);
    check(calls === 1 && last(h).code === 'E85', '9b 開關打開：模型回 N 就擋', JSON.stringify(last(h)));
    const cost = H.one('SELECT calls, inp FROM dm_cost');
    check(cost && cost.calls === 1 && cost.inp === 80, '9c 付了錢的呼叫有記帳（鐵則 44）');
    fetchImpl = async () => { throw new Error('down'); };
    NOW += 60000;
    await say(H, h, '服務壞了', 3);
    check(last(h).t === 'ack', '9d 審核服務壞掉：放行（關鍵字已經擋過一輪）');
    fetchImpl = async () => { throw new Error('不應該有網路呼叫'); };
    await setOps({ danmaku: { on: true } });
  }

  // ---- 10. 1,000 人同時在線 ----
  {
    const B = room('dm:1000030:0');
    const viewers = [];
    for (let i = 0; i < 1000; i++) viewers.push(join(B, sock('g:v' + i, { cid: '1000030' })));
    sends = 0; kvPuts = 0; timers.length = 0;
    NOW = Date.parse('2026-11-02T06:00:00Z');
    let said = 0;
    // 100 個人、每 0.4 秒的窗口裡各有 10 個人發言、共 30 個窗口
    for (let w = 0; w < 30; w++) {
      for (let k = 0; k < 10; k++) {
        const who = viewers[(w * 10 + k) % 100];
        await say(B, who, `第${w}輪 ${k}`, 120000 + w * 400 + k);
        said++;
      }
      flushAll();
      NOW += 2100;
    }
    const broadcastSends = sends - said;   // 扣掉回給發言者的 ack
    check(broadcastSends <= 30 * 1000, `10a 合併廣播：${said} 則 × 1,000 人，實際送出 ${broadcastSends} 次（不合併是 ${said * 1000}）`);
    check(kvPuts === 0, '10b 整段發言與廣播 KV 寫入 0 次（鐵則 10）', kvPuts);
  }

  // ---- 11. 原始碼契約 ----
  const part = require('fs').readFileSync(require('path').join(__dirname, '..', 'backend/src/parts/26-danmaku.js'), 'utf8');
  check(/ctx\.acceptWebSocket\(/.test(part) && !/server\.accept\(\)/.test(part), '11a 用 Hibernation API（ctx.acceptWebSocket），不用 accept()（整條連線計 duration）');
  const puts = part.match(/SUBS\.put\(([^,]+)/g) || [];
  check(puts.length === 1 && /DM_BANS_KEY/.test(puts[0]), '11b 彈幕的 KV 寫入只有後台的禁言名單', puts.join(' / '));
  const d0 = A.normDanmaku(undefined);
  check(d0.on === false && d0.aiMod === false && d0.allow.length === 0, '11c 預設：關閉、不用 Haiku、白名單空');
  check(/danmaku: normDanmaku\(o\.danmaku\)/.test(SRC), '11d opsConfig 帶 danmaku');
  check(/new_sqlite_classes = \["DanmakuRoom"\]/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'backend/wrangler.toml'), 'utf8')), '11e wrangler.toml 有 DanmakuRoom 的 migration（SQLite 版：免費方案只支援這種）');

  // ---- 12. 擴充功能：彈幕只在測試版（Ray 2026-10-28：先做好、不發行；工作規則 7）----
  {
    const fs = require('fs'); const p = require('path');
    const ext = (f) => fs.readFileSync(p.join(__dirname, '..', 'extension', f), 'utf8');
    const strip = (t) => t.replace(/\/\* @test-only:start \*\/[\s\S]*?\/\* @test-only:end \*\//g, '');
    const sw = ext('src/background/sw.js');
    check(/dmOpen/.test(sw) && !/dm(Open|Say|Range|Connect)|\/v1\/dm\//.test(strip(sw)), '12a sw.js 的彈幕程式碼全部在測試標記裡（正式版建置時整段移除）');
    check(!/danmaku/.test(ext('manifest.base.json')) && /danmaku-content\.js/.test(ext('manifest.test.json')), '12b 只有測試版 manifest 注入 danmaku-content.js');
    check(!/danmaku|\/v1\/dm\//.test(strip(ext('src/content/main.js'))), '12c main.js 沒有彈幕程式碼');
    const dc = ext('src/test/danmaku-content.js');
    check(/prefs = \{ on: false/.test(dc), '12d 畫面預設關閉');
    const dcCode = dc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    check(/player\.pos\(\)/.test(dcCode) && !/currentTime/.test(dcCode), '12e 位置讀進度條，不讀 video.currentTime（鐵則 63）');
    check(/\+\+c\.retry > DM_MAX_RETRY/.test(sw), '12f 重連有上限（鐵則 3）');
    check(!/innerHTML|insertAdjacentHTML/.test(dcCode), '12g 畫面（含屏蔽詞清單）不用 innerHTML——彈幕與屏蔽詞都是別人或自己打的字');
    const areas = ((dcCode.match(/const AREAS = (\[[^;]*\]);/) || [])[1] || '').match(/\d?\.\d+/g) || [];
    check(areas.length >= 3 && areas.every((v) => Number(v) <= 0.75), '12h 顯示區域最大 3/4（不蓋到下方的字幕）', areas.join(','));
    check(/function cleanPrefs/.test(dcCode) && /cleanPrefs\(r && r\[KEY\]\)/.test(dcCode), '12i 讀回來的設定一律過 cleanPrefs（舊版或壞掉的值退回預設）');
    check(/付費後即可發送/.test(dcCode) && /toldView/.test(dcCode), '12j 未付費只能看：說明原因，而且只說一次（不是每 60 秒跳一次）');
    check(/function flyLate/.test(dcCode) && /pos - it\.pos <= LIVE_GRACE_MS/.test(dcCode) && /flyLate\(m\.items/.test(dcCode),
      '12k 即時推來的彈幕有寬容：跑在最前面的人也看得到稍早位置的彈幕');
    check(/ctl\.append\(bar, tip, panel\)/.test(dcCode) && !/root\.append\(bar/.test(dcCode) && /innerWidth - s\.left/.test(dcCode),
      '12l 控制列在貼視窗的那一層、以視窗右下角記距離（改視窗大小不會跑掉）');
    // 2026-11-07 Ray：輸入框左邊的箭頭收合；收起來時輸入框、送出、設定、開關全部藏起來，只剩小圓鈕
    check(/bar\.append\(colBtn, input, sendBtn, gear, btn, bubble\)/.test(dcCode)
      && /collapsed: r\.collapsed === true/.test(dcCode)
      && /const expanded = !prefs\.collapsed/.test(dcCode)
      && ['input', 'colBtn', 'gear', 'btn'].every((n) => new RegExp(n + '\\.style\\.display = expanded').test(dcCode))
      && /bubble\.style\.display = expanded \? 'none' : 'flex'/.test(dcCode),
      '12m 收合：箭頭在輸入框左邊；收起時四個控制全部隱藏、只剩小圓鈕；狀態過 cleanPrefs 存起來');
    // 2026-11-08 Ray：離開影片回到網站頁面，小圓鈕還留在畫面上——沒有影片時整層要藏起來
    // ⚠️ 主程式離開影片時不清 contentId，只看 cid 在真的 F1TV 上沒用——一定要同時看頁面上有沒有影片
    check(/const onVideo = !!\(cid && vr &&/.test(dcCode) && /mainVideoRect\(\)/.test(dcCode)
      && /if \(!onVideo\) \{[\s\S]{0,200}root\.style\.display = 'none'[\s\S]{0,80}ctl\.style\.display = 'none'/.test(dcCode),
      '12n 頁面上沒有影片時彈幕層與控制列都隱藏（不只看 contentId），不留在網站頁面上');
  }

  // ---- 13. 後台即時處理（2026-10-28 Ray）----
  {
    const CID = '2000001';
    const rm = room(A.dmRoomName(CID, 0));
    const mk = (sub, extra) => join(rm, sock(sub, Object.assign({ cid: CID }, extra || {})));
    const adm = mk('admin', { admin: true, post: false });
    const v1 = mk('g:v1');
    const v2 = mk('g:v2');

    // 憑證：管理者旗標只認 sub＝admin；竄改不行
    const at = await A.dmTicketIssue(env, CID, 'admin', 'a');
    const av = await A.dmTicketVerify(env, at, CID);
    check(av && av.admin, '13a 管理者憑證驗得出來（旗標 a、sub＝admin）');
    const fake = await A.dmTicketIssue(env, CID, 'g:evil', 'a');
    check(!(await A.dmTicketVerify(env, fake, CID)).admin, '13b 一般帳號就算帶了 a 旗標也不是管理者');

    // 廣播：後台收帶身分的、觀眾收不帶身分的；後台不算在線人數
    NOW += 10000;
    await say(rm, v1, '安全車出來了', 5000, 1);
    flushAll();
    const am = adm.sent.find((m) => m.t === 'am');
    const vm1 = v2.sent.find((m) => m.t === 'm');
    check(am && am.items[0].sub === 'g:v1' && vm1 && !('sub' in vm1.items[0]) && !adm.sent.some((m) => m.t === 'm'),
      '13c 後台收到帶身分的「am」，觀眾的「m」沒有身分；後台不收觀眾那份', JSON.stringify({ am, vm1 }));
    const stats = await rm.op({ op: 'stats' });
    check(stats.online === 2, '13d 在線人數不算後台的連線', stats.online);
    await say(rm, adm, '我是管理員', 5000, 9);
    check(last(adm).t === 'err' && last(adm).code === 'E81', '13e 後台連線不能發彈幕');

    // 限時禁言 60 秒：當場生效、本人收到通知、時間到自動解除（不必重連）
    await rm.op({ op: 'ban', sub: 'g:v1', mode: 'mute', until: Math.floor(NOW / 1000) + 60, at: Math.floor(NOW / 1000) });
    check(v1.sent.some((m) => m.t === 'muted' && m.until > 0) && !v2.sent.some((m) => m.t === 'muted'), '13f 被禁言的人當場收到通知（只有他）');
    NOW += 3000;
    await say(rm, v1, '我被禁了嗎', 6000, 2);
    check(last(v1).code === 'E83' && /秒後解除/.test(last(v1).msg), '13g 限時禁言中：E83 並告訴他還剩幾秒', JSON.stringify(last(v1)));
    NOW += 61000;
    await say(rm, v1, '解禁了', 7000, 3);
    check(last(v1).t === 'ack', '13h 60 秒後自動解除，不必重新連線', JSON.stringify(last(v1)));

    // 解除以時間比新舊：KV 的解除紀錄蓋過房間裡較舊的永久禁言
    await rm.op({ op: 'ban', sub: 'g:v2', mode: 'mute', until: 0, at: Math.floor(NOW / 1000) });
    NOW += 3000;
    kv.set('dm:bans', JSON.stringify({ 'g:v2': { mode: '', at: Math.floor(NOW / 1000) } })); A.resetOps();
    await say(rm, v2, '我回來了', 8000, 4);
    check(last(v2).t === 'ack', '13i 在禁言名單頁解除（KV 較新的解除紀錄）蓋過房間裡較舊的禁言', JSON.stringify(last(v2)));
    // （解除紀錄留著：正式環境保留 7 天，拿掉的話房間裡較舊的禁言又會生效）

    // 暫停與慢速模式
    await rm.op({ op: 'ctl', paused: true, slow: 0 });
    check(v2.sent.some((m) => m.t === 'ctl' && m.ctl.paused), '13j 暫停會通知在線的觀眾');
    NOW += 3000;
    await say(rm, v2, '暫停中', 9000, 5);
    check(last(v2).code === 'E88', '13k 暫停中發言 → E88');
    await rm.op({ op: 'ctl', paused: false, slow: 10 });
    NOW += 15000;                        // 離上一則超過 10 秒，第一則要過
    await say(rm, v2, '慢速第一則', 9500, 6);
    NOW += 5000;
    await say(rm, v2, '慢速第二則', 9600, 7);
    check(v2.sent.some((m) => m.n === 6 && m.t === 'ack') && last(v2).code === 'E84' && /慢速模式/.test(last(v2).msg), '13l 慢速模式 10 秒：5 秒後第二則被擋', JSON.stringify(last(v2)));
    const badCtl = await rm.op({ op: 'ctl', paused: false, slow: 7 });
    check(badCtl.ctl.slow === 0, '13m 慢速只收 0／5／10／30 秒（亂填退回關閉）');
    await rm.op({ op: 'ctl', paused: false, slow: 0 });
    flushAll();

    // 自動隱藏：3 個登入帳號檢舉 → 收起來、觀眾收到 del、重播拿不到；沒登入的檢舉不算門檻
    NOW += 3000;
    await say(rm, v1, '欠檢舉的一則', 20000, 8);
    const target = last(v1).id;
    flushAll();
    for (const s of ['i:x1', 'i:x2', 'i:x3']) await rm.report(mk(s), { sub: s, cid: CID }, { id: target });
    let row = rm.one('SELECT state, reports FROM dm WHERE id = ?', target);
    check(row && row.state === 0 && row.reports === 3, '13n 三個沒登入的檢舉：記下來、但不自動隱藏（安裝編號免費無限領）', JSON.stringify(row));
    const reporter = mk('g:r1');
    await rm.report(reporter, { sub: 'g:r1', cid: CID }, { id: target });
    await rm.report(reporter, { sub: 'g:r2', cid: CID }, { id: target });
    v2.sent.length = 0;
    await rm.report(reporter, { sub: 'g:r3', cid: CID }, { id: target });
    row = rm.one('SELECT state FROM dm WHERE id = ?', target);
    const rng = await rm.op({ op: 'range', from: 0, to: 60000 });
    check(row.state === 3 && v2.sent.some((m) => m.t === 'del' && m.ids.includes(target)) && !rng.items.some((x) => x.id === target),
      '13o 三個登入帳號檢舉 → 自動隱藏（觀眾收到 del、重播拿不到）', JSON.stringify(row));
    check(adm.sent.some((m) => m.t === 'rep' && m.id === target && m.state === 3), '13p 後台即時收到檢舉與自動隱藏');
    check(reporter.sent.some((m) => m.t === 'reported' && m.id === target), '13q 檢舉的人收到「已收到」');
    v2.sent.length = 0;
    await rm.op({ op: 'state', id: target, state: 0 });
    check(v2.sent.some((m) => m.t === 'm' && m.items[0].id === target) && adm.sent.some((m) => m.t === 'st' && m.id === target && m.state === 0),
      '13r 後台判定沒問題 → 恢復並送回給在線的人');

    // 後台端點：限時只收 60／180／600；影子一律永久；解除留紀錄
    sb.authAdmin = () => true;
    const call = async (p, body) => {
      const r = await A.handleDanmakuAdmin({ method: 'POST', json: async () => body, headers: new Map() }, env, p, new URL('https://x' + p));
      return JSON.parse(r.body);
    };
    let r = await call('/v1/admin/dm/ban', { sub: 'g:z', mode: 'mute', sec: 180, cid: CID });
    check(r.until - Math.floor(NOW / 1000) === 180, '13s 禁言 180 秒', JSON.stringify(r));
    r = await call('/v1/admin/dm/ban', { sub: 'g:z', mode: 'mute', sec: 999 });
    check(r.until === 0, '13t 不是 60／180／600 的秒數 → 永久（不會變成奇怪的長度）');
    r = await call('/v1/admin/dm/ban', { sub: 'g:z', mode: 'shadow', sec: 60 });
    check(r.until === 0, '13u 影子禁言一律永久');
    r = await call('/v1/admin/dm/ban', { sub: 'admin', mode: 'mute' });
    check(r.error, '13v 不能禁言後台自己');
    await call('/v1/admin/dm/ban', { sub: 'g:z', mode: '' });
    const bans = JSON.parse(kv.get('dm:bans'));
    check(bans['g:z'] && bans['g:z'].mode === '' && bans['g:z'].at > 0, '13w 解除寫一筆有時間的紀錄（才蓋得過房間裡的舊禁言）');
    r = await call('/v1/admin/dm/ticket', { cid: CID });
    check(r.ticket && (await A.dmTicketVerify(env, r.ticket, CID)).admin, '13x 後台換得到管理者憑證');
    kv.delete('dm:bans'); A.resetOps();

    // 分類：年 → 站 → 場次
    sb.listBundleMeta = async () => [
      { cid: '3001', slug: '/detail/3001/2026-japanese-grand-prix' },
      { cid: '3002', slug: '/detail/3002/2025-british-grand-prix-qualifying' },
      { cid: '3003', slug: '' },
    ];
    const lab = await A.dmRoomsLabeled(env, [{ cid: '3001', n: 5, last: NOW }, { cid: '3002', n: 2, last: NOW }, { cid: '3003', n: 1, last: NOW }]);
    const by = Object.fromEntries(lab.map((x) => [x.cid, x]));
    check(by['3001'].year === 2026 && /^R\d+ /.test(by['3001'].gp.label) && by['3002'].year === 2025 && /British GP/.test(by['3002'].gp.label)
      && by['3003'].gp.key === 'other', '13y 有彈幕的影片依年份與站分類（本季對賽程、舊賽季從網址推、沒網址的另外放）',
      JSON.stringify(lab.map((x) => [x.cid, x.year, x.gp.label, x.title])));
  }

  // ---- 14. 批量刪除、刪除保留一星期（2026-10-29 Ray）----
  {
    NOW = Date.parse('2026-11-02T06:00:00Z');
    const CID = '2000002';
    const name = A.dmRoomName(CID, 0);
    const rm = room(name);
    const adm = join(rm, sock('admin', { cid: CID, admin: true, post: false }));
    const v = join(rm, sock('g:b1', { cid: CID }));
    const ids = [];
    for (let i = 0; i < 5; i++) { NOW += 2100; await say(rm, v, '洗版' + i, 1000 + i); ids.push(last(v).id); }
    flushAll();
    v.sent.length = 0; adm.sent.length = 0;
    const T0 = NOW;
    let r = await rm.op({ op: 'states', ids: ids.slice(0, 3).concat([ids[0], 999999]), state: 1 });
    const dels = v.sent.filter((m) => m.t === 'del');
    check(r.n === 3 && dels.length === 1 && dels[0].ids.length === 3, '14a 批量刪除：重複與不存在的略過，觀眾只收到一則 del（三個 id）', JSON.stringify([r, dels]));
    check(adm.sent.filter((m) => m.t === 'st' && m.state === 1 && m.del_at === T0).length === 3, '14b 後台收到每一則的新狀態與刪除時間');
    const al = await rm.ctx.storage.getAlarm();
    check(al === T0 + 7 * 86400000, '14c 排了一星期後的永久刪除', String(al - T0));
    const rng = await rm.op({ op: 'range', from: 0, to: 60000 });
    check(rng.items.length === 2, '14d 重播拿不到刪掉的', JSON.stringify(rng.items.map((x) => x.x)));
    // 一星期內：恢復得回來
    NOW = T0 + 3 * 86400000;
    await rm.op({ op: 'states', ids: [ids[0]], state: 0 });
    check(v.sent.some((m) => m.t === 'm' && m.items.some((x) => x.id === ids[0])), '14e 一星期內可以恢復，恢復的會送回給觀眾');
    // 還沒到：alarm 不刪
    await rm.alarm();
    let n = rm.one('SELECT COUNT(*) AS n FROM dm').n;
    check(n === 5, '14f 不到一星期，alarm 不刪任何一則', String(n));
    // 第二次刪除比較晚：alarm 不能被往後延
    await rm.op({ op: 'states', ids: [ids[3]], state: 1 });
    check((await rm.ctx.storage.getAlarm()) === T0 + 7 * 86400000, '14g 晚刪的不會把較早的那次永久刪除往後延');
    // 滿一星期：只刪滿一星期的，再排下一次
    NOW = T0 + 7 * 86400000 + 1;
    rm.sql.exec('INSERT INTO dm_report (id, sub, at) VALUES (?, ?, ?)', ids[1], 'g:r', NOW);
    await rm.alarm();
    const left = rm.sql.exec('SELECT id, state FROM dm ORDER BY id').toArray().map((x) => x.id);
    check(!left.includes(ids[1]) && !left.includes(ids[2]) && left.includes(ids[0]) && left.includes(ids[3]) && left.length === 3,
      '14h 滿一星期的永久刪除（恢復的、晚刪的、沒刪的都還在）', JSON.stringify(left));
    check(!rm.one('SELECT id FROM dm_report WHERE id = ?', ids[1]), '14i 檢舉紀錄跟著刪');
    check((await rm.ctx.storage.getAlarm()) === T0 + 3 * 86400000 + 7 * 86400000, '14j 再排下一次（晚刪的那則滿一星期時）');
    // 一次最多 200 則
    const many = Array.from({ length: 250 }, (_, i) => i + 1);
    r = await rm.op({ op: 'states', ids: many, state: 1 });
    check(r.ok && r.n <= 200, '14k 房間一次最多處理 200 則');
    const call = async (p, body) => JSON.parse((await A.handleDanmakuAdmin({ method: 'POST', json: async () => body, headers: new Map() }, env, p, new URL('https://x' + p))).body);
    r = await call('/v1/admin/dm/states', { cid: CID, ids: many, state: 1 });
    check(r.error, '14l 後台端點超過 200 則直接拒絕（不會默默只做一部分）');
    r = await call('/v1/admin/dm/states', { cid: CID, ids: [ids[4], ids[3]], state: 0 });
    check(r.ok && r.n === 2, '14m 後台端點批量恢復', JSON.stringify(r));
    // 舊房間：這一版以前刪掉的沒有時間 → 從啟動那一刻算一星期，不會一部署就消失
    const ctx = makeCtx();
    ctx.db.exec("CREATE TABLE dm (id INTEGER PRIMARY KEY AUTOINCREMENT, pos INTEGER NOT NULL, at INTEGER NOT NULL, sub TEXT NOT NULL, text TEXT NOT NULL, live INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0)");
    ctx.db.exec("INSERT INTO dm (pos, at, sub, text, state) VALUES (1, 1, 'g:o', '舊的刪除', 1), (2, 2, 'g:o', '舊的正常', 0)");
    const old = new A.DanmakuRoom(ctx, env);
    await new Promise((res) => setImmediate(res));
    const od = old.one("SELECT del_at FROM dm WHERE text = '舊的刪除'");
    check(od && od.del_at === NOW && (await ctx.storage.getAlarm()) === NOW + 7 * 86400000, '14n 舊房間加上欄位，舊的刪除從現在起保留一星期', JSON.stringify(od));
  }

  if (failed) { console.log(`\n❌ 彈幕 ${failed} 項未通過`); process.exit(1); }
  console.log('\n✅ 彈幕（四道門、憑證、內容與頻率、合併廣播、影子禁言、刪除與檢舉、重播、Haiku 開關、1,000 人、KV 0 寫入）');
})().catch((e) => { console.log('❌ check-danmaku 執行失敗：' + (e && e.stack || e)); process.exit(1); });
