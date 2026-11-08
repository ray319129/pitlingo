#!/usr/bin/env node
/**
 * 產生賽事資料的字面量（貼進 backend/src/parts/02-remote-config.js 的 REMOTE_CONFIG.schedule）。
 *
 * 為什麼要用產生的而不是手打：23 站 × 5 個場次 = 115 個時間戳，
 * 手打一定會錯，而錯了**完全不會報錯**——只會讓某一張通行證的效期不對。
 *
 * ## 資料來源
 *
 * 場次時間抄自 f1calendar.com（以 **Europe/London** 顯示），
 * 衝刺賽站別依 F1 官方公布的 2026 Sprint Calendar 核對過：
 * **中國、邁阿密、加拿大、英國、荷蘭、新加坡**共六站。
 *
 * ⚠️ 這一版**不再有推估值**。先前用「標準時刻表」推估的版本有兩個實際錯誤：
 *    把比利時標成衝刺賽（實際不是），漏掉英國與荷蘭（實際是）。
 *    衝刺賽週的場次組成完全不同，錯了會讓商品卡列出不存在的場次。
 *
 * ⚠️ 時間一律換算成 **UTC 秒**存進資料裡。前端再依使用者的時區顯示——
 *    伺服器猜不到使用者在哪裡，猜錯的後果是他照著錯的時間去等排位賽。
 *
 * ⚠️ `start` / `end` 是**當地日期**，不是倫敦日期。拉斯維加斯的正賽在
 *    當地星期六深夜，換算倫敦已是星期日；兩者差一天是正常的。
 *
 * 用法：node tools/gen-schedule.js > /tmp/schedule.txt
 *       node tools/gen-schedule.js 2027        # 下一季（場次時間還沒填完時會列出缺哪些並停下）
 *
 * ⚠️ 2027 賽程（RAW_2027）：日期與衝刺賽週抄自 F1 官方 2026-09-16 公布的 2027 賽曆
 *    （planetf1、formulaonehistory 兩個來源交叉核對：24 站、10 個衝刺賽週，
 *    義大利 R14 在西班牙 R15 之前）。**場次時間官方還沒公布**，全部是 null——
 *    這支工具在有 null 時拒絕輸出，不會產生推估值（見上面「不再有推估值」）。
 *    卡達與阿布達比在報導裡標「仍有變數」，填資料時再確認一次。
 */

/* 站名 → 國家、國旗、時區、賽道。**只有這一份是人工維護的對照表。** */
const META = {
  澳洲: ['澳洲', '🇦🇺', 'Australia/Melbourne', 'Albert Park'],
  中國: ['中國', '🇨🇳', 'Asia/Shanghai', 'Shanghai'],
  日本: ['日本', '🇯🇵', 'Asia/Tokyo', 'Suzuka'],
  邁阿密: ['美國', '🇺🇸', 'America/New_York', 'Miami'],
  加拿大: ['加拿大', '🇨🇦', 'America/Toronto', 'Gilles Villeneuve'],
  摩納哥: ['摩納哥', '🇲🇨', 'Europe/Monaco', 'Monaco'],
  巴塞隆納: ['西班牙', '🇪🇸', 'Europe/Madrid', 'Barcelona-Catalunya'],
  奧地利: ['奧地利', '🇦🇹', 'Europe/Vienna', 'Red Bull Ring'],
  英國: ['英國', '🇬🇧', 'Europe/London', 'Silverstone'],
  比利時: ['比利時', '🇧🇪', 'Europe/Brussels', 'Spa-Francorchamps'],
  匈牙利: ['匈牙利', '🇭🇺', 'Europe/Budapest', 'Hungaroring'],
  荷蘭: ['荷蘭', '🇳🇱', 'Europe/Amsterdam', 'Zandvoort'],
  義大利: ['義大利', '🇮🇹', 'Europe/Rome', 'Monza'],
  '西班牙（馬德里）': ['西班牙', '🇪🇸', 'Europe/Madrid', 'Madring'],
  亞塞拜然: ['亞塞拜然', '🇦🇿', 'Asia/Baku', 'Baku City'],
  '巴林（馬來西亞 Sepang）': ['馬來西亞', '🇲🇾', 'Asia/Kuala_Lumpur', 'Sepang'],
  新加坡: ['新加坡', '🇸🇬', 'Asia/Singapore', 'Marina Bay'],
  美國: ['美國', '🇺🇸', 'America/Chicago', 'Circuit of the Americas'],
  墨西哥: ['墨西哥', '🇲🇽', 'America/Mexico_City', 'Hermanos Rodríguez'],
  巴西: ['巴西', '🇧🇷', 'America/Sao_Paulo', 'Interlagos'],
  拉斯維加斯: ['美國', '🇺🇸', 'America/Los_Angeles', 'Las Vegas Strip'],
  卡達: ['卡達', '🇶🇦', 'Asia/Qatar', 'Lusail'],
  阿布達比: ['阿拉伯聯合大公國', '🇦🇪', 'Asia/Dubai', 'Yas Marina'],
  // 2027 新增／回歸
  巴林: ['巴林', '🇧🇭', 'Asia/Bahrain', 'Sakhir'],
  沙烏地阿拉伯: ['沙烏地阿拉伯', '🇸🇦', 'Asia/Riyadh', 'Jeddah Corniche'],
  葡萄牙: ['葡萄牙', '🇵🇹', 'Europe/Lisbon', 'Portimão'],
  土耳其: ['土耳其', '🇹🇷', 'Europe/Istanbul', 'Istanbul Park'],
};

