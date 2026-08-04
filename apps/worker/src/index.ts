import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { loadWorkerEnv } from '@ai-gateway/config';
import { createLogger } from '@ai-gateway/logger';
import { initOtel } from '@ai-gateway/otel';

const env = loadWorkerEnv();
const logger = createLogger({ level: env.LOG_LEVEL, serviceName: 'worker' });
initOtel({
  serviceName: 'worker',
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_ENABLED,
});

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * bull:meter — 计量队列消费
 * TODO(worker): 结算对账（预扣 hold 补扣/退款）→ 写 usage_logs + transactions → 刷新缓存
 */
const meterWorker = new Worker(
  'meter',
  async (job) => {
    // TODO(worker): 结算实现（下一阶段）
    logger.info({ jobId: job.id, name: job.name }, 'meter job received (结算实现中)');
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

// TODO(worker): 定时任务占位（每日对账 / 充值码过期 / 日志分区清理 / hold 兜底扫描）

meterWorker.on('completed', (job) => logger.debug({ jobId: job.id }, 'job completed'));
meterWorker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, err: err.message }, 'job failed'),
);

logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker started');

process.on('SIGTERM', async () => {
  await meterWorker.close();
  await connection.quit();
});
