/**
 * HTTP app（协议适配层）：错误信封收口 + 请求链 + 路由挂载。
 * 业务一律来自本 app services 与共享 service 包——本层零业务规则
 * （错误映射表与会话校验链是协议契约，不是规则）。
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Db } from '@ai-gateway/repository';
import { createRepositories } from '@ai-gateway/repository';
import { mapErrorToHttp } from './http/error-map.js';
import { ZodError } from 'zod';
import { sessionMiddleware, type SessionEnv } from './middleware/session.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { bodyParserLimit, corsPreflight, securityHeaders } from './middleware/security.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { keysRoutes } from './routes/keys.js';
import { walletRoutes } from './routes/wallet.js';
import { redeemRoutes } from './routes/redeem.js';
import { paymentsRoutes } from './routes/payments.js';
import { usageRoutes } from './routes/usage.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { orgRoutes } from './routes/orgs.js';
import { appsRoutes } from './routes/apps.js';
import { oauthRoutes } from './routes/oauth.js';
import { pricingRoutes } from './routes/pricing.js';
import { referralRoutes } from './routes/referrals.js';
import { playgroundRoutes } from './routes/playground.js';
import type { ClientApiAssembly } from './assembly.js';

export interface AppDeps {
  db: Db;
  assembly: ClientApiAssembly;
  jwtSecret: string;
  trustedProxyHops: number;
  corsOrigins: readonly string[];
  bodyLimitBytes: number;
  secureCookie?: boolean;
}

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const app = new Hono<SessionEnv>();
  const repos = createRepositories();
  const session = sessionMiddleware(db, deps.jwtSecret);

  app.onError((error, c) => {
    if (error instanceof ZodError) {
      return c.json(
        { error: { code: 'invalid_request', message: '请求参数不合法' } },
        400,
      );
    }
    const mapped = mapErrorToHttp(error);
    if (mapped.status >= 500) console.error('[client-api] internal error:', error);
    return c.json(
      { error: { code: mapped.code, message: mapped.message } },
      mapped.status as ContentfulStatusCode,
    );
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: '路径不存在' } }, 404));

  app.use('*', corsPreflight(deps.corsOrigins));
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit(deps.bodyLimitBytes));
  app.use('*', requestIdMiddleware());

  app.get('/healthz', async (c) => {
    await repos.health.ping({
      db,
      requestId: c.get('requestId'),
      actor: { kind: 'system' },
      traceParent: null,
    });
    // Redis readiness（首选组件：不可达 = 不健康——LB/编排器应摘除本副本）
    try {
      await deps.assembly.redis.ping();
    } catch {
      return c.json({ ok: false, redis: 'down' }, 503);
    }
    return c.json({ ok: true });
  });

  app.route(
    '/',
    authRoutes(deps.assembly.auth, { session, trustedProxyHops: deps.trustedProxyHops }),
  );
  app.route('/', meRoutes(deps.assembly.auth, session));
  app.route('/', keysRoutes(deps.assembly.keys, session));
  app.route('/', walletRoutes(deps.assembly.walletRead, session));
  app.route('/', redeemRoutes(deps.assembly.redeem, session));
  app.route('/', paymentsRoutes(deps.assembly.payments, session));
  app.route('/', usageRoutes(deps.assembly.usage, session));
  app.route('/', subscriptionRoutes(deps.assembly.subscriptionService, session));
  app.route('/', orgRoutes(deps.assembly.org, session));
  app.route('/', appsRoutes(deps.assembly.apps, session));
  app.route('/', referralRoutes(deps.assembly.referralService, session));
  // 操练场代理（配置成组才挂载；未配时前端入口隐藏）
  if (deps.assembly.playground) {
    const pgRepos = createRepositories();
    app.route(
      '/',
      playgroundRoutes(
        {
          ...deps.assembly.playground,
          userStatus: async (userId) => {
            const account = await pgRepos.userAccount.findById(
              { db: deps.db, requestId: 'playground', actor: { kind: 'system' }, traceParent: null },
              userId,
            );
            return account != null && account.status === 0;
          },
        },
        session,
      ),
    );
  }
  app.route('/', oauthRoutes(deps.assembly.oauth, { secureCookie: deps.secureCookie ?? false }));
  app.route('/', pricingRoutes(db));

  return app;
}
