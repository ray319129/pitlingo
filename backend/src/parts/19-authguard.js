// ---------------------------------------------------------------------------
// AuthGuard：登入相關的計數、單次使用與撤銷（Durable Object，2026-10-02）
//
// ⚠️ **為什麼不能用 KV：** KV 是最終一致的（Cloudflare 文件：寫入後最多約 60 秒才傳到
//    其他機房），而且沒有 CAS。以前的驗證碼全部存在 KV：
//      · 同時送 50 個猜測 → 50 個都讀到「已猜 0 次」→ 「5 次就燒掉」形同虛設
//      · 驗證成功後刪除 → 其他機房 60 秒內仍讀得到 → 同一組碼可以再登入一次
//      · 同時送兩個正確的碼 → 兩個都成功
//    DO 同一時間只處理一個請求（而且在 storage 讀寫期間不會插入別的請求），
//    「讀→判斷→寫」因此是原子的，跨機房也只有一份資料。
//
// ⚠️ **只有一個實例**（名稱 `auth-v1`）。登入是低流量的，一個實例處理所有信箱、IP
//    與全站計數，三種限額才能在同一個交易裡一起判斷。
//
// ⚠️ 儲存的內容**全部是雜湊**：信箱、IP、sub、驗證碼。外流也拿不到原文。
// ---------------------------------------------------------------------------

function authStub(env) {
  if (!env || !env.AUTH) return null;
  return env.AUTH.get(env.AUTH.idFromName('auth-v1'));
}

