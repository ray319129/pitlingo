#!/usr/bin/env node
/**
 * 後端的正式版與測試版（2026-09-17，使用者決定「語音辨識的測試端點拆到獨立的測試後端」）
 *
 *   backend/dist/release/index.js   正式後端 f1zh-api（api.pitlingo.com）——所有 @test-only 區塊移除
 *   backend/dist/test/index.js      測試後端 f1zh-api-test（f1zh-api-test.pitlingo.workers.dev）——完整，
 *                                   但靠 PITLINGO_ROLE=asr-test 只開 /v1/asr/* 與 /v1/health
 *
 * 原始碼只有一份（backend/src/parts/*.js，依檔名順序接起來），標記與擴充功能相同：
 *   /* @test-only:start *\/  …  /* @test-only:end *\/
 *
 * ⚠️ **不需要手動跑。** wrangler.toml 與 wrangler.test.toml 都設了 `[build] command`，
 *    `wrangler deploy` 會先執行這支——不然有一天會部署到上一次建置的舊檔。
 * ⚠️ 檢查工具（check-backend、check-asr…）一律讀原始碼 backend/src/parts/（tools/lib/backend-src.js 的 readBackend()，完整版），
 *    正式版的正確性由 --check 保證：移除之後仍以 ESM 解析、仍有完整的正式端點、沒有任何語音辨識。
 *
 * 用法：
 *   node tools/build-backend.js           產生兩份
 *   node tools/build-backend.js --check   在暫存資料夾建置並驗證（check-all 會跑）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readBackend, BACKEND_LABEL } = require('./lib/backend-src');

const root = path.join(__dirname, '..');
const MARK = /\/\* @test-only:start \*\/[\s\S]*?\/\* @test-only:end \*\//g;

function build(outRoot) {
  const text = readBackend();
  const s1 = (text.match(/@test-only:start/g) || []).length;
  const e1 = (text.match(/@test-only:end/g) || []).length;
  if (s1 !== e1) throw new Error(`${BACKEND_LABEL}：@test-only 標記不成對（start ${s1}／end ${e1}）`);
  const release = text.replace(MARK, '');
  for (const [kind, body] of [['release', release], ['test', text]]) {
    fs.mkdirSync(path.join(outRoot, kind), { recursive: true });
    fs.writeFileSync(path.join(outRoot, kind, 'index.js'), body);
  }
  return { release, test: text, markers: s1 };
}

const check = process.argv.includes('--check');
if (!check) {
  const r = build(path.join(root, 'backend/dist'));
  console.log(`✅ backend/dist/release/index.js（正式，移除 ${r.markers} 段測試程式碼）`);
  console.log('✅ backend/dist/test/index.js（測試後端，只開語音辨識）');
  process.exit(0);
}

let failed = 0;
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { failed++; console.log('❌ ' + m); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-backend-'));
let r;
try { r = build(tmp); } catch (e) { bad(e.message); process.exit(1); }

// 1. 正式後端沒有任何測試程式碼
{
  const FORBID = [
    [/@test-only/, '測試標記'], [/\/v1\/asr\//, '語音辨識路由'], [/handleAsr|asrDeepgram|asrOpenAI/, '語音辨識函式'],
    [/ASR_TEST_KEY|DEEPGRAM_API_KEY/, '語音辨識機密'], [/\bE7[0-3]:/, '語音辨識錯誤碼'], [/PITLINGO_ROLE/, '測試後端角色'],
  ];
  const leaks = FORBID.filter(([re]) => re.test(r.release)).map(([, l]) => l);
  leaks.length ? bad('正式後端含有測試程式碼：' + leaks.join('、')) : ok('正式後端沒有語音辨識的任何程式碼（路由、函式、機密名稱、錯誤碼）');
}
// 2. 正式端點一個都沒少（標記包錯範圍時會把正式程式碼一起吃掉，而且不會報錯）
{
  const want = ['/v1/translate', '/v1/subs', '/v1/report', '/v1/config', '/v1/checkout', '/v1/payment/webhook', '/v1/order', 'adminGate(', 'SubtitleRoom', 'async scheduled('];
  const src = readBackend();
  const lost = want.filter((w) => src.includes(w) && !r.release.includes(w));
  lost.length ? bad('正式後端少了這些（標記包太大）：' + lost.join('、')) : ok(`正式後端保留所有正式端點與排程（抽查 ${want.length} 項）`);
  const srcRoutes = (src.match(/path === '\/v1\/[^']+'/g) || []).filter((x) => !/\/v1\/asr\//.test(x)).length;
  const relRoutes = (r.release.match(/path === '\/v1\/[^']+'/g) || []).length;
  srcRoutes === relRoutes ? ok(`路由數量一致（${relRoutes} 處，只少了語音辨識）`) : bad(`路由數量不一致：原始碼扣掉語音辨識 ${srcRoutes}，正式後端 ${relRoutes}`);
}
// 3. 測試後端有語音辨識與角色限制
/\/v1\/asr\/test/.test(r.test) && /PITLINGO_ROLE === 'asr-test'/.test(r.test)
  ? ok('測試後端有語音辨識端點，且只開 /v1/asr/*') : bad('測試後端缺少語音辨識或角色限制');
// 4. 兩份都要能以 ESM 解析（node --check 對 .js 的 ESM 有盲點，見坑 #35）
for (const kind of ['release', 'test']) {
  const f = path.join(tmp, kind, 'index.mjs');
  fs.copyFileSync(path.join(tmp, kind, 'index.js'), f);
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok(`${kind === 'release' ? '正式' : '測試'}後端以 ESM 解析成功`); }
  catch (e) { bad(`${kind === 'release' ? '正式' : '測試'}後端 ESM 解析失敗：` + String(e.stderr || e.message).split('\n').slice(0, 3).join(' ')); }
}
// 5. wrangler 設定：正式與測試都部署建置結果、測試後端沒有網域、排程、Durable Object
{
  const prod = fs.readFileSync(path.join(root, 'backend/wrangler.toml'), 'utf8');
  const test = fs.readFileSync(path.join(root, 'backend/wrangler.test.toml'), 'utf8');
  const line = (t, k) => (t.split(/\r?\n/).find((l) => new RegExp('^' + k + '\\s*=').test(l.trim())) || '');
  // ⚠️ TOML：表頭（[build]、[[routes]]…）之後的鍵都屬於那個表。把 [build] 插在 compatibility_date 前面，
  //    它就靜靜變成 build.compatibility_date——2026-09-17 寫這支時差點這樣部署出去。
  for (const [label, t] of [['wrangler.toml', prod], ['wrangler.test.toml', test]]) {
    const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const firstTable = lines.findIndex((l) => l.startsWith('['));
    const late = ['name', 'main', 'compatibility_date', 'workers_dev']
      .filter((k) => lines.findIndex((l) => new RegExp('^' + k + '\\s*=').test(l)) > firstTable);
    late.length ? bad(`${label}：${late.join('、')} 寫在表頭之後，會被當成那個表的設定`) : ok(`${label}：頂層設定都在表頭之前`);
  }
  /dist\/release\/index\.js/.test(line(prod, 'main')) ? ok('wrangler.toml 部署 dist/release（正式後端不含測試程式碼）')
    : bad('wrangler.toml 的 main 不是 dist/release/index.js——正式後端會帶著語音辨識');
  /build-backend\.js/.test(prod) && /build-backend\.js/.test(test) ? ok('兩份 wrangler 設定都會在部署前自動建置')
    : bad('wrangler 設定沒有 [build] command——可能部署到舊的建置結果');
  /dist\/test\/index\.js/.test(line(test, 'main')) ? ok('wrangler.test.toml 部署 dist/test') : bad('wrangler.test.toml 的 main 不是 dist/test/index.js');
  const testBad = [];
  if (!/name\s*=\s*"f1zh-api-test"/.test(test)) testBad.push('名稱不是 f1zh-api-test（會蓋掉正式後端）');
  if (/\[\[routes\]\]|custom_domain/.test(test.replace(/^\s*#.*$/gm, ''))) testBad.push('有自訂網域／路由');
  if (/\[triggers\]|crons/.test(test.replace(/^\s*#.*$/gm, ''))) testBad.push('有排程（會重複同步賽程、多寄每日彙報）');
  if (/durable_objects|\[\[migrations\]\]/.test(test.replace(/^\s*#.*$/gm, ''))) testBad.push('有 Durable Object');
  if (!/PITLINGO_ROLE\s*=\s*"asr-test"/.test(test)) testBad.push('沒有 PITLINGO_ROLE="asr-test"（會變成第二個正式 API）');
  testBad.length ? bad('wrangler.test.toml：' + testBad.join('、')) : ok('測試後端：獨立名稱、沒有網域、沒有排程、沒有 Durable Object、只開語音辨識');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failed) { console.log(`❌ 後端建置有 ${failed} 項未通過`); process.exit(1); }
console.log('✅ 正式後端與測試後端都建置正確');
