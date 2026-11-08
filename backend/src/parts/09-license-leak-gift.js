// ---------------------------------------------------------------------------
// 授權碼外洩的處置（2026-10-04）
//
// 授權碼是「持有即擁有」的憑證——外流之後，拿到的人和擁有者在系統眼中一模一樣。
// 三件事讓擁有者拿回控制權：
//   1. 解除裝置立刻生效（removeDevices 寫 entvoid）
//   2. 登入「我的帳號」看得到每一台裝置、可以不限次數解除（只憑授權碼的那條路有上限）
//   3. **換發**：同一份授權、新的一組碼，舊碼立刻失效、所有裝置登出
// ---------------------------------------------------------------------------

/**
 * 授權碼要配上**擁有它的帳號**才能用（啟用與續期都過這一關）。
 *
 * ⚠️ **2026-10-04 使用者推翻了「授權碼不需要登入就能用」的定案**：帳號的成本只是一個
 *    收得到驗證碼的信箱，綁在一起換來的是「外流的碼別人拿去也用不了」——
 *    除非他同時收得到購買信箱的信（或擁有者用認領把它併進自己的帳號）。
 *    擁有＝這組碼的購買信箱（acct）在登入帳號的信箱清單裡（登入那個信箱、或認領過）。
 * ⚠️ strict：被登出、被「登出所有裝置」的權杖要立刻不能用（AuthGuard 連不上一律擋）。
 * ⚠️ 兩種失敗要分開講：沒登入（E79，擴充功能會引導登入）、登入了但不是這個帳號的碼
 *    （E75，告訴他是哪個信箱——遮罩過——讓他知道要用哪個信箱登入或去認領）。
 */
async function licenseOwnerCheck(env, request, lic) {
  const sess = await sessionOf(env, request, true);
  if (!sess) {
    return { error: json({
      error: '請先登入：在擴充功能按「登入」，用購買時填寫的信箱登入，授權就會自動恢復。',
      code: 'E79', needLogin: true,
    }, 403) };
  }
  const acc = await readGoogleAccount(env, sess.sub);
  const owner = accountKey(lic.acct || lic.email || '');
  if (!acc || !owner || !(acc.emails || []).includes(owner)) {
    return { error: json({
      error: `這份授權屬於 ${maskEmail(owner)} 的帳號，不是目前登入的帳號。`
        + '請改用購買時的信箱登入；若那也是你的信箱，可以到 pitlingo.com「我的帳號」輸入那個信箱認領。',
      code: 'E75', owner: maskEmail(owner),
    }, 403) };
  }
  return { sess, acc };
}

/**
 * 把這個帳號擁有的每一組授權碼底下的裝置全部移除並作廢通行證（「登出所有裝置」用）。
 * 擁有者重新登入擴充功能後會自動重新啟用（擴充功能記得授權碼）。
 */
async function stopAccountDevices(env, acc) {
  let n = 0;
  for (const em of (acc.emails || []).slice(0, 10)) {
    let keys = [];
    try { keys = JSON.parse((await env.SUBS.get(`licmail:${accountKey(em)}`)) || '[]'); } catch (e) { keys = []; }
    for (const k of (Array.isArray(keys) ? keys : []).slice(0, 50)) {
      const key = normLicense(k);
      const lic = await readLicense(env, key);
      if (!lic || !(lic.devices || []).length) continue;
      const ids = lic.devices.map((d) => d.installId).filter(Boolean);
      lic.devices = [];
      await env.SUBS.put(licKey(key), JSON.stringify(lic));
      await voidEntitlements(env, ids);
      n += ids.length;
    }
  }
  return n;
}

/** licmail 索引：把 oldKey 換成 newKey（找不到 oldKey 就補上 newKey）。 */
async function licIndexSwap(env, mail, oldKey, newKey) {
  const ik = `licmail:${mail}`;
  let arr = [];
  try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  arr = arr.filter((k) => normLicense(k) !== oldKey && normLicense(k) !== newKey);
  arr.push(newKey);
  await env.SUBS.put(ik, JSON.stringify(arr));
}

