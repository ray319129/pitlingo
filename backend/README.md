# f1zh-api — 共用譯文後端

Cloudflare Workers + KV。對應 `handoff.md` 路線圖的 **P1**。

## 為什麼需要它

所有人看同一支影片拿到的是**同一份英文字幕**，所以譯文可以共用。

```
第一次有人看  → 翻譯一次 → 存進 KV
之後所有人    → 直接下載，零 API 呼叫
```

| | 各自翻譯 | 共用快取 |
|---|---|---|
| 每用戶每月 API 成本 | $0.62 ~ $2.40 | **趨近 $0** |
| 整季全站 API 成本 | 隨用戶數線性成長 | **固定約 US$40** |

---

## 原始碼結構（2026-10-28 拆檔）

後端原始碼在 `backend/src/parts/NN-名稱.js`（28 片，依功能切開）。**依檔名順序接起來就是完整的一份**，
所有片段共用同一個作用域（不是 ESM 互相 import），所以拆檔前後的建置結果逐位元相同。

- 建置：`tools/build-backend.js` 接起來 → 移除 `@test-only` → `dist/release/index.js`／`dist/test/index.js`
- 檢查工具一律透過 `tools/lib/backend-src.js` 的 `readBackend()` 讀，不要自己去讀某一片
- 新增片段：兩位數字開頭決定順序；`export default`（fetch 處理）一定在最後一片
- ⚠️ **不要再建立 `backend/src/index.js`**——`check-all` 看到就變紅（兩份來源一定會漂移）
- 單片不是合法程式（函式可能用到別片的宣告），語法與「引用不存在的名稱」檢查都對接起來的整份跑

## 部署步驟

### 1. 安裝 wrangler 並登入

```bash
npm install -g wrangler
wrangler login
```

### 2. 建立 KV namespace

```bash
cd backend
wrangler kv namespace create SUBS
```

把回傳的 `id` 填進 `wrangler.toml` 的 `[[kv_namespaces]]`。

### 3. 設定機密

```bash
wrangler secret put ANTHROPIC_API_KEY   # 你的 Anthropic 金鑰
wrangler secret put ANTHROPIC_API_KEY_HARVEST   # （可省略）收割端用的金鑰，放另一個 Console workspace：帳單、花費上限、速率限制分開（v5.72）
wrangler secret put ADMIN_TOKEN         # 自己想一個長字串，只有你知道
wrangler secret put CLIENT_TOKEN        # 自己想一個長字串，會放進 userscript
```

**後台的鑰匙請用工具產生，在你自己的終端機執行**（在 Claude Code 裡會拒絕，避免新鑰匙進對話紀錄）：

```bash
node tools/rotate-admin-secrets.js
```

| 機密 | 用途 |
|---|---|
| `ADMIN_TOKEN` | 後台登入。所有 `/v1/admin/*` 與 `POST／DELETE /v1/config` |
| `ADMIN_TOTP_SECRET` | 後台第二把鎖（驗證器 App 的 6 位數）。登入時驗一次，之後帶 4 天工作階段 |
| `HARVEST_TOKEN` | **只能收割**：`POST /v1/subs`、`POST /v1/admin/harvest/plan`、`GET /v1/admin/bundles`、`POST /v1/admin/bundles/slugs`，標頭 `x-harvest-token`，不需要動態碼（失敗鎖定、稽核照常）。放在 userscript 裡的是這一把，不是 ADMIN_TOKEN。**v5.56 起也能打 `/v1/translate`**（管理版擴充功能的收割翻譯經過後端）：成本記在 ustats 的 `harvest`，另外熔斷（`HARVEST_USD_CAP`，預設 10 美元，超過回 E80），不影響使用者的 `DAILY_USD_CAP`；帶了但打錯一律 401 |

**綠界的測試收銀台預設關閉。** 綠界的測試金鑰是官方公開的（也寫在這個 repo 裡），
以前 webhook 會接受測試金鑰簽的通知——任何人都能偽造「付款成功」換到授權（handoff 坑 #41）。
要走一次完整的測試流程時才暫時打開，測完**立刻刪掉**：

```bash
wrangler secret put ECPAY_ALLOW_STAGE      # 值填 1
wrangler secret delete ECPAY_ALLOW_STAGE   # 測完一定要刪
```

即使打開，測試簽章也只認「當初以 `mode: "stage"` 建立」的訂單，正式訂單永遠不認。

**語音辨識字幕只在測試後端（2026-09-17 起）。** 正式後端 `api.pitlingo.com` 沒有這些端點（`tools/build-backend.js` 建置時移除，`wrangler deploy` 自動執行）。
測試後端是另一個 Worker `f1zh-api-test`（`https://f1zh-api-test.pitlingo.workers.dev`），與正式後端共用 KV，但**只回應 `/v1/asr/*` 與 `/v1/health`**，沒有網域、沒有排程。機密要另外設：

```bash
npx wrangler deploy --config wrangler.test.toml
npx wrangler secret put ASR_TEST_KEY      --config wrangler.test.toml   # 自己想一個長字串，填進測試版設定頁
npx wrangler secret put DEEPGRAM_API_KEY  --config wrangler.test.toml   # 或 OPENAI_API_KEY（兩個都有時用 Deepgram）
npx wrangler secret put ANTHROPIC_API_KEY --config wrangler.test.toml   # 整份翻譯用
npx wrangler secret put TOKEN_SECRET      --config wrangler.test.toml   # 頻率限制的雜湊金鑰，隨便一個長字串
```

沒設 `ASR_TEST_KEY` 時 `/v1/asr/test` 一律 404。

`POST /v1/asr/test?translate=0&words=1`（實驗室收割用）：只辨識不翻譯、回傳逐字時間 `words: [{ w, start, end, c }]`（幻覺句與信心 < 0.3 的字已移除）。
`POST /v1/asr/test/translate` `{ lines: [...] }`：整份逐字稿分批翻譯，一次最多 60 句，回 `{ out: [{ en, zh }], usd }`，用量記進成本統計（熔斷算得到），不寫共用快取。

每日辨識上限預設 120 分鐘（vars `ASR_DAILY_MINUTES`），超過回 429 `E72` 且不呼叫辨識服務。錯誤碼：`E70` 沒有辨識金鑰、`E71` 音訊大小不對、`E73` 辨識服務出錯。**辨識結果不寫進共用快取。**

### 3b. 寄信 —— Cloudflare 主力、Resend 與 ZeptoMail 備援（v5.88 起）

所有信都走 `sendMail()`（`src/parts/12-payment-webhook.js`），依序試、沒設定的跳過、前一家失敗換下一家：

| 順序 | 服務 | 設定 | 額度與價格（2026-11-03 查官方文件） |
|---|---|---|---|
| 1 | Cloudflare Email Sending | `wrangler.toml` 的 `[[send_email]] name = "EMAIL"`；網域要先啟用：`wrangler email sending enable pitlingo.com`（或主控台） | Workers Paid 每月含 3,000 封、超過每千封 US$0.35；**Beta**，新帳號每日額度未公布 |
| 2 | Resend | `wrangler secret put RESEND_API_KEY`（下面的步驟） | 免費版每月 3,000、每天 100 封 |
| 3 | Zoho ZeptoMail | `wrangler secret put ZEPTOMAIL_TOKEN`（Mail Agent 的 Send Mail Token，不含 `Zoho-enczapikey` 前綴）；`ZEPTOMAIL_URL` 選填，照後台顯示的 API 網址（預設 `https://api.zeptomail.com/v1.1/email`；cpaas.zoho.com 實測回 500） | 每 1 萬封 US$2.50、6 個月內有效，首 1 萬封免費 |

⚠️ 前一家逾時但其實寄出時，下一家會再寄一次（收件人收到兩封）——寧可重複也不要寄不到。
⚠️ 三家的寄件網域都要做 SPF／DKIM 驗證；`MAIL_FROM` 是共用的。
⚠️ 平常第一家成功就停，備援永遠測不到——後台 `POST /v1/admin/mail/test` 帶 `{"via":"cloudflare"|"resend"|"zeptomail"}` 只用那一家寄一封測試信，回 `{ok, via, status, tried}`。

#### Resend：網域驗證 → API key

**沒有這一步，Email 驗證碼登入會回「尚未開放」，授權碼信也寄不出去。**

⚠️ **一定要先驗證網域，才產生 API key。** 順序反過來不會報錯——
key 拿得到、程式也跑得動，只是**每一封信都被退回或丟進垃圾郵件**，
而 Resend 的 API 仍然回 200。那是最難查的那種壞法。

#### (1) 在 Resend 加入網域

1. 註冊 <https://resend.com>（免費方案每天 100 封、每月 3,000 封，夠用）
2. 左側 **Domains** → **Add Domain** → 填 `pitlingo.com`
3. 地區選離台灣近的（例如 `ap-northeast-1`）——只影響寄送延遲

