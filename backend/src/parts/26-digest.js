// ---------------------------------------------------------------------------
// 每日彙報
//
// 為什麼需要：**所有壞消息目前都要你自己去後台翻。** 成本、共用快取命中率、
// 本週還缺哪些場次沒收割、有沒有新的工單——這些沒有一項會主動找上你，
// 而它們壞掉的時候都不報錯（這個專案的 bug 幾乎都是這樣）。
//
// ⚠️ **一律每天寄，就算完全正常也寄。** 只在有事時才寄的設計，會讓
//    「系統壞了所以沒寄」與「一切正常所以沒寄」長得一模一樣——
//    而前者正是最需要你知道的情況。每天一封，沒收到本身就是訊號。
//
// ⚠️ 寄不出去不可以讓排程整個失敗。結果一律寫進 KV（digest:last），
//    後台看得到最後一次彙報的內容與寄送結果。
// ---------------------------------------------------------------------------

/** 幾天內開賽就算「即將到來」，覆蓋率不足要示警。 */
const DIGEST_SOON_DAYS = 7;

/** HTML 逸出。彙報裡有 cid 與工單編號，雖然都是我們自己產的，仍然不直接拼。 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 比賽週末的 UTC 日期集合（YYYY-MM-DD）：週四暖身（開始日前一天）到正賽隔天。
 * ⚠️ 正賽隔天也算：美洲站的正賽在 UTC 常常已經是隔天（拉斯維加斯是週六晚上＝UTC 週日）。
 */
function raceWeekendDates(cfg) {
  const out = new Set();
  for (const g of gpList(cfg)) {
    const a = dayStartSec(g.start), b = dayStartSec(g.end);
    if (a === null || b === null) continue;
    for (let t = a - 86400; t <= b + 86400; t += 86400) {
      out.add(new Date(t * 1000).toISOString().slice(0, 10));
    }
  }
  return out;
}