/** 呼叫 AuthGuard。連不上回 null——呼叫端一律當成「不放行」（fail closed）。 */
async function authCall(env, body) {
  const stub = authStub(env);
  if (!stub) return null;
  try {
    const r = await stub.fetch('https://auth-guard/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function authLimitKey(env, kind, who) {
  return kind + ':' + (await hmac(tokenSecret(env) || 'x', 'lim:' + String(who || ''))).slice(0, 24);
}
/** 讀目前的計數，不加一（管理端的鎖定判斷用）。連不上回 0——不要因為 DO 暫時有事把管理員鎖在外面。 */
async function authLimitPeek(env, kind, who) {
  const lim = AUTH_LIMITS[kind];
  if (!lim) return 0;
  const r = await authCall(env, { op: 'peek', k: await authLimitKey(env, kind, who), win: lim[1] });
  return (r && r.ok && Number(r.n)) || 0;
}
async function authLimitReset(env, kind, who) {
  await authCall(env, { op: 'reset', k: await authLimitKey(env, kind, who) });
}

// ⚠️ 每一次都寫 KV 的便宜端點要有**每日總量**上限（security-audit 2026-10-05 #4）。
//    KV 寫入是整個帳號共用的 1,000 次／天；安裝權杖可以無限申請、IP 可以換，
//    只有「每分鐘」的限流擋不住有人一天打一千次——之後結帳、發碼、共用快取全部寫不進去。
//    上限放 AuthGuard（DO，不吃 KV）；沒有 AuthGuard 的環境（本機）不限。
async function kvWriteBudgetOk(env, kind, who) {
  if (!env.AUTH) return true;
  return !(await authLimited(env, kind, who));
}

/** 嚴格限額（計在 AuthGuard 裡，原子、跨機房一致）。超過或連不上都回 true（擋下）。 */
async function authLimited(env, kind, who) {
  const lim = AUTH_LIMITS[kind];
  if (!lim) return false;
  const key = await authLimitKey(env, kind, who);
  const r = await authCall(env, { op: 'limit', k: key, max: lim[0], win: lim[1] });
  return !(r && r.ok);
}

export class AuthGuard {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
  }

  async fetch(request) {
    let b = null;
    try { b = await request.json(); } catch (e) { b = null; }
    const reply = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
    if (!b || typeof b.op !== 'string') return reply({ ok: false, reason: 'bad' });
    const now = Math.floor(Date.now() / 1000);
    // 每天清一次過期的紀錄（鬧鐘只設一次，到點時在 alarm() 裡重設）
    try {
      if (!(await this.storage.getAlarm())) await this.storage.setAlarm(Date.now() + 86400000);
    } catch (e) { /* 測試環境或不支援鬧鐘時不影響主流程 */ }
    switch (b.op) {
      case 'start': return reply(await this.start(b, now));
      case 'verify': return reply(await this.verify(b, now));
      case 'limit': return reply(await this.limit(b, now));
      case 'check': return reply(await this.check(b, now));
      case 'revoke': return reply(await this.revoke(b, now));
      case 'revokeAll': return reply(await this.revokeAll(b, now));
      case 'once': return reply(await this.once(b, now));
      case 'early': return reply(await this.early(b, now));
      case 'peek': {
        if (!b.k) return reply({ ok: false });
        const r = (await this.storage.get('l:' + b.k)) || {};
        const win = Number(b.win) || Number(r.win) || 0;
        return reply({ ok: true, n: (now - (r.w || 0) < win) ? (r.n || 0) : 0 });
      }
      case 'reset': {
        if (b.k) await this.storage.delete('l:' + b.k);
        return reply({ ok: true });
      }
      case 'reserve': return reply(await this.reserve(b, now));
      case 'refund': return reply(await this.refund(b, now));
      case 'void': return reply(await this.voidIds(b, now));
      case 'voidlist': return reply({ ok: true, list: await this.voidList(now) });
      case 'stats': return reply(await this.statsAdd(b));
      case 'statsGet': return reply(await this.statsGet(b));
      default: return reply({ ok: false, reason: 'bad' });
    }
  }

  // ---- 寄驗證碼 ----------------------------------------------------------
  async start(b, now) {
    if (!b.eh || !b.ih || !b.h) return { ok: false, reason: 'bad' };
    const day = Math.floor(now / 86400);

    // 全站每日上限（保護寄信額度——見 OTP_GLOBAL_DAILY_DEFAULT）
    const gKey = 'g:' + day;
    const g = (await this.storage.get(gKey)) || 0;
    if (g >= (Number(b.globalMax) || OTP_GLOBAL_DAILY_DEFAULT)) return { ok: false, reason: 'global' };
    // 陌生信箱另有一個較小的池（2026-10-28，見 OTP_NEW_DAILY_DEFAULT）：
    // 用大量 IP 灌隨機信箱只能燒掉這一池，既有客戶仍然收得到驗證碼
    const nKey = 'n:' + day;
    const n = b.isNew ? ((await this.storage.get(nKey)) || 0) : 0;
    if (b.isNew && n >= (Number(b.newMax) || OTP_NEW_DAILY_DEFAULT)) return { ok: false, reason: 'global' };

    // 每 IP：10 分鐘 3 封、每天 10 封（擋「換很多信箱狂要碼」）
    const ipKey = 'i:' + b.ih;
    const ip = (await this.storage.get(ipKey)) || {};
    if (!(now - (ip.w10 || 0) < 600)) { ip.w10 = now; ip.n10 = 0; }
    if (ip.dw !== day) { ip.dw = day; ip.dn = 0; }
    if (ip.n10 >= OTP_IP_10MIN_MAX) return { ok: false, reason: 'ip', retry: 600 - (now - ip.w10) };
    if (ip.dn >= OTP_IP_DAILY_MAX) return { ok: false, reason: 'ip', retry: (day + 1) * 86400 - now };

    // 每信箱：鎖定、冷卻、每小時、每天
    const eKey = 'e:' + b.eh;
    const e = (await this.storage.get(eKey)) || {};
    if ((e.lockUntil || 0) > now) return { ok: false, reason: 'locked', retry: e.lockUntil - now };
    if (e.sentAt && now - e.sentAt < OTP_COOLDOWN_SEC) {
      return { ok: false, reason: 'cooldown', retry: OTP_COOLDOWN_SEC - (now - e.sentAt) };
    }
    const hour = Math.floor(now / 3600);
    if (e.hw !== hour) { e.hw = hour; e.hn = 0; }
    if (e.dw !== day) { e.dw = day; e.dn = 0; }
    // 呼叫端可以給更嚴的上限（認領驗證碼用），不可以給更鬆的
    const hMax = Math.min(OTP_HOURLY_MAX, Number(b.hmax) || OTP_HOURLY_MAX);
    const dMax = Math.min(OTP_DAILY_MAX, Number(b.dmax) || OTP_DAILY_MAX);
    // ⚠️ 每小時／每天的上限**依「信箱＋要求來源」分開計**（security-audit run-2 #8）。
    //    以前只算信箱：別人用一個 IP 先把這個信箱今天的 10 封用完，本人整天收不到驗證碼。
    //    現在別人用掉的是「他那個來源」的份；信箱整體另有 OTP_MAILBOX_SPREAD 倍的天花板防轟炸。
    const pKey = 'p:' + b.eh + ':' + b.ih;
    const pr = (await this.storage.get(pKey)) || {};
    if (pr.hw !== hour) { pr.hw = hour; pr.hn = 0; }
    if (pr.dw !== day) { pr.dw = day; pr.dn = 0; }
    // 呼叫端給了更嚴的上限（認領驗證碼）時，信箱整體就是那個上限，不放寬
    const spread = (b.hmax || b.dmax) ? 1 : OTP_MAILBOX_SPREAD;
    if (pr.hn >= hMax || e.hn >= hMax * spread) return { ok: false, reason: 'hourly', retry: (hour + 1) * 3600 - now };
    if (pr.dn >= dMax || e.dn >= dMax * spread) return { ok: false, reason: 'daily', retry: (day + 1) * 86400 - now };

    // 放行：**新碼取代舊碼**（舊的那組從這一刻起失效）
    e.h = b.h; e.exp = now + OTP_TTL_SEC; e.tries = 0; e.sentAt = now;
    e.hn += 1; e.dn += 1; e.touch = now;
    pr.hn += 1; pr.dn += 1; pr.touch = now;
    ip.n10 += 1; ip.dn += 1; ip.touch = now;
    await this.storage.put(eKey, e);
    await this.storage.put(pKey, pr);
    await this.storage.put(ipKey, ip);
    await this.storage.put(gKey, g + 1);
    if (b.isNew) await this.storage.put(nKey, n + 1);
    return { ok: true };
  }

  // ---- 驗證碼比對（計次、燒碼、單次使用都在這裡，原子地完成）---------------
  async verify(b, now) {
    if (!b.eh || !b.ih || !b.h) return { ok: false, reason: 'bad' };
    const ipKey = 'i:' + b.ih;
    const ip = (await this.storage.get(ipKey)) || {};
    if (!(now - (ip.vw || 0) < 3600)) { ip.vw = now; ip.vn = 0; }
    // 每 IP 每小時最多猜錯 10 次（擋「同一台機器對很多信箱各猜幾次」）
    if (ip.vn >= OTP_IP_FAIL_HOURLY_MAX) return { ok: false, reason: 'ip' };

    const eKey = 'e:' + b.eh;
    const e = (await this.storage.get(eKey)) || {};
    const failIp = async () => { ip.vn += 1; ip.touch = now; await this.storage.put(ipKey, ip); };

    if ((e.lockUntil || 0) > now) { await failIp(); return { ok: false, reason: 'locked' }; }
    if (!e.h || now > (e.exp || 0)) {
      // 沒有碼或已過期：與「碼錯了」回同一種結果（呼叫端回同一句話）
      if (e.h) { e.h = null; await this.storage.put(eKey, e); }
      await failIp();
      return { ok: false, reason: 'nocode' };
    }

    if (!safeEqual(String(b.h), String(e.h))) {
      e.tries = (e.tries || 0) + 1;
      if (!(now - (e.fw || 0) < 86400)) { e.fw = now; e.fn = 0; }
      e.fn = (e.fn || 0) + 1;
      e.touch = now;
      let reason = 'wrong';
      if (e.tries >= OTP_MAX_TRIES) { e.h = null; reason = 'burned'; }
      // ⚠️ 鎖定時**把失敗計數歸零**（security-audit run-2 #8）。以前不歸零：一小時後解鎖、
      //    別人再猜錯 1 次又鎖一小時——只要知道 email 就能讓對方整天用不了驗證碼登入。
      if (e.fn >= OTP_EMAIL_FAIL_MAX) { e.h = null; e.lockUntil = now + OTP_EMAIL_LOCK_SEC; e.fn = 0; e.fw = now; reason = 'locked'; }
      await this.storage.put(eKey, e);
      await failIp();
      return { ok: false, reason };
    }

    // ⚠️ **對了就立刻銷毀**——單次使用。DO 是強一致的，這一刻之後任何地方都讀不到它。
    e.h = null; e.tries = 0; e.touch = now;
    await this.storage.put(eKey, e);
    return { ok: true };
  }

  // ---- 通用限額（固定視窗）-------------------------------------------------
  async limit(b, now) {
    const max = Number(b.max) || 0, win = Number(b.win) || 0;
    if (!b.k || !(max > 0) || !(win > 0)) return { ok: false, reason: 'bad' };
    const key = 'l:' + b.k;
    const r = (await this.storage.get(key)) || {};
    if (!(now - (r.w || 0) < win)) { r.w = now; r.n = 0; }
    if (r.n >= max) return { ok: false, reason: 'limit', retry: win - (now - r.w) };
    r.n += 1; r.win = win;
    await this.storage.put(key, r);
    return { ok: true };
  }

  // ---- 只做一次（金流通知的去重）-------------------------------------------
  // ⚠️ 以前去重是「讀 KV order:<no> → 沒有 → 發碼 → 寫 order:<no>」。綠界重送、
  //    或同一筆通知同時打到兩個機房時，兩邊都讀到「沒有」→ 同一筆訂單發兩組碼。
  //    DO 一次只處理一個請求，第一個拿到 ok，其餘一律 dup。
  async once(b, now) {
    if (!b.k) return { ok: false, reason: 'bad' };
    const key = 'o:' + b.k;
    if (b.release) { await this.storage.delete(key); return { ok: true }; }
    if (await this.storage.get(key)) return { ok: false, reason: 'dup' };
    await this.storage.put(key, now + (Number(b.ttl) || 86400));
    return { ok: true };
  }

  // ---- 早鳥名額（2026-11-03）----------------------------------------------
  // 一筆紀錄 `B:early` = { sold: { 帳號: 訂單 }, holds: { 帳號: { o: 訂單, exp } } }。
  // ⚠️ 鍵名開頭不可以是 clean() 會清的字母（e／i／p／l／r／a／o／q／v／t／s／g）——`early` 會被當成 e 開頭刪掉
  // 每個帳號最多一席：同一個帳號重新結帳只是換掉自己的保留，不會多佔一席
  async early(b, now) {
    const s = (await this.storage.get('B:early')) || { sold: {}, holds: {} };
    s.sold = s.sold || {}; s.holds = s.holds || {};
    for (const [a, h] of Object.entries(s.holds)) if (!(h && h.exp > now)) delete s.holds[a];
    const soldN = Object.keys(s.sold).length;
    const heldN = Object.keys(s.holds).length;
    if (b.act === 'count') return { ok: true, sold: soldN, held: heldN };
    const acct = String(b.acct || ''); const id = String(b.id || '');
    const max = Math.max(0, Math.floor(Number(b.max) || 0));
    if (!acct || !id || !max) return { ok: false, reason: 'bad' };
    const mine = !!s.holds[acct];                 // 自己的保留已經算在 heldN 裡
    if (b.act === 'hold') {
      if (s.sold[acct]) return { ok: false, reason: 'dup' };
      if (!mine && soldN + heldN >= max) return { ok: false, reason: 'full' };
      s.holds[acct] = { o: id, exp: now + Math.max(60, Math.floor(Number(b.ttl) || 1800)) };
      await this.storage.put('B:early', s);
      return { ok: true };
    }
    if (b.act === 'sell') {
      if (s.sold[acct]) return s.sold[acct] === id ? { ok: true, dup: true } : { ok: false, reason: 'dup' };
      if (!mine && soldN + heldN >= max) return { ok: false, reason: 'full' };
      delete s.holds[acct];
      s.sold[acct] = id;
      await this.storage.put('B:early', s);
      return { ok: true };
    }
    return { ok: false, reason: 'bad' };
  }

  // ---- 工作階段撤銷 --------------------------------------------------------
  async check(b, now) {
    if (!b.sid) return { ok: false };
    if (await this.storage.get('r:' + b.sid)) return { ok: false, reason: 'revoked' };
    // 整個家族被登出（見 sessionFamily）
    if (b.fam && await this.storage.get('r:F' + b.fam)) return { ok: false, reason: 'revoked' };
    if (b.ah) {
      const before = await this.storage.get('a:' + b.ah);
      // 「登出所有裝置」那一秒（含）之前簽的全部作廢
      if (before && Number(b.iat) <= before) return { ok: false, reason: 'revoked' };
    }
    return { ok: true };
  }

  async revoke(b, now) {
    if (!b.sid) return { ok: false };
    // 存到它原本的到期時間為止（之後簽章本身就過期了，不必再記）
    await this.storage.put('r:' + b.sid, Number(b.exp) || now + SESSION_TTL_DAYS * 86400);
    return { ok: true };
  }

  async revokeAll(b, now) {
    if (!b.ah) return { ok: false };
    await this.storage.put('a:' + b.ah, now);
    return { ok: true };
  }

  // ---- 額度預扣（翻譯的免費額度與付費使用者的每日上限）--------------------
  // ⚠️ **先預扣、再花錢、最後退回沒用到的**（security-audit run-2 #1、#2）。以前是「讀 KV 看用了多少
  //    → 呼叫模型 → 取樣寫回」：20 個請求同時到，20 個都讀到「還剩 300 句」，一共翻了 4,000 句。
  //    這裡一次判斷所有鍵（安裝＋IP、或安裝＋帳號），給的量是每一把都還容得下的最小值，
  //    而且 DO 一次只處理一個請求——並發的請求只會分到剩下的，不會各拿一份。
  // ⚠️ 鍵名本身帶 UTC 日期（新的一天就是新的鍵），exp 只用來讓每日清理知道什麼時候可以丟。
  async reserve(b, now) {
    const keys = (Array.isArray(b.keys) ? b.keys : []).filter((x) => x && typeof x.k === 'string' && Number(x.max) > 0);
    const want = Math.max(0, Math.floor(Number(b.want) || 0));
    if (!keys.length || keys.length > 4) return { ok: false, reason: 'bad' };
    const recs = [];
    let grant = want;
    for (const x of keys) {
      const r = (await this.storage.get('q:' + x.k)) || { n: 0 };
      if (!(Number(r.exp) > now)) r.n = 0;
      r.exp = Number(x.exp) > now ? Number(x.exp) : now + 2 * 86400;
      grant = Math.min(grant, Math.max(0, Number(x.max) - (r.n || 0)));
      recs.push([x.k, r]);
    }
    if (grant > 0) for (const [k, r] of recs) { r.n = (r.n || 0) + grant; await this.storage.put('q:' + k, r); }
    return { ok: true, granted: grant };
  }

  async refund(b, now) {
    const n = Math.max(0, Math.floor(Number(b.n) || 0));
    const keys = (Array.isArray(b.keys) ? b.keys : []).filter((k) => typeof k === 'string').slice(0, 4);
    if (!n || !keys.length) return { ok: true };
    for (const k of keys) {
      const r = await this.storage.get('q:' + k);
      if (r && Number(r.exp) > now) { r.n = Math.max(0, (r.n || 0) - n); await this.storage.put('q:' + k, r); }
    }
    return { ok: true };
  }

  // ---- 通行證作廢清單（security-audit run-2 #15）----------------------------
  // ⚠️ 以前整份清單是 KV 的一個鍵，「讀→改→寫」：解除裝置、退款、停用同時發生時互相覆蓋，
  //    被蓋掉的那一筆＝被踢掉的人繼續看（鐵則 52）。現在每台一筆、在 DO 裡改，不會漏。
  // ⚠️ 每一筆存到通行證自然過期為止（u），之後簽章本身就過期了，不必再記。
  async voidIds(b, now) {
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter((x) => typeof x === 'string' && x).slice(0, 200);
    if (!ids.length) return { ok: true };
    for (const id of ids) {
      if (b.del) await this.storage.delete('v:' + id);
      else await this.storage.put('v:' + id, { t: Number(b.t) || Date.now(), u: Number(b.u) || now + ENTITLEMENT_DAYS * 86400 });
    }
    return { ok: true };
  }

  async voidList(now) {
    const out = [];
    const m = await this.storage.list({ prefix: 'v:' });
    for (const [k, v] of m) {
      if (!k.startsWith('v:') || !v || Number(v.u) < now) continue;
      out.push({ i: k.slice(2), t: v.t, u: v.u });
    }
    return out;
  }

  // ---- 翻譯統計的合併（A11，2026-10-26）---------------------------------------
  // 各 isolate 把這一輪的增量送來，這裡加進 storage（強一致、一次一個請求，不會互相蓋掉），
  // 再把整份寫成 KV 快照給讀取端（後台、彙報、熔斷）。**storage 才是正本**：KV 寫失敗（額度用完）
  // 只代表快照舊了，下一輪會連同新的一起寫出去，數字不會掉。
  // ⚠️ KV 寫入次數與舊做法一樣（每輪 stats＋ustats 各一次），這裡自己算進 __kv——DO 的 env.SUBS 沒有計量器。
  async statsAdd(b) {
    const sk = String(b.sk || ''), uk = String(b.uk || '');
    if (!/^stats:\d{4}-\d\d-\d\d$/.test(sk) || !/^ustats:\d{4}-\d\d-\d\d$/.test(uk)) return { ok: false, reason: 'bad' };
    const kv = this.env && this.env.SUBS;
    // 第一次（部署當天、或正本已清掉）以 KV 上現有的快照當起點，不要從 0 開始把當天前半段蓋掉
    const seed = async (key) => {
      const v = await this.storage.get('s:' + key);
      if (v) return v;
      try { return (kv && JSON.parse((await kv.get(key)) || '{}')) || {}; } catch (e) { return {}; }
    };
    const day = await seed(sk);
    mergeStatRows(day, b.rows, false);
    const users = b.users && Object.keys(b.users).length ? b.users : null;
    const k = day.__kv || (day.__kv = { put: 0, del: 0, get: 0, list: 0 });
    for (const f of ['put', 'del', 'get', 'list']) k[f] = (k[f] || 0) + (Number(b.kv && b.kv[f]) || 0);
    // KV 快照最多 STATS_SNAP_MS 寫一次（見 statsSnap）；這一次會不會寫，先算好才能把它記進 __kv
    const snapAt = (await this.storage.get('snapAt')) || {};
    const nowMs = Date.now();
    const dueS = nowMs - (Number(snapAt[sk]) || 0) >= STATS_SNAP_MS;
    const users0 = b.users && Object.keys(b.users).length;
    const dueU = !!users0 && nowMs - (Number(snapAt[uk]) || 0) >= STATS_SNAP_MS;
    k.put += (kv && dueS ? 1 : 0) + (kv && dueU ? 1 : 0);   // 下面這一次（或兩次）快照寫入
    const alerts = kvQuotaAlerts(k, kvDailyCap(this.env));
    await this.storage.put('s:' + sk, day);
    let uday = null;
    if (users) {
      uday = await seed(uk);
      // 滿了併進 __others（同 flushUserStats）；'harvest' 一定要有自己的一列（收割熔斷靠它）
      const fold = {};
      for (const [id, r] of Object.entries(users)) {
        const target = (uday[id] || id === 'harvest' || Object.keys(uday).length < USTATS_MAX_ROWS) ? id : '__others';
        mergeStatRows(fold, { [target]: r }, true);
        if (!uday[target]) uday[target] = Object.assign(emptyStatRow(), { plan: '', last: 0 });
      }
      mergeStatRows(uday, fold, true);
      await this.storage.put('s:' + uk, uday);
    }
    let kvFail = 0;
    if (kv) {
      const dirty = (await this.storage.get('snapDirty')) || {};
      if (dueS) { try { await kv.put(sk, JSON.stringify(day), { expirationTtl: STATS_TTL[0] }); snapAt[sk] = nowMs; delete dirty[sk]; } catch (e) { kvFail++; dirty[sk] = 1; } } else dirty[sk] = 1;
      if (uday) {
        if (dueU) { try { await kv.put(uk, JSON.stringify(uday), { expirationTtl: STATS_TTL[1] }); snapAt[uk] = nowMs; delete dirty[uk]; } catch (e) { kvFail++; dirty[uk] = 1; } } else dirty[uk] = 1;
      }
      await this.storage.put({ snapAt, snapDirty: dirty });
      // 還沒寫的快照：鬧鐘排在「最早可以寫」的那一刻（可能比每日清理早）
      if (Object.keys(dirty).length) {
        const due = Math.min(...Object.keys(dirty).map((x) => (Number(snapAt[x]) || 0) + STATS_SNAP_MS));
        try { const cur = await this.storage.getAlarm(); if (!cur || cur > due) await this.storage.setAlarm(Math.max(due, nowMs + 1000)); } catch (e) { /* noop */ }
      }
    }
    return { ok: true, alerts, put: k.put, kvFail };
  }

  /**
   * 統計正本（給讀今天、昨天統計的地方：熔斷、後台、彙報）。KV 快照最多落後 STATS_SNAP_MS，
   * 而 isolate 落地之後就把自己的未落地量清掉了——讀 KV 的話數字會暫時倒退，所以近兩天一律讀這裡。
   */
  async statsGet(b) {
    const key = String(b.key || '');
    if (!/^u?stats:\d{4}-\d\d-\d\d$/.test(key)) return { ok: false, reason: 'bad' };
    return { ok: true, day: (await this.storage.get('s:' + key)) || null };
  }

  /** 鬧鐘到點：把還沒寫的統計快照寫進 KV（statsAdd 節流下來的） */
  async statsSnapFlush() {
    const kv = this.env && this.env.SUBS;
    if (!kv) return;
    const dirty = (await this.storage.get('snapDirty')) || {};
    const keys = Object.keys(dirty);
    if (!keys.length) return;
    const snapAt = (await this.storage.get('snapAt')) || {};
    const nowMs = Date.now();
    let puts = 0;
    for (const key of keys) {
      if (nowMs - (Number(snapAt[key]) || 0) < STATS_SNAP_MS) continue;
      const v = await this.storage.get('s:' + key);
      if (!v) { delete dirty[key]; continue; }
      try {
        await kv.put(key, JSON.stringify(v), { expirationTtl: key.startsWith('ustats:') ? STATS_TTL[1] : STATS_TTL[0] });
        snapAt[key] = nowMs; delete dirty[key]; puts++;
      } catch (e) { /* 留著，下一輪再寫 */ }
    }
    // 自己寫的 KV 記進當天的計數（鐵則 43／45：計量器要看得到）
    if (puts) {
      const sk = statsKey();
      const d = await this.storage.get('s:' + sk);
      if (d) { const k = d.__kv || (d.__kv = { put: 0, del: 0, get: 0, list: 0 }); k.put += puts; await this.storage.put('s:' + sk, d); }
    }
    await this.storage.put({ snapAt, snapDirty: dirty });
    return Object.keys(dirty).length ? Math.min(...Object.keys(dirty).map((x) => (Number(snapAt[x]) || 0) + STATS_SNAP_MS)) : 0;
  }

  // ---- 每日清理 ------------------------------------------------------------
  // ⚠️ **分頁讀**（security-audit run-2 需驗證 #7）。以前一次 list() 全部讀進記憶體，
  //    資料量（每位免費使用者每天一把額度鍵）長大之後，鬧鐘會撞到 DO 的記憶體或 CPU 上限，
  //    清理失敗 → 資料更多 → 更容易失敗。每頁 500 筆、最多 40 頁，下一輪鬧鐘接著清。
  async alarm() {
    // 統計快照（A11 之後的節流）。⚠️ 這個鬧鐘以前只做每日清理；現在也被 statsAdd 提早叫醒，清理要看 cleanAt
    let snapNext = 0;
    try { snapNext = (await this.statsSnapFlush()) || 0; } catch (e) { snapNext = Date.now() + STATS_SNAP_MS; }
    const cleanAt = Number(await this.storage.get('cleanAt')) || 0;
    if (cleanAt && Date.now() < cleanAt) {
      // 最早 60 秒後：KV 寫不進去時（額度用完）待寫的那一份「最早可寫時間」早就過了，不夾住的話鬧鐘會一直在原地響
      await this.storage.setAlarm(snapNext ? Math.min(Math.max(snapNext, Date.now() + 60000), cleanAt) : cleanAt);
      return;
    }
    await this.clean();
    const nextClean = Date.now() + 86400000;
    await this.storage.put('cleanAt', nextClean);
    await this.storage.setAlarm(snapNext ? Math.min(Math.max(snapNext, Date.now() + 60000), nextClean) : nextClean);
  }

  async clean() {
    const now = Math.floor(Date.now() / 1000);
    const day = Math.floor(now / 86400);
    let after;
    for (let page = 0; page < 40; page++) {
      const opt = { limit: 500 };
      if (after !== undefined) opt.startAfter = after;
      const all = await this.storage.list(opt);
      const drop = [];
      let last;
      for (const [k, v] of all) {
        last = k;
        const t = k[0];
        if (t === 'g' && Number(k.slice(2)) < day - 2) drop.push(k);
        else if ((t === 'e' || t === 'i' || t === 'p') && v && (v.touch || 0) < now - 2 * 86400 && !((v.lockUntil || 0) > now)) drop.push(k);
        else if (t === 'l' && v && (v.w || 0) + (v.win || 0) < now - 86400) drop.push(k);
        else if (t === 'r' && Number(v) < now) drop.push(k);
        else if (t === 'a' && Number(v) + SESSION_TTL_DAYS * 86400 < now) drop.push(k);
        else if (t === 'o' && Number(v) < now) drop.push(k);
        else if (t === 'q' && v && Number(v.exp) < now) drop.push(k);
        else if (t === 'v' && v && Number(v.u) < now) drop.push(k);
        else if (t === 't' && Number(v) < now) drop.push(k);
        // 翻譯統計的正本只留 3 天（KV 快照另有自己的 TTL，後台與彙報讀 KV）
        else if (t === 's' && (Date.parse(k.replace(/^s:u?stats:/, '') + 'T00:00:00Z') || Infinity) < (day - 3) * 86400000) drop.push(k);
      }
      for (let i = 0; i < drop.length; i += 128) await this.storage.delete(drop.slice(i, i + 128));
      // 測試用的假儲存不認 limit／startAfter、一次回全部：沒有前進就停
      if (!all.size || all.size < 500 || last === undefined || last === after) break;
      after = last;
    }
  }
}

/**
 * Cloudflare Turnstile（機器人驗證）。**沒設定 TURNSTILE_SECRET 時不啟用**——直接放行。
 *
 * 啟用方式：建立 widget（網域 pitlingo.com）→ `wrangler secret put TURNSTILE_SECRET`、
 * `[vars] TURNSTILE_SITE_KEY`、`TURNSTILE_HOSTNAMES = "pitlingo.com"`。
 * 驗證依官方的標準做法：success、action 與網域都要對；連不上 siteverify 一律擋（fail closed）。
 * ⚠️ token 是單次的，前端每送一次就要 reset widget。
 */
async function turnstileOk(env, token, ip, action) {
  if (!env.TURNSTILE_SECRET) return true;
  const hosts = new Set(String(env.TURNSTILE_HOSTNAMES || '').split(',').map((h) => h.trim()).filter(Boolean));
  if (typeof token !== 'string' || !token || token.length > 2048 || !hosts.size) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: String(ip || '') }),
    });
    if (!r.ok) return false;
    const d = await r.json();
    return d.success === true && d.action === action && hosts.has(d.hostname);
  } catch (e) {
    return false;
  }
}

