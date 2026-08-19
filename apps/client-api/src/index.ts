import { serve } from '@hono/node-server';
import { loadClientApiEnv, createLogger, initOtel } from '@ai-gateway/core';
import { mailerFromEnv, captchaFromEnv, USER_MAIL_BRAND } from '@ai-gateway/identity';
import { createDb } from '@ai-gateway/db';
import { createWallet } from '@ai-gateway/wallet';
import { createRedis } from '@ai-gateway/http';
import { createApp } from './app.js';

/**
 * client-api 启动入口（仅 bootstrap，无业务逻辑）：
 * 加载环境 → 初始化可观测性 → 组装依赖（db/redis/wallet）→ createApp → serve。
 */

const env = loadClientApiEnv();
const logger = createLogger({ level: env.LOG_LEVEL, serviceName: 'client-api' });
initOtel({
  serviceName: 'client-api',
  mode: env.OTEL_TRACES_MODE,
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  logger,
});

const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
// S7：资金事实在 wallet（client-api 资金动词域：订阅/兑换/支付/营销）
const wallet = createWallet(db, {
  accounts: [],
  refTypes: ['subscription', 'pack', 'redeem', 'payment', 'promo'],
  currencies: ['CNY'],
});

const app = createApp({
  db,
  redis,
  wallet,
  logger,
  mailer: mailerFromEnv(env, USER_MAIL_BRAND),
  captcha: captchaFromEnv(env),
  config: {
    oauth: {
      frontendUrl: env.OAUTH_FRONTEND_URL,
      apiBase: env.OAUTH_API_BASE,
      github:
        env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET
          ? { clientId: env.OAUTH_GITHUB_CLIENT_ID, clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET }
          : null,
      google:
        env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET
          ? { clientId: env.OAUTH_GOOGLE_CLIENT_ID, clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET }
          : null,
    },
    jwtSecret: env.JWT_SECRET,
    secureCookie: env.NODE_ENV === 'production',
    giftAmount: env.GIFT_AMOUNT,
    trustedOrigins: env.CSRF_TRUSTED_ORIGINS,
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
    internalApiToken: env.INTERNAL_API_TOKEN,
    registerEnabled: env.REGISTER_ENABLED,
    referralSignupBonus: env.REFERRAL_SIGNUP_BONUS,
    playground:
      env.GATEWAY_URL && env.GATEWAY_JWT_SECRET
        ? { gatewayUrl: env.GATEWAY_URL, gatewayJwtSecret: env.GATEWAY_JWT_SECRET }
        : null,
    referralCommissionRate: env.REFERRAL_COMMISSION_RATE,
    payments: {
      // 渠道成组配置才启用（半配置 = 渠道关闭并告警，不静默半启用）
      epay:
        env.EPAY_PID && env.EPAY_KEY && env.EPAY_GATEWAY_URL && env.CLIENT_PUBLIC_ORIGIN
          ? {
              pid: env.EPAY_PID,
              key: env.EPAY_KEY,
              gatewayUrl: env.EPAY_GATEWAY_URL,
              notifyUrl: `${env.CLIENT_PUBLIC_ORIGIN}/api/public/payments/epay/notify`,
              returnUrl: `${env.CLIENT_PUBLIC_ORIGIN}/dashboard/billing`,
            }
          : null,
      stripe:
        env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.CLIENT_PUBLIC_ORIGIN
          ? {
              secretKey: env.STRIPE_SECRET_KEY,
              webhookSecret: env.STRIPE_WEBHOOK_SECRET,
              webhookUrl: `${env.CLIENT_PUBLIC_ORIGIN}/api/public/payments/stripe/webhook`,
              successUrl: `${env.CLIENT_PUBLIC_ORIGIN}/dashboard/billing?paid=1`,
              cancelUrl: `${env.CLIENT_PUBLIC_ORIGIN}/dashboard/billing?canceled=1`,
            }
          : null,
    },
  },
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'client-api listening (internal only)');
});
