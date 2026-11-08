// ---------------------------------------------------------------------------
// 新裝置登入通知（2026-10-04，參考 Netflix「有新裝置正在使用您的帳戶」）
//
// 授權碼綁帳號之後，「誰登入了我的帳號」就等於「誰在用我的授權」。擁有者要在
// 第一時間知道，才來得及按「登出所有裝置」。
//
//   · 網站：每個瀏覽器一個 `__Host-pl_dev` cookie（隨機 18 bytes、HttpOnly、400 天），
//     **登出不清它**——它是「這台瀏覽器」，不是登入狀態
//   · 擴充功能：用 installId（配對取回權杖的那一刻）
//   · 帳號記錄 `devs` 只存「雜湊後的裝置識別碼＋粗略的裝置名稱＋時間」，最多 20 筆；
//     地點只在寄信當下由 Cloudflare 依 IP 估出來，**不儲存**（隱私權政策承諾不存 IP）
//
// ⚠️ 不寄的情況：剛建立的帳號、改版前就存在而第一次被記錄的帳號（沒有可比對的紀錄，
//    寄了等於對每個老使用者都喊一次「有新裝置」——訓練他們忽略這封信）。
// ⚠️ 「剛建立」看的是**帳號建立時間**（ACCOUNT_FRESH_SEC 內），不只看這一次是不是建立帳號的那一次。
//    新使用者的第一次登入幾乎都是兩步：從擴充功能按登入 → 網站上登入（建立帳號、記下網頁這台）→
//    配對成立（記下擴充功能這台）——第二步看起來就是「已有帳號、多了一台」，以前會立刻寄
//    「有新裝置登入」給剛註冊的人（2026-10-31 R19 FP2 Ray 實測）。第一次要收到的是歡迎信（sendWelcomeMail）。
// ⚠️ 每個帳號每天最多 10 封、全站每天 30 封：寄信額度與授權碼信共用（見 OTP_GLOBAL_DAILY_DEFAULT）。
// ---------------------------------------------------------------------------
const DEVICE_COOKIE = '__Host-pl_dev';
const DEVICE_MAX = 20;
const ACCOUNT_FRESH_SEC = 30 * 60;   // 帳號建立後這段時間內新增的裝置不寄「新裝置」通知（同一次註冊的後續步驟）

function deviceIdFrom(request) {
  const ck = request.headers.get('cookie') || '';
  const m = ck.match(new RegExp('(?:^|;\\s*)' + DEVICE_COOKIE + '=([A-Za-z0-9_-]{16,64})(?:;|$)'));
  return m ? m[1] : '';
}

function deviceCookie(id) {
  return `${DEVICE_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${400 * 86400}`;
}

/** 「Windows Chrome - 網頁瀏覽器」／「PitLingo 擴充功能（Windows Chrome）」。只看 User-Agent。 */
function deviceLabel(request, kind) {
  const ua = request.headers.get('user-agent') || '';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS' : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
      : /Linux/.test(ua) ? 'Linux' : '未知系統';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '瀏覽器';
  return kind === 'ext' ? `PitLingo 擴充功能（${os} ${br}）` : `${os} ${br} - 網頁瀏覽器`;
}

/** 「Taichung，台灣」。Cloudflare 依 IP 估的，可能不準；拿不到就說拿不到。 */
function placeLabel(request) {
  const cf = request.cf || {};
  let country = String(cf.country || '');
  try { if (country) country = new Intl.DisplayNames(['zh-TW'], { type: 'region' }).of(country) || country; } catch (e) { /* 保留國碼 */ }
  const city = String(cf.city || cf.region || '');
  return [city, country].filter(Boolean).join('，') || '無法判斷';
}

/**
 * 記下這次登入的裝置；是新裝置就寄通知。回傳 `{ isNew, mailed }`（測試用）。
 * @param kind  'web'（網站）或 'ext'（擴充功能）
 */
