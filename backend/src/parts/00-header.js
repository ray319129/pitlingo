/**
 * f1zh-api — F1TV 繁中字幕共用譯文後端
 *
 * 核心價值：所有人看同一支影片拿到的是同一份英文字幕，所以譯文可以共用。
 * 第一次有人看 → 翻譯一次 → 存進 KV；之後所有人 → 直接下載，零 API 呼叫。
 *
 * 路由
 *   GET  /v1/health                    健康檢查
 *   GET  /v1/config                    遠端設定（選擇器等，可熱修不用重送審）
 *   GET  /v1/subs?cid=<contentId>      取回整支影片的譯文
 *   POST /v1/subs                      上傳譯文（需 ADMIN_TOKEN）
 *   POST /v1/translate                 翻譯未命中的句子（需 CLIENT_TOKEN）
 *   POST /v1/complete                  標記整支已完整收割（需安裝權杖）
 *   POST /v1/register                  匿名換取安裝權杖（無需權杖，IP 限流）
 *   POST /v1/license/activate          用授權碼啟用這台裝置，換回通行證
 *   POST /v1/license/renew             續期（失敗不影響現有通行證）
 *   POST /v1/license/deactivate        解除裝置（不需該裝置的權杖）
 *   POST /v1/license/devices           列出這組授權碼的裝置（純查詢）
 *   POST /v1/report                    使用者送出診斷，回傳工單編號
 *   POST /v1/metric                    產品數據（彙總計數，不含個資）
 *   GET  /v1/admin/metrics             產品數據後台
 *   POST /v1/checkout                  建立訂單，回傳導向綠界的表單
 *   POST /v1/payment/webhook           金流回呼：驗簽 → 防重放 → 自動發碼
 *   POST /v1/payment/info              ATM／超商取號通知（**不發碼**）
 *   GET  /v1/order?no=                 查單筆訂單狀態
 *   GET  /v1/admin/license/list        授權清單（可搜尋、可分頁）
 *   POST /v1/admin/license/patch       延期／換方案／解除全部裝置
 *   GET  /v1/admin/reports             診斷回報清單
 *   POST /v1/admin/license/issue       發碼（金流 webhook 之後接這裡）
 *   POST /v1/admin/license/revoke      停用（退款／盜用）
 *   GET  /v1/admin/license/lookup      用 email 查回授權碼（客服補發）
 *   GET  /v1/admin/stats               成本後台（需 ADMIN_TOKEN）
 *   POST /v1/admin/revoke              撤銷某個安裝（需 ADMIN_TOKEN）
 *
 * 環境變數（wrangler secret put）
 *   ANTHROPIC_API_KEY   Anthropic 金鑰
 *   ANTHROPIC_API_KEY_HARVEST  收割端（收割權杖）用的金鑰，放在另一個 Console workspace（可省略，退回上一把）
 *   ADMIN_TOKEN         上傳與後台用的管理權杖
 *   TOKEN_SECRET        簽發安裝權杖用（未設定時由 ADMIN_TOKEN 衍生）
 *   CLIENT_TOKEN        舊版共用權杖，僅為相容 userscript 而保留
 *   DAILY_USD_CAP       成本熔斷上限（美元／天，預設 5）
 * KV binding: SUBS
 *
 * v1.4  SYSTEM_PROMPT 與 userscript 同步（34 → 273 條術語）。
 *       同時讓 prompt 跨過 4096 token 門檻，cache_control 才真的生效。
 * v1.5  修 /v1/translate 的讀改寫競爭（並行請求互相覆蓋，實測只有 41%
 *       的譯文存活）。新增 /v1/complete 讓用戶端標記整支已收割完整。
 * v1.6  /v1/subs 拿掉 max-age=60。bundle 現在是多寫入者，HTTP 快取
 *       是用戶端清不掉的一層，會讓剛寫進去的 segCount 完全看不到。
 * v1.7  單句不再走批次編號協定（實測回覆率只有 50%，坑 #9）。
 *       批次解析加上「行數相同就按位置對應」的備援。
 * v2.3  方案期限由伺服器依方案計算（trial 14 天／season 到隔年 1/31／
 *       lifetime 無期限）；授權清單、批次修改、診斷回報工單。
 * v2.2  管理端點補回 CORS（後台是本機開的 file://，Origin 是 null，
 *       第一版把自己的後台也擋掉了）。新增 /v1/license/devices。
 * v2.1  **授權與安裝權杖分離**。v2.0 把「證明付過錢」做成綁裝置的，
 *       換一台電腦就失效——付費軟體不能這樣。改成可攜帶的授權碼：
 *       任何裝置貼上就能用，最多 3 台，可自行解除，可用 email 補發。
 * v2.0  資安與維運：每個安裝一枚權杖（取代所有人共用的 CLIENT_TOKEN，S6）、
 *       拿掉 CORS `*`、常數時間比對、速率限制改以 installId 為鍵、
 *       譯文合理性檢查擋 prompt injection 汙染共用快取（S9）、
 *       成本統計與每日熔斷、分階段推送（rollout / killSwitch / minClientVersion）。
 */

/**
 * 後端版本。**`/v1/health` 會回傳它，這是唯一能確認「線上跑的是哪一版」的方法。**
 *
 * ⚠️ 沒有這個之前，部署完只能靠副作用推論（2026-09-25 想確認 KV 修正有沒有上線時
 *    才發現做不到，只好用「連讀三次看計數有沒有漲」去猜）。
 * ⚠️ 改這個常數時要同步改 `CLAUDE.md` 的產物表——`node tools/check-backend-version.js` 會擋，
 *    理由與 userscript 的版本號一樣：**版本號說謊，排查就整個被誤導**。
 */
const BACKEND_VERSION = '5.95';

const MODEL = 'claude-haiku-4-5';
const BATCH_MAX = 20;              // 一次 API 呼叫最多翻幾句
const RATE_LIMIT_PER_MIN = 120;    // 每 IP 每分鐘的 /v1/translate 上限
const BUNDLE_MAX_LINES = 20000;    // 單支影片的譯文上限，防呆

