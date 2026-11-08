#!/usr/bin/env node
/**
 * 語音逐字稿組裝（extension/src/test/asr-assemble.js，只在測試版）。
 *
 * 收割逐字稿的正確性全靠這支，而它壞掉時**不會報錯**：
 *   · 重疊區沒去重 → 每 15 秒重複一兩個字，逐字稿讀起來像結巴
 *   · 去重太兇 → 切點附近的字消失
 *   · 段回來的順序亂了沒排 → 句子前後顛倒
 *   · 2 倍速時時間沒換算 → 逐字稿的時間全部偏掉一半，播放時字幕對不上
 *   · 跳轉（seek）後還硬算時間 → 字幕出現在錯的地方
 *
 * 用法：node tools/check-asr-assemble.js
 */
const path = require('path');
const A = require(path.join(__dirname, '..', 'extension/src/test/asr-assemble.js'));

let failed = 0;
const expect = (c, m, d) => { if (c) console.log('✅ ' + m); else { failed++; console.log('❌ ' + m + (d !== undefined ? '：' + JSON.stringify(d).slice(0, 400) : '')); } };

// 一段「講話」：每個字 0.4 秒，從牆上時間 base 開始
const SPEECH = 'Verstappen pits from the lead. Norris stays out on older tyres. The safety car is coming in this lap. Leclerc has the fastest lap of the race so far.'
  .split(' ');
const WORD_MS = 400;
const T0 = 1_000_000;
const truth = SPEECH.map((w, i) => ({ w, startWall: T0 + i * WORD_MS, endWall: T0 + i * WORD_MS + 350 }));

/** 模擬 offscreen 切段：段長 chunkSec、重疊 overlapSec，回傳每段「辨識出」的字（段內秒數）。 */
function chunkify(chunkSec, overlapSec, totalMs) {
  const out = [];
  let ws = T0;
  let seq = 0;
  while (ws < T0 + totalMs) {
    const we = ws + chunkSec * 1000;
    seq++;
    const words = truth
      // 被切點切到的字辨識不出來（只收完整落在段內的字）
      .filter((t) => t.startWall >= ws && t.endWall <= we)
      .map((t) => ({ w: t.w, start: (t.startWall - ws) / 1000, end: (t.endWall - ws) / 1000, c: 0.95 }));
    out.push({ type: 'asr-result', ok: true, seq, wallStart: ws, wallEnd: we, overlapSec, words, audioSec: chunkSec });
    ws = we - overlapSec * 1000;
  }
  out[out.length - 1].final = true;
  return out;
}
const joined = (asm) => asm.sentences.map((s) => s.en).join(' ');
const total = SPEECH.length * WORD_MS + 500;

// ---- 1. 重疊區去重：每個字剛好一次 ----
{
  const asm = A.createAssembler({ overlapSec: 2 });
  for (const c of chunkify(5, 2, total)) asm.add(c);
  asm.finish();
  expect(joined(asm) === SPEECH.join(' '), '重疊 2 秒：每個字剛好出現一次、順序正確', joined(asm));
  expect(asm.stats.dupWordsDropped > 0, '重疊區確實有重複的字被丟掉（不是剛好沒重疊）', asm.stats);
}

// ---- 2. 沒有重疊時，切點上的字會掉（證明重疊有用）----
{
  const asm = A.createAssembler({ overlapSec: 0 });
  for (const c of chunkify(5, 0, total)) asm.add(c);
  asm.finish();
  const lost = SPEECH.length - asm.stats.words;
  expect(lost > 0, `沒有重疊：切點上的 ${lost} 個字不見（對照組，證明重疊是必要的）`);
}

// ---- 3. 亂序回來 ----
{
  const asm = A.createAssembler({ overlapSec: 2 });
  const cs = chunkify(5, 2, total);
  const order = cs.slice().reverse();
  for (const c of order) asm.add(c);
  asm.finish();
  expect(joined(asm) === SPEECH.join(' '), '段回來的順序完全顛倒：組出來仍然一樣', joined(asm));
  const asm2 = A.createAssembler({ overlapSec: 2 });
  asm2.add(cs[1]);
  expect(asm2.sentences.length === 0 && asm2.pendingCount() === 1, '第 2 段先到：先放著，不會搶先處理');
}

