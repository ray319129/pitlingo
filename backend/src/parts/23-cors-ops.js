// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
/**
 * 網站自己的來源。**只開這幾個，不開 `*`。**
 *
 * ⚠️ 上面 `CORS` 的註解說「我們根本不需要 CORS」——那句話在當時是對的，
 *    因為只有擴充功能（service worker + host_permissions）與 userscript
 *    （GM_xmlhttpRequest）在打 API，兩者都不受 CORS 限制。
 *
 *    但 **`pitlingo.com/buy` 是一般的瀏覽器頁面**，它的 fetch 一定受 CORS 管。
 *    購買頁改成向後端要價格之後，這個「不需要 CORS」的前提就不成立了，
 *    症狀是使用者按下結帳看到 `Failed to fetch`，而 Console 才有真正的原因。
 *
 *    這是坑 #13 的又一次：**在某個檔案（或某個時期）成立的規則，
 *    要主動確認它在新的使用情境下還成不成立。**
 *
 *    開放範圍刻意只到「我們自己的網站 + 我們自己需要的端點」，
 *    不回到 `*`——那會把原本消除掉的攻擊面整個放回來。
 */
const SITE_ORIGINS = new Set([
  'https://pitlingo.com',
  'https://www.pitlingo.com',
]);

// 購買頁與客服頁實際會打的端點。沒列在這裡的一律維持「不開 CORS」。
const SITE_PATHS = new Set([
  '/v1/plans', '/v1/quote', '/v1/checkout', '/v1/contact', '/v1/order',
  // 帳號頁。⚠️ **只開帳號頁真的會打的那幾支**——CORS 是「哪個網站可以代表使用者呼叫我們」，
  //    多開一個就是多一個可以被別的頁面利用的入口。
  '/v1/auth/google', '/v1/account/me', '/v1/account/claim', '/v1/account/claim/verify',
  '/v1/account/license/deactivate', '/v1/account/license/reissue', '/v1/account/license/gift', '/v1/account/f1/reveal',
  '/v1/auth/email/start', '/v1/auth/email/verify', '/v1/auth/link/claim', '/v1/auth/logout',
  // 網站內容（公開唯讀）。寫入走 /v1/admin/site，不在這裡。
  '/v1/site',
]);

/**
 * 可由後台修改的營運設定。**存在 KV，不用重新部署就能改。**
 *
 * 使用者的要求：「整個網站我要能夠自訂」。目前開放這些——
 * 都是會隨營運調整、而每次調整都要我改程式碼重新部署的東西：
 *
 *   prices        各方案價格（覆寫程式碼裡的預設）
 *   earlyLimit    早鳥限量組數
 *   hidden        要下架的方案（不刪除，只是不顯示也不能買）
 *   choosePayment 綠界的付款方式（見 `ecpayPayment` 的說明）
 *   notice        購買頁最上方的公告，空字串就不顯示
 *
 * ⚠️ **覆寫只接受「已知的方案鍵」與合理範圍的數字。**
 *    後台被誤操作或貼錯 JSON 時，最糟只是某個價格沒被覆寫，
 *    不會變成 0 元或負數——那種錯誤會直接變成金錢損失。
 */
/**
 * 把影片的網址後綴（slug）對回賽程的某一站。
 *
 * 為什麼需要英文關鍵字：賽程的 `name` 是中文（「荷蘭」），而 F1TV 的 slug
 * 是英文（`2026-dutch-grand-prix`）——直接比對永遠對不上。
 *
 * ⚠️ **關鍵字現在長在每一站的資料上（`g.slugs`），不是另一張以輪次為鍵的表。**
 *    舊版是 `GP_SLUG_HINTS[g.r]`，有兩個問題，而且都不會報錯：
 *      1. 換賽季只要輪次順序一改，整張表就全錯
 *      2. 賽程可以從 SCHEDULE_URL 同步，那張表卻不會跟著同步
 *    放進賽事記錄之後，同步進來的賽程自己帶關鍵字；沒帶的就退回用
 *    `circuit` 推導——對不準總比整季歸不了類好。
 */
