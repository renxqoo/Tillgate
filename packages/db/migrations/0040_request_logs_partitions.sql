-- request_logs 月分区（30 天滚动）。
-- 原表为普通无界表（写入量随网关流量线性增长）；换为 PARTITION BY RANGE (created_at)：
--   - 分区表主键必须含分区键 → (id, created_at)；FK 不保留（日志表高频写入，
--     引用完整性由写入方保证，去除每行两次 FK 检查亦为收益）
--   - 预建 [前月, 当月, 次月] 分区 + DEFAULT 兜底；worker 每日建下月分区并滚动删 30 天前分区
--   - 存量行一次性拷入，事务内原子换名（锁窗口极短）
CREATE TABLE request_logs_partitioned (
  LIKE request_logs INCLUDING DEFAULTS,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

DO $$
DECLARE
  part_start date;
  part_name text;
  m date := date_trunc('month', now())::date;
BEGIN
  FOR i IN -1..1 LOOP
    part_start := (m + (i || ' month')::interval)::date;
    part_name := 'request_logs_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF request_logs_partitioned FOR VALUES FROM (%L) TO (%L)',
      part_name, part_start, (part_start + interval '1 month')::date
    );
  END LOOP;
  EXECUTE 'CREATE TABLE request_logs_default PARTITION OF request_logs_partitioned DEFAULT';
END $$;

-- 索引在分区母表上声明（自动下推到各分区）
CREATE INDEX request_logs_partitioned_created_idx ON request_logs_partitioned (created_at);
CREATE INDEX request_logs_partitioned_user_created_idx ON request_logs_partitioned (user_id, created_at);

-- 拷贝存量 + 原子换名（drizzle 迁移执行器按事务包裹本文件）
INSERT INTO request_logs_partitioned SELECT * FROM request_logs;
ALTER TABLE request_logs RENAME TO request_logs_unpartitioned;
ALTER TABLE request_logs_partitioned RENAME TO request_logs;
-- bigserial 序列仍被旧表持有所有权，而新表默认值依赖它：先解绑再删旧表，最后把
-- 所有权交给新表并把序列对齐到已拷贝的最大 id。
ALTER SEQUENCE request_logs_id_seq OWNED BY NONE;
DROP TABLE request_logs_unpartitioned;
ALTER SEQUENCE request_logs_id_seq OWNED BY request_logs.id;
SELECT setval('request_logs_id_seq', (SELECT COALESCE(max(id), 1) FROM request_logs));
