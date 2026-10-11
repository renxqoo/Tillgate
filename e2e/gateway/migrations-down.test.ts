/**
 * migration 0114/0115 down 可执行性验证（docs §11 契约级——路 C#6）：
 * 真实 PG 上 up（已随 schema 回放）→ down → 再 up，断言表/列/ACL 行恢复。
 * down 是回滚阶梯的终点动作（§9 步骤 5）——纯声明的对称性不算验证。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { setupE2EWorld, type E2EWorld } from './kit';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

/** 迁移文件 → 语句序列（剥注释行后按分号切——注释块黏连 DDL 时简单 split 会误滤） */
function statements(file: string): string[] {
  return file
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(!hasEnv)('migration 0114/0115 down 双向可执行', () => {
  it('up → down → up 循环：表/列/ACL 行完整恢复', async () => {
    const world: E2EWorld = await setupE2EWorld();
    const db = world.db;
    const migrationsDir = join(import.meta.dirname, '../../packages/db/migrations');
    const down0113 = readFileSync(join(migrationsDir, '0114_prefix_calibrations.down.sql'), 'utf8');
    const down0114 = readFileSync(
      join(migrationsDir, '0115_billing_calibration_admin.down.sql'),
      'utf8',
    );
    const up0113 = readFileSync(join(migrationsDir, '0114_prefix_calibrations.sql'), 'utf8');
    const up0114 = readFileSync(join(migrationsDir, '0115_billing_calibration_admin.sql'), 'utf8');

    // 前置：schema 回放后 0113/0114 已 up（表存在）
    const hasTable = async () =>
      (
        await db.execute(
          sql`select exists (select 1 from information_schema.tables where table_name = 'prefix_calibrations') as ok`,
        )
      )[0] as { ok: boolean };
    expect((await hasTable()).ok).toBe(true);

    // down（0114 先——ACL 依赖；再 0113）→ 断言拆除
    for (const stmt of statements(down0114)) await db.execute(sql.raw(stmt));
    for (const stmt of statements(down0113)) await db.execute(sql.raw(stmt));
    expect((await hasTable()).ok).toBe(false);
    const colGone = (
      await db.execute(
        sql`select exists (select 1 from information_schema.columns where table_name = 'billing_requests' and column_name = 'conservative_channel_amount') as ok`,
      )
    )[0] as { ok: boolean };
    expect(colGone.ok).toBe(false);

    // 再 up → 断言恢复（含 ACL 行——0114 的 VALUES 幂等插入）
    for (const stmt of statements(up0113)) await db.execute(sql.raw(stmt));
    for (const stmt of statements(up0114)) await db.execute(sql.raw(stmt));
    expect((await hasTable()).ok).toBe(true);
    const acl = (
      await db.execute(
        sql`select count(*)::int as n from endpoint_permissions where path = '/v1/settings/billing-calibration'`,
      )
    )[0] as { n: number };
    expect(acl.n).toBe(2); // GET + PUT
    await world.teardown();
  }, 120_000);
});
