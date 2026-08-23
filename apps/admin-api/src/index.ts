import { serve } from '@hono/node-server';
import { ping } from '@tokenlens/db';
import { loadAdminApiConfig } from './config';
import { assembleAdminApi } from './assembly';
import { createAdminApp } from './app';
import { createAdminShutdown } from './shutdown';

/**
 * 管理控制面入口：config → assembly → app → serve → 信号接线（三段式,不自行拼装依赖）。
 * 部署：单副本低流量管理面;P2 登录波起 Redis 必配。
 */

const config = loadAdminApiConfig();
const assembly = assembleAdminApi(config);
// ping 绑定在进程装配面:app.ts 不接触 Db 类型(P5:非装配代码只持闭包与纯契约)
const app = createAdminApp({
  pingDb: () => ping(assembly.db),
  logger: assembly.logger,
  sessions: assembly.identity.sessions,
  accounts: assembly.accounts,
  wallet: assembly.billing.wallet,
  // 调账/赠送幂等用例:billing operations(store 装配件在 assembly 域内)
  operations: assembly.operations,
  // writeAudit 桥:operations 事务句柄 → observability 同事务审计原语
  writeAudit: assembly.writeAuditInTx,
  subscriptions: assembly.billing.subscriptions,
  controlPlane: assembly.controlPlane,
  observability: assembly.observability,
  corsOrigins: config.corsOrigins,
  bodyLimitBytes: config.bodyLimitBytes,
  now: () => new Date(),
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  assembly.logger.info(
    {
      port: info.port,
      auth: 'admin-session',
      cors: config.corsOrigins.length > 0 ? 'allowlist' : 'none',
    },
    'admin-api ready',
  );
});

const shutdown = createAdminShutdown({
  server,
  otel: assembly.otel,
  db: assembly.db,
  graceMs: config.shutdownGraceMs,
  logger: assembly.logger,
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
