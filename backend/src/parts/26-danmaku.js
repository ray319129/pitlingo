// ---------------------------------------------------------------------------
// 彈幕（2026-10-28，handoff 9.1 #23）—— **已做好、尚未發行**
//
// Ray 的決定：先做出來，等人數上來、Ray 說要才推出；一次做到完整，以人多為前提設計；
// 未付費（含沒登入）看得到、不能發（2026-10-28 Ray，推翻同日的「免費試用不能用」）；不顯示任何身分；Haiku 自動審核是後台開關、預設關。
// 發行前的閘門是 ops.danmaku.on（預設 false）——關著時只有 ops.danmaku.allow 裡的信箱用得到。
// 擴充功能那一端只在測試版（測試標記包住），正式版沒有任何彈幕程式碼。
//
// ⚠️ **彈幕對齊影片時間軸（毫秒），不對齊現實時間。**
//    每則記「發在影片第幾毫秒」（播放器 `.tm-ui-seekbar` 的 aria-valuenow，鐵則 63）。
//    重播的人播到那裡才看到 → 不劇透；直播時發的彈幕留給之後每一位觀眾 → 人少也不冷清。
//
// ⚠️ **傳輸用 WebSocket＋Hibernation API**（官方文件 2026-10-28 查證）：
//    伺服器送出的訊息不計費、收到的訊息 20 則算 1 次請求、閒置的連線不計 duration。
//    輪詢每人每 5 秒一次＝100 人看 2 小時就 14 萬次請求，一場就超過免費方案一天的額度。
//    不用 Hibernation 的 accept() 會整條連線計 duration——**一定要用 ctx.acceptWebSocket**。
//
// ⚠️ **KV 一次都不寫彈幕。** 每則一寫就撞 1,000／天（鐵則 10）。全部進 DO 的 SQLite。
//    唯一的 KV 寫入是後台的禁言名單（人手操作，一天幾次）。
//
// 架構：
//   POST /v1/dm/ticket   （未發行時）白名單 → 60 秒的連線憑證；付費授權的帳號才帶「可發言」旗標
//   GET  /v1/dm/ws       帶憑證升級成 WebSocket，轉給該影片的 DanmakuRoom
//   GET  /v1/dm/range    重播：依播放位置一次拿 30 秒（邊緣快取 60 秒，1 萬人看重播也幾乎不打到房間）
//   房間（DanmakuRoom，一支影片一個；名稱帶分片號，人多時可以分）
//     收到 say → 長度／頻率／每日上限／關鍵字／（開關打開時）Haiku 審核 → 存 SQLite → 0.4 秒合併一包廣播
//   索引房間（'__index'）：哪些影片有彈幕、檢舉佇列——後台用
//
// 瀏覽器的 WebSocket 不能帶自訂標頭，所以身分走「先用標頭換憑證、再用憑證連線」；
// 憑證只活 60 秒、綁影片，就算出現在網址或日誌裡也沒有重放價值。
// ---------------------------------------------------------------------------

const DM_MAX_LEN = 40;                 // 一則最多幾個字（彈幕是短句；長了蓋住畫面）
const DM_MIN_GAP_MS = 2000;            // 同一個人兩則之間至少隔多久
const DM_PER_MIN = 10;                 // 同一個人一分鐘最多幾則
const DM_PER_DAY = 300;                // 同一個人在同一支影片一天最多幾則
const DM_ROOM_PER_DAY = 20000;         // 一支影片一天最多幾則（保險絲：SQLite 寫入免費方案 10 萬列／天）
const DM_TICKET_SEC = 60;              // 連線憑證效期
const DM_BUCKET_MS = 30000;            // 重播一次拿多長
const DM_RANGE_CACHE_SEC = 60;         // 重播那一段的邊緣快取（刪除的彈幕最多這麼久後從重播消失）
const DM_FLUSH_MS = 400;               // 廣播合併間隔
const DM_MAX_POS_MS = 8 * 3600 * 1000; // 影片位置上限（最長的轉播也不到 8 小時）
const DM_SHARDS = 1;                   // 一支影片分幾個房間。⚠️ 改大之前先讀 dmRoomName 的說明
const DM_INDEX_ROOM = '__index';
const DM_BANS_KEY = 'dm:bans';
const DM_AI_MAX_PER_DAY = 5000;        // Haiku 審核每天最多幾則（超過就只靠關鍵字）
// ---- 後台即時處理（2026-10-28 Ray）----
const DM_MUTE_SECS = [60, 180, 600];   // 限時禁言的選項；0＝永久
const DM_SLOW_SECS = [0, 5, 10, 30];   // 慢速模式：每人幾秒一則（0＝關）
const DM_AUTO_HIDE = 3;                // 幾個「登入的帳號」檢舉同一則就先自動隱藏、等後台審
const DM_DEL_KEEP_MS = 7 * 86400 * 1000; // 後台刪除的彈幕保留一星期（可以恢復），之後由 alarm 永久刪除（2026-10-29 Ray）
const DM_BATCH_MAX = 200;               // 批量刪除／恢復一次最多幾則（＝後台一頁）
const DM_ADMIN_SUB = 'admin';          // 後台連線的身分（使用者的 sub 一律是 g:／i: 開頭，不會撞名）

/** 禁言還有沒有效（限時禁言過了就當作沒有）。 */
function dmBanActive(ban, nowS) {
  return !!(ban && (ban.mode === 'mute' || ban.mode === 'shadow') && (!ban.until || ban.until > (nowS || nowSec())));
}

/**
 * 內建的關鍵字（比對前先 dmFold：全半形、大小寫、拿掉空白與標點）。
 * 後台可以再加（ops.danmaku.words）。**刻意只放少量明確的**——
 * 中文的變體寫法關鍵字擋不完，那是 Haiku 開關與檢舉的工作；這裡擋最常見、零爭議的。
 */
