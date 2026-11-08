#!/usr/bin/env node
/**
 * Email 驗證碼登入與工作階段的資安實測。
 *
 * ⚠️ **每一條規則拿掉都不會讓登入壞掉，只會讓它可以被攻破。**
 *    這正是最危險的形狀——功能測試全綠，而大門是開的。
 *
 *    沒有次數上限 → 六位數字用程式猜，平均 50 萬次就中
 *    次數存在 KV  → 同時送 50 個猜測，50 個都讀到「猜了 0 次」（2026-10-02 修掉）
 *    可以用第二次 → 翻到舊信的人可以一直登入；KV 刪除要 60 秒才傳到別的機房
 *    存明碼      → 儲存一旦外流，所有進行中的登入都被接管
 *    沒有冷卻    → 我們的伺服器變成別人的信箱轟炸機
 *    沒有全站上限 → 狂要碼燒光寄信額度，付了錢的人收不到授權碼
 *    會列舉      → 這支端點變成「查某人是不是使用者」的工具
 *    用 === 比對 → 回應時間會洩漏對了幾位
 *    不能撤銷    → 權杖被偷就能用滿效期，按登出也沒用
 *
 * AuthGuard（Durable Object）用真的類別、假的 storage 跑；並發用「一次只處理一個請求」
 * 模擬 DO 的語意——那正是 KV 做不到、而這次改用 DO 的原因。
 *
 * 用法：node tools/check-auth-email.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const vm = require('vm');
const root = path.join(__dirname, '..');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const fail = (m, d) => { errors.push(m + (d ? '：' + d : '')); console.log('❌ ' + m + (d ? '：' + d : '')); };

let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

// 寄出去的信都攔下來，才拿得到驗證碼（真實世界只有使用者的信箱拿得到）。
const mails = [];
let siteverify = null;   // Turnstile 的假回應（測試第 12 項設定）
const sandbox = {
  crypto: require('crypto').webcrypto,
  TextEncoder, TextDecoder, btoa, atob, Uint8Array, Uint32Array, URLSearchParams, AbortSignal,
  Response: class { constructor(b, i) { this.body = b; this.status = 200; Object.assign(this, i || {}); if (this.ok === undefined) this.ok = true; } },
  Request: class {},
  URL, console, Date, Math, JSON, Map, Set, Promise, RegExp, Error,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, setTimeout,
  fetch: async (url, init) => {
    if (String(url).includes('resend.com')) {
      const b = JSON.parse(init.body);
      mails.push({ to: b.to[0], subject: b.subject, html: b.html });
      return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
    }
    if (String(url).includes('challenges.cloudflare.com')) {
      if (!siteverify) throw new Error('siteverify 連不上');
      return { ok: true, status: 200, json: async () => siteverify };
    }
    throw new Error('未預期的網路呼叫：' + url);
  },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { otpStart, otpVerify, otpNew, emailLogin, googleLogin,'
  + ' readGoogleAccount, mergeEmailAccountIntoGoogle, accountKey, issueSession, verifySession,'
  + ' OTP_MAX_TRIES, OTP_TTL_SEC, OTP_COOLDOWN_SEC, OTP_HOURLY_MAX, OTP_MAILBOX_SPREAD, OTP_EMAIL_FAIL_MAX, OTP_IP_10MIN_MAX,'
  + ' OTP_IP_FAIL_HOURLY_MAX, looksLikeEmail, AuthGuard, authCall, authSubHash, turnstileOk, hmac,'
  + ' FREE_DAILY_LINES, FREE_DAILY_LINES_GUEST };', ctx);
const A = sandbox.__api;

function fakeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix || '')).map((name) => ({ name, metadata: {} })), list_complete: true };
    },
    _store: store,
  };
}

/** Durable Object 的 storage（structured clone 語意：存進去的是副本）。 */
function fakeDOStorage() {
  const m = new Map();
  let alarm = null;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    async get(k) { return clone(m.get(k)); },
    async put(k, v) { m.set(k, clone(v)); },
    async delete(k) { for (const x of [].concat(k)) m.delete(x); },
    async list() { return new Map([...m.entries()].map(([k, v]) => [k, clone(v)])); },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
    _map: m,
  };
}

