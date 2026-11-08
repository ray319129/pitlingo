// ---------------------------------------------------------------------------
// 金流 webhook —— 付款成功後自動發碼
//
// 為什麼要驗簽：webhook 的網址是公開的，任何人都能 POST 一筆假訂單過來換取
// 免費授權。綠界用 CheckMacValue（參數排序後接上 HashKey/HashIV 再雜湊）。
//
// 為什麼要防重放：金流平台在沒收到 200 時會**重送同一筆通知**，
// 不擋的話同一筆訂單會發出好幾組授權碼。以訂單編號為鍵記錄已處理過的。
// ---------------------------------------------------------------------------

/** 綠界的 CheckMacValue。演算法固定，錯一個環節就全錯。 */
async function ecpayMac(params, hashKey, hashIV) {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue')
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const raw = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`;
  // 綠界指定的 URL encode 規則（.NET UrlEncode：小寫，且部分字元不編碼）
  const enc = encodeURIComponent(raw).toLowerCase()
    .replace(/%20/g, '+').replace(/%21/g, '!').replace(/%2a/g, '*')
    .replace(/%28/g, '(').replace(/%29/g, ')').replace(/%27/g, "'");
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(enc));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * 商品代號 → 方案。對不上就用 season——
 * **寧可多給也不要讓付了錢的人拿不到東西**，客服可以事後調整，
 * 但「付了錢沒東西」是最傷的。
 */
function planFromItem(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('early') || n.includes('早鳥')) return 'season_early';
  return 'season';
}

async function handlePaymentWebhook(request, env) {
  const ct = request.headers.get('content-type') || '';
  let p = {};
  if (ct.includes('json')) {
    p = await request.json().catch(() => ({}));
  } else {
    const form = await request.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) p[k] = String(v);
  }

  const orderId = String(p.MerchantTradeNo || p.orderId || '').trim();
  if (!orderId) return new Response('0|no order id', { status: 400 });

  // --- 驗簽 ---
  // 正式與測試兩組憑證都試。測試環境用綠界公開的帳號，
  // 讓我們能在**不花真錢**的情況下驗證整條路徑——正式環境上線前唯一的辦法。
  // ⚠️ 測試簽章只在開放測試、且訂單本身是測試模式時才認（見 ecpayMacOk）。
  let macMode = null;
  if (env.ECPAY_HASH_KEY && env.ECPAY_HASH_IV) {
    macMode = await ecpayMacOk(env, p, await readPending(env, orderId));
    if (!macMode) {
      return new Response('0|bad mac', { status: 401 });
    }
  } else if (env.WEBHOOK_SECRET) {
    // 通用備援：自訂金流或測試時用 header 驗
    if (!safeEqual(request.headers.get('x-webhook-secret') || '', env.WEBHOOK_SECRET)) {
      return new Response('0|unauthorized', { status: 401 });
    }
  } else {
    // 沒設定任何驗證方式就不處理。**寧可不發也不要開一個誰都能領的窗口。**
    return new Response('0|webhook not configured', { status: 503 });
  }

  // 未付款成功也要回 1，否則金流會一直重送
  const paid = String(p.RtnCode || p.status || '') === '1' || p.status === 'paid';
  if (!paid) return new Response('1|OK');

  // ⚠️ **綠界後台的「模擬付款」也會送 RtnCode=1**（帶 SimulatePaid=1，簽章是真的）。
  //    官方文件明講模擬付款不可以出貨。以前照樣發碼——任何能登入綠界後台的人
  //    （或手滑按到的你）都能不付錢生出一組正式授權碼。測試收銀台（stage）照常放行。
  if (String(p.SimulatePaid || '') === '1' && macMode !== 'stage') {
    try { await patchOrder(env, orderId, { simulated: true, simulatedAt: nowSec() }); } catch (e) { /* noop */ }
    return new Response('1|OK');
  }

  // --- 防重放 ---
  const dedupeKey = `order:${orderId}`;
  const seen = await env.SUBS.get(dedupeKey);
  if (seen) return new Response('1|OK', { headers: { 'x-pitlingo-license': seen } });

  // ⚠️ 上面那一道是 KV（最終一致、沒有 CAS）：同一筆通知同時到兩次，兩邊都讀到「沒有」，
  //    同一筆訂單會發出兩組碼。真正的一次性在 AuthGuard（坑 #81）。
  //    AuthGuard 連不上時回非 1——綠界會重送，比發兩組碼好。
  if (env.AUTH) {
    const once = await authCall(env, { op: 'once', k: 'pay:' + orderId, ttl: 400 * 86400 });
    if (!once) return new Response('0|busy', { status: 503 });
    if (!once.ok) return new Response('1|OK');
  }
  const prog = { licWritten: false };
  try {
    return await issueForPaidOrder(env, p, orderId, dedupeKey, prog);
  } catch (e) {
    // 發到一半出錯：**授權碼還沒寫進去**才把「已處理」放掉，讓綠界的重送能再試一次。
    // ⚠️ 已經寫進去了就不放（security-audit 2026-10-05）：放掉的話重送會再發一組新碼——
    //    同一筆訂單兩組有效的授權碼。那種情況交給後台（訂單會停在未付款、管理員會收到通知）。
    if (env.AUTH && !prog.licWritten) { try { await authCall(env, { op: 'once', k: 'pay:' + orderId, release: true }); } catch (e2) { /* noop */ } }
    try { await notifyAdmin(env, `[PitLingo] 發碼中途出錯 ${orderId}`, `訂單：${orderId}\n授權碼已寫入：${prog.licWritten ? '是（不會自動重試，請人工確認）' : '否（等綠界重送）'}\n錯誤：${String((e && e.message) || e).slice(0, 300)}`); } catch (e3) { /* noop */ }
    return new Response('0|error', { status: 500 });
  }
}

/** 付款成功後實際發碼（驗簽、模擬付款、去重都已在 handlePaymentWebhook 做完）。 */
async function issueForPaidOrder(env, p, orderId, dedupeKey, prog) {

  // --- 發碼 ---
  // ⚠️ 方案要從**我們自己建立訂單時記下的** pending 讀，不要從綠界回傳的
  //    商品名稱猜。使用者結帳當下看到的是什麼價格，就該拿到什麼方案——
  //    靠字串比對猜商品名，改一次文案就會發錯方案，而且不會有人發現。
  let pending = null;
  try { pending = JSON.parse((await env.SUBS.get(`pending:${orderId}`)) || 'null'); } catch (e) { /* noop */ }

  const email = String((pending && pending.email) || p.CustomerEmail || p.email || '').trim();
  let plan = pending && PLANS[pending.plan] ? pending.plan : planFromItem(p.ItemName || p.plan);

  // 金額對不上就不發碼。綠界的通知帶著實付金額，與我們記錄的價格不符
  // 代表有人竄改了結帳參數，或我們自己算錯了——兩種都不該默默發下去。
  if (pending && p.TradeAmt !== undefined && Number(p.TradeAmt) !== Number(pending.price)) {
    return new Response('0|amount mismatch', { status: 400 });
  }
  // 早鳥：付款完成才算賣出（AuthGuard，結帳時保留的那一席轉成賣出）。賣不出去（名額滿、這個帳號買過、
  //    AuthGuard 連不上）就改發**同內容**的季票——他付的是 399，拿到的東西完全一樣，只是不算進早鳥。
  //    **寧可少賣一組也不要賣超**；後台會收到通知，要不要退差價由人決定。
  let earlyFell = false;
  if (plan === 'season_early' && !(await earlyClaim(env, orderId, email))) { plan = earlyTargetKey() || 'season'; earlyFell = true; }
  const extraEarly = pending && Array.isArray(pending.extra) && pending.extra.find((x) => x && x.plan === 'season_early');
  if (extraEarly && !(await earlyClaim(env, orderId, email))) { extraEarly.plan = earlyTargetKey() || 'season'; earlyFell = true; }
  if (earlyFell) {
    try { await notifyAdmin(env, `早鳥沒有名額：訂單 ${orderId} 改發同內容的季票`, `訂單 ${orderId}（${email}）付了早鳥價，但付款時早鳥已經沒有名額（或這個帳號買過、或 AuthGuard 連不上），已改發 ${PLANS[earlyTargetKey() || 'season'].label}。要不要退差價請自行判斷。`); } catch (e) { /* 通知失敗不擋發碼 */ }
  }
  // ⚠️ **不含字幕授權的訂單不發授權碼。**
  //
  //    svc_none 代表「這筆訂單沒有任何字幕使用權」（目前只有共用帳號的
  //    單一比賽週末代訂會走到這裡）。以前照樣發一組碼，但那組碼是**立刻過期**的——
  //    買家貼進擴充功能只會看到「已過期」，然後來問是不是買錯了。
  //    不發一個沒用的東西最乾淨。訂單記錄照常建立，後台一樣追得到。
  const noLicense = plan === 'svc_none';
  const key = noLicense ? null : normLicense(licenseKeyNew());
  // Weekend Pass 要記下它涵蓋的是哪一場、從哪一天起生效。
  // 少了這兩個欄位，提前購買的人會拿到一張「現在就能用、但比賽前就過期」的通行證。
  // ⚠️ **數量一定要從購物車讀回來。**
  //    買 3 張通行證卻只發一張的效期，是安靜地少給使用者他付過錢的東西——
  //    不報錯，只有他自己會在第二站發現看不了。
  // 比賽週通行證：買了哪幾場、各自的區間。**結帳時就算好存進 pending**，
  // 不要在這裡重算——重算會用「現在」當基準，而付款可能是幾小時後
  // （ATM／超商），基準一變就發出與購買頁顯示不同的效期。
  const gpWins = (pending && Array.isArray(pending.windows)) ? pending.windows : [];
  const gpIds = (pending && Array.isArray(pending.gpIds)) ? pending.gpIds : [];
  const gpLabels = gpIds.map((id) => {
    const g = gpById(id);
    return g ? (g.label || `${g.name}大獎賽`) : id;
  });

  // 代訂是**人工服務**：付款只代表「已收款、待處理」，不是已完成。
  // 把它列進授權記錄是為了讓後台看得到、追得到、結得了案——
  // 沒有這個欄位，代訂訂單付完款就從系統裡消失，只剩你信箱裡的一封通知。
  const cartItems = (pending && Array.isArray(pending.items)) ? pending.items : [];
  const services = cartItems.filter((i) => PLANS[i.key] && PLANS[i.key].manual);

  const lic = {
    plan, email, orderId,
    // 帳號鍵。**日後導入登入時，靠這個欄位把既有資料接回帳號**——
    // 少一筆就是一筆接不回去的孤兒，而且完全不會報錯（見 accountKey）。
    acct: accountKey(email),
    // 比賽週通行證的效期＝最後一段的結束；其餘方案照原本的算法
    expiresAt: gpWins.length ? Math.max(...gpWins.map((x) => x[1])) : planExpiry(plan),
    startsAt: gpWins.length ? Math.min(...gpWins.map((x) => x[0])) : planStart(plan),
    // 區間本身也要存。跳著買時，中間的空檔靠它擋住。
    windows: gpWins.length ? gpWins : null,
    gpIds: gpIds.length ? gpIds : null,
    // ⚠️ 這幾站是代訂附贈的（gpIds 的子集）。**現在沒有人讀它**，
    //    但少記一次就永遠補不回來——見 quoteCart 的 giftGpIds。
    giftGpIds: (pending && Array.isArray(pending.giftGpIds) && pending.giftGpIds.length)
      ? pending.giftGpIds : null,
    gpName: gpLabels.length ? gpLabels.join('、') : null,
    gpCount: gpIds.length || null,
    // 失效的那一刻是「下一場的第一場賽事」。**要把那一場的名字存下來**——
    // 只給日期，使用者無從判斷自己還能不能看下一場。
    nextLabel: (() => {
      if (!gpIds.length) return null;
      const lastId = gpIds[gpIds.length - 1];
      const w = gpWindow(gpById(lastId));
      return w && w.next ? (w.next.label || `${w.next.name}大獎賽`) : null;
    })(),
    // weekFrom 已由 windows 取代（比賽週區間是一段一段的，不是一個起點）
    // 這筆訂單實付多少。升級抵扣要用它，不能用牌價——
    // 折抵過的訂單若用牌價回算，會把折掉的金額再抵一次。
    // ⚠️ **只記通行證那幾行實際付的錢，不是訂單總價。**
    //    記成總價的話，跟著代訂免費拿到的通行證會換到滿額的升級折抵。
    paid: (PLANS[plan] && PLANS[plan].weekBound && pending && pending.weekPaid !== undefined)
      ? Number(pending.weekPaid) || 0
      // 同一張單還有另一組授權（下一季票）時，扣掉它的錢（見 quoteCart 的 primaryPaid）
      : (pending && pending.primaryPaid != null) ? Number(pending.primaryPaid) || 0
      : (pending ? Number(pending.price) || 0 : (PLANS[plan] || {}).price || 0),
    items: cartItems,
    // 訂單實付總價（含代訂、扣掉折抵）。**只給交易明細信用**——升級折抵一律看上面的 paid。
    orderTotal: pending ? Number(pending.price) || 0 : null,
    services: services.length ? services.map((s) => ({
      key: s.key, qty: s.qty, label: PLANS[s.key].label, status: 'pending',
      // 代訂自營要用：共用帳號是哪一場、一個月方案是誰的帳號。**少了這兩個，付款後就問不回來了。**
      gp: s.gp || null, acctMode: s.acct || null,
    })) : null,
    devices: [], createdAt: nowSec(), revoked: false,
    source: 'webhook',
  };
  // ---- 同一張訂單的其他授權碼（2026-10-30）----
  // 「本賽季的票＋下一賽季票」一張單發兩組碼（見 quoteCart 的 extra）：效期不同的東西不能共用一組碼。
  // ⚠️ 先把每一組的碼與內容都準備好，**再一起寫**——寫到一半出錯時 prog.licWritten 已經成立，
  //    不會重發（同 handlePaymentWebhook 的說明），後台會收到「發碼中途出錯」的通知去補。
  const extras = [];
  for (const x of ((pending && Array.isArray(pending.extra)) ? pending.extra : [])) {
    if (noLicense || !x || !PLANS[x.plan] || PLANS[x.plan].manual) continue;
    const xk = normLicense(licenseKeyNew());
    extras.push({
      key: xk,
      lic: {
        ...lic, plan: x.plan,
        expiresAt: planExpiry(x.plan), startsAt: planStart(x.plan),
        windows: null, gpIds: null, giftGpIds: null, gpName: null, gpCount: null, nextLabel: null,
        paid: Number(x.paid) || 0,
        // 代訂是整張訂單的事，記在主授權上就好——記兩份會讓後台同一件代訂出現兩次
        // ⚠️ 不在授權記錄裡互存對方的碼：換發會讓那種指標過期。兩組靠 orderId 與訂單的 extraLicenses 連起來
        services: null,
        devices: [],
      },
    });
  }

  if (!noLicense) await env.SUBS.put(licKey(key), JSON.stringify(lic));
  if (prog) prog.licWritten = true;
  for (const x of extras) await env.SUBS.put(licKey(x.key), JSON.stringify(x.lic));

  // 拿去抵扣的比賽週通行證要標記，否則下一次升級還能再抵一次同樣的金額。
  // ⚠️ 一定要在發碼**之後**做：先標記後發碼的話，發碼失敗會讓使用者
  //    既沒拿到新授權、舊的額度也被吃掉。
  if (pending && Array.isArray(pending.creditKeys) && pending.creditKeys.length) {
    await markCredited(env, pending.creditKeys, orderId);
  }
  // 去重記錄一定要寫，即使沒有發碼——不寫的話綠界重送時會再處理一次。
  await env.SUBS.put(dedupeKey, key || 'nolicense', { expirationTtl: 400 * 86400 });
  await env.SUBS.delete(`pending:${orderId}`);
  if (email && !noLicense) {
    const ik = `licmail:${email.toLowerCase()}`;
    let arr = [];
    try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { /* noop */ }
    for (const k of [key, ...extras.map((x) => x.key)]) if (!arr.includes(k)) arr.push(k);
    await env.SUBS.put(ik, JSON.stringify(arr));
  }

  // 寄授權碼給買家。
  // ⚠️ **絕不能讓寄信失敗影響發碼。** 授權碼此刻已經寫進資料庫了，
  //    寄不出去客服補得回來；但如果因為寄信拋例外而讓 webhook 回非 200，
  //    綠界會重送，而重送會被去重擋掉——結果是買家永遠收不到、後台也查不出原因。
  let mailed = { sent: false, reason: 'no_email' };
  if (email) {
    try {
      mailed = await sendLicenseMail(env, email, key, lic, { noLicense, extra: extras });
    } catch (e) {
      mailed = { sent: false, reason: String(e && e.message || e) };
    }
    if (!mailed.sent) {
      // 寄不出去一定要留下紀錄，否則只會變成「買家說沒收到」的無頭公案
      try {
        await env.SUBS.put(`mailfail:${orderId}`, JSON.stringify({
          orderId, email, key, reason: mailed.reason, at: nowSec(),
        }), { expirationTtl: 90 * 86400 });
      } catch (e) { /* 連記錄都失敗就算了，不擋主流程 */ }
    }
  }

  // 訂單標記為已付款。**放在寄信之後**，這樣 mailed 才是真的結果——
  // 後台靠這個欄位挑出「已付款但信沒寄出去」的訂單去補寄。
  //
  // ⚠️ **這段從訂單管理上線那天（ce20dbd）起就放錯了函式**——放在診斷回報的
  //    handler 裡，那裡沒有 orderId／lic／mailed，一執行就是 ReferenceError，
  //    被下面的 try/catch 靜靜吞掉。結果：每一筆付款成功的訂單在後台永遠是
  //    「未完成付款」、補寄清單永遠是空的、帳號頁累計消費永遠是 0。
  //    2026-09-17 端對端實測才發現，`check-backend` 現在會驗。
  //
  // ⚠️ 金額用 **pending.price（整張訂單的實付）**，不是 lic.paid——
  //    lic.paid 只算比賽週通行證那幾行（給升級折抵用），拿來當訂單金額
  //    會讓「通行證 49 + 代訂 658」的訂單在營收裡變成 49。
  // ⚠️ services 只在授權記錄有的時候才覆寫；結帳時已經記過一份（含標籤），
  //    傳 undefined 進去會把它洗掉。
  try {
    const paidFields = {
      status: 'paid', paidAt: nowSec(),
      licenseKey: noLicense ? null : prettyLicense(key), plan, email,
      price: pending ? Number(pending.price) || 0 : Number(lic.paid) || 0,
      mailed: !!mailed.sent,
      mailReason: mailed.sent ? '' : String(mailed.reason || ''),
      summary: (lic.items || []).map((i) => ((PLANS[i.key] || {}).label || i.key)
        + (i.qty > 1 ? ' x' + i.qty : '')).join('、') || (PLANS[plan] || {}).label || plan,
    };
    if (Array.isArray(lic.services) && lic.services.length) paidFields.services = lic.services;
    // 同一張訂單的其他授權碼（付款完成頁、後台、退款都要看得到）
    if (extras.length) paidFields.extraLicenses = extras.map((x) => ({ licenseKey: prettyLicense(x.key), plan: x.lic.plan }));
    // 帳本要的真實數字（2026-10-24）：綠界實際扣的手續費（2025/04 起＝交易手續費＋處理費）、付款方式、綠界交易編號。
    // 以前沒存，帳本只能用費率猜——第一筆真實付款（10/23）的手續費因此要人工補登。
    const fee = Number(p.PaymentTypeChargeFee);
    if (p.PaymentTypeChargeFee !== undefined && p.PaymentTypeChargeFee !== '' && Number.isFinite(fee) && fee >= 0) paidFields.fee = fee;
    if (p.PaymentType) paidFields.payType = String(p.PaymentType).slice(0, 50);
    if (p.TradeNo) paidFields.tradeNo = String(p.TradeNo).slice(0, 20);
    if (p.TradeAmt !== undefined && Number.isFinite(Number(p.TradeAmt))) paidFields.amount = Number(p.TradeAmt);
    await patchOrder(env, orderId, paidFields);
  } catch (e) { /* 訂單記錄失敗絕不擋發碼——碼已經發出去了 */ }

  // 代訂：付款成功的當下就建立待處理的指派（D1）。失敗不影響發碼——
  // 後台打開「代訂」分頁時會再補一次（resellSyncAll），所以這裡只是讓它即時出現。
  try { await resellSyncOrder(env, orderId); } catch (e) { /* 補同步會接手 */ }

  // ⚠️ **「有人買了東西」一定要通知得到你。**
  //    尤其是 `mailed` 為 false 的時候——買家沒收到授權碼而你不知道有人買了，
  //    第一個發現的人會是三天後寫信來問的客戶。
  try {
    await notifyAdmin(env, `[PitLingo] 新訂單 ${orderId}`,
      `訂單　：${orderId}\n方案　：${plan}\nemail　：${email}\n`
      + `授權碼：${key ? prettyLicense(key) : '(此方案不發碼)'}\n`
      + extras.map((x) => `授權碼：${prettyLicense(x.key)}（${x.lic.plan}）\n`).join('')
      + `寄信　：${mailed && mailed.sent ? '已寄出' : `❌ 失敗（${(mailed && mailed.reason) || '未知'}）—— 需要手動補寄`}`);
  } catch (e) { /* 通知失敗不影響發碼 */ }

  return new Response('1|OK');
}

/**
 * 管理端：列出所有授權碼。
 *
 * 量大之後「一組一組查」是不能用的。這裡直接掃 KV 的 lic: 前綴，
 * 支援關鍵字過濾（授權碼／email／訂單編號）與狀態過濾。
 *
 * KV 的 list 有游標，所以要能分頁——一次撈完在幾百組之後會逾時。
 */
async function handleLicenseList(request, env, url) {
  const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
  const status = url.searchParams.get('status') || 'all';
  const cursor = url.searchParams.get('cursor') || undefined;

  const listed = await env.SUBS.list({ prefix: 'lic:', limit: 200, cursor });
  const rows = [];
  for (const k of listed.keys) {
    const raw = await env.SUBS.get(k.name);
    if (!raw) continue;
    let lic; try { lic = JSON.parse(raw); } catch (e) { continue; }
    const key = k.name.slice(4);

    const expired = !!(lic.expiresAt && lic.expiresAt * 1000 < Date.now());
    const state = lic.replacedBy ? 'replaced' : lic.revoked ? 'revoked' : expired ? 'expired' : 'active';
    // 換發掉的舊碼算在「已停用」那一類（它也帶 revoked）
    if (status !== 'all' && status !== state && !(status === 'revoked' && state === 'replaced')) continue;
    if (q && ![key, lic.email, lic.orderId].some((v) => String(v || '').toLowerCase().includes(q))) continue;

    rows.push({
      licenseKey: prettyLicense(key),
      raw: key,
      plan: lic.plan,
      planLabel: (PLANS[lic.plan] || {}).label || lic.plan,
      // 買多站的通行證要看得出來。少了這兩個欄位，後台上「比賽週通行證 ×3」
      // 與「比賽週通行證 ×1」長得一模一樣，客服完全分不出來。
      gpCount: lic.gpCount || null,
      gpName: lic.gpName || null,
      email: lic.email || '',
      orderId: lic.orderId || '',
      createdAt: lic.createdAt || null,
      expiresAt: lic.expiresAt || null,
      devices: (lic.devices || []).length,
      state,
      replacedBy: lic.replacedBy ? prettyLicense(lic.replacedBy) : '',
      replacedHow: lic.replacedHow || '',
      reissuedAt: lic.reissuedAt || null,
    });
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ rows, cursor: listed.list_complete ? null : listed.cursor, complete: listed.list_complete });
}

/**
 * 管理端：改一組授權碼（延期、換方案、解除全部裝置）。
 * 客服最常做的三件事，不做的話每次都要重發一組新碼。
 */
async function handleLicensePatch(request, env) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  const lic = await readLicense(env, key);
  if (!lic) return err('查無此授權碼', 404);

  // ⚠️ 一定要在任何修改**之前**取。`clearDevices` 會把 `lic.devices` 清成空陣列，
  //    等到下面才讀就一個 installId 都拿不到，於是「清空裝置」在伺服器端毫無效果。
  const idsBefore = (lic.devices || []).map((d) => d.installId).filter(Boolean);

  if (body.plan && PLANS[body.plan]) {
    lic.plan = body.plan;
    if (body.recalcExpiry) lic.expiresAt = planExpiry(body.plan);
  }
  // ⚠️ 換發過的舊碼不可以「恢復」——那會讓新舊兩組碼同時有效，換發等於沒做。
  if (lic.replacedBy && body.revoked === false) {
    return err(`這組授權碼已換發為 ${prettyLicense(lic.replacedBy)}，舊碼不能恢復`, 409, 'E78');
  }
  if (body.expiresAt !== undefined) lic.expiresAt = body.expiresAt ? Number(body.expiresAt) : null;
  if (body.extendDays) lic.expiresAt = (lic.expiresAt || nowSec()) + Number(body.extendDays) * 86400;
  if (body.revoked !== undefined) { lic.revoked = !!body.revoked; lic.revokedAt = body.revoked ? nowSec() : null; }
  if (body.clearDevices) lic.devices = [];
  const oldMail = String(lic.email || '').toLowerCase();
  if (body.email !== undefined) {
    lic.email = String(body.email).trim();
    // ⚠️ 帳號歸屬看的是 acct 與 licmail 索引，不是 email 欄位（2026-10-04 修）。
    //    以前只改 email：後台看起來改好了，新信箱登入「我的帳號」卻看不到這組碼、
    //    舊信箱登入反而還看得到。
    lic.acct = accountKey(lic.email);
  }

  await env.SUBS.put(licKey(key), JSON.stringify(lic));
  if (body.email !== undefined && oldMail !== lic.email.toLowerCase()) {
    await licIndexMove(env, key, oldMail, lic.email.toLowerCase());
  }

  // 通行證作廢要跟著 `revoked` 走**兩個方向**。
  // 只處理停用不處理恢復的話，後台按了「恢復」畫面會說成功，
  // 但那台裝置的通行證仍在作廢清單裡 → 使用者依舊用不了，且沒有任何錯誤訊息。
  if (body.revoked === true) await voidEntitlements(env, idsBefore);
  else if (body.revoked === false) await unvoidEntitlements(env, idsBefore);
  // 清空裝置＝把那些安裝踢掉，它們手上的通行證也要一起失效，
  // 否則「清空裝置」只是清掉一份名單，被踢掉的人照樣能用到通行證過期。
  if (body.clearDevices) await voidEntitlements(env, idsBefore);
  return json({ ok: true, licenseKey: prettyLicense(key), plan: lic.plan, expiresAt: lic.expiresAt, revoked: !!lic.revoked, devices: (lic.devices || []).length });
}

/**
 * 管理端：**永久刪除**一組授權碼。
 *
 * 與「停用」是不同的東西，兩個都要有：
 *   停用  資料留著。退款、盜用、chargeback 用——**日後有爭議時你需要那筆紀錄**。
 *   刪除  資料清掉。測試用的、發錯的、重複發的用。
 *
 * 安全設計：
 *   1. **有裝置啟用過的碼預設不給刪**，除非明確帶 force。
 *      真實使用者的碼被誤刪 = 他付了錢卻突然失效，那是最嚴重的傷害。
 *   2. 刪除時把 email 索引與訂單去重鍵一起清掉，否則會留下指向空值的索引，
 *      客服查詢時看到一組查不到內容的碼，比沒有更困惑。
 *   3. 已刪除的碼不再能啟用（KV 讀不到 → 404），**而且已經發出去的通行證
 *      會立刻作廢**（寫進 `entvoid`）。
 *
 * ⚠️ 第 3 點在 2026-08-17 改過，原本的設計是「通行證仍在有效期內運作，
 *    避免誤刪立刻把人踢下線」。實際回報的症狀是：**後台刪除授權碼，
 *    擴充功能仍顯示已啟用，而且伺服器端真的還在放行**——
 *    對「刪除」這個動作而言那是錯的，管理員按了刪除就是要它立刻停。
 *    誤刪的保護留在第 1 點（有裝置就必須帶 force），那才是正確的位置。
 *
 *    作廢用的是 `entvoid` 而不是 `revoked`：前者退回免費層，後者是整個安裝封鎖。
 *    刪掉一組發錯的碼不該讓那個人連每場 15 分鐘的免費額度都沒有。
 */
async function handleLicenseDelete(request, env) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  const lic = await readLicense(env, key);
  if (!lic) return err('查無此授權碼', 404);

  const devices = (lic.devices || []).length;
  if (devices > 0 && !body.force) {
    return json({
      error: `這組授權碼有 ${devices} 台裝置啟用中，不能直接刪除。`
        + '若確定要刪，請先確認不是真實使用者（誤刪會讓付費者立刻失效）。',
      needsForce: true, devices,
    }, 409);
  }

  // ⚠️ **刪掉授權碼不會讓已經發出去的通行證失效。**
  //    通行證是簽出去的獨立憑證，最長 14 天，`entitlementGate` 只驗簽章與期限。
  //    實際回報過的症狀：後台刪除授權碼，使用者的擴充功能仍顯示「已啟用」——
  //    而且不只是畫面，伺服器端也真的還在放行。
  //    所以刪除時必須把底下的安裝寫進撤銷清單，那是唯一能立刻生效的機制。
  await voidEntitlements(env, (lic.devices || []).map((d) => d.installId));

  await env.SUBS.delete(licKey(key));

  // 連帶清掉索引，不留下指向空值的殘骸
  if (lic.email) {
    const ik = `licmail:${lic.email.toLowerCase()}`;
    let arr = [];
    try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { /* noop */ }
    arr = arr.filter((k) => k !== key);
    if (arr.length) await env.SUBS.put(ik, JSON.stringify(arr));
    else await env.SUBS.delete(ik);
  }
  // 訂單去重鍵也要清，否則同一筆訂單日後補發會被當成重放而拒絕
  // ⚠️ 只清「指向這組碼」的那一個——同一張訂單的第二組碼（下一季票）被刪時，
  //    去重鍵指的是主授權，清掉會讓付款完成頁查不到主授權、綠界重送時再發一組
  if (lic.orderId && (await env.SUBS.get(`order:${lic.orderId}`)) === key) await env.SUBS.delete(`order:${lic.orderId}`);

  return json({ ok: true, deleted: prettyLicense(key), hadDevices: devices });
}

/** 管理端：把工單標成已解決／未解決。 */
/**
 * 工單的 KV metadata。
 *
 * ⚠️ 坑 #73（2026-10-02）：三個寫入點（擴充功能回報、網站聯絡表單、後台結案）
 *    原本**都沒寫 metadata**，而每日彙報用 `list()` 數「未處理」——list 只回傳鍵名與
 *    metadata，於是未處理的數量永遠等於工單總數：後台 3 張全部結案，
 *    彙報每天照樣寄「有 3 張工單還沒處理」。
 *    與 `ord:`／`bundle:`／`nosub:` 同一條規則：**會被 list 讀摘要的前綴，每個寫入點都要帶 metadata**。
 */
function reportMeta(rec) {
  return { resolved: !!(rec && rec.resolved), at: (rec && rec.at) || 0 };
}

async function handleReportPatch(request, env) {
  const body = await request.json().catch(() => null);
  const id = String((body && body.id) || '').trim();
  if (!id) return err('缺少工單編號');
  let key = `report:${id}`;
  let raw = await env.SUBS.get(key);
  if (!raw) { key = `areport:${id}`; raw = await env.SUBS.get(key); }
  if (!raw) return err('查無此工單', 404);
  const rec = JSON.parse(raw);

  if (body.resolved !== undefined) {
    rec.resolved = !!body.resolved;
    rec.resolvedAt = body.resolved ? nowSec() : null;
  }
  if (body.adminNote !== undefined) rec.adminNote = String(body.adminNote).slice(0, 2000);
  if (body.delete) { await env.SUBS.delete(key); return json({ ok: true, deleted: id }); }

  // 保留原本的 TTL 計算方式，避免「編輯一次就重新計時 90 天」
  const age = nowSec() - (rec.at || nowSec());
  const left = Math.max(86400, (rec.auto ? AUTO_REPORT_TTL_DAYS : REPORT_TTL_DAYS) * 86400 - age);
  // ⚠️ **一定要帶 metadata。** KV 的 put 不帶 metadata 會把原本的整個清掉（坑 #73），
  //    而每日彙報數「未處理工單」讀的正是 metadata——漏掉這一行，結案永遠不會被看到。
  await env.SUBS.put(key, JSON.stringify(rec), { expirationTtl: left, metadata: reportMeta(rec) });
  return json({ ok: true, id, resolved: !!rec.resolved });
}

/** 管理端：發碼。P3 接上金流後由 webhook 呼叫，現在先手動。 */
async function handleLicenseIssue(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');
  // ⚠️ 授權碼綁帳號（2026-10-04 起）：沒有 email、或登入收不了的 email，發出去的碼**沒有人用得了**
  //    （沒有任何帳號擁有它）。以前後台可以不填 email 發碼。
  if (!looksLikeEmail(body.email)) return err('授權碼要綁在帳號上：請填寫客人用來登入的 email');
  const key = normLicense(body.licenseKey || licenseKeyNew());
  let plan = PLANS[body.plan] ? String(body.plan) : 'season';

  // 早鳥限量。**不能靠人工盯著改**——賣超了要嘛食言要嘛虧錢，兩個都不該發生。
  // 超過就自動降級成正式價，並在回應裡說明，讓發碼的人知道發生了什麼。
  let downgraded = false;
  let earlyUsed = -1;
  if (plan === 'season_early') {
    // 後台發的早鳥也要佔名額（AuthGuard），id 用授權碼。沒名額就改發同內容的季票
    if (await earlyClaim(env, 'admin:' + key, body.email)) earlyUsed = await earlyIssued(env);
    else { plan = earlyTargetKey() || 'season'; downgraded = true; earlyUsed = await earlyIssued(env); }
  }
  // ⚠️ **後台發的碼必須與 webhook 發的碼有相同欄位。**
  //    少了 weekFrom，比賽週通行證的正式七天不知道從哪天算；
  //    少了 paid，這張碼日後升級賽季票時折抵金額會算成 0——
  //    兩者都不會報錯，只會在幾週後變成一筆客訴。
  // ⚠️ **後台發比賽週通行證時必須指定是哪幾場。**
  //    不指定的話發出去的碼沒有 windows，使用者的設定頁看不到「涵蓋哪一場」，
  //    而客服也對不上他到底補償了什麼。沒指定時預設給「接下來一場」。
  const wantGps = Array.isArray(body.gpIds) ? body.gpIds.map(String).filter(Boolean) : [];
  let wkGps = [];
  if (PLANS[plan] && PLANS[plan].weekBound) {
    wkGps = wantGps.length
      ? wantGps.map((id) => gpById(id)).filter(Boolean)
      : (() => {
        // 沒指定就給「接下來還賣得出去的那一場」。
        // ⚠️ 不可以用「區間還沒結束」——正賽剛跑完的那一站區間還開著，
        //    挑到它等於補償一張只剩重播的通行證。
        const g = gpList().find((x) => gpSellable(x));
        return g ? [g] : [];
      })();
  }
  const wkWins = wkGps.map((g) => { const w2 = gpWindow(g); return w2 ? [w2.from, w2.until] : null; })
    .filter(Boolean);
  const wkMerged = mergeWindows(wkWins);
  const opsNow = await opsConfig(env);
  const lic = {
    plan,
    email: accountKey(body.email),              // 來自金流，用於補發，不另外收集
    acct: accountKey(body.email),               // 帳號鍵，見 accountKey 的說明
    orderId: String(body.orderId || ''),
    // 期限一律由伺服器依方案算。只有明確傳 expiresAt 時才覆寫（客服調整用）。
    expiresAt: body.expiresAt ? Number(body.expiresAt)
      : (wkMerged.length ? Math.max(...wkMerged.map((x) => x[1])) : planExpiry(plan)),
    startsAt: wkMerged.length ? Math.min(...wkMerged.map((x) => x[0])) : planStart(plan),
    // 與 webhook 發出的碼**欄位完全一致**——少一個，使用者的設定頁就少一塊，
    // 而那不會報錯（這個專案已經因為欄位不一致踩過兩次）。
    windows: wkMerged.length ? wkMerged : null,
    gpIds: wkGps.length ? wkGps.map((g) => gpId(g)) : null,
    gpName: wkGps.length ? wkGps.map((g) => g.label || `${g.name}大獎賽`).join('、') : null,
    gpCount: wkGps.length || null,
    nextLabel: (() => {
      if (!wkGps.length) return null;
      const w2 = gpWindow(wkGps[wkGps.length - 1]);
      return w2 && w2.next ? (w2.next.label || `${w2.next.name}大獎賽`) : null;
    })(),
    // 實付金額。手動發碼時預設用此刻的實際售價；補償碼是 0，折抵時自然算不到。
    paid: body.paid !== undefined ? Number(body.paid) || 0 : (planPrice(plan, opsNow) || 0),
    items: [{ key: plan, qty: 1, unit: planPrice(plan, opsNow) || 0 }],
    services: PLANS[plan] && PLANS[plan].manual
      ? [{ key: plan, qty: 1, label: PLANS[plan].label, status: 'pending' }] : null,
    devices: [],
    createdAt: nowSec(),
    revoked: false,
    source: 'admin',
  };
  await env.SUBS.put(licKey(key), JSON.stringify(lic));
  // 建 email 索引，讓「忘記授權碼」查得回來
  if (lic.email) {
    const ik = `licmail:${lic.email.toLowerCase()}`;
    let arr = [];
    try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { /* noop */ }
    if (!arr.includes(key)) arr.push(key);
    await env.SUBS.put(ik, JSON.stringify(arr));
  }
  return json({
    ok: true, licenseKey: prettyLicense(key), plan: lic.plan,
    planLabel: (PLANS[lic.plan] || {}).label || lic.plan,
    expiresAt: lic.expiresAt,
    downgraded,
    // 只有發早鳥時才知道剩幾組；發正式方案時不為了顯示而多掃一次 KV
    earlyLeft: earlyUsed < 0 ? null : Math.max(0, EARLY_LIMIT - earlyUsed),
  });
}

/**
 * 寄出授權碼。
 *
 * ⚠️ **買家看不到訂單資訊，是目前最嚴重的體驗缺口**——付了錢卻什麼都沒收到，
 *    第一個念頭是被騙。付款完成頁可以顯示，但那一頁關掉就再也找不回來，
 *    而授權碼是他日後換電腦、重灌時唯一的憑據。
 *
 * 寄信一律走 `sendMail()`（2026-11-03 起，見下方）。**沒設定任何一家時不報錯、
 * 只記一筆事件**——寄信失敗絕不能影響發碼：授權碼已經在資料庫裡了，
 * 客服補寄得回來，但如果因為寄信炸掉而讓發碼流程中斷，那是真的損失。
 *
 * 需要的設定：
 *   MAIL_FROM（vars，例如 "PitLingo <noreply@pitlingo.com>"，網域要在每一家都驗證過）
 *   以及下面三家至少一家
 */

/**
 * 寄信（2026-11-03，Ray：「主用 Cloudflare 備援 Resend 跟 ZeptoMail」）。
 *
 * 依序試，沒設定的那一家直接跳過、前一家失敗就換下一家：
 *   1. Cloudflare Email Sending —— `[[send_email]] name = "EMAIL"` binding（Workers Paid 每月含 3,000 封，
 *      超過每千封 US$0.35；Beta、新帳號每日額度未公布）。不需要金鑰。
 *   2. Resend —— `RESEND_API_KEY`（免費版每月 3,000、每天 100 封）
 *   3. ZeptoMail —— `ZEPTOMAIL_TOKEN`（Mail Agent 的 Send Mail Token，不含前綴）；
 *      `ZEPTOMAIL_URL` 選填，**照 ZeptoMail 後台 Mail Agent → API 顯示的網址填**——
 *      預設 api.zeptomail.com——**2026-11-03 實測 cpaas.zoho.com/v1.1/email 回 HTTP 500**（官方英文頁寫的是它，後台網址也是 cpaas.zoho.com）；帳號所在區域不同時要改
 *
 * ⚠️ 回傳 `{ ok, via, status, tried }`：`status` 是最後一家的結果（'sent'／'HTTP 4xx …'／錯誤碼），
 *    `tried` 記每一家的結果——呼叫端原本拼的「HTTP nnn」字串照舊從 `status` 來。
 * ⚠️ 前一家「其實寄出了但回報失敗」（逾時）時，下一家會再寄一次＝收件人收到兩封。
 *    驗證碼信兩封內容相同，可以接受；**不能因為怕重複就不備援**——寄不到才是真的壞掉。
 */
function mailConfigured(env) {
  return !!(env && ((env.EMAIL && typeof env.EMAIL.send === 'function') || env.RESEND_API_KEY || env.ZEPTOMAIL_TOKEN));
}

function mailFromParts(env) {
  const raw = String(env.MAIL_FROM || 'PitLingo <noreply@pitlingo.com>').trim();
  const m = raw.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  return m ? { raw, name: m[1].replace(/^"|"$/g, '').trim(), email: m[2] } : { raw, name: '', email: raw };
}

async function sendMail(env, msg) {
  const to = [].concat((msg && msg.to) || []).filter(Boolean);
  const tried = [];
  if (!to.length) return { ok: false, via: '', status: 'no_recipient', tried };
  const from = mailFromParts(env);
  const { subject, html } = msg;
  const text = msg.text || undefined;
  const timeout = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined);

  const providers = [];
  if (env.EMAIL && typeof env.EMAIL.send === 'function') {
    providers.push(['cloudflare', async () => {
      try {
        await env.EMAIL.send({
          from: from.name ? { email: from.email, name: from.name } : from.email,
          to, subject, html, ...(text ? { text } : {}),
        });
        return 'sent';
      } catch (e) { return String((e && (e.code || e.message)) || e).slice(0, 120); }
    }]);
  }
  if (env.RESEND_API_KEY) {
    providers.push(['resend', async () => {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: from.raw, to, subject, html, ...(text ? { text } : {}) }),
        signal: timeout(),
      });
      if (r.ok) return 'sent';
      const t = await r.text().catch(() => '');
      return `HTTP ${r.status} ${t.slice(0, 200)}`.trim();
    }]);
  }
  if (env.ZEPTOMAIL_TOKEN) {
    providers.push(['zeptomail', async () => {
      const r = await fetch(env.ZEPTOMAIL_URL || 'https://api.zeptomail.com/v1.1/email', {
        method: 'POST',
        headers: { authorization: `Zoho-enczapikey ${env.ZEPTOMAIL_TOKEN}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          from: from.name ? { address: from.email, name: from.name } : { address: from.email },
          to: to.map((address) => ({ email_address: { address } })),
          subject, htmlbody: html, ...(text ? { textbody: text } : {}),
        }),
        signal: timeout(),
      });
      if (r.ok) return 'sent';
      const t = await r.text().catch(() => '');
      return `HTTP ${r.status} ${t.slice(0, 200)}`.trim();
    }]);
  }
  if (!providers.length) return { ok: false, via: '', status: 'not_configured', tried };

  for (const [name, run] of providers) {
    let status;
    try { status = await run(); } catch (e) { status = String((e && e.message) || e).slice(0, 120); }
    tried.push(`${name}:${status === 'sent' ? 'sent' : status}`);
    if (status === 'sent') return { ok: true, via: name, status: 'sent', tried };
    console.log(`sendMail: ${name} 失敗（${status}），換下一家`);
  }
  return { ok: false, via: '', status: tried.length ? tried[tried.length - 1].replace(/^[a-z]+:/, '') : 'failed', tried };
}
/**
 * 所有對外信件共用的外框。
 *
 * 參考了三封真實的商用信（Riot 登入碼、Netflix 新裝置通知、PlayStation 收據），
 * 它們的頁尾都做了同樣四件事，而我們原本一件都沒有：
 *
 *   1. **防釣魚聲明**——「我們不會向你索取…」。使用者日後一定會收到
 *      假冒我們的信，這一句是他當下唯一的判斷依據。
 *   2. **為什麼你會收到這封信**——Netflix 寫「因為您是會員」。
 *      沒有這句的信會被當成垃圾郵件檢舉，而檢舉會傷到整個網域的信譽。
 *   3. **這是系統信、不要回覆**——回了沒人看，使用者以為我們不理他。
 *   4. **條款／隱私權／客服三個連結**——三封參考信全都有，而且是法遵要件。
 *
 * ⚠️ **不要在這裡放任何追蹤像素或外連圖片。** 隱私權政策沒有寫這件事，
 *    而且圖片被擋掉時版面會破。信件的內容要在純文字模式下也讀得完整。
 */
