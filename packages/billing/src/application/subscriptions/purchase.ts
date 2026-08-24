/**
 * purchase 动词：余额现金购买（禁透支）→ 订阅行（团队套餐组织同事务创建）。
 * 竞态：「单有效订阅」部分唯一索引兜底 → already_subscribed（事务回滚可安全重试）。
 */
import { randomUUID } from 'node:crypto';
import { BillingErrors } from '../../domain/errors.js';
import { assertValidQuantity } from '../../domain/subscription/rules.js';
import type { PurchaseInput, SubscribeResult } from './subscriptions.js';
import {
  assertPlanPurchasable,
  chargeCash,
  runSubscribeOperation,
  snapshotPlanForQuantity,
  type SubscriptionAssembly,
} from './subscription-shared.js';

// eslint-disable-next-line max-lines-per-function -- 存量棘轮(铁律22⑥):顺序编排/契约签名,拆分需独立契约裁决
export async function purchase(
  assembly: SubscriptionAssembly,
  input: PurchaseInput,
): Promise<SubscribeResult> {
  const { store, accounts, wallet, clock } = assembly;
  const { receipt, replayed } = await runSubscribeOperation(assembly, {
    operationId: input.operationId,
    kind: 'subscription.purchase',
    payload: {
      userId: input.userId,
      planId: input.planId,
      quantity: input.quantity ?? 1,
    },
    // eslint-disable-next-line max-lines-per-function, max-statements -- 存量棘轮(铁律22⑥):顺序编排/契约签名,拆分需独立契约裁决
    execute: async (tx) => {
      const now = clock();
      const { userId } = input;
      const quantity = input.quantity ?? 1;
      assertValidQuantity(quantity);
      // C4：惰性翻转「已自然到期但 status 仍 0」——不翻则新购买撞唯一索引死锁
      await store.expireLapsedSubscriptions(tx, userId, now);
      const active = await store.lockActiveSubscriptionForUser(tx, userId, now);
      if (active) {
        throw BillingErrors.business('subscription_state', { reason: 'already_subscribed' });
      }
      const { planId } = input;
      const startAt = now;

      if (!(await accounts.userExists(tx, userId))) {
        throw BillingErrors.business('user_not_found', { userId });
      }
      const plan = await assertPlanPurchasable(assembly, tx, { planId, userId, quantity });

      // 团队套餐的组织在事务内创建（重放不刷行——operations 占位先行）
      let orgId: number | null = null;
      if (input.ensureOrg && plan.allowSeats) {
        orgId = await accounts.insertOrgWithOwner(tx, {
          name: `组织-${randomUUID().slice(0, 6)}`,
          ownerUserId: userId,
        });
      }

      // 总价 = 档价 × 席位；总额度 = 档额度 × 席位（快照）
      const snapshot = snapshotPlanForQuantity(startAt, plan, quantity);
      const charge = await chargeCash(wallet, tx, {
        userId,
        amount: snapshot.price,
        refId: input.operationId,
        memo: `购买套餐「${plan.name}」×${quantity}`,
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
