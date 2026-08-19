/**
 * 结算唤醒消费端（BullMQ Worker）：'settle-wake' 任务到达即触发 runOnce；
 * 合并执行器把突发唤醒折叠成一次批次（正在跑时新唤醒只置 pending）。
 *
 * 通道故障语义：BullMQ 自动重连；期间结算由定时兜底扫描继续（账务不依赖
 * 消息——认领/幂等全在 DB），通道断开记 error 级日志供告警。
 */
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { SETTLE_WAKE_QUEUE } from '@ai-gateway/service';

export interface SettleWakeupConsumer {
  /** 合并执行器（供测试直接驱动） */
  coalescedRun(): Promise<void>;
  close(): Promise<void>;
}

export function createCoalescedRunner(run: () => Promise<unknown>) {
  let running = false;
  let pending = false;
  return async function coalescedRun(): Promise<void> {
    if (running) {
      pending = true; // 正在跑：合并为跑完再来一轮
      return;
    }
    running = true;
    try {
      await run();
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void coalescedRun();
      }
    }
  };
}

export function createSettleWakeupConsumer(
  redisUrl: string,
  onWake: () => Promise<void>,
  options: {
    logger?: { error(obj: unknown, msg: string): void };
    /**
     * 满批阈值 + 排空回调：一次唤醒连续消费批次直到出现非满批（积压一次抽干，
     * 而非每个兜底周期只消化 batchSize 张）。缺省不排空（单批语义，测试友好）。
     */
    batchSize?: number;
    pendingCount?: () => Promise<number | null>;
  } = {},
): SettleWakeupConsumer {
  const coalescedRun = createCoalescedRunner(onWake);
  const drain = async (): Promise<void> => {
    // BullMQ 固定 jobId 去重：批次运行期间新唤醒在 Redis 侧被吞——不排空的话
    // 这批新 pending 只能等 30s 兜底扫描，积压时吞吐塌到 0.67 张/秒
    for (let guard = 0; guard < 1_000; guard++) {
      const pending = await options.pendingCount?.();
      if (pending == null || pending === 0) break;
      await coalescedRun();
      if (pending < (options.batchSize ?? 1)) break;
    }
  };
  const worker = new Worker(
    SETTLE_WAKE_QUEUE,
    async (_job: Job) => {
      if (options.pendingCount != null) {
        await drain();
      } else {
        await coalescedRun();
      }
    },
    { connection: { url: redisUrl }, concurrency: 1 },
  );
  worker.on('error', (error: Error) => {
    options.logger?.error({ err: error.message }, 'settle wake worker error (sweep covers)');
  });
  return {
    coalescedRun,
    async close() {
      await worker.close();
    },
  };
}
