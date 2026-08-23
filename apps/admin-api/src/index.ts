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
  // P2:会话验证 + 属主回查（admins 行存在且 status=0——封禁/注销即刻失效,D8/W3）
  sessions: {
    validate: assembly.identity.sessions.validate,
    owner: (adminId) => assembly.controlPlane.admins.find(adminId),
  },
  accounts: assembly.accounts,
  wallet: assembly.billing.wallet,
  // 调账/赠送幂等用例:billing operations(store 装配件在 assembly 域内)
  operations: assembly.operations,
  // writeAudit 桥:operations 事务句柄 → observability 同事务审计原语
  writeAudit: assembly.writeAuditInTx,
  subscriptions: assembly.billing.subscriptions,
  plans: assembly.billing.plans,
  redeemBatches: assembly.redeemBatches,
  review: assembly.billing.settlement.review,
  postAudit: assembly.postAudit,
  controlPlane: assembly.controlPlane,
  vendorCatalog: assembly.vendorCatalog,
  observability: assembly.observability,
  notifications: assembly.notifications,
  generationTasks: assembly.generationTasks,
  paymentAdmin: assembly.paymentAdmin,
  // 关单留痕文案 = 审计数据(v1 同字面),装配层显式持有(铁律 3)
  orderCloseReason: '管理员手动关闭',
  // P2 登录面编排件
  identity: assembly.identity,
  authGuards: assembly.authGuards,
  trustedProxyHops: config.trustedProxyHops,
  mailerConfigured: assembly.mailerConfigured,
  loginAudit: assembly.loginAudit,
  sessionTtlSec: config.sessionTtlSec,
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
  redis: assembly.redis,
  db: assembly.db,
  graceMs: config.shutdownGraceMs,
  logger: assembly.logger,
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
