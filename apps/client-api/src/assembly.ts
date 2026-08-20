/**
 * 装配根：进程级依赖一次组装（db / Redis / wallet / 守卫 / 服务 / 路由产物）。
 * 全部可变值来自 config——本文件零字面量配置。
 *
 * REDIS_URL 未配置 = 单副本开发形态：登录爆破防护/注册限流降级关闭；
 * 配置即生产形态。wallet 白名单 fail-closed：本 app 只经手三类业务域入账
 * （gift 注册赠送 / redeem 兑换码 / topup 在线充值），对手科目只有外部世界镜像。
 */
import type { Redis } from 'ioredis';
import { createDb } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import {
  createAuthFailureGuard,
  createKeyBruteForceGuard,
  createRedisClient,
  initOtel,
} from '@ai-gateway/core';
import { createWallet, createSubscriptionDomain, type WalletApi, type SubscriptionDomain } from '@ai-gateway/service';
import { mailerFromEnv, captchaFromEnv, USER_MAIL_BRAND, createRedisSessionRevocationStore, type Mailer } from '@ai-gateway/identity';
import { createAuthService } from './services/auth.service.js';
import { createRepositories } from '@ai-gateway/repository';
import { createKeysService } from './services/keys.service.js';
import { createWalletService } from './services/wallet.service.js';
import { createRedeemService } from './services/redeem.service.js';
import { createUsageService } from './services/usage.service.js';
import { createRedisFixedWindowCounter } from './services/rate-counter.js';
import { createSubscriptionService } from './services/subscription.service.js';
import { createOrgService } from './services/org.service.js';
import { createAppsService } from './services/apps.service.js';
import { createReferralService } from './services/referral.service.js';
import { createOAuthService, createRedisStateStore } from './services/oauth.service.js';
import {
  createEpayProvider,
  createStripeProvider,
  createPaymentsService,
  type PaymentProviderPort,
} from './services/payments.service.js';
import type { ClientApiConfig } from './config.js';

export interface ClientApiAssembly {
  /** 会话 jti 吊销表（logout 即时下线） */
  revocationStore: ReturnType<typeof createRedisSessionRevocationStore>;
  wallet: WalletApi;
  subscriptions: SubscriptionDomain;
  auth: ReturnType<typeof createAuthService>;
  keys: ReturnType<typeof createKeysService>;
  walletRead: ReturnType<typeof createWalletService>;
  redeem: ReturnType<typeof createRedeemService>;
  usage: ReturnType<typeof createUsageService>;
  subscriptionService: ReturnType<typeof createSubscriptionService>;
  org: ReturnType<typeof createOrgService>;
  apps: ReturnType<typeof createAppsService>;
  referralService: ReturnType<typeof createReferralService>;
  oauth: ReturnType<typeof createOAuthService>;
  payments: ReturnType<typeof createPaymentsService>;
  /** 已配置支付渠道（空 = 在线充值关闭） */
  paymentProviders: readonly PaymentProviderPort[];
  /** 操练场代理配置（null = 未启用） */
  redis: Redis;
  otel: { shutdown(): Promise<void> };
}

/** 易支付五件套全配才启用（部分配置 = 配置错误，直接抛——fail-closed） */
function buildEpay(config: ClientApiConfig): PaymentProviderPort | null {
  if (!config.EPAY_PID && !config.EPAY_KEY && !config.EPAY_GATEWAY_URL && !config.EPAY_NOTIFY_URL && !config.EPAY_RETURN_URL) {
    return null;
  }
  if (
    !config.EPAY_PID ||
    !config.EPAY_KEY ||
    !config.EPAY_GATEWAY_URL ||
    !config.EPAY_NOTIFY_URL ||
    !config.EPAY_RETURN_URL
  ) {
    throw new Error('EPAY_* 五项须成组配置（pid/key/gateway/notify/return）');
  }
  return createEpayProvider({
    pid: config.EPAY_PID,
    key: config.EPAY_KEY,
    gatewayUrl: config.EPAY_GATEWAY_URL,
    notifyUrl: config.EPAY_NOTIFY_URL,
    returnUrl: config.EPAY_RETURN_URL,
  });
}

