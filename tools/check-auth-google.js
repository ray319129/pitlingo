#!/usr/bin/env node
/**
 * Google 一鍵登入的實測。
 *
 * ⚠️ **這是整個專案裡最不能只靠「看起來對」的一段。**
 *    驗簽少一項檢查，登入仍然完全正常——只是變成可以偽造。
 *    少 `aud` → 任何 Google 應用程式的 token 都能登入本站
 *    少 `iss` → 任何人自簽的 token 都能用
 *    少 `exp` → 撿到一枚舊 token 就能永久登入
 *    少 `email_verified` → 註冊一個宣稱是別人 email 的帳號就能接管
 *    `alg` 沒鎖 → `none` 讓簽章不必存在，`HS256` 讓公鑰變成 HMAC 金鑰
 *
 *    以上每一項單獨拿掉，**所有正常登入都還是會成功**。
 *
 * 做法：自己產一對真的 RSA 金鑰、自己簽 token、把 Google 的 JWKS 端點
 * 換成回傳我們的公鑰。這樣驗簽走的是真正的密碼學路徑，不是被繞過的假路徑。
 *
 * 用法：node tools/check-auth-google.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const vm = require('vm');
const root = path.join(__dirname, '..');
const webcrypto = require('crypto').webcrypto;

const errors = [];
const ok = (label) => console.log('✅ ' + label);
const fail = (label, detail) => {
  errors.push(label + (detail ? '：' + detail : ''));
  console.log('❌ ' + label + (detail ? '：' + detail : ''));
};

const CLIENT_ID = '123456789-test.apps.googleusercontent.com';
const KID = 'test-key-1';

let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

let jwksBody = null;
let fetchCalls = 0;
const sandbox = {
  crypto: webcrypto,
  TextEncoder, TextDecoder, btoa, atob, Uint8Array,
  Response: class { constructor(b, i) { this.body = b; Object.assign(this, i); } },
  Request: class {},
  URL, console, Date, Math, JSON, Map, Set, Promise, RegExp, Error,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite,
  fetch: async (url) => {
    fetchCalls++;
    if (String(url).includes('oauth2/v3/certs')) {
      return { ok: true, status: 200, json: async () => jwksBody };
    }
    throw new Error('測試不該打其他網路：' + url);
  },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { verifyGoogleIdToken, issueSession, verifySession,'
  + ' googleLogin, claimByEmail, readGoogleAccount, accountKey };', ctx);
const A = sandbox.__api;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o) => b64url(Buffer.from(JSON.stringify(o), 'utf8'));

function fakeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
    _store: store,
  };
}

(async () => {
  // 一對真的 RSA 金鑰。公鑰當成 Google 的 JWKS 端點回傳。
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const pub = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  jwksBody = { keys: [{ kty: 'RSA', n: pub.n, e: pub.e, alg: 'RS256', use: 'sig', kid: KID }] };

  const now = Math.floor(Date.now() / 1000);
  const basePayload = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1122334455',
    email: 'ray@example.com',
    email_verified: true,
    name: 'Ray',
    iat: now - 10,
    exp: now + 3600,
  };

  async function sign(payload, header) {
    const h = enc(Object.assign({ alg: 'RS256', kid: KID, typ: 'JWT' }, header || {}));
    const p = enc(payload);
    const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey,
      new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }

  const env = { GOOGLE_CLIENT_ID: CLIENT_ID, ADMIN_TOKEN: 'x', SUBS: fakeKV() };
  const tryVerify = async (t) => {
    try { return { ok: true, v: await A.verifyGoogleIdToken(env, t) }; }
    catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
  };

  // -------------------------------------------------------------------------
  // 1) 正常的 token 必須通過
  // -------------------------------------------------------------------------
  {
    const r = await tryVerify(await sign(basePayload));
    r.ok && r.v.sub === '1122334455' && r.v.email === 'ray@example.com'
      ? ok('正常的 Google token 通過，sub 與 email 都解得出來')
      : fail('正常的 token 被擋下', r.err || JSON.stringify(r.v));
  }

  // -------------------------------------------------------------------------
  // 2) 每一項缺失都必須被擋下
  //
  // ⚠️ 這幾個案例全部是**簽章正確的真 token**——差別只在內容。
  //    所以擋不擋得下來，完全取決於那四行檢查有沒有寫。
  // -------------------------------------------------------------------------
  {
    const CASES = [
      ['aud 是別的應用程式', Object.assign({}, basePayload, { aud: 'someone-else.apps.googleusercontent.com' })],
      ['iss 不是 Google', Object.assign({}, basePayload, { iss: 'https://evil.example.com' })],
      ['已過期', Object.assign({}, basePayload, { exp: now - 60 })],
      ['email 未驗證', Object.assign({}, basePayload, { email_verified: false })],
      ['沒有 email_verified 欄位', (() => { const p = Object.assign({}, basePayload); delete p.email_verified; return p; })()],
      ['沒有 sub', (() => { const p = Object.assign({}, basePayload); delete p.sub; return p; })()],
      ['iat 在未來很久', Object.assign({}, basePayload, { iat: now + 4000 })],
    ];
    const bad = [];
    for (const [name, payload] of CASES) {
      const r = await tryVerify(await sign(payload));
      if (r.ok) bad.push(name);
    }
    bad.length
      ? fail('簽章正確但內容有問題的 token 被放行', bad.join('、') + ' —— 每一項都等於可以登入成別人')
      : ok(`${CASES.length} 種內容造假的 token 全部被擋下（aud／iss／exp／email_verified／sub／iat）`);
  }

  // -------------------------------------------------------------------------
  // 3) JWT 的經典攻擊
  // -------------------------------------------------------------------------
  {
    const bad = [];

    // alg: none —— 簽章根本不存在
    const hNone = enc({ alg: 'none', kid: KID, typ: 'JWT' });
    const pNone = enc(basePayload);
    if ((await tryVerify(`${hNone}.${pNone}.`)).ok) bad.push('alg=none');

    // alg: HS256 —— 拿公開的公鑰當 HMAC 金鑰自己簽
    const hHs = enc({ alg: 'HS256', kid: KID, typ: 'JWT' });
    const fakeSig = b64url(require('crypto').createHmac('sha256', JSON.stringify(jwksBody.keys[0]))
      .update(`${hHs}.${pNone}`).digest());
    if ((await tryVerify(`${hHs}.${pNone}.${fakeSig}`)).ok) bad.push('alg=HS256');

    // 簽完之後竄改 payload
    const good = await sign(basePayload);
    const parts = good.split('.');
    const tampered = `${parts[0]}.${enc(Object.assign({}, basePayload, { sub: '9999999' }))}.${parts[2]}`;
    if ((await tryVerify(tampered)).ok) bad.push('竄改 payload');

    // 不認識的 kid（攻擊者自己的金鑰）
    const hBad = enc({ alg: 'RS256', kid: 'not-a-real-key', typ: 'JWT' });
    const sigBad = b64url(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey,
      new TextEncoder().encode(`${hBad}.${pNone}`)));
    if ((await tryVerify(`${hBad}.${pNone}.${sigBad}`)).ok) bad.push('未知的 kid');

    // 格式亂七八糟的
    for (const junk of ['', 'abc', 'a.b', 'a.b.c.d']) {
      if ((await tryVerify(junk)).ok) bad.push('格式錯誤仍放行：' + JSON.stringify(junk));
    }

    bad.length ? fail('JWT 經典攻擊沒有被擋下', bad.join('、'))
      : ok('alg=none／alg=HS256／竄改 payload／未知 kid／格式錯誤全部被擋下');

    // ⚠️ **上面那一組擋得下來，不代表 alg 有被鎖。**
    //    實測（回種驗證）：把 `header.alg !== 'RS256'` 那行拿掉，上面全部照樣通過——
    //    因為 RSA 驗簽本身就會讓 alg=none（空簽章）與 alg=HS256（HMAC 當 RSA 簽章）失敗。
    //    也就是說 alg 鎖是**縱深防禦**，它的價值在於「快速失敗」與
    //    「日後有人依 alg 選金鑰時不會選錯」，而那沒有可觀測的行為。
    //    沒有行為可測的東西，就用靜態斷言釘住——否則它會在某次重構裡靜靜消失。
    /RS256/.test(src) && /header\.alg\s*!==\s*'RS256'/.test(src)
      ? ok('alg 明確鎖定 RS256（縱深防禦，靜態斷言）')
      : fail('alg 沒有被明確鎖定', '目前靠 RSA 驗簽擋住，但少了快速失敗那一層');
  }

  // 沒設 GOOGLE_CLIENT_ID 的部署不可以「因為沒得比對所以放行」
  {
    try {
      await A.verifyGoogleIdToken({ SUBS: fakeKV() }, await sign(basePayload));
      fail('沒設 GOOGLE_CLIENT_ID 卻放行', '那等於任何 Google token 都能登入');
    } catch (e) { ok('沒設 GOOGLE_CLIENT_ID 時一律拒絕（不是預設放行）'); }
  }

  // -------------------------------------------------------------------------
  // 4) 工作階段權杖
  // -------------------------------------------------------------------------
  {
    const e2 = { TOKEN_SECRET: 'super-secret', SUBS: fakeKV() };
    const s = await A.issueSession(e2, 'sub-1');
    const bad = [];
    if (!(await A.verifySession(e2, s.token))) bad.push('自己發的權杖驗不過');
    if (!(await A.verifySession(e2, 'Bearer ' + s.token))) bad.push('帶 Bearer 前綴時驗不過');
    if (await A.verifySession(e2, s.token.slice(0, -2) + 'xx')) bad.push('簽章被改過仍然通過');
    if (await A.verifySession(e2, 'sub-2.' + (Math.floor(Date.now() / 1000) + 999) + '.deadbeef')) {
      bad.push('自己編的權杖通過了');
    }
    // 換一把 secret 就不該認得
    if (await A.verifySession({ TOKEN_SECRET: 'other', SUBS: fakeKV() }, s.token)) {
      bad.push('換了 TOKEN_SECRET 還認得舊權杖');
    }
    // 過期
    const expired = 'sub-1.' + (Math.floor(Date.now() / 1000) - 10);
    const sig = await (async () => {
      const k = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('super-secret'),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const b = await webcrypto.subtle.sign('HMAC', k, new TextEncoder().encode('sess:' + expired));
      return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
    })();
    if (await A.verifySession(e2, expired + '.' + sig)) bad.push('過期的權杖仍然通過');

    bad.length ? fail('工作階段權杖有問題', bad.join('、'))
      : ok('工作階段權杖：簽章、Bearer 前綴、竄改、換 secret、過期都正確');
  }

  // -------------------------------------------------------------------------
  // 5) 帳號認領
  //
  // ⚠️ **一個 email 只能被一個 Google 帳號認領。** 否則兩個人先後用同一個
  //    email 登入，後者會看到前者的訂單——那是資料外洩，不是功能缺陷。
  // -------------------------------------------------------------------------
  {
    const kv = fakeKV();
    const e3 = { TOKEN_SECRET: 's', SUBS: kv };
    const bad = [];

    const a1 = await A.googleLogin(e3, { sub: 'A', email: 'shared@example.com', name: 'A' });
    if (!a1.created) bad.push('第一次登入沒有建立帳號');
    if (!a1.acc.emails.includes('shared@example.com')) bad.push('首次登入沒有認領自己的已驗證 email');

    // 第二個 Google 帳號宣稱同一個 email
    const a2 = await A.googleLogin(e3, { sub: 'B', email: 'shared@example.com', name: 'B' });
    if (a2.acc.emails.includes('shared@example.com')) {
      bad.push('同一個 email 被第二個帳號認領 —— 那會讓 B 看到 A 的訂單');
    }

    // 重複登入不可以重複建立
    const a3 = await A.googleLogin(e3, { sub: 'A', email: 'shared@example.com', name: 'A' });
    if (a3.created) bad.push('既有帳號被當成新帳號重建');

    // email 改了：主鍵仍然是 sub，舊資料不可以不見
    const a4 = await A.googleLogin(e3, { sub: 'A', email: 'newname@example.com', name: 'A' });
    if (a4.created) bad.push('改了 email 就被當成新帳號 —— 購買紀錄會整個不見');
    if (!a4.acc.emails.includes('shared@example.com')) bad.push('改 email 後舊 email 被丟掉');

    // 認領一個沒有購買紀錄的信箱（2026-10-30 起認領用購買信箱）：第一步不可以直接併入
    const c1 = await A.claimByEmail(e3, 'A', 'nobody@example.com');
    const accA = await A.readGoogleAccount(e3, 'A');
    if (c1.already || (accA && accA.emails.includes('nobody@example.com'))) bad.push('沒有驗證碼就把別的信箱併進帳號');

    bad.length ? fail('帳號認領有問題', bad.join('、'))
      : ok('帳號認領：首次認領、email 不可重複佔用、改名不掉資料、沒驗證碼不能併入別的信箱');
  }

  // JWKS 要有快取，不可以每次登入都去抓
  {
    const before = fetchCalls;
    await tryVerify(await sign(basePayload));
    await tryVerify(await sign(basePayload));
    (fetchCalls - before) === 0
      ? ok('JWKS 有快取（連續驗證沒有再打 Google）')
      : fail('JWKS 沒有快取', `多打了 ${fetchCalls - before} 次，登入會變慢而且沒有必要`);
  }

  console.log('');
  if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
  console.log('✅ Google 登入全部正確');
})();
