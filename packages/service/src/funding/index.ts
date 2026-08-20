/**
 * funding 装配出口：契约 + 两个初始来源 + 不可变注册表 + 瀑布两阶段（plan/commit）+ 释放。
 * 加促销池 = promo-source.ts 工厂 + 装配数组加一项（管线零改动，§3.5）。
 */
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { WalletApi } from '../wallet/wallet.js';
import { createPaygSource } from './payg-source.js';
import { createFundingRegistry, type FundingRegistry } from './registry.js';
import { createSubscriptionSource } from './subscription-source.js';

export type {
  FundingSource,
  FundingSourceContext,
  ProbeInput,
  ReserveInput,
  SourceReservation,
  SourceType,
} from './source.js';
export { createPaygSource } from './payg-source.js';
export { createSubscriptionSource } from './subscription-source.js';
export { createFundingRegistry, type FundingRegistry } from './registry.js';
export type { FundingPlan, FundingPlanEntry, PlanFundingInput } from './plan.js';
export { planFunding } from './plan.js';
export { commitFunding } from './commit.js';
export type { ReleaseAllInput } from './release.js';
export { createReleaseAllReservations } from './release.js';

/** 默认来源集装配（过渡期冻结为 {subscription, payg}——§4.4，promo 等 worker 后再加入数组） */
export function createDefaultFundingRegistry(deps: {
  wallet: WalletApi;
  repos?: Repositories;
}): FundingRegistry {
  const repos = deps.repos ?? createRepositories();
  return createFundingRegistry([
    createSubscriptionSource({ repos, wallet: deps.wallet }),
    createPaygSource({ wallet: deps.wallet, repos }),
  ]);
}