// ---- 4. 中間一段失敗：後一段的重疊區整段收下 ----
{
  const cs = chunkify(5, 2, total);
  cs[2] = Object.assign({}, cs[2], { ok: false, words: [], error: 'HTTP 502' });
  const asm = A.createAssembler({ overlapSec: 2 });
  for (const c of cs) asm.add(c);
  asm.finish();
  const got = A.normWords(joined(asm));
  // 失敗那段獨有的字（不在前後段裡）一定救不回來；但後一段重疊區的字要救回來
  const inNeighbours = new Set();
  for (const i of [1, 3]) for (const w of cs[i].words) inNeighbours.add(cs[i].wallStart + w.start * 1000);
  const recoverable = truth.filter((t) => t.startWall >= cs[2].wallStart && t.startWall < cs[2].wallEnd && inNeighbours.has(t.startWall));
  const recovered = recoverable.filter((t) => got.includes(A.normWords(t.w)[0])).length;
  expect(recovered === recoverable.length, `中間一段失敗：前後段聽得到的 ${recoverable.length} 個字都救回來`, { recovered, recoverable: recoverable.map((x) => x.w) });
  const counts = {};
  for (const w of got) counts[w] = (counts[w] || 0) + 1;
  const dup = Object.entries(counts).filter(([w, n]) => n > SPEECH.filter((x) => A.normWords(x)[0] === w).length);
  expect(!dup.length, '救回來的同時沒有重複的字', dup);
  expect(asm.stats.failed === 1, '失敗段數有記下來');
}

// ---- 5. 回報遺失：skipMissing 繼續往下 ----
{
  const cs = chunkify(5, 2, total);
  const asm = A.createAssembler({ overlapSec: 2 });
  for (const c of cs) if (c.seq !== 2) asm.add(c);
  expect(asm.sentences.length === 0 || asm.nextSeq() === 2, '第 2 段的回報沒到：後面的段先卡住等它');
  const skipped = asm.skipMissing();
  asm.finish();
  expect(skipped === 1 && asm.stats.skipped === 1 && asm.stats.words > 0, '跳過遺失的段之後繼續組裝', asm.stats);
}

// ---- 6. 斷句：句尾標點、停頓、長度上限 ----
{
  const asm = A.createAssembler({ overlapSec: 2 });
  for (const c of chunkify(5, 2, total)) asm.add(c);
  asm.finish();
  expect(asm.sentences.length === 4 && asm.sentences.every((s) => /[.]$/.test(s.en)), '依句尾標點切成 4 句', asm.sentences.map((s) => s.en));

  const asm2 = A.createAssembler({ overlapSec: 0, gapSec: 0.7 });
  asm2.add({ seq: 1, ok: true, wallStart: 0, wallEnd: 10000, final: true, words: [
    { w: 'box', start: 0, end: 0.3 }, { w: 'box', start: 0.4, end: 0.7 },
    { w: 'copy', start: 2.0, end: 2.3 }, { w: 'that', start: 2.4, end: 2.7 },
  ] });
  asm2.finish();
  expect(asm2.sentences.length === 2, '沒有標點但停頓超過 0.7 秒：切成兩句', asm2.sentences.map((s) => s.en));

  const long = Array.from({ length: 60 }, (_, i) => ({ w: 'word' + i, start: i * 0.3, end: i * 0.3 + 0.25 }));
  const asm3 = A.createAssembler({ overlapSec: 0 });
  asm3.add({ seq: 1, ok: true, wallStart: 0, wallEnd: 20000, final: true, words: long });
  asm3.finish();
  expect(asm3.sentences.every((s) => s.n <= 28 && (s.endWall - s.startWall) / 1000 <= 10.5), '一直講不停：每句不超過 28 字、10 秒', asm3.sentences.map((s) => s.n));
}

