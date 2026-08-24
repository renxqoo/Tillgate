import type { PoolClient } from 'pg';
import type { Db } from '@tillgate/db';

/**
 * request_logs 月分区维护(当月+次月预建;超保留期 DETACH+DROP)。
 * v1 worker partition-maintenance 平移;advisory try-lock 内置(未获锁 = 跳过,G7)。
 * 锁键逐字保留 v1(`ai-gateway:request-log-partition`):迁移重叠期新旧 worker 互斥(S3)。
 *
 * ⚠️ request_logs 是手写迁移管理的分区母表(db schema 注释:禁 db:generate)——
 * 本函数是运行时 ensure/maintain 的唯一入口,分区命名 `request_logs_YYYY_MM`。
 */
export interface RequestLogPartitionOptions {
  retentionDays: number;
}

export interface RequestLogPartitionResult {
  created: string[];
  dropped: string[];
}

const LOCK_KEY = "hashtext('ai-gateway:request-log-partition')";

export async function maintainRequestLogPartitions(
  db: Db,
  opts: RequestLogPartitionOptions,
): Promise<RequestLogPartitionResult> {
  const client = await db.$client.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock(${LOCK_KEY}) as acquired`,
    );
    if (!lock.rows[0]?.acquired) return { created: [], dropped: [] };
    try {
      return await maintainOnClient(client, opts);
    } finally {
      await client.query(`select pg_advisory_unlock(${LOCK_KEY})`);
    }
  } finally {
    client.release();
  }
}

/** 月分区维护本体(v1 逐句平移;可测纯 DDL 计划,边界由服务端 SQL 生成) */
async function maintainOnClient(
  client: PoolClient,
  opts: RequestLogPartitionOptions,
): Promise<RequestLogPartitionResult> {
  const table = 'request_logs';
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
