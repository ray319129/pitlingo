#!/usr/bin/env node
/**
 * 網站共用頁首與頁尾 —— **唯一的定義在這支檔案**
 *
 * 為什麼需要：網站沒有建置流程，每一頁都是獨立的 HTML。
 * 2026-09-16 之前每頁各自寫一個「← PitLingo」返回連結，
 * 三份法律文件的頁尾內容還互不相同（一份有免責聲明、一份有信箱、一份只有連結）。
 * **各寫一份就一定會漂移**——這個專案的跨檔案契約每一個都因此出過事。
 *
 * 做法：頁首頁尾放在標記之間，由這支工具蓋印到每一頁。
 *
 *   node tools/site-chrome.js          把定義寫進所有頁面
 *   node tools/site-chrome.js --check  驗證每一頁與定義逐字相同（check-all 會跑）
 *
 * ⚠️ **要改導覽或頁尾，改這支檔案然後跑一次，不要直接改 HTML。**
 *    直接改 HTML 的話，--check 會紅。
 *
 * ⚠️ 唯一允許每頁不同的是 `aria-current="page"`（標出目前所在頁）。
 */
const fs = require('fs');
const path = require('path');

const LEGAL = path.join(__dirname, '..', 'legal');

/** 哪些頁面套用共用外框。後台（secret-pitstop.html）刻意不在內——那是內部工具，版面完全不同。 */
const PAGES = ['index.html', 'buy.html', 'faq.html', 'contact.html', 'paid.html', 'account.html', 'terms.html', 'privacy.html', '404.html', 'welcome.html'];

/** 導覽項目：[網址, 文字, 對應的頁面檔名] */
const TICK = 'F1TV 英文 CC 即時翻成繁體中文 / 台灣用語 / 不用換平台 / 每天免費 15 分鐘 / ';

const NAV = [
  ['/', '首頁', 'index.html'],
  ['/buy', '方案', 'buy.html'],
  ['/faq', '常見問題', 'faq.html'],
  ['/account', '我的帳號', 'account.html'],
  ['/contact', '聯絡我們', 'contact.html'],
];

function header(page) {
  const cur = (file) => (file === page ? ' aria-current="page"' : '');
  return [
    '<!-- SITE-HEADER：由 tools/site-chrome.js 產生，請勿直接修改 -->',
    // ⚠️ 不再是一條橫列（使用者 2026-10-02：「上排標題移除，改成與 F1TV 名次側欄一樣的效果」）。
    //    .site-header 現在只是個容器，真正的兩個東西是浮在左側的面板與浮在右上的字標。
    // 暫停鍵的狀態（首頁 Hero 的那顆，motion.js）。**內嵌**而不是外部檔案：
    // 要在側欄跑馬燈畫出來之前就套上，外部檔案（defer）會先跑一下才停。
    // ⚠️ try/catch：無痕模式或封鎖儲存空間時 localStorage 會丟例外。
    '<script>try{if(localStorage.getItem(\'pl_motion\')===\'paused\')document.documentElement.setAttribute(\'data-motion\',\'paused\')}catch(e){}</script>',
    '<header class="site-header">',
    '  <div class="inner">',
    '    <nav class="site-nav" aria-label="主要導覽">',
    // 面板抬頭：比照 F1 名次表的「F1 RACE ／ LAP 4/50」。
    // ⚠️ aria-hidden：右上角的 .brand 才是真正的首頁連結與品牌標示，
    //    這裡再讓螢幕閱讀器念一次 PitLingo 只是重複。
    // ⚠️ 面板抬頭是**可以點回首頁的連結**（使用者 2026-10-02）。
    //    所以不能再 aria-hidden —— 隱藏的連結對鍵盤與螢幕閱讀器是陷阱：
    //    tab 會停在一個「存在但念不出來」的東西上。
    //    右上角的 .brand 也是回首頁，兩個都指向同一處是正常的
    //    （就像頁首 logo 與側欄 logo 並存）。
    '      <a class="nav-head" href="/">',
    '        <span class="nav-mark">PitLingo</span>',
    '      </a>',
    // ⚠️ 跑馬燈 aria-hidden：循環的裝飾帶，讓螢幕閱讀器重複念兩遍只是噪音。
    //    文字重複兩份是為了無縫循環（translateX(-50%) 剛好接回起點）。
    //    ⚠️ 文案只放確定為真的句子，不放任何統計數字。
    '      <div class="nav-tick" aria-hidden="true"><span>' + TICK + TICK + '</span></div>',
    '      <div class="nav-list">',
    // 名次編號：F1 計時板的語彙。aria-hidden——螢幕閱讀器念「一 首頁」只是雜訊。
    // .tc 是每列最左的車隊代表色塊；.nm 的 border-left 就是編號後面那道「|」。
    ...NAV.map(([href, text, file], i) => `        <a href="${href}"${cur(file)}><i class="tc" aria-hidden="true"></i><span class="pos" aria-hidden="true">${i + 1}</span><span class="nm">${text}</span></a>`),
    '      </div>',
    // ⚠️ 全站主要 CTA 統一是「免費試用 15 分鐘」（使用者 2026-09-17 指定）。
    //    不要換成「立即購買／開始使用／立即體驗」——各頁說法不同會讓轉換路徑變模糊。
    // ⚠️ CTA 留在導覽裡：它是全站最重要的轉換按鈕，面板模式會變成面板底部那一列紅色的。
    '      <a class="nav-cta" href="/#try">免費試用 15 分鐘</a>',
    // 面板最下方的流動橫線：由「>」形狀排成，由左向右跑。
    // ⚠️ 圖形用 CSS background 的 SVG data URI 畫，不是外部檔案——
    //    一條裝飾線不值得多一個 HTTP 請求，也不必進 MEDIA_LICENSES。
    '      <div class="nav-flow" aria-hidden="true"></div>',
    // 右緣的虛直線。外層負責捲動連動的位移，內層負責閒置時的緩慢飄動——
    // 兩個動畫分屬不同時間軸，必須掛在不同元素上才不會互相覆蓋。
    '      <div class="nav-rail" aria-hidden="true"><i></i></div>',
    '    </nav>',
    '    <a class="brand" href="/"><img src="/icon128.png" alt="" width="30" height="30"><span>PitLingo</span></a>',
    '  </div>',
    '</header>',
    '<!-- /SITE-HEADER -->',
  ].join('\n');
}

