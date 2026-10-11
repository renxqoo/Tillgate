-- 收据校准预估（docs/calibrated-exposure-estimate.md §3.1/§3.2c）。
--
-- 表 prefix_calibrations：结算成功写 (user, mapping, prefix哈希链) → 实测
-- inputTokens；下一笔同前缀请求收缩预估敞口（130 倍保守 → 接近实际）。
-- 写入守卫（inference C7）与保留策略（worker 批后清理）在应用层；
-- 本表只存事实，无触发器（资金不变量不驻留此表——它只影响预估，
-- B2 钳制/死信阈值永不消费校准值，I0 安全分离）。
--
-- billing_requests.conservative_channel_amount：reserve 时与校准金额同调用、
-- 同价格快照、字节界口径算出的保守金额。B4 二级上界的唯一判定与数值来源
-- （NULL = 未按校准预留 → B4 走原路径；upstreamCost 超此列 → 死信，价格
-- 漂移探测器——reserve 后调价会被它抓住）。

CREATE TABLE prefix_calibrations (
  user_id      bigint        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mapping_id   bigint        NOT NULL,
  prefix_hash  text          NOT NULL,
  channel_id   bigint        NOT NULL,
  input_tokens bigint        NOT NULL,
  messages_len integer       NOT NULL,
  request_id   uuid          NOT NULL,
  settled_at   timestamptz   NOT NULL,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT prefix_calibrations_pk PRIMARY KEY (user_id, mapping_id, prefix_hash),
  -- 读路径 top-N 现读：(user, mapping) settled_at 倒序
  CONSTRAINT prefix_calibrations_input_tokens_positive_ck CHECK (input_tokens > 0),
  CONSTRAINT prefix_calibrations_messages_len_positive_ck CHECK (messages_len > 0)
);
CREATE INDEX prefix_calibrations_recent_idx
  ON prefix_calibrations (user_id, mapping_id, settled_at DESC);

ALTER TABLE billing_requests
  ADD COLUMN conservative_channel_amount numeric(38, 18);
