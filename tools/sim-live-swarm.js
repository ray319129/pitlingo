#!/usr/bin/env node
/**
 * 直播人潮模擬器（2026-10-16，handoff 9.1「多人同時看直播的隱藏問題」① ② ③）
 *
 * **為什麼需要**：多人同時看直播的問題只在「很多人、同一時間、同一批句子」時出現，
 * 而開發者只有一台電腦。check-live-concurrency 只驗「10 個請求同時到」這一個瞬間；
 * 這支把整條路徑跑一遍——N 個虛擬觀眾照擴充功能的節奏看一整段直播，
 * 打的是**真的後端程式碼**（backend/src/parts/*.js 接起來，移除 @test-only 後＝正式版），
 * 下面全部是假的：KV、Durable Object、Anthropic、時鐘。
 *
 * ⚠️ **不打正式後端、不碰 F1TV、不花錢**（坑 #60：壓測不可以打正式後端）。
 *
 * 量的東西（每一項都對到一個 Cloudflare 免費方案的上限或一個使用者看得到的結果）：
 *   - Worker 請求數（100,000／天）
 *   - Durable Object 請求數（100,000／天）與作用時間（13,000 GB-s／天）
 *   - KV 讀／寫／列舉／刪除（100,000／1,000／1,000／1,000 每天），**依前綴分開數**
 *   - 模型呼叫次數、翻譯句數、估計成本（實測公式 $0.000766／次 ＋ $0.000121／句）
 *   - 每位觀眾的每一句字幕：**在畫面出現之前**有沒有拿到譯文
 *
 * 時間是虛擬的：2 小時的正賽幾十秒跑完，而且每次結果一樣（固定亂數種子）。
 *
 * 模型的假設（改這裡之前先讀 CLAUDE.md「關鍵技術事實」）：
 *   - 1 小時約 1,101 句、622 個 VTT 分段 → 每段約 5.8 秒、平均 1.77 句
 *   - VTT 抵達時間 ＝ 分段時間 ＋ 播放器輪詢相位（0~分段長）＋ 0.3 × 落後秒數
 *     畫面出現時間 ＝ 抵達 ＋ 提前量，提前量 ＝ 21 ＋ 0.7 × 落後秒數
 *     （擬合 2026-09-24~25 五個實測樣本：落後 4 秒→約 24 秒、33→47.6、80→約 75）
 *   - 擴充功能的節奏照抄 content/main.js：直播一律急件；300ms ＋ 0~1200ms 抖動；
 *     每批最多 20 句；同時最多 3 批；落後 ≥ 35 秒（延遲畫面生效）時等 10 秒湊批；
 *     前導端等 20 秒（leaderWinMs）；HTTP 錯誤的那一批**直接丟掉**（sw.js translateLines
 *     把錯誤包成 result.error，content 不會 requeue）；畫面出現時還沒有譯文就以急件單獨補送
 *   - 請求隨機分配到 K 個 isolate（實測約 2），每個 isolate 有自己的記憶體（緩衝、快取）
 *
 * 用法：
 *   node tools/sim-live-swarm.js                         預設：30 位觀眾、30 分鐘、基準情境
 *   node tools/sim-live-swarm.js --viewers 100 --minutes 60
 *   node tools/sim-live-swarm.js --scenario anth429      故障注入，見 SCENARIOS
 *   node tools/sim-live-swarm.js --ceiling               ① 天花板表：10／30／100 人各跑一次再外推
 *   node tools/sim-live-swarm.js --all                   所有故障情境各跑一次（③）
 *   --leader-win 20                                     前導端湊批秒數（main.js leaderWinMs，遠端設定可改 5~50）
 *   --delay-share 0.8                                   開著延遲畫面（落後 40~55 秒）的觀眾比例
 *   加 --json 輸出機器可讀的結果
 *   node tools/sim-live-swarm.js --check                 回歸檢查（check-all 會跑，約 5 秒）
 *   --no-rl-binding                                     不用 Rate Limiting binding（KV 取樣計數，舊行為）
 *   --no-hibernate                                      假 DO 不休眠（舊行為；只用來對照，線上的 DO 一定會休眠）
 *   --backend <檔案>                                    改用另一份後端（突變測試用）
 *
 * ⚠️ 已知的限制：假的 SubtitleRoom 讓請求在 await 之間完全並行。真的 DO 在 100 個請求同時
 *    「掛著等」（op: 'wait'）時實測會變慢、還會出錯（handleTranslate 急件段的註解，對正式環境量的）。
 *    所以這支量到「掛在 DO 上等很好」**不可以當成證據**——那個做法已經實測否決。
 *    又短又快的操作（peek／claim／done）不受影響。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');
const root = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// 參數
// ─────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
};

// Cloudflare 免費方案（2026-10 查官方文件）。數字改了這裡要一起改。
const LIMITS = {
  worker: 100000,          // Workers 請求／天（UTC 午夜重置），超過回 Error 1027
  doReq: 100000,           // Durable Objects 請求／天
  doGBs: 13000,            // Durable Objects 作用時間 GB-s／天（128MB × 秒）
  kvRead: 100000,
  kvWrite: 1000,
  kvList: 1000,
  kvDelete: 1000,
};
const COST_PER_CALL = 0.000766;
const COST_PER_LINE = 0.000121;

/**
 * 故障情境（③）。每一個都對應一個「線上真的可能發生」的狀況。
 * from／to 是模擬開始後的分鐘數。
 */
const SCENARIOS = {
  base: { desc: '基準：沒有故障' },
  nat: { desc: '共用 IP：一半的觀眾在同一個 NAT 後面（宿舍、公司、行動網路 CGNAT）', sharedIpFrac: 0.5 },
  kvlag: { desc: 'KV 傳播延遲 60 秒（官方說最多約 60 秒）', kvLagMs: 60000 },
  anth429: { desc: 'Anthropic 第 5~10 分鐘有一半的呼叫回 429', model429: { from: 5, to: 10, p: 0.5 } },
  anthSlow: { desc: 'Anthropic 第 5~10 分鐘變慢 4 倍（4~8 秒）', modelSlow: { from: 5, to: 10, x: 4 } },
  authDown: { desc: 'AuthGuard 第 5~10 分鐘完全連不上', authFault: { from: 5, to: 10, p: 1 } },
  authFlaky: { desc: 'AuthGuard 第 5~10 分鐘有 30% 的請求回 overloaded', authFault: { from: 5, to: 10, p: 0.3 } },
  roomDown: { desc: 'SubtitleRoom（每場一個 DO）第 5~10 分鐘連不上', roomFault: { from: 5, to: 10, p: 1 } },
  kvFull: { desc: 'KV 寫入額度從一開始就用完（每次 put 都丟例外）', kvPutFailAfter: 0 },
  leaderGone: { desc: '有前導端，第 5 分鐘離線', leader: true, leaderLeaveMin: 5 },
  leader: { desc: '有前導端，全程在線', leader: true },
};

