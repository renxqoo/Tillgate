import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { loadWorkerEnv } from '@ai-gateway/config';
import { createLogger } from '@ai-gateway/logger';
import { initOtel } from '@ai-gateway/otel';
import { createDb } from '@ai-gateway/db';
import { settle, type MeterJobData } from './settle.js';

const env = loadWorkerEnv();
const logger = createLogger({ level: env.LOG_LEVEL, serviceName: 'worker' });
initOtel({
  serviceName: 'worker',
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_ENABLED,
});

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const db = createDb(env.DATABASE_URL);

/**
 * bull:meter — 计量队列消费
 * 结算：算实际费用 → 写 usage_logs + transactions → 扣余额 → 刷 Redis 缓存
 * 幂等：requestId（usage_logs 唯一约束，重复 job 自动跳过）
 */
const meterWorker = new Worker<MeterJobData>(
  'meter',
  async (job) => {
    const data = job.data;
    logger.info({ jobId: job.id, requestId: data.requestId, model: data.realModel }, 'meter job start');
    const result = await settle(db, connection, data);
    if (result.settled) {
      logger.info(
        { jobId: job.id, requestId: data.requestId, amount: result.amount, usage: data.usage },
        'meter settled',
      );
    } else {
      logger.info({ jobId: job.id, requestId: data.requestId }, 'meter skipped (already settled)');
    }
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

meterWorker.on('completed', (job) => logger.debug({ jobId: job?.id }, 'job completed'));
meterWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'job failed'));

logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker started (meter consumer)');

process.on('SIGTERM', async () => {
  logger.info('worker shutting down...');
  await meterWorker.close();
  await connection.quit();
  await db.$client.end();
});
