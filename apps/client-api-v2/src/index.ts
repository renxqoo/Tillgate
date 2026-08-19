/**
 * client-api-v2 启动入口（仅 bootstrap，无业务逻辑）：
 * 加载环境 → 基础设施验证（DB/Redis fail-closed：连不上拒绝启动）
 * → 建连 → 装配 → createApp → serve → 配置快照 → 优雅停机。
 */
import { serve } from '@hono/node-server';
import { createDb } from '@ai-gateway/db';
import { assertRedisReachable, createRedisClient } from '@ai-gateway/core';
import { loadConfig } from './config.js';
import { assembleClientApi } from './assembly.js';
import { createApp } from './app.js';
import { createShutdown } from './shutdown.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL, { poolMax: config.DB_POOL_MAX });
const startupRedis = createRedisClient(config.REDIS_URL, { serviceName: 'client-api-v2' });
await assertRedisReachable(startupRedis, 'client-api-v2', config.REDIS_URL);
await startupRedis.quit().catch(() => {});
const assembly = assembleClientApi(config, db);
const app = createApp({
    revocationStore: assembly.revocationStore,
  db,
  assembly,
  jwtSecret: config.JWT_SECRET,
  trustedProxyHops: config.TRUSTED_PROXY_HOPS,
  corsOrigins: config.CORS_ORIGINS ? config.CORS_ORIGINS.split(',').map((s) => s.trim()) : [],
  bodyLimitBytes: config.BODY_LIMIT_BYTES,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[client-api-v2] listening on :${info.port}`);
  // 配置快照：关键业务参数生效值一处可查（排查「以为配了其实默认」类问题）
  console.log(
    `[client-api-v2] config snapshot: ${JSON.stringify({
      registerEnabled: config.REGISTER_ENABLED,
      emailCodeRequired: config.EMAIL_CODE_REQUIRED,
      giftAmount: config.GIFT_AMOUNT,
      topup: `${config.TOPUP_MIN}~${config.TOPUP_MAX} @${config.TOPUP_EXCHANGE_RATE}`,
      payments: { epay: config.EPAY_PID != null, stripe: config.STRIPE_SECRET_KEY != null },
      referral: { signupBonus: config.REFERRAL_SIGNUP_BONUS, commissionRate: config.REFERRAL_COMMISSION_RATE },
      oauth: { github: config.OAUTH_GITHUB_CLIENT_ID != null, google: config.OAUTH_GOOGLE_CLIENT_ID != null },
      maxKeysPerUser: config.MAX_KEYS_PER_USER,
      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      secureCookie: config.SECURE_COOKIE,
      otel: config.OTEL_TRACES_MODE,
    })}`,
  );
});

const shutdown = createShutdown({
  server,
  otel: assembly.otel,
  redis: assembly.redis,
  db,
  graceMs: config.CLIENT_SHUTDOWN_GRACE_MS,
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