⚠️ **填根網域 `pitlingo.com`，不要填 `mail.pitlingo.com` 之類的子網域**，
   除非你打算讓寄件地址也是那個子網域。`MAIL_FROM` 的網域必須與這裡驗證的
   網域相符，不符的話 Resend 直接拒絕。

#### (2) 把三筆 DNS 記錄加到 Cloudflare

Resend 會給你三筆記錄。到 **Cloudflare → pitlingo.com → DNS → Records** 逐筆新增：

| 類型 | 名稱 | 內容 | Proxy |
|---|---|---|---|
| `TXT` | `send`（或 Resend 指定的） | `v=spf1 include:amazonses.com ~all` | — |
| `TXT` | `resend._domainkey` | Resend 給的那一長串（DKIM 公鑰） | — |
| `MX` | `send` | `feedback-smtp.<區域>.amazonses.com`（優先權 10） | — |

⚠️ **Proxy 狀態一定要是「DNS only」（灰色雲朵），不可以是橘色。**
   Cloudflare 的橘雲是給 HTTP 用的，套在郵件記錄上會讓驗證永遠不通過，
   而畫面上只會一直顯示「Pending」——不會有任何錯誤訊息告訴你原因。

⚠️ **DKIM 那串很長，複製時不要斷行、不要漏掉結尾。** 貼完回頭比對前後各 10 個字元。

⚠️ **如果 `pitlingo.com` 已經有 SPF 記錄，不可以再加第二筆。**
   一個網域只能有一筆 SPF，有兩筆等於兩筆都失效。
   要把 `include:amazonses.com` 併進既有那一筆裡。

#### (3) 回 Resend 按 Verify

通常一兩分鐘，最長 72 小時。三個項目都變成綠色的 **Verified** 才算完成。

沒過的話依序檢查：Proxy 是不是灰色 → 名稱有沒有多打 `.pitlingo.com`
（Cloudflare 會自動補網域，打全名會變成 `send.pitlingo.com.pitlingo.com`）
→ 有沒有重複的 SPF。

#### (4) 產生 API key 並寫進 Cloudflare

Resend 左側 **API Keys** → **Create API Key**：

- Name：`pitlingo-worker`
- Permission：**Sending access**（不要給 Full access——這把 key 只需要寄信）
- Domain：限定 `pitlingo.com`

⚠️ **key 只會顯示一次**（`re_` 開頭）。關掉視窗就再也看不到，只能重新產生。

```bash
cd backend
wrangler secret put RESEND_API_KEY
# 貼上 re_xxxxxxxx，按 Enter
```

⚠️ **絕對不要把 key 寫進 `wrangler.toml` 或任何檔案。**
   這個 repo 是公開的，`check-wrangler.js` 會擋，但擋不住你貼進別的地方。

#### (5) 確認 `MAIL_FROM` 對得起來

`wrangler.toml` 的 `MAIL_FROM` 目前是 `PitLingo <noreply@pitlingo.com>`。
**網域部分必須與上面驗證的網域一致**，否則 Resend 會拒絕。
`noreply@` 這個信箱**不需要真的存在**——寄件地址不必收得到信。

#### (6) 驗證真的能寄

```bash
curl -X POST "https://api.pitlingo.com/v1/auth/email/start" \
  -H "content-type: application/json" \
  -d '{"email":"你的信箱@gmail.com"}'
```

- 回 `{"ok":true,...}` 且**信真的收到** → 完成
- 回 `E65`「尚未開放」→ secret 沒設好，或部署還沒生效（重新 `wrangler deploy`）
- 回 `{"ok":true}` **但信沒來** → 網域驗證沒過，去 Resend 的 **Logs** 看退件原因

⚠️ **`ok:true` 不等於信寄到了。** 這支端點刻意對「有沒有這個帳號」回同樣的話
（防帳號列舉），所以**唯一能確認的方式是真的去收信**。

⚠️ 同一個信箱 60 秒內只能要一次碼、每小時最多 5 次——測試時不要連按。

產生隨機權杖：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

### 4. 部署

```bash
wrangler deploy
```

會得到一個網址，例如 `https://f1zh-api.<你的帳號>.workers.dev`

### 5. 驗證

```bash
curl https://f1zh-api.xxx.workers.dev/v1/health
```

預期回傳 `{"ok":true,...}`

---

## API

所有回應皆為 JSON，並帶 CORS 標頭。

### `GET /v1/health`
健康檢查。無需權杖。

### `GET /v1/config`
遠端設定（選擇器、contentId 規則、隱藏用 CSS）。無需權杖。

**這是 `handoff.md` 防禦順位第 1 名的實作。** F1TV 改版時改這裡就能熱修所有用戶，不用等 1~3 天的商店審核。選擇器是**陣列**，依序嘗試——灰度推送期間新舊版可同時支援。

**續訂折扣 2026-10-30 起暫停（v5.79，`RENEW_ENABLED = false`）**：`/v1/plans` 的 `renewPct` 回 `null`、報價與結帳不給續訂價。

**限時活動（v5.70）**：後台「營運設定 → 限時活動」存進 `ops:config` 的 `promo`（`name`、`text`、`pct` 50～95、`keys` ⊂ week／season／season_next、`from`／`until` UTC 秒、最長 31 天、`theme` red／gold）。不合格整個不生效。`/v1/plans` 回 `promo` 與各商品 `promoPrice`；老客戶續訂 9 折只在 `/v1/quote`、`/v1/checkout` 依登入帳號計算（這兩支允許帶 cookie）。`tools/check-promo.js`。

**熱修：後台「營運設定 → 遠端設定（熱修）」**（2026-10-02 起；之前只能用 curl 打 `POST／DELETE /v1/config`）。
可以直接編輯 JSON 推送、一鍵緊急停用（killSwitch）、還原為內建預設。推送前檢查 JSON、`sites`、版本號要變大。
`GET /v1/admin/config` 回報目前生效的是內建還是 KV 熱修版（公開的 `GET /v1/config` 分不出來）。

⚠️ **KV 熱修版會蓋過之後每一次部署的內建設定**——賽程與免費範圍也在這份設定裡。修完、部署修正之後一定要還原。

### `GET /v1/subs?cid=<contentId>`
取回整支影片的譯文。需 `X-Client-Token`。
**v5.49 起套用與 /v1/translate 相同的免費場次規則**：沒有有效通行證（或不是收割工具）時，收割標成非免費場次的影片回 402 `E31`。
免費額度用完**仍然可以讀**（既定設計）。`segCount` 對一般用戶端是 max(收割的, 其他觀眾回報的 `clientSeg`)，對收割工具只給收割蓋的那個。

```json
{ "cid": "1000010512", "count": 1101, "updatedAt": "...", "lines": { "<正規化原文>": "譯文" } }
```

### `POST /v1/subs`
上傳譯文。需 `X-Admin-Token`。採**合併**寫入，不會覆蓋既有內容。

```json
{ "cid": "1000010512", "lines": { "<原文或正規化後的 key>": "譯文" }, "segCount": 1372, "v": "4.13.1" }
```

`segCount` 只在整軌收完、每一句都有結果時才帶（＝標記完整）。`v` 是蓋章的 userscript 版本，
後端記成 `markV`：**v4.13.0 以後蓋的章才被信任**（v5.57 起也接受管理版擴充功能的 `ext-x.y.z`，用自己的門檻 `EXT_MARK_TRUSTED_FROM`＝0.37.0 判斷），之前的若句／段比例低於本季同類場次中位數的 75%，
會被列為「可疑」並排回收割計畫（見 handoff 坑 #62）。分段數與既有的相同時也接受（重新驗證要能重新蓋章）。
**v5.49 起也接受比較小的**（往下修正；以前被灌過大的值修不回來）。帶 `slug` 時會蓋掉用戶端寫的後綴（`slugBy: 'client'` → `'harvest'`）。

### 翻譯清單的維護端點（需 ADMIN_TOKEN）

| 端點 | 作用 |
|---|---|
| `POST /v1/admin/bundle/unmark` `{cid}` | 撤銷完整標記（segCount 歸零），讓它回到收割計畫重新驗證。**譯文不刪** |
| `POST /v1/admin/bundle/drop` `{cid}` | 整份刪除。**只接受一句都沒有的**（壓測殘留等），有譯文一律拒絕 |
| `POST /v1/admin/bundle/purge` `{cid, keys}` | 刪掉指定的幾句 |

**時間軸（v5.95）**：`POST /v1/subs`（收割蓋章）可以多帶 `times: { 句子: 秒 }`，存成 bundle 的 `t`（`mergeLineTimes`：只收這份 bundle 有譯文的句子、0～86,400 秒、取到 0.1 秒；譯文被刪掉的句子時間一起清掉），回應多 `timed`。**搭那一次本來就要寫的 KV，不多寫。** `GET /v1/admin/bundle` 回 `t`，後台依它排序並標時間；`GET /v1/subs`（用戶端）**不回**。

### `POST /v1/translate`
翻譯尚未快取的句子。需 `X-Client-Token`。

伺服器先查 `line:` 快取，未命中才呼叫 Anthropic，翻完寫回快取。**金鑰只存在伺服器端。**

