import type { PoolClient } from 'pg';

/**
 * request_logs 月分区维护（R6，自 worker-application 提取为可测函数）：
 *   - 确保 [当月, 次月] 分区存在（幂等）
 *   - DETACH + DROP 结束日期早于 now() - retentionDays 的分区（30 天滚动）
 *   - 表名可参数化（默认 request_logs；测试用一次性表）
 */
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
      // PARTITION OF 边界是 DDL，不能带参数；日期由服务端 ::date::text 生成（YYYY-MM-DD），
      // 表名经 relname 白名单正则约束——无注入面
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
