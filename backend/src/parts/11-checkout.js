// ---------------------------------------------------------------------------
// 結帳（綠界 AioCheckOut V5）
//
// 流程：
//   1. 使用者在 /buy 選方案、勾選同意條款 → POST /v1/checkout
//   2. 我們建立訂單、算 CheckMacValue、回傳一份「自動送出的表單」
//   3. 瀏覽器把表單 POST 到綠界的收銀台
//   4. 使用者付款
//   5. 綠界 **伺服器對伺服器** POST 到 ReturnURL（/v1/payment/webhook）→ 我們發碼
//   6. 綠界把瀏覽器導回 OrderResultURL（/paid）→ 顯示授權碼
//
// ⚠️ 發碼**只認第 5 步**，不認第 6 步。
//    第 6 步是瀏覽器導向，任何人都能自己打開那個網址並偽造參數。
//    只有 ReturnURL 的通知帶得出正確的 CheckMacValue。
//
// ⚠️ ATM 與超商是**非即時付款**：
//    綠界會先送一次「取號成功」（RtnCode=2）到 PaymentInfoURL，
//    幾天後真的付款了才送 RtnCode=1 到 ReturnURL。
//    **RtnCode=2 絕對不能發碼**——那時候錢還沒進來。
// ---------------------------------------------------------------------------

// 正式與測試的收銀台位址。測試環境用綠界公開的共用帳號，
// 可以走完整流程而不會真的扣款——**正式環境上線前唯一能驗證的方法**。
const ECPAY_URL = {
  production: 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5',
  stage: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
};

// 綠界公開的測試帳號（官方文件公佈，不是機密）
const ECPAY_TEST = {
  merchantId: '3002607',
  hashKey: 'pwFHCqoQZGmho4w6',
  hashIV: 'EkRm7iFT261dpevs',
};

/**
 * 測試收銀台與測試簽章是否開放。**預設關閉。**
 *
 * ⚠️ 2026-09-17 修掉的洞：綠界的測試金鑰是官方文件公佈的，也寫在這個公開 repo 裡。
 *    以前 webhook 對每一筆通知都「正式、測試兩組都試」，於是：
 *      1. 任何人都能自己算出一個「付款成功」的測試簽章，換到免費的賽季通行證；
 *      2. 就算不偽造，結帳時送 `mode: 'stage'` 就能在測試收銀台用綠界公開的
 *         測試卡號「付款」，回來的通知是真的測試簽章，一樣發碼。
 *    每一筆都是 200、授權信照常寄出，**完全不會報錯**。
 *
 * 要走一次完整的測試流程時：`wrangler secret put ECPAY_ALLOW_STAGE`（值填 1），
 * 測完**立刻刪掉**（`wrangler secret delete ECPAY_ALLOW_STAGE`）。
 * 即使開著，測試簽章也**只認當初以測試模式建立的訂單**（見 ecpayMacOk）。
 */
function stageAllowed(env) {
  return String((env && env.ECPAY_ALLOW_STAGE) || '') === '1';
}

/**
 * 驗綠界通知的簽章。回傳通過的是哪一組（'production'／'stage'），都不通過回 null。
 *
 * ⚠️ 測試簽章要同時滿足三件事才算數：開放測試、訂單存在、訂單是以測試模式建立的。
 *    少一件，公開的測試金鑰就又變回一把萬能鑰匙。
 */
async function ecpayMacOk(env, p, pending) {
  const mine = String(p.CheckMacValue || '').toUpperCase();
  if (!mine) return null;
  if (env.ECPAY_HASH_KEY && env.ECPAY_HASH_IV
    && safeEqual(mine, await ecpayMac(p, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV))) return 'production';
  if (stageAllowed(env) && pending && pending.mode === 'stage'
    && safeEqual(mine, await ecpayMac(p, ECPAY_TEST.hashKey, ECPAY_TEST.hashIV))) return 'stage';
  return null;
}

async function readPending(env, no) {
  if (!no) return null;
  try { return JSON.parse((await env.SUBS.get(`pending:${no}`)) || 'null'); } catch (e) { return null; }
}

function ecpayConf(env, mode) {
  if (mode === 'stage') {
    return { ...ECPAY_TEST, url: ECPAY_URL.stage, mode: 'stage' };
  }
  return {
    merchantId: env.ECPAY_MERCHANT_ID || '',
    hashKey: env.ECPAY_HASH_KEY || '',
    hashIV: env.ECPAY_HASH_IV || '',
    url: ECPAY_URL.production,
    mode: 'production',
  };
}

/**
 * 綠界的訂單編號：英數字，最長 20 碼，**必須唯一**。
 *
 * ⚠️ 時間戳只到秒，所以同一秒內的訂單完全靠隨機碼區分。
 *    第一版寫成「3 bytes → base36 → 截 5 碼」，實測 3000 次撞 12 次——
 *    因為單一 byte 轉 base36 最多兩碼再補零，分布嚴重傾斜，實際只有約 18 bits。
 *    綠界收到重複的訂單編號會直接拒絕，**使用者付不了錢而且看不懂為什麼**。
 *
 *    改成直接從字元表均勻取樣：6 碼 × log2(36) ≈ 31 bits，同一秒內幾乎不可能撞。
 */
const TRADE_AB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';   // 36 個

function tradeNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // 時間戳只到「分」，把省下的兩碼讓給隨機。
  // 秒級時間戳 + 6 碼隨機在 20000 次仍會偶爾碰撞（生日問題）；
  // 分級 + 8 碼隨機把同一分鐘內的空間拉到 36^8 ≈ 2.8×10^12。
  const stamp = `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;

  // 拒絕取樣去掉模數偏差（256 不是 36 的倍數）。成本可忽略，何必留個歪的分布。
  let r = '';
  while (r.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(8))) {
      if (b >= 252) continue;                  // 252 = 7 × 36
      r += TRADE_AB[b % 36];
      if (r.length === 8) break;
    }
  }
  return `PL${stamp}${r}`;                     // PL + 10 + 8 = 20 碼，剛好在上限
}

/** 綠界要的時間格式：yyyy/MM/dd HH:mm:ss，且必須是台北時間。 */
function tradeDate() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);   // UTC+8
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} `
    + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/**
 * 把購物車算成一張報價單。
 *
 * **結帳與畫面顯示一定要走同一個函式**，否則畫面寫一個數字、綠界收另一個，
 * 那是最直接的糾紛。`/v1/quote` 與 `/v1/checkout` 都呼叫這裡。
 *
 * 三條規則按順序套用：
 *   1. 賽季方案用 `seasonPriceNow`（分段價、早鳥賣完自動降級）
 *   2. **代訂附贈的比賽週是購物車裡真正的一列（NT$0）**，不是折抵
 *   3. 升級補差價：扣掉這個 email 本賽季已付的比賽週通行證
 */
