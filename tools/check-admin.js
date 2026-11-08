#!/usr/bin/env node
/**
 * 後台的靜態一致性檢查。
 *
 * 後台是單一 HTML 檔，沒有建置步驟，所以任何拼錯都要到「點下去沒反應」
 * 才會發現——而後台是客服操作的地方，出錯的代價是使用者權益。
 *
 * 檢查三件事：
 *   1. JS 取用的 id 都存在（`$('xx')` 打錯 → null.onclick 才炸）
 *   2. 每個管理端點都真的被呼叫（後端做了但前端沒接 = 等於沒做，
 *      這件事實際發生過：`handleLicensePatch` 支援換方案但 UI 沒有選單）
 *   3. 危險操作一定要有二次確認（刪除、停用不可逆或影響使用者）
 *
 * 用法：node tools/check-admin.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const root = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'legal/secret-pitstop.html'), 'utf8');
const api = readBackend();

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };

// --- 0. JS 必須能執行 -------------------------------------------------------
// **這是最重要的一項。** 後台是單一 HTML，一個語法錯誤就讓整段 script 不執行，
// 於是每個按鈕都沒反應——而瀏覽器只在 Console 留一行紅字，
// 從畫面上完全看不出來「壞掉」與「還沒載入」的差別。
//
// 實際踩過：用腳本插入程式碼時，換行跳脫被吃掉變成真的換行，
// 單引號字串因此跨行 → 整個後台變成靜態頁面，所有按鈕都沒反應。
{
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) bad('後台找不到 <script> 區塊');
  else {
    try { new (require('vm').Script)(m[1]); ok('後台 JS 語法正確（整段可執行）'); }
    catch (e) { bad(`後台 JS 有語法錯誤，整段不會執行、所有按鈕都沒反應：${e.message}`); }
  }
}

// --- 1. id 一致性 ---------------------------------------------------------
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...html.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((i) => !ids.has(i));
missing.length
  ? bad(`後台取用了不存在的 id：${missing.join('、')} —— 那些按鈕會完全沒反應`)
  : ok(`${used.size} 個 id 都存在`);
// id 不可以重複（2026-11-02 R19 正賽：逐句紀錄與授權清單都用 ll-out／ll-go，getElementById 拿到的是頁面上第一個——
// 授權清單畫進了逐句紀錄的框、授權清單的「重新整理」按了沒反應；樣本信的 mt-out 與產品數據撞名同理）。上面只驗「存在」，驗不到撞名
{
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]).filter((x) => !x.includes('${'));   // 樣板字串產生的不算
  const dup = [...new Set(all.filter((x, i) => all.indexOf(x) !== i))];
  dup.length
    ? bad(`後台有重複的 id：${dup.join('、')} —— $() 只拿得到第一個，另一個區塊的內容會畫錯地方、按鈕沒反應`)
    : ok(`${all.length} 個 id 沒有重複`);
}

// --- 2. 每個管理端點都要有人用 ---------------------------------------------
// 後端做了但前端沒接，等於沒做。這正是「後台改方案」那次的情況。
const endpoints = [...api.matchAll(/path === '(\/v1\/admin\/[^']+)'/g)].map((m) => m[1]);
// 只有管理版收割端（收割權杖）會呼叫的端點，不是後台的操作。⚠️ 加進來要寫理由
const HARVEST_ONLY = new Set([
  '/v1/admin/harvest/f1tv-schedule',   // A4：收割端讀 F1TV 賽事頁後送上來；結果在 /v1/schedule 的 shows／f1tv
  '/v1/admin/harvest/status',          // 收割端每 15 秒送狀態；後台從 /v1/admin/live 的 harvesters 讀
]);
const unused = [...new Set(endpoints)].filter((e) => !html.includes(e) && !HARVEST_ONLY.has(e));
unused.length
  ? bad(`後端有這些管理端點但後台沒有用到：${unused.join('、')} —— 做了等於沒做`)
  : ok(`${new Set(endpoints).size} 個管理端點都有對應的 UI`);

// --- 2b. 不在 /v1/admin/ 底下的管理端點也要有人用 ----------------------------
// ⚠️ 2026-10-02 全面檢查發現：上面那一項只掃 `/v1/admin/` 開頭的路徑，
//    於是 `POST／DELETE /v1/config`（遠端設定熱修——比賽日 F1TV 改版時唯一的救命索）
//    從上線起就**沒有任何後台介面**，而這支檢查一直是綠的。
//    與坑 #50 同一類：用路徑前綴判斷，就會漏掉前綴以外的東西。
//    改成直接讀後端 `isAdmin` 的定義——那才是「需要管理權限」的唯一來源。
{
  const m = api.match(/const isAdmin = ([\s\S]*?);\r?\n/);
  if (!m) bad('找不到後端的 isAdmin 定義——這一項檢查失去依據');
  else {
    const sw = fs.readFileSync(path.join(root, 'extension/src/background/sw.js'), 'utf8');
    const extra = [...m[1].matchAll(/path === '([^']+)' && \(?request\.method === '(\w+)'(?: \|\| request\.method === '(\w+)')?/g)]
      .flatMap((x) => [[x[1], x[2]], x[3] ? [x[1], x[3]] : null].filter(Boolean));
    if (!extra.length) bad('isAdmin 裡找不到任何 /v1/admin/ 以外的端點——格式變了，這一項沒有在檢查');
    // 呼叫端可以是後台或擴充功能的 sw.js（收割的完整標記 POST /v1/subs 是管理版在用；userscript 2026-10-28 已封存）。
    // 方法也要對得上：後台只用 GET 讀 /v1/config 不算有介面。
    const callers = (p, meth) => {
      const re = new RegExp("apiCall\\('" + p.replace(/\//g, '\\/') + "'[^)]*method: '" + meth + "'");
      if (re.test(html)) return '後台';
      if (sw.includes(p) && new RegExp("method: '" + meth + "'").test(sw)) return '管理版（sw.js）';
      return null;
    };
    const orphan = extra.filter(([p, meth]) => !callers(p, meth)).map(([p, meth]) => meth + ' ' + p);
    orphan.length
      ? bad(`這些需要管理權限的端點沒有任何介面：${orphan.join('、')} —— 出事時只能手打 curl`)
      : ok(`${extra.length} 個不在 /v1/admin/ 底下的管理端點也都有呼叫端（${extra.map(([p, meth]) => meth + ' ' + p).join('、')}）`);
  }
}

// --- 3. 危險操作必須有二次確認 ---------------------------------------------
// 刪除與停用都會影響使用者權益，誤點的代價是真實的。
// 用「動作關鍵字」定位，而不是端點——同一個端點可能同時有安全與危險的用法
// （reports/patch 既是標記已解決，也是刪除工單）。
const DANGEROUS = [
  // 定位到確認框本身（「永久刪除」這四個字在彈幕的保留說明裡也會出現，2026-10-29）
  [/confirm\('永久刪除 ' \+ row\.licenseKey/, '刪除授權碼'],
  [/刪除選取的 ' \+ ids\.length \+ ' 則彈幕/, '批量刪除彈幕'],
  [/小時內失去存取權/, '停用授權碼'],
  [/刪除這張工單/, '刪除工單'],
  [/的所有裝置/, '清空裝置'],
  // 遠端設定：約 3 分鐘內影響**所有**使用者（2026-10-02）
  [/緊急停用：所有使用者的字幕/, '遠端設定緊急停用'],
  [/推送熱修 v/, '推送遠端設定'],
  [/還原為內建預設？/, '還原遠端設定'],
];
let confirmed = 0;
for (const [pat, label] of DANGEROUS) {
  const m = html.match(pat);
  if (!m) { bad(`找不到 ${label} 的操作`); continue; }
  const i = html.indexOf(m[0]);
  const around = html.slice(Math.max(0, i - 200), i + 200);
  if (/confirm\(/.test(around)) confirmed++;
  else bad(`${label} 沒有二次確認 —— 誤點會直接影響使用者`);
}
confirmed === DANGEROUS.length && ok(`${confirmed} 個危險操作都有二次確認`);

// --- 4. 方案與價格一律由伺服器提供，後台不可以自己寫一份 ---------------------
//
// 舊版是把方案選項寫死在 HTML 裡，並用「寫死的名稱都存在於後端」來把關。
// 那個把關擋不住真正發生的事：定價從「早鳥 399／正式 599」改成
// 「上半季 599／下半季 299／一週 39」之後，**名稱依然存在**，
// 所以檢查照樣通過，而後台還在發早鳥碼——賣的東西與網站上的是兩套。
//
// 所以現在反過來檢查：後台**不准**出現寫死的方案選項或價格。
const planBlock = api.match(/const PLANS = \{([\s\S]*?)\n\};/)[1];
const backendPlans = [...planBlock.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);

const hardPlan = [...html.matchAll(/<option value="([a-z_0-9]+)"/g)]
  .map((m) => m[1]).filter((k) => backendPlans.includes(k));
hardPlan.length
  ? bad(`後台把方案寫死在 HTML 裡：${[...new Set(hardPlan)].join('、')} —— 改價之後會靜默漂掉`)
  : ok('後台沒有寫死任何方案選項');

// 價格同理。任何 NT$ 後面直接跟數字都是寫死的價格。
const hardPrice = [...html.matchAll(/NT\$\s?[0-9][0-9,]*/g)].map((m) => m[0]);
hardPrice.length
  ? bad(`後台寫死了價格：${[...new Set(hardPrice)].join('、')} —— 應該由 /v1/admin/plans 提供`)
  : ok('後台沒有寫死任何價格');

