/**
 * 直播延遲畫面（2026-10-06 初版；2026-10-11 R17 新加坡正賽實測後改寫）
 *
 * 讓看直播的人一律落後直播邊緣 N 秒（預設 45）。前導收割端貼著邊緣翻譯，
 * 使用者的字幕檔比它晚 N 秒到——到的時候譯文早就在共用快取裡。
 *
 * ⚠️ **Ray 的決定：預設開、不告訴使用者（畫面上沒有任何提示）、按 F1TV 的 LIVE 鍵也要維持延遲。**
 *    遠端設定 `liveDelay.enabled` 可以隨時關掉（不必發新版）。
 *
 * ──── 2026-10-11 正賽實測推翻了初版的三個假設（坑 #97）────
 *
 *  1. **`video.currentTime` 不能拿來往回拉。** 設下去之後畫面停住、自己暫停、卡 20 秒，
 *     然後播放器把畫面拉回邊緣。F1TV 的 WASM 播放器自己決定要抓哪些分段，
 *     從外面改 currentTime 它不會去抓那一段。
 *  2. **`video.seekable`／`currentTime` 量不出「落後多少」。** 播放器自己往回跳（進度條、← 鍵、LIVE 鍵）時
 *     會重建 `<video>` 的時間軸——畫面確實回到 60 秒前，currentTime 卻照樣平順往前、seekable 照樣只差 3 秒。
 *     初版一進直播就因為「DVR 只有 3 秒」整場停用，就是這個假象。
 *  3. **真正的播放位置在進度條上：`.tm-ui-seekbar` 的 `aria-valuenow`（毫秒）。**
 *     正常播放每 10 秒加 10,000，按 ← 減 10,000，按 LIVE 一次跳回邊緣。
 *
 * ──── 現在的做法 ────
 *
 *  · **量**：邊緣 ＝ 看過的最大「位置 − 牆上時鐘」＋ 現在的牆上時鐘；落後 ＝ 邊緣 − 位置。
 *    位置不可能超過邊緣，所以取最大值只會越來越準；暫停時位置不動、牆上時鐘照走，不會把邊緣拉低。
 *  · **拉**：對播放器容器送 ← 鍵（實測播放器接受程式送的按鍵，每次 10 秒，約 3.5 秒後一次執行）。
 *    交給播放器自己 seek，它才會正確去抓分段——**不碰 currentTime、不碰 MediaSource**（坑 #8）。
 *  · **藏**：送鍵會叫出「↺10」圖示、控制列、緩衝轉圈，落後時 LIVE 標記會變灰。
 *    送鍵前後幾秒用 CSS 把前三者藏起來；延遲期間把 LIVE 標記的 `-live-edge` class 補回去。
 *  · **LIVE 鍵**：在 window 的捕捉階段攔下點擊，改送 → 鍵停在「邊緣 − N」——畫面不會先跳到邊緣再跳回來。
 *    沒攔到的跳轉（拖到最右、播放器自己追邊緣）由每秒的檢查補送 ←。
 *  · **剛進直播**：一開始播就送 ←（Ray 決定 (a)＋(b)：進直播時、按 LIVE 時）。
 *
 * ⚠️ 修正有冷卻與每小時上限（鐵則 3）；送了鍵位置卻沒動（播放器不收程式按鍵了）連續 3 次就停用這一場。
 *    寧可沒有延遲，也不要和播放器拔河。
 * ⚠️ 這裡寫死的 class 名稱是 F1TV 2026-10 的版本。改版後找不到元素 → `pos()` 回 null → 什麼都不做。
 */
