#!/usr/bin/env node
/**
 * 網站「後台可編輯」的規則（2026-09-18 全站開放編輯時新增）
 *
 * 使用者要求網站的每一頁都能在後台修改。這件事有四種壞法，全部不會報錯：
 *
 *   1. **可編輯的元素裡有連結或清單。** 覆寫時整段會被換成純文字（只支援 **粗體** 與換行），
 *      連結與清單當場消失——頁面看起來只是「少了一個連結」，沒有人會發現。
 *   2. **兩頁用了同一個鍵。** 全站共用一份內容，改常見問題的標題會連購買頁一起改掉。
 *   3. **頁面標了 data-edit 卻沒載入 site-content.js**（或沒有 pl-hydrating）。
 *      後台改了、發布了、網站上就是不變。
 *   4. **發布的文字把系統數字寫錯。** check-legal／check-consistency 只讀 HTML 的預設值，
 *      看不到後台發布的覆寫——所以後端要自己擋（siteFactProblems），這裡驗那道門真的有效，
 *      而且**每一頁的預設文字本身都過得了那道門**（否則原封不動按發布也會被拒絕）。
 *
 * 另外：使用條款與隱私權政策**不可以**被標成可編輯（法律文件，有 check-legal 比對系統行為）。
 *
 * 用法：node tools/check-site-content.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

let failed = 0;
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { failed++; console.log('❌ ' + m); };
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const ADMIN = read('legal/secret-pitstop.html');
const BACKEND = require('./lib/backend-src').readBackend();

// ---- 後台列出的頁面 ----
const pagesBlock = (ADMIN.match(/const ST_PAGES = \[([\s\S]*?)\n\];/) || [])[1] || '';
const PAGES = [...pagesBlock.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => m[1]);
const fileOf = (u) => (u === '/' ? 'legal/index.html' : `legal${u}.html`);
if (!PAGES.length) bad('後台找不到 ST_PAGES（可編輯頁面清單）');

// 取出元素的內容（處理同名標籤巢狀）
function innerOf(html, idx) {
  const open = html.lastIndexOf('<', idx);
  const tag = (html.slice(open + 1).match(/^([a-zA-Z0-9]+)/) || [])[1];
  const start = html.indexOf('>', idx) + 1;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (!depth) return { tag, inner: html.slice(start, m.index) };
  }
  return { tag, inner: null };
}

const KEY_RE = new RegExp((BACKEND.match(/const SITE_KEY_RE = \/(.+)\/;/) || [])[1] || '^$');
const SEC_RE = new RegExp((BACKEND.match(/const SITE_SECTION_RE = \/(.+)\/;/) || [])[1] || '^$');
const KEYS_MAX = Number((BACKEND.match(/const SITE_KEYS_MAX = (\d+);/) || [])[1]);
const SECS_MAX = Number((BACKEND.match(/const SITE_SECTIONS_MAX = (\d+);/) || [])[1]);

const textOwner = new Map();   // 鍵 → 頁面
const hrefOwner = new Map();
const secOwner = new Map();
const defaults = {};           // 鍵 → 預設文字（給事實守門用）
const problems = { leaf: [], dupe: [], key: [], wiring: [] };

for (const u of PAGES) {
  const f = fileOf(u);
  if (!fs.existsSync(path.join(root, f))) { problems.wiring.push(`${u}：找不到 ${f}`); continue; }
  const html = read(f).replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
  const edits = [...html.matchAll(/ data-edit="([^"]+)"/g)];
  if (!edits.length) problems.wiring.push(`${u}：沒有任何 data-edit，後台列了這一頁卻沒有東西可以改`);
  if (!/<script src="\/site-content\.js/.test(html)) problems.wiring.push(`${u}：沒有載入 site-content.js（後台改了網站也不會變）`);
  if (!/<html[^>]*class="[^"]*pl-hydrating/.test(html)) problems.wiring.push(`${u}：<html> 沒有 pl-hydrating（第一次載入會先閃預設文字）`);

  for (const m of edits) {
    const k = m[1];
    if (!KEY_RE.test(k)) problems.key.push(`${u}：鍵「${k}」不符合後端格式，發布時會被丟掉`);
    if (textOwner.has(k) && textOwner.get(k) !== u) problems.dupe.push(`「${k}」同時在 ${textOwner.get(k)} 與 ${u}`);
    else if (textOwner.has(k)) problems.dupe.push(`「${k}」在 ${u} 出現兩次`);
    textOwner.set(k, u);
    const { tag, inner } = innerOf(html, m.index);
    if (inner == null) { problems.leaf.push(`${u}：「${k}」的 <${tag}> 找不到結尾`); continue; }
    const tags = [...inner.matchAll(/<\/?([a-zA-Z0-9]+)/g)].map((x) => x[1].toLowerCase());
    const badTags = [...new Set(tags.filter((t) => !['b', 'strong', 'br'].includes(t)))];
    if (badTags.length) problems.leaf.push(`${u}：「${k}」裡面有 <${badTags.join('>、<')}>——覆寫時會變成純文字而消失`);
    defaults[k] = inner.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(b|strong)>/gi, '**').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }
  for (const m of html.matchAll(/ data-edit-href="([^"]+)"/g)) {
    const k = m[1];
    if (!KEY_RE.test(k)) problems.key.push(`${u}：連結鍵「${k}」不符合後端格式`);
    if (hrefOwner.has(k)) problems.dupe.push(`連結「${k}」同時在 ${hrefOwner.get(k)} 與 ${u}`);
    hrefOwner.set(k, u);
  }
  for (const m of html.matchAll(/ data-section="([^"]+)"/g)) {
    const id = m[1];
    if (!SEC_RE.test(id)) problems.key.push(`${u}：區塊「${id}」不符合後端格式`);
    if (secOwner.has(id)) problems.dupe.push(`區塊「${id}」同時在 ${secOwner.get(id)} 與 ${u}`);
    secOwner.set(id, u);
  }
  if (/ data-section="/.test(html) && !/ id="sections"/.test(html)) {
    problems.wiring.push(`${u}：有 data-section 卻沒有 id="sections" 的容器，區塊排序不會生效`);
  }
}

problems.wiring.length ? bad('頁面沒有接好：\n     ' + problems.wiring.join('\n     '))
  : ok(`${PAGES.length} 個可編輯頁面都載入 site-content.js、都有 pl-hydrating、都有可編輯欄位`);
problems.leaf.length ? bad('可編輯元素裡有覆寫後會消失的結構：\n     ' + problems.leaf.join('\n     '))
  : ok(`${textOwner.size} 個可編輯文字都是葉節點（裡面只有粗體與換行）`);
problems.dupe.length ? bad('鍵撞名（全站共用一份內容，改一頁會連另一頁一起改）：\n     ' + problems.dupe.join('\n     '))
  : ok('全站的文字鍵、連結鍵、區塊代號都不重複');
problems.key.length ? bad(problems.key.join('\n     ')) : ok('所有鍵都符合後端的格式（不會在發布時被丟掉）');

textOwner.size + hrefOwner.size <= KEYS_MAX
  ? ok(`欄位總數 ${textOwner.size + hrefOwner.size}，在後端上限 ${KEYS_MAX} 以內`)
  : bad(`欄位總數 ${textOwner.size + hrefOwner.size} 超過後端上限 ${KEYS_MAX}——多出來的會在發布時被靜靜丟掉`);
secOwner.size <= SECS_MAX
  ? ok(`區塊總數 ${secOwner.size}，在後端上限 ${SECS_MAX} 以內`)
  : bad(`區塊總數 ${secOwner.size} 超過後端上限 ${SECS_MAX}`);

// ---- 法律文件不可以被標成可編輯 ----
{
  const leak = ['legal/terms.html', 'legal/privacy.html'].filter((f) => / data-edit(-href)?="/.test(read(f)));
  const listed = PAGES.filter((u) => /terms|privacy/.test(u));
  leak.length || listed.length
    ? bad('使用條款／隱私權政策被開放編輯了（法律文件，check-legal 在比對系統行為）：' + [...leak, ...listed].join('、'))
    : ok('使用條款與隱私權政策沒有開放編輯');
}

// ---- 事實守門 ----
{
  let src = "'use strict';\n" + BACKEND;
  src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
  src = src.replace(/\bexport\s+class\s+/g, 'class ');
  const sandbox = {
    crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
    Response: class {}, Request: class {}, URL, console, Date, Math, JSON, Map, Set, Promise, RegExp, Error,
    Object, Array, String, Number, Boolean, parseInt, parseFloat, isFinite,
    fetch: async () => { throw new Error('no network'); },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(src + '\n;this.__api = { siteFactProblems, sanitizeSiteContent };', vm.createContext(sandbox));
  const A = sandbox.__api;

  // 每一頁的預設文字原封不動發布，一定要過得了——否則使用者什麼都沒改，按發布卻被拒絕
  const asIs = A.siteFactProblems({ texts: defaults }, {});
  asIs.length
    ? bad('網站的預設文字本身就過不了發布前的數字核對：\n     ' + asIs.join('\n     '))
    : ok(`${Object.keys(defaults).length} 段預設文字原封不動發布都過得了數字核對`);

  const cases = [
    ['登入後免費試用 30 分鐘', true, '免費分鐘數寫錯'],
    ['每一場都能免費試看 15 分鐘，不登入 5 分鐘', false, '正確的免費分鐘數'],
    ['同一組碼最多可在 5 台裝置同時啟用', true, '裝置數寫錯'],
    ['同時最多 3 台', false, '正確的裝置數'],
    ['比賽週通行證 NT$39', true, '不存在的價格'],
    ['比賽週通行證 NT$49', false, '正確的價格'],
    ['在 Chrome 加入擴充功能，一分鐘完成', false, '與免費無關的時間'],
    ['影片 30 分鐘後開始', false, '沒有提到免費的分鐘數'],
  ];
  const wrong = cases.filter(([t, expect]) => (A.siteFactProblems({ texts: { x: t } }, {}).length > 0) !== expect)
    .map(([t, expect, label]) => `${label}「${t}」應該${expect ? '被擋' : '放行'}`);
  wrong.length ? bad('發布前的數字核對判斷錯誤：' + wrong.join('；'))
    : ok(`發布前的數字核對：${cases.length} 個情境（免費分鐘數／裝置數／價格，以及不該擋的）都正確`);
}

console.log('');
if (failed) { console.log(`❌ 網站可編輯內容有 ${failed} 項未通過`); process.exit(1); }
console.log('✅ 網站可編輯內容的規則全部成立');