// ---- 信件樣式：與網站同一套（legal/site.css 的 :root，2026-09-17）----
//
// ⚠️ **只能用行內樣式與表格排版。** Gmail 會丟掉 <style> 裡大部分規則、Outlook 用 Word 引擎排版，
//    div + flex 在那裡會整個散掉。背景色要同時寫 bgcolor 屬性與 style，少一個就有客戶端變白底。
// ⚠️ **深色是刻意的**（與網站一致）。meta color-scheme 告訴支援的客戶端「這封本來就是深色」，
//    避免它再反轉一次變成灰底黑字。
// ⚠️ 圖片一定要有文字備援：很多信箱預設不載入圖片，標頭仍要看得出是 PitLingo。
// 後台網址（legal/secret-pitstop.html）。只有寄給管理員的信會用到；改路徑時 check-links 會驗兩邊一致
const ADMIN_PAGE_PATH = '/secret-pitstop';

const MAIL_C = {
  page: '#0e0e14', card: '#15151e', surface: '#1e1e27', line: '#313139',
  text: '#ffffff', body: '#c9c9cf', dim: '#8b898c', red: '#e10600',
};
const MAIL_FONT = "system-ui,-apple-system,'Segoe UI','Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif";
const MAIL_MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/** 小標題：白字＋左側紅線（網站區塊標題的樣子） */
function mailH2(t) {
  return `<h2 style="margin:26px 0 10px;padding-left:10px;border-left:3px solid ${MAIL_C.red};`
    + `font:700 16px/1.4 ${MAIL_FONT};color:${MAIL_C.text}">${t}</h2>`;
}

