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
import { statsAdminRoutes } from './routes/stats.js';
import { channelImportRoutes } from './routes/channel-import.js';
import { authRoutes } from './routes/auth.js';
import { keyRoutes } from './routes/keys.js';
import { appRoutes } from './routes/apps.js';
import { panelRoutes } from './routes/panel.js';
import { adminAuthMiddleware } from './middleware/admin-auth.js';
import { resolveSession, userSessionMiddleware, type AdminEnv } from './middleware/session.js';
import { ValidationError } from './lib/validation.js';
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
 *   - 机器令牌调用：无 session → adminId 保持 undefined（审计 actor 仍为 'admin'，adminId 为 NULL）
 *   - 会话调用：从 Cookie 解析 session.userId 注入 c.var.adminId
 *   - 失败/无会话：不阻塞（adminId 可空，审计容忍 NULL）
 */
function adminIdInjector(db: ReturnType<typeof createDb>, jwtSecret: string): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const session = await resolveSession(c, db, jwtSecret).catch(() => null);
    if (session && session.role === 1) c.set('adminId', session.userId);
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

  // 管理端鉴权（S4 + §5）：
  //   - 机器令牌：Authorization: Bearer <ADMIN_API_TOKEN> 或 X-Admin-Token
  //   - 管理员会话：HttpOnly Cookie 中 role=1 的面板 JWT（控制台登录后获得）
  //   - 任一通过即放行
  app.use('/api/admin/*', adminAuthMiddleware(env.ADMIN_API_TOKEN, db, env.JWT_SECRET));
  // 鉴权通过后注入 adminId（审计操作人，可空）
  app.use('/api/admin/*', adminIdInjector(db, env.JWT_SECRET));

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
  // 报表/仪表盘/日志/审计（§4.8）
  app.route('/', statsAdminRoutes(db));

  // 登录/注销（公开：/api/auth/login 不需要会话）
  app.route('/', authRoutes(db, {
    jwtSecret: env.JWT_SECRET,
    giftAmount: env.GIFT_AMOUNT,
    secureCookie: env.NODE_ENV === 'production',
  }));

  // 用户面板：必须有有效会话（userSessionMiddleware 注入 c.var.session）
  app.use('/api/me/*', userSessionMiddleware(db, env.JWT_SECRET));
  app.use('/api/keys/*', userSessionMiddleware(db, env.JWT_SECRET));
  app.use('/api/apps/*', userSessionMiddleware(db, env.JWT_SECRET));
  app.use('/api/usage/*', userSessionMiddleware(db, env.JWT_SECRET));
  app.use('/api/redeem', userSessionMiddleware(db, env.JWT_SECRET));
  app.use('/api/auth/password', userSessionMiddleware(db, env.JWT_SECRET));
  app.route('/', keyRoutes(db));
  app.route('/', appRoutes(db));
  app.route('/', panelRoutes(db));

  return app;
}

serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'admin-api listening (internal only)');
});
