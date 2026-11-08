// ---------------------------------------------------------------------------
// 管理端的多層防護
//
// ⚠️ **問題不是「網址被猜中」，是「猜中之後只剩一層」。**
//    後台的網址本來就擋不住人——它是靜態頁，任何人載入都拿得到 HTML，
//    而 HTML 裡沒有任何資料。真正的門是 API。所以正確的做法不是把路徑
//    藏起來（那是 security through obscurity，擋不住也驗不了），
//    而是**讓那扇門本身變成好幾層**：
//
//      1. ADMIN_TOKEN          既有。單獨一層時，洩漏＝全部資料外流
//      2. ADMIN_TOTP_SECRET    第二把鎖，30 秒動態碼。token 洩漏也進不來
//      3. ADMIN_IPS            IP 白名單。設了就只有那些位址進得來
//      4. 失敗鎖定              同一來源連續失敗就封鎖，讓暴力嘗試不可行
//      5. 稽核日誌              誰、何時、打了什麼、成功與否
//      6. Cloudflare Access    最強的一層，在 Worker 之前就擋掉（見 SECURITY.md）
//
// ⚠️ **每一層都可以單獨關掉，而且預設是關的。** 設定錯誤把自己鎖在外面，
//    比沒有防護更糟——那時你連去關掉它的後台都進不去。
// ---------------------------------------------------------------------------

/** 連續失敗幾次就鎖。 */
const ADMIN_FAIL_MAX = 8;
/** 鎖多久（秒）。 */
const ADMIN_LOCK_SEC = 900;
/** 稽核紀錄保留天數。 */
const ADMIN_AUDIT_DAYS = 30;

/** 來源的穩定代號。**不存 IP 原文**——隱私權政策承諾過，也沒有必要。 */
async function adminWho(env, ip) {
  return (await hmac(tokenSecret(env) || 'x', 'adm:' + String(ip || ''))).slice(0, 16);
}

/**
 * RFC 6238 TOTP（30 秒、6 碼、HMAC-SHA1），與 Google Authenticator／1Password 相容。
 *
 * ⚠️ 允許前後各一個時間窗，因為手機與伺服器的時鐘一定有差。
 *    放寬到 ±1 是標準做法；再寬就等於把有效期拉長到兩分半，沒有意義。
 */
function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = A.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function totpAt(secretB32, step) {
  const key = b32decode(secretB32);
  if (!key.length) return null;
  const msg = new Uint8Array(8);
  let v = step;
  for (let i = 7; i >= 0; i--) { msg[i] = v & 0xff; v = Math.floor(v / 256); }
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
  const off = sig[sig.length - 1] & 0x0f;
  const bin = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

/** 對得上就回那一組碼的時間步（一定是正數），否則 0。 */
async function totpOk(secretB32, code) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return 0;
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step - 1, step, step + 1]) {
    const want = await totpAt(secretB32, s);
    if (want && safeEqual(want, c)) return s;
  }
  return 0;
}

/**
 * 稽核紀錄。**只記會改變狀態的請求與所有失敗**。
 *
 * ⚠️ 每一個請求都記會撞爆 KV 寫入額度——後台一開就是十幾個 GET。
 *    而真正需要事後追查的是「誰改了什麼」與「誰在敲門」，讀取不是。
 */
async function adminAudit(env, entry) {
  try {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await env.SUBS.put(`audit:${id}`, JSON.stringify(entry), {
      expirationTtl: ADMIN_AUDIT_DAYS * 86400,
      metadata: { at: entry.at, p: entry.path, m: entry.method, ok: entry.ok, w: entry.who, r: entry.reason || '' },
    });
  } catch (e) { /* 記不起來不能讓管理端整個壞掉 */ }
}

/**
 * 後台登入工作階段的效期。2026-10-28 Ray：從 8 小時改成 4 天。
 * 仍然綁來源（換網路就要重登）、仍然只放在分頁記憶體（重新整理就要重登），
 * 輪換 ADMIN_TOKEN 或動態碼金鑰會讓全部立刻失效。
 */
