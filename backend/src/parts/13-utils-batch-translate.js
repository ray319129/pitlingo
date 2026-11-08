// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
// ⚠️ **不要放 Access-Control-Allow-Origin: '*'。**
//
// 原本是 `*`，等於任何網站都能從瀏覽器直接打這個 API。搭配「權杖等同公開」
// （S6），一個惡意網頁就能無限燒 Anthropic 額度。
//
// 而我們**根本不需要 CORS**：
//   - 擴充功能的請求由 service worker 發出，有 host_permissions，不受 CORS 限制
//   - userscript 用 GM_xmlhttpRequest，也不受限制
// 拿掉之後，瀏覽器端的跨站呼叫會被瀏覽器自己擋下來，攻擊面直接消失。
const CORS = {
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  // ⚠️ **新增一個自訂標頭時，這一行一定要一起改。**
  //    漏掉不會在後端報錯——瀏覽器會在**預檢**階段就擋下來，
  //    症狀是前端拿到 `Failed to fetch`，而 Worker 的日誌裡什麼都沒有
  //    （那個請求根本沒送到）。帳號頁的 `authorization` 就這樣漏過一次。
  'Access-Control-Allow-Headers': 'content-type,x-client-token,x-admin-token,x-admin-otp,x-admin-session,x-harvest-token,authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * 管理端點需要 CORS，一般端點不需要。
 *
 * 一般端點拿掉 CORS 是對的（用戶端都不受 CORS 限制，開著只是徒增攻擊面）。
 * 但**後台是本機開的 HTML 檔**，`file://` 的 Origin 是 `null`，
 * 沒有 CORS 就完全打不到 API——第一版把自己的後台也擋掉了。
 *
 * 這裡放寬是安全的：管理端點一律要 `x-admin-token`，而那個權杖
 * **不在任何發佈出去的程式碼裡**（不像 CLIENT_TOKEN 隨擴充功能發給所有人）。
 * 沒有權杖的跨站請求照樣是 401。
 */
const ADMIN_CORS = { ...CORS, 'Access-Control-Allow-Origin': '*' };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

/** 管理端點專用的回應（帶 CORS） */
function adminJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...ADMIN_CORS },
  });
}

/**
 * 錯誤代碼表。
 *
 * 為什麼需要：**訊息會隨文案調整而變，代碼不會。** 使用者截圖回報時，
 * 「翻譯失敗，請稍後再試」查不出任何東西；「PL-E31」一秒就定位。
 *
 * ⚠️ **不是每個異常都該給使用者代碼。** 這個專案有兩種「沒有字幕」是正常的：
 *      · 這支影片本來就沒有字幕（宣傳片、純畫面）
 *      · 有字幕的影片中途長時間沒旁白（賽後訪問、頒獎）
 *    給那兩種發代碼，等於訓練使用者把正常現象當故障回報，
 *    然後真正的故障就淹沒在雜訊裡。判準是：
 *      **「使用者的體驗確實壞了」且「我們拿到代碼真的查得出東西」** 才給。
 *
 * ⚠️ 代碼一旦發出去就**不可以改語意**。要淘汰就留著別再用，
 *    不要回收給別的錯誤——使用者手上與工單裡的舊代碼會永遠存在。
 */
const ERR_CODES = {
  E10: '請求格式不正確',
  E11: '缺少必要欄位',
  E12: '一次送出的句數超過上限',
  E13: '單句長度超過上限（整批都超過才會擋）',
  E14: '應付金額低於金流最低收款金額，需人工處理',
  E20: '安裝權杖無效或已過期',
  E21: '這個安裝已被封鎖',
  E22: '授權碼有問題（不存在／已停用／已過期／尚未生效）',
  E30: '免費額度今日已用完',
  E31: '這支影片不在免費範圍內',
  E32: '請求太頻繁',
  E33: '付費帳號今日的翻譯量已達上限（只影響還沒翻過的新內容）',
  E40: '今日翻譯成本已達上限（共用快取不受影響）',
  E41: '翻譯服務暫時不可用',
  E50: '金流參數驗證失敗',
  E51: '訂單不存在',
  // 帳號（Google 登入）。⚠️ **不可以沿用 E40/E41**——那兩個已經在線上
  //    代表「成本達上限」與「翻譯服務不可用」，改語意會讓舊截圖查錯方向。
  E60: 'Google 登入驗證失敗',
  E61: '尚未登入或登入已過期',
  E62: '查無此帳號',
  E63: '授權碼認領失敗',
  E64: 'email 格式不正確',
  E65: 'Email 登入尚未開放或寄信失敗',
  E66: '要求驗證碼太頻繁',
  E67: '驗證碼不正確或已過期',
  E68: '配對碼無效或已過期',
  // 2026-10-02 登入加固
  E56: '機器人驗證未通過',
  E57: '請求來源不符（跨站請求被擋下）',
  E69: '這個信箱的驗證碼猜錯太多次，已暫時鎖定',
  // 2026-10-04 授權碼外洩的處置（E70～E73 已被測試後端的語音辨識用掉）
  E74: '認領驗證碼不正確或已過期',
  E75: '這組授權碼不屬於目前登入的帳號',
  E76: '只憑授權碼解除裝置的次數已達上限（2026-10-30 起不再使用）',
  E77: '換發授權碼太頻繁（2026-10-30 起不再使用：自助換發已拿掉）',
  E78: '這組授權碼已換發，舊碼不能再使用',
  E79: '授權碼要登入擁有它的帳號才能使用',
  E80: '今日收割成本已達上限（使用者的翻譯不受影響）',
  // 彈幕（2026-10-28，尚未發行：ops.danmaku 關著時只有白名單帳號用得到）
  E81: '發送彈幕需要付費授權（觀看不需要；收割端不能用彈幕）',
  E82: '彈幕尚未開放',
  E83: '你已被禁止發送彈幕',
  E84: '彈幕發送太頻繁，請稍後再試',
  E85: '彈幕內容不符合規範',
  E86: '今日彈幕數量已達上限',
  E87: '彈幕連線憑證無效或已過期',
  E88: '彈幕暫停中（後台暫停了這支影片的彈幕）',
  // 2026-10-30 以帳號為準
  E89: '這個帳號目前沒有可用的授權',
  E90: '解除其他裝置要登入「我的帳號」',
  /* @test-only:start */
  // 語音辨識（只在測試後端 f1zh-api-test）
  E70: '語音辨識服務尚未設定金鑰',
  E71: '語音辨識的音訊段大小不對',
  E72: '今日語音辨識分鐘數已達上限',
  E73: '語音辨識服務回傳錯誤',
  /* @test-only:end */
};

