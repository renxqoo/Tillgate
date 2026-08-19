/**
 * 结算唤醒生产端（BullMQ）：signal 落 settlement_pending 后向 'settle-wake' 队列
 * 投递固定 jobId 的任务——同 ID 未完成时新投递被 BullMQ 静默去重，
 * 流量洪峰天然合并为一次批量认领。
 *
 * 语义：纯门铃——消息不带账务指令，入队失败只记日志（worker 兜底扫描覆盖）。
 */
import { Queue } from 'bullmq';
import { SETTLE_WAKE_QUEUE } from '@ai-gateway/service';

export interface SettleWakeupProducer {
  /** 注入 billing domain 的 wake 端口（fire-and-forget） */
  wake: (requestId: string) => void;
  close(): Promise<void>;
}

export function createSettleWakeupProducer(
  redisUrl: string,
  options: { logger?: { warn(obj: unknown, msg: string): void } } = {},
): SettleWakeupProducer {
  const queue = new Queue(SETTLE_WAKE_QUEUE, {
    connection: { url: redisUrl },
    defaultJobOptions: {
      // 完成即删：固定 jobId 的门铃语义要求完成后立即释放——保留已完成任务
      // 会让后续同 jobId 投递被 BullMQ 静默去重（唤醒丢失，退化为兜底扫描节奏）
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  return {
    wake(requestId) {
      void queue
        .add('settle', { requestId }, { jobId: 'settle-wake' })
        .catch((error: Error) => {
          options.logger?.warn(
            { err: error.message, requestId },
            'settle wake enqueue failed (worker sweep covers loss)',
          );
        });
    },
    async close() {
      await queue.close();
    },
  };
}
