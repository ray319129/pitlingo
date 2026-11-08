#!/usr/bin/env node
/**
 * 檢查「譯文錯開一格」的防線（2026-11-05）
 *
 * 共用快取約 2% 的句子拿到「後一句」的譯文：模型在一批裡合併或跳過一行，之後的編號
 * 照樣連續往下編。以前 translateBatch 只照編號對應，抓不到。這支用假模型重現：
 *
 *   1. 合併一行並重新編號（最後一號消失）→ 偵測到、拆半重翻，每一句都對上自己的譯文
 *   2. 編號完整、但從某一句起內容錯開（本句的名字全不見、拿到下一句的名字）→ 同上
 *   3. 跨行句（英文一句被切成兩行，模型把後半的名字譯在前一行、但本句名字還在）→ **不擋**
 *      （擋了就永遠進不了快取、每一輪重付錢）
 *   4. 每一次呼叫的費用都加總（坑 #44）；中途失敗時已付的錢跟著錯誤帶出去
 *   5. 呼叫次數有上限（一批 20 句最多 27 次；最底層剩 ≤ 5 句逐句翻）
 *   6. 清理用的寬鬆偵測（shiftSuspectIdx）抓得到錯開、不抓正常句
 *
 *   node tools/check-realign.js
 */
'use strict';
const vm = require('vm');
const { readBackend } = require('./lib/backend-src');

let failed = 0;
const expect = (c, m) => { if (c) console.log('✅ ' + m); else { failed++; console.log('❌ ' + m); } };

let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

const NAMES = ['verstappen', 'hamilton', 'bottas', 'leclerc', 'norris', 'piastri', 'russell', 'alonso'];
/** 假譯文：「譯」＋英文裡出現的名字（首字大寫）＋原句的數字編號（不可以放英文——偵測器會把譯文裡的英文字當名字） */
const ids = new Map();
const idOf = (en) => { if (!ids.has(en)) ids.set(en, ids.size + 1); return ids.get(en); };
const zhOf = (en) => '譯' + NAMES.filter((n) => en.includes(n)).map((n) => ' ' + n[0].toUpperCase() + n.slice(1)).join('') + '〈' + idOf(en) + '〉';

let mode = 'ok';
let calls = 0;
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
const sandbox = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
  Response: class {}, Request: class {}, URL, console: { log() {}, warn() {}, error() {} },
  Date, Math, JSON, Map, Set, Promise, RegExp, Error, Object, Array, String, Number, Boolean,
  parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
  caches: { default: { async match() {}, async put() {}, async delete() {} } },
  fetch: async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    const msg = body.messages[0].content;
    if (mode === 'fail' && calls === 2) return { ok: false, status: 529, async text() { return 'overloaded'; } };
    if (!msg.startsWith('【批次翻譯】')) {
      return { ok: true, async json() { return { content: [{ type: 'text', text: zhOf(msg) }], stop_reason: 'end_turn', usage }; } };
    }
    const lines = msg.split('\n').slice(1).map((l) => l.replace(/^\d+\.\s/, ''));
    let zh = lines.map(zhOf);
    if (mode === 'merge' || mode === 'fail') {
      // 第 3、4 句（索引 2、3）合併成一行，後面重新連續編號 → 少一號、從第 3 句起錯開
      const k = lines.findIndex((l) => l.includes('mergeme'));
      if (k >= 0 && k + 1 < lines.length) zh = zh.slice(0, k).concat([zhOf(lines[k] + ' ' + lines[k + 1])], zh.slice(k + 2));
    }
    if (mode === 'shift') {
      // 編號完整，但從含 shiftme 的那一句起，每一句拿到下一句的譯文、最後一句自己補了一句
      const k = lines.findIndex((l) => l.includes('shiftme'));
      if (k >= 0) zh = zh.slice(0, k).concat(zh.slice(k + 1), ['譯〈補〉']);
    }
    const text = zh.map((z, i) => `${i + 1}. ${z}`).join('\n');
    return { ok: true, async json() { return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }; } };
  },
};
vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__tb = translateBatch; globalThis.__ss = shiftSuspectIdx;', sandbox);
const env = { ANTHROPIC_API_KEY: 'x' };

