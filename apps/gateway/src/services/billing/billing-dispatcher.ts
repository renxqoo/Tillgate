import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { BILLING_SETTLEMENT_QUEUE, type BillingSettlementWakeup } from '@ai-gateway/ledger';

/**
 * 结算唤醒器。队列不携带用户、价格或 usage；这些事实只从 PostgreSQL 收据读取。
 * 入队失败不影响资金正确性，worker 的 DB 扫描会恢复 settlement_pending 请求。
 */
export class BillingDispatcher {
  private readonly queue: Queue<BillingSettlementWakeup> | null;

  constructor(redis?: Redis) {
    this.queue = redis
      ? new Queue<BillingSettlementWakeup>(BILLING_SETTLEMENT_QUEUE, { connection: redis })
      : null;
  }

  async wake(requestId: string): Promise<{ ok: boolean; error?: Error }> {
    try {
      if (!this.queue) return { ok: false, error: new Error('billing dispatcher unavailable') };
      await this.queue.add(
        'settle',
        { requestId },
        {
          jobId: requestId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 1_000,
          removeOnFail: false,
        },
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  close(): Promise<void> {
    return this.queue?.close() ?? Promise.resolve();
  }
}
