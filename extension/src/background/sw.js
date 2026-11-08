/**
 * Service Worker —— 開源版（自備 Anthropic API key，沒有任何 PitLingo 伺服器）
 *
 * 它做三件事：
 *   1. 翻譯：用使用者自己的 API key 直接呼叫 api.anthropic.com
 *   2. 本機譯文快取：同一支影片看第二次不再付錢（存在 chrome.storage.local，只在這台電腦）
 *   3. 幫 content script 抓 F1TV 的字幕清單與 VTT（CDN 跨來源，content script 自己抓會被 CORS 擋）
 *
 * ⚠️ MV3 的 SW 隨時可能被瀏覽器殺掉並重啟，**狀態一律放 chrome.storage**。
 *    模組層級的變數只是同一次生命週期內的加速，掉了不影響正確性。
 *
 * API key 只存在 chrome.storage.local（不同步、不上傳），只送給 api.anthropic.com。
 */

importScripts('/src/shared/normalize.js', '/src/shared/defaults.js', '/src/shared/prompt.js');

const PL = self.PL;
const DEFAULT_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// ---------------------------------------------------------------------------
// 設定與 API key
// ---------------------------------------------------------------------------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return PL.sanitizeSettings(settings);
}

async function getKey() {
  const { apiKey, model } = await chrome.storage.local.get(['apiKey', 'model']);
  return { key: String(apiKey || '').trim(), model: String(model || '').trim() || DEFAULT_MODEL };
}

// 第一次安裝：打開設定頁讓使用者填 API key
chrome.runtime.onInstalled.addListener((d) => {
  if (!d || d.reason !== 'install') return;
  chrome.runtime.openOptionsPage().catch(() => {});
});

// ---------------------------------------------------------------------------
// 用量（只記 token 數，給設定頁顯示「今天用了多少」；不上傳）
// ---------------------------------------------------------------------------
function dayKey() { return new Date().toISOString().slice(0, 10); }

