/**
 * BullMQ 结算队列装配（2026-08-26 增量）：PG 是资金与队列状态唯一事实源，
 * Redis 只承担触发、进程隔离与瞬时失败退避时序——jobId=requestId（入队去重）、
 * 无业务 payload。processor 是 worker 侧唯一处理真相
 * （`processSettlementRequest`，与直驱 runner 同函数）。
 * 进程隔离语义：processor 抛错（retried/unknown-failure 映射）由 BullMQ 捕获
 * → 指数退避重投 → attempts 耗尽进 failed set（缺陷信号，error 日志；
 * 业务死信判定真相在 PG settlement_attempts + billing 失败策略）。
 */
import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import type { SettlementProcessOutcome } from '../jobs/settlement.js';

/** 有界收口竞速（模块级：close 语义单一定义；副作用式绕开 then 返回值规则） */
function boundedClose(pending: Promise<unknown>, ms = 5_000): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    void pending.then(settle, settle);
  });
}

export const SETTLEMENT_QUEUE_NAME = 'settlement';

/** 需要重投的结局（瞬时失败：PG 已写 retry_wait + 退避；BullMQ 更快地重试） */
const RETRY_OUTCOMES: readonly SettlementProcessOutcome[] = ['retried', 'unknown-failure'];

export interface SettlementQueueFace {
  /** 幂等入队（jobId=requestId 去重；attempts/backoff 只在首次入队生效） */
  enqueueMany(requestIds: readonly string[]): Promise<void>;
  /** 优雅收口：停消费 → 关队列 → 断 Redis 连接 */
  close(): Promise<void>;
}

export interface SettlementQueueEnv {
  readonly redisUrl: string;
  readonly prefix: string;
  readonly concurrency: number;
  /** BullMQ attempts 保险丝（业务死信判定在 PG；正常路径不触及） */
  readonly maxAttempts: number;
  /** 指数退避基delay（与 PG failurePolicy.baseDelayMs 同值装配） */
  readonly backoffBaseMs: number;
  readonly process: (requestId: string) => Promise<SettlementProcessOutcome>;
  readonly logger: {
    info(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
}

// eslint-disable-next-line max-lines-per-function -- BullMQ 装配工厂:连接/队列/消费端/事件一次成型,拆分只透传句柄
export function createSettlementQueue(env: SettlementQueueEnv): SettlementQueueFace {
  // BullMQ 硬性要求 maxRetriesPerRequest:null(阻塞命令语义);不复用 runtime
  // 通用客户端(maxRetriesPerRequest:1 形态冲突)
  const connection = new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  });
  const jobOptions: JobsOptions = {
    attempts: env.maxAttempts,
    backoff: { type: 'exponential', delay: env.backoffBaseMs },
    removeOnComplete: 1_000,
    removeOnFail: 10_000,
  };
  const queue = new Queue(SETTLEMENT_QUEUE_NAME, { connection, prefix: env.prefix });
  const worker = new Worker(
    SETTLEMENT_QUEUE_NAME,
    async (job) => {
      const requestId = job.data.requestId as string;
      const outcome = await env.process(requestId);
      if (RETRY_OUTCOMES.includes(outcome)) {
        // 已知瞬时失败:抛错交给 BullMQ 退避重投(同 jobId 延迟重试)
        throw new Error(`settlement retryable outcome=${outcome} request=${requestId}`);
      }
    },
    { connection, prefix: env.prefix, concurrency: env.concurrency },
  );
  worker.on('failed', (job, error) => {
    // attempts 耗尽 = 保险丝熔断(业务上不该发生:PG 策略先行死信)——缺陷信号
    env.logger.error(
      { err: String(error), jobId: job?.id, attemptsMade: job?.attemptsMade },
      'settlement job exhausted attempts (defect signal; sweep/recover will cover)',
    );
  });
  worker.on('error', (error) => {
    env.logger.error({ err: String(error) }, 'settlement worker error');
  });
  env.logger.info(
    { queue: SETTLEMENT_QUEUE_NAME, prefix: env.prefix, concurrency: env.concurrency },
    'settlement bullmq worker started',
  );
  return {
    async enqueueMany(requestIds) {
      if (requestIds.length === 0) return;
      await queue.addBulk(
        requestIds.map((requestId) => ({
          name: 'settle',
          data: { requestId },
          opts: { ...jobOptions, jobId: requestId },
        })),
      );
    },
    async close() {
      // 有界收口:Redis 不可达时 BullMQ close 会等重试循环——竞速超时后强制断连
      // (生产正常路径毫秒级完成,故障路径 5s 强断,停机宽限不被无限占用)
      await boundedClose(worker.close());
      await boundedClose(queue.close());
      connection.disconnect();
    },
  };
}
