import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests, users } from '@ai-gateway/db/schema';
import {
  Decimal,
  estimateMaxCost,
  requiredReservation,
  toDecimal,
  toStorage,
} from '@ai-gateway/money';
import type {
  AuthorizeBillingCommand,
  BillingAuthorization,
  BillingEvent,
  BillingQuote,
  BillingSignalResult,
  UsageReceipt,
} from './types.js';

export class BillingConfigurationError extends Error {
  constructor(
    public readonly code: 'invalid_quote' | 'invalid_coefficient' | 'reservation_limit_exceeded',
  ) {
    super(code);
    this.name = 'BillingConfigurationError';
  }
}

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly userId: number,
    public readonly balance: string,
    public readonly settledBalance = balance,
    public readonly reservedBalance = '0',
  ) {
    super(`insufficient balance for user ${userId}: ${balance}`);
    this.name = 'InsufficientBalanceError';
  }
}

export class BillingStateConflictError extends Error {
  constructor(
    public readonly requestId: string,
    message: string,
  ) {
    super(message);
    this.name = 'BillingStateConflictError';
  }
}

export class BillingUsageExceedsAuthorizationError extends Error {
  constructor() {
    super('billing_receipt_usage_exceeds_authorization');
    this.name = 'BillingUsageExceedsAuthorizationError';
  }
}

export interface Billing {
  authorize(command: AuthorizeBillingCommand): Promise<BillingAuthorization>;
  signal(event: BillingEvent): Promise<BillingSignalResult>;
}

export interface BillingDeps {
  db: Db;
  clock?: () => Date;
  admission?: {
    maxPending: number;
    maxOldestAgeMs: number;
    cacheMs: number;
  };
}