async function noteLoginDevice(env, request, acc0, kind, devRaw, created) {
  if (!devRaw || !acc0 || !acc0.sub) return { isNew: false, mailed: false };
  const h = (await hmac(tokenSecret(env) || 'x', `dev:${kind}:${devRaw}`)).slice(0, 24);
  // 重讀一次再寫：別蓋掉這幾毫秒內別處寫進帳號的東西（例如認領新增的信箱）——KV 沒有 CAS（鐵則 16）
  const acc = (await readGoogleAccount(env, acc0.sub)) || acc0;
  const had = Array.isArray(acc.devs);
  const list = had ? acc.devs : [];
  const hit = list.find((d) => d.h === h);
  if (hit) {
    // 認得的裝置：一週更新一次時間就好（不必每次登入都寫 KV）
    if (nowSec() - (Number(hit.at) || 0) > 7 * 86400) {
      hit.at = nowSec();
      await env.SUBS.put(acctgKey(acc.sub), JSON.stringify(acc));
    }
    return { isNew: false, mailed: false };
  }
  const label = deviceLabel(request, kind);
  acc.devs = list.concat({ h, k: kind, at: nowSec(), d: label }).slice(-DEVICE_MAX);
  await env.SUBS.put(acctgKey(acc.sub), JSON.stringify(acc));
  if (created || !had) return { isNew: true, mailed: false };
  if (nowSec() - (Number(acc.createdAt) || 0) < ACCOUNT_FRESH_SEC) return { isNew: true, mailed: false };
  if (!mailConfigured(env) || !acc.email) return { isNew: true, mailed: false };
  if (await authLimited(env, 'newdev', acc.sub)) return { isNew: true, mailed: false };
  if (await authLimited(env, 'newdevall', 'all')) return { isNew: true, mailed: false };
  const sent = await sendNewDeviceMail(env, acc.email, { device: label, place: placeLabel(request), at: nowSec() });
  return { isNew: true, mailed: !!sent.ok };
}

/** 新裝置通知的標題與 HTML。文字可在後台改（MAIL_DEFS.newdevice），裝置／地點／時間是 {{details}} 區塊。 */
async function buildNewDeviceMail(env, to, info, ov) {
  const C = MAIL_C;
  const when = new Date(info.at * 1000).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const row = (k, v) => `<tr><td style="padding:10px 0 2px;color:${C.dim};font-size:13px">${k}</td></tr>`
    + `<tr><td style="padding:0 0 6px;color:${C.text};font-size:16px">${v}</td></tr>`;
  const details = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
    + `style="width:100%;border-collapse:collapse;font:15px/1.5 ${MAIL_FONT};margin-bottom:14px">`
    + row('裝置', esc(info.device))
    + row('地點', esc(info.place) + `<br><span style="font-size:13px;color:${C.dim}">（此地點可能不精確）</span>`)
    + row('時間', `${esc(when)}（台灣時間）`)
    + '</table>';
  const m = await composeMail(env, 'newdevice', { email: to }, ov, { details });
  return { subject: m.subject, html: mailShell(m.title, m.bodyHtml, {
    site: m.site, why: '這是帳號安全通知：您的 PitLingo 帳號在新的裝置上登入' }) };
}

async function sendNewDeviceMail(env, to, info) {
  try {
    const m = await buildNewDeviceMail(env, to, info);
    const r = await sendMail(env, { to: [to], subject: m.subject, html: m.html });
    return { ok: r.ok };
  } catch (e) {
    return { ok: false };
  }
}

/**
 * 歡迎信（2026-10-31，Ray：「第一次登入的帳號不用寄『有新裝置登入』，第一次要寄的是歡迎信（可包含推銷內容）」）。
 *
 * 帳號**建立的那一次**寄一封（Google 與 Email 驗證碼都走 loginResponse）。合併既有帳號、之後的登入都不寄。
 * ⚠️ 這封含推銷內容＝行銷用途：隱私權政策第三節寫明「建立帳號時寄一封歡迎信、之後不寄行銷信」。
 *    （2026-11-05 Ray 要求信裡不再寫「這是唯一一封……」那段；承諾仍在政策裡。）要改成會再寄的電子報，先改政策並加退訂。
 * ⚠️ 不寫價格、不寫 Team Radio、不推 VPN（網站行銷規則）；免費分鐘數讀 REMOTE_CONFIG，不寫死。
 * ⚠️ 寄信失敗絕不擋登入；每帳號一封（AuthGuard，並發的兩次建立也只寄一封）、全站每天上限（寄信額度與驗證碼共用）。
 */
/** 內容可以在後台「寄信內容」改（v5.94，25-mail-content.js）；沒改過就是 MAIL_DEFS.welcome 的預設 */
async function buildWelcomeMail(env, acc, ov) {
  const ft = REMOTE_CONFIG.freeTier || {};
  const m = await composeMail(env, 'welcome', { email: acc.email, mins: Math.round((Number(ft.seconds) || 900) / 60) }, ov);
  return { subject: m.subject, html: mailShell(m.title, m.bodyHtml, { site: m.site, why: '您剛剛建立了 PitLingo 帳號' }) };
}