// ⚠️ 頁尾同時滿足 check-legal 對條款與隱私權的三個要求：
//    兩份文件互相連結、都有聯絡信箱、都有與 Formula 1 無關聯的聲明。
//    改這裡之前先跑 `node tools/check-legal.js`。
const FOOTER = [
  '<!-- SITE-FOOTER：由 tools/site-chrome.js 產生，請勿直接修改 -->',
  '<footer class="site-footer">',
  '  <div class="inner">',
  '    <nav aria-label="頁尾導覽">',
  '      <a href="/buy">購買</a>',
  '      <a href="/faq">常見問題</a>',
  '      <a href="/account">我的帳號</a>',
  '      <a href="/contact">聯絡我們</a>',
  '      <a href="/terms">使用條款</a>',
  '      <a href="/privacy">隱私權政策</a>',
  '      <a href="mailto:pitlingo.office@gmail.com">pitlingo.office@gmail.com</a>',
  '    </nav>',
  '    <p>PitLingo 為獨立開發的第三方工具，與 Formula 1、FIA 或 Formula One World Championship Limited',
  '    無任何關聯，亦未獲其背書。F1、FORMULA 1 等商標均為其所有人之財產。</p>',
  '  </div>',
  '</footer>',
  '<!-- /SITE-FOOTER -->',
].join('\n');

const HEAD_RE = /<!-- SITE-HEADER[\s\S]*?<!-- \/SITE-HEADER -->/;
const FOOT_RE = /<!-- SITE-FOOTER[\s\S]*?<!-- \/SITE-FOOTER -->/;

const check = process.argv.includes('--check');
const problems = [];

for (const page of PAGES) {
  const file = path.join(LEGAL, page);
  const raw = fs.readFileSync(file, 'utf8');
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const src = raw.replace(/\r\n/g, '\n');
  const wantH = header(page);

  if (check) {
    const h = src.match(HEAD_RE);
    const f = src.match(FOOT_RE);
    if (!h) problems.push(`${page}：沒有共用頁首`);
    else if (h[0] !== wantH) problems.push(`${page}：頁首與定義不同（有人直接改了 HTML？）`);
    if (!f) problems.push(`${page}：沒有共用頁尾`);
    else if (f[0] !== FOOTER) problems.push(`${page}：頁尾與定義不同（有人直接改了 HTML？）`);
    // 頁首要緊接在 <body> 之後、頁尾要在 </body> 之前——放錯位置的話
    // 吸頂導覽會被別的容器夾住，視覺上看起來「沒有吸頂」而不報錯
    if (h && !/<body[^>]*>\s*<!-- SITE-HEADER/.test(src)) problems.push(`${page}：頁首不在 <body> 的最前面`);
    if (f && !/<!-- \/SITE-FOOTER -->\s*<\/body>/.test(src)) problems.push(`${page}：頁尾不在 </body> 的最後面`);
    continue;
  }

  let out = src;
  out = HEAD_RE.test(out) ? out.replace(HEAD_RE, () => wantH) : out.replace(/<body([^>]*)>\n?/, (m, a) => `<body${a}>\n${wantH}\n`);
  out = FOOT_RE.test(out) ? out.replace(FOOT_RE, () => FOOTER) : out.replace(/\n?<\/body>/, () => `\n${FOOTER}\n</body>`);
  // ⚠️ 取代字串一律用函式形式：頁面內容裡若有 `$'` 之類的序列，字串形式會把半個檔案複製進來
  fs.writeFileSync(file, out.replace(/\n/g, nl), 'utf8');
  console.log('已套用：' + page);
}

if (check) {
  if (problems.length) {
    problems.forEach((p) => console.log('❌ ' + p));
    console.log('\n修法：改 tools/site-chrome.js 的定義後執行 `node tools/site-chrome.js`');
    process.exit(1);
  }
  console.log(`✅ ${PAGES.length} 個頁面的頁首與頁尾都與定義逐字相同`);
}
