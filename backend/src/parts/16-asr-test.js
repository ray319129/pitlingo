// ---------------------------------------------------------------------------
// 語音辨識字幕 —— **測試專用**（2026-09-17）
//
// ⚠️ **這一整段只存在於測試後端（f1zh-api-test）。** 正式後端（api.pitlingo.com）由
//    tools/build-backend.js 建置時整段移除（使用者 2026-09-17 決定：測試端點不放正式後端）。
//
// 只給擴充功能**測試版**用（正式版沒有擷取聲音的程式碼與權限）。
// 沒有設定 ASR_TEST_KEY，或請求沒帶對的金鑰，一律回 404——**對外看起來這個端點不存在**。
//
// 需要的機密（wrangler secret put）：
//   ASR_TEST_KEY        測試版設定頁填的那一組，自己想一個長字串
//   DEEPGRAM_API_KEY    （擇一，優先）Deepgram Nova-3，有逐句時間
//   OPENAI_API_KEY      （擇一）OpenAI whisper-1 verbose_json，有逐段時間
// 選填 vars：ASR_DAILY_MINUTES（每日辨識分鐘上限，預設 120）
//
// ⚠️ **辨識結果不寫進共用快取。** 語音辨識的英文與官方 CC 不會逐字相同，
//    混進同一個 bundle 會讓同一支影片出現兩種英文、兩份譯文（handoff 9.1 #21）。
// ⚠️ 每日用量用 Cache API 記（每 5 秒一段，寫 KV 一小時就是 720 次，會撞 1,000 次／天的上限）。
//    Cache API 是每個機房各一份，所以上限是**近似值**——測試用夠了，正式功能要換成 DO。
// ---------------------------------------------------------------------------
const ASR_MAX_BYTES = 2 * 1024 * 1024;        // 16 kHz 單聲道 16-bit 約 65 秒
const ASR_WAV_BYTES_PER_SEC = 32000;
const ASR_MAX_LINE_LEN = 1000;               // 與翻譯端點的單句上限相同（那一個是 handleTranslate 裡的區域常數）
// 語音辨識模型在靜音、音樂、群眾噪音時會「聽出」不存在的句子。這些是最常見的幾種。
const ASR_HALLUCINATION = /thank(s| you) for watching|please subscribe|like and subscribe|subtitles by|amara\.org|^\W*$|^(you|bye|okay|thank you)\.?$/i;
// 給辨識模型的提示詞：車手與車隊名稱是錯誤率最高的地方
const ASR_KEYTERMS = ['Verstappen', 'Leclerc', 'Hamilton', 'Norris', 'Piastri', 'Russell', 'Antonelli', 'Alonso',
  'Stroll', 'Gasly', 'Colapinto', 'Albon', 'Sainz', 'Lawson', 'Lindblad', 'Hulkenberg', 'Bortoleto', 'Ocon',
  'Bearman', 'Perez', 'Bottas', 'Hadjar', 'McLaren', 'Ferrari', 'Mercedes', 'Red Bull', 'Aston Martin', 'Alpine',
  'Williams', 'Racing Bulls', 'Audi', 'Haas', 'Cadillac', 'DRS', 'undercut', 'overcut', 'safety car', 'pit lane'];

function asrUsageKey() {
  return `https://pitlingo-internal/asr-usage/${new Date().toISOString().slice(0, 10)}`;
}
async function asrUsedSec() {
  try {
    if (typeof caches === 'undefined') return 0;
    const r = await caches.default.match(asrUsageKey());
    return r ? Number(await r.text()) || 0 : 0;
  } catch (e) { return 0; }
}
async function asrAddSec(sec) {
  try {
    if (typeof caches === 'undefined') return;
    const cur = await asrUsedSec();
    await caches.default.put(asrUsageKey(), new Response(String(cur + sec), {
      headers: { 'cache-control': 'max-age=172800' },
    }));
  } catch (e) { /* 記不起來不擋辨識 */ }
}

/** Deepgram：逐句（utterances）帶時間。 */
/** 把服務回傳的逐字資料整理成 { w, start, end, c }。w 是帶標點與大小寫的字。 */
function asrWordsFrom(list) {
  return (list || []).map((x) => ({
    w: String(x.punctuated_word || x.word || '').trim(),
    start: Number(x.start) || 0,
    end: Number(x.end) || 0,
    c: x.confidence === undefined ? null : Number(x.confidence),
  })).filter((x) => x.w);
}

async function asrDeepgram(env, audio) {
  const q = new URLSearchParams({ model: 'nova-3', language: 'en', smart_format: 'true', punctuate: 'true', utterances: 'true' });
  for (const t of ASR_KEYTERMS) q.append('keyterm', t);
  const r = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
    method: 'POST',
    headers: { authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'content-type': 'audio/wav' },
    body: audio,
  });
  if (!r.ok) throw new Error(`Deepgram HTTP ${r.status}：${(await r.text()).slice(0, 160)}`);
  const d = await r.json();
  const utt = (d.results && d.results.utterances) || [];
  const alt = d.results && d.results.channels && d.results.channels[0] && d.results.channels[0].alternatives
    && d.results.channels[0].alternatives[0];
  // 逐字時間（收割逐字稿用）：整段的字比 utterances 裡的完整，優先用它
  const words = asrWordsFrom((alt && alt.words && alt.words.length) ? alt.words
    : utt.reduce((a, u) => a.concat(u.words || []), []));
  if (utt.length) {
    // 低信心的不在這裡丟：交給 handleAsrTest 統一過濾，dropped 才數得到（診斷要看得出丟了多少）
    const segs = utt.map((u) => ({
      start: Number(u.start) || 0, end: Number(u.end) || 0, en: String(u.transcript || '').trim(),
      weak: u.confidence !== undefined && u.confidence < 0.4,
    }));
    segs.words = words;
    return segs;
  }
  if (!alt || !alt.transcript) { const none = []; none.words = words; return none; }
  const w = alt.words || [];
  const one = [{ start: w.length ? w[0].start : 0, end: w.length ? w[w.length - 1].end : 0, en: String(alt.transcript).trim() }];
  one.words = words;
  return one;
}

