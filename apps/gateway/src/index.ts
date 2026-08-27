/**
 * 进程入口：load config → assemble → Redis 连通性 fail-closed → app → serve →
 * 信号注册（停机编排归 shutdown.ts + runtime）。
 * 配置快照日志：排查「以为配了其实默认」——密钥类只打长度不打值。
 */
import { serveApp } from '@tillgate/http';
import { assertRedisReachable } from '@tillgate/runtime';
import { loadGatewayConfig } from './config';
import type { GatewayConfig } from './config';
import { assembleGateway } from './assembly';
import type { GatewayAssembly } from './assembly';
import { createGatewayApp } from './app';
import type { GatewayAppDeps } from './app';
import { gatewayDbBudget } from './db-budget.js';
import { ServerDrainAbort } from '@tillgate/ai';
import { createGatewayShutdown } from './shutdown';

/** app 依赖组装（assembly + config → createGatewayApp 入参——纯字段搬运） */
function toAppDeps(assembly: GatewayAssembly, config: GatewayConfig): GatewayAppDeps {
  return {
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
    outputCap: {
      defaultMax: config.output.defaultMaxOutputTokens,
      exposureCap: config.output.exposureCap,
    },
    oauthIpGuard: assembly.authGuards.ipGuard,
    corsOrigins: config.corsOrigins,
    bodyLimitBytes: config.bodyLimitBytes,
    uploadLimits: {
      imageMime: config.uploadLimits.imageMime,
      audioMime: config.uploadLimits.audioMime,
      maxFileBytes: config.uploadLimits.maxFileBytes,
    },
    trustedProxyHops: config.trustedProxyHops,
    // DB 并发预算门:钳制业务并发在池内(推导见 src/db-budget.ts——绝不越池,
    // 万级并发下任何形态都须入口排队,node 池队列塌陷 / Bun SQL 排队楔死)
    dbBudget: gatewayDbBudget(config.dbPoolMax),
    logger: assembly.logger,
  };
}

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const assembly = assembleGateway(config);
  const { logger } = assembly;

  // Redis fail-closed：熔断/限流/爆破共享存储连不上拒绝启动
  await assertRedisReachable(assembly.redis, 'gateway', config.redisUrl, 5_000);

  // 服务端 drain 控制器：宽限耗尽时以 ServerDrainAbort abort 在途请求预算——
  // 终态归类 server_draining（全额释放）而非 request_cancelled（估算结算）
  const drainController = new AbortController();
  const app = createGatewayApp({
    ...toAppDeps(assembly, config),
    drainSignal: drainController.signal,
  });

  const server = serveApp(app, { port: config.port }, () => {
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
    // 宽限耗尽 → abort 在途请求（server_draining 分类 + 信号结算收尾窗）
    drain: {
      abort: () => drainController.abort(new ServerDrainAbort()),
      finalizeMs: config.drainFinalizeMs,
    },
    logger,
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[gateway] startup failed:', error);
  process.exit(1);
});
