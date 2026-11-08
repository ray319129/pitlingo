/**
 * 語音辨識實驗室（**只存在於測試版**）。畫面說明見 asr-lab.html 開頭。
 *
 * 訊息流：
 *   offscreen（擷取）──target:'sw'──▶ 這裡（也會到 service worker，它對實驗室模式的訊息不做事）
 *   F1TV 分頁（asr-content.js）──target:'asrLab'──▶ 這裡：播放位置、速度、靜音、官方字幕
 *   這裡 ──target:'offscreen', asr-config──▶ offscreen：開始／停止收割、監聽、段長、測試標籤
 *   這裡 ──tabs.sendMessage asrLab*──▶ 分頁：心跳、改速度、影片靜音、疊逐字稿
 *
 * ⚠️ 擷取只能從擴充功能圖示開始（tabCapture 需要使用者在 F1TV 分頁上的手勢），這一頁開不了。
 *    擷取停了，要回 F1TV 分頁再按一次「開啟語音辨識實驗室」。
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const P = self.PLAsrAssemble;
  const tabId = Number(new URLSearchParams(location.search).get('tab'));
  const SILENCE_RMS = 0.004;
  const TRANSLATE_BATCH = 40;

  let backend = '';
  let asrKey = '';
  const samples = [];        // { wall, t, rate, paused, muted, volume }
  const cc = [];             // { wall, t, text }
  const levels = [];         // { wall, rms, peak }
  const chunkLog = [];
  let lastSample = null;
  let capture = null;        // offscreen 的狀態
  let harvest = null;
  let transcript = null;     // 收好（或載入）的逐字稿
  let test = null;
  let tabMutedNow = false;

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtT = (t) => {
    if (t === null || t === undefined || !isFinite(t)) return '—';
    const s = Math.max(0, t);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(1).padStart(4, '0');
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + x;
  };
  const pct = (x) => (x === null || x === undefined ? '—' : Math.round(x * 100) + '%');
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(text, cls) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false }) + '  ' + text;
    const box = $('log');
    box.prepend(line);
    while (box.childNodes.length > 300) box.lastChild.remove();
  }

  function off(msg) {
    return new Promise((res) => chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg), (r) => {
      if (chrome.runtime.lastError) res({ ok: false, error: '擷取已停止（' + chrome.runtime.lastError.message + '）——回 F1TV 分頁點擴充功能圖示，再按一次「開啟語音辨識實驗室」' });
      else res(r || { ok: false, error: 'offscreen 沒有回應' });
    }));
  }

  function toTab(msg) {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // 啟動
  // ---------------------------------------------------------------------------
  async function init() {
    if (!tabId) { $('target').textContent = '缺少目標分頁——請從 F1TV 分頁的擴充功能圖示開啟這一頁'; return; }
    const info = await new Promise((res) => chrome.runtime.sendMessage({ type: 'asrLabInfo' }, (r) => res(chrome.runtime.lastError ? {} : (r || {}))));
    backend = info.backend || '';
    asrKey = (await chrome.storage.local.get('asrTestKey')).asrTestKey || '';
    if (!asrKey) log('⚠️ 沒有測試金鑰——回設定頁填 ASR_TEST_KEY', 'bad');
    try {
      const t = await chrome.tabs.get(tabId);
      $('target').textContent = '目標分頁：' + (t.title || t.url);
      tabMutedNow = !!(t.mutedInfo && t.mutedInfo.muted);
      $('tabMute').checked = tabMutedNow;
    } catch (e) { $('target').textContent = '目標分頁已關閉'; }
    heartbeat();
    setInterval(heartbeat, 5000);
    setInterval(pollCapture, 2000);
    setInterval(renderLive, 500);
    pollCapture();
    renderSaved();
    log('實驗室已開啟。擷取目前只量音量、不上傳。');
  }

  function heartbeat() { toTab({ type: 'asrLabWatch', on: true }); }

  async function pollCapture() {
    const r = await off({ type: 'asr-status' });
    capture = r.ok ? r : null;
    if (capture) $('monitor').checked = !!capture.monitor;
    $('captureState').innerHTML = capture
      ? Object.entries({
        擷取: capture.capturing ? '進行中' : '否', 模式: capture.mode, 上傳: capture.upload ? '是' : '否',
        監聽: capture.monitor ? '開' : '關', 段長: capture.chunkSec + ' 秒', 重疊: capture.overlapSec + ' 秒',
        輪次: capture.session, 已切段: capture.seq, 送出中: capture.inflight, 取樣率: capture.sampleRate,
        後端: backend, 金鑰: asrKey ? '已填' : '未填',
      }).map(([k, v]) => '<b>' + esc(k) + '</b><span>' + esc(v) + '</span>').join('')
      : '<b>擷取</b><span class="bad">' + esc(r.error) + '</span>';
  }

  // ---------------------------------------------------------------------------
  // 訊息
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg) return false;
    if (msg.target === 'asrLab') {
      if (!sender.tab || sender.tab.id !== tabId) return false;
      onTab(msg);
      return false;
    }
    if (msg.target === 'sw' && (msg.tabId === tabId || !msg.tabId)) onCapture(msg);
    return false;
  });

  function onTab(m) {
    if (m.type === 'sample') {
      lastSample = m;
      samples.push({ wall: m.wall, t: m.t, rate: m.rate, paused: m.paused, muted: m.muted, volume: m.volume });
      if (samples.length > 60000) samples.splice(0, samples.length - 60000);
      return;
    }
    if (m.type === 'cc') {
      if (m.t === null) return;
      cc.push({ wall: m.wall, t: m.t, text: m.text });
      if (cc.length > 20000) cc.shift();
      return;
    }
    if (m.type === 'rateResult') {
      $('rateActual').textContent = m.ok ? '實際 ' + m.actual + '×' : m.error;
      if (m.ok && Math.abs(m.actual - m.requested) > 0.01) log(`⚠️ 要求 ${m.requested}×，播放器維持 ${m.actual}×——F1TV 擋下改速度`, 'warn');
      else if (m.ok) log(`播放速度 ${m.actual}×`);
      return;
    }
    if (m.type === 'muteResult') {
      if (m.ok) log('影片播放器靜音：' + (m.actual ? '開' : '關'));
    }
  }

  function onCapture(m) {
    if (m.type === 'asr-level') {
      levels.push({ wall: m.wall, rms: m.rms, peak: m.peak });
      if (levels.length > 240) levels.shift();
      return;
    }
    if (m.type === 'asr-started') { log('擷取開始，取樣率 ' + m.sampleRate); return; }
    if (m.type === 'asr-ended') { log('❌ 擷取結束（分頁關閉、重新整理，或 Chrome 停止了擷取）', 'bad'); pollCapture(); return; }
    if (m.type !== 'asr-chunk' && m.type !== 'asr-result') return;
    if (m.mode !== 'lab') return;

    const words = (m.words || []).length;
    const status = m.silent ? '靜音（沒送）' : m.dropped ? '來不及送（丟掉）' : m.ok ? '成功' : '失敗';
    chunkLog.unshift({ seq: m.seq, tag: m.tag || '收割', sec: m.audioSec, rms: m.rms, status, asrMs: m.asrMs, roundMs: m.roundMs, words, error: m.ok ? '' : (m.error || (m.status ? 'HTTP ' + m.status : '')) });
    if (chunkLog.length > 60) chunkLog.pop();
    renderChunks();
    if (m.type === 'asr-result' && !m.ok) log(`第 ${m.seq} 段辨識失敗：${m.error || 'HTTP ' + m.status}${m.code ? '（' + m.code + '）' : ''}`, 'bad');
    if (m.usedSec !== undefined && m.capSec) $('harvestStats').dataset.used = `今日辨識 ${Math.round(m.usedSec / 60)}/${Math.round(m.capSec / 60)} 分鐘`;

    if (m.tag && m.tag.indexOf('test:') === 0) { if (test) test.onResult(m); return; }
    if (harvest && m.session === harvest.session) {
      harvest.lastAddAt = Date.now();
      if (m.type === 'asr-result') {
        if (m.ok) { if (typeof m.asrMs === 'number') harvest.asrMs.push(m.asrMs); } else harvest.errors++;
      }
      harvest.asm.add(m);
      if (m.final) harvest.gotFinal = true;
      renderTranscript();
    }
  }

  // ---------------------------------------------------------------------------
  // ① 聲音拿得到嗎
  // ---------------------------------------------------------------------------
  function renderLive() {
    const now = Date.now();
    const last = levels[levels.length - 1];
    const rms = last ? last.rms : 0;
    $('meterBar').style.width = Math.min(100, rms * 500) + '%';
    $('meterBar').style.background = rms < SILENCE_RMS ? 'var(--bad)' : 'var(--ok)';
    $('meterText').textContent = last
      ? `RMS ${rms.toFixed(4)}　峰值 ${last.peak.toFixed(3)}　${rms > 0 ? (20 * Math.log10(rms)).toFixed(1) + ' dBFS' : '−∞ dBFS'}`
      : '沒有音量資料';
    const blocks = '▁▂▃▄▅▆▇█';
    $('spark').textContent = levels.slice(-120).map((l) => blocks[Math.min(7, Math.floor(Math.min(1, l.rms * 8) * 7.99))]).join('');

    const s = lastSample;
    const stale = !s || now - s.wall > 3000;
    $('videoState').innerHTML = s ? [
      ['影片', s.cid ? 'contentId ' + s.cid : '（沒有 contentId）'],
      ['位置', fmtT(s.t) + (s.duration ? ' / ' + fmtT(s.duration) : '') + (s.live ? '　直播' : '')],
      ['狀態', (s.paused ? '暫停' : '播放中') + '　速度 ' + s.rate + '×'],
      ['影片音量', s.muted ? '靜音' : Math.round((s.volume || 0) * 100) + '%'],
      ['官方字幕', s.ccVerdict + '　收到 ' + cc.length + ' 句'],
      ['分頁回報', stale ? '⚠️ 超過 3 秒沒收到（F1TV 分頁重新整理過？）' : '正常'],
    ].map(([k, v]) => '<b>' + esc(k) + '</b><span>' + esc(v) + '</span>').join('') : '<b>影片</b><span>還沒收到分頁回報</span>';

    const recent = levels.filter((l) => now - l.wall < 6000).map((l) => l.rms);
    const med = median(recent);
    let v, cls;
    if (!capture || !capture.capturing) { v = '❌ 沒有在擷取'; cls = 'bad'; }
    else if (stale) { v = '⚠️ 收不到影片狀態，無法判斷'; cls = 'warn'; }
    else if (s.paused) { v = '⏸ 影片暫停中——播放後才能判斷'; cls = 'warn'; }
    else if (s.muted || !s.volume) { v = '⚠️ 影片播放器本身靜音或音量 0：擷取到的也會是靜音'; cls = 'warn'; }
    else if (med === null || recent.length < 8) { v = '… 量測中'; cls = 'warn'; }
    else if (med >= SILENCE_RMS) { v = '✅ 拿得到聲音'; cls = 'ok'; }
    else { v = '❌ 播放中卻擷取不到聲音——多半是 DRM 讓分頁聲音變成空白（也可能這幾秒剛好沒聲音，多看一會兒）'; cls = 'bad'; }
    $('verdict').textContent = v;
    $('verdict').className = 'verdict ' + cls;

    if (harvest) renderHarvestStats();
  }

  // ---------------------------------------------------------------------------
  // ② 控制
  // ---------------------------------------------------------------------------
  async function setMonitor(on) {
    const r = await off({ type: 'asr-config', monitor: on });
    if (!r.ok) { log(r.error, 'bad'); return false; }
    $('monitor').checked = !!r.monitor;
    return true;
  }
  async function setTabMuted(on) {
    try { await chrome.tabs.update(tabId, { muted: on }); tabMutedNow = on; $('tabMute').checked = on; return true; }
    catch (e) { log('分頁靜音失敗：' + e.message, 'bad'); return false; }
  }
  function setVideoMuted(on) { $('videoMute').checked = on; toTab({ type: 'asrLabVideoMute', muted: on }); }
  function setRate(r) { $('rate').value = String(r); toTab({ type: 'asrLabRate', rate: r }); }

  $('monitor').onchange = () => setMonitor($('monitor').checked);
  $('tabMute').onchange = () => setTabMuted($('tabMute').checked);
  $('videoMute').onchange = () => setVideoMuted($('videoMute').checked);
  $('rate').onchange = () => setRate(Number($('rate').value));
  $('stopCapture').onclick = async () => {
    if (harvest) await harvestStop();
    await new Promise((res) => chrome.runtime.sendMessage({ type: 'asrStop' }, () => res()));
    log('已停止擷取');
    pollCapture();
  };

  // ---------------------------------------------------------------------------
  // ③ 自動測試：靜音與倍速
  // ---------------------------------------------------------------------------
  const CONDITIONS = [
    { key: 'base', label: '基準：監聽、1×', monitor: true, tabMuted: false, videoMuted: false, rate: 1 },
    { key: 'nomon', label: '不監聽（喇叭沒聲音）', monitor: false, tabMuted: false, videoMuted: false, rate: 1 },
    { key: 'tabmute', label: 'Chrome 分頁靜音', monitor: true, tabMuted: true, videoMuted: false, rate: 1 },
    { key: 'vidmute', label: '影片播放器靜音', monitor: true, tabMuted: false, videoMuted: true, rate: 1 },
    { key: 'r15', label: '1.5 倍速', monitor: true, tabMuted: false, videoMuted: false, rate: 1.5 },
    { key: 'r2', label: '2 倍速', monitor: true, tabMuted: false, videoMuted: false, rate: 2 },
    { key: 'r2nomon', label: '2 倍速＋不監聽', monitor: false, tabMuted: false, videoMuted: false, rate: 2 },
  ];

  $('testRun').onclick = runTest;
  $('testAbort').onclick = () => { if (test) test.aborted = true; };

  async function runTest() {
    if (harvest) return log('收割進行中，不能同時測試', 'warn');
    if (!asrKey) return log('沒有測試金鑰', 'bad');
    const secs = Number($('testSec').value) || 15;
    const rows = [];
    test = { aborted: false, waiting: null, onResult(m) { if (this.waiting && m.tag === this.waiting.tag) this.waiting.resolve(m); } };
    $('testRun').disabled = true; $('testAbort').disabled = false; $('harvestStart').disabled = true;
    $('testConclusion').innerHTML = '';
    log(`開始自動測試（每種 ${secs} 秒）`);
    const restore = { monitor: $('monitor').checked, tabMuted: tabMutedNow, rate: Number($('rate').value) || 1 };
    try {
      for (let i = 0; i < CONDITIONS.length && !test.aborted; i++) {
        const c = CONDITIONS[i];
        $('testProgress').textContent = `${i + 1}/${CONDITIONS.length} ${c.label}`;
        await setMonitor(c.monitor);
        await setTabMuted(c.tabMuted);
        setVideoMuted(c.videoMuted);
        setRate(c.rate);
        await sleep(2500);                                    // 讓播放器與音量穩定
        if (lastSample && lastSample.paused) log('⚠️ 影片暫停中，這一項的結果沒有意義', 'warn');
        const tag = 'test:' + c.key + ':' + Date.now();
        const got = new Promise((resolve) => { test.waiting = { tag, resolve }; });
        const ws = Date.now();
        const r = await off({ type: 'asr-config', upload: true, translate: false, words: true, chunkSec: secs, overlapSec: 0, tag });
        if (!r.ok) { log(r.error, 'bad'); break; }
        await sleep(secs * 1000 + 300);
        await off({ type: 'asr-config', upload: false, tag: '' });   // 手上不到 1 秒，不會再多送一段
        const m = await Promise.race([got, sleep(45000).then(() => null)]);
        test.waiting = null;
        const we = ws + secs * 1000;
        const lv = levels.filter((l) => l.wall >= ws && l.wall <= we).map((l) => l.rms);
        const rateActual = lastSample ? lastSample.rate : null;
        const words = m && m.ok ? (m.words || []) : [];
        const hyp = words.map((w) => w.w).join(' ');
        const ccText = [...new Set(cc.filter((x) => x.wall >= ws && x.wall <= we + 1500).map((x) => x.text))].join(' ');
        const e = P.wordErrors(ccText, hyp);
        const row = {
          c, rateActual, rms: median(lv), words: words.length,
          wordsPerMediaSec: words.length / (secs * (rateActual || c.rate)),
          similarity: e.similarity, silent: m && m.silent, error: !m ? '沒有回應' : (m.ok || m.silent ? '' : (m.error || 'HTTP ' + m.status)),
        };
        rows.push(row);
        renderTestRows(rows);
      }
    } finally {
      await setMonitor(restore.monitor);
      await setTabMuted(restore.tabMuted);
      setVideoMuted(false);
      setRate(restore.rate);
      $('testRun').disabled = false; $('testAbort').disabled = true; $('harvestStart').disabled = false;
      $('testProgress').textContent = test && test.aborted ? '已中止' : '完成';
      test = null;
    }
    renderTestConclusion(rows);
  }

  function judge(row, base) {
    if (row.error) return { cls: 'bad', text: '❌ ' + row.error };
    // 播放器沒接受要求的速度：這一列測到的其實是別的速度，不能判「可用」
    if (row.rateActual !== null && Math.abs(row.rateActual - row.c.rate) > 0.01) {
      return { cls: 'bad', text: `❌ 播放器不接受 ${row.c.rate}×（實際 ${row.rateActual}×）` };
    }
    if (row.silent || row.rms === null || row.rms < SILENCE_RMS) return { cls: 'bad', text: '❌ 擷取到的是靜音' };
    if (!row.words) return { cls: 'bad', text: '❌ 有聲音但辨識不出字' };
    if (base && base.words && !base.error) {
      if (row.wordsPerMediaSec < base.wordsPerMediaSec * 0.7) return { cls: 'warn', text: '⚠️ 字數明顯比基準少' };
      if (row.similarity !== null && base.similarity !== null && row.similarity < base.similarity - 0.15) return { cls: 'warn', text: '⚠️ 準確度明顯比基準差' };
    }
    return { cls: 'ok', text: '✅ 可用' };
  }

  function renderTestRows(rows) {
    const base = rows.find((r) => r.c.key === 'base');
    $('testRows').innerHTML = rows.map((r) => {
      const j = judge(r, r === base ? null : base);
      return '<tr><td>' + esc(r.c.label) + '</td><td class="num">' + (r.rateActual === null ? '—' : r.rateActual + '×') + '</td>'
        + '<td class="num">' + (r.rms === null ? '—' : r.rms.toFixed(4)) + '</td><td class="num">' + r.words + '</td>'
        + '<td class="num">' + r.wordsPerMediaSec.toFixed(2) + '</td><td class="num">' + pct(r.similarity) + '</td>'
        + '<td class="' + j.cls + '">' + esc(j.text) + '</td></tr>';
    }).join('');
  }

  function renderTestConclusion(rows) {
    const by = (k) => rows.find((r) => r.c.key === k);
    const base = by('base');
    const ok = (k) => { const r = by(k); return r && judge(r, base).cls === 'ok'; };
    const L = [];
    if (!base) { $('testConclusion').textContent = '測試沒有跑完。'; return; }
    L.push(judge(base, null).cls === 'ok' ? '<span class="ok">✅ 聲音拿得到，辨識得出字</span>' : '<span class="bad">❌ 基準就失敗了——聲音拿不到，其他項目沒有意義</span>');
    if (judge(base, null).cls === 'ok') {
      L.push(ok('nomon') ? '<span class="ok">✅ 可以靜音收割：關掉監聽，喇叭沒聲音但擷取正常</span>'
        : ok('tabmute') ? '<span class="ok">✅ 可以靜音收割：用 Chrome 分頁靜音</span>'
          : '<span class="bad">❌ 靜音時擷取不到可用的聲音——收割時必須開著聲音</span>');
      const r2 = by('r2');
      L.push(r2 && r2.rateActual !== 2 ? '<span class="bad">❌ 播放器不接受 2 倍速（實際 ' + esc(r2.rateActual) + '×）</span>'
        : ok('r2') ? '<span class="ok">✅ 可以 2 倍速收割</span>'
          : ok('r15') ? '<span class="warn">⚠️ 2 倍速準確度下降，1.5 倍速可用</span>'
            : '<span class="bad">❌ 倍速會讓辨識變差，收割請用 1 倍速</span>');
      if (ok('r2nomon') && ok('r2')) L.push('<span class="ok">✅ 2 倍速＋靜音同時成立：收一支 2 小時的影片約 1 小時、不用聽</span>');
      L.push(ok('vidmute') ? '<span class="warn">ℹ️ 影片播放器靜音時仍擷取得到（少見，代表擷取點在播放器之前）</span>'
        : '<span class="hint">ℹ️ 影片播放器靜音會讓擷取也變成靜音（預期如此：靜音要用「不監聽」而不是把播放器靜音）</span>');
    }
    $('testConclusion').innerHTML = L.join('<br>');
    log('自動測試完成：' + $('testConclusion').textContent.replace(/\s+/g, ' '));
  }

  // ---------------------------------------------------------------------------
  // ④ 收割逐字稿
  // ---------------------------------------------------------------------------
  $('harvestStart').onclick = harvestStartFn;
  $('harvestStop').onclick = harvestStop;

  async function harvestStartFn() {
    if (test) return;
    if (!asrKey) return log('沒有測試金鑰', 'bad');
    if (!lastSample || lastSample.t === null) log('⚠️ 還沒收到影片播放位置——時間會對不上，請確認 F1TV 分頁在播放', 'warn');
    const chunkSec = Number($('chunkSec').value) || 15;
    const overlapSec = Number($('overlapSec').value) || 2;
    const r = await off({ type: 'asr-config', upload: true, translate: false, words: true, chunkSec, overlapSec, tag: '' });
    if (!r.ok) return log(r.error, 'bad');
    harvest = {
      asm: P.createAssembler({ overlapSec }), session: r.session, startedAt: Date.now(), endedAt: 0,
      chunkSec, overlapSec, asrMs: [], errors: 0, lastAddAt: Date.now(), stopping: false, gotFinal: false,
      cid: lastSample && lastSample.cid, title: lastSample && lastSample.title, url: lastSample && lastSample.url,
      rates: new Set(),
    };
    transcript = null;
    $('harvestStart').disabled = true; $('harvestStop').disabled = false; $('testRun').disabled = true;
    $('translate').disabled = true; $('save').disabled = true; $('export').disabled = true; $('showOnVideo').disabled = true;
    log(`開始收割：每段 ${chunkSec} 秒、重疊 ${overlapSec} 秒`);
    harvest.skipTimer = setInterval(() => {
      // 某一段的回報一直沒到（訊息遺失）：90 秒後跳過，免得後面全部卡住
      if (harvest && harvest.asm.pendingCount() && Date.now() - harvest.lastAddAt > 90000) {
        const n = harvest.asm.skipMissing();
        if (n) log(`⚠️ 有 ${n} 段的回報遺失，已跳過`, 'warn');
        renderTranscript();
      }
    }, 5000);
  }

  async function harvestStop() {
    if (!harvest || harvest.stopping) return;
    harvest.stopping = true;
    $('harvestStop').disabled = true;
    log('停止收割，等最後幾段回來…');
    await off({ type: 'asr-config', upload: false });
    const until = Date.now() + 60000;
    // 送出中的段都回來、而且沒有卡住的段，才收尾
    while (Date.now() < until) {
      const st = await off({ type: 'asr-status' });
      if ((!st.ok || !st.inflight) && !harvest.asm.pendingCount()) break;
      await sleep(1000);
    }
    await sleep(800);
    harvest.asm.finish();
    harvest.endedAt = Date.now();
    clearInterval(harvest.skipTimer);
    transcript = buildTranscript();
    harvest = null;
    renderTranscript();
    compare();
    $('harvestStart').disabled = false; $('testRun').disabled = false;
    $('translate').disabled = !transcript.sentences.length;
    $('save').disabled = $('export').disabled = $('showOnVideo').disabled = !transcript.sentences.length;
    log(`收割完成：${transcript.sentences.length} 句、${transcript.stats.words} 字、辨識 ${Math.round(transcript.stats.audioSec)} 秒音訊`);
  }

  function mapper() { return P.createMediaMapper(samples); }

  function timed(list, offsetSec) {
    const m = mapper();
    return list.map((s) => {
      const a = m(s.startWall), b = m(s.endWall);
      return {
        startWall: s.startWall, endWall: s.endWall, en: s.en, zh: s.zh || '',
        start: a === null ? null : +(a + offsetSec).toFixed(2),
        end: b === null ? null : +(b + offsetSec).toFixed(2),
      };
    });
  }

  function buildTranscript() {
    const h = harvest;
    const offsetSec = Number($('offsetSec').value) || 0;
    const rs = samples.filter((x) => x.wall >= h.startedAt && x.wall <= h.endedAt).map((x) => x.rate);
    return {
      cid: h.cid, title: h.title, url: h.url, createdAt: h.startedAt, endedAt: h.endedAt,
      chunkSec: h.chunkSec, overlapSec: h.overlapSec, offsetSec,
      rates: [...new Set(rs)], stats: Object.assign({}, h.asm.stats),
      asrMsMedian: median(h.asm.stats.ok ? h.asrMs : []),
      sentences: timed(h.asm.sentences, offsetSec),
      cc: cc.filter((x) => x.wall >= h.startedAt - 5000 && x.wall <= h.endedAt + 5000).map((x) => ({ t: x.t, text: x.text })),
      translated: false, usd: 0,
    };
  }

  function currentRows() {
    if (harvest) return timed(harvest.asm.sentences, Number($('offsetSec').value) || 0);
    return transcript ? transcript.sentences : [];
  }

  function renderTranscript() {
    const rows = currentRows();
    const shown = rows.slice(-400);
    $('transcriptRows').innerHTML = shown.map((s) => '<tr><td class="num' + (s.start === null ? ' nulltime' : '') + '">'
      + (s.start === null ? '時間不明' : fmtT(s.start)) + '</td><td class="en">' + esc(s.en) + '</td><td class="zh">' + esc(s.zh || '') + '</td></tr>').join('');
    $('openSentence').textContent = harvest && harvest.asm.openText() ? '正在組句：' + harvest.asm.openText() : '';
    const box = $('transcriptRows').closest('.scroll');
    if (harvest) box.scrollTop = box.scrollHeight;
  }

  function renderHarvestStats() {
    const s = harvest.asm.stats;
    const mins = ((Date.now() - harvest.startedAt) / 60000).toFixed(1);
    $('harvestStats').textContent = `收割 ${mins} 分鐘　段：成功 ${s.ok}／靜音 ${s.silent}／失敗 ${s.failed}／丟掉 ${s.dropped}／遺失 ${s.skipped}`
      + `　等待中 ${harvest.asm.pendingCount()}　句 ${harvest.asm.sentences.length}　字 ${s.words}（重疊去重 ${s.dupWordsDropped}）`
      + `　辨識中位數 ${median(harvest.asrMs) ?? '—'}ms　${$('harvestStats').dataset.used || ''}`;
  }

  $('offsetSec').onchange = () => {
    if (transcript) { transcript.offsetSec = Number($('offsetSec').value) || 0; retime(); }
    renderTranscript();
    compare();
  };

  /** 已收好的逐字稿改時間校正：用牆上時間重算（載入的逐字稿沒有牆上時間，只平移）。 */
  function retime() {
    const o = transcript.offsetSec;
    if (transcript.sentences.length && transcript.sentences[0].startWall !== undefined && samples.length) {
      const zh = transcript.sentences.map((s) => s.zh);
      transcript.sentences = timed(transcript.sentences, o).map((s, i) => Object.assign(s, { zh: zh[i] }));
    } else {
      const d = o - (transcript.appliedOffset || 0);
      for (const s of transcript.sentences) { if (s.start !== null) s.start += d; if (s.end !== null) s.end += d; }
      transcript.appliedOffset = o;
    }
    pushToVideo();
  }

  $('applyOffset').onclick = () => {
    const rows = currentRows();
    const ccList = transcript ? transcript.cc : cc;
    const cur = Number($('offsetSec').value) || 0;
    const est = P.estimateOffset(rows, ccList);
    if (!est) return log('估計不出偏移：需要有官方字幕、而且逐字稿與官方字幕有足夠相同的句子', 'warn');
    $('offsetSec').value = (cur + est.offsetSec).toFixed(1);
    log(`套用估計的時間校正 ${(cur + est.offsetSec).toFixed(1)} 秒（依 ${est.n} 句）`);
    $('offsetSec').onchange();
  };

  // ---------------------------------------------------------------------------
  // ⑤ 整份翻譯
  // ---------------------------------------------------------------------------
  $('translate').onclick = async () => {
    if (!transcript || !transcript.sentences.length) return;
    $('translate').disabled = true;
    const list = transcript.sentences;
    let usd = 0, done = 0, bad = 0;
    try {
      for (let i = 0; i < list.length; i += TRANSLATE_BATCH) {
        const batch = list.slice(i, i + TRANSLATE_BATCH);
        $('trProgress').textContent = `${i}/${list.length}…`;
        const r = await fetch(backend + '/v1/asr/test/translate', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-asr-key': asrKey },
          body: JSON.stringify({ lines: batch.map((s) => s.en.slice(0, 1000)) }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) { log(`翻譯第 ${i + 1} 句起失敗：${d.error || 'HTTP ' + r.status}`, 'bad'); break; }
        d.out.forEach((x, k) => { batch[k].zh = x.zh; if (!x.zh) bad++; });
        usd += d.usd || 0;
        done += batch.length;
        renderTranscript();
      }
    } finally {
      transcript.translated = done === list.length;
      transcript.usd = (transcript.usd || 0) + usd;
      $('trProgress').textContent = `已翻 ${done}/${list.length} 句，${bad} 句被守門擋下，翻譯約 US$${usd.toFixed(4)}`;
      $('translate').disabled = false;
      log($('trProgress').textContent);
      pushToVideo();
    }
  };

  // ---------------------------------------------------------------------------
  // ⑥ 準確率
  // ---------------------------------------------------------------------------
  $('compare').onclick = compare;

  function compare() {
    const rows = currentRows();
    const ccList = transcript ? transcript.cc : cc.filter((x) => harvest && x.wall >= harvest.startedAt - 5000);
    if (!rows.length || !ccList.length) {
      $('accSummary').textContent = !ccList.length ? '沒有官方字幕資料（影片沒開 CC，或收割時實驗室沒開）' : '還沒有逐字稿';
      $('accRows').innerHTML = '';
      return;
    }
    const r = P.compareWithCc(rows, ccList, 60);
    const est = P.estimateOffset(rows, ccList);
    const nullT = rows.filter((x) => x.start === null).length;
    $('accSummary').innerHTML = '整體相似度 <b>' + pct(r.similarity) + '</b>（CC ' + r.ref + ' 字）'
      + (est ? '　估計偏移 ' + est.offsetSec.toFixed(1) + ' 秒（' + est.n + ' 句）' : '')
      + (nullT ? '　<span class="warn">' + nullT + ' 句時間不明</span>' : '');
    $('accRows').innerHTML = r.windows.map((w) => '<tr><td>' + fmtT(w.from) + '–' + fmtT(w.to) + '</td><td class="num">' + w.ref
      + '</td><td class="num">' + w.hyp + '</td><td class="num">' + pct(w.similarity) + '</td></tr>').join('');
    if (transcript) transcript.accuracy = { similarity: r.similarity, ccWords: r.ref, offsetEstimate: est };
  }

  // ---------------------------------------------------------------------------
  // ⑦ 儲存與播放
  // ---------------------------------------------------------------------------
  const KEY = (t) => 'asrTranscript:' + (t.cid || 'unknown') + ':' + t.createdAt;

  $('save').onclick = async () => {
    if (!transcript) return;
    const t = Object.assign({}, transcript, { sentences: transcript.sentences.map(({ start, end, en, zh }) => ({ start, end, en, zh })) });
    try {
      await chrome.storage.local.set({ [KEY(transcript)]: t });
      log('已存到這台電腦（chrome.storage.local）');
    } catch (e) { log('儲存失敗：' + e.message, 'bad'); }
    renderSaved();
  };

  $('export').onclick = () => {
    if (!transcript) return;
    const blob = new Blob([JSON.stringify(transcript, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pitlingo-asr-' + (transcript.cid || 'unknown') + '-' + new Date(transcript.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  $('showOnVideo').onchange = pushToVideo;

  function pushToVideo() {
    if (!transcript) return;
    toTab({
      type: 'asrLabTranscript', on: $('showOnVideo').checked,
      cues: transcript.sentences.map(({ start, end, en, zh }) => ({ start, end, en, zh })),
    });
  }

  async function renderSaved() {
    const all = await chrome.storage.local.get(null);
    const items = Object.entries(all).filter(([k]) => k.indexOf('asrTranscript:') === 0)
      .map(([k, v]) => Object.assign({ key: k }, v)).sort((a, b) => b.createdAt - a.createdAt);
    $('savedRows').innerHTML = items.map((t) => '<tr><td>' + esc(t.title || t.cid || '—') + '</td><td class="num">' + t.sentences.length
      + '</td><td class="num">' + t.sentences.filter((s) => s.zh).length + '</td><td>' + new Date(t.createdAt).toLocaleString('zh-TW', { hour12: false })
      + '</td><td><button data-load="' + esc(t.key) + '">載入</button> <button data-del="' + esc(t.key) + '">刪除</button></td></tr>').join('')
      || '<tr><td colspan="5" class="hint">還沒有存過逐字稿</td></tr>';
    $('savedRows').querySelectorAll('[data-load]').forEach((b) => { b.onclick = () => loadSaved(all[b.dataset.load]); });
    $('savedRows').querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('刪除這份逐字稿？')) return;
        await chrome.storage.local.remove(b.dataset.del);
        renderSaved();
      };
    });
  }

  function loadSaved(t) {
    if (harvest) return log('收割進行中，不能載入', 'warn');
    transcript = JSON.parse(JSON.stringify(t));
    transcript.appliedOffset = transcript.offsetSec || 0;
    $('offsetSec').value = transcript.offsetSec || 0;
    $('translate').disabled = $('save').disabled = $('export').disabled = $('showOnVideo').disabled = false;
    renderTranscript();
    compare();
    if (lastSample && t.cid && lastSample.cid && t.cid !== lastSample.cid) log('⚠️ 這份逐字稿不是目前分頁這支影片的，疊到影片上會對不上', 'warn');
    log('已載入：' + (t.title || t.cid));
    pushToVideo();
  }

  // ---------------------------------------------------------------------------
  // 除錯：音訊段
  // ---------------------------------------------------------------------------
  function renderChunks() {
    $('chunkRows').innerHTML = chunkLog.map((c) => '<tr><td class="num">' + c.seq + '</td><td>' + esc(c.tag.indexOf('test:') === 0 ? '測試 ' + c.tag.split(':')[1] : c.tag)
      + '</td><td class="num">' + (c.sec ? c.sec.toFixed(1) : '—') + '</td><td class="num">' + (typeof c.rms === 'number' ? c.rms.toFixed(4) : '—')
      + '</td><td class="' + (c.status === '成功' ? 'ok' : c.status === '失敗' ? 'bad' : 'warn') + '">' + esc(c.status)
      + '</td><td class="num">' + (c.asrMs ?? '—') + '</td><td class="num">' + (c.roundMs ?? '—') + '</td><td class="num">' + c.words
      + '</td><td>' + esc(c.error) + '</td></tr>').join('');
  }

  window.addEventListener('beforeunload', (e) => {
    toTab({ type: 'asrLabWatch', on: false });
    if (harvest) { e.preventDefault(); e.returnValue = ''; }
  });

  init();
})();
