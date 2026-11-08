// ---------------------------------------------------------------------------
// 代訂自營（RESELL-OPS.md，2026-10-12 起；第 1 階段：帳號庫存、成本、採購區、事件、全域查詢）
//
// 資料放 D1（綁定 RESELL_DB），不放 KV：
//   · 帳號、指派、席次、成本彼此關聯，KV 只能整包讀寫
//   · 第 2 階段「賣第 5 席要被擋」需要交易；KV 沒有 CAS（鐵則 16、52、60）
//   · D1 免費方案每天 10 萬次寫入，不吃 KV 那 1,000 次（鐵則 10）
//
// ⚠️ 沒有綁 RESELL_DB 時：讀取回 configured:false，寫入一律拒絕——**不退回存 KV**。
// ⚠️ 交付用的密碼副本以 AES-GCM 加密（金鑰 RESELL_KEY，32 bytes base64），AAD 綁 login_email：
//    就算有人在資料庫裡把兩列的密文對調，解密也會失敗，而不是把 A 帳號的密碼交給 B 的客戶。
//    沒設 RESELL_KEY 時**拒絕存密碼**，絕不退回存明文。
// ⚠️ pw_enc 只有 reveal 端點會讀。清單、查詢一律列舉欄位（RESELL_ACCOUNT_COLS），不准 SELECT *。
// ---------------------------------------------------------------------------
const RESELL_TIERS = ['pro', 'premium'];
const RESELL_BILLING = ['monthly', 'annual'];
const RESELL_STATUS = ['available', 'assigned', 'shared', 'recovering', 'disabled'];
const RESELL_REGION_STALE_DAYS = 30;       // 採購區價格多久沒核對就提醒
const RESELL_RENEW_SOON_DAYS = 7;          // 幾天內扣款／到期算「即將」
// 清單與查詢能看的欄位。**沒有 pw_enc。** check-resell 會驗每一個 SELECT 都不帶它。
const RESELL_ACCOUNT_COLS = 'id, login_email, region, tier, billing, status, renews_at, auto_renew, vault_ref,'
  + ' (pw_enc IS NOT NULL) AS has_pw, pw_set_at, card_ref, note, created_at, updated_at, source, agent_sku, share';

function resellDb(env) { return env && env.RESELL_DB ? env.RESELL_DB : null; }
const resellNoDb = () => err('代訂資料庫還沒建立（wrangler.toml 沒有綁 RESELL_DB）', 503);

// ---------------------------------------------------------------------------
// 帳本（2026-10-24，Ray：「真正上線後我想要有記帳，都要真實的收支」；schema 見 migrations/0004_ledger.sql）
//
// **只記真的進出的錢（現金制）。** 後台「成本」分頁的數字是後端自己估的下限，不是帳——這裡一個都不用。
//   收入／退款／金流手續費 ← 訂單（快照進 ledger_orders：KV 的訂單 400 天後會過期，帳要留更久）
//   代訂採購               ← f1_costs（代訂分頁記的帳單實扣台幣）
//   其他                   ← ledger_entries（人工記，金額填信用卡帳單上的台幣）
// ⚠️ 不可以刪，只能作廢；作廢的照樣列出來（劃線），只是不算進合計。
// ⚠️ 日期一律用**台灣時間**分日、分月——用 UTC 的話每天早上 8 點以前的交易會掉進前一天／前一個月。
// ---------------------------------------------------------------------------
const LEDGER_EXPENSE_CATS = ['AI 翻譯（Anthropic）', '雲端主機（Cloudflare）', '寄信（Resend）', '網域', '商店與開發者費用', '其他支出'];
const LEDGER_INCOME_CATS = ['其他收入'];
const LEDGER_TW = 8 * 3600;
const ledgerDay = (sec) => new Date((sec + LEDGER_TW) * 1000).toISOString().slice(0, 10);
/** 'YYYY-MM-DD'（台灣日期）→ 那天台灣中午的 unix 秒；格式錯或不存在的日期回 null */
function ledgerDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const sec = Date.UTC(+m[1], +m[2] - 1, +m[3], 4) / 1000;   // 台灣 12:00＝UTC 04:00
  return ledgerDay(sec) === m[0] ? sec : null;                // 2026-02-30 這種會被 Date 進位，擋掉
}
const ledgerMoney = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null; };

