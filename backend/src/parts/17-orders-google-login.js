// ---------------------------------------------------------------------------
// 訂單記錄
// ---------------------------------------------------------------------------
/**
 * 為什麼要獨立存一份訂單，而不是靠授權碼記錄？
 *
 * 因為**授權碼只在付款成功後才存在**。付款失敗、取號了沒去繳、
 * 使用者按到一半跑掉——這些在系統裡完全不留痕跡，
 * 於是後台看到的永遠只有「成功的那些」，而真正需要人去看的正是失敗的那些。
 *
 * 狀態機（只會往前，不會倒退）：
 *   created  → 已建立訂單，導向綠界了
 *   awaiting → ATM／超商已取號，等繳費
 *   paid     → 綠界的伺服器對伺服器通知確認收款，授權碼已發
 *   failed   → 綠界回報付款失敗
 *
 * ⚠️ **paid 是終點，任何東西都不准把它改回去。** 導回頁是使用者的瀏覽器送的，
 *    可以偽造；若允許它覆寫，別人就能把已付款的訂單標成失敗。
 */
const ORDER_TTL = 400 * 86400;
// refunded 排最後：綠界重送的付款通知（paid）不可以把已退款的訂單改回已付款
const ORDER_RANK = { created: 0, awaiting: 1, failed: 2, paid: 3, refunded: 4 };

function ordKey(no) { return `ord:${no}`; }

/**
 * 訂單的 metadata。後台列表**只讀 metadata、不逐筆 get**——
 * 一次 list 就把整張表撈回來，KV 操作數與訂單數無關。
 * KV 對 metadata 有 1024 bytes 上限，所以欄位名用單字母、字串都截短。
 */
function ordMeta(o) {
  return {
    s: o.status,
    at: o.at || 0,
    t: Number(o.price) || 0,
    e: String(o.email || '').slice(0, 60),
    l: String(o.summary || '').slice(0, 80),
    n: (o.services || []).some((x) => x && x.status !== 'done') ? 1 : 0,
    m: o.mailed ? 1 : 0,
  };
}

async function readOrder(env, no) {
  try { return JSON.parse((await env.SUBS.get(ordKey(no))) || 'null'); } catch (e) { return null; }
}

/**
 * 更新訂單。
 * ⚠️ 讀→改→寫在 KV 上沒有 CAS（坑 #24），但訂單是**單一訂單編號**的線性流程，
 *    競爭只會發生在「導回頁」與「webhook」同時到達時——
 *    用 ORDER_RANK 擋住降級就足夠：兩邊都寫，贏的一定是狀態較後面的那個。
 */
async function patchOrder(env, no, fields) {
  if (!env.SUBS || !no) return null;
  const o = (await readOrder(env, no)) || { no, at: nowSec(), status: 'created' };
  const f = Object.assign({}, fields);
  if (f.status && ORDER_RANK[f.status] < ORDER_RANK[o.status || 'created']) delete f.status;
  Object.assign(o, f, { updatedAt: nowSec() });
  invalidateOrderList();
  await env.SUBS.put(ordKey(no), JSON.stringify(o), {
    expirationTtl: ordTtl(o), metadata: ordMeta(o),
  });
  return o;
}

/**
 * 訂單保存多久。**沒付款的只留 30 天**（security-audit run-2 #3）：匿名的人每按一次結帳就是一筆，
 * 以前一律留 400 天，灌進來的垃圾訂單一年多都在後台清單與 list 額度裡。
 * 付款或退款之後的每一次更新都會把它改回 400 天（patchOrder 每次都重設 TTL）。
 */
function ordTtl(o) {
  return (o && (o.status === 'paid' || o.status === 'refunded')) ? ORDER_TTL : 30 * 86400;
}

