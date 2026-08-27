/** 兑换批次详情 */
import { BillingErrors } from '../../domain/errors.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { RedeemBatchRecord, RedeemCodeStore } from '../../ports/payment-ports.js';

export async function batchDetail(
  env: { store: Pick<BillingStore, 'read'>; codes: Pick<RedeemCodeStore, 'findBatch'> },
  batchId: number,
): Promise<RedeemBatchRecord> {
  const row = await env.store.read((conn) => env.codes.findBatch(conn, batchId));
  if (row === null) {
    throw BillingErrors.business('redeem_batch_not_found', { batchId: String(batchId) });
  }
  return row;
}
