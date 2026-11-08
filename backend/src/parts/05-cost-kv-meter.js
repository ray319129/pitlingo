// ---------------------------------------------------------------------------
// 成本統計與熔斷
//
// 為什麼要自己做：Anthropic 的帳單是事後的，被攻擊時你會在月底才知道。
// 這裡要能即時回答「今天花了多少」「哪支影片最貴」「快取還有沒有生效」。
//
// 為什麼不用 KV 逐筆寫：KV 免費額度 1,000 puts/天，已經撞過一次（坑 #19）。
// 改成 **isolate 內累積、每 15 分鐘或滿 200 筆才落地一次**，
// 最壞 96 puts/天。代價是 isolate 被回收時會掉最後一小段——
// 成本可觀測性容許近似值，額度不容許。
// ---------------------------------------------------------------------------

// Haiku 4.5 每百萬 token 的美元單價。改模型時要一起改。
const PRICE = { in: 1.0, out: 5.0, cacheRead: 0.1, cacheWrite: 1.25 };

// ⚠️ **緩衝區在 isolate 的記憶體裡，而 isolate 被回收時沒有任何關閉鉤子。**
//    還沒落地的部分就這樣消失——不報錯，只是後台的成本偏低。
//    熔斷讀得到「自己這個 isolate 的未落地量」（見 dailyCost 結尾），
//    所以漏掉的是**跨 isolate** 的部分：每個死掉的 isolate 帶走它自己那一份。
//
//    原本是 200 次／15 分鐘，直播時那可能是好幾百句的花費靜靜消失。
//    改成 50 次／2 分鐘：一場約 650 次呼叫的直播只多到 13 次 KV 寫入，
//    離 1,000/天的天花板還很遠（坑 #10）。
const STATS_FLUSH_MS = 2 * 60 * 1000;
const STATS_FLUSH_N = 50;
// 逼近熔斷上限時要更準——那時候「少算幾百句」的代價是**超過上限而不自知**。
const STATS_FLUSH_N_TIGHT = 10;
const STATS_TIGHT_AT = 0.8;
let pending_ = { at: Date.now(), n: 0, rows: {} };

// ---------------------------------------------------------------------------
// KV 用量計量
//
// ⚠️ **這個專案已經撞過一次 KV 寫入的天花板（坑 #19），而從那之後
//    「現在到底寫幾次」一直是用推估的。** 推估在這個專案裡沒有一次是對的。
//
// 免費方案 1,000 puts/天；Workers Paid 是每月 100 萬。差 30 倍，
// 而**你不知道自己在哪一邊、離牆多遠**——這正是最該量的那種東西。
//
// 實作方式是把 binding 包一層，不是去改 119 個呼叫點：
// 改呼叫點一定會漏掉幾個，而漏掉的那幾個正好是最難發現的。
//
// ⚠️ 計數本身**不額外寫 KV**——它搭既有的統計落地一起走（見 flushStats），
//    否則「量測成本」本身就會變成成本。
//
// ⚠️ 與成本統計同樣的限制：緩衝在 isolate 記憶體裡，isolate 被回收會掉一段。
//    所以這個數字是**下限**，真實值只會更高。報告時要照這樣講。
// ---------------------------------------------------------------------------
let kvOps = { put: 0, del: 0, get: 0, list: 0 };

// ⚠️ **落地本身也會寫 KV，而那次寫入會被自己的計量器算到。**（2026-09-24 實測）
//    後果是 flushStats 永遠有理由再跑一次：後台每輪詢一次就「先落地再讀」、
//    落地又寫一次 → 下一次輪詢看到 kvOps.put=1，守門條件成立，又落地……
//    **完全沒有人在看直播的整天，KV 仍以每分鐘約一次的速度爬升**
//    （實測 411 分鐘 381 次，外推一整天 1,335 次／上限 1,000）。
//    9/24 那天 21:17 撞到天花板，有一部分就是這樣燒掉的。
//    **計量器把它要量測的額度吃掉了。**
//
//    解法：自己那幾次寫入不留在 kvOps 裡當成「還有事要做」的證據，
//    而是搬進 carry_，在下一次真的有事的落地時一起記帳——
//    數字照樣精確（不可以用「不計自己」來止血，那是讓計量器說謊），迴圈斷掉。
let carry_ = { put: 0, del: 0, get: 0, list: 0 };

