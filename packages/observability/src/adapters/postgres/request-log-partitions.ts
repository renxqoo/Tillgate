import type { SQL } from 'bun';
import { withSessionTryLock, type Db } from '@tillgate/db';

/**
 * request_logs 月分区维护(当月+次月预建;超保留期 DETACH+DROP)。
 * v1 worker partition-maintenance 平移;advisory try-lock 内置(未获锁 = 跳过,G7)。
 * 锁键逐字保留 v1(`ai-gateway:request-log-partition`):迁移重叠期新旧 worker 互斥(S3)。
 *
 * ⚠️ request_logs 是手写迁移管理的分区母表(db schema 注释:禁 db:generate)——
 * 本函数是运行时 ensure/maintain 的唯一入口,分区命名 `request_logs_YYYY_MM`。
 * bun-native:专用连接为 Bun SQL reserve;unsafe(text, params) 承接 v1 的
 * client.query 逐句文本(DDL 不接受绑定参数——边界串是服务端 to_char/date_trunc
 * 产物,字符集受限,与 v1 同等内联信任)。
 */
export interface RequestLogPartitionOptions {
  retentionDays: number;
}

export interface RequestLogPartitionResult {
  created: string[];
  dropped: string[];
}

const LOCK_KEY = 'ai-gateway:request-log-partition';

export async function maintainRequestLogPartitions(
  db: Db,
  opts: RequestLogPartitionOptions,
): Promise<RequestLogPartitionResult> {
  return (
    (await withSessionTryLock(db, { key: LOCK_KEY }, () => runOnReserved(db, opts))) ?? {
      created: [],
      dropped: [],
    }
  );
}

/** 锁已持有后的维护本体;语句走独立专用连接(锁是跨进程互斥,不要求同连接执行) */
async function runOnReserved(db: Db, opts: RequestLogPartitionOptions): Promise<RequestLogPartitionResult> {
  const client = await db.$client.reserve();
  try {
    const table = 'request_logs';
    const created = await ensureMonthlyPartitions(client, table);
    const stale = await client.unsafe<Array<{ relname: string }>>(
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
    const dropped: string[] = [];
    for (const row of stale) {
      await client.unsafe(`alter table "${table}" detach partition "${row.relname}"`);
      await client.unsafe(`drop table if exists "${row.relname}"`);
      dropped.push(row.relname);
    }
    return { created, dropped };
  } finally {
    await client.release();
  }
}

/** 预建当月+次月分区(to_regclass 探测,已存在则跳过);返回新建的分区名 */
async function ensureMonthlyPartitions(client: SQL, table: string): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i <= 1; i++) {
    const r = await client.unsafe<Array<{ name: string }>>(
      `select to_char(date_trunc('month', now()) + ($1::text || ' month')::interval, 'YYYY_MM') as name`,
      [String(i)],
    );
    const [monthRow] = r;
    if (monthRow === undefined) {
      throw new Error('expected one month-name row from to_char query');
    }
    const name = `${table}_${monthRow.name}`;
    const bounds = await client.unsafe<Array<{ s: string; e: string }>>(
      `select (date_trunc('month', now()) + ($1::text || ' month')::interval)::date::text as s,
              (date_trunc('month', now()) + (($1::int + 1)::text || ' month')::interval)::date::text as e`,
      [String(i)],
    );
    const exists = await client.unsafe<Array<{ ok: boolean }>>(`select to_regclass($1) is not null as ok`, [
      `public.${name}`,
    ]);
    if (!exists[0]?.ok) {
      const [boundsRow] = bounds;
      if (boundsRow === undefined) {
        throw new Error('expected one month-bounds row from date_trunc query');
      }
      await client.unsafe(
        `create table if not exists "${name}" partition of "${table}" for values from ('${boundsRow.s}') to ('${boundsRow.e}')`,
      );
      created.push(name);
    }
  }
  return created;
}
