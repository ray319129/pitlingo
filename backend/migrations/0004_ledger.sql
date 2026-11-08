-- 帳本（2026-10-24，Ray：「真正上線後我想要有記帳，都要真實的收支」「做在後台 並加試算表加訂單匯出」）
--
-- 記的是**真的進出的錢**（現金制），不是後端自己估的成本：
--   · 收入與退款：付款成功的訂單，**快照進 ledger_orders**（見下）
--   · 金流手續費：綠界付款通知的 PaymentTypeChargeFee（v5.65 起存進訂單）；之前的訂單人工補登 fee_manual
--   · 代訂採購：f1_costs（帳單實扣台幣，讀的時候合併）
--   · 其他支出（Anthropic 儲值、Cloudflare、網域…）與其他收入：ledger_entries，金額填**信用卡帳單上的台幣**
--
-- ⚠️ **不可以刪，只能作廢**（voided＋原因）。帳本被改過要看得出來；打錯就作廢再記一筆。
-- ⚠️ 套用：cd backend && wrangler d1 migrations apply pitlingo-resell --remote
--    （與代訂共用同一個 D1；tools/check-ledger.js 直接執行這個檔案）

CREATE TABLE ledger_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  INTEGER NOT NULL,                 -- 實際刷卡／入帳的日子（unix 秒，台灣時間當天中午）
  kind         TEXT    NOT NULL CHECK (kind IN ('income', 'expense')),
  category     TEXT    NOT NULL,
  item         TEXT    NOT NULL,                 -- 這筆是什麼（「Anthropic 儲值」「pitlingo.com 續約」）
  amount_twd   INTEGER NOT NULL CHECK (amount_twd > 0),   -- 帳單實扣台幣（含海外手續費）
  amount_orig  REAL,                             -- 原幣金額（參考用）
  currency     TEXT,                             -- USD、EUR…
  receipt      TEXT,                             -- 收據放在哪（檔名、信件主旨）
  note         TEXT,
  voided       INTEGER NOT NULL DEFAULT 0,
  void_reason  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX ledger_when ON ledger_entries (occurred_at);

-- 訂單的帳務快照。⚠️ **不可以只從 KV 讀**：付款的訂單在 KV 只保存 ORDER_TTL（400 天，最後一次更新起算），
--    過期之後收入會從帳上消失，而帳要留好幾年。每日排程與打開帳本時從 KV 同步（UPSERT），
--    KV 過期之後這裡留著最後一份。fee_manual 是人工補登，同步**永遠不覆寫**它。
CREATE TABLE ledger_orders (
  order_no     TEXT    PRIMARY KEY,
  paid_at      INTEGER NOT NULL,
  amount_twd   INTEGER NOT NULL,                 -- 實收（綠界 TradeAmt；沒有就用訂單價格）
  fee_twd      REAL,                             -- 綠界付款通知帶的手續費
  fee_manual   REAL,                             -- 人工補登（通知沒帶時）
  fee_note     TEXT,
  pay_type     TEXT,
  trade_no     TEXT,
  summary      TEXT,
  status       TEXT    NOT NULL CHECK (status IN ('paid', 'refunded')),
  refunded_at  INTEGER,
  synced_at    INTEGER NOT NULL
);
CREATE INDEX ledger_orders_paid ON ledger_orders (paid_at);
