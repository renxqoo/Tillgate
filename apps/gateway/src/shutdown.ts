/**
 * 停机编排（v1 shutdown.ts 迁移；收口顺序归 runtime createShutdown 契约）：
 * gateway 形状绑定——closeables = inference 退订（ai 事件总线）+ settle-wake。
 * 目标树 §3 指定独立文件（trace-receiver 无此件因其零 closeables）。
 */
import type { ServerType } from '@hono/node-server';
import type { Redis } from 'ioredis';
import { createShutdown } from '@tokenlens/runtime';

export interface GatewayShutdownDeps {
  server: ServerType;
  otel: { shutdown(): Promise<void> };
  redis: Redis;
  closeDb: () => Promise<void>;
  inference: { close(): void };
  settleWake: { close(): Promise<void> };
  graceMs: number;
  /** 退出函数注入（测试）；生产缺省走 runtime 的 process.exit */
  exit?: (code: number) => never;
  logger?: { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
}

export function createGatewayShutdown(deps: GatewayShutdownDeps) {
  return createShutdown({
    serviceName: 'gateway',
    server: deps.server,
    otel: deps.otel,
    redis: deps.redis,
    db: { end: () => deps.closeDb() },
    graceMs: deps.graceMs,
    // inference 退订先行（停接线再停存储）；settle-wake 无长连接（形状对齐）
    closeables: [
      { close: async () => deps.inference.close() },
      { close: () => deps.settleWake.close() },
    ],
    ...(deps.exit != null ? { exit: deps.exit } : {}),
    ...(deps.logger != null
      ? {
          log: {
            info: (msg: string) => deps.logger!.info({}, msg),
            error: (msg: string) => deps.logger!.error({}, msg),
          },
        }
      : {}),
  });
}