html.includes('/v1/admin/plans')
  ? ok(`方案下拉由伺服器提供（後端目前有 ${backendPlans.length} 個方案）`)
  : bad('後台沒有向 /v1/admin/plans 取方案 —— 下拉一定是寫死的');

// --- 4a. 外人寫的欄位不可以沒跳脫就插進 HTML --------------------------------
//
// 2026-09-17 端對端實測發現：問題回報那張表把 note／contact／version 直接插進 innerHTML。
// 聯絡表單是公開的——填一段 <img src=x onerror=…>，你一打開後台的「問題回報」分頁，
// 那段程式就在**放著 ADMIN_TOKEN 的頁面**裡執行。
// 同樣的問題也在授權清單的 email（結帳的 email 格式檢查允許 `<img/src=x/onerror=…>@a.co`）、
// 成本表的 cid（擴充功能送來的）、產品數據的鍵名（也是擴充功能送來的）。
//
// 規則：這些欄位名稱出現在 `${...}` 或 `' + ... + '` 裡時，一定要包著 esc／escHtml。
{
  const OUTSIDER = ['note', 'contact', 'email', 'message', 'cid', 'slug', 'version', 'summary', 'who', 'failMsg', 'mailReason', 'en', 'zh'];
  const fieldRe = new RegExp(`\\b[a-zA-Z_]\\w*\\.(${OUTSIDER.join('|')})\\b`);
  const lines = html.split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    // 只看有在組 HTML 的行
    if (!/</.test(line) && !/innerHTML/.test(line)) return;
    for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
      const e = m[1].trim();
      if (fieldRe.test(e) && !/^(esc|escHtml)\(/.test(e) && !/\.(length|toLocaleString)\b/.test(e)) found.push(`${i + 1}: \${${e}}`);
    }
    for (const m of line.matchAll(/\+\s*([a-zA-Z_][\w.]*(?:\s*\|\|\s*'[^']*')?)\s*\+/g)) {
      const e = m[1].trim();
      if (fieldRe.test(e)) found.push(`${i + 1}: + ${e} +`);
    }
  });
  found.length
    ? bad(`外人寫的欄位沒有跳脫就插進 HTML（後台頁面裡有 ADMIN_TOKEN，這是能偷權杖的洞）：\n     ${found.join('\n     ')}`)
    : ok('外人寫的欄位（工單內容、email、cid…）插進 HTML 前都有跳脫');
}

