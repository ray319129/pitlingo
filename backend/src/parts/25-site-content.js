// =====================================================================
// 網站內容（使用者可在後台自行編輯）
//
// 使用者要求（2026-09-17）：「我要能夠自行修改網站上的文字、排版，且要用很簡單的方式，
// 但又要確保除了我以外不會有任何人能夠修改網站。」
//
// 做法：
//   · 網站 HTML 本身帶著**預設文字**（沒有網路或後端掛掉時照常顯示、搜尋引擎看得到）
//   · 可編輯的元素標 `data-edit="鍵"`；後台發布的內容只「覆寫」那些鍵
//   · 區塊順序與顯示／隱藏標 `data-section="id"`
//   · 寫入一律走 /v1/admin/*——**與後台同一道門**（權杖＋動態碼＋IP 白名單＋失敗鎖定＋稽核）
//
// ⚠️ **使用條款、隱私權政策、購買頁的同意勾選刻意不在可編輯範圍。**
//    那些文字有 check-legal／check-links 在比對程式的實際行為，
//    從後台改就繞過了檢查——條款寫的和系統做的會悄悄對不上。
//
// ⚠️ **內容一律當純文字處理。** 只支援兩種標記：`**粗體**` 與換行。
//    允許任意 HTML 等於讓「後台權杖外洩」直接升級成「網站被植入惡意腳本」。
//    連結只接受白名單內的網址。前端渲染時會再過濾一次（兩道）。
// =====================================================================
const SITE_CONTENT_KEY = 'site:content';
const SITE_HISTORY_KEY = 'site:history';
const SITE_HISTORY_MAX = 20;
const SITE_TEXT_MAX = 800;
// 2026-09-18 起全站每一頁（首頁、方案、常見問題、聯絡、帳號、付款結果、404）都可以編輯，
// 鍵以頁面為前綴（faq.*、buy.*…）。常見問題一頁就有上百個欄位，300 不夠。
const SITE_KEYS_MAX = 1500;
const SITE_SECTIONS_MAX = 120;
const SITE_DEMO_MAX = 40;
/** 公開讀取的邊緣快取秒數。發布後最久這麼久才看得到（見 handoff 坑 #11：快取層要加總） */
const SITE_CACHE_SEC = 30;
const SITE_KEY_RE = /^[a-z][a-z0-9_.-]{0,59}$/;
const SITE_SECTION_RE = /^[a-z][a-z0-9-]{0,29}$/;

