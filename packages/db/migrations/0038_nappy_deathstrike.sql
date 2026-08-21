CREATE UNIQUE INDEX "rate_card_coefficients_global_uq" ON "rate_card_coefficients" USING btree ("rate_card_id","scope") WHERE model_mapping_id is null;--> statement-breakpoint
ALTER TABLE "model_mappings" ADD CONSTRAINT "model_mappings_prices_nonnegative_ck" CHECK ("model_mappings"."input_price" >= 0 and "model_mappings"."output_price" >= 0 and "model_mappings"."cache_input_price" >= 0);--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_amounts_nonnegative_ck" CHECK ("usage_logs"."amount" >= 0 and "usage_logs"."plan_amount" >= 0 and "usage_logs"."payg_amount" >= 0 and "usage_logs"."upstream_cost" >= 0);--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_amount_split_ck" CHECK (("usage_logs"."status" <> 0) or ("usage_logs"."amount" = "usage_logs"."plan_amount" + "usage_logs"."payg_amount"));--> statement-breakpoint
-- 存量治理（先于下方 transactions_balance_chain_ck）：旧计银实现（2026-08-14 前）
-- 写 consume 流水时 balance_before 恒记 0（1359 行恒等式违例，多为压测用户 21；
-- 其中 350 行 balance_after 本身亦有并发漂移）。按「每用户首行 before 锚定 + 金额前缀和」
-- 整链重算，恒等式构造性成立；干净用户（链本自洽）的行不发生变化。
WITH chain AS (
  SELECT id,
    first_value(balance_before) OVER w AS anchor,
    sum(amount) OVER w AS running
  FROM transactions
  WINDOW w AS (PARTITION BY user_id ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
)
UPDATE transactions t
SET balance_before = c.anchor + c.running - t.amount,
    balance_after  = c.anchor + c.running
FROM chain c WHERE t.id = c.id
  AND (t.balance_before <> c.anchor + c.running - t.amount OR t.balance_after <> c.anchor + c.running);

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_balance_chain_ck" CHECK ("transactions"."balance_after" = "transactions"."balance_before" + "transactions"."amount");