const ADMIN_SESSION_SEC = 4 * 86400;

/**
 * 後台登入工作階段：`<到期秒>.<簽章>`，簽章綁來源代號。
 *
 * ⚠️ 簽章金鑰混入 ADMIN_TOKEN 與 ADMIN_TOTP_SECRET：**換掉任何一個，所有已登入的工作階段立刻失效**
 *    （權杖外洩時輪換就能踢掉對方，不必等 8 小時）。
 * ⚠️ 不存 KV：驗證是純計算，後台每次請求都驗也不花寫入額度（坑 #10）。
 */
async function adminSessionSig(env, exp, who) {
  const key = `${tokenSecret(env) || 'x'}|${env.ADMIN_TOKEN || ''}|${env.ADMIN_TOTP_SECRET || ''}`;
  return hmac(key, `adm-session:${exp}:${who}`);
}
async function adminSessionIssue(env, who) {
  const exp = nowSec() + ADMIN_SESSION_SEC;
  return { session: `${exp}.${await adminSessionSig(env, exp, who)}`, expiresAt: exp };
}
async function adminSessionOk(env, raw, who) {
  const m = String(raw || '').match(/^(\d{10})\.([A-Za-z0-9_-]{20,})$/);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > nowSec()) || exp > nowSec() + ADMIN_SESSION_SEC + 60) return false;
  return safeEqual(m[2], await adminSessionSig(env, exp, who));
}

/**
 * 管理端的單一入口檢查。**在任何 admin 端點之前跑一次。**
 *
 * 各端點裡的 `authAdmin` 一律保留——那是縱深防禦：
 * 日後有人新增端點卻忘了接上這裡時，仍然擋得住。
 */
