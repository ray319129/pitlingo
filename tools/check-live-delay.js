#!/usr/bin/env node
/**
 * 直播延遲畫面控制器（extension/src/shared/live-delay.js）的行為檢查。
 *
 * 這是唯一一段會**主動移動使用者畫面**的程式碼，錯了的後果是「一直往回跳」或「卡在邊緣暴雷」，
 * 而且只有直播時才看得到。用一個照 2026-10-11 正賽實測行為做的假 F1TV 播放器把每一種情況跑過：
 *   · 位置只在進度條上（aria-valuenow，毫秒）；<video> 的時間軸不可信，所以假播放器根本不給
 *   · ← / → 每次 10 秒，送完約 3.5 秒後才一次執行；目標以「按下那一刻」的位置計算（所以實際多倒退約 3.5 秒）
 *   · extra：剛進直播時播放器額外多退的秒數（2026-10-11 實測兩次約 7～9 秒，預設 8；「多退」情境用 20）
 *
 *   1. 一進直播（在邊緣）→ 送 ← 到邊緣 − 45 秒
 *   2. 按 LIVE 鍵 → 攔下，不跳到邊緣；若落後超過 45 秒則往前送到 45 秒
 *   3. 沒攔到的跳到邊緣（拖到最右）→ 補送 ←
 *   4. 送鍵後播放器還沒執行的那幾秒 → 不重複送（不會一路往回退）
 *   5. 播放器一直把我們拉回邊緣 → 每小時上限，超過停用
 *   6. 播放器不收程式按鍵 → 3 次沒反應就停用
 *   7. 找不到進度條（F1TV 改版）→ 什麼都不做
 *   8. 不是直播／遠端關掉 → 完全不動
 *   9. 使用者自己往回拉很遠 → 不干涉、LIVE 標記不假裝在邊緣
 *  10. 播放器加速追邊緣 → 維持 1 倍速；暫停 → 不動
 *  11. 延遲中 LIVE 標記維持「在邊緣」的樣子
 *  12. 播放器介面凍住（影片在播、進度條不動）→ 量不準，不送鍵、不假裝；恢復後照常
 *
 * 用法：node tools/check-live-delay.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const errors = [];
const ok = (m) => console.log('✅ ' + m);
const fail = (m) => { errors.push(m); console.log('❌ ' + m); };

const src = fs.readFileSync(path.join(__dirname, '..', 'extension/src/shared/live-delay.js'), 'utf8');
const ctx = { self: {}, console, Date, Math, Number, Object, JSON };
vm.createContext(ctx);
vm.runInContext('"use strict";' + src, ctx);
const create = ctx.self.PL.createLiveDelay;

/** 假的 F1TV 播放器。edge／pos 都是毫秒；t 是牆上時鐘。 */
function makePlayer(o) {
  const p = Object.assign({ t: 0, edge: 3000000, pos: 2997000, paused: false, rate: 1, ignoreKeys: false, noSeekbar: false, fakeEdgeOn: null, extra: 8 }, o || {});
  p.pending = 0; p.pendingAt = 0; p.pendingBase = 0; p.keys = 0; p.liveHandler = null;
  // ct＝video.currentTime（秒）；frozen＝播放器介面凍住：影片照播、進度條不動（R18 Post-Race 實測）
  p.ct = 0; p.frozen = false; p.frozenLag = 0;
  const press = (ms) => {
    if (!p.pending) p.pendingBase = p.pos;
    p.pending += ms; p.pendingAt = p.t + 3500;
  };
  const ls = {};
  p.v = {
    get paused() { return p.paused; },
    get currentTime() { return p.ct; },
    seeking: false,
    get playbackRate() { return p.rate; },
    set playbackRate(x) { p.rate = x; },
    addEventListener(n, f) { (ls[n] = ls[n] || []).push(f); },
    removeEventListener(n, f) { ls[n] = (ls[n] || []).filter((x) => x !== f); },
  };
  p.player = {
    video: () => p.v,
    pos: () => (p.noSeekbar ? null : p.pos),
    back(n) { p.keys += n; if (!p.ignoreKeys) press(-n * 10000 - p.extra * 1000); p.extra = 0; return true; },
    fwd(n) { p.keys += n; if (!p.ignoreKeys) press(n * 10000); return true; },
    fakeEdge(on) { p.fakeEdgeOn = on; },
    onLiveClick(h) { p.liveHandler = h; },
  };
  p.advance = (sec) => {
    for (let i = 0; i < sec * 10; i++) {
      p.t += 100; p.edge += 100;
      if (!p.paused) { p.ct += 0.1 * p.rate; if (p.frozen) p.frozenLag += 100 * p.rate; else p.pos += 100 * p.rate; }
      if (p.pending && p.t >= p.pendingAt) { p.pos = Math.min(p.edge, p.pendingBase + p.pending); p.pending = 0; }
    }
  };
  p.behind = () => (p.edge - p.pos) / 1000;
  /** 按 LIVE：handler 吞掉就不跳；沒吞就跳到邊緣 */
  p.pressLive = () => {
    const h = p.liveHandler;
    const swallowed = h ? ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].map((t) => h(t)).every(Boolean) : false;
    if (!swallowed) p.pos = p.edge - 2000;
    return swallowed;
  };
  return p;
}

