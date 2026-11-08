// ---------------------------------------------------------------------------
// 伺服器端的授權閘門
//
// **用戶端的授權檢查只是 UI，這裡才是真正的牆。**
// 用戶端沒有 TOKEN_SECRET，驗不了通行證的簽章；而且使用者本來就能改自己
// 電腦上的 storage。所以「有沒有付費」必須在會花錢的端點上判定。
//
// 免費層的配額也在這裡。用戶端負責「播到 15 分鐘就不再顯示」（那是產品承諾），
// 伺服器負責「未授權的安裝每天最多翻 N 句」（那是成本保護）。
// 兩者目的不同，都要有——只做前者的話，改個 storage 就能無限用。
// ---------------------------------------------------------------------------

// 免費層每天的翻譯句數上限。
// 一場練習賽 15 分鐘約 250~300 句，四種場次一天最多兩場，抓 800 已經寬鬆。
// 超過就退回「只讀共用快取」——**已經有人翻過的影片仍然完全可用**，
// 使用者不會覺得壞掉，只是新影片當天不再幫他翻。
const FREE_DAILY_LINES = 800;

/**
 * 遊客（沒有登入）的每日額度。約等於三個場次各 5 分鐘的轉播（2026-09-17 由 3 分鐘調為 5 分鐘）。
 *
 * ⚠️ **這個數字的用途不是省錢，是給「登入」一個理由。**
 *    遊客身分清一次瀏覽器就能重來，那是原理上擋不住的；
 *    與其假裝擋得住，不如讓「登入就從 3 分鐘變 15 分鐘」變成一個
 *    划算到不值得繞過的交易。
 */
const FREE_DAILY_LINES_GUEST = 300;

// IP 層的額度倍率。同一個 IP 後面可能是整個家庭或宿舍的 NAT，
// 設太緊會誤傷正常使用者，而那種傷害是靜默的——他只會覺得壞掉然後解除安裝。
const FREE_IP_MULTIPLIER = 3;

const freeKey = (installId) => `free:${installId}:${new Date().toISOString().slice(0, 10)}`;

/**
 * 判定這次請求能翻幾句。回傳 { allowed, reason, plan }。
 *
 * 設計原則：**任何不確定的情況都往寬鬆解釋**。
 * 讀不到授權、KV 暫時有問題、通行證剛好在續期空窗——
 * 這些都不該讓付了錢的人被擋。真正要擋的是「明確沒有授權且已超過免費額度」。
 */