/**
 * 帳號鍵。
 *
 * ⚠️ **這是日後導入帳號系統時唯一的接點，現在就必須釘死。**
 *
 * 目前沒有帳號、沒有密碼，使用者的身分就是**購買時填的 email**。
 * 那沒問題——授權碼本來就是綁人不綁機器。但要能無痛長成
 *
 *     Account
 *       ├── Purchases     ord:<訂單編號>     （已經有了）
 *       ├── Licenses      lic:<授權碼>       （已經有了）
 *       └── Entitlements  簽出去的通行證      （已經有了）
 *
 * 唯一的前提是：**每一筆訂單與每一組授權碼都必須帶著同一個正規化過的 email。**
 * 少一筆就是一筆日後接不回帳號的孤兒資料，而且不會報錯——
 * 只會在某個人登入後發現「我買的東西不見了」。
 *
 * 正規化規則刻意保守：只做 trim + 小寫。
 * **不做 Gmail 的點號與 +tag 摺疊**——那會把兩個在法律上不同的
 * 收件人視為同一個人，退款與爭議時說不清楚。
 */
function accountKey(email) {
  return String(email || '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Google 一鍵登入
//
// 使用者的決定：帳號系統用 Google 一鍵註冊／登入。設計在 CLAUDE.md
// 「日後導入 Google 一鍵登入」那一段，這裡是它的實作。
//
// ⚠️ **驗簽一定在後端。** 前端拿到的 ID token 是使用者可以換掉的東西，
//    前端「驗過了」等於沒驗——把 `credential` 換成自己簽的，
//    就能登入成任何人。
//
// ⚠️ **`sub` 才是主鍵，email 只是顯示欄位。** Google 的 email 會變
//    （改名、換網域、公司帳號轉移）。用 email 當主鍵的話，
//    使用者改名的那天就會變成另一個人，而他所有的購買紀錄都不見了。
//
// ⚠️ **`email_verified` 一定要驗。** 沒驗就等於「填什麼 email 就拿到
//    誰的授權」——那是接管別人的帳號，不是登入。
//
// ⚠️ **不在擴充功能裡跑 OAuth。** MV3 的 chrome.identity 會把流程綁在
//    Chrome 帳號上，Edge 與其他 Chromium 的行為不一致。做在網站上，
//    登入後仍然是拿授權碼貼進擴充功能——**擴充功能一行都不用改**。
// ---------------------------------------------------------------------------

/**
 * 登入工作階段的長度。
 *
 * 網站（cookie）14 天：它看得到訂單與 email，而且是瀏覽器裡最容易被偷的地方。
 * 擴充功能（配對取得）30 天：存在擴充功能自己的儲存空間，網頁上的 XSS 拿不到；
 * 它主要用來把免費額度綁在帳號上，太短會讓使用者常常莫名其妙變成遊客。
 * SESSION_TTL_DAYS 保留給 subalias（合併帳號的舊 sub 別名）用：取兩者中較長的。
 */
const SESSION_TTL_WEB_DAYS = 14;
const SESSION_TTL_EXT_DAYS = 30;
const SESSION_TTL_DAYS = Math.max(SESSION_TTL_WEB_DAYS, SESSION_TTL_EXT_DAYS);
/**
 * 網站的工作階段 cookie。
 * ⚠️ `__Host-` 前綴：瀏覽器強制要求 Secure、Path=/、**不可以帶 Domain**——
 *    也就是只屬於 api.pitlingo.com 這一個主機，子網域或別的網站都設不了、也讀不到。
 * ⚠️ HttpOnly：網頁上的 JavaScript 讀不到（XSS 偷不走）。
 * ⚠️ SameSite=Strict：別的網站發起的請求不會帶它（CSRF）。pitlingo.com → api.pitlingo.com
 *    是同一個網站（same-site），所以我們自己的頁面照樣帶得到。
 */
const SESSION_COOKIE = '__Host-pl_sess';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];

// JWKS 快取一小時。Google 的金鑰輪替頻率遠低於此，
// 而每次登入都去抓一次會讓登入變慢又沒有必要。
let jwksCache = { at: 0, keys: null };

function b64urlToBytes(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
  const bin = atob(t + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function googleKeys() {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600000) return jwksCache.keys;
  const r = await fetch(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`拿不到 Google 的金鑰（HTTP ${r.status}）`);
  const d = await r.json();
  if (!d || !Array.isArray(d.keys) || !d.keys.length) throw new Error('Google 的金鑰格式不對');
  jwksCache = { at: Date.now(), keys: d.keys };
  return d.keys;
}

/**
 * 驗證 Google 的 ID token。回傳 `{ sub, email, emailVerified, name, picture }`。
 *
 * ⚠️ **`alg` 必須是 RS256，而且要在讀 payload 之前就檢查。**
 *    JWT 最經典的攻擊就是把 `alg` 改成 `none` 或 `HS256`——
 *    前者讓簽章不必存在，後者讓攻擊者拿公開的公鑰當 HMAC 金鑰自己簽。
 *    這兩種都會讓「驗簽」變成走過場。
 */
async function verifyGoogleIdToken(env, idToken) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('伺服器未設定 GOOGLE_CLIENT_ID');

  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('token 格式不正確');
  const [h, p, s] = parts;

  let header;
  try { header = b64urlToJson(h); } catch (e) { throw new Error('token 的標頭解不開'); }
  if (header.alg !== 'RS256') throw new Error(`不接受的簽章演算法：${header.alg}`);

  const keys = await googleKeys();
  const jwk = keys.find((k) => k.kid === header.kid) || null;
  if (!jwk) {
    // 金鑰輪替時可能快取的是舊的。清掉重抓一次，只重試這一次。
    jwksCache = { at: 0, keys: null };
    const fresh = await googleKeys();
    const again = fresh.find((k) => k.kid === header.kid);
    if (!again) throw new Error('找不到對應的 Google 金鑰');
    return verifyWithJwk(again, h, p, s, clientId);
  }
  return verifyWithJwk(jwk, h, p, s, clientId);
}

async function verifyWithJwk(jwk, h, p, s, clientId) {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify'],
  );
  const data = new TextEncoder().encode(`${h}.${p}`);
  const okSig = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), data);
  if (!okSig) throw new Error('簽章驗證失敗');

  const c = b64urlToJson(p);
  const now = Math.floor(Date.now() / 1000);

  // ⚠️ 這四項缺一不可，而且**每一項單獨拿掉都不會讓登入壞掉**——
  //    只會讓它變得可以偽造。這正是最危險的一種缺陷。
  if (!GOOGLE_ISS.includes(String(c.iss))) throw new Error('簽發者不是 Google');
  if (String(c.aud) !== String(clientId)) throw new Error('這枚 token 不是發給本站的');
  if (!(Number(c.exp) > now)) throw new Error('token 已過期');
  // 時鐘誤差放寬 5 分鐘。iat 在未來太多代表 token 被動過手腳。
  if (Number(c.iat) && Number(c.iat) > now + 300) throw new Error('token 的簽發時間不合理');
  // nbf（not before）：Google 目前會帶。還沒生效的 token 不收（時鐘誤差同樣放寬 5 分鐘）
  if (Number(c.nbf) && Number(c.nbf) > now + 300) throw new Error('token 尚未生效');
  if (c.email_verified !== true && c.email_verified !== 'true') {
    throw new Error('這個 Google 帳號的 email 尚未驗證，無法登入');
  }
  if (!c.sub) throw new Error('token 裡沒有使用者識別碼');

  return {
    sub: String(c.sub),
    email: accountKey(c.email),
    name: String(c.name || '').slice(0, 80),
    picture: String(c.picture || '').slice(0, 300),
  };
}

