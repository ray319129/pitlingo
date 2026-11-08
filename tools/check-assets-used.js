#!/usr/bin/env node
/**
 * 檢查 legal/ 底下的素材是不是真的有人載入
 *
 * 為什麼需要：2026-09-30 做過一次 `reveal.js`——檔案建好了、部署了，
 * 但**沒有任何一頁引用它**，而 `check-all` 從頭到尾是綠的。
 * 原因是當時的檢查寫成「有沒有這個檔案」，不是「有沒有人用這個檔案」。
 * 兩者差一個字，結果差很多：一個是檔案存在，一個是功能存在。
 *
 * 這支擋兩個方向：
 *   A. **孤兒檔**：檔案在 legal/，但沒有任何 HTML 或 CSS 引用它。
 *      → 要嘛忘了掛上去（功能其實沒生效），要嘛該刪（白白佔部署體積）。
 *   B. **斷引用**：HTML/CSS 指向 legal/ 底下不存在的檔案。
 *      → 破圖、樣式整個不生效，而且瀏覽器只會靜靜地 404。
 *
 * ⚠️ 只掃 legal/（會部署的那一包）。tools/、backend/、extension/ 不在範圍。
 *
 *   node tools/check-assets-used.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LEGAL = path.join(__dirname, '..', 'legal');

/** 這些不需要被別人引用，它們本身就是進入點或由平台直接讀取 */
const ENTRY = new Set([
  'index.html', 'buy.html', 'faq.html', 'contact.html', 'paid.html',
  'account.html', 'terms.html', 'privacy.html', '404.html', 'welcome.html',
  'privacy-en.html',       // 英文版隱私權政策：商店的隱私權政策網址欄位填它（2026-10-12）
  'secret-pitstop.html',   // 後台，直接用網址開
  '_headers',              // Cloudflare Pages 讀的設定檔
  'sitemap.xml',           // 搜尋引擎讀的頁面清單（在 Search Console 提交）
  'bimi-logo.svg',         // BIMI 由郵件用戶端依 DNS 取用
  'mail-logo-96.png', 'mail-avatar.png',  // 系統信裡用絕對網址引用
  'icon128.png',           // favicon／manifest／信件共用
  'favicon.ico',           // 瀏覽器自動抓 /favicon.ico（2026-10-03 換新商標時補上）
]);

/** 掃描時要讀內容找引用的檔案類型 */
const TEXT = /\.(html|css|js|json|webmanifest)$/i;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(LEGAL);
const rel = (f) => path.relative(LEGAL, f).replace(/\\/g, '/');

// 把所有文字檔的內容併起來，當作「引用來源」
let haystack = '';
for (const f of files) {
  if (TEXT.test(f)) haystack += '\n' + fs.readFileSync(f, 'utf8');
}

const problems = [];

// ── A. 孤兒檔 ──────────────────────────────────────────────────
for (const f of files) {
  const r = rel(f);
  const base = path.basename(r);
  if (ENTRY.has(base)) continue;
  // ⚠️ 比對用**檔名**不是完整路徑：CSS 寫 url(/img/kerb.jpg)、
  //    HTML 寫 src="/img/kerb.jpg"，而磁碟上的相對路徑是 img/kerb.jpg。
  //    只比檔名會有誤判風險，但同名檔在 legal/ 底下本來就不該出現（見下方 C）。
  if (!haystack.includes(base)) {
    problems.push(`孤兒檔：legal/${r} 沒有任何 HTML 或 CSS 引用它`);
  }
}

// ── B. 斷引用 ──────────────────────────────────────────────────
// 只看指向 legal/ 內部的絕對路徑（/img/x.jpg、/site.css 這種），
// 外部網址與 data: 不在範圍。
const onDisk = new Set(files.map((f) => '/' + rel(f)));
const seen = new Set();
const REF = /(?:src|href)="(\/[^"#?]+)|url\((\/[^)"'?#]+)/g;
let m;
while ((m = REF.exec(haystack))) {
  const p = (m[1] || m[2]).split('?')[0];
  if (seen.has(p)) continue;
  seen.add(p);
  if (p === '/' || p.endsWith('/')) continue;          // 目錄或首頁
  if (/\.(html)$/.test(p)) continue;                   // 頁面用無副檔名網址，另有 check-links 管
  if (!/\.[a-z0-9]{2,5}$/i.test(p)) continue;          // 沒有副檔名＝路由，不是檔案
  if (!onDisk.has(p) && !require('./lib/omitted-media').isOmitted(p)) problems.push(`斷引用：有人指向 ${p}，但 legal${p} 不存在`);
}

// ── C. 同名檔（會讓 A 的檔名比對產生誤判）────────────────────────
const byName = new Map();
for (const f of files) {
  const b = path.basename(rel(f));
  if (!byName.has(b)) byName.set(b, []);
  byName.get(b).push(rel(f));
}
for (const [b, list] of byName) {
  if (list.length > 1) problems.push(`同名檔會讓「有沒有人用」判斷失準：${list.join(' 與 ')}（${b}）`);
}

if (problems.length) {
  problems.forEach((p) => console.log('❌ ' + p));
  console.log('\n孤兒檔的兩種修法：把它掛到頁面上（原本就該用），或刪掉（已經不需要）。');
  process.exit(1);
}
console.log(`✅ legal/ 的 ${files.length} 個檔案都有人用，也沒有指向不存在的檔案`);