async function checkEntitlement(env, auth, request, wantLines) {
  // userscript 是**管理員收割工具**，它的工作就是賽前把整支影片翻完灌進共用快取。
  // 用免費額度擋它等於把整個共用快取的來源掐死——而且 legacy 全體共用
  // 一個 installId，第一個人用完 800 句，其他人全部被擋。
  // 它拿的是 CLIENT_TOKEN（只有你有），本來就不是一般使用者。
  if (auth.legacy) return { allowed: wantLines, reason: 'legacy', plan: 'admin' };

  const ent = request.headers.get('x-entitlement') || '';

  if (ent) {
    const v = await verifyEntitlement(env, ent);
    // 通行證必須是簽給這個安裝的，否則等於一張到處傳的萬用票
    if (v.ok && v.installId === auth.installId) {
      if ((await revokedSet(env)).has(auth.installId)) {
        return { allowed: 0, reason: 'revoked', plan: null };
      }
      // 授權碼被刪除／停用／清空裝置時，簽出去的通行證要在這裡被擋下。
      // 沒有這一步，刪掉授權碼在伺服器端**完全沒有效果**，最長 14 天照樣放行。
      // 注意這裡是 break 不是 return —— 讓他退回免費層，而不是整個擋死。
      // ⚠️ 作廢只擋「作廢那一刻以前簽的」通行證（security-audit 2026-10-05 #2，本機重現過）。
      //    以前清單只認 installId、而且任何啟用都會把那台從清單拿掉——啟用**另一組**自己的授權碼
      //    （甚至是還沒開始、根本不發通行證的那種）就讓被退款／被解除／被換發掉的那張通行證復活。
      //    現在不必「解除作廢」：之後新簽的通行證時間在作廢之後，自然通過。
      const vs = await entVoidSet(env);
      const voidedAt = vs.at ? vs.at.get(auth.installId) : (vs.has(auth.installId) ? Infinity : 0);
      if (!voidedAt || (v.iat && v.iat > voidedAt)) {
        // 付費的每日上限在 handleTranslate 真的要呼叫模型時才預扣（licensedQuotaKeys）
        return { allowed: wantLines, reason: 'licensed', plan: v.plan, quotaKeys: licensedQuotaKeys(auth) };
      }
    }
    // 通行證壞掉或過期 → 不直接拒絕，往下走免費層。
    // 使用者可能只是續期失敗，讓他至少還有免費額度可用。
  }

  // ---- 免費層 ----
  //
  // 兩個鍵一起看：**installId** 與 **IP**。
  //
  // 只看 installId 的話，重裝擴充功能就換一組新的、額度全新——那是原理上
  // 擋不住的（installId 存在使用者自己的 storage 裡）。加上 IP 這一層之後，
  // 想重複拿免費額度就得連 IP 一起換，難度差很多：重裝是點兩下，換 IP 要
  // 換網路或掛 VPN，而願意為了省 NT$299 每天做這件事的人不是我們的客戶。
  //
  // ⚠️ IP 的額度**刻意開得比 installId 寬**（3 倍）。同一個 IP 後面可能是
  //    整個家庭、宿舍或公司的 NAT，設太緊會誤傷完全正常的使用者，
  //    而那種傷害是靜默的：他只會覺得「這東西壞掉了」然後解除安裝。
  const ipRaw = request.headers.get('cf-connecting-ip') || '';

  // ⚠️ **額度綁帳號，不是綁 installId——這才是防白嫖的關鍵。**
  //
  //    `installId` 存在使用者自己的瀏覽器儲存裡，清掉就是一個全新身分，
  //    那是**原理上擋不住的**。加上 IP 只是提高一點成本（換手機熱點就繞過）。
  //    真正能拉高成本的是「要一個已驗證的 email 或 Google 帳號」——
  //    那要手機驗證，不是點兩下就有。
  //
  //    所以：登入的人額度綁 `sub`（清瀏覽器沒用），遊客綁 installId 且額度較小。
  //    這不是懲罰遊客，是給「留下聯絡方式」一個具體的理由。
  const loggedIn = !!(auth && auth.acct);
  const cap = loggedIn ? FREE_DAILY_LINES : FREE_DAILY_LINES_GUEST;
  // ⚠️ **這裡只決定「算在誰身上、上限多少」，不讀也不扣用量**（security-audit run-2 #1，2026-10-06）。
  //    以前是「這裡讀 KV 看用了多少 → 呼叫模型 → 事後取樣寫回」：20 個請求同時到，20 個都讀到
  //    「還剩 300 句」，一共翻了 4,000 句。現在用量在 AuthGuard 裡**先預扣**
  //    （handleTranslate → quotaReserve），只有真的要呼叫模型的請求才扣，翻完退回沒用到的。
  //    額度用完的人**照樣拿得到共用快取裡已經有的句子**——那本來就是設計（見 FREE_DAILY_LINES）。
  // ⚠️ 安裝／帳號與 IP **兩把一起扣**（取兩者剩餘的較小值）。IP 只存雜湊（隱私權政策）；
  //    IPv6 以 /64 計——一般家用網路配到的是一整段 /64，用完整位址算等於每換一個位址就有新額度
  //    （security-audit run-2 需驗證 #2）。
  const keys = [{ k: freeKey(loggedIn ? 'acct:' + auth.acct : auth.installId), max: cap }];
  if (ipRaw) {
    keys.push({ k: freeKey('ip:' + (await hmac(tokenSecret(env) || 'x', ipBucket(ipRaw))).slice(0, 16)), max: FREE_DAILY_LINES * FREE_IP_MULTIPLIER });
  }
  return {
    allowed: wantLines,
    reason: 'free', plan: loggedIn ? 'trial' : 'guest',
    quotaKeys: keys, quotaUnit: 'lines',
  };
}

/**
 * IP 的計數單位：IPv4 是整個位址，IPv6 取前 64 位元（一個家用網段）。
 * ⚠️ 只用來算額度，不寫進任何儲存（呼叫端會先雜湊）。
 */
