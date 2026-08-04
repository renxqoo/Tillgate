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
  const cfg = { ...defaultAiConfig(), allowLocalUrl: false }; // 生产安全：强制 https
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

  // 全局中间件链（顺序：CORS预检 → 安全头 → bodyLimit → OTel → request_id → 鉴权）
  app.use('*', corsPreflight);
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit);
  app.use('*', otelMiddleware());
  app.use('*', requestIdMiddleware());
  // 鉴权：仅业务路由（healthz 不需要）
  app.use('/v1/chat/completions', authMiddleware(db, redis));
  app.use('/v1/models', authMiddleware(db, redis));
  app.use('/v1/embeddings', authMiddleware(db, redis));

  app.route('/healthz', healthRoutes);
  app.route('/v1/models', modelsRoutes(db));
  app.route('/v1/chat/completions', chatCompletionsRoutes(db, ai, billing, rateLimiter, meter));
  app.route('/v1/embeddings', embeddingsRoutes(db, ai, billing, rateLimiter, meter));
  app.route('/oauth/token', oauthTokenRoutes(db, redis));

  return app;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const db = createDb(env.DATABASE_URL);
  // BullMQ 要求 maxRetriesPerRequest: null（阻塞命令如 BLPOP 需要无限重试）
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
  await redis.connect();
  const billing = new BillingService(redis, db, env.HOLD_TTL_SECONDS * 1000);
  const rateLimiter = new RateLimiter(redis);
  const meter = new MeterProducer(redis);
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

  // H2：优雅关闭——SIGTERM/SIGINT 时停止接收新连接，等待在途请求完成（含 SSE 长连接）
  // 滚动更新时 compose stop_grace_period 给足时间（默认 10s，建议配 30s）
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // 防重复触发
    shuttingDown = true;
    logger.info({ signal }, 'gateway shutting down (draining in-flight requests)...');
    httpServer.close((err) => {
      if (err) logger.error({ err: err.message }, 'server close error');
      // 关闭 Redis 连接（meter queue + billing）
      Promise.allSettled([meter.close(), redis.quit(), otel.shutdown()])
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

