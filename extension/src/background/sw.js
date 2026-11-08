/**
 * Service Worker —— 唯一對外通訊的地方
 *
 * 為什麼所有網路請求都走這裡，而不是讓 content script 直接 fetch：
 *   1. content script 的 fetch 受頁面 CORS 限制；SW 不受，只要有 host_permissions
 *   2. 未來要加的授權權杖只存在這裡，不會出現在頁面環境裡
 *   3. 商店審核時「網路行為集中在一處」比散落各處容易解釋
 *
 * ⚠️ MV3 的 SW 隨時可能被瀏覽器殺掉並重啟。
 *    因此**所有狀態都必須放 chrome.storage，不能放模組層級變數**。
 *    下面的 memCache 只是同一次生命週期內的加速，掉了也不影響正確性。
 */

importScripts('/src/shared/normalize.js', '/src/shared/defaults.js');

const BACKEND = self.PL.BACKEND;
// 遠端設定是「F1TV 改版時能不能在幾分鐘內救回所有使用者」的唯一保障。
//
// 這個值踩過兩次：
//   6 小時  → 比賽日出事等於整場報銷
//   10 分鐘 → content script 每 60 秒重讀變成空轉，實際傳播仍是 10 分鐘
//
// 真正的傳播延遲 = SW 快取 TTL + content script 的重讀間隔。
// 設 2 分鐘，最壞情況約 3 分鐘。設定 JSON 只有幾百 bytes，
// 每位使用者每 2 分鐘一次請求的負載完全可接受。
const CONFIG_TTL_MS = 2 * 60 * 1000;        // 2 分鐘

// 生命週期內的記憶體快取。被殺掉就沒了，但 storage 裡有備份。
const memCache = {
  bundles: new Map(),      // cid -> { lines, segCount, count, at }
  config: null,
};

// ---------------------------------------------------------------------------
// 後端通訊
// ---------------------------------------------------------------------------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return self.PL.sanitizeSettings(settings);
}

/**
 * 取得這個安裝的權杖。沒有就跟後端換一枚。
 *
 * 為什麼不再用使用者手動貼的共用金鑰（SECURITY.md S6）：
 * 那枚金鑰隨擴充功能發給每一個人，等同公開——任何人都能拿去無限呼叫後端
 * 燒掉 Anthropic 額度。改成**每個安裝一枚**之後才有辦法個別限額與撤銷。
 *
 * 使用者完全無感：不需要註冊、不需要 email、不收任何個資，
 * 只是啟動時匿名換一枚權杖存在本機。
 *
 * `installId` 同時用於分階段推送的分流（同一個安裝永遠落在同一組）。
 * 它**只送給我們自己的後端**，不做任何跨站追蹤。
 */
const TOKEN_RENEW_BEFORE_MS = 7 * 86400 * 1000;     // 到期前 7 天就換新的

async function getClientToken() {
  const st = await chrome.storage.local.get(['installToken', 'installExp', 'clientToken']);

  // 還在有效期內就用它
  if (st.installToken && st.installExp && st.installExp * 1000 - Date.now() > TOKEN_RENEW_BEFORE_MS) {
    return st.installToken;
  }

  try {
    const res = await fetch(BACKEND + '/v1/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (res.ok) {
      const d = await res.json();
      if (d && d.token) {
        await chrome.storage.local.set({ installToken: d.token, installExp: d.exp });
        return d.token;
      }
    }
  } catch (e) { /* 換不到就往下退 */ }

  // 換不到新的就先用舊的（過期總比沒有好），再退回使用者手填的金鑰
  return st.installToken || st.clientToken || '';
}

/** 分階段推送用的分流識別碼。從權杖裡取，不另外產生。 */
async function getInstallId() {
  const { installToken } = await chrome.storage.local.get('installToken');
  if (!installToken) return '';
  const first = String(installToken).split('.')[0];
  return /^[0-9a-f-]{8,}$/i.test(first) ? first : '';
}

/**
 * 呼叫後端。
 *
 * ⚠️ 錯誤一定要帶著 **status 與伺服器給的訊息**。
 *
 * 原本只丟 `new Error('HTTP 404')`，於是每個呼叫端都只能寫
 * 「無法連線到伺服器」——但 404（端點不存在／後端沒部署）、401（權杖問題）、
 * 429（太頻繁）、503（額度用盡）是完全不同的四件事，
 * **對使用者的指示也完全不同**。把它們混成同一句話，等於沒有錯誤訊息。
 *
 * 實際踩到：使用者按「傳送診斷」看到「無法連線到伺服器，請檢查網路」，
 * 真正的原因是後端還沒部署 v2.3，`/v1/report` 回 404。他去檢查網路是白費工。
 */
async function api(path, options) {
  const token = await getClientToken();
  // 通行證一併帶上。伺服器用它判斷這個安裝有沒有付費——
  // 用戶端的授權 UI 只是體驗，真正的閘門在伺服器（沒有 TOKEN_SECRET 就驗不了簽）。
  const { entitlement, accountToken } = await chrome.storage.local.get(['entitlement', 'accountToken']);
  const headers = { 'content-type': 'application/json', 'x-client-token': token };
  if (entitlement) headers['x-entitlement'] = entitlement;
  // 登入權杖。⚠️ **它決定免費額度綁在帳號還是 installId 上**——
  //    綁帳號的人清掉瀏覽器儲存也不會讓額度重來（見後端 checkEntitlement）。
  //    權杖過期時伺服器會當成遊客，**不會回錯誤**，所以這裡不需要先驗。
  if (accountToken) headers.authorization = 'Bearer ' + accountToken;
  /* @admin-only:start */
  await withHarvestToken(headers, path);
  // 管理版只有收割身分（2026-10-24 Ray）：沒權杖就不翻譯、不當前導端——**不退回用個人授權**，
  // 否則成本會混進客戶帳、前導端的身分也變成一般付費使用者
  if (/^\/v1\/(translate|leader\/beat)/.test(path) && !headers['x-harvest-token']) {
    throw new Error('管理版尚未設定收割權杖（設定頁最下面「管理版：收割」）');
  }
  /* @admin-only:end */

  let res;
  try {
    res = await fetch(BACKEND + path, Object.assign({ headers }, options || {}));
  } catch (e) {
    // 只有這裡才是真的連不上
    const err = new Error('無法連線到伺服器，請檢查網路連線');
    err.offline = true;
    throw err;
  }

  const data = await res.json().catch(() => null);
  if (res.ok) return data;

  const err = new Error(describeHttp(res.status, data));
  err.status = res.status;
  err.data = data;
  throw err;
}

/* @admin-only:start */
/**
 * 管理版：收割權杖（handoff 9.1 #26）。設定頁「收割權杖」欄位，存在 chrome.storage.local。
 * 帶了就是收割身分（後端 authClient → installId 'harvest'）：不吃免費額度、成本記在 harvest、
 * 收割蓋的完整標記可信。打錯後端直接 401，不會靜靜變成一般使用者。
 *
 * ⚠️ **只加在收割會用到的路徑。** api() 也負責授權、帳號、配對——那些請求帶了收割權杖，
 *    後端會把它們全部當成 'harvest' 這個安裝，授權狀態與裝置名單全部錯亂。
 */
// '/v1/leader/beat'：前導收割的心跳（2026-10-24）。後端收割身分＝legacy，心跳照收；不必有授權碼
// '/v1/leader/status'：自動開直播問「別台前導端在不在」（2026-10-25，兩台同一個 F1TV 帳號不能同時播）
const HARVEST_PATHS = ['/v1/translate', '/v1/subs', '/v1/admin/harvest/', '/v1/admin/bundles', '/v1/leader/beat', '/v1/leader/status'];
async function withHarvestToken(headers, path) {
  if (!HARVEST_PATHS.some((p) => String(path || '').startsWith(p))) return headers;
  const { harvestToken } = await chrome.storage.local.get('harvestToken');
  if (harvestToken) headers['x-harvest-token'] = harvestToken;
  return headers;
}