const batch = (special) => Array.from({ length: 20 }, (_, i) => {
  const n = NAMES[i % NAMES.length];
  if (i === 2 && special) return `${special} and ${n} goes wide`;
  return `line ${i} with ${n} on track`;
});
const allRight = (lines, out) => lines.every((l) => out[l] === zhOf(l));

(async () => {
  // 0) 正常：一次呼叫、全部對上
  mode = 'ok'; calls = 0;
  let L = batch('');
  let r = await sandbox.__tb(env, L);
  expect(calls === 1 && allRight(L, r.out) && !r.realigned, `正常的一批：1 次呼叫、20 句全對（${calls} 次）`);

  // 1) 合併一行並重新編號
  mode = 'merge'; calls = 0;
  L = batch('mergeme');
  r = await sandbox.__tb(env, L);
  const wrong = L.filter((l) => r.out[l] && r.out[l] !== zhOf(l));
  expect(wrong.length === 0, `合併一行＋重新編號：沒有任何一句拿到別句的譯文（錯 ${wrong.length} 句）`);
  expect(r.realigned > 0, `偵測到並重翻（realigned=${r.realigned}）`);
  expect(calls <= 27, `呼叫次數有上限：${calls} 次（≤ 27）`);
  expect(r.usage.output_tokens === usage.output_tokens * calls, `每一次呼叫的費用都加總：output ${r.usage.output_tokens} = ${usage.output_tokens} × ${calls}`);
  const got = L.filter((l) => r.out[l]).length;
  expect(got === 20, `20 句全部翻得出來（${got}/20；最底層剩 ≤ 5 句逐句翻）`);

  // 2) 編號完整、內容錯開
  mode = 'shift'; calls = 0;
  L = batch('shiftme');
  r = await sandbox.__tb(env, L);
  const wrong2 = L.filter((l) => r.out[l] && r.out[l] !== zhOf(l));
  expect(r.realigned > 0 && wrong2.length === 0, `編號完整但內容錯開：偵測到、沒有錯句（錯 ${wrong2.length} 句，realigned=${r.realigned}）`);

  // 3) 跨行句：本句名字還在，下一句的名字譯在前一行 → 不擋
  mode = 'ok'; calls = 0;
  const strad = ['hulkenberg s very close to norris a hundredth', 'second away from max verstappen', 'line 3 with alonso'];
  const fakeOut = ['Hulkenberg 很接近 Norris，差 Verstappen 百分之一秒', '有點震驚 Verstappen', '譯 Alonso'];
  const map = {}; fakeOut.forEach((z, i) => { map[i + 1] = z; });
  const cut = vm.runInContext('alignBreak', sandbox)(strad, map);
  expect(cut === -1, `跨行句（本句名字還在）不擋：alignBreak = ${cut}`);

  // 4) 中途失敗：已付的錢跟著錯誤帶出去
  mode = 'fail'; calls = 0;
  let caught = null;
  try { await sandbox.__tb(env, batch('mergeme')); } catch (e) { caught = e; }
  expect(caught && caught.usage && caught.usage.output_tokens === usage.output_tokens,
    `重翻途中失敗：錯誤帶著前面已付的費用（output ${caught && caught.usage && caught.usage.output_tokens}）`);

  // 5) 寬鬆偵測
  const en = ['with valtteri bottas', 'well thank you to dc and to jolyon', 'line with leclerc'];
  const zh = ['感謝 DC 和 Jolyon 的精彩分析', '也感謝 Lando Norris', '譯 Leclerc'];
  const idx = sandbox.__ss(en, zh);
  expect(idx.length === 1 && idx[0] === 0, `寬鬆偵測抓到「with valtteri bottas → 感謝 DC 和 Jolyon」：${JSON.stringify(idx)}`);
  const ok = sandbox.__ss(['line with leclerc', 'line with norris'], ['譯 Leclerc', '譯 Norris']);
  expect(ok.length === 0, '正常句不抓');

  if (failed) { console.log(`\n❌ ${failed} 項未通過`); process.exit(1); }
  console.log('\n✅ 錯開防線全部通過');
})().catch((e) => { console.log('❌ ' + (e.stack || e)); process.exit(1); });
