import { Hono } from 'hono';
import type { Db } from '@ai-gateway/db';
import type { Ledger } from '@ai-gateway/ledger';
import type { Logger } from '@ai-gateway/core';
import { errorHandler, csrfProtection, type Redis } from '@ai-gateway/http';
import { bodyLimit } from 'hono/body-limit';
import { userSessionMiddleware, type ClientEnv } from '@ai-gateway/identity';
import type { ClientApiConfig } from './config.js';
import type { ClientServices } from './services/index.js';
import { clientAuthRoutesPublic, clientAuthRoutesProtected } from './routes/auth.js';
import { keyRoutes } from './routes/keys.js';
import { appRoutes } from './routes/apps.js';
import { meRoutes } from './routes/me.js';
import { usageRoutes } from './routes/usage.js';
import { redeemRoutes } from './routes/redeem.js';
import { planRoutes } from './routes/plans.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { orgRoutes } from './routes/orgs.js';

/**
 * client-api 应用组装（依赖注入唯一入口）。
 *
 * 挂载结构（默认安全）：
 *   - 公开端点显式挂载（login/logout/healthz）
 *   - 其余全部挂在受保护子应用：api.use('*', userSessionMiddleware)
 *     → 新增路由默认被会话守护（fail-closed），无需逐条挂中间件
 */

export interface ClientApiDeps {
  db: Db;
  redis: Redis;
  ledger: Ledger;
  logger: Logger;
  config: ClientApiConfig;
}

export function createApp(deps: ClientApiDeps): Hono {
  const services: ClientServices = {
    db: deps.db,
    redis: deps.redis,
    ledger: deps.ledger,
    logger: deps.logger,
  };

  const app = new Hono();
  app.onError(errorHandler(deps.logger));
  // T5：内部面也设请求体上限（32MB，兼容兑换券图 ≤20MB）——无上限时
  // /api/auth/login 一个未鉴权大 body 即可打爆堆内存。
  app.use('*', bodyLimit({ maxSize: 32 * 1024 * 1024 }));
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // 公开端点（不要求用户会话）
  app.route('/api/auth', clientAuthRoutesPublic(services, deps.config));

  // 受保护子应用：默认要求有效用户会话 + 状态变更 Origin 校验（CSRF 纵深防御）
  const api = new Hono<ClientEnv>();
  api.use('*', userSessionMiddleware(deps.db, deps.config.jwtSecret));
  api.use('*', csrfProtection({ trustedOrigins: deps.config.trustedOrigins }));
  api.route('/auth', clientAuthRoutesProtected(services));
  api.route('/me', meRoutes(services));
  api.route('/keys', keyRoutes(services));
  api.route('/apps', appRoutes(services));
  api.route('/usage', usageRoutes(services));
  api.route('/redeem', redeemRoutes(services));
  api.route('/plans', planRoutes(services));
  api.route('/subscriptions', subscriptionRoutes(services));
  api.route('/orgs', orgRoutes(services));
  app.route('/api', api);

  return app;
}
