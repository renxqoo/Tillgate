import type { Logger } from '@ai-gateway/logger';

/**
 * W-1 修复：Worker 优雅关闭处理器。
 *
 * 提取为独立模块便于测试（mock 依赖注入，不依赖真实 BullMQ/Redis/DB）。
 *
 * 行为：
 *   - 依次关闭 worker → redis → db（每步 catch，失败不阻塞后续）
 *   - 最后调 process.exit(0)（确保进程退出，防 BullMQ 内部 timer 残留）
 *   - 防重复触发（SIGTERM + SIGINT 并发时只执行一次）
 */

export interface ShutdownDeps {
  closeWorker: () => Promise<unknown>;
  quitRedis: () => Promise<unknown>;
  endDb: () => Promise<unknown>;
  exit: (code?: number) => void;
}

export function createShutdownHandler(deps: ShutdownDeps, logger?: Pick<Logger, 'info' | 'warn'>) {
  let shuttingDown = false;
  return async (signal: string): Promise<void> => {
    if (shuttingDown) return; // 防重复触发
    shuttingDown = true;
    logger?.info({ signal }, 'worker shutting down...');
    try { await deps.closeWorker(); } catch (e) { logger?.warn({ err: (e as Error).message }, 'worker close failed'); }
    try { await deps.quitRedis(); } catch (e) { logger?.warn({ err: (e as Error).message }, 'redis quit failed'); }
    try { await deps.endDb(); } catch (e) { logger?.warn({ err: (e as Error).message }, 'db end failed'); }
    deps.exit(0);
  };
}
