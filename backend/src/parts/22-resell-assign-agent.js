// ---------------------------------------------------------------------------
// 代訂自營 第 2 階段：訂單 ↔ 帳號指派、共用帳號席次、結帳保留名額（RESELL-OPS 第 4、7 節）
//
// ⚠️ **「賣第 5 席」靠資料庫擋，不靠程式先查再寫。** 先查再寫在並發時一定會超賣
//    （鐵則 16、52、60 的同一類）。這裡每一個「搶」都是單一條件式 SQL，
//    SQLite 一次只執行一個寫入，所以條件與寫入之間不會有別人插隊；
//    f1_seats 的 CHECK（seat_no 1～4）與主鍵是第二道防線——程式算錯也插不進第 5 席。
// ⚠️ 自備帳號（byo）**不連結任何 F1TV 帳號**（使用者 2026-10-12）：指派時直接拒絕。
// ---------------------------------------------------------------------------
const RESELL_SEATS = 4;                     // 每個共用帳號賣幾席（Premium 官方 6 台，留 2 台）
const RESELL_HOLD_SEC = 2 * 3600;           // 結帳保留名額多久（沒付款就釋出；取號會延長到 3 天）
const RESELL_ACTIVE = "('pending', 'active')";

/** 這個方案現在可選的帳號模式（第一個是預設）。一個月方案的自備帳號要等條款（byoGated）。 */
function resellModesOf(key, env) {
  const p = PLANS[key];
  if (!p || !p.manual || !Array.isArray(p.acctModes)) return [];
  return p.acctModes.filter((m) => m !== 'byo' || !p.byoGated || (env && env.RESELL_BYO_MONTHLY === '1'));
}

/** 訂單裡記的模式 → 實際模式。舊訂單沒記就用方案的預設（一個月＝我們提供、年＝自備、週末＝共用）。 */
function resellModeFor(key, recorded) {
  const p = PLANS[key] || {};
  const all = Array.isArray(p.acctModes) ? p.acctModes : [];
  return all.includes(recorded) ? recorded : (all[0] || 'ours');
}

function resellMonthsFor(key, qty) {
  const p = PLANS[key] || {};
  if (p.svcWeekend) return 0;
  if (/_1y_/.test(key)) return 12;
  return Math.max(1, Number(qty) || 1);
}

async function resellSetting(db, key, dflt) {
  const r = await db.prepare('SELECT value FROM f1_settings WHERE key = ?').bind(key).first();
  return r ? r.value : dflt;
}

/**
 * 結帳時替共用帳號保留一席。回 { ok, skipped }。
 * 席次上限（設定 shared_cap）沒打開時不檢查——2026-10-12 前的「照現狀繼續賣」。
 *
 * 名額＝共用帳號數 × 4；已用＝還沒結束的共用指派＋還沒變成指派、也還沒過期的保留。
 * ⚠️ 一條 INSERT … SELECT … WHERE 就是整個判斷，不可以拆成「先 SELECT 再 INSERT」。
 */
async function resellHoldShared(env, orderNo, gp) {
  const db = resellDb(env);
  if (!db) return { ok: true, skipped: true };
  if ((await resellSetting(db, 'shared_cap', 'off')) !== 'on') return { ok: true, skipped: true };
  const now = nowSec();
  const r = await db.prepare(
    'INSERT INTO f1_holds (order_no, gp_id, created_at, expires_at) SELECT ?1, ?2, ?3, ?4'
    + " WHERE (SELECT COUNT(*) FROM f1_accounts WHERE status = 'shared' AND tier = 'premium') * ?5"
    + ` > (SELECT COUNT(*) FROM f1_assignments WHERE mode = 'shared' AND gp_id = ?2 AND status IN ${RESELL_ACTIVE})`
    + ' + (SELECT COUNT(*) FROM f1_holds h WHERE h.gp_id = ?2 AND h.expires_at > ?3'
    + '      AND NOT EXISTS (SELECT 1 FROM f1_assignments x WHERE x.order_no = h.order_no))')
    .bind(String(orderNo), String(gp), now, now + RESELL_HOLD_SEC, RESELL_SEATS).run();
  return { ok: !!(r.meta && r.meta.changes === 1) };
}

/**
 * 把一筆訂單的代訂項目寫成指派（待處理）。重複呼叫不會重複建立（UNIQUE order_no + line_idx）。
 * 退款的訂單：還沒處理的指派改成取消、釋出席次與帳號。
 */