/**
 * 用已驗證的 email 登入（必要時建立帳號）。
 *
 * ⚠️ **同一個 email 不論用 Google 還是驗證碼進來，都必須是同一個帳號。**
 *    分成兩個的話，使用者會用 Google 登入看到訂單、用驗證碼登入看到空的，
 *    然後合理地認為我們弄丟了他的東西。
 *
 * 做法：`gsub:<email>` 是「這個 email 屬於哪個帳號」的唯一真相。
 * 驗證碼登入時先問它——已經有主人就登入那個帳號（不論主人是 Google 還是
 * email 建的），沒有才新建一個 `em:` 開頭的帳號。
 */
/**
 * email 帳號的 sub。
 *
 * ⚠️ **不可以直接把 email 當 sub。** 兩個理由：
 *    1. email 含有點，而工作階段權杖是用點分隔的——會把 sub 切斷（已踩過）
 *    2. sub 會進權杖，而權杖會出現在瀏覽器儲存、日誌、網址裡。
 *       **不要把使用者的信箱放進去。**
 */
async function emailSub(env, email) {
  return 'em' + (await hmac(tokenSecret(env) || 'x', 'sub:' + accountKey(email))).slice(0, 32);
}

async function emailLogin(env, emailRaw) {
  const email = accountKey(emailRaw);
  const now = nowSec();
  const owner = await env.SUBS.get(gsubKey(email));
  if (owner) {
    const acc = await readGoogleAccount(env, owner);
    if (acc) {
      if (now - (acc.lastLogin || 0) > 86400) {
        acc.lastLogin = now;
        await env.SUBS.put(acctgKey(acc.sub || owner), JSON.stringify(acc));
      }
      return { acc, created: false };
    }
    // 指標在但帳號不見了（被手動刪過）。當成沒有，重新建立。
  }
  const sub = await emailSub(env, email);
  const acc = {
    sub, email, name: email.split('@')[0], emails: [email],
    createdAt: now, lastLogin: now, via: 'email',
  };
  await env.SUBS.put(gsubKey(email), sub);
  await env.SUBS.put(acctgKey(sub), JSON.stringify(acc));
  return { acc, created: true };
}

