// ---------------------------------------------------------------------------
// 路由處理
// ---------------------------------------------------------------------------
/**
 * @param opts.paid    付費（licensed）或收割工具（legacy）：不受免費場次限制
 * @param opts.legacy  收割工具：segCount 只給收割蓋過章的那個（它靠這個決定要不要重收）
 */
async function handleGetSubs(request, env, url, opts) {
  const o = opts || {};
  const cid = url.searchParams.get('cid');
  if (!cid || !/^\d{1,20}$/.test(cid)) return err('缺少或格式錯誤的 cid');
  const bundle = await readBundle(env, cid);
  // 晚加入的觀眾（A15）：直播中 KV 最多落後房間 90 秒（寫入節奏）＋約 60 秒（KV 傳播）。
  // 最近 20 分鐘內有更新、或 KV 根本還沒有這支（直播剛開始）時，把房間裡 15 分鐘內的句子併進去——
  // 只多一次 DO 請求，不寫任何東西。重播的影片 bundle 很久沒動，不會走到這裡
  const fresh = !bundle.updatedAt || Date.now() - Date.parse(bundle.updatedAt) < 20 * 60000;
  if (fresh && env.ROOM) {
    const d = await roomOp(env, cid, { op: 'dump' });
    if (d && d.lines && typeof d.lines === 'object') {
      for (const [k, zh] of Object.entries(d.lines)) if (typeof zh === 'string' && zh && !bundle.lines[k]) bundle.lines[k] = zh;
    }
  }
  // ⚠️ 與 /v1/translate 同一條免費場次規則（security-audit run-2 #12）。以前這裡什麼都不查：
  //    /v1/translate 回 402 E31 的同一批句子，這裡照樣 200。
  //    ⚠️ 額度用完**仍然可以讀**——「已經翻過的影片仍然完全可用」是既定設計，不要加 E30。
  if (!o.paid && isFreeSlug(trustedSlug(bundle)) === false) {
    return json({ cid, lines: {}, count: 0, reason: 'not_free_session', code: 'E31',
      error: '這支影片不在免費範圍內。' }, 402);
  }
  return json({
    cid,
    count: Object.keys(bundle.lines).length,
    // segCount > 0 代表曾經有人「完整無失敗」地收割過這支影片。
    // 用戶端拿它和字幕清單的分段數比對，相同就可以完全跳過整軌預抓。
    // 一般用戶端也看「其他觀眾回報的」（clientSeg）——偽造的最壞結果只是跳過預抓；
    // 收割工具只看收割蓋的章，否則偽造的值會讓它不再重收（見 handleComplete）。
    segCount: o.legacy ? (bundle.segCount || 0) : Math.max(bundle.segCount || 0, bundle.clientSeg || 0),
    updatedAt: bundle.updatedAt,
    lines: bundle.lines,
    // ⚠️ 絕對不要在這裡放 max-age。
    //
    // 原本是 `public, max-age=60`。v1.2 那時 bundle 只有管理員會寫，一分鐘的
    // 陳舊無所謂。現在每個使用者的 /v1/translate 與 /v1/complete 都會改它，
    // 而瀏覽器的 HTTP 快取是**我們清不掉的一層**——用戶端把自己的記憶體快取
    // 作廢也沒用，fetch 仍然回舊的 body。
    //
    // 實測：01:03:06 查核（存進 HTTP 快取，segCount=0）→ 01:03:11 標記完整
    // → 01:03:48 重開，42 秒還在快取內，於是拿到 segCount=0，跳過判斷永遠
    // 不成立，整支又重抓 383 段。（handoff 坑 #26）
    //
    // 重複請求由用戶端 SW 的 90 秒記憶體快取吸收，這層不需要也不該再快取。
  }, 200, { 'cache-control': 'no-store' });
}

/**
 * 把收割端算好的「每句在影片裡第幾秒」併進 bundle.t（{ normKey: 秒 }，取到 0.1 秒）。回傳收了幾句。
 * 只收這份 bundle 裡真的有譯文的句子（垃圾鍵進不來、t 不會比 lines 大）；順手清掉譯文已經被刪掉的句子的時間。
 * 以新送來的為準（只有收割權杖／管理員寫得進來）。
 */
const LINE_TIME_MAX_SEC = 86400;
function mergeLineTimes(bundle, times) {
  const lines = bundle.lines || {};
  const t = (bundle.t && typeof bundle.t === 'object' && !Array.isArray(bundle.t)) ? bundle.t : {};
  let n = 0;
  if (times && typeof times === 'object' && !Array.isArray(times)) {
    let seen = 0;
    for (const [raw, v] of Object.entries(times)) {
      if (++seen > BUNDLE_MAX_LINES) break;
      const k = normKey(raw);
      if (!k || lines[k] === undefined) continue;
      const sec = Number(v);
      if (typeof v !== 'number' || !Number.isFinite(sec) || sec < 0 || sec > LINE_TIME_MAX_SEC) continue;
      t[k] = Math.round(sec * 10) / 10;
      n++;
    }
  }
  for (const k of Object.keys(t)) if (lines[k] === undefined) delete t[k];
  if (Object.keys(t).length) bundle.t = t; else delete bundle.t;
  return n;
}

