#!/usr/bin/env node
/**
 * 管理版收割佇列（extension/src/admin/harvest.js，handoff 9.1 #26 第 3 階段）的行為。
 *
 * 從 userscript 移植過來的那幾條規則，每一條都曾經在 userscript 上出過事——這裡逐條推著走：
 *   · 只接手「佇列自己開的那一頁」（以前任何分頁開任何影片都會被當成收割工作，看到一半被跳走）
 *   · 蓋章成功才算完成；不完整／失敗記成失敗（鐵則 37、38）
 *   · 後端早就完整、或跳過整軌預抓 → 立刻完成（以前白等 15 分鐘逾時記成失敗）
 *   · 沒有字幕清單要等夠久才算「這支沒字幕」（以前每支只收開頭幾秒）
 *   · 逾時看「多久沒進度」（另有硬上限）、跑完會前往下一支，網址帶 ?action=play
 *   · 沒有收割權杖就暫停，不會整晚 401
 *   · 現在有場次在播就不收割（後端 liveNow）
 *
 * 用法：node tools/check-admin-harvest.js（check-all 會跑）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'admin', 'harvest.js'), 'utf8');

let failed = 0;
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { failed++; console.log('❌ ' + m); };

const PATH_A = '/detail/1000010001/2026-singapore-grand-prix-race';
const PATH_B = '/detail/1000010002/2026-singapore-grand-prix-qualifying';

async function makeEnv(o) {
  let NOW = Date.parse('2026-10-12T12:00:00Z');
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  }
  const timers = new Map(); let tid = 0;
  const store = JSON.parse(JSON.stringify(o.storage || {}));
  const sent = [];
  const errors = [];
  const nav = [];
  let snap = Object.assign({
    cid: '1000010001', harvestOn: true, playlistSegs: 0, segFetched: 0, segFailed: 0, harvestInFlight: false,
    harvestSkipped: false, harvestDone: false, bundleComplete: false, pending: 0, inflight: 0, wanted: 0, missing: 0,
    dropped: 0, blocked: 0, errors: 0, stamp: { cid: '', state: '' },
  }, o.snap || {});
  const loc = { pathname: o.path || PATH_A };
  Object.defineProperty(loc, 'href', {
    get: () => 'https://f1tv.formula1.com' + loc.pathname,
    set: (v) => { nav.push(String(v)); },
  });
  const el = () => ({
    style: { setProperty(k, v) { this[k] = v; } }, children: [], isConnected: true, textContent: '', innerHTML: '',
    appendChild(c) { this.children.push(c); return c; }, append(...c) { c.forEach((x) => this.appendChild(x)); }, remove() { this.isConnected = false; },
  });
  const document = {
    body: Object.assign(el(), { innerHTML: o.html || '', scrollHeight: 1000 }), documentElement: el(),
    createElement: el, getElementById: () => null,
    querySelectorAll: (s) => (s.startsWith('a[') ? (o.links || []).map((h) => ({ getAttribute: () => h })) : []),
    addEventListener() {},
  };
  const chrome = {
    runtime: {
      lastError: null, getManifest: () => ({ version: '0.37.0' }),
      sendMessage(msg, cb) {
        sent.push(msg);
        const r = o.respond ? o.respond(msg) : { ok: true, result: { ok: true } };
        cb(r);
      },
    },
    storage: { local: {
      get: async (k) => (k in store ? { [k]: JSON.parse(JSON.stringify(store[k])) } : {}),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store[k] = JSON.parse(JSON.stringify(v)); },
    } },
  };
  const sandbox = {
    console: { log() {} }, document, chrome, location: loc,
    setTimeout: (fn, ms) => { timers.set(++tid, { fn, at: NOW + (Number(ms) || 0) }); return tid; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => 0, clearInterval() {},
    confirm: () => true, scrollTo() {},
    Date: FakeDate, Math, JSON, Map, Set, Promise, RegExp, Error, Object, Array, String, Number, Boolean, isFinite,
  };
  sandbox.window = sandbox;
  let fast = 0;
  sandbox.__plAdmin = { snapshot: () => JSON.parse(JSON.stringify(snap)), fastPace: () => { fast++; } };
  vm.createContext(sandbox);
  vm.runInContext("'use strict';\n" + SRC, sandbox, { filename: 'harvest.js' });
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  async function advance(ms) {
    const end = NOW + ms;
    while (NOW < end) {
      NOW = Math.min(end, NOW + 500);
      const due = [...timers.entries()].filter(([, t]) => t.at <= NOW).sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) { timers.delete(id); try { await t.fn(); } catch (e) { errors.push(e.message); } }
      await settle();
    }
  }
  return { store, sent, nav, errors, advance, get fast() { return fast; }, set snap(v) { snap = Object.assign(snap, v); } };
}

const running = (extra) => ({
  harvestToken: 'h',
  plHarvestQueue: Object.assign({ queue: [PATH_B], done: [], failed: [], running: true, startedAt: 1, current: { path: PATH_A, at: 1 } }, extra || {}),
});

(async () => {
  // 1. 佇列開的這一頁蓋章成功 → 記完成、前往下一支（帶 ?action=play）
  {
    const E = await makeEnv({ storage: running(), snap: { playlistSegs: 10, segFetched: 10, harvestDone: true } });
    await E.advance(20000);
    E.snap = { stamp: { cid: '1000010001', state: 'ok', note: '後端 900 句' } };
    await E.advance(10000);
    const q = E.store.plHarvestQueue;
    q.done.includes(PATH_A) && !q.failed.length && E.nav[0] === 'https://f1tv.formula1.com' + PATH_B + '?action=play'
      ? ok('蓋章成功才記完成，接著前往下一支（完整網址＋?action=play）')
      : bad(`蓋章成功後佇列不對（done ${JSON.stringify(q.done)}、failed ${JSON.stringify(q.failed)}、導覽 ${JSON.stringify(E.nav)}）`);
  }
  // 1b. 蓋章還在等（翻譯沒結束）→ 不可以提早換頁
  {
    const E = await makeEnv({ storage: running(), snap: { playlistSegs: 10, segFetched: 10, harvestDone: true, pending: 30,
      stamp: { cid: '1000010001', state: 'waiting' } } });
    await E.advance(5 * 60000);
    !E.nav.length && !E.store.plHarvestQueue.done.length
      ? ok('分段抓完但翻譯還在跑（標記等待中）：不換頁（userscript 荷蘭站的坑）')
      : bad('翻譯還沒結束就換頁了——還在翻的句子會跟著消失');
  }
  // 2. 不完整 → 記失敗、照樣往下
  {
    const E = await makeEnv({ storage: running(), snap: { stamp: { cid: '1000010001', state: 'incomplete', note: '30 句沒有譯文' }, playlistSegs: 10, segFetched: 10 } });
    await E.advance(15000);
    const q = E.store.plHarvestQueue;
    q.failed.includes(PATH_A) && !q.done.length && E.nav.length === 1 && /沒有譯文/.test(q.last && q.last.why)
      ? ok('不完整（有句子沒譯文）記成失敗並寫下原因，之後「重跑失敗」再補')
      : bad(`不完整卻沒有記成失敗（${JSON.stringify(q)}）`);
  }
  // 3. 後端早就完整 → 立刻完成
  {
    const E = await makeEnv({ storage: running(), snap: { bundleComplete: true } });
    await E.advance(15000);
    E.store.plHarvestQueue.done.includes(PATH_A)
      ? ok('後端早就有完整的一份：立刻記完成（不白等 15 分鐘）')
      : bad('後端早就完整卻沒有立刻記完成');
  }
  // 4. 沒有字幕清單：90 秒內不可以下結論；之後只有「master 裡確實沒有字幕軌」才記完成
  {
    const E = await makeEnv({ storage: running(), snap: { subTrack: 'none' } });
    await E.advance(60000);
    const early = E.store.plHarvestQueue.done.length + E.store.plHarvestQueue.failed.length;
    await E.advance(60000);
    early === 0 && E.store.plHarvestQueue.done.includes(PATH_A)
      ? ok('master 裡沒有字幕軌：等滿 90 秒才認定「這支沒有字幕」（不會每支只收開頭幾秒）')
      : bad(`沒有字幕清單的判斷不對（60 秒時已結束 ${early} 支、120 秒時 done ${JSON.stringify(E.store.plHarvestQueue.done)}）`);
  }
  // 4b. 沒看到 master（播放器沒載入）／有字幕軌卻拿不到清單：不可以記成「完成：沒有字幕」——那樣永遠不會補收（R19 排位重播）
  for (const subTrack of ['unknown', 'has']) {
    const E = await makeEnv({ storage: running(), snap: { subTrack } });
    await E.advance(120000);
    const early = E.store.plHarvestQueue.done.length + E.store.plHarvestQueue.failed.length;
    await E.advance(90000);
    const q = E.store.plHarvestQueue;
    early === 0 && !q.done.length && q.failed.includes(PATH_A) && /不是沒有字幕/.test(q.last && q.last.why)
      ? ok(`subTrack=${subTrack}：拿不到字幕清單記成失敗（可以重跑），不記成「這支沒有字幕」`)
      : bad(`subTrack=${subTrack} 的判斷不對（2 分鐘時已結束 ${early} 支、3.5 分鐘時 ${JSON.stringify({ done: q.done, failed: q.failed, last: q.last })}）`);
  }
  // 5. 不是佇列開的頁面：不接手
  {
    const E = await makeEnv({ storage: running(), path: PATH_B, snap: { bundleComplete: true } });
    await E.advance(60000);
    const q = E.store.plHarvestQueue;
    !E.nav.length && !q.done.length && q.current.path === PATH_A
      ? ok('自己開來看的影片（不是佇列開的）不接手、不換頁、不記成完成')
      : bad('別的頁面被當成收割工作——看到一半會被跳走');
  }
  // 6. 逾時看「多久沒進度」：卡住 5 分鐘 → 記失敗
  {
    const E = await makeEnv({ storage: running(), snap: { playlistSegs: 100, segFetched: 40, harvestInFlight: true } });
    await E.advance(4 * 60000);
    const early = E.store.plHarvestQueue.failed.length;
    await E.advance(3 * 60000);
    !early && E.store.plHarvestQueue.failed.includes(PATH_A) && /沒有進度/.test(E.store.plHarvestQueue.last.why)
      ? ok('5 分鐘沒有任何進度記成失敗並往下（不會卡死整個佇列）')
      : bad(`卡住的判斷不對（4 分鐘時失敗 ${early} 支、7 分鐘時 ${JSON.stringify(E.store.plHarvestQueue.last)}）`);
  }
  // 6b. 一直有進度就一直等——正賽 2,416 段 15 分鐘抓不完不是失敗（2026-10-12 實測）
  {
    const E = await makeEnv({ storage: running(), snap: { playlistSegs: 2416, segFetched: 0, harvestInFlight: true } });
    for (let i = 1; i <= 30; i++) { E.snap = { segFetched: i * 60 }; await E.advance(60000); }
    !E.store.plHarvestQueue.failed.length && !E.nav.length
      ? ok('一直有進度時 30 分鐘還在等（大場次不會被固定時限砍掉）')
      : bad(`有進度卻被判失敗：${JSON.stringify(E.store.plHarvestQueue.last)}`);
  }
  // 6c. 硬上限：數字一直跳但永遠到不了 → 120 分鐘記失敗
  {
    const E = await makeEnv({ storage: running(), snap: { playlistSegs: 100, segFetched: 1, harvestInFlight: true } });
    for (let i = 1; i <= 125; i++) { E.snap = { segFetched: 1 + (i % 2) }; await E.advance(60000); }
    E.store.plHarvestQueue.failed.includes(PATH_A) && /逾時/.test(E.store.plHarvestQueue.last.why)
      ? ok('進度一直跳但到不了時，120 分鐘硬上限記成失敗')
      : bad('硬上限沒有作用——佇列可以被一支影片卡一整晚');
  }
  // 6d. 佇列接手時要切到全速（觀眾版的退讓會讓大場次抓不完）
  {
    const E = await makeEnv({ storage: running(), snap: { bundleComplete: true } });
    await E.advance(5000);
    const own = await makeEnv({ storage: running(), path: PATH_B });
    await own.advance(5000);
    E.fast === 1 && own.fast === 0
      ? ok('佇列開的頁面切到收割全速；自己開來看的影片不切')
      : bad(`全速切換不對（佇列頁 ${E.fast} 次、自己開的頁 ${own.fast} 次）`);
  }
  // 7. 分段有失敗：翻譯停下後記失敗（不會蓋章，也不能永遠等）
  {
    const E = await makeEnv({ storage: running(), snap: { playlistSegs: 10, segFetched: 9, segFailed: 1 } });
    await E.advance(15000);
    E.store.plHarvestQueue.failed.includes(PATH_A)
      ? ok('分段有失敗時，翻譯停下就記成失敗（不等到逾時）')
      : bad('分段有失敗時佇列卡住');
  }
  // 8. 沒有收割權杖：暫停佇列，不換頁
  {
    const st = running(); delete st.harvestToken;
    const E = await makeEnv({ storage: st, snap: { bundleComplete: true } });
    await E.advance(20000);
    E.store.plHarvestQueue.running === false && !E.nav.length
      ? ok('沒有收割權杖時佇列暫停（不會整晚打出 401）')
      : bad('沒有收割權杖還在跑佇列');
  }
  // 9. 佇列跑完：停止，不導覽
  {
    const E = await makeEnv({ storage: running({ queue: [] }), snap: { bundleComplete: true } });
    await E.advance(20000);
    const q = E.store.plHarvestQueue;
    q.running === false && q.current === null && !E.nav.length
      ? ok('佇列跑完就停（不亂導覽）')
      : bad(`佇列跑完的狀態不對（${JSON.stringify(q)}、導覽 ${JSON.stringify(E.nav)}）`);
  }
  // 10. 列表頁的提示：有場次在播時一律不開口；有自動開始時直接排佇列
  {
    const plan = { ok: true, result: { ok: true, liveNow: { round: 18, name: 'US', label: 'FP1' }, todo: [{ status: 'replay', missing: ['正賽'] }] } };
    const E = await makeEnv({ path: '/page/123/formula-1-singapore-2026', storage: { harvestToken: 'h', plHarvestAuto: true },
      links: [PATH_A], respond: (m) => (m.type === 'harvestPlan' ? plan : { ok: true, result: { ok: true } }) });
    await E.advance(10000);
    !E.store.plHarvestQueue && !E.nav.length
      ? ok('有場次在播時，列表頁不開始收割（跟影片搶 CDN）')
      : bad('有場次在播還開始收割');
  }
  {
    const plan = { ok: true, result: { ok: true, todo: [{ status: 'replay', round: 17, name: 'Singapore', missing: ['正賽'] }],
      queue: [PATH_A], plan: [{ round: 17, name: 'Singapore', label: '正賽' }], received: 1 } };
    const E = await makeEnv({ path: '/page/123/formula-1-singapore-2026', storage: { harvestToken: 'h', plHarvestAuto: true },
      links: [PATH_A], respond: (m) => (m.type === 'harvestPlan' ? plan : { ok: true, result: { ok: true } }) });
    await E.advance(15000);
    const q = E.store.plHarvestQueue || {};
    const asked = E.sent.find((m) => m.type === 'harvestPlan' && Array.isArray(m.paths));
    q.running && q.current && q.current.path === PATH_A && E.nav[0] === 'https://f1tv.formula1.com' + PATH_A + '?action=play'
      && asked && asked.paths.includes(PATH_A)
      ? ok('自動開始：刮本頁連結交給後端計畫，照後端的佇列開跑')
      : bad(`自動開始沒有照後端計畫開跑（佇列 ${JSON.stringify(q)}、導覽 ${JSON.stringify(E.nav)}）`);
    E.errors.length ? bad('收割佇列有例外：' + E.errors.join('；')) : ok('收割佇列沒有例外');
  }

  console.log('');
  if (failed) { console.log(`❌ 管理版收割佇列有 ${failed} 項未通過`); process.exit(1); }
  console.log('✅ 管理版收割佇列全部正確');
})().catch((e) => { console.log('❌ 測試環境崩潰：' + (e && e.stack || e)); process.exit(1); });
