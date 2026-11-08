/**
 * 設定頁的「管理版：收割」區塊（**只存在於管理版**，handoff 9.1 #26）。
 *
 * 權杖存在 chrome.storage.local 的 `harvestToken`，只有 SW 讀它來帶 header（見 sw.js withHarvestToken）。
 * ⚠️ 儲存前先打一次 /v1/admin/harvest/plan 驗證——打錯的權杖不存，否則整晚的收割都是 401。
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const box = $('harvestAdmin');
  if (!box) return;
  box.hidden = false;

  const msg = (t, bad) => { $('harvestMsg').textContent = t; $('harvestMsg').className = 'result' + (bad ? ' err' : ''); };
  const sw = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || { ok: false }))));

  // 管理版只做管理版的事（2026-10-24 Ray）：登入、配對、授權、購買、新手導覽一律不出現（options.css .customerOnly）。
  // 身分只有收割權杖一種；沒有權杖就不翻譯、不當前導端（sw.js api() 擋下），**不退回用個人授權**。
  document.body.classList.add('adminBuild');
  const identity = (has) => {
    $('admTokenBadge').className = 'badge' + (has ? ' ok' : '');
    $('admTokenText').textContent = has ? '已設定：不需要登入或授權碼' : '尚未設定——管理版不翻譯、不當前導端，請在最下面設定';
  };
  chrome.storage.local.get('plLeader', (r) => {
    const on = !(r.plLeader && r.plLeader.on === false);
    $('admLeader').textContent = '前導收割模式：' + (on
      ? `開（看直播時貼邊緣先翻，批次 ${(r.plLeader && r.plLeader.win) || 20} 秒、每 30 秒送心跳）`
      : '關（F1TV 頁面 Console 打 __pitlingo.leader(true) 打開）');
  });

  chrome.storage.local.get('harvestToken', (r) => {
    msg(r.harvestToken ? '已設定（欄位不顯示內容）' : '尚未設定');
    identity(!!r.harvestToken);
  });

  $('harvestSave').addEventListener('click', async () => {
    const v = $('harvestToken').value.trim();
    if (!v) { msg('請先貼上權杖', true); return; }
    const { harvestToken: prev } = await chrome.storage.local.get('harvestToken');
    await chrome.storage.local.set({ harvestToken: v });
    msg('驗證中…');
    const res = await sw({ type: 'harvestPlan', paths: [] });
    const r = (res.ok && res.result) || {};
    if (r.ok) {
      $('harvestToken').value = '';
      identity(true);
      msg('✅ 已儲存並驗證。重新整理 F1TV 分頁後生效。');
    } else {
      // 驗證失敗：還原成原本的（或清掉），不留一把壞的
      if (prev) await chrome.storage.local.set({ harvestToken: prev });
      else await chrome.storage.local.remove('harvestToken');
      msg('✖ 驗證失敗：' + (r.error || res.error || '(未知)'), true);
    }
  });

  $('harvestClear').addEventListener('click', async () => {
    await chrome.storage.local.remove('harvestToken');
    $('harvestToken').value = '';
    identity(false);
    msg('已清除。重新整理 F1TV 分頁後生效。');
  });
})();