/**
 * 把「用驗證碼建的帳號」併進 Google 帳號。
 *
 * ⚠️ 情境一定會發生：先用 email 驗證碼登入過，後來改用 Google（同一個信箱）。
 *    不併的話 `gsub` 還指著舊帳號，Google 那邊會看到一個空的新帳號。
 *
 * ⚠️ **舊的工作階段權杖不可以立刻失效**——使用者可能正開著另一個分頁。
 *    所以留一筆 `subalias:` 讓舊 sub 還查得到人。
 */
async function mergeEmailAccountIntoGoogle(env, emailSub, googleSub) {
  const old = await readGoogleAccount(env, emailSub);
  if (!old) return null;
  const merged = await readGoogleAccount(env, googleSub);
  const emails = [...new Set([...(merged ? merged.emails : []), ...(old.emails || [])])];
  // aliases：舊 sub 的權杖還透過別名有效，「登出所有裝置」要連它們一起撤銷
  const aliases = [...new Set([...((merged && merged.aliases) || []), ...(old.aliases || []), emailSub])];
  const acc = Object.assign({}, old, merged || {}, { sub: googleSub, emails, aliases });
  await env.SUBS.put(acctgKey(googleSub), JSON.stringify(acc));
  await env.SUBS.put('subalias:' + emailSub, googleSub, { expirationTtl: SESSION_TTL_DAYS * 86400 });
  for (const em of emails) await env.SUBS.put(gsubKey(em), googleSub);
  // ⚠️ **舊記錄一定要刪掉，而且一定要在別名寫好之後才刪。**
  //    不刪的話 `readGoogleAccount(舊 sub)` 會直接讀到那份舊的，
  //    別名那條路永遠走不到——使用者拿著舊權杖會看到一個**合併前的空帳號**，
  //    而且完全不報錯。順序反過來則更糟：中途失敗帳號就消失了。
  try { await env.SUBS.delete(acctgKey(emailSub)); } catch (e) { /* 別名已經在了，刪不掉不致命 */ }
  return acc;
}