function meteredKV(ns) {
  if (!ns || ns.__metered) return ns;
  return {
    __metered: true,
    get: (...a) => { kvOps.get++; return ns.get(...a); },
    getWithMetadata: (...a) => { kvOps.get++; return ns.getWithMetadata(...a); },
    put: (...a) => { kvOps.put++; return ns.put(...a); },
    delete: (...a) => { kvOps.del++; return ns.delete(...a); },
    list: (...a) => { kvOps.list++; return ns.list(...a); },
  };
}

/** 把 env 換成「KV 有計量」的版本。每個進入點都要包一次。 */
function withMeter(env) {
  if (!env || !env.SUBS || env.SUBS.__metered) return env;
  return Object.assign({}, env, { SUBS: meteredKV(env.SUBS) });
}

/** 免費方案的每日寫入天花板（撞到之後寫入直接失敗）。 */
const KV_FREE_DAILY_PUTS = 1000;

/**
 * 每日 KV 寫入的告警線（2026-11-01，Ray 決定升級 Workers Paid）。
 * 付費方案 KV 寫入每月含 100 萬次、超過每百萬 $5（官方 kv/platform/pricing，2026-11-01 查證），
 * 不再有「撞牆就失敗」——這條線只是「平均一天的含量」，超過代表開始多付錢。
 * 由 wrangler.toml 的 `KV_DAILY_PUTS` 設定；沒設＝免費方案的 1,000。
 * ⚠️ **確認帳號真的升級之後才改設定。** 沒升級就改大，真的撞牆時告警不會響（鐵則 51 反過來）。
 */
function kvDailyCap(env) {
  const n = Number(env && env.KV_DAILY_PUTS);
  return n > 0 ? n : KV_FREE_DAILY_PUTS;
}
const kvPaid = (cap) => cap > KV_FREE_DAILY_PUTS;

/**
 * 統計的 KV 快照最多多久寫一次（2026-10-26，人數成長的模擬）。A11 之後正本在 AuthGuard，KV 只是給後台讀的快照；
 * 以前每次落地都寫——sim-live-swarm 100 人 30 分鐘 stats＋ustats 寫 396 次（KV 每天 1,000）。
 * 讀近兩天的一律走 readStatsDay（問 AuthGuard），不受這個延遲影響。
 */
const STATS_SNAP_MS = 5 * 60000;
const STATS_TTL = [400 * 86400, 120 * 86400];   // stats:、ustats: 的 KV 快照保存期限

/** 讀一天的統計：今天、昨天問 AuthGuard 的正本（最新），更早的或問不到時讀 KV 快照 */
async function readStatsDay(env, key) {
  const d = Date.parse(String(key).replace(/^u?stats:/, '') + 'T00:00:00Z');
  if (env.AUTH && d >= Date.now() - 2 * 86400000) {
    const r = await authCall(env, { op: 'statsGet', key }).catch(() => null);
    if (r && r.ok && r.day && typeof r.day === 'object') return r.day;
  }
  try { return JSON.parse((await env.SUBS.get(key)) || '{}') || {}; } catch (e) { return {}; }
}

function statsKey(d) {
  const t = new Date(d || Date.now());
  return `stats:${t.toISOString().slice(0, 10)}`;      // 一天一個 key
}

function costOf(u) {
  return (u.input_tokens || 0) / 1e6 * PRICE.in
    + (u.output_tokens || 0) / 1e6 * PRICE.out
    + (u.cache_read_input_tokens || 0) / 1e6 * PRICE.cacheRead
    + (u.cache_creation_input_tokens || 0) / 1e6 * PRICE.cacheWrite;
}

/**
 * 每位使用者的用量。
 *
 * 為什麼要獨立一份，而不是加在 stats 的每支影片底下：
 * **兩個問題不一樣。** 「哪支影片花最多錢」是內容問題（要不要預先收割）；
 * 「哪個安裝花最多錢」是濫用與單位經濟問題（有人在燒錢嗎？付費者的
 * 平均成本是多少？）。混在一起會讓兩邊的維度都變成笛卡兒積，資料量爆掉。
 *
 * ⚠️ **一天一個 key，跟著 stats 同一次 flush 落地。**
 *    KV 寫入是免費方案的天花板（1,000/天，坑 #10），
 *    所以絕不能「每位使用者一個 key」——那是每天上萬次寫入。
 *
 * ⚠️ 筆數要有上限。無界成長的 value 遲早撞上 KV 的 25MB 單值上限，
 *    而那會**讓整份統計寫不進去**（連帶影響成本熔斷）。
 *    超過上限的併進 __others，寧可失去尾端的解析度也不要整份掉。
 */
