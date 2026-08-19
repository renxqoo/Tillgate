/**
 * 优雅停机（可测编排件）：SIGTERM/SIGINT → 停收新请求（server.close）→
 * 在途宽限 → OTel flush → Redis/DB 连接收口 → 正常退出；宽限耗尽强退。
 * 与 client-api-v2 同语义（管理面无长流，宽限通常瞬过）。
 */
export interface ShutdownDeps {
  server: { close(callback: () => void): void };
  otel: { shutdown(): Promise<void> };
  redis: { quit(): Promise<unknown> } | null;
  db: { $client: { end(): Promise<unknown> } };
  /** 宽限上界 ms */
  graceMs: number;
  /** 退出函数（测试注入）；正常路径 0 / 强退 1 */
  exit?: (code: number) => never;
}

export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let triggered = false;
  return (signal: string) => {
    if (triggered) return; // 二次信号不重复触发（收口路径只走一遍）
    triggered = true;
    console.log(`[admin-api-v2] ${signal} received, draining`);
    deps.server.close(() => {
      void (async () => {
        await deps.otel.shutdown().catch(() => {});
        await deps.redis?.quit().catch(() => {});
        await deps.db.$client.end().catch(() => {});
        console.log('[admin-api-v2] drained');
        exit(0);
      })();
    });
    setTimeout(() => {
      console.error('[admin-api-v2] drain grace expired, forcing exit');
      exit(1);
    }, Math.max(1_000, deps.graceMs)).unref();
  };
}