async function resellSyncOrder(env, no, given) {
  const db = resellDb(env);
  if (!db) return 0;
  const o = given || await readOrder(env, no);
  if (!o) return 0;
  const now = nowSec();
  if (o.status === 'refunded') {
    const open = await db.prepare(`SELECT id FROM f1_assignments WHERE order_no = ? AND status IN ${RESELL_ACTIVE}`).bind(no).all();
    for (const a of open.results || []) await resellClose(db, a.id, 'cancelled', '訂單已退款');
    return 0;
  }
  if (o.status !== 'paid') return 0;
  const acct = accountKey(o.email);
  let n = 0;
  const services = Array.isArray(o.services) ? o.services : [];
  for (let i = 0; i < services.length; i++) {
    const s = services[i] || {};
    const p = PLANS[s.key];
    if (!p || !p.manual) continue;
    const mode = resellModeFor(s.key, s.acctMode);
    const r = await db.prepare('INSERT OR IGNORE INTO f1_assignments (order_no, line_idx, plan_key, mode, months, gp_id, cust_acct,'
      + " status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .bind(no, i, s.key, mode, resellMonthsFor(s.key, s.qty), p.svcWeekend ? (s.gp || null) : null, acct, now, now)
      .run();
    if (r.meta && r.meta.changes) {
      n++;
      await resellLog(db, { kind: 'assign_new', order_no: no, cust_acct: acct, detail: `${p.label}・${mode}` + (s.gp ? `・${s.gp}` : '') });
    }
  }
  return n;
}

/**
 * 補同步：已付款、代訂還沒結案的訂單裡，D1 還沒有的那幾筆（webhook 當下寫失敗的）。
 * ⚠️ 訂單清單讀最新的（fresh），只在後台按下時跑——不在任何輪詢路徑上（鐵則 47）。
 */
async function resellSyncAll(env) {
  const db = resellDb(env);
  if (!db) return { synced: 0, checked: 0 };
  const { rows } = await orderRows(env, { fresh: true });
  const known = new Set(((await db.prepare('SELECT DISTINCT order_no FROM f1_assignments').all()).results || []).map((r) => r.order_no));
  const openKnown = new Set(((await db.prepare(`SELECT DISTINCT order_no FROM f1_assignments WHERE status IN ${RESELL_ACTIVE}`).all()).results || []).map((r) => r.order_no));
  let synced = 0;
  let checked = 0;
  for (const r of rows) {
    const need = (r.status === 'paid' && r.manual && !known.has(r.no)) || (r.status === 'refunded' && openKnown.has(r.no));
    if (!need) continue;
    checked++;
    synced += await resellSyncOrder(env, r.no);
    if (checked >= 50) break;          // 一次最多讀 50 筆訂單（KV 讀取），剩下的下一次再補
  }
  return { synced, checked };
}

/** 收尾一筆指派（結束、違規、取消），連同帳號與席次。 */
async function resellClose(db, id, status, note) {
  const a = await db.prepare('SELECT * FROM f1_assignments WHERE id = ?').bind(id).first();
  if (!a) return null;
  const now = nowSec();
  const stmts = [
    db.prepare(`UPDATE f1_assignments SET status = ?, note = coalesce(?, note), updated_at = ? WHERE id = ? AND status IN ${RESELL_ACTIVE}`)
      .bind(status, note || null, now, id),
  ];
  if (a.mode === 'ours' && a.account_id) {
    // 交付過（active）的帳號一定要先改密碼才能再用 → 回收中；從沒交付的直接回到可指派
    // ⚠️ 只限我們自營的帳號：代理商的帳號不歸我們回收（見下一段）
    stmts.push(db.prepare("UPDATE f1_accounts SET status = ?, updated_at = ? WHERE id = ? AND status = 'assigned' AND source = 'self'")
      .bind(a.status === 'active' || status === 'revoked' ? 'recovering' : 'available', now, a.account_id));
  }
  if (a.account_id) {
    // 代理商的帳號：最後一筆使用它的指派結束時，停用並**清掉交付用密碼**（RESELL-OPS 3.2 第 2 條：到期要真的刪）。
    // 合用帳號可能還有別位客戶在用，所以條件是「沒有任何還沒結束的指派」。同一個 batch，看得到上面那句的結果。
    stmts.push(db.prepare("UPDATE f1_accounts SET status = 'disabled', pw_enc = NULL, pw_set_at = NULL, updated_at = ?1"
      + " WHERE id = ?2 AND source = 'agent'"
      + ` AND NOT EXISTS (SELECT 1 FROM f1_assignments WHERE account_id = ?2 AND status IN ${RESELL_ACTIVE})`)
      .bind(now, a.account_id));
  }
  // 共用帳號：取消與違規釋出席次（可以再賣）；正常結束保留紀錄（那一場已經過了）
  if (a.mode === 'shared' && status !== 'ended') {
    stmts.push(db.prepare('DELETE FROM f1_seats WHERE assignment_id = ?').bind(id));
  }
  await db.batch(stmts);
  return a;
}

/** 依方案算使用期間。共用帳號＝該週末的週五 00:00（台灣）到正賽後 3 小時。 */
function resellPeriod(a, startsAt) {
  if (a.mode === 'shared') {
    const g = a.gp_id ? gpById(a.gp_id) : null;
    if (!g) return { starts: startsAt || null, ends: null };
    return {
      starts: dayStartSec(g.start) - 8 * 3600,
      ends: gpHandoverSec(g) || (dayStartSec(g.end) + 86400),
    };
  }
  const s = startsAt || nowSec();
  const d = new Date(s * 1000);
  d.setUTCMonth(d.getUTCMonth() + (Number(a.months) || 1));
  return { starts: s, ends: Math.floor(d.getTime() / 1000) };
}

/** 指派一個我方帳號（專屬）或一個共用席次。 */
async function handleResellAssign(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  const id = Number(b && b.id);
  if (!Number.isInteger(id) || id <= 0) return err('id 不對');
  const a = await db.prepare('SELECT * FROM f1_assignments WHERE id = ?').bind(id).first();
  if (!a) return err('查無此指派', 404);
  if (a.mode === 'byo') return err('自備帳號的訂單不指派我方的帳號（不連結客戶的 F1TV 帳號）');
  if (!['pending', 'active'].includes(a.status)) return err('這筆已經結束，不能再指派');
  if (a.account_id) return err('已經指派過了；要換帳號請先「取消指派」');
  const tier = (PLANS[a.plan_key] || {}).f1Tier || 'premium';
  const now = nowSec();
  const wantAcc = b.account_id == null || b.account_id === '' ? null : Number(b.account_id);

  if (a.mode === 'ours') {
    if (!Number.isInteger(wantAcc) || wantAcc <= 0) return err('請選擇要指派的帳號');
    const acc = await db.prepare('SELECT id, tier, status FROM f1_accounts WHERE id = ?').bind(wantAcc).first();
    if (!acc) return err('查無此帳號', 404);
    if (acc.tier !== tier) return err(`這筆訂單要 ${tier === 'premium' ? 'Premium' : 'Pro'} 帳號，選的是 ${acc.tier === 'premium' ? 'Premium' : 'Pro'}`);
    // 先綁指派（條件：帳號此刻是可指派），再改帳號狀態（條件：指派真的綁到它）。同一個 batch＝同一個交易。
    const res = await db.batch([
      db.prepare(`UPDATE f1_assignments SET account_id = ?1, updated_at = ?2 WHERE id = ?3 AND account_id IS NULL AND status IN ${RESELL_ACTIVE}`
        + " AND EXISTS (SELECT 1 FROM f1_accounts WHERE id = ?1 AND status = 'available' AND tier = ?4)").bind(wantAcc, now, id, tier),
      db.prepare("UPDATE f1_accounts SET status = 'assigned', updated_at = ?2 WHERE id = ?1 AND status = 'available'"
        + ' AND EXISTS (SELECT 1 FROM f1_assignments WHERE id = ?3 AND account_id = ?1)').bind(wantAcc, now, id),
    ]);
    if (!(res[0].meta && res[0].meta.changes === 1)) return err('這個帳號現在不是「可指派」（可能剛被別筆訂單用走），請重新整理', 409);
    await resellLog(db, { kind: 'assign', account_id: wantAcc, order_no: a.order_no, cust_acct: a.cust_acct });
    return json({ ok: true, id, account_id: wantAcc });
  }

  // ---- 共用帳號：搶一個席次 ----
  const gp = String((b && b.gp_id) || a.gp_id || '');
  if (!gp || !gpById(gp)) return err('請指定場次（這筆訂單沒有記錄是哪一場）');
  let cands;
  if (wantAcc) cands = [wantAcc];
  else {
    // 自動挑：先塞滿已經有人的帳號（少換幾個帳號的密碼），再用新的
    const r = await db.prepare("SELECT a.id, (SELECT COUNT(*) FROM f1_seats s WHERE s.gp_id = ?1 AND s.account_id = a.id) AS used"
      + " FROM f1_accounts a WHERE a.status = 'shared' AND a.tier = 'premium' AND used < ?2 ORDER BY used DESC, a.id LIMIT 10")
      .bind(gp, RESELL_SEATS).all();
    cands = (r.results || []).map((x) => x.id);
  }
  for (const acc of cands) {
    const res = await db.batch([
      db.prepare('INSERT INTO f1_seats (gp_id, account_id, seat_no, assignment_id, created_at)'
        + ' SELECT ?1, ?2, n.n, ?3, ?4 FROM (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) AS n'
        + ' WHERE n.n <= ?5 AND n.n NOT IN (SELECT seat_no FROM f1_seats WHERE gp_id = ?1 AND account_id = ?2)'
        + " AND EXISTS (SELECT 1 FROM f1_accounts WHERE id = ?2 AND status = 'shared' AND tier = 'premium')"
        + ` AND EXISTS (SELECT 1 FROM f1_assignments WHERE id = ?3 AND account_id IS NULL AND status IN ${RESELL_ACTIVE})`
        + ' AND NOT EXISTS (SELECT 1 FROM f1_seats WHERE assignment_id = ?3)'
        + ' ORDER BY n.n LIMIT 1').bind(gp, acc, id, now, RESELL_SEATS),
      db.prepare('UPDATE f1_assignments SET account_id = ?2, gp_id = ?1, updated_at = ?4,'
        + ' seat_no = (SELECT seat_no FROM f1_seats WHERE assignment_id = ?3)'
        + ' WHERE id = ?3 AND EXISTS (SELECT 1 FROM f1_seats WHERE assignment_id = ?3 AND account_id = ?2)').bind(gp, acc, id, now),
    ]);
    if (res[0].meta && res[0].meta.changes === 1) {
      const row = await db.prepare('SELECT seat_no FROM f1_assignments WHERE id = ?').bind(id).first();
      await resellLog(db, { kind: 'seat', account_id: acc, order_no: a.order_no, cust_acct: a.cust_acct, detail: `${gp} 第 ${row.seat_no} 席` });
      return json({ ok: true, id, account_id: acc, seat_no: row.seat_no });
    }
  }
  return err(`${gp} 的共用帳號席次已滿（每個帳號 ${RESELL_SEATS} 席）。請新增共用帳號，或為這筆訂單退款`, 409);
}

/** 指派的狀態變更：開通、到期、違規收回、取消、取消指派、備註。 */
async function handleResellAssignmentAction(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  const id = Number(b && b.id);
  if (!Number.isInteger(id) || id <= 0) return err('id 不對');
  const a = await db.prepare('SELECT * FROM f1_assignments WHERE id = ?').bind(id).first();
  if (!a) return err('查無此指派', 404);
  const action = String((b && b.action) || '');
  const now = nowSec();
  const note = b && b.note != null ? resellStr(b.note, 500) : null;
  const open = ['pending', 'active'].includes(a.status);

  if (action === 'activate') {
    if (!open) return err('這筆已經結束');
    if (a.mode !== 'byo' && !a.account_id) return err('先指派帳號或席次，才能開通');
    const s = resellSec(b.starts_at);
    const e = resellSec(b.ends_at);
    if (s === undefined || e === undefined) return err('日期格式不對');
    const per = resellPeriod(a, s);
    const starts = s || per.starts;
    const ends = e || per.ends;
    if (starts && ends && ends <= starts) return err('結束要晚於開始');
    await db.prepare(`UPDATE f1_assignments SET status = 'active', starts_at = ?, ends_at = ?, note = coalesce(?, note), updated_at = ? WHERE id = ? AND status IN ${RESELL_ACTIVE}`)
      .bind(starts || null, ends || null, note, now, id).run();
    await resellLog(db, { kind: 'activate', account_id: a.account_id, order_no: a.order_no, cust_acct: a.cust_acct });
    await resellMarkLineDone(env, a, now);
    return json({ ok: true, id, starts_at: starts || null, ends_at: ends || null });
  }
  if (action === 'end' || action === 'revoke' || action === 'cancel') {
    if (!open) return err('這筆已經結束');
    if (action === 'end' && a.status !== 'active') return err('還沒開通的請用「取消」');
    const st = { end: 'ended', revoke: 'revoked', cancel: 'cancelled' }[action];
    await resellClose(db, id, st, note);
    await resellLog(db, { kind: action === 'revoke' ? 'violation' : action, account_id: a.account_id, order_no: a.order_no,
      cust_acct: a.cust_acct, detail: note || '' });
    return json({ ok: true, id, status: st });
  }
  if (action === 'unassign') {
    if (a.status !== 'pending' || !a.account_id) return err('只有「待處理且已指派」的可以取消指派');
    const stmts = [db.prepare('UPDATE f1_assignments SET account_id = NULL, seat_no = NULL, updated_at = ? WHERE id = ?').bind(now, id)];
    if (a.mode === 'ours') stmts.push(db.prepare("UPDATE f1_accounts SET status = 'available', updated_at = ? WHERE id = ? AND status = 'assigned'").bind(now, a.account_id));
    if (a.mode === 'shared') stmts.push(db.prepare('DELETE FROM f1_seats WHERE assignment_id = ?').bind(id));
    await db.batch(stmts);
    await resellLog(db, { kind: 'unassign', account_id: a.account_id, order_no: a.order_no, cust_acct: a.cust_acct });
    return json({ ok: true, id });
  }
  if (action === 'note') {
    await db.prepare('UPDATE f1_assignments SET note = ?, updated_at = ? WHERE id = ?').bind(note, now, id).run();
    return json({ ok: true, id });
  }
  return err('不認得的動作');
}

async function handleResellSync(env) {
  if (!resellDb(env)) return resellNoDb();
  return json(Object.assign({ ok: true }, await resellSyncAll(env)));
}

async function handleResellSettings(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  if (!b || typeof b.sharedCap !== 'boolean') return err('要給 sharedCap: true／false');
  await db.prepare('INSERT INTO f1_settings (key, value, updated_at) VALUES (?, ?, ?)'
    + ' ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind('shared_cap', b.sharedCap ? 'on' : 'off', nowSec()).run();
  await resellLog(db, { kind: 'setting', detail: `共用帳號席次上限 ${b.sharedCap ? '開' : '關'}` });
  return json({ ok: true, sharedCap: b.sharedCap });
}

/** 訂單上的「代訂待處理」跟著結案（後台訂單分頁的徽章、每日彙報都看它）。 */
async function resellMarkLineDone(env, a, now) {
  try {
    const o = await readOrder(env, a.order_no);
    if (o && Array.isArray(o.services) && o.services[a.line_idx] && o.services[a.line_idx].status !== 'done') {
      const sv = o.services.slice();
      sv[a.line_idx] = Object.assign({}, sv[a.line_idx], { status: 'done', doneAt: now });
      await patchOrder(env, a.order_no, { services: sv });
    }
  } catch (x) { /* 訂單徽章晚一點更新不影響開通 */ }
}

// ---------------------------------------------------------------------------
// 代理商交付（2026-10-23，backend v5.61）
//
// Ray：「我目前就先暫時用跟代理商訂購帳號」「購買後在網站內的我的帳號內交給買家 同時也要寄信」。
// 後台在一筆待處理的指派上填代理商給的帳密 → 一個動作完成：進庫存（加密）、綁訂單、開通、寄通知信。
//
// ⚠️ **信裡沒有密碼**（RESELL-OPS 3.2）：只說「請登入我的帳號查看」。密碼只在客戶登入後按「顯示」時解密，每次都記一筆。
// ⚠️ 共用（單一比賽週末）**週五 00:00（台灣）才出現在帳號頁**，不提早；正賽後 3 小時起不再顯示，排程清掉密文。
// ⚠️ 充值（年方案，客戶自己的帳號）沒有帳密可交付——代理商加值完照舊按「開通」。
// ---------------------------------------------------------------------------
const RESELL_SHARE = ['solo', '3', '6', 'weekend', 'topup'];
const RESELL_AGENT_REGION = 'XX';            // 代理商帳號沒有我們的採購區（ISO 3166 的「使用者自訂」碼）

async function handleResellDeliver(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  const id = Number(b && b.id);
  if (!Number.isInteger(id) || id <= 0) return err('id 不對');
  const a = await db.prepare('SELECT * FROM f1_assignments WHERE id = ?').bind(id).first();
  if (!a) return err('查無此指派', 404);
  if (a.mode === 'byo') return err('自備帳號（充值）沒有帳密可交付：代理商加值到客戶自己的帳號後，按「開通」即可');
  if (!['pending', 'active'].includes(a.status)) return err('這筆已經結束，不能再交付');
  if (a.account_id) return err('已經有帳號了；要換帳號請先「取消指派」或修改那個帳號的密碼');
  const tier = (PLANS[a.plan_key] || {}).f1Tier || 'premium';

  const loginEmail = accountKey(b.login_email);
  if (!looksLikeEmail(loginEmail)) return err('登入信箱格式不對');
  const pw = b.password == null ? '' : String(b.password);
  if (pw.length < 4 || pw.length > 200) return err('請填代理商給的密碼');
  const share = String(b.share || (a.mode === 'shared' ? 'weekend' : 'solo'));
  if (!RESELL_SHARE.includes(share) || share === 'topup') return err('帳號型態不對');
  const agentSku = resellStr(b.agent_sku, 80);
  const costTwd = b.cost_twd == null || b.cost_twd === '' ? null : Number(b.cost_twd);
  if (costTwd != null && !(Number.isFinite(costTwd) && costTwd > 0 && costTwd <= 100000)) return err('台幣成本不對');
  const costCny = b.cost_cny == null || b.cost_cny === '' ? null : Number(b.cost_cny);
  if (costCny != null && !(Number.isFinite(costCny) && costCny > 0 && costCny <= 100000)) return err('人民幣成本不對');

  const existing = await db.prepare('SELECT id, source, tier FROM f1_accounts WHERE login_email = ?').bind(loginEmail).first();
  if (existing && existing.source !== 'agent') return err('這個信箱是我們自營的帳號，不能當成代理商帳號交付');
  if (existing && existing.tier !== tier) return err(`這筆訂單要 ${tier === 'premium' ? 'Premium' : 'Pro'}，這個帳號記的是 ${existing.tier === 'premium' ? 'Premium' : 'Pro'}`);
  const pwEnc = await resellSeal(env, pw, loginEmail);
  if (!pwEnc) return err('RESELL_KEY 未設定或格式不對，不能存密碼（不會改存明文）', 503);

  const now = nowSec();
  const per = resellPeriod(a, null);
  let accId = existing && existing.id;
  if (existing) {
    // 合用帳號：代理商可能把同一個帳號給我們好幾位客戶。密碼以最新的為準（舊的那位也一起看到新密碼）。
    await db.prepare("UPDATE f1_accounts SET pw_enc = ?, pw_set_at = ?, agent_sku = coalesce(?, agent_sku), share = ?, status = 'assigned', updated_at = ? WHERE id = ?")
      .bind(pwEnc, now, agentSku, share, now, accId).run();
  } else {
    const r = await db.prepare('INSERT INTO f1_accounts (login_email, region, tier, billing, status, renews_at, auto_renew, source, agent_sku, share,'
      + " pw_enc, pw_set_at, note, created_at, updated_at) VALUES (?, ?, ?, ?, 'assigned', ?, 0, 'agent', ?, ?, ?, ?, ?, ?, ?)")
      .bind(loginEmail, RESELL_AGENT_REGION, tier, Number(a.months) >= 12 ? 'annual' : 'monthly', per.ends || null,
        agentSku, share, pwEnc, now, resellStr(b.note, 1000), now, now)
      .run();
    accId = r.meta && r.meta.last_row_id;
  }
  let bound;
  try {
    bound = await db.prepare('UPDATE f1_assignments SET account_id = ?, status = \'active\', starts_at = ?, ends_at = ?, delivered_at = ?, updated_at = ?'
      + ` WHERE id = ? AND account_id IS NULL AND status IN ${RESELL_ACTIVE}`)
      .bind(accId, per.starts || now, per.ends || null, now, now, id).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return err('這個帳號正被另一筆專屬（一個月）訂單使用中', 409);
    throw e;
  }
  if (!(bound.meta && bound.meta.changes === 1)) return err('這筆指派剛被別人處理過，請重新整理', 409);
  await resellLog(db, { kind: 'deliver', account_id: accId, order_no: a.order_no, cust_acct: a.cust_acct,
    detail: `代理商・${share}` + (agentSku ? `・${agentSku}` : '') });
  await resellLog(db, { kind: 'pw_set', account_id: accId });
  if (costTwd) {
    await db.prepare('INSERT INTO f1_costs (account_id, period_from, period_until, amount_local, currency, amount_twd, paid_at, note, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(accId, per.starts || now, per.ends || now + 1, costCny, costCny ? 'CNY' : null, Math.round(costTwd), now,
        `訂單 ${a.order_no}`, now).run();
    await resellLog(db, { kind: 'cost_add', account_id: accId, order_no: a.order_no, detail: `NT$${Math.round(costTwd)}` + (costCny ? ` (${costCny} CNY)` : '') });
  }
  await resellMarkLineDone(env, a, now);

  // 寄信失敗不回滾交付：帳號頁照樣看得到，後台顯示「信沒寄出」可以重寄
  let mail;
  try { mail = await sendF1ReadyMail(env, a.cust_acct, { plan: (PLANS[a.plan_key] || {}).label || a.plan_key, mode: a.mode, starts: per.starts, ends: per.ends, gp: a.gp_id }); } catch (e) { mail = { ok: false, reason: String((e && e.message) || e).slice(0, 80) }; }
  const mailStatus = mail.ok ? 'sent' : (mail.reason || 'failed');
  await db.prepare('UPDATE f1_assignments SET mail_status = ? WHERE id = ?').bind(mailStatus, id).run();
  return json({ ok: true, id, account_id: accId, starts_at: per.starts || now, ends_at: per.ends || null, mail: mailStatus });
}

/** 重寄交付通知（第一次沒寄出、或客戶說沒收到）。 */
async function handleResellRemail(request, env) {
  const db = resellDb(env);
  if (!db) return resellNoDb();
  const b = await request.json().catch(() => null);
  const id = Number(b && b.id);
  if (!Number.isInteger(id) || id <= 0) return err('id 不對');
  const a = await db.prepare('SELECT * FROM f1_assignments WHERE id = ?').bind(id).first();
  if (!a) return err('查無此指派', 404);
  if (a.status !== 'active' || !a.delivered_at) return err('這筆還沒交付，或已經結束');
  let mail;
  try { mail = await sendF1ReadyMail(env, a.cust_acct, { plan: (PLANS[a.plan_key] || {}).label || a.plan_key, mode: a.mode, starts: a.starts_at, ends: a.ends_at, gp: a.gp_id }); } catch (e) { mail = { ok: false, reason: String((e && e.message) || e).slice(0, 80) }; }
  const mailStatus = mail.ok ? 'sent' : (mail.reason || 'failed');
  await db.prepare('UPDATE f1_assignments SET mail_status = ? WHERE id = ?').bind(mailStatus, id).run();
  await resellLog(db, { kind: 'remail', account_id: a.account_id, order_no: a.order_no, cust_acct: a.cust_acct, detail: mailStatus });
  return json({ ok: true, id, mail: mailStatus });
}

/** 交付通知信。**沒有密碼、沒有連結參數**（RESELL-OPS 3.2）。 */
/** 交付通知的標題與 HTML。文字可在後台改（MAIL_DEFS.f1ready），「何時看得到帳密」是 {{access}} 區塊。 */
async function buildF1ReadyMail(env, to, info, ov) {
  const day = (s) => (s ? new Date(s * 1000).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit',
  }) : '—');
  const g = info.gp ? gpById(info.gp) : null;
  const later = info.mode === 'shared' && info.starts && info.starts > nowSec();
  const access = later
    ? `<p>帳號與密碼將於 <b>${esc(day(info.starts))}（台灣時間）</b> 起出現在「我的帳號」頁，屆時請登入查看。</p>`
    : '<p>請登入「我的帳號」查看 F1TV 的登入信箱與密碼。</p>';
  const m = await composeMail(env, 'f1ready', {
    email: to, plan: info.plan, gp: g ? `（${g.label || g.name}）` : '', from: day(info.starts), until: day(info.ends),
  }, ov, { access });
  return { subject: m.subject, html: mailShell(m.title, m.bodyHtml, {
    site: m.site, why: '這是您在 PitLingo 購買的 F1TV 代訂服務的交付通知' }) };
}

