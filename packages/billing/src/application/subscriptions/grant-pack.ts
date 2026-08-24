/**
 * grantPack 动词：有效订阅加额（现金口径 transfer，禁透支）——
 * 加油包挂靠有效订阅（行锁），配额加到当前有效订阅（status=0 守卫）。
 */
import { Decimal } from '../../domain/money.js';
import { BillingErrors } from '../../domain/errors.js';
import type { GrantPackInput, GrantPackResult } from './subscriptions.js';
import { chargeCash, type SubscriptionAssembly } from './subscription-shared.js';

// eslint-disable-next-line max-lines-per-function -- 订阅生命周期编排:加额事务体位于边界,oxfmt 换行推超 2 行
export async function grantPack(
  assembly: SubscriptionAssembly,
  input: GrantPackInput,
): Promise<GrantPackResult> {
  const { store, wallet, clock, operations } = assembly;
  const { receipt, replayed } = await operations.run({
    operationId: input.operationId,
    kind: 'pack.grant',
    payload: { userId: input.userId, packId: input.packId },
    execute: async (tx) => {
      const now = clock();
      // 加油包挂靠有效订阅（行锁）；无有效订阅 → no_subscription
      const sub = await store.lockActiveSubscriptionForUser(tx, input.userId, now);
      if (!sub) {
        throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
      }
      const pack = await store.findPlan(tx, input.packId);
      if (!pack) throw BillingErrors.business('plan_not_found', { planId: input.packId });
      if (pack.status !== 0) {
        throw BillingErrors.business('plan_disabled', { planId: input.packId });
      }
      if (pack.kind !== 'pack') {
        throw BillingErrors.business('not_a_pack', { planId: input.packId });
      }
      // 零价加油包是免费额度印刷机（资损红线）——发放必须走现金口径
      if (new Decimal(pack.price).lte(0)) {
        throw BillingErrors.business('plan_not_purchasable', { planId: input.packId });
      }

      const charge = await chargeCash(wallet, tx, {
        userId: input.userId,
        amount: pack.price,
        refId: input.operationId,
        memo: `加油包「${pack.name}」发放`,
        refType: 'pack',
      });
      // 配额加到当前有效订阅（status=0 守卫）；0 行 = 并发取消 → 冲突拒绝
      const added = await store.tryAddQuota(tx, {
        subscriptionId: sub.id,
        quota: pack.quotaAmount,
      });
      if (!added) {
        throw BillingErrors.business('subscription_state', { reason: 'subscription_inactive' });
      }

      return {
        userId: input.userId,
        subscriptionId: sub.id,
        quotaAdded: pack.quotaAmount,
        balanceBefore: charge.balanceBefore,
        balanceAfter: charge.balanceAfter,
      };
    },
  });
  return { ...receipt, replayed };
}
