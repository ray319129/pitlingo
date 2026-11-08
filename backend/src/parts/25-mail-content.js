// =====================================================================
// 寄信內容（使用者可在後台自行編輯，2026-11-05 v5.94）
//
// Ray：「要能夠讓我修改寄信的內容」→「都要開放編輯」。
//
// 做法與網站內容（25-site-content.js）相同的原則：
//   · 程式碼裡帶著**預設內容**（MAIL_DEFS），後台發布的只「覆寫」標題、大標題、內文
//   · 寫入一律走 /v1/admin/*（與後台同一道門），舊版本推進歷史，可以還原
//   · 預設與覆寫走**同一個渲染器**；預覽也呼叫**真正寄信用的那個函式**（MAIL_SAMPLES），
//     只是收件人與資料是假的——預覽長什麼樣，寄出去就長什麼樣
//
// ⚠️ **內文一律當純文字處理。** 支援的標記只有：
//      **粗體**　　空一行＝分段　　「## 標題」　　「- 」開頭＝清單　　「~ 」開頭＝灰色小字
//      [文字](網址)＝連結　　單獨一行的 [文字](網址)＝紅色按鈕
//      {變數}＝換成實際值（逸出）
//      單獨一行的 {{區塊}}＝程式產生的資料區塊（驗證碼、交易明細、裝置資訊…）
//    允許任意 HTML 等於讓「後台權杖外洩」升級成「用我們的網域寄釣魚信」。
//    連結只接受網站內容同一份白名單（siteHrefOk）。
// ⚠️ **資料區塊留在程式裡**：驗證碼、交易明細（含「非統一發票」）、裝置／地點／時間——
//    那些內容是安全或法律需要的，不開放改字，只能決定放哪裡。`required` 的區塊刪掉就不准發布
//    （少了驗證碼的驗證碼信、少了明細的收據，寄出去就是壞的）。
// ⚠️ 發布時檢查**系統事實**（免費分鐘數、價格、裝置數，siteFactProblems）與行銷規則：
//    車隊無線電一律不准；VPN 只准出現在代訂這種「使用條件」的信（`vpnOk`）。
// ⚠️ 寄給管理員的通知與每日彙報不在這裡（內部用、內容是資料）。
// =====================================================================
const MAIL_CONTENT_KEY = 'mail:content';
const MAIL_HISTORY_KEY = 'mail:history';
const MAIL_HISTORY_MAX = 20;
const MAIL_SUBJECT_MAX = 120;
const MAIL_BODY_MAX = 4000;
const MAIL_FIELDS = ['subject', 'heading', 'body'];

