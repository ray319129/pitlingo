#!/usr/bin/env node
/**
 * 已登入時預填 email（legal/login-email.js）。
 *
 * 會默默壞掉的地方：
 *   - 填了值卻沒送 input 事件 → 購買頁「前往付款」停在不能按（看起來像網站壞了）
 *   - 蓋掉使用者已經打的字、或瀏覽器自動填入的信箱
 *   - 沒登入也打 API、401 時把欄位弄亂
 *   - 頁面有沒有真的載入這支腳本（沒載入時一切照舊，不會有人發現）
 *
 * 用法：node tools/check-login-email.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'legal/login-email.js'), 'utf8');

let failed = 0;
const expect = (c, m, d) => { if (c) console.log('✅ ' + m); else { failed++; console.log('❌ ' + m + (d !== undefined ? '：' + JSON.stringify(d) : '')); } };

function makeInput(id, value) {
  const listeners = {};
  const el = {
    id, value: value || '', events: [], after: null,
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent: (ev) => { el.events.push(ev.type); (listeners[ev.type] || []).forEach((f) => f(ev)); return true; },
    insertAdjacentElement: (pos, node) => { el.after = node; node.parentNode = { removeChild: () => { el.after = null; } }; },
    userTypes: (v) => { el.value = v; (listeners.input || []).forEach((f) => f({ type: 'input', isTrusted: true })); },
  };
  return el;
}

async function run({ token, me, status = 200, inputs, beforeResolve }) {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const sb = {
    // 2026-10-02 起憑證在 HttpOnly cookie（JS 讀不到），localStorage 只有「登入過」的提示旗標
    localStorage: { getItem: (k) => (k === 'pitlingo.signedIn' && token ? '1' : null) },
    document: {
      getElementById: (id) => inputs[id] || null,
      createElement: () => ({ className: '', textContent: '' }),
    },
    Event: class { constructor(type) { this.type = type; this.isTrusted = false; } },
    fetch: async (url, init) => {
      calls.push({ url, auth: init && init.headers && init.headers.authorization, cred: init && init.credentials });
      await gate;
      return { ok: status === 200, json: async () => me };
    },
    Promise, JSON, String,
  };
  vm.createContext(sb);
  vm.runInContext(src, sb);
  if (beforeResolve) beforeResolve();
  release();
  await new Promise((r) => setTimeout(r, 10));
  return calls;
}

(async () => {
  const ME = { profile: { email: 'ray@example.com', name: 'Ray' } };

  {
    const inputs = { email: makeInput('email') };
    const calls = await run({ token: 'tok', me: ME, inputs });
    expect(inputs.email.value === 'ray@example.com', '已登入：購買頁 email 預填登入信箱', inputs.email.value);
    expect(inputs.email.events.includes('input'), '預填後送出 input 事件（付款按鈕與升級折抵才會重算）');
    expect(calls.length === 1 && calls[0].cred === 'include' && !calls[0].auth && /\/v1\/account\/me$/.test(calls[0].url), '帶 cookie（credentials: include）呼叫 /v1/account/me，不帶任何權杖', calls);
    expect(inputs.email.after && /可以直接修改/.test(inputs.email.after.textContent), '欄位下方提示「已帶入，可以修改」');
    inputs.email.userTypes('work@company.com');
    expect(inputs.email.value === 'work@company.com' && !inputs.email.after, '使用者改掉之後保留他打的，提示消失');
  }
  {
    const inputs = { contact: makeInput('contact') };
    await run({ token: 'tok', me: ME, inputs });
    expect(inputs.contact.value === 'ray@example.com', '已登入：聯絡頁 email 預填登入信箱');
  }
  {
    const inputs = { email: makeInput('email') };
    const calls = await run({ token: '', me: ME, inputs });
    expect(!calls.length && inputs.email.value === '', '沒登入：不呼叫 API、欄位維持空白');
  }
  {
    const inputs = { email: makeInput('email') };
    await run({ token: 'expired', me: { error: 'unauthorized' }, status: 401, inputs });
    expect(inputs.email.value === '' && !inputs.email.events.length, '工作階段過期（401）：欄位不動');
  }
  {
    const inputs = { email: makeInput('email') };
    await run({ token: 'tok', me: ME, inputs, beforeResolve: () => inputs.email.userTypes('me@x.co') });
    expect(inputs.email.value === 'me@x.co', 'API 回來之前使用者已經開始打字：不覆蓋', inputs.email.value);
  }
  {
    const inputs = { email: makeInput('email', 'autofill@browser.com') };
    await run({ token: 'tok', me: ME, inputs });
    expect(inputs.email.value === 'autofill@browser.com', '瀏覽器已自動填入其他信箱：不覆蓋', inputs.email.value);
  }
  for (const [page, id] of [['buy.html', 'email'], ['contact.html', 'contact']]) {
    const html = fs.readFileSync(path.join(root, 'legal', page), 'utf8');
    expect(/<script src="\/login-email\.js\?v=[0-9a-f]+"><\/script>/.test(html) && html.includes(`id="${id}"`),
      `${page} 有載入 login-email.js，且欄位 #${id} 存在`);
  }

  console.log('');
  if (failed) { console.log(`❌ 預填 email 有 ${failed} 項未通過`); process.exit(1); }
  console.log('✅ 已登入時預填 email，且絕不覆蓋使用者輸入');
})();
