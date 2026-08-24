/**
 * 停机编排（v1 §1.6 语义；收口顺序归 runtime createShutdown 契约）：
 * healthServer.close → otel flush → closeables（scheduler 停收+宽限 →
 * wakeup 释放 LISTEN 连接 → abandonOwnedClaims 归还本副本 processing 认领）
 * → db 收口 → exit。abandon 在 db 收口之前是账务关键步（不等 60s 租约自然
 * 到期，本副本认领立即归还 retry_wait——v1 同款）。
 */
import { createShutdown } from '@tillgate/runtime';

export interface WorkerShutdownDeps {
  /** createShutdown 只依赖该形状（健康端点关闭时传立即回调占位） */
  healthServer: { close(callback: () => void): void };
  otel: { shutdown(): Promise<void> };
  closeDb: () => Promise<void>;
  scheduler: { stop(): Promise<void> };
  wakeup: { close(): Promise<void> } | null;
  abandonOwnedClaims: () => Promise<number>;
  graceMs: number;
  /** pino 形状（info/error 双参）；注入以统一日志面 */
  logger?: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
  /** 退出函数（测试注入；缺省 process.exit） */
  exit?: (code: number) => never;
}

export function createWorkerShutdown(deps: WorkerShutdownDeps) {
  return createShutdown({
    serviceName: 'worker',
    server: deps.healthServer,
    otel: deps.otel,
    redis: null,
    db: { end: () => deps.closeDb() },
    graceMs: deps.graceMs,
    // 顺序即语义：先停调度（在途宽限）→ 再释放监听 → 最后归还认领（db 之前）
    closeables: [
      { close: () => deps.scheduler.stop() },
      ...(deps.wakeup != null ? [{ close: () => deps.wakeup!.close() }] : []),
      {
        close: async () => {
          const released = await deps.abandonOwnedClaims();
          deps.logger?.info({ released }, 'abandoned owned settlement claims');
        },
      },
    ],
    ...(deps.logger != null
      ? {
          log: {
            info: (message: string) => deps.logger!.info(message),
            error: (message: string) => deps.logger!.error(message),
          },
        }
      : {}),
    ...(deps.exit != null ? { exit: deps.exit } : {}),
  });
}