const N = ['fp1', 'fp2', 'fp3', 'quali', 'race'];
const S = ['fp1', 'sq', 'sprint', 'quali', 'race'];
const LABEL = {
  fp1: '第一次自由練習', fp2: '第二次自由練習', fp3: '第三次自由練習',
  sq: '衝刺排位賽', sprint: '衝刺賽', quali: '排位賽', race: '正賽',
};
/** 衝刺賽週只有一次自由練習，名稱不同。 */
const LABEL_SPRINT = Object.assign({}, LABEL, { fp1: '唯一自由練習' });

/**
 * 賽程。
 *   [輪次, 站名, 當地開始日, 當地結束日, 衝刺賽?, 場次時間（Europe/London）, 額外旗標]
 * 場次時間的順序固定：一般週末 FP1 FP2 FP3 Q R；衝刺賽週 FP1 SQ Sprint Q R。
 */
const RAW = [
  [1, '澳洲', '2026-03-06', '2026-03-08', false,
    ['03-06 01:30', '03-06 05:00', '03-07 01:30', '03-07 05:00', '03-08 04:00'], {}],
  [2, '中國', '2026-03-13', '2026-03-15', true,
    ['03-13 03:30', '03-13 07:30', '03-14 03:00', '03-14 07:00', '03-15 07:00'], {}],
  [3, '日本', '2026-03-27', '2026-03-29', false,
    ['03-27 02:30', '03-27 06:00', '03-28 02:30', '03-28 06:00', '03-29 06:00'], {}],
  [4, '邁阿密', '2026-05-01', '2026-05-03', true,
    ['05-01 17:00', '05-01 21:30', '05-02 17:00', '05-02 21:00', '05-03 18:00'], {}],
  [5, '加拿大', '2026-05-22', '2026-05-24', true,
    ['05-22 17:30', '05-22 21:30', '05-23 17:00', '05-23 21:00', '05-24 21:00'], {}],
  [6, '摩納哥', '2026-06-05', '2026-06-07', false,
    ['06-05 12:30', '06-05 16:00', '06-06 11:30', '06-06 15:00', '06-07 14:00'], {}],
  [7, '巴塞隆納', '2026-06-12', '2026-06-14', false,
    ['06-12 12:30', '06-12 16:00', '06-13 11:30', '06-13 15:00', '06-14 14:00'], {}],
  [8, '奧地利', '2026-06-26', '2026-06-28', false,
    ['06-26 12:30', '06-26 16:00', '06-27 11:30', '06-27 15:00', '06-28 14:00'], {}],
  [9, '英國', '2026-07-03', '2026-07-05', true,
    ['07-03 12:30', '07-03 16:30', '07-04 12:00', '07-04 16:00', '07-05 15:00'], {}],
  [10, '比利時', '2026-07-17', '2026-07-19', false,
    ['07-17 12:30', '07-17 16:00', '07-18 11:30', '07-18 15:00', '07-19 14:00'], {}],
  [11, '匈牙利', '2026-07-24', '2026-07-26', false,
    ['07-24 12:30', '07-24 16:00', '07-25 11:30', '07-25 15:00', '07-26 14:00'], {}],
  [12, '荷蘭', '2026-08-21', '2026-08-23', true,
    ['08-21 11:30', '08-21 15:30', '08-22 11:00', '08-22 15:00', '08-23 14:00'],
    { afterSummerBreak: true }],
  [13, '義大利', '2026-09-04', '2026-09-06', false,
    ['09-04 11:30', '09-04 15:00', '09-05 11:30', '09-05 15:00', '09-06 14:00'], {}],
  [14, '西班牙（馬德里）', '2026-09-11', '2026-09-13', false,
    ['09-11 12:30', '09-11 16:00', '09-12 11:30', '09-12 15:00', '09-13 14:00'], {}],
  [15, '亞塞拜然', '2026-09-24', '2026-09-26', false,
    ['09-24 09:30', '09-24 13:00', '09-25 09:30', '09-25 13:00', '09-26 12:00'], {}],
  [16, '巴林（馬來西亞 Sepang）', '2026-10-02', '2026-10-04', false,
    ['10-02 05:30', '10-02 09:00', '10-03 05:30', '10-03 09:00', '10-04 08:00'], {}],
  [17, '新加坡', '2026-10-09', '2026-10-11', true,
    ['10-09 09:30', '10-09 13:30', '10-10 10:00', '10-10 14:00', '10-11 13:00'], {}],
  [18, '美國', '2026-10-23', '2026-10-25', false,
    ['10-23 18:30', '10-23 22:00', '10-24 18:30', '10-24 22:00', '10-25 20:00'], {}],
  [19, '墨西哥', '2026-10-30', '2026-11-01', false,
    ['10-30 18:30', '10-30 22:00', '10-31 17:30', '10-31 21:00', '11-01 20:00'], {}],
  [20, '巴西', '2026-11-06', '2026-11-08', false,
    ['11-06 15:30', '11-06 19:00', '11-07 14:30', '11-07 18:00', '11-08 17:00'], {}],
  [21, '拉斯維加斯', '2026-11-19', '2026-11-21', false,
    ['11-20 00:30', '11-20 04:00', '11-21 00:30', '11-21 04:00', '11-22 04:00'], {}],
  [22, '卡達', '2026-11-27', '2026-11-29', false,
    ['11-27 13:30', '11-27 17:00', '11-28 14:30', '11-28 18:00', '11-29 16:00'],
    {}],   // 2026-10-02：F1 已確認照常舉行，拿掉 tentative
  [23, '阿布達比', '2026-12-04', '2026-12-06', false,
    ['12-04 09:30', '12-04 13:00', '12-05 10:30', '12-05 14:00', '12-06 13:00'],
    {}],   // 2026-10-02：F1 已確認照常舉行，拿掉 tentative
];

