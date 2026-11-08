#!/usr/bin/env node
/**
 * 前導收割端巡查（leaderWatch，backend v5.66，2026-10-25）的行為檢查。
 *
 * 為什麼需要：巡查跑在 cron 裡、整段包在 catch 底下——寄不出去、根本沒跑、條件寫錯，
 * 三種情況看起來都一樣：沒有信（鐵則 28）。而「沒有信」本來就是正常狀態，沒有人會發現它壞了。
 *
 * 驗：
 *   1. 場次開始 10 分鐘、前導端從沒出現 → 寄一封到 LEADER_ALERT_TO；同一個時段再跑一次不再寄
 *   2. 前導端有心跳（/v1/leader/beat 會記到全域）→ 不寄
 *   3. 前導端最後是主動離開（bye）→ 算不在 → 寄（這一場還沒來）
 *   4. 寄信失敗 → 名額放回去，下一次還會再試
 *   5. 不在 [10, 15) 分鐘的窗內 → 不寄（cron 每 5 分鐘一次，一場只會落到一次）
 *   6. 節目（Pre-Race Show 等）也會被巡查
 *   7. scheduled()：每 5 分鐘那條只跑巡查，不同步賽程、不寫 KV（鐵則 10）
 *   8. wrangler.toml 的 cron 字串與 LEADER_WATCH_CRON 一字不差（不一致 → 分流失效，巡查從來不跑）
 *
 * 用法：node tools/check-leader-watch.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const vm = require('vm');
const root = path.join(__dirname, '..');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const fail = (m, d) => { errors.push(m); console.log('❌ ' + m + (d ? '：' + d : '')); };

// 嚴格模式：真正的 Worker 是 ESM（坑 #37）
let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{/, 'var __worker = {');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

let NOW = 0;                                   // 假時鐘（毫秒）
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}

const mails = [];
let mailFails = false;
const sandbox = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
  Response: class {
    constructor(b, i) { this.body = b; this.status = 200; Object.assign(this, i || {}); if (this.ok === undefined) this.ok = this.status >= 200 && this.status < 300; }
    async json() { try { return JSON.parse(this.body); } catch (e) { return null; } }
    async text() { return String(this.body); }
  },
  Request: class {}, Headers: class { constructor() {} },
  URL, URLSearchParams, console: { log() {}, warn() {}, error() {} },
  Date: FakeDate, Math, JSON, Map, Set, Promise, RegExp, Error, Intl,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, isNaN,
  setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
  fetch: async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      if (mailFails) return { ok: false, status: 500, async json() { return {}; }, async text() { return 'x'; } };
      mails.push(JSON.parse(init.body));
      return { ok: true, status: 200, async json() { return { id: 'm' }; }, async text() { return '{}'; } };
    }
    throw new Error('未預期的網路呼叫：' + url);
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { leaderWatch, leaderDownAlert, leaderNoCidAlert, roomOp, SubtitleRoom, AuthGuard, gpShows, LEADER_WATCH_CRON, LEADER_GLOBAL_ROOM, worker: __worker, REMOTE_CONFIG, harvestStatusClean, HSTAT_MAX, HSTAT_KEEP_MS };', sandbox);
const A = sandbox.__api;

/** Durable Object 的 storage：get(key|陣列)、put(key, v | 物件)、delete、鬧鐘 */
function fakeStorage() {
  const m = new Map();
  return {
    async get(k) { if (Array.isArray(k)) { const o = new Map(); for (const x of k) if (m.has(x)) o.set(x, m.get(x)); return o; } return m.get(k); },
    async put(k, v) { if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, b); } else m.set(k, v); },
    async delete(k) { if (Array.isArray(k)) { let n = 0; for (const x of k) n += m.delete(x) ? 1 : 0; return n; } return m.delete(k); },
    async list(o) { const pre = (o && o.prefix) || ""; return new Map([...m].filter(([k]) => String(k).startsWith(pre))); },
    async getAlarm() { return 1; }, async setAlarm() {},
  };
}
function ns(Cls, env) {
  const rooms = new Map();
  return {
    idFromName: (n) => ({ name: n, toString: () => n }),
    get(id) {
      const key = String(id.name);
      if (!rooms.has(key)) rooms.set(key, { inst: new Cls({ storage: fakeStorage() }, env), q: Promise.resolve() });
      const r = rooms.get(key);
      return { fetch(url, init) { const n = r.q.then(() => r.inst.fetch({ async json() { return JSON.parse(init.body); } })); r.q = n.catch(() => {}); return n; } };
    },
  };
}

