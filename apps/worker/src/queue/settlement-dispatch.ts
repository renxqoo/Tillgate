/**
 * 结算调度装配便捷件（2026-08-26 增量）：processor + BullMQ 队列 + sweep +
 * 直驱 job 一次成型——assembly 根只持本工厂返回的闭包面（装配根行数纪律）。
 * 与 settlement-queue.ts 的分工：queue 文件管 BullMQ 通用形状；本文件组合
 * billing settlement 面成 worker 的调度三件套（sweep=生产 tick、direct=E2E
 * 直驱、process=两者共用的处理真相）。
 */
import type { SettlementApi } from '@tillgate/billing';
import type { Logger } from '@tillgate/runtime';
import { createSettlementDirectJob, createSettlementProcessor } from '../jobs/settlement';
import { createSettlementSweepJob } from '../jobs/settlement-sweep';
import { createSettlementQueue } from './settlement-queue';

/** worker.settle 配置段的调度子集（装配根传 config.settle 派生值） */
export interface SettlementDispatchConfig {
  readonly ownerId: string;
  readonly batchSize: number;
  readonly claimLeaseMs: number;
  readonly backoffBaseMs: number;
  readonly bullmq: {
    readonly redisUrl: string;
    readonly prefix: string;
    readonly concurrency: number;
    readonly maxAttempts: number;
  };
}

export interface SettlementDispatch {
  readonly queue: ReturnType<typeof createSettlementQueue>;
  /** 生产调度 tick：due 扫描 → BullMQ 入队 */
  readonly sweep: () => Promise<{ due: number; enqueued: true }>;
  /** E2E/运维确定性入口：due 扫描 → 直驱 processor */
  readonly direct: () => Promise<{
    due: number;
    outcomes: Record<string, number>;
  }>;
}

export function createSettlementDispatch(deps: {
  settlement: Pick<SettlementApi, 'claim' | 'processClaim' | 'listDueRequestIds'>;
  config: SettlementDispatchConfig;
  onError: (error: unknown, context: string) => void;
  logger: Logger;
}): SettlementDispatch {
  const process = createSettlementProcessor({
    settlement: deps.settlement,
    ownerId: deps.config.ownerId,
    claimLeaseMs: deps.config.claimLeaseMs,
    onError: deps.onError,
  });
  const queue = createSettlementQueue({
    redisUrl: deps.config.bullmq.redisUrl,
    prefix: deps.config.bullmq.prefix,
    concurrency: deps.config.bullmq.concurrency,
    maxAttempts: deps.config.bullmq.maxAttempts,
    backoffBaseMs: deps.config.backoffBaseMs,
    process,
    logger: deps.logger,
  });
  return {
    queue,
    sweep: createSettlementSweepJob({
      settlement: deps.settlement,
      enqueueMany: (requestIds) => queue.enqueueMany(requestIds),
      batchSize: deps.config.batchSize,
      onError: deps.onError,
    }),
    direct: createSettlementDirectJob({
      settlement: deps.settlement,
      ownerId: deps.config.ownerId,
      claimLeaseMs: deps.config.claimLeaseMs,
      batchSize: deps.config.batchSize,
      onError: deps.onError,
    }),
  };
}
