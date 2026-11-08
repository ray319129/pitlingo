/**
 * motion.js —— 首頁 Hero 的暫停鍵（2026-10-02，使用者指定：玻璃效果的圓形暫停鍵）
 *
 * 位置：Hero 按鈕列、「查看方案」右邊（使用者 2026-10-02 指定）。
 *
 * 為什麼要有：WCAG 2.2.2（A 級）——自動移動超過 5 秒、而且與其他內容並存的東西，
 * 一定要能暫停。彈幕、跑馬燈、流動金屬、字幕輪播全都是。
 * 「減少動態效果」的電腦上彈幕仍然會慢速飄（使用者選的），這顆鍵讓真正需要的人整個停下來。
 *
 * 狀態存在 localStorage（pl_motion）。每一頁的頁首都有一行內嵌腳本（tools/site-chrome.js 產生），
 * 在畫面出來之前就套上 html[data-motion="paused"]——所以暫停之後換頁，側欄的跑馬燈也是停的。
 * 這支只負責首頁那顆鍵：切換、存起來、通知 veins.js 與 site-content.js（事件 pl-motion）。
 *
 * ⚠️ localStorage 可能不能用（無痕、被封鎖）：讀寫都包 try/catch。
 *    寫不進去時這一頁照樣暫停，只是換頁後不記得。
 * ⚠️ 無障礙名稱固定是「暫停背景動態」，狀態用 aria-pressed 表示——
 *    名稱跟著狀態換、又同時用 aria-pressed，螢幕閱讀器會念成「播放，已按下」這種矛盾的話。
 */
(function () {
  'use strict';

  var btn = document.querySelector('[data-motion-toggle]');
  if (!btn) return;
  var root = document.documentElement;
  var KEY = 'pl_motion';

  function paused() { return root.getAttribute('data-motion') === 'paused'; }

  function render() {
    var p = paused();
    btn.setAttribute('aria-pressed', p ? 'true' : 'false');
    btn.setAttribute('title', p ? '繼續播放背景動態' : '暫停背景動態');
  }

  btn.addEventListener('click', function () {
    var p = !paused();
    if (p) root.setAttribute('data-motion', 'paused'); else root.removeAttribute('data-motion');
    try {
      if (p) localStorage.setItem(KEY, 'paused'); else localStorage.removeItem(KEY);
    } catch (e) { /* 無痕或被封鎖：這一頁照樣生效 */ }
    render();
    document.dispatchEvent(new CustomEvent('pl-motion', { detail: { paused: p } }));
  });

  render();
}());
