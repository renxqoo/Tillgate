/**
 * renew 动词：顺延续费（未到期从旧 end 起）——旧订阅 CAS 转到期 + 新行 + 凭证改绑。
 * userId=null 为管理面直续（免属主检查；指纹仍含发起者防跨键重放）。
 * 竞态：「单有效订阅」部分唯一索引兜底 → already_subscribed（事务回滚可安全重试）。
 */
import { BillingErrors } from '../../domain/errors.js';
import { renewalStart } from '../../domain/subscription/rules.js';
import type { RenewInput, SubscribeResult } from './subscriptions.js';
import {
  assertPlanPurchasable,
  chargeCash,
  runSubscribeOperation,
  snapshotPlanForQuantity,
  type SubscriptionAssembly,
} from './subscription-shared.js';

// eslint-disable-next-line max-lines-per-function -- 存量棘轮(铁律22⑥):顺序编排/契约签名,拆分需独立契约裁决
export async function renew(
  assembly: SubscriptionAssembly,
  input: RenewInput,
): Promise<SubscribeResult> {
  const { store, accounts, wallet, clock } = assembly;
  const { receipt, replayed } = await runSubscribeOperation(assembly, {
    operationId: input.operationId,
    kind: 'subscription.renew',
    payload: { userId: input.userId, subscriptionId: input.subscriptionId },
    // eslint-disable-next-line max-lines-per-function, max-statements -- 存量棘轮(铁律22⑥):顺序编排/契约签名,拆分需独立契约裁决
    execute: async (tx) => {
      const now = clock();
      const sub = await store.lockActiveSubscription(tx, input.subscriptionId);
      if (!sub || (input.userId != null && sub.userId !== input.userId)) {
        throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
      }
      const { userId, planId, quantity, orgId } = sub; // 续费沿用原席位
      const startAt = renewalStart(sub.endAt, now);
      // 旧订阅转到期；0 行 = 状态已被并发改变，不得复活
      if (
        !(await store.casSubscriptionStatus(tx, {
          subscriptionId: input.subscriptionId,
          from: 0,
          to: 1,
        }))
      ) {
        throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
      }

      if (!(await accounts.userExists(tx, userId))) {
        throw BillingErrors.business('user_not_found', { userId });
      }
      const plan = await assertPlanPurchasable(assembly, tx, { planId, userId, quantity });

      // 总价 = 档价 × 席位；总额度 = 档额度 × 席位（快照）；组织归属沿用旧订阅
      const snapshot = snapshotPlanForQuantity(startAt, plan, quantity);
      const charge = await chargeCash(wallet, tx, {
        userId,
        amount: snapshot.price,
        refId: input.operationId,
        memo: `续费套餐「${plan.name}」×${quantity}`,
      });

      const subscriptionId = await store.insertSubscription(tx, {
        userId,
        planId,
        startAt,
        endAt: snapshot.endAt,
        quotaAmount: snapshot.quotaAmount,
        quantity,
        price: snapshot.price,
        orgId,
      });

      // 续费：绑定旧订阅的凭证改绑到新订阅（续费不打断现有 key/app）
      await accounts.rebindCredentials(tx, input.subscriptionId, subscriptionId);

      return {
        userId,
        subscriptionId,
        orgId,
        planId,
        planName: plan.name,
        quantity,
        startAt: startAt.toISOString(),
        endAt: snapshot.endAt.toISOString(),
        quotaAmount: snapshot.quotaAmount,
        price: snapshot.price,
        balanceBefore: charge.balanceBefore,
        balanceAfter: charge.balanceAfter,
      };
    },
  });
  return { ...receipt, replayed };
}