/**
 * 錯誤回應。
 *
 * code 是給使用者回報用的短代碼。訊息會隨文案調整而變，
 * 代碼不會——使用者截圖給我們時，代碼才是查得回來的東西。
 */
function err(message, status = 400, code) {
  return json(code ? { error: message, code } : { error: message }, status);
}

/** 與 userscript 的 normKey() 必須完全一致，否則兩邊算出的 key 不同 */
function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bundleKey(cid) { return `bundle:${cid}`; }
// 註：曾經有 line:<cid>:<normKey> 的逐句快取，因為每句一次 KV put 會炸掉
// 免費額度（1,000/天）而移除。譯文現在一律存在 bundle:<cid> 裡。

async function readBundle(env, cid) {
  const raw = await env.SUBS.get(bundleKey(cid));
  if (!raw) return { v: 1, cid, updatedAt: null, segCount: 0, lines: {} };
  try {
    const b = JSON.parse(raw);
    if (typeof b.segCount !== 'number') b.segCount = 0;
    return b;
  } catch { return { v: 1, cid, updatedAt: null, segCount: 0, lines: {} }; }
}

/**
 * 標記「這支影片的字幕已經被完整收割過」。
 *
 * 用途：讓後續的觀看者跳過整軌預抓。沒有這個標記的話，每個人開啟同一支影片
 * 都會再向 CDN 抓一次全部分段（實測 383 段、約 80 秒），而那些分段幾乎不會
 * 帶來任何新句子——純粹的浪費，還會多累積一次 Imperva 的曝險。
 *
 * userscript 早就有這個判斷（`bundleSegCount === segs.length`），
 * 但它是靠 ADMIN_TOKEN 走 `POST /v1/subs` 寫進去的。擴充功能的使用者
 * 不該持有 ADMIN_TOKEN，所以獨立成這支只能寫 segCount 的端點。
 *
 * 防呆：只准往上加。這樣就算某個用戶端算錯或惡意回報，最壞也只是讓別人
 * 略過預抓、退回 worker 攔截（仍有提前量），不會弄壞既有譯文。
 */
/**
 * 標記完整的最低「句/段」比例。
 *
 * 門檻用線上 32 支已完整的影片校準：健康的落在 1.3~2.4 句/段，
 * 安靜的練習賽最低 0.70，壞掉的是 0.19／0.33／0.36。取 0.5 兩邊都安全。
 *
 * ⚠️ 放在模組層是因為**每日彙報也要用同一個門檻**。各寫各的話，
 *    後台說「可疑」而彙報說「正常」，兩邊都不會報錯。
 */
const MIN_LINES_PER_SEG = 0.5;

