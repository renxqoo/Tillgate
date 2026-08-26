/**
 * Bun 原生 HTTP 服务适配（bun-native 形态单一真相）：
 * hono app → Bun.serve（fetch 协议原生,不经 node:http 兼容层）;
 * env.server 注入 hono 上下文（trusted-client-ip 的 socket 取址依赖它）;
 * close(callback) 对齐 runtime 停机契约——stop(false) 停收新连接、等在途
 * 自然收口,宽限兜底仍归 runtime 的强退计时器。
 */

/** runtime.createShutdown 的最小 server 面（node:http Server 形） */
export interface AppServer {
  close(callback: () => void): void;
}

export interface ServeAppOptions {
  readonly port: number;
  /** 缺省全接口（Bun.serve 缺省 0.0.0.0） */
  readonly hostname?: string;
}

export function serveApp(
  app: { fetch: (request: Request, env: unknown) => Response | Promise<Response> },
  opts: ServeAppOptions,
  onListening?: (info: { port: number }) => void,
): AppServer {
  const server = Bun.serve({
    port: opts.port,
    ...(opts.hostname != null ? { hostname: opts.hostname } : {}),
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