function run(name, o, fn) {
  const p = makePlayer(o && o.player);
  const ld = create({ now: () => p.t, log: () => {}, player: p.player });
  if (o && o.enabled === false) ld.setEnabled(false, 45);
  const tick = (isLive, sec) => { for (let i = 0; i < (sec || 1); i++) { p.advance(1); ld.tick(isLive); } };
  try { fn(p, ld, tick); } catch (e) { fail(name + '：' + (e.stack || e)); }
}
// ← 一次 10 秒，目標 45 只能落在 40 或 50；再加上播放器本身離真正邊緣約 3 秒
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 8);

// 1. 一進直播
run('進直播', null, (p, ld, tick) => {
  tick(true, 15);
  const s = ld.status();
  near(p.behind(), 45) && s.entryFix ? ok(`一進直播就送 ← 到落後 ${p.behind().toFixed(0)} 秒（目標 45）`)
    : fail(`進直播沒有拉到 45 秒：落後 ${p.behind().toFixed(1)}、entryFix=${s.entryFix}`);
});

// 1b. 剛進直播時播放器多退了十幾秒（實測 5 下變 63 秒）→ 自己送鍵造成的，往前修一次
run('進直播多退', { player: { extra: 20 } }, (p, ld, tick) => {
  tick(true, 8);
  const first = p.behind();
  tick(true, 7);
  tick(true, 20);
  const s = ld.status();
  first > 53 && near(p.behind(), 45) && s.overFixes === 1
    ? ok(`剛進直播被多退到 ${first.toFixed(0)} 秒時，往前修一次回到 ${p.behind().toFixed(0)} 秒`)
    : fail(`進直播多退：先 ${first.toFixed(1)} 秒、20 秒後 ${p.behind().toFixed(1)} 秒、修過頭 ${s.overFixes} 次`);
});

// 2. LIVE 鍵：攔下，不跳到邊緣
run('LIVE 鍵', null, (p, ld, tick) => {
  tick(true, 20);
  const before = p.behind();
  const swallowed = p.pressLive();
  tick(true, 1);
  const right = p.behind();
  tick(true, 15);
  (swallowed && near(right, before, 3) && near(p.behind(), 45))
    ? ok(`按 LIVE 鍵被攔下：畫面沒有跳到邊緣（按下後落後 ${right.toFixed(0)} 秒），之後維持 ${p.behind().toFixed(0)} 秒`)
    : fail(`LIVE 鍵：吞掉=${swallowed}、按下後落後 ${right.toFixed(1)}、15 秒後 ${p.behind().toFixed(1)}`);
});

// 2b. 使用者往回看 2 分鐘後按 LIVE → 往前送到 45 秒（不是邊緣）
run('LIVE 鍵（從很後面）', null, (p, ld, tick) => {
  tick(true, 20);
  p.pos -= 120000;
  tick(true, 5);
  p.pressLive();
  tick(true, 15);
  const s = ld.status();
  near(p.behind(), 45) && s.liveFixes === 1 ? ok(`往回看 2 分鐘後按 LIVE，往前送到落後 ${p.behind().toFixed(0)} 秒（不是邊緣）`)
    : fail(`從很後面按 LIVE 之後落後 ${p.behind().toFixed(1)} 秒、liveFixes=${s.liveFixes}`);
});

