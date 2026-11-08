#!/usr/bin/env node
/**
 * 擴充功能的三個版本：正式版、測試版（2026-09-17，使用者要求「分實際發布的版本與測試版本以防萬一」）、
 * 管理版（2026-10-11，取代 userscript 收割，handoff 9.1 #26）
 *
 *   dist/pitlingo-release   上架、給一般使用者的版本
 *                           · 所有 `@test-only`、`@admin-only` 區塊移除（__pitlingo.t.*、語音辨識、測試掛鉤、收割）
 *                           · 沒有 src/test/、src/admin/、沒有 tabCapture／offscreen 權限
 *   dist/pitlingo-test      你自己用的版本（名稱「PitLingo（測試版）」）
 *                           · 保留全部測試工具與語音辨識字幕；**不含**收割
 *                           · 權限多 tabCapture、offscreen
 *   dist/pitlingo-admin     收割用（名稱「PitLingo（管理版）」）＝正式版＋收割
 *                           · 保留 `@admin-only` 區塊與 src/admin/；**不含**測試工具；權限與正式版相同
 *
 * 原始碼只有一份（extension/）。測試專用的程式碼用標記包起來：
 *   JS/CSS：  /* @test-only:start *\/  …  /* @test-only:end *\/
 *   HTML：    <!-- @test-only:start -->  …  <!-- @test-only:end -->
 * 管理版專用的同理，標記改成 `@admin-only`。
 * ⚠️ 收割權杖能寫所有人共用的快取——**正式版與測試版都不可以有任何 `@admin-only` 的東西**，--check 會擋。
 *
 * ⚠️ **這取代了「上線前手動刪掉 TESTING 區塊」。** 手動刪一定會漏（或多刪），
 *    而漏刪的後果是正式版帶著會繞過防護的測試指令。現在由 --check 證明正式版裡一行都沒有。
 * ⚠️ **extension/ 本身不可以直接載入**（2026-09-17）。原始碼資料夾同時含有兩個版本的程式碼，
 *    manifest 因此改名為 manifest.base.json——Chrome 找不到 manifest.json 就載不進去。
 *    原因：使用者一直從 extension/ 載入當成正式版，實際跑的是「帶測試工具與語音辨識介面的版本」。
 *    **不要把 manifest.base.json 改回 manifest.json**，--check 會擋。
 * ⚠️ 兩個版本從 chrome://extensions 載入時是**兩個不同的擴充功能**（路徑不同 → ID 不同），
 *    設定與授權不互通。同時開著會兩個都疊字，測試時只啟用其中一個。
 *
 * 用法：
 *   node tools/build-extension.js          產生 dist/ 下的三個版本
 *   node tools/build-extension.js --check  在暫存資料夾建置並驗證（check-all 會跑）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'extension');
const check = process.argv.includes('--check');

const MARKS = {
  'test-only': {
    js: /\/\* @test-only:start \*\/[\s\S]*?\/\* @test-only:end \*\//g,
    html: /<!-- @test-only:start -->[\s\S]*?<!-- @test-only:end -->/g,
  },
  'admin-only': {
    js: /\/\* @admin-only:start \*\/[\s\S]*?\/\* @admin-only:end \*\//g,
    html: /<!-- @admin-only:start -->[\s\S]*?<!-- @admin-only:end -->/g,
  },
};

/** 每個版本要拿掉哪些標記、不複製哪些資料夾。 */
const KINDS = {
  release: { strip: ['test-only', 'admin-only'], skipDirs: ['src/test/', 'src/admin/'] },
  test: { strip: ['admin-only'], skipDirs: ['src/admin/'] },
  admin: { strip: ['test-only'], skipDirs: ['src/test/'] },
};

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

function stripMarks(text, file, tags) {
  for (const tag of tags) {
    if (/\.html$/.test(file)) text = text.replace(MARKS[tag].html, '');
    else if (/\.(js|css)$/.test(file)) text = text.replace(MARKS[tag].js, '');
  }
  return text;
}

