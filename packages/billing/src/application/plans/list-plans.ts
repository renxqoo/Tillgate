/** 套餐目录管理列表（q 过滤 + 白名单排序 + 分页——口径由调用方收口） */
import type { BillingStore, PlanRecord } from '../../ports/billing-store.js';

export interface ListPlansQuery {
  q?: string;
  sortBy: 'id' | 'name' | 'status' | 'price' | 'sortOrder';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export function listPlans(
  env: { store: Pick<BillingStore, 'read' | 'listAdminPlans'> },
  query: ListPlansQuery,
): Promise<{ rows: PlanRecord[]; total: number }> {
  return env.store.read((conn) => env.store.listAdminPlans(conn, query));
}
