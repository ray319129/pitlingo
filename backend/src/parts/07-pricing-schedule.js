// ---------------------------------------------------------------------------
// 定價（2026-08-17 第二次定案，使用者決定）
//
// **只有三個價格。** 上一版是四段的階梯（599／399／259／129），
// 雖然每一段都算得出道理，但使用者的判斷是：**選項太多會讓人猶豫**，
// 而猶豫的結果不是選便宜的那個，是不買。這個判斷我同意——
// 定價的正確性不只看每一段划不划算，也看使用者能不能一眼看懂。
//
//   夏休前（上半季）  NT$599
//   夏休起（下半季）  NT$299
//   單場比賽週末      NT$39
//
// 分界用 **F1 的夏休**，不用月份也不用剩餘場次：那是每個看 F1 的人
// 本來就知道的界線，不需要解釋。「夏休前加入 599／夏休後加入 299」
// 一句話講得完，而「剩 15 個週末以上 599」要先問「那現在剩幾個」。
// ---------------------------------------------------------------------------
// PRICE_FIRST_HALF / PRICE_SECOND_HALF 已移到 PLANS 之前宣告（TDZ，見那裡的說明）

/**
 * 低於這個數量就不再賣「本賽季」，改賣**下一個賽季**。
 *
 * 使用者的決定（2026-08-17）：不停售，但要賣得誠實——賣的是下賽季的，
 * 而且**購買頁與結帳都必須明講**。本賽季剩下的週末一併附贈：
 * 共用快取讓它幾乎零成本，而「現在就能開始用」比任何折扣都好溝通。
 *
 * ⚠️ 門檻是 **8**，是算出來的：下半季價 299 ÷ 39（單場）≈ 7.7，
 *    也就是剩不到 8 個週末時，整季票會比一場一場買**還貴**——
 *    那是使用者自己算得出來的事，不能讓它發生。
 *    到那個時候就該改賣下一賽季（本季剩下的附贈），對雙方都比較好。
 */
const NEXT_SEASON_MIN_WEEKENDS = 8;

// ---------------------------------------------------------------------------
// 賽程查詢
//
// 資料在 REMOTE_CONFIG.schedule（放遠端才能熱更新，見那裡的說明）。
// 這些函式刻意**全部容忍賽程是空的或壞的**：賽程只是讓定價與 Weekend Pass
// 更精準的輔助資料，拿不到時要能退回「不看賽程」的舊行為，
// 而不是讓整個購買流程掛掉。
// ---------------------------------------------------------------------------

/** 一天的秒數界線。用 UTC 是刻意的，見 schedule 的註解。 */
function dayStartSec(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
}

/**
 * KV 裡的賽程快取。
 *
 * ⚠️ **`scheduleList()` 是同步的，而 KV 是非同步的。**
 *    所有算效期的地方（gpWindow、planExpiry…）都是同步函式，
 *    要它們每次去 await 一次 KV 是不可能的，也不該——那是每個請求一次額外讀取。
 *    所以在請求最前面 await 一次載進這個快取，之後同步讀。
 *
 * ⚠️ 快取沒有載到時**退回內建賽程**，不是回空陣列。
 *    回空會讓所有效期算成 null、所有商品消失，而那不會報錯（坑 #23）。
 */
let schedCache = { at: 0, races: null };

async function loadSchedule(env) {
  try { await loadF1tvSched(env); } catch (e) { /* 用推算的節目時間 */ }
  if (schedCache.races && Date.now() - schedCache.at < 60000) return;
  try {
    const raw = JSON.parse((await env.SUBS.get(SCHED_KEY)) || 'null');
    if (raw && Array.isArray(raw.races) && validateSchedule(raw.races).ok) {
      schedCache = { at: Date.now(), races: raw.races };
      return;
    }
  } catch (e) { /* 用內建的 */ }
  schedCache = { at: Date.now(), races: null };
}

