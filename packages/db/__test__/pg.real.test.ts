/**
 * 真实 PostgreSQL 集成(IMPLEMENTATION.md §4):SAVEPOINT 退化、真实唯一冲突、
 * advisory lock、池生命周期。资金级边界行为必须真实 PG 语义(总纲 §5.6)。
 *
 * 运行约定:DB_TEST_URL(优先)或 DATABASE_URL 缺失时整组 skip(与 ai 包 *.real.test.ts 同约定(铁律 14));
 * 只在独立 scratch schema(tillgate_db_test)内造对象,结束即删,不触碰库内既有对象。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  advisoryLock,
  closeDb,
  createDb,
  isUniqueViolation,
  ping,
  runTx,
  uniqueViolationConstraint,
  type Db,
} from '../src/index.js';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
const SCHEMA = sql.raw('tillgate_db_test');
/** 测试池参数(显式注入,无默认——与包契约一致) */
const POOL = {
  poolMax: 5,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 3_000,
  maxUses: 1_000,
} as const;

(url ? describe : describe.skip)('真实 PostgreSQL(db 基础设施)', () => {
  let db: Db;

  const countKv = async (k: number): Promise<number> => {
    const r = await db.execute(sql`select count(*)::int as n from ${SCHEMA}.kv where k = ${k}`);
    return (r.rows[0] as { n: number }).n;
  };

  beforeAll(async () => {
    db = createDb({ url: url!, ...POOL });
    await db.execute(sql`create schema if not exists ${SCHEMA}`);
    await db.execute(sql`create table if not exists ${SCHEMA}.kv (k int primary key, v text)`);
    await db.execute(sql`truncate ${SCHEMA}.kv`);
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`drop schema if exists ${SCHEMA} cascade`);
      await closeDb(db);
    }
  });

  it('runTx 提交后对外可见', async () => {
    await runTx(
      db,
      async (tx) => {
        await tx.execute(sql`insert into ${SCHEMA}.kv values (1, 'committed')`);
      },
      { maxAttempts: 2, baseDelayMs: 5, maxJitterMs: 5 },
    );
    expect(await countKv(1)).toBe(1);
  });

  it('真实 23505:唯一冲突被检出(含约束名),事务整体回滚', async () => {
    let captured: unknown;
    await expect(
      runTx(
        db,
        async (tx) => {
          await tx.execute(sql`insert into ${SCHEMA}.kv values (1, 'dup')`);
        },
        { maxAttempts: 2, baseDelayMs: 5, maxJitterMs: 5 },
      ),
    ).rejects.toThrow();
    try {
      await db.execute(sql`insert into ${SCHEMA}.kv values (1, 'dup-pool')`);
    } catch (error) {
      captured = error;
    }
    expect(isUniqueViolation(captured)).toBe(true);
    expect(uniqueViolationConstraint(captured)).toBe('kv_pkey');
    expect(await countKv(1)).toBe(1); // 回滚生效,重复插入未留痕
  });

  it('SAVEPOINT:外层事务内 runTx 失败只回滚内层,外层照常提交', async () => {
    await runTx(
      db,
      async (tx) => {
        await tx.execute(sql`insert into ${SCHEMA}.kv values (2, 'outer')`);
        await expect(
          runTx(
            tx,
            async (inner) => {
              await inner.execute(sql`insert into ${SCHEMA}.kv values (3, 'inner')`);
              throw new Error('inner fail');
            },
            { maxAttempts: 2, baseDelayMs: 5, maxJitterMs: 5 },
          ),
        ).rejects.toThrow('inner fail');
        const innerRows = await tx.execute(
          sql`select count(*)::int as n from ${SCHEMA}.kv where k = 3`,
        );
        expect((innerRows.rows[0] as { n: number }).n).toBe(0); // savepoint 已回滚
      },
      { maxAttempts: 2, baseDelayMs: 5, maxJitterMs: 5 },
    );
    expect(await countKv(2)).toBe(1); // 外层提交不受内层失败影响
    expect(await countKv(3)).toBe(0);
  });

  it('瞬态错误在真实句柄上触发重试并恢复', async () => {
    let attempt = 0;
    await runTx(
      db,
      async (tx) => {
        attempt += 1;
        if (attempt === 1) {
          // 模拟 drizzle 包装形态的串行化失败(真实 40001 由 PG 并发冲突产生,此处验证端到端接线)
          throw new Error('drizzle-wrap', {
            cause: Object.assign(new Error('serialization failure'), { code: '40001' }),
          });
        }
        await tx.execute(sql`insert into ${SCHEMA}.kv values (4, 'retried')`);
      },
      { maxAttempts: 3, baseDelayMs: 1, maxJitterMs: 1 },
    );
    expect(attempt).toBe(2);
    expect(await countKv(4)).toBe(1);
  });

  it('advisoryLock:同事务内同键可重入(xact 锁语义)', async () => {
    await runTx(
      db,
      async (tx) => {
        await advisoryLock(tx, 'tillgate-db-test:reentrant');
        await advisoryLock(tx, 'tillgate-db-test:reentrant'); // 不阻塞不死锁
      },
      { maxAttempts: 2, baseDelayMs: 5, maxJitterMs: 5 },
    );
  });

  it('池生命周期:createDb → ping → closeDb,关闭后连接拒绝', async () => {
    const own = createDb({ url: url!, ...POOL });
    await ping(own); // select 1
    await closeDb(own);
    await expect(own.execute(sql`select 1`)).rejects.toThrow();
  });
});
