import { Hono, type Context } from 'hono';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import type { Ai } from '@ai-gateway/ai';
import type { GatewayEnv, Logger } from '@ai-gateway/core';
import { healthRoutes } from './routes/health.js';
import { debugTracesRoutes } from './routes/debug-traces.js';
import { modelsRoutes } from './routes/models.js';
import { inferenceEndpoints, inferenceRoutes } from './routes/inference-endpoints.js';
import { generationTaskRoutes } from './routes/generation-tasks.js';
import { nativeProtocolRoutes } from './routes/native-protocol.js';
import { modalityRoutes, modalityEndpointPaths } from './routes/modality-endpoints.js';
import { oauthTokenRoutes } from './routes/oauth-token.js';
import { authMiddleware, type AuthEnv } from './middleware/auth.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { requestLogMiddleware } from './middleware/request-log.js';
import { otelMiddleware } from './middleware/otel.js';
import { corsPreflight, securityHeaders, bodyParserLimit } from './middleware/security.js';
import { errorEnvelope, renderReject } from './lib/http.js';
import { translateBoundaryError } from './lib/errors.js';
import { createAuthService } from './services/auth/auth-service.js';
import { createOAuthService } from './services/auth/oauth-service.js';
import type { RateLimiter } from './services/billing/rate-limit-service.js';
import type { BillingDispatcher } from './services/billing/billing-dispatcher.js';
import { createModelRouter } from './services/routing/model-router.js';
import { createCoefficientCache } from './services/auth/coefficient-cache.js';
import { createPipeline } from './services/pipeline/run.js';
import type { RequestLifecycle } from './services/runtime/request-lifecycle.js';
import type { CompletionRegistry } from './services/runtime/completion-registry.js';
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
 *   → 鉴权（推理端点表 + /v1/models）→ 路由
 */
export function createApp(deps: GatewayDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  const authService = createAuthService(deps.db, deps.redis, deps.env.JWT_SECRET, {
    authFailureLimit: deps.env.GATEWAY_AUTH_FAILURE_LIMIT,
    authFailureWindowS: deps.env.GATEWAY_AUTH_FAILURE_WINDOW_S,
  });
  const oauthService = createOAuthService(deps.db, deps.redis, deps.env.JWT_SECRET, deps.logger);
  const billing = createBilling({
    db: deps.db,
    admission: {
      maxPending: deps.env.BILLING_PENDING_MAX,
      maxOldestAgeMs: deps.env.BILLING_PENDING_MAX_AGE_SECONDS * 1_000,
      cacheMs: deps.env.BILLING_ADMISSION_CACHE_MS,
    },
  });
  const router = createModelRouter(
    deps.db,
    deps.redis,
    deps.env.ENCRYPTION_KEY,
    deps.env.ENCRYPTION_KEY_OLD,
  );
  const coefficients = createCoefficientCache(deps.db, deps.redis);
  const runInference = createPipeline({ ...deps, billing, router, coefficients });

  // 统一错误处理（OpenAI 风格错误信封；不用 message 文本启发式）
  app.onError((err, c) => appErrorHandler(deps.logger, err, c));

  // /v1/* 未匹配路径：OpenAI 风格 404 信封
  app.notFound((c) => {
    if (c.req.path.startsWith('/v1/')) {
      return errorEnvelope(c, 404, 'not_found', '路径不存在', undefined, readRequestId(c));
    }
    return c.json({ error: { message: 'not found', code: 'not_found' } }, 404);
  });

  // 全局中间件链
  app.use('*', corsPreflight(deps.env.CORS_ALLOWED_ORIGINS));
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit());
  // requestId 先于 otel：span 属性 request.id（计费关联锚点）依赖它
  app.use('*', requestIdMiddleware());
  app.use('*', otelMiddleware());
  // requestLog 前置到鉴权之前：鉴权失败（401/429）也写入 request_logs。
  // 刻意按 /v1/* 前缀挂载而非端点表驱动——其语义是「记录一切 /v1 请求」（含未注册路径的 404），
  // 与推理端点表（只管已注册路径）职责不同。
  app.use('/v1/*', requestLogMiddleware(deps.db, deps.logger, deps.env.TRUSTED_PROXY_HOPS));
  // 鉴权：推理端点表驱动 + /v1/models（GET，非推理）
  for (const endpoint of inferenceEndpoints) {
    app.use(endpoint.path, authMiddleware(authService, deps.env.TRUSTED_PROXY_HOPS));
  }
  app.use('/v1/models/*', authMiddleware(authService, deps.env.TRUSTED_PROXY_HOPS));
  // 异步生成任务查询（video/music 提交后轮询）
  app.use('/v1/videos/*', authMiddleware(authService, deps.env.TRUSTED_PROXY_HOPS));
  app.use('/v1/musics/*', authMiddleware(authService, deps.env.TRUSTED_PROXY_HOPS));
  // 原生协议端点（模型名在 URL）：gemini v1beta 族 + 旧版 engines 别名
  app.use('/v1beta/*', authMiddleware(authService, deps.env.TRUSTED_PROXY_HOPS));
  // 模态端点（images/audio/rerank/moderations；multipart 族无 JSON body 校验）
  for (const path of modalityEndpointPaths) {
    app.use(path, authMiddleware(authService, deps.env.TRUSTED_PROXY_HOPS));
  }
  app.use('/v1/engines/*', authMiddleware(authService, deps.env.TRUSTED_PROXY_HOPS));

  // 路由
  app.route('/', healthRoutes({ db: deps.db, redis: deps.redis, lifecycle: deps.lifecycle }));
  app.route('/', generationTaskRoutes(deps.db));
  // 本地零基建链路查看页：仅 memory 模式暴露（otlp/off 下路由不存在）
  if (deps.env.OTEL_TRACES_MODE === 'memory') {
    app.route(
      '/debug',
      debugTracesRoutes({
        token: deps.env.DEBUG_TRACES_TOKEN,
        dev: deps.env.NODE_ENV === 'development',
      }),
    );
  }
  app.route('/v1/models', modelsRoutes(router));
  // 推理端点注册表驱动挂载（单一真相：routes/inference-endpoints.ts）
  for (const endpoint of inferenceEndpoints) {
    app.route(endpoint.path, inferenceRoutes(runInference, endpoint));
  }
  app.route('/', nativeProtocolRoutes(runInference));
  app.route('/', modalityRoutes(runInference));
  app.route('/oauth/token', oauthTokenRoutes(oauthService, deps.env.TRUSTED_PROXY_HOPS));

  return app;
}

/** 统一错误处理（导出供测试复用）：任何抛出的错误 → 统一翻译 → OpenAI 错误信封。
 *  翻译单一真相在 lib/errors.ts（HttpError/ValidationError/PG 约束/HTTPException/兜底 500），
 *  渲染单一真相在 lib/http.ts renderReject——本函数只补「未知异常记日志」这一件事。 */
export function appErrorHandler(logger: Logger, err: Error, c: Context): Response {
  const reject = translateBoundaryError(err);
  if (reject.status >= 500) {
    const requestId = readRequestId(c);
    logger.error(
      { requestId, errorName: err.name, err: err.message, stack: err.stack, cause: err.cause },
      'unhandled error',
    );
  }
  return renderReject(c, reject);
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