function ipBucket(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s.includes(':')) return s;
  // 展開 :: 之後取前 4 組
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const full = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => (x || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/**
 * 付費使用者每天最多讓模型翻多少字元（security-audit run-2 #2）。
 *
 * ⚠️ 以前付費的沒有任何上限，只有全站每天 DAILY_USD_CAP（$5）的熔斷——一個付費安裝送 30 個
 *    200 句的長句子就把全站燒到熔斷，之後**所有人**（付費與免費）都沒有新字幕。
 *    現在每個安裝、每個帳號各有上限，超過只擋那一個人，全站熔斷留著當最後保險。
 * ⚠️ 用**字元**不用句數：模型費用跟著長度走，攻擊用的是 1,000 字元的長句子。
 *    正常的一句字幕約 40 字元、一小時約 1,100 句 ≈ 5 萬字元；40 萬字元 ≈ 8 小時沒有共用快取的新內容，
 *    約 US$1。一組授權碼最多 3 台裝置 × 40 萬，碰不到 $5 的熔斷。
 */
const LICENSED_DAILY_CHARS = 400000;
const LICENSED_DAILY_CHARS_ACCT = 600000;
/** 小於這個字元數的付費請求（直播的一般批次）不等預扣結果，見 handleTranslate 2.1。 */
const LICENSED_SYNC_CHARS = 4000;
/** 這個 isolate 已知今天用完的額度鍵（鍵名帶日期，隔天自然對不上）。 */
const licExhausted = new Set();
function markLicExhausted(keys) {
  if (licExhausted.size > 5000) licExhausted.clear();
  for (const x of keys || []) licExhausted.add(x.k);
}

function licensedQuotaKeys(auth) {
  const keys = [{ k: freeKey('lic:' + auth.installId), max: LICENSED_DAILY_CHARS }];
  if (auth.acct) keys.push({ k: freeKey('lica:' + auth.acct), max: LICENSED_DAILY_CHARS_ACCT });
  return keys;
}

/**
 * 在 AuthGuard 裡預扣額度。回傳實際給了多少（可能比要的少）；連不上回 null。
 * 鍵名裡帶 UTC 日期（freeKey），過了午夜就是新的一把。
 */
async function quotaReserve(env, keys, want) {
  if (!env.AUTH) return want;               // 本機沒有 AuthGuard：不限（與 kvWriteBudgetOk 一致）
  const end = (Math.floor(Date.now() / 86400000) + 2) * 86400;
  const r = await authCall(env, { op: 'reserve', want, keys: keys.map((x) => ({ k: x.k, max: x.max, exp: end })) });
  return (r && r.ok) ? Math.max(0, Number(r.granted) || 0) : null;
}

async function quotaRefund(env, keys, n) {
  if (!env.AUTH || !(n > 0)) return;
  try { await authCall(env, { op: 'refund', n, keys: keys.map((x) => x.k) }); } catch (e) { /* 退不回去只是少用一點 */ }
}

/**
 * 這個網址後綴算不算免費場次。
 *
 * ⚠️ **這條規則以前只存在於用戶端。** 後端的免費層只認「今天用掉幾句」，
 *    完全不知道使用者在看哪支影片——所以「免費只涵蓋四種正式場次的前 15 分鐘」
 *    這件事，只要改一下用戶端就繞得過去。那不是取捨，是疏漏。
 *
 * ⚠️ **slug 的來源順序有意義。**
 *    1. bundle.slug —— 收割時由我們自己寫入，一般使用者改不到，是可信的
 *    2. body.slug   —— 用戶端送的，可以偽造，只在我們還沒有記錄時才用
 *
 *    兩者都沒有時**放行**（fail open）。理由：真正值得白嫖的是正賽、排位這些
 *    熱門影片，而那些一定被收割過、一定有 bundle.slug；為了堵一個不存在的
 *    情境去擋掉「還沒被收割的新影片」，代價是把新使用者第一次的體驗弄壞，
 *    而那是我們的獲客漏斗。免費層本來就還有每日句數上限兜著。
 */
function isFreeSlug(slug) {
  const ft = REMOTE_CONFIG.freeTier || {};
  const s = String(slug || '').toLowerCase();
  if (!s) return null;                                  // 沒有資訊，不做判斷
  try {
    if ((ft.exclude || []).some((p) => new RegExp(p).test(s))) return false;
    return (ft.include || []).some((p) => new RegExp(p).test(s));
  } catch (e) {
    return null;                                        // 設定裡的正則壞掉：不擋
  }
}

// （noteFreeUsage 已移除，2026-10-06：免費額度改在 AuthGuard 裡預扣，見 quotaReserve。
//   以前的取樣寫入每 10 次寫一次 KV，而且「先讀、事後寫」擋不住並發。）

// ---------------------------------------------------------------------------
// 產品數據（彙總，不可識別個人）
//
// **只收「能改善產品與定價」的東西，其餘一律不收。**
//
// 收：場次類型的使用分布、免費額度用到第幾分鐘、免費 → 付費的轉換、
//     各版本的錯誤率、共用快取命中率。
// 不收：看了哪一支影片（cid 不進這裡）、IP、瀏覽紀錄、任何跨站識別碼。
//
// 為什麼刻意不收 cid：那等於觀看紀錄。它對「優化商業方案」沒有幫助
// （我知道「排位賽佔 30%」就夠了，不需要知道「這個人看了摩納哥排位賽」），
// 卻會讓隱私政策難寫、商店審查難過、資料外洩時的後果嚴重得多。
//
// 儲存方式與成本統計相同：isolate 內累積，每 15 分鐘或滿 200 筆才落地，
// 避開 KV 1,000 puts/天 的天花板。
// ---------------------------------------------------------------------------
const METRIC_TTL_DAYS = 400;

let mPending = { at: Date.now(), n: 0, rows: {} };

function metricKey(d) {
  return `metric:${new Date(d || Date.now()).toISOString().slice(0, 10)}`;
}

/**
 * 合法的事件與維度。**白名單制**——用戶端傳什麼我們都不照單全收，
 * 否則哪天多送了一個欄位，個資就從那裡漏出去了。
 */
const METRIC_EVENTS = {
  session_start: ['sessionType', 'licensed', 'version'],
  free_exhausted: ['sessionType', 'minutes', 'version'],
  license_activated: ['plan', 'version'],
  playback_error: ['kind', 'version'],
};

const SESSION_TYPES = ['practice', 'qualifying', 'sprint', 'race', 'other'];
// 2026-11-03 補上 week／season_next／week_svc／replay_month：以前比賽週通行證的啟用全部記成 other（行銷對話發現）
const PLAN_NAMES = ['season_early', 'season', 'season_next', 'week', 'week_svc', 'replay_month', 'comp', 'trial', 'free_season'];

/** 把用戶端送來的值收斂成有限集合，避免變成自由文字而夾帶內容。 */
function normDim(key, v) {
  if (key === 'sessionType') return SESSION_TYPES.includes(v) ? v : 'other';
  if (key === 'plan') return PLAN_NAMES.includes(v) ? v : 'other';
  if (key === 'licensed') return v ? 'yes' : 'no';
  if (key === 'version') return /^\d+\.\d+\.\d+$/.test(String(v)) ? String(v) : 'unknown';
  if (key === 'minutes') {
    // 分桶而不是原值——原值精確到秒等於一條時間軸，分桶才是統計
    const n = Number(v);
    if (!Number.isFinite(n)) return 'unknown';
    return n < 5 ? '0-5' : n < 10 ? '5-10' : n < 15 ? '10-15' : '15+';
  }
  if (key === 'kind') {
    const K = ['no_caption', 'prefetch_failed', 'backend_error', 'poll_stall'];
    return K.includes(v) ? v : 'other';
  }
  return 'other';
}

function recordMetric(event, dims) {
  const allowed = METRIC_EVENTS[event];
  if (!allowed) return;                     // 不認識的事件直接丟掉
  const parts = [event];
  for (const k of allowed) parts.push(`${k}=${normDim(k, dims && dims[k])}`);
  const key = parts.join('|');
  mPending.rows[key] = (mPending.rows[key] || 0) + 1;
  mPending.n++;
}

function metricsShouldFlush() {
  return mPending.n >= 200 || (mPending.n > 0 && Date.now() - mPending.at > 15 * 60 * 1000);
}

async function flushMetrics(env) {
  if (!mPending.n) return;
  const mine = mPending.rows;
  mPending = { at: Date.now(), n: 0, rows: {} };
  const key = metricKey();
  let day = {};
  try { day = JSON.parse((await env.SUBS.get(key)) || '{}'); } catch (e) { /* 壞掉重來 */ }
  // 與 bundle 一樣是多寫入者，同樣要重讀後合併（坑 #24）
  for (const [k, v] of Object.entries(mine)) day[k] = (day[k] || 0) + v;
  await env.SUBS.put(key, JSON.stringify(day), { expirationTtl: METRIC_TTL_DAYS * 86400 });
}

/** 用戶端回報事件。刻意不需要授權以外的任何資訊。 */
async function handleMetric(request, env, auth) {
  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');
  const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
  for (const e of events) {
    if (e && typeof e.event === 'string') recordMetric(e.event, e.dims || {});
  }
  if (metricsShouldFlush()) {
    // ⚠️ 落地要吃全站每日上限（security-audit run-2 需驗證 #4）：匿名安裝每 10 個請求就能觸發一次寫入。
    //    超過就丟掉這一批——產品統計不值得拿結帳與發碼要用的 KV 寫入去換。
    if (await kvWriteBudgetOk(env, 'metricall', 'all')) { try { await flushMetrics(env); } catch (e2) { /* 統計不擋主流程 */ } }
    else mPending = { at: Date.now(), n: 0, rows: {} };
  }
  return json({ ok: true, accepted: events.length });
}

/**
 * 管理端：讀統計。整理成「能拿來做決定」的形狀，不是丟一堆原始計數。
 */
async function handleMetrics(env, url) {
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
  const agg = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    let day = {};
    try { day = JSON.parse((await env.SUBS.get(metricKey(d))) || '{}'); } catch (e) { /* noop */ }
    for (const [k, v] of Object.entries(day)) agg[k] = (agg[k] || 0) + v;
  }

  const pick = (prefix) => Object.entries(agg)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => [k.split('|').slice(1), v]);

  // 場次類型分布 —— 回答「該不該把免費層擴大到別的內容」
  const bySession = {};
  for (const [dims, v] of pick('session_start|')) {
    const t = (dims.find((d) => d.startsWith('sessionType=')) || '').slice(12);
    bySession[t] = (bySession[t] || 0) + v;
  }

  // 免費額度用到第幾分鐘就走 —— 回答「15 分鐘夠不夠」
  const freeDropoff = {};
  for (const [dims, v] of pick('free_exhausted|')) {
    const m = (dims.find((d) => d.startsWith('minutes=')) || '').slice(8);
    freeDropoff[m] = (freeDropoff[m] || 0) + v;
  }

  // 轉換率 —— 回答「定價對不對」
  let freeStarts = 0, paidStarts = 0;
  for (const [dims, v] of pick('session_start|')) {
    const lic = (dims.find((d) => d.startsWith('licensed=')) || '').slice(9);
    if (lic === 'yes') paidStarts += v; else freeStarts += v;
  }
  const activations = pick('license_activated|').reduce((a, [, v]) => a + v, 0);

  // 各版本的錯誤 —— 回答「這次推送是不是推壞了」
  const errorsByVersion = {};
  for (const [dims, v] of pick('playback_error|')) {
    const ver = (dims.find((d) => d.startsWith('version=')) || '').slice(8);
    const kind = (dims.find((d) => d.startsWith('kind=')) || '').slice(5);
    errorsByVersion[ver] = errorsByVersion[ver] || {};
    errorsByVersion[ver][kind] = (errorsByVersion[ver][kind] || 0) + v;
  }

  return json({
    days,
    sessionTypes: bySession,
    freeDropoffMinutes: freeDropoff,
    sessions: { free: freeStarts, licensed: paidStarts },
    activations,
    conversionHint: freeStarts ? +(activations / freeStarts).toFixed(4) : null,
    errorsByVersion,
    note: '所有數據皆為彙總計數，不含 contentId、IP 或任何可識別個人的資訊。',
  });
}