(function () {
  const PL = (self.PL = self.PL || {});

  const SEL = {
    seekbar: '.tm-ui-seekbar',
    box: '.tm-ui-uicontainer',
    label: '.tm-ui-playbacktimelabel',
    liveBtn: '.tm-ui-playbacktimelabel-live',
    edgeCls: 'tm-ui-playbacktimelabel-live-edge',
  };
  const HIDE_CSS = '.tm-ui-quick-seek-overlay,.tm-ui-buffering-overlay{display:none!important}'
    + '.tm-ui-controlbar{opacity:0!important;transition:none!important}';

  /** F1TV 播放器的轉接層。測試會換成假的。 */
  PL.f1tvPlayer = function (doc) {
    doc = doc || document;
    let style = null, unhideAt = 0, unhideTimer = null, edgeStyle = null, edgeOn = false;
    // 播放器把 -live-edge 拿掉的那一刻就補回去（只靠每秒檢查會灰 1 秒，實測看得到）
    const labelSeen = new WeakSet();
    const labelMo = typeof MutationObserver === 'function' ? new MutationObserver((ms) => {
      if (!edgeOn) return;
      for (const m of ms) {
        const e = m.target;
        if (!e.classList.contains(SEL.edgeCls)) { e.classList.add(SEL.edgeCls); e.dataset.plEdge = '1'; }
      }
    }) : null;
    function hide(ms) {
      try {
        if (!style) { style = doc.createElement('style'); style.textContent = HIDE_CSS; }
        if (!style.isConnected) (doc.head || doc.documentElement).appendChild(style);
        unhideAt = Math.max(unhideAt, Date.now() + ms);
        clearTimeout(unhideTimer);
        unhideTimer = setTimeout(() => { try { style.remove(); } catch (e) { /* noop */ } }, unhideAt - Date.now());
      } catch (e) { /* noop */ }
    }
    function key(k, n) {
      const box = doc.querySelector(SEL.box);
      if (!box) return false;
      const code = k === 'left' ? 'ArrowLeft' : 'ArrowRight';
      const kc = k === 'left' ? 37 : 39;
      hide(7000);
      for (let i = 0; i < n; i++) {
        box.dispatchEvent(new KeyboardEvent('keydown', { key: code, code, keyCode: kc, which: kc, bubbles: true, cancelable: true }));
        box.dispatchEvent(new KeyboardEvent('keyup', { key: code, code, keyCode: kc, which: kc, bubbles: true }));
      }
      return true;
    }
    return {
      video: () => doc.querySelector('video'),
      /** 播放位置（毫秒），找不到進度條就是 null */
      pos() {
        const e = doc.querySelector(SEL.seekbar);
        const v = e && Number(e.getAttribute('aria-valuenow'));
        return Number.isFinite(v) && v > 0 ? v : null;
      },
      back: (n) => key('left', n),
      fwd: (n) => key('right', n),
      /**
       * 延遲期間讓 LIVE 標記與進度條維持「在邊緣」的樣子。
       * 進度條是播放器每一幀改 inline style（不帶 !important）：已播放 scaleX(0.987)、圓點 translateX(1192px)。
       * 用樣式表加 !important 蓋過去，播放器怎麼改都不會閃（實測 2026-10-11：落後 45 秒時圓點離最右約 1%，看得出來）。
       */
      fakeEdge(on) {
        edgeOn = !!on;
        // 只拿掉自己加的：播放器自己加的（真的在邊緣）不可以動
        doc.querySelectorAll(SEL.label).forEach((e) => {
          if (labelMo && !labelSeen.has(e)) { labelSeen.add(e); labelMo.observe(e, { attributes: true, attributeFilter: ['class'] }); }
          if (on && !e.classList.contains(SEL.edgeCls)) { e.classList.add(SEL.edgeCls); e.dataset.plEdge = '1'; }
          else if (!on && e.dataset.plEdge) { e.classList.remove(SEL.edgeCls); delete e.dataset.plEdge; }
        });
        try {
          if (!on) { if (edgeStyle) edgeStyle.remove(); return; }
          const bar = doc.querySelector(SEL.seekbar);
          const w = bar ? Math.round(bar.getBoundingClientRect().width) : 0;
          if (!w) return;
          if (!edgeStyle) edgeStyle = doc.createElement('style');
          // ⚠️ 一定要限定在 .tm-ui-seekbar 底下：音量條用的是同一套元件（實測：圓點被推到最右邊）
          const css = '.tm-ui-seekbar .tm-seekbar-playbackposition,.tm-ui-seekbar .tm-seekbar-bufferlevel{transform:scaleX(1)!important}'
            + `.tm-ui-seekbar .tm-seekbar-playbackposition-marker{transform:translateX(${w}px)!important}`;
          if (edgeStyle.textContent !== css) edgeStyle.textContent = css;
          if (!edgeStyle.isConnected) (doc.head || doc.documentElement).appendChild(edgeStyle);
        } catch (e) { /* noop */ }
      },
      /** 攔 LIVE 鍵：handler 回 true 就吞掉這次點擊 */
      onLiveClick(handler) {
        const f = (ev) => {
          const t = ev.target && ev.target.closest && ev.target.closest(SEL.liveBtn);
          if (t && handler(ev.type)) { ev.stopImmediatePropagation(); ev.preventDefault(); }
        };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((n) => window.addEventListener(n, f, true));
      },
    };
  };

  PL.createLiveDelay = function (opts) {
    const o = Object.assign({
      seconds: 45,          // 目標落後秒數
      tolerance: 8,         // 落後少於 seconds − tolerance 才修正
      step: 10,             // 每按一次 ← 倒退幾秒（F1TV 實測 10）
      drift: 4,             // 送鍵到播放器執行之間（約 3.5 秒）畫面照走，實際倒退比 n×10 多約 4 秒（實測 3 下 33.7、5 下 54.9）
      entryExtra: 8,        // 剛進直播（播放器剛啟動）那一次，播放器還會額外多退約 7～9 秒（實測兩次：5 下 63 秒、4 下 51 秒）
      overshoot: 6,         // 自己送鍵後落後超過 seconds＋這個值，就往前修一次（剛進直播時實測 5 下變 63 秒）
      settleMs: 9000,       // 送鍵後多久才再看（播放器約 3.5 秒後才執行）
      maxPerHour: 30,
      maxNoEffect: 3,
      now: () => Date.now(),
      log: () => {},
      player: null,
    }, opts || {});
    const P = o.player || PL.f1tvPlayer();

    let edgeOff = null;     // 看過的最大（位置 − 牆上時鐘）
    let lastFix = -Infinity;
    let fixTimes = [];
    let check = null;       // { at, before }：送鍵後要驗證位置有沒有動
    let noEffect = 0;
    let live = false, enabled = true, stopped = '';
    let video = null;
    let lastEl = null;      // 最後一個看過的 <video>（換成另一個＝播放器重建）
    // 進度條凍住偵測（2026-10-26 R18 Post-Race 實測，A12）：F1TV 播放器的介面整個不更新——
    // 進度條時間停在 23:23、畫面全黑，但 video.currentTime 照實際時間前進、字幕照常換。
    // 這時 aria-valuenow 不動、牆上時鐘照走，「落後」會被算成一直變大（實測讀出 600 秒，實際 1～4 秒）。
    // 影片明明在播、位置卻 FROZEN_SEC 秒都沒變 → 量不準，這一段什麼都不做（不假裝、不送鍵），等它恢復。
    const FROZEN_SEC = 20;
    let lastPos = null, posCt = null;
    const stats = { fixes: 0, liveFixes: 0, tickFixes: 0, overFixes: 0, entryFix: false, behind: null, noEffect: 0, frozen: false, frozenTimes: 0 };

    function frozenNow(v) {
      const p = P.pos();
      const ct = v && Number.isFinite(v.currentTime) ? v.currentTime : null;
      if (p === null || ct === null) { lastPos = p; posCt = ct; return false; }
      if (p !== lastPos || posCt === null || ct < posCt) { lastPos = p; posCt = ct; return false; }
      // 暫停時兩邊都不動，不算凍住
      return !v.paused && ct - posCt >= FROZEN_SEC;
    }

    function want() { return enabled && live && !stopped; }
    function behindNow() {
      const p = P.pos();
      if (p === null) return null;
      const t = o.now();
      if (edgeOff === null || p - t > edgeOff) edgeOff = p - t;
      return Math.max(0, (edgeOff + t - p) / 1000);
    }
    function canFix() {
      const t = o.now();
      if (t - lastFix < o.settleMs) return false;
      fixTimes = fixTimes.filter((x) => t - x < 3600000);
      if (fixTimes.length >= o.maxPerHour) {
        stopped = `一小時內修正了 ${fixTimes.length} 次（播放器可能一直把畫面拉回邊緣），這一場停用延遲`;
        o.log(stopped);
        return false;
      }
      return true;
    }
    function did(behind, dir) {
      const t = o.now();
      fixTimes.push(t); lastFix = t; stats.fixes++;
      check = { at: t, before: behind, dir };
    }

    function onRate() {
      const v = video;
      if (v && want() && v.playbackRate > 1) { try { v.playbackRate = 1; } catch (e) { /* noop */ } }
    }
    function attach(v) {
      if (video === v) return;
      if (video) video.removeEventListener('ratechange', onRate, true);
      video = v;
      if (v) v.addEventListener('ratechange', onRate, true);
    }

    // LIVE 鍵：不讓播放器跳到邊緣，改成往前送到「邊緣 − N」
    let liveHooked = false;
    function hookLive() {
      if (liveHooked || !P.onLiveClick) return;
      liveHooked = true;
      P.onLiveClick((type) => {
        if (!want()) return false;
        if (type !== 'click') return true;           // 按下／放開也吞掉，只在 click 時動作
        const b = behindNow();
        if (b === null) return false;                // 量不到就讓播放器照原本的做
        // 落後在 N～N+10 秒之間就不動（看起來像「已經在最新」）；更後面才往前送，送到 N～N+10 之間
        // 往前送也一樣：目標以按下那一刻計算、3.5 秒後才執行，實際少前進約 drift 秒
        const n = (b - o.seconds) < o.step ? 0 : Math.round((b - o.seconds + o.drift) / o.step);
        if (n > 0 && canFix()) { P.fwd(n); stats.liveFixes++; did(b, 'fwd'); }
        return true;
      });
    }

    return {
      /** 每秒呼叫一次。isLive：這一支是不是直播。 */
      tick(isLive) {
        hookLive();
        const v = P.video();
        if (v !== video) attach(v || null);
        // 播放器重建（<video> 換了一個）＝進度條換成新的時間軸，要重新量（2026-11-01 R19 排位實測）：
        // 只在「直播 ↔ 不是直播」改變時重置的話，節目 → 排位（兩邊都是直播）、斷線重連後播放器重建，
        // 都會拿上一條時間軸的邊緣來算——斷線那次三個分頁都讀出「落後 556～561 秒」（實際 0～5 秒），
        // 以為是使用者自己往回拉而不介入，觀眾整段沒有延遲；換片那次則退過頭再往前修，多跳一次被看見。
        // 當成剛進直播：重新量邊緣、剛進直播的額外倒退量照扣。⚠️ 每小時上限（fixTimes）與停用原因不歸零（鐵則 3）
        if (v && v !== lastEl) {
          if (lastEl) { edgeOff = null; check = null; noEffect = 0; stats.entryFix = false; lastPos = null; posCt = null; stats.rebuilds = (stats.rebuilds || 0) + 1; }
          lastEl = v;
        }
        if (!!isLive !== live) { live = !!isLive; stopped = ''; fixTimes = []; edgeOff = null; check = null; noEffect = 0; stats.entryFix = false; }
        const fr = frozenNow(v);
        if (fr !== stats.frozen) {
          stats.frozen = fr;
          if (fr) { stats.frozenTimes++; o.log(`進度條 ${FROZEN_SEC} 秒沒有動、影片卻在播（播放器介面凍住），量不準，先不修正`); }
          // ⚠️ 恢復時**不可以**把 edgeOff 歸零：重新量會把「現在的位置」當成邊緣，於是以為落後 0 秒、
          //    再往回送一次，變成落後 85 秒（測試抓到的）。凍住期間位置不動、時鐘照走，只會讓 p − t 變小，
          //    不會把 edgeOff 拉高，原本的值照樣可信。只丟掉「送鍵後待驗證」那一筆（凍住期間量不到效果）
          else { check = null; }
        }
        if (fr) { stats.behind = null; P.fakeEdge(false); return; }
        const b = behindNow();
        stats.behind = b === null ? null : +b.toFixed(1);
        if (!want() || b === null) { P.fakeEdge(false); return; }   // 遠端關掉／不是直播／停用：照實顯示
        P.fakeEdge(b < o.seconds + 20);             // 延遲中看起來「在邊緣」；使用者自己往回拉很遠就不假裝
        if (!v || v.paused || v.seeking) return;
        onRate();
        // 送了鍵，位置有沒有真的動？動過頭了就修回來（閉迴路：只修**自己**送鍵造成的，使用者自己往回看不碰）
        if (check && o.now() - check.at >= o.settleMs) {
          const c = check;
          check = null;
          if (Math.abs(b - c.before) < o.step / 2) {
            noEffect++; stats.noEffect = noEffect;
            if (noEffect >= o.maxNoEffect) { stopped = `送了 ${noEffect} 次按鍵播放位置都沒有動（播放器可能不再接受程式按鍵），這一場停用延遲`; o.log(stopped); return; }
          } else {
            noEffect = 0;
            if (c.dir === 'back' && b > o.seconds + o.overshoot && b < o.seconds + 40 && canFix()) {
              const n = Math.max(1, Math.round((b - o.seconds + o.drift) / o.step));
              if (P.fwd(n)) { stats.overFixes = (stats.overFixes || 0) + 1; did(b, 'fwd'); return; }
            }
          }
        }
        if (b < o.seconds - o.tolerance && canFix()) {
          const extra = stats.entryFix ? 0 : o.entryExtra;
          const n = Math.max(1, Math.round((o.seconds - o.drift - extra - b) / o.step));
          if (P.back(n)) { stats.tickFixes++; if (!stats.entryFix) stats.entryFix = true; did(b, 'back'); }
        }
      },
      setEnabled(on, seconds) {
        enabled = !!on;
        if (Number(seconds) >= 10 && Number(seconds) <= 120) o.seconds = Number(seconds);
      },
      /** 診斷報告用（不顯示在畫面上）。 */
      status() {
        return { enabled, live, seconds: o.seconds, active: want(), stopped, ...stats };
      },
    };
  };
})();
