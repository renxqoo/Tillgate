/**
 * admin-api 启动入口（仅 bootstrap，无业务逻辑）：
 * 加载环境 → 基础设施验证（DB/Redis fail-closed：连不上拒绝启动）
 * → 建连 → 装配 → createApp → serve → 配置快照 → 优雅停机。
 */
import { serve } from '@hono/node-server';
import { createDb } from '@ai-gateway/db';
import { assertRedisReachable, createRedisClient } from '@ai-gateway/core';
import { loadConfig } from './config.js';
import { assembleAdminApi } from './assembly.js';
import { createApp } from './app.js';
import { createShutdown } from './shutdown.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL, { poolMax: config.DB_POOL_MAX });
const startupRedis = createRedisClient(config.REDIS_URL, { serviceName: 'admin-api' });
await assertRedisReachable(startupRedis, 'admin-api', config.REDIS_URL);
await startupRedis.quit().catch(() => {});
const assembly = assembleAdminApi(config, db);
const app = createApp({
  db,
  assembly,
  jwtSecret: config.ADMIN_JWT_SECRET,
  corsOrigins: config.CORS_ORIGINS ? config.CORS_ORIGINS.split(',').map((s) => s.trim()) : [],
  bodyLimitBytes: config.BODY_LIMIT_BYTES,
  trustedProxyHops: config.TRUSTED_PROXY_HOPS,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[admin-api] listening on :${info.port}`);
  // 配置快照：关键业务参数生效值一处可查（排查「以为配了其实默认」类问题）
  console.log(`[admin-api] config snapshot: ${JSON.stringify({
      currency: config.ADMIN_CURRENCY,
      allowLocalUpstream: config.ALLOW_LOCAL_UPSTREAM,
      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      otel: config.OTEL_TRACES_MODE,
  })}`);
});

const shutdown = createShutdown({
  server,
  otel: assembly.otel,
  redis: assembly.redis,
  db,
  graceMs: config.ADMIN_SHUTDOWN_GRACE_MS,
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