/**
 * 2027 賽季（官方 2026-09-16 公布）。場次時間（Europe/London）官方公布後填進第 6 欄。
 * 衝刺賽週：巴林、澳洲、日本、加拿大、摩納哥、英國、義大利、巴西、卡達、阿布達比。
 */
const RAW_2027 = [
  [1, '巴林', '2027-03-12', '2027-03-14', true, null, {}],
  [2, '沙烏地阿拉伯', '2027-03-19', '2027-03-21', false, null, {}],
  [3, '澳洲', '2027-04-02', '2027-04-04', true, null, {}],
  [4, '日本', '2027-04-09', '2027-04-11', true, null, {}],
  [5, '中國', '2027-04-16', '2027-04-18', false, null, {}],
  [6, '邁阿密', '2027-04-30', '2027-05-02', false, null, {}],
  [7, '加拿大', '2027-05-21', '2027-05-23', true, null, {}],
  [8, '摩納哥', '2027-06-04', '2027-06-06', true, null, {}],
  [9, '葡萄牙', '2027-06-18', '2027-06-20', false, null, {}],
  [10, '英國', '2027-07-02', '2027-07-04', true, null, {}],
  [11, '奧地利', '2027-07-09', '2027-07-11', false, null, {}],
  [12, '比利時', '2027-07-23', '2027-07-25', false, null, {}],
  [13, '匈牙利', '2027-07-30', '2027-08-01', false, null, {}],
  [14, '義大利', '2027-09-03', '2027-09-05', true, null, { afterSummerBreak: true }],
  [15, '西班牙（馬德里）', '2027-09-10', '2027-09-12', false, null, {}],
  [16, '亞塞拜然', '2027-09-24', '2027-09-26', false, null, {}],
  [17, '土耳其', '2027-10-01', '2027-10-03', false, null, {}],
  [18, '新加坡', '2027-10-08', '2027-10-10', false, null, {}],
  [19, '美國', '2027-10-22', '2027-10-24', false, null, {}],
  [20, '墨西哥', '2027-10-29', '2027-10-31', false, null, {}],
  [21, '巴西', '2027-11-05', '2027-11-07', true, null, {}],
  // 2026-10-30 對 formula1.com/en/racing/2027：官方是 11/18～20（週四～週六），原本抄成 19～21
  [22, '拉斯維加斯', '2027-11-18', '2027-11-20', false, null, {}],
  [23, '卡達', '2027-12-03', '2027-12-05', true, null, {}],
  [24, '阿布達比', '2027-12-10', '2027-12-12', true, null, {}],
];

