#!/usr/bin/env node
/**
 * 檢查「寄信內容可以在後台編輯」（v5.94，backend/src/parts/25-mail-content.js）
 *
 *   1. 沒有覆寫時用預設：歡迎信標題＝「歡迎使用 PitLingo」、有「已經建立完成」、沒有 Ray 要刪的兩句
 *   2. 覆寫的標題與內文會被用上；{email}、{mins} 換成實際值
 *   3. 內文是純文字：<script>、onerror 一律變成字；信箱（外人可決定）也逸出
 *   4. 連結白名單：javascript:、外部網址不會變成連結，發布時被擋
 *   5. 發布前核對系統事實（免費分鐘數、價格）與行銷規則（車隊無線電、VPN）
 *   6. 發布留歷史；KV 讀壞了照樣寄（用預設）
 *
 *   node tools/check-mail-content.js
 */
'use strict';
const vm = require('vm');
const { readBackend } = require('./lib/backend-src');

let failed = 0;
const expect = (c, m) => { if (c) console.log('✅ ' + m); else { failed++; console.log('❌ ' + m); } };

let src = "'use strict';\n" + readBackend();
src = src.replace(/export default \{[\s\S]*?\n\};\r?\n/, '');
src = src.replace(/\bexport\s+class\s+/g, 'class ');

