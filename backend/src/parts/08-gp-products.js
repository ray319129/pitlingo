// ---------------------------------------------------------------------------
// Grand Prix 商品模型
// ---------------------------------------------------------------------------
/**
 * **一個 Grand Prix = 一個商品。**
 *
 * 商品本身不保存任何時間，只保存「綁到哪一場」（gpId）；
 * 效期一律由這裡依賽事資料**動態算**。這是使用者定的核心原則，
 * 理由很實際：賽程會變（延期、改時間、加減場次），
 * 若商品自己存了一份時間，改賽程之後**已售出的通行證會與賽事脫節**，
 * 而且不會有任何錯誤——只有使用者會發現「我買的那場看不到」。
 *
 * ⚠️ **比賽週的界線不是正賽，是「第一場賽事」。**
 *    區間定義成 [本場第一場賽事 − 暖身提前量, 下一場第一場賽事 − 暖身提前量)，
 *    這樣 23 個區間會**完美接合、不重疊也不留縫**：
 *    任何一個時間點都只屬於一個 GP，不會出現「兩張票都能看」或「都不能看」。
 */

/**
 * 暖身提前量。
 *
 * 比賽週的**星期四就有 warm-up 直播**（使用者確認過），而第一場正式賽事
 * 是星期五的自由練習。若區間直接切在第一場賽事，那場暖身會落到**上一站**
 * 的通行證裡——買了荷蘭的人看不到荷蘭的暖身，買了匈牙利的人反而看得到。
 * 往前挪一天就對齊了。
 *
 * ⚠️ 使用者最新的敘述是「有效至下一場第一場賽事開始前」，
 *    那會把下一場的暖身也包進來。這裡刻意保守一天，與先前
 *    「到下個比賽週的星期三」的決定一致。要改成 0 只需動這個常數，
 *    但改之前要知道那等於把下一站的暖身送出去。
 */
/** 目前的賽季年份。賽事資料沒帶 season 時用它補。 */
const SEASON_YEAR = 2026;

const WARMUP_LEAD_SEC = 86400;

/**
 * 把一組區間合併排序。相鄰（首尾相接）的要併成一段，
 * 否則「連續買三站」會變成三段，而使用者感受上那是一整段。
 */
function mergeWindows(list) {
  const a = (list || []).map((w) => [Number(w[0]), Number(w[1])])
    .filter((w) => w[0] < w[1]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const w of a) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push([w[0], w[1]]);
  }
  return out;
}

/**
 * 現在落在哪一段區間裡。回傳那一段，不在任何一段裡回 null。
 *
 * ⚠️ **這是「跳著買」能成立的關鍵。**
 *    使用者可以只買荷蘭與新加坡，中間那三站不該送給他。
 *    做法不是把區間塞進通行證簽章（那要改格式、會讓已發出的通行證全失效），
 *    而是利用「通行證最長只有 14 天、到期一定會回來續」這個既有性質：
 *    續期時**只簽到「現在這一段的結束」為止**，落在空檔就不簽。
 *    格式一行都不用改。
 */
function currentWindow(windows, from) {
  const now = Math.floor((from || Date.now()) / 1000);
  for (const w of windows || []) if (now >= w[0] && now < w[1]) return w;
  return null;
}

function nextWindow(windows, from) {
  const now = Math.floor((from || Date.now()) / 1000);
  return (windows || []).find((w) => w[0] > now) || null;
}

/**
 * 賽事資料的來源與同步時間。
 *
 * ⚠️ **同步失敗時要退回內建賽程，不可以讓商店沒有賽事。**
 *    外部來源壞掉（改格式、擋 IP、回空）時若直接套用，整個購買頁會空掉，
 *    而那看起來像我們倒了。寧可用舊賽程也不要沒有賽程。
 */
async function scheduleMeta(env) {
  try {
    const raw = JSON.parse((await env.SUBS.get(SCHED_KEY)) || "null");
    if (raw && Array.isArray(raw.races) && raw.races.length) {
      return { source: raw.source || "sync", at: raw.at || 0, races: raw.races };
    }
  } catch (e) { /* 壞掉就用內建的 */ }
  return { source: "built-in", at: 0, races: null };
}

const SCHED_KEY = "sched:current";

/** 賽事的穩定識別碼。跨賽季不重複，而且看得懂。 */
function gpId(g) {
  return `${g.season || SEASON_YEAR}-${String(g.r).padStart(2, '0')}`;
}

/** 依開始日排序過的賽事清單。 */
function gpList(cfg) {
  return scheduleList(cfg).slice()
    .sort((a, b) => dayStartSec(a.start) - dayStartSec(b.start));
}

function gpById(id, cfg) {
  return gpList(cfg).find((g) => gpId(g) === String(id)) || null;
}

/**
 * 這一場的第一場賽事是什麼時候（UTC 秒）。
 * 沒有場次資料時退回「開始日的 00:00 UTC」——**那一定早於任何實際場次**，
 * 所以區間只會偏保守（提早結束），不會把下一站送出去。
 */
function gpFirstSession(g) {
  const list = (g && Array.isArray(g.sessions)) ? g.sessions.filter((x) => x && x.t) : [];
  if (list.length) return Math.min(...list.map((x) => Number(x.t)));
  return dayStartSec(g.start);
}

/** 某個場次的時間（找不到回 null）。 */
function gpSession(g, kind) {
  const s = (g && Array.isArray(g.sessions)) ? g.sessions.find((x) => x && x.k === kind) : null;
  return s ? Number(s.t) : null;
}

/**
 * 正賽跑完之後，多久算「這一站真的結束了」。
 *
 * 正賽本身約兩小時，加上頒獎與賽後訪談。抓三小時是為了**寧可晚一點停售**
 * ——早停一分鐘就是把還在直播中的商品下架，那是實實在在的客訴；
 * 晚停三小時只是多賣了三小時的重播，沒有人因此受損。
 */
const RACE_TAIL_SEC = 3 * 3600;

/**
 * 這一站的「交棒時刻」：正賽結束之後。
 *
 * ⚠️ **沒有正賽資料時要回 null，不可以猜。** 猜錯的方向是「提早停售」，
 *    而那會讓一張還能用的通行證在購買頁上消失，沒有任何錯誤訊息。
 */
function gpHandoverSec(g) {
  const race = gpSession(g, 'race');
  if (race) return race + RACE_TAIL_SEC;
  // 季前測試沒有正賽：最後一天的測試結束就停售，開幕站提前生效接手（跟正賽跑完之後一樣）
  if (g && g.testing) {
    const ss = (Array.isArray(g.sessions) ? g.sessions : []).filter((x) => x && x.t);
    if (ss.length) return Math.max(...ss.map((x) => Number(x.t) + (Number(x.len) || TESTING_DAY_SEC)));
  }
  return null;
}

/** 季前測試一天的轉播長度（兩節各約 4 小時＋午休）。場次資料沒帶 len 時用。 */
const TESTING_DAY_SEC = 9.5 * 3600;

/**
 * 這一場的通行證區間 [from, until)。
 *
 * 最後一站沒有「下一場」，就給到正賽後七天——賽季結束後還要留時間看重播。
 *
 * ---------------------------------------------------------------------------
 * 賽後交棒（2026-09-16，使用者提出的問題）
 * ---------------------------------------------------------------------------
 * 原本的區間是完美接合的：某一站的通行證一直有效到**下一站開始前一天**。
 * 聽起來合理，實際上製造了一個很糟的購買體驗——
 *
 *   9/16 西班牙站的正賽已經跑完了，但購買頁上它還標著「進行中」而且賣得出去。
 *   這時候買下去，拿到的是一張**接下來不會有任何直播**的通行證：
 *   內容只剩重播，而下一站的暖身又已經落在下一張票裡。
 *   **使用者付了錢，卻買不到他以為自己買的東西。**
 *
 * 使用者的解法（採用）：
 *   · 正賽結束後就**停售**這一站
 *   · **已售出的效期完全不動**（仍然到下一站開始前一天）
 *   · 下一站的通行證**提前生效**，從這一刻接手
 *
 * 於是兩站之間的空檔歸下一站：現在買下一站，立刻就能看重播，
 * 而且接得上它自己的暖身。沒有任何人少拿到東西——
 * 已經買了這一站的人時間沒變，要買下一站的人反而多拿到一段。
 *
 * ⚠️ **這讓相鄰兩段刻意重疊**，從 `[handover(N), 原本的 from(N+1))` 這一段。
 *    舊的 `check-backend` 斷言「前一段的 until === 後一段的 from」現在會紅——
 *    那條斷言已經改寫成「不可以有空窗，而且重疊必須剛好等於交棒點」。
 *    **不要把它改回完美接合**，那會把這個修正整個退掉。
 *
 * ⚠️ **這裡不可以遞迴去呼叫 gpWindow(prev)。** 不需要：
 *    `until(prev)` 的定義就是 `gpFirstSession(g) − WARMUP_LEAD_SEC`，
 *    也就是下面的 `natural`。所以交棒點只跟 prev 的正賽時間有關，
 *    一次算完，不必往前追。
 */
