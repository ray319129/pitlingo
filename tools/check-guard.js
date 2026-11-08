#!/usr/bin/env node
/**
 * 譯文合理性守門的兩份複本（後端／擴充功能）必須一致。
 * ⚠️ 2026-10-28 起 userscript 封存在 archive/（凍結、不再維護），不再列入比對。
 *
 * ⚠️ **這是第四個跨檔案的硬性契約**（前三個是 normKey、SYSTEM_PROMPT、
 *    userscript 版本號）。對不起來的後果與 normKey 同類：不報錯，
 *    只是同一句話在不同產物上表現不同——後端擋掉了、用戶端放行，
 *    或者反過來，而使用者只會覺得「有時候有怪句子、有時候少一句」。
 *
 * 兩份：
 *   backend/src/parts/*.js               ROLE_BREAK / latinEchoOk / plausibleTranslation()
 *   extension/src/shared/normalize.js    ROLE_BREAK / latinEchoOk / PL.plausible()
 *
 * 除了比對規則本身，還跑四組**行為樣本**：
 *   - 真實發生過的模型自言自語必須被擋
 *   - 真實的轉播譯文必須放行
 *   - **人名／隊名／數字的正確譯文（沒有中文）必須放行**
 *   - 壞掉的無中文譯文（只剩標點、整句只翻出一個名字）必須被擋
 *
 * ⚠️ **只測「壞的有沒有擋下」會讓規則愈收愈緊，直到正常字幕也被吃掉**——
 *    而那個症狀是「偶爾少一句」，沒有人會回報。正反兩邊都要測。
 *
 * 用法：node tools/check-guard.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { readBackend, BACKEND_LABEL } = require('./lib/backend-src');
const read = (f) => (f === BACKEND_LABEL ? readBackend() : fs.readFileSync(path.join(root, f), 'utf8'));

let bad = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { bad++; console.log('  ❌ ' + m); };

const FILES = [
  [BACKEND_LABEL, 'backend'],
  ['extension/src/shared/normalize.js', 'extension'],
];

const RE_ROLE = /const ROLE_BREAK = new RegExp\(\[[\s\S]*?\]\.join\('\|'\)\);/;
const RE_INJ = /const INJECTION_HINT = \/.*\/i;/;
const RE_LATIN = /function latinEchoOk\(en, t\) \{[\s\S]*?\n\}/;
const RE_LATIN_IND = /function latinEchoOk\(en, t\) \{[\s\S]*?\n\s*\}/;

/* --- 1. 三段規則都必須一字不差 --- */
for (const [name, re] of [['ROLE_BREAK', RE_ROLE], ['INJECTION_HINT', RE_INJ], ['latinEchoOk', RE_LATIN_IND]]) {
  const got = new Map();
  for (const [f, label] of FILES) {
    const m = read(f).match(re);
    if (m) got.set(label, m[0].split('\n').map((x) => x.trim()).filter(Boolean).join('\n'));
  }
  if (got.size !== FILES.length) { no(`${name}：只在 ${[...got.keys()].join('、')} 找得到`); continue; }
  new Set(got.values()).size === 1
    ? ok(`${name} 三份一致`)
    : no(`${name} 三份不一致：\n` + [...got].map(([k, v]) => `     --- ${k} ---\n     ` + v.replace(/\n/g, '\n     ')).join('\n'));
}