```json
{ "cid": "1000010512", "lines": ["English line 1", "English line 2"] }
```

回應含 `cached` / `translated` / `usage`，可用來確認共用是否生效。

**額度（v5.49，坑 #94）**：只有真的要呼叫模型的句子才在 AuthGuard 預扣（`reserve`），翻完退回沒用到的（`refund`）。
- 免費：遊客 300 句／登入 800 句（每天，UTC），同一個 IP（IPv6 以 /64 計）另有 3 倍上限。用完時快取裡已有的句子照給（200，帶 `code: 'E30'`），一句都沒有才回 402。AuthGuard 連不上 → 不翻（`E41`）。
- 付費：每天每安裝 40 萬字元、每帳號 60 萬字元（`LICENSED_DAILY_CHARS`）；超過回 200 `code: 'E33'`，只擋那個人。AuthGuard 連不上 → 放行（全站 `DAILY_USD_CAP` 熔斷仍在）。
- 預扣在 SubtitleRoom 認領之前；認領了卻沒翻出來的句子用 `release` 放掉。

---

### 前導收割端：`POST /v1/leader/beat`、`GET /v1/leader/status`、每 5 分鐘巡查（v5.66）

- **SubtitleRoom 的結果存在 DO storage**（v5.66，坑 #98）：DO 閒置 10 秒就休眠、記憶體丟掉，所以前導端翻好的句子一分鐘一列（`res:<分鐘>`，每句 [譯文, 時間]）寫進 storage，醒來讀回、**15 分鐘**過期（v5.67：要蓋過晚加入觀眾一次補抓的整個直播滑動視窗，約 10 分鐘）、過期列刪掉。免費方案 DO 每天 10 萬列寫入，一次 done 一列。
- `POST /v1/leader/beat`（收割權杖或付費）：心跳／離開。除了該影片的 SubtitleRoom，**也記一份全域的**（`leader-global`）。
- `GET /v1/leader/status`（收割權杖或付費）：`{ leaderAt, leaderByeAt, present }`。備援機的待命模式靠它判斷主機在不在。
- **cron `*/5 * * * *`**（`leaderWatch`）：場次或節目（`/v1/schedule` 的 `shows`）表定開始後 10～15 分鐘，全域心跳超過 3 分鐘 → 寄信到 `LEADER_ALERT_TO`（沒設用 `REPORT_TO`），每場一封。不寫 KV。
  ⚠️ cron 字串要與 `LEADER_WATCH_CRON` 一字不差（`scheduled` 靠 `event.cron` 分流；`check-leader-watch` 會擋）。
- **觀眾那邊的「前導收割端不在」告警**（`leaderDownAlert`，2 小時一封）：先看全域心跳——收割端在別支影片上（節目與正式場次重疊）就**不寄**，哪裡都不在才寄。
- **收割端拿不到影片編號**（`leaderNoCidAlert`）：收割權杖＋`live`＋非數字 cid 的翻譯請求 → 寄信（2 小時一封）。那些譯文進 `misc`，不共用、不進快取（R18 排位實例）。
- `/v1/schedule` 每站多 `slugs` 與 `shows`（`GP_SHOWS`，節目時間從正式場次推算）。
- **F1TV 賽事頁的真實時程**（v5.68，A4）：`POST /v1/admin/harvest/f1tv-schedule`（收割權杖）收 `{ gpId, items: [{ kind, at, end, cid, href }] }`，`f1tvSchedClean` 嚴格驗證（時間限該站週末、網址 cid 一致、一定要有正賽且與官方差不到 2 小時），內容變了才寫 `f1tvsched:v1`。有它時 `shows` 改用 F1TV 的時間（`src: 'f1tv'`），每站另有 `f1tv`（kind → `{ cid, href }`）；正式場次時間仍以官方為準，對不上只回 `mismatch`。
- **收割端即時狀態**（v5.75）：`POST /v1/admin/harvest/status`（收割權杖）收 `{ id: '<設定檔>-<分頁>', status }`，`harvestStatusClean` 只留認得的欄位（面板文字、進度條位置／總長、影片時間、落後邊緣、凍住、rAF、視窗、自動開直播模式、前導心跳、目前字幕）；存 `leader-global` 這個 SubtitleRoom 的 storage（`hstat:<id>`，不寫 KV），最多 6 張、6 小時沒更新就丟。`/v1/admin/live` 回 `harvesters`（新的在前）與 `nowMs`（後台算時鐘差）。
- **逐句紀錄**（v5.85，handoff A25）：`handleTranslate` 每個請求回應後（`ctx.waitUntil`）送 `op: plog` 給該影片的 SubtitleRoom，存 storage `plog:<15 位毫秒>:<亂數>`、14 天（`PLOG_KEEP_MS`，寫入時 2% 機率順手刪舊的）。內容：`who`（`harvest` 或 installId 前 8 碼）、`plan`／`live`／`ldr`／`urg`／`t0`／`t1`，以及每句 `lineHash`（cyrb53，不存原文）的去向 `c`／`r`／`w`／`m`／`x`／`d`（`PLOG_SRC`）。misc 不記。`GET /v1/admin/linelog?cid=&from=&to=&dump=1`（adminGate）→ `op: plogSum` → `plogSummary`：`who`（每人每種去向的句數）、`model`（`translations`／`unique`／`extra`＝重複翻次數，分 `same` 同一請求內、`race` 同時在翻、`late` 翻好了還再翻；`pairs` 先翻 → 後翻）、`dups`（前 50 句明細）。一次最多讀 20,000 筆（`truncated`）。每個翻譯請求多 1 次 DO 請求＋1 列寫入，不寫 KV。`check-line-log` 驗。
- **共用快取的寫入緩衝在 SubtitleRoom**（v5.68，A15）：`done` 帶 `buffer: true, cid, slug` → 房間回 `buffered`（接手的句子），有新句子排 90 秒後的鬧鐘，`alarm()` 把翻好時間晚於 `flushedAt` 的 `res:` 句子 `mergeWrite` 進 KV（失敗 2 分鐘後重試）；房間寫了幾次 KV 由下一個 `done` 的 `kvPuts` 帶回 isolate 記帳。`op: dump` 給 GET /v1/subs 併入房間 15 分鐘內的句子（bundle 20 分鐘內有更新時才問）。
- **翻譯統計**（v5.68，A11）：加法在 AuthGuard（`op: stats`），KV 的 `stats:`／`ustats:` 是快照、每個鍵最多 5 分鐘寫一次（鬧鐘補寫）；讀近兩天的走 `readStatsDay` → `op: statsGet`。
- **速率限制**（v5.68）：有 `env.RL`（wrangler.toml `[[ratelimits]]`，Cloudflare Rate Limiting binding）就用它，不寫 KV；沒有時退回 KV 取樣（每 25 次寫一次）。官方文件沒寫免費方案能不能用，2026-10-26 實際部署：**免費方案接受**。

### `POST /v1/coverage`（v5.51，擴充功能測試版用）

`{ cids: [...] }`（最多 100 個，需 `x-client-token`）→ `{ map: { <cid>: 'ready'|'partial'|'nosub' } }`。沒有資料的 cid 不回。
整張狀態表放 Cache API（每個機房 30 分鐘），不會每次 list KV。

### `POST /v1/account/license/gift`（v5.51，**預設關閉**）

`{ licenseKey, gpId, to }`（網站 cookie）。把一站還沒開始的**附贈**比賽週轉給 `to`：拆成綁 `to` 帳號的新碼並寄信。
`[vars] GIFT_TRANSFER = "1"` 才開；沒開時 403。每站一次（AuthGuard once）、每組碼每天 5 站。**2026-10-11 起已開啟**（v5.55），條款第七條同步（check-legal 8）。

**Turnstile（2026-10-11 起啟用）**：驗證碼登入（`/v1/auth/email/start`）要帶 Turnstile token。`[vars] TURNSTILE_SITE_KEY`／`TURNSTILE_HOSTNAMES` ＋ secret `TURNSTILE_SECRET`；沒設 secret 時整個功能不啟用。換 widget 時**先部署變數、最後才設 secret**。

### `POST /v1/complete`

標記「這支影片已被完整收割」，讓後續觀看者跳過整軌預抓。需 `x-client-token`。

```json
{ "cid": "1000010267", "segCount": 383 }
```

**v5.49 起寫的是 `clientSeg`（參考值），不是 `segCount`**（坑 #95）：`segCount` 是收割排程的依據，只有收割能設。
`clientSeg` 只用來讓其他觀眾跳過預抓（GET /v1/subs 回 max）。以下是原本的說明：

**只准往上加。** 一般使用者不該持有 `ADMIN_TOKEN`，
但沒有這個標記的話，每個人開同一支影片都會再向 CDN 抓一次全部分段（實測 383 段、約 80 秒），
而那些分段幾乎不會帶來新句子。

若 bundle 目前沒有任何譯文，請求會被拒絕——否則別人會跳過預抓卻拿到空的。

