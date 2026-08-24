/**
 * 优雅停机绑定：SIGTERM/SIGINT → 停收新请求 → 在途宽限 → OTel flush →
 * Redis/DB 连接收口 → 正常退出；宽限耗尽强退。语义件归 runtime.createShutdown
 * （二次信号幂等、unref 计时器）——本文件只做 app 侧类型收窄。
 */
import { createShutdown, type Logger } from '@tillgate/runtime';

export interface ClientShutdownDeps {
  readonly serviceName: string;
  /** @hono/node-server 的 ServerType（http1/http2 并集）——最小 close 面 */
  readonly server: { close(callback: () => void): void };
  readonly otel: { shutdown(): Promise<void> };
  readonly redis: { quit(): Promise<unknown> };
  readonly db: { end(): Promise<unknown> };
  readonly graceMs: number;
  readonly logger?: Logger;
  /** 退出函数（测试注入）；正常路径 0 / 强退 1 */
  readonly exit?: (code: number) => never;
}

export function createClientShutdown(deps: ClientShutdownDeps): (signal: string) => void {
  return createShutdown({
    serviceName: deps.serviceName,
    server: deps.server,
    otel: deps.otel,
    redis: deps.redis,
    db: deps.db,
    graceMs: deps.graceMs,
    ...(deps.logger != null ? { log: deps.logger } : {}),
    ...(deps.exit != null ? { exit: deps.exit } : {}),
  });
}