const USTATS_MAX_ROWS = 2000;
let upending_ = {};

function ustatsKey(d) {
  const t = new Date(d || Date.now());
  return `ustats:${t.toISOString().slice(0, 10)}`;
}

function recordUserUsage(installId, plan, usage, translated, cachedHits) {
  const id = String(installId || 'unknown').slice(0, 40);
  const r = upending_[id] || (upending_[id] = {
    calls: 0, translated: 0, cached: 0,
    in: 0, out: 0, cacheRead: 0, cacheWrite: 0, plan: '', last: 0,
  });
  r.calls++;
  r.translated += translated || 0;
  r.cached += cachedHits || 0;
  r.in += usage.input_tokens || 0;
  r.out += usage.output_tokens || 0;
  r.cacheRead += usage.cache_read_input_tokens || 0;
  r.cacheWrite += usage.cache_creation_input_tokens || 0;
  r.plan = plan || r.plan;
  r.last = nowSec();
}

async function flushUserStats(env) {
  const mine = upending_;
  if (!Object.keys(mine).length) return;
  upending_ = {};
  const key = ustatsKey();
  let day = {};
  try { day = JSON.parse((await env.SUBS.get(key)) || '{}'); } catch (e) { day = {}; }
  for (const [id, r] of Object.entries(mine)) {
    // 已經滿了就併進 __others，不要讓 value 無界成長
    // 'harvest' 一定要有自己的一列：收割的熔斷靠它算（併進 __others 就等於收割永遠不會熔斷）
    const target = (day[id] || id === 'harvest' || Object.keys(day).length < USTATS_MAX_ROWS) ? id : '__others';
    const d = day[target] || (day[target] = {
      calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, plan: '', last: 0,
    });
    for (const k of ['calls', 'translated', 'cached', 'in', 'out', 'cacheRead', 'cacheWrite']) {
      d[k] = (d[k] || 0) + r[k];
    }
    d.plan = r.plan || d.plan;
    d.last = Math.max(d.last || 0, r.last || 0);
  }
  try {
    await env.SUBS.put(key, JSON.stringify(day), { expirationTtl: 120 * 86400 });
  } catch (e) {
    // 同 flushStats：先清空再寫入，失敗就要合併回去（見那裡的說明）
    for (const [id, r] of Object.entries(mine)) {
      const t = upending_[id] || (upending_[id] = {
        calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, plan: '', last: 0,
      });
      for (const k of ['calls', 'translated', 'cached', 'in', 'out', 'cacheRead', 'cacheWrite']) {
        t[k] = (t[k] || 0) + (r[k] || 0);
      }
      t.plan = r.plan || t.plan;
      t.last = Math.max(t.last || 0, r.last || 0);
    }
    throw e;
  }
}

function recordUsage(cid, usage, translated, cachedHits) {
  const r = pending_.rows[cid] || (pending_.rows[cid] = {
    calls: 0, translated: 0, cached: 0,
    in: 0, out: 0, cacheRead: 0, cacheWrite: 0,
  });
  r.calls++;
  r.translated += translated || 0;
  r.cached += cachedHits || 0;
  r.in += usage.input_tokens || 0;
  r.out += usage.output_tokens || 0;
  r.cacheRead += usage.cache_read_input_tokens || 0;
  r.cacheWrite += usage.cache_creation_input_tokens || 0;
  pending_.n++;
}

function shouldFlush(env) {
  if (!pending_.n) return false;
  const cap = Number((env && env.DAILY_USD_CAP) || DAILY_USD_CAP_DEFAULT);
  // breakerCache 是熔斷每分鐘算一次的結果，這裡只是讀，不額外花成本。
  const near = cap > 0 && breakerCache.usd >= cap * STATS_TIGHT_AT;
  const n = near ? STATS_FLUSH_N_TIGHT : STATS_FLUSH_N;
  return pending_.n >= n || Date.now() - pending_.at > STATS_FLUSH_MS;
}