function scheduleList(cfg) {
  // 同步的來源順序：呼叫端指定的 cfg → KV 同步來的 → 內建的退路
  const list = (cfg && Array.isArray(cfg.schedule)) ? cfg.schedule
    : (schedCache.races || REMOTE_CONFIG.schedule);
  return Array.isArray(list) ? list.filter((g) => g && dayStartSec(g.start) && dayStartSec(g.end)) : [];
}

/**
 * 還剩幾個比賽週末。**待決場次也算進去。**
 *
 * ⚠️ 這個判斷在 2026-08-17 改過方向。原本刻意排除待決場次（「寧可低估」），
 *    使用者的決定是**不要低估**：那兩場是 F1 官方排定的賽程，取消與否
 *    是他們的決定，不是我們的。事先自己打折扣等於替別人的不確定性買單，
 *    而真的取消時該處理的是退費或補償，不是預先少賣。
 *
 *    影響：以 2026-08-17 為例，剩餘從 10 變成 12。
 */
function racesLeft(from, cfg) {
  const now = Math.floor((from || Date.now()) / 1000);
  // 季前測試（testing: true）不是比賽週末：不算進「還剩幾站」，也不影響季票的分段價與停賣
  return scheduleList(cfg).filter((g) => !g.testing && dayStartSec(g.end) + 86400 > now).length;
}

/**
 * 現在是不是休賽期：本賽季最後一站已經跑完（racesLeft 為 0，含賽程是空的），
 * 或賽程上的第一項還沒開始（換季之後、開幕之前）。重播月票只在這段期間販售。
 * ⚠️ 賽程上的第一項是**季前測試**（2027 起放進賽程，testing: true）：休賽期在測試的比賽週開始時就結束
 *    （2026-10-30 Ray：「不能看到季前測試的直播，季前測試要像正賽一樣賣」）。
 */
function inOffSeason(from, cfg) {
  // 與下一賽季票生效、本賽季票停賣同一個時刻（最後一站正賽結束後），不是隔天
  if (seasonOver(from, cfg)) return true;
  const list = gpList(cfg);
  const w = list.length ? gpWindow(list[0], cfg) : null;
  return !!(w && Math.floor((from || Date.now()) / 1000) < w.from);
}

/** 下一個還沒開始的比賽週從什麼時候開始（秒）。賽程上沒有就回 null。 */
function nextGpStartSec(from, cfg) {
  const now = Math.floor((from || Date.now()) / 1000);
  for (const g of gpList(cfg)) {
    const w = gpWindow(g, cfg);
    if (w && w.from > now) return w.from;
  }
  return null;
}

/** 其中有幾個是待確認的。購買頁要標示出來，讓使用者自己知道。 */
function racesLeftTentative(from, cfg) {
  const now = Math.floor((from || Date.now()) / 1000);
  return scheduleList(cfg).filter((g) => !g.testing && g.tentative && dayStartSec(g.end) + 86400 > now).length;
}

/**
 * 下一場（或正在進行中的那一場）比賽週末。
 *
 * Weekend Pass 賣的是「某一場 GP 的週末」，不是「發碼後 4 天」。
 * 舊的做法在使用者提前一週購買時會**在比賽開始前就過期**——
 * 付了錢卻什麼都看不到，而且不會有任何錯誤訊息。
 *
 * 前後各放寬一天：涵蓋各站的當地時區，也涵蓋賽前的媒體日內容。
 */
const WEEKEND_PAD_SEC = 86400;

function nextGrandPrix(from, cfg) {
  const now = Math.floor((from || Date.now()) / 1000);
  const list = scheduleList(cfg).slice().sort((a, b) => dayStartSec(a.start) - dayStartSec(b.start));
  // 先找「現在正在進行中」的，再找「接下來最近的一場」
  return list.find((g) => dayStartSec(g.end) + WEEKEND_PAD_SEC > now) || null;
}

