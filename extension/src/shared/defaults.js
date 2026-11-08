/**
 * 預設設定與遠端設定的合併邏輯
 *
 * 設計原則：**任何可能因 F1TV 改版而失效的東西都必須是資料，不能是程式碼。**
 * 選擇器、contentId 規則、隱藏用 CSS 全部放在這裡當「內建預設」，
 * 同時由後端的 /v1/config 提供可熱更新的版本。
 *
 * F1TV 改版時：改後端的 JSON → 幾分鐘內所有使用者恢復
 * 而不是：改程式碼 → 送審 → 等 1~3 天 → 使用者手動更新
 *
 * 選擇器是**陣列**，依序嘗試。F1TV 灰度推送期間新舊版會同時存在，
 * 陣列讓兩邊都能運作，你不必賭切換時機。
 */

(function (root) {
  'use strict';

  const BUILT_IN_CONFIG = {
    version: 0,                       // 內建版本永遠是 0，遠端的一定比較新
    sites: [
      {
        host: 'f1tv.formula1.com',
        captionRoot: ['.tm-subtitle-region-container'],
        captionLabel: ['.tm-ui-subtitle-label'],
        contentIdPattern: '/detail/(\\d+)',
        hideCss: '.tm-subtitle-region-container{opacity:0 !important}',
        // 播放器的字幕語言選單（Bitmovin Player UI 的 SubtitleSelectBox）。進入影片時自動開英文字幕用（main.js 的 tickAutoCC）
        ccSelect: ['select.tm-ui-subtitleselectbox'],
      },
    ],
    // 遠端設定拿不到時的備援。語意見 backend 的 REMOTE_CONFIG。
    // 直播延遲畫面（見 shared/live-delay.js）。後端連不上時也照樣延遲——前導收割的前提
    // 開源版預設關閉：延遲畫面原本是為了讓「前導收割端」先翻好、觀眾直接拿共用快取，開源版沒有那一端
    liveDelay: { enabled: false, seconds: 45 },
    freeTier: {
      seconds: 900,
      // 遊客（沒登入）的秒數。**不是懲罰，是讓「登入」有具體的理由**——
      // 遊客身分清一次瀏覽器就能重來，那原理上擋不住；與其假裝擋得住，
      // 不如讓「登入就從 5 分鐘變 15 分鐘」划算到不值得繞過。
      // 2026-09-17 使用者決定：未登入 5 分鐘、登入 15 分鐘（原本遊客 3 分鐘）。
      guestSeconds: 300,
      // ⚠️ **免費範圍＝本季的正式場次**（2026-09-18 使用者決定，方案 B）。
      //    以前用關鍵字（practice／qualifying／sprint／-race$／grand-prix$），實測 47 支不是正式場次的影片
      //    也被判成免費：排位賽／衝刺賽的賽前賽後節目、2024／2025 年的正賽重播、F1 Academy、F3、保時捷盃。
      //    正式場次的網址一定是「年份-站名-gp-場次」或「年份-站名-grand-prix」，對資料庫 148 支實測：
      //    本季 70 場全中、其餘 0 誤判。
      // ⚠️ **年份寫死在這裡，換季時要改**（check-consistency 會驗它等於 seasonYear）。
      // ⚠️ 設定是字串，不可以用 `\d` 之類需要跳脫的寫法——字串裡的 `\d` 會變成 `d`，正則靜默失效。
      exclude: ['-(psc|f1a|f2|f3|kids)-'],
      include: ['/2026-[a-z0-9-]+-(gp-(practice-[1-3]|sprint-qualifying|qualifying|sprint)|grand-prix)$'],
    },
  };

  /**
   * 這支影片屬不屬於免費層涵蓋的場次。
   *
   * 免費層只涵蓋**本季的正式賽事場次**（練習賽、衝刺排位、衝刺賽、排位賽、正賽），
   * 額度是每天所有影片共用一份（見 content/main.js 的 freeSecondsLeft）。
   * 其餘 F1TV 影片不在免費範圍——那些是額外內容，不是使用者訂閱 F1TV 的主要理由。
   *
   * 先排除再納入：`post-race-show-monaco` 含 "race" 但顯然不是正賽。
   */
  function isFreeSession(pathname, freeTier) {
    const ft = freeTier || BUILT_IN_CONFIG.freeTier;
    const slug = String(pathname || '').toLowerCase();
    try {
      if ((ft.exclude || []).some((p) => new RegExp(p).test(slug))) return false;
      return (ft.include || []).some((p) => new RegExp(p).test(slug));
    } catch (e) {
      return false;        // 設定裡的正則壞掉時保守處理：不當成免費
    }
  }

  const DEFAULT_SETTINGS = {
    enabled: true,
    showEnglish: true,          // 雙語顯示。字幕延遲時能靠英文關鍵字對上畫面
    fontSize: 26,               // 以 1280px 寬的影片為基準，會依實際大小縮放
    bottomPct: 8,               // 距影片底部的百分比（相對影片高度，不是視窗）
    hideNativeCC: true,         // 隱藏原生英文字幕，避免與疊字重疊
    // 進入影片時自動把 F1TV 的字幕切到英文。疊字跟著原生字幕走，CC 沒開中文就不會出現，
    // 而 F1TV 每換一支影片都重設成 None（2026-10-12 Ray 實測）
    autoEnableCC: true,
    // 字幕時機微調（毫秒）。負值＝延後顯示，正值＝提前顯示。
    //
    // 提前只在重播、且**校準通過離散度檢查**時生效（見 main.js 的
    // `recomputeCalibration`）。直播一律夾成 0——直播的字幕清單是滑動視窗，
    // 基準點會變，校準值不可信。
    //
    // ⚠️ 這一項**每次換影片都會被重設為 0**（main.js 的 `resetOffsetForNewVideo`）。
    //    它補的是「這一支影片的偏差」，不是使用者的長期偏好——
    //    字級與位置才是長期偏好，那兩項刻意不重設。
    subtitleOffset: 0,
    // 「字幕停留上限」曾經在這裡（holdMs）。**已移除，改成 main.js 的固定值 HOLD_MS。**
    // 自從疊字改成跟著原生字幕一起收掉之後，那個計時器在正常播放時永遠不會觸發，
    // 調它不會有任何可見效果——留著只會讓使用者以為自己調錯了。
    // 舊的 storage 裡可能還有這個欄位，`sanitizeSettings` 不輸出它就等於自然淘汰。
    debug: false,               // 詳細日誌：每句字幕、每個批次都印到 Console（測試用）
    // 即時狀態面板（HUD）。**預設關閉，而且必須預設關閉。**
    //
    // ⚠️ 它會在 F1TV 的畫面上蓋一塊東西，而那是別人的網站。
    //    一般使用者看到的必須是乾淨的播放器——與 `debug` 同一個道理。
    //
    // 打開之後每一場直播都會有，不必記得去按：**這一項的存在理由就是
    // 「每次都忘記開」**（LIVE-TEST 的五個數字跑了好幾場一個都沒量到）。
    hud: false,
    // 字幕外觀（2026-11-03 Ray：「字幕的控制選項多一點(背景透明度、字幕顏色、背景顏色、字幕外框)」）。
    // 預設值＝改版前寫死在 overlay.css 的樣子，升級的人畫面一個像素都不變。
    textColor: '#ffffff',
    bgColor: '#000000',
    bgOpacity: 72,              // 0～100；0＝完全透明（只剩外框）
    outline: 'shadow',          // none／shadow（陰影）／thin（細外框）／thick（粗外框）
  };

  const OUTLINES = ['none', 'shadow', 'thin', 'thick'];

  /**
   * 設定 → 疊字的 CSS 變數。**疊字層（main.js）與設定頁的預覽共用這一支**，
   * 預覽長什麼樣子，F1TV 上就長什麼樣子。
   * 英文那一行比中文淡一點、背景也淡一點（與改版前的 #c9c9c9／0.55 相同比例）。
   */
  function subtitleLook(s) {
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r, g, b] = rgb(s.textColor);
    const [br, bg, bb] = rgb(s.bgColor);
    const a = s.bgOpacity / 100;
    // 外框顏色跟字的深淺相反：深色字配白框，否則黑字黑框等於沒有框
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const oc = lum < 0.45 ? 'rgba(255,255,255,.95)' : 'rgba(0,0,0,.95)';
    const ring = (w) => [[-w, -w], [0, -w], [w, -w], [-w, 0], [w, 0], [-w, w], [0, w], [w, w]]
      .map(([x, y]) => x + 'px ' + y + 'px 0 ' + oc).join(',');
    const shadow = {
      none: 'none',
      shadow: lum < 0.45 ? '0 2px 4px rgba(255,255,255,.6)' : '0 2px 4px rgba(0,0,0,.9)',
      thin: ring(1),
      thick: ring(2) + ',0 2px 4px rgba(0,0,0,.6)',
    }[s.outline];
    return {
      '--pl-fg': 'rgb(' + r + ',' + g + ',' + b + ')',
      '--pl-fg-en': 'rgba(' + r + ',' + g + ',' + b + ',.8)',
      '--pl-bg': 'rgba(' + br + ',' + bg + ',' + bb + ',' + a.toFixed(2) + ')',
      '--pl-bg-en': 'rgba(' + br + ',' + bg + ',' + bb + ',' + (a * 0.76).toFixed(2) + ')',
      '--pl-shadow': shadow,
      '--pl-shadow-en': s.outline === 'shadow' ? shadow.replace('0 2px 4px', '0 1px 3px') : shadow,
    };
  }

  /** 從設定檔裡挑出符合目前網域的那一組 */
  /**
   * 清洗設定值。
   *
   * 設定會從 chrome.storage 讀回來，而那裡面可能有：舊版留下的欄位、
   * 使用者用開發者工具塞的值、同步過來的損毀資料。
   * 不清洗的話 `fontSize: 'big'` 會變成 CSS 的 `NaNpx`——**不會報錯，
   * 只是字幕整個不見**，而使用者完全不知道發生什麼事。
   *
   * 原則：每個欄位都夾在合理範圍內，型別不對就退回預設。寧可忽略也不要壞掉。
   */
  function sanitizeSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, (raw && typeof raw === 'object') ? raw : {});
    const num = (v, lo, hi, dflt) => {
      // 布林要先擋掉。`Number(true) === 1`，所以 `subtitleOffset: true` 會安靜地
      // 變成「提前 1 毫秒」——不是預設值，也不是使用者的意思，而且完全看不出來。
      if (typeof v === 'boolean') return dflt;
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    return {
      enabled: !!s.enabled,
      showEnglish: !!s.showEnglish,
      hideNativeCC: !!s.hideNativeCC,
      autoEnableCC: !!s.autoEnableCC,
      debug: !!s.debug,
      hud: !!s.hud,
      fontSize: num(s.fontSize, 12, 72, DEFAULT_SETTINGS.fontSize),
      bottomPct: num(s.bottomPct, 0, 60, DEFAULT_SETTINGS.bottomPct),
      // 延後 3 秒 / 提前 2 秒。**不對稱是刻意的**：
      // 延後是純計時器，設多少就是多少；提前依賴校準值，誤差會變成錯位的字幕。
      // 這裡的夾值是最後一道防線——設定頁的 min/max 只是 UI，
      // storage 可以被同步、被舊版寫入、被開發者工具塞任何東西。
      subtitleOffset: num(s.subtitleOffset, -3000, 2000, 0),
      // 顏色只收 #rrggbb：寫進 CSS 的值，不驗就是讓 storage 裡的字串變成樣式注入
      textColor: /^#[0-9a-f]{6}$/i.test(s.textColor) ? s.textColor.toLowerCase() : DEFAULT_SETTINGS.textColor,
      bgColor: /^#[0-9a-f]{6}$/i.test(s.bgColor) ? s.bgColor.toLowerCase() : DEFAULT_SETTINGS.bgColor,
      bgOpacity: Math.round(num(s.bgOpacity, 0, 100, DEFAULT_SETTINGS.bgOpacity)),
      outline: OUTLINES.includes(s.outline) ? s.outline : DEFAULT_SETTINGS.outline,
    };
  }

  function siteConfigFor(config, hostname) {
    const sites = (config && config.sites) || [];
    return sites.find((s) => hostname.endsWith(s.host)) || null;
  }

  root.PL = root.PL || {};
  root.PL.BUILT_IN_CONFIG = BUILT_IN_CONFIG;
  root.PL.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  root.PL.siteConfigFor = siteConfigFor;
  root.PL.sanitizeSettings = sanitizeSettings;
  root.PL.subtitleLook = subtitleLook;
  root.PL.isFreeSession = isFreeSession;
})(typeof self !== 'undefined' ? self : this);