function gpWindow(g, cfg) {
  if (!g) return null;
  const list = gpList(cfg);
  const i = list.findIndex((x) => gpId(x) === gpId(g));
  if (i < 0) return null;
  // 原本的生效時刻：自己的第一場賽事前一天（涵蓋比賽週四的暖身）
  const natural = gpFirstSession(g) - WARMUP_LEAD_SEC;
  const prev = list[i - 1];
  const handover = prev ? gpHandoverSec(prev) : null;
  // 上一站的正賽跑完之後，兩站之間的空檔就歸這一站。
  // ⚠️ 只會提前，不會延後——`handover` 比 `natural` 晚的話（賽程極度密集，
  //    或資料有問題）就維持原樣，否則會把自己的暖身推到區間外。
  const from = (handover !== null && handover < natural) ? handover : natural;
  const next = list[i + 1];
  const until = next
    ? gpFirstSession(next) - WARMUP_LEAD_SEC
    : (gpSession(g, 'race') || dayStartSec(g.end)) + 7 * 86400;
  return { from, until, next: next || null, prev: prev || null, natural, handover: gpHandoverSec(g) };
}

/**
 * 商品狀態。**由賽事時間自動判斷，沒有任何人工開關。**
 *
 *   upcoming  尚未生效（可購買；買了要等比賽週開始）
 *   open      已可立即使用，但比賽週還沒開始（可購買）——上一站交棒後的空檔
 *   live      比賽週進行中（可購買）
 *   replay    正賽已結束，**不再販售**；已購買的人仍然有效，可看重播
 *   finished  區間結束（不可購買，已購買的也失效）
 *
 * ⚠️ **`replay` 與 `finished` 是兩件事，不可以合併。**
 *    `replay` 的通行證還在生效中——設定頁、授權查詢、entitlement 都要照常放行。
 *    合併的話等於在正賽結束的那一刻讓所有人的通行證失效，
 *    而那是「使用者付了錢、東西被收回去」，是這整套設計裡最嚴重的那種錯。
 *
 * ⚠️ **判斷「能不能賣」一律用 `gpSellable()`，不要自己比對字串。**
 *    這裡每多一個狀態，散落各處的 `=== 'finished'` 就多漏一個地方，
 *    而漏掉的後果是「已經跑完的站還賣得出去」——正是這次要修的問題。
 */
function gpStatus(g, from, cfg) {
  const now = Math.floor((from || Date.now()) / 1000);
  const w = gpWindow(g, cfg);
  if (!w) return 'finished';
  if (now >= w.until) return 'finished';
  if (w.handover !== null && now >= w.handover) return 'replay';
  if (now >= w.natural) return 'live';
  if (now >= w.from) return 'open';
  return 'upcoming';
}

/** 這一站現在賣不賣得出去。**所有販售路徑都要走這個函式。** */
function gpSellable(g, from, cfg) {
  const st = gpStatus(g, from, cfg);
  return st !== 'finished' && st !== 'replay';
}

/** 不能賣的原因，給使用者看的一句話。**「為什麼」比「不行」有用。** */
function gpUnsellableReason(g, from, cfg) {
  const nm = (g && (g.label || `${g.name}大獎賽`)) || '該場次';
  const st = gpStatus(g, from, cfg);
  if (st === 'replay') {
    const w = gpWindow(g, cfg);
    const nx = w && w.next ? (w.next.label || `${w.next.name}大獎賽`) : null;
    return `${nm}${g && g.testing ? '' : '的正賽'}已經結束，不再販售`
      + (nx ? `——請改買${nx}通行證，它現在就能用（含這段期間的重播）。` : '。');
  }
  if (st === 'finished') return `${nm}已經結束，無法購買`;
  return null;
}

/**
 * F1TV 的節目（Weekend Warm-Up、賽前賽後節目）。賽程來源只有正式場次，節目時間從正式場次推算。
 * 偏移量取自 2026 美國站 F1TV 賽事頁的時程：Pre-Qualifying 04:25／排位 05:00／Post-Qualifying 06:10；
 * Pre-Race 02:50／正賽 04:00／Post-Race 06:00。Weekend Warm-Up＝FP1 前 16 小時
 * （PL-261023-WNZB：10/23 09:37 台灣時間貼著直播邊緣；只有一個數據點）。
 * ⚠️ 管理版的自動開直播（harvest.js）與 tools/autolive.ps1 都讀這裡，不要再各自寫一份。
 * ⚠️ 衝刺週末的節目（賽前賽後衝刺節目）名稱與時間還沒查，先不列。
 */
const GP_SHOWS = [
  { kind: 'warmup', label: 'Weekend Warm-Up', from: 'fp1', off: -16 * 3600, len: 2700 },
  { kind: 'preq', label: 'Pre-Qualifying Show', from: 'quali', off: -35 * 60, len: 2100 },
  { kind: 'postq', label: 'Post-Qualifying Show', from: 'quali', off: 70 * 60, len: 3600 },
  { kind: 'prer', label: 'Pre-Race Show', from: 'race', off: -70 * 60, len: 4200 },
  { kind: 'postr', label: 'Post-Race Show', from: 'race', off: 120 * 60, len: 3600 },
];
function gpShows(g) {
  // F1TV 賽事頁的真實時程優先（A4）。有任何一個節目就只用它——F1TV 沒列的節目就是沒有，不要用推算補
  const real = f1tvSched[gpId(g)];
  const shows = real && Array.isArray(real.items) ? real.items.filter((x) => F1TV_SHOW_LABEL[x.kind]) : [];
  if (shows.length) return shows.map((x) => ({ kind: x.kind, label: F1TV_SHOW_LABEL[x.kind], at: x.at, len: x.len, src: 'f1tv' }));
  const out = [];
  for (const d of GP_SHOWS) {
    const base = gpSession(g, d.from);
    if (base) out.push({ kind: d.kind, label: d.label, at: base + d.off, len: d.len });
  }
  return out;
}

/**
 * F1TV 賽事頁的真實時程（A4，2026-10-26）。
 * 管理版收割端每 12 小時讀一次 F1TV 賽事頁的內容 API（同源、帶它自己的登入），把每一場（含節目）的
 * 時間、contentId、播放網址送上來（POST /v1/admin/harvest/f1tv-schedule）。
 * 為什麼：GP_SHOWS 是用美國站推算的偏移量，R19 墨西哥的 Weekend Warm-Up 推算 10:30、F1TV 實際 04:30（台灣），
 * 照推算排程會整場漏掉；Pre-Qualifying 差 25 分、Post-Qualifying 差 50 分。
 * ⚠️ **正式場次的時間仍以官方賽程為準**——這裡只帶 cid／網址；兩邊對不上時回報（mismatch），不覆蓋。
 * ⚠️ 讀不寫：跟著 loadSchedule 每 5 分鐘最多讀一次 KV。寫入只發生在內容真的變了的時候（一站一週約 1～3 次）。
 */