/** 連結白名單。站內路徑、頁內錨點、自己的網域、兩個擴充功能商店。 */
function siteHrefOk(h) {
  const s = String(h || '').trim();
  if (!s || s.length > 300) return false;
  // 不接受 //evil.com，也不接受 /\evil.com——瀏覽器把反斜線當成斜線，那會變成外部網址（security-audit run-2 加固）
  if (/^\/(?![/\\])[^\s"'<>\\]*$/.test(s)) return true;      // /buy、/faq#x
  if (/^#[a-z0-9_-]{1,40}$/i.test(s)) return true;
  return /^https:\/\/(pitlingo\.com|www\.pitlingo\.com|chromewebstore\.google\.com|microsoftedge\.microsoft\.com)(\/[^\s"'<>]*)?$/.test(s);
}

/** 清洗後台送上來的內容。**不合格的欄位直接丟掉**，不是整份拒絕——少一個欄位只是顯示預設值。 */
function sanitizeSiteContent(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const str = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').slice(0, max);
  const out = { texts: {}, hrefs: {}, sections: [], demo: { lines: [], intervalMs: 4200 } };
  const dropped = [];

  let n = 0;
  for (const [k, v] of Object.entries(r.texts || {})) {
    if (n >= SITE_KEYS_MAX) break;
    if (!SITE_KEY_RE.test(k) || typeof v !== 'string') { dropped.push(k); continue; }
    out.texts[k] = str(v, SITE_TEXT_MAX); n++;
  }
  for (const [k, v] of Object.entries(r.hrefs || {})) {
    if (!SITE_KEY_RE.test(k) || !siteHrefOk(v)) { dropped.push(k); continue; }
    out.hrefs[k] = String(v).trim();
  }
  const seen = new Set();
  for (const s of Array.isArray(r.sections) ? r.sections : []) {
    const id = s && String(s.id || '');
    if (!SITE_SECTION_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.sections.push({ id, visible: s.visible !== false });
    if (out.sections.length >= SITE_SECTIONS_MAX) break;
  }
  const d = (r.demo && typeof r.demo === 'object') ? r.demo : {};
  for (const l of Array.isArray(d.lines) ? d.lines : []) {
    if (out.demo.lines.length >= SITE_DEMO_MAX) break;
    const en = str(l && l.en, 160).trim();
    const zh = str(l && l.zh, 120).trim();
    if (!en || !zh) continue;
    out.demo.lines.push({ en, zh, label: str(l && l.label, 40).trim() });
  }
  const iv = Number(d.intervalMs);
  out.demo.intervalMs = Number.isFinite(iv) ? Math.min(10000, Math.max(2500, Math.round(iv))) : 4200;
  return { content: out, dropped };
}

/**
 * 網站文字裡的**系統事實**要與系統實際行為一致，否則拒絕發布。
 *
 * 為什麼要有這一道（2026-09-18）：全站開放後台編輯之前，check-legal／check-consistency
 * 會拿 HTML 裡的文字去比對程式碼（免費分鐘數、裝置數、價格）。那些檢查**只讀預設值**——
 * 後台發布的覆寫文字它們看不到。開放編輯之後，把「15 分鐘」改成「30 分鐘」、
 * 「3 台」改成「5 台」、「NT$49」改成「NT$39」都會直接上線，而那是在收錢的頁面上說謊。
 *
 * 只抓三種寫法，刻意不做成通用的「數字檢查」——那會連「一分鐘完成安裝」都擋掉：
 *   · 同一段文字提到「免費／試用／試看」時的「N 分鐘」→ N 必須是登入或遊客的免費分鐘數
 *   · 「N 台裝置」「同時最多 N 台」→ N 必須是 MAX_DEVICES
 *   · 「NT$N」→ N 必須是某個方案的牌價或目前的實際售價
 */
function siteFactProblems(content, ops) {
  const ft = REMOTE_CONFIG.freeTier || {};
  const mins = new Set([Math.round((ft.seconds || 900) / 60), Math.round((ft.guestSeconds || 300) / 60)]);
  const prices = new Set([WEEKEND_PRICE, PRICE_FIRST_HALF, PRICE_SECOND_HALF]);
  for (const [k, v] of Object.entries(PLANS)) {
    if (v.price > 0) prices.add(v.price);
    try { const lp = planPrice(k, ops || {}); if (lp > 0) prices.add(lp); } catch (e) { /* 沒有覆寫就用牌價 */ }
  }
  const out = [];
  for (const [k, t] of Object.entries((content && content.texts) || {})) {
    const text = String(t);
    if (/免費|試用|試看/.test(text)) {
      for (const m of text.matchAll(/(\d+)\s*分鐘/g)) {
        if (!mins.has(Number(m[1]))) out.push(`${k}：免費試用寫「${m[1]} 分鐘」，系統實際是 ${[...mins].join('／')} 分鐘`);
      }
    }
    for (const m of text.matchAll(/(?:同時最多|最多可在)?\s*(\d+)\s*台(?:裝置)?/g)) {
      if (!/裝置|同時/.test(text)) break;
      if (Number(m[1]) !== MAX_DEVICES) out.push(`${k}：寫「${m[1]} 台」，系統實際上限是 ${MAX_DEVICES} 台裝置`);
    }
    for (const m of text.matchAll(/NT\$\s?(\d[\d,]*)/g)) {
      const n = Number(m[1].replace(/,/g, ''));
      if (!prices.has(n)) out.push(`${k}：寫「NT$${m[1]}」，沒有任何方案是這個價格（${[...prices].sort((a, b) => a - b).join('、')}）`);
    }
  }
  return out;
}

/** 公開讀取：先查邊緣快取，沒有才讀 KV。首頁每位訪客都會打一次，不能每次都讀 KV。 */
async function readSiteContentPublic(env) {
  const cacheKey = new Request('https://api.pitlingo.com/__cache/site-content');
  let cache = null;
  try { cache = caches.default; } catch (e) { cache = null; }
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit.json();
  }
  let content = null;
  try { content = JSON.parse((await env.SUBS.get(SITE_CONTENT_KEY)) || 'null'); } catch (e) { content = null; }
  const body = { ok: true, content };
  if (cache) {
    await cache.put(cacheKey, new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${SITE_CACHE_SEC}` },
    })).catch(() => {});
  }
  return body;
}

async function purgeSiteCache() {
  try { await caches.default.delete(new Request('https://api.pitlingo.com/__cache/site-content')); } catch (e) { /* 只清得到本機房，其他機房靠 30 秒過期 */ }
}

/** 發布一份新內容。舊的那份推進歷史（保留 20 份），任何一次都能還原。 */
async function publishSiteContent(env, content, who, note) {
  let prev = null;
  try { prev = JSON.parse((await env.SUBS.get(SITE_CONTENT_KEY)) || 'null'); } catch (e) { prev = null; }
  let hist = [];
  try { hist = JSON.parse((await env.SUBS.get(SITE_HISTORY_KEY)) || '[]'); } catch (e) { hist = []; }
  if (prev) hist.unshift(prev);
  hist = hist.slice(0, SITE_HISTORY_MAX);
  const next = {
    ...content,
    version: ((prev && prev.version) || 0) + 1,
    publishedAt: nowSec(),
    publishedBy: String(who || '').slice(0, 60),
    note: String(note || '').slice(0, 120),
  };
  // ⚠️ 先寫歷史再寫本體：中途失敗時最壞是「歷史多一份」，不會是「舊版本不見了」
  await env.SUBS.put(SITE_HISTORY_KEY, JSON.stringify(hist));
  await env.SUBS.put(SITE_CONTENT_KEY, JSON.stringify(next));
  await purgeSiteCache();
  return next;
}

// ---- 模擬畫面的候選句：從翻譯清單挑「看得出是 F1 精彩時刻」的句子 ----
//
// ⚠️ 共用快取的鍵是 normKey 過的英文（全小寫、沒有標點），直接顯示很難看。
//    這裡只做「看起來像樣」的整理，**最後由使用者勾選、可以改字**——
//    自動挑選只是省去翻上萬句的時間，不是替他決定。
const DEMO_KEYWORDS = {
  'lights out': 6, 'safety car': 6, 'virtual safety car': 6, 'red flag': 6, 'chequered flag': 6,
  'pole position': 6, 'fastest lap': 6, 'undercut': 6, 'overcut': 6, 'world champion': 6,
  'pole': 5, 'podium': 5, 'championship': 5, 'track limits': 5, 'penalty': 5, 'drs': 5,
  'overtake': 5, 'box': 4, 'pit stop': 4, 'pit': 4, 'victory': 4, 'lead': 4, 'leader': 4,
  'tyres': 3, 'tyre': 3, 'intermediates': 4, 'rain': 4, 'strategy': 4, 'purple sector': 5,
  'gap': 3, 'win': 3, 'soft': 2, 'grid': 3, 'qualifying': 2, 'q3': 3, 'crash': 3, 'contact': 3,
};
const DEMO_NAMES = {
  verstappen: 'Verstappen', hamilton: 'Hamilton', leclerc: 'Leclerc', norris: 'Norris', piastri: 'Piastri',
  russell: 'Russell', sainz: 'Sainz', alonso: 'Alonso', stroll: 'Stroll', gasly: 'Gasly', ocon: 'Ocon',
  albon: 'Albon', tsunoda: 'Tsunoda', hulkenberg: 'Hulkenberg', bottas: 'Bottas', perez: 'Perez',
  lawson: 'Lawson', bearman: 'Bearman', antonelli: 'Antonelli', hadjar: 'Hadjar', bortoleto: 'Bortoleto',
  colapinto: 'Colapinto', max: 'Max', lewis: 'Lewis', charles: 'Charles', lando: 'Lando', oscar: 'Oscar',
  george: 'George', carlos: 'Carlos', fernando: 'Fernando', ferrari: 'Ferrari', mercedes: 'Mercedes',
  mclaren: 'McLaren', williams: 'Williams', alpine: 'Alpine', haas: 'Haas', sauber: 'Sauber', audi: 'Audi',
  cadillac: 'Cadillac', drs: 'DRS', fia: 'FIA', vsc: 'VSC', f1: 'F1', q1: 'Q1', q2: 'Q2', q3: 'Q3', i: 'I',
  kimi: 'Kimi', isack: 'Isack', nico: 'Nico', yuki: 'Yuki', pierre: 'Pierre', esteban: 'Esteban', alex: 'Alex',
  lance: 'Lance', liam: 'Liam', ollie: 'Ollie', gabriel: 'Gabriel', franco: 'Franco', valtteri: 'Valtteri',
  sergio: 'Sergio',
};
const DEMO_BLOCK = /\b(radio|fuck|shit|bloody|damn|crap)\b/;

// ⚠️ **半句不要。** 字幕依時間切段，一句話常被切成兩三段——
//    「Reduced pit stop time full safety car」放在行銷頁上只會讓人覺得翻譯很破。
//    以連接詞開頭、或結尾停在冠詞／介系詞上的，多半是被切斷的片段。
const DEMO_BAD_START = new Set(['and', 'but', 'so', 'which', 'then', 'to', 'before', 'at', 'if', 'like', 'or',
  'of', 'for', 'with', 'in', 'on', 'that', 'because', 'as', 'than', 'reduced', 'once', 'ever']);
const DEMO_BAD_END = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'for', 'that', 'we', 'is', 'his', 'her',
  'their', 'with', 'in', 'on', 'at', 's', 'but', 'or', 'from', 'by', 'about', 'this', 'was', 'be', 'are', 'they']);

/** normKey 會把撇號拿掉（`he's` → `he s`）。顯示前補回常見的縮寫。 */
function demoContractions(t) {
  return t
    .replace(/\b(won|don|didn|can|isn|wasn|doesn|couldn|wouldn|shouldn|haven|hasn|aren|weren) t\b/g, "$1't")
    .replace(/\bi m\b/g, "I'm")
    .replace(/\b(he|she|we|they|you|it|that|i) ll\b/g, "$1'll")
    .replace(/\b(we|they|you) re\b/g, "$1're")
    .replace(/\b(i|we|they|you) ve\b/g, "$1've")
    .replace(/\b(i|he|she|we|they|you) d\b/g, "$1'd")
    .replace(/\b(\w+) s\b/g, "$1's");
}

function demoPrettyEn(norm) {
  let s = demoContractions(String(norm || '')).split(' ').map((w) => {
    if (DEMO_NAMES[w]) return DEMO_NAMES[w];
    if (/^p\d{1,2}$/.test(w)) return w.toUpperCase();
    return w;
  }).join(' ')
    .replace(/\bred bull\b/g, 'Red Bull').replace(/\baston martin\b/g, 'Aston Martin')
    .replace(/\bracing bulls\b/g, 'Racing Bulls')
    .replace(/\bformula one\b/g, 'Formula One').replace(/\bgrand prix\b/g, 'Grand Prix')
    .replace(/\bi'(ll|ve|d)\b/g, "I'$1");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(s) ? s : s + '.';
}

function demoScore(norm) {
  const pad = ` ${norm} `;
  let score = 0;
  for (const [kw, w] of Object.entries(DEMO_KEYWORDS)) if (pad.includes(` ${kw} `)) score += w;
  const words = String(norm || '').split(' ');
  if (DEMO_BAD_START.has(words[0])) score -= 6;
  if (DEMO_BAD_END.has(words[words.length - 1])) score -= 6;
  return score;
}

/** 這句主要在講什麼。用來避免整份清單都是同一件事（實測九成是「虛擬安全車」）。 */
function demoTopic(norm) {
  const pad = ` ${norm} `;
  let best = '';
  let bw = 0;
  for (const [kw, w] of Object.entries(DEMO_KEYWORDS)) {
    if (pad.includes(` ${kw} `) && w > bw) { best = kw; bw = w; }
  }
  return best.replace(/^virtual /, '');
}

async function demoCandidates(env) {
  const season = REMOTE_CONFIG.seasonYear || SEASON_YEAR;
  const items = (await listBundleMeta(env))
    .filter((it) => it.slug && ['race', 'quali', 'sprint', 'sq'].includes(sessionKind(slugKeyOf(it.slug), season)))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 12);                                   // ⚠️ 上限：每支 bundle 讀一次 KV，而且可能有幾百 KB

  const out = [];
  for (const it of items) {
    const b = await readBundle(env, it.cid);
    const g = scheduleList(REMOTE_CONFIG).find((x) => slugMatchesGp(slugKeyOf(it.slug), x));
    const label = `${g ? g.name + ' · ' : ''}${sessionTitle(it.slug, season)}`;
    const picked = [];
    for (const [norm, zh] of Object.entries(b.lines || {})) {
      if (typeof zh !== 'string') continue;
      const words = norm.split(' ').length;
      if (words < 5 || words > 20 || norm.length > 110 || DEMO_BLOCK.test(norm)) continue;
      if (!/[一-鿿]/.test(zh) || zh.length > 60) continue;
      // 中文也是半句的話不要（開頭是「的」「和」、或太短）
      if (/^[的和與或並而及]/.test(zh) || zh.length < 6) continue;
      if (!plausibleTranslation(norm, zh)) continue;
      const score = demoScore(norm);
      if (score < 4) continue;
      picked.push({
        en: demoPrettyEn(norm), zh, label,
        score: score + (/[。！？]$/.test(zh) ? 2 : 0),     // 中文是完整句子的優先
        topic: demoTopic(norm),
      });
    }
    picked.sort((a, b2) => b2.score - a.score);
    out.push(...picked.slice(0, 8));                 // 每支最多 8 句，避免整份清單都是同一場
  }
  // 同一個主題最多 4 句，讓清單有變化
  const perTopic = {};
  return out.sort((a, b) => b.score - a.score)
    .filter((x) => { perTopic[x.topic] = (perTopic[x.topic] || 0) + 1; return perTopic[x.topic] <= 4; })
    .slice(0, 80);
}

/**
 * 要帶 cookie 的端點（網站的登入工作階段）。
 * ⚠️ **只有這幾個**允許 credentials：允許帶 cookie 的跨來源請求，就是允許那個來源
 *    以使用者的身分呼叫我們。其他網站端點（方案、結帳、聯絡）不需要。
 */
const SITE_CRED_PATHS = new Set([
  // 報價與結帳帶登入狀態只為了一件事：老客戶續訂折扣（renewFor）。沒登入照常可買
  '/v1/quote', '/v1/checkout',
  '/v1/auth/google', '/v1/auth/email/start', '/v1/auth/email/verify', '/v1/auth/logout',
  '/v1/auth/link/claim', '/v1/account/me', '/v1/account/claim', '/v1/account/claim/verify',
  '/v1/account/license/deactivate', '/v1/account/license/reissue', '/v1/account/license/gift', '/v1/account/f1/reveal',
]);

function siteCorsFor(request, path) {
  const origin = request.headers.get('origin') || '';
  if (!SITE_ORIGINS.has(origin)) return null;
  if (!SITE_PATHS.has(path)) return null;
  return {
    ...CORS,
    'Access-Control-Allow-Origin': origin,
    // 來源不只一個，快取必須依 Origin 分開，否則 CDN 會把 A 的允許標頭回給 B
    Vary: 'Origin',
    ...(SITE_CRED_PATHS.has(path) ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
  };
}