/**
 * 管理版的收割請求（第 3 階段）。content script 不直接打後端——權杖只在這裡讀。
 *
 * ⚠️ **沒有收割權杖就不送。** 這幾支都是收割專用的端點，沒權杖送出去只會 401，
 *    而且每一次 401 都會被後端記成一次失敗（adminGate 的鎖定）。
 */
async function harvestCall(kind, msg) {
  const { harvestToken } = await chrome.storage.local.get('harvestToken');
  if (!harvestToken) return { ok: false, error: '未設定收割權杖（設定頁 → 管理版 → 收割權杖）' };
  try {
    if (kind === 'plan') {
      const paths = Array.isArray(msg.paths) ? msg.paths.map(String).slice(0, 2000) : null;
      return await api('/v1/admin/harvest/plan', { method: 'POST', body: JSON.stringify(paths ? { paths } : {}) });
    }
    if (kind === 'bundles') return await api('/v1/admin/bundles', { cache: 'no-store' });
    if (kind === 'slugs') {
      const paths = (Array.isArray(msg.paths) ? msg.paths : []).map(String).slice(0, 2000);
      return await api('/v1/admin/bundles/slugs', { method: 'POST', body: JSON.stringify({ paths }) });
    }
    if (kind === 'stamp') {
      // 可信的完整標記：整支影片的譯文＋分段數一起寫（POST /v1/subs）。
      // ⚠️ 不走 /v1/complete——那支只記 clientSeg（參考值），收割佇列與彙報都不信它（坑 #95）。
      // 譯文一起帶上：/v1/translate 寫進後端緩衝的那份要等合併才落地，
      // 這一次寫入讓「標記完整」與「譯文真的在 KV 裡」是同一件事（鐵則 48）。
      const cid = String(msg.cid || '');
      if (!/^\d{1,20}$/.test(cid)) return { ok: false, error: 'cid 格式不正確' };
      const body = { cid, lines: msg.lines || {}, slug: String(msg.slug || '').slice(0, 120) };
      // 每句在影片裡的秒數（後台翻譯清單的時間軸，2026-11-06）
      if (msg.times && typeof msg.times === 'object' && !Array.isArray(msg.times)) body.times = msg.times;
      if (msg.segCount > 0) { body.segCount = Number(msg.segCount); body.v = String(msg.v || ''); }
      const d = await api('/v1/subs', { method: 'POST', body: JSON.stringify(body) });
      memCache.bundles.delete(cid);
      return d;
    }
    if (kind === 'f1tvSched') {
      // F1TV 賽事頁的真實時程（A4）：harvest.js 在 F1TV 頁面上讀好、整理成 { kind, at, end, cid, href }，這裡只轉送
      const items = (Array.isArray(msg.items) ? msg.items : []).slice(0, 60);
      return await api('/v1/admin/harvest/f1tv-schedule', { method: 'POST', body: JSON.stringify({ gpId: String(msg.gpId || ''), items }) });
    }
    if (kind === 'status') {
      // 收割端的即時狀態（面板內容＋播放位置）→ 後台「即時狀態」。後端驗格式，這裡只轉送
      return await api('/v1/admin/harvest/status', { method: 'POST', body: JSON.stringify({ id: String(msg.id || ''), status: msg.status || {} }) });
    }
    return { ok: false, error: 'unknown harvest call' };
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: e.status || 0 };
  }
}
/* @admin-only:end */

/** 把 HTTP 狀態翻成「使用者現在能做什麼」。 */
function describeHttp(status, data) {
  if (data && data.error) return data.error;
  if (status === 401) return '存取權杖無效。請重新載入擴充功能，它會自動重新取得。';
  if (status === 403) return '沒有權限執行這個動作。';
  if (status === 404) return '伺服器上找不到這個功能（可能是後端版本較舊）。請聯絡開發者。';
  if (status === 429) return '操作太頻繁，請稍後再試。';
  if (status === 503) return '服務暫時無法使用，請稍後再試。';
  if (status >= 500) return `伺服器發生錯誤（${status}），請稍後再試。`;
  return `請求失敗（HTTP ${status}）`;
}

/**
 * 取得遠端設定。這是 F1TV 改版時的救命索：
 * 選擇器變了就改後端 JSON，不用重新送審。
 * 拿不到就用內建預設，功能不會因為後端掛掉而中斷。
 */
async function getConfig() {
  const now = Date.now();
  if (memCache.config && now - memCache.config.at < CONFIG_TTL_MS) return memCache.config.data;

  const { configCache } = await chrome.storage.local.get('configCache');
  if (configCache && now - configCache.at < CONFIG_TTL_MS) {
    memCache.config = configCache;
    return configCache.data;
  }

  try {
    // 帶上 installId，讓伺服器決定這個安裝該拿哪一版（分階段推送）
    const iid = await getInstallId();
    const data = await api('/v1/config' + (iid ? `?iid=${encodeURIComponent(iid)}` : ''));
    const entry = { data, at: now };
    memCache.config = entry;
    await chrome.storage.local.set({ configCache: entry });
    return data;
  } catch (e) {
    // 後端不可用時退回內建設定，或用過期的快取（過期總比沒有好）
    if (configCache) return configCache.data;
    return self.PL.BUILT_IN_CONFIG;
  }
}

/**
 * 取得整支影片的譯文。
 * 這是「共用快取」的讀取端——同一支影片全世界只翻一次，其他人直接下載。
 */
/**
 * ⚠️ 這個快取一定要有 TTL。
 *
 * 原本是 `if (cached) return cached;`——存了 `at` 卻從來不檢查，等於永久快取。
 * 實測症狀：同一支影片預抓完 836 句後重整頁面，共用快取仍然只回報 87 句，
 * 整支又重翻一次。因為 SW 在重整之間沒有被回收，回的是開場那份舊 bundle。
 * 使用者完全看不出來，只會覺得「怎麼又在翻」。（handoff 坑 #23）
 *
 * 90 秒是折衷：夠短，讓重整或別人剛灌進去的譯文很快被看到；
 * 夠長，不會讓正常觀看途中反覆打後端。
 */
const BUNDLE_TTL_MS = 90 * 1000;

async function getBundle(cid, force) {
  if (!cid) return { lines: {}, count: 0, segCount: 0 };

  const cached = memCache.bundles.get(cid);
  if (cached && !force && Date.now() - cached.at < BUNDLE_TTL_MS) return cached;

  try {
    // cache: 'no-store' 是第二道保險。後端 v1.6 起已改成 no-store，但使用者的
    // 後端可能還沒部署，而舊回應帶著 max-age=60——那層 HTTP 快取我們清不掉，
    // 會讓剛寫進去的 segCount 整整一分鐘看不到（坑 #26）。
    const d = await api(`/v1/subs?cid=${encodeURIComponent(cid)}`, { cache: 'no-store' });
    const entry = { lines: d.lines || {}, count: d.count || 0, segCount: d.segCount || 0, at: Date.now() };
    memCache.bundles.set(cid, entry);
    // 只留最近 3 支，避免 SW 記憶體無限成長
    if (memCache.bundles.size > 3) memCache.bundles.delete(memCache.bundles.keys().next().value);
    return entry;
  } catch (e) {
    return { lines: {}, count: 0, segCount: 0, error: String(e.message || e) };
  }
}

/**
 * 後備路徑：這支影片還沒被收割過時，逐句向後端要翻譯。
 * 後端會先查自己的單句快取，未命中才呼叫模型，並把結果存起來——
 * 所以就算是「第一個看的人」，他翻過的每一句也都會嘉惠後面的人。
 */
// ---------------------------------------------------------------------------
// 帳號
// ---------------------------------------------------------------------------
const SITE = 'https://pitlingo.com';