const F1TV_SCHED_KEY = 'f1tvsched:v1';
let f1tvSched = {};          // gpId → { at, items: [{ kind, at, len, cid, href }] }
let f1tvSchedAt = 0;
const F1TV_SHOW_LABEL = {
  warmup: 'Weekend Warm-Up', pres: 'Pre-Sprint Show', posts: 'Post-Sprint Show',
  preq: 'Pre-Qualifying Show', postq: 'Post-Qualifying Show', prer: 'Pre-Race Show', postr: 'Post-Race Show',
};
const F1TV_SESSION_KINDS = ['fp1', 'fp2', 'fp3', 'sq', 'sprint', 'quali', 'race'];

async function loadF1tvSched(env) {
  if (Date.now() - f1tvSchedAt < 5 * 60000) return;
  f1tvSchedAt = Date.now();
  try {
    const raw = JSON.parse((await env.SUBS.get(F1TV_SCHED_KEY)) || 'null');
    f1tvSched = (raw && raw.gps && typeof raw.gps === 'object') ? raw.gps : {};
  } catch (e) { /* 讀不到就用推算的節目時間 */ }
}

/** 一場的 F1TV 連結（自動開直播直接開，不必在首頁上找）：kind → { cid, href } */
function gpF1tvLinks(g) {
  const real = f1tvSched[gpId(g)];
  const out = {};
  if (real && Array.isArray(real.items)) for (const x of real.items) out[x.kind] = { cid: x.cid, href: x.href };
  return out;
}

/**
 * 收割端送上來的時程，嚴格驗證（坑 #61：多了一個寫入者，就要問讀它的人還能不能信它）。
 * 收割權杖外洩時，最壞只能把這一站的節目時間改到這一站的週末範圍內、cid 改成另一支影片——
 * 所以：時間限在賽事日期前 3 天～後 2 天、網址必須是 /detail/<同一個 cid>/<slug>?action=play、
 * 一定要有正賽而且正賽時間與官方差不到 2 小時（擋「整份對錯站」）。
 */
function f1tvSchedClean(g, items) {
  const lo = dayStartSec(g.start) - 3 * 86400;
  const hi = dayStartSec(g.end) + 2 * 86400;
  const kinds = new Set(F1TV_SESSION_KINDS.concat(Object.keys(F1TV_SHOW_LABEL)));
  const out = [];
  const bad = [];
  const seen = new Set();
  for (const x of (Array.isArray(items) ? items : []).slice(0, 60)) {
    const kind = String((x && x.kind) || '');
    const at = Math.floor(Number(x && x.at));
    const end = Math.floor(Number(x && x.end));
    const cid = String((x && x.cid) || '');
    const href = String((x && x.href) || '');
    if (!kinds.has(kind) || seen.has(kind)) { bad.push(kind || '?'); continue; }
    if (!(at >= lo && at <= hi)) { bad.push(kind + ':time'); continue; }
    const len = end > at ? end - at : 3600;
    if (len < 600 || len > 5 * 3600) { bad.push(kind + ':len'); continue; }
    if (!/^\d{6,12}$/.test(cid) || !new RegExp('^/detail/' + cid + '/[a-z0-9-]{1,120}\\?action=play$').test(href)) { bad.push(kind + ':href'); continue; }
    seen.add(kind);
    out.push({ kind, at, len, cid, href });
  }
  const race = out.find((x) => x.kind === 'race');
  const off = gpSession(g, 'race');
  if (!race) return { error: '沒有正賽（可能讀到的不是這一站的賽事頁）', bad };
  if (off && Math.abs(race.at - off) > 2 * 3600) return { error: `正賽時間與官方差 ${Math.round((race.at - off) / 60)} 分鐘，整份拒絕`, bad };
  if (out.length < 3) return { error: '場次太少', bad };
  out.sort((a, b) => a.at - b.at);
  // 正式場次：F1TV 與官方賽程對不上的列出來（不覆蓋，給人看）
  const mismatch = [];
  for (const x of out) {
    if (!F1TV_SESSION_KINDS.includes(x.kind)) continue;
    const t = gpSession(g, x.kind);
    if (t && Math.abs(x.at - t) > 300) mismatch.push({ kind: x.kind, f1tv: x.at, official: t });
  }
  return { items: out, bad, mismatch };
}

async function f1tvSchedSave(env, id, items) {
  let raw = null;
  try { raw = JSON.parse((await env.SUBS.get(F1TV_SCHED_KEY)) || 'null'); } catch (e) { raw = null; }
  const gps = (raw && raw.gps && typeof raw.gps === 'object') ? raw.gps : {};
  const same = gps[id] && JSON.stringify(gps[id].items) === JSON.stringify(items);
  // 早就結束的站清掉（只留結束不到 14 天的），一份 KV 不會無限長大
  const keep = {};
  const now = nowSec();
  for (const g of gpList()) {
    const k = gpId(g);
    if (gps[k] && dayStartSec(g.end) + 14 * 86400 > now) keep[k] = gps[k];
  }
  if (same && Object.keys(keep).length === Object.keys(gps).length) return { changed: false };
  keep[id] = { at: same ? gps[id].at : now, items };
  await env.SUBS.put(F1TV_SCHED_KEY, JSON.stringify({ at: now, gps: keep }));
  f1tvSched = keep; f1tvSchedAt = Date.now();
  return { changed: !same };
}

/** 給購買頁與後台用的完整商品描述。 */
function gpProduct(g, from, cfg) {
  const w = gpWindow(g, cfg);
  const status = gpStatus(g, from, cfg);
  return {
    id: gpId(g),
    round: g.r,
    season: g.season || SEASON_YEAR,
    name: g.name,
    label: g.label || `${g.name}大獎賽`,
    country: g.country || g.name,
    flag: g.flag || '',
    circuit: g.circuit || '',
    tz: g.tz || 'UTC',
    startDate: g.start,
    endDate: g.end,
    sprint: !!g.sprint,
    tentative: !!g.tentative,
    // 場次時間是不是推估的。目前內建資料**全部是真實時間**（來自 f1calendar），
    // 所以這裡一律 false；保留這個欄位是因為日後若有新賽季尚未公布時刻表，
    // 仍然要能標示「待官方確認」而不是假裝知道。
    estimated: !!g.est,
    // len：季前測試一天約 9.5 小時，管理版與 autolive 要知道要開多久（一般場次沒有 len，用它們自己的表）
    sessions: (g.sessions || []).map((x) => (x.len ? { kind: x.k, label: x.n, at: Number(x.t), len: Number(x.len) } : { kind: x.k, label: x.n, at: Number(x.t) })),
    testing: !!g.testing,
    // 開幕站的前一項是季前測試：購買頁「上一站的正賽已經結束」要改說法
    afterTesting: !!(w && w.prev && w.prev.testing),
    // 管理版自動開直播用（2026-10-25）：F1TV 網址裡的站名（判斷節目連結是不是這一站的）與節目時間
    slugs: Array.isArray(g.slugs) ? g.slugs : [],
    shows: gpShows(g),
    // F1TV 的 contentId／播放網址（A4、A13：自動開直播直接開這一支，不靠在首頁上找連結）
    f1tv: gpF1tvLinks(g),
    firstSessionAt: gpFirstSession(g),
    qualiAt: gpSession(g, 'quali'),
    raceAt: gpSession(g, 'race'),
    validFrom: w ? w.from : null,
    validUntil: w ? w.until : null,
    // 比賽週「原本」的起點（自己的第一場賽事前一天）。與 validFrom 不同時，
    // 代表這一張是接了上一站的棒——購買頁要說得出「現在買立刻能用」。
    weekendFrom: w ? w.natural : null,
    // 停售時刻（正賽結束後）。前端拿它顯示倒數：**「還能買多久」比
    // 「還剩多久到期」更接近使用者真正要做的決定。**
    sellUntil: w ? w.handover : null,
    nextLabel: w && w.next ? (w.next.label || `${w.next.name}大獎賽`) : null,
    nextFirstSessionAt: w && w.next ? gpFirstSession(w.next) : null,
    status,
    purchasable: status !== 'finished' && status !== 'replay',
  };
}

