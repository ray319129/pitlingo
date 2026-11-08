/**
 * 開源版刻意不附的網站素材。
 *
 * - /img/*.jpg：照片的來源與授權無法證明，不能再散布
 * - /demo-*.mp4、/demo-*.jpg、/f1tv_*_plan.jpg：含 F1TV 的畫面或截圖（F1 的素材）
 * （/icon128.png 是自家圖示，已放在 legal/）
 *
 * 網站照樣能開，這些位置會是空白。要自己架站時換成你有權使用的素材。
 * check-links 與 check-assets-used 讀這份清單，把它們當成「已知缺少」而不是錯誤。
 */
'use strict';
const OMITTED = /^\/(img\/[^/]+\.jpg|demo-[^/]+\.(mp4|jpg)|f1tv_[a-z]+_plan\.jpg)$/;
module.exports = { isOmitted: (p) => OMITTED.test(p) };
