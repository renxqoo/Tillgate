/**
 * settlement/process-claim（S6 平移自 billing/processor/process-claim.ts）：
 * 单张认领的结算管线。settleClaim 由装配层注入（billing 域钱包实现）。
 *
 *   decodeReceipt（毒收据 → throw）→ settleClaim（遥测包装可选）
 *   → 成功：usageSettled/balanceChanged effects（safeEffect：2s 超时 + 吞错）
 *   → 失败：finishFailure（分类 → retry_wait/dead 状态迁移 + requestDead 告警）
 *
 * claim_lost = 认领已被并发方拿走（claim 三元组 CAS 0 行命中）——幂等安全，不计数为失败。
 */
import type { Db } from '@ai-gateway/db';
import type {
  BillingEffects,
  SettleClaimResult,
  SettlementClaim,
  SettlementProcessorOptions,
} from '../billing/types.js';
import { decodeReceipt } from './claim.js';
import { finishFailure, safeEffect } from './failure.js';

/** 单据处理管线的四种结局（计数与日志的单一词汇表） */
export type ClaimOutcome = 'settled' | 'retried' | 'dead' | 'claim_lost';

export async function processClaim(
  db: Db,
  settleClaim: (claim: SettlementClaim) => Promise<SettleClaimResult>,
  options: SettlementProcessorOptions,
  effects: BillingEffects | undefined,
  random: () => number,
  claimed: SettlementClaim,
): Promise<ClaimOutcome> {
  try {
    claimed.receipt = decodeReceipt(claimed.receipt);
    const runSettle = () => settleClaim(claimed);
    const settled = await (options.telemetry?.settle
      ? options.telemetry.settle(claimed, runSettle)
      : runSettle());
    if (settled.outcome === 'settled') {
      await safeEffect(
        () =>
          effects?.usageSettled?.({ data: claimed.receipt, result: settled }) ??
          Promise.resolve(),
      );
      await safeEffect(
        () => effects?.balanceChanged?.({ userId: claimed.receipt.userId }) ?? Promise.resolve(),
      );
      return 'settled';
    }
    return 'claim_lost';
  } catch (error) {
    return finishFailure(db, options, effects, random, claimed, error);
  }
}
