# PitLingo

F1TV 繁體中文即時字幕。攔截 F1TV 官方英文字幕（CC），用 Claude Haiku 翻成台灣用語的繁體中文，雙語疊在畫面上。

> **服務已於 2026 年 11 月停止營運，程式碼以 MIT 授權開源。**
> 原本的後端（`api.pitlingo.com`）與網站已經關閉。要使用，必須自己部署後端，見下方「自己架設」。

本專案與 Formula 1、Formula One Management、F1TV 沒有任何關係。使用時請自行遵守 F1TV 的服務條款。

## 內容

| 資料夾 | 是什麼 |
|---|---|
| `extension/` | Chrome／Edge 擴充功能（Manifest V3）。建置出三個版本：正式版、測試版（多了語音辨識與彈幕等實驗功能）、管理版（多了賽前整軌收割） |
| `backend/` | Cloudflare Workers 後端：共用譯文快取（KV）、翻譯（Anthropic API）、授權與登入、金流（綠界）、直播多人共用翻譯（Durable Objects）、代訂庫存與帳本（D1） |
| `legal/` | 網站（Cloudflare Pages）：首頁、購買、帳號、條款、後台頁面 |
| `tools/` | 建置、部署與約 60 項契約／行為檢查 |

細節請看 [`extension/README.md`](extension/README.md) 與 [`backend/README.md`](backend/README.md)。

## 運作方式

字幕的取得分三層，任何一層失效只是變貴，不會壞：

1. **整軌預抓**：從 worker 攔到的 m3u8 找出字幕軌，開播前把整部影片的字幕一次翻完
2. **Worker 注入**：F1TV 的串流請求都在 blob Web Worker 內，主執行緒 patch 不到，所以注入到 worker 裡攔 VTT
3. **DOM 逐句翻譯**：最後的退路，讀播放器字幕元素的 `textContent`

翻好的譯文寫進共用快取，同一支影片之後的觀眾直接命中、不用再付翻譯費。實測整軌預抓每句約 US$0.000155，兩小時正賽約 US$0.31。

## 自己架設

需要：Node.js（開發時用 v24）、Cloudflare 帳號（Durable Objects 用 SQLite 後端）、Anthropic API key。

```bash
# 1. 檢查（不需要任何帳號）
node tools/build-extension.js
node tools/check-all.js
```

```bash
# 2. 後端
cd backend
wrangler kv namespace create SUBS          # 把 id 填進 wrangler.toml
wrangler d1 create pitlingo-resell         # 把 database_id 填進 wrangler.toml
wrangler d1 migrations apply pitlingo-resell --remote
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ADMIN_TOKEN            # 自己產生的長隨機字串
wrangler secret put TOKEN_SECRET           # 自己產生的長隨機字串
wrangler deploy
```

`wrangler.toml` 裡所有 `<你的 …>`、`you@example.com`、`pitlingo.com` 都要換成你自己的值。其他選用的機密（寄信、Google 登入、Turnstile、綠界）見 [`backend/README.md`](backend/README.md)。

```bash
# 3. 擴充功能：把 extension/src/shared/defaults.js 的 BACKEND 改成你的 Worker 網址，再建置
node tools/build-extension.js
```

到 `chrome://extensions` 開啟開發人員模式 → 載入未封裝項目 → 選 `dist/pitlingo-release`。
**不要直接載入 `extension/`**：那份原始碼同時含有測試版的程式碼。

## 沒有放進來的東西

- **網站照片與示範影片**：照片來源的授權無法證明，示範影片含 F1TV 畫面。網站照樣能開，那些位置會是空白（清單在 `tools/lib/omitted-media.js`）
- **固定測試資料**（`tools/fixtures/`）：內容是 F1TV 字幕原文，不散布。沒有時 `check-all` 會印警告但不擋
- 營運文件、行銷素材、使用者診斷報告與所有客戶資料

## 授權

[MIT](LICENSE)