/**
 * 季前測試（2026-10-30 Ray：「季前測試要像正賽一樣賣」）。放進賽程當第 0 輪（testing: true）：
 * 購買頁多一張「季前測試通行證」、效期到開幕站比賽週開始前、不算進「本季還剩幾站」、
 * 重播月票截在它開始之前。日期：formula1.com/en/racing/2027（巴林 2/24～27）。
 * days：每一天第一節的開始時間（Europe/London），官方公布後填；一天的轉播約 9.5 小時（len）。
 */
const TESTING_2027 = { name: '巴林', label: '2027 季前測試（巴林）', start: '2027-02-24', end: '2027-02-27', days: null };

/** F1TV 網址裡的站名關鍵字（收割覆蓋率、自動開直播用）。2026 那份是後來手補進 REMOTE_CONFIG 的，產生器以前不輸出。 */
const SLUGS = {
  澳洲: ['australia', 'australian', 'melbourne', 'albert-park'],
  中國: ['china', 'chinese', 'shanghai'],
  日本: ['japan', 'japanese', 'suzuka'],
  邁阿密: ['miami'],
  加拿大: ['canada', 'canadian', 'montreal', 'gilles-villeneuve'],
  摩納哥: ['monaco'],
  巴塞隆納: ['barcelona', 'catalunya'],
  奧地利: ['austria', 'austrian', 'spielberg', 'red-bull-ring'],
  英國: ['britain', 'british', 'great-britain', 'silverstone'],
  比利時: ['belgium', 'belgian', 'spa', 'spa-francorchamps'],
  匈牙利: ['hungary', 'hungarian', 'hungaroring', 'budapest'],
  荷蘭: ['dutch', 'netherlands', 'zandvoort'],
  義大利: ['italy', 'italian', 'monza'],
  '西班牙（馬德里）': ['madrid', 'madring', 'spain', 'spanish'],
  亞塞拜然: ['azerbaijan', 'baku'],
  '巴林（馬來西亞 Sepang）': ['bahrain', 'sakhir', 'sepang', 'malaysia', 'malaysian'],
  新加坡: ['singapore', 'marina-bay'],
  美國: ['united-states', 'austin', 'americas', 'cota'],
  墨西哥: ['mexico', 'mexican', 'mexico-city'],
  巴西: ['brazil', 'brazilian', 'sao-paulo', 'interlagos'],
  拉斯維加斯: ['las-vegas', 'vegas'],
  卡達: ['qatar', 'lusail'],
  阿布達比: ['abu-dhabi', 'yas-marina'],
  巴林: ['bahrain', 'sakhir'],
  沙烏地阿拉伯: ['saudi-arabia', 'saudi-arabian', 'jeddah'],
  葡萄牙: ['portugal', 'portuguese', 'portimao', 'algarve'],
  土耳其: ['turkey', 'turkish', 'turkiye', 'istanbul'],
};

