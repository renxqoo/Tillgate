import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadAdminApiEnv } from '@ai-gateway/config';
import { createLogger, type Logger } from '@ai-gateway/logger';
import { initOtel } from '@ai-gateway/otel';
import { createDb } from '@ai-gateway/db';
import { channelAdminRoutes } from './routes/channels.js';
import { rateCardAdminRoutes } from './routes/rate-cards.js';
import { userAdminRoutes } from './routes/users.js';
import { redeemAdminRoutes } from './routes/redeem.js';
import { keyAdminRoutes } from './routes/keys.js';
import { statsAdminRoutes } from './routes/stats.js';
import { channelImportRoutes } from './routes/channel-import.js';
import { adminUserRoutes } from './routes/auth.js';
import { adminAuthRoutes } from './routes/admin-auth.js';
import { adminAuthMiddleware, tryResolveAdminSession, type AdminEnv } from '@ai-gateway/identity';
import { ValidationError } from './lib/validation.js';
import { getAdminRedis } from './lib/route-invalidation.js';
import type { MiddlewareHandler } from 'hono';

export const env = loadAdminApiEnv();
export const logger: Logger = createLogger({ level: env.LOG_LEVEL, serviceName: 'admin-api' });
initOtel({
  serviceName: 'admin-api',
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_ENABLED,
});

/**
 * 注入 adminId（供审计日志回溯操作人）。
 *   - 机器令牌调用：无 admin 会话 → adminId 保持 undefined（审计 adminId 为 NULL）
 *   - 会话调用：从 ag_admin_session Cookie 解析管理员会话 → 注入 c.var.adminId（admins.id）
 *   - 失败/无会话：不阻塞（adminId 可空，审计容忍 NULL）
 *
 * 拆分后：改用 tryResolveAdminSession + ADMIN_JWT_SECRET（仅认管理员会话）。
 */
function adminIdInjector(db: ReturnType<typeof createDb>, adminJwtSecret: string): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const session = await tryResolveAdminSession(c, db, adminJwtSecret).catch(() => null);
    if (session) c.set('adminId', session.adminId);
    await next();
  };
}

export function createApp() {
  const db = createDb(env.DATABASE_URL);
  const app = new Hono<AdminEnv>();

  // 统一错误处理
  app.onError((err, c) => {
    if (err instanceof ValidationError) {
      return c.json({ error: { message: '参数校验失败', code: 'VALIDATION_ERROR', details: err.details } }, 400);
    }
    logger.error({ err: err.message }, 'unhandled error');
    return c.json({ error: { message: '内部错误', code: 'INTERNAL_ERROR' } }, 500);
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // 管理端鉴权（拆分后用独立 ADMIN_JWT_SECRET + ag_admin_session cookie + admins 表回查）
  // 公开端点（/api/admin/auth/login、/api/admin/auth/logout）需在下方显式跳过本中间件
  app.use('/api/admin/*', async (c, next) => {
    // 登录/注销是公开端点，不要求管理员会话（否则无法首次登录）
    const path = c.req.path;
    if (path === '/api/admin/auth/login' || path === '/api/admin/auth/logout') {
      return next();
    }
    return adminAuthMiddleware(db, env.ADMIN_JWT_SECRET)(c, next);
  });
  // 鉴权通过后注入 adminId（审计操作人，可空）
  app.use('/api/admin/*', adminIdInjector(db, env.ADMIN_JWT_SECRET));

  // 管理员登录/注销/改密码/me（公开登录端点 + 需登录的改密/me）
  app.route('/', adminAuthRoutes(db, {
    adminJwtSecret: env.ADMIN_JWT_SECRET,
    secureCookie: env.NODE_ENV === 'production',
    redis: getAdminRedis(),
  }));

  // 管理员开通用户账号（set-password，需管理员会话）
  app.route('/', adminUserRoutes(db));

  // 渠道/供应商/模型管理（api-contract §4.5/§4.6）
  app.route('/', channelAdminRoutes(db));
  // 渠道批量导入（§4.5）
  app.route('/', channelImportRoutes(db, env.ENCRYPTION_KEY));
  // 费率卡管理（§4.9）
  app.route('/', rateCardAdminRoutes(db));
  // 用户管理（§4.4）
  app.route('/', userAdminRoutes(db));
  // 充值码管理（§4.7）
  app.route('/', redeemAdminRoutes(db));
  // Key 限流管理（管理员配置 Key 的 RPM/TPM，改后立即生效）
  app.route('/', keyAdminRoutes(db));
  // 报表/仪表盘/日志/审计（§4.8）
  app.route('/', statsAdminRoutes(db));

  return app;
}

serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'admin-api listening (internal only)');
});
