/**
 * cancel 动词：CAS 0→2，无资金变动——剩余额度作废（不退款）。
 * 仅有效订阅可取消；幂等重放走 operations 回执。
 */
import { BillingErrors } from '../../domain/errors.js';
import type { CancelInput } from './subscriptions.js';
import type { SubscriptionAssembly } from './subscription-shared.js';

export async function cancel(
  assembly: SubscriptionAssembly,
  input: CancelInput,
): Promise<{ subscriptionId: number; replayed: boolean }> {
  const { receipt, replayed } = await assembly.operations.run({
    operationId: input.operationId,
    kind: 'subscription.cancel',
    payload: { subscriptionId: input.subscriptionId },
    execute: async (tx) => {
      // 仅有效订阅可取消；0 行 = 不存在/已到期/已取消（幂等重放走 operations 回执）
      const cancelled = await assembly.store.casSubscriptionStatus(tx, {
        subscriptionId: input.subscriptionId,
        from: 0,
        to: 2,
      });
      if (!cancelled) {
        throw BillingErrors.business('subscription_state', { reason: 'no_subscription' });
      }
      return { subscriptionId: input.subscriptionId };
    },
  });
  return { subscriptionId: receipt.subscriptionId, replayed };
}
