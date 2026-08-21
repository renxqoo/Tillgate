/**
 * channel-budget 装配出口（网关/结算侧最小集 = closeout 两步）：
 * releaseExposure（敞口归还）+ deductBudget（成本扣减熔断）。
 * recharge（进货）/ adjust（调账）是 admin-api 的用例——角色裁剪 2026-08-19 移出，将来在此扩展。
 */
import { createDeductBudget } from './deduct-budget.js';
import { createReleaseExposure } from './release-exposure.js';
import type { ChannelBudgetEnv } from './env.js';

export type { ChannelBudgetEnv } from './env.js';
export { createReleaseExposure, type ReleaseExposure } from './release-exposure.js';
export { createDeductBudget, type DeductBudget } from './deduct-budget.js';

export interface ChannelBudgetCloseout {
  releaseExposure: ReturnType<typeof createReleaseExposure>;
  deductBudget: ReturnType<typeof createDeductBudget>;
}

export function createChannelBudgetUseCases(env: ChannelBudgetEnv): ChannelBudgetCloseout {
  return {
    releaseExposure: createReleaseExposure(env),
    deductBudget: createDeductBudget(env),
  };
}
