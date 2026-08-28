/**
 * 装配根：进程级依赖一次组装（db / Redis / 能力包 facade / 守卫 / 读面 / 路由产物）。
 * 全部可变值来自 config——本文件零字面量配置（领域常量除外并注明）。
 * 唯一 ./composition 消费点（adapters 亦白名单——架构测试执行）。
 *
 * wallet 白名单 fail-closed：本 app 只经手五类业务域入账（gift 注册赠送 / redeem
 * 兑换 / topup 充值 / subscription 订阅收款 / referral 返利），对手科目只有外部
 * 世界与平台收入镜像。跨能力 bridge（walletCredit / sessionInvalidation）
 * 不共享事务——赠送/归因本就是 best-effort 段。
 */
import { suggestDbBudget } from '@tillgate/http';
import { createDb, ping, type Db, type TxRetryPolicy } from '@tillgate/db';
import { bootIntegrationReader } from './adapters/integration-reader.js';
import { createClientPayments } from './adapters/payment-providers.js';
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
  createRedemptionApi,
  type Billing,
  type PaymentsApi,
  type RedemptionApi,
} from '@tillgate/billing';
import {
  createPostgresBillingStore,
  createPostgresRedeemCodeStore,
  createPostgresWalletStore,
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
import { captchaSiteKeyOf } from './adapters/dynamic-captcha.js';
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

// eslint-disable-next-line max-lines-per-function, complexity -- 装配根 composition root:线性依赖组装,拆段只会层层透传上下文
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

  // ---- 集成动态配置 reader + OAuth 基地址 boot 解析（adapters/integration-reader.ts） ----
  const cipher = createCipher(config.ENCRYPTION_KEY);
  const {
    reader,
    apiBase: bootApiBase,
    frontendUrl: bootFrontendUrl,
    frontendUrlConfigured,
  } = await bootIntegrationReader({
    db,
    encryptionKey: config.ENCRYPTION_KEY,
    logger,
    oauthBase: { apiBase: config.OAUTH_API_BASE, frontendUrl: config.OAUTH_FRONTEND_URL },
  });

  // ---- identity（凭据/挑战/会话/OAuth/吊销——动态装配在 adapters/identity-stack.ts） ----
  const {
    identity,
    mailer,
    resetTokens,
    emailCodeRequired,
    oauthProviderNames,
    apiBase,
    frontendUrl,
  } = createIdentityStack({
    config,
    db,
    redis,
    txRetry,
    logger,
    clock,
    reader,
    apiBase: bootApiBase,
    frontendUrl: bootFrontendUrl ?? 'http://localhost:3000',
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
  const payments: PaymentsApi = createClientPayments({
    config,
    db,
    reader,
    store: billingStore,
    wallet: billing.wallet,
    orderLimiter: rateCounter,
    logger,
    clock,
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
      // （best-effort 段，失败可按 refKey 补发）
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
      // 跨能力 bridge：会话吊销线归 identity（唯一所有者）
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

  const validateSession = async (token: string): Promise<SessionInfo | null> => {
    const payload = await identity.sessions.validate(token, 'user');
    if (payload == null) return null;
    const userId = Number(payload.sub);
    const status = await accountRead.activeUserStatus(userId);
    if (status !== USER_STATUS.ACTIVE) return null;
    return { userId, jti: payload.jti, exp: payload.exp };
  };

  // capabilities 每请求求值（快照驱动的 UX 面）
  // captchaSiteKey 按 effective（停用 = siteKey null——注册闸门随之关闭）；
  // 计算真源在 dynamic-captcha.captchaSiteKeyOf（测试锁真源防表达式漂移）
  const captchaSiteKey = (): string | null => captchaSiteKeyOf(reader.latest().captcha);
  const capabilities = () => ({
    registerEnabled: config.REGISTER_ENABLED,
    captchaSiteKey: captchaSiteKey(),
    emailCodeRequired: emailCodeRequired(),
  });

  const deps: ClientApiDeps = {
    protocol: {
      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      corsOrigins:
        config.CORS_ORIGINS === '' ? [] : config.CORS_ORIGINS.split(',').map((s) => s.trim()),
      corsMaxAgeSeconds: config.CLIENT_CORS_MAX_AGE_SECONDS,
      bodyLimitBytes: config.CLIENT_BODY_LIMIT_BYTES,
    },
    // DB 并发预算门:公网 ingress 入口排队(余量 2 给探针旁路;无 fire-and-forget 写入面)
    dbBudget: suggestDbBudget(config.DB_POOL_MAX, 2),
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
      smtpReady: () => reader.latest().smtp.effective,
      passwordPolicy: { minLength: config.CLIENT_PASSWORD_MIN_LENGTH, maxLength: 128 },
      sealer: {
        seal: (plaintext) => cipher.encrypt(plaintext),
        open: (sealed) => cipher.decrypt(sealed),
      },
      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      captcha: identity.captcha,
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
      // 显式配置才作为找回链接基地址（缺省回落值不算）
      resetLinkBase: frontendUrlConfigured ? frontendUrl : null,
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
      providers: oauthProviderNames,
      authorize: identity.oauth.authorize,
      callback: identity.oauth.callback,
      findUser: identity.oauth.findUser,
      provision: accounts.provisionOAuthAccount,
      onboarding: async (userId) => accounts.completeAccountOnboarding({ userId }),
      userStatus: accountRead.activeUserStatus,
      touchLastLogin: accountRead.touchLastLogin,
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
    payments: {
      refreshIntegrationSnapshot: async () => {
        await reader.refresh();
      },
      payments,
    },
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
