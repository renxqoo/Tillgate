/**
 * 进程入口：load config → assemble → Redis 连通性 fail-closed → app → serve →
 * 信号注册（v1 index.ts 迁移；停机编排归 shutdown.ts + runtime）。
 * 配置快照日志：排查「以为配了其实默认」——密钥类只打长度不打值。
 */
import { serve } from '@hono/node-server';
import { assertRedisReachable } from '@tokenlens/runtime';
import { loadGatewayConfig } from './config';
import { assembleGateway } from './assembly';
import { createGatewayApp } from './app';
import { createGatewayShutdown } from './shutdown';

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const assembly = assembleGateway(config);
  const logger = assembly.logger;

  // Redis fail-closed：熔断/限流/爆破共享存储连不上拒绝启动（v1 语义）
  await assertRedisReachable(assembly.redis, 'gateway', config.redisUrl, 5_000);

  const app = createGatewayApp({
    inference: assembly.inference,
    reader: {
      resolveKeyByHash: (keyHash) => assembly.accounts.resolveKeyByHash(keyHash),
      resolveApp: (appId) => assembly.accounts.resolveApp(appId),
    },
    verifyAppClient: (input) => assembly.accounts.verifyAppClient(input),
    models: assembly.modelsReader,
    requestLogs: assembly.requestLogs,
    pingDb: assembly.pingDb,
    redisProbe: assembly.redis,
    authGuards: assembly.authGuards,
    oauth: {
      jwtSecret: config.oauth.jwtSecret,
      issuer: config.oauth.issuer,
      audience: config.oauth.audience,
      keyPrefix: config.keyPrefix,
      tokenTtlSeconds: config.oauth.tokenTtlSeconds,
    },
    rateLimit: assembly.rateLimit,
    oauthIpGuard: assembly.authGuards.ipGuard,
    corsOrigins: config.corsOrigins,
    bodyLimitBytes: config.bodyLimitBytes,
    uploadLimits: {
      imageMime: config.uploadLimits.imageMime,
      audioMime: config.uploadLimits.audioMime,
      maxFileBytes: config.uploadLimits.maxFileBytes,
    },
    trustedProxyHops: config.trustedProxyHops,
    logger,
  });

  const server = serve({ fetch: app.fetch, port: config.port }, () => {
    logger.info(
      {
        port: config.port,
        env: config.nodeEnv,
        currency: config.currency,
        reservationMode: config.reservationPolicy.mode,
        globalRpm: config.globalRpm,
        otel: config.otel.mode,
        upstreamDeadlineMs: config.upstreamDeadlineMs,
        bodyLimitBytes: config.bodyLimitBytes,
      },
      'gateway listening',
    );
  });

  const shutdown = createGatewayShutdown({
    server,
    otel: assembly.otel,
    redis: assembly.redis,
    closeDb: assembly.closeDb,
    inference: assembly.inference,
    settleWake: assembly.settleWake,
    graceMs: config.shutdownGraceMs,
    logger,
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[gateway] startup failed:', error);
  process.exit(1);
});
