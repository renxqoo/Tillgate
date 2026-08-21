import { serve } from '@hono/node-server';
import { loadTraceReceiverEnv, createLogger, initOtel } from '@ai-gateway/core';
import { createDb } from '@ai-gateway/db';
import { createPgTraceStore } from '@ai-gateway/tracing';
import { createReceiverApp } from './app.js';
import { SpanBatcher } from './batcher.js';

/**
 * 链路接收端入口：独立小服务（内网），诊断数据 best-effort。
 * 部署：双副本无状态；网关/worker 等通过 OTEL_TRACES_MODE=otlp +
 * OTEL_EXPORTER_OTLP_ENDPOINT=http://trace-receiver:8793 指向本服务。
 */

const env = loadTraceReceiverEnv();
const logger = createLogger({ level: env.LOG_LEVEL });
const otel = initOtel({
  serviceName: 'trace-receiver',
  mode: env.OTEL_TRACES_MODE,
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  logger,
});

const db = createDb(env.DATABASE_URL);
const store = createPgTraceStore(db);
const batcher = new SpanBatcher(store, {
  max: env.TRACE_QUEUE_MAX,
  batchMax: env.TRACE_BATCH_MAX,
  flushIntervalMs: env.TRACE_FLUSH_INTERVAL_MS,
});
const app = createReceiverApp({ db, store, token: env.TRACE_RECEIVER_TOKEN, batcher });

const server = serve({ fetch: app.fetch, port: env.TRACE_RECEIVER_PORT }, (info) => {
  batcher.start();
  logger.info(
    {
      port: info.port,
      auth: env.TRACE_RECEIVER_TOKEN ? 'token' : 'open(dev)',
      queueMax: env.TRACE_QUEUE_MAX,
      batchMax: env.TRACE_BATCH_MAX,
    },
    'trace-receiver ready',
  );
});

let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ reason }, 'trace-receiver draining');
  server.close();
  await batcher.close(); // 尽力刷完缓冲
  await otel.shutdown().catch(() => {});
  await db.$client.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