async function handleComplete(request, env) {
  let body = null;
  try { body = await request.json(); } catch { return err('invalid json'); }
  const cid = String((body && body.cid) || '').trim();
  const segCount = Number(body && body.segCount) || 0;
  if (!cid) return err('缺少 cid');
  // contentId 一定是數字（與 GET /v1/subs 同一個規則）。以前任何字串都收，
  // 每換一個字串就多一筆 nosub:<cid>，而那個前綴沒有總量上限（security-audit #4）。
  if (!/^\d{1,20}$/.test(cid)) return err('cid 格式不正確');

  // 影片的網址後綴。**這是後台唯一能用來分辨「這是哪一場的哪個場次」的東西**——
  // 我們只存 contentId，那是一串數字，人看不出是澳洲正賽還是賽後訪問。
  // 用戶端本來就知道自己在哪一頁，順手帶上來即可。
  const slug = String((body && body.slug) || '').slice(0, 120);

  // ⚠️ **「這支影片沒有官方字幕軌」必須在 segCount 檢查之前處理。**
  //
  //    這段邏輯原本寫在 `handlePostSubs`（`/v1/subs`）裡，但那支端點要
  //    **管理員權杖**而且必須帶 `lines`——擴充功能從來不會打那裡，
  //    它打的是這一支。於是那段程式碼從上線到現在**一次都沒有執行過**。
  //
  //    而這支端點的 `segCount 不合理` 又會把它擋掉（回報時 segCount 一定是 0）。
  //    兩道各自合理的關卡疊在一起，讓「有多少影片沒有字幕」這個
  //    **決定要不要自己做語音辨識的關鍵數字**，永遠是 0。
  //
  //    ⚠️ 不可以因此寫一份空的 bundle：空 bundle 會混進翻譯清單，
  //       看起來像「收割失敗」，而那兩件事該做的處理完全不同。
  if (body && body.noSubtitles) {
    try { await noteNoSubtitles(env, cid, slug); } catch (e) { /* 統計失敗不擋功能 */ }
    return json({ ok: true, noSubtitles: true });
  }

  if (!(segCount > 0 && segCount < 100000)) return err('segCount 不合理');

  const bundle = await readBundle(env, cid);
  // 用戶端送的後綴只在還沒有時補上，並標成「用戶端給的」——免費場次的判斷不信它（見 trustedSlug）
  if (slug && !bundle.slug) { bundle.slug = slug; bundle.slugBy = 'client'; }

  const lineCount = Object.keys(bundle.lines || {}).length;
  // 沒有譯文就不該標記完整——否則別人會跳過預抓卻什麼也拿不到
  if (!lineCount) return json({ ok: false, reason: 'bundle 沒有譯文，不標記', segCount: bundle.segCount });
  // ⚠️ **句數與分段數不成比例時也不可以標記完整。**
  //
  //    原本只檢查「有沒有譯文」，於是一支 1,320 段卻只有 247 句的 bundle
  //    也會被標成完整（線上實測抓到 3 支，最低 0.19 句/段）。
  //    後果是**所有後續觀看者都跳過整軌預抓**，退回逐句翻譯（約 5 倍成本），
  //    而那份殘缺的快取**永遠不會有人再去補**——沒有人會重新收割一支
  //    已經標記完整的影片。不報錯，只是一直花錢。
  //
  //    門檻用線上 32 支已完整的影片校準：健康的落在 1.3~2.4 句/段，
  //    安靜的練習賽最低 0.70，壞掉的是 0.19/0.33/0.36。取 0.5 兩邊都安全。
  if (lineCount < segCount * MIN_LINES_PER_SEG) {
    return json({
      ok: false,
      reason: `句數與分段數不成比例（${lineCount} 句 / ${segCount} 段），可能收割不完整，不標記`,
      segCount: bundle.segCount, lineCount,
    });
  }
  // ⚠️ **用戶端的回報只記成參考值（clientSeg），不碰 segCount**（security-audit run-2 #11）。
  //    segCount 是收割排程與「已完整」的依據；以前任何安裝權杖都能把它設成任意大的數，
  //    缺句的影片就從收割佇列消失，而且只准往上加——真正的數字再也寫不回去。
  //    clientSeg 只用來讓其他觀眾跳過整軌預抓（handleGetSubs），偽造的最壞結果是
  //    「別人退回 worker 攔截」，那正是這支端點原本的設計假設。
  const cur = Math.max(bundle.segCount || 0, bundle.clientSeg || 0);
  if (cur >= segCount) {
    return json({ ok: true, unchanged: true, segCount: cur, lineCount });
  }

  bundle.clientSeg = segCount;
  await writeBundle(env, cid, bundle);
  return json({ ok: true, segCount, lineCount });
}

/**
 * 判斷免費場次時可以相信的網址後綴（security-audit run-2 #9）。
 * 收割與舊資料寫的照信；**用戶端寫的（slugBy: 'client'）不信**——
 * 以前誰先送誰算數，一個匿名安裝就能把真正的免費場次標成「不在免費範圍」，免費使用者全被 E31 擋下。
 */
function trustedSlug(bundle) {
  return (bundle && bundle.slug && bundle.slugBy !== 'client') ? bundle.slug : '';
}

/**
 * 重讀 → 合併 → 寫回。**不要直接寫 handler 一開始讀到的那份。**
 *
 * 為什麼：`/v1/translate` 的流程是「讀 bundle → 呼叫模型（1~2 秒）→ 寫回」。
 * 用戶端同時最多有 3 個請求在飛，三個都讀到同一份舊快照，然後依序整份覆蓋——
 * 只有最後寫的那個活下來，前面的譯文全部消失。
 *
 * 實測：一輪翻了 363 句，後端只多了 148 句（41%），與 3 個並行請求的預期吻合。
 * **完全不會報錯**——每個請求自己都成功，使用者也拿得到譯文，
 * 只有下一個觀看者要重新付費。
 *
 * KV 沒有 CAS，所以做不到完全無損；但把競爭視窗從「模型呼叫的 1~2 秒」縮到
 * 「讀+寫的幾十毫秒」，已經是數量級的差別。（handoff 坑 #24）
 */
