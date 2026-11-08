#!/usr/bin/env node
/**
 * 法律文件與程式碼的一致性檢查。
 *
 * 為什麼需要：隱私權政策寫「我們不蒐集 X」，但程式碼真的在蒐集 X ——
 * 這在 Chrome Web Store 是下架理由，在台灣個資法下是不實陳述。
 * 而這種不一致**不會有任何技術徵兆**，只會在被檢舉或稽核時爆開。
 *
 * 政策是承諾，程式碼是事實。這支確保兩者對得起來。
 *
 * 用法：node tools/check-legal.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const root = path.join(__dirname, '..');

const priv = fs.readFileSync(path.join(root, 'legal/privacy.html'), 'utf8');
const terms = fs.readFileSync(path.join(root, 'legal/terms.html'), 'utf8');
const api = readBackend();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.base.json'), 'utf8'));

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };

// --- 1. 權限：manifest 有的，政策必須列出來 --------------------------------
const perms = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
const undeclared = perms.filter((p) => {
  const host = p.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
  return !priv.includes(host) && !priv.includes(p);
});
undeclared.length
  ? bad(`manifest 有這些權限但隱私政策沒說明：${undeclared.join('、')} —— 商店審核會問`)
  : ok(`${perms.length} 個權限都在隱私政策裡說明了`);

// 反過來：政策不該列出已經移除的權限
const REMOVED = ['cookies', 'tabs', 'webRequest', 'history', 'bookmarks'];
const overclaimed = REMOVED.filter((p) => new RegExp(`<code>${p}</code>`).test(priv));
overclaimed.length
  ? bad(`隱私政策提到我們沒有的權限：${overclaimed.join('、')}`)
  : ok('隱私政策沒有列出多餘的權限');

// --- 2. 蒐集的統計維度必須與白名單一致 --------------------------------------
// 政策說「我們記錄 A/B/C」，程式碼的白名單就必須是 A/B/C。
const evBlock = api.match(/const METRIC_EVENTS = \{([\s\S]*?)\n\};/);
if (!evBlock) bad('找不到 METRIC_EVENTS 白名單');
else {
  const dims = new Set();
  for (const m of evBlock[1].matchAll(/'(\w+)'/g)) dims.add(m[1]);
  // 政策明確承諾不收的維度，白名單裡就不可以出現
  const FORBIDDEN = ['cid', 'contentId', 'ip', 'url', 'email', 'userId', 'installId'];
  const leaked = FORBIDDEN.filter((f) => dims.has(f));
  leaked.length
    ? bad(`統計白名單含政策承諾不蒐集的欄位：${leaked.join('、')}`)
    : ok(`統計白名單（${[...dims].join('、')}）沒有違反政策的承諾`);
}

// --- 3. 政策承諾的保存期限要與程式碼一致 -----------------------------------
const ttlChecks = [
  [/REPORT_TTL_DAYS = (\d+)/, 90, '問題回報'],
  [/METRIC_TTL_DAYS = (\d+)/, 400, '使用統計'],
  // 2026-09-17 隱私權政策補上帳號與訂單之後新增的承諾
  // 2026-10-02 起網站與擴充功能分開：網站 cookie 14 天、擴充功能 30 天
  [/SESSION_TTL_WEB_DAYS = (\d+)/, 14, '登入憑證（網站）'],
  [/SESSION_TTL_EXT_DAYS = (\d+)/, 30, '登入憑證（擴充功能）'],
  [/ORDER_TTL = (\d+) \* 86400/, 400, '訂單記錄'],
];
{
  const otp = api.match(/OTP_TTL_SEC = (\d+)/);
  otp && Number(otp[1]) === 600 && priv.includes('10 分鐘')
    ? ok('登入驗證碼 10 分鐘失效，與政策一致')
    : bad('登入驗證碼的有效時間與隱私權政策不一致（政策寫 10 分鐘）');
  // 政策列出的第三方，缺一個就是沒有告知
  const THIRD = ['Cloudflare', 'Anthropic', 'ECPay', 'Google Identity Services', 'Resend', 'Gmail'];
  const miss = THIRD.filter((t) => !priv.includes(t));
  miss.length ? bad('隱私權政策的第三方服務少了：' + miss.join('、')) : ok('隱私權政策列出所有第三方服務（' + THIRD.length + ' 個）');
  // 程式碼真的有用到 Resend 與 Google 登入時，政策就必須提到
  if (/api\.resend\.com/.test(api) && !priv.includes('Resend')) bad('程式碼用 Resend 寄信，但隱私權政策沒提');
}
for (const [re, expect, label] of ttlChecks) {
  const m = api.match(re);
  if (!m) { bad(`找不到 ${label} 的保存期限設定`); continue; }
  Number(m[1]) === expect
    ? ok(`${label} 保存 ${m[1]} 天，與政策一致`)
    : bad(`${label} 程式碼是 ${m[1]} 天，但政策寫的是 ${expect} 天`);
}

// --- 4. 價格必須與後端的 PLANS 一致 -----------------------------------------
const planBlock = api.match(/const PLANS = \{([\s\S]*?)\n\};/)[1];
const prices = {};

// ⚠️ **價格不一定是數字字面值。**
//
//    這個迴圈原本只抓 `price:\s*(\d+)`，於是 `price: WEEKEND_PRICE`
//    與 `price: PRICE_FIRST_HALF` 兩個方案**整個被跳過**——
//    比賽週通行證的價格從頭到尾沒有被比對過，而檢查照樣是綠的。
//    實際後果：2026-09-16 單場價由 39 調到 49，條款裡的 NT$39 沒有人發現。
//
//    **一個「什麼都沒驗到卻是綠的」檢查，比沒有檢查更糟**——它會讓人以為驗過了。
//    所以這裡先把檔案裡的常數解出來，價格寫成常數名也照驗。
const consts = {};
for (const m of api.matchAll(/^const ([A-Z][A-Z0-9_]*) = (\d+);/gm)) consts[m[1]] = Number(m[2]);
const priceVal = (raw) => {
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  return Object.prototype.hasOwnProperty.call(consts, s) ? consts[s] : null;
};
const unresolved = [];
// ⚠️ 以「頂層的方案鍵（兩格縮排）」切段，不用 `[^}]*`：賽季票的名稱改成 getter 之後
//    樣板字串裡的 `${SEASON_YEAR}` 有 `}`，舊正則在那裡就斷了——季票價格整個沒驗、檢查照樣是綠的（2026-10-30 發現）
const planHeads = Array.from(planBlock.matchAll(/^ {2}(\w+):\s*\{/gm));
planHeads.forEach((h, i) => {
  const seg = planBlock.slice(h.index, i + 1 < planHeads.length ? planHeads[i + 1].index : planBlock.length);
  const m = seg.match(/\bprice:\s*([A-Za-z0-9_]+)/);
  if (!m) return;
  const v = priceVal(m[1]);
  if (v === null) { unresolved.push(`${h[1]}=${m[1]}`); return; }
  prices[h[1]] = v;
});
for (const k of ['season', 'season_early', 'season_next', 'week']) {
  if (!(k in prices)) unresolved.push(`${k}=（沒抓到）`);
}
unresolved.length
  ? bad(`有方案的價格解不出來，等於沒有比對：${unresolved.join('、')}`)
  : ok(`所有方案的價格都解得出實際數字（共 ${Object.keys(prices).length} 個）`);
const inTerms = (n) => terms.includes(`NT$${n}`);
const priceMismatch = Object.entries(prices)
  .filter(([, p]) => p > 0)
  .filter(([, p]) => !inTerms(p));
priceMismatch.length
  ? bad(`後端的價格沒有出現在使用條款：${priceMismatch.map(([k, p]) => `${k}=NT$${p}`).join('、')}`)
  : ok(`價格與後端一致（${Object.entries(prices).filter(([, p]) => p).map(([k, p]) => `${k} NT$${p}`).join('、')}）`);

// 升級折抵的兩個門檻也一定要與條款一致。
//
// ⚠️ **這兩個數字會跟著單場價漂移**：折抵上限的定義是「最多折兩站」，
//    單場 39 時是 80、49 時是 100。程式碼改了、條款沒改，
//    就是「條款寫 80、系統折 100」——那是對外的承諾對不上實際行為。
// ⚠️ **值可能是常數名，不是數字。** `UPGRADE_CREDIT_MAX = WEEKEND_PRICE`
//    就是這樣寫的（「折抵上限等於一張單場」這件事要由程式碼自己保證，
//    寫死成 49 的話單場價一改就變成「說好折一站卻折不滿」）。
//    只抓 `(\d+)` 的話這一項會直接消失，而**消失的檢查是綠的**——
//    這個檔案幾分鐘前才因為同一個形狀漏掉比賽週的價格。
for (const [name, label, phrase] of [
  ['UPGRADE_CREDIT_MAX', '升級折抵上限', (n) => `折抵上限為 NT$${n}`],
  ['UPGRADE_FREE_BELOW', '免收差額門檻', (n) => `低於 NT$${n}`],
]) {
  const m = api.match(new RegExp(`const ${name} = ([A-Za-z0-9_]+)`));
  if (!m) { bad(`找不到 ${label}（${name}）`); continue; }
  const v = priceVal(m[1]);
  if (v === null) {
    bad(`${label} 的值解不出實際數字（寫的是 ${m[1]}）—— 等於沒有比對`);
    continue;
  }
  terms.includes(phrase(v))
    ? ok(`${label} NT$${v}，條款與程式碼一致`)
    : bad(`${label} 程式碼是 NT$${v}，但使用條款沒有這個數字`);
}

// 早鳥限量的數字也要對
const limitM = api.match(/const EARLY_LIMIT = (\d+)/);
if (limitM && !terms.includes(`限量 ${limitM[1]} 組`)) {
  bad(`使用條款沒寫早鳥限量 ${limitM[1]} 組，或數字與程式碼不符`);
} else if (limitM) ok(`早鳥限量 ${limitM[1]} 組，條款與程式碼一致`);

// --- 5. 免費層的秒數要一致 --------------------------------------------------
const freeM = api.match(/freeTier:\s*\{\s*\n?\s*seconds:\s*(\d+)/);
if (freeM) {
  const mins = Number(freeM[1]) / 60;
  [priv, terms].every((d) => d.includes(`${mins} 分鐘`))
    ? ok(`免費層 ${mins} 分鐘，兩份文件都一致`)
    : bad(`程式碼的免費層是 ${mins} 分鐘，但文件沒有一致地寫出這個數字`);
}

// --- 5b. 未登入（遊客）的免費秒數也要一致 ------------------------------------
// 2026-09-17 發現：網站、常見問題、**使用條款**都寫「15 分鐘・不需註冊」，
// 程式的遊客額度卻是 3 分鐘——這一項以前只驗登入的 15 分鐘，遊客的完全沒驗。
{
  const g = api.match(/guestSeconds:\s*(\d+)/);
  const faq = fs.readFileSync(path.join(root, 'legal/faq.html'), 'utf8');
  const home = fs.readFileSync(path.join(root, 'legal/index.html'), 'utf8');
  if (!g) bad('找不到 guestSeconds（遊客免費秒數）');
  else {
    const gm = Number(g[1]) / 60;
    const docs = [['使用條款', terms], ['常見問題', faq], ['首頁', home]];
    // ⚠️ 不可以用 includes：「15 分鐘」本身就包含「5 分鐘」，檢查會永遠通過（回種舊條款時抓到的）
    const minRe = new RegExp(`(^|[^0-9])${gm} 分鐘`);
    const miss = docs.filter(([, d]) => !minRe.test(d)).map(([n]) => n);
    miss.length
      ? bad(`程式的遊客免費額度是 ${gm} 分鐘，但這些文件沒有寫出來：${miss.join('、')}`)
      : ok(`遊客免費 ${gm} 分鐘，條款、常見問題、首頁都一致`);
    const lie = docs.filter(([, d]) => /15 分鐘[^<]{0,30}不需(要)?註冊|不需(要)?註冊[^<]{0,30}15 分鐘/.test(d)).map(([n]) => n);
    lie.length
      ? bad(`這些文件仍寫「15 分鐘・不需註冊」，但 15 分鐘需要登入：${lie.join('、')}`)
      : ok('沒有文件把「15 分鐘」寫成不需登入');
  }
}

// --- 6. 台灣法規的必要條款 --------------------------------------------------
// 沒有明示排除，消費者仍可主張七天無條件退貨——這條漏掉的代價是實質的。
const REQUIRED = [
  [/通訊交易解除權合理例外情事適用準則/, '七天鑑賞期排除的法源依據'],
  [/事先同意/, '「經消費者事先同意」的要件'],
  [/無任何關聯|均無關聯/, '與 Formula 1 無關聯的聲明'],
  [/個人資料保護法/, '個資法下的當事人權利'],
];
for (const [re, label] of REQUIRED) {
  const doc = re.source.includes('個人資料') ? priv : terms;
  re.test(doc) ? ok(`已載明：${label}`) : bad(`缺少：${label}`);
}

// --- 7. 聯絡方式與網域 ------------------------------------------------------
const MAIL = 'pitlingo.office@gmail.com';
[priv, terms].every((d) => d.includes(MAIL))
  ? ok('兩份文件都有聯絡信箱')
  : bad('文件缺少聯絡信箱');
[priv, terms].every((d) => d.includes('pitlingo.com'))
  ? ok('兩份文件互相連結')
  : bad('文件之間沒有互相連結');

// --- 8. 附贈轉送：開關與條款一致 -------------------------------------------
// 開了卻沒寫進條款＝做了條款沒允許的事；條款寫了卻沒開＝承諾了做不到的事。
{
  const toml = fs.readFileSync(path.join(root, 'backend/wrangler.toml'), 'utf8');
  const on = /^GIFT_TRANSFER\s*=\s*"1"/m.test(toml);
  const inTerms = /轉送予他人一次/.test(terms);
  const inPriv = /轉送附贈的比賽週通行證/.test(priv);
  on === inTerms && on === inPriv
    ? ok(`附贈轉送：開關 ${on ? '開' : '關'}，條款與隱私權政策一致`)
    : bad(`附贈轉送：開關 ${on ? '開' : '關'}，但條款${inTerms ? '有' : '沒有'}、隱私權政策${inPriv ? '有' : '沒有'}寫`);
}

// --- 9. 英文版隱私權政策不可以落後中文版 -----------------------------------
// 2026-10-12 為了商店審查加的英文翻譯（/privacy-en，商店欄位填這個）。
// 翻譯最容易出的事是「中文改了、英文沒跟」——審查員讀的是英文，
// 那就變成對審查員的不實陳述。這裡擋得住的是可以機械比對的部分：
// 日期、權限、第三方、保存期限的數字；文意仍要人對照。
{
  const en = fs.readFileSync(path.join(root, 'legal/privacy-en.html'), 'utf8');
  const M = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const zd = priv.match(/最後更新：(\d{4}) 年 (\d{1,2}) 月 (\d{1,2}) 日/);
  const ed = en.match(/Last updated: (\w+) (\d{1,2}), (\d{4})/);
  zd && ed && M.indexOf(ed[1]) + 1 === Number(zd[2]) && ed[2] === zd[3] && ed[3] === zd[1]
    ? ok('英文版隱私權政策的更新日期與中文版相同')
    : bad(`英文版隱私權政策的日期（${ed ? ed.slice(1).join(' ') : '找不到'}）與中文版（${zd ? zd.slice(1).join('-') : '找不到'}）不同——中文改了就要同步翻譯`);
  const enMiss = perms.filter((p) => !en.includes(p.replace(/^https?:\/\//, '').replace(/\/\*$/, '')));
  const enThird = ['Cloudflare', 'Anthropic', 'ECPay', 'Google Identity Services', 'Resend', 'Gmail'].filter((t) => !en.includes(t));
  const zhCodes = [...priv.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1]).filter((c) => !c.includes('…'));
  const enCodeMiss = zhCodes.filter((c) => !en.includes('<code>' + c + '</code>'));
  // 保存期限與其他承諾的數字：中文版出現的，英文版也要出現
  const NUMS = ['90 days', '400 days', '14 days', '30 days', '10 minutes', '3 days', '2 minutes', '400 days', '5 minutes', '20 previously', '16 characters', '13 months', 'under 13'];
  const numMiss = NUMS.filter((n) => !en.includes(n));
  const probs = [];
  if (enMiss.length) probs.push('權限 ' + enMiss.join('、'));
  if (enThird.length) probs.push('第三方 ' + enThird.join('、'));
  if (enCodeMiss.length) probs.push('中文版有的 <code> ' + enCodeMiss.join('、'));
  if (numMiss.length) probs.push('數字 ' + numMiss.join('、'));
  probs.length ? bad('英文版隱私權政策少了：' + probs.join('；')) : ok('英文版隱私權政策的權限、第三方與保存期限與中文版一致');
  /\/privacy-en/.test(priv) ? ok('中文版有連到英文版') : bad('中文版隱私權政策沒有連到英文版');
}

console.log('');
if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
console.log('✅ 法律文件與程式碼的實際行為完全一致');
