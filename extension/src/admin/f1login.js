/**
 * PitLingo 管理版：F1TV 自動重新登入的「填表單」那一步（A24，2026-10-31）。
 *
 * 只在 id.formula1.com 執行（manifest.admin.json 的 extra_content_scripts；正式版與測試版沒有這支）。
 * 由 harvest.js 的 f1Step 帶過來：它在 F1TV 按了「Sign in」、把 plF1Relogin.stage 設成 'form'，
 * 這裡才動手——平常 Ray 自己打開登入頁，這支什麼都不做。
 *
 * 表單（Ray 2026-10-31 示範，id.formula1.com/as/authorize?...）：Email address、Password、「Sign In」按鈕。
 * ⚠️ 帳號密碼來自這個設定檔的 chrome.storage.local（面板「🔑 F1TV 帳號」），不寫 log、不送出到 F1 以外的地方。
 * ⚠️ 只送一次：送出前就把 stage 改成 'back'；回不到 F1TV（帳密錯、跳驗證）由 harvest.js 的 5 分鐘逾時收尾。
 * ⚠️ 中文登入頁是壞的（A21）：網址帶中文語系就換成英文再載入。
 */
(() => {
  'use strict';
  const KEY = 'plF1Relogin';
  const STEP_MS = 5 * 60000;
  const log = (m) => { try { console.log('%c[PitLingo 自動登入] ' + m, 'color:#0a7c4a'); } catch (e) { /* noop */ } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = (k) => chrome.storage.local.get(k).then((o) => o[k]).catch(() => null);
  const set = (k, v) => chrome.storage.local.set({ [k]: v }).catch(() => {});
  const visible = (el) => !!el && el.offsetParent !== null;

  /**
   * 填欄位。2026-10-31 實測：只用原生 setter＋input／change，畫面上有值，按下去卻回
   * 「There was a problem with your password or email」，Ray 手動再按同一顆就進得去——頁面自己的狀態沒跟上（推論）。
   * 改成 execCommand('insertText')：走瀏覽器的編輯流程，送出與鍵盤輸入相同的 beforeinput／input（inputType: insertText）。
   * 不支援時退回原生 setter
   */
  function fill(el, v) {
    el.focus();
    el.select();
    let done = false;
    try { done = document.execCommand('insertText', false, v) && el.value === v; } catch (e) { done = false; }
    if (!done) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  async function run() {
    const st = await get(KEY);
    // 送出後被拒（頁面重載回登入頁並顯示錯誤）：只送一次，不重送（帳號鎖定風險），面板說明請手動按
    if (st && st.stage === 'back' && Date.now() - (st.at || 0) < STEP_MS
      && /problem with your password or email/i.test(document.body.textContent || '')) {
      log(`自動送出被拒（F1 說帳號或密碼有問題；方式 ${st.method || 'click'}）`);
      await set(KEY, { lastAt: st.lastAt, fail: `自動送出被拒（方式 ${st.method || 'click'}；F1 說帳號或密碼有問題）——欄位已填好，請手動按 Sign In；手動也不行才是帳密錯` });
      return;
    }
    if (!st || st.stage !== 'form' || Date.now() - (st.at || 0) > STEP_MS) return;
    // 中文語系 → 英文（Ray：「登入時的網址得換」）
    const en = location.href
      .replace(/([?&](?:ui_locales|lang|locale|language)=)zh[^&#]*/gi, (m, k) => k + 'en')
      .replace(/\/#\/zh(-[a-z]+)?\//i, () => '/#/en/');
    if (en !== location.href) { log('登入頁是中文語系，換成英文'); location.replace(en); return; }
    const cred = await get('plF1Cred');
    if (!cred || !cred.email || !cred.pw) { await set(KEY, Object.assign({}, st, { stage: '', fail: '沒有存 F1TV 帳號' })); return; }
    // 等表單畫出來（最多 30 秒）
    let email = null, pw = null, btn = null;
    for (let i = 0; i < 30 && !(email && pw && btn); i++) {
      pw = [...document.querySelectorAll('input[type="password"]')].find(visible);
      email = [...document.querySelectorAll('input[type="email"], input[name*="mail" i], input[autocomplete="username"], input[id*="mail" i]')].find(visible)
        || [...document.querySelectorAll('input[type="text"]')].find(visible);
      btn = [...document.querySelectorAll('button, input[type="submit"]')]
        .find((b) => visible(b) && /^\s*(sign in|log in|login)\s*$/i.test(b.textContent || b.value || ''));
      if (!(email && pw && btn)) await sleep(1000);
    }
    if (!(email && pw && btn)) {
      const text = document.body.textContent || '';
      // 中文登入頁是壞的（A21）：2026-10-31 實測網址列是 /as/authorize?…（沒有 zh），內容卻是 …/zh/login.html 的 NoSuchKey
      // ——語系是登入流程依瀏覽器語言選的，改網址救不了，只能把 Chrome 語言的英文排第一
      const zhBroken = /NoSuchKey/.test(text) && /\/zh\//.test(text);
      const challenge = /captcha|verify|verification|robot/i.test(text);
      log('找不到登入表單' + (zhBroken ? '（中文登入頁壞掉）' : challenge ? '（頁面上像是驗證挑戰）' : ''));
      await set(KEY, { lastAt: st.lastAt, fail: zhBroken ? '登入頁是中文版（壞的）：請把這個 Chrome 的語言設定裡英文移到最上面'
        : challenge ? '登入頁出現驗證挑戰' : '找不到登入表單（F1 改版了？）' });
      return;
    }
    // 2026-10-31：直接按按鈕（click）兩種填值方式都被拒（「problem with your password or email」），Ray 手動按 Enter 或按鈕都進得去。
    // 改試：①密碼欄送 Enter 鍵事件（頁面自己聽 keydown 的話會送出）②3 秒內沒換頁 → form.requestSubmit()。
    // 一輪最多送兩次（帳號鎖定風險）；用了哪一種記在 method，被拒時失敗訊息帶出來，才知道哪一種不行
    await set(KEY, Object.assign({}, st, { stage: 'back', at: Date.now(), method: 'enter' }));
    fill(email, cred.email);
    fill(pw, cred.pw);
    await sleep(500);
    log('填好帳號密碼，在密碼欄按 Enter');
    pw.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      pw.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    await sleep(3000);
    const form = pw.form || btn.closest('form');
    if (!form || typeof form.requestSubmit !== 'function') { log('Enter 之後沒有換頁，這一頁沒有 form 可以 requestSubmit'); return; }
    await set(KEY, Object.assign({}, st, { stage: 'back', at: Date.now(), method: 'requestSubmit' }));
    log('Enter 之後 3 秒沒有換頁，改用 requestSubmit');
    try { form.requestSubmit(btn.form === form ? btn : undefined); } catch (e) { log('requestSubmit 失敗：' + e.message); }
  }
  setTimeout(() => run().catch((e) => log('錯誤：' + e.message)), 1500);
})();