/** AUTH 綁定：真的 AuthGuard、一次只處理一個請求（DO 的語意）。 */
function fakeAuthNS() {
  const storage = fakeDOStorage();
  const guard = new A.AuthGuard({ storage }, {});
  let chain = Promise.resolve();
  const stub = {
    fetch(url, init) {
      const p = chain.then(() => guard.fetch({ json: async () => JSON.parse(init.body) }));
      chain = p.catch(() => {});
      return p.then((resp) => ({ json: async () => JSON.parse(resp.body) }));
    },
  };
  return { idFromName: () => 'auth-v1', get: () => stub, _storage: storage, _guard: guard };
}

const newEnv = () => ({ SUBS: fakeKV(), AUTH: fakeAuthNS(), TOKEN_SECRET: 'test-secret', RESEND_API_KEY: 're_test', MAIL_FROM: 'x <a@b.c>' });
// ⚠️ 驗證碼在信件內文的那個方框裡（mailCodeBox：`>123456</div>`）。
//    不可以抓「第一個六位數字」——信件 HTML 的色碼（#313139）也是六位數字，
//    第一版就是抓到顏色，於是正確的碼被測成「被拒」。
const codeOf = () => (mails[mails.length - 1].html.match(/>(\d{6})<\/div>/) || [])[1];

// 時間控制（冷卻、每小時、鎖定都要靠它）
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (sec) => { clockOffset += sec * 1000; };
// ⚠️ 每小時上限是以整點為界的視窗。一路 advance(61) 下去如果剛好跨過整點，計數會歸零，
//    測試就變成看運氣。需要「同一個小時內」的測試先對齊到整點後一秒。
const alignHour = () => { const s = Math.floor(Date.now() / 1000); advance(3600 - (s % 3600) + 1); };