/**
 * 第一次安裝 → 打開網站的「安裝完成」頁（2026-10-24 Ray）。告訴使用者裝好了、下一步去 F1TV。
 * ⚠️ 只有 reason === 'install'。更新版本、Chrome 更新（chrome_update）都不開——
 *    每次自動更新都跳一個分頁會被當成騷擾，也是商店常見的檢舉理由。
 * ⚠️ 網址不帶任何參數：不需要，也不該把安裝資訊交給網頁。
 * 管理版不開：那是我們自己的收割端，排程開的 Chrome 第一次載入時不該多一個分頁。
 */
let welcomeOnInstall = true;
/* @admin-only:start */
welcomeOnInstall = false;
/* @admin-only:end */
chrome.runtime.onInstalled.addListener((d) => {
  if (!d || d.reason !== 'install' || !welcomeOnInstall) return;
  chrome.tabs.create({ url: SITE + '/welcome' }).catch(() => {});
});

/**
 * ⚠️ **快取 10 分鐘**（2026-10-04 修）。每個開著的 F1TV 分頁每 60 秒就問一次（refreshLicensed），
 *    以前每次都打 /v1/account/me——那支要讀帳號、每組授權碼、AuthGuard，還要列訂單。
 *    一個人看三小時就是 180 次，一百個人就吃掉 KV 每天十萬次讀取的大半，list 也會撞 1,000 次的牆。
 *    設定頁打開時用 force（使用者正在看，要最新的）；登入、登出時清掉快取。
 */
let acctCache = null;   // { at, tok, result }
const ACCT_CACHE_MS = 10 * 60 * 1000;

async function accountStatus(force) {
  // ⚠️ 快取要綁「當時的登入權杖」（2026-10-31 R19 FP2 Ray 實測）：沒登入時快取了 { signedIn: false }，
  //    登入的那一刻影片分頁收到 accountToken 變動就來問——拿到的是**舊的「沒登入」**，
  //    免費額度停在 5 分鐘、已經用完的人照樣被擋，要重新整理頁面才變 15 分鐘。權杖變了就重問
  const { accountToken } = await chrome.storage.local.get('accountToken');
  const tok = accountToken || '';
  if (!force && acctCache && acctCache.tok === tok && Date.now() - acctCache.at < ACCT_CACHE_MS) return acctCache.result;
  const r = await accountStatusFresh();
  // 離線的結果不快取：網路一恢復就要能拿到真的狀態
  acctCache = r && r.offline ? null : { at: Date.now(), tok, result: r };
  return r;
}

async function accountStatusFresh() {
  const { accountToken, accountProfile } = await chrome.storage.local.get(['accountToken', 'accountProfile']);
  if (!accountToken) return { signedIn: false };
  // ⚠️ 只問一次伺服器，失敗**不要當成登出**——可能只是暫時連不上，
  //    而把人登出會讓他的免費額度突然從 15 分鐘掉到 5 分鐘。
  try {
    const d = await api('/v1/account/me');
    const prof = (d && d.profile) || {};
    await chrome.storage.local.set({ accountProfile: prof });
    return { signedIn: true, profile: prof, licenses: (d.licenses || []).length };
  } catch (e) {
    if (e.status === 401) {
      await chrome.storage.local.remove(['accountToken', 'accountProfile']);
      // 授權綁帳號（2026-10-04 起）：登入失效＝這台的授權也停（伺服器續期會拒絕）。
      // 現在就停，畫面才不會說「已啟用」卻翻不出來。授權碼留著，重新登入就自動恢復。
      await pauseLicense('登入已失效，授權暫停。重新登入帳號即可恢復。');
      return { signedIn: false, expired: true };
    }
    return { signedIn: true, profile: accountProfile || {}, offline: true };
  }
}

/**
 * 開分頁讓使用者登入，然後用一次性配對碼把工作階段帶回來。
 *
 * ⚠️ 配對碼必須**不可猜**（這裡用 crypto.randomUUID，122 bits）、
 *    **單次有效**、**短效**（後端 TTL 5 分鐘）。它會出現在網址列，
 *    可能被瀏覽器記錄或被整條複製分享出去。
 */
async function accountLink() {
  const nonce = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '').slice(0, 40);
  // ⚠️ 先向伺服器登記這組配對碼（綁住這個安裝），拿回 4 碼確認碼顯示在彈出視窗上；
  //    使用者要在網站上輸入它（security-audit 2026-10-05 #1：以前網站拿到 ?link= 就自動配對，
  //    別人自己編一組碼丟連結給你就能拿到你的登入）。
  let code = '';
  try {
    const s = await api('/v1/auth/link/start', { method: 'POST', body: JSON.stringify({ nonce }) });
    code = (s && s.code) || '';
  } catch (e) {
    return { signedIn: false, error: e.message || '無法開始登入' };
  }
  // ⚠️ 開分頁的那一刻**彈出視窗就會關掉**（Chrome 的行為，焦點離開就關）——確認碼原本只顯示在
  //    彈出視窗裡，使用者到了網站上卻看不到要輸入什麼（2026-10-06 使用者回報）。所以：
  //    1. 確認碼同時顯示在工具列圖示的徽章上（4 碼剛好放得下），在網站上一抬頭就看得到；
  //    2. linkPending 留在 storage，重新打開彈出視窗會再顯示一次（options.js 啟動時讀）。
  //    id 用來分辨「哪一次配對」：使用者重新產生確認碼時，舊的那一輪要自己停、而且不可以清掉新的。
  const id = nonce.slice(0, 8);
  await chrome.storage.local.set({ linkPending: { code, id, until: Date.now() + 5 * 60000 } });
  await linkBadge(code);
  await chrome.tabs.create({ url: `${SITE}/account?link=${nonce}` });
  try {
    return await accountLinkPoll(nonce, id);
  } finally {
    const { linkPending } = await chrome.storage.local.get('linkPending');
    if (!linkPending || linkPending.id === id) {
      await chrome.storage.local.remove('linkPending');
      await linkBadge('');
    }
  }
}

/** 工具列圖示的徽章：配對期間顯示確認碼。測試環境沒有 chrome.action 也不能壞。 */
async function linkBadge(code) {
  try {
    if (!chrome.action || !chrome.action.setBadgeText) return;
    if (code) await chrome.action.setBadgeBackgroundColor({ color: '#e10600' });
    await chrome.action.setBadgeText({ text: code || '' });
  } catch (e) { /* 徽章只是方便，失敗不影響配對 */ }
}

async function accountLinkPoll(nonce, id) {
  // 輪詢等使用者登入完成。⚠️ **一定要有上限**（坑 #3）——
  //    使用者可能關掉分頁、可能去泡咖啡，不能讓這個迴圈永遠跑。
  // ⚠️ 彈出視窗關掉之後，這個迴圈是 SW 自己在跑。MV3 的 SW 閒置 30 秒會被收掉，
  //    而 fetch 不算「活動」——每一輪讀一次 storage（擴充功能 API）讓它活著，
  //    順便檢查這一輪是不是已經被新的配對取代。
  const DEADLINE = Date.now() + 5 * 60000;
  const STEP = 2000;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, STEP));
    if (id) {
      const { linkPending } = await chrome.storage.local.get('linkPending');
      if (linkPending && linkPending.id !== id) return { signedIn: false, superseded: true };
    }
    let d = null;
    try { d = await api(`/v1/auth/link?nonce=${encodeURIComponent(nonce)}`); } catch (e) { d = null; }
    if (d && d.token) {
      await chrome.storage.local.set({ accountToken: d.token });
      const st = await accountStatus(true);
      // 登入完成：授權綁帳號，所以這裡順便把授權接回來（記得的授權碼、或帳號裡有效的那一組）
      try { st.license = await licenseAfterLogin(); } catch (e) { /* 失敗時設定頁會顯示原因 */ }
      return st;
    }
  }
  return { signedIn: false, timeout: true };
}

/**
 * 暫停這台的授權（登出、登入失效時）。**授權碼留著**——重新登入後 licenseAfterLogin 會接回來。
 */
