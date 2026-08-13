import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import type { Ai } from '@ai-gateway/ai';
import type { GatewayEnv, Logger } from '@ai-gateway/core';
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
import { errorEnvelope, HttpError } from './lib/http.js';
import { ValidationError } from './lib/validation.js';
import { AuthService } from './services/auth/auth-service.js';
import { OAuthService } from './services/auth/oauth-service.js';
import { RateLimiter } from './services/billing/rate-limit-service.js';
import { BillingDispatcher } from './services/billing/billing-dispatcher.js';
import { ModelRouter } from './services/routing/model-router.js';
import { LlmPipeline } from './services/pipeline/llm-pipeline.js';
import { RequestLifecycle } from './services/runtime/request-lifecycle.js';
import { CompletionRegistry } from './services/runtime/completion-registry.js';
import { createBilling } from '@ai-gateway/ledger';

/** gateway 依赖（启动时装配，测试可注入） */
export interface GatewayDeps {
  db: Db;
  ai: Ai;
  redis: Redis;
  env: GatewayEnv;
  logger: Logger;
  billingDispatcher: BillingDispatcher;
  rateLimiter: RateLimiter;
  lifecycle: RequestLifecycle;
  completions: CompletionRegistry;
}

/**
 * createApp：组装中间件链 + 路由（可测试，无副作用）。
 *
 * 中间件顺序：
 *   CORS 预检 → 安全头 → body 上限 → OTel → requestId → requestLog（鉴权前：401/429 也入日志）
 *   → 鉴权（/v1/chat/completions、/v1/models、/v1/embeddings）→ 路由
 */
export function createApp(deps: GatewayDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  const authService = new AuthService(deps.db, deps.redis, deps.env.JWT_SECRET);
  const oauthService = new OAuthService(deps.db, deps.redis, deps.env.JWT_SECRET, deps.logger);
  const billing = createBilling({
    db: deps.db,
    admission: {
      maxPending: deps.env.BILLING_PENDING_MAX,
      maxOldestAgeMs: deps.env.BILLING_PENDING_MAX_AGE_SECONDS * 1_000,
      cacheMs: deps.env.BILLING_ADMISSION_CACHE_MS,
    },
  });
  const router = new ModelRouter(deps.db, deps.redis, deps.env.ENCRYPTION_KEY);
  const pipeline = new LlmPipeline({ ...deps, billing, router });

  // 统一错误处理（OpenAI 风格错误信封；不用 message 文本启发式）
  app.onError((err, c) => appErrorHandler(deps.logger, err, c));

  // /v1/* 未匹配路径：OpenAI 风格 404 信封
  app.notFound((c) => {
    if (c.req.path.startsWith('/v1/')) {
      return errorEnvelope(c, 404, 'not_found', '路径不存在', undefined, readRequestId(c));
    }
    return c.json({ error: 'not found' }, 404);
  });

  // 全局中间件链
  app.use('*', corsPreflight(deps.env.CORS_ALLOWED_ORIGINS));
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit());
  app.use('*', otelMiddleware());
  app.use('*', requestIdMiddleware());
  // requestLog 前置到鉴权之前：鉴权失败（401/429）也写入 request_logs
  app.use('/v1/*', requestLogMiddleware(deps.db, deps.logger));
  app.use('/v1/chat/completions', authMiddleware(authService));
  app.use('/v1/models', authMiddleware(authService));
  app.use('/v1/embeddings', authMiddleware(authService));

  // 路由
  app.route('/', healthRoutes({ db: deps.db, redis: deps.redis, lifecycle: deps.lifecycle }));
  app.route('/v1/models', modelsRoutes(router));
  app.route('/v1/chat/completions', chatCompletionsRoutes(pipeline));
  app.route('/v1/embeddings', embeddingsRoutes(pipeline));
  app.route('/oauth/token', oauthTokenRoutes(oauthService));

  return app;
}

/** 统一错误处理（导出供测试复用）：HttpError/ValidationError/HTTPException/其他 → OpenAI 错误信封 */
export function appErrorHandler(logger: Logger, err: Error, c: Context): Response {
  const requestId = readRequestId(c);
  if (err instanceof HttpError) {
    return errorEnvelope(c, err.status, err.code, err.message, err.suggestion, requestId);
  }
  if (err instanceof ValidationError) {
    return errorEnvelope(c, 400, 'invalid_request', '请求参数校验失败', undefined, requestId);
  }
  if (err instanceof HTTPException) {
    // Hono 内置错误：JSON 解析失败（400）/ 未匹配路由（404）等
    const status = err.status >= 400 && err.status < 600 ? err.status : 400;
    const message = status === 400 ? '请求体不是合法 JSON' : '路径不存在';
    return errorEnvelope(
      c,
      status,
      status === 404 ? 'not_found' : 'invalid_request',
      message,
      undefined,
      requestId,
    );
  }
  logger.error(
    { requestId, errorName: err.name, err: err.message, stack: err.stack, cause: err.cause },
    'unhandled error',
  );
  return errorEnvelope(c, 500, 'internal_error', '网关内部错误', undefined, requestId);
}

/** 安全读取 requestId（onError 可能在 requestId 中间件之前触发） */
function readRequestId(c: unknown): string | null {
  try {
    const v = (c as { var?: { requestId?: unknown } }).var;
    return typeof v?.requestId === 'string' ? v.requestId : null;
  } catch {
    return null;
  }
}
