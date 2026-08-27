/**
 * 停机编排规格（runtime createShutdown 的 worker 形状绑定）：
 * server.close → otel → closeables（scheduler → wakeup → abandon）→ db → exit(0)。
 */
import { describe, expect, it } from 'vitest';
import { createWorkerShutdown } from '../src/shutdown';

/** 注入形态：记录退出码后永久挂起（exit 语义 = 不再返回） */
const hangingExit =
  (record: { code: number | null }): ((code: number) => never) =>
  (code: number) => {
    record.code = code;
    return new Promise(() => {}) as never;
  };

describe('createWorkerShutdown', () => {
  it('收口顺序：server → otel → scheduler → settleQueue → wakeup → abandon → db → exit(0)', async () => {
    const events: string[] = [];
    const exitRecord = { code: null as number | null };
    const shutdown = createWorkerShutdown({
      healthServer: {
        close(callback) {
          events.push('server');
          callback();
        },
      },
      otel: {
        async shutdown() {
          events.push('otel');
        },
      },
      settleQueue: {
        async close() {
          events.push('settleQueue');
        },
      },
      closeDb: async () => {
        events.push('db');
      },
      scheduler: {
        async stop() {
          events.push('scheduler');
        },
      },
      wakeup: {
        async close() {
          events.push('wakeup');
        },
      },
      abandonOwnedClaims: async () => {
        events.push('abandon');
        return 3;
      },
      graceMs: 1_000,
      logger: {
        info: () => {},
        error: () => {},
      },
      exit: hangingExit(exitRecord),
    });
    shutdown('SIGTERM');
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(events).toEqual([
      'server',
      'otel',
      'scheduler',
      'settleQueue',
      'wakeup',
      'abandon',
      'db',
    ]);
    expect(exitRecord.code).toBe(0);
  });

  it('wakeup=null（唤醒关闭形态）：closeables 跳过监听收口', async () => {
    const events: string[] = [];
    const shutdown = createWorkerShutdown({
      healthServer: {
        close(callback) {
          callback();
        },
      },
      otel: { async shutdown() {} },
      settleQueue: { async close() {} },
      closeDb: async () => {
        events.push('db');
      },
      scheduler: {
        async stop() {
          events.push('scheduler');
        },
      },
      wakeup: null,
      abandonOwnedClaims: async () => 0,
      graceMs: 1_000,
      exit: hangingExit({ code: null }),
    });
    shutdown('SIGINT');
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(events).toEqual(['scheduler', 'db']);
  });
});
