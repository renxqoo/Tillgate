import { Hono } from 'hono';
import { pathToFileURL } from 'node:url';
import Redis from 'ioredis';
import { loadGatewayEnv, type GatewayEnv } from '@ai-gateway/config';
import { createLogger, type Logger } from '@ai-gateway/logger';
import { initOtel } from '@ai-gateway/otel';
import { createDb, type Db } from '@ai-gateway/db';
import { createAi, defaultAiConfig, type Ai } from '@ai-gateway/ai';
import { createRedisBreakerStorage, createRedisDeadCredentialStorage } from './infrastructure/ai-storage.js';
import { healthRoutes } from './routes/health.js';
import { modelsRoutes } from './routes/models.js';
import { chatCompletionsRoutes } from './routes/chat-completions.js';
import { embeddingsRoutes } from './routes/embeddings.js';
import { oauthTokenRoutes } from './routes/oauth-token.js';
import { authMiddleware, type AuthEnv } from './middleware/auth.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { requestLogMiddleware } from './middleware/request-log.js';
import { otelMiddleware } from './middleware/otel.js';
import { corsPreflight, securityHeaders, bodyParserLimit } from './middleware/security.js';
import { BillingService } from './lib/billing.js';
import { RateLimiter } from './lib/rate-limit.js';
import { MeterProducer } from './lib/meter.js';
import { meterEnqueueFailedCounter } from './lib/metrics.js';
import { ValidationError } from './lib/validation.js';

export const env: GatewayEnv = loadGatewayEnv();
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
 *    否则各副本内存独立，熔断形同虚设。
 */
export function createGatewayAi(redis?: Redis): Ai {
  // 双重门控：ALLOW_LOCAL_UPSTREAM=true 且 NODE_ENV !== 'production' 才放行 http://内网上游。
  // 仅用于本地 mock 上游压测；生产镜像即便误配 ALLOW_LOCAL_UPSTREAM 也被 NODE_ENV 拦下。
  const allowLocal = env.ALLOW_LOCAL_UPSTREAM && env.NODE_ENV !== 'production';
  const cfg = { ...defaultAiConfig(), allowLocalUrl: allowLocal };
  if (redis) {
    return createAi(cfg, {
      breakerStorage: createRedisBreakerStorage(redis),
      deadCredentialStorage: createRedisDeadCredentialStorage(redis),
    });
  }
  // 单实例退化：内存存储（开发用）
  return createAi(cfg);
}