/** 現在買 season 要多少錢。回傳 { price, tier }。 */
/**
 * 現在買 Season Pass 是什麼價、買到的是哪一季。
 *
 * 回傳 `{ price, tier, weekendsLeft, nextSeason, until }`。
 * `nextSeason: true` 代表**賣的是下一個賽季**——呼叫端一律要把這件事顯示出來，
 * 靜靜地收全價然後給一個要等好幾個月才用得到的東西，是最糟的那種體驗。
 *
 * `base` 只在賽程讀不到時當作退路，正常情況價格完全由價目表決定。
 */
/** 夏休已經開始了嗎（含夏休期間本身）。標記見 schedule 的 `afterSummerBreak`。 */
function afterSummerBreak(from, cfg) {
  const list = scheduleList(cfg);
  const first = list.find((g) => g.afterSummerBreak);
  if (!first) return false;                       // 沒標就一律當上半季，寧可收全價
  const prev = list.filter((g) => dayStartSec(g.end) < dayStartSec(first.start)).pop();
  // 界線取「夏休前最後一場結束的隔天」。夏休期間買到的就是下半季價——
  // 那段時間本來就沒有比賽，使用者買的是接下來的下半季。
  const boundary = prev ? dayStartSec(prev.end) + 86400 : dayStartSec(first.start);
  return Math.floor((from || Date.now()) / 1000) >= boundary;
}

function seasonPriceNow(base, from, cfg) {
  const now = from || Date.now();
  const left = racesLeft(now, cfg);

  // 賽程拿不到（設定壞掉、還沒推新賽季）就回上半季牌價。
  // 寧可收全價也不要因為讀不到資料就亂打折——那種錯誤沒有人會來反映。
  if (!scheduleList(cfg).length) {
    return {
      price: base || PRICE_FIRST_HALF, tier: '上半季',
      weekendsLeft: null, nextSeason: false, until: seasonEndSec(now),
    };
  }

  // ⚠️ **本賽季通行證永遠只賣本賽季。**
  //
  //    舊版在剩不到 8 個比賽週末時，把這張票整個換成「下一賽季」並收 599。
  //    使用者的決定（2026-08-19）是不要那樣做：剩幾場、值不值得，讓他自己判斷，
  //    我們不替他決定「這時候買本季不划算」。想買下一季的人去買 season_next。
  //
  //    這也移除了一個很難解釋的現象——同一張卡片會在某一天突然從 299 變成 599，
  //    而那其實是換了商品，不是漲價。
  let second = afterSummerBreak(now, cfg);

  // ⚠️ **絕對底線：整季票不可以比「單場 × 剩餘週末」還貴。**
  //
  // 只有兩個整季價，就代表上半季那個價要涵蓋很長一段時間。2026 的賽季被
  // 戰事削短之後，夏休前的最後幾週只剩 11 個週末——這時 599 元的整季票
  // 比買 11 張單場票（429 元）貴了 40%。使用者按計算機就會發現，
  // 而發現之後失去的不只是這一單。
  //
  // 這裡不引入第三個價格（那正是使用者要避免的複雜度），而是**提早套用
  // 下半季價**。價格種類仍然只有兩個，故事也還說得通：
  // 「夏休後 299；本季所剩不多時提早適用」。
  // 之所以一定接得住，是因為 NEXT_SEASON_MIN_WEEKENDS = 8 保證了
  // 剩餘至少 8 個週末，而 299 < 49 × 8 = 392。
  // （單場價由 39 調到 49 之後餘裕更大，但這條保證的成立條件沒有變：
  //   PRICE_SECOND_HALF < WEEKEND_PRICE × NEXT_SEASON_MIN_WEEKENDS。
  //   check-backend 會驗，不要靠記憶。）
  if (!second && PRICE_FIRST_HALF > WEEKEND_PRICE * left) second = true;

  return {
    price: second ? PRICE_SECOND_HALF : PRICE_FIRST_HALF,
    tier: second ? '下半季' : '上半季',
    weekendsLeft: left,
    nextSeason: false,
    until: seasonEndSec(now),
  };
}

