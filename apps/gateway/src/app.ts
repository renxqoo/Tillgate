import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import type { Ai } from '@ai-gateway/ai';
import type { GatewayEnv, Logger } from '@ai-gateway/core';
import { healthRoutes } from './routes/health.js';
import { debugTracesRoutes } from './routes/debug-traces.js';
import { modelsRoutes } from './routes/models.js';
import { inferenceEndpoints, inferenceRoutes } from './routes/inference-endpoints.js';
import { oauthTokenRoutes } from './routes/oauth-token.js';
import { authMiddleware, type AuthEnv } from './middleware/auth.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { requestLogMiddleware } from './middleware/request-log.js';
import { otelMiddleware } from './middleware/otel.js';
import { corsPreflight, securityHeaders, bodyParserLimit } from './middleware/security.js';
import { errorEnvelope, HttpError } from './lib/http.js';
import { pgSqlState } from '@ai-gateway/http';
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
 *   → 鉴权（推理端点表 + /v1/models）→ 路由
 */
export function createApp(deps: GatewayDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  const authService = new AuthService(deps.db, deps.redis, deps.env.JWT_SECRET, {
    authFailureLimit: deps.env.GATEWAY_AUTH_FAILURE_LIMIT,
    authFailureWindowS: deps.env.GATEWAY_AUTH_FAILURE_WINDOW_S,
  });
  const oauthService = new OAuthService(deps.db, deps.redis, deps.env.JWT_SECRET, deps.logger);
  const billing = createBilling({
    db: deps.db,
    admission: {
      maxPending: deps.env.BILLING_PENDING_MAX,
      maxOldestAgeMs: deps.env.BILLING_PENDING_MAX_AGE_SECONDS * 1_000,
      cacheMs: deps.env.BILLING_ADMISSION_CACHE_MS,
    },
  });
  const router = new ModelRouter(
    deps.db,
    deps.redis,
    deps.env.ENCRYPTION_KEY,
    deps.env.ENCRYPTION_KEY_OLD,
  );
  const pipeline = new LlmPipeline({ ...deps, billing, router });

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
  app.use('/v1/models', authMiddleware(authService, deps.env.TRUSTED_PROXY_HOPS));

  // 路由
  app.route('/', healthRoutes({ db: deps.db, redis: deps.redis, lifecycle: deps.lifecycle }));
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
    app.route(endpoint.path, inferenceRoutes(pipeline, endpoint));
  }
  app.route('/oauth/token', oauthTokenRoutes(oauthService, deps.env.TRUSTED_PROXY_HOPS));

  return app;
}

/** PG 约束错误 → 网关 OpenAI 信封（与 packages/http PG_CODE_MAP 同语义、网关码风格） */
const PG_GATEWAY_MAP: Record<string, { status: number; code: string; message: string }> = {
  '23505': { status: 409, code: 'conflict', message: '记录已存在（唯一约束冲突）' },
  '23503': { status: 400, code: 'invalid_reference', message: '引用的资源不存在' },
  '23514': { status: 400, code: 'constraint_violation', message: '操作违反数据约束' },
  '22001': { status: 400, code: 'value_too_long', message: '字段值超出长度限制' },
  '22P02': { status: 400, code: 'invalid_value', message: '字段值格式非法' },
  '22003': { status: 400, code: 'value_out_of_range', message: '字段值超出数值范围' },
};

/** 统一错误处理（导出供测试复用）：HttpError/ValidationError/PG 约束/HTTPException/其他 → OpenAI 错误信封 */
export function appErrorHandler(logger: Logger, err: Error, c: Context): Response {
  const requestId = readRequestId(c);
  if (err instanceof HttpError) {
    return errorEnvelope(c, err.status, err.code, err.message, err.suggestion, requestId);
  }
  if (err instanceof ValidationError) {
    return errorEnvelope(c, 400, 'invalid_request', '请求参数校验失败', undefined, requestId);
  }
  // PG 约束/值错误 → 4xx（可预期拒绝不得伪装 500；与 packages/http 同表同义）
  const pg = PG_GATEWAY_MAP[pgSqlState(err) ?? ''];
  if (pg) {
    return errorEnvelope(c, pg.status, pg.code, pg.message, undefined, requestId);
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
