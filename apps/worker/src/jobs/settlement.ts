/**
 * 结算驱动（2026-08-26 BullMQ 增量重写）：单条结算 processor ——
 * 定向认领（requestIds=[id]；空认领 = 已终态/他方持有，幂等完成）→
 * processClaim（结算/失败策略/死信判定全在 @tillgate/billing，与调度层无关）。
 * 未知异常不外抛（记日志返回 unknown-failure）——调用方（BullMQ Worker /
 * 直驱 runner）决定重投；毒账单绝不外溢成进程级故障（live-fire F-1 语义）。
 * `createSettlementDirectJob`：listDue 扫描 + 逐条直驱 processor ——
 * runners.settle 与 E2E 的确定性入口（同一生产函数，不经 BullMQ runtime）。
 */
import type { SettlementApi } from '@tillgate/billing';

export type SettlementProcessOutcome =
  | 'settled'
  | 'retried'
  | 'dead'
  | 'claim_lost'
  | 'unknown-failure';

export interface SettlementProcessorDeps {
  readonly settlement: Pick<SettlementApi, 'claim' | 'processClaim'>;
  readonly ownerId: string;
  readonly claimLeaseMs: number;
  readonly onError: (error: unknown, context: string) => void;
}

/** 单条结算驱动：已知结局透传；未知异常吞掉并标记（重投决策归调用方） */
export function createSettlementProcessor(deps: SettlementProcessorDeps) {
  return async function processSettlementRequest(requestId: string): Promise<SettlementProcessOutcome> {
    try {
      const claims = await deps.settlement.claim({
        ownerId: deps.ownerId,
        batchSize: 1,
        claimLeaseMs: deps.claimLeaseMs,
        requestIds: [requestId],
      });
      const [claim] = claims;
      if (claim == null) return 'claim_lost';
      return await deps.settlement.processClaim(claim);
    } catch (error) {
      deps.onError(error, `settlement process request=${requestId}`);
      return 'unknown-failure';
    }
  };
}

export interface SettlementDirectJobDeps extends SettlementProcessorDeps {
  readonly settlement: Pick<SettlementApi, 'claim' | 'processClaim' | 'listDueRequestIds'>;
  readonly batchSize: number;
}

/** 直驱一轮：扫 due 行并逐条同步处理（runners.settle / E2E 确定性入口） */
export function createSettlementDirectJob(deps: SettlementDirectJobDeps) {
  const process = createSettlementProcessor(deps);
  return async function runSettlementDirect(): Promise<{
    due: number;
    outcomes: Record<SettlementProcessOutcome, number>;
  }> {
    const due = await deps.settlement.listDueRequestIds({ limit: deps.batchSize });
    const outcomes: Record<SettlementProcessOutcome, number> = {
      settled: 0,
      retried: 0,
      dead: 0,
      claim_lost: 0,
      'unknown-failure': 0,
    };
    for (const requestId of due) {
      outcomes[await process(requestId)] += 1;
    }
    return { due: due.length, outcomes };
  };
}
