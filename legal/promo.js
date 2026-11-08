/**
 * 限時活動的三個顯示位置（2026-10-26 Ray 決定，BUSINESS.md 第 0 節）
 *
 *   ① 頁首上方的公告列（全站）：活動名稱、文字、一直倒數、「查看方案」、✕
 *   ② 首頁主視覺：「查看方案」旁邊一個「限時 N 折」標籤
 *   ③ 首頁價格區：通行證卡片多一行活動價
 *
 * ⚠️ **這裡只負責顯示。** 價格一律由後端算（/v1/plans 的 promoPrice、/v1/quote），
 *    畫面上的數字錯了也不會收錯錢——但仍然要對，不對就是糾紛。
 * ⚠️ 沒有活動時什麼都不做，網站跟平常完全一樣。
 * ⚠️ 倒數到 0 就自己收起來：/v1/plans 有 60 秒公開快取，不能等下一次讀取。
 * ⚠️ 按 ✕ 只記「這一檔活動」（id）。換一檔新活動會再出現一次。
 * ⑤ 本賽季免費體驗（2026-11-03 Ray：「這個賽季就不賣了，改讓現在知道的人都能免費用到賽季結束」）：
 *    /v1/plans 有 freeSeason 時公告列報它（主推），早鳥縮成同一條裡的第二個連結；活動到期後端就不給，
 *    前端也用 until 自己收。優先順序：限時活動 ＞ 本賽季免費 ＞ 早鳥。
 *    活動期間全站主要按鈕「免費試用 15 分鐘」換成「免費看完本季」、#try 的標題換成「登入就免費看完本季」
 *    （2026-11-03 Ray：「按鈕先換」）。**換回不靠人記得**：後端過了 seasonFinishSec 就不給 freeSeason，
 *    這裡就什麼都不換，HTML 原本的字照舊。只換「字完全等於預設值」的元素——後台改過的字不碰。
 * ④ 早鳥公告（2026-11-03 Ray：「早鳥優惠也要做公告」）：沒有限時活動時，公告列改報早鳥——
 *    數字全部讀 /v1/plans 的 season_early（剩幾組、截止），售完／截止／鎖住時後端就不給或 locked，
 *    公告自己就不出現，不必到後台開關。限時活動優先（同一時間只放一條公告列）。
 * ⚠️ 預覽（?promo=preview&theme=gold）只在本機開發網址有效——
 *    正式網站上用網址就能叫出一個假的特價，等於讓任何人截圖造謠。
 */
