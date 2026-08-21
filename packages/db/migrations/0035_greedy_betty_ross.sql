-- C4 数据回填：已自然到期但 status 仍为 0 的个人订阅一次性翻转为到期态
-- （唯一索引只看 status=0；不回填则这些行永久占用个人订阅唯一槽，购买死锁）。
UPDATE user_subscriptions SET status = 1 WHERE status = 0 AND org_id IS NULL AND end_at <= now();

CREATE UNIQUE INDEX "channels_name_uq" ON "channels" USING btree ("name");