async function sendF1ReadyMail(env, to, info) {
  if (!mailConfigured(env) || !to) return { ok: false, reason: 'not_configured' };
  const m = await buildF1ReadyMail(env, to, info);
  const r = await sendMail(env, { to: [to], subject: m.subject, html: m.html });
  return { ok: r.ok, reason: r.ok ? '' : r.status };
}

/**
 * 「我的帳號」頁的 F1TV 代訂區塊。**不帶密碼**——密碼只走 customerF1Reveal。
 * login_email 也只在使用期間內給（共用帳號週五 00:00 前看不到）。
 */
async function customerF1(env, emails) {
  const db = resellDb(env);
  const accts = [...new Set((emails || []).map(accountKey).filter((x) => x && x.includes('@')))].slice(0, 10);
  if (!db || !accts.length) return [];
  const now = nowSec();
  const r = await db.prepare(`SELECT a.id, a.plan_key, a.mode, a.status, a.gp_id, a.starts_at, a.ends_at, a.delivered_at, f.login_email`
    + ` FROM f1_assignments a LEFT JOIN f1_accounts f ON f.id = a.account_id`
    + ` WHERE a.cust_acct IN (${accts.map(() => '?').join(', ')}) AND (a.status IN ${RESELL_ACTIVE} OR a.updated_at > ?)`
    + ' ORDER BY a.created_at DESC LIMIT 20').bind(...accts, now - 30 * 86400).all();
  return (r.results || []).map((x) => {
    const g = x.gp_id ? gpById(x.gp_id) : null;
    const inWindow = x.status === 'active' && (!x.starts_at || now >= x.starts_at) && (!x.ends_at || now < x.ends_at);
    const canShow = inWindow && x.mode !== 'byo' && !!x.login_email;
    return {
      id: x.id,
      planLabel: (PLANS[x.plan_key] || {}).label || x.plan_key,
      mode: x.mode,
      gpLabel: g ? (g.label || g.name) : null,
      // pending 處理中 / scheduled 已交付、還沒到開始時間 / ready 可以看 / ended 已結束
      state: x.status === 'pending' ? 'pending'
        : x.status !== 'active' || (x.ends_at && now >= x.ends_at) ? 'ended'
          : (x.starts_at && now < x.starts_at) ? 'scheduled' : 'ready',
      startsAt: x.starts_at || null,
      endsAt: x.ends_at || null,
      loginEmail: canShow ? x.login_email : null,
      canReveal: canShow,
    };
  });
}

