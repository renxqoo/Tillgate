/**
 * @ai-gateway/ledger/subscription —— 订阅域出口（S3）。
 *
 * 套餐生命周期动词（purchase/renew/change/cancel/grantPack）+ 额度原语
 * （quota reserve/settle/release，供 billing 域调用）。资金动作全部委托
 * wallet（transfer 现金口径 + tx 注入同生共死）；幂等走 ledger-core
 * （operationId 全局唯一，指纹与旧版一致保重放兼容）。
 * 域内零余额读写——余额的唯一事实在 wallet（plan §1 硬规则）。
 *
 * 装配要求：wallet 的 refTypes 白名单须含 'subscription' 与 'pack'。
 */
import { createDomainOperations } from '../platform/operations.js';
import { applySubscriptionCore } from './purchase.js';
import { changeSubscription } from './change.js';
import { cancelSubscription } from './cancel.js';
import { grantPack } from './pack.js';
import type {
  SubscriptionContext,
  SubscriptionDeps,
  SubscriptionDomain,
} from './types.js';
import { SUBSCRIPTION_OPERATION_KINDS } from './types.js';

export function createSubscriptionDomain(deps: SubscriptionDeps): SubscriptionDomain {
  const ctx: SubscriptionContext = {
    db: deps.db,
    wallet: deps.wallet,
    operations: createDomainOperations(deps.db, SUBSCRIPTION_OPERATION_KINDS),
    effects: deps.effects,
    clock: deps.clock ?? (() => new Date()),
  };
  return {
    purchase: (input) =>
      applySubscriptionCore(ctx, {
        kind: 'subscription.purchase',
        operationId: input.operationId,
        userId: input.userId,
        planId: input.planId,
        subscriptionId: null,
        quantity: input.quantity ?? 1,
        orgId: input.orgId ?? null,
        ensureOrg: input.ensureOrg ?? false,
        adminId: input.adminId ?? null,
      }),
    renew: (input) =>
      applySubscriptionCore(ctx, {
        kind: 'subscription.renew',
        operationId: input.operationId,
        userId: input.userId ?? null,
        planId: null,
        subscriptionId: input.subscriptionId,
        quantity: null, // 沿用原席位
        orgId: null,
        adminId: input.adminId ?? null,
      }),
    change: (input) => changeSubscription(ctx, input),
    cancel: (input) => cancelSubscription(ctx, input),
    grantPack: (input) => grantPack(ctx, input),
  };
}

export {
  renewalStart,
  periodEnd,
} from './period.js';
export {
  remainingQuota,
  remainingValue,
  changeDiff,
} from './proration.js';
export {
  assertChangeEligibility,
  assertSeatsAllowed,
} from './eligibility.js';
export {
  reserveQuota,
  settleQuota,
  releaseQuota,
} from './quota.js';
export type {
  SubscriptionDeps,
  SubscriptionEffects,
  PurchaseInput,
  RenewInput,
  ChangeInput,
  CancelInput,
  PackInput,
  SubscribeResult,
  CancelResult,
  SubscriptionDomain,
} from './types.js';
