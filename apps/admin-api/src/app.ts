import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '@ai-gateway/db';
import type { BillingOperations, Ledger } from '@ai-gateway/ledger';
import type { Logger } from '@ai-gateway/core';
import { errorHandler, csrfProtection, type Redis } from '@ai-gateway/http';
import { adminAuthMiddleware, type AdminEnv } from '@ai-gateway/identity';
import type { AdminApiConfig } from './config.js';
import type { AdminServices } from './services/index.js';
import type { VoucherStorage } from './services/voucher-storage.js';
import {
  adminAuthRoutesPublic,
  adminAuthRoutesProtected,
  adminMeRoutes,
} from './routes/admin-auth.js';
import { userAdminRoutes } from './routes/users.js';
import { keyAdminRoutes } from './routes/keys.js';
import { providerAdminRoutes } from './routes/providers.js';
import { vendorCatalogRoutes } from './routes/vendor-catalog.js';
import { paymentOrderAdminRoutes } from './routes/payment-orders.js';
import { notificationAdminRoutes } from './routes/notifications.js';
import { channelAdminRoutes } from './routes/channels.js';
import { channelFundsRoutes } from './routes/channel-funds.js';
import { voucherRoutes } from './routes/vouchers.js';
import { modelAdminRoutes } from './routes/models.js';
import { modelCatalogRoutes } from './routes/model-catalog.js';
import { rateCardAdminRoutes } from './routes/rate-cards.js';
import { planAdminRoutes } from './routes/plans.js';
import { subscriptionAdminRoutes } from './routes/subscriptions.js';
import { redeemAdminRoutes } from './routes/redeem.js';
import { statsAdminRoutes } from './routes/stats.js';
import { logAdminRoutes, auditLogAdminRoutes } from './routes/logs.js';
import { usageLogAdminRoutes } from './routes/usage-logs.js';
import { billingOperationsRoutes } from './routes/billing-operations.js';
import { generationTaskAdminRoutes } from './routes/generation-tasks.js';
import { tracingAdminRoutes } from './routes/tracing.js';
import type { Mailer } from '@ai-gateway/identity';
import { createPgTraceStore, type TraceStore } from '@ai-gateway/tracing';

/**
 * admin-api 应用组装（依赖注入唯一入口）。
 *
 * 挂载结构：
 *   - 公开端点显式挂载（login/logout/healthz）
 *   - 其余全部挂在受保护子应用：admin.use('*', adminAuthMiddleware)
 *     → 新增路由默认被鉴权守护（fail-closed），无需逐条挂中间件
 *
 * 所有依赖（db/redis/ledger/加密密钥/日志/配置）由调用方注入，
 * 路由与服务不直读 process.env / 全局单例，测试可完整复用本工厂。
 */

export interface AdminApiDeps {
  db: Db;
  redis: Redis;
  ledger: Ledger;
  billingOperations: BillingOperations;
  /** 链路存储（缺省由 db 构造 PG 实现） */
  tracingStore?: TraceStore;
  /** 邮箱验证码发信（未配置 = null） */
  mailer?: Mailer | null;
  /** 渠道上游 Key 加密密钥（AES-256-GCM） */
  encryptionKey: string;
  /** 轮换双 key 窗：旧密钥（v1 密文解密用）；加密新密文时 OLD 设置则写 v2 */
  encryptionKeyOld?: string;
  /** 凭证截图存储（本地磁盘/未来 OSS） */
  voucherStorage: VoucherStorage;
  logger: Logger;
  config: AdminApiConfig;
}

export function createApp(deps: AdminApiDeps): Hono {
  const services: AdminServices = {
    db: deps.db,
    redis: deps.redis,
    ledger: deps.ledger,
    billingOperations: deps.billingOperations,
    tracingStore: deps.tracingStore ?? createPgTraceStore(deps.db),
    mailer: deps.mailer ?? null,
    encryptionKey: deps.encryptionKey,
    encryptionKeyOld: deps.encryptionKeyOld,
    voucherStorage: deps.voucherStorage,
    // 双重门控与网关一致：生产即便误配 ALLOW_LOCAL_UPSTREAM 也不放行内网上游
    allowLocalUpstream: deps.config.allowLocalUpstream && process.env.NODE_ENV !== 'production',
    logger: deps.logger,
  };

  const app = new Hono();
  // T5：管理面请求体上限（32MB，兼容兑换券图 ≤20MB）
  app.use('*', bodyLimit({ maxSize: 32 * 1024 * 1024 }));
  app.onError(errorHandler(deps.logger));
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // 公开端点（不要求管理员会话）
  app.route('/api/admin/auth', adminAuthRoutesPublic(services, deps.config));

  // 受保护子应用：默认要求管理员会话 + 状态变更 Origin 校验（CSRF 纵深防御）
  const admin = new Hono<AdminEnv>();
  admin.use('*', adminAuthMiddleware(deps.db, deps.config.adminJwtSecret));
  admin.use(
    '*',
    csrfProtection({
      trustedOrigins: deps.config.trustedOrigins,
      internalToken: deps.config.internalApiToken,
    }),
  );
  admin.route('/auth', adminAuthRoutesProtected(services));
  admin.route('/me', adminMeRoutes(services));
  admin.route('/users', userAdminRoutes(services));
  admin.route('/keys', keyAdminRoutes(services));
  admin.route('/providers', providerAdminRoutes(services));
  admin.route('/vendor-catalog', vendorCatalogRoutes());
  admin.route('/payment-orders', paymentOrderAdminRoutes(deps.db));
  admin.route('/notifications', notificationAdminRoutes(deps.db));
  admin.route('/channels', channelAdminRoutes(services));
  admin.route('/channel-funds', channelFundsRoutes(services, deps.config.voucherMaxBytes));
  admin.route('/vouchers', voucherRoutes(services));
  admin.route('/models', modelAdminRoutes(services));
  admin.route('/model-catalog', modelCatalogRoutes(services));
  admin.route('/rate-cards', rateCardAdminRoutes(services));
  admin.route('/plans', planAdminRoutes(services));
  admin.route('/subscriptions', subscriptionAdminRoutes(services));
  admin.route('/redeem-batches', redeemAdminRoutes(services));
  admin.route('/stats', statsAdminRoutes(services));
  admin.route('/logs', logAdminRoutes(services));
  admin.route('/usage-logs', usageLogAdminRoutes(services));
  admin.route('/generation-tasks', generationTaskAdminRoutes(services));
  admin.route('/audit-logs', auditLogAdminRoutes(services));
  admin.route('/billing-operations', billingOperationsRoutes(services));
  admin.route('/tracing', tracingAdminRoutes(services));
  app.route('/api/admin', admin);

  return app;
}
