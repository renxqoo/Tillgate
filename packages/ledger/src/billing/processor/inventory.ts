import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import type { BillingInventory, SettlementProcessorOptions } from '../types.js';

/** 库存与停机归还（拆自 processor.ts，行为零变更）。 */

export async function inventory(db: Db, clock: () => Date): Promise<BillingInventory> {
  const now = clock();
  const rows = await db.execute<{
    pending: string;
    processing: string;
    retrying: string;
    dead: string;
    oldest_pending_at: Date | string | null;
  }>(sql`
    select
      count(*) filter (where status = 'settlement_pending')::text as pending,
      count(*) filter (where status = 'processing')::text as processing,
      count(*) filter (where status = 'retry_wait')::text as retrying,
      count(*) filter (where status = 'dead')::text as dead,
      min(created_at) filter (where status in ('settlement_pending','processing','retry_wait')) as oldest_pending_at
    from billing_requests
  `);
  const row = rows.rows[0]!;
  const oldest = row.oldest_pending_at
    ? new Date(row.oldest_pending_at).getTime()
    : now.getTime();
  return {
    pending: Number(row.pending),
    processing: Number(row.processing),
    retrying: Number(row.retrying),
    dead: Number(row.dead),
    oldestPendingMs: Math.max(0, now.getTime() - oldest),
  };
}

/** 优雅停机：把本副本持有的 processing 认领归还 retry_wait（立即可被其他副本接手） */
export async function abandonOwnedClaims(
  db: Db,
  options: SettlementProcessorOptions,
  clock: () => Date,
): Promise<number> {
  const now = clock();
  const changed = await db
    .update(billingRequests)
    .set({
      status: 'retry_wait',
      revision: sql`${billingRequests.revision} + 1`,
      nextSettlementAt: now,
      claimOwner: null,
      claimToken: null,
      claimUntil: null,
      failureClass: 'claim_expired',
      lastError: 'worker shutdown returned claim',
      updatedAt: now,
    })
    .where(
      and(
        eq(billingRequests.status, 'processing'),
        eq(billingRequests.claimOwner, options.ownerId),
      ),
    )
    .returning({ requestId: billingRequests.requestId });
  return changed.length;
}