async function sendWelcomeMail(env, acc) {
  if (!mailConfigured(env) || !acc || !acc.email || !acc.sub) return { ok: false, skipped: 'nokey' };
  if (await authLimited(env, 'welcome', acc.sub)) return { ok: false, skipped: 'sent' };
  if (await authLimited(env, 'welcomeall', 'all')) return { ok: false, skipped: 'cap' };
  try {
    const m = await buildWelcomeMail(env, acc);
    const r = await sendMail(env, { to: [acc.email], subject: m.subject, html: m.html });
    return { ok: r.ok };
  } catch (e) {
    return { ok: false };
  }
}

/**
 * 用購買信箱認領（2026-10-30 起；以前是輸入授權碼）。
 *
 * ⚠️ **這條路不可以拿掉。** 購買時填的 email ≠ 登入的 email 一定會發生
 *    （用公司信箱買、用私人 Google 登入）。沒有這條路，那些人永遠拿不回自己買的東西。
 *
 * ⚠️ 真正的證明一直是**寄到購買信箱的驗證碼**——以前的授權碼只是「指出要認領哪個信箱」。
 *    授權改成以帳號為準、畫面不再顯示授權碼之後，直接讓使用者輸入那個信箱。
 *
 * ⚠️ **不可以變成「這個信箱有沒有買過」的探針。** 有沒有購買紀錄、是不是已經屬於別的帳號、
 *    是不是在冷卻中，第一步一律回同一句話（`needCode`），只是沒有東西可認領時**不寄信**。
 *    （/v1/quote 收信箱回折抵也是同一種洞，v5.81 已經關掉，見 security-audit run-2 #16。）
 *
 * ⚠️ 認領驗證碼與登入驗證碼**完全分開**：
 *    · 雜湊綁著「購買信箱＋要併入的帳號」——A 帳號要的碼，B 帳號拿去用對不上；
 *      登入的碼拿來認領、認領的碼拿去登入也都對不上
 *    · AuthGuard 裡用不同的信箱雜湊（otpc: 對 otpe:），計數、冷卻、鎖定各自獨立——
 *      **別人狂按認領，不會把擁有者的 Email 登入額度用光**（否則就是讓擁有者登不進來）
 *    · 每個購買信箱每天最多 3 封（比登入嚴），全站每日寄信上限共用（保護交易信的額度）
 */
async function claimByEmail(env, sub, emailRaw, ip) {
  const email = accountKey(emailRaw || '');
  if (!looksLikeEmail(email)) return { ok: false, error: '請輸入購買時填的信箱' };
  const acc = await readGoogleAccount(env, sub);
  if (!acc) return { ok: false, error: '請先登入' };
  // 自己帳號裡的信箱：不是探針（他本來就知道），直接說
  if (acc.emails.includes(email)) return { ok: true, already: true, email };
  const sentLike = { ok: true, needCode: true, to: email, ttlSec: OTP_TTL_SEC };

  if (!mailConfigured(env) || !env.AUTH) return { ok: false, error: '認領暫時無法使用，請到「聯絡我們」由客服處理', code: 'E65' };
  // 沒有可認領的、或那個信箱已經是別的帳號：照樣回「已寄出」，但不寄（見上方探針）
  if (!(await emailHasLicenses(env, email))) return sentLike;
  const owner = await env.SUBS.get(gsubKey(email));
  if (owner && owner !== sub) return sentLike;

  const code = otpNew();
  const r = await authCall(env, {
    op: 'start',
    eh: await claimEmailHash(env, email),
    ih: await authIpHash(env, ip),
    h: await claimCodeHash(env, email, sub, code),
    globalMax: Number(env.OTP_GLOBAL_DAILY) > 0 ? Number(env.OTP_GLOBAL_DAILY) : OTP_GLOBAL_DAILY_DEFAULT,
    hmax: CLAIM_OTP_HOURLY_MAX, dmax: CLAIM_OTP_DAILY_MAX,
  });
  if (!r) return { ok: false, error: '認領暫時無法使用，請稍後再試', code: 'E65' };
  if (!r.ok) {
    // 全站與 IP 的上限和這個信箱無關，可以照實說；信箱自己的冷卻／上限／鎖定只會發生在
    // 「真的寄過」的信箱上——照實說等於洩漏它有購買紀錄，所以回同一句話。
    if (r.reason === 'global') return { ok: false, error: '今天的驗證碼名額已滿，請明天再試', code: 'E66' };
    if (r.reason === 'ip') return { ok: false, error: '要求次數過多，請稍後再試', code: 'E66' };
    return sentLike;
  }
  const sent = await sendClaimMail(env, email, code, maskEmail(acc.email || ''));
  if (!sent.ok) return { ok: false, error: '寄信失敗，請稍後再試', code: 'E65' };
  return sentLike;
}

