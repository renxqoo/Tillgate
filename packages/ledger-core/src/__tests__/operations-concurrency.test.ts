/** 并发语义：同键 N 并发恰一次 execute / 指纹互异全冲突 / 慢执行不被半途读 / 异键互不干扰 */
import { describe, expect, it } from 'vitest';
import { OperationConflictError } from '../errors';
import { ledgerOperations } from '../schema';
import { buildFixture, nextOperationId, sleep } from './helpers';

describe('同键并发（唯一索引单语句定序）', () => {
  it('6 路并发同键同参：全部成功、回执结构一致、提交的 execute 恰一次', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    const receipt = { transactionId: 42, balanceAfter: '10.00' };
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        fx.ledger.run({
          operationId,
          kind: 'payment.credit',
          fingerprint: { userId: 9, amount: '10.00' },
          execute: fx.makeExecute(receipt),
        }),
      ),
    );
    expect(outcomes).toHaveLength(6);
    // 结构一致（jsonb 不保键序，重放回执键序可能与内存对象不同——断言语义用结构相等）
    for (const outcome of outcomes) {
      expect(outcome.receipt).toEqual(receipt);
    }
    // 恰一个非重放结果 = 恰一次「已提交」的 execute（重试壳内被回滚的尝试不计入结果）
    const nonReplayed = outcomes.filter((o) => !o.replayed);
    expect(nonReplayed).toHaveLength(1);
    expect(fx.executions()).toBeGreaterThanOrEqual(1);
  });

  it('6 路并发同键互异指纹：恰一人执行，其余 fingerprint_mismatch', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        fx.ledger.run({
          operationId,
          kind: 'gift.grant',
          fingerprint: { seq: i },
          execute: fx.makeExecute({ won: i }),
        }),
      ),
    );
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const conflicts = outcomes.filter(
      (o) => o.status === 'rejected' && o.reason instanceof OperationConflictError,
    );
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(5);
    const conflictError = (conflicts[0] as PromiseRejectedResult).reason as OperationConflictError;
    expect(conflictError.reason).toBe('fingerprint_mismatch');
    expect(fx.executions()).toBe(1);
  });

  it('慢执行期间并发重放：阻塞到首个事务终结后拿到完整回执（无半成品读）', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    const receipt = { slow: true, items: [1, 2, 3] };
    const slow = fx.ledger.run({
      operationId,
      kind: 'order.place',
      fingerprint: { orderId: 'slow-1' },
      execute: async () => {
        await sleep(300);
        return receipt;
      },
    });
    await sleep(50); // 让首个事务先起步占住唯一键
    const replay = await fx.ledger.run({
      operationId,
      kind: 'order.place',
      fingerprint: { orderId: 'slow-1' },
      execute: fx.makeExecute({ wrong: true }),
    });
    const first = await slow;
    expect(first.replayed).toBe(false);
    expect(first.receipt).toEqual(receipt);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(receipt);
  });

  it('首个事务回滚后，阻塞中的并发者接棒执行', async () => {
    const fx = buildFixture();
    const operationId = nextOperationId();
    let attempt = 0;
    const winner = fx.ledger.run({
      operationId,
      kind: 'order.settle',
      fingerprint: { orderId: 'r-1' },
      execute: async () => {
        attempt += 1;
        if (attempt === 1) {
          await sleep(200);
          throw new Error('first aborts');
        }
        return { settled: true };
      },
    });
    const loser = (async () => {
      await sleep(50);
      return fx.ledger.run({
        operationId,
        kind: 'order.settle',
        fingerprint: { orderId: 'r-1' },
        execute: async () => {
          attempt += 1;
          return { settled: true };
        },
      });
    })();
    await expect(winner).rejects.toThrow('first aborts');
    const taken = await loser;
    expect(taken.replayed).toBe(false);
    expect(taken.receipt).toEqual({ settled: true });
  });
});

describe('异键并发', () => {
  it('20 个不同操作并行全部执行成功', async () => {
    const fx = buildFixture();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        fx.ledger.run({
          operationId: `test.bulk:${Date.now().toString(36)}.${i}`,
          kind: 'gift.grant',
          fingerprint: { seq: i },
          execute: fx.makeExecute({ seq: i }),
        }),
      ),
    );
    expect(outcomes.every((o) => !o.replayed)).toBe(true);
    expect(fx.executions()).toBe(20);
  });

  it('同库并发写不同业务行的死锁由 runTx 重试壳吸收（重试后要么执行要么重放）', async () => {
    const fx = buildFixture();
    // 两组操作各自嵌套以相反顺序写同两行，制造死锁窗口；runTx 自动重试兜底
    const base = Date.now().toString(36);
    const run = (suffix: string, order: [string, string]) =>
      fx.ledger.run({
        operationId: `test.deadlock:${base}.${suffix}`,
        kind: 'order.place',
        fingerprint: { suffix, order },
        execute: async (tx) => {
          for (const target of order) {
            await tx
              .insert(ledgerOperations)
              .values({ operationId: target, kind: 'order.cancel', fingerprint: 'f'.repeat(64) })
              .onConflictDoNothing({ target: ledgerOperations.operationId });
          }
          return { done: true };
        },
      });
    const results = await Promise.all([
      run('a', [`test.dl:${base}.1`, `test.dl:${base}.2`]),
      run('b', [`test.dl:${base}.2`, `test.dl:${base}.1`]),
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.receipt !== null)).toBe(true);
  });
});