async function quoteCart(env, rawItems, opts) {
  let items = Array.isArray(rawItems) ? rawItems : [];
  const o = opts || {};
  const ops = await opsConfig(env);          // 後台可覆寫價格與下架方案
  const lines = [];
  let total = 0;
  let seasonKey = null;
  let hasSeason = false;
  const paidGps = new Set();     // 付費購買的場次
  const giftGps = new Set();     // 代訂附贈的場次

  // ⚠️ **有些組合本身就是錯的，要在算錢之前擋下來。**
  //
  //    這一段是矩陣測試（tools/check-plan-matrix.js）抓出來的兩個
  //    **會收錯錢**的 bug：
  //
  //    (1) 賽季票 + 比賽週通行證
  //        發出去的授權會帶著比賽週的區間，而 entitlementUntil 只簽到
  //        「現在這一段」的結束——**整張賽季票被截成一週**，而且比賽週之外
  //        完全不能用。客人付了 NT$338 拿到兩週。兩者本來就重複，不該讓他買。
  //
  //    (2) 同一場買兩次
  //        兩列、收兩次錢，但區間合併後只有一段——**第二筆是純損失**。
  //
  //    ⚠️ 這裡回 error 而不是「默默修正金額」：使用者手上有購買頁的截圖，
  //       默默改掉才是糾紛的來源。唯一的例外是**完全相同的重複項目**
  //       （那是用戶端的 bug，不是他的選擇），那種直接去重。
  {
    const seen = new Set();
    const dedup = [];
    for (const it of items) {
      const k = String((it && it.key) || '') + '|' + String((it && it.gp) || '');
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(it);
    }
    items = dedup;

    const ks = items.map((it) => String((it && it.key) || ''));
    const nSeason = ks.filter((k) => PLANS[k] && PLANS[k].untilSeasonEnd).length;
    const nNext = ks.filter((k) => PLANS[k] && PLANS[k].nextSeasonOnly).length;
    const nWeek = ks.filter((k) => PLANS[k] && PLANS[k].weekBound).length;
    const nReplay = ks.filter((k) => PLANS[k] && PLANS[k].offSeasonOnly).length;

    if (nSeason > 1) {
      return { error: '一次只能購買一張賽季通行證。多買一張不會延長效期，只會重複收費。' };
    }
    if (nNext > 1) {
      return { error: '一次只能購買一張下一賽季通行證。' };
    }
    // 下一賽季票＋本賽季的票（賽季票、比賽週、附贈比賽週的代訂）可以放同一張單（2026-10-30 Ray）：
    //    一張訂單發**兩組授權碼**（見下面的 licenses）。v5.80 曾經要求單獨結帳——
    //    那時一張訂單只發一組碼，另一張會被吃掉；分兩次買又多一次手續費與來回。
    // 重播月票不跟其他字幕方案一起賣：它只在休賽期賣，而那時賽季／下一季票涵蓋的期間裡重播本來就看得到
    if (nReplay && (nSeason || nNext || nWeek)) {
      return { error: '重播月票請單獨購買。已選擇的賽季或比賽週通行證涵蓋的期間內，重播本來就看得到。' };
    }
    if (nSeason && nWeek) {
      return {
        error: '賽季通行證已經涵蓋本賽季的所有場次，不需要再加購比賽週通行證。'
          + '請移除其中一種再結帳。',
      };
    }

    // ⚠️ **付費買了哪幾場，必須在跑迴圈之前就知道。**
    //    附贈的場次不可以跟付費的撞號（同一場不會重複開通），
    //    而代訂那一列可能排在通行證後面——邊跑邊記就會漏掉前面那些。
    hasSeason = nSeason > 0;
    for (const it of items) {
      const pp = PLANS[String((it && it.key) || '')];
      if (pp && pp.weekBound && it && it.gp) paidGps.add(String(it.gp));
    }
  }

  // 早鳥名額只在購物車裡有早鳥、或有被早鳥鎖住的那張（599）時才問 AuthGuard
  const early = items.some((it) => {
    const k = String((it && it.key) || '');
    return (PLANS[k] && PLANS[k].earlyBird) || k === earlyTargetKey();
  }) ? await earlyState(env) : null;

  const gpWindows = [];
  let lineFrom = null; let lineUntil = null; let lineNext = null; let lineGp = null;
  for (const it of items) {
    // ⚠️ 每一圈都要清掉，否則第二張通行證會沿用第一張的效期顯示
    lineFrom = null; lineUntil = null; lineNext = null; lineGp = null;
    const key = String((it && it.key) || '');
    const p = PLANS[key];
    if (!p || p.internal || !(p.price > 0)) return { error: `方案不存在或不販售：${key}` };
    if (ops.hidden.includes(key)) return { error: `此方案目前未販售：${p.label}` };
    const lock = planLock(key, undefined, undefined, early);
    if (lock) return { error: `${p.label} 目前無法購買——${lock}` };
    // 數量上限。
    // ⚠️ 一般方案維持 5（買 5 張賽季票沒有意義，多半是誤操作）；
    //    **通行證的上限是「本賽季剩餘比賽週」**——使用者的決定：
    //    想一次買到季末就讓他買，那是我們最不用行銷的一種營收。
    //    上限一定要有：沒有上限的話 999 張會算出一個跨到明年的效期。
    // ⚠️ 比賽週通行證**一場只能買一張**。同一場買兩張不會延長任何東西，
    //    只是收兩次錢——那是客訴。要多站就選多個場次（每場各一張）。
    // 比賽週通行證與共用帳號的代訂都是「一場一份」；一個月的代訂可買多份。
    const maxQty = (p.weekBound || p.svcWeekend) ? 1 : (Number(p.maxQty) || 5);
    // 一個月的代訂一次只賣 1 份（2026-10-30 Ray：代理商沒辦法一次訂一個月分三次）。
    // 快取裡的舊購買頁還可能送 qty 3——回錯誤，不默默改成 1（他畫面上看到的是三個月的價格）
    if (p.manual && !p.svcWeekend && maxQty === 1 && Number(it && it.qty) > 1) {
      return { error: `${p.label}一次只能購買 1 份，請重新整理購買頁` };
    }
    const qty = Math.max(1, Math.min(maxQty, Number(it.qty) || 1));
    // 代訂的帳號模式。沒帶就用預設（舊版購買頁）；帶了不允許的就**回錯誤**，不默默換掉——
    // 他在畫面上選的是 A，我們不能交付 B。
    let acctMode = null;
    if (p.manual && Array.isArray(p.acctModes) && p.acctModes.length) {
      const allowed = resellModesOf(key, env);
      const want = it && it.acct ? String(it.acct) : allowed[0];
      if (!allowed.includes(want)) return { error: `${p.label}目前不提供這種帳號方式，請重新整理購買頁` };
      if (want === 'byo' && p.byoGated && Number(it.qty) > 1) {
        return { error: '使用自己的 F1TV 帳號時，一次只能購買 1 個月（要更久請選擇一年方案）' };
      }
      acctMode = want;
    }

    let unit = planPrice(key, ops);          // 後台覆寫優先，沒設就用程式碼裡的牌價
    let note = '';
    if (p.untilSeasonEnd) {
      // 早鳥賣完不再自動改正式方案（2026-11-03）：planLock 已經擋下，回錯誤讓他自己選——
      //    默默換成 599 等於他看到 399 卻被收 599
      const k = key;
      const sp = seasonPriceNow(PLANS[k].price);
      unit = sp.price;
      note = sp.nextSeason ? `${sp.tier}（本賽季剩餘週末一併附贈）` : sp.tier;
      seasonKey = k;
    }
    if (p.nextSeasonOnly) {
      const st = planStart(key);
      lineFrom = st; lineUntil = planExpiry(key);
      note = st ? `${SEASON_YEAR} 賽季最後一站結束後生效（之後 ${SEASON_YEAR} 賽季的重播也看得到）` : '購買後立即生效';
    }
    // 折扣（限時活動／老客戶續訂）。早鳥不疊折扣（discountFor 自己會排除）
    const disc = discountFor(p.untilSeasonEnd ? seasonKey : key, unit, ops, !!o.renew);
    unit = disc.unit;
    // 共用帳號的代訂綁單一比賽週末，同樣要指定是哪一場——
    // 不指定的話，訂單進來時不知道要幫他開哪個週末的帳號，而那是人工作業，
    // 弄錯了就是整筆重來。
    if (p.svcWeekend) {
      const gid2 = String((it && it.gp) || '');
      const g2 = gid2 ? gpById(gid2) : null;
      if (!g2) return { error: (p.label || '此方案') + '必須指定場次（請重新整理購買頁）' };
      if (!gpSellable(g2)) return { error: gpUnsellableReason(g2) };
      lineGp = g2;
    }

    if (p.weekBound) {
      // ⚠️ **比賽週通行證一定要指定是哪一場。**
      //    商品是「荷蘭大獎賽通行證」，不是「一週」——沒有 gp 就不知道賣什麼。
      const gid = String((it && it.gp) || '');
      const g = gid ? gpById(gid) : null;
      if (!g) return { error: '比賽週通行證必須指定場次（請重新整理購買頁）' };
      // ⚠️ **這裡是唯一真正的防線。** 購買頁的「已結束／已停售」只是方便：
      //    HTML 會被瀏覽器快取，賽程也會在頁面開著的時候往前走——
      //    正賽跑完那一刻，某個人的分頁上那張卡片還是可以點的。
      if (!gpSellable(g)) return { error: gpUnsellableReason(g) };
      const w = gpWindow(g);
      if (!w) return { error: '找不到該場次的比賽週區間' };
      gpWindows.push([w.from, w.until, gpId(g)]);
      // 購物車要看得到這一張的效期。**時間一律回 UTC 秒**，
      //    由前端換成使用者的時區——伺服器猜不到他在哪裡。
      lineFrom = w.from; lineUntil = w.until;
      lineNext = w.next ? (w.next.label || (w.next.name + '大獎賽')) : null;
    }
    // 比賽週通行證的顯示名稱是**那一場的名字**，不是方案名稱
    const lineLabel = (p.weekBound && it && it.gp && gpById(String(it.gp)))
      ? (gpById(String(it.gp)).label || `${gpById(String(it.gp)).name}大獎賽`)
      : (lineGp ? (p.label + '　' + (lineGp.label || lineGp.name)) : p.label)
        + (acctMode === 'byo' && p.acctModes.length > 1 ? '（使用自己的 F1TV 帳號）' : '');
    lines.push({
      key, gp: (it && it.gp) ? String(it.gp) : null, acctMode,
      validFrom: lineFrom, validUntil: lineUntil, nextLabel: lineNext,
      label: lineLabel, qty, unit, sum: unit * qty, note,
      // 折扣的來源與原價。訂單照存，退款與升級折抵一律以實付（unit）計
      promo: disc.promo,
      vpn: !!p.vpn, manual: !!p.manual,
      // primary 的判斷要用得到它：全是代訂時，有沒有附贈一週決定發哪一種內部方案
      bundleWeek: p.bundleWeeks > 0,
    });
    total += unit * qty;

    // ---- 代訂附贈的比賽週通行證 ----
    //
    // ⚠️ **附贈的每一張都是購物車裡真正的一列，不是折抵。**
    //
    //    舊做法是「代訂 + 通行證」折 39 元。金額算得對，但買家必須自己
    //    回答「代訂送的那週去哪了」——因為它從頭到尾沒有出現在畫面上。
    //    **能用「看得到」解決的，不要用「說明得清楚」解決。**
    //
    // ⚠️ **場次一定要在伺服器這裡驗。** 前端送來的只是 gp 代號，
    //    張數上限、有沒有結束、有沒有跟付費那幾張撞號，全部在這裡把關。
    //    前端的「已附贈／不可選」只是方便，不是防線。
    if (p.bundleWeeks > 0) {
      // 賽季通行證已經涵蓋整季，附贈的週沒有任何內容可以給。
      // **但仍然要出現在購物車裡**——不然買家會以為附贈憑空消失了，
      // 而那正是舊折抵做法的毛病。
      if (hasSeason) {
        lines.push({
          key: 'week_svc', gp: null, gift: true, manual: true, parent: key,
          label: `比賽週通行證 ×${p.bundleWeeks * qty}`,
          qty: 1, unit: 0, sum: 0,
          note: '已包含於賽季通行證，無須指定場次',
        });
      } else {
        // 上限：每份 N 張 × 份數，但不能超過本賽季還沒開始的場次數
        const openGps = gpList().filter((g) => gpSellable(g));
        const allow = Math.min(p.bundleWeeks * qty, openGps.length);
        let want = Array.from(new Set(
          (Array.isArray(it && it.gifts) ? it.gifts : [])
            .map((x) => String(x || '')).filter(Boolean),
        ));
        // ⚠️ 沒指定就自動補**最近幾場尚未被佔用的**。
        //    這條路是給舊版購買頁（HTML 可能還在快取裡）與 body.plan 舊格式走的，
        //    直接回錯誤會讓那些人結不了帳，而他們什麼也沒做錯。
        if (!want.length) {
          want = openGps.map((g) => gpId(g))
            .filter((id) => !paidGps.has(id) && !giftGps.has(id))
            .slice(0, allow);
        }
        if (want.length > allow) {
          return { error: `${p.label} 附贈 ${allow} 張比賽週通行證，您指定了 ${want.length} 場。` };
        }
        if (want.length < allow) {
          return {
            error: `請指定 ${p.label} 附贈的 ${allow} 個比賽週場次`
              + `（目前只指定了 ${want.length} 個）。`,
          };
        }
        for (const gid of want) {
          const g = gpById(gid);
          if (!g) return { error: '附贈的比賽週場次不存在（請重新整理購買頁）' };
          const nm = g.label || `${g.name}大獎賽`;
          if (!gpSellable(g)) {
            return { error: (gpUnsellableReason(g) || `${nm}已經結束`) + '（無法指定為附贈場次）' };
          }
          if (giftGps.has(gpId(g))) {
            return { error: `${nm}重複指定為附贈場次——同一場只會開通一次。` };
          }
          if (paidGps.has(gpId(g))) {
            return {
              error: `${nm}已經在購物車中（付費購買）。附贈的場次請改選其他站——`
                + '同一場只會開通一次，重複指定不會延長任何效期。',
            };
          }
          giftGps.add(gpId(g));
          const gw = gpWindow(g);
          if (!gw) return { error: '找不到該場次的比賽週區間' };
          gpWindows.push([gw.from, gw.until, gpId(g)]);
          lines.push({
            key: 'week_svc', gp: gpId(g), gift: true, manual: true, parent: key,
            label: nm, qty: 1, unit: 0, sum: 0,
            validFrom: gw.from, validUntil: gw.until,
            nextLabel: gw.next ? (gw.next.label || (gw.next.name + '大獎賽')) : null,
            note: '代訂附贈',
          });
        }
      }
    }
  }

  const adjustments = [];

  // ⚠️ **這裡以前有一行「代訂已附贈一週，折抵 −39」。拿掉了，不要加回來。**
  //    附贈現在是上面那幾列 NT$0 的商品，買家看得到自己拿到哪幾站。
  //    再加一筆折抵就會變成折兩次。

  // ---- 升級補差價 ----
  let creditKeys = [];
  let creditNote = null;
  // ⚠️ **折抵不成立時一定要把原因交出去（creditNote）。**
  //    weekCreditFor 一直都算得出原因，購買頁也一直留著顯示它的位置，
  //    但這裡以前從來沒有設定 creditNote——輸錯授權碼、email 對不上、
  //    拿附贈的那張來折，畫面上都只是「金額沒變」，一個字都沒有（2026-09-17 端對端實測發現）。
  //    `check-credit` 第 5 項會擋。
  if (o.upgrade && !seasonKey) {
    creditNote = '升級折抵只適用於賽季通行證。請先把賽季通行證加入購物車。';
  } else if (o.upgrade && seasonKey && !(Array.isArray(o.acctEmails) && o.acctEmails.length)) {
    creditNote = CREDIT_REASON_TEXT.need_login;
  } else if (o.upgrade && seasonKey && o.email && !o.acctEmails.map((e) => accountKey(e)).includes(accountKey(o.email))) {
    // 新的賽季票會發到結帳信箱；它不在登入的帳號裡，就等於「用 A 帳號的折抵買給 B」——擋下並說明
    creditNote = CREDIT_REASON_TEXT.email_not_mine;
  } else if (o.upgrade && seasonKey) {
    // ⚠️ 信箱清單一定要來自**工作階段**（呼叫端的 accountEmailsOf），不可以是使用者填的
    const c = await weekCreditFor(env, o.acctEmails, Date.now());
    if (c.credit > 0) {
      const use = Math.min(c.credit, total);      // 不會變成負數
      adjustments.push({ label: `已購比賽週通行證折抵（本賽季 ${c.keys.length} 張）`, amount: -use });
      total -= use;
      creditKeys = c.keys;
    } else {
      creditNote = CREDIT_REASON_TEXT[c.reason] || CREDIT_REASON_TEXT.none;
    }
  }

  total = Math.max(0, Math.round(total));

  // ---- 這張訂單要發幾組授權碼（2026-10-30）----
  //
  // 一組授權碼只有一個效期。效期互不相干的東西放同一張單，就要各自成碼：
  //   本賽季（賽季票，或比賽週＋附贈的週）一組、下一賽季票一組。
  // ⚠️ 本賽季那一組一定排第一個——它是「主授權」：`order:<訂單>`、訂單記錄的 licenseKey、
  //    付款完成頁、補寄信、退款都先認它。多出來的那組記在 extra（訂單的 extraLicenses）。
  // ⚠️ 同一組裡**不可以**混兩種效期：比賽週的區間一旦掛到賽季票上，整張被截成一週（上面擋掉的那種）。
  const isNext = (l) => !!(PLANS[l.key] && PLANS[l.key].nextSeasonOnly);
  const nextLine = lines.find((l) => !l.manual && isNext(l));
  const curKey = (lines.find((l) => !l.manual && !isNext(l)) || {}).key
    || (lines.some((l) => l.bundleWeek) ? 'week_svc' : null);
  // 主方案：發碼與統計要有一個代表。只有下一季票時就是它；全是代訂時見下面 primary 的註解
  const primaryKey = curKey || (nextLine ? nextLine.key : 'svc_none');
  const primaryIsWeek = !!(PLANS[primaryKey] && PLANS[primaryKey].weekBound);
  // 下一季票自己那一組：付的錢就是那一列（折抵只給賽季票，不會落在它身上）
  const extra = (nextLine && curKey) ? [{ plan: nextLine.key, paid: nextLine.sum }] : [];

  // ⚠️ **通行證實際付了多少，要跟整張訂單的金額分開記。**
  //
  //    授權記錄的 paid 原本存的是**整張訂單的總價**，於是
  //    「代訂 1 年（4,599）+ 一張通行證（被折成 0 元）」發出的通行證
  //    會帶著 paid = 4599——日後升級賽季票時，一張免費拿到的通行證
  //    換到滿額折抵。實測確認過。
  //
  //    這裡只算 weekBound 那幾行。**附贈的那幾列 sum 是 0**，
  //    所以自動不計入——這是把附贈做成商品列（而不是折抵）的附帶好處：
  //    不必再去追「哪一筆折抵折的是通行證」。
  const weekLines = lines.filter((l) => PLANS[l.key] && PLANS[l.key].weekBound);
  const weekPaid = Math.max(0, weekLines.reduce((n, l) => n + l.sum, 0));
  return {
    lines,
    adjustments,
    total,
    creditKeys,
    // 通行證那幾行實際付了多少。**升級折抵只能用這個數字**，不能用訂單總價。
    weekPaid,
    // 買到的比賽週區間。發碼時直接寫進授權記錄，續期時用它判斷「現在能不能用」。
    //
    // ⚠️ **只有主方案是比賽週通行證時才帶區間。**
    //    上面已經擋掉「賽季票 + 通行證」了，這裡是第二道：
    //    區間一旦掛到賽季票上，那張票會被截成一週，而且完全不報錯。
    //    要壞就壞在安全的那一邊——寧可少一段區間（使用者仍有完整效期），
    //    也不要多一段（把長效期截短）。
    windows: primaryIsWeek ? mergeWindows(gpWindows.map((w) => [w[0], w[1]])) : [],
    gpIds: primaryIsWeek ? gpWindows.map((w) => w[2]) : [],
    // ⚠️ **哪幾站是附贈的，一定要記下來——即使現在沒有人讀它。**
    //
    //    現在附贈與自費的區間被合併成同一張授權，兩者長得一模一樣。
    //    日後若要讓「附贈的通行證可以送人」（＝發成獨立的授權碼），
    //    就必須知道哪幾站原本是附贈的——而**那個資訊只有結帳當下有**。
    //    沒記下來的話，這段期間的訂單就永遠拆不出來了，
    //    屆時只能對舊訂單特殊處理，那才是真正的痛。
    //
    //    記一個欄位是零成本（同一次 KV 寫入），漏記是不可逆的。
    giftGpIds: primaryIsWeek ? Array.from(giftGps) : [],
    // 主方案：發碼與統計要有一個代表。
    //
    // ⚠️ **購物車全是代訂時，絕對不可以拿代訂方案當主方案。**
    //    代訂方案沒有期限欄位，planExpiry 會回 null＝無期限，
    //    等於送出一張永不過期的字幕授權（實際存在過的漏洞）。
    //    全是代訂時改發內部方案：有附贈一週的發 week_svc，
    //    沒有的發 svc_none（立刻到期，只用來讓後台追得到這張訂單）。
    primary: primaryKey,
    // 主授權以外要另外發的授權碼（目前只有「下一賽季票＋本賽季的東西」會有，見上面）
    extra,
    // 主授權的 paid 要扣掉另一組的錢，否則兩組授權各記一次下一季票的價格
    primaryPaid: extra.length ? Math.max(0, total - extra.reduce((n, x) => n + x.paid, 0)) : null,
    // 差額低到不值得走金流時直接送（見 UPGRADE_FREE_BELOW）
    creditNote,
    freeUpgrade: !!(o.upgrade && total > 0 && total < UPGRADE_FREE_BELOW),
    needsVpn: lines.some((l) => l.vpn),
    hasManual: lines.some((l) => l.manual),
  };
}

