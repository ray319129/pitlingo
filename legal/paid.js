const API = 'https://api.pitlingo.com';
const out = document.getElementById('out');

// 綠界會用 POST 導回來，參數在表單裡；直接開啟時則在 query string。
// 兩種都要能取到訂單編號。
function orderNo() {
  const q = new URLSearchParams(location.search).get('no')
    || new URLSearchParams(location.search).get('MerchantTradeNo');
  return q || sessionStorage.getItem('pl_order') || '';
}

function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(html) {
  out.innerHTML = html;
  // ⚠️ 不能用 inline onclick：網站的 CSP 不允許內嵌事件處理器，按了沒反應（security-audit 2026-10-05）
  const r = document.getElementById('reloadBtn');
  if (r) r.addEventListener('click', () => location.reload());
}

// 綠界失敗時會由 Worker 帶 failed=1 轉回來（見 /v1/payment/result）。
// **失敗一定要給回去的路**——只說「失敗」而把人留在死路上，
// 那筆生意就結束了，而多數失敗（卡片被拒、額度不足）換個方式就能成功。
function failedInfo() {
  const q = new URLSearchParams(location.search);
  if (q.get('failed') !== '1') return null;
  // ⚠️ `msg` 是網址參數——任何人都能做一個 pitlingo.com/paid?failed=1&msg=請匯款到… 的連結
  //    （security-audit 2026-10-05：可以拿來釣魚）。只顯示「看起來像金流回覆」的短訊息：
  //    60 字以內、沒有數字串、網址、@——那些正是詐騙訊息需要的東西。
  const raw = String(q.get('msg') || '').trim();
  const safe = raw.length <= 60 && !/\d{3,}|https?:|www\.|@|\.(com|tw|net|org)/i.test(raw);
  return { msg: safe ? raw : '' };
}