function build(kind, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  const base = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.base.json'), 'utf8'));
  const overlay = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.test.json'), 'utf8'));
  const adminOverlay = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.admin.json'), 'utf8'));
  const K = KINDS[kind];

  for (const rel of listFiles(SRC)) {
    if (/^manifest\.[a-z]+\.json$/.test(rel)) continue;
    if (/(^|\/)README\.md$/.test(rel)) continue;
    if (K.skipDirs.some((d) => rel.startsWith(d))) continue;
    const from = path.join(SRC, rel);
    const to = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (/\.(js|html|css)$/.test(rel)) {
      const text = fs.readFileSync(from, 'utf8');
      fs.writeFileSync(to, stripMarks(text, rel, K.strip));
    } else {
      fs.copyFileSync(from, to);
    }
  }

  const m = JSON.parse(JSON.stringify(base));
  if (kind === 'test') {
    m.name = overlay.name;
    m.short_name = overlay.short_name;
    m.version_name = m.version + overlay.version_name_suffix;
    m.permissions = [...new Set([...(m.permissions || []), ...overlay.add_permissions])];
    // 語音辨識打測試後端（f1zh-api-test），只有測試版有這個主機權限
    m.host_permissions = [...new Set([...(m.host_permissions || []), ...(overlay.add_host_permissions || [])])];
    const add = overlay.add_content_scripts_js;
    const cs = (m.content_scripts || []).find((c) => (c.js || []).includes(add.after));
    if (!cs) throw new Error('測試版 manifest：找不到含 ' + add.after + ' 的 content script');
    const i = cs.js.indexOf(add.after);
    cs.js.splice(i + 1, 0, ...add.files);
    if (m.action) m.action.default_title = overlay.name;
  }
  if (kind === 'admin') {
    m.name = adminOverlay.name;
    m.short_name = adminOverlay.short_name;
    m.version_name = m.version + adminOverlay.version_name_suffix;
    // 收割佇列（src/admin/harvest.js）接在 main.js 後面，靠 main.js 的 window.__plAdmin 取得進度
    const add = adminOverlay.add_content_scripts_js;
    const cs = (m.content_scripts || []).find((c) => (c.js || []).includes(add.after));
    if (!cs) throw new Error('管理版 manifest：找不到含 ' + add.after + ' 的 content script');
    cs.js.splice(cs.js.indexOf(add.after) + 1, 0, ...add.files);
    // 不在 F1TV 頁面上跑的管理版腳本（F1TV 自動重新登入填表單，A24）
    m.content_scripts.push(...(adminOverlay.extra_content_scripts || []));
    if (m.action) m.action.default_title = adminOverlay.name;
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  return m;
}

function referencedFiles(m) {
  const out = [];
  if (m.background && m.background.service_worker) out.push(m.background.service_worker);
  for (const c of m.content_scripts || []) out.push(...(c.js || []), ...(c.css || []));
  if (m.options_ui) out.push(m.options_ui.page);
  if (m.action && m.action.default_popup) out.push(m.action.default_popup);
  for (const v of Object.values(m.icons || {})) out.push(v);
  return [...new Set(out)];
}

if (!check) {
  const dist = path.join(root, 'dist');
  const r = build('release', path.join(dist, 'pitlingo-release'));
  const t = build('test', path.join(dist, 'pitlingo-test'));
  const a = build('admin', path.join(dist, 'pitlingo-admin'));
  console.log(`✅ dist/pitlingo-release  v${r.version}（正式版）`);
  console.log(`✅ dist/pitlingo-test     v${t.version_name}（測試版：${t.permissions.join('、')}）`);
  console.log(`✅ dist/pitlingo-admin    v${a.version_name}（管理版：收割用）`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------
let failed = 0;
const ok = (msg) => console.log('✅ ' + msg);
const bad = (msg) => { failed++; console.log('❌ ' + msg); };

// 0. 原始碼裡的標記要成對，否則正則會吃掉一大段或留下半截
for (const rel of listFiles(SRC).filter((f) => /\.(js|html|css)$/.test(f))) {
  const t = fs.readFileSync(path.join(SRC, rel), 'utf8');
  for (const tag of Object.keys(MARKS)) {
    const s1 = t.split(`@${tag}:start`).length - 1;
    const e1 = t.split(`@${tag}:end`).length - 1;
    if (s1 !== e1) bad(`${rel}：@${tag} 標記不成對（start ${s1}／end ${e1}）`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-build-'));
const relDir = path.join(tmp, 'release');
const testDir = path.join(tmp, 'test');
const rm = build('release', relDir);
const tm = build('test', testDir);
const adminDir = path.join(tmp, 'admin');
const am = build('admin', adminDir);
const base = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.base.json'), 'utf8'));

// 0b. 原始碼資料夾不可以被直接載入（它同時含有測試版的程式碼）
fs.existsSync(path.join(SRC, 'manifest.json'))
  ? bad('extension/manifest.json 存在——extension/ 又可以直接載入了，而它含有測試版的程式碼。manifest 一律叫 manifest.base.json，載入請用 dist/pitlingo-release')
  : ok('extension/ 無法直接載入（沒有 manifest.json），只能載入建置出來的 dist/pitlingo-release 或 dist/pitlingo-test');

// 1. 正式版不可以有任何測試程式碼
{
  const leaks = [];
  const FORBID = [
    [/@test-only/, '測試標記'], [/\bTESTING\b/, 'TESTING 區塊'], [/__plTest|plTestHook/, '測試掛鉤'],
    [/\bt: TESTING\b|__pitlingo\.help\(\)/, '__pitlingo.t／help'], [/tabCapture|chrome\.offscreen/, '擷取分頁聲音'],
    [/\/v1\/asr\/|\basr[A-Z]\w*|asrTest/, '語音辨識'],
  ];
  for (const rel of listFiles(relDir)) {
    if (!/\.(js|html|css|json)$/.test(rel)) continue;
    const t = fs.readFileSync(path.join(relDir, rel), 'utf8');
    for (const [re, label] of FORBID) if (re.test(t)) leaks.push(`${rel}（${label}）`);
  }
  leaks.length ? bad('正式版含有測試程式碼：' + leaks.join('、')) : ok('正式版沒有任何測試程式碼（__pitlingo.t、語音辨識、測試掛鉤、測試標記）');
  fs.existsSync(path.join(relDir, 'src/test')) ? bad('正式版含有 src/test/') : ok('正式版沒有 src/test/');
  JSON.stringify(rm.host_permissions) === JSON.stringify(base.host_permissions) && !/f1zh-api-test/.test(JSON.stringify(rm))
    ? ok('正式版的主機權限與原始 manifest 相同（沒有測試後端）')
    : bad('正式版的主機權限被改動或含有測試後端：' + JSON.stringify(rm.host_permissions));
  JSON.stringify(rm.permissions) === JSON.stringify(base.permissions)
    ? ok(`正式版權限與原始 manifest 相同（${rm.permissions.join('、')}）`)
    : bad('正式版權限被改動：' + rm.permissions.join('、'));
  rm.name === base.name ? ok('正式版名稱正確') : bad('正式版名稱被改成 ' + rm.name);
}

// 2. 測試版要有測試功能
{
  (tm.host_permissions || []).includes('https://f1zh-api-test.pitlingo.workers.dev/*')
    ? ok('測試版有測試後端的主機權限（語音辨識打 f1zh-api-test）') : bad('測試版沒有測試後端的主機權限——語音辨識的請求會被 CORS 擋下');
  ['tabCapture', 'offscreen'].every((p) => tm.permissions.includes(p))
    ? ok('測試版有 tabCapture、offscreen 權限') : bad('測試版缺少擷取權限');
  /測試版/.test(tm.name) ? ok('測試版名稱標示「測試版」（不會跟正式版搞混）') : bad('測試版名稱沒有標示');
  const main = fs.readFileSync(path.join(testDir, 'src/content/main.js'), 'utf8');
  /t: TESTING/.test(main) && /window\.__plTest/.test(main) ? ok('測試版保留 __pitlingo.t 與測試掛鉤') : bad('測試版缺少測試工具');
  const cs = tm.content_scripts.find((c) => c.js.includes('src/content/main.js'));
  cs && cs.js.indexOf('src/test/asr-content.js') === cs.js.indexOf('src/content/main.js') + 1
    ? ok('測試版的語音辨識 content script 排在 main.js 之後（掛鉤先建立）')
    : bad('測試版的語音辨識 content script 順序不對');
}

// 2b. 管理版：收割的東西只在管理版（正式版、測試版都不可以有）；管理版不帶測試工具
{
  const ADMIN = [[/@admin-only/, '管理版標記'], [/x-harvest-token|harvestToken/, '收割權杖'], [/src\/admin\//, 'src/admin'], [/__plAdmin|harvestStamp|harvestOn\b/, '收割掛鉤'], [/leaderLoad|leaderBeat|plLeader/, '前導收割模式'], [/harvestTimes|cueVideoSec/, '翻譯清單時間軸']];
  for (const [label, dir] of [['正式版', relDir], ['測試版', testDir]]) {
    const leaks = [];
    for (const rel of listFiles(dir)) {
      if (!/\.(js|html|css|json)$/.test(rel)) continue;
      const t = fs.readFileSync(path.join(dir, rel), 'utf8');
      for (const [re, l] of ADMIN) if (re.test(t)) leaks.push(`${rel}（${l}）`);
    }
    if (fs.existsSync(path.join(dir, 'src/admin'))) leaks.push('src/admin/');
    leaks.length ? bad(`${label}含有管理版的東西：${leaks.join('、')}`) : ok(`${label}沒有任何管理版的東西（收割權杖、src/admin）`);
  }
  const sw = fs.readFileSync(path.join(adminDir, 'src/background/sw.js'), 'utf8');
  /x-harvest-token/.test(sw) ? ok('管理版會送收割權杖') : bad('管理版沒有收割權杖的程式碼');
  // 收割佇列（第 3 階段）：harvest.js 要接在 main.js 後面，main.js 要有它讀的掛鉤，設定頁要有權杖欄位
  const acs = am.content_scripts.find((c) => c.js.includes('src/content/main.js'));
  acs && acs.js.indexOf('src/admin/harvest.js') === acs.js.indexOf('src/content/main.js') + 1
    ? ok('管理版在 main.js 之後注入收割佇列（src/admin/harvest.js）') : bad('管理版沒有（或順序錯誤地）注入 src/admin/harvest.js');
  const amain = fs.readFileSync(path.join(adminDir, 'src/content/main.js'), 'utf8');
  /window\.__plAdmin\s*=/.test(amain) && /harvestStampWhenSettled\(/.test(amain)
    ? ok('管理版 main.js 有收割掛鉤與可信的完整標記') : bad('管理版 main.js 缺收割掛鉤（__plAdmin／harvestStampWhenSettled）');
  // 前導收割模式（2026-10-24 從測試版移進管理版）：預設開、不延遲畫面、心跳帶收割權杖、leader() 不帶參數不改設定
  /noLiveDelay = true;/.test(amain) && /leaderMode = harvestOn && o\.on !== false/.test(amain) && /if \(on !== undefined\)/.test(amain)
    && /case 'leaderBeat'/.test(sw) && /HARVEST_PATHS = \[[^\]]*'\/v1\/leader\/beat'/.test(sw)
    ? ok('管理版有前導收割模式（預設開、不延遲畫面、心跳帶收割權杖、leader() 不帶參數只回狀態）')
    : bad('管理版的前導收割模式不完整（noLiveDelay／預設開／leader() 查詢／leaderBeat／HARVEST_PATHS 的心跳）');
  const aopt = fs.readFileSync(path.join(adminDir, 'src/options/options.html'), 'utf8');
  /id="harvestToken"/.test(aopt) && /admin\/options-admin\.js/.test(aopt)
    ? ok('管理版設定頁有收割權杖欄位') : bad('管理版設定頁沒有收割權杖欄位');
  // 管理版只做管理版的事（2026-10-24）：登入、配對、授權、購買、新手導覽都藏起來；身分只有收割權杖，沒權杖不翻譯
  const aoptJs = fs.readFileSync(path.join(adminDir, 'src/admin/options-admin.js'), 'utf8');
  const aCss = fs.readFileSync(path.join(adminDir, 'src/options/options.css'), 'utf8');
  const customer = ['acctBar', 'linkBox', 'onboard', 'licSection'];
  /id="adminIdentity"/.test(aopt) && /classList\.add\('adminBuild'\)/.test(aoptJs) && /body\.adminBuild \.customerOnly\s*\{\s*display:\s*none !important/.test(aCss)
    && customer.every((id) => new RegExp(`id="${id}"[^>]*class="[^"]*customerOnly`).test(aopt))
    ? ok('管理版設定頁：只有「管理版」狀態卡，登入／配對／授權／購買／新手導覽都不出現') : bad('管理版設定頁還看得到客戶用的區塊（customerOnly／adminBuild）');
  /throw new Error\('管理版尚未設定收割權杖/.test(sw)
    ? ok('管理版沒有收割權杖就不翻譯、不送心跳（不退回用個人授權）') : bad('管理版沒有收割權杖時會退回用個人授權翻譯');
  /id="adminIdentity"/.test(fs.readFileSync(path.join(relDir, 'src/options/options.html'), 'utf8'))
    ? bad('正式版設定頁出現「管理版」狀態卡') : ok('正式版設定頁沒有「管理版」狀態卡');
  const leaks = [];
  for (const rel of listFiles(adminDir)) {
    if (!/\.(js|html|css|json)$/.test(rel)) continue;
    const t = fs.readFileSync(path.join(adminDir, rel), 'utf8');
    if (/@test-only|\bt: TESTING\b|tabCapture|chrome\.offscreen/.test(t)) leaks.push(rel);
  }
  if (fs.existsSync(path.join(adminDir, 'src/test'))) leaks.push('src/test/');
  leaks.length ? bad('管理版帶了測試工具：' + leaks.join('、')) : ok('管理版不帶測試工具');
  /管理版/.test(am.name) ? ok('管理版名稱標示「管理版」') : bad('管理版名稱沒有標示');
  JSON.stringify(am.permissions) === JSON.stringify(base.permissions)
    && JSON.stringify(am.host_permissions) === JSON.stringify(base.host_permissions)
    ? ok('管理版權限與正式版相同（不多要任何權限）') : bad('管理版權限與正式版不同');
}

// 3. 三個版本：manifest 參照的檔案都存在、每支 JS 都編譯得過
for (const [label, dir, m] of [['正式版', relDir, rm], ['測試版', testDir, tm], ['管理版', adminDir, am]]) {
  const missing = referencedFiles(m).filter((f) => !fs.existsSync(path.join(dir, f)));
  missing.length ? bad(`${label} manifest 參照的檔案不存在：${missing.join('、')}`) : ok(`${label} manifest 參照的檔案都在`);
  const htmlRefs = [];
  for (const rel of listFiles(dir).filter((f) => f.endsWith('.html'))) {
    const t = fs.readFileSync(path.join(dir, rel), 'utf8');
    for (const mm of t.matchAll(/<script src="([^"]+)"/g)) {
      const p = path.join(path.dirname(path.join(dir, rel)), mm[1]);
      if (!fs.existsSync(p)) htmlRefs.push(`${rel} → ${mm[1]}`);
    }
  }
  htmlRefs.length ? bad(`${label} 的 HTML 引用了不存在的腳本：${htmlRefs.join('、')}`) : ok(`${label} HTML 引用的腳本都在`);
  const syntax = [];
  for (const rel of listFiles(dir).filter((f) => f.endsWith('.js'))) {
    try { execFileSync(process.execPath, ['--check', path.join(dir, rel)], { stdio: 'pipe' }); }
    catch (e) { syntax.push(rel + '：' + String(e.stderr || e.message).split('\n').find((l) => /Error/.test(l))); }
  }
  syntax.length ? bad(`${label} 有 JS 語法錯誤：${syntax.join('；')}`) : ok(`${label} 所有 JS 語法正確`);
}

// 4. 正式版：拿掉測試區塊後，行為測試與「引用不存在的名稱」檢查照樣要過
for (const [label, script, env] of [
  ['正式版的使用者行為（check-extension-behavior）', 'tools/check-extension-behavior.js', { PL_EXT_ROOT: relDir }],
  ['正式版沒有引用不存在的名稱（check-undeclared）', 'tools/check-undeclared.js', { PL_EXT_ROOT: relDir }],
  ['管理版的使用者行為（check-extension-behavior）', 'tools/check-extension-behavior.js', { PL_EXT_ROOT: adminDir }],
  ['管理版沒有引用不存在的名稱（check-undeclared）', 'tools/check-undeclared.js', { PL_EXT_ROOT: adminDir }],
]) {
  try {
    execFileSync(process.execPath, [path.join(root, script)], { cwd: root, stdio: 'pipe', env: Object.assign({}, process.env, env) });
    ok(label);
  } catch (e) {
    bad(label + ' 失敗：\n' + String(e.stdout || '').split('\n').filter((l) => /❌|⚠/.test(l)).slice(0, 8).join('\n'));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failed) { console.log(`❌ 擴充功能建置有 ${failed} 項未通過`); process.exit(1); }
console.log('✅ 正式版、測試版、管理版都建置正確');