/** Stripe 四件套全配才启用（部分配置 = 配置错误，直接抛——fail-closed） */
function buildStripe(config: ClientApiConfig): PaymentProviderPort | null {
  const group = [
    config.STRIPE_SECRET_KEY,
    config.STRIPE_WEBHOOK_SECRET,
    config.STRIPE_SUCCESS_URL,
    config.STRIPE_CANCEL_URL,
  ];
  if (group.every((v) => !v)) return null;
  if (group.some((v) => !v)) {
    throw new Error('STRIPE_* 四项须成组配置（secretKey/webhookSecret/successUrl/cancelUrl）');
  }
  return createStripeProvider({
    secretKey: config.STRIPE_SECRET_KEY!,
    webhookSecret: config.STRIPE_WEBHOOK_SECRET!,
    successUrl: config.STRIPE_SUCCESS_URL!,
    cancelUrl: config.STRIPE_CANCEL_URL!,
    ...(config.STRIPE_API_BASE ? { apiBase: config.STRIPE_API_BASE } : {}),
  });
}

/** 端点覆盖解析（JSON：私有化网关/E2E mock 上游用；非法 JSON fail-loud） */
const parseEndpoints = (json: string | undefined, provider: string) => {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as { authorizeUrl?: string; tokenUrl?: string; profileUrl?: string; emailsUrl?: string };
  } catch {
    throw new Error(`OAUTH_${provider.toUpperCase()}_ENDPOINTS_JSON 不是合法 JSON`);
  }
};

