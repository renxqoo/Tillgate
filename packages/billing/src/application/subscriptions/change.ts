/**
 * change 动词：升档/加席位（行锁新鲜快照折算 → 补差价 max(0, 新总价−剩余价值)）。
 * 组织归属随订阅继承（升档不得把组织订阅变个人订阅）。
 * userId=null 为管理面（免属主检查；指纹仍含发起者防跨键重放）。
 */
import { BillingErrors } from '../../domain/errors.js';
import {
  assertChangeEligibility,
  assertValidQuantity,
  changeDiff,
  remainingValue,
} from '../../domain/subscription/rules.js';
import type { ChangeInput, SubscribeResult } from './subscriptions.js';
import {
  assertPlanPurchasable,
  chargeCash,
  runSubscribeOperation,
  snapshotPlanForQuantity,
  type SubscriptionAssembly,
} from './subscription-shared.js';

// eslint-disable-next-line max-lines-per-function -- 顺序编排/契约签名,拆分需独立契约设计
export async function change(
  assembly: SubscriptionAssembly,
  input: ChangeInput,
): Promise<SubscribeResult> {
  const { store, accounts, wallet, clock } = assembly;
  assertValidQuantity(input.quantity);
  const { receipt, replayed } = await runSubscribeOperation(assembly, {
    operationId: input.operationId,
    kind: 'subscription.change',
    payload: {
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      targetPlanId: input.targetPlanId,
      quantity: input.quantity,
    },
    // eslint-disable-next-line max-lines-per-function -- 顺序编排/契约签名,拆分需独立契约设计
    execute: async (tx) => {
      const now = clock();
      // 折算必须基于行锁后的新鲜快照——无锁读与并发结算竞态会低估剩余价值 → 多收
      const current = await store.lockActiveSubscription(tx, input.subscriptionId);
      if (!current || (input.userId != null && current.userId !== input.userId)) {
        throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
      }
      const currentPlan = await store.findPlan(tx, current.planId);
      const target = await assertPlanPurchasable(assembly, tx, {
        planId: input.targetPlanId,
        userId: current.userId,
        quantity: input.quantity,
      });

      assertChangeEligibility({
        currentSortOrder: currentPlan?.sortOrder ?? null,
        targetSortOrder: target.sortOrder,
        currentQuantity: current.quantity,
        targetQuantity: input.quantity,
      });

      // 补差价 = max(0, 新总价 − 剩余价值)；≤0 免费升级
      const snapshot = snapshotPlanForQuantity(now, target, input.quantity);
      const diff = changeDiff(snapshot.price, remainingValue(current));

      // 旧订阅转到期（保留 used/reserved 供在途请求结算）；0 行 = 并发已改 → 拒绝
      if (
        !(await store.casSubscriptionStatus(tx, {
          subscriptionId: input.subscriptionId,
          from: 0,
          to: 1,
        }))
      ) {
        throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
      }

      // 仅正差价收款；免费升级无资金变动
      let balanceBefore: string | null = null;
      let balanceAfter: string | null = null;
      if (diff.gt(0)) {
        const charge = await chargeCash(wallet, tx, {
          userId: current.userId,
          amount: diff.toString(),
          refId: input.operationId,
          memo: `变更套餐「${currentPlan?.name ?? `#${current.planId}`}」→「${target.name}」×${input.quantity} 补差价 ${diff.toString()}`,
        });
        ({ balanceBefore } = charge);
        ({ balanceAfter } = charge);
      }

      const subscriptionId = await store.insertSubscription(tx, {
        userId: current.userId,
        planId: input.targetPlanId,
        startAt: now,
        endAt: snapshot.endAt,
        quotaAmount: snapshot.quotaAmount,
        quantity: input.quantity,
        price: snapshot.price,
        // 组织归属随订阅继承（升档不得把组织订阅变个人订阅）
        orgId: current.orgId,
      });
      await accounts.rebindCredentials(tx, input.subscriptionId, subscriptionId);

      return {
        userId: current.userId,
        subscriptionId,
        orgId: current.orgId,
        planId: input.targetPlanId,
        planName: target.name,
        quantity: input.quantity,
        startAt: now.toISOString(),
        endAt: snapshot.endAt.toISOString(),
        quotaAmount: snapshot.quotaAmount,
        price: snapshot.price,
        balanceBefore,
        balanceAfter,
      };
    },
  });
  return { ...receipt, replayed };
}