const kv = new Map();
let puts = 0;
const SUBS = {
  async get(k) { return kv.has(k) ? kv.get(k) : null; },
  async put(k, v) { puts++; kv.set(k, v); },
  async delete(k) { kv.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const sandbox = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
  Response: class {}, Request: class {}, URL, console: { log() {}, warn() {}, error() {} },
  Date, Math, JSON, Map, Set, Promise, RegExp, Error, Object, Array, String, Number, Boolean,
  parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
  caches: { default: { async match() {}, async put() {}, async delete() {} } },
  fetch: async (u) => { throw new Error('未預期的網路呼叫：' + u); },
};
vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__M = { composeMail, sanitizeMailContent, mailContentProblems, publishMailContent, MAIL_DEFS, mailShell, esc, REMOTE_CONFIG };', sandbox);
const M = sandbox.__M;
const env = { SUBS, SITE_URL: 'https://pitlingo.com' };
const mins = Math.round(((M.REMOTE_CONFIG.freeTier || {}).seconds || 900) / 60);

(async () => {
  // 1) 預設
  let m = await M.composeMail(env, 'welcome', { email: 'a@b.com', mins });
  expect(m.subject === '歡迎使用 PitLingo' && m.title === '歡迎使用 PitLingo', `預設標題＝「歡迎使用 PitLingo」：${m.subject}`);
  expect(m.bodyHtml.includes('已經建立完成') && m.bodyHtml.includes('a@b.com'), '預設內文告訴使用者帳號已經建立完成，帶著他的信箱');
  expect(!/唯一一封|不需要輸入任何序號|雙語對照一眼看懂/.test(m.bodyHtml), '預設內文沒有 Ray 要刪的句子');
  expect(m.bodyHtml.includes(`每天免費 ${mins} 分鐘`), `免費分鐘數讀系統設定（${mins}）`);
  expect(m.bodyHtml.includes('href="https://pitlingo.com/buy"') && m.bodyHtml.includes('購買 Weekend Pass'), '單獨一行的 [文字](/buy) 變成按鈕，站內路徑補成完整網址');
  expect(/<h2[^>]*>現在就能用<\/h2>/.test(m.bodyHtml) && /<li[^>]*>/.test(m.bodyHtml), '## 小標題與 - 清單照樣式渲染');

  // 2) 覆寫
  const draft = M.sanitizeMailContent({ texts: {
    'welcome.subject': '嗨 {email}',
    'welcome.body': '您好：\n\n帳號 **{email}** 好了，每天免費 {mins} 分鐘。',
    'evil.key': 'x',
  } });
  expect(!('evil.key' in draft.texts), '不認得的鍵丟掉');
  m = await M.composeMail(env, 'welcome', { email: 'a@b.com', mins }, draft);
  expect(m.subject === '嗨 a@b.com' && m.bodyHtml.includes('<b style="color:#ffffff">a@b.com</b>'), '覆寫的標題與內文被用上，變數換成實際值');

  // 3) 純文字
  const x = M.sanitizeMailContent({ texts: { 'welcome.body': '<script>alert(1)</script>\n<img src=x onerror=alert(1)>' } });
  m = await M.composeMail(env, 'welcome', { email: '"><img src=x onerror=1>@b.com', mins }, x);
  expect(!/<script|<img src=x/i.test(m.bodyHtml) && m.bodyHtml.includes('&lt;script&gt;'), '內文的 HTML 一律變成字');
  m = await M.composeMail(env, 'welcome', { email: '<b>x</b>@b.com', mins });
  expect(!m.bodyHtml.includes('<b>x</b>') && m.bodyHtml.includes('&lt;b&gt;x&lt;/b&gt;'), '信箱（外人決定的字串）也逸出');

  // 4) 連結白名單
  const bad = M.sanitizeMailContent({ texts: { 'welcome.body': '[點我](javascript:alert(1))\n\n去 [這裡](https://evil.example/x) 看' } });
  m = await M.composeMail(env, 'welcome', { email: 'a@b.com', mins }, bad);
  expect(!/href="javascript|evil\.example"/.test(m.bodyHtml), 'javascript: 與外部網址不會變成連結');
  const pb = M.mailContentProblems(bad, {});
  expect(pb.length >= 1 && pb.every((p) => /允許範圍/.test(p)), `發布時擋下不允許的連結：${pb.length} 項`);

  // 5) 系統事實與行銷規則
  const wrong = M.sanitizeMailContent({ texts: { 'welcome.body': `每天免費 ${mins + 15} 分鐘，只要 NT$1。也有 Team Radio，記得開 VPN。` } });
  const pw = M.mailContentProblems(wrong, {});
  expect(pw.some((p) => /分鐘/.test(p)) && pw.some((p) => /NT\$1/.test(p)) && pw.some((p) => /無線電/.test(p)) && pw.some((p) => /VPN/.test(p)),
    `寫錯免費分鐘數、價格、提車隊無線電、推 VPN 都被擋（${pw.length} 項）`);
  expect(M.mailContentProblems(M.sanitizeMailContent({ texts: { 'welcome.body': M.MAIL_DEFS.welcome.body } }), {}).length === 0, '預設內容本身通過檢查');

  // 6) 發布與歷史；KV 壞掉照樣用預設
  await M.publishMailContent(env, draft, 'ray', '第一次');
  await M.publishMailContent(env, M.sanitizeMailContent({ texts: {} }), 'ray', '第二次');
  const hist = JSON.parse(kv.get('mail:history'));
  expect(JSON.parse(kv.get('mail:content')).version === 2 && hist.length === 1 && hist[0].version === 1, '發布兩次：本體第 2 版、歷史留第 1 版');
  kv.set('mail:content', '{壞掉');
  m = await M.composeMail(env, 'welcome', { email: 'a@b.com', mins });
  expect(m.subject === '歡迎使用 PitLingo' && m.bodyHtml.includes('已經建立完成'), 'KV 內容壞掉時照樣寄預設內容');

  // 7) 所有寄給使用者的信都開放（2026-11-05 Ray：「都要開放編輯」）
  kv.delete('mail:content');
  const S = vm.runInContext('MAIL_SAMPLES', sandbox);
  const ids = Object.keys(M.MAIL_DEFS);
  expect(['welcome', 'otp', 'claim', 'newdevice', 'order', 'order_nokey', 'reissue', 'gift', 'f1ready'].every((i) => ids.includes(i) && S[i]),
    `9 種信都可編輯、都有預覽：${ids.join('、')}`);
  const out = {};
  for (const i of ids) out[i] = await S[i](env);
  expect(ids.every((i) => out[i].subject && out[i].html.includes('</html>') && !/\{\{|\{\w+\}/.test(out[i].html.replace(/<style[\s\S]*?<\/style>/g, ''))),
    '每一封用預設內容都組得出來，沒有殘留的 {變數} 或 {{區塊}}');
  expect(out.otp.html.includes('000000') && out.claim.html.includes('000000') && !/000000/.test(out.otp.subject + out.claim.subject),
    '驗證碼在內文、不在標題');
  expect(['order', 'order_nokey', 'reissue'].every((i) => out[i].html.includes('非統一發票') && out[i].html.includes('交易明細')),
    '三種訂單信都有交易明細與「非統一發票」');
  expect(out.order.html.includes('啟用方式') && !out.order_nokey.html.includes('啟用方式') && out.order_nokey.html.includes('不含字幕翻譯使用權'),
    '有授權的訂單有啟用方式；不含授權的明講為什麼');
  expect(out.newdevice.html.includes('Windows Chrome') && out.newdevice.html.includes('此地點可能不精確'), '新裝置通知帶著裝置與地點區塊');
  expect(out.order.subject === 'PitLingo 訂單完成（SAMPLE-WEEK）', `訂單信標題帶訂單編號：${out.order.subject}`);
  const noId = await vm.runInContext('buildLicenseMail', sandbox)(env, 'a@b.com', 'K', { items: [] }, {});
  expect(noId.subject === 'PitLingo 訂單完成', `沒有訂單編號時不留空括號：${noId.subject}`);

  // 8) 必要區塊、區塊位置、VPN 只限代訂
  const noCode = M.sanitizeMailContent({ texts: { 'otp.body': '請輸入驗證碼。' } });
  expect(M.mailContentProblems(noCode, {}).some((x) => /\{\{code\}\}/.test(x)), '驗證碼信刪掉 {{code}} 不准發布');
  const codeInSubj = M.sanitizeMailContent({ texts: { 'otp.subject': '驗證碼 {{code}}' } });
  expect(M.mailContentProblems(codeInSubj, {}).some((x) => /只能放在內文/.test(x)), '{{code}} 放進標題不准發布');
  const unknownBlk = M.sanitizeMailContent({ texts: { 'welcome.body': '{{receipt}}' } });
  expect(M.mailContentProblems(unknownBlk, {}).some((x) => /沒有 \{\{receipt\}\}/.test(x)), '用了這封信沒有的區塊不准發布');
  const noReceipt = M.sanitizeMailContent({ texts: { 'order.body': '謝謝購買。' } });
  expect(M.mailContentProblems(noReceipt, {}).some((x) => /receipt/.test(x)), '訂單信刪掉交易明細不准發布');
  expect(M.mailContentProblems(M.sanitizeMailContent({ texts: { 'f1ready.body': M.MAIL_DEFS.f1ready.body } }), {}).length === 0
    && M.mailContentProblems(M.sanitizeMailContent({ texts: { 'gift.body': '記得開 VPN' } }), {}).length === 1,
    'VPN 只准出現在代訂的信');
  // KV 被手動改壞（少了必要區塊）時，那一封退回預設內文——不可以寄出沒有驗證碼的驗證碼信
  kv.set('mail:content', JSON.stringify({ version: 9, texts: { 'otp.body': '沒有碼', 'otp.subject': '登入用' } }));
  const broken = await S.otp(env);
  expect(broken.html.includes('000000') && broken.subject === '登入用', 'KV 裡的內文少了必要區塊：內文退回預設（驗證碼照樣在），標題照用');
  // 每一封的預設內容本身都通過發布檢查
  const allDefault = { texts: {} };
  for (const i of ids) for (const f of ['subject', 'heading', 'body']) allDefault.texts[i + '.' + f] = M.MAIL_DEFS[i][f];
  const pd = M.mailContentProblems(M.sanitizeMailContent(allDefault), {});
  expect(pd.length === 0, '每一封的預設內容都通過發布檢查' + (pd.length ? '：' + pd.join('；') : ''));

  if (failed) { console.log(`\n❌ ${failed} 項未通過`); process.exit(1); }
  console.log('\n✅ 寄信內容編輯全部通過');
})().catch((e) => { console.log('❌ ' + (e.stack || e)); process.exit(1); });