// 3. 沒攔到的跳到邊緣
run('拖到最右', null, (p, ld, tick) => {
  tick(true, 20);
  p.pos = p.edge - 1000;
  tick(true, 15);
  const s = ld.status();
  near(p.behind(), 45) && s.tickFixes >= 2 ? ok(`拖到最右（沒經過 LIVE 鍵）之後補送 ←，回到落後 ${p.behind().toFixed(0)} 秒`)
    : fail(`拖到最右之後落後 ${p.behind().toFixed(1)} 秒、補送 ${s.tickFixes} 次`);
});

// 4. 送鍵後播放器還沒執行 → 不重複送
run('不重複送', null, (p, ld, tick) => {
  tick(true, 600);
  const s = ld.status();
  s.fixes === 1 && near(p.behind(), 45) ? ok(`10 分鐘只送了 1 次（播放器延遲執行的那幾秒沒有重複送），維持 ${p.behind().toFixed(0)} 秒`)
    : fail(`10 分鐘送了 ${s.fixes} 次、落後 ${p.behind().toFixed(0)} 秒（應該只送 1 次、約 45）`);
});

// 5. 拔河
run('拔河', null, (p, ld, tick) => {
  for (let i = 0; i < 3600; i++) {
    if (i % 15 === 0) p.pos = p.edge - 2000;   // 播放器每 15 秒把位置拉回邊緣
    tick(true, 1);
  }
  const s = ld.status();
  s.fixes <= 30 && s.stopped ? ok(`播放器一直把畫面拉回邊緣時，修正 ${s.fixes} 次後停用這一場（不和播放器拔河）`)
    : fail(`和播放器拔河：一小時修正了 ${s.fixes} 次，停用＝${!!s.stopped}`);
});

// 6. 不收程式按鍵
run('不收按鍵', { player: { ignoreKeys: true } }, (p, ld, tick) => {
  tick(true, 120);
  const s = ld.status();
  s.stopped && s.fixes === 3 ? ok('播放器不收程式按鍵時，3 次沒反應就停用（不會每 9 秒送一次送一整場）')
    : fail(`播放器不收按鍵：送了 ${s.fixes} 次、停用＝${!!s.stopped}`);
});

// 7. 找不到進度條
run('改版', { player: { noSeekbar: true } }, (p, ld, tick) => {
  tick(true, 60);
  p.pressLive();
  p.keys === 0 ? ok('找不到進度條（F1TV 改版）時完全不送鍵、LIVE 鍵照原本的行為') : fail(`找不到進度條仍然送了 ${p.keys} 次鍵`);
});

// 8. 不是直播／遠端關掉
run('重播', null, (p, ld, tick) => {
  tick(false, 60);
  const sw = p.pressLive();
  p.keys === 0 && !sw ? ok('重播（不是直播）完全不動畫面、LIVE 鍵不攔') : fail('重播時也動了畫面');
});
run('遠端關掉', { enabled: false }, (p, ld, tick) => {
  tick(true, 60);
  const sw = p.pressLive();
  p.keys === 0 && !sw ? ok('遠端設定 enabled: false 時完全不動畫面、LIVE 鍵不攔') : fail('遠端關掉之後仍然在動');
});

// 9. 使用者往回看很遠
run('往回看', null, (p, ld, tick) => {
  tick(true, 20);
  const k = p.keys;
  p.pos -= 600000;
  tick(true, 60);
  near(p.behind(), 600 + 45, 8) && p.keys === k && p.fakeEdgeOn === false
    ? ok('使用者自己往回拉 10 分鐘：不干涉、LIVE 標記照實顯示不在邊緣')
    : fail(`往回看：落後 ${p.behind().toFixed(0)}、多送了 ${p.keys - k} 次鍵、假裝邊緣=${p.fakeEdgeOn}`);
});

// 10. 加速／暫停
run('加速', null, (p, ld, tick) => {
  tick(true, 15);
  p.v.playbackRate = 1.25;
  tick(true, 1);
  p.rate === 1 ? ok('延遲中播放器加速追邊緣時維持 1 倍速') : fail(`延遲中被加速到 ${p.rate} 倍`);
});
run('暫停', null, (p, ld, tick) => {
  p.paused = true;
  tick(true, 120);
  p.keys === 0 ? ok('暫停時不送鍵（落後只會變多）') : fail('暫停時也在送鍵');
});