// ---------------------------------------------------------------------------
// 成長統計（2026-11-04，Ray：「加一個統計數據的區塊，可以忽略11/3之前的 因為那之前都是我在測試」）
//
// 註冊、登入、購買、使用事件，全部從某一天（台灣時間 00:00）算起。
// ⚠️ **讀取不可以觸發寫入**（坑 #46）：這支只 list／get，一次 KV 寫入都沒有。
// ⚠️ **list 也有額度**（坑 #47）：帳號沒有 metadata，只能逐筆 get，所以整份結果
//    在記憶體快取 5 分鐘；後台重複按查詢不會重新列舉。帳號上千之後要改成寫入時帶
//    metadata（那時每個 `acctg:` 寫入點都要帶，坑 #50），或搬到 D1。
// ⚠️ 帳號的 lastLogin 一天最多更新一次（googleLogin 為了省寫入），所以「活躍」是天的精度。
// ---------------------------------------------------------------------------
const GROWTH_SINCE_DEFAULT = '2026-11-03';   // 這天以前是 Ray 自己的測試
const GROWTH_CACHE_MS = 5 * 60 * 1000;
let growthCache_ = null;                     // { key, at, data }

/** 'YYYY-MM-DD'（台灣時間）→ 那天 00:00 的 Unix 秒 */
function twDayStartSec(ymd) {
  const ms = Date.parse(ymd + 'T00:00:00+08:00');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
/** Unix 秒 → 台灣日期 'YYYY-MM-DD' */
function twYmd(sec) {
  return new Date(sec * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function listAllKeys(env, prefix, maxPages) {
  const out = [];
  let cursor;
  for (let page = 0; page < (maxPages || 10); page++) {
    const r = await env.SUBS.list({ prefix, limit: 1000, cursor });
    out.push(...r.keys);
    if (r.list_complete) return { keys: out, complete: true };
    cursor = r.cursor;
  }
  return { keys: out, complete: false };
}

async function handleGrowth(env, url) {
  const sinceYmd = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('since') || '')
    ? url.searchParams.get('since') : GROWTH_SINCE_DEFAULT;
  const since = twDayStartSec(sinceYmd);
  if (since == null) return err('since 格式錯誤（YYYY-MM-DD）');
  const fresh = url.searchParams.get('fresh') === '1';
  if (!fresh && growthCache_ && growthCache_.key === sinceYmd && Date.now() - growthCache_.at < GROWTH_CACHE_MS) {
    return json(Object.assign({}, growthCache_.data, { cachedAt: growthCache_.at }));
  }
  const now = nowSec();

  // ---- 帳號 ----
  const acctList = await listAllKeys(env, 'acctg:', 5);
  const accounts = [];
  for (const k of acctList.keys) {
    let a = null;
    try { a = JSON.parse((await env.SUBS.get(k.name)) || 'null'); } catch (e) { a = null; }
    if (a) accounts.push(a);
  }
  const fresh_ = accounts.filter((a) => (Number(a.createdAt) || 0) >= since);
  // email 帳號的 sub 是 `em` ＋ HMAC（`emailSub()`，19-authguard.js），**沒有冒號**；更早的版本是 `em:<email>`。
  // Google 的 sub 是純數字，不會以 em 開頭。v5.91 寫成 startsWith('em:')，所有 email 帳號都被算成 Google。
  // ⚠️ 不可以用 `via === 'email'` 判斷：email 帳號併進 Google 後（mergeEmailAccountIntoGoogle）via 會被帶過去。
  const isEmailSub = (a) => String(a.sub || '').startsWith('em');
  const daily = {};
  for (const a of fresh_) { const d = twYmd(a.createdAt); daily[d] = (daily[d] || 0) + 1; }
  const activeWithin = (days) => fresh_.filter((a) => now - (Number(a.lastLogin) || 0) <= days * 86400).length;
  const returned = fresh_.filter((a) => (Number(a.lastLogin) || 0) - (Number(a.createdAt) || 0) >= 86400).length;

  // ---- 訂單（只讀 metadata，一次 list）----
  const ordList = await listAllKeys(env, 'ord:', 5);
  const ordStat = { created: 0, paid: 0, failed: 0, refunded: 0, other: 0, revenueTwd: 0, freeOrders: 0 };
  const paidEmails = new Set();
  for (const k of ordList.keys) {
    const m = k.metadata || {};
    if ((Number(m.at) || 0) < since) continue;
    ordStat.created++;
    if (m.s === 'paid') {
      ordStat.paid++;
      ordStat.revenueTwd += Number(m.t) || 0;
      // NT$0 的訂單（免費方案、全額折抵）不算「付費」——那個人沒有付錢
      if (!(Number(m.t) > 0)) ordStat.freeOrders++;
      else if (m.e) paidEmails.add(accountKey(m.e));
    } else if (m.s === 'failed') ordStat.failed++;
    else if (m.s === 'refunded') ordStat.refunded++;
    else ordStat.other++;
  }
  // 註冊後有付費的帳號（任一個綁定的 email 出現在金額 > 0 的已付款訂單上）。
  // ⚠️ metadata 的 email 截在 60 字元，超長信箱會對不上——下限值。
  const buyers = fresh_.filter((a) => [a.email].concat(a.emails || []).some((e) => e && paidEmails.has(accountKey(e).slice(0, 60)))).length;

  // ---- 使用事件（metric:<UTC 日>，所以起點是 UTC 日期，最多差 8 小時）----
  const ev = { sessionFree: 0, sessionLicensed: 0, freeExhausted: 0, activations: 0, activationsByPlan: {}, errors: 0 };
  const evDaily = {};
  const startUtc = new Date(since * 1000);
  const dayCount = Math.min(400, Math.ceil((Date.now() - startUtc.getTime()) / 86400000) + 1);
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const key = metricKey(d);
    if (key.slice(7) < twYmd(since)) break;
    let day = {};
    try { day = JSON.parse((await env.SUBS.get(key)) || '{}'); } catch (e) { day = {}; }
    if (i === 0) for (const [k, v] of Object.entries(mPending.rows)) day[k] = (day[k] || 0) + v; // 疊上未落地的（坑 #46）
    const ymd = key.slice(7);
    const dd = evDaily[ymd] = { sessions: 0, activations: 0 };
    for (const [k, v] of Object.entries(day)) {
      const [name, ...dims] = k.split('|');
      if (name === 'session_start') {
        if (dims.includes('licensed=yes')) ev.sessionLicensed += v; else ev.sessionFree += v;
        dd.sessions += v;
      } else if (name === 'free_exhausted') ev.freeExhausted += v;
      else if (name === 'license_activated') {
        ev.activations += v; dd.activations += v;
        const plan = (dims.find((x) => x.startsWith('plan=')) || 'plan=other').slice(5);
        ev.activationsByPlan[plan] = (ev.activationsByPlan[plan] || 0) + v;
      } else if (name === 'playback_error') ev.errors += v;
    }
  }

  const data = {
    ok: true,
    since: sinceYmd,
    accounts: {
      total: fresh_.length,
      allTime: accounts.length,
      google: fresh_.filter((a) => !isEmailSub(a)).length,
      email: fresh_.filter(isEmailSub).length,
      active7: activeWithin(7),
      active30: activeWithin(30),
      returned,
      buyers,
      daily,
      listComplete: acctList.complete,
    },
    orders: Object.assign(ordStat, { listComplete: ordList.complete }),
    events: Object.assign(ev, { daily: evDaily }),
    note: '帳號與訂單以台灣時間起算；使用事件以 UTC 日期分格（最多差 8 小時）。活躍＝最後登入在期間內（一天最多記一次）。',
  };
  growthCache_ = { key: sinceYmd, at: Date.now(), data };
  return json(data);
}

// ---------------------------------------------------------------------------
// 診斷回報
//
// 使用者按「傳送診斷」→ 後端收下、給一個工單編號、存進 KV。
//
// **為什麼不是直接寄信**：從 Cloudflare 寄到 Gmail 需要一個已驗證的寄件網域
// （SPF/DKIM）。在 pitlingo.com 買下並設定好之前，任何寄信方案的送達率
// 都會很差，甚至直接進垃圾桶——那比沒有更糟，因為你會以為沒人回報。
//
// 所以分兩層：
//   1. 一律存進 KV，後台看得到（**這層永遠可靠，不依賴任何外部服務**）
//   2. 設定了 REPORT_WEBHOOK 就額外推一份出去（Email API、Discord、Slack 都行）
//      —— 網域好了之後填上去即可，不用改程式。
// ---------------------------------------------------------------------------
const REPORT_TTL_DAYS = 90;
// 自動回報（量測用）留短一點：它是我們自己產生的量測資料，不是客訴，
// 而且一場直播就會產生十幾份。
const AUTO_REPORT_TTL_DAYS = 14;

/** 工單編號：PL-YYMMDD-XXXX。使用者報修時報這組，我們就查得到。 */
function ticketId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((x) => AB[x % AB.length]).join('');
  return `PL-${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${r}`;
}

