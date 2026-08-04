import { Hono } from 'hono';
import { pathToFileURL } from 'node:url';
import { loadGatewayEnv, type GatewayEnv } from '@ai-gateway/config';
import { createLogger, type Logger } from '@ai-gateway/logger';
import { initOtel } from '@ai-gateway/otel';
import { healthRoutes } from './routes/health.js';
import { modelsRoutes } from './routes/models.js';
import { chatCompletionsRoutes } from './routes/chat-completions.js';
import { oauthTokenRoutes } from './routes/oauth-token.js';

export const env: GatewayEnv = loadGatewayEnv();
export const logger: Logger = createLogger({
  level: env.LOG_LEVEL,
  serviceName: 'gateway',
  pretty: env.NODE_ENV === 'development',
});
export const otel: { shutdown: () => Promise<void> } = initOtel({
  serviceName: 'gateway',
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_ENABLED,
});

export function createApp() {
  const app = new Hono();

  // TODO(gateway): request_id 中间件 + OTel 埋点 + 统一错误信封
  app.route('/healthz', healthRoutes);
  app.route('/v1/models', modelsRoutes);
  app.route('/v1/chat/completions', chatCompletionsRoutes);
  app.route('/oauth/token', oauthTokenRoutes);

  return app;
}
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createApp();
  const { serve } = await import('@hono/node-server');
  serve({ fetch: server.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port }, 'gateway listening');
  });
}
