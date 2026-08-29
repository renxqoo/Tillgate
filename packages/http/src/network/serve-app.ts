/**
 * Bun 原生 HTTP 服务适配（bun-native 形态单一真相）：
 * hono app → Bun.serve（fetch 协议原生,不经 node:http 兼容层）;
 * env.server 注入 hono 上下文（trusted-client-ip 的 socket 取址依赖它）;
 * close(callback) 对齐 runtime 停机契约——stop(false) 停收新连接、等在途
 * 自然收口,宽限兜底仍归 runtime 的强退计时器。
 * idleTimeout 显式默认 60s:Bun 缺省 10s 会切断「handler 等慢上游期间未写
 * 响应」的连接与「流式响应字节间隔超 10s」的连接——反代侧表现为 502/流截断
 * （OAuth 回调等 GitHub 上游即真实案例）。
 */

/** runtime.createShutdown 的最小 server 面（node:http Server 形） */
export interface AppServer {
  close(callback: () => void): void;
}

export interface ServeAppOptions {
  readonly port: number;
  /** 缺省全接口（Bun.serve 缺省 0.0.0.0） */
  readonly hostname?: string;
  /**
   * 空闲连接切断秒数（Bun 平台上限 255;缺省 60）。
   * 该计时在「无任何字节往来」时递减——响应首字节前的慢 handler 与流式
   * 长间隔都会触发;流式应用（gateway）应显式调到接近反代读超时。
   */
  readonly idleTimeoutSeconds?: number;
}

/** Bun idleTimeout 平台上限（Bun.serve 对超值直接抛错,这里前置成契约信息） */
const IDLE_TIMEOUT_MAX_SECONDS = 255;
const IDLE_TIMEOUT_DEFAULT_SECONDS = 60;

export function serveApp(
  app: { fetch: (request: Request, env: unknown) => Response | Promise<Response> },
  opts: ServeAppOptions,
  onListening?: (info: { port: number }) => void,
): AppServer {
  if (
    opts.idleTimeoutSeconds != null &&
    (!Number.isInteger(opts.idleTimeoutSeconds) ||
      opts.idleTimeoutSeconds < 1 ||
      opts.idleTimeoutSeconds > IDLE_TIMEOUT_MAX_SECONDS)
  ) {
    throw new Error(
      `idleTimeoutSeconds must be an integer in [1, ${IDLE_TIMEOUT_MAX_SECONDS}] (Bun platform cap)`,
    );
  }
  const server = Bun.serve({
    port: opts.port,
    ...(opts.hostname != null ? { hostname: opts.hostname } : {}),
    idleTimeout: opts.idleTimeoutSeconds ?? IDLE_TIMEOUT_DEFAULT_SECONDS,
    fetch: (request, bunServer) => app.fetch(request, { server: bunServer }),
  });
  // server.port 在 port=0(随机端口)时由系统分配后回填——实际监听值回传调用方
  const actualPort = server.port;
  onListening?.({ port: actualPort ?? opts.port });
  return {
    close(callback) {
      // 双路都收口回调(成功/失败不区分——宽限强退兜底在 runtime 侧)
      void server.stop(false).finally(callback);
    },
  };
}
