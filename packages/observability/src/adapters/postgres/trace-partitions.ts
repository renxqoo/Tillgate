import { sql } from 'drizzle-orm';
import { withSessionTryLock, type Db } from '@tillgate/db';
import {
  TRACE_PARTITION_DAY_RE,
  dayKey,
  shiftDay,
  type MaintainPartitionsOptions,
  type MaintainPartitionsResult,
} from '../../tracing/partition';
import { observabilityErrors } from '../../errors';

/**
 * trace_spans 日分区 DDL(UTC 天边界,全链路统一时区)。
 *
 *   - ensureTracePartition:写入路径调用(CREATE IF NOT EXISTS 幂等,多副本并发执行无害;
 *     进程内 memo 在 store 闭包,此处不缓存——维护路径靠 list 差集判定)
 *   - maintainTracePartitions:worker 定时调用——预建未来分区 + DETACH/DROP 超期分区
 *     (分区删除而非 DELETE,避免 VACUUM 灾难);内置 advisory try-lock,未获锁 = 跳过
 *
 * 锁键逐字保留 v1(`ai-gateway:trace-partition`):迁移重叠期新旧 worker 互斥(S3)。
 */

const PARTITION_PREFIX = 'trace_spans_p';
const LOCK_KEY = 'ai-gateway:trace-partition';

/** 确保某 UTC 日的分区存在(幂等) */
export async function ensureTracePartition(db: Db, day: string): Promise<void> {
  if (!TRACE_PARTITION_DAY_RE.test(day)) {
    throw observabilityErrors.business('invalid_partition_day', { day });
  }
  await db.execute(
    sql.raw(
      `create table if not exists "${PARTITION_PREFIX}${day}" ` +
        // 边界显式 +00 偏移:裸日期串会按建分区会话的时区解释,与 UTC dayKey 错位
        `partition of trace_spans for values from ('${day} 00:00:00+00') to ('${shiftDay(day, 1)} 00:00:00+00')`,
    ),
  );
}

/** 列出现有分区日(只认本命名规则,天然避开无关表) */
export async function listTracePartitionDays(db: Db): Promise<string[]> {
  const result = await db.execute<{ relname: string }>(sql`
    select c.relname from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    where p.relname = 'trace_spans'
  `);
  return result
    .map((r) => r.relname)
    .filter((name) => name.startsWith(PARTITION_PREFIX))
    .map((name) => name.slice(PARTITION_PREFIX.length))
    .filter((day) => TRACE_PARTITION_DAY_RE.test(day))
    .toSorted();
}

/** 预建未来分区 + 清理超期分区(幂等;DETACH 后 DROP,避免并发查询踩删除);未获锁返回空结果 */
export async function maintainTracePartitions(
  db: Db,
  options: MaintainPartitionsOptions = {},
): Promise<MaintainPartitionsResult> {
  const retentionDays = Math.max(0, options.retentionDays ?? 7);
  const lookaheadDays = Math.max(0, options.lookaheadDays ?? 2);
  const today = dayKey(new Date());
  const cutoff = shiftDay(today, -retentionDays);

  // 锁是跨进程互斥(专用连接持有),DDL 走池连接——与 v1 语义等价
  return (
    (await withSessionTryLock(db, { key: LOCK_KEY }, async () => {
      const created: string[] = [];
      for (let i = 0; i <= lookaheadDays; i++) {
        const day = shiftDay(today, i);
        const before = new Set(await listTracePartitionDays(db));
        await ensureTracePartition(db, day);
        if (!before.has(day)) created.push(day);
      }

      const dropped: string[] = [];
      for (const day of await listTracePartitionDays(db)) {
        if (day < cutoff) {
          await db.execute(
            sql.raw(`alter table trace_spans detach partition "${PARTITION_PREFIX}${day}"`),
          );
          await db.execute(sql.raw(`drop table if exists "${PARTITION_PREFIX}${day}"`));
          dropped.push(day);
        }
      }
      return { created, dropped };
    })) ?? { created: [], dropped: [] }
  );
}
