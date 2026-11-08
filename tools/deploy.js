#!/usr/bin/env node
/**
 * 一鍵部署：檢查 → 部署 → **確認線上真的換版了**
 *
 * 為什麼要有這支（2026-09-25）：
 *   9/24 那天後端的 KV 修正做完、測試全綠、也提交了——**但沒有部署**，
 *   於是額度繼續被燒了一整天，而當下沒有任何跡象顯示「你改的東西還沒生效」。
 *   「記得部署」和「記得按按鈕」是同一類問題：**不能靠記性**。
 *
 *   第二件事同樣重要：部署完之後**要能證明它真的上去了**。
 *   在 `/v1/health` 有版本號之前，只能靠副作用去猜（連讀三次看計數有沒有漲）。
 *
 * 用法：
 *   node tools/deploy.js backend     後端 Worker
 *   node tools/deploy.js site        網站與後台（legal/）
 *   node tools/deploy.js all         兩個都做
 *   node tools/deploy.js backend --skip-checks   （不建議，只在檢查工具本身壞掉時）
 *
 * 分階段推送（handoff 9.1 #20，2026-10-06）——**上線有真的使用者之後一律用這個**：
 *   node tools/deploy.js backend --gradual 10    新版只接 10% 流量，舊版 90%
 *   node tools/deploy.js backend --promote       確認沒問題 → 新版 100%
 *   node tools/deploy.js backend --rollback      有問題 → 舊版 100%（秒級，不用重新建置）
 *   觀察期間看後台「即時」與「問題回報」：新版的錯誤會以版本號區分（診斷報告帶後端版本）。
 *   ⚠️ 分流是**每個請求各自抽籤**，同一個使用者可能一下打到新版、一下打到舊版——
 *      新舊兩版必須能讀寫彼此的資料（KV 格式、通行證格式、AuthGuard op）。改資料格式的那一版不要分流。
 *
 * ⚠️ 帶 Durable Object migration 的那一次要自己跑 `wrangler deploy`——
 *    Cloudflare 會用 code 10211 拒絕漸進式部署（見 CLAUDE.md 環境那一節）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('-')) || 'backend';
const skipChecks = args.includes('--skip-checks');

const API = 'https://f1zh-api.pitlingo.workers.dev';
const SITE = 'https://pitlingo.com';

function run(cmd, cmdArgs, cwd) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}${cwd ? `   (${cwd})` : ''}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: cwd || root, stdio: 'inherit', shell: true });
  return r.status === 0;
}

function die(msg) {
  console.log(`\n❌ ${msg}`);
  process.exit(1);
}

/** 讀原始碼裡的版本，等一下拿來跟線上比對。 */
function sourceVersion() {
  const src = readBackend();
  const m = src.match(/^const BACKEND_VERSION\s*=\s*['"]([^'"]+)['"]/m);
  if (!m) die('backend/src/parts/*.js 裡找不到 BACKEND_VERSION');
  return m[1];
}

