/**
 * HTTP app（协议适配层）：错误信封收口 + 请求链 + 路由挂载。
 * 业务一律来自能力 facade——本层零业务规则（错误 face 映射是协议契约，不是规则）。
 * app 非 assembly 代码不引用 Db/DbTx/composition（架构测试机器锁定）。
 */
import { Hono } from 'hono';
import {
  bodyParserLimit,
  corsPreflight,
  dbBudgetMiddleware,
  errorHandler,
  securityHeaders,
  requestIdMiddleware,
  HttpErrors,
} from '@tillgate/http';
import type { Inference } from '@tillgate/inference';
import type { RequestLogStore } from '@tillgate/observability';
import { otelMiddleware } from './http/middleware/otel';
import { requestLogMiddleware } from './http/middleware/request-log';
import {
  apiKeyMiddleware,
  type AuthEnv,
  type AuthGuards,
  type AuthReadModel,
} from './http/middleware/api-key';
import { preauthIpRateLimitMiddleware, type RateLimitGate } from './http/middleware/rate-limit';
import { inferenceEndpoints } from './http/contracts/inference-endpoints';
import { inferenceRoutes, enginesAliasRoutes } from './http/routes/inference-endpoints';
import { geminiNativeRoutes } from './http/routes/native-gemini';
import { modelsRoutes, type ModelsReader } from './http/routes/models';
import { modalityMultipartRoutes } from './http/routes/modality-multipart';
import { generationRoutes } from './http/routes/generation';
import { oauthTokenRoutes, type OAuthTokenDeps } from './http/routes/oauth-token';
import type { AuthFailureGuard } from '@tillgate/runtime';
import { GATEWAY_FACE_OVERRIDES, gatewayErrorCatalog } from './http/openai-error-face';

export interface GatewayAppDeps {
  inference: Inference;
  reader: AuthReadModel;
  models: ModelsReader;
  /** OAuth client_credentials 凭证校验（accounts verifyAppClient 装配绑定） */
  verifyAppClient: Parameters<ReturnType<typeof oauthTokenRoutes>['post']>[0] extends never
    ? never
    : OAuthTokenDeps['verifyAppClient'];
  requestLogs: RequestLogStore;
  /** Redis 探针（/readyz；缺省只探 db） */
  redisProbe?: { ping(): Promise<unknown> };
  pingDb: () => Promise<void>;
  authGuards?: AuthGuards;
  oauth: {
    jwtSecret: string;
    issuer: string;
    audience: string;
    keyPrefix: string;
    tokenTtlSeconds: number;
  };
  rateLimit?: RateLimitGate;
  oauthIpGuard?: AuthFailureGuard;
  corsOrigins?: readonly string[];
  bodyLimitBytes?: number;
  /** DB 并发预算门(万级形态入口排队;缺省关闭——不注入即旁路) */
  dbBudget?: { limit: number; maxQueue: number; waitTimeoutMs: number };
  uploadLimits?: {
    imageMime: ReadonlySet<string>;
    audioMime: ReadonlySet<string>;
    maxFileBytes: number;
  };
  trustedProxyHops: number;
  logger?: { error(obj: unknown, msg: string): void };
}