最壞情況（用戶端算錯或惡意回報）只是讓別人略過預抓、退回 worker 即時攔截（仍有提前量），
不會弄壞既有譯文。

### `GET /v1/site`（公開）與 `/v1/admin/site*`

網站首頁的可編輯內容。公開端只讀、邊緣快取 30 秒；寫入一律走後台門檻。

| 端點 | 用途 |
|---|---|
| `GET /v1/site` | 首頁載入時讀取（CORS 只開 pitlingo.com） |
| `GET /v1/admin/site` | 目前內容＋版本紀錄 |
| `POST /v1/admin/site` | 發布 `{ content, note }`，回傳被略過的欄位 `dropped` |
| `POST /v1/admin/site/restore` | `{ version }` 還原成某一版（存成新的一版） |
| `POST /v1/admin/site/demo-candidates` | 從翻譯清單挑模擬畫面的候選句（讀最多 12 支 bundle） |

```json
{ "texts": { "hero.h1": "F1TV 沒有繁體中文字幕？" },
  "hrefs": { "trial.install": "https://chromewebstore.google.com/detail/..." },
  "sections": [ { "id": "demo", "visible": true }, { "id": "vpn", "visible": false } ],
  "demo": { "lines": [ { "en": "...", "zh": "...", "label": "加拿大 · 正賽" } ], "intervalMs": 4200 } }
```

⚠️ 文字只支援 `**粗體**` 與換行；連結只接受站內路徑、`#錨點`、pitlingo.com、Chrome／Edge 官方商店。
不合規則的欄位會被丟掉並列在 `dropped`，不會整份拒絕。

### 訂單

| 端點 | 說明 |
|---|---|
| `GET /v1/order?no=` | 付款結果頁查自己那筆。已付款時回 `planLabel`、`gpName`、`startsAt`、`expiresAt` 與 `services`（同一張訂單裡的代訂，只有名稱與數量）；兩份授權時（本賽季＋下一賽季票）另回 `extra: [{planLabel, gpName, startsAt, expiresAt}]`。**v5.82 起一律不回授權碼**（以前 24 小時內回完整的） |
| `POST /v1/admin/login` | 後台登入畫面用。通過 adminGate（權杖＋動態碼）後回 `{ otpEnabled, session, expiresAt }`。有設 `ADMIN_TOTP_SECRET` 時發 4 天的工作階段（綁來源、輪換權杖或動態碼金鑰即失效），之後的請求帶 `x-admin-session` 取代 `x-admin-otp`。**登入本身一律要動態碼** |
| `GET /v1/admin/orders` | 訂單列表（只讀 metadata）；`?feed=1` 給新訂單通知輪詢 |
| `POST /v1/admin/orders/repair-paid` | **一次性修復**：補上付款成功卻停在「未完成付款」的訂單（handoff 坑 #40），並移除被記成代訂服務的附贈比賽週。`{ "apply": false }`（預設）只試算、回傳會改哪幾筆；`{ "apply": true }` 才寫入。依據是 webhook 發碼時寫下的 `order:<編號>`，可重複執行 |

### 代訂自營（D1，v5.58 起；指派與席次 v5.59；RESELL-OPS.md）

資料放 **D1**（綁定 `RESELL_DB`），不放 KV：帳號、指派、席次、成本彼此關聯，而且「賣第 5 席要被擋」需要交易。

**建立（一次性，要 Ray 同意——這是 Cloudflare 帳號的變更）：**

```bash
cd backend
wrangler d1 create pitlingo-resell                       # 把回傳的 database_id 填進 wrangler.toml 的 [[d1_databases]]
wrangler d1 migrations apply pitlingo-resell --remote    # 套用 backend/migrations/
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" | wrangler secret put RESELL_KEY
```

⚠️ `RESELL_KEY` 是交付用密碼的加密金鑰。**換掉它＝所有已存的密碼都解不開**（要重新輸入）；請另存一份在密碼管理器。
⚠️ 沒綁 `RESELL_DB` 時讀取回 `configured.db: false`、寫入一律 503——**不會退回存 KV**。沒設 `RESELL_KEY` 時可以新增帳號，但拒絕存密碼（不會改存明文）。

| 端點 | 說明 |
|---|---|
| `GET /v1/admin/search?q=` | **全域查詢**：客戶 email、訂單編號、授權碼、或我方 F1TV 帳號的信箱／備註／密碼管理器項目名稱。回客戶視圖（與帳號頁同一支 `accountView`）、訂單、授權、F1TV 帳號、代訂事件。**訂單清單不走 5 分鐘快取**；KV 跨機房最多約 60 秒的延遲寫在回應的 `notes` |
| `GET /v1/admin/resell` | 代訂分頁的全部資料：帳號（**不帶 `pw_enc`**，只有 `has_pw`）、採購區（`stale`：超過 30 天沒核對）、每個帳號的成本加總、摘要（各狀態數、7 天內扣款／到期） |
| `POST /v1/admin/resell/account` | 新增或修改（帶 `id`）。`password` 有給才動密碼，`clearPassword: true` 清掉。改登入信箱時要重新給密碼（密文的 AAD 綁信箱）。不收完整卡號；共用帳號（`status: shared`）只能是 Premium |
| `POST /v1/admin/resell/reveal` | `{ id }` → 解密交付用密碼。**每次都記一筆 `pw_reveal`，先記再給** |
| `POST /v1/admin/resell/cost` | 一期的實付：`amount_twd` 以信用卡帳單實扣為準 |
| `POST /v1/admin/resell/region` | 採購區牌價；每存一次 `checked_at` 就更新成現在 |
| `POST /v1/admin/resell/deliver` | （v5.61）代理商交付：`{ id, login_email, password, agent_sku?, share?, cost_cny?, cost_twd? }` → 加密進庫存（`source: agent`）、綁指派、開通、記成本、寄「請登入我的帳號查看」通知信（信裡沒有密碼）。充值（自備）不適用 |
| `POST /v1/admin/resell/remail` | `{ id }` 重寄交付通知 |
（v5.62）`POST /v1/admin/resell/account` 對**代理商帳號**另收 `agent_sku`、`share`（交付時品項填錯用）；自營帳號帶這兩欄會被拒絕。
| `POST /v1/account/f1/reveal`（網站，登入 cookie） | `{ id }` → 客戶看自己代訂帳號的密碼。CSRF、每帳號每小時 30 次、no-store，**每次記一筆 `cust_reveal`**；週末共用週五 00:00（台灣）前與期間結束後都拒絕 |
| `GET /v1/admin/resell/events` | 事件紀錄（`?account_id=` 篩單一帳號） |
| `POST /v1/admin/resell/sync` | 補同步：已付款但還沒有指派的代訂訂單建成「待處理」、退款的取消。**付款當下 webhook 已經會做**，這支只是補漏；會列舉整個 `ord:`（list 也算 1,000/天），一次最多讀 50 筆訂單 |
| `POST /v1/admin/resell/assign` | `{ id, account_id? }`。我們提供：一定要給 `account_id`，帳號要「可指派」且方案等級相符。共用：不給就自動挑（先塞滿已經有人的帳號），滿了回 409。**自備帳號一律拒絕**（不連結任何帳號，資料庫也有 CHECK） |
| `POST /v1/admin/resell/assignment` | `{ id, action }`：`activate`（可帶 `starts_at`；留空＝今天，共用＝那個週末週五 00:00 到正賽後 3 小時；同時把訂單的代訂項目標成 done）／`end`／`revoke`（違規，`note` 寫原因）／`cancel`／`unassign`／`note` |
| `GET/POST /v1/admin/mail/content` | 寄信內容（v5.94）：GET 回 `defs`（每封信的預設標題／內文／變數）、目前發布的 `content`、版本紀錄；POST `{texts:{"welcome.subject","welcome.body"}, note}` 發布（先過 `mailContentProblems`，有問題回 400 `problems`）|
| `POST /v1/admin/mail/preview` | `{id, texts}` → `{subject, html, problems}`，草稿預覽，不寫 KV |
| `POST /v1/admin/mail/content/restore` | `{version}`：舊版當成新的一版發布（同樣過檢查）|
| `POST /v1/admin/mail/sample` | `{id, texts, to?}`：用草稿寄一封「[樣本]」給自己（預設 REPORT_TO）|
| `POST /v1/admin/bundle/realign` | `{ cid, dry? }`（v5.92）：伺服器當場讀最新的 bundle，用寬鬆偵測（`shiftSuspectIdx`）刪掉疑似「拿到後一句譯文」的句子；`dry: 1` 只回會刪幾句。`GET bundle/suspect` 另回 `shifted` 清單。後台「翻譯清單」有單支與全部影片兩個按鈕 |
| `GET /v1/admin/growth?since=YYYY-MM-DD[&fresh=1]` | 成長統計（v5.91）：從 since（台灣時間 00:00，預設 2026-11-03）起的新註冊（Google／Email、每日、7／30 天活躍、隔天回訪、註冊後有付費）、訂單（建立／付款／營收／失敗／退款）、使用事件。只讀不寫，記憶體快取 5 分鐘 |
| `POST /v1/admin/resell/settings` | `{ sharedCap: true/false }`：共用帳號席次上限。打開後結帳會先保留名額（2 小時，取號後 3 天），名額＝共用帳號數 × 4 |