// ---- 工作階段權杖（v2，2026-10-02）-----------------------------------------
// 格式：`<sub>.<sid>.<iat>.<exp>.<HMAC>`。
//   sid  隨機 18 bytes，開頭一個字母標種類（w 網站 cookie／x 擴充功能）
//   iat  簽發時間——「登出所有裝置」作廢的是這個時間點以前簽的全部
//
// ⚠️ **v1（`<sub>.<exp>.<HMAC>`）一律不再接受。** v1 沒有 sid，**無法撤銷**：
//    偷到就能用滿 30 天，按登出也只是刪掉自己這一份。接受 v1 等於讓
//    「不能撤銷」這一類權杖再活 30 天。代價是改版當下已登入的人要重新登入一次。
//
// ⚠️ 簽章的前綴是 `sess2:`，與 v1 的 `sess:` 不同——v1 的簽章拿來也驗不過 v2。

// ⚠️ 擴充功能的權杖（x）續期時會換新的（handleLicenseRenew），**一家人要認得出彼此**
//    （security-audit run-2 #14，2026-10-06）。以前換出來的新權杖和舊的毫無關係：
//      · 擴充功能按登出只撤銷手上那一枚——被複製走的那枚、以及它續出來的，照樣有效
//      · 一枚被複製的權杖可以一路續下去，永遠不會過期
//    現在 sid 後面帶「家族編號＋第一枚的簽發時間」：登出撤銷整個家族，
//    而且整個家族最長 SESSION_X_MAX_DAYS 天（之後要重新登入一次）。
//    格式：x + 24 碼隨機 + 'f' + 12 碼家族編號 + 10 位數的起始時間（共 48 碼）。舊的 25 碼照收。
const SESSION_X_MAX_DAYS = 180;

