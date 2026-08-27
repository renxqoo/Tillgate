/**
 * 恢复 job：三类滞留单兜底（authorized 过期 / in_flight 租约过期 / processing
 * 认领过期——recover 用例语义）。回收的 processing 行回到 retry_wait 立即可
 * 重领——由 settle sweep 周期重新入队（recover 不返回 ids，billing 契约零改动；
 * 多等一个 sweep 周期可接受）。前提是
 * 同 jobId 的旧 job 不在 completed/failed 保留集内挡路——该出口由
 * enqueueMany 的终态残留重投保证（queue/settlement-queue.ts）。
 */
import type { RecoveryRunResult, SettlementApi } from '@tillgate/billing';

type RecoveryJob = () => Promise<RecoveryRunResult>;

export function createRecoveryJob(deps: {
  settlement: Pick<SettlementApi, 'recover'>;
  batchSize: number;
}): RecoveryJob {
  return async function runRecovery() {
    return await deps.settlement.recover({ batchSize: deps.batchSize });
  };
}