// --- 4b. 訂單狀態要與後端的狀態機一致 ---------------------------------------
// 後端多一個狀態而後台沒有對應標籤時，畫面會直接顯示英文代碼，
// 而那看起來只像是「有一筆奇怪的訂單」，不像是漏了東西。
{
  const rank = api.match(/const ORDER_RANK = \{([^}]*)\}/);
  if (!rank) bad('後端找不到 ORDER_RANK —— 訂單狀態機不見了');
  else {
    const states = [...rank[1].matchAll(/(\w+):/g)].map((m) => m[1]);
    const labels = html.match(/const OR_LABEL = \{([^}]*)\}/);
    if (!labels) bad('後台找不到 OR_LABEL —— 訂單狀態會顯示成英文代碼');
    else {
      const have = [...labels[1].matchAll(/(\w+):/g)].map((m) => m[1]);
      const miss = states.filter((x) => !have.includes(x));
      miss.length
        ? bad(`後台沒有這些訂單狀態的中文標籤：${miss.join('、')}`)
        : ok(`${states.length} 個訂單狀態都有中文標籤`);
    }
  }
}

// --- 4c. 每一個控制項都必須有人接 -------------------------------------------
//
// ⚠️ **實際發生過（2026-08-22）：加了「搜尋」輸入框與「載入更多」按鈕，
//    但接手的那段 JS 因為補丁腳本失敗而沒有寫進去。** 頁面照常渲染、
//    Console 一片乾淨，只是那兩個控制項按了完全沒有反應——
//    使用者看到的是「你說的新功能在哪裡？」
//
// ⚠️ **這支檢查自己也踩過坑：** 第一版的正則寫了 \b，而它經過補丁腳本時
//    被寫成真正的**倒退鍵字元**（U+0008），於是一個控制項都掃不到、
//    dead 永遠是空的、檢查永遠是綠的。**掃描型的檢查一定要驗自己的分母**——
//    掃到 0 個目標時必須紅燈，否則它只是一行讓人安心的謊話。
{
  const scriptAt = html.indexOf('<script>');
  const scriptSrc = scriptAt >= 0 ? html.slice(scriptAt) : '';
  const dead = [];
  let scanned = 0;
  const re = /<(button|input|select|textarea)\s[^>]*id="([\w-]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    scanned++;
    const id = m[2];
    if (!new RegExp("['\"`]" + id + "['\"`]").test(scriptSrc)) dead.push(m[1] + '#' + id);
  }
  if (scanned < 20) {
    bad(`只掃到 ${scanned} 個控制項 —— 後台明明有幾十個，代表這支檢查本身壞了`);
  } else if (dead.length) {
    bad(`這些控制項在 JS 裡找不到，按了不會有任何反應：${dead.join('、')}`);
  } else {
    ok(`${scanned} 個按鈕與輸入框都有 JS 接手（沒有死掉的控制項）`);
  }
}

