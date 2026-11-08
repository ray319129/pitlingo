/**
 * ─────────────────────────────────────────────────────────────────
 *  Durable Object：每支影片一個實例，負責「誰去翻哪幾句」
 * ─────────────────────────────────────────────────────────────────
 *
 * **為什麼非它不可**：`claimLine`（Cache API 版）是 check-then-act，
 * 而 Cache API 與 KV **都沒有 CAS**——10 個請求同時抵達時，
 * 全部會先 `match` 到空的，才依序 `put`，去重完全失效。
 * `tools/check-live-concurrency.js` 實測：10 個並發 → 10 次模型呼叫。
 *
 * DO 的特性正好對症：**同一個 id 的所有請求都排到同一個單執行緒實例**，
 * 所以「檢查再認領」在這裡是原子操作，不需要任何鎖。
 *
 * ⚠️ **這裡只做協調，絕不做翻譯。**
 *    DO 是單執行緒且**運算時間要計費**。把 Anthropic 的呼叫放進來的話：
 *      1. 第 2 個人要等第 1 個人的 API 來回（1~3 秒）才輪得到
 *      2. 那 1~3 秒的等待會被計入 GB-秒
 *    進出必須在毫秒級。
 *
 * ⚠️ 認領記錄**刻意只放記憶體**，不寫 `state.storage`。
 *    它的壽命只有 25 秒，寫進儲存等於為了一個短暫的旗標付儲存費與 IO。
 *    實例被回收時記錄跟著消失——那時最壞的後果是重複翻一次，可以接受。
 */
