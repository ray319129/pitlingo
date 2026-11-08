/**
 * 語音辨識測試：擷取分頁聲音 → 切段 → 上傳辨識 → 把結果交回 service worker／實驗室頁。
 *
 * ⚠️ **只存在於測試版。** 一般使用者安裝的正式版沒有這個檔案、沒有 tabCapture 權限。
 *
 * 兩種用法（`mode`）：
 *   live  即時字幕：每 N 秒一段、每段各自翻譯，結果顯示在分頁上的黃框（原本那一種）
 *   lab   語音辨識實驗室（src/test/asr-lab.html）：預設**只量音量、不上傳**；
 *         實驗室按「收割」時才開始上傳，而且每段不翻譯、要逐字時間，段與段重疊，
 *         收完整份再一起翻（見 asr-assemble.js）
 *
 * 流程：
 *   設定頁（使用者手勢）取得 streamId → service worker 開這個 offscreen document
 *   → getUserMedia 拿到分頁聲音 →（監聽開著時）接回喇叭
 *   → AudioWorklet 降到 16 kHz → 切段 WAV → POST /v1/asr/test
 *
 * ⚠️ **擷取分頁聲音時 Chrome 會把分頁本身靜音**，使用者聽到的是這裡接回喇叭的那一路。
 *    所以「不監聽」＝喇叭沒聲音、但擷取照樣有聲音——這就是「靜音收割」，實驗室會實測它成不成立。
 * ⚠️ 已知限制：擷取的是「正在播出的聲音」，結果一定晚於聲音——即時這條路**不可能有提前量**。
 */
'use strict';

let ctx = null;
let stream = null;
let src = null;
let node = null;
let cfg = null;
let monitoring = false;
let chunks = [];
let chunkLen = 0;
let chunkWall = 0;
let seq = 0;
let session = 0;
let inflight = 0;
let levelSq = 0;
let levelN = 0;
let levelPeak = 0;
let levelTimer = null;
const SAMPLE_RATE = 16000;
const MAX_INFLIGHT = 3;
// 低於這個 RMS 視為靜音，不上傳（省錢，也用來判斷 DRM 讓擷取到的聲音變成靜音）
const SILENCE_RMS = 0.004;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'asr-start') {
    start(msg).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'asr-config') { sendResponse(configure(msg)); return false; }
  if (msg.type === 'asr-status') { sendResponse(status()); return false; }
  if (msg.type === 'asr-stop') { stop(); sendResponse({ ok: true }); return false; }
  return false;
});

function status() {
  return {
    ok: true, capturing: !!stream, mode: cfg && cfg.mode, upload: !!(cfg && cfg.upload),
    monitor: monitoring, chunkSec: cfg && cfg.chunkSec, overlapSec: cfg && cfg.overlapSec,
    session, seq, inflight, sampleRate: ctx ? ctx.sampleRate : null, tabId: cfg && cfg.tabId,
  };
}

async function start(m) {
  stop();
  cfg = {
    mode: m.mode === 'lab' ? 'lab' : 'live',
    tabId: m.tabId, backend: m.backend, asrKey: m.asrKey, clientToken: m.clientToken,
    chunkSec: Number(m.chunkSec) || 5,
    overlapSec: Number(m.overlapSec) || 0,
    // 即時模式一開始就上傳並逐段翻譯；實驗室模式先只量音量
    upload: m.mode === 'lab' ? !!m.upload : true,
    translate: m.mode === 'lab' ? !!m.translate : true,
    words: m.mode === 'lab' ? m.words !== false : false,
    tag: '',
  };
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId } },
    video: false,
  });
  ctx = new AudioContext();
  src = ctx.createMediaStreamSource(stream);
  setMonitor(m.monitor !== false);
  await ctx.audioWorklet.addModule('asr-worklet.js');
  node = new AudioWorkletNode(ctx, 'pl-asr-capture');
  node.port.onmessage = (ev) => onFrames(ev.data);
  // worklet 要被「拉」才會處理：接到一個音量 0 的 gain 再到 destination
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute).connect(ctx.destination);
  stream.getAudioTracks().forEach((t) => { t.onended = () => report({ type: 'asr-ended' }); });
  resetChunk();
  seq = 0;
  session = Date.now();
  // 音量每 0.5 秒回報一次：實驗室的音量表與「聲音拿不拿得到」靠它
  levelTimer = setInterval(() => {
    const rms = levelN ? Math.sqrt(levelSq / levelN) : 0;
    report({ type: 'asr-level', rms, peak: levelPeak, wall: Date.now(), monitor: monitoring, frames: levelN });
    levelSq = 0; levelN = 0; levelPeak = 0;
  }, 500);
  report({ type: 'asr-started', sampleRate: ctx.sampleRate, session, monitor: monitoring });
}

/** 監聽＝把擷取到的聲音接回喇叭。關掉就是「靜音收割」：喇叭沒聲音，擷取照樣收。 */
function setMonitor(on) {
  if (!src || !ctx) return;
  try { src.disconnect(ctx.destination); } catch (e) { /* 本來就沒接 */ }
  if (on) src.connect(ctx.destination);
  monitoring = !!on;
}

