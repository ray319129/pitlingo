// ---------------------------------------------------------------------------
// 授權：每個安裝一枚權杖（取代所有人共用的 CLIENT_TOKEN）
//
// 為什麼非改不可（SECURITY.md S6）：
// CLIENT_TOKEN 隨擴充功能發給每一位使用者，任何人解開 .crx 就拿得到——**等於公開**。
// 搭配 CORS `*`，任何網站都能無限呼叫 /v1/translate 燒掉 Anthropic 額度。
// 這不是加檢查能解決的，必須讓「每個安裝有自己的身分」。
//
// 設計取捨：**不做帳號系統**。使用者不需要註冊、不需要 email，
// 首次啟動時匿名換一枚權杖就好。這樣：
//   - 每個安裝可獨立限額、獨立撤銷（濫用或退款時）
//   - 速率限制終於有意義的鍵（IP 換 proxy 就繞過，installId 不行）
//   - P3 要接付費時，同一枚權杖加上 plan 欄位即可，不用重做
//
// 權杖格式：<installId>.<exp>.<HMAC-SHA256 簽章>
// 驗證只需要 HMAC，**不必讀 KV**，所以每次請求的成本是零。
// 撤銷才需要查 KV，而撤銷清單很小且可快取。
// ---------------------------------------------------------------------------
const TOKEN_TTL_DAYS = 90;

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

/**
 * 常數時間比對。
 * 一般的 `!==` 會在第一個不同的位元組就返回，理論上可由回應時間推出正確值。
 * 跨網路且有速率限制時實務上不可行，但比對密鑰本來就該用常數時間——
 * 成本是三行，沒有理由不做。（SECURITY.md S11）
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 把 installId 穩定地映射到 0~99 的一個桶。
 * 同一個安裝永遠落在同一個桶，所以推送 10% 時，那 10% 的人不會忽新忽舊。
 */
async function bucketOf(installId) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(installId)));
  return new Uint8Array(buf)[0] % 100;
}

function tokenSecret(env) {
  // 沒有專用 secret 時退回 ADMIN_TOKEN 衍生，讓既有部署不會壞。
  // 正式環境應該 `wrangler secret put TOKEN_SECRET`。
  return env.TOKEN_SECRET || (env.ADMIN_TOKEN ? env.ADMIN_TOKEN + ':install' : null);
}

async function issueInstallToken(env) {
  const secret = tokenSecret(env);
  if (!secret) throw new Error('伺服器未設定 TOKEN_SECRET');
  const installId = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_DAYS * 86400;
  const payload = `${installId}.${exp}`;
  return { token: `${payload}.${await hmac(secret, payload)}`, installId, exp };
}

// 撤銷清單。整份放一個 key，用 isolate 內快取避免每個請求都讀 KV。
//
// **這份清單是「停用／刪除授權」唯一能立刻生效的機制。**
// 通行證（entitlement）是簽出去的，簽完就獨立生效到期限為止——
// 後端刪掉授權碼並不會讓已經發出去的通行證失效。所以停用或刪除時
// 必須把該授權底下的所有安裝寫進這裡，`entitlementGate` 才擋得住。
//
// 項目格式演進（兩種都要讀得懂）：
//   舊："installId"                 —— 永久有效，會無限累積
//   新：{ i: installId, u: 到期秒 } —— 只需要撐到該通行證自然過期
//
// 為什麼要有到期時間：通行證最長 14 天，過期後那筆撤銷紀錄就沒有意義了。
// 不清掉的話，每刪一組授權就永久留下最多 3 筆，這份「應該永遠很小」的清單
// 會慢慢長大，而它是每次翻譯都要讀的東西。
let revCache = { at: 0, set: null };

/** 讀出並整理撤銷清單。回傳 { list, set }，list 已剔除過期項目。 */
async function revokedRead(env) {
  let raw = [];
  try { raw = JSON.parse((await env.SUBS.get('revoked')) || '[]'); } catch (e) { /* 壞掉當空的 */ }
  if (!Array.isArray(raw)) raw = [];
  const now = nowSec();
  const list = [];
  const set = new Set();
  for (const it of raw) {
    if (typeof it === 'string') { list.push(it); set.add(it); continue; }   // 舊格式，永久保留
    if (!it || typeof it.i !== 'string') continue;
    if (it.u && it.u < now) continue;                                       // 已過期，順手剔除
    list.push(it); set.add(it.i);
  }
  return { list, set };
}

async function revokedSet(env) {
  if (revCache.set && Date.now() - revCache.at < 60000) return revCache.set;
  const { set } = await revokedRead(env);
  revCache = { at: Date.now(), set };
  return set;
}

