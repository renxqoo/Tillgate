/**
 * HTTP app（协议适配层）：错误信封收口 + 请求链 + 路由挂载。
 * 业务一律来自能力 facade——本层零业务规则（错误 face 映射是协议契约，不是规则）。
 * app 非 assembly 代码不引用 Db/DbTx/composition（架构测试机器锁定）。
 *
 * keala 无路径作用域 use：鉴权经各路由组 router.use 挂载域化；预认证链
 * （/v1 /v1beta /oauth/token）经 pathGated 全局件按装配前缀表门控。
 */
import { Keala, type Router } from 'keala';
import {
  asMiddleware,
  pathPrefixGate,
  bodyParser,
  bodyParserLimit,
  corsPreflight,
  dbBudgetMiddleware,
  errorHandling,
  notFoundResponse,
  requestIdMiddleware,
  securityHeaders,
  withRequest,
  type App,
  type DbBudgetOptions,
  type Middleware,
} from '@tillgate/http';
import type { Inference } from '@tillgate/inference';
import type { OutputCapConfig } from '@tillgate/inference';
import type { RequestLogStore } from '@tillgate/observability';
import { otelMiddleware } from './http/middleware/otel';
import { requestLogMiddleware } from './http/middleware/request-log';
import {
  apiKeyMiddleware,
  type AuthGuards,
  type AuthReadModel,
  type GwContext,
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
  verifyAppClient: OAuthTokenDeps['verifyAppClient'];
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
  /** 输出上界口径（准入预占与 inference prepare 共用配置；缺省取包缺省） */
  outputCap?: OutputCapConfig;
  /**
   * 服务端 drain 信号（停机宽限耗尽时以 ServerDrainAbort abort——驱动
   * server_draining 终态分类；与客户端断连信号在各入口合成）。
   */
  drainSignal?: AbortSignal;
  oauthIpGuard?: AuthFailureGuard;
  corsOrigins?: readonly string[];
  bodyLimitBytes?: number;
  /** DB 并发预算门(万级形态入口排队;缺省关闭——不注入即旁路) */
  dbBudget?: DbBudgetOptions;
  uploadLimits?: {
    imageMime: ReadonlySet<string>;
    audioMime: ReadonlySet<string>;
    maxFileBytes: number;
  };
  trustedProxyHops: number;
  logger?: { error(obj: unknown, msg: string): void };
}

/** 路由组挂载 + 鉴权域化（router.use 在该挂载域内先于 handler） */
function mountAuthed(
  app: Keala,
  entry: { path: string; router: Router; auth: Middleware<GwContext> },
): void {
  entry.router.use(asMiddleware(entry.auth));
  app.mount(entry.path, entry.router);
}