/**
 * ⚠️ 舊的 weekWindow()（「購買起算 N 天」）已經**整個移除**。
 *
 *    通行證的效期一律走 gpWindow()——綁定賽事、動態計算。
 *    兩套區間算法並存本身就是漂移的來源：改了一邊忘了另一邊，
 *    而算出來的效期不一致完全不會報錯，只會讓某些人的通行證早幾天失效。
 *
 *    MIN_PASS_SEC（保底 72 小時）也一併移除：區間現在錨定賽程，
 *    最短的一段也有好幾天，那個保底不再有意義。
 */


function planExpiry(plan, from, cfg, count) {
  const p = PLANS[plan];
  if (!p) return null;
  // 本賽季免費體驗：到本賽季最後一站結束。賽程讀不到時回「已經到期」——null 是永久授權
  if (p.freeSeason) return seasonFinishSec(cfg) || Math.floor((from || Date.now()) / 1000) - 1;
  // ⚠️ **不含字幕授權的方案要回「已經到期」，不可以回 null。**
  //    null 在這裡的語意是「無期限」，回錯方向就是白送一張永久授權。
  if (p.noSubs) return Math.floor((from || Date.now()) / 1000) - 1;
  // 代訂方案本身也一樣。字幕使用權是靠附贈的 week_svc 給的，代訂方案自己
  //    **從來不該帶著任何期限**——它沒有 days／weekBound／untilSeasonEnd，
  //    若走到下面就會回 null＝永久授權。primary 的選法已經不會挑到它了，
  //    但這裡是最後一道：日後任何新路徑發錯方案，最壞的結果是「立刻過期」，
  //    而不是「白送一張永久授權」。**要壞就壞在安全的那一邊。**
  if (p.manual) return Math.floor((from || Date.now()) / 1000) - 1;
  // 賽季方案：季末改賣下一季，效期要跟著那一季走（見 seasonPriceNow）
  // 下一賽季通行證：效期到**下一季**結束，本季剩餘場次一併附贈（所以現在就能用）
  if (p.nextSeasonOnly) return nextSeasonEndSec(from);
  // 重播月票：30 天，但截在下一個比賽週開始前——不可以變成 99 元看開幕戰直播
  if (p.offSeasonOnly) {
    const base = Math.floor((from || Date.now()) / 1000) + p.days * 86400;
    const cap = nextGpStartSec(from, cfg);
    return cap && cap < base ? cap : base;
  }
  if (p.untilSeasonEnd) return seasonPriceNow(p.price, from, cfg).until;
  if (p.weekBound) {
    // ⚠️ **通行證的效期一律由賽事資料算**（gpWindow）。
    //    這裡是「沒有指定場次」時的退路：取接下來的第 count 場。
    //    正常路徑（購買頁、webhook）一定會帶 gpId，走不到這裡。
    const list = gpList(cfg);
    // ⚠️ **要挑「還賣得出去」的那一場，不是「區間還沒結束」的那一場。**
    //    正賽剛跑完的那一站區間還沒結束（重播期），若挑到它，
    //    這張退路發出來的通行證從第一秒就只剩重播——正是這次要修的毛病。
    const idx = list.findIndex((g) => gpSellable(g, from, cfg));
    if (idx < 0) return null;
    const g = list[Math.min(idx + Math.max(1, Number(count) || 1) - 1, list.length - 1)];
    const w = gpWindow(g, cfg);
    // 賽程讀不到就退回「購買後 7 天」，不要因為缺資料就發不出通行證
    if (w) return w.until;
    return Math.floor((from || Date.now()) / 1000) + (p.days || 7) * 86400;
  }
  if (p.days) return Math.floor((from || Date.now()) / 1000) + p.days * 86400;
  return null;
}

/**
 * 生效時間。比賽週通行證**購買當下就能用**，所以一律回 null（不設限）。
 * 保留這個函式是因為授權記錄有 `startsAt` 欄位，日後若有需要延後生效的
 * 方案（例如預購下一季）可以在這裡加，而 `licenseProblem` 已經會處理。
 */
function planStart(plan, from, cfg) {
  const p = PLANS[plan];
  // 下一賽季通行證（2026-10-30 Ray：「送重播權，2026賽季結束後立即生效」）：**本賽季最後一站結束才生效**。
  //    本賽季剩下的直播要另外買（比賽週或本賽季票）；最後一站結束之後買的立即生效（休賽期看得到本賽季的重播）。
  //    以前沒有生效時間＝付款就能用，等於把本賽季剩下的場次送掉，本賽季票在季末賣不出去
  if (p && p.nextSeasonOnly) {
    const fin = seasonFinishSec(cfg);
    const now = Math.floor((from || Date.now()) / 1000);
    return fin && fin > now ? fin : null;
  }
  return null;
}

/**
 * 本賽季什麼時候結束：最後一站（不含季前測試）的正賽結束後（gpHandoverSec，與停售同一個時刻）。
 * 下一賽季票的生效、本賽季票的停賣、重播月票的開賣都看這一刻。賽程是空的回 null。
 */
function seasonFinishSec(cfg) {
  const races = gpList(cfg).filter((g) => !g.testing);
  const last = races[races.length - 1];
  if (!last) return null;
  return gpHandoverSec(last) || dayStartSec(last.end) + 86400;
}

/**
 * 本賽季免費體驗（2026-11-03 Ray）：登入的帳號免費用到本賽季最後一站正賽結束 3 小時後
 * （seasonFinishSec，跟本賽季票停售同一刻）。期間比賽週與本賽季票停賣（planLock）。
 */
function freeSeasonActive(from, cfg) {
  return SEASON_YEAR === FREE_SEASON_YEAR && !seasonOver(from, cfg);
}

/**
 * 給這個帳號一份本賽季免費體驗的授權（已經有就回那一份）。活動沒開、帳號沒有信箱、AuthGuard 連不上 → null。
 * ⚠️ 一個帳號只發一份：「只做一次」是並發問題（鐵則 55），放 AuthGuard `once`，鍵是帳號的 sub。
 *    同時兩個請求時，搶輸的那個拿不到 key（回 null），由擴充功能下一次自動檢查接上——不會多發一份。
 * ⚠️ 授權記錄跟後台發的碼欄位一致（acct、email、索引），否則日後接不回帳號（資料模型契約）。
 */
async function ensureFreeSeasonLicense(env, acc) {
  if (!acc || !freeSeasonActive()) return null;
  const email = accountKey((acc.emails && acc.emails[0]) || acc.email || '');
  if (!email || !acc.sub) return null;
  const until = planExpiry('free_season');
  if (!(until > nowSec())) return null;
  const onceKey = 'freeseason:' + acc.sub;
  const once = await authCall(env, { op: 'once', k: onceKey, ttl: Math.max(86400, until - nowSec() + 86400) });
  if (!once) return null;
  if (!once.ok) return null;   // 已經發過（或另一個請求正在發）：pickAccountLicense 會挑到它
  let key = '';
  for (let i = 0; i < 5 && !key; i++) {
    const k = licenseKeyNew();
    if (!(await env.SUBS.get(licKey(k)))) key = k;
  }
  if (!key) { await authCall(env, { op: 'once', k: onceKey, release: true }); return null; }
  const lic = {
    plan: 'free_season',
    email, acct: email,
    orderId: '',
    expiresAt: until,
    startsAt: null,
    windows: null, gpIds: null, gpName: null, gpCount: null, nextLabel: null,
    paid: 0,
    items: [{ key: 'free_season', qty: 1, unit: 0 }],
    services: null,
    devices: [],
    createdAt: nowSec(),
    revoked: false,
    source: 'free_season',
  };
  try {
    await env.SUBS.put(licKey(key), JSON.stringify(lic));
    const ik = `licmail:${email}`;
    let arr = [];
    try { arr = JSON.parse((await env.SUBS.get(ik)) || '[]'); } catch (e) { arr = []; }
    if (!arr.includes(key)) arr.push(key);
    await env.SUBS.put(ik, JSON.stringify(arr));
  } catch (e) {
    await authCall(env, { op: 'once', k: onceKey, release: true });
    return null;
  }
  return key;
}

/** 本賽季跑完了沒有（賽程是空的也算）。 */
function seasonOver(from, cfg) {
  const fin = seasonFinishSec(cfg);
  return fin === null || Math.floor((from || Date.now()) / 1000) >= fin;
}