/**
 * ─────────────────────────────────────────────────────────────────
 *  bundle 寫入的合併緩衝（2026-09-23，直播實測前）
 * ─────────────────────────────────────────────────────────────────
 *
 * **問題**：「/v1/translate」 每一個「有新句子」的請求就寫一次 KV。直播時
 * 每批只有 3 句左右（提前量短、批次湊不大），一小時約 1,100 句 ＝ 約 370 次寫入，
 * 兩小時的正賽單人就超過 700 次——而**免費方案每天只有 1,000 次**（坑 #10）。
 * 撞牆之後所有寫入回 429：使用者自己看得到字幕（他那次的翻譯有回傳），
 * 但**譯文存不進共用快取**，下一個人要重新付費，而且完全不報錯。
 *
 * **做法**：同一支影片的新句子先累積在 isolate 記憶體，**滿 60 句或超過 15 秒**
 * 才真的寫一次 KV。直播時等於每 20 次請求才寫一次。
 *
 * ⚠️ **緩衝裡的句子要併進讀回來的 bundle**，否則同一個 isolate 的下一個請求
 *    會以為那些句子還沒翻過 → 重新翻一次 → 反而更貴（比多寫幾次 KV 更糟）。
 *
 * ⚠️ **isolate 被回收會帶走還沒寫出去的部分**（最多 60 句／15 秒）。
 *    那些句子只是沒進共用快取，**沒有人會因此看不到字幕**——
 *    與「撞上寫入上限之後每一句都存不進去」相比，這是刻意選的那一邊。
 *
 * ⚠️ 收割（「POST /v1/subs」）與完整標記（「/v1/complete」）**不走這裡**：
 *    那兩條本來就是一次寫一整支，而且要立刻可見。
 */
// ⚠️ **這兩個數字是 2026-09-23 亞塞拜然暖身實測後調整的。**
//    原本是 60 句／15 秒。實測一場 40 分鐘的直播寫了 390 次 KV（每日上限 1,000），
//    拆開來看：速率限制取樣約 33、統計約 14，**其餘約 340 次全是 bundle**。
//    原因是「15 秒」這條規則：直播每 3~4 秒一個請求，所以幾乎每 4 個請求就寫一次；
//    而 Cloudflare 會把請求分散到多個 isolate（實測約 2 個），**每個 isolate 各有一份緩衝
//    與各自的計時器**，寫入次數因此再乘上 isolate 數。
//
//    改成 120 句／90 秒：同樣 40 分鐘約 2 × (2400/90) ≈ 53 次。
//    代價是 isolate 被回收時最多丟 120 句／90 秒——那些句子只是沒進共用快取，
//    **沒有人會因此看不到字幕**（他自己那次的翻譯已經回傳了）。
//
//    ⚠️ 真正的解法是把緩衝搬到 DO（每支影片一個實例，跨 isolate 只有一份），
//       但那要改 DO 的儲存與 alarm，賽前不動。見 handoff 的下一步。
const BUNDLE_BUF_MAX_LINES = 120;
const BUNDLE_BUF_MAX_MS = 90000;
// 寫入失敗時最多留這麼多句等重試。配額用完會一直失敗，不設上限會吃爆記憶體。
const BUNDLE_BUF_RETRY_MAX = 600;
const bundleBuf = new Map();          // cid → { lines, slug, since }

/** 把這次新翻的句子放進緩衝。回傳 true 代表該寫出去了。 */
const BUNDLE_BUF_MAX_CIDS = 300;

function bufferBundleLines(cid, added, slug) {
  const keys = Object.keys(added || {});
  const want = String(slug || '').slice(0, 120);
  if (!keys.length && !want) return false;
  let e = bundleBuf.get(cid);
  if (!e) {
    // ⚠️ 緩衝要有上限（security-audit run-2 #4）：以前每個新的影片編號都留一筆、永遠不清。
    //    只有後綴、沒有句子、而且很久沒人碰的先丟（丟掉只是那支晚一點補後綴）；
    //    還是滿的就不再收新的「只有後綴」。
    if (bundleBuf.size >= BUNDLE_BUF_MAX_CIDS) {
      const now = Date.now();
      for (const [c, old] of bundleBuf) {
        if (!Object.keys(old.lines).length && now - old.since > BUNDLE_BUF_MAX_MS) bundleBuf.delete(c);
      }
      if (bundleBuf.size >= BUNDLE_BUF_MAX_CIDS && !keys.length) return false;
    }
    e = { lines: {}, slug: '', since: Date.now() }; bundleBuf.set(cid, e);
  }
  for (const k of keys) if (!e.lines[k]) e.lines[k] = added[k];
  if (want && !e.slug) e.slug = want;
  return Object.keys(e.lines).length >= BUNDLE_BUF_MAX_LINES
    || Date.now() - e.since >= BUNDLE_BUF_MAX_MS;
}

/** 緩衝裡這支影片的句子（讀 bundle 時要併進去，否則會重翻）。 */
function bufferedLines(cid) {
  const e = bundleBuf.get(cid);
  const seen = roomSeen.get(cid);
  if (seen && Date.now() - seen.at > ROOM_SEEN_MS) roomSeen.delete(cid);
  else if (seen) return e ? Object.assign({}, seen.lines, e.lines) : seen.lines;
  return e ? e.lines : null;
}