let usageChain = Promise.resolve();
function addUsage(u) {
  if (!u) return usageChain;
  // 串起來做：三個批次同時回來時，讀→寫不會互相蓋掉
  usageChain = usageChain.then(async () => {
    const { usage } = await chrome.storage.local.get('usage');
    const day = dayKey();
    const cur = usage && usage.day === day ? usage : { day, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    cur.calls++;
    cur.input += u.input_tokens || 0;
    cur.output += u.output_tokens || 0;
    cur.cacheRead += u.cache_read_input_tokens || 0;
    cur.cacheWrite += u.cache_creation_input_tokens || 0;
    await chrome.storage.local.set({ usage: cur });
  }).catch(() => {});
  return usageChain;
}

// ---------------------------------------------------------------------------
// 呼叫模型
// ---------------------------------------------------------------------------
function describeAnthropicError(status, body) {
  let msg = '';
  try { msg = (JSON.parse(body).error || {}).message || ''; } catch (e) { /* 不是 JSON */ }
  if (status === 401) return 'API key 無效（401）。請到 PitLingo 設定頁重新貼上。';
  if (status === 403) return 'API key 沒有權限（403）' + (msg ? '：' + msg : '');
  if (status === 429) return 'Anthropic 限流（429），稍後會自動重試。';
  if (status === 529 || status === 503) return 'Anthropic 暫時過載（' + status + '），稍後會自動重試。';
  if (status === 400 && /credit/i.test(msg)) return 'Anthropic 帳戶餘額不足：' + msg;
  return `Anthropic HTTP ${status}${msg ? '：' + msg : ''}`;
}

async function callModel(userContent, maxTokens) {
  const { key, model } = await getKey();
  if (!key) { const e = new Error('還沒設定 API key。請點工具列的 PitLingo 圖示填入。'); e.noKey = true; throw e; }
  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // 從瀏覽器環境直接呼叫 Anthropic 必須帶這個標頭（否則 CORS 會被拒）
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        // system prompt 超過 4,096 tokens，cache_control 讓同一份提示在 5 分鐘內只算一次全額
        system: [{ type: 'text', text: PL.SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (e) {
    throw new Error('連不上 api.anthropic.com，請檢查網路');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(describeAnthropicError(res.status, body));
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  addUsage(data.usage);
  if (data.stop_reason === 'refusal') throw new Error('model refusal');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { text };
}

// ---------------------------------------------------------------------------
// 批次翻譯（移植自 PitLingo 後端 13-utils-batch-translate.js）
//
// 一批送「1. …\n2. …」，用行首編號對回去。模型偶爾會合併或跳過一行，
// 之後每一句就拿到下一句的譯文（「錯開一格」）——alignBreak 偵測到就把後半拆開重翻。
// ---------------------------------------------------------------------------
const ALIGN_STOP = new Set(['the', 'and', 'drs', 'vsc', 'f1tv', 'formula', 'one', 'grand', 'prix', 'pit', 'lap', 'team', 'radio', 'okay']);
const ALIGN_COMMON = new Set(('race plan will brown mad magic manual override course control clerk stop village loop farm curve curves '
  + 'square pool tunnel hairpin straight grand hotel street city strip ring club first chapel vale wall champions castle section town '
  + 'sling shot bridge memorial stadium turn triple apex long beach slam driver massive corner seat source campus kick shell puma halo '
  + 'swimming hill park moss button hunt jones boxes triangle crossover new that\'s he\'s and the bulls '
  + 'circuit international qualifying sprint practice').split(' '));
let promptNames_ = null;
function promptNames() {
  if (!promptNames_) {
    promptNames_ = new Set();
    for (const w of String(PL.SYSTEM_PROMPT).match(/\b[A-Z][a-z][A-Za-z'-]{2,}\b/g) || []) {
      const t = w.toLowerCase();
      if (!ALIGN_COMMON.has(t) && !ALIGN_STOP.has(t)) promptNames_.add(t);
    }
  }
  return promptNames_;
}

function alignTokens(s) {
  return (String(s || '').match(/[A-Za-z][A-Za-z'-]{2,}/g) || [])
    .map((t) => t.toLowerCase().replace(/'s$/, ''))
    .filter((t) => !ALIGN_STOP.has(t));
}

/** 第 i 句是不是拿到了後一句的譯文（嚴格版：只認不會誤判的訊號） */
function shiftedAt(en, zh, i, names) {
  const a = alignTokens(zh[i]);
  if (!a.length || i + 1 >= en.length) return false;
  const e0 = String(en[i]).toLowerCase(), e1 = String(en[i + 1]).toLowerCase();
  if (a.some((t) => e0.includes(t))) return false;
  if (!a.every((t) => e1.includes(t))) return false;
  const z1 = String(zh[i + 1] || '').toLowerCase();
  if (a.some((t) => z1.includes(t))) return false;
  const own = alignTokens(en[i]).filter((t) => (names.has(t) || promptNames().has(t)) && !a.includes(t));
  if (!own.length) return false;
  const z0 = String(zh[i]).toLowerCase();
  return !own.some((t) => z0.includes(t));
}

/** 這一批從第幾句起不可信（-1＝整批可信） */
function alignBreak(lines, map) {
  const n = lines.length;
  const nums = Object.keys(map).map(Number);
  if (nums.some((k) => k > n)) return 0;
  if (nums.length && !(n in map)) return 0;
  const zh = lines.map((_, i) => map[i + 1] || '');
  const names = new Set();
  for (const z of zh) for (const t of alignTokens(z)) names.add(t);
  for (let i = 0; i < n; i++) if (zh[i] && shiftedAt(lines, zh, i, names)) return i;
  return -1;
}

/** 回傳 { 英文原句: 中文 } */
async function translateBatch(lines, depth) {
  depth = depth || 0;
  // 只有一句時不走編號協定：模型會照「只輸出譯文」直接回，不加編號
  if (lines.length === 1) {
    const r = await callModel(lines[0], 200);
    return r.text ? { [lines[0]]: r.text } : {};
  }
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const { text } = await callModel(`【批次翻譯】共 ${lines.length} 句\n${numbered}`, 2500);

  // 同一個編號出現兩次＝不可信，兩個都不要
  const map = {};
  const dup = new Set();
  text.split('\n').forEach((ln) => {
    const m = ln.match(/^\s*(\d+)\s*[.、:：)]\s*(.*)$/);
    if (!m) return;
    const n = parseInt(m[1], 10);
    if (n in map) dup.add(n);
    map[n] = m[2].trim();
  });
  dup.forEach((n) => { delete map[n]; });

  // 錯開一格：從 cut 起的不收，拆成兩半重翻（同一批原樣重送多半得到同樣的錯）。
  // 最多拆兩層；到最底層還錯、剩下 ≤ 5 句就逐句翻，更多就放棄（下一輪由 content script 重新要）
  const cut = alignBreak(lines, map);
  if (cut >= 0) {
    const out = {};
    for (let i = 0; i < cut; i++) if (map[i + 1]) out[lines[i]] = map[i + 1];
    const rest = lines.slice(cut);
    const parts = rest.length === 1 ? [rest]
      : depth < 2 ? [rest.slice(0, Math.ceil(rest.length / 2)), rest.slice(Math.ceil(rest.length / 2))]
        : rest.length <= 5 ? rest.map((l) => [l]) : [];
    for (const part of parts) Object.assign(out, await translateBatch(part, depth + 1));
    return out;
  }

  const out = {};
  lines.forEach((l, i) => { if (map[i + 1]) out[l] = map[i + 1]; });
  // 一個編號都沒對上、但行數剛好相等 → 按位置對應
  if (!Object.keys(out).length) {
    const rows = text.split('\n').map((x) => x.trim()).filter(Boolean);
    if (rows.length === lines.length) {
      lines.forEach((l, i) => {
        const zh = rows[i].replace(/^\s*\d+\s*[.、:：)]\s*/, '').trim();
        if (zh) out[l] = zh;
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 本機譯文快取
//
// 每支影片一份：`c:<contentId>` → { lines: { normKey: 中文 }, segCount, at }
// 最多留 MAX_VIDEOS 支（依最近使用），避免 chrome.storage.local 的 10MB 上限被塞滿。
// segCount：整軌預抓完成時記下分段數，重看同一支影片時 content script 會跳過預抓。
// ---------------------------------------------------------------------------
const MAX_VIDEOS = 20;
const mem = new Map();          // cid -> entry（同一次生命週期內的加速）
const dirty = new Set();
let flushTimer = null;

function validCid(cid) { return /^\d{1,20}$/.test(String(cid || '')); }

async function loadEntry(cid) {
  if (mem.has(cid)) return mem.get(cid);
  const k = 'c:' + cid;
  const o = await chrome.storage.local.get(k);
  if (mem.has(cid)) return mem.get(cid);     // 等 storage 的期間別的請求已經載入
  const e = o[k] || { lines: {}, segCount: 0, at: 0 };
  mem.set(cid, e);
  return e;
}

async function touchIndex(cid) {
  const { cIdx } = await chrome.storage.local.get('cIdx');
  let idx = Array.isArray(cIdx) ? cIdx.filter((x) => x !== cid) : [];
  idx.unshift(cid);
  const drop = idx.slice(MAX_VIDEOS);
  idx = idx.slice(0, MAX_VIDEOS);
  await chrome.storage.local.set({ cIdx: idx });
  if (drop.length) {
    await chrome.storage.local.remove(drop.map((c) => 'c:' + c));
    drop.forEach((c) => mem.delete(c));
  }
}

function scheduleCacheFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const ids = Array.from(dirty);
    dirty.clear();
    for (const cid of ids) {
      const e = mem.get(cid);
      if (!e) continue;
      e.at = Date.now();
      try {
        await chrome.storage.local.set({ ['c:' + cid]: e });
        await touchIndex(cid);
      } catch (err) { /* 空間不足：這次不存，不影響翻譯 */ }
    }
  }, 2000);
}

async function getBundle(cid) {
  if (!validCid(cid)) return { lines: {}, count: 0, segCount: 0 };
  const e = await loadEntry(cid);
  return { lines: e.lines, count: Object.keys(e.lines).length, segCount: e.segCount || 0 };
}

async function cacheLines(cid, out) {
  if (!validCid(cid) || !Object.keys(out).length) return;
  const e = await loadEntry(cid);
  Object.assign(e.lines, out);
  dirty.add(cid);
  scheduleCacheFlush();
}

async function markComplete(cid, segCount) {
  if (!validCid(cid)) return { ok: false };
  const e = await loadEntry(cid);
  e.segCount = Number(segCount) || 0;
  dirty.add(cid);
  scheduleCacheFlush();
  return { ok: true, lineCount: Object.keys(e.lines).length };
}

// ---------------------------------------------------------------------------
// content script 的翻譯請求
// ---------------------------------------------------------------------------
async function translateLines(cid, lines) {
  if (!Array.isArray(lines) || !lines.length) return { lines: {} };
  const result = {};
  const missing = [];
  const seen = new Set();
  const known = validCid(cid) ? (await loadEntry(cid)).lines : {};
  for (const raw of lines.slice(0, 200)) {
    if (typeof raw !== 'string' || raw.length > 1000) continue;
    // 句子裡的換行換成空白：批次靠行首編號對回去，換行會讓一句話偽造出別句的譯文
    const en = raw.replace(/[\r\n\u2028\u2029\u0085]+/g, ' ').trim();
    const k = PL.normKey(en);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (known[k]) { result[k] = known[k]; continue; }
    missing.push({ en, k });
  }
  if (!missing.length) return { lines: result };

  let out;
  try {
    out = await translateBatch(missing.map((m) => m.en));
  } catch (e) {
    return { lines: result, error: String(e.message || e), noKey: !!e.noKey };
  }
  const fresh = {};
  for (const m of missing) {
    const zh = out[m.en];
    // 譯文守門：模型的自言自語、只剩標點、長得不像譯文的，一律不顯示也不存
    if (zh && PL.plausible(m.en, zh)) { result[m.k] = zh; fresh[m.k] = zh; }
  }
  await cacheLines(cid, fresh);
  return { lines: result, translated: Object.keys(fresh).length };
}

// ---------------------------------------------------------------------------
// F1TV 串流資源（m3u8／vtt）
//
// ⚠️ 白名單是必要的：字幕清單的網址來自 content script，而那是從 MAIN world 的
//    window.postMessage 收來的——頁面上任何腳本都能偽造。沒有白名單，
//    頁面上的第三方腳本就能讓這個擴充功能帶著使用者的 cookie 去抓任意網址。
// ---------------------------------------------------------------------------
const FETCH_ALLOW_RE = /^(ott-video[a-z0-9-]*|f1tv)\.formula1\.com$/i;
// Akamai 是所有客戶共用的網域，只能列完整主機名，不可以用 *.akamaized.net
const FETCH_ALLOW_HOSTS = new Set(['f1prodlive.akamaized.net']);

function isAllowedFetch(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return FETCH_ALLOW_RE.test(u.hostname) || FETCH_ALLOW_HOSTS.has(u.hostname.toLowerCase());
  } catch (e) { return false; }
}

async function fetchText(url) {
  if (!isAllowedFetch(url)) throw new Error('網址不在允許清單內，已拒絕');
  // priority: 'low'：字幕和影片打同一個 CDN，不讓路的話播放器會降解析度
  const res = await fetch(url, { credentials: 'include', priority: 'low' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// 設定頁用：測試 API key（會花一次很小的呼叫）
// ---------------------------------------------------------------------------
async function testKey() {
  try {
    const out = await translateBatch(['Lights out and away we go!']);
    const zh = Object.values(out)[0] || '';
    return zh ? { ok: true, sample: zh } : { ok: false, error: '模型沒有回譯文' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// 訊息通道
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 只接受自己這個擴充功能的訊息（content script 與設定頁）
  if (!sender || sender.id !== chrome.runtime.id) return false;
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'getConfig':
        case 'refreshConfig':
          // 開源版沒有遠端設定：一律用內建的（F1TV 改版時改 shared/defaults.js）
          sendResponse({ ok: true, config: PL.BUILT_IN_CONFIG });
          break;
        case 'getSettings':
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case 'getBundle':
          sendResponse({ ok: true, bundle: await getBundle(msg.cid) });
          break;
        case 'translate':
          sendResponse({ ok: true, result: await translateLines(msg.cid, msg.lines) });
          break;
        case 'markComplete':
          sendResponse({ ok: true, result: await markComplete(msg.cid, msg.segCount) });
          break;
        case 'fetchText':
          try { sendResponse({ ok: true, text: await fetchText(msg.url) }); }
          catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
          break;
        // 「有沒有授權」＝有沒有填 API key。沒有帳號、沒有免費額度
        case 'licenseStatus': {
          const { key } = await getKey();
          sendResponse({ ok: true, license: key ? { active: true, plan: 'byok' } : { active: false, reason: '尚未設定 API key' } });
          break;
        }
        case 'accountStatus':
          sendResponse({ ok: true, result: { signedIn: false } });
          break;
        case 'testKey':
          sendResponse({ ok: true, result: await testKey() });
          break;
        case 'usage': {
          const { usage, cIdx } = await chrome.storage.local.get(['usage', 'cIdx']);
          sendResponse({ ok: true, usage: usage && usage.day === dayKey() ? usage : null, videos: (cIdx || []).length });
          break;
        }
        case 'clearCache': {
          const { cIdx } = await chrome.storage.local.get('cIdx');
          await chrome.storage.local.remove((cIdx || []).map((c) => 'c:' + c).concat('cIdx'));
          mem.clear(); dirty.clear();
          sendResponse({ ok: true });
          break;
        }
        // 正式版留下的呼叫，開源版沒有伺服器可以送：直接回成功，不做任何事
        case 'metric':
        case 'translateKeepalive':
          sendResponse({ ok: true });
          break;
        case 'sendReport':
          sendResponse({ ok: false, error: '開源版沒有回報伺服器。請在 Console 執行 __pitlingo.diag() 複製診斷內容，到 GitHub 開 issue。' });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;   // 非同步 sendResponse 一定要 return true
});
