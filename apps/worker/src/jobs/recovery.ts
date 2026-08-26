/**
 * 恢复 job：三类滞留单兜底（authorized 过期 / in_flight 租约过期 / processing
 * 认领过期——recover 用例语义）。回收的 processing 行回到 retry_wait 立即可
 * 重领——BullMQ 调度下由 settle sweep 周期兜底重新入队（recover 不返回 ids，
 * billing 契约零改动；多等一个 sweep 周期可接受，见 IMPLEMENTATION 增量节裁决 5）。
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