/**
 * 早鳥（2026-11-03 改寫）。
 *
 * ⚠️ **名額計在 AuthGuard 裡**（鍵 `B:early`）：DO 一次只處理一個請求，最後幾組同時結帳也不會超賣（鐵則 52、60）。
 *    以前是「數 KV 裡 plan=season_early 的授權碼」——結帳與付款之間沒有保留，兩個人同時刷卡都會看到還有名額；
 *    而且每次結帳都要把整個 `lic:` 前綴掃一遍。
 * 流程：結帳 hold（每帳號一席、EARLY_HOLD_SEC 後自動放掉）→ 付款通知 sell（hold 轉賣出）。
 */
function earlyTargetKey() {
  // 早鳥的內容＝這一張。換季前是下一賽季票，換季後是本賽季票；過了那一年就沒有早鳥了
  if (SEASON_YEAR < EARLY_YEAR) return 'season_next';
  if (SEASON_YEAR === EARLY_YEAR) return 'season';
  return null;
}

/** 早鳥截止：EARLY_YEAR 季前測試（賽程第 0 輪）的比賽週開始時。換季前 2027 的賽程還沒進來＝還沒截止，回 null。 */
function earlyDeadlineSec(cfg) {
  if (SEASON_YEAR !== EARLY_YEAR) return null;
  const list = gpList(cfg);
  const first = list.find((g) => g.testing) || list[0];
  const w = first ? gpWindow(first, cfg) : null;
  return w ? w.from : null;
}

/**
 * 早鳥現況。known=false＝AuthGuard 連不上（呼叫端要當成「不知道有沒有名額」：早鳥不賣、599 也先不開）。
 *   over     截止了（過了截止時間，或已經不是那一年）
 *   soldOut  付款完成的已滿 EARLY_LIMIT 組
 *   left     還能結帳的組數（扣掉結帳中保留的）
 *   open     早鳥還在賣（＝599 那張要鎖住）
 */
async function earlyState(env, from, cfg) {
  const now = Math.floor((from || Date.now()) / 1000);
  const deadline = earlyDeadlineSec(cfg);
  const over = !earlyTargetKey() || (deadline !== null && now >= deadline);
  // 完全沒有 AuthGuard 綁定（設定錯誤，或沒接 AuthGuard 的測試環境）：早鳥不賣、599 照常開——沒有計數器就不可能限量。
  //    綁定在、只是這一次連不上（known=false）則兩張都先鎖：那是暫時的，不要因為一次失敗就把 599 放出去
  if (!authStub(env)) return { known: true, disabled: true, over, soldOut: false, left: 0, sold: null, held: null, open: false, deadline };
  const r = await authCall(env, { op: 'early', act: 'count' });
  if (!r || !r.ok) return { known: false, over, soldOut: false, left: null, sold: null, held: null, open: !over, deadline };
  const sold = Number(r.sold) || 0; const held = Number(r.held) || 0;
  const soldOut = sold >= EARLY_LIMIT;
  return { known: true, over, soldOut, left: Math.max(0, EARLY_LIMIT - sold - held), sold, held, open: !over && !soldOut, deadline };
}

/** 結帳：保留一席。回 { ok } 或 { ok:false, reason: 'dup'（這個帳號買過）｜'full'｜'down'（AuthGuard 連不上）} */
async function earlyHold(env, orderNo, email) {
  const r = await authCall(env, { op: 'early', act: 'hold', id: String(orderNo), acct: accountKey(email), max: EARLY_LIMIT, ttl: EARLY_HOLD_SEC });
  return r || { ok: false, reason: 'down' };
}

/**
 * 付款完成／後台發碼：把這一席記成賣出。**同一個 id 重複呼叫是冪等的**（webhook 會重送）。
 * 失敗（名額滿、這個帳號買過、AuthGuard 連不上）回 false——呼叫端改發同內容的 earlyTargetKey()：
 * 付了錢的人拿到的東西完全一樣，只是不算進早鳥。寧可少賣一組也不要賣超。
 */
async function earlyClaim(env, id, email) {
  const r = await authCall(env, { op: 'early', act: 'sell', id: String(id), acct: accountKey(email), max: EARLY_LIMIT });
  return !!(r && r.ok);
}

/** 已賣出幾組（後台顯示用）。連不上回 0。 */
async function earlyIssued(env) {
  const r = await authCall(env, { op: 'early', act: 'count' });
  return r && r.ok ? Number(r.sold) || 0 : 0;
}

async function earlyRemaining(env) {
  const st = await earlyState(env);
  return st.left === null ? 0 : st.left;
}

function licenseKeyNew() {
  // 去掉容易看錯的 0/O/1/I/L，因為使用者要用手打
  const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(b).map((x) => AB[x % AB.length]).join('');
  return `PL${s}`;
}

