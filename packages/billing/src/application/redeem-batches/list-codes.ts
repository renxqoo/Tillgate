/** 批内码列表（哈希脱敏在 presenter——明文不存在于库） */
import { BillingErrors } from '../../domain/errors.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { RedeemCodeRecord, RedeemCodeStore } from '../../ports/payment-ports.js';

export interface ListCodesQuery {
  batchId: number;
  status?: number;
  sortBy: 'id' | 'usedAt';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export async function listCodes(
  env: {
    store: Pick<BillingStore, 'read'>;
    codes: Pick<RedeemCodeStore, 'findBatch' | 'listCodes'>;
  },
  query: ListCodesQuery,
): Promise<{ rows: RedeemCodeRecord[]; total: number }> {
  const batch = await env.store.read((conn) => env.codes.findBatch(conn, query.batchId));
  if (batch === null) {
    throw BillingErrors.business('redeem_batch_not_found', { batchId: String(query.batchId) });
  }
  return env.store.read((conn) => env.codes.listCodes(conn, query));
}
