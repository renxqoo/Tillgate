/** 套餐更新（kind 不可变——周期校验按「当前 kind ∪ 补丁」合并口径） */
import { BillingErrors } from '../../domain/errors.js';
import type { BillingStore, PlanRecord } from '../../ports/billing-store.js';
import { assertKindPeriodConsistency } from './plan-rules.js';

export interface UpdatePlanInput {
  planId: number;
  patch: {
    name?: string;
    sortOrder?: number | null;
    price?: string;
    periodDays?: number;
    quotaAmount?: string;
    allowSeats?: boolean;
    status?: number;
  };
}

export async function updatePlan(
  env: { store: Pick<BillingStore, 'read' | 'transaction' | 'findPlan' | 'patchPlan'> },
  input: UpdatePlanInput,
): Promise<PlanRecord> {
  const current = await env.store.read((conn) => env.store.findPlan(conn, input.planId));
  if (current === null) {
    throw BillingErrors.business('plan_not_found', { planId: input.planId });
  }
  const periodDays = assertKindPeriodConsistency(
    current.kind,
    input.patch.periodDays ?? current.periodDays,
  );
  const row = await env.store.transaction((tx) =>
    env.store.patchPlan(tx, {
      planId: input.planId,
      patch: { ...input.patch, periodDays },
    }),
  );
  if (row === null) {
    throw BillingErrors.business('plan_not_found', { planId: input.planId });
  }
  return row;
}