const DM_WORDS_BUILTIN = [
  '幹你娘', '幹妳娘', '操你媽', '操你妈', '肏你', '靠北', '雞掰', '机掰', '屄', '他媽的', '他妈的',
  '去死', '智障', '腦殘', '脑残', '白癡', '白痴', '垃圾人', '賤人', '贱人',
  '加line', '加賴', '私訊我', '代購', '博弈', '娛樂城', '娱乐城', '投資群', '飆股',
];
// 網址、帳號、電話一律不收（廣告與個資）。比對原文，不是 dmFold 之後的
const DM_LINK_RE = /(https?:|www\.|\.(com|net|org|tw|io|cc|xyz|me|app|top|vip)\b|line\.me|t\.me|discord\.gg|@[a-z0-9_]{3,}|\d{4}[-\s]?\d{3}[-\s]?\d{3})/i;

/** 比對用的正規化：全形轉半形、小寫、拿掉空白／標點／符號（「幹 你 娘」「幹.你.娘」都會被抓到）。 */
function dmFold(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
}

/** 送進來的原文整理成要存的樣子。回傳 null＝不收。 */
function dmClean(raw) {
  let t = String(raw == null ? '' : raw).normalize('NFKC');
  // 控制字元、零寬字元、雙向控制（拿來偽裝方向與藏字）一律拿掉
  t = t.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if ([...t].length > DM_MAX_LEN) return null;
  // 同一個字連打十次以上＝洗版
  if (/(.)\1{9,}/u.test(t)) return null;
  return t;
}

/** 關鍵字與網址。回傳擋下的原因，null＝通過。 */
function dmBlocked(text, extraWords) {
  if (DM_LINK_RE.test(text)) return 'link';
  const f = dmFold(text);
  for (const w of DM_WORDS_BUILTIN.concat(extraWords || [])) {
    const k = dmFold(w);
    if (k && f.includes(k)) return 'word';
  }
  return null;
}

/** ops.danmaku 的整理。任何不合格的值都退回最保守的預設（關著、白名單空、不用 Haiku）。 */
function normDanmaku(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const allow = (Array.isArray(o.allow) ? o.allow : [])
    .map((e) => String(e || '').trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 200);
  const words = (Array.isArray(o.words) ? o.words : [])
    .map((w) => String(w || '').trim()).filter((w) => w && w.length <= 30).slice(0, 500);
  return { on: o.on === true, allow, words, aiMod: o.aiMod === true };
}

/**
 * 房間名稱。
 * ⚠️ 分片（DM_SHARDS > 1）時同一支影片的彈幕分散在幾個房間——廣播只到同一片的人。
 *    要分之前得先做「片之間互相轉送」（或一層扇出），否則不同片的人看不到彼此。
 *    協定已經預留：憑證與連線都帶片號，用戶端不必改。
 */
function dmRoomName(cid, shard) { return `dm:${cid}:${shard || 0}`; }
function dmShardOf(sub) {
  if (DM_SHARDS <= 1) return 0;
  let h = 0;
  for (const ch of String(sub)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % DM_SHARDS;
}
function dmStub(env, name) {
  return env.DM.get(env.DM.idFromName(name), { locationHint: 'apac' });
}
async function dmOp(env, name, body) {
  if (!env.DM) return null;
  try {
    const res = await dmStub(env, name).fetch('https://dm.pitlingo.internal/op', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.ok ? await res.json() : null;
  } catch (e) { return null; }
}

let dmBansCache = { at: 0, data: null };
/** 禁言名單：{ [sub]: { mode: 'mute'|'shadow', at, note } }。後台改的時候作廢快取。 */
async function dmBans(env) {
  if (dmBansCache.data && Date.now() - dmBansCache.at < 60000) return dmBansCache.data;
  let d = {};
  try { d = JSON.parse((await env.SUBS.get(DM_BANS_KEY)) || '{}') || {}; } catch (e) { d = {}; }
  dmBansCache = { at: Date.now(), data: d };
  return d;
}

const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))));

/** 憑證：dm1.<cid>.<shard>.<sub>.<exp>.<flags>.<簽章>。flags：p＝可發言、s＝影子禁言、u＝未付費（只能看） */
async function dmTicketIssue(env, cid, sub, flags) {
  const exp = nowSec() + DM_TICKET_SEC;
  const payload = `dm1.${cid}.${dmShardOf(sub)}.${b64u(sub)}.${exp}.${flags}`;
  return payload + '.' + (await hmac(tokenSecret(env), 'dmt:' + payload));
}
async function dmTicketVerify(env, t, cid) {
  const s = String(t || '');
  if (!s || s.length > 600) return null;
  const i = s.lastIndexOf('.');
  if (i < 0) return null;
  const payload = s.slice(0, i);
  const secret = tokenSecret(env);
  if (!secret || !safeEqual(s.slice(i + 1), await hmac(secret, 'dmt:' + payload))) return null;
  const [v, c, shard, subB, exp, flags] = payload.split('.');
  if (v !== 'dm1' || c !== cid || !(Number(exp) >= nowSec())) return null;
  let sub;
  try { sub = unb64u(subB); } catch (e) { return null; }
  return { cid: c, shard: Number(shard) || 0, sub, post: /p/.test(flags || ''), shadow: /s/.test(flags || ''), unpaid: /u/.test(flags || ''),
    admin: /a/.test(flags || '') && sub === DM_ADMIN_SUB };
}

/**
 * 換憑證。依序：收割端不行 → 發行前的白名單 → 付費與否決定能不能發言 → 禁言。
 * 回傳 { ok, ticket, post, unpaid, shard } 或 { error, status, code }。
 *
 * ⚠️ **未付費（含沒登入）看得到、不能發**（2026-10-28 Ray 推翻同日「免費試用不能用」）。
 *    看＝只收廣播與重播，成本是房間送出的訊息（不計費）與 range 的邊緣快取，人多也幾乎不花錢；
 *    發言才需要「追得到一個人」——所以只有付費授權的帳號拿得到 p 旗標。
 *    沒登入的身分用 'i:'+installId（只拿來做檢舉去重，不會出現在任何人的畫面上）。
 */
