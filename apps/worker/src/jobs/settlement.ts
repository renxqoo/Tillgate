/**
 * 结算批次 job（v1 run-once.ts 语义平移；业务在 billing settlement facade）：
 * 认领（SKIP LOCKED）→ 租约保活（interval 续租，失败不杀批次——CAS 五元组 +
 * usage_logs 唯一约束兜底）→ 并行 processClaim → 计数回执。
 * 恢复 job：三类滞留单兜底（authorized 过期 / in_flight 租约过期 / processing
 * 认领过期——recover 用例语义）。
 */
import type { RecoveryRunResult, SettlementApi, SettlementClaim } from '@tillgate/billing';

interface SettlementBatchResult {
  claimed: number;
  settled: number;
  retried: number;
  dead: number;
  claimLost: number;
}

type SettlementBatchJob = () => Promise<SettlementBatchResult>;
type RecoveryJob = () => Promise<RecoveryRunResult>;

export function createSettlementBatchJob(deps: {
  settlement: Pick<SettlementApi, 'claim' | 'renewClaims' | 'processClaim'>;
  ownerId: string;
  batchSize: number;
  claimLeaseMs: number;
}): SettlementBatchJob {
  return async function runSettlementBatch(): Promise<SettlementBatchResult> {
    const claims = await deps.settlement.claim({
      ownerId: deps.ownerId,
      batchSize: deps.batchSize,
      claimLeaseMs: deps.claimLeaseMs,
    });
    if (claims.length === 0) {
      return { claimed: 0, settled: 0, retried: 0, dead: 0, claimLost: 0 };
    }
    const result: SettlementBatchResult = {
      claimed: claims.length,
      settled: 0,
      retried: 0,
      dead: 0,
      claimLost: 0,
    };
    // 租约保活：批次运行期间按 claimLeaseMs/3 续租（v1 同节奏；unref 不阻停机）
    const tokens = claims.map((claim: SettlementClaim) => claim.claimToken);
    const renewTimer = setInterval(
      () => {
        void deps.settlement
          .renewClaims({ ownerId: deps.ownerId, tokens, claimLeaseMs: deps.claimLeaseMs })
          .catch(() => undefined);
      },
      Math.max(1_000, Math.floor(deps.claimLeaseMs / 3)),
    );
    renewTimer.unref();
    try {
      const outcomes = await Promise.all(
        claims.map(async (claim) => deps.settlement.processClaim(claim)),
      );
      for (const outcome of outcomes) {
        if (outcome === 'settled') result.settled += 1;
        else if (outcome === 'retried') result.retried += 1;
        else if (outcome === 'dead') result.dead += 1;
        else result.claimLost += 1;
      }
      return result;
    } finally {
      clearInterval(renewTimer);
    }
  };
}

export function createRecoveryJob(deps: {
  settlement: Pick<SettlementApi, 'recover'>;
  batchSize: number;
}): RecoveryJob {
  return async function runRecovery() {
    return await deps.settlement.recover({ batchSize: deps.batchSize });
  };
}