/**
 * 房間接手寫 KV 的句子（A15），這個 isolate 仍然記著當讀取快取——不寫 KV，只是讓同一個 isolate 的下一個請求
 * 不必再去問房間。少了這一份，句子在房間寫進 KV 之前（最多 90 秒＋傳播）每個請求都要 peek 一次：
 * sim-live-swarm 100 人實測 ROOM 的 peek 從 5,747 增加到 8,736（DO 請求是免費方案另一個每日上限）。
 * 有上限：最多 300 支影片、每支 3,000 句、5 分鐘沒新句子就丟（那時 KV 早就有了）。
 */
const roomSeen = new Map();
const ROOM_SEEN_MS = 5 * 60000;
function rememberRoomOwned(cid, lines, keys) {
  let e = roomSeen.get(cid);
  if (!e) {
    if (roomSeen.size >= 300) { const old = roomSeen.keys().next().value; roomSeen.delete(old); }
    e = { lines: {}, at: 0, n: 0 };
    roomSeen.set(cid, e);
  }
  for (const k of keys) {
    if (e.n >= 3000) break;
    if (!e.lines[k] && lines[k]) { e.lines[k] = lines[k]; e.n++; }
  }
  e.at = Date.now();
}

/** 真的寫出去。沒有東西就不寫（寫入是天花板）。 */
async function flushBundleBuf(env, cid) {
  const e = bundleBuf.get(cid);
  if (!e) return;
  bundleBuf.delete(cid);
  if (!Object.keys(e.lines).length && !e.slug) return;
  try {
    await mergeWrite(env, cid, e.lines, e.slug);
  } catch (err) {
    // ⚠️ **譯文是已經付過錢的東西，寫失敗不可以就這樣消失。**（2026-09-25 稽核發現）
    //    緩衝是在寫入之前就清掉的，失敗等於「錢付了、共用快取沒有、下一個人重付一次」。
    //    放回去等下一次觸發；併發可能已經放了新的進來，所以新的優先。
    const cur = bundleBuf.get(cid);
    const merged = cur
      ? { lines: Object.assign({}, e.lines, cur.lines), slug: cur.slug || e.slug, since: e.since }
      : e;
    // ⚠️ 但要有上限：KV 配額用完時會一直失敗，無限累積會把 isolate 的記憶體吃掉。
    //    超過就丟掉最舊的（插入順序），保住記憶體——這是最後手段，不是常態。
    const keys = Object.keys(merged.lines);
    if (keys.length > BUNDLE_BUF_RETRY_MAX) {
      const keep = keys.slice(-BUNDLE_BUF_RETRY_MAX);
      const trimmed = {};
      for (const k of keep) trimmed[k] = merged.lines[k];
      merged.lines = trimmed;
    }
    bundleBuf.set(cid, merged);
    throw err;
  }
}

async function mergeWrite(env, cid, added, slug) {
  const keys = Object.keys(added || {});
  const fresh = await readBundle(env, cid);
  // ⚠️ **slug 一定要在這裡寫回，不可以只在呼叫端的那份快照上設。**
  //
  //    呼叫端（handleTranslate）手上的 bundle 是它自己讀的快照，而這裡為了
  //    避免並行覆蓋（坑 #24）會**重新讀一份乾淨的再寫回**——呼叫端在快照上
  //    設的任何欄位都會被無聲丟棄，包括 slug。
  //
  //    實際後果（2026-09-14 從線上資料查出來）：8/20~9/13 共 11 場直播、
  //    24,127 句譯文全部沒有 slug，後台完全分不了類。收割那條路沒事，
  //    因為 handlePostSubs／handleComplete 是直接呼叫 writeBundle——
  //    **也就是「手動收割的有標題、真實使用者看的沒有」，正好是反的。**
  //
  //    ⚠️ 這是坑 #24 的副作用，不是它的錯：修「讀→慢操作→寫回」時，
  //       要把**那段期間在快照上寫過的每一個欄位**都帶過來，不只是主要資料。
  const want = String(slug || '').slice(0, 120);
  // ⚠️ **只為了補後綴而寫，要這支影片本來就有譯文**（security-audit run-2 #4）。以前空白的翻譯請求
  //    每換一個影片編號就永久寫一筆 bundle——不花模型費、不吃免費額度，一路燒全站的 KV 寫入。
  //    「整批命中快取時補後綴」這條仍然成立（坑 #38），因為那種 bundle 一定有句子。
  const needSlug = !!want && !fresh.slug
    && (keys.length > 0 || Object.keys(fresh.lines || {}).length > 0);
  // 沒有新句子、也沒有 slug 要補，就不要寫 KV（寫入是天花板，坑 #10）。
  if (!keys.length && !needSlug) return;
  if (needSlug) { fresh.slug = want; fresh.slugBy = 'client'; }
  for (const k of keys) {
    // 上限也要在這裡擋。原本只有 handlePostSubs 檢查，
    // 但擴充功能上線後絕大多數寫入都走這條路。
    if (Object.keys(fresh.lines).length >= BUNDLE_MAX_LINES) break;
    if (!fresh.lines[k]) fresh.lines[k] = added[k];   // 只補、不覆蓋別人的
  }
  await writeBundle(env, cid, fresh);
}

