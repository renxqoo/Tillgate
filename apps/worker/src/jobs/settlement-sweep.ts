/**
 * 结算 sweep job（2026-08-26 BullMQ 增量）：周期扫描 due 行
 * （settlement_pending/retry_wait 且到期）批量入队——兜 Redis 丢任务/丢通知/
 * recover 回收行；不直接结算（处理面单一真相 = processor + BullMQ Worker）。
 * 入队幂等（jobId=requestId 去重）：对活 job 重复触发天然安全；对 completed/
 * failed 保留集内的旧 job 去重会吞掉重投，出口在 enqueueMany 内建
 * （终态残留 remove 后重投，见 queue/settlement-queue.ts）。
 */
import type { SettlementApi } from '@tillgate/billing';

export interface SettlementSweepJobDeps {
  readonly settlement: Pick<SettlementApi, 'listDueRequestIds'>;
  readonly enqueueMany: (requestIds: readonly string[]) => Promise<void>;
  readonly batchSize: number;
  readonly onError: (error: unknown, context: string) => void;
}

export function createSettlementSweepJob(deps: SettlementSweepJobDeps) {
  return async function runSettlementSweep(): Promise<{ due: number; enqueued: true }> {
    const due = await deps.settlement.listDueRequestIds({ limit: deps.batchSize });
    if (due.length > 0) {
      try {
        await deps.enqueueMany(due);
      } catch (error) {
        // 入队失败不致命：下个 sweep 周期重扫（PG 真相未动）
        deps.onError(error, 'settlement sweep enqueue');
      }
    }
    return { due: due.length, enqueued: true };
  };
}