export class SubtitleRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.claims = new Map();          // normKey -> 到期時間（毫秒）
    this.results = new Map();         // normKey -> { zh, at } 剛翻好的那幾秒
    this.waiters = [];                // 正在等結果的請求
  }

  /**
   * 休眠醒來後，把最近幾分鐘的結果從 storage 讀回記憶體（每次醒來只讀一次），順手刪掉過期的列。
   *
   * ⚠️ **為什麼要存 storage**（2026-10-25，R18 排位後節目實測）：沒有 WebSocket 的 DO
   *    **10 秒沒有請求就休眠，記憶體整個丟掉**（官方文件 Durable Object lifecycle）。
   *    前導端每 20 秒一批、心跳 30 秒、觀眾 30～40 秒一批——房間幾乎每一輪都睡著，
   *    前導端翻好的句子在觀眾 12～40 秒後來問時已經不見了，觀眾只好自己再翻（B 自己翻 62%）。
   *    模擬器（sim-live-swarm）的假 DO 不會休眠，所以那裡一直是綠的。
   */
  async loadResults(now) {
    if (this.resultsLoaded) return;
    this.resultsLoaded = true;
    try {
      const rows = await this.state.storage.list({ prefix: 'res:' });
      const first = Math.floor((now - ROOM_RESULT_KEEP_MS) / ROOM_SLOT_MS);
      const stale = [];
      for (const [key, lines] of rows) {
        const slot = Number(key.slice(4));
        if (!(slot >= first)) { stale.push(key); continue; }
        // 每句存 [譯文, 翻好的時間]；整列都過期就刪
        let alive = 0;
        for (const [k, v] of Object.entries(lines || {})) {
          const zh = Array.isArray(v) ? v[0] : null;
          const at = Array.isArray(v) ? Number(v[1]) || 0 : 0;
          if (typeof zh !== 'string' || !zh || now - at >= ROOM_RESULT_KEEP_MS) continue;
          alive++;
          if (!this.results.has(k)) this.results.set(k, { zh, at });
        }
        if (!alive) stale.push(key);
      }
      if (stale.length) await this.state.storage.delete(stale);
    } catch (e) { /* 讀不回來只是退回「這一輪沒得共用」，與修之前一樣 */ }
  }

  /**
   * 剛翻好的寫進 storage。**一分鐘一列**（不是一句一列）：免費方案每天 10 萬列寫入，
   * 一句一列的話每句一次寫入、刪除再一次；一分鐘一列＝一次 done 一列。
   * DO 的輸入閘門保證這段「讀→改→寫」不會和別的請求交錯。
   */
  async saveResults(lines, now) {
    const stored = [];
    try {
      const slot = Math.floor(now / ROOM_SLOT_MS);
      const key = 'res:' + slot;
      if (!this.slotBuf || this.slotBuf.slot !== slot) {
        const prev = await this.state.storage.get(key);   // 醒來後同一分鐘可能已經存過
        const lines0 = (prev && typeof prev === 'object') ? prev : {};
        this.slotBuf = { slot, lines: lines0, bytes: new TextEncoder().encode(JSON.stringify(lines0)).length };
        await this.state.storage.delete('res:' + (slot - Math.ceil(ROOM_RESULT_KEEP_MS / ROOM_SLOT_MS) - 2));
      }
      const buf = this.slotBuf.lines;
      let grew = false;
      for (const [k, zh] of Object.entries(lines)) {
        if (buf[k]) continue;
        // 一列的大小要有上限（DO 的 key-value 單一值上限 128 KiB；字元數當位元組的近似，中文另外乘 3）
        const add = k.length + zh.length * 3 + 24;
        if (this.slotBuf.bytes + add > ROOM_SLOT_MAX_BYTES) break;
        buf[k] = [zh, now];
        this.slotBuf.bytes += add;
        grew = true;
        stored.push(k);
      }
      if (grew) await this.state.storage.put(key, buf);
    } catch (e) { return []; /* 寫不進去只是休眠後這一批拿不到，記憶體裡的照樣能用 */ }
    return stored;
  }

  /**
   * 共用快取（KV bundle）的寫入緩衝搬進房間（A15，2026-10-26）。
   *
   * 以前每個 isolate 各有一份緩衝（bundleBuf），滿 120 句或 90 秒才寫，而且要**同一個 isolate 再收到請求**
   * 才會檢查——請求散在多台機器上時遲遲不寫、isolate 被回收就整段丟掉。R18 排位後節目：收割端翻了約 280 句，
   * 晚 9.5 分鐘加入的 B 從 KV 只拿到 1 句（A15）。
   * 現在：房間每支影片一份、強一致，`res:` 列本來就存著剛翻好的句子（含翻好的時間）——
   * 「還沒寫進 KV 的」＝翻好時間晚於 `flushedAt` 的那些，**不需要另外存一份**。
   * 有新句子就排一個 90 秒後的 alarm，到點把它們合併寫進 KV（一支影片全站一次，不再乘 isolate 數）。
   * ⚠️ KV 寫失敗：`flushedAt` 不動、2 分鐘後再試；句子在 `res:` 裡留 15 分鐘，配額用完超過 15 分鐘才會掉
   *    （以前是 isolate 被回收就掉）。
   * ⚠️ 房間的 env.SUBS 沒有計量器（鐵則 45、43）：寫了幾次記在 `kvUnrep`，下一個 done 的回覆帶回去由 isolate 記帳。
   */
  async armFlush(now) {
    if (this.flushAt && this.flushAt > now) return;
    try {
      const cur = await this.state.storage.getAlarm();
      if (cur && cur > now) { this.flushAt = cur; return; }
      this.flushAt = now + ROOM_FLUSH_MS;
      await this.state.storage.setAlarm(this.flushAt);
    } catch (e) { this.flushAt = 0; }
  }

  async alarm() {
    const now = Date.now();
    this.flushAt = 0;
    let meta = null;
    try { meta = await this.state.storage.get(['bufCid', 'bufSlug', 'flushedAt', 'kvUnrep']); } catch (e) { meta = null; }
    const cid = meta && meta.get('bufCid');
    if (!cid || !/^\d{1,20}$/.test(String(cid))) return;
    const flushedAt = Number(meta.get('flushedAt')) || 0;
    const lines = {};
    let newest = flushedAt;
    try {
      const rows = await this.state.storage.list({ prefix: 'res:' });
      for (const [, row] of rows) {
        for (const [k, v] of Object.entries(row || {})) {
          const at = Array.isArray(v) ? Number(v[1]) || 0 : 0;
          if (at > flushedAt && typeof v[0] === 'string' && v[0]) { lines[k] = v[0]; if (at > newest) newest = at; }
        }
      }
    } catch (e) { await this.retryFlush(now); return; }
    if (!Object.keys(lines).length) return;
    try {
      const c = String(cid);
      const slug = String(meta.get('bufSlug') || '');
      await mergeWrite(this.env, c, lines, slug);
    } catch (e) { await this.retryFlush(now); return; }
    try {
      await this.state.storage.put({ flushedAt: newest, kvUnrep: (Number(meta.get('kvUnrep')) || 0) + 1 });   // mergeWrite 寫一次 KV
    } catch (e) { /* 下一輪會再寫一次同樣的句子，只多一次 KV 寫入，不會掉 */ }
  }

  async retryFlush(now) {
    try { this.flushAt = now + 120000; await this.state.storage.setAlarm(this.flushAt); } catch (e) { this.flushAt = 0; }
  }

  /** 把已經有結果的句子交給等待者，湊齊的就放行。 */
  wake() {
    const left = [];
    for (const w of this.waiters) {
      for (const k of [...w.need]) {
        const r = this.results.get(k);
        if (r) { w.have[k] = r.zh; w.need.delete(k); }
      }
      if (!w.need.size) w.resolve(w.have); else left.push(w);
    }
    this.waiters = left;
  }

  async fetch(request) {
    let body = null;
    try { body = await request.json(); } catch (e) { body = null; }
    const op = String((body && body.op) || 'claim');
    const keys = Array.isArray(body && body.keys) ? body.keys.filter((k) => typeof k === 'string' && k) : [];
    const now = Date.now();
    const reply = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

    // ---- 逐句紀錄（2026-10-31，Ray：「要有真正的數據紀錄所有事，不要再用推測的」）----------
    // 每一個翻譯請求一筆：誰、什麼時候、每一句從哪裡來（快取／房間／等到的／自己花錢翻／被擋／沒拿到）。
    // 只存句子的雜湊（lineHash），不存原文。存這支影片自己的房間 storage（不寫 KV）；PLOG_KEEP_MS 以前的順手刪掉
    if (op === 'plog') {
      const r = body && body.rec;
      if (!r || typeof r !== 'object') return reply({ ok: false });
      try {
        const k = 'plog:' + String(now).padStart(15, '0') + ':' + Math.random().toString(36).slice(2, 6);
        await this.state.storage.put(k, r);
        if (Math.random() < 0.02) {
          const old = await this.state.storage.list({ prefix: 'plog:', end: 'plog:' + String(now - PLOG_KEEP_MS).padStart(15, '0'), limit: 500 });
          if (old.size) await this.state.storage.delete([...old.keys()]);
        }
      } catch (e) { return reply({ ok: false }); }
      return reply({ ok: true });
    }
    if (op === 'plogSum') {
      try {
        const from = Number(body.from) || 0, to = Number(body.to) || now;
        const recs = [...(await this.state.storage.list({
          prefix: 'plog:', start: 'plog:' + String(from).padStart(15, '0'), end: 'plog:' + String(to + 1).padStart(15, '0'), limit: PLOG_SUM_MAX,
        })).values()];
        return reply(plogSummary(recs, body.dump === true));
      } catch (e) { return reply({ error: String((e && e.message) || e) }); }
    }

    // ---- 收割端的即時狀態（只在 LEADER_GLOBAL_ROOM，2026-10-30）-------------
    // 存 storage（DO 閒置 10 秒就休眠，鐵則 64），每張卡一個鍵；超過 HSTAT_KEEP_MS 沒更新的、超過 HSTAT_MAX 張的刪掉
    if (op === 'hstat') {
      const id = String((body && body.id) || '');
      if (!/^[a-z0-9]{1,12}-[a-z0-9]{1,12}$/.test(id) || !body.status || typeof body.status !== 'object') return reply({ ok: false });
      try {
        await this.state.storage.put('hstat:' + id, Object.assign({}, body.status, { id, at: now }));
        const all = [...(await this.state.storage.list({ prefix: 'hstat:' }))].sort((a, b) => ((b[1] && b[1].at) || 0) - ((a[1] && a[1].at) || 0));
        const drop = all.filter(([, v], i) => i >= HSTAT_MAX || !v || now - (v.at || 0) > HSTAT_KEEP_MS).map(([k]) => k);
        if (drop.length) await this.state.storage.delete(drop);
      } catch (e) { return reply({ ok: false }); }
      return reply({ ok: true });
    }
    if (op === 'hstatList') {
      try {
        const all = [...(await this.state.storage.list({ prefix: 'hstat:' }))].map(([, v]) => v)
          .filter((v) => v && now - (v.at || 0) <= HSTAT_KEEP_MS).sort((a, b) => b.at - a.at);
        return reply({ items: all, now });
      } catch (e) { return reply({ items: [], now }); }
    }

    // ---- 翻譯者把結果交回來 --------------------------------------------
    //
    // ⚠️ **這一步是整個設計的重點。** 以前等待者是去輪詢 KV，
    //    而 KV 是最終一致的——Cloudflare 自己的文件寫著
    //    「寫入後數十秒仍可能讀到舊值」。所以等待者常常等滿逾時、
    //    什麼也沒等到，最後還是自己翻一次（實測 p50 3.7 秒）。
    //    DO 是強一致而且單執行緒，結果一放進來就能立刻交出去。
    // ---- 前導收割端的心跳 ------------------------------------------------
    // ⚠️ leaderAt／leaderByeAt **要寫進 state.storage**（2026-10-24，R18 FP2）。以前只放記憶體，
    //    DO 實例被回收後歸零，下一次心跳（最多 30 秒）之前所有觀眾都讀到「前導端不在」——
    //    B 的自動診斷在 21:40 UTC 就出現過一次，運氣不好就是一封假告警。
    //    心跳每 30 秒一次，寫入節流成 60 秒一次（一場 3 小時約 180 次）；讀取只在實例剛起來時一次。
    //    差 60 秒不影響判斷：告警門檻是 LEADER_STALE_MS（3 分鐘）。
    if (this.leaderAt === undefined) {
      try {
        const s = await this.state.storage.get(['leaderAt', 'leaderByeAt']);
        this.leaderAt = Number(s.get('leaderAt')) || 0;
        this.leaderByeAt = Number(s.get('leaderByeAt')) || 0;
      } catch (e) { this.leaderAt = 0; this.leaderByeAt = 0; }
      this.leaderSavedAt = this.leaderAt;
    }
    const saveLeader = async (force) => {
      if (!force && now - (this.leaderSavedAt || 0) < 60000) return;
      this.leaderSavedAt = now;
      try { await this.state.storage.put({ leaderAt: this.leaderAt, leaderByeAt: this.leaderByeAt }); } catch (e) { /* 只是少一份備份，記憶體裡的照樣能用 */ }
    };
    if (op === 'beat') {
      const wasBye = !!this.leaderByeAt && this.leaderByeAt >= this.leaderAt;
      this.leaderAt = now;
      await saveLeader(wasBye);   // 從「離開」回來要立刻存，否則實例回收後又變回離開
      return reply({ ok: true });
    }
    // 前導端主動離開（關分頁、換影片、關掉前導模式）：記下來，觀眾那邊就不發告警
    if (op === 'bye') {
      this.leaderByeAt = now;
      await saveLeader(true);
      return reply({ ok: true });
    }

    // ---- 先看看別人剛翻好的（2026-10-06，直播前導收割）--------------------
    // ⚠️ 前導收割端翻好的句子要經過 bundleBuf（最多 90 秒）＋ KV 傳播（最多約 60 秒）才讀得到——
    //    延遲 45 秒的使用者會撲空、自己再翻一次。這裡是強一致的：收割端一翻完，所有人就拿得到。
    if (op === 'peek' || op === 'wait' || op === 'done' || op === 'dump') await this.loadResults(now);
    if (op === 'dump') {
      const have = {};
      let n = 0;
      for (const [k, r] of this.results) {
        if (now - r.at < ROOM_RESULT_KEEP_MS) { have[k] = r.zh; if (++n >= 3000) break; }
      }
      return reply({ lines: have });
    }
    if (op === 'peek') {
      const have = {};
      for (const k of keys) {
        const r = this.results.get(k);
        if (r && now - r.at < ROOM_RESULT_KEEP_MS) have[k] = r.zh;
      }
      return reply({ lines: have, leaderAt: this.leaderAt || 0, leaderByeAt: this.leaderByeAt || 0 });
    }

    if (op === 'done') {
      if (body && body.leader) { const wasBye = !!this.leaderByeAt && this.leaderByeAt >= this.leaderAt; this.leaderAt = now; await saveLeader(wasBye); }
      const lines = (body && body.lines && typeof body.lines === 'object') ? body.lines : {};
      let n = 0;
      const ok = {};
      for (const [k, zh] of Object.entries(lines)) {
        if (typeof k === 'string' && k && typeof zh === 'string' && zh) {
          this.results.set(k, { zh, at: now });
          ok[k] = zh;
          n++;
        }
      }
      this.wake();
      const stored = n ? await this.saveResults(ok, now) : [];
      // 共用快取的寫入緩衝由房間負責（A15）：isolate 帶 buffer:true 才算數，沒帶的（舊版、測試）照舊自己緩衝
      let buffered = null;
      let kvPuts = 0;
      if (body && body.buffer === true && /^\d{1,20}$/.test(String(body.cid || ''))) {
        try {
          const m = await this.state.storage.get(['bufCid', 'bufSlug', 'kvUnrep']);
          const slug = String(body.slug || '').slice(0, 120);
          const upd = {};
          if (m.get('bufCid') !== String(body.cid)) upd.bufCid = String(body.cid);
          if (slug && !m.get('bufSlug')) upd.bufSlug = slug;
          kvPuts = Number(m.get('kvUnrep')) || 0;
          if (kvPuts) upd.kvUnrep = 0;
          if (Object.keys(upd).length) await this.state.storage.put(upd);
          if (stored.length) await this.armFlush(now);
          buffered = stored;
        } catch (e) { buffered = null; kvPuts = 0; }
      }
      // 結果留 ROOM_RESULT_KEEP_MS（15 分鐘，蓋過直播滑動視窗），之後 KV 自然會一致。
      // ⚠️ 不清的話這個 Map 會隨直播長度無限成長，而 DO 的記憶體要錢。
      if (this.results.size > 3000) {
        for (const [k, v] of this.results) if (now - v.at > ROOM_RESULT_KEEP_MS) this.results.delete(k);
      }
      return reply({ ok: true, stored: n, waiting: this.waiters.length, buffered, kvPuts });
    }

    // ---- 等別人翻完 ----------------------------------------------------
    if (op === 'wait') {
      const timeoutMs = Math.min(8000, Math.max(100, Number(body && body.timeoutMs) || 2000));
      const have = {};
      const need = new Set();
      for (const k of keys) {
        const r = this.results.get(k);
        if (r) have[k] = r.zh; else need.add(k);
      }
      if (!need.size) return reply({ lines: have, waited: 0 });

      const t0 = Date.now();
      const got = await new Promise((resolve) => {
        const w = { need, have: {}, resolve };
        this.waiters.push(w);
        // ⚠️ **一定要有逾時。** 翻譯者可能當掉、可能被限流、可能根本沒回來。
        //    沒有逾時的話這個請求會一直掛著，而呼叫端也跟著掛著。
        setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          resolve(w.have);
        }, timeoutMs);
      });
      return reply({ lines: { ...have, ...got }, waited: Date.now() - t0 });
    }

    // ---- 放棄認領 ------------------------------------------------------
    // 認領了卻沒翻出來（被額度截掉、模型漏回、合理性檢查擋掉、批次失敗）的句子要馬上放掉，
    // 否則別的觀眾要白等滿 25 秒（security-audit run-2 #7）。
    if (op === 'release') {
      for (const k of keys) this.claims.delete(k);
      return reply({ ok: true, released: keys.length });
    }

    // ---- 認領（預設）---------------------------------------------------
    const ttlMs = Math.min(120000, Math.max(1000, Number(body && body.ttlMs) || CLAIM_TTL_SEC * 1000));
    const mine = [];
    for (const k of keys) {
      const exp = this.claims.get(k);
      if (exp && exp > now) continue;   // 別人正在翻，而且還沒逾時
      this.claims.set(k, now + ttlMs);
      mine.push(k);
    }

    // 清掉過期的。**要有上界**——直播兩小時的句數上千，
    // 不清的話這個 Map 會一直長大，而 DO 的記憶體是計費資源。
    if (this.claims.size > 4000) {
      for (const [k, v] of this.claims) if (v <= now) this.claims.delete(k);
    }

    return reply({ mine, held: this.claims.size });
  }
}

