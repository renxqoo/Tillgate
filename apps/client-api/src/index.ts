/**
 * client-api 启动入口（仅 bootstrap，无业务逻辑）：
 * 加载环境 → 装配（内部完成 DB 建连与 Redis fail-closed 连通性验证）→
 * createApp → serve → 配置快照 → 优雅停机。
 */
import { serve } from '@hono/node-server';
import { loadClientApiConfig } from './config.js';
import { assembleClientApi } from './assembly.js';
import { createClientApiApp } from './app.js';
import { createClientShutdown } from './shutdown.js';

const config = loadClientApiConfig();
const { logger, otel, db, redis, deps } = await assembleClientApi(config);
const app = createClientApiApp(deps);

const server = serve({ fetch: app.fetch, port: config.CLIENT_API_PORT }, (info) => {
  logger.info({ port: info.port }, 'client-api listening');
  // 配置快照：关键业务参数生效值一处可查（排查「以为配了其实默认」类问题）
  logger.info(
    {
      registerEnabled: config.REGISTER_ENABLED,
      emailCodeRequired: config.EMAIL_CODE_REQUIRED,
      topup: `${config.TOPUP_MIN}~${config.TOPUP_MAX} @${config.TOPUP_EXCHANGE_RATE}`,
      // 支付渠道已迁 integration_settings（动态面经 /v1/payments/channels 报真相）
      // oauth 凭据已迁 integration_settings（快照驱动）;启动日志只报静态面

      trustedProxyHops: config.TRUSTED_PROXY_HOPS,
      secureCookie: config.SECURE_COOKIE,
      otel: config.OTEL_TRACES_MODE,
    },
    'client-api config snapshot',
  );
});

const shutdown = createClientShutdown({
  serviceName: 'client-api',
  server,
  otel,
  redis,
  db: { end: () => db.$client.end() },
  graceMs: config.CLIENT_SHUTDOWN_GRACE_MS,
  logger,
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
