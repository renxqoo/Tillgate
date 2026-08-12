import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadClientApiEnv } from '@ai-gateway/config';
import { createLogger, type Logger } from '@ai-gateway/logger';
import { initOtel } from '@ai-gateway/otel';
import { createDb } from '@ai-gateway/db';
import { clientAuthRoutes } from './routes/auth.js';
import { keyRoutes } from './routes/keys.js';
import { appRoutes } from './routes/apps.js';
import { panelRoutes } from './routes/panel.js';
import { userSessionMiddleware, type ClientEnv } from '@ai-gateway/identity';
import { ValidationError } from './lib/validation.js';
import { getSharedRedis } from '@ai-gateway/billing';

export const env = loadClientApiEnv();
export const logger: Logger = createLogger({ level: env.LOG_LEVEL, serviceName: 'client-api' });
initOtel({
  serviceName: 'client-api',
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_ENABLED,
});

export function createApp() {
  const db = createDb(env.DATABASE_URL);
  const app = new Hono<ClientEnv>();

  // 统一错误处理
  app.onError((err, c) => {
    if (err instanceof ValidationError) {
      return c.json({ error: { message: '参数校验失败', code: 'VALIDATION_ERROR', details: err.details } }, 400);
    }
    logger.error({ err: err.message }, 'unhandled error');
    return c.json({ error: { message: '内部错误', code: 'INTERNAL_ERROR' } }, 500);
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // 登录/注销（公开：/api/auth/login 不需要会话）
  // C6 修复：注入 Redis 启用登录限流/锁定
  app.route('/', clientAuthRoutes(db, {
    jwtSecret: env.JWT_SECRET,
    giftAmount: env.GIFT_AMOUNT,
    secureCookie: env.NODE_ENV === 'production',
    redis: getSharedRedis(),
  }));

  // 用户面板：必须有有效用户会话（userSessionMiddleware 注入 c.var.session）
  app.use('/api/me/*', userSessionMiddleware(db, env.JWT_SECRET));
  app.use('/api/keys/*', userSessionMiddleware(db, env.JWT_SECRET));
  app.use('/api/apps/*', userSessionMiddleware(db, env.JWT_SECRET));
  app.use('/api/usage/*', userSessionMiddleware(db, env.JWT_SECRET));
  app.use('/api/redeem/*', userSessionMiddleware(db, env.JWT_SECRET));
  app.use('/api/auth/password', userSessionMiddleware(db, env.JWT_SECRET));
  app.route('/', keyRoutes(db));
  app.route('/', appRoutes(db));
  app.route('/', panelRoutes(db));

  return app;
}

serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'client-api listening (internal only)');
});