/** 客戶在「我的帳號」按「顯示密碼」。**每一次都記一筆**（RESELL-OPS 3.2 第 3 條），記不下來就不給。 */
async function customerF1Reveal(env, emails, id, ua) {
  const db = resellDb(env);
  if (!db) return { status: 503, body: { ok: false, error: '暫時無法使用' } };
  const accts = [...new Set((emails || []).map(accountKey).filter((x) => x && x.includes('@')))].slice(0, 10);
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0 || !accts.length) return { status: 400, body: { ok: false, error: 'id 不對' } };
  const a = await db.prepare(`SELECT * FROM f1_assignments WHERE id = ? AND cust_acct IN (${accts.map(() => '?').join(', ')})`).bind(n, ...accts).first();
  // 別人的指派與不存在的指派回同一句——不讓人用 id 探測別人有沒有買
  if (!a) return { status: 404, body: { ok: false, error: '查無此項目' } };
  const now = nowSec();
  if (a.status !== 'active' || a.mode === 'byo' || !a.account_id) return { status: 409, body: { ok: false, error: '這個項目目前沒有可顯示的帳號' } };
  if (a.starts_at && now < a.starts_at) return { status: 409, body: { ok: false, error: '還沒到使用時間' } };
  if (a.ends_at && now >= a.ends_at) return { status: 409, body: { ok: false, error: '使用期間已結束' } };
  const row = await db.prepare('SELECT login_email, pw_enc FROM f1_accounts WHERE id = ?').bind(a.account_id).first();
  if (!row || !row.pw_enc) return { status: 409, body: { ok: false, error: '帳號資料更新中，請稍後再試或聯絡我們' } };
  let password;
  try { password = await resellOpen(env, row.pw_enc, row.login_email); } catch (e) {
    await resellLog(db, { actor: 'customer', kind: 'pw_reveal_fail', account_id: a.account_id, order_no: a.order_no, cust_acct: a.cust_acct });
    return { status: 500, body: { ok: false, error: '暫時無法顯示，請聯絡我們' } };
  }
  const device = /Mobile|Android|iPhone|iPad/i.test(String(ua || '')) ? '行動裝置' : '電腦';
  await resellLog(db, { actor: 'customer', kind: 'cust_reveal', account_id: a.account_id, order_no: a.order_no, cust_acct: a.cust_acct, detail: device });
  return { status: 200, body: { ok: true, id: n, loginEmail: row.login_email, password } };
}

