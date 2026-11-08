#!/usr/bin/env node
/**
 * F1TV 賽事頁的真實時程（2026-10-26，A4／A13／A17）。
 *
 * 為什麼需要：後端的節目時間原本是用美國站推算的偏移量。R19 墨西哥 F1TV 賽事頁實際是
 * Weekend Warm-Up 04:30（台灣）、推算的是 10:30——照推算排程整場漏掉；Pre-Qualifying 差 25 分、Post-Qualifying 差 50 分。
 * 管理版收割端讀 F1TV 自己的內容 API、送給後端；後端嚴格驗證後以它為準。
 *
 * 下面的資料是 2026-10-26 從 F1TV 內容 API（/2.0/R/ENG/WEB_DASH/ALL/PAGE/<id>/PRO/3）實際讀到的
 * 墨西哥站（12332）與新加坡站（12328，衝刺週末）的場次，只留時間、contentId、網址、titleBrief。
 *
 *   1. 收割端的解析：titleBrief → kind；F1 Kids、F1 Academy、精華、沒有播放網址的都不收
 *   2. 後端驗證：墨西哥那份收下、正式場次與官方賽程一致（mismatch 為空）
 *   3. 收下之後 /v1/schedule 的 shows 換成 F1TV 的時間（Warm-Up 04:30 台灣）、f1tv 帶 contentId／網址
 *   4. 同一份再送一次：不寫 KV（鐵則 10）
 *   5. 擋得住：沒有正賽、正賽差 3 小時、網址的 cid 對不上、時間在週末範圍外、把新加坡那份送成墨西哥
 *   6. 收割端 alFindLink：表定前 20 分鐘起直接開 F1TV 的網址（A13／A17），之前照舊在首頁找；播完的不再開
 *   7. AL_NOT_F1 擋得掉 F1 Kids（2026-singapore-gp-f1-kids-sprint 也以 -sprint 結尾）
 *
 * 用法：node tools/check-f1tv-schedule.js
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

const iso = (s) => Math.floor(Date.parse(s) / 1000);
// [titleBrief, Series, start, end, href]
const MEXICO = [
  ['Weekend Warm-Up', 'FORMULA 1', '2026-10-29T20:30:00Z', '2026-10-29T21:30:00Z', '/detail/1000010422/weekend-warm-up-mexico?action=play'],
  ['Practice 1', 'FORMULA 1', '2026-10-30T18:30:00Z', '2026-10-30T19:30:00Z', '/detail/1000010412/2026-mexico-city-gp-practice-1?action=play'],
  ['Practice 2', 'FORMULA 1', '2026-10-30T22:00:00Z', '2026-10-30T23:00:00Z', '/detail/1000010413/2026-mexico-city-gp-practice-2?action=play'],
  ['Practice 3', 'FORMULA 1', '2026-10-31T17:30:00Z', '2026-10-31T18:30:00Z', '/detail/1000010414/2026-mexico-city-gp-practice-3?action=play'],
  ['Pre-Qualifying Show', 'FORMULA 1', '2026-10-31T20:00:00Z', '2026-10-31T21:00:00Z', '/detail/1000010415/pre-qualifying-show-mexico?action=play'],
  ['Qualifying', 'FORMULA 1', '2026-10-31T21:00:00Z', '2026-10-31T22:00:00Z', '/detail/1000010417/2026-mexico-city-gp-qualifying?action=play'],
  ['Post-Qualifying Show', 'FORMULA 1', '2026-10-31T23:00:00Z', '2026-11-01T00:00:00Z', '/detail/1000010416/post-qualifying-show-mexico?action=play'],
  ['Pre-Race Show', 'FORMULA 1', '2026-11-01T19:00:00Z', '2026-11-01T20:00:00Z', '/detail/1000010418/pre-race-show-mexico?action=play'],
  ['Race', 'FORMULA 1', '2026-11-01T20:00:00Z', '2026-11-01T22:00:00Z', '/detail/1000010420/2026-mexico-city-grand-prix?action=play'],
  ['Post-Race Show', 'FORMULA 1', '2026-11-01T22:00:00Z', '2026-11-01T23:00:00Z', '/detail/1000010419/post-race-show-mexico?action=play'],
  // 不該收的：F1 Academy、精華（沒有 ?action=play）
  ['Race', 'F1 ACADEMY', '2026-11-01T16:00:00Z', '2026-11-01T17:00:00Z', '/detail/1000077999/2026-mexico-city-gp-f1a-race?action=play'],
  ['Race Highlights', 'FORMULA 1', '2026-11-01T23:00:00Z', '2026-11-01T23:10:00Z', '/detail/1000078999/race-highlights-mexico'],
];
const SINGAPORE = [
  ['Weekend Warm-Up', 'FORMULA 1', '2026-10-08T13:30:00Z', '2026-10-08T14:10:00Z', '/detail/1000010388/weekend-warm-up-singapore?action=play'],
  ['Practice 1', 'FORMULA 1', '2026-10-09T08:30:00Z', '2026-10-09T09:45:00Z', '/detail/1000010392/2026-singapore-gp-practice-1?action=play'],
  ['Sprint Qualifying', 'FORMULA 1', '2026-10-09T12:30:00Z', '2026-10-09T13:30:00Z', '/detail/1000010389/2026-singapore-gp-sprint-qualifying?action=play'],
  ['Pre-Sprint Show', 'FORMULA 1', '2026-10-10T08:15:00Z', '2026-10-10T08:56:00Z', '/detail/1000010399/pre-sprint-show-singapore?action=play'],
  ['Sprint', 'FORMULA 1', '2026-10-10T09:00:00Z', '2026-10-10T10:00:00Z', '/detail/1000010390/2026-singapore-gp-sprint?action=play'],
  ['F1 Kids Sprint', 'FORMULA 1', '2026-10-10T09:00:00Z', '2026-10-10T10:00:00Z', '/detail/1000011236/2026-singapore-gp-f1-kids-sprint?action=play'],
  ['Post-Sprint Show', 'FORMULA 1', '2026-10-10T10:00:00Z', '2026-10-10T10:30:00Z', '/detail/1000010393/post-sprint-show-singapore?action=play'],
  ['Pre-Qualifying Show', 'FORMULA 1', '2026-10-10T12:40:00Z', '2026-10-10T13:25:00Z', '/detail/1000010400/pre-qualifying-show-singapore?action=play'],
  ['Qualifying', 'FORMULA 1', '2026-10-10T13:30:00Z', '2026-10-10T14:40:00Z', '/detail/1000010395/2026-singapore-gp-qualifying?action=play'],
  ['Post-Qualifying Show', 'FORMULA 1', '2026-10-10T14:40:00Z', '2026-10-10T15:10:00Z', '/detail/1000010394/post-qualifying-show-singapore?action=play'],
  ['Pre-Race Show', 'FORMULA 1', '2026-10-11T10:50:00Z', '2026-10-11T11:55:00Z', '/detail/1000010396/pre-race-show-singapore?action=play'],
  ['Race', 'FORMULA 1', '2026-10-11T12:00:00Z', '2026-10-11T14:00:00Z', '/detail/1000010398/2026-singapore-grand-prix?action=play'],
  ['F1 Kids', 'FORMULA 1', '2026-10-11T12:00:00Z', '2026-10-11T14:00:00Z', '/detail/1000011237/2026-singapore-gp-f1-kids?action=play'],
  ['Post-Race Show', 'FORMULA 1', '2026-10-11T14:00:00Z', '2026-10-11T14:40:00Z', '/detail/1000010397/post-race-show-singapore?action=play'],
];
/** 做成 F1TV 內容 API 的形狀（事件埋在好幾層 containers 裡） */
function apiPage(rows) {
  const events = rows.map(([tb, series, st, en, href]) => ({
    id: (href.match(/\/detail\/(\d+)/) || [])[1],
    metadata: { titleBrief: tb, title: tb, emfAttributes: { sessionStartDate: String(Date.parse(st)), sessionEndDate: String(Date.parse(en)), Series: series, state: 'Pre-Live' } },
    actions: [{ href }],
  }));
  return { resultObj: { containers: [{ x: 1 }, { retrieveItems: { resultObj: { containers: [{ events }] } } }] } };
}