export class BillingBacklogError extends Error {
  constructor(
    public readonly pending: number,
    public readonly oldestPendingMs: number,
  ) {
    super('billing_settlement_backlog');
    this.name = 'BillingBacklogError';
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function leaseUntil(now: Date, leaseMs: number): Date {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new BillingConfigurationError('invalid_quote');
  return new Date(now.getTime() + leaseMs);
}

function calculateRequired(quote: BillingQuote, limit: string): Decimal {
  if (quote.candidates.length === 0) throw new BillingConfigurationError('invalid_quote');
  if (quote.explicitlyFree) return new Decimal(0);

  let maximum = new Decimal(0);
  for (const candidate of quote.candidates) {
    const coefficient = toDecimal(candidate.coefficient);
    const prices = [
      toDecimal(candidate.inputPrice),
      toDecimal(candidate.outputPrice),
      toDecimal(candidate.cacheInputPrice),
    ];
    if (!coefficient.isFinite() || coefficient.lte(0)) {
      throw new BillingConfigurationError('invalid_coefficient');
    }
    if (prices.some((price) => !price.isFinite() || price.lt(0))) {
      throw new BillingConfigurationError('invalid_quote');
    }
    const estimate = estimateMaxCost({
      estimatedInputTokens: candidate.inputTokenUpperBound,
      maxOutputTokens: quote.maxOutputTokens,
      inputPrice: candidate.inputPrice,
      cacheInputPrice: candidate.cacheInputPrice,
      outputPrice: candidate.outputPrice,
      coefficient,
    });
    if (estimate.gt(maximum)) maximum = estimate;
  }
  if (maximum.lte(0)) throw new BillingConfigurationError('invalid_quote');
  try {
    return requiredReservation(maximum, limit);
  } catch (error) {
    if ((error as Error).message === 'reservation_limit_exceeded') {
      throw new BillingConfigurationError('reservation_limit_exceeded');
    }
    throw new BillingConfigurationError('invalid_quote');
  }
}

export function validateReceipt(userId: number, quote: BillingQuote, receipt: UsageReceipt): void {
  if (receipt.userId !== userId) throw new Error('billing_receipt_user_mismatch');
  if (receipt.usage.estimated) throw new Error('billing_receipt_estimated_usage');
  const usageValues = [
    receipt.usage.inputTokens,
    receipt.usage.cachedInputTokens,
    receipt.usage.outputTokens,
    receipt.durationMs,
  ];
  if (usageValues.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('billing_receipt_invalid_usage');
  }
  if (
    !Number.isInteger(receipt.usage.inputTokens) ||
    !Number.isInteger(receipt.usage.cachedInputTokens) ||
    !Number.isInteger(receipt.usage.outputTokens) ||
    receipt.usage.cachedInputTokens > receipt.usage.inputTokens
  ) {
    throw new Error('billing_receipt_invalid_usage');
  }
  const candidate = quote.candidates.find(
    (item) =>
      item.mappingId === receipt.mappingId &&
      item.externalModel === receipt.externalModel &&
      item.realModel === receipt.realModel &&
      toDecimal(item.inputPrice).eq(receipt.inputPrice) &&
      toDecimal(item.outputPrice).eq(receipt.outputPrice) &&
      toDecimal(item.cacheInputPrice).eq(receipt.cacheInputPrice) &&
      toDecimal(item.coefficient).eq(receipt.coefficient) &&
      item.billingPolicyFingerprint === receipt.billingPolicyFingerprint,
  );
  if (!candidate) throw new Error('billing_receipt_not_authorized');
  if (
    receipt.usage.inputTokens > candidate.inputTokenUpperBound ||
    receipt.usage.outputTokens > quote.maxOutputTokens
  ) {
    throw new BillingUsageExceedsAuthorizationError();
  }
}

/**
 * 企业计费门面。PostgreSQL 是唯一事实源；队列只发送 requestId 唤醒结算处理器。
 */
export function createBilling({ db, clock = () => new Date(), admission }: BillingDeps): Billing {
  let admissionCache: { expiresAt: number; pending: number; oldestPendingMs: number } | undefined;
  let admissionProbe: Promise<{ pending: number; oldestPendingMs: number }> | undefined;

  async function assertSettlementCapacity(): Promise<void> {
    if (!admission) return;
    const nowMs = Date.now();
    let state = admissionCache && admissionCache.expiresAt > nowMs ? admissionCache : undefined;
    if (!state) {
      admissionProbe ??= db
        .execute<{ pending: string; oldest_pending_at: Date | string | null }>(sql`
          select
            count(*)::text as pending,
            min(created_at) as oldest_pending_at
          from billing_requests
          where status in ('settlement_pending','processing','retry_wait')
        `)
        .then((result) => {
          const row = result.rows[0];
          const oldestPendingMs = row?.oldest_pending_at
            ? Math.max(0, Date.now() - new Date(row.oldest_pending_at).getTime())
            : 0;
          const value = { pending: Number(row?.pending ?? 0), oldestPendingMs };
          admissionCache = { ...value, expiresAt: Date.now() + admission.cacheMs };
          return value;
        })
        .finally(() => {
          admissionProbe = undefined;
        });
      state = { ...(await admissionProbe), expiresAt: Date.now() + admission.cacheMs };
    }
    if (
      state.pending >= admission.maxPending ||
      state.oldestPendingMs >= admission.maxOldestAgeMs
    ) {
      throw new BillingBacklogError(state.pending, state.oldestPendingMs);
    }
  }

  return {
    async authorize(command) {
      await assertSettlementCapacity();
      const amount = toStorage(calculateRequired(command.quote, command.reservationLimit));
      const fp = fingerprint({
        requestId: command.requestId,
        userId: command.userId,
        stream: command.stream,
        quote: command.quote,
        amount,
      });
      const now = clock();
      const result = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(billingRequests)
          .values({
            requestId: command.requestId,
            userId: command.userId,
            reservedAmount: amount,
            status: 'authorized',
            stream: command.stream,
            quote: command.quote as unknown as Record<string, unknown>,
            authorizationFingerprint: fp,
            leaseExpiresAt: leaseUntil(now, command.authorizationTtlMs),
            nextSettlementAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: billingRequests.requestId })
          .returning({ requestId: billingRequests.requestId });

        if (inserted.length === 0) {
          const existing = await tx.query.billingRequests.findFirst({
            where: eq(billingRequests.requestId, command.requestId),
          });
          if (
            !existing ||
            existing.authorizationFingerprint !== fp ||
            existing.userId !== command.userId ||
            !toDecimal(existing.reservedAmount).eq(amount)
          ) {
            throw new BillingStateConflictError(command.requestId, 'authorization replay conflict');
          }
          const user = await tx.query.users.findFirst({
            where: eq(users.id, command.userId),
            columns: { balance: true, reservedBalance: true },
          });
          if (!user) throw new InsufficientBalanceError(command.userId, '0');
          return {
            settledBalance: user.balance,
            reservedBalance: user.reservedBalance,
            availableBalance: toStorage(toDecimal(user.balance).minus(user.reservedBalance)),
            replayed: true,
          };
        }

        if (toDecimal(amount).isZero()) {
          const user = await tx.query.users.findFirst({
            where: eq(users.id, command.userId),
            columns: { balance: true, reservedBalance: true },
          });
          if (!user) throw new InsufficientBalanceError(command.userId, '0');
          return {
            settledBalance: user.balance,
            reservedBalance: user.reservedBalance,
            availableBalance: toStorage(toDecimal(user.balance).minus(user.reservedBalance)),
            replayed: false,
          };
        }

        const updated = await tx
          .update(users)
          .set({
            reservedBalance: sql`${users.reservedBalance} + ${amount}::numeric`,
            updatedAt: now,
          })
          .where(
            sql`${users.id} = ${command.userId}
                and ${users.balance} - ${users.reservedBalance} >= ${amount}::numeric`,
          )
          .returning({ balance: users.balance, reservedBalance: users.reservedBalance });
        if (updated.length === 0) {
          const current = await tx.query.users.findFirst({
            where: eq(users.id, command.userId),
            columns: { balance: true, reservedBalance: true },
          });
          const available = current
            ? toStorage(toDecimal(current.balance).minus(current.reservedBalance))
            : '0';
          throw new InsufficientBalanceError(
            command.userId,
            available,
            current?.balance ?? '0',
            current?.reservedBalance ?? '0',
          );
        }
        return {
          settledBalance: updated[0]!.balance,
          reservedBalance: updated[0]!.reservedBalance,
          availableBalance: toStorage(
            toDecimal(updated[0]!.balance).minus(updated[0]!.reservedBalance),
          ),
          replayed: false,
        };
      });
      return {
        requestId: command.requestId,
        reservedAmount: amount,
        settledBalance: result.settledBalance,
        reservedBalance: result.reservedBalance,
        availableBalance: result.availableBalance,
        replayed: result.replayed,
      };
    },

    async signal(event) {
      const now = clock();
      if (event.type === 'upstream.started') {
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
      } else if (event.type === 'lease.renewed') {
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
      } else if (event.type === 'request.succeeded') {
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
        if (!['authorized', 'in_flight', 'uncertain'].includes(authorized.status)) {
          throw new BillingStateConflictError(
            event.requestId,
            'receipt conflicts with billing state',
          );
        }
        try {
          validateReceipt(
            authorized.userId,
            authorized.quote as unknown as BillingQuote,
            event.receipt,
          );
        } catch (error) {
          if (!(error instanceof BillingUsageExceedsAuthorizationError)) throw error;
          const dead = await db
            .update(billingRequests)
            .set({
              status: 'dead',
              revision: sql`${billingRequests.revision} + 1`,
              receipt: event.receipt as unknown as Record<string, unknown>,
              receiptFingerprint: receiptFp,
              failureCode: 'usage_exceeds_authorization',
              failureClass: 'invariant_violation',
              lastError: error.message,
              leaseExpiresAt: null,
              deadAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(billingRequests.requestId, event.requestId),
                inArray(billingRequests.status, ['authorized', 'in_flight', 'uncertain']),
              ),
            )
            .returning({ requestId: billingRequests.requestId });
          if (dead.length > 0) return { changed: true, status: 'dead', replayed: false };
          throw new BillingStateConflictError(
            event.requestId,
            'usage overrun conflicts with billing state',
          );
        }
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
              inArray(billingRequests.status, ['authorized', 'in_flight', 'uncertain']),
            ),
          )
          .returning({ status: billingRequests.status });
        if (changed.length > 0) {
          return { changed: true, status: 'settlement_pending', replayed: false };
        }
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
        throw new BillingStateConflictError(
          event.requestId,
          'receipt conflicts with billing state',
        );
      } else if (event.type === 'request.uncertain') {
        const uncertain = await db
          .update(billingRequests)
          .set({
            status: 'uncertain',
            revision: sql`${billingRequests.revision} + 1`,
            failureCode: event.reason.slice(0, 64),
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(billingRequests.requestId, event.requestId),
              eq(billingRequests.status, 'in_flight'),
            ),
          )
          .returning({ requestId: billingRequests.requestId });
        if (uncertain.length > 0) {
          return { changed: true, status: 'uncertain', replayed: false };
        }
      } else {
        if (event.upstreamCharge === 'unknown') {
          const uncertain = await db
            .update(billingRequests)
            .set({
              status: 'uncertain',
              revision: sql`${billingRequests.revision} + 1`,
              failureCode: event.reason.slice(0, 64),
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(billingRequests.requestId, event.requestId),
                eq(billingRequests.status, 'in_flight'),
              ),
            )
            .returning({ requestId: billingRequests.requestId });
          if (uncertain.length > 0) {
            return { changed: true, status: 'uncertain', replayed: false };
          }
        }
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
                event.upstreamCharge === 'none'
                  ? inArray(billingRequests.status, ['authorized', 'in_flight'])
                  : eq(billingRequests.status, 'authorized'),
              ),
            )
            .returning({
              userId: billingRequests.userId,
              amount: billingRequests.reservedAmount,
            });
          if (row.length === 0) return null;
          const reservation = await tx
            .update(users)
            .set({
              reservedBalance: sql`${users.reservedBalance} - ${row[0]!.amount}::numeric`,
              updatedAt: now,
            })
            .where(
              sql`${users.id} = ${row[0]!.userId}
                  and ${users.reservedBalance} >= ${row[0]!.amount}::numeric`,
            )
            .returning({ id: users.id });
          if (reservation.length === 0) throw new Error('billing_reservation_invariant');
          return row[0]!;
        });
        if (released) {
          return { changed: true, status: 'released', replayed: false };
        }
      }

      const existing = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, event.requestId),
        columns: { status: true },
      });
      if (!existing)
        throw new BillingStateConflictError(event.requestId, 'billing request missing');
      if (event.type === 'upstream.started' && existing.status !== 'in_flight') {
        throw new BillingStateConflictError(
          event.requestId,
          `upstream start rejected in billing state ${existing.status}`,
        );
      }
      return { changed: false, status: existing.status, replayed: true };
    },
  };
}

export function newLeaseOwner(): string {
  return randomUUID();
}
