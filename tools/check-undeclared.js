#!/usr/bin/env node
/**
 * 引用了不存在的名稱（變數、函式）—— **node --check、esbuild、vm 測試全部放行的那一類 bug**。
 *
 * 為什麼需要：2026-09-17 端對端實測發現，「付款成功後把訂單標成已付款」那段程式碼
 * 從訂單管理上線那天起就放錯了函式——放在診斷回報的 handler 裡。那裡沒有
 * `orderId`／`lic`／`mailed`，一執行就是 ReferenceError，**被 try/catch 靜靜吞掉**。
 * 結果每一筆付款成功的訂單在後台永遠是「未完成付款」，而所有檢查一片綠：
 *
 *   node --check   只看語法，名稱存不存在它不管
 *   esbuild        打包時也不管
 *   check-backend  那條路徑沒有測試走到；走到了也被 try/catch 吞掉
 *
 * 這支用 TypeScript 的型別檢查器（只讀，不改任何檔案、不需要 tsconfig）
 * 找 TS2304「Cannot find name」與 TS2552「did you mean」。
 * 驗證過：對修正前的後端跑，正好抓到那 13 處。
 *
 * ⚠️ TypeScript 不是這個專案的相依套件。找不到時**印黃色警告、不擋**——
 *    和 check-fixtures 一樣，不吭聲的話這項檢查等於不存在。
 *    安裝方式：`npm i -g typescript`
 *
 * 用法：node tools/check-undeclared.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');

function loadTs() {
  const tries = ['typescript'];
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  // 全域安裝的位置，以及常見 CLI 內附的那一份（vercel、wrangler 等）
  const globalDirs = [path.join(appdata, 'npm', 'node_modules'), '/usr/local/lib/node_modules', '/usr/lib/node_modules'];
  for (const g of globalDirs) {
    tries.push(path.join(g, 'typescript'));
    try {
      for (const pkg of fs.readdirSync(g)) tries.push(path.join(g, pkg, 'node_modules', 'typescript'));
    } catch (e) { /* 目錄不存在 */ }
  }
  for (const t of tries) {
    try { return require(t); } catch (e) { /* 下一個 */ }
  }
  return null;
}

const ts = loadTs();
if (!ts) {
  console.log('⚠️  找不到 TypeScript —— 「引用不存在的名稱」這一類 bug 目前無法偵測（npm i -g typescript）');
  process.exit(0);
}

const EXT_ROOT = process.env.PL_EXT_ROOT;   // 建置出來的版本（build-extension --check）
const FILES = EXT_ROOT ? [] : [
  'extension/src/content/main.js', 'extension/src/content/inject.js',
  'extension/src/background/sw.js', 'extension/src/options/options.js',
  'extension/src/shared/defaults.js', 'extension/src/shared/normalize.js', 'extension/src/shared/live-delay.js',
  'extension/src/test/asr-content.js', 'extension/src/test/offscreen.js', 'extension/src/test/options-test.js',
  'extension/src/test/asr-worklet.js', 'extension/src/test/asr-lab.js', 'extension/src/test/asr-assemble.js',
  'legal/buy.js', 'legal/account.js', 'legal/paid.js', 'legal/contact.js', 'legal/site-content.js',
];

// 後台的程式碼寫在 secret-pitstop.html 裡，抽出來另存暫存檔再檢查
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-undeclared-'));
const extra = [];
if (EXT_ROOT) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) extra.push(p);
  });
  walk(path.join(EXT_ROOT, 'src'));
}
if (!EXT_ROOT) {
  const html = fs.readFileSync(path.join(root, 'legal/secret-pitstop.html'), 'utf8');
  let i = 0;
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/application\/json/.test(m[1])) continue;
    const f = path.join(tmp, `secret-pitstop.html-${i++}.js`);
    fs.writeFileSync(f, m[2]);
    extra.push(f);
  }
}

// 執行環境提供、但標準 lib 沒有宣告的名稱
const RUNTIME_GLOBALS = new Set([
  'chrome', 'caches', 'HTMLRewriter', 'DurableObject', 'WebSocketPair', 'WebSocketRequestResponsePair', 'importScripts', 'google',
  'GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest', 'GM_registerMenuCommand', 'GM_addStyle',
  'GM_setClipboard', 'GM_info', 'unsafeWindow',
  // AudioWorklet 的全域（語音辨識測試的 asr-worklet.js）
  'AudioWorkletProcessor', 'registerProcessor', 'sampleRate',
  // asr-assemble.js 同時給擴充功能頁與 Node 測試用（typeof module 判斷）
  'module',
]);

// 後端拆成片段（共用一個作用域），單獨檢查每一片會把別片的宣告當成不存在——接起來檢查
const backendTmp = path.join(tmp, 'backend.js');
if (!EXT_ROOT) { fs.writeFileSync(backendTmp, require('./lib/backend-src').readBackend()); extra.push(backendTmp); }

const program = ts.createProgram([...FILES.map((f) => path.join(root, f)), ...extra], {
  allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, types: [],
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.webworker.importscripts.d.ts'],
});

const hits = [];
for (const d of ts.getPreEmitDiagnostics(program)) {
  if (![2304, 2552, 18004].includes(d.code) || !d.file) continue;
  const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  const name = (msg.match(/'([^']+)'/) || [])[1];
  if (RUNTIME_GLOBALS.has(name)) continue;
  const { line } = d.file.getLineAndCharacterOfPosition(d.start);
  const isBackend = path.resolve(d.file.fileName) === path.resolve(backendTmp);
  if (isBackend) { const at = require('./lib/backend-src').locate(line + 1); hits.push(`${at.file}:${at.line}  ${msg}`); continue; }
  const file = d.file.fileName.startsWith(tmp.replace(/\\/g, '/')) || d.file.fileName.startsWith(tmp)
    ? 'legal/secret-pitstop.html（內嵌腳本）' : path.relative(root, d.file.fileName);
  hits.push(`${file}:${line + 1}  ${msg}`);
}
fs.rmSync(tmp, { recursive: true, force: true });

if (hits.length) {
  console.log(`❌ 引用了不存在的名稱（${hits.length} 處）—— 執行到那一行就是 ReferenceError，被 try/catch 包住時完全不會報錯`);
  hits.forEach((h) => console.log('   ' + h));
  process.exit(1);
}
console.log(`✅ ${FILES.length + extra.length} 支檔案沒有引用不存在的名稱（TypeScript ${ts.version}）`);
