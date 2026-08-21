/**
 * 分区维护双循环：trace_spans（packages/tracing maintainPartitions）
 * + request_logs（月分区）。
 * 各自 advisory lock 防多副本并发；缺位时分区时间窗过后插入直接失败（不是慢，是报错）。
 */
import type { PoolClient } from 'pg';
import { maintainPartitions } from '@ai-gateway/tracing';
import type { Db } from '@ai-gateway/repository';

/** trace_spans 分区维护（预建未来 + 清理超期） */
export async function runTracePartitionMaintenance(
  db: Db,
  opts: { retentionDays: number },
  logger: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void },
): Promise<void> {
  const client = await db.$client.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext('ai-gateway:trace-partition')) as acquired",
    );
    if (!lock.rows[0]?.acquired) return;
    try {
      const result = await maintainPartitions(db, { retentionDays: opts.retentionDays });
      if (result.created.length + result.dropped.length > 0) {
        logger.info(result, 'trace partitions maintained');
      }
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('ai-gateway:trace-partition'))");
    }
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'trace partition maintenance failed');
  } finally {
    client.release();
  }
}

/** request_logs 月分区维护（当月+次月预建；超保留期 DETACH+DROP） */
export async function runRequestLogPartitionMaintenance(
  db: Db,
  opts: { retentionDays: number },
  logger: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void },
): Promise<void> {
  const client = await db.$client.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext('ai-gateway:request-log-partition')) as acquired",
    );
    if (!lock.rows[0]?.acquired) return;
    try {
      const result = await maintainRequestLogPartitions(client, opts);
      if (result.created.length + result.dropped.length > 0) {
        logger.info(result, 'request_logs partitions maintained');
      }
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('ai-gateway:request-log-partition'))");
    }
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'request_logs partition maintenance failed');
  } finally {
    client.release();
  }
}

/** request_logs 月分区维护（可测纯函数；DDL 边界由服务端生成） */
export async function maintainRequestLogPartitions(
  client: PoolClient,
  opts: { retentionDays: number; table?: string },
): Promise<{ created: string[]; dropped: string[] }> {
  const table = opts.table ?? 'request_logs';
  const created: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i <= 1; i++) {
    const r = await client.query<{ name: string }>(
      `select to_char(date_trunc('month', now()) + ($1::text || ' month')::interval, 'YYYY_MM') as name`,
      [String(i)],
    );
    const name = `${table}_${r.rows[0]!.name}`;
    const bounds = await client.query<{ s: string; e: string }>(
      `select (date_trunc('month', now()) + ($1::text || ' month')::interval)::date::text as s,
              (date_trunc('month', now()) + (($1::int + 1)::text || ' month')::interval)::date::text as e`,
      [String(i)],
    );
    const exists = await client.query<{ ok: boolean }>(`select to_regclass($1) is not null as ok`, [
      `public.${name}`,
    ]);
    if (!exists.rows[0]?.ok) {
      await client.query(
        `create table if not exists "${name}" partition of "${table}" for values from ('${bounds.rows[0]!.s}') to ('${bounds.rows[0]!.e}')`,
      );
      created.push(name);
    }
  }
  const stale = await client.query<{ relname: string }>(
    `select c.relname from pg_inherits i
       join pg_class p on i.inhparent = p.oid
       join pg_class c on i.inhrelid = c.oid
      where p.relname = $1
        and c.relname ~ ('^' || $1 || '_[0-9]{4}_[0-9]{2}$')
        and (make_date(
               (regexp_match(c.relname, '^' || $1 || '_([0-9]{4})_[0-9]{2}$'))[1]::int,
               (regexp_match(c.relname, '^' || $1 || '_[0-9]{4}_([0-9]{2})$'))[1]::int,
               1
             ) + interval '1 month')::date
            < (now() - ($2::text || ' days')::interval)::date`,
    [table, String(opts.retentionDays)],
  );
  for (const row of stale.rows) {
    await client.query(`alter table "${table}" detach partition "${row.relname}"`);
    await client.query(`drop table if exists "${row.relname}"`);
    dropped.push(row.relname);
  }
  return { created, dropped };
}