/** licmail 索引：把 key 從 fromMail 搬到 toMail（後台改授權碼的 email 時用）。 */
async function licIndexMove(env, key, fromMail, toMail) {
  if (fromMail) {
    const ik = `licmail:${fromMail}`;
    let arr = [];
    try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { arr = []; }
    arr = (Array.isArray(arr) ? arr : []).filter((k) => normLicense(k) !== key);
    if (arr.length) await env.SUBS.put(ik, JSON.stringify(arr)); else await env.SUBS.delete(ik);
  }
  if (toMail) {
    const ik = `licmail:${toMail}`;
    let arr = [];
    try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { arr = []; }
    arr = Array.isArray(arr) ? arr : [];
    if (!arr.some((k) => normLicense(k) === key)) arr.push(key);
    await env.SUBS.put(ik, JSON.stringify(arr));
  }
}

/** 換發的「家族」鍵：同一份授權不論換發幾次都是同一個（自助換發的 7 天限制看它）。 */
function licLineage(key, lic) {
  return (Array.isArray(lic.reissuedFrom) && lic.reissuedFrom[0]) || key;
}

/**
 * 換發授權碼：同一份授權（方案、效期、比賽週區間、訂單、帳號、折抵紀錄全部不變）換一組新碼。
 *
 * ⚠️ 舊碼**同時**標 replacedBy 與 revoked：
 *    · revoked 讓所有既有的「停用就跳過」自動成立——升級折抵（否則新舊兩張會各抵一次）、
 *      後台統計、啟用、續期，不必逐一記得「還有換發這種狀態」
 *    · replacedBy 讓訊息說得出「去哪裡拿新碼」，也讓後台擋住「恢復」（恢復＝兩組碼同時有效）
 * ⚠️ 舊碼底下的裝置**全部登出**（entvoid）。換發的理由就是「有不該有的人在用」，
 *    分不出哪一台是誰的，只能全部重來；擁有者用新碼在自己的裝置上重新啟用即可。
 * ⚠️ 寫入順序：先寫新碼、再把舊碼退役。反過來的話中途失敗＝使用者兩組碼都不能用。
 *    舊碼退役失敗時把新碼刪掉，維持「只有一組有效」。
 *
 * @param opts.by  'self'（我的帳號）或 'admin'（後台）——記在舊碼上，日後查得到是誰換的
 */
