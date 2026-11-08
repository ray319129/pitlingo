/*
 * 設定頁／彈出視窗。
 *
 * 設計原則：
 *   1. **打開就看得到現在是什麼狀況。** 使用者按圖示多半是因為「怎麼沒字幕」，
 *      不是想調字級。所以狀態放最上面，而且每個錯誤都要說「現在能做什麼」。
 *   2. **每個非同步動作都要有失敗的樣子。** 後端掛掉、沒開 F1TV、權杖過期，
 *      都不能只是靜靜地沒反應。
 *   3. **授權跟著人走。** 這裡要讓使用者清楚知道換電腦不會失效，
 *      並且能自己管理裝置——不要讓他寫信問客服。
 */
(function () {
  'use strict';

  const { sanitizeSettings, DEFAULT_SETTINGS, BACKEND } = self.PL;
  const $ = (id) => document.getElementById(id);
  // 伺服器回來的字串放進 innerHTML 前一律跳脫（security-audit 2026-10-05）。
  // 站名、裝置編號、工單編號現在都是我們自己產的，但「現在是」不等於「永遠是」。
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 一般使用者看不到「詳細日誌」——那是開發用的，放出去只會造成困惑。
// 需要時仍可在 F1TV 分頁的 Console 打 `__pitlingo.debug(true)` 打開。
const TOGGLES = ['enabled', 'showEnglish', 'hideNativeCC', 'autoEnableCC'];
  // holdMs 已移除：疊字改成跟著原生字幕收掉之後，那個計時器在正常播放時
  // 永遠不會觸發，放在設定頁上只是一個調了不會有反應的旋鈕。
  const RANGES = ['fontSize', 'bottomPct', 'subtitleOffset'];
  // 字幕外觀（2026-11-03）：色票＋自訂顏色、透明度滑桿、外框單選鈕。check-options 讀這個陣列確認每一項都有 UI
  const LOOK = ['textColor', 'bgColor', 'bgOpacity', 'outline'];

  let settings = Object.assign({}, DEFAULT_SETTINGS);

  // ---------------------------------------------------------------------
  // 與 service worker / content script 通訊
  // ---------------------------------------------------------------------
  function sw(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (res || { ok: false, error: '沒有回應' }));
        });
      } catch (e) { resolve({ ok: false, error: String(e.message || e) }); }
    });
  }

  // ---------------------------------------------------------------------
  // 帳號
  //
  // ⚠️ **登入不是使用的必要條件。** 這一條的用途是讓人知道
  //    「登入可以把免費額度從 5 分鐘變成 15 分鐘」，不是把人擋在外面。
  //    文案一律寫成好處，不要寫成警告。
  // ---------------------------------------------------------------------
  let acctBusy = false;
  let lastAcct = null;
  let linkCode = '';
  // ⚠️ 彈出視窗在開分頁的那一刻就會被 Chrome 關掉，配對其實是 SW 在背景等。
  //    使用者到網站上需要確認碼時會**重新打開**彈出視窗——那時候 acctBusy 是 false（新的一頁），
  //    要從 storage 把等待中的確認碼讀回來顯示（2026-10-06 使用者回報「看不到確認碼」）。
  let linkWaiting = false;
  // SW 登記配對後會把確認碼寫進 storage；等待中就把它顯示出來
  chrome.storage.onChanged.addListener((ch) => {
    if (!ch.linkPending) return;
    linkCode = (ch.linkPending.newValue && ch.linkPending.newValue.code) || '';
    if (acctBusy) { paintAccount(null); return; }
    if (linkWaiting && !linkCode) {
      // 背景那一輪結束了（登入完成或逾時）：重新問一次帳號狀態
      linkWaiting = false;
      refreshAccount().then(() => refreshLicense()).then(() => refreshStatus()).catch(() => {});
    }
  });

  async function restoreLinkPending() {
    const { linkPending } = await chrome.storage.local.get('linkPending');
    if (linkPending && linkPending.code && linkPending.until > Date.now()) {
      linkCode = linkPending.code;
      linkWaiting = true;
    }
  }

  function paintAccount(st) {
    lastAcct = st;
    const name = $('acctName');
    const btn = $('acctBtn');
    // ⚠️ 已經用授權碼啟用的人**不是免費層**（2026-10-04 修）。以前一律寫「未登入 · 免費 5 分鐘」，
    //    已付費的人一打開就看到自己被說成免費使用者，下面卻又寫「已啟用 Season」，以為授權壞了。
    // ⚠️ 同一天稍晚：授權改成**一定要登入擁有它的帳號**。沒登入時授權是「暫停」，按鈕要說恢復。
    const licensed = !!(licState && licState.active);
    const paused = !licensed && !!(licState && licState.reason);
    // 等待配對時，確認碼另外放大標在最上面（帳號列那一行太小，2026-10-24 Ray 要求）
    const showCode = !(st && st.signedIn) && (acctBusy || linkWaiting) && !!linkCode;
    $('linkBox').hidden = !showCode;
    if (showCode) $('linkBoxCode').textContent = linkCode;
    // 回報問題的聯絡方式：登入就帶入帳號 email（2026-11-03 Ray 要求）。使用者自己改過的不蓋掉；登出時收回自動帶的
    const rc = $('rpContact');
    const em = (st && st.signedIn && st.profile && st.profile.email) || '';
    if (em && (!rc.value || rc.dataset.auto === '1')) { rc.value = em; rc.dataset.auto = '1'; }
    else if (!em && rc.dataset.auto === '1') { rc.value = ''; delete rc.dataset.auto; }
    if (st && st.signedIn) {
      const who = (st.profile && (st.profile.name || st.profile.email)) || '已登入';
      name.textContent = who + (st.offline ? '（離線）' : '');
      name.classList.add('on');
      btn.textContent = '登出';
    } else if ((acctBusy || linkWaiting) && linkCode) {
      // 配對確認碼：使用者要在開啟的網頁上輸入這 4 碼（只會在自己的擴充功能上看到它）
      // 碼放最前面：這一行太長會被截成「…」，確認碼不可以被截掉
      name.innerHTML = '確認碼 <b class="linkCode"></b> · 網頁登入後輸入（圖示上也看得到）';
      name.querySelector('.linkCode').textContent = linkCode;
      name.classList.remove('on');
      // 重新打開彈出視窗時：背景仍在等，按鈕可以重新產生一組（例如網頁分頁被關掉了）
      btn.textContent = acctBusy ? '等待中…' : '重新產生';
      btn.disabled = acctBusy;
      return;
    } else {
      name.textContent = acctBusy ? '請在開啟的分頁完成登入…'
        : licensed ? '未登入帳號 · 授權使用中' : paused ? '未登入 · 授權暫停中' : '未登入 · 免費 5 分鐘';
      name.classList.remove('on');
      btn.textContent = acctBusy ? '等待中…' : (licensed || paused) ? '登入恢復授權' : '登入拿 15 分鐘';
    }
    btn.disabled = acctBusy;
  }

  async function refreshAccount() {
    const r = await sw({ type: 'accountStatus', force: true });
    paintAccount(r.ok ? r.result : null);
  }

  $('acctBtn').onclick = async () => {
    if (acctBusy) return;
    const cur = await sw({ type: 'accountStatus' });
    if (cur.ok && cur.result && cur.result.signedIn) {
      // 授權綁帳號：登出會讓這台的授權暫停，先說清楚
      if (licState && licState.active
        && !confirm('登出帳號？\n這台電腦的授權會跟著暫停，重新登入就會恢復。')) return;
      await sw({ type: 'accountLogout' });
      await refreshAccount();
      await refreshLicense();
      await refreshStatus();
      return;
    }
    // ⚠️ 配對是**開分頁 + 輪詢**，最長五分鐘。期間要讓使用者看得出來
    //    「我們在等你」，否則他會以為按鈕壞了而一直重按。
    acctBusy = true;
    linkWaiting = false;
    paintAccount(null);
    const r = await sw({ type: 'accountLink' });
    acctBusy = false;
    linkCode = '';
    // 被新的一輪取代（使用者在另一個彈出視窗按了重新產生）：不要蓋掉新那一輪的畫面
    if (r.ok && r.result && r.result.superseded) { await restoreLinkPending(); paintAccount(null); return; }
    paintAccount(r.ok ? r.result : null);
    // 登入完成時 SW 會順便把授權接回來（記得的授權碼，或帳號裡有效的那一組）
    if (r.ok && r.result && r.result.signedIn) {
      await refreshLicense();
      await refreshStatus();
      const lr = r.result.license;
      if (lr && lr.ok === false && lr.error) { $('licMsg').className = 'result err'; $('licMsg').textContent = lr.error; }
    }
    if (r.ok && r.result && r.result.error) {
      $('acctName').textContent = r.result.error;
    }
    if (r.ok && r.result && r.result.timeout) {
      // ⚠️ 這裡原本寫 `toast(...)`，但 options.js **沒有那個函式**——
      //    `node --check` 完全過得去，要按到按鈕才會 ReferenceError（坑 #22）。
      //    這個檔案的慣例是用各區塊自己的訊息元素，狀態列就用它自己那一行。
      $('acctName').textContent = '沒有完成登入，再按一次可以重來';
    }
  };

  /**
   * 對目前的 F1TV 分頁說話。沒有那個分頁時要明確講，不要靜靜失敗。
   *
   * ⚠️ **開著好幾個 F1TV 分頁時，要挑「正在看的那一個」。** 以前一律取 tabs[0]，
   *    診斷報告與狀態卡可能來自一個早就沒在播的分頁——報告看起來完全正常，
   *    但描述的不是出問題的那個畫面。順序：正在發出聲音 → 所在視窗的作用中分頁 → 最近使用。
   */
  function toTab(msg) {
    return new Promise((resolve) => {
      chrome.tabs.query({ url: 'https://f1tv.formula1.com/*' }, (tabs) => {
        if (!tabs || !tabs.length) return resolve({ ok: false, noTab: true });
        const rank = (t) => (t.audible ? 4 : 0) + (t.active ? 2 : 0);
        const best = tabs.slice().sort((a, b) => (rank(b) - rank(a)) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)))[0];
        chrome.tabs.sendMessage(best.id, msg, (res) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (res || { ok: false }));
        });
      });
    });
  }

  // ---------------------------------------------------------------------
  // 狀態卡
  // ---------------------------------------------------------------------
  function setStatus(level, text, detail, actionHtml) {
    $('dot').className = 'dot ' + level;
    $('statusText').textContent = text;
    $('statusDetail').textContent = detail || '';
    const a = $('statusAction');
    if (actionHtml) { a.innerHTML = actionHtml; a.hidden = false; } else { a.hidden = true; }
  }

  async function refreshStatus() {
    if (!settings.enabled) {
      return setStatus('', '翻譯已關閉', '在下方「顯示」把它打開即可。收割仍會在背景進行。');
    }

    const st = await sw({ type: 'status' });
    if (!st.ok) {
      return setStatus('err', '無法連線到服務',
        st.error || '', '字幕功能暫時無法使用。請稍後再試，或在下方「回報問題」按「傳送診斷資訊」。');
    }

    // 有沒有開著 F1TV 分頁
    const tab = await toTab({ type: 'quickStatus' });
    if (tab.noTab) {
      return setStatus('', '待命中', '打開 F1TV 的影片頁面就會自動開始。');
    }
    if (!tab.ok) {
      return setStatus('warn', '尚未在這個分頁啟動',
        '', '請重新整理 F1TV 的分頁。剛安裝或剛更新時需要重整一次。');
    }

    const s = tab.state || {};
    if (!s.everSawCaption) {
      return setStatus('warn', '尚未偵測到字幕', '',
        '請確認 F1TV 播放器的 <b>英文字幕（CC）已開啟</b>：播放器右下角齒輪 → Subtitles → English。');
    }
    // 2026-10-28 Ray：「運作中」底下不用顯示細節（本機譯文句數、本片已完整）——那是給我們看的，診斷報告裡都有

    // 免費模式一定要把剩餘時間放在最顯眼的位置。
    // 使用者要決定買不買，唯一的依據就是「還剩多久」——
    // 把它藏在診斷報告裡等於沒有告訴他。
    if (!s.licensed) {
      if (!s.freeSession) {
        return setStatus('warn', '本片不在免費範圍',
          '免費試看僅涵蓋本季的練習賽、衝刺賽、排位賽與正賽。',
          '啟用授權後即可觀看所有內容。');
      }
      const left = Math.max(0, s.freeLeft || 0);
      const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
      const total = Math.round((s.freeTotal || 300) / 60);
      if (left <= 0) {
        // 額度用完是**最需要給出路**的一刻。只說「已結束」等於把人擋在門口，
        // 而他此時正是最有意願購買的時候——狀態卡直接給連結，不必讓他自己找。
        return setStatus('warn', '免費試看已結束',
          `今天的免費 ${total} 分鐘已用完（台灣時間 0 點重置），原生英文字幕已恢復顯示。`
          + (s.signedIn ? '' : '登入帳號每天可用 15 分鐘。'),
          '<a class="buyBtn" href="https://pitlingo.com/buy" target="_blank" rel="noopener">'
          + '查看方案</a>'
          + '<span class="hint">已經購買？用結帳時填寫的信箱登入就會自動啟用。</span>');
      }
      return setStatus('ok', `免費試看　剩餘 ${mm}:${ss}`,
        `今天的免費額度共 ${total} 分鐘（所有影片共用）`
        + (s.playing ? '' : '　·　目前暫停中，不計時'));
    }

    setStatus('ok', '運作中');
  }

  // ---------------------------------------------------------------------
  // 授權
  // ---------------------------------------------------------------------
  let licState = null;

  function fmtDate(sec) {
    if (!sec) return '無期限';
    return new Date(sec * 1000).toLocaleDateString('zh-TW');
  }

  /**
   * @param {boolean} force 向後端重新確認一次，不用等背景那 24 小時的週期。
   *
   * 打開這一頁的當下就是使用者在確認授權狀態的當下。若只讀本機快取，
   * 授權在後台被停用或刪除之後，這裡最長會有 24 小時顯示錯的狀態——
   * **畫面說「已啟用」而伺服器早就不認**，那比顯示不出來更糟。
   */
  async function refreshLicense(force) {
    const res = await sw({ type: 'licenseStatus', force: !!force });
    licState = (res.ok && res.license) || null;
    const active = !!(licState && licState.active);

    $('licActive').hidden = !active;
    $('licInactive').hidden = active;
    // 帳號列的文字取決於有沒有授權（見 paintAccount），授權狀態變了就重畫
    if (lastAcct !== undefined) paintAccount(lastAcct);
    if (!active) {
      // 沒登入：告訴他登入就有；登入了還是沒有：多半是用別的信箱買的 → 認領（1.0.2 起沒有授權碼欄位）
      const signedIn = !!(lastAcct && lastAcct.signedIn);
      $('licHow').hidden = signedIn;
      $('licClaim').hidden = !signedIn;
      // 被停用／刪除時要說明原因，否則使用者只看到「未啟用」會以為是自己弄丟了。
      // ⚠️ 沒登入時**不顯示**原因（1.0.2）：那時的原因只會是「要登入」，上面的 licHow 已經講了——
      //    兩段講同一件事，其中一段還是紅字，看起來像出錯（2026-10-30 Ray 截圖）。
      const why = signedIn && licState && licState.reason;
      const el = $('licMsg');
      if (el) { el.className = why ? 'result err' : 'result'; el.textContent = why || ''; }
      return;
    }

    // ⚠️ **方案名稱一律用伺服器回的 planLabel。**
    //    這裡本來寫死一份對照表，裡面還有一個根本不存在的鍵（weekend），
    //    而真正的鍵是 week——所以買一週通行證的人在這一頁看到的是
    //    英文鍵名「week」，而且完全不報錯。
    //    寫死的對照表在方案增減時一定會漂，這是第二次了（後台也發生過）。
    $('licPlan').textContent = licState.planLabel || licState.plan;
    $('licExp').textContent = licState.expiresAt
      ? `有效期至 ${fmtDate(licState.expiresAt)}`
      : '無使用期限';
    paintGpPass(licState);
  }

  /**
   * 比賽週通行證的細節。
   *
   * ⚠️ **不要只寫「有效 N 天」。** 使用者買的是「荷蘭大獎賽通行證」，
   *    他要看到的是那個名字、以及「什麼時候失效、為什麼是那個時候」。
   *    一個沒有脈絡的日期，他無法判斷自己還能不能看下一場。
   */
  // ⚠️ **剩餘時間要會走。** 只在載入當下算一次的話，設定頁開著十分鐘
  //    看到的還是十分鐘前的數字，而使用者會拿那個數字判斷「還來不來得及看」。
  //    每分鐘重畫一次就夠——秒級跳動只是視覺噪音。
  let gpTimer = null;
  let gpState = null;

  function paintGpPass(st) {
    const box = $('licGp');
    gpState = st;
    if (!gpTimer) gpTimer = setInterval(() => { if (gpState) paintGpPass(gpState); }, 60000);
    if (!box) return;
    const wins = Array.isArray(st.windows) ? st.windows : null;
    if (!st.gpName && !wins) { box.hidden = true; return; }
    box.hidden = false;

    const now = Math.floor(Date.now() / 1000);
    // 現在落在哪一段。跳著買時中間會有空檔，那時要說清楚下一段何時開始。
    const cur = wins && wins.find((w) => now >= w[0] && now < w[1]);
    const next = wins && wins.find((w) => w[0] > now);

    const left = (sec) => {
      const s2 = sec - now;
      if (s2 <= 0) return '';
      const d = Math.floor(s2 / 86400);
      const h = Math.floor((s2 % 86400) / 3600);
      return d > 0 ? `${d} 天 ${h} 小時` : `${h} 小時`;
    };

    const rows = [];
    if (st.gpName) rows.push(['涵蓋場次', st.gpName]);
    if (cur) {
      rows.push(['狀態', '使用中']);
      rows.push(['有效至', fmtDateTime(cur[1])
        + (st.nextLabel ? `（${st.nextLabel}第一場賽事前）` : '')]);
      rows.push(['剩餘', left(cur[1])]);
    } else if (next) {
      rows.push(['狀態', '尚未進入比賽週']);
      rows.push(['生效時間', fmtDateTime(next[0])]);
      rows.push(['還有', left(next[0])]);
    } else if (wins) {
      rows.push(['狀態', '涵蓋的比賽週都已結束']);
    }

    box.innerHTML = rows.map(([k, v]) =>
      `<div class="licGpRow"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  }

  /** 日期＋時間，用使用者自己的時區。 */
  function fmtDateTime(sec) {
    if (!sec) return '—';
    try {
      return new Intl.DateTimeFormat('zh-TW', {
        month: 'numeric', day: 'numeric', weekday: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(sec * 1000));
    } catch (e) { return new Date(sec * 1000).toLocaleString(); }
  }
  // ⚠️ 1.0.2 起沒有「貼上授權碼」與「只憑授權碼解除別台」：授權以帳號為準，
  //    裝置管理在網站「我的帳號」（licDevices 是連結）。

  $('licRemove').onclick = async () => {
    // 停用是使用者主動放棄這台的存取權，要再問一次。
    // ⚠️ **一定要連帶登出**（1.0.2）：授權以帳號為準，只清本機的話，背景每小時的檢查
    //    會從還登入著的帳號把授權接回來——按了「停用」一小時後又自己啟用。
    if (!confirm('在這台電腦停用授權並登出？\n這台會釋出一個裝置名額；之後重新登入就會恢復。')) return;
    await sw({ type: 'licenseClear' });
    await sw({ type: 'accountLogout' });
    await refreshAccount();
    await refreshLicense();
    await refreshStatus();
  };

  // ---------------------------------------------------------------------
  // 設定
  // ---------------------------------------------------------------------
  // 滑桿已走過的那段塗紅：CSS 拿不到 input 的值，由這裡寫 --p
  function fillRanges() {
    document.querySelectorAll('input[type="range"]').forEach((r) => {
      const lo = Number(r.min) || 0, hi = Number(r.max) || 100;
      r.style.setProperty('--p', ((Number(r.value) - lo) / (hi - lo) * 100) + '%');
    });
  }

  function renderOutputs() {
    renderLook();
    fillRanges();
    $('fontSizeOut').textContent = settings.fontSize + ' px';
    $('bottomPctOut').textContent = settings.bottomPct + ' %';
    const off = settings.subtitleOffset || 0;
    $('subtitleOffsetOut').textContent = off === 0 ? '跟隨官方字幕'
      : off < 0 ? `延後 ${(-off / 1000).toFixed(1)} 秒`
      : `提前 ${(off / 1000).toFixed(1)} 秒（僅重播）`;
    refreshOffsetLive();
  }

  /**
   * 問正在播放的分頁「這個設定現在真的生效了嗎」。
   *
   * 拿不到分頁不是錯誤——使用者可能只是在設定頁調整。
   * 但**絕對不能靜靜地什麼都不顯示**，那會讓人分不清「沒生效」與「沒查到」。
   */
  let offsetLiveTimer = null;
  function refreshOffsetLive() {
    clearTimeout(offsetLiveTimer);
    offsetLiveTimer = setTimeout(async () => {
      const el = $('offsetLive');
      if (!el) return;
      if ((settings.subtitleOffset || 0) === 0) { el.textContent = '　'; return; }
      const r = await toTab({ type: 'timingStatus' });
      if (r && r.noTab) { el.textContent = '目前狀態：沒有開啟中的 F1TV 分頁，無法確認是否生效'; return; }
      if (!r || !r.ok || !r.timing) { el.textContent = '目前狀態：查不到（請重新整理 F1TV 分頁）'; return; }
      el.textContent = '目前狀態：' + r.timing.text;
    }, 250);
  }

  function paint() {
    TOGGLES.forEach((k) => { $(k).checked = !!settings[k]; });
    RANGES.forEach((k) => { $(k).value = settings[k]; });
    $('textColor').value = settings.textColor;
    $('bgColor').value = settings.bgColor;
    $('bgClear').value = 100 - settings.bgOpacity;
    document.querySelectorAll('input[name="outline"]').forEach((r) => { r.checked = r.value === settings.outline; });
    renderOutputs();
  }

  // 字幕外觀的預覽：跟 F1TV 上的疊字共用 PL.subtitleLook，所以看到的就是實際樣子
  function renderLook() {
    const box = $('spBox');
    const v = self.PL.subtitleLook(settings);
    for (const p in v) box.style.setProperty(p, v[p]);
    // 預覽框約 300px 寬，等於 1280px 影片的四分之一，字級照比例縮（不縮的話 48px 會塞不下）
    $('spZh').style.fontSize = Math.max(11, Math.round(settings.fontSize * 0.55)) + 'px';
    $('spEn').style.fontSize = Math.max(9, Math.round(settings.fontSize * 0.62 * 0.55)) + 'px';
    $('spEn').hidden = !settings.showEnglish;
    box.style.bottom = (6 + settings.bottomPct * 0.9) + 'px';
    $('bgClearOut').textContent = (100 - settings.bgOpacity) + ' %';
    document.querySelectorAll('.swatches').forEach((g) => {
      const cur = settings[g.dataset.key];
      g.querySelectorAll('.sw[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === cur));
      const custom = g.querySelector('.sw.custom');
      custom.classList.toggle('on', ![...g.querySelectorAll('.sw[data-v]')].some((b) => b.dataset.v === cur));
      custom.style.setProperty('--c', cur);
    });
  }

  let saveTimer = null;
  function save() {
    settings = sanitizeSettings(settings);
    renderOutputs();
    // 拉滑桿會連續觸發，節流一下避免狂寫 storage
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ settings }), 120);
  }

  TOGGLES.forEach((k) => { $(k).onchange = () => { settings[k] = $(k).checked; save(); refreshStatus(); }; });
  RANGES.forEach((k) => { $(k).oninput = () => { settings[k] = Number($(k).value); save(); }; });

  // 字幕外觀
  document.querySelectorAll('.swatches').forEach((g) => {
    const key = g.dataset.key;
    g.querySelectorAll('.sw[data-v]').forEach((b) => {
      b.style.setProperty('--c', b.dataset.v);   // MV3：HTML 不放行內 style，顏色在這裡塗
      b.onclick = () => { settings[key] = b.dataset.v; $(key).value = b.dataset.v; save(); };
    });
    $(key).oninput = () => { settings[key] = $(key).value; save(); };
  });
  // 滑桿往右＝越透明（Ray 的用語是「背景透明度」）；存的是不透明度，跟 CSS 的 alpha 同方向
  $('bgClear').oninput = () => { settings.bgOpacity = 100 - Number($('bgClear').value); save(); };
  document.querySelectorAll('input[name="outline"]').forEach((r) => {
    r.onchange = () => { if (r.checked) { settings.outline = r.value; save(); } };
  });
  $('lookReset').onclick = () => {
    LOOK.concat('fontSize', 'bottomPct').forEach((k) => { settings[k] = DEFAULT_SETTINGS[k]; });
    save(); paint();
  };

  // ---------------------------------------------------------------------
  // 疑難排解
  // ---------------------------------------------------------------------
  /**
   * 傳送診斷給開發者。
   *
   * 原本是「複製到剪貼簿再自己貼給我」——那對一般使用者太麻煩，
   * 而且他們常常貼一半、貼錯地方，或根本不知道要貼去哪裡。
   *
   * 改成直接送到後端並回一個工單編號。使用者只要記那組編號，
   * 客服對得起來就好。
   */
  $('rpContact').oninput = () => { delete $('rpContact').dataset.auto; };

  $('rpSend').onclick = async () => {
    const btn = $('rpSend');
    const out = $('rpResult');
    // 問題描述必填（2026-11-03 Ray 要求）：沒有描述的報告只有時間軸，客服猜不到使用者看到什麼
    if (!$('rpNote').value.trim()) {
      out.hidden = false; out.className = 'rpResult err';
      out.textContent = '請先在「問題描述」寫下遇到的狀況。';
      $('rpNote').focus();
      return;
    }
    btn.disabled = true;
    out.hidden = false; out.className = 'rpResult'; out.textContent = '收集中…';

    const got = await toTab({ type: 'collectDiagnostics' });
    if (got.noTab) {
      btn.disabled = false;
      out.className = 'rpResult err';
      out.textContent = '請先打開 F1TV 的分頁，我們才收集得到運作狀態。';
      return;
    }
    if (!got.ok || !got.report) {
      btn.disabled = false;
      out.className = 'rpResult err';
      out.textContent = '收集失敗。請重新整理 F1TV 的分頁後再試一次。';
      return;
    }

    out.textContent = '傳送中…';
    const res = await sw({
      type: 'sendReport',
      report: got.report,
      note: $('rpNote').value.trim(),
      contact: $('rpContact').value.trim(),
      version: chrome.runtime.getManifest().version,
    });
    btn.disabled = false;

    if (res.ok && res.result && res.result.ticket) {
      out.className = 'rpResult ok';
      out.innerHTML = '已送出，謝謝你的回報。<br>詢問進度時請提供這組編號：'
        + `<div class="ticket">${esc(res.result.ticket)}</div>`;
      $('rpNote').value = '';
    } else {
      // 送不出去時要給一條退路，不能讓使用者卡在這裡
      out.className = 'rpResult err';
      out.textContent = ((res.result && res.result.error) || res.error || '傳送失敗')
        + '。可以稍後再試，或到 Console 打 __pitlingo.diag() 自行複製。';
    }
  };

  $('reloadCfg').onclick = async () => {
    const btn = $('reloadCfg');
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '重新載入中…';
    const res = await toTab({ type: 'applyConfigNow' });
    btn.disabled = false;
    btn.textContent = res.noTab ? '請先打開 F1TV 分頁'
      : res.ok ? (res.changed ? `已更新到 v${res.version}` : '已是最新設定')
      : '載入失敗';
    setTimeout(() => { btn.textContent = old; }, 2600);
  };

  $('onboardDone').onclick = () => {
    $('onboard').hidden = true;
    chrome.storage.local.set({ onboarded: true });
  };

  // ---------------------------------------------------------------------
  // 啟動
  // ---------------------------------------------------------------------
  (async () => {
    const st = await chrome.storage.local.get(['settings', 'onboarded']);
    settings = sanitizeSettings(st.settings);
    paint();

    $('onboard').hidden = !!st.onboarded;
    // 後端網址只在測試版顯示（2026-11-03 Ray：「為什麼要顯示後端在這?」——一般使用者用不到）
    $('ver').textContent = `版本 ${chrome.runtime.getManifest().version}`;
    /* @test-only:start */
    $('ver').textContent += `　·　後端 ${BACKEND.replace(/^https:\/\//, '')}`;
    /* @test-only:end */

    await restoreLinkPending();
    await refreshAccount();
    // 開啟這一頁時強制向後端確認一次，不要拿最多過時 24 小時的本機狀態去顯示
    await refreshLicense(true);
    await refreshStatus();
    // 彈出視窗開著的期間持續更新，使用者才看得到收割進度變化
    setInterval(refreshStatus, 3000);
  })();
})();
