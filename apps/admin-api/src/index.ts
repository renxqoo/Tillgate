import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadAdminApiEnv } from '@ai-gateway/config';
import { createLogger } from '@ai-gateway/logger';
import { initOtel } from '@ai-gateway/otel';

const env = loadAdminApiEnv();
const logger = createLogger({ level: env.LOG_LEVEL, serviceName: 'admin-api' });
initOtel({
  serviceName: 'admin-api',
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_ENABLED,
});

const app = new Hono();

// TODO(admin-api): 面板会话鉴权（HttpOnly Cookie JWT，role=admin 校验）+ audit_logs 中间件
app.get('/healthz', (c) => c.json({ status: 'ok' }));

// TODO(admin-api): 路由分组（下一阶段）：
//   /api/me · /api/auth/* · /api/keys · /api/apps · /api/redeem · /api/usage
//   /api/admin/users · /api/admin/channels · /api/admin/providers · /api/admin/models
//   /api/admin/rate-cards · /api/admin/plans · /api/admin/redeem-batches
//   /api/admin/stats/* · /api/admin/logs · /api/admin/audit-logs

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'admin-api listening (internal only)');
});
