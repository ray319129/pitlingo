// ---------------------------------------------------------------------------
// 賽事資料的同步
// ---------------------------------------------------------------------------
/**
 * 賽程不能靠人工每週改。
 *
 * ⚠️ **但也不能無條件相信外部來源。** 來源改格式、被擋、回空、
 *    或回了一份殘缺的賽程時，若直接套用，整個購買頁會空掉或算出錯誤的效期——
 *    而那看起來像我們倒了。所以流程是：
 *
 *      抓 → **嚴格驗證** → 通過才寫進 KV → 沒通過就保留原狀並記錄原因
 *
 *    永遠有退路：KV 沒有可用資料時自動退回程式碼裡的內建賽程。
 *
 * ⚠️ **同步只覆蓋時間，不覆蓋價格與商品。** 商品綁的是 gpId，
 *    賽事時間變了效期自動跟著變，不需要動任何商品資料。
 */
const SCHED_MIN_RACES = 15;          // 一個賽季不可能少於這個數
const SCHED_MAX_RACES = 30;

/**
 * 驗證一份賽程。回傳 { ok, reason }。
 * **寧可拒絕一份看起來怪怪的賽程，也不要把它套上去。**
 */
function validateSchedule(races) {
  if (!Array.isArray(races)) return { ok: false, reason: '不是陣列' };
  if (races.length < SCHED_MIN_RACES) return { ok: false, reason: `只有 ${races.length} 站，太少` };
  if (races.length > SCHED_MAX_RACES) return { ok: false, reason: `有 ${races.length} 站，太多` };

  let prev = 0;
  for (const g of races) {
    if (!g || !g.name || !dayStartSec(g.start) || !dayStartSec(g.end)) {
      return { ok: false, reason: `${(g && g.name) || '某一站'} 缺少必要欄位` };
    }
    if (dayStartSec(g.end) < dayStartSec(g.start)) {
      return { ok: false, reason: `${g.name} 的結束日早於開始日` };
    }
    // ⚠️ **會被畫進網頁的字串欄位也要驗**（security-audit 2026-10-05 #9）。以前只驗日期與站數，
    //    flag／season／r 原封不動送到後台與購買頁的 innerHTML——後台沒有 CSP、記憶體裡有 ADMIN_TOKEN。
    //    外部賽程目前沒設（SCHEDULE_URL），這是縱深防禦：誰能改那份檔案，不該就能在後台執行程式。
    const unsafe = (v) => typeof v === 'string' && /[<>"'`&]/.test(v);
    if (['name', 'label', 'circuit', 'flag'].some((f) => unsafe(g[f]))) return { ok: false, reason: `${String(g.name).slice(0, 40)} 含有不允許的字元` };
    if (g.flag !== undefined && (typeof g.flag !== 'string' || g.flag.length > 16)) return { ok: false, reason: `${g.name} 的 flag 格式不對` };
    if (g.season !== undefined && !/^\d{4}$/.test(String(g.season))) return { ok: false, reason: `${g.name} 的 season 格式不對` };
    // 季前測試是第 0 輪（gpId「2027-00」）
    if (g.r !== undefined && !(Number.isInteger(Number(g.r)) && Number(g.r) >= (g.testing ? 0 : 1) && Number(g.r) <= 40)) return { ok: false, reason: `${g.name} 的輪次格式不對` };
    // 日期必須遞增。亂序會讓「下一場」算錯，而那直接決定效期。
    if (dayStartSec(g.start) < prev) return { ok: false, reason: `${g.name} 的日期沒有遞增` };
    prev = dayStartSec(g.start);
    // 場次時間必須落在比賽週內（前後各放寬一天，涵蓋時區）
    for (const s of g.sessions || []) {
      if (!s || !s.t) continue;
      // 場次名稱與種類也會顯示在頁面上（security-audit run-2 加固：以前只查了站名那幾個欄位）
      if (unsafe(s.n) || unsafe(s.k) || String(s.n || '').length > 40 || String(s.k || '').length > 20) {
        return { ok: false, reason: `${String(g.name).slice(0, 40)} 的場次名稱含有不允許的字元或太長` };
      }
      if (s.t < dayStartSec(g.start) - 86400 || s.t > dayStartSec(g.end) + 2 * 86400) {
        return { ok: false, reason: `${g.name} 的「${s.n || s.k}」時間落在比賽週之外` };
      }
    }
  }
  return { ok: true };
}

/**
 * 從外部來源同步賽程。
 *
 * env.SCHEDULE_URL 指向一份 JSON（格式與內建 schedule 相同）。
 * 沒設定時這支不做任何事——**不設定不是錯誤**，那代表你選擇手動維護。
 */
async function syncSchedule(env, force) {
  const url = env.SCHEDULE_URL;
  if (!url) return { ok: false, reason: 'SCHEDULE_URL 未設定（目前使用內建賽程）' };

  let races = null;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) return { ok: false, reason: `來源回 HTTP ${r.status}` };
    const d = await r.json();
    races = Array.isArray(d) ? d : (d && d.schedule) || (d && d.races) || null;
  } catch (e) {
    return { ok: false, reason: '抓不到來源：' + String((e && e.message) || e) };
  }

  const v = validateSchedule(races);
  if (!v.ok) return { ok: false, reason: '資料不合理，已保留原賽程：' + v.reason };

  // 內容沒變就不要寫。KV 寫入是這個專案的天花板（坑 #10）。
  const body = JSON.stringify({ source: 'sync', at: nowSec(), url, races });
  if (!force) {
    const cur = await env.SUBS.get(SCHED_KEY);
    if (cur) {
      try {
        const old = JSON.parse(cur);
        if (JSON.stringify(old.races) === JSON.stringify(races)) {
          return { ok: true, changed: false, races: races.length };
        }
      } catch (e) { /* 壞掉就覆蓋 */ }
    }
  }
  await env.SUBS.put(SCHED_KEY, body);
  schedCache = { at: 0, races: null };
  return { ok: true, changed: true, races: races.length };
}

