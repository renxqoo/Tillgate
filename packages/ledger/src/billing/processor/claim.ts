import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { toDecimal } from '@ai-gateway/money';
import { PoisonReceiptError } from '../errors.js';
import type { SettlementClaim, SettlementProcessorOptions, UsageReceipt } from '../types.js';

/** 结算认领（拆自 processor.ts，行为零变更）：FOR UPDATE SKIP LOCKED 批量领取
 *  settlement_pending/retry_wait → processing，写 claim 三元组（owner/token/until）
 *  + revision 乐观锁。多副本安全：skip locked 天然分片。 */

export type ClaimedRow = {
  request_id: string;
  claim_token: string;
  revision: number | string;
  settlement_attempts: number | string;
  receipt: UsageReceipt | string;
  claim_until: Date | string;
  trace_parent: string | null;
};

export function decodeReceipt(value: UsageReceipt | string): UsageReceipt {
  const receipt = typeof value === 'string' ? (JSON.parse(value) as UsageReceipt) : value;
  const usage = receipt?.usage;
  const numeric = usage
    ? [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, receipt.durationMs]
    : [];
  const prices = receipt
    ? [receipt.inputPrice, receipt.outputPrice, receipt.cacheInputPrice, receipt.coefficient]
    : [];
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    typeof receipt.requestId !== 'string' ||
    !Number.isInteger(receipt.userId) ||
    receipt.userId <= 0 ||
    !usage ||
    numeric.some((item) => !Number.isFinite(item) || item < 0) ||
    prices.some((item) => typeof item !== 'string' || !toDecimal(item).isFinite()) ||
    typeof receipt.externalModel !== 'string' ||
    typeof receipt.realModel !== 'string' ||
    !Number.isInteger(receipt.mappingId) ||
    (receipt.billingPolicyFingerprint !== null &&
      !/^[a-f0-9]{64}$/.test(receipt.billingPolicyFingerprint))
  ) {
    throw new PoisonReceiptError();
  }
  return receipt;
}

export async function claim(
  db: Db,
  options: SettlementProcessorOptions,
  clock: () => Date,
  requestIds?: string[],
): Promise<SettlementClaim[]> {
  const limit = Math.min(options.batchSize, options.concurrency ?? 1);
  const idFilter = requestIds?.length
    ? sql`and request_id in (${sql.join(
        requestIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const rows = await db.transaction(async (tx) => {
    const result = await tx.execute<ClaimedRow>(sql`
      with candidates as (
        select request_id
        from billing_requests
        where status in ('settlement_pending', 'retry_wait')
          and (next_settlement_at is null or next_settlement_at <= clock_timestamp())
          ${idFilter}
        order by next_settlement_at nulls first, created_at
        for update skip locked
        limit ${limit}
      )
      update billing_requests b
      set status = 'processing',
          revision = b.revision + 1,
          settlement_attempts = b.settlement_attempts + 1,
          claim_owner = ${options.ownerId},
          claim_token = gen_random_uuid(),
          claim_until = clock_timestamp() + (${options.claimLeaseMs} * interval '1 millisecond'),
          failure_class = null,
          last_error = null,
          updated_at = clock_timestamp()
      from candidates c
      where b.request_id = c.request_id
      returning b.request_id, b.claim_token, b.revision, b.settlement_attempts,
                b.receipt, b.claim_until, b.trace_parent
    `);
    return result.rows;
  });
  return rows.map((row) => ({
    requestId: row.request_id,
    ownerId: options.ownerId,
    claimToken: row.claim_token,
    revision: Number(row.revision),
    attempt: Number(row.settlement_attempts),
    receipt: row.receipt as unknown as UsageReceipt,
    claimedAt: clock(),
    claimUntil: new Date(row.claim_until),
    traceParent: row.trace_parent,
  }));
}
