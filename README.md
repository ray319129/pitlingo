# PitLingo（開源版）

F1TV 繁體中文字幕。讀取 F1TV 官方英文字幕（CC），用 Claude 翻成台灣用語的繁體中文，雙語疊在畫面上。

> PitLingo 原本是付費服務，**2026 年 11 月停止營運**，改成這個開源版：
> **沒有任何 PitLingo 伺服器**，翻譯用你自己的 Anthropic API key，費用直接記在你的 Anthropic 帳戶。

本專案與 Formula 1、Formula One Management、F1TV 沒有任何關係。使用時請自行遵守 F1TV 的服務條款。

## 安裝

1. 下載這個 repo（Code → Download ZIP），解壓縮
2. Chrome 或 Edge 打開 `chrome://extensions`，右上角開啟「開發人員模式」
3. 「載入未封裝項目」→ 選 `extension` 資料夾
4. 點工具列的 PitLingo 圖示 → 貼上 Anthropic API key → 「儲存並測試」
5. 打開 F1TV 的任一支影片

API key 到 [Anthropic Console](https://console.anthropic.com/settings/keys) 建立。**建議替這把金鑰設定每月花費上限。**

## 要花多少錢

依 PitLingo 營運期間用 `claude-haiku-4-5` 實測：整軌預抓每句約 US$0.000155，**一場兩小時的正賽約 US$0.3**。
價格以 [Anthropic 官方定價](https://www.anthropic.com/pricing) 為準。

- **重播**：開始播放時把整支影片的字幕一次翻完（之後拖動進度條也有中文）。只看十分鐘也會翻完整支。
- **直播**：邊播邊翻。
- **同一支影片看第二次不再花錢**：譯文存在本機快取（最近 20 支影片）。
- 設定頁會顯示今天用了多少 tokens；實際金額看 Anthropic Console。

## 運作方式

| 層 | 做什麼 |
|---|---|
| 整軌預抓 | 從播放器的 m3u8 找出字幕軌，把整支影片的 VTT 抓下來先翻好 |
| Worker 注入 | F1TV 的串流請求都在 blob Web Worker 裡，主執行緒攔不到，所以注入到 worker 裡攔 VTT |
| DOM 逐句 | 最後的退路：讀播放器字幕元素的文字 |

顯示獨立於上面三層：每 250ms 讀一次 F1TV 的字幕元素，對到譯文就疊上中文。

| 檔案 | 內容 |
|---|---|
| `extension/src/background/sw.js` | 呼叫 Anthropic、本機譯文快取、抓 m3u8／VTT（網址白名單） |
| `extension/src/content/inject.js` | 注入 F1TV 的 Web Worker 攔字幕（MAIN world） |
| `extension/src/content/main.js` | 偵測字幕、排批次、顯示疊字、診斷 |
| `extension/src/shared/prompt.js` | 翻譯用的 system prompt（F1 術語與台灣用語） |
| `extension/src/shared/normalize.js` | 快取鍵與譯文守門（擋掉模型的自言自語） |
| `extension/src/shared/defaults.js` | F1TV 的選擇器。**F1TV 改版導致抓不到字幕時改這裡** |

## 隱私

見 [PRIVACY.md](PRIVACY.md)。簡單說：擴充功能只連 F1TV 與 api.anthropic.com，不收集任何資料，API key 與譯文只存在你的瀏覽器。

## 疑難排解

在 F1TV 分頁按 F12 → Console，左上角把 `top` 切到 **PitLingo**，可以用：

| 指令 | 用途 |
|---|---|
| `__pitlingo.diag()` | 診斷報告（回報問題時附上） |
| `__pitlingo.events()` | 事件時間軸 |
| `__pitlingo.hud(true)` | 畫面上的即時狀態面板 |

## 開發

```bash
node tools/test-sw.js           # service worker：請求格式、本機快取、守門、錯開一格（不花錢）
node tools/smoke-extension.js   # content script 在假 DOM 裡跑一遍
```

`extension/` 可以直接載入，不需要建置。

## 授權

[MIT](LICENSE)