/** 這個信箱底下有沒有授權（licmail 索引非空）。 */
async function emailHasLicenses(env, email) {
  let keys = [];
  try { keys = JSON.parse((await env.SUBS.get(`licmail:${accountKey(email)}`)) || '[]'); } catch (e) { keys = []; }
  return Array.isArray(keys) && keys.length > 0;
}

/** 認領第二步：驗證寄到購買信箱的碼，對了才真的併入。 */
async function claimVerify(env, sub, emailRaw, codeRaw, ip) {
  const email = accountKey(emailRaw || '');
  const code = String(codeRaw || '').replace(/\D/g, '');
  const bad = { ok: false, error: '驗證碼不正確或已過期', code: 'E74' };
  if (!looksLikeEmail(email) || code.length !== 6) return bad;
  const acc = await readGoogleAccount(env, sub);
  if (!acc) return { ok: false, error: '請先登入' };
  if (!env.AUTH) return { ok: false, error: '認領暫時無法使用，請稍後再試', code: 'E65' };

  // 比對、計次、燒碼、單次使用都在 AuthGuard 裡原子地完成（與登入驗證碼同一套）
  const r = await authCall(env, {
    op: 'verify',
    eh: await claimEmailHash(env, email),
    ih: await authIpHash(env, ip),
    h: await claimCodeHash(env, email, sub, code),
  });
  if (!r) return { ok: false, error: '認領暫時無法使用，請稍後再試', code: 'E65' };
  if (!r.ok) {
    if (r.reason === 'locked') return { ok: false, error: '這個信箱的認領驗證碼猜錯太多次，請一小時後再試', code: 'E69' };
    if (r.reason === 'ip') return { ok: false, error: '嘗試次數過多，請稍後再試', code: 'E66' };
    if (r.reason === 'burned') return { ok: false, error: '嘗試次數過多，請重新要求驗證碼', code: 'E74' };
    return bad;
  }

  // 驗過了才併入。⚠️ 再查一次歸屬：等驗證碼的這幾分鐘裡，那個信箱可能已經被別的帳號登入／認領
  const fresh = (await readGoogleAccount(env, sub)) || acc;
  if (fresh.emails.includes(email)) return { ok: true, already: true, email };
  const owner = await env.SUBS.get(gsubKey(email));
  if (owner && owner !== sub) return { ok: false, error: '這個信箱已經屬於另一個帳號，請用那個信箱登入' };
  // ⚠️ 用帳號記錄自己的 sub，不是權杖上的 sub（security-audit 2026-10-05）：合併過的帳號，
  //    權杖可能還簽著舊的 email sub（透過別名查得到人）——寫回 acctg:<舊 sub> 會分出第二份帳號，
  //    認領進來的信箱掛在一份沒有人會讀的記錄上。
  const realSub = fresh.sub || sub;
  if (!owner) await env.SUBS.put(gsubKey(email), realSub);
  fresh.emails.push(email);
  await env.SUBS.put(acctgKey(realSub), JSON.stringify(fresh));
  return { ok: true, email };
}

/** 認領驗證碼的雜湊：綁購買信箱、要併入的帳號。前綴 `claim2:`，與登入的 `otp:`、舊版綁授權碼的 `claim:` 都不同。 */
async function claimCodeHash(env, email, sub, code) {
  return hmac(tokenSecret(env) || 'x', `claim2:${accountKey(email)}:${sub}:${code}`);
}
/** AuthGuard 裡認領用的信箱雜湊（與登入的 otpe: 分開，計數與鎖定各自獨立）。 */
async function claimEmailHash(env, email) {
  return (await hmac(tokenSecret(env) || 'x', 'otpc:' + accountKey(email))).slice(0, 32);
}

/**
 * 遮罩信箱：`ray@gmail.com` → `r***@g***.com`。
 * 給「只有授權碼的人」看的地方一律用這個——他不該因此知道擁有者的信箱。
 */