// eslint-disable-next-line max-lines-per-function -- HTTP 装配平铺：中间件链与路由挂载顺序即契约
export function createGatewayApp(deps: GatewayAppDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.onError(
    errorHandler({
      catalog: gatewayErrorCatalog(),
      overrides: GATEWAY_FACE_OVERRIDES,
      ...(deps.logger != null ? { logger: deps.logger } : {}),
    }),
  );

  app.notFound((c) => {
    // /v1/ 前缀文案区分；统一 http.not_found 目录码
    throw HttpErrors.business('not_found', {
      path: c.req.path,
      detail: c.req.path.startsWith('/v1/') ? 'path not found' : 'not found',
    });
  });

  app.use(
    '*',
    corsPreflight({
      origins: deps.corsOrigins ?? [],
      methods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      maxAgeSeconds: 86_400,
    }),
  );
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit(deps.bodyLimitBytes ?? 10 * 1024 * 1024));
  if (deps.dbBudget != null) app.use('*', dbBudgetMiddleware(deps.dbBudget));
  app.use('*', requestIdMiddleware());
  // requestId 之后挂载：span 属性 request.id 依赖它；off 模式为 no-op
  app.use('*', otelMiddleware());

  app.get('/healthz', async (c) => {
    await deps.pingDb();
    return c.json({ ok: true });
  });
  app.get('/livez', (c) => c.json({ ok: true })); // 存活探针（LB）；轻量不查依赖
  app.get('/readyz', async (c) => {
    await deps.pingDb();
    if (deps.redisProbe) await deps.redisProbe.ping();
    return c.json({ ok: true });
  });

  // 预认证 per-IP 硬限（第一道闸）：未认证洪水不经过任何鉴权维度限流，且每发都写
  // request_logs（写放大）——本闸挂 requestLog 之前，超限 429 不写日志。
  // /v1 与 /v1beta 双入口同一 IP 桶（Gemini 原生入口不匹配 /v1/* 前缀）。
  if (deps.rateLimit?.preauthIpRpm != null) {
    const preauth = preauthIpRateLimitMiddleware({
      limiter: deps.rateLimit.limiter,
      maxPerMinute: deps.rateLimit.preauthIpRpm,
      trustedProxyHops: deps.trustedProxyHops,
    });
    app.use('/v1/*', preauth);
    app.use('/v1beta/*', preauth);
  }

  // requestLog 前置到鉴权之前：401/429 也入日志（「记录一切 /v1 与 /v1beta 请求」语义）
  const requestLog = requestLogMiddleware({
    store: deps.requestLogs,
    ...(deps.logger != null ? { logger: deps.logger } : {}),
    trustedProxyHops: deps.trustedProxyHops,
  });
  app.use('/v1/*', requestLog);
  app.use('/v1beta/*', requestLog);

  const authMiddleware = () =>
    apiKeyMiddleware(deps.reader, deps.authGuards, {
      secret: deps.oauth.jwtSecret,
      issuer: deps.oauth.issuer,
      audience: deps.oauth.audience,
      keyPrefix: deps.oauth.keyPrefix,
    });

  // 鉴权按已注册端点挂载（未注册路径 404 而非 401）
  for (const path of ['/v1/models', '/v1/models/*']) {
    app.use(path, authMiddleware());
  }
  app.route('/v1/models', modelsRoutes(deps.models));

  const routeDeps = {
    inference: deps.inference,
    ...(deps.rateLimit != null ? { rateLimit: deps.rateLimit } : {}),
  };
  for (const endpoint of inferenceEndpoints) {
    app.use(endpoint.path, authMiddleware());
    app.route(endpoint.path, inferenceRoutes(routeDeps, endpoint));
  }
  // OpenAI legacy 引擎别名（pre-1.0 SDK 走 /v1/engines/:model/embeddings）
  const embeddings = inferenceEndpoints.find((e) => e.path === '/v1/embeddings');
  if (embeddings == null) {
    // 端点注册表为冻结形状（architecture 快照锁定）；缺失即注册表漂移，启动 fail-fast
    throw new Error('inference endpoint registry missing /v1/embeddings');
  }
  app.use('/v1/engines/:model/embeddings', authMiddleware());
  app.route('/v1/engines/:model', enginesAliasRoutes(routeDeps, embeddings));
  // Gemini 原生入口（/v1beta/models/:model:generateContent|streamGenerateContent）
  app.use('/v1beta/models/:modelAction', authMiddleware());
  app.route('/', geminiNativeRoutes(routeDeps));
  // 模态 multipart 族（同鉴权）
  for (const path of ['/v1/images/edits', '/v1/audio/transcriptions', '/v1/audio/translations']) {
    app.use(path, authMiddleware());
  }
  app.route(
    '/',
    modalityMultipartRoutes(routeDeps, {
      ...(deps.uploadLimits != null
        ? {
            imageMime: deps.uploadLimits.imageMime,
            audioMime: deps.uploadLimits.audioMime,
            maxFileBytes: deps.uploadLimits.maxFileBytes,
          }
        : {}),
      bodyLimitBytes: deps.bodyLimitBytes ?? 10 * 1024 * 1024,
    }),
  );
  // 异步生成任务族（提交 + 查询，同鉴权）
  for (const path of [
    '/v1/video/generations',
    '/v1/music/generations',
    '/v1/videos/*',
    '/v1/musics/*',
  ]) {
    app.use(path, authMiddleware());
  }
  app.route('/', generationRoutes(routeDeps));

  // /oauth/token（无鉴权——本身是取令牌端点；ipGuard 爆破锁定装配注入）
  app.route(
    '/oauth/token',
    oauthTokenRoutes({
      verifyAppClient: deps.verifyAppClient,
      jwtSecret: deps.oauth.jwtSecret,
      tokenTtlSeconds: deps.oauth.tokenTtlSeconds,
      issuer: deps.oauth.issuer,
      audience: deps.oauth.audience,
      ...(deps.oauthIpGuard != null ? { ipGuard: deps.oauthIpGuard } : {}),
      trustedProxyHops: deps.trustedProxyHops,
    }),
  );

  return app;
}