**套用第 2 階段（v5.59）：先 migration 再部署**——`wrangler d1 migrations apply pitlingo-resell --remote`，然後 `node tools/deploy.js backend`。反過來的話代訂分頁與結帳的名額檢查會查不到表。

帳號方式（`/v1/plans` 回 `acctModes`、結帳的每一列帶 `acct`）：共用週末＝`shared`；一個月＝`ours`（設了 `RESELL_BYO_MONTHLY="1"` 才多一個 `byo`，限 1 份）；年方案＝`byo`。

本機試：`node tools/resell-lab.js` → `http://127.0.0.1:8796/secret-pitstop.html`（API 位址填同一個網址；資料只在記憶體）。
檢查：`node tools/check-resell.js`（D1 用 `node:sqlite` 直接執行正式的 migration）。

### 帳本（D1，v5.65；migrations/0004_ledger.sql）

只記**真的進出的錢**（現金制）。後台「帳本」分頁。

| 端點 | 用途 |
|---|---|
| `GET /v1/admin/ledger?from=YYYY-MM&to=YYYY-MM` | 先把付款／退款的訂單快照進 `ledger_orders`，再合併三個來源回每一筆＋每月合計（台灣時間分月）。`missingFee` 列出缺綠界手續費的訂單 |
| `POST /v1/admin/ledger/entry` | 人工記一筆：`date`（YYYY-MM-DD，不可未來）、`kind`、`category`（固定清單）、`item`、`amount_twd`（帳單實扣台幣，正整數）、`amount_orig`／`currency`／`receipt`／`note` 選填 |
| `POST /v1/admin/ledger/void` | 作廢（要 `reason`）。**沒有刪除** |
| `POST /v1/admin/ledger/fee` | 補登訂單的綠界手續費（付款通知沒帶的）；通知有帶的回 409 |

- 收入來自訂單，但**快照進 D1**：付款的訂單在 KV 只留 400 天（`ORDER_TTL`），帳要留更久。打開帳本與每日排程各同步一次；狀態沒變的不重讀。
- **付款方式**（v5.71）：訂單總額 ≤ 130 元（`CREDIT_ONLY_MAX`，2026-10-27 從 79 改）一律 `ChoosePayment: Credit`，後台的 `choosePayment` 蓋不過——綠界一般賣家信用卡最低 5 元＋處理費 1 元，超商代碼每筆 31 元，49 元走超商手續費約三分之二。超過門檻照舊用後台設定（預設 ALL）。
- 付款通知（v5.65 起）把綠界的 `PaymentTypeChargeFee`（2025/04 起＝交易手續費＋處理費）、`PaymentType`、`TradeNo`、`TradeAmt` 存進訂單。
- 代訂採購直接讀 `f1_costs`。
- **套用：先 migration 再部署**——`wrangler d1 migrations apply pitlingo-resell --remote`，然後 `node tools/deploy.js backend`。反過來的話帳本分頁 500、每日排程的同步失敗（不影響其他功能）。
- `tools/check-ledger.js`（check-all 會跑）。

### `GET /v1/admin/coverage`

**每一站的每一個場次，我們手上有沒有譯文。** 需 `x-admin-token`。

後台原本只回答得了「已經有什麼」，回答不了「還缺什麼」——而缺的那些，
正是下一場直播會用全額付費重翻一次的東西（實測：R12~R14 三站從未收割，
那幾場直播的共用快取命中率是 0%，每場約 $0.73）。

```json
{ "season": 2026,
  "races": [ { "id": "2026-14", "round": 14, "name": "西班牙（馬德里）",
               "status": "live", "need": 5, "have": 2, "complete": 1,
               "sessions": [ { "kind": "fp1", "label": "第一次自由練習",
                               "cid": "1000010366", "lines": 2396, "complete": false } ],
               "warmup": null } ] }
```

⚠️ **「應該有幾場」直接取自賽程的 `sessions`，不是寫死的數字。** 衝刺賽週的場次
組成不同（只有一場練習、多了衝刺排位與衝刺賽），寫死會讓六個衝刺賽站永遠顯示缺兩場。

⚠️ **賽前暖身不計入分母。** 它不在官方場次表裡，也不是每一站都有——計入的話
覆蓋率永遠到不了 100%，而永遠紅著的指標會被無視，等於沒有。

⚠️ 舊賽季的重播與支援賽事（保時捷超級盃、F1 Academy）**不算本季覆蓋率**。
它們是有價值的快取，但算進去的話「R1 已收割 6/6」可能有一半是 2024 年的。

### `POST /v1/admin/harvest/plan`

**現在該收哪幾場，以及送上來的連結裡哪幾條值得跑。** 需 `x-admin-token`。

不帶 `paths` 時只回答「該收哪幾場」（後台的「現在該收哪幾場」按鈕）；
帶了才額外回傳排好序的待跑佇列（userscript 刮完頁面後送上來）。

```json
{ "liveNow": null, "lagMinutes": 60,
  "todo": [ { "round": 14, "name": "西班牙（馬德里）", "status": "live",
              "missing": ["第一次自由練習", "正賽"], "partial": 0 } ],
  "waiting": [ { "round": 15, "label": "正賽", "readyAt": 1790427600 } ],
  "queue": ["/detail/…/2026-madrid-grand-prix", "/detail/…/2026-madrid-gp-qualifying"],
  "skipped": { "complete": 3, "notMissing": 0, "otherSeason": 2, "support": 1, "unknown": 0, "dup": 0 } }
```

⚠️ **分類邏輯只有這一份。** 複製到 userscript 就是第五個跨檔案的硬性契約，
而這個專案已經有四個、每一個都因為漂移出過事。用戶端只做它獨有、
伺服器做不到的事：把頁面上的連結刮下來（F1TV 有 Imperva，伺服器端爬不了）。

規則：

| | |
|---|---|
| 何時可收 | 場次**結束一小時後**（`HARVEST_LAG_SEC`），等 F1TV 上架 VOD |
| 何時不可收 | 任何場次的開播前 15 分鐘到結束為止（`liveNow`）——收割與影片打同一個 CDN |
| 場次長度 | 一律**往長估**（正賽 2 小時、其餘 1 小時）。估短的代價是跟影片搶頻寬，估長只是晚一點開始，兩邊不對稱 |
| 順序 | 正賽 → 排位 → 衝刺 → 衝刺排位 → 練習 → 暖身。**順序的意義是「被打斷時留下什麼」** |
| 不跑的 | 已經有完整快取的、舊賽季重播、支援賽事（分開計數，處理方式不同） |

### 帳號登入（2026-10-02 加固）

| 端點 | 說明 |
|---|---|
| `POST /v1/auth/email/start` | 寄驗證碼。`{ email, turnstile? }` |
| `POST /v1/auth/email/verify` | `{ email, code }`。成功時設 `__Host-pl_sess` cookie，**回應裡沒有權杖** |
| `POST /v1/auth/google` | `{ credential }`（Google ID token）。同上 |
| `POST /v1/auth/logout` | `{ all? }`。作廢這一枚（擴充功能的權杖連同續期換出來的整個家族）；`all: true` 作廢這個帳號之前簽的全部（含擴充功能） |
| `POST /v1/auth/link/claim` | 網站把擴充功能的配對碼換成一枚**擴充功能專用**的權杖（種類 x、30 天） |
| `GET /v1/auth/link?nonce=` | 擴充功能取回那一枚（單次） |
| `GET /v1/account/me` | 網站用 cookie、擴充功能用 `Authorization: Bearer`。每組授權碼帶 `deviceList`（前 8 碼＋最後使用時間） |
| `POST /v1/account/claim` | `{ email }`（v5.82 起是購買信箱，不再收授權碼）。已在帳號裡回 `already`；否則一律回 `{ needCode, to, ttlSec }`——**沒有購買紀錄、已經屬於別的帳號、信箱自己的冷卻／上限都回同一句而且不寄信**（不是「買過沒有」的探針）；全站與 IP 的上限照實回 E66 |
| `POST /v1/account/claim/verify` | `{ email, code }`。驗證碼對了才把購買信箱併入（E74） |
| `POST /v1/account/license/deactivate` | `{ licenseKey, device }`（8 碼）。只有擁有者（E75）、不限次數、立刻生效 |
| ~~`POST /v1/account/license/reissue`~~ | **v5.82 拿掉**（自助換發）：授權以帳號為準，碼外流別人也用不了，換發擋不到任何東西（E77 保留不再使用） |
| `POST /v1/admin/license/reissue` | 後台換發（客服用，不限次數），寄「授權已重新設定」通知（**不放碼**，請客人在擴充功能登出再登入） |