/* --- 2. 行為樣本 --- */
const LEAK = [
  ['我沒有收到任何關於 Isaac Hadjar 的資訊。（注：根據我的知識庫，請提供完整的轉播內容片段，我會直接翻譯。）', '2026-08-21 直播實際外洩'],
  ['注：這句話沒有上下文', '括號外的註解'],
  ['以下是這句話的翻譯', '模型自報'],
  ['作為 AI 助理，我', '自稱 AI'],
  ['請提供完整的原文', '要求輸入'],
  ['這句無法翻譯', '拒答'],
  ['翻譯如下：他贏了', '前綴'],
  // 2026-11-02 R19 正賽 1:51:00 實際顯示在畫面上（other → …）；共用快取裡同類 48 句
  ['我準備好了。請輸入需要翻譯的 F1 轉播內容。', 'R19 實際外洩：短片段被當成對話開頭'],
  ['我已準備好。請輸入要翻譯的英文轉播評論。', '同上'],
  ['我需要你提供要翻譯的英文內容。\n\n請直接貼上轉播評論或字幕，我會立即翻譯成台灣賽車圈慣用的繁體中文。', 'R19 want → 帶空行的長段'],
  ['我看不到圖片。請直接貼上英文轉播評論的文字', 'pic → 回應圖片'],
  ['我無法回答這個問題。\n\n我是 F1 轉播字幕翻譯器，只翻譯轉播畫面上別人講的話。', '自稱翻譯器'],
  ['收到。我已準備好按照上述規則進行 F1 轉播字幕翻譯。', '引用提示詞'],
  ['沒有英文轉播內容可翻譯。', '回報沒有輸入'],
  ['(空)', 'R19 1:54:45 實際外洩：規則 6 的空字串被寫成字'],
  ['（此行無內容）', '整句括號旁白'],
  ['（句子未完，無法翻譯）', '整句括號旁白'],
  ['（此行為上文續句，已併入第 3 行）', '整句括號旁白'],
  ['空字串（無意義輸入）', '把空字串寫出來'],
  ['空', '只剩一個字'],
];
// ⚠️ 這些是**真實的轉播譯文**，誤攔它們就是在正賽最激動的時刻把字幕挖掉。
const REAL = [
  ['我無法相信他沒有在發車順序上', '車手無線電常見句'],
  ['我不能再推了，輪胎完蛋了', '車手無線電常見句'],
  ['以下是本場最快單圈的車手', '播報員的正常用語'],
  ['原文是這樣說的沒錯', '正常對話'],
  ['他今天經歷了不少波折才拿到第二名', '一般播報'],
  ['觀眾們的情緒恢復了，但他們剛才受到了巨大的衝擊', '一般播報'],
  ['昨天他用他的職業生涯第八個竿位向我們證明了這一點', '一般播報'],
  // 2026-11-02 加規則時在共用快取 30 萬句裡找到、差點被誤擋的真實譯文
  ['但根據規則，我覺得他站不住腳', '「根據規則」是播報常用語（58 句）'],
  ['根據規則 Q1、SQ1、SQ2', '規則後面接數字'],
  ['他可能在聽轉播評論', '「轉播評論」本身可以是內容'],
  ['好像她在聽轉播評論，速度降到 60 KPH', '同上'],
  ['「轟油門」', '整句被引號包住是正常的'],
  ['他準備好了，請看他的起步', '「準備好了」不是「我」說的'],
];
// ⚠️ **人名／隊名／數字的正確譯文本來就沒有中文。**
//    SYSTEM_PROMPT 規定它們保留原文，所以「沒有中文就擋掉」會把它們全部吃掉。
//    線上實測（119 支影片、122,017 句）：965 句被那條規則擋下，其中 768 句是對的。
const LATIN_OK = [
  ['hamilton', 'Hamilton', '單一人名'],
  ['12', '12', '數字'],
  ['albert park', 'Albert Park', '賽道名'],
  ['albon albert park', 'Albon Albert Park', '人名＋賽道'],
  ['norris hamilton piastri leclerc gasly verstappen',
    'Norris、Hamilton、Piastri、Leclerc、Gasly、Verstappen', '一長串名字，帶中文標點'],
  ['formula one', 'F1', '縮寫'],
];
const LATIN_BAD = [
  ['pitlane', '。', '只剩標點'],
  ['ago', '。', '只剩標點'],
  ['he had a great run in 99 didn t he', 'Eddie Irvine', '整句只翻出一個名字'],
  ['and norris takes the lead here at turn one',
    'and norris takes the lead here at turn one', '整句照抄英文'],
];

