/** run 生命周期：首执行/重放/指纹漂移冲突/回滚重试/事务注入/回执约束/效应语义 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ledgerOperations } from '../schema';
import { InvalidInputError, OperationConflictError } from '../errors';
import { buildFixture, db, nextOperationId } from './helpers';

describe('run：首执行与重放', () => {
  it('首次执行落档；同键同参重放不执行、回执逐字节一致', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    const receipt = { transactionId: 9001, balanceAfter: '128.00' };
    const first = await fx.ledger.run({
      operationId,
      kind: 'payment.credit',
      fingerprint: { userId: 7, amount: '128.00' },
      execute: fx.makeExecute(receipt),
    });
    expect(first.replayed).toBe(false);
    expect(first.receipt).toEqual(receipt);
    expect(fx.executions()).toBe(1);

    const replay = await fx.ledger.run({
      operationId,
      kind: 'payment.credit',
      fingerprint: { amount: '128.00', userId: 7 }, // 键序无关
      execute: fx.makeExecute({ transactionId: 9999 }), // 重放不会执行到这个
    });
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(receipt);
    expect(fx.executions()).toBe(1);
    expect(replay.createdAt).toBe(first.createdAt);
  });

  it('指纹漂移 → OperationConflictError(fingerprint_mismatch)；kind 漂移 → kind_mismatch', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    await fx.ledger.run({
      operationId,
      kind: 'payment.credit',
      fingerprint: { userId: 7, amount: '10.00' },
      execute: fx.makeExecute({ ok: true }),
    });
    const drift = await fx.ledger
      .run({
        operationId,
        kind: 'payment.credit',
        fingerprint: { userId: 7, amount: '99.00' },
        execute: fx.makeExecute({ ok: true }),
      })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as OperationConflictError,
      );
    expect(drift).toBeInstanceOf(OperationConflictError);
    expect(drift.reason).toBe('fingerprint_mismatch');

    const kindDrift = await fx.ledger
      .run({
        operationId,
        kind: 'payment.refund',
        fingerprint: { userId: 7, amount: '10.00' },
        execute: fx.makeExecute({ ok: true }),
      })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as OperationConflictError,
      );
    expect(kindDrift).toBeInstanceOf(OperationConflictError);
    expect(kindDrift.reason).toBe('kind_mismatch');
    expect(fx.executions()).toBe(1);
  });

  it('execute 抛错 → 操作行随事务回滚；重试接棒执行', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    let attempt = 0;
    const result = await fx.ledger
      .run({
        operationId,
        kind: 'order.place',
        fingerprint: { orderId: 'o-1' },
        execute: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('upstream down');
          return { placed: true };
        },
      })
      .catch(() => null);
    expect(result).toBeNull();
    const rows = await db
      .select()
      .from(ledgerOperations)
      .where(eq(ledgerOperations.operationId, operationId));
    expect(rows).toHaveLength(0); // 回滚=操作行不存在，不是「执行了没回执」

    const retry = await fx.ledger.run({
      operationId,
      kind: 'order.place',
      fingerprint: { orderId: 'o-1' },
      execute: async () => {
        attempt += 1;
        return { placed: true };
      },
    });
    expect(retry.replayed).toBe(false);
    expect(retry.receipt).toEqual({ placed: true });
  });

  it('tx 注入：随调用方事务回滚；调用方提交则落档（业务写与操作行同生共死）', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    await expect(
      db.transaction(async (tx) => {
        await fx.ledger.run({
          operationId,
          kind: 'gift.grant',
          fingerprint: { userId: 1 },
          execute: fx.makeExecute({ granted: true }),
          tx,
        });
        throw new Error('caller-abort');
      }),
    ).rejects.toThrow('caller-abort');
    expect(
      (await db.select().from(ledgerOperations).where(eq(ledgerOperations.operationId, operationId))).length,
    ).toBe(0);

    await db.transaction(async (tx) => {
      await fx.ledger.run({
        operationId,
        kind: 'gift.grant',
        fingerprint: { userId: 1 },
        execute: fx.makeExecute({ granted: true }),
        tx,
      });
    });
    const view = await fx.ledger.operation({ operationId });
    expect(view?.receipt).toEqual({ granted: true });
  });

  it('execute 内可写库：嵌套另一操作行（同库写证明 tx 有效性），回滚连带消失', async () => {
    const fx = buildFixture();
    const outer = nextOperationId();
    const inner = nextOperationId();
    await fx.ledger.run({
      operationId: outer,
      kind: 'order.place',
      fingerprint: { id: outer },
      execute: async (tx) => {
        await tx.insert(ledgerOperations).values({ operationId: inner, kind: 'order.cancel', fingerprint: 'f'.repeat(64) });
        return { nested: inner };
      },
    });
    expect(await fx.ledger.operation({ operationId: inner })).not.toBeNull();

    const outer2 = nextOperationId();
    const inner2 = nextOperationId();
    await fx.ledger
      .run({
        operationId: outer2,
        kind: 'order.place',
        fingerprint: { id: outer2 },
        execute: async (tx) => {
          await tx.insert(ledgerOperations).values({ operationId: inner2, kind: 'order.cancel', fingerprint: 'f'.repeat(64) });
          throw new Error('business fail');
        },
      })
      .catch(() => undefined);
    expect(await fx.ledger.operation({ operationId: inner2 })).toBeNull();
  });
});

describe('run：回执约束', () => {
  it('回执 null 合法（纯审计型操作）；重放归 null', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    const result = await fx.ledger.run({
      operationId,
      kind: 'subscription.cancel',
      fingerprint: { subId: 5 },
      execute: fx.makeExecute(null),
    });
    expect(result.receipt).toBeNull();
    const replay = await fx.ledger.run({
      operationId,
      kind: 'subscription.cancel',
      fingerprint: { subId: 5 },
      execute: fx.makeExecute({ wrong: true }),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toBeNull();
  });

  it('回执非纯对象拒绝（数组/标量）；超 16KB 拒绝——且整个事务回滚不留半档', async () => {
    const fx = buildFixture();
    const arrayOp = nextOperationId();
    await expect(
      fx.ledger.run({
        operationId: arrayOp,
        kind: 'gift.grant',
        fingerprint: { id: arrayOp },
        execute: fx.makeExecute([1, 2] as never),
      }),
    ).rejects.toThrow(InvalidInputError);
    expect(await fx.ledger.operation({ operationId: arrayOp })).toBeNull();

    const bigOp = nextOperationId();
    await expect(
      fx.ledger.run({
        operationId: bigOp,
        kind: 'gift.grant',
        fingerprint: { id: bigOp },
        execute: fx.makeExecute({ blob: 'x'.repeat(20_000) }),
      }),
    ).rejects.toThrow(InvalidInputError);
    expect(await fx.ledger.operation({ operationId: bigOp })).toBeNull();
  });
});

describe('run：效应语义', () => {
  it('committed 首执行与重放都触发（replayed 区分）；audit 跟随', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    const input = {
      operationId,
      kind: 'payment.credit',
      fingerprint: { userId: 1 },
      execute: fx.makeExecute({ ok: 1 }),
    };
    await fx.ledger.run(input);
    await fx.ledger.run(input);
    expect(fx.committed.map((c) => c.replayed)).toEqual([false, true]);
    expect(fx.audits.map((a) => a.action)).toEqual(['operation.execute', 'operation.replay']);
  });

  it('committed/audit 抛错被吞（提交后观测失败不改变结果）', async () => {
    const fx = buildFixture({
      effects: {
        committed: async () => {
          throw new Error('bus down');
        },
        audit: async () => {
          throw new Error('audit down');
        },
      },
    });
    const result = await fx.ledger.run({
      operationId: nextOperationId(),
      kind: 'gift.grant',
      fingerprint: { userId: 2 },
      execute: fx.makeExecute({ ok: true }),
    });
    expect(result.replayed).toBe(false);
    expect(result.receipt).toEqual({ ok: true });
  });
});
