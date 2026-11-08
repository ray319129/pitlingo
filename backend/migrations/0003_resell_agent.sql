-- 代訂：改向代理商訂購帳號（2026-10-23，Ray：「我目前就先暫時用跟代理商訂購帳號，所以後臺要改」）
--
-- ⚠️ 套用：cd backend && wrangler d1 migrations apply pitlingo-resell --remote
--    **先套用、再部署程式**：新程式會讀這幾個欄位，反過來的話代訂分頁會出錯。
--
-- 代理商交付的帳號照樣進 f1_accounts（同一套加密、查看紀錄、全域查詢），只是：
--   · 沒有我們的採購區與卡（region 存 'XX'＝未指定，card_ref 留空）
--   · 合用帳號可能同時給我們好幾位客戶（代理商決定），所以不走「回收中→可指派」的循環
-- source：self＝我們自己採購（RESELL-OPS 第 3～5 節，暫停中）／agent＝代理商交付
-- share：代理商的品項型態。solo＝獨享 / 3、6＝幾人合用 / weekend＝單一比賽週末 / topup＝充值到客戶自己的帳號
ALTER TABLE f1_accounts ADD COLUMN source TEXT NOT NULL DEFAULT 'self' CHECK (source IN ('self', 'agent'));
ALTER TABLE f1_accounts ADD COLUMN agent_sku TEXT;
ALTER TABLE f1_accounts ADD COLUMN share TEXT CHECK (share IS NULL OR share IN ('solo', '3', '6', 'weekend', 'topup'));

-- 交付給客戶的時間與通知信結果（「我沒收到」時的依據，RESELL-OPS 第 7 節「交付紀錄」）
ALTER TABLE f1_assignments ADD COLUMN delivered_at INTEGER;
ALTER TABLE f1_assignments ADD COLUMN mail_status TEXT;