/** 膠囊按鈕（網站的主要 CTA）。用表格包，Outlook 才有底色。 */
function mailButton(href, label) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 6px">'
    + `<tr><td bgcolor="${MAIL_C.red}" style="background:${MAIL_C.red};border-radius:999px">`
    + `<a href="${href}" style="display:inline-block;padding:13px 28px;font:700 15px/1 ${MAIL_FONT};`
    + `color:#ffffff;text-decoration:none;border-radius:999px">${label}</a></td></tr></table>`;
}

/** 授權碼、驗證碼那種「要抄下來」的框 */
function mailCodeBox(text, size, spacing) {
  return `<div style="font:700 ${size}px/1.4 ${MAIL_MONO};letter-spacing:${spacing}px;color:${MAIL_C.text};`
    + `background:${MAIL_C.surface};border:1px solid ${MAIL_C.line};border-left:4px solid ${MAIL_C.red};`
    + `border-radius:8px;padding:18px 12px;text-align:center;margin:16px 0">${text}</div>`;
}

function mailShell(title, bodyHtml, opts) {
  const site = (opts && opts.site) || 'https://pitlingo.com';
  const why = (opts && opts.why) || '您曾在 PitLingo 購買或使用我們的服務';
  const link = (href, t) =>
    `<a href="${site}${href}" style="color:${MAIL_C.text};text-decoration:underline">${t}</a>`;
  const C = MAIL_C;
  return [
    '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">',
    `<title>${title}</title></head>`,
    `<body style="margin:0;padding:0;background:${C.page}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}">`,
    '<tr><td align="center" style="padding:28px 12px">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" `
      + `style="max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:8px">`,
    // 頂端紅線（網站頁首下緣那條）
    `<tr><td height="4" bgcolor="${C.red}" style="height:4px;line-height:4px;font-size:0;background:${C.red};border-radius:8px 8px 0 0">&nbsp;</td></tr>`,
    // 標頭：頭像＋字標。圖片載不出來時，alt 與旁邊的字仍看得出是誰寄的
    `<tr><td style="padding:22px 28px 0"><a href="${site}" style="text-decoration:none;color:${C.text}">`
      + `<img src="${site}/mail-logo-96.png" width="36" height="36" alt="PitLingo" `
      + `style="display:inline-block;vertical-align:middle;border:0;border-radius:8px">`
      + `<span style="display:inline-block;vertical-align:middle;margin-left:10px;font:800 19px/36px ${MAIL_FONT};`
      + `letter-spacing:.3px;color:${C.text}">PitLingo</span></a></td></tr>`,
    `<tr><td style="padding:20px 28px 6px;font:16px/1.75 ${MAIL_FONT};color:${C.body}">`,
    `<h1 style="margin:0 0 14px;font:800 24px/1.35 ${MAIL_FONT};color:${C.text}">${title}</h1>`,
    bodyHtml,
    '</td></tr>',
    `<tr><td style="padding:10px 28px 26px;font:13px/1.75 ${MAIL_FONT};color:${C.dim}">`,
    `<div style="border-top:1px solid ${C.line};margin:14px 0 14px;height:0;line-height:0;font-size:0">&nbsp;</div>`,
    `<p style="margin:0 0 10px;color:${C.body}">`,
    // 1. 防釣魚
    `<b style="color:${C.text}">PitLingo 不會以任何方式向您索取密碼、驗證碼或信用卡資訊。</b><br>`,
    '若您收到可疑信件，請勿點擊其中連結，並來信告知我們。',
    '</p>',
    '<p style="margin:0 0 10px">',
    // 3. 系統信
    '此為系統自動發送的信件，請勿直接回覆——回覆不會有人看到。<br>',
    // 2. 為什麼收到
    `您收到這封信，是因為${why}。`,
    '</p>',
    '<p style="margin:0">',
    [link('/terms', '使用條款'), link('/privacy', '隱私權政策'), link('/contact', '聯絡客服')]
      .join(' 　·　 '),
    '<br>© ' + new Date().getUTCFullYear() + ' PitLingo',
    '</p>',
    '</td></tr></table>',
    '</td></tr></table></body></html>',
  ].join('');
}