function sessionFamily(sid, iat) {
  if (typeof sid === 'string' && sid.length === 48 && sid[0] === 'x' && sid[25] === 'f' && /^\d{10}$/.test(sid.slice(38))) {
    return { fam: sid.slice(26, 38), root: Number(sid.slice(38)) };
  }
  return { fam: null, root: iat };
}

async function issueSession(env, sub, kind, family) {
  const secret = tokenSecret(env);
  if (!secret) throw new Error('伺服器未設定 TOKEN_SECRET');
  const k = kind === 'x' ? 'x' : 'w';
  const iat = nowSec();
  let exp = iat + (k === 'x' ? SESSION_TTL_EXT_DAYS : SESSION_TTL_WEB_DAYS) * 86400;
  let sid = k + b64url(crypto.getRandomValues(new Uint8Array(18)));
  if (k === 'x') {
    const fam = (family && /^[A-Za-z0-9_-]{12}$/.test(family.fam || '')) ? family.fam
      : b64url(crypto.getRandomValues(new Uint8Array(9)));
    const root = (family && Number(family.root) > 0) ? Math.floor(Number(family.root)) : iat;
    sid += 'f' + fam + String(root).padStart(10, '0');
    // 不可以活過整個家族的上限
    exp = Math.min(exp, root + SESSION_X_MAX_DAYS * 86400);
  }
  const payload = `${sub}.${sid}.${iat}.${exp}`;
  return { token: `${payload}.${await hmac(secret, 'sess2:' + payload)}`, exp, sid, iat };
}

/**
 * 驗證工作階段。
 *
 * `opts.strict`：**再問 AuthGuard 這一枚有沒有被撤銷**（登出、登出所有裝置）。
 *   看得到個資或會改資料的端點（帳號、認領、配對、登出）一律 strict。
 *   翻譯那條路不 strict：每一個翻譯請求都多一次 DO 呼叫太貴，而它只用來決定
 *   「免費額度算在帳號還是 installId 上」——被撤銷的權杖頂多多拿幾分鐘免費額度。
 * ⚠️ strict 時 AuthGuard 連不上就**當成無效**（fail closed）。
 */
async function verifySession(env, token, opts) {
  const secret = tokenSecret(env);
  if (!secret) return null;
  const raw = String(token || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw || raw.length > 600) return null;
  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const payload = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  if (!safeEqual(sig, await hmac(secret, 'sess2:' + payload))) return null;
  // ⚠️ **從右邊拆，不可以用 `split('.')` 由左取。** sub 有可能自己就含有點
  //    （email 帳號的 sub 曾經是 `em:ray@example.com`）。從左邊拆會把 sub 切斷，
  //    於是**每一枚這種權杖都驗不過**——「登入成功但立刻變回未登入」，而且不報錯。
  const parts = payload.split('.');
  if (parts.length < 4) return null;
  const exp = parts.pop();
  const iat = parts.pop();
  const sid = parts.pop();
  const sub = parts.join('.');
  if (!sub || !/^[wx][A-Za-z0-9_-]{20,}$/.test(sid)) return null;
  if (!/^\d+$/.test(exp) || !/^\d+$/.test(iat)) return null;
  if (!(Number(exp) > nowSec())) return null;
  const sess = { sub, sid, iat: Number(iat), exp: Number(exp), kind: sid[0] };
  Object.assign(sess, sessionFamily(sid, sess.iat));
  if (sess.kind === 'x' && nowSec() - sess.root > SESSION_X_MAX_DAYS * 86400) return null;
  if (opts && opts.strict) {
    const r = await authCall(env, { op: 'check', sid, fam: sess.fam || undefined, ah: await authSubHash(env, sub), iat: sess.iat });
    if (!r || !r.ok) return null;
  }
  return sess;
}

