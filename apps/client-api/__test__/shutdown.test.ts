/**
 * shutdown 绑定单测：关停顺序（server → otel → redis → db → exit 0）、
 * 二次信号幂等。语义件归 runtime（其契约测试覆盖宽限强退细节）。
 * exit 以记录型替身注入（真 throw 会经异步链变成未处理拒绝）。
 */
import { describe, expect, it } from 'vitest';
import { createClientShutdown } from '../src/shutdown.js';

function buildHarness() {
  const calls: string[] = [];
  const exitCodes: number[] = [];
  const exit = ((code: number) => {
    exitCodes.push(code);
  }) as (code: number) => never;
  const deps = {
    serviceName: 'client-api-test',
    server: {
      close(cb: () => void) {
        calls.push('server');
        cb();
      },
    },
    otel: {
      shutdown: () => {
        calls.push('otel');
        return Promise.resolve();
      },
    },
    redis: {
      quit: () => {
        calls.push('redis');
        return Promise.resolve();
      },
    },
    db: {
      end: () => {
        calls.push('db');
        return Promise.resolve();
      },
    },
    graceMs: 10_000,
  };
  return { calls, exitCodes, deps, exit };
}

describe('client-api shutdown', () => {
  it('按序收口并 exit(0)', async () => {
    const h = buildHarness();
    const shutdown = createClientShutdown({ ...h.deps, exit: h.exit });
    shutdown('SIGTERM');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(h.calls).toEqual(['server', 'otel', 'redis', 'db']);
    expect(h.exitCodes).toEqual([0]);
  });

  it('二次信号不重复触发', async () => {
    const h = buildHarness();
    const shutdown = createClientShutdown({ ...h.deps, exit: h.exit });
    shutdown('SIGTERM');
    shutdown('SIGINT');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(h.exitCodes).toEqual([0]);
    expect(h.calls.filter((c) => c === 'server')).toHaveLength(1);
  });

  it('宽限耗尽透传 drain 钩子（db-budget-signals：预算门排队的停机出局接线）', async () => {
    const h = buildHarness();
    const order: string[] = [];
    const shutdown = createClientShutdown({
      ...h.deps,
      graceMs: 100, // 下界钳到 1s——宽限耗尽走 drain 路径
      drain: {
        abort: () => {
          order.push('drain-abort');
        },
      },
      exit: h.exit,
    });
    shutdown('SIGTERM');
    await new Promise((r) => {
      setTimeout(r, 1_150);
    });
    // drain abort 在宽限耗尽时触发（自然收口已先行 exit(0);此处只锁停机侧接线）
    expect(order).toEqual(['drain-abort']);
  });
});
