/**
 * 优雅停机（可测编排件）：SIGTERM/SIGINT → 停收新请求（server.close）→
 * 在途宽限 → OTel flush → Redis/DB 连接收口 → 正常退出；宽限耗尽强退
 * （K8s 随后 SIGKILL——在途长流由客户端重试，账务由租约恢复链兜底）。
 */
export interface ShutdownDeps {
  server: { close(callback: () => void): void };
  otel: { shutdown(): Promise<void> };
  redis: { quit(): Promise<unknown> } | null;
  db: { $client: { end(): Promise<unknown> } };
  /** 宽限上界 ms */
  graceMs: number;
  /** 附加收口件（结算唤醒监听连接等；失败不阻断停机） */
  closeables?: Array<{ close(): Promise<void> }>;
  /** 退出函数（测试注入）；正常路径 0 / 强退 1 */
  exit?: (code: number) => never;
  now?: () => number;
}

export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let triggered = false;
  return (signal: string) => {
    if (triggered) return; // 二次信号不重复触发（收口路径只走一遍）
    triggered = true;
    console.log(`[gateway] ${signal} received, draining`);
    deps.server.close(() => {
      void (async () => {
        await deps.otel.shutdown().catch(() => {});
        for (const c of deps.closeables ?? []) await c.close().catch(() => undefined);
      await deps.redis?.quit().catch(() => {});
        await deps.db.$client.end().catch(() => {});
        console.log('[gateway] drained');
        exit(0);
      })();
    });
    setTimeout(() => {
      console.error('[gateway] drain grace expired, forcing exit');
      exit(1);
    }, Math.max(1_000, deps.graceMs)).unref();
  };
}
