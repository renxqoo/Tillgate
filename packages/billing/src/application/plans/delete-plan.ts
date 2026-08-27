/** 套餐删除（守卫:任何状态的订阅引用(含历史)→ plan_in_use;审计后置归 app） */
import { BillingErrors } from '../../domain/errors.js';
import type { BillingStore } from '../../ports/billing-store.js';

export async function deletePlan(
  env: {
    store: Pick<
      BillingStore,
      'read' | 'transaction' | 'countSubscriptionsAnyStatus' | 'deletePlan'
    >;
  },
  input: { planId: number },
): Promise<{ ok: true }> {
  const refs = await env.store.read((conn) =>
    env.store.countSubscriptionsAnyStatus(conn, input.planId),
  );
  if (refs > 0) {
    throw BillingErrors.business('plan_in_use', { planId: input.planId, refs: String(refs) });
  }
  const removed = await env.store.transaction((tx) => env.store.deletePlan(tx, input.planId));
  if (!removed) {
    throw BillingErrors.business('plan_not_found', { planId: input.planId });
  }
  return { ok: true };
}
