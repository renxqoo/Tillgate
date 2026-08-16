import { serve } from '@hono/node-server';
import { loadClientApiEnv, createLogger, initOtel } from '@ai-gateway/core';
import { mailerFromEnv, captchaFromEnv, USER_MAIL_BRAND } from '@ai-gateway/identity';
import { createDb } from '@ai-gateway/db';
import { createLedger } from '@ai-gateway/ledger';
import { balanceCache, createRedis, recordAudit } from '@ai-gateway/http';
import { createApp } from './app.js';

/**
 * client-api 启动入口（仅 bootstrap，无业务逻辑）：
 * 加载环境 → 初始化可观测性 → 组装依赖（db/redis/ledger）→ createApp → serve。
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
const ledger = createLedger({
  db,
  effects: {
    balanceChanged: async ({ userId }) => {
      await redis.del(balanceCache(userId)).catch(() => {});
    },
    // client-api 触发的资金变动均为用户自助行为（兑换/首登赠额），actor 记 user
    audit: async (event) => recordAudit(db, { ...event, actor: 'user', adminId: null }),
  },
});

const app = createApp({
  db,
  redis,
  ledger,
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
  },
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'client-api listening (internal only)');
});
