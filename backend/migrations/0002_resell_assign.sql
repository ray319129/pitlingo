-- 代訂自營：第 2 階段（2026-10-12）——訂單 ↔ 帳號指派、共用帳號席次、結帳時的保留名額、設定
--
-- ⚠️ 套用：cd backend && wrangler d1 migrations apply pitlingo-resell --remote
--    **先套用、再部署程式**：新程式會查這幾張表，反過來的話代訂分頁與結帳的名額檢查會出錯。

-- 一筆訂單裡的一個代訂項目＝一列。由「付款成功」建立（webhook 當下，失敗時後台打開代訂分頁會補）。
-- mode：ours＝我方提供的專屬帳號 / byo＝客戶自備帳號 / shared＝共用帳號的一個席次
-- ⚠️ 自備帳號（byo）**不連結任何 F1TV 帳號**（使用者 2026-10-12 決定）：account_id 一律是 NULL，
--    這張表也沒有欄位存客戶的 F1TV 信箱。開通需要的臨時資料（第 3 階段）開通完就刪。
CREATE TABLE f1_assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no    TEXT    NOT NULL,
  line_idx    INTEGER NOT NULL,                  -- 訂單 services 陣列裡的第幾項
  plan_key    TEXT    NOT NULL,
  mode        TEXT    NOT NULL CHECK (mode IN ('ours', 'byo', 'shared')),
  months      INTEGER NOT NULL DEFAULT 1,        -- 一個月方案買幾份；年方案 12；共用帳號 0
  gp_id       TEXT,                              -- 共用帳號：哪一場大獎賽
  cust_acct   TEXT    NOT NULL,                  -- 客戶的 accountKey（購買信箱）
  -- pending 待處理 / active 使用中 / ended 已到期 / revoked 違規收回 / cancelled 退款取消
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'active', 'ended', 'revoked', 'cancelled')),
  account_id  INTEGER REFERENCES f1_accounts (id),
  seat_no     INTEGER,
  starts_at   INTEGER,
  ends_at     INTEGER,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (order_no, line_idx),
  CHECK (mode <> 'byo' OR account_id IS NULL)
);
CREATE INDEX f1_assign_status ON f1_assignments (status);
CREATE INDEX f1_assign_cust ON f1_assignments (cust_acct);
CREATE INDEX f1_assign_gp ON f1_assignments (gp_id, mode, status);
-- 一個專屬帳號同一時間只能給一筆還沒結束的訂單（第二道防線；第一道在程式的條件式 UPDATE）
CREATE UNIQUE INDEX f1_assign_ours_once ON f1_assignments (account_id)
  WHERE mode = 'ours' AND status IN ('pending', 'active');

-- 共用帳號的席次：一場大獎賽 × 一個帳號 × 第幾席。**4 席是硬上限，寫在 CHECK 裡**，
-- 程式算錯也插不進第 5 席（RESELL-OPS 第 4 節；Premium 官方 6 台，留 2 台）。
CREATE TABLE f1_seats (
  gp_id          TEXT    NOT NULL,
  account_id     INTEGER NOT NULL REFERENCES f1_accounts (id),
  seat_no        INTEGER NOT NULL CHECK (seat_no BETWEEN 1 AND 4),
  assignment_id  INTEGER NOT NULL UNIQUE REFERENCES f1_assignments (id),
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (gp_id, account_id, seat_no)
);

-- 結帳當下替共用帳號保留名額（席次上限打開時才用）。付款成功轉成指派；沒付款的到期自動失效。
CREATE TABLE f1_holds (
  order_no    TEXT    NOT NULL,
  gp_id       TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (order_no, gp_id)
);
CREATE INDEX f1_holds_gp ON f1_holds (gp_id, expires_at);

-- 代訂的設定（不放 KV：後台切開關不該吃 KV 每天 1,000 次的寫入）
CREATE TABLE f1_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
