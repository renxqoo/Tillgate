import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';

/**
 * trace_spans 日分区维护（UTC 天为边界，全链路统一时区）。
 *
 *   - ensureDailyPartition：写入路径调用（按天 memo，CREATE IF NOT EXISTS 幂等，
 *     多副本并发执行无害）
 *   - maintainPartitions：worker 定时调用——预建未来分区 + DETACH/DROP 超期分区
 *     （分区删除而非 DELETE，避免 VACUUM 灾难）
 */

const PARTITION_PREFIX = 'trace_spans_p';

/** Date → 'YYYY-MM-DD'（UTC）；分区边界统一用 UTC，杜绝会话时区错位 */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return dayKey(d);
}

const ensured = new Set<string>();

/** 确保某 UTC 日的分区存在（进程内 memo：每天每副本至多一次 DDL） */
export async function ensureDailyPartition(db: Db, day: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid partition day: ${day}`);
  if (ensured.has(day)) return;
  await db.execute(
    sql.raw(
      `create table if not exists "${PARTITION_PREFIX}${day}" ` +
        // 边界显式 +00 偏移：裸日期串会按建分区会话的时区解释，与 UTC dayKey 错位
        `partition of trace_spans for values from ('${day} 00:00:00+00') to ('${shiftDay(day, 1)} 00:00:00+00')`,
    ),
  );
  ensured.add(day);
}

export interface MaintainOptions {
  /** 保留天数（分区日 < 今天-retention 才删）；默认 7 */
  retentionDays?: number;
  /** 预建未来天数；默认 2 */
  lookaheadDays?: number;
}

export interface MaintainResult {
  created: string[];
  dropped: string[];
}

/** 列出现有分区日（只认本命名规则，天然避开无关表） */
export async function listPartitionDays(db: Db): Promise<string[]> {
  const result = await db.execute<{ relname: string }>(sql`
    select c.relname from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    where p.relname = 'trace_spans'
  `);
  return result.rows
    .map((r) => r.relname)
    .filter((name) => name.startsWith(PARTITION_PREFIX))
    .map((name) => name.slice(PARTITION_PREFIX.length))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .toSorted();
}

/** 预建未来分区 + 清理超期分区（幂等；DETACH 后 DROP，避免并发查询踩删除） */
export async function maintainPartitions(
  db: Db,
  options: MaintainOptions = {},
): Promise<MaintainResult> {
  const retentionDays = Math.max(0, options.retentionDays ?? 7);
  const lookaheadDays = Math.max(0, options.lookaheadDays ?? 2);
  const today = dayKey(new Date());
  const cutoff = shiftDay(today, -retentionDays);

  const created: string[] = [];
  for (let i = 0; i <= lookaheadDays; i++) {
    const day = shiftDay(today, i);
    const before = new Set(await listPartitionDays(db));
    await ensureDailyPartition(db, day);
    if (!before.has(day)) created.push(day);
  }

  const dropped: string[] = [];
  for (const day of await listPartitionDays(db)) {
    if (day < cutoff) {
      await db.execute(
        sql.raw(`alter table trace_spans detach partition "${PARTITION_PREFIX}${day}"`),
      );
      await db.execute(sql.raw(`drop table if exists "${PARTITION_PREFIX}${day}"`));
      dropped.push(day);
    }
  }
  return { created, dropped };
}