**擴充功能配對（v5.48）**：`POST /v1/auth/link/start {nonce}`（要 `x-client-token`）→ `{ code }`；網站 `POST /v1/auth/link/claim {nonce, code}`（cookie）；擴充功能 `GET /v1/auth/link?nonce=`（要同一個安裝的 `x-client-token`，否則一律 pending）。
通行證格式 `<installId>.<plan>.<exp>.<iat 毫秒>.<HMAC>`（舊的 4 段照收）；作廢清單 `entvoid` 每筆 `{i, u, t}`，只擋 `t` 以前簽的。
每日總量（AuthGuard，`AUTH_LIMITS`）：complete、nosuball、contact、contactall、contactmailall（網站聯絡表單的通知信，v5.74 起會寄）、report、reportall、activate、admfail、admaudit；
v5.49 加 activatelic（每組碼每天 20 次真的寫入）、deactself（解除自己 10 次）、checkout（每 IP 每小時 20）、checkoutall（全站每天 300）、
metricall（統計落地每天 150）、slugall（只為補後綴的寫入每天 150）、quote（帶升級的報價每 IP 10 分鐘 30 次）、reportmail／reportmailall（回報通知信每安裝 3、全站 30）。
作廢（v5.49）存在 AuthGuard 每台一筆 `v:<installId>`；KV 的 `entvoid` 只讀不寫，14 天內自然過期。
登入端點（google／email start／email verify）有帶 Origin 就必須是 pitlingo.com（login CSRF，E57）。
後台動態碼同一組只能用一次。未付款的訂單（`ord:`）只留 30 天，付款或退款後 400 天。

**v5.83**：會出現在擴充功能與帳號頁的授權訊息改寫成「這份授權」（E79 改成「請先登入……授權就會自動恢復」、E75、查無／已停用、啟用太多次），後台訊息不變。
**授權碼綁帳號（v5.47）**：`POST /v1/license/activate`／`/renew` 都要帶擁有這組碼的帳號的登入權杖（`Authorization: Bearer`，strict）。沒登入 403 `E79`（`needLogin: true`），別的帳號 403 `E75`（`owner` 遮罩）。還沒開始的通行證啟用回 `{ ok, pending, message, startsAt }`（登記裝置、不發通行證）。續期時擴充功能權杖超過 7 天會在回應帶 `accountToken`（新的一枚）。
**以帳號為準（v5.81）**：`/activate` 可以不帶 `licenseKey`——後端從登入帳號挑能用的那組（只認記錄上屬於這個帳號的；有空位 → 原本那組 → 這台已在 → 效期最晚），帳號裡沒有可用的回 404 `E89`。`/renew` 帶的碼不能用（例如本季票到期）而且**這台登記在那組碼上**時，自動換到帳號裡能用的另一組（被解除的裝置不換）。**明確帶了碼的啟用一律不換**。兩者回應都帶 `licenseKey`（實際用的那組，`PL-XXXX-…`）。
**升級折抵（v5.81）**：`/v1/quote`、`/v1/checkout` 的 `upgrade: true` 改看登入帳號（cookie，strict），不再收 `licenseKey`。沒登入回 `creditNote` 要求登入、結帳信箱不屬於帳號也不折。`POST /v1/auth/logout {all:true}` 會連授權一起停（回 `devicesStopped`）。
新裝置登入通知：網站 `__Host-pl_dev` cookie、擴充功能 installId；帳號 `devs` 只存雜湊＋裝置類型＋時間。帳號建立 30 分鐘內加的裝置不寄（`ACCOUNT_FRESH_SEC`；新使用者「網站登入 → 配對擴充功能」那一步不是新裝置）。**歡迎信（v5.84）**：帳號建立的那一次（`loginResponse` 的 `created`，Google 與 Email 驗證碼都算）寄一封 `sendWelcomeMail`——使用方式＋方案介紹＋購買連結，信裡寫明是唯一一封；AuthGuard `welcome`（每帳號 1 封）、`welcomeall`（全站每天 40 封）；失敗不擋登入。
後台 `POST /v1/admin/orders/patch {no, refund:true}`：訂單標 `refunded`、授權停用、裝置作廢（錢在綠界後台退）。

`POST /v1/license/deactivate`（擴充功能）：**v5.82 起只能解除自己這一台**（要帶這台的 `x-client-token`），別台一律 403 `E90`、請到「我的帳號」解除（以前只憑授權碼解除別台 30 天 3 次，E76 保留不再使用）。被解除的那台立刻失效（entvoid）。`POST /v1/license/devices`（只憑授權碼列裝置）v5.82 拿掉。
**一張訂單多組授權碼（v5.81）**：`quoteCart` 回 `extra`（下一賽季票那一組）；webhook 主授權照舊（`order:<訂單>`、訂單 `licenseKey`），其餘寫成獨立的 `lic:`、記在訂單 `extraLicenses`、同一封信列出。退款、改寄信箱、換發、刪除都涵蓋第二組。`/v1/account/me` 的每組授權多 `usable`（現在就能用）與 `startsAt`。

換發掉的舊碼在啟用／續期回 403 + E78（訊息請他登出再登入）。**v5.82：授權碼退出使用者介面**——購買信、轉送信、換發信、`/v1/order` 都不放碼；授權碼只剩後端記錄編號與後台／客服用途。

**AuthGuard（Durable Object，binding `AUTH`，單一實例 `auth-v1`）**：驗證碼雜湊、猜錯次數、冷卻、
每信箱／每 IP／全站限額、鎖定、工作階段撤銷全部在這裡。**不可以搬回 KV**——KV 最終一致而且沒有 CAS，
次數上限與單次使用在並發時不成立（坑 #75）。沒有 `AUTH` 綁定時 Email 登入直接停用（fail closed）。
儲存內容全部是雜湊；每天的鬧鐘會清掉 2 天沒動的紀錄（v5.49 起分頁清，每頁 500、最多 40 頁）。
op：start、verify、limit、peek、reset、check、revoke、revokeAll、once，v5.49 加 reserve／refund（翻譯額度）與 void／voidlist（作廢）。

**工作階段 v2**：`<sub>.<sid>.<iat>.<exp>.<HMAC>`。擴充功能的（x）v5.49 起 sid 為 48 碼：`x`＋24 碼隨機＋`f`＋12 碼家族編號＋10 位數起始時間；
續期換出的新權杖同一家族、登出一起撤銷、整個家族最長 180 天（`SESSION_X_MAX_DAYS`）。舊的 25 碼照收。帳號、認領、配對、登出用 strict（再問 AuthGuard 有沒有被撤銷）；
翻譯那條路只驗簽章（每個請求多一次 DO 呼叫太貴）。v1 權杖不再接受。

**可調的設定**：

| 名稱 | 類型 | 預設 | 用途 |
|---|---|---|---|
| `OTP_GLOBAL_DAILY` | var | 60 | 全站每天最多寄幾封驗證碼信（保護授權碼信的寄信額度） |
| `OTP_NEW_DAILY` | var | 30 | 其中寄給**陌生信箱**（沒有 `gsub:`／`licmail:`）的上限——大量 IP 洗額度時用完的是這個池，既有客戶照樣收得到 |
| `TURNSTILE_SECRET` | secret | 未設定＝不啟用 | 機器人驗證 |
| `TURNSTILE_SITE_KEY` | var | — | 帳號頁的 widget（經 `/v1/plans` 給前端） |
| `TURNSTILE_HOSTNAMES` | var | — | siteverify 回傳的網域要在這裡（例：`pitlingo.com`） |

### `GET /v1/admin/digest`

每日彙報。需 `x-admin-token`。預設只產生內容不寄出；`?send=1` 才真的寄，
`?last=1` 讀排程最後一次的結果（`digest:last`，保留 30 天）。

內容：今日成本與上限、近 7 天共用快取／prompt 快取命中率、本週與下週的收割
覆蓋率與缺的場次、沒有網址後綴的影片數、標記完整但句數偏低的影片、未處理工單、
賽程同步結果。

2026-10-02 起（坑 #73、#74）：命中率警報只看**非比賽週末**（直播本來就不可能賽前收割）；
「已播完的場次還沒收完整」看的是 `complete`，直播時累積的部分句子不算；
已結束但沒收完整的場次列一行（不進警報）；無 slug 只對 14 天內新出現的數字 cid 發警報；
工單計數讀 metadata、沒有 metadata 的舊工單退回讀值。

排程掛在既有的 `crons = ["0 4 * * *"]`，**在賽程同步之後跑**（否則報的永遠是昨天的同步結果）。

⚠️ **就算完全正常也寄。** 只在有事時才寄的設計，會讓「系統壞了所以沒寄」與
「一切正常所以沒寄」長得一模一樣——而前者正是最需要你知道的情況。

收件人取 `DIGEST_TO`，沒設就用 `REPORT_TO`。三家寄信服務都沒設定時不會寄信
（也不會報錯）；`REPORT_WEBHOOK`（Discord／Slack）是獨立的第二條路，
在 Resend 的網域驗證完成之前那是唯一真的送得到的管道。

## 彈幕（v5.73 起，**尚未發行**）