(function () {
  'use strict';
  const API = 'https://api.pitlingo.com';
  const CLOSED = 'pl_promo_closed';
  const LABEL = { week: '比賽週通行證', season: '本季通行證', season_next: '下一季通行證' };

  const pctText = (pct) => (pct % 10 === 0 ? String(pct / 10) : String(pct)) + ' 折';
  const money = (n) => 'NT$' + Number(n || 0).toLocaleString('zh-TW');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 無痕模式 */ } },
  };

  function isLocal() {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || /\.(localhost|test)$/.test(location.hostname);
  }

  /** 本機預覽用的假活動（只在 isLocal 時）。 */
  function previewData() {
    const q = new URLSearchParams(location.search);
    if (!isLocal() || q.get('promo') !== 'preview') return null;
    const now = Math.floor(Date.now() / 1000);
    const pct = Number(q.get('pct')) || 90;
    return {
      promo: {
        id: 'preview', name: '夏休特價', text: '', pct, keys: ['week', 'season', 'season_next'],
        from: now - 3600, until: now + 3 * 86400 + 4 * 3600 + 12 * 60 + 9,
        theme: q.get('theme') === 'red' ? 'red' : 'gold',
      },
      plans: [{ key: 'season', price: 299, promoPrice: Math.floor(299 * pct / 100) },
        { key: 'season_next', price: 599, locked: null }],
      races: [{ price: 49, promoPrice: Math.floor(49 * pct / 100), purchasable: true }],
      renewPct: 90,
      preview: true,
    };
  }

  function left(until) {
    const s = Math.max(0, Math.floor(until - Date.now() / 1000));
    const d = Math.floor(s / 86400);
    const z = (n) => String(n).padStart(2, '0');
    const hms = z(Math.floor(s % 86400 / 3600)) + ':' + z(Math.floor(s % 3600 / 60)) + ':' + z(s % 60);
    return { s, text: (d ? d + ' 天 ' : '') + hms };
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ① 公告列 ---------------------------------------------------------------
  function bar(p) {
    if (store.get(CLOSED) === p.id) return null;
    const b = el('div', 'promo-bar promo-' + p.theme);
    b.setAttribute('role', 'region');
    b.setAttribute('aria-label', '限時活動');
    const auto = p.keys.map((k) => LABEL[k]).filter(Boolean).join('、') + '限時 ' + pctText(p.pct);
    const msg = el('span', 'promo-msg');
    // 手機上只放短句（「通行證限時 9 折」），否則公告列會折成三行、吃掉半個首屏
    msg.append(el('b', 'promo-name', p.name), el('span', 'promo-long', ' ' + (p.text || auto)),
      el('span', 'promo-short', ' 通行證限時 ' + pctText(p.pct)));
    const cd = el('span', 'promo-cd');
    // ⚠️ 倒數每秒變，螢幕閱讀器不可以每秒念一次——aria-hidden，結束時間另外給
    cd.setAttribute('aria-hidden', 'true');
    const end = new Date(p.until * 1000);
    const sr = el('span', 'sr-only', '，活動至 ' + (end.getMonth() + 1) + '/' + end.getDate() + ' '
      + String(end.getHours()).padStart(2, '0') + ':' + String(end.getMinutes()).padStart(2, '0') + ' 結束');
    const go = el('a', 'promo-go', '查看方案 →');
    go.href = '/buy';
    const x = el('button', 'promo-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', '關閉活動公告');
    x.onclick = () => { store.set(CLOSED, p.id); remove(b); };
    b.append(msg, sr, cd, go, x);
    return { node: b, cd };
  }

  // ④ 早鳥公告列 -------------------------------------------------------------
  // 只在「現在買得到」時出現：有卡片、沒有鎖、還有剩。結帳中佔掉的名額不算剩（跟購買頁同一個數字）
  function earlyBar(d) {
    const e = (d.plans || []).find((x) => x.key === 'season_early');
    if (!e || e.locked || !(e.remaining > 0)) return null;
    const id = 'early-' + (String(e.label || '').match(/\d{4}/) || [''])[0];
    if (store.get(CLOSED) === id) return null;
    const year = id.slice(6);
    const b = el('div', 'promo-bar promo-gold');
    b.setAttribute('role', 'region');
    b.setAttribute('aria-label', '早鳥優惠');
    const end = e.deadline ? new Date(e.deadline * 1000) : null;
    const when = end ? '，' + (end.getMonth() + 1) + '/' + end.getDate() + ' 截止' : '';
    const msg = el('span', 'promo-msg');
    msg.append(el('b', 'promo-name', year + ' 賽季早鳥'),
      el('span', 'promo-long', ' 整季通行證 ' + money(e.price) + '，限量 ' + e.limit + ' 組、剩 ' + e.remaining + ' 組' + when + '，售完為止'),
      el('span', 'promo-short', ' ' + money(e.price) + '・剩 ' + e.remaining + ' 組'));
    const go = el('a', 'promo-go', '立即購買 →');
    go.href = '/buy#catSeason';
    const x = el('button', 'promo-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', '關閉早鳥公告');
    x.onclick = () => { store.set(CLOSED, id); remove(b); };
    b.append(msg, go, x);
    return b;
  }

  // ⑤ 本賽季免費體驗公告列 ---------------------------------------------------
  function freeBar(d) {
    const f = d.freeSeason;
    if (!f || !(f.until > Date.now() / 1000)) return null;
    const id = 'free-' + f.year;
    if (store.get(CLOSED) === id) return null;
    const b = el('div', 'promo-bar promo-gold');
    b.setAttribute('role', 'region');
    b.setAttribute('aria-label', '本賽季免費');
    const end = new Date(f.until * 1000);
    const when = (end.getMonth() + 1) + '/' + end.getDate();
    const msg = el('span', 'promo-msg');
    msg.append(el('b', 'promo-name', f.year + ' 賽季免費看'),
      el('span', 'promo-long', ' 剩下的比賽全部免費，登入擴充功能就能用到 ' + when + '（本賽季最後一站結束）'),
      el('span', 'promo-short', ' 登入就能用到 ' + when));
    const go = el('a', 'promo-go', '免費開始 →');
    go.href = '/#try';
    b.append(msg, go);
    // 早鳥還買得到時，同一條放第二個連結（手機上收掉，避免折成兩行）
    const e = (d.plans || []).find((x) => x.key === 'season_early');
    if (e && !e.locked && e.remaining > 0) {
      const eg = el('a', 'promo-go promo-long', (String(e.label || '').match(/\d{4}/) || [''])[0] + ' 早鳥 ' + money(e.price) + '・剩 ' + e.remaining + ' 組 →');
      eg.href = '/buy#catSeason';
      b.append(eg);
    }
    const x = el('button', 'promo-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', '關閉公告');
    x.onclick = () => { store.set(CLOSED, id); remove(b); };
    b.append(x);
    return b;
  }

  // ⑤ 活動期間換主要按鈕的字 ---------------------------------------------------
  const CTA_SWAP = [
    ['a.btn, a.nav-cta', '免費試用 15 分鐘', '免費看完本季'],
    ['[data-edit="trial.title"]', '先免費試用 15 分鐘', '登入就免費看完本季'],
  ];
  function freeCta(d) {
    const f = d.freeSeason;
    if (!f || !(f.until > Date.now() / 1000)) return;
    const run = () => CTA_SWAP.forEach(([sel, from, to]) => {
      document.querySelectorAll(sel).forEach((n) => { if (n.textContent.trim() === from) n.textContent = to; });
    });
    run();
    // site-content.js 最慢 4 秒才套完後台內容（它只覆寫後台有設的鍵）；再跑兩次蓋過去
    setTimeout(run, 1500);
    setTimeout(run, 4500);
  }

  function mount(node) {
    document.body.prepend(node);
    const fit = () => document.documentElement.style.setProperty('--promo-h', node.offsetHeight + 'px');
    document.documentElement.classList.add('has-promo');
    fit();
    window.addEventListener('resize', fit);
  }

  function remove(b) {
    b.remove();
    document.documentElement.classList.remove('has-promo');
    document.documentElement.style.removeProperty('--promo-h');
  }

  // ② 首頁主視覺標籤 -----------------------------------------------------------
  function heroChip(p) {
    const link = document.querySelector('.hero .cta-row a[href="#pricing"]');
    if (!link) return null;
    const c = el('span', 'promo-chip promo-' + p.theme, '限時 ' + pctText(p.pct));
    link.after(c);
    return c;
  }

  // ③ 首頁價格區 ---------------------------------------------------------------
  function priceCards(d) {
    const cards = document.querySelectorAll('#pricing .pcard');
    const out = [];
    const add = (card, text) => {
      if (!card) return;
      const n = el('p', 'ppromo promo-' + d.promo.theme, text);
      const pp = card.querySelector('.pprice');
      (pp || card.firstChild).after(n);
      out.push(n);
    };
    const p = d.promo;
    if (p.keys.includes('week')) {
      const r = (d.races || []).find((x) => x.purchasable && x.promoPrice != null);
      if (r) add(cards[0], '限時 ' + pctText(p.pct) + '　' + money(r.promoPrice) + '（原價 ' + money(r.price) + '）');
    }
    if (p.keys.includes('season')) {
      const s = (d.plans || []).find((x) => x.key === 'season' && x.promoPrice != null);
      if (s) add(cards[1], '限時 ' + pctText(p.pct) + '　本季 ' + money(s.promoPrice) + '（原價 ' + money(s.price) + '）');
    }
    return out;
  }

  /** 老客戶續訂：只在下一季通行證開賣時出現（平常鎖著，說了也買不到）。 */
  function renewHint(d) {
    const n = (d.plans || []).find((x) => x.key === 'season_next' && !x.locked);
    const card = document.querySelectorAll('#pricing .pcard')[1];
    if (!n || !card || !d.renewPct) return;   // 續訂折扣暫停時後端回 null
    const h = el('p', 'prenew', '買過賽季通行證？下一季享老客戶 ' + pctText(d.renewPct || 90) + '（登入後結帳自動套用）');
    card.querySelector('p') ? card.querySelector('p').after(h) : card.append(h);
  }

  function apply(d) {
    if (d.plans) renewHint(d);
    const p = d.promo;
    if (!p || !(p.until > Date.now() / 1000)) {
      const eb = freeBar(d) || earlyBar(d);
      if (eb) mount(eb);
      return;
    }
    const parts = [];
    const b = bar(p);
    if (b) mount(b.node);
    const chip = heroChip(p);
    if (chip) parts.push(chip);
    parts.push(...priceCards(d));

    // ⚠️ 一直倒數（Ray 選 C）。到 0 的那一刻全部收掉，不等伺服器
    const tick = () => {
      const t = left(p.until);
      if (b) b.cd.textContent = '倒數 ' + t.text;
      if (t.s <= 0) {
        clearInterval(timer);
        if (b) remove(b.node);
        parts.forEach((x) => x.remove());
      }
    };
    const timer = setInterval(tick, 1000);
    tick();
  }

  const pv = previewData();
  if (pv) { apply(pv); return; }
  fetch(API + '/v1/plans', { credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d) { apply(d); freeCta(d); } })
    .catch(() => { /* 讀不到就當沒有活動——網站照常 */ });
})();
