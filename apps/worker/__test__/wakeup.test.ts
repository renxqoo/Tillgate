/**
 * 唤醒消费端规格（v1 wakeup.test.ts 的 PG 形态对位）：
 * 合并执行器纯语义（3 次并发唤醒 ≤ 2 次执行）、满批排空（认领计数判定）、
 * LISTEN 假连接通知触发、断线重连退避。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCoalescedRunner,
  createSettleWakeListener,
  type ListenConnection,
} from '../src/wakeup/postgres-notify';

describe('合并执行器（纯语义，v1 平移）', () => {
  it('3 次并发唤醒 ≤ 2 次执行（一轮在跑 + 一轮 pending 补跑）', async () => {
    let runs = 0;
    const coalescedRun = createCoalescedRunner(async () => {
      runs += 1;
      // 模拟批次运行期间的并发唤醒：挂起中再次触发三次
      if (runs === 1) {
        await Promise.all([coalescedRun(), coalescedRun(), coalescedRun()]);
      }
    });
    await coalescedRun();
    expect(runs).toBe(2);
  });

  it('顺序（非并发）唤醒各跑各的', async () => {
    let runs = 0;
    const coalescedRun = createCoalescedRunner(async () => {
      runs += 1;
    });
    await coalescedRun();
    await coalescedRun();
    await coalescedRun();
    expect(runs).toBe(3);
  });
});

/** LISTEN 假连接：notification 手动注入、error 手动触发 */
function fakeConnection() {
  const listeners = {
    notification: new Set<(payload: { channel?: string; payload?: string }) => void>(),
    error: new Set<(error: Error) => void>(),
  };
  const queries: string[] = [];
  const connection: ListenConnection = {
    async query(text) {
      queries.push(text);
    },
    on(event, listener) {
      (listeners as never as Record<string, Set<never>>)[event]?.add(listener as never);
    },
    release: vi.fn(),
  };
  return {
    connection,
    queries,
    notify(channel: string): void {
      for (const listener of listeners.notification) listener({ channel, payload: '' });
    },
    emitError(error: Error): void {
      for (const listener of listeners.error) listener(error);
    },
  };
}

describe('PG LISTEN 消费端', () => {
  it('启动即 LISTEN 指定通道；通知触发 drain（非满批即停）', async () => {
    const fake = fakeConnection();
    const batches: number[] = [];
    const listener = createSettleWakeListener({
      connect: async () => fake.connection,
      channel: 'settle-wake',
      runBatch: async () => {
        const claimed = 3; // 非满批（batchSize=5）——一轮即止
        batches.push(claimed);
        return claimed;
      },
      batchSize: 5,
      logger: { warn: () => undefined, error: () => undefined },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.queries).toEqual(['LISTEN "settle-wake"']);
    fake.notify('settle-wake');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(batches).toEqual([3]);
    // 其他通道的通知不触发
    fake.notify('other-channel');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(batches).toEqual([3]);
    await listener.close();
    expect(fake.connection.release).toHaveBeenCalled();
  });

  it('满批排空：认领满批连跑直到非满批（积压一次抽干）', async () => {
    const fake = fakeConnection();
    const claimCounts = [5, 5, 2];
    let call = 0;
    const listener = createSettleWakeListener({
      connect: async () => fake.connection,
      channel: 'settle-wake',
      runBatch: async () => claimCounts[Math.min(call++, claimCounts.length - 1)]!,
      batchSize: 5,
      logger: { warn: () => undefined, error: () => undefined },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.notify('settle-wake');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(call).toBe(3); // 5(满) → 5(满) → 2(非满，止)
    await listener.close();
  });

  it('连接 error → 指数退避重连并重发 LISTEN', async () => {
    vi.useFakeTimers();
    try {
      const first = fakeConnection();
      const second = fakeConnection();
      let connectCount = 0;
      const listener = createSettleWakeListener({
        connect: async () => {
          connectCount += 1;
          return connectCount === 1 ? first.connection : second.connection;
        },
        channel: 'settle-wake',
        runBatch: async () => 0,
        batchSize: 5,
        logger: { warn: () => undefined, error: () => undefined },
        backoff: { baseMs: 1_000, maxMs: 30_000 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(first.queries).toEqual(['LISTEN "settle-wake"']);
      first.emitError(new Error('connection reset'));
      await vi.advanceTimersByTimeAsync(1_000); // 首次退避 1s
      expect(second.queries).toEqual(['LISTEN "settle-wake"']);
      await listener.close();
      expect(second.connection.release).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('批次运行期间的并发通知折叠为一次补跑（coalescing + drain 组合）', async () => {
    const fake = fakeConnection();
    let runs = 0;
    const listener = createSettleWakeListener({
      connect: async () => fake.connection,
      channel: 'settle-wake',
      runBatch: async () => {
        runs += 1;
        if (runs === 1) {
          // 仅首轮批次运行中敲门铃（自激发会无限递归——真实 NOTIFY 不来自自身批次）
          fake.notify('settle-wake');
          fake.notify('settle-wake');
        }
        return 0; // 非满批
      },
      batchSize: 5,
      logger: { warn: () => undefined, error: () => undefined },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.notify('settle-wake');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(2); // 一轮 + pending 补跑一轮
    await listener.close();
  });
});

describe('唤醒消费端：连接故障路径', () => {
  it('初始建连失败 → error 日志 + 重连调度；close 后不再重连', async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const warns: unknown[] = [];
      let attempts = 0;
      const listener = createSettleWakeListener({
        connect: async () => {
          attempts += 1;
          throw new Error('pool down');
        },
        channel: 'settle-wake',
        runBatch: async () => 0,
        batchSize: 5,
        logger: {
          warn: (_o, _m) => void warns.push(1),
          error: (_o, _m) => void errors.push(1),
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      expect(errors).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000); // 首次退避重连（再失败再排）
      expect(attempts).toBe(2);
      await listener.close();
      const frozen = attempts;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(frozen); // close 后重连调度终止
    } finally {
      vi.useRealTimers();
    }
  });

  it('close 时建连在途：晚到的连接被立即释放（不泄漏）', async () => {
    let resolveConnect!: (connection: ListenConnection) => void;
    const pending = new Promise<ListenConnection>((resolve) => {
      resolveConnect = resolve;
    });
    const fake = fakeConnection();
    const listener = createSettleWakeListener({
      connect: () => pending,
      channel: 'settle-wake',
      runBatch: async () => 0,
      batchSize: 5,
      logger: { warn: () => undefined, error: () => undefined },
    });
    await listener.close();
    resolveConnect(fake.connection);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.connection.release).toHaveBeenCalled();
  });
});
