/**
 * 优雅停机编排件（可测、无全局状态——信号注册留在 app 的进程入口）：
 * SIGTERM/SIGINT → 停收新请求（server.close）→ 在途宽限 → 观测 flush →
 * 附加收口件 → Redis/DB 连接收口 → 正常退出；宽限耗尽强退
 * （K8s 随后 SIGKILL——在途长流由客户端重试，账务由租约恢复链兜底）。
 *
 * gateway 全集形态（closeables）+ serviceName 参数化；收口顺序固定：otel → closeables → redis → db。
 */

export interface ShutdownLog {
  info(message: string): void;
  error(message: string): void;
}

export interface ShutdownDeps {
  /** 日志前缀（服务名） */
  serviceName: string;
  server: { close(callback: () => void): void };
  /** 观测收口（OTel flush 等）——最先关，之后的收口日志不再进 trace */
  otel: { shutdown(): Promise<void> };
  redis: { quit(): Promise<unknown> } | null;
  /** DB 连接收口（pg 原生 client.end 形状；drizzle 经 $client.end 适配） */
  db: { end(): Promise<unknown> };
  /** 宽限上界 ms（<1000 按 1000 生效——强退定时器正确性的下界，防御而非 fail-fast） */
  graceMs: number;
  /** 附加收口件（结算唤醒监听连接等；失败不阻断停机） */
  closeables?: Array<{ close(): Promise<void> }>;
  /**
   * 宽限耗尽时的在途请求预算中止（drain 语义）：abort 携带服务端 drain 标记
   * （消费方以 ServerDrainAbort 类 reason 驱动 server_draining 终态分类与全额
   * 释放），abort 后留 finalizeMs 收尾窗（信号结算/释放）再强退。
   */
  drain?: {
    abort(): void;
    /** 收尾窗 ms（<1000 按 1000 生效；缺省 5000） */
    finalizeMs?: number;
  };
  /** 退出函数（测试注入）；正常路径 0 / 强退 1 */
  exit?: (code: number) => never;
  /** 日志出口（缺省 console）；注入以统一日志面 */
  log?: ShutdownLog;
}

export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? console;
  let triggered = false;
  return (signal: string) => {
    if (triggered) return; // 二次信号不重复触发（收口路径只走一遍；强退兜底是 K8s SIGKILL）
    triggered = true;
    log.info(`[${deps.serviceName}] ${signal} received, draining`);
    deps.server.close(() => {
      void (async () => {
        await deps.otel.shutdown().catch(() => {});
        for (const c of deps.closeables ?? []) await c.close().catch(() => {});
        await deps.redis?.quit().catch(() => {});
        await deps.db.end().catch(() => {});
        log.info(`[${deps.serviceName}] drained`);
        exit(0);
      })();
    });
    setTimeout(
      () => {
        if (deps.drain != null) {
          // 宽限耗尽：先中止在途请求预算（drain 标记 → 终态分类/释放），留收尾窗再强退
          log.error(`[${deps.serviceName}] drain grace expired, aborting in-flight requests`);
          deps.drain.abort();
          setTimeout(
            () => {
              log.error(`[${deps.serviceName}] drain finalize window expired, forcing exit`);
              exit(1);
            },
            Math.max(1_000, deps.drain.finalizeMs ?? 5_000),
          ).unref();
          return;
        }
        log.error(`[${deps.serviceName}] drain grace expired, forcing exit`);
        exit(1);
      },
      Math.max(1_000, deps.graceMs),
    ).unref();
  };
}
