/**
 * 語音辨識字幕 —— 畫面顯示與量測（**只存在於測試版**）
 *
 * 由測試版 manifest 在 main.js 之後注入，透過 main.js 的 `window.__plTest` 掛鉤取得
 * 輪詢、原生字幕、診斷報告、HUD 與訊息。正式版沒有這支檔案，main.js 裡的掛鉤也整段移除。
 *
 * 要回答的問題：
 *   1. 聲音拿不拿得到（DRM 時擷取到的是靜音 → RMS≈0）
 *   2. 辨識＋翻譯要多久（從「這句講完」到「中文出現」）
 *   3. 準不準——**同一段時間，語音辨識的英文與官方 CC 並排記下來**，事後逐句比對
 *
 * 顯示方式（設定頁可選）：
 *   when   always＝一律顯示（與官方字幕比較用）／nocc＝只在沒有官方字幕時顯示（模擬實際產品）
 *   timing late＝結果一到就顯示（直播沒有延遲畫面時唯一看得到的方式）
 *          aligned＝只在播放位置落在那句的時段內才顯示（搭配 t.delay() 延遲畫面測）
 */
(function () {
  'use strict';
  const T = window.__plTest;
  if (!T) return;                     // main.js 不是測試版（沒有掛鉤）就什麼都不做

  const MAX_CUES = 300;
  const MAX_NATIVE = 400;
  const MAX_PAIRS = 40;
  const opts = { on: false, when: 'always', timing: 'late' };
  const st = {
    started: 0, chunks: 0, silent: 0, dropped: 0, errors: 0, lastError: '',
    segments: 0, asrMs: [], roundMs: [], latency: [], provider: '', usedSec: 0, capSec: 0,
    rms: [], shown: 0, skippedNoCc: 0,
  };
  const cues = [];
  const native = [];
  const pairs = [];
  let el = null;
  let hideAt = 0;
  let queue = [];

  const push = (arr, v, max) => { arr.push(v); if (arr.length > max) arr.shift(); };
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  function box() {
    if (el && el.isConnected) return el;
    el = document.createElement('div');
    el.id = 'pitlingo-asr';
    el.style.cssText = [
      'position:fixed', 'z-index:2147482990', 'left:50%', 'transform:translateX(-50%)', 'pointer-events:none',
      'text-align:center', 'max-width:80vw', 'display:none',
      'font:700 22px/1.4 "Noto Sans TC","Microsoft JhengHei",sans-serif', 'color:#fff',
      'background:rgba(20,16,0,.78)', 'border:2px solid #f5b301', 'border-radius:8px', 'padding:4px 14px',
    ].join(';');
    const tag = document.createElement('div');
    tag.textContent = '語音辨識（測試）';
    tag.style.cssText = 'font:600 11px/1.4 system-ui;color:#f5b301;letter-spacing:.08em';
    const zh = document.createElement('div'); zh.className = 'z';
    const en = document.createElement('div'); en.className = 'e';
    en.style.cssText = 'font:400 14px/1.4 system-ui;color:#d9d3b8';
    el.append(tag, zh, en);
    const host = document.fullscreenElement || document.body;
    host.appendChild(el);
    return el;
  }

  function place() {
    const r = T.api.mainVideoRect();
    const b = box();
    if (r) b.style.bottom = (window.innerHeight - r.bottom + r.height * 0.24) + 'px';
    else b.style.bottom = '30%';
  }

  function show(cue, ms) {
    const b = box();
    place();
    b.querySelector('.z').textContent = cue.zh || '（沒有譯文）';
    b.querySelector('.e').textContent = cue.en;
    b.style.display = 'block';
    hideAt = Date.now() + ms;
    st.shown++;
  }

  function hide() { if (el) el.style.display = 'none'; }

  function allowedNow() {
    if (!opts.on) return false;
    if (opts.when !== 'nocc') return true;
    // 只在「這支沒有官方字幕」或「最近 8 秒原生字幕都是空的」時顯示
    const recentNative = native.length && Date.now() - native[native.length - 1].wall < 8000;
    const ok = T.api.subtitleTrackVerdict() === 'none' || !recentNative;
    if (!ok) st.skippedNoCc++;
    return ok;
  }

  // ---- 結果進來 ----
  T.message.push((m) => {
    if (m.type === 'asrStopped') { opts.on = false; hide(); return; }
    if (m.type !== 'asrCues') return;
    const d = m.data || {};
    if (d.mode === 'lab') return;       // 實驗室的收割結果不在這裡顯示（沒有逐段翻譯）
    if (d.type === 'asr-started') { st.started = Date.now(); return; }
    if (d.type === 'asr-chunk') {
      st.chunks++;
      if (d.silent) st.silent++;
      if (d.dropped) st.dropped++;
      if (typeof d.rms === 'number') push(st.rms, d.rms, 60);
      return;
    }
    if (d.type !== 'asr-result') return;
    st.chunks++;
    if (typeof d.rms === 'number') push(st.rms, d.rms, 60);
    if (typeof d.roundMs === 'number') push(st.roundMs, d.roundMs, 200);
    if (!d.ok) { st.errors++; st.lastError = d.error || ('HTTP ' + d.status); return; }
    st.provider = d.provider || st.provider;
    st.usedSec = d.usedSec || st.usedSec;
    st.capSec = d.capSec || st.capSec;
    if (typeof d.asrMs === 'number') push(st.asrMs, d.asrMs, 200);

    const v = document.querySelector('video');
    const now = Date.now();
    const rate = (v && v.playbackRate) || 1;
    // 牆上時間 → 播放位置：這段音訊開始時，影片播到哪裡
    const mediaAt = v && !v.paused ? v.currentTime - ((now - d.wallStart) / 1000) * rate : null;
    for (const s of d.segments || []) {
      st.segments++;
      const cue = {
        en: s.en, zh: s.zh,
        start: mediaAt === null ? null : mediaAt + s.start * rate,
        end: mediaAt === null ? null : mediaAt + s.end * rate,
        spokenEndWall: d.wallStart + s.end * 1000,
      };
      push(st.latency, now - cue.spokenEndWall, 200);
      push(cues, cue, MAX_CUES);
      // 與官方 CC 並排：這句講的那段時間前後 2 秒內，原生字幕出現過什麼
      if (cue.start !== null) {
        const cc = native.filter((x) => x.t >= cue.start - 2 && x.t <= cue.end + 2).map((x) => x.text);
        push(pairs, { t: cue.start, asr: cue.en, cc: [...new Set(cc)].join(' / ') || '（官方字幕在這段是空的）' }, MAX_PAIRS);
      }
      if (opts.timing === 'late') queue.push({ cue, ms: Math.max(1500, (s.end - s.start) * 1000) });
    }
  });

  // ---- 每次輪詢 ----
  T.poll.push(() => {
    if (!opts.on) { if (!lab.show) hide(); return; }
    const v = document.querySelector('video');
    if (opts.timing === 'late') {
      if (Date.now() >= hideAt) {
        const next = queue.shift();
        if (next && allowedNow()) show(next.cue, next.ms);
        else if (!next) hide();
      }
      return;
    }
    // aligned：播放位置落在那句的時段內才顯示
    if (!v) return;
    const t = v.currentTime;
    const hit = cues.find((c) => c.start !== null && t >= c.start && t <= c.end + 0.3);
    if (hit && allowedNow()) show(hit, 400); else if (Date.now() >= hideAt) hide();
  });

  // ---- 原生字幕（比對用）----
  T.native.push((text) => {
    const v = document.querySelector('video');
    if (!v) return;
    push(native, { t: v.currentTime, wall: Date.now(), text }, MAX_NATIVE);
  });

  // ---- 診斷報告 ----
  T.diag.push((L) => {
    L.push('');
    L.push('──── 語音辨識字幕（測試版）────');
    if (!st.chunks && !opts.on) { L.push('未啟用（設定頁 → 語音辨識測試 → 開始）'); return; }
    const avgRms = st.rms.length ? st.rms.reduce((a, b) => a + b, 0) / st.rms.length : null;
    L.push(`狀態　　　：${opts.on ? '擷取中' : '已停止'}　顯示 ${opts.when}/${opts.timing}　服務 ${st.provider || '—'}`);
    L.push(`音訊段　　：${st.chunks} 段（靜音 ${st.silent}、來不及送 ${st.dropped}、錯誤 ${st.errors}）`
      + (st.lastError ? `　最後錯誤：${st.lastError}` : ''));
    L.push(`音量 RMS　：平均 ${avgRms === null ? '—' : avgRms.toFixed(4)}`
      + (avgRms !== null && avgRms < 0.004 ? '　⚠️ 幾乎是靜音——DRM 可能讓擷取到的聲音變成空白' : ''));
    L.push(`辨識句數　：${st.segments} 句　已顯示 ${st.shown} 次　因有官方字幕略過 ${st.skippedNoCc} 次`);
    L.push(`耗時　　　：辨識中位數 ${median(st.asrMs) ?? '—'}ms　上傳到回來 ${median(st.roundMs) ?? '—'}ms`
      + `　講完 → 中文出現 中位數 ${median(st.latency) ?? '—'}ms`);
    L.push(`今日用量　：${Math.round(st.usedSec / 60)} / ${Math.round(st.capSec / 60)} 分鐘`);
    if (pairs.length) {
      L.push('與官方字幕並排（最近 ' + pairs.length + ' 句）：');
      for (const p of pairs.slice(-20)) {
        L.push(`　[${p.t.toFixed(1)}s] ASR：${p.asr}`);
        L.push(`　　　　　 CC ：${p.cc}`);
      }
    }
  });

  T.hud.push((L) => {
    if (!opts.on && !st.chunks) return;
    L.push(`${'語音辨識'.padEnd(6, '　')}${opts.on ? '擷取中' : '停止'}　${st.segments} 句　延遲 ${median(st.latency) ?? '—'}ms　錯誤 ${st.errors}`);
  });

  // =========================================================================
  // 語音辨識實驗室（src/test/asr-lab.html）的橋
  //
  // 實驗室是擴充功能自己的分頁，碰不到 F1TV 的 DOM。它需要知道「影片現在播到哪、幾倍速、
  // 有沒有靜音、官方字幕寫了什麼」才能把逐字稿的時間對上、判斷聲音拿不拿得到，
  // 也需要叫這裡改播放速度、把影片靜音、把收好的逐字稿疊在影片上。
  //
  // ⚠️ 實驗室每 5 秒送一次心跳；12 秒沒收到就停止回報——實驗室分頁關掉之後不能一直送訊息。
  // =========================================================================
  const lab = { watchUntil: 0, timer: null, cues: null, show: false, lastCc: '' };

  function mainVideo() {
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area) { best = v; area = a; }
    }
    return best;
  }

  function labSend(o) {
    try { chrome.runtime.sendMessage(Object.assign({ target: 'asrLab' }, o)).catch(() => {}); } catch (e) { /* 擴充功能重新載入過 */ }
  }

  function labTick() {
    if (Date.now() > lab.watchUntil) { clearInterval(lab.timer); lab.timer = null; return; }
    const v = mainVideo();
    labSend({
      type: 'sample', wall: Date.now(),
      t: v ? v.currentTime : null, rate: v ? v.playbackRate : null, paused: v ? v.paused : null,
      muted: v ? v.muted : null, volume: v ? v.volume : null, ended: v ? v.ended : null,
      duration: v && isFinite(v.duration) ? v.duration : null,
      cid: T.api.contentId ? T.api.contentId() : null, title: document.title, url: location.href,
      ccVerdict: T.api.subtitleTrackVerdict(), live: T.api.isLive(),
    });
  }

  T.message.push((m) => {
    if (!/^asrLab/.test(m.type)) return;
    const v = mainVideo();
    if (m.type === 'asrLabWatch') {
      lab.watchUntil = m.on === false ? 0 : Date.now() + 12000;
      if (lab.watchUntil && !lab.timer) lab.timer = setInterval(labTick, 250);
      return;
    }
    if (m.type === 'asrLabRate') {
      if (!v) return labSend({ type: 'rateResult', ok: false, error: '找不到影片' });
      const want = Number(m.rate) || 1;
      try { v.playbackRate = want; } catch (e) { /* 播放器可能擋 */ }
      // 播放器可能在下一個 tick 把速度改回去——過一秒再讀一次才知道有沒有生效
      setTimeout(() => labSend({ type: 'rateResult', ok: true, requested: want, actual: v.playbackRate }), 1000);
      return;
    }
    if (m.type === 'asrLabVideoMute') {
      if (!v) return labSend({ type: 'muteResult', ok: false, error: '找不到影片' });
      v.muted = !!m.muted;
      setTimeout(() => labSend({ type: 'muteResult', ok: true, requested: !!m.muted, actual: v.muted }), 500);
      return;
    }
    if (m.type === 'asrLabTranscript') {
      lab.cues = Array.isArray(m.cues) ? m.cues.filter((c) => c.start !== null && c.start !== undefined) : null;
      lab.show = !!m.on && !!lab.cues && lab.cues.length > 0;
      if (!lab.show) hide();
    }
  });

  // 官方字幕：實驗室拿來算準確率與時間偏移
  T.native.push((text) => {
    if (Date.now() > lab.watchUntil || text === lab.lastCc) return;
    lab.lastCc = text;
    const v = mainVideo();
    labSend({ type: 'cc', wall: Date.now(), t: v ? v.currentTime : null, text });
  });

  // 把收好的逐字稿疊在影片上（與官方字幕同一個時間軸，對不對得上一眼就看得出來）
  T.poll.push(() => {
    if (!lab.show || opts.on) return;
    const v = mainVideo();
    if (!v) return;
    const t = v.currentTime;
    const hit = lab.cues.find((c) => t >= c.start && t <= (c.end || c.start + 3) + 0.3);
    if (hit) show({ en: hit.en, zh: hit.zh }, 400);
    else if (Date.now() >= hideAt) hide();
  });

  // ---- 設定 ----
  function applyOpts(v) {
    const o = v || {};
    opts.on = !!o.on;
    opts.when = o.when === 'nocc' ? 'nocc' : 'always';
    opts.timing = o.timing === 'aligned' ? 'aligned' : 'late';
    if (!opts.on) { queue = []; hide(); }
  }
  chrome.storage.local.get('asrTest', (r) => applyOpts(r && r.asrTest));
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.asrTest) applyOpts(ch.asrTest.newValue); });
})();