async function dmTicket(env, request, auth, cid) {
  // ⚠️ legacy（收割權杖）不行：收割端不是觀眾
  if (auth.legacy) return { error: '彈幕需要付費授權', status: 403, code: 'E81' };
  const sess = await sessionOf(env, request, false);
  const sub = sess ? sess.sub : (auth.installId ? 'i:' + auth.installId : '');
  if (!sub) return { error: '彈幕需要登入', status: 401, code: 'E81' };
  const cfg = normDanmaku((await opsConfig(env)).danmaku);
  if (!cfg.on) {
    // 未發行：只有白名單的帳號（沒登入一律不在白名單）
    const acc = sess ? await readGoogleAccount(env, sess.sub).catch(() => null) : null;
    const mine = ((acc && acc.emails) || []).map((e) => String(e).toLowerCase());
    if (!mine.some((e) => cfg.allow.includes(e))) return { error: '彈幕尚未開放', status: 403, code: 'E82' };
  }
  let paid = false;
  if (sess) {
    const gate = await checkEntitlement(env, Object.assign({}, auth, { acct: sess.sub }), request, 1);
    paid = gate.reason === 'licensed';
  }
  const raw = (await dmBans(env))[sub];
  const ban = dmBanActive(raw) ? raw : null;
  // ⚠️ 限時禁言照樣給 p：禁言在房間裡每一則當場查（會過期），憑證只活 60 秒、不是禁言的依據
  const flags = (paid && !(ban && ban.mode === 'mute' && !ban.until) ? 'p' : '') + (ban && ban.mode === 'shadow' ? 's' : '') + (paid ? '' : 'u');
  return { ok: true, ticket: await dmTicketIssue(env, cid, sub, flags), post: flags.includes('p'), unpaid: !paid, shard: dmShardOf(sub), exp: nowSec() + DM_TICKET_SEC };
}

/** 重播：一段 30 秒的彈幕，邊緣快取 60 秒（快取鍵不含憑證——每個人拿到的都一樣）。 */
async function dmRange(env, cid, bucket, shard, ctxWait) {
  const key = new Request(`https://dm-cache.pitlingo.internal/${cid}/${shard}/${bucket}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return hit.json();
  }
  const d = await dmOp(env, dmRoomName(cid, shard), { op: 'range', from: bucket * DM_BUCKET_MS, to: (bucket + 1) * DM_BUCKET_MS });
  const out = { items: (d && d.items) || [] };
  if (cache && d) {
    const res = new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${DM_RANGE_CACHE_SEC}` } });
    const p = cache.put(key, res).catch(() => {});
    if (ctxWait) ctxWait(p); else await p;
  }
  return out;
}

/**
 * Haiku 審核（ops.danmaku.aiMod，預設關）。回傳 true＝放行。
 * ⚠️ 失敗一律放行（關鍵字已經擋過一輪）：審核服務壞掉時整個彈幕停擺，比漏一則更糟。
 * ⚠️ 用量記在房間的 SQLite（dm_cost）——付了錢的呼叫每一次都要記（鐵則 44）。
 */
async function dmAiOk(env, text) {
  if (!env.ANTHROPIC_API_KEY) return { ok: true, usage: null };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 3, temperature: 0,
        system: '你是 F1 直播彈幕的審核員。使用者訊息是一則觀眾彈幕（繁體中文為主）。'
          + '含有髒話（包括諧音、拆字、注音、火星文等變體）、人身攻擊、歧視、性騷擾、廣告、詐騙、聯絡方式、政治引戰時回 N，'
          + '一般的比賽討論、對車手車隊的情緒（例如「爛透了」「太扯了」）、玩笑都回 Y。只回一個字母。',
        messages: [{ role: 'user', content: text }],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: true, usage: null };
    const d = await res.json();
    const ans = ((d.content || []).find((b) => b.type === 'text') || {}).text || '';
    return { ok: !/^\s*N/i.test(ans), usage: d.usage || {} };
  } catch (e) {
    return { ok: true, usage: null };
  }
}

/** 給後台：把 sub 換成看得懂的東西（信箱的第一個）。只在後台用，不會送到觀眾那裡。 */
async function dmWho(env, sub) {
  const acc = await readGoogleAccount(env, sub).catch(() => null);
  return (acc && acc.emails && acc.emails[0]) || sub;
}

