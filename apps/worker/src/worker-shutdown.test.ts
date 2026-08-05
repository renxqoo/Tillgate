import { describe, expect, it, vi } from 'vitest';

/**
 * W-1 修复测试：Worker 优雅关闭
 *
 * Bug：
 *   - SIGTERM handler 不调 process.exit → BullMQ 内部 timer 不释放 → 进程不退出
 *   - 无 SIGINT 处理 → dev 环境 Ctrl-C 强杀
 *   - 无 error 事件监听 → Redis 断开时 unhandled error → 进程崩
 *
 * 修复：提取 createShutdownHandler，测试其行为（mock process.exit / close / quit / end）。
 */
import { createShutdownHandler } from './shutdown-handler.js';

describe('W-1: Worker 优雅关闭', () => {
  it('shutdown 依次关闭 worker→redis→db，最后调 process.exit(0)', async () => {
    const order: string[] = [];
    const mocks = {
      closeWorker: vi.fn(async () => { order.push('worker'); }),
      quitRedis: vi.fn(async () => { order.push('redis'); }),
      endDb: vi.fn(async () => { order.push('db'); }),
      exit: vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`); }),
    };
    const shutdown = createShutdownHandler({
      closeWorker: mocks.closeWorker,
      quitRedis: mocks.quitRedis,
      endDb: mocks.endDb,
      exit: mocks.exit,
    });
    await shutdown('SIGTERM');
    expect(order).toEqual(['worker', 'redis', 'db', 'exit:0']);
  });

  it('shutdown 某步失败不阻塞后续（catch 后继续）', async () => {
    const mocks = {
      closeWorker: vi.fn(async () => { throw new Error('worker close failed'); }),
      quitRedis: vi.fn(async () => {}),
      endDb: vi.fn(async () => {}),
      exit: vi.fn(),
    };
    const shutdown = createShutdownHandler(mocks);
    await shutdown('SIGTERM');
    // worker 失败但 redis/db/exit 仍执行
    expect(mocks.quitRedis).toHaveBeenCalled();
    expect(mocks.endDb).toHaveBeenCalled();
    expect(mocks.exit).toHaveBeenCalledWith(0);
  });

  it('shutdown 只执行一次（防重复触发 SIGTERM+SIGINT）', async () => {
    const mocks = {
      closeWorker: vi.fn(async () => {}),
      quitRedis: vi.fn(async () => {}),
      endDb: vi.fn(async () => {}),
      exit: vi.fn(),
    };
    const shutdown = createShutdownHandler(mocks);
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    expect(mocks.exit).toHaveBeenCalledTimes(1);
  });
});