/** 落地統計。與 bundle 一樣是多寫入者，所以同樣要「重讀再合併」（坑 #24）。 */
async function flushStats(env) {
  // ⚠️ **只有 KV 寫入、沒有翻譯的時候也要落地**（2026-09-18）。
  //    以前這裡看到「沒有翻譯統計」就直接返回，於是 KV 計數永遠跟著一起被丟掉——
  //    全季收割那一夜寫了約 570 次 KV（上傳 + 稽核），後台與彙報卻顯示「—」。
  //    **最大量寫入的那幾天，正好是計量器看不到的那幾天。**
  if (!pending_.n && !kvOps.put && !kvOps.del) return;
  const mine = pending_.rows;
  const mineN = pending_.n;
  pending_ = { at: Date.now(), n: 0, rows: {} };
  // ⚠️ **有 AuthGuard 就交給它合併，不要在這裡「讀 KV → 加 → 整份寫回」。**（2026-10-26 R18 正賽實測，A11）
  //    請求分散在好幾個 isolate，每個都各自緩衝、各自讀→加→寫。KV 最終一致（別的機房最多約 60 秒才看到新值），
  //    兩個 isolate 前後腳讀到同一份舊值，後寫的就把先寫的那段蓋掉——鐵則 16 的老問題。
  //    實測：觀眾的累計從 1,317 倒退成 1,297（一段 −20）、B 的 `last` 停在 03:59 但 B 一直在翻。
  //    DO 一次只處理一個請求、storage 強一致，所以「加」放在 DO 裡做，KV 只當它寫出來的快照（讀取端不用改）。
  if (env.AUTH) return flushStatsViaGuard(env, mine, mineN);
  const key = statsKey();
  let day = {};
  try { day = JSON.parse((await env.SUBS.get(key)) || '{}'); } catch (e) { /* 壞掉重來 */ }
  for (const [cid, r] of Object.entries(mine)) {
    const d = day[cid] || (day[cid] = { calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
    for (const k of Object.keys(r)) d[k] = (d[k] || 0) + r[k];
  }

  // KV 用量搭同一次落地，**不額外寫一次**——否則量測本身就變成成本。
  // ⚠️ 用 `__kv` 這個不可能與 contentId 衝突的鍵；讀取端要記得排除它，
  //    不然後台會多出一支叫做「__kv」的影片。
  // ⚠️ **快照一定要在歸零之前取。** 寫失敗時要靠它把計數還回去；
  //    取在歸零之後的話它永遠是 0，還原那段程式碼看起來有做事、實際上什麼都沒還
  //    （2026-09-25 我自己第一版就是這樣寫的，測試只驗句數所以是綠的）。
  const kvMine = {
    put: kvOps.put + carry_.put, del: kvOps.del + carry_.del,
    get: kvOps.get + carry_.get, list: kvOps.list + carry_.list,
  };
  {
    const k = day.__kv || (day.__kv = { put: 0, del: 0, get: 0, list: 0 });
    // carry_ = 上一次落地自己做的那幾次，當時刻意沒有留在 kvOps 裡（見上面的說明）
    k.put += kvMine.put; k.del += kvMine.del;
    k.get += kvMine.get; k.list += kvMine.list;
    carry_ = { put: 0, del: 0, get: 0, list: 0 };
    kvOps = { put: 0, del: 0, get: 0, list: 0 };
  }
  // ⚠️ **寫失敗就要把資料放回去。**（2026-09-25 稽核發現，有實證）
  //    pending_ 是在寫入**之前**清空的（避免這段 await 期間的併發重複記帳），
  //    所以寫失敗時那一段就永遠消失了——而它代表的是**已經付過錢的模型呼叫**。
  //    9/24 撞到 KV 上限那天：stats 記 4,381 句、ustats 記 5,575 句，
  //    差的 1,194 句就是這樣掉的（ustats 沒掉純粹是因為它排在後面、根本沒被執行到）。
  //    後果是後台的成本永遠偏低，而「偏低」正好發生在花最多錢的那幾天。
  // ⚠️ **額度告警要在寫進去之前決定，旗標搭同一筆記錄。**（2026-09-25）
  //    9/24 撞到 KV 每日上限是事後跑腳本才看到的——每日彙報一天一次，
  //    撞牆當下沒有任何人知道，而那之後所有寫入都被丟棄（譯文進不了共用快取）。
  //    ⚠️ 旗標刻意存在 `day.__kv` 裡：**再開一個鍵去記「有沒有通知過」，
  //       等於為了警告額度快用完而多花額度**，那是最諷刺的失敗方式。
  //    ⚠️ 旗標是每日的（跟著 statsKey 換日自然重置），所以一天最多各響一次。
  const alerts = kvQuotaAlerts(day.__kv, kvDailyCap(env));

  try {
    await env.SUBS.put(key, JSON.stringify(day), { expirationTtl: 400 * 86400 });
    // 寫成功才通知。寫失敗時旗標沒落地，下一次會重新判斷——**不會漏報，只會晚報**。
    for (const [title, why] of alerts) {
      try {
        await notifyAdmin(env,
          `[PitLingo] KV 寫入額度 ${title}`,
          `今日 KV 寫入：${day.__kv.put} / ${kvDailyCap(env)}\n${why}\n\n`
          + '額度在台北時間早上 8 點（UTC 午夜）重算。\n'
          + '後台：https://pitlingo.com/secret-pitstop → 即時',
          // ⚠️ **一定要帶收件人。** notifyAdmin 沒有 to 就只會走 webhook，
          //    而 REPORT_WEBHOOK 從來沒設過——等於這個告警靜默不送（測試抓到的）。
          { to: env.REPORT_TO || 'pitlingo.office@gmail.com' });
      } catch (e2) { /* 通知失敗不影響落地本身 */ }
    }
  } catch (e) {
    // 併發可能已經在 pending_ 裡放了新東西，所以是**合併**回去，不是覆蓋。
    for (const [cid, r] of Object.entries(mine)) {
      const d = pending_.rows[cid] || (pending_.rows[cid] = {
        calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0,
      });
      for (const k of Object.keys(r)) d[k] = (d[k] || 0) + r[k];
    }
    pending_.n += mineN;
    // KV 計數同樣要還回去，否則「撞牆那天寫了幾次」這個數字自己也會缺一角
    carry_.put += kvMine.put; carry_.del += kvMine.del;
    carry_.get += kvMine.get; carry_.list += kvMine.list;
    throw e;
  }
  // 每位使用者的那份跟著同一次落地。**不要另外排一個時程**——
  // 兩份各自 flush 等於 KV 寫入翻倍，而那是這個專案的天花板。
  try { await flushUserStats(env); } catch (e) { /* 使用者統計失敗不影響成本熔斷 */ }
  // 上面這兩次寫入（以及過程中的讀取）要記帳，但**不可以變成「下一次還要再落地」的理由**。
  // 同一個 isolate 裡併發進來的請求可能也在這期間寫了東西，一起延到下一次記——
  // 晚一輪記帳不影響正確性，真正的活動另有 pending_.n 會把落地叫起來。
  carry_ = kvOps;
  kvOps = { put: 0, del: 0, get: 0, list: 0 };
}

const STAT_FIELDS = ['calls', 'translated', 'cached', 'in', 'out', 'cacheRead', 'cacheWrite'];
const emptyStatRow = () => ({ calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });

/** 把 src 的每支影片（或每個安裝）的計數加進 dst。使用者那份多帶 plan／last。 */
function mergeStatRows(dst, src, users) {
  for (const [id, r] of Object.entries(src || {})) {
    if (!r || typeof r !== 'object') continue;
    const d = dst[id] || (dst[id] = users ? Object.assign(emptyStatRow(), { plan: '', last: 0 }) : emptyStatRow());
    for (const k of STAT_FIELDS) d[k] = (d[k] || 0) + (Number(r[k]) || 0);
    if (users) { d.plan = r.plan || d.plan; d.last = Math.max(d.last || 0, Number(r.last) || 0); }
  }
}

/**
 * flushStats 的 DO 版本（A11）。這一輪的增量交給 AuthGuard `stats`，由它加進強一致的 storage，再把整份寫成 KV 快照。
 * 失敗（DO 連不上）就把增量原封不動放回緩衝，下一輪再送——**已經付過錢的呼叫不可以因為統計失敗就消失**（鐵則 48）。
 */
async function flushStatsViaGuard(env, mine, mineN) {
  const umine = upending_;
  upending_ = {};
  const kvMine = {
    put: kvOps.put + carry_.put, del: kvOps.del + carry_.del,
    get: kvOps.get + carry_.get, list: kvOps.list + carry_.list,
  };
  carry_ = { put: 0, del: 0, get: 0, list: 0 };
  kvOps = { put: 0, del: 0, get: 0, list: 0 };
  const r = await authCall(env, { op: 'stats', sk: statsKey(), uk: ustatsKey(), rows: mine, users: umine, kv: kvMine });
  if (!r || !r.ok) {
    mergeStatRows(pending_.rows, mine, false);
    pending_.n += mineN;
    mergeStatRows(upending_, umine, true);
    carry_.put += kvMine.put; carry_.del += kvMine.del;
    carry_.get += kvMine.get; carry_.list += kvMine.list;
    throw new Error('stats guard unavailable');
  }
  for (const [title, why] of (r.alerts || [])) {
    try {
      await notifyAdmin(env,
        `[PitLingo] KV 寫入額度 ${title}`,
        `今日 KV 寫入：${r.put} / ${kvDailyCap(env)}\n${why}\n\n`
        + '額度在台北時間早上 8 點（UTC 午夜）重算。\n'
        + '後台：https://pitlingo.com/secret-pitstop → 即時',
        { to: env.REPORT_TO || 'pitlingo.office@gmail.com' });
    } catch (e2) { /* 通知失敗不影響落地本身 */ }
  }
  // 這段 await 期間同一個 isolate 併發進來的 KV 操作，延到下一輪記帳（同上面的 carry_ 說明）
  carry_ = kvOps;
  kvOps = { put: 0, del: 0, get: 0, list: 0 };
}

/** KV 額度告警（flushStats 與 AuthGuard 共用）。旗標記在 k 本身，一天各響一次。 */
function kvQuotaAlerts(k, cap) {
  const alerts = [];
  const pct = cap ? (k.put / cap) : 0;
  if (pct >= 1 && !k.a100) {
    k.a100 = 1;
    alerts.push(kvPaid(cap)
      ? ['⚠️ 超過每日平均含量', '付費方案不會擋寫入，但照這個速度整個月會超過含量（超過每百萬次 $5）。先查是哪個前綴寫最多。']
      : ['❌ 已撞上限', '寫入正在被丟棄：譯文進不了共用快取，統計與稽核也記不到。']);
  }
  else if (pct >= 0.9 && !k.a90) { k.a90 = 1; alerts.push(['⚠️ 已用九成', kvPaid(cap) ? '快到每日平均含量。' : '照目前速度很快會撞上限。']); }
  else if (pct >= 0.7 && !k.a70) { k.a70 = 1; alerts.push(['⚠️ 已用七成', '若今天還有直播，先確認後台沒有分頁開著在輪詢。']); }
  return alerts;
}

// ⚠️ **讀取不可以觸發寫入。**（2026-09-24 實測，9/25 改成這個做法）
//    原本四個管理端點都是「讀之前先落地一次，數字才新」。而後台的「即時」分頁
//    每 15 秒自動更新一次（LV_TICK_MS，預設就是勾起來的）——
//    **光是把後台開著不動就是 4 次寫入／分鐘、一天 5,760 次**，上限 1,000 的 5.7 倍。
//    9/24 那天實測：沒有任何翻譯的十分鐘寫了 47 次。
//
//    先試過「讀取路徑最多每 60 秒落地一次」，但那還是 2 次／分鐘（stats + ustats），
//    外推一場正賽仍要 480 次。真正該問的是：**讀取為什麼需要寫？**
//    落地的唯一理由是「讓數字新一點」——那就把記憶體裡還沒落地的那一段
//    **疊在讀到的值上面顯示**（statsSummary 與 handleUserStats 各一處），一次也不用寫。
//
//    ⚠️ 疊的是**這個 isolate 的**未落地量，跨 isolate 的看不到。
//       但原本的「先落地再讀」也只落地自己這個 isolate，**精確度完全一樣**，
//       差別只在不再為了顯示而付出寫入的代價。

/**
 * 成本熔斷。
 *
 * 沒有這個的話，S6 的共用密鑰被濫用時，你會在帳單來的時候才知道。
 * 超過上限就停掉「會花錢的路徑」（/v1/translate），
 * **但共用快取的讀取照常** —— 已經翻好的影片仍然完全可用，
 * 使用者體驗只退化成「新影片暫時不翻」，不是整個壞掉。
 */
const DAILY_USD_CAP_DEFAULT = 5;

async function dailyCost(env) {
  let day = {};
  try { day = await readStatsDay(env, statsKey()); } catch (e) { /* noop */ }
  let usd = 0;
  for (const r of Object.values(day)) {
    usd += costOf({
      input_tokens: r.in, output_tokens: r.out,
      cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
    });
  }
  // 加上還沒落地的部分，否則熔斷會慢 15 分鐘
  for (const r of Object.values(pending_.rows)) {
    usd += costOf({
      input_tokens: r.in, output_tokens: r.out,
      cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
    });
  }
  return usd;
}

/**
 * 收割今天花了多少（ustats 的 'harvest' 那一列，加上這個 isolate 還沒落地的）。
 *
 * ⚠️ stats 是以影片分列、分不出誰翻的；ustats 以安裝分列，收割的安裝固定叫 'harvest'。
 *    兩份在同一次落地寫入（flushStats → flushUserStats），所以相減是一致的。
 */
async function harvestCost(env) {
  let day = {};
  try { day = await readStatsDay(env, ustatsKey()); } catch (e) { /* noop */ }
  let usd = 0;
  for (const r of [day.harvest, upending_.harvest]) {
    if (!r) continue;
    usd += costOf({
      input_tokens: r.in, output_tokens: r.out,
      cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
    });
  }
  return usd;
}

/**
 * 收割的每日成本上限（美元）。**與使用者的 DAILY_USD_CAP 分開算**（2026-10-11，管理版）：
 * userscript 直接打 Anthropic 時收割根本不經過熔斷；改成經過後端之後若共用一個上限，
 * 一個收割夜（全季補收可能好幾美元）就會讓當天的直播觀眾全部 E40。
 */
const HARVEST_USD_CAP_DEFAULT = 10;

let breakerCache = { at: 0, usd: 0, harvest: 0 };
async function overBudget(env, harvest) {
  const cap = harvest
    ? Number(env.HARVEST_USD_CAP || HARVEST_USD_CAP_DEFAULT)
    : Number(env.DAILY_USD_CAP || DAILY_USD_CAP_DEFAULT);
  if (!(cap > 0)) return false;
  if (Date.now() - breakerCache.at > 60000) {
    const total = await dailyCost(env);
    const h = await harvestCost(env);
    // usd＝使用者的部分（總額扣掉收割）。shouldFlush 也讀它——收割量大時不該讓落地變密
    breakerCache = { at: Date.now(), usd: Math.max(0, total - h), harvest: h };
  }
  return (harvest ? breakerCache.harvest : breakerCache.usd) >= cap;
}

/**
 * 譯文合理性檢查（SECURITY.md S9）。
 *
 * `/v1/translate` 的輸入直接進模型，攻擊者可以用 prompt injection 讓輸出
 * 受他控制，再寫進**他指定的 cid**——所有後續觀看者都會拿到被汙染的譯文。
 *
 * 完全防不了 injection，但可以讓「被汙染的東西進不了共用快取」：
 * 不合格的譯文仍然回傳給請求者（他自己愛看什麼是他的事），只是不寫回 bundle。
 */
const INJECTION_HINT = /ignore (all |the )?(previous|above)|system prompt|you are now|<\|.*?\|>|assistant:|忽略(上述|先前)|你現在是/i;

/**
 * 模型「跳出角色」的跡象。
 *
 * ⚠️ **實際發生過，而且直接顯示在使用者的畫面上**（2026-08-21 直播）：
 *    輸入「When were you first informed of Isaac Hadjar」——一個轉播畫面上的
 *    問句，而且人名拼法與模型記憶中的不同。模型於是切換成助理模式，
 *    輸出「我沒有收到任何關於 Isaac Hadjar 的資訊。（注：根據我的知識庫……
 *    請提供完整的轉播內容片段，我會直接翻譯。）」
 *
 *    SYSTEM_PROMPT 已經加了規則 2a/2b/2c 擋這件事，但**提示詞不是保證**。
 *    這裡是最後一道：寧可那一句沒有譯文（畫面空白），
 *    也絕不能把模型的自言自語當成字幕顯示給付費使用者看。
 */
//
// ⚠️ **這份規則有三份複本，必須一字不差**（backend／extension／userscript）。
//    對不起來的後果：某一邊擋掉、另一邊放行，同一句話在不同產物上表現不同，
//    而且不報錯。`node tools/check-guard.js` 會擋。
//
// ⚠️ **規則放寬過一次，是刻意的。** 原本有 `我(無法|不能|沒有收到)`，
//    那在 F1 轉播裡是**極常見的正常譯文**——「我無法相信」「我不能再推了」
//    都是車手無線電的日常。以前那條只擋「寫進共用快取」，誤判的代價是重翻一次；
//    現在它同時擋「顯示給使用者」，誤判的代價變成**那一句沒有中文字幕**。
//    代價變了門檻就要跟著變：留下的每一條都必須是轉播裡幾乎不可能出現的話。
//    `以下是`／`原文是` 同理，改成只有出現在句首才算。
const ROLE_BREAK = new RegExp([
  '[（(]\\s*[注註][：:]',
  '^[注註][：:]',
  '知識庫',
  '(作為|身為)\\s*(一個)?\\s*AI',
  '語言模型',
  '我(會|可以)[^。]{0,8}翻譯',
  '(無法|不便|不予)翻譯',
  '請提供[^。]{0,20}(原文|內容|片段|文字|字幕|句子)',
  '^(以下是|這是)[^。]{0,8}(翻譯|譯文)',
  '^(翻譯如下|譯文如下|中文翻譯如下)',
  // 2026-11-02 R19 正賽：拿到很短的片段（want／other／go）時，模型以為是對話開頭，回「我準備好了，請輸入…」。
  // 共用快取 30 萬句裡掃出 48 句，全部是這一類；下面每一條在那 30 萬句裡都沒有誤擋任何正常譯文。
  '我(已經|已)?準備好了?[。，,！!]?\\s*請',
  '請(直接)?(輸入|貼上)',
  '請提供[^。]{0,20}(翻譯|轉播|英文)',
  '需要翻譯的',
  '我需要你提供',
  '繁體中文',
  '翻譯器',
  '上述規則',
  '英文(轉播|原文|字幕|內容)',
  '轉播字幕',
  // SYSTEM_PROMPT 規則 6 要它輸出空字串，它把「空字串」「（空）」「（此行無內容）」寫出來。
  // 整句被括號包住的譯文在快取裡全部是這種旁白（「」不算，那是正常引號）。
  '空字串',
  '^[（(][^）)]*[）)]$',
  '^(空|無)$',
  // 正常的字幕沒有空行；快取裡帶空行的 16 句全部是模型在跟人說話。
  '\\n\\s*\\n',
].join('|'));

/**
 * 沒有中文的譯文，什麼時候仍然是對的。
 *
 * ⚠️ **這條規則是用線上 12 萬句實際譯文校準出來的，不要憑感覺改。**
 *
 *    原本只有一句「沒有中文就擋掉」，理由是「純英文回來代表模型照抄」。
 *    實測掃過全部 119 支影片、122,017 句之後發現：**被它擋下的 965 句裡，
 *    有 768 句是正確的譯文**——`hamilton → Hamilton`、`12 → 12`、
 *    `albert park → Albert Park`。我們自己的 SYSTEM_PROMPT 就規定
 *    人名、隊名、彎名、輪胎代號一律保留原文，所以**正確的譯文本來就沒有中文**。
 *
 *    這條規則以前只擋「寫進共用快取」，誤判不痛不癢；現在它同時擋「顯示」，
 *    誤判就是把字幕挖掉——而名字類的字幕在轉播裡非常多。
 *
 * 放行的條件（三選一）：
 *   1. 輸出的字母數字是來源的子集，且來源不超過 5 個詞（人名／隊名／數字）
 *   2. 同上但輸出帶中文標點（、，。）——那證明模型是刻意排版，不是照抄
 *   3. 來源很短且輸出很短（formula one → F1）
 *
 * 仍然擋下的（實測 197 句，逐句看過）：
 *   · 153 句只剩標點（`pitlane → 。`）——那是壞掉
 *   · 44 句是「整句只翻出一個名字」（`he had a great run in 99 → Eddie Irvine`）
 *     ——內容真的掉了，顯示英文原字幕比顯示半句好
 */
function latinEchoOk(en, t) {
  const a = String(en).toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!b) return false;                       // 只剩標點：壞掉了
  const words = String(en).trim().split(/\s+/).filter(Boolean).length;
  if (!a.includes(b)) return b.length <= 4 && words <= 3;
  return words <= 5 || /[、，。：；！？「」（）]/.test(t);
}

function plausibleTranslation(en, zh) {
  if (typeof zh !== 'string') return false;
  const t = zh.trim();
  if (!t) return false;
  // ⚠️ **長度上限收緊過。** 原本是 max(120, en × 3)，那對短句太寬鬆：
  //    44 字的英文可以配到 132 字的「譯文」，而上面那段自言自語是 116 字，
  //    **差 16 字就矇混過關**。中文本來就比英文密，正常譯文幾乎不會比原文長，
  //    ×2 已經非常寬裕。
  if (t.length > Math.max(60, en.length * 2)) return false;
  if (INJECTION_HINT.test(t)) return false;
  if (ROLE_BREAK.test(t)) return false;
  // 正常譯文一定有中文；純英文回來通常代表模型照抄或被帶偏
  // 沒有中文時，只有「來源本身就是人名／隊名／數字」才放行（見 latinEchoOk）
  if (!/[\u4e00-\u9fff]/.test(t) && !latinEchoOk(en, t)) return false;
  return true;
}