/**
 * 通行證作廢清單。**與 `revoked` 是不同的東西，不要合併。**
 *
 * | | `revoked` | `entvoid`（這裡） |
 * |---|---|---|
 * | 語意 | 封鎖整個安裝 | 只讓已發出的通行證失效 |
 * | 後果 | 連免費層都用不了 | **退回免費層**，還能看每場前 15 分鐘 |
 * | 用途 | 濫用、盜用 | 刪除授權碼、停用、清空裝置 |
 *
 * 為什麼一定要分開：刪掉一組發錯的授權碼，不該讓那個人的瀏覽器連免費層
 * 都用不了——那是懲罰，不是修正。但用同一份清單就會變成那樣，
 * 而且完全不會報錯，只會有人寫信來說「我連免費的都不能用了」。
 */
let voidCache = { at: 0, set: null };

async function entVoidRead(env) {
  let raw = [];
  try { raw = JSON.parse((await env.SUBS.get('entvoid')) || '[]'); } catch (e) { /* 壞掉當空的 */ }
  if (!Array.isArray(raw)) raw = [];
  const now = nowSec();
  const list = [];
  const set = new Set();
  // installId → 作廢的那一刻（毫秒）。**只擋那一刻以前簽的通行證**（2026-10-05，見 voidEntitlements）。
  // 舊紀錄沒有 t：以 u − 14 天推回作廢時間（voidEntitlements 預設的 u 就是作廢當下 ＋ 14 天）。
  const at = new Map();
  for (const it of raw) {
    if (!it || typeof it.i !== 'string') continue;
    if (it.u && it.u < now) continue;               // 通行證早就自然過期了，剔除
    list.push(it); set.add(it.i);
    const t = Number(it.t) || ((Number(it.u) || now) - ENTITLEMENT_DAYS * 86400) * 1000;
    at.set(it.i, Math.max(at.get(it.i) || 0, t));
  }
  // 2026-10-06 起新的作廢存在 AuthGuard（見 AuthGuard.voidIds）。上面那份 KV 清單是舊資料，
  // 不再寫入、14 天內自然過期，在那之前兩邊一起看。
  if (env.AUTH) {
    const r = await authCall(env, { op: 'voidlist' });
    if (r && r.ok && Array.isArray(r.list)) {
      for (const it of r.list) {
        if (!it || typeof it.i !== 'string') continue;
        set.add(it.i);
        at.set(it.i, Math.max(at.get(it.i) || 0, Number(it.t) || 0));
      }
    }
  }
  set.at = at;
  return { list, set };
}

async function entVoidSet(env) {
  if (voidCache.set && Date.now() - voidCache.at < 60000) return voidCache.set;
  const { set } = await entVoidRead(env);
  voidCache = { at: Date.now(), set };
  return set;
}

/**
 * 讓這些安裝手上的通行證失效。
 *
 * ⚠️ KV 沒有 CAS（坑 #24）。這是「讀→改→寫」，兩個管理動作同時進行會互相覆蓋。
 *    頻率極低，但**漏掉一筆的後果是被停用的人還能繼續用**，
 *    所以寫回前重讀合併，成本一次 KV 讀取。
 */
async function voidEntitlements(env, installIds, untilSec) {
  const ids = (installIds || []).filter((x) => typeof x === 'string' && x);
  if (!ids.length) return 0;
  // 只需要撐到通行證自然過期為止；再久就是無意義地讓清單長大。
  const until = untilSec || (nowSec() + ENTITLEMENT_DAYS * 86400);
  // ⚠️ 放 AuthGuard，每台一筆（security-audit run-2 #15）：兩個作廢同時發生不會互相蓋掉。
  //    AuthGuard 連不上才退回舊的 KV 清單——漏記一筆的後果（被踢的人繼續看）比偶爾互蓋更糟。
  if (env.AUTH) {
    const r = await authCall(env, { op: 'void', ids, u: until, t: Date.now() });
    if (r && r.ok) { voidCache = { at: 0, set: null }; return ids.length; }
  }
  const { list } = await entVoidRead(env);
  // ⚠️ **每次都更新作廢時間**（以前同一台已經在清單裡就跳過）：作廢只擋「這一刻以前簽的」，
  //    第二次作廢（例如重新啟用後又被解除）要用新的時間，否則中間簽的那張擋不到。
  const t = Date.now();
  const next = list.filter((it) => !ids.includes(it.i));
  for (const id of ids) next.push({ i: id, u: until, t });
  await env.SUBS.put('entvoid', JSON.stringify(next));
  voidCache = { at: 0, set: null };
  return list.length;
}

/** 恢復。後台按「恢復」時要走這條，否則畫面說成功、使用者還是不能用。 */
async function unvoidEntitlements(env, installIds) {
  const ids = new Set((installIds || []).filter(Boolean));
  if (!ids.size) return 0;
  if (env.AUTH) await authCall(env, { op: 'void', ids: [...ids], del: true });
  const { list } = await entVoidRead(env);
  const next = list.filter((it) => !ids.has(it.i));
  // 舊的 KV 清單裡真的有才寫（多數情況沒有，不必花一次寫入）
  if (next.length !== list.length) await env.SUBS.put('entvoid', JSON.stringify(next));
  voidCache = { at: 0, set: null };
  return next.length;
}

