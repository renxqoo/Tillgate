/** runTx 事务重试壳单元：瞬态死锁自动重试、非瞬态直抛、耗尽后上抛 */
import { describe, expect, it, vi } from 'vitest';
import { runTx } from '../internal';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

const deadlock = (msg = 'deadlock detected'): Error =>
  Object.assign(new Error(msg), { code: '40P01' });

const serialization = (): Error =>
  Object.assign(new Error('could not serialize'), { code: '40001' });

/** 包装一层 cause 模拟 drizzle 的错误链 */
const wrapped = (inner: Error): Error => {
  const outer = new Error('Failed query') as Error & { cause?: unknown };
  outer.cause = inner;
  return outer;
};

function fakeDb(calls: unknown[]): NodePgDatabase {
  let i = 0;
  return {
    transaction: vi.fn(async (fn: (tx: never) => Promise<unknown>) => {
      const behavior = calls[i];
      i += 1;
      if (behavior instanceof Error) throw behavior;
      return fn(behavior as never);
    }),
  } as unknown as NodePgDatabase;
}

describe('runTx 瞬态重试壳', () => {
  it('死锁两次后成功：共调用 3 次，返回业务结果', async () => {
    const tx = { marker: 'tx' };
    const db = fakeDb([deadlock(), wrapped(deadlock()), tx]);
    const result = await runTx(
      db,
      async (t) => `done:${(t as unknown as { marker: string }).marker}`,
    );
    expect(result).toBe('done:tx');
    expect(db.transaction).toHaveBeenCalledTimes(3);
  });

  it('每次瞬态重试都发出可观测事件，且观测器异常不影响资金事务', async () => {
    const db = fakeDb([deadlock(), wrapped(deadlock()), 'ok']);
    const retries: Array<{ operation: string; attempt: number; code: string }> = [];
    const result = await runTx(
      db,
      async () => 'done',
      {
        onTransactionRetry(event) {
          retries.push(event);
          if (event.attempt === 1) throw new Error('telemetry backend down');
        },
      },
      'credit',
    );
    expect(result).toBe('done');
    expect(retries).toEqual([
      { operation: 'credit', attempt: 1, code: '40P01' },
      { operation: 'credit', attempt: 2, code: '40P01' },
    ]);
  });

  it('串行化失败（40001）同样重试；drizzle cause 包装可穿透', async () => {
    const db = fakeDb([wrapped(serialization()), 'ok']);
    await expect(runTx(db, async () => 'ok')).resolves.toBe('ok');
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it('非瞬态错误直抛不重试', async () => {
    const db = fakeDb([new Error('insufficient')]);
    await expect(runTx(db, async () => 'x')).rejects.toThrow('insufficient');
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('连续死锁 5 次耗尽后上抛最后一个错误', async () => {
    const db = fakeDb([deadlock(), deadlock(), deadlock(), deadlock(), deadlock()]);
    await expect(runTx(db, async () => 'x')).rejects.toThrow('deadlock');
    expect(db.transaction).toHaveBeenCalledTimes(5);
  });
});