export function assembleClientApi(
  config: ClientApiConfig,
  db: Db = createDb(config.DATABASE_URL, { poolMax: config.DB_POOL_MAX }),
  /** 测试注入（缺省 undefined = 按环境构造；null = 强制无 mailer） */
  overrides: { mailer?: Mailer | null } = {},
): ClientApiAssembly {
  // Redis 必配（首选组件：爆破防护/限流/OAuth state/缓存——启动入口已做连通性验证）
  const redis = createRedisClient(config.REDIS_URL, { serviceName: 'client-api' });

  const wallet = createWallet({
    db,
    guards: {
      // 本 app 经手的五类业务域：赠送/兑换/充值/订阅收款（收款对手 platform_revenue）/邀请返利
      refTypes: ['gift', 'redeem', 'topup', 'subscription', 'referral'],
      currencies: [config.CLIENT_CURRENCY],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: config.CLIENT_CURRENCY,
  });
  const subscriptions = createSubscriptionDomain({ db, wallet });

  const loginGuard = createKeyBruteForceGuard(redis, {
    failureThreshold: config.LOGIN_FAILURE_THRESHOLD,
    failureWindowS: config.LOGIN_FAILURE_WINDOW_S,
    lockS: config.LOGIN_LOCK_S,
  });
  const ipGuard = createAuthFailureGuard(redis, {
    limit: config.LOGIN_IP_FAILURE_LIMIT,
    windowS: config.LOGIN_IP_FAILURE_WINDOW_S,
  });
  const registerLimiter = createRedisFixedWindowCounter(redis, 'register-hour');
  const redeemLimiter = createRedisFixedWindowCounter(redis, 'redeem-min');
  const topupOrderLimiter = createRedisFixedWindowCounter(redis, 'topup-order-min');

  const mailer = overrides.mailer !== undefined ? overrides.mailer : mailerFromEnv(config, USER_MAIL_BRAND);
  const captcha = captchaFromEnv(config);
  const emailCodeRequired =
    config.EMAIL_CODE_REQUIRED === 'on'
      ? true
      : config.EMAIL_CODE_REQUIRED === 'off'
        ? false
        : mailer != null; // auto：SMTP 已配置即强制两级登录

  const referralService = createReferralService({
    db,
    wallet,
    // 营销参数 DB 化（2026-08-21）：每动作读 marketing_settings 现值——管理面改值即时生效
    signupBonus: async () => (await createRepositories().marketing.getSettings({ db, requestId: 'marketing', actor: { kind: 'system' }, traceParent: null })).referralSignupBonus,
    commissionRate: async () => (await createRepositories().marketing.getSettings({ db, requestId: 'marketing', actor: { kind: 'system' }, traceParent: null })).referralCommissionRate,
    frontendUrl: config.OAUTH_FRONTEND_URL ?? 'http://localhost:3000',
  });
  const auth = createAuthService({
    db,
    wallet,
    jwtSecret: config.JWT_SECRET,
    sessionTtlSeconds: config.SESSION_TTL_SECONDS,
    registerEnabled: config.REGISTER_ENABLED,
    giftAmount: async () => (await createRepositories().marketing.getSettings({ db, requestId: 'marketing', actor: { kind: 'system' }, traceParent: null })).signupGiftAmount,
    loginGuard,
    ipGuard,
    registerLimiter,
    registerIpLimitPerHour: config.REGISTER_IP_LIMIT_PER_HOUR,
    mailer,
    captcha,
    emailCodeRequired,
    referral: {
      apply: (ctx, inviteeId, affCode) =>
        referralService.applyReferral(ctx, { inviteeId, affCode }),
    },
  });
  const keys = createKeysService({ db });
  const walletRead = createWalletService(wallet);
  const redeem = createRedeemService({
    db,
    wallet,
    limiter: redeemLimiter,
    perMinuteLimit: config.REDEEM_PER_MINUTE_LIMIT,
  });
  const usage = createUsageService({ db });
  const subscriptionService = createSubscriptionService({ db, domain: subscriptions });
  const org = createOrgService({ db });
  const apps = createAppsService({ db });

  // OAuth：前后端基地址与凭证成组配置才可用（frontend/api 缺一 = 启动失败——半配 = 静默坏流）
  const oauthConfigured =
    config.OAUTH_GITHUB_CLIENT_ID ||
    config.OAUTH_GITHUB_CLIENT_SECRET ||
    config.OAUTH_GOOGLE_CLIENT_ID ||
    config.OAUTH_GOOGLE_CLIENT_SECRET;
  const oauthBase =
    config.OAUTH_FRONTEND_URL && config.OAUTH_API_BASE
      ? { frontendUrl: config.OAUTH_FRONTEND_URL, apiBase: config.OAUTH_API_BASE }
      : oauthConfigured
        ? (() => {
            throw new Error('OAUTH_FRONTEND_URL 与 OAUTH_API_BASE 须与 OAuth 凭证成组配置');
          })()
        : null;
  const oauth = createOAuthService({
    db,
    wallet,
    jwtSecret: config.JWT_SECRET,
    sessionTtlSeconds: config.SESSION_TTL_SECONDS,
    frontendUrl: oauthBase?.frontendUrl ?? 'http://localhost:3000',
    apiBase: oauthBase?.apiBase ?? 'http://localhost:8081',
    providers: {
      ...(config.OAUTH_GITHUB_CLIENT_ID && config.OAUTH_GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: config.OAUTH_GITHUB_CLIENT_ID,
              clientSecret: config.OAUTH_GITHUB_CLIENT_SECRET,
              ...(parseEndpoints(config.OAUTH_GITHUB_ENDPOINTS_JSON, 'github')
                ? { endpoints: parseEndpoints(config.OAUTH_GITHUB_ENDPOINTS_JSON, 'github') }
                : {}),
            },
          }
        : {}),
      ...(config.OAUTH_GOOGLE_CLIENT_ID && config.OAUTH_GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: config.OAUTH_GOOGLE_CLIENT_ID,
              clientSecret: config.OAUTH_GOOGLE_CLIENT_SECRET,
              ...(parseEndpoints(config.OAUTH_GOOGLE_ENDPOINTS_JSON, 'google')
                ? { endpoints: parseEndpoints(config.OAUTH_GOOGLE_ENDPOINTS_JSON, 'google') }
                : {}),
            },
          }
        : {}),
    },
    // state 单次存储：Redis 多副本共享；单副本开发形态用进程内存（语义不降级）
    stateStore: createRedisStateStore(redis),
    giftAmount: async () => (await createRepositories().marketing.getSettings({ db, requestId: 'marketing', actor: { kind: 'system' }, traceParent: null })).signupGiftAmount,
  });
  const epay = buildEpay(config);
  const stripe = buildStripe(config);
  const paymentProviders = [epay, stripe].filter((p): p is PaymentProviderPort => p != null);
  const payments = createPaymentsService({
    db,
    wallet,
    providers: paymentProviders,
    currency: config.CLIENT_CURRENCY,
    topupMin: config.TOPUP_MIN,
    topupMax: config.TOPUP_MAX,
    exchangeRate: config.TOPUP_EXCHANGE_RATE,
    orderTtlMs: config.PAYMENT_ORDER_TTL_MS,
    orderLimiter: topupOrderLimiter,
  });

  const otel = initOtel({
    serviceName: 'client-api',
    mode: config.OTEL_TRACES_MODE,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  // 会话 jti 吊销表（logout 即时下线；Redis 键随令牌自然过期自动清理）
  const revocationStore = createRedisSessionRevocationStore(redis, {
    logger: { warn: (obj: unknown, msg: string) => console.warn('[client-api]', msg, obj) },
  });

  return {
    revocationStore,
    wallet,
    subscriptions,
    auth,
    keys,
    walletRead,
    redeem,
    usage,
    subscriptionService,
    org,
    apps,
    referralService,
    oauth,
    payments,
    paymentProviders,
    redis,
    otel,
  };
}
