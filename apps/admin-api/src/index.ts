import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadAdminApiEnv } from '@ai-gateway/config';
import { createLogger, type Logger } from '@ai-gateway/logger';
import { initOtel } from '@ai-gateway/otel';
import { createDb } from '@ai-gateway/db';
import { channelAdminRoutes } from './routes/channels.js';
import { adminAuthMiddleware } from './middleware/admin-auth.js';
import { ValidationError } from './lib/validation.js';

export const env = loadAdminApiEnv();
export const logger: Logger = createLogger({ level: env.LOG_LEVEL, serviceName: 'admin-api' });
initOtel({
  serviceName: 'admin-api',
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_ENABLED,
});

export function createApp() {
  const db = createDb(env.DATABASE_URL);
  const app = new Hono();

  // 统一错误处理
  app.onError((err, c) => {
    if (err instanceof ValidationError) {
      return c.json({ error: { message: '参数校验失败', code: 'VALIDATION_ERROR', details: err.details } }, 400);
    }
    logger.error({ err: err.message }, 'unhandled error');
    return c.json({ error: { message: '内部错误', code: 'INTERNAL_ERROR' } }, 500);
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // 管理端鉴权（S4）：所有 /api/admin/* 必须带有效 ADMIN_API_TOKEN
  // fail-closed：未配置 token 时返回 503（绝不放行）
  app.use('/api/admin/*', adminAuthMiddleware(env.ADMIN_API_TOKEN));

  // 渠道/供应商/模型管理（api-contract §4.5/§4.6）
  app.route('/', channelAdminRoutes(db));

  // TODO: audit_logs 中间件（管理操作审计）
  // TODO: /api/me · /api/auth/* · /api/keys · /api/apps · /api/redeem · /api/usage

  return app;
}

serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'admin-api listening (internal only)');
});
