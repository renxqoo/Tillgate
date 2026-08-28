/**
 * HTTP app（协议适配层）：错误信封收口 + 请求链 + 路由挂载。
 * 业务一律来自能力包 facade 与装配注入的读面——本层零业务规则
 * （错误目录装配与协议闸是契约，不是规则）。本层不触数据库句柄与能力包装配子入口；
 * pgSqlState 是纯 SQLSTATE 分类函数（trace-receiver 同款白名单例外）。
 */
import { Hono } from 'hono';
import {
  dbBudgetMiddleware,
  bodyParserLimit,
  corsPreflight,
  errorHandler,
  HttpErrors,
  requestIdMiddleware,
  securityHeaders,
  type DbBudgetOptions,
} from '@tillgate/http';
import { pgSqlState } from '@tillgate/db';
import { CLIENT_FACE_OVERRIDES, clientErrorCatalog } from './http/error-face.js';
import {
  sessionMiddleware,
  type SessionEnv,
  type SessionValidator,
} from './http/middleware/session.js';
import { authRoutes, type AuthDeps } from './http/routes/auth.js';
import { forgotRoutes } from './http/routes/auth-forgot.js';
import { meRoutes, type MeDeps } from './http/routes/me.js';
import { keysRoutes, type KeysDeps } from './http/routes/keys.js';
import { appsRoutes, type AppsDeps } from './http/routes/apps.js';
import { orgRoutes, type OrgsDeps } from './http/routes/orgs.js';
import { walletRoutes, type WalletDeps } from './http/routes/wallet.js';
import { redeemRoutes, type RedeemDeps } from './http/routes/redeem.js';
import { paymentsRoutes, type PaymentsDeps } from './http/routes/payments.js';
import { subscriptionRoutes, type SubscriptionsDeps } from './http/routes/subscriptions.js';
import { usageRoutes, type UsageReads } from './http/routes/usage.js';
import { oauthRoutes, type OAuthDeps } from './http/routes/oauth.js';
import { pricingRoutes, type PricingReads } from './http/routes/pricing.js';
import { referralRoutes, type ReferralsDeps } from './http/routes/referrals.js';

export interface ClientApiDeps {
  readonly protocol: {
    readonly trustedProxyHops: number;
    readonly corsOrigins: readonly string[];
    readonly corsMaxAgeSeconds: number;
    readonly bodyLimitBytes: number;
  };
  /** DB 并发预算门(公网 ingress 入口排队;缺省关闭——不注入即旁路) */
  readonly dbBudget?: DbBudgetOptions;
  readonly logger: { error(obj: Record<string, unknown>, msg?: string): void };
  readonly health: { pingDb(): Promise<void>; pingRedis(): Promise<void> };
  readonly validateSession: SessionValidator;
  readonly auth: AuthDeps;
  readonly oauth: OAuthDeps;
  readonly me: MeDeps;
  readonly keys: KeysDeps;
  readonly apps: AppsDeps;
  readonly orgs: OrgsDeps;
  readonly wallet: WalletDeps;
  readonly redeem: RedeemDeps;
  readonly payments: PaymentsDeps;
  readonly subscriptions: SubscriptionsDeps;
  readonly usage: UsageReads;
  readonly pricing: PricingReads;
  readonly referrals: ReferralsDeps;
}

// eslint-disable-next-line max-lines-per-function -- 应用装配:错误处理/中间件栈/路由挂载线性平铺
export function createClientApiApp(deps: ClientApiDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();
  const session = sessionMiddleware(deps.validateSession);

  app.onError(
    errorHandler({
      catalog: clientErrorCatalog(),
      overrides: CLIENT_FACE_OVERRIDES,
      sqlState: pgSqlState,
      logger: deps.logger,
    }),
  );
  app.notFound(() => {
    throw HttpErrors.business('not_found');
  });

  app.use(
    '*',
    corsPreflight({
      origins: deps.protocol.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAgeSeconds: deps.protocol.corsMaxAgeSeconds,
    }),
  );
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit(deps.protocol.bodyLimitBytes));
  if (deps.dbBudget != null) app.use('*', dbBudgetMiddleware(deps.dbBudget));
  app.use('*', requestIdMiddleware<SessionEnv>());

  app.get('/healthz', async (c) => {
    await deps.health.pingDb();
    // Redis readiness（首选组件：不可达 = 不健康——LB/编排器应摘除本副本）
    try {
      await deps.health.pingRedis();
    } catch {
      return c.json({ ok: false, redis: 'down' }, 503);
    }
    return c.json({ ok: true });
  });

  app.route('/', authRoutes(deps.auth, session));
  app.route('/', forgotRoutes(deps.auth));
  app.route('/', meRoutes(deps.me, session));
  app.route('/', keysRoutes(deps.keys, session));
  app.route('/', appsRoutes(deps.apps, session));
  app.route('/', orgRoutes(deps.orgs, session));
  app.route('/', walletRoutes(deps.wallet, session));
  app.route('/', redeemRoutes(deps.redeem, session));
  app.route('/', paymentsRoutes(deps.payments, session));
  app.route('/', subscriptionRoutes(deps.subscriptions, session));
  app.route('/', usageRoutes(deps.usage, session));
  app.route('/', oauthRoutes(deps.oauth));
  app.route('/', pricingRoutes(deps.pricing, session));
  app.route('/', referralRoutes(deps.referrals, session));

  return app;
}