// ─────────────────────────────────────────────────────────────────────────────
// 可重現的亂數
// ─────────────────────────────────────────────────────────────────────────────
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 一次模擬
// ─────────────────────────────────────────────────────────────────────────────
async function simulate(opts) {
  const sc = SCENARIOS[opts.scenario] || SCENARIOS.base;
  const N = opts.viewers;
  const MIN = opts.minutes;
  const K = opts.isolates;
  const rnd = prng(opts.seed);          // 觀眾與時間線
  const rndBackend = prng(opts.seed + 1);  // 後端的 Math.random（速率限制取樣）
  const rndNet = prng(opts.seed + 2);   // 網路與模型延遲

  // ── 虛擬時鐘 ──────────────────────────────────────────────────────────────
  const T0 = Date.UTC(2026, 9, 25, 6, 0, 0);   // 10/25 14:00 台灣時間（正賽時段）
  let NOW = T0;
  let activity = 0;
  let timerSeq = 0;
  const heap = [];                       // [at, seq, fn]
  const cancelled = new Set();
  const hpush = (e) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] < e[0] || (heap[p][0] === e[0] && heap[p][1] < e[1])) break;
      heap[i] = heap[p]; i = p;
    }
    heap[i] = e;
  };
  const hpop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        const lt = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
        if (l < heap.length && lt(heap[l], m === i ? last : heap[m])) m = l;
        if (r < heap.length && lt(heap[r], m === i ? last : heap[m])) m = r;
        if (m === i) break;
        heap[i] = heap[m]; i = m;
      }
      heap[i] = last;
    }
    return top;
  };
  const vSetTimeout = (fn, ms, ...a) => {
    activity++;
    const id = ++timerSeq;
    hpush([NOW + Math.max(0, Number(ms) || 0), id, () => fn(...a)]);
    return id;
  };
  const vClearTimeout = (id) => { if (id) cancelled.add(id); };
  const vsleep = (ms) => new Promise((r) => vSetTimeout(r, ms));
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
    static now() { return NOW; }
  }
  const minute = () => (NOW - T0) / 60000;
  const inWin = (w) => !!w && minute() >= w.from && minute() < w.to;

  // ── 計數器 ────────────────────────────────────────────────────────────────
  const C = {
    worker: 0, workerBy: {}, workerStatus: {}, workerErr: 0, workerErrMsg: {},
    doReq: { ROOM: 0, AUTH: 0 }, doFail: { ROOM: 0, AUTH: 0 }, doHibernate: { ROOM: 0, AUTH: 0 }, doOps: { ROOM: {}, AUTH: {} },
    authQueueMax: 0, authWaitMax: 0,
    kv: { get: 0, put: 0, delete: 0, list: 0 }, kvPutBy: {}, kvGetBy: {}, kvListBy: {}, kvPutFail: 0,
    model: 0, model429: 0, modelLines: 0, modelDistinct: new Set(),
    doActiveMs: { ROOM: 0, AUTH: 0 },
  };
  const bump = (o, k, n) => { o[k] = (o[k] || 0) + (n || 1); };
  const prefixOf = (k) => { const s = String(k); const i = s.indexOf(':'); return i < 0 ? s : s.slice(0, i); };

  // ── 假的 crypto.subtle（同步完成，才能用虛擬時鐘）────────────────────────
  // ⚠️ 真的 webcrypto 是在執行緒池算完再回來，會跨過 setImmediate——
  //    虛擬時鐘就無法判斷「這一刻的事情做完了沒」。HMAC／SHA 改用 node 的同步版，
  //    算出來的位元組與 webcrypto 完全相同（簽出來的權杖照樣通過後端驗證）。
  const real = nodeCrypto.webcrypto.subtle;
  const hashName = (h) => String((h && h.name) || h || 'SHA-256').toLowerCase().replace('-', '');
  const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  const subtle = {
    importKey(fmt, data, alg, ext, uses) {
      if (fmt === 'raw' && alg && (alg.name === 'HMAC')) {
        return Promise.resolve({ __hmac: Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data), hash: hashName(alg.hash) });
      }
      return real.importKey(fmt, data, alg, ext, uses);
    },
    sign(alg, key, data) {
      if (key && key.__hmac) return Promise.resolve(toAB(nodeCrypto.createHmac(key.hash, key.__hmac).update(Buffer.from(data)).digest()));
      return real.sign(alg, key, data);
    },
    verify(alg, key, sig, data) {
      if (key && key.__hmac) {
        const d = nodeCrypto.createHmac(key.hash, key.__hmac).update(Buffer.from(data)).digest();
        const s = Buffer.from(sig instanceof ArrayBuffer ? new Uint8Array(sig) : sig);
        return Promise.resolve(s.length === d.length && nodeCrypto.timingSafeEqual(s, d));
      }
      return real.verify(alg, key, sig, data);
    },
    digest(alg, data) {
      return Promise.resolve(toAB(nodeCrypto.createHash(hashName(alg)).update(Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)).digest()));
    },
    encrypt: (...a) => real.encrypt(...a),
    decrypt: (...a) => real.decrypt(...a),
  };
  const simCrypto = {
    subtle,
    getRandomValues: (a) => nodeCrypto.webcrypto.getRandomValues(a),
    randomUUID: () => nodeCrypto.randomUUID(),
  };

  // ── Request／Response（簡化版，同步完成）─────────────────────────────────
  class SimResponse {
    constructor(body, init) {
      const i = init || {};
      this._b = body == null ? null : body;
      this.body = this._b;
      this.status = i.status === undefined ? 200 : i.status;
      this.statusText = i.statusText || '';
      this.headers = new Headers(i.headers || {});
      this.ok = this.status >= 200 && this.status < 300;
    }
    async text() {
      const b = this._b;
      if (b == null) return '';
      if (typeof b === 'string') return b;
      if (b instanceof Uint8Array || b instanceof ArrayBuffer) return Buffer.from(b).toString('utf8');
      return String(b);
    }
    async json() { return JSON.parse(await this.text()); }
    async arrayBuffer() { return toAB(Buffer.from(await this.text())); }
    clone() { return new SimResponse(this._b, { status: this.status, headers: this.headers }); }
    static json(o, init) {
      const i = Object.assign({}, init || {});
      i.headers = Object.assign({ 'content-type': 'application/json' }, i.headers || {});
      return new SimResponse(JSON.stringify(o), i);
    }
    static redirect(u, s) { return new SimResponse(null, { status: s || 302, headers: { location: String(u) } }); }
  }
  class SimRequest {
    constructor(input, init) {
      const i = init || {};
      if (input instanceof SimRequest) {
        this.url = input.url; this.method = input.method; this.headers = new Headers(input.headers); this._b = input._b;
      } else {
        this.url = String(input); this.method = 'GET'; this.headers = new Headers(); this._b = null;
      }
      if (i.method) this.method = String(i.method).toUpperCase();
      if (i.headers) this.headers = new Headers(i.headers);
      if (i.body !== undefined) this._b = i.body;
      this.cf = { country: 'TW', colo: 'TPE' };
    }
    async text() { return this._b == null ? '' : String(this._b); }
    async json() { return JSON.parse(await this.text()); }
    async arrayBuffer() { return toAB(Buffer.from(await this.text())); }
    async formData() { throw new Error('formData 不在模擬範圍'); }
    clone() { return new SimRequest(this); }
  }

  // ── 假的 KV（多個 isolate、可設傳播延遲、可設寫入額度用完）──────────────
  const kvLag = sc.kvLagMs || opts.kvLagMs || 0;
  const kvStore = new Map();             // key -> [{ v, meta, exp, at, iso }]（新的在後）
  const putFailAfter = sc.kvPutFailAfter === undefined ? Infinity : sc.kvPutFailAfter;
  function kvVisible(key, iso) {
    const vs = kvStore.get(key);
    if (!vs) return null;
    for (let i = vs.length - 1; i >= 0; i--) {
      const v = vs[i];
      if (v.iso === iso || NOW >= v.at + kvLag) {
        if (v.v === null) return null;
        if (v.exp && NOW / 1000 >= v.exp) return null;
        return v;
      }
    }
    return null;
  }
  function kvView(iso) {
    return {
      async get(key, type) {
        activity++; C.kv.get++; bump(C.kvGetBy, prefixOf(key));
        const v = kvVisible(key, iso);
        if (!v) return null;
        const t = typeof type === 'string' ? type : (type && type.type);
        if (t === 'json') return JSON.parse(v.v);
        return v.v;
      },
      async getWithMetadata(key, type) {
        activity++; C.kv.get++; bump(C.kvGetBy, prefixOf(key));
        const v = kvVisible(key, iso);
        if (!v) return { value: null, metadata: null };
        const t = typeof type === 'string' ? type : (type && type.type);
        return { value: t === 'json' ? JSON.parse(v.v) : v.v, metadata: v.meta || null };
      },
      async put(key, value, o) {
        activity++;
        if (C.kv.put >= putFailAfter) { C.kvPutFail++; throw new Error('KV put() limit exceeded for the day.'); }
        C.kv.put++; bump(C.kvPutBy, prefixOf(key));
        const oo = o || {};
        const exp = oo.expiration ? Number(oo.expiration) : (oo.expirationTtl ? NOW / 1000 + Number(oo.expirationTtl) : 0);
        const vs = kvStore.get(key) || [];
        vs.push({ v: typeof value === 'string' ? value : String(value), meta: oo.metadata || null, exp, at: NOW, iso });
        if (vs.length > 4) vs.shift();
        kvStore.set(key, vs);
      },
      async delete(key) {
        activity++; C.kv.delete++;
        const vs = kvStore.get(key) || [];
        vs.push({ v: null, meta: null, exp: 0, at: NOW, iso });
        if (vs.length > 4) vs.shift();
        kvStore.set(key, vs);
      },
      async list(o) {
        activity++; C.kv.list++;
        const pre = (o && o.prefix) || '';
        bump(C.kvListBy, prefixOf(pre) || '(全部)');
        const keys = [];
        for (const k of kvStore.keys()) {
          if (!k.startsWith(pre)) continue;
          const v = kvVisible(k, iso);
          if (v) keys.push({ name: k, metadata: v.meta || undefined, expiration: v.exp || undefined });
        }
        keys.sort((a, b) => (a.name < b.name ? -1 : 1));
        const lim = Math.min(1000, (o && o.limit) || 1000);
        return { keys: keys.slice(0, lim), list_complete: keys.length <= lim, cursor: keys.length > lim ? 'x' : undefined };
      },
    };
  }

  // ── Cache API（同一個機房共用；只有 DO 不可用時的認領退路會用到）─────────
  const cacheMap = new Map();
  const caches = {
    default: {
      async match(u) {
        activity++;
        const e = cacheMap.get(String(u && u.url ? u.url : u));
        if (!e || NOW > e) return undefined;
        return new SimResponse('1');
      },
      async put(u, r) {
        activity++;
        const cc = (r && r.headers && r.headers.get('cache-control')) || '';
        const m = cc.match(/max-age=(\d+)/);
        cacheMap.set(String(u && u.url ? u.url : u), NOW + (m ? Number(m[1]) * 1000 : 60000));
      },
      async delete(u) { cacheMap.delete(String(u && u.url ? u.url : u)); return true; },
    },
  };

  // ── 假的 Anthropic ──────────────────────────────────────────────────────
  async function simFetch(url, init) {
    activity++;
    const u = String(url && url.url ? url.url : url);
    if (u.includes('api.anthropic.com')) {
      C.model++;
      const body = JSON.parse((init && init.body) || '{}');
      const content = String((body.messages && body.messages[0] && body.messages[0].content) || '');
      const m = content.match(/^【批次翻譯】共 (\d+) 句\n([\s\S]*)$/);
      const ens = m ? m[2].split('\n').map((l) => l.replace(/^\d+\.\s/, '')) : [content];
      C.modelLines += ens.length;
      for (const en of ens) C.modelDistinct.add(en);
      if (inWin(sc.model429) && rndNet() < sc.model429.p) {
        C.model429++;
        await vsleep(150);
        return new SimResponse(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'simulated' } }), { status: 429 });
      }
      // 實測模型回應 1~2 秒；句數多一點就慢一點
      let ms = 800 + ens.length * 40 + rndNet() * 700;
      if (inWin(sc.modelSlow)) ms *= sc.modelSlow.x;
      await vsleep(ms);
      const zh = (en) => '譯' + '文'.repeat(Math.max(1, Math.min(20, Math.floor(en.length / 3))));
      const text = m ? ens.map((en, i) => `${i + 1}. ${zh(en)}`).join('\n') : zh(ens[0]);
      return SimResponse.json({
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 40 + 15 * ens.length, output_tokens: 20 * ens.length, cache_read_input_tokens: 4800, cache_creation_input_tokens: 0 },
      });
    }
    // 其他外部呼叫（寄信、webhook…）：記一筆就好
    bump(C, 'otherFetch');
    return SimResponse.json({ ok: true, id: 'sim' });
  }

  // ── 載入後端（每個 isolate 一份，模組層的狀態彼此獨立）──────────────────
  let src = (opts.backend ? fs.readFileSync(path.resolve(opts.backend), 'utf8') : require('./lib/backend-src').readBackend());
  // 正式版＝移除 @test-only（與 tools/build-backend.js 同一個規則）
  src = src.replace(/\/\* @test-only:start \*\/[\s\S]*?\/\* @test-only:end \*\//g, '');
  // ⚠️ 一定要 'use strict'（坑 #37）：Worker 是 ESM＝嚴格模式
  src = "'use strict';\n" + src
    .replace(/^export default \{/m, 'const __worker = {')
    .replace(/\bexport\s+class\s+/g, 'class ');
  src += '\n;globalThis.__api = { worker: __worker, SubtitleRoom, AuthGuard, issueInstallToken, issueSession, issueEntitlement, normKey, acctgKey, validateSchedule, REMOTE_CONFIG, SCHED_KEY };';
  const script = new vm.Script(src, { filename: 'backend/src/parts/*.js' });
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const simMath = Object.create(Math);
  simMath.random = rndBackend;
  function loadBackend() {
    const sb = {
      console: opts.verbose ? console : quiet,
      crypto: simCrypto, TextEncoder, TextDecoder, btoa, atob, URL, URLSearchParams, Headers,
      Request: SimRequest, Response: SimResponse, fetch: simFetch, caches,
      setTimeout: vSetTimeout, clearTimeout: vClearTimeout,
      setInterval: () => 0, clearInterval: () => {},
      Date: FakeDate, Math: simMath, structuredClone, queueMicrotask,
      AbortController, AbortSignal, Blob, FormData, ReadableStream, WritableStream, TransformStream,
    };
    sb.globalThis = sb;
    vm.createContext(sb);
    script.runInContext(sb);
    return sb.__api;
  }

  // ── 假的 Durable Object namespace ───────────────────────────────────────
  // onAlarm：鬧鐘到點時叫醒那個 DO（A15 起 SubtitleRoom 靠鬧鐘把共用快取寫進 KV；以前這裡只記不響）
  function makeStorage(onAlarm) {
    const m = new Map();
    let alarm = null;
    const clone = (v) => (v === undefined ? undefined : structuredClone(v));
    return {
      async get(k) {
        activity++;
        if (Array.isArray(k)) { const o = new Map(); for (const x of k) if (m.has(x)) o.set(x, clone(m.get(x))); return o; }
        return clone(m.get(k));
      },
      async put(k, v) {
        activity++;
        if (typeof k === 'object' && k) { for (const [a, b] of Object.entries(k)) m.set(a, clone(b)); return; }
        m.set(k, clone(v));
      },
      async delete(k) { activity++; if (Array.isArray(k)) { let n = 0; for (const x of k) n += m.delete(x) ? 1 : 0; return n; } return m.delete(k); },
      async deleteAll() { m.clear(); },
      async list(o) {
        activity++;
        const pre = (o && o.prefix) || '';
        const out = new Map();
        for (const k of [...m.keys()].sort()) {
          if (!k.startsWith(pre)) continue;
          if (o && o.start && k < o.start) continue;
          if (o && o.startAfter && k <= o.startAfter) continue;
          if (o && o.end && k >= o.end) continue;
          out.set(k, clone(m.get(k)));
          if (o && o.limit && out.size >= o.limit) break;
        }
        return out;
      },
      async getAlarm() { return alarm; },
      async setAlarm(t) {
        alarm = Number(t);
        const mine = alarm;
        vSetTimeout(() => { if (alarm === mine) { alarm = null; if (onAlarm) onAlarm(); } }, Math.max(0, mine - NOW));
      },
      async deleteAlarm() { alarm = null; },
    };
  }
  function makeNS(name, Cls, env, o) {
    const inst = new Map();
    return {
      idFromName: (n) => ({ name: String(n), toString() { return String(n); } }),
      idFromString: (s) => ({ name: String(s), toString() { return String(s); } }),
      newUniqueId: () => ({ name: nodeCrypto.randomUUID(), toString() { return this.name; } }),
      get(id) {
        const key = String(id.name);
        const make = (storage) => new Cls({ storage, id, blockConcurrencyWhile: async (f) => f(), waitUntil() {} }, env);
        if (!inst.has(key)) {
          const storage = makeStorage(() => {
            const r = inst.get(key);
            if (!r || typeof r.obj.alarm !== 'function') return;
            C.doReq[name]++;
            bump(C.doOps[name], 'alarm');
            // 鬧鐘也照休眠規則：睡著了就是新的實例、同一份 storage
            if (!o.noHibernate && r.seen && !r.inflight && NOW >= r.until) { r.obj = r.make(r.storage); C.doHibernate[name] = (C.doHibernate[name] || 0) + 1; }
            if (NOW >= r.until) { C.doActiveMs[name] += 10000; } else { C.doActiveMs[name] += NOW + 10000 - r.until; }
            r.until = NOW + 10000;
            r.inflight++;
            Promise.resolve().then(() => r.obj.alarm()).catch((e) => bump(C.workerErrMsg, 'alarm: ' + String(e.message).slice(0, 60))).finally(() => { r.inflight--; });
          });
          inst.set(key, { obj: make(storage), storage, make, queue: Promise.resolve(), depth: 0, until: 0, inflight: 0, seen: false });
        }
        const r = inst.get(key);
        return {
          async fetch(url, init) {
            activity++;
            C.doReq[name]++;
            let op = '';
            try { op = String(JSON.parse((init && init.body) || '{}').op || ''); } catch (e) { /* noop */ }
            bump(C.doOps[name], op || '(無)');
            // 機房 → DO 的來回（台灣 → apac）
            const rtt = 30 + rndNet() * 30;
            await vsleep(rtt / 2);
            if (inWin(o.fault) && rndNet() < o.fault.p) {
              C.doFail[name]++;
              throw new Error('Durable Object is overloaded. Requests queued for too long.');
            }
            // 作用時間的上限：官方文件說閒置 10 秒、可休眠就不計費（兩個 DO 都沒有 WebSocket／計時器），
            // 所以每次請求最多讓它多「醒著」10 秒。重疊的部分只算一次。
            // **休眠**（2026-10-25）：沒有 WebSocket 的 DO 閒置 10 秒就休眠，記憶體整個丟掉、storage 留著
            // （官方文件 Durable Object lifecycle）。以前這裡的假 DO 永遠不休眠——SubtitleRoom 把前導端的
            // 結果只放記憶體，線上觀眾拿不到（R18 實測 B 自己翻 62%），這裡卻一直是綠的。
            if (!o.noHibernate && r.seen && !r.inflight && NOW >= r.until) { r.obj = r.make(r.storage); C.doHibernate[name] = (C.doHibernate[name] || 0) + 1; }
            r.seen = true;
            if (NOW >= r.until) { C.doActiveMs[name] += 10000; } else { C.doActiveMs[name] += NOW + 10000 - r.until; }
            r.until = NOW + 10000;
            const req = new SimRequest(url, init);
            const t0 = NOW;
            const run = async () => {
              r.inflight++;
              try { return await r.obj.fetch(req); } finally { r.inflight--; r.until = Math.max(r.until, NOW + 10000); }
            };
            let res;
            if (o.serialize) {
              // AuthGuard 的每個操作都在 storage 的 await 之間，輸入閘會讓它們一個接一個——
              // 等同完全序列化。排隊深度與等待時間就是「單一全域 DO」的壓力指標。
              r.depth++;
              C.authQueueMax = Math.max(C.authQueueMax, r.depth);
              const p = r.queue.then(run);
              r.queue = p.catch(() => {});
              try { res = await p; } finally { r.depth--; }
              C.authWaitMax = Math.max(C.authWaitMax, NOW - t0);
            } else {
              res = await run();    // SubtitleRoom 只有記憶體操作；wait 的 await 本來就會交錯
            }
            await vsleep(rtt / 2);
            return res;
          },
        };
      },
      instances: inst,
    };
  }

  const vars = {
    TOKEN_SECRET: 'sim-token-secret-not-real',
    ANTHROPIC_API_KEY: 'sk-sim',
    DAILY_USD_CAP: '999',
    // 寄信「成功」（simFetch 回 200）：線上寄得出去，告警類的 once 才會留住、不會每個請求重試
    RESEND_API_KEY: 'sim-resend', MAIL_FROM: 'PitLingo <sim@pitlingo.com>', REPORT_TO: 'ops@example.test',
  };
  const doApi = loadBackend();
  const doEnv = Object.assign({}, vars, { SUBS: kvView('do') });
  const ROOM = makeNS('ROOM', doApi.SubtitleRoom, doEnv, { fault: sc.roomFault, noHibernate: !!opts.noHibernate });
  const AUTH = makeNS('AUTH', doApi.AuthGuard, doEnv, { fault: sc.authFault, serialize: true, noHibernate: !!opts.noHibernate });
  doEnv.ROOM = ROOM; doEnv.AUTH = AUTH;
  // Cloudflare 的 Rate Limiting binding（wrangler.toml [[ratelimits]]，2026-10-26）：每個機房一份計數、不吃 KV。
  // 模擬成單一機房、每分鐘一個窗。--no-rl-binding 退回 KV 取樣（舊行為，或方案不支援 binding 時）
  const rlCount = new Map();
  const RL = opts.noRlBinding ? null : { async limit({ key }) { const k = key + ':' + Math.floor(NOW / 60000); const n = (rlCount.get(k) || 0) + 1; rlCount.set(k, n); return { success: n <= 120 }; } };
  const isolates = [];
  for (let i = 0; i < K; i++) {
    const api = loadBackend();
    isolates.push({ api, env: Object.assign({}, vars, { SUBS: kvView('iso' + i), ROOM, AUTH }, RL ? { RL } : {}) });
  }
  const normKey = isolates[0].api.normKey;

  // ── 線上本來就有的 KV 資料（直接放進去，不算進計數）──────────────────────
  // ⚠️ 少了這些，量到的是「空資料庫」的行為：賽程不在 KV 時 loadSchedule 每個請求都重讀
  //    （快取只在讀到合法賽程時才成立），帳號不存在時 /v1/account/me 回 404 而少走一大段。
  const seed = (k, v) => kvStore.set(k, [{ v: JSON.stringify(v), meta: null, exp: 0, at: 0, iso: 'seed' }]);
  {
    const A = isolates[0].api;
    const races = A.REMOTE_CONFIG.schedule;
    if (!A.validateSchedule(races).ok) throw new Error('內建賽程沒通過 validateSchedule，sched:current 種不進去');
    seed(A.SCHED_KEY, { races, at: Math.floor(T0 / 1000) - 3600 });
  }

  async function callWorker(method, p, headers, body) {
    C.worker++;
    const route = p.split('?')[0];
    bump(C.workerBy, method + ' ' + route);
    const iso = isolates[Math.floor(rndNet() * K)];
    const req = new SimRequest('https://api.pitlingo.com' + p, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    await vsleep(20 + rndNet() * 20);           // 觀眾 → 台北機房
    let res;
    try {
      res = await iso.api.worker.fetch(req, iso.env, { waitUntil() {}, passThroughOnException() {} });
    } catch (e) {
      C.workerErr++;
      bump(C.workerErrMsg, String((e && e.message) || e).slice(0, 80));
      await vsleep(20);
      return { status: 500, data: null };
    }
    bump(C.workerStatus, route + ' ' + res.status);
    let data = null;
    try { data = await res.json(); } catch (e) { /* noop */ }
    await vsleep(20 + rndNet() * 20);
    return { status: res.status, data };
  }

  // ── 直播時間線 ──────────────────────────────────────────────────────────
  const CID = '1000009999';
  const SLUG = `/detail/${CID}/2026-united-states-grand-prix`;
  const SEG_MS = 3600000 / 622;
  const VOCAB = ('verstappen norris leclerc piastri hamilton russell sainz alonso box lap pit tyre medium hard soft '
    + 'undercut overcut gap closing defending drs turn sector purple fastest safety car virtual flag yellow '
    + 'penalty seconds stewards investigating track limits strategy degradation pace push gearbox engine '
    + 'radio team window stint lead podium points championship battle overtake brakes lockup wide corner '
    + 'chicane straight hairpin crowd weather rain intermediate wet dry grip temperature').split(' ');
  const segs = [];
  let lineNo = 0;
  const totalMs = MIN * 60000;
  // 時間線往前多生 2 分鐘：落後 80 秒的人一開場就在看「開場前」的分段
  for (let t = -120000; t < totalMs; t += SEG_MS) {
    const pick = [0, 1, 1, 2, 2, 2, 3, 3][Math.floor(rnd() * 8)];
    const lines = [];
    for (let j = 0; j < pick; j++) {
      const n = 5 + Math.floor(rnd() * 8);
      const w = [];
      for (let x = 0; x < n; x++) w.push(VOCAB[Math.floor(rnd() * VOCAB.length)]);
      const en = (w.join(' ') + ' ' + (++lineNo)).replace(/^./, (c) => c.toUpperCase());
      lines.push({ en, k: normKey(en), off: (j + 0.5) * SEG_MS / Math.max(1, pick) });
    }
    segs.push({ t: T0 + t, lines });
  }

  // ── 虛擬觀眾 ────────────────────────────────────────────────────────────
  const issueEnv = isolates[0].env;
  const viewers = [];
  const sharedIp = '203.0.113.7';
  const typesCycle = opts.mix || ['paid', 'paid', 'free', 'free', 'guest'];
  for (let i = 0; i < N + (sc.leader ? 1 : 0); i++) {
    const isLeader = sc.leader && i === N;
    const type = isLeader ? 'leader' : typesCycle[i % typesCycle.length];
    const it = await isolates[0].api.issueInstallToken(issueEnv);
    const v = {
      i, type, installId: it.installId, token: it.token,
      // ⚠️ 延遲畫面預設開啟（REMOTE_CONFIG.liveDelay，45 秒），擴充功能會主動把畫面拉到落後 40~55 秒
      //    （R17 實測）。所以大部分觀眾在那裡、走 10 秒湊批；關掉的人才貼邊緣或隨意落後。
      //    第一版把大部分人放在邊緣，量到的去重與前導端效果都是錯的。
      lag: isLeader ? 3 : (rnd() < opts.delayShare ? 40 + rnd() * 15 : [3, 4, 5, 8, 12, 20, 33][Math.floor(rnd() * 7)]),
      phase: rnd() * SEG_MS,
      // 前 1/3 開場就在，其他人在前半段陸續加入
      join: isLeader ? 0 : (rnd() < 0.34 ? rnd() * 30000 : rnd() * totalMs * 0.5),
      leave: isLeader && sc.leaderLeaveMin ? sc.leaderLeaveMin * 60000 : Infinity,
      pause: null,
      ip: (sc.sharedIpFrac && rnd() < sc.sharedIpFrac && !isLeader) ? sharedIp : `198.51.${100 + (i >> 8)}.${i & 255}`,
      memo: new Map(), memoAt: new Map(), requested: new Set(), pending: new Map(), urgent: new Set(),
      inflight: 0, timer: null, timerLong: false, cues: [], exhaustedAt: Infinity,
      sent: 0, sentLines: 0, errors: {}, gotFromBundle: 0,
    };
    if (type !== 'guest') {
      const s = await isolates[0].api.issueSession(issueEnv, `viewer${i}@example.test`, 'x');
      v.session = s.token;
      seed(isolates[0].api.acctgKey(`viewer${i}@example.test`), { email: `viewer${i}@example.test`, name: 'Viewer ' + i, emails: [`viewer${i}@example.test`] });
    }
    if (type === 'paid' || type === 'leader') {
      const e = await isolates[0].api.issueEntitlement(issueEnv, v.installId, 'week', Math.floor((T0 + 7 * 86400000) / 1000));
      v.entitlement = e.entitlement;
    }
    // 1/10 的人中途暫停 1~3 分鐘（之後落後變多，而且恢復時一次補抓暫停期間的分段）
    if (!isLeader && rnd() < 0.1) {
      const ps = v.join + 60000 + rnd() * Math.max(1, totalMs - v.join - 240000);
      v.pause = { from: ps, to: ps + 60000 + rnd() * 120000 };
    }
    // 免費試看：擴充功能自己算的時間（未登入 5 分鐘、登入 15 分鐘）
    v.trialMs = type === 'guest' ? 5 * 60000 : type === 'free' ? 15 * 60000 : Infinity;
    viewers.push(v);
  }

  function headersOf(v) {
    const h = { 'content-type': 'application/json', 'x-client-token': v.token, 'cf-connecting-ip': v.ip };
    if (v.session) h.authorization = 'Bearer ' + v.session;
    if (v.entitlement) h['x-entitlement'] = v.entitlement;
    return h;
  }
  const watching = (v, t) => t >= T0 + v.join && t < T0 + v.leave && !(v.pause && t >= T0 + v.pause.from && t < T0 + v.pause.to);
  const entitled = (v, t) => t < T0 + v.join + v.trialMs && t < v.exhaustedAt;
  const lagAt = (v, t) => v.lag + (v.pause && t >= T0 + v.pause.to ? (v.pause.to - v.pause.from) / 1000 : 0);

  // 擴充功能 content/main.js 的 scheduleFlush／flushPending
  function scheduleFlush(v) {
    const urgentPending = [...v.pending.keys()].some((k) => v.urgent.has(k));
    if (v.timer) {
      if (!(v.timerLong && urgentPending)) return;
      vClearTimeout(v.timer); v.timer = null;
    }
    const jitter = Math.floor(rnd() * 1200);
    let wait = 300 + jitter;
    v.timerLong = false;
    if (!urgentPending && v.pending.size < 20) {
      if (v.type === 'leader') { wait = opts.leaderWin * 1000; v.timerLong = true; } else if (lagAt(v, NOW) >= 35) { wait = 10000 + jitter; v.timerLong = true; }
    }
    v.timer = vSetTimeout(() => flush(v), wait);
  }
  async function flush(v) {
    v.timer = null; v.timerLong = false;
    if (!v.pending.size) return;
    if (!entitled(v, NOW) || NOW >= T0 + v.leave) { v.pending.clear(); return; }
    if (v.inflight >= 3) { scheduleFlush(v); return; }
    const keys = [...v.pending.keys()].slice(0, 20);
    const batch = keys.map((k) => v.pending.get(k));
    keys.forEach((k) => { v.pending.delete(k); v.requested.add(k); v.urgent.delete(k); });
    v.inflight++;
    v.sent++; v.sentLines += keys.length;
    try {
      const r = await callWorker('POST', '/v1/translate', headersOf(v), {
        cid: CID, lines: batch, urgent: true, slug: SLUG, live: true, ...(v.type === 'leader' ? { leader: true } : {}),
      });
      const d = r.data || {};
      for (const [k, zh] of Object.entries(d.lines || {})) {
        if (!v.memo.has(k)) { v.memo.set(k, zh); v.memoAt.set(k, NOW); }
      }
      v.paidLines = (v.paidLines || 0) + (Number(d.translated) || 0);
      if (r.status !== 200 || d.error) bump(v.errors, (d.code || 'HTTP' + r.status));
      if (d.code === 'E30' || d.reason === 'free_quota_exhausted') v.exhaustedAt = Math.min(v.exhaustedAt, NOW);
      if (d.pendingElsewhere) {
        // 急件照理不會被要求讓路；真的發生就照擴充功能的做法稍後重排
        const back = keys.filter((k) => !d.lines || !d.lines[k]);
        vSetTimeout(() => { back.forEach((k, j) => { if (!v.memo.has(k)) v.pending.set(k, batch[keys.indexOf(k)]); }); if (v.pending.size) scheduleFlush(v); }, Number(d.retryAfterMs) || 3000);
      }
    } finally {
      keys.forEach((k) => v.requested.delete(k));
      v.inflight--;
      if (v.pending.size) scheduleFlush(v);
    }
  }

  // 排程：每位觀眾的每個分段抵達、每一句的畫面出現
  for (const v of viewers) {
    vSetTimeout(async () => {
      // 開啟影片：讀共用快取（sw.js getBundle）
      const r = await callWorker('GET', '/v1/subs?cid=' + CID, headersOf(v));
      for (const [k, zh] of Object.entries((r.data && r.data.lines) || {})) {
        if (!v.memo.has(k)) { v.memo.set(k, zh); v.memoAt.set(k, NOW); v.gotFromBundle++; }
      }
    }, v.join);
    // 登入的人每 10 分鐘問一次帳號狀態（sw.js accountStatus 快取 10 分鐘）
    if (v.session) {
      for (let t = v.join + 1000; t < Math.min(totalMs, v.leave); t += 600000) {
        vSetTimeout(() => callWorker('GET', '/v1/account/me', headersOf(v)), t);
      }
    }
    if (v.type === 'leader') {
      for (let t = v.join + 500; t < Math.min(totalMs, v.leave); t += 30000) {
        vSetTimeout(() => callWorker('POST', '/v1/leader/beat', headersOf(v), { cid: CID }), t);
      }
    }
    for (const s of segs) {
      if (!s.lines.length) continue;
      const base = s.t + v.phase;
      let arrive = base + 0.3 * v.lag * 1000;
      if (v.pause && arrive >= T0 + v.pause.from) {
        const pd = v.pause.to - v.pause.from;
        arrive = Math.max(T0 + v.pause.to, base + 0.3 * (v.lag * 1000 + pd));
      }
      arrive = Math.max(arrive, T0 + v.join);
      const lagMs = lagAt(v, arrive) * 1000;
      const display0 = base + 21000 + lagMs;
      // 晚加入的人會把直播清單裡還在的分段一次補抓（--backfill 分鐘；R18 實測 107 段、約 10 分鐘）。
      // 那些句子不會顯示（畫面已經過了），但會被送去翻——錢花在這裡
      const backfill = opts.backfill > 0 && v.join > 0 && base >= T0 + v.join - opts.backfill * 60000;
      if ((display0 + SEG_MS < T0 + v.join && !backfill) || arrive >= T0 + totalMs || arrive >= T0 + v.leave) continue;
      vSetTimeout(() => {
        if (!watching(v, NOW) && !(v.pause && NOW >= T0 + v.pause.to)) return;
        if (!entitled(v, NOW)) return;
        let added = 0;
        for (const l of s.lines) {
          if (v.memo.has(l.k) || v.requested.has(l.k) || v.pending.has(l.k)) continue;
          v.pending.set(l.k, l.en); added++;
        }
        if (added) scheduleFlush(v);
      }, arrive - T0);
      for (const l of s.lines) {
        const display = display0 + l.off;
        if (display < T0 + v.join || display >= T0 + totalMs || display >= T0 + v.leave) continue;
        const cue = { k: l.k, en: l.en, display };
        v.cues.push(cue);
        vSetTimeout(() => {
          cue.counted = entitled(v, NOW) && watching(v, NOW);
          // 畫面出現了還沒有譯文：DOM 那條路以急件單獨補送（content/main.js handleCaption）
          if (cue.counted && !v.memo.has(l.k) && !v.requested.has(l.k)) {
            v.urgent.add(l.k); v.pending.set(l.k, l.en); scheduleFlush(v);
          }
        }, display - T0);
      }
    }
  }

  // ── 事件迴圈 ────────────────────────────────────────────────────────────
  // ⚠️ 每推進一格時鐘，要等所有「這一刻」觸發的非同步工作做完才能再推進。
  //    全部的 I/O 都是假的（同步完成或掛在虛擬計時器上），所以只剩 microtask；
  //    用 setImmediate 讓它們跑完，連續幾輪沒有新動靜就當作這一刻結束了。
  const settle = async () => {
    let idle = 0, last = -1;
    while (idle < 2) {
      await new Promise((r) => setImmediate(r));
      if (activity === last) idle++; else { idle = 0; last = activity; }
    }
  };
  const END = T0 + totalMs + 60000;       // 收尾多跑一分鐘，讓還在飛的請求回來
  let steps = 0;
  while (heap.length && heap[0][0] <= END) {
    const at = heap[0][0];
    NOW = at;
    while (heap.length && heap[0][0] === at) {
      const [, id, fn] = hpop();
      if (cancelled.has(id)) { cancelled.delete(id); continue; }
      try { fn(); } catch (e) { bump(C.workerErrMsg, 'timer: ' + String(e.message).slice(0, 60)); }
    }
    await settle();
    if (++steps % 20000 === 0 && opts.progress) process.stderr.write(`\r  ${(minute()).toFixed(1)} / ${MIN} 分鐘`);
  }
  if (opts.progress) process.stderr.write('\r' + ' '.repeat(40) + '\r');

  // ── 結果 ────────────────────────────────────────────────────────────────
  const uniq = new Set();
  for (const s of segs) for (const l of s.lines) if (s.t >= T0 - 120000) uniq.add(l.k);
  const byType = {};
  for (const v of viewers) {
    const b = byType[v.type] || (byType[v.type] = { viewers: 0, cues: 0, onTime: 0, late: 0, missed: 0, errors: {}, paidLines: 0, delay: 0 });
    b.viewers++;
    b.paidLines += v.paidLines || 0;
    if (v.lag >= 35) b.delay++;
    for (const c of v.cues) {
      if (!c.counted) continue;
      b.cues++;
      const at = v.memoAt.get(c.k);
      if (at !== undefined && at <= c.display) b.onTime++;
      else if (at !== undefined && at <= c.display + 3500) b.late++;
      else b.missed++;
    }
    for (const [k, n] of Object.entries(v.errors)) bump(b.errors, k, n);
  }
  const roomGBs = C.doActiveMs.ROOM / 1000 * 0.128;
  const authGBs = C.doActiveMs.AUTH / 1000 * 0.128;
  return {
    scenario: opts.scenario, desc: sc.desc, delayShare: opts.delayShare, viewers: N, minutes: MIN, isolates: K,
    worker: C.worker, workerBy: C.workerBy, workerStatus: C.workerStatus, workerErr: C.workerErr, workerErrMsg: C.workerErrMsg,
    doReq: C.doReq, doOps: C.doOps, doFail: C.doFail, doGBs: roomGBs + authGBs,
    authQueueMax: C.authQueueMax, authWaitMax: C.authWaitMax,
    kv: C.kv, kvPutBy: C.kvPutBy, kvGetBy: C.kvGetBy, kvListBy: C.kvListBy, kvPutFail: C.kvPutFail,
    model: C.model, model429: C.model429, modelLines: C.modelLines, modelDistinct: C.modelDistinct.size, uniqueLines: uniq.size,
    cost: C.model * COST_PER_CALL + C.modelLines * COST_PER_LINE,
    byType,
    perViewer: viewers.map((v) => ({ type: v.type, lag: Math.round(v.lag), joinMin: +(v.join / 60000).toFixed(1), paidLines: v.paidLines || 0, sent: v.sentLines })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 輸出
// ─────────────────────────────────────────────────────────────────────────────
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');
const top = (o, n) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n || 8).map(([k, v]) => `${k} ${v}`).join('、') || '—';

function report(r) {
  const perH = 60 / r.minutes;
  console.log(`\n━━━ ${r.scenario}：${r.desc} ━━━`);
  console.log(`觀眾 ${r.viewers} 位、${r.minutes} 分鐘、${r.isolates} 個 isolate、延遲畫面 ${Math.round(r.delayShare * 100)}%`);
  console.log(`\n【使用者看到的】（準時＝畫面出現之前就有譯文；晚到＝出現後 3.5 秒內補上）`);
  for (const [t, b] of Object.entries(r.byType)) {
    console.log(`  ${t.padEnd(7)} ${String(b.viewers).padStart(3)} 人  ${String(b.cues).padStart(6)} 句  準時 ${pct(b.onTime, b.cues).padStart(6)}  晚到 ${pct(b.late, b.cues).padStart(6)}  沒有 ${pct(b.missed, b.cues).padStart(6)}`
      + `  自己翻 ${b.paidLines} 句` + (Object.keys(b.errors).length ? `  錯誤：${top(b.errors)}` : ''));
  }
  console.log(`\n【成本】模型呼叫 ${r.model} 次（429 ${r.model429}）、送翻 ${r.modelLines} 句，其中不重複 ${r.modelDistinct} 句`
    + ` → 重複付費倍率 ${(r.modelLines / Math.max(1, r.modelDistinct)).toFixed(2)}×（時間線共 ${r.uniqueLines} 句）、估計 $${r.cost.toFixed(3)}（每小時 $${(r.cost * perH).toFixed(2)}）`);
  console.log(`\n【Cloudflare 用量】（括號內＝換算每小時）`);
  console.log(`  Worker 請求  ${r.worker}（${Math.round(r.worker * perH)}）  ${top(r.workerBy, 5)}`);
  console.log(`  DO 請求      ROOM ${r.doReq.ROOM}（${Math.round(r.doReq.ROOM * perH)}）、AUTH ${r.doReq.AUTH}（${Math.round(r.doReq.AUTH * perH)}）  作用時間上限 ${r.doGBs.toFixed(0)} GB-s（${Math.round(r.doGBs * perH)}／小時）`);
  console.log(`               ROOM：${top(r.doOps.ROOM)}`);
  console.log(`               AUTH：${top(r.doOps.AUTH)}　排隊最深 ${r.authQueueMax}、最久 ${r.authWaitMax}ms`);
  if (r.doFail.ROOM || r.doFail.AUTH) console.log(`               注入失敗：ROOM ${r.doFail.ROOM}、AUTH ${r.doFail.AUTH}`);
  console.log(`  KV 讀        ${r.kv.get}（${Math.round(r.kv.get * perH)}）  ${top(r.kvGetBy, 6)}`);
  console.log(`  KV 寫        ${r.kv.put}（${Math.round(r.kv.put * perH)}）  ${top(r.kvPutBy, 8)}` + (r.kvPutFail ? `　被拒 ${r.kvPutFail}` : ''));
  console.log(`  KV 列舉      ${r.kv.list}（${Math.round(r.kv.list * perH)}）  ${top(r.kvListBy, 6)}`);
  if (r.workerErr) console.log(`  ⚠️ Worker 例外 ${r.workerErr} 次：${top(r.workerErrMsg, 4)}`);
  const st = Object.entries(r.workerStatus).filter(([k]) => !/ 200$/.test(k));
  if (st.length) console.log(`  非 200 回應：${st.map(([k, v]) => `${k}×${v}`).join('、')}`);
}

/** ① 天花板：每一項上限在 N 人同時看的時候，一天能撐幾小時的直播 */
function ceiling(rs) {
  console.log('\n━━━ ① 天花板：一天能撐幾小時的直播（只算直播本身的用量）━━━');
  console.log('⚠️ 排程、收割、後台、網站另外會吃掉一部分——實際能用的比這裡少\n');
  const rows = [
    ['Worker 請求', (r) => r.worker, LIMITS.worker],
    ['DO 請求', (r) => r.doReq.ROOM + r.doReq.AUTH, LIMITS.doReq],
    ['DO 作用時間（GB-s）', (r) => r.doGBs, LIMITS.doGBs],
    ['KV 讀', (r) => r.kv.get, LIMITS.kvRead],
    ['KV 寫', (r) => r.kv.put, LIMITS.kvWrite],
    ['KV 列舉', (r) => r.kv.list, LIMITS.kvList],
  ];
  const head = '項目'.padEnd(18) + rs.map((r) => `${r.viewers} 人／小時`.padStart(14) + '撐幾小時'.padStart(9)).join('');
  console.log(head);
  for (const [name, f, lim] of rows) {
    let line = name.padEnd(18);
    for (const r of rs) {
      const perH = f(r) * 60 / r.minutes;
      const h = perH ? lim / perH : Infinity;
      line += String(Math.round(perH)).padStart(14) + (h === Infinity ? '∞' : h.toFixed(1)).padStart(9);
    }
    console.log(line);
  }
  console.log('\n模型成本（每小時）：' + rs.map((r) => `${r.viewers} 人 $${(r.cost * 60 / r.minutes).toFixed(2)}`).join('、'));
}

/**
 * 回歸檢查（--check）。每一項都對到 handoff 6.2 的一個已修問題；
 * 突變測試：把對應的修正拿掉，那一項一定要變紅（2026-10-16 做過）。
 */
async function check(base) {
  let bad = 0;
  const ok = (m) => console.log('✅ ' + m);
  const no = (m) => { bad++; console.log('❌ ' + m); };
  const o = (x) => Object.assign({}, base, { viewers: 30, minutes: 10, progress: false }, x);

  // 0. 先懷疑工具本身（坑 #36）：量不到東西的檢查比沒有檢查更糟
  const b = await simulate(o({ scenario: 'base', delayShare: 0 }));
  const cues = Object.values(b.byType).reduce((a, t) => a + t.cues, 0);
  const onTime = Object.values(b.byType).reduce((a, t) => a + t.onTime, 0);
  cues > 1000 && b.model > 0 && onTime / cues > 0.95
    ? ok(`模擬器有在量：${cues} 句字幕、${b.model} 次模型呼叫、準時 ${(100 * onTime / cues).toFixed(1)}%`)
    : no(`模擬器本身沒量到東西或字幕大量遲到：${cues} 句、模型 ${b.model} 次、準時 ${onTime}/${cues}`);

  // 1. S1：所有人貼邊緣看（最壞情況），同一句不可以被付很多次錢
  const dup = b.modelLines / Math.max(1, b.modelDistinct);
  dup <= 1.15
    ? ok(`S1 貼邊緣的觀眾不再彼此重複付費：重複倍率 ${dup.toFixed(2)}×（修正前 30 人約 2.8×）`)
    : no(`S1 直播去重失效：30 人都貼邊緣看時重複付費 ${dup.toFixed(2)}×——沒認領到的人等不到別人的譯文（handoff 6.2 S1）`);

  // 2. S4：沒有前導端時，告警的 once 不可以每個請求都問一次 AuthGuard
  const once = b.doOps.AUTH.once || 0;
  once <= base.isolates * 2
    ? ok(`S4 前導端不在的告警：AuthGuard once 只問了 ${once} 次（每個 isolate 一次）`)
    : no(`S4 每個直播請求都問一次 AuthGuard once：${once} 次（handoff 6.2 S4）`);

  // 3. S3：KV 寫入額度用完時，翻譯請求不可以 500
  const f = await simulate(o({ scenario: 'kvFull' }));
  !f.workerErr
    ? ok('S3 KV 寫入額度用完時，翻譯請求照常回應（沒有任何 Worker 例外）')
    : no(`S3 KV 寫入額度用完後有 ${f.workerErr} 個請求丟例外：${top(f.workerErrMsg, 2)}（handoff 6.2 S3）`);

  console.log(bad ? `\n❌ ${bad} 項未通過` : '\n✅ 多人直播的回歸檢查全部通過');
  process.exit(bad ? 1 : 0);
}

(async () => {
  const base = {
    viewers: Number(arg('viewers', 30)), minutes: Number(arg('minutes', 30)),
    isolates: Number(arg('isolates', 2)), seed: Number(arg('seed', 20261016)),
    backend: arg('backend', '') || '',
    scenario: String(arg('scenario', 'base')), delayShare: Number(arg('delay-share', 0.8)), leaderWin: Number(arg('leader-win', 20)), noHibernate: !!arg('no-hibernate', false), noRlBinding: !!arg('no-rl-binding', false), backfill: Number(arg('backfill', 0)) || 0, verbose: !!arg('verbose', false), progress: !arg('json', false),
  };
  if (!SCENARIOS[base.scenario]) { console.log('沒有這個情境：' + base.scenario + '。可用：' + Object.keys(SCENARIOS).join('、')); process.exit(2); }
  const out = [];
  if (arg('check', false)) return check(base);
  if (arg('ceiling', false)) {
    for (const n of [10, 30, 100]) out.push(await simulate(Object.assign({}, base, { viewers: n, scenario: 'base' })));
    if (!arg('json', false)) { out.forEach(report); ceiling(out); }
  } else if (arg('all', false)) {
    for (const s of Object.keys(SCENARIOS)) out.push(await simulate(Object.assign({}, base, { scenario: s })));
    if (!arg('json', false)) out.forEach(report);
  } else {
    out.push(await simulate(base));
    if (!arg('json', false)) report(out[0]);
  }
  if (arg('json', false)) console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.log('❌ 模擬器本身出錯：' + (e && e.stack || e)); process.exit(1); });
