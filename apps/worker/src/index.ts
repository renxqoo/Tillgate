import { createLogger, initOtel, loadWorkerEnv } from '@ai-gateway/core';
import { createBillingWorkerApplication } from './worker-application.js';

const env = loadWorkerEnv();
const logger = createLogger({ level: env.LOG_LEVEL, serviceName: 'worker' });
const telemetry = initOtel({
  serviceName: 'worker',
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_ENABLED,
});
const application = createBillingWorkerApplication({
  env,
  logger,
  telemetryShutdown: telemetry.shutdown,
});

let shuttingDown = false;
async function shutdown(reason: 'SIGTERM' | 'SIGINT' | 'fatal'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const hardExit = setTimeout(() => {
    logger.fatal({ reason }, 'worker shutdown hard deadline exceeded');
    process.exit(1);
  }, env.WORKER_SHUTDOWN_TIMEOUT_MS + 1_000);
  hardExit.unref();
  try {
    const report = await application.stop({ reason, deadlineMs: env.WORKER_SHUTDOWN_TIMEOUT_MS });
    logger.info({ report }, 'worker stopped');
    process.exitCode = report.clean ? 0 : 1;
  } finally {
    clearTimeout(hardExit);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('fatal');
});
process.once('unhandledRejection', (error) => {
  logger.fatal({ err: error }, 'unhandled rejection');
  void shutdown('fatal');
});

try {
  await application.start();
} catch (error) {
  logger.fatal({ err: error }, 'worker startup failed');
  await shutdown('fatal');
}

export { createBillingWorkerApplication } from './worker-application.js';