/**
 * 向 DO 認領一批句子。回傳「這次該由我翻的」那些。
 *
 * ⚠️ **DO 不可用時一律退回舊路徑**（Cache API），不是直接放行也不是直接擋。
 *    DO 是新的單點：第一次上線就全部依賴它是不必要的風險。
 *    退回舊路徑最壞只是回到「去重不保證」，服務本身不受影響。
 *
 * `locationHint: 'apac'` 是刻意指定的：DO 實例的位置在第一次建立時決定，
 * 不指定的話可能建在美國，台灣使用者每次認領都多一趟跨太平洋往返（約 150ms）。
 * 直播的即時性吃不起那個延遲。
 */
/**
 * 對這支影片的 DO 送一個操作。回傳 null 代表 DO 不可用——
 * **呼叫端一律要有不依賴 DO 的退路**。
 */
/** 認領了卻沒有結果的句子放掉（見 SubtitleRoom 的 release）。 */
async function releaseUnfinished(env, cid, claimed, result) {
  if (!claimed || !claimed.size) return;
  const keys = [...claimed].filter((k) => !result[k]);
  if (keys.length) { try { await roomOp(env, cid, { op: 'release', keys }); } catch (e) { /* 最壞是別人等 25 秒 */ } }
}

async function roomOp(env, cid, body) {
  if (!env.ROOM) return null;
  try {
    const id = env.ROOM.idFromName(String(cid || 'misc'));
    const stub = env.ROOM.get(id, { locationHint: 'apac' });
    const res = await stub.fetch('https://room.pitlingo.internal/op', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function claimViaDO(env, cid, keys) {
  if (!keys.length) return null;
  const d = await roomOp(env, cid, { op: 'claim', keys, ttlMs: CLAIM_TTL_SEC * 1000 });
  return Array.isArray(d && d.mine) ? d.mine : null;
}

/**
 * 翻完之後把結果交給 DO，讓正在等的人**立刻**拿到。
 *
 * ⚠️ **不可以只寫 KV 就算了。** KV 是最終一致的（Cloudflare 的文件：
 *    寫入後數十秒仍可能讀到舊值），等待者輪詢 KV 常常什麼都等不到，
 *    最後還是自己翻一次——實測 100 人並發時 p50 延遲 3.7 秒。
 *
 * ⚠️ 失敗不擋主流程。交不出去最壞只是等待者逾時後自己翻，
 *    與沒有這個機制時一樣。
 */
async function roomPublish(env, cid, lines, leader, slug) {
  if (!lines || !Object.keys(lines).length) return null;
  try {
    const r = await roomOp(env, cid, { op: 'done', lines, leader: !!leader, buffer: true, cid: String(cid), slug: String(slug || '') });
    // 房間代寫的 KV 次數記進這個 isolate 的計量器（房間自己沒有計量器）
    if (r && r.kvPuts > 0) kvOps.put += Math.min(1000, Number(r.kvPuts) || 0);
    // 房間接手緩衝的句子（A15）。null＝房間不可用或舊版，全部照舊自己緩衝
    return (r && Array.isArray(r.buffered)) ? new Set(r.buffered) : null;
  } catch (e) { return null; /* 不擋主流程 */ }
}

/**
 * 剛翻好的結果要在 SubtitleRoom 留多久。
 *
 * ⚠️ **要蓋過整個直播滑動視窗，不是只蓋延遲畫面的 45 秒**（2026-10-25，R18 排位後節目）。
 *    晚加入的觀眾會把直播清單裡的全部分段（實測 107 段、約 10 分鐘）一次補抓、一次送來翻；
 *    那些句子收割端早就翻過，但 KV 還沒有——B 晚 9.5 分鐘加入時共用快取只給了 1 句，
 *    收割端那時已經翻了約 280 句，B 全部自己重翻。KV 這條路慢在兩層：每個 isolate 自己的
 *    寫入緩衝（滿 120 句或 90 秒，而且要**同一個 isolate 再收到請求**才會寫）加上 KV 傳播。
 *    房間是每支影片一份、強一致、而且已經存 storage（休眠不丟），所以把保留時間拉到 15 分鐘。
 *    代價：storage 一支影片最多約 17 列、醒來時讀一次；寫入次數不變（一次 done 一列）。
 */
const ROOM_RESULT_KEEP_MS = 900000;
/** 結果在 storage 裡一分鐘存一列（見 SubtitleRoom.saveResults） */
const ROOM_SLOT_MS = 60000;
/** 一列最大約多少位元組（上限 128 KiB 留餘裕）。一般直播一分鐘十幾到幾十句、約幾 KB；觀眾剛加入時的補抓會一次送上百句 */
const ROOM_SLOT_MAX_BYTES = 100000;
/** 房間有新句子後多久寫一次 KV（A15）。與以前的 isolate 緩衝（BUNDLE_BUF_MAX_MS）同一個節奏，但全站只有一份 */
const ROOM_FLUSH_MS = 90000;
/** 收割端多久沒動靜算「不在」。心跳每 30 秒一次。 */
const LEADER_STALE_MS = 180000;
/** 全域的前導端心跳記在這個 SubtitleRoom（cid 是數字，不會撞名） */
const LEADER_GLOBAL_ROOM = 'leader-global';

// ---- 逐句紀錄（handleTranslate → 房間 'plog'；後台 /v1/admin/linelog → 'plogSum'）----
const PLOG_KEEP_MS = 14 * 86400000;
const PLOG_SUM_MAX = 20000;
/** 每一句的去向。順序就是 handleTranslate 裡的順序 */
const PLOG_SRC = { c: '共用快取', r: '前導端房間', w: '等別人翻好', m: '自己花錢翻', x: '翻了但守門擋下', d: '沒拿到' };

/** 句子（normKey 之後）的雜湊：cyrb53，14 位十六進位。只用來比對「是不是同一句」，紀錄裡不存原文 */
function lineHash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0').slice(2);
}

/**
 * 把一段時間的逐句紀錄彙整成「實際發生了什麼」：
 *   · 每個人（who）幾個請求、每一種去向各幾句
 *   · 花錢翻的總次數 vs 不重複句數 → **重複翻了幾次（extra）**，全部是逐句比對出來的，不是相減推算
 *   · 每一次重複翻是哪一種：same＝同一個請求裡同一句出現兩次（translateBatch 不去重，模型真的翻兩次，2026-10-31 check-line-log 查到）；
 *     race＝兩個請求同時在翻（時間重疊）；late＝第一份已經翻好了、後來的請求還是自己翻（共用沒送到）
 *   · 誰 → 誰（先翻的 → 重複翻的）各幾次；前 50 句的明細
 */
function plogSummary(recs, dump) {
  const who = {};
  const model = new Map();
  let from = 0, to = 0;
  recs.forEach((r, ri) => {
    if (!r || typeof r !== 'object') return;
    const w = String(r.who || '?');
    const a = who[w] || (who[w] = { req: 0, live: 0, c: 0, r: 0, w: 0, m: 0, x: 0, d: 0 });
    a.req++;
    if (r.live) a.live++;
    for (const s of Object.keys(PLOG_SRC)) a[s] += Array.isArray(r[s]) ? r[s].length : 0;
    for (const h of (Array.isArray(r.m) ? r.m : [])) {
      if (!model.has(h)) model.set(h, []);
      model.get(h).push({ who: w, t0: r.t0, t1: r.t1, ri });
    }
    from = from ? Math.min(from, r.t0) : r.t0;
    to = Math.max(to, r.t1 || r.t0);
  });
  let translations = 0, extra = 0, same = 0, race = 0, late = 0;
  const pairs = {};
  const dups = [];
  for (const [h, ev] of model) {
    translations += ev.length;
    if (ev.length < 2) continue;
    ev.sort((a, b) => a.t0 - b.t0 || a.ri - b.ri);
    for (let i = 1; i < ev.length; i++) {
      extra++;
      if (ev[i].ri === ev[0].ri) same++; else if (ev[i].t0 >= ev[0].t1) late++; else race++;
      const p = `${ev[0].who} → ${ev[i].who}`;
      pairs[p] = (pairs[p] || 0) + 1;
    }
    if (dups.length < 50) dups.push({ h, ev });
  }
  return {
    records: recs.length, truncated: recs.length >= PLOG_SUM_MAX, from, to, src: PLOG_SRC, who,
    model: { translations, unique: model.size, extra, same, race, late, pairs },
    dups,
    raw: dump ? recs : undefined,
  };
}
/** 收割端狀態卡（/v1/admin/harvest/status）：多久沒更新就丟、最多留幾張 */
const HSTAT_KEEP_MS = 6 * 3600 * 1000;
const HSTAT_MAX = 6;

/**
 * 收割端送上來的狀態：只留認得的欄位、限制型別與長度（外洩的收割權杖能寫的就只有這些）。
 * 顯示端（後台）照樣一律 escHtml。
 */
function harvestStatusClean(b) {
  const id = String((b && b.id) || '');
  if (!/^[a-z0-9]{1,12}-[a-z0-9]{1,12}$/.test(id)) return { error: 'id 格式不正確' };
  const s = (b && b.status && typeof b.status === 'object') ? b.status : null;
  if (!s) return { error: '沒有 status' };
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e10 ? v : null);
  const out = {
    ver: str(s.ver, 20), path: str(s.path, 200), cid: /^\d{1,20}$/.test(String(s.cid || '')) ? String(s.cid) : '',
    isLive: s.isLive === true,
    lines: (Array.isArray(s.lines) ? s.lines : []).slice(0, 40).map((x) => str(x, 300)),
    autoLive: s.autoLive === true ? true : s.autoLive === 'standby' ? 'standby' : false,
    leaderMode: s.leaderMode === true, leaderBeat: s.leaderBeat === true,
    leaderSeen: typeof s.leaderSeen === 'boolean' ? s.leaderSeen : null,
    raf: num(s.raf), vis: str(s.vis, 16),
    win: (Array.isArray(s.win) ? s.win : []).slice(0, 4).map((x) => num(x)),
    video: s.video && typeof s.video === 'object' ? { paused: s.video.paused === true, t: num(s.video.t) } : null,
    seek: { now: num(s.seek && s.seek.now), max: num(s.seek && s.seek.max) },
    behind: num(s.behind), frozen: s.frozen === true, frozenTimes: Math.max(0, Math.min(1e6, Math.floor(num(s.frozenTimes) || 0))),
    caption: str(s.caption, 200),
  };
  if (JSON.stringify(out).length > 16000) return { error: '太大' };
  return { id, status: out };
}
/** 場次表定開始多久之後還沒有前導端，就告警 */
const LEADER_WATCH_AFTER_SEC = 600;
/** ⚠️ 要與 wrangler.toml [triggers] crons 裡的那一條一字不差（scheduled 靠 event.cron 分流） */
const LEADER_WATCH_CRON = '*/5 * * * *';

/**
 * 每 5 分鐘一次（2026-10-25，Ray：「以後都能自動用好收割端」）：場次（含節目）表定開始 10 分鐘了，
 * 前導端卻沒有心跳 → 寄信。以前的告警只在「有觀眾在看直播」時才會觸發，沒人看、收割端也沒開就完全不知道。
 * 每場只寄一封（AuthGuard once）。不寫 KV（鐵則 10）：讀賽程（每分鐘最多一次）、問兩個 DO。
 */
async function leaderWatch(env) {
  await loadSchedule(env);
  const now = nowSec();
  const due = [];
  for (const g of scheduleList()) {
    const items = (g.sessions || []).map((x) => ({ kind: x.k, label: x.n, at: Number(x.t) })).concat(gpShows(g));
    for (const it of items) {
      // cron 每 5 分鐘一次，[開始 +10 分, +15 分) 剛好落到一次
      if (it.at && now - it.at >= LEADER_WATCH_AFTER_SEC && now - it.at < LEADER_WATCH_AFTER_SEC + 300) due.push({ g, it });
    }
  }
  if (!due.length) return { due: 0 };
  const pk = await roomOp(env, LEADER_GLOBAL_ROOM, { op: 'peek', keys: [] });
  if (!pk) return { due: due.length, error: 'room' };
  const leaderAt = Number(pk.leaderAt) || 0;
  if (Date.now() - leaderAt <= LEADER_STALE_MS && (Number(pk.leaderByeAt) || 0) <= leaderAt) return { due: due.length, present: true };
  const { g, it } = due[0];
  const k = `leaderwatch:${gpId(g)}:${it.kind}`;
  const once = await authCall(env, { op: 'once', k, ttl: 86400 });
  if (!once || !once.ok) return { due: due.length, skipped: true };
  const when = new Date(it.at * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  const out = await notifyAdmin(env, `[PitLingo] ${g.name}「${it.label}」開始 10 分鐘了，前導收割端沒有出現`,
    `${g.label || g.name}「${it.label}」表定 ${when}（台灣時間）開始，到現在前導收割端都沒有心跳`
    + `（${leaderAt ? `最後一次是 ${Math.round((Date.now() - leaderAt) / 60000)} 分鐘前` : '從來沒有'}）。\n\n`
    + '使用者照樣看得到字幕（各自翻譯），只是成本會比較高。\n'
    + '可能的原因：收割用的電腦沒開機／睡著、Chrome 沒開、F1TV 登出、VPN 沒連、直播網址對不上。\n'
    + '有備援筆電（待命模式）的話，它應該已經接手了；過 5 分鐘還收到同一場的信就不是這樣。',
    { to: env.LEADER_ALERT_TO || env.REPORT_TO });
  console.log('leaderWatch: ' + k + ' ' + JSON.stringify(out));
  if (!out || (out.mail !== 'sent' && out.webhook !== 'sent')) await authCall(env, { op: 'once', k, release: true });
  return { due: due.length, alerted: k };
}

/** 掛在 DO 上等別人翻完。回傳等到的句子（可能是空的）。 */
async function roomWait(env, cid, keys, timeoutMs) {
  const d = await roomOp(env, cid, { op: 'wait', keys, timeoutMs });
  return (d && d.lines && typeof d.lines === 'object') ? d.lines : null;
}

/**
 * 認領一批句子，回傳「該由我翻的那些」。
 *
 * ⚠️ **急件與非急件必須用同一套認領。** 原本急件那條路只認 DO，
 *    於是 DO 一不可用（或測試環境沒模擬好）就完全沒有去重——
 *    而那正是最花錢的路徑。
 *
 * 順序：DO（單執行緒，原子）→ 退回 Cache API（per-colo，不保證但夠用）。
 * 兩者都不可用時 `claimLine` 一律回 true：**降級成多花錢，不是沒有字幕。**
 */
async function claimKeys(env, cid, keys) {
  const viaDO = await claimViaDO(env, cid, keys);
  if (viaDO) return new Set(viaDO);
  const mine = new Set();
  for (const k of keys) if (await claimLine(cid, k)) mine.add(k);
  return mine;
}

async function claimLine(cid, key) {
  try {
    if (typeof caches === 'undefined' || !caches.default) return true;
    // 用一個合法但不會與真實路由相撞的網址當 cache key
    const url = `https://claim.pitlingo.internal/${encodeURIComponent(cid)}/${encodeURIComponent(key)}`;
    const hit = await caches.default.match(url);
    if (hit) return false;                       // 別人正在翻
    await caches.default.put(url, new Response('1', {
      headers: { 'cache-control': `max-age=${CLAIM_TTL_SEC}` },
    }));
    return true;
  } catch (e) {
    return true;                                 // 任何差錯都放行，見上面的說明
  }
}

/* @test-only:start */
