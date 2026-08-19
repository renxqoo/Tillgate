/**
 * 结算批次编排（run-once）：认领一批 → 逐张 processClaim（失败自动分类退避/死信）。
 * 长批次租约保活防 recover 误回收（双扣防线第二层：即便保活缺席，
 * 结算 CAS 五元组与 usage_logs 唯一约束仍结构性防双扣——保活只是省掉白干的回滚重试）。
 * 批次计数回执供指标。
 */
import type { SettlementDomain } from '@ai-gateway/service';
import type { RunContext } from '@ai-gateway/service';

export interface SettlementRunResult {
  claimed: number;
  settled: number;
  retried: number;
  dead: number;
  claimLost: number;
}

export interface RunOnceDeps {
  settlement: SettlementDomain;
  ownerId: string;
  batchSize: number;
  claimLeaseMs: number;
}

export function createRunOnce(deps: RunOnceDeps) {
  return async function runOnce(ctx: RunContext): Promise<SettlementRunResult> {
    const claims = await deps.settlement.claim(ctx, {
      ownerId: deps.ownerId,
      batchSize: deps.batchSize,
      claimLeaseMs: deps.claimLeaseMs,
    });
    const result: SettlementRunResult = {
      claimed: claims.length,
      settled: 0,
      retried: 0,
      dead: 0,
      claimLost: 0,
    };
    if (claims.length === 0) return result;

    // 租约保活：批次耗时可能逼近租约（慢结算/大批次）——周期续租防 recover 误回收
    const tokens = claims.map((claim) => claim.claimToken);
    const renewTimer = setInterval(() => {
      void deps.settlement
        .renewClaims(ctx, { ownerId: deps.ownerId, tokens, claimLeaseMs: deps.claimLeaseMs })
        .catch(() => undefined); // 续租失败不杀批次：CAS/唯一约束兜底
    }, Math.max(1_000, Math.floor(deps.claimLeaseMs / 3)));
    renewTimer.unref?.();

    try {
      await Promise.all(
        claims.map(async (claim) => {
          const outcome = await deps.settlement.processClaim(ctx, claim);
          if (outcome === 'settled') result.settled += 1;
          else if (outcome === 'retried') result.retried += 1;
          else if (outcome === 'dead') result.dead += 1;
          else result.claimLost += 1;
        }),
      );
    } finally {
      clearInterval(renewTimer);
    }
    return result;
  };
}
