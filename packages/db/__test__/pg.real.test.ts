/**
 * 真实 PostgreSQL 集成:SAVEPOINT 退化、真实唯一冲突、
 * advisory lock、池生命周期。资金级边界行为必须真实 PG 语义。
 *
 * 运行约定:DB_TEST_URL(优先)或 DATABASE_URL 缺失时整组 skip(与 ai 包 *.real.test.ts 同约定);
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
  withSessionTryLock,
  type Db,
  type DbTx,
} from '../src/index.js';
import { defined } from './defined.js';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
const SCHEMA = sql.raw('tillgate_db_test');
/** 测试池参数(显式注入,无默认——与包契约一致) */
const POOL = {
  poolMax: 5,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 3_000,
} as const;

(url ? describe : describe.skip)('真实 PostgreSQL(db 基础设施)', () => {
  let db: Db;

  const countKv = async (k: number): Promise<number> => {
    const r = await db.execute(sql`select count(*)::int as n from ${SCHEMA}.kv where k = ${k}`);
    return (r[0] as { n: number }).n;
  };

  // 内层事务体:插入后抛错——SAVEPOINT 回滚断言的行为载体(作用域级具名函数,压平回调嵌套)
  const innerTxThatFails = async (inner: DbTx): Promise<void> => {
    await inner.execute(sql`insert into ${SCHEMA}.kv values (3, 'inner')`);
    throw new Error('inner fail');
  };

  beforeAll(async () => {
    db = createDb({ url: defined(url, 'url'), ...POOL });
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
          runTx(tx, innerTxThatFails, { maxAttempts: 2, baseDelayMs: 5, maxJitterMs: 5 }),
        ).rejects.toThrow('inner fail');
        const innerRows = await tx.execute(
          sql`select count(*)::int as n from ${SCHEMA}.kv where k = 3`,
        );
        expect((innerRows[0] as { n: number }).n).toBe(0); // savepoint 已回滚
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
    const own = createDb({ url: defined(url, 'url'), ...POOL });
    await ping(own); // select 1
    await closeDb(own);
    await expect(own.execute(sql`select 1`)).rejects.toThrow();
  });

  it('withSessionTryLock:持锁连接在锁窗口内被杀 → 结果不丢、锁释放、池健康(R-5)', async () => {
    const key = 'tillgate-db-test:unlock-fail';
    const defects: Array<{ key: string }> = [];
    const advisoryLockCount = async (): Promise<number> => {
      const rows = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_locks
        where locktype = 'advisory' and classid = 0 and objid = hashtext(${key})::bigint`);
      return Number((rows[0] as { n: number }).n);
    };
    const result = await withSessionTryLock(
      db,
      {
        key,
        onDefect: (error, defectKey) => {
          void error;
          defects.push({ key: defectKey });
        },
      },
      async () => {
        // fn 走池连接;持锁者是 withSessionTryLock 内部的保留连接——杀死它,
        // 后续 unlock 语句必然失败(连接已死),进入解锁失败处置分支
        await db.execute(sql`
          select pg_terminate_backend(l.pid) from pg_locks l
          where l.locktype = 'advisory' and l.classid = 0 and l.objid = hashtext(${key})::bigint`);
        return 'ran';
      },
    );
    expect(result).toBe('ran'); // fn 结果不被解锁失败反杀
    expect(defects).toHaveLength(1); // 缺陷上报恰一次
    expect(defects[0]?.key).toBe(key);
    // 锁不残留(连接死亡即释放——若实现把持锁死连接归还池,锁表可见悬挂)
    expect(await advisoryLockCount()).toBe(0);
    // 池仍健康:同键 try-lock 立即可用
    expect(await withSessionTryLock(db, { key }, async () => 'second')).toBe('second');
    expect(await advisoryLockCount()).toBe(0);
  });
});