/**
 * 通知管理員（你）。
 *
 * ⚠️ **這一支存在的理由：新訂單與診斷回報原本只走 `REPORT_WEBHOOK`，
 *    而那個變數從來沒設過——也就是說「有人買了東西」這件事
 *    不會以任何形式通知到你。**
 *
 *    買家那封信寄失敗時更嚴重：買家沒收到碼、你也不知道有人買了，
 *    第一個發現的人是三天後寫信來問的客戶。
 *
 * 兩條路都送，而且**任一條失敗都不影響主流程**——
 * 通知是附加價值，不可以因為通知掛掉就讓發碼失敗。
 */
async function notifyAdmin(env, subject, text, opts) {
  const out = { webhook: 'skipped', mail: 'skipped' };
  const to = (opts && opts.to) || env.REPORT_TO;

  if (env.REPORT_WEBHOOK) {
    try {
      const r = await fetch(env.REPORT_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject, to, text: String(text).slice(0, 60000) }),
      });
      out.webhook = r.ok ? 'sent' : `HTTP ${r.status}`;
    } catch (e) { out.webhook = String((e && e.message) || e).slice(0, 120); }
  }

  if (mailConfigured(env) && to) {
    try {
      const body = mailShell(subject,
        `<pre style="white-space:pre-wrap;word-break:break-word;font:13px/1.65 ${MAIL_MONO};`
        + `color:${MAIL_C.body};background:${MAIL_C.page};`
        + `border:1px solid ${MAIL_C.line};border-radius:8px;padding:14px;margin:0">`
        + String(text).slice(0, 60000).replace(/[&<>]/g, (c) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
        + '</pre>',
        { site: env.SITE_URL || 'https://pitlingo.com', why: '您是 PitLingo 的管理員' });
      const r = await sendMail(env, { to: [to], subject, html: body });
      out.mail = r.ok ? 'sent' : r.status;
    } catch (e) { out.mail = String((e && e.message) || e).slice(0, 120); }
  }

  return out;
}

