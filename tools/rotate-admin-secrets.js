#!/usr/bin/env node
/**
 * 輪換後台的鑰匙（2026-09-17）。**請你自己在終端機執行，不要叫 Claude 跑**——
 * 它跑的話，新的權杖會出現在對話紀錄裡，就跟舊的那一組一樣外洩了（SECURITY.md S7）。
 *
 * 會做三件事（可以用 --only 挑）：
 *   admin    產生新的 ADMIN_TOKEN            → 後台登入畫面用
 *   harvest  產生新的 HARVEST_TOKEN          → 管理版擴充功能收割用（只能收割，不需要動態碼）
 *   totp     產生新的 ADMIN_TOTP_SECRET      → 手機驗證器 App（Google Authenticator／1Password…）
 *
 * 做法：
 *   1. 在本機產生隨機值（crypto.randomBytes）
 *   2. 用標準輸入交給 `wrangler secret put`——值不會出現在指令列、也不會進 shell 歷史
 *   3. 寫進你家目錄的一個文字檔（**不在 repo 裡**），畫面上只印檔案路徑
 *
 * 執行之後：
 *   · 後台會把你登出（舊權杖失效），用新的 ADMIN_TOKEN＋手機上的 6 位數登入
 *   · 管理版擴充功能（dist/pitlingo-admin）：設定頁 → 管理版 → 收割權杖，貼上 HARVEST_TOKEN（每一台收割用的設定檔都要換）
 *   · 那個文字檔抄進密碼管理工具後**刪掉**
 *
 * 用法：
 *   node tools/rotate-admin-secrets.js                  三個都換
 *   node tools/rotate-admin-secrets.js --only=totp      只設定動態碼
 *   node tools/rotate-admin-secrets.js --dry-run        只產生、寫檔，不動後端（先看看長什麼樣）
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const onlyArg = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const ONLY = onlyArg ? new Set(onlyArg.split(',').map((x) => x.trim())) : new Set(['admin', 'harvest', 'totp']);
for (const k of ONLY) if (!['admin', 'harvest', 'totp'].includes(k)) { console.error('--only 只能是 admin、harvest、totp'); process.exit(1); }

// 在 Claude Code 的工具裡執行時，輸出會進對話紀錄——擋下來
if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) {
  console.error('❌ 偵測到是在 Claude Code 裡執行。這支會產生新的後台鑰匙，請在你自己的終端機執行。');
  process.exit(1);
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function base32(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}
function totpNow(secretB32) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const key = [];
  for (const ch of secretB32) { value = (value << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { key.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(key)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  return String((((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1000000).padStart(6, '0');
}

function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['wrangler', 'secret', 'put', name], { cwd: path.join(root, 'backend'), shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`wrangler secret put ${name} 失敗（${code}）：${out.slice(-300)}`))));
    p.stdin.write(value + '\n');
    p.stdin.end();
  });
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

(async () => {
  const gen = {};
  if (ONLY.has('admin')) gen.ADMIN_TOKEN = b64url(crypto.randomBytes(32));
  if (ONLY.has('harvest')) gen.HARVEST_TOKEN = b64url(crypto.randomBytes(32));
  if (ONLY.has('totp')) gen.ADMIN_TOTP_SECRET = base32(crypto.randomBytes(20));

  console.log('將要' + (dry ? '產生（不動後端）' : '設定到 Cloudflare') + '：' + Object.keys(gen).join('、'));
  if (!dry) {
    if (gen.ADMIN_TOKEN) console.log('  · 換 ADMIN_TOKEN 後，目前開著的後台會被登出');
    if (gen.ADMIN_TOTP_SECRET) console.log('  · 設了動態碼之後，登入後台要輸入手機上的 6 位數——請先確定手機在旁邊');
    if (gen.ADMIN_TOKEN && !gen.HARVEST_TOKEN) console.log('  · 管理版擴充功能的收割權杖若還是舊的，收割會失敗，請一起換成新的 HARVEST_TOKEN');
    const a = await ask('確定要繼續嗎？輸入 yes：');
    if (a.trim().toLowerCase() !== 'yes') { console.log('已取消，什麼都沒改'); return; }
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const file = path.join(os.homedir(), `pitlingo-admin-secrets-${stamp}.txt`);
  const lines = [
    `PitLingo 後台鑰匙（${new Date().toLocaleString('zh-TW', { hour12: false })} 產生${dry ? '，dry-run：尚未設定到後端' : ''}）`,
    '抄進密碼管理工具後，請刪除這個檔案。',
    '',
  ];
  if (gen.ADMIN_TOKEN) lines.push('ADMIN_TOKEN（後台登入畫面）', gen.ADMIN_TOKEN, '');
  if (gen.HARVEST_TOKEN) lines.push('HARVEST_TOKEN（管理版擴充功能 → 設定頁 → 管理版 → 收割權杖）', gen.HARVEST_TOKEN, '');
  if (gen.ADMIN_TOTP_SECRET) {
    lines.push('ADMIN_TOTP_SECRET（驗證器 App → 新增 → 手動輸入金鑰；類型：以時間為準、6 位數、30 秒）', gen.ADMIN_TOTP_SECRET, '',
      '或把這一行做成 QR code 掃描：',
      `otpauth://totp/PitLingo:admin?secret=${gen.ADMIN_TOTP_SECRET}&issuer=PitLingo&digits=6&period=30`, '');
  }
  fs.writeFileSync(file, lines.join(os.EOL), { encoding: 'utf8', mode: 0o600 });
  console.log('✅ 已寫入：' + file);

  if (!dry) {
    // 先寫檔再推：推到一半失敗時，已經生效的那幾個值你手上一定有
    for (const [k, v] of Object.entries(gen)) {
      process.stdout.write(`設定 ${k}… `);
      await putSecret(k, v);
      console.log('✅');
    }
  }
  if (gen.ADMIN_TOTP_SECRET) {
    console.log('\n把金鑰加進驗證器 App 之後，App 上現在應該顯示：' + totpNow(gen.ADMIN_TOTP_SECRET) + '（30 秒內會換）');
    console.log('對不上的話：手機時間要設成自動；或重新手動輸入金鑰。');
  }
  console.log(dry ? '\n（dry-run：後端沒有任何改變）' : '\n完成。記得刪掉上面那個文字檔。');
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