/** 從請求取出工作階段：先看 Authorization（擴充功能），再看 cookie（網站）。 */
function sessionFrom(request) {
  const auth = request.headers.get('authorization') || '';
  if (/^Bearer\s+\S/i.test(auth)) return { raw: auth, via: 'bearer' };
  const ck = request.headers.get('cookie') || '';
  const m = ck.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  return m ? { raw: m[1], via: 'cookie' } : { raw: '', via: '' };
}

async function sessionOf(env, request, strict) {
  const f = sessionFrom(request);
  if (!f.raw) return null;
  const s = await verifySession(env, f.raw, { strict: !!strict });
  return s ? Object.assign(s, { via: f.via }) : null;
}

function sessionCookie(token, maxAgeSec) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

/**
 * CSRF 的第二道：用 cookie 驗證的寫入請求，Origin 必須是我們自己的網站。
 * SameSite=Strict 已經讓別的網站帶不到 cookie；這一道是給「瀏覽器沒照規矩來」的情況。
 * 用 Authorization 標頭的（擴充功能）不受影響——跨站網頁本來就加不了這個標頭。
 */
function csrfOk(request, sess) {
  if (!sess || sess.via !== 'cookie') return true;
  return SITE_ORIGINS.has(request.headers.get('origin') || '');
}

/**
 * 登入端點的來源檢查（security-audit run-2 需驗證 #1，login CSRF）。
 * 別的網站用自動送出的表單或 fetch 打我們的登入端點，瀏覽器會存下回應裡的 cookie——
 * 使用者就在不知情下登入**攻擊者的帳號**，之後買的東西進了對方帳號。
 * 瀏覽器發出的跨站 POST 一定帶 Origin，所以：有帶就必須是我們的網站；沒帶（不是瀏覽器）放行。
 */
function loginOriginOk(request) {
  const o = request.headers.get('origin');
  return !o || SITE_ORIGINS.has(o);
}

/** sub 的雜湊。AuthGuard 裡不存 sub 原文（email 帳號的 sub 也是 email 衍生的）。 */
async function authSubHash(env, sub) {
  return (await hmac(tokenSecret(env) || 'x', 'authsub:' + String(sub))).slice(0, 32);
}

// ---- 帳號記錄 -------------------------------------------------------------
// `acctg:<sub>` 是帳號本體；`gsub:<email>` 是「這個 email 已經被哪個 sub 認領」。

const acctgKey = (sub) => `acctg:${sub}`;
const gsubKey = (email) => `gsub:${accountKey(email)}`;

async function readGoogleAccount(env, sub) {
  let acc = null;
  try { acc = JSON.parse((await env.SUBS.get(acctgKey(sub))) || 'null'); } catch (e) { acc = null; }
  if (acc) return acc;
  // ⚠️ **合併過的舊 sub 要查得到人。** 先用 email 驗證碼登入、後來改用
  //    Google 的人，他手上那枚工作階段權杖是簽給 `em:` 那個 sub 的。
  //    不解析別名的話，他會在合併的瞬間被登出，而且看起來像帳號被刪了。
  let alias = null;
  try { alias = await env.SUBS.get('subalias:' + sub); } catch (e) { alias = null; }
  if (!alias || alias === sub) return null;
  try { return JSON.parse((await env.SUBS.get(acctgKey(alias))) || 'null'); } catch (e) { return null; }
}

/**
 * 登入（必要時建立帳號）。
 *
 * ⚠️ **首次登入時用「已驗證的 email」認領既有資料。**
 *    使用者在有登入之前就買過東西，那些訂單與授權碼是用 email 記的。
 *    不認領的話，他登入後會看到一個空白的帳號——**東西還在，但他找不到**，
 *    而那看起來就像我們弄丟了他的購買紀錄。
 *
 * ⚠️ **一個 email 只能被一個 Google 帳號認領。** 否則兩個人先後用
 *    同一個 email 登入，後者會看到前者的訂單。
 */