async function handlePostSubs(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return err('body 不是合法 JSON');
  const { cid, lines, segCount } = body;
  if (!cid || !/^\d{1,20}$/.test(String(cid))) return err('缺少或格式錯誤的 cid');
  if (!lines || typeof lines !== 'object') return err('缺少 lines');

  const bundle = await readBundle(env, String(cid));
  // 只有「完整無失敗」的收割才會帶 segCount 上來，代表這份 bundle 已涵蓋整支影片
  //
  // ⚠️ **分段數相同也要接受，並記下是哪個版本蓋的章**（2026-09-18）。
  //    以前只接受「比較大」的——重新驗證一支舊版標記的影片時，分段數一樣，
  //    這一步什麼都不做，於是永遠分不出「新版確認過」與「舊版蓋的、可能缺句」。
  // ⚠️ 收割可以**往下修正**（security-audit run-2 #11）：以前只收「比較大」的，被灌過大的值就修不回來。
  if (typeof segCount === 'number' && segCount > 0 && segCount < 100000) {
    bundle.segCount = segCount;
    const v = String(body.v || '').slice(0, 16);
    // 管理版擴充功能蓋的章帶 `ext-` 前綴（版本號跟 userscript 是兩條線，不能拿同一個門檻比）
    if (/^(ext-)?\d+\.\d+\.\d+$/.test(v)) bundle.markV = v;
  }
  // 網址後綴：後台的翻譯清單靠它分辨這是哪一場的哪個場次。
  // 只在還沒有的時候寫入——先到先得，避免不同來源互相覆蓋。
  const slug = String(body.slug || '').slice(0, 120);

  // ⚠️ **「這支沒有字幕」要另外記，不要寫成一份空的 bundle。**
  //    空 bundle 會混進翻譯清單，看起來像「收割失敗」，
  //    而那兩件事該做的處理完全不同。
  if (body.noSubtitles) {
    try { await noteNoSubtitles(env, String(cid), slug); } catch (e) { /* 統計失敗不擋 */ }
    return json({ ok: true, noSubtitles: true });
  }
  // 收割寫的後綴是可信的，**可以蓋掉用戶端給的**（security-audit run-2 #9）
  if (slug && (!bundle.slug || bundle.slugBy === 'client')) { bundle.slug = slug; bundle.slugBy = 'harvest'; }
  let added = 0;
  let rejected = 0;
  for (const [rawKey, zh] of Object.entries(lines)) {
    if (typeof zh !== 'string' || !zh) continue;
    const k = normKey(rawKey);
    if (!k) continue;
    // ⚠️ **收割上傳也要過同一道門。**
    //    這條路需要 ADMIN_TOKEN，所以以前直接信任——但它是**大量、未經過目**的
    //    寫入，而共用快取是所有人共用的：一句垃圾會顯示給每一個看那支影片的人。
    //    後台的「掃描可疑譯文」之所以存在，就是因為這道門以前沒關。
    if (!plausibleTranslation(rawKey, zh)) { rejected++; continue; }
    if (bundle.lines[k] === zh) continue;
    if (Object.keys(bundle.lines).length >= BUNDLE_MAX_LINES) break;
    bundle.lines[k] = zh;
    added++;
  }
  // 每句在影片裡的秒數（2026-11-06，Ray：「翻譯清單能否有時間軸」→「要做」）：管理版收割蓋章時一起帶上，
  // 搭這一次本來就要寫的 KV，不多寫。只給後台看，GET /v1/subs 不回（用戶端不需要、也不必多下載）。
  const timed = mergeLineTimes(bundle, body.times);
  await writeBundle(env, String(cid), bundle);
  // 收割上傳不經過翻譯統計，要自己觸發 KV 計數落地（每累積 40 次寫入落地一次＝多 2.5% 的寫入）
  if (kvOps.put >= 40) { try { await flushStats(env); } catch (e) { /* 統計不該影響主流程 */ } }
  return json({
    ok: true, cid: String(cid), added, rejected, timed,
    total: Object.keys(bundle.lines).length,
    segCount: bundle.segCount || 0,
  });
}

/**
 * 翻譯未命中的句子。
 *
 * ⚠️ 這裡的 KV 寫入次數是整個系統最容易爆掉的地方。
 * 初版是「每翻一句寫一個 line: key」，實測一場 550 句就寫了 550 次——
 * 免費額度只有 1,000 puts/天，一場正賽（約 2,000 句）光一個觀看者就超額兩倍，
 * 之後所有寫入回 429，表現為用戶端連續拿到 HTTP 500。
 *
 * 改成「讀一次 bundle、寫一次 bundle」：一次請求固定 1 put，
 * 一場正賽約 140 puts。
 *
 * 併發時的 read-modify-write 可能掉幾句（多人同時看同一支全新內容），
 * 但那只是那幾句之後會被重翻一次，不影響正確性。
 */
/**
 * 認領一句話的翻譯權。回傳 true 代表「這句由我翻」。
 *
 * 為什麼用 Cache API 不用 KV：見 `handleTranslate` 裡的說明（KV 寫入額度）。
 *
 * ⚠️ **失敗一律回 true（放行）。** 這是刻意的：去重是省錢的優化，
 *    不是正確性的要件。Cache API 不可用時最壞就是回到現在的行為（重複翻），
 *    而如果寫成「失敗就不翻」，一個機房的 cache 出問題就會讓那裡的
 *    所有使用者完全沒有字幕——用省錢的機制製造出功能性故障是不能接受的。
 */
const CLAIM_TTL_SEC = 25;

/**
 * 急件的「認領但不放棄」等待預算（毫秒）。
 *
 * ⚠️ **這個數字是在兩個壞結果之間取平衡，不是隨便挑的。**
 *    等太短：認領者的模型還沒回來，白等一趟照樣自己翻（回到 N 倍成本）
 *    等太長：使用者盯著空白字幕，而直播每 3~4 秒就換一句
 *
 *    模型回應實測 1~2 秒。900ms 抓得到「認領者已經寫回快取」的那一部分；
 *    抓不到的仍然自己翻——**最壞情況與改動前完全相同**。
 */
const URGENT_WAIT_MS = 2200;
/** 等待期間重讀共用快取的次數。KV 讀取免費額度 100k/天，這點量無所謂。 */
const URGENT_POLLS = 6;

