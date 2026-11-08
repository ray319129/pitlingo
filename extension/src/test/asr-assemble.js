/**
 * 語音逐字稿的組裝（**只存在於測試版**，實驗室頁與 tools/check-asr-assemble.js 共用）。
 *
 * 收割時聲音被切成重疊的段（例如 15 秒一段、前後重疊 2 秒），每段各自辨識、各自回來，
 * 而且**回來的順序不一定是送出的順序**。這裡負責：
 *
 *   1. 依段號排好再處理（晚到的段先放著）
 *   2. 重疊區只留一份：以重疊區的中點為界，前一段管前半、後一段管後半。
 *      中點附近的字在兩段裡都是完整的，切在邊緣才會半個字
 *   3. 前一段失敗或來不及送時，後一段的重疊區整段留下（能救多少救多少）
 *   4. 字 → 句：停頓、句尾標點、長度上限
 *   5. 牆上時間 → 影片時間：用內容腳本每 0.25 秒回報的播放位置內插，
 *      所以**暫停、倍速、中途改速度**都自然算得對；跳轉（seek）附近的時間無法確定就回 null
 *   6. 與官方字幕比對的字錯率（WER）
 *
 * ⚠️ 純函式、不碰 chrome.*，才測得了。
 */
(function (root) {
  'use strict';

  const END_PUNCT = /[.?!]["')\]]?$/;

  function createAssembler(opts) {
    const o = Object.assign({ overlapSec: 2, gapSec: 0.7, maxSentenceSec: 10, maxWords: 28, minWordsForPunct: 4 }, opts || {});
    const pending = new Map();
    let nextSeq = 1;
    let prevCut = -Infinity;      // 上一段管到哪個牆上時間（ms）
    let open = null;              // 還沒結束的句子
    const sentences = [];
    const stats = { chunks: 0, ok: 0, silent: 0, dropped: 0, failed: 0, words: 0, dupWordsDropped: 0, audioSec: 0, skipped: 0 };

    function closeOpen() {
      if (open && open.words.length) {
        sentences.push({
          startWall: open.words[0].startWall,
          endWall: open.words[open.words.length - 1].endWall,
          en: open.words.map((w) => w.w).join(' '),
          n: open.words.length,
        });
      }
      open = null;
    }

    function pushWord(w) {
      if (open) {
        const last = open.words[open.words.length - 1];
        const gap = (w.startWall - last.endWall) / 1000;
        const dur = (w.endWall - open.words[0].startWall) / 1000;
        if (gap > o.gapSec || dur > o.maxSentenceSec || open.words.length >= o.maxWords) closeOpen();
      }
      if (!open) open = { words: [] };
      open.words.push(w);
      stats.words++;
      if (END_PUNCT.test(w.w) && open.words.length >= o.minWordsForPunct) closeOpen();
    }

    // 上一段切點之後的字先扣著：下一段成功就丟掉（下一段也聽到了），
    // 下一段沒有字（失敗、來不及送、靜音）就放出來——那是唯一聽到它們的一段
    let heldTail = [];

    function processChunk(c) {
      stats.chunks++;
      const ws = Number(c.wallStart) || 0;
      const we = Number(c.wallEnd) || ws;
      const ov = c.final ? 0 : (c.overlapSec !== undefined ? Number(c.overlapSec) : o.overlapSec) || 0;
      const cut = c.final ? Infinity : we - ov * 500;
      if (c.silent || c.dropped || !c.ok) {
        if (c.silent) stats.silent++; else if (c.dropped) stats.dropped++; else stats.failed++;
        for (const w of heldTail) pushWord(w);
        heldTail = [];
        // 這段沒有字：下一段的重疊區要整段收下，不要以這段的切點為界
        prevCut = -Infinity;
        return;
      }
      stats.dupWordsDropped += heldTail.length;
      heldTail = [];
      stats.ok++;
      stats.audioSec += Number(c.audioSec) || (we - ws) / 1000;
      const words = (c.words || []).slice().sort((a, b) => a.start - b.start);
      for (const w of words) {
        const x = { w: w.w, startWall: ws + w.start * 1000, endWall: ws + w.end * 1000 };
        if (x.startWall < prevCut) { stats.dupWordsDropped++; continue; }
        if (x.startWall >= cut) { heldTail.push(x); continue; }
        pushWord(x);
      }
      prevCut = cut;
    }

    function drain() {
      while (pending.has(nextSeq)) {
        const c = pending.get(nextSeq);
        pending.delete(nextSeq);
        nextSeq++;
        processChunk(c);
      }
    }

    return {
      /** 每一段的回報（asr-result 或 asr-chunk）都要丟進來，包含靜音與失敗——段號才接得起來。 */
      add(c) {
        if (!c || !(c.seq >= 1)) return;
        if (c.seq < nextSeq || pending.has(c.seq)) return;   // 重複的回報
        pending.set(c.seq, c);
        drain();
      },
      /** 某一段的回報遲遲不來（訊息遺失）：跳過缺的段號，把後面已到的處理掉。 */
      skipMissing() {
        if (!pending.size) return 0;
        const min = Math.min(...pending.keys());
        const n = min - nextSeq;
        if (n > 0) {
          // 遺失的段與失敗的段一樣：上一段扣著的尾巴要放出來
          stats.skipped += n; nextSeq = min; prevCut = -Infinity;
          for (const w of heldTail) pushWord(w);
          heldTail = [];
        }
        drain();
        return n;
      },
      /** 收割結束：處理手上所有的段、把最後一句收尾。 */
      finish() {
        while (pending.size) this.skipMissing();
        for (const w of heldTail) pushWord(w);   // 最後一段沒標 final（例如擷取被中斷）時，尾巴也要收
        heldTail = [];
        closeOpen();
      },
      pendingCount: () => pending.size,
      nextSeq: () => nextSeq,
      sentences,
      stats,
      openText: () => (open ? open.words.map((w) => w.w).join(' ') : ''),
    };
  }

  /**
   * 牆上時間（ms）→ 影片時間（秒）。samples：[{ wall, t, rate, paused }]，依 wall 排序。
   * 兩個樣本之間發生跳轉（實際位置與推算差超過 tolSec）時，那個區間回 null。
   */
  function createMediaMapper(samples, opts) {
    const tol = (opts && opts.tolSec) || 1.5;
    return function mediaAt(wall) {
      if (!samples.length) return null;
      let lo = 0, hi = samples.length - 1;
      if (wall < samples[0].wall) {
        const s = samples[0];
        if (s.wall - wall > 5000) return null;
        return s.t - (s.paused ? 0 : ((s.wall - wall) / 1000) * (s.rate || 1));
      }
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (samples[mid].wall <= wall) lo = mid; else hi = mid - 1;
      }
      const s = samples[lo];
      const n = samples[lo + 1];
      if (n) {
        const predicted = s.t + (s.paused ? 0 : ((n.wall - s.wall) / 1000) * (s.rate || 1));
        if (Math.abs(predicted - n.t) > tol) return null;   // 這段期間跳轉過
      } else if (wall - s.wall > 5000) {
        return null;                                         // 樣本斷了太久，不猜
      }
      return s.t + (s.paused ? 0 : ((wall - s.wall) / 1000) * (s.rate || 1));
    };
  }

  function normWords(text) {
    return String(text || '').toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z0-9']+/g, ' ')
      .split(' ')
      .map((w) => w.replace(/^'+|'+$/g, ''))
      .filter(Boolean);
  }

  /** 字錯率：以官方字幕為準（ref），語音辨識為待測（hyp）。 */
  function wordErrors(refText, hypText) {
    const r = Array.isArray(refText) ? refText : normWords(refText);
    const h = Array.isArray(hypText) ? hypText : normWords(hypText);
    if (!r.length) return { edits: h.length, ref: 0, hyp: h.length, wer: null, similarity: null };
    let prev = new Array(h.length + 1);
    for (let j = 0; j <= h.length; j++) prev[j] = j;
    for (let i = 1; i <= r.length; i++) {
      const cur = new Array(h.length + 1);
      cur[0] = i;
      for (let j = 1; j <= h.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    const edits = prev[h.length];
    const wer = edits / r.length;
    return { edits, ref: r.length, hyp: h.length, wer, similarity: Math.max(0, 1 - wer) };
  }

  /**
   * 以固定長度的影片時間窗比對整份逐字稿與官方字幕。
   * cues：[{ start, en }]（start 為影片秒數，null 的略過）；cc：[{ t, text }]
   * 官方字幕在畫面上是「一段文字停留一陣子」，同一句會被回報多次——先去重。
   */
  function compareWithCc(cues, cc, windowSec) {
    const win = windowSec || 60;
    const seen = new Set();
    const ccu = [];
    for (const x of cc) {
      const k = String(x.text || '').trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      ccu.push({ t: x.t, text: k });
    }
    const times = cues.filter((c) => c.start !== null && c.start !== undefined).map((c) => c.start)
      .concat(ccu.map((x) => x.t));
    if (!times.length) return { windows: [], edits: 0, ref: 0, similarity: null };
    const t0 = Math.floor(Math.min(...times) / win) * win;
    const t1 = Math.max(...times);
    const windows = [];
    let edits = 0, ref = 0;
    for (let a = t0; a <= t1; a += win) {
      const b = a + win;
      const hyp = cues.filter((c) => c.start !== null && c.start >= a && c.start < b).map((c) => c.en).join(' ');
      const r = ccu.filter((x) => x.t >= a && x.t < b).map((x) => x.text).join(' ');
      const e = wordErrors(r, hyp);
      if (!e.ref) { windows.push({ from: a, to: b, similarity: null, ref: 0, hyp: e.hyp }); continue; }
      edits += e.edits; ref += e.ref;
      windows.push({ from: a, to: b, similarity: e.similarity, ref: e.ref, hyp: e.hyp });
    }
    return { windows, edits, ref, similarity: ref ? Math.max(0, 1 - edits / ref) : null };
  }

  /**
   * 估計時間偏移：每一句找時間最近、字重疊最多的官方字幕，取（官方字幕時間 − 這句開始時間）的中位數。
   * 正值＝逐字稿比官方字幕早。官方字幕本身也有顯示延遲，所以這是「對齊到官方字幕」的偏移，不是絕對值。
   */
  function estimateOffset(cues, cc) {
    const diffs = [];
    for (const c of cues) {
      if (c.start === null || c.start === undefined) continue;
      const cw = new Set(normWords(c.en));
      if (cw.size < 3) continue;
      let best = null;
      for (const x of cc) {
        if (Math.abs(x.t - c.start) > 15) continue;
        const xw = normWords(x.text);
        if (!xw.length) continue;
        const inter = xw.filter((w) => cw.has(w)).length;
        const score = inter / Math.max(cw.size, xw.length);
        if (score >= 0.5 && (!best || score > best.score)) best = { score, t: x.t };
      }
      if (best) diffs.push(best.t - c.start);
    }
    if (!diffs.length) return null;
    diffs.sort((a, b) => a - b);
    return { offsetSec: diffs[Math.floor(diffs.length / 2)], n: diffs.length };
  }

  const api = { createAssembler, createMediaMapper, normWords, wordErrors, compareWithCc, estimateOffset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PLAsrAssemble = api;
})(typeof self !== 'undefined' ? self : this);