/**
 * 管理端：一個帳號（email）底下的全部東西。
 *
 * 這同時是**客服最常需要的那一頁**（「這個人寄信來，他買了什麼？」）
 * 與**帳號系統的預演**：日後真的做登入時，這支的回傳內容就是
 * 使用者登入後看到的畫面，不需要改資料結構。
 */
async function handleAccount(env, url) {
  const acct = accountKey(url.searchParams.get('email'));
  if (!acct || !acct.includes('@')) return err('請提供 email', 400, 'E10');
  return json(await accountView(env, acct));
}

/**
 * 一個 email 底下的全部東西（純資料，不含 Response）。
 *
 * ⚠️ **後台的「查一個客戶」與使用者登入後看到的畫面，用的是同一支。**
 *    分成兩份的話，兩邊遲早會不一致——而不一致的方向通常是
 *    「客服看得到、使用者看不到」，那看起來就像我們弄丟了他的東西。
 */
async function accountView(env, acct, opt) {
  // Licenses：走既有的 email 索引
  let keys = [];
  try { keys = JSON.parse((await env.SUBS.get(`licmail:${acct}`)) || '[]'); } catch (e) { keys = []; }
  const licenses = [];
  for (const k of keys.slice(0, 50)) {
    const lic = await readLicense(env, normLicense(k));
    if (!lic) continue;
    // 換發掉的舊碼不列（索引在換發時已經換成新碼，這裡是給舊資料的保險）
    if (lic.replacedBy) continue;
    const expired = !!(lic.expiresAt && lic.expiresAt * 1000 < Date.now());
    licenses.push({
      licenseKey: prettyLicense(normLicense(k)),
      plan: lic.plan,
      planLabel: (PLANS[lic.plan] || {}).label || lic.plan,
      state: lic.revoked ? 'revoked' : expired ? 'expired' : 'active',
      // 現在就能用（不在比賽週空檔、不是還沒生效的下一季票）。擴充功能續期被拒時靠它挑下一組碼——
      // state 只看到期，還沒開始的也是 active，挑到它會在兩組碼之間來回換（2026-10-30）
      usable: !licenseProblem(lic),
      startsAt: lic.startsAt || null,
      expiresAt: lic.expiresAt || null,
      devices: (lic.devices || []).length,
      // 每一台的前 8 碼與最後使用時間。擁有者要靠它認出「哪一台不是我的」（授權碼外洩時）。
      // 只給前 8 碼：完整的 installId 是那台裝置的身分，不需要離開伺服器。
      deviceList: (lic.devices || []).map((d) => ({
        id: String(d.installId || '').slice(0, 8), addedAt: d.addedAt || null, lastSeen: d.lastSeen || null,
      })),
      reissuedAt: lic.reissuedAt || null,
      orderId: lic.orderId || '',
      paid: lic.paid || 0,
      // 代訂送的那一週要標出來——它與使用者自己買的意義完全不同
      fromService: !!(PLANS[lic.plan] && PLANS[lic.plan].fromService),
      gpCount: lic.gpCount || null,
      gpName: lic.gpName || null,
      // 可以轉送給朋友的附贈比賽週（GIFT_TRANSFER 沒開時一律是空的，見 handleAccountGift）
      giftable: giftableWeeks(env, lic),
      giftedOut: Array.isArray(lic.giftedOut) ? lic.giftedOut.map((x) => ({ gpId: x.gpId, to: x.to, at: x.at })) : [],
    });
  }

  // Purchases：訂單清單的 metadata（不逐筆 get）。
  // ⚠️ **走 orderRows 的 5 分鐘快取，不要自己列舉**（2026-10-04 修，鐵則 47）。
  //    以前每次呼叫都列舉整個 ord: 前綴，而 /v1/account/me 對帳號的**每一個信箱**各呼叫一次、
  //    擴充功能**每次打開彈出視窗**都會打 /v1/account/me——list 也是 1,000 次／天。
  //    代價：別的 isolate 剛寫入的訂單最多晚 5 分鐘出現（授權碼走 licmail 索引，不受影響）。
  const { rows } = await orderRows(env, opt);
  const purchases = rows.filter((o) => accountKey(o.email) === acct).map((o) => ({
    no: o.no, status: o.status, at: o.at, price: o.price, summary: o.summary, mailed: o.mailed, manual: o.manual,
  }));

  const paid = purchases.filter((p) => p.status === 'paid');
  return {
    ok: true,
    account: acct,
    licenses,
    purchases,
    summary: {
      licenses: licenses.length,
      active: licenses.filter((l) => l.state === 'active').length,
      orders: purchases.length,
      paidOrders: paid.length,
      lifetimeTwd: paid.reduce((n, p) => n + (p.price || 0), 0),
      // 孤兒偵測：有授權碼卻找不到對應的訂單，日後接帳號時會接不上
      orphanLicenses: licenses.filter((l) => l.orderId
        && !purchases.some((p) => p.no === l.orderId)).length,
    },
  };
}

