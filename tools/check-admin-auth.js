#!/usr/bin/env node
/**
 * 後台防護的實測。
 *
 * 為什麼需要：這一整組的失敗**兩個方向都是災難，而且都不報錯**——
 *   寫鬆了：什麼碼都收，第二把鎖等於沒有，而後台看起來一切正常
 *   寫緊了：正確的碼被拒絕，**你連去關掉它的後台都進不去**
 *
 * TOTP 用 RFC 6238 附錄 B 的官方測試向量驗，不用自己想的例子——
 * 自己想的例子只能證明「實作跟我想的一樣」，證明不了「跟手機上的
 * Google Authenticator 一樣」，而後者才是真正要對得起來的東西。
 *
 * 用法：node tools/check-admin-auth.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const vm = require('vm');
const root = path.join(__dirname, '..');

const errors = [];
const ok = (label) => console.log('✅ ' + label);
const fail = (label, detail) => {
  errors.push(label + (detail ? '：' + detail : ''));
  console.log('❌ ' + label + (detail ? '：' + detail : ''));
};

// ⚠️ 嚴格模式載入（坑 #37）
let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

const sandbox = {
  crypto: require('crypto').webcrypto,
  TextEncoder, TextDecoder, btoa, atob, Uint8Array,
  Response: class { constructor(b, i) { this.body = b; Object.assign(this, i); } },
  Request: class {},
  URL, console, Date, Math, JSON, Map, Set, Promise, RegExp, Error,
  Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite,
  fetch: async () => { throw new Error('測試不該打真的網路'); },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__api = { totpAt, totpOk, b32decode, adminGate, safeEqual,'
  + ' ADMIN_FAIL_MAX, ADMIN_LOCK_SEC, authHarvest, HARVEST_ROUTES, adminSessionIssue, adminSessionOk, adminSessionSig, ADMIN_SESSION_SEC };', ctx);
const A = sandbox.__api;

function fakeKV() {
  const store = new Map();
  const meta = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, o) { store.set(k, v); meta.set(k, (o && o.metadata) || {}); },
    async delete(k) { store.delete(k); meta.delete(k); },
    async list({ prefix }) {
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix || ''))
          .map((name) => ({ name, metadata: meta.get(name) || {} })),
        list_complete: true, cursor: null,
      };
    },
    _store: store, _meta: meta,
  };
}
const req = (headers) => ({ method: 'GET', headers: { get: (h) => headers[h.toLowerCase()] || null } });

(async () => {
  // -------------------------------------------------------------------------
  // 1) TOTP 必須與 RFC 6238 一字不差
  //
  // ⚠️ 秘密是 ASCII "12345678901234567890"，base32 後如下。
  //    對不上就代表使用者手機上的 Google Authenticator 會產出不同的碼——
  //    症狀是「密碼永遠錯」，而你查不出哪裡錯。
  // -------------------------------------------------------------------------
  {
    const SEC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const V = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
      [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
    const bad = [];
    for (const [t, want] of V) {
      const got = await A.totpAt(SEC, Math.floor(t / 30));
      if (got !== want) bad.push(`T=${t} → ${got}（應為 ${want}）`);
    }
    bad.length ? fail('TOTP 與 RFC 6238 不符', bad.join('；'))
      : ok(`TOTP 通過 RFC 6238 全部 ${V.length} 個官方測試向量`);

    const now = Math.floor(Date.now() / 30000);
    const cur = await A.totpAt(SEC, now);
    const prev = await A.totpAt(SEC, now - 1);
    const next = await A.totpAt(SEC, now + 1);
    const far = await A.totpAt(SEC, now + 5);
    (await A.totpOk(SEC, cur)) && (await A.totpOk(SEC, prev)) && (await A.totpOk(SEC, next))
      ? ok('前後各一個時間窗都收（手機與伺服器的時鐘一定有差）')
      : fail('時間窗太窄', '正確的碼會被拒絕，那會把人鎖在外面');
    !(await A.totpOk(SEC, far))
      ? ok('差太遠的碼會被拒絕')
      : fail('時間窗太寬', '差 5 個窗還收，等於沒有時效');
    !(await A.totpOk(SEC, '')) && !(await A.totpOk(SEC, '12345')) && !(await A.totpOk(SEC, 'abcdef'))
      ? ok('空值／長度不對／非數字都拒絕')
      : fail('TOTP 的格式檢查有漏');
  }

  // -------------------------------------------------------------------------
  // 2) 入口檢查的行為
  // -------------------------------------------------------------------------
  {
    const SEC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const P = '/v1/admin/stats';
    const bad = [];

    // (a) 沒設 ADMIN_TOKEN 的部署一律拒絕——不可以「沒設定就放行」
    let r = await A.adminGate({ SUBS: fakeKV() }, req({}), P, '1.1.1.1');
    if (r.ok) bad.push('沒設 ADMIN_TOKEN 卻放行');

    // (b) 錯的權杖
    const env1 = { SUBS: fakeKV(), ADMIN_TOKEN: 'right' };
    r = await A.adminGate(env1, req({ 'x-admin-token': 'wrong' }), P, '1.1.1.1');
    if (r.ok || r.status !== 401) bad.push('錯的權杖沒有回 401');

    // (c) 對的權杖、沒開第二把鎖 → 放行
    r = await A.adminGate({ SUBS: fakeKV(), ADMIN_TOKEN: 'right' },
      req({ 'x-admin-token': 'right' }), P, '1.1.1.1');
    if (!r.ok) bad.push('對的權杖被擋下');

    // (d) 開了第二把鎖之後，**光有權杖不夠**。這是整個改動的重點：
    //     ADMIN_TOKEN 外流（貼進聊天、存進瀏覽器）時仍然進不來。
    const env2 = { SUBS: fakeKV(), ADMIN_TOKEN: 'right', ADMIN_TOTP_SECRET: SEC };
    r = await A.adminGate(env2, req({ 'x-admin-token': 'right' }), P, '1.1.1.1');
    if (r.ok) bad.push('設了 TOTP 卻只憑權杖就放行 —— 第二把鎖等於沒有');
    r = await A.adminGate(env2, req({ 'x-admin-token': 'right', 'x-admin-otp': '000000' }), P, '1.1.1.1');
    if (r.ok) bad.push('錯的動態碼被接受');
    const good = await A.totpAt(SEC, Math.floor(Date.now() / 30000));
    r = await A.adminGate({ SUBS: fakeKV(), ADMIN_TOKEN: 'right', ADMIN_TOTP_SECRET: SEC },
      req({ 'x-admin-token': 'right', 'x-admin-otp': good }), P, '1.1.1.1');
    if (!r.ok) bad.push('正確的權杖＋動態碼被擋下 —— 那會把你鎖在外面');

    // (e) IP 白名單
    const env3 = { SUBS: fakeKV(), ADMIN_TOKEN: 'right', ADMIN_IPS: '9.9.9.9, 8.8.8.8' };
    r = await A.adminGate(env3, req({ 'x-admin-token': 'right' }), P, '1.1.1.1');
    if (r.ok || r.status !== 403) bad.push('白名單外的來源沒有被擋');
    r = await A.adminGate({ SUBS: fakeKV(), ADMIN_TOKEN: 'right', ADMIN_IPS: '9.9.9.9, 8.8.8.8' },
      req({ 'x-admin-token': 'right' }), P, '8.8.8.8');
    if (!r.ok) bad.push('白名單內的來源被擋');

    // (f) 失敗鎖定。**要在權杖驗證之前擋**——被鎖住的來源連試都不該能試。
    const kv = fakeKV();
    const env4 = { SUBS: kv, ADMIN_TOKEN: 'right' };
    for (let i = 0; i < A.ADMIN_FAIL_MAX; i++) {
      await A.adminGate(env4, req({ 'x-admin-token': 'nope' }), P, '2.2.2.2');
    }
    r = await A.adminGate(env4, req({ 'x-admin-token': 'right' }), P, '2.2.2.2');
    if (r.ok || r.status !== 429) bad.push(`連續失敗 ${A.ADMIN_FAIL_MAX} 次後沒有鎖定（拿到 ${r.status}）`);
    // 另一個來源不可以被連坐
    r = await A.adminGate(env4, req({ 'x-admin-token': 'right' }), P, '3.3.3.3');
    if (!r.ok) bad.push('別的來源被連坐鎖定');

    // (g) 失敗一定要留下稽核紀錄——那是「有人在敲門」唯一看得見的地方
    const audits = [...kv._store.keys()].filter((k) => k.startsWith('audit:'));
    if (!audits.length) bad.push('失敗沒有留下稽核紀錄');
    const metas = audits.map((k) => kv._meta.get(k));
    if (!metas.some((m) => m && m.ok === false && m.r === 'token')) {
      bad.push('稽核紀錄沒有記下失敗原因');
    }
    // 來源只存雜湊，不可以出現 IP 原文
    if (JSON.stringify([...kv._store.values()]).includes('2.2.2.2')) {
      bad.push('稽核紀錄裡有 IP 原文 —— 隱私權政策承諾過只存雜湊');
    }

    bad.length
      ? fail('後台入口檢查有漏', bad.join('；'))
      : ok('入口檢查：權杖、第二把鎖、IP 白名單、失敗鎖定、稽核紀錄全部正確');
  }

  // -------------------------------------------------------------------------
  // 2b) 登入工作階段（2026-09-17）
  //
  // ⚠️ 原本每個請求都要帶動態碼，一組碼約 90 秒失效，而訂單輪詢每 45 秒一次——
  //    過期後每次輪詢都算失敗，8 次鎖 15 分鐘：**打開第二把鎖幾分鐘內就把自己鎖在外面。**
  //    現在登入時驗一次動態碼，之後帶工作階段。這裡驗「方便」沒有換掉「安全」。
  // -------------------------------------------------------------------------
  {
    const SEC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const bad = [];
    const kv = fakeKV();
    const env = { SUBS: kv, ADMIN_TOKEN: 'right', TOKEN_SECRET: 'ts', ADMIN_TOTP_SECRET: SEC };
    const code = await A.totpAt(SEC, Math.floor(Date.now() / 30000));

    let r = await A.adminGate(env, req({ 'x-admin-token': 'right', 'x-admin-otp': code }), '/v1/admin/login', '5.5.5.5');
    if (!r.ok) bad.push('正確的權杖＋動態碼登入失敗');
    const sess = (await A.adminSessionIssue(env, r.who)).session;
    const P = '/v1/admin/stats';

    // 輪詢一小時：60 次請求都不帶動態碼，不可以被擋、不可以累積成鎖定
    let blocked = 0;
    for (let i = 0; i < 60; i++) {
      const x = await A.adminGate(env, req({ 'x-admin-token': 'right', 'x-admin-session': sess }), P, '5.5.5.5');
      if (!x.ok) blocked++;
    }
    if (blocked) bad.push(`帶工作階段的請求被擋了 ${blocked}/60 次 —— 後台會把自己鎖在外面`);

    // 工作階段不能取代權杖
    r = await A.adminGate(env, req({ 'x-admin-token': 'wrong', 'x-admin-session': sess }), P, '5.5.5.5');
    if (r.ok) bad.push('只有工作階段、權杖錯誤卻放行');
    // 綁來源：被偷到別的地方用不了
    r = await A.adminGate(env, req({ 'x-admin-token': 'right', 'x-admin-session': sess }), P, '6.6.6.6');
    if (r.ok) bad.push('工作階段換一個來源也能用');
    // 登入本身一律要動態碼（不能拿工作階段無限續命）
    r = await A.adminGate(env, req({ 'x-admin-token': 'right', 'x-admin-session': sess }), '/v1/admin/login', '5.5.5.5');
    if (r.ok) bad.push('拿工作階段就能再登入一次（等於永不過期）');
    // 竄改到期時間
    const [, sig] = sess.split('.');
    const later = Math.floor(Date.now() / 1000) + 30 * 86400;
    r = await A.adminGate(env, req({ 'x-admin-token': 'right', 'x-admin-session': later + '.' + sig }), P, '5.5.5.5');
    if (r.ok) bad.push('改掉到期時間仍被接受');
    // 過期
    const past = Math.floor(Date.now() / 1000) - 5;
    const who = (await A.adminGate({ SUBS: fakeKV(), ADMIN_TOKEN: 'right' }, req({ 'x-admin-token': 'right' }), P, '5.5.5.5')).who;
    const expired = past + '.' + await A.adminSessionSig(env, past, who);
    r = await A.adminGate(env, req({ 'x-admin-token': 'right', 'x-admin-session': expired }), P, '5.5.5.5');
    if (r.ok) bad.push('過期的工作階段被接受');
    if (!r.ok && !/過期/.test(r.error)) bad.push('過期時沒有告訴使用者要重新登入：' + r.error);
    // 輪換權杖或動態碼金鑰 → 既有工作階段立刻失效
    r = await A.adminGate(Object.assign({}, env, { ADMIN_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' }),
      req({ 'x-admin-token': 'right', 'x-admin-session': sess }), P, '5.5.5.5');
    if (r.ok) bad.push('換掉 ADMIN_TOTP_SECRET 後舊的工作階段仍能用');
    const env5 = Object.assign({}, env, { ADMIN_TOKEN: 'rotated' });
    r = await A.adminGate(env5, req({ 'x-admin-token': 'rotated', 'x-admin-session': sess }), P, '5.5.5.5');
    if (r.ok) bad.push('輪換 ADMIN_TOKEN 後舊的工作階段仍能用');
    // 亂填
    for (const junk of ['', 'abc', '9999999999.x', sess + 'x']) {
      if (await A.adminSessionOk(env, junk, who)) bad.push('格式錯誤的工作階段被接受：' + junk);
    }

    bad.length
      ? fail('後台登入工作階段有漏', bad.join('；'))
      : ok('登入工作階段：輪詢一小時不被鎖、不能取代權杖、綁來源、不能續命、竄改／過期／輪換後失效');
  }

  // -------------------------------------------------------------------------
  // 3) 每一個管理端點都要走得到入口檢查
  //
  // ⚠️ 入口檢查是**一個 if**。日後有人把 admin 端點寫在那個 if 前面，
  //    或改了路徑前綴，整套防護會靜靜地被繞過。
  // -------------------------------------------------------------------------
  {
    // ⚠️ **只能看 handleRequest 之後的文字。**
    //    `routeAdmin` 的函式本體定義在檔案更前面，裡面滿是
    //    `path === '/v1/admin/…'`——拿整個檔案做文字比較會得出
    //    「入口檢查排在端點後面」這種**假警報**。
    //    （這支檢查的第一版就是這樣，我差點去「修」一段沒有壞的程式碼。）
    //    在 handleRequest 之內，文字順序才等於執行順序。
    const head = src.indexOf('const isAdmin = path.startsWith');
    const bad = [];
    if (head < 0) {
      bad.push('找不到 isAdmin 判斷');
    } else {
      const tail = src.slice(head);
      const gate = tail.indexOf('await adminGate(');
      const firstInline = tail.search(/path === '\/v1\/admin\//);
      const routeCall = tail.indexOf('routeAdmin(path, request, env, url)');
      if (gate < 0) bad.push('找不到 adminGate 呼叫');
      if (gate >= 0 && firstInline >= 0 && gate > firstInline) {
        bad.push('adminGate 排在第一個 admin 端點之後，等於沒有作用');
      }
      if (gate >= 0 && routeCall >= 0 && gate > routeCall) {
        bad.push('adminGate 排在 routeAdmin 之後，等於沒有作用');
      }
      // 縱深防禦：入口檢查是一個 if，它被繞過時端點自己還要擋得住。
      //   · routeAdmin 那一支：呼叫端驗一次（它的註解就寫著「權限已在外層驗過」）
      //   · handleRequest 裡直接寫的端點：每一個各自驗
      const inline = (tail.match(/path === '\/v1\/admin\//g) || []).length;
      // 收割端點用 authHarvest（管理員權杖，或只限那幾個端點的收割權杖），也算縱深防禦
      const auths = (tail.match(/authAdmin\(env, request\)|authHarvest\(env, request, path\)/g) || []).length;
      if (routeCall >= 0) {
        const before = tail.slice(Math.max(0, routeCall - 400), routeCall);
        if (!/authAdmin\(env, request\)/.test(before)) {
          bad.push('routeAdmin 的呼叫端沒有 authAdmin —— 那一支底下所有端點都沒有第二層');
        }
      }
      if (auths < inline) {
        bad.push(`handleRequest 裡有 ${inline} 個 admin 端點，卻只有 ${auths} 處 authAdmin`);
      }
      if (!bad.length) {
        ok(`入口檢查在所有 admin 端點之前；縱深防禦仍在（${inline} 個直寫端點各自驗、routeAdmin 由呼叫端驗）`);
      }
    }
    if (bad.length) fail('入口檢查的位置不對', bad.join('；'));
  }

  // -------------------------------------------------------------------------
  // 4) 所有「比對 ADMIN_TOKEN」的地方都要在入口檢查的範圍內
  //
  // ⚠️ 2026-09-17 發現：POST／DELETE /v1/config（推 killSwitch、改選擇器）不在 /v1/admin/ 底下，
  //    自己用 `!==` 比一次權杖就放行——動態碼、失敗鎖定、稽核全部不適用，
  //    上面第 3 項只看 /v1/admin/ 開頭的路徑，所以一直是綠的。
  // -------------------------------------------------------------------------
  {
    const bad = [];
    const handler = src.slice(src.indexOf('const isAdmin = path.startsWith'));
    // 直接讀 x-admin-token 的只能是 authAdmin 與 adminGate 本身
    const raw = [...src.matchAll(/headers\.get\('x-admin-token'\)/g)].map((m) => {
      const before = src.slice(0, m.index);
      const fn = before.match(/(?:async )?function (\w+)\([^)]*\)\s*\{(?![\s\S]*\nfunction |[\s\S]*\nasync function )/);
      return fn ? fn[1] : '?';
    });
    const outside = raw.filter((f) => f !== 'authAdmin' && f !== 'adminGate');
    if (outside.length) bad.push('這些地方自己讀 x-admin-token（繞過入口檢查、而且可能不是固定時間比對）：' + outside.join('、'));
    // 在 handleRequest 裡用 authAdmin 的每一個非 /v1/admin/ 端點，都要被 isAdmin 涵蓋
    const isAdminExpr = handler.slice(0, handler.indexOf(';'));
    const routes = [...handler.matchAll(/if \(path === '([^']+)' && request\.method === '(\w+)'\) \{\s*\n\s*if \(!(?:authAdmin\(env, request\)|authHarvest\(env, request, path\))\)/g)]
      .map((m) => ({ path: m[1], method: m[2] })).filter((r) => !r.path.startsWith('/v1/admin/'));
    for (const r of routes) {
      if (!(isAdminExpr.includes(`'${r.path}'`) && isAdminExpr.includes(`'${r.method}'`))) {
        bad.push(`${r.method} ${r.path} 要管理權限，卻不在 isAdmin 裡（沒有動態碼、鎖定、稽核）`);
      }
    }
    // 行為：開了動態碼之後，只有權杖推不了遠端設定
    const SEC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const env = { SUBS: fakeKV(), ADMIN_TOKEN: 'right', TOKEN_SECRET: 'ts', ADMIN_TOTP_SECRET: SEC };
    const g = await A.adminGate(env, { method: 'POST', headers: { get: (h) => (h.toLowerCase() === 'x-admin-token' ? 'right' : null) } }, '/v1/config', '7.7.7.7');
    if (g.ok) bad.push('adminGate 對 /v1/config 只憑權杖就放行');
    bad.length
      ? fail('有管理操作不在入口檢查裡', bad.join('；'))
      : ok(`所有管理權限檢查都在入口檢查裡（含 ${routes.length} 個不在 /v1/admin/ 底下的端點：${routes.map((r) => r.method + ' ' + r.path).join('、')}）`);
  }

  // -------------------------------------------------------------------------
  // 5) 收割權杖（HARVEST_TOKEN）：只開那幾個端點、不需要動態碼、失敗照樣鎖
  //
  // ⚠️ 沒有它的話，一打開動態碼 userscript 的自動收割就全部 401，
  //    而且每一次都算失敗——連後台一起鎖 15 分鐘。
  // -------------------------------------------------------------------------
  {
    const bad = [];
    const SEC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const mk = () => ({ SUBS: fakeKV(), ADMIN_TOKEN: 'admin-tok', TOKEN_SECRET: 'ts', ADMIN_TOTP_SECRET: SEC, HARVEST_TOKEN: 'harvest-tok' });
    const rq = (method, h) => ({ method, headers: { get: (k) => h[k.toLowerCase()] || null } });
    for (const route of A.HARVEST_ROUTES) {
      const [method, path] = route.split(' ');
      const env = mk();
      const g = await A.adminGate(env, rq(method, { 'x-harvest-token': 'harvest-tok' }), path, '8.8.4.4');
      if (!g.ok) bad.push(`收割權杖打不了 ${route}（開了動態碼之後自動收割會壞）：${g.error}`);
      if (!A.authHarvest(env, rq(method, { 'x-harvest-token': 'harvest-tok' }), path)) bad.push(`${route} 的縱深防禦不認收割權杖`);
      const adminOnly = await A.adminGate(env, rq(method, { 'x-admin-token': 'admin-tok' }), path, '8.8.4.5');
      if (adminOnly.ok) bad.push(`${route}：只有管理員權杖、沒有動態碼卻放行`);
    }
    for (const [method, path] of [['GET', '/v1/admin/stats'], ['POST', '/v1/admin/license/issue'], ['POST', '/v1/config'], ['DELETE', '/v1/config'], ['GET', '/v1/admin/orders']]) {
      const env = mk();
      const g = await A.adminGate(env, rq(method, { 'x-harvest-token': 'harvest-tok', 'x-admin-token': 'harvest-tok' }), path, '9.9.9.8');
      if (g.ok) bad.push(`收割權杖打得進 ${method} ${path}——它應該只能收割`);
      if (A.authHarvest(env, rq(method, { 'x-harvest-token': 'harvest-tok' }), path)) bad.push(`authHarvest 對 ${method} ${path} 放行`);
    }
    // 沒設 HARVEST_TOKEN 時，空的收割權杖標頭不可以被當成相符
    const noEnv = mk(); delete noEnv.HARVEST_TOKEN;
    if ((await A.adminGate(noEnv, rq('POST', { 'x-harvest-token': '' }), '/v1/subs', '9.9.9.7')).ok) bad.push('沒設 HARVEST_TOKEN 時空標頭被放行');
    // 猜收割權杖一樣會被鎖
    const lk = mk();
    for (let i = 0; i < A.ADMIN_FAIL_MAX; i++) await A.adminGate(lk, rq('POST', { 'x-harvest-token': 'guess' + i }), '/v1/subs', '6.6.6.1');
    const after = await A.adminGate(lk, rq('POST', { 'x-harvest-token': 'harvest-tok' }), '/v1/subs', '6.6.6.1');
    if (after.ok || after.status !== 429) bad.push('連續猜錯收割權杖沒有被鎖（拿到 ' + after.status + '）');
    // 寫入要留稽核，標明是收割權杖
    const au = mk();
    await A.adminGate(au, rq('POST', { 'x-harvest-token': 'harvest-tok' }), '/v1/subs', '6.6.6.2');
    const metas = [...au.SUBS._meta.values()];
    if (!metas.some((m) => m && m.ok === true && m.r === 'harvest')) bad.push('收割權杖的寫入沒有留下稽核紀錄');
    bad.length
      ? fail('收割權杖有漏', bad.join('；'))
      : ok(`收割權杖：${A.HARVEST_ROUTES.size} 個收割端點不需要動態碼；其他管理端點一律擋下；猜錯照樣鎖定；寫入留稽核`);
  }

  console.log('');
  if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
  console.log('✅ 後台防護全部正確');
})();
