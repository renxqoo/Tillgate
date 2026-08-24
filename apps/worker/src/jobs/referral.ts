/**
 * 佣金日结 job（驱动壳）：聚合/入账/幂等在 billing referral-commission 用例；
 * 费率与幂等键词表的单一真相在 accounts domain（装配桥接注入 rate/refIdOf）。
 */
import type { ReferralCommissionResult } from '@tillgate/billing';

type ReferralJob = () => Promise<ReferralCommissionResult>;

export function createReferralJob(deps: {
  run: () => Promise<ReferralCommissionResult>;
}): ReferralJob {
  return async function runReferral() {
    return await deps.run();
  };
}
