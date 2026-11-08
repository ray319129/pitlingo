#!/usr/bin/env node
/**
 * 注入到 worker 內部的程式碼是**字串**，`node --check inject.js` 只會檢查外層檔案，
 * 字串裡的語法錯誤完全看不到——而它壞掉的後果是「影片還能播，但字幕永遠不出現」，
 * 沒有任何錯誤訊息會浮到我們這邊（那段程式碼跑在 worker 裡，還被 try/catch 包著）。
 *
 * 這支做兩件事：
 *   1. 把 WORKER_HOOK 抽出來實際 `new Function()` 一次，確認語法過得去
 *   2. 用實際的 URL／content-type 樣本驗 `interesting()` 與 `looksText()`
 *      —— 那兩個函式判斷錯的後果是**播放卡頓**，見坑 #33
 *
 * ⚠️ （歷史）**兩份 worker hook 都要驗：擴充功能的 inject.js 與 userscript。**
 * ⚠️ 2026-10-28 起 userscript 封存在 archive/（凍結、不再維護），不再列入比對。
 *    這支以前只讀 inject.js。坑 #33（只看大小不看型別，音訊分段被 clone + 解碼 → 播放卡頓）
 *    在擴充功能修掉了，**userscript 那份一直沒修**——而 userscript 正是收割時開著看的那一個。
 *    規則在一個檔案學到、沒有橫向確認（鐵則 13），2026-09-17 全面檢視才發現。
 *
 * 用法：node tools/check-inject.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };

const TARGETS = [
  ['擴充功能 inject.js', 'extension/src/content/inject.js'],
];

function checkHook(label, src) {
  console.log(`\n── ${label} ──`);
  const pre = (m) => `[${label}] ${m}`;

  // --- 1. 抽出 WORKER_HOOK ---------------------------------------------------
  const m = src.match(/const WORKER_HOOK = `([\s\S]*?)`;\r?\n/);
  if (!m) { bad(pre('找不到 WORKER_HOOK 樣板字串——這支檢查失效了，先修它')); return; }
  // 要重現「樣板字串被求值之後」的樣子，兩件事都得做：
  //   1. ${...} 是產生時代入的，換成不影響語法的常值
  //   2. **跳脫要還原**。檔案裡寫的 `\\.` 在求值後是 `\.`；直接拿原始文字去編譯，
  //      正則會變成「比對一個反斜線」，測出來的行為跟實際跑的完全不同。
  const hook = m[1]
    .replace(/\$\{[^}]*\}/g, '"__x__"')
    .replace(/\\([\s\S])/g, (_, c) => (c === '\\' || c === '`' || c === '$' ? c : '\\' + c));

  try {
    new Function(hook);
    ok(pre('WORKER_HOOK 語法正確（實際編譯過，不是只看檔案）'));
  } catch (e) {
    bad(pre(`WORKER_HOOK 有語法錯誤：${e.message} —— 注入後字幕會完全不出現且不報錯`));
    return;
  }

  // --- 2. 在沙箱裡取出兩個判斷函式 -------------------------------------------
  // hook 是 IIFE，把內部函式掛到 globalThis 才拿得到。
  if (!/function looksText\(/.test(hook)) {
    bad(pre('沒有 looksText() —— 二進位的媒體分段硬解成字串時湊出 "-->"，整段垃圾會被當成字幕送去翻譯'));
  }
  const probe = hook.replace(
    'var of=self.fetch;',
    'self.__interesting=interesting; self.__looksText=(typeof looksText==="function")?looksText:null; var of=self.fetch;');
  const sandbox = {
    self: {}, BroadcastChannel: function () { this.postMessage = () => {}; },
    TextDecoder, console: { log() {} },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(probe, sandbox);

  const interesting = sandbox.__interesting;
  const looksText = sandbox.__looksText;
  if (typeof interesting !== 'function') {
    bad(pre('取不到 interesting()——檢查的探針失效了'));
    return;
  }

  // --- 3. 媒體分段絕對不可以被攔 ---------------------------------------------
  // 這是坑 #33：舊版最後一條規則只看大小（<300KB），HLS 的音訊分段幾乎全部
  // 落在那個範圍內，於是每個分段都被 clone + TextDecoder 解一遍 → 播放卡頓。
  const MEDIA = [
    ['https://cdn.f1tv.com/out/v1/abc/seg_00123.m4s', 'video/mp4', '180000'],
    ['https://cdn.f1tv.com/out/v1/abc/seg_00123.m4s', 'audio/mp4', '48000'],
    ['https://cdn.f1tv.com/out/v1/abc/audio_128k_00042.aac', '', '42000'],
    ['https://cdn.f1tv.com/out/v1/abc/video_5000k_00042.ts', '', '250000'],
    ['https://cdn.f1tv.com/out/v1/abc/init.mp4', 'application/octet-stream', '1200'],
    ['https://cdn.f1tv.com/out/v1/abc/frag_9.cmfv', '', '210000'],
    ['https://cdn.f1tv.com/out/v1/abc/frag_9.cmfa', '', '30000'],
    ['https://cdn.f1tv.com/thumb/x.jpg', 'image/jpeg', '90000'],
    // 型別與副檔名都看不出來、但大小落在舊規則 300KB 以內的音訊分段
    ['https://cdn.f1tv.com/opaque/a/000123', '', '120000'],
  ];
  const leaked = MEDIA.filter(([u, c, l]) => interesting(u, c, l)).map(([u]) => u.split('/').pop());
  leaked.length
    ? bad(pre(`媒體分段被當成可攔截：${leaked.join('、')} —— 會 clone + 解碼每個分段，播放會卡頓`))
    : ok(pre(`${MEDIA.length} 種媒體分段全部被排除`));

  // --- 4. 字幕與清單一定要攔得到 ---------------------------------------------
  const WANT = [
    ['https://cdn.f1tv.com/out/v1/abc/index_14_0.m3u8', 'application/vnd.apple.mpegurl', '40000'],
    ['https://cdn.f1tv.com/out/v1/abc/master.m3u8', '', '8000'],
    ['https://cdn.f1tv.com/out/v1/abc/sub_en_00042.vtt', 'text/vtt', '900'],
    ['https://cdn.f1tv.com/out/v1/abc/subtitle/00042', '', '900'],
    ['https://cdn.f1tv.com/out/v1/abc/manifest.mpd', 'application/dash+xml', '20000'],
    ['https://cdn.f1tv.com/opaque/segment/00042', '', '1500'],   // 判斷不出型別的小回應
  ];
  const missed = WANT.filter(([u, c, l]) => !interesting(u, c, l)).map(([u]) => u.split('/').pop());
  missed.length
    ? bad(pre(`字幕／清單沒被攔到：${missed.join('、')} —— 會失去提前量，字幕退回逐句翻譯`))
    : ok(pre(`${WANT.length} 種字幕與清單全部攔得到`));

  // --- 5. 二進位垃圾不可以被當成文字 -----------------------------------------
  if (typeof looksText !== 'function') return;
  const binary = Array.from({ length: 300 }, (_, i) => String.fromCharCode(i % 7 === 0 ? 0 : (i * 31) % 256)).join('');
  looksText(binary) ? bad(pre('二進位內容被判定成文字')) : ok(pre('含 NUL 的二進位內容被擋下'));

  const binaryNoNul = Array.from({ length: 300 }, (_, i) => String.fromCharCode(1 + (i * 31) % 255)).join('');
  looksText(binaryNoNul) ? bad(pre('大量控制字元的內容被判定成文字')) : ok(pre('大量控制字元的內容被擋下'));

  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nBox box box, Max.\n';
  looksText(vtt) ? ok(pre('正常 VTT 判定為文字')) : bad(pre('正常 VTT 被誤判成二進位 —— 字幕會完全不出現'));

  const m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6.0,\nseg_1.vtt\n';
  looksText(m3u8) ? ok(pre('m3u8 判定為文字')) : bad(pre('m3u8 被誤判成二進位'));

  const cjk = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n進站進站，Max。\n';
  looksText(cjk) ? ok(pre('含中文的內容判定為文字')) : bad(pre('含中文的內容被誤判成二進位'));
}

for (const [label, file] of TARGETS) checkHook(label, fs.readFileSync(path.join(root, file), 'utf8'));

console.log(errors.length ? `\n❌ ${errors.length} 個問題` : '\n✅ 注入層檢查全部通過（兩份 worker hook）');
process.exit(errors.length ? 1 : 0);
