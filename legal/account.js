/* PitLingo 帳號頁
 *
 * ⚠️ **這一頁不做任何驗證。** Google 的 ID token 與 email 驗證碼拿到就轉交後端，
 *    驗簽、比對、次數上限、冷卻全部在伺服器。前端能做的檢查，攻擊者也能改掉。
 *
 * ⚠️ **這一頁只回答「我買過什麼」，不負責啟用。** 擴充功能啟用看的是**登入的帳號**
 *    （2026-10-30 起以帳號為準：登入後由伺服器從帳號挑一組能用的，通常不必貼碼）。
 *    授權碼（後端記錄編號）在這一頁只當按鈕的識別，不顯示；認領改用購買信箱（2026-10-30）。
 *
 * ⚠️ 帶 `?link=<配對碼>` 進來時，登入成功後要把工作階段交給那組配對碼——
 *    那是擴充功能在等的東西（見後端 /v1/auth/link）。
 *
 * ⚠️ **登入憑證不在這支程式手上**（2026-10-02 起）。後端把它放在 HttpOnly cookie，
 *    網頁上的 JavaScript 讀不到——以前存在 localStorage，任何一段 XSS 都偷得走。
 *    所以每個請求都帶 `credentials: 'include'`，登入狀態一律問伺服器。
 *    localStorage 只留一個「登入過」的提示旗標（不是憑證），給其他頁決定要不要問伺服器。
 */
