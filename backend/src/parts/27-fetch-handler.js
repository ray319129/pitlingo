export default {
  /**
   * 每天自動同步賽程。
   *
   * ⚠️ **賽程不能靠人工每週改**（使用者的要求）。比賽時間變更、延期、
   *    加減場次都會直接影響已售出通行證的效期，而那是動態算的——
   *    只要賽事資料是對的，效期就是對的。
   *
   * ⚠️ 同步失敗**不做任何事**，保留原賽程。外部來源壞掉時若清空資料，
   *    整個購買頁會空掉、所有效期算成 null，而且不會報錯。
   */
  async scheduled(event, env, ctx) {
    /* @test-only:start */
    // 測試後端沒有設排程；萬一有人加了，也不可以同步賽程或多寄一封每日彙報
    if (env.PITLINGO_ROLE === 'asr-test') return;
    /* @test-only:end */
    env = withMeter(env);                        // 排程也會寫 KV，一樣要計
    // 每 5 分鐘那一個只做前導端巡查；每日的同步、彙報只在 0 4 * * * 跑
    if (event && event.cron === LEADER_WATCH_CRON) {
      ctx.waitUntil(leaderWatch(env).catch((e) => console.log('leaderWatch 失敗：' + String((e && e.message) || e).slice(0, 200))));
      return;
    }
    ctx.waitUntil((async () => {
      const r = await syncSchedule(env).catch((e) => ({ ok: false, reason: String(e) }));
      // 結果寫進 KV，後台看得到「上次同步發生什麼事」——
      // 排程失敗最容易變成沒有人知道的靜默失敗。
      try {
        await env.SUBS.put("sched:lastrun", JSON.stringify({ at: nowSec(), result: r }),
          { expirationTtl: 90 * 86400 });
      } catch (e) { /* 記不起來也不能讓排程整個爆掉 */ }

      // 代訂：過了使用期間的收尾、清掉代理商帳號的密文。失敗不擋彙報
      try { await resellExpire(env); } catch (e) { /* 明天再試 */ }

      // 帳本：把付款／退款的訂單快照進 D1（KV 的訂單 400 天後過期，帳要留更久）。沒人打開帳本也要每天記到
      try { const db = resellDb(env); if (db) await ledgerSyncOrders(env, db); } catch (e) { /* 明天再試 */ }

      // ⚠️ **彙報要在同步之後跑。** 彙報會報告「賽程同步結果」，
      //    順序反過來的話報的永遠是昨天的。
      //
      // ⚠️ 同步失敗**不可以讓彙報也不跑**——那正是最需要通知你的一天。
      try {
        await loadSchedule(env);
        const d = await buildDigest(env);
        const sent = await sendDigest(env, d);
        await env.SUBS.put('digest:last', JSON.stringify({
          at: d.at, subject: d.subject, alerts: d.alerts, sections: d.sections, sent,
        }), { expirationTtl: 30 * 86400 });
      } catch (e) {
        try {
          await env.SUBS.put('digest:last', JSON.stringify({
            at: nowSec(), subject: '彙報產生失敗', alerts: [String((e && e.message) || e)],
            sections: [], sent: { mail: 'skipped', webhook: 'skipped' },
          }), { expirationTtl: 30 * 86400 });
        } catch (e2) { /* 連記錄都失敗就算了，不能讓排程爆掉 */ }
      }
    })());
  },

  async fetch(request, env, ctx) {
    const res = await handleRequest(request, env, ctx);
    try {
      const c = siteCorsFor(request, new URL(request.url).pathname);
      if (!c) return res;
      // Response 的 headers 是唯讀的，要重建一份才改得動
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(c)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      return res;
    }
  },
};