async function pauseLicense(reason) {
  const { licenseKey } = await chrome.storage.local.get('licenseKey');
  if (!licenseKey) return;
  await chrome.storage.local.remove(LIC_DISPLAY_KEYS);
  await chrome.storage.local.set({ licRevokedReason: reason, entCheckedAt: Date.now() });
}

/**
 * 登入之後把授權接回來。**以帳號為準**（2026-10-30，後端 v5.81）：
 *   1. 記得授權碼 → 用它重新啟用（同一台裝置重複啟用不佔名額；那組不能用了伺服器會換成帳號裡能用的）
 *   2. 不記得、或那組不是這個帳號的 → 不帶碼啟用，伺服器從帳號裡挑，**不必再貼一次**
 * 挑哪一組由伺服器決定（pickAccountLicense）：用戶端不再讀 /v1/account/me 自己挑——
 * 用戶端挑過一次就出過錯（還沒生效的碼也是 active，會在兩組之間來回換）。
 */
async function licenseAfterLogin() {
  const { licenseKey } = await chrome.storage.local.get('licenseKey');
  if (licenseKey) {
    const r = await licenseActivate(licenseKey);
    if (r && r.ok) return r;
  }
  const r2 = await licenseActivate('', { fromAccount: true });
  return r2 && r2.ok ? r2 : null;
}

async function translateLines(cid, lines, urgent, slug, extra) {
  if (!lines || !lines.length) return { lines: {} };
  // live：直播中（後端據此判斷前導收割端不在時要不要告警）；leader：管理版的前導收割模式
  const x = extra || {};
  try {
    return await api('/v1/translate', {
      method: 'POST',
      // urgent = 畫面上現在就要用。後端只讓**非急件**參與直播的並發去重，
      // 因為讓路的人要等別人翻完再讀快取，而直播字幕 3~4 秒就換一句。
      // **預設是急件**：漏標的後果是多花一點錢，標錯方向的後果是看不到字幕。
      // slug：伺服器要靠它判斷這支影片算不算免費場次（那條規則以前只在用戶端）
      body: JSON.stringify({
        cid: cid || 'misc', lines, urgent: urgent !== false, slug: slug || '',
        ...(x.live ? { live: true } : {}), ...(x.leader ? { leader: true } : {}),
      }),
    });
  } catch (e) {
    return { lines: {}, error: String(e.message || e) };
  }
}

/**
 * 告訴後端「這支影片的字幕已被完整收割」，讓後續觀看者跳過整軌預抓。
 *
 * 標記成功後要把本機的 bundle 快取作廢，否則同一個 SW 生命週期內
 * 下一次 getBundle 還是回舊的 segCount=0，跳過判斷永遠不會生效。
 */
