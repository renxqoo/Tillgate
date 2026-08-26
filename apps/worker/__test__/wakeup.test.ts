/**
 * 唤醒消费端规格（2026-08-26 BullMQ 增量改写）：通知 payload 解析
 * （UUID → 定向 onWake(requestId)；缺失/非 UUID → onWake(null) sweep 兜底）、
 * LISTEN 假连接通知触发、断线重连退避。
 */
import { describe, expect, it, vi } from 'vitest';
import { createSettleWakeListener, type ListenConnection } from '../src/wakeup/postgres-notify';

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
    notify(channel: string, payload = ''): void {
      for (const listener of listeners.notification) listener({ channel, payload });
    },
    emitError(error: Error): void {
      for (const listener of listeners.error) listener(error);
    },
  };
}

const QUIET = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('PG LISTEN 消费端（BullMQ 入队形态）', () => {
  it('启动即 LISTEN 指定通道；payload=requestId → onWake(requestId) 定向入队', async () => {
    const fake = fakeConnection();
    const wakes: Array<string | null> = [];
    const listener = createSettleWakeListener({
      connect: async () => fake.connection,
      channel: 'settle-wake',
      onWake: async (requestId) => {
        wakes.push(requestId);
      },
      logger: { warn: () => {}, error: () => {} },
    });
    await QUIET(5);
    expect(fake.queries).toEqual(['LISTEN "settle-wake"']);
    fake.notify('settle-wake', '0b9f6c2e-8d1a-4c3b-9e2f-1a2b3c4d5e6f');
    await QUIET(10);
    expect(wakes).toEqual(['0b9f6c2e-8d1a-4c3b-9e2f-1a2b3c4d5e6f']);
    // 其他通道的通知不触发
    fake.notify('other-channel', '0b9f6c2e-8d1a-4c3b-9e2f-1a2b3c4d5e6f');
    await QUIET(5);
    expect(wakes).toHaveLength(1);
    await listener.close();
    expect(fake.connection.release).toHaveBeenCalled();
  });

  it('payload 缺失 → onWake(null)（sweep 兜底）；非 UUID 垃圾 → 同样兜底 + warn', async () => {
    const fake = fakeConnection();
    const wakes: Array<string | null> = [];
    const warns: unknown[] = [];
    const listener = createSettleWakeListener({
      connect: async () => fake.connection,
      channel: 'settle-wake',
      onWake: async (requestId) => {
        wakes.push(requestId);
      },
      logger: {
        warn: (_o, _m) => void warns.push(1),
        error: () => {},
      },
    });
    await QUIET(5);
    fake.notify('settle-wake'); // 空 payload（网关旧形态/纯门铃）
    fake.notify('settle-wake', 'not-a-uuid');
    await QUIET(10);
    expect(wakes).toEqual([null, null]);
    expect(warns).toHaveLength(1); // 非 UUID 垃圾才 warn；空 payload 是合法旧形态
    await listener.close();
  });

  it('onWake 抛错（入队失败）→ error 日志，不影响后续通知', async () => {
    const fake = fakeConnection();
    const errors: unknown[] = [];
    let calls = 0;
    const listener = createSettleWakeListener({
      connect: async () => fake.connection,
      channel: 'settle-wake',
      onWake: async () => {
        calls += 1;
        if (calls === 1) throw new Error('redis down');
      },
      logger: {
        warn: () => {},
        error: (_o, _m) => void errors.push(1),
      },
    });
    await QUIET(5);
    fake.notify('settle-wake', '0b9f6c2e-8d1a-4c3b-9e2f-1a2b3c4d5e6f');
    fake.notify('settle-wake', '0b9f6c2e-8d1a-4c3b-9e2f-1a2b3c4d5e70');
    await QUIET(10);
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
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
        onWake: async () => {},
        logger: { warn: () => {}, error: () => {} },
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
});

describe('唤醒消费端：连接故障路径', () => {
  it('初始建连失败 → error 日志 + 重连调度；close 后不再重连', async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      let attempts = 0;
      const listener = createSettleWakeListener({
        connect: async () => {
          attempts += 1;
          throw new Error('pool down');
        },
        channel: 'settle-wake',
        onWake: async () => {},
        logger: {
          warn: () => {},
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
      onWake: async () => {},
      logger: { warn: () => {}, error: () => {} },
    });
    await listener.close();
    resolveConnect(fake.connection);
    await QUIET(5);
    expect(fake.connection.release).toHaveBeenCalled();
  });
});
