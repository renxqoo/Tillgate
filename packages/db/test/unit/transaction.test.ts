/**
 * 事务壳(IMPLEMENTATION.md §4):瞬态重试、退避节奏、钩子吞错、耗尽语义。
 * 行为等价锚点:注入 v1 等价策略 { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 }
 * 时,重试触发/上限/退避公式与 v1 三份拷贝逐字一致(D1)。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Db } from '../../src/client.js';
import { runTx } from '../../src/transaction.js';

/** v1 行为等价策略 */
const V1_POLICY = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 } as const;

/** 模拟 pg 瞬态错误(drizzle 包装形态:code 在 cause 里) */
const deadlock = () =>
  new Error('drizzle-wrap', { cause: Object.assign(new Error('deadlock'), { code: '40P01' }) });
const serialization = () =>
  new Error('drizzle-wrap', { cause: Object.assign(new Error('serialize'), { code: '40001' }) });

/** 假 Db:transaction 忠实执行回调(失败由回调内注入,模拟 fn 抛错 → 事务拒绝) */
function fakeDb() {
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
  return { db: { transaction } as unknown as Db, transaction };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runTx 重试语义', () => {
  it('首试成功直通,不重试不退避', async () => {
    const { db, transaction } = fakeDb();
    await expect(runTx(db, async () => 'ok', V1_POLICY)).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('瞬态失败一次后重试成功(40001),onRetry 收到 {attempt, code}', async () => {
    const { db, transaction } = fakeDb();
    const onRetry = vi.fn();
    let attempt = 0;
    const result = await runTx(
      db,
      async () => {
        attempt += 1;
        if (attempt === 1) throw serialization();
        return 'recovered';
      },
      V1_POLICY,
      { onRetry },
    );
    expect(result).toBe('recovered');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, code: '40001' });
  });

  it('非瞬态错误一次抛出(不重试)', async () => {
    const { db, transaction } = fakeDb();
    const onRetry = vi.fn();
    await expect(
      runTx(
        db,
        async () => {
          throw new Error('not transient');
        },
        V1_POLICY,
        { onRetry },
      ),
    ).rejects.toThrow('not transient');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('瞬态错误耗尽 maxAttempts 后抛最后一次错误', async () => {
    const { db, transaction } = fakeDb();
    const onRetry = vi.fn();
    await expect(
      runTx(db, async () => { throw deadlock(); }, { maxAttempts: 3, baseDelayMs: 1, maxJitterMs: 1 }, { onRetry }),
    ).rejects.toThrow('drizzle-wrap'); // 抛出的是 db.transaction 拒绝的原错误(外层包装)
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2); // 第 1、2 次失败后各通知一次;第 3 次直接抛
  });

  it('onRetry 抛错被吞,重试继续(观测不参与资金决策)', async () => {
    const { db } = fakeDb();
    const onRetry = vi.fn(() => {
      throw new Error('telemetry down');
    });
    let attempt = 0;
    await expect(
      runTx(
        db,
        async () => {
          attempt += 1;
          if (attempt === 1) throw deadlock();
          return 'ok';
        },
        V1_POLICY,
        { onRetry },
      ),
    ).resolves.toBe('ok');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('runTx 退避节奏(v1 公式:base·2^attempt + jitter)', () => {
  it('抖动固定 0.5 时重试在累计 25 / 65 / 135ms 触发(每次重试后重排 15·2^n+10)', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter = floor(0.5·20) = 10
    const { db, transaction } = fakeDb();
    let attempt = 0;
    const pending = runTx(
      db,
      async () => {
        attempt += 1;
        if (attempt <= 3) throw deadlock();
        return 'done';
      },
      V1_POLICY,
    );

    await vi.advanceTimersByTimeAsync(24);
    expect(transaction).toHaveBeenCalledTimes(1); // 0+25 未到
    await vi.advanceTimersByTimeAsync(1); // t=25:第 1 次重试(15·1+10)
    expect(transaction).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(39);
    expect(transaction).toHaveBeenCalledTimes(2); // 25+40=65 未到
    await vi.advanceTimersByTimeAsync(1); // t=65:第 2 次重试(15·2+10)
    expect(transaction).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(69);
    expect(transaction).toHaveBeenCalledTimes(3); // 65+70=135 未到
    await vi.advanceTimersByTimeAsync(1); // t=135:第 3 次重试(15·4+10)
    expect(transaction).toHaveBeenCalledTimes(4);

    await expect(pending).resolves.toBe('done');
  });
});