/** 可以在後台編輯的信。id 也是 texts 的鍵前綴（welcome.subject、welcome.heading、welcome.body）。 */
const MAIL_DEFS = {
  welcome: {
    name: '歡迎信',
    when: '帳號建立的那一次（Google 或信箱驗證碼登入），每個帳號只寄一封',
    vars: { email: '使用者的信箱', mins: '每天免費分鐘數（系統設定）', site: '網站網址' },
    blocks: {},
    required: [],
    subject: '歡迎使用 PitLingo',
    heading: '歡迎使用 PitLingo',
    // 2026-11-05 Ray：「您好之後不用說那麼多，讓使用者知道已經建立完成就好」；
    // 刪掉「不需要輸入任何序號」與最後一段「這是帳號建立時的唯一一封歡迎信……聯絡我們」
    body: [
      '您好：',
      '',
      '您的 PitLingo 帳號（**{email}**）已經建立完成。',
      '',
      '## 現在就能用',
      '- 登入帳號後，**每天免費 {mins} 分鐘**（本季的練習賽、衝刺賽、排位賽、正賽；台灣時間 0 點重置）',
      '- 打開 F1TV 開始播放，中文字幕會自動出現，不用任何設定',
      '- 直播也能用：比賽中的評論一句一句即時翻成中文',
      '',
      '## 想把整個週末看完？',
      '免費時間是讓您先試試看。購買 **Weekend Pass**，一個比賽週末的直播與重播都不限時間；整季都想看，賽季通行證更划算。購買後用**同一個信箱**登入擴充功能，授權就會自動啟用。',
      '',
      '[購買 Weekend Pass](/buy)',
      '',
      '~ 以前用別的信箱買過？到「[我的帳號](/account)」輸入購買時的信箱認領，就會併進這個帳號。',
    ].join('\n'),
  },
  otp: {
    name: '登入驗證碼',
    when: '用信箱驗證碼登入時',
    vars: { mins: '驗證碼幾分鐘內有效' },
    blocks: { code: '六位數驗證碼（大字框）' },
    required: ['code'],
    // ⚠️ 主旨不放驗證碼（會出現在鎖定畫面通知、郵件日誌）——{{code}} 只能放在內文
    subject: 'PitLingo 登入驗證碼',
    heading: 'PitLingo 登入驗證碼',
    body: [
      '{{code}}',
      '把這組數字輸入登入畫面即可，{mins} 分鐘內有效。',
      '',
      '~ 如果不是您本人要登入，請忽略這封信——在您輸入這組數字之前，沒有任何人能用它登入。',
    ].join('\n'),
  },
  claim: {
    name: '認領購買驗證碼',
    when: '有人在「我的帳號」輸入購買信箱、要把那個信箱的購買併進他的帳號時（寄到購買信箱）',
    vars: { requester: '要求認領的那個帳號（信箱）', mins: '驗證碼幾分鐘內有效' },
    blocks: { code: '六位數驗證碼（大字框）' },
    required: ['code'],
    subject: 'PitLingo 認領購買驗證碼',
    heading: 'PitLingo 認領購買驗證碼',
    body: [
      '{{code}}',
      '有人在 PitLingo 要求把**這個信箱**的購買紀錄，併入另一個登入帳號（**{requester}**）。',
      '',
      '如果是您本人（例如用公司信箱購買、用私人信箱登入），把這組數字輸入「我的帳號」頁面即可，{mins} 分鐘內有效。',
      '',
      '~ **如果不是您本人：請不要把這組數字告訴任何人**，包括自稱客服的人——我們永遠不會向您索取驗證碼。',
    ].join('\n'),
  },
  newdevice: {
    name: '新裝置登入通知',
    when: '帳號在新的瀏覽器或擴充功能登入時（帳號建立 30 分鐘內不寄）',
    vars: { email: '帳號信箱' },
    blocks: { details: '裝置、地點（含「可能不精確」）、台灣時間' },
    required: ['details'],
    subject: 'PitLingo：有新裝置登入您的帳號',
    heading: '有新裝置登入您的 PitLingo 帳號',
    body: [
      '您好：',
      '',
      '有新裝置登入您的 PitLingo 帳號（**{email}**）。',
      '',
      '## 詳情',
      '{{details}}',
      '**如果這是您本人：**',
      '不需要做任何事，祝您觀賽愉快！',
      '',
      '**如果這不是您：**',
      '請立即到「我的帳號」按**「登出所有裝置」**——所有裝置都會被登出，授權也會在那些裝置上立刻停止。',
      '能登入您的帳號，代表對方收得到這個信箱的驗證碼（或登得進您的 Google 帳號），請同時**變更信箱密碼並開啟兩步驟驗證**。',
      '',
      '[前往我的帳號](/account)',
      '',
      '~ 需要協助？請到 pitlingo.com「聯絡我們」。我們不會向您索取驗證碼或授權碼。',
    ].join('\n'),
  },
  order: {
    name: '訂單完成',
    when: '付款成功、授權開通時',
    vars: { email: '購買信箱', orderId: '訂單編號' },
    blocks: {
      contains: '同一張訂單有兩份授權時的清單（沒有就是空的）',
      receipt: '交易明細（訂單編號、日期、品項、金額、「非統一發票」）',
      service: '有代訂時的說明（沒有就是空的）',
      activate: '啟用方式三步驟與裝置數',
    },
    required: ['receipt'],
    subject: 'PitLingo 訂單完成（{orderId}）',
    heading: 'PitLingo 訂單完成',
    body: [
      '感謝您的購買，授權已經開通。它綁定**這個信箱的帳號**：在擴充功能用這個信箱登入就會自動啟用，**不需要輸入任何序號**，換電腦或重新安裝都一樣。',
      '{{contains}}',
      '{{receipt}}',
      '{{service}}',
      '{{activate}}',
      '[前往我的帳號](/account)',
    ].join('\n'),
  },
  order_nokey: {
    name: '訂單完成（不含字幕授權）',
    when: '只買代訂（共用帳號單一週末）、沒有字幕授權的訂單付款成功時',
    vars: { email: '購買信箱', orderId: '訂單編號' },
    blocks: {
      receipt: '交易明細（訂單編號、日期、品項、金額、「非統一發票」）',
      service: '代訂說明',
    },
    required: ['receipt'],
    subject: 'PitLingo 訂單完成（{orderId}）',
    heading: 'PitLingo 訂單完成',
    body: [
      '感謝您的購買，我們已收到您的訂單。',
      '',
      '**本方案不含字幕翻譯使用權**——這是正常的，不是漏寄。若您也需要中文字幕，請另外購買比賽週通行證。',
      '{{receipt}}',
      '{{service}}',
      '[前往我的帳號](/account)',
    ].join('\n'),
  },
  reissue: {
    name: '授權已重新設定',
    when: '客服在後台換發授權時',
    vars: { email: '授權的信箱', orderId: '訂單編號' },
    blocks: {
      contains: '同一張訂單有兩份授權時的清單（沒有就是空的）',
      receipt: '交易明細',
      service: '有代訂時的說明（沒有就是空的）',
      activate: '啟用方式三步驟與裝置數',
    },
    required: ['receipt'],
    subject: 'PitLingo 授權已重新設定（{orderId}）',
    heading: 'PitLingo 授權已重新設定',
    body: [
      '您的授權**已由客服重新設定**，原本啟用的裝置都已登出。請在要使用的裝置上，於擴充功能**登出再登入**（請用 {email}），授權就會恢復。方案與有效期限都不變。',
      '',
      '~ 如果您沒有聯絡過客服，請直接回覆這封信。',
      '{{contains}}',
      '{{receipt}}',
      '{{service}}',
      '{{activate}}',
      '[前往我的帳號](/account)',
    ].join('\n'),
  },
  gift: {
    name: '朋友送您通行證',
    when: '有人把附贈的比賽週通行證轉送給這個信箱時',
    vars: { from: '送的人（遮罩過的信箱）', gp: '哪一站', date: '生效日' },
    blocks: {},
    required: [],
    subject: 'PitLingo：朋友送您一張比賽週通行證',
    heading: '朋友送您一張比賽週通行證',
    body: [
      '{from} 送您一張 **PitLingo 比賽週通行證**：**{gp}**（{date} 起生效）。觀看 F1TV 時會有即時繁體中文字幕。',
      '',
      '使用方式：安裝 PitLingo 擴充功能 → 按「登入」，**用收到這封信的信箱登入**，授權就會自動啟用，不需要輸入任何序號。',
      '',
      '~ 需要自備有效的 F1TV 訂閱。如果您不認識寄件人，忽略這封信即可。',
    ].join('\n'),
  },
  f1ready: {
    name: '代訂 F1TV 帳號已準備好',
    when: '代訂的 F1TV 帳號指派給客人時（後台代訂）',
    vars: { email: '客人的信箱', plan: '方案名稱', gp: '哪一站（沒有就是空的）', from: '開始時間', until: '結束時間' },
    blocks: { access: '什麼時候能在「我的帳號」看到帳密（共用帳號在開始前會寫開始時間）' },
    required: ['access'],
    vpnOk: true,   // VPN 是使用條件，不是推廣（網站行銷規則允許出現在使用條件）
    subject: 'PitLingo：您的 F1TV 帳號已準備好，請登入我的帳號查看',
    heading: '您的 F1TV 帳號已準備好',
    body: [
      '您好：',
      '',
      '您訂購的 **{plan}**{gp} 已準備好。',
      '{{access}}',
      '使用期間：{from} 至 {until}（台灣時間）。',
      '',
      '請用**收到這封信的信箱**登入（{email}）。',
      '',
      '[前往我的帳號](/account)',
      '',
      '**請勿更改此 F1TV 帳號的密碼、登入信箱或訂閱設定**，否則可能導致您與其他使用者無法登入。觀看 F1TV 需自行準備 VPN。',
      '',
      '~ 為了您的帳號安全，密碼不會寫在信裡。登入有問題請到 pitlingo.com「聯絡我們」。',
    ].join('\n'),
  },
};

function mailEscAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 站內路徑補成完整網址（信裡沒有「目前網站」可以相對）。白名單外的回空字串。 */
function mailHref(h, site) {
  const s = String(h || '').trim();
  if (!siteHrefOk(s) || s.startsWith('#')) return '';
  return s.startsWith('/') ? site + s : s;
}

/**
 * 純文字 → 信件 HTML。**先逸出、再套標記**——使用者打的任何 `<` 都只會是字。
 * 變數在逸出之後才換進去，而且變數值本身也逸出（信箱是外人可以決定的字串）。
 * `blocks` 是程式產生、可信的 HTML，只能以「單獨一行的 {{名稱}}」放進來。
 */
function renderMailBody(text, vars, site, blocks) {
  const bl = blocks || {};
  const inline = (line) => {
    let h = esc(line);
    h = h.replace(/\[([^\]\n]{1,80})\]\(([^)\s]{1,300})\)/g, (m, label, href) => {
      const u = mailHref(href.replace(/&amp;/g, '&'), site);
      return u ? `<a href="${mailEscAttr(u)}" style="color:${MAIL_C.text};text-decoration:underline">${label}</a>` : label;
    });
    h = h.replace(/\*\*([^*\n]+)\*\*/g, (m, t) => `<b style="color:${MAIL_C.text}">${t}</b>`);
    h = h.replace(/\{(\w{1,20})\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? esc(vars[k]) : m));
    return h;
  };
  const out = [];
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  let small = false;
  let list = [];
  const flushPara = () => {
    if (para.length) {
      out.push((small ? `<p style="font-size:14px;color:${MAIL_C.dim}">` : '<p>') + para.map(inline).join('<br>') + '</p>');
      para = [];
    }
    small = false;
  };
  const flushList = () => {
    if (list.length) {
      out.push('<ul style="margin:0;padding-left:20px">' + list.map((l) => `<li style="margin:0 0 8px">${inline(l)}</li>`).join('') + '</ul>');
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const blk = line.trim().match(/^\{\{(\w{1,20})\}\}$/);
    if (blk) {
      flushPara(); flushList();
      if (Object.prototype.hasOwnProperty.call(bl, blk[1])) out.push(String(bl[blk[1]] || ''));
      continue;
    }
    const btn = line.trim().match(/^\[([^\]\n]{1,40})\]\(([^)\s]{1,300})\)$/);
    if (btn) {
      const u = mailHref(btn[2], site);
      flushPara(); flushList();
      out.push(u ? mailButton(mailEscAttr(u), esc(btn[1])) : `<p>${esc(btn[1])}</p>`);
      continue;
    }
    if (/^##\s+/.test(line)) { flushPara(); flushList(); out.push(mailH2(inline(line.replace(/^##\s+/, '')))); continue; }
    if (/^-\s+/.test(line)) { flushPara(); list.push(line.replace(/^-\s+/, '')); continue; }
    flushList();
    if (/^~\s+/.test(line)) {
      if (!small) flushPara();
      small = true;
      para.push(line.replace(/^~\s+/, ''));
      continue;
    }
    if (small) flushPara();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
}

