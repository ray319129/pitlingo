#!/usr/bin/env node
/**
 * 一次跑完所有檢查。
 *
 * 存在的理由很實際：檢查工具愈來愈多，靠記憶一支一支跑就會漏。
 * v0.4.0 出包正是因為只跑了 `node --check` 就交出去（坑 #22）。
 *
 * 用法：node tools/check-all.js
 */
const { execFileSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');

const SYNTAX = [
  'extension/src/content/main.js',
  'extension/src/content/inject.js',
  'extension/src/background/sw.js',
  'extension/src/shared/normalize.js',
  'extension/src/shared/defaults.js',
  'extension/src/shared/live-delay.js',
];

const CHECKS = [
  ['normKey 兩份一致（後端／擴充功能）', 'tools/check-normkey.js'],
  ['譯文守門兩份一致且套在每條路徑上', 'tools/check-guard.js'],
  ['SYSTEM_PROMPT 快取門檻（≥ 4,096 tokens）', 'tools/check-prompt.js'],
  ['事件日誌沒有被丟掉的參數', 'tools/check-logcalls.js'],
  ['擴充功能可實際執行（抓 --check 抓不到的）', 'tools/smoke-extension.js'],
  ['補上官方漏掉的字幕（輪詢真的跑、影片真的在播）', 'tools/check-gapfill.js'],
  ['沒有引用不存在的名稱（try/catch 會把 ReferenceError 吞掉）', 'tools/check-undeclared.js'],
  ['擴充功能使用者看得到的行為（直播免費額度／總開關／原生字幕／授權即時生效）', 'tools/check-extension-behavior.js'],
  ['管理版收割佇列（只接手自己開的頁、蓋章才算完成、逾時與沒字幕）', 'tools/check-admin-harvest.js'],
  ['直播延遲畫面（進直播／LIVE 鍵／重新錨定／拔河上限／DVR 不夠深）', 'tools/check-live-delay.js'],
  ['網站共用頁首頁尾逐字相同（沒有建置流程，靠這支擋漂移）', 'tools/site-chrome.js', ['--check']],
  ['注入層（worker hook 語法 + 絕不攔媒體分段）', 'tools/check-inject.js'],
  ['正規表示式全部編譯得起來（--check 抓不到）', 'tools/check-regex.js'],
  ['後端資安與維運邏輯（權杖／分流／汙染防護／成本）', 'tools/check-backend.js'],
  ['亂操作防呆（15 個情境，不可有未捕捉的例外）', 'tools/chaos-extension.js'],
  ['設定頁的 HTML／CSS／JS 一致性', 'tools/check-options.js'],
  ['後台與後端一致（端點都有 UI、危險操作有確認）', 'tools/check-admin.js'],
  // ⚠️ 分類、標題、覆蓋率的失敗全都是靜默的：slug 掉了不報錯，
  //    關鍵字互相踩到也不報錯，後台照樣畫得出漂亮的分組。
  ['分類與收割覆蓋率（slug 不可掉、關鍵字不可互相踩）', 'tools/check-coverage.js'],
  ['網站可編輯內容（葉節點、鍵不撞名、法律文件不開放、發布前核對系統數字）', 'tools/check-site-content.js'],
  ['成本記錄對得上帳單（四種 token、失敗前已付的錢、拒答）', 'tools/check-cost-recording.js'],
  ['譯文錯開一格的防線（合併重編號、內容錯開、跨行不擋、費用加總、呼叫上限）', 'tools/check-realign.js'],
  ['翻譯清單的時間軸（只收有譯文的句子、搭蓋章那一次寫入、用戶端讀不到、絕對／相對時間）', 'tools/check-line-times.js'],
  ['後台成長統計（起算日、台灣時間分日、付費比對、只讀不寫、快取）', 'tools/check-growth.js'],
  ['寄信內容可在後台編輯（9 種信、必要區塊、純文字、連結白名單、系統數字核對、歷史）', 'tools/check-mail-content.js'],
  ['KV 寫入預算（直播不可以撞上免費方案的每日上限）', 'tools/check-kv-budget.js'],
  ['翻譯統計在多個 isolate 之下不會互相蓋掉（A11）', 'tools/check-stats-merge.js'],
  ['F1TV 賽事頁的真實時程：解析、驗證、直接開（A4／A13／A17）', 'tools/check-f1tv-schedule.js'],
  ['共用快取的寫入緩衝在房間裡（晚加入的觀眾拿得到、isolate 回收不掉句子，A15）', 'tools/check-room-flush.js'],
  // ⚠️ 兩個方向都是災難：寫鬆了第二把鎖等於沒有，寫緊了連你自己都進不去。
  ['後台防護（TOTP 對得上手機、鎖定、白名單、稽核）', 'tools/check-admin-auth.js'],
  // ⚠️ 驗簽少一項檢查，登入仍然完全正常——只是變成可以偽造。
  ['Google 登入（偽造 token 一律擋下）', 'tools/check-auth-google.js'],
  // ⚠️ 每一條規則拿掉都不會讓登入壞掉，只會讓它可以被攻破——
  //    次數上限、單次有效、只存雜湊、冷卻，四項都回種驗證過會變紅。
  ['Email 驗證碼登入（猜碼／並發／重放／明碼／轟炸／撤銷）', 'tools/check-auth-email.js'],
  ['網站登入工作階段（HttpOnly cookie／CSRF／CORS／登出即失效）', 'tools/check-auth-session.js'],
  ['授權碼外洩處置（認領用購買信箱且不是探針／只能解除自己這台／後台換發／訂單頁不回碼）', 'tools/check-license-security.js'],
  ['代訂自營（D1 庫存／密碼加密與查看紀錄／全域查詢即時）', 'tools/check-resell.js'],
  ['帳本（真實收支：訂單快照、綠界手續費、台灣時間分月、只能作廢不能刪）', 'tools/check-ledger.js'],
  // ⚠️ **這支以前不在清單裡，而且一直是紅的。** 假的模型回應少了 `type:'text'`，
  //    於是「有沒有人拿到字幕」永遠量成 0；假的 Response 少了 `ok`，
  //    於是 DO 那條路永遠沒被走到。工具存在不等於有人在跑它。
  ['直播多人並發（N 個觀眾不可以付 N 倍）', 'tools/check-live-concurrency.js'],
  ['前導收割端巡查（場次開始 10 分鐘沒有前導端就寄信、每 5 分鐘的 cron 只做巡查）', 'tools/check-leader-watch.js'],
  ['逐句紀錄（每個請求一筆、每一句都有去向、不存原文、重複翻分得出三種）', 'tools/check-line-log.js'],
  // 2026-10-16：上面那支只驗「10 個請求同時到」的一瞬間，修正前後都是綠的——擋不住 handoff 6.2 的 S1。
  //    這支讓 30 個虛擬觀眾照擴充功能的節奏看 10 分鐘，驗 S1（重複付費）、S3（KV 額度用完不 500）、S4（告警不狂問 AuthGuard）
  ['多人直播人潮模擬（重複付費、KV 額度用完、告警）', 'tools/sim-live-swarm.js', ['--check']],
  // ⚠️ 一個重複的鍵會讓**每一次部署都失敗**，而錯誤訊息把出錯那行原樣印出來，
  //    看起來像「正在套用這個設定」——我因此連續兩次把失敗當成成功。
  ['wrangler.toml（重複鍵會讓部署整個失敗）', 'tools/check-wrangler.js'],
  ['法律文件與程式碼一致（權限／保存期限／價格／法規要件）', 'tools/check-legal.js'],
  ['所有超連結指向正確位置', 'tools/check-links.js'],
  // ⚠️ 擋「檔案存在但沒有任何頁面載入」。2026-09-30 的 reveal.js 就是這樣：
  //    建好了、部署了，零頁引用，而 check-all 從頭到尾是綠的。
  ['legal/ 的素材都有人用（孤兒檔與斷引用）', 'tools/check-assets-used.js'],
  // ⚠️ ?v= 一旦發佈就凍結一年（_headers 給 max-age=31536000）。
  //    內容改了卻沒換 ?v=，使用者永遠拿不到新版，而且完全不報錯。
  ['網站資產的 ?v= 等於內容雜湊', 'tools/bump-assets.js', ['--check']],
  ['跨產物一致（免費層／長度上限／快取版本／條款數字）', 'tools/check-consistency.js'],
  ['方案組合矩陣（每一種搭配的金額與授權都要正確）', 'tools/check-plan-matrix.js'],
  ['折扣與促銷（只限通行證、不疊加、最長 31 天、續訂只給付過錢的）', 'tools/check-promo.js'],
  ['彈幕（尚未發行：四道門、合併廣播、影子禁言、1,000 人、KV 0 寫入）', 'tools/check-danmaku.js'],
  ['升級折抵沒有漏財（贈送的一週不可折抵）', 'tools/check-credit.js'],
  ['系統信（總計＝實付、網站同款樣式、驗證碼信無登入連結、後台新路徑）', 'tools/check-mail.js'],
  ['已登入時預填 email（不覆蓋使用者輸入）', 'tools/check-login-email.js'],
  ['語音辨識測試端點（金鑰門、每日上限、幻覺過濾、不進共用快取、整份翻譯）', 'tools/check-asr.js'],
  ['語音逐字稿組裝（重疊去重、亂序、失敗段、倍速與暫停的時間換算、字錯率）', 'tools/check-asr-assemble.js'],
  // ⚠️ 正式版不可以帶任何測試程式碼（__pitlingo.t、語音辨識、tabCapture 權限）。
  //    以前靠「上線前手動刪掉 TESTING 區塊」，現在由建置產生正式版並在這裡證明一行都沒有。
  ['擴充功能正式版／測試版建置（正式版沒有測試程式碼）', 'tools/build-extension.js', ['--check']],
  // ⚠️ 語音辨識的測試端點只在測試後端（f1zh-api-test）；正式後端部署的是移除測試程式碼後的建置結果
  ['後端正式版／測試版建置（正式後端沒有語音辨識；wrangler 設定正確）', 'tools/build-backend.js', ['--check']],
  ['翻譯品質沒有靜默退化（固定測試資料）', 'tools/check-fixtures.js'],
];

let failed = 0;

function run(label, args) {
  try {
    const out = execFileSync(process.execPath, args, { cwd: root, stdio: 'pipe' }).toString();
    console.log(`✅ ${label}`);
    // ⚠️ **通過但有警告時一定要印出來。**
    //    「沒有測試資料所以跳過」如果被吞掉，就等於那項檢查永遠不存在，
    //    而畫面上還是一片綠 —— 這個專案最不能接受的就是這種靜默。
    out.split(String.fromCharCode(10)).filter((l) => l.includes('⚠'))
      .forEach((l) => console.log('     ' + l.trim()));
  } catch (e) {
    failed++;
    console.log(`❌ ${label}`);
    const out = ((e.stdout || '') + (e.stderr || '')).toString().trim();
    if (out) out.split('\n').forEach((l) => console.log('     ' + l));
  }
}

console.log('── 語法 ──');
for (const f of SYNTAX) run(f, ['--check', f]);

/**
 * ⚠️ **`node --check` 對 ESM 檔案有盲點。**
 *
 * 後端（`backend/src/parts/` 接起來）是 ES module（`export default`），但副檔名是 `.js`，
 * 於是 `node --check` 用 **CommonJS** 的方式解析它——實測會**放行**
 * 下面這種錯誤，而 wrangler 用的 esbuild 直接爆掉：
 *
 *     async function handleRequest(r, e) {
 *       { ... }
 *     },        ← 多餘的逗號
 *     };        ← 多餘的分號
 *
 * 實際發生過：CORS 重構把 `export default { async fetch() }` 拆成獨立函式時，
 * 尾端的 `},\n};` 沒改乾淨。`check-all` 全綠，`wrangler deploy` 失敗，
 * 而錯誤訊息只有一個行號——**測試綠燈卻部署不了，比紅燈更浪費時間**。
 *
 * 修法是複製成 `.mjs` 再檢查一次：`.mjs` 強制走 ESM 解析，
 * 這種錯誤就抓得到（實測 `.js` exit 0、`.mjs` exit 1）。
 */
{
  const fs = require('fs');
  const os = require('os');
  // 後端拆成片段（backend/src/parts/），單片不是合法程式——接起來才檢查
  const { readBackend, BACKEND_LABEL } = require('./lib/backend-src');
  if (fs.existsSync(path.join(root, 'backend/src/index.js'))) {
    console.log('❌ backend/src/index.js 又出現了——後端原始碼只在 backend/src/parts/，兩份一定會漂移');
    failed++;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-esm-'));
  const copy = path.join(tmp, 'backend.mjs');
  fs.writeFileSync(copy, readBackend());
  run(`${BACKEND_LABEL}（接起來、以 ESM 解析）`, ['--check', copy]);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* noop */ }
}

// JSON 檔沒有 `node --check` 可用，但壞掉的後果更嚴重：
// manifest.json 不合法 → 擴充功能整個載入不了。
// 實際發生過一次（腳本先開寫入模式清空檔案才讀取），所以納入檢查。
for (const f of ['extension/manifest.base.json', 'extension/manifest.test.json']) {
  run(f, ['-e', `JSON.parse(require('fs').readFileSync(${JSON.stringify(f)}, 'utf8'))`]);
}

console.log('\n── 契約與行為 ──');
// 第三個元素是額外參數（例如 --check）。沒有就當空陣列。
for (const [label, script, extra] of CHECKS) run(label, [script, ...(extra || [])]);

console.log('');
if (failed) {
  console.log(`❌ ${failed} 項未通過，請修正後再提交`);
  process.exit(1);
}
console.log('✅ 全部通過');
