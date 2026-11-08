/**
 * 收割佇列 —— **只存在於管理版**（handoff 9.1 #26 第 3 階段）
 *
 * 從 userscript（f1tv-zh-subtitles.user.js 的「自動收割」「依後端計畫收割」「全季收割」
 * 「補回網址後綴」「狀態面板」）移植過來。行為刻意保持一樣，差別只有：
 *   · 翻譯走後端 /v1/translate（收割權杖），瀏覽器裡沒有 Anthropic 金鑰、成本記在 harvest 那一列
 *   · 完整標記由 main.js 蓋（POST /v1/subs，等翻譯真的結束才蓋，見 harvestStampWhenSettled）
 *   · 油猴選單換成右上角的控制面板（Alt+Shift+J 開關）
 *
 * 由管理版 manifest 在 main.js 之後注入，透過 main.js 的 `window.__plAdmin` 取得收割進度。
 * 正式版與測試版沒有這支檔案，main.js 裡的掛鉤也整段移除（tools/build-extension.js --check 會驗）。
 *
 * ⚠️ **分類邏輯一行都不在這裡**（哪一站、哪個場次、缺不缺、到時間了沒）——全部由後端的
 *    POST /v1/admin/harvest/plan 回答。這裡只做後端做不到的事：把 F1TV 頁面上的連結刮下來
 *    （F1TV 有 Imperva，伺服器端爬不了）。
 * ⚠️ 面板一律 textContent；來自後端的文字（站名、場次名、錯誤）用到 HTML 的地方一律跳脫。
 */