async function adminGate(env, request, path, ip) {
  const who = await adminWho(env, ip);
  const at = nowSec();
  const method = request.method;
  // ⚠️ **失敗計數放在 AuthGuard，不放 KV**（security-audit 2026-10-05 #3）。
  //    以前每一次被拒都寫 2 次 KV（失敗計數＋稽核紀錄），在任何驗證之前——匿名打
  //    /v1/admin/* 約 500 次就用完整個帳號每天 1,000 次的寫入額度，結帳、發碼、共用快取全部寫不進去。
  //    設了 ADMIN_IPS 時更糟：白名單在鎖定之前檢查，被拒的來源永遠不會被鎖、每次都寫。
  //    現在：鎖定最先查（被鎖的來源零寫入）、計數在 DO（不吃 KV）、稽核紀錄全站每天最多 200 筆。
  //    沒有 AuthGuard 的環境（本機開發）退回原本的 KV 計數。
  const useGuard = !!env.AUTH;
  const deny = async (status, error, reason) => {
    // 失敗一律計數。這是「有人在試」唯一看得見的地方。
    if (useGuard) {
      await authLimited(env, 'admfail', who);
    } else {
      try {
        const k = `admfail:${who}`;
        const n = parseInt((await env.SUBS.get(k)) || '0', 10) || 0;
        await env.SUBS.put(k, String(n + 1), { expirationTtl: ADMIN_LOCK_SEC });
      } catch (e) { /* 計數失敗不影響拒絕 */ }
    }
    // 稽核紀錄是 KV 寫入：全站每天最多 200 筆失敗紀錄，再多就只計數（DO）不寫 KV
    if (!useGuard || !(await authLimited(env, 'admaudit', 'all'))) {
      await adminAudit(env, { at, who, path, method, ok: false, reason });
    }
    return { ok: false, status, error };
  };

  if (!env.ADMIN_TOKEN) return { ok: false, status: 503, error: '伺服器未設定 ADMIN_TOKEN' };

  // ① 失敗鎖定。**放在所有驗證（含 IP 白名單）之前**——被鎖住的來源連試都不該能試，也不該再寫任何東西。
  let fails = 0;
  if (useGuard) {
    fails = await authLimitPeek(env, 'admfail', who);
  } else {
    try { fails = parseInt((await env.SUBS.get(`admfail:${who}`)) || '0', 10) || 0; } catch (e) { fails = 0; }
  }
  if (fails >= ADMIN_FAIL_MAX) {
    return { ok: false, status: 429, error: `嘗試次數過多，請於 ${Math.round(ADMIN_LOCK_SEC / 60)} 分鐘後再試` };
  }
  const clearFails = async () => {
    if (!fails) return;
    if (useGuard) { await authLimitReset(env, 'admfail', who); return; }
    try { await env.SUBS.delete(`admfail:${who}`); } catch (e) { /* noop */ }
  };

  // ② IP 白名單（選用）。設了才生效——設錯會把自己鎖在外面。
  if (env.ADMIN_IPS) {
    const allow = String(env.ADMIN_IPS).split(',').map((x) => x.trim()).filter(Boolean);
    if (allow.length && !allow.includes(String(ip || ''))) {
      return deny(403, '來源位址不在白名單內', 'ip');
    }
  }

  // ③' 收割權杖：只限 HARVEST_ROUTES，不需要動態碼。白名單與失敗鎖定已在上面照常套用。
  if (env.HARVEST_TOKEN && harvestRoute(request, path)
    && safeEqual(request.headers.get('x-harvest-token') || '', env.HARVEST_TOKEN)) {
    await clearFails();
    if (method !== 'GET') await adminAudit(env, { at, who, path, method, ok: true, reason: 'harvest' });
    return { ok: true, who, harvest: true };
  }

  // ③ 主權杖
  if (!safeEqual(request.headers.get('x-admin-token') || '', env.ADMIN_TOKEN)) {
    return deny(401, 'unauthorized', 'token');
  }

  // ④ 第二把鎖（選用）。設了之後，**光有 ADMIN_TOKEN 進不來**。
  //
  // ⚠️ **動態碼只在登入時驗一次，之後帶登入工作階段。**（2026-09-17）
  //    原本每個請求都要帶動態碼，而一組碼約 90 秒就失效——後台的訂單輪詢每 45 秒一次，
  //    過期後每次輪詢都算一次失敗，8 次就鎖 15 分鐘：**一打開第二把鎖，幾分鐘內就把自己鎖在外面。**
  //    工作階段仍然要搭配 ADMIN_TOKEN（上面第 ③ 步照驗），而且綁來源、8 小時到期；
  //    /v1/admin/login 本身一律要動態碼，不能拿工作階段續命。
  if (env.ADMIN_TOTP_SECRET) {
    const viaSession = path !== '/v1/admin/login'
      && await adminSessionOk(env, request.headers.get('x-admin-session') || '', who);
    if (!viaSession) {
      const st = await totpOk(env.ADMIN_TOTP_SECRET, request.headers.get('x-admin-otp') || '');
      if (!st) return deny(401, request.headers.get('x-admin-session') ? '登入已過期，請重新登入' : '動態驗證碼不正確', 'otp');
      // ⚠️ **同一組動態碼只能用一次**（security-audit run-2 加固建議）。一組碼在前後各一步的
      //    時間窗裡都有效（約 90 秒），被看到或攔到的那一組在這段時間內可以重複用。
      //    記在 AuthGuard（原子、跨機房一致）；沒有 AuthGuard 的本機環境不檢查。
      if (env.AUTH) {
        const once = await authCall(env, { op: 'once', k: 'totp:' + st, ttl: 120 });
        if (!once || !once.ok) return deny(401, '這組動態驗證碼已經用過了，請等下一組', 'otp');
      }
    }
  }

  // 通過了就把失敗計數清掉，避免正常使用累積成鎖定。
  await clearFails();

  // ⑤ 會改變狀態的請求一律留紀錄。GET 不記（量太大，而且不是追查的對象）。
  if (method !== 'GET') await adminAudit(env, { at, who, path, method, ok: true });

  return { ok: true, who };
}