function gpSlugHints(g) {
  if (g && Array.isArray(g.slugs) && g.slugs.length) {
    return g.slugs.map((s) => String(s || '').toLowerCase().trim()).filter(Boolean);
  }
  const c = String((g && g.circuit) || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return c ? [c] : [];
}

/**
 * slug 的比對用形式：只取最後一段、非英數一律換成連字號，前後各補一個。
 *
 * ⚠️ **前後補連字號不是為了好看，是為了讓關鍵字以「整個詞」比對。**
 *    實際踩過（2026-09-14 從線上資料查出來）：比利時的關鍵字 `spa`
 *    用 `includes` 會命中 `2025-spanish-grand-prix`，而 R10 排在 R14 前面，
 *    於是**西班牙站的所有影片都被歸進比利時**，後台看起來完全正常。
 *    諷刺的是舊版註解就寫著「用 `usa` 會誤中 `usual`」，然後下面第十行
 *    做了一模一樣的事。補上連字號之後 `-spa-` 不在 `-spanish-` 裡面。
 */
function slugKeyOf(slug) {
  const last = String(slug || '').toLowerCase().split('/').filter(Boolean).pop() || '';
  return '-' + last.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-';
}

function slugMatchesGp(slugKey, g) {
  return gpSlugHints(g).some((kw) => slugKey.includes('-' + kw + '-'));
}

/**
 * 從 slug 推出「這是哪一種場次」的中文名稱。
 *
 * ⚠️ **標題不需要向 F1TV 要。** slug 本身就是標題，而且用戶端每一次請求
 *    都已經送上來了。線上 110 支有 slug 的影片只有 44 種形態、完全規則，
 *    所以這裡是純字串處理：沒有外部請求、沒有 Imperva 風險、不會失敗。
 *
 * ⚠️ 順序有意義：`sprint-qualifying` 要排在 `qualifying` 前面，
 *    否則衝刺排位賽會被認成排位賽（`freeTier` 的註解也踩過同一件事）。
 */
const SESSION_RULES = [
  [/-sprint-qualifying-/, '衝刺排位賽'],
  [/-sprint-/, '衝刺賽'],
  [/-qualifying-/, '排位賽'],
  [/-practice-1-/, '第一次自由練習'],
  [/-practice-2-/, '第二次自由練習'],
  [/-practice-3-/, '第三次自由練習'],
  [/-practice-/, '自由練習'],
  [/-feature-race-/, '主賽'],
  [/-opening-race-/, '開幕賽'],
  [/-reverse-grid-race-/, '倒轉發車順序賽'],
  [/-race-1-/, '第一回合'],
  [/-race-2-/, '第二回合'],
  [/-grand-prix-/, '正賽'],
  [/-race-/, '正賽'],
  [/-highlights-/, '精華'],
];

/** 支援賽事的系列名。翻譯價值低但仍會被觀看，分得出來才知道快取花在哪。 */
const SERIES_RULES = [
  [/-psc-/, '保時捷超級盃'],
  [/-f1a-/, 'F1 Academy'],
  [/-f2-/, 'F2'],
  [/-f3-/, 'F3'],
  [/-f1-kids-|-kids-/, 'F1 Kids'],
];

function sessionTitle(slug, season) {
  const k = slugKeyOf(slug);
  if (!k || k === '--') return '';

  // 測試編號可能沒有（一季只測一次時）：2027-pre-season-testing-day-1
  const t = /-pre-season-testing-(?:(\d+)-)?day-(\d+)(?:-session-(\d+))?-/.exec(k);
  if (t) return `季前測試${t[1] ? ' ' + t[1] : ''}・第 ${t[2]} 天` + (t[3] ? `・第 ${t[3]} 節` : '');
  if (k.includes('-weekend-warm-up-')) return '賽前暖身';
  if (k.includes('-press-conference-')) return '記者會';
  // 節目與精華：不可以落到下面的場次規則（它們含 -qualifying-、-sprint-、-race-）
  const show = /-(pre|post)-(sprint-qualifying|qualifying|sprint|race)-show-/.exec(k);
  if (show) {
    const what = { 'sprint-qualifying': '衝刺排位賽', qualifying: '排位賽', sprint: '衝刺賽', race: '正賽' }[show[2]];
    return `${what}${show[1] === 'pre' ? '賽前' : '賽後'}節目`;
  }
  if (k.includes('-highlights-')) return '精華';
  if (/-race-in-30-/.test(k)) return '30 分鐘精華';

  const series = (SERIES_RULES.find(([re]) => re.test(k)) || [])[1] || '';
  const kind = (SESSION_RULES.find(([re]) => re.test(k)) || [])[1] || '';
  if (!series && !kind) return '';

  // 舊賽季的重播要標出來，否則後台會以為今年多翻了一堆。
  const y = (/-((?:19|20)\d{2})-/.exec(k) || [])[1];
  const old = y && season && Number(y) !== Number(season) ? `${y} ` : '';
  return old + [series, kind].filter(Boolean).join('・');
}

/**
 * 場次代碼。與賽程裡的 `sessions[].k` 同一套字彙，覆蓋率才對得起來。
 *
 * ⚠️ 與 `sessionTitle` 分開是刻意的：賽程把衝刺賽週的唯一一場練習叫
 *    「唯一自由練習」，而 slug 一律是 `practice-1`——**用中文名去比對會漏**。
 *
 * ⚠️ 舊賽季的重播與支援賽事都回空字串。它們是有價值的快取，但**不算
 *    本季的覆蓋率**；算進去的話「R1 已收割 6/6」可能有一半是 2024 年的。
 */
const KIND_RULES = [
  // 季前測試：一天一個場次（td1～td3）。網址實例：2026-pre-season-testing-2-day-1-session-1、2026-pre-season-testing-1-day-2。
  // ⚠️ 一天分兩節上架時（session-1／-2）覆蓋率只取句數多的那支，另一支靠觀眾自己翻（2026-10-30 已知、接受）
  [/-pre-season-testing-(?:\d+-)?day-1-/, 'td1'],
  [/-pre-season-testing-(?:\d+-)?day-2-/, 'td2'],
  [/-pre-season-testing-(?:\d+-)?day-3-/, 'td3'],
  [/-pre-season-testing-/, ''],
  [/-sprint-qualifying-/, 'sq'],
  [/-sprint-/, 'sprint'],
  [/-qualifying-/, 'quali'],
  [/-practice-1-/, 'fp1'],
  [/-practice-2-/, 'fp2'],
  [/-practice-3-/, 'fp3'],
  [/-practice-/, 'fp1'],
  [/-grand-prix-/, 'race'],
];

function sessionKind(slugKey, season) {
  if (!slugKey) return '';
  if (SERIES_RULES.some(([re]) => re.test(slugKey))) return '';
  const y = (/-((?:19|20)\d{2})-/.exec(slugKey) || [])[1];
  if (y && season && Number(y) !== Number(season)) return '';
  if (slugKey.includes('-weekend-warm-up-')) return 'warmup';
  // ⚠️ **正式場次的 slug 一定帶年份**（2026-dutch-gp-qualifying、2026-dutch-grand-prix）。
  //    節目與精華不帶（pre-qualifying-show-netherlands、qualifying-highlights-netherlands），
  //    但它們含有 -qualifying-、-sprint-，以前全部被當成排位賽／衝刺賽（2026-09-17 實際收割時發現）：
  //    收割計畫把節目排進佇列（白花錢），覆蓋率「取句數最多的那支」可能讓節目頂替正式場次、
  //    而且拿節目的完整標記算「已完整收割」。
  if (!y) return '';
  return (KIND_RULES.find(([re]) => re.test(slugKey)) || [])[1] || '';
}

/**
 * 所有 bundle 的摘要。**只讀 metadata，不讀本體。**
 * 一份兩千句的 bundle 約 200KB，一百支就是 20MB——讀本體會逾時。
 */
// ⚠️ **list 也有每日 1,000 次的額度，而且同樣被後台的自動刷新吃掉。**（2026-09-25 稽核發現）
//    liveSnapshot → harvestCoverage → listBundleMeta，每一次都列舉整個 `bundle:` 前綴。
//    後台每 15 秒刷新 ＝ 4 次／分鐘 ＝ 一天 5,760 次（9/24 實測 1,596 次／上限 1,000）。
//    **寫入那一條昨天修好了（讀取不再落地），列舉這一條當時沒看到。**
//    修一種資源的用量時要把同一條路徑上的其他資源一起看——它們是同一個呼叫堆疊。
//
//    bundle 清單變動很慢（只有收割或直播寫入時才變），快取 5 分鐘綽綽有餘；
//    本 isolate 自己寫 bundle 時直接作廢，不必等過期。
const BUNDLE_META_TTL_MS = 300000;
let bundleMetaCache = null;        // { at, items }

/** 寫過 bundle 就作廢，讓後台馬上看得到新的一支。 */
function invalidateBundleMeta() { bundleMetaCache = null; }

/**
 * 影片翻譯覆蓋地圖（handoff 9.1 #18，2026-10-06）：cid → 'ready'｜'partial'｜'nosub'。
 *   ready    收割蓋過章的完整繁中（segCount，只有收割能設——見坑 #95）
 *   partial  有一些譯文（直播時累積的、或有人看過一部分），看的時候會即時補翻
 *   nosub    這支影片沒有官方英文字幕軌，我們翻不了
 *   （沒有列出的＝還沒有人看過，看的時候即時翻）
 *
 * ⚠️ **list 也是每天 1,000 次**（坑 #70）。F1TV 的目錄頁一頁幾十支影片、每個觀眾都會打——
 *    結果放 Cache API（每個機房一份、30 分鐘），不是每個 isolate 各自 list 一次。
 *    算出來的只有狀態，不含句子、網址後綴或任何使用者資料。
 */
const COVERAGE_MAP_TTL_SEC = 1800;
const COVERAGE_MAP_URL = 'https://pitlingo.internal/coverage-map/v1';

async function coverageMap(env) {
  const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
  if (cache) {
    try { const hit = await cache.match(COVERAGE_MAP_URL); if (hit) return await hit.json(); } catch (e) { /* 重算 */ }
  }
  const map = {};
  for (const it of await listBundleMeta(env)) {
    if (!/^\d{1,20}$/.test(it.cid)) continue;
    if (it.segCount > 0) map[it.cid] = 'ready';
    else if (it.lines >= 30) map[it.cid] = 'partial';
  }
  let cursor;
  for (let page = 0; page < 3; page++) {
    const r = await env.SUBS.list({ prefix: 'nosub:', limit: 1000, cursor });
    for (const k of r.keys) {
      const cid = k.name.slice('nosub:'.length);
      if (!map[cid]) map[cid] = 'nosub';
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  if (cache) {
    try {
      await cache.put(COVERAGE_MAP_URL, new Response(JSON.stringify(map), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${COVERAGE_MAP_TTL_SEC}` },
      }));
    } catch (e) { /* 存不進快取只是下一次再算 */ }
  }
  return map;
}

async function listBundleMeta(env) {
  if (bundleMetaCache && Date.now() - bundleMetaCache.at < BUNDLE_META_TTL_MS) {
    return bundleMetaCache.items;
  }
  const items = [];
  let cursor;
  // KV list 一次最多 1000 筆，用 cursor 翻頁。上限 10 頁當防呆——
  // 真的有上萬支影片時，該做的是分頁 UI 而不是一次全撈。
  for (let page = 0; page < 10; page++) {
    const r = await env.SUBS.list({ prefix: 'bundle:', limit: 1000, cursor });
    for (const k of r.keys) {
      const m = k.metadata || {};
      items.push({
        cid: k.name.slice('bundle:'.length),
        lines: Number(m.n) || 0,
        segCount: Number(m.seg) || 0,
        markV: m.mv || '',
        at: m.at || null,
        slug: m.slug || '',
      });
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  bundleMetaCache = { at: Date.now(), items };
  return items;
}

/**
 * 場次長度（秒）。用來算「這一場什麼時候結束」。
 *
 * ⚠️ 這是**上限估計**，不是精確長度。正賽有紅旗會超過兩小時，練習賽提早結束
 *    也常見。估長一點的代價只是晚一點收割，估短的代價是**在還在播的時候
 *    跟影片搶同一個 CDN**（坑 #34）——兩邊不對稱，所以一律往長的估。
 */
const SESSION_LEN_SEC = { fp1: 3600, fp2: 3600, fp3: 3600, quali: 3600, sq: 3600, sprint: 3600, race: 7200, td1: 34200, td2: 34200, td3: 34200 };

/** 場次結束後多久才可以收割（使用者指定：一小時）。等 VOD 上架。 */
const HARVEST_LAG_SEC = 3600;

/** 場次開播前這段時間也不可以收割——人已經在等著看了。 */
const HARVEST_GUARD_SEC = 900;

/**
 * 收割的優先順序。
 *
 * ⚠️ **順序的意義是「被打斷時留下什麼」。** 收割隨時可能中斷（關電腦、
 *    F1TV 登出、Chrome 把背景分頁節流），照列表頁的順序跑的話，
 *    留下來的可能是三場練習而正賽一句都沒有。
 */
const HARVEST_PRIORITY = ['race', 'quali', 'sprint', 'sq', 'fp1', 'fp2', 'fp3', 'td1', 'td2', 'td3', 'warmup'];

/**
 * 收割計畫：**現在該收哪幾場，以及送上來的這些連結裡哪幾條值得跑。**
 *
 * 為什麼要放在後端：判斷「這條網址是哪一站的哪一種場次」需要
 * `slugMatchesGp` + `sessionKind` + 賽程 + 已有的快取狀態。
 * 那一整套如果複製到 userscript，就是第五個跨檔案的硬性契約，
 * 而**這個專案已經有四個，每一個都因為漂移出過事**。
 * 用戶端只負責一件它獨有的能力：把頁面上的連結刮下來。
 *
 * `paths` 可以不給——不給時只回答「現在該收哪幾場」（後台用），
 * 給了才額外回傳排好序的待跑佇列（userscript 用）。
 */
/**
 * 即時快照。**後台「即時」分頁的唯一資料來源。**
 *
 * 為什麼要有這一支——LIVE-TEST.md 的第 ②③ 項原本是這樣寫的：
 *
 *     curl "https://api.pitlingo.com/v1/admin/stats?days=1" -H "x-admin-token: ..."
 *     「看模型呼叫次數 vs 翻譯句數」
 *     「直播結束後看 KV puts 的增量」
 *
 * 那要求人在直播當下開終端機、記得先存一份起始值、事後再減一次。
 * **跑了好幾場直播，一次都沒做到。** 所以把判讀搬到伺服器上：
 * 這一支直接回答「去重有沒有生效」「KV 會不會撞天花板」，
 * 後台只要開著就看得到，不必算。
 *
 * ⚠️ **判讀要連同依據一起回傳。** 只回一個「正常／異常」的字，
 *    出事時沒有人查得下去；把分子分母一起給，才有辦法往下追。
 */
async function liveSnapshot(env, cfg) {
  const c = cfg || REMOTE_CONFIG;
  const now = nowSec();

  const [stats, cov, hs] = await Promise.all([
    statsSummary(env, 1).catch(() => null),
    harvestCoverage(env, c).catch(() => null),
    // 收割端的即時狀態卡（DO 讀取，不碰 KV）
    roomOp(env, LEADER_GLOBAL_ROOM, { op: 'hstatList' }).catch(() => null),
  ]);

  // ---- 現在有沒有場次正在播 ----
  let session = null;
  for (const g of gpList(c)) {
    for (const s of g.sessions || []) {
      const len = SESSION_LEN_SEC[s.k] || 3600;
      if (now >= s.t && now < s.t + len) {
        session = {
          round: g.r, gp: g.label || `${g.name}大獎賽`, label: s.n, kind: s.k,
          startedAt: s.t, elapsedSec: now - s.t, lengthSec: len,
        };
      }
    }
  }

  const t = (stats && stats.total) || null;

  // ---- ② 並發去重有沒有生效 ----
  //
  // 判讀依據：**一次模型呼叫應該涵蓋一整批（約 15 句）。**
  //   每次呼叫的句數 ≈ 15  → 去重生效（N 個觀眾只翻了一份）
  //   每次呼叫的句數 ≈ 15/N → 去重失效（每個人各翻各的）
  //
  // ⚠️ 這個比值在**句數還很少的時候沒有意義**（一批還沒滿就被送出）。
  //    樣本不足時要明講「還看不出來」，不可以給一個看起來像結論的數字。
  const linesPerCall = (t && t.calls) ? +(t.translated / t.calls).toFixed(1) : null;

  // ⚠️ **只有一個觀眾時，這個比值量的不是去重。**（2026-09-23 亞塞拜然暖身實測後補上）
  //    實測：一個人看直播 → 每次呼叫 2.8 句 → 判讀寫「❌ 去重失效，每個觀眾都在付全額」。
  //    但**根本沒有第二個人可以讓**：2.8 句反映的是直播批次湊不大（提前量短），
  //    那是成本問題，不是去重問題。兩者的處理方式完全不同
  //    （前者要調批次策略或延遲畫面，後者要查認領機制），判讀混為一談會查錯方向。
  let viewers = null;
  try {
    const day = await readStatsDay(env, ustatsKey());
    viewers = Object.keys(day).filter((k) => k !== '__others').length;
  } catch (e) { viewers = null; }

  const dedupe = {
    calls: t ? t.calls : null,
    translated: t ? t.translated : null,
    linesPerCall,
    viewers,
    verdict: (!t || t.translated < 200) ? '樣本不足，還看不出來'
      : viewers !== null && viewers <= 1
        ? `只有 1 位觀眾——去重無從發生。每次呼叫 ${linesPerCall} 句反映的是直播的批次大小（成本問題，不是去重問題）`
        : linesPerCall >= 8 ? '✅ 去重生效（一次呼叫涵蓋一整批）'
          : linesPerCall >= 4 ? '⚠️ 部分去重（可能有幾個人同時各翻各的）'
            : '❌ 去重失效 —— 每個觀眾都在付全額',
  };

  // ---- ③ KV 寫入量 ----
  //
  // ⚠️ **這是下限。** 計數器活在 isolate 記憶體裡，isolate 被回收會帶走
  //    還沒落地的那一段——真實用量只會更高。報告時一定要照這樣講。
  const puts = (stats && stats.kv && stats.kv.todayPuts) || 0;
  const cap = kvDailyCap(env);
  const kv = {
    todayPuts: puts, cap, paid: kvPaid(cap),
    pct: cap ? Math.round((puts / cap) * 100) : null,
    verdict: puts >= cap ? (kvPaid(cap) ? '⚠️ 超過每日平均含量（付費方案照樣寫得進去，只是開始多付錢）' : '❌ 已經撞到天花板，寫入正在被丟棄')
      : puts > cap * 0.8 ? '⚠️ 已用掉八成'
        : '✅ 還有餘裕',
    note: '下限值（isolate 回收會漏掉未落地的部分）',
  };

  return {
    ok: true,
    now,
    nowMs: Date.now(),
    session,
    harvesters: (hs && Array.isArray(hs.items)) ? hs.items : [],
    today: t ? {
      usd: stats.total.usd,
      calls: t.calls,
      translated: t.translated,
      sharedCacheHits: t.sharedCacheHits,
      sharedHitRate: t.sharedHitRate,
      promptCacheHitRate: t.promptCacheHitRate,
      usdPerLine: t.usdPerTranslatedLine,
      capUsd: stats.budget.dailyCapUsd,
    } : null,
    dedupe,
    kv,
    coverage: cov ? {
      need: cov.races.reduce((a, r) => a + r.need, 0),
      have: cov.races.reduce((a, r) => a + r.have, 0),
      // 只算還沒結束的——已結束的再缺也補不回那次直播的錢
      openNeed: cov.races.filter((r) => r.status !== 'finished')
        .reduce((a, r) => a + r.need, 0),
      openHave: cov.races.filter((r) => r.status !== 'finished')
        .reduce((a, r) => a + r.have, 0),
    } : null,
  };
}

async function harvestPlan(env, cfg, paths) {
  const c = cfg || REMOTE_CONFIG;
  const now = nowSec();
  const cov = await harvestCoverage(env, c);
  const races = gpList(c);

  // 現在有沒有任何場次正在播（或即將開播）。**有的話一律不收割。**
  let liveNow = null;
  for (const g of races) {
    for (const s of g.sessions || []) {
      const len = SESSION_LEN_SEC[s.k] || 3600;
      if (now >= s.t - HARVEST_GUARD_SEC && now < s.t + len) {
        liveNow = { round: g.r, name: g.name, label: s.n };
      }
    }
  }

  // 每一站、每一個場次：缺不缺、到時間了沒。
  const byRace = new Map();
  const todo = [];
  const waiting = [];
  for (const r of cov.races) {
    const g = races.find((x) => gpId(x) === r.id);
    const want = new Map();
    for (const s of r.sessions) {
      const gs = (g.sessions || []).find((x) => x.k === s.kind);
      const len = SESSION_LEN_SEC[s.kind] || 3600;
      const readyAt = gs ? gs.t + len + HARVEST_LAG_SEC : 0;
      if (s.lines && s.complete && !s.suspect) continue;   // 已經有完整快取（可疑的要重新驗證）
      if (!readyAt) continue;
      if (now < readyAt) {
        waiting.push({ round: r.round, name: r.name, label: s.label, readyAt });
        continue;
      }
      want.set(s.kind, { label: s.label, partial: !!s.lines });
    }
    if (!want.size) continue;
    byRace.set(r.id, { race: r, want });
    todo.push({
      id: r.id, round: r.round, name: r.name, status: r.status,
      missing: [...want.values()].map((x) => x.label),
      partial: [...want.values()].filter((x) => x.partial).length,
    });
  }

  // 排序：進行中 → 正賽剛結束（**這才是收割的黃金時段**）→ 即將開始（近的先）
  //      → 已結束（新的先）。
  //
  // ⚠️ `replay` 一定要排在 `upcoming` 前面。正賽跑完之後那幾個小時，
  //    是所有場次都已經播完、而譯文還有機會補齊的唯一時機——
  //    排到後面等於每次打開後台看到的都是「下週要做的事」，
  //    而這週還沒收完的悄悄過期。
  const HARVEST_RANK = { live: 0, replay: 1, open: 2, upcoming: 3, finished: 4 };
  const rank = (x) => (HARVEST_RANK[x.status] === undefined ? 4 : HARVEST_RANK[x.status]);
  todo.sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 4 ? b.round - a.round : a.round - b.round));

  const out = {
    now, liveNow,
    lagMinutes: Math.round(HARVEST_LAG_SEC / 60),
    todo,
    waiting: waiting.sort((a, b) => a.readyAt - b.readyAt).slice(0, 12),
  };
  if (!Array.isArray(paths)) return out;

  // --- 送上來的連結：挑出值得跑的，並排好順序 -------------------------------
  const season = c.seasonYear || SEASON_YEAR;
  const skipped = { complete: 0, notMissing: 0, otherSeason: 0, support: 0, unknown: 0, dup: 0 };
  const picked = [];
  const seen = new Set();
  for (const raw of paths.slice(0, 1000)) {
    const m = String(raw || '').match(/\/detail\/(\d+)(\/[A-Za-z0-9\-_]+)/);
    if (!m) { skipped.unknown++; continue; }
    const path = `/detail/${m[1]}${m[2]}`;
    if (seen.has(path)) { skipped.dup++; continue; }
    seen.add(path);

    const key = slugKeyOf(path);
    const g = races.find((x) => slugMatchesGp(key, x));
    if (!g) { skipped.unknown++; continue; }
    const kind = sessionKind(key, season);
    if (!kind) {
      // 舊賽季重播與支援賽事都走這條。分開計數，因為處理方式不同：
      // 前者永遠不該自動收割，後者是「目前不收，日後也許」。
      if (SERIES_RULES.some(([re]) => re.test(key))) skipped.support++;
      else skipped.otherSeason++;
      continue;
    }
    const e = byRace.get(gpId(g));
    if (!e || !e.want.has(kind)) {
      // 可能是已完整、也可能是還沒到「賽後一小時」。
      const r = cov.races.find((x) => x.id === gpId(g));
      const s = r && r.sessions.find((x) => x.kind === kind);
      if (s && s.complete) skipped.complete++; else skipped.notMissing++;
      continue;
    }
    picked.push({ path, gp: gpId(g), round: g.r, kind, label: e.want.get(kind).label, name: g.name });
  }

  const order = new Map(todo.map((t, i) => [t.id, i]));
  picked.sort((a, b) => (order.has(a.gp) ? order.get(a.gp) : 99) - (order.has(b.gp) ? order.get(b.gp) : 99)
    || HARVEST_PRIORITY.indexOf(a.kind) - HARVEST_PRIORITY.indexOf(b.kind));

  out.queue = picked.map((p) => p.path);
  out.plan = picked;
  out.skipped = skipped;
  out.received = Array.isArray(paths) ? paths.length : 0;
  return out;
}

/**
 * 收割覆蓋率：**每一站的每一個場次，我們手上有沒有譯文。**
 *
 * 為什麼要這個而不是只看「翻譯清單有幾支」：後台原本只回答得了
 * 「已經有什麼」，回答不了「**還缺什麼**」——而缺的那些正是下一場直播
 * 會用全額付費重翻一次的東西。實測（2026-09-14）：R12~R14 三站
 * 從未收割，於是那幾場直播的共用快取命中率是 0%，每場約 $0.73。
 *
 * ⚠️ 「應該有幾場」直接取自賽程的 `sessions`，不是寫死的數字——
 *    衝刺賽週的場次組成不同（只有一場練習、多了衝刺排位與衝刺賽），
 *    寫死會讓六個衝刺賽站永遠顯示缺兩場。
 *
 * ⚠️ 賽前暖身（weekend-warm-up）**不計入分母**。它不在官方場次表裡，
 *    而且不是每一站都有——計入的話覆蓋率永遠到不了 100%，
 *    那種永遠紅著的指標會被無視，等於沒有。
 */
/**
 * 從這個版本起，userscript 的完整標記才可信（坑 #55、#56、#58 都修掉之後）。
 * 之前的版本可能在翻譯還沒結束時就蓋章，或把失敗的批次丟掉仍然蓋章。
 */
const MARK_TRUSTED_FROM = '4.13.0';
/**
 * 管理版擴充功能（handoff 9.1 #26 第 3 階段）的完整標記從這個版本起可信。
 * 它的版本號是另一條線（0.x），**不可以拿 MARK_TRUSTED_FROM 比**——0.37 < 4.13 會把每一支都列為可疑。
 */
const EXT_MARK_TRUSTED_FROM = '0.37.0';
function markTrusted(v) {
  const s = String(v || '');
  return s.startsWith('ext-') ? verAtLeast(s.slice(4), EXT_MARK_TRUSTED_FROM) : verAtLeast(s, MARK_TRUSTED_FROM);
}
/** 句／段比例低於同類場次中位數的這個比例，就懷疑缺句。 */
const SUSPECT_RATIO = 0.75;

function verAtLeast(v, min) {
  const a = String(v || '').split('.').map(Number);
  const b = String(min).split('.').map(Number);
  if (a.length !== 3 || a.some((x) => !Number.isFinite(x))) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return true;
}

/**
 * **標記完整、但很可能缺句**的影片（2026-09-18 全季收割後檢查發現）。
 *
 * 以前只有一條絕對門檻（MIN_LINES_PER_SEG = 0.5 句／段），是用 32 支影片校準的，
 * 當時把 0.70 當成「安靜的練習賽」放行。全季 70 支正式場次收齊之後再看：
 * 中位數 2.12，**從 80% 起是一條平滑的分布，底下另有 5 支脫隊**（33%～71%），
 * 全部是 v4.13.0 之前的版本蓋的章——而那些版本有「翻譯還沒結束就蓋章」（坑 #56）
 * 與「失敗的批次丟掉照樣蓋章」（坑 #55）兩個已知缺陷。
 *
 * 判斷方式是**跟同一季的正式場次比**，不是再調一個絕對門檻：
 * 絕對門檻遲早又會把某種安靜的場次誤判或放過；相對的中位數會跟著資料走。
 *
 * ⚠️ 被 MARK_TRUSTED_FROM 以後的版本重新蓋過章的就不再懷疑——
 *    那代表「新版逐句確認過，這支就是這麼安靜」。沒有這一條，
 *    真的很安靜的場次會被永遠列為可疑，每一輪都叫人重收。
 */
function suspectMarked(items, races, season) {
  const official = [];
  for (const it of items) {
    if (!it.slug || !(it.segCount > 0) || !it.lines) continue;
    const key = slugKeyOf(it.slug);
    const k = sessionKind(key, season);
    if (!k || k === 'warmup') continue;
    if (!races.some((g) => slugMatchesGp(key, g))) continue;
    official.push(it);
  }
  const out = new Set();
  if (official.length < 10) return out;          // 樣本太少時中位數沒有意義
  const ratios = official.map((x) => x.lines / x.segCount).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  for (const it of official) {
    if (markTrusted(it.markV)) continue;
    if (it.lines / it.segCount < median * SUSPECT_RATIO) out.add(String(it.cid));
  }
  return out;
}

async function harvestCoverage(env, cfg) {
  const c = cfg || REMOTE_CONFIG;
  const season = c.seasonYear || SEASON_YEAR;
  const items = await listBundleMeta(env);
  const races = gpList(c);

  // cid → 該影片對到哪一站的哪一種場次。同一種場次有多支時取句數最多的。
  const best = new Map();       // `${gpId}|${kind}` → item
  for (const it of items) {
    if (!it.slug) continue;
    const key = slugKeyOf(it.slug);
    const g = races.find((x) => slugMatchesGp(key, x));
    if (!g) continue;
    const k = sessionKind(key, season);
    if (!k) continue;
    const id = `${gpId(g)}|${k}`;
    const cur = best.get(id);
    if (!cur || it.lines > cur.lines) best.set(id, it);
  }

  const suspect = suspectMarked(items, races, season);
  const out = [];
  for (const g of races) {
    const want = (Array.isArray(g.sessions) ? g.sessions : []).map((s) => ({ k: s.k, n: s.n }));
    const rows = want.map((s) => {
      const it = best.get(`${gpId(g)}|${s.k}`) || null;
      return {
        kind: s.k,
        label: s.n,
        cid: it ? it.cid : '',
        lines: it ? it.lines : 0,
        // segCount > 0 才代表「整軌收割完成」，後續觀看者才會跳過預抓。
        complete: !!(it && it.segCount > 0),
        // 標記完整但很可能缺句（見 suspectMarked）。收割計畫會把它排回佇列
        suspect: !!(it && suspect.has(String(it.cid))),
        at: it ? it.at : null,
      };
    });
    const warm = best.get(`${gpId(g)}|warmup`) || null;
    const have = rows.filter((r) => r.lines > 0).length;
    out.push({
      id: gpId(g),
      round: g.r,
      name: g.name,
      start: g.start,
      end: g.end,
      sprint: !!g.sprint,
      status: gpStatus(g, null, c),
      need: rows.length,
      have,
      complete: rows.filter((r) => r.complete).length,
      lines: rows.reduce((a, r) => a + r.lines, 0),
      coverage: rows.length ? have / rows.length : 0,
      sessions: rows,
      warmup: warm ? { cid: warm.cid, lines: warm.lines, complete: warm.segCount > 0 } : null,
    });
  }
  return { season, races: out, suspect: [...suspect] };
}
const OPS_KEY = 'ops:config';
let opsCache = { at: 0, data: null };

async function opsConfig(env) {
  if (opsCache.data && Date.now() - opsCache.at < 30000) return opsCache.data;
  let raw = null;
  try { raw = JSON.parse((await env.SUBS.get(OPS_KEY)) || 'null'); } catch (e) { raw = null; }
  const o = (raw && typeof raw === 'object') ? raw : {};

  const prices = {};
  if (o.prices && typeof o.prices === 'object') {
    for (const [k, v] of Object.entries(o.prices)) {
      // 只認得的方案、只收 1~99999 的整數。0 或負數一律忽略。
      if (!PLANS[k]) continue;
      const n = Math.round(Number(v));
      if (Number.isFinite(n) && n >= 1 && n <= 99999) prices[k] = n;
    }
  }
  const data = {
    prices,
    earlyLimit: Number.isFinite(Number(o.earlyLimit)) && Number(o.earlyLimit) >= 0
      ? Math.min(9999, Math.round(Number(o.earlyLimit))) : null,
    hidden: Array.isArray(o.hidden) ? o.hidden.filter((k) => PLANS[k]) : [],
    choosePayment: typeof o.choosePayment === 'string' && /^[A-Za-z]+$/.test(o.choosePayment)
      ? o.choosePayment : null,
    notice: typeof o.notice === 'string' ? o.notice.slice(0, 500) : '',
    // 限時活動（見 normPromo）。設定不合格＝沒有活動
    promo: normPromo(o.promo),
    // 彈幕（尚未發行）。預設關、白名單空、不用 Haiku——見 normDanmaku
    danmaku: normDanmaku(o.danmaku),
    // ---- 單位經濟的三個輸入 ----
    // ⚠️ 這三個**我們量不到，只能由你填**。填之前後台會明講是估算值，
    //    不會拿假數字冒充實測——單位經濟算錯的代價是「以為賺錢其實在虧」。
    fxTwdPerUsd: Number(o.fxTwdPerUsd) > 0 ? Number(o.fxTwdPerUsd) : 32,
    marketingTwd: Number(o.marketingTwd) >= 0 ? Number(o.marketingTwd) : 0,
    // 一個付費者預期會續訂幾季。**沒有資料之前一律是 1**——
    // 用 2、3 會讓 LTV 憑空變兩三倍，然後據此決定廣告預算，那是最貴的一種錯。
    ltvSeasons: Number(o.ltvSeasons) > 0 ? Number(o.ltvSeasons) : 1,
  };
  opsCache = { at: Date.now(), data };
  return data;
}

/**
 * 這個方案現在能不能買。回傳 null＝可以，否則回傳鎖住的原因。
 *
 * ⚠️ **鎖住的方案仍然要回給購買頁**，只是不能結帳。
 *    直接從清單裡拿掉會讓人以為賣完了或網站壞了；
 *    留著並說明「什麼時候會開放」，那本身就是預告。
 *
 * ⚠️ 這個判斷必須同時擋住 quoteCart（結帳）與 checkout，不能只做在畫面上——
 *    購買頁的按鈕是用戶端的東西，繞過它只要開一個 devtools。
 */
function planLock(key, from, cfg, early) {
  const p = PLANS[key];
  if (!p) return '方案不存在';
  // 早鳥（2026-11-03）：early＝earlyState() 的結果。**賣東西的地方（結帳、/v1/plans、後台方案）一定要傳**，
  //    沒傳的話早鳥只看年份與截止、599 那張也不會被鎖
  if (p.earlyBird) {
    const st = early || {};
    if (!earlyTargetKey() || st.over) return `${EARLY_YEAR} 賽季早鳥已截止`;
    if (st.known === false) return '暫時無法確認早鳥剩餘名額，請稍後再試';
    if (st.disabled) return '早鳥目前未開放';
    if (st.soldOut) return `早鳥 ${EARLY_LIMIT} 組已售完`;
    if (st.left === 0) return '早鳥名額目前都在結帳中，請稍後再試';
  }
  // 本賽季免費體驗期間，本賽季的比賽週與本賽季票停賣（2026-11-03 Ray：「這個賽季就不賣了」）。早鳥、下一季、代訂照賣
  if ((key === 'week' || key === 'season') && freeSeasonActive(from, cfg)) {
    return `${FREE_SEASON_YEAR} 賽季剩下的比賽免費開放中：在擴充功能登入帳號就能使用，不必購買`;
  }
  // 早鳥還在賣的時候，同內容的 599 那張鎖住（Ray：「早鳥賣完再開599」）。連不上 AuthGuard 時 open 也是 true＝先鎖
  if (early && early.open && key === earlyTargetKey()) return `早鳥 ${EARLY_LIMIT} 組售完後開放`;
  // 本賽季全部跑完就停賣本賽季票（2026-10-30 Ray 選 C）：之後只剩重播，休賽期改賣下一賽季票（買了立刻生效）與重播月票。
  //    ⚠️ 剩不到 7 站時**照賣**（Ray：先不用停賣，但網站要寫清楚是哪年的季票）
  if (p.untilSeasonEnd) {
    return seasonOver(from, cfg)
      ? `${SEASON_YEAR} 賽季已全部結束，請改買 ${SEASON_YEAR + 1} 賽季通行證（購買後立即生效）或重播月票`
      : null;
  }
  if (p.offSeasonOnly) {
    return inOffSeason(from, cfg)
      ? null
      : `重播月票只在休賽期販售：${SEASON_YEAR} 賽季最後一站結束後開放，下一賽季開幕前截止。賽季中請選擇比賽週或賽季通行證`;
  }
  if (!p.nextSeasonOnly) return null;
  const left = racesLeft(from, cfg);
  if (left < NEXT_SEASON_MIN_WEEKENDS) return null;
  // ⚠️ 條件是「少於」NEXT_SEASON_MIN_WEEKENDS 才開放。文案原本寫「要到剩 8 個時才開放」，
  //    於是剩 8 個的那一週畫面同時寫「還有 8 個週末」與「剩 8 個才開放」（2026-10-02 實測）。
  return `本賽季還有 ${left} 個比賽週末，下一賽季通行證會在剩下 ${NEXT_SEASON_MIN_WEEKENDS - 1} 個週末時開放預購`;
}

/** 這個方案現在的牌價（後台覆寫優先）。 */
function planPrice(key, ops) {
  const p = PLANS[key];
  if (!p) return 0;
  return (ops && ops.prices && ops.prices[key] != null) ? ops.prices[key] : p.price;
}