/** 後台送上來的內容只留認得的鍵、截長度；不認得的丟掉（少一個欄位只是用預設）。 */
function sanitizeMailContent(raw) {
  const texts = {};
  const src = (raw && typeof raw === 'object' && raw.texts && typeof raw.texts === 'object') ? raw.texts : {};
  for (const id of Object.keys(MAIL_DEFS)) {
    for (const f of MAIL_FIELDS) {
      const v = src[id + '.' + f];
      if (typeof v !== 'string' || !v.trim()) continue;
      texts[id + '.' + f] = f === 'body'
        ? v.replace(/\r\n?/g, '\n').slice(0, MAIL_BODY_MAX)
        : v.replace(/[\r\n]+/g, ' ').trim().slice(0, MAIL_SUBJECT_MAX);
    }
  }
  return { texts };
}

/** 發布前的檢查：系統數字（與網站同一套）＋行銷規則＋連結白名單＋資料區塊。回傳問題清單。 */
function mailContentProblems(content, ops) {
  const texts = (content && content.texts) || {};
  const out = siteFactProblems({ texts }, ops);
  for (const [k, v] of Object.entries(texts)) {
    const id = k.split('.')[0];
    const def = MAIL_DEFS[id];
    if (!def) continue;
    const name = `${def.name}・${{ subject: '標題', heading: '大標題', body: '內文' }[k.split('.')[1]] || k}`;
    if (/車隊無線電|team\s*radio/i.test(v)) out.push(`${name}：不可以提車隊無線電（目前沒有 Team Radio 翻譯）`);
    if (!def.vpnOk && /VPN/i.test(v)) out.push(`${name}：這封信不可以提 VPN（只有代訂的使用條件可以）`);
    for (const m of String(v).matchAll(/\[[^\]\n]{1,80}\]\(([^)\s]{1,300})\)/g)) {
      if (!mailHref(m[1], 'https://pitlingo.com')) out.push(`${name}：連結「${m[1]}」不在允許範圍（只接受站內路徑與 pitlingo.com）`);
    }
    for (const m of String(v).matchAll(/\{\{(\w{1,20})\}\}/g)) {
      if (!k.endsWith('.body')) out.push(`${name}：{{${m[1]}}} 只能放在內文`);
      else if (!Object.prototype.hasOwnProperty.call(def.blocks, m[1])) out.push(`${name}：沒有 {{${m[1]}}} 這個區塊（可用：${Object.keys(def.blocks).map((b) => '{{' + b + '}}').join('、') || '無'}）`);
    }
    if (k.endsWith('.body')) {
      for (const b of def.required) {
        if (!new RegExp('^\\s*\\{\\{' + b + '\\}\\}\\s*$', 'm').test(v)) out.push(`${name}：一定要有單獨一行的 {{${b}}}（${def.blocks[b]}）`);
      }
    }
  }
  return out;
}

