/**
 * 结算驱动（2026-08-26 BullMQ 增量重写）：批量结算 processor ——
 * 定向认领（requestIds=[id]；空认领 = 已终态/他方持有，幂等完成）+
 * 捎带认领至多 batchSize-1 条 due（SKIP LOCKED 多副本安全）→
 * settleClaims 批量同事务（账户行锁一次拿放）；
 * 批内毒账单整批回滚 → 回退逐张 processClaim 隔离（失败策略/死信判定
 * 全在 @tillgate/billing，与调度层无关）。未知异常不外抛（记日志返回
 * unknown-failure）——调用方（BullMQ Worker / 直驱 runner）决定重投；
 * 毒账单绝不外溢成进程级故障（live-fire F-1 语义）。
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
  readonly settlement: Pick<SettlementApi, 'claim' | 'settleClaims' | 'processClaim'>;
  readonly ownerId: string;
  readonly claimLeaseMs: number;
  /** 批量结算每轮上限（含被通知的这条；1 = 关闭批量）。 */
  readonly batchSize: number;
  readonly onError: (error: unknown, context: string) => void;
}

function toOutcome(result: {
  outcome: 'settled' | 'already_settled' | 'claim_lost';
}): 'settled' | 'claim_lost' {
  return result.outcome === 'claim_lost' ? 'claim_lost' : 'settled';
}

/** 单条结算驱动：已知结局透传；未知异常吞掉并标记（重投决策归调用方） */
export function createSettlementProcessor(deps: SettlementProcessorDeps) {
  return async function processSettlementRequest(
    requestId: string,
  ): Promise<SettlementProcessOutcome> {
    try {
      const claims = await deps.settlement.claim({
        ownerId: deps.ownerId,
        batchSize: 1,
        claimLeaseMs: deps.claimLeaseMs,
        requestIds: [requestId],
      });
      const [notified] = claims;
      if (notified == null) return 'claim_lost';
      // 捎带批量：同轮再认领至多 batchSize-1 条 due——结算吞吐瓶颈在
      // platform_revenue 单行串行化，批内共享事务摊薄锁成本（多副本由
      // SKIP LOCKED 天然互斥）。
      const extras =
        deps.batchSize > 1
          ? await deps.settlement.claim({
              ownerId: deps.ownerId,
              batchSize: deps.batchSize - 1,
              claimLeaseMs: deps.claimLeaseMs,
            })
          : [];
      const batch = [notified, ...extras];
      if (batch.length > 1) {
        try {
          const [notifiedResult] = await deps.settlement.settleClaims(batch);
          if (notifiedResult != null) return toOutcome(notifiedResult);
        } catch (error) {
          // 批内毒账单：整批已回滚，逐张回退隔离（失败分类归 processClaim）
          deps.onError(error, `settlement batch fallback request=${requestId}`);
        }
      }
      return await deps.settlement.processClaim(notified);
    } catch (error) {
      deps.onError(error, `settlement process request=${requestId}`);
      return 'unknown-failure';
    }
  };
}

export interface SettlementDirectJobDeps extends SettlementProcessorDeps {
  readonly settlement: Pick<
    SettlementApi,
    'claim' | 'settleClaims' | 'processClaim' | 'listDueRequestIds'
  >;
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
