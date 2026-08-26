/**
 * 唤醒消费端规格（bun-native sql.listen 形态）：通知 payload 解析
 * （UUID → 定向 onWake(requestId)；缺失/非 UUID → onWake(null) sweep 兜底）、
 * 假订阅通知触发、启动失败退避重试、close 竞态不泄漏。
 */
import { describe, expect, it, vi } from 'vitest';
import { createSettleWakeListener, type WakeSubscription } from '../src/wakeup/postgres-notify';

/** 假 listen 工厂：记录订阅、可手动注入通知 */
function fakeListen() {
  const subscriptions: Array<{
    channel: string;
    emit(payload: string): void;
    unlisten: ReturnType<typeof vi.fn>;
  }> = [];
  const listen = vi.fn(
    (channel: string, onMessage: (payload: string) => void) => {
      const sub = {
        channel,
        emit: onMessage,
        unlisten: vi.fn(async () => {}),
      };
      subscriptions.push(sub);
      return Promise.resolve(sub as unknown as WakeSubscription);
    },
  );
  return { listen, subscriptions };
}

const QUIET = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
const UUID = '0b9f6c2e-8d1a-4c3b-9e2f-1a2b3c4d5e6f';

describe('sql.listen 消费端（BullMQ 入队形态）', () => {
  it('启动即订阅指定通道；payload=requestId → onWake(requestId) 定向入队', async () => {
    const fake = fakeListen();
    const wakes: Array<string | null> = [];
    const listener = createSettleWakeListener({
      listen: fake.listen,
      channel: 'settle-wake',
      onWake: async (requestId) => {
        wakes.push(requestId);
      },
      logger: { warn: () => {}, error: () => {} },
    });
    await QUIET(5);
    expect(fake.listen).toHaveBeenCalledWith('settle-wake', expect.any(Function));
    fake.subscriptions[0]?.emit(UUID);
    await QUIET(10);
    expect(wakes).toEqual([UUID]);
    await listener.close();
    expect(fake.subscriptions[0]?.unlisten).toHaveBeenCalled();
  });

  it('payload 缺失 → onWake(null)（sweep 兜底）；非 UUID 垃圾 → 同样兜底 + warn', async () => {
    const fake = fakeListen();
    const wakes: Array<string | null> = [];
    const warns: unknown[] = [];
    const listener = createSettleWakeListener({
      listen: fake.listen,
      channel: 'settle-wake',
      onWake: async (requestId) => {
        wakes.push(requestId);
      },
      logger: {
        warn: () => void warns.push(1),
        error: () => {},
      },
    });
    await QUIET(5);
    fake.subscriptions[0]?.emit(''); // 空 payload（网关旧形态/纯门铃）
    fake.subscriptions[0]?.emit('not-a-uuid');
    await QUIET(10);
    expect(wakes).toEqual([null, null]);
    expect(warns).toHaveLength(1); // 非 UUID 垃圾才 warn；空 payload 是合法旧形态
    await listener.close();
  });

  it('onWake 抛错（入队失败）→ error 日志，不影响后续通知', async () => {
    const fake = fakeListen();
    const errors: unknown[] = [];
    let calls = 0;
    const listener = createSettleWakeListener({
      listen: fake.listen,
      channel: 'settle-wake',
      onWake: async () => {
        calls += 1;
        if (calls === 1) throw new Error('redis down');
      },
      logger: {
        warn: () => {},
        error: () => void errors.push(1),
      },
    });
    await QUIET(5);
    fake.subscriptions[0]?.emit(UUID);
    fake.subscriptions[0]?.emit('0b9f6c2e-8d1a-4c3b-9e2f-1a2b3c4d5e70');
    await QUIET(10);
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
    await listener.close();
  });

  it('listen 启动失败 → 指数退避重试，成功后正常收通知', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeListen();
      let attempts = 0;
      const listener = createSettleWakeListener({
        listen: (channel, onMessage) => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error('pool down'))
            : fake.listen(channel, onMessage);
        },
        channel: 'settle-wake',
        onWake: async () => {},
        logger: { warn: () => {}, error: () => {} },
        backoff: { baseMs: 1_000, maxMs: 30_000 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000); // 首次退避 1s 后重试成功
      expect(attempts).toBe(2);
      expect(fake.subscriptions).toHaveLength(1);
      await listener.close();
      expect(fake.subscriptions[0]?.unlisten).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('close 后不再重试', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const listener = createSettleWakeListener({
        listen: () => {
          attempts += 1;
          return Promise.reject(new Error('pool down'));
        },
        channel: 'settle-wake',
        onWake: async () => {},
        logger: { warn: () => {}, error: () => {} },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      await listener.close();
      const frozen = attempts;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(frozen); // close 后重试调度终止
    } finally {
      vi.useRealTimers();
    }
  });

  it('close 时订阅在途：晚到的订阅被立即拆除（不泄漏监听连接）', async () => {
    let resolveListen!: (sub: WakeSubscription) => void;
    const pending = new Promise<WakeSubscription>((resolve) => {
      resolveListen = resolve;
    });
    const fake = fakeListen();
    const listener = createSettleWakeListener({
      listen: () => pending,
      channel: 'settle-wake',
      onWake: async () => {},
      logger: { warn: () => {}, error: () => {} },
    });
    await listener.close();
    // 晚到的订阅：close 已置位，start 收到后立即 unlisten
    fake.listen('settle-wake', () => {});
    resolveListen(fake.subscriptions[0] as unknown as WakeSubscription);
    await QUIET(5);
    expect(fake.subscriptions[0]?.unlisten).toHaveBeenCalled();
  });
});
