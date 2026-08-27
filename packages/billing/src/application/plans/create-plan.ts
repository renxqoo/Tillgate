/** 套餐创建（kind×周期一致性;审计后置归 app 装配层） */
import type { BillingStore, PlanRecord } from '../../ports/billing-store.js';
import { assertKindPeriodConsistency } from './plan-rules.js';

export interface CreatePlanInput {
  name: string;
  kind?: 'subscription' | 'pack';
  sortOrder?: number | null;
  price: string;
  periodDays?: number;
  quotaAmount: string;
  allowSeats?: boolean;
}

export async function createPlan(
  env: { store: Pick<BillingStore, 'transaction' | 'insertPlan'> },
  input: CreatePlanInput,
): Promise<PlanRecord> {
  const kind = input.kind ?? 'subscription';
  const periodDays = assertKindPeriodConsistency(kind, input.periodDays);
  return env.store.transaction((tx) =>
    env.store.insertPlan(tx, {
      name: input.name,
      kind,
      sortOrder: input.sortOrder ?? null,
      price: input.price,
      periodDays,
      quotaAmount: input.quotaAmount,
      allowSeats: input.allowSeats ?? false,
    }),
  );
}
