import { Hono } from 'hono';
import type { Db } from '@ai-gateway/db';
import type { Ledger } from '@ai-gateway/ledger';
import type { Logger } from '@ai-gateway/core';
import { errorHandler, type Redis } from '@ai-gateway/http';
import { userSessionMiddleware, type ClientEnv } from '@ai-gateway/identity';
import type { ClientApiConfig } from './config.js';
import type { ClientServices } from './services/index.js';
import { clientAuthRoutesPublic, clientAuthRoutesProtected } from './routes/auth.js';
import { keyRoutes } from './routes/keys.js';
import { appRoutes } from './routes/apps.js';
import { meRoutes } from './routes/me.js';
import { usageRoutes } from './routes/usage.js';
import { redeemRoutes } from './routes/redeem.js';

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
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // 公开端点（不要求用户会话）
  app.route('/api/auth', clientAuthRoutesPublic(services, deps.config));

  // 受保护子应用：默认要求有效用户会话
  const api = new Hono<ClientEnv>();
  api.use('*', userSessionMiddleware(deps.db, deps.config.jwtSecret));
  api.route('/auth', clientAuthRoutesProtected(services));
  api.route('/me', meRoutes(services));
  api.route('/keys', keyRoutes(services));
  api.route('/apps', appRoutes(services));
  api.route('/usage', usageRoutes(services));
  api.route('/redeem', redeemRoutes(services));
  app.route('/api', api);

  return app;
}