async function readMailContent(env) {
  try { return JSON.parse((await env.SUBS.get(MAIL_CONTENT_KEY)) || 'null'); } catch (e) { return null; }
}

/**
 * 組出某一封信的標題、大標題與內文 HTML。`override` 給後台預覽用（還沒發布的草稿）。
 * 讀不到 KV、或沒有覆寫時一律用預設——**寄信不可以因為內容設定壞掉而不寄**。
 * 覆寫的內文若少了必要區塊（例如 KV 被手動改壞），**那一封退回預設內文**——寧可舊文字，不可以寄出沒有驗證碼的驗證碼信。
 */
async function composeMail(env, id, vars, override, blocks) {
  const def = MAIL_DEFS[id];
  let content = override;
  if (!content) content = await readMailContent(env);
  const t = (content && content.texts) || {};
  const site = env.SITE_URL || 'https://pitlingo.com';
  const all = { site, ...vars };
  const pick = (f) => ((typeof t[id + '.' + f] === 'string' && t[id + '.' + f].trim()) ? t[id + '.' + f] : def[f]);
  let bodyRaw = pick('body');
  if (def.required.some((b) => !new RegExp('^\\s*\\{\\{' + b + '\\}\\}\\s*$', 'm').test(bodyRaw))) bodyRaw = def.body;
  const fill = (s) => String(s).replace(/\{(\w{1,20})\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(all, k) ? String(all[k]) : m));
  return {
    // 變數是空的（例如沒有訂單編號）時，「（）」一起拿掉——舊版就是「有編號才加括號」
    subject: fill(pick('subject')).replace(/\{\{\w+\}\}/g, '').replace(/（\s*）|\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim(),
    title: esc(fill(pick('heading')).replace(/\{\{\w+\}\}/g, '').trim()),
    bodyHtml: renderMailBody(bodyRaw, all, site, blocks),
    site,
  };
}

async function publishMailContent(env, content, who, note) {
  const prev = await readMailContent(env);
  let hist = [];
  try { hist = JSON.parse((await env.SUBS.get(MAIL_HISTORY_KEY)) || '[]'); } catch (e) { hist = []; }
  if (prev) hist.unshift(prev);
  hist = hist.slice(0, MAIL_HISTORY_MAX);
  const next = {
    ...content,
    version: ((prev && prev.version) || 0) + 1,
    publishedAt: nowSec(),
    publishedBy: String(who || '').slice(0, 60),
    note: String(note || '').slice(0, 120),
  };
  // 先寫歷史再寫本體：中途失敗最壞是「歷史多一份」（與網站內容相同）
  await env.SUBS.put(MAIL_HISTORY_KEY, JSON.stringify(hist));
  await env.SUBS.put(MAIL_CONTENT_KEY, JSON.stringify(next));
  return next;
}

/**
 * 預覽與樣本：呼叫**真正寄信用的組信函式**（build*Mail），資料是當場捏的假資料，不碰 KV 裡的訂單或帳號。
 * 回傳 { subject, html }。`ov` 是草稿內容（undefined＝用已發布的）。
 */
const MAIL_SAMPLES = {
  welcome: (env, ov) => buildWelcomeMail(env, { email: 'you@example.com' }, ov),
  otp: (env, ov) => buildOtpMail(env, '000000', ov),
  claim: (env, ov) => buildClaimMail(env, '000000', 'you@example.com', ov),
  newdevice: (env, ov) => buildNewDeviceMail(env, 'you@example.com', { device: 'Windows Chrome', place: '台北市，台灣', at: nowSec() }, ov),
  order: (env, ov) => buildLicenseMail(env, 'you@example.com', 'PLSAMPLE0001', mailSampleLic(), { mailOverride: ov }),
  order_nokey: (env, ov) => buildLicenseMail(env, 'you@example.com', '', mailSampleLic(true), { noLicense: true, mailOverride: ov }),
  reissue: (env, ov) => buildLicenseMail(env, 'you@example.com', 'PLSAMPLE0001', mailSampleLic(), { reissued: true, mailOverride: ov }),
  gift: (env, ov) => buildGiftMail(env, { gpName: '阿布達比大獎賽', startsAt: nowSec() + 7 * 86400 }, 'r***@g***.com', ov),
  f1ready: (env, ov) => buildF1ReadyMail(env, 'you@example.com',
    { plan: 'F1TV Premium 共用帳號', starts: nowSec() + 2 * 86400, ends: nowSec() + 5 * 86400, mode: 'shared' }, ov),
};

function mailSampleLic(noKey) {
  const now = nowSec();
  if (noKey) {
    return { orderId: 'SAMPLE-SVCONLY', createdAt: now, paid: PLANS.svc_pro_5d.price,
      items: [{ key: 'svc_pro_5d', qty: 1, unit: PLANS.svc_pro_5d.price }],
      services: [{ key: 'svc_pro_5d', qty: 1, label: '代訂', status: 'pending' }] };
  }
  return { orderId: 'SAMPLE-WEEK', createdAt: now, expiresAt: now + 14 * 86400,
    paid: WEEKEND_PRICE, items: [{ key: 'week', qty: 1, unit: WEEKEND_PRICE }] };
}
