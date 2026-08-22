/**
 * 优雅停机单测：drain 路径（close 回调 → OTel/closeables/Redis/DB 收口 → exit 0）、
 * 宽限耗尽强退（exit 1）、二次信号幂等、收口件失败不阻断、日志注入面。
 */
import { describe, expect, it, vi } from 'vitest';
import { createShutdown, type ShutdownDeps } from '../../src/lifecycle/shutdown';

function fakeDeps(behavior: { closeCallsCallback: boolean; failOtel?: boolean }) {
  const order: string[] = [];
  const logs: string[] = [];
  // 只记录不抛（真 process.exit 永不返回；抛错会制造未处理拒绝）
  const exit = (code: number) => {
    order.push(`exit:${code}`);
  };
  const deps: ShutdownDeps = {
    serviceName: 'test-svc',
    server: {
      close(cb: () => void) {
        order.push('close');
        if (behavior.closeCallsCallback) cb();
      },
    },
    otel: {
      shutdown: async () => {
        order.push('otel');
        if (behavior.failOtel) throw new Error('flush failed');
      },
    },
    redis: { quit: async () => void order.push('redis') },
    db: { end: async () => void order.push('db') },
    graceMs: 100,
    closeables: [
      { close: async () => void order.push('closeable:1') },
      { close: async () => void order.push('closeable:2') },
    ],
    exit: exit as unknown as (code: number) => never,
    log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
  };
  return { deps, order, logs };
}

describe('createShutdown', () => {
  it('drain 路径：close → OTel → closeables（序）→ Redis → DB → exit(0)', async () => {
    const { deps, order } = fakeDeps({ closeCallsCallback: true });
    createShutdown(deps)('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['close', 'otel', 'closeable:1', 'closeable:2', 'redis', 'db', 'exit:0']);
  });

  it('宽限耗尽：在途未完成（close 回调不触发）→ exit(1)', async () => {
    const { deps, order } = fakeDeps({ closeCallsCallback: false });
    createShutdown(deps)('SIGINT');
    await new Promise((r) => setTimeout(r, 1_200));
    expect(order).toEqual(['close', 'exit:1']);
  });

  it('二次信号不重复触发收口', async () => {
    const { deps, order } = fakeDeps({ closeCallsCallback: true });
    const shutdown = createShutdown(deps);
    shutdown('SIGTERM');
    shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(order.filter((s) => s.startsWith('exit'))).toEqual(['exit:0']);
  });

  it('收口件失败不阻断停机（otel 抛错仍走到 exit(0)）', async () => {
    const { deps, order } = fakeDeps({ closeCallsCallback: true, failOtel: true });
    createShutdown(deps)('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['close', 'otel', 'closeable:1', 'closeable:2', 'redis', 'db', 'exit:0']);
  });

  it('日志走注入出口且带服务名', async () => {
    const { deps, logs } = fakeDeps({ closeCallsCallback: true });
    createShutdown(deps)('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(logs).toContain('[test-svc] SIGTERM received, draining');
    expect(logs).toContain('[test-svc] drained');
  });

  it('宽限强退走 error 级日志', async () => {
    const { deps, logs } = fakeDeps({ closeCallsCallback: false });
    createShutdown(deps)('SIGTERM');
    await new Promise((r) => setTimeout(r, 1_200));
    expect(logs).toContain('[test-svc] drain grace expired, forcing exit');
  });

  it('缺省出口：不注入 exit/log 时回落 process.exit / console（B2 同理的注入面缺省分支）', async () => {
    const { deps } = fakeDeps({ closeCallsCallback: true });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as (code?: number | string | null) => never);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      createShutdown({ ...deps, exit: undefined, log: undefined })('SIGTERM');
      await new Promise((r) => setTimeout(r, 10));
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(infoSpy.mock.calls.flat().join('\n')).toContain('[test-svc] drained');
    } finally {
      exitSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