/**
 * 把 KV 裡付款／退款的訂單快照進 D1。打開帳本與每日排程各跑一次。
 * 已經在 D1、而且狀態沒變的訂單不重讀（付款之後只有「退款」會改到帳務欄位）。
 * ⚠️ 用 fresh 列舉（鐵則 47）：只在人打開帳本與每天一次的排程，不在任何輪詢路徑上。
 */
async function ledgerSyncOrders(env, db) {
  const { rows } = await orderRows(env, { fresh: true });
  const have = new Map(((await db.prepare('SELECT order_no, status FROM ledger_orders').all()).results || []).map((r) => [r.order_no, r.status]));
  const stmts = [];
  for (const r of rows) {
    if (r.status !== 'paid' && r.status !== 'refunded') continue;
    if (have.get(r.no) === r.status) continue;
    const o = await readOrder(env, r.no);
    if (!o || (o.status !== 'paid' && o.status !== 'refunded')) continue;
    const paidAt = Number(o.paidAt) || Number(r.at) || 0;
    if (!paidAt) continue;
    const amount = Math.round(o.amount !== undefined && Number.isFinite(Number(o.amount)) ? Number(o.amount) : (Number(o.price) || 0));
    const fee = o.fee !== undefined && o.fee !== null && Number.isFinite(Number(o.fee)) ? Number(o.fee) : null;
    const refunded = o.status === 'refunded';
    stmts.push(db.prepare('INSERT INTO ledger_orders (order_no, paid_at, amount_twd, fee_twd, pay_type, trade_no, summary, status, refunded_at, synced_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (order_no) DO UPDATE SET'
      + ' paid_at = excluded.paid_at, amount_twd = excluded.amount_twd, fee_twd = COALESCE(excluded.fee_twd, ledger_orders.fee_twd),'
      + ' pay_type = COALESCE(excluded.pay_type, ledger_orders.pay_type), trade_no = COALESCE(excluded.trade_no, ledger_orders.trade_no),'
      + ' summary = excluded.summary, status = excluded.status, refunded_at = excluded.refunded_at, synced_at = excluded.synced_at')
      .bind(r.no, paidAt, amount, fee, o.payType ? String(o.payType) : null, o.tradeNo ? String(o.tradeNo) : null,
        String(o.summary || r.summary || '').slice(0, 200), refunded ? 'refunded' : 'paid',
        refunded ? (Number(o.refundedAt) || nowSec()) : null, nowSec()));
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

/** 帳本：每一筆收支（三個來源合併）＋每月合計。from／to 是 'YYYY-MM'（台灣時間），不給就全部。 */
async function handleLedger(env, url) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  let synced = 0;
  let syncError = '';
  try { synced = await ledgerSyncOrders(env, db); } catch (e) { syncError = String((e && e.message) || e).slice(0, 200); }
  const from = /^\d{4}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : '';
  const to = /^\d{4}-\d{2}$/.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : '';

  const lines = [];
  // dir：+1 收入、-1 支出。amount 一律正數；null＝缺資料（手續費沒帶也沒補登）
  const add = (sec, dir, category, item, amount, extra) => lines.push(Object.assign({ date: ledgerDay(sec), at: sec, dir, category, item, amount }, extra || {}));
  const ords = (await db.prepare('SELECT * FROM ledger_orders ORDER BY paid_at').all()).results || [];
  for (const o of ords) {
    if (!o.amount_twd) continue;
    add(o.paid_at, 1, '銷售收入', o.summary || '訂單', o.amount_twd, { src: 'order', ref: o.order_no, payType: o.pay_type || '' });
    const fee = o.fee_twd != null ? o.fee_twd : o.fee_manual;
    add(o.paid_at, -1, '金流手續費', '綠界手續費 ' + o.order_no, fee == null ? null : fee,
      { src: 'fee', ref: o.order_no, feeFrom: o.fee_twd != null ? 'ecpay' : (o.fee_manual != null ? 'manual' : 'missing'), note: o.fee_note || '' });
    // 退款：整筆退。綠界的手續費退不退回要看綠界的對帳單，這裡不假設——有退回就記一筆「其他收入」
    if (o.status === 'refunded') add(o.refunded_at || o.paid_at, -1, '退款', '退款 ' + o.order_no, o.amount_twd, { src: 'refund', ref: o.order_no });
  }
  const costs = (await db.prepare('SELECT c.id, c.paid_at, c.amount_twd, c.amount_local, c.currency, c.note, a.login_email'
    + ' FROM f1_costs c LEFT JOIN f1_accounts a ON a.id = c.account_id ORDER BY c.paid_at').all()).results || [];
  for (const c of costs) {
    add(c.paid_at, -1, '代訂採購（F1TV）', 'F1TV 訂閱 ' + (c.login_email || ('#' + c.id)), c.amount_twd,
      { src: 'f1cost', ref: String(c.id), orig: c.amount_local != null ? c.amount_local + ' ' + (c.currency || '') : '', note: c.note || '' });
  }
  const ents = (await db.prepare('SELECT * FROM ledger_entries ORDER BY occurred_at, id').all()).results || [];
  for (const e of ents) {
    add(e.occurred_at, e.kind === 'income' ? 1 : -1, e.category, e.item, e.amount_twd, {
      src: 'entry', ref: String(e.id), orig: e.amount_orig != null ? e.amount_orig + ' ' + (e.currency || '') : '',
      receipt: e.receipt || '', note: e.note || '', voided: !!e.voided, voidReason: e.void_reason || '',
    });
  }
  const inRange = (l) => (!from || l.date.slice(0, 7) >= from) && (!to || l.date.slice(0, 7) <= to);
  const out = lines.filter(inRange).sort((a, b) => a.at - b.at || a.dir - b.dir);

  const months = {};
  for (const l of out) {
    if (l.voided || l.amount == null) continue;
    const ym = l.date.slice(0, 7);
    const m = months[ym] || (months[ym] = { ym, income: 0, expense: 0, byCat: {} });
    if (l.dir > 0) m.income += l.amount; else m.expense += l.amount;
    m.byCat[l.category] = (m.byCat[l.category] || 0) + l.dir * l.amount;
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  const monthList = Object.values(months).sort((a, b) => (a.ym < b.ym ? -1 : 1))
    .map((m) => ({ ym: m.ym, income: r2(m.income), expense: r2(m.expense), net: r2(m.income - m.expense), byCat: m.byCat }));
  return json({
    ok: true, from, to, synced, syncError,
    lines: out,
    months: monthList,
    missingFee: out.filter((l) => l.src === 'fee' && l.amount == null).map((l) => l.ref),
    categories: { expense: LEDGER_EXPENSE_CATS, income: LEDGER_INCOME_CATS },
  }, 200, { 'cache-control': 'no-store' });
}

async function handleLedgerEntry(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  if (!b) return err('body 不是合法 JSON');
  const at = ledgerDate(b.date);
  if (!at) return err('日期請填 YYYY-MM-DD（刷卡或入帳的那一天）');
  if (at > nowSec() + 86400) return err('日期不可以是未來（帳本只記已經發生的）');
  const kind = b.kind === 'income' ? 'income' : b.kind === 'expense' ? 'expense' : '';
  if (!kind) return err('請選收入或支出');
  const cats = kind === 'income' ? LEDGER_INCOME_CATS : LEDGER_EXPENSE_CATS;
  if (!cats.includes(b.category)) return err('分類不對');
  const item = resellStr(b.item, 120);
  if (!item) return err('請填這筆是什麼');
  const twd = Number(b.amount_twd);
  if (!Number.isInteger(twd) || twd <= 0 || twd > 10000000) return err('台幣金額請填正整數（信用卡帳單上的實扣金額）');
  const orig = b.amount_orig == null || b.amount_orig === '' ? null : ledgerMoney(b.amount_orig, 10000000);
  if (b.amount_orig != null && b.amount_orig !== '' && orig == null) return err('原幣金額不對');
  const cur = resellStr(b.currency, 3);
  if (cur && !/^[A-Za-z]{3}$/.test(cur)) return err('幣別請填三碼（USD、EUR…）');
  const now = nowSec();
  const r = await db.prepare('INSERT INTO ledger_entries (occurred_at, kind, category, item, amount_twd, amount_orig, currency, receipt, note, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(at, kind, b.category, item, twd, orig, cur ? cur.toUpperCase() : null, resellStr(b.receipt, 200), resellStr(b.note, 300), now, now).run();
  return json({ ok: true, id: r.meta && r.meta.last_row_id });
}

/** 作廢（不刪）。已作廢的不能再改——要改就作廢再記一筆新的。 */
async function handleLedgerVoid(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  const id = Number(b && b.id);
  if (!Number.isInteger(id) || id <= 0) return err('id 不對');
  const reason = resellStr(b.reason, 200);
  if (!reason) return err('作廢要寫原因');
  const r = await db.prepare('UPDATE ledger_entries SET voided = 1, void_reason = ?, updated_at = ? WHERE id = ? AND voided = 0').bind(reason, nowSec(), id).run();
  if (!(r.meta && r.meta.changes)) return err('查無此筆，或已經作廢', 404);
  return json({ ok: true });
}

/** 訂單手續費人工補登（付款通知沒帶的）。綠界通知有帶的不給改——以通知為準。 */
async function handleLedgerFee(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  const no = String((b && b.order_no) || '').trim();
  const fee = ledgerMoney(b && b.fee_twd, 100000);
  if (!no || fee == null) return err('訂單編號或手續費不對');
  const row = await db.prepare('SELECT fee_twd FROM ledger_orders WHERE order_no = ?').bind(no).first();
  if (!row) return err('帳本裡沒有這筆訂單（只有付款成功的訂單會進帳本）', 404);
  if (row.fee_twd != null) return err('這筆的手續費是綠界付款通知帶的，以通知為準，不能改', 409);
  await db.prepare('UPDATE ledger_orders SET fee_manual = ?, fee_note = ? WHERE order_no = ?').bind(fee, resellStr(b.note, 200), no).run();
  return json({ ok: true });
}

async function resellCryptoKey(env) {
  const raw = String((env && env.RESELL_KEY) || '').trim();
  if (!raw) return null;
  let bytes;
  try { bytes = b64urlToBytes(raw); } catch (e) { return null; }
  if (bytes.length !== 32) return null;
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** 加密交付用密碼。aad 用 login_email：密文只對那一列有效。 */
async function resellSeal(env, plain, aad) {
  const key = await resellCryptoKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(String(aad)) },
    key, new TextEncoder().encode(String(plain)));
  return 'v1.' + b64url(iv) + '.' + b64url(ct);
}

async function resellOpen(env, sealed, aad) {
  const key = await resellCryptoKey(env);
  if (!key) throw new Error('RESELL_KEY 未設定或格式不對，無法解密');
  const [ver, iv, ct] = String(sealed || '').split('.');
  if (ver !== 'v1' || !iv || !ct) throw new Error('密文格式不對');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlToBytes(iv), additionalData: new TextEncoder().encode(String(aad)) },
    key, b64urlToBytes(ct));
  return new TextDecoder().decode(pt);
}

