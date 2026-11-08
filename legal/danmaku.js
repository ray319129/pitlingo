/**
 * danmaku.js —— Hero 背景彈幕的懸停互動
 *
 * 滑鼠碰到飄過的英文字幕時：該句變明顯，下方展開中文翻譯，打字機效果。
 *
 * ⚠️ 翻譯不是畫在彈幕那一層，而是畫在**另一層沒有遮罩的浮層**上。
 *    原因：`.danmaku` 有一塊 radial 遮罩把文案區的彈幕淡掉（否則會壓到主標），
 *    而遮罩作用於整層、沒辦法只放行一個子元素。如果翻譯跟著待在那一層，
 *    滑到中央時會整個看不見——而且**指標事件照樣會觸發**，變成
 *    「有東西被 hover 了但畫面上什麼都沒有」。
 *
 * ⚠️ 懸停時暫停該句的動畫。不暫停的話它會從游標底下滑走，
 *    中文還沒打完就消失——那不是互動，是在跟使用者賽跑。
 *
 * 降級：JS 沒載入 → 彈幕照常飄，只是不能互動。沒有任何視覺缺口。
 */
(function () {
  'use strict';

  var layer = document.querySelector('.hero-cine .danmaku');
  if (!layer) return;
  var stage = layer.parentNode;
  if (!stage) return;

  // ⚠️ 觸控裝置沒有 hover 的概念：點一下會卡住一個不會消失的浮層。
  if (!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches)) return;

  var pop = document.createElement('div');
  pop.className = 'dm-pop';
  pop.setAttribute('aria-hidden', 'true');
  pop.innerHTML = '<span class="dm-en"></span><span class="dm-zh"></span>';
  stage.appendChild(pop);

  var popEn = pop.querySelector('.dm-en');
  var popZh = pop.querySelector('.dm-zh');
  var typer = 0, current = null;

  function stopTyping() {
    if (typer) { clearInterval(typer); typer = 0; }
  }

  function type(text) {
    stopTyping();
    popZh.textContent = '';
    var i = 0;
    // 「中文翻譯出現的動畫速度要快」——18ms/字，一句十幾個字約 0.3 秒。
    typer = setInterval(function () {
      i++;
      popZh.textContent = text.slice(0, i);
      if (i >= text.length) stopTyping();
    }, 18);
  }

  function show(span) {
    if (current === span) return;
    hide();
    current = span;

    var zh = span.getAttribute('data-zh') || '';
    if (!zh) return;

    span.classList.add('on');
    // ⚠️ 暫停：不暫停的話它會從游標底下滑走，中文還沒打完就不見了。
    span.style.animationPlayState = 'paused';

    var sr = span.getBoundingClientRect();
    var pr = stage.getBoundingClientRect();
    pop.style.left = (sr.left - pr.left) + 'px';
    pop.style.top = (sr.bottom - pr.top + 6) + 'px';

    popEn.textContent = span.textContent;
    pop.classList.add('on');
    type(zh);
  }

  function hide() {
    stopTyping();
    pop.classList.remove('on');
    popZh.textContent = '';
    if (current) {
      current.classList.remove('on');
      current.style.animationPlayState = '';
      current = null;
    }
  }

  // ⚠️ **不能只靠彈幕自己的 pointerenter。**
  //    文案層（.inner，z-index 2）蓋在彈幕（z-index 1）上面，滑過主標、
  //    內文、CTA 那一帶時，指標事件打在文案上，彈幕永遠收不到——
  //    使用者實測回報「某些位置碰到不會翻譯」就是這個。
  //
  //    改成在整個 Hero 上聽 pointermove，用 elementsFromPoint 取得游標下
  //    **整疊**元素，從中找出彈幕。這樣不管上面蓋了什麼都找得到。
  //
  //    ⚠️ 節流用**時間戳，不用 requestAnimationFrame**。
  //       pointermove 一秒可以觸發上百次，而 elementsFromPoint 會強制
  //       重算版面，所以一定要節流——但 rAF 在被節流的環境（背景分頁、
  //       省電模式、沒在繪製的視窗）**完全不會觸發**，把它放在事件與動作
  //       之間，等於讓整個功能在那些情況下安靜地死掉。
  //       實測過：某些情況下 400ms 內 rAF 一次都沒跑。
  //       30ms 的時間戳節流同樣省，而且不依賴繪製。
  var zone = layer.closest('.hero') || stage;
  var last = 0;

  zone.addEventListener('pointermove', function (e) {
    var now = e.timeStamp || Date.now();
    if (now - last < 30) return;
    last = now;
    var stack = document.elementsFromPoint(e.clientX, e.clientY);
    var hit = null;
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (el.parentNode === layer && el.tagName === 'SPAN') { hit = el; break; }
    }
    if (hit) show(hit); else hide();
  });
  zone.addEventListener('pointerleave', hide);

  // 捲離 Hero 之後不留一個浮在半空的翻譯
  window.addEventListener('scroll', function () { if (current) hide(); }, { passive: true });
}());
