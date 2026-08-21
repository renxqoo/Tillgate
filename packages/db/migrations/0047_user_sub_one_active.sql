-- F1：团队套餐并发购买绕过「单有效订阅」不变式 → 双扣费。
-- 根因：单活跃闸门是无锁 findFirst，ensureOrg 在并发事务里各建新组织，
-- personal_uq（org_id IS NULL）与 org_uq（按 org）都不覆盖「同用户、不同 org」
-- 的并发插入。修法：不变量下沉 DB——per-user 全维部分唯一索引，
-- 应用层只把 23505 翻译成 already_subscribed（runSubscriptionTx）。

-- 数据治理 1（加约束前校验/收敛存量）：自然到期但 status 仍为 0 的行先翻转。
-- 不翻则挡住新购买撞唯一索引（对应应用层 C4 惰性翻转；此处一次性收敛全量）。
UPDATE user_subscriptions SET status = 1 WHERE status = 0 AND end_at <= now();

-- 数据治理 2：历史并发竞态可能留下的同用户多条活跃行——保留最新一条（业务上
-- 后购为有效），其余翻转。被翻转的重复行不再可续费（renew 只认 status=0），
-- 与「本就不该存在」的语义一致。
UPDATE user_subscriptions AS us
SET status = 1
WHERE us.status = 0
  AND us.id NOT IN (
    SELECT max(id) FROM user_subscriptions WHERE status = 0 GROUP BY user_id
  );

-- per-user 全维硬不变量：每用户至多一条 status=0（个人或组织皆然）。
-- org 维保留 one_org_uq（防跨用户在同一组织重复开订阅）。
DROP INDEX IF EXISTS user_subscriptions_one_personal_uq; -- 被 per-user 索引完全覆盖，删除以免双真相
-- IF NOT EXISTS：该迁移生成早于手工应用（开发库已建同名索引），幂等保证链路可重放
CREATE UNIQUE INDEX IF NOT EXISTS user_subscriptions_one_active_uq ON user_subscriptions (user_id) WHERE status = 0;