async function resellLog(db, e) {
  await db.prepare('INSERT INTO f1_events (at, actor, kind, account_id, order_no, cust_acct, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(nowSec(), e.actor || 'admin', e.kind, e.account_id == null ? null : e.account_id,
      e.order_no || null, e.cust_acct || null, e.detail ? String(e.detail).slice(0, 300) : null)
    .run();
}

const resellStr = (v, max) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);
function resellSec(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;   // undefined＝格式錯
}

/** 後台「代訂」分頁的全部資料。量很小（帳號數十個），一次給。 */
async function handleResellOverview(env) {
  const db = resellDb(env);
  const keyOk = !!(await resellCryptoKey(env));
  if (!db) {
    return json({ ok: true, configured: { db: false, key: keyOk }, accounts: [], regions: [], costs: [],
      assignments: [], seatsByGp: [], sharedPool: { accounts: 0, seatsPerAccount: RESELL_SEATS }, settings: { sharedCap: false } });
  }
  const now = nowSec();
  const [acc, reg, cost] = await db.batch([
    db.prepare(`SELECT ${RESELL_ACCOUNT_COLS} FROM f1_accounts ORDER BY status, renews_at IS NULL, renews_at, id`),
    db.prepare('SELECT * FROM f1_regions ORDER BY region'),
    db.prepare('SELECT account_id, COUNT(*) AS n, SUM(amount_twd) AS twd, MAX(paid_at) AS last_paid FROM f1_costs GROUP BY account_id'),
  ]);
  const accounts = (acc.results || []).map((a) => Object.assign({}, a, { has_pw: !!a.has_pw, auto_renew: !!a.auto_renew }));
  const regions = (reg.results || []).map((r) => Object.assign({}, r, {
    usable: !!r.usable,
    stale: now - (r.checked_at || 0) > RESELL_REGION_STALE_DAYS * 86400,
  }));
  const byStatus = {};
  for (const s of RESELL_STATUS) byStatus[s] = 0;
  for (const a of accounts) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  const extra = await resellOverviewExtra(db);
  return json({
    ok: true,
    at: now,
    ...extra,
    configured: { db: true, key: keyOk },
    accounts,
    regions,
    costs: cost.results || [],
    summary: {
      byStatus,
      pendingAssignments: extra.assignments.filter((x) => x.status === 'pending').length,
      renewingSoon: accounts.filter((a) => a.status !== 'disabled' && a.renews_at
        && a.renews_at - now <= RESELL_RENEW_SOON_DAYS * 86400).map((a) => a.id),
      staleRegions: regions.filter((r) => r.stale).map((r) => r.region),
    },
    rules: { regionStaleDays: RESELL_REGION_STALE_DAYS, renewSoonDays: RESELL_RENEW_SOON_DAYS },
  });
}

