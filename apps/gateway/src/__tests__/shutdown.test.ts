/**
 * 优雅停机单测：drain 路径（close 回调 → OTel/Redis/DB 收口 → exit 0）与
 * 宽限耗尽强退路径（exit 1）；二次信号幂等。
 */
import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../shutdown.js';

function fakeDeps(behavior: { closeCallsCallback: boolean }) {
  const order: string[] = [];
  // 只记录不抛（真 process.exit 永不返回；抛错会制造未处理拒绝）
  const exit = vi.fn((code: number) => {
    order.push(`exit:${code}`);
  });
  const server = {
    close(cb: () => void) {
      order.push('close');
      if (behavior.closeCallsCallback) cb();
    },
  };
  const deps = {
    server,
    otel: { shutdown: async () => { order.push('otel'); } },
    redis: { quit: async () => { order.push('redis'); } },
    db: { $client: { end: async () => { order.push('db'); } } },
    graceMs: 100,
    exit: exit as unknown as (code: number) => never,
  };
  return { deps, order, exit };
}

describe('createShutdown', () => {
  it('drain 路径：close → OTel → Redis → DB → exit(0)', async () => {
    const { deps, order, exit } = fakeDeps({ closeCallsCallback: true });
    const shutdown = createShutdown(deps);
    shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['close', 'otel', 'redis', 'db', 'exit:0']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('宽限耗尽：在途未完成（close 回调不触发）→ exit(1)', async () => {
    const { deps, exit } = fakeDeps({ closeCallsCallback: false });
    const shutdown = createShutdown(deps);
    shutdown('SIGINT');
    await new Promise((r) => setTimeout(r, 1_200));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('二次信号不重复触发收口', async () => {
    const { deps, exit } = fakeDeps({ closeCallsCallback: true });
    const shutdown = createShutdown(deps);
    shutdown('SIGTERM');
    shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