async function googleLogin(env, profile) {
  const now = nowSec();
  let acc = await readGoogleAccount(env, profile.sub);

  if (!acc) {
    acc = {
      sub: profile.sub,
      email: profile.email,
      name: profile.name,
      emails: [],
      createdAt: now,
      lastLogin: now,
    };
    // 認領：這個已驗證的 email 若還沒被別的 sub 佔走，就歸這個帳號。
    if (profile.email) {
      const owner = await env.SUBS.get(gsubKey(profile.email));
      if (!owner) {
        await env.SUBS.put(gsubKey(profile.email), profile.sub);
        acc.emails.push(profile.email);
      } else if (owner === profile.sub) {
        acc.emails.push(profile.email);
      } else if (owner === (await emailSub(env, profile.email))) {
        // 這個 email 之前是用驗證碼登入建的帳號。**併進來**，
        // 否則使用者改用 Google 之後會看到一個空的新帳號。
        const m = await mergeEmailAccountIntoGoogle(env, owner, profile.sub);
        if (m) return { acc: m, created: false, merged: true };
      }
      // 被別人佔走時**不報錯**——他仍然可以用授權碼認領自己的東西。
      // 在這裡擋下等於讓一個誤操作永久鎖死一個人的帳號。
    }
    await env.SUBS.put(acctgKey(profile.sub), JSON.stringify(acc));
    return { acc, created: true };
  }

  // 既有帳號：email 會變，更新顯示用的欄位，但**主鍵永遠是 sub**。
  let dirty = false;
  if (profile.email && acc.email !== profile.email) { acc.email = profile.email; dirty = true; }
  if (profile.name && acc.name !== profile.name) { acc.name = profile.name; dirty = true; }
  if (profile.email && !acc.emails.includes(profile.email)) {
    const owner = await env.SUBS.get(gsubKey(profile.email));
    if (!owner) {
      await env.SUBS.put(gsubKey(profile.email), profile.sub);
      acc.emails.push(profile.email);
      dirty = true;
    }
  }
  // 每次登入都寫一次 KV 會浪費額度（坑 #10）。只在**內容真的變了**、
  // 或距離上次登入超過一天時才寫。
  if (dirty || now - (acc.lastLogin || 0) > 86400) {
    acc.lastLogin = now;
    await env.SUBS.put(acctgKey(profile.sub), JSON.stringify(acc));
  }
  return { acc, created: false };
}

/**
 * 登入成功的回應（Google 與 Email 驗證碼共用）。
 *
 * ⚠️ **權杖只放在 HttpOnly cookie，不放在回應內容裡。** 以前是回傳 token、
 *    前端存進 localStorage——網頁上任何一段 XSS 都讀得到它。
 *    擴充功能不走這裡：它用配對碼拿自己的那一枚（/v1/auth/link）。
 */
async function loginResponse(env, acc, created, extra, request) {
  const s = await issueSession(env, acc.sub, 'w');
  // 新裝置通知：這個瀏覽器用 __Host-pl_dev 認（沒有就發一個）。通知失敗絕不擋登入。
  let devRaw = request ? deviceIdFrom(request) : '';
  let setDev = '';
  if (request && !devRaw) {
    devRaw = b64url(crypto.getRandomValues(new Uint8Array(18)));
    setDev = deviceCookie(devRaw);
  }
  if (request) {
    try { await noteLoginDevice(env, request, acc, 'web', devRaw, created); } catch (e) { /* noop */ }
  }
  // 第一次登入（帳號剛建立）寄歡迎信，不寄「新裝置」通知（2026-10-31）。失敗絕不擋登入
  if (created) {
    try { await sendWelcomeMail(env, acc); } catch (e) { /* noop */ }
  }
  const res = json({
    ok: true, exp: s.exp, created,
    profile: Object.assign({ email: acc.email, name: acc.name }, extra || {}),
    emails: acc.emails || [],
  }, 200, { 'set-cookie': sessionCookie(s.token, s.exp - s.iat) });
  if (setDev) res.headers.append('set-cookie', setDev);
  return res;
}