const kvWrites = [];
function makeEnv() {
  const kv = new Map();
  const env = {
    TOKEN_SECRET: 'test-secret', RESEND_API_KEY: 're_test', REPORT_TO: 'office@example.com', LEADER_ALERT_TO: 'ray@example.com',
    SUBS: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => { kvWrites.push(k); kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
      list: async () => ({ keys: [], list_complete: true }),
    },
  };
  env.ROOM = ns(A.SubtitleRoom, env);
  env.AUTH = ns(A.AuthGuard, env);
  return env;
}

// 用內建賽程的美國站（R18）
const us = A.REMOTE_CONFIG.schedule.find((g) => g.r === 18);
const race = us.sessions.find((s) => s.k === 'race').t;

(async () => {
  // 1. 開始 11 分鐘，從沒出現
  {
    const env = makeEnv(); mails.length = 0;
    NOW = (race + 11 * 60) * 1000;
    const r1 = await A.leaderWatch(env);
    const r2 = await A.leaderWatch(env);
    mails.length === 1 && mails[0].to[0] === 'ray@example.com' && /正賽/.test(mails[0].subject)
      ? ok('正賽開始 11 分鐘、前導端從沒出現 → 寄一封到 LEADER_ALERT_TO（不是 REPORT_TO）')
      : fail('沒有寄到 LEADER_ALERT_TO', JSON.stringify({ n: mails.length, to: mails[0] && mails[0].to, r1 }));
    mails.length === 1 && r2 && r2.skipped ? ok('同一場再巡一次不再寄') : fail('同一場寄了不只一封', JSON.stringify(r2));
  }
  // 2. 有心跳
  {
    const env = makeEnv(); mails.length = 0;
    NOW = (race + 11 * 60) * 1000;
    await A.roomOp(env, A.LEADER_GLOBAL_ROOM, { op: 'beat' });
    NOW += 60000;
    const r = await A.leaderWatch(env);
    !mails.length && r && r.present ? ok('前導端 1 分鐘前有心跳 → 不寄') : fail('前導端在卻寄了告警', JSON.stringify(r));
  }
  // 3. 最後是 bye
  {
    const env = makeEnv(); mails.length = 0;
    NOW = (race + 9 * 60) * 1000;
    await A.roomOp(env, A.LEADER_GLOBAL_ROOM, { op: 'beat' });
    NOW += 30000;
    await A.roomOp(env, A.LEADER_GLOBAL_ROOM, { op: 'bye' });
    NOW = (race + 11 * 60) * 1000;
    await A.leaderWatch(env);
    mails.length === 1 ? ok('前導端最後是主動離開（bye）→ 算不在，照樣寄') : fail('前導端離開後沒有告警', String(mails.length));
  }
  // 4. 寄信失敗 → 放回名額
  {
    const env = makeEnv(); mails.length = 0;
    NOW = (race + 11 * 60) * 1000;
    mailFails = true;
    await A.leaderWatch(env);
    mailFails = false;
    await A.leaderWatch(env);
    mails.length === 1 ? ok('寄信失敗時名額放回去，下一次巡查補寄') : fail('寄信失敗之後就再也不寄了', String(mails.length));
  }
  // 5. 窗外
  {
    const env = makeEnv(); mails.length = 0;
    let n = 0;
    for (const m of [5, 9, 15, 20, 40]) { NOW = (race + m * 60) * 1000; const r = await A.leaderWatch(env); if (r && r.due) n++; }
    !mails.length && !n ? ok('開始 5／9／15／20／40 分鐘都不在巡查窗內（一場只會落到一次）') : fail('巡查窗不對', `due ${n}、信 ${mails.length}`);
  }
  // 6. 節目
  {
    const env = makeEnv(); mails.length = 0;
    const prer = A.gpShows(us).find((x) => x.kind === 'prer');
    NOW = (prer.at + 11 * 60) * 1000;
    await A.leaderWatch(env);
    prer && prer.at === race - 70 * 60 && mails.length === 1 && /Pre-Race Show/.test(mails[0].subject)
      ? ok('節目也巡查（Pre-Race Show＝正賽前 70 分鐘）')
      : fail('節目沒有被巡查', JSON.stringify({ prer, n: mails.length }));
  }
  // 7. scheduled 分流
  {
    const env = makeEnv(); mails.length = 0; kvWrites.length = 0;
    NOW = (race + 11 * 60) * 1000;
    const waits = [];
    await A.worker.scheduled({ cron: A.LEADER_WATCH_CRON }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    mails.length === 1 && !kvWrites.length
      ? ok('scheduled()：每 5 分鐘那條只跑巡查（寄了信、沒有寫任何 KV、沒有同步賽程）')
      : fail('每 5 分鐘的排程跑錯了東西', JSON.stringify({ mails: mails.length, kv: kvWrites }));
  }
  // 8. wrangler.toml
  {
    const toml = fs.readFileSync(path.join(root, 'backend/wrangler.toml'), 'utf8');
    const m = toml.match(/^crons\s*=\s*\[([^\]]*)\]/m);
    const crons = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    crons.includes(A.LEADER_WATCH_CRON) && crons.includes('0 4 * * *')
      ? ok(`wrangler.toml 的 crons 有「${A.LEADER_WATCH_CRON}」與每日那一條`)
      : fail('wrangler.toml 的 crons 與 LEADER_WATCH_CRON 對不上——巡查永遠不會跑', JSON.stringify(crons));
    /^LEADER_ALERT_TO\s*=\s*"[^"@\s]+@[^"\s]+"/m.test(toml) ? ok('wrangler.toml 有 LEADER_ALERT_TO') : fail('wrangler.toml 沒有 LEADER_ALERT_TO');
  }
  // 9. 心跳端點要同時記全域那一份——少了它，巡查與備援機永遠看到「不在」（主機在播也照寄告警、備援機也開直播＝互踢）
  {
    const raw = readBackend();
    const i = raw.indexOf("path === '/v1/leader/beat'");
    const seg = i > 0 ? raw.slice(i, raw.indexOf("path === '/v1/leader/status'", i)) : '';
    /roomOp\(env,\s*LEADER_GLOBAL_ROOM,\s*\{\s*op:\s*b\.bye === true \? 'bye' : 'beat'/.test(seg)
      ? ok('/v1/leader/beat 同時記全域的前導端心跳（巡查與備援機看的那一份）')
      : fail('/v1/leader/beat 沒有記全域心跳');
  }
  // 10. 重疊：前導端在節目上、觀眾在正式場次（R18 排位前收到的那封誤報）
  {
    const env = makeEnv(); mails.length = 0;
    NOW = (race + 30 * 3600) * 1000;                      // 另一個 2 小時時段（記憶體的節流與前面無關）
    await A.roomOp(env, A.LEADER_GLOBAL_ROOM, { op: 'beat' });
    NOW += 30000;
    await A.leaderDownAlert(env, '1000010406', 0);
    const quiet = mails.length === 0;
    NOW += 30 * 60000;                                    // 30 分鐘後前導端哪裡都不在了
    await A.leaderDownAlert(env, '1000010406', 0);
    quiet && mails.length === 1 && mails[0].to[0] === 'ray@example.com'
      ? ok('前導端在別支影片上有心跳 → 觀眾那邊不寄「不在」；哪裡都沒有心跳 → 照寄')
      : fail('重疊時的告警不對', JSON.stringify({ quiet, n: mails.length }));
  }
  // 13. 房間休眠：沒有 WebSocket 的 DO 閒置 10 秒就休眠、記憶體丟掉（R18 排位後節目：B 自己翻 62% 的原因）
  {
    const storage = fakeStorage();
    const mk = () => new A.SubtitleRoom({ storage }, {});
    const call = async (o, b) => (await o.fetch({ async json() { return b; } })).json();
    NOW = (race + 50 * 3600) * 1000;
    await call(mk(), { op: 'done', lines: { 'k one': '一', 'k two': '二' }, leader: true });
    NOW += 12000;                                           // 12 秒後（中間休眠過）＝新的實例、同一份 storage
    const p1 = await call(mk(), { op: 'peek', keys: ['k one', 'k two', 'k three'] });
    // 晚 10 分鐘加入的觀眾會補抓整個直播滑動視窗（R18 B 晚 9.5 分鐘加入、共用快取只給 1 句）
    NOW += 10 * 60000;
    const pLate = await call(mk(), { op: 'peek', keys: ['k one'] });
    NOW += 6 * 60000;                                       // 超過保留時間（15 分鐘）
    const p2 = await call(mk(), { op: 'peek', keys: ['k one'] });
    const rows = [...(await storage.list({ prefix: 'res:' })).keys()];
    p1.lines['k one'] === '一' && p1.lines['k two'] === '二' && !p1.lines['k three'] && pLate.lines['k one'] === '一'
      && !p2.lines['k one'] && !rows.length
      ? ok('房間休眠後翻好的句子還拿得到；晚 10 分鐘加入也拿得到；超過 15 分鐘就沒有，storage 裡過期的列也刪掉了')
      : fail('房間的結果撐不到該撐的時間（觀眾會自己重翻）', JSON.stringify({ p1: p1.lines, late: pLate.lines, p2: p2.lines, rows }));
  }
  // 12. 管理版：前導端沒有影片編號一律不送（要排在「等 15 秒就照送進 misc」之前）；正式版不可以有這段
  {
    const build = (d) => { try { return fs.readFileSync(path.join(root, 'dist', d, 'src/content/main.js'), 'utf8'); } catch (e) { return ''; } };
    const adm = build('pitlingo-admin');
    const rel = build('pitlingo-release');
    const fp = (s) => { const i = s.indexOf('async function flushPending()'); return i > 0 ? s.slice(i, s.indexOf('最後一道', i)) : ''; };
    const a = fp(adm);
    const iHold = a.indexOf('if (leaderMode) {');
    const iWait = a.indexOf('Date.now() - noCidSince < CID_WAIT_MS');
    !adm || !rel
      ? fail('找不到 dist 建置（先跑 node tools/build-extension.js）')
      : iHold > 0 && iWait > iHold && /leaderNoCidReload\(\)/.test(a) && /leaderFinalDiag\('前導端離開這一場/.test(adm)
        && !/leaderNoCidReload|leaderFinalDiag/.test(rel)
        ? ok('管理版：前導端沒有影片編號就不翻譯、2 分鐘重新整理、離開前送診斷；正式版沒有這些')
        : fail('管理版的無影片編號保護不對', JSON.stringify({ iHold, iWait, relLeak: /leaderNoCidReload|leaderFinalDiag/.test(rel) }));
  }
  // 11. 收割端沒有影片編號
  {
    const env = makeEnv(); mails.length = 0;
    NOW = (race + 40 * 3600) * 1000;
    await A.leaderNoCidAlert(env, 'misc');
    await A.leaderNoCidAlert(env, 'misc');
    mails.length === 1 && /影片編號/.test(mails[0].subject) && mails[0].to[0] === 'ray@example.com'
      ? ok('收割端在直播中送了沒有影片編號的翻譯 → 寄一封到 LEADER_ALERT_TO，同時段不重寄')
      : fail('沒有影片編號的告警不對', String(mails.length));
    const raw = readBackend();
    const i = raw.indexOf('async function handleTranslate(');
    const seg = raw.slice(i, raw.indexOf('checkEntitlement(env, auth, request', i));
    /if \(!shared && auth\.harvest && body\.live === true\) await leaderNoCidAlert\(env, cid\)/.test(seg)
      ? ok('handleTranslate 真的會呼叫這個告警（收割身分＋直播＋沒有數字 cid）')
      : fail('handleTranslate 沒有呼叫 leaderNoCidAlert');
  }

  // ---- 收割端狀態回報（2026-10-30，/v1/admin/harvest/status → 後台「即時狀態」）----
  {
    const C = A.harvestStatusClean;
    const good = { id: 'abc123-tab9', status: { ver: '1.0.0', cid: '1000010422', isLive: true, lines: ['x'.repeat(500), '<b>y</b>'], autoLive: 'standby',
      seek: { now: 123456, max: 200000 }, video: { paused: false, t: 99.5 }, behind: 3.2, frozen: false, raf: 60, evil: 'z', win: [1, 2, 3, 4] } };
    const c = C(good);
    !c.error && c.status.lines[0].length === 300 && c.status.evil === undefined && c.status.autoLive === 'standby' && c.status.seek.now === 123456
      ? ok('狀態回報：只留認得的欄位、長度截斷')
      : fail('狀態回報的清洗不對', JSON.stringify(c).slice(0, 200));
    C({ id: '../x', status: {} }).error && C({ id: 'a-b' }).error && C({ id: 'a-b', status: { cid: 'abc', seek: { now: 'NaN' } } }).status.cid === ''
      ? ok('狀態回報：id 格式不對、沒有 status 一律拒絕；cid 不是數字就清掉')
      : fail('狀態回報的格式驗證放行了不該放的');
    const env = makeEnv();
    kvWrites.length = 0;
    NOW = Date.parse('2026-10-30T00:00:00Z');
    for (let i = 0; i < A.HSTAT_MAX + 2; i++) { NOW += 1000; await A.roomOp(env, A.LEADER_GLOBAL_ROOM, { op: 'hstat', id: 'p' + i + '-t', status: c.status }); }
    let l = await A.roomOp(env, A.LEADER_GLOBAL_ROOM, { op: 'hstatList' });
    l && l.items.length === A.HSTAT_MAX && l.items[0].id === 'p' + (A.HSTAT_MAX + 1) + '-t' && l.items[0].at === NOW
      ? ok(`狀態回報：最多留 ${A.HSTAT_MAX} 張、最新的在前、帶伺服器時間`)
      : fail('狀態卡的上限或排序不對', JSON.stringify(l && l.items.map((x) => x.id)));
    NOW += A.HSTAT_KEEP_MS + 1;
    l = await A.roomOp(env, A.LEADER_GLOBAL_ROOM, { op: 'hstatList' });
    l && l.items.length === 0 ? ok('狀態回報：6 小時沒更新的不顯示') : fail('過期的狀態卡還在');
    kvWrites.length === 0 ? ok('狀態回報不寫 KV（存在 Durable Object，鐵則 10）') : fail('狀態回報寫了 KV', kvWrites.join(','));
    const raw = readBackend();
    const hr = raw.slice(raw.indexOf('const HARVEST_ROUTES'), raw.indexOf(']);', raw.indexOf('const HARVEST_ROUTES')));
    hr.includes("'POST /v1/admin/harvest/status'") && /harvesters:/.test(raw.slice(raw.indexOf('async function liveSnapshot(')))
      ? ok('收割權杖可以送狀態（白名單）、/v1/admin/live 帶 harvesters')
      : fail('狀態回報的端點沒接上');
  }

  console.log(errors.length ? `\n❌ ${errors.length} 項未通過` : '\n✅ 前導收割端巡查全部符合預期');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log('❌ 測試本身出錯：' + (e && e.stack || e)); process.exit(1); });
