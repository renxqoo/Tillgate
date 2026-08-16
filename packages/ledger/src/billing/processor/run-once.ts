import type { Db } from '@ai-gateway/db';
import type {
  BillingEffects,
  SettlementProcessorOptions,
  SettlementRunResult,
} from '../types.js';
import { claim } from './claim.js';
import { withClaimRenewal } from './claim-lease.js';
import { processClaim, type ClaimOutcome } from './process-claim.js';

/**
 * 结算批次编排（拆自 createBillingProcessor.runOnce，行为零变更）：
 *
 *   claim（批量认领）→ withClaimRenewal（租约保活）{
 *     并发逐单 processClaim（结算管线）→ 结局计数
 *   }
 *
 * claim() 抛错直接上抛（DB 级故障由 worker 循环层处置）；毒收据的解码
 * 发生在逐单管线内（decodeReceipt），由 finishFailure 转 dead。
 */
export async function runOnce(
  db: Db,
  options: SettlementProcessorOptions,
  effects: BillingEffects | undefined,
  clock: () => Date,
  random: () => number,
  requestIds?: string[],
): Promise<SettlementRunResult> {
  const claims = await claim(db, options, clock, requestIds);
  const result: SettlementRunResult = {
    claimed: claims.length,
    settled: 0,
    retried: 0,
    dead: 0,
    claimLost: 0,
  };
  await withClaimRenewal(db, options, claims, async () => {
    await Promise.all(
      claims.map(async (claimed) => {
        const outcome: ClaimOutcome = await processClaim(db, options, effects, random, claimed);
        if (outcome === 'settled') result.settled += 1;
        else if (outcome === 'retried') result.retried += 1;
        else if (outcome === 'dead') result.dead += 1;
        else result.claimLost += 1;
      }),
    );
  });
  return result;
}