// 12. 進度條凍住（A12）：影片在播、aria-valuenow 不動 → 不送鍵、不假裝在邊緣；恢復後照常維持
run('進度條凍住', null, (p, ld, tick) => {
  tick(true, 20);
  const k = p.keys;
  p.frozen = true;
  tick(true, 120);
  const s = ld.status();
  const during = { keys: p.keys - k, frozen: s.frozen, behind: s.behind, edge: p.fakeEdgeOn };
  // 恢復：播放器的介面追上真正的位置
  p.frozen = false; p.pos += p.frozenLag; p.frozenLag = 0;
  tick(true, 30);
  const s2 = ld.status();
  during.keys === 0 && during.frozen && during.behind === null && during.edge === false
    && !s2.frozen && s2.frozenTimes === 1 && near(p.behind(), 45) && !s2.stopped
    ? ok(`進度條凍住 2 分鐘（影片照播）：不送鍵、不假裝在邊緣、診斷標「凍住」；恢復後照常維持 ${p.behind().toFixed(0)} 秒`)
    : fail('進度條凍住：' + JSON.stringify({ during, after: { frozen: s2.frozen, times: s2.frozenTimes, behind: p.behind(), stopped: s2.stopped } }));
});

// 13. 播放器重建（2026-11-01 R19 排位實測）：<video> 換了一個、進度條換成新的時間軸 → 重新量，當成剛進直播
//     a. 斷線重連：新時間軸比舊的小 → 舊版讀出「落後 560 秒」、以為使用者往回拉而不介入，整段沒有延遲
//     b. 節目 → 排位（同一頁換片）：新時間軸比舊的大 → 舊版沒扣剛進直播的額外倒退量，退過頭再往前修（多跳一次）
const rebuild = (p, pos) => {
  const nv = Object.defineProperties({}, Object.getOwnPropertyDescriptors(p.v));
  const gone = p.v;
  p.v = null;
  return { back() { p.v = nv; p.pos = pos; p.edge = pos + 3000; p.extra = 8; p.pending = 0; }, gone };
};
run('播放器重建（時間軸變小）', null, (p, ld, tick) => {
  tick(true, 30);
  const r = rebuild(p, 500000);
  tick(true, 200);   // 斷線約 3.5 分鐘：沒有 <video>
  r.back();
  tick(true, 30);
  const s = ld.status();
  near(p.behind(), 45) && s.behind !== null && near(s.behind, p.behind(), 6) && p.fakeEdgeOn === true && !s.stopped
    ? ok(`斷線後播放器重建（新時間軸較小）：重新量、拉回落後 ${p.behind().toFixed(0)} 秒，LIVE 標記維持在邊緣`)
    : fail('播放器重建（時間軸變小）：' + JSON.stringify({ real: p.behind(), measured: s.behind, edge: p.fakeEdgeOn, stopped: s.stopped }));
});
run('播放器重建（時間軸變大）', null, (p, ld, tick) => {
  tick(true, 30);
  const over0 = ld.status().overFixes || 0;
  const r = rebuild(p, 9000000);
  tick(true, 6);
  r.back();
  tick(true, 40);
  const s = ld.status();
  near(p.behind(), 45) && (s.overFixes || 0) === over0
    ? ok(`同一頁換片（新時間軸較大）：照剛進直播扣掉額外倒退，一次到位落後 ${p.behind().toFixed(0)} 秒、沒有往前修`)
    : fail('播放器重建（時間軸變大）：' + JSON.stringify({ real: p.behind(), overFixes: (s.overFixes || 0) - over0 }));
});

// 11. LIVE 標記
run('LIVE 標記', null, (p, ld, tick) => {
  tick(true, 15);
  p.fakeEdgeOn === true ? ok('延遲中 LIVE 標記維持「在邊緣」（藍色）') : fail('延遲中 LIVE 標記會變灰（使用者看得出來）');
});

console.log('');
if (errors.length) { console.log(`❌ ${errors.length} 項未通過`); process.exit(1); }
console.log('✅ 直播延遲畫面控制器全部正確');