async function buildDigest(env, cfg) {
  const c = cfg || REMOTE_CONFIG;
  const now = nowSec();
  const alerts = [];
  const sec = [];

  // 1) 成本
  const st = await statsSummary(env, 7).catch(() => null);
  const cap = Number(env.DAILY_USD_CAP || DAILY_USD_CAP_DEFAULT);
  if (st) {
    const today = st.budget.todayUsd;
    const hit = st.total.sharedHitRate;
    const pc = st.total.promptCacheHitRate;
    sec.push({
      t: '成本',
      rows: [
        `今日 $${today.toFixed(4)} / 上限 $${cap}`,
        `近 7 天 $${st.total.usd.toFixed(4)}，翻譯 ${st.total.translated} 句`,
        `共用快取命中率 ${hit === null ? '—' : (hit * 100).toFixed(1) + '%'}`,
        `prompt 快取命中率 ${pc === null ? '—' : (pc * 100).toFixed(1) + '%'}`,
        // ⚠️ KV 寫入是這個專案撞過的那面牆（坑 #19）。這個數字是**下限**。
        `KV 寫入 今日 ${st.kv.todayPuts == null ? '—' : st.kv.todayPuts}`
          + ` / ${st.kv.paid ? '每日平均含量' : '免費方案上限'} ${st.kv.freeDailyCap}（下限值，實際更高）`,
      ],
    });
    // 免費方案撞牆的症狀是「寫入直接失敗」——那會讓譯文存不進共用快取，
    // 而使用者端看起來完全正常（他自己拿得到譯文），只是下一個人要重付一次。
    if (st.kv.todayPuts != null && st.kv.todayPuts >= st.kv.freeDailyCap * 0.7) {
      alerts.push(st.kv.paid
        ? `今日 KV 寫入已達 ${st.kv.todayPuts} 次（每日平均含量 ${st.kv.freeDailyCap}）——超過含量每百萬次 $5`
        : `今日 KV 寫入已達 ${st.kv.todayPuts} 次（免費方案上限 ${st.kv.freeDailyCap}）`
        + `——若在免費方案上，撞牆時譯文會存不進共用快取而且不會報錯`);
    }
    if (cap > 0 && today >= cap * 0.8) {
      alerts.push(`今日成本 $${today.toFixed(2)} 已達上限的 ${Math.round((today / cap) * 100)}%`);
    }
    // ⚠️ prompt 快取掉下來就是坑 #21 復發：SYSTEM_PROMPT 低於 4,096 tokens 時
    //    cache_control 會**靜默失效**，不報錯，只是每一次都全額計費。
    if (pc !== null && pc < 0.8) {
      alerts.push(`prompt 快取命中率只有 ${(pc * 100).toFixed(1)}%，可能是 SYSTEM_PROMPT 掉到 4,096 tokens 以下`);
    }
    // ⚠️ 坑 #74（2026-10-02）：這條原本拿**全部流量**算。比賽週末幾乎都是直播，
    //    而直播本來就不可能賽前收割——於是只要那一週有比賽，這條就一定響，
    //    而且「賽前沒有收割」這個建議根本做不到（坑 #63：不可能處理的警告）。
    //    改成只看**比賽週末以外**的日子（週四暖身前一天到正賽隔天，UTC 日期）。
    //    那才是重播流量，命中率低才代表「收割漏了」。
    const raceDays = raceWeekendDates(c);
    let rpT = 0, rpC = 0;
    for (const d of st.daily || []) {
      if (raceDays.has(d.date)) continue;
      rpT += d.translated || 0; rpC += d.cached || 0;
    }
    const rpHit = (rpT + rpC) ? rpC / (rpT + rpC) : null;
    sec[sec.length - 1].rows.splice(3, 0,
      `　其中非比賽週末（重播）${rpHit === null ? '—' : (rpHit * 100).toFixed(1) + '%'}`
      + `（${rpT + rpC} 句；比賽週末的直播不可能賽前收割，不列入判斷）`);
    if (rpT > 500 && (rpHit || 0) < 0.3) {
      alerts.push(`非比賽週末的共用快取命中率只有 ${((rpHit || 0) * 100).toFixed(1)}%——重播幾乎每一句都在付全額，代表收割漏了`);
    }
  }

  // 2) 收割覆蓋率。只報「進行中」與「即將到來」的那幾站——
  //    已結束的站再缺也補不回那次直播的錢，列出來只會讓重點被淹沒。
  const cov = await harvestCoverage(env, c).catch(() => null);
  if (cov) {
    // ⚠️ **`replay` 一定要留在這份清單裡。** 正賽剛跑完的那一站雖然不再販售，
    //    但它的場次才剛全部播完，**現在是唯一還補得起來的時間點**
    //    （HARVEST_LAG_SEC 之後才收得到完整的 VTT）。
    //    把它當成「已結束」濾掉，等於每一站都在最該收割的那幾小時從報告上消失。
    const STILL_ACTIONABLE = new Set(['live', 'replay']);
    const soon = cov.races.filter((r) => {
      if (STILL_ACTIONABLE.has(r.status)) return true;
      if (r.status !== 'upcoming' && r.status !== 'open') return false;
      const s = dayStartSec(r.start);
      return s && s - now < DIGEST_SOON_DAYS * 86400;
    });
    const stLabel = (s) => (s === 'live' ? '進行中' : s === 'replay' ? '正賽已結束' : '即將開始');
    const rows = soon.length ? soon.map((r) => {
      const miss = r.sessions.filter((x) => !x.lines).map((x) => x.label);
      return `R${r.round} ${r.name}（${r.start}，${stLabel(r.status)}）`
        + `　已收割 ${r.have}/${r.need}`
        + (miss.length ? `　缺：${miss.join('、')}` : '　全部到齊')
        + (r.have > r.complete ? `　⚠️ 其中 ${r.have - r.complete} 支未標記完整` : '');
    }) : ['近期沒有比賽週'];
    // ⚠️ 已結束但沒收完整的場次（坑 #74 同一次）。**列一行、不進警報**：
    //    它們在收割計畫裡會被排進去（harvestPlan 本來就會），但有些可能永遠標不了完整
    //    （例如被守門擋掉的句子超過 2%）——放進警報就會變成天天響、處理不掉的那種。
    //    原本這裡完全不提，R15 亞塞拜然 5 場直播時累積了 1.3 萬句卻 0 場完整，
    //    只有打開後台「翻譯清單」才看得到。
    const doneIncomplete = [];
    for (const r of cov.races.filter((x) => x.status === 'finished')) {
      for (const x of r.sessions) {
        if (!(x.lines && x.complete && !x.suspect)) doneIncomplete.push(`R${r.round} ${r.name} ${x.label}`);
      }
    }
    rows.push(doneIncomplete.length
      ? `已結束但沒有完整收割：${doneIncomplete.length} 場（${doneIncomplete.slice(0, 8).join('、')}`
        + `${doneIncomplete.length > 8 ? '…' : ''}）——收割計畫會排進去`
      : '已結束的場次全部完整');
    sec.push({ t: '收割覆蓋率', rows });
    // ⚠️ **只對「已經播完、收得到」的場次發警告**（2026-09-18）。
    //    以前是 `have < need` 就警告，於是下週才開賽的站每天都掛在「需要注意」裡——
    //    還沒播的場次根本沒有字幕可以收，那是一個**不可能處理的警告**，
    //    而不可能處理的警告會訓練人忽略整份彙報。
    const gps = gpList(c);
    for (const r of soon) {
      const g = gps.find((x) => gpId(x) === r.id);
      const aired = new Set(((g && g.sessions) || [])
        .filter((x) => x.t + (SESSION_LEN_SEC[x.k] || 3600) + HARVEST_LAG_SEC <= now)
        .map((x) => x.k));
      // ⚠️ 坑 #74：以前只看 `!x.lines`（一句都沒有）。**直播看過的場次會累積部分資料**，
      //    於是被當成「已收割」——R15 亞塞拜然 5 場全是這樣，賽後的 VOD 一場都沒收，
      //    而這條警報一次都沒響。直播時拿到的句子不等於完整收割，要看 complete。
      const miss = r.sessions.filter((x) => aired.has(x.kind) && !(x.lines && x.complete && !x.suspect)).length;
      if (miss) {
        alerts.push(`R${r.round} ${r.name} 有 ${miss} 個已播完的場次還沒收完整（直播時累積的不算；`
          + (r.status === 'live' ? '週末進行中'
            : r.status === 'replay' ? '正賽已結束，**現在是最後機會**'
              : r.start + ' 開始') + '）');
      }
    }
  }

  // 3) 資料健康：沒有 slug 的、標了完整但句數與分段不成比例的
  const meta = await listBundleMeta(env).catch(() => []);
  const nometaAll = meta.filter((x) => !x.slug);
  const nometa = nometaAll.length;
  // ⚠️ 坑 #74（K3）：只對**處理得了**的發警報。
  //    · 非數字 cid（`misc`）是坑 #53 以前留下的死資料：後端只對數字 cid 讀寫共用快取，
  //      它永遠不會被讀到，也補不了 slug。
  //    · 很久以前寫進來的那幾支，後台「待補資料」一直看得到；天天寄同一條會訓練人忽略彙報。
  //    新出現的（14 天內有更新）才代表某條路徑又在丟 slug——那才值得叫人。
  const nometaNew = nometaAll.filter((x) => /^\d+$/.test(String(x.cid))
    && x.at && Date.parse(x.at) > Date.now() - 14 * 86400000).length;
  // ⚠️ 以前這裡用絕對門檻（0.5 句／段），抓到的永遠是那 3 支舊賽季重播與保時捷盃——
  //    它們本來就安靜，而且不算覆蓋率。真正缺句的本季正式場次（0.70、1.30…）反而全部放過。
  //    改成與同類場次比（suspectMarked），只看本季正式場次。
  const suspect = (cov && cov.suspect) || [];
  sec.push({
    t: '資料健康',
    rows: [
      `影片 ${meta.length} 支，句子 ${meta.reduce((a, x) => a + x.lines, 0)} 句`,
      `沒有網址後綴（無法分類）：${nometa} 支`,
      `標記完整但很可能缺句（與同類場次相比）：${suspect.length} 支`
        + (suspect.length ? `（${suspect.slice(0, 6).join('、')}）` : ''),
    ],
  });
  if (suspect.length) {
    alerts.push(`有 ${suspect.length} 支影片標記完整但句數明顯少於同類場次——到後台「翻譯清單」按「重新驗證可疑的」`);
  }
  if (nometaNew) alerts.push(`最近 14 天有 ${nometaNew} 支影片寫進來時沒有網址後綴，後台分不了類（某條路徑又在丟 slug）`);

  // 4) 工單
  let openTickets = 0;
  try {
    const r = await env.SUBS.list({ prefix: 'report:', limit: 1000 });
    for (const k of r.keys) {
      // ⚠️ 2026-10-02 以前寫入的工單沒有 metadata（坑 #73）。那些要讀值才知道結案了沒——
      //    只看 metadata 的話，它們在 90 天 TTL 到期前會一直被算成未處理。
      if (k.metadata && typeof k.metadata.resolved === 'boolean') {
        if (!k.metadata.resolved) openTickets++;
        continue;
      }
      let rec = null;
      try { rec = JSON.parse((await env.SUBS.get(k.name)) || 'null'); } catch (e) { rec = null; }
      if (rec && !rec.resolved) openTickets++;
    }
  } catch (e) { /* 讀不到就不報，不能讓彙報整個失敗 */ }
  sec.push({ t: '問題回報', rows: [`未處理工單 ${openTickets} 張`] });
  if (openTickets) alerts.push(`有 ${openTickets} 張工單還沒處理`);

  // 4.5) 換季（K10，2026-10-06）。整季最後一站跑完一週還是舊賽季，就每天提醒。
  //      ⚠️ 年份漏改不報錯：新賽季的每一場都會「不在免費範圍」，免費試用整個消失。
  try {
    const list = gpList(cfg);
    const lastEnd = list.length ? Math.max(...list.map((g) => dayStartSec(g.end) + 86400)) : 0;
    if (lastEnd && nowSec() > lastEnd + 7 * 86400) {
      alerts.push(`${cfg.seasonYear || SEASON_YEAR} 賽季已結束 ${Math.floor((nowSec() - lastEnd) / 86400)} 天，還沒換季——`
        + `依 handoff 9.1「換季作業」：填 ${(cfg.seasonYear || SEASON_YEAR) + 1} 場次時間（tools/gen-schedule.js）、node tools/season-rollover.js ${(cfg.seasonYear || SEASON_YEAR) + 1} --write、部署`);
    }
  } catch (e) { /* 彙報不能因為這一段失敗 */ }

  // 5) 賽程同步
  let schedNote = 'SCHEDULE_URL 未設定（使用內建賽程）';
  if (env.SCHEDULE_URL) {
    try {
      const last = JSON.parse((await env.SUBS.get('sched:lastrun')) || 'null');
      const r = last && last.result;
      schedNote = r && r.ok
        ? `最後一次同步 ${new Date((last.at || 0) * 1000).toISOString().slice(0, 16)}，${r.changed === false ? '內容未變' : '更新 ' + r.races + ' 站'}`
        : `⚠️ 最後一次同步失敗：${(r && r.reason) || '沒有紀錄'}`;
      if (!(r && r.ok)) alerts.push('賽程同步失敗，目前用的是舊資料');
    } catch (e) { schedNote = '讀不到同步紀錄'; }
  }
  sec.push({ t: '賽程', rows: [schedNote] });

  const date = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  const subject = alerts.length
    ? `PitLingo 每日彙報 ${date}　⚠️ ${alerts.length} 項需要注意`
    : `PitLingo 每日彙報 ${date}　一切正常`;

  const site = env.SITE_URL || 'https://pitlingo.com';
  const html = mailShell(esc(subject), [
    alerts.length
      ? `<ul style="background:#2a1215;border-left:4px solid ${MAIL_C.red};border-radius:6px;color:${MAIL_C.text};padding:12px 12px 12px 28px;margin:0 0 16px">`
        + alerts.map((a) => `<li>${esc(a)}</li>`).join('') + '</ul>'
      : '',
    sec.map((s) => mailH2(esc(s.t))
      + `<ul style="margin:0;padding-left:20px">${s.rows.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`).join(''),
    mailButton(`${esc(site)}${ADMIN_PAGE_PATH}`, '打開後台'),
  ].join(''), { site, why: '您是 PitLingo 的管理員' });

  const text = [subject, '']
    .concat(alerts.length ? ['[需要注意]'].concat(alerts.map((a) => '  - ' + a), ['']) : [])
    .concat(sec.reduce((acc, s) => acc.concat(['【' + s.t + '】'], s.rows.map((r) => '  ' + r), ['']), []))
    .join('\n');

  return { subject, alerts, sections: sec, html, text, at: now };
}

async function sendDigest(env, digest) {
  const to = env.DIGEST_TO || env.REPORT_TO;
  const out = { mail: 'skipped', webhook: 'skipped' };

  if (mailConfigured(env) && to) {
    try {
      const r = await sendMail(env, { to: [to], subject: digest.subject, html: digest.html });
      out.mail = r.ok ? 'sent' : r.status;
    } catch (e) { out.mail = String((e && e.message) || e); }
  } else {
    out.mail = mailConfigured(env) ? 'no_recipient' : 'no_api_key';
  }

  // Discord／Slack 也收得到。**信與 webhook 是兩條獨立的路**——
  // Resend 的網域驗證還沒完成之前，webhook 是唯一真的送得到的管道。
  if (env.REPORT_WEBHOOK) {
    try {
      const r = await fetch(env.REPORT_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: digest.text.slice(0, 1900), text: digest.text.slice(0, 1900) }),
      });
      out.webhook = r.ok ? 'sent' : `HTTP ${r.status}`;
    } catch (e) { out.webhook = String((e && e.message) || e); }
  }
  return out;
}