程式在 `src/parts/26-danmaku.js`，行為測試 `node tools/check-danmaku.js`。閘門是 `ops.danmaku`（後台「彈幕（未發行）」分頁）：
`on` 預設 false——關著時只有 `allow` 白名單裡的信箱能用。收割權杖一律不能用。

**v5.74 起未付費（含沒登入）看得到、不能發**（2026-10-28 Ray）：憑證旗標 `p`＝可發言（只有付費授權且沒被禁言）、`s`＝影子禁言、`u`＝未付費。沒登入的身分是 `i:<installId>`（只拿來做檢舉去重）。未付費的連線送 `say` 回 `E81`「發送彈幕需要付費授權」——**不是** E83（被禁言），提示不同。

| 端點 | 說明 |
|---|---|
| `POST /v1/dm/ticket?cid=` | 帶 `x-client-token`（＋登入工作階段、`x-entitlement`）→ 60 秒的連線憑證（瀏覽器的 WebSocket 不能帶標頭）；回 `{ticket, post, unpaid}` |
| `GET /v1/dm/ws?cid=&t=` | 升級成 WebSocket，接到 `DanmakuRoom`（每支影片一個，SQLite，Hibernation API） |
| `GET /v1/dm/range?cid=&b=&t=` | 重播：影片第 b 個 30 秒的彈幕（邊緣快取 60 秒） |
| `/v1/admin/dm/*` | 後台：影片清單（`rooms`，帶年／站／標題分類）、檢舉、單支影片的彈幕（`msgs`，`statsOnly=1` 只回在線人數）、刪除／恢復（`state` 一則；`states` 批量 1～200 則）、禁言（`ban`，`sec`＝60／180／600，其他＝永久；`mode:'shadow'` 一律永久；`mode:''` 解除）、`bans`（含剩幾秒）、`who`（sub→信箱）、`ticket`（後台連進房間的 WebSocket 憑證）、`ctl`（暫停／慢速 0／5／10／30 秒） |

WebSocket 訊息：送 `{t:'say', x, pos(毫秒), live, n}`／`{t:'report', id}`／`{t:'ping'}`；收 `hello`（`post`、`unpaid`、`max`、`ctl`）／`ack`／`err`／`m`（`items:[{id,pos,x,live}]`，**沒有任何身分**）／`del`／`reported`／`muted`（`until`）／`unmuted`／`ctl`（`{paused, slow}`）／`pong`。

**後台即時處理（v5.74）**：後台拿 `a` 旗標的憑證（只有 sub＝`admin` 才算數）連同一個 WebSocket，收 `am`（帶 sub、時間、狀態、檢舉數）／`rep`／`st`；管理連線不算在線、不能發言或檢舉。
- **3 個登入帳號檢舉 → 自動隱藏**（狀態 3、對觀眾送 `del`）；`i:` 安裝識別碼的檢舉不算數。
- **限時禁言**房間內也記一份，跟 KV `dm:bans` 比 `at` 取新的，當場生效；解除寫墓碑（7 天後清）。影子禁言不通知本人。
- **暫停**時發言回 `E88`；**慢速模式**回 `E84`（每 N 秒一則）。
- **刪除保留一星期**：`dm.del_at` 記刪除時間，期間內後台可以恢復；DO **alarm** 在最早那則滿一星期時永久刪除（連同檢舉紀錄）並排下一次。
⚠️ 新的 DO class（migration v3）：**這一次部署必須用 `wrangler deploy`**，versions upload 會被 10211 拒絕。
⚠️ 彈幕不寫 KV；唯一的 KV 寫入是後台的禁言名單 `dm:bans`。

## 資料模型（KV）

| Key | 內容 | 寫入者 |
|---|---|---|
| `bundle:<cid>` | 整支影片的譯文 map ＋ `segCount`（只有收割寫）＋ `clientSeg`（觀眾回報）＋ `slug`／`slugBy`（`client` 或 `harvest`） | `/v1/subs`、`/v1/translate`、`/v1/complete` |
| `digest:last` | 排程最後一次彙報的內容與寄送結果，TTL 30 天 | cron |
| `rl:<ip>:<分鐘>` | 速率限制計數，TTL 120 秒 | 自動 |
| `config` | 遠端設定，可熱修 | `/v1/config` |

> v1.2 以前還有 `line:<cid>:<normKey>` 逐句 key。因為每句一次 KV 寫入直接撞爆
> 免費額度（坑 #19），v1.3 起全部併進 `bundle`。

### ⚠️ `bundle` 是多寫入者，而且 KV 沒有 CAS

這份文件原本寫著「`bundle` 走單一寫入者模型（只有收割器會寫），所以 read-modify-write
沒有競態問題」。**那個假設在擴充功能上線後就不成立了**——每個使用者的
`/v1/translate` 都會寫回 bundle，而用戶端同時最多 3 個請求在飛。

實測後果：一輪翻了 363 句，後端只多 148 句（41%）。三個請求讀到同一份舊快照，
模型呼叫花 1~2 秒，然後依序整份覆蓋，只有最後寫的活下來。**沒有任何錯誤**——
每個請求自己都成功，使用者也拿得到譯文，只有下一個人要重新付費。

v1.5 起所有寫入都走 `mergeWrite()`：**寫回前重讀再合併，只補不覆蓋**。
KV 沒有 CAS，做不到零損失，但競爭視窗從「模型呼叫的 1~2 秒」縮到
「讀+寫的幾十毫秒」，差了好幾個數量級。

真要零損失就得換 Durable Objects——目前的量還不值得。

---

## Prompt 同步 ⚠️

`src/index.js` 的 `SYSTEM_PROMPT` 與 userscript 的 `SYSTEM_PROMPT` **必須逐字相同**。改完跑：

```bash
node tools/check-prompt.js
```

### 為什麼是「逐字相同」而不是「語意一致」

v1.3 以前後端只放精簡版（34 條術語），理由是「後端只翻零星未命中句，完整術語表放收割器就好」。**這個理由是錯的**，錯在兩個地方：

1. **擴充功能的翻譯 100% 由後端執行。** 使用者沒有 API key，沒有收割器。共用快取沒命中時，他拿到的就是精簡術語表翻出來的結果——比 userscript 差一截。
2. **精簡版約 650 tokens，低於 Haiku 的 4,096 快取門檻。** `cache_control` 在門檻以下是**靜默失效**的：不報錯，只是每次都全額計費。等於為了「省 prompt」反而一直多付錢。

搬完整份之後兩個問題一起解決：術語表補齊，token 數也跨過門檻。

### 為什麼用複製而不是共用模組

userscript 必須是單一檔案（Tampermonkey），backend 由 wrangler 打包，兩邊沒有共用模組的辦法。所以比照 `normKey()` 的前例：允許複製，但用 `tools/check-prompt.js` 擋漂移。

---

## 成本與限制