function guardOf(file) {
  const src = read(file);
  const rb = src.match(RE_ROLE)[0];
  const ih = src.match(RE_INJ)[0];
  const le = src.match(RE_LATIN_IND)[0].split('\n').map((x) => x.replace(/^ {2}/, '')).join('\n');
  const body = [
    'if (typeof zh !== "string") return false;',
    'const t = zh.trim();',
    'if (!t) return false;',
    'if (t.length > Math.max(60, String(en || "").length * 2)) return false;',
    'if (INJECTION_HINT.test(t)) return false;',
    'if (ROLE_BREAK.test(t)) return false;',
    'if (!/[\u4e00-\u9fff]/.test(t) && !latinEchoOk(en, t)) return false;',
    'return true;',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${rb}\n${ih}\n${le}\nreturn function (en, zh) {\n${body}\n};`)();
}

{
  const g = guardOf(BACKEND_LABEL);
  // 英文長度給得寬鬆，才不會讓長度規則替代掉真正要測的規則
  const EN = 'x'.repeat(200);
  let n = 0;
  for (const [t, why] of LEAK) if (g(EN, t)) { n++; no(`外洩樣本沒擋下（${why}）：${t.slice(0, 40)}`); }
  if (!n) ok(`${LEAK.length} 個外洩樣本全部擋下`);

  n = 0;
  for (const [t, why] of REAL) if (!g(EN, t)) { n++; no(`正常譯文被誤擋（${why}）：${t}`); }
  if (!n) ok(`${REAL.length} 句真實轉播譯文全部放行`);

  n = 0;
  for (const [en, zh, why] of LATIN_OK) if (!g(en, zh)) { n++; no(`正確但沒有中文的譯文被擋（${why}）：${en} → ${zh}`); }
  if (!n) ok(`${LATIN_OK.length} 句「正確但沒有中文」的譯文全部放行`);

  n = 0;
  for (const [en, zh, why] of LATIN_BAD) if (g(en, zh)) { n++; no(`壞掉的無中文譯文沒擋下（${why}）：${en} → ${zh}`); }
  if (!n) ok(`${LATIN_BAD.length} 句壞掉的無中文譯文全部擋下`);
}

/* --- 3. 三份實作必須給出相同結果 --- */
//
// ⚠️ 規則一致不代表**用法**一致。這裡直接跑三份，對同一批樣本比對輸出。
{
  const gs = FILES.map(([f, label]) => [label, guardOf(f)]);
  const all = [...LEAK.map(([t]) => ['x'.repeat(200), t]), ...REAL.map(([t]) => ['x'.repeat(200), t]),
    ...LATIN_OK.map(([en, zh]) => [en, zh]), ...LATIN_BAD.map(([en, zh]) => [en, zh])];
  const diff = [];
  for (const [en, zh] of all) {
    const rs = gs.map(([, g]) => g(en, zh));
    if (new Set(rs).size > 1) diff.push(`${zh.slice(0, 30)} → ` + gs.map(([l], i) => `${l}=${rs[i]}`).join('、'));
  }
  diff.length
    ? no('三份實作對同一句話給出不同答案：\n     ' + diff.join('\n     '))
    : ok(`${all.length} 個樣本在三份實作上結果完全相同`);
}

/* --- 4. 守門必須套在該套的地方 --- */
{
  const be = read(BACKEND_LABEL);
  const seg = be.match(/for \(const m of chunk\) \{[\s\S]*?\n {6}\}/);
  if (!seg) no('找不到 /v1/translate 的回應迴圈');
  else {
    const i = seg[0].indexOf('plausibleTranslation');
    const j = seg[0].indexOf('result[m.k] = zh');
    (i >= 0 && j > i)
      ? ok('/v1/translate：不合理的譯文連請求者都拿不到')
      : no('/v1/translate 把未通過檢查的譯文回給請求者了（模型的自言自語會顯示在畫面上）');
  }
  /handlePostSubs[\s\S]*?plausibleTranslation/.test(be)
    ? ok('POST /v1/subs（收割上傳）也過同一道門')
    : no('POST /v1/subs 沒有做合理性檢查 —— 收割會把垃圾寫進所有人的共用快取');
}
{
  const mn = read('extension/src/content/main.js');
  /function remember\(k, zh\) \{[\s\S]{0,400}?self\.PL\.plausible/.test(mn)
    ? ok('擴充功能：remember() 是唯一入口，且有守門')
    : no('擴充功能的 remember() 沒有守門 —— 共用快取的舊資料會直接顯示');
  /state\.blocked/.test(mn) && /合理性檢查擋下/.test(mn)
    ? ok('擴充功能：攔截次數會出現在診斷報告裡')
    : no('攔截次數沒有進診斷報告 —— 過度攔截將無從發現');
}

console.log('');
console.log(bad ? `❌ ${bad} 項未通過` : '✅ 譯文守門兩份一致，且套在每一條路徑上');
process.exit(bad ? 1 : 0);