/** 部署是非同步的，要輪詢到版本真的換過去為止。 */
async function waitForVersion(want, seconds) {
  const until = Date.now() + seconds * 1000;
  let last = '(讀不到)';
  while (Date.now() < until) {
    try {
      const r = await fetch(`${API}/v1/health`, { cache: 'no-store' });
      const d = await r.json();
      last = d.version || '(這一版還沒有版本號)';
      if (d.version === want) return { ok: true, saw: last };
    } catch (e) { last = '(連不上：' + (e.message || e) + ')'; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, saw: last };
}

async function deployBackend() {
  const want = sourceVersion();
  console.log(`\n▶ 後端 v${want}`);

  if (!skipChecks && !run('node', ['tools/check-all.js'])) die('部署前檢查沒過（見上面的訊息）');
  if (!run('wrangler', ['deploy'], path.join(root, 'backend'))) die('wrangler deploy 失敗');

  console.log('\n⏳ 等線上換版（最多 90 秒）…');
  const r = await waitForVersion(want, 90);
  if (!r.ok) {
    die(`線上版本還是 ${r.saw}，不是 v${want}。\n`
      + '   可能是部署到別的環境、或 Cloudflare 還在推。先跑：\n'
      + `   curl ${API}/v1/health`);
  }
  console.log(`\n✅ 後端 v${want} 已上線並驗證過（/v1/health 回報 ${r.saw}）`);
}

// ---- 分階段推送 ----------------------------------------------------------
const GRADUAL_STATE = path.join(root, 'backend', '.wrangler', 'gradual.json');

function wcap(args) {
  console.log(`
$ wrangler ${args.join(' ')}`);
  const r = spawnSync('wrangler', args, { cwd: path.join(root, 'backend'), encoding: 'utf8', shell: true });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

function currentVersions() {
  const r = wcap(['deployments', 'status', '--json']);
  if (!r.ok) die('讀不到目前的部署狀態');
  const j = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
  return j.versions || [];
}

/** 抽樣打 /v1/health，看到目標版本至少一次就算上線（10% 時平均 10 次看到一次）。 */
async function sawVersion(want, seconds) {
  const until = Date.now() + seconds * 1000;
  const seen = {};
  while (Date.now() < until) {
    try {
      const d = await (await fetch(`${API}/v1/health`, { cache: 'no-store' })).json();
      seen[d.version] = (seen[d.version] || 0) + 1;
      if (d.version === want) return { ok: true, seen };
    } catch (e) { /* 下一輪再試 */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, seen };
}

async function gradual(pct) {
  const want = sourceVersion();
  if (!(pct >= 1 && pct <= 99)) die('--gradual 要給 1～99 的百分比');
  if (fs.existsSync(GRADUAL_STATE)) die('上一次的分流還沒結束——先 --promote 或 --rollback');
  const cur = currentVersions();
  if (cur.length !== 1 || cur[0].percentage !== 100) die('目前不是單一版本 100%（已經在分流？）——先 --promote 或 --rollback');
  const old = cur[0].version_id;
  if (!skipChecks && !run('node', ['tools/check-all.js'])) die('部署前檢查沒過（見上面的訊息）');
  // 自己先建置一次：不依賴 versions upload 會不會跑 wrangler.toml 的 [build]（上傳的是 dist/release）
  if (!run('node', ['tools/build-backend.js'])) die('建置失敗');
  const up = wcap(['versions', 'upload', '--tag', 'v' + want, '--message', `"v${want}"`]);
  if (!up.ok) {
    die(/10211/.test(up.out)
      ? '這一版帶 Durable Object migration，Cloudflare 不准分流（code 10211）——用 node tools/deploy.js backend 整個換'
      : 'wrangler versions upload 失敗');
  }
  const m = up.out.match(/Version ID:\s*([0-9a-f-]{36})/i);
  if (!m) die('上傳成功但讀不到新版本的 ID（wrangler 的輸出格式改了？）');
  const neu = m[1];
  fs.mkdirSync(path.dirname(GRADUAL_STATE), { recursive: true });
  fs.writeFileSync(GRADUAL_STATE, JSON.stringify({ neu, old, ver: want, pct, at: new Date().toISOString() }, null, 2));
  if (!wcap(['versions', 'deploy', `${neu}@${pct}%`, `${old}@${100 - pct}%`, '-y', '--message', `"v${want} ${pct}%"`]).ok) {
    fs.unlinkSync(GRADUAL_STATE);
    die('wrangler versions deploy 失敗（線上仍是舊版 100%）');
  }
  console.log(`
⏳ 抽樣 /v1/health，等看到 v${want}（${pct}% 的流量）…`);
  const r = await sawVersion(want, 120);
  console.log(r.ok ? `
✅ v${want} 已接 ${pct}% 流量（抽樣看到：${JSON.stringify(r.seen)}）`
    : `
⚠️ 兩分鐘內沒有抽到 v${want}（${JSON.stringify(r.seen)}）——流量太小時正常，自己再 curl 幾次`);
  console.log('   觀察後台「即時」與「問題回報」。沒問題：--promote；有問題：--rollback');
}

async function finishGradual(promote) {
  if (!fs.existsSync(GRADUAL_STATE)) die('沒有進行中的分流（backend/.wrangler/gradual.json 不存在）');
  const s = JSON.parse(fs.readFileSync(GRADUAL_STATE, 'utf8'));
  const id = promote ? s.neu : s.old;
  if (!wcap(['versions', 'deploy', `${id}@100%`, '-y', '--message', promote ? `"v${s.ver} 100%"` : '"rollback"']).ok) die('wrangler versions deploy 失敗');
  fs.unlinkSync(GRADUAL_STATE);
  if (promote) {
    const r = await waitForVersion(s.ver, 90);
    console.log(r.ok ? `
✅ v${s.ver} 已接 100% 流量` : `
⚠️ 已送出，但線上還看到 ${r.saw}——再 curl 一次`);
  } else {
    console.log(`
↩️ 已退回舊版 100%（${s.old}）。v${s.ver} 的程式碼還在原始碼裡，修好再分流一次`);
  }
}

async function deploySite() {
  console.log('\n▶ 網站與後台');
  // ⚠️ 資產的 ?v= 一發布就凍結一年，**一定要先重算**，否則使用者會拿到舊檔到明年。
  if (!run('node', ['tools/bump-assets.js'])) die('bump-assets 失敗');
  if (!skipChecks && !run('node', ['tools/check-all.js'])) die('部署前檢查沒過');
  if (!run('wrangler', ['pages', 'deploy', 'legal', '--project-name', 'pitlingo', '--branch', 'main'])) {
    die('wrangler pages deploy 失敗');
  }
  try {
    const r = await fetch(SITE, { cache: 'no-store' });
    console.log(r.ok ? `\n✅ 網站已部署（${SITE} 回 ${r.status}）`
      : `\n⚠️ 網站部署完成，但 ${SITE} 回 ${r.status}——自己開一次確認`);
  } catch (e) {
    console.log(`\n⚠️ 網站部署完成，但連不上 ${SITE}：${e.message}`);
  }
}

(async () => {
  if (skipChecks) console.log('⚠️ 已略過檢查（--skip-checks）。只有在檢查工具本身壞掉時才該這樣做。');

  if (!['backend', 'api', 'site', 'all'].includes(target)) {
    die(`不認得的目標「${target}」。可用：backend / site / all`);
  }
  const gi = args.indexOf('--gradual');
  if (gi >= 0) { await gradual(Number(args[gi + 1])); return; }
  if (args.includes('--promote')) { await finishGradual(true); return; }
  if (args.includes('--rollback')) { await finishGradual(false); return; }
  if (target === 'backend' || target === 'api' || target === 'all') await deployBackend();
  if (target === 'site' || target === 'all') await deploySite();
  console.log('');
})().catch((e) => die(String((e && e.stack) || e)));