async function writeBundle(env, cid, bundle) {
  bundle.updatedAt = new Date().toISOString();
  invalidateBundleMeta();      // 後台的清單快取要馬上看得到這一支
  // ⚠️ **一定要同時寫 KV metadata。**
  //
  // 後台要列出「哪些影片翻好了、各有幾句」，而 `list()` 只回傳鍵名——
  // 沒有 metadata 的話，要知道句數就得把每一份 bundle 都讀出來，
  // 一份兩千句約 200KB，一百支就是 20MB 的讀取，一次列表就會逾時。
  //
  // metadata 有 1KB 上限，所以只放摘要，不放內容。
  await env.SUBS.put(bundleKey(cid), JSON.stringify(bundle), {
    metadata: {
      n: Object.keys(bundle.lines || {}).length,
      seg: bundle.segCount || 0,
      // 標記完整的是哪個版本（見 MARK_TRUSTED_FROM）。舊資料沒有這一欄＝來源不明
      mv: String(bundle.markV || '').slice(0, 16),
      at: bundle.updatedAt,
      slug: String(bundle.slug || '').slice(0, 120),
    },
  });
}

/**
 * 粗略的每 IP 速率限制。
 * KV 是最終一致性，所以本來就是近似值 —— 目的是擋住失控迴圈，不是精算配額。
 *
 * ⚠️ 每次請求都寫一次 KV 會吃掉免費額度（1,000 puts/天）。
 * 改成取樣：平均每 SAMPLE 次才寫一次，寫入時直接加 SAMPLE 補回來。
 * 精度變差但門檻仍然守得住，而寫入量降為 1/SAMPLE。
 */
// 2026-09-23：直播 334 個請求換到約 33 次速率限制的取樣寫入。上限是 1,000/天，
// 取樣拉到 25 仍然擋得住失控迴圈（門檻本來就是近似值），寫入量降到 1/2.5。
const RL_SAMPLE = 25;

/**
 * 速率限制。
 *
 * 鍵從 IP 換成 installId（SECURITY.md S8）：IP 換個 proxy 就繞過，
 * 而 installId 要繞過就得不斷重新註冊——而註冊本身另有 IP 限制。
 *
 * 仍然用取樣寫入（每 10 次才寫一次 KV），因為每次都寫必定撞爆
 * 1,000 puts/天 的額度。取樣讓限制變成近似值，但配合成本熔斷已經足夠。
 */
