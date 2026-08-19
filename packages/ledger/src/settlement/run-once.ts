/**
 * settlement/run-once（S6 平移自 billing/processor/run-once.ts）：结算批次编排。
 * settleClaim 由装配层注入（billing 域钱包实现）。
 */
import type { Db } from '@ai-gateway/db';
import type {
  BillingEffects,
  SettleClaimResult,
  SettlementClaim,
  SettlementProcessorOptions,
  SettlementRunResult,
} from '../billing/types.js';
import { claim } from './claim.js';
import { withClaimRenewal } from './claim-lease.js';
import { processClaim, type ClaimOutcome } from './process-claim.js';

export async function runOnce(
  db: Db,
  settleClaim: (claim: SettlementClaim) => Promise<SettleClaimResult>,
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
        const outcome: ClaimOutcome = await processClaim(
          db,
          settleClaim,
          options,
          effects,
          random,
          claimed,
        );
        if (outcome === 'settled') result.settled += 1;
        else if (outcome === 'retried') result.retried += 1;
        else if (outcome === 'dead') result.dead += 1;
        else result.claimLost += 1;
      }),
    );
  });
  return result;
}