async function reissueLicense(env, oldRaw, opts) {
  const oldKey = normLicense(oldRaw);
  const lic = await readLicense(env, oldKey);
  if (!lic) return { ok: false, status: 404, error: '查無此授權碼' };
  if (lic.replacedBy) return { ok: false, status: 409, code: 'E78', error: '這組授權碼已經換發過了' };
  if (lic.revoked) return { ok: false, status: 409, error: '這組授權碼已停用，不能換發。如有疑問請聯絡客服' };

  let newKey = '';
  for (let i = 0; i < 5 && !newKey; i++) {
    const k = licenseKeyNew();
    if (!(await env.SUBS.get(licKey(k)))) newKey = k;
  }
  if (!newKey) return { ok: false, status: 503, error: '暫時無法產生新的授權碼，請稍後再試' };

  const now = nowSec();
  const by = (opts && opts.by) || 'admin';
  const oldIds = (lic.devices || []).map((d) => d.installId).filter(Boolean);
  const fresh = Object.assign({}, lic, {
    devices: [],
    reissuedFrom: (Array.isArray(lic.reissuedFrom) ? lic.reissuedFrom : []).concat(oldKey),
    reissuedAt: now,
    reissueCount: (Number(lic.reissueCount) || 0) + 1,
  });
  delete fresh.replacedBy;
  await env.SUBS.put(licKey(newKey), JSON.stringify(fresh));
  const retired = Object.assign({}, lic, {
    devices: [], revoked: true, revokedAt: now,
    replacedBy: newKey, replacedAt: now, replacedHow: by,
  });
  try {
    await env.SUBS.put(licKey(oldKey), JSON.stringify(retired));
  } catch (e) {
    try { await env.SUBS.delete(licKey(newKey)); } catch (e2) { /* noop */ }
    throw e;
  }
  await voidEntitlements(env, oldIds);

  // 指向這組碼的地方都要跟著換，否則「補寄授權信」「付款完成頁」「我的帳號」會拿到舊碼
  const mail = String(lic.email || '').trim().toLowerCase();
  if (mail) await licIndexSwap(env, mail, oldKey, newKey);
  if (lic.orderId) {
    try {
      if ((await env.SUBS.get(`order:${lic.orderId}`)) === oldKey) {
        await env.SUBS.put(`order:${lic.orderId}`, newKey, { expirationTtl: 400 * 86400 });
      }
      const o = await readOrder(env, lic.orderId);
      if (o && normLicense(o.licenseKey) === oldKey) await patchOrder(env, lic.orderId, { licenseKey: prettyLicense(newKey) });
      // 同一張訂單的第二組碼（下一季票）換發時，訂單上那一筆也要換
      else if (o && Array.isArray(o.extraLicenses) && o.extraLicenses.some((x) => normLicense(x && x.licenseKey) === oldKey)) {
        await patchOrder(env, lic.orderId, {
          extraLicenses: o.extraLicenses.map((x) => (normLicense(x && x.licenseKey) === oldKey ? { ...x, licenseKey: prettyLicense(newKey) } : x)),
        });
      }
    } catch (e) { /* 訂單指標更新失敗不影響換發本身——新碼已經生效 */ }
  }

  let mailed = { sent: false };
  if (lic.email) {
    try { mailed = await sendLicenseMail(env, lic.email, newKey, fresh, { reissued: true }); } catch (e) { /* 寄不出去時新碼仍在「我的帳號」 */ }
  }
  return { ok: true, oldKey, newKey, devicesCleared: oldIds.length, mailed: !!mailed.sent };
}

/** 後台：換發（不受 7 天限制——客服判斷過了）。 */
async function handleAdminReissue(request, env) {
  const body = await request.json().catch(() => null);
  const r = await reissueLicense(env, body && body.licenseKey, { by: 'admin' });
  if (!r.ok) return err(r.error, r.status || 400, r.code);
  return json({ ok: true, oldKey: prettyLicense(r.oldKey), licenseKey: prettyLicense(r.newKey), devicesCleared: r.devicesCleared, mailed: r.mailed });
}

/**
 * 「這組授權碼是不是目前登入的帳號的」。帳號頁所有對授權碼的操作都先過這一關。
 * ⚠️ 查無此碼與不是你的回**同一句話**——不要讓帳號頁變成「這組碼存不存在」的查詢工具。
 */
async function ownedLicense(env, sub, keyRaw) {
  const key = normLicense(keyRaw);
  if (!key) return { error: err('請提供授權碼') };
  const acc = await readGoogleAccount(env, sub);
  if (!acc) return { error: err('請先登入', 401, 'E61') };
  const lic = await readLicense(env, key);
  const owner = lic ? accountKey(lic.acct || lic.email || '') : '';
  if (!lic || !owner || !(acc.emails || []).includes(owner)) {
    return { error: err('這份授權不在你的帳號裡', 403, 'E75') };
  }
  return { acc, key, lic };
}

/** 我的帳號：解除某一台裝置（不限次數——登入就證明了是擁有者）。 */
async function handleAccountDeviceRemove(env, sess, b) {
  if (await authLimited(env, 'acctdev', sess.sub)) return err('操作太頻繁，請稍後再試', 429, 'E32');
  const o = await ownedLicense(env, sess.sub, b && b.licenseKey);
  if (o.error) return o.error;
  if (o.lic.replacedBy) return err('這份授權已由客服重新設定，請重新整理頁面', 409, 'E78');
  return removeDevices(env, o.key, o.lic, String((b && b.device) || '').trim());
}

