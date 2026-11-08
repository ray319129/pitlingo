#!/usr/bin/env node
/**
 * wrangler.toml 的健全性檢查。
 *
 * ⚠️ **為什麼需要：一個重複的鍵會讓每一次部署都失敗，而失敗訊息很容易被誤讀。**
 *    實際踩過（2026-09-15）：`GOOGLE_CLIENT_ID` 在 `[vars]` 裡出現兩次，
 *    wrangler 回 `Invalid TOML document: trying to redefine an already defined
 *    table or value`，而它把出錯的那一行原樣印出來——
 *    看起來就像「正在套用這個設定」。我因此**連續兩次把失敗當成成功**，
 *    還對著一個根本沒部署上去的版本做驗證。
 *
 *    後果特別壞的地方在於：舊版本還在線上跑，所有 API 都正常回應，
 *    只有你剛改的那件事沒有生效——**沒有任何地方會告訴你**。
 *
 * 用法：node tools/check-wrangler.js
 */
const fs = require('fs');
const path = require('path');
const { readBackend } = require('./lib/backend-src');
const root = path.join(__dirname, '..');
const FILE = path.join(root, 'backend/wrangler.toml');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const fail = (m, d) => { errors.push(m + (d ? '：' + d : '')); console.log('❌ ' + m + (d ? '：' + d : '')); };

const raw = fs.readFileSync(FILE, 'utf8');
const lines = raw.split(/\r?\n/);

// ---------------------------------------------------------------------------
// 1) 同一張表裡不可以有重複的鍵
//
// 這裡刻意**不寫完整的 TOML 剖析器**——只要追「目前在哪張表」與
// 「這張表看過哪些鍵」就夠了，而且看得懂、不會自己長出 bug。
// `[[...]]` 是陣列表，每次出現都是新的一筆，所以要各自重來。
// ---------------------------------------------------------------------------
{
  let table = '(root)';
  let seen = new Map();
  const dups = [];
  const tables = new Set();
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = t.match(/^\[\[?([^\]]+)\]\]?$/);
    if (m) {
      table = t;
      // 陣列表（`[[x]]`）可以重複出現；一般表（`[x]`）不行。
      if (!t.startsWith('[[')) {
        if (tables.has(t)) dups.push(`第 ${i + 1} 行：表 ${t} 重複定義`);
        tables.add(t);
      }
      seen = new Map();
      return;
    }
    const kv = t.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (!kv) return;
    const key = kv[1];
    if (seen.has(key)) {
      dups.push(`第 ${i + 1} 行：${table} 裡的 ${key} 與第 ${seen.get(key)} 行重複`);
    } else {
      seen.set(key, i + 1);
    }
  });
  dups.length
    ? fail('wrangler.toml 有重複定義，wrangler 會拒絕部署', dups.join('；'))
    : ok('沒有重複的表或鍵（重複會讓每一次部署都失敗）');
}

// ---------------------------------------------------------------------------
// 2) 該有的東西要在
//
// ⚠️ 少了這些不會讓部署失敗，只會讓某個功能**靜靜地不作用**——
//    這個專案最常見的失敗形狀。
// ---------------------------------------------------------------------------
{
  const NEED = [
    ['main = ', '進入點'],
    ['[[kv_namespaces]]', 'KV 綁定（沒有它整個後端沒有儲存）'],
    ['binding = "SUBS"', 'KV 的 binding 名稱（程式碼裡寫死 env.SUBS）'],
    ['[[durable_objects.bindings]]', 'Durable Object（直播並發去重靠它）'],
    ['class_name = "SubtitleRoom"', 'DO 的類別名稱'],
    // 2026-10-02：沒有 AuthGuard 時 Email 驗證碼登入會整個停用（fail closed），帳號頁也全部變成未登入
    ['name = "AUTH"', 'AuthGuard 的 binding（Email 登入的計數、單次使用、撤銷）'],
    ['class_name = "AuthGuard"', 'AuthGuard 的類別名稱'],
    ['new_sqlite_classes = ["AuthGuard"]', 'AuthGuard 的 migration'],
    ['[triggers]', 'cron（賽程同步與每日彙報）'],
    ['workers_dev = true', 'workers.dev 路由（舊版擴充功能還指向那裡）'],
  ];
  const miss = NEED.filter(([k]) => !raw.includes(k)).map(([k, why]) => `${k}（${why}）`);
  miss.length ? fail('wrangler.toml 少了必要設定', miss.join('；'))
    : ok(`${NEED.length} 項必要設定都在`);
}

// ---------------------------------------------------------------------------
// 3) 機密不可以寫進 wrangler.toml
//
// ⚠️ 這個檔案**會進 git，而 repo 是公開的**。
//    機密一律走 `wrangler secret put`，只有「本來就會出現在前端」的東西
//    （例如 Google 的 client_id）才可以放 [vars]。
// ---------------------------------------------------------------------------
{
  const BANNED = [
    [/ANTHROPIC_API_KEY\s*=/, 'ANTHROPIC_API_KEY'],
    [/ADMIN_TOKEN\s*=/, 'ADMIN_TOKEN'],
    [/TOKEN_SECRET\s*=/, 'TOKEN_SECRET'],
    [/RESEND_API_KEY\s*=/, 'RESEND_API_KEY'],
    [/ZEPTOMAIL_TOKEN\s*=/, 'ZEPTOMAIL_TOKEN'],
    [/ECPAY_HASH_(KEY|IV)\s*=/, 'ECPAY_HASH_*'],
    [/ADMIN_TOTP_SECRET\s*=/, 'ADMIN_TOTP_SECRET'],
    [/client_secret/i, 'Google client_secret'],
    [/sk-ant-/, 'Anthropic 金鑰字串'],
  ];
  const active = lines.filter((l) => !l.trim().startsWith('#')).join('\n');
  const hits = BANNED.filter(([re]) => re.test(active)).map(([, n]) => n);
  hits.length
    ? fail('機密被寫進 wrangler.toml（這個檔案會進公開 repo）', hits.join('、') + ' —— 改用 wrangler secret put')
    : ok(`${BANNED.length} 種機密都沒有出現在未註解的設定裡`);
}

console.log('');
// ---------------------------------------------------------------------------
// 4) 速率限制 binding 的 limit 要等於後端的 RATE_LIMIT_PER_MIN（2026-10-26）
//    兩邊各寫一次：改了程式忘了改這裡，限制就靜靜地變成別的數字
// ---------------------------------------------------------------------------
{
  const src = readBackend();
  const want = Number((src.match(/const RATE_LIMIT_PER_MIN = (\d+)/) || [])[1]);
  const m = raw.match(/\[\[ratelimits\]\][\s\S]*?limit\s*=\s*(\d+)[\s\S]*?period\s*=\s*(\d+)/);
  if (!m) ok('沒有速率限制 binding（後端退回 KV 取樣）');
  else if (Number(m[1]) !== want) fail('速率限制 binding 的 limit 與 RATE_LIMIT_PER_MIN 不一致', `${m[1]} ≠ ${want}`);
  else if (m[2] !== '60') fail('速率限制 binding 的 period 要是 60（RATE_LIMIT_PER_MIN 是每分鐘）', m[2]);
  else ok(`速率限制 binding：每分鐘 ${want} 次，與後端一致`);
}

if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
console.log('✅ wrangler.toml 正確');