export class DanmakuRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.pending = [];        // 等著合併廣播的
    this.timer = null;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS dm (
        id INTEGER PRIMARY KEY AUTOINCREMENT, pos INTEGER NOT NULL, at INTEGER NOT NULL,
        sub TEXT NOT NULL, text TEXT NOT NULL, live INTEGER NOT NULL DEFAULT 0,
        state INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0)`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS dm_pos ON dm (pos)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS dm_sub ON dm (sub, at)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS dm_at ON dm (at)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS dm_report (id INTEGER NOT NULL, sub TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (id, sub))');
      this.sql.exec('CREATE TABLE IF NOT EXISTS dm_cost (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, inp INTEGER NOT NULL, outp INTEGER NOT NULL)');
      // 索引房間用
      this.sql.exec('CREATE TABLE IF NOT EXISTS dm_rooms (cid TEXT PRIMARY KEY, last INTEGER NOT NULL, n INTEGER NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS dm_reports (cid TEXT NOT NULL, id INTEGER NOT NULL, at INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (cid, id))');
      // 刪除的時間（毫秒）：保留一星期用。舊房間沒有這個欄位——先查再加（不靠「重複加會丟錯」，失敗的語句不該出現在初始化裡）
      if (!this.sql.exec('PRAGMA table_info(dm)').toArray().some((c) => c.name === 'del_at')) this.sql.exec('ALTER TABLE dm ADD COLUMN del_at INTEGER');
      // 這一版以前刪掉的沒有時間：從現在起算一星期（不會在部署當下就消失）
      const old = this.one('SELECT COUNT(*) AS n FROM dm WHERE state = 1 AND del_at IS NULL');
      if (old && old.n) { this.sql.exec('UPDATE dm SET del_at = ? WHERE state = 1 AND del_at IS NULL', Date.now()); await this.armPurge(); }
    });
    // 用戶端每 25 秒送一次 ping；自動回應不會喚醒房間（不計 duration）
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}')); } catch (e) { /* 測試環境沒有 */ }
  }

  one(q, ...args) { const r = this.sql.exec(q, ...args).toArray(); return r[0] || null; }

  isAdmin(ws) { const w = ws.deserializeAttachment() || {}; return !!w.admin; }
  viewers() { return this.ctx.getWebSockets().filter((ws) => !this.isAdmin(ws)); }
  admins() { return this.ctx.getWebSockets(DM_ADMIN_SUB); }
  toAdmins(o) { const s = JSON.stringify(o); for (const ws of this.admins()) { try { ws.send(s); } catch (e) { /* 斷了 */ } } }
  toViewers(o) { const s = JSON.stringify(o); for (const ws of this.viewers()) { try { ws.send(s); } catch (e) { /* 斷了 */ } } }

  /** 這個房間的控制：暫停、慢速模式。存在 storage（DO 休眠會丟記憶體，鐵則 64）。 */
  async ctlGet() {
    const c = (await this.ctx.storage.get('ctl')) || {};
    return { paused: !!c.paused, slow: DM_SLOW_SECS.includes(Number(c.slow)) ? Number(c.slow) : 0 };
  }

  /**
   * 房間裡的禁言（後台在這支影片按的）。**比 KV 的名單優先**：
   * KV 名單有 60 秒快取、而且別的 isolate 的快取作廢不到——60 秒的限時禁言等名單傳過來就已經結束了。
   * mode 為空字串＝後台剛解除（蓋過還沒過期的 KV 快取）。
   */
  async banOf(sub) {
    const local = await this.ctx.storage.get('ban:' + sub);
    const g = (await dmBans(this.env))[sub];
    // 兩邊都有就信「比較新的那一筆」：在禁言名單頁解除（沒有指定影片）時，KV 寫的是解除紀錄，要蓋過房間裡舊的禁言
    const rec = local && g ? ((Number(local.at) || 0) >= (Number(g.at) || 0) ? local : g) : (local || g);
    return dmBanActive(rec) ? rec : null;
  }

  /**
   * 刪除（1）／恢復（0）一批。自動隱藏（3）只由檢舉觸發，這裡不會設。
   * 刪除記下時間、保留一星期（後台還能恢復），到期由 alarm 永久刪除；恢復就把時間清掉。
   */
  async setStates(ids, st, now) {
    const del = [], back = [];
    for (const id of ids) {
      const row = this.one('SELECT id, pos, text, live, state FROM dm WHERE id = ?', id);
      if (!row || row.state === st) continue;
      this.sql.exec('UPDATE dm SET state = ?, del_at = ? WHERE id = ?', st, st === 1 ? now : null, id);
      if (st === 1) del.push(id);
      // 恢復被刪除／自動隱藏的：送回給在線的人（影子禁言的本來就沒給別人看過，不送）
      else if (row.state === 3 || row.state === 1) back.push({ id, pos: row.pos, x: row.text, live: row.live });
      this.toAdmins({ t: 'st', id, state: st, del_at: st === 1 ? now : null });
    }
    if (del.length) { this.toViewers({ t: 'del', ids: del }); await this.armPurge(); }
    if (back.length) this.toViewers({ t: 'm', items: back });
    return del.length + back.length;
  }

  /** 排下一次永久刪除：最早被刪的那一則滿一星期時。已經排了更早的就不動（alarm 裡呼叫時 force：剛觸發的那個不算數） */
  async armPurge(force) {
    const s = this.ctx.storage;
    if (!s.setAlarm) return;
    const r = this.one('SELECT MIN(del_at) AS t FROM dm WHERE state = 1 AND del_at IS NOT NULL');
    if (!r || r.t == null) return;
    const when = Number(r.t) + DM_DEL_KEEP_MS;
    const cur = await s.getAlarm();
    if (force || cur == null || cur > when) await s.setAlarm(when);
  }

  /** 刪除滿一星期的彈幕：連同檢舉紀錄一起永久刪掉，再排下一次 */
  async alarm() {
    const cutoff = Date.now() - DM_DEL_KEEP_MS;
    this.sql.exec('DELETE FROM dm_report WHERE id IN (SELECT id FROM dm WHERE state = 1 AND del_at IS NOT NULL AND del_at <= ?)', cutoff);
    this.sql.exec('DELETE FROM dm WHERE state = 1 AND del_at IS NOT NULL AND del_at <= ?', cutoff);
    await this.armPurge(true);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket') {
      const who = { sub: request.headers.get('x-dm-sub') || '', post: request.headers.get('x-dm-post') === '1',
        shadow: request.headers.get('x-dm-shadow') === '1', unpaid: request.headers.get('x-dm-unpaid') === '1',
        admin: request.headers.get('x-dm-admin') === '1' && request.headers.get('x-dm-sub') === DM_ADMIN_SUB,
        cid: request.headers.get('x-dm-cid') || '' };
      if (!who.sub || !who.cid) return new Response('bad', { status: 400 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // 後台的連線另外標記：廣播時它收「帶身分」的版本，觀眾收不帶身分的
      this.ctx.acceptWebSocket(server, [who.admin ? DM_ADMIN_SUB : who.sub]);
      server.serializeAttachment(who);
      const ctl = await this.ctlGet();
      if (who.admin) server.send(JSON.stringify({ t: 'hello', admin: true, ctl, online: this.viewers().length }));
      else server.send(JSON.stringify({ t: 'hello', post: who.post, unpaid: who.unpaid, max: DM_MAX_LEN, ctl }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/op' && request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      return Response.json(await this.op(b || {}));
    }
    return new Response('not found', { status: 404 });
  }

  async op(b) {
    const now = Date.now();
    switch (b.op) {
      case 'range': {
        const rows = this.sql.exec('SELECT id, pos, text, live FROM dm WHERE pos >= ? AND pos < ? AND state = 0 ORDER BY pos LIMIT 2000',
          Number(b.from) || 0, Number(b.to) || 0).toArray();
        return { items: rows.map((r) => ({ id: r.id, pos: r.pos, x: r.text, live: r.live })) };
      }
      case 'list': {                     // 後台：最近的彈幕（含 sub 與狀態）
        const before = Number(b.before) || 9e15;
        const rows = this.sql.exec('SELECT id, pos, at, sub, text, live, state, reports, del_at FROM dm WHERE id < ? ORDER BY id DESC LIMIT 200', before).toArray();
        return { items: rows };
      }
      case 'bySub': {
        const rows = this.sql.exec('SELECT id, pos, at, text, state, reports, del_at FROM dm WHERE sub = ? ORDER BY id DESC LIMIT 200', String(b.sub || '')).toArray();
        return { items: rows };
      }
      case 'state': {                    // 後台：刪除（1）／恢復（0）一則
        const id = Number(b.id) || 0;
        if (!this.one('SELECT id FROM dm WHERE id = ?', id)) return { ok: false, error: '找不到這則' };
        await this.setStates([id], b.state === 1 ? 1 : 0, now);
        return { ok: true };
      }
      case 'states': {                   // 後台：批量刪除／恢復
        const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter((x) => x > 0))].slice(0, DM_BATCH_MAX);
        return { ok: true, n: await this.setStates(ids, b.state === 1 ? 1 : 0, now) };
      }
      case 'stats': {
        const day = new Date().toISOString().slice(0, 10);
        const c = this.one('SELECT calls, inp, outp FROM dm_cost WHERE day = ?', day);
        const t = this.one('SELECT COUNT(*) AS n FROM dm');
        return { total: t ? t.n : 0, online: this.viewers().length, ai: c || { calls: 0, inp: 0, outp: 0 }, ctl: await this.ctlGet() };
      }
      case 'ctl': {                      // 後台：暫停／慢速模式
        const next = { paused: !!b.paused, slow: DM_SLOW_SECS.includes(Number(b.slow)) ? Number(b.slow) : 0 };
        await this.ctx.storage.put('ctl', next);
        this.toViewers({ t: 'ctl', ctl: next });
        this.toAdmins({ t: 'ctl', ctl: next });
        return { ok: true, ctl: next };
      }
      case 'ban': {                      // 後台在這支影片禁言／解除：當場生效（見 banOf）
        const sub = String(b.sub || '');
        if (!sub) return { ok: false };
        const rec = { mode: b.mode === 'mute' || b.mode === 'shadow' ? b.mode : '', until: Number(b.until) || 0, at: Number(b.at) || nowSec() };
        await this.ctx.storage.put('ban:' + sub, rec);
        // 只有一般禁言告訴本人（影子禁言的重點就是他不知道）
        const tell = rec.mode === 'mute' ? { t: 'muted', until: rec.until } : rec.mode === '' ? { t: 'unmuted' } : null;
        if (tell) for (const ws of this.ctx.getWebSockets(sub)) { try { ws.send(JSON.stringify(tell)); } catch (e) { /* 斷了 */ } }
        return { ok: true };
      }
      // ---- 索引房間 ----
      case 'touch':
        this.sql.exec('INSERT INTO dm_rooms (cid, last, n) VALUES (?, ?, ?) ON CONFLICT(cid) DO UPDATE SET last = excluded.last, n = dm_rooms.n + excluded.n',
          String(b.cid), now, Number(b.n) || 0);
        return { ok: true };
      case 'rooms':
        return { items: this.sql.exec('SELECT cid, last, n FROM dm_rooms ORDER BY last DESC LIMIT 200').toArray() };
      case 'reported':
        this.sql.exec('INSERT INTO dm_reports (cid, id, at, n) VALUES (?, ?, ?, 1) ON CONFLICT(cid, id) DO UPDATE SET at = excluded.at, n = dm_reports.n + 1',
          String(b.cid), Number(b.id) || 0, now);
        return { ok: true };
      case 'reports':
        return { items: this.sql.exec('SELECT cid, id, at, n FROM dm_reports ORDER BY at DESC LIMIT 200').toArray() };
      case 'resolve':
        for (const id of (Array.isArray(b.ids) ? b.ids : [b.id])) this.sql.exec('DELETE FROM dm_reports WHERE cid = ? AND id = ?', String(b.cid), Number(id) || 0);
        return { ok: true };
      default:
        return { error: 'unknown op' };
    }
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const who = ws.deserializeAttachment() || {};
    if (m.t === 'say') return this.say(ws, who, m);
    if (m.t === 'report' && !who.admin) return this.report(ws, who, m);
  }

  reply(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) { /* 對方已經斷了 */ } }

  async say(ws, who, m) {
    const n = m.n;                       // 用戶端的編號，回 ack／err 時帶回去
    const fail = (code, msg) => this.reply(ws, { t: 'err', n, code, msg });
    // ⚠️ 禁言要在這裡當場查，不能只信連線當時的憑證：連線可以掛好幾個小時，
    //    只看憑證的話「禁言」要等他自己斷線重連才生效。名單有 60 秒快取，所以最慢 60 秒生效。
    if (who.admin) return fail('E81', '後台連線不能發彈幕');
    // 未付費只能看（憑證沒有 p 旗標）：回 E81，不是「被禁言」——那是兩件事，提示也不同
    if (who.unpaid) return fail('E81', '發送彈幕需要付費授權');
    const ctl = await this.ctlGet();
    if (ctl.paused) return fail('E88', '彈幕暫停中，請稍後再試');
    // ⚠️ 禁言以「現在」的名單為準，不看連線當時的旗標：限時禁言會過期、後台也可能剛解除
    const ban = await this.banOf(who.sub);
    if (ban && ban.mode === 'mute') {
      return fail('E83', ban.until ? `你已被禁言，${Math.max(1, ban.until - nowSec())} 秒後解除` : '你已被禁止發送彈幕');
    }
    who.shadow = !!(ban && ban.mode === 'shadow');
    const text = dmClean(m.x);
    if (!text) return fail('E85', '彈幕要 1～' + DM_MAX_LEN + ' 個字');
    const pos = Math.round(Number(m.pos));
    if (!(pos >= 0 && pos <= DM_MAX_POS_MS)) return fail('E85', '播放位置不正確');
    const now = Date.now();
    const dayStart = Date.parse(new Date(now).toISOString().slice(0, 10));
    // 頻率與每日上限：用查的（讀不計寫入額度），不另外記計數
    const last = this.one('SELECT MAX(at) AS t FROM dm WHERE sub = ?', who.sub);
    if (ctl.slow && last && last.t && now - last.t < ctl.slow * 1000) return fail('E84', `慢速模式：每 ${ctl.slow} 秒最多一則`);
    if (last && last.t && now - last.t < DM_MIN_GAP_MS) return fail('E84', '發送太頻繁，請稍後再試');
    const perMin = this.one('SELECT COUNT(*) AS n FROM dm WHERE sub = ? AND at >= ?', who.sub, now - 60000);
    if (perMin && perMin.n >= DM_PER_MIN) return fail('E84', '發送太頻繁，請稍後再試');
    const perDay = this.one('SELECT COUNT(*) AS n FROM dm WHERE sub = ? AND at >= ?', who.sub, dayStart);
    if (perDay && perDay.n >= DM_PER_DAY) return fail('E86', '今日彈幕數量已達上限');
    const room = this.one('SELECT COUNT(*) AS n FROM dm WHERE at >= ?', dayStart);
    if (room && room.n >= DM_ROOM_PER_DAY) return fail('E86', '這支影片今日的彈幕已達上限');

    const cfg = normDanmaku((await opsConfig(this.env)).danmaku);
    if (dmBlocked(text, cfg.words)) return fail('E85', '彈幕內容不符合規範');
    if (cfg.aiMod) {
      const day = new Date(now).toISOString().slice(0, 10);
      const used = this.one('SELECT calls FROM dm_cost WHERE day = ?', day);
      if (!used || used.calls < DM_AI_MAX_PER_DAY) {
        const r = await dmAiOk(this.env, text);
        if (r.usage) {
          this.sql.exec('INSERT INTO dm_cost (day, calls, inp, outp) VALUES (?, 1, ?, ?) ON CONFLICT(day) DO UPDATE SET calls = calls + 1, inp = inp + excluded.inp, outp = outp + excluded.outp',
            day, Number(r.usage.input_tokens) || 0, Number(r.usage.output_tokens) || 0);
        }
        if (!r.ok) return fail('E85', '彈幕內容不符合規範');
      }
    }

    // ⚠️ 影子禁言：照樣存（後台看得到）、照樣回成功、照樣送回他自己的連線——只有別人看不到
    const state = who.shadow ? 2 : 0;
    const live = m.live ? 1 : 0;
    const row = this.one('INSERT INTO dm (pos, at, sub, text, live, state) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', pos, now, who.sub, text, live, state);
    const item = { id: row.id, pos, x: text, live };
    this.reply(ws, { t: 'ack', n, id: row.id });
    this.pending.push({ item, shadowOf: who.shadow ? who.sub : null, sub: who.sub, at: now });
    if (!this.timer) this.timer = setTimeout(() => this.flush(), DM_FLUSH_MS);
    this.noteIndex(who.cid, now);
  }

  /** 合併廣播：0.4 秒內收到的一次送出。1,000 人同時刷時，送出次數不會跟著「則數 × 人數」爆炸。 */
  flush() {
    this.timer = null;
    const batch = this.pending;
    this.pending = [];
    if (!batch.length) return;
    const pub = batch.filter((p) => !p.shadowOf).map((p) => p.item);
    const pubMsg = pub.length ? JSON.stringify({ t: 'm', items: pub }) : null;
    // 後台：全部（含影子禁言的），帶身分與狀態——觀眾的那一份**沒有任何身分**
    this.toAdmins({ t: 'am', items: batch.map((p) => Object.assign({}, p.item, { sub: p.sub, at: p.at, state: p.shadowOf ? 2 : 0, reports: 0 })) });
    for (const ws of this.ctx.getWebSockets()) {
      const who = ws.deserializeAttachment() || {};
      if (who.admin) continue;
      const own = batch.filter((p) => p.shadowOf && p.shadowOf === who.sub).map((p) => p.item);
      try {
        if (own.length) ws.send(JSON.stringify({ t: 'm', items: pub.concat(own) }));
        else if (pubMsg) ws.send(pubMsg);
      } catch (e) { /* 斷線的那一條等 close 收 */ }
    }
  }

  broadcast(o) {
    const s = JSON.stringify(o);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch (e) { /* 斷了 */ } }
  }

  /** 告訴索引房間「這支影片有新彈幕」。10 分鐘最多一次（記在 storage：休眠會丟記憶體，鐵則 64）。 */
  async noteIndex(cid, now) {
    if (!cid) return;
    try {
      const last = Number(await this.ctx.storage.get('idxAt')) || 0;
      const pend = (Number(await this.ctx.storage.get('idxN')) || 0) + 1;
      if (now - last < 10 * 60000) { await this.ctx.storage.put('idxN', pend); return; }
      await this.ctx.storage.put({ idxAt: now, idxN: 0 });
      await dmOp(this.env, DM_INDEX_ROOM, { op: 'touch', cid, n: pend });
    } catch (e) { /* 只影響後台的清單 */ }
  }

  async report(ws, who, m) {
    const id = Number(m.id) || 0;
    if (!id) return;
    const row = this.one('SELECT id FROM dm WHERE id = ?', id);
    if (!row) return;
    // 同一個人檢舉同一則只算一次
    const before = this.one('SELECT id FROM dm_report WHERE id = ? AND sub = ?', id, who.sub);
    if (before) return this.reply(ws, { t: 'reported', id });
    this.sql.exec('INSERT INTO dm_report (id, sub, at) VALUES (?, ?, ?)', id, who.sub, Date.now());
    this.sql.exec('UPDATE dm SET reports = reports + 1 WHERE id = ?', id);
    this.reply(ws, { t: 'reported', id });
    // 自動隱藏：DM_AUTO_HIDE 個**登入的帳號**檢舉就先收起來、等後台審（2026-10-28 Ray 選 3）。
    // ⚠️ 沒登入的檢舉（i:安裝編號）照樣記、後台看得到，但不算進門檻——
    //    安裝編號免費無限領，三個就能把任何一則彈幕藏起來。
    const acct = this.one("SELECT COUNT(*) AS n FROM dm_report WHERE id = ? AND sub NOT LIKE 'i:%'", id);
    const cur = this.one('SELECT reports, state FROM dm WHERE id = ?', id);
    let state = cur ? cur.state : 0;
    if (cur && cur.state === 0 && acct && acct.n >= DM_AUTO_HIDE) {
      state = 3;
      this.sql.exec('UPDATE dm SET state = 3 WHERE id = ?', id);
      this.toViewers({ t: 'del', ids: [id] });
    }
    this.toAdmins({ t: 'rep', id, reports: cur ? cur.reports : 1, state });
    await dmOp(this.env, DM_INDEX_ROOM, { op: 'reported', cid: who.cid, id });
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1006 ? 1000 : code, 'bye'); } catch (e) { /* 已經關了 */ }
  }
  async webSocketError() { /* 由 close 收 */ }
}

/**
 * 彈幕的公開端點。回傳 Response，不是彈幕的路徑回 null。
 * 不經過 SITE_CORS：用戶端是擴充功能的 service worker。
 */
async function handleDanmaku(request, env, path, url, ip, ctxWait) {
  if (!path.startsWith('/v1/dm/')) return null;
  if (!env.DM) return err('彈幕尚未設定', 503, 'E82');
  const cid = String(url.searchParams.get('cid') || '');
  if (!/^\d{1,20}$/.test(cid)) return err('cid 格式不正確');

  if (path === '/v1/dm/ticket' && request.method === 'POST') {
    const a = await authClient(env, request);
    if (!a.ok) return err('unauthorized: ' + a.reason, 401);
    if (await rateLimited(env, a.legacy ? ip : a.installId)) return err('請求太頻繁，請稍後再試', 429, 'E32');
    const r = await dmTicket(env, request, a, cid);
    if (!r.ok) return err(r.error, r.status, r.code);
    return json(r);
  }

  const tk = await dmTicketVerify(env, url.searchParams.get('t'), cid);
  if (!tk) return err('彈幕連線憑證無效或已過期', 401, 'E87');

  if (path === '/v1/dm/ws') {
    if (request.headers.get('Upgrade') !== 'websocket') return err('需要 WebSocket', 426);
    const h = new Headers(request.headers);
    h.set('x-dm-sub', tk.sub);
    h.set('x-dm-cid', cid);
    h.set('x-dm-post', tk.post ? '1' : '0');
    h.set('x-dm-shadow', tk.shadow ? '1' : '0');
    h.set('x-dm-unpaid', tk.unpaid ? '1' : '0');
    // ⚠️ 每一個 x-dm-* 都要在這裡明確設定：h 是從用戶端的標頭複製來的，漏設一個就等於讓用戶端自己填
    h.set('x-dm-admin', tk.admin ? '1' : '0');
    return dmStub(env, dmRoomName(cid, tk.shard)).fetch(new Request(request.url, { headers: h }));
  }

  if (path === '/v1/dm/range' && request.method === 'GET') {
    const b = Math.floor(Number(url.searchParams.get('b')));
    if (!(b >= 0 && b * DM_BUCKET_MS <= DM_MAX_POS_MS)) return err('b 不正確');
    return json(await dmRange(env, cid, b, tk.shard, ctxWait), 200, { 'cache-control': 'no-store' });
  }
  return err('not found', 404);
}

/**
 * 後台：有彈幕的影片依「年 → 站 → 場次」分類（2026-10-28 Ray）。
 * 網址後綴（slug）就是標題，從翻譯快取的摘要拿（listBundleMeta，5 分鐘記憶體快取，不會每次 list KV）。
 * ⚠️ slug 可能是用戶端寫的（坑 #95）——這裡只拿來分類顯示，不做任何判斷；後台顯示一律 escHtml。
 */
async function dmRoomsLabeled(env, rooms) {
  let metas = [];
  try { metas = await listBundleMeta(env); } catch (e) { metas = []; }
  const slugOf = new Map(metas.map((m) => [String(m.cid), m.slug || '']));
  const cfg = REMOTE_CONFIG;
  const season = (cfg && cfg.seasonYear) || SEASON_YEAR;
  const sched = scheduleList(cfg);
  return rooms.map((x) => {
    const slug = slugOf.get(String(x.cid)) || '';
    const key = slug ? slugKeyOf(slug) : '';
    const year = Number((/-((?:19|20)\d{2})-/.exec(key) || [])[1]) || new Date(Number(x.last) || Date.now()).getUTCFullYear();
    let gp;
    const hit = key && year === Number(season) ? sched.find((g) => slugMatchesGp(key, g)) : null;
    if (hit && hit.testing) gp = { key: 'testing', label: '季前測試', order: 0 };
    else if (hit) gp = { key: 'r' + hit.r, label: `R${hit.r} ${hit.name}`, order: hit.r };
    else if (key.includes('-pre-season-testing-')) gp = { key: 'testing', label: '季前測試', order: 0 };
    else {
      const m = /-(?:19|20)\d{2}-([a-z0-9-]+?)-grand-prix-/.exec(key);
      gp = m ? { key: 'gp-' + m[1], label: m[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) + ' GP', order: 500 }
        : { key: 'other', label: slug ? '其他' : '沒有網址後綴（無法分類）', order: 999 };
    }
    return Object.assign({}, x, { slug, year, gp, title: (slug && sessionTitle(slug, season)) || slug || '' });
  });
}

/** 後台的彈幕端點（/v1/admin/dm/*，adminGate 已經在入口驗過）。 */
async function handleDanmakuAdmin(request, env, path, url) {
  if (!path.startsWith('/v1/admin/dm/')) return null;
  if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
  if (!env.DM) return adminJson({ error: '沒有綁定 DM（wrangler.toml）' }, 503);
  const body = request.method === 'POST' ? (await request.json().catch(() => null)) || {} : {};
  const cid = String(body.cid || url.searchParams.get('cid') || '');
  const cidOk = /^\d{1,20}$/.test(cid);

  if (path === '/v1/admin/dm/rooms') {
    const d = await dmOp(env, DM_INDEX_ROOM, { op: 'rooms' });
    return adminJson({ ok: true, items: await dmRoomsLabeled(env, (d && d.items) || []) });
  }
  // 後台即時連進房間：換一張管理者憑證（60 秒、綁影片、旗標 a）。adminGate 已經在入口驗過
  if (path === '/v1/admin/dm/ticket' && request.method === 'POST') {
    if (!cidOk) return adminJson({ error: 'cid 不正確' }, 400);
    return adminJson({ ok: true, ticket: await dmTicketIssue(env, cid, DM_ADMIN_SUB, 'a') });
  }
  if (path === '/v1/admin/dm/ctl' && request.method === 'POST') {
    if (!cidOk) return adminJson({ error: 'cid 不正確' }, 400);
    const r = await dmOp(env, dmRoomName(cid, 0), { op: 'ctl', paused: !!body.paused, slow: Number(body.slow) || 0 });
    return adminJson(r || { error: '房間沒有回應' }, r ? 200 : 502);
  }
  if (path === '/v1/admin/dm/who' && request.method === 'POST') {
    const subs = (Array.isArray(body.subs) ? body.subs : []).map(String).filter((s) => s && s.length <= 200).slice(0, 100);
    const map = {};
    for (const s of subs) map[s] = s.startsWith('i:') ? '（未登入）' + s.slice(2, 10) : await dmWho(env, s);
    return adminJson({ ok: true, map });
  }
  if (path === '/v1/admin/dm/reports') {
    const d = await dmOp(env, DM_INDEX_ROOM, { op: 'reports' });
    return adminJson({ ok: true, items: (d && d.items) || [] });
  }
  if (path === '/v1/admin/dm/msgs') {
    if (!cidOk) return adminJson({ error: 'cid 不正確' }, 400);
    const st = await dmOp(env, dmRoomName(cid, 0), { op: 'stats' });
    // 即時處理每 30 秒只問在線人數：不拉 200 則、不查信箱
    if (url.searchParams.get('statsOnly') === '1') return adminJson({ ok: true, stats: st });
    const d = await dmOp(env, dmRoomName(cid, 0), { op: 'list', before: Number(url.searchParams.get('before')) || 0 });
    const items = (d && d.items) || [];
    const who = {};
    for (const s of new Set(items.map((x) => x.sub))) who[s] = await dmWho(env, s);
    return adminJson({ ok: true, items: items.map((x) => Object.assign({}, x, { who: who[x.sub] })), stats: st });
  }
  if (path === '/v1/admin/dm/state' && request.method === 'POST') {
    if (!cidOk || !(Number(body.id) > 0)) return adminJson({ error: 'cid／id 不正確' }, 400);
    await dmOp(env, dmRoomName(cid, 0), { op: 'state', id: Number(body.id), state: body.state === 1 ? 1 : 0 });
    if (body.resolve) await dmOp(env, DM_INDEX_ROOM, { op: 'resolve', cid, id: Number(body.id) });
    return adminJson({ ok: true });
  }
  if (path === '/v1/admin/dm/states' && request.method === 'POST') {   // 批量刪除／恢復（後台勾選）
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((x) => x > 0) : [];
    if (!cidOk || !ids.length || ids.length > DM_BATCH_MAX) return adminJson({ error: 'cid／ids 不正確（一次 1～' + DM_BATCH_MAX + ' 則）' }, 400);
    const r = await dmOp(env, dmRoomName(cid, 0), { op: 'states', ids, state: body.state === 1 ? 1 : 0 });
    if (body.resolve) await dmOp(env, DM_INDEX_ROOM, { op: 'resolve', cid, ids });
    return adminJson({ ok: true, n: (r && r.n) || 0 });
  }
  if (path === '/v1/admin/dm/bans' && request.method === 'GET') {
    const bans = await dmBans(env);
    const out = [];
    const now = nowSec();
    for (const [sub, v] of Object.entries(bans)) {
      if (!dmBanActive(v, now)) continue;          // 過期的限時禁言不列
      out.push(Object.assign({ sub, who: await dmWho(env, sub), left: v.until ? v.until - now : 0 }, v));
    }
    return adminJson({ ok: true, items: out });
  }
  if (path === '/v1/admin/dm/ban' && request.method === 'POST') {
    const sub = String(body.sub || '');
    if (!sub || sub.length > 200 || sub === DM_ADMIN_SUB) return adminJson({ error: 'sub 不正確' }, 400);
    const mode = body.mode === 'mute' || body.mode === 'shadow' ? body.mode : '';
    // 限時禁言：只收 60／180／600 秒；其他（含 0）＝永久。影子禁言一律永久（限時的影子沒有意義）
    const sec = mode === 'mute' && DM_MUTE_SECS.includes(Number(body.sec)) ? Number(body.sec) : 0;
    const now = nowSec();
    // 解除也寫一筆（mode 空字串＋時間）：房間裡可能還留著在那支影片按的禁言，比時間才蓋得過去（見 banOf）
    const rec = { mode, at: now, until: sec ? now + sec : 0, note: mode ? String(body.note || '').slice(0, 200) : '' };
    // 讀→寫回之間沒有慢操作，而且只有後台在寫（一個人），KV 沒有 CAS 的問題在這裡不成立
    let bans = {};
    try { bans = JSON.parse((await env.SUBS.get(DM_BANS_KEY)) || '{}') || {}; } catch (e) { bans = {}; }
    // 順手清掉失效超過 7 天的（過期的限時禁言、解除紀錄）——7 天內的解除紀錄要留著蓋房間裡的舊禁言
    for (const [k, v] of Object.entries(bans)) if (!dmBanActive(v, now) && now - (Number(v.at) || 0) > 7 * 86400) delete bans[k];
    bans[sub] = rec;
    await env.SUBS.put(DM_BANS_KEY, JSON.stringify(bans));
    dmBansCache = { at: 0, data: null };
    // ⚠️ 在哪支影片按的就**當場**通知那個房間（KV 名單在別的 isolate 有 60 秒快取，60 秒的禁言等不起）；
    //    其他房間最慢 60 秒跟上
    if (cidOk) await dmOp(env, dmRoomName(cid, 0), { op: 'ban', sub, mode, until: rec.until, at: now });
    return adminJson({ ok: true, until: rec.until });
  }
  if (path === '/v1/admin/dm/bySub') {
    const sub = String(url.searchParams.get('sub') || '');
    if (!cidOk || !sub) return adminJson({ error: 'cid／sub 不正確' }, 400);
    const d = await dmOp(env, dmRoomName(cid, 0), { op: 'bySub', sub });
    return adminJson({ ok: true, items: (d && d.items) || [] });
  }
  return adminJson({ error: 'not found' }, 404);
}