// ---------------------------------------------------------------------------
// 附贈比賽週的轉送（handoff 9.1 #19，2026-10-06）
//
// 代訂附贈的比賽週原本和自費的合併在同一組授權碼裡，而 2026-10-04 起授權碼綁帳號——
// 「把碼給朋友」行不通了（CLAUDE.md：要支援送禮就做「轉讓」，不要放寬綁定）。
// 這裡讓擁有者在「我的帳號」把**一站還沒開始的附贈比賽週**轉給朋友的信箱：
// 那一站從自己的授權拆出來，變成一組綁朋友帳號的新碼，寄到朋友信箱。
//
// ⚠️ **預設關閉**：wrangler.toml 的 [vars] 設 GIFT_TRANSFER = "1" 才開（工作規則 7：新功能要問過 Ray）。
//    開之前條款要加第七條（草稿在 handoff 9.1 #19）。
// ⚠️ 只能轉**附贈的**（giftGpIds 是結帳當下記的，只有它分得出來）、**還沒開始的**（開始了就是兩邊都看過）、
//    每一站只能轉一次（AuthGuard once，並發的兩個請求只有一個成功）。
// ⚠️ 寫入順序：先寫新碼、再改舊的。改舊的失敗就把新碼刪掉——寧可轉送失敗，也不要一站變兩份。
// ---------------------------------------------------------------------------
function giftEnabled(env) { return String((env && env.GIFT_TRANSFER) || '') === '1'; }

/** 這張授權現在可以轉送的附贈比賽週。 */
function giftableWeeks(env, lic) {
  if (!giftEnabled(env) || !lic || lic.revoked || lic.replacedBy) return [];
  if (!(PLANS[lic.plan] && PLANS[lic.plan].weekBound)) return [];   // 賽季票＋代訂：附贈沒有作用（條款第五條）
  const now = nowSec();
  const out = [];
  for (const id of Array.isArray(lic.giftGpIds) ? lic.giftGpIds : []) {
    if (!(lic.gpIds || []).includes(id)) continue;                  // 已經轉出去了
    const g = gpById(id);
    const w = g && gpWindow(g);
    if (!w || now >= w.from) continue;                               // 開始了就不能轉
    out.push({ gpId: id, label: g.label || `${g.name}大獎賽`, from: w.from, until: w.until });
  }
  return out;
}

