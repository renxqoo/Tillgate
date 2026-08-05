import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { loadWorkerEnv } from '@ai-gateway/config';
import { createLogger } from '@ai-gateway/logger';
import { initOtel, metrics } from '@ai-gateway/otel';
import { createDb } from '@ai-gateway/db';
import { settle, type MeterJobData } from './settle.js';
import { createShutdownHandler } from './shutdown-handler.js';

const env = loadWorkerEnv();
const logger = createLogger({ level: env.LOG_LEVEL, serviceName: 'worker' });
initOtel({
  serviceName: 'worker',
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_ENABLED,
});

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const db = createDb(env.DATABASE_URL);

/** 计费失败告警计数器（资损防线：failed job 不静默丢失，运维可告警介入） */
const meterFailedCounter = metrics.getMeter('worker.metrics').createCounter('meter_job_failed_total', {
  description: '计量 job 最终失败次数（重试耗尽，资损风险）',
});

/**
 * bull:meter — 计量队列消费
 * 结算：算实际费用 → 写 usage_logs + transactions → 扣余额 → 删 hold → 刷 Redis 缓存
 * 幂等：requestId（usage_logs 唯一约束，重复 job 自动跳过）
 *
 * 重试/兜底（资损防线）：
 *   - 生产者侧（meter.ts）已配 attempts:3 + 指数退避 + removeOnFail:true（死信永久留存）
 *   - 消费侧 failed 事件：重试耗尽后记 error 日志 + 告警计数器，运维介入重放
 *   - P1：加 DLQ 自动重放 Worker（消费 failed 队列二次处理）
 */
const meterWorker = new Worker<MeterJobData>(
  'meter',
  async (job) => {
    const data = job.data;
    logger.info({ jobId: job.id, requestId: data.requestId, model: data.realModel }, 'meter job start');
    const result = await settle(db, connection, data);
    if (result.settled) {
      if (result.overdraft) {
        // 透支：实际用量超余额 → 如实扣全额，余额为负（= 用户欠款）。下次充值自动抵扣。
        // 资损告警：余额为负 = 平台垫付，需关注催收（用户已享服务但欠款未付）。
        logger.warn(
          { jobId: job.id, requestId: data.requestId, amount: result.amount, usage: data.usage, userId: data.userId },
          'meter overdraft (balance negative — user debt, awaiting recharge to cover)',
        );
      } else {
        logger.info(
          { jobId: job.id, requestId: data.requestId, amount: result.amount, usage: data.usage },
          'meter settled',
        );
      }
    } else {
      logger.info({ jobId: job.id, requestId: data.requestId }, 'meter skipped (already settled)');
    }
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

meterWorker.on('completed', (job) => logger.debug({ jobId: job?.id }, 'job completed'));
meterWorker.on('failed', (job, err) => {
  // 重试耗尽 → 告警（不静默丢失；P1 加 DLQ 自动重放）
  logger.error({ jobId: job?.id, requestId: job?.data?.requestId, err: err.message, attempts: job?.attemptsMade }, 'meter job failed (revenue loss risk — alert + manual replay)');
  meterFailedCounter.add(1, { requestId: job?.data?.requestId ?? 'unknown' });
});
// W-1：监听 error 事件（Redis 断开等），防 unhandled error 崩进程
meterWorker.on('error', (err) => {
  logger.error({ err: err.message }, 'worker error event (Redis/BullMQ internal)');
});

logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker started (meter consumer)');

// W-1：优雅关闭——SIGTERM/SIGINT 都处理，防重复触发，确保 process.exit
const shutdown = createShutdownHandler(
  {
    closeWorker: () => meterWorker.close(),
    quitRedis: () => connection.quit(),
    endDb: () => db.$client.end(),
    exit: (code) => process.exit(code),
  },
  logger,
);
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
