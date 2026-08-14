import { Hono } from 'hono';
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
import { channelAdminRoutes } from './routes/channels.js';
import { channelFundsRoutes } from './routes/channel-funds.js';
import { voucherRoutes } from './routes/vouchers.js';
import { modelAdminRoutes } from './routes/models.js';
import { rateCardAdminRoutes } from './routes/rate-cards.js';
import { redeemAdminRoutes } from './routes/redeem.js';
import { statsAdminRoutes } from './routes/stats.js';
import { logAdminRoutes, auditLogAdminRoutes } from './routes/logs.js';
import { billingOperationsRoutes } from './routes/billing-operations.js';

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
  /** 渠道上游 Key 加密密钥（AES-256-GCM） */
  encryptionKey: string;
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
    encryptionKey: deps.encryptionKey,
    voucherStorage: deps.voucherStorage,
    logger: deps.logger,
  };

  const app = new Hono();
  app.onError(errorHandler(deps.logger));
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // 公开端点（不要求管理员会话）
  app.route('/api/admin/auth', adminAuthRoutesPublic(services, deps.config));

  // 受保护子应用：默认要求管理员会话 + 状态变更 Origin 校验（CSRF 纵深防御）
  const admin = new Hono<AdminEnv>();
  admin.use('*', adminAuthMiddleware(deps.db, deps.config.adminJwtSecret));
  admin.use('*', csrfProtection({ trustedOrigins: deps.config.trustedOrigins }));
  admin.route('/auth', adminAuthRoutesProtected(services));
  admin.route('/me', adminMeRoutes(services));
  admin.route('/users', userAdminRoutes(services));
  admin.route('/keys', keyAdminRoutes(services));
  admin.route('/providers', providerAdminRoutes(services));
  admin.route('/channels', channelAdminRoutes(services));
  admin.route('/channel-funds', channelFundsRoutes(services, deps.config.voucherMaxBytes));
  admin.route('/vouchers', voucherRoutes(services));
  admin.route('/models', modelAdminRoutes(services));
  admin.route('/rate-cards', rateCardAdminRoutes(services));
  admin.route('/redeem-batches', redeemAdminRoutes(services));
  admin.route('/stats', statsAdminRoutes(services));
  admin.route('/logs', logAdminRoutes(services));
  admin.route('/audit-logs', auditLogAdminRoutes(services));
  admin.route('/billing-operations', billingOperationsRoutes(services));
  app.route('/api/admin', admin);

  return app;
}