/**
 * 驗證用戶端權杖。回傳 { ok, installId } 或 { ok:false, reason }。
 *
 * 相容性：舊的共用 CLIENT_TOKEN 仍然接受，但會標記成 legacy。
 * 這是為了讓 userscript（管理員工具）與尚未更新的安裝不會突然壞掉——
 * **但 legacy 走比較嚴格的限額**，見 handleTranslate。
 */
async function authClient(env, request) {
  // 管理版擴充功能的收割（handoff 9.1 #26，2026-10-11）：帶 HARVEST_TOKEN 的請求翻譯經過後端，
  // 瀏覽器裡不放 Anthropic 金鑰。權限等同舊的共用 CLIENT_TOKEN（legacy：不吃免費額度、
  // 收割蓋的完整標記可信），但**成本另外記在 installId 'harvest'、另外熔斷**（見 overBudget）——
  // 收割夜不可以把直播觀眾的翻譯一起停掉。
  // ⚠️ 帶了收割權杖卻對不上就直接拒絕，**不要退回去看 x-client-token**：
  //    管理版兩個標頭都送，權杖打錯時靜靜變成一般使用者，收割會吃免費額度、標記不被信任，而且不報錯。
  const ht = request.headers.get('x-harvest-token') || '';
  if (ht) {
    if (env.HARVEST_TOKEN && safeEqual(ht, env.HARVEST_TOKEN)) {
      return { ok: true, installId: 'harvest', legacy: true, harvest: true };
    }
    return { ok: false, reason: 'invalid harvest token' };
  }

  const raw = request.headers.get('x-client-token') || '';
  if (!raw) return { ok: false, reason: 'missing token' };

  const parts = raw.split('.');
  if (parts.length === 3) {
    const [installId, expStr, sig] = parts;
    const secret = tokenSecret(env);
    if (!secret) return { ok: false, reason: 'server misconfigured' };
    const expect = await hmac(secret, `${installId}.${expStr}`);
    if (!safeEqual(sig, expect)) return { ok: false, reason: 'bad signature' };
    if (Number(expStr) * 1000 < Date.now()) return { ok: false, reason: 'expired' };
    if ((await revokedSet(env)).has(installId)) return { ok: false, reason: 'revoked' };
    return { ok: true, installId, legacy: false };
  }

  // 舊格式：所有人共用的那一枚
  if (env.CLIENT_TOKEN && safeEqual(raw, env.CLIENT_TOKEN)) {
    return { ok: true, installId: 'legacy', legacy: true };
  }
  return { ok: false, reason: 'invalid token' };
}

function authAdmin(env, request) {
  return !!env.ADMIN_TOKEN && safeEqual(request.headers.get('x-admin-token') || '', env.ADMIN_TOKEN);
}

// ---------------------------------------------------------------------------
// 收割權杖（HARVEST_TOKEN，2026-09-17）——最小權限
//
// userscript 的自動收割要打管理端點（排佇列、寫譯文、補網址後綴），而它是**無人值守的程式**，
// 不可能輸入 30 秒一換的動態碼。原本它用 ADMIN_TOKEN——於是：
//   · 一打開動態碼（ADMIN_TOTP_SECRET），自動收割立刻全部 401，而且每一次都算失敗 → 連後台一起鎖住
//   · 放在瀏覽器擴充（Tampermonkey）裡的是**整個後台的鑰匙**：發碼、退款、改價、推 killSwitch
// 改成：收割只拿得到下面這幾個端點，不需要動態碼（失敗鎖定與稽核照常）。
// ⚠️ **不要把新端點隨手加進這張表。** 每加一個，收割權杖外洩的損害就多一項。
// ---------------------------------------------------------------------------
const HARVEST_ROUTES = new Set([
  'POST /v1/subs',
  'POST /v1/admin/harvest/plan',
  'GET /v1/admin/bundles',
  'POST /v1/admin/bundles/slugs',
  // F1TV 賽事頁的真實時程（A4）。外洩的損害見 f1tvSchedClean：只能在該站週末範圍內挪節目時間
  'POST /v1/admin/harvest/f1tv-schedule',
  // 收割端的即時狀態（2026-10-30）。外洩的損害見 harvestStatusClean：只能在後台「即時狀態」放一張假的收割端卡片
  // （格式與長度驗過、後台一律 escHtml、存在 DO 不寫 KV、最多留 HSTAT_MAX 張）
  'POST /v1/admin/harvest/status',
]);

function harvestRoute(request, path) { return HARVEST_ROUTES.has(request.method + ' ' + path); }

/** 收割端點的權限：管理員權杖，或（只限這幾個端點）收割權杖。 */
function authHarvest(env, request, path) {
  if (authAdmin(env, request)) return true;
  return !!env.HARVEST_TOKEN && harvestRoute(request, path)
    && safeEqual(request.headers.get('x-harvest-token') || '', env.HARVEST_TOKEN);
}

