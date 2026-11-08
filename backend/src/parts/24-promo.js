// =====================================================================
// 折扣與促銷（2026-10-26 Ray 決定，BUSINESS.md 第 0 節）
//
//   限時活動：後台設定期間與折數，到期自動恢復原價
//   續訂折扣：買過賽季通行證的帳號，買下一季 9 折
//
// ⚠️ **只限通行證**（比賽週／本季／下一季）。代訂利潤薄，不參與；
//    早鳥本身就是最低價，**不再疊任何折扣**。
// ⚠️ **兩種折扣不疊加，只取比較便宜的那一個**（疊加規則待 Ray 再討論）。
// ⚠️ **放棄永久促銷**：活動最長 PROMO_MAX_DAYS 天，超過的設定一律不生效——
//    長期掛著「原價劃掉」有不實標示的風險，也會讓折扣失去意義。
// ⚠️ 折扣價用 floor 取整（鐵則 18）：599 × 0.9 = 539。
// =====================================================================
const PROMO_KEYS = ['week', 'season', 'season_next'];
const PROMO_MAX_DAYS = 31;
const PROMO_PCT_MIN = 50;      // 最多打 5 折——設錯成 0 折就是白送
const PROMO_PCT_MAX = 95;
const PROMO_THEMES = ['red', 'gold'];
const RENEW_PCT = 90;          // 老客戶續訂 9 折
// 2026-10-30 Ray：「這個先不用 先移除」——續訂折扣暫停：結帳不打折、購買頁與首頁不提示（/v1/plans 的 renewPct 回 null）。
// 程式與資格判斷都留著，要恢復只改這個值
const RENEW_ENABLED = false;
const RENEW_FROM_PLANS = new Set(['season', 'season_early', 'season_next']);

/** 驗證後台存的活動設定。不合格回 null（＝沒有活動），不會半套生效。 */
function normPromo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = Math.floor(Number(raw.from));
  const until = Math.floor(Number(raw.until));
  const pct = Math.round(Number(raw.pct));
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) return null;
  if (until - from > PROMO_MAX_DAYS * 86400) return null;
  if (!(pct >= PROMO_PCT_MIN && pct <= PROMO_PCT_MAX)) return null;
  const keys = (Array.isArray(raw.keys) ? raw.keys : []).filter((k) => PROMO_KEYS.includes(k));
  if (!keys.length) return null;
  const name = String(raw.name || '').trim().slice(0, 30);
  if (!name) return null;
  return {
    // id 決定「關掉公告後要不要再出現」——同一檔活動改文字不換 id
    id: String(raw.id || `${from}`).replace(/[^\w-]/g, '').slice(0, 40) || String(from),
    name,
    text: String(raw.text || '').trim().slice(0, 80),
    pct, keys, from, until,
    // 2026-10-26 Ray 看過紅／金兩種，選金色。紅色保留給後台個別選用
    theme: PROMO_THEMES.includes(raw.theme) ? raw.theme : 'gold',
  };
}

/** 此刻生效中的活動（沒有就 null）。 */
function promoActive(ops, now) {
  const p = ops && ops.promo;
  if (!p) return null;
  const t = Math.floor((now || Date.now()) / 1000);
  return (t >= p.from && t < p.until) ? p : null;
}

function pctPrice(list, pct) {
  return Math.floor(list * pct / 100);
}

/**
 * 一個商品此刻的折扣。回傳 { unit, promo } —— promo 為 null 代表照原價。
 * `key` 要傳**實際賣出的方案**（早鳥賣完時已經換成 season）。
 */
function discountFor(key, list, ops, renew, now) {
  if (!PROMO_KEYS.includes(key) || !(list > 0)) return { unit: list, promo: null };
  const opts = [];
  const c = promoActive(ops, now);
  if (c && c.keys.includes(key)) {
    opts.push({ unit: pctPrice(list, c.pct), promo: { kind: 'campaign', id: c.id, name: c.name, pct: c.pct, list, until: c.until } });
  }
  if (RENEW_ENABLED && renew && key === 'season_next') {
    opts.push({ unit: pctPrice(list, RENEW_PCT), promo: { kind: 'renew', name: '老客戶續訂價', pct: RENEW_PCT, list } });
  }
  if (!opts.length) return { unit: list, promo: null };
  opts.sort((a, b) => a.unit - b.unit);
  return opts[0].unit < list ? opts[0] : { unit: list, promo: null };
}

/**
 * 這些信箱有沒有買過賽季通行證（續訂折扣的資格）。
 * 只算**付了錢**的：客服補償、後台手動發的 0 元授權不算。
 */
async function renewEligible(env, emails) {
  for (const em of (emails || []).slice(0, 10)) {
    let keys = [];
    try { keys = JSON.parse((await env.SUBS.get(`licmail:${accountKey(em)}`)) || '[]'); } catch (e) { keys = []; }
    for (const k of keys.slice(0, 50)) {
      const lic = await readLicense(env, normLicense(k));
      if (lic && !lic.revoked && RENEW_FROM_PLANS.has(lic.plan) && (lic.paid || 0) > 0) return true;
    }
  }
  return false;
}

/**
 * 結帳／報價的續訂資格。**一定要登入，而且結帳信箱屬於這個帳號。**
 * 只憑 email 判斷的話，報價就變成「查任何人有沒有買過」的工具。
 */
/** 登入的帳號的信箱清單（網站 cookie 或擴充功能的權杖）；沒登入回 null。升級折抵用。
 * ⚠️ strict：折抵是錢，已撤銷的工作階段（登出所有裝置）要立刻失效，不能等快取過期。 */
async function accountEmailsOf(env, request) {
  try {
    const sess = await sessionOf(env, request, true);
    const acc = sess ? await readGoogleAccount(env, sess.sub) : null;
    return acc && Array.isArray(acc.emails) && acc.emails.length ? acc.emails.map((e) => accountKey(e)) : null;
  } catch (e) { return null; }
}

async function renewFor(env, request, email) {
  try {
    const sess = await sessionOf(env, request, false);
    if (!sess) return false;
    const acc = await readGoogleAccount(env, sess.sub);
    if (!acc) return false;
    const mine = (acc.emails || []).map((e) => accountKey(e));
    if (!email || !mine.includes(accountKey(email))) return false;
    return await renewEligible(env, [email]);
  } catch (e) { return false; }
}