/** OpenAI whisper-1：verbose_json 的 segments 帶時間與「不是講話」的機率。 */
async function asrOpenAI(env, audio) {
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: 'audio/wav' }), 'chunk.wav');
  fd.append('model', 'whisper-1');
  fd.append('language', 'en');
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'segment');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('prompt', 'Formula 1 race commentary. ' + ASR_KEYTERMS.join(', ') + '.');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: fd,
  });
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}：${(await r.text()).slice(0, 160)}`);
  const d = await r.json();
  const segs = (d.segments || []).map((x) => ({
    start: Number(x.start) || 0, end: Number(x.end) || 0, en: String(x.text || '').trim(),
    weak: Number(x.no_speech_prob) > 0.6,   // 多半不是講話（音樂、群眾噪音）
  }));
  segs.words = asrWordsFrom(d.words);
  return segs;
}

async function handleAsrTest(request, env) {
  // 沒開、金鑰不對：一律 404，不透露端點存在
  if (!env.ASR_TEST_KEY || !safeEqual(request.headers.get('x-asr-key') || '', env.ASR_TEST_KEY)) {
    return err('not found', 404);
  }
  const provider = env.DEEPGRAM_API_KEY ? 'deepgram' : env.OPENAI_API_KEY ? 'openai' : '';
  if (!provider) return err('尚未設定語音辨識服務的金鑰（DEEPGRAM_API_KEY 或 OPENAI_API_KEY）', 503, 'E70');
  if (await overBudget(env)) return err('今日成本已達上限，語音辨識暫停', 503, 'E40');

  // 收割逐字稿時：每段不翻譯（整份收完再一起翻，有上下文也比較省），而且要逐字時間才接得起段與段
  const q = new URL(request.url).searchParams;
  const wantTranslate = q.get('translate') !== '0';
  const wantWords = q.get('words') === '1';

  const audio = await request.arrayBuffer();
  if (audio.byteLength < 1000) return err('音訊太短', 400, 'E71');
  if (audio.byteLength > ASR_MAX_BYTES) return err('音訊段太長（上限約 60 秒）', 413, 'E71');
  const audioSec = Math.max(0, (audio.byteLength - 44) / ASR_WAV_BYTES_PER_SEC);

  const capSec = (Number(env.ASR_DAILY_MINUTES) || 120) * 60;
  const usedBefore = await asrUsedSec();
  if (usedBefore + audioSec > capSec) {
    return json({ ok: false, error: `今日語音辨識已用 ${Math.round(usedBefore / 60)} 分鐘，達上限`, code: 'E72', usedSec: usedBefore, capSec }, 429);
  }

  const t0 = Date.now();
  let segs;
  try {
    segs = provider === 'deepgram' ? await asrDeepgram(env, audio) : await asrOpenAI(env, audio);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e), code: 'E73', provider }, 502);
  }
  const asrMs = Date.now() - t0;
  await asrAddSec(audioSec);

  const clean = segs
    .filter((x) => !x.weak)
    .map((x) => ({ start: x.start, end: Math.max(x.end, x.start + 0.5), en: x.en.replace(/\s+/g, ' ').trim() }))
    .filter((x) => x.en.length >= 2 && x.en.length <= ASR_MAX_LINE_LEN && !ASR_HALLUCINATION.test(x.en));
  const dropped = segs.length - clean.length;

  let trMs = 0;
  let usage = null;
  if (!wantTranslate) for (const x of clean) x.zh = '';
  if (clean.length && wantTranslate) {
    const t1 = Date.now();
    try {
      const r = await translateBatch(env, clean.map((x) => x.en));
      usage = r.usage || null;
      // 記進成本統計：熔斷（DAILY_USD_CAP）才算得到這筆，後台也看得到
      if (usage) recordUsage('asr-test', usage, clean.length, 0);
      for (const x of clean) {
        const zh = r.out && r.out[x.en];
        x.zh = zh && plausibleTranslation(x.en, zh) ? zh : '';
      }
    } catch (e) {
      for (const x of clean) x.zh = '';
    }
    trMs = Date.now() - t1;
  }

  return json({
    ok: true, provider, audioSec: +audioSec.toFixed(2), asrMs, trMs, dropped,
    segments: clean, usedSec: Math.round(usedBefore + audioSec), capSec,
    usage,
    // 幻覺句的字也要拿掉，否則收割時「Thank you for watching」會從逐字資料繞回逐字稿
    words: wantWords ? asrWordsOutsideHallucinations(segs, segs.words || []) : undefined,
  });
}

/** 落在被判定為幻覺或低信心的句子時段內的字一律丟掉。 */
function asrWordsOutsideHallucinations(segs, words) {
  const bad = segs.filter((x) => x.weak || ASR_HALLUCINATION.test(String(x.en || '').replace(/\s+/g, ' ').trim()));
  return words.filter((w) => (w.c === null || w.c >= 0.3)
    && !bad.some((b) => w.start >= b.start - 0.05 && w.end <= b.end + 0.05));
}

/** 整份逐字稿一次最多翻幾句（一次呼叫）。前端會切批。 */
const ASR_TRANSLATE_MAX_LINES = 60;

/**
 * 收割好的逐字稿整份翻譯（測試專用，2026-09-17）。
 *
 * 與 /v1/asr/test 同一把金鑰，沒有或不對一律 404。**不寫共用快取**（語音辨識的英文與官方 CC 不同，見 9.1 #21）。
 * 連續的句子放同一批，模型看得到前後文——這是「收完再翻」比「每段各翻各的」準的原因。
 */
async function handleAsrTranslate(request, env) {
  if (!env.ASR_TEST_KEY || !safeEqual(request.headers.get('x-asr-key') || '', env.ASR_TEST_KEY)) {
    return err('not found', 404);
  }
  if (await overBudget(env)) return err('今日成本已達上限，翻譯暫停', 503, 'E40');
  const b = await request.json().catch(() => null);
  const lines = b && Array.isArray(b.lines) ? b.lines.map((x) => String(x || '').replace(/\s+/g, ' ').trim()) : null;
  if (!lines || !lines.length) return err('缺少 lines', 400, 'E71');
  if (lines.length > ASR_TRANSLATE_MAX_LINES) return err(`一次最多 ${ASR_TRANSLATE_MAX_LINES} 句`, 413, 'E71');
  if (lines.some((x) => !x || x.length > ASR_MAX_LINE_LEN)) return err('有空白或過長的句子', 400, 'E71');

  const t0 = Date.now();
  let r;
  try {
    r = await translateBatch(env, lines);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e), code: 'E73' }, 502);
  }
  const usage = r.usage || {};
  recordUsage('asr-test', usage, lines.length, 0);
  const out = lines.map((en) => {
    const zh = r.out && r.out[en];
    return { en, zh: zh && plausibleTranslation(en, zh) ? zh : '' };
  });
  return json({ ok: true, out, ms: Date.now() - t0, usage, usd: +costOf(usage).toFixed(6) });
}
/* @test-only:end */

async function handleTranslate(request, env, ip, auth, ctx) {
  if (await rateLimited(env, auth.installId === 'legacy' ? ip : auth.installId)) {
    return err('請求太頻繁，請稍後再試', 429, 'E32');
  }

  // 有帶登入權杖就認出來。**免費額度會因此綁在帳號上而不是 installId**，
  // 也就是清掉瀏覽器儲存不會讓額度重來（見 checkEntitlement 的說明）。
  // ⚠️ 權杖壞掉或過期一律當成遊客，**不要回錯誤**——
  //    使用者只是額度變少，不該因為登入狀態過期就完全看不到字幕。
  if (!auth.acct) {
    // 不 strict：每個翻譯請求都多一次 DO 呼叫太貴，而這裡只決定免費額度算在誰身上
    const sess = await verifySession(env, request.headers.get('authorization'));
    if (sess) auth = Object.assign({}, auth, { acct: sess.sub });
  }

  // 成本熔斷：超過當日上限就停掉會花錢的路徑。
  // **共用快取的讀取不受影響**——已翻好的影片完全照常，
  // 退化的只是「新影片暫時不翻」，不是整個壞掉。
  if (await overBudget(env, auth.harvest)) {
    return json({
      lines: {}, translated: 0,
      error: auth.harvest
        ? '今日收割成本已達上限（HARVEST_USD_CAP），使用者的翻譯不受影響'
        : '今日翻譯額度已用盡，已翻譯過的影片仍可正常觀看',
      overBudget: true,
      code: auth.harvest ? 'E80' : 'E40',
    }, 503);
  }

  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON', 400, 'E10');
  const cid = String(body.cid || 'misc');
  // ⚠️ **沒有真的影片編號時，照翻但不進共用快取、不進直播房間。**（2026-09-17）
  //    擴充功能在網址還沒解析出 contentId 的那一兩秒送出的批次 cid 是 null，
  //    sw.js 補成 'misc'——於是好幾支影片的譯文混寫進同一個叫 misc 的 bundle（實測 956 句），
  //    真正那支影片的快取反而缺這些句子（下一個觀眾再付一次錢），
  //    而所有沒有編號的觀眾被放進同一個 DO 房間互相「讓路」。
  //    F1TV 的 contentId 一律是數字；不是數字就只服務這一次請求。
  const shared = /^\d{1,20}$/.test(cid);
  if (!shared && auth.harvest && body.live === true) await leaderNoCidAlert(env, cid);
  const input = Array.isArray(body.lines) ? body.lines : [];
  if (!input.length) return err('缺少 lines', 400, 'E11');

  // ⚠️ 授權閘門。用戶端的檢查只是 UI，**這裡才是真正的牆**。
  const gate = await checkEntitlement(env, auth, request, input.length);
  if (!gate.allowed) {
    return json({
      lines: {}, translated: 0,
      error: gate.reason === 'revoked'
        ? '這組授權已停用。如有疑問請聯絡客服。'
        : '免費額度今日已用完。已翻譯過的影片仍可正常觀看，或購買 Season 解除限制。',
      reason: gate.reason,
      plan: gate.plan,
      code: gate.reason === 'revoked' ? 'E21' : 'E30',
    }, 402);
  }
  if (input.length > 200) return err('一次最多 200 句', 400, 'E12');

  // 每句的長度上限。沒有這個限制的話，200 句 × 每句 100KB = 20MB 進模型，
  // 一次請求就能燒掉大量 token —— **成本放大攻擊**。
  // 真實字幕一句不會超過 300 字元，1,000 已經非常寬鬆。
  //
  // ⚠️ **只丟掉超長的那幾句，不要整批退回。**
  //    舊版是整批 400。防成本放大的效果一模一樣（超長的那句同樣沒進模型），
  //    但代價完全不同：F1TV 偶爾會把整段節目介紹塞進字幕容器，
  //    那一句就會讓**同批 199 句正常字幕一起被拒**，
  //    使用者看到的是「不可超過 1000 字元」然後整段沒有字幕——
  //    一個與他無關、也無從處理的錯誤訊息。
  const MAX_LINE_LEN = 1000;
  const tooLong = input.filter((l) => typeof l === 'string' && l.length > MAX_LINE_LEN).length;
  const lines2 = tooLong
    ? input.filter((l) => !(typeof l === 'string' && l.length > MAX_LINE_LEN))
    : input;
  // 整批都是超長的才算真的有問題（那不像字幕，像是有人在灌資料）
  if (!lines2.length) {
    return err(`整批字幕都超過 ${MAX_LINE_LEN} 字元，已全數略過`, 400, 'E13');
  }

  // 1) 讀一次 bundle 當快取（取代先前逐句讀 line: key）
  const bundle = shared ? await readBundle(env, cid) : { lines: {} };
  // ⚠️ 還沒寫出去的那一批也算數（見 bundleBuf）。少了這一步，同一個 isolate 的
  //    下一個請求會把剛翻好、還在緩衝裡的句子當成沒翻過，再翻一次。
  if (shared) {
    const buf = bufferedLines(cid);
    if (buf) for (const [k, zh] of Object.entries(buf)) if (!bundle.lines[k]) bundle.lines[k] = zh;
  }

  // 免費使用者只能翻**免費場次**的影片。見 isFreeSlug 的說明。
  // 已付費的（gate.reason === 'licensed'）與收割工具（legacy）不受這條限制。
  if (gate.reason === 'free') {
    // 用戶端寫的後綴不信（trustedSlug，security-audit run-2 #9）；沒有可信的就用這次請求自己帶的
    const known = isFreeSlug(trustedSlug(bundle) || body.slug);
    if (known === false) {
      return json({
        lines: {}, translated: 0,
        error: '這支影片不在免費範圍內。免費試看涵蓋本季的練習賽、排位賽、衝刺賽與正賽，每天登入 15 分鐘、未登入 5 分鐘。',
        reason: 'not_free_session',
        code: 'E31',
        plan: 'trial',
      }, 402);
    }
  }
  // ⚠️ **不要在這裡寫 bundle.slug。**
  //    這一份 bundle 是快照，寫回時會被 mergeWrite 重讀的那份取代，
  //    設了也會不見（這正是 2026-09-14 查出來的那個 bug）。
  //    slug 的落地統一交給 mergeWrite —— 它是這條路上唯一真的會寫 KV 的地方。
  const result = {};
  const added = {};       // 這次請求新翻出來的，寫回時只合併這些
  // 逐句紀錄（2026-10-31，見 PLOG_SRC）：每一句記下去向，請求結束時交給這支影片的房間。
  // 用 waitUntil 送、不等它——不拖慢回應（鐵則 18）。沒有影片編號的（misc）不記，房間也不共用
  const plogT0 = Date.now();
  const plog = shared ? { c: [], r: [], w: [], m: [], x: [] } : null;
  const plogMark = (src, k) => { if (plog) plog[src].push(lineHash(k)); };
  const plogAll = [];   // 這次請求的每一句（normKey 之後），沒有歸到任何去向的就是「沒拿到」
  const finish = (resp) => {
    if (!plog) return resp;
    try {
      const seen = new Set([...plog.c, ...plog.r, ...plog.w, ...plog.m, ...plog.x]);
      const d = [];
      for (const k of plogAll) {
        const h = lineHash(k);
        if (!seen.has(h)) { seen.add(h); d.push(h); }
      }
      const rec = Object.assign({
        t0: plogT0, t1: Date.now(), who: auth.harvest ? 'harvest' : String(auth.installId || '?').slice(0, 8),
        plan: gate.plan || '', live: body.live === true, ldr: body.leader === true, urg: body.urgent !== false,
      }, plog, { d });
      const p = roomOp(env, cid, { op: 'plog', rec }).catch(() => null);
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    } catch (e) { /* 紀錄失敗不影響翻譯 */ }
    return resp;
  };
  const missing = [];
  for (const raw of lines2) {
    // ⚠️ **句子裡的換行一律換成空白**（security-audit 2026-10-05 #6，本機重現過）。
    //    批次是把每句接成「1. …\n2. …」送進同一個模型 context，再用行首編號對回去。
    //    一句「x\n1. 攻擊者的中文」就能偽造出第 1 句的譯文，寫進所有人共用的快取。
    //    字幕的一句本來就是一行；normKey 也把換行當空白，所以快取鍵不變。
    const en = String(raw || '').replace(/[\r\n\u2028\u2029\u0085]+/g, ' ').trim();
    if (!en) continue;
    const k = normKey(en);
    if (!k) continue;
    plogAll.push(k);
    if (bundle.lines[k]) { result[k] = bundle.lines[k]; plogMark('c', k); continue; }
    missing.push({ en, k });
  }

  // 1.3) **先問 SubtitleRoom 有沒有人剛翻好**（直播前導收割，2026-10-06）。
  //      收割端貼直播邊緣翻、使用者延遲 45 秒——使用者的句子到的時候，答案已經在 DO 裡，
  //      不必等它寫進 KV（最多 90 秒緩衝＋約 60 秒傳播，鐵則 11）。命中的不扣額度、不花錢。
  let leaderAt = 0;
  let leaderBye = false;     // 前導端最後一次是主動離開的（bye 比最後一次心跳新）→ 不告警
  let leaderKnown = false;   // 這一次有沒有問過 SubtitleRoom（全部命中快取時沒問——不可以回「不在」，坑 #97）
  if (shared && missing.length) {
    const pk = await roomOp(env, cid, { op: 'peek', keys: missing.map((m) => m.k) });
    if (pk) {
      leaderKnown = true;
      leaderAt = Number(pk.leaderAt) || 0;
      leaderBye = (Number(pk.leaderByeAt) || 0) > leaderAt;
      const got = (pk.lines && typeof pk.lines === 'object') ? pk.lines : {};
      if (Object.keys(got).length) {
        for (const m of missing) if (got[m.k] && !result[m.k]) { result[m.k] = got[m.k]; plogMark('r', m.k); }
        const keep = missing.filter((m) => !result[m.k]);
        missing.length = 0;
        missing.push(...keep);
      }
    }
    // 直播中而前導收割端不在：通知 Ray（每 2 小時最多一次）。使用者照樣會自己翻——
    // 這是軟降級，不是壞掉——但成本會回到「每個在看的人各自翻」的老樣子。
    // 前導端自己的請求不算（它第一次送來時 DO 還沒看過它）。
    // 前導端主動離開的也不算（2026-10-24）：場次結束 Ray 先關前導端是正常操作，不是故障
    if (body.live === true && body.leader !== true && !leaderBye && (REMOTE_CONFIG.liveDelay || {}).enabled && Date.now() - leaderAt > LEADER_STALE_MS) {
      await leaderDownAlert(env, cid, leaderAt);
    }
  }
  // 付費（或收割工具）而且自稱前導收割端，才算數——免費的人自稱是收割端只會讓告警失靈
  const asLeader = body.leader === true && (gate.reason === 'licensed' || gate.reason === 'legacy');

  // 1.4) **免費額度：先預扣、再認領**（security-audit run-2 #1、#7，2026-10-06）。
  //    在 AuthGuard 裡原子地扣，並發的請求只會分到剩下的。截斷要在認領**之前**——
  //    以前先認領全部 200 句、之後才截到只剩 1 句額度，另外 199 句卡住別的觀眾 25 秒。
  //    AuthGuard 連不上就不翻（fail closed）：免費層的成本保護不能因為它暫時有事就失效。
  let freeGranted = 0;
  if (gate.reason === 'free' && missing.length) {
    const g = await quotaReserve(env, gate.quotaKeys, Math.min(missing.length, gate.allowed));
    freeGranted = g == null ? 0 : g;
    if (missing.length > freeGranted) missing.length = freeGranted;
    if (!freeGranted) {
      const out = {
        lines: result, translated: 0,
        error: g == null
          ? '翻譯服務暫時忙碌，已翻譯過的句子仍會顯示，請稍後再試'
          : '免費額度今日已用完。已翻譯過的影片仍可正常觀看，或購買 Season 解除限制。',
        reason: g == null ? 'free_quota_unavailable' : 'free_quota_exhausted',
        plan: gate.plan, code: g == null ? 'E41' : 'E30',
      };
      // 共用快取裡已經有的句子照給（額度只管「要花錢翻的」）；一句都沒有才回 402
      return finish(json(out, Object.keys(result).length ? 200 : 402));
    }
  }
  const claimed = new Set();          // 這次認領到的句子；沒翻出來的最後要放掉

  // 1.5) **直播的並發去重。**
  //
  // 直播時所有觀眾在同一秒看到同一批新的 VTT 分段，於是同時發現快取沒有、
  // 同時送同一批句子來翻。10 個人在線就是 **10 倍的錢翻同樣的內容**，
  // 而且 10 份寫回同一個 bundle（KV 沒有 CAS，還會互相覆蓋）。
  //
  // 用 **Cache API 當認領記號**，不用 KV：
  //   · KV 寫入是免費方案的天花板（1,000/天，坑 #19），不能為了去重再加寫入
  //   · Cache API 不計入 KV 額度，而且**是 per-colo 的**——這正好符合需求，
  //     同一場直播的觀眾多半連到同一個機房，去重就發生在他們之間
  //   · 認領失敗不是錯誤：讓路的人直接拿 bundle 裡現有的，
  //     幾秒後下一批請求就會看到別人翻好的結果
  //
  // TTL 只有 25 秒：認領者如果斷線或超時，最多卡住別人 25 秒，之後自動重試。
  // 寧可偶爾重複翻一次，也不要因為一個人網路慢就讓所有人都拿不到字幕。
  // ⚠️ **「現在就要用」的句子絕對不讓路。**
  //
  // 這是使用者指出的漏洞，而且他是對的：讓路的人要等別人翻完再從快取讀，
  // 而直播字幕每 3~4 秒換一句——如果那句是「現在螢幕上這一句」，
  // 等回來的時候畫面早就換過了，等於**那句對他就是沒有顯示**。
  //
  // 但不是所有句子都這麼急。兩條路徑的時間預算差了兩個數量級：
  //
  //   前瞻預譯（`ingestVtt`）  播放器提前下載的分段 → **幾十秒後**才會顯示
  //   DOM 逐句（`handleCaption`）  已經在螢幕上了 → **現在**就要
  //
  // 所以只有前瞻那條路讓步。用戶端會用 `urgent` 標出來，
  // 而**預設是急件**——沒標的一律不讓路，漏標的後果是多花錢，
  // 標錯方向的後果是使用者看不到字幕，兩者嚴重程度差很多。
  const urgent = body.urgent !== false;

  // -------------------------------------------------------------------------
  // 急件也要去重——但**不可以用「讓路」的方式**。
  //
  // ⚠️ **直播時每一個請求都是急件**（用戶端的 `state.isLive` 會強制標記），
  //    而舊版的去重只跑在非急件上。也就是說：**專門為了解決
  //    「N 個觀眾同時看＝N 倍的錢」而建的機制，正好在直播時完全不啟動。**
  //
  //    線上實測（2026-09-15，對正式環境跑真的併發）：
  //      非急件　9 個同時請求 × 8 句 → 模型翻 8 句（去重生效）
  //      急件　　9 個同時請求 × 8 句 → 模型翻 72 句（**9 倍**）
  //
  // ⚠️ **不可以把用戶端的 `state.isLive` 拿掉。** 那個標記是刻意的，
  //    理由寫在 main.js：讓路的前提是「有時間等別人翻完再讀快取」，
  //    而那個前提來自重播的 47 秒提前量；直播沒有，讓路等於放棄那一句。
  //    實測過的後果是回覆率掉到 16~34%，字幕斷斷續續。
  //
  // 所以這裡的做法是「認領但不放棄」：
  //   認領到的 → 自己翻（與以前一樣）
  //   沒認領到 → **短暫等待後重讀共用快取**，拿得到就用
  //   等不到　 → 還是自己翻（fail-open）
  //
  // 最好的情況：N 個觀眾只花 1 次模型呼叫。
  // 最壞的情況：與改動前一模一樣。**沒有人會因為這個改動而少看到字幕。**
  let urgentWaited = 0;
  if (missing.length && urgent && shared) {
    const mine = await claimKeys(env, cid, missing.map((m) => m.k));
    for (const k of mine) claimed.add(k);
    const others = missing.filter((m) => !mine.has(m.k));
    if (others.length) {
      // ⚠️⚠️ **不要改成「掛在 DO 上等通知」。試過了，更糟。**
      //
      //    推論是這樣的：KV 是最終一致的（Cloudflare 文件明寫「寫入後
      //    數十秒仍可能讀到舊值」），所以輪詢 KV 的等待者應該常常白等；
      //    DO 強一致又單執行緒，翻好就能立刻叫醒等待者。聽起來完全合理。
      //
      //    **實測（100 個並發，對正式環境）：**
      //      輪詢 KV      牆鐘 4,454ms · 送達 800/800 · 0 個錯誤 · p99 4,452ms
      //      掛在 DO 上   牆鐘 9,242ms · 送達 688/800 · 14 個錯誤 · p99 9,236ms
      //
      //    原因：**DO 是單執行緒的。** 100 個請求同時掛在同一個實例上，
      //    它就從「協調者」變成「序列化瓶頸」——為了修一致性，
      //    製造了一個更嚴重的排隊問題。
      //
      //    DO 適合做**又短又快**的認領（claim），不適合被拿來當通知通道。
      //    真正該降低延遲的地方是**讓 100 個請求不要同時到**（用戶端的抖動），
      //    而不是讓它們在伺服器上排隊。
      //
      // ⚠️ **但只輪詢 KV 幾乎等不到**（2026-10-16 模擬，handoff 6.2 S1）：譯文要等緩衝滿 120 句
      //    或 90 秒才寫進 KV，2.2 秒內不會出現——沒認領到的人最後幾乎都自己翻
      //    （所有人貼邊緣看時：30 人 2.8 倍、100 人 6.1 倍的錢）。所以補兩個**不掛著等**的來源：
      //      1. 每一輪也看本 isolate 的緩衝（`bufferedLines`，記憶體，不花任何請求）
      //         ——認領者在同一個 isolate 時立刻拿得到
      //      2. 輪詢完還缺的，自己翻之前**問 SubtitleRoom 一次 peek**（又短又快，問完就走，
      //         不是上面試過的「掛著等」）。認領者翻好當下就 `done` 發布，2.2 秒後多半已經在了
      const step = Math.max(1, Math.round(URGENT_WAIT_MS / URGENT_POLLS));
      for (let i = 0; i < URGENT_POLLS && others.some((m) => !result[m.k]); i++) {
        await new Promise((r) => setTimeout(r, step));
        const buf = bufferedLines(cid) || {};
        for (const m of others) if (!result[m.k] && buf[m.k]) { result[m.k] = buf[m.k]; plogMark('w', m.k); }
        if (!others.some((m) => !result[m.k])) break;
        const fresh = await readBundle(env, cid);
        for (const m of others) {
          if (!result[m.k] && fresh.lines && fresh.lines[m.k]) { result[m.k] = fresh.lines[m.k]; plogMark('w', m.k); }
        }
      }
      const still = others.filter((m) => !result[m.k]);
      if (still.length) {
        const pk = await roomOp(env, cid, { op: 'peek', keys: still.map((m) => m.k) });
        const got = (pk && pk.lines && typeof pk.lines === 'object') ? pk.lines : {};
        for (const m of still) if (got[m.k]) { result[m.k] = got[m.k]; plogMark('w', m.k); }
      }
      // ⚠️ `missing` 是 const 陣列，**只能原地改**，不可以重新指派。
      const keep = missing.filter((m) => !result[m.k]);
      urgentWaited = missing.length - keep.length;
      missing.length = 0;
      missing.push(...keep);
    }
  }

  if (missing.length && !urgent && shared) {
    // 先試 Durable Object（單執行緒，認領是原子的）。
    // 拿不到就退回 Cache API 版——去重不保證，但服務不受影響。
    const viaDO = await claimViaDO(env, cid, missing.map((m) => m.k));
    let keep;
    if (viaDO) {
      const ok = new Set(viaDO);
      for (const k of ok) claimed.add(k);
      keep = missing.filter((m) => ok.has(m.k));
    } else {
      keep = [];
      for (const m of missing) {
        if (await claimLine(cid, m.k)) keep.push(m);
      }
    }
    // 全部都被別人認領了 → 這次不翻，讓使用者拿現有的。
    // 用戶端會改去讀 bundle（一次 KV 讀取），不是重送翻譯請求。
    if (!keep.length) {
      await quotaRefund(env, gate.quotaKeys || [], freeGranted);
      return finish(json({ lines: result, translated: 0, pendingElsewhere: missing.length, retryAfterMs: 1200 }));
    }
    missing.length = 0;
    missing.push(...keep);
  }

  // 2) 未命中的才呼叫模型。
  //    免費層可能只允許一部分——**先翻的是排在前面的**，也就是使用者
  //    正在看的那一段，不是隨機丟掉。
  if (missing.length > gate.allowed) missing.length = gate.allowed;

  // 2.1) **付費使用者的每日上限**（security-audit run-2 #2）。只在真的要呼叫模型時扣，
  //      以字元計（費用跟著長度走）。超過只擋這一個人；AuthGuard 連不上時放行——
  //      付了錢的人不該因為我們的元件有事就沒字幕，全站的 DAILY_USD_CAP 熔斷仍然在。
  //      ⚠️ **直播的小批次不等預扣的結果**（和模型呼叫同時跑）：直播每一批都是「畫面上就要」的句子，
  //         多等一趟 AuthGuard 就是中文多落後一點（鐵則 18）。代價是用完的那一刻最多多翻一個小批次；
  //         用完之後這個 isolate 記住（licExhausted），下一個請求當場擋。大的請求（攻擊用的那種）照樣先扣再翻。
  let licPending = null;
  if (gate.reason === 'licensed' && missing.length && gate.quotaKeys
      && gate.quotaKeys.some((x) => licExhausted.has(x.k))) {
    if (claimed.size) await roomOp(env, cid, { op: 'release', keys: [...claimed] });
    return finish(json({
      lines: result, translated: 0,
      error: '今天這個帳號的翻譯量已達上限。已經翻好的影片仍可正常觀看，明天（台灣時間早上 8 點）恢復。',
      reason: 'licensed_quota_exhausted', code: 'E33', plan: gate.plan,
    }));
  }
  const licNeed = (gate.reason === 'licensed' && gate.quotaKeys) ? missing.reduce((a, m) => a + m.en.length, 0) : 0;
  if (licNeed && licNeed <= LICENSED_SYNC_CHARS) {
    licPending = quotaReserve(env, gate.quotaKeys, licNeed).then((g) => {
      if (g != null && g < licNeed) markLicExhausted(gate.quotaKeys);
    }).catch(() => {});
  } else if (licNeed) {
    const need = licNeed;
    const g = await quotaReserve(env, gate.quotaKeys, need);
    if (g != null && g < need) {
      markLicExhausted(gate.quotaKeys);
      let used = 0, n = 0;
      for (const m of missing) { if (used + m.en.length > g) break; used += m.en.length; n++; }
      await quotaRefund(env, gate.quotaKeys, g - used);
      missing.length = n;
      if (!n) {
        if (claimed.size) await roomOp(env, cid, { op: 'release', keys: [...claimed] });
        return finish(json({
          lines: result, translated: 0,
          error: '今天這個帳號的翻譯量已達上限。已經翻好的影片仍可正常觀看，明天（台灣時間早上 8 點）恢復。',
          reason: 'licensed_quota_exhausted', code: 'E33', plan: gate.plan,
        }));
      }
    }
  }
  let translated = 0;
  let rejected = 0;                   // 通過模型但沒通過合理性檢查、不寫入快取的數量
  // ⚠️ **四種 token 都要記**（2026-09-18 拿 Anthropic 帳單對帳發現）：
  //    以前少了 cache_creation_input_tokens，快取寫入的費用從來沒進過統計。
  const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const addUsage = (u) => {
    if (!u) return;
    usageTotals.input_tokens += u.input_tokens || 0;
    usageTotals.output_tokens += u.output_tokens || 0;
    usageTotals.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    usageTotals.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  };
  for (let i = 0; i < missing.length; i += BATCH_MAX) {
    const chunk = missing.slice(i, i + BATCH_MAX);
    try {
      const { out, usage } = await translateBatch(modelEnv(env, auth), chunk.map((m) => m.en));
      const justDone = {};             // 這一批剛翻好的，要立刻交給等待者
      for (const m of chunk) {
        const zh = out[m.en];
        if (!zh) continue;
        // ⚠️ **不合理的譯文連請求者都不給。**
        //
        //    這裡原本寫「請求者拿得到（他自己愛看什麼是他的事）」，只擋寫入快取。
        //    那句話是錯的：請求者不是在「選擇」什麼，他是一個正在看比賽的付費
        //    使用者，而模型的自言自語會直接出現在他畫面上——**實際發生過兩次**。
        //    寧可那一句沒有中文（英文原字幕還在），也不要顯示模型的內心話。
        if (!plausibleTranslation(m.en, zh)) { rejected++; plogMark('x', m.k); continue; }
        result[m.k] = zh;
        translated++;
        plogMark('m', m.k);
        bundle.lines[m.k] = zh;
        added[m.k] = zh;
        justDone[m.k] = zh;
      }
      // ⚠️ **在寫 KV 之前就交給 DO。** 正在等的人是「畫面上現在就要」的那些，
      //    多等一次 KV 寫入（再加上 KV 的最終一致性）對他們就是看不到字幕。
      //    一批一批交，不要等所有批次都翻完——分批的意義就在這裡。
      if (shared) {
        const owned = await roomPublish(env, cid, justDone, asLeader, body.slug);
        if (owned) { rememberRoomOwned(cid, justDone, owned); for (const k of owned) delete added[k]; }
      }
      addUsage(usage);
    } catch (e) {
      // 已經翻好的先存起來，不要因為後面失敗就整批丟掉
      // 失敗時已經翻好的那些**立刻寫出去**：這個請求已經出錯，不要再把它們留在記憶體裡賭下一次
      if (translated && shared) {
        try { bufferBundleLines(cid, added, body.slug); await flushBundleBuf(env, cid); } catch (e2) { /* noop */ }
      }
      // ⚠️ **失敗之前已經付的錢也要記。** 以前這裡直接 return，前面幾批成功的
      //    與這一批（拒答也收費）全部從統計裡消失——後台的成本因此比帳單低。
      addUsage(e && e.usage);
      recordUsage(cid, usageTotals, translated, input.length - missing.length);
      recordUserUsage(auth.installId, gate.plan, usageTotals, translated, input.length - missing.length);
      if (shouldFlush(env)) { try { await flushStats(env); } catch (e3) { /* 統計不該影響主流程 */ } }
      if (gate.reason === 'free') await quotaRefund(env, gate.quotaKeys, freeGranted - translated);
      await releaseUnfinished(env, cid, claimed, result);
      if (licPending) await licPending;
      return finish(json({ lines: result, translated, error: String(e.message || e) }, 502));
    }
  }

  // 3) 一次請求只寫一次 KV，而且是「重讀後合併」不是直接覆蓋。
  //    ⚠️ **沒有新句子時也要呼叫**——這支同時負責補 slug（見它自己的說明），
  //       而「整批都命中快取」正是最常見的情況。條件寫在 mergeWrite 裡面，
  //       不寫在這裡，才不會有第二個呼叫端又漏掉一次。
  // 直播時每個請求只有 3 句左右，一次一寫會在免費方案上撞牆（見 bundleBuf）
  // ⚠️ **寫共用快取失敗，不可以讓這個請求失敗。**（2026-09-25 稽核發現）
  //    譯文已經翻好、錢已經付了，使用者要的東西就在手上。這裡沒有包 try/catch，
  //    所以 KV 配額用完時（9/24 21:17 真的發生過）最外層會回 500——
  //    **模型成功了，使用者卻看不到字幕。** 快取寫不進去只是「下一個人要重付」，
  //    不該升級成「這個人現在就壞掉」。失敗的那一段已經被放回緩衝等重試。
  // ⚠️ 只為了補後綴的寫入（這次沒翻出新句子），影片本來就要有譯文才收（security-audit run-2 #4）。
  //    空白翻譯請求每換一個影片編號就永久寫一筆 bundle——不花模型費、不吃免費額度。
  //    全站每天另有上限：真正的補後綴一場比賽只有幾支影片。
  const hasContent = translated > 0 || Object.keys(bundle.lines).length > 0;
  let slugForBuf = hasContent ? body.slug : '';
  if (slugForBuf && !translated && !bundle.slug && !(bufferedLines(cid))
      && !(await kvWriteBudgetOk(env, 'slugall', 'all'))) slugForBuf = '';
  if (shared && bufferBundleLines(cid, added, slugForBuf)) {
    try { await flushBundleBuf(env, cid); } catch (e) { /* 快取寫不進去不影響本次回應 */ }
  }

  recordUsage(cid, usageTotals, translated, input.length - missing.length);
  // 每位使用者一份。直播時要回答的是「誰在燒錢」，那用 cid 分組看不出來。
  recordUserUsage(auth.installId, gate.plan, usageTotals, translated, input.length - missing.length);
  // 預扣了但沒翻出來的（模型漏回、合理性檢查擋掉、別人先翻好了）退回去
  if (gate.reason === 'free') await quotaRefund(env, gate.quotaKeys, freeGranted - translated);
  await releaseUnfinished(env, cid, claimed, result);
  // 和模型同時送出的預扣：模型回來時通常早就完成了，這裡等它只是確保它在請求結束前送達
  if (licPending) await licPending;
  if (shouldFlush(env)) { try { await flushStats(env); } catch (e) { /* 統計不該影響主流程 */ } }

  return finish(json({
    cid,
    lines: result,
    requested: input.length,
    cached: input.length - missing.length,
    translated,
    rejected,
    usage: usageTotals,
    // 前導收割端在不在（診斷報告用，畫面上不顯示）。null＝這一次沒問（全部命中快取），用戶端保留上一次的值
    leader: leaderKnown ? (!leaderBye && !!leaderAt && Date.now() - leaderAt <= LEADER_STALE_MS) : null,
  }));
}

/** leaderDownAlert 的本機記憶：這個時段處理過了就不再問 AuthGuard（見函式內說明） */
let leaderAlertSkip = { k: '', until: 0 };
let leaderNoCidSkip = 0;

/**
 * 收割端在直播中送了沒有影片編號的翻譯（2026-10-25，R18 排位）：那些句子進 misc——不共用、不進快取，
 * 觀眾看不到心跳又各自重翻，整場付兩次錢，而且沒有任何地方報錯。管理版 1.0.0 之後不會再送
 * （flushPending 擋），這裡是給舊版與沒想到的路徑的最後一道。每 2 小時最多一封；不寫 KV。
 */
async function leaderNoCidAlert(env, cid) {
  if (Date.now() < leaderNoCidSkip) return;
  leaderNoCidSkip = (Math.floor(Date.now() / 7200000) + 1) * 7200000;
  try {
    const k = 'leadernocid:' + Math.floor(Date.now() / 7200000);
    const once = await authCall(env, { op: 'once', k, ttl: 7200 });
    if (!once || !once.ok) { if (!once) leaderNoCidSkip = Date.now() + 60000; return; }
    const out = await notifyAdmin(env, '[PitLingo] 前導收割端在直播中拿不到影片編號',
      `收割端送來的直播翻譯沒有影片編號（cid=${String(cid).slice(0, 20)}）。這些譯文不會共用給觀眾、也不會進共用快取，`
      + '觀眾看不到前導端的心跳，會各自再翻一次。\n\n'
      + '處理：在收割用的電腦把 F1TV 分頁重新整理；若管理版不是最新版，先重新載入擴充功能。之後請送一份診斷。',
      { to: env.LEADER_ALERT_TO || env.REPORT_TO });
    console.log('leaderNoCidAlert: ' + JSON.stringify(out));
    if (!out || (out.mail !== 'sent' && out.webhook !== 'sent')) {
      leaderNoCidSkip = Date.now() + 60000;
      await authCall(env, { op: 'once', k, release: true });
    }
  } catch (e) {
    console.log('leaderNoCidAlert 失敗：' + String((e && e.message) || e).slice(0, 200));
    leaderNoCidSkip = Date.now() + 60000;
  }
}

/** 直播中沒有前導收割端：寄一封信給 Ray。同一個小時只寄一次（AuthGuard once，跨機房一致）。 */
async function leaderDownAlert(env, cid, leaderAt) {
  // ⚠️ 2026-10-11 R17 實測兩個時段都沒收到信，卻完全看不出是哪一步——結果以前被丟掉了（坑 #40 的同類）。
  //    現在：寄成功才算數（失敗就把名額放回去，下一個請求再試）、結果一律印出來（wrangler tail 看得到）。
  const k = 'leaderdown3:' + Math.floor(Date.now() / 7200000);
  // ⚠️ **這個 isolate 已經處理過這個時段就不再問 AuthGuard**（2026-10-16，handoff 6.2 S4）。
  //    以前沒有前導端時，每一個直播翻譯請求都多打一次 once——兩小時只寄一封，卻每次都問，
  //    DO 請求因此多四到五成（模擬：once 佔 AuthGuard 請求的七成以上）。
  //    記在記憶體就夠了：isolate 重開最多多問一次，once 本身仍然保證只寄一封。
  //    AuthGuard 沒回應、寄信失敗時只跳過 60 秒（保留「下一個請求再試」，只是不要每個請求都試）。
  if (leaderAlertSkip.k === k && Date.now() < leaderAlertSkip.until) return;
  // ⚠️ **前導端在別的影片上不算「不在」**（2026-10-25，Ray）：節目與正式場次重疊時，Ray 決定
  //    節目跑到結束再交接（AL_PREFER_MAIN = false），那段時間正式場次的房間一定沒有心跳——
  //    照舊寄信的話**每一次重疊都是一封誤報**（R18 排位前就收到一封）。全域房間有心跳＝收割端活著、
  //    只是在別支上，不寄；60 秒後再問（交接完它就會出現在這一支）。問不到全域房間時照舊寄（寧可多寄）。
  const gl = await roomOp(env, LEADER_GLOBAL_ROOM, { op: 'peek', keys: [] });
  const glAt = gl ? Number(gl.leaderAt) || 0 : 0;
  if (glAt && Date.now() - glAt <= LEADER_STALE_MS && (Number(gl.leaderByeAt) || 0) <= glAt) {
    leaderAlertSkip = { k, until: Date.now() + 60000 };
    return;
  }
  leaderAlertSkip = { k, until: (Math.floor(Date.now() / 7200000) + 1) * 7200000 };
  try {
    const once = await authCall(env, { op: 'once', k, ttl: 7200 });
    if (!once) leaderAlertSkip = { k, until: Date.now() + 60000 };
    if (!once || !once.ok) { if (!once) console.log('leaderDownAlert: AuthGuard 無回應'); return; }
    const out = await notifyAdmin(env, '[PitLingo] 直播中，前導收割端不在',
      `有觀眾正在看直播（cid ${cid}），但前導收割端${leaderAt ? `已經 ${Math.round((Date.now() - leaderAt) / 60000)} 分鐘沒有動靜` : '這一場還沒出現過'}。\n\n`
      + '使用者照樣看得到字幕（各自翻譯），但成本會回到每個人各自翻的情況。\n'
      + '要恢復：在收割用的電腦打開這一場的 F1TV 直播（擴充功能管理版；前導模式預設開著）。',
      { to: env.LEADER_ALERT_TO || env.REPORT_TO || 'pitlingo.office@gmail.com' });
    console.log('leaderDownAlert: cid=' + cid + ' ' + JSON.stringify(out));
    if (!out || (out.mail !== 'sent' && out.webhook !== 'sent')) {
      leaderAlertSkip = { k, until: Date.now() + 60000 };
      await authCall(env, { op: 'once', k, release: true });
    }
  } catch (e) {
    console.log('leaderDownAlert 失敗：' + String((e && e.message) || e).slice(0, 200));
    leaderAlertSkip = { k, until: Date.now() + 60000 };
    try { await authCall(env, { op: 'once', k, release: true }); } catch (e2) { /* noop */ }
  }
}

/**
 * 成本後台。回答四個問題：
 *   今天花了多少？哪支影片最貴？prompt 快取還有沒有生效？共用快取的命中率？
 *
 * 第三個特別重要：prompt cache 命中率掉下來，代表 SYSTEM_PROMPT 又低於
 * 4,096 tokens 了（坑 #21），那是**每次全額計費卻不報錯**的狀態。
 */
async function handleStats(env, url) {
  const days = Math.min(31, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
  return json(await statsSummary(env, days));
}

/**
 * 成本摘要。**與 /v1/admin/stats 共用同一份計算**——每日彙報要報的數字
 * 必須和後台看到的完全一致，各算各的遲早會有一邊算錯而沒人發現。
 */
async function statsSummary(env, days) {
  const out = [];
  let total = { usd: 0, calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const kvTotal = { put: 0, del: 0, get: 0, list: 0 };

  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const key = statsKey(d);
    let day = {};
    try { day = await readStatsDay(env, key); } catch (e) { /* noop */ }
    // 今天這一格要疊上「這個 isolate 還沒落地的量」——見上面「讀取不可以觸發寫入」。
    // day 是剛剛 parse 出來的區域物件，改它不會寫回 KV。
    if (i === 0) {
      for (const [cid, r] of Object.entries(pending_.rows)) {
        const d = day[cid] || (day[cid] = {
          calls: 0, translated: 0, cached: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0,
        });
        for (const k of Object.keys(r)) d[k] = (d[k] || 0) + r[k];
      }
      const u = day.__kv || (day.__kv = { put: 0, del: 0, get: 0, list: 0 });
      u.put += kvOps.put + carry_.put; u.del += kvOps.del + carry_.del;
      u.get += kvOps.get + carry_.get; u.list += kvOps.list + carry_.list;
    }
    // ⚠️ `__kv` 是 KV 用量，不是影片。不排除的話後台會多出一支叫 __kv 的片。
    const kv = day.__kv || null;
    const vids = Object.entries(day).filter(([cid]) => cid !== '__kv').map(([cid, r]) => ({
      cid,
      usd: +costOf({
        input_tokens: r.in, output_tokens: r.out,
        cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite,
      }).toFixed(4),
      calls: r.calls, translated: r.translated, cached: r.cached,
    })).sort((a, b) => b.usd - a.usd);

    const dayUsd = vids.reduce((a, v) => a + v.usd, 0);
    if (kv) {
      kvTotal.put += kv.put || 0; kvTotal.del += kv.del || 0;
      kvTotal.get += kv.get || 0; kvTotal.list += kv.list || 0;
    }
    for (const [cid, r] of Object.entries(day)) {
      if (cid === '__kv') continue;
      total.calls += r.calls; total.translated += r.translated; total.cached += r.cached;
      total.in += r.in; total.out += r.out; total.cacheRead += r.cacheRead; total.cacheWrite += r.cacheWrite;
    }
    total.usd += dayUsd;
    out.push({
      date: key.slice(6), usd: +dayUsd.toFixed(4), videos: vids.slice(0, 10),
      kvPuts: kv ? (kv.put || 0) : null,
      // 彙報要分得出「比賽週末」與「平日」的命中率（坑 #74），所以每天的總數要帶出來
      translated: vids.reduce((a, v) => a + (v.translated || 0), 0),
      cached: vids.reduce((a, v) => a + (v.cached || 0), 0),
    });
  }

  const promptIn = total.in + total.cacheRead;
  return {
    days,
    total: {
      usd: +total.usd.toFixed(4),
      calls: total.calls,
      translated: total.translated,
      sharedCacheHits: total.cached,
      // 共用快取命中率 = 整個商業模式的分母
      sharedHitRate: (total.cached + total.translated)
        ? +(total.cached / (total.cached + total.translated)).toFixed(4) : null,
      // prompt 快取命中率：掉下來就是坑 #21 復發
      promptCacheHitRate: promptIn ? +(total.cacheRead / promptIn).toFixed(4) : null,
      usdPerTranslatedLine: total.translated ? +(total.usd / total.translated).toFixed(6) : null,
    },
    budget: {
      dailyCapUsd: Number(env.DAILY_USD_CAP || DAILY_USD_CAP_DEFAULT),
      todayUsd: +(out[0] ? out[0].usd : 0).toFixed(4),
    },
    // ⚠️ **這是下限，不是實際值。** 計數器在 isolate 記憶體裡，
    //    isolate 被回收會帶走還沒落地的那一段——真實用量只會更高。
    //    報告時一定要照這樣講，否則會有人拿它當「離天花板還很遠」的證據。
    kv: {
      todayPuts: out[0] && out[0].kvPuts != null ? out[0].kvPuts : null,
      periodPuts: kvTotal.put,
      periodGets: kvTotal.get,
      periodLists: kvTotal.list,
      periodDeletes: kvTotal.del,
      freeDailyCap: kvDailyCap(env),   // 鍵名沿用（彙報讀它）；付費方案時是每日平均含量
      paid: kvPaid(kvDailyCap(env)),
      note: '下限值（isolate 回收會漏掉未落地的部分）',
    },
    daily: out,
  };
}



