/**
 * 設定頁的「語音辨識測試」區塊（**只存在於測試版**）。
 *
 * ⚠️ 開始擷取一定要從這裡按——chrome.tabCapture 需要「使用者在這個分頁上點了擴充功能」
 *    這個手勢，service worker 或 content script 自己呼叫會被拒。
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const box = $('asrTest');
  if (!box) return;
  box.hidden = false;

  const msg = (t, bad) => { $('asrMsg').textContent = t; $('asrMsg').className = 'result' + (bad ? ' err' : ''); };
  const sw = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || { ok: false }))));

  chrome.storage.local.get(['asrTestKey', 'asrTest'], (r) => {
    $('asrKey').value = r.asrTestKey || '';
    const o = r.asrTest || {};
    $('asrWhen').value = o.when || 'always';
    $('asrTiming').value = o.timing || 'late';
    $('asrChunk').value = String(o.chunkSec || 5);
    paint();
  });

  async function paint() {
    const { asrRunning, asrStats } = await chrome.storage.local.get(['asrRunning', 'asrStats']);
    $('asrStart').disabled = !!asrRunning;
    $('asrStop').disabled = !asrRunning;
    const s = asrStats || {};
    $('asrStatus').textContent = asrRunning
      ? `擷取中　段數 ${s.chunks || 0}（靜音 ${s.silent || 0}、錯誤 ${s.errors || 0}）　句數 ${s.segments || 0}`
        + (s.lastRms !== undefined ? `　音量 ${Number(s.lastRms).toFixed(4)}` : '')
        + (s.lastError ? `　最後錯誤：${s.lastError}` : '')
      : '未擷取';
  }
  setInterval(paint, 1000);

  $('asrStart').onclick = async () => {
    const key = $('asrKey').value.trim();
    if (!key) return msg('請先填測試金鑰（後端的 ASR_TEST_KEY）', true);
    if (!chrome.tabCapture) return msg('這個版本沒有擷取分頁聲音的權限——請載入 dist/pitlingo-test', true);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/f1tv\.formula1\.com\//.test(tab.url || '')) {
      return msg('請先切到正在播放的 F1TV 分頁，在那個分頁上點擴充功能圖示，再按開始', true);
    }
    const opts = { on: true, when: $('asrWhen').value, timing: $('asrTiming').value, chunkSec: Number($('asrChunk').value) || 5 };
    await chrome.storage.local.set({ asrTestKey: key, asrTest: opts, asrStats: {} });
    msg('取得分頁聲音中…');
    let streamId;
    try {
      streamId = await new Promise((res, rej) => chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError || !id) rej(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || '拿不到 streamId'));
        else res(id);
      }));
    } catch (e) { return msg('無法擷取分頁聲音：' + e.message, true); }
    const r = await sw({ type: 'asrStart', streamId, tabId: tab.id, chunkSec: opts.chunkSec });
    if (r.ok && r.result && r.result.ok) msg('已開始。這個視窗可以關掉，擷取會繼續。');
    else msg('開始失敗：' + ((r.result && r.result.error) || r.error || '未知'), true);
    paint();
  };

  // 語音辨識實驗室：**擷取一定要在這裡開始**（使用者在 F1TV 分頁上點圖示＝手勢），
  // 實驗室分頁本身拿不到這個手勢。先只量音量、不上傳，收割與測試都在實驗室裡按。
  $('asrLab').onclick = async () => {
    const key = $('asrKey').value.trim();
    if (!key) return msg('請先填測試金鑰（後端的 ASR_TEST_KEY）', true);
    if (!chrome.tabCapture) return msg('這個版本沒有擷取分頁聲音的權限——請載入 dist/pitlingo-test', true);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/f1tv\.formula1\.com\//.test(tab.url || '')) {
      return msg('請先切到 F1TV 的播放分頁，在那個分頁上點擴充功能圖示，再按這顆', true);
    }
    await chrome.storage.local.set({ asrTestKey: key });
    msg('取得分頁聲音中…');
    let streamId;
    try {
      streamId = await new Promise((res, rej) => chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError || !id) rej(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || '拿不到 streamId'));
        else res(id);
      }));
    } catch (e) { return msg('無法擷取分頁聲音：' + e.message, true); }
    const r = await sw({ type: 'asrStart', streamId, tabId: tab.id, mode: 'lab', upload: false, monitor: true });
    if (!(r.ok && r.result && r.result.ok)) return msg('開始失敗：' + ((r.result && r.result.error) || r.error || '未知'), true);
    chrome.tabs.create({ url: chrome.runtime.getURL('src/test/asr-lab.html') + '?tab=' + tab.id });
  };

  $('asrStop').onclick = async () => {
    await sw({ type: 'asrStop' });
    msg('已停止');
    paint();
  };

  ['asrWhen', 'asrTiming'].forEach((id) => {
    $(id).onchange = async () => {
      const { asrTest } = await chrome.storage.local.get('asrTest');
      await chrome.storage.local.set({ asrTest: Object.assign({}, asrTest || {}, { when: $('asrWhen').value, timing: $('asrTiming').value }) });
    };
  });
})();
