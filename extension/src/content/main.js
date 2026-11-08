/**
 * Content script（ISOLATED world）
 *
 * 職責只有三件事：
 *   1. 知道現在在看哪支影片（contentId）
 *   2. 讀出畫面上的英文字幕
 *   3. 查表 → 疊字顯示
 *
 * 網路通訊全部交給 service worker。這裡不碰任何金鑰、不注入頁面腳本、
 * 不修改 Worker——所以 F1TV 怎麼改播放器內部都影響不到我們，
 * 只有「字幕的 DOM 選擇器」這一個接觸面，而那個可以靠遠端設定熱修。
 *
 * ── 從 userscript 帶過來的教訓（都是實際踩過的坑）──
 *   #1  讀文字一律用 textContent。innerText 對隱藏元素回傳空字串
 *   #4  不要相信「註冊一次就永遠有效」——SPA 會重建 DOM，observer 會靜默失聯
 *   #11 contentId 不能只認一種網址形式
 *   #14 沒有旁白的片段（動畫、宣傳片）不是故障，不能誤報
 */

(function () {
  'use strict';

  // 注入兩次的話會有兩組計時器、兩份狀態，症狀是各種東西「莫名其妙跑兩遍」。
  // MV3 正常不會這樣，但 SPA 導覽、擴充功能重載、開發時手動注入都可能造成，
  // 而且完全不報錯。擋掉的成本是一行。
  if (window.__pitlingoBooted) return;
  window.__pitlingoBooted = true;

  const { clean, normKey, siteConfigFor, sanitizeSettings, DEFAULT_SETTINGS } = self.PL;

  // 100ms（原 250ms）。observer 正常時輪詢只是備援，這個間隔不重要；
  // 但 observer 失聯時它就是唯一的偵測手段，而 250ms 直接加在顯示延遲上。
  // collectCaption() 只掃字幕容器內的少數節點，100ms 的成本可以接受。
  // 實際 observer 有沒有在作用，看診斷報告的「偵測來源」那兩個數字。
  const POLL_MS = 100;             // 主動輪詢字幕的間隔（偵測備援）
  const STRUCT_MS = 1500;          // 結構性檢查的間隔
  const STALL_MS = 2500;           // 超過這麼久沒輪詢到，判定分頁被節流過

  // 逐句即時翻譯（後備路徑）的節流參數。
  // 這條路只有在影片沒被預先收割時才會用到，本來就追不上 F1 的語速，
  // 但至少要把「等待聚合」與「一次只能飛一個請求」這兩個自找的瓶頸拿掉。
  const PENDING_FLUSH_MS = 300;    // 原本 1200ms，光是等待就吃掉大半預算
  const MAX_INFLIGHT = 3;          // 允許並行，否則第二句要等第一句回來才送
  const BATCH_MAX = 20;

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let site = null;                 // 目前網域適用的選擇器設定

  // 上限。一場正賽約 2,000 句，這次實測單支練習賽就 3,331 句——
  // 沒有上限的話，長時間連看多支影片會一路長上去。
  // Map 保留插入順序，砍最舊的就近似 LRU（重看同一支時最近的那些才有價值）。
  const MEMO_MAX = 12000;
  const PENDING_MAX = 3000;        // 待翻佇列。正常收割不會逼近，防的是異常情況
  const memo = new Map();          // normKey -> 譯文（**跨影片共用**，不要拿來當單片的分母）
  let sessionKeys = new Set();     // 這支影片出現過的 normKey，回寫查核的分母
  let contentId = null;
  let seenContentId = null;        // 從 performance 觀察到的
  let lastPath = location.pathname;

  let lastSeenCaption = '';
  let lastRaw = '';
  let everSawCaption = false;

  const pending = new Map();
  // 「現在螢幕上就要用」的鍵。直播的並發去重只讓前瞻那條路讓步，
  // 急件一律不讓——讓路的人要等別人翻完再讀快取，而直播字幕 3~4 秒就換一句。
  const urgentKeys = new Set();       // normKey -> 原文（待送出）
  const requested = new Set();     // 已送出、等待回應中的 normKey
  let pendingTimer = null;
  let pendingLong = false;        // 目前排的是長的等待（直播延遲／前導模式），急件要能插隊

  // ---- 直播延遲畫面（2026-10-06，見 shared/live-delay.js）----
  // ⚠️ Ray 的決定：預設開、畫面上不提示。狀態只出現在診斷報告與事件時間軸。
  // 延遲中的觀眾批次可以等久一點（前導收割端不在時也比較省）；但「畫面上現在就要」的句子（urgentKeys）照樣立刻送。
  // ⚠️ 2026-10-11 實測：延遲 45 秒只讓**付費**的提前量變長（整軌預抓抓邊緣，中位數 25 → 40 秒）；
  //    免費的不變（約 25 秒）——播放器只抓目前位置附近的分段。等 10 秒的依據是急件會插隊，不是提前量變長。
  const LIVE_DELAY_HOLD_MS = 10000;
  // ⚠️ **前導收割端在的時候要等得比它久**（2026-10-25，R18 FP3）。付費觀眾的整軌預抓盯著直播邊緣的字幕清單，
  //    和前導端**同一秒**拿到新分段；前導端湊批次等 leaderWinMs（20 秒），觀眾只等 10 秒 → 觀眾先認領、自己翻，
  //    前導端反過來撿觀眾的。FP3 實測觀眾共用率掉到 47%（FP2 的觀眾預抓沒啟動、只靠播放器落後 45 秒拿分段，93%）。
  //    28 秒＝前導端 20 秒＋模型約 3 秒＋餘裕。付費觀眾的提前量中位數約 40～60 秒，畫面上馬上要的句子照樣插隊。
  //    前導端不在（或還不知道）時維持 10 秒：沒有人會替他翻，等久只是讓中文變晚。
  const LIVE_DELAY_LEADER_HOLD_MS = 28000;
  let leaderMode = false;         // 管理版的前導收割模式（貼邊緣、不延遲、大批次、送心跳）；正式版永遠 false
  let leaderWinMs = 20000;
  let leaderSeen = null;          // 最近一次翻譯回應說前導收割端在不在
  // 管理版一律不延遲畫面（2026-10-24 Ray 決定）：它是前導端與收割工具。R18 FP2 開場管理版把前導端拉回 45 秒，
  // 觀眾整整一段都自己翻——就算有人把前導模式關掉，管理版也不該把自己拉到觀眾後面
  let noLiveDelay = false;
  const liveDelay = self.PL.createLiveDelay({ log: (m) => evWarn('延遲畫面：' + m) });
  let liveDelayCfg = null;
  function liveDelayInEffect() {
    const s = liveDelay.status();
    return s.active && s.behind !== null && s.behind >= s.seconds - 10;
  }
  function applyLiveDelay(cfg) {
    if (cfg) liveDelayCfg = cfg.liveDelay || null;   // 不帶參數＝沿用上一次的設定（切換前導模式時）
    const d = Object.assign({ enabled: true, seconds: 45 }, liveDelayCfg || {});
    liveDelay.setEnabled(d.enabled !== false && !leaderMode && !noLiveDelay, d.seconds);
  }
  let inflight = 0;
  const batchStats = [];           // { sent, got, ms } — 診斷用，看批次效率

  const state = {
    bundleCount: 0, translated: 0, misses: 0, errors: 0,
    playlistSegs: 0, segFetched: 0, segFailed: 0, prefetched: 0,
    workerPatched: 0, workerVtt: 0, manifests: 0, prefetchAnnounced: false,
    serverCount: -1,               // 回寫查核：後端實際有幾句（-1 = 尚未查核）
    harvestSkipped: false,         // 是否因為「已有人收割完整」而跳過整軌預抓
    dropped: 0,                    // 重試 3 次仍失敗、已放棄的句數
    yieldCount: 0, yieldMs: 0,   // 為了讓路給影片而暫停收割的次數與總時間
    gaps: 0, lastGap: null,        // 字幕中途缺漏（不含「本來就沒旁白」）
    badLines: 0,                   // 長度異常而被略過的「字幕」——不是 0 就代表攔錯東西了
    blocked: 0,                    // 合理性檢查擋下的譯文（模型跳出角色）。**要看得到，否則過度攔截無從發現**
    hits: 0, isLive: false, harvestDone: false,
  };

  // ---- 事件時間軸 ----
  // 所有狀態變化都記在這裡，「匯出診斷」時一併帶出。
  // 沒有這個就只能靠翻 Console 猜，而 SW 的 log 又在另一個視窗。
  const eventLog = [];
  let phase = '啟動中';
  /**
   * 相同訊息連續出現時折疊成計數，不要各佔一行。
   *
   * 為什麼一定要有：實測跑三小時後，事件時間軸 400 筆裡有 150 筆是同一行
   * 「⚙ 遠端設定已更新 v1 → v1」，把真正重要的紀錄全部擠掉。
   * **診斷報告是這個專案唯一的回報管道**——被洗版就等於瞎了，
   * 而洗版的原因有很多種，一個一個修永遠追不完。
   * 在這裡擋一次，之後任何來源的重複訊息都傷不到報告。
   */
  /**
   * Console 輸出的總開關。**預設關閉，而且必須預設關閉。**
   *
   * ⚠️ **一般使用者按 F12 時必須看到完全乾淨的 Console。**
   *    在別人的網站上印東西是三件壞事：讓使用者以為是 F1TV 壞了、
   *    把我們的內部狀態（快取命中、cid、批次大小）攤在所有人面前、
   *    以及把 F1TV 自己的錯誤訊息淹掉。
   *
   * ⚠️ **關掉的只有 Console，事件時間軸照常記錄。**
   *    `eventLog` 是診斷報告的全部內容，也是這個專案唯一的回報管道
   *    ——連它一起關掉的話，使用者回報問題時我們手上什麼都沒有。
   *
   * 管理員（你）要打開有兩種方式，都立即生效：
   *   · 設定頁勾「詳細日誌」
   *   · Console 打 `__pitlingo.debug(true)`
   *
   * ⚠️ 宣告**必須排在 logEvent 之前**。`let` 有 TDZ，
   *    如果載入過程中有任何一行先呼叫 logEvent，就會是 ReferenceError
   *    ——而那發生在 async 的 boot() 裡，會變成使用者看到的
   *    `Uncaught (in promise)`，然後整個擴充功能靜靜地不動。
   */
  let debugOn = false;

  let lastLogMsg = '', lastLogCount = 0;
  function logEvent(level, msg) {
    if (msg === lastLogMsg && eventLog.length) {
      lastLogCount++;
      eventLog[eventLog.length - 1] =
        `${eventLog[eventLog.length - 1].replace(/　×\d+$/, '')}　×${lastLogCount + 1}`;
      return;                                  // Console 也不再重複印
    }
    lastLogMsg = msg; lastLogCount = 0;
    eventLog.push(`[${new Date().toISOString().slice(11, 23)}] ${level.toUpperCase().padEnd(4)} ${msg}`);
    if (eventLog.length > 400) eventLog.shift();
    const style = level === 'err' ? 'color:#e10600;font-weight:bold'
                : level === 'ok' ? 'color:#0a0;font-weight:bold'
                : level === 'warn' ? 'color:#c80;font-weight:bold'
                : 'color:#57f';
    // ⚠️ 只有管理員開了詳細日誌才印。見 debugOn 的說明。
    if (debugOn) console.log(`%c[PitLingo] ${msg}`, style);
  }
  const evOk = (m) => logEvent('ok', m);
  const evInfo = (m) => logEvent('info', m);
  const evWarn = (m) => logEvent('warn', m);
  const evErr = (m) => logEvent('err', m);

  /**
   * 詳細日誌（每句字幕、每個批次都印）。
   *
   * 為什麼要獨立一個層級：正常使用時每 3~4 秒印一行只是噪音，
   * 但測試階段看不到這些就只能猜。預設關閉，兩種方式打開：
   *   - 設定頁勾「詳細日誌」
   *   - Console 打 `__pitlingo.debug(true)`（立即生效，不用重整）
   *
   * 這些**不寫進事件時間軸**——時間軸只有 400 筆，被逐句訊息灌爆的話，
   * 匯出診斷時就看不到真正重要的狀態變化了。
   */
  // ⚠️ **正式版也要記詳細日誌，只是不印出來。**（2026-09-17 使用者要求）
  //    Console 指令 `__pitlingo.debug()` 只在測試版；但一般使用者按「傳送診斷資訊」時，
  //    開發者要看得到最近的詳細日誌——所以一律記在記憶體裡，只放進診斷報告。
  //    上限 300 行：一場直播每 3~4 秒一行，約 15 分鐘的量，報告大小仍遠低於後端 200KB 上限。
  const DEBUG_LOG_MAX = 300;
  const debugLog = [];
  function dbg(msg) {
    debugLog.push(`[${new Date().toISOString().slice(11, 23)}] ${String(msg).slice(0, 300)}`);
    if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
    if (!debugOn) return;
    console.log(`%c[PitLingo·debug] ${msg}`, 'color:#888');
  }
  function setPhase(p, extra) {
    if (phase === p) return;
    phase = p;
    evInfo(`▶ ${p}${extra ? ' — ' + extra : ''}`);
  }
  const log = evInfo;

  // =========================================================================
  // 與 service worker 通訊
  // =========================================================================
  /**
   * 擴充功能被重新載入／更新／停用之後，**這個分頁裡舊的 content script 還活著**——
   * 計時器照跑，但 chrome.runtime 已經失效，任何 `chrome.runtime.getManifest()` 都丟
   * 「Extension context invalidated」（2026-10-12 Ray 回報：自動診斷的計時器每 10 秒丟一次）。
   * Chrome 不會把新版注入已經開著的分頁，所以這個分頁要重新整理才會有新版。
   * 版本號在載入時記一次；失聯之後由 orphanShutdown 整個停手。
   */
  const EXT_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; } })();
  function extAlive() {
    try { return !!chrome.runtime.getManifest(); } catch (e) { return false; }
  }
  let orphaned = false;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: 'no response' });
        });
      } catch (e) { resolve({ ok: false, error: String(e.message || e) }); }
    });
  }

  // =========================================================================
  // contentId
  //
  // F1TV 有多種網址形式：/detail/<id>/... 帶得到 id，/page/<id>/... 帶不到。
  // 只認網址的話，從活動頁進去看影片時整個功能會靜默失效（userscript 的坑 #11）。
  //
  // 解法：performance.getEntriesByType('resource') 會列出主執行緒發過的每一個請求，
  // 而且是**回溯的**——不用提早 hook，也不需要 webRequest 那種高風險權限。
  // 播放 API（.../CONTENT/PLAY?contentId=...）一定會出現在裡面。
  // =========================================================================
  /**
   * 從資源計時裡找 contentId。**只在網址上找不到時才做。**
   *
   * ⚠️ 這個函式原本每 1.5 秒無條件跑一次，而資源計時緩衝被我們自己調到
   *    1,000 筆——等於每 1.5 秒對一千條幾百字元的網址各跑一次正則。
   *    F1TV 的網址還特別長（帶著 400 字元的授權 token）。
   *    那是持續佔用主執行緒的工作，而**播放器的 ABR 決策也跑在主執行緒上**。
   *
   *    絕大多數情況網址本身就有 `/detail/(\d+)`，根本不需要掃。
   *    這裡先問一次，有答案就直接返回。
   */
  function scanContentIdFromPerformance() {
    if (seenContentId) return;                        // 已經找到過就不必再掃
    if (site && site.contentIdPattern) {
      try {
        if (new RegExp(site.contentIdPattern).test(location.pathname)) return;
      } catch (e) { /* 設定裡的正則壞掉就往下掃 */ }
    }
    // ⚠️ **只找 `contentId=` 是不夠的。**
    //
    //    實測（2026-08-21 直播）：兩台裝置看同一場直播，一台的網址是
    //    /detail/<id>/... 解析得到 cid，另一台解析不到，於是**整場的譯文
    //    被寫進 misc 這個公用桶子**——與正片的重疊率 98.1%，
    //    等於同一句話付了兩次錢，而且不會有任何錯誤訊息。
    //
    //    所以三種形式都掃：查詢參數、/detail/ 路徑、以及頁面自己的資料。
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const u = entries[i].name;
        const m = u.match(/[?&]contentId=(\d+)/i) || u.match(/\/detail\/(\d+)/);
        if (m) { seenContentId = m[1]; return; }
      }
    } catch (e) { /* 不影響主要功能 */ }
    // 最後一招：頁面自己的資料（Next.js 的 __NEXT_DATA__ 之類）
    try {
      const raw = (document.getElementById('__NEXT_DATA__') || {}).textContent || '';
      const m = raw.match(/"contentId"\s*:\s*"?(\d{6,})/);
      if (m) { seenContentId = m[1]; return; }
    } catch (e) { /* 不影響主要功能 */ }
  }


  function currentContentId() {
    if (site && site.contentIdPattern) {
      try {
        const m = location.pathname.match(new RegExp(site.contentIdPattern));
        if (m && m[1]) return m[1];
      } catch (e) { /* 設定裡的正則有問題就忽略 */ }
    }
    return seenContentId;
  }

  // =========================================================================
  // 字幕讀取
  // =========================================================================
  function qsAll(selectors) {
    for (const sel of selectors || []) {
      const found = document.querySelectorAll(sel);
      if (found.length) return Array.from(found);
    }
    return [];
  }

  function captionContainers() { return site ? qsAll(site.captionRoot) : []; }

  /** 多視角時可能同時有多個字幕容器，取面積最大的那個（主畫面） */
  function activeContainer() {
    const list = captionContainers();
    if (list.length <= 1) return list[0] || null;
    let best = null, bestArea = -1;
    for (const el of list) {
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = el; }
    }
    return best;
  }

  /**
   * 逐葉節點取 textContent 再用空白接起來。
   * 不用 innerText —— 它是版面感知的，元素被我們隱藏後會回傳空字串（坑 #1）。
   * 也不直接用整段 textContent —— 那樣多行字幕會黏成一團沒有空格。
   */
  function textOf(el) {
    const parts = [];
    el.querySelectorAll('*').forEach((n) => {
      if (n.firstElementChild) return;              // 只取葉節點，避免重複計算
      const t = (n.textContent || '').trim();
      if (t) parts.push(t);
    });
    if (!parts.length) {
      const t = (el.textContent || '').trim();
      if (t) parts.push(t);
    }
    return parts.join(' ');
  }

  function collectCaption() {
    const root = activeContainer();
    if (!root) return '';
    const labels = site ? (site.captionLabel || []) : [];
    let parts = [];
    for (const sel of labels) {
      const found = root.querySelectorAll(sel);
      if (found.length) { parts = Array.from(found).map(textOf).filter(Boolean); break; }
    }
    if (!parts.length) { const t = textOf(root); if (t) parts = [t]; }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // =========================================================================
  // 輪詢為主、observer 為輔
  //
  // 這是 userscript 的坑 #4：原本只掛 MutationObserver 就以為永遠有效，
  // 但 F1TV 切換視角時會銷毀重建播放器 DOM，observer 隨之靜默失聯——
  // 不報錯、不觸發，字幕就這樣停了，使用者只覺得「時好時壞」。
  //
  // 輪詢不依賴任何註冊狀態，因此不可能失效。observer 只是讓反應更即時。
  // =========================================================================
  /**
   * 輪詢停擺偵測。
   *
   * 實測回報：看到一半字幕停了一小段，「動了動滑鼠就好」。
   * 最可能的原因是 Chrome 對被遮蔽（occluded）或背景分頁的計時器做節流——
   * setInterval 會被拉長到每分鐘一次，於是 250ms 的輪詢與 1.5 秒的結構檢查
   * 全部失效；滑鼠一動視窗回到前景，計時器恢復正常。
   *
   * 這是推測而非確認，但不論真正原因為何，處理方式都一樣：
   * **偵測到自己剛剛被凍結，就強制做一次完整重檢**，而不是假設狀態還新鮮。
   */
  /**
   * 「播放中卻沒有字幕」的提示。擴充功能一直缺這個——使用者忘了開 CC 時
   * 畫面完全沒反應，也沒有任何說明，只會以為是我們壞了。
   *
   * 防呆的重點在**寧可漏報也不要誤報**（userscript 坑 #14）：
   *   - 只有 video 存在、正在播放、且沒暫停才計時
   *   - 看過任何一句字幕就永不再提示（那代表 CC 是開的，現在只是沒旁白）
   *   - 五分鐘內最多提示一次
   *   - 有 VTT 資料才是高訊號（確定這支有字幕卻沒顯示 → CC 沒開）；
   *     沒資料只記 Console，因為可能真的是開場動畫或宣傳片
   */
  const NO_CAPTION_WARN_MS = 45000;
  // 中途缺漏的門檻。轉播的自然空白（換鏡頭、車手沒講話）多半在 10 秒內，
  // 20 秒沒有任何字幕就值得記一筆——但要分辨是不是本來就沒旁白，見 checkCaptionGap。
  const CAPTION_GAP_MS = 20000;
  let lastNonEmptyAt = Date.now();
  let hintShownAt = 0;

  function isActuallyPlaying() {
    const v = document.querySelector('video');
    return !!(v && !v.paused && !v.ended && v.readyState >= 2 && v.currentTime > 0);
  }

  /**
   * 播放中卻長時間沒有字幕。**要分辨是誰的問題。**
   *
   * ⚠️ 舊版只在「從未看過字幕」時才警告（`if (everSawCaption) return`），
   *    所以**比賽中途的缺漏完全是隱形的**——使用者看到字幕消失一段，
   *    診斷報告卻什麼都沒有，我們只能用猜的。
   *
   * 中途缺漏有四種成因，後果完全不同，必須當場分辨：
   *
   *   A. 這段本來就沒有旁白（賽後訪問、頒獎、純畫面）
   *      → **正常**。原生字幕也是空的，我們沒有東西可翻。
   *   B. 原生字幕有，我們沒有譯文
   *      → 翻譯沒跟上，或這句不在快取裡。可以補。
   *   C. 原生字幕整個不見了
   *      → CC 被關掉、選擇器失效、或播放器重建導致 observer 失聯。
   *   D. 額度用完
   *      → 免費模式的正常行為，但要說清楚免得被當成故障。
   *
   * 判斷依據是**當下重讀 DOM**，不是任何快取的變數。
   */
  let gapReported = 0;
  // ⚠️ **這個函式曾經從來沒有被呼叫過。** 定義、代碼（PL-C03／PL-C04）、診斷報告的
  //    「中途缺漏」、HUD 的「缺漏」都寫好了，唯獨沒有任何地方呼叫它——
  //    於是缺漏永遠是 0，看起來像「從來沒發生過」（2026-09-17 行為測試發現）。
  //    現在由結構性檢查每 1.5 秒呼叫一次，check-extension-behavior 第 7 項會驗。
  function checkCaptionGap() {
    if (!settings.enabled || !site || killed || tooOld) return;
    if (!everSawCaption) return;                        // 交給下面的首次偵測處理
    // 暫停不算缺漏：暫停期間把起點往後推，恢復播放時才不會回報「缺漏 300 秒」
    if (!isActuallyPlaying()) { lastNonEmptyAt = Date.now(); return; }
    if (Date.now() - lastNonEmptyAt < CAPTION_GAP_MS) return;
    // 同一次缺漏只回報一次，恢復之後才會再記
    if (gapReported > lastNonEmptyAt) return;
    gapReported = Date.now();

    const gapSec = Math.round((Date.now() - lastNonEmptyAt) / 1000);
    const container = activeContainer();
    const nativeNow = clean(collectCaption());

    let kind, msg;
    if (trialExhausted()) {
      kind = 'quota';
      msg = `已停止顯示 ${gapSec} 秒：免費額度已用完（這是正常行為，非故障）`;
    } else if (nativeNow) {
      // 原生有字幕，我們卻沒畫出來 —— 這是真的漏了
      const k = normKey(nativeNow);
      kind = memo.has(k) ? 'render' : 'untranslated';
      if (kind === 'render') plErr('PL-C04', gapSec + ' 秒');
      msg = `⚠ 字幕缺漏 ${gapSec} 秒：原生字幕存在但未顯示中文`
        + `（${memo.has(k) ? '譯文已在本機，疑似顯示層問題' : '這句尚無譯文'}）`;
    } else if (!container) {
      kind = 'container_gone';
      plErr('PL-C03', gapSec + ' 秒');
      msg = `⚠ 字幕缺漏 ${gapSec} 秒：找不到字幕容器 —— 選擇器可能已失效，或播放器重建中`;
    } else {
      kind = 'silent';
      msg = `字幕空白 ${gapSec} 秒：原生字幕也是空的（賽後訪問、頒獎、純畫面時屬正常）`;
    }

    // 「本來就沒旁白」不該吵人，記成 INFO；其餘是要處理的問題
    if (kind === 'silent' || kind === 'quota') evInfo(msg); else evWarn(msg);
    metric('caption_gap', { kind, sessionType: sessionType() });
    state.gaps = (state.gaps || 0) + (kind === 'silent' || kind === 'quota' ? 0 : 1);
    state.lastGap = { kind, sec: gapSec, at: new Date().toISOString() };
  }

  /**
   * 播了一陣子還是完全攔不到串流 → 注入失敗。
   *
   * 這種情況功能還在（會退化成逐句翻譯），但**慢很多也貴很多**，
   * 而且使用者只會覺得「字幕怎麼一直慢半拍」。所以要留代碼，
   * 但**不打斷觀看**——它還能用，跳一個大警告只會嚇到人。
   */
  let injectChecked = false;
  let injectSince = Date.now();
  function checkInjection() {
    if (injectChecked || !site || killed) return;
    if (!isActuallyPlaying()) return;
    if (Date.now() - injectSince < 90000) return;      // 給它 90 秒
    injectChecked = true;
    if (state.workerPatched > 0 || state.workerVtt > 0 || state.segFetched > 0) return;
    plErr('PL-C05', '播放 90 秒仍未攔截到任何串流資料');
  }
  // ⚠️ **自己的計時器，不可以共用 lastNonEmptyAt。** 以前這裡每 45 秒就把
  //    lastNonEmptyAt 重設成現在——而那是 checkCaptionGap 算「缺漏多久」的起點。
  //    結果一段 70 秒的空白被切成好幾段、每段都報「20 秒」。
  let noCaptionSince = Date.now();
  function checkNoCaption() {
    if (!settings.enabled || !site) return;
    if (!isActuallyPlaying() || everSawCaption) { noCaptionSince = Date.now(); return; }
    if (Date.now() - noCaptionSince < NO_CAPTION_WARN_MS) return;
    noCaptionSince = Date.now();

    if (Date.now() - hintShownAt < 300000) return;    // 五分鐘內只提示一次
    hintShownAt = Date.now();

    const haveData = state.workerVtt > 0 || state.segFetched > 0 || memo.size > 0;
    if (haveData) {
      metric('playback_error', { kind: 'no_caption' });
      evWarn('這支影片有字幕資料，但畫面上從未出現字幕 — 播放器的 CC 應該是關著的');
      show('⚠ 請在播放器設定開啟英文字幕 (CC)', '');
    } else {
      evInfo('播放中但尚未取得任何字幕（可能是無旁白片段，或 CC 未開啟）');
    }
  }

  // =========================================================================
  // 進入影片時自動開啟英文字幕（v0.38.0，Ray 2026-10-12：三個版本都要）
  //
  // 疊字是跟著原生字幕走的——**CC 沒開，中文就完全不會出現**，而 F1TV 每換一支影片
  // 都把 CC 重設成 None（Ray 實測）。以前只能等 checkNoCaption 幾十秒後提醒。
  //
  // 做法：F1TV 的播放器介面是 Bitmovin Player UI（`tm-` 是它的 CSS 前綴）。
  // 字幕語言是一個真的 <select>（`.tm-ui-subtitleselectbox`），它聽 `change` 事件，
  // 讀 value 後呼叫 player.subtitles.enable(value)；「關閉」的 value 是字串 'null'
  // （bitmovin-player-ui：SelectBox.ts 的 on('change')、SubtitleUtils.ts 的 SUBTITLES_OFF_KEY）。
  // 所以設 value＋送一次 change，走的是跟手動選一模一樣的路——**不模擬點齒輪與選單**。
  //
  // ⚠️ 每支影片只做一次：之後使用者自己關掉就尊重他，不會再打開。
  // ⚠️ 已經不是「關閉」（使用者或 F1TV 自己選了別的語言）就不碰。
  // ⚠️ 有上限：字幕軌 90 秒內沒出現（這支沒有字幕／F1TV 改版）就安靜放棄——
  //    還有 checkNoCaption 的提醒當備援。
  // ⚠️ 選擇器是資料：遠端設定的 sites[].ccSelect 可熱更新，沒有時用內建的。
  // =========================================================================
  const CC_AUTO_MAX_MS = 90000;
  // 送出後下一秒就確認播放器真的切過去了。⚠️ 不可以拉長：確認之前使用者關掉的話會被當成
  // 「播放器沒接受」而重開（測試抓到的）；1 秒內人不可能點完 齒輪 → Subtitles → Language
  const CC_VERIFY_MS = 1000;
  const CC_MAX_TRIES = 3;
  let ccAuto = { cid: '', state: '', since: 0, at: 0, tries: 0, value: '' };

  function ccSelectEl() {
    let sels = site && site.ccSelect;
    if (!sels) { try { sels = (self.PL.siteConfigFor(self.PL.BUILT_IN_CONFIG, location.hostname) || {}).ccSelect; } catch (e) { sels = null; } }
    const el = qsAll(sels)[0];
    return el && el.options ? el : null;
  }

  /**
   * 這個選項是不是「關閉字幕」。
   * ⚠️ F1TV 改過 Bitmovin 的選單：value 不是原版的字串 'null'，而是 JSON
   *    `{"trackId":null,"feedId":null}`（2026-10-12 Ray 實機傾印；第一版只認 'null'，
   *    把 None 當成「已經開著別的語言」而不動它）。三種都認：原版、F1TV 的 JSON、文字 None／Off。
   */
  function ccIsOff(o) {
    if (!o) return true;
    const v = String(o.value == null ? '' : o.value);
    if (v === 'null' || v === '') return true;
    if (v.charAt(0) === '{') {
      try { const j = JSON.parse(v); if (j && 'trackId' in j && j.trackId == null) return true; } catch (e) { /* 不是 JSON 就看文字 */ }
    }
    return /^(none|off)$/i.test((o.textContent || '').trim());
  }

  function tickAutoCC() {
    if (!settings.enabled || !settings.autoEnableCC || killed || orphaned || !site || !contentId) return;
    if (ccAuto.cid !== contentId) ccAuto = { cid: contentId, state: 'waiting', since: Date.now(), at: 0, tries: 0, value: '' };
    if (ccAuto.state !== 'waiting' && ccAuto.state !== 'sent') return;
    const sel = ccSelectEl();
    if (ccAuto.state === 'sent') {
      if (Date.now() - ccAuto.at < CC_VERIFY_MS) return;
      if (sel && sel.value === ccAuto.value) { ccAuto.state = 'done'; return; }
      if (ccAuto.tries >= CC_MAX_TRIES) { ccAuto.state = 'gaveup'; evWarn('自動開啟英文字幕沒有生效（播放器沒有切過去），請手動開啟'); return; }
      ccAuto.state = 'waiting';
    }
    // ⚠️ 90 秒從「播放器真的開始載入影片」才算，不是從頁面載入（v0.38.4）。
    //    2026-10-23 Ray 實測（工單 PL-261023-WNZB）：頁面載入後播放器過了三分多鐘才出來，
    //    第 91 秒就以「找不到字幕選單（F1TV 改版？）」放棄——選單根本還沒被建出來。
    const v = document.querySelector('video');
    if (!v || !(v.readyState >= 1)) { ccAuto.since = Date.now(); return; }
    if (Date.now() - ccAuto.since > CC_AUTO_MAX_MS) {
      ccAuto.state = 'gaveup';
      evInfo(sel ? '這支影片 90 秒內沒有出現英文字幕軌，不自動開啟' : '找不到播放器的字幕選單，不自動開啟（F1TV 改版？）');
      return;
    }
    if (!sel || !sel.options.length) return;
    const cur = sel.options[sel.selectedIndex];
    if (cur && !ccIsOff(cur) && ccAuto.tries === 0) {
      ccAuto.state = 'already';
      log(`字幕本來就是開著的（${(cur.textContent || '').trim()}），不動它`);
      return;
    }
    const opts = Array.from(sel.options).filter((o) => !ccIsOff(o));
    const en = opts.find((o) => /^english/i.test((o.textContent || '').trim()))
      || opts.find((o) => /english/i.test(o.textContent || ''));
    if (!en) return;                     // 字幕軌還沒載入；直播常要等幾秒
    sel.value = en.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    ccAuto.tries++; ccAuto.at = Date.now(); ccAuto.value = en.value; ccAuto.state = 'sent';
    evInfo(`已自動開啟英文字幕（${(en.textContent || '').trim()}）`);
  }

  let lastPollAt = Date.now();
  function checkPollStall() {
    const gap = Date.now() - lastPollAt;
    lastPollAt = Date.now();
    // 門檻用絕對值，不要用 POLL_MS 的倍數。
    // 輪詢間隔從 250ms 調到 100ms 時，倍數寫法會把門檻一起縮到 800ms，
    // 那已經落在正常抖動範圍內，會開始誤報停擺並無謂地整組重掛觀察者。
    if (gap < STALL_MS) return false;             // 正常抖動
    evWarn(`偵測到輪詢停擺 ${Math.round(gap / 1000)} 秒（分頁可能被瀏覽器節流），強制重檢`);
    observedNodes = new Set();                    // 逼 hookObservers 整組重掛
    hookObservers();
    lastSeenCaption = ''; lastRaw = '';           // 清掉去重狀態，避免漏掉停擺期間那句
    mount(); reposition();
    return true;
  }

  /**
   * 偵測來源統計 —— 用來回答「0.5 秒的延遲有多少是我們造成的」。
   *
   * 顯示延遲＝(a) F1TV 自己把字幕畫進 DOM 的時機 ＋ (b) 我們發現它的時間。
   * 只有 (b) 是我們能改的，而兩者靠猜分不開。
   *
   * observer 命中代表 (b) 幾乎是 0（mutation 當下就處理）；
   * 輪詢命中代表 observer 沒作用，(b) 最壞是一個 POLL_MS。
   * 兩邊的比例直接告訴我們該不該把力氣花在調輪詢間隔上。
   */
  const detect = { byObserver: 0, byPoll: 0, renderMs: [], paintMs: [] };

  /**
   * **中文落後英文多久**（2026-09-23 為直播實測補上）。
   *
   * ⚠️ 這是使用者定下的判準：中文晚於英文超過 **0.5 秒**就要測「延遲畫面輸出」
   *    （見 LIVE-TEST.md）。以前診斷報告只有「JS 耗時」與「到上畫面」——
   *    那兩個量的是**我們自己畫得多快**（命中快取時都是幾毫秒），
   *    完全不含「這句還沒翻好、等譯文回來才補上」的那段等待，
   *    而那段等待正是直播時使用者真正感覺到的落後。量錯地方＝沒量（鐵則 18）。
   *
   * 命中快取的句子也要記（落後幾乎是 0）——只記沒命中的會讓中位數失真成
   * 「每一句都很慢」，而那會把我們推去做一個其實不需要的延遲畫面功能。
   */
  // ⚠️ **`ms` 是滾動視窗，`late`／`never` 是全場累計——兩者的分母不一樣。**（2026-09-25）
  //    舊的診斷寫成「沒跟上 32 句（400 筆）」，讀起來像 8%，
  //    但 32 是整場累計、400 只是最近那一段視窗，**這個比較從一開始就沒有意義**。
  //    9/24 實測就是這樣讀出一個「8% 沒跟上」與「1.3% 未命中」的假矛盾，
  //    害我差點去查一個不存在的問題。
  //    修法：另外記一個全場的 `seen`，讓累計數有自己誠實的分母。
  const zhLag = { ms: [], waiting: new Map(), late: 0, never: 0, seen: 0 };
  const ZH_LAG_MAX = 400;
  function zhLagNote(ms) {
    zhLag.ms.push(ms);
    if (zhLag.ms.length > ZH_LAG_MAX) zhLag.ms.shift();
    if (ms > 500) zhLag.late++;
    zhLag.seen++;
  }
  /** 這一句的英文已經在畫面上了，但還沒有中文。記下時間，等補上時算落後。 */
  function zhLagWait(k) {
    if (!k || zhLag.waiting.has(k)) return;
    zhLag.waiting.set(k, Date.now());
    // 畫面上的句子每 3~4 秒就換，留太多只會讓過期的樣本混進來
    if (zhLag.waiting.size > 60) zhLag.waiting.delete(zhLag.waiting.keys().next().value);
  }
  /** 中文真的畫上去了。 */
  function zhLagDone(k) {
    if (!k) return;
    const at = zhLag.waiting.get(k);
    if (at === undefined) { zhLagNote(0); return; }   // 一出現就有中文
    zhLag.waiting.delete(k);
    zhLagNote(Date.now() - at);
  }
  function zhLagStats() {
    if (!zhLag.ms.length) return null;
    const a = zhLag.ms.slice().sort((x, y) => x - y);
    const at = (q) => a[Math.min(a.length - 1, Math.floor(a.length * q))];
    return {
      n: a.length, p50: at(0.5), p90: at(0.9),
      late: zhLag.late, never: zhLag.never, seen: zhLag.seen,
    };
  }
  let inObserverTick = false;

  function onMutation() {
    inObserverTick = true;
    try { pollCaption(); } finally { inObserverTick = false; }
  }

  /**
   * 播放器是不是已經被關掉了。
   *
   * ⚠️ **不能只看網址。** 點播放器左上角的返回鍵時網址完全不變，
   *    播放器卻已經被拆掉（坑 #15）。判斷依據是 video 元素消失——
   *    但要給 5 秒寬限，因為切換視角、換畫質時播放器會短暫重建，
   *    那幾百毫秒的消失不是「離開」。
   *
   * 收割與顯示共用同一份判斷，兩邊的定義不一致會很難查。
   */
  let videoGoneLogged = false;
  let videoMissingSince = 0;
  // ⚠️ **「還沒出現」不是「關掉了」**（v0.38.2）。整頁載入時影片元素要好幾秒才建出來，
  //    而字幕清單在那之前就攔到了——舊版從頁面載入就開始計時，整軌預抓一啟動就判定
  //    「播放器已關閉」、0 段中止。收割佇列每一支都是整頁載入，所以每一支都中
  //    （2026-10-12 Ray 實測：正賽 2416 段「已抓 0」，佇列白等到逾時）。
  let videoSeenOnce = false;
  function playerGone() {
    const v = document.querySelector('video');
    if (v) { videoSeenOnce = true; videoMissingSince = 0; return false; }
    if (!videoSeenOnce) return false;
    if (!videoMissingSince) { videoMissingSince = Date.now(); return false; }
    return Date.now() - videoMissingSince > 5000;
  }

  /**
   * 錯誤代碼。
   *
   * ⚠️ **只有「使用者的體驗確實壞了」而且「我們拿到代碼查得出東西」才給代碼。**
   *
   *    這個專案有兩種「沒有字幕」是完全正常的：這支影片本來就沒字幕，
   *    以及有字幕的影片中途長時間沒旁白（賽後訪問、頒獎、純畫面）。
   *    給那兩種發代碼，等於訓練使用者把正常現象當故障回報——
   *    然後真正的故障就淹沒在雜訊裡。它們一律只記 INFO，不給代碼。
   *
   * ⚠️ 代碼發出去就不可以改語意。要淘汰就留著別再用。
   */
  const PL_CODES = {
    'PL-C01': '連不上翻譯伺服器',
    'PL-C02': '伺服器回報錯誤（後面會附伺服器自己的代碼）',
    'PL-C03': '找不到字幕容器 —— 播放器改版或選擇器失效',
    'PL-C04': '譯文已在本機，畫面卻沒顯示 —— 顯示層問題',
    'PL-C05': '注入失敗 —— 攔不到串流，只能逐句翻譯（較慢較貴）',
    'PL-C06': '這支影片不在免費範圍內（不是故障）',
    'PL-C07': '免費額度已用完（不是故障）',
    'PL-C08': '解析不出影片編號 —— 譯文無法存進這支影片的共用快取',
  };
  // 這次觀看出現過哪些代碼，診斷報告要帶上去
  const seenCodes = new Map();

  /**
   * 記一個錯誤代碼。toUser 為 true 時才會顯示在畫面上——
   * 大部分代碼只需要進診斷，不需要打斷觀看。
   */
  function plErr(code, detail, toUser) {
    seenCodes.set(code, (seenCodes.get(code) || 0) + 1);
    const line = '【' + code + '】' + (PL_CODES[code] || '') + (detail ? '　' + detail : '');
    evWarn(line);
    if (toUser) show('⚠ ' + line + '　（回報時請附上代碼）', '');
    return code;
  }

  /**
   * 擴充功能已經被重新載入／停用（見 extAlive）：這一份舊的 content script 整個停手。
   * 疊字拿掉、原生英文字幕還回去、延遲畫面放開、自動診斷停止——**不可以留下一層不會再更新的中文**。
   * 新版要重新整理分頁才會注入（Chrome 不會補注入已開著的分頁）。
   */
  function orphanShutdown() {
    orphaned = true;
    killed = true;                       // 所有「killSwitch 時不動畫面」的路徑一起生效
    autoDiagMin = 0;
    harvestGen++;                        // 收割與預抓自行中止
    clearTimeout(pendingTimer); pending.clear();
    try { applyHideNative(); } catch (e) { /* noop */ }
    try { box.remove(); } catch (e) { /* noop */ }
    evWarn('⚠️ 擴充功能已重新載入或停用，這個分頁的舊版已停止。重新整理頁面即可載入新版。');
  }

  function pollCaption() {
    if (orphaned) return;
    checkPollStall();
    // ⚠️ 觀看時間的累計要在所有停用判斷之前——關掉翻譯的人仍然在看影片，
    //    HUD 與診斷報告要的是「實際播放了多久」，不是「翻譯開著多久」。
    accumulateWatch();
    // ⚠️ 提前顯示要放在所有停用判斷**之後**。
    //    放前面的話 killSwitch 開著、或使用者關掉翻譯時它照樣跑：
    //    show() 會擋住畫面所以看不出問題，但 shownEarly 已經被標記成「顯示過」，
    //    等到恢復時那些句子再也不會提前——靜默地少一個功能，沒有任何錯誤訊息。
    if (!settings.enabled || !site || killed || tooOld) return;

    // 播放器關掉了就不要再偵測字幕。網址沒變，但畫面上已經沒有影片——
    // 這時候容器裡殘留的東西不是字幕，而疊字還留在畫面上只會擋住頁面。
    if (playerGone()) {
      if (!videoGoneLogged) {
        videoGoneLogged = true;
        evInfo('播放器已關閉（網址未變），暫停字幕偵測與顯示');
        lastSeenCaption = ''; lastRaw = ''; currentEn = '';
        scheduleHide();
      }
      return;
    }
    if (videoGoneLogged) {
      videoGoneLogged = false;
      evInfo('播放器已回來，恢復字幕偵測');
      // 重新開始，不要沿用關掉前的去重狀態
      lastSeenCaption = ''; lastRaw = ''; currentEn = '';
      lastNonEmptyAt = Date.now();
      observedNodes = new Set();
      hookObservers();
    }

    tickEarlyDisplay();
    const cur = collectCaption();
    // 補字幕要在「內容沒變就 return」之前跑：原生字幕持續空白時內容一直沒變，
    // 而那正是需要補的時候。
    tickGapFill(cur);
    /* @test-only:start */ plTestHook('poll', cur); /* @test-only:end */
    if (cur === lastSeenCaption) return;
    lastSeenCaption = cur;
    if (cur) {
      if (inObserverTick) detect.byObserver++; else detect.byPoll++;
      dbg(`偵測到字幕（${inObserverTick ? 'observer' : '輪詢'}）：${cur.slice(0, 60)}`);
    }

    if (!cur) {
      // 字幕清空可能只是換句空檔，也可能是切換視角導致重建。
      // 一定要重置 lastRaw，否則切回來時若第一句與切走前相同會被去重擋掉。
      lastRaw = '';
      // currentEn 也要清。它是「補顯示」的依據，不清的話畫面上明明沒字幕了，
      // 慢回來的翻譯還是會把那句舊的重新畫出來。
      currentEn = '';
      // ⚠️ 收起也要走延後佇列。只延後顯示會把每一句的顯示時間砍掉 N 毫秒，
      //    短句直接消失、稍長的句子閃一下就沒——見 `enqueueDelayed` 的說明。
      enqueueDelayed(scheduleHide);
      return;
    }
    lastNonEmptyAt = Date.now();
    if (!everSawCaption) { everSawCaption = true; log('已偵測到第一句字幕，CC 運作正常'); }
    noteDomCue(clean(cur));
    handleCaption(cur);
  }

  let observedNodes = new Set();
  const observers = [];
  function hookObservers() {
    const now = captionContainers();
    let changed = now.length !== observedNodes.size;
    if (!changed) for (const el of now) { if (!observedNodes.has(el)) { changed = true; break; } }
    if (!changed) return;

    observers.forEach((o) => { try { o.disconnect(); } catch (e) { /* noop */ } });
    observers.length = 0;
    observedNodes = new Set(now);
    now.forEach((node) => {
      const o = new MutationObserver(onMutation);
      o.observe(node, { childList: true, subtree: true, characterData: true });
      observers.push(o);
    });
  }

  // =========================================================================
  // 翻譯：先查快取，未命中才聚合送後端
  // =========================================================================
  let currentEn = '';              // 畫面上正在顯示的英文原句

  // =========================================================================
  // 免費層閘門
  //
  // 免費額度：**每天一份，所有影片加起來**——登入 15 分鐘、未登入 5 分鐘（台灣時間 0 點重置）。
  // 只有本季的正式場次（練習賽、衝刺排位、衝刺賽、排位賽、正賽）能用，其餘 F1TV 影片不含在內。
  //
  // ⚠️ 2026-09-18 以前是「**每一支**符合資格的影片各 15 分鐘」（重播看播放位置、直播看累計秒數），
  //    看五場就有五個 15 分鐘。使用者決定改成全部影片共用一份每日額度。
  //
  // 這裡是**產品承諾**的實作（使用者看得到的規則）；
  // 成本保護在伺服器（未授權的安裝每天有句數上限）。兩者目的不同，都要有——
  // 只做這一層的話，改一下 storage 就能無限用。
  // =========================================================================
  let licensed = false;              // 有沒有有效授權
  /* @admin-only:start */
  // ⚠️ 宣告要在 refreshLicensed 之前（let 有 TDZ）
  let harvestOn = false;             // 管理版：有沒有設定收割權杖
  // 收割的完整標記進度（state：waiting／ok／incomplete／failed／aborted）。收割佇列靠它判斷這一支結束了沒
  const harvestStamp = { cid: '', state: '', note: '', segCount: 0 };
  // 載入時後端就已經有收割蓋過章的完整一份（＝userscript 的 remoteComplete）
  let harvestBundleComplete = false;
  // 每句在影片裡的秒數（2026-11-06，後台翻譯清單的時間軸）：normKey → 秒，同一句取最早出現的那次。
  // 只在重播的整軌預抓時記（分段在清單裡的累計長度＝影片時間），蓋章時一起送
  const harvestTimes = new Map();
  /* @admin-only:end */
  // 有沒有登入帳號。**只影響免費額度的長度**（遊客 5 分鐘、登入 15 分鐘），
  // 不影響任何功能——登入不是使用的必要條件。
  let signedIn = false;
  let acctChecked = false;           // 第一次問過登入狀態沒有（載入頁面那一次不算「剛登入」）
  let freeSession = false;           // 這支影片屬不屬於免費涵蓋的場次
  let freeSpent = 0;                 // 今天（台灣時間）所有影片加起來已用掉的免費秒數
  let freeDay = '';                  // freeSpent 屬於哪一天
  let lastTickAt = 0;
  let trialEndedShown = false;

  /** 這個人的免費額度總長（秒）。遊客與登入不同。 */
  function freeLimitSec() {
    return signedIn
      ? ((freeTierCfg && freeTierCfg.seconds) || 900)
      : ((freeTierCfg && freeTierCfg.guestSeconds) || 300);
  }

  /**
   * 免費額度的「一天」：**台灣時間**。
   * ⚠️ 不可以用使用者電腦的時區——改時區就能多拿一天；條款與網站寫的也是台灣時間。
   */
  function freeDayKey(now) {
    return new Date((now || Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }
  /** 跨過台灣時間 0 點：今天的額度重新開始。 */
  function rollFreeDay() {
    const d = freeDayKey();
    if (d === freeDay) return;
    freeDay = d; freeSpent = 0; freeUnsaved = 0; trialEndedShown = false;
  }

  /** 免費額度還剩幾秒。授權中回傳 Infinity。 */
  function freeSecondsLeft() {
    if (licensed) return Infinity;
    if (!freeSession) return 0;
    rollFreeDay();
    // ⚠️ freeTier 掛在**設定的根層**，不是 sites[i] 底下。
    //    原本寫 `site.freeTier` 永遠是 undefined，於是一直用內建值——
    //    遠端推的免費層設定完全不會生效，而且不報錯（這個專案的招牌錯法）。
    // 遊客與登入的額度不同。⚠️ **真正的閘門在伺服器**（它依帳號算每日句數），
    //    這裡只是讓畫面上的倒數與伺服器一致；用戶端改這個數字沒有用。
    // 直播與重播一律用**實際觀看秒數**：額度是全部影片共用的，播放位置在這裡沒有意義
    //（以前重播看「是不是在前 15 分鐘」，那等於每支影片各送一份）。暫停不扣。
    return Math.max(0, freeLimitSec() - freeSpent);
  }

  /**
   * 記錄免費用量。
   *
   * ⚠️ **這裡要寫進 storage，不能只留在記憶體。**
   *    舊版 `freeSpent` 是 content script 的區域變數，開新分頁就從 0 開始——
   *    使用者只要按一下「在新分頁開啟」就重置了計時。伺服器端每日 800 句
   *    仍然擋得住成本，但畫面上顯示「剩餘 15:00」等於在告訴他這招有效，
   *    而**讓使用者以為自己找到漏洞，比真的有漏洞更糟**：
   *    他會去講給別人聽，而且再也不會付錢。
   *
   *    storage 是整個擴充功能共用的，所以**所有分頁、所有影片**看到同一份今日用量。
   *    每個分頁只寫「自己新增的秒數」（freeUnsaved），讀回來再取較大值——
   *    兩個分頁同時在看時各扣各的，不會互相覆蓋成比較少的那一份。
   */
  const FREE_DAILY_KEY = 'freeDaily';
  let freeUsageSaveAt = 0;
  let freeUnsaved = 0;

  function tickFreeUsage() {
    const now = Date.now();
    rollFreeDay();
    // 只在「真的在免費看翻譯」時扣：有授權、不在免費範圍、關掉翻譯、暫停，都不扣
    if (!licensed && freeSession && settings.enabled && isActuallyPlaying() && freeSpent < freeLimitSec()) {
      if (lastTickAt) {
        const d = Math.min(5, (now - lastTickAt) / 1000);
        freeSpent += d; freeUnsaved += d;
      }
      // 節流寫入：每 5 秒一次就夠，chrome.storage 寫太密會拖慢
      if (now - freeUsageSaveAt > 5000) {
        freeUsageSaveAt = now;
        saveFreeDaily();
      }
    }
    lastTickAt = now;
  }

  function saveFreeDaily() {
    const add = freeUnsaved;
    if (!add) return;
    freeUnsaved = 0;
    const day = freeDay;
    try {
      chrome.storage.local.get(FREE_DAILY_KEY, (o) => {
        const cur = (o && o[FREE_DAILY_KEY]) || {};
        const base = cur.day === day ? (Number(cur.spent) || 0) : 0;
        const spent = Math.round((base + add) * 10) / 10;
        if (day === freeDay && spent > freeSpent) freeSpent = spent;
        chrome.storage.local.set({ [FREE_DAILY_KEY]: { day, spent } });
      });
    } catch (e) { /* 分頁關閉中，忽略 */ }
  }

  /** 讀回今天已經用掉的額度（別的分頁、別支影片用掉的都算）。 */
  function loadFreeDaily() {
    rollFreeDay();
    try {
      chrome.storage.local.get(FREE_DAILY_KEY, (o) => {
        const rec = (o && o[FREE_DAILY_KEY]) || {};
        if (rec.day === freeDay && Number.isFinite(rec.spent) && rec.spent > freeSpent) {
          freeSpent = rec.spent;
          evInfo(`今天已使用 ${Math.round(freeSpent)} 秒免費額度（所有影片共用，台灣時間 0 點重置）`);
        }
      });
    } catch (e) { /* noop */ }
  }

  function trialExhausted() {
    if (licensed) return false;
    if (!freeSession) return true;          // 不在免費範圍的影片，一律需要授權
    return freeSecondsLeft() <= 0;
  }

  function showTrialEnded() {
    if (trialEndedShown) return;
    trialEndedShown = true;
    // ⚠️ **分鐘數跟著這個人的額度走。** 以前寫死「15 分鐘」，
    //    遊客（3 分鐘）額度用完時看到的是一句錯的話。
    const mins = Math.round(freeLimitSec() / 60);
    metric('free_exhausted', { sessionType: sessionType(), minutes: mins });
    box.classList.remove('on');
    if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }   // 把原生英文字幕還給使用者
    evWarn(freeSession
      // 方案名稱不要寫死在這裡——「購買 Season」在一週通行證上線後就是錯的，
      // 而且會隨定價調整而漂掉。指向購買頁，那裡的價格永遠是對的。
      ? `⏳ 今天的免費 ${mins} 分鐘已用完（台灣時間 0 點重置）。原生英文字幕已恢復顯示。`
        + (signedIn ? '' : '登入帳號每天可用 15 分鐘；')
        + '購買授權可解除限制：https://pitlingo.com/buy'
      : '🔒 這支影片不在免費範圍內（免費只涵蓋本季的練習賽／衝刺賽／排位賽／正賽）。');
  }

  // =========================================================================
  // 產品數據
  //
  // **只送彙總得出來的維度，不送 contentId、不送任何識別碼。**
  // 我們要回答的是「排位賽佔多少」「15 分鐘夠不夠」「哪個版本錯最多」，
  // 不是「這個人看了什麼」——後者對優化沒幫助，卻讓隱私政策難寫、
  // 審查難過、外洩時後果嚴重得多。
  //
  // 攢著批次送，不要每個事件都打一次網路。
  // =========================================================================
  const metricQueue = [];
  let metricTimer = null;

  /** 從網址推出場次類型。與免費層用同一份規則，但這裡只要粗分類。 */
  function sessionType() {
    const p = location.pathname.toLowerCase();
    if (!self.PL.isFreeSession(p, freeTierCfg)) return 'other';
    if (/practice/.test(p)) return 'practice';
    if (/qualifying/.test(p)) return 'qualifying';
    if (/sprint/.test(p)) return 'sprint';
    return 'race';
  }

  function metric(event, dims) {
    metricQueue.push({ event, dims: Object.assign({ version: EXT_VERSION }, dims || {}) });
    if (metricQueue.length > 40) metricQueue.shift();
    clearTimeout(metricTimer);
    // 30 秒攢一次。事件很少，不值得為它增加請求數。
    metricTimer = setTimeout(flushMetrics, 30000);
  }

  function flushMetrics() {
    if (!metricQueue.length) return;
    const events = metricQueue.splice(0, metricQueue.length);
    send({ type: 'metric', events }).catch(() => {});
  }

  // =========================================================================
  // 自動診斷回報（**預設關閉，沒有任何介面可以打開**）
  //
  // 為什麼要有：提前量與中文落後這兩個數字**只存在使用者的瀏覽器裡**，後端
  //   完全看不到。2026-09-23 亞塞拜然暖身那場，後端那一半的數字全部拿到了，
  //   擴充功能這一半整場空白——因為賽後沒有人記得按那顆按鈕。
  //   **量測不可以依賴「記得按按鈕」**，直播只有一次，錯過就沒有了。
  //
  // ⚠️ **預設關閉。** 只有 `__pitlingo.autoDiag(10)`（或直接寫 storage）才會啟用，
  //   設定頁上不存在這個開關。隱私權政策承諾「診斷資訊只在你按下傳送時才送出」，
  //   這條承諾不可以因為我們想量測就破功——客戶端永遠不會自己上傳任何東西。
  //
  // ⚠️ 計時用「**實際播放的時間**」，不是牆上時鐘。分頁切到背景時 setInterval 會被
  //   拉長到一分鐘一次（見檔案開頭），用牆上時鐘會在暫停或切走時照樣累積，
  //   回來之後一次噴出好幾份內容幾乎相同的報告。
  const AUTO_DIAG_MAX = 24;           // 一次頁面載入最多送幾份（10 分鐘 × 24 = 4 小時）
  // 單次 tick 最多計入多少播放進度。分頁被切到背景時 setInterval 會被拉長到一分鐘一次，
  // 所以上限要容得下那一格；超過就當成拖進度條（直播可以往回拉 DVR），不計。
  const AUTO_DIAG_TICK_CAP = 180000;
  const AUTO_DIAG_END_MS = 90000;     // 停止播放這麼久之後補送最後一份
  const AUTO_DIAG_MIN_END_MS = 60000; // 還沒送過的話，至少要播過這麼久才值得補一份
  let autoDiagMin = 0;                // 0 = 關閉
  /* @admin-only:start */
  let adminAutoLive = false;          // 管理版「📡 自動開直播」：false／true（主機）／'standby'（診斷報告用）
  let adminRafRate = null;            // 最近 10 秒 requestAnimationFrame 每秒幾次（A12）
  /* @admin-only:end */
  let autoDiagPlayedMs = 0;
  let autoDiagSent = 0;
  let autoDiagTickAt = 0;
  let autoDiagCt = null;              // 上一次看到的播放進度（秒）
  let autoDiagLastPlayAt = 0;
  let autoDiagPendingEnd = false;

  /** 把輸入收斂成 0（關閉）或 1~60 分鐘。storage 與 Console 兩條路共用。 */
  function autoDiagClamp(v) {
    const n = Number(v === true ? 10 : v);
    return Number.isFinite(n) && n > 0 ? Math.min(60, Math.max(1, Math.round(n))) : 0;
  }

  function autoDiagStatus() {
    return autoDiagMin
      ? `自動診斷回報：每 ${autoDiagMin} 分鐘（只在播放中計時），本頁已送 ${autoDiagSent} 份`
      : '自動診斷回報：關閉';
  }

  function autoDiagSet(min) {
    autoDiagMin = autoDiagClamp(min);
    autoDiagPlayedMs = 0;
    autoDiagTickAt = 0;
    autoDiagCt = null;
    // 寫進 storage：同一場直播開好幾個分頁時，其他分頁靠 onChanged 跟上。
    try { chrome.storage.local.set({ autoDiag: autoDiagMin }); } catch (e) { /* noop */ }
    return autoDiagStatus();
  }

  function sendAutoDiag(why) {
    autoDiagSent += 1;
    autoDiagPlayedMs = 0;
    const n = autoDiagSent;
    evInfo(`自動送出診斷（${why}）第 ${n} 份`);
    return send({
      type: 'sendReport',
      auto: true,
      report: buildDiagnostics(),
      note: `自動回報（${why}）第 ${n} 份`,
      contact: '',
      version: EXT_VERSION,
    }).catch(() => { /* 量測失敗絕不影響觀看 */ });
  }

  function tickAutoDiag() {
    if (!autoDiagMin || orphaned) return;
    const now = Date.now();
    const playing = isActuallyPlaying();
    // ⚠️ **用播放進度的增量計時，不是牆上時鐘的增量。**（2026-09-24 實測後改）
    //    原本是「牆上時鐘的差，單次最多計 5 秒」。那個 5 秒上限是為了擋背景節流，
    //    但**背景分頁的影片照樣在播**——節流成一分鐘一格之後，10 分鐘的播放只被算成 50 秒，
    //    報告間隔被拉長到四倍（實測 FP2 有一段 20:12→20:52 沒有任何一份）。
    //    影片自己的 currentTime 只在真的播放時前進，暫停、背景、節流全部自動正確。
    const v = document.querySelector('video');
    const ct = v ? Number(v.currentTime) : NaN;
    if (playing && Number.isFinite(ct) && autoDiagCt !== null) {
      const d = (ct - autoDiagCt) * 1000;
      // 負的或太大的是拖進度條（直播可以往回拉 DVR），不是播放
      if (d > 0 && d <= AUTO_DIAG_TICK_CAP) autoDiagPlayedMs += d;
    }
    autoDiagCt = Number.isFinite(ct) ? ct : null;
    autoDiagTickAt = now;
    if (playing) { autoDiagLastPlayAt = now; autoDiagPendingEnd = true; }

    if (playing && autoDiagSent < AUTO_DIAG_MAX && autoDiagPlayedMs >= autoDiagMin * 60000) {
      sendAutoDiag('定期');
      return;
    }
    // 場次結束（或使用者離開播放）之後補一份：最後那幾分鐘的數字才是完整的，
    // 而使用者關掉分頁之前不會有任何人通知我們。
    // ⚠️ 條件不可以只寫 `autoDiagSent > 0`：只看了 5 分鐘就關掉的場次
    //    （間隔還沒到）會**一份都拿不到**，而那種短場次往往正是出問題的那一場。
    if (!playing && autoDiagPendingEnd && autoDiagSent < AUTO_DIAG_MAX
      && (autoDiagSent > 0 || autoDiagPlayedMs >= AUTO_DIAG_MIN_END_MS)
      && autoDiagLastPlayAt && now - autoDiagLastPlayAt >= AUTO_DIAG_END_MS) {
      autoDiagPendingEnd = false;
      sendAutoDiag('結束');
    }
  }

  async function refreshLicensed() {
    // 登入狀態順便更新。⚠️ 問不到時**維持原狀**，不要當成登出——
    //    那會讓免費額度突然從 15 分鐘掉到 5 分鐘，而使用者不知道為什麼。
    const wasSignedIn = signedIn;
    try {
      const a = await send({ type: 'accountStatus' });
      if (a && a.ok && a.result) signedIn = !!a.result.signedIn;
    } catch (e) { /* 維持原狀 */ }
    // 試看用完之後才登入（2026-10-31 R19 FP2 Ray 實測：要重新整理頁面才會變 15 分鐘）：
    //    額度從 5 分鐘變 15 分鐘，**當場**恢復中文——提示重新允許出現（下次用完還要再講一次），
    //    原生英文字幕重新隱藏由下面的 applyHideNative（呼叫端在 refreshLicensed 之後也會再叫一次）負責
    const firstCheck = !acctChecked;
    acctChecked = true;
    if (!firstCheck && signedIn && !wasSignedIn && !licensed) {
      trialEndedShown = false;
      evInfo(`✅ 已登入：今天的免費額度變成 ${Math.round(freeLimitSec() / 60)} 分鐘（剩 ${Math.round(freeSecondsLeft() / 60)} 分鐘）`);
      applyHideNative();
    }

    const res = await send({ type: 'licenseStatus' });
    const was = licensed;
    licensed = !!(res.ok && res.license && res.license.active);
    /* @admin-only:start */
    // 管理版設了收割權杖：後端把這個身分當付費（authClient → legacy），用戶端的免費閘門也要跟著放行，
    // 否則整軌預抓會被「免費模式」擋掉、收割一支都跑不起來。
    if (harvestOn) licensed = true;
    /* @admin-only:end */
    if (licensed !== was) {
      evInfo(licensed ? '✅ 授權已生效，無使用限制' : 'ℹ️ 目前為免費模式');
      if (licensed) trialEndedShown = false;      // 剛買完要立刻恢復顯示
      // 額度用完時原生英文字幕被還給使用者；買完之後要重新隱藏，否則畫面上兩份英文
      applyHideNative();
    }
  }

  // =========================================================================
  // 字幕時機微調
  //
  // 使用者實測發現 F1TV 官方字幕本身時快時慢。這裡讓他自己補那個偏差。
  //
  // **兩個方向的難度完全不同：**
  //
  //   延後（offset < 0）  容易。收到字幕後 setTimeout 再顯示。零風險，任何情況都能用。
  //   提前（offset > 0）  難。我們是「看到 F1TV 畫出字幕才知道有這句」，
  //                       本質上不可能比它更早——除非用 VTT 的時間軸。
  //
  // 而直接用 VTT 時間軸就是 handoff 決策 4.1 明確避開的那條路：
  // HLS 分段 VTT 的時間基準要靠 X-TIMESTAMP-MAP 換算，很脆弱，
  // 做出來常常是「翻譯正確但時機歪掉」。
  //
  // **所以這裡不解析 X-TIMESTAMP-MAP，改用自我校準：**
  // 每當 DOM 出現一句我們手上也有 VTT 時間的字幕，就記下
  // `video.currentTime - cue 時間` 這個差值。取中位數就是這支影片的基準偏移。
  // 有了它才啟用提前顯示；校準樣本不足就自動退回「只能延後」。
  //
  // 好處是它自我修正、不依賴任何格式假設，而且**校準失敗時的退化方向是安全的**
  // （退回現在的行為，而不是顯示錯位的字幕）。
  //
  // ⚠️ 直播只允許延後。直播的字幕清單是滑動視窗，基準點會隨著重抓而變，
  //    校準出來的值不可信——寧可不做，也不要在直播時顯示錯位的字幕。
  // =========================================================================
  // 兩個方向的上限**刻意不對稱**：
  //   延後是純 setTimeout，不依賴任何推論，加多久就是多久 → 放寬到 3 秒
  //   提前依賴校準值，誤差會直接變成「字幕顯示在錯的地方」 → 維持 2 秒
  // 對稱看起來比較整齊，但那會讓風險最高的方向拿到最大的權限。
  const OFFSET_LATE_MAX_MS = 3000;   // 延後（負值）的上限
  const OFFSET_EARLY_MAX_MS = 2000;  // 提前（正值）的上限
  const CALIB_MIN = 12;              // 至少要這麼多樣本才敢下判斷
  const CALIB_KEEP = 40;             // 樣本保留數（滑動視窗）
  const CUE_MAX = 20000;             // cue 時間／原文的記錄上限

  // ⚠️ **離散度閘門——這是提前顯示唯一可信的依據。**
  //
  // `parseVtt` 的 `start` 是 cue 在**那個分段檔案內**的秒數。F1TV 的分段
  // VTT 究竟寫絕對時間還是分段內相對時間，我們沒有實測過，而兩者的差別
  // 是致命的：
  //   絕對時間 → `currentTime - cue` 是常數，中位數就是基準偏移，提前顯示成立
  //   分段相對 → 這個差值等於「該分段的起始時間」，隨播放持續變大，
  //              中位數是垃圾，提前顯示會在隨機的時刻噴出隨機的句子
  //
  // 舊版直接取 8 個樣本的中位數就相信它，**沒有任何辦法分辨這兩種情況**——
  // 那正是「用起來怪怪的、不確定有沒有效」的來源。
  //
  // 改成看樣本的**四分位距（IQR）**：
  //   絕對時間的話所有樣本會擠在一起（IQR 只反映播放器畫字幕的抖動，遠小於 1 秒）
  //   分段相對的話樣本會攤在整支影片的長度上（IQR 是幾百秒）
  // 超過門檻就判定「cue 時間軸不可用」，自動退回只允許延後。
  //
  // 這樣不論 F1TV 用哪種寫法都不會出錯，而且**判斷結果會寫進診斷報告**，
  // 不用再靠感覺猜它有沒有生效。
  const CALIB_MAX_SPREAD_S = 1.0;

  const cueTimes = new Map();        // normKey -> VTT 裡的 cue 起始秒數
  const cueText = new Map();         // normKey -> 原文。提前顯示時要一起畫出來

  // =======================================================================
  // 補上官方漏掉的字幕（2026-09-16，使用者要求「做得比官方還好」）
  //
  // 現象：F1TV 的原生字幕偶爾會少一兩句。**使用者看到的是 PitLingo 沒翻**，
  //       不會想到是官方播放器本來就沒畫。
  //
  // 但「少一句」有三種完全不同的成因，能不能補取決於是哪一種：
  //   A. VTT 裡有這句，播放器沒畫（或被下一句瞬間蓋掉）→ **補得到**
  //   B. 我們的 250ms 輪詢沒抓到很短的那一句              → **補得到**（同一條路）
  //   C. VTT 裡根本沒有（聽打員漏打）                     → 沒有來源，只能靠語音辨識
  //
  // ⚠️ **不可以直接拿 VTT 的時間去對 `video.currentTime`。**
  //    cue 時間可能是「分段檔案內的相對秒數」（見 parseVtt 上方的說明），
  //    這種情況下絕對對不上，補出來的會是隨機時刻的隨機句子。
  //    既有的「提前顯示」為此加了校準閘門，而校準常常過不了。
  //
  //    這裡改用**錨點**：原生字幕剛畫出某一句時，記下那一刻的播放位置；
  //    下一句該在「錨點位置 +（兩句 cue 起始時間的差）」出現。
  //    **同一個 VTT 檔案內，兩句的時間差不論基準是絕對或相對都是準的**，
  //    所以不需要校準。跨檔案的差值只有在偵測到絕對時間軸時才採用。
  //
  // ⚠️ 用**播放位置**而不是牆上時鐘推算——暫停、倍速、拖進度條都自動正確。
  // =======================================================================
  const timeline = [];               // 依抵達順序：{ k, text, start, end, file, seq, dom, filled }
  const timelineIdx = new Map();     // `${k}@${start}` -> entry（同一分段被抓兩次時去重）
  const keyEntries = new Map();      // normKey -> [entry, ...]（同一句可能出現多次）
  let vttFileSeq = 0;
  let cueSeq = 0;                    // ⚠️ 不變式：timeline[seq - 1] === 那一筆。重置時要一起歸零
  let fillAnchor = null;             // { entry, media } 原生字幕最後畫出的那一句
  let fillActive = null;             // { entry, fromMedia, untilMedia } 我們正在補的那一句
  let timeBase = 'unknown';          // 'absolute' | 'relative' | 'unknown'
  const timeBaseSamples = [];        // 跨檔案相鄰兩句的時間差是否合理
  const gapFill = { filled: 0 };
  const FILL_LAG_S = 0.8;            // 給原生字幕的寬限：它只是晚一點畫，就不要搶
  const FILL_ANCHOR_MAX_S = 45;      // 錨點離太遠就不信（拖進度條、長時間空白）
  const FILL_SCAN = 8;               // 從錨點往後最多看幾句
  // ---- 提前量（LIVE-TEST ①）-------------------------------------------
  // VTT 抵達 → 那一句出現在畫面上，中間有多少毫秒。
  // **這決定了直播能不能做並發去重**：有幾十秒就能讓路等別人翻，
  // 沒有的話讓路等於放棄那一句。重播實測是 47~53 秒，直播從未量過。
  const vttSeenAt = new Map();       // normKey -> VTT 抵達的時間（毫秒）
  const leadSamples = [];            // 每一句的提前量（毫秒）

  /** 提前量摘要。給診斷報告用——沒有人看的數字等於沒有量。 */
  function leadStats() {
    if (!leadSamples.length) return null;
    const a = leadSamples.slice().sort((x, y) => x - y);
    const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
    return { n: a.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), min: a[0], max: a[a.length - 1] };
  }

  /** 把一句 cue 記進時間軸。同一分段被抓第二次時不重複記。 */
  function noteTimeline(k, text, cue, file, firstOfFile) {
    const id = k + '@' + cue.start;
    if (timelineIdx.has(id)) return;
    const end = (cue.end !== null && cue.end > cue.start) ? cue.end : cue.start + 3;

    // 時間基準偵測：**新檔案的第一句**與上一筆（別的檔案）比。
    // 絕對時間軸時差值是小的正數；分段相對時間會一直掉回 0 附近（負的）。
    // 預抓若亂序抵達也會出現負值——那剛好會被判成「不可信」，是安全的那一邊。
    const prev = timeline[timeline.length - 1];
    if (firstOfFile && prev && prev.file !== file) {
      const d = cue.start - prev.start;
      timeBaseSamples.push(d >= 0 && d < 30);
      if (timeBaseSamples.length > 40) timeBaseSamples.shift();
      if (timeBaseSamples.length >= 20) {
        const ok = timeBaseSamples.filter(Boolean).length / timeBaseSamples.length;
        timeBase = ok >= 0.9 ? 'absolute' : ok < 0.5 ? 'relative' : 'unknown';
      }
    }

    const e = { k, text, start: cue.start, end, file, seq: ++cueSeq, dom: false, filled: false };
    timeline.push(e);
    timelineIdx.set(id, e);
    const list = keyEntries.get(k);
    if (list) list.push(e); else keyEntries.set(k, [e]);
  }

  /**
   * 原生字幕畫出一句時呼叫：標記「官方有畫」並把它設成錨點。
   *
   * 同一句可能在時間軸上出現很多次（「Copy」「Box box」），
   * 要挑**錨點之後的第一筆**，否則會錨到一小時前的那一次。
   */
  function noteDomCue(text) {
    const k = normKey(text);
    if (!k) return;
    const list = keyEntries.get(k);
    if (!list) return;
    const after = fillAnchor ? fillAnchor.entry.seq : 0;
    const e = list.find((x) => x.seq > after && !x.dom) || list.find((x) => !x.dom) || list[list.length - 1];
    e.dom = true;
    const v = document.querySelector('video');
    if (v && Number.isFinite(v.currentTime)) fillAnchor = { entry: e, media: v.currentTime };
    // 原生字幕追上來了（或換成下一句），由 DOM 路徑接手
    fillActive = null;
  }

  /**
   * 每次輪詢：原生字幕是空的、但依錨點推算這時候應該有一句 → 我們補上。
   *
   * ⚠️ **只在原生字幕是空的時候動作。** 原生有字就一律交給 DOM 路徑，
   *    兩條路搶同一個畫面只會讓字幕閃爍。
   */
  function tickGapFill(cur) {
    if (cur) { fillActive = null; return; }
    const v = document.querySelector('video');
    if (!v || !Number.isFinite(v.currentTime)) return;

    // 正在補的那一句到期了（或被拖走了）就收起來。
    // ⚠️ 這裡一定要自己收：原生字幕本來就是空的，輪詢不會再觸發 scheduleHide，
    //    不收的話它會賴在畫面上到 HOLD_MS（7 秒）。
    if (fillActive) {
      if (v.currentTime >= fillActive.untilMedia || v.currentTime < fillActive.fromMedia - 1) {
        fillActive = null;
        box.classList.remove('on');
      }
      return;
    }

    // 延後／提前顯示時時間軸已經被平移，兩種機制疊在一起很難保證正確——先不補
    if (!fillAnchor || v.paused || trialExhausted() || activeOffsetMs() !== 0) return;
    const elapsed = v.currentTime - fillAnchor.media;
    if (elapsed < 0 || elapsed > FILL_ANCHOR_MAX_S) { fillAnchor = null; return; }

    const a = fillAnchor.entry;
    for (let i = a.seq; i < timeline.length && i < a.seq + FILL_SCAN; i++) {
      const e = timeline[i];
      // 跨檔案的時間差只有在時間軸確定是絕對時才可信
      if (e.file !== a.file && timeBase !== 'absolute') break;
      const rel = e.start - a.start;
      const relEnd = e.end - a.start;
      if (rel <= 0 || rel > FILL_ANCHOR_MAX_S) break;
      if (elapsed < rel + FILL_LAG_S) break;          // 還沒到（時間軸依序，後面更晚）
      if (elapsed >= relEnd) continue;                // 這一句的時段已經過了
      if (e.dom || e.filled) continue;
      // 與錨點同一句：原生多半是連續顯示同一行，不要重畫
      if (e.k === a.k) continue;

      const zh = memo.get(e.k);
      if (!zh) {
        // 還沒有譯文就不補——不畫「翻譯中…」這種佔位字（見 handleCaption 的說明）。
        // 但把它排成急件，下一句這種情況就來得及。
        if (!requested.has(e.k) && pending.size < PENDING_MAX) {
          urgentKeys.add(e.k); pending.set(e.k, e.text); scheduleFlush();
        }
        return;
      }
      e.filled = true;
      gapFill.filled++;
      lastRaw = '';
      render(zh, settings.showEnglish ? e.text : '');
      fillActive = { entry: e, fromMedia: v.currentTime, untilMedia: fillAnchor.media + relEnd };
      dbg(`補上官方漏掉的字幕：${e.text.slice(0, 50)}`);
      return;
    }
  }

  /**
   * 官方漏了幾句、我們補了幾句。
   *
   * 「漏掉」的判定**不看時間，看順序**：兩句原生有畫的字幕之間
   * （相距 3 句以內），夾著一句原生沒畫的——那就是漏掉。
   * 相距太遠的空洞不算，那通常是拖進度條或中途才開始看。
   *
   * ⚠️ 同一句連續出現兩次時，原生是連續顯示同一行，DOM 不會變化，
   *    所以第二筆永遠不會被標成 dom。左右鄰居是同一句且有畫，就當作有畫。
   */
  function fillStats() {
    let seen = 0, dropped = 0, lastDom = 0;
    const domSeqs = [];
    for (const e of timeline) if (e.dom) { seen++; domSeqs.push(e.seq); }
    if (!seen) return null;
    let j = 0;
    for (const e of timeline) {
      if (e.seq < domSeqs[0] || e.seq > domSeqs[domSeqs.length - 1]) continue;
      while (j < domSeqs.length && domSeqs[j] < e.seq) { lastDom = domSeqs[j]; j++; }
      if (e.dom) continue;
      const next = j < domSeqs.length ? domSeqs[j] : Infinity;
      if (e.seq - lastDom > 3 || next - e.seq > 3) continue;
      const pv = timeline[e.seq - 2];
      const nx = timeline[e.seq];
      if ((pv && pv.k === e.k && pv.dom) || (nx && nx.k === e.k && nx.dom)) continue;
      dropped++;
    }
    return {
      seen, dropped, filled: gapFill.filled, timeBase,
      rate: seen + dropped ? +((dropped / (seen + dropped)) * 100).toFixed(2) : 0,
    };
  }

  // =======================================================================
  // 直播實測（LIVE-TEST）自動採樣
  //
  // ⚠️ **這一段存在的理由是「每次都忘記」。**
  //
  //    LIVE-TEST.md 列了五個要量的數字，寫得很清楚——但每一個都需要
  //    「直播當下人在電腦前，而且記得要做」。實際跑了好幾場直播之後，
  //    **五個裡面一個都沒有被量到**。文件沒有錯，錯的是把它交給記憶。
  //
  //    所以改成：**開著就自動量，什麼都不用按。** 事後匯出診斷就有全部數字。
  //
  // ⚠️ **只採樣，不改變任何行為。** 這裡絕對不可以去動播放、動節奏、動請求——
  //    量測本身改變了被量的東西，量到的數字就沒有意義了。
  //
  // ⚠️ **不可以無限成長。** 直播三小時 ＝ 1,080 次採樣。所有東西都存成
  //    彙總值（計數、極值、總和），只有「事件」才留清單而且有上限（坑 #3）。
  // =======================================================================
  const LT_TICK_MS = 10000;          // 每 10 秒採樣一次
  const LT_MAX_TICKS = 2200;         // 約 6 小時就停（比任何一場直播都長）
  const LT_MAX_EVENTS = 60;          // 解析度變化／卡頓事件的上限

  // ⚠️ **宣告必須排在 ltTick 之前。** `let` 有 TDZ，而 ltTick 的最後一行會讀它。
  //    這個檔案已經因為同一件事踩過一次（見 debugOn 的說明）：
  //    宣告放在後面時 `node --check` 完全過得去，要等到那一行真的執行才爆炸，
  //    而它發生在 setInterval 裡——**錯誤會被吞掉，採樣靜靜地停掉**。
  let hudOn = false;

  const liveTest = {
    startedAt: 0,
    ticks: 0,
    // ⑤ 播放品質。**這是唯一能客觀回答「開著會不會卡」的東西**——
    //    在此之前 LIVE-TEST.md 寫的是「主觀感受：播放順不順」。
    q: { dropped: 0, total: 0, res: '', resChanges: [], stalls: 0, stallSec: 0 },
    // ① 提前量由 leadStats() 提供，這裡只記「直播當下」的那一份
    // ④ 免費層計時
    free: { startLeft: null, lastLeft: null, endedAt: 0 },
    // DVR 深度（延遲畫面的預算上限）
    dvr: { n: 0, minDepth: null, maxDepth: null, minBehind: null, maxBehind: null },
    // 播放器緩衝存量：讓路機制的判斷依據
    buf: { n: 0, sum: 0, min: null },
    events: [],
  };

  function ltNote(msg) {
    if (liveTest.events.length >= LT_MAX_EVENTS) return;
    liveTest.events.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  }

  let ltTimer = null;
  let ltWasStalled = 0;

  // ---- 觀看時間 ----
  //
  // ⚠️ **HUD 原本顯示的是「頁面開著多久」，而且標得像觀看時間。**
  //    `Date.now() - liveTest.startedAt`，startedAt 在頁面載入時設一次：
  //    暫停也在算、換影片也不歸零。使用者問「這是停留在影片的時間嗎」
  //    ——答案是「比那還糟，是整個分頁開著的時間」。
  //
  //    現在分成兩個數字，而且每支影片各自重算：
  //      opened  這支影片打開多久（含暫停）
  //      watched 實際在播放的秒數（暫停、緩衝、結束都不算）
  let watchMs = 0;
  let watchLastAt = 0;
  function accumulateWatch() {
    const now = Date.now();
    const v = document.querySelector('video');
    const playing = !!(v && !v.paused && !v.ended && v.readyState >= 3);
    // 單次最多計 1 秒：分頁被節流時輪詢可能好幾秒才跑一次，
    // 那段時間影片是否真的在播我們不知道，寧可少算。
    if (playing && watchLastAt) watchMs += Math.min(now - watchLastAt, 1000);
    watchLastAt = playing ? now : 0;
  }

  /** 秒數 → H:MM:SS（未滿一小時顯示 M:SS）。無效值回 '—'。 */
  function fmtClock(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 0) return '—';
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = String(Math.floor(n % 60)).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function ltTick() {
    liveTest.ticks++;
    if (liveTest.ticks > LT_MAX_TICKS) { ltStop(); return; }
    const v = document.querySelector('video');
    if (!v) return;

    // ---- ⑤ 播放品質：掉幀與解析度 ----
    //
    // ⚠️ `getVideoPlaybackQuality()` 不是每個瀏覽器都有，而且**取得失敗
    //    不可以讓整個採樣停掉**——它只是五項裡的一項。
    try {
      if (typeof v.getVideoPlaybackQuality === 'function') {
        const pq = v.getVideoPlaybackQuality();
        // 這兩個是 **video 元素的累計值**。F1TV 換影片時常常沿用同一個
        // video 元素，所以要記下這支影片開始時的基準，否則會把上一支的掉幀算進來。
        if (Number.isFinite(pq.droppedVideoFrames) && Number.isFinite(pq.totalVideoFrames)) {
          if (!liveTest.q.base || pq.totalVideoFrames < liveTest.q.base.t) {
            liveTest.q.base = { d: pq.droppedVideoFrames, t: pq.totalVideoFrames };
          }
          liveTest.q.dropped = pq.droppedVideoFrames - liveTest.q.base.d;
          liveTest.q.total = pq.totalVideoFrames - liveTest.q.base.t;
        }
      }
    } catch (e) { /* 沒有就算了 */ }

    if (v.videoWidth && v.videoHeight) {
      const res = `${v.videoWidth}×${v.videoHeight}`;
      if (res !== liveTest.q.res) {
        // **解析度往下掉就是 ABR 在降解析度**——坑 #34 正是這件事。
        if (liveTest.q.res && liveTest.q.resChanges.length < LT_MAX_EVENTS) {
          liveTest.q.resChanges.push(`${liveTest.q.res}→${res}`);
          ltNote(`解析度變化 ${liveTest.q.res} → ${res}`);
        }
        liveTest.q.res = res;
      }
    }

    // ---- 卡頓：播放中但緩衝見底 ----
    const buf = bufferAheadSec();
    if (buf !== null) {
      liveTest.buf.n++; liveTest.buf.sum += buf;
      if (liveTest.buf.min === null || buf < liveTest.buf.min) liveTest.buf.min = buf;
    }
    // readyState < 3 ＝ 沒有足夠資料可以繼續播。**沒在播的時候不算卡頓**，
    // 否則使用者自己暫停也會被記成一次卡頓。
    const stalling = !v.paused && !v.ended && v.readyState < 3;
    if (stalling) {
      if (!ltWasStalled) { liveTest.q.stalls++; ltNote('播放卡頓（readyState < 3）'); }
      ltWasStalled = 1;
      liveTest.q.stallSec += LT_TICK_MS / 1000;
    } else ltWasStalled = 0;

    // ---- DVR 深度（延遲畫面的預算上限）----
    try {
      const sk = v.seekable;
      if (sk && sk.length) {
        const head = sk.start(0);
        const live = sk.end(sk.length - 1);
        const depth = +(live - head).toFixed(1);
        const behind = +(live - v.currentTime).toFixed(1);
        liveTest.dvr.n++;
        const put = (k, val, cmp) => {
          if (liveTest.dvr[k] === null || cmp(val, liveTest.dvr[k])) liveTest.dvr[k] = val;
        };
        put('minDepth', depth, (a, b) => a < b); put('maxDepth', depth, (a, b) => a > b);
        put('minBehind', behind, (a, b) => a < b); put('maxBehind', behind, (a, b) => a > b);
      }
    } catch (e) { /* noop */ }

    // ---- ④ 免費層計時 ----
    if (!licensed) {
      const left = Math.round(freeSecondsLeft());
      if (liveTest.free.startLeft === null) liveTest.free.startLeft = left;
      // **倒數不該在暫停時走。** 記下來，事後對得出來。
      if (v.paused && liveTest.free.lastLeft !== null && left < liveTest.free.lastLeft - 1) {
        ltNote(`⚠️ 暫停中免費額度仍在扣（${liveTest.free.lastLeft} → ${left}）`);
      }
      liveTest.free.lastLeft = left;
      if (left <= 0 && !liveTest.free.endedAt) {
        liveTest.free.endedAt = Date.now();
        ltNote('免費額度用完');
      }
    }

    if (hudOn) hudPaint();
  }

  function ltStart() {
    if (ltTimer) return;
    liveTest.startedAt = Date.now();
    ltTimer = setInterval(ltTick, LT_TICK_MS);
    ltTick();
  }

  function ltStop() {
    if (ltTimer) { clearInterval(ltTimer); ltTimer = null; }
  }

  /** 採樣摘要。**診斷報告一定要帶上**——量了沒人看等於沒量。 */
  function ltSummary() {
    if (!liveTest.startedAt) return null;
    const mins = Math.round((Date.now() - liveTest.startedAt) / 60000);
    return {
      minutes: mins,                              // 這支影片打開多久（含暫停）
      watchedMin: Math.round(watchMs / 60000),     // 實際播放多久
      dropRate: liveTest.q.total
        ? +(liveTest.q.dropped / liveTest.q.total * 100).toFixed(3) : null,
      dropped: liveTest.q.dropped,
      frames: liveTest.q.total,
      res: liveTest.q.res,
      resChanges: liveTest.q.resChanges.slice(),
      stalls: liveTest.q.stalls,
      stallSec: Math.round(liveTest.q.stallSec),
      bufAvg: liveTest.buf.n ? +(liveTest.buf.sum / liveTest.buf.n).toFixed(1) : null,
      bufMin: liveTest.buf.min,
      dvrDepth: liveTest.dvr.maxDepth,
      dvrDepthMin: liveTest.dvr.minDepth,
      behindMin: liveTest.dvr.minBehind,
      behindMax: liveTest.dvr.maxBehind,
      free: liveTest.free.startLeft !== null ? liveTest.free : null,
      events: liveTest.events.slice(),
    };
  }

  const calibSamples = [];           // video.currentTime - cueTime 的樣本
  let calibrated = null;             // 通過閘門的中位數，null = 不可用
  let calibSpread = null;            // 最近一次算出來的 IQR，診斷用
  let calibNote = '尚未取得樣本';    // 人看得懂的狀態，會進診斷報告與設定頁
  const shownEarly = new Set();      // 已經提前顯示過的鍵，避免 DOM 到時重複
  let earlyHoldUntil = 0;            // 提前顯示期間，暫時不讓「原生字幕清空」收掉疊字
  let lastSeekCheck = 0;             // 上次看到的 currentTime，用來偵測往回拖

  /** 把使用者設定夾進合法範圍。非數字一律當 0（跟隨官方字幕）。 */
  function clampOffset(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(-OFFSET_LATE_MAX_MS, Math.min(OFFSET_EARLY_MAX_MS, v));
  }

  /** 目前**實際生效**的偏移。提前的條件不成立時一律回 0。 */
  function activeOffsetMs() {
    const raw = clampOffset(settings.subtitleOffset);
    if (raw <= 0) return raw;                      // 延後：任何情況都安全
    if (state.isLive) return 0;                    // 直播不提前
    if (calibrated === null) return 0;             // 沒校準好就不提前
    return raw;
  }

  /**
   * 設定值與實際行為的落差要說出來。
   *
   * 使用者拉了「提前 1.5 秒」但直播不支援時，畫面上什麼都沒變——
   * 沒有這行字他只會覺得「這個功能是不是壞的」。
   */
  function offsetStatusText() {
    const raw = clampOffset(settings.subtitleOffset);
    if (raw === 0) return '跟隨官方字幕';
    if (raw < 0) return `延後 ${(-raw / 1000).toFixed(1)} 秒（已生效）`;
    const want = `提前 ${(raw / 1000).toFixed(1)} 秒`;
    if (state.isLive) return `${want} → 直播不支援，目前未生效`;
    if (calibrated === null) return `${want} → 未生效：${calibNote}`;
    return `${want}（已生效，${calibNote}）`;
  }

  /** 依目前樣本重算校準值與可信度。樣本不足或太散就把 `calibrated` 收回 null。 */
  function recomputeCalibration() {
    if (calibSamples.length < CALIB_MIN) {
      calibrated = null; calibSpread = null;
      calibNote = `校準中（${calibSamples.length}/${CALIB_MIN} 個樣本）`;
      return;
    }
    const a = calibSamples.slice().sort((x, y) => x - y);
    const q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))];
    const med = q(0.5);
    const iqr = q(0.75) - q(0.25);
    calibSpread = iqr;
    if (!Number.isFinite(med) || !Number.isFinite(iqr) || iqr > CALIB_MAX_SPREAD_S) {
      calibrated = null;
      calibNote = `cue 時間軸不可用（離散 ${Number.isFinite(iqr) ? iqr.toFixed(1) : '?'}s`
        + `，上限 ${CALIB_MAX_SPREAD_S}s）→ 只能延後`;
      return;
    }
    calibrated = med;
    calibNote = `基準 ${med.toFixed(2)}s、離散 ${iqr.toFixed(2)}s`;
  }

  /** DOM 出現一句時記一筆校準樣本。 */
  function noteCalibration(k) {
    if (state.isLive) return;
    const cue = cueTimes.get(k);
    if (cue === undefined) return;
    const v = document.querySelector('video');
    if (!v || !Number.isFinite(v.currentTime)) return;

    calibSamples.push(v.currentTime - cue);
    if (calibSamples.length > CALIB_KEEP) calibSamples.shift();
    recomputeCalibration();
  }

  /**
   * 使用者改設定或換影片時，把所有時序狀態收乾淨。
   *
   * 不做這件事的具體後果：把「延後 3 秒」改成「提前 1 秒」的那一刻，
   * 已經排進去的延後計時器還會在 3 秒後醒來補畫一次——那時畫面早就換句了。
   * 它有 DOM 比對護著不會畫錯內容，但**提前與延後同時活著**這件事本身
   * 就是不該存在的狀態，之後任何一次改動都可能踩到。
   */
  function cancelTimingTimers() {
    // 佇列裡排的是「用舊偏移算出來的」顯示與收起，改了設定就全部作廢。
    // 留著的話「延後 3 秒 → 改成提前」的那一刻，兩種模式會有一段時間同時活著。
    for (const t of delayQueue) clearTimeout(t);
    delayQueue.clear();
    earlyHoldUntil = 0;
  }

  /**
   * 換影片時把「字幕時機」歸零。字級與位置**不歸零**。
   *
   * 為什麼只有這一項要歸零：字級與位置是使用者對「我的螢幕」的偏好，跨影片一定成立。
   * 字幕時機不是——它補的是**這一支影片的**字幕偏差，而那個偏差每支都不同
   * （直播與重播的差別更大）。把上一支調好的值帶到下一支，等於預設就是錯的，
   * 而且錯得很難察覺：使用者不會想到「我上禮拜調過」。
   *
   * 一定要寫回 storage 而不是只改記憶體裡的 `settings`——
   * 否則設定頁的滑桿還停在 -1.5 秒，實際行為卻是 0，
   * 那種「畫面說一套做一套」的狀態比功能不完整更糟。
   */
  function resetOffsetForNewVideo() {
    if (clampOffset(settings.subtitleOffset) === 0) return;   // 已經是預設，別多寫一次
    const next = Object.assign({}, settings, { subtitleOffset: 0 });
    settings = sanitizeSettings(next);
    // 寫回會觸發 storage.onChanged，那裡再 sanitize 一次得到同樣的值，
    // 而且下一輪 clampOffset 已經是 0，不會再寫 → 不會遞迴。
    try { chrome.storage.local.set({ settings }); } catch (e) { /* 分頁正在關閉，忽略 */ }
    evInfo('已換影片，字幕時機回復預設（字級與位置保留）');
  }

  /**
   * 提前顯示。每次輪詢時檢查「再過 offset 毫秒就該出現」的那句。
   *
   * 只在**已經有譯文**時才提前——沒有譯文就提前顯示等於什麼都沒有，
   * 反而讓下面的 DOM 路徑被去重擋掉。
   */
  function tickEarlyDisplay() {
    const off = activeOffsetMs();
    if (off <= 0) return;
    // 免費額度用完之後**這條路也要關**。
    // handleCaption 有擋，但提前顯示不經過它——漏掉的話免費層等於形同虛設。
    if (trialExhausted()) return;
    const v = document.querySelector('video');
    if (!v || !Number.isFinite(v.currentTime) || v.paused) return;

    // 往回拖進度條時把「已提前顯示過」清掉，否則重看那一段完全不會提前。
    // 只認明顯的倒退（2 秒），避免播放器微調 currentTime 就誤判。
    if (v.currentTime < lastSeekCheck - 2) shownEarly.clear();
    lastSeekCheck = v.currentTime;

    const target = v.currentTime - calibrated + off / 1000;
    // 找出「起始時間落在 [target-0.5, target] 這個窗內」且還沒顯示過的那句。
    // 窗口 0.5 秒是為了容忍輪詢間隔與校準誤差。
    for (const [k, t] of cueTimes) {
      if (t > target || t < target - 0.5) continue;
      if (shownEarly.has(k)) continue;
      const zh = memo.get(k);
      if (!zh) continue;
      shownEarly.add(k);
      if (shownEarly.size > 3000) shownEarly.clear();
      lastRaw = '';                 // 讓 DOM 到達時不會因為去重而漏掉狀態更新
      // ⚠️ 原文要一起畫。舊版傳空字串，於是提前顯示時只有中文，
      //    等原生字幕追上來才補英文——**畫面會在一兩秒內跳動一次**。
      //    那個跳動看起來就像「時機怪怪的」，但成因是內容變了不是時機變了。
      render(zh, settings.showEnglish ? (cueText.get(k) || '') : '');
      // 提前顯示的這段期間，原生字幕還沒出現，輪詢會判定「字幕清空」而想收掉。
      // 撐住到原生字幕預期抵達為止，多留一個寬限。上限就是 off，不會無限延長。
      earlyHoldUntil = Date.now() + off + CLEAR_GRACE_MS;
      dbg(`提前 ${off}ms 顯示：${zh.slice(0, 30)}`);
      return;
    }
  }

  /**
   * 延後顯示。
   *
   * ⚠️ **「顯示」與「收起」必須用同一個延遲，這是整個功能的關鍵。**
   *
   * 舊版只延後顯示，收起仍然跟著原生字幕即時走。後果是每一句的顯示時間
   * 都被硬生生砍掉 N 毫秒：
   *
   *   原生字幕 0 ~ 1200ms、延後 1000ms
   *     → 我們 1000ms 才畫出來，1200ms 原生就清空了，1550ms 收起
   *     → 使用者看到的是**閃一下就不見**（只有 550ms）
   *
   *   原生字幕 0 ~ 800ms、延後 1000ms
   *     → 排程到 1000ms 時原生早就沒了，舊版的 DOM 比對判定「畫面已換句」
   *     → **這一句完全不顯示**
   *
   * 而轉播字幕每 3~4 秒換一句，延後 3 秒幾乎必然落在這兩種情況裡——
   * 延後開得愈大，掉字幕愈嚴重。這就是「有些字幕顯示出來後馬上消失、
   * 有時甚至完全沒顯示」的成因。
   *
   * 正解是把延後當成**整條時間軸的平移**：顯示、收起都進同一個佇列，
   * 使用者看到的就是原生字幕往後挪 N 毫秒，長度完全不變。
   *
   * 舊版那個 DOM 比對是為了坑 #18（過時的譯文重新彈出）加的，但那個坑屬於
   * **翻譯慢回來才補顯示**的路徑（`flushPending` 裡那段，仍然保留檢查）。
   * 這裡的排程是在字幕出現當下、譯文已經在手上時就決定的，延遲量固定、
   * 順序不會亂——它不是「遲到的結果」，是「刻意平移的結果」，不該套同一條規則。
   */
  const delayQueue = new Set();
  const DELAY_QUEUE_MAX = 40;        // 字幕異常抖動時不要無限堆積

  function enqueueDelayed(fn) {
    const off = activeOffsetMs();
    if (off >= 0) { fn(); return; }          // 沒開延後就照舊立刻執行

    const cid = contentId;
    const v0 = document.querySelector('video');
    const at0 = v0 && Number.isFinite(v0.currentTime) ? v0.currentTime : null;
    let t = null;
    t = setTimeout(() => {
      delayQueue.delete(t);
      // 這段期間世界可能整個換掉了，逐項確認再動畫面。
      if (cid !== contentId) return;                      // 換了影片
      if (!settings.enabled || killed || tooOld) return;   // 中途被停用
      if (at0 !== null) {
        const v = document.querySelector('video');
        // 拖了進度條就作廢。正常播放時 currentTime 會剛好前進 -off 毫秒，
        // 差太多代表使用者跳走了，這句已經沒有意義。
        if (v && Number.isFinite(v.currentTime)
            && Math.abs(v.currentTime - (at0 + (-off) / 1000)) > 3) return;
      }
      fn();
    }, -off);
    delayQueue.add(t);

    if (delayQueue.size > DELAY_QUEUE_MAX) {
      const oldest = delayQueue.values().next().value;
      clearTimeout(oldest);
      delayQueue.delete(oldest);
    }
  }

  function renderWithOffset(zh, en) {
    earlyHoldUntil = 0;              // 原生字幕已經到了，不需要再撐
    enqueueDelayed(() => render(zh, en));
  }

  function handleCaption(raw) {
    const text = clean(raw);
    if (!text || text.length < 2 || text === lastRaw) return;
    // DOM 路徑同樣要擋。字幕容器若被 F1TV 拿去放別的東西（實測見過整段
    // 節目介紹），送出去只會讓整批被後端退回。
    if (text.length > MAX_LINE_LEN) {
      lastRaw = text;
      state.badLines = (state.badLines || 0) + 1;
      dbg(`略過異常長度的字幕（${text.length} 字元）`);
      return;
    }
    lastRaw = text;
    currentEn = text;
    /* @test-only:start */ plTestHook('native', text); /* @test-only:end */

    // 提前量取樣：這一句的 VTT 是多久以前抵達的。
    // ⚠️ 只在**第一次**看到時取樣（取完就刪），否則同一句在畫面上停留
    //    好幾秒會被輪詢重複記錄，把中位數往上拉。
    {
      const lk = normKey(text);
      const seen = lk ? vttSeenAt.get(lk) : null;
      if (seen) {
        vttSeenAt.delete(lk);
        leadSamples.push(Date.now() - seen);
        if (leadSamples.length > 400) leadSamples.shift();
      }
    }

    // 免費額度用完就停止顯示。**已經在畫面上的不會被抽走**，
    // 只是不再翻新的——中途把字幕整個抽掉比一開始就沒有更惱人。
    if (trialExhausted()) { showTrialEnded(); return; }

    const k = normKey(text);
    sessionKeys.add(k);
    const hit = memo.get(k);
    if (hit) {
      state.hits++;
      zhLagDone(k);
      noteCalibration(k);
      const t0 = performance.now();
      renderWithOffset(hit, text);
      const jsMs = performance.now() - t0;
      detect.renderMs.push(jsMs);
      if (detect.renderMs.length > 200) detect.renderMs.shift();

      // ⚠️ 上面那個數字只到「JS 返回」為止，**不是使用者看到的時間**。
      // 之前只量它就下結論「我們只加 1ms」，漏掉了版面計算與繪製。
      // 兩次 rAF 之後才是這一幀真的上畫面，那個才能拿去跟 userscript 比。
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const paintMs = performance.now() - t0;
        detect.paintMs.push(paintMs);
        if (detect.paintMs.length > 200) detect.paintMs.shift();
      }));

      dbg(`命中本機快取（JS ${jsMs.toFixed(1)}ms）：${hit.slice(0, 40)}`);
      return;
    }

    state.misses++;
    zhLagWait(k);                     // 英文已經在畫面上，開始算中文落後多久
    dbg(`未命中，排入佇列：${text.slice(0, 60)}`);
    // 走到這裡代表預抓還沒涵蓋到這句。
    // 不顯示「翻譯中…」之類的佔位字——那會一直在畫面上閃、非常分心。
    // 就讓畫面保持空白，譯文回來時若這句還在螢幕上就補顯示。

    if (requested.has(k)) return;  // 已經送出去了，等回應就好
    // ⚠️ **這一句現在就在螢幕上，是急件。**
    //
    //    `urgentKeys` 原本設計成「畫面上正在顯示的句子不參與直播並發去重」，
    //    但**從來沒有任何地方 add 進去**——於是 isUrgent 永遠是 false，
    //    每一批都被當成非急件，直播時全部讓給其他觀眾去翻。
    //
    //    單人測試看不出來（沒有人可以讓），兩個人同時看就會
    //    互相讓來讓去：實測回覆率只有 16~34%，字幕斷斷續續。
    //    讓路的那些要等 3 秒後重讀共用快取，而直播每 3~4 秒就換一句——
    //    等回來時那句早就過去了。
    urgentKeys.add(k);
    pending.set(k, text);
    scheduleFlush();
  }

  /**
   * 收割期間不要讓計時器把批次切碎（userscript 坑 #10）。
   *
   * 整軌預抓時 383 個分段會在一分多鐘內陸續到齊，每段只帶 2~3 句新的。
   * 300ms 的 flush 計時器一到就把那零星幾句送出去，於是批次平均只有 4.8 句——
   * userscript 同樣的片子是 14.9 句。批次小三倍，API 呼叫就多三倍。
   *
   * 收割期間改成「湊滿 BATCH_MAX 才送」，收割結束時再把剩下的一次倒出去。
   * 這不影響即時性：收割中的句子本來就是未來 40 分鐘才會用到的。
   */
  /** 寫入本機快取並維持上限。切換影片時 memo 刻意不清（重複用語可互相受惠） */
  /**
   * 寫進 memo。**所有譯文都經過這裡**，所以合理性檢查放這裡就漏不掉：
   * 逐句翻譯的回應、共用快取的 bundle、整軌預抓的結果，三條路都會呼叫它。
   *
   * ⚠️ **後端已經擋過一次，這裡仍然要擋。**
   *    (1) memo 裡可能還留著上一版放行的壞句子；
   *    (2) 共用快取裡有「守門收緊之前」寫進去的舊資料；
   *    (3) 後端哪天改壞了，這裡是使用者與模型內心話之間最後一層。
   *    誤判的代價只是那一句沒有中文，英文原字幕仍然在畫面上。
   */
  function remember(k, zh) {
    if (self.PL.plausible && !self.PL.plausible(k, zh)) {
      state.blocked = (state.blocked || 0) + 1;
      dbg('⛔ 擋下不合理的譯文：' + String(zh).slice(0, 60));
      return;
    }
    memo.set(k, zh);
    if (memo.size <= MEMO_MAX) return;
    // 淘汰最舊的，但**跳過這支影片還會用到的鍵**。
    // 不跳過的話，連看幾支長影片之後會把正在看的這支的譯文淘汰掉，
    // 畫面上突然開始重翻已經翻過的句子——不報錯，只是變慢又變貴。
    for (const key of memo.keys()) {
      if (memo.size <= MEMO_MAX) break;
      if (sessionKeys.has(key)) continue;
      memo.delete(key);
    }
  }

  function scheduleFlush() {
    const urgentPending = [...pending.keys()].some((k) => urgentKeys.has(k));
    if (pendingTimer) {
      // 長的等待中進來一句「畫面上現在就要」的：插隊，不可以讓它等 10 秒
      if (!(pendingLong && urgentPending)) return;
      clearTimeout(pendingTimer); pendingTimer = null;
    }
    if (harvestInFlight && pending.size < BATCH_MAX) return;   // 等湊滿
    // ⚠️ **直播要加抖動。** 直播時所有觀眾在同一秒看到同一批新分段，
    //    不加抖動的話大家會在同一個毫秒送出同一批句子，伺服器端的認領
    //    機制只能擋掉一部分（認領本身也需要時間）。
    //    0~1.2 秒的隨機延遲把尖峰攤平，代價是直播字幕最多晚 1.2 秒——
    //    而 worker 的提前量有 50 秒，這點延遲完全吸收得掉。
    const jitter = state.isLive ? Math.floor(Math.random() * 1200) : 0;
    let wait = PENDING_FLUSH_MS + jitter;
    pendingLong = false;
    if (state.isLive && !urgentPending && pending.size < BATCH_MAX) {
      // 前導收割端：沒有人等它，湊大批次（每句成本降到約一半，模型有上下文）
      if (leaderMode) { wait = leaderWinMs; pendingLong = true; }
      // 延遲中的觀眾：提前量約 70 秒，多等 10 秒湊批次（前導收割端在的話，送出去時多半已經在 DO 裡）
      // ⚠️ 只在**真的已經落後**的時候才等（延遲沒做成——沒有 video、DVR 不夠深、被停用——就照原本的節奏）
      else if (liveDelayInEffect()) { wait = (leaderSeen ? LIVE_DELAY_LEADER_HOLD_MS : LIVE_DELAY_HOLD_MS) + jitter; pendingLong = true; }
    }
    pendingTimer = setTimeout(flushPending, wait);
  }

  /** 收割結束時把佇列倒乾淨——不然最後不滿一批的句子會卡住 */
  function drainAfterHarvest() {
    if (!pending.size) return;
    dbg(`收割結束，倒出剩餘 ${pending.size} 句`);
    clearTimeout(pendingTimer); pendingTimer = null;
    flushPending();
  }

  /**
   * 還沒解析出 cid 時，先把句子留在佇列裡。
   *
   * ⚠️ **沒有 cid 的請求會被丟進 `misc` 這個所有影片共用的桶子。**
   *    後果是：這支影片的共用快取拿不到那些句子，下一個觀看者要重付一次；
   *    而同一場如果有另一台裝置解析得到 cid，同一句話就會**被翻兩次、付兩次錢**。
   *    實測過，重疊率 98.1%。
   *
   * ⚠️ 但**不能無限期等**——等不到就完全沒有字幕，那比多付錢嚴重得多。
   *    所以只等 CID_WAIT_MS，之後照樣送出（用 misc），但會記一筆警告與代碼，
   *    讓它從「安靜地多花錢」變成診斷報告上看得到的一行。
   */
  const CID_WAIT_MS = 15000;
  let noCidSince = 0;

  async function flushPending() {
    pendingTimer = null;
    pendingLong = false;
    if (!pending.size) return;

    if (!contentId) {
      if (!noCidSince) noCidSince = Date.now();
      /* @admin-only:start */
      // 前導端沒有影片編號就**一律不送**（2026-10-25，R18 排位）：送了會進 misc——不共用給觀眾、
      // 不寫進共用快取，觀眾也看不到心跳而各自重翻，等於整場付兩次錢（實測 797 次呼叫、2,325 句）。
      // 句子留在佇列，持續重抓編號；直播中 2 分鐘還拿不到就重新整理分頁（每個分頁最多 2 次，鐵則 3）。
      if (leaderMode) {
        state.heldNoCid = (state.heldNoCid || 0) + pending.size;
        if (!state.noCidWarned) { state.noCidWarned = true; evErr('🎯 前導端拿不到影片編號：先不翻譯（避免進 misc、觀眾重翻）'); }
        if (state.isLive && Date.now() - noCidSince > LEADER_NOCID_RELOAD_MS) leaderNoCidReload();
        scheduleFlush();
        return;
      }
      /* @admin-only:end */
      // 沒有影片編號、頁面上也沒有 <video>＝沒有在播任何東西，不送也不留（2026-11-03）。
      // R19 正賽：在觀眾的 Chrome 開賽事頁（/page/12332/…，沒有 video）找連結，15 秒後照樣送出，
      // 281 句進了 misc、算在那位觀眾的授權上。有 video 但拿不到編號（從活動頁進去看）照舊等 15 秒再送。
      if (!document.querySelector('video')) {
        state.droppedNoVideo = (state.droppedNoVideo || 0) + pending.size;
        pending.clear();
        noCidSince = 0;
        return;
      }
      if (Date.now() - noCidSince < CID_WAIT_MS) {
        state.heldNoCid = (state.heldNoCid || 0) + pending.size;
        scheduleFlush();                     // 等一下再試，句子留在佇列裡
        return;
      }
      if (!state.noCidWarned) {
        state.noCidWarned = true;
        plErr('PL-C08', '譯文會寫進公用快取，這支影片的下一位觀看者要重新付費');
      }
    } else {
      noCidSince = 0;
    }
    // 最後一道。佇列可能是額度用完**之前**排進來的，送出去仍然要花錢。
    // 三道防線（ingestVtt／handleCaption／這裡）刻意重複——
    // 每一條進入佇列的路都要各自擋，只擋入口會漏掉未來新增的路徑。
    if (trialExhausted()) { pending.clear(); return; }
    if (inflight >= MAX_INFLIGHT) { scheduleFlush(); return; }

    const keys = Array.from(pending.keys()).slice(0, BATCH_MAX);
    const batch = keys.map((k) => pending.get(k));
    keys.forEach((k) => { pending.delete(k); requested.add(k); });

    inflight++;
    const t0 = Date.now();
    dbg(`送出批次 ${batch.length} 句（佇列剩 ${pending.size}，飛行中 ${inflight}/${MAX_INFLIGHT}）`);
    batch.forEach((t, i) => dbg(`  ${i + 1}. ${t.slice(0, 70)}`));
    try {
      // 整批只要有一句是急件就整批算急件。分開送會讓批次變小、呼叫次數變多，
      // 而批次大小直接決定成本（實測 14.3 句/批 vs 4.8 句/批＝三倍的呼叫）。
      // ⚠️ **直播一律算急件。**
      //    並發去重的前提是「讓路的人有時間等別人翻完再讀快取」，
      //    而那個前提來自重播的整軌預抓（提前量約 47 秒）。
      //    直播沒有提前量——字幕是隨畫面產生的，讓路等於放棄那一句。
      const isUrgent = state.isLive || keys.some((k) => urgentKeys.has(k));
      keys.forEach((k) => urgentKeys.delete(k));
      // slug 要一起送。**伺服器要靠它判斷這支影片算不算免費場次**——
      // 那條規則以前只存在於這裡，改一下用戶端就繞得過去。
      const res = await send({
        type: 'translate', cid: contentId, lines: batch,
        urgent: isUrgent, slug: location.pathname,
        live: !!state.isLive, leader: leaderMode,
      });
      if (res.ok && res.result && typeof res.result.leader === 'boolean') leaderSeen = res.result.leader;
      const lines = (res.ok && res.result && res.result.lines) || {};
      let n = 0;
      for (const [k, zh] of Object.entries(lines)) { remember(k, zh); n++; }
      state.translated += n;
      const ms = Date.now() - t0;
      batchStats.push({ sent: batch.length, got: n, ms });
      if (batchStats.length > 100) batchStats.shift();
      dbg(`批次回應：送 ${batch.length} / 回 ${n} 句，耗時 ${ms}ms`
        + (n < batch.length ? `　⚠ 少了 ${batch.length - n} 句` : ''));
      for (const [k, zh] of Object.entries(lines)) dbg(`  → ${zh.slice(0, 40)}`);
      // 直播時別人正在翻同一批句子（伺服器端的認領機制）。
      // **不是錯誤**，把這些句子排回佇列，過幾秒再讀一次就會從共用快取拿到。
      // 沒有這段的話，讓路的那些句子會被 `requested` 標記成「已送出」而永遠不再要，
      // 於是直播時只有第一個到的人看得到字幕——安靜地壞掉。
      const elsewhere = res.ok && res.result && res.result.pendingElsewhere;
      if (elsewhere) {
        const back = keys.filter((k) => !lines[k]);
        back.forEach((k) => { requested.delete(k); });
        dbg(`${back.length} 句由其他觀眾翻譯中，稍後從共用快取取得`);
        setTimeout(() => {
          // 排回去之前先確認還沒被別人補上，避免無意義的重送
          back.forEach((k) => { if (!memo.has(k) && batch.length) pending.set(k, batch[keys.indexOf(k)] || ''); });
          for (const [k, v] of pending) if (!v) pending.delete(k);
          if (pending.size) scheduleFlush();
        }, Number(res.result.retryAfterMs) || 3000);
      }
      if (res.ok && res.result && res.result.error) {
        state.errors++;
        const be = String(res.result.code || '');
        // 免費層的兩種情形**不是故障**，用專屬代碼標成「預期內」，
        // 不要跟真正的錯誤混在一起（見 plErr 的說明）。
        const code = res.result.reason === 'not_free_session' ? 'PL-C06'
          : /^E3[02]$/.test(be) ? 'PL-C07' : 'PL-C02';
        // logEvent 只吃一個參數，第二個會被靜默丟掉——一律用字串串接。
        plErr(code, String(res.result.error || '(無訊息)') + (be ? '（伺服器 ' + be + '）' : ''));
      }
      // 譯文可能正好對應畫面上「此刻仍在顯示」的那一句，補上去。
      //
      // 一定要當場重讀 DOM 比對，不能只信 currentEn：
      // 那個變數只反映「最後一次看到的字幕」，翻譯慢回來時畫面早就換過了，
      // 直接拿它補顯示會把過時的句子重新彈出來——實測表現為
      // 「同一段字幕在不同時間斷斷續續重複出現」。
      const nowEn = clean(collectCaption());
      if (nowEn && nowEn === currentEn) {
        const nk = normKey(nowEn);
        const zh = memo.get(nk);
        if (zh) { render(zh, nowEn); zhLagDone(nk); }
      }
      // 譯文回來時那句已經不在畫面上了＝這一句使用者根本沒看到中文。
      // **一定要單獨記**：把它當成「落後很久」會汙染中位數，當成沒發生則是說謊。
      for (const k2 of keys) {
        if (!zhLag.waiting.has(k2)) continue;
        if (normKey(nowEn || '') === k2) continue;
        zhLag.waiting.delete(k2);
        zhLag.never++;
        // 沒跟上的也算「看過的一句」，否則 never 的分母會少掉它自己
        zhLag.seen++;
      }
    } catch (e) {
      state.errors++;
      plErr('PL-C01', String(e.message || e));
      requeue(keys, batch, e.message);
    } finally {
      keys.forEach((k) => requested.delete(k));
      inflight--;
      if (pending.size) scheduleFlush();
    }
  }

  /**
   * 失敗的句子要放回佇列重試。
   *
   * 原本是直接丟掉：`requested.delete(k)` 之後那 20 句就永遠消失了，
   * 不重試、不記錄，只有 `state.errors++`。一次 429（後端每 IP 每分鐘 120 次，
   * 同一個家用 IP 兩人同時收割就會逼近）或一次網路抖動 = 20 句永久遺失，
   * 而且**共用快取會缺這 20 句，下一個人得重新付費**。
   *
   * 每句最多重試 3 次。超過就放棄——那通常代表後端有系統性問題，
   * 無上限重試只會把 429 變得更嚴重（鐵則 #3）。
   */
  const retryCount = new Map();      // normKey -> 已重試次數
  function requeue(keys, batch, reason) {
    let back = 0, gaveUp = 0;
    keys.forEach((k, i) => {
      const n = (retryCount.get(k) || 0) + 1;
      if (n > 3) { retryCount.delete(k); gaveUp++; return; }
      retryCount.set(k, n);
      if (!memo.has(k)) { pending.set(k, batch[i]); back++; }
    });
    state.dropped += gaveUp;
    evWarn(`批次失敗（${reason}）：${back} 句已排回重試`
      + (gaveUp ? `，${gaveUp} 句重試 3 次仍失敗已放棄` : ''));
  }

  // =========================================================================
  // 疊字層
  // =========================================================================
  const box = document.createElement('div');
  box.id = 'pitlingo-box';
  const zhEl = document.createElement('div'); zhEl.id = 'pitlingo-zh';
  const enEl = document.createElement('div'); enEl.id = 'pitlingo-en';
  box.appendChild(zhEl);
  box.appendChild(enEl);

  let hideTimer = null;
  let hideStyleEl = null;

  // ⚠️ **這是「隱藏原生字幕」唯一的判斷，而且要是冪等的**——結構性檢查每 1.5 秒呼叫一次。
  //    以前免費額度用完時只在 showTrialEnded 把樣式拿掉一次，之後任何一個
  //    呼叫 applyHideNative 的地方（改設定、遠端設定更新）都會把原生字幕**又藏起來**，
  //    而我們已經不畫中文——畫面上一個字都沒有。版本過舊（tooOld）也是同一個洞。
  function applyHideNative() {
    const want = settings.enabled && !killed && !tooOld && settings.hideNativeCC && site && site.hideCss
      && !trialExhausted();
    if (want && !hideStyleEl) {
      hideStyleEl = document.createElement('style');
      // 用 opacity 而非 visibility：visibility:hidden 會讓文字讀不到（坑 #1），
      // 而且我們還要靠這個容器的矩形來定位疊字，必須保留版面。
      hideStyleEl.textContent = site.hideCss;
      (document.head || document.documentElement).appendChild(hideStyleEl);
    } else if (!want && hideStyleEl) {
      hideStyleEl.remove(); hideStyleEl = null;
    }
  }

  /** 全螢幕時疊字層必須搬進 fullscreen element，否則整個看不到 */
  function mount() {
    const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (host && box.parentElement !== host) host.appendChild(box);
  }

  function mainVideoRect() {
    let best = null;
    document.querySelectorAll('video').forEach((v) => {
      const r = v.getBoundingClientRect();
      if (r.width < 100 || r.height < 60) return;
      if (!best || r.width * r.height > best.width * best.height) best = r;
    });
    return best;
  }

  function reposition() {
    const vr = mainVideoRect();
    // 優先貼齊原生字幕容器：我們用 opacity 隱藏它，版面仍在，
    // 所以它的矩形就是 F1TV 原本要放字幕的精確位置（多視角也會落在正確那一格）
    let r = null, tight = false;
    const c = activeContainer();
    if (c) {
      const cr = c.getBoundingClientRect();
      if (cr.width > 40 && cr.height > 8) { r = cr; tight = true; }
    }
    if (!r) r = vr;
    if (!r) return;

    box.style.left = (r.left + r.width / 2) + 'px';
    box.style.bottom = tight
      ? (window.innerHeight - r.bottom) + 'px'
      : (window.innerHeight - r.bottom + r.height * settings.bottomPct / 100) + 'px';
    box.style.maxWidth = (r.width * 0.95) + 'px';

    // 字級依主畫面寬度縮放，避免字幕容器寬度變動導致字體忽大忽小
    const scale = Math.max(0.5, (vr ? vr.width : r.width) / 1280);
    zhEl.style.fontSize = Math.round(settings.fontSize * scale) + 'px';
    enEl.style.fontSize = Math.round(settings.fontSize * 0.62 * scale) + 'px';
    enEl.style.display = settings.showEnglish ? 'inline-block' : 'none';
    applyLook();
  }

  // 字幕外觀（顏色／背景／外框）。reposition 每 250ms 會跑，只在設定真的變了才寫樣式
  let lookKey = '';
  function applyLook() {
    const k = [settings.textColor, settings.bgColor, settings.bgOpacity, settings.outline].join('|');
    if (k === lookKey) return;
    lookKey = k;
    const v = self.PL.subtitleLook(settings);
    for (const p in v) box.style.setProperty(p, v[p]);
  }

  /**
   * 原生字幕消失時，跟著把疊字收掉。
   *
   * 這是「感覺比 userscript 慢一拍」的真正成因。原本只靠 `holdMs` 計時器：
   *   holdMs 太短 → F1TV 的字幕還在，我們的中文先消失，空白一段才換下一句
   *   holdMs 太長 → 講完很久了，我們還掛著上一句，跟聲音對不起來
   * 兩種都讀起來像「延遲」，而且**調參數永遠只能二選一**。
   *
   * 正解是跟著來源走：我們每 100ms 就知道原生字幕清空了，那一刻收掉即可。
   * `holdMs` 從此退化成純安全網（輪詢真的停擺時才輪到它）。
   *
   * 350ms 寬限是因為換句之間 F1TV 會有極短的空窗，立刻收掉會閃爍。
   */
  const CLEAR_GRACE_MS = 350;

  /**
   * 字幕停留上限。**固定值，不開放調整。**
   *
   * 它曾經是設定頁上的滑桿，但那是個會誤導人的旋鈕：自從「跟著原生字幕一起收掉」
   * 之後，正常播放時這個計時器**永遠不會被觸發**——調它不會有任何可見效果。
   * 使用者覺得字幕不同步時會去拉它，拉完沒變，於是以為整個功能壞了。
   *
   * 真正會用到它的只有一種情況：輪詢停擺（分頁被瀏覽器節流），那時原生字幕
   * 清空的事件我們收不到，只剩這個計時器把疊字收掉。既然是安全網，
   * 就該由我們決定長度，7 秒足以涵蓋任何一句正常的轉播字幕。
   */
  const HOLD_MS = 7000;

  let clearTimer = null;
  function scheduleHide() {
    clearTimeout(clearTimer);
    // 提前顯示期間原生字幕本來就還沒出現，這時的「清空」不是真的結束。
    // 沒有這個保護，提前顯示的句子會在 350ms 後被自己的輪詢收掉——
    // 表現出來是「開了提前之後字幕一閃就不見」。
    // ⚠️ 一定要先確認是有限數。`Math.max(350, Math.min(NaN, 7000))` 會得到 NaN，
    //    而 `setTimeout(fn, NaN)` 被當成 0 —— 疊字會在下一個 tick 立刻消失。
    //    那是「調一調就壞掉」裡最難查的一種：沒有錯誤訊息，只是字幕一閃而過。
    const remain = earlyHoldUntil - Date.now();
    const wait = Number.isFinite(remain)
      ? Math.max(CLEAR_GRACE_MS, Math.min(remain, HOLD_MS))
      : CLEAR_GRACE_MS;
    clearTimer = setTimeout(() => {
      box.classList.remove('on');
      dbg('原生字幕已清空，收起疊字');
    }, wait);
  }

  function show(zhText, enText, isPending) {
    if (!settings.enabled || killed || tooOld) return;
    clearTimeout(clearTimer);          // 新句子來了，取消待執行的收起
    mount(); reposition();
    zhEl.textContent = zhText;
    zhEl.classList.toggle('pending', !!isPending);
    enEl.textContent = enText || '';
    box.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => box.classList.remove('on'), HOLD_MS);
  }

  function render(zh, en) { show(zh, en, false); }

  // =========================================================================
  // 預抓 —— 決定「跟不跟得上」與「要花多少錢」
  //
  // 兩個層次，不要混為一談：
  //
  // 【提前量】只讀 DOM 的話是 0：字幕出現在畫面上我們才知道有這句，翻譯來回
  //   1~3 秒，而轉播每 3~4 秒一句，永遠追不上。但播放器本來就會**提前約 50 秒**
  //   下載字幕分段——inject.js 在 worker 內攔到那些分段，提前量就回來了。
  //   這一層在 v0.3.0 就完成了。
  //
  // 【整軌覆蓋】worker 只給得到「播放器已經下載的」部分。所以第一個看的人仍要
  //   為整支影片付翻譯費，而且拖動進度條會跳到還沒攔到的區段。整軌預抓則是
  //   一次把整支翻完：之後零呼叫、100% 命中，並且把譯文灌滿共用快取。
  //   這一層是 v0.4.0 補上的。
  //
  //   攔到的 manifest → 字幕清單 → 全部 VTT 分段 → 批次翻譯 → 存進共用快取
  //
  // 入口不是 PLAY API（八個版本都不通，見 handoff 7.7），而是 worker 本來就會
  // 抓的 m3u8。搭便車，零額外請求——F1TV 有 Imperva 機器人防護，這點很重要。
  //
  // 重播：一次抓完整支。直播：滑動視窗，定期重抓補新分段。
  // =========================================================================
  // ⚠️ **收割必須讓路給影片。** 這是使用者實測回報的問題：
  //    開著擴充功能時影片一直卡頓、自動降解析度，關掉就正常。
  //
  //    成因很直接——整軌預抓要抓 1,020 個 VTT 分段，而那些分段跟影片來自
  //    **同一個 CDN 主機**。HTTP/2 之下它們共用同一條連線，我們每秒打十幾個
  //    請求就是在跟影片分段搶頻寬與 stream 優先權。播放器的 ABR 演算法量到
  //    吞吐量下降，就會做它該做的事：**降解析度**。
  //    我們拿到的字幕是 40 分鐘後才要用的，影片是現在就要看的——
  //    優先權完全相反。
  //
  //    三道退讓，缺一不可：
  //      1. `priority: 'low'`（在 sw.js）——直接告訴瀏覽器這些請求排後面
  //      2. 並發從 3 降到 1、間隔拉長
  //      3. 播放器缺資料時**主動暫停收割**（見 `playbackHealthy`）
  // 節奏調整（v0.18.1）：上一版為了修卡頓把並發壓到 1、間隔 120ms，
  // 1,203 段最快也要四分半。現在退讓機制已經是**自適應**的
  // （priority:'low' + 依緩衝存量減速 + 真卡住才暫停），
  // 可以把健康時的節奏放回來，卡頓時仍然會自動退到 800ms 單線。
  const FETCH_CONCURRENCY = 2;
  const FETCH_GAP_MS = 40;
  const LIVE_REFRESH_MS = 20000;

  // ⚠️ **退讓要「減速」不能「停住」。** 上一版寫成硬性閘門：緩衝低於 8 秒就
  //    整個停下來等，最多等 30 秒。實測診斷（v0.17.0）打臉：
  //      分段：清單 1203 / 已抓 4　　讓路給影片：2 次，共 30.2 秒
  //    57 秒的觀看裡有 30 秒在等，只抓到 4 段——照這個速度 1,203 段要四小時，
  //    等於**整軌預抓實質上不會完成**。收割不完就沒有人把譯文灌滿共用快取，
  //    下一位觀眾要從頭付費翻譯，成本反而比卡頓那版更糟。
  //
  //    修一個問題製造另一個問題，是因為我把「讓路」做成二元的。
  //    改成三段，任何時候都還在前進：
  //      健康        正常速度
  //      緩衝偏低    放慢到 SLOW（不停）
  //      真的在等資料（readyState < 3）  才短暫暫停，且上限只有 5 秒
  const YIELD_BUFFER_SEC = 8;        // 低於這個秒數就放慢
  const FETCH_GAP_SLOW_MS = 800;     // 放慢時的間隔
  const YIELD_POLL_MS = 250;
  const YIELD_MAX_MS = 5000;         // 真的卡住時最多暫停這麼久
  /* @admin-only:start */
  // 管理版的收割佇列接手這一頁時（沒有人在看，影片只是用來拿到字幕清單）改用
  // userscript 收割的節奏：6 條並行、每段 60ms、不讓路給影片。
  // 沿用觀眾版的退讓，實測正賽 2,416 段在 15 分鐘只抓到 600 段（2026-10-12）。
  // ⚠️ 只有佇列明確接手才切換——管理版平常拿來看比賽時仍然是觀眾版的節奏。
  const HARVEST_FETCH_CONCURRENCY = 6;
  const HARVEST_FETCH_GAP_MS = 60;
  let harvestFast = false;
  let fetchBoost = null;             // 正在跑的那一輪 fetchSegments 的「加開 worker」
  /* @admin-only:end */

  let harvestGen = 0;
  let harvestInFlight = false;
  let subtitlePlaylistUrl = null;
  let prefetchHow = '';               // 字幕清單是怎麼拿到的，診斷用
  let bundleSegCount = 0;             // 後端記錄「這支收割過幾段」，0 = 沒人收割完整過
  const seenSegments = new Set();     // 已抓過的分段網址，直播重抓時用來去重
  const prefetchSeen = new Set();     // 已排入翻譯的 normKey
  let liveTimer = null;

  // worker 攔到的 m3u8／MPD。整軌預抓的入口——播放器自己會抓這些，
  // 我們只是搭便車，不產生任何額外的網路請求（Imperva 之下這點很重要）。
  // 上限 12 份：換畫質、換影片都會產生新的，只保留最近的即可。
  const MANIFEST_MAX = 12;
  const MANIFEST_MAX_BYTES = 8e6;   // 總量上限。份數上限擋不住「每份都很大」
  let manifests = [];

  async function swFetchText(url) {
    const res = await send({ type: 'fetchText', url });
    if (!res.ok) throw new Error(res.error || 'fetch 失敗');
    return res.text;
  }

  /** 從 master m3u8 找出英文字幕軌的播放清單位址 */
  function findSubtitlePlaylist(masterBody, masterUrl) {
    const re = /#EXT-X-MEDIA:([^\n]*TYPE=SUBTITLES[^\n]*)/gi;
    let m, best = null;
    while ((m = re.exec(masterBody))) {
      const attrs = m[1];
      const uri = (attrs.match(/URI="([^"]+)"/i) || [])[1];
      if (!uri) continue;
      const lang = (attrs.match(/LANGUAGE="([^"]+)"/i) || [])[1] || '';
      if (!best) best = { uri, lang };
      if (/^en/i.test(lang)) { best = { uri, lang }; break; }
    }
    if (!best) return null;
    try { return { url: new URL(best.uri, masterUrl).href, lang: best.lang }; }
    catch (e) { return null; }
  }

  /**
   * 從 worker 攔到的 manifest 找出字幕清單。這是整軌預抓的入口。
   *
   * 兩條路徑，順序有意義：
   *   1. 直接攔到字幕的 media playlist —— 最穩。網址原封不動、body 已經在手上，
   *      連 fetch 都不用，也沒有相對路徑解析出錯的風險。
   *   2. 從 master 的 #EXT-X-MEDIA:TYPE=SUBTITLES 解析 —— 備援。
   *
   * 兩條都由 userscript 實測驗證過（見 userscript 的 findSubtitlePlaylist）。
   * 由新到舊掃，因為換畫質／換影片會留下舊的 manifest。
   */
  function findSubtitlePlaylistFromObserved() {
    for (let i = manifests.length - 1; i >= 0; i--) {
      const m = manifests[i];
      if (!m.body) continue;
      if (/#EXTINF/i.test(m.body) && /\.vtt|\.webvtt/i.test(m.body)) {
        return { url: m.url, body: m.body, lang: 'eng', how: '直接攔到字幕清單' };
      }
    }
    for (let i = manifests.length - 1; i >= 0; i--) {
      const m = manifests[i];
      if (!m.body || !/#EXT-X-STREAM-INF/i.test(m.body)) continue;
      const sp = findSubtitlePlaylist(m.body, m.url);
      if (sp) return { url: sp.url, body: null, lang: sp.lang, how: '由 master 解析' };
    }
    return null;
  }

  /**
   * 這支影片到底**有沒有**官方字幕軌。
   *
   * ⚠️ **三態，不是布林。** 最重要的是分出「確定沒有」與「還不知道」：
   *
   *   has     —— 攔到字幕清單，或 master 裡有 TYPE=SUBTITLES
   *   none    —— **看過 master 了**，而裡面完全沒有字幕軌 → 這支真的沒有
   *   unknown —— 連 master 都還沒攔到（注入失敗？還在載？）→ **什麼都不要說**
   *
   * 把 unknown 當成 none 會造成最糟的誤報：注入失效時對每一支影片都說
   * 「這支沒有字幕」，使用者會以為我們的涵蓋範圍很差而退訂——
   * 而真正的問題（注入壞了）反而被這句話蓋掉。
   *
   * 也刻意**不看使用者有沒有開 CC**：CC 關著但字幕軌存在時，
   * 判定仍然是 has，那種情況要由 checkNoCaption 去提醒開 CC。
   */
  function subtitleTrackVerdict() {
    let sawMaster = false;
    for (const m of manifests) {
      if (!m.body) continue;
      if (/#EXTINF/i.test(m.body) && /\.vtt|\.webvtt/i.test(m.body)) return 'has';
      if (/#EXT-X-STREAM-INF/i.test(m.body)) {
        sawMaster = true;
        if (/TYPE=SUBTITLES/i.test(m.body)) return 'has';
      }
    }
    return sawMaster ? 'none' : 'unknown';
  }

  /**
   * 「這支影片沒有官方字幕」的告知。
   *
   * ⚠️ **這不是錯誤，所以沒有錯誤代碼。** 影片本來就沒字幕是 F1TV 的內容問題，
   *    不是我們的故障。發代碼等於訓練使用者把正常現象當故障回報，
   *    真正的故障就會淹沒在雜訊裡（見 plErr 的說明）。
   *
   * 但**一定要說**：買家付了錢，點開一支空白的影片而畫面上沒有任何說明時，
   * 他分不出「我們壞了」與「這支本來就沒有」。那筆客訴是自找的。
   */
  let noSubShown = false;
  function checkNoSubtitleTrack() {
    if (noSubShown || !settings.enabled || !site || killed || tooOld) return;
    if (!isActuallyPlaying()) return;
    // 給播放器時間把 master 載進來。太早判定會把「還在載」說成「沒有」。
    if (Date.now() - injectSince < 45000) return;
    if (subtitleTrackVerdict() !== 'none') return;

    noSubShown = true;
    evInfo('這支影片沒有官方英文字幕軌 —— 沒有可以翻譯的來源（不是故障）');
    show('ℹ 這支影片沒有官方英文字幕，PitLingo 無法翻譯', '');
    // 回報給後端統計。**知道比例才有辦法決定要不要自己做語音辨識。**
    try {
      send({ type: 'markComplete', cid: contentId, segCount: 0, slug: location.pathname, noSubtitles: true });
    } catch (e) { /* 統計失敗不影響任何功能 */ }
  }

  /**
   * 等 worker 攔到字幕清單。
   *
   * 不自己去猜網址、也不打 PLAY API——那條路試過八個版本都不通，而且 F1TV 有
   * Imperva 機器人防護，送出注定失敗的請求只是在累積風險。
   * 播放器自己一定會抓，我們等它就好。
   */
  function waitForSubtitlePlaylist(myGen) {
    return new Promise((resolve) => {
      let tries = 0;
      const tick = () => {
        if (myGen !== harvestGen) return resolve(null);
        const sp = findSubtitlePlaylistFromObserved();
        if (sp) return resolve(sp);
        // 同一支影片第二次預抓（🎯 重收）：清單的 body 第一次用完就放掉了，沿用已知的位址。
        // subtitlePlaylistUrl 在換影片時清空，不會拿到上一支的
        if (subtitlePlaylistUrl) return resolve({ url: subtitlePlaylistUrl, body: null, how: '沿用這支已知的字幕清單' });
        if (++tries >= 45) return resolve(null);      // 最多等 45 秒
        setTimeout(tick, 1000);
      };
      tick();
    });
  }

  /* @admin-only:start */
  /**
   * 一句 cue 在整支影片裡的秒數（後台翻譯清單的時間軸）。
   * F1TV 的分段 VTT 寫的是絕對時間還是分段內相對時間沒有實測過（見上面 OFFSET 的說明），所以兩種都認：
   *   落在這個分段的範圍內 → 絕對時間，直接用；落在 0～分段長度 → 相對時間，加上分段起點；
   *   都不是（例如帶 X-TIMESTAMP-MAP 的固定偏移）→ 退回分段起點（誤差最多一個分段，約幾秒）。
   */
  function cueVideoSec(start, seg) {
    const slack = 1;
    if (start >= seg.at - slack && start <= seg.at + seg.dur + slack) return start;
    if (start >= -0.5 && start <= seg.dur + slack) return seg.at + Math.max(0, start);
    return seg.at;
  }
  /* @admin-only:end */

  function parseMediaPlaylist(body, baseUrl) {
    const segs = [];
    let dur = 0;
    body.replace(/\r/g, '').split('\n').forEach((raw) => {
      const t = raw.trim();
      if (!t) return;
      if (/^#EXTINF:/i.test(t)) { dur = parseFloat(t.slice(8)) || 0; return; }
      if (t[0] === '#') return;
      try { segs.push({ url: new URL(t, baseUrl).href, dur }); } catch (e) { /* noop */ }
      dur = 0;
    });
    return { segs, isVod: /#EXT-X-ENDLIST/i.test(body) };
  }

  /** `00:01:23.456` → 秒。分秒可省略小時。 */
  function hmsToSec(t) {
    const m = String(t).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
    if (!m) return null;
    return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]) + Number(m[4]) / 1000;
  }

  /**
   * 極簡 WebVTT 解析。回傳 `{ text, start }`。
   *
   * `start` 是 cue 在**這個分段檔案內**的秒數，不是影片的絕對時間——
   * HLS 分段 VTT 要靠 X-TIMESTAMP-MAP 才能換算成絕對時間，而那條路很脆弱
   * （決策 4.1 明確避開）。我們不換算，改用自我校準推出基準，
   * 見 `noteCalibration`。
   */
  function parseVtt(raw) {
    const out = [];
    if (!raw || raw.indexOf('-->') === -1) return out;
    // ⚠️ **結束時間也要解析。** 原本只取起始時間，那對「提前顯示」夠用，
    //    但「補上官方漏掉的字幕」必須知道一句該在畫面上停多久——
    //    沒有結束時間，補上去的字不是一閃就收，就是賴在畫面上七秒。
    let cur = null, start = null, end = null;
    String(raw).replace(/\r\n?/g, '\n').split('\n').forEach((ln) => {
      if (ln.indexOf('-->') !== -1) {
        if (cur && cur.length) out.push({ text: cur.join(' '), start, end });
        cur = [];
        const parts = ln.split('-->');
        start = hmsToSec(parts[0]);
        // 結束欄位後面可能接 cue 設定（`00:01.000 line:90%`），只取第一段
        end = hmsToSec(String(parts[1] || '').trim().split(/\s+/)[0]);
        return;
      }
      if (cur === null) return;
      if (ln.trim() === '') { if (cur.length) { out.push({ text: cur.join(' '), start, end }); cur = null; } return; }
      cur.push(ln.trim());
    });
    if (cur && cur.length) out.push({ text: cur.join(' '), start, end });
    return out;
  }

  /**
   * 接收 MAIN world 轉送過來的 VTT。
   *
   * 這是擴充功能取得「提前量」的唯一來源：播放器會提前約 50 秒下載字幕分段，
   * inject.js 在 worker 內攔到之後用 BroadcastChannel 送到 MAIN world，
   * MAIN world 再用 window.postMessage 轉給這裡（只有這裡有 chrome.* API）。
   */
  /**
   * 重讀遠端設定並就地套用。
   *
   * 這是「F1TV 改版時能在幾分鐘內救回所有使用者」的最後一哩：
   * 後端推了新選擇器之後，這裡會在下一次輪詢時換上去，
   * 使用者不用重新整理，影片也不用中斷。
   */
  const CONFIG_RECHECK_MS = 60000;
  let configVersion = -1;
  let killed = false;              // 遠端總開關
  let freeTierCfg = null;          // 免費層設定（在遠端設定的**根層**，不在 sites 底下）
  let tooOld = false;              // 版本低於伺服器要求的下限

  /** 語意化版本比較。回傳 -1 / 0 / 1。 */
  function cmpVer(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  async function applyRemoteConfig(force) {
    const res = await send({ type: force ? 'refreshConfig' : 'getConfig' });
    const config = (res.ok && res.config) || null;
    if (!config) return false;
    const next = siteConfigFor(config, location.hostname);
    if (!next) return false;

    const changed = config.version !== configVersion
      || JSON.stringify(next) !== JSON.stringify(site);
    if (!changed) return false;

    const prevVersion = configVersion;
    const prevSite = site;
    configVersion = config.version;
    site = next;
    freeTierCfg = config.freeTier || (self.PL.BUILT_IN_CONFIG.freeTier);
    applyLiveDelay(config);

    // ---- 總開關 ----
    // F1TV 大改版而我們一時修不好時，與其讓使用者看到錯亂的疊字，
    // 不如乾淨地退回原生英文字幕。這是最後的救命索（P3-PLAN 1.3）。
    killed = !!config.killSwitch;
    if (killed) {
      box.classList.remove('on');
      if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }   // 讓原生字幕回來
      evWarn('⛔ 已由遠端停用疊字（killSwitch）。原生英文字幕已恢復顯示。'
        + '這通常代表 F1TV 剛改版、我們正在修，請稍後再試。');
      return true;
    }

    // ---- 版本下限 ----
    // 舊版用戶端可能因為協定改變而產生壞資料（例如把殘缺的譯文寫進共用快取）。
    // 與其讓它繼續跑，不如明確要求更新。
    const myVer = EXT_VERSION;
    if (config.minClientVersion && cmpVer(myVer, config.minClientVersion) < 0) {
      tooOld = true;
      box.classList.remove('on');
      if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }   // 疊字停了，原生字幕一定要還回去
      evErr(`⛔ 這個版本（v${myVer}）已停止支援，最低需要 v${config.minClientVersion}。`
        + '請到 chrome://extensions 更新 PitLingo。');
      return true;
    }
    tooOld = false;

    // 選擇器換了就把觀察者整組重掛，並清掉「已隱藏」的樣式重新套用
    observedNodes = new Set();
    if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }
    applyHideNative();
    lastSeenCaption = ''; lastRaw = '';

    // ---- 自我檢查 ----
    // 推了壞選擇器時，使用者不該等我們發現。這裡在套用後 30 秒回頭確認
    // 「還抓得到字幕嗎」，抓不到就自動退回上一版設定（P3-PLAN 1.4）。
    // 有了它，即使推送出錯，最多也只壞 30 秒。
    if (prevVersion >= 0 && !killed && !tooOld) scheduleConfigSelfCheck(prevSite, prevVersion);

    if (prevVersion >= 0) {
      if (prevVersion === configVersion) {
        // 版本號一樣卻判定有變 → 是內容漂移，不是真的推了新設定。
        // 這種情況使用者不需要知道，降到詳細日誌就好。
        dbg(`遠端設定內容有異動但版本仍為 v${configVersion}，已就地套用`);
      } else {
        evOk(`⚙ 遠端設定已更新 v${prevVersion} → v${configVersion}，選擇器已就地套用`
          + `（root: ${(site.captionRoot || []).join(', ')}）`);
      }
    }
    return true;
  }

  /**
   * 遠端設定的自我檢查。
   *
   * 只在「套用新設定之前本來看得到字幕」時才判定失敗——否則影片剛開場、
   * 進廣告、或這段本來就沒旁白，都會被誤判成推送失敗而白白回退（坑 #14 的教訓）。
   */
  let selfCheckTimer = null;
  function scheduleConfigSelfCheck(prevSite, prevVersion) {
    clearTimeout(selfCheckTimer);
    const wasWorking = everSawCaption;
    const before = state.hits + state.misses;
    selfCheckTimer = setTimeout(() => {
      if (!wasWorking || !prevSite) return;              // 本來就沒在運作，不能判定
      if (!isActuallyPlaying()) return;                  // 沒在播就沒有判斷依據
      if (state.hits + state.misses > before) return;    // 這 30 秒有抓到字幕，正常
      if (collectCaption()) return;                      // 此刻畫面上有字幕，正常

      // ⚠️ **兩個誤判防線，都是實際遇到才補的。**
      //
      // 1. 版本沒變就沒有東西可以退。使用者實際看到過
      //    「套用設定 v1 後 30 秒都抓不到字幕，自動退回 v1」——
      //    退回自己是個 no-op，但那行紅字看起來像出了大事。
      if (prevVersion === configVersion) {
        dbg('自我檢查：30 秒沒有字幕，但設定版本沒變，沒有可退回的版本');
        return;
      }
      // 2. **「沒有字幕」不等於「選擇器壞了」。** 賽後訪問、頒獎、純畫面
      //    很容易連續 30 秒沒有任何旁白，那時原生字幕本來就是空的。
      //    選擇器真的失效時的樣子是**容器整個找不到**，而不是容器在、內容空。
      //    只看「抓不到文字」會把安靜的片段誤判成推壞設定，然後把好的設定退掉。
      if (captionContainers().length > 0) {
        dbg('自我檢查：30 秒沒有字幕，但字幕容器存在 → 判定為無旁白片段，不退回設定');
        return;
      }

      evErr(`⚠ 套用設定 v${configVersion} 後 30 秒找不到字幕容器，自動退回 v${prevVersion}`);
      site = prevSite;
      configVersion = prevVersion;
      observedNodes = new Set();
      if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }
      applyHideNative();
      lastSeenCaption = ''; lastRaw = '';
      hookObservers();
    }, 30000);
  }

  const MARK = '__pitlingo_vtt__';
  function installInjectBridge() {
    window.addEventListener('message', (ev) => {
      // 只接受同一個 window 發出、帶我們自己標記的訊息
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d[MARK] !== true) return;

      if (d.kind === 'injected') {
        state.workerPatched++;
        evOk(`✅ 已注入 Worker hook（原始腳本 ${d.bytes} bytes）`);
        return;
      }
      if (d.kind === 'vtt' && typeof d.vtt === 'string') {
        state.workerVtt++;
        const added = ingestVtt(d.vtt);
        if (added && !state.prefetchAnnounced) {
          state.prefetchAnnounced = true;
          setPhase('前瞻預譯中');
          // 措辭要準確：這裡只代表「攔到了新的 VTT 分段」，不是重跑整軌預抓。
          // 原本寫「開始批次預譯」，使用者掛著幾小時後看到它再次出現，
          // 會誤以為整支又要重翻一次（實際上只翻了 1~2 句沒命中的）。
          evOk('✅ 已從播放器的字幕分段取得提前量');
        }
        return;
      }
      if (d.kind === 'manifest' && typeof d.manifest === 'string') {
        noteStreamType(d.manifest);
        /* @test-only:start */ noteEncryption(d.manifest); /* @test-only:end */
        if (manifests.some((m) => m.url === d.url)) return;   // 同一份會重覆抓
        // 已經拿到字幕清單就不需要再留任何 manifest ——
        // 它們唯一的用途就是找出那個位址。
        if (subtitlePlaylistUrl) return;
        manifests.push({ url: d.url || '', body: d.manifest, bytes: d.manifest.length });
        // ⚠️ 上限要看**總位元組**，不是份數。
        //    每份最多 600,000 字元，12 份 = 最壞 14 MB 常駐在頁面裡。
        //    m3u8 是純文字，8 MB 已經遠超過任何實際情況。
        let total = manifests.reduce((a, m) => a + m.bytes, 0);
        while (manifests.length > MANIFEST_MAX || (manifests.length > 1 && total > MANIFEST_MAX_BYTES)) {
          total -= manifests.shift().bytes;
        }
        state.manifests = manifests.length;
        return;
      }
    }, false);
  }

  /**
   * 一句字幕的長度上限。**必須與後端的 `MAX_LINE_LEN` 一致。**
   *
   * 後端超過就整批退回（「單句長度不可超過 1000 字元」），所以送出去之前
   * 就該擋掉——讓後端替我們做輸入驗證，代價是整批句子一起被丟掉。
   *
   * 實際發生過：worker 攔到的媒體分段被硬解成文字，其中湊出了 "-->"，
   * `parseVtt` 於是產出一句幾萬字元的「字幕」。根因已在 inject.js 修掉
   * （不再碰媒體分段），這裡是第二道防線——真正的口語句子不會超過 200 字元，
   * 超過 1000 的一定不是字幕。
   */
  const MAX_LINE_LEN = 1000;

  /**
   * 從攔到的清單判斷直播或重播。
   *
   * ⚠️ **這件事以前只在整軌預抓裡做，而整軌預抓只對付費使用者執行。**
   *    免費使用者看直播時 `state.isLive` 永遠是 false，於是：
   *      · 免費額度用重播的規則算（`limit - video.currentTime`），
   *        直播的播放位置動輒幾千秒 → **一打開額度就是 0**
   *      · 翻譯請求沒有標成急件 → 多人同時看時互相讓路，字幕斷斷續續
   *      · 直播專用的抖動、不提前顯示等保護全部沒有作用
   *    而那正是「免費試看直播」——最需要一次就留住人的時刻（2026-09-17 行為測試發現）。
   *
   * 媒體清單（有 #EXTINF）沒有 #EXT-X-ENDLIST ＝ 直播；有 ＝ 重播。
   * master 清單看不出來，略過。DASH 看 MPD 的 type="dynamic"。
   */
  /* @test-only:start */
  /**
   * 串流有沒有加密（DRM）。**只記錄，不改變任何行為。只在測試版**（2026-09-17 使用者決定：為語音辨識評估加的，不放正式版）。
   *
   * 為什麼要量：「沒有官方字幕的影片自己做語音辨識」（handoff 9.1 #21）的第一個問題
   * 就是「音訊拿不拿得到」。HLS 的 `#EXT-X-KEY`（METHOD 不是 NONE）、DASH 的
   * `<ContentProtection>` 代表有加密；有 Widevine 之類的 DRM 時音訊分段是密文，
   * 語音辨識只剩「擷取分頁聲音」一條路。這個數字從來沒有被量過（2026-09-17）。
   * 清單內容在找到字幕清單後會被釋放，所以要在收到的當下就記。
   */
  const encryption = { seen: 0, encrypted: 0, methods: new Set() };
  function noteEncryption(body) {
    const t = String(body || '');
    encryption.seen++;
    const keys = [...t.matchAll(/#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=([A-Z0-9-]+)/gi)]
      .map((m) => m[1].toUpperCase()).filter((m) => m !== 'NONE');
    const kf = [...t.matchAll(/KEYFORMAT="([^"]+)"/gi)].map((m) => m[1]);
    const dash = /<ContentProtection/i.test(t);
    if (keys.length || dash) {
      encryption.encrypted++;
      keys.forEach((m) => encryption.methods.add(m));
      kf.forEach((f) => encryption.methods.add(/edef8ba9/i.test(f) ? 'Widevine' : /playready|9a04f079/i.test(f) ? 'PlayReady' : /fairplay|streamingkeydelivery/i.test(f) ? 'FairPlay' : f.slice(0, 40)));
      if (dash) encryption.methods.add('DASH ContentProtection');
    }
  }
  /* @test-only:end */

  function noteStreamType(body) {
    const head = String(body || '').slice(0, 4000);
    let live = null;
    if (/<MPD/i.test(head)) live = /type\s*=\s*"dynamic"/i.test(head);
    else if (/#EXTINF/i.test(body)) live = !/#EXT-X-ENDLIST/i.test(body);
    if (live === null || live === state.isLive) return;
    state.isLive = live;
    evInfo(live ? '偵測到直播（清單沒有結束標記）' : '偵測到重播（清單有結束標記）');
  }

  function ingestVtt(text, seg) {
    // 免費額度用完就不再排任何翻譯。
    // ⚠️ 這條路**不經過 `handleCaption`**，那裡的 `trialExhausted()` 擋不到它——
    //    漏掉的話免費使用者看不到字幕，我們卻還在替他翻譯後面的內容。
    if (trialExhausted()) return 0;
    let added = 0;
    let dropped = 0;
    const file = ++vttFileSeq;
    let firstOfFile = true;
    for (const cue of parseVtt(text)) {
      const t = clean(cue.text);
      if (!t || t.length < 2) continue;
      if (t.length > MAX_LINE_LEN) { dropped++; continue; }
      const k = normKey(t);
      if (!k) continue;
      // ⚠️ **時間軸要在 prefetchSeen 去重之前記。** 去重是「翻譯」用的
      //    （同一句不必翻兩次），但補字幕需要**每一次出現**的時間——
      //    「Box box」一場會出現幾十次，只記第一次就只補得到第一次。
      if (cue.start !== null && timeline.length < CUE_MAX) noteTimeline(k, t, cue, file, firstOfFile);
      firstOfFile = false;
      /* @admin-only:start */
      if (seg && typeof seg.at === 'number' && cue.start !== null) {
        const sec = cueVideoSec(cue.start, seg);
        const had = harvestTimes.get(k);
        if (had === undefined ? harvestTimes.size < CUE_MAX : sec < had) harvestTimes.set(k, sec);
      }
      /* @admin-only:end */
      if (prefetchSeen.has(k)) continue;
      prefetchSeen.add(k);
      // 已有譯文也要登記——那句確實出現在這支影片的 VTT 裡（坑 #16）
      sessionKeys.add(k);
      // 時間軸留給「提前顯示」用。上限與 memo 同級，避免無界成長。
      // 原文也要留：提前顯示時要跟中文一起畫出來，否則英文會晚一兩秒才跳進來。
      if (cue.start !== null && cueTimes.size < CUE_MAX) {
        cueTimes.set(k, cue.start);
        cueText.set(k, t);
      }
      // ⚠️ **提前量（VTT 抵達 → 畫面顯示）是這個專案最關鍵的未知數**
      //    （LIVE-TEST ①），而它到今天為止一次都沒有被量過——
      //    因為量它需要「直播當下」，而每次直播都忘了做。
      //    所以把它做成自動的：這裡記抵達時間，handleCaption 那邊記顯示時間。
      //    使用者什麼都不用做，事後匯出診斷就有。
      if (vttSeenAt.size < CUE_MAX) vttSeenAt.set(k, Date.now());
      if (memo.has(k)) continue;          // 共用快取已有，不用再翻
      if (pending.size >= PENDING_MAX) continue;   // 佇列爆了就先不收，下輪再說
      pending.set(k, t);
      added++;
    }
    if (dropped) {
      // 出現就代表有東西不對勁，要看得到。正常的 VTT 一句都不會被丟。
      state.badLines = (state.badLines || 0) + dropped;
      evWarn(`已略過 ${dropped} 句異常長度的字幕（超過 ${MAX_LINE_LEN} 字元），`
        + '通常代表攔到的不是字幕檔');
    }
    if (added) scheduleFlush();
    return added;
  }

  /**
   * 收割該不該停（userscript 坑 #15）。
   *
   * 只看 contentId 不夠：點播放器左上角的返回鍵時**網址不會變**，
   * 播放器已經被拆掉了，收割卻繼續跑完上千個請求。
   * 以「video 元素消失超過 5 秒」為訊號——5 秒是為了避開播放器重建時的短暫消失。
   */

  function harvestShouldStop(myGen) {
    if (myGen !== harvestGen) return '影片切換';

    // ⚠️ **關掉翻譯不算中止收割。**
    //
    // `settings.enabled` 控制的是「要不要在畫面上顯示疊字」，不是「要不要繼續
    // 貢獻共用快取」。使用者可能只是想暫時看純英文，收割跑到 80% 卻整個作廢，
    // 下一個看同一支影片的人就得從頭付費——那是白白浪費已經抓下來的東西。
    //
    // 收割的唯一終止條件是**使用者真的離開了這支影片**。而「離開」不能只看網址：
    // 點播放器左上角的返回鍵時網址完全不變，播放器卻已經被拆掉（坑 #15）。
    // 所以用 video 元素消失超過 5 秒當訊號（5 秒是為了避開播放器重建的短暫消失）。
    // 與顯示端共用同一份判斷（playerGone），兩邊定義不一致會非常難查
    return playerGone() ? '播放器已關閉' : null;
  }

  /**
   * 播放器現在有沒有餘裕讓我們抓東西。
   *
   * 判斷依據是**緩衝存量**，不是「有沒有在播」。等到 `waiting` 事件才讓路已經太晚——
   * 那時畫面已經停住，而且 ABR 早就降過一次畫質了。緩衝掉到 8 秒就先退開。
   *
   * 暫停時回 true：那時頻寬是空的，正是收割的好時機。
   */
  /** 播放器前方還緩衝了幾秒。取不到回 null（不代表有問題）。 */
  function bufferAheadSec() {
    const v = document.querySelector('video');
    if (!v || !Number.isFinite(v.currentTime)) return null;
    try {
      const b = v.buffered;
      if (!b || !b.length) return null;
      // 找出涵蓋目前播放位置的那一段，不能直接取最後一段——
      // 拖過進度條之後 buffered 會有好幾段，最後一段可能離現在很遠。
      for (let i = 0; i < b.length; i++) {
        if (v.currentTime >= b.start(i) - 0.5 && v.currentTime <= b.end(i)) {
          return b.end(i) - v.currentTime;
        }
      }
      return 0;                        // 目前位置根本沒被緩衝到 = 正在等
    } catch (e) { return null; }
  }

  /**
   * 現在該用什麼節奏抓。回傳要等的毫秒數。
   *
   * `'stall'` 代表播放器真的在等資料，那時完全不要跟它搶。
   */
  function fetchPace() {
    const v = document.querySelector('video');
    if (!v) return FETCH_GAP_MS;                 // 沒有影片就沒有要讓的對象
    if (v.paused || v.ended) return FETCH_GAP_MS; // 沒在播，頻寬讓給我們
    if (v.readyState < 3) return 'stall';         // HAVE_FUTURE_DATA 以下＝正在等資料
    const ahead = bufferAheadSec();
    if (ahead !== null && ahead < YIELD_BUFFER_SEC) return FETCH_GAP_SLOW_MS;
    return FETCH_GAP_MS;
  }

  /**
   * 依播放狀況調整節奏，回傳這一輪該等多久。
   *
   * 只有「真的在等資料」才會暫停，而且上限 5 秒——**必須保證一直有進度**，
   * 因為收割不完等於沒有人把譯文灌進共用快取。
   */
  async function paceForPlayback(myGen) {
    /* @admin-only:start */
    if (harvestFast) return HARVEST_FETCH_GAP_MS;
    /* @admin-only:end */
    let pace = fetchPace();
    if (pace !== 'stall') return pace;

    const t0 = Date.now();
    state.yieldCount++;
    while (fetchPace() === 'stall') {
      if (myGen !== harvestGen) return FETCH_GAP_MS;      // 換影片了
      if (Date.now() - t0 > YIELD_MAX_MS) break;
      await new Promise((r) => setTimeout(r, YIELD_POLL_MS));
    }
    state.yieldMs += Date.now() - t0;
    // 剛從卡住恢復，先用慢速走一段，不要立刻又搶滿
    return FETCH_GAP_SLOW_MS;
  }

  async function fetchSegments(list, myGen) {
    let idx = 0, lastPct = -1, stopReason = null;
    const worker = async () => {
      while (idx < list.length) {
        const stop = harvestShouldStop(myGen);
        if (stop) { stopReason = stop; return; }
        // 每抓一段之前都確認一次。整軌預抓會持續好幾分鐘，
        // 播放狀況在那段期間會變——只在開頭判斷一次沒有意義。
        const gap = await paceForPlayback(myGen);
        if (myGen !== harvestGen) return;
        const s = list[idx++];
        if (seenSegments.has(s.url)) continue;
        seenSegments.add(s.url);
        try {
          const t = await swFetchText(s.url);
          state.segFetched++;
          ingestVtt(t, s);
        } catch (e) { state.segFailed++; }
        const pct = Math.floor((state.segFetched / Math.max(1, list.length)) * 10) * 10;
        if (pct > lastPct && pct > 0 && pct < 100) {
          lastPct = pct;
          evInfo(`預抓進度 ${pct}%（${state.segFetched}/${list.length} 段，待翻 ${pending.size} 句）`);
        }
        // 用這一輪算出來的節奏，不是固定值——緩衝偏低時會自動變慢
        if (gap) await new Promise((r) => setTimeout(r, gap));
      }
    };
    // worker 數可以在途中變多（管理版的佇列晚一步接手時），所以用會長大的陣列，逐一等完
    const runners = [];
    const addWorkers = (n) => { while (runners.length < n) runners.push(worker()); };
    addWorkers(FETCH_CONCURRENCY);
    /* @admin-only:start */
    if (harvestFast) addWorkers(HARVEST_FETCH_CONCURRENCY);
    fetchBoost = () => addWorkers(HARVEST_FETCH_CONCURRENCY);
    /* @admin-only:end */
    for (let i = 0; i < runners.length; i++) await runners[i];
    /* @admin-only:start */
    fetchBoost = null;
    /* @admin-only:end */
    if (stopReason) evWarn(`收割已中止（${stopReason}），已抓 ${state.segFetched}/${list.length} 段`);
    return stopReason;
  }

  /** 直播：字幕清單是滑動視窗，定期重抓才能持續拿到 live edge 的新分段 */
  async function refreshLive(myGen) {
    if (myGen !== harvestGen || !subtitlePlaylistUrl) return;
    try {
      const body = await swFetchText(subtitlePlaylistUrl);
      const { segs } = parseMediaPlaylist(body, subtitlePlaylistUrl);
      const fresh = segs.filter((s) => !seenSegments.has(s.url));
      if (fresh.length) {
        evInfo(`直播：清單新增 ${fresh.length} 段`);
        await fetchSegments(fresh, myGen);
      }
    } catch (e) { evWarn(`直播清單更新失敗：${e.message}`); }
    if (myGen === harvestGen) liveTimer = setTimeout(() => refreshLive(myGen), LIVE_REFRESH_MS);
  }

  /**
   * 收割完成後告訴後端，讓下一個看同一支影片的人可以整段跳過。
   *
   * 等 25 秒才送：`handleComplete` 會拒絕「bundle 還沒有譯文」的標記請求，
   * 而最後幾批翻譯此時可能還在路上。標記早了會被拒，等於白跑一趟。
   */
  function markComplete(cid, segCount, myGen) {
    setTimeout(async () => {
      if (myGen !== harvestGen || cid !== contentId) return;
      // 帶上網址後綴，後台才分得出這是哪一場的哪個場次
      const res = await send({ type: 'markComplete', cid, segCount, slug: location.pathname });
      const r = (res.ok && res.result) || {};
      if (r.ok) {
        evOk(`✅ 已標記完整收割（${segCount} 段 / 後端 ${r.lineCount || '?'} 句）`
          + '，之後看這支影片的人會跳過整軌預抓');
      } else {
        evWarn(`標記完整收割未成功：${r.reason || r.error || '(未知)'}`);
      }
    }, 25000);
  }

  /**
   * 預抓翻完之後，回頭問後端「你現在有幾句」。
   *
   * 為什麼值得做：整條共用快取的價值全押在「我翻的東西真的存進去了」上，
   * 而那件事**沒有任何使用者可見的回饋**——存失敗了畫面一模一樣，
   * 只有下一個人要重新付費。實測就踩過：以為在貢獻，其實伺服器一句沒收到。
   *
   * 等 20 秒是要讓最後幾批翻譯先回來並寫進後端。
   */
  function verifyUpload(cid, myGen) {
    setTimeout(async () => {
      if (myGen !== harvestGen || cid !== contentId) return;
      const res = await send({ type: 'getBundle', cid, force: true });
      const b = (res.ok && res.bundle) || {};
      if (b.error) { evWarn(`共用快取回寫查核失敗：${b.error}`); return; }
      const server = b.lines || {};
      const serverCount = Object.keys(server).length;
      state.serverCount = serverCount;

      // ⚠️ 分母一定要用「這支影片的鍵」，不能用 memo.size。
      //    memo 跨影片共用（重複用語互相受惠，刻意的），拿它去比單一影片的
      //    bundle 必然偏低。實測就誤報過：本機 4308／後端 1946 看似只有 45%，
      //    其實 4308 裡有 2357 句是上一支影片的——真實回寫率是 99.7%。
      //    這是坑 #16 換個形式又出現，這次污染的是量測而不是資料。
      const mine = Array.from(sessionKeys);
      const missing = mine.filter((k) => !server[k]);
      const rate = mine.length ? (mine.length - missing.length) / mine.length : 1;

      if (rate >= 0.95) {
        evOk(`☁ 回寫查核：這支影片本機 ${mine.length} 句，後端已有 ${mine.length - missing.length} 句`
          + `（${Math.round(rate * 100)}%），共用快取正常累積`);
      } else {
        evWarn(`⚠ 回寫查核：這支影片本機 ${mine.length} 句，後端只有 ${mine.length - missing.length} 句`
          + `（${Math.round(rate * 100)}%）。`
          + '譯文沒有完整進入共用快取——下一個觀看者會重新付費。'
          + '請確認後端已部署最新版（`cd backend && wrangler deploy`），'
          + '以及 Cloudflare KV 當日寫入額度未用盡。');
      }
    }, 20000);
  }

  /**
   * 整軌預抓。
   *
   * 為什麼這件事值得做：worker 攔截給的是「播放器已經下載的」分段，也就是約
   * 50 秒的提前量——夠跟上語速，但**第一次看的人仍要為整支影片付翻譯費**，
   * 而且拖動進度條會跳到還沒攔到的區段。整軌預抓則是一次把整支翻完，
   * 之後零呼叫、100% 命中，並且把譯文灌滿共用快取讓所有後續觀看者受惠。
   *
   * 入口從哪來：**不打 PLAY API**（八個版本都不通，見 7.7；而且 F1TV 有
   * Imperva 機器人防護）。改用 worker 攔到的 manifest——播放器自己一定會抓，
   * 我們搭便車，零額外請求。
   */
  /**
   * 整軌預抓因為「播放器已關閉」中止、而播放器又回來了（F1TV 重建播放器、換畫質）：接著抓。
   * 沒有這段的話那支影片的收割就停在半路，收割佇列只能等到逾時記失敗。
   * 上限 3 次（鐵則 3）；換影片就作廢。
   */
  const PREFETCH_RESUME_MAX = 3;
  let prefetchResume = null;
  function tickPrefetchResume() {
    const r = prefetchResume;
    if (!r) return;
    if (r.cid !== contentId) { prefetchResume = null; return; }
    if (harvestInFlight || playerGone() || !document.querySelector('video')) return;
    if (r.n >= PREFETCH_RESUME_MAX) { prefetchResume = null; evWarn(`整軌預抓已中止 ${r.n} 次，不再自動接續`); return; }
    r.n++;
    evInfo(`播放器回來了，接續整軌預抓（第 ${r.n} 次；已抓 ${state.segFetched} 段不重抓）`);
    const { cid, force } = r;
    prefetchResume = Object.assign({}, r, { pendingRun: true });
    startPrefetch(cid, 0, force).finally(() => {
      if (prefetchResume && prefetchResume.pendingRun && prefetchResume.cid === cid) prefetchResume = null;
    });
  }

  async function startPrefetch(cid, attempt, force) {
    if (!cid) return;

    // ⚠️ **花錢之前先確認身分。**
    //
    // 整軌預抓會把整支影片（這裡是 1,203 段、上千句）送去翻譯。對已付費的人
    // 那是正確的：他要看完整場，而且順便把譯文灌滿共用快取讓所有人受惠。
    // 但對免費使用者，他**最多只看得到 15 分鐘**，卻讓我們付了整場的翻譯費。
    //
    // 更糟的是它可以被反覆觸發：進一支沒人翻過的影片、等收割開始、立刻退出、
    // 換下一支——每一輪都在燒錢。伺服器端每日 800 句的上限擋得住金額，
    // 但擋不住「免費使用者的成本結構本身就是錯的」。
    //
    // 免費模式改成只用 **worker 攔到的分段**（前瞻預譯）：那是播放器自己會下載的
    // 東西，我們搭便車、零額外請求，提前量約 50 秒，足夠涵蓋他看得到的 15 分鐘。
    // 整軌預抓留給付費使用者。
    //
    // `force` 是測試指令用的，會繞過這個判斷（上線前那段測試工具要整段移除）。
    if (!licensed && !force) {
      evInfo('免費模式：略過整軌預抓，改用播放器自己下載的字幕分段（提前量約 50 秒）。'
        + '購買授權後會自動改用整軌預抓，拖動進度條也不會漏字幕。');
      setPhase('前瞻預譯中');
      return;
    }

    const myGen = harvestGen;

    // 上一支影片的收割可能還在收尾（等待階段最長 45 秒，切換影片時要等它讀到
    // 世代已變才會退出）。直接 return 會讓新影片**永遠沒有整軌預抓**，
    // 所以改成稍後重試。上限是鐵則 #3：任何輪詢裡的重試都要有上限。
    if (harvestInFlight) {
      const n = (attempt || 0) + 1;
      if (n > 30) { evWarn('前一次收割遲遲未釋放，放棄整軌預抓'); return; }
      setTimeout(() => { if (myGen === harvestGen) startPrefetch(cid, n, force); }, 1500);
      return;
    }

    harvestInFlight = true;
    setPhase('等待字幕清單');
    try {
      const sp = await waitForSubtitlePlaylist(myGen);
      if (myGen !== harvestGen) return;
      if (!sp) {
        // 播放器關著的時候本來就攔不到（2026-11-01 R19 賽後節目：同一頁換片後播放器關了 9 分鐘，
        // B、C 等滿 45 秒就放棄，播放器回來之後整場都沒有整軌預抓）→ 跟「收割中途播放器關閉」一樣，回來再試
        if (playerGone()) {
          prefetchResume = { cid, force: !!force, at: Date.now(), n: (prefetchResume && prefetchResume.cid === cid ? prefetchResume.n : 0) };
          evInfo('等字幕清單時播放器是關著的，播放器回來後再試整軌預抓');
          setPhase('前瞻預譯中');
          return;
        }
        evWarn('等待 45 秒仍未從播放器攔到字幕清單，略過整軌預抓。'
          + '仍會用 worker 攔到的分段運作（有提前量，只是沒有整軌覆蓋）。');
        setPhase('前瞻預譯中');
        return;
      }
      evOk(`✅ 取得字幕清單（${sp.how}）`);

      setPhase('讀取字幕清單');
      prefetchHow = sp.how;
      subtitlePlaylistUrl = sp.url;
      // body 的唯一用途是找出這個位址，找到就放掉。
      // 診斷仍看得到有幾份與各自多大（bytes 留著）。
      manifests.forEach((m) => { m.body = ''; });
      // 路徑 1 已經連 body 都攔到了，不用再發一次請求
      const body = sp.body || await swFetchText(sp.url);
      const { segs, isVod } = parseMediaPlaylist(body, sp.url);
      state.playlistSegs = segs.length;
      state.isLive = !isVod;

      if (isVod) {
        /* @admin-only:start */
        // 每個分段在影片裡的起點＝前面所有分段的 EXTINF 加總（重播的清單從影片開頭列起）
        if (harvestOn) { let segAt = 0; for (const s of segs) { s.at = segAt; segAt += s.dur; } }
        /* @admin-only:end */
        // 已經有人完整收割過就不要再抓一次。
        //
        // 沒有這個判斷的話，每個開啟同一支影片的人都會再向 CDN 發 383 個請求、
        // 花約 80 秒，而那些分段幾乎不會帶來任何新句子——純粹浪費，
        // 還多累積一次 Imperva 的曝險。userscript 早就有這個判斷，
        // 擴充功能到 v0.4.3 才補上。
        if (!force && bundleSegCount > 0 && bundleSegCount === segs.length && memo.size > 0) {
          state.harvestSkipped = true;
          evOk(`⏭ 跳過整軌預抓：後端記錄這支已完整收割（${bundleSegCount} 段 / 本機 ${memo.size} 句），`
            + '不重複向 CDN 抓 ' + segs.length + ' 個分段');
          setPhase('前瞻預譯中');
          return;
        }

        setPhase('預抓中', `${segs.length} 段`);
        evInfo(`字幕分段共 ${segs.length} 個（重播，一次抓完）`);
        // 從目前播放位置開始，讓馬上要用到的先翻，不要先去翻片尾
        const v = document.querySelector('video');
        const cur = (v && isFinite(v.currentTime)) ? v.currentTime : 0;
        let acc = 0, start = 0;
        for (let i = 0; i < segs.length; i++) {
          if (acc + segs[i].dur > cur) { start = i; break; }
          acc += segs[i].dur;
        }
        const stopped = await fetchSegments(segs.slice(start).concat(segs.slice(0, start)), myGen);
        if (myGen !== harvestGen) { evInfo('預抓已中止（影片切換）'); return; }
        // harvestInFlight 還是 true，scheduleFlush 會繼續等湊滿一批。
        // 這裡先放開再倒佇列，否則最後不滿 BATCH_MAX 的句子會卡著不送。
        harvestInFlight = false;
        drainAfterHarvest();
        if (stopped) {                                      // 中止就不標記完整
          // 播放器被重建（不是使用者離開）時，回來後接著抓，已抓過的分段不重抓（見 tickPrefetchResume）
          if (stopped === '播放器已關閉') prefetchResume = { cid, force: !!force, at: Date.now(), n: (prefetchResume && prefetchResume.cid === cid ? prefetchResume.n : 0) };
          setPhase('前瞻預譯中'); return;
        }
        state.harvestDone = state.segFailed === 0;
        evOk(`預抓完成：${state.segFetched} 段成功、${state.segFailed} 段失敗，待翻 ${pending.size} 句`);
        // 只有「分段全抓到」**且「沒有句子被放棄」**才敢標記完整。
        //
        // 原本只看 segFailed，那只涵蓋「分段抓取」；翻譯失敗被放棄的句子完全
        // 不擋標記，等於可能把殘缺的 bundle 標成完整——之後所有人都跳過預抓，
        // 拿到的永遠是缺角的譯文，而且沒有任何機制會去補。
        /* @admin-only:start */
        // 管理版：用收割權杖蓋可信的章（等翻譯真的結束、譯文一起寫），不走 /v1/complete
        if (harvestOn && state.harvestDone) {
          harvestStampWhenSettled(cid, segs.length, myGen);
          verifyUpload(cid, myGen);
          return;
        }
        /* @admin-only:end */
        if (state.harvestDone && !state.dropped) {
          markComplete(cid, segs.length, myGen);
        } else if (state.dropped) {
          evWarn(`有 ${state.dropped} 句重試後仍失敗，這次不標記完整收割`
            + '（避免後續使用者跳過預抓卻拿到缺角的譯文）');
        }
        verifyUpload(cid, myGen);
      } else {
        setPhase('直播預抓中');
        evInfo(`偵測到直播（無 EXT-X-ENDLIST），改用滑動視窗持續補抓`);
        await fetchSegments(segs, myGen);
        harvestInFlight = false;
        drainAfterHarvest();
        liveTimer = setTimeout(() => refreshLive(myGen), LIVE_REFRESH_MS);
      }
    } catch (e) {
      // 預抓失敗不等於沒字幕——worker 攔截仍在跑，提前量還在。
      // 只是少了整軌覆蓋（拖進度條會遇到沒翻過的區段）。
      evErr(`整軌預抓失敗：${e.message}。改用 worker 攔到的分段繼續運作`);
      setPhase('前瞻預譯中');
    } finally {
      harvestInFlight = false;
    }
  }

  // =========================================================================
  // 影片切換
  // =========================================================================
  /**
   * 取回整支影片的譯文。
   *
   * 一定要能重試：實測過「啟動時金鑰還沒填 → 401 → 之後永遠不再嘗試」，
   * 結果整場都走最慢的逐句路徑。任何暫時性失敗都該自己恢復。
   */
  let bundleRetryTimer = null;
  let bundleAttempts = 0;
  const BUNDLE_MAX_ATTEMPTS = 5;

  async function loadBundle(cid, isRetry) {
    if (!cid) return;
    clearTimeout(bundleRetryTimer);
    if (!isRetry) bundleAttempts = 0;

    const res = await send({ type: 'getBundle', cid });
    const b = (res.ok && res.bundle) || {};
    bundleSegCount = b.segCount || 0;
    /* @admin-only:start */
    // 帶收割權杖時 segCount 只會是收割蓋的章（後端 legacy），所以這裡可以直接信
    harvestBundleComplete = harvestOn && bundleSegCount > 0 && Object.keys(b.lines || {}).length > 0;
    /* @admin-only:end */
    let n = 0;
    for (const [k, zh] of Object.entries(b.lines || {})) { if (!memo.has(k)) { remember(k, zh); n++; } }
    state.bundleCount = n;

    if (n) { evOk(`☁ 已從共用譯文庫取得 ${n} 句（cid ${cid}），本片無須重新翻譯`); return; }

    if (b.error) {
      bundleAttempts++;
      const hint = /401/.test(b.error) ? '（存取金鑰無效或尚未設定）' : '';
      if (bundleAttempts < BUNDLE_MAX_ATTEMPTS) {
        const wait = Math.min(30000, 3000 * bundleAttempts);   // 3s、6s、9s…
        log(`共用快取讀取失敗${hint}：${b.error}，${wait / 1000} 秒後重試（${bundleAttempts}/${BUNDLE_MAX_ATTEMPTS}）`);
        bundleRetryTimer = setTimeout(() => loadBundle(cid, true), wait);
      } else {
        log(`共用快取讀取失敗${hint}：${b.error}。已停止重試，改用逐句即時翻譯（較慢且較貴）。`);
      }
      return;
    }
    log(`共用快取尚無此影片的譯文（cid ${cid}），將以逐句即時翻譯運作`);
  }

  function checkContentChange() {
    if (location.pathname !== lastPath) { lastPath = location.pathname; seenContentId = null; }
    scanContentIdFromPerformance();
    const cid = currentContentId();
    if (!cid || cid === contentId) return;
    const prev = contentId;
    /* @admin-only:start */
    // 直播結束後 F1TV 自己播了下一支（沒人按）→ 不收那一支，回首頁（見 leaderAutoplayCheck）
    if (prev && prev === leaderBeatCid && !userActedRecently()) { leaderGoHome('直播結束後 F1TV 自動播了下一支'); return; }
    if (prev && prev === leaderBeatCid) leaderBye(prev);   // 前導端離開上一支：主動說一聲，免得觀眾那邊發告警
    /* @admin-only:end */
    contentId = cid;
    // 換影片時重置顯示狀態，但 memo 保留——不同影片的重複用語可以互相受惠
    lastRaw = ''; lastSeenCaption = ''; everSawCaption = false; currentEn = '';
    // 換影片＝重新判斷一次注入有沒有成功，並清掉上一支的代碼統計
    injectChecked = false; injectSince = Date.now(); seenCodes.clear();
    noSubShown = false;
    lastNonEmptyAt = Date.now(); gapReported = 0; noCaptionSince = Date.now();
    /* @test-only:start */ encryption.seen = 0; encryption.encrypted = 0; encryption.methods.clear(); /* @test-only:end */
    pending.clear(); requested.clear();
    clearTimeout(bundleRetryTimer); bundleAttempts = 0;
    observedNodes = new Set();

    // 讓還在跑的預抓自行中止，並清掉上一支的收割狀態
    harvestGen++;
    clearTimeout(liveTimer);
    subtitlePlaylistUrl = null;
    seenSegments.clear(); prefetchSeen.clear();
    // ⚠️ manifest 一定要清。留著的話新影片會拿上一支的字幕清單去抓，
    //    整支翻錯還不會報錯——就是坑 #16 那種靜默污染。
    manifests = [];
    sessionKeys = new Set();
    cueTimes.clear(); cueText.clear();
    // 補字幕的時間軸是**這支影片的**。不清的話錨點會落在上一支的句子上。
    // ⚠️ cueSeq 一定要跟 timeline 一起歸零，否則 `timeline[seq - 1]` 的不變式失效，
    //    補字幕會拿錯句子——而且不會報錯。
    timeline.length = 0; timelineIdx.clear(); keyEntries.clear();
    cueSeq = 0; fillAnchor = null; fillActive = null;
    zhLag.ms.length = 0; zhLag.waiting.clear(); zhLag.late = 0; zhLag.never = 0;
    timeBase = 'unknown'; timeBaseSamples.length = 0; gapFill.filled = 0;
    // 提前量、觀看時間、自動採樣也都是「這支影片的」數字。
    // ⚠️ 原本換影片時**完全沒清**，HUD 上的時間與提前量會把上一支的算進來。
    leadSamples.length = 0; vttSeenAt.clear();
    watchMs = 0; watchLastAt = 0;
    liveTest.startedAt = Date.now();
    liveTest.q = { dropped: 0, total: 0, res: '', resChanges: [], stalls: 0, stallSec: 0 };
    liveTest.free = { startLeft: null, lastLeft: null, endedAt: 0 };
    liveTest.dvr = { n: 0, minDepth: null, maxDepth: null, minBehind: null, maxBehind: null };
    liveTest.buf = { n: 0, sum: 0, min: null };
    liveTest.events = [];
    calibSamples.length = 0; calibrated = null; calibSpread = null;
    calibNote = '尚未取得樣本';
    shownEarly.clear(); lastSeekCheck = 0;
    cancelTimingTimers();
    resetOffsetForNewVideo();
    // 每支影片各自判定免費資格
    freeSession = self.PL.isFreeSession(location.pathname, freeTierCfg);
    // ⚠️ **換影片不重置額度**——那正是舊版「每支影片各 15 分鐘」的來源
    lastTickAt = 0; trialEndedShown = false;
    loadFreeDaily();
    bundleSegCount = 0;
    state.manifests = 0;
    state.harvestSkipped = false;
    state.dropped = 0;
    state.badLines = 0; state.blocked = 0; state.gaps = 0; state.lastGap = null;
    state.yieldCount = 0; state.yieldMs = 0;
    state.serverCount = -1;
    state.playlistSegs = 0; state.segFetched = 0; state.segFailed = 0;
    state.isLive = false; state.harvestDone = false;
    /* @admin-only:start */
    harvestStamp.cid = ''; harvestStamp.state = ''; harvestStamp.note = '';
    harvestBundleComplete = false;
    harvestTimes.clear();
    if (prev) harvestFast = false;     // 佇列是整頁導覽；同一頁內換影片＝有人手動點了別支
    /* @admin-only:end */

    if (prev) { setPhase('切換影片'); evInfo(`影片切換 ${prev} → ${cid}`); }
    metric('session_start', { sessionType: sessionType(), licensed });
    loadBundle(cid).then(() => startPrefetch(cid));
  }

  // =========================================================================
  // 啟動
  // =========================================================================
  async function boot() {
    const [cfgRes, setRes] = await Promise.all([
      send({ type: 'getConfig' }),
      send({ type: 'getSettings' }),
    ]);
    const config = (cfgRes.ok && cfgRes.config) || self.PL.BUILT_IN_CONFIG;
    settings = sanitizeSettings((setRes.ok && setRes.settings) || {});
    debugOn = !!settings.debug;
    hudSet(!!settings.hud);
    site = siteConfigFor(config, location.hostname);
    freeTierCfg = config.freeTier || self.PL.BUILT_IN_CONFIG.freeTier;
    applyLiveDelay(config);
    configVersion = config.version;

    // ⚠️ **總開關與版本下限在啟動時就要判斷。**
    //    以前只在 applyRemoteConfig 裡、而且只有「版本號跟上次不同」時才判斷——
    //    頁面載入時拿到的設定就是新版，之後每 60 秒問到的都一樣，永遠不會觸發。
    //    也就是說：**開關打開之後才打開 F1TV 的人，完全不受總開關影響**。
    //    那是 F1TV 大改版時唯一的救命索（2026-09-17 行為測試發現）。
    killed = !!config.killSwitch;
    tooOld = !!(config.minClientVersion
      && cmpVer(EXT_VERSION, config.minClientVersion) < 0);
    if (killed) {
      evWarn('⛔ 已由遠端停用疊字（killSwitch）。原生英文字幕照常顯示。');
    }
    if (tooOld) {
      evErr(`⛔ 這個版本（v${EXT_VERSION}）已停止支援，`
        + `最低需要 v${config.minClientVersion}。請到 chrome://extensions 更新 PitLingo。`);
    }

    if (!site) { evWarn('這個網域沒有對應的設定，不啟用'); return; }
    setPhase('等待播放');
    evOk(`PitLingo v${EXT_VERSION} 已啟動　|　設定版本 ${config.version}`
       + `　|　翻譯：${settings.enabled ? '開啟' : '關閉'}`);
    evInfo('提示：擴充功能圖示 →「回報問題」→「傳送診斷資訊」可一鍵送出完整狀態');

    /* @admin-only:start */
    // ⚠️ 包 try：這一行在 boot() 裡，丟例外會讓整個擴充功能靜靜不動（收割權杖讀不到＝一般使用者）
    try { harvestOn = !!((await chrome.storage.local.get('harvestToken')) || {}).harvestToken; } catch (e) { harvestOn = false; }
    if (harvestOn) evInfo('🚜 管理版：已設定收割權杖，翻譯與完整標記走收割身分');
    else evWarn('🚜 管理版：尚未設定收割權杖——不翻譯、不當前導端（擴充功能圖示 → 最下面「管理版：收割」）');
    /* @admin-only:end */
    // 授權狀態決定免費層的閘門。取不到就當未授權——
    // **但那不會鎖住功能**，只是套用免費額度（15 分鐘）。
    await refreshLicensed();
    freeSession = self.PL.isFreeSession(location.pathname, freeTierCfg);

    applyHideNative();
    mount();
    // 直播延遲畫面：每秒看一次。killSwitch／版本過舊時整個擴充功能都不該動畫面
    setInterval(() => {
      if (!orphaned && !extAlive()) orphanShutdown();
      try { tickAutoCC(); } catch (e) { /* 不影響字幕 */ }
      if (!orphaned && !killed) { try { tickPrefetchResume(); } catch (e) { /* 不影響字幕 */ } }
      try { liveDelay.tick(state.isLive && !killed && !tooOld && !orphaned); } catch (e) { /* 不影響字幕 */ }
    }, 1000);
    /* @admin-only:start */ leaderLoad(); /* @admin-only:end */
    /* @test-only:start */ coverageBadgesStart(); /* @test-only:end */

    // 接收 MAIN world 注入 worker 後轉送回來的 VTT —— 提前量的唯一來源
    installInjectBridge();

    // 預設的資源計時緩衝只有 250 筆，長時間觀看會把播放器的 PLAY 請求擠出去，
    // 之後就再也找不到那個網址了。
    try { performance.setResourceTimingBufferSize(1000); } catch (e) { /* noop */ }

    // 自動診斷回報：**預設關閉**，只有在自己的機器上開過才會有值
    try {
      chrome.storage.local.get(['autoDiag', 'plAutoLive'], (o) => {
        autoDiagMin = autoDiagClamp(o && o.autoDiag);
        /* @admin-only:start */
        // 管理版開著「自動開直播」＝這台是無人值守的收割端（Ray 自己的機器，不是客戶）→ 預設每 10 分鐘送一份。
        // 不寫進 storage：關掉自動開直播就跟著回到原本的設定
        if (!autoDiagMin && o && o.plAutoLive) autoDiagMin = 10;
        adminAutoLive = (o && o.plAutoLive) || false;
        /* @admin-only:end */
        if (autoDiagMin) evInfo(autoDiagStatus());
      });
    } catch (e) { /* noop */ }
    /* @admin-only:start */
    // 開關打開之後不用重新整理就要開始自動診斷（A14，2026-10-26）：以前只在載入頁面那一刻讀一次，
    // 先開頁面、後開開關的那一場整場沒有自動診斷。使用者自己設的 autoDiag 優先，不覆蓋
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local' || !ch.plAutoLive) return;
        adminAutoLive = ch.plAutoLive.newValue || false;
        chrome.storage.local.get(['autoDiag'], (o) => {
          if (autoDiagClamp(o && o.autoDiag)) return;
          const want = adminAutoLive ? 10 : 0;
          if (want === autoDiagMin) return;
          autoDiagMin = want; autoDiagPlayedMs = 0; autoDiagTickAt = 0; autoDiagCt = null;
          evInfo(autoDiagStatus());
        });
      });
    } catch (e) { /* noop */ }
    // 繪製狀態（A12）：R18 Post-Race 收割端畫面全黑、進度條凍住，影片卻照播。
    // 推測是視窗在螢幕外時 Chrome 不跑 requestAnimationFrame（播放器的介面靠它更新）——
    // 下一次凍住時診斷報告要能直接回答「rAF 有沒有在跑、視窗在哪、影片的版面多大」
    (function rafMeter() {
      let n = 0;
      const f = () => { n++; try { requestAnimationFrame(f); } catch (e) { /* noop */ } };
      try { requestAnimationFrame(f); } catch (e) { /* noop */ }
      setInterval(() => { adminRafRate = n / 10; n = 0; }, 10000);
    })();
    /* @admin-only:end */

    setInterval(pollCaption, POLL_MS);
    setInterval(() => {
      checkContentChange();
      hookObservers();
      mount();
      reposition();
      checkNoCaption();
      checkCaptionGap();
      checkNoSubtitleTrack();
      checkInjection();
      tickFreeUsage();
      tickAutoDiag();
      // 冪等。免費額度剛用完、授權剛生效、遠端開關改變，
      // 原生字幕該不該藏都在這裡收斂，不靠某一個事件記得去處理。
      applyHideNative();
    }, STRUCT_MS);

    // 定期重讀遠端設定並「就地套用」。
    // 沒有這個的話，F1TV 改版時就算後端已經推了新選擇器，
    // 使用者還是得自己重新整理頁面才會生效——比賽播到一半沒人會想這樣做。
    setInterval(applyRemoteConfig, CONFIG_RECHECK_MS);
    // 剛買完要立刻能用，剛被停用也要及時反映
    setInterval(refreshLicensed, CONFIG_RECHECK_MS);

    ['fullscreenchange', 'webkitfullscreenchange', 'resize', 'scroll'].forEach((e) =>
      window.addEventListener(e, () => { mount(); reposition(); }, true));

    /**
     * 關閉分頁前，把還沒送出的句子做最後一搏。
     *
     * 擴充功能的譯文是**由後端在 /v1/translate 當下寫回 bundle** 的，所以
     * 「翻好的」本來就已經在伺服器上，中途離開不會白費——這點和 userscript
     * 的「累積到最後才上傳」不同，反而更安全。
     *
     * 但**還在佇列裡、根本還沒送出去**的那些會直接消失。收割完的瞬間可能還有
     * 幾十句待送，這時關掉分頁就等於下一個人要重翻那幾十句。
     *
     * pagehide 不能用 await（頁面隨時會被凍結），所以直接發 keepalive 請求。
     * 這也是為什麼要走 sendBeacon 風格而不是等回應——我們不需要譯文了，
     * 只是要讓伺服器把它翻出來存進共用快取，嘉惠下一個人。
     */
    window.addEventListener('pagehide', () => {
      flushMetrics();
      /* @admin-only:start */
      if (leaderBeatCid) leaderBye(leaderBeatCid);
      /* @admin-only:end */
      if (!pending.size || !contentId) return;
      const lines = Array.from(pending.values()).slice(0, 200);
      send({ type: 'translateKeepalive', cid: contentId, lines });
      evInfo(`離開頁面，最後送出 ${lines.length} 句給共用快取`);
    });

    // 分頁重新可見／取得焦點時立刻重檢，不用等下一次輪詢。
    // 這正是「動了動滑鼠就好」那個症狀的直接對策。
    ['focus', 'visibilitychange'].forEach((e) =>
      window.addEventListener(e, () => {
        if (document.visibilityState === 'hidden') return;
        checkPollStall();
        pollCaption();
      }, true));

    // ⚠️ **不管有沒有打開面板，採樣一律開始。**
    //
    //    整個 LIVE-TEST 卡了好幾場直播，原因從來不是做不到，
    //    而是「要在直播當下記得去按」。把它綁在任何開關上，
    //    下一場就會再忘記一次——所以這裡沒有開關，開著就在量。
    //    成本：每 10 秒讀幾個 video 屬性，不發任何網路請求、不寫任何儲存空間。
    ltStart();

    checkContentChange();
  }

  // 設定在選項頁被改動時即時反映，不用重新整理
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // 別的分頁扣了今天的免費額度：這裡也要跟著少（取較大值，不會倒退）
    if (changes[FREE_DAILY_KEY]) {
      const v = changes[FREE_DAILY_KEY].newValue || {};
      rollFreeDay();
      if (v.day === freeDay && Number(v.spent) > freeSpent) freeSpent = Number(v.spent);
    }

    // 在別的分頁開關自動診斷，這裡跟著改，不用重新整理
    if (changes.autoDiag) {
      autoDiagMin = autoDiagClamp(changes.autoDiag.newValue);
      autoDiagPlayedMs = 0;
      autoDiagTickAt = 0;
      autoDiagCt = null;
    }

    if (changes.settings) {
      settings = sanitizeSettings(changes.settings.newValue);
      debugOn = !!settings.debug;
      // 勾起來就立刻出現、取消就立刻消失。**不要等重新整理**——
      // 直播當下要看狀態的人，沒有辦法重新整理（那會中斷播放）。
      hudSet(!!settings.hud);
      // 時機一改，之前排好的延後計時器就作廢——它是用**舊的**偏移排的。
      // 不清的話「延後 3 秒 → 改成提前」的那一刻，兩種模式會有一小段重疊。
      cancelTimingTimers();
      applyHideNative();
      reposition();
      if (!settings.enabled) box.classList.remove('on');
    }

    // 剛啟用授權、剛登入、剛被停用：**立刻**重算，不要等 60 秒的輪詢。
    //    使用者在設定頁按下「啟用」之後切回影片，看到的必須已經是付費模式。
    if (changes.entitlement || changes.entExp || changes.licenseKey || changes.accountToken) {
      refreshLicensed().then(() => applyHideNative()).catch(() => {});
    }

    // 金鑰是後填的很常見（開了播放頁才想到要設定）。
    // 一填好就立刻重抓 bundle，不必等使用者重新整理或換影片。
    if (changes.clientToken && contentId) {
      log('偵測到存取金鑰更新，重新讀取共用快取');
      bundleAttempts = 0;
      loadBundle(contentId);
    }
  });

  // =========================================================================
  // 診斷報告
  // 一鍵匯出所有狀態。回報問題時直接貼這份，不用翻 Console，
  // 也不用另外去 chrome://extensions 開 service worker 的視窗。
  // =========================================================================
  /**
   * 把網址裡的敏感段落遮掉，但保留足以診斷的資訊（長度、頭尾、路徑結構）。
   * 判斷「網址有沒有被截斷」只需要長度，不需要權杖本體。
   */
  function maskUrl(u) {
    if (!u) return '(尚未取得)';
    try {
      const url = new URL(u);
      // F1TV 的授權段是 /v2/pa_<很長的 base64>/...
      const path = url.pathname.replace(/\/(pa_[A-Za-z0-9_\-=]+)/g, (m, tok) =>
        `/pa_${tok.slice(3, 11)}…${tok.slice(-6)}[共${tok.length - 3}字元·已遮蔽]`)
        // Akamai 的授權段是 /v2/hdntl=exp=…~acl=…~hmac=<簽章>/...（2026-11-01 R19 排位重播走 f1prodlive.akamaized.net，
        // 舊版只認 pa_，整段簽章原封不動進了診斷報告）
        .replace(/\/((?:hdntl|hdnts|hdnea)=[^/]+)/g, (m, tok) => `/${tok.slice(0, 6)}…[共${tok.length}字元·已遮蔽]`);
      return `${url.origin}${path}${url.search ? '?<query 已遮蔽>' : ''}　(全長 ${u.length} 字元)`;
    } catch (e) {
      return `(網址解析失敗，全長 ${String(u).length} 字元)`;
    }
  }

  function buildDiagnostics() {
    const L = [];
    const v = document.querySelector('video');
    const rootEl = activeContainer();
    L.push('════════ PitLingo 擴充功能 診斷報告 ════════');
    L.push(`產生時間　：${new Date().toISOString()}`);
    L.push(`版本　　　：${EXT_VERSION}`);
    L.push(`目前階段　：${phase}`);
    /* @admin-only:start */
    L.push(`自動開直播：${adminAutoLive === true ? '主機' : adminAutoLive === 'standby' ? '備援機（待命）' : '⚠️ 關（這台不會自己開直播）'}`);
    {
      const vr = v ? v.getBoundingClientRect() : null;
      L.push(`畫面繪製　：rAF ${adminRafRate === null ? '量測中' : adminRafRate + ' 次/秒'}　可見度 ${document.visibilityState}`
        + `　視窗 (${window.screenX},${window.screenY}) ${window.outerWidth}×${window.outerHeight}`
        + `　影片版面 ${vr ? Math.round(vr.width) + '×' + Math.round(vr.height) : '-'}`);
    }
    /* @admin-only:end */
    L.push(`網址　　　：${location.href}`);
    L.push(`UA　　　　：${navigator.userAgent}`);
    L.push('');
    L.push('──── 影片與字幕 ────');
    L.push(`contentId　：${contentId || '(無)'}（網址 ${(location.pathname.match(/\/detail\/(\d+)/) || [])[1] || '-'} / 觀察 ${seenContentId || '-'}）`);
    L.push(`video　　　：${v ? `${v.paused ? '暫停' : '播放中'} ${v.currentTime.toFixed(1)}s / ${v.duration}` : '無'}`);
    L.push(`字幕容器　：${captionContainers().length} 個（觀察中 ${observedNodes.size}）`);
    L.push(`容器文字長：${rootEl ? (rootEl.textContent || '').trim().length : 0} 字`);
    L.push(`目前抓到　：${collectCaption() || '(空)'}`);
    L.push(`曾看到字幕：${everSawCaption ? '是' : '否'}`);
    L.push('');
    L.push('──── 提前量來源：Worker 注入 ────');
    L.push(`已注入 Worker：${state.workerPatched} 個`);
    L.push(`收到的 VTT 分段：${state.workerVtt} 份`);
    L.push(`攔到的 manifest：${state.manifests} 份（整軌預抓的入口）`);
    // 分類一下，找不到字幕清單時這行會直接說明卡在哪
    const mMaster = manifests.filter((m) => /#EXT-X-STREAM-INF/i.test(m.body || '')).length;
    const mSubs = manifests.filter((m) => /#EXTINF/i.test(m.body || '') && /\.vtt|\.webvtt/i.test(m.body || '')).length;
    const mBytes = manifests.reduce((a, m) => a + (m.bytes || 0), 0);
    L.push(`  其中 master ${mMaster} 份、字幕清單 ${mSubs} 份、共 ${(mBytes / 1024).toFixed(0)} KB`
      + (subtitlePlaylistUrl ? '（已取得清單，內容已釋放）' : ''));
    /* @test-only:start */
    L.push(`串流加密　：看過 ${encryption.seen} 份清單，其中 ${encryption.encrypted} 份有加密`
      + (encryption.methods.size ? `（${[...encryption.methods].join('、')}）` : '')
      + '　※ 評估語音辨識用：有 DRM 時音訊分段是密文，只能擷取分頁聲音');
    /* @test-only:end */
    L.push(`PLAY API 路徑：已停用（八輪未通，改用 Worker 注入 + 攔到的 manifest）`);
    L.push('');
    L.push('──── 整軌預抓（決定成本與拖進度條會不會漏）────');
    L.push(`型態　　　：${state.isLive ? '直播（滑動視窗）' : '重播'}`);
    {
      const ld = liveDelay.status();
      L.push(`延遲畫面　：${!ld.enabled ? (leaderMode ? '關（前導收割模式）' : '關（遠端設定）') : !ld.live ? '待命（不是直播）' : ld.stopped ? '停用：' + ld.stopped : '進行中'}`
        + `　目標 ${ld.seconds}s　落後邊緣 ${ld.frozen ? '—（進度條凍住：影片在播、進度條不動，量不準）' : ld.behind === null ? '—（找不到進度條）' : ld.behind + 's'}（進度條）${ld.frozenTimes ? `　凍住過 ${ld.frozenTimes} 次` : ''}`
        + `　修正 ${ld.fixes} 次（進直播 ${ld.entryFix ? '有' : '無'}、攔 LIVE 鍵 ${ld.liveFixes}、補送 ${ld.tickFixes}、修過頭 ${ld.overFixes || 0}、沒反應 ${ld.noEffect}）　前導收割端 ${leaderSeen === null ? '—' : leaderSeen ? '在' : '不在'}`);
    }
    L.push(`清單來源　：${prefetchHow || '(尚未取得)'}`);
    // ⚠️ **絕對不能把完整網址寫進報告。**
    //
    // F1TV 的字幕清單網址裡有一段 base64，解開來含 sessionId 與一個 24 小時
    // 有效的 CDN 存取權杖（ttl:1440）。這份報告是設計來貼給別人看的——
    // 貼出去等於把該串流的存取權一起送出去。
    //
    // v0.4.0 為了偵錯拿掉截斷時破壞了這個原則（坑 #31）。
    // 現在改成遮蔽權杖但保留長度與頭尾，仍然看得出「有沒有被切掉」——
    // 那才是坑 #3 真正要防的事，不需要完整權杖也能判斷。
    L.push(`字幕清單　：${maskUrl(subtitlePlaylistUrl)}`);
    L.push(`分段　　　：清單 ${state.playlistSegs} / 已抓 ${state.segFetched}（失敗 ${state.segFailed}）`);
    // 收割與影片搶同一個 CDN 的頻寬。這兩個數字是「我們有沒有乖乖讓路」的證據——
    // 使用者回報畫質下降時先看這裡，全 0 代表根本沒讓過。
    const ahead = bufferAheadSec();
    L.push(`讓路給影片：暫停 ${state.yieldCount} 次共 ${(state.yieldMs / 1000).toFixed(1)} 秒`
      + `　目前節奏 ${fetchPace() === 'stall' ? '暫停（播放器正在等資料）' : fetchPace() + 'ms'}`);
    L.push(`播放器緩衝：${ahead === null ? '(取不到)' : ahead.toFixed(1) + ' 秒'}`
      + `　放慢門檻 ${YIELD_BUFFER_SEC}s、正常 ${FETCH_GAP_MS}ms／放慢 ${FETCH_GAP_SLOW_MS}ms、並發 ${FETCH_CONCURRENCY}`);
    L.push(`收割完成　：${state.harvestDone}　進行中：${harvestInFlight}　世代 ${harvestGen}`);
    L.push(`後端完整度：記錄 ${bundleSegCount} 段` + (state.harvestSkipped ? '　→ 本次已跳過整軌預抓' : (bundleSegCount ? '' : '（尚無人完整收割過）')));
    L.push('');
    L.push('──── 顯示延遲的歸因 ────');
    // 這一段的用途：回答「延遲有多少是我們造成的」。
    // observer 命中 = 我們幾乎沒有加延遲；輪詢命中 = 最壞加了一個 POLL_MS。
    const dTot = detect.byObserver + detect.byPoll;
    const pctObs = dTot ? Math.round((detect.byObserver / dTot) * 100) : 0;
    L.push(`偵測來源　：observer ${detect.byObserver} 次 / 輪詢 ${detect.byPoll} 次`
      + `（observer 佔 ${pctObs}%，輪詢間隔 ${POLL_MS}ms）`);
    const stat = (arr) => {
      if (!arr.length) return '(尚無樣本)';
      const a = arr.slice().sort((x, y) => x - y);
      return `中位數 ${a[Math.floor(a.length / 2)].toFixed(1)}ms / `
        + `p90 ${a[Math.floor(a.length * 0.9)].toFixed(1)}ms / 最大 ${a[a.length - 1].toFixed(1)}ms`
        + `（${a.length} 筆）`;
    };
    {
      const z = zhLagStats();
      L.push('中文落後英文：' + (z
        ? `中位數 ${(z.p50 / 1000).toFixed(2)}s / p90 ${(z.p90 / 1000).toFixed(2)}s（最近 ${z.n} 筆）`
          + `　超過 0.5 秒 ${z.late} 句、譯文回來時已經換句 ${z.never} 句`
          + `　／ 全場 ${z.seen} 句（沒跟上 ${z.seen ? ((z.never / z.seen) * 100).toFixed(1) : '0.0'}%）`
          + (z.p50 > 500 ? '　⚠️ 超過使用者定的 0.5 秒判準 → 見 LIVE-TEST.md 的延遲畫面' : '')
        : '(尚無樣本)'));
      L.push('※ 這一行才是使用者感覺到的落後（含等譯文的時間）。下面兩行只量我們自己畫得多快。');
    }
    L.push(`JS 耗時　　：${stat(detect.renderMs)}`);
    L.push(`到上畫面　：${stat(detect.paintMs)}　← 這個才是使用者看到的`);
    L.push('※ 「JS 耗時」只到函式返回，不含版面計算與繪製。要跟 userscript 比就比「到上畫面」。');
    L.push('');
    L.push('──── 字幕時機微調 ────');
    // 「設定值」與「實際生效」一定要分兩行印。
    // 只印一個數字的話，使用者設了提前 1.5 秒但條件不成立時，
    // 報告看起來完全正常，我們也查不出他為什麼覺得沒效。
    L.push(`設定值　　：${clampOffset(settings.subtitleOffset)} ms`
      + `（上限：延後 ${OFFSET_LATE_MAX_MS} / 提前 ${OFFSET_EARLY_MAX_MS}）`);
    L.push(`實際生效　：${activeOffsetMs()} ms　→ ${offsetStatusText()}`);
    L.push(`校準　　　：${calibNote}`
      + `　樣本 ${calibSamples.length}/${CALIB_MIN}`
      + `　離散 ${calibSpread === null ? '-' : calibSpread.toFixed(2) + 's'}`
      + `（上限 ${CALIB_MAX_SPREAD_S}s）`);
    L.push(`cue 時間軸：${cueTimes.size} 句有時間`
      + `　已提前顯示 ${shownEarly.size} 句`);
    L.push(`延後佇列　：${delayQueue.size} 筆待執行（上限 ${DELAY_QUEUE_MAX}）`
      + '　※ 顯示與收起都在裡面，只延後其中一邊會讓字幕閃一下就消失');
    L.push(`停留上限　：${HOLD_MS} ms（固定值，不開放調整）`);
    L.push('');
    L.push('──── 翻譯 ────');
    L.push(`共用快取取得：${state.bundleCount} 句`);
    L.push(`後端回寫查核：${state.serverCount < 0 ? '(尚未查核)' : state.serverCount + ' 句在後端'}`);
    if (batchStats.length) {
      const sent = batchStats.reduce((a, b) => a + b.sent, 0);
      const got = batchStats.reduce((a, b) => a + b.got, 0);
      const ms = batchStats.reduce((a, b) => a + b.ms, 0);
      L.push(`批次效率　：${batchStats.length} 批、平均 ${(sent / batchStats.length).toFixed(1)} 句/批、`
        + `平均 ${Math.round(ms / batchStats.length)}ms、回覆率 ${sent ? Math.round((got / sent) * 100) : 0}%`);
    }
    L.push(`本機快取　：${memo.size} 句`);
    L.push(`命中 / 未命中：${state.hits} / ${state.misses}`);
    // 出現過的錯誤代碼。**排在前面**——這是回報時最有用的一行。
    if (seenCodes.size) {
      L.push('錯誤代碼　：' + Array.from(seenCodes, ([c, n]) =>
        c + '×' + n + '（' + (PL_CODES[c] || '?') + '）').join('　'));
    } else {
      L.push('錯誤代碼　：無');
    }
    L.push(`字幕軌　　：${({ has: '有', none: '這支影片沒有官方字幕', unknown: '尚未判定' })[subtitleTrackVerdict()]}`);
    // ⚠️ 這一行是為了讓「安靜地多付錢」浮出來。cid 解析不到時，譯文會落進
    //    所有影片共用的 misc 桶子，這支影片的下一位觀看者要重新付費。
    L.push(`影片編號　：${contentId || '（尚未解析出來）'}`
      + `${state.heldNoCid ? `　※ 曾因沒有編號而暫留 ${state.heldNoCid} 句` : ''}`
      + `${state.droppedNoVideo ? `　※ 頁面沒有影片、沒送出 ${state.droppedNoVideo} 句` : ''}`
      + `${state.noCidWarned ? '　⚠ 最後仍以公用快取送出' : ''}`);
    L.push(`即時翻譯　：${state.translated} 句　錯誤 ${state.errors}　`
      + `放棄 ${state.dropped} 句${state.dropped ? '（已重試 3 次）' : ''}`);
    // 不是 0 就代表「攔到的東西不是字幕」。曾經因為 worker 把媒體分段
    // 硬解成文字、其中湊出 "-->"，而送出幾萬字元的假字幕給後端。
    // 中途缺漏。**這是「看比賽時字幕突然消失一段」的唯一線索**——
    // 舊版看過一次字幕之後就再也不警告，那種缺漏完全是隱形的。
    L.push(`中途缺漏　：${state.gaps || 0} 次`
      + (state.lastGap
        ? `　最近一次：${state.lastGap.kind} / ${state.lastGap.sec} 秒 / ${state.lastGap.at}`
        : '（無）')
      + `　※ kind：untranslated=無譯文、render=有譯文卻沒畫、`
      + `container_gone=找不到字幕容器、silent=本來就沒旁白（正常）`);
    L.push(`長度異常略過：${state.badLines || 0} 句`
      + (state.badLines ? `　⚠ 不該大於 0，代表攔截層抓到了不是字幕的東西` : ''));
    // ⚠️ **這個數字一定要出現在報告裡。** 合理性檢查會讓那一句沒有中文字幕，
    //    過度攔截的症狀是「偶爾少一句」——除非看得到次數，否則永遠查不出來。
    L.push(`合理性檢查擋下：${state.blocked || 0} 句`
      + (state.blocked ? `　（模型跳出角色，該句只顯示英文）` : ''));
    L.push(`待送出　　：${pending.size} 句　飛行中 ${inflight} 個請求（上限 ${MAX_INFLIGHT}）`);
    L.push('');
    L.push('──── 設定 ────');
    L.push(JSON.stringify(settings));
    // 傳播延遲 = SW 快取 TTL（2 分鐘）+ 這邊的重讀間隔，最壞約 3 分鐘。
    // 只寫「每 60 秒重讀」會誤導——那 60 秒常常只是問到 SW 的快取。
    L.push(`遠端設定版本：v${configVersion}（重讀間隔 ${CONFIG_RECHECK_MS / 1000} 秒；`
      + `含後端快取，實際傳播最壞約 3 分鐘。要立即生效請用「立即重新載入設定」）`);
    L.push(`選擇器：${JSON.stringify(site && { root: site.captionRoot, label: site.captionLabel })}`);
    L.push(`授權狀態：${licensed ? '已授權' : '免費模式'}`
      + `　場次${freeSession ? '在' : '不在'}免費範圍`
      + (licensed ? '' : `　剩餘 ${Math.round(freeSecondsLeft())} 秒`)
      + `　免費層 ${freeLimitSec()} 秒`
      + `（${freeTierCfg === self.PL.BUILT_IN_CONFIG.freeTier ? '內建' : '遠端'}）`
      + `　計時方式：${state.isLive ? '直播＝累計實際觀看秒數（暫停不計）' : '重播＝以播放位置判定前 N 分鐘'}`);
    if (!licensed) {
      L.push(`　　※ 目前${signedIn ? '已登入' : '未登入＝遊客'}（${Math.round(freeLimitSec() / 60)} 分鐘）`);
      L.push('　　※ 免費模式不執行整軌預抓，只用播放器自己下載的分段（前瞻預譯）');
    }

    // ---- 提前量（LIVE-TEST ①）----
    // ⚠️ **這是這個專案最關鍵的未知數，而且到今天都還沒被量過。**
    //    有幾十秒 → 直播可以做並發去重（讓路等別人翻）
    //    接近 0   → 讓路等於放棄那一句，只能各自翻或靠賽前收割
    {
      const s = leadStats();
      L.push(s
        ? `提前量　　：VTT 抵達 → 畫面顯示　中位數 ${s.p50}ms`
          + `（p10 ${s.p10} / p90 ${s.p90} / 最短 ${s.min} / 最長 ${s.max}，${s.n} 個樣本）`
          + `　${state.isLive ? '【直播】' : '【重播】'}`
        : '提前量　　：尚未取得樣本（需要同時攔到 VTT 與畫面字幕）');
    }
    // ---- 補上官方漏掉的字幕 ----
    {
      const fs = fillStats();
      L.push('');
      L.push('──── 補上官方漏掉的字幕 ────');
      if (!fs) {
        L.push('尚無資料（需要同時攔到 VTT 與原生字幕）');
      } else {
        L.push(`原生有畫　：${fs.seen} 句`);
        L.push(`官方漏掉　：${fs.dropped} 句（${fs.rate}%）　——VTT 裡有、播放器沒畫，或短到輪詢沒抓到`);
        L.push(`我們補上　：${fs.filled} 句`);
        L.push(`時間軸基準：${fs.timeBase}`
          + (fs.timeBase === 'absolute' ? '（跨分段也能補）'
            : '（只補同一個 VTT 分段內的句子；跨分段的差值不可信）'));
        L.push('　　※ 「VTT 裡根本沒有」的那種缺漏（聽打員漏打）沒有來源，這裡量不到也補不了');
      }
    }

    // ---- 直播實測自動採樣（LIVE-TEST ②③④⑤）----
    //
    // ⚠️ **這一段是 LIVE-TEST.md 那五個數字的自動版本。**
    //    文件本身沒有錯，錯的是把它交給「直播當下要記得做」——
    //    跑了好幾場直播，五個裡面一個都沒量到。現在開著就會有。
    {
      const s5 = ltSummary();
      if (s5) {
        L.push('');
        L.push('──── 直播實測自動採樣 ────');
        L.push(`採樣時長　：開啟 ${s5.minutes} 分鐘，其中實際播放 ${s5.watchedMin} 分鐘`);
        L.push(`播放品質　：${s5.res || '未知'}`
          + `　掉幀 ${s5.dropRate === null ? '無資料' : s5.dropRate + '%'}`
          + `（${s5.dropped}/${s5.frames} 幀）`);
        L.push(`解析度變化：${s5.resChanges.length
          ? s5.resChanges.join('、')
          : '無（ABR 沒有降解析度）'}`);
        L.push(`卡頓　　　：${s5.stalls} 次，共 ${s5.stallSec} 秒`
          + `　　讓路給影片：${state.yieldCount} 次共 ${Math.round(state.yieldMs / 1000)} 秒`);
        L.push(`播放器緩衝：平均 ${s5.bufAvg === null ? '—' : s5.bufAvg + 's'}`
          + `　最低 ${s5.bufMin === null ? '—' : s5.bufMin.toFixed(1) + 's'}`);
        if (s5.dvrDepth !== null) {
          L.push(`DVR 視窗　：深度 ${s5.dvrDepth} 秒　落後直播邊緣 `
            + `${s5.behindMin}~${s5.behindMax} 秒`);
          L.push('　　　　　　（＝「延遲畫面輸出」最多可以往回多少秒，'
            + '不需要碰 MediaSource）');
        }
        if (s5.free) {
          L.push(`免費層計時：起 ${s5.free.startLeft}s → 現在 ${s5.free.lastLeft}s`
            + (s5.free.endedAt ? '　（已用完）' : ''));
        }
        if (s5.events.length) {
          L.push('採樣事件　：');
          for (const e of s5.events) L.push('　　' + e);
        }
      }
    }
    /* @test-only:start */ plTestHook('diag', L); /* @test-only:end */
    L.push(`遠端狀態：${killed ? '⛔ killSwitch 已啟用' : '正常'}`
      + `${tooOld ? '　⛔ 版本過舊，已停止翻譯' : ''}`);
    L.push('');
    L.push(`──── 事件時間軸（最近 ${Math.min(eventLog.length, 150)} 筆）────`);
    L.push(eventLog.slice(-150).join('\n'));
    L.push('');
    // 詳細日誌：逐句字幕、批次、快取命中。平常不印 Console，只在這裡給開發者看
    L.push(`──── 詳細日誌（最近 ${debugLog.length} 行）────`);
    L.push(debugLog.length ? debugLog.join('\n') : '（沒有紀錄）');
    L.push('');
    L.push('════════ 報告結束 ════════');
    return L.join('\n');
  }

  // 選項頁按「匯出診斷」時會來要這份報告
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    /* @test-only:start */
    if (msg && typeof msg.type === 'string' && /^asr/.test(msg.type)) { plTestHook('message', msg); return false; }
    /* @test-only:end */
    // 設定頁的狀態卡要知道「這個分頁現在如何」
    if (msg && msg.type === 'quickStatus') {
      sendResponse({
        ok: true,
        state: {
          everSawCaption, memo: memo.size, contentId,
          harvestSkipped: state.harvestSkipped,
          killed, tooOld, phase,
          // 免費額度要讓使用者看得到，不能只寫在診斷報告裡。
          // 「還剩多久」是他決定要不要買的唯一依據。
          licensed,
          zhLag: zhLagStats(),
          freeSession,
          freeLeft: licensed ? null : Math.round(freeSecondsLeft()),
          freeTotal: freeLimitSec(),
          signedIn,
          playing: isActuallyPlaying(),
        },
      });
      return true;
    }
    if (msg && msg.type === 'collectDiagnostics') {
      sendResponse({ ok: true, report: buildDiagnostics() });
      return true;
    }
    // 設定頁要能回答「我拉的這個時機，現在真的生效了嗎」。
    // 沒有這條路的話，提前顯示的所有前置條件（重播、校準通過）都是黑箱。
    if (msg && msg.type === 'timingStatus') {
      sendResponse({
        ok: true,
        timing: {
          text: offsetStatusText(),
          set: clampOffset(settings.subtitleOffset),
          active: activeOffsetMs(),
          isLive: !!state.isLive,
          samples: calibSamples.length,
          spread: calibSpread,
          note: calibNote,
        },
      });
      return true;
    }
    // 選項頁按「立即重新載入設定」時會打這個，不用等下一次輪詢
    if (msg && msg.type === 'applyConfigNow') {
      applyRemoteConfig(true).then((changed) => {
        sendResponse({ ok: true, changed, version: configVersion });
      });
      return true;
    }
    return false;
  });

  // =========================================================================
  // 即時狀態面板（HUD）
  //
  // 使用者的要求：「我想要有個完整的實時測試偵錯與狀態介面能夠使用，
  // 讓你我都能夠更加清楚的了解詳細情況。」
  //
  // 在此之前唯一的管道是**事後**匯出診斷。那對「直播當下這一秒發生什麼事」
  // 完全無能為力——字幕突然停了、畫面開始卡、額度快用完，
  // 全都只能等結束之後從時間軸裡回推。
  //
  // ⚠️ **預設關閉，只有在設定頁勾起來才會出現。**
  //    這塊東西蓋在 F1TV 的畫面上，而那是別人的網站。
  //    一般使用者看到的必須是乾淨的播放器（與 Console 靜音同一個道理）。
  //
  // ⚠️ **只讀不寫。** 這個面板不可以改變任何行為——
  //    它存在的目的是看清楚系統在做什麼，不是參與。
  //
  // ⚠️ **不可以用 innerHTML 塞進任何從網路來的字串。** 這裡顯示的東西包含
  //    contentId 與譯文片段，全部走 textContent。
  // =========================================================================
  const HUD_ID = 'pitlingo-hud';
  let hudEl = null;
  let hudTimer = null;
  let hudMin = false;                 // 收合成一行
  let hudDragOff = null;              // 上一組拖曳監聽的解除函式

  function hudBuild() {
    // ⚠️ **用 `isConnected`，不可以用 `document.body.contains(hudEl)`。**
    //    面板掛在 `documentElement` 底下（要蓋過播放器，不能被 body 的
    //    overflow 或 transform 夾住），而那是 body 的**兄弟節點**——
    //    `body.contains()` 永遠回 false，於是每秒重畫都會再 append 一個新的，
    //    三小時的直播結束時 DOM 裡有上萬個面板疊在一起。
    //    煙霧測試抓到的就是這個（面板內容一直是空的，因為畫在新的那一個上）。
    if (hudEl && hudEl.isConnected) return hudEl;
    const el = document.createElement('div');
    el.id = HUD_ID;
    // ⚠️ z-index 要高過 F1TV 的播放器控制列，但**不要用 2147483647**——
    //    那會蓋掉瀏覽器自己的 UI（例如全螢幕提示），而且沒有必要。
    el.style.cssText = [
      'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483000',
      'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'color:#e8f0ff', 'background:rgba(8,12,20,.88)', 'backdrop-filter:blur(6px)',
      'border:1px solid rgba(120,160,255,.35)', 'border-radius:10px',
      'padding:8px 10px', 'min-width:300px', 'max-width:min(380px,44vw)',
      'box-shadow:0 8px 28px rgba(0,0,0,.45)', 'white-space:pre',
      'pointer-events:auto', 'user-select:text',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:4px;cursor:move';
    const title = document.createElement('b');
    title.textContent = 'PitLingo';
    title.style.cssText = 'color:#8ab4ff;letter-spacing:.5px';
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1';
    const btnMin = document.createElement('button');
    const btnClose = document.createElement('button');
    for (const b of [btnMin, btnClose]) {
      b.type = 'button';
      b.style.cssText = 'all:unset;cursor:pointer;padding:0 5px;color:#9fb4d8;font:inherit';
    }
    btnMin.textContent = '—'; btnMin.title = '收合';
    // ⚠️ 設定頁**沒有**這個開關（刻意的，見 __pitlingo.hud 的說明）。
    //    以前寫「設定頁可再打開」，而且關閉只關記憶體——改任何一個設定它又跳回來。
    btnClose.textContent = '×';
    btnClose.title = '關閉（要再打開：F12 → Console 左上角把 top 切到 PitLingo → __pitlingo.hud(true)）';
    btnMin.onclick = () => { hudMin = !hudMin; hudPaint(); };
    btnClose.onclick = () => {
      hudSet(false);
      settings = sanitizeSettings(Object.assign({}, settings, { hud: false }));
      try { chrome.storage.local.set({ settings }); } catch (e) { /* 分頁正在關閉 */ }
    };
    head.append(title, spacer, btnMin, btnClose);

    const body = document.createElement('div');
    body.className = 'plHudBody';

    // 拖曳。**位置只記在記憶體裡**——存起來的話，換一台螢幕尺寸就會
    // 跑到畫面外，而使用者不知道要怎麼把它找回來。
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      drag = { x: e.clientX, y: e.clientY, r: el.getBoundingClientRect() };
      e.preventDefault();
    });
    const onMove = (e) => {
      if (!drag) return;
      const top = Math.max(0, Math.min(window.innerHeight - 40, drag.r.top + (e.clientY - drag.y)));
      const left = Math.max(0, Math.min(window.innerWidth - 60, drag.r.left + (e.clientX - drag.x)));
      el.style.top = top + 'px'; el.style.left = left + 'px'; el.style.right = 'auto';
    };
    // ⚠️ 監聽要掛在 window 上，不是 head 上——滑鼠移出面板時還要跟得住。
    //    每次重建面板就換掉上一組，不要一直疊加（開關十次＝十組監聽）。
    if (hudDragOff) hudDragOff();
    const onUp = () => { drag = null; };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    hudDragOff = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    };

    el.append(head, body);
    document.documentElement.appendChild(el);
    hudEl = el;
    return el;
  }

  /** 秒數 → M:SS。負數與 NaN 一律回 '—'，不要在面板上印 NaN。 */
  function hudMs(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 0) return '—';
    const m = Math.floor(n / 60);
    return m + ':' + String(Math.floor(n % 60)).padStart(2, '0');
  }

  function hudPaint() {
    if (!hudOn) return;
    const el = hudBuild();
    const body = el.querySelector('.plHudBody');
    if (!body) return;

    if (hudMin) { body.textContent = phase; return; }

    const L = [];
    const pad = (s) => String(s).padEnd(6, '　').slice(0, 6);
    const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');

    // 直播看不到「總長」，重播才有播放位置可以顯示
    {
      const v = document.querySelector('video');
      const watched = fmtClock(watchMs / 1000);
      const opened = liveTest.startedAt ? fmtClock((Date.now() - liveTest.startedAt) / 1000) : '—';
      if (state.isLive) {
        L.push(`${pad('狀態')}直播　已播放 ${watched}（開啟 ${opened}）　${phase}`);
      } else {
        const pos = v && Number.isFinite(v.currentTime) ? fmtClock(v.currentTime) : '—';
        const dur = v && Number.isFinite(v.duration) ? fmtClock(v.duration) : '—';
        L.push(`${pad('狀態')}重播　位置 ${pos} / ${dur}　已播放 ${watched}　${phase}`);
      }
    }

    // 補字幕：**官方漏掉的，我們補上**
    {
      const fs = fillStats();
      if (fs) {
        L.push(`${pad('補字幕')}官方漏 ${fs.dropped} 句（${fs.rate}%）　已補 ${fs.filled} 句`
          + `　時間軸 ${fs.timeBase === 'absolute' ? '絕對' : fs.timeBase === 'relative' ? '分段相對' : '判定中'}`);
      }
    }

    // ① 提前量：**這個面板最重要的一行。**
    const ls = leadStats();
    L.push(`${pad('提前量')}${ls
      ? `p50 ${(ls.p50 / 1000).toFixed(1)}s　(p10 ${(ls.p10 / 1000).toFixed(1)} / `
        + `p90 ${(ls.p90 / 1000).toFixed(1)}, n=${ls.n})`
      : '尚未取得樣本'}`);

    const done = state.hits + state.translated;
    L.push(`${pad('字幕')}命中 ${pct(state.hits, done)}　已譯 ${state.translated}`
      + `　待譯 ${pending.size}　飛行 ${inflight}`);
    L.push(`${pad('')}錯誤 ${state.errors}　放棄 ${state.dropped}`
      + `　擋下 ${state.blocked}　缺漏 ${state.gaps}`);

    const b = batchStats[batchStats.length - 1];
    L.push(`${pad('批次')}${b ? `${b.got}/${b.sent} 句　${b.ms}ms　（共 ${batchStats.length} 批）`
      : '尚未送出'}`);

    {
      const z = zhLagStats();
      L.push(`${pad('中文落後')}${z
        ? `p50 ${(z.p50 / 1000).toFixed(2)}s　p90 ${(z.p90 / 1000).toFixed(2)}s`
          + `　>0.5s ${z.late} 句　沒跟上 ${z.never} 句（n=${z.n}）`
          + (z.p50 > 500 ? '　⚠ 超過判準' : '')
        : '尚未取得樣本'}`);
    }

    const s5 = ltSummary();
    L.push(`${pad('畫面')}${liveTest.q.res || '—'}`
      + `　掉幀 ${s5 && s5.dropRate !== null ? s5.dropRate + '%' : '—'}`
      + `　緩衝 ${(() => { const x = bufferAheadSec(); return x === null ? '—' : x.toFixed(1) + 's'; })()}`);
    L.push(`${pad('')}卡頓 ${liveTest.q.stalls} 次／${Math.round(liveTest.q.stallSec)}s`
      + `　讓路 ${state.yieldCount} 次／${Math.round(state.yieldMs / 1000)}s`);

    if (liveTest.dvr.n) {
      L.push(`${pad('DVR')}深度 ${liveTest.dvr.maxDepth}s`
        + `　落後 ${liveTest.dvr.minBehind}~${liveTest.dvr.maxBehind}s`
        + '　（延遲畫面的預算）');
    }

    L.push(`${pad('額度')}${licensed ? '已授權'
      : `今日免費剩 ${hudMs(freeSecondsLeft())}　${signedIn ? '已登入（15 分鐘/天）' : '遊客（5 分鐘/天）'}`}`);

    if (liveTest.events.length) {
      L.push(`${pad('事件')}${liveTest.events[liveTest.events.length - 1]}`);
    }

    /* @test-only:start */ plTestHook('hud', L); /* @test-only:end */
    body.textContent = L.join('\n');
  }

  function hudSet(on) {
    hudOn = !!on;
    if (hudOn) {
      hudBuild();
      hudPaint();
      // 1 秒一次。**不要更快**——這塊東西畫在影片上面，
      // 重畫太頻繁會跟播放器搶主執行緒，那就違反了「只讀不寫」。
      if (!hudTimer) hudTimer = setInterval(hudPaint, 1000);
    } else {
      if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
      const el = document.getElementById(HUD_ID);
      if (el) el.remove();
      hudEl = null;
    }
    return hudOn;
  }

  // 給偵錯用：在 Console 打 window.__pitlingo 可以看目前狀態
  // =========================================================================
  // 測試工具
  //
  // ⚠️ 下面的測試工具包在 test-only 標記裡，**正式版建置時自動移除**
  //    （tools/build-extension.js，--check 會證明正式版一行都沒有）。不必再手動刪。
  //
  // 保留哪些、移除哪些的原則：
  //   保留 — diag / events / state / peek / debug / hud / live：回報問題的管道，正式版必須留著
  //   移除 — 測試工具與語音辨識：會繞過防護（強制預抓）、洩漏內部狀態、或只有開發時有用
  // =========================================================================
  /* @admin-only:start */
  // =========================================================================
  // 管理版的收割（handoff 9.1 #26 第 3 階段；**正式版與測試版建置時整段移除**）
  //
  // 佇列、全季收割、提示條、狀態面板寫在 src/admin/harvest.js，只有管理版 manifest 會注入。
  // 這裡只做兩件主程式才做得到的事：蓋可信的完整標記、把收割進度交出去。
  // =========================================================================
  const STAMP_BLOCK_TOL = 0.02;       // 沒有譯文的句子（多半是守門擋下）容許的比例，與 userscript 相同
  const STAMP_SETTLE_MAX_MS = 10 * 60000;

  /** 這支影片還有幾句沒有譯文（守門擋下＋沒拿到結果的都算） */
  function harvestMissing() {
    let n = 0;
    for (const k of sessionKeys) if (!memo.has(k)) n++;
    return n;
  }
  const harvestSettled = () => !harvestInFlight && pending.size === 0 && inflight === 0;

  /**
   * 等翻譯真的結束，再用收割權杖蓋章（POST /v1/subs，譯文＋分段數一起寫）。
   *
   * ⚠️ 不可以分段一抓完就蓋（userscript 坑：荷蘭站「已標記完整」時還有 1,500 句在翻）。
   * ⚠️ 有句子重試後仍放棄、或沒譯文的超過容許比例，就**不蓋章**——
   *    已經翻好的仍在後端緩衝裡，只是這支不算完整，佇列會記成失敗讓人重跑（鐵則 37、38）。
   * ⚠️ 等待有上限（鐵則 3）。
   */
  function harvestStampWhenSettled(cid, segCount, myGen) {
    Object.assign(harvestStamp, { cid, state: 'waiting', note: '等翻譯結束', segCount });
    const t0 = Date.now();
    const tick = async () => {
      if (myGen !== harvestGen || cid !== contentId) { harvestStamp.state = 'aborted'; return; }
      if (!harvestSettled()) {
        if (Date.now() - t0 > STAMP_SETTLE_MAX_MS) {
          Object.assign(harvestStamp, { state: 'failed', note: '翻譯 10 分鐘仍未結束' });
          evWarn('🚜 收割：翻譯 10 分鐘仍未結束，這支不蓋完整標記');
          return;
        }
        setTimeout(tick, 3000);
        return;
      }
      const missing = harvestMissing();
      const tol = Math.max(20, Math.floor(sessionKeys.size * STAMP_BLOCK_TOL));
      if (state.dropped || missing > tol) {
        Object.assign(harvestStamp, { state: 'incomplete', note: `${missing} 句沒有譯文、${state.dropped} 句放棄` });
        evWarn(`🚜 收割不完整（${harvestStamp.note}），不蓋完整標記；已翻的部分仍在共用快取`);
        return;
      }
      const lines = {};
      for (const k of sessionKeys) { const zh = memo.get(k); if (zh) lines[k] = zh; }
      const times = {};
      for (const k of Object.keys(lines)) { const sec = harvestTimes.get(k); if (sec !== undefined) times[k] = Math.round(sec * 10) / 10; }
      for (let i = 1; i <= 3; i++) {
        const res = await send({
          type: 'harvestStamp', cid, lines, times, segCount, slug: location.pathname,
          v: 'ext-' + EXT_VERSION,
        });
        const r = (res.ok && res.result) || {};
        if (myGen !== harvestGen) { harvestStamp.state = 'aborted'; return; }
        if (r.ok && r.segCount >= segCount) {
          Object.assign(harvestStamp, { state: 'ok', note: `後端 ${r.total} 句（本次新增 ${r.added}、擋下 ${r.rejected}、時間軸 ${r.timed || 0} 句）` });
          evOk(`🚜 ✅ 已蓋完整標記：${segCount} 段／${harvestStamp.note}`);
          return;
        }
        harvestStamp.note = r.error || r.reason || '(未知)';
        // 401 重試也沒用（權杖錯了）
        if (r.status === 401) break;
        await new Promise((ok) => setTimeout(ok, 5000 * i));
      }
      harvestStamp.state = 'failed';
      evWarn(`🚜 完整標記送不出去：${harvestStamp.note}`);
    };
    setTimeout(tick, 3000);
  }

  /**
   * 🎯 重收目前這一支（＝userscript 的「立即整軌預抓」）：後端說已完整也照樣整軌抓一次、翻完重新蓋章。
   * 用在「懷疑這支的快取缺句」——可疑標記、使用者回報某段沒字幕。已翻過的句子從共用快取拿，不重付。
   */
  function forceHarvest() {
    if (!harvestOn) return '沒有收割權杖';
    if (!contentId) return '這一頁沒有影片';
    if (harvestInFlight) return '這一支正在收割中';
    state.harvestSkipped = false; harvestBundleComplete = false;
    state.segFetched = 0; state.segFailed = 0; state.dropped = 0; state.harvestDone = false;
    seenSegments.clear();
    Object.assign(harvestStamp, { cid: '', state: '', note: '' });
    evInfo('🎯 重收這一支（略過「已完整」判斷）');
    startPrefetch(contentId, 0, true);
    return '';
  }

  /** 收割佇列接手這一頁：切到全速。已經在抓的那一輪也立刻加開 worker。 */
  function harvestFastPace() {
    if (!harvestOn || harvestFast) return;
    harvestFast = true;
    evInfo(`🚜 收割佇列接手：抓取改為 ${HARVEST_FETCH_CONCURRENCY} 條並行、間隔 ${HARVEST_FETCH_GAP_MS}ms，不讓路給影片`);
    if (fetchBoost) fetchBoost();
  }

  // ---- 前導收割模式（管理版，2026-10-24 從測試版移過來）----
  // Ray 的電腦開管理版看直播：這個分頁貼直播邊緣、不延遲、批次等 leaderWinMs、每 30 秒送心跳。
  // 其他觀眾延遲 45 秒，他們的句子到的時候，這裡翻好的早就在 SubtitleRoom 裡了。
  // **預設開**——以前要在 Console 打指令，R18 FP2 開場就因為少打／打錯讓觀眾自己翻了一段。
  // 心跳與翻譯都帶收割權杖（sw.js HARVEST_PATHS）：不靠授權碼，成本記在 'harvest'。
  noLiveDelay = true;
  var leaderBeatCid = null;   // 最近一次送過心跳的 cid（var：checkContentChange／pagehide 在上面就用到）
  async function leaderLoad() {
    try {
      const o = (await chrome.storage.local.get('plLeader')).plLeader || {};
      // 沒有收割權杖的管理版不翻譯（sw.js api() 擋下），當然也不算前導端
      leaderMode = harvestOn && o.on !== false;
      if (Number(o.win) >= 5 && Number(o.win) <= 50) leaderWinMs = Number(o.win) * 1000;
    } catch (e) { leaderMode = harvestOn; }
    if (!leaderMode && leaderBeatCid) leaderBye(leaderBeatCid);
    applyLiveDelay();
    evInfo(!harvestOn ? '🎯 前導收割模式：關（沒有收割權杖）'
      : leaderMode ? `🎯 前導收割模式：開（不延遲畫面、直播批次等 ${leaderWinMs / 1000} 秒、每 30 秒送心跳）`
        : '🎯 前導收割模式：關（__pitlingo.leader(true) 打開）');
  }
  function leaderStatus() {
    const d = liveDelay.status();
    return { leaderMode, windowSec: leaderWinMs / 1000, live: !!state.isLive, delayEnabled: d.enabled, delayActive: d.active, leaderSeen };
  }
  setInterval(() => {
    if (leaderMode && state.isLive && contentId) { send({ type: 'leaderBeat', cid: contentId }); leaderBeatCid = contentId; }
  }, 30000);
  // 前導端**主動**離開（關分頁、換影片、關掉前導模式）時告訴後端（2026-10-24，R18 FP2）：
  // 場次結束 Ray 先關 A、B 還開著，後端兩分鐘後就寄「前導端不在」——那是 Ray 自己關的，不是故障。
  // 當機、斷網、電腦睡著不會送這一聲，所以那些情況照樣告警。
  function leaderBye(cid) {
    leaderBeatCid = null;
    send({ type: 'leaderBeat', cid, bye: true });
    evInfo(`🎯 前導端離開 cid ${cid}（已通知後端，不發告警）`);
  }

  // 直播結束 → 回 F1TV 首頁等下一場（2026-10-25 Ray，R18 FP3）。
  // F1TV 在直播結束後會顯示「Starts in N ✕」倒數，然後**自己播下一支推薦影片**（FP3 播了 F1A 精華）。
  // 管理版會把那一支當成新影片去收割（用收割權杖、算收割成本），A 的 FP3 診斷也被換掉了。
  // 兩道：①看到倒數、影片已經不在播 → 直接回首頁（倒數根本不讓它跑完）；
  //       ②倒數的字樣哪天改了：前導中的那一支換成別支、而且最近沒有人按過鍵盤滑鼠 → 一樣回首頁。
  // ⚠️ 只在「剛才還是前導端」的那一頁生效：自己點別支（有真的點擊）、收割佇列換頁（整頁導覽，prev 是空的）都不受影響。
  // ⚠️ 倒數判斷要加「影片沒在播」：直播中頁面上可能有別的「Starts in」（例如下一場的預告卡），不可以把前導端踢出直播。
  // var：checkContentChange 在上面就會呼叫 userActedRecently（與 leaderBeatCid 同理，避免 TDZ）
  var F1TV_HOME = 'https://f1tv.formula1.com/';
  var USER_ACT_MS = 8000;
  var lastUserActAt = 0;
  var wentHome = false;
  /** 前導端直播中拿不到影片編號多久就重新整理（見 flushPending） */
  var LEADER_NOCID_RELOAD_MS = 120000;
  var LEADER_NOCID_RELOAD_MAX = 2;
  function leaderNoCidReload() {
    let n = 0;
    try { n = Number(sessionStorage.getItem('plNoCidReload')) || 0; } catch (e) { /* noop */ }
    if (n >= LEADER_NOCID_RELOAD_MAX) {
      if (!state.noCidGaveUp) { state.noCidGaveUp = true; evErr(`🎯 前導端重新整理 ${n} 次仍拿不到影片編號，停止重試（這一頁不翻譯）`); }
      return;
    }
    try { sessionStorage.setItem('plNoCidReload', String(n + 1)); } catch (e) { /* noop */ }
    evErr(`🎯 前導端 ${Math.round(LEADER_NOCID_RELOAD_MS / 60000)} 分鐘拿不到影片編號 → 送診斷後重新整理（第 ${n + 1} 次）`);
    leaderFinalDiag('拿不到影片編號，重新整理前').then(() => location.reload());
  }
  /** 前導端離開一頁之前送一份自動診斷（R18 排位：分頁跳走後收割端的紀錄全部消失，報告沒送到）。最多等 4 秒 */
  function leaderFinalDiag(why) {
    return Promise.race([
      sendAutoDiag(why),
      new Promise((r) => setTimeout(r, 4000)),
    ]).catch(() => {});
  }
  var countdownSeen = 0;   // 連續看到倒數的秒數：直播短暫卡頓＋頁面剛好有別的倒數卡，不可以一次就踢出直播
  for (const t of ['pointerdown', 'keydown']) {
    window.addEventListener(t, (e) => { if (e.isTrusted) lastUserActAt = Date.now(); }, true);
  }
  function userActedRecently() { return Date.now() - lastUserActAt < USER_ACT_MS; }
  function leaderGoHome(why) {
    if (wentHome) return;
    wentHome = true;
    // 自動開直播（harvest.js autoLive）回到首頁後不可以又點回這一場的重播
    const ended = leaderBeatCid || contentId;
    if (ended) {
      try {
        chrome.storage.local.get('plAutoLiveEnded', (o) => {
          const list = ((o && o.plAutoLiveEnded) || []).filter((x) => x !== String(ended)).slice(-20);
          chrome.storage.local.set({ plAutoLiveEnded: list.concat(String(ended)) });
        });
      } catch (e) { /* 只是少一筆紀錄：autoLive 另外用「只在場次時間內」擋 */ }
    }
    if (leaderBeatCid) leaderBye(leaderBeatCid);
    evInfo(`🏁 ${why} → 回 F1TV 首頁等下一場`);
    // 離開前先送一份診斷：換頁之後這一頁的時間軸就沒了
    leaderFinalDiag('前導端離開這一場：' + why).then(() => location.assign(F1TV_HOME));
  }
  function autoplayCountdownShown() {
    for (const el of document.querySelectorAll('button, a, div, span')) {
      if (el.children.length > 3) continue;   // 只看小元素：大容器的 textContent 會把整頁的字都算進來
      if (/^\s*Starts in\s*\d+\s*$/i.test(el.textContent || '')) return true;
    }
    return false;
  }
  function leaderAutoplayCheck() {
    if (!leaderBeatCid || wentHome || isActuallyPlaying()) { countdownSeen = 0; return; }
    countdownSeen = autoplayCountdownShown() ? countdownSeen + 1 : 0;
    if (countdownSeen >= 3) leaderGoHome('直播結束，F1TV 開始倒數自動播下一支');
  }
  setInterval(leaderAutoplayCheck, 1000);

  window.__plAdmin = {
    forceHarvest,
    fastPace: harvestFastPace,
    // 正式場次優先（harvest.js alPreferMain）離開節目時走同一條路：記成播完、送 bye、送最後一份診斷
    goHome: (why) => leaderGoHome(why),
    snapshot: () => ({
      cid: contentId, phase, harvestOn, isLive: !!state.isLive,
      playlistSegs: state.playlistSegs, segFetched: state.segFetched, segFailed: state.segFailed,
      harvestInFlight, harvestSkipped: state.harvestSkipped, harvestDone: state.harvestDone,
      bundleComplete: harvestBundleComplete,
      wanted: sessionKeys.size, missing: harvestMissing(), pending: pending.size, inflight,
      dropped: state.dropped, blocked: state.blocked, errors: state.errors, translated: state.translated,
      stamp: Object.assign({}, harvestStamp),
      // 'none'＝攔到 master 而且裡面沒有字幕軌（真的沒字幕）；'unknown'＝連 master 都沒看到（播放器沒起來）
      subTrack: subtitleTrackVerdict(),
    }),
    // 後台「即時狀態」看收割端（2026-10-30 Ray：「管理面板上有的都要有，也要有收割端目前在直播的幾分幾秒」）。
    // 播放位置讀進度條（鐵則 63：直播的 video.currentTime 是假象）；凍住（A12）時進度條不動，另附影片時間
    live: () => {
      const v = document.querySelector('video');
      const sb = document.querySelector('.tm-ui-seekbar');
      const num = (a) => { const n = sb ? Number(sb.getAttribute(a)) : NaN; return Number.isFinite(n) && n >= 0 ? n : null; };
      const ld = liveDelay.status();
      return {
        autoLive: adminAutoLive, leaderMode, leaderBeat: !!leaderBeatCid, leaderSeen,
        raf: adminRafRate, vis: document.visibilityState,
        win: [window.screenX, window.screenY, window.outerWidth, window.outerHeight],
        video: v ? { paused: !!v.paused, t: Math.round(v.currentTime * 10) / 10 } : null,
        seek: { now: num('aria-valuenow'), max: num('aria-valuemax') },
        behind: ld.behind === undefined ? null : ld.behind, frozen: !!ld.frozen, frozenTimes: ld.frozenTimes || 0,
        caption: String(collectCaption() || '').slice(0, 200),
      };
    },
  };
  /* @admin-only:end */

  /* @test-only:start */
  // =========================================================================
  // 測試版的掛鉤（**正式版建置時整段移除**，tools/build-extension.js）
  //
  // 語音辨識字幕等測試功能寫在 src/test/ 的獨立檔案裡，只有測試版 manifest 會注入。
  // 它們透過這裡拿到輪詢、原生字幕、診斷報告、HUD 與訊息——主程式不必知道它們的存在。
  // ⚠️ 掛鉤裡的例外一律吞掉：測試功能壞掉不可以拖垮字幕本身。
  // =========================================================================
  window.__plTest = {
    poll: [], native: [], diag: [], hud: [], message: [],
    api: {
      subtitleTrackVerdict: () => subtitleTrackVerdict(),
      mainVideoRect: () => mainVideoRect(),
      isLive: () => !!state.isLive,
      contentId: () => contentId,
    },
  };
  function plTestHook(kind, arg) {
    const list = window.__plTest && window.__plTest[kind];
    if (!list) return;
    for (const fn of list) { try { fn(arg); } catch (e) { /* 測試功能壞掉不影響主程式 */ } }
  }

  const TESTING = {
    // ---- 強制觸發 ----
    prefetch: () => startPrefetch(contentId, 0, true),   // 強制重抓整支，繞過跳過判斷
    reloadConfig: () => applyRemoteConfig(true),          // 立刻重讀遠端設定，不等 60 秒
    markComplete: () => send({ type: 'markComplete', cid: contentId, segCount: state.playlistSegs }),
    refreshBundle: async () => {
      const r = await send({ type: 'getBundle', cid: contentId, force: true });
      const b = (r.ok && r.bundle) || {};
      console.log(`後端：${Object.keys(b.lines || {}).length} 句，segCount ${b.segCount || 0}`);
      return b;
    },

    // ---- 內部狀態 ----
    detect: () => detect,                 // 偵測來源統計（observer vs 輪詢）
    batches: () => batchStats,            // 每個批次的句數與耗時
    manifests: () => manifests.map((m) => ({ url: m.url, bytes: m.bytes, held: !!m.body })),
    memo: () => memo,
    pending: () => Array.from(pending.values()),
    settings: () => settings,
    site: () => site,

    // ---- 模擬 ----
    // 假裝畫面出現這句字幕，用來單獨測翻譯與顯示路徑，不用等影片播到
    feed: (en) => { handleCaption(String(en || '')); return '已送入：' + en; },
    // 假裝分頁被節流過，驗證停擺偵測會不會正確重掛
    stall: () => { lastPollAt = Date.now() - STALL_MS - 1000; return checkPollStall(); },

    // ---- 延遲畫面的可行性探針（使用者要求，獨立於正常播放路徑）----
    //
    // ⚠️ **結論先寫在這裡：要延遲畫面，不需要碰 MediaSource。**
    //
    //    使用者的想法是「稍微延緩畫面輸出，讓譯文趕得上」。方向是對的，
    //    但直接動 MediaSource 是坑 #8 明令禁止的——那是影片本身，
    //    弄壞的後果是整支影片播不出來，而且很難查。
    //
    //    直播有 DVR 視窗（F1TV 的直播可以往回拉）。只要把播放頭往回移 N 秒，
    //    畫面就是 N 秒前的內容——**這正是「延遲畫面輸出」，而且完全不碰
    //    MediaSource，只用標準的 `video.currentTime`。**
    //
    //    `dvr()` 先回答「有沒有可以往回的空間」，`delay(n)` 才真的動。
    //    ⚠️ 兩支都只是**探針**，不接進正常播放路徑；確認可行之前不要自動化。
    dvr: () => {
      const v = document.querySelector('video');
      if (!v) return { error: '找不到 video 元素' };
      const r = (tr) => Array.from({ length: tr.length }, (_, i) => [+tr.start(i).toFixed(2), +tr.end(i).toFixed(2)]);
      const seek = r(v.seekable);
      const live = seek.length ? seek[seek.length - 1][1] : null;
      const head = seek.length ? seek[0][0] : null;
      return {
        isLive: state.isLive,
        currentTime: +v.currentTime.toFixed(2),
        seekable: seek,
        buffered: r(v.buffered),
        // 可以往回多少秒＝延遲畫面的預算上限
        dvrDepthSec: (live !== null && head !== null) ? +(live - head).toFixed(1) : null,
        behindLiveSec: live !== null ? +(live - v.currentTime).toFixed(1) : null,
        playbackRate: v.playbackRate,
        paused: v.paused,
        readyState: v.readyState,
      };
    },

    delay: (sec) => {
      const n = Math.max(1, Math.min(60, Number(sec) || 10));
      const v = document.querySelector('video');
      if (!v) return { error: '找不到 video 元素' };
      const before = v.currentTime;
      const seek = v.seekable;
      const head = seek.length ? seek.start(0) : 0;
      const target = before - n;
      if (target < head + 1) {
        return { error: `往回 ${n} 秒會超出 DVR 視窗（最早只能到 ${head.toFixed(1)}）`, before, head };
      }
      v.currentTime = target;
      // 回報**之後**的狀態要等一下，seek 不是同步完成的。
      return new Promise((resolve) => setTimeout(() => resolve({
        requested: n,
        before: +before.toFixed(2),
        after: +v.currentTime.toFixed(2),
        actuallyMoved: +(before - v.currentTime).toFixed(2),
        paused: v.paused,
        readyState: v.readyState,
        note: '若 readyState >= 3 且 paused=false，代表往回拉之後仍然正常播放',
      }), 1500));
    },

    delayStatus: () => liveDelay.status(),
    help: () => {
      console.log([
        '【正式版保留】',
        '  __pitlingo.diag()            匯出完整診斷（回報問題用這個）',
        '  __pitlingo.autoDiag(10)      每 10 分鐘自動送一份診斷（0 關閉；不帶參數＝查狀態）',
        '  __pitlingo.events()          事件時間軸',
        '  __pitlingo.state             目前狀態',
        '  __pitlingo.peek()            現在畫面上抓到什麼英文',
        '  __pitlingo.debug(true)       開關詳細日誌',
        '  __pitlingo.hud(true)         即時狀態面板（設定頁也可以勾）',
        '  __pitlingo.live()            這一場自動量到的數字（提前量／掉幀／DVR／卡頓）',
        '',
        '【上線前移除 —— __pitlingo.t.*】',
        '  t.prefetch()                 強制重抓整支（繞過跳過判斷）',
        '  t.reloadConfig()             立刻重讀遠端設定',
        '  t.markComplete()             手動標記完整收割',
        '  t.refreshBundle()            強制重讀後端 bundle 並印出句數與 segCount',
        '  t.detect()                   偵測來源統計',
        '  t.batches()                  每個批次的句數與耗時',
        '  t.manifests()                攔到的 manifest 清單',
        '  t.memo() / t.pending()       本機快取 / 待翻佇列',
        '  t.feed("Box box box")        假裝畫面出現這句，測翻譯與顯示',
        '  t.stall()                    假裝被節流，測停擺偵測',
        '  t.dvr()                      直播可以往回拉多少秒（延遲畫面的預算）',
        '  t.delay(10)                  把畫面往回拉 10 秒，看還能不能正常播',
      ].join('\n'));
      return '見上方';
    },
  };
  /* @test-only:end */

  window.__pitlingo = {
    // ---- 正式版也要保留 ----
    diag: () => { const r = buildDiagnostics(); console.log(r); return r; },
    // 每 N 分鐘自動送一份診斷（0 關閉）。**預設關閉**，量測直播時才開。
    // 不帶參數只回報狀態（**不會改狀態**）；autoDiag(10) 開、autoDiag(0) 關。
    autoDiag: (min) => {
      const s = min === undefined ? autoDiagStatus() : autoDiagSet(min);
      console.log('[PitLingo] ' + s);
      return s;
    },
    events: () => { console.log(eventLog.join('\n')); return eventLog.length; },
    peek: () => collectCaption(),
    /* @test-only:start */
    // 詳細日誌印到 Console。**只在測試版**（2026-09-17 使用者決定）；正式版的詳細日誌只進診斷報告
    debug: (on) => { debugOn = on !== false; console.log('[PitLingo] 詳細日誌：' + (debugOn ? '開啟' : '關閉')); return debugOn; },
    /* @test-only:end */
    // 即時狀態面板。**正式版也保留**——它與 diag() 同一類：
    // 回報問題時「現在畫面上是什麼狀況」比事後的時間軸好用太多。
    //
    // ⚠️ **刻意不放進設定頁。** 設定頁是一般使用者看的，
    //    「詳細日誌」當初就是為了同一個理由拿掉的（見 options.js 的說明）。
    //
    // ⚠️ **但會寫回 storage。** 只在記憶體裡開的話，每一場直播都要重打一次——
    //    而「每次都忘記」正是這整套東西要解決的問題。
    //    打一次 `__pitlingo.hud(true)`，之後每一場都有。
    hud: (on) => {
      const v = hudSet(on !== false);
      settings = sanitizeSettings(Object.assign({}, settings, { hud: v }));
      try { chrome.storage.local.set({ settings }); } catch (e) { /* 分頁正在關閉 */ }
      return v;
    },
    /* @admin-only:start */
    // 前導收割模式（管理版，預設開）。**不帶參數只回狀態、不改設定**——
    // 測試版時代 leader() 不帶參數＝關閉，R18 FP2 就這樣被關掉過（LIVE-TEST.md R18）。
    // leader(true) 開、leader(true, 20) 指定批次秒數（5～50）、leader(false) 關。存在本機，重新整理後仍然有效
    leader: async (on, win) => {
      if (on !== undefined) {
        await chrome.storage.local.set({ plLeader: { on: !!on, win: Number(win) || leaderWinMs / 1000 } });
        await leaderLoad();
      }
      const s = leaderStatus();
      console.log('[PitLingo] 前導收割模式：' + (s.leaderMode ? `開（批次 ${s.windowSec} 秒）` : '關') + '　延遲畫面：' + (s.delayEnabled ? '開' : '關'));
      return s;
    },
    /* @admin-only:end */
    /* @test-only:start */
    // 這一場到目前為止量到的直播數字。**只在測試版**（2026-09-17 使用者決定）；
    // 正式版照常量，數字放在診斷報告的「直播實測自動採樣」
    live: () => { const s = ltSummary(); console.log(s); return s; },
    /* @test-only:end */
    get state() {
      return Object.assign({
        contentId, memo: memo.size, pending: pending.size,
        requested: requested.size, inflight, everSawCaption,
      }, state);
    },

    // ---- 測試工具：只在測試版存在（正式版建置時移除）----
    /* @test-only:start */
    t: TESTING,
    help: TESTING.help,
    /* @test-only:end */
  };
  // ⚠️ __pitlingo 在擴充功能的隔離環境裡。Console 預設是頁面環境（top），直接打會是 not defined——
  //    要先把 Console 左上角的 top 切到 PitLingo。
  /* @test-only:start */
  evInfo('測試版：F12 → Console 左上角把 top 切到 PitLingo，再打 `__pitlingo.help()` 看可用指令');
  /* @test-only:end */

  /* @test-only:start */
  // =========================================================================
  // 目錄頁的翻譯覆蓋標記（handoff 9.1 #18，2026-10-06）
  //
  // F1TV 的影片卡片上標「完整繁中／部分繁中／無官方字幕」，讓使用者點進去之前就知道。
  // 資料來自 /v1/coverage（後端從共用快取的摘要算，每個機房快取 30 分鐘）。
  // 沒有標記＝還沒有人看過，看的時候即時翻——那不是壞事，所以不標。
  //
  // ⚠️ **測試版功能**：進正式版前要問過 Ray（工作規則 7）。
  // ⚠️ 用輪詢不用 MutationObserver 當主力（鐵則 4：SPA 會重建 DOM），而且輪詢有上限（鐵則 3）。
  // ⚠️ 只加一個小標籤、不改卡片的版面；讀網址用 getAttribute，不碰任何文字內容。
  // =========================================================================
  const COV_LABEL = {
    ready: ['完整繁中', '#1f9d55'],
    partial: ['部分繁中', '#b7791f'],
    nosub: ['無官方字幕', '#6b7280'],
  };
  const covAsked = new Set();       // 問過的 cid：問過就不再問（不論有沒有結果）
  const covMap = new Map();
  let covBusy = false;
  let covRounds = 0;
  const COV_MAX_ROUNDS = 2000;      // 每 3 秒一輪，約 100 分鐘後停
  const COV_MAX_CIDS = 1500;        // 一個分頁最多問這麼多支

  function covCidOf(a) {
    const m = String(a.getAttribute('href') || '').match(/\/detail\/(\d{1,20})(?:[/?#]|$)/);
    return m ? m[1] : '';
  }

  function covPaint(a, st) {
    const lab = COV_LABEL[st];
    if (!lab || a.querySelector(':scope > .pl-cov')) return;
    const b = document.createElement('span');
    b.className = 'pl-cov';
    b.textContent = lab[0];
    b.style.cssText = 'position:absolute;top:6px;left:6px;z-index:5;padding:2px 6px;border-radius:4px;'
      + 'font:600 11px/1.4 system-ui,sans-serif;color:#fff;pointer-events:none;opacity:.92;background:' + lab[1];
    try { if (getComputedStyle(a).position === 'static') a.style.position = 'relative'; } catch (e) { /* noop */ }
    a.appendChild(b);
  }

  async function covScan() {
    if (covBusy || ++covRounds > COV_MAX_ROUNDS) return;
    covBusy = true;
    try {
      const anchors = [...document.querySelectorAll('a[href*="/detail/"]')];
      const need = [];
      for (const a of anchors) {
        const cid = covCidOf(a);
        if (!cid) continue;
        if (covMap.has(cid)) covPaint(a, covMap.get(cid));
        else if (!covAsked.has(cid) && need.length < 100 && covAsked.size < COV_MAX_CIDS) {
          need.push(cid);
          covAsked.add(cid);
        }
      }
      if (!need.length) return;
      const r = await send({ type: 'coverageLookup', cids: need });
      if (!r.ok) return;            // 失敗不重問（covAsked 已記），避免每 3 秒打一次壞掉的端點
      for (const [c, st] of Object.entries(r.map || {})) covMap.set(c, st);
      for (const a of anchors) {
        const c = covCidOf(a);
        if (covMap.has(c)) covPaint(a, covMap.get(c));
      }
    } finally {
      covBusy = false;
    }
  }

  function coverageBadgesStart() {
    covScan();
    setInterval(covScan, 3000);
  }
  /* @test-only:end */

  boot();
})();