/** 排程：過了使用期間的指派收尾（代理商帳號順便清掉密文）。一天一次，一次最多 100 筆。 */
async function resellExpire(env) {
  const db = resellDb(env);
  if (!db) return 0;
  const r = await db.prepare("SELECT id FROM f1_assignments WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ? LIMIT 100")
    .bind(nowSec()).all();
  let n = 0;
  for (const x of r.results || []) {
    const a = await resellClose(db, x.id, 'ended', '使用期間結束（排程）');
    if (a) { n++; await resellLog(db, { actor: 'system', kind: 'end', account_id: a.account_id, order_no: a.order_no, cust_acct: a.cust_acct }); }
  }
  return n;
}

/** 總覽要加的第 2 階段資料：指派、各場次的席次、設定。 */
async function resellOverviewExtra(db) {
  const now = nowSec();
  const [asg, seats, holds, pool, cap] = await db.batch([
    db.prepare(`SELECT a.*, f.login_email FROM f1_assignments a LEFT JOIN f1_accounts f ON f.id = a.account_id
      WHERE a.status IN ${RESELL_ACTIVE} OR a.updated_at > ? ORDER BY a.status = 'pending' DESC, a.created_at DESC LIMIT 300`).bind(now - 30 * 86400),
    db.prepare(`SELECT gp_id, COUNT(*) AS used FROM f1_assignments WHERE mode = 'shared' AND status IN ${RESELL_ACTIVE} AND gp_id IS NOT NULL GROUP BY gp_id`),
    db.prepare('SELECT h.gp_id, COUNT(*) AS n FROM f1_holds h WHERE h.expires_at > ? AND NOT EXISTS (SELECT 1 FROM f1_assignments x WHERE x.order_no = h.order_no) GROUP BY h.gp_id').bind(now),
    db.prepare("SELECT COUNT(*) AS n FROM f1_accounts WHERE status = 'shared' AND tier = 'premium'"),
    db.prepare("SELECT value FROM f1_settings WHERE key = 'shared_cap'"),
  ]);
  const holdBy = {};
  for (const h of holds.results || []) holdBy[h.gp_id] = h.n;
  const poolN = ((pool.results || [])[0] || {}).n || 0;
  const gps = new Set([...(seats.results || []).map((x) => x.gp_id), ...Object.keys(holdBy)]);
  const usedBy = {};
  for (const x of seats.results || []) usedBy[x.gp_id] = x.used;
  return {
    assignments: (asg.results || []).map((x) => Object.assign({}, x, {
      planLabel: (PLANS[x.plan_key] || {}).label || x.plan_key,
      tier: (PLANS[x.plan_key] || {}).f1Tier || 'premium',   // 後台挑帳號用；由方案決定，前端不猜
      gpLabel: x.gp_id && gpById(x.gp_id) ? (gpById(x.gp_id).label || gpById(x.gp_id).name) : null,
    })),
    seatsByGp: [...gps].map((g) => ({
      gp_id: g, label: gpById(g) ? (gpById(g).label || gpById(g).name) : g,
      used: usedBy[g] || 0, holds: holdBy[g] || 0, capacity: poolN * RESELL_SEATS,
    })),
    sharedPool: { accounts: poolN, seatsPerAccount: RESELL_SEATS },
    settings: { sharedCap: (((cap.results || [])[0]) || {}).value === 'on' },
  };
}