// ---- 7. 靜音段 ----
{
  const cs = chunkify(5, 2, total);
  const asm = A.createAssembler({ overlapSec: 2 });
  asm.add({ type: 'asr-chunk', silent: true, seq: 1, wallStart: T0 - 3000, wallEnd: T0 + 2000, overlapSec: 2 });
  for (const c of cs) asm.add(Object.assign({}, c, { seq: c.seq + 1 }));
  asm.finish();
  expect(asm.stats.silent === 1 && joined(asm) === SPEECH.join(' '), '開頭有一段靜音：不影響後面的組裝', joined(asm));
}

// ---- 8. 牆上時間 → 影片時間 ----
{
  const samples = [
    { wall: 0, t: 100, rate: 1, paused: false },
    { wall: 1000, t: 101, rate: 1, paused: false },
    { wall: 2000, t: 102, rate: 2, paused: false },   // 這裡改成 2 倍速
    { wall: 3000, t: 104, rate: 2, paused: false },
    { wall: 4000, t: 106, rate: 2, paused: true },    // 暫停
    { wall: 5000, t: 106, rate: 2, paused: true },
    { wall: 6000, t: 106, rate: 2, paused: false },
    { wall: 7000, t: 300, rate: 2, paused: false },   // 跳轉
    { wall: 8000, t: 302, rate: 2, paused: false },
  ];
  const m = A.createMediaMapper(samples);
  const near = (a, b) => a !== null && Math.abs(a - b) < 1e-6;
  expect(near(m(500), 100.5), '1 倍速：0.5 秒後在 100.5 秒');
  expect(near(m(2500), 103), '2 倍速：牆上 0.5 秒＝影片 1 秒');
  expect(near(m(4500), 106), '暫停中：影片時間不動');
  expect(m(6500) === null, '跳轉的那一秒內：回 null（不猜）', m(6500));
  expect(near(m(7500), 301), '跳轉之後：用新的位置繼續算', m(7500));
  expect(m(20000) === null, '樣本斷了超過 5 秒：回 null', m(20000));
}

// ---- 9. 字錯率與官方字幕比對 ----
{
  const e = A.wordErrors('The safety car is coming in this lap.', 'the safety car is coming in this lap');
  expect(e.edits === 0 && e.similarity === 1, '大小寫與標點不算錯');
  const e2 = A.wordErrors('Verstappen pits from the lead', 'Max Verstappen pits from lead');
  expect(e2.edits === 2 && e2.ref === 5, '多一個字、少一個字＝2 個錯', e2);
  expect(A.wordErrors('', 'hello').similarity === null, '官方字幕是空的：相似度是 null（不是 0 分）');
  expect(A.normWords("Hamilton’s car. It's OK!").join(' ') === "hamilton's car it's ok", '彎引號與標點正規化');

  const cues = [
    { start: 10, en: 'Verstappen pits from the lead.' },
    { start: 14, en: 'Norris stays out.' },
    { start: 75, en: 'Safety car in this lap.' },
  ];
  const cc = [
    { t: 11, text: 'Verstappen pits from the lead.' },
    { t: 11.5, text: 'Verstappen pits from the lead.' },    // 同一句在畫面上停留被回報兩次
    { t: 15, text: 'Norris stays out.' },
    { t: 76, text: 'The safety car is in this lap.' },
  ];
  const r = A.compareWithCc(cues, cc, 60);
  expect(r.windows.length === 2 && r.windows[0].similarity === 1, '官方字幕重複回報的同一句只算一次', r.windows);
  expect(r.similarity !== null && r.similarity < 1 && r.similarity > 0.7, '整體相似度把各時間窗加總（不是平均百分比）', r);
  const off = A.estimateOffset(cues, cc);
  expect(off && Math.abs(off.offsetSec - 1) < 1e-6 && off.n === 3, '估計時間偏移：官方字幕晚 1 秒', off);
}

console.log('');
if (failed) { console.log(`❌ 語音逐字稿組裝有 ${failed} 項未通過`); process.exit(1); }
console.log('✅ 語音逐字稿組裝全部通過');
