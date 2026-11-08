#!/usr/bin/env node
/**
 * 網站與擴充功能裡所有超連結的檢查。
 *
 * 為什麼需要：法律文件的網址會填進 Chrome Web Store 的審核欄位，
 * 連結壞掉 = 審核直接失敗。而「連結壞掉」在本機完全看不出來——
 * HTML 不會因為 href 指錯而報錯。
 *
 * 檢查兩件事：
 *   1. 站內連結指向的檔案真的存在（`/privacy` → `legal/privacy.html`）
 *   2. 站外連結（含 mailto）格式正確，且網域是我們預期的那幾個
 *
 * 加 --live 會實際發請求驗證線上狀態（需要網路）。
 *
 * 用法：node tools/check-links.js [--live]
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const live = process.argv.includes('--live');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { errors.push(m); console.log('❌ ' + m); };

// 我們自己的網域。出現在連結裡的其他網域都要有明確理由。
const OURS = ['pitlingo.com', 'pitlingo.pages.dev', 'api.pitlingo.com',
  'f1zh-api.pitlingo.workers.dev'];
// ⚠️ github.com/ray319129 已移除（2026-10-16）：repo 是私有的，外人點了是 404；隱私權政策原本連到那裡

// 刻意允許的第三方網域。**與 OURS 分開列**——塞進叫「OURS」的清單
// 等於讓變數名稱說謊，日後沒有人會發現站上多了外部請求。
// ⚠️ 這裡每加一個，隱私權政策的第三方表格就必須同步揭露（check-legal 在擋）。
const THIRD_OK = ['fonts.googleapis.com', 'fonts.gstatic.com'];
// 只能當**連結**（<a href>，使用者點了才離開本站）的外部網址——不是第三方請求，不用揭露在隱私權政策。
// ⚠️ 不可以出現在 src＝會在載入頁面時就發出請求，那要走 THIRD_OK。
const LINK_ONLY = [
  'https://f1tv.formula1.com/',   // 安裝完成頁的「打開 F1TV」（2026-10-24）
  // 首頁安裝按鈕（2026-11-03 商店公開）。只放我們自己的商品頁，不開放整個商店網域
  'https://chromewebstore.google.com/detail/kjfholeimhnldleehnniamhhbpefacnn',
  'https://www.instagram.com/pitlingo/',   // 官方 IG（2026-11-03 Ray 給的帳號）
];

const FILES = [
  ['legal/index.html', '網站首頁'],
  ['legal/privacy.html', '隱私權政策'],
  ['legal/privacy-en.html', '隱私權政策（英文版）'],
  ['legal/terms.html', '使用條款'],
  ['legal/buy.html', '購買頁'],
  ['legal/paid.html', '付款結果頁'],
  ['legal/contact.html', '聯絡我們'],
  // ⚠️ 這兩頁原本不在清單裡——它們的連結從來沒被檢查過。
  //    2026-09-16 全站共用頁首頁尾之後才發現（/account 連結被判定不存在）。
  ['legal/faq.html', '常見問題'],
  ['legal/account.html', '我的帳號'],
  ['legal/404.html', '404 頁'],
  ['legal/welcome.html', '安裝完成頁'],
  ['extension/src/options/options.html', '擴充功能設定頁'],
];

// 站內路徑 → 實際檔案
// 網址 → 實際檔案。Cloudflare Pages 會自動把 /buy 對到 buy.html。
// 新增頁面時這裡要一起加，否則連結檢查會漏掉那一頁。
const ROUTES = {
  '/': 'legal/index.html',
  '/privacy': 'legal/privacy.html',
  '/privacy-en': 'legal/privacy-en.html',
  '/terms': 'legal/terms.html',
  '/buy': 'legal/buy.html',
  '/faq': 'legal/faq.html',
  '/paid': 'legal/paid.html',
  '/contact': 'legal/contact.html',
  '/account': 'legal/account.html',
  '/welcome': 'legal/welcome.html',
  // 後台 2026-09-17 從 /admin 搬到這裡。/admin 現在是 404（見 legal/404.html）
  '/secret-pitstop': 'legal/secret-pitstop.html',
};

// sitemap.xml（2026-10-16）：每個網址都要對得到頁面，而且公開頁面一個都不能漏——
// 漏掉的頁面 Google 只能靠連結自己找，新頁面（例如 /privacy-en）會很久才被收錄。
{
  const SITEMAP_SKIP = ['/paid', '/account', '/welcome', '/secret-pitstop'];   // 理由見 sitemap.xml 開頭
  const sm = fs.readFileSync(path.join(root, 'legal/sitemap.xml'), 'utf8');
  const locs = [...sm.matchAll(/<loc>https:\/\/pitlingo\.com([^<]*)<\/loc>/g)].map((m) => m[1] || '/');
  const all = [...sm.matchAll(/<loc>([^<]*)<\/loc>/g)].length;
  if (all !== locs.length) bad('sitemap.xml 有不是 https://pitlingo.com 的網址');
  const dead = locs.filter((u) => !ROUTES[u] || !fs.existsSync(path.join(root, ROUTES[u])));
  const miss = Object.keys(ROUTES).filter((u) => !SITEMAP_SKIP.includes(u) && !locs.includes(u));
  const leak = locs.filter((u) => SITEMAP_SKIP.includes(u));
  dead.length ? bad('sitemap.xml 的網址對不到頁面：' + dead.join('、')) : null;
  miss.length ? bad('sitemap.xml 漏了公開頁面：' + miss.join('、')) : null;
  leak.length ? bad('sitemap.xml 不該列這些頁面：' + leak.join('、')) : null;
  if (!dead.length && !miss.length && !leak.length && all === locs.length) ok(`sitemap.xml 的 ${locs.length} 個網址都對得到頁面，公開頁面沒有漏`);
}

const external = new Set();
let internalOk = 0;

for (const [rel, label] of FILES) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) { bad(`${label} 檔案不存在：${rel}`); continue; }
  const html = fs.readFileSync(p, 'utf8');
  // ⚠️ 屬性名前面一定要是空白：`data-edit-href="cta.try"` 結尾也是 href，
  //    沒有邊界的話它的值（鍵名）會被當成相對路徑，回報「檔案不存在」。
  const hrefs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const m of html.matchAll(/\ssrc="([^"]+)"/g)) if (LINK_ONLY.some((u) => m[1].startsWith(u))) bad(`${label}：${m[1]} 只能當連結，不可以當 src 載入`);

  for (let h of hrefs) {
    if (h.startsWith('mailto:')) {
      /^mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(h)
        ? internalOk++
        : bad(`${label}：mailto 格式不正確 → ${h}`);
      continue;
    }
    if (h.startsWith('http')) {
      external.add(h);
      const host = new URL(h).hostname;
      if (!OURS.some((o) => h.includes(o)) && !THIRD_OK.some((o) => h.includes(o)) && !LINK_ONLY.some((u) => h.startsWith(u))) {
        bad(`${label}：連到非預期的網域 → ${host}`);
      }
      continue;
    }
    if (h.startsWith('#') || h.startsWith('data:')) continue;

    // 快取破壞用的 ?v= 要先剝掉，否則 /buy.js?v=3.8 會被當成不存在的檔案。
    h = h.split('?')[0].split('#')[0];
    // 站內：可能是路由（/privacy）或相對路徑（options.css）
    if (h.startsWith('/')) {
      const target = ROUTES[h] || path.join('legal', h.replace(/^\//, ''));
      fs.existsSync(path.join(root, target)) || require('./lib/omitted-media').isOmitted(h)
        ? internalOk++
        : bad(`${label}：站內連結指向不存在的檔案 → ${h}（找不到 ${target}）`);
    } else {
      const target = path.join(path.dirname(p), h);
      fs.existsSync(target)
        ? internalOk++
        : bad(`${label}：相對路徑不存在 → ${h}`);
    }
  }
}
if (!errors.length) ok(`${internalOk} 個站內連結與資源都存在`);

// 三份文件必須互相連通，缺一個使用者就會走進死巷
const priv = fs.readFileSync(path.join(root, 'legal/privacy.html'), 'utf8');
const terms = fs.readFileSync(path.join(root, 'legal/terms.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'legal/index.html'), 'utf8');
const pairs = [
  [priv, '/terms', '隱私政策 → 使用條款'],
  [terms, '/privacy', '使用條款 → 隱私政策'],
  [index, '/privacy', '首頁 → 隱私政策'],
  [index, '/terms', '首頁 → 使用條款'],
];
let linked = 0;
for (const [doc, want, label] of pairs) {
  doc.includes(want) ? linked++ : bad(`缺少連結：${label}`);
}
linked === pairs.length && ok('四條互連的路徑都在（不會走進死巷）');

// 購買頁必須連得到條款與隱私政策 —— 那是「經消費者事先同意」的前提，
// 使用者要看得到自己同意的是什麼
const buy = fs.readFileSync(path.join(root, 'legal/buy.html'), 'utf8');
['/terms', '/privacy'].every((u) => buy.includes(u))
  ? ok('購買頁連得到使用條款與隱私政策')
  : bad('購買頁沒有連到條款 —— 七天鑑賞期的排除在法律上不成立');
/type="checkbox"[^>]*id="agree"|id="agree"[^>]*type="checkbox"/.test(buy)
  ? ok('購買頁有同意條款的勾選（法定要件）')
  : bad('購買頁缺少同意勾選 —— 沒有它，排除七天鑑賞期無效');

// 擴充功能的設定頁要連到法律文件——商店審核會看
const opts = fs.readFileSync(path.join(root, 'extension/src/options/options.html'), 'utf8');
['/privacy', '/terms'].every((u) => opts.includes(u))
  ? ok('擴充功能設定頁連得到隱私政策與使用條款')
  : bad('擴充功能設定頁沒有連到法律文件 —— 商店審核會問');

// 後端位址：manifest 的 host_permissions 必須涵蓋程式碼實際用的位址
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.base.json'), 'utf8'));
const defaults = fs.readFileSync(path.join(root, 'extension/src/shared/defaults.js'), 'utf8');
const backend = (defaults.match(/BACKEND\s*=\s*'([^']+)'/) || [])[1];
if (!backend) bad('找不到 BACKEND 位址');
else {
  const host = new URL(backend).hostname;
  (manifest.host_permissions || []).some((p) => p.includes(host))
    ? ok(`BACKEND（${host}）在 host_permissions 裡`)
    : bad(`BACKEND 是 ${host}，但 manifest 的 host_permissions 沒有涵蓋它 —— 所有請求都會被擋`);
}

console.log('');
if (live) {
  (async () => {
    console.log('── 線上驗證 ──');
    const urls = ['https://pitlingo.pages.dev/', 'https://pitlingo.pages.dev/privacy',
      'https://pitlingo.pages.dev/terms', backend + '/v1/health'];
    for (const u of urls) {
      try {
        const r = await fetch(u, { redirect: 'follow' });
        r.ok ? ok(`${u} → ${r.status}`) : bad(`${u} → ${r.status}`);
      } catch (e) { bad(`${u} → ${e.message}`); }
    }
    finish();
  })();
} else finish();

function finish() {
  console.log('');
  if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
  console.log('✅ 所有連結都指向正確位置');
}
