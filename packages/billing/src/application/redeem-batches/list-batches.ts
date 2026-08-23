/** 兑换批次管理列表（U6） */
import type { BillingStore } from '../../ports/billing-store.js';
import type { RedeemBatchRecord, RedeemCodeStore } from '../../ports/payment-ports.js';

export interface ListBatchesQuery {
  q?: string;
  sortBy: 'id' | 'name' | 'amount' | 'createdAt';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export function listBatches(
  env: { store: Pick<BillingStore, 'read'>; codes: Pick<RedeemCodeStore, 'listBatches'> },
  query: ListBatchesQuery,
): Promise<{ rows: RedeemBatchRecord[]; total: number }> {
  return env.store.read((conn) => env.codes.listBatches(conn, query));
}
