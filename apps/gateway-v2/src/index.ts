/**
 * 服务入口：基础设施验证（Redis fail-closed：连不上拒绝启动）→ 装配 → 监听
 * → 配置快照 → 优雅停机（部署参数全来自 config）。
 * SIGTERM/SIGINT：停收新请求（server.close）→ 等待在途完成（宽限上界）→
 * OTel flush → Redis/DB 连接收口。宽限耗尽强制退出（K8s 会再发 SIGKILL）。
 */
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { assertRedisReachable } from '@ai-gateway/core';
import { assembleGateway } from './assembly.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createShutdown } from './shutdown.js';

const config = loadConfig();
const assembly = assembleGateway(config);
await assertRedisReachable(assembly.redis, 'gateway-v2', config.REDIS_URL);
const app = createApp({
  db: assembly.db,
  runChat: assembly.runChat,
  submitGeneration: assembly.submitGeneration,
  authGuards: assembly.authGuards,
  redisProbe: assembly.redis,
  oauth: assembly.oauth,
});

const server: ServerType = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(`[gateway-v2] listening on :${port}`);
  // 配置快照：关键业务参数生效值一处可查（排查「以为配了其实默认」类问题）
  console.log(
    `[gateway-v2] config snapshot: ${JSON.stringify({
      currency: config.GATEWAY_CURRENCY,
      freeModelDailyLimit: config.FREE_MODEL_DAILY_LIMIT,
      reservationMax: config.BILLING_RESERVATION_MAX,
      authTtlMs: config.BILLING_AUTHORIZATION_TTL_MS,
      admission: { maxPending: config.ADMISSION_MAX_PENDING, maxOldestMs: config.ADMISSION_MAX_OLDEST_MS },
      authGuards: { keyThreshold: config.AUTH_KEY_FAILURE_THRESHOLD, ipLimit: config.AUTH_IP_FAILURE_LIMIT },
      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      allowLocalUpstream: config.GATEWAY_AI_ALLOW_LOCAL_URL,
      otel: config.OTEL_TRACES_MODE,
    })}`,
  );
});

const shutdown = createShutdown({
  server,
  otel: assembly.otel,
  redis: assembly.redis,
  db: assembly.db,
  closeables: [assembly.settleWakeup],
  graceMs: config.GATEWAY_SHUTDOWN_GRACE_MS,
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