/**
 * 升級補差價：Season 價 − 這個 email 本賽季已付的比賽週通行證金額。
 *
 * 規則一句話講得完，但實作有六個一定要釘死的點（全部踩過或想過）：
 *
 *   1. **綁 email**：授權本來就是綁人不綁裝置，email 是唯一的自然鍵。
 *      不同 email 買的不能互相抵——那是界線，不是限制。
 *   2. **只算本賽季**：用 `expiresAt` 落在同一個賽季界線內來判斷。
 *   3. **用升級當下的 Season 價**：不是購買時的。
 *   4. **抵扣無上限**（使用者決定）：買滿就免費升級。實質效果是
 *      「買散的最多跟買整季一樣貴」，對最忠實的使用者不做懲罰。
 *   5. **已抵扣過的不能再抵**：`creditedAt` 標記，否則明年還能再用一次。
 *   6. **差額 < 30 元直接送**：綠界超商代收一筆 25 元、ATM 10~15 元，
 *      收 20 元淨得可能是負的。而且 `TotalAmount` 不能是 0。
 */
const UPGRADE_FREE_BELOW = 30;

/**
 * 升級折抵的上限。
 *
 * 使用者的決定（2026-09-16）：**最多折一站**，也就是剛好一張單場的牌價。
 *
 * 沿革：2026-08-19 定為「最多折兩站」（單場 39 → 78 取整成 80），
 * 單場調到 49 之後一度變成 100，同日改為**只折一站**。
 *
 * 為什麼要有上限——原本是「全額折抵，買滿就免費升級」，那在
 * 通行證可以一次買多站之後會出事：一個人買 12 站（NT$588）再升級賽季票，
 * 折抵金額超過賽季票本身，等於免費拿到賽季票還倒賺。
 *
 * 為什麼改成一站：**「折你買的那一張」是一句不需要解釋的話。**
 * 兩站要先讓人相信「我買了三張，為什麼只折兩張」，而那個為什麼
 * 講完了還是會覺得吃虧。一站則對應一個很自然的情境——
 * 「先買一場試試看，喜歡就升級整季」，那一場的錢原樣退回去。
 *
 * ⚠️ **直接等於 `WEEKEND_PRICE`，不要寫成另一個數字。**
 *    寫死的話單場價一改就變成「說好折一站卻折不滿」，而那不會報錯。
 *
 * ⚠️ 這個數字改動時要同時改 legal/terms.html 的折抵條款，
 *    check-legal.js 會比對兩邊。
 */
const UPGRADE_CREDIT_MAX = WEEKEND_PRICE;

/**
 * 折抵不成立的原因 → 給買家看的話。鍵是 weekCreditFor 回傳的 reason。
 * ⚠️ 新增 reason 時要在這裡補一句，沒有對應的會落到 `none`（仍然有說明，但不精確）。
 */
const CREDIT_REASON_TEXT = {
  need_login: '升級折抵要先登入——我們會用帳號裡的比賽週通行證折抵。請到「我的帳號」登入後再回來結帳。',
  email_not_mine: '升級折抵時請用登入帳號的信箱結帳（新的賽季通行證要放進同一個帳號）。',
  none: '這個帳號本賽季沒有可折抵的比賽週通行證（可能已經折抵過、不是本賽季購買的，或是代訂附贈的）。',
};

/**
 * 升級折抵：這個帳號本賽季買過的比賽週通行證可以折多少。
 *
 * ⚠️ **所有權由登入證明**（2026-10-30 起）。以前是「email ＋一組屬於該 email 的授權碼」——
 *    email 是公開資訊不是憑證（第一版只靠 email，等於能用別人的錢買自己的授權），所以要碼當證明。
 *    授權碼綁帳號之後，登入本身就是更強的證明（要收得到那個信箱的驗證碼或 Google 登入），
 *    而且不會有「拿到一組碼就能試出購買信箱」的問題（security-audit run-2 #16 那一條整個消失）。
 * @param emails  **登入的帳號**的信箱清單（呼叫端從工作階段取得，不可以是使用者填的）
 */