function normLicense(k) {
  return String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function prettyLicense(k) {
  const n = normLicense(k).replace(/^PL/, '');
  return 'PL-' + (n.match(/.{1,4}/g) || []).join('-');
}

const licKey = (k) => `lic:${normLicense(k)}`;

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * 通行證（entitlement）：<installId>.<plan>.<exp>.<簽章>
 *
 * 用戶端存起來離線驗證。**後端不可用時只要還沒過期就繼續服務**——
 * 伺服器出問題是我們的錯，不該讓付費使用者看不到字幕。
 */
async function issueEntitlement(env, installId, plan, until) {
  const secret = tokenSecret(env);
  const exp = Math.min(until || 4102444800, nowSec() + ENTITLEMENT_DAYS * 86400);
  // 第四段是簽發時間（毫秒）。作廢清單只擋「作廢那一刻以前簽的」，見 entVoidRead／checkEntitlement
  const payload = `${installId}.${plan}.${exp}.${Date.now()}`;
  return { entitlement: `${payload}.${await hmac(secret, payload)}`, exp, plan };
}

/**
 * 驗證通行證。
 *
 * ⚠️ **這個驗證只能在伺服器做，用戶端做不到。**
 * 簽章是 HMAC，需要 TOKEN_SECRET，而那個絕不能發給用戶端。
 *
 * 所以分工是：
 *   用戶端  只讀通行證裡的 exp 判斷「還沒過期」，用來決定 UI 顯示什麼。
 *           **那是體驗，不是防護**——使用者當然可以自己塞一個假的進 storage。
 *   伺服器  在會花錢的端點（/v1/translate）實際驗簽。
 *           偽造的通行證拿不到翻譯，這才是真正的那道牆。
 *
 * 把防線放在伺服器而不是用戶端，也讓「後端掛掉時已付費的人照常能用」
 * 這件事成立——用戶端不會因為驗不了簽就把功能鎖起來。
 */
async function verifyEntitlement(env, ent) {
  const parts = String(ent || '').split('.');
  // 新格式多一段簽發時間（毫秒）；舊格式（4 段）照收，簽發時間當成 0——作廢時一定擋得到它
  if (parts.length !== 4 && parts.length !== 5) return { ok: false, reason: 'malformed' };
  const sig = parts.pop();
  const [installId, plan, expStr, iatStr] = parts;
  // 沒有密鑰時一律不認（security-audit run-2 加固）：以前會拿字串 "null" 當 HMAC 金鑰，誰都算得出來
  const secret = tokenSecret(env);
  if (!secret) return { ok: false, reason: 'server misconfigured' };
  const expect = await hmac(secret, parts.join('.'));
  if (!safeEqual(sig, expect)) return { ok: false, reason: 'bad signature' };
  if (Number(expStr) * 1000 < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, installId, plan, exp: Number(expStr), iat: Number(iatStr) || 0 };
}

async function readLicense(env, key) {
  const raw = await env.SUBS.get(licKey(key));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** 授權碼目前能不能用。回傳 null 代表可用，否則回傳要給使用者看的原因。 */
function licenseProblem(lic) {
  if (!lic) return { msg: '找不到這份授權。請登出再登入；仍然不行請到「聯絡我們」', status: 404 };
  // ⚠️ 換發過的舊碼同時帶 revoked（讓所有既有的「停用就跳過」邏輯——升級折抵、後台、帳號頁——
  //    自動把它排除），所以這一條一定要排在 revoked 前面，訊息才說得出「去哪裡拿新碼」。
  // 2026-10-30 起只有客服（後台）會換發；擁有者在擴充功能登出再登入，伺服器會從帳號挑到新的那份
  if (lic.replacedBy) return { msg: '這份授權已由客服重新設定：請在擴充功能登出再登入，授權就會恢復', status: 403, code: 'E78' };
  if (lic.revoked) return { msg: '這份授權已停用（退款或違規）。如有疑問請聯絡客服', status: 403 };
  if (lic.allGifted) return { msg: '這張通行證的比賽週都已轉送給別人了', status: 403 };
  if (lic.expiresAt && lic.expiresAt * 1000 < Date.now()) return { msg: '授權已過期，請續訂', status: 403 };

  // ⚠️ **比賽週通行證是「一段一段」的，不是一整條。**
  //    跳著買（只買荷蘭與新加坡）時，中間那幾站不該給他。
  //    落在空檔時要說清楚「下一段什麼時候開始」——只說「未生效」
  //    會讓人以為買錯了或系統壞了。
  if (Array.isArray(lic.windows) && lic.windows.length) {
    if (!currentWindow(lic.windows)) {
      const nx = nextWindow(lic.windows);
      if (!nx) return { msg: '這張通行證涵蓋的比賽週都已結束', status: 403 };
      const d = new Date(nx[0] * 1000);
      return {
        msg: `這張通行證涵蓋的下一個比賽週為 ${lic.gpName || ''}，`
          + `將於 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日起生效`,
        status: 403,
        notYet: true, startsAt: nx[0],
      };
    }
  }
  // Weekend Pass 提前買的情況。**要說出從哪一天開始能用**——
  // 只回「尚未生效」會讓人以為買錯了或系統壞了。
  // 下一賽季票（2026-10-30）：不是 Weekend Pass，也不是「該週星期四」——講方案名稱與台灣時間的生效日
  if (lic.startsAt && lic.startsAt * 1000 > Date.now() && PLANS[lic.plan] && PLANS[lic.plan].nextSeasonOnly) {
    const t = new Date((lic.startsAt + 8 * 3600) * 1000);
    return {
      msg: `這組${PLANS[lic.plan].label || '授權碼'}將於 ${t.getUTCMonth() + 1} 月 ${t.getUTCDate()} 日`
        + `（${SEASON_YEAR} 賽季最後一站結束後）起生效，屆時擴充功能會自動開通`,
      status: 403,
      notYet: true, startsAt: lic.startsAt,
    };
  }
  if (lic.startsAt && lic.startsAt * 1000 > Date.now()) {
    const d = new Date(lic.startsAt * 1000);
    const ymd = `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
    return {
      msg: `這張 Weekend Pass 涵蓋的是 ${lic.gpName || '下一場'} 大獎賽週末，`
        + `將於 ${ymd}（該週星期四）起生效`,
      status: 403,
      notYet: true, startsAt: lic.startsAt,
    };
  }
  return null;
}

/** 啟用：把授權碼綁到這個安裝，換回通行證。同一組碼可在任何裝置操作。 */
/**
 * 這張授權碼現在應該簽到什麼時候。
 *
 * ⚠️ **有比賽週區間時，只能簽到「現在這一段」的結束。**
 *    簽到最後一段的結束就等於把中間的空檔一起送出去，
 *    而通行證最長 14 天、到期一定會回來續，所以這樣切完全不影響體驗。
 */
function entitlementUntil(lic) {
  if (Array.isArray(lic.windows) && lic.windows.length) {
    const w = currentWindow(lic.windows);
    if (w) return w[1];
  }
  return lic.expiresAt;
}

// ---------------------------------------------------------------------------
// 以帳號為準（2026-10-30）
//
// 授權碼綁帳號之後（2026-10-04），「這個帳號能不能看」才是真正的問題，記住哪一組碼是用戶端的負擔：
// 一張訂單兩組碼、本賽季票到期換下一季票、換發後的新碼，以前都要使用者自己處理（或重新登入）。
// 現在啟用可以不帶碼（伺服器從帳號裡挑），續期時原本那組不能用了也由伺服器換到能用的那一組。
//
// ⚠️ 沒有多給任何權限：帳號擁有的碼本來就列在 /v1/account/me，登入的人本來就能逐一啟用。
//    這裡只是替他挑。擁有的定義與 licenseOwnerCheck 相同（授權記錄的 acct 在帳號的信箱清單裡），
//    **以授權記錄本身為準**，不信 licmail 索引（索引可能過期）。
// ⚠️ 續期換碼只給「原本就登記在那組碼底下」的裝置（wasHere）。被擁有者「解除」的裝置不在名單裡，
//    不可以靠續期自動登記到另一組——那會讓「解除」失效。
// ---------------------------------------------------------------------------

/** 帳號所有信箱底下的授權碼（去重、各信箱最多 50 組）。 */
async function accountLicenseKeys(env, acc) {
  const out = [];
  for (const em of (acc.emails || []).slice(0, 10)) {
    let keys = [];
    try { keys = JSON.parse((await env.SUBS.get(`licmail:${accountKey(em)}`)) || '[]'); } catch (e) { keys = []; }
    for (const k of (Array.isArray(keys) ? keys : []).slice(0, 50)) {
      const key = normLicense(k);
      if (key && !out.includes(key)) out.push(key);
    }
  }
  return out;
}

/**
 * 從帳號擁有的授權裡挑一組給這台裝置。回傳 { key, pending } 或 null。
 * 優先順序：現在就能用 → 還有裝置名額 → 指定的那組 → 這台已登記的 → 能用比較久的。
 * 全都還沒開始時回最早開始的那組（pending: true）。
 */
async function pickAccountLicense(env, acc, installId, preferKey) {
  const mine = (acc.emails || []).map((e) => accountKey(e));
  let best = null; let bestScore = null; let pend = null;
  for (const key of await accountLicenseKeys(env, acc)) {
    const lic = await readLicense(env, key);
    if (!lic) continue;
    const owner = accountKey(lic.acct || lic.email || '');
    if (!owner || !mine.includes(owner)) continue;
    const p = licenseProblem(lic);
    if (p && !p.notYet) continue;
    const devs = Array.isArray(lic.devices) ? lic.devices : [];
    const here = devs.some((d) => d.installId === installId);
    if (p) {
      const st = Number(p.startsAt) || 0;
      if (!pend || (key === preferKey) || (pend.key !== preferKey && st < pend.st)) pend = { key, st };
      continue;
    }
    const score = [(!here && devs.length >= MAX_DEVICES) ? 0 : 1, key === preferKey ? 1 : 0, here ? 1 : 0, Number(entitlementUntil(lic)) || 0];
    let better = !bestScore;
    for (let i = 0; !better && i < score.length; i++) {
      if (score[i] !== bestScore[i]) { better = score[i] > bestScore[i]; break; }
    }
    if (better) { best = key; bestScore = score; }
  }
  if (best) return { key: best, pending: false };
  return pend ? { key: pend.key, pending: true } : null;
}

/**
 * 決定這次要用哪一組碼。碼本身現在就能用 → 原樣；不能用（過期、停用、換發、還沒開始、不存在）
 * 或沒帶碼 → 看登入的帳號裡有沒有能用的另一組。
 *   onlyIfHere：續期用。只有原本登記在那組碼底下的裝置才換（見上面 wasHere）。
 */
async function resolveAccountKey(env, request, auth, key, onlyIfHere) {
  const lic = key ? await readLicense(env, key) : null;
  if (key && lic && !licenseProblem(lic)) return { key };
  if (onlyIfHere && !(lic && (lic.devices || []).some((d) => d.installId === auth.installId))) return { key };
  const sess = await sessionOf(env, request, true);
  const acc = sess ? await readGoogleAccount(env, sess.sub) : null;
  if (!acc) {
    if (key) return { key };
    return { error: json({ error: '請先在擴充功能登入購買時填寫的信箱，授權會自動啟用', code: 'E79', needLogin: true }, 403) };
  }
  let pick = await pickAccountLicense(env, acc, auth.installId, key);
  // 本賽季免費體驗：帳號裡沒有現在就能用的（沒有、或只有還沒開始的，例如 2027 早鳥）→ 發一份免費的
  if (!pick || pick.pending) {
    const fk = await ensureFreeSeasonLicense(env, acc);
    if (fk) pick = { key: fk, pending: false };
  }
  if (!pick) {
    if (key) return { key };
    return { error: err('這個帳號目前沒有可用的授權。購買後用同一個信箱登入即可；用別的信箱買的，請到 pitlingo.com「我的帳號」認領', 404, 'E89') };
  }
  // 指定的那組不能用、帳號裡也只有「還沒開始」的：維持指定的那組（行為與以前相同）
  if (key && pick.pending) return { key };
  return { key: pick.key };
}

async function handleLicenseActivate(request, env, auth) {
  const body = await request.json().catch(() => null);
  const given = normLicense(body && body.licenseKey);
  if (given && given.length < 8) return err('授權碼格式不正確');
  // 帶了碼＝使用者指定這一組（手動貼上），照原樣處理，不偷換成別組——換了他會看不懂發生什麼事。
  // 不帶碼＝登入後／每小時的自動檢查，由伺服器從帳號裡挑。
  if (given) return activateLicenseKey(request, env, auth, given);
  const r = await resolveAccountKey(env, request, auth, '', false);
  if (r.error) return r.error;
  return activateLicenseKey(request, env, auth, r.key);
}

/** 把這台裝置登記到某一組碼底下並簽通行證（啟用、以及續期換碼時用）。 */
async function activateLicenseKey(request, env, auth, key) {
  const readAt = Date.now();
  let lic = await readLicense(env, key);
  const bad = licenseProblem(lic);
  // ⚠️ 「還沒開始」（提前買的 Weekend Pass、跳著買的比賽週在空檔中）**照樣登記這台裝置**，
  //    只是不發通行證（2026-10-04 修）。以前直接拒絕——裝置沒登記，之後的續期一律
  //    「這台裝置尚未啟用」，比賽週開始時擴充功能不會自己恢復，除非使用者記得回來重新啟用。
  if (bad && !bad.notYet) return err(bad.msg, bad.status, bad.code);
  // 授權碼一定要配上「擁有它的帳號」（2026-10-04 起，見 licenseOwnerCheck）
  const own = await licenseOwnerCheck(env, request, lic);
  if (own.error) return own.error;

  const iid = auth.installId;
  // ⚠️ **寫回之前重讀一次，只改自己這一台**（security-audit run-2 #6）。以前拿上面那份快照
  //    （中間隔著帳號驗證的好幾次 await）整份寫回——後台在那幾百毫秒裡按的「停用」「退款」
  //    會被悄悄蓋回 revoked: false，之後續期照樣拿到付費通行證。
  //    KV 沒有 CAS，重讀只能把時間窗縮小；簽完通行證後還有第二道（licenseChangedSince）。
  const fresh = await readLicense(env, key);
  const bad2 = licenseProblem(fresh);
  if (bad2 && !bad2.notYet) return err(bad2.msg, bad2.status, bad2.code);
  lic = fresh;
  lic.devices = Array.isArray(lic.devices) ? lic.devices : [];
  const known = lic.devices.find((d) => d.installId === iid);
  let write = true;

  if (!known) {
    if (lic.devices.length >= MAX_DEVICES) {
      // **不要自動踢掉別台。** 使用者可能正在另一台看比賽，
      // 靜默踢掉會變成兩台互相把對方擠下線。讓他自己決定解除哪一台。
      return json({
        error: `已達裝置上限（${MAX_DEVICES} 台）。請先解除其中一台再啟用`,
        needsDeactivate: true,
        devices: lic.devices.map((d) => ({ id: d.installId.slice(0, 8), lastSeen: d.lastSeen })),
      }, 409);
    }
    // sub：是哪個帳號啟用的。「登出所有裝置」靠它找出這個帳號底下要一起停掉的裝置。
    lic.devices.push({ installId: iid, addedAt: nowSec(), lastSeen: nowSec(), sub: own.acc.sub });
  } else if (nowSec() - (Number(known.lastSeen) || 0) > 6 * 3600 || known.sub !== own.acc.sub) {
    known.lastSeen = nowSec();
    known.sub = own.acc.sub;
  } else {
    // 已登記、最近見過、同一個帳號：沒有任何東西要改，不寫 KV（與續期同一條規則）
    write = false;
  }

  if (write) {
    // ⚠️ 每組授權碼每天的寫入上限（security-audit run-2 #5）。以前只以 installId 計，
    //    而 installId 可以無限重新領——「註冊→啟用→自己停用」一直循環就能燒光全站的 KV 寫入。
    if (!(await kvWriteBudgetOk(env, 'activatelic', key))) return err('這份授權今天啟用太多次，請明天再試', 429, 'E32');
    await env.SUBS.put(licKey(key), JSON.stringify(lic));
  }

  // （2026-10-05 起不必再清：作廢只擋「作廢那一刻以前簽的」，下面新簽的這張自然通過。
  //   以前在這裡清作廢紀錄——任何一組自己的授權碼啟用就會讓別組被作廢的通行證復活。）
  // ⚠️ **舊註解保留作為紀錄：啟用一定要把作廢紀錄清掉。**
  //    作廢清單是以 installId 為鍵的，不是以通行證為鍵。所以「清空裝置後
  //    請使用者重新啟用」這條最常見的客服流程會變成：重新啟用成功、
  //    拿到新的通行證，但這個 installId 還在作廢清單裡 → 伺服器照樣擋。
  //    畫面顯示已啟用、實際不能用，而且完全不報錯——付費使用者直接壞掉。
  if (bad && bad.notYet) {
    return json({
      ok: true, pending: true, message: bad.msg, startsAt: bad.startsAt || null,
      licenseKey: prettyLicense(key),
      plan: lic.plan || 'season', planLabel: (PLANS[lic.plan] || {}).label || lic.plan,
      gpName: lic.gpName || null, devices: lic.devices.length,
    });
  }

  // ⚠️ 有比賽週區間時只能簽到「現在這一段」的結束，見 entitlementUntil
  const ent = await issueEntitlement(env, iid, lic.plan || 'season', entitlementUntil(lic));
  if (await licenseChangedSince(env, key, iid, readAt)) return err('授權狀態剛剛變更了，請重新整理後再試', 409, 'E22');
  // 涵蓋的站名要一起回。買 3 站的人在擴充功能裡只看到一個日期時，
  // 根本分不出自己買的是 1 站還是 3 站——那是他付過錢的東西。
  return json({
    ok: true, plan: lic.plan || 'season',
    // 實際用的是哪一組（可能是伺服器從帳號裡挑的）。擴充功能記住它，下次續期用
    licenseKey: prettyLicense(key),
    windows: lic.windows || null,
    gpIds: lic.gpIds || null,
    giftGpIds: lic.giftGpIds || null,
    nextLabel: lic.nextLabel || null,
    // ⚠️ **方案名稱由伺服器給，用戶端不要自己維護一份對照表。**
    //    options.js 曾經寫死過，於是加了 week／season_next／week_svc 之後，
    //    使用者的設定頁直接顯示英文鍵名（"week"），而且完全不報錯。
    planLabel: (PLANS[lic.plan] || {}).label || lic.plan,
    expiresAt: lic.expiresAt,
    gpName: lic.gpName || null, gpCount: lic.gpCount || null,
    devices: lic.devices.length, ...ent,
  });
}

/**
 * 解除裝置（只憑授權碼，擴充功能的「管理裝置」）。換電腦、賣掉舊電腦、或撞到上限時自己處理。
 *
 * @param caller  呼叫者的安裝（authClient 的結果，可能是 null）。解除**自己這一台**不計次數。
 */
async function handleLicenseDeactivate(request, env, caller) {
  const body = await request.json().catch(() => null);
  const key = normLicense(body && body.licenseKey);
  const target = String((body && body.installId) || '').trim();
  if (!key || !target) return err('需要 licenseKey 與 installId');

  const lic = await readLicense(env, key);
  if (!lic) return err('查無此授權碼', 404);
  if (lic.replacedBy) return err(licenseProblem(lic).msg, 403, 'E78');
  const own = !!(caller && caller.ok && !caller.legacy && caller.installId === target);
  // 只能解除**自己這一台**（2026-10-30 起）。別台一律到登入後的「我的帳號」——
  // 以前「只憑授權碼解除別台」30 天 3 次（E76，代碼保留不再使用），拿到碼的人就能踢擁有者。
  if (!own) return err('解除其他裝置請登入 pitlingo.com「我的帳號」管理', 403, 'E90');
  // 解除自己這一台有每日寫入上限（security-audit run-2 #5：和啟用一起循環就能無限寫 KV）
  return removeDevices(env, key, lic, target, async () =>
    ((await kvWriteBudgetOk(env, 'deactself', key)) ? null : err('操作太頻繁，請明天再試', 429, 'E32')));
}

/**
 * 把裝置從授權碼底下移除，**並讓它手上的通行證立刻失效**。
 *
 * ⚠️ 只從名單拿掉是不夠的（2026-10-04 修）：通行證是簽出去的獨立憑證、最長 14 天，
 *    續期時才會發現「這台不在名單上」。被踢掉的人（例如偷到授權碼的人）在那之前照樣能看。
 *    與 clearDevices／停用／刪除同一套作法：寫進 entvoid。
 *    那台之後如果又用授權碼啟用回來，handleLicenseActivate 會把它從 entvoid 拿掉。
 *
 * @param gate  確認有那一台之後、真的移除之前呼叫；回傳 Response 就中止（計次用）。
 */
async function removeDevices(env, key, lic, target, gate) {
  // 允許用前 8 碼指認（畫面上只看得到那幾碼）。⚠️ 少於 8 碼一律拒絕：
  //    以前沒有下限，送一個字元就會把開頭相同的所有裝置一次清掉。
  if (target.length < 8) return err('裝置編號至少要 8 碼');
  const devs = Array.isArray(lic.devices) ? lic.devices : [];
  const hit = devs.filter((d) => d.installId === target || d.installId.startsWith(target));
  if (!hit.length) return err('這份授權底下沒有這台裝置（可能已經解除了）', 404);
  if (gate) {
    const stop = await gate();
    if (stop) return stop;
  }
  lic.devices = devs.filter((d) => !hit.includes(d));
  await env.SUBS.put(licKey(key), JSON.stringify(lic));
  await voidEntitlements(env, hit.map((d) => d.installId));
  return json({ ok: true, removed: hit.length, remaining: lic.devices.length });
}

/** 續期。**呼叫失敗不影響現有通行證**，過期前都還能用。 */
async function handleLicenseRenew(request, env, auth) {
  const body = await request.json().catch(() => null);
  const given = normLicense(body && body.licenseKey);
  // 原本那組不能用了（本賽季票到期、退款、換發）→ 換成帳號裡能用的那一組，走啟用（登記這台）
  const r = await resolveAccountKey(env, request, auth, given, true);
  if (r.error) return r.error;
  if (r.key !== given) return activateLicenseKey(request, env, auth, r.key);
  const key = given;
  const readAt = Date.now();
  const lic = await readLicense(env, key);
  const bad = licenseProblem(lic);
  if (bad) return err(bad.msg, bad.status, bad.code);
  // ⚠️ 續期也要驗帳號——不驗的話「綁帳號」只在啟用那一刻成立：外流的碼一旦被啟用，
  //    對方登出、帳號被「登出所有裝置」之後照樣每天續下去。
  const own = await licenseOwnerCheck(env, request, lic);
  if (own.error) return own.error;

  const d = (lic.devices || []).find((x) => x.installId === auth.installId);
  if (!d) return err('這台裝置尚未啟用此授權', 403);
  // ⚠️ 每天只寫一次 KV（鐵則 10）。以前每次續期都寫，「打開設定頁就強制續一次」會讓它更頻繁。
  if (nowSec() - (Number(d.lastSeen) || 0) > 6 * 3600 || d.sub !== own.acc.sub) {
    // ⚠️ 寫回前重讀、只改自己這一台（security-audit run-2 #6／#13）：拿上面的快照整份寫回，
    //    會把這段時間裡的撤銷、退款、「登出所有裝置」清掉的裝置名單一起蓋回去。
    const fresh = await readLicense(env, key);
    const fd = fresh && !licenseProblem(fresh) && (fresh.devices || []).find((x) => x.installId === auth.installId);
    if (!fd) return err('這台裝置尚未啟用此授權', 403);
    fd.lastSeen = nowSec();
    fd.sub = own.acc.sub;
    await env.SUBS.put(licKey(key), JSON.stringify(fresh));
  }
  // 擴充功能的登入權杖 30 天到期。授權現在依賴它，到期就等於授權停掉——
  // 所以續期時順便換一枚新的（超過 7 天才換），每天都在用的人不必常常重新登入。
  // 舊的那枚不撤銷：回應若在路上丟了，擴充功能手上那枚仍然能用。
  // ⚠️ 新的那枚和舊的同一個家族（sessionFamily）：登出時一起撤銷，整個家族最長 SESSION_X_MAX_DAYS 天。
  let accountToken = null;
  let succ = null;
  if (own.sess.kind === 'x' && nowSec() - own.sess.iat > 7 * 86400) {
    // 簽給帳號的主 sub（合併過的舊 sub 別名只活 30 天）
    succ = await issueSession(env, own.acc.sub || own.sess.sub, 'x', { fam: own.sess.fam, root: own.sess.root });
    accountToken = succ.token;
  }
  const ent = await issueEntitlement(env, auth.installId, lic.plan || 'season', entitlementUntil(lic));
  // ⚠️ **慢的步驟做完之後再確認一次**（security-audit run-2 #10、#13）。這個請求在途中的
  //    那幾百毫秒裡，後台可能剛撤銷／退款，擁有者可能剛按「登出所有裝置」——
  //    那些動作只擋得到「那一刻以前」簽的東西，而上面兩樣是在那之後才簽的。
  const stillIn = await sessionOf(env, request, true);
  const changed = await licenseChangedSince(env, key, auth.installId, readAt);
  if (!stillIn || changed) {
    if (succ) await authCall(env, { op: 'revoke', sid: succ.sid, exp: succ.exp });
    return !stillIn
      ? json({ error: '登入已失效，請重新登入', code: 'E79', needLogin: true }, 403)
      : err('授權狀態剛剛變更了，請重新整理', 409, 'E22');
  }
  return json({
    ...(accountToken ? { accountToken } : {}),
    ok: true,
    plan: lic.plan || 'season',
    planLabel: (PLANS[lic.plan] || {}).label || lic.plan,
    gpName: lic.gpName || null, gpCount: lic.gpCount || null,
    windows: lic.windows || null, nextLabel: lic.nextLabel || null,
    licenseKey: prettyLicense(key),
    // 設定頁的「有效期至」靠它更新（後台延期、賽程異動）。以前只有啟用時回。
    expiresAt: lic.expiresAt || null,
    ...ent,
  });
}

/**
 * 從 readAt 那一刻到現在，這組授權對這台裝置來說有沒有變：被停用／換發／過期、
 * 這台被移出名單、或這台的通行證在那之後被作廢。有變就要丟掉剛簽的通行證。
 * ⚠️ 作廢清單讀**不經快取**的那份（entVoidRead），60 秒的快取正好會錯過剛剛的作廢。
 */
async function licenseChangedSince(env, key, installId, readAt) {
  const now = await readLicense(env, key);
  const p = licenseProblem(now);
  if (p && !p.notYet) return true;
  if (!(now.devices || []).some((x) => x.installId === installId)) return true;
  const { set } = await entVoidRead(env);
  const vt = set.at ? (set.at.get(installId) || 0) : 0;
  return vt >= readAt;
}

/** 列出這組授權碼底下的裝置。純查詢，不會改動任何東西。 */