const WANT = process.argv[2] === '2027' ? 2027 : 2026;
const SRC = WANT === 2027 ? RAW_2027 : RAW;
const TESTING = WANT === 2027 ? TESTING_2027 : null;
{
  const missing = SRC.filter((x) => !Array.isArray(x[5])).map((x) => `R${x[0]} ${x[1]}`);
  if (TESTING && !Array.isArray(TESTING.days)) missing.unshift('季前測試');
  if (missing.length) {
    console.error(`${WANT} 賽季還有 ${missing.length} 站沒有場次時間（官方公布後填進 RAW_${WANT} 第 6 欄）：
  ${missing.join('、')}`);
    console.error('不輸出——推估的場次時間會讓通行證的生效時間算錯（見檔頭）。');
    process.exit(1);
  }
}

/** 某個時區在某個瞬間的 UTC 偏移（分鐘）。用 Intl 反推，不引任何套件。 */
function offsetMinutes(tz, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour % 24), +p.minute, +p.second);
  return (asUtc - utcMs) / 60000;
}

/**
 * 倫敦時間 → UTC 秒。
 * **要迭代**，因為偏移本身取決於瞬間（英國夏令時間 BST 是 UTC+1，冬天 GMT 是 UTC+0）。
 */
function londonToUtcSec(md, hhmm) {
  const [M, D] = md.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  // ⚠️ 年份以前寫死 2026——拿來產生 2027 的資料，夏令時間的切換日會算錯一小時
  let guess = Date.UTC(WANT, M - 1, D, h, mi);
  for (let i = 0; i < 3; i++) {
    const off = offsetMinutes('Europe/London', guess);
    const next = Date.UTC(WANT, M - 1, D, h, mi) - off * 60000;
    if (next === guess) break;
    guess = next;
  }
  return Math.floor(guess / 1000);
}

const out = SRC.map(([r, name, start, end, sprint, times, extra]) => {
  const [country, flag, tz, circuit] = META[name];
  const kinds = sprint ? S : N;
  const labels = sprint ? LABEL_SPRINT : LABEL;
  if (times.length !== kinds.length) {
    throw new Error(`${name} 的場次數量不對：${times.length} vs ${kinds.length}`);
  }
  const sessions = kinds.map((k, i) => {
    const [md, hhmm] = times[i].split(' ');
    return { k, n: labels[k], t: londonToUtcSec(md, hhmm) };
  });
  // 場次時間必須遞增。抄錯順序完全不會報錯，只會讓「第一場賽事」算錯，
  // 而那直接決定通行證的生效與失效時間。
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i].t <= sessions[i - 1].t) {
      throw new Error(`${name} 的場次時間沒有遞增：${sessions[i - 1].n} → ${sessions[i].n}`);
    }
  }

  if (!SLUGS[name]) throw new Error(`${name} 沒有 slugs（加進 SLUGS）`);
  const bits = [
    `r: ${r}`,
    `name: '${name}'`,
    `label: '${name}大獎賽'`,
    `country: '${country}'`,
    `flag: '${flag}'`,
    `circuit: '${circuit}'`,
    `slugs: [${SLUGS[name].map((x) => `'${x}'`).join(', ')}]`,
    `tz: '${tz}'`,
    `start: '${start}'`,
    `end: '${end}'`,
  ];
  if (sprint) bits.push('sprint: true');
  if (extra.tentative) bits.push('tentative: true');
  if (extra.afterSummerBreak) bits.push('afterSummerBreak: true');
  bits.push('sessions: [' + sessions.map((s) => `{ k: '${s.k}', n: '${s.n}', t: ${s.t} }`).join(', ') + ']');
  return '    { ' + bits.join(', ') + ' },';
});

// 季前測試排在最前面（第 0 輪）
if (TESTING) {
  const [country, flag, tz, circuit] = META[TESTING.name];
  const sessions = TESTING.days.map((x, i) => {
    const [md, hhmm] = x.split(' ');
    return `{ k: 'td${i + 1}', n: '季前測試第 ${i + 1} 天', t: ${londonToUtcSec(md, hhmm)}, len: 34200 }`;
  });
  out.unshift('    { ' + [
    'r: 0', 'testing: true', `name: '${TESTING.name}季前測試'`, `label: '${TESTING.label}'`, `country: '${country}'`,
    `flag: '${flag}'`, `circuit: '${circuit}'`, "slugs: ['pre-season-testing']", `tz: '${tz}'`,
    `start: '${TESTING.start}'`, `end: '${TESTING.end}'`, 'sessions: [' + sessions.join(', ') + ']',
  ].join(', ') + ' },');
}

console.log('  schedule: [');
console.log(out.join('\n'));
console.log('  ],');
