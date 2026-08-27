/** 订阅管理列表（users/plans 富化与剩余额度投影在 store 物理层完成） */
import type { AdminSubscriptionRow, BillingStore } from '../../ports/billing-store.js';

export interface AdminListSubscriptionsInput {
  q?: string;
  planId?: number;
  userId?: number;
  status?: number;
  sortBy: 'id' | 'createdAt' | 'startAt' | 'endAt' | 'usedAmount';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export function adminListSubscriptions(
  env: { store: Pick<BillingStore, 'read' | 'listAdminSubscriptions'> },
  input: AdminListSubscriptionsInput,
): Promise<{ rows: AdminSubscriptionRow[]; total: number }> {
  return env.store.read((conn) => env.store.listAdminSubscriptions(conn, input));
}