(function () {
  'use strict';

  var API = 'https://api.pitlingo.com';
  // 舊版存在 localStorage 的權杖（v1，伺服器已不再接受）。進來就清掉，不留在瀏覽器裡。
  var OLD_TOKEN_KEY = 'pitlingo.session';
  // 「這台瀏覽器登入過」的提示。**不是憑證**：偷到它什麼也做不了，
  // 只是讓購買頁與聯絡頁知道值不值得去問伺服器（不然每個訪客都要多打一次 API）。
  var HINT_KEY = 'pitlingo.signedIn';
  var out = document.getElementById('out');
  var tsKey = '';         // Turnstile site key（後端沒啟用時是空字串）
  var tsWidget = null;    // 這一頁的 Turnstile widget id

  function esc(s) {
    // 單引號也要（security-audit 2026-10-05）：放進單引號屬性時不跳脫就能跳出屬性
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setHint(on) {
    try { on ? localStorage.setItem(HINT_KEY, '1') : localStorage.removeItem(HINT_KEY); } catch (e) { /* 無痕模式 */ }
  }
  try { localStorage.removeItem(OLD_TOKEN_KEY); } catch (e) { /* 無痕模式 */ }

  /** 擴充功能傳過來的一次性配對碼。**只從網址讀，不存起來。** */
  function linkNonce() {
    var m = String(location.search || '').match(/[?&]link=([A-Za-z0-9_-]{20,64})(?:&|$)/);
    return m ? m[1] : '';
  }

  // 只有這兩類端點帶 cookie（後端 SITE_CRED_PATHS 也只對它們開放帶 cookie 的 CORS）。
  var CRED = /^\/v1\/(auth|account)\//;

  function api(path, opts) {
    var o = opts || {};
    // ⚠️ credentials: 'include' 才會帶上 api.pitlingo.com 的登入 cookie。
    //    少了它，登入成功了但下一個請求仍然是「未登入」，而且不會報任何錯。
    // ⚠️ **但只能對帳號與登入端點帶。** 對 /v1/plans 也帶的話，後端沒有對它開放
    //    帶 cookie 的 CORS，瀏覽器會直接擋掉回應——2026-10-02 上線後實測：
    //    帳號頁顯示「連不上伺服器」、Google 登入按鈕整個不見（拿不到 client ID）。
    return fetch(API + path, {
      method: o.method || 'GET', headers: { 'content-type': 'application/json' },
      body: o.body, credentials: CRED.test(path) ? 'include' : 'omit',
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) {
            var e = new Error(d.error || ('HTTP ' + r.status));
            e.status = r.status; e.code = d.code;
            throw e;
          }
          return d;
        });
      });
  }

  function money(n) { return 'NT$' + Number(n || 0).toLocaleString('en-US'); }
  function when(sec) {
    if (!sec) return '—';
    return new Date(sec * 1000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  }
  /** 日期＋時間（裝置的「最後使用」要精確到時分，才認得出是不是自己剛剛用的）。 */
  function whenTime(sec) {
    if (!sec) return '—';
    return new Date(sec * 1000).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  // ---- 未登入 -------------------------------------------------------------
  var otpEmail = '';

  function showLogin(clientId, note) {
    var linking = !!linkNonce();
    var head = linking
      ? '<p class="lead">登入後，輸入瀏覽器右上角 PitLingo 圖示上的 4 碼確認碼，就能把擴充功能連結到你的帳號。</p>'
      : '<p class="lead">登入以查看你買過的方案與購買紀錄。</p>';

    out.innerHTML = (note ? '<p class="acct-bad">' + esc(note) + '</p>' : '')
      + head
      + (clientId ? '<div id="gbtn"></div><p class="acct-muted" style="margin:6px 0 18px">或</p>' : '')
      + '<div class="acct-box">'
      + '<h3>用 Email 收驗證碼</h3>'
      + '<p class="acct-muted">不需要密碼。我們寄一組 6 位數字給你，輸入即可登入。</p>'
      + '<div id="otpStep1">'
      + '<div class="acct-form"><input id="otpEmail" type="email" size="26" placeholder="you@example.com" autocomplete="email">'
      + '<div id="otpTs"></div>'
      + '<button id="otpSend">寄驗證碼</button>'
      // 按「換一個信箱」之後的回頭路：誤點的人不必重寄（重寄還有 60 秒冷卻），輸入到一半的碼也還在
      + '<button id="otpReturn" class="linkish" hidden>← 回到輸入驗證碼（已寄到 <b id="otpReturnTo"></b>）</button></div>'
      + '</div>'
      + '<div id="otpStep2" hidden>'
      + '<p class="acct-muted">驗證碼已寄到 <b id="otpTo"></b>，10 分鐘內有效。</p>'
      + '<div class="acct-form"><input id="otpCode" size="10" maxlength="6" inputmode="numeric" placeholder="6 位數字" autocomplete="one-time-code">'
      + '<button id="otpGo">登入</button>'
      + '<button id="otpBack" class="secondary">換一個信箱</button></div>'
      + '</div>'
      + '<div id="otpMsg" class="acct-muted"></div>'
      + '</div>'
      + '<div class="acct-box">'
      + '<h3>買的時候用的不是這個信箱？</h3>'
      + '<p class="acct-muted">很常見——用公司信箱買、用私人 Google 登入。'
      + '登入後輸入<b>購買時填的信箱</b>、收一組驗證碼，就能把那個信箱的購買併進來。</p>'
      + '</div>'
      + '<p class="acct-muted">授權綁定<b>購買時填寫的信箱</b>：在擴充功能按「登入」，'
      + '登入後帳號裡的授權會自動啟用，不必輸入任何序號。用別的信箱登入的話，先在這裡認領那筆購買。</p>';

    wireOtp();
    if (clientId) mountGoogle(clientId);
    if (tsKey) mountTurnstile();
  }

  /**
   * Cloudflare Turnstile（機器人驗證）。後端有設定時才出現（/v1/plans 的 turnstileSiteKey）。
   * ⚠️ token 是單次的：每送一次「寄驗證碼」就要 reset，否則第二次一定被擋。
   */
  function mountTurnstile() {
    var render = function () {
      if (!window.turnstile || !document.getElementById('otpTs')) return;
      tsWidget = window.turnstile.render('#otpTs', { sitekey: tsKey, action: 'login', theme: 'dark' });
    };
    if (window.turnstile) { render(); return; }
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
  }
  function turnstileToken() {
    try { return (window.turnstile && tsWidget !== null) ? (window.turnstile.getResponse(tsWidget) || '') : ''; } catch (e) { return ''; }
  }
  function turnstileReset() {
    try { if (window.turnstile && tsWidget !== null) window.turnstile.reset(tsWidget); } catch (e) { /* noop */ }
  }

  function mountGoogle(clientId) {
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = function () {
      if (!window.google || !google.accounts || !google.accounts.id) return;
      google.accounts.id.initialize({ client_id: clientId, callback: onCredential });
      google.accounts.id.renderButton(document.getElementById('gbtn'),
        { theme: 'outline', size: 'large', text: 'signin_with', locale: 'zh_TW' });
    };
    // ⚠️ 載不到 Google 不可以讓整頁壞掉——Email 驗證碼那條路仍然要能用。
    s.onerror = function () {
      var g = document.getElementById('gbtn');
      if (g) g.innerHTML = '<span class="acct-muted">Google 登入載入失敗，請改用下方的 Email 驗證碼。</span>';
    };
    document.head.appendChild(s);
  }

  function wireOtp() {
    var msg = document.getElementById('otpMsg');
    var s1 = document.getElementById('otpStep1');
    var s2 = document.getElementById('otpStep2');

    document.getElementById('otpSend').onclick = function () {
      var el = document.getElementById('otpEmail');
      var email = (el.value || '').trim();
      if (!email) { msg.textContent = '請輸入 email。'; return; }
      msg.textContent = '寄送中…';
      api('/v1/auth/email/start', { method: 'POST', body: JSON.stringify({ email: email, turnstile: turnstileToken() }) })
        .then(function () {
          turnstileReset();
          otpEmail = email;
          document.getElementById('otpTo').textContent = email;
          s1.hidden = true; s2.hidden = false;
          msg.innerHTML = '<span class="acct-muted">沒收到？先看垃圾信件匣，一分鐘後可以再要一次。</span>';
          document.getElementById('otpCode').focus();
        })
        .catch(function (e) { turnstileReset(); msg.innerHTML = '<span class="acct-bad">' + esc(e.message) + '</span>'; });
    };

    document.getElementById('otpGo').onclick = function () {
      var code = (document.getElementById('otpCode').value || '').trim();
      if (!/^\d{6}$/.test(code)) { msg.innerHTML = '<span class="acct-bad">請輸入 6 位數字。</span>'; return; }
      msg.textContent = '驗證中…';
      api('/v1/auth/email/verify', {
        method: 'POST', body: JSON.stringify({ email: otpEmail, code: code }),
      }).then(function () {
        setHint(true);
        afterLogin();
      }).catch(function (e) {
        msg.innerHTML = '<span class="acct-bad">' + esc(e.message) + '</span>';
      });
    };

    // ⚠️ 「換一個信箱」不清掉任何東西：信箱欄位帶回剛剛那個、已輸入的碼留著，
    //    並給一顆回頭的按鈕——驗證碼仍然有效，誤點的人回去就能繼續。
    var ret = document.getElementById('otpReturn');
    document.getElementById('otpBack').onclick = function () {
      s2.hidden = true; s1.hidden = false; msg.textContent = '';
      document.getElementById('otpEmail').value = otpEmail;
      document.getElementById('otpReturnTo').textContent = otpEmail;
      ret.hidden = false;
      document.getElementById('otpEmail').focus();
    };
    ret.onclick = function () {
      s1.hidden = true; s2.hidden = false;
      msg.innerHTML = '<span class="acct-muted">沒收到？先看垃圾信件匣，一分鐘後可以再要一次。</span>';
      document.getElementById('otpCode').focus();
    };
  }

  function onCredential(res) {
    out.innerHTML = '<p class="lead">登入中…</p>';
    api('/v1/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential: res && res.credential }),
    }).then(function () {
      setHint(true);
      afterLogin();
    }).catch(function (e) {
      setHint(false);
      boot(e.message || '登入失敗');
    });
  }

  // ---- 登入之後：先處理擴充功能配對，再載入帳號 ---------------------------
  var linkedOk = false;

  // ⚠️ **不自動配對**（security-audit 2026-10-05 #1）。以前帶著 ?link= 進來就直接把登入交出去——
  //    攻擊者自己編一組配對碼、把連結丟給你，就能拿到你的帳號與授權。
  //    現在要輸入**你自己的擴充功能視窗上**顯示的 4 碼確認碼，畫面上也明講別人給的連結不要繼續。
  function afterLogin() { loadMe(); }

  function dropLink() {
    // ⚠️ 配對碼**用過或放棄就從網址拿掉**。它在網址列裡，會被瀏覽器記錄、
    //    也可能被使用者整條複製分享出去。
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* noop */ }
  }

  function linkBox(email) {
    return '<div class="acct-box acct-link"><h3>連結 PitLingo 擴充功能</h3>'
      + '<p>要把擴充功能連結到 <b>' + esc(email) + '</b>，請輸入<b>你自己的擴充功能</b>顯示的 4 碼確認碼——就在瀏覽器右上角 PitLingo 圖示的紅色標籤上（點開圖示也看得到）。</p>'
      + '<p class="acct-bad">⚠️ 如果這個網址或確認碼是別人給你的，請按「不要連結」——'
      + '對方會因此取得你的帳號與授權。我們不會透過訊息、電話或客服向你要確認碼。</p>'
      + '<div class="acct-form"><input id="linkCode" maxlength="6" autocomplete="off" spellcheck="false" placeholder="4 碼確認碼">'
      + '<button id="linkGo">連結</button><button id="linkNo" class="secondary">不要連結</button></div>'
      + '<div id="linkMsg" class="acct-muted"></div></div>';
  }

  function wireLink() {
    var go = document.getElementById('linkGo');
    if (!go) return;
    go.onclick = function () {
      var code = (document.getElementById('linkCode').value || '').trim();
      var msg = document.getElementById('linkMsg');
      if (!code) { msg.innerHTML = '<span class="acct-bad">請輸入確認碼。</span>'; return; }
      go.disabled = true;
      msg.textContent = '連結中…';
      api('/v1/auth/link/claim', { method: 'POST', body: JSON.stringify({ nonce: linkNonce(), code: code }) })
        .then(function () { linkedOk = true; dropLink(); loadMe(); })
        .catch(function (e) {
          go.disabled = false;
          msg.innerHTML = '<span class="acct-bad">' + esc(e.message) + '</span>';
        });
    };
    document.getElementById('linkNo').onclick = function () { dropLink(); loadMe(); };
  }

  function loadMe() {
    out.innerHTML = '<p class="lead">載入中…</p>';
    api('/v1/account/me').then(render).catch(function (e) {
      if (e.status === 401) { setHint(false); boot('登入已過期，請重新登入'); return; }
      out.innerHTML = '<p class="acct-bad">載入失敗：' + esc(e.message) + '</p>';
    });
  }

  function render(d) {
    var p = d.profile || {};
    var s = d.summary || {};
    var html = '';

    if (linkNonce() && !linkedOk) html += linkBox(p.email || '');
    if (linkedOk) {
      html += '<div class="acct-box" style="border-color:#0a7c4a">'
        + '<b class="acct-ok">✓ 已連結你的 PitLingo 擴充功能</b><br>'
        + '<span class="acct-muted">可以關掉這個分頁了。擴充功能會自動接上這個帳號裡的授權（沒有授權時免費額度變成 15 分鐘）。</span>'
        + '</div>';
    }

    html += '<div class="acct-box"><div class="acct-row">'
      + '<div><b>' + esc(p.name || p.email) + '</b><br>'
      + '<span class="acct-muted">' + esc(p.email) + '</span></div>'
      + '<div class="acct-actions"><button id="logout" class="secondary">登出</button>'
      + '<button id="logoutAll" class="secondary" title="包含已連結的擴充功能">登出所有裝置</button></div></div></div>';

    // ⚠️ 2026-10-30 起畫面上不顯示授權碼（授權以帳號為準，碼只是後端的記錄編號）。
    //    l.licenseKey 仍然拿來當按鈕的識別（解除裝置、轉送），只是不印出來。
    html += '<h2>我的授權</h2>';
    if (!(d.licenses || []).length) {
      html += '<div class="acct-box"><p>這個帳號底下還沒有授權。</p>'
        + '<p class="acct-muted">如果你買過但這裡沒有，多半是<b>購買時填的信箱</b>'
        + '和你登入用的信箱不同。在下面「認領其他購買」輸入那個信箱即可。</p></div>';
    } else {
      html += d.licenses.map(function (l, i) {
        // 還沒生效的（下一賽季票）要講哪一天起，不要寫「有效」讓人以為現在就能用
        var st = (l.state === 'active' && l.startsAt && l.startsAt * 1000 > Date.now())
          ? '<span class="acct-muted">' + new Date(l.startsAt * 1000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }) + ' 起生效</span>'
          : l.state === 'active' ? '<span class="acct-ok">有效</span>'
          : l.state === 'expired' ? '<span class="acct-muted">已到期</span>'
            : '<span class="acct-bad">已停用</span>';
        var devs = l.deviceList || [];
        // 每一台都列出來：擁有者要靠「最後使用時間」認出哪一台不是自己的。
        // 解除別台只能在這裡做（2026-10-30 起擴充功能不再提供「只憑授權碼解除」）——登入就證明了是擁有者。
        var devHtml = devs.length
          ? devs.map(function (dv) {
            return '<div class="acct-dev"><span><span class="acct-key">' + esc(dv.id) + '</span>'
              + '<span class="acct-muted">　最後使用 ' + whenTime(dv.lastSeen) + '</span></span>'
              + '<button class="secondary" data-devoff="' + i + '" data-dev="' + esc(dv.id) + '">解除</button></div>';
          }).join('')
          : '<p class="acct-muted">還沒有任何裝置使用這份授權。</p>';
        return '<div class="acct-box acct-lic">'
          + '<div class="acct-row"><div>'
          + '<b>' + esc(l.planLabel || l.plan) + '</b>'
          + (l.fromService ? '<span class="acct-muted">（代訂附贈）</span>' : '')
          + (l.gpName ? '<br><span class="acct-muted">' + esc(l.gpName) + '</span>' : '')
          + (l.orderId ? '<br><span class="acct-muted">訂單 ' + esc(l.orderId) + '</span>' : '')
          + '</div><div style="text-align:right">' + st
          + '<br><span class="acct-muted">有效至 ' + when(l.expiresAt)
          + '　·　已啟用 ' + (l.devices || 0) + ' 台</span></div></div>'
          + (l.state === 'active' || l.state === 'expired'
            ? '<details class="acct-more"><summary>管理裝置</summary>' + devHtml
              + '<p class="acct-muted">看到不認得的裝置：先按「解除」，再按上方的「登出所有裝置」並變更信箱密碼。</p>'
              + '</details>'
            : '')
          // 附贈的比賽週可以送給朋友（#19；後端 GIFT_TRANSFER 沒開時 giftable 一律是空的，這段不會出現）
          + ((l.giftable || []).length
            ? '<details class="acct-more"><summary>把附贈的比賽週送給朋友</summary>'
              + '<p class="acct-muted">還沒開始的附贈比賽週可以轉給朋友：那一站會從這組授權拿掉，'
              + '變成<b>綁朋友信箱</b>的授權，朋友用那個信箱登入擴充功能就能使用。每一站只能轉一次，轉出去就不能收回。</p>'
              + l.giftable.map(function (g) {
                return '<div class="acct-dev"><span>' + esc(g.label) + '<span class="acct-muted">　' + when(g.from) + ' 起</span></span>'
                  + '<button class="secondary" data-gift="' + i + '" data-gp="' + esc(g.gpId) + '" data-gplabel="' + esc(g.label) + '">送給朋友</button></div>';
              }).join('')
              + '</details>'
            : '')
          + ((l.giftedOut || []).length
            ? '<p class="acct-muted">已轉送：' + l.giftedOut.map(function (x) { return esc(x.gpId) + ' → ' + esc(x.to); }).join('、') + '</p>'
            : '')
          + '<div class="acct-licmsg acct-muted" data-msg="' + i + '"></div>'
          + '</div>';
      }).join('')
        + '<p class="acct-muted">使用方式：擴充功能圖示 → 「登入」（用這個帳號）→ 授權自動啟用。'
        + '授權綁定這個帳號，最多 3 台裝置，可自行解除後轉移。</p>';
    }

    // F1TV 代訂（RESELL-OPS 3.2）：密碼只在這裡、只在按「顯示」時向伺服器要（每次都有紀錄），
    // 不放進頁面初始資料、不存任何地方。共用帳號週五 00:00（台灣）前伺服器連登入信箱都不給。
    var f1 = d.f1 || [];
    if (f1.length) {
      html += '<h2>F1TV 代訂帳號</h2>';
      html += f1.map(function (x) {
        var head = '<b>' + esc(x.planLabel) + '</b>' + (x.gpLabel ? '<span class="acct-muted">・' + esc(x.gpLabel) + '</span>' : '');
        var span = x.startsAt ? '<span class="acct-muted">使用期間 ' + whenTime(x.startsAt) + ' ～ ' + whenTime(x.endsAt) + '（台灣時間）</span>' : '';
        var body;
        if (x.state === 'pending') {
          body = '<p class="acct-muted">處理中，完成後會寄信通知你（一個工作天內）。</p>';
        } else if (x.state === 'scheduled') {
          body = '<p>帳號已準備好，將於 <b>' + whenTime(x.startsAt) + '</b>（台灣時間）起顯示在這裡。</p>';
        } else if (x.state === 'ended') {
          body = '<p class="acct-muted">使用期間已結束。</p>';
        } else if (x.mode === 'byo') {
          body = '<p class="acct-ok">已開通到你自己的 F1TV 帳號。</p>';
        } else {
          body = '<div class="acct-dev"><span>登入信箱　<span class="acct-key">' + esc(x.loginEmail || '') + '</span></span></div>'
            + '<div class="acct-dev"><span>密碼　<span class="acct-key" data-f1pw="' + esc(x.id) + '">••••••••</span></span>'
            + (x.canReveal ? '<button class="secondary" data-f1show="' + esc(x.id) + '">顯示密碼</button>' : '') + '</div>'
            + '<p class="acct-muted"><b>請勿更改這個 F1TV 帳號的密碼、登入信箱或訂閱設定</b>，否則會被收回使用權（剩餘期間不退費）。'
            + '觀看 F1TV 需自行準備 VPN。</p>';
        }
        return '<div class="acct-box"><div class="acct-row"><div>' + head + '<br>' + span + '</div></div>' + body
          + '<div class="acct-licmsg acct-muted" data-f1msg="' + esc(x.id) + '"></div></div>';
      }).join('');
    }

    // 只列付款成功的。結帳當下就會建立訂單（帳號模型的契約），所以按了結帳又沒付的
    // 也在 purchases 裡——對客戶來說那不是「購買」，列出來只會讓人以為被扣款。
    // （後台的帳號視圖照樣看得到全部，排查用。）
    // 已退款的也列（標「已退款」）：客人要看得到「那筆錢退回來了」，不然會以為還被收著
    var paidList = (d.purchases || []).filter(function (o) { return o.status === 'paid' || o.status === 'refunded'; });
    html += '<h2>購買紀錄</h2>';
    if (!paidList.length) {
      html += '<div class="acct-box"><p class="acct-muted">還沒有購買紀錄。</p></div>';
    } else {
      html += '<div class="acct-box">' + paidList.map(function (o) {
        return '<div class="acct-row"><div>' + esc(o.summary || o.no) + '<br>'
          + '<span class="acct-muted">' + esc(o.no) + '　' + when(o.at) + '</span></div>'
          + '<div style="text-align:right">' + money(o.price) + '<br>'
          + '<span class="acct-muted">' + (o.status === 'refunded' ? '已退款' : '已付款') + '</span></div></div>';
      }).join('') + '</div>'
        + '<p class="acct-muted">累計消費 ' + money(s.lifetimeTwd)
        + '　·　已付款 ' + (s.paidOrders || 0) + ' 筆</p>';
    }

    html += '<h2>認領其他購買</h2><div class="acct-box">'
      + '<p class="acct-muted">用<b>公司信箱</b>買、用私人信箱登入？'
      + '輸入<b>購買時填的信箱</b>，再輸入我們寄到那個信箱的驗證碼，就能把那個信箱的購買併進這個帳號。</p>'
      + '<div id="claimStep1"><div class="acct-form"><input id="claimEmail" type="email" size="26" placeholder="購買時填的信箱" autocomplete="email">'
      + '<button id="claimGo">寄驗證碼</button></div></div>'
      // 第二步：驗證碼寄到**購買信箱**（不是登入的這個信箱）——收得到那個信箱的信才證明那些購買是你的。
      // ⚠️ 伺服器對「有沒有購買紀錄」一律回同一句話（不當成查詢別人買過沒有的探針），畫面也照講。
      + '<div id="claimStep2" hidden>'
      + '<p class="acct-muted">如果 <b id="claimTo"></b> 有購買紀錄，我們已寄出一組驗證碼，10 分鐘內有效。</p>'
      + '<div class="acct-form"><input id="claimCode" size="10" maxlength="6" inputmode="numeric" placeholder="6 位數字" autocomplete="one-time-code">'
      + '<button id="claimVerify">確認認領</button>'
      + '<button id="claimBack" class="secondary">換一個信箱</button></div></div>'
      + '<div id="claimMsg" class="acct-muted"></div>';
    if ((d.emails || []).length > 1) {
      html += '<p class="acct-muted">已併入的信箱：' + d.emails.map(esc).join('、') + '</p>';
    }
    html += '</div>';

    out.innerHTML = html;
    wireLink();

    Array.prototype.forEach.call(out.querySelectorAll('[data-f1show]'), function (b) {
      b.onclick = function () {
        var id = Number(b.getAttribute('data-f1show'));
        var pwEl = out.querySelector('[data-f1pw="' + id + '"]');
        var msg = out.querySelector('[data-f1msg="' + id + '"]');
        if (b.getAttribute('data-shown') === '1') {
          pwEl.textContent = '••••••••'; b.textContent = '顯示密碼'; b.removeAttribute('data-shown'); return;
        }
        b.disabled = true;
        api('/v1/account/f1/reveal', { method: 'POST', body: JSON.stringify({ id: id }) }).then(function (r) {
          pwEl.textContent = r.password;
          b.textContent = '隱藏'; b.setAttribute('data-shown', '1');
          if (msg) msg.textContent = '';
        }).catch(function (e) {
          if (msg) msg.textContent = '無法顯示：' + e.message;
        }).then(function () { b.disabled = false; });
      };
    });

    // ⚠️ 登出要請**伺服器**作廢這一枚（不是只清掉本機）——偷到的 cookie 才會跟著失效。
    //    「登出所有裝置」連擴充功能那一枚與其他瀏覽器的一起作廢（覺得帳號被別人用了時按這個）。
    function logout(all) {
      linkedOk = false;
      setHint(false);
      try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) { /* noop */ }
      api('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ all: !!all }) })
        .catch(function () { /* 連不上也要回到登入畫面；cookie 由伺服器清 */ })
        .then(function () { boot(all ? '已登出所有裝置' : ''); });
    }
    document.getElementById('logout').onclick = function () { logout(false); };
    document.getElementById('logoutAll').onclick = function () {
      if (confirm('登出所有裝置？\n\n這台電腦、其他瀏覽器，以及已連結的擴充功能都會被登出；'
        + '擴充功能上的授權也會立刻停止，要用的裝置重新登入就會恢復。\n\n'
        + '覺得有人用了你的帳號時按這個，並記得變更信箱密碼。')) logout(true);
    };
    // ---- 認領：購買信箱 → 寄到那個信箱的驗證碼 → 併入 ----
    var claiming = '';
    var cMsg = document.getElementById('claimMsg');
    var c1 = document.getElementById('claimStep1');
    var c2 = document.getElementById('claimStep2');
    var claimDone = function (r) {
      cMsg.innerHTML = r.already
        ? '<span class="acct-ok">這筆本來就已經在你的帳號裡了。</span>'
        : '<span class="acct-ok">已認領 ' + esc(r.email) + '，正在重新載入…</span>';
      setTimeout(loadMe, 700);
    };
    document.getElementById('claimGo').onclick = function () {
      var mail = (document.getElementById('claimEmail').value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { cMsg.innerHTML = '<span class="acct-bad">請輸入購買時填的信箱。</span>'; return; }
      cMsg.textContent = '確認中…';
      api('/v1/account/claim', {
        method: 'POST', body: JSON.stringify({ email: mail }),
      }).then(function (r) {
        if (!r.needCode) return claimDone(r);
        claiming = mail;
        document.getElementById('claimTo').textContent = r.to || mail;
        c1.hidden = true; c2.hidden = false;
        cMsg.innerHTML = '<span class="acct-muted">收不到的話：先看垃圾信件匣、確認信箱沒有打錯；'
          + '如果這個信箱曾經直接登入過 PitLingo，它已經是另一個帳號，請改用它登入。'
          + '購買信箱已經不能收信了，請到「聯絡我們」由客服協助。</span>';
        document.getElementById('claimCode').focus();
      }).catch(function (e) {
        cMsg.innerHTML = '<span class="acct-bad">' + esc(e.message) + '</span>';
      });
    };
    document.getElementById('claimVerify').onclick = function () {
      var code = (document.getElementById('claimCode').value || '').trim();
      if (!/^\d{6}$/.test(code)) { cMsg.innerHTML = '<span class="acct-bad">請輸入 6 位數字。</span>'; return; }
      cMsg.textContent = '認領中…';
      api('/v1/account/claim/verify', {
        method: 'POST', body: JSON.stringify({ email: claiming, code: code }),
      }).then(claimDone).catch(function (e) {
        cMsg.innerHTML = '<span class="acct-bad">' + esc(e.message) + '</span>';
      });
    };
    document.getElementById('claimBack').onclick = function () {
      c2.hidden = true; c1.hidden = false; cMsg.textContent = '';
    };

    // ---- 每份授權：解除裝置、轉送附贈 ----
    var lics = d.licenses || [];
    var licMsg = function (i, html) {
      var el = out.querySelector('[data-msg="' + i + '"]');
      if (el) el.innerHTML = html;
    };
    out.querySelectorAll('button[data-devoff]').forEach(function (b) {
      b.onclick = function () {
        var i = Number(b.getAttribute('data-devoff'));
        var l = lics[i];
        if (!l) return;
        if (!confirm('解除裝置 ' + b.getAttribute('data-dev') + '？\n\n那台會立刻停止翻譯（退回免費額度）。'
          + '如果是你自己的裝置，之後在那台的擴充功能登出再登入就會恢復。')) return;
        b.disabled = true;
        api('/v1/account/license/deactivate', {
          method: 'POST', body: JSON.stringify({ licenseKey: l.licenseKey, device: b.getAttribute('data-dev') }),
        }).then(function () {
          licMsg(i, '<span class="acct-ok">已解除，正在重新載入…</span>');
          setTimeout(loadMe, 600);
        }).catch(function (e) {
          b.disabled = false;
          licMsg(i, '<span class="acct-bad">' + esc(e.message) + '</span>');
        });
      };
    });
    out.querySelectorAll('button[data-gift]').forEach(function (b) {
      b.onclick = function () {
        var i = Number(b.getAttribute('data-gift'));
        var l = lics[i];
        if (!l) return;
        var label = b.getAttribute('data-gplabel') || '';
        var to = (prompt('要把「' + label + '」送給誰？請輸入朋友的 email：\n（他要用這個信箱登入 PitLingo 才能使用）') || '').trim();
        if (!to) return;
        if (!confirm('把「' + label + '」送給 ' + to + '？\n\n· 這一站會從你的授權拿掉\n· 轉出去就不能收回')) return;
        b.disabled = true;
        licMsg(i, '轉送中…');
        api('/v1/account/license/gift', {
          method: 'POST', body: JSON.stringify({ licenseKey: l.licenseKey, gpId: b.getAttribute('data-gp'), to: to }),
        }).then(function (r) {
          licMsg(i, '<span class="acct-ok">已送出：' + esc(label) + ' → ' + esc(r.to) + '</span>'
            + (r.mailed ? '<br><span class="acct-muted">已寄信通知對方：用那個信箱登入擴充功能就能使用。</span>' : ''));
          var row = b.closest('.acct-dev');
          if (row) row.remove();
        }).catch(function (e) {
          b.disabled = false;
          licMsg(i, '<span class="acct-bad">' + esc(e.message) + '</span>');
        });
      };
    });
  }

  // ---- 進入點 -------------------------------------------------------------
  function boot(note) {
    // client ID 由後端提供，換 ID 時只要改一個 wrangler var，
    // 不必動這個檔案（動了就要重算資產雜湊）。
    api('/v1/plans').then(function (d) {
      tsKey = d.turnstileSiteKey || '';
      showLogin(d.googleClientId || '', note);
    }).catch(function () {
      showLogin('', note || '連不上伺服器');
    });
  }

  // 登入狀態問伺服器（cookie 讀不到）。帶著配對碼進來時，render 會在最上面放確認碼的輸入框。
  out.innerHTML = '<p class="lead">載入中…</p>';
  api('/v1/account/me').then(function (d) {
    setHint(true);
    render(d);
  }).catch(function (e) {
    if (e.status === 401) setHint(false);
    boot();
  });
})();