// ---- 收割端：從 harvest.js 取出解析與找連結的函式（它們在 IIFE 裡，沒有匯出）----
const hsrc = fs.readFileSync(path.join(root, 'extension/src/admin/harvest.js'), 'utf8');
function grab(re, name) {
  const m = hsrc.match(re);
  if (!m) { bad('harvest.js 裡找不到 ' + name); process.exit(1); }
  return m[0];
}
const block = [
  "const cidOf = (p) => (String(p).match(/\\/detail\\/(\\d+)/) || [])[1] || '';",
  grab(/const F1TV_BRIEF = \{[\s\S]*?\n {2}\};/, 'F1TV_BRIEF'),
  grab(/function f1tvWalk\(j, test\) \{[\s\S]*?\n {2}\}/, 'f1tvWalk'),
  grab(/function f1tvEvents\(j\) \{[\s\S]*?\n {2}\}/, 'f1tvEvents'),
  grab(/const AL_SLUG = \{[\s\S]*?\n {2}\};/, 'AL_SLUG'),
  grab(/const AL_SHOW = new Set\([^\n]*\);/, 'AL_SHOW'),
  grab(/const AL_NOT_F1 = [^\n]*;/, 'AL_NOT_F1'),
  grab(/const AL_DIRECT_SEC = [^\n]*;/, 'AL_DIRECT_SEC'),
  grab(/function alFindLink\(s, ended, g\) \{[\s\S]*?\n {2}\}/, 'alFindLink'),
].join('\n');
const hbox = { Date, Map, Set, Number, String, Math, scrapeList: [] };
vm.createContext(hbox);
vm.runInContext("'use strict';\nconst scrape = () => this.scrapeList;\n" + block
  + '\nthis.h = { f1tvEvents, alFindLink, AL_NOT_F1, AL_SLUG };', hbox);