async function weekCreditFor(env, emails, from) {
  const mails = (Array.isArray(emails) ? emails : []).map((e) => accountKey(e)).filter(Boolean);
  if (!mails.length || !env.SUBS) return { credit: 0, keys: [], reason: 'need_login' };

  let arr = [];
  for (const mail of mails.slice(0, 10)) {
    let a = [];
    try { a = JSON.parse((await env.SUBS.get(`licmail:${mail}`)) || '[]'); } catch (e) { /* noop */ }
    for (const k of (Array.isArray(a) ? a : []).slice(0, 50)) if (!arr.includes(k)) arr.push(k);
  }
  if (!arr.length) return { credit: 0, keys: [], reason: 'none' };

  const seasonEnd = seasonEndSec(from);
  let credit = 0;
  const keys = [];
  for (const k of arr) {
    const lic = await readLicense(env, k);
    if (!lic || lic.revoked || lic.replacedBy) continue;
    // 以授權記錄本身為準（licmail 索引可能過期）
    if (!mails.includes(accountKey(lic.acct || lic.email || ''))) continue;
    const p = PLANS[lic.plan];
    if (!p || !p.weekBound) continue;               // 只有比賽週通行證能抵
    // ⚠️ **代訂附贈的那一週是我們送的，不可以拿來折抵我們自己的錢。**
    //
    //    fromService 的檢查原本只做在「當證明用的那一張」上，
    //    **沒有做在這個累加迴圈裡**——於是只要手上有任何一張真的通行證當證明，
    //    代訂送的那幾張就全部被算進折抵。實測：真票 39 + 贈送票 → 折抵 80。
    //    上限救了大部分損失，但那 80 元仍然是白送的。
    if (p.fromService) continue;
    if (lic.creditedAt) continue;                   // 已經抵過了
    // 本賽季：到期日必須落在這個賽季界線之前
    if (!lic.expiresAt || lic.expiresAt > seasonEnd) continue;
    // ⚠️ 贈送的（paid: 0）就是 0——以前用 `||` 把 0 當成「沒記錄」改用牌價，送的票也能抵 NT$49
    credit += Number(lic.paid != null ? lic.paid : p.price) || 0;
    keys.push(k);
  }
  // ⚠️ **一定要夾上限。** 通行證可以一次買多站之後，
  //    12 站（NT$468）的折抵會超過賽季票本身。
  if (credit > UPGRADE_CREDIT_MAX) credit = UPGRADE_CREDIT_MAX;
  return credit > 0 ? { credit, keys } : { credit: 0, keys: [], reason: 'none' };
}

/** 升級後把用掉的那些標記起來，避免重複抵扣。 */
async function markCredited(env, keys, orderId) {
  for (const k of keys || []) {
    const lic = await readLicense(env, k);
    if (!lic || lic.creditedAt) continue;
    lic.creditedAt = nowSec();
    lic.creditedBy = String(orderId || '');
    await env.SUBS.put(licKey(k), JSON.stringify(lic));
  }
}

// 早鳥限量。賣完自動改用正式價——**不能靠人工盯著改**，
// 賣超了要嘛食言要嘛虧錢，兩個都不該發生。
const EARLY_LIMIT = 20;
// 早鳥賣的是哪一年的賽季票（2026-11-03 Ray：賣 2027）。**不跟著 SEASON_YEAR 走**，見 PLANS.season_early
const EARLY_YEAR = 2027;
// 結帳時保留早鳥名額多久（秒）。早鳥只收信用卡（handleCheckout），刷卡頁不會開這麼久；
// 超過才付款的，webhook 還有名額就照賣、沒有就改發同內容的季票（earlyClaim）
const EARLY_HOLD_SEC = 1800;
// 本賽季免費體驗的賽季（2026-11-03 Ray）。只在 SEASON_YEAR 等於它、而且本賽季還沒跑完時生效；
// 換季之後自動失效，不必記得回來關
const FREE_SEASON_YEAR = 2026;

