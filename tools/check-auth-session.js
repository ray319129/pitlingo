#!/usr/bin/env node
/**
 * 網站登入工作階段的路由層實測（2026-10-02）。
 *
 * check-auth-email 驗的是函式；這支用**真的 Request／Response** 走完整條路由，
 * 驗那些只有在 HTTP 層才看得到的東西——它們全都是「拿掉也不會壞，只會變得可以被攻破」：
 *
 *   · 權杖只在 HttpOnly cookie 裡，回應內容沒有它（XSS 偷不走）
 *   · cookie 是 __Host-、Secure、SameSite=Strict、Path=/、沒有 Domain
 *   · 用 cookie 驗證的寫入請求，Origin 不是我們的網站就擋（CSRF）
 *   · 允許帶 cookie 的 CORS 只開在帳號那幾支，其他端點不開
 *   · 登出之後，舊的 cookie 在伺服器端就失效（不是只刪掉本機那一份）
 *   · 擴充功能拿到的是另一枚權杖：網站登出不影響它，「登出所有裝置」才會
 *   · 舊格式（不能撤銷）的權杖一律擋
 *
 * 用法：node tools/check-auth-session.js
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
// 這支要走完整的 fetch 入口（含網站 CORS 的包裝），所以保留 default export 的物件
src = src.replace(/export default \{/, 'this.__worker = {');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

const mails = [];
const sandbox = {
  crypto: require('crypto').webcrypto,
  TextEncoder, TextDecoder, btoa, atob, Uint8Array, Uint32Array, URLSearchParams, AbortSignal,
  Request, Response, Headers, URL,
  console, Date, Math, JSON, Map, Set, Promise, RegExp, Error,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
  fetch: async (url, init) => {
    if (String(url).includes('resend.com')) {
      const b = JSON.parse(init.body);
      mails.push({ to: b.to[0], subject: b.subject, html: b.html });
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }
    throw new Error('未預期的網路呼叫：' + url);
  },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { AuthGuard, issueSession, hmac };', ctx);
const W = sandbox.__worker;
const A = sandbox.__api;

function fakeKV() {
  const store = new Map();
  const meta = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, o) { store.set(k, v); meta.set(k, (o && o.metadata) || {}); },
    async delete(k) { store.delete(k); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix || '')).map((name) => ({ name, metadata: meta.get(name) || {} })), list_complete: true };
    },
  };
}
function fakeAuthNS() {
  const m = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const storage = {
    async get(k) { return clone(m.get(k)); },
    async put(k, v) { m.set(k, clone(v)); },
    async delete(k) { for (const x of [].concat(k)) m.delete(x); },
    async list() { return new Map(m); },
    async getAlarm() { return 1; },
    async setAlarm() {},
  };
  const guard = new A.AuthGuard({ storage }, {});
  let chain = Promise.resolve();
  const stub = {
    fetch(url, init) {
      const p = chain.then(() => guard.fetch({ json: async () => JSON.parse(init.body) }));
      chain = p.catch(() => {});
      return p;
    },
  };
  return { idFromName: () => 'auth-v1', get: () => stub };
}

const env = { SUBS: fakeKV(), AUTH: fakeAuthNS(), TOKEN_SECRET: 'route-secret', RESEND_API_KEY: 're_x', MAIL_FROM: 'x <a@b.c>' };
const SITE = 'https://pitlingo.com';
const call = (p, { method = 'GET', body, origin = SITE, cookie, bearer, ip = '203.0.113.5', token } = {}) => {
  const h = { 'content-type': 'application/json', 'cf-connecting-ip': ip };
  if (origin) h.origin = origin;
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = 'Bearer ' + bearer;
  if (token) h['x-client-token'] = token;
  return W.fetch(new Request('https://api.pitlingo.com' + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
};
const cookieOf = (res) => {
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(/(__Host-pl_sess=[^;]*)/);
  return { header: sc, pair: m ? m[1] : '' };
};
const codeOf = () => (mails[mails.length - 1].html.match(/>(\d{6})<\/div>/) || [])[1];

async function emailLogin(email, ip) {
  await call('/v1/auth/email/start', { method: 'POST', body: { email }, ip });
  const res = await call('/v1/auth/email/verify', { method: 'POST', body: { email, code: codeOf() }, ip });
  return { res, body: await res.clone().json(), cookie: cookieOf(res) };
}

(async () => {
  // 1) 登入：權杖只在 cookie，旗標要齊
  let ck = '';
  {
    const bad = [];
    const { res, body, cookie } = await emailLogin('route@example.com', '203.0.113.5');
    if (res.status !== 200) bad.push('登入失敗：HTTP ' + res.status + ' ' + JSON.stringify(body));
    if ('token' in body) bad.push('回應內容裡有 token —— 前端拿得到就代表 XSS 也拿得到');
    if (/[A-Za-z0-9_-]{20,}\.\d+\.\d+\.[A-Za-z0-9_-]{20,}/.test(JSON.stringify(body))) bad.push('回應內容裡看得到權杖形狀的字串');
    const h = cookie.header;
    for (const [re, label] of [[/^__Host-pl_sess=/, '__Host- 前綴'], [/;\s*HttpOnly/i, 'HttpOnly'], [/;\s*Secure/i, 'Secure'],
      [/;\s*SameSite=Strict/i, 'SameSite=Strict'], [/;\s*Path=\//i, 'Path=/'], [/;\s*Max-Age=\d+/i, 'Max-Age']]) {
      if (!re.test(h)) bad.push('cookie 少了 ' + label + '：' + h.replace(/=([^;]{12})[^;]*/, '=$1…'));
    }
    if (/;\s*Domain=/i.test(h)) bad.push('cookie 帶了 Domain（__Host- 不允許，也會讓子網域讀得到）');
    const age = Number((h.match(/Max-Age=(\d+)/i) || [])[1]);
    if (Math.round(age / 86400) !== 14) bad.push('網站 cookie 的效期不是 14 天：' + age);
    if (res.headers.get('access-control-allow-credentials') !== 'true') bad.push('登入回應沒有 Access-Control-Allow-Credentials（瀏覽器會丟掉 cookie）');
    ck = cookie.pair;
    bad.length ? fail('登入回應', bad.join('；'))
      : ok('登入後權杖只在 cookie（__Host-、HttpOnly、Secure、SameSite=Strict、Path=/、14 天），回應內容沒有權杖');
  }

  // 2) 用 cookie 讀帳號；跨站寫入被擋
  {
    const bad = [];
    const me = await call('/v1/account/me', { cookie: ck });
    if (me.status !== 200) bad.push('帶 cookie 讀帳號失敗：HTTP ' + me.status);
    const evil = await call('/v1/account/claim', { method: 'POST', body: { licenseKey: 'PL-XXXX-XXXX-XXXX' }, cookie: ck, origin: 'https://evil.example' });
    if (evil.status !== 403) bad.push('別的網站帶著 cookie 送寫入請求沒有被擋：HTTP ' + evil.status);
    const noOrigin = await call('/v1/account/claim', { method: 'POST', body: { licenseKey: 'PL-XXXX-XXXX-XXXX' }, cookie: ck, origin: '' });
    if (noOrigin.status !== 403) bad.push('沒有 Origin 的 cookie 寫入請求沒有被擋：HTTP ' + noOrigin.status);
    const mine = await call('/v1/account/claim', { method: 'POST', body: { licenseKey: 'PL-XXXX-XXXX-XXXX' }, cookie: ck });
    if (mine.status === 403) bad.push('自己網站的寫入請求被誤擋');
    bad.length ? fail('cookie 驗證與 CSRF', bad.join('；'))
      : ok('cookie 讀得到帳號；用 cookie 的寫入請求，Origin 不是 pitlingo.com（或沒有）一律擋');
  }

  // 3) CORS：只有帳號那幾支允許帶 cookie
  {
    const bad = [];
    const pre = await W.fetch(new Request('https://api.pitlingo.com/v1/account/me', { method: 'OPTIONS', headers: { origin: SITE } }), env);
    if (pre.headers.get('access-control-allow-credentials') !== 'true') bad.push('帳號端點的預檢沒有允許 credentials');
    const plans = await W.fetch(new Request('https://api.pitlingo.com/v1/plans', { method: 'OPTIONS', headers: { origin: SITE } }), env);
    if (plans.headers.get('access-control-allow-credentials')) bad.push('方案端點也允許帶 cookie（不需要，多開一個就多一個入口）');
    const evil = await W.fetch(new Request('https://api.pitlingo.com/v1/account/me', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env);
    if (evil.headers.get('access-control-allow-origin') === 'https://evil.example') bad.push('別的網站的預檢被放行');
    bad.length ? fail('CORS', bad.join('；')) : ok('允許帶 cookie 的 CORS 只開在帳號端點、只對 pitlingo.com');
  }

  // 4) 擴充功能配對：拿到另一枚權杖；網站登出不影響它；登出所有裝置才會
  {
    const bad = [];
    const nonce = 'n'.repeat(10) + 'ABCDEFGHIJ1234567890';
    // 配對要先由擴充功能登記（拿確認碼），網站輸入確認碼，只有登記的那個安裝取得回（security-audit #1）
    const iid = 'abcdef12-1111-4111-8111-000000000001';
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const itok = `${iid}.${exp}.${await A.hmac(env.TOKEN_SECRET, iid + '.' + exp)}`;
    const st = await (await call('/v1/auth/link/start', { method: 'POST', body: { nonce }, token: itok, origin: '' })).json();
    if (!st.code) bad.push('登記配對沒有拿到確認碼');
    const lc = await call('/v1/auth/link/claim', { method: 'POST', body: { nonce, code: st.code }, cookie: ck });
    if (lc.status !== 200) bad.push('配對失敗：HTTP ' + lc.status);
    const got = await (await call('/v1/auth/link?nonce=' + nonce, { origin: '', token: itok })).json();
    const ext = got.token || '';
    if (!/\.x[A-Za-z0-9_-]{20,}\./.test(ext)) bad.push('擴充功能拿到的不是 x 種類的權杖');
    // 網站登出
    const lo = await call('/v1/auth/logout', { method: 'POST', body: {}, cookie: ck });
    if (!/Max-Age=0/i.test(lo.headers.get('set-cookie') || '')) bad.push('登出沒有清掉 cookie');
    const after = await call('/v1/account/me', { cookie: ck });
    if (after.status !== 401) bad.push('登出之後舊 cookie 仍然有效（偷到的 cookie 登出也沒用）：HTTP ' + after.status);
    const extStill = await call('/v1/account/me', { bearer: ext, origin: '' });
    if (extStill.status !== 200) bad.push('網站登出把擴充功能也登出了（應該只有「登出所有裝置」才會）');
    // 登出所有裝置
    // ⚠️ 先推過 60 秒冷卻再登入。第一版沒推：要不到新碼、拿舊碼登入失敗，接著在「沒登入」
    //    的狀態下按登出所有裝置（冪等地回 200）——測試看起來在驗撤銷，其實什麼都沒驗到。
    const realNow = Date.now;
    Date.now = () => realNow() + 120000;
    const again = await emailLogin('route@example.com', '203.0.113.6');
    if (again.res.status !== 200) bad.push('第二次登入失敗（後面的驗證就沒有意義）：HTTP ' + again.res.status);
    Date.now = () => realNow() + 122000;
    const all = await call('/v1/auth/logout', { method: 'POST', body: { all: true }, cookie: again.cookie.pair });
    if (all.status !== 200) bad.push('登出所有裝置失敗：HTTP ' + all.status);
    const extGone = await call('/v1/account/me', { bearer: ext, origin: '' });
    if (extGone.status !== 401) bad.push('登出所有裝置之後擴充功能的權杖仍然有效');
    bad.length ? fail('撤銷', bad.join('；'))
      : ok('登出立即在伺服器端作廢 cookie；擴充功能是另一枚權杖，只有「登出所有裝置」會一起作廢');
  }

  // 5) 舊格式權杖（v1，不能撤銷）一律擋
  {
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const sub = 'em' + 'a'.repeat(32);
    const v1 = `${sub}.${exp}.${await A.hmac('route-secret', `sess:${sub}.${exp}`)}`;
    const r = await call('/v1/account/me', { bearer: v1, origin: '' });
    r.status === 401 ? ok('舊格式的權杖（沒有 sid、不能撤銷）一律擋')
      : fail('舊格式的權杖仍然被接受', 'HTTP ' + r.status);
  }

  // 6) 前端「帶 cookie」的端點必須正好是後端「允許帶 cookie」的那幾支
  //
  // ⚠️ 2026-10-02 上線後實測踩到：account.js 對所有請求都帶 cookie（含 /v1/plans），
  //    而後端只對帳號端點開放帶 cookie 的 CORS → 瀏覽器擋掉 /v1/plans 的回應，
  //    帳號頁顯示「連不上伺服器」、Google 登入按鈕整個不見。這支前面的測試全是綠的——
  //    它們只測後端，看不到前端送了什麼。
  {
    const bad = [];
    const be = readBackend();
    const credBlock = (be.match(/const SITE_CRED_PATHS = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || '';
    const credSet = new Set([...credBlock.matchAll(/'(\/v1\/[^']+)'/g)].map((m) => m[1]));
    if (!credSet.size) bad.push('找不到後端的 SITE_CRED_PATHS');
    const acc = fs.readFileSync(path.join(root, 'legal/account.js'), 'utf8');
    const credRe = acc.match(/var CRED = (\/.*\/);/);
    if (!credRe) bad.push('account.js 找不到 CRED（決定哪些請求帶 cookie 的規則）');
    else {
      // eslint-disable-next-line no-eval
      const re = eval(credRe[1]);
      const paths = [...new Set([...acc.matchAll(/api\('(\/v1\/[^'?]+)/g)].map((m) => m[1]))];
      for (const p of paths) {
        if (re.test(p) && !credSet.has(p)) bad.push(`account.js 對 ${p} 帶 cookie，但後端沒有對它開放（瀏覽器會擋掉回應）`);
        if (!re.test(p) && credSet.has(p)) bad.push(`account.js 對 ${p} 沒帶 cookie，但它需要登入`);
      }
      if (!paths.includes('/v1/plans') || re.test('/v1/plans')) bad.push('account.js 對 /v1/plans 的處理不對（它不可以帶 cookie）');
    }
    const le = fs.readFileSync(path.join(root, 'legal/login-email.js'), 'utf8');
    for (const m of le.matchAll(/fetch\(API \+ '(\/v1\/[^']+)', \{[^}]*credentials: 'include'/g)) {
      if (!credSet.has(m[1])) bad.push(`login-email.js 對 ${m[1]} 帶 cookie，但後端沒有對它開放`);
    }
    bad.length ? fail('前端帶 cookie 的端點與後端不一致', bad.join('；'))
      : ok('前端只對帳號與登入端點帶 cookie，正好是後端開放帶 cookie 的那幾支（/v1/plans 不帶）');
  }

  console.log('');
  if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
  console.log('✅ 網站登入工作階段全部正確');
})().catch((e) => { console.log('❌ 例外：' + (e && e.stack || e)); process.exit(1); });