/** 管理端路由。權限已在外層驗過，這裡只管分派。 */
async function routeAdmin(path, request, env, url) {
  const m = request.method;

  if (path === '/v1/admin/license/issue' && m === 'POST') return handleLicenseIssue(request, env);
  if (path === '/v1/admin/plans' && m === 'GET') return handleAdminPlans(env);
  // 遠端設定的現況（後台「營運設定 → 遠端設定」用）。
  // ⚠️ 公開的 GET /v1/config 分不出「內建」與「KV 裡一份一模一樣的熱修版」，
  //    而這個差別很重要：**KV 熱修版會蓋過之後每一次部署的內建設定**
  //    （賽程、免費範圍都在裡面）——修完忘了還原，下一次改賽程就永遠到不了使用者。
  if (path === '/v1/admin/config' && m === 'GET') {
    let kv = null, prev = false;
    try { kv = JSON.parse((await env.SUBS.get('config')) || 'null'); } catch (e) { kv = { _broken: true }; }
    try { prev = !!(await env.SUBS.get('config:prev')); } catch (e) { prev = false; }
    return json({
      ok: true,
      active: kv ? 'kv' : 'builtin',
      builtinVersion: REMOTE_CONFIG.version,
      kvVersion: kv && !kv._broken ? kv.version : null,
      hasPrev: prev,
      effective: kv && !kv._broken ? kv : REMOTE_CONFIG,
    });
  }
  // 賽事資料。**與商品分開**：這裡只管賽事時間，商品綁的是 gpId。
  if (path === '/v1/admin/schedule' && m === 'GET') {
    const meta = await scheduleMeta(env);
    return json({
      ok: true,
      source: meta.source,
      syncedAt: meta.at,
      configured: !!env.SCHEDULE_URL,
      season: SEASON_YEAR,
      races: gpList().map((g) => gpProduct(g, Date.now())),
    });
  }
  if (path === '/v1/admin/schedule/sync' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    return json(Object.assign({ ok: false }, await syncSchedule(env, !!(b && b.force))));
  }
  if (path === '/v1/admin/account' && m === 'GET') return handleAccount(env, url);
  // 代訂自營（RESELL-OPS 第 7 節，D1）與全域查詢
  if (path === '/v1/admin/search' && m === 'GET') return handleAdminSearch(env, url);
  if (path === '/v1/admin/ledger' && m === 'GET') return handleLedger(env, url);
  if (path === '/v1/admin/ledger/entry' && m === 'POST') return handleLedgerEntry(request, env);
  if (path === '/v1/admin/ledger/void' && m === 'POST') return handleLedgerVoid(request, env);
  if (path === '/v1/admin/ledger/fee' && m === 'POST') return handleLedgerFee(request, env);
  if (path === '/v1/admin/resell' && m === 'GET') return handleResellOverview(env);
  if (path === '/v1/admin/resell/account' && m === 'POST') return handleResellAccountSave(request, env);
  if (path === '/v1/admin/resell/reveal' && m === 'POST') return handleResellReveal(request, env);
  if (path === '/v1/admin/resell/cost' && m === 'POST') return handleResellCostAdd(request, env);
  if (path === '/v1/admin/resell/region' && m === 'POST') return handleResellRegionSave(request, env);
  if (path === '/v1/admin/resell/events' && m === 'GET') return handleResellEvents(env, url);
  if (path === '/v1/admin/resell/sync' && m === 'POST') return handleResellSync(env);
  if (path === '/v1/admin/resell/assign' && m === 'POST') return handleResellAssign(request, env);
  if (path === '/v1/admin/resell/assignment' && m === 'POST') return handleResellAssignmentAction(request, env);
  if (path === '/v1/admin/resell/settings' && m === 'POST') return handleResellSettings(request, env);
  if (path === '/v1/admin/resell/deliver' && m === 'POST') return handleResellDeliver(request, env);
  if (path === '/v1/admin/resell/remail' && m === 'POST') return handleResellRemail(request, env);
  if (path === '/v1/admin/econ' && m === 'GET') {
    return handleEcon(env, url);
  }
  if (path === '/v1/admin/users' && m === 'GET') {
    return handleUserStats(env, url);
  }
  // 代碼表。後台照著顯示，不必自己抄一份（抄了就會漂）。
  if (path === '/v1/admin/codes' && m === 'GET') return json({ ok: true, codes: ERR_CODES });
  // 逐句紀錄（2026-10-31）：一支影片在一段時間內每一句的去向、誰花錢翻了、重複翻了幾次（逐句比對，不是推算）。
  // ?cid=<影片編號>&from=<毫秒>&to=<毫秒>&dump=1（dump 附上原始紀錄）。讀 DO，不碰 KV
  if (path === '/v1/admin/linelog' && m === 'GET') {
    const cid = String(url.searchParams.get('cid') || '').trim();
    if (!/^\d{1,20}$/.test(cid)) return err('cid 格式不正確', 400, 'E10');
    const r = await roomOp(env, cid, { op: 'plogSum', from: Number(url.searchParams.get('from')) || 0, to: Number(url.searchParams.get('to')) || 0, dump: url.searchParams.get('dump') === '1' });
    return json(Object.assign({ ok: !!r && !r.error, cid }, r || { error: 'room unavailable' }));
  }
  // 單一影片的完整譯文。用途有二：後台抽查翻譯品質、以及 tools/fetch-fixtures.js
  // 抓固定測試資料。**不做分頁**——一支影片最多 BUNDLE_MAX_LINES 句，回得完。
  // 掃出可疑譯文。**守門是後來才收緊的，之前放行的東西還躺在快取裡**，
  // 而共用快取是所有人共用的——一句垃圾會顯示給每一個看那支影片的人。
  if (path === '/v1/admin/bundle/suspect' && m === 'GET') {
    const cid = String(url.searchParams.get('cid') || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(cid)) return err('cid 格式不正確', 400, 'E10');
    const b = await readBundle(env, cid);
    const bad = [];
    for (const [en, zh] of Object.entries(b.lines || {})) {
      if (!plausibleTranslation(en, zh)) bad.push({ en, zh });
      if (bad.length >= 200) break;
    }
    // 譯文錯開一格（2026-11-05）：另列，因為寬鬆偵測約一半是跨行句（意思沒錯）——只適合刪了重翻
    const en = Object.keys(b.lines || {});
    const zh = en.map((k) => String(b.lines[k]));
    const shifted = shiftSuspectIdx(en, zh).slice(0, 200).map((i) => ({ en: en[i], zh: zh[i], next: en[i + 1] }));
    return json({ ok: true, cid, slug: b.slug || '', total: en.length, bad, shifted });
  }

  // 刪掉疑似「拿到後一句譯文」的句子（2026-11-05，Ray：「做1跟2」）。伺服器當場讀最新的 bundle 判斷，
  // 不收用戶端給的鍵；dry=1 只回會刪哪些。刪掉的句子下次有人看時重翻（翻譯端已有錯開防線）。
  // ⚠️ 讀→改→寫沒有 CAS（坑 #24），與 bundle/purge 同樣只做刪除，最壞是漏刪幾句。
  if (path === '/v1/admin/bundle/realign' && m === 'POST') {
    const b0 = await request.json().catch(() => null);
    const cid = String((b0 && b0.cid) || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(cid)) return err('cid 格式不正確', 400, 'E10');
    const b = await readBundle(env, cid);
    const en = Object.keys(b.lines || {});
    const zh = en.map((k) => String(b.lines[k]));
    const idx = shiftSuspectIdx(en, zh);
    const sample = idx.slice(0, 5).map((i) => ({ en: en[i], zh: zh[i] }));
    if (b0.dry || !idx.length) return json({ ok: true, cid, dry: !!b0.dry, found: idx.length, removed: 0, sample });
    for (const i of idx) delete b.lines[en[i]];
    await writeBundle(env, cid, b);
    return json({ ok: true, cid, found: idx.length, removed: idx.length, left: Object.keys(b.lines).length, sample });
  }

  // 刪掉指定的幾句。**只刪不改**——改譯文等於用後台繞過模型，
  // 那條路一開，快取裡就會混進沒有經過任何驗證的內容。
  if (path === '/v1/admin/bundle/purge' && m === 'POST') {
    const b0 = await request.json().catch(() => null);
    const cid = String((b0 && b0.cid) || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(cid)) return err('cid 格式不正確', 400, 'E10');
    const keys = Array.isArray(b0.keys) ? b0.keys : [];
    if (!keys.length) return err('沒有指定要刪除的句子');
    // ⚠️ 讀→改→寫在 KV 上沒有 CAS（坑 #24）。這是後台的低頻操作，
    //    而且只做刪除，最壞的結果是與同時發生的寫入互相覆蓋掉一部分——
    //    下一次掃描還是抓得到，不會造成資料損毀。
    const b = await readBundle(env, cid);
    let n = 0;
    for (const k of keys) {
      const nk = normKey(k);
      if (b.lines && b.lines[nk] !== undefined) { delete b.lines[nk]; n++; }
      if (b.lines && b.lines[k] !== undefined) { delete b.lines[k]; n++; }
    }
    await writeBundle(env, cid, b);
    return json({ ok: true, cid, removed: n, left: Object.keys(b.lines || {}).length });
  }

  /**
   * 整份刪掉一個 bundle。**只刪空的。**
   *
   * 起因（2026-09-18）：後台 R14 底下多了 9 筆 `conctest-…`、`urgtest-…`、`load100-…`
   * 之類的紀錄，每一筆 0 句、slug 都是 `2026-madrid-gp-practice-1`——
   * 那是早期用線上後端做壓測時留下的假 contentId（坑 #53 修掉來源之後仍留在 KV 裡）。
   * 它們會混進翻譯清單、被算進「幾支影片」，讓人以為那一站有 18 支。
   *
   * ⚠️ **有句子的一律拒絕。** 整份刪除不可逆，而「一句都沒有」是唯一能確定
   *    不會弄丟任何譯文的情況。要刪個別句子請用 `bundle/purge`。
   */
  if (path === '/v1/admin/bundle/drop' && m === 'POST') {
    const b0 = await request.json().catch(() => null);
    const cid = String((b0 && b0.cid) || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(cid)) return err('cid 格式不正確', 400, 'E10');
    const b = await readBundle(env, cid);
    const n = Object.keys((b && b.lines) || {}).length;
    if (n > 0) return err(`這一份有 ${n} 句譯文，不能整份刪除（要刪個別句子請用 bundle/purge）`);
    invalidateBundleMeta();      // 刪掉一支之後，後台的清單不可以還列著它
    await env.SUBS.delete(bundleKey(cid));
    return json({ ok: true, cid, deleted: true });
  }

  /**
   * 撤銷一支影片的完整標記，讓它回到收割佇列重新驗證。
   *
   * ⚠️ **譯文一句都不動**，只把 segCount 歸零。重收時已翻過的句子直接從共用快取拿（免費），
   *    真的缺的才會翻——所以「重新驗證」本身就能證明它原本到底缺不缺：
   *    重收之後句數沒變，就代表那支影片本來就這麼安靜，新版蓋章之後不再列為可疑。
   *
   * 撤銷到重收之間，看這支影片的人會重新走整軌預抓（補齊缺句），不會少看到字幕。
   */
  if (path === '/v1/admin/bundle/unmark' && m === 'POST') {
    const b0 = await request.json().catch(() => null);
    const cid = String((b0 && b0.cid) || '').trim();
    if (!/^\d{1,20}$/.test(cid)) return err('cid 格式不正確', 400, 'E10');
    const b = await readBundle(env, cid);
    if (!(b.segCount > 0)) return json({ ok: true, cid, unchanged: true });
    const was = b.segCount;
    b.segCount = 0;
    b.markV = '';
    await writeBundle(env, cid, b);
    return json({ ok: true, cid, was, lines: Object.keys(b.lines || {}).length });
  }

  if (path === '/v1/admin/bundle' && m === 'GET') {
    const cid = String(url.searchParams.get('cid') || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(cid)) return err('cid 格式不正確', 400, 'E10');
    const b = await readBundle(env, cid);
    return json({
      ok: true, cid, slug: b.slug || '', segCount: b.segCount || 0,
      count: Object.keys(b.lines || {}).length, lines: b.lines || {},
      // 每句在影片裡的秒數（2026-11-06 起收割過的影片才有；後台依它排序並顯示時間）
      t: (b.t && typeof b.t === 'object') ? b.t : {},
    });
  }
  if (path === '/v1/admin/orders' && m === 'GET') return handleOrderList(env, url);
  if (path === '/v1/admin/orders/get' && m === 'GET') return handleOrderGet(env, url);
  if (path === '/v1/admin/orders/patch' && m === 'POST') return handleOrderPatch(request, env);
  if (path === '/v1/admin/orders/repair-paid' && m === 'POST') return handleOrderRepairPaid(request, env);
  // license/revoke 與 license/lookup 已由 license/patch（revoked 欄位）與
  // license/list（?q= 可搜 email）取代。**同一件事不留兩種做法**——
  // 後台只會用其中一條，另一條遲早會漂掉而沒人發現。
  if (path === '/v1/admin/license/list' && m === 'GET') return handleLicenseList(request, env, url);
  if (path === '/v1/admin/license/patch' && m === 'POST') return handleLicensePatch(request, env);
  if (path === '/v1/admin/license/delete' && m === 'POST') return handleLicenseDelete(request, env);
  if (path === '/v1/admin/license/reissue' && m === 'POST') return handleAdminReissue(request, env);
  if (path === '/v1/admin/reports/patch' && m === 'POST') return handleReportPatch(request, env);
  if (path === '/v1/admin/reports' && m === 'GET') return handleReportList(env, url);
  if (path === '/v1/admin/metrics' && m === 'GET') {
    try { await flushMetrics(env); } catch (e) { /* 先落地再讀 */ }
    return handleMetrics(env, url);
  }

  // 成長統計：註冊／購買／使用事件，從某一天起算（預設 2026-11-03）。只讀不寫，快取 5 分鐘
  if (path === '/v1/admin/growth' && m === 'GET') return handleGrowth(env, url);

  if (path === '/v1/admin/stats' && m === 'GET') {
    return handleStats(env, url);
  }

  // 撤銷某個安裝（濫用、盜用時用；退款請用 license/revoke）
  if (path === '/v1/admin/revoke' && m === 'POST') {
    const b = await request.json().catch(() => null);
    const id = b && String(b.installId || '').trim();
    if (!id) return err('缺少 installId');
    let list = [];
    try { list = JSON.parse((await env.SUBS.get('revoked')) || '[]'); } catch (e) { /* noop */ }
    if (!list.includes(id)) list.push(id);
    await env.SUBS.put('revoked', JSON.stringify(list));
    revCache = { at: 0, set: null };       // 立刻讓快取失效
    return json({ ok: true, revoked: list.length });
  }

  return null;
}

