/**
 * HTTP app（协议适配层）：错误信封收口 + 请求链 + 路由挂载。
 * 业务一律来自能力包 facade 与装配注入的读面——本层零业务规则
 * （错误目录装配与协议闸是契约，不是规则）。本层不触数据库句柄与能力包装配子入口；
 * pgSqlState 是纯 SQLSTATE 分类函数（trace-receiver 同款白名单例外）。
 */
import { Keala } from 'keala';
import {
  asMiddleware,
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
} from '@tillgate/http';
import { pgSqlState } from '@tillgate/db';
import { CLIENT_FACE_OVERRIDES, clientErrorCatalog } from './http/error-face.js';
import {
  sessionMiddleware,
  type SessionMiddleware,
  type SessionValidator,
} from './http/middleware/session.js';
import { authRoutes, type AuthDeps } from './http/routes/auth.js';
import { registerRoutes } from './http/routes/auth-register.js';
import { loginRoutes } from './http/routes/auth-login.js';
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
export function createClientApiApp(deps: ClientApiDeps): App {
  const app = new Keala();
  const session: SessionMiddleware = sessionMiddleware(deps.validateSession);

  // 错误响应由最外层中间件产生（keala onError 是日志监听器）——必须第一个注册
  app.use(
    errorHandling({
      catalog: clientErrorCatalog(),
      overrides: CLIENT_FACE_OVERRIDES,
      sqlState: pgSqlState,
      logger: deps.logger,
    }),
  );
  // keala notFound 在中间件链外执行——直接产出同款本地化信封（throw 不可达错误链）
  app.notFound((c) =>
    notFoundResponse(c, { catalog: clientErrorCatalog(), overrides: CLIENT_FACE_OVERRIDES }),
  );

  app.use(
    corsPreflight({
      origins: deps.protocol.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAgeSeconds: deps.protocol.corsMaxAgeSeconds,
    }),
  );
  app.use(securityHeaders);
  app.use(bodyParserLimit(deps.protocol.bodyLimitBytes));
  app.use(bodyParser(deps.protocol.bodyLimitBytes));
  if (deps.dbBudget != null) app.use(dbBudgetMiddleware(deps.dbBudget));
  app.use(asMiddleware(requestIdMiddleware()));

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

  app.mount('/', authRoutes(deps.auth, session));
  app.mount('/', registerRoutes(deps.auth));
  app.mount('/', loginRoutes(deps.auth));
  app.mount('/', forgotRoutes(deps.auth));
  app.mount('/', meRoutes(deps.me, session));
  app.mount('/', keysRoutes(deps.keys, session));
  app.mount('/', appsRoutes(deps.apps, session));
  app.mount('/', orgRoutes(deps.orgs, session));
  app.mount('/', walletRoutes(deps.wallet, session));
  app.mount('/', redeemRoutes(deps.redeem, session));
  app.mount('/', paymentsRoutes(deps.payments, session));
  app.mount('/', subscriptionRoutes(deps.subscriptions, session));
  app.mount('/', usageRoutes(deps.usage, session));
  app.mount('/', oauthRoutes(deps.oauth));
  app.mount('/', pricingRoutes(deps.pricing, session));
  app.mount('/', referralRoutes(deps.referrals, session));

  return withRequest(app);
}
