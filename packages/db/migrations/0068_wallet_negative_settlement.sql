-- 已发生的计费必须全额结算：余额不足时允许用户账户形成负余额。
-- 新请求是否允许继续消费仍由 wallet authorize 的 balance + credit_limit - in_flight 守卫控制。
alter table wallet_accounts
  drop constraint if exists wallet_accounts_balance_floor_ck;
