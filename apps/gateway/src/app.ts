/**
 * HTTP app（协议适配层）：错误信封收口 + 请求链 + 路由挂载。
 * 业务一律来自 service 包——本层零业务规则（错误映射表是协议契约，不是规则）。
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createRepositories, type Db } from '@ai-gateway/repository';
import { mapErrorToHttp } from './http/error-map.js';
import { systemContext } from '@ai-gateway/service';
import { apiKeyMiddleware, type AuthEnv, type AuthGuards } from './middleware/api-key.js';
import { otelMiddleware } from './middleware/otel.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { bodyParserLimit, corsPreflight, securityHeaders } from './middleware/security.js';
import { requestLogMiddleware } from './middleware/request-log.js';
import { enginesAliasRoutes, inferenceEndpoints, inferenceRoutes } from './routes/inference-endpoints.js';
import { geminiNativeRoutes } from './routes/native-protocol.js';
import { modelsRoutes } from './routes/models.js';
import { modalityMultipartRoutes } from './routes/modality-multipart.js';
import { generationRoutes } from './routes/generation.js';
import { oauthTokenRoutes } from './routes/oauth-token.js';
import type { createRunChat } from './pipeline/run-chat.js';
import type { createSubmitGeneration } from './generation/submit.js';

export interface AppDeps {
  db: Db;
  runChat?: ReturnType<typeof createRunChat>;
  /** 生成任务提交编排（video/music 异步族；缺省不挂路由） */
  submitGeneration?: ReturnType<typeof createSubmitGeneration>;
  /** 鉴权爆破防护（Redis 装配注入；缺省跳过 = 单副本开发形态） */
  authGuards?: AuthGuards;
  /** Redis 就绪探针（/readyz；缺省只探 db） */
  redisProbe?: { ping(): Promise<unknown> };
  /** CORS 白名单（逗号分隔 env 装配解析）；空表 = 不放行跨域 */
  corsOrigins?: readonly string[];
  /** /oauth/token 与 JWT 凭证验签密钥（必配——JWT 凭证分支依赖） */
  oauth: { jwtSecret: string; tokenTtlSeconds: number };
}

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const app = new Hono<AuthEnv>();
  const repos = createRepositories();

  app.onError((error, c) => {
    const mapped = mapErrorToHttp(error);
    if (mapped.status >= 500) console.error('[gateway] internal error:', error);
    return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status as ContentfulStatusCode);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/v1/')) {
      return c.json({ error: { code: 'not_found', message: 'path not found' } }, 404);
    }
    return c.json({ error: { code: 'not_found', message: 'not found' } }, 404);
  });

  app.use('*', corsPreflight(deps.corsOrigins ?? []));
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit());
  app.use('*', requestIdMiddleware());
  // requestId 之后挂载：span 属性 request.id 依赖它；off 模式为 no-op
  app.use('*', otelMiddleware());

  app.get('/healthz', async (c) => {
    await repos.health.ping({ ...systemContext('healthz'), db });
    return c.json({ ok: true });
  });
  // /livez（nginx/LB 存活探针路径；轻量不查依赖）
  app.get('/livez', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    await repos.health.ping({ ...systemContext('readyz'), db });
    if (deps.redisProbe) await deps.redisProbe.ping();
    return c.json({ ok: true });
  });

  // requestLog 前置到鉴权之前：401/429 也入日志（「记录一切 /v1 请求」语义）
  app.use('/v1/*', requestLogMiddleware({ db, trustedProxyHops: deps.authGuards?.trustedProxyHops ?? 0 }));
  // 鉴权按已注册端点挂载（未注册路径 404 而非 401）
  app.use('/v1/models', apiKeyMiddleware(db, deps.authGuards, deps.oauth.jwtSecret));
  app.use('/v1/models/*', apiKeyMiddleware(db, deps.authGuards, deps.oauth.jwtSecret));

  app.route('/v1/models', modelsRoutes({ db, ctx: systemContext('models') }));
  if (deps.runChat) {
    for (const endpoint of inferenceEndpoints) {
      app.use(endpoint.path, apiKeyMiddleware(db, deps.authGuards, deps.oauth.jwtSecret));
      app.route(endpoint.path, inferenceRoutes(deps.runChat, endpoint));
    }
    // OpenAI legacy 引擎别名（pre-1.0 SDK 走 /v1/engines/:model/embeddings）
    const embeddings = inferenceEndpoints.find((e) => e.path === '/v1/embeddings')!;
    app.use('/v1/engines/:model/embeddings', apiKeyMiddleware(db, deps.authGuards, deps.oauth.jwtSecret));
    app.route('/v1/engines/:model', enginesAliasRoutes(deps.runChat, embeddings));
    // Gemini 原生入口（/v1beta/models/:model:generateContent|streamGenerateContent）
    app.use('/v1beta/models/:modelAction', apiKeyMiddleware(db, deps.authGuards, deps.oauth.jwtSecret));
    app.route('/', geminiNativeRoutes(deps.runChat));
    // 模态 multipart 族（同鉴权）
    for (const path of ['/v1/images/edits', '/v1/audio/transcriptions', '/v1/audio/translations']) {
      app.use(path, apiKeyMiddleware(db, deps.authGuards, deps.oauth.jwtSecret));
    }
    app.route('/', modalityMultipartRoutes(deps.runChat));
  }
  // 异步生成任务族（提交 + 查询，同鉴权）
  if (deps.submitGeneration) {
    for (const path of ['/v1/video/generations', '/v1/music/generations', '/v1/videos/*', '/v1/musics/*']) {
      app.use(path, apiKeyMiddleware(db, deps.authGuards, deps.oauth.jwtSecret));
    }
    app.route('/', generationRoutes({ db, submit: deps.submitGeneration }));
  }
  // /oauth/token（无鉴权——本身是取令牌端点；ipGuard 爆破锁定装配注入）
  app.route(
    '/oauth/token',
    oauthTokenRoutes({
      db,
      ...deps.oauth,
      ipGuard: deps.authGuards?.ipGuard,
      trustedProxyHops: deps.authGuards?.trustedProxyHops,
    }),
  );

  return app;
}