(function () {
  'use strict';
  const A = window.__plAdmin;
  if (!A) return;                       // main.js 不是管理版就什麼都不做

  const ORIGIN = 'https://f1tv.formula1.com';
  const K = {
    queue: 'plHarvestQueue', crawl: 'plHarvestCrawl', auto: 'plHarvestAuto',
    asked: 'plHarvestAskedAt', season: 'plHarvestSeasonPath', panel: 'plHarvestPanel',
  };
  const HQ_SETTLE_MS = 8000;            // 頁面載入後先等播放器起來
  const HQ_POLL_MS = 3000;
  // 逾時看「多久沒進度」，不看總時間（2026-10-12）：固定 15 分鐘讓正賽 2,416 段只抓到 600 段就被判失敗，
  // 而短的場次卡死時又要白等 15 分鐘。有在前進就一直等，硬上限只防「進度數字在跳但永遠到不了」。
  const HQ_IDLE_MS = 5 * 60000;         // 這麼久沒有任何進度＝卡住
  const HQ_MAX_MS = 120 * 60000;        // 單支的硬上限，避免卡死整個佇列
  // 等這麼久還沒有字幕清單，才敢認定「這支沒有字幕」（太短會把「播放器還沒起來」誤判掉）
  const HQ_NOSUB_MS = 90000;
  // 拿不到字幕清單、又沒有證據說「這支沒有字幕」：等這麼久就記失敗（可以「重跑失敗」），不記完成
  const HQ_NOLIST_MS = 3 * 60000;
  // 佇列記著「正在收這一支」、頁面卻不在那一支上超過這麼久＝那一支中途離開了（換頁、當機、F1TV 轉去別頁）
  const HQ_ORPHAN_MS = 3 * 60000;
  const HQ_ASK_QUIET_MS = 12 * 3600 * 1000;
  const HQ_CRAWL_GAP_MS = 2500;         // 換頁至少隔這麼久，不要像機器人在掃
  const HQ_CRAWL_MAX_MS = 20 * 60000;
  const pageAt = Date.now();
  // tools/autolive.ps1 開 Chrome 時網址帶 #pl-autolive=main|standby（A14）。一開始就讀：SPA 之後可能改掉網址
  const AL_LAUNCH = (String(location.hash || '').match(/pl-autolive=(main|standby)\b/) || [])[1] || '';

  /** 唯一能用的網址形式：/detail/<數字>/<slug>。少了 slug 一律 404，而 slug 無法從 id 反推 */
  const HQ_VALID = /^\/detail\/\d+\/[A-Za-z0-9\-_]+$/;
  const HQ_RACE_PAGE = /^\/page\/\d+\/formula-1-[a-z0-9-]+-(19|20)\d{2}$/;
  const HQ_SEASON_PAGE = /^\/page\/\d+\/(19|20)\d{2}-season$/;
  // gpStatus() 的集合；replay（正賽剛跑完的那一晚）是最該提醒的
  const HOT = new Set(['live', 'replay', 'open', 'upcoming']);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"'`]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const short = (p) => String(p || '').replace(/^\/detail\/\d+\//, '');
  const cidOf = (p) => (String(p).match(/\/detail\/(\d+)/) || [])[1] || '';
  const fmtMin = (ms) => {
    if (!isFinite(ms) || ms < 0) return '—';
    const m = Math.floor(ms / 60000); const h = Math.floor(m / 60);
    return h ? `${h} 時 ${m % 60} 分` : `${m} 分`;
  };
  const log = (m) => { try { console.log('%c[PitLingo 收割] ' + m, 'color:#0a7c4a'); } catch (e) { /* noop */ } };

  async function get(k, dflt) {
    try { const o = await chrome.storage.local.get(k); return o[k] === undefined ? dflt : o[k]; } catch (e) { return dflt; }
  }
  // 只用來判斷有沒有；請求一律由 SW 帶權杖，這裡不保存也不顯示它
  const hasToken = async () => !!(await get('harvestToken', ''));
  const set = (k, v) => chrome.storage.local.set({ [k]: v }).catch(() => {});
  function send(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError && chrome.runtime.lastError.message })); }
      catch (e) { resolve({ ok: false, error: String(e.message || e) }); }
    });
  }
  /** 收割端點的呼叫；失敗一律丟例外（訊息給人看得懂） */
  async function call(type, extra) {
    const res = await send(Object.assign({ type }, extra || {}));
    const r = (res && res.ok && res.result) || {};
    if (!res || !res.ok || r.ok === false || r.error) throw new Error(r.error || (res && res.error) || '(未知錯誤)');
    return r;
  }

  // ---------------------------------------------------------------------------
  // 佇列（chrome.storage.local；換頁、關瀏覽器都還在）
  // ---------------------------------------------------------------------------
  async function qLoad() {
    const d = await get(K.queue, null);
    if (!d || !Array.isArray(d.queue)) return { queue: [], done: [], failed: [], running: false, startedAt: 0, current: null };
    // 不合法的項目在讀取時就丟掉：導覽到拼錯的網址看起來像網路壞掉
    d.queue = d.queue.filter((x) => typeof x === 'string' && HQ_VALID.test(x));
    d.done = Array.isArray(d.done) ? d.done : [];
    d.failed = Array.isArray(d.failed) ? d.failed : [];
    return d;
  }
  const qSave = (d) => set(K.queue, d);

  /** 本頁所有影片連結（不套略過規則——略過與否由後端計畫決定，補 slug 也要看到全部） */
  function scrape() {
    const out = new Set();
    const add = (raw) => {
      const m = String(raw || '').match(/\/detail\/(\d+)(\/[A-Za-z0-9\-_]+)/);
      if (m) out.add(`/detail/${m[1]}${m[2]}`);
    };
    document.querySelectorAll('a[href*="/detail/"]').forEach((a) => add(a.getAttribute('href')));
    // SPA 有時把連結畫在別的屬性上，整頁掃一次當備援
    (document.body.innerHTML.match(/\/detail\/\d+\/[A-Za-z0-9\-_]+/g) || []).forEach(add);
    return [...out];
  }

  // ---------------------------------------------------------------------------
  // 提示條（右下角）。**不用 alert**——自動流程裡的 alert 會把頁面卡住
  // ---------------------------------------------------------------------------
  function banner(html, buttons) {
    const old = document.getElementById('pitlingo-hq-banner');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'pitlingo-hq-banner';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:380px;'
      + 'padding:14px 16px;border-radius:12px;background:rgba(20,20,24,.96);color:#fff;'
      + 'font:14px/1.6 system-ui,"Microsoft JhengHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45)';
    const body = document.createElement('div');
    body.innerHTML = html;               // 呼叫端負責跳脫（esc）
    box.appendChild(body);
    const bar = document.createElement('div');
    bar.style.cssText = 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap';
    for (const b of buttons || [{ text: '好', onClick: () => {} }]) {
      const el = document.createElement('button');
      el.textContent = b.text;
      el.style.cssText = 'border:0;border-radius:7px;padding:6px 12px;cursor:pointer;font:inherit;'
        + (b.primary ? 'background:#0a7c4a;color:#fff' : 'background:rgba(255,255,255,.14);color:#fff');
      el.onclick = () => { try { b.onClick(); } finally { if (b.close !== false) box.remove(); } };
      bar.appendChild(el);
    }
    box.appendChild(bar);
    document.body.appendChild(box);
    return box;
  }
  const note = (title, sub) => banner(`<b>${esc(title)}</b>${sub ? `<br><span style="opacity:.8">${esc(sub)}</span>` : ''}`);

  // ---------------------------------------------------------------------------
  // 依後端計畫收割
  // ---------------------------------------------------------------------------
  const plan = (paths) => call('harvestPlan', paths ? { paths } : {});

  async function planAndStart(quiet) {
    let p;
    try { p = await plan(scrape()); }
    catch (e) { if (!quiet) note('取得收割計畫失敗', e.message); return; }
    if (p.liveNow) {
      const m = `R${p.liveNow.round} ${p.liveNow.name} 的「${p.liveNow.label}」正在播（或即將開播）。收割會跟影片搶同一個 CDN。`;
      if (quiet) log('現在不收割：' + m); else note('現在不收割', m);
      return;
    }
    if (!p.queue || !p.queue.length) {
      if (quiet) { log('本頁沒有要跑的'); return; }
      const s = p.skipped || {};
      const todo = (p.todo || []).map((t) => `R${esc(t.round)} ${esc(t.name)}：${(t.missing || []).map(esc).join('、')}`).join('<br>');
      banner(`<b>本頁沒有需要收割的影片</b><br><span style="opacity:.8">送出 ${esc(p.received)} 條連結：`
        + `已完整 ${esc(s.complete || 0)}、不缺或還沒到時間 ${esc(s.notMissing || 0)}、舊賽季 ${esc(s.otherSeason || 0)}、`
        + `支援賽事 ${esc(s.support || 0)}、認不出 ${esc(s.unknown || 0)}</span>`
        + (todo ? `<br><br>後端說該收的是：<br>${todo}<br>請到那幾場的頁面再按一次。` : '<br><br>目前整季沒有該收割的場次。'));
      return;
    }
    const d = await qLoad();
    const known = new Set([...d.queue, ...d.done, ...d.failed]);
    const added = p.queue.filter((x) => !known.has(x));
    d.queue.push(...added);
    d.running = true; d.startedAt = Date.now();
    await qSave(d);
    const lines = (p.plan || []).slice(0, 12).map((x) => `R${esc(x.round)} ${esc(x.name)}・${esc(x.label)}`).join('<br>');
    banner(`<b>開始收割 ${d.queue.length} 支</b><br><span style="opacity:.8">${lines}${(p.plan || []).length > 12 ? '<br>…' : ''}</span>`);
    log(`依後端計畫排入 ${added.length} 支，開始`);
    setTimeout(next, 1200);
  }

  /** 列表頁載入後問一次「現在有沒有該收的」。在 /detail/ 頁不問（那時多半正在看影片） */
  async function offer() {
    const d = await qLoad();
    if (d.running) return;
    if (/\/detail\/\d+/.test(location.pathname)) return;
    let p;
    try { p = await plan(null); } catch (e) { return; }
    if (p.liveNow || !p.todo || !p.todo.length) return;
    const hot = p.todo.filter((t) => HOT.has(t.status));
    if (!hot.length) return;
    if (await get(K.auto, false)) { planAndStart(true); return; }
    if (Date.now() - Number(await get(K.asked, 0) || 0) < HQ_ASK_QUIET_MS) return;
    const t = hot[0];
    banner(`<b>R${esc(t.round)} ${esc(t.name)}</b> 還缺 ${esc((t.missing || []).length)} 個場次沒收割<br>`
      + `<span style="opacity:.8">${(t.missing || []).map(esc).join('、')}</span><br>`
      + '<label style="display:flex;gap:6px;align-items:center;margin-top:8px;opacity:.85">'
      + '<input type="checkbox" id="pitlingo-hq-auto"> 以後都自動開始，不用再問</label>', [
      { text: '開始收割本頁', primary: true, onClick: () => {
        const cb = document.getElementById('pitlingo-hq-auto');
        if (cb && cb.checked) set(K.auto, true);
        planAndStart(false);
      } },
      { text: '暫時不要', onClick: () => set(K.asked, Date.now()) },
    ]);
  }

  // ---------------------------------------------------------------------------
  // 全季收割：本季頁 → 逐站刮連結 → 一次交給後端計畫 → 開跑
  // ---------------------------------------------------------------------------
  const crawlLoad = async () => (await get(K.crawl, null)) || { active: false };
  const crawlSave = (c) => set(K.crawl, c);
  const go = (path) => { location.href = ORIGIN + path; };

  async function seasonPath() {
    const a = [...document.querySelectorAll('a[href^="/page/"]')]
      .map((x) => x.getAttribute('href').split('?')[0]).find((h) => HQ_SEASON_PAGE.test(h));
    return a || await get(K.season, '');
  }

  async function crawlStart() {
    if ((await qLoad()).running) { note('收割佇列正在跑', '先暫停，再開始全季收割。'); return; }
    const season = await seasonPath();
    if (!season) { note('找不到本季頁的連結', '請先打開 F1TV 首頁（頁首有「20xx Season」）再按一次。'); return; }
    await set(K.season, season);
    await crawlSave({ active: true, stage: 'season', season, pages: [], i: 0, paths: [], startedAt: Date.now() });
    note('全季收割：正在找出本季每一站的頁面…', '會自動換頁，請不要操作這個分頁');
    if (location.pathname !== season) go(season); else setTimeout(crawlTick, 1500);
  }

  async function scrollAll() {
    for (let i = 0; i < 8; i++) { try { window.scrollTo(0, document.body.scrollHeight); } catch (e) { /* noop */ } await sleep(500); }
  }

  async function crawlTick() {
    const c = await crawlLoad();
    if (!c.active) return;
    if (Date.now() - c.startedAt > HQ_CRAWL_MAX_MS) {
      await crawlSave({ active: false });
      note('全季收割逾時，已放棄', '可能是 F1TV 頁面載入太慢。再按一次即可重來。');
      return;
    }
    if (c.stage === 'season') {
      if (location.pathname !== c.season) { go(c.season); return; }
      await scrollAll();
      c.pages = [...new Set([...document.querySelectorAll('a[href^="/page/"]')]
        .map((a) => a.getAttribute('href').split('?')[0])
        .filter((h) => HQ_RACE_PAGE.test(h) && !/testing/.test(h)))];
      if (!c.pages.length) { await crawlSave({ active: false }); note('全季收割：本季頁上找不到任何一站', 'F1TV 可能改版了。'); return; }
      c.stage = 'races'; c.i = 0; await crawlSave(c);
      log(`本季 ${c.pages.length} 站，開始逐站收集連結`);
      setTimeout(() => go(c.pages[0]), HQ_CRAWL_GAP_MS);
      return;
    }
    if (c.stage === 'races') {
      const want = c.pages[c.i];
      if (!want) { crawlFinish(c); return; }
      if (location.pathname !== want) { go(want); return; }
      await scrollAll();
      const before = c.paths.length;
      c.paths = [...new Set([...c.paths, ...scrape()])];
      c.i++;
      await crawlSave(c);
      log(`第 ${c.i}/${c.pages.length} 站：${c.paths.length - before} 條新連結`);
      if (c.i < c.pages.length) setTimeout(() => go(c.pages[c.i]), HQ_CRAWL_GAP_MS);
      else crawlFinish(c);
    }
  }

  async function crawlFinish(c) {
    await crawlSave({ active: false, lastPaths: c.paths.length, finishedAt: Date.now() });
    let p;
    try { p = await plan(c.paths); } catch (e) { note('全季收割：取得收割計畫失敗', e.message); return; }
    if (p.liveNow) { note('現在不收割', `R${p.liveNow.round} ${p.liveNow.name} 的「${p.liveNow.label}」正在播或即將開播。`); return; }
    const queue = p.queue || [];
    if (!queue.length) { note('✅ 本季沒有需要收割的影片', `送出 ${p.received} 條連結`); return; }
    const d = await qLoad();
    // 以後端的判斷為準：之前記成完成／失敗、但後端仍說不完整的，也要重新排進來
    const inQ = new Set(d.queue);
    d.queue.push(...queue.filter((x) => !inQ.has(x)));
    d.failed = d.failed.filter((x) => !queue.includes(x));
    d.running = true; d.startedAt = Date.now(); d.current = null;
    await qSave(d);
    const s = p.skipped || {};
    note(`全季收割：排入 ${queue.length} 支，開始`,
      `已完整 ${s.complete || 0}、還沒到時間 ${s.notMissing || 0}、舊賽季 ${s.otherSeason || 0}、支援賽事 ${s.support || 0}`);
    setTimeout(next, 2000);
  }

  // ---------------------------------------------------------------------------
  // 逐支跑
  // ---------------------------------------------------------------------------
  async function next() {
    const d = await qLoad();
    if (!d.running) return;
    const path = d.queue.shift();
    if (!path) {
      d.running = false; d.current = null; await qSave(d);
      note('✅ 佇列跑完了', `完成 ${d.done.length} 支、失敗 ${d.failed.length} 支。`);
      return;
    }
    // 直播優先（2026-11-02 R19 正賽）：時間窗內有還沒播完的場次，就不開下一支重播
    const live = await alPending();
    if (live) { d.queue.unshift(path); await qYield(d, live); return; }
    // ⚠️ 記下「這一支是佇列開的」——watch 只接手這一頁，你自己開來看的影片不會被當成收割工作
    d.current = { path, at: Date.now() };
    await qSave(d);
    log(`前往 ${path}（佇列剩 ${d.queue.length}）`);
    location.href = `${ORIGIN}${path}?action=play`;
  }

  /**
   * 佇列卡住了沒（2026-11-02 R19 正賽：整場賽前節目收割端停在首頁）。
   * 佇列最後一支收完後要等 1.5 秒才由 next() 把「執行中」改回停止；這 1.5 秒內頁面離開了，next() 就沒跑，
   * 之後也沒有人回頭處理——佇列永遠「執行中 剩 0」，alTick 一直讓路，自動開直播整晚不動，重開 Chrome 也沒用（狀態在 storage）。
   * 回傳 null＝沒事；'empty'＝執行中但沒有要收、也沒有正在收的；'orphan'＝記著正在收的那支、頁面卻不在那支上超過 HQ_ORPHAN_MS。
   * 純函式（check-autolive-slugs 直接拿來跑）
   */
  function qStuck(d, pathname, now) {
    if (!d || !d.running) return null;
    const cur = d.current;
    // ⚠️ 只在「不是影片頁」時才算：人在別的影片頁上＝自己開來看的，不可以把他踢走（check-admin-harvest 5）
    if (cur && cur.path && !/^\/detail\//.test(pathname) && now - (cur.at || 0) > HQ_ORPHAN_MS) return 'orphan';
    if (!d.queue.length && !cur) return 'empty';
    return null;
  }
  /** 修好卡住的佇列。頁面載入時與 alTick 每一輪都跑 */
  async function qHeal() {
    const d = await qLoad();
    const why = qStuck(d, location.pathname, Date.now());
    if (!why) return d;
    if (why === 'orphan') {
      d.failed.push(d.current.path);
      d.last = { path: d.current.path, ok: false, why: '收割頁中途離開（沒收完就換頁了）', at: Date.now() };
      d.current = null;
    }
    if (!d.queue.length) d.running = false;
    await qSave(d);
    log(why === 'empty' ? '收割佇列：顯示「執行中」但已經沒有要收的，改回停止（不然會擋住自動開直播）'
      : `收割佇列：${short(d.last.path)} 中途離開，記為失敗${d.running ? '，接著收下一支' : '，佇列也收完了，改回停止'}`);
    if (d.running) setTimeout(next, 1200);
    return d;
  }
  /** 直播優先：佇列先停下（正在收的那支放回最前面），記著是因為直播才停的，直播結束後 qResume 接著收 */
  async function qYield(d, h) {
    if (d.current && d.current.path && !d.queue.includes(d.current.path)) d.queue.unshift(d.current.path);
    d.current = null; d.running = false; d.pausedForLive = Date.now();
    await qSave(d);
    log(`直播優先：R${h.g.round}「${h.s.label}」的時間到了，收割佇列先暫停（剩 ${d.queue.length} 支，直播結束後自動接著收）`);
  }
  /** 因為直播才停的佇列，時間窗內沒有還沒播完的場次了就接著收。手動暫停的不動 */
  async function qResume() {
    const d = await qLoad();
    if (!d.pausedForLive || d.running) return;
    d.pausedForLive = 0;
    if (d.queue.length) d.running = true;
    await qSave(d);
    if (!d.running) return;
    log(`直播結束：收割佇列接著收（剩 ${d.queue.length} 支）`);
    setTimeout(next, 1200);
  }

  /**
   * 這一支結束了沒。回傳 null＝還沒；{ ok, why }＝結束（ok=false 記成失敗）。
   * 與 userscript 的 hqDone 同一套條件；差別是「翻完＋蓋章」由 main.js 的 stamp 狀態回答。
   */
  function verdict(s) {
    if (s.bundleComplete) return { ok: true, why: '後端早就有完整的一份' };
    if (s.harvestSkipped) return { ok: true, why: '後端記錄已完整收割，跳過' };
    const st = s.stamp || {};
    if (st.cid === s.cid) {
      if (st.state === 'ok') return { ok: true, why: st.note };
      if (st.state === 'incomplete' || st.state === 'failed') return { ok: false, why: st.note };
      return null;                                         // waiting：等翻譯結束、等蓋章
    }
    if (s.playlistSegs > 0) {
      // 分段沒抓齊（有失敗）就不會蓋章——等翻譯停下來後記成失敗，已翻的部分仍在共用快取
      const settled = !s.harvestInFlight && s.pending === 0 && s.inflight === 0;
      if (settled && s.segFetched + s.segFailed >= s.playlistSegs && !s.harvestDone) {
        return { ok: false, why: `分段失敗 ${s.segFailed} 段` };
      }
      return null;
    }
    // ⚠️ playlistSegs === 0 也可能只是「播放器還沒起來」——等夠久才敢說這支沒有字幕
    // ⚠️ 而且要有證據（2026-11-03）：以前等滿 90 秒就記「完成：這支沒有官方字幕」，不管播放器有沒有載入。
    //    R19 排位重播就這樣被記成完成——直播時明明有字幕——之後再也不會補收（「完成」不會重跑，鐵則 38、41）。
    //    只有攔到 master、裡面確實沒有字幕軌才算沒字幕；其他情況（沒看到 master、清單抓取失敗）記失敗。
    const age = Date.now() - pageAt;
    if (age > HQ_NOSUB_MS && s.subTrack === 'none') return { ok: true, why: '沒有字幕清單（master 裡沒有字幕軌＝這支沒有官方字幕）' };
    if (age > HQ_NOLIST_MS) {
      return { ok: false, why: s.subTrack === 'has'
        ? '有字幕軌但沒取得字幕清單（清單抓取失敗或被擋，不是沒有字幕）'
        : '沒攔到播放器的 master 清單（播放器沒載入？不是沒有字幕）' };
    }
    return null;
  }

  async function watch() {
    const d = await qLoad();
    if (!d.running) return;
    const path = location.pathname;
    if (!/\/detail\/\d+/.test(path)) return;
    if (!d.current || d.current.path !== path) { log(`${path} 不是收割佇列開的頁面，不接手`); return; }
    if (!(await hasToken())) {
      d.running = false; await qSave(d);
      note('收割已暫停：沒有收割權杖', '到擴充功能設定頁 → 管理版 → 收割權杖 填好後再繼續。');
      return;
    }
    const t0 = Date.now();
    try { A.fastPace(); } catch (e) { /* noop */ }       // 沒有人在看：抓取改全速、不讓路給影片
    log(`盯著 ${path}，${HQ_IDLE_MS / 60000} 分鐘沒進度或滿 ${HQ_MAX_MS / 60000} 分鐘就記為失敗`);
    let lastSig = '', lastMoveAt = t0, liveAt = t0;
    const tick = async () => {
      const cur = await qLoad();
      if (!cur.running) return;                          // 中途被暫停
      // 直播優先：每分鐘看一次時間窗。收到一半的這支放回佇列最前面，直播結束後再收
      if (Date.now() - liveAt > 60000) {
        liveAt = Date.now();
        const live = await alPending();
        if (live) { await qYield(cur, live); location.assign(ORIGIN + '/'); return; }
      }
      let s;
      try { s = A.snapshot(); } catch (e) { s = null; }
      const v = s && verdict(s);
      const now = Date.now();
      // 任何一個數字在動都算有進度（抓分段、翻譯、等蓋章的狀態變化）
      const sig = s ? [s.playlistSegs, s.segFetched, s.segFailed, s.translated, s.pending, s.inflight, (s.stamp || {}).state].join('|') : '';
      if (sig !== lastSig) { lastSig = sig; lastMoveAt = now; }
      const idle = now - lastMoveAt > HQ_IDLE_MS;
      if (v || idle || now - t0 > HQ_MAX_MS) {
        const ok = v ? v.ok : false;
        const got = `已抓 ${s ? s.segFetched : '?'}/${s ? s.playlistSegs : '?'} 段`;
        const why = v ? v.why : idle ? `${HQ_IDLE_MS / 60000} 分鐘沒有進度（${got}）` : `逾時（${got}）`;
        (ok ? cur.done : cur.failed).push(path);
        cur.current = null;
        cur.last = { path, ok, why, at: Date.now() };
        await qSave(cur);
        log(`${path} ${ok ? '完成' : '記為失敗'}：${why}`);
        setTimeout(next, 1500);
        return;
      }
      setTimeout(tick, HQ_POLL_MS);
    };
    setTimeout(tick, HQ_SETTLE_MS);
  }

  // ---------------------------------------------------------------------------
  // 補回缺少網址後綴的影片（絕不猜測：只送真的在頁面上或佇列裡看到的連結）
  // ---------------------------------------------------------------------------
  async function fixSlugs() {
    let miss;
    try {
      const d = await call('harvestBundles');
      miss = new Set();
      for (const g of d.groups || []) for (const it of g.items || []) if (!it.slug) miss.add(String(it.cid));
    } catch (e) { note('讀取後端清單失敗', e.message); return; }
    if (!miss.size) { note('後端沒有缺少網址後綴的影片', '不用補。'); return; }
    const q = await qLoad();
    const hit = [...new Set([...scrape(), ...q.done, ...q.queue, ...q.failed])]
      .filter((p) => HQ_VALID.test(p) && miss.has(cidOf(p)));
    if (!hit.length) {
      note(`後端還缺 ${miss.size} 支的網址後綴`, '本頁與收割佇列裡都沒有對應的連結。請到那幾場的 F1TV 頁面（往下捲到底）再按一次。');
      return;
    }
    let r;
    try { r = await call('harvestSlugs', { paths: hit }); } catch (e) { note('上傳失敗', e.message); return; }
    const left = miss.size - (r.updated || 0);
    note(`已補回 ${r.updated || 0} 支`, left > 0 ? `還缺 ${left} 支，到那幾場的頁面再按一次。` : '✅ 全部補齊了。');
  }

  // ---------------------------------------------------------------------------
  // 控制面板（右上角；Alt+Shift+J 開關）。狀態一律 textContent
  // ---------------------------------------------------------------------------
  let panel = null, panelText = null, panelTimer = null;

  async function panelLines() {
    const L = [];
    const s = A.snapshot();
    const q = await qLoad();
    const c = await crawlLoad();
    const now = Date.now();
    L.push(`PitLingo 管理版 v${chrome.runtime.getManifest().version}　${s.harvestOn ? '收割權杖 ✓' : '⚠ 沒有收割權杖'}`);
    if (s.cid) {
      L.push(`影片　${s.cid}　${short(location.pathname).slice(0, 40)}　${s.phase || ''}`);
      L.push(`分段　${s.segFetched}/${s.playlistSegs || '?'}${s.segFailed ? `（失敗 ${s.segFailed}）` : ''}`
        + `${s.harvestInFlight ? '　抓取中' : ''}${s.bundleComplete ? '　後端已完整' : ''}${s.harvestSkipped ? '　已跳過' : ''}`);
      L.push(`翻譯　應有 ${s.wanted}　沒譯文 ${s.missing}　待送 ${s.pending}　飛行 ${s.inflight}　放棄 ${s.dropped}　擋下 ${s.blocked}　錯誤 ${s.errors}`);
      const st = s.stamp || {};
      L.push(`標記　${st.cid === s.cid && st.state ? `${{ waiting: '等待中', ok: '✅ 已蓋章', incomplete: '⚠ 不完整', failed: '✖ 失敗', aborted: '已中止' }[st.state] || st.state}　${st.note || ''}` : '尚未'}`);
    }
    if (q.running || q.queue.length || q.done.length || q.failed.length) {
      L.push(`佇列　${q.running ? '執行中' : '暫停'}　剩 ${q.queue.length}　完成 ${q.done.length}　失敗 ${q.failed.length}`);
      if (q.current && q.current.path) L.push(`　　　目前 ${short(q.current.path)}（${fmtMin(now - q.current.at)}）`);
      if (q.queue.length) L.push(`　　　下一支 ${q.queue.slice(0, 2).map(short).join('、')}`);
      if (q.last) L.push(`　　　上一支 ${q.last.ok ? '✅' : '✖'} ${short(q.last.path)}：${q.last.why || ''}`);
      if (q.running && (q.done.length + q.failed.length) && q.startedAt) {
        const per = (now - q.startedAt) / (q.done.length + q.failed.length);
        L.push(`　　　預估還要 ${fmtMin(per * q.queue.length)}（平均每支 ${fmtMin(per)}）`);
      }
    }
    if (c.active) L.push(`全季　收集連結 ${c.stage === 'season' ? '（本季頁）' : `${c.i}/${(c.pages || []).length} 站`}　${(c.paths || []).length} 條`);
    L.push(...(await f1Lines()));
    return L;
  }

  async function panelPaint() {
    if (!panel || !panel.isConnected) return;
    try { panelText.textContent = (await panelLines()).join('\n'); }
    catch (e) { panelText.textContent = '面板錯誤：' + e.message; }
  }

  function button(text, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'border:0;border-radius:6px;padding:4px 8px;cursor:pointer;font:12px system-ui,"Microsoft JhengHei",sans-serif;'
      + 'background:rgba(255,255,255,.14);color:#fff';
    b.onclick = (e) => { e.stopPropagation(); Promise.resolve(onClick()).then(panelPaint).catch((err) => note('操作失敗', err.message)); };
    return b;
  }

  async function panelSet(on) {
    await set(K.panel, !!on);
    clearInterval(panelTimer); panelTimer = null;
    if (!on) { if (panel) panel.remove(); panel = null; return; }
    if (!panel || !panel.isConnected) {
      panel = document.createElement('div');
      panel.id = 'pitlingo-harvest-panel';
      panel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:560px;'
        + 'padding:10px 12px;border-radius:8px;background:rgba(10,10,14,.9);color:#e8e8ea;'
        + 'border-left:3px solid #0a7c4a;box-shadow:0 6px 24px rgba(0,0,0,.4)';
      panelText = document.createElement('div');
      panelText.style.cssText = 'font:12px/1.55 ui-monospace,Consolas,"Microsoft JhengHei",monospace;white-space:pre;pointer-events:none';
      const bar = document.createElement('div');
      bar.style.cssText = 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap';
      bar.append(
        button('🚜 依計畫收割本頁', () => planAndStart(false)),
        button('🌐 全季收割', crawlStart),
        button('⏯ 開始／暫停', async () => {
          const d = await qLoad();
          if (d.running) { d.running = false; await qSave(d); return; }
          if (!d.queue.length) { note('佇列是空的', '先按「依計畫收割本頁」或「全季收割」。'); return; }
          d.running = true; d.startedAt = Date.now(); await qSave(d);
          note(`開始收割，佇列 ${d.queue.length} 支`, '⚠️ 背景分頁的計時器會被 Chrome 節流——把這個分頁拉成獨立視窗並保持可見（不要最小化）。');
          setTimeout(next, 1200);
        }),
        button('🔁 重跑失敗', async () => {
          const d = await qLoad();
          const back = d.failed.filter((x) => HQ_VALID.test(x) && !d.queue.includes(x));
          d.queue.push(...back); d.failed = []; await qSave(d);
          note(`已把 ${back.length} 支放回佇列`, '按「開始／暫停」繼續。');
        }),
        button('🎯 重收這一支', () => {
          const why = A.forceHarvest();
          if (why) note('不能重收', why);
          else note('開始重收這一支', '略過「已完整」判斷，整軌抓完、翻完後重新蓋章。已翻過的句子從共用快取拿，不會重付。');
        }),
        button('🩹 補網址後綴', fixSlugs),
        button('🤖 自動開始', async () => {
          const on = !(await get(K.auto, false));
          await set(K.auto, on);
          note(on ? '已開啟自動開始' : '已關閉自動開始',
            on ? '列表頁有該收割的場次時直接開始。仍然不會在任何場次播出期間收割（後端依賽程判斷）。' : '以後會先問過你。');
        }),
        // 按一次換一種：關 → 主機 → 備援機（待命）→ 關
        button('📡 自動開直播', async () => {
          const cur = await get(AL.on, false);
          const next = cur === false ? true : cur === true ? 'standby' : false;
          await set(AL.on, next);
          if (next === true) note('自動開直播：主機', '這個設定檔在首頁時，每一場（含 Warm-Up 與賽前賽後節目）表定前 35 分鐘起會自己找到那一場、靜音播放、當前導端；結束後回首頁。別台前導端正在收時不開。⚠️ 只在收割專用的設定檔打開（同一個 F1TV 帳號兩路串流會互踢）。');
          else if (next === 'standby') note('自動開直播：備援機（待命）', '平常不開直播。每一場表定開始 5 分鐘後，主機還沒有前導端心跳才接手。主機與備援機可以用同一個 F1TV 帳號（同一時間只會有一台在播）。');
          else note('已關閉自動開直播', '以後不會自己開直播。');
          if (next) setTimeout(alTick, 500);
        }),
        button('🔑 F1TV 帳號', f1CredForm),
        button('🔄 立即重新登入', async () => {
          if (/^\/detail\//.test(location.pathname) && !window.confirm('正在看影片，重新登入會離開這一頁。確定？')) return;
          if (!(await f1Start('manual'))) note('沒有開始', '還沒存 F1TV 帳號（按「🔑 F1TV 帳號」），或上一輪還在進行中。');
        }),
        button('🗑 清空佇列', async () => {
          if (!window.confirm('清空整個收割佇列（含已完成與失敗的紀錄）？')) return;
          await qSave({ queue: [], done: [], failed: [], running: false, startedAt: 0, current: null });
        }),
        button('✕', () => panelSet(false)),
      );
      panel.append(panelText, bar);
      (document.body || document.documentElement).appendChild(panel);
    }
    panelPaint();
    panelTimer = setInterval(panelPaint, 1000);
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'J' || e.key === 'j')) panelSet(!panel);
  });

  // ---------------------------------------------------------------------------
  // 狀態回報到後台（2026-10-30 Ray：「同步收割端的所有即時狀態到後台，管理面板上有的都要有，
  // 也要有收割端目前在直播的幾分幾秒」）。面板開不開都送；15 秒一次，存在後端的 Durable Object（不寫 KV）。
  // 身分：設定檔一個 id（chrome.storage）＋分頁一個 id（sessionStorage，換頁不變）——Ray 平常收割的那個 Chrome
  // 也開著管理版時，後台看到的是兩張卡，不會互相蓋掉
  // ---------------------------------------------------------------------------
  const STATUS_MS = 15000;
  async function statusId() {
    const rnd = () => Math.random().toString(36).slice(2, 10);
    let p = await get('plStatusRid', '');
    if (!/^[a-z0-9]{4,12}$/.test(p)) { p = rnd(); await set('plStatusRid', p); }
    let t = '';
    try { t = sessionStorage.getItem('plStatusTab') || ''; if (!/^[a-z0-9]{4,12}$/.test(t)) { t = rnd(); sessionStorage.setItem('plStatusTab', t); } }
    catch (e) { t = 'x'; }
    return p + '-' + t;
  }
  async function statusPush() {
    if (!(await hasToken())) return;
    const lv = (A.live && A.live()) || {};
    const status = Object.assign({
      ver: chrome.runtime.getManifest().version,
      path: location.pathname.slice(0, 200),
      cid: A.snapshot().cid || '',
      isLive: !!A.snapshot().isLive,
      lines: (await panelLines()).slice(0, 40),
    }, lv);
    await call('harvestStatus', { id: await statusId(), status });
  }
  // 不在影片頁（首頁等開播）時一分鐘一次就夠：收割用的 Chrome 整個週末都開著，15 秒一次一天就是 5,760 個
  // Worker 請求＋DO 寫入（免費方案 Worker 一天 10 萬）
  let statusAt = 0;
  const statusTick = () => {
    if (!/^\/detail\//.test(location.pathname) && Date.now() - statusAt < 60000) return;
    statusAt = Date.now();
    statusPush().catch(() => {});
  };
  setTimeout(statusTick, 5000);
  setInterval(statusTick, STATUS_MS);

  // ---------------------------------------------------------------------------
  // 自動開直播（2026-10-25 Ray：「排位賽就實際測試自動開收割」）
  // ---------------------------------------------------------------------------
  // 排程（tools/autolive.ps1）在開賽前把收割專用的 Chrome 開到 F1TV 首頁；這裡接手：
  // 依後端公開賽程（/v1/schedule）判斷「現在該播哪一場」→ 在頁面上找那一場的連結 → 開來播（靜音）。
  // 前導模式、自動開英文字幕、結束後回首頁（main.js leaderGoHome）都是原本就有的。
  // ⚠️ **預設關**，只在收割專用的設定檔打開（面板「📡 自動開直播」）：Ray 平常收割用的管理版若也開著，
  //    一個 F1TV 帳號同時兩路串流會互踢。
  // ⚠️ 只在**不是影片頁**的時候動作（首頁、賽事頁）：正在看的影片不搶；收割佇列在跑也不動。
  const AL = { on: 'plAutoLive', ended: 'plAutoLiveEnded', went: 'plAutoLiveWent', err: 'plAutoLiveErr' };
  // F1TV 錯誤頁之後的重試（2026-10-31 R19 FP2 實測）：直接開影片頁回 ER9003，錯誤頁自動按 GO BACK HOME、
  // alTick 十幾秒後又直接開——4 分鐘開了 15 次，沒有任何等待（鐵則 #3）。
  // ER9003＝F1TV「訂閱方案不足」：這個設定檔的 F1TV 登入狀態壞了（Ray 手動點也一樣），重試不會好 → 30 分鐘才再試一次、
  // 停在錯誤頁讓人看得到；其他錯誤碼（R18 的 ER9004 是偶發）依序等 2／4／8／16 分鐘。同一支影片最多 5 次就不再自動開
  const AL_ERR_WAIT_MIN = [2, 4, 8, 16];
  const AL_ERR_SUB_MIN = 30;
  const AL_ERR_MAX = 5;
  // 表定開始之前撞到的錯誤頁＝直播還沒開（2026-11-01 R19 排位實測：表定前 15 分鐘從賽前節目切過去，排位還沒開 → 錯誤頁 →
  // 照「2／4／8 分鐘」等，20:46Z 開播了收割端還在等，Ray 手動進去）。固定 1 分鐘再試、**不累加次數**；
  // 次數只算開賽之後的（那才是 F1TV 真的有問題）。表定前最多約 20 次（AL_DIRECT_SEC），1 分鐘一次不算連打。ER9003 照舊
  const AL_ERR_PRE_MIN = 1;
  const alErrWaitMs = (e) => (e.pre ? AL_ERR_PRE_MIN : e.code === 'ER9003' ? AL_ERR_SUB_MIN : AL_ERR_WAIT_MIN[Math.min(e.n, AL_ERR_WAIT_MIN.length) - 1]) * 60000;
  let alErrLogged = '';
  const AL_LEAD_SEC = 35 * 60;          // Ray：直播大約在表定前 30～10 分鐘開，提前 35 分鐘開始找
  const AL_TICK_MS = 20000;
  const AL_RELOAD_MS = 3 * 60000;       // 找不到連結時，隔這麼久重新整理一次首頁（直播列可能還沒更新）
  const AL_PLAY_WAIT_MS = 4 * 60000;     // 點進去之後等這麼久還沒播起來，就回首頁重試
  const AL_PLAY_KICK_MS = 90000;         // 播放器這麼久都沒自己播，才從外面補叫一次 play()（見 alKeepPlaying）
  const AL_STANDBY_GRACE_SEC = 5 * 60;  // 備援機：表定開始後等主機這麼久
  // 正式場次優先（alPreferMain）。歷史：2026-10-25 Ray 先決定關（節目跑到結束再交接）——代價是正式場次開頭約
  // 10～15 分鐘沒有前導端、觀眾各自翻；R18 正賽實際看到之後，2026-10-26 改回開（見下）。
  // 代價反過來：節目最後約 10～15 分鐘沒有前導端（節目的觀眾少，划算）
  // ⚠️ 2026-10-26 Ray 改回**開**：「當主要的比賽開始就直接跳過去」（R18 正賽：Pre-Race 節目播到 04:00，正賽 03:45 就開播了）。
  //    F1TV 正式場次約在表定前 10～15 分鐘開播（Ray 觀察），所以表定前 15 分鐘離開節目，回首頁每 1 分鐘找正式場次的連結
  const AL_PREFER_MAIN = true;
  const AL_MAIN_SWITCH_SEC = 15 * 60;   // 正式場次表定前這麼久，從節目切過去（R18 排位實測：排位直播在表定前 15 分鐘開，內容接著賽前節目）
  const AL_RELOAD_MAX = 15;             // 一場最多重新整理這麼多次（F1TV 有 Imperva，不要像機器人一直刷）
  // 有 F1TV 直接網址時，表定前這麼久開始直接開（A17，見 alFindLink）。點進去 4 分鐘沒播起來回首頁、20 秒後再開，
  // 實際上就是 Ray 提的「T−20／15／10／5 分各試一次」
  const AL_DIRECT_SEC = 20 * 60;
  // 賽程的 kind → F1TV 網址 slug 的結尾（實例：2026-united-states-gp-practice-3、2026-monaco-grand-prix）
  const AL_SLUG = {
    fp1: /-practice-1$/, fp2: /-practice-2$/, fp3: /-practice-3$/,
    quali: /(?<!sprint)-qualifying$/, sq: /-sprint-qualifying$/, sprint: /(?<!qualifying)-sprint$/,
    // ⚠️ `-psc-race`／`-pre-race`／`-post-race` 是節目，不是正賽（實例：2026-italian-gp-psc-race）
    race: /(-grand-prix|(?<!-psc|-pre|-post)-race)$/,
    // 節目（Ray 2026-10-25：這些也要收）。網址沒有年份開頭（實例：weekend-warm-up-united-states），
    // 四個賽前賽後節目的網址還沒看過，先用「含有這幾個字」比對
    warmup: /^weekend-warm-up-/,
    preq: /pre-qualifying/, postq: /post-qualifying/, prer: /pre-race/, postr: /post-race/,
    // 衝刺週末的節目（2026 新加坡站 F1TV 賽事頁實例：pre-sprint-show-singapore、post-sprint-show-singapore）
    pres: /pre-sprint/, posts: /post-sprint/,
    // 季前測試（2027 起在賽程裡，一天一個場次）。實例：2026-pre-season-testing-2-day-1-session-1
    td1: /-pre-season-testing-(?:\d+-)?day-1(?:-session-\d+)?$/, td2: /-pre-season-testing-(?:\d+-)?day-2(?:-session-\d+)?$/,
    td3: /-pre-season-testing-(?:\d+-)?day-3(?:-session-\d+)?$/,
  };
  const AL_SHOW = new Set(['warmup', 'preq', 'postq', 'prer', 'postr', 'pres', 'posts']);
  // ⚠️ 不是 F1 的系列一律排除（R18 排位實測）：`2026-united-states-gp-f1a-qualifying` 也以 -qualifying 結尾，
  //    而且 F1A 的 cid（1000077805）比 F1 排位（1000010406）大——「取 cid 最大的」就選到 F1A，排位結束後開了 F1A 的重播。
  //    正賽同理：`2026-united-states-gp-f1a-opening-race` 也以 -race 結尾
  // `kids`：2026-singapore-gp-f1-kids-sprint 也以 -sprint 結尾（F1 Kids 是給小朋友的另一路轉播，賽事頁實例）
  const AL_NOT_F1 = /(^|-)(f1a|f2|f3|psc|academy|porsche|supercup|kids)(-|$)/;
  const AL_LEN = { race: 7200, warmup: 2700, preq: 2100, prer: 4200, td1: 34200, td2: 34200, td3: 34200 };   // 秒；其餘 1 小時（後端場次有 len 時以它為準）
  /**
   * 節目的時間：**以後端 /v1/schedule 的 `shows` 為準**（v5.66 起，後端 GP_SHOWS）。
   * 這一份只是後端還沒有 `shows` 時的退路，偏移量相同（取自 2026 美國站 F1TV 賽事頁的時程）。
   *   Pre-Qualifying 04:25／排位 05:00／Post-Qualifying 06:10；Pre-Race 02:50／正賽 04:00／Post-Race 06:00
   *   Weekend Warm-Up：PL-261023-WNZB 實測 10/23 09:37（台灣）貼著直播邊緣＝FP1 前約 16 小時（當地週四晚上）
   * ⚠️ Warm-Up 只有一個數據點。改偏移量改後端 GP_SHOWS；這裡跟著改。
   */
  const AL_DERIVED = [
    { kind: 'warmup', label: 'Weekend Warm-Up', from: 'fp1', off: -16 * 3600 },
    { kind: 'preq', label: 'Pre-Qualifying Show', from: 'quali', off: -35 * 60 },
    { kind: 'postq', label: 'Post-Qualifying Show', from: 'quali', off: 70 * 60 },
    { kind: 'prer', label: 'Pre-Race Show', from: 'race', off: -70 * 60 },
    { kind: 'postr', label: 'Post-Race Show', from: 'race', off: 120 * 60 },
  ];
  function alSessions(g) {
    const ss = (g.sessions || []).slice();
    if (Array.isArray(g.shows)) return ss.concat(g.shows).sort((a, b) => a.at - b.at);
    for (const d of AL_DERIVED) {
      const base = ss.find((x) => x.kind === d.from);
      if (base) ss.push({ kind: d.kind, label: d.label, at: base.at + d.off });
    }
    return ss.sort((a, b) => a.at - b.at);
  }
  let alSched = null;
  let alSchedAt = 0;
  let alSince = Date.now();
  const s0 = (s) => s.kind + '@' + s.at;   // 一個場次的識別（重新整理次數按場次算）

  /** 現在時間窗內的所有場次（含節目），依表定時間排。賽前節目與排位會重疊，由 alTick 依序找第一個還沒播完的。 */
  async function alNowSessions() {
    if (!alSched || Date.now() - alSchedAt > 30 * 60000) {
      const r = await call('autoLiveSchedule');
      alSched = r.races || []; alSchedAt = Date.now();
    }
    const now = Date.now() / 1000;
    const out = [];
    for (const g of alSched) {
      for (const s of alSessions(g)) {
        const len = s.len || AL_LEN[s.kind] || 3600;
        // 結束時間多放一小時：正賽、排位常常延誤；直播真的結束了 main.js 會自己回首頁並記下來
        if (now >= s.at - AL_LEAD_SEC && now < s.at + len + 3600 && AL_SLUG[s.kind]) out.push({ g, s });
      }
    }
    return out;
  }

  /**
   * 這一場在本頁的連結。同一場可能出現多條（直播、預告），取 contentId 最大的（F1TV 的編號隨時間遞增）。
   * A13（2026-10-26）：後端有這一場的 F1TV contentId／網址（alSyncF1tv 從 F1TV 賽事頁讀來的）就**直接開**，
   * 不在首頁上找——R18 Post-Race 已經在首頁直播列上，這一頁卻找不到連結，等了 3 分鐘重新整理才進去。
   * F1TV 的直播與之後的重播是同一個 contentId，所以網址事先就知道。
   * 直接開只從表定前 AL_DIRECT_SEC 開始（A17）：再早直播通常還沒開，點進去只會停在倒數頁、4 分鐘後回首頁，
   * 白白多打 F1TV 幾次。表定前 35～20 分鐘仍然照舊在首頁上找（直播提早開時首頁上就有）。
   */
  function alFindLink(s, ended, g) {
    const direct = g && g.f1tv && g.f1tv[s.kind];
    if (direct && /^\/detail\/\d+\/[a-z0-9-]+/.test(direct.href || '') && direct.cid === cidOf(direct.href)) {
      if (ended.includes(direct.cid)) return { done: true };
      if (Date.now() / 1000 >= s.at - AL_DIRECT_SEC) return { path: direct.href.split('?')[0], direct: true };
    }
    const year = new Date(s.at * 1000).getUTCFullYear();
    const re = AL_SLUG[s.kind];
    // 節目的網址沒有年份：改用「含這一站的站名」擋掉上一站的舊節目（後端 slugs，例如 united-states、mexico-city）
    const place = (g && Array.isArray(g.slugs)) ? g.slugs : [];
    // ⚠️ 正式場次也要對站名（2026-11-01 R19 FP3）：表定前 35～20 分鐘還沒有直接網址、首頁上本站 FP3 也還沒出現，
    //    而上一站的 `2026-united-states-gp-practice-3` 重播在首頁上——只看「2026- 開頭＋-practice-3 結尾」就開了 R18 FP3。
    //    2026 KV 裡 91 個正式場次網址全部含本站的 slugs（2026-11-01 查證）。季前測試的網址沒有站名，照舊只看年份
    const needPlace = place.length && !/^td\d$/.test(s.kind);
    const all = scrape().filter((p) => {
      const slug = p.replace(/^\/detail\/\d+\//, '');
      const atPlace = !needPlace || place.some((w) => slug.includes(w));
      const mine = AL_SHOW.has(s.kind) ? atPlace : slug.startsWith(year + '-') && atPlace;
      return mine && re.test(slug) && !AL_NOT_F1.test(slug);
    });
    all.sort((a, b) => Number(cidOf(b)) - Number(cidOf(a)));
    // 最新的那一條已經播完（main.js 回首頁時記下的）＝這一場結束了，不要再點進它的重播
    if (all.length && ended.includes(cidOf(all[0]))) return { done: true };
    return all.length ? { path: all[0] } : null;
  }

  // ---- F1TV 賽事頁的真實時程（A4，2026-10-26）----
  // 後端的節目時間原本是用美國站推算的偏移量；R19 墨西哥 Weekend Warm-Up 推算 10:30、F1TV 實際 04:30（台灣），
  // 照推算排程會整場漏掉。這裡每 12 小時讀一次 F1TV 自己的內容 API（同源、用這個分頁的登入），
  // 把接下來 10 天內每一站的場次時間＋contentId＋播放網址送給後端（後端嚴格驗證、只在內容變了才寫 KV）。
  // ⚠️ F1TV 有 Imperva：一輪最多 1（本季頁）＋站數（通常 1～2）個請求，12 小時一輪，失敗也等 12 小時
  const AL_SYNC_MS = 12 * 3600 * 1000;
  // 「進行中」超過這麼久就當作那一輪死掉了（分頁被重新整理、換頁、關掉時，那一輪不會寫完成）。
  // 2026-10-27 實測：重新載入管理版後同步卡在「進行中」，照 AL_SYNC_MS 要等 12 小時才會再試——
  // 而 R19 Warm-Up 的真實時間（比推算早 6 小時）就靠這一輪
  const AL_SYNC_STALE_MS = 10 * 60 * 1000;
  const F1TV_FETCH_MS = 20000;
  // 本季頁找不到頁首連結時的退路（/page/12343/2026-season）。新賽季頁首通常有連結，沒有的話補這裡
  const F1TV_SEASON_PAGE = { 2026: '/page/12343/2026-season' };
  // F1TV 賽事頁的 titleBrief → 賽程的 kind（2026 墨西哥、新加坡賽事頁實例）。對不上的（F1 Kids…）一律不收
  const F1TV_BRIEF = {
    'Weekend Warm-Up': 'warmup', 'Practice 1': 'fp1', 'Practice 2': 'fp2', 'Practice 3': 'fp3',
    'Sprint Qualifying': 'sq', 'Pre-Sprint Show': 'pres', 'Sprint': 'sprint', 'Post-Sprint Show': 'posts',
    'Pre-Qualifying Show': 'preq', 'Qualifying': 'quali', 'Post-Qualifying Show': 'postq',
    'Pre-Race Show': 'prer', 'Race': 'race', 'Post-Race Show': 'postr',
  };
  function f1tvWalk(j, test) {
    const out = [];
    (function w(o, d) {
      if (!o || typeof o !== 'object' || d > 40) return;
      if (Array.isArray(o)) { for (const x of o) w(x, d + 1); return; }
      if (test(o)) out.push(o);
      for (const k in o) w(o[k], d + 1);
    })(j, 0);
    return out;
  }
  async function f1tvGet(pagePath) {
    const id = (String(pagePath).match(/^\/page\/(\d+)\//) || [])[1];
    if (!id) throw new Error('頁面網址不對：' + pagePath);
    // 一定要有逾時：2026-10-27 同步卡在「進行中」，一個不回應的請求會讓整輪永遠不結束
    const r = await fetch(`${ORIGIN}/2.0/R/ENG/WEB_DASH/ALL/PAGE/${id}/PRO/3`, { credentials: 'include', signal: AbortSignal.timeout(F1TV_FETCH_MS) });
    if (!r.ok) throw new Error('F1TV ' + r.status);
    return r.json();
  }
  /** 賽事頁 API → [{ kind, at, end, cid, href }]。只收 FORMULA 1、有播放網址、titleBrief 對得上的 */
  function f1tvEvents(j) {
    const ev = f1tvWalk(j, (o) => o.metadata && o.metadata.emfAttributes && o.metadata.emfAttributes.sessionStartDate && Array.isArray(o.actions));
    const out = new Map();
    for (const e of ev) {
      const m = e.metadata; const a = m.emfAttributes;
      const href = String((e.actions[0] && e.actions[0].href) || '');
      const kind = F1TV_BRIEF[String(m.titleBrief || '').trim()];
      if (!kind || a.Series !== 'FORMULA 1' || !/\?action=play$/.test(href)) continue;
      const cid = cidOf(href);
      const at = Math.floor(Number(a.sessionStartDate) / 1000);
      const end = Math.floor(Number(a.sessionEndDate) / 1000);
      if (!cid || !at || out.has(kind)) continue;
      out.set(kind, { kind, at, end, cid, href });
    }
    return [...out.values()];
  }
  async function alSyncF1tv(force) {
    const last = await get('plF1tvSync', { at: 0 });
    const stale = last.result === '進行中' && Date.now() - (last.at || 0) > AL_SYNC_STALE_MS;
    if (!force && !stale && Date.now() - (last.at || 0) < AL_SYNC_MS) return last;
    await set('plF1tvSync', { at: Date.now(), result: '進行中' });   // 先記：失敗也等下一輪，不連打
    const res = [];
    try {
      const races = (await call('autoLiveSchedule')).races || [];
      const now = Date.now() / 1000;
      const day = (ymd) => Date.parse(String(ymd) + 'T00:00:00Z') / 1000;
      const due = races.filter((g) => day(g.endDate) + 86400 >= now && day(g.startDate) - 10 * 86400 <= now);
      if (!due.length) res.push('接下來 10 天沒有比賽');
      if (due.length) {
        const year = new Date().getUTCFullYear();
        let season = await seasonPath();
        if (!season || !season.includes('/' + year + '-season')) season = F1TV_SEASON_PAGE[year] || '';
        if (!season) throw new Error(`不知道 ${year} 賽季頁在哪（F1TV_SEASON_PAGE）`);
        // 本季頁上每一站：Meeting_Start_Date（YYYY-MM-DD）對後端的 startDate
        const meets = f1tvWalk(await f1tvGet(season), (o) => o.metadata && o.metadata.emfAttributes
          && o.metadata.emfAttributes.Meeting_Start_Date && Array.isArray(o.actions) && o.actions[0] && HQ_RACE_PAGE.test(String(o.actions[0].href || '')));
        for (const g of due) {
          const m = meets.find((x) => String(x.metadata.emfAttributes.Meeting_Start_Date).slice(0, 10) === g.startDate);
          if (!m) { res.push(`R${g.round} 找不到賽事頁`); continue; }
          await sleep(HQ_CRAWL_GAP_MS);
          const items = f1tvEvents(await f1tvGet(m.actions[0].href));
          const r = await call('harvestF1tvSched', { gpId: g.id, items });
          const mm = (r.mismatch || []).map((x) => `${x.kind} 差 ${Math.round((x.f1tv - x.official) / 60)} 分`).join('、');
          res.push(`R${g.round} ${r.n} 場${r.changed ? '（有更新）' : ''}${mm ? '；正式場次與官方不一致：' + mm : ''}`);
        }
      }
    } catch (e) { res.push('失敗：' + e.message); }
    log('F1TV 時程同步：' + res.join('；'));
    alSched = null;   // 下一輪重讀後端賽程，拿到新的節目時間與網址
    const out = { at: Date.now(), result: res.join('；') };
    await set('plF1tvSync', out);
    return out;
  }

  /**
   * 時間窗內要開哪一場（純函式，check-autolive-slugs 直接拿來跑）。look(h) 是 alFindLink 的結果。
   * 依表定時間找第一個還沒播完的；找到連結就開，找不到先記著、繼續看後面的。
   * ⚠️ 正式場次已經到了切換時間（表定前 AL_MAIN_SWITCH_SEC）而且還沒播完，就**不開節目**
   *   （2026-11-02 R19 正賽：04:03 收割端回首頁，賽前節目還在時間窗內、排在前面，就被重新開了——
   *    要等 alPreferMain 30 秒後再離開，或像 Ray 那樣手動切出來）。與 alPreferMain 同一條規則，只是提前在首頁就套用
   */
  function alPick(hits, now, look) {
    const mainDue = AL_PREFER_MAIN && hits.some((h) => !AL_SHOW.has(h.s.kind) && now >= h.s.at - AL_MAIN_SWITCH_SEC && !(look(h) || {}).done);
    let hit = null, found = null;
    for (const h of hits) {
      if (mainDue && AL_SHOW.has(h.s.kind)) continue;             // 正式場次優先
      const f = look(h);
      if (f && f.done) continue;                                  // 這一場已經播完，看下一場
      hit = h; found = f;
      if (f) break;                                               // 找到連結就開；找不到先記著，繼續看後面的有沒有
    }
    return { hit, found };
  }
  /** 時間窗內還沒播完的場次（自動開直播開著時才算）。收割佇列與全季收割看到它就讓路 */
  async function alPending() {
    if (!(await get(AL.on, false))) return null;
    let hits;
    try { hits = await alNowSessions(); } catch (e) { return null; }
    if (!hits.length) return null;
    const ended = await get(AL.ended, []);
    return alPick(hits, Date.now() / 1000, (h) => alFindLink(h.s, ended, h.g)).hit;
  }

  async function alTick() {
    if (!(await get(AL.on, false)) || !(await hasToken())) return;  // false＝關；true＝主機；'standby'＝備援機
    if (/^\/detail\//.test(location.pathname)) return;           // 正在看影片：不搶
    if (((await get(F1.st, null)) || {}).stage) return;           // F1TV 自動重新登入進行中：不換頁（A24）
    // F1TV 沒登入（或憑證過期）就不開影片頁：開了 F1TV 只會轉去登入頁，回首頁又再開一次，整個視窗一直跳
    // （2026-10-31 FP2 延長時 Ray 實測：沒登入的設定檔載入管理版後一直被帶去登入頁）。
    // 有存帳號 → 直接走一輪自動登入（不看場次時間窗：沒登入本來就收不到）；沒存 → 面板說明，停在首頁
    const f1e = f1Exp();
    if (!f1e || f1e * 1000 <= Date.now()) {
      if (await f1Start('nologin')) return;
      const msg = '自動開直播：F1TV 沒有登入（或登入過期），先不開影片頁——請在這個視窗登入 F1TV，或在面板「🔑 F1TV 帳號」存好帳號';
      if (alErrLogged !== msg) { alErrLogged = msg; log(msg); note('F1TV 沒有登入', '自動開直播先暫停：沒登入時開影片頁只會被 F1TV 轉去登入頁。請在這個視窗登入 F1TV（登入頁是中文壞頁的話，把 Chrome 語言的英文移到最上面），或在面板「🔑 F1TV 帳號」存好帳號讓它自己登入。'); }
      return;
    }
    // 收割佇列與全季收割：直播優先（2026-11-02 R19 正賽，Ray：「要確保以後再也不會發生卡住的問題」）。
    // 以前是「佇列在跑就讓路」——佇列卡在「執行中 剩 0」時，自動開直播整場賽前節目都不動。
    // 現在：先修卡住的佇列；時間窗內有還沒播完的場次，佇列與全季收割一律讓路（之後自動接著收），不再擋自動開直播
    const q = await qHeal();
    const pending = await alPending();
    if (q.running) { if (!pending) return; await qYield(q, pending); }
    const c = await crawlLoad();
    if (c.active) {
      if (!pending) return;
      await crawlSave({ active: false });
      log(`直播優先：R${pending.g.round}「${pending.s.label}」的時間到了，全季收割中止（直播後再按一次「全季收割」）`);
      note('全季收割已中止：直播優先', `R${pending.g.round}「${pending.s.label}」的時間到了。直播結束後再按一次「🌐 全季收割」。`);
    }
    let hits;
    try { hits = await alNowSessions(); } catch (e) { log('自動開直播：取得賽程失敗 ' + e.message); return; }
    if (!hits.length) { await qResume(); return; }
    const ended = await get(AL.ended, []);
    const { hit, found } = alPick(hits, Date.now() / 1000, (h) => alFindLink(h.s, ended, h.g));
    if (!hit) { await qResume(); return; }                       // 時間窗內的都播完了：因為直播停下的佇列接著收
    const mode = await get(AL.on, false);
    // 備援機（待命）：表定開始 5 分鐘後主機還沒心跳才接手——主機在表定前 35 分鐘就開始找，給它時間
    if (mode === 'standby' && Date.now() / 1000 < hit.s.at + AL_STANDBY_GRACE_SEC) return;
    // 兩台都一樣：後端看得到別台的前導端心跳就不開（同一個 F1TV 帳號兩路串流會互踢，Ray 2026-10-25 確認）。
    // 這一台在首頁＝自己沒有在播，所以「在」的那一個一定是別台。
    // 問不到時：主機照開（不可以因為後端暫時有事就不收）；備援機**不開**（主機可能正在播，開了就互踢）
    if (found) {
      const st = await call('autoLiveLeader').catch(() => null);
      if (!st && mode === 'standby') { log('自動開直播：問不到主機在不在，備援機先不開'); return; }
      if (st && st.present) { log(`自動開直播：別台前導端正在收（${Math.round((Date.now() - st.leaderAt) / 1000)} 秒前有心跳），這一台不開`); return; }
      if (mode === 'standby') log('自動開直播：主機沒有心跳，備援機接手');
    }
    if (!found) {
      log(`自動開直播：R${hit.g.round} ${hit.g.name}「${hit.s.label}」的連結還沒出現在這一頁`);
      const rl = await get('plAutoLiveReload', { at: 0, n: 0 });
      // 表定前 20 分鐘內（例如剛從賽前節目切過來，直播連結還沒上首頁）縮短成 1 分鐘，不要白白漏掉開頭；總次數上限不變。
      // 節目也算（2026-10-26 R18 Post-Race：正賽 06:04 結束回首頁，Ray 看到 Post-Race 已經在直播列上，
      // 這一頁卻沒找到連結，等滿 3 分鐘重新整理才進去）
      const soon = Date.now() / 1000 >= hit.s.at - 20 * 60;
      if (Date.now() - alSince > (soon ? 60000 : AL_RELOAD_MS) && rl.n < AL_RELOAD_MAX) {
        await set('plAutoLiveReload', { at: s0(hit.s), n: rl.at === s0(hit.s) ? rl.n + 1 : 1 });
        location.reload();
      }
      return;
    }
    const path = found.path;
    // 這一支剛撞過 F1TV 錯誤頁：等夠了才再開，次數用完就不再自動開（見 AL_ERR_*）
    const err = await get(AL.err, null);
    if (err && err.cid === cidOf(path)) {
      const left = err.at + alErrWaitMs(err) - Date.now();
      if (err.n >= AL_ERR_MAX || left > 0) {
        const msg = err.n >= AL_ERR_MAX
          ? `自動開直播：這一支已經撞 F1TV 錯誤頁 ${err.n} 次（${err.code}），不再自動開——請手動處理`
          : `自動開直播：上次 F1TV 回 ${err.code}，${Math.ceil(left / 60000)} 分鐘後再試（${err.pre ? '還沒到表定開始，不算次數' : '第 ' + err.n + ' 次'}）`;
        if (alErrLogged !== msg) { alErrLogged = msg; log(msg); }
        return;
      }
    }
    const until =hit.s.at + (hit.s.len || AL_LEN[hit.s.kind] || 3600);
    await set(AL.went, { cid: cidOf(path), at: Date.now(), kind: hit.s.kind, direct: !!found.direct, start: hit.s.at, until });
    log(`自動開直播：R${hit.g.round} ${hit.g.name}「${hit.s.label}」→ ${path}`);
    location.href = `${ORIGIN}${path}?action=play`;
  }

  /**
   * 自動開的那一頁：影片沒有在播就靜音後自己按播放。
   * 排程開的 Chrome 沒有任何人點過頁面——Chrome 的自動播放規則只放行**靜音**的影片，
   * 所以先靜音（前導端不需要聲音）。播起來就收手，之後的暫停當成有人故意按的。
   * ⚠️ 直播還沒開始時，首頁可能已經掛著這一場（倒數中）：點進去會停在「還沒開始」的頁面。
   *    4 分鐘內沒播起來就回首頁，讓 alTick 過一陣子再試（Ray：直播約在表定前 30～10 分鐘開）。
   */
  /**
   * 保險：節目的網址比對比較鬆，可能點到上一站的舊節目（重播）＝收割成本、而且不是直播。
   * 播起來 60 秒後，main.js 已經從播放清單判斷出是不是直播（要有分段數才算判斷過）；是重播就記成播完、回首頁。
   */
  function alCheckLive(went) {
    const cid = went.cid;
    setTimeout(async () => {
      const a = window.__plAdmin && window.__plAdmin.snapshot && window.__plAdmin.snapshot();
      if (!a || a.cid !== cid || !a.playlistSegs || a.isLive) return;
      // 直接開的（F1TV 賽事頁給的 contentId）一定是這一場：表定結束前不是直播＝還沒開始（或播的是開播前的片頭），
      // **不可以記成播完**——記了這一場就再也不會開。回首頁，下一輪再試
      if (went.direct && Date.now() / 1000 < (went.until || 0)) {
        log('自動開直播：這一場還不是直播（可能還沒開始），回首頁稍後再試');
        location.assign(ORIGIN + '/');
        return;
      }
      const ended = await get(AL.ended, []);
      await set(AL.ended, ended.concat(cid).slice(-20));
      log('自動開直播：開到的是重播不是直播，回首頁');
      location.assign(ORIGIN + '/');
    }, 60000);
  }

  /**
   * 正式場次優先（2026-10-25，Ray：「賽前節目正在直播時，排位賽、正賽也會同時開始，會不會搞混？」）。
   * 不會混：譯文按影片（cid）分開存。但一台機器、一個 F1TV 帳號同時只能播一路——
   * 停在賽前節目直到它結束，排位／正賽開頭那段就沒有前導端（觀眾各自翻，比較貴）。
   * 所以：自動開的是節目、而某個正式場次離表定不到 15 分鐘 → 把這個節目記成播完、回首頁，alTick 會去開正式場次。
   * 反過來不做：排位延誤時不會為了賽後節目離開排位。
   */
  async function alPreferMain() {
    const cid = cidOf(location.pathname);
    // 看網址判斷是不是節目，不看「是不是自動開的」：R18 Pre-Race 是 Ray 手動點進去的，也要能交接到正賽
    const slug = location.pathname.replace(/^\/detail\/\d+\//, '');
    if (!cid || ![...AL_SHOW].some((k) => AL_SLUG[k] && AL_SLUG[k].test(slug))) return;
    const t = setInterval(async () => {
      try {
        if (!(await get(AL.on, false))) return;
        const now = Date.now() / 1000;
        const main = (await alNowSessions()).find((h) => !AL_SHOW.has(h.s.kind) && now >= h.s.at - AL_MAIN_SWITCH_SEC && now < h.s.at + 1800);
        if (!main) return;
        clearInterval(t);
        const ended = await get(AL.ended, []);
        await set(AL.ended, ended.concat(cid).slice(-20));
        log(`自動開直播：${main.s.label}快開始了，離開節目改收正式場次`);
        // 走 main.js 的離開流程（送 bye：觀眾那邊不會誤報前導端不在；離開前送一份診斷）；拿不到就直接回首頁
        const a = window.__plAdmin;
        if (a && typeof a.goHome === 'function') a.goHome(`${main.s.label}快開始了，離開節目改收正式場次`);
        else location.assign(ORIGIN + '/');
      } catch (e) { /* 下一輪再看 */ }
    }, 30000);
  }

  /**
   * 播完要自己離開（2026-11-01 R19，Ray：「收割完了之後要自己退出 不然會一直卡在裡面直到播完」）。
   * FP3 直播結束後 F1TV 沒有出現「Starts in」倒數（main.js leaderAutoplayCheck 的那一道沒觸發），頁面繼續播，
   * 賽前節目 04:15 開了，收割端還停在 FP3 裡——alTick 只在首頁才開下一場。
   * 規則（只管賽程裡有 F1TV 網址的那幾支，手動點的別支不管）：表定結束之後，
   *   ①main.js 判斷已經不是直播（播放清單看得出來）→ 離開；
   *   ②還說是直播也一樣離開，只要超過表定結束 AL_OVERRUN_SEC（正賽 3 小時、其他 90 分鐘——延誤、紅旗也夠用）。
   * ⚠️ 不為了下一場就離開還在直播的這一場（排位延誤時不可以為了賽後節目跳走，同 alPreferMain 的反方向）。
   * 離開走 main.js 的 goHome（記成播完、送 bye、送最後一份診斷），alTick 回首頁後開下一場。
   */
  const AL_OVERRUN_SEC = { race: 3 * 3600 };
  const AL_OVERRUN_DEFAULT_SEC = 90 * 60;
  async function alLeaveEnded() {
    const cid = cidOf(location.pathname);
    if (!cid) return;
    const t = setInterval(async () => {
      try {
        if (!(await get(AL.on, false))) return;
        // 收割佇列開的頁（重播收割）不是自動開直播的事：表定結束 90 分鐘後的「超過上限」會把佇列正在收的那一支踢走
        // （2026-11-01 R19：Ray 重新載入後佇列接手收排位重播，排位表定 22:00 結束，23:30 就會被 goHome）
        if ((await qLoad()).running || (await crawlLoad()).active) return;
        await alNowSessions();                                     // 確保 alSched 載入（30 分鐘快取）
        let mine = null;
        for (const g of alSched || []) {
          for (const s of alSessions(g)) {
            const d = g.f1tv && g.f1tv[s.kind];
            if (d && d.cid === cid) mine = s;
          }
        }
        if (!mine) return;
        const now = Date.now() / 1000;
        const end = mine.at + (mine.len || AL_LEN[mine.kind] || 3600);
        if (now < end) return;
        const a = window.__plAdmin && window.__plAdmin.snapshot && window.__plAdmin.snapshot();
        const notLive = !!(a && a.cid === cid && a.playlistSegs && !a.isLive);
        const over = now >= end + (AL_OVERRUN_SEC[mine.kind] || AL_OVERRUN_DEFAULT_SEC);
        // 不是直播了＝這一頁已經改成整軌預抓（R19 FP3 20:10Z 起的診斷：「預抓中、前導不在」）。
        // 收完再走（Ray：「收割完了之後要自己退出」）；但下一場快開始（表定前 AL_DIRECT_SEC）就不等了——直播優先，重播之後還能收
        const harvested = !!(a && (a.harvestDone || a.bundleComplete));
        const done0 = await get(AL.ended, []);
        const nextSoon = (await alNowSessions()).some((h) => {
          const d = h.g.f1tv && h.g.f1tv[h.s.kind];
          return d && d.cid !== cid && now >= h.s.at - AL_DIRECT_SEC && !done0.includes(d.cid);
        });
        if (!over && !(notLive && (harvested || nextSoon))) return;
        clearInterval(t);
        const ended = await get(AL.ended, []);
        await set(AL.ended, ended.concat(cid).slice(-20));
        const why = `${mine.label || mine.kind}已經播完（${over ? '超過表定結束 ' + Math.round((now - end) / 60) + ' 分鐘' : harvested ? '不是直播了、重播也收完了' : '不是直播了，下一場快開始，重播之後再收'}），離開等下一場`;
        log('自動開直播：' + why);
        if (a && typeof window.__plAdmin.goHome === 'function') window.__plAdmin.goHome(why);
        else location.assign(ORIGIN + '/');
      } catch (e) { /* 下一輪再看 */ }
    }, 60000);
  }

  async function alKeepPlaying() {
    const went = await get(AL.went, null);
    if (!went || went.cid !== cidOf(location.pathname) || Date.now() - went.at > 10 * 60000) return;
    if (!(await get(AL.on, false))) return;
    const startedAt = Date.now();
    const giveUp = startedAt + AL_PLAY_WAIT_MS;
    let lastT = -1, moving = 0, kicked = false;
    const t = setInterval(() => {
      // F1TV 直播開頭會跳「Watch Live or from Start」視窗，不選影片就卡著不播（R18 Pre-Qualifying 實測）。
      // 前導端一定要貼直播邊緣 → 選 WATCH LIVE。只比對按鈕本身的文字，不碰「WATCH FROM START」
      const wl = [...document.querySelectorAll('button, a, [role="button"]')]
        .find((b) => /^\s*watch live\s*$/i.test(b.textContent || '') && b.offsetParent !== null);
      if (wl) { log('自動開直播：選「WATCH LIVE」'); wl.click(); }
      const v = document.querySelector('video');
      if (v) {
        // ⚠️ **不要從外面叫影片播放**（A12，2026-10-31 R19 FP1 實測）：以前每 2 秒 `muted = true`＋`play()`，
        //   影片在播放器還停在「Watch Live / from Start」時就被我們播起來，F1TV 的介面沒走完自己的流程——
        //   影片框 0×0、畫面全黑、進度條不動、字幕跑到左上角，底下照樣在播（480×270、不掉幀）。
        //   R18 Post-Race、R19 Warm-Up、FP1 開場都是排程自動開的那一次凍住；Ray 回首頁自己點進去（這段不介入）就正常。
        //   聲音由 autolive.ps1 的 --mute-audio 關、自動播放由 --autoplay-policy 放行，不需要我們碰影片。
        //   只有播放器 90 秒都沒有自己播、畫面上也沒有 WATCH LIVE 可按時，才補叫一次 play()（最後手段）。
        if (v.paused && !wl && !kicked && Date.now() - startedAt > AL_PLAY_KICK_MS) {
          kicked = true;
          log('自動開直播：播放器 90 秒沒有自己播，補叫一次播放');
          v.play().catch(() => {});
        }
        moving = (!v.paused && v.currentTime !== lastT && lastT >= 0) ? moving + 1 : 0;
        lastT = v.currentTime;
        if (moving >= 3) { clearInterval(t); log('自動開直播：已經在播，不再介入'); set(AL.err, null).catch(() => {}); alCheckLive(went); return; }
      }
      if (Date.now() > giveUp) {
        clearInterval(t);
        log('自動開直播：4 分鐘沒播起來（直播可能還沒開始），回首頁稍後再試');
        location.assign(ORIGIN + '/');
      }
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // F1TV 登入憑證（A24，2026-10-31 R19 FP2）
  // ---------------------------------------------------------------------------
  // F1TV 的 `entitlement_token`／`login-session` Cookie 是 JWT、效期 4 天，過期了 F1TV 不會自己換：
  // 收割設定檔 FP1 還能看，FP2 開影片頁回 ER9003（訂閱方案不足），手動點也一樣，**重新登入就好**（Ray 實測）。
  // 所以：①面板（＝後台收割端卡片）顯示到期時間；②剩不到 F1_RENEW_H 小時、而且不在場次時間窗內，
  // 自己登出再登入換一張新的；撞到 ER9003 也一樣（最後的補救）。
  // 登出：/settings 的「SIGN OUT」。登入：選單（左上三條線）→「Sign in」→ id.formula1.com 的表單（src/admin/f1login.js 填）。
  // ⚠️ 帳號密碼由 Ray 在面板「🔑 F1TV 帳號」輸入，只存這個設定檔的 chrome.storage.local；不送後端、不寫 log。
  //    Chrome 存的密碼不能用：自動填入的值在有人真的點過頁面之前，網頁與擴充功能都讀不到。
  // ⚠️ 一次只走一輪、每一步 5 分鐘逾時、兩輪至少隔 6 小時（ER9003 隔 30 分鐘）；失敗就停下來在面板說明，不重試
  //    （F1TV 有 Imperva，登入頁被當成機器人只會更糟）。Ray 實測登出只影響這個瀏覽器：另一個設定檔的前導端照常有心跳
  const F1 = { cred: 'plF1Cred', st: 'plF1Relogin' };
  const F1_RENEW_H = 12;
  const F1_GAP_MS = 6 * 3600000;
  const F1_GAP_ER9003_MS = 30 * 60000;
  const F1_STEP_MS = 5 * 60000;
  /** entitlement_token 的到期時間（秒）；沒有這個 Cookie（沒登入）回 0 */
  function f1Exp() {
    const m = document.cookie.match(/(?:^|; )entitlement_token=([^;]*)/);
    if (!m) return 0;
    try {
      const p = JSON.parse(atob(decodeURIComponent(m[1]).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return Number(p.exp) || 0;
    } catch (e) { return 0; }
  }
  const f1Fmt = (sec) => { const d = new Date(sec * 1000); const z = (n) => String(n).padStart(2, '0'); return `${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
  async function f1Lines() {
    const exp = f1Exp();
    const left = (exp * 1000 - Date.now()) / 3600000;
    const st = await get(F1.st, null);
    const cred = await get(F1.cred, null);
    const L = [`F1TV登入　${exp ? `到期 ${f1Fmt(exp)}（剩 ${left < 0 ? '0，已過期' : left.toFixed(1) + ' 小時'}）${left < F1_RENEW_H ? '　⚠ 快過期' : ''}` : '⚠ 沒有登入憑證（未登入）'}`
      + `　自動登入 ${cred && cred.email ? '已設定' : '未設定'}`];
    if (st && st.stage) L.push(`　　　自動登入進行中：${st.stage}（${st.why}）`);
    else if (st && st.fail) L.push(`　　　上次自動登入失敗：${st.fail}`);
    return L;
  }
  const f1Visible = (re) => [...document.querySelectorAll('button, a, [role="button"]')]
    .find((x) => re.test(x.textContent || '') && x.offsetParent !== null);
  /** 開始一輪：記下狀態、到 /settings 登出 */
  async function f1Start(why) {
    // ⚠️ 2026-10-31 實測：F1 登入頁有行為偵測（document 聽 pointermove／keydown…、DaVinci 的 dvResponse），
    //    程式送出一律被拒（click → 「problem with your password or email」；Enter 鍵事件、requestSubmit 都送不出去）。
    //    要全自動只能偽造真人操作＝繞過機器人偵測，不做。自動登出卻登不回去會把還能用的收割端弄壞，
    //    所以只留面板按鈕（manual，Ray 在電腦前）；renew／nologin／ER9003 一律不自動登出（handoff A24）
    if (why !== 'manual') return false;
    const cred = await get(F1.cred, null);
    if (!cred || !cred.email || !cred.pw) return false;
    const st = await get(F1.st, null) || {};
    if (st.stage) return false;
    // 'manual'＝面板按鈕（Ray 自己按的，不受間隔限制）
    // ER9003／沒登入＝現在就收不到，30 分鐘就可以再試；主動換（renew）隔 6 小時
    if (why !== 'manual' && Date.now() - (st.lastAt || 0) < (why === 'ER9003' || why === 'nologin' ? F1_GAP_ER9003_MS : F1_GAP_MS)) return false;
    await set(F1.st, { stage: 'logout', at: Date.now(), why, oldExp: f1Exp(), lastAt: Date.now() });
    log(`F1TV 自動登入：開始（${why}），先到 /settings 登出`);
    location.assign(ORIGIN + '/settings');
    return true;
  }
  async function f1Fail(st, why) {
    await set(F1.st, { lastAt: st.lastAt, fail: `${why}（${f1Fmt(Date.now() / 1000)}）` });
    log('F1TV 自動登入：失敗——' + why);
    note('F1TV 自動登入失敗', `${why}。請在這個視窗手動登入 F1TV（選單 → Sign in）；手動登入也不行的話，重連 VPN 再試（Ray 2026-10-31）。`);
  }
  let f1Busy = false;
  /** 每 3 秒推進一步（換頁之後從 storage 接著做） */
  async function f1Step() {
    if (f1Busy) return;
    const st = await get(F1.st, null);
    if (!st || !st.stage) return;
    f1Busy = true;
    try {
      if (Date.now() - st.at > F1_STEP_MS) { await f1Fail(st, `「${st.stage}」這一步 5 分鐘沒有完成`); return; }
      if (st.stage === 'logout') {
        if (location.pathname !== '/settings') { location.assign(ORIGIN + '/settings'); return; }
        const out = f1Visible(/^\s*sign out\s*$/i);
        if (out) {
          await set(F1.st, Object.assign({}, st, { stage: 'signin', at: Date.now() }));
          log('F1TV 自動登入：按 SIGN OUT');
          out.click();
        } else if (f1Visible(/^\s*sign in\s*$/i) || !f1Exp()) {
          await set(F1.st, Object.assign({}, st, { stage: 'signin', at: Date.now() }));   // 已經是登出的
        }
        return;
      }
      if (st.stage === 'signin') {
        let b = f1Visible(/^\s*sign in\s*$/i);
        if (!b) {
          // 左上角三條線（Ray 2026-10-31 示範）：header 裡第一個沒有文字的按鈕，或 aria-label 像選單的
          const menu = [...document.querySelectorAll('header button, nav button, button[aria-label]')]
            .find((x) => x.offsetParent !== null && (/menu|navigation/i.test(x.getAttribute('aria-label') || '') || !(x.textContent || '').trim()));
          if (menu) { menu.click(); await sleep(1200); b = f1Visible(/^\s*sign in\s*$/i); }
        }
        if (b) {
          await set(F1.st, Object.assign({}, st, { stage: 'form', at: Date.now() }));
          log('F1TV 自動登入：按 Sign in');
          b.click();
        }
        return;
      }
      if (st.stage === 'back') {
        const exp = f1Exp();
        if (exp && exp > (st.oldExp || 0) && exp * 1000 > Date.now() + F1_RENEW_H * 3600000) {
          await set(F1.st, { lastAt: st.lastAt, okAt: Date.now() });
          await set(AL.err, null);
          log(`F1TV 自動登入：成功，新的憑證到期 ${f1Fmt(exp)}`);
          note('F1TV 已重新登入', `新的登入憑證到期 ${f1Fmt(exp)}。自動開直播照常。`);
          if (location.pathname !== '/') location.assign(ORIGIN + '/');
        }
      }
      // 'form'：在 id.formula1.com，由 f1login.js 處理；回到 F1TV 卻還是 'form' 就等逾時
    } finally { f1Busy = false; }
  }
  /** 主動換：剩不到 F1_RENEW_H 小時（或沒登入），而且現在不在任何場次的時間窗內（表定前 35 分鐘～結束後 1 小時） */
  async function f1Renew() {
    if (/^\/detail\//.test(location.pathname) || location.pathname === '/settings') return;
    if (!(await get(AL.on, false))) return;
    const exp = f1Exp();
    if (exp && exp * 1000 - Date.now() > F1_RENEW_H * 3600000) return;
    let hits = [];
    try { hits = await alNowSessions(); } catch (e) { return; }
    if (hits.length) return;
    await f1Start(exp ? 'renew' : 'nologin');
  }
  /** 面板「🔑 F1TV 帳號」：輸入、更換或清除。密碼欄是 type=password */
  function f1CredForm() {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center';
    box.innerHTML = '<form style="background:#16161c;color:#eee;padding:16px;border-radius:8px;display:grid;gap:8px;width:320px;font:13px system-ui,\'Microsoft JhengHei\',sans-serif">'
      + '<b>F1TV 帳號（自動重新登入用）</b><span style="opacity:.75">只存在這個 Chrome 設定檔，不會送出去。</span>'
      + '<input name="e" type="email" autocomplete="off" placeholder="Email" style="padding:6px">'
      + '<input name="p" type="password" autocomplete="new-password" placeholder="Password" style="padding:6px">'
      + '<div style="display:flex;gap:6px"><button type="submit">儲存</button><button type="button" data-x="clear">清除</button><button type="button" data-x="close">取消</button></div></form>';
    const f = box.querySelector('form');
    get(F1.cred, null).then((c) => { if (c && c.email) f.e.value = c.email; });
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!f.e.value.trim() || !f.p.value) { note('沒有儲存', 'Email 與密碼都要填。'); return; }
      await set(F1.cred, { email: f.e.value.trim(), pw: f.p.value });
      box.remove(); note('已儲存 F1TV 帳號', `登入憑證剩不到 ${F1_RENEW_H} 小時（而且不在場次時間）或撞到 ER9003 時，會自己登出再登入。`);
    };
    box.querySelector('[data-x="clear"]').onclick = async () => { await set(F1.cred, null); box.remove(); note('已清除 F1TV 帳號', '不會再自動登入。'); };
    box.querySelector('[data-x="close"]').onclick = () => box.remove();
    document.body.appendChild(box);
    f.e.focus();
  }

  // ---------------------------------------------------------------------------
  // 啟動
  // ---------------------------------------------------------------------------
  (async () => {
    // 等頁面與播放器起來
    await sleep(2500);
    const on = await hasToken();
    const q = await qLoad();
    const c = await crawlLoad();
    if (await get(K.panel, false) || q.running || c.active) panelSet(true);
    // 卡住的佇列（「執行中 剩 0」、正在收的那支中途離開）先修好，否則會擋住自動開直播（2026-11-02 R19 正賽）
    await qHeal().catch(() => {});
    // watch 要在權杖判斷之前：佇列在跑卻沒有權杖時，由它暫停佇列並說明（否則佇列永遠掛著「執行中」）
    if (!c.active) watch();
    // F1TV 自動重新登入：進行中的那一輪每 3 秒推進一步；到期前主動換每 5 分鐘看一次（A24）
    setInterval(() => f1Step().catch(() => {}), 3000);
    f1Step().catch(() => {});
    setInterval(() => f1Renew().catch(() => {}), 5 * 60000);
    setTimeout(() => f1Renew().catch(() => {}), 20000);
    if (!on) return;                                    // 沒有權杖：面板可以開，但什麼都不自動做
    // 排程開的收割端，「📡 自動開直播」卻是關的 → 照排程打開（A14，2026-10-26）。
    // R18 Pre-Race：重裝擴充功能把開關清掉了，排程照樣準時開了 Chrome，卻停在首頁什麼都不做，Ray 手動點進去。
    // 會帶這個記號的只有 autolive.ps1，而它只開收割專用的設定檔；主機／備援機由排程那一台的 -Standby 決定。
    // 已經開著的不動（使用者在面板選了備援機，排程不可以把它改回主機）
    if (AL_LAUNCH) {
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* noop */ }
      if ((await get(AL.on, false)) === false) {
        const mode = AL_LAUNCH === 'standby' ? 'standby' : true;
        await set(AL.on, mode);
        log(`自動開直播：排程開的視窗、開關卻是關的 → 打開（${mode === true ? '主機' : '備援機'}）`);
        note('自動開直播已由排程打開', `這個視窗是 tools/autolive.ps1 開的，「📡 自動開直播」原本是關的（重裝擴充功能會清掉）。已設成「${mode === true ? '主機' : '備援機（待命）'}」。`);
      }
    }
    // 自動開直播：首頁每 20 秒看一次；影片頁只負責「自動開的那一支要播起來」
    alKeepPlaying().catch(() => {});
    if (AL_PREFER_MAIN) alPreferMain().catch(() => {});
    alLeaveEnded().catch(() => {});
    // 擴充功能重新載入／更新後，已經開著的分頁不會拿到新版（Chrome 不重新注入），舊的這一份跟擴充功能斷線，
    // 卻還掛在播放器的串流上——R18 Pre-Qualifying 實測：畫面全黑、時間軸不動，按 F5 才好。
    // 自動開直播的設定檔沒有人顧：偵測到斷線就自己重新整理。⚠️ 斷線後讀不到 storage，所以開關要在這裡先讀好
    if (await get(AL.on, false)) {
      // F1TV 偶爾回錯誤頁「Oops, Something went wrong (ER9004)」＋「GO BACK HOME」按鈕
      // （R18 排位實測：賽前節目結束、收割端照設計回首頁時出現，Ray 手動按才回來）。看到就自己按，30 秒最多一次
      let oopsAt = 0;
      setInterval(() => {
        if (Date.now() - oopsAt < 30000) return;
        // 2026-10-31 R19 FP1：影片頁按 F5 回的是 404，按鈕是「Back to home」。只在頁面看得出是錯誤頁時才按
        const b = [...document.querySelectorAll('button, a, [role="button"]')]
          .find((x) => /^\s*(go back home|back to home)\s*$/i.test(x.textContent || '') && x.offsetParent !== null);
        if (!b) return;
        if (!/ER\d{3,5}|404|not found|went wrong/i.test(document.body.textContent || '')) return;
        oopsAt = Date.now();
        const code = ((document.body.textContent || '').match(/ER\d{3,5}/) || ['?'])[0];
        // 記下這一支撞到錯誤頁，alTick 依錯誤碼等一陣子才再開（AL_ERR_*）。先記再按：按下去就換頁了
        (async () => {
          const went = await get(AL.went, null);
          const cid = cidOf(location.pathname) || (went && went.cid) || '';
          const prev = await get(AL.err, null);
          const n0 = prev && prev.cid === cid ? (prev.n || 0) : 0;
          // 自動開的這一支還沒到表定開始：直播還沒開，不算一次失敗（見 AL_ERR_PRE_MIN）
          const pre = code !== 'ER9003' && !!(went && went.cid === cid && went.start && Date.now() / 1000 < went.start);
          const n = pre ? n0 : n0 + 1;
          await set(AL.err, { cid, code, at: Date.now(), n, pre });
          log(pre ? `自動開直播：F1TV 錯誤頁（${code}），還沒到表定開始（直播大概還沒開），按 GO BACK HOME、${AL_ERR_PRE_MIN} 分鐘後再試`
            : `自動開直播：F1TV 錯誤頁（${code}），按 GO BACK HOME；第 ${n} 次`);
          // ER9003＝登入憑證失效：有存帳號就直接去登出再登入（不按 GO BACK HOME，f1Start 會換頁）
          if (code === 'ER9003' && (await f1Start('ER9003'))) return;
          if (code === 'ER9003') {
            note('F1TV 說這個帳號不能看直播（ER9003）',
              `F1TV 的「訂閱方案不足」：這個設定檔的 F1TV 登入狀態有問題，重試不會好。請在這個視窗確認 F1TV 的登入（必要時登出再登入）；自動開直播 ${AL_ERR_SUB_MIN} 分鐘後才會再試。`);
          }
          b.click();
        })().catch(() => b.click());
      }, 5000);
      setInterval(() => {
        let alive = false;
        try { alive = !!(chrome.runtime && chrome.runtime.id); } catch (e) { alive = false; }
        // 影片頁直接重新整理會變 404（2026-10-31 R19 FP1 Ray 實測 F5）→ 影片頁改回首頁，自動開直播 20 秒內再點進去
        if (!alive) { if (/^\/detail\//.test(location.pathname)) location.assign(ORIGIN + '/'); else location.reload(); }
      }, 5000);
    }
    // A4：F1TV 賽事頁的真實時程。只在不是影片頁時跑（看影片時不多打 F1TV），12 小時一輪
    const syncIfIdle = () => { if (!/^\/detail\//.test(location.pathname)) get(AL.on, false).then((v) => v && alSyncF1tv().catch(() => {})); };
    setTimeout(syncIfIdle, 6000);
    setInterval(syncIfIdle, 30 * 60000);
    setInterval(() => alTick().catch((e) => log('自動開直播：' + e.message)), AL_TICK_MS);
    setTimeout(() => alTick().catch(() => {}), 4000);
    if (c.active) { setTimeout(() => crawlTick().catch((e) => log('全季收割：' + e.message)), 2500); return; }
    // 等 SPA 把清單畫出來再問
    setTimeout(() => offer().catch(() => {}), 3500);
  })();
})();