// 通行證有效期。用戶端每 24 小時回報一次，這個 14 天只是**離線緩衝**——
// 後端掛掉時已付費的人還能撐兩週（見 SECURITY.md 的授權模型）。
const ENTITLEMENT_DAYS = 14;

/**
 * 本賽季（SEASON_YEAR）結束時間：SEASON_YEAR 的隔年 1 月 31 日。
 *
 * ⚠️ **綁賽季年份，不綁「現在是哪一年」**（2026-10-30 全面檢查發現）。以前用今天的日期推：
 *    過了 1/31 就算到明年的 1/31——換季作業（season-rollover）只要晚於 2/1，這時買「2026 賽季通行證」
 *    會拿到到 2028/1/31 的效期（整個 2027 賽季，而且剩 0 站收 299），下一賽季通行證更是到 2029。
 *    `from` 留著只是讓舊的呼叫端不必改；賽季結束後停賣本季票見 planLock。
 */
function seasonEndSec(from) {   // eslint-disable-line no-unused-vars
  return Math.floor(Date.UTC(SEASON_YEAR + 1, 0, 31, 23, 59, 59) / 1000);
}

/**
 * 下一個賽季結束的時間。
 *
 * 賽季末期賣的是下一季的通行證，效期要蓋到那一季跑完為止。
 * 直接在 `seasonEndSec` 上再加一年——F1 賽季固定橫跨年底，
 * 用「隔年 1/31」這個界線推一年就是下一季的界線。
 */
function nextSeasonEndSec(from) {   // eslint-disable-line no-unused-vars
  return Math.floor(Date.UTC(SEASON_YEAR + 2, 0, 31, 23, 59, 59) / 1000);
}

/**
 * Weekend Pass 涵蓋的時段：**該比賽週的星期四 → 該週末結束**。
 *
 * ⚠️ 舊版是「發碼後 4 天」，那在使用者提前購買時會**在比賽開始前就過期**——
 *    付了錢卻什麼都看不到，而且不會有任何錯誤訊息。賣的是「某一場 GP 的週末」，
 *    效期就該綁那一場，不是綁購買時間。
 *
 * 結束時間取正賽日的隔天 00:00 UTC。各站時區差很多（拉斯維加斯的正賽在
 * 當地週六晚上、澳洲的正賽在 UTC 週六），統一往後蓋一天才不會有人
 * 在自己的星期天發現通行證已經過期。
 */
function weekendWindow(from, cfg) {
  const gp = nextGrandPrix(from, cfg);
  if (!gp) return null;
  const thursday = dayStartSec(gp.start) - 86400;      // start 是練習賽第一天（週五）
  const closes = dayStartSec(gp.end) + 86400;
  return { gp, startsAt: thursday, expiresAt: closes };
}

/**
 * 比賽週通行證的時段。
 *
 * **設計取捨**：使用者原本想讓買家自己選「立刻啟用或延後啟用」。
 * 我建議不要——那是一個需要解釋的決定，而買東西時最不想做的就是做決定；
 * 「我以為我選了延後」會直接變成退款爭議，而且沒有乾淨的裁決依據。
 *
 * 改成規則固定、購買頁一句話講完：
 *
 *   購買當下 ──立刻可用（贈送）──► 下一個比賽週的星期一 ──7 天──► 到期
 *
 * 這樣正式的七天一定完整涵蓋週五六日的比賽，買家不必算、也不會算錯，
 * 而購買到比賽週之間的空檔變成「送的」——那段時間 F1TV 本來就有大量重播，
 * 對買家是實質好處，對我們幾乎零成本（共用快取）。
 *
 * `GRACE_MAX_SEC` 是必要的上限：夏休期間買，下一個比賽週可能在四週後，
 * 沒有上限的話「贈送」會變成「幾乎白送一個月」。
 */
const WEEK_GRACE_MAX_SEC = 14 * 86400;