export function createApp(db: Db, ai: Ai, billing: BillingService, rateLimiter: RateLimiter, meter: MeterProducer, redis: Redis): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // 统一错误处理：ValidationError → 400 + details（其他错误 → 500）
  app.onError((err, c) => {
    const requestId = (c as { var?: { requestId?: string } }).var?.requestId;
    // JSON 解析失败（非法 JSON body）→ 400
    if (err.message?.includes('JSON') || err instanceof SyntaxError) {
      return c.json(
        {
          error: {
            message: '请求体不是合法 JSON',
            type: 'invalid_request_error',
            code: 'invalid_request',
            param: null,
            request_id: requestId ?? null,
            suggestion: null,
          },
        },
        400,
      );
    }
    if (err instanceof ValidationError) {
      return c.json(
        {
          error: {
            message: '请求参数校验失败',
            type: 'invalid_request_error',
            code: 'invalid_request',
            param: null,
            request_id: requestId ?? null,
            details: err.details,
          },
        },
        400,
      );
    }
    logger.error({ requestId, err: err.message }, 'unhandled error');
    return c.json(
      {
        error: {
          message: '网关内部错误',
          type: 'server_error',
          code: 'internal_error',
          param: null,
          request_id: requestId ?? null,
          suggestion: null,
        },
      },
      500,
    );
  });

  // 全局中间件链（顺序：CORS预检 → 安全头+bodyLimit预判 → OTel → request_id → 鉴权）
  app.use('*', corsPreflight);
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit);
  app.use('*', otelMiddleware());
  app.use('*', requestIdMiddleware());
  app.use('/v1/chat/completions', authMiddleware(db, redis));
  app.use('/v1/models', authMiddleware(db, redis));
  app.use('/v1/embeddings', authMiddleware(db, redis));
  app.use('/v1/*', requestLogMiddleware(db, logger));

  app.route('/healthz', healthRoutes);
  app.route('/v1/models', modelsRoutes(db));
  app.route('/v1/chat/completions', chatCompletionsRoutes(db, ai, billing, rateLimiter, meter, redis));
  app.route('/v1/embeddings', embeddingsRoutes(db, ai, billing, rateLimiter, meter, redis));
  app.route('/oauth/token', oauthTokenRoutes(db, redis));

  return app;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // 提高 Node 原生 fetch（undici）的每源连接池上限。
  // 默认 ~128 连接/源 → 单上游时并发被卡在 ~128-200（即使 DB/事件循环空闲）。
  // 这是「单实例并发瓶颈」的真因：不是 DB 连接池，是 undici 出站连接池。
  // 用 plain Agent（只调 connections，不设 connect 钩子）→ 不破坏 SSE 流式逐块推送
  // （早先用 connect.lookup 的 custom dispatcher 会缓冲 body，已移除；plain Agent 无此问题）。
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connections: 2048, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 }));

  const db = createDb(env.DATABASE_URL);
  // B5 修复：拆两条 Redis 连接——共用一条会导致 Redis 宕机时业务命令进入 offline
  // queue 永不 reject，billing/route-cache/key-auth 的 try/catch fail-open 分支不可达，
  // /v1/* 全部 hang（sync-settle 兜底也够不着）。
  //
  //   - bullRedis：BullMQ 专用，保留 maxRetriesPerRequest: null（阻塞命令要求）。
  //   - redis（业务）：enableOfflineQueue: false + 有限 maxRetriesPerRequest + commandTimeout，
  //     Redis 宕机时命令立即 reject → 触发各业务的 catch 降级（fail-open）。
  const bullRedis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
  await bullRedis.connect();
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false, // 宕机时命令立即 reject（而非无限排队）→ fail-open 可达
    maxRetriesPerRequest: 1, // 单条命令最多重试 1 次（有限，不无限挂起）
    commandTimeout: 2_000, // 单命令 2s 超时（防慢命令拖垮请求）
    retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 2_000)),
  });
  await redis.connect();
  const billing = new BillingService(redis, db, env.HOLD_TTL_SECONDS * 1000);
  const rateLimiter = new RateLimiter(redis);
  const meter = new MeterProducer(bullRedis);
  // 入队失败 → 记日志 + 告警指标（资损防线 B4：防漏计费无感知）
  meter.onFailure = (data, error) => {
    logger.error({ requestId: data.requestId, userId: data.userId, err: error.message }, 'meter enqueue failed (revenue loss risk)');
    meterEnqueueFailedCounter.add(1);
  };
  const ai = createGatewayAi(redis);
  const server = createApp(db, ai, billing, rateLimiter, meter, redis);
  const { serve } = await import('@hono/node-server');
  const httpServer = serve({ fetch: server.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port }, 'gateway listening');
  });

  // C3 修复：定期回收泄漏的 hold（hold 后 gateway 崩溃、settle 未跑 → hold 残留 → 余额滞留）。
  // 每 60s 扫描一次，退还无 TTL 残留的真正泄漏 hold。best-effort，异常不致命。
  // 阈值=0：仅回收 ttl===-1（无 TTL 的异常残留），不碰仍在 TTL 内的正常在途 hold。
  // （旧值 60_000 会把 TTL 剩余 <60s 的长请求 hold 误回收 → 余额错乱资损）
  const reclaimTimer = setInterval(() => {
    billing.reclaimExpiredHolds().then((n) => {
      if (n > 0) logger.info({ reclaimed: n }, 'reclaimed leaked holds (balance refunded)');
    }).catch((err) => {
      logger.warn({ err: (err as Error).message }, 'hold reclaim sweep failed');
    });
  }, 60_000);
  reclaimTimer.unref();

  // H2：优雅关闭——SIGTERM/SIGINT 时停止接收新连接，等待在途请求完成（含 SSE 长连接）
  // 滚动更新时 compose stop_grace_period 给足时间（默认 10s，建议配 30s）
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // 防重复触发
    shuttingDown = true;
    logger.info({ signal }, 'gateway shutting down (draining in-flight requests)...');
    clearInterval(reclaimTimer);
    httpServer.close((err) => {
      if (err) logger.error({ err: err.message }, 'server close error');
      // 关闭 Redis 连接（meter queue 用 bullRedis + 业务用 redis）
      Promise.allSettled([meter.close(), bullRedis.quit(), redis.quit(), otel.shutdown()])
        .then(() => {
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

