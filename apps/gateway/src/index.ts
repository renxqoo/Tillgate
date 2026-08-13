import { pathToFileURL } from 'node:url';
import Redis from 'ioredis';
import { loadGatewayEnv, createLogger, initOtel, type Logger } from '@ai-gateway/core';
import { createDb } from '@ai-gateway/db';
import { createAi, defaultAiConfig, type Ai } from '@ai-gateway/ai';
import {
  createRedisBreakerStorage,
  createRedisDeadCredentialStorage,
} from './infrastructure/ai-storage.js';
import { createApp } from './app.js';
import { RateLimiter } from './services/billing/rate-limit-service.js';
import { BillingDispatcher } from './services/billing/billing-dispatcher.js';
import { RequestLifecycle } from './services/runtime/request-lifecycle.js';
import { CompletionRegistry } from './services/runtime/completion-registry.js';

/**
 * gateway 启动入口（纯 bootstrap：装配依赖 → 起服务 → 优雅关闭）。
 * 业务装配见 app.ts（createApp），可独立测试。
 */

export const env = loadGatewayEnv();
export const logger: Logger = createLogger({
  level: env.LOG_LEVEL,
  serviceName: 'gateway',
  pretty: env.NODE_ENV === 'development',
});
export const otel: { shutdown: () => Promise<void> } = initOtel({
  serviceName: 'gateway',
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_ENABLED,
});

/**
 * 全局 createAi 实例。
 * H1：注入 Redis 熔断/死凭据存储——多副本（--scale gateway=N）共享熔断状态，
 *     否则各副本内存独立，熔断形同虚设。
 */
export function createGatewayAi(redis?: Redis): Ai {
  // 双重门控：ALLOW_LOCAL_UPSTREAM=true 且 NODE_ENV !== 'production' 才放行 http://内网上游。
  // 仅用于本地 mock 上游压测；生产镜像即便误配 ALLOW_LOCAL_UPSTREAM 也被 NODE_ENV 拦下。
  const allowLocal = env.ALLOW_LOCAL_UPSTREAM && env.NODE_ENV !== 'production';
  const cfg = {
    ...defaultAiConfig(),
    allowLocalUrl: allowLocal,
    allowedHosts: env.UPSTREAM_HOST_ALLOWLIST,
  };
  if (redis) {
    return createAi(cfg, {
      breakerStorage: createRedisBreakerStorage(redis),
      deadCredentialStorage: createRedisDeadCredentialStorage(redis),
    });
  }
  // 单实例退化：内存存储（开发用）
  return createAi(cfg);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // 提高 Node 原生 fetch（undici）的每源连接池上限。
  // 默认 ~128 连接/源 → 单上游时并发被卡在 ~128-200（即使 DB/事件循环空闲）。
  // 用 plain Agent（只调 connections，不设 connect 钩子）→ 不破坏 SSE 流式逐块推送。
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(
    new Agent({ connections: 2048, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 }),
  );

  const db = createDb(env.DATABASE_URL);
  // B5 修复：拆两条 Redis 连接——共用一条会导致 Redis 宕机时业务命令进入 offline
  // queue 永不 reject，业务 try/catch fail-open 分支不可达，/v1/* 全部 hang。
  //   - bullRedis：BullMQ 专用，保留 maxRetriesPerRequest: null（阻塞命令要求）。
  //   - redis（业务）：enableOfflineQueue: false + 有限重试 + commandTimeout，
  //     Redis 宕机时命令立即 reject → 触发各业务 catch 降级（fail-open）。
  const bullRedis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy: () => null,
  });
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2_000,
    retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 2_000)),
  });
  await redis.connect();

  let billingDispatcher = new BillingDispatcher();
  try {
    await bullRedis.connect();
    billingDispatcher = new BillingDispatcher(bullRedis);
  } catch (error) {
    logger.warn(
      { err: (error as Error).message },
      'billing wakeup unavailable; DB worker poll remains authoritative',
    );
  }
  const rateLimiter = new RateLimiter(redis);
  const ai = createGatewayAi(redis);
  const lifecycle = new RequestLifecycle(env.GATEWAY_REQUEST_DEADLINE_MS);
  const completions = new CompletionRegistry();
  const app = createApp({
    db,
    ai,
    redis,
    env,
    logger,
    billingDispatcher,
    rateLimiter,
    lifecycle,
    completions,
  });

  const { serve } = await import('@hono/node-server');
  const httpServer = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port }, 'gateway listening');
  });
  const nodeServer = httpServer as typeof httpServer & {
    maxConnections: number;
    headersTimeout: number;
    requestTimeout: number;
    keepAliveTimeout: number;
    maxRequestsPerSocket: number;
  };
  nodeServer.maxConnections = env.GATEWAY_MAX_CONNECTIONS;
  nodeServer.headersTimeout = env.GATEWAY_HEADERS_TIMEOUT_MS;
  nodeServer.requestTimeout = env.GATEWAY_REQUEST_TIMEOUT_MS;
  nodeServer.keepAliveTimeout = 65_000;
  nodeServer.maxRequestsPerSocket = 1_000;

  // H2：优雅关闭——SIGTERM/SIGINT 时停止接收新连接，等待在途请求完成（含 SSE 长连接）
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // 防重复触发
    shuttingDown = true;
    lifecycle.beginDrain();
    logger.info({ signal }, 'gateway shutting down (draining in-flight requests)...');
    httpServer.close((err) => {
      if (err) logger.error({ err: err.message }, 'server close error');
      Promise.allSettled([
        completions.drain(10_000),
        billingDispatcher.close(),
        bullRedis.quit(),
        redis.quit(),
        db.$client.end(),
        otel.shutdown(),
      ]).then(() => {
        logger.info('gateway shutdown complete');
        process.exit(0);
      });
    });
    // 超时兜底：30s 后强制退出（防僵死连接卡住）
    setTimeout(() => {
      logger.warn('graceful shutdown timeout, forcing exit');
      process.exit(1);
    }, 30_000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