async function markComplete(cid, segCount, slug, noSubtitles) {
  // ⚠️ **`segCount === 0` 是「這支影片沒有官方字幕軌」的合法回報，不是缺參數。**
  //
  //    這裡原本是 `if (!cid || !segCount)`，於是每一筆「沒有字幕」的回報
  //    **在離開瀏覽器之前就被丟掉**——沒有錯誤、沒有日誌，
  //    而後台的「沒有字幕的影片」永遠是 0。
  //    那個 0 看起來像「這個問題不存在」，實際上是「我們從來沒量過」。
  //    偵測、回報、儲存、顯示四段全都寫好了，卡在這一行。
  if (!cid) return { ok: false };
  if (!noSubtitles && !segCount) return { ok: false };
  try {
    const d = await api('/v1/complete', {
      method: 'POST',
      // slug 是後台唯一能分辨「這是哪一場的哪個場次」的東西——
      // 我們只存 contentId，那是一串數字，人看不出是澳洲正賽還是賽後訪問。
      body: JSON.stringify({ cid, segCount, slug: slug || '', noSubtitles: !!noSubtitles }),
    });
    memCache.bundles.delete(cid);
    return d;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// 授權
//
// **授權碼綁人，安裝權杖綁裝置。** 兩者不可混用——
// 用安裝權杖當付費憑證的話，使用者換一台電腦就失效。
//
// 通行證（entitlement）存在本機，過期前都算有效。
// **後端連不上時不要把功能鎖起來**：伺服器出問題是我們的錯，
// 不該讓已付費的人看不到字幕。
// ---------------------------------------------------------------------------
// 通行證有效期 14 天是為了**離線容忍度**：後端掛掉時已付費的人還能撐兩週。
// 但如果只在快到期時才續，停用（退款、盜用、chargeback）最久要 11 天才生效——
// 那對開發者完全沒有保護。
//
// 拆成兩個時間：
//   RECHECK   每 24 小時主動回報一次。停用後最多一天生效。
//   有效期    仍是 14 天。後端連不上時**不會**把功能鎖起來，只是續不到而已。
// 兩者互不衝突：正常情況每天續一次，異常情況靠 14 天的緩衝撐著。
const ENT_RECHECK_MS = 24 * 3600 * 1000;

/** 授權的本機狀態（通行證與設定頁顯示用的欄位）。停用、清除時一起清。 */
const LIC_DISPLAY_KEYS = ['entitlement', 'entExp', 'licPlan', 'licPlanLabel', 'licGpName', 'licGpCount',
  'licWindows', 'licNextLabel', 'licExpiresAt', 'entCheckedAt'];

/**
 * @param {boolean} force 立刻向後端問一次，不用等 24 小時的週期。
 *
 * 設定頁開啟時要用 force。使用者按圖示的當下就是他在確認狀態的當下——
 * 那時給他一個最多過時 24 小時的答案，等於讓畫面說謊。
 * 一次請求的成本可以忽略，而且離線時 `licenseRenew` 不會清掉任何東西。
 */
async function licenseStatus(force) {
  if (force) {
    const { licenseKey, accountToken } = await chrome.storage.local.get(['licenseKey', 'accountToken']);
    if (licenseKey) await licenseRenew().catch(() => {});
    // 登入了但還沒有任何授權碼（先登入、後來才買）：打開設定頁時問一次帳號裡有沒有
    else if (accountToken) await licenseActivate('', { fromAccount: true }).catch(() => {});
  }
  const st = await chrome.storage.local.get(['licenseKey', 'entitlement', 'entExp', 'licPlan',
    'licPlanLabel', 'licGpName', 'licGpCount', 'licWindows', 'licNextLabel',
    'licExpiresAt', 'entCheckedAt']);
  if (!st.entitlement || !st.entExp) {
    // ⚠️ 記得授權碼、但目前沒有通行證（比賽週之間的空檔、暫時被拒、剛重新登入）：
    //    **每小時自己再試一次續期**（2026-10-04 修）。以前只有打開設定頁（force）才會再問，
    //    跳著買比賽週的人在下一站開始時一直停在免費模式，除非他剛好點開擴充功能。
    const { accountToken } = await chrome.storage.local.get('accountToken');
    if (!force && (st.licenseKey || accountToken) && (!st.entCheckedAt || Date.now() - st.entCheckedAt > 3600 * 1000)) {
      // 沒記得碼但登入了（先登入、後來才在網站買）：每小時問一次帳號——買完不必重新登入或貼碼
      const r = st.licenseKey
        ? await licenseRenew().catch(() => null)
        : await licenseActivate('', { fromAccount: true }).catch(() => null);
      if (r && r.ok && !r.pending) return licenseStatus();
      await chrome.storage.local.set({ entCheckedAt: Date.now() });
    }
    const { licRevokedReason } = await chrome.storage.local.get('licRevokedReason');
    return { active: false, reason: licRevokedReason || '' };
  }

  const expMs = st.entExp * 1000;
  if (expMs < Date.now()) {
    // 過期了，試著續一次。續不到也先回報未啟用，但**不刪掉授權碼**——
    // 可能只是後端暫時掛掉，網路恢復後還要能自動續回來。
    const r = await licenseRenew();
    if (!r.ok) return { active: false, expired: true, licenseKey: st.licenseKey };
    return licenseStatus();
  }

  // 距離上次回報超過 24 小時就在背景續一次，不擋使用者。
  // 這是停用能生效的唯一途徑，不能省。
  if (!st.entCheckedAt || Date.now() - st.entCheckedAt > ENT_RECHECK_MS) {
    licenseRenew().catch(() => {});
  }

  return {
    active: true,
    plan: st.licPlan || 'season',
    planLabel: st.licPlanLabel || '',
    gpName: st.licGpName || '',
    gpCount: st.licGpCount || 0,
    windows: st.licWindows || null,
    nextLabel: st.licNextLabel || '',
    expiresAt: st.licExpiresAt || null,
    licenseKey: st.licenseKey || '',
  };
}

async function licenseActivate(licenseKey, opts) {
  let key = String(licenseKey || '').trim();
  // fromAccount：不帶碼，由伺服器從登入的帳號裡挑（登入後、每小時的自動檢查）。使用者手動按「啟用」一定要有碼
  if (!key && !(opts && opts.fromAccount)) return { ok: false, error: '請輸入授權碼' };
  try {
    const d = await api('/v1/license/activate', { method: 'POST', body: JSON.stringify({ licenseKey: key }) });
    if (!d || !d.ok) return d || { ok: false, error: '啟用失敗' };
    // 實際用的是哪一組以伺服器回的為準（它可能換成帳號裡能用的那一組）
    if (d.licenseKey) key = String(d.licenseKey);
    // 還沒開始（提前買的 Weekend Pass／比賽週之間）：伺服器已登記這台，只是還沒有通行證。
    // 記住授權碼，licenseStatus 每小時會自己再續一次，開始那一刻就接上。
    if (d.pending) {
      await chrome.storage.local.remove(LIC_DISPLAY_KEYS);
      await chrome.storage.local.set({ licenseKey: key, licRevokedReason: d.message || '尚未生效', entCheckedAt: Date.now() });
      return d;
    }
    await chrome.storage.local.set({
      licenseKey: key, entitlement: d.entitlement, entExp: d.exp,
      licPlan: d.plan, licPlanLabel: d.planLabel || '',
      licGpName: d.gpName || '', licGpCount: d.gpCount || 0,
      // 比賽週區間。設定頁靠它算「剩餘多久」與「下一段何時生效」。
      licWindows: d.windows || null, licNextLabel: d.nextLabel || '',
      licExpiresAt: d.expiresAt || null,
      entCheckedAt: Date.now(), licRevokedReason: '',
    });
    return d;
  } catch (e) {
    // api() 現在會把伺服器的訊息與 body 一起帶回來，
    // 所以裝置上限（409 + devices 清單）不用再重打一次請求。
    return Object.assign({ ok: false, error: e.message }, e.data || {});
  }
}

async function licenseRenew() {
  const { licenseKey } = await chrome.storage.local.get('licenseKey');
  if (!licenseKey) return { ok: false };
  try {
    // ⚠️ 要帶登入權杖：授權綁帳號之後，伺服器續期會驗「登入的帳號擁有這組碼」（2026-10-04）
    const { accountToken } = await chrome.storage.local.get('accountToken');
    const headers = { 'content-type': 'application/json', 'x-client-token': await getClientToken() };
    if (accountToken) headers.authorization = 'Bearer ' + accountToken;
    const res = await fetch(BACKEND + '/v1/license/renew', {
      method: 'POST', headers, body: JSON.stringify({ licenseKey }),
    });
    const d = await res.json().catch(() => ({}));
    // 伺服器順便換了一枚新的登入權杖（舊的快到期了）。存起來，否則 30 天後授權會跟著停。
    if (d && typeof d.accountToken === 'string' && d.accountToken) {
      await chrome.storage.local.set({ accountToken: d.accountToken });
    }

    // 403 = 已停用／已過期／這台裝置已被解除。
    // 404 = 授權碼**已被刪除**（後台永久刪除，或客服重新發碼）。
    //
    // 兩者都是**確定的否定答案**，要立刻清掉本機狀態。
    // ⚠️ 原本只判 403。實際回報的症狀就是這個漏洞：後台把授權碼刪掉之後，
    //    續期收到 404，程式碼一路往下走到「不是 ok 就什麼都不做」，
    //    於是本機的通行證原封不動，擴充功能持續顯示「已啟用」最長 14 天。
    //    不報錯、沒有日誌，只有使用者看得到那個錯的狀態。
    //
    // 其他錯誤（500、逾時、斷網）一律不動——那可能只是後端暫時有事，
    // 把付費使用者的授權清掉才是真正的傷害。
    if (res.status === 403 || res.status === 404) {
      await chrome.storage.local.remove(LIC_DISPLAY_KEYS);
      await chrome.storage.local.set({
        entCheckedAt: Date.now(),
        licRevokedReason: d.error || (res.status === 404 ? '這份授權已不存在' : '授權已停用'),
      });
      // （本賽季票到期、下一賽季票接手這類換碼，伺服器在續期時就做掉了——走到這裡代表帳號裡也沒有能用的）
      return { ok: false, revoked: true, error: d.error };
    }
    if (res.ok && d && d.ok) {
      const upd = {
        entitlement: d.entitlement, entExp: d.exp, licPlan: d.plan,
        licPlanLabel: d.planLabel || '', licGpName: d.gpName || '', licGpCount: d.gpCount || 0,
        licWindows: d.windows || null, licNextLabel: d.nextLabel || '',
        entCheckedAt: Date.now(), licRevokedReason: '',
      };
      // 伺服器換了一組（原本那組不能用了，帳號裡另一組接手）→ 記住新的，下次直接續它
      if (d.licenseKey) upd.licenseKey = String(d.licenseKey);
      // ⚠️ 「有效期至」也要更新。以前只有啟用時寫一次，後台延期、
      //    賽程異動之後設定頁顯示的永遠是啟用當下的日期。
      if (d.expiresAt !== undefined) upd.licExpiresAt = d.expiresAt || null;
      await chrome.storage.local.set(upd);
    }
    return d || { ok: false };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/**
 * 在這台停用：**也要把這台從伺服器的裝置名單拿掉**（2026-10-04 修）。
 * 以前只清本機，伺服器上這台仍佔著一個名額——按三次「在這台停用」再換電腦，
 * 就會被「已達裝置上限」擋住，而使用者明明已經停用過了。
 * 後端用安裝權杖認出是本人這一台（1.0.2 起只能解除自己這一台，別台在網站「我的帳號」）。
 * 呼叫端（設定頁「在這台停用並登出」）會接著登出——否則每小時的檢查會從帳號把授權接回來。
 * 連不上也照樣清本機：使用者的意思是「這台不要用了」，不能因為網路擋住。
 */
async function licenseClear() {
  const { licenseKey } = await chrome.storage.local.get('licenseKey');
  const iid = await getInstallId();
  if (licenseKey && iid) {
    try {
      await api('/v1/license/deactivate', { method: 'POST', body: JSON.stringify({ licenseKey, installId: iid }) });
    } catch (e) { /* 伺服器那邊之後由使用者在「管理裝置」或「我的帳號」解除 */ }
  }
  await chrome.storage.local.remove(['licenseKey', 'licRevokedReason'].concat(LIC_DISPLAY_KEYS));
}

// ---------------------------------------------------------------------------
// F1TV 串流資源
//
// 為什麼要在這裡發請求，而不是在 content script：
//   1. 有 host_permissions 的 SW 不受頁面 CSP 限制
//   2. CDN 是跨來源，content script 的 fetch 會被 CORS 擋
//
// 為什麼要拿這些：擴充功能若只讀畫面上的 DOM，提前量是 0，
// 逐句翻譯永遠追不上轉播語速。拿到 VTT 才有提前量（實測 47~53 秒），
// 那正是 userscript 跟得上而擴充功能跟不上的原因。
// ---------------------------------------------------------------------------

/**
 * 純文字抓取（m3u8 / vtt）。帶上使用者的 session。
 *
 * 這是整軌預抓唯一需要的網路能力：字幕清單的位址由 content script 從
 * worker 攔到的 manifest 取得，這裡只負責把它抓下來（CDN 是跨來源，
 * content script 自己 fetch 會被 CORS 擋）。
 *
 * PLAY API 那整套（權杖掃描、header 組合、cookie 讀取）已於 v0.4.0 移除——
 * 八個版本都沒通，而且新的預抓入口根本不需要授權。
 */
// 只允許抓這些網域。**這個白名單是必要的，不是防禦性程式設計。**
//
// 字幕清單的網址來自 content script，而 content script 是從 MAIN world 的
// window.postMessage 收來的——**頁面上任何腳本都能偽造那個訊息**。
// 沒有白名單的話，F1TV 頁面上的第三方腳本（廣告、分析、被入侵的 CDN）
// 就能讓這個擴充功能帶著使用者的 cookie 去抓任意網址。
// ⚠️ **F1TV 會依內容換 CDN 主機名。** 實測（2026-08-21 直播）：
//      重播  ott-video-fer-cf.formula1.com
//      直播  ott-video-cf.formula1.com      ← 少了 "fer"
//
//    舊版寫死那兩個字串，於是**直播的整軌預抓從來沒有成功過**——
//    診斷報告裡是一行「網址不在允許清單內，已拒絕」，功能退化成
//    只靠 worker 攔到的分段，但不報錯、畫面上也看不出來。
//
//    改成樣式比對，涵蓋現在與未來的 ott-video 變體。
//    **仍然只限 formula1.com 底下的 ott-video / f1tv 主機**——
//    這個白名單是必要的：字幕清單的網址來自 content script，
//    而那是從 MAIN world 的 postMessage 收來的，頁面上任何腳本都能偽造。
const FETCH_ALLOW_RE = /^(ott-video[a-z0-9-]*|f1tv)\.formula1\.com$/i;
// ⚠️ F1TV 也會把字幕清單放在 Akamai（2026-11-01 R19 排位重播實測：f1prodlive.akamaized.net，路徑 /v2/hdntl=…）。
//    沒列進來時整軌預抓「網址不在允許清單內」靜默退化。akamaized.net 是所有 Akamai 客戶共用的網域，
//    **只能列完整主機名，不可以用 *.akamaized.net**（那等於允許任何人的 Akamai 主機）。manifest 的 host_permissions 同步
const FETCH_ALLOW_HOSTS = new Set(['f1prodlive.akamaized.net']);

function isAllowedFetch(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return FETCH_ALLOW_RE.test(u.hostname) || FETCH_ALLOW_HOSTS.has(u.hostname.toLowerCase());
  } catch (e) { return false; }
}

async function fetchText(url) {
  if (!isAllowedFetch(url)) throw new Error('網址不在允許清單內，已拒絕');
  // ⚠️ `priority: 'low'` 不是可有可無的優化，是**正確性層級的**。
  //    這些請求打的是與影片同一個 CDN 主機，HTTP/2 之下共用同一條連線。
  //    不標低優先權的話，瀏覽器會把「40 分鐘後才要用的字幕」和
  //    「現在就要播的影片分段」排在同一個優先級 —— 播放器的 ABR 量到
  //    吞吐量下降就會降解析度。使用者實測：開擴充功能就卡，關掉就正常。
  //    舊版 Chrome 不支援這個欄位時會直接忽略，不會出錯。
  const res = await fetch(url, { credentials: 'include', priority: 'low' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// 與 content script 的訊息通道
// ---------------------------------------------------------------------------
/* @test-only:start */
// ---------------------------------------------------------------------------
// 語音辨識測試（**只在測試版存在**，正式版建置時整段移除）
//
// 設定頁（使用者手勢）拿到 streamId → 這裡開 offscreen document 擷取聲音並上傳辨識
// → offscreen 把結果送回來 → 這裡轉給那個分頁的 content script（offscreen 沒有 chrome.tabs）。
// ---------------------------------------------------------------------------
const ASR_OFFSCREEN = 'src/test/offscreen.html';
// 語音辨識打的是**測試後端**，不是正式後端（2026-09-17 使用者決定：測試端點不放 api.pitlingo.com）。
// 見 backend/wrangler.test.toml。其他 API（翻譯、授權、設定）照常打 BACKEND。
const ASR_BACKEND = 'https://f1zh-api-test.pitlingo.workers.dev';

async function asrEnsureOffscreen() {
  if (!chrome.offscreen) throw new Error('這個版本沒有 offscreen 權限——請載入 dist/pitlingo-test');
  const ctxs = chrome.runtime.getContexts
    ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [];
  if (ctxs.length) return;
  await chrome.offscreen.createDocument({
    url: ASR_OFFSCREEN, reasons: ['USER_MEDIA'], justification: '語音辨識測試：擷取分頁聲音',
  });
}

async function asrStart(msg) {
  const { asrTestKey } = await chrome.storage.local.get('asrTestKey');
  if (!asrTestKey) return { ok: false, error: '請先填測試金鑰' };
  await asrEnsureOffscreen();
  const r = await chrome.runtime.sendMessage({
    target: 'offscreen', type: 'asr-start', streamId: msg.streamId, tabId: msg.tabId,
    backend: ASR_BACKEND, asrKey: asrTestKey, clientToken: await getClientToken(), chunkSec: msg.chunkSec || 5,
    // 實驗室模式（asr-lab.html）：先只量音量，收割時才上傳；監聽＝接回喇叭
    mode: msg.mode === 'lab' ? 'lab' : 'live', overlapSec: msg.overlapSec || 0,
    upload: !!msg.upload, translate: !!msg.translate, words: msg.words !== false, monitor: msg.monitor !== false,
  });
  if (r && r.ok) await chrome.storage.local.set({ asrRunning: { tabId: msg.tabId, at: Date.now(), mode: msg.mode === 'lab' ? 'lab' : 'live' } });
  return r || { ok: false, error: 'offscreen 沒有回應' };
}

async function asrStop() {
  const { asrRunning, asrTest } = await chrome.storage.local.get(['asrRunning', 'asrTest']);
  try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'asr-stop' }); } catch (e) { /* 已經關了 */ }
  try { if (chrome.offscreen) await chrome.offscreen.closeDocument(); } catch (e) { /* 已經關了 */ }
  await chrome.storage.local.remove('asrRunning');
  await chrome.storage.local.set({ asrTest: Object.assign({}, asrTest || {}, { on: false }) });
  if (asrRunning && asrRunning.tabId) chrome.tabs.sendMessage(asrRunning.tabId, { type: 'asrStopped' }).catch(() => {});
  return { ok: true };
}

/** offscreen 送回來的結果：轉給分頁，並更新設定頁看得到的統計。 */
async function asrRelay(msg) {
  if (msg.type === 'asr-ended') { await asrStop(); return; }
  // 音量每 0.5 秒一次、實驗室的收割結果：實驗室頁自己直接收，不轉給分頁、也不寫統計
  //（寫 storage 每秒兩次沒有必要，黃框也不該顯示沒翻譯的收割段）
  if (msg.type === 'asr-level' || msg.mode === 'lab') return;
  if (msg.tabId) chrome.tabs.sendMessage(msg.tabId, { type: 'asrCues', data: msg }).catch(() => {});
  const { asrStats } = await chrome.storage.local.get('asrStats');
  const s = Object.assign({ chunks: 0, silent: 0, errors: 0, segments: 0 }, asrStats || {});
  if (msg.type === 'asr-chunk' || msg.type === 'asr-result') s.chunks++;
  if (msg.silent) s.silent++;
  if (msg.type === 'asr-result' && !msg.ok) { s.errors++; s.lastError = msg.error || ('HTTP ' + msg.status); }
  if (msg.type === 'asr-result' && msg.ok) s.segments += (msg.segments || []).length;
  if (typeof msg.rms === 'number') s.lastRms = msg.rms;
  await chrome.storage.local.set({ asrStats: s });
}
/* @test-only:end */

/* @test-only:start */
// ---------------------------------------------------------------------------
// 彈幕（**只在測試版**，2026-10-28 Ray：先做好、不發行，handoff 9.1 #23）
//
// WebSocket 開在這裡（service worker），不開在 content script：
//   · F1TV 頁面的 CSP 管不到這裡；連線的身分（權杖、通行證、登入）也只在這裡讀
//   · Chrome 116 起，SW 裡有收發訊息的 WebSocket 會讓 SW 保持清醒（每 20 秒 ping 一次）
// 分頁（src/test/danmaku-content.js）每 60 秒送一次 dmOpen——SW 被回收、連線斷掉都會被補回來
// （鐵則 4：不要相信「連一次就永遠有效」）。重連有上限（鐵則 3）。
// ---------------------------------------------------------------------------
const DM_WS_BASE = BACKEND.replace(/^http/, 'ws');
const DM_MAX_RETRY = 8;
const dmConns = new Map();       // tabId -> { cid, ws, ticket, ticketAt, retry, ping, closing }

async function dmTicketFor(c) {
  if (c.ticket && Date.now() - c.ticketAt < 45000) return c.ticket;
  const d = await api('/v1/dm/ticket?cid=' + encodeURIComponent(c.cid), { method: 'POST' });
  c.ticket = d.ticket;
  c.ticketAt = Date.now();
  c.post = !!d.post;
  c.unpaid = !!d.unpaid;           // 未付費：看得到、不能發（2026-10-28 Ray）
  return c.ticket;
}

function dmTell(tabId, data) {
  chrome.tabs.sendMessage(tabId, { type: 'dmEvent', data }).catch(() => {});
}

function dmClose(tabId) {
  const c = dmConns.get(tabId);
  if (!c) return;
  c.closing = true;
  clearInterval(c.ping);
  try { if (c.ws) c.ws.close(1000, 'bye'); } catch (e) { /* 已經關了 */ }
  dmConns.delete(tabId);
}

async function dmConnect(tabId, c) {
  let t;
  try {
    t = await dmTicketFor(c);
  } catch (e) {
    // 尚未開放（E82）、收割端（E81）不是故障，不重試
    const code = e.data && e.data.code;
    dmTell(tabId, { t: 'denied', code: code || '', msg: String(e.message || e) });
    dmConns.delete(tabId);
    return;
  }
  const ws = new WebSocket(DM_WS_BASE + '/v1/dm/ws?cid=' + encodeURIComponent(c.cid) + '&t=' + encodeURIComponent(t));
  c.ws = ws;
  c.ticket = null;               // 憑證用過就丟，重連時換新的
  ws.onopen = () => { c.retry = 0; };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t !== 'pong') dmTell(tabId, m);
  };
  ws.onclose = () => {
    clearInterval(c.ping);
    if (c.closing || dmConns.get(tabId) !== c) return;
    if (++c.retry > DM_MAX_RETRY) { dmTell(tabId, { t: 'down' }); dmConns.delete(tabId); return; }
    setTimeout(() => { if (dmConns.get(tabId) === c) dmConnect(tabId, c); }, Math.min(30000, 1000 * 2 ** c.retry));
  };
  clearInterval(c.ping);
  c.ping = setInterval(() => { try { if (ws.readyState === 1) ws.send('{"t":"ping"}'); } catch (e) { /* 等 onclose */ } }, 20000);
}

async function dmOpen(tabId, cid) {
  const cur = dmConns.get(tabId);
  if (cur && cur.cid === cid && cur.ws && cur.ws.readyState <= 1) return { ok: true, post: cur.post, unpaid: cur.unpaid };
  if (cur) dmClose(tabId);
  const c = { cid, ws: null, ticket: null, ticketAt: 0, retry: 0, ping: null, closing: false, post: false, unpaid: false };
  dmConns.set(tabId, c);
  await dmConnect(tabId, c);
  return { ok: dmConns.has(tabId), post: c.post, unpaid: c.unpaid };
}

function dmSend(tabId, obj) {
  const c = dmConns.get(tabId);
  if (!c || !c.ws || c.ws.readyState !== 1) return false;
  c.ws.send(JSON.stringify(obj));
  return true;
}

/** 重播：影片第 b 個 30 秒。憑證要另外換（不經過 WebSocket，邊緣快取才有用）。 */
async function dmRange(tabId, cid, b) {
  const c = dmConns.get(tabId) || { cid };
  if (c.cid !== cid) return { ok: false };
  const t = await dmTicketFor(c);
  const res = await fetch(BACKEND + '/v1/dm/range?cid=' + encodeURIComponent(cid) + '&b=' + b + '&t=' + encodeURIComponent(t));
  if (!res.ok) return { ok: false };
  return { ok: true, items: ((await res.json()) || {}).items || [] };
}

if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener((tabId) => dmClose(tabId));
/* @test-only:end */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  /* @test-only:start */
  if (msg && typeof msg.type === 'string' && /^dm[A-Z]/.test(msg.type) && msg.type !== 'dmEvent') {
    const tabId = sender.tab && sender.tab.id;
    const cid = String(msg.cid || '');
    if (!tabId || !/^\d{1,20}$/.test(cid) && msg.type !== 'dmClose') { sendResponse({ ok: false }); return false; }
    (async () => {
      try {
        if (msg.type === 'dmOpen') sendResponse(await dmOpen(tabId, cid));
        else if (msg.type === 'dmClose') { dmClose(tabId); sendResponse({ ok: true }); }
        else if (msg.type === 'dmSay') sendResponse({ ok: dmSend(tabId, { t: 'say', x: String(msg.x || ''), pos: msg.pos, live: !!msg.live, n: msg.n }) });
        else if (msg.type === 'dmReport') sendResponse({ ok: dmSend(tabId, { t: 'report', id: msg.id }) });
        else if (msg.type === 'dmRange') sendResponse(await dmRange(tabId, cid, Math.floor(Number(msg.b)) || 0));
        else sendResponse({ ok: false });
      } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
    })();
    return true;
  }
  /* @test-only:end */
  /* @test-only:start */
  if (msg && msg.target === 'offscreen') return false;          // 給 offscreen 的，不是給這裡
  if (msg && msg.target === 'sw') { asrRelay(msg).catch(() => {}); return false; }
  if (msg && msg.type === 'asrStart') { asrStart(msg).then((r) => sendResponse({ ok: true, result: r })).catch((e) => sendResponse({ ok: true, result: { ok: false, error: String(e.message || e) } })); return true; }
  if (msg && msg.type === 'asrStop') { asrStop().then((r) => sendResponse({ ok: true, result: r })); return true; }
  if (msg && msg.target === 'asrLab') return false;             // 分頁回報給實驗室頁的，不是給這裡
  if (msg && msg.type === 'asrLabInfo') {
    chrome.storage.local.get(['asrTestKey', 'asrRunning']).then((r) => sendResponse({
      ok: true, backend: ASR_BACKEND, hasKey: !!r.asrTestKey, running: r.asrRunning || null,
    }));
    return true;
  }
  /* @test-only:end */
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'getConfig':
          sendResponse({ ok: true, config: await getConfig() });
          break;
        case 'refreshConfig':
          // 強制丟掉快取重抓 —— 驗證熱修流程與緊急狀況都要用到
          memCache.config = null;
          await chrome.storage.local.remove('configCache');
          sendResponse({ ok: true, config: await getConfig() });
          break;
        case 'getSettings':
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case 'getBundle':
          sendResponse({ ok: true, bundle: await getBundle(msg.cid, msg.force) });
          break;
        /* @test-only:start */
        // 目錄頁的翻譯覆蓋標記（handoff 9.1 #18）。測試版功能，進正式版前要問過 Ray（工作規則 7）
        case 'coverageLookup': {
          const cids = (Array.isArray(msg.cids) ? msg.cids : []).filter((c) => /^\d{1,20}$/.test(String(c))).slice(0, 100);
          if (!cids.length) { sendResponse({ ok: true, map: {} }); break; }
          try {
            const d = await api('/v1/coverage', { method: 'POST', body: JSON.stringify({ cids }) });
            sendResponse({ ok: true, map: (d && d.map) || {} });
          } catch (e) {
            sendResponse({ ok: false, error: String(e.message || e) });
          }
          break;
        }
        /* @test-only:end */
        case 'translate':
          sendResponse({ ok: true, result: await translateLines(msg.cid, msg.lines, msg.urgent, msg.slug, { live: msg.live, leader: msg.leader }) });
          break;
        /* @admin-only:start */
        // 前導收割端的心跳（管理版的前導模式，見 main.js leaderLoad）。帶收割權杖（HARVEST_PATHS）
        case 'leaderBeat':
          try { await api('/v1/leader/beat', { method: 'POST', body: JSON.stringify({ cid: String(msg.cid || ''), bye: msg.bye === true }) }); sendResponse({ ok: true }); } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
          break;
        // 自動開直播（harvest.js autoLive）：公開的賽程，不需要任何權杖
        case 'autoLiveSchedule':
          try { sendResponse({ ok: true, result: await api('/v1/schedule') }); } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
          break;
        case 'autoLiveLeader':
          try { sendResponse({ ok: true, result: await api('/v1/leader/status') }); } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
          break;
        /* @admin-only:end */
        // pagehide 觸發的最後一搏。頁面隨時會被凍結，所以立刻回應、
        // 用 keepalive 讓請求在分頁消失後仍然送達。我們不需要譯文，
        // 只是要讓伺服器把它翻出來存進共用快取。
        case 'translateKeepalive':
          sendResponse({ ok: true });
          try {
            const token = await getClientToken();
            // ⚠️ 授權與登入憑證一定要帶，與 api() 相同。以前沒帶，付費使用者關分頁時
            //    送出的最後一批被伺服器當成遊客：吃掉免費額度，或整批被拒。
            const { entitlement, accountToken } = await chrome.storage.local.get(['entitlement', 'accountToken']);
            const headers = { 'content-type': 'application/json', 'x-client-token': token };
            if (entitlement) headers['x-entitlement'] = entitlement;
            if (accountToken) headers.authorization = 'Bearer ' + accountToken;
            /* @admin-only:start */
            await withHarvestToken(headers, '/v1/translate');
            if (!headers['x-harvest-token']) break;   // 管理版沒權杖不翻譯（同 api()）
            /* @admin-only:end */
            fetch(BACKEND + '/v1/translate', {
              method: 'POST',
              keepalive: true,
              headers,
              body: JSON.stringify({ cid: msg.cid || 'misc', lines: msg.lines || [] }),
            }).catch(() => {});
          } catch (e) { /* 離開途中，不做任何事 */ }
          break;
        // ---- 狀態與授權（設定頁用）----
        case 'status': {
          try {
            const h = await fetch(BACKEND + '/v1/health').then((r) => r.json());
            sendResponse({ ok: true, health: h });
          } catch (e) { sendResponse({ ok: false, error: '後端無法連線' }); }
          break;
        }
        // ---- 帳號 ----
        //
        // ⚠️ **不在這裡跑 OAuth。** MV3 的 chrome.identity 會把流程綁在
        //    Chrome 帳號上，Edge 與其他 Chromium 行為不一致。
        //    改成開一個分頁讓使用者在網站上登入，再用一次性配對碼把
        //    工作階段帶回來——使用者只按一次，不用複製貼上。
        case 'accountStatus':
          sendResponse({ ok: true, result: await accountStatus(!!msg.force) });
          break;
        case 'accountLink':
          sendResponse({ ok: true, result: await accountLink() });
          break;
        case 'accountLogout': {
          acctCache = null;
          // ⚠️ **先請伺服器作廢這枚登入，再刪本機的**（security-audit run-2 #14）。以前只刪本機：
          //    被複製走的那一枚（以及它續期換出來的）照樣有效。伺服器會連同整個家族一起撤銷。
          //    連不上也照樣登出本機——使用者按登出，畫面就一定要登出。
          const { accountToken: tok } = await chrome.storage.local.get('accountToken');
          if (tok) {
            try {
              await fetch(BACKEND + '/v1/auth/logout', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
                body: '{}',
              });
            } catch (e) { /* 離線：本機照樣登出 */ }
          }
          await chrome.storage.local.remove(['accountToken', 'accountProfile']);
          // 授權綁帳號：登出＝這台的授權暫停（授權碼留著，重新登入就恢復）
          await pauseLicense('已登出帳號，授權暫停。重新登入帳號即可恢復。');
          sendResponse({ ok: true, result: { signedIn: false } });
          break;
        }
        case 'licenseStatus':
          sendResponse({ ok: true, license: await licenseStatus(msg.force) });
          break;
        // 1.0.2 起沒有 licenseActivate（貼碼）／licenseDeactivate／licenseDevices 訊息：
        // 授權以帳號為準，裝置管理在網站「我的帳號」。
        case 'licenseClear':
          // ⚠️ 要清乾淨，包括上一次的停用原因——否則停用後設定頁還掛著舊的紅字。
          await licenseClear();
          sendResponse({ ok: true });
          break;
        // 產品數據。**失敗一律吞掉**——統計不該影響使用者的任何體驗。
        case 'metric':
          sendResponse({ ok: true });
          try { await api('/v1/metric', { method: 'POST', body: JSON.stringify({ events: msg.events }) }); }
          catch (e) { /* noop */ }
          break;
        case 'sendReport': {
          try {
            const d = await api('/v1/report', {
              method: 'POST',
              body: JSON.stringify({
                report: msg.report, note: msg.note, contact: msg.contact, version: msg.version,
                auto: !!msg.auto,
              }),
            });
            sendResponse({ ok: true, result: d });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }
        case 'markComplete':
          sendResponse({ ok: true, result: await markComplete(msg.cid, msg.segCount, msg.slug, msg.noSubtitles) });
          break;
        /* @admin-only:start */
        case 'harvestPlan':
          sendResponse({ ok: true, result: await harvestCall('plan', msg) });
          break;
        case 'harvestStamp':
          sendResponse({ ok: true, result: await harvestCall('stamp', msg) });
          break;
        case 'harvestBundles':
          sendResponse({ ok: true, result: await harvestCall('bundles', msg) });
          break;
        case 'harvestSlugs':
          sendResponse({ ok: true, result: await harvestCall('slugs', msg) });
          break;
        case 'harvestF1tvSched':
          sendResponse({ ok: true, result: await harvestCall('f1tvSched', msg) });
          break;
        case 'harvestStatus':
          sendResponse({ ok: true, result: await harvestCall('status', msg) });
          break;
        /* @admin-only:end */
        case 'fetchText':
          try {
            sendResponse({ ok: true, text: await fetchText(msg.url) });
          } catch (e) {
            sendResponse({ ok: false, error: String(e.message || e) });
          }
          break;
        case 'health':
          try {
            const h = await fetch(BACKEND + '/v1/health').then((r) => r.json());
            sendResponse({ ok: true, health: h });
          } catch (e) {
            sendResponse({ ok: false, error: String(e.message || e) });
          }
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;   // 一定要 return true，否則非同步的 sendResponse 會失效
});

// 設定改變時清掉設定快取，讓新的權杖立刻生效
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.clientToken) { memCache.config = null; memCache.bundles.clear(); }
  /* @admin-only:start */
  // 有沒有收割權杖，GET /v1/subs 回的 segCount 意義不同（收割只看收割蓋的章）——換了就作廢
  if (changes.harvestToken) memCache.bundles.clear();
  /* @admin-only:end */
});