const H = hbox.h;

const mx = H.f1tvEvents(apiPage(MEXICO));
const sg = H.f1tvEvents(apiPage(SINGAPORE));
const kinds = (a) => a.map((x) => x.kind).sort().join(',');
check(kinds(mx) === 'fp1,fp2,fp3,postq,postr,preq,prer,quali,race,warmup', '1a 墨西哥解析出 10 場、F1 Academy 與精華不收', kinds(mx));
check(kinds(sg) === 'fp1,postq,postr,posts,preq,prer,pres,quali,race,sprint,sq,warmup', '1b 新加坡（衝刺週末）解析出 12 場、F1 Kids 不收', kinds(sg));
const mxRace = mx.find((x) => x.kind === 'race');
check(mxRace && mxRace.cid === '1000010420' && mxRace.at === iso('2026-11-01T20:00:00Z'), '1c 正賽的 cid／時間正確');
check(sg.find((x) => x.kind === 'sprint').cid === '1000010390', '1d 衝刺賽選到 F1 的那一支，不是 F1 Kids Sprint（同一個時段）');

// ---- 後端 ----
let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');
const NOW = Date.parse('2026-10-26T12:00:00Z');
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const kvm = new Map();
const kv = {
  puts: 0,
  async get(k) { return kvm.has(k) ? kvm.get(k) : null; },
  async put(k, v) { this.puts++; kvm.set(k, v); },
  async delete(k) { kvm.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const sandbox = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
  Response: class { constructor(b, i) { this.body = b; Object.assign(this, i || {}); } },
  Request: class {}, URL, console: { log() {}, warn() {}, error() {} },
  Date: FakeDate, Math, JSON, Map, Set, Promise, RegExp, Error,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('不應該有網路呼叫'); },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { gpList, gpId, gpShows, gpProduct, gpSession, f1tvSchedClean, f1tvSchedSave, loadSchedule, HARVEST_ROUTES };', sandbox);
const B = sandbox.__api;
const env = { SUBS: kv };

(async () => {
  await B.loadSchedule(env);
  const g = B.gpList().find((x) => x.r === 19);
  const gSg = B.gpList().find((x) => x.r === 17);
  if (!g || !gSg) { bad('內建賽程找不到 R19／R17'); process.exit(1); }
  const id = B.gpId(g);
  const tw = (t) => new Date((t + 8 * 3600) * 1000).toISOString().slice(5, 16).replace('T', ' ');

  const before = B.gpShows(g).find((x) => x.kind === 'warmup');
  check(before && !before.src, `0  同步前 Warm-Up 是推算的（台灣 ${before && tw(before.at)}）`);

  const c = B.f1tvSchedClean(g, mx);
  check(!c.error && c.items.length === 10 && !c.bad.length, '2a 墨西哥那份收下（10 場、沒有被丟掉的）', c.error || JSON.stringify(c.bad));
  check(c.mismatch && c.mismatch.length === 0, '2b 正式場次與官方賽程一致', JSON.stringify(c.mismatch));

  const r1 = await B.f1tvSchedSave(env, id, c.items);
  check(r1.changed && kv.puts === 1, '3a 寫進 KV 一次');
  const shows = B.gpShows(g);
  const wu = shows.find((x) => x.kind === 'warmup');
  check(wu && wu.src === 'f1tv' && tw(wu.at) === '10-30 04:30', `3b Warm-Up 改成 F1TV 的時間（台灣 ${wu && tw(wu.at)}）`);
  check(shows.length === 5 && shows.every((x) => x.src === 'f1tv' && x.label && x.len >= 600), '3c 五個節目都換成 F1TV 的、都有名稱與長度');
  const p = B.gpProduct(g, NOW);
  check(p.f1tv && p.f1tv.warmup && p.f1tv.warmup.cid === '1000010422' && p.f1tv.race.href === '/detail/1000010420/2026-mexico-city-grand-prix?action=play',
    '3d /v1/schedule 的 f1tv 帶 contentId 與播放網址');
  check(B.gpShows(gSg).every((x) => !x.src), '3e 別站不受影響（新加坡仍是推算的）');

  const r2 = await B.f1tvSchedSave(env, id, B.f1tvSchedClean(g, mx).items);
  check(!r2.changed && kv.puts === 1, '4  同一份再送一次：不寫 KV');

  const noRace = B.f1tvSchedClean(g, mx.filter((x) => x.kind !== 'race'));
  check(!!noRace.error, '5a 沒有正賽：整份拒絕');
  const shifted = B.f1tvSchedClean(g, mx.map((x) => (x.kind === 'race' ? Object.assign({}, x, { at: x.at + 3 * 3600, end: x.end + 3 * 3600 }) : x)));
  check(!!shifted.error, '5b 正賽與官方差 3 小時：整份拒絕');
  const hrefBad = B.f1tvSchedClean(g, mx.map((x) => (x.kind === 'warmup' ? Object.assign({}, x, { href: '/detail/1000099999/weekend-warm-up-mexico?action=play' }) : x)));
  check(!hrefBad.error && hrefBad.bad.includes('warmup:href') && !hrefBad.items.some((x) => x.kind === 'warmup'), '5c 網址的 cid 對不上：那一場丟掉');
  const offsite = B.f1tvSchedClean(g, mx.map((x) => (x.kind === 'postr' ? Object.assign({}, x, { at: x.at + 10 * 86400, end: x.end + 10 * 86400 }) : x)));
  check(!offsite.error && offsite.bad.includes('postr:time'), '5d 時間在這一站週末範圍外：那一場丟掉');
  const wrongGp = B.f1tvSchedClean(g, sg);
  check(!!wrongGp.error, '5e 把新加坡那份送成墨西哥：整份拒絕', JSON.stringify(wrongGp));
  check(B.HARVEST_ROUTES.has('POST /v1/admin/harvest/f1tv-schedule'), '5f 端點在收割權杖的白名單裡（只有這一個新端點）');

  // ---- 收割端 alFindLink ----
  const gp = { f1tv: p.f1tv, slugs: ['mexico'] };
  const s = { kind: 'warmup', at: wu.at };
  // hbox 用的是這邊的 Date，直接換 Date.now 就能控制 alFindLink 看到的時間
  const realNow = Date.now;
  Date.now = () => (wu.at - 30 * 60) * 1000;
  hbox.scrapeList = [];
  check(H.alFindLink(s, [], gp) === null, '6a 表定前 30 分鐘：不直接開（直播多半還沒開），首頁上也還沒有 → 等');
  Date.now = () => (wu.at - 19 * 60) * 1000;
  const f = H.alFindLink(s, [], gp);
  check(f && f.direct && f.path === '/detail/1000010422/weekend-warm-up-mexico', '6b 表定前 19 分鐘：直接開 F1TV 的網址（不靠首頁）', JSON.stringify(f));
  check((H.alFindLink(s, ['1000010422'], gp) || {}).done === true, '6c 播完的那一支（main.js 記下的）不再開');
  check(H.alFindLink(s, [], { slugs: ['mexico'] }) === null, '6d 後端沒有 F1TV 網址時退回首頁找連結（照舊）');
  Date.now = realNow;

  check(H.AL_NOT_F1.test('2026-singapore-gp-f1-kids-sprint') && !H.AL_NOT_F1.test('2026-singapore-gp-sprint'), '7a F1 Kids 擋掉、F1 的衝刺賽不擋');
  check(H.AL_SLUG.pres.test('pre-sprint-show-singapore') && H.AL_SLUG.posts.test('post-sprint-show-singapore'), '7b 衝刺週末的節目網址對得上');
  check(/const stale = last\.result === '進行中' && Date\.now\(\) - \(last\.at \|\| 0\) > AL_SYNC_STALE_MS/.test(hsrc)
    && /!stale && Date\.now\(\) - \(last\.at \|\| 0\) < AL_SYNC_MS/.test(hsrc), '7c 同步卡在「進行中」超過 10 分鐘就重試，不等 12 小時（2026-10-27 實測卡住）');
  check(/PRO\/3`, \{ credentials: 'include', signal: AbortSignal\.timeout\(F1TV_FETCH_MS\) \}/.test(hsrc), '7d 讀 F1TV 內容 API 一定要有逾時');

  console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