// eslint-disable-next-line max-lines-per-function -- HTTP 装配平铺：中间件链与路由挂载顺序即契约
export function createGatewayApp(deps: GatewayAppDeps): App {
  const app = new Keala();

  // 错误响应由最外层中间件产生（keala onError 是日志监听器）——必须第一个注册
  app.use(
    errorHandling({
      catalog: gatewayErrorCatalog(),
      overrides: GATEWAY_FACE_OVERRIDES,
      ...(deps.logger != null ? { logger: deps.logger } : {}),
    }),
  );

  app.notFound((c) =>
    // /v1/ 前缀文案区分；统一 http.not_found 目录码（keala notFound 在链外——直出信封）
    notFoundResponse(
      c,
      { catalog: gatewayErrorCatalog(), overrides: GATEWAY_FACE_OVERRIDES },
      {
        path: c.path,
        detail: c.path.startsWith('/v1/') ? 'path not found' : 'not found',
      },
    ),
  );

  const bodyLimitBytes = deps.bodyLimitBytes ?? 10 * 1024 * 1024;
  app.use(
    corsPreflight({
      origins: deps.corsOrigins ?? [],
      methods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      maxAgeSeconds: 86_400,
    }),
  );
  app.use(securityHeaders);
  app.use(bodyParserLimit(bodyLimitBytes));
  app.use(bodyParser(bodyLimitBytes));
  if (deps.dbBudget != null) app.use(dbBudgetMiddleware(deps.dbBudget));
  app.use(asMiddleware(requestIdMiddleware()));
  // requestId 之后挂载：span 属性 request.id 依赖它；off 模式为 no-op
  app.use(asMiddleware(otelMiddleware()));

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

  /**
   * 预认证链挂载（顺序即契约；经 pathGated 门控——keala 全局件 + 装配前缀表）：
   * 1. per-IP 硬限——未认证洪水不经过任何鉴权维度限流，且每发都写 request_logs（写放大），
   *    故本闸挂日志之前：超限 429 直接出站、不写日志；/v1 与 /v1beta 双入口同一 IP 桶。
   * 2. requestLog——鉴权之前，401/429 也入日志（「记录一切 /v1 与 /v1beta 请求」语义）。
   */
  const gate = deps.rateLimit;
  if (gate != null && gate.preauthIpRpm != null) {
    app.use(
      asMiddleware(
        pathPrefixGate(
          ['/v1', '/v1beta'],
          preauthIpRateLimitMiddleware({
            limiter: gate.limiter,
            maxPerMinute: gate.preauthIpRpm,
            trustedProxyHops: deps.trustedProxyHops,
          }),
        ),
      ),
    );
    // /oauth/token 是第三个公网入口（不在 /v1 前缀下）：未认证洪水在 ipGuard 锁定
    // 前每发都是一次 verifyAppClient DB 读 + 2 个 Redis 写——同闸覆盖（精确路径门）
    app.use(
      asMiddleware(
        pathPrefixGate(
          ['/oauth/token'],
          preauthIpRateLimitMiddleware({
            limiter: gate.limiter,
            maxPerMinute: gate.preauthIpRpm,
            trustedProxyHops: deps.trustedProxyHops,
          }),
        ),
      ),
    );
  }
  app.use(
    asMiddleware(
      pathPrefixGate(
        ['/v1', '/v1beta'],
        requestLogMiddleware({
          store: deps.requestLogs,
          ...(deps.logger != null ? { logger: deps.logger } : {}),
          trustedProxyHops: deps.trustedProxyHops,
        }),
      ),
    ),
  );

  const authMiddleware = () =>
    apiKeyMiddleware(deps.reader, deps.authGuards, {
      secret: deps.oauth.jwtSecret,
      issuer: deps.oauth.issuer,
      audience: deps.oauth.audience,
      keyPrefix: deps.oauth.keyPrefix,
    });

  // 鉴权按已注册端点挂载（router.use 域化＝旧路径作用域；未注册路径 404 而非 401）
  mountAuthed(app, { path: '/v1/models', router: modelsRoutes(deps.models), auth: authMiddleware() });

  const routeDeps = {
    inference: deps.inference,
    ...(deps.rateLimit != null ? { rateLimit: deps.rateLimit } : {}),
    ...(deps.outputCap != null ? { outputCap: deps.outputCap } : {}),
    ...(deps.drainSignal != null ? { drainSignal: deps.drainSignal } : {}),
  };
  for (const endpoint of inferenceEndpoints) {
    mountAuthed(app, {
      path: endpoint.path,
      router: inferenceRoutes(routeDeps, endpoint),
      auth: authMiddleware(),
    });
  }
  // OpenAI legacy 引擎别名（pre-1.0 SDK 走 /v1/engines/:model/embeddings）
  const embeddings = inferenceEndpoints.find((e) => e.path === '/v1/embeddings');
  if (embeddings == null) {
    // 端点注册表为冻结形状（architecture 快照锁定）；缺失即注册表漂移，启动 fail-fast
    throw new Error('inference endpoint registry missing /v1/embeddings');
  }
  mountAuthed(app, { path: '/v1/engines/:model', router: enginesAliasRoutes(routeDeps, embeddings), auth: authMiddleware() });
  // Gemini 原生入口（/v1beta/models/:model:generateContent|streamGenerateContent）
  mountAuthed(app, { path: '/', router: geminiNativeRoutes(routeDeps), auth: authMiddleware() });
  // 模态 multipart 族（同鉴权）
  mountAuthed(app, {
    path: '/',
    router: modalityMultipartRoutes(routeDeps, {
      ...(deps.uploadLimits != null
        ? {
            imageMime: deps.uploadLimits.imageMime,
            audioMime: deps.uploadLimits.audioMime,
            maxFileBytes: deps.uploadLimits.maxFileBytes,
          }
        : {}),
      bodyLimitBytes,
    }),
    auth: authMiddleware(),
  });
  // 异步生成任务族（提交 + 查询，同鉴权）
  mountAuthed(app, { path: '/', router: generationRoutes(routeDeps), auth: authMiddleware() });

  // /oauth/token（无鉴权——本身是取令牌端点；ipGuard 爆破锁定装配注入）
  app.mount(
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

  return withRequest(app);
}
