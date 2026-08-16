import { serve } from '@hono/node-server';
import { loadAdminApiEnv, createLogger, initOtel } from '@ai-gateway/core';
import { createDb } from '@ai-gateway/db';
import { createBillingOperations, createLedger } from '@ai-gateway/ledger';
import { balanceCache, createRedis, recordAudit } from '@ai-gateway/http';
import { createApp } from './app.js';
import { mailerFromEnv, ADMIN_MAIL_BRAND } from '@ai-gateway/identity';
import { createLocalVoucherStorage } from './services/voucher-storage.js';

/**
 * admin-api 启动入口（仅 bootstrap，无业务逻辑）：
 * 加载环境 → 初始化可观测性 → 组装依赖（db/redis/ledger）→ createApp → serve。
 */

const env = loadAdminApiEnv();
const logger = createLogger({ level: env.LOG_LEVEL, serviceName: 'admin-api' });
initOtel({
  serviceName: 'admin-api',
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
    audit: async (event) => recordAudit(db, { ...event, actor: event.actor ?? 'admin' }),
  },
});
const billingOperations = createBillingOperations({ db });

const app = createApp({
  db,
  redis,
  ledger,
  billingOperations,
  encryptionKey: env.ENCRYPTION_KEY,
  encryptionKeyOld: env.ENCRYPTION_KEY_OLD,
  mailer: mailerFromEnv(env, ADMIN_MAIL_BRAND),
  logger,
  config: {
    adminJwtSecret: env.ADMIN_JWT_SECRET,
    secureCookie: env.NODE_ENV === 'production',
    trustedOrigins: env.CSRF_TRUSTED_ORIGINS,
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
    internalApiToken: env.INTERNAL_API_TOKEN,
    voucherStorageDir: env.VOUCHER_STORAGE_DIR,
    allowLocalUpstream: env.ALLOW_LOCAL_UPSTREAM,
    voucherMaxBytes: env.VOUCHER_MAX_BYTES,
  },
  voucherStorage: createLocalVoucherStorage(env.VOUCHER_STORAGE_DIR),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'admin-api listening (internal only)');
});