function maskEmail(e) {
  const s = String(e || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '***';
  const user = s.slice(0, at);
  const dom = s.slice(at + 1);
  const dot = dom.lastIndexOf('.');
  const host = dot > 0 ? dom.slice(0, dot) : dom;
  const tld = dot > 0 ? dom.slice(dot) : '';
  return user.slice(0, 1) + '***@' + host.slice(0, 1) + '***' + tld;
}

/**
 * 認領驗證碼信。文字可在後台改（MAIL_DEFS.claim），驗證碼是 {{code}} 區塊（必要）。
 * ⚠️ 這封信最可能被利用的方式是社交工程：「我是客服，請把收到的數字告訴我」。預設內容直接講破。
 * ⚠️ 主旨不放驗證碼（與登入信同一個理由）。
 */
async function buildClaimMail(env, code, requester, ov) {
  const m = await composeMail(env, 'claim', { requester, mins: Math.round(OTP_TTL_SEC / 60) }, ov,
    { code: mailCodeBox(esc(code), 34, 8) });
  return { subject: m.subject, html: mailShell(m.title, m.bodyHtml, {
    site: m.site, why: '有人要求把這個信箱的 PitLingo 購買併入另一個帳號' }) };
}

async function sendClaimMail(env, to, code, requester) {
  try {
    const m = await buildClaimMail(env, code, requester);
    const r = await sendMail(env, { to: [to], subject: m.subject, html: m.html });
    return { ok: r.ok };
  } catch (e) {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Email 驗證碼登入
//
// 為什麼要有：不是每個人都有 Google 帳號。而**加密碼是錯的解法**——
// 密碼會外洩、會被撞庫、會被重複使用，而「重設密碼」本身又是一個攻擊面。
// 寄一組一次性的碼，這三件事一件都不會發生。
//
// ⚠️ 這一段的每一條規則都是為了一個具體的攻擊寫的，拿掉任何一條都不會讓
//    登入壞掉，只會讓它變得可以被攻破——**和 Google 驗簽那一段一樣的形狀**。
// ---------------------------------------------------------------------------

/** 驗證碼效期。太長＝撿到信就能登入；太短＝使用者還沒收到信就過期。 */
const OTP_TTL_SEC = 600;
/** 同一組碼最多可以猜幾次（猜錯第 5 次就把整組燒掉）。 */
const OTP_MAX_TRIES = 5;
/** 同一個 email 幾秒內只能要一次碼（防止拿我們的伺服器去洗別人的信箱）。 */
const OTP_COOLDOWN_SEC = 60;
/** 同一個 email 每小時／每天最多寄幾次。 */
const OTP_HOURLY_MAX = 5;
const OTP_DAILY_MAX = 10;
/**
 * 同一個 email 24 小時內**跨所有碼**猜錯幾次就鎖、鎖多久。
 * ⚠️ 只有「每組碼 5 次」的話，換碼就能繼續猜：每小時 5 組 × 5 次＝25 次，
 *    一年下來中獎機率約 20%。加上這一道之後每天最多 15 次，一年約 0.5%。
 * ⚠️ 鎖的是「用驗證碼登入這個信箱」，**不是帳號**——Google 登入與授權碼照常可用。
 *    鎖太久會變成「別人可以故意把你鎖在門外」，所以只鎖 1 小時。
 */
const OTP_EMAIL_FAIL_MAX = 15;
const OTP_EMAIL_LOCK_SEC = 3600;
/** 同一個 IP：10 分鐘最多寄 3 封、每天 10 封；每小時最多猜錯 10 次。 */
const OTP_IP_10MIN_MAX = 3;
const OTP_IP_DAILY_MAX = 10;
const OTP_IP_FAIL_HOURLY_MAX = 10;
/** 同一個信箱、不同要求來源加起來的天花板（倍數）。見 AuthGuard.start。 */
const OTP_MAILBOX_SPREAD = 2;
/**
 * 全站每天最多寄幾封驗證碼信（UTC 日）。可用 wrangler var OTP_GLOBAL_DAILY 調整。
 * ⚠️ **這是在保護授權碼信。** 驗證碼信與授權碼、收據共用同一個 Resend 寄信額度；
 *    有人用幾千個 IP 狂要驗證碼的話，額度燒光的那一天**付了錢的人收不到授權碼**。
 *    預設 60 是以 Resend 免費方案每天 100 封估的，留 40 封給交易信。
 */
const OTP_GLOBAL_DAILY_DEFAULT = 60;
/**
 * 其中「陌生信箱」（從來沒登入過、也沒買過的）每天最多用掉幾封（2026-10-28 Ray：「如何防止大量 IP 洗信箱額度」）。
 * ⚠️ 單看全站上限的話，攻擊者用大量 IP（每個都過了 Turnstile）灌隨機信箱，60 封用完那天**所有人**都收不到驗證碼。
 *    攻擊者手上只有陌生信箱（他不知道誰是我們的客戶），所以把陌生信箱關在一個較小的池子：
 *    最壞情況是「當天新註冊的人收不到」，既有客戶照常登入。可用 wrangler var OTP_NEW_DAILY 調整。
 * ⚠️ 代價：池子滿的那一天，回應會因為「這個信箱是不是客戶」而不同（帳號列舉）——只在被攻擊時才看得出來，接受。
 */
const OTP_NEW_DAILY_DEFAULT = 30;

/** 這個信箱是不是我們認識的人（登入過或買過）。讀 KV 兩次，不寫。 */
async function otpKnownEmail(env, email) {
  try {
    if (await env.SUBS.get(gsubKey(email))) return true;
    const lic = await env.SUBS.get(`licmail:${accountKey(email)}`);
    return !!(lic && lic !== '[]');
  } catch (e) { return true; }   // 讀不到就當認識：寧可少擋，不要把客戶擋在門外
}
/** 其他登入相關端點的嚴格限額：[次數, 秒數]。 */
const AUTH_LIMITS = {
  google: [20, 600],       // 每 IP：Google 登入
  claim: [10, 3600],       // 每帳號：認領別的購買信箱（要驗證碼那一步也算）
  linkclaim: [10, 3600],   // 每帳號：配對擴充功能
  linkstart: [10, 3600],   // 每安裝：擴充功能發起配對
  linkcode: [5, 600],      // 每組配對碼：確認碼最多猜 5 次
  // ---- 裝置管理（2026-10-04；10-30 拿掉「只憑授權碼解除別台」與自助換發，原本的 deact／reissue 限額一起刪）----
  acctdev: [30, 3600],     // 每帳號：在「我的帳號」解除裝置（只是防呆）
  gift: [5, 86400],        // 每組授權碼：轉送附贈的比賽週每天最多 5 站（#19）
  newdev: [10, 86400],     // 每帳號：新裝置登入通知每天最多 10 封
  newdevall: [30, 86400],  // 全站：新裝置登入通知每天最多 30 封（寄信額度與授權碼信共用）
  welcome: [1, 400 * 86400],  // 每帳號：歡迎信只寄一封（2026-10-31）
  welcomeall: [40, 86400],    // 全站：歡迎信每天最多 40 封（寄信額度與驗證碼共用；超過的人只是沒收到歡迎信）
  admfail: [ADMIN_FAIL_MAX, ADMIN_LOCK_SEC], // 每來源：管理端失敗計數（鎖定看 authLimitPeek）
  admaudit: [200, 86400],  // 全站：管理端失敗的稽核紀錄每天最多寫 200 筆 KV
  // ---- 每次都寫 KV 的便宜端點（kvWriteBudgetOk）----
  complete: [60, 3600],    // 每安裝：/v1/complete（正常看片一支一次）
  activate: [30, 3600],    // 每安裝：/v1/license/activate（登入後自動接回也算一次）
  // ---- security-audit run-2（2026-10-06）----
  activatelic: [20, 86400],  // 每組授權碼：啟用真的寫 KV 的次數（installId 可以無限重新領，不能只靠上一條）
  f1reveal: [30, 3600],      // 每帳號：在「我的帳號」顯示 F1TV 密碼（每次都寫一筆 D1 事件；只是防呆）
  deactself: [10, 86400],    // 每組授權碼：解除自己這一台
  checkout: [20, 3600],      // 每 IP：匿名結帳（每次寫 2 筆 KV）
  checkoutall: [300, 86400], // 全站：結帳每天最多 300 次
  metricall: [150, 86400],   // 全站：/v1/metric 真的寫 KV 的次數
  slugall: [150, 86400],     // 全站：只為了補網址後綴而寫 bundle 的次數
  quote: [30, 600],          // 每 IP：帶升級折抵的報價（會查授權碼與購買信箱）
  reportmail: [3, 86400],    // 每安裝：問題回報觸發的通知信
  reportmailall: [30, 86400],// 全站：問題回報觸發的通知信（寄信額度與授權碼信共用）
  nosuball: [200, 86400],  // 全站：新的「沒有字幕」紀錄每天最多 200 筆
  contact: [5, 3600],      // 每 IP：網站聯絡表單
  contactall: [100, 86400],// 全站：網站聯絡表單
  contactmailall: [30, 86400],// 全站：網站聯絡表單的通知信（寄信額度與授權碼信共用）
  report: [20, 3600],      // 每安裝：擴充功能的問題回報
  reportall: [300, 86400], // 全站：擴充功能的問題回報
};

/** 認領用驗證碼：每個購買信箱每小時／每天最多寄幾封（比登入嚴，見 claimStart）。 */
const CLAIM_OTP_HOURLY_MAX = 3;
const CLAIM_OTP_DAILY_MAX = 3;

/**
 * email 格式。**只收安全的 ASCII 字元**（2026-10-02 收緊）。
 *
 * ⚠️ 以前是「不是空白、不是 @ 就好」，於是 `<script>@x.co`、帶引號、全形字元都過得了。
 *    email 會被寫進帳號名稱、信件、後台——放寬的格式等於把注入的機會留給每一個顯示它的地方。
 *    國際化網域（IDN）與特殊字元的信箱在台灣幾乎不存在，這個取捨划算。
 */
function looksLikeEmail(s) {
  const e = accountKey(s);
  return !!e && e.length <= 254 && !e.includes('..')
    && /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(e);
}

/**
 * 產生 6 位數驗證碼。
 *
 * ⚠️ **不可以用 `Math.random()`**——那是可預測的，攻擊者能算出下一組碼。
 * ⚠️ **也不可以直接對隨機數取 1000000 的餘數**：2^32 不是 1000000 的倍數，
 *    取餘數會讓前面幾個數字出現機率稍高（modulo bias）。用拒絕取樣。
 */
function otpNew() {
  const a = new Uint32Array(1);
  const LIMIT = Math.floor(4294967296 / 1000000) * 1000000;
  for (let i = 0; i < 24; i++) {
    crypto.getRandomValues(a);
    if (a[0] < LIMIT) return String(a[0] % 1000000).padStart(6, '0');
  }
  // 理論上跑不到這裡（每次成功機率 > 99.9%）。真的跑到就用最後一個值，
  // 偏差可以忽略——**但不可以直接丟例外讓登入整個壞掉**。
  return String(a[0] % 1000000).padStart(6, '0');
}

/**
 * 寄出驗證碼。
 *
 * ⚠️ **回傳值一律相同，不透露這個 email 有沒有帳號。** 否則這支端點會變成
 *    「查某人是不是我們的使用者」的查詢工具（帳號列舉）。
 *    我們本來就會在首次登入時建立帳號，所以這件事對功能沒有影響。
 *
 * ⚠️ **絕對不可以把驗證碼回傳給呼叫端**，即使是為了自己測試方便。
 *    那等於任何人輸入任何 email 就能登入。
 */
async function otpStart(env, emailRaw, ip) {
  const email = accountKey(emailRaw);
  if (!looksLikeEmail(email)) return { ok: false, error: 'email 格式不正確', code: 'E64' };
  if (!mailConfigured(env)) {
    // 沒設定寄信就明講。**不可以假裝寄出去了**——使用者會一直等一封
    // 永遠不會到的信，而你在後台看不到任何異常。
    return { ok: false, error: 'Email 登入尚未開放，請改用 Google 登入或授權碼', code: 'E65' };
  }
  // ⚠️ **沒有 AuthGuard 就不提供 Email 登入**（fail closed）。退回 KV 的話，
  //    次數上限與單次使用都會因為最終一致而失效——那正是這次要修的東西。
  if (!env.AUTH) return { ok: false, error: 'Email 登入暫時無法使用，請改用 Google 登入或授權碼', code: 'E65' };

  const code = otpNew();
  const secret = tokenSecret(env) || 'x';
  // ⚠️ **只存雜湊，不存驗證碼本身**，而且雜湊把 email 綁進去：拿 A 信箱的碼
  //    去登 B 信箱永遠對不上。AuthGuard 裡的 email 與 IP 也都只有雜湊——
  //    儲存外流時拿不到驗證碼、信箱或 IP。
  const r = await authCall(env, {
    op: 'start',
    eh: await otpEmailHash(env, email),
    ih: await authIpHash(env, ip),
    h: await hmac(secret, `otp:${email}:${code}`),
    globalMax: Number(env.OTP_GLOBAL_DAILY) > 0 ? Number(env.OTP_GLOBAL_DAILY) : OTP_GLOBAL_DAILY_DEFAULT,
    isNew: !(await otpKnownEmail(env, email)),
    newMax: Number(env.OTP_NEW_DAILY) > 0 ? Number(env.OTP_NEW_DAILY) : OTP_NEW_DAILY_DEFAULT,
  });
  if (!r) return { ok: false, error: 'Email 登入暫時無法使用，請改用 Google 登入或授權碼', code: 'E65' };
  if (!r.ok) {
    // ⚠️ 訊息只依「這個信箱的寄送狀態」而定，與它有沒有帳號無關（帳號列舉）。
    if (r.reason === 'cooldown') return { ok: false, error: `請稍候 ${r.retry || OTP_COOLDOWN_SEC} 秒再試`, code: 'E66', retry: r.retry };
    if (r.reason === 'locked') return { ok: false, error: '這個信箱的驗證碼猜錯太多次，請一小時後再試，或改用 Google 登入', code: 'E69' };
    if (r.reason === 'global') return { ok: false, error: '今天的 Email 登入名額已滿，請改用 Google 登入或明天再試', code: 'E66' };
    return { ok: false, error: '要求次數過多，請稍後再試', code: 'E66', retry: r.retry };
  }

  const sent = await sendOtpMail(env, email, code);
  if (!sent.ok) return { ok: false, error: '寄信失敗，請稍後再試', code: 'E65' };
  return { ok: true, ttlSec: OTP_TTL_SEC };
}

/** AuthGuard 用的信箱雜湊。**不可以和驗證碼的雜湊共用前綴**（那是兩種東西）。 */
async function otpEmailHash(env, email) {
  return (await hmac(tokenSecret(env) || 'x', 'otpe:' + accountKey(email))).slice(0, 32);
}
/** IP 雜湊。與 rateLimited 同一套規則：隱私權政策承諾原始 IP 不寫入任何儲存。 */
async function authIpHash(env, ip) {
  return (await hmac(tokenSecret(env) || 'x', 'rl:' + String(ip || ''))).slice(0, 16);
}

/**
 * 登入驗證碼信。文字可在後台改（MAIL_DEFS.otp），驗證碼是 {{code}} 區塊（必要，只能在內文）。
 * ⚠️ 信裡**刻意不放「按這裡直接登入」的連結**。那種連結被轉寄或被
 *    郵件閘道預先點開就等於帳號被登入，而使用者完全不會察覺。
 * ⚠️ **主旨不放驗證碼**（2026-10-02 改，原本是放的）。主旨會出現在郵件伺服器與垃圾信過濾器的日誌、
 *    手機鎖定畫面的通知、共用電腦的收件匣列表。後台也擋 {{code}} 放在標題（mailContentProblems）。
 */
async function buildOtpMail(env, code, ov) {
  const m = await composeMail(env, 'otp', { mins: Math.round(OTP_TTL_SEC / 60) }, ov,
    { code: mailCodeBox(esc(code), 34, 8) });
  return { subject: m.subject, html: mailShell(m.title, m.bodyHtml, {
    site: m.site, why: '有人（可能是您）要求以這個信箱登入 PitLingo' }) };
}

async function sendOtpMail(env, to, code, subjectTag) {
  try {
    const m = await buildOtpMail(env, code);
    const r = await sendMail(env, { to: [to], subject: (subjectTag || ((s) => s))(m.subject), html: m.html });
    return { ok: r.ok };
  } catch (e) {
    return { ok: false };
  }
}

/**
 * 驗證並登入。
 *
 * ⚠️ **比對一定要用 safeEqual（時間安全）。** 用 `===` 比較字串，
 *    回應時間會隨著「前幾位對了幾個」而變化，那足以讓人一位一位猜出來。
 *
 * ⚠️ **猜錯要計次，而且用完就燒掉整組碼**，不是只擋這一次。
 *    沒有上限的話，六位數字用程式猜平均 50 萬次就中。
 */
async function otpVerify(env, emailRaw, codeRaw, ip) {
  const email = accountKey(emailRaw);
  const code = String(codeRaw || '').replace(/\D/g, '');
  if (!looksLikeEmail(email) || code.length !== 6) {
    return { ok: false, error: '驗證碼不正確', code: 'E67' };
  }
  if (!env.AUTH) return { ok: false, error: 'Email 登入暫時無法使用', code: 'E65' };
  // ⚠️ 比對、計次、燒碼、單次使用**全部在 AuthGuard 裡一次做完**（見那裡的說明）。
  //    在 Worker 這邊讀出來比、再寫回去，就又回到「讀→比→寫」的競爭——
  //    同時送 50 個猜測會有 50 個都讀到「猜了 0 次」。
  const r = await authCall(env, {
    op: 'verify',
    eh: await otpEmailHash(env, email),
    ih: await authIpHash(env, ip),
    h: await hmac(tokenSecret(env) || 'x', `otp:${email}:${code}`),
  });
  if (!r) return { ok: false, error: 'Email 登入暫時無法使用', code: 'E65' };
  if (!r.ok) {
    // ⚠️ 「沒有這組碼」「過期」「碼錯了」回同一句話——分開講等於告訴攻擊者
    //    哪些 email 正在登入中。只有「鎖住」要明講，否則使用者會一直試一直錯。
    if (r.reason === 'locked') return { ok: false, error: '這個信箱的驗證碼猜錯太多次，請一小時後再試，或改用 Google 登入', code: 'E69' };
    if (r.reason === 'ip') return { ok: false, error: '嘗試次數過多，請稍後再試', code: 'E66' };
    if (r.reason === 'burned') return { ok: false, error: '嘗試次數過多，請重新要求驗證碼', code: 'E67' };
    return { ok: false, error: '驗證碼不正確或已過期', code: 'E67' };
  }
  return { ok: true, email };
}

