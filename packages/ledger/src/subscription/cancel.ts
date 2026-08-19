/** subscription/cancel：取消（CAS 状态 0→2，不涉钱；额度与余额均不动）。 */
import { and, eq } from 'drizzle-orm';
import { userSubscriptions } from '@ai-gateway/db/schema';
import { LedgerError } from '../platform/errors.js';
import { runSubscriptionAudit } from './purchase.js';
import type { CancelInput, CancelResult, SubscriptionContext } from './types.js';

export async function cancelSubscription(
  ctx: SubscriptionContext,
  input: CancelInput,
): Promise<CancelResult> {
  const { receipt, replayed } = await ctx.operations.run({
    operationId: input.operationId,
    kind: 'subscription.cancel',
    fingerprint: {
      kind: 'subscription.cancel',
      userId: null,
      adminId: input.adminId ?? null,
      subscriptionId: input.subscriptionId,
    },
    execute: async (tx) => {
      const changed = await tx
        .update(userSubscriptions)
        .set({ status: 2 })
        .where(
          and(eq(userSubscriptions.id, input.subscriptionId), eq(userSubscriptions.status, 0)),
        )
        .returning({ id: userSubscriptions.id });
      if (changed.length === 0) throw new LedgerError('no_subscription');
      return { subscriptionId: changed[0]!.id };
    },
  });
  await runSubscriptionAudit(ctx, !replayed, {
    adminId: input.adminId ?? null,
    action: 'subscription.cancel',
    targetType: 'subscription',
    targetId: receipt.subscriptionId,
  });
  return { ...receipt, replayed };
}