async function check() {
  const fail = failedInfo();
  if (fail) {
    return render(`<h1>付款未完成</h1>
      <p class="lead">這筆交易沒有成功，<b>沒有扣款</b>。</p>
      ${fail.msg ? `<p>銀行或金流回覆：<code>${esc(fail.msg)}</code></p>` : ''}
      <p>常見原因：卡片被發卡行拒絕、額度不足、3D 驗證逾時。
         換一張卡或改用 ATM／超商代碼通常就能完成。</p>
      <p><a class="btn" href="/buy">回到購買頁重試</a></p>
      <p class="hint">若重複失敗，請走
      <a href="/contact">聯絡我們</a>，附上這個時間點，我們幫你查。</p>`);
  }

  const no = orderNo();
  if (!no) {
    return render(`<h1>找不到訂單</h1>
      <p class="lead">請從付款完成的頁面回到這裡，或直接查看你的 email。</p>
      <p>收據會寄到你結帳時填寫的信箱，用那個信箱登入擴充功能就能使用。若沒收到，請來信
      <a href="mailto:pitlingo.office@gmail.com">pitlingo.office@gmail.com</a>。</p>`);
  }
  sessionStorage.setItem('pl_order', no);

  let d;
  try {
    const r = await fetch(`${API}/v1/order?no=${encodeURIComponent(no)}`);
    d = await r.json();
  } catch (e) {
    return render(`<h1>暫時查不到</h1>
      <p class="lead">網路或伺服器暫時有問題，但<b>這不影響你的訂單</b>。</p>
      <p>稍後重新整理，或直接查看 email。訂單編號：<code>${esc(no)}</code></p>`);
  }

  if (d.status === 'paid') {
    // ⚠️ **有些方案不含字幕授權。**
    //    目前只有共用帳號的單一比賽週末代訂會走到這裡。
    //    要明講「這是正常的」，否則買家會以為系統出錯了，然後來問。
    if (d.noLicense) {
      return render(`<h1>付款完成</h1>
        <p class="lead">謝謝你的支持，我們已收到你的訂單。</p>
        <div class="notice">
          <strong>本方案不含字幕翻譯使用權</strong>
          <p>這是正常的，不是系統出錯。若你也需要中文字幕，
             請另外購買<a href="/buy">比賽週通行證</a>。</p>
        </div>
        <h2>接下來</h2>
        <ol class="steps">
          <li>我們會在<b>一個工作天內</b>完成開通，並寄信通知你；帳號與密碼請登入「我的帳號」查看</li>
          <li>開通後<b>僅限網頁端觀看</b>，無法使用 App、電視或遊戲主機</li>
          <li>觀看時<b>需自備 VPN</b>——F1TV 在台灣未提供服務</li>
        </ol>
        <p class="hint">訂單編號：<code>${esc(no)}</code>　·　
           高峰時段共用帳號可能無法進入或被登出，這是共用帳號的固有特性。</p>`);
    }
    // 同一張訂單裡有代訂時，要把代訂的後續講清楚（見後端 handleOrderStatus）
    const svc = Array.isArray(d.services) ? d.services : [];
    const svcBlock = svc.length ? `
      <div class="notice">
        <strong>代訂服務已收款，將於一個工作天內完成</strong>
        <ul class="tight">${svc.map((s) => `<li>${esc(s.label)}${s.qty > 1 ? ` × ${s.qty}` : ''}</li>`).join('')}</ul>
        <p>開通後會寄信到你結帳時填寫的信箱，帳號與密碼請用<b>同一個信箱</b>登入「我的帳號」查看。<b>觀看時仍需自備 VPN</b>——F1TV 在台灣未提供服務。</p>
      </div>` : '';
    // 2026-10-30 起**不顯示授權碼**（後端也不回）：授權綁結帳信箱的帳號，登入就自動啟用。
    //    這一頁只講「買了什麼、何時生效、到什麼時候」。
    //    同一張訂單有兩份時（本賽季＋下一賽季票，見後端 handleOrderStatus 的 extra）一起列。
    const twTime = (sec) => new Date(sec * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const twDate = (sec) => new Date(sec * 1000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
    const passes = [d].concat(Array.isArray(d.extra) ? d.extra : []).filter((x) => x.planLabel);
    const passBlock = passes.length ? `<ul class="tight">${passes.map((x) => `<li><b>${esc(x.planLabel)}</b>`
      + (x.gpName ? `（${esc(x.gpName)}）` : '')
      + (x.startsAt && x.startsAt * 1000 > Date.now() ? `：${esc(twTime(x.startsAt))}（台灣時間）起生效，屆時會自動開通` : '')
      + (x.expiresAt ? `，有效期至 ${esc(twDate(x.expiresAt))}` : '')
      + '</li>').join('')}</ul>` : '';
    return render(`<h1>付款完成</h1>
      <p class="lead">謝謝你的支持，授權已經開通。它綁定<b>結帳時填寫的信箱</b>，不需要輸入任何序號。</p>
      ${passBlock}
      <p class="hint">訂單編號：<code>${esc(no)}</code>　·　收據已寄到你的信箱。</p>
      <h2>接下來</h2>
      <ol class="steps">
        <li>安裝 PitLingo 擴充功能</li>
        <li>點擴充功能圖示 → <b>登入</b>（用結帳時填寫的信箱）→ 授權會自動啟用。<b>已經用這個信箱登入了？</b>點一下擴充功能圖示就會立刻生效</li>
        <li>打開 F1TV 影片，記得在播放器開啟英文字幕（CC）</li>
      </ol>
      <p class="hint">最多可在 3 台裝置同時啟用，可自行解除後轉移。</p>
      ${svcBlock}`);
  }

  if (d.status === 'awaiting_payment') {
    const p = d.payment || {};
    const rows = [
      p.bank && ['銀行代碼', p.bank],
      p.vAccount && ['繳費帳號', p.vAccount],
      p.payNo && ['超商繳費代碼', p.payNo],
      p.expire && ['繳費期限', p.expire],
    ].filter(Boolean);
    return render(`<h1>尚未完成付款</h1>
      <p class="lead">已為你取得繳費資訊。<b>完成繳費後才會開通</b>，通常在款項入帳後幾分鐘內。</p>
      <table class="pay">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>
      <p>同樣的資訊綠界也會寄到你的信箱。訂單編號：<code>${esc(no)}</code></p>
      <p class="hint">繳費完成後回到這頁重新整理，就會看到開通結果。</p>`);
  }

  if (d.status === 'pending') {
    return render(`<h1>處理中</h1>
      <p class="lead">我們還沒收到付款通知。若你剛完成付款，請稍等幾分鐘後重新整理。</p>
      <p>訂單編號：<code>${esc(no)}</code></p>
      <button id="reloadBtn">重新整理</button>`);
  }

  render(`<h1>查無此訂單</h1>
    <p class="lead">訂單編號 <code>${esc(no)}</code> 沒有紀錄。</p>
    <p>若你確實付了款，請來信
    <a href="mailto:pitlingo.office@gmail.com">pitlingo.office@gmail.com</a> 並附上訂單編號，我們會處理。</p>`);
}

check();
