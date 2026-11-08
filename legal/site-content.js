/**
 * 網站內容覆寫 ＋ 模擬畫面輪播
 *
 * HTML 裡的文字是**預設值**：後端掛掉、網路很慢、腳本被擋，頁面照樣完整。
 * 後台發布的內容只覆寫標了 `data-edit` 的元素。
 *
 * ⚠️ **內容一律當純文字。** 只支援 `**粗體**` 與換行，其餘全部跳脫。
 *    後端已經清洗過一次，這裡再做一次——後台權杖外洩的最壞結果
 *    必須是「文字被亂改」，不能是「首頁被植入腳本」。
 *
 * ⚠️ **快取層（坑 #11：傳播延遲是所有快取層的總和）**
 *    後台發布 → 後端邊緣快取最多 30 秒 → 這裡的 localStorage 只當「首次繪製」用、
 *    每次仍會向後端要一次最新的。所以使用者最多晚 30 秒看到新內容。
 *
 * 預覽：網址加 `?preview=1`，讀的是後台存在**這台瀏覽器**的草稿，只有自己看得到。
 */
(function () {
  'use strict';

  var API = 'https://api.pitlingo.com/v1/site';
  var CACHE_KEY = 'pl_site_cache';
  var DRAFT_KEY = 'pl_site_draft';
  var root = document.documentElement;
  var preview = /[?&]preview=1\b/.test(location.search);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** 唯二支援的標記：**粗體** 與換行。 */
  function rich(t) {
    return esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  }
  /** 與後端 siteHrefOk 同一份規則。 */
  function hrefOk(h) {
    var s = String(h || '').trim();
    if (!s || s.length > 300) return false;
    if (/^\/(?![/\\])[^\s"'<>\\]*$/.test(s)) return true;   // 不收 //evil 與 /\evil
    if (/^#[a-z0-9_-]{1,40}$/i.test(s)) return true;
    return /^https:\/\/(pitlingo\.com|www\.pitlingo\.com|chromewebstore\.google\.com|microsoftedge\.microsoft\.com)(\/[^\s"'<>]*)?$/.test(s);
  }

  function reveal() { root.classList.remove('pl-hydrating'); }

  var appliedVersion = null;

  function apply(c) {
    if (!c || typeof c !== 'object') return;
    var texts = c.texts || {};
    var hrefs = c.hrefs || {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function (el) {
      var k = el.getAttribute('data-edit');
      if (Object.prototype.hasOwnProperty.call(texts, k) && typeof texts[k] === 'string') el.innerHTML = rich(texts[k]);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit-href]'), function (el) {
      var k = el.getAttribute('data-edit-href');
      if (Object.prototype.hasOwnProperty.call(hrefs, k) && hrefOk(hrefs[k])) el.setAttribute('href', hrefs[k]);
    });

    // 區塊順序與顯示。**沒列在內容裡的區塊保持原位、原狀**——
    // HTML 新增一個區塊時，舊的已發布內容不會讓它消失。
    var host = document.getElementById('sections');
    if (host && Array.isArray(c.sections) && c.sections.length) {
      c.sections.forEach(function (s) {
        var el = host.querySelector(':scope > [data-section="' + String(s.id).replace(/[^a-z0-9-]/g, '') + '"]');
        if (!el) return;
        host.appendChild(el);
        el.hidden = s.visible === false;
      });
      // 沒被列到的區塊排到最後但維持原本的顯示狀態
      Array.prototype.forEach.call(host.querySelectorAll(':scope > [data-section]'), function (el) {
        var listed = c.sections.some(function (s) { return s.id === el.getAttribute('data-section'); });
        if (!listed) host.appendChild(el);
      });
    }

    if (c.demo && Array.isArray(c.demo.lines) && c.demo.lines.length) {
      demo.setLines(c.demo.lines, c.demo.intervalMs);
    }
    appliedVersion = c.version || null;
  }

  // =====================================================================
  // 模擬畫面：輪播真實翻譯清單裡的句子
  // =====================================================================
  var demo = (function () {
    var box = document.querySelector('[data-demo]');
    if (!box) return { setLines: function () {}, start: function () {} };
    var enEl = box.querySelector('[data-demo-en]');
    var zhEl = box.querySelector('[data-demo-zh]');
    var labelEl = box.querySelector('[data-demo-label]');
    // ⚠️ 進度條已移除，計時改畫在賽道線上（2026-10-02）。
    var lineEl = box.querySelector('[data-demo-line]');
    var countEl = box.querySelector('[data-demo-count]');
    var lines = [];
    var interval = 4200;
    var i = 0;
    var timer = null;

    try {
      var def = JSON.parse((document.getElementById('demo-default') || {}).textContent || '[]');
      if (Array.isArray(def)) lines = def;
    } catch (e) { lines = []; }

    function show(n) {
      if (!lines.length) return;
      var l = lines[n % lines.length];
      box.classList.add('swap');
      setTimeout(function () {
        enEl.textContent = l.en || '';
        zhEl.textContent = l.zh || '';
        if (labelEl) labelEl.textContent = l.label || '';
        if (countEl) countEl.textContent = (n % lines.length + 1) + ' / ' + lines.length;
        box.classList.remove('swap');
        // ⚠️ 減少動態效果時也照畫（2026-10-02）：它是這一句的進度條，不是裝飾。
        //    以前直接整條畫滿不動，使用者看不出字幕什麼時候會換。
        if (lineEl && motionPaused()) {
          // 暫停中換到這一句（例如暫停狀態下打開頁面）：時間線直接畫滿，不跑
          lineEl.style.transition = 'none';
          lineEl.style.strokeDashoffset = '0';
        } else if (lineEl) {
          // 賽道線＝這一句的時間線：整條隱形 → 從左往右畫出來，畫滿就換句。
          // pathLength=1000 寫在 markup 上，所以 1000 就是「整條」。
          lineEl.style.transition = 'none';
          lineEl.style.strokeDashoffset = '1000';
          // 強制重排，讓下一個 transition 真的從頭開始
          void lineEl.getBoundingClientRect();
          lineEl.style.transition = 'stroke-dashoffset ' + interval + 'ms linear';
          lineEl.style.strokeDashoffset = '0';
        }
      // 淡出淡入在減少動態效果時保留（只動 opacity；位移已在 CSS 拿掉）
      }, 260);
    }

    function tick() { i++; show(i); }

    function motionPaused() { return document.documentElement.getAttribute('data-motion') === 'paused'; }

    function start() {
      clearInterval(timer);
      if (!lines.length) return;
      show(i);
      // 暫停中（motion.js 的暫停鍵）：顯示目前這一句，但不輪播
      if (motionPaused()) return;
      timer = setInterval(tick, interval);
    }

    // 分頁看不到時暫停——背景分頁跑動畫只是耗電
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearInterval(timer); else start();
    });

    // 暫停鍵：停輪播、時間線停在當下的位置；繼續時從這一句重新開始計時
    document.addEventListener('pl-motion', function (e) {
      if (e.detail && e.detail.paused) {
        clearInterval(timer);
        if (lineEl && lineEl.getAnimations) {
          lineEl.getAnimations().forEach(function (a) { a.pause(); });
        }
      } else {
        start();
      }
    });

    return {
      setLines: function (next, ms) {
        lines = next.slice(0, 40);
        interval = Math.min(10000, Math.max(2500, Number(ms) || 4200));
        i = 0;
        start();
      },
      start: start,
    };
  })();

  // =====================================================================
  // 載入順序
  // =====================================================================
  if (preview) {
    var draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { draft = null; }
    apply(draft);
    reveal();
    var bar = document.createElement('div');
    bar.className = 'preview-bar';
    bar.textContent = draft ? '預覽模式：顯示的是後台尚未發布的草稿，只有這台瀏覽器看得到'
      : '預覽模式：這台瀏覽器沒有草稿（請從後台按「預覽」）';
    document.body.appendChild(bar);
    demo.start();
    return;
  }

  // 1) 上次看過的內容先套上去——回訪者不會看到文字閃一下
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { cached = null; }
  if (cached) apply(cached);
  demo.start();
  // 第一次來的人沒有快取：最多等 0.7 秒讓最新內容先到，等不到就顯示預設文字。
  // ⚠️ 不可以等更久——標題空白比「文字換一次」傷得更重。
  if (cached) reveal(); else setTimeout(reveal, 700);

  // 2) 再向後端要最新的。失敗就維持現狀——HTML 裡的預設文字本來就是完整的。
  var ctrl = window.AbortController ? new AbortController() : null;
  var giveUp = setTimeout(function () { if (ctrl) ctrl.abort(); }, 4000);
  fetch(API, { signal: ctrl ? ctrl.signal : undefined, credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      clearTimeout(giveUp);
      var c = d && d.content;
      if (!c) { reveal(); if (cached) { try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* noop */ } } return; }
      if (c.version !== appliedVersion) apply(c);
      reveal();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* 無痕模式寫不進去沒關係 */ }
    })
    .catch(function () { clearTimeout(giveUp); reveal(); });
})();