- **Cloudflare 免費方案**：每天 100,000 次 Workers 請求、KV 每天 100,000 次讀 / 1,000 次寫。以早期規模綽綽有餘。
- **v5.95（2026-11-06）翻譯清單的時間軸**（Ray：「翻譯清單能否有時間軸?」→「要做，先改程式跑檢查」）。管理版收割重播時算出每句在影片裡第幾秒，蓋章（`POST /v1/subs`）時以 `times` 一起送；`mergeLineTimes` 存成 bundle 的 `t`；`GET /v1/admin/bundle` 回 `t`，後台「翻譯清單 → 看句子」有時間的依時間排序並標 [分:秒]，沒有的排在後面照原本順序。KV 寫入次數不變、用戶端讀不到。`tools/check-line-times.js`。
- **v5.94（2026-11-05）寄信內容可在後台編輯＋歡迎信改短**（Ray：「要能夠讓我修改寄信的內容」「歡迎信的標題只要 歡迎使用 PitLingo」「內文太過繁瑣，您好之後不用說那麼多，讓使用者知道已經建立完成就好。」刪掉「不需要輸入任何序號」與「這是帳號建立時的唯一一封歡迎信，之後我們不會寄送行銷信件；收據、驗證碼與帳號安全通知仍會照常寄出。需要協助請到 pitlingo.com「聯絡我們」。」）。新片段 `25-mail-content.js`：`MAIL_DEFS`（預設內容，目前只有 welcome）、`composeMail()`（預設與覆寫走同一個渲染器）、KV `mail:content`／`mail:history`（20 版）。內文是純文字（先逸出再套標記）：`**粗體**`、空行分段、`## 小標題`、`- 清單`、`[文字](網址)` 連結、單獨一行＝按鈕、`{email}`／`{mins}`／`{site}`；連結走 `siteHrefOk` 白名單。發布與寄樣本前跑 `mailContentProblems`（siteFactProblems＋車隊無線電／VPN＋連結）。信件大標題＝標題。後台新分頁「寄信內容」（預覽在 sandbox iframe）。驗證碼、收據、授權信**不開放**（內容與安全／法律說明綁在一起）。　**同日擴大（Ray：「都要開放編輯」）**：寄給使用者的 9 種信全部開放——歡迎信、登入驗證碼、認領驗證碼、新裝置通知、訂單完成、訂單完成（不含字幕授權）、授權已重新設定、朋友送您通行證、代訂 F1TV 帳號已準備好。每封可改**標題、大標題、內文**；驗證碼、交易明細（含「非統一發票」）、裝置／地點／時間、多份授權清單、代訂說明、啟用方式、代訂帳密何時可看，都是程式產生的**區塊**（內文裡單獨一行 `{{code}}`／`{{receipt}}`／`{{details}}`…），只能決定位置；必要區塊（驗證碼、交易明細、裝置資訊、代訂可看時間）刪掉不准發布，KV 被改壞時那一封退回預設內文。`{{…}}` 不准放標題（驗證碼不進主旨）。VPN 只准出現在代訂的信（`vpnOk`）。每封信拆成 `build*Mail`（組信）＋`send*Mail`（寄），後台預覽與樣本呼叫同一個 build 函式＋假資料（`MAIL_SAMPLES`）。內文新增 `~ ` 灰色小字。**預設內容與舊信逐字相同，只有三處順手更正**：認領信拿掉「用授權碼」與「換發新的授權碼」（10-30 起認領改用購買信箱、自助換發已拿掉）；新裝置通知「授權碼也會…必要時再換發授權碼」→「授權也會…」（同理）。寄給管理員的通知與每日彙報不開放（內部用）。`tools/check-mail-content.js`（36 項）；`check-license-security` 的歡迎信檢查改成驗新標題、「已經建立完成」、沒有被刪的兩句。
- **v5.93（2026-11-05）成長統計的 Google／信箱分類修正**（Ray 問「已註冊是否有包含google帳號」時查到）：`/v1/admin/growth` 用 `sub.startsWith('em:')` 判斷信箱帳號，但 `emailSub()` 產生的是 `em`＋HMAC、**沒有冒號**——所有信箱帳號都被算成 Google（「已註冊」總數本來就對）。改成 `startsWith('em')`（Google 的 sub 是純數字）。不用 `via`：信箱帳號併進 Google 後 via 會被帶過去。`check-growth` 改用真正的 `emailSub()` 產生測試帳號，並加一個「併過來、via 還是 email」的 Google 帳號
- **v5.92（2026-11-05）譯文錯開一格的防線**（Ray：「做1跟2。不要做3」）：共用快取約 2% 的句子拿到後一句的譯文——模型在批次裡合併或跳過一行、之後的編號照樣連續往下編。`translateBatch` 新增 `alignBreak`：編號超出或最後一號不見 → 整批不可信；嚴格版 `shiftedAt`（本句中文的名字全來自下一句、下一句中文沒有它們、**本句英文自己的名字在中文裡一個都沒有**）→ 從那一句起不收。不收的部分拆兩半重翻（temperature 0 原樣重送會得到同樣的錯），最多兩層、最底層 ≤ 5 句逐句翻，上限 27 次呼叫，費用全部加總、失敗時帶在錯誤上（坑 #44）。名字＝這一批中文裡的英文字 ∪ SYSTEM_PROMPT 辭典的首字大寫字（去掉 Hill／Park／Ring 等常見字）。⚠️ **不可以用寬鬆版在翻譯當下擋**：跨行句（英文一句被字幕切兩行）會被永遠擋下、每輪重付錢。`tools/check-realign.js`
- **v5.91（2026-11-04）成長統計**（Ray：「加一個統計數據的區塊，可以忽略11/3之前的 因為那之前都是我在測試」）：`handleGrowth`（`10-gate-analytics-reports.js`）＋後台「產品數據」分頁最上面的「成長統計」。帳號 `acctg:` 沒有 metadata，逐筆 get，所以整份結果快取 5 分鐘（坑 #47）；訂單只讀 metadata；使用事件讀 `metric:<UTC 日>` 並疊上未落地的量（坑 #46，不 flush）。「註冊後有付費」只算金額 > 0 的已付款訂單。`tools/check-growth.js`（check-all）
- **v5.90（2026-11-03）本賽季免費體驗**（Ray：「這個賽季就不賣了，改讓現在知道的人都能免費用到賽季結束，賽季一結束就停止免費試用的活動」）：方案 `free_season`（不賣、後台也不能發）。`FREE_SEASON_YEAR = 2026`，`freeSeasonActive()`＝SEASON_YEAR 等於它且本賽季還沒跑完（`seasonFinishSec`＝最後一站正賽結束 3 小時後）。登入的帳號在啟用／續期（`resolveAccountKey`）時，帳號裡沒有現在就能用的授權（沒有、或只有還沒開始的，例如 2027 早鳥）→ `ensureFreeSeasonLicense` 發一份，效期到 `seasonFinishSec`；一個帳號一份靠 AuthGuard `once`（鍵 `freeseason:<sub>`），連不上就不發。**擴充功能不用改**：1.0.1 起登入後、每小時、打開設定頁都會不帶碼啟用。活動期間 `planLock` 鎖 `week`／`season`（早鳥、下一季、代訂照賣；代訂附贈的場次照選）。`/v1/plans` 多 `freeSeason: {year, until}`、races 多 `free`。統計：`free_season` 算免費使用者。測試：購買流程的檢查用 `withoutFreeSeason()`（tools/lib/backend-src.js）在活動關著的世界裡驗，活動本身由 check-license-security「本賽季免費體驗」打開來驗
- **v5.89（2026-11-03）早鳥改賣 2027 賽季通行證**：`season_early` 399、限量 20、每帳號 1 份，內容與 2027 季票相同（`EARLY_YEAR` 固定 2027，不跟 `SEASON_YEAR` 走）。名額計在 AuthGuard（`op: 'early'`，鍵 `B:early`）：結帳 `earlyHold` 保留 30 分鐘、付款通知 `earlyClaim` 轉賣出，同一個訂單重送是冪等的；沒名額時改發同內容的季票並通知後台。早鳥結帳只收信用卡。早鳥還在賣時，同內容的 599 那張（換季前 `season_next`、換季後 `season`）由 `planLock(…, early)` 鎖住「早鳥 20 組售完後開放」；售完或 2027 季前測試的比賽週開始（`earlyDeadlineSec`）就收掉早鳥。`/v1/plans` 多 `remaining`／`deadline`／`forNext`。AuthGuard 連不上時兩張都先鎖；完全沒有 AuthGuard 綁定時早鳥不賣、599 照開
- **v5.88（2026-11-03）寄信改走 `sendMail()`**：原本 10 個地方各自打 Resend，收成一個函式；Cloudflare Email Sending 主力，Resend、ZeptoMail 備援。Resend Pro 每月 US$20 不升級（見 handoff 2026-11-03）
- **v5.87（2026-11-02）SYSTEM_PROMPT 規則 6／6a／批次模式**：不再叫模型「輸出空字串」（它會把那幾個字寫出來），改「什麼都不輸出」；只有一兩個字的片段照字面翻、不准回「我準備好了，請輸入」。清快取用 `node tools/purge-implausible.js`（預設只列出、`--apply` 才刪，不需要 ADMIN_TOKEN）。
- **v5.87（2026-11-02）譯文守門加強**：`ROLE_BREAK` 多 15 條（「我準備好了…請」「請輸入／貼上」「我需要你提供」「繁體中文」「翻譯器」「空字串」、整句括號、空行…），擋 R19 正賽實際顯示在畫面上的模型自言自語；快取裡舊的用 `/v1/admin/bundle/suspect` 掃、`/v1/admin/bundle/purge` 刪。與擴充功能 shared/normalize.js 一字不差（check-guard）。
- **2026-11-01 Ray 決定升級 Workers Paid（$5／月）**：KV 寫入改成每月含 100 萬次、超過每百萬 $5（官方 kv/platform/pricing 與 workers/platform/pricing，2026-11-01 查證）。v5.86 起告警線由 `wrangler.toml` 的 `KV_DAILY_PUTS` 決定（`kvDailyCap(env)`）；**沒設＝免費方案 1,000**，確認帳號真的升級之後才把那一行打開（`33000`），否則撞牆時告警不會響。
- **KV 寫入次數是最先會碰到的天花板**（每天 1,000 次）。v1.3 起 `/v1/translate` 不論翻幾句都只寫 1 次 KV（v1.2 以前是每句一次，實測 38 分鐘就把當日額度用光，見 handoff 坑 #19）。收割器的 `POST /v1/subs` 一次寫一個 bundle 也只佔 1 次 —— **仍是建議的主要灌注方式**，因為它能在賽前就把整支影片灌滿。
- 速率限制 120 req/min/IP，KV 最終一致性，屬近似值。計數是取樣寫入（每 25 次寫 1 次）；**KV 寫入額度用完時照樣放行**（v5.60，寫不進去不可以讓翻譯請求 500）。

---

## 尚未實作（商品化才需要）

- 帳號系統與 JWT
- 金流 webhook
- 免費層配額（每場比賽前 15 分鐘）
- 靜默失效遙測回報端點
- 直播收割器（見 `handoff.md` 7.2）