/**
 * 管理端：單位經濟。
 *
 * ⚠️ **量得到的與估出來的必須分開標示。**
 *
 *    量得到：成本（token 實際用量 × 單價）、營收（已付款訂單）、
 *            使用者數、翻譯句數、快取命中率。
 *    估出來：匯率、行銷花費、續訂季數——這三個系統裡沒有資料，只能由你填。
 *
 *    把兩者混在一起呈現，會讓一個「我猜的續訂率」看起來像實測的 LTV，
 *    然後那個數字被拿去決定廣告預算。所以回傳裡 assumptions 是獨立欄位，
 *    後台也必須把它標成估算。
 */
async function handleEcon(env, url) {
  const days = Math.max(1, Math.min(120, Number(url.searchParams.get('days')) || 30));
  const ops = await opsConfig(env);
  const fx = ops.fxTwdPerUsd;

  // ---- 成本（實測）----
  let usd = 0;
  let translated = 0;
  let cachedHits = 0;
  const perVideo = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    let day = {};
    try { day = await readStatsDay(env, statsKey(d)); } catch (e) { day = {}; }
    for (const [cid, r] of Object.entries(day)) {
      const c = costOf({
        input_tokens: r.in, output_tokens: r.out,
        cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
      });
      usd += c;
      translated += r.translated || 0;
      cachedHits += r.cached || 0;
      perVideo[cid] = (perVideo[cid] || 0) + c;
    }
  }

  // ---- 使用者（實測）----
  let users = 0;
  let paidUsers = 0;
  let freeUsers = 0;
  let usdPaid = 0;
  let usdFree = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    let day = {};
    try { day = await readStatsDay(env, ustatsKey(d)); } catch (e) { day = {}; }
    for (const [id, r] of Object.entries(day)) {
      if (id === '__others') continue;
      users++;
      const c = costOf({
        input_tokens: r.in, output_tokens: r.out,
        cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
      });
      // 本賽季免費體驗（free_season）有通行證但沒付錢：算免費的
      if (r.plan && r.plan !== 'trial' && !(PLANS[r.plan] && PLANS[r.plan].free)) { paidUsers++; usdPaid += c; } else { freeUsers++; usdFree += c; }
    }
  }
  // ⚠️ 跨日會重複計算同一個安裝（我們刻意不做跨日去重——那需要保存
  //    每個 installId 的全部歷史，成本與隱私都不划算）。
  //    所以這裡是**人日**，不是「不重複人數」。名字要誠實。
  const userDays = users;

  // ---- 營收（實測，來自訂單）----
  let revenueTwd = 0;
  let orders = 0;
  let cursor;
  const since = nowSec() - days * 86400;
  for (let page = 0; page < 5; page++) {
    const r = await env.SUBS.list({ prefix: 'ord:', limit: 1000, cursor });
    for (const k of r.keys) {
      const m = k.metadata || {};
      if (m.s !== 'paid' || (m.at || 0) < since) continue;
      revenueTwd += Number(m.t) || 0;
      orders++;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }

  const costTwd = usd * fx;
  const grossTwd = revenueTwd - costTwd;
  const arpu = orders ? revenueTwd / orders : null;

  return json({
    ok: true,
    days,
    measured: {
      costUsd: +usd.toFixed(4),
      costTwd: +costTwd.toFixed(1),
      revenueTwd,
      orders,
      grossTwd: +grossTwd.toFixed(1),
      grossMargin: revenueTwd ? +(grossTwd / revenueTwd).toFixed(4) : null,
      translated,
      cachedHits,
      cacheHitRate: (translated + cachedHits) ? +(cachedHits / (translated + cachedHits)).toFixed(4) : null,
      // 題目要的那幾個「每 X 成本」
      usdPerTranslation: translated ? +(usd / translated).toFixed(6) : null,
      usdPerCacheMiss: translated ? +(usd / translated).toFixed(6) : null,
      usdPerRace: Object.keys(perVideo).length
        ? +(usd / Object.keys(perVideo).length).toFixed(4) : null,
      videos: Object.keys(perVideo).length,
      userDays,
      paidUserDays: paidUsers,
      freeUserDays: freeUsers,
      usdPerActiveUserDay: userDays ? +(usd / userDays).toFixed(6) : null,
      usdPerPaidUserDay: paidUsers ? +(usdPaid / paidUsers).toFixed(6) : null,
      usdPerTrialUserDay: freeUsers ? +(usdFree / freeUsers).toFixed(6) : null,
      arpuTwd: arpu == null ? null : +arpu.toFixed(1),
    },
    // ⚠️ 以下三個是**你填的估算值**，不是量出來的
    assumptions: {
      fxTwdPerUsd: fx,
      marketingTwd: ops.marketingTwd,
      ltvSeasons: ops.ltvSeasons,
    },
    estimated: {
      // CAC：行銷花費 ÷ 這段期間的付費訂單數
      cacTwd: orders ? +(ops.marketingTwd / orders).toFixed(1) : null,
      // LTV：平均客單價 × 預期續訂季數 − 服務該客戶的成本
      ltvTwd: arpu == null ? null
        : +((arpu * ops.ltvSeasons) - (paidUsers ? (usdPaid / paidUsers) * fx : 0)).toFixed(1),
      ltvCac: (orders && ops.marketingTwd > 0 && arpu != null)
        ? +(((arpu * ops.ltvSeasons) - (paidUsers ? (usdPaid / paidUsers) * fx : 0))
            / (ops.marketingTwd / orders)).toFixed(2)
        : null,
    },
  });
}

/**
 * 管理端：每位使用者花了多少。
 *
 * 直播測試要回答的問題就是這一個——「有沒有人在燒錢」「付費者的平均成本」。
 * 用影片分組看不出來：一支熱門影片的成本可能來自 1 個人也可能來自 100 個人，
 * 那兩件事的意義完全相反。
 */
async function handleUserStats(env, url) {
  const days = Math.max(1, Math.min(31, Number(url.searchParams.get('days')) || 1));
  const merged = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    let day = {};
    try { day = await readStatsDay(env, ustatsKey(d)); } catch (e) { day = {}; }
    // 今天這一格疊上這個 isolate 還沒落地的量（同上：讀取不可以觸發寫入）
    if (i === 0) {
      for (const [id, r] of Object.entries(upending_)) {
        const t = day[id] || (day[id] = {
          calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, plan: '', last: 0,
        });
        for (const k of ['calls', 'translated', 'cached', 'in', 'out', 'cacheRead', 'cacheWrite']) {
          t[k] = (t[k] || 0) + (r[k] || 0);
        }
        t.plan = r.plan || t.plan;
        t.last = Math.max(t.last || 0, r.last || 0);
      }
    }
    for (const [id, r] of Object.entries(day)) {
      const t = merged[id] || (merged[id] = {
        calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, plan: '', last: 0,
      });
      for (const k of ['calls', 'translated', 'cached', 'in', 'out', 'cacheRead', 'cacheWrite']) {
        t[k] = (t[k] || 0) + (r[k] || 0);
      }
      t.plan = r.plan || t.plan;
      t.last = Math.max(t.last || 0, r.last || 0);
    }
  }

  const rows = Object.entries(merged).map(([id, r]) => ({
    installId: id,
    plan: r.plan || 'trial',
    calls: r.calls,
    translated: r.translated,
    cached: r.cached,
    // 共用快取命中率：這是整個商業模式的分母
    hitRate: (r.translated + r.cached) ? r.cached / (r.translated + r.cached) : null,
    usd: +costOf({
      input_tokens: r.in, output_tokens: r.out,
      cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
    }).toFixed(6),
    lastAt: r.last || null,
  })).sort((a, b) => b.usd - a.usd);

  const isFree = (r) => !r.plan || r.plan === 'trial' || !!(PLANS[r.plan] && PLANS[r.plan].free);
  const paid = rows.filter((r) => !isFree(r));
  const free = rows.filter(isFree);
  const sum = (a) => a.reduce((x, r) => x + r.usd, 0);

  return json({
    ok: true,
    days,
    rows: rows.slice(0, 300),
    totals: {
      users: rows.length,
      paidUsers: paid.length,
      freeUsers: free.length,
      usd: +sum(rows).toFixed(4),
      usdPaid: +sum(paid).toFixed(4),
      usdFree: +sum(free).toFixed(4),
      // 單位經濟的兩個核心數字
      usdPerPaidUser: paid.length ? +(sum(paid) / paid.length).toFixed(4) : null,
      usdPerFreeUser: free.length ? +(sum(free) / free.length).toFixed(4) : null,
    },
  });
}