/**
 * 新增或修改一個我方的 F1TV 帳號。
 * password 有給才動密碼；clearPassword:true 清掉。**回應永遠不帶密碼。**
 */
async function handleResellAccountSave(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  if (!b) return err('body 不是合法 JSON');

  const id = b.id == null || b.id === '' ? null : Number(b.id);
  if (id != null && !(Number.isInteger(id) && id > 0)) return err('id 不對');
  const old = id ? await db.prepare('SELECT id, login_email, pw_enc, pw_set_at FROM f1_accounts WHERE id = ?').bind(id).first() : null;
  if (id && !old) return err('查無此帳號', 404);

  const loginEmail = b.login_email == null && old ? old.login_email : accountKey(b.login_email);
  if (!looksLikeEmail(loginEmail)) return err('登入信箱格式不對');
  const region = String(b.region || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return err('採購區請填兩碼國碼（例如 BR、KR）');
  const tier = String(b.tier || '');
  if (!RESELL_TIERS.includes(tier)) return err('方案只能是 pro 或 premium');
  const billing = String(b.billing || 'monthly');
  if (!RESELL_BILLING.includes(billing)) return err('計費只能是 monthly 或 annual');
  const status = String(b.status || 'available');
  if (!RESELL_STATUS.includes(status)) return err('狀態不對');
  // 共用帳號只能用 Premium：Pro 同時只有 1 條串流（RESELL-OPS 1.1，官方比較表）
  if (status === 'shared' && tier !== 'premium') return err('共用帳號只能用 Premium（Pro 同時只能 1 條串流）');
  const renewsAt = resellSec(b.renews_at);
  if (renewsAt === undefined) return err('到期／扣款日格式不對');
  const cardRef = resellStr(b.card_ref, 40);
  // 只存末四碼或虛擬卡代號。13 位以上的連續數字就是完整卡號——不收。
  if (cardRef && /\d{13,}/.test(cardRef.replace(/[\s-]/g, ''))) return err('卡片只記末四碼或代號，不要存完整卡號');

  const pw = b.password == null || b.password === '' ? null : String(b.password);
  if (pw != null && (pw.length < 4 || pw.length > 200)) return err('密碼長度不對');
  // 密文的 AAD 綁登入信箱：改信箱又不給新密碼的話，舊密文就再也解不開
  if (old && old.pw_enc && loginEmail !== old.login_email && pw == null && !b.clearPassword) {
    return err('改登入信箱時要重新輸入密碼（密碼是綁著信箱加密的）');
  }
  let pwEnc = old ? old.pw_enc : null;
  let pwChanged = false;
  if (pw != null) {
    pwEnc = await resellSeal(env, pw, loginEmail);
    if (!pwEnc) return err('RESELL_KEY 未設定或格式不對，不能存密碼（不會改存明文）', 503);
    pwChanged = true;
  } else if (b.clearPassword) {
    pwEnc = null;
    pwChanged = !!(old && old.pw_enc);
  }

  // 代理商帳號的品項與型態（交付時寫入；填錯時在後台改，2026-10-23）。自營帳號不收這兩欄。
  let agentFix = null;
  if (old && (b.agent_sku !== undefined || b.share !== undefined)) {
    const src = await db.prepare('SELECT source, agent_sku, share FROM f1_accounts WHERE id = ?').bind(id).first();
    if (!src || src.source !== 'agent') return err('只有代理商帳號有「代理商品項」與「型態」');
    const share = b.share === undefined ? src.share : String(b.share);
    if (!RESELL_SHARE.includes(share)) return err('型態不對');
    agentFix = [b.agent_sku === undefined ? src.agent_sku : resellStr(b.agent_sku, 80), share];
  }

  const now = nowSec();
  const vals = [loginEmail, region, tier, billing, status, renewsAt, b.auto_renew === false ? 0 : 1,
    resellStr(b.vault_ref, 120), cardRef, resellStr(b.note, 1000)];
  let accountId = id;
  try {
    if (old) {
      await db.prepare('UPDATE f1_accounts SET login_email = ?, region = ?, tier = ?, billing = ?, status = ?, renews_at = ?,'
        + ' auto_renew = ?, vault_ref = ?, card_ref = ?, note = ?, pw_enc = ?, pw_set_at = ?, updated_at = ? WHERE id = ?')
        .bind(...vals, pwEnc, pwChanged ? (pwEnc ? now : null) : (old.pw_set_at || null), now, id)
        .run();
    } else {
      const r = await db.prepare('INSERT INTO f1_accounts (login_email, region, tier, billing, status, renews_at, auto_renew,'
        + ' vault_ref, card_ref, note, pw_enc, pw_set_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(...vals, pwEnc, pwEnc ? now : null, now, now)
        .run();
      accountId = r.meta && r.meta.last_row_id;
    }
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return err('這個登入信箱已經在庫存裡了');
    throw e;
  }
  if (agentFix) {
    await db.prepare('UPDATE f1_accounts SET agent_sku = ?, share = ? WHERE id = ?').bind(agentFix[0], agentFix[1], id).run();
  }
  await resellLog(db, { kind: old ? 'account_edit' : 'account_add', account_id: accountId,
    detail: `${loginEmail} ${region} ${tier}/${billing} ${status}` + (agentFix ? ` ${agentFix[1]} ${agentFix[0] || ''}` : '') });
  if (pwChanged) await resellLog(db, { kind: pwEnc ? 'pw_set' : 'pw_clear', account_id: accountId });
  return json({ ok: true, id: accountId });
}

/** 解密交付用密碼給後台看。**每一次都記一筆**（RESELL-OPS 3.2 第 4 條）。 */
async function handleResellReveal(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  const id = Number(b && b.id);
  if (!Number.isInteger(id) || id <= 0) return err('id 不對');
  const row = await db.prepare('SELECT login_email, pw_enc FROM f1_accounts WHERE id = ?').bind(id).first();
  if (!row) return err('查無此帳號', 404);
  if (!row.pw_enc) return err('這個帳號沒有存交付用密碼', 404);
  let password;
  try { password = await resellOpen(env, row.pw_enc, row.login_email); } catch (e) {
    await resellLog(db, { kind: 'pw_reveal_fail', account_id: id, detail: String(e && e.message || e) });
    return err('解密失敗：' + String(e && e.message || e), 500);
  }
  // 先記再給：記不下來就不給（沒有紀錄的查看＝無法追查）
  await resellLog(db, { kind: 'pw_reveal', account_id: id });
  return json({ ok: true, id, login_email: row.login_email, password });
}

async function handleResellCostAdd(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  if (!b) return err('body 不是合法 JSON');
  const accountId = Number(b.account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) return err('account_id 不對');
  if (!(await db.prepare('SELECT id FROM f1_accounts WHERE id = ?').bind(accountId).first())) return err('查無此帳號', 404);
  const from = resellSec(b.period_from);
  const until = resellSec(b.period_until);
  const paidAt = resellSec(b.paid_at) || nowSec();
  if (!from || !until || until <= from) return err('期間不對（迄日要晚於起日）');
  const twd = Number(b.amount_twd);
  if (!Number.isFinite(twd) || twd <= 0 || twd > 100000) return err('台幣實扣金額不對');
  const local = b.amount_local == null || b.amount_local === '' ? null : Number(b.amount_local);
  if (local != null && !(Number.isFinite(local) && local > 0)) return err('當地價格不對');
  const currency = resellStr(b.currency, 3);
  if (currency && !/^[A-Z]{3}$/.test(currency.toUpperCase())) return err('幣別請填三碼（BRL、KRW…）');
  const r = await db.prepare('INSERT INTO f1_costs (account_id, period_from, period_until, amount_local, currency, amount_twd,'
    + ' paid_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(accountId, from, until, local, currency ? currency.toUpperCase() : null, Math.round(twd), paidAt,
      resellStr(b.note, 300), nowSec())
    .run();
  await resellLog(db, { kind: 'cost_add', account_id: accountId, detail: `NT$${Math.round(twd)}` + (local ? ` (${local} ${currency || ''})` : '') });
  return json({ ok: true, id: r.meta && r.meta.last_row_id });
}

/** 採購區價格。每存一次就把核對日期更新成現在——**這就是「最後一次親眼看過結帳頁」的紀錄**。 */
async function handleResellRegionSave(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  if (!b) return err('body 不是合法 JSON');
  const region = String(b.region || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return err('採購區請填兩碼國碼');
  const price = (v) => (v == null || v === '' ? null : Number(v));
  const p = [price(b.pro_month), price(b.pro_year), price(b.prem_month), price(b.prem_year)];
  if (p.some((v) => v != null && !(Number.isFinite(v) && v > 0))) return err('價格要是正數');
  const basis = b.price_basis == null || b.price_basis === '' ? null : String(b.price_basis);
  if (basis && !['local', 'usd'].includes(basis)) return err('計價基準只能是 local 或 usd');
  const currency = resellStr(b.currency, 3);
  await db.prepare('INSERT INTO f1_regions (region, currency, pro_month, pro_year, prem_month, prem_year, price_basis, usable, checked_at, note)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (region) DO UPDATE SET currency = excluded.currency,'
    + ' pro_month = excluded.pro_month, pro_year = excluded.pro_year, prem_month = excluded.prem_month,'
    + ' prem_year = excluded.prem_year, price_basis = excluded.price_basis, usable = excluded.usable,'
    + ' checked_at = excluded.checked_at, note = excluded.note')
    .bind(region, currency ? currency.toUpperCase() : null, ...p, basis, b.usable === false ? 0 : 1, nowSec(), resellStr(b.note, 300))
    .run();
  await resellLog(db, { kind: 'region_set', detail: region + (b.usable === false ? '（不可用）' : '') });
  return json({ ok: true, region });
}

async function handleResellEvents(env, url) {
  const db = resellDb(env);
  if (!db) return json({ ok: true, configured: { db: false }, events: [] });
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
  const aid = Number(url.searchParams.get('account_id'));
  const stmt = Number.isInteger(aid) && aid > 0
    ? db.prepare('SELECT * FROM f1_events WHERE account_id = ? ORDER BY at DESC, id DESC LIMIT ?').bind(aid, limit)
    : db.prepare('SELECT * FROM f1_events ORDER BY at DESC, id DESC LIMIT ?').bind(limit);
  const r = await stmt.all();
  return json({ ok: true, events: r.results || [] });
}

/** LIKE 的萬用字元要跳脫，否則搜「f1_」會把每一列都找出來。 */
const resellLike = (q) => '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';

/**
 * 後台的全域查詢：輸入 email、訂單編號、授權碼、或我方 F1TV 帳號的任何片段，一次看到所有相關的東西。
 *
 * ⚠️ **「最新」是這支的規格**（使用者 2026-10-12：「可以查詢所有資料，也得確保都是最新資訊」）：
 *    · 訂單清單**不走** 5 分鐘的記憶體快取（orderRows fresh）
 *    · D1 沒開讀取副本，讀的是主資料庫，寫完立刻看得到
 *    · KV 是最終一致：**別的機房**剛寫的東西最多約 60 秒才看得到——這是 KV 本身的性質，回應的 notes 會講
 */
async function handleAdminSearch(env, url) {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 200);
  if (q.length < 2) return err('請輸入至少 2 個字');
  const out = { ok: true, q, at: nowSec(), customer: null, order: null, license: null, f1Accounts: [], assignments: [], events: [],
    notes: ['訂單、授權、帳號存在 KV：別的機房剛寫入的資料最多約 60 秒後才查得到。代訂資料（D1）是即時的。'] };

  // 訂單編號
  for (const no of [...new Set([q, q.toUpperCase()])]) {
    const o = await readOrder(env, no);
    if (o) { out.order = o; break; }
  }
  // 授權碼
  let lic = null;
  const nk = normLicense(q);
  if (nk.length >= 8 && !q.includes('@')) {
    lic = await readLicense(env, nk);
    if (lic) {
      out.license = {
        licenseKey: prettyLicense(nk), plan: lic.plan, planLabel: (PLANS[lic.plan] || {}).label || lic.plan,
        acct: lic.acct || null, email: lic.email || null, orderId: lic.orderId || null,
        revoked: !!lic.revoked, replacedBy: lic.replacedBy || null, expiresAt: lic.expiresAt || null,
        devices: (lic.devices || []).length,
      };
    }
  }
  // 由上面任何一個推出客戶帳號
  let acct = null;
  if (q.includes('@')) acct = accountKey(q);
  else if (out.order && out.order.email) acct = accountKey(out.order.email);
  else if (lic) acct = lic.acct || accountKey(lic.email);
  if (acct && acct.includes('@')) {
    out.customer = await accountView(env, acct, { fresh: true });
  }

  const db = resellDb(env);
  if (db) {
    const like = resellLike(q.toLowerCase());
    const r = await db.prepare(`SELECT ${RESELL_ACCOUNT_COLS} FROM f1_accounts WHERE lower(login_email) LIKE ?1 ESCAPE '\\'`
      + ` OR lower(coalesce(note, '')) LIKE ?1 ESCAPE '\\' OR lower(coalesce(vault_ref, '')) LIKE ?1 ESCAPE '\\'`
      + ` OR lower(coalesce(card_ref, '')) LIKE ?1 ESCAPE '\\' ORDER BY id LIMIT 20`).bind(like).all();
    out.f1Accounts = (r.results || []).map((a) => Object.assign({}, a, { has_pw: !!a.has_pw, auto_renew: !!a.auto_renew }));
    const ids = out.f1Accounts.map((a) => a.id);
    {
      const c2 = [];
      const a2 = [];
      if (ids.length) { c2.push(`a.account_id IN (${ids.map(() => '?').join(', ')})`); a2.push(...ids); }
      if (out.order) { c2.push('a.order_no = ?'); a2.push(out.order.no || q); }
      if (acct) { c2.push('a.cust_acct = ?'); a2.push(acct); }
      if (c2.length) {
        const ar = await db.prepare(`SELECT a.*, f.login_email FROM f1_assignments a LEFT JOIN f1_accounts f ON f.id = a.account_id`
          + ` WHERE ${c2.join(' OR ')} ORDER BY a.created_at DESC LIMIT 50`).bind(...a2).all();
        out.assignments = (ar.results || []).map((x) => Object.assign({}, x, { planLabel: (PLANS[x.plan_key] || {}).label || x.plan_key }));
      }
    }
    const conds = [];
    const args = [];
    if (ids.length) { conds.push(`account_id IN (${ids.map(() => '?').join(', ')})`); args.push(...ids); }
    if (out.order) { conds.push('order_no = ?'); args.push(out.order.no || q); }
    if (acct) { conds.push('cust_acct = ?'); args.push(acct); }
    if (conds.length) {
      const ev = await db.prepare(`SELECT * FROM f1_events WHERE ${conds.join(' OR ')} ORDER BY at DESC, id DESC LIMIT 50`)
        .bind(...args).all();
      out.events = ev.results || [];
    }
  } else {
    out.notes.push('代訂資料庫還沒建立，F1TV 帳號庫存不在查詢範圍內。');
  }
  out.found = !!(out.order || out.license || (out.customer && (out.customer.licenses.length || out.customer.purchases.length))
    || out.f1Accounts.length || out.assignments.length);
  return json(out);
}

