import { serveApp, suggestDbBudget } from '@tillgate/http';
import { ping } from '@tillgate/db';
import { loadAdminApiConfig } from './config';
import { assembleAdminApi } from './assembly';
import { createAdminApp } from './app';
import { createAdminShutdown } from './shutdown';
import { verifyRbacStartup } from './startup-rbac';

/**
 * 管理控制面入口：config → assembly → app → serve → 信号接线（三段式,不自行拼装依赖）。
 * 部署：单副本低流量管理面;Redis 必配。
 */

const config = loadAdminApiConfig();
const assembly = await assembleAdminApi(config);
// 启动对账:代码侧 enforced 码 ⊆ DB 活动码,缺种子拒启(fail-closed;非阻塞不挡监听)
verifyRbacStartup({
  activeCodes: assembly.controlPlane.rbac.permissions.activeCodes,
  logger: assembly.logger,
});
// ping 绑定在进程装配面:app.ts 不接触 Db 类型(非装配代码只持闭包与纯契约)
// 停机排水控制器:宽限耗尽时 abort 预算门排队者(裸 abort——终止分类 reason
// 是 gateway 推理链专属语义,预算队列只关心 aborted 事实)
const drainController = new AbortController();
const app = createAdminApp({
  pingDb: () => ping(assembly.db),
  // DB 并发预算门:管理面批量脚本(调账/导出)入口排队,防打满小池(余量 2 给探针)
  dbBudget: { ...suggestDbBudget(assembly.dbPool.poolMax, 2), drainSignal: drainController.signal },
  logger: assembly.logger,
  // 会话验证 + 属主回查（admins 行存在且 status=0——封禁/注销即刻失效）
  sessions: {
    validate: assembly.identity.sessions.validate,
    owner: (adminId) => assembly.controlPlane.admins.findAccess(adminId),
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
  // 关单留痕文案 = 审计数据,装配层显式持有
  orderCloseReason: '管理员手动关闭',
  // 登录面编排件
  identity: assembly.identity,
  authGuards: assembly.authGuards,
  trustedProxyHops: config.trustedProxyHops,
  mailerConfigured: assembly.mailerConfigured,
  invites: assembly.invites,
  sendInviteLink: assembly.sendInviteLink,
  inviteLinkBase: assembly.inviteLinkBase,
  loginAudit: assembly.loginAudit,
  stepupAudit: assembly.stepupAudit,
  twoFactorAudit: assembly.twoFactorAudit,
  sessionTtlSec: config.sessionTtlSec,
  corsOrigins: config.corsOrigins,
  bodyLimitBytes: config.bodyLimitBytes,
  now: () => new Date(),
});

const server = serveApp(app, { port: config.port }, () => {
  assembly.logger.info(
    {
      port: config.port,
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
  drain: { abort: () => drainController.abort() },
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
