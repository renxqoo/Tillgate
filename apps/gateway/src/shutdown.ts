/**
 * 停机编排（收口顺序归 runtime createShutdown 契约）：
 * gateway 形状绑定——closeables = inference 退订（ai 事件总线）+ settle-wake。
 * 独立文件（trace-receiver 无此件因其零 closeables）。
 */
import type { AppServer } from '@tillgate/http';
import type { Redis } from 'ioredis';
import { createShutdown } from '@tillgate/runtime';

export interface GatewayShutdownDeps {
  server: AppServer;
  otel: { shutdown(): Promise<void> };
  redis: Redis;
  closeDb: () => Promise<void>;
  inference: { close(): void };
  settleWake: { close(): Promise<void> };
  graceMs: number;
  /** 宽限耗尽时的在途请求预算中止（drain 语义；透传 runtime createShutdown） */
  drain?: { abort(): void; finalizeMs?: number };
  /** 退出函数注入（测试）；生产缺省走 runtime 的 process.exit */
  exit?: (code: number) => never;
  logger?: { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
  /** 路由策略 TTL reader 定时器停止面（装配注入；未注入 = 无定时器） */
  policyReaderStop?: () => void;
}

export function createGatewayShutdown(deps: GatewayShutdownDeps) {
  // 先收窄到局部：条件展开内的闭包不再保持 deps.logger 的属性收窄
  const { logger } = deps;
  return createShutdown({
    serviceName: 'gateway',
    server: deps.server,
    otel: deps.otel,
    redis: deps.redis,
    db: { end: () => deps.closeDb() },
    graceMs: deps.graceMs,
    ...(deps.drain != null ? { drain: deps.drain } : {}),
    // inference 退订先行（停接线再停存储）；settle-wake 无长连接（形状对齐）
    closeables: [
      { close: async () => deps.inference.close() },
      { close: () => deps.settleWake.close() },
      ...(deps.policyReaderStop != null ? [{ close: async () => deps.policyReaderStop?.() }] : []),
    ],
    ...(deps.exit != null ? { exit: deps.exit } : {}),
    ...(logger != null
      ? {
          log: {
            info: (msg: string) => logger.info({}, msg),
            error: (msg: string) => logger.error({}, msg),
          },
        }
      : {}),
  });
}
