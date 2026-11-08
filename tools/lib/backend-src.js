/**
 * 後端原始碼的唯一讀取點（2026-10-28 拆檔）
 *
 * 後端原本是一支 14,000 行的 backend/src/index.js。現在依功能拆在
 * backend/src/parts/NN-名稱.js，**依檔名順序接起來就是原本那一份**——
 * 所有片段共用同一個作用域（不是 ESM 模組彼此 import），所以行為與拆檔前逐字相同。
 *
 *   readBackend()      接好的完整原始碼（建置、檢查工具、模擬器都用這個）
 *   backendParts()     [{ file, text }]，依順序
 *   locate(line)       接好之後的第 N 行 → { file, line }（錯誤訊息用）
 *   BACKEND_LABEL      在訊息裡指稱後端原始碼時用的名稱
 *
 * ⚠️ 新增片段：檔名用兩位數字開頭決定順序。`export default`（fetch 處理）一定在最後一片。
 * ⚠️ 不要再建立 backend/src/index.js——兩份來源一定會漂移，check-all 會擋。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'backend', 'src', 'parts');
const BACKEND_LABEL = 'backend/src/parts/*.js';

function backendParts() {
  return fs.readdirSync(DIR)
    .filter((f) => /^\d{2}-[\w-]+\.js$/.test(f))
    .sort()
    .map((f) => ({ file: 'backend/src/parts/' + f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }));
}

function readBackend() {
  return backendParts().map((p) => p.text).join('');
}

/** 接好的原始碼寫成暫存檔（需要「一個檔案路徑」的工具用：TypeScript、node --check、vm 的 filename）。 */
function backendFile(ext = '.js') {
  const f = path.join(require('os').tmpdir(), `pitlingo-backend-${process.pid}${ext}`);
  fs.writeFileSync(f, readBackend());
  return f;
}

/**
 * 把「本賽季免費體驗」關掉的原始碼（2026-11-03）。
 * 活動期間比賽週與本季票停賣——驗購買流程的檢查（結帳、方案矩陣、折扣、折抵、授權碼外洩）
 * 要在「活動沒開」的世界裡驗，那套流程換季後照樣要用。活動本身由 check-license-security 的「本賽季免費體驗」把它打開來驗。
 * ⚠️ 找不到那一行就直接丟錯：改了寫法卻沒人發現的話，這些檢查會在活動開著的情況下默默全部改測別的東西。
 */
function withoutFreeSeason(src) {
  const re = /const FREE_SEASON_YEAR = \d+;/;
  if (!re.test(src)) throw new Error('withoutFreeSeason：找不到 const FREE_SEASON_YEAR = …;（07-pricing-schedule.js）');
  // let：check-license-security 要在同一份環境裡把活動打開驗一次（FREE_SEASON_YEAR = SEASON_YEAR）
  return src.replace(re, () => 'let FREE_SEASON_YEAR = 0;');
}

function locate(line) {
  let n = line;
  for (const p of backendParts()) {
    const count = p.text.split('\n').length - (p.text.endsWith('\n') ? 1 : 0);
    if (n <= count) return { file: p.file, line: n };
    n -= count;
  }
  return { file: BACKEND_LABEL, line };
}

module.exports = { readBackend, withoutFreeSeason, backendFile, backendParts, locate, BACKEND_LABEL, PARTS_DIR: DIR };