// --- 5. 不可以把 ADMIN_TOKEN 存進 localStorage ------------------------------
/localStorage[^\n]*(tok|token)/i.test(html)
  ? bad('後台把權杖存進 localStorage —— 任何能碰到這台電腦的人都拿得到管理權限')
  : ok('權杖只留在分頁記憶體，沒有寫入儲存空間');

// --- 6. 登入畫面（2026-09-17）：登入前看不到任何後台內容 ---------------------
{
  const probs = [];
  const appOpen = html.indexOf('<div id="app" hidden>');
  const appClose = html.indexOf('</div><!-- /#app -->');
  if (appOpen < 0) probs.push('後台內容的外框 #app 不見了或沒有預設 hidden');
  if (appClose < appOpen) probs.push('#app 沒有正確收尾');
  // 所有頁籤區塊與分頁按鈕都要在 #app 裡面
  const outside = [...html.matchAll(/<section id="(p-[a-z]+)"|<div class="tabs">/g)]
    .filter((m) => m.index < appOpen || m.index > appClose).map((m) => m[1] || 'tabs');
  if (outside.length) probs.push('這些區塊在 #app 外面，登入前就看得到：' + outside.join('、'));
  if (!/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(html)) probs.push('缺少 [hidden]{display:none!important}，某個區塊的 display 規則可能蓋過 hidden');
  if (!/<form id="gate"/.test(html) || html.indexOf('<form id="gate"') > appOpen) probs.push('登入表單 #gate 不見了');
  if (!/'x-admin-session': adminSession/.test(html)) probs.push('apiCall 沒有帶登入工作階段——開了動態碼之後輪詢會把自己鎖在外面');
  if (!/if \(!isLogin && \$\('app'\)\.hidden\) throw/.test(html)) probs.push('登出狀態下背景輪詢仍會打 API（每一次都算失敗）');
  if (!/'\/v1\/admin\/login'/.test(api)) probs.push('後端沒有 /v1/admin/login');
  probs.length ? probs.forEach(bad) : ok('登入畫面：登入前所有頁籤與區塊都隱藏，登入後帶工作階段，登出狀態不打 API');
}

console.log('');
if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
console.log('✅ 後台與後端完全對得起來');
