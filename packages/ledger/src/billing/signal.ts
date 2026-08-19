/**
 * billing/signal（S5 重写）：四事件——钱包之上的状态机迁移。
 *
 *   upstream.started   authorized → in_flight（起租约，覆盖整个请求预算）
 *   lease.renewed      in_flight 续租（owner 校验）
 *   request.succeeded  authorized/in_flight → settlement_pending（收据验收 → worker 结算入口）
 *   request.failed     authorized/in_flight → released（三路预扣同事务释放：不扣）
 *
 * 状态 CAS 与旧版（signal/*）一致；资金释放路径换 wallet + subscription.quota +
 * channel-budget（release-reservations 唯一实现）。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import type { Wallet } from '@ai-gateway/wallet';
import { validateReceipt } from '../rating/quote.js';
import type { BillingQuote } from '../rating/types.js';
import { BillingStateConflictError } from '../platform/errors.js';
import type { BillingEvent, BillingSignalResult } from './types.js';
import { billingFingerprint, leaseUntil } from './lease.js';
import { releaseReservations } from './release-reservations.js';

export async function signalBillingEvent(
  db: Db,
  wallet: Wallet,
  clock: () => Date,
  event: BillingEvent,
): Promise<BillingSignalResult> {
  switch (event.type) {
    case 'upstream.started':
      return applyUpstreamStarted(db, clock, event);
    case 'lease.renewed':
      return applyLeaseRenewed(db, clock, event);
    case 'request.succeeded':
      return applyRequestSucceeded(db, clock, event);
    case 'request.failed':
      return applyRequestFailed(db, wallet, clock, event);
  }
}

async function applyUpstreamStarted(
  db: Db,
  clock: () => Date,
  event: Extract<BillingEvent, { type: 'upstream.started' }>,
): Promise<BillingSignalResult> {
  const now = clock();
  const changed = await db
    .update(billingRequests)
    .set({
      status: 'in_flight',
      revision: sql`${billingRequests.revision} + 1`,
      leaseOwner: event.leaseOwner,
      leaseExpiresAt: leaseUntil(now, event.leaseMs),
      upstreamStartedAt: sql`coalesce(${billingRequests.upstreamStartedAt}, ${now})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(billingRequests.requestId, event.requestId),
        inArray(billingRequests.status, ['authorized', 'in_flight']),
      ),
    )
    .returning({ status: billingRequests.status });
  if (changed.length > 0) return { changed: true, status: 'in_flight', replayed: false };
  return replayOrCurrent(db, event.requestId);
}

async function applyLeaseRenewed(
  db: Db,
  clock: () => Date,
  event: Extract<BillingEvent, { type: 'lease.renewed' }>,
): Promise<BillingSignalResult> {
  const now = clock();
  const changed = await db
    .update(billingRequests)
    .set({ leaseExpiresAt: leaseUntil(now, event.leaseMs), updatedAt: now })
    .where(
      and(
        eq(billingRequests.requestId, event.requestId),
        eq(billingRequests.status, 'in_flight'),
        eq(billingRequests.leaseOwner, event.leaseOwner),
      ),
    )
    .returning({ status: billingRequests.status });
  if (changed.length > 0) return { changed: true, status: 'in_flight', replayed: false };
  return replayOrCurrent(db, event.requestId);
}

async function applyRequestSucceeded(
  db: Db,
  clock: () => Date,
  event: Extract<BillingEvent, { type: 'request.succeeded' }>,
): Promise<BillingSignalResult> {
  if (event.receipt.requestId !== event.requestId) {
    throw new BillingStateConflictError(event.requestId, 'receipt requestId mismatch');
  }
  const now = clock();
  const receiptFp = billingFingerprint(event.receipt);
  const authorized = await db.query.billingRequests.findFirst({
    where: eq(billingRequests.requestId, event.requestId),
    columns: { userId: true, quote: true, status: true, receiptFingerprint: true },
  });
  if (!authorized) throw new BillingStateConflictError(event.requestId, 'billing request missing');
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
  if (changed.length > 0) return { changed: true, status: 'settlement_pending', replayed: false };
  // 条件更新竞态失败：同指纹仍幂等，异指纹才是真冲突
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

async function applyRequestFailed(
  db: Db,
  wallet: Wallet,
  clock: () => Date,
  event: Extract<BillingEvent, { type: 'request.failed' }>,
): Promise<BillingSignalResult> {
  const now = clock();
  const released = await db.transaction(async (tx) => {
    const row = await tx
      .update(billingRequests)
      .set({
        status: 'released',
        revision: sql`${billingRequests.revision} + 1`,
        failureCode: event.reason.slice(0, 64),
        leaseExpiresAt: null,
        releasedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(billingRequests.requestId, event.requestId),
          inArray(billingRequests.status, ['authorized', 'in_flight']),
        ),
      )
      .returning({
        userId: billingRequests.userId,
        reservedAmount: billingRequests.reservedAmount,
        planReservedAmount: billingRequests.planReservedAmount,
        subscriptionId: billingRequests.subscriptionId,
        channelId: billingRequests.channelId,
        channelReservedAmount: billingRequests.channelReservedAmount,
      });
    if (row.length === 0) return null;
    await releaseReservations(wallet, tx, { requestId: event.requestId, ...row[0]! });
    return row[0]!;
  });
  if (released) {
    return {
      changed: true,
      status: 'released',
      replayed: false,
      amountReleased: released.reservedAmount,
    };
  }
  return replayOrCurrent(db, event.requestId);
}

/** 未命中转移：回读现状（幂等重放判定交编排层） */
async function replayOrCurrent(db: Db, requestId: string): Promise<BillingSignalResult> {
  const [row] = await db
    .select({ status: billingRequests.status })
    .from(billingRequests)
    .where(eq(billingRequests.requestId, requestId));
  if (!row) throw new BillingStateConflictError(requestId, 'billing request missing');
  return { changed: false, status: row.status, replayed: true };
}