async function handleRequest(request, env, ctx) {
  // ⚠️ **每個進入點都要包一次計量。** 漏包的那條路會靜靜地不被計入，
  //    而「看起來寫得比實際少」比完全沒有數字更危險——你會照著它做決定。
  env = withMeter(env);
  // ⚠️ **賽程要在最前面載一次。** 之後所有算效期的地方都是同步函式，
  //    沒有機會 await。載不到會自動退回內建賽程（見 loadSchedule）。
  try { await loadSchedule(env); } catch (e) { /* 用內建的 */ }
  {
    const url = new URL(request.url);
    const path = url.pathname;
    /* @test-only:start */
    // ⚠️ 測試後端（wrangler.test.toml 設 PITLINGO_ROLE=asr-test）只回應語音辨識與健康檢查。
    //    它跑的是完整的程式碼、綁的是同一個 KV——不擋的話等於多一個沒人看管的正式 API。
    if (env.PITLINGO_ROLE === 'asr-test' && !path.startsWith('/v1/asr/') && path !== '/v1/health'
      && request.method !== 'OPTIONS') {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    /* @test-only:end */
    // ⚠️ 寫入遠端設定（POST／DELETE /v1/config）也是管理操作：它能推 killSwitch、改選擇器，
    //    一次讓所有人的字幕停擺。它不在 /v1/admin/ 底下，**原本完全沒走入口檢查**——
    //    沒有動態碼、沒有失敗鎖定、沒有稽核，只比一次權杖（2026-09-17 發現）。
    const isAdmin = path.startsWith('/v1/admin/')
      || (path === '/v1/config' && (request.method === 'POST' || request.method === 'DELETE'))
      || (path === '/v1/subs' && request.method === 'POST');

    // 預檢。三種情況要分開：
    //   管理端點  本機開的 `file://` 後台，Origin 是 null，要放寬
    //   網站端點  只允許我們自己的網域（見 SITE_ORIGINS）
    //   其他      維持不開 CORS，瀏覽器端的跨站呼叫直接被擋掉
    if (request.method === 'OPTIONS') {
      const site = siteCorsFor(request, path);
      return new Response(null, { status: 204, headers: isAdmin ? ADMIN_CORS : (site || CORS) });
    }
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';

    // ⚠️ **管理端的單一入口檢查。** 各端點裡的 authAdmin 一律保留（縱深防禦），
    //    但白名單、第二把鎖、失敗鎖定、稽核只在這裡做一次——
    //    散在 30 個端點裡的檢查，遲早會有一個新端點忘了接。
    if (isAdmin) {
      const g = await adminGate(env, request, path, ip);
      if (!g.ok) return adminJson({ error: g.error }, g.status);

      // 後台登入畫面。走到這裡代表 adminGate 已驗過 ADMIN_TOKEN（有設第二把鎖時也驗過動態碼）。
      // 沒設 ADMIN_TOTP_SECRET 時不發工作階段——每次請求只看權杖，發了也沒有意義。
      if (path === '/v1/admin/login' && request.method === 'POST') {
        const s = env.ADMIN_TOTP_SECRET ? await adminSessionIssue(env, g.who) : null;
        return adminJson({
          ok: true,
          otpEnabled: !!env.ADMIN_TOTP_SECRET,
          session: s ? s.session : null,
          expiresAt: s ? s.expiresAt : null,
        });
      }
    }

    try {
      // 彈幕（尚未發行，見 26-danmaku.js）。不是彈幕的路徑回 null，往下走
      if (path.startsWith('/v1/dm/')) return await handleDanmaku(request, env, path, url, ip, null);
      if (path.startsWith('/v1/admin/dm/')) return await handleDanmakuAdmin(request, env, path, url);

      if (path === '/v1/health') {
        return json({ ok: true, ts: new Date().toISOString(), model: MODEL, version: BACKEND_VERSION });
      }

      // 遠端設定優先讀 KV，讀不到才用內建預設。
      // 這樣 F1TV 改版時只要 POST 一次就能救所有使用者，不必重新部署 Worker。
      if (path === '/v1/config' && request.method === 'GET') {
        const raw = await env.SUBS.get('config');
        let cfg = REMOTE_CONFIG;
        if (raw) { try { cfg = JSON.parse(raw); } catch (e) { /* 壞掉就用內建的 */ } }

        // 分階段推送：用戶端帶自己的 installId，伺服器決定他該拿哪一版。
        // 分流在伺服器做而不是用戶端，這樣才能單方面收回一次失敗的推送。
        const rollout = cfg.rollout === undefined ? 100 : Number(cfg.rollout);
        const iid = url.searchParams.get('iid') || '';
        if (rollout < 100 && iid && (await bucketOf(iid)) >= rollout) {
          const prev = await env.SUBS.get('config:prev');
          if (prev) { try { cfg = JSON.parse(prev); } catch (e) { /* 用現行的 */ } }
          else cfg = REMOTE_CONFIG;
        }
        // ⚠️ 不可以放 max-age：推送與 killSwitch 要能即時生效（坑 #26 同一類）
        return json(cfg, 200, { 'cache-control': 'no-store' });
      }

      // 熱修入口：改選擇器不用重新部署，也不用等商店審核
      if (path === '/v1/config' && request.method === 'POST') {
        if (!authAdmin(env, request)) return err('unauthorized', 401);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.sites)) return err('需要 { version, sites: [...] }');
        // rollout 必須合法，否則推錯一個數字就等於全站生效或全站失效
        if (body.rollout !== undefined
            && !(Number.isFinite(body.rollout) && body.rollout >= 0 && body.rollout <= 100)) {
          return err('rollout 必須是 0~100');
        }
        // 保留上一版，讓不在推送範圍內的安裝有東西可用
        const prevRaw = await env.SUBS.get('config');
        if (prevRaw) await env.SUBS.put('config:prev', prevRaw);
        await env.SUBS.put('config', JSON.stringify(body));
        return json({
          ok: true, version: body.version, sites: body.sites.length,
          rollout: body.rollout === undefined ? 100 : body.rollout,
        });
      }

      // 出事時的還原鍵：刪掉 KV 就回到內建預設
      if (path === '/v1/config' && request.method === 'DELETE') {
        if (!authAdmin(env, request)) return err('unauthorized', 401);
        await env.SUBS.delete('config');
        return json({ ok: true, reverted: true, version: REMOTE_CONFIG.version });
      }

      // 匿名註冊：換一枚屬於這個安裝的權杖。不需要帳號、不收任何個資。
      // 用 IP 限制頻率，避免有人狂刷權杖來繞過 installId 的限額。
      if (path === '/v1/register' && request.method === 'POST') {
        if (await rateLimited(env, `reg:${ip}`)) return err('rate limited', 429);
        try {
          const t = await issueInstallToken(env);
          return json({ ok: true, token: t.token, exp: t.exp });
        } catch (e) {
          return err(String(e.message || e), 500);
        }
      }

      if (path === '/v1/subs' && request.method === 'GET') {
        let a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        // 付費與否用同一道閘門判斷（只讀，不扣額度）
        if (!a.acct) {
          const s = await verifySession(env, request.headers.get('authorization'));
          if (s) a = Object.assign({}, a, { acct: s.sub });
        }
        const gate = await checkEntitlement(env, a, request, 1);
        if (gate.reason === 'revoked') return json({ lines: {}, count: 0, reason: 'revoked', code: 'E21' }, 402);
        return handleGetSubs(request, env, url, {
          paid: gate.reason === 'licensed' || gate.reason === 'legacy', legacy: !!a.legacy,
        });
      }

      if (path === '/v1/subs' && request.method === 'POST') {
        if (!authHarvest(env, request, path)) return err('unauthorized', 401);
        return handlePostSubs(request, env);
      }

      if (path === '/v1/translate' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        return handleTranslate(request, env, ip, a, ctx);
      }

      // 前導收割端的心跳（直播期間每 30 秒一次）。只收付費或收割工具——
      // 免費的人送心跳只會讓「收割端不在」的告警失靈。
      if (path === '/v1/leader/beat' && request.method === 'POST') {
        let a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        if (await rateLimited(env, a.legacy ? ip : a.installId)) return err('請求太頻繁，請稍後再試', 429, 'E32');
        const gate = await checkEntitlement(env, a, request, 1);
        if (gate.reason !== 'licensed' && gate.reason !== 'legacy') return err('只有付費授權可以當前導收割端', 403);
        const b = await request.json().catch(() => null);
        const cid = String((b && b.cid) || '');
        if (!/^\d{1,20}$/.test(cid)) return err('cid 格式不正確');
        await roomOp(env, cid, { op: b.bye === true ? 'bye' : 'beat' });
        // 全域那一份：「前導端現在在不在」不分影片（排程告警、備援機待命都看這個）
        await roomOp(env, LEADER_GLOBAL_ROOM, { op: b.bye === true ? 'bye' : 'beat' });
        return json({ ok: true });
      }

      // 前導端在不在（2026-10-25）：備援機的待命模式用——主機有心跳就不開直播（同一個 F1TV 帳號兩路會互踢）
      if (path === '/v1/leader/status' && request.method === 'GET') {
        let a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        if (await rateLimited(env, a.legacy ? ip : a.installId)) return err('請求太頻繁，請稍後再試', 429, 'E32');
        const gate = await checkEntitlement(env, a, request, 1);
        if (gate.reason !== 'licensed' && gate.reason !== 'legacy') return err('只有付費授權可以查', 403);
        const pk = await roomOp(env, LEADER_GLOBAL_ROOM, { op: 'peek', keys: [] });
        if (!pk) return err('暫時查不到', 503);
        const leaderAt = Number(pk.leaderAt) || 0;
        const leaderByeAt = Number(pk.leaderByeAt) || 0;
        return json({ ok: true, leaderAt, leaderByeAt, present: leaderByeAt <= leaderAt && !!leaderAt && Date.now() - leaderAt <= LEADER_STALE_MS });
      }

      // 影片翻譯覆蓋地圖（擴充功能在 F1TV 目錄頁標「完整繁中／部分／沒有字幕」，#18）
      if (path === '/v1/coverage' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        if (await rateLimited(env, a.legacy ? ip : a.installId)) return err('請求太頻繁，請稍後再試', 429, 'E32');
        const b = await request.json().catch(() => null);
        const cids = (Array.isArray(b && b.cids) ? b.cids : []).map(String).filter((c) => /^\d{1,20}$/.test(c)).slice(0, 100);
        const map = await coverageMap(env);
        const out = {};
        for (const c of cids) if (map[c]) out[c] = map[c];
        return json({ ok: true, map: out });
      }

      if (path === '/v1/complete' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        // 以前完全沒有限流（security-audit #4）。legacy（userscript 收割）不限——它一晚標記幾十支
        if (!a.legacy && !(await kvWriteBudgetOk(env, 'complete', a.installId))) return err('回報太頻繁，請稍後再試', 429, 'E32');
        return handleComplete(request, env);
      }

      // ---- 授權（綁人，不綁裝置）----
      if (path === '/v1/license/activate' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        // 每次啟用都寫 KV；以前沒有任何限流（security-audit 2026-10-05 覆蓋檢查列為待補）
        if (!a.legacy && !(await kvWriteBudgetOk(env, 'activate', a.installId))) return err('操作太頻繁，請稍後再試', 429, 'E32');
        return handleLicenseActivate(request, env, a);
      }
      // 公開的方案資訊。購買頁用它顯示價格與早鳥剩餘數——
      // **價格寫死在前端會漂**，改後端就得改兩個地方，遲早忘記一個。
      // 購物車報價。購買頁每次改動都打這裡，**畫面上的數字一律由後端算**——
      // 前端自己算就一定會跟結帳收的錢漂掉，而那是最直接的糾紛。
      if (path === '/v1/quote' && request.method === 'POST') {
        const b = await request.json().catch(() => null);
        if (!b) return err('body 不是合法 JSON');
        // （2026-10-30 起升級折抵改看登入的帳號，不再拿授權碼比對購買信箱——
        //   security-audit run-2 #16 的「用一組碼試出信箱」不存在了，那道限次也就拿掉）
        const items = Array.isArray(b.items) ? b.items : [];
        if (!items.length) return err('購物車是空的');
        if (items.length > 10) return err('一次最多 10 個項目');
        const renew = await renewFor(env, request, b.email);
        const acctEmails = b.upgrade ? await accountEmailsOf(env, request) : null;
        const q = await quoteCart(env, items, { email: b.email, upgrade: !!b.upgrade, acctEmails, renew });
        if (q.error) return err(q.error);
        return json({
          ok: true,
          lines: q.lines, adjustments: q.adjustments, total: q.total,
          needsVpn: q.needsVpn, hasManual: q.hasManual, freeUpgrade: q.freeUpgrade,
          windows: q.windows || [], gpIds: q.gpIds || [],
          creditNote: q.creditNote || null,
        });
      }

      /**
       * 翻譯清單：哪些影片翻好了、各有幾句、屬於哪一場 GP。
       *
       * ⚠️ **只讀 metadata，不讀 bundle 本體。** 一份兩千句的 bundle 約 200KB，
       *    一百支就是 20MB——一次列表就會逾時，而且把 KV 讀取額度吃光。
       *    `list()` 直接回傳 metadata，那是為這種用途設計的。
       *
       * 舊資料沒有 metadata（在加上之前寫入的），會列在「待補資料」那一組，
       * 下次那支影片被寫入時就會自動補上——**不另外做回填**，
       * 回填要把每一份都讀出來再寫回去，代價正是我們要避免的那件事。
       */
      /**
       * 收割覆蓋率：**每一站的每一個場次，我們手上有沒有譯文。**
       *
       * 後台原本只回答得了「已經有什麼」，回答不了「還缺什麼」——
       * 而缺的那些正是下一場直播會用全額付費重翻一次的東西。
       */
      /**
       * 稽核紀錄：誰、何時、打了哪個管理端點、成功還是失敗。
       *
       * ⚠️ **失敗那幾筆才是重點。** 一整排 `ok: false / reason: token`
       *    代表有人正在試你的後台——那是目前唯一看得見這件事的地方。
       *    來源只存雜湊（不存 IP 原文），但同一個來源的雜湊是穩定的，
       *    所以「是不是同一個人一直試」仍然看得出來。
       */
      if (path === '/v1/admin/audit' && request.method === 'GET') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const rows = [];
        let cursor;
        for (let page = 0; page < 3; page++) {
          const r = await env.SUBS.list({ prefix: 'audit:', limit: 1000, cursor });
          for (const k of r.keys) {
            const m = k.metadata || {};
            rows.push({ at: m.at || 0, path: m.p || '', method: m.m || '', ok: !!m.ok, who: m.w || '', reason: m.r || '' });
          }
          if (r.list_complete) break;
          cursor = r.cursor;
        }
        rows.sort((a, b) => (b.at || 0) - (a.at || 0));
        const fails = rows.filter((x) => !x.ok);
        return adminJson({
          ok: true,
          rows: rows.slice(0, 300),
          total: rows.length,
          failures: fails.length,
          // 同一個來源失敗超過幾次就值得看一眼
          suspects: [...new Set(fails.map((x) => x.who))]
            .map((w) => ({ who: w, n: fails.filter((x) => x.who === w).length }))
            .filter((x) => x.n >= 3).sort((a, b) => b.n - a.n),
          layers: {
            token: !!env.ADMIN_TOKEN,
            otp: !!env.ADMIN_TOTP_SECRET,
            ipAllowlist: !!env.ADMIN_IPS,
            lockAfter: ADMIN_FAIL_MAX,
            lockMinutes: Math.round(ADMIN_LOCK_SEC / 60),
            auditDays: ADMIN_AUDIT_DAYS,
          },
        });
      }

      if (path === '/v1/admin/coverage' && request.method === 'GET') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const cov = await harvestCoverage(env, REMOTE_CONFIG);
        return adminJson({ ok: true, ...cov });
      }

      /**
       * 寄一封各種類型的樣本信。
       *
       * ⚠️ **不寫入任何記錄。** 為了測一封信而真的發一組授權碼，
       *    等於在正式資料裡留下一筆假訂單、一組假授權碼，
       *    而那會混進營收統計、授權管理、以及升級折抵的計算。
       *    這裡用的是**當場捏出來的假資料**，不碰 KV。
       *
       * ⚠️ 每一封的主旨都會加上「[樣本]」——收件匣裡分得出哪些是測試的，
       *    否則三個月後看到一封「訂單完成」會以為真的有人買了。
       */
      if (path === '/v1/admin/mail/test' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        if (!mailConfigured(env)) return adminJson({ error: '尚未設定寄信（EMAIL binding、RESEND_API_KEY、ZEPTOMAIL_TOKEN 都沒有）' }, 400);
        const b = await request.json().catch(() => null);
        const to = accountKey((b && b.to) || env.REPORT_TO);
        if (!to) return adminJson({ error: '缺少收件信箱' }, 400);

        const now = nowSec();
        const out = {};
        const tag = (s) => `[樣本] ${s}`;

        // 只測某一家寄信服務（2026-11-03，v5.88）：`{ via: 'cloudflare'|'resend'|'zeptomail' }`。
        // 平常 sendMail 第一家成功就停，後面兩家永遠測不到——備援要真的寄過一次才算存在。
        if (b && b.via) {
          const only = String(b.via);
          if (!['cloudflare', 'resend', 'zeptomail'].includes(only)) return adminJson({ error: 'via 只能是 cloudflare／resend／zeptomail' }, 400);
          const e2 = { ...env };
          if (only !== 'cloudflare') delete e2.EMAIL;
          if (only !== 'resend') delete e2.RESEND_API_KEY;
          if (only !== 'zeptomail') delete e2.ZEPTOMAIL_TOKEN;
          const r = await sendMail(e2, {
            to: [to], subject: tag(`寄信測試：${only}`),
            html: mailShell('寄信測試', `<p>這封信由 <b>${only}</b> 寄出。</p>`,
              { site: env.SITE_URL || 'https://pitlingo.com', why: '管理員在後台測試寄信服務' }),
          });
          return adminJson({ ok: r.ok, to, via: r.via, status: r.status, tried: r.tried });
        }

        // 1) 登入驗證碼
        try {
          const r = await sendOtpMail(env, to, '000000', tag);
          out.otp = r.ok ? 'sent' : 'failed';
        } catch (e) { out.otp = String((e && e.message) || e).slice(0, 100); }

        // 2) 單場通行證的訂單完成信
        try {
          const r = await sendLicenseMail(env, to, 'PLSAMPLE0001', {
            orderId: 'SAMPLE-WEEK', createdAt: now, expiresAt: now + 14 * 86400,
            paid: WEEKEND_PRICE, items: [{ key: 'week', qty: 1, unit: WEEKEND_PRICE }],
          }, { subjectTag: tag });
          out.licenseWeek = r.sent ? 'sent' : (r.reason || 'failed');
        } catch (e) { out.licenseWeek = String((e && e.message) || e).slice(0, 100); }

        // 3) 賽季票＋代訂（多列、含代訂說明的那一種）
        try {
          const r = await sendLicenseMail(env, to, 'PLSAMPLE0002', {
            orderId: 'SAMPLE-SEASON', createdAt: now, expiresAt: now + 180 * 86400,
            paid: PLANS.season.price,
            orderTotal: PLANS.season.price + PLANS.svc_prem_1y_own.price,
            items: [{ key: 'season', qty: 1, unit: PLANS.season.price },
              { key: 'svc_prem_1y_own', qty: 1, unit: PLANS.svc_prem_1y_own.price }],
            services: [{ key: 'svc_prem_1y_own', qty: 1, label: '代訂', status: 'pending' }],
          }, { subjectTag: tag });
          out.licenseSeason = r.sent ? 'sent' : (r.reason || 'failed');
        } catch (e) { out.licenseSeason = String((e && e.message) || e).slice(0, 100); }

        // 4) 不含字幕授權的那一種（買家會以為信寄漏了，所以要能看得到長什麼樣）
        try {
          const r = await sendLicenseMail(env, to, '', {
            orderId: 'SAMPLE-SVCONLY', createdAt: now, paid: PLANS.svc_pro_5d.price,
            items: [{ key: 'svc_pro_5d', qty: 1, unit: PLANS.svc_pro_5d.price }],
            services: [{ key: 'svc_pro_5d', qty: 1, label: '代訂', status: 'pending' }],
          }, { noLicense: true, subjectTag: tag });
          out.licenseNoKey = r.sent ? 'sent' : (r.reason || 'failed');
        } catch (e) { out.licenseNoKey = String((e && e.message) || e).slice(0, 100); }

        // 5) 管理員通知（新訂單的形狀）
        try {
          const r = await notifyAdmin(env, tag('[PitLingo] 新訂單 SAMPLE-0001'),
            '訂單　：SAMPLE-0001\n方案　：week\nemail　：buyer@example.com\n'
            + '授權碼：PL-SAMP-LE00-01\n寄信　：已寄出', { to });
          out.adminNotice = r.mail;
        } catch (e) { out.adminNotice = String((e && e.message) || e).slice(0, 100); }

        // 6) 每日彙報（用真實資料產生，但不寫 digest:last）
        try {
          const d = await buildDigest(env);
          const r = await sendMail(env, { to: [to], subject: tag(d.subject), html: d.html });
          out.digest = r.ok ? 'sent' : r.status;
        } catch (e) { out.digest = String((e && e.message) || e).slice(0, 100); }

        return adminJson({ ok: true, to, sent: out });
      }

      // ---- 寄信內容編輯（v5.94，25-mail-content.js）----
      if (path === '/v1/admin/mail/content' && request.method === 'GET') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        let history = [];
        try { history = JSON.parse((await env.SUBS.get(MAIL_HISTORY_KEY)) || '[]'); } catch (e) { history = []; }
        const defs = Object.entries(MAIL_DEFS).map(([id, d]) => ({
          id, name: d.name, when: d.when, vars: d.vars, blocks: d.blocks, required: d.required,
          subject: d.subject, heading: d.heading, body: d.body }));
        return adminJson({ ok: true, defs, content: await readMailContent(env), history: history.map((h) => ({
          version: h.version, publishedAt: h.publishedAt, publishedBy: h.publishedBy, note: h.note })) });
      }
      if (path === '/v1/admin/mail/preview' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        const id = String((b && b.id) || '');
        if (!MAIL_DEFS[id]) return adminJson({ error: '沒有這封信' }, 400);
        const content = sanitizeMailContent(b);
        // 用真正寄信的組信函式＋假資料：預覽長什麼樣，寄出去就長什麼樣
        const m = await MAIL_SAMPLES[id](env, content);
        return adminJson({ ok: true, subject: m.subject, html: m.html, problems: mailContentProblems(content, await opsConfig(env)) });
      }
      if (path === '/v1/admin/mail/content' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        if (!b || !b.texts) return adminJson({ error: '缺少 texts' }, 400);
        const content = sanitizeMailContent(b);
        const problems = mailContentProblems(content, await opsConfig(env));
        if (problems.length) return adminJson({ error: '內容有問題，沒有發布', problems }, 400);
        const saved = await publishMailContent(env, content, await adminWho(env, ip), b.note);
        return adminJson({ ok: true, version: saved.version });
      }
      if (path === '/v1/admin/mail/content/restore' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        let history = [];
        try { history = JSON.parse((await env.SUBS.get(MAIL_HISTORY_KEY)) || '[]'); } catch (e) { history = []; }
        const old = history.find((h) => h.version === Number(b && b.version));
        if (!old) return adminJson({ error: '找不到那個版本' }, 404);
        // 還原＝當成新的一版發布，而且要過同一道檢查（舊版可能寫著當時的價格或分鐘數）
        const content = sanitizeMailContent(old);
        const problems = mailContentProblems(content, await opsConfig(env));
        if (problems.length) return adminJson({ error: '那一版的內容與系統目前不符，不能直接還原', problems }, 400);
        const saved = await publishMailContent(env, content, await adminWho(env, ip), `還原自第 ${old.version} 版`);
        return adminJson({ ok: true, version: saved.version });
      }
      // 寄一封樣本給自己（主旨加「[樣本]」）。用草稿內容，不必先發布
      if (path === '/v1/admin/mail/sample' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        if (!mailConfigured(env)) return adminJson({ error: '尚未設定寄信' }, 400);
        const b = await request.json().catch(() => null);
        const id = String((b && b.id) || '');
        if (!MAIL_DEFS[id]) return adminJson({ error: '沒有這封信' }, 400);
        const to = accountKey((b && b.to) || env.REPORT_TO);
        if (!to) return adminJson({ error: '缺少收件信箱' }, 400);
        const content = sanitizeMailContent(b);
        const problems = mailContentProblems(content, await opsConfig(env));
        if (problems.length) return adminJson({ error: '內容有問題，沒有寄出', problems }, 400);
        const m = await MAIL_SAMPLES[id](env, content);
        const r = await sendMail(env, { to: [to], subject: `[樣本] ${m.subject}`, html: m.html });
        return adminJson({ ok: r.ok, to });
      }

      // 即時快照（後台「即時」分頁）。**先落地再讀**——計數器在 isolate
      // 記憶體裡，不先 flush 的話直播當下看到的永遠是上一次落地的舊數字，
      // 而那正是最需要看清楚的時刻。
      // ---- 網站內容編輯（只有通過後台門檻的人能寫）----
      if (path === '/v1/admin/site' && request.method === 'GET') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        let content = null; let history = [];
        try { content = JSON.parse((await env.SUBS.get(SITE_CONTENT_KEY)) || 'null'); } catch (e) { content = null; }
        try { history = JSON.parse((await env.SUBS.get(SITE_HISTORY_KEY)) || '[]'); } catch (e) { history = []; }
        return adminJson({ ok: true, content, history: history.map((h) => ({
          version: h.version, publishedAt: h.publishedAt, publishedBy: h.publishedBy, note: h.note })) });
      }
      if (path === '/v1/admin/site' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        if (!b || !b.content) return adminJson({ error: '缺少 content' }, 400);
        const { content, dropped } = sanitizeSiteContent(b.content);
        const facts = siteFactProblems(content, await opsConfig(env));
        if (facts.length) return adminJson({ error: '有文字寫的數字與系統實際不符，沒有發布', facts }, 400);
        const saved = await publishSiteContent(env, content, await adminWho(env, ip), b.note);
        return adminJson({ ok: true, version: saved.version, dropped, cacheSec: SITE_CACHE_SEC });
      }
      if (path === '/v1/admin/site/restore' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        let history = [];
        try { history = JSON.parse((await env.SUBS.get(SITE_HISTORY_KEY)) || '[]'); } catch (e) { history = []; }
        const old = history.find((h) => h.version === Number(b && b.version));
        if (!old) return adminJson({ error: '找不到那個版本' }, 404);
        // 還原＝把舊內容**當成新的一版發布**，不是覆寫歷史——還原本身也要能被還原
        const { content } = sanitizeSiteContent(old);
        // 舊版本可能寫著當時的價格或免費分鐘數——還原也要過同一道門
        const facts = siteFactProblems(content, await opsConfig(env));
        if (facts.length) return adminJson({ error: '那一版的文字與系統目前的數字不符，不能直接還原', facts }, 400);
        const saved = await publishSiteContent(env, content, await adminWho(env, ip), `還原自第 ${old.version} 版`);
        return adminJson({ ok: true, version: saved.version });
      }
      if (path === '/v1/admin/site/demo-candidates' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        return adminJson({ ok: true, candidates: await demoCandidates(env) });
      }

      if (path === '/v1/admin/live' && request.method === 'GET') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        return adminJson(await liveSnapshot(env, REMOTE_CONFIG));
      }

      /**
       * 收割計畫。不帶 `paths` 時只回答「現在該收哪幾場」（後台用）；
       * 帶了才額外回傳排好序的待跑佇列（userscript 刮完頁面後送上來）。
       *
       * ⚠️ **分類邏輯只有這一份。** 複製到 userscript 就是第五個跨檔案的
       *    硬性契約，而這個專案已經有四個、每一個都因為漂移出過事。
       *    用戶端只做它獨有的事：把頁面上的連結刮下來。
       */
      if (path === '/v1/admin/harvest/plan' && request.method === 'POST') {
        if (!authHarvest(env, request, path)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        const paths = Array.isArray(b && b.paths) ? b.paths : null;
        return adminJson({ ok: true, ...(await harvestPlan(env, REMOTE_CONFIG, paths)) });
      }

      // 收割端的即時狀態（2026-10-30）：管理版每 15 秒送一次，後台「即時狀態」顯示。存 DO，不寫 KV
      if (path === '/v1/admin/harvest/status' && request.method === 'POST') {
        if (!authHarvest(env, request, path)) return adminJson({ error: 'unauthorized' }, 401);
        const c = harvestStatusClean(await request.json().catch(() => null));
        if (c.error) return adminJson({ ok: false, error: c.error }, 400);
        const r = await roomOp(env, LEADER_GLOBAL_ROOM, { op: 'hstat', id: c.id, status: c.status });
        return adminJson({ ok: !!(r && r.ok) });
      }

      // F1TV 賽事頁的真實時程（A4，2026-10-26）。管理版收割端送上來；見 f1tvSchedClean
      if (path === '/v1/admin/harvest/f1tv-schedule' && request.method === 'POST') {
        if (!authHarvest(env, request, path)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        const g = b ? gpById(String(b.gpId || '')) : null;
        if (!g) return adminJson({ ok: false, error: '找不到這一站（gpId）' }, 400);
        const c = f1tvSchedClean(g, b.items);
        if (c.error) return adminJson({ ok: false, error: c.error, bad: c.bad }, 400);
        const r = await f1tvSchedSave(env, gpId(g), c.items);
        return adminJson({ ok: true, gpId: gpId(g), n: c.items.length, changed: r.changed, bad: c.bad, mismatch: c.mismatch, shows: gpShows(g) });
      }

      /**
       * 每日彙報。GET 是預覽（不寄信），`?send=1` 才真的寄出去。
       *
       * ⚠️ 預覽與排程走的是**同一個 buildDigest**。分成兩份的話，
       *    你看到的內容跟實際寄出去的會慢慢分岔，而且不會有人發現。
       */
      if (path === '/v1/admin/digest' && request.method === 'GET') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        if (url.searchParams.get('last') === '1') {
          let last = null;
          try { last = JSON.parse((await env.SUBS.get('digest:last')) || 'null'); } catch (e) { last = null; }
          return adminJson({ ok: true, last });
        }
        const d = await buildDigest(env, REMOTE_CONFIG);
        const sent = url.searchParams.get('send') === '1' ? await sendDigest(env, d) : null;
        return adminJson({
          ok: true, subject: d.subject, alerts: d.alerts, sections: d.sections, text: d.text, sent,
        });
      }

      if (path === '/v1/admin/bundles' && request.method === 'GET') {
        if (!authHarvest(env, request, path)) return adminJson({ error: 'unauthorized' }, 401);

        const items = await listBundleMeta(env);
        const suspect = suspectMarked(items, gpList(REMOTE_CONFIG), REMOTE_CONFIG.seasonYear || SEASON_YEAR);
        for (const it of items) it.suspect = suspect.has(String(it.cid));

        // 依比賽週分組。用 slug 比對賽程的站名——slug 是英文，賽程是中文，
        // 所以額外帶一份英文關鍵字對照。對不上的歸「其他／未分類」。
        const cfg = REMOTE_CONFIG;
        const groups = new Map();
        const put = (key, label, order, it) => {
          if (!groups.has(key)) groups.set(key, { key, label, order, items: [] });
          groups.get(key).items.push(it);
        };
        const season = cfg.seasonYear || SEASON_YEAR;
        for (const it of items) {
          // 中文場次名。slug 就是標題，不必向 F1TV 要（見 sessionTitle）。
          it.title = it.slug ? sessionTitle(it.slug, season) : '';
          const key = it.slug ? slugKeyOf(it.slug) : '';
          const hit = key ? scheduleList(cfg).find((g) => slugMatchesGp(key, g)) : null;
          if (hit) put(`r${hit.r}`, `R${hit.r} ${hit.name}（${hit.start}）`, hit.r, it);
          else if (!it.slug) put('nometa', '待補資料（沒有網址後綴，無法分類）', 998, it);
          // 季前測試不屬於任何一站，但它是每年第一批被收割的內容，
          // 丟進「其他」會跟真正對不上的混在一起看不出來。
          else if (key.includes('-pre-season-testing-')) put('testing', '季前測試', 900, it);
          else put('other', '其他／未分類', 999, it);
        }

        const out = [...groups.values()].sort((a, b) => a.order - b.order).map((g) => ({
          key: g.key,
          label: g.label,
          videos: g.items.length,
          lines: g.items.reduce((a, x) => a + x.lines, 0),
          complete: g.items.filter((x) => x.segCount > 0).length,
          items: g.items.sort((a, b) => b.lines - a.lines),
        }));

        // 沒有官方字幕的影片。**與「收割失敗」是兩回事**——
        // 前者是 F1TV 的內容問題（我們無能為力），後者是我們的問題。
        // 混在一起看，真正需要處理的那些會被淹沒。
        const noSub = [];
        try {
          let nc;
          for (let p = 0; p < 3; p++) {
            const nr = await env.SUBS.list({ prefix: 'nosub:', limit: 1000, cursor: nc });
            for (const k of nr.keys) {
              const md = k.metadata || {};
              noSub.push({ cid: k.name.slice(6), slug: md.slug || '', n: md.n || 1, at: md.at || 0 });
            }
            if (nr.list_complete) break;
            nc = nr.cursor;
          }
        } catch (e) { /* 統計讀不到不影響主清單 */ }
        noSub.sort((a, b) => (b.n || 0) - (a.n || 0));

        return adminJson({
          ok: true,
          totals: {
            videos: items.length,
            lines: items.reduce((a, x) => a + x.lines, 0),
            complete: items.filter((x) => x.segCount > 0).length,
            noMeta: items.filter((x) => !x.slug).length,
            noSub: noSub.length,
          },
          groups: out,
          noSub,
        });
      }

      /**
       * 回填舊 bundle 的摘要（metadata）。
       *
       * ⚠️ 我原本主張「不做回填，讓它自然補上」——**那個判斷是錯的**。
       *    自然補上的前提是「那支影片會再被寫入」，但已經完整收割過的影片
       *    正好**永遠不會再被寫入**（沒有新句子就不會上傳）。
       *    結果是最有價值的資料——已經翻好的那些——永遠停在「待補資料」。
       *
       * 一次處理一批，用 cursor 續跑。**每一份都要讀出來再寫回**，
       * 那正是列表時要避免的成本——但回填是一次性的，值得。
       *
       * `slug` 舊資料裡沒有，**無法從 contentId 反推**。這裡只補得回
       * 句數與分段數；slug 會在該影片下次被觀看或收割時補上（見 /v1/subs）。
       */
      if (path === '/v1/admin/backfill' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => ({}));
        const cursor = b && b.cursor ? String(b.cursor) : undefined;
        // 一批 25 支。再多會逼近 Worker 的 CPU 時間上限（每支要 JSON.parse 200KB）
        const r = await env.SUBS.list({ prefix: 'bundle:', limit: 25, cursor });

        let done = 0;
        let skipped = 0;
        for (const k of r.keys) {
          // 已經有摘要就跳過——回填是為了補舊資料，不是重寫全部
          if (k.metadata && typeof k.metadata.n === 'number') { skipped++; continue; }
          const cid = k.name.slice('bundle:'.length);
          const bundle = await readBundle(env, cid);
          if (!bundle) continue;
          await writeBundle(env, cid, bundle);     // writeBundle 會順手寫入 metadata
          done++;
        }

        return adminJson({
          ok: true,
          scanned: r.keys.length,
          filled: done,
          skipped,
          cursor: r.list_complete ? null : r.cursor,
          complete: !!r.list_complete,
        });
      }

      /**
       * 補齊 slug。
       *
       * ⚠️ **slug 無法從 contentId 反推**——我們只存數字，而 F1TV 不提供反查
       *    （`/detail/<id>` 只會回 404，而且有 Imperva 不能爬）。
       *
       * 但那份資料其實已經存在：**userscript 的收割佇列裡就是完整路徑**。
       * 所以讓它把 `done` 與 `queue` 的路徑送上來，後端逐一對上 cid。
       * 這比要求管理員手工填 30 筆務實得多。
       *
       * 只在「還沒有 slug」時寫入——先到先得，不覆蓋既有的。
       */
      if (path === '/v1/admin/bundles/slugs' && request.method === 'POST') {
        if (!authHarvest(env, request, path)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        const paths = Array.isArray(b && b.paths) ? b.paths.slice(0, 500) : [];
        if (!paths.length) return adminJson({ error: '沒有收到任何路徑' }, 400);

        let updated = 0, missing = 0, already = 0;
        for (const raw of paths) {
          const m = String(raw || '').match(/\/detail\/(\d+)(\/[A-Za-z0-9\-_]+)/);
          if (!m) continue;
          const cid = m[1];
          const slug = `/detail/${cid}${m[2]}`;
          const cur = await env.SUBS.get(bundleKey(cid));
          if (!cur) { missing++; continue; }        // 這支還沒有任何譯文
          let bundle;
          try { bundle = JSON.parse(cur); } catch (e) { continue; }
          // 收割佇列的路徑是可信的：用戶端給的後綴可以被它蓋掉（security-audit run-2 #9）
          if (bundle.slug && (bundle.slugBy !== 'client' || bundle.slug === slug)) { already++; continue; }
          bundle.slug = slug;
          bundle.slugBy = 'harvest';
          await writeBundle(env, cid, bundle);
          updated++;
        }
        return adminJson({ ok: true, updated, already, missing, received: paths.length });
      }

      // 營運設定的讀寫。只有帶 ADMIN_TOKEN 才改得動。
      if (path === '/v1/admin/ops' && request.method === 'GET') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const ops0 = await opsConfig(env);
        let raw = null;
        try { raw = JSON.parse((await env.SUBS.get(OPS_KEY)) || 'null'); } catch (e) { raw = null; }
        return adminJson({
          ok: true,
          current: raw || {},
          applied: await opsConfig(env),
          // 讓後台知道有哪些方案可以調，不必憑記憶打字。
          //
          // ⚠️ **一定要回「此刻實際會收的錢」（effective），不能只回牌價。**
          //    賽季方案的牌價是 599，但季中分段定價可能讓實收變成 299。
          //    後台只看得到牌價時，你會以為改了 599 就是改了售價——
          //    然後發現綠界收的是另一個數字。那正是這個專案已經踩過的坑。
          plans: Object.entries(PLANS)
            .filter(([, v]) => v.price > 0 && !v.internal)
            .map(([k, v]) => {
              const list = planPrice(k, ops0);
              const sp = v.untilSeasonEnd ? seasonPriceNow(list) : null;
              return {
                key: k, label: v.label,
                defaultPrice: v.price,
                effective: sp ? sp.price : list,
                tier: sp ? sp.tier : '',
                kind: /^svc_/.test(k) ? 'service' : 'sub',
              };
            }),
        });
      }
      if (path === '/v1/admin/ops' && request.method === 'POST') {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const b = await request.json().catch(() => null);
        if (!b || typeof b !== 'object') return adminJson({ error: 'body 不是合法 JSON' }, 400);
        await env.SUBS.put(OPS_KEY, JSON.stringify(b));
        opsCache = { at: 0, data: null };            // 立刻讓快取失效
        return adminJson({ ok: true, applied: await opsConfig(env) });
      }

      // 賽事資料。**與商品分開**——商品只綁 gpId，時間一律由這裡動態算。
      // ⚠️ 2026-10-02 查證：**目前沒有任何呼叫端**。購買頁讀 `/v1/plans`（裡面已帶 races）、
      //    後台讀 `/v1/admin/schedule`。保留它是因為它是公開唯讀、零成本，
      //    日後擴充功能要顯示賽程時可以直接用——但不要再以為購買頁靠它。
      if (path === '/v1/schedule' && request.method === 'GET') {
        const now = Date.now();
        return json({
          ok: true,
          season: SEASON_YEAR,
          // 資料是不是同步來的、什麼時候同步的——畫面上要標示「時間待官方確認」
          source: (await scheduleMeta(env)).source,
          syncedAt: (await scheduleMeta(env)).at,
          races: gpList().map((g) => gpProduct(g, now)),
        });
      }

      // 網站內容（公開唯讀）。首頁載入時讀一次，覆寫 HTML 裡的預設文字。
      if (path === '/v1/site' && request.method === 'GET') {
        return json(await readSiteContentPublic(env), 200, { 'cache-control': 'no-cache' });
      }

      if (path === '/v1/plans' && request.method === 'GET') {
        const ops = await opsConfig(env);
        const early = await earlyState(env);
        const left = early.left === null ? 0 : early.left;
        const season = seasonPriceNow(PLANS.season.price);
        // 比賽週通行證的價格（後台可改），要跟每一場商品一起給
        const gpPrice = planPrice('week', ops);
        const gpHidden = ops.hidden.includes('week');
        const plans = Object.entries(PLANS)
          .filter(([, v]) => v.price > 0)
          .map(([k, v]) => {
            // 賽季方案要顯示**當下實際會收的錢**，不是牌價。
            // 顯示 599 卻收 420（或反過來）都是糾紛。
            // 牌價要走 planPrice，後台改過的價格才會反映到畫面上。
            // 只改 quoteCart 不改這裡的話，會變成「顯示舊價、收新價」——
            // 那正是這一版要修掉的那個問題，只是換個地方發生。
            const list = planPrice(k, ops);
            const sp = v.untilSeasonEnd ? seasonPriceNow(list) : null;
            return {
              key: k, label: v.label,
              // 鎖住的方案照樣回給購買頁，只是不能結帳（見 planLock 的說明）
              locked: planLock(k, undefined, undefined, early),
              price: sp ? sp.price : list,
              listPrice: list,
              // 限時活動價（沒有活動＝null）。續訂價因人而異，不放在這份公開快取的回應裡
              promoPrice: (() => { const d = discountFor(k, sp ? sp.price : list, ops, false); return d.promo ? d.unit : null; })(),
              tier: sp ? sp.tier : null,
              limit: v.limit || null,
              // 早鳥：還能買幾組（扣掉結帳中保留的）與截止時間（換季前是 null＝還沒排定）
              remaining: v.earlyBird ? early.left : null,
              deadline: v.earlyBird ? early.deadline : null,
              // 結帳中（保留 30 分鐘）的份數分開給：剩餘數字已經扣掉它們，放棄結帳時會從 0 跳回 1，要讓人看得出原因（行銷對話 2026-11-03）
              holding: v.earlyBird ? (early.held || 0) : null,
              // 是不是下一賽季的票（購買頁判斷「本賽季的賽季票」用；早鳥換季前是、換季後不是）
              forNext: !!v.nextSeasonOnly,
              // 賣的是下一季時一定要標出來，購買頁才有辦法講清楚
              nextSeason: !!(sp && sp.nextSeason),
              // 重播月票的到期日要買之前就看得到（可能被下一季開幕截短）
              until: sp ? sp.until : (v.offSeasonOnly ? planExpiry(k) : null),
              offSeason: !!v.offSeasonOnly,
              // 下一賽季票什麼時候生效（本賽季最後一站結束後；之後買的是 null＝立即）
              startsAt: v.nextSeasonOnly ? planStart(k) : null,
              // 比賽週通行證涵蓋的是哪一場、到什麼時候
              // ⚠️ **買在正賽當天或之後的人要看得到自己買的是什麼。**
              //    賽程只有日期沒有時間，所以伺服器分不出「正賽剛開始」與
              //    「正賽已結束」——兩者都落在同一天。與其猜錯，不如**講清楚**：
              //    把涵蓋的站名、到期日、以及下一站是誰全部給購買頁，
              //    正賽當天再加一句提醒。使用者自己知道比賽跑完了沒有。
              // ⚠️ 舊的 gp 欄位已移除。真正的商品清單是 races（一個 GP 一張卡），
              //    留著第二份「代表場次」只會變成第二個事實來源。
              // 一場一份的商品 maxQty=1；一個月的代訂可買多份（上限見方案設定）
              maxQty: (v.weekBound || v.svcWeekend) ? 1 : (Number(v.maxQty) || 1),
              svcWeekend: !!v.svcWeekend,
              // 代訂的帳號模式（第一個是預設）。只有一種時購買頁不顯示選項
              acctModes: resellModesOf(k, env),
              vpn: !!v.vpn,
              // 共用帳號的限制要在卡片上跳出來，不能只寫在商品說明裡
              shared: !!v.shared,
              desc: v.desc || '',
              bundleWeeks: Number(v.bundleWeeks) || 0,
            };
          })
          // ⚠️ 早鳥價一旦不比當期 Season 價便宜就自動下架。
          //    2026 的分段價會掉到 259／129，那時還掛著「限量 20 組早鳥價 399」
          //    等於在賣一個比正常價還貴的東西——沒有人會來反映，只會不買。
          //    用「比較價格」而不是「比較日期」，才不必每年維護一個截止日。
          .filter((p) => !ops.hidden.includes(p.key))
          // 早鳥截止或售完就收掉（2026-11-03 Ray：「早鳥賣完再開599」「加截止日」）
          .filter((p) => !(p.key === 'season_early' && (early.over || early.soldOut || early.disabled)));

        // **一個 Grand Prix = 一個商品。** 價格共用 week 的牌價，
        // 但每一場是獨立的商品卡（狀態、效期、場次時間都不同）。
        // ⚠️ 已結束的場次**仍然回給購買頁**——使用者要看得到歷史，
        //    只是不可購買。整個消失會讓人以為賽程漏了一站。
        // 本賽季免費體驗（2026-11-03）：還沒結束的場次標 free，購買頁顯示「免費開放中」而不是加入購物車。
        //    purchasable 不動——代訂附贈的場次選單靠它（代訂照賣）；真正擋購買的是 planLock('week')
        const freeOn = freeSeasonActive();
        const races = gpList().map((g) => {
          const p = gpProduct(g, Date.now());
          return Object.assign(p, {
            planKey: 'week',
            price: gpPrice,
            promoPrice: (() => { const d = discountFor('week', gpPrice, ops, false); return d.promo ? d.unit : null; })(),
            purchasable: p.purchasable && !gpHidden,
            free: !!(freeOn && p.purchasable),
            hidden: gpHidden,
          });
        });
        return json({
          plans,
          races,
          earlyLeft: left,
          notice: ops.notice || '',
          // 本賽季免費體驗：網站的公告列與購買頁用（until＝本賽季最後一站正賽結束 3 小時後）
          freeSeason: freeOn ? { year: FREE_SEASON_YEAR, until: planExpiry('free_season') } : null,
          // 首頁公告列／主視覺標籤／價格區用。⚠️ 這份回應有 60 秒公開快取，
          //    活動結束後最多晚 60 秒消失——前端另外用 until 自己判斷，到點就收
          promo: (() => {
            const c = promoActive(ops);
            return c ? { id: c.id, name: c.name, text: c.text, pct: c.pct, keys: c.keys, from: c.from, until: c.until, theme: c.theme } : null;
          })(),
          // 續訂折扣暫停時回 null，購買頁與首頁就不顯示「老客戶 9 折」
          renewPct: RENEW_ENABLED ? RENEW_PCT : null,
          // Google 登入的用戶端 ID。**不是機密**（它本來就會出現在前端原始碼），
          // 放在這裡是為了讓它只需要設一次 wrangler var，
          // 不必為了換一個 ID 去改網站檔案再重算資產雜湊。
          // 沒設定時帳號頁會顯示「尚未開放」，而不是壞掉。
          googleClientId: env.GOOGLE_CLIENT_ID || '',
          // 機器人驗證的 site key（不是機密）。空字串＝未啟用，帳號頁就不顯示 widget。
          turnstileSiteKey: env.TURNSTILE_SECRET ? (env.TURNSTILE_SITE_KEY || '') : '',
          season: {
            weekendsLeft: season.weekendsLeft,
            tentative: racesLeftTentative(),
            nextSeason: season.nextSeason,
            tier: season.tier,
          },
        }, 200, { 'cache-control': 'public, max-age=60' });
      }

      // ---- 金流 ----
      // 結帳不需要用戶端權杖：使用者是在網頁上買，不是在擴充功能裡。
      if (path === '/v1/checkout' && request.method === 'POST') {
        if (await rateLimited(env, `co:${ip}`)) return err('操作太頻繁，請稍後再試', 429);
        // ⚠️ 每次結帳寫 2 筆 KV，以前只有取樣的每分鐘限流（security-audit run-2 #3：4 個 IP 一分鐘寫了 1,210 次）。
        //    每 IP 每小時 20 次、全站每天 300 次——真實的買家一天不會有幾十筆，300 次已經很寬。
        if (!(await kvWriteBudgetOk(env, 'checkout', ip))) return err('結帳次數太多，請稍後再試', 429, 'E32');
        if (!(await kvWriteBudgetOk(env, 'checkoutall', 'all'))) return err('今天的線上結帳已達上限，請來信 pitlingo.office@gmail.com 由我們協助', 429, 'E32');
        return handleCheckout(request, env, url);
      }
      // 金流回呼。**不需要用戶端權杖**（金流平台不會帶），改用簽章驗證。
      if (path === '/v1/payment/webhook' && request.method === 'POST') {
        return handlePaymentWebhook(request, env);
      }
      // ATM／超商取號通知。**這裡不發碼**——取號不等於付款。
      if (path === '/v1/payment/info' && request.method === 'POST') {
        return handlePaymentInfo(request, env);
      }
      /**
       * 綠界付款後的瀏覽器導回點。
       *
       * 綠界用 **POST** 導回，而付款結果頁是靜態的 Pages——靜態頁讀不到 POST body。
       * 所以由 Worker 接住，取出訂單編號與結果碼，再 302 轉到 `/paid`。
       *
       * ⚠️ **這裡不發碼、不改任何狀態。** 發碼只在 `/v1/payment/webhook`（伺服器對伺服器）。
       *    瀏覽器導回是使用者可以偽造的——把發碼掛在這裡等於開放任何人自行下單。
       */
      if (path === '/v1/payment/result' && request.method === 'POST') {
        let p = {};
        try {
          const form = await request.formData();
          for (const [k, v] of form) p[k] = String(v);
        } catch (e) { p = {}; }

        const no = String(p.MerchantTradeNo || '').slice(0, 32);
        const okPay = String(p.RtnCode) === '1';
        // ⚠️ ATM／超商代碼／條碼「取號成功」的 RtnCode 不是 1（ATM 是 2、超商與條碼是 10100073）。
        //    那不是失敗——錢還沒繳而已。以前一律當失敗：訂單被標成 failed、
        //    使用者被導到「付款失敗」頁，手上卻拿著一組繳費代碼。
        const gotCode = ['2', '10100073'].includes(String(p.RtnCode));

        // ⚠️ **這是使用者的瀏覽器送過來的，內容可以偽造。**
        //    所以要記進訂單之前必須先驗綠界的簽章；驗不過就只轉址、不改任何狀態。
        //    （驗過了也只允許往 failed 走，patchOrder 的 ORDER_RANK 擋住把
        //      已付款的訂單改回去——不然任何人都能把別人的訂單標成失敗。）
        if (no && !okPay && !gotCode) {
          try {
            const good = await ecpayMacOk(env, p, await readPending(env, no));
            if (good) {
              await patchOrder(env, no, {
                status: 'failed',
                failCode: String(p.RtnCode || ''),
                failMsg: String(p.RtnMsg || '').slice(0, 200),
              });
            }
          } catch (e) { /* 記不起來也要把人導回去，不能卡在這裡 */ }
        }
        const site = env.SITE_URL || 'https://pitlingo.com';
        // 失敗時把綠界的訊息一起帶過去，讓使用者知道為什麼被拒
        const msg = encodeURIComponent(String(p.RtnMsg || '').slice(0, 120));
        const to = (okPay || gotCode)
          ? `${site}/paid?no=${encodeURIComponent(no)}`
          : `${site}/paid?no=${encodeURIComponent(no)}&failed=1&msg=${msg}`;
        return new Response(null, { status: 302, headers: { Location: to } });
      }

      // ---- 帳號（Google 一鍵登入）----
      //
      // ⚠️ **這三支不可以用 ADMIN_TOKEN 保護，也不可以完全不保護。**
      //    它們是使用者自己呼叫的，憑據是登入後拿到的工作階段權杖。
      //    CORS 只開給我們自己的網域（SITE_PATHS）。

      if (path === '/v1/auth/google' && request.method === 'POST') {
        // 登入是會被暴力嘗試的端點——限流用 IP，因為此時還沒有身分可以綁。
        // ⚠️ 用 AuthGuard 的嚴格限額，不是取樣的 rateLimited（那個每 25 次才記一次）。
        if (!loginOriginOk(request)) return err('請求來源不符', 403, 'E57');
        if (await authLimited(env, 'google', ip)) return err('嘗試次數過多，請稍後再試', 429, 'E32');
        const b = await request.json().catch(() => null);
        let profile;
        try {
          profile = await verifyGoogleIdToken(env, b && b.credential);
        } catch (e) {
          // ⚠️ 驗證失敗的原因可以照實說（那是使用者自己的 token），
          //    但**不可以回傳 token 的任何內容**——那會變成一個解碼服務。
          return err('登入失敗：' + String((e && e.message) || e), 401, 'E60');
        }
        const { acc, created } = await googleLogin(env, profile);
        return loginResponse(env, acc, created, { picture: profile.picture }, request);
      }

      // Email 驗證碼：要一組碼
      if (path === '/v1/auth/email/start' && request.method === 'POST') {
        // ⚠️ 三層限額都在 AuthGuard 裡（每信箱、每 IP、全站），原子而且跨機房一致。
        if (!loginOriginOk(request)) return err('請求來源不符', 403, 'E57');
        const b = await request.json().catch(() => null);
        if (!(await turnstileOk(env, b && b.turnstile, ip, 'login'))) return err('機器人驗證未通過，請重新整理再試', 403, 'E56');
        const r = await otpStart(env, b && b.email, ip);
        if (!r.ok) return err(r.error, r.code === 'E64' ? 400 : r.code === 'E65' ? 503 : 429, r.code);
        return json({ ok: true, ttlSec: r.ttlSec });
      }

      // Email 驗證碼：驗證並登入
      if (path === '/v1/auth/email/verify' && request.method === 'POST') {
        if (!loginOriginOk(request)) return err('請求來源不符', 403, 'E57');
        const b = await request.json().catch(() => null);
        const v = await otpVerify(env, b && b.email, b && b.code, ip);
        if (!v.ok) return err(v.error, v.code === 'E66' ? 429 : v.code === 'E65' ? 503 : 401, v.code);
        const { acc, created } = await emailLogin(env, v.email);
        return loginResponse(env, acc, created, undefined, request);
      }

      // 登出。`all: true` ＝ 登出所有裝置（含擴充功能）。
      if (path === '/v1/auth/logout' && request.method === 'POST') {
        const sess = await sessionOf(env, request, true);
        const clear = { 'set-cookie': sessionCookie('', 0) };
        // 沒登入（或已經無效）也回成功並清 cookie：登出是冪等的，不需要告訴對方任何事。
        if (!sess) return json({ ok: true }, 200, clear);
        if (!csrfOk(request, sess)) return err('請求來源不符', 403, 'E57');
        const b = await request.json().catch(() => null);
        await authCall(env, { op: 'revoke', sid: sess.sid, exp: sess.exp });
        // 擴充功能的權杖：連同續期換出來的整個家族一起撤銷（security-audit run-2 #14）
        if (sess.fam) await authCall(env, { op: 'revoke', sid: 'F' + sess.fam, exp: sess.root + SESSION_X_MAX_DAYS * 86400 });
        let stopped = 0;
        if (b && b.all) {
          const acc = await readGoogleAccount(env, sess.sub);
          // ⚠️ 合併過的帳號：舊的 email 帳號 sub 簽出去的權杖還透過別名有效（最多 30 天）。
          //    只撤銷目前這個 sub 的話，那些權杖不受「登出所有裝置」影響（2026-10-04 修）。
          const subs = [...new Set([sess.sub, acc && acc.sub, ...((acc && acc.aliases) || [])].filter(Boolean))];
          for (const sub of subs) await authCall(env, { op: 'revokeAll', ah: await authSubHash(env, sub) });
          // 授權綁帳號之後，「登出所有裝置」也要讓**授權**在那些裝置上立刻停下來——
          // 覺得帳號被別人用了才會按這顆，只登出不停授權，對方手上的通行證還能用到 14 天。
          if (acc) stopped = await stopAccountDevices(env, acc);
        }
        return json({ ok: true, all: !!(b && b.all), devicesStopped: stopped }, 200, clear);
      }

      // ---- 擴充功能配對 ----
      //
      // ⚠️ **不在擴充功能裡跑 OAuth**（MV3 的 chrome.identity 會綁死 Chrome
      //    帳號，Edge 行為不一致）。改成：擴充功能產生一組一次性的配對碼、
      //    開分頁讓使用者在網站上登入，網站把權杖交到那組碼底下，
      //    擴充功能再取回來。使用者只按一次，不用複製貼上。

      // ⚠️ **配對要綁住發起的那個擴充功能，而且要使用者親手輸入確認碼**
      //    （security-audit 2026-10-05 #1，本機重現過）。以前任何人都能自選一組配對碼，
      //    把 `pitlingo.com/account?link=<碼>` 丟給已登入的受害者——網站自動完成配對，
      //    攻擊者再用同一組碼取回受害者 30 天有效的擴充功能權杖（看得到授權碼、能換發、能用授權），
      //    而且不帶安裝權杖取回就不會觸發新裝置通知。現在：
      //      1. 擴充功能先登記（/v1/auth/link/start，要安裝權杖）→ 拿到 4 碼確認碼、顯示在彈出視窗
      //      2. 網站不自動配對：使用者要輸入**自己擴充功能上**的確認碼（每組配對碼最多猜 5 次）
      //      3. 只有登記的那個安裝取得回權杖；新裝置通知在配對成立當下一定寄出
      //    確認碼擋不住「攻擊者連碼一起騙你輸入」，所以網站上有明確的警告。
      if (path === '/v1/auth/link/start' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok || a.legacy) return err('unauthorized', 401);
        if (await authLimited(env, 'linkstart', a.installId)) return err('配對次數過多，請稍後再試', 429, 'E32');
        const b = await request.json().catch(() => null);
        const nonce = String((b && b.nonce) || '');
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(nonce)) return err('配對碼格式不正確', 400, 'E68');
        const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        const code = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((x) => AB[x % AB.length]).join('');
        await env.SUBS.put(`linkreq:${nonce}`, JSON.stringify({ iid: a.installId, code, at: nowSec() }), { expirationTtl: 300 });
        return json({ ok: true, code, ttlSec: 300 });
      }

      // 網站端：使用者輸入確認碼後，把工作階段交給這組配對碼
      if (path === '/v1/auth/link/claim' && request.method === 'POST') {
        const sess = await sessionOf(env, request, true);
        if (!sess) return err('請先登入', 401, 'E61');
        if (!csrfOk(request, sess)) return err('請求來源不符', 403, 'E57');
        if (await authLimited(env, 'linkclaim', sess.sub)) return err('配對次數過多，請稍後再試', 429, 'E32');
        const b = await request.json().catch(() => null);
        const nonce = String((b && b.nonce) || '');
        // ⚠️ 長度與字元集要驗。配對碼是 KV 的鍵名，讓使用者塞任意字串進去
        //    等於開放他寫入任意鍵。
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(nonce)) return err('配對碼格式不正確', 400, 'E68');
        let req = null;
        try { req = JSON.parse((await env.SUBS.get(`linkreq:${nonce}`)) || 'null'); } catch (e) { req = null; }
        if (!req || !req.iid) return err('這個連結已失效。請回到擴充功能，重新按一次「登入」', 400, 'E68');
        // 每組配對碼最多猜 5 次（4 碼、31 個字元，猜中機率約百萬分之五）
        if (await authLimited(env, 'linkcode', nonce)) return err('確認碼錯太多次。請回到擴充功能重新按一次「登入」', 429, 'E68');
        const code = String((b && b.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!code || !safeEqual(code, String(req.code || ''))) {
          return err('確認碼不對。請輸入你自己的擴充功能視窗上顯示的 4 碼', 400, 'E68');
        }
        // 擴充功能拿到的是**另一枚**權杖（種類 x、30 天），可以單獨撤銷，
        // 網站登出不會連帶把擴充功能登出（除非按「登出所有裝置」）。
        const s = await issueSession(env, sess.sub, 'x');
        await env.SUBS.delete(`linkreq:${nonce}`);
        // ⚠️ TTL 只有 5 分鐘，而且**取走就刪**；只有登記的那個安裝取得回去（見 GET /v1/auth/link）
        await env.SUBS.put(`link:${nonce}`, JSON.stringify({ token: s.token, exp: s.exp, iid: req.iid }),
          { expirationTtl: 300 });
        // 新裝置通知在配對成立的這一刻寄（以前在取回時、而且要帶安裝權杖才寄——攻擊者不帶就不寄）
        try {
          const acc = await readGoogleAccount(env, sess.sub);
          if (acc) await noteLoginDevice(env, request, acc, 'ext', req.iid, false);
        } catch (e) { /* 通知失敗不擋配對 */ }
        return json({ ok: true });
      }

      // 擴充功能端：取回權杖（單次）
      if (path === '/v1/auth/link' && request.method === 'GET') {
        if (await rateLimited(env, `link:${ip}`)) return err('rate limited', 429, 'E32');
        const nonce = String(url.searchParams.get('nonce') || '');
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(nonce)) return err('配對碼格式不正確', 400, 'E68');
        let rec = null;
        try { rec = JSON.parse((await env.SUBS.get(`link:${nonce}`)) || 'null'); } catch (e) { rec = null; }
        if (!rec) return json({ ok: true, pending: true });   // 還沒登入完，繼續等
        // ⚠️ 只有登記這組配對碼的那個擴充功能取得回去。別人拿到配對碼（網址列、瀏覽紀錄、
        //    被分享出去的連結）也只會一直看到 pending。
        const a = request.headers.get('x-client-token') ? await authClient(env, request) : null;
        if (!a || !a.ok || a.legacy || (rec.iid && a.installId !== rec.iid)) return json({ ok: true, pending: true });
        await env.SUBS.delete(`link:${nonce}`);               // **單次有效**
        return json({ ok: true, token: rec.token, exp: rec.exp });
      }

      if (path === '/v1/account/me' && request.method === 'GET') {
        const sess = await sessionOf(env, request, true);
        if (!sess) return err('請先登入', 401, 'E61');
        const acc = await readGoogleAccount(env, sess.sub);
        if (!acc) return err('查無此帳號', 404, 'E62');

        // 一個帳號可能綁了好幾個 email（用公司信箱買、用私人 Google 登入）。
        // ⚠️ 上限 10 個是防呆：認領是使用者自己觸發的，沒有上限的話
        //    這一頁的成本會隨著認領次數線性成長。
        const views = [];
        for (const em of (acc.emails || []).slice(0, 10)) {
          views.push(await accountView(env, em));
        }
        const licenses = views.flatMap((v) => v.licenses);
        const purchases = views.flatMap((v) => v.purchases)
          .sort((a, b) => (b.at || 0) - (a.at || 0));
        const paid = purchases.filter((p) => p.status === 'paid');
        // F1TV 代訂（D1）。讀不到不可以讓整個帳號頁壞掉——授權與訂單比它重要
        let f1 = [];
        try { f1 = await customerF1(env, acc.emails || []); } catch (e) { f1 = []; }
        return json({
          ok: true,
          profile: { email: acc.email, name: acc.name },
          emails: acc.emails || [],
          licenses,
          purchases,
          f1,
          // 老客戶續訂折扣的資格（買過賽季通行證、付了錢的）。購買頁與首頁價格區用
          renew: licenses.some((l) => RENEW_FROM_PLANS.has(l.plan) && (l.paid || 0) > 0 && l.state !== 'revoked'),
          summary: {
            licenses: licenses.length,
            active: licenses.filter((l) => l.state === 'active').length,
            orders: purchases.length,
            paidOrders: paid.length,
            lifetimeTwd: paid.reduce((n, p) => n + (p.price || 0), 0),
          },
        }, 200, { 'cache-control': 'no-store' });   // 含代訂的 F1TV 登入信箱（RESELL-OPS 3.2 第 6 條）
      }

      if (path === '/v1/account/claim' && request.method === 'POST') {
        const sess = await sessionOf(env, request, true);
        if (!sess) return err('請先登入', 401, 'E61');
        if (!csrfOk(request, sess)) return err('請求來源不符', 403, 'E57');
        // 認領會寄信到別人輸入的信箱——嚴格限額，而且綁在帳號上不是 IP。
        if (await authLimited(env, 'claim', sess.sub)) return err('認領次數過多，請稍後再試', 429, 'E32');
        const b = await request.json().catch(() => null);
        const r = await claimByEmail(env, sess.sub, b && b.email, ip);
        if (!r.ok) return err(r.error, r.code === 'E66' ? 429 : r.code === 'E65' ? 503 : 400, r.code || 'E63');
        return json(r);
      }

      // 認領第二步：輸入寄到購買信箱的驗證碼
      if (path === '/v1/account/claim/verify' && request.method === 'POST') {
        const sess = await sessionOf(env, request, true);
        if (!sess) return err('請先登入', 401, 'E61');
        if (!csrfOk(request, sess)) return err('請求來源不符', 403, 'E57');
        const b = await request.json().catch(() => null);
        const r = await claimVerify(env, sess.sub, b && b.email, b && b.code, ip);
        if (!r.ok) return err(r.error, r.code === 'E66' ? 429 : r.code === 'E65' ? 503 : 400, r.code || 'E63');
        return json(r);
      }

      // 我的帳號：顯示代訂的 F1TV 密碼（RESELL-OPS 3.2：登入後才解密、每次記一筆、no-store）
      if (path === '/v1/account/f1/reveal' && request.method === 'POST') {
        const sess = await sessionOf(env, request, true);
        if (!sess) return err('請先登入', 401, 'E61');
        if (!csrfOk(request, sess)) return err('請求來源不符', 403, 'E57');
        if (await authLimited(env, 'f1reveal', sess.sub)) return err('操作太頻繁，請稍後再試', 429, 'E32');
        const acc = await readGoogleAccount(env, sess.sub);
        if (!acc) return err('查無此帳號', 404, 'E62');
        const b = await request.json().catch(() => null);
        const r = await customerF1Reveal(env, acc.emails || [], b && b.id, request.headers.get('user-agent'));
        return json(r.body, r.status, { 'cache-control': 'no-store' });
      }

      // 我的帳號：解除裝置、換發授權碼（都要是自己帳號裡的碼，見 ownedLicense）
      if (path === '/v1/account/license/gift' && request.method === 'POST') {
        const sess = await sessionOf(env, request, true);
        if (!sess) return err('請先登入', 401, 'E61');
        if (!csrfOk(request, sess)) return err('請求來源不符', 403, 'E57');
        return handleAccountGift(env, sess, await request.json().catch(() => null));
      }

      // 自助換發（/v1/account/license/reissue）2026-10-30 拿掉：授權以帳號為準之後，授權碼外流別人也用不了，
      // 換發擋不到任何東西，反而讓擁有者的擴充功能停在舊碼上。後台換發（客服用）保留。
      if (path === '/v1/account/license/deactivate' && request.method === 'POST') {
        const sess = await sessionOf(env, request, true);
        if (!sess) return err('請先登入', 401, 'E61');
        if (!csrfOk(request, sess)) return err('請求來源不符', 403, 'E57');
        const b = await request.json().catch(() => null);
        return handleAccountDeviceRemove(env, sess, b);
      }

      if (path === '/v1/order' && request.method === 'GET') {
        return handleOrderStatus(env, url);
      }

      // 產品數據。彙總計數，不含任何可識別個人的資訊。
      if (path === '/v1/metric' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        return handleMetric(request, env, a);
      }

      // 網站的客服工單。
      //
      // ⚠️ 與 `/v1/report` 刻意分開：那條需要安裝權杖（避免被當成匿名投遞箱），
      //    但網站訪客**沒有**安裝權杖——買家可能根本還沒裝擴充功能。
      //    這裡改用 IP 速率限制當防濫用，並寫進同一份 `report:` 儲存，
      //    後台就不必再做第二套介面（工單編號、已解決標記、列表全部共用）。
      if (path === '/v1/contact' && request.method === 'POST') {
        if (await rateLimited(env, `web:${ip}`)) return err('送出太頻繁，請稍後再試', 429);
        if (!(await kvWriteBudgetOk(env, 'contact', ip))) return err('送出太頻繁，請一小時後再試，或直接來信 pitlingo.office@gmail.com', 429);
        if (!(await kvWriteBudgetOk(env, 'contactall', 'all'))) return err('今天的線上表單已達上限，請直接來信 pitlingo.office@gmail.com', 429);
        return handleContactSubmit(request, env);
      }

      /* @test-only:start */
      // 語音辨識字幕（只在測試後端；沒有 ASR_TEST_KEY 或金鑰不對一律 404）
      if (path === '/v1/asr/test' && request.method === 'POST') {
        if (await rateLimited(env, `asr:${ip}`)) return err('rate limited', 429);
        return handleAsrTest(request, env);
      }
      if (path === '/v1/asr/test/translate' && request.method === 'POST') {
        if (await rateLimited(env, `asr:${ip}`)) return err('rate limited', 429);
        return handleAsrTranslate(request, env);
      }
      /* @test-only:end */

      // 診斷回報。需要安裝權杖，避免被當成匿名投遞箱。
      if (path === '/v1/report' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        if (await rateLimited(env, `rep:${a.installId}`)) return err('回報太頻繁，請稍後再試', 429);
        if (!(await kvWriteBudgetOk(env, 'report', a.installId))
          || !(await kvWriteBudgetOk(env, 'reportall', 'all'))) return err('回報太頻繁，請稍後再試', 429);
        return handleReportSubmit(request, env, a);
      }

      // /v1/license/devices（只憑授權碼列出裝置）2026-10-30 拿掉：裝置管理只在登入後的「我的帳號」。
      if (path === '/v1/license/renew' && request.method === 'POST') {
        const a = await authClient(env, request);
        if (!a.ok) return err('unauthorized: ' + a.reason, 401);
        return handleLicenseRenew(request, env, a);
      }
      // 擴充功能「登出／在這台停用」時把**自己這一台**從名單拿掉（要帶這台的安裝權杖）。
      // 解除**別台**（電腦壞了、賣掉了）只在登入後的「我的帳號」——2026-10-30 起不再接受「只憑授權碼解除別台」。
      if (path === '/v1/license/deactivate' && request.method === 'POST') {
        if (await rateLimited(env, `lic:${ip}`)) return err('rate limited', 429);
        // 安裝權杖是選用的：有帶、而且要解除的正是自己這一台時不計次數（見 AUTH_LIMITS.deact）
        const caller = request.headers.get('x-client-token') ? await authClient(env, request) : null;
        return handleLicenseDeactivate(request, env, caller);
      }

      // ---- 管理後台 ----
      // 權限在這裡驗一次，回應一律補 CORS —— 後台是本機開的 file:// 網頁，
      // Origin 是 null，沒有 CORS 連問都問不到（第一版把自己的後台擋掉了）。
      if (isAdmin) {
        if (!authAdmin(env, request)) return adminJson({ error: 'unauthorized' }, 401);
        const res = await routeAdmin(path, request, env, url);
        if (!res) return adminJson({ error: 'not found' }, 404);
        // no-store：代訂的密碼揭露、客戶資料都走這裡，任何一層都不可以快取（RESELL-OPS 3.2 第 6 條）
        return new Response(await res.text(), { status: res.status || 200, headers: Object.assign({ 'cache-control': 'no-store' }, ADMIN_CORS) });
      }

      return err('not found', 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
}
