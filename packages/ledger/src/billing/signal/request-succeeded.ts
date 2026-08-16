import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import type { BillingEvent, BillingQuote, BillingSignalResult } from '../types.js';
import { fingerprint, validateReceipt } from '../quote.js';
import { BillingStateConflictError } from '../errors.js';

/** request.succeeded 事件（判别收窄后的精确类型） */
export type RequestSucceededEvent = Extract<BillingEvent, { type: 'request.succeeded' }>;

/**
 * request.succeeded：落 durable receipt → settlement_pending（worker 结算队列入口）。
 *
 * 验收链：requestId 一致 → 同指纹重放幂等（settlement_pending/settled 直接返回）
 * → 状态必须处于 authorized/in_flight → validateReceipt（用户一致/usage 自洽/
 * 估算归属合法/价格快照命中授权候选）→ 条件更新落收据。
 * 本处理器的所有路径都返回或抛出——不存在「未命中转移」的中间态（与 started/
 * renewed/failed 不同），最后的冲突直接抛 BillingStateConflictError。
 */
export async function applyRequestSucceeded(
  db: Db,
  now: Date,
  event: RequestSucceededEvent,
): Promise<BillingSignalResult> {
  if (event.receipt.requestId !== event.requestId) {
    throw new BillingStateConflictError(event.requestId, 'receipt requestId mismatch');
  }
  const receiptFp = fingerprint(event.receipt);
  const authorized = await db.query.billingRequests.findFirst({
    where: eq(billingRequests.requestId, event.requestId),
    columns: {
      userId: true,
      quote: true,
      status: true,
      receiptFingerprint: true,
    },
  });
  if (!authorized) {
    throw new BillingStateConflictError(event.requestId, 'billing request missing');
  }
  if (
    ['settlement_pending', 'settled'].includes(authorized.status) &&
    authorized.receiptFingerprint === receiptFp
  ) {
    return { changed: false, status: authorized.status, replayed: true };
  }
  if (!['authorized', 'in_flight'].includes(authorized.status)) {
    throw new BillingStateConflictError(event.requestId, 'receipt conflicts with billing state');
  }
  validateReceipt(authorized.userId, authorized.quote as unknown as BillingQuote, event.receipt);
  const changed = await db
    .update(billingRequests)
    .set({
      status: 'settlement_pending',
      revision: sql`${billingRequests.revision} + 1`,
      receipt: event.receipt as unknown as Record<string, unknown>,
      receiptFingerprint: receiptFp,
      leaseExpiresAt: null,
      nextSettlementAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(billingRequests.requestId, event.requestId),
        inArray(billingRequests.status, ['authorized', 'in_flight']),
      ),
    )
    .returning({ status: billingRequests.status });
  if (changed.length > 0) {
    return { changed: true, status: 'settlement_pending', replayed: false };
  }
  // 条件更新竞态失败（并发的同名转移抢先）：同指纹仍幂等，异指纹才是真冲突
  const existing = await db.query.billingRequests.findFirst({
    where: eq(billingRequests.requestId, event.requestId),
    columns: { status: true, receiptFingerprint: true },
  });
  if (
    existing &&
    ['settlement_pending', 'settled'].includes(existing.status) &&
    existing.receiptFingerprint === receiptFp
  ) {
    return { changed: false, status: existing.status, replayed: true };
  }
  throw new BillingStateConflictError(event.requestId, 'receipt conflicts with billing state');
}
