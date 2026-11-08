#!/usr/bin/env node
/**
 * 系統寄出的信（2026-09-17）。
 *
 * 走真的流程：結帳 → 綠界付款通知（正式金鑰簽章）→ 攔下送往 Resend 的那封信，檢查內容。
 *
 * 會默默壞掉的地方：
 *   1. **交易明細的總計不是實付金額。** 授權記錄的 `paid` 刻意只記通行證那幾列（給升級折抵用），
 *      信卻拿它當總計——「比賽週通行證＋代訂」的信列著兩個品項，總計只寫通行證的價錢。
 *      後台「寄樣本信」的賽季＋代訂那封就是這樣被發現的。
 *   2. 升級補差價的訂單：品項是牌價、實付較少，沒有折抵列時加總對不起來。
 *   3. 樣式與網站不一致（淺色底、舊的綠色）；沒有頭像；圖片擋掉時認不出寄件者。
 *   4. 授權碼跑進主旨；驗證碼信出現「直接登入」連結（被轉寄或預先點開就等於被登入）。
 *   5. 寄給管理員的彙報信還指向舊的後台路徑。
 *
 * 用法：node tools/check-mail.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { readBackend, withoutFreeSeason } = require('./lib/backend-src');

const root = path.join(__dirname, '..');
// 購買流程在「本賽季免費體驗」關掉的世界裡驗（withoutFreeSeason 的說明）
const src = "'use strict';\n" + withoutFreeSeason(readBackend())
  .replace(/export default \{[\s\S]*?\n\};\r?\n/, '')
  .replace(/\bexport\s+class\s+/g, 'class ');

const sent = [];
const zepto = [];
const failNext = new Set();   // 這些網址回 503（模擬那一家掛掉）
const sb = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
  Response, Request, Headers, FormData, Blob, URL, URLSearchParams,
  console, Date, Math, JSON, Map, Set, Promise, RegExp, Error, Array, Object, String, Number, Boolean,
  Uint8Array, ArrayBuffer, setTimeout, clearTimeout, parseInt, parseFloat, isNaN, isFinite, Intl,
  fetch: async (url, init) => {
    if (failNext.has(String(url))) return new Response('{"message":"boom"}', { status: 503 });
    if (String(url).endsWith('/v1.1/email')) { zepto.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) }); return new Response('{"message":"OK"}', { status: 200 }); }
    if (String(url) === 'https://api.resend.com/emails') {
      sent.push(JSON.parse(init.body));
      return new Response('{"id":"x"}', { status: 200 });
    }
    return new Response('{}', { status: 200 });   // 管理員 webhook 等：不在意
  },
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src + '\n;this.__api={handleCheckout,handlePaymentWebhook,ecpayMac,sendLicenseMail,sendOtpMail,'
  + 'buildDigest,gpList,gpSellable,gpId,PLANS,WEEKEND_PRICE,ADMIN_PAGE_PATH,'
  + 'handleReportSubmit,handleContactSubmit,handleReportList,flushStats,withMeter,KV_FREE_DAILY_PUTS,kvDailyCap,kvQuotaAlerts,sendMail,mailConfigured};', sb);
const A = sb.__api;

let failed = 0;
const expect = (c, m, d) => { if (c) console.log('✅ ' + m); else { failed++; console.log('❌ ' + m + (d !== undefined ? '：' + String(d).slice(0, 300) : '')); } };

const kv = new Map();
const env = {
  TOKEN_SECRET: 'test-secret-abc', ADMIN_TOKEN: 'admin-xyz', RESEND_API_KEY: 're_test', SITE_URL: 'https://pitlingo.com',
  ECPAY_MERCHANT_ID: '9990001', ECPAY_HASH_KEY: 'prodHashKey12345', ECPAY_HASH_IV: 'prodHashIV123456',
  SUBS: {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
    list: async (o) => ({ keys: [...kv.keys()].filter((k) => k.startsWith((o && o.prefix) || '')).map((name) => ({ name })), list_complete: true }),
  },
};

const NOW = Date.now();
const gps = A.gpList().filter((g) => A.gpSellable(g, NOW)).map((g) => A.gpId(g));
const money = (n) => 'NT$' + Number(n).toLocaleString('en-US');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

async function buy(items, email) {
  const r = await A.handleCheckout(new Request('https://x/', {
    method: 'POST', body: JSON.stringify({ items, email, agreed: true }),
  }), env, new URL('https://x/'));
  const d = JSON.parse(await r.text());
  if (!d.ok) throw new Error('結帳失敗：' + d.error);
  const p = {
    MerchantID: env.ECPAY_MERCHANT_ID, MerchantTradeNo: d.params.MerchantTradeNo, RtnCode: '1', RtnMsg: 'paid',
    TradeAmt: String(d.price), PaymentDate: '2026/09/17 12:00:00',
  };
  p.CheckMacValue = await A.ecpayMac(p, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);
  sent.length = 0;
  await A.handlePaymentWebhook({
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/x-www-form-urlencoded' : null) },
    formData: async () => new Map(Object.entries(p)),
  }, env);
  const mail = sent.find((m) => m.to && m.to[0] === email);
  const hit = [...kv.entries()].filter(([k]) => k.startsWith('lic:'))
    .find(([, v]) => JSON.parse(v).orderId === d.params.MerchantTradeNo);
  const lic = hit ? Object.assign(JSON.parse(hit[1]), { _key: hit[0].slice(4) }) : null;
  return { price: d.price, mail, lic };
}

function styleChecks(label, html) {
  expect(/bgcolor="#0e0e14"/.test(html) && /#15151e/.test(html) && /#e10600/.test(html),
    `${label}：深色底＋賽道紅，與網站同一套色票`);
  expect(!/#0a7c4a|color:#111|#f6f7f9|#fff4f4/.test(html), `${label}：沒有殘留舊版的淺色／綠色樣式`);
  expect(/<img src="https:\/\/pitlingo\.com\/mail-logo-96\.png"[^>]*alt="PitLingo"/.test(html),
    `${label}：標頭有頭像，圖片被擋時 alt 仍寫 PitLingo`);
  expect(fs.existsSync(path.join(root, 'legal/mail-logo-96.png')), `${label}：頭像檔 legal/mail-logo-96.png 存在（會隨網站部署）`);
  expect(/<meta name="color-scheme" content="dark">/.test(html), `${label}：宣告深色，客戶端不會再反轉一次`);
  expect(/不會以任何方式向您索取密碼/.test(html) && /請勿直接回覆/.test(html) && /\/privacy/.test(html),
    `${label}：頁尾的防釣魚、系統信、隱私權連結都還在`);
}

(async () => {
  // ---- 1. 比賽週通行證＋代訂：總計要是整張訂單的實付 ----
  {
    const { price, mail, lic } = await buy(
      [{ key: 'week', gp: gps[0], qty: 1 }, { key: 'svc_prem_1m_own', qty: 1, gifts: [gps[1]] }], 'mix@x.com');
    expect(mail, '通行證＋代訂：付款後有寄出授權信');
    if (mail) {
      const t = text(mail.html);
      const m = t.match(/總計 (NT\$[\d,]+)/);
      expect(m && m[1] === money(price), `通行證＋代訂：總計等於實付 ${money(price)}（不是只算通行證那列）`, m && m[1]);
      expect(lic && Number(lic.paid) < price, '通行證＋代訂：授權的 paid 仍只記通行證那幾列（升級折抵不能變大）',
        lic && lic.paid);
      expect(lic && Number(lic.orderTotal) === price, '授權記錄存了訂單總價 orderTotal（補寄信時用）', lic && lic.orderTotal);
      const pretty = lic ? lic._key.replace(/^PL/, '').match(/.{1,4}/g).join('-') : '@@';
      // 2026-10-30 起信裡完全不放授權碼（授權以帳號為準）——主旨與內文都不可以有
      expect(lic && !mail.subject.includes(lic._key) && !mail.subject.includes(pretty)
        && !mail.html.includes(pretty) && !mail.html.includes(lic._key) && /不需要輸入任何序號/.test(mail.html),
        '授權信不放授權碼（主旨與內文都沒有），並說明登入就自動啟用', mail.subject);
      expect(/href="https:\/\/pitlingo\.com\/account"/.test(mail.html), '授權信有「前往我的帳號」按鈕');
      styleChecks('授權信', mail.html);
    }
  }

  // ---- 1b. 比賽週＋下一賽季票：一封信列出兩組碼，各自標方案（2026-10-30，v5.81）----
  {
    const { price, mail } = await buy([{ key: 'week', gp: gps[3], qty: 1 }, { key: 'season_next', qty: 1 }], 'two@x.com');
    const keys = [...kv.entries()].filter(([k, v]) => k.startsWith('lic:') && JSON.parse(v).email === 'two@x.com')
      .map(([k, v]) => [k.slice(4).replace(/^PL/, '').match(/.{1,4}/g).join('-'), JSON.parse(v).plan]);
    const t = mail ? text(mail.html) : '';
    expect(mail && sent.filter((m) => m.to && m.to[0] === 'two@x.com').length === 1 && keys.length === 2
      && !keys.some(([k]) => mail.html.includes(k)) && /這張訂單包含/.test(t)
      && t.includes(A.PLANS.season_next.label) && /起生效/.test(t)
      && (t.match(/總計 (NT\$[\d,]+)/) || [])[1] === money(price),
    '比賽週＋下一賽季票：只寄一封信，兩份授權各自標方案與生效日（不放碼）、總計是整張訂單', t.slice(0, 400));
  }

  // ---- 2. 只買一張通行證（總計＝那一列）----
  {
    const { price, mail } = await buy([{ key: 'week', gp: gps[2], qty: 1 }], 'one@x.com');
    const m = mail && text(mail.html).match(/總計 (NT\$[\d,]+)/);
    expect(m && m[1] === money(price) && price === A.WEEKEND_PRICE, `單買通行證：總計 ${money(A.WEEKEND_PRICE)}`, m && m[1]);
  }

  // ---- 3. 補寄：舊授權沒有 orderTotal、升級補差價（實付比牌價少）----
  {
    sent.length = 0;
    const season = A.PLANS.season.price;
    await A.sendLicenseMail(env, 'old@x.com', 'PLOLDKEY0001', {
      orderId: 'OLD-1', createdAt: 1, expiresAt: 2, paid: season - 599,
      items: [{ key: 'season', qty: 1, unit: season }],
    }, { total: season - 599 });
    const t = sent[0] ? text(sent[0].html) : '';
    expect(/升級補差價折抵 −NT\$599/.test(t) && t.includes('總計 ' + money(season - 599)),
      '升級補差價：列出折抵 −NT$599，總計是實付金額（加總對得起來）', t.slice(t.indexOf('交易明細'), t.indexOf('交易明細') + 200));
    sent.length = 0;
    await A.sendLicenseMail(env, 'old@x.com', 'PLOLDKEY0002', {
      orderId: 'OLD-2', createdAt: 1, expiresAt: 2, paid: 599,
      items: [{ key: 'week', qty: 1, unit: 599 }, { key: 'svc_prem_1m_own', qty: 1, unit: 900 }],
    });
    const t2 = sent[0] ? text(sent[0].html) : '';
    expect(t2.includes('總計 NT$1,499') && !/折抵/.test(t2), '沒有 orderTotal 的舊授權：總計退回品項加總，不是 paid', t2.match(/總計 \S+/));
  }

  // ---- 4. 不含授權碼的訂單 ----
  {
    sent.length = 0;
    await A.sendLicenseMail(env, 'svc@x.com', '', {
      orderId: 'SVC-1', createdAt: 1, paid: 900, items: [{ key: 'svc_pro_5d', qty: 1, unit: 900 }],
    }, { noLicense: true });
    const h = sent[0] ? sent[0].html : '';
    expect(/不含字幕翻譯使用權/.test(h) && /不是漏寄/.test(h) && !/啟用方式/.test(h) && !/3 台裝置/.test(h),
      '不含字幕授權的訂單：說明這是正常的，不出現啟用步驟與裝置上限');
  }

  // ---- 5. 登入驗證碼 ----
  {
    sent.length = 0;
    await A.sendOtpMail(env, 'otp@x.com', '482913');
    const h = sent[0] ? sent[0].html : '';
    styleChecks('驗證碼信', h);
    // ⚠️ 2026-10-02 起**主旨不放驗證碼**（使用者：驗證碼不可以被 Log）。主旨會進郵件伺服器的
    //    日誌、鎖定畫面的通知；以前這一項要求碼「要」在主旨，現在反過來驗。
    expect(/482913/.test(h) && !/482913/.test(sent[0].subject), '驗證碼信：碼在信內、不在主旨');
    const hrefs = [...h.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
    const bad = hrefs.filter((u) => !/^https:\/\/pitlingo\.com(\/terms|\/privacy|\/contact)?$/.test(u));
    expect(!bad.length, '驗證碼信：沒有任何「直接登入」連結（只有首頁與頁尾連結）', bad.join(' '));
  }

  // ---- 6. 管理員彙報 ----
  // ---- KV 額度告警：快撞上限時要**當下**通知，不是等隔天的彙報 ----
  //
  // 9/24 撞到每日上限是事後跑腳本才看到的。撞牆之後所有寫入都被丟棄
  // （譯文進不了共用快取），而彙報一天只發一次——**最需要知道的那幾個小時完全沒人知道**。
  // ⚠️ 這是包在 try/catch 裡的副作用（鐵則 28）：放錯位置或條件寫反都不會報錯。
  {
    const menv = A.withMeter(env);
    const cap = A.KV_FREE_DAILY_PUTS;

    // 先做到七成。用 metered 的 env 寫，計數才會真的跑起來。
    sent.length = 0;
    for (let i = 0; i < Math.ceil(cap * 0.72); i++) await menv.SUBS.put('warm:' + i, '1');
    await A.flushStats(menv);
    const first = sent.filter((m) => /KV 寫入額度/.test(m.subject || ''));
    expect(first.length === 1 && /七成/.test(first[0].subject),
      'KV 用到七成時當下就發信通知', first.map((m) => m.subject).join('／') || '（一封都沒有）');

    // 同一天不可以一直重複發——旗標搭在同一筆記錄上，不另外寫 KV
    sent.length = 0;
    await menv.SUBS.put('warm:again', '1');
    await A.flushStats(menv);
    expect(sent.filter((m) => /KV 寫入額度/.test(m.subject || '')).length === 0,
      '同一個門檻同一天只發一次（不會變成每分鐘一封的雜訊）');

    // 再往上跨到九成，要再發一次（不同門檻是不同的事）
    sent.length = 0;
    for (let i = 0; i < Math.ceil(cap * 0.2); i++) await menv.SUBS.put('warm2:' + i, '1');
    await A.flushStats(menv);
    const second = sent.filter((m) => /KV 寫入額度/.test(m.subject || ''));
    expect(second.length === 1 && /九成/.test(second[0].subject),
      '跨到九成時再發一次（不同門檻分開算）', second.map((m) => m.subject).join('／') || '（一封都沒有）');
  }

  // ---- 付費方案（2026-11-01 Ray 決定升級）：告警線由 KV_DAILY_PUTS 決定 ----
  //   沒設＝免費方案 1,000（沒升級就改大，撞牆時告警不會響）；設了＝每日平均含量，文字不可以再說「寫入被丟棄」
  {
    const free = A.kvDailyCap({}), paid = A.kvDailyCap({ KV_DAILY_PUTS: '33000' }), bad = A.kvDailyCap({ KV_DAILY_PUTS: 'abc' });
    expect(free === 1000 && paid === 33000 && bad === 1000, 'KV_DAILY_PUTS 沒設或亂設＝免費方案 1,000；設了就照設定', `${free} ${paid} ${bad}`);
    const quiet = A.kvQuotaAlerts({ put: 990 }, 33000);
    const over = A.kvQuotaAlerts({ put: 34000 }, 33000);
    expect(quiet.length === 0 && over.length === 1 && !/丟棄|撞上限/.test(over[0].join('')) && /含量/.test(over[0].join('')),
      '付費方案：990 次不告警；超過每日含量時說「多付錢」而不是「寫入被丟棄」', JSON.stringify({ quiet, over }));
  }


  // ---- 網站「聯絡我們」：要寄通知信（2026-10-28 Ray 回報沒收到）----
  //   被 try/catch 包住的副作用（鐵則 28）：寄信失敗刻意吞掉，所以「根本沒寄」也不會報錯。
  {
    sent.length = 0;
    const r = await A.handleContactSubmit(new Request('https://x/v1/contact', {
      method: 'POST', body: JSON.stringify({ message: '我付款後沒有收到授權碼', contact: 'buyer@example.com', orderId: 'PL123' }),
    }), env);
    const d = JSON.parse(await r.text());
    const m = sent.find((x) => /網站聯絡表單/.test(x.subject || ''));
    const mt = m ? (m.html || m.text || '') : '';
    expect(d.ok && m && mt.includes('我付款後沒有收到授權碼') && mt.includes('buyer@example.com')
      && mt.includes(d.ticket) && kv.has('report:' + d.ticket),
      '網站「聯絡我們」送出後存成工單、並寄通知信（內容含訊息、聯絡方式、工單編號）',
      JSON.stringify({ ok: d.ok, subjects: sent.map((x) => x.subject) }));
    for (const k of [...kv.keys()]) if (k.startsWith('report:')) kv.delete(k);
  }

  // ---- 自動診斷回報：不寄信、不混進客訴清單、不進彙報的工單數 ----
  //
  // 為什麼在這支測：它是**被 try/catch 包住的副作用**（寄信失敗刻意吞掉），
  //   放錯位置或條件寫反都不會報錯（鐵則 28）。而自動回報一場直播十幾份，
  //   三件事任何一件沒做到都會讓真正的客訴被埋掉：
  //   信箱每 10 分鐘一封、清單前 200 筆被擠爆、彙報天天喊一個不可能歸零的數字（坑 #63）。
  {
    const auth = { ok: true, installId: 'iid-autodiag' };
    const post = (body) => A.handleReportSubmit(
      new Request('https://x/v1/report', { method: 'POST', body: JSON.stringify(body) }), env, auth);

    sent.length = 0;
    await post({ report: '════ 診斷報告 ════ 使用者按按鈕送的' });
    const mailedUser = sent.length;
    sent.length = 0;
    await post({ report: '════ 診斷報告 ════ 自動送的', auto: true, note: '自動回報（定期）第 1 份' });
    expect(mailedUser === 1 && sent.length === 0,
      '使用者按按鈕的診斷會寄信通知，自動回報不寄信',
      `使用者 ${mailedUser} 封 / 自動 ${sent.length} 封`);

    const keys = [...kv.keys()];
    expect(keys.filter((k) => k.startsWith('report:')).length === 1
      && keys.filter((k) => k.startsWith('areport:')).length === 1,
      '自動回報存在 areport: 前綴，和客訴分開',
      keys.filter((k) => /report:/.test(k)).join('、'));

    const rows = async (q) => JSON.parse(await (await A.handleReportList(
      env, new URL('https://x/v1/admin/reports' + q))).text()).rows;
    const normal = await rows('');
    const autos = await rows('?kind=auto');
    expect(normal.length === 1 && !normal[0].auto && autos.length === 1 && autos[0].auto === true,
      '後台的客訴清單不含自動回報，勾「看自動回報」才看得到',
      `客訴 ${normal.length} 筆 / 自動 ${autos.length} 筆`);

    const dg = await A.buildDigest(env);
    expect(/未處理工單 1 張/.test(dg.text || dg.html.replace(/<[^>]+>/g, ' ')),
      '每日彙報的未處理工單只算客訴（自動回報永遠不會被處理，算進去就是不可能歸零的警告）',
      (dg.html.replace(/<[^>]+>/g, ' ').match(/未處理工單 d+ 張/) || [])[0]);
  }

  {
    const d = await A.buildDigest(env);
    expect(d.html.includes('https://pitlingo.com' + A.ADMIN_PAGE_PATH) && A.ADMIN_PAGE_PATH === '/secret-pitstop',
      '每日彙報：後台連結指向 /secret-pitstop');
    expect(!/pitlingo\.com\/admin\b/.test(d.html), '每日彙報：沒有舊的 /admin 連結');
    styleChecks('每日彙報', d.html);
  }

  // ---- 寄信的備援順序（2026-11-03：主用 Cloudflare、備援 Resend 與 ZeptoMail）----
  {
    const cf = [];
    const cfOk = { send: async (m) => { cf.push(m); return { messageId: 'm1' }; } };
    const cfBad = { send: async () => { const e = new Error('daily limit'); e.code = 'E_DAILY_LIMIT_EXCEEDED'; throw e; } };
    const base = { MAIL_FROM: 'PitLingo <noreply@pitlingo.com>' };
    const msg = { to: ['a@example.com'], subject: 's', html: '<p>h</p>' };
    const reset = () => { cf.length = 0; sent.length = 0; zepto.length = 0; failNext.clear(); };

    reset();
    let r = await A.sendMail({ ...base, EMAIL: cfOk, RESEND_API_KEY: 're', ZEPTOMAIL_TOKEN: 'zt' }, msg);
    expect(r.ok && r.via === 'cloudflare' && cf.length === 1 && !sent.length && !zepto.length,
      '三家都設定時只走 Cloudflare，Resend 與 ZeptoMail 一封都沒寄', JSON.stringify(r));
    expect(cf[0] && cf[0].from && cf[0].from.email === 'noreply@pitlingo.com' && cf[0].from.name === 'PitLingo'
      && cf[0].to[0] === 'a@example.com' && cf[0].html === '<p>h</p>',
      'Cloudflare 的寄件者拆成 { email, name }（Workers API 的格式）', JSON.stringify(cf[0]));

    reset();
    r = await A.sendMail({ ...base, EMAIL: cfBad, RESEND_API_KEY: 're', ZEPTOMAIL_TOKEN: 'zt' }, msg);
    expect(r.ok && r.via === 'resend' && sent.length === 1 && !zepto.length && /E_DAILY_LIMIT_EXCEEDED/.test(r.tried[0]),
      'Cloudflare 丟錯（每日額度用完）→ 改走 Resend，ZeptoMail 沒動', JSON.stringify(r));

    reset(); failNext.add('https://api.resend.com/emails');
    r = await A.sendMail({ ...base, EMAIL: cfBad, RESEND_API_KEY: 're', ZEPTOMAIL_TOKEN: 'zt' }, msg);
    const z = zepto[0];
    expect(r.ok && r.via === 'zeptomail' && r.tried.length === 3, 'Cloudflare 與 Resend 都失敗 → ZeptoMail 寄出', JSON.stringify(r));
    expect(z && z.url === 'https://api.zeptomail.com/v1.1/email' && z.auth === 'Zoho-enczapikey zt'
      && z.body.from.address === 'noreply@pitlingo.com' && z.body.to[0].email_address.address === 'a@example.com'
      && z.body.htmlbody === '<p>h</p>' && z.body.subject === 's',
      'ZeptoMail 的請求格式照官方文件（Zoho-enczapikey、email_address、htmlbody）', JSON.stringify(z));

    reset();
    await A.sendMail({ ...base, ZEPTOMAIL_TOKEN: 'zt', ZEPTOMAIL_URL: 'https://api.zeptomail.eu/v1.1/email' }, msg);
    expect(zepto[0] && zepto[0].url === 'https://api.zeptomail.eu/v1.1/email', 'ZEPTOMAIL_URL 可以換區域');

    reset(); failNext.add('https://api.resend.com/emails'); failNext.add('https://api.zeptomail.com/v1.1/email');
    r = await A.sendMail({ ...base, EMAIL: cfBad, RESEND_API_KEY: 're', ZEPTOMAIL_TOKEN: 'zt' }, msg);
    expect(!r.ok && /^HTTP 503/.test(r.status) && r.tried.length === 3, '三家都失敗 → 回失敗，status 是最後一家的結果（呼叫端拿去記「信未寄出」）', JSON.stringify(r));

    reset();
    r = await A.sendMail({ ...base }, msg);
    expect(!r.ok && r.status === 'not_configured' && !A.mailConfigured(base), '一家都沒設定 → not_configured，不假裝寄出');
    expect(A.mailConfigured({ EMAIL: cfOk }) && A.mailConfigured({ ZEPTOMAIL_TOKEN: 'z' }) && A.mailConfigured({ RESEND_API_KEY: 'r' }),
      '任何一家有設定就算「可以寄信」（Email 登入、購買信不會因為只設了 Cloudflare 就關掉）');

    reset();
    const o = await A.sendOtpMail({ ...env, RESEND_API_KEY: undefined, EMAIL: cfOk }, 'b@example.com', '123456');
    expect(o.ok && cf.length === 1 && cf[0].subject === 'PitLingo 登入驗證碼' && !sent.length,
      '登入驗證碼信在只有 Cloudflare 時也寄得出去', JSON.stringify(o));
    reset();
  }

  console.log('');
  if (failed) { console.log(`❌ 系統信有 ${failed} 項未通過`); process.exit(1); }
  console.log('✅ 系統信的金額、樣式、連結都正確');
})().catch((e) => { console.log('❌ 執行失敗：' + (e && e.stack || e)); process.exit(1); });