(async () => {
  // -------------------------------------------------------------------------
  // 1) 驗證碼本身
  // -------------------------------------------------------------------------
  {
    const bad = [];
    const seen = new Map();
    for (let i = 0; i < 4000; i++) {
      const c = A.otpNew();
      if (!/^\d{6}$/.test(c)) { bad.push('格式不是六位數字：' + c); break; }
      const d = c[0];
      seen.set(d, (seen.get(d) || 0) + 1);
    }
    let worst = 0;
    for (const d of '0123456789') worst = Math.max(worst, Math.abs((seen.get(d) || 0) - 400));
    if (worst > 120) bad.push(`首位數字分布不均（最大偏差 ${worst}，期望 400）`);
    bad.length ? fail('驗證碼產生有問題', bad.join('；')) : ok('驗證碼是六位數字且分布均勻（沒有 modulo bias）');
  }

  // -------------------------------------------------------------------------
  // 2) 正常流程 + 單次有效 + 儲存裡沒有任何原文 + 主旨沒有驗證碼
  // -------------------------------------------------------------------------
  {
    const env = newEnv();
    const bad = [];
    const r = await A.otpStart(env, 'Ray@Example.com ', '203.0.113.9');
    if (!r.ok) bad.push('正常要求被拒：' + r.error);
    // ⚠️ 回應裡**絕對不可以**有驗證碼
    if (JSON.stringify(r).match(/\d{6}/)) bad.push('回應裡出現了六位數字 —— 驗證碼不可以回傳給呼叫端');
    const code = codeOf();
    if (!code) bad.push('信裡找不到驗證碼');
    // ⚠️ 主旨會進郵件伺服器的日誌與鎖定畫面的通知（使用者：驗證碼不可以被 Log）
    if (code && mails[mails.length - 1].subject.includes(code)) bad.push('驗證碼出現在信件主旨');

    // ⚠️ KV 與 AuthGuard 裡都只能有雜湊：驗證碼、信箱、IP 都不可以是原文
    const stored = JSON.stringify([...env.SUBS._store.entries(), ...env.AUTH._storage._map.entries()]);
    if (code && stored.includes(code)) bad.push('儲存裡有驗證碼明碼 —— 外流等於所有登入被接管');
    if (stored.includes('example.com')) bad.push('儲存裡有信箱原文');
    if (stored.includes('203.0.113.9')) bad.push('儲存裡有 IP 原文（隱私權政策承諾只存雜湊）');

    // email 大小寫與前後空白要正規化（寄給誰就能用誰驗）
    const v1 = await A.otpVerify(env, 'ray@example.com', code, '203.0.113.9');
    if (!v1.ok) bad.push('正確的驗證碼被拒：' + v1.error);
    // 第二次一定要失敗
    const v2 = await A.otpVerify(env, 'ray@example.com', code, '203.0.113.9');
    if (v2.ok) bad.push('同一組碼可以用第二次 —— 翻到舊信的人可以一直登入');
    // 用 A 信箱的碼登 B 信箱（碼與信箱綁在雜湊裡）
    advance(61);
    await A.otpStart(env, 'mine@example.com', '203.0.113.10');
    const mine = codeOf();
    const swap = await A.otpVerify(env, 'victim@example.com', mine, '203.0.113.10');
    if (swap.ok) bad.push('A 信箱的驗證碼可以拿去登入 B 信箱');

    bad.length ? fail('基本流程有問題', bad.join('；'))
      : ok('寄碼→驗證→登入正常；主旨、回應、儲存都沒有明碼；同一組碼只能用一次；碼綁定信箱');
  }

  // -------------------------------------------------------------------------
  // 3) 猜碼：逐次、並發、跨碼
  // -------------------------------------------------------------------------
  {
    const env = newEnv();
    await A.otpStart(env, 'guess@example.com', '198.51.100.1');
    const code = codeOf();
    const bad = [];
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < A.OTP_MAX_TRIES; i++) {
      const r = await A.otpVerify(env, 'guess@example.com', wrong, '198.51.100.' + (10 + i));
      if (r.ok) { bad.push('錯的碼被接受'); break; }
    }
    // 用完次數之後，**連正確的碼也不能再用**——整組要燒掉
    const after = await A.otpVerify(env, 'guess@example.com', code, '198.51.100.99');
    if (after.ok) bad.push(`猜錯 ${A.OTP_MAX_TRIES} 次之後正確的碼仍然有效 —— 等於沒有次數上限`);
    bad.length ? fail('猜碼防護有問題', bad.join('；'))
      : ok(`猜錯 ${A.OTP_MAX_TRIES} 次就把整組碼燒掉（六位數字沒有上限的話平均 50 萬次就猜中）`);
  }
  {
    // ⚠️ 並發：以前次數存在 KV，同時送出的請求全部讀到「猜了 0 次」
    const env = newEnv();
    advance(61);
    await A.otpStart(env, 'race@example.com', '198.51.100.2');
    const code = codeOf();
    const bad = [];
    const guesses = [];
    for (let i = 0; i < 40; i++) {
      const g = String((Number(code) + 1 + i) % 1000000).padStart(6, '0');
      guesses.push(A.otpVerify(env, 'race@example.com', g, '198.51.100.' + (100 + i)));
    }
    const rs = await Promise.all(guesses);
    if (rs.some((r) => r.ok)) bad.push('並發的錯誤猜測有被接受的');
    const after = await A.otpVerify(env, 'race@example.com', code, '198.51.100.250');
    if (after.ok) bad.push('同時送 40 個錯的猜測之後，正確的碼仍然有效 —— 次數上限在並發下失效');
    // 同時送好幾個正確的碼：只能有一個成功
    advance(61);
    await A.otpStart(env, 'twice@example.com', '198.51.100.3');
    const c2 = codeOf();
    const same = await Promise.all(Array.from({ length: 8 }, (_, i) => A.otpVerify(env, 'twice@example.com', c2, '198.51.100.' + (40 + i))));
    const wins = same.filter((r) => r.ok).length;
    if (wins !== 1) bad.push(`同時送 8 個正確的碼，成功了 ${wins} 個（應該剛好 1 個）`);
    bad.length ? fail('並發猜碼／重放', bad.join('；'))
      : ok('並發下次數上限照樣成立；同時送多個正確的碼只有一個能登入（單次使用是原子的）');
  }
  {
    // 跨碼：換一組新碼不可以讓猜測次數歸零
    const env = newEnv();
    const bad = [];
    let ip = 1;
    let fails = 0;
    let lockedAt = 0;
    for (let round = 0; round < 4 && !lockedAt; round++) {
      advance(61);
      const s = await A.otpStart(env, 'lock@example.com', '192.0.2.' + (ip++));
      if (!s.ok) { if (s.code === 'E69') lockedAt = fails; break; }
      const code = codeOf();
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < A.OTP_MAX_TRIES; i++) {
        const r = await A.otpVerify(env, 'lock@example.com', wrong, '192.0.2.' + (ip++));
        fails++;
        if (r.code === 'E69') { lockedAt = fails; break; }
      }
    }
    if (lockedAt !== A.OTP_EMAIL_FAIL_MAX) bad.push(`跨碼累計猜錯 ${A.OTP_EMAIL_FAIL_MAX} 次應該鎖住，實際：${lockedAt || '沒有鎖'}`);
    advance(61);
    const again = await A.otpStart(env, 'lock@example.com', '192.0.2.200');
    if (again.ok || again.code !== 'E69') bad.push('鎖住之後仍然可以要新的碼');
    advance(3700);
    const later = await A.otpStart(env, 'lock@example.com', '192.0.2.201');
    if (!later.ok) bad.push('鎖定一小時後仍然要不到碼（鎖太久會變成別人能故意把你鎖在門外）');
    // security-audit run-2 #8：解鎖後別人再猜錯 1 次不可以又鎖一小時（鎖定時失敗計數要歸零）
    if (later.ok) {
      const wrong = codeOf() === '000000' ? '111111' : '000000';
      const one = await A.otpVerify(env, 'lock@example.com', wrong, '192.0.2.202');
      if (one.code === 'E69') bad.push('解鎖後猜錯 1 次又被鎖住——知道 email 就能讓對方整天用不了驗證碼登入');
    }
    bad.length ? fail('跨碼的猜錯上限', bad.join('；'))
      : ok(`同一信箱 24 小時內跨碼猜錯 ${A.OTP_EMAIL_FAIL_MAX} 次鎖 1 小時（只有每組 5 次的話，換碼就能無限猜）`);
  }
  {
    // 每 IP 猜錯上限：同一台機器對很多信箱各猜幾次
    const env = newEnv();
    const bad = [];
    for (let i = 0; i < A.OTP_IP_FAIL_HOURLY_MAX; i++) {
      await A.otpVerify(env, `spray${i}@example.com`, '123456', '192.0.2.77');
    }
    const r = await A.otpVerify(env, 'spray-last@example.com', '123456', '192.0.2.77');
    if (r.code !== 'E66') bad.push(`同一個 IP 猜錯 ${A.OTP_IP_FAIL_HOURLY_MAX} 次之後沒有被擋：${JSON.stringify(r)}`);
    bad.length ? fail('每 IP 的猜錯上限', bad.join('；'))
      : ok(`同一個 IP 每小時最多猜錯 ${A.OTP_IP_FAIL_HOURLY_MAX} 次（擋「換很多信箱各猜幾次」）`);
  }

  // -------------------------------------------------------------------------
  // 4) 寄碼的限額：冷卻、每小時、每 IP、全站
  // -------------------------------------------------------------------------
  {
    const env = newEnv();
    const bad = [];
    alignHour();
    const a = await A.otpStart(env, 'flood@example.com', '192.0.2.1');
    if (!a.ok) bad.push('第一次就被擋');
    const b = await A.otpStart(env, 'flood@example.com', '192.0.2.2');
    if (b.ok) bad.push(`${A.OTP_COOLDOWN_SEC} 秒內可以連續要碼 —— 伺服器會變成信箱轟炸機`);
    // 每小時上限：同一個來源 OTP_HOURLY_MAX；換很多 IP 加起來也只到 OTP_MAILBOX_SPREAD 倍（防轟炸）
    // （security-audit run-2 #8：以前只算信箱，別人用一個 IP 就能把本人今天的份用完）
    let sentInHour = 1;
    for (let i = 0; i < A.OTP_HOURLY_MAX * A.OTP_MAILBOX_SPREAD + 3; i++) {
      advance(61);
      const r = await A.otpStart(env, 'flood@example.com', '192.0.2.' + (10 + i));
      if (r.ok) sentInHour++;
    }
    if (sentInHour > A.OTP_HOURLY_MAX * A.OTP_MAILBOX_SPREAD) bad.push(`同一個信箱一小時寄了 ${sentInHour} 封（上限 ${A.OTP_HOURLY_MAX * A.OTP_MAILBOX_SPREAD}）`);
    {
      const envS = newEnv();
      alignHour();
      let same = 0;
      for (let i = 0; i < A.OTP_HOURLY_MAX + 2; i++) {
        advance(61);
        if ((await A.otpStart(envS, 'one@example.com', '192.0.2.200')).ok) same++;
        if (i === 1 || i === 4) advance(600);   // 避開每 IP 10 分鐘 3 封
      }
      if (same > A.OTP_HOURLY_MAX) bad.push(`同一個來源對同一個信箱一小時寄了 ${same} 封（上限 ${A.OTP_HOURLY_MAX}）`);
      advance(61);
      const other = await A.otpStart(envS, 'one@example.com', '203.0.113.200');
      if (!other.ok) bad.push('別的來源把這個信箱的份用完之後，本人從自己的網路也要不到驗證碼（' + other.error + '）');
    }

    // 每 IP：10 分鐘內換信箱狂要
    const env2 = newEnv();
    let ipOk = 0;
    for (let i = 0; i < A.OTP_IP_10MIN_MAX + 2; i++) {
      const r = await A.otpStart(env2, `bot${i}@example.com`, '198.51.100.66');
      if (r.ok) ipOk++;
    }
    if (ipOk > A.OTP_IP_10MIN_MAX) bad.push(`同一個 IP 10 分鐘內寄了 ${ipOk} 封（上限 ${A.OTP_IP_10MIN_MAX}）`);

    // 全站：很多 IP、很多信箱也不可以燒光寄信額度
    const env3 = newEnv();
    env3.OTP_GLOBAL_DAILY = '3';
    const before = mails.length;
    let globalOk = 0, lastMsg = '';
    for (let i = 0; i < 6; i++) {
      const r = await A.otpStart(env3, `many${i}@example.com`, '203.0.113.' + (50 + i));
      if (r.ok) globalOk++; else lastMsg = r.error;
    }
    if (globalOk !== 3 || mails.length - before !== 3) bad.push(`全站上限 3 封，實際寄了 ${mails.length - before} 封`);
    if (!/Google/.test(lastMsg)) bad.push('全站額滿時沒有告訴使用者可以改用 Google 登入');

    // 陌生信箱的池子：大量 IP 灌隨機信箱只能燒掉這一池，既有客戶照樣收得到（2026-10-28）
    const env4 = newEnv();
    env4.OTP_GLOBAL_DAILY = '10';
    env4.OTP_NEW_DAILY = '2';
    await A.emailLogin(env4, 'regular@example.com');
    let newOk = 0;
    for (let i = 0; i < 6; i++) if ((await A.otpStart(env4, `rand${i}@example.com`, '203.0.113.' + (120 + i))).ok) newOk++;
    if (newOk !== 2) bad.push(`陌生信箱的池子上限 2 封，實際寄了 ${newOk} 封`);
    const known = await A.otpStart(env4, 'regular@example.com', '203.0.113.140');
    if (!known.ok) bad.push('陌生信箱的池子用完之後，既有客戶也要不到驗證碼（' + known.error + '）');

    bad.length ? fail('寄碼限額', bad.join('；'))
      : ok(`冷卻 ${A.OTP_COOLDOWN_SEC} 秒、每信箱每小時 ${A.OTP_HOURLY_MAX} 封、每 IP 10 分鐘 ${A.OTP_IP_10MIN_MAX} 封、全站每日上限（保護授權碼信的寄信額度）`);
  }

  // -------------------------------------------------------------------------
  // 5) 帳號列舉：有沒有帳號都要回一樣的東西
  // -------------------------------------------------------------------------
  {
    const env = newEnv();
    await A.emailLogin(env, 'known@example.com');
    const r1 = await A.otpStart(env, 'known@example.com', '198.51.100.31');
    const r2 = await A.otpStart(env, 'nobody-here@example.com', '198.51.100.32');
    const v1 = await A.otpVerify(env, 'known@example.com', '000001', '198.51.100.33');
    const v2 = await A.otpVerify(env, 'never-asked@example.com', '000001', '198.51.100.34');
    const shape = (x) => JSON.stringify({ ok: x.ok, code: x.code || null, error: x.error || null });
    (shape(r1) === shape(r2) && shape(v1) === shape(v2))
      ? ok('有帳號與沒帳號、有碼與沒碼的回應完全相同（不可以變成「查某人是不是使用者」的工具）')
      : fail('回應會洩漏這個 email 的狀態', shape(r1) + ' vs ' + shape(r2) + '／' + shape(v1) + ' vs ' + shape(v2));
  }

  // -------------------------------------------------------------------------
  // 6) 沒設定寄信、沒有 AuthGuard 時都要明講，不可以假裝寄出去
  // -------------------------------------------------------------------------
  {
    const before = mails.length;
    const r = await A.otpStart({ SUBS: fakeKV(), AUTH: fakeAuthNS(), TOKEN_SECRET: 's' }, 'x@example.com', '1.1.1.1');
    const r2 = await A.otpStart({ SUBS: fakeKV(), TOKEN_SECRET: 's', RESEND_API_KEY: 're' }, 'x@example.com', '1.1.1.1');
    const v2 = await A.otpVerify({ SUBS: fakeKV(), TOKEN_SECRET: 's' }, 'x@example.com', '123456', '1.1.1.1');
    (!r.ok && !r2.ok && !v2.ok && mails.length === before)
      ? ok('沒設定寄信、或 AuthGuard 不在時直接拒絕（fail closed，不退回 KV）')
      : fail('沒有寄信設定或沒有 AuthGuard 卻放行', JSON.stringify([r, r2, v2]));
  }

  // -------------------------------------------------------------------------
  // 7) 同一個 email，Google 與驗證碼必須是同一個帳號
  // -------------------------------------------------------------------------
  {
    const env = newEnv();
    const bad = [];
    const a1 = await A.emailLogin(env, 'both@example.com');
    if (!a1.created) bad.push('第一次沒有建立帳號');
    const sessOld = await A.issueSession(env, a1.acc.sub);
    const g = await A.googleLogin(env, { sub: '55667788', email: 'both@example.com', name: 'Ray' });
    if (g.acc.sub !== '55667788') bad.push('Google 登入沒有變成主帳號');
    if (!(g.acc.emails || []).includes('both@example.com')) bad.push('合併後 email 不見了');
    // ⚠️ 舊的工作階段不可以立刻失效——使用者可能開著另一個分頁
    const resolved = await A.readGoogleAccount(env, (await A.verifySession(env, sessOld.token)).sub);
    if (!resolved || resolved.sub !== '55667788') bad.push('合併後舊權杖查不到帳號 —— 使用者會被無預警登出');
    const a2 = await A.emailLogin(env, 'both@example.com');
    if (a2.acc.sub !== '55667788') bad.push('驗證碼登入沒有回到合併後的帳號：' + a2.acc.sub);
    bad.length ? fail('Google 與驗證碼沒有指向同一個帳號', bad.join('；'))
      : ok('同一個 email 不論用 Google 或驗證碼，都是同一個帳號；合併後舊權杖仍然有效');
  }

  // -------------------------------------------------------------------------
  // 8) email 格式：只收安全字元
  // -------------------------------------------------------------------------
  {
    const okCases = ['a@b.co', 'ray.lin+f1@gmail.com', 'first_last@mail.example.com.tw'];
    const ngCases = ['', 'a', 'a@b', 'a b@c.com', 'a@@b.com', 'x'.repeat(250) + '@b.com',
      '<script>@x.co', 'a"b@c.com', "o'neil@x.com", 'ä@b.com', 'a@b.c', 'a..b@c.com', 'a@b.com\n'.repeat(2)];
    const bad = [];
    for (const e of okCases) if (!A.looksLikeEmail(e)) bad.push('正常的 email 被拒：' + e);
    for (const e of ngCases) if (A.looksLikeEmail(e)) bad.push('不安全的 email 被接受：' + JSON.stringify(e));
    bad.length ? fail('email 格式檢查有漏', bad.join('；')) : ok('email 只收安全的 ASCII 字元（擋 <script>、引號、全形字、連續句點）');
  }

  // -------------------------------------------------------------------------
  // 9) 遊客與登入的額度必須不同，而且登入的比較多
  // -------------------------------------------------------------------------
  {
    (A.FREE_DAILY_LINES_GUEST > 0 && A.FREE_DAILY_LINES > A.FREE_DAILY_LINES_GUEST)
      ? ok(`遊客 ${A.FREE_DAILY_LINES_GUEST} 句 < 登入 ${A.FREE_DAILY_LINES} 句（登入要有具體好處）`)
      : fail('遊客與登入的額度沒有差別', `遊客 ${A.FREE_DAILY_LINES_GUEST} / 登入 ${A.FREE_DAILY_LINES}`);
  }

  // -------------------------------------------------------------------------
  // 10) 靜態斷言：比對一定要用時間安全的方式
  //
  // ⚠️ 這一項**沒有可觀測的行為**——`===` 與 safeEqual 的結果完全一樣，
  //    差別只在回應時間。所以只能用靜態斷言釘住，我不假裝測得到時序。
  // ⚠️ 比對在 AuthGuard 的 verify 裡（2026-10-02 起）。
  // -------------------------------------------------------------------------
  {
    const body = (src.match(/async verify\(b, now\) \{[\s\S]*?\n  \}/) || [''])[0];
    body && /safeEqual\(/.test(body) && !/e\.h\s*===|===\s*e\.h/.test(body)
      ? ok('驗證碼比對用 safeEqual（`===` 的回應時間會洩漏對了幾位）')
      : fail('驗證碼比對沒有用時間安全的方式（或找不到 AuthGuard.verify）');
  }

  // -------------------------------------------------------------------------
  // 11) 工作階段：竄改、舊格式、撤銷、登出所有裝置
  // -------------------------------------------------------------------------
  {
    const env = newEnv();
    const bad = [];
    const s = await A.issueSession(env, 'em123abc', 'w');
    const v = await A.verifySession(env, s.token, { strict: true });
    if (!v || v.sub !== 'em123abc') bad.push('正常的權杖驗不過');
    const t = s.token.slice(0, -2) + (s.token.slice(-2) === 'AA' ? 'BB' : 'AA');
    if (await A.verifySession(env, t)) bad.push('改過簽章的權杖被接受');
    // v1 格式（沒有 sid、不能撤銷）一律不收
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const v1 = `em123abc.${exp}.${await A.hmac('test-secret', 'sess:em123abc.' + exp)}`;
    if (await A.verifySession(env, v1)) bad.push('舊格式（不能撤銷）的權杖仍然被接受');
    // 單一撤銷
    await A.authCall(env, { op: 'revoke', sid: s.sid, exp: s.exp });
    if (await A.verifySession(env, s.token, { strict: true })) bad.push('登出（撤銷）之後權杖仍然有效');
    if (!(await A.verifySession(env, s.token))) bad.push('非 strict 的路徑也應該只驗簽章（翻譯那條路不打 DO）');
    // 登出所有裝置：之前簽的全部作廢，之後簽的照常
    const x1 = await A.issueSession(env, 'em123abc', 'x');
    advance(2);
    await A.authCall(env, { op: 'revokeAll', ah: await A.authSubHash(env, 'em123abc') });
    advance(2);
    const x2 = await A.issueSession(env, 'em123abc', 'x');
    if (await A.verifySession(env, x1.token, { strict: true })) bad.push('登出所有裝置之後，之前簽的權杖仍然有效');
    if (!(await A.verifySession(env, x2.token, { strict: true }))) bad.push('登出所有裝置之後重新登入的權杖被誤擋');
    // AuthGuard 不在時 strict 一律擋（fail closed）
    if (await A.verifySession({ TOKEN_SECRET: 'test-secret' }, x2.token, { strict: true })) bad.push('AuthGuard 不在時 strict 驗證卻放行');
    // 效期：網站 14 天、擴充功能 30 天
    const w = await A.issueSession(env, 'u', 'w');
    const x = await A.issueSession(env, 'u', 'x');
    if (Math.round((w.exp - w.iat) / 86400) !== 14 || Math.round((x.exp - x.iat) / 86400) !== 30) bad.push('效期不是 網站 14 天／擴充功能 30 天');
    bad.length ? fail('工作階段', bad.join('；'))
      : ok('權杖改簽章或舊格式一律擋；登出立即作廢；登出所有裝置作廢之前簽的全部；AuthGuard 不在時 fail closed');
  }

  // -------------------------------------------------------------------------
  // 12) Turnstile（機器人驗證）：沒設定時放行；設定後 success、action、網域都要對
  // -------------------------------------------------------------------------
  {
    const bad = [];
    if (!(await A.turnstileOk({}, '', '1.1.1.1', 'login'))) bad.push('沒設定 TURNSTILE_SECRET 時應該放行（未啟用）');
    const env = { TURNSTILE_SECRET: 'sec', TURNSTILE_HOSTNAMES: 'pitlingo.com' };
    siteverify = { success: true, action: 'login', hostname: 'pitlingo.com' };
    if (!(await A.turnstileOk(env, 'tok', '1.1.1.1', 'login'))) bad.push('正確的 token 被擋');
    if (await A.turnstileOk(env, '', '1.1.1.1', 'login')) bad.push('沒帶 token 卻放行');
    siteverify = { success: true, action: 'signup', hostname: 'pitlingo.com' };
    if (await A.turnstileOk(env, 'tok', '1.1.1.1', 'login')) bad.push('action 不對卻放行（別的表單的 token 拿來用）');
    siteverify = { success: true, action: 'login', hostname: 'evil.example' };
    if (await A.turnstileOk(env, 'tok', '1.1.1.1', 'login')) bad.push('網域不對卻放行');
    siteverify = { success: false };
    if (await A.turnstileOk(env, 'tok', '1.1.1.1', 'login')) bad.push('success: false 卻放行');
    siteverify = null;
    if (await A.turnstileOk(env, 'tok', '1.1.1.1', 'login')) bad.push('siteverify 連不上時放行（應該 fail closed）');
    bad.length ? fail('Turnstile 驗證', bad.join('；'))
      : ok('Turnstile：未設定時不啟用；設定後 success／action／網域都要對，連不上一律擋');
  }

  Date.now = realNow;
  console.log('');
  if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
  console.log('✅ Email 驗證碼登入與工作階段全部正確');
})();
