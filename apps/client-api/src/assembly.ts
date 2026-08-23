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
import { createDb, ping, type Db, type TxRetryPolicy } from '@tokenlens/db';
import {
  assertRedisReachable,
  createAuthFailureGuard,
  createCipher,
  createKeyBruteForceGuard,
  createLogger,
  createRedisClient,
  type Logger,
} from '@tokenlens/runtime';
import { initOtel, type OtelHandle } from '@tokenlens/observability';
import { createIdentity, type Identity, type OAuthEndpointsOverride, type OAuthProviderCredentials } from '@tokenlens/identity';
import {
  createAccounts,
  USER_STATUS,
  type AccountUseCases,
} from '@tokenlens/accounts';
import { createPgFundingSourceResolver } from '@tokenlens/accounts/composition';
import {
  createBilling,
  createPaymentsApi,
  createRedemptionApi,
  type Billing,
  type PaymentsApi,
  type RedemptionApi,
} from '@tokenlens/billing';
import {
  createPostgresBillingStore,
  createPostgresPaymentOrderStore,
  createPostgresRedeemCodeStore,
  createPostgresWalletStore,
  createEpayProvider,
  createStripeProvider,
} from '@tokenlens/billing/composition';
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
import { createRedisSessionRevocation } from './adapters/redis-session-revocation.js';
import { createRedisOAuthStateStore } from './adapters/redis-oauth-state.js';
import { createSmtpLoginMailer } from './adapters/smtp-login-mailer.js';
import { createTurnstileCaptcha } from './adapters/turnstile-captcha.js';

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

/** 端点覆盖解析（JSON 已在 config 预校验；此处仅反序列化） */
function parseEndpoints(json: string | undefined): OAuthEndpointsOverride | undefined {
  if (!json) return undefined;
  return JSON.parse(json) as OAuthEndpointsOverride;
}

/** 存储时钟单点（identity/accounts/billing 同源注入） */
const clock = (): Date => new Date();

