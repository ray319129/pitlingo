#!/usr/bin/env node
/**
 * 把 legal/*.html 裡的 `?v=` 換成該檔案內容的雜湊。
 *
 * ⚠️ **為什麼需要這支：`?v=` 一旦發佈出去，那個網址的內容就凍結一年了。**
 *
 *    `legal/_headers` 給 `/*.js` 與 `/site.css` 的是 `max-age=31536000`。
 *    那是對的——版本化的網址就該永久快取。但它的前提是**內容變了網址就要變**。
 *
 *    今天實際踩到：同一天先後部署兩次，兩次都掛 `?v=5.9`。
 *    第一次載過的瀏覽器把舊的 5.9 存了一年，第二次的修正**永遠不會生效**，
 *    而且完全沒有錯誤訊息——畫面就只是「沒有反應」。
 *    用 curl 檢查還會看到新版（curl 沒有瀏覽器快取），於是更難懷疑到快取頭上。
 *    這是鐵則 #11（傳播延遲是所有快取層的總和）第四次咬人。
 *
 *    手動 bump 版本號解得掉，但那是一個**必須每次都記得**的步驟——
 *    而這次就是忘了。改成用內容雜湊，忘不了：內容一樣雜湊就一樣，
 *    內容變了雜湊必變。
 *
 * 用法：node tools/bump-assets.js        （部署 legal/ 之前跑）
 *      node tools/bump-assets.js --check （只檢查，有漂移就回非零；給 check-all 用）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'legal');
const check = process.argv.includes('--check');

const hash = (f) => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(dir, f))).digest('hex').slice(0, 8);

// ── legal/icon128.png：從 extension/icons 複製（2026-10-02，坑 #74 同一次全面檢查）──
// ⚠️ 它被 .gitignore 排除（「從 extension/icons 複製過去，不重複追蹤」），
//    但**以前沒有任何工具會複製它**——只是這台電腦剛好有一份。
//    換電腦、乾淨 clone 之後部署：9 頁的頁首圖示、favicon、信件圖示全部 404，
//    而所有檢查都是綠的（check-assets-used 把它當進入點，不驗存在）。
//    deploy.js 在跑檢查之前先跑這支，所以放在這裡就涵蓋了部署。
{
  const src = path.join(root, 'extension/icons/icon128.png');
  const dst = path.join(dir, 'icon128.png');
  const same = fs.existsSync(dst) && fs.readFileSync(dst).equals(fs.readFileSync(src));
  if (!same) {
    if (check) {
      console.log('❌ legal/icon128.png ' + (fs.existsSync(dst) ? '與 extension/icons/icon128.png 不同' : '不存在')
        + ' —— 部署後全站頁首圖示與 favicon 會壞\n\n   修法：node tools/bump-assets.js');
      process.exit(1);
    }
    fs.copyFileSync(src, dst);
    console.log('✅ 已從 extension/icons 複製 legal/icon128.png');
  }
}

// `?v=` 指向的資產。**新增一支就要加進來**，漏了就等於那支永遠不會更新。
const assets = fs.readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
const want = Object.fromEntries(assets.map((f) => [f, hash(f)]));

let changed = 0;
const drift = [];

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
  const p = path.join(dir, f);
  const src = fs.readFileSync(p, 'utf8');
  // /site.css?v=xxx 或 /buy.js?v=xxx
  const out = src.replace(/\/([\w.-]+\.(?:js|css))\?v=([\w.]+)/g, (m, file, ver) => {
    const h = want[file];
    if (!h) return m;                       // 不是 legal/ 裡的檔案，別碰
    if (h !== ver) { drift.push(`${f} → ${file}：${ver} ≠ ${h}`); }
    return `/${file}?v=${h}`;
  });
  if (out !== src) {
    changed++;
    if (!check) fs.writeFileSync(p, out);
  }
}

// ── CSP：內嵌腳本的雜湊（2026-10-02）──────────────────────────────────────
// legal/_headers 的 Content-Security-Policy 只放行列出雜湊的內嵌腳本。
// ⚠️ 內嵌腳本改一個字雜湊就變，沒跟著改的話**那一行在每一頁都會被瀏覽器擋掉**，
//    只在 Console 留一行紅字。所以雜湊不手寫，一律從頁面裡算出來。
// 後台（secret-pitstop.html）不套網站 CSP（見 _headers），不算進來；
// type="application/json" 的資料區塊不會被執行，CSP 也不管它。
{
  const hashes = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html') && x !== 'secret-pitstop.html')) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      hashes.add("'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'");
    }
  }
  const hp = path.join(dir, '_headers');
  const hdr = fs.readFileSync(hp, 'utf8');
  const want = [...hashes].sort().join(' ');
  const out = hdr.replace(/(Content-Security-Policy: [^\n]*?script-src 'self' )((?:'sha256-[^']+' ?)+)/, (m, pre) => pre + want + ' ');
  if (!/Content-Security-Policy: [^\n]*script-src 'self' 'sha256-/.test(hdr)) {
    drift.push('_headers 找不到 CSP 的 script-src 雜湊欄位');
  } else if (out !== hdr) {
    drift.push('_headers 的 CSP 雜湊與頁面內嵌腳本不符（內嵌腳本會被瀏覽器擋掉）');
    if (!check) fs.writeFileSync(hp, out);
  }
}

if (check) {
  if (drift.length) {
    console.log('❌ 資產版本與內容不符 —— 部署後使用者會拿到舊檔（快取一年）\n');
    drift.forEach((d) => console.log('   ' + d));
    console.log('\n   修法：node tools/bump-assets.js');
    process.exit(1);
  }
  console.log('✅ 資產版本 = 內容雜湊');
  process.exit(0);
}

console.log(changed ? `✅ 已更新 ${changed} 個 HTML 的 ?v=` : '✅ 已是最新，無需更動');
for (const [f, h] of Object.entries(want)) console.log('   ' + f.padEnd(12) + ' → ' + h);
