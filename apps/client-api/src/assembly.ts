/**
 * 装配根：进程级依赖一次组装（db / Redis / 能力包 facade / 守卫 / 读面 / 路由产物）。
 * 全部可变值来自 config——本文件零字面量配置（领域常量除外并注明）。
 * 唯一 ./composition 消费点（adapters 亦白名单——架构测试执行）。
 *
 * wallet 白名单 fail-closed：本 app 只经手五类业务域入账（gift 注册赠送 / redeem
 * 兑换 / topup 充值 / subscription 订阅收款 / referral 返利），对手科目只有外部
 * 世界与平台收入镜像（v1 语义）。跨能力 bridge（walletCredit / sessionInvalidation）
 * 不共享事务——赠送/归因本就是 best-effort 段（accounts G4/G5 注释口径）。
 */
import { createDb, ping, type Db, type TxRetryPolicy } from '@tillgate/db';
import {
  assertRedisReachable,
  createAuthFailureGuard,
  createCipher,
  createKeyBruteForceGuard,
  createLogger,
  createRedisClient,
  type Logger,
} from '@tillgate/runtime';
import { initOtel, type OtelHandle } from '@tillgate/observability';
import type { Identity, Mailer } from '@tillgate/identity';
import { createAccounts, USER_STATUS, type AccountUseCases } from '@tillgate/accounts';
import { createPgFundingSourceResolver } from '@tillgate/accounts/composition';
import {
  createBilling,
  createPaymentsApi,
  createRedemptionApi,
  type Billing,
  type PaymentsApi,
  type RedemptionApi,
} from '@tillgate/billing';
import {
  createPostgresBillingStore,
  createPostgresPaymentOrderStore,
  createPostgresRedeemCodeStore,
  createPostgresWalletStore,
  createEpayProvider,
  createStripeProvider,
} from '@tillgate/billing/composition';
import type { Redis } from 'ioredis';
import type { ClientApiConfig } from './config.js';
import type { ClientApiDeps } from './app.js';
import type { SessionInfo } from './http/middleware/session.js';
import { createAccountRead } from './adapters/account-read.js';
import { createBillingRead } from './adapters/billing-read.js';
import { createUsageRead } from './adapters/usage-read.js';
import { createSubscriptionRead } from './adapters/subscription-read.js';
import { createPricingRead } from './adapters/pricing-read.js';
import { createRedisFixedWindowCounter } from './adapters/redis-rate-counter.js';
import { createIdentityStack } from './adapters/identity-stack.js';
import { RESET_TOKEN_TTL_MINUTES } from './adapters/redis-reset-token.js';

export interface ClientApiAssembly {
  readonly logger: Logger;
  readonly otel: OtelHandle;
  readonly db: Db;
  readonly redis: Redis;
  readonly identity: Identity;
  readonly accounts: AccountUseCases;
  readonly billing: Billing;
  readonly deps: ClientApiDeps;
}

/** 存储时钟单点（identity/accounts/billing 同源注入） */
const clock = (): Date => new Date();

/** 装配覆盖缝：mailer 显式注入/置空（E2E capture mailer 消费；缺省按环境构造） */
export interface AssemblyOverrides {
  readonly mailer?: Mailer | null;
}

