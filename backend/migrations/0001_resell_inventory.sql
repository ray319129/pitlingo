-- 代訂自營：第 1 階段（2026-10-12，RESELL-OPS 第 7 節、handoff 9.1）
--
-- 帳號庫存、成本、採購區價格、事件紀錄。指派與共用帳號席次是第 2 階段（0002）。
--
-- ⚠️ 套用：cd backend && wrangler d1 migrations apply pitlingo-resell --remote
--    本機測試由 tools/check-resell.js 用 node:sqlite 直接執行這個檔案——
--    **測試跑的就是正式的 schema**，不是另外抄一份。
-- ⚠️ 已套用的 migration 不可以改（D1 用檔名記錄套用過哪些）。要改就新增 0002、0003…

-- 我方擁有的 F1TV 帳號（專屬帳號與共用帳號池）。客戶自備的帳號**不在這裡**。
CREATE TABLE f1_accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  login_email  TEXT    NOT NULL UNIQUE,          -- 我方網域的信箱（f1-001@…），已轉小寫
  region       TEXT    NOT NULL,                 -- 採購區，ISO 國碼大寫（BR、KR…）
  tier         TEXT    NOT NULL CHECK (tier IN ('pro', 'premium')),
  billing      TEXT    NOT NULL DEFAULT 'monthly' CHECK (billing IN ('monthly', 'annual')),
  -- available 可指派 / assigned 專屬帳號使用中 / shared 共用帳號池 / recovering 回收中（改密碼、清裝置）/ disabled 停用
  status       TEXT    NOT NULL DEFAULT 'available'
               CHECK (status IN ('available', 'assigned', 'shared', 'recovering', 'disabled')),
  renews_at    INTEGER,                          -- 下一次扣款或到期（unix 秒）
  auto_renew   INTEGER NOT NULL DEFAULT 1,
  vault_ref    TEXT,                             -- 密碼管理器裡的項目名稱（主密碼以那裡為準）
  -- 交付用的密碼副本，AES-GCM 加密（RESELL-OPS 3.2）。格式 v1.<iv>.<密文>，AAD 綁 login_email。
  -- ⚠️ 任何清單、查詢、匯出、彙報都不可以 SELECT 這一欄；只有 reveal 端點解密。
  pw_enc       TEXT,
  pw_set_at    INTEGER,
  card_ref     TEXT,                             -- 綁的卡（末四碼或虛擬卡代號，不存完整卡號）
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX f1_accounts_status ON f1_accounts (status);
CREATE INDEX f1_accounts_renews ON f1_accounts (renews_at);

-- 每個帳號每一期實際付了多少。**台幣實扣金額以信用卡帳單為準**，不是牌價換算。
CREATE TABLE f1_costs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES f1_accounts (id),
  period_from   INTEGER NOT NULL,
  period_until  INTEGER NOT NULL,
  amount_local  REAL,                            -- 結帳頁上的當地價格
  currency      TEXT,                            -- BRL、KRW…
  amount_twd    INTEGER NOT NULL,                -- 帳單實扣台幣（含海外手續費）
  paid_at       INTEGER NOT NULL,
  note          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX f1_costs_account ON f1_costs (account_id);

-- 採購區的牌價。checked_at 超過 30 天就在彙報與後台提醒（RESELL-OPS「2026-10 重新查證」）。
CREATE TABLE f1_regions (
  region        TEXT PRIMARY KEY,
  currency      TEXT,
  pro_month     REAL,
  pro_year      REAL,
  prem_month    REAL,
  prem_year     REAL,
  price_basis   TEXT,                            -- 'local'（固定當地價）或 'usd'（美金換算，會跟匯率漂）
  usable        INTEGER NOT NULL DEFAULT 1,      -- 台灣的卡結帳會不會過
  checked_at    INTEGER NOT NULL,
  note          TEXT
);

-- 事件紀錄：誰在什麼時候做了什麼。**看密碼一定記一筆**（RESELL-OPS 3.2 第 3、4 條）。
CREATE TABLE f1_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT    NOT NULL,                  -- admin / customer / system
  kind        TEXT    NOT NULL,                  -- account_add / account_edit / pw_set / pw_reveal / cost_add / region_set …
  account_id  INTEGER,
  order_no    TEXT,
  cust_acct   TEXT,                              -- 客戶的 accountKey（第 2 階段起）
  detail      TEXT                               -- 簡短說明，**不可以含密碼**
);
CREATE INDEX f1_events_account ON f1_events (account_id, at);
CREATE INDEX f1_events_at ON f1_events (at);