async function handleReportSubmit(request, env, auth) {
  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');

  const report = String(body.report || '');
  if (!report.trim()) return err('診斷內容是空的');
  if (report.length > 200000) return err('診斷內容過大');

  // 使用者可能填了聯絡方式（選填）。沒填就靠工單編號對。
  const contact = String(body.contact || '').slice(0, 200);
  const note = String(body.note || '').slice(0, 2000);

  // ⚠️ **自動回報要和客訴分開存（`areport:` 前綴），不是加個欄位就好。**（2026-09-24）
  //    三件事都會壞掉：
  //    1) 工單清單只讀前 200 把鍵（依鍵名排序 ≈ 依時間），一場直播十幾份自動回報
  //       會把真正的客訴擠出那個視窗；
  //    2) 每日彙報數的是 `report:` 裡「未處理」的數量，自動回報永遠不會被處理，
  //       彙報會天天喊一個不可能歸零的數字（坑 #63：不可能處理的警告比沒有警告更糟）；
  //    3) 下面的信也會每 10 分鐘寄一封。
  const auto = !!body.auto;
  const id = ticketId();
  const rec = {
    id, at: nowSec(),
    installId: auth.installId,
    version: String(body.version || ''),
    contact, note, report,
  };
  if (auto) rec.auto = 1;
  // ⚠️ metadata 一定要寫（坑 #73）：每日彙報用 list() 數「未處理」，只讀得到 metadata。
  await env.SUBS.put(`${auto ? 'areport' : 'report'}:${id}`, JSON.stringify(rec),
    { expirationTtl: (auto ? AUTO_REPORT_TTL_DAYS : REPORT_TTL_DAYS) * 86400, metadata: reportMeta(rec) });

  // 第二層：有設定就推出去。**失敗不影響回報成功**——
  // 東西已經存進 KV 了，使用者不該因為我們的通知管道有問題而被要求重送。
  // ⚠️ 診斷回報是**唯一**的問題回報管道。通知不出去等於工單石沉大海。
  // ⚠️ 但自動回報不寄信：它每 10 分鐘一份，寄信只會讓真正的客訴淹沒在裡面。
  // ⚠️ 通知信有自己的上限（security-audit run-2 需驗證 #6）：回報每天最多 300 筆，
  //    每筆都寄信會用掉 Resend 的每日額度（免費方案 100 封），那天付了錢的人收不到授權碼。
  //    超過只是不寄信——工單照樣存著，後台「問題回報」看得到。
  const mailOk = !auto && (await kvWriteBudgetOk(env, 'reportmail', auth.installId))
    && (await kvWriteBudgetOk(env, 'reportmailall', 'all'));
  if (mailOk) try {
    await notifyAdmin(env, `[PitLingo] 診斷回報 ${id}`,
      `工單　：${id}\n版本　：${rec.version || '-'}\n`
      + `聯絡　：${contact || '(未留)'}\n說明　：${note || '(無)'}\n\n`
      + report.slice(0, 20000),
      { to: env.REPORT_TO || 'pitlingo.office@gmail.com' });
  } catch (e) { /* 通知失敗不影響回報本身 */ }

  return json({ ok: true, ticket: id });
}

