// ---------------------------------------------------------------------------
// 遠端設定 —— 改這裡就能熱修所有用戶，不用重新送審擴充功能
// 選擇器用陣列依序嘗試：F1TV 灰度推送期間新舊版會同時存在
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 遠端設定
//
// 除了選擇器，還帶三個**分階段推送**用的欄位（P3-PLAN 第 1 節）：
//
//   rollout          0~100。只有這個比例的安裝會套用這一版，其餘沿用上一版。
//                    分流依 installId 雜湊，同一個人永遠落在同一組，不會忽新忽舊。
//   killSwitch       true = 所有用戶端停用疊字，乾淨退回原生英文字幕。
//                    F1TV 大改版而我們一時修不好時，這比讓使用者看錯亂的疊字好。
//   minClientVersion 低於此版的用戶端顯示「請更新」並停止翻譯。
//
// 為什麼需要：`wrangler deploy` 與 `POST /v1/config` 現在都是「一改就全中」。
// 收費之後，一次失誤 = 所有付費使用者同時故障。
// ---------------------------------------------------------------------------
const REMOTE_CONFIG = {
  version: 1,
  rollout: 100,
  killSwitch: false,
  minClientVersion: '0.0.0',

  // ---- 直播延遲畫面（2026-10-06，Ray 決定：預設開、不告訴使用者，LIVE 鍵也維持延遲）----
  // 看直播的人一律落後直播邊緣 seconds 秒；前導收割端貼邊緣翻，使用者的字幕到的時候譯文早就在快取裡。
  // 出問題時用遠端設定把 enabled 改成 false 就關掉（不必發新版）。見 extension/src/shared/live-delay.js
  liveDelay: { enabled: true, seconds: 45 },

  // ---- 免費層 ----
  // 免費層：本季正式場次，**每天所有影片加起來**登入 15 分鐘、未登入 5 分鐘（台灣時間 0 點重置，
  // 由擴充功能計時；伺服器另有每日句數上限兜成本）。以前是每場各 15 分鐘，其餘 F1TV 影片（賽後節目、紀錄片、
  // 集錦、車手訪談⋯）不含在免費內。
  //
  // 用網址 slug 分類，而且**放在遠端設定**——F1TV 隨時可能改命名規則，
  // 寫死在用戶端的話就得重新送審。實測到的 slug：
  //   2026-barcelona-gp-practice-1 / 2026-barcelona-gp-qualifying
  //   2026-miami-gp-sprint         / （正賽推測為 -race）
  // 不免費的：post-race-show-monaco、weekend-warm-up-miami
  // ---- 2026 賽程 ----
  //
  // ⚠️ **放在遠端設定，不是寫死在用戶端。** 2026 這個賽季特別容易變動：
  //    中東戰事已經讓四月整個月的兩場比賽消失，而年底兩場還在待決。
  //    寫死在擴充功能裡的話，每次賽程異動都要重新送審、等 1~3 天、
  //    再等使用者更新——而 Weekend Pass 賣的就是「某一場比賽的週末」，
  //    賽程錯了就是使用者付錢買到錯的日期。
  //
  // 資料來源與查證日期：2026-08-17，以 formula1.com、Wikipedia、
  // Sky Sports／FIA 公告三方交叉比對。
  //
  // 2026 的三項異動：
  //   · 巴林（原 4/10–12 Sakhir）與沙烏地（原 4/17–19 Jeddah）因伊朗戰事取消
  //   · 巴林 GP 移師馬來西亞 Sepang，10/02–04 舉行，
  //     官方名稱為「Formula 1 Gulf Air Bahrain Grand Prix in Malaysia」
  //   · 西班牙站移至馬德里新賽道 Madring（不是巴塞隆納；巴塞隆納是 6 月那場）
  // 結果是 23 場而非原定的 24 場，且**四月完全沒有比賽**。
  //
  // `tentative: true` 代表尚未確定。卡達與阿布達比原本受中東情勢影響、標為待定；
  // ✅ 2026-10-02 查證：F1 在荷蘭站週末確認兩站照常舉行（卡達 11/27–29、阿布達比 12/3–6），
  //    已拿掉 tentative。來源：euronews 2026-07-29、Gulf Business「F1 chief confirms Abu Dhabi
  //    will host 2026 season finale」、racingnews365「Qatar and Abu Dhabi confirmation deadline」。
  // ⚠️ 這兩站在確認後仍標待定了一個多月（SCHEDULE_URL 沒設，資料不會自己更新）——
  //    購買頁一直寫「其中 2 場待 F1 官方確認」。
  // **計算「剩餘場次」時待決場次不計入**——寧可低估，也不要拿一場可能不存在的
  // 比賽去說服使用者買方案。
  //
  // 日期格式 YYYY-MM-DD，`start` 是練習賽第一天、`end` 是正賽當天。
  // 時區一律用 UTC 判斷，不做各站當地時間換算：Weekend Pass 的範圍會往兩邊
  // 各放寬一天，那個緩衝遠大於任何時區差。
  seasonYear: 2026,
  // 賽事資料。**一個 Grand Prix = 一個商品**，通行證的效期由這裡動態算出來，
  // 商品自己不保存任何時間（見 gpWindow）。
  //
  // ⚠️ 哪些是事實、哪些是推估：
  //   事實 —— 場次日期、衝刺賽週、待定場次、夏休界線
  //   推估 —— 每個場次的開始時間（標 `est: 1`）。用 F1 的標準時刻表換算，
  //           官方公布後由 /v1/admin/schedule/sync 覆蓋。**推估值不可以
  //           在畫面上假裝是官方時間**，購買頁會標示「時間待官方確認」。
  //
  // ⚠️ 這一份是**內建的退路**。實際使用的是 KV 的 `sched:current`（若有），
  //    同步失敗或資料不合理時自動退回這裡——寧可用舊賽程，也不要沒有賽程。
  // 賽事資料。**一個 Grand Prix = 一個商品**，通行證的效期由這裡動態算出來，
  // 商品自己不保存任何時間（見 gpWindow）。
  //
  // 場次時間抄自 f1calendar.com（原以 Europe/London 顯示，這裡已換算成 UTC 秒），
  // 衝刺賽站別依 F1 官方公布的 2026 Sprint Calendar 核對：
  // **中國、邁阿密、加拿大、英國、荷蘭、新加坡**共六站。
  //
  // ⚠️ 先前有一版是用「標準時刻表」推估的，那一版有兩個實際錯誤：
  //    把比利時標成衝刺賽（實際不是）、漏掉英國與荷蘭（實際是）。
  //    衝刺賽週的場次組成完全不同，錯了會讓商品卡列出不存在的場次。
  //    **不要再用推估值。**
  //
  // ⚠️ start / end 是**當地日期**，不是倫敦日期。拉斯維加斯的正賽在當地
  //    星期六深夜，換算倫敦已是星期日；兩者差一天是正常的。
  //
  // ⚠️ 這一份是**內建的退路**。實際使用的是 KV 的 sched:current（若有），
  //    同步失敗或資料不合理時自動退回這裡——寧可用舊賽程，也不要沒有賽程。
  //
  // 要重新產生：node tools/gen-schedule.js
  schedule: [
    { r: 1, name: '澳洲', label: '澳洲大獎賽', country: '澳洲', flag: '🇦🇺', circuit: 'Albert Park', slugs: ['australia', 'australian', 'melbourne', 'albert-park'], tz: 'Australia/Melbourne', start: '2026-03-06', end: '2026-03-08', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1772760600 }, { k: 'fp2', n: '第二次自由練習', t: 1772773200 }, { k: 'fp3', n: '第三次自由練習', t: 1772847000 }, { k: 'quali', n: '排位賽', t: 1772859600 }, { k: 'race', n: '正賽', t: 1772942400 }] },
    { r: 2, name: '中國', label: '中國大獎賽', country: '中國', flag: '🇨🇳', circuit: 'Shanghai', slugs: ['china', 'chinese', 'shanghai'], tz: 'Asia/Shanghai', start: '2026-03-13', end: '2026-03-15', sprint: true, sessions: [{ k: 'fp1', n: '唯一自由練習', t: 1773372600 }, { k: 'sq', n: '衝刺排位賽', t: 1773387000 }, { k: 'sprint', n: '衝刺賽', t: 1773457200 }, { k: 'quali', n: '排位賽', t: 1773471600 }, { k: 'race', n: '正賽', t: 1773558000 }] },
    { r: 3, name: '日本', label: '日本大獎賽', country: '日本', flag: '🇯🇵', circuit: 'Suzuka', slugs: ['japan', 'japanese', 'suzuka'], tz: 'Asia/Tokyo', start: '2026-03-27', end: '2026-03-29', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1774578600 }, { k: 'fp2', n: '第二次自由練習', t: 1774591200 }, { k: 'fp3', n: '第三次自由練習', t: 1774665000 }, { k: 'quali', n: '排位賽', t: 1774677600 }, { k: 'race', n: '正賽', t: 1774760400 }] },
    { r: 4, name: '邁阿密', label: '邁阿密大獎賽', country: '美國', flag: '🇺🇸', circuit: 'Miami', slugs: ['miami'], tz: 'America/New_York', start: '2026-05-01', end: '2026-05-03', sprint: true, sessions: [{ k: 'fp1', n: '唯一自由練習', t: 1777651200 }, { k: 'sq', n: '衝刺排位賽', t: 1777667400 }, { k: 'sprint', n: '衝刺賽', t: 1777737600 }, { k: 'quali', n: '排位賽', t: 1777752000 }, { k: 'race', n: '正賽', t: 1777827600 }] },
    { r: 5, name: '加拿大', label: '加拿大大獎賽', country: '加拿大', flag: '🇨🇦', circuit: 'Gilles Villeneuve', slugs: ['canada', 'canadian', 'montreal', 'gilles-villeneuve'], tz: 'America/Toronto', start: '2026-05-22', end: '2026-05-24', sprint: true, sessions: [{ k: 'fp1', n: '唯一自由練習', t: 1779467400 }, { k: 'sq', n: '衝刺排位賽', t: 1779481800 }, { k: 'sprint', n: '衝刺賽', t: 1779552000 }, { k: 'quali', n: '排位賽', t: 1779566400 }, { k: 'race', n: '正賽', t: 1779652800 }] },
    { r: 6, name: '摩納哥', label: '摩納哥大獎賽', country: '摩納哥', flag: '🇲🇨', circuit: 'Monaco', slugs: ['monaco'], tz: 'Europe/Monaco', start: '2026-06-05', end: '2026-06-07', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1780659000 }, { k: 'fp2', n: '第二次自由練習', t: 1780671600 }, { k: 'fp3', n: '第三次自由練習', t: 1780741800 }, { k: 'quali', n: '排位賽', t: 1780754400 }, { k: 'race', n: '正賽', t: 1780837200 }] },
    { r: 7, name: '巴塞隆納', label: '巴塞隆納大獎賽', country: '西班牙', flag: '🇪🇸', circuit: 'Barcelona-Catalunya', slugs: ['barcelona', 'catalunya'], tz: 'Europe/Madrid', start: '2026-06-12', end: '2026-06-14', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1781263800 }, { k: 'fp2', n: '第二次自由練習', t: 1781276400 }, { k: 'fp3', n: '第三次自由練習', t: 1781346600 }, { k: 'quali', n: '排位賽', t: 1781359200 }, { k: 'race', n: '正賽', t: 1781442000 }] },
    { r: 8, name: '奧地利', label: '奧地利大獎賽', country: '奧地利', flag: '🇦🇹', circuit: 'Red Bull Ring', slugs: ['austria', 'austrian', 'spielberg', 'red-bull-ring'], tz: 'Europe/Vienna', start: '2026-06-26', end: '2026-06-28', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1782473400 }, { k: 'fp2', n: '第二次自由練習', t: 1782486000 }, { k: 'fp3', n: '第三次自由練習', t: 1782556200 }, { k: 'quali', n: '排位賽', t: 1782568800 }, { k: 'race', n: '正賽', t: 1782651600 }] },
    { r: 9, name: '英國', label: '英國大獎賽', country: '英國', flag: '🇬🇧', circuit: 'Silverstone', slugs: ['britain', 'british', 'great-britain', 'silverstone'], tz: 'Europe/London', start: '2026-07-03', end: '2026-07-05', sprint: true, sessions: [{ k: 'fp1', n: '唯一自由練習', t: 1783078200 }, { k: 'sq', n: '衝刺排位賽', t: 1783092600 }, { k: 'sprint', n: '衝刺賽', t: 1783162800 }, { k: 'quali', n: '排位賽', t: 1783177200 }, { k: 'race', n: '正賽', t: 1783260000 }] },
    { r: 10, name: '比利時', label: '比利時大獎賽', country: '比利時', flag: '🇧🇪', circuit: 'Spa-Francorchamps', slugs: ['belgium', 'belgian', 'spa', 'spa-francorchamps'], tz: 'Europe/Brussels', start: '2026-07-17', end: '2026-07-19', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1784287800 }, { k: 'fp2', n: '第二次自由練習', t: 1784300400 }, { k: 'fp3', n: '第三次自由練習', t: 1784370600 }, { k: 'quali', n: '排位賽', t: 1784383200 }, { k: 'race', n: '正賽', t: 1784466000 }] },
    { r: 11, name: '匈牙利', label: '匈牙利大獎賽', country: '匈牙利', flag: '🇭🇺', circuit: 'Hungaroring', slugs: ['hungary', 'hungarian', 'hungaroring', 'budapest'], tz: 'Europe/Budapest', start: '2026-07-24', end: '2026-07-26', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1784892600 }, { k: 'fp2', n: '第二次自由練習', t: 1784905200 }, { k: 'fp3', n: '第三次自由練習', t: 1784975400 }, { k: 'quali', n: '排位賽', t: 1784988000 }, { k: 'race', n: '正賽', t: 1785070800 }] },
    { r: 12, name: '荷蘭', label: '荷蘭大獎賽', country: '荷蘭', flag: '🇳🇱', circuit: 'Zandvoort', slugs: ['dutch', 'netherlands', 'zandvoort'], tz: 'Europe/Amsterdam', start: '2026-08-21', end: '2026-08-23', sprint: true, afterSummerBreak: true, sessions: [{ k: 'fp1', n: '唯一自由練習', t: 1787308200 }, { k: 'sq', n: '衝刺排位賽', t: 1787322600 }, { k: 'sprint', n: '衝刺賽', t: 1787392800 }, { k: 'quali', n: '排位賽', t: 1787407200 }, { k: 'race', n: '正賽', t: 1787490000 }] },
    { r: 13, name: '義大利', label: '義大利大獎賽', country: '義大利', flag: '🇮🇹', circuit: 'Monza', slugs: ['italy', 'italian', 'monza'], tz: 'Europe/Rome', start: '2026-09-04', end: '2026-09-06', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1788517800 }, { k: 'fp2', n: '第二次自由練習', t: 1788530400 }, { k: 'fp3', n: '第三次自由練習', t: 1788604200 }, { k: 'quali', n: '排位賽', t: 1788616800 }, { k: 'race', n: '正賽', t: 1788699600 }] },
    { r: 14, name: '西班牙（馬德里）', label: '西班牙（馬德里）大獎賽', country: '西班牙', flag: '🇪🇸', circuit: 'Madring', slugs: ['madrid', 'madring', 'spain', 'spanish'], tz: 'Europe/Madrid', start: '2026-09-11', end: '2026-09-13', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1789126200 }, { k: 'fp2', n: '第二次自由練習', t: 1789138800 }, { k: 'fp3', n: '第三次自由練習', t: 1789209000 }, { k: 'quali', n: '排位賽', t: 1789221600 }, { k: 'race', n: '正賽', t: 1789304400 }] },
    { r: 15, name: '亞塞拜然', label: '亞塞拜然大獎賽', country: '亞塞拜然', flag: '🇦🇿', circuit: 'Baku City', slugs: ['azerbaijan', 'baku'], tz: 'Asia/Baku', start: '2026-09-24', end: '2026-09-26', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1790238600 }, { k: 'fp2', n: '第二次自由練習', t: 1790251200 }, { k: 'fp3', n: '第三次自由練習', t: 1790325000 }, { k: 'quali', n: '排位賽', t: 1790337600 }, { k: 'race', n: '正賽', t: 1790420400 }] },
    { r: 16, name: '巴林（馬來西亞 Sepang）', label: '巴林（馬來西亞 Sepang）大獎賽', country: '馬來西亞', flag: '🇲🇾', circuit: 'Sepang', slugs: ['bahrain', 'sakhir', 'sepang', 'malaysia', 'malaysian'], tz: 'Asia/Kuala_Lumpur', start: '2026-10-02', end: '2026-10-04', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1790915400 }, { k: 'fp2', n: '第二次自由練習', t: 1790928000 }, { k: 'fp3', n: '第三次自由練習', t: 1791001800 }, { k: 'quali', n: '排位賽', t: 1791014400 }, { k: 'race', n: '正賽', t: 1791097200 }] },
    { r: 17, name: '新加坡', label: '新加坡大獎賽', country: '新加坡', flag: '🇸🇬', circuit: 'Marina Bay', slugs: ['singapore', 'marina-bay'], tz: 'Asia/Singapore', start: '2026-10-09', end: '2026-10-11', sprint: true, sessions: [{ k: 'fp1', n: '唯一自由練習', t: 1791534600 }, { k: 'sq', n: '衝刺排位賽', t: 1791549000 }, { k: 'sprint', n: '衝刺賽', t: 1791622800 }, { k: 'quali', n: '排位賽', t: 1791637200 }, { k: 'race', n: '正賽', t: 1791720000 }] },
    { r: 18, name: '美國', label: '美國大獎賽', country: '美國', flag: '🇺🇸', circuit: 'Circuit of the Americas', slugs: ['united-states', 'austin', 'americas', 'cota'], tz: 'America/Chicago', start: '2026-10-23', end: '2026-10-25', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1792776600 }, { k: 'fp2', n: '第二次自由練習', t: 1792789200 }, { k: 'fp3', n: '第三次自由練習', t: 1792863000 }, { k: 'quali', n: '排位賽', t: 1792875600 }, { k: 'race', n: '正賽', t: 1792958400 }] },
    { r: 19, name: '墨西哥', label: '墨西哥大獎賽', country: '墨西哥', flag: '🇲🇽', circuit: 'Hermanos Rodríguez', slugs: ['mexico', 'mexican', 'mexico-city'], tz: 'America/Mexico_City', start: '2026-10-30', end: '2026-11-01', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1793385000 }, { k: 'fp2', n: '第二次自由練習', t: 1793397600 }, { k: 'fp3', n: '第三次自由練習', t: 1793467800 }, { k: 'quali', n: '排位賽', t: 1793480400 }, { k: 'race', n: '正賽', t: 1793563200 }] },
    { r: 20, name: '巴西', label: '巴西大獎賽', country: '巴西', flag: '🇧🇷', circuit: 'Interlagos', slugs: ['brazil', 'brazilian', 'sao-paulo', 'interlagos'], tz: 'America/Sao_Paulo', start: '2026-11-06', end: '2026-11-08', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1793979000 }, { k: 'fp2', n: '第二次自由練習', t: 1793991600 }, { k: 'fp3', n: '第三次自由練習', t: 1794061800 }, { k: 'quali', n: '排位賽', t: 1794074400 }, { k: 'race', n: '正賽', t: 1794157200 }] },
    { r: 21, name: '拉斯維加斯', label: '拉斯維加斯大獎賽', country: '美國', flag: '🇺🇸', circuit: 'Las Vegas Strip', slugs: ['las-vegas', 'vegas'], tz: 'America/Los_Angeles', start: '2026-11-19', end: '2026-11-21', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1795134600 }, { k: 'fp2', n: '第二次自由練習', t: 1795147200 }, { k: 'fp3', n: '第三次自由練習', t: 1795221000 }, { k: 'quali', n: '排位賽', t: 1795233600 }, { k: 'race', n: '正賽', t: 1795320000 }] },
    { r: 22, name: '卡達', label: '卡達大獎賽', country: '卡達', flag: '🇶🇦', circuit: 'Lusail', slugs: ['qatar', 'lusail'], tz: 'Asia/Qatar', start: '2026-11-27', end: '2026-11-29', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1795786200 }, { k: 'fp2', n: '第二次自由練習', t: 1795798800 }, { k: 'fp3', n: '第三次自由練習', t: 1795876200 }, { k: 'quali', n: '排位賽', t: 1795888800 }, { k: 'race', n: '正賽', t: 1795968000 }] },
    { r: 23, name: '阿布達比', label: '阿布達比大獎賽', country: '阿拉伯聯合大公國', flag: '🇦🇪', circuit: 'Yas Marina', slugs: ['abu-dhabi', 'yas-marina'], tz: 'Asia/Dubai', start: '2026-12-04', end: '2026-12-06', sessions: [{ k: 'fp1', n: '第一次自由練習', t: 1796376600 }, { k: 'fp2', n: '第二次自由練習', t: 1796389200 }, { k: 'fp3', n: '第三次自由練習', t: 1796466600 }, { k: 'quali', n: '排位賽', t: 1796479200 }, { k: 'race', n: '正賽', t: 1796562000 }] },
  ],

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
  sites: [
    {
      host: 'f1tv.formula1.com',
      captionRoot: ['.tm-subtitle-region-container'],
      captionLabel: ['.tm-ui-subtitle-label'],
      contentIdPattern: '/detail/(\\d+)',
      hideCss: '.tm-subtitle-region-container{opacity:0 !important}',
    },
  ],
};