// eslint-disable-next-line max-lines-per-function, complexity -- 装配根 composition root:线性依赖组装,拆段只会层层透传上下文(存量棘轮)
export async function assembleClientApi(
  config: ClientApiConfig,
  overrides: AssemblyOverrides = {},
): Promise<ClientApiAssembly> {
  // 经 zod 配置读运行期 NODE_ENV：直接读 process.env 会被 bun build 在构建期静态
  // 内联（builder 阶段无 NODE_ENV → pretty 恒 true），生产镜像因 pino-pretty
  // transport 动态 require（thread-stream worker 打不进 bundle）必崩
  const logger = createLogger({
    level: config.LOG_LEVEL,
    serviceName: 'client-api',
    pretty: config.NODE_ENV !== 'production',
  });
  const otel = initOtel({
    serviceName: 'client-api',
    serviceVersion: '0.1.0',
    mode: config.OTEL_TRACES_MODE,
    ...(config.OTEL_EXPORTER_OTLP_ENDPOINT != null
      ? {
          endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
          metricsExportIntervalMs: config.OTEL_METRICS_INTERVAL_MS,
        }
      : {}),
    ...(config.TRACE_RECEIVER_TOKEN != null ? { authToken: config.TRACE_RECEIVER_TOKEN } : {}),
  });

  const db = createDb({
    url: config.DATABASE_URL,
    poolMax: config.DB_POOL_MAX,
    idleTimeoutMillis: config.CLIENT_DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.CLIENT_DB_CONNECT_TIMEOUT_MS,
    maxUses: config.CLIENT_DB_MAX_USES,
  });

  const redis = createRedisClient(
    config.REDIS_URL,
    config.REDIS_SENTINELS != null
      ? {
          serviceName: 'client-api',
          logThrottleMs: config.CLIENT_REDIS_LOG_THROTTLE_MS,
          log: (message) => logger.warn({ message }, 'client-api redis'),
          sentinels: config.REDIS_SENTINELS,
          sentinelName: config.REDIS_SENTINEL_NAME as string,
          ...(config.REDIS_SENTINEL_PASSWORD != null
            ? { sentinelPassword: config.REDIS_SENTINEL_PASSWORD }
            : {}),
        }
      : {
          serviceName: 'client-api',
          logThrottleMs: config.CLIENT_REDIS_LOG_THROTTLE_MS,
          log: (message) => logger.warn({ message }, 'client-api redis'),
        },
  );
  // Redis 必配（爆破防护/限流/OAuth state/定价缓存——fail-closed：连不上拒绝启动）
  await assertRedisReachable(
    redis,
    'client-api',
    config.REDIS_URL,
    config.CLIENT_STARTUP_PROBE_TIMEOUT_MS,
  );

  const txRetry: TxRetryPolicy = {
    maxAttempts: config.CLIENT_TX_MAX_ATTEMPTS,
    baseDelayMs: config.CLIENT_TX_BASE_DELAY_MS,
    maxJitterMs: config.CLIENT_TX_MAX_JITTER_MS,
  };

  // ---- identity（凭据/挑战/会话/OAuth/吊销——OAuth 映射/邮件/Redis 件在 adapters/identity-stack.ts） ----
  const { identity, oauthProviders, mailer, resetTokens, emailCodeRequired, apiBase } =
    createIdentityStack({
      config,
      db,
      redis,
      txRetry,
      logger,
      clock,
      ...(overrides.mailer !== undefined ? { mailerOverride: overrides.mailer } : {}),
    });

  // ---- billing（钱包/订阅/支付/兑换——共享同一套 postgres store） ----
  const walletStore = createPostgresWalletStore(db, { retry: txRetry });
  const billingStore = createPostgresBillingStore(db, { retry: txRetry });
  const billing = createBilling(
    {
      walletStore,
      store: billingStore,
      quota: billingStore.quotaStore,
      channels: billingStore.channelStore,
      accounts: billingStore.accountContext,
    },
    {
      guards: {
        refTypes: ['gift', 'redeem', 'topup', 'subscription', 'referral'],
        currencies: [config.CLIENT_CURRENCY],
        internalAccounts: ['outside', 'platform_revenue'],
      },
      currency: config.CLIENT_CURRENCY,
      resolver: createPgFundingSourceResolver(),
      failurePolicy: {
        maxAttempts: config.CLIENT_SETTLE_MAX_ATTEMPTS,
        baseDelayMs: config.CLIENT_SETTLE_BASE_DELAY_MS,
        maxDelayMs: config.CLIENT_SETTLE_MAX_DELAY_MS,
      },
      clock,
      onError: (error, context) =>
        logger.error({ err: String(error), context }, 'settlement error'),
    },
  );

  const rateCounter = createRedisFixedWindowCounter(redis, 'client-api');
  const payments: PaymentsApi = createPaymentsApi({
    store: billingStore,
    orders: createPostgresPaymentOrderStore(db),
    wallet: billing.wallet,
    providers: [
      ...(config.EPAY_PID != null
        ? [
            createEpayProvider({
              pid: config.EPAY_PID,
              key: config.EPAY_KEY as string,
              gatewayUrl: config.EPAY_GATEWAY_URL as string,
              notifyUrl: config.EPAY_NOTIFY_URL as string,
              returnUrl: config.EPAY_RETURN_URL as string,
              payType: config.EPAY_PAY_TYPE as 'alipay' | 'wxpay' | 'qqpay',
            }),
          ]
        : []),
      ...(config.STRIPE_SECRET_KEY != null
        ? [
            createStripeProvider({
              secretKey: config.STRIPE_SECRET_KEY,
              webhookSecret: config.STRIPE_WEBHOOK_SECRET as string,
              successUrl: config.STRIPE_SUCCESS_URL as string,
              cancelUrl: config.STRIPE_CANCEL_URL as string,
              currency: config.CLIENT_CURRENCY,
              ...(config.STRIPE_API_BASE != null ? { apiBase: config.STRIPE_API_BASE } : {}),
            }),
          ]
        : []),
    ],
    currency: config.CLIENT_CURRENCY,
    exchangeRate: config.TOPUP_EXCHANGE_RATE,
    topupMin: config.TOPUP_MIN,
    topupMax: config.TOPUP_MAX,
    orderLimiter: rateCounter,
    perMinuteOrderLimit: config.CLIENT_TOPUP_ORDERS_PER_MINUTE,
    orderTtlMs: config.PAYMENT_ORDER_TTL_MS,
    clock,
    logError: (message, detail) => logger.error({ detail }, message),
  });
  const redemption: RedemptionApi = createRedemptionApi({
    store: billingStore,
    codes: createPostgresRedeemCodeStore(db),
    wallet: billing.wallet,
    limiter: rateCounter,
    perMinuteLimit: config.REDEEM_PER_MINUTE_LIMIT,
    clock,
  });

  // ---- accounts（资料/Key/App/组织/推荐——walletCredit 与吊销 bridge 注入） ----
  const accounts = createAccounts({
    db,
    walletCredit: {
      // 跨能力 bridge：赠送/返利入账走 billing 钱包幂等键；不进 accounts 事务
      // （v1 G4/G5：best-effort 段，失败可按 refKey 补发）
      async credit(_db, command) {
        const result = await billing.wallet.credit({
          userId: command.userId,
          amount: command.amount,
          refType: command.refType,
          refId: command.refId,
          ...(command.memo != null ? { memo: command.memo } : {}),
        });
        return { replayed: result.replayed };
      },
    },
    sessionInvalidation: {
      // 跨能力 bridge：会话吊销线归 identity（§3.4 唯一所有者）
      async invalidateUserSessions(_db, input) {
        await identity.revocation.advance(input);
      },
    },
    policy: {
      keyPrefix: config.KEY_PREFIX,
      invitationTtlMs: config.CLIENT_INVITATION_TTL_MS,
      invitationPendingFactor: config.CLIENT_INVITATION_PENDING_FACTOR,
      invitationPendingCap: config.CLIENT_INVITATION_PENDING_CAP,
      amountLimitUpper: '1000000000000',
      rpmLimitMax: config.CLIENT_RPM_LIMIT_MAX,
      tpmLimitMax: config.CLIENT_TPM_LIMIT_MAX,
      scopeModelsMax: 100,
      referralInviteeLimit: config.CLIENT_REFERRAL_INVITEE_LIMIT,
      listPage: { page: 1, limit: 20, maxLimit: 100 },
      banDefaultReason: 'banned by administrator',
    },
    txRetry,
    now: clock,
  });

  // ---- 读面与守卫 ----
  const accountRead = createAccountRead(db);
  const billingRead = createBillingRead(db);
  const usageRead = createUsageRead(db, config.CLIENT_USAGE_TZ);
  const subscriptionRead = createSubscriptionRead(db);
  const pricingRead = createPricingRead(db, redis, {
    cacheTtlMs: config.PRICING_CACHE_TTL_MS,
    timezoneTtlMs: config.BILLING_TIMEZONE_TTL_MS,
    timezoneFallback: config.BILLING_TIMEZONE_DEFAULT,
  });
  const loginGuard = createKeyBruteForceGuard(redis, {
    failureThreshold: config.LOGIN_FAILURE_THRESHOLD,
    failureWindowS: config.LOGIN_FAILURE_WINDOW_S,
    lockS: config.LOGIN_LOCK_S,
  });
  const ipGuard = createAuthFailureGuard(redis, {
    limit: config.LOGIN_IP_FAILURE_LIMIT,
    windowS: config.LOGIN_IP_FAILURE_WINDOW_S,
  });

  const cipher = createCipher(config.ENCRYPTION_KEY);
  const validateSession = async (token: string): Promise<SessionInfo | null> => {
    const payload = await identity.sessions.validate(token, 'user');
    if (payload == null) return null;
    const userId = Number(payload.sub);
    const status = await accountRead.activeUserStatus(userId);
    if (status !== USER_STATUS.ACTIVE) return null;
    return { userId, jti: payload.jti, exp: payload.exp };
  };

  const frontendUrl = config.OAUTH_FRONTEND_URL ?? 'http://localhost:3000';
  const capabilities = {
    registerEnabled: config.REGISTER_ENABLED,
    captchaSiteKey: config.CAPTCHA_SITE_KEY ?? null,
    emailCodeRequired,
  };

  const deps: ClientApiDeps = {
    protocol: {
      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      corsOrigins:
        config.CORS_ORIGINS === '' ? [] : config.CORS_ORIGINS.split(',').map((s) => s.trim()),
      corsMaxAgeSeconds: config.CLIENT_CORS_MAX_AGE_SECONDS,
      bodyLimitBytes: config.CLIENT_BODY_LIMIT_BYTES,
    },
    logger: {
      error: (obj, msg) => logger.error(obj, msg),
    },
    health: {
      pingDb: () => ping(db),
      pingRedis: async () => {
        await redis.ping();
      },
    },
    validateSession,
    auth: {
      capabilities,
      passwordPolicy: { minLength: config.CLIENT_PASSWORD_MIN_LENGTH, maxLength: 128 },
      sealer: {
        seal: (plaintext) => cipher.encrypt(plaintext),
        open: (sealed) => cipher.decrypt(sealed),
      },
      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      captcha:
        config.CAPTCHA_SECRET_KEY != null && config.CAPTCHA_SITE_KEY != null
          ? identity.captcha
          : null,
      registerLimiter: rateCounter,
      registerIpLimitPerHour: config.REGISTER_IP_LIMIT_PER_HOUR,
      registerWindowSeconds: config.REGISTER_IP_WINDOW_SECONDS,
      emailTaken: accountRead.emailTaken,
      challenges: identity.challenges,
      registerCredential: identity.credentials.register,
      provision: accounts.provisionLocalAccount,
      onboarding: accounts.completeAccountOnboarding,
      authenticate: identity.passwords.authenticate,
      changePassword: identity.passwords.change,
      resetPassword: identity.passwords.reset,
      issueResetToken: resetTokens.issue,
      consumeResetToken: resetTokens.consume,
      sendResetLink:
        mailer != null ? (to, url, ctx) => mailer.sendPasswordResetLink(to, url, ctx) : null,
      resetLinkBase: config.OAUTH_FRONTEND_URL ?? null,
      resetTokenTtlMinutes: RESET_TOKEN_TTL_MINUTES,
      guards: { emailIp: loginGuard, ip: ipGuard },
      userStatus: accountRead.activeUserStatus,
      userByEmail: accountRead.userByEmail,
      touchLastLogin: accountRead.touchLastLogin,
      sign: (userId) => identity.sessions.sign({ realm: 'user', subjectId: userId }),
      logout: async (token) => {
        await identity.sessions.logout(token, 'user');
      },
    },
    oauth: {
      providers: Object.keys(oauthProviders),
      authorize: identity.oauth.authorize,
      callback: identity.oauth.callback,
      findUser: identity.oauth.findUser,
      provision: accounts.provisionOAuthAccount,
      onboarding: async (userId) => accounts.completeAccountOnboarding({ userId }),
      userStatus: accountRead.activeUserStatus,
      sign: (userId) => identity.sessions.sign({ realm: 'user', subjectId: userId }),
      frontendUrl,
      apiBase,
      secureCookie: config.SECURE_COOKIE,
      stateTtlSeconds: config.OAUTH_STATE_TTL_SECONDS,
    },
    me: {
      profile: accounts.getProfile,
      updateDisplayName: accounts.updateDisplayName,
      walletAccounts: billing.wallet.accounts,
    },
    keys: {
      create: accounts.createKey,
      list: accounts.listKeys,
      patch: accounts.patchKey,
      rotate: accounts.rotateKey,
      revoke: accounts.revokeKey,
    },
    apps: {
      create: accounts.createApp,
      list: accounts.listApps,
      disable: accounts.disableApp,
      rotateSecret: accounts.rotateAppSecret,
    },
    orgs: {
      listMyOrgs: accounts.listMyOrgs,
      orgDetail: accounts.getOrgDetail,
      invite: accounts.inviteMember,
      revokeInvitation: accounts.revokeInvitation,
      acceptInvitation: accounts.acceptInvitation,
      patchMember: accounts.setMemberLimits,
      removeMember: accounts.removeMember,
      orgSubscriptions: subscriptionRead.orgSubscriptions,
    },
    wallet: {
      accounts: billing.wallet.accounts,
      statement: billing.wallet.statement,
    },
    redeem: {
      redeem: redemption.redeem,
      history: redemption.history,
    },
    payments: { payments },
    subscriptions: {
      api: billing.subscriptions,
      reads: subscriptionRead,
    },
    usage: usageRead,
    pricing: pricingRead,
    referrals: {
      marketingSettings: accounts.getMarketingSettings,
      overview: accounts.referralOverview,
      totalCommission: billingRead.totalCommission,
      frontendBaseUrl: frontendUrl,
    },
  };

  return { logger, otel, db, redis, identity, accounts, billing, deps };
}