export async function assembleClientApi(config: ClientApiConfig): Promise<ClientApiAssembly> {
  const production = process.env.NODE_ENV === 'production';
  const logger = createLogger({
    level: config.LOG_LEVEL,
    serviceName: 'client-api',
    pretty: !production,
  });
  const otel = initOtel({
    serviceName: 'client-api',
    serviceVersion: '0.1.0',
    mode: config.OTEL_TRACES_MODE,
    ...(config.OTEL_EXPORTER_OTLP_ENDPOINT != null
      ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT, metricsExportIntervalMs: config.OTEL_METRICS_INTERVAL_MS }
      : {}),
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
          logThrottleMs: 60_000,
          log: (message) => logger.warn({ message }, 'client-api redis'),
          sentinels: config.REDIS_SENTINELS,
          sentinelName: config.REDIS_SENTINEL_NAME as string,
          ...(config.REDIS_SENTINEL_PASSWORD != null
            ? { sentinelPassword: config.REDIS_SENTINEL_PASSWORD }
            : {}),
        }
      : {
          serviceName: 'client-api',
          logThrottleMs: 60_000,
          log: (message) => logger.warn({ message }, 'client-api redis'),
        },
  );
  // Redis 必配（爆破防护/限流/OAuth state/定价缓存——fail-closed：连不上拒绝启动）
  await assertRedisReachable(redis, 'client-api', config.REDIS_URL, 5_000);

  const txRetry: TxRetryPolicy = {
    maxAttempts: config.CLIENT_TX_MAX_ATTEMPTS,
    baseDelayMs: config.CLIENT_TX_BASE_DELAY_MS,
    maxJitterMs: config.CLIENT_TX_MAX_JITTER_MS,
  };

  // ---- identity（凭据/挑战/会话/OAuth/吊销） ----
  const oauthProviders: Record<string, OAuthProviderCredentials> = {};
  if (config.OAUTH_GITHUB_CLIENT_ID != null && config.OAUTH_GITHUB_CLIENT_SECRET != null) {
    const endpoints = parseEndpoints(config.OAUTH_GITHUB_ENDPOINTS_JSON);
    oauthProviders.github = {
      clientId: config.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: config.OAUTH_GITHUB_CLIENT_SECRET,
      ...(endpoints != null ? { endpoints } : {}),
    };
  }
  if (config.OAUTH_GOOGLE_CLIENT_ID != null && config.OAUTH_GOOGLE_CLIENT_SECRET != null) {
    const endpoints = parseEndpoints(config.OAUTH_GOOGLE_ENDPOINTS_JSON);
    oauthProviders.google = {
      clientId: config.OAUTH_GOOGLE_CLIENT_ID,
      clientSecret: config.OAUTH_GOOGLE_CLIENT_SECRET,
      ...(endpoints != null ? { endpoints } : {}),
    };
  }
  const smtpReady =
    config.SMTP_HOST != null && config.SMTP_USER != null && config.SMTP_PASS != null;
  // 用户面邮件品牌（展示常量——非部署可变值）
  const mailBrand = { brand: 'TokenLens 控制台', brandEn: 'TokenLens Console', brandSub: 'TOKENLENS · CONSOLE' };
  const mailer = smtpReady
    ? createSmtpLoginMailer(
        {
          host: config.SMTP_HOST as string,
          port: config.SMTP_PORT,
          user: config.SMTP_USER as string,
          pass: config.SMTP_PASS as string,
          from: config.SMTP_FROM ?? (config.SMTP_USER as string),
        },
        mailBrand,
        {
          ttlMinutes: Math.ceil(config.CLIENT_CHALLENGE_TTL_MS / 60_000),
          maxAttempts: config.CLIENT_CHALLENGE_MAX_ATTEMPTS,
        },
        clock,
      )
    : null;
  const emailCodeRequired =
    config.EMAIL_CODE_REQUIRED === 'on'
      ? true
      : config.EMAIL_CODE_REQUIRED === 'off'
        ? false
        : mailer != null; // auto：SMTP 已配置即强制两级登录（v1 口径）

  const sessionRevocation = createRedisSessionRevocation(redis);
  const oauthStateStore = createRedisOAuthStateStore(redis);
  const apiBase = config.OAUTH_API_BASE ?? 'http://localhost:8081';
  const identity = createIdentity({
    db,
    txRetry,
    clock: { now: clock },
    logger: { warn: (obj, msg) => logger.warn(obj as object, msg) },
    config: {
      identifiers: ['email'],
      providers: Object.keys(oauthProviders),
      challengeKinds: ['email_code'],
      realms: ['user'],
      passwordPolicy: { minLength: config.CLIENT_PASSWORD_MIN_LENGTH, maxLength: 128 },
      challenge: {
        digits: 6,
        ttlMs: config.CLIENT_CHALLENGE_TTL_MS,
        cooldownMs: config.CLIENT_CHALLENGE_COOLDOWN_MS,
        maxAttempts: config.CLIENT_CHALLENGE_MAX_ATTEMPTS,
      },
      codePepper: config.CLIENT_CODE_PEPPER,
      // TOTP 词表必填项（用户面暂不开放 MFA 端点——identity 配置契约）
      totp: { issuer: config.CLIENT_TOTP_ISSUER, stepSec: 30, windowSteps: 1, recoveryCount: 8 },
      sessions: {
        user: { issuer: 'tokenlens:user', secret: config.JWT_SECRET, ttlSec: config.SESSION_TTL_SECONDS },
      },
      oauth: oauthProviders,
      oauthStateTtlSec: config.OAUTH_STATE_TTL_SECONDS,
      // 回调地址精确白名单（identity assertRedirectAllowed 消费；两 provider 常驻）
      oauthRedirectAllowlist: [
        `${apiBase}/v1/oauth/github/callback`,
        `${apiBase}/v1/oauth/google/callback`,
      ],
    },
    ...(mailer != null ? { mailer } : {}),
    ...(config.CAPTCHA_SECRET_KEY != null
      ? { captcha: createTurnstileCaptcha({ secretKey: config.CAPTCHA_SECRET_KEY, verifyUrl: config.CAPTCHA_VERIFY_URL }) }
      : {}),
    sessionRevocation,
    oauthStateStore,
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
      onError: (error, context) => logger.error({ err: String(error), context }, 'settlement error'),
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
  const pricingRead = createPricingRead(db, redis, { cacheTtlMs: config.PRICING_CACHE_TTL_MS });
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
      emailTaken: accountRead.emailTaken,
      challenges: identity.challenges,
      registerCredential: identity.credentials.register,
      provision: accounts.provisionLocalAccount,
      onboarding: accounts.completeAccountOnboarding,
      authenticate: identity.passwords.authenticate,
      changePassword: identity.passwords.change,
      guards: { emailIp: loginGuard, ip: ipGuard },
      userStatus: accountRead.activeUserStatus,
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