/**
 * 網站「聯絡我們」表單（/v1/contact）。速率限制在呼叫端（每 IP 每小時 5 筆、全站每天 100 筆）。
 *
 * ⚠️ **一定要寄通知信**（2026-10-28 Ray 回報「用聯絡我們傳送訊息時 email 沒有通知」）：
 *    原本只寫進 `report:`、什麼都沒寄——擴充功能的診斷回報會寄、網站表單不會，
 *    而網站表單是**還沒買、還沒裝**的人唯一的管道，沒人看就等於石沉大海。
 * ⚠️ 通知信有自己的全站上限（contactmailall）：寄信與授權碼信共用 Resend 的額度，
 *    超過只是不寄信——工單照樣存著，後台「問題回報」看得到（與 handleReportSubmit 同一套）。
 */
async function handleContactSubmit(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return err('body 不是合法 JSON');
  const msg = String(b.message || '').trim();
  if (msg.length < 5) return err('請描述你遇到的問題（至少 5 個字）');
  if (msg.length > 4000) return err('內容過長，請精簡在 4000 字以內');
  const contact = String(b.contact || '').trim().slice(0, 200);
  if (!contact) return err('請留下 email，否則我們無法回覆你');

  const id = ticketId();
  await env.SUBS.put(`report:${id}`, JSON.stringify({
    id,
    source: 'web',                         // 後台要分得出來源，處理方式不同
    contact,
    note: msg,
    orderId: String(b.orderId || '').slice(0, 40),
    report: '(網站客服工單，無診斷內容)',
    at: nowSec(),
    resolved: false,
  }), { expirationTtl: REPORT_TTL_DAYS * 86400, metadata: { resolved: false, at: nowSec() } });


  // 通知失敗不影響送出本身：東西已經存了，不該要使用者重送
  if (await kvWriteBudgetOk(env, 'contactmailall', 'all')) try {
    await notifyAdmin(env, `[PitLingo] 網站聯絡表單 ${id}`,
      `工單　：${id}
來源　：網站「聯絡我們」
聯絡　：${contact}
訂單　：${String(b.orderId || '').slice(0, 40) || '(未填)'}

${msg}
`,
      { to: env.REPORT_TO || 'pitlingo.office@gmail.com' });
  } catch (e) { /* 通知失敗不影響工單 */ }

  return json({ ok: true, ticket: id });
}