/**
 * 記錄「這支影片沒有官方字幕軌」。
 *
 * 為什麼要記：**我們目前不知道 F1TV 有多少內容沒有字幕。**
 * 沒有字幕的影片根本不會建立 bundle，等於在資料裡消失——
 * 於是「要不要自己做語音辨識」這個決定完全沒有數字可以依據。
 *
 * ⚠️ 這是**用戶端回報的**，所以可以偽造。但代價很低（只是統計），
 *    而且用「回報次數」當信心值：同一支被不同人回報越多次越可信。
 *
 * ⚠️ **每支最多寫三次。** KV 寫入是這個專案的天花板（坑 #10），
 *    熱門影片被幾百人看過就寫幾百次的話，光這一項就能吃掉整天的額度。
 */
const NOSUB_MAX_REPORTS = 3;

async function noteNoSubtitles(env, cid, slug) {
  if (!env.SUBS || !cid) return;
  const key = `nosub:${cid}`;
  let rec = null;
  try { rec = JSON.parse((await env.SUBS.get(key)) || 'null'); } catch (e) { rec = null; }
  if (rec && (rec.n || 0) >= NOSUB_MAX_REPORTS) return;      // 夠了，不再寫
  // 新的 cid 全站每天最多 200 筆（每個新 cid 都是一次 KV 寫入）
  if (!rec && !(await kvWriteBudgetOk(env, 'nosuball', 'all'))) return;
  const next = {
    cid,
    slug: (rec && rec.slug) || String(slug || '').slice(0, 120),
    n: ((rec && rec.n) || 0) + 1,
    first: (rec && rec.first) || nowSec(),
    at: nowSec(),
  };
  await env.SUBS.put(key, JSON.stringify(next), {
    expirationTtl: 400 * 86400,
    metadata: { n: next.n, slug: next.slug, at: next.at },
  });
}

/**
 * 管理端：訂單列表。
 *
 * 只讀 metadata，所以一頁 1000 筆等於 1 次 KV 操作。
 * KV 的 list 是照鍵名字典序，而訂單編號的前綴是零補的時間戳，
 * 所以**掃回來的順序是由舊到新**——要顯示最新的必須全部撈回來再反轉。
 * 上限設五頁（5,000 筆）；真的超過時寧可截斷並說出來，也不要讓後台逾時打不開。
 */
/**
 * 一次性修復：補上「付款成功卻停在未完成付款」的訂單記錄。
 *
 * 為什麼需要：把訂單標成已付款的那段程式碼從 ce20dbd 起放錯了函式（見 webhook 的註解），
 * 在修正之前付款的每一筆訂單，授權碼有發、信有寄，但 `ord:` 記錄永遠停在 created。
 * 修掉程式碼不會回頭修資料——**這支負責把舊資料補回來**。
 *
 * 判斷依據是 webhook 自己寫下的 `order:<編號>`（防重放用，發碼成功才會有），
 * 不是猜測：有那筆就代表綠界確實通知付款成功、我們確實發了碼。
 *
 * 順便修第二個問題：結帳時把「代訂附贈的比賽週」也記成待處理的代訂服務（key 為 week_svc）。
 *
 * ⚠️ 預設只試算（apply: false），回傳會改哪幾筆；確認後再送 apply: true。
 * ⚠️ 可以重複執行：已經是 paid、沒有附贈列的訂單不會被寫入。
 */