/**
 * 小額訂單只開信用卡（2026-10-26 Ray：「49和79只開信用卡」→ 10-27 改「130以下都只能用信用卡」，
 * 涵蓋兩張週通行證 98、週通行證＋週末代訂 128）。
 *
 * 綠界官網服務費率表（一般賣家、未稅，另加 5% 營業稅）：信用卡 2.75%、每筆最低 5 元＋處理費 1 元；
 * ATM 1% 最低 15 元；超商條碼 16 元；超商代碼 31 元。49 元那一筆刷卡實付 6.0（最低 5 元已含稅，2026-11-03 綠界實扣），
 * 走超商代碼約 32.6——手續費吃掉三分之二。門檻用**訂單總額**，不看商品：
 * 折扣、購物車組合都會改金額，手續費只跟金額有關。
 * 大於門檻的照舊用後台設定（`ops.choosePayment`，預設 ALL）。
 */
const CREDIT_ONLY_MAX = 130;
function choosePaymentFor(price, ops) {
  if (Number(price) <= CREDIT_ONLY_MAX) return 'Credit';
  return (ops && ops.choosePayment) || 'ALL';
}

async function handleCheckout(request, env, url) {
  const ops = await opsConfig(env);
  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');

  // ⚠️ 法定要件：七天鑑賞期的排除需要「經消費者事先同意」。
  //    沒有這個勾選，排除條款在法律上不成立，使用者仍可主張無條件退貨。
  if (!body.agreed) return err('請先閱讀並同意使用條款與隱私權政策');

  // ⚠️ 與登入用**同一個**格式檢查（2026-10-04 改）。授權碼現在一定要登入購買信箱的帳號
  //    才能用；結帳收了一個登入不收的信箱（例如含引號或非 ASCII 字元），付了錢的人就
  //    永遠登不進去、永遠用不了。以前結帳是寬鬆的正則、登入是嚴格的白名單。
  const email = accountKey(body.email);
  if (!looksLikeEmail(email)) {
    return err('請填寫正確的 email（英數字與 . _ % + -）—— 授權碼會綁在這個信箱的帳號上，使用時要用它登入');
  }

  // 舊的單品格式（`plan`）與新的購物車格式（`items`）都要收。
  // 購買頁改版是漸進的，中間一定有兩種格式並存的時間。
  const raw = Array.isArray(body.items) && body.items.length
    ? body.items
    : (body.plan ? [{ key: body.plan, qty: 1 }] : []);
  if (!raw.length) return err('購物車是空的');
  if (raw.length > 10) return err('一次最多 10 個項目');

  const renew = await renewFor(env, request, email);
  const acctEmails = body.upgrade ? await accountEmailsOf(env, request) : null;
  const quote = await quoteCart(env, raw, { email, upgrade: !!body.upgrade, acctEmails, renew });
  if (quote.error) return err(quote.error);
  const price = quote.total;
  const finalPlan = quote.primary;
  // ⚠️ **小額差額不可以送進綠界。**
  //    綠界超商代收一筆固定 25 元、ATM 10~15 元，收 20 元的淨得是負的。
  //    但更重要的是：購買頁對這種情況顯示的是「將直接為您升級，不另行收費」，
  //    若這裡照樣收款，**畫面上的承諾就成了謊話**。
  //    目前沒有自動發碼的免費升級流程（那是一條不經付款就發出授權的路，
  //    要另外設計防濫用），所以這裡誠實擋下並導向客服。
  //    以現行定價（折抵上限 49、賽季票 299/599）這條路實際上碰不到，
  //    留著是為了日後改價時不會靜默地開始收負毛利的錢。
  if (price < UPGRADE_FREE_BELOW) {
    return err(`本次應付金額僅 NT$${price}，低於金流最低收款金額。`
      + '請來信 pitlingo.office@gmail.com 並附上您的授權碼，我們會直接為您升級。', 400, 'E14');
  }

  // ⚠️ 測試收銀台預設不開放（見 stageAllowed）。不要改成「靜默改走正式」——
  //    送 mode: stage 的只會是測試工具或攻擊者，兩者都該收到明確的拒絕。
  if (body.mode === 'stage' && !stageAllowed(env)) return err('測試模式未開放', 403);
  const conf = ecpayConf(env, body.mode === 'stage' ? 'stage' : 'production');
  if (!conf.merchantId || !conf.hashKey || !conf.hashIV) {
    return err('金流尚未設定完成，請稍後再試或聯絡客服', 503);
  }

  const no = tradeNo();

  // 共用帳號的名額（RESELL-OPS 第 4 節）。席次上限打開時，結帳當下就保留一席；
  // 名額滿了就在這裡擋下，不要讓人付了錢才發現沒有位子。
  // ⚠️ 資料庫查不到時**擋下**（不知道還有沒有位子，就不能收錢）——上限沒打開時不會走到查詢。
  // 早鳥：結帳當下保留一席（AuthGuard，每帳號一席、EARLY_HOLD_SEC 後自動放掉）。保留不到就不讓他付錢
  const hasEarly = quote.lines.some((l) => PLANS[l.key] && PLANS[l.key].earlyBird);
  if (hasEarly) {
    const h = await earlyHold(env, no, email);
    if (!h.ok) {
      return err(h.reason === 'dup' ? `每個帳號限購 1 份早鳥，這個帳號已經買過了`
        : h.reason === 'full' ? `早鳥 ${EARLY_LIMIT} 組已售完或都在結帳中，請稍後再試`
          : '暫時無法確認早鳥剩餘名額，請稍後再試', h.reason === 'down' ? 503 : 409);
    }
  }
  for (const l of quote.lines) {
    if (!l.gp || !PLANS[l.key] || !PLANS[l.key].svcWeekend) continue;
    let h;
    try { h = await resellHoldShared(env, no, l.gp); } catch (e) { h = { ok: false, error: true }; }
    if (!h.ok) {
      return err(h.error
        ? '暫時無法確認共用帳號的名額，請稍後再試'
        : '這個比賽週末的共用帳號名額已滿。可以改選一個月的代訂方案，或聯絡客服', 409);
    }
  }
  const site = env.SITE_URL || 'https://pitlingo.com';
  const api = env.API_URL || 'https://api.pitlingo.com';

  // 官方規格的硬性限制，違反了綠界會直接拒絕而且錯誤訊息很難懂：
  //   ReturnURL 必須 HTTPS（443）、不可指定埠號、不可含中文
  //   ReturnURL 與 OrderResultURL 不可相同
  if (!/^https:\/\/[^:/]+(\/|$)/.test(api) || !/^https:\/\/[^:/]+(\/|$)/.test(site)) {
    return err('伺服器設定不正確（回呼網址必須是 https 且不可指定埠號）', 500);
  }

  const params = {
    MerchantID: conf.merchantId,
    MerchantTradeNo: no,
    MerchantTradeDate: tradeDate(),
    PaymentType: 'aio',
    TotalAmount: String(price),
    // 官方規格：TradeDesc String(200)「不可有特殊字元」。用純英數與空格最保險。
    TradeDesc: 'PitLingo subtitle service',
    // ⚠️ ItemName 用 # 分隔多項商品，所以商品名稱本身**絕對不能含 #**。
    //    我們只有一項，但方案名稱是外部可改的，先過濾掉。
    // 多項商品用 # 分隔（綠界規格）。名稱本身絕不能含 #，所以先濾掉。
    // 折抵不列成項目——綠界沒有負數金額的概念，`TotalAmount` 已經是折抵後的數字，
    // 折抵明細記在我們自己的訂單裡（`pending`），出問題時對得回來。
    ItemName: quote.lines
      .map((l) => `PitLingo ${l.label}${l.qty > 1 ? ` x${l.qty}` : ''}`.replace(/#/g, ' '))
      .join('#').slice(0, 400),
    ReturnURL: `${api}/v1/payment/webhook`,
    // ⚠️ **不要同時設 ClientBackURL 與 OrderResultURL。**
    //    官方文件：兩者都設時 OrderResultURL 優先，ClientBackURL 會失效——
    //    留著只會讓人以為它有作用。我們要的是「付款後導回並顯示授權碼」，
    //    所以只留 OrderResultURL。
    //    另外它與 ReturnURL **不可相同**，否則綠界的判斷會錯亂。
    // ⚠️ **綠界是用 POST 導回來的，而 `/paid` 是 Cloudflare Pages 的靜態頁。**
    //    靜態頁拿不到 POST body，於是頁面上什麼訂單資訊都沒有——
    //    實測就是這個症狀：付款成功卻看不到授權碼。
    //    改成先導到 Worker，由它接住 POST、驗簽，再 302 帶著訂單編號轉到 /paid。
    OrderResultURL: `${api}/v1/payment/result`,
    // ATM／超商取號時的通知。**與 ReturnURL 分開**，因為取號不等於付款。
    PaymentInfoURL: `${api}/v1/payment/info`,
    // ⚠️ **綠界錯誤 10300023「本次交易未提供任何付款方式」就是這一行造成的。**
    //
    //    "ALL" 的語意是「顯示商店已開通的全部方式」，但若商店在綠界後台
    //    **一項都還沒開通**（或該筆金額不在任何一種方式的可用區間內），
    //    過濾之後就一種都不剩，綠界直接回這個錯誤。
    //    常見於測試帳號轉正式帳號、審核尚未完成時。
    //
    //    改成可由後台設定（ops:config 的 choosePayment），用途有二：
    //      1. 商店只開通信用卡時填 "Credit"，就不會被 ALL 過濾成空
    //      2. 想暫時只收某一種方式時不必改程式碼重新部署
    // 早鳥只收信用卡（2026-11-03）：名額只保留 EARLY_HOLD_SEC；ATM／超商要好幾天才付款，保留不了那麼久
    ChoosePayment: hasEarly ? 'Credit' : choosePaymentFor(price, ops),
    EncryptType: '1',
    CustomerEmail: email,
    NeedExtraPaidInfo: 'N',
  };
  params.CheckMacValue = await ecpayMac(params, conf.hashKey, conf.hashIV);

  // 先把訂單記下來。webhook 回來時要靠它知道「這筆是什麼方案、寄給誰」——
  // 綠界的通知不會帶我們自己的欄位。
  await env.SUBS.put(`pending:${no}`, JSON.stringify({
    plan: finalPlan, price, email, at: nowSec(), mode: conf.mode,
    // 購物車全貌要留著：webhook 回來時要知道發哪些碼、哪些是待人工處理的代訂，
    // 以及哪幾張比賽週通行證已經被拿去抵扣了（不標記的話明年還能再抵一次）。
    items: quote.lines.map((l) => ({ key: l.key, gp: l.gp || null, qty: l.qty, unit: l.unit, acct: l.acctMode || null, ...(l.promo ? { promo: l.promo } : {}) })),
    // ⚠️ **區間在結帳當下就算好存起來。** 付款可能是幾小時甚至幾天後
    //    （ATM／超商代碼最長 30 天），webhook 再重算會用當時的「現在」當基準，
    //    發出去的效期就與購買頁顯示的不一樣——而使用者手上有截圖。
    windows: quote.windows || [],
    gpIds: quote.gpIds || [],
    // 附贈的那幾站（見 quoteCart 的 giftGpIds）。目前沒有人讀，日後拆碼要用
    giftGpIds: quote.giftGpIds || [],
    adjustments: quote.adjustments,
    creditKeys: quote.creditKeys,
    manual: quote.hasManual,
    // 折抵只認這個數字，不認訂單總價（見 quoteCart 的 weekPaid）
    weekPaid: quote.weekPaid,
    // 主授權以外要另外發的授權碼（見 quoteCart 的 extra）。**結帳當下就定好**，webhook 不重算
    extra: quote.extra || [],
    primaryPaid: quote.primaryPaid,
  }), { expirationTtl: 30 * 86400 });          // 超商代碼最長可繳 30 天

  // 訂單記錄。**與 pending 是兩回事**：pending 只是 webhook 要用的暫存，
  // 發完碼就刪掉；訂單記錄要留到明年，後台才看得到「有人結帳但沒付成功」。
  // 沒有這一份的話，付款失敗在系統裡完全不留痕跡（實際踩過）。
  await patchOrder(env, no, {
    no, at: nowSec(), status: 'created',
    price, email, plan: finalPlan, mode: conf.mode,
    summary: quote.lines.map((l) => `${l.label}${l.qty > 1 ? ' x' + l.qty : ''}`).join('、'),
    items: quote.lines.map((l) => ({ key: l.key, label: l.label, qty: l.qty, unit: l.unit })),
    adjustments: quote.adjustments,
    // ⚠️ 要排除附贈列（gift）。附贈列也帶 manual: true，那是為了讓主方案判斷跳過它，
    //    不代表它是一件要人工處理的事——不排除的話後台與付款完成頁都會把附贈的那一站列成代訂。
    services: quote.lines.filter((l) => l.manual && !l.gift)
      .map((l) => ({ key: l.key, label: l.label, qty: l.qty, status: 'pending', gp: l.gp || null, acctMode: l.acctMode || null })),
    mailed: false,
  });

  return json({ ok: true, action: conf.url, params, orderId: no, plan: finalPlan, price, mode: conf.mode });
}

/**
 * ATM／超商「取號成功」的通知。
 * **這裡絕對不能發碼**——取號只代表拿到繳費代碼，錢還沒進來。
 * 存起來只是為了讓使用者在 /paid 頁面看得到繳費資訊。
 */
async function handlePaymentInfo(request, env) {
  const ct = request.headers.get('content-type') || '';
  let p = {};
  if (ct.includes('json')) p = await request.json().catch(() => ({}));
  else {
    const form = await request.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) p[k] = String(v);
  }
  const no = String(p.MerchantTradeNo || '').trim();
  if (!no) return new Response('0|no order id', { status: 400 });

  if (!(await ecpayMacOk(env, p, await readPending(env, no)))) return new Response('0|bad mac', { status: 401 });

  await env.SUBS.put(`payinfo:${no}`, JSON.stringify({
    bank: p.BankCode || '', vAccount: p.vAccount || '',
    payNo: p.PaymentNo || '', expire: p.ExpireDate || '',
    at: nowSec(),
  }), { expirationTtl: 30 * 86400 });

  // 後台要分得出「還沒去繳」與「付款失敗」——ATM／超商取號的人常常隔天才繳，
  // 把它們混在 created 裡會讓人以為訂單流失了。
  await patchOrder(env, no, { status: 'awaiting' });

  // 取號代表他打算付錢（ATM／超商常常隔天才繳）。共用帳號保留的名額延長到 3 天，
  // 否則 2 小時後名額被別人買走，他繳完錢卻沒有位子。
  try {
    const db = resellDb(env);
    if (db) await db.prepare('UPDATE f1_holds SET expires_at = max(expires_at, ?) WHERE order_no = ?').bind(nowSec() + 3 * 86400, no).run();
  } catch (e) { /* 名額延長失敗不影響取號 */ }

  return new Response('1|OK');
}

/** 讓 /paid 頁面查自己那筆訂單的狀態。只回「這筆訂單」的資訊，不列舉。 */
async function handleOrderStatus(env, url) {
  const no = String(url.searchParams.get('no') || '').trim();
  if (!/^PL[A-Z0-9]{5,24}$/.test(no)) return err('訂單編號格式不正確');

  const licKeyRaw = await env.SUBS.get(`order:${no}`);
  if (licKeyRaw) {
    // 不含字幕授權的訂單沒有授權碼（見 webhook 的 noLicense）。
    // 要明講「這筆訂單不需要授權碼」，不要留一個空白讓人以為出錯了。
    // ⚠️ **同一張訂單裡的代訂也要回報。** 以前只回授權碼，於是「通行證 + 代訂 1 個月」
    //    付款完成頁只秀授權碼，對代訂一個字都沒提——付了幾百元的人看不到
    //    「我們會在三個工作日內處理」（2026-09-17 端對端實測發現）。
    //    只回名稱與數量，不回 email 或任何個資：訂單編號本身不是登入憑證。
    const ord = await readOrder(env, no);
    const services = (ord && Array.isArray(ord.services) ? ord.services : [])
      .map((s) => ({ label: String(s.label || ''), qty: Number(s.qty) || 1 }));
    if (licKeyRaw === 'nolicense') return json({ status: 'paid', noLicense: true, services });
    // ⚠️ **一律不回授權碼**（2026-10-30 起；以前是付款後 24 小時內回完整的、之後遮罩）。
    //    這支端點沒有任何登入，只要訂單編號——而訂單編號印在收據、信件、「我的帳號」上，也會被截圖。
    //    授權以帳號為準之後付款完成頁也不需要它：只回「買了什麼、何時生效、到什麼時候」。
    const brief = (lic, plan) => ({
      planLabel: (PLANS[(lic && lic.plan) || plan || ''] || {}).label || '',
      gpName: (lic && lic.gpName) || null,
      startsAt: (lic && lic.startsAt) || null,
      expiresAt: (lic && lic.expiresAt) || null,
    });
    const main = brief(await readLicense(env, licKeyRaw));
    // 同一張訂單的第二份授權（下一賽季票，見 quoteCart 的 extra）
    const extra = [];
    for (const x of (ord && Array.isArray(ord.extraLicenses) ? ord.extraLicenses : [])) {
      const raw = normLicense(x && x.licenseKey);
      if (!raw) continue;
      extra.push(brief(await readLicense(env, raw), x.plan));
    }
    return json({ status: 'paid', ...main, services, ...(extra.length ? { extra } : {}) });
  }
  const info = await env.SUBS.get(`payinfo:${no}`);
  if (info) return json({ status: 'awaiting_payment', payment: JSON.parse(info) });

  const pend = await env.SUBS.get(`pending:${no}`);
  if (pend) return json({ status: 'pending' });
  return json({ status: 'unknown' }, 404);
}