/** 實驗室在擷取中途改設定：開始／停止收割、監聽、段長、測試標籤。 */
function configure(m) {
  if (!cfg || !stream) return { ok: false, error: '目前沒有在擷取——請到 F1TV 分頁點擴充功能圖示，按「開啟語音辨識實驗室」' };
  if (m.monitor !== undefined) setMonitor(!!m.monitor);
  const wasUploading = cfg.upload;
  for (const k of ['chunkSec', 'overlapSec']) if (m[k] !== undefined) cfg[k] = Number(m[k]) || 0;
  for (const k of ['translate', 'words']) if (m[k] !== undefined) cfg[k] = !!m[k];
  if (m.tag !== undefined) cfg.tag = String(m.tag || '');
  if (m.upload !== undefined) {
    cfg.upload = !!m.upload;
    if (!wasUploading && cfg.upload) {
      // 新的一輪收割：從現在開始切段、段號從 1 開始，實驗室靠段號依序接起來
      resetChunk();
      seq = 0;
      session = Date.now();
    } else if (wasUploading && !cfg.upload) {
      // 停止時把手上不滿一段的聲音也送出去（標 final），否則最後幾秒會不見
      if (chunkLen >= SAMPLE_RATE) flush(true);
      resetChunk();
    }
  }
  return status();
}

function stop() {
  if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* noop */ }
  try { if (ctx) ctx.close(); } catch (e) { /* noop */ }
  stream = null; ctx = null; node = null; src = null; monitoring = false;
  resetChunk();
}

function resetChunk() { chunks = []; chunkLen = 0; chunkWall = 0; }

function onFrames(frame) {
  if (!cfg) return;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768;
    levelSq += v * v;
    const a = v < 0 ? -v : v;
    if (a > levelPeak) levelPeak = a;
  }
  levelN += frame.length;
  if (!cfg.upload) return;
  // 這一批的第一個樣本大約是「現在往前推這批的長度」
  if (!chunkWall) chunkWall = Date.now() - (frame.length / SAMPLE_RATE) * 1000;
  chunks.push(frame);
  chunkLen += frame.length;
  if (chunkLen >= SAMPLE_RATE * (cfg.chunkSec || 5)) flush(false);
}

function flush(final) {
  const pcm = new Int16Array(chunkLen);
  let off = 0;
  for (const c of chunks) { pcm.set(c, off); off += c.length; }
  const wallStart = chunkWall;
  const wallEnd = wallStart + (pcm.length / SAMPLE_RATE) * 1000;
  // 重疊：把這段最後 overlapSec 秒留下來當下一段的開頭，跨在切點上的字兩段都聽得到
  const keep = final ? 0 : Math.min(pcm.length, Math.round((cfg.overlapSec || 0) * SAMPLE_RATE));
  if (keep > 0) {
    chunks = [pcm.slice(pcm.length - keep)];
    chunkLen = keep;
    chunkWall = wallEnd - (keep / SAMPLE_RATE) * 1000;
  } else {
    resetChunk();
  }
  seq++;

  let sq = 0;
  for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; sq += v * v; }
  const rms = Math.sqrt(sq / Math.max(1, pcm.length));
  const base = {
    seq, session, wallStart, wallEnd, rms, final: !!final, mode: cfg.mode, tag: cfg.tag,
    overlapSec: final ? 0 : (cfg.overlapSec || 0), audioSec: pcm.length / SAMPLE_RATE,
  };

  if (rms < SILENCE_RMS) { report(Object.assign({ type: 'asr-chunk', silent: true }, base)); return; }
  if (inflight >= MAX_INFLIGHT) { report(Object.assign({ type: 'asr-chunk', dropped: true }, base)); return; }
  upload(encodeWav(pcm), base);
}

async function upload(wav, base) {
  inflight++;
  const t0 = Date.now();
  const q = [];
  if (!cfg.translate) q.push('translate=0');
  if (cfg.words) q.push('words=1');
  try {
    const r = await fetch(cfg.backend + '/v1/asr/test' + (q.length ? '?' + q.join('&') : ''), {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', 'x-asr-key': cfg.asrKey, 'x-client-token': cfg.clientToken || '' },
      body: wav,
    });
    const d = await r.json().catch(() => ({}));
    report(Object.assign({}, d, base, { type: 'asr-result', ok: r.ok && d.ok !== false, status: r.status, roundMs: Date.now() - t0 }));
  } catch (e) {
    report(Object.assign({}, base, { type: 'asr-result', ok: false, error: String((e && e.message) || e), roundMs: Date.now() - t0 }));
  } finally {
    inflight--;
  }
}

function encodeWav(pcm) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

function report(o) {
  try {
    chrome.runtime.sendMessage(Object.assign({ target: 'sw', tabId: cfg && cfg.tabId }, o)).catch(() => {});
  } catch (e) { /* noop */ }
}