async function handleOrderRepairPaid(request, env) {
  const body = await request.json().catch(() => ({}));
  const apply = body && body.apply === true;
  const out = { apply, checked: 0, markedPaid: [], giftFixed: [], missingOrder: [] };

  let cursor;
  for (let page = 0; page < 10; page++) {
    const r = await env.SUBS.list({ prefix: 'order:', limit: 1000, cursor });
    for (const k of r.keys) {
      const no = k.name.slice('order:'.length);
      out.checked++;
      const ord = await readOrder(env, no);
      if (!ord) { out.missingOrder.push(no); continue; }
      const fields = {};
      if (ord.status !== 'paid') {
        const val = await env.SUBS.get(k.name);
        const lic = val && val !== 'nolicense' ? await readLicense(env, val) : null;
        const mailFail = await env.SUBS.get(`mailfail:${no}`);
        Object.assign(fields, {
          status: 'paid',
          paidAt: (lic && lic.createdAt) || ord.updatedAt || ord.at || nowSec(),
          licenseKey: val && val !== 'nolicense' ? prettyLicense(val) : null,
          // 沒有 mailfail 記錄就當作寄出了（寄信失敗一定會留那筆）
          mailed: !mailFail,
          repairedAt: nowSec(),
        });
        out.markedPaid.push(no);
      }
      if (Array.isArray(ord.services) && ord.services.some((s) => s && s.key === 'week_svc')) {
        fields.services = ord.services.filter((s) => s && s.key !== 'week_svc');
        out.giftFixed.push(no);
      }
      if (apply && Object.keys(fields).length) await patchOrder(env, no, fields);
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return json({ ok: true, ...out });
}

// ⚠️ **與 bundle 清單同一個毛病**（2026-09-25 稽核時一起發現）：
//    後台的訂單徽章每 45 秒輪詢一次 `/v1/admin/orders?feed=1`，而它每次都列舉整個
//    `ord:` 前綴 —— 後台開著就是 1.33 次／分鐘 ＝ **一天 1,920 次列舉**，上限 1,000。
//    訂單只有在有人買東西時才變，快取 5 分鐘完全夠用；本 isolate 寫訂單時直接作廢。
//    ⚠️ 付款通知可能落在別的 isolate，那時要等過期——所以徽章最壞會晚 5 分鐘亮，
//       這對「有沒有人工訂單要處理」完全無所謂。
const ORDER_LIST_TTL_MS = 300000;
let orderListCache = null;         // { at, rows, truncated }

function invalidateOrderList() { orderListCache = null; }

async function handleOrderList(env, url) {
  const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
  const status = url.searchParams.get('status') || 'all';
  const feed = url.searchParams.get('feed') === '1';
  const { rows, truncated } = await orderRows(env);
  return orderListReply(rows, truncated, { q, status, feed });
}

/**
 * 全部訂單的摘要（metadata），快取 5 分鐘。後台訂單清單與「我的帳號」共用。
 * 回傳的陣列是快取本身，**呼叫端不可以改它**。
 */
async function orderRows(env, opt) {
  // fresh：後台全域查詢用（RESELL-OPS 第 7 節「確保都是最新資訊」）。只在有人按查詢時列舉一次，
  //        不在任何輪詢路徑上——鐵則 47 的那筆帳（list 也是 1,000／天）只算人手按的次數。
  if (!(opt && opt.fresh) && orderListCache && Date.now() - orderListCache.at < ORDER_LIST_TTL_MS) {
    return { rows: orderListCache.rows, truncated: orderListCache.truncated };
  }
  const rows = [];
  let cursor;
  let truncated = false;
  for (let page = 0; page < 5; page++) {
    const r = await env.SUBS.list({ prefix: 'ord:', limit: 1000, cursor });
    for (const k of r.keys) {
      const m = k.metadata || {};
      rows.push({
        no: k.name.slice(4),
        status: m.s || 'created',
        at: m.at || 0,
        price: m.t || 0,
        email: m.e || '',
        summary: m.l || '',
        manual: !!m.n,
        mailed: !!m.m,
      });
    }
    if (r.list_complete) { cursor = null; break; }
    cursor = r.cursor;
    if (page === 4) truncated = true;
  }
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  orderListCache = { at: Date.now(), rows, truncated };
  return { rows, truncated };
}

/** 把清單整理成回應。**篩選一律在這裡做**，快取存的是未篩選的原始清單。 */
function orderListReply(rows, truncated, opt) {
  const { q, status, feed } = opt;

  // 通知輪詢用的輕量模式：只回最新一筆已付款的摘要，回應只有幾十位元組
  if (feed) {
    const paid = rows.filter((r) => r.status === 'paid');
    return json({
      ok: true,
      latest: paid[0] || null,
      paidCount: paid.length,
      pendingManual: paid.filter((r) => r.manual).length,
      mailFailed: paid.filter((r) => !r.mailed).length,
    });
  }

  const out = rows.filter((r) => {
    if (status !== 'all' && r.status !== status) return false;
    if (q && ![r.no, r.email, r.summary].some((v) => String(v).toLowerCase().includes(q))) return false;
    return true;
  });
  return json({
    ok: true, rows: out.slice(0, 500), total: rows.length,
    shown: Math.min(out.length, 500), truncated,
  });
}

/** 管理端：單筆訂單的完整內容（列表只有摘要）。 */
async function handleOrderGet(env, url) {
  const no = String(url.searchParams.get('no') || '').trim();
  const o = await readOrder(env, no);
  if (!o) return err('查無此訂單', 404);
  let mf = null;
  let pay = null;
  try { mf = JSON.parse((await env.SUBS.get(`mailfail:${no}`)) || 'null'); } catch (e) { /* noop */ }
  try { pay = JSON.parse((await env.SUBS.get(`payinfo:${no}`)) || 'null'); } catch (e) { /* noop */ }
  return json({ ok: true, order: o, mailFail: mf, payInfo: pay });
}

/**
 * 管理端：改一筆訂單。
 *
 * 只開放三件客服真的要做的事：
 *   note        寫備註（例如「已用 LINE 聯繫」）
 *   serviceDone 代訂結案——**不做這個的話，代訂訂單付完款就沒人知道處理了沒**
 *   resendMail  補寄授權碼信。寄信失敗是會發生的（網域沒驗、信箱打錯），
 *               沒有這個按鈕就只能請買家自己去「忘記授權碼」，體驗差很多
 *
 * ⚠️ **刻意不提供「手動標記為已付款」。** 那等於在後台開一個發碼後門，
 *    誤點或權杖外流的代價是直接送出商品。要補償請用發碼頁的「客服補償」。
 */
async function handleOrderPatch(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return err('body 不是合法 JSON');
  const no = String(b.no || '').trim();
  const o = await readOrder(env, no);
  if (!o) return err('查無此訂單', 404);

  if (b.note !== undefined) o.note = String(b.note).slice(0, 500);

  // 退款（2026-10-04）：以前沒有這個狀態——退了款的訂單永遠是「已付款」，營收、
  // 「我的帳號」的累計消費都照算；授權只能另外去授權頁停用，兩邊對不起來。
  // 現在一個動作做完：訂單標 refunded、授權停用、那些裝置的通行證立刻作廢。
  // ⚠️ 退款本身（把錢退回去）在綠界後台做，這裡只記帳與停授權。
  let refundedDevices = 0;
  if (b.refund) {
    if (o.status !== 'paid') return err('只有已付款的訂單可以標記退款');
    o.status = 'refunded';
    o.refundedAt = nowSec();
    // 整張訂單退款＝這張訂單發出的每一組碼都停用（含第二組：下一賽季票，2026-10-30）
    const refundKeys = [o.licenseKey, ...(Array.isArray(o.extraLicenses) ? o.extraLicenses.map((x) => x && x.licenseKey) : [])]
      .map((k) => normLicense(k)).filter(Boolean);
    for (const rk of refundKeys) {
      const rl = await readLicense(env, rk);
      if (rl) {
        const ids = (rl.devices || []).map((d) => d.installId).filter(Boolean);
        rl.revoked = true; rl.revokedAt = nowSec(); rl.refunded = true;
        await env.SUBS.put(licKey(rk), JSON.stringify(rl));
        await voidEntitlements(env, ids);
        refundedDevices += ids.length;
      }
    }
  }

  if (b.serviceDone !== undefined && Array.isArray(o.services)) {
    const i = Number(b.serviceDone);
    if (o.services[i]) {
      o.services[i].status = o.services[i].status === 'done' ? 'pending' : 'done';
      o.services[i].doneAt = nowSec();
    }
  }

  let mail = null;
  if (b.resendMail) {
    if (o.status !== 'paid' || !o.licenseKey) return err('這筆訂單還沒發碼，沒有東西可以寄');
    const lic = await readLicense(env, normLicense(o.licenseKey));
    if (!lic) return err('找不到對應的授權碼，可能已被刪除');
    const to = accountKey(b.email || o.email || '');
    if (!looksLikeEmail(to)) return err('信箱格式不正確');
    // ⚠️ 改寄到別的信箱＝客人當初打錯信箱。授權綁帳號之後，**授權本身也要搬到新信箱**
    //    （acct 與 licmail 索引）——否則他收到碼、卻永遠用不了（他登不進那個打錯的信箱）。
    // 同一張訂單的第二組碼（下一賽季票）一起寄、一起搬
    const extra = [];
    for (const x of (Array.isArray(o.extraLicenses) ? o.extraLicenses : [])) {
      const xk = normLicense(x && x.licenseKey);
      const xl = xk ? await readLicense(env, xk) : null;
      if (xl) extra.push({ key: xk, lic: xl });
    }
    for (const it of [{ key: normLicense(o.licenseKey), lic }, ...extra]) {
      if (to === accountKey(it.lic.email || '')) continue;
      const from = String(it.lic.email || '').toLowerCase();
      it.lic.email = to;
      it.lic.acct = to;
      await env.SUBS.put(licKey(it.key), JSON.stringify(it.lic));
      await licIndexMove(env, it.key, from, to);
    }
    try {
      mail = await sendLicenseMail(env, to, normLicense(o.licenseKey), lic,
        { total: lic.orderTotal != null ? lic.orderTotal : (o.price != null ? o.price : undefined), extra });
    } catch (e) { mail = { sent: false, reason: String((e && e.message) || e) }; }
    if (mail.sent) {
      o.mailed = true;
      o.email = to || o.email;
      await env.SUBS.delete(`mailfail:${no}`);
    }
  }

  invalidateOrderList();
  await env.SUBS.put(ordKey(no), JSON.stringify(o), {
    expirationTtl: ordTtl(o), metadata: ordMeta(o),
  });
  return json({ ok: true, order: o, mail, refundedDevices });
}

/**
 * 管理端：目前有哪些方案、實際價格是多少。
 *
 * ⚠️ **後台的方案下拉不可以寫死。** 之前就是寫死的，於是定價從
 *    「早鳥 399／正式 599」改成「上半季 599／下半季 299／一週 39」之後，
 *    後台還在發早鳥碼——發出去的方案與網站上賣的根本是兩套東西，
 *    而且不會有任何錯誤訊息。
 *
 * 這裡回的是**伺服器此刻真正會用的價格**（含後台覆寫與賽季分段），
 * 而不是程式碼裡的牌價。
 */
async function handleAdminPlans(env) {
  const ops = await opsConfig(env);
  const early = await earlyState(env);
  const out = [];
  for (const [key, p] of Object.entries(PLANS)) {
    const row = {
      key,
      label: p.label,
      listPrice: p.price,
      price: planPrice(key, ops),
      kind: /^svc_/.test(key) ? 'service' : (p.free || !p.price) ? 'internal' : 'sub',
      hidden: ops.hidden.includes(key),
      manual: !!p.manual,
      weekBound: !!p.weekBound,
      // ⚠️ **發碼下拉只能列出「發了有用」的方案。**
      //    代訂方案本身發出去是一張立刻到期的碼（字幕使用權是靠附贈的
      //    week_svc 給的）；trial 是免費層，根本不需要授權碼。
      //    把它們列進去只會讓客服在壓力下選錯，而選錯完全不報錯——
      //    使用者拿到一張「看起來正常、貼上去卻說已過期」的碼。
      issuable: !p.manual && !p.noSubs && !p.free,
      locked: planLock(key, undefined, undefined, early),
      note: '',
    };
    if (p.untilSeasonEnd) {
      const sp = seasonPriceNow(row.price);
      row.price = sp.price;
      row.note = sp.tier + (sp.nextSeason ? '（次一賽季）' : '');
    }
    if (!row.note && p.days) row.note = `${p.days} 天`;
    out.push(row);
  }
  return json({ ok: true, plans: out, earlyLeft: early.left === null ? 0 : early.left, early });
}

