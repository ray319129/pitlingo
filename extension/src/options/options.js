/*
 * 設定頁／彈出視窗。
 *
 * 設計原則：
 *   1. **打開就看得到現在是什麼狀況。** 使用者按圖示多半是因為「怎麼沒字幕」，
 *      不是想調字級。所以狀態放最上面，而且每個錯誤都要說「現在能做什麼」。
 *   2. **每個非同步動作都要有失敗的樣子。** 後端掛掉、沒開 F1TV、權杖過期，
 *      都不能只是靜靜地沒反應。
 *   3. 開源版沒有帳號與授權：唯一的「授權」是使用者自己的 Anthropic API key。
 */
(function () {
  'use strict';

  const { sanitizeSettings, DEFAULT_SETTINGS } = self.PL;
  const $ = (id) => document.getElementById(id);

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
      return setStatus('', '翻譯已關閉', '在下方「顯示」把它打開即可。');
    }

    if (!licState || !licState.active) {
      return setStatus('warn', '尚未設定 API key', '', '在下方填入你的 Anthropic API key，PitLingo 才會翻譯。');
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

    setStatus('ok', '運作中');
  }

  // ---------------------------------------------------------------------
  // API key
  // ---------------------------------------------------------------------
  let licState = null;

  async function refreshLicense() {
    const res = await sw({ type: 'licenseStatus' });
    licState = (res.ok && res.license) || null;
  }

  function keyMsg(cls, text) {
    const out = $('keyResult');
    out.hidden = !text; out.className = 'rpResult' + (cls ? ' ' + cls : ''); out.textContent = text || '';
  }

  async function refreshUsage() {
    const r = await sw({ type: 'usage' });
    const u = r.ok && r.usage;
    const fmt = (n) => Number(n || 0).toLocaleString('en-US');
    $('usageLine').textContent = (u
      ? `今天（UTC）呼叫 ${fmt(u.calls)} 次：輸入 ${fmt(u.input)}、快取讀取 ${fmt(u.cacheRead)}、快取寫入 ${fmt(u.cacheWrite)}、輸出 ${fmt(u.output)} tokens。`
      : '今天還沒有呼叫過模型。') + ` 本機快取 ${(r.ok && r.videos) || 0} 支影片。實際金額以 Anthropic Console 為準。`;
  }

  $('keySave').onclick = async () => {
    const key = $('apiKey').value.trim();
    const model = $('model').value.trim();
    if (!key) { keyMsg('err', '請先貼上 API key。'); return; }
    if (!/^sk-ant-/.test(key) && !confirm('這把金鑰不是 sk-ant- 開頭，確定要用它嗎？')) return;
    await chrome.storage.local.set({ apiKey: key, model });
    $('keySave').disabled = true;
    keyMsg('', '測試中（會呼叫一次模型）…');
    const r = await sw({ type: 'testKey' });
    $('keySave').disabled = false;
    const t = r.ok && r.result;
    if (t && t.ok) keyMsg('ok', `可以用了。測試譯文：${t.sample}　（已開著的 F1TV 分頁請重新整理）`);
    else keyMsg('err', '金鑰已儲存，但測試失敗：' + ((t && t.error) || r.error || '未知錯誤'));
    await refreshLicense(); await refreshStatus(); await refreshUsage();
  };

  $('keyClear').onclick = async () => {
    if (!confirm('清除這台電腦上的 API key？清除後 PitLingo 不會再翻譯。')) return;
    await chrome.storage.local.remove(['apiKey']);
    $('apiKey').value = '';
    keyMsg('', '已清除。');
    await refreshLicense(); await refreshStatus();
  };

  $('cacheClear').onclick = async () => {
    if (!confirm('清除本機的譯文快取？看過的影片下次要重新翻譯（重新花錢）。')) return;
    await sw({ type: 'clearCache' });
    await refreshUsage();
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
    $('ver').textContent = `版本 ${chrome.runtime.getManifest().version}`;
    

    const k = await chrome.storage.local.get(['apiKey', 'model']);
    $('apiKey').value = k.apiKey || '';
    $('model').value = k.model || '';
    await refreshLicense();
    await refreshStatus();
    await refreshUsage();
    // 彈出視窗開著的期間持續更新，使用者才看得到收割進度變化
    setInterval(refreshStatus, 3000);
  })();
})();