/** 管理端：列出回報。內容很長，清單只給摘要，點開才看全文。 */
async function handleReportList(env, url) {
  const id = url.searchParams.get('id');
  if (id) {
    // 前綴兩個都要找：後台點開一筆時不必先知道它是客訴還是自動回報。
    const raw = (await env.SUBS.get(`report:${id}`)) || (await env.SUBS.get(`areport:${id}`));
    if (!raw) return err('查無此工單', 404);
    return json(JSON.parse(raw));
  }
  const listed = await env.SUBS.list({
    prefix: url.searchParams.get('kind') === 'auto' ? 'areport:' : 'report:', limit: 200,
  });
  const rows = [];
  for (const k of listed.keys) {
    const raw = await env.SUBS.get(k.name);
    if (!raw) continue;
    let r; try { r = JSON.parse(raw); } catch (e) { continue; }
    rows.push({
      id: r.id, at: r.at, version: r.version, contact: r.contact, note: r.note,
      resolved: !!r.resolved, adminNote: r.adminNote || '', auto: !!r.auto,
      // 摘要抓幾個一眼能判斷的欄位，不用點開就能分類
      summary: (r.report.match(/^目前階段.*$/m) || [''])[0].trim()
        + '　' + (r.report.match(/^命中 \/ 未命中.*$/m) || [''])[0].trim(),
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return json({ rows });
}