async function rateLimited(env, ip) {
  // ⚠️ **鍵名不可以含原始 IP。** 隱私權政策承諾「原始 IP 不會被寫入任何儲存」，
  //    以前這裡是 `rl:<IP>:<分鐘>`（2026-09-17 對照條款時發現）。
  //    呼叫端傳進來的可能是 IP、installId 或帳號，一律雜湊，行為不變。
  const who = (await hmac(tokenSecret(env) || 'x', 'rl:' + String(ip || ''))).slice(0, 16);
  // Cloudflare 的 Rate Limiting binding（2026-10-26，現成工具優先）：不吃 KV 寫入。sim-live-swarm 100 人 30 分鐘，
  // 這裡的 KV 取樣寫入 418 次＝全部 KV 寫入的一半，人數一多就是撞上每日 1,000 次的第一個原因。
  // binding 的計數是每個機房各自一份、近似值——與 KV 取樣一樣是「擋失控迴圈」的精度，夠用（官方文件 Rate Limiting）。
  // 沒有 binding（本機、測試、或方案不支援）或呼叫失敗時退回下面的 KV 取樣
  if (env.RL && typeof env.RL.limit === 'function') {
    try { const r = await env.RL.limit({ key: who }); return !(r && r.success); } catch (e) { /* 退回 KV 取樣 */ }
  }
  const key = `rl:${who}:${Math.floor(Date.now() / 60000)}`;
  const n = parseInt((await env.SUBS.get(key)) || '0', 10);
  if (n >= RATE_LIMIT_PER_MIN) return true;
  if (Math.random() < 1 / RL_SAMPLE) {
    // ⚠️ **寫不進去也要放行**（2026-10-16，handoff 6.2 S3）。KV 寫入額度用完那一刻起，
    //    這行原本會丟例外，**每 25 個請求就有 1 個直接 500**——擋失控迴圈的計數器
    //    把正常使用者的字幕弄掉，和坑 #49（快取寫不進去升級成使用者壞掉）同一類。
    //    計數少記一筆只是限制鬆一點；成本熔斷與 AuthGuard 的額度仍然在。
    try { await env.SUBS.put(key, String(n + RL_SAMPLE), { expirationTtl: 120 }); } catch (e) { /* 見上 */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Anthropic 批次翻譯
// ---------------------------------------------------------------------------
/**
 * 呼叫模型。逐句與批次共用同一份 system，才能共用同一份 prompt cache。
 */
async function callModel(env, userContent, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // 一定要先看 stop_reason 再讀 content
  // ⚠️ 拒答也是付過錢的呼叫——把 usage 帶在錯誤上，呼叫端才記得到（2026-09-18 對帳發現）
  if (data.stop_reason === 'refusal') { const e = new Error('model refusal'); e.usage = data.usage || {}; throw e; }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return { text, usage: data.usage || {} };
}

/**
 * ⚠️ 只有一句時**不要走批次編號協定**（userscript 坑 #9）。
 *
 * prompt 內部有衝突：【輸出規則】說「只輸出譯文本身」，【批次模式】說「每行加編號」。
 * 句數多時模型照批次規則走；**只有一句時它會照輸出規則直接給譯文、不加編號**，
 * 於是解析端一個都對不上，整批作廢。
 *
 * 實測就是這樣：單句批次回覆率只有 50%（送 2 句回 1 句），而且完全不報錯——
 * 沒對上的那句只是「沒有譯文」，下次再翻一遍，白花一次錢。
 */
/**
 * 收割端用另一把金鑰（2026-10-27 Ray 建好 workspace 與 `ANTHROPIC_API_KEY_HARVEST`）。
 * 為什麼：Console 的用量／成本報表以 workspace 分——收割與觀眾的帳單才分得開（後端自己記的是下限，A11）；
 * 花費上限與速率限制也各自一份：收割出事（R18 排位整場進 misc）不吃觀眾的額度，晚上整支重播的大量請求不讓直播觀眾被限流。
 * 沒設定時退回 ANTHROPIC_API_KEY。只換金鑰，其他綁定（KV、DO）原封不動。
 */
function modelEnv(env, auth) {
  if (!auth || !auth.harvest || !env.ANTHROPIC_API_KEY_HARVEST) return env;
  return Object.assign({}, env, { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY_HARVEST });
}

async function translateOne(env, line) {
  const r = await callModel(env, line, 200);
  return { out: r.text ? { [line]: r.text } : {}, usage: r.usage };
}

// ---------------------------------------------------------------------------
// 譯文錯開一格（2026-11-05 查出：共用快取約 2% 的句子拿到「後一句」的譯文）
//
// 成因：模型在一批裡合併或跳過某一行，之後的編號照樣連續往下編——從那一行起每一句
// 都拿到下一句的譯文，最後一號則消失。SYSTEM_PROMPT 從第一版就寫「不要合併、拆分、
// 重排或省略任何一行」，模型偶爾仍不守；以前解析只看編號，這裡是第二道防線。
//
// ⚠️ **不可以只用「中文裡的名字出現在下一句英文」來判斷。** 英文一句話常被字幕切成兩行，
//    模型照語意把後半的名字譯在前一行（「hulkenberg s very close 100th of a｜second away
//    from max verstappen」）——那不是錯，而且同一批每次都會這樣翻，擋了就永遠進不了快取、
//    每一輪重付一次錢。翻譯當下只認兩個不會誤判的訊號（見 alignBreak）。
// ---------------------------------------------------------------------------
const ALIGN_STOP = new Set(['the', 'and', 'drs', 'vsc', 'f1tv', 'formula', 'one', 'grand', 'prix', 'pit', 'lap', 'team', 'radio', 'okay']);

/**
 * 辭典裡的專有名詞（SYSTEM_PROMPT 裡首字大寫的字：車手、車隊、轉播員、賽道、彎角），小寫。
 * 英文是正規化過的小寫，認不出哪個字是名字——一批裡如果只有錯開的那一句提到某人，
 * 光看這一批的中文就認不出來，所以加上辭典。
 * ⚠️ 去掉常見英文字（Hill、Park、Ring、Turn…）：它們出現在一般句子裡，譯文本來就沒有，
 *    當成名字會讓「本句名字全不見」幾乎永遠成立，嚴格版就退化成寬鬆版。
 */
const ALIGN_COMMON = new Set(('race plan will brown mad magic manual override course control clerk stop village loop farm curve curves '
  + 'square pool tunnel hairpin straight grand hotel street city strip ring club first chapel vale wall champions castle section town '
  + 'sling shot bridge memorial stadium turn triple apex long beach slam driver massive corner seat source campus kick shell puma halo '
  + 'swimming hill park moss button hunt jones boxes triangle crossover new that\'s he\'s and the bulls '
  + 'circuit international qualifying sprint practice').split(' '));
let promptNames_ = null;
function promptNames() {
  if (!promptNames_) {
    promptNames_ = new Set();
    for (const w of String(SYSTEM_PROMPT).match(/\b[A-Z][a-z][A-Za-z'-]{2,}\b/g) || []) {
      const t = w.toLowerCase();
      if (!ALIGN_COMMON.has(t) && !ALIGN_STOP.has(t)) promptNames_.add(t);
    }
  }
  return promptNames_;
}

/** 中文譯文裡保留原文的專有名詞（Verstappen、Red Bull…），小寫 */
function alignTokens(s) {
  return (String(s || '').match(/[A-Za-z][A-Za-z'-]{2,}/g) || [])
    .map((t) => t.toLowerCase().replace(/'s$/, ''))
    .filter((t) => !ALIGN_STOP.has(t));
}

/**
 * 第 i 句是不是拿到了後一句的譯文（嚴格版，翻譯當下用）：
 *   中文裡的名字全部不在本句英文、都在下一句英文、而下一句的中文沒有它們；
 *   **而且本句英文自己的名字在中文裡一個都沒有**——跨行的句子會保留自己的名字，錯開的不會。
 *
 * ⚠️ 英文是正規化過的小寫，認不出哪個字是名字。「名字」改用 names：這一批中文譯文裡
 *    出現過的英文字（中文裡保留原文的幾乎都是人名、隊名、地名）。不傳 names 就用整批的中文算。
 */
function shiftedAt(en, zh, i, names) {
  if (!names) { names = new Set(); for (const z of zh) for (const t of alignTokens(z)) names.add(t); }
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

/**
 * 寬鬆版（清理舊資料、後台掃描用）：不要求本句英文有名字。
 * 會連「英文沒有名字的跨行句」一起抓（實測約一半），所以**只能拿來刪**——
 * 刪錯的下次重翻而已；不能拿來在翻譯當下擋（會永遠擋同一句）。
 */
function shiftSuspectIdx(en, zh) {
  const out = [];
  for (let i = 0; i + 1 < en.length; i++) {
    const a = alignTokens(zh[i]);
    if (!a.length) continue;
    const e0 = String(en[i]).toLowerCase(), e1 = String(en[i + 1]).toLowerCase();
    if (a.some((t) => e0.includes(t))) continue;
    if (!a.every((t) => e1.includes(t))) continue;
    const z1 = String(zh[i + 1] || '').toLowerCase();
    if (a.some((t) => z1.includes(t))) continue;
    out.push(i);
  }
  return out;
}

/**
 * 這一批從第幾句起不可信（-1＝整批可信）。
 *   1. 編號超出輸入、或最後一號不見（而前面有對上）→ 模型重新編過號，從哪裡開始錯不知道 → 0
 *   2. shiftedAt 成立的第一句 → 從那一句起（錯開會一路傳到最後）
 */
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

function sumUsage(a, b) {
  const o = Object.assign({}, a || {});
  for (const [k, v] of Object.entries(b || {})) if (typeof v === 'number') o[k] = (o[k] || 0) + v;
  return o;
}

async function translateBatch(env, lines, depth) {
  if (lines.length === 1) return translateOne(env, lines[0]);
  depth = depth || 0;

  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const r = await callModel(env, `【批次翻譯】共 ${lines.length} 句\n${numbered}`, 2500);
  const text = r.text;
  const data = { usage: r.usage };

  // ⚠️ 同一個編號出現兩次＝這個編號不可信，**兩個都不要**（以前是後面的蓋前面的——
  //    偽造的編號正好排在後面）。那一句會在下一輪單獨重翻，多花一點錢而已。
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

  // 錯開一格：從 cut 起的譯文不收。**換個組合再翻**（拆成兩半）——temperature 0，
  // 同一批原樣重送多半得到同樣的錯。最多拆兩層；到最底層還錯、而剩下 ≤ 5 句就逐句翻
  // （單句不編號，不可能錯開）；更多就不收，下一輪由呼叫端重新要。
  // 呼叫次數上限：1 + 2 + 4 + 4×5 = 27（每一層每一組都錯開才會到；實際一次錯開約 4～8 次）。
  const cut = alignBreak(lines, map);
  if (cut >= 0) {
    const out = {};
    for (let i = 0; i < cut; i++) if (map[i + 1]) out[lines[i]] = map[i + 1];
    let usage = data.usage || {};
    const rest = lines.slice(cut);
    const parts = rest.length === 1 ? [rest]
      : depth < 2 ? [rest.slice(0, Math.ceil(rest.length / 2)), rest.slice(Math.ceil(rest.length / 2))]
        : rest.length <= 5 ? rest.map((l) => [l]) : [];
    for (const part of parts) {
      try {
        const sub = await translateBatch(env, part, depth + 1);
        Object.assign(out, sub.out);
        usage = sumUsage(usage, sub.usage);
      } catch (e) {
        // ⚠️ 前面已經付的錢跟著錯誤帶出去（坑 #44／#68）
        e.usage = sumUsage(usage, e.usage);
        throw e;
      }
    }
    return { out, usage, realigned: rest.length };
  }

  const out = {};
  lines.forEach((l, i) => {
    const zh = map[i + 1];
    if (zh) out[l] = zh;
  });

  // 備援：一個編號都沒對上，但回應行數剛好等於輸入行數 → 按位置對應。
  // 模型偶爾會整批漏掉編號，這時位置資訊仍然可信，不該整批丟掉重翻。
  if (!Object.keys(out).length) {
    const rows = text.split('\n').map((x) => x.trim()).filter(Boolean);
    if (rows.length === lines.length) {
      lines.forEach((l, i) => {
        const zh = rows[i].replace(/^\s*\d+\s*[.、:：)]\s*/, '').trim();
        if (zh) out[l] = zh;
      });
    }
  }
  return { out, usage: data.usage || {} };
}