/**
 * 訂單完成／授權重新設定信的標題與 HTML。
 * 文字可在後台改（MAIL_DEFS.order／order_nokey／reissue，v5.94）；交易明細、多份授權清單、
 * 代訂說明、啟用方式是程式產生的區塊（{{receipt}} 必要——那是買家唯一的交易明細，含「非統一發票」）。
 * `opts.mailOverride`：後台預覽用的草稿內容。
 */
async function buildLicenseMail(env, to, key, lic, opts) {
  // ⚠️ **沒有授權碼的訂單也要寄信。** 共用帳號的單一比賽週末代訂不含字幕授權，
  //    所以不發碼——但買家仍然付了錢，**不寄信等於他付完款什麼都沒收到**。
  //    那封信講的是「我們收到訂單了，三個工作日內開通」。
  const noKey = !!(opts && opts.noLicense) || !key;

  const items = (lic.items || []).map((i) => {
    const p = PLANS[i.key];
    return `<li>${p ? p.label : i.key}${i.qty > 1 ? ` × ${i.qty}` : ''}</li>`;
  }).join('');
  const svc = (lic.services || []).length
    ? '<p><b>代訂服務</b>將於一個工作天內處理完成，完成後另行以本信箱通知，帳號資訊請登入「我的帳號」查看。'
      + '請注意：<b>觀看 F1TV 需自行準備 VPN</b>。</p>'
    : '';
  const exp = lic.expiresAt
    ? new Date(lic.expiresAt * 1000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
    : '無期限';

  // ---- 收據表格（參考 PlayStation 的購買完成信）----
  //
  // ⚠️ **金額一定要列出來。** 原本的信只列品名不列價格，於是買家手上
  //    沒有任何一份寫著「我付了多少」的文件——爭議時雙方各說各話。
  const money = (n) => 'NT$' + Number(n || 0).toLocaleString('en-US');
  const C = MAIL_C;
  const cell = `padding:8px 0;border-bottom:1px solid ${C.line};color:${C.text}`;
  let itemsSum = 0;
  const rows = (lic.items || []).map((i) => {
    const p = PLANS[i.key];
    const name = (p ? p.label : i.key) + (i.qty > 1 ? ` × ${i.qty}` : '');
    const sum = Number(i.unit || 0) * Number(i.qty || 1);
    itemsSum += sum;
    return `<tr><td style="${cell}">` + name
      + `</td><td style="${cell};text-align:right;white-space:nowrap">` + (sum ? money(sum) : '—') + '</td></tr>';
  }).join('');
  // ⚠️ **總計是這張訂單實付的金額，不是 lic.paid。**（2026-09-17 修）
  //    lic.paid 刻意只記「通行證那幾列」（給升級折抵用，見 handlePaymentWebhook），
  //    所以「比賽週通行證＋代訂」的信原本寫「總計 NT$599」，上面卻列著 599 與 4,599——
  //    買家手上唯一的交易明細金額是錯的。訂單總價由呼叫端給（opts.total），
  //    舊授權沒有 orderTotal 時才退回品項加總。
  const total = (opts && opts.total !== undefined && opts.total !== null) ? Number(opts.total) || 0
    : (lic.orderTotal !== undefined && lic.orderTotal !== null) ? Number(lic.orderTotal) || 0
      : (itemsSum || Number(lic.paid || 0));
  // 升級補差價：品項是牌價，實付比較少，差額要列出來，否則加總對不起來
  const credit = rows && itemsSum > total ? itemsSum - total : 0;
  const site = env.SITE_URL || 'https://pitlingo.com';

  const reissued = !!(opts && opts.reissued) && !noKey;
  // 同一張訂單的其他授權碼（見 issueForPaidOrder 的 extras）：[{ key, lic }]
  const extraList = (opts && Array.isArray(opts.extra)) ? opts.extra.filter((x) => x && x.key && x.lic) : [];
  const planName = (l) => (l.gpName ? `比賽週通行證（${l.gpName}）` : ((PLANS[l.plan] || {}).label || l.plan));
  const dateTw = (sec, withTime) => new Date(sec * 1000).toLocaleString('zh-TW', withTime
    ? { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric' });
  // ⚠️ 2026-10-30 起**信裡不放授權碼**：授權以帳號為準，碼只是後端的記錄編號。
  //    換發的開頭要先講「舊碼已經失效、所有裝置都登出了」；不含字幕授權的訂單要明講為什麼——
  //    那兩段文字在 MAIL_DEFS.reissue／order_nokey 的預設內文裡。
  // 同一張訂單有兩份授權時（本賽季＋下一賽季票），每一份都要標清楚是哪個方案、何時生效
  const contains = [
    (!noKey && extraList.length) ? mailH2('這張訂單包含') : '',
    (!noKey && extraList.length) ? `<ul style="padding-left:20px;margin:0;color:${C.body}">`
      + [{ lic }].concat(extraList).map((x) => `<li><b>${planName(x.lic)}</b>：`
        + (x.lic.startsAt && x.lic.startsAt > nowSec() + 60
          ? `${dateTw(x.lic.startsAt, true)}（台灣時間）起生效，`
          : '')
        + `有效期至 ${x.lic.expiresAt ? dateTw(x.lic.expiresAt) : '無期限'}</li>`).join('')
      + '</ul>'
      + `<p style="font-size:14px;color:${C.dim};margin:6px 0 0">還沒生效的那一份，時間到了會自動接上。</p>` : '',

  ].join('');
  const receipt = [
    // ---- 交易明細 ----
    mailH2('交易明細'),
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
      + `style="width:100%;border-collapse:collapse;font:15px/1.5 ${MAIL_FONT}">`,
    `<tr><td style="padding:6px 0;color:${C.dim}">訂單編號</td>`
      + `<td style="padding:6px 0;text-align:right;color:${C.text};font-family:${MAIL_MONO}">${lic.orderId || '-'}</td></tr>`,
    `<tr><td style="padding:6px 0;color:${C.dim}">購買日期</td>`
      + `<td style="padding:6px 0;text-align:right;color:${C.text}">`
      + `${new Date((lic.createdAt || nowSec()) * 1000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}`
      + '</td></tr>',
    // 還沒生效的要寫出生效日：下一賽季票在本賽季最後一站結束後才生效、還沒開始的比賽週也是（2026-10-30）
    (!noKey && lic.startsAt && lic.startsAt > (lic.createdAt || nowSec()) + 60)
      ? `<tr><td style="padding:6px 0;color:${C.dim}">生效日</td>`
        + `<td style="padding:6px 0;text-align:right;color:${C.text}">`
        + `${new Date(lic.startsAt * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}（台灣時間）`
        + '</td></tr>'
      : '',
    noKey ? '' : `<tr><td style="padding:6px 0;color:${C.dim}">有效期至</td>`
      + `<td style="padding:6px 0;text-align:right;color:${C.text}">${exp}</td></tr>`,
    '</table>',
    rows ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
      + `style="width:100%;border-collapse:collapse;font:15px/1.5 ${MAIL_FONT};margin-top:12px">`
      + `<tr><th style="text-align:left;padding:6px 0;border-bottom:2px solid ${C.line};font-size:13px;`
      + `color:${C.dim};font-weight:600">項目</th><th style="text-align:right;padding:6px 0;border-bottom:2px solid ${C.line};`
      + `font-size:13px;color:${C.dim};font-weight:600">金額</th></tr>`
      + rows
      + (credit ? `<tr><td style="${cell}">升級補差價折抵</td>`
        + `<td style="${cell};text-align:right;white-space:nowrap">−${money(credit)}</td></tr>` : '')
      + `<tr><td style="padding:12px 0;font-weight:800;color:${C.text}">總計</td>`
      + `<td style="padding:12px 0;text-align:right;font-weight:800;font-size:18px;color:${C.text};white-space:nowrap">${money(total)}</td></tr>`
      + '</table>' : '',
    // ⚠️ **一定要寫這一句。** 目前沒有統一發票機制（見待辦清單），
    //    而買家會把這封信當成發票用。PlayStation 的收據也是這樣寫的——
    //    講清楚「這不是發票」，比事後解釋為什麼沒有發票好得多。
    `<p style="font-size:13px;color:${C.dim};margin:8px 0 0">`
      + `本信件為交易明細，<b style="color:${C.body}">非統一發票</b>。</p>`,
  ].join('');
  const activate = [
    noKey ? '' : mailH2('啟用方式'),
    // 授權綁帳號（2026-10-04 起）：要登入**這個信箱**，授權才會啟用
    noKey ? '' : `<ol style="padding-left:20px;margin:0;color:${C.body}"><li>安裝 PitLingo 擴充功能</li>`
      + `<li>點擴充功能圖示 → <b>登入</b>（請用 ${esc(to)}）→ 授權會自動啟用。已經用這個信箱登入了？點一下擴充功能圖示就會立刻生效</li>`
      + '<li>打開 F1TV 影片，並在播放器開啟英文字幕（CC）</li></ol>',
    noKey ? '' : `<p style="font-size:14px;color:${C.dim};margin:10px 0 0">最多可在 3 台裝置同時啟用，可自行解除後轉移。</p>`,
  ].join('');
  const id = reissued ? 'reissue' : (noKey ? 'order_nokey' : 'order');
  const m = await composeMail(env, id, { email: to, orderId: lic.orderId || '' }, opts && opts.mailOverride,
    { contains: noKey ? '' : contains, receipt, service: svc, activate: noKey ? '' : activate });

  return {
    subject: m.subject,
    html: mailShell(m.title, m.bodyHtml, {
      site: m.site,
      why: reissued ? '客服為這個信箱的 PitLingo 授權重新設定' : '您在 PitLingo 完成了一筆購買',
    }),
  };
}

async function sendLicenseMail(env, to, key, lic, opts) {
  if (!mailConfigured(env) || !to) return { sent: false, reason: 'not_configured' };
  try {
    const m = await buildLicenseMail(env, to, key, lic, opts);
    const r = await sendMail(env, {
        to: [to],
        // ⚠️ **授權碼絕對不可以放進主旨。**
        //
        //    原本是 `PitLingo 授權碼 ${pretty}`。主旨會出現在鎖定畫面的通知、
        //    郵件列表的預覽、以及各種記錄郵件標頭的中繼系統裡——
        //    也就是說，**授權碼會出現在所有「不必打開信」就看得到的地方**。
        //
        //    對照參考信：Riot 把登入碼放在主旨是**對的**，因為那是 10 分鐘、
        //    一次性的東西，方便性勝過風險；而授權碼是**整季有效的永久憑證**，
        //    性質剛好相反。同一個做法用在不同性質的憑證上，一個是體貼，
        //    一個是把鑰匙貼在門上。
        //    （後台也擋：區塊 {{…}} 不准放在標題；標題的變數只有 {email}、{orderId}）
        subject: ((opts && opts.subjectTag) || ((s) => s))(m.subject),
        html: m.html,
    });
    if (!r.ok) return { sent: false, reason: r.status };
    return { sent: true, via: r.via };
  } catch (e) {
    return { sent: false, reason: String(e && e.message || e) };
  }
}

/** 管理端：停用（退款、盜用、chargeback）。 */
async function handleLicenseRevoke(request, env) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  const lic = await readLicense(env, key);
  if (!lic) return err('查無此授權碼', 404);
  lic.revoked = true;
  lic.revokedAt = nowSec();
  await env.SUBS.put(licKey(key), JSON.stringify(lic));
  // 與刪除同理：光是把 `revoked` 寫進授權記錄，只會讓**下一次續期**被拒；
  // 在那之前（最長 24 小時）已發出的通行證照樣通過伺服器端閘門。
  // 退款與盜用都要求立刻生效，所以一併讓通行證作廢。
  await voidEntitlements(env, (lic.devices || []).map((d) => d.installId));
  return json({ ok: true, devices: (lic.devices || []).length });
}

/** 管理端：用 email 查回授權碼（客服補發用）。 */
async function handleLicenseLookup(request, env, url) {
  const email = String(url.searchParams.get('email') || '').toLowerCase().trim();
  if (!email) return err('需要 email');
  let arr = [];
  try { arr = JSON.parse((await env.SUBS.get(`licmail:${email}`)) || '[]'); } catch (e) { /* noop */ }
  const out = [];
  for (const k of arr) {
    const lic = await readLicense(env, k);
    if (lic) out.push({ licenseKey: prettyLicense(k), plan: lic.plan, expiresAt: lic.expiresAt, revoked: !!lic.revoked, devices: (lic.devices || []).length });
  }
  return json({ email, licenses: out });
}