/** 轉送通知。文字可在後台改（MAIL_DEFS.gift）。2026-10-30 起不放授權碼：綁的是這個信箱的帳號，登入就有 */
async function buildGiftMail(env, lic, fromMasked, ov) {
  const d = (s) => new Date(s * 1000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  const m = await composeMail(env, 'gift', { from: fromMasked, gp: lic.gpName, date: d(lic.startsAt) }, ov);
  return { subject: m.subject, html: mailShell(m.title, m.bodyHtml, {
    site: m.site, why: '有 PitLingo 的使用者把附贈的比賽週通行證轉送給這個信箱' }) };
}

async function sendGiftMail(env, to, key, lic, fromMasked) {
  if (!mailConfigured(env) || !to) return { sent: false };
  try {
    const m = await buildGiftMail(env, lic, fromMasked);
    const r = await sendMail(env, { to: [to], subject: m.subject, html: m.html });
    return { sent: r.ok };
  } catch (e) { return { sent: false }; }
}

async function handleAccountGift(env, sess, b) {
  if (!giftEnabled(env)) return err('轉送功能尚未開放', 403);
  const o = await ownedLicense(env, sess.sub, b && b.licenseKey);
  if (o.error) return o.error;
  const gpIdWant = String((b && b.gpId) || '');
  const to = accountKey((b && b.to) || '');
  if (!looksLikeEmail(to)) return err('收件人的 email 格式不正確', 400, 'E64');
  if ((o.acc.emails || []).includes(to)) return err('不能轉給自己帳號裡的信箱', 400);
  const wk = giftableWeeks(env, o.lic).find((x) => x.gpId === gpIdWant);
  if (!wk) return err('這一站不能轉送（不是附贈的、已經開始、或已經轉出去了）', 409);
  // 每組授權碼每天最多轉 5 站（防呆；正常一張代訂最多附贈 3 站）
  if (await authLimited(env, 'gift', o.key)) return err('操作太頻繁，請明天再試', 429, 'E32');
  // ⚠️ 同一站只能轉一次——兩個並發請求都讀到「還沒轉」時，只有一個拿得到這張票
  const once = await authCall(env, { op: 'once', k: 'gift:' + o.key + ':' + gpIdWant, ttl: Math.max(86400, wk.until - nowSec()) });
  if (!once || !once.ok) return err('這一站已經在轉送中或已經轉出去了，請重新整理', 409);

  let newKey = '';
  for (let i = 0; i < 5 && !newKey; i++) {
    const k = licenseKeyNew();
    if (!(await env.SUBS.get(licKey(k)))) newKey = k;
  }
  if (!newKey) { await authCall(env, { op: 'once', k: 'gift:' + o.key + ':' + gpIdWant, release: true }); return err('暫時無法產生授權碼，請稍後再試', 503); }

  const g = gpById(gpIdWant);
  const w = gpWindow(g);
  const now = nowSec();
  const gift = {
    plan: 'week_svc', email: to,
    acct: to,                         // 帳號鍵（CLAUDE.md 資料模型：每一組授權碼都要有 acct）
    orderId: o.lic.orderId || '',
    expiresAt: w.until, startsAt: w.from,
    windows: [[w.from, w.until]], gpIds: [gpIdWant], giftGpIds: null,
    gpName: wk.label, gpCount: 1,
    nextLabel: w.next ? (w.next.label || `${w.next.name}大獎賽`) : null,
    paid: 0, items: [], orderTotal: null, services: null,
    devices: [], createdAt: now, revoked: false, source: 'gift',
    giftedFrom: o.key,
  };
  await env.SUBS.put(licKey(newKey), JSON.stringify(gift));

  // 舊的那一張：拿掉這一站，區間依剩下的站重新算（區間在發碼時合併過，不能直接挖洞）
  try {
    const fresh = await readLicense(env, o.key);
    if (!fresh || fresh.revoked || fresh.replacedBy || !(fresh.gpIds || []).includes(gpIdWant)) throw new Error('changed');
    const ids = fresh.gpIds.filter((x) => x !== gpIdWant);
    const wins = ids.map((id) => gpWindow(gpById(id))).filter(Boolean).map((x) => [x.from, x.until]);
    fresh.gpIds = ids.length ? ids : null;
    fresh.giftGpIds = (fresh.giftGpIds || []).filter((x) => x !== gpIdWant);
    fresh.windows = wins.length ? mergeWindows(wins) : null;
    fresh.gpCount = ids.length || null;
    fresh.gpName = ids.length ? ids.map((id) => { const x = gpById(id); return x ? (x.label || `${x.name}大獎賽`) : id; }).join('、') : null;
    if (wins.length) {
      fresh.startsAt = Math.min(...wins.map((x) => x[0]));
      fresh.expiresAt = Math.max(...wins.map((x) => x[1]));
    } else {
      fresh.expiresAt = now;          // 整張都轉出去了
      fresh.allGifted = true;
    }
    fresh.giftedOut = (Array.isArray(fresh.giftedOut) ? fresh.giftedOut : []).concat({ gpId: gpIdWant, key: newKey, to: maskEmail(to), at: now });
    await env.SUBS.put(licKey(o.key), JSON.stringify(fresh));
  } catch (e) {
    await env.SUBS.delete(licKey(newKey));
    await authCall(env, { op: 'once', k: 'gift:' + o.key + ':' + gpIdWant, release: true });
    return err('授權狀態剛剛變更了，請重新整理後再試', 409, 'E22');
  }
  await licIndexMove(env, newKey, null, to);
  let mailed = { sent: false };
  try { mailed = await sendGiftMail(env, to, newKey, gift, maskEmail(o.lic.email || o.acc.email || '')); } catch (e) { /* 寄不出去：對方登入「我的帳號」也看得到 */ }
  return json({ ok: true, gpId: gpIdWant, to: maskEmail(to), mailed: !!mailed.sent });
}

