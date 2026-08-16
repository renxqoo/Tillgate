import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { loadRootEnvFile } from '@ai-gateway/http';
import { Pool } from 'pg';
import { maintainRequestLogPartitions } from '../request-log-partitions.js';
import { isDeepHealthAuthorized } from '../health-gate.js';

/**
 * A8：request_logs 月分区维护（一次性表上验证——建未来分区幂等 + 滚动删过期分区）。
 * A10：worker /health 深度口令牌门（未配 token 一律拒；恒定时间比较）。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway');
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway' });
const TMP = 'tmp_part_test';

let connected = false;
beforeAll(async () => {
  try {
    await db.execute(sql`select 1`);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  if (connected) await pool.query(`drop table if exists ${TMP} cascade`).catch(() => {});
  await pool.end().catch(() => {});
  await db.$client.end().catch(() => {});
});

describe('A8 maintainRequestLogPartitions（一次性表）', () => {
  it('建当月/次月分区幂等；retention=13 时删除上月分区', async (context) => {
    if (!connected) return context.skip();
    const client = await pool.connect();
    try {
      await client.query(`drop table if exists ${TMP} cascade`);
      await client.query(
        `create table ${TMP} (id bigserial, created_at timestamptz not null default now(), primary key (id, created_at))
           partition by range (created_at)`,
      );
      // 手工建一个「上月」分区（含过期数据）
      const prevMonth = await client.query<{ s: string; e: string; name: string }>(
        `select (date_trunc('month', now()) - interval '1 month')::date::text as s,
                date_trunc('month', now())::date::text as e,
                to_char(date_trunc('month', now()) - interval '1 month', 'YYYY_MM') as name`,
      );
      await client.query(
        `create table ${TMP}_${prevMonth.rows[0]!.name} partition of ${TMP} for values from ('${prevMonth.rows[0]!.s}') to ('${prevMonth.rows[0]!.e}')`,
      );

      // 第一轮：建 [当月, 次月]，retention=13 → 上月分区结束日 ≤ 今月 1 日 < 今-13d? 按真实日历判定
      const r1 = await maintainRequestLogPartitions(client, { retentionDays: 13, table: TMP });
      expect(r1.created.length).toBe(2); // 当月 + 次月
      // 上月分区是否被删取决于日历（今月 1 日 < 今-13d 当且仅当日 ≥ 14 日）；
      // 用 SQL 直接验证判定而非猜日期：结束日 < now()-13d
      const expectDrop = await client.query<{ ok: boolean }>(
        `select (date_trunc('month', now())::date < (now() - interval '13 days')::date) as ok`,
      );
      expect(r1.dropped.length).toBe(expectDrop.rows[0]!.ok ? 1 : 0);

      // 第二轮：幂等（无新建），且不误删当月/次月
      const r2 = await maintainRequestLogPartitions(client, { retentionDays: 13, table: TMP });
      expect(r2.created.length).toBe(0);
      const parts = await client.query<{ relname: string }>(
        `select c.relname from pg_inherits i join pg_class p on i.inhparent=p.oid join pg_class c on i.inhrelid=c.oid where p.relname=$1`,
        [TMP],
      );
      expect(parts.rows.length).toBeGreaterThanOrEqual(2); // 当月 + 次月常在
    } finally {
      client.release();
    }
  });
});

describe('A10 isDeepHealthAuthorized', () => {
  it('未配 token 一律拒；正确 token 过；错误/缺失拒', () => {
    const t = 'h'.repeat(32);
    expect(isDeepHealthAuthorized(undefined, undefined)).toBe(false); // 未配置 fail-closed
    expect(isDeepHealthAuthorized(t, undefined)).toBe(false);
    expect(isDeepHealthAuthorized(undefined, t)).toBe(false);
    expect(isDeepHealthAuthorized('wrong-token-aaaaaaaaaaaaaaaaaaaaaaaa', t)).toBe(false);
    expect(isDeepHealthAuthorized(t, t)).toBe(true);
  });
});
