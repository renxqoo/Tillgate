import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { auditLogs, billingRequests, fundOperations } from '@ai-gateway/db/schema';
import { validateReceipt } from './billing-flow.js';
import { releaseReservedAmounts } from './release.js';
import type { BillingQuote, BillingRequestStatus, UsageReceipt } from './types.js';

export interface BillingReviewCase {
  requestId: string;
  userId: number;
  status: 'dead' | 'uncertain';
  revision: number;
  reservedAmount: string;
  failureCode: string | null;
  failureClass: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BillingReviewResult {
  requestId: string;
  userId: number;
  status: BillingRequestStatus;
  revision: number;
  replayed: boolean;
}

interface OperationBase {
  operationId: string;
  requestId: string;
  expectedRevision: number;
  /** null = 系统自动化动作（worker 自动放行 / 治理脚本） */
  adminId: number | null;
  reason: string;
  evidenceRefs?: string[];
  /** 审计主体：人工复核（admin，默认）或系统自动化（system） */
  actor?: 'admin' | 'system';
}

export type ResolveUncertainCommand = OperationBase &
  (
    | { decision: 'confirmed_no_charge' }
    | { decision: 'provider_receipt_recovered'; receipt: UsageReceipt }
  );

export interface BillingOperations {
  listCases(input: {
    status: 'dead' | 'uncertain';
    limit?: number;
    offset?: number;
  }): Promise<BillingReviewCase[]>;
  /** 队列总数（分页 total） */
  countCases(status: 'dead' | 'uncertain'): Promise<number>;
  retryDead(input: OperationBase): Promise<BillingReviewResult>;
  resolveUncertain(input: ResolveUncertainCommand): Promise<BillingReviewResult>;
  /** 废弃 dead 单：确认不收费并释放全部预扣（人工复核或治理脚本，幂等 + 审计）。 */
  abandonDead(input: OperationBase): Promise<BillingReviewResult>;
}

export class BillingOperationError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'state_conflict'
      | 'idempotency_conflict'
      | 'invalid_receipt',
  ) {
    super(code);
    this.name = 'BillingOperationError';
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertCommand(input: OperationBase): void {
  if (!input.operationId || !input.requestId || !Number.isInteger(input.expectedRevision)) {
    throw new BillingOperationError('state_conflict');
  }
  if (!input.reason.trim() || input.reason.length > 1000) {
    throw new BillingOperationError('state_conflict');
  }
}

/** 释放一个请求的三类预扣（余额在途 / 套餐在途 / 渠道在途），供 resolve 与 abandon 共用。
 *  唯一实现在 release.ts，此处仅注入本模块的错误语义。 */
async function releaseReservations(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  row: {
    userId: number;
    reservedAmount: string;
    planReservedAmount: string | null;
    subscriptionId: number | null;
    channelId: number | null;
    channelReservedAmount: string | null;
  },
): Promise<void> {
  await releaseReservedAmounts(tx, row, (dimension) =>
    new BillingOperationError(dimension === 'user' ? 'not_found' : 'state_conflict'),
  );
}

export function createBillingOperations(input: { db: Db; clock?: () => Date }): BillingOperations {
  const { db } = input;

  async function runOperation(
    kind: 'billing.retry_dead' | 'billing.resolve_uncertain' | 'billing.abandon_dead',
    command: OperationBase,
    payload: Record<string, unknown>,
    change: (
      tx: Parameters<Parameters<Db['transaction']>[0]>[0],
      now: Date,
    ) => Promise<BillingReviewResult>,
  ): Promise<BillingReviewResult> {
    assertCommand(command);
    const fingerprint = hash({ kind, ...payload });
    const result = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(fundOperations)
        .values({ operationId: command.operationId, kind, fingerprint })
        .onConflictDoNothing({ target: fundOperations.operationId })
        .returning({ operationId: fundOperations.operationId });
      if (inserted.length === 0) {
        const existing = await tx.query.fundOperations.findFirst({
          where: eq(fundOperations.operationId, command.operationId),
        });
        if (
          !existing ||
          existing.kind !== kind ||
          existing.fingerprint !== fingerprint ||
          !existing.result
        ) {
          throw new BillingOperationError('idempotency_conflict');
        }
        return { ...(existing.result as Omit<BillingReviewResult, 'replayed'>), replayed: true };
      }

      const changed = await change(tx, new Date());
      const stored = {
        requestId: changed.requestId,
        userId: changed.userId,
        status: changed.status,
        revision: changed.revision,
      };
      await tx
        .update(fundOperations)
        .set({ result: stored })
        .where(eq(fundOperations.operationId, command.operationId));
      await tx.insert(auditLogs).values({
        adminId: command.adminId,
        actor: command.actor ?? 'admin',
        action: kind,
        targetType: 'billing_request',
        targetId: command.requestId,
        detail: {
          operationId: command.operationId,
          expectedRevision: command.expectedRevision,
          reason: command.reason,
          evidenceRefs: command.evidenceRefs ?? [],
          ...payload,
          receipt: undefined,
          result: stored,
        },
      });
      return changed;
    });
    return result;
  }

  return {
    async listCases({ status, limit = 50, offset = 0 }) {
      const rows = await db
        .select({
          requestId: billingRequests.requestId,
          userId: billingRequests.userId,
          status: billingRequests.status,
          revision: billingRequests.revision,
          reservedAmount: billingRequests.reservedAmount,
          failureCode: billingRequests.failureCode,
          failureClass: billingRequests.failureClass,
          lastError: billingRequests.lastError,
          createdAt: billingRequests.createdAt,
          updatedAt: billingRequests.updatedAt,
        })
        .from(billingRequests)
        .where(eq(billingRequests.status, status))
        // 金额优先：钱数大的先被人看到；同额按时间倒序
        .orderBy(desc(billingRequests.reservedAmount), desc(billingRequests.updatedAt))
        .limit(Math.min(200, Math.max(1, limit)))
        .offset(Math.max(0, offset));
      return rows as BillingReviewCase[];
    },

    async countCases(status) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(billingRequests)
        .where(eq(billingRequests.status, status));
      return Number(row?.count ?? 0);
    },

    async retryDead(command) {
      return runOperation('billing.retry_dead', command, { ...command }, async (tx) => {
        const [row] = await tx
          .update(billingRequests)
          .set({
            status: 'retry_wait',
            revision: sql`${billingRequests.revision} + 1`,
            settlementAttempts: 0,
            nextSettlementAt: sql`clock_timestamp()`,
            failureClass: null,
            lastError: null,
            deadAt: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(billingRequests.requestId, command.requestId),
              eq(billingRequests.status, 'dead'),
              eq(billingRequests.revision, command.expectedRevision),
            ),
          )
          .returning({
            requestId: billingRequests.requestId,
            userId: billingRequests.userId,
            status: billingRequests.status,
            revision: billingRequests.revision,
          });
        if (!row) throw new BillingOperationError('state_conflict');
        return { ...row, status: row.status as BillingRequestStatus, replayed: false };
      });
    },

    async resolveUncertain(command) {
      const payload = {
        ...command,
        receipt:
          command.decision === 'provider_receipt_recovered' ? hash(command.receipt) : undefined,
      };
      const result = await runOperation(
        'billing.resolve_uncertain',
        command,
        payload,
        async (tx, now) => {
          const row = await tx.query.billingRequests.findFirst({
            where: and(
              eq(billingRequests.requestId, command.requestId),
              eq(billingRequests.status, 'uncertain'),
              eq(billingRequests.revision, command.expectedRevision),
            ),
          });
          if (!row) throw new BillingOperationError('state_conflict');

          if (command.decision === 'provider_receipt_recovered') {
            try {
              validateReceipt(row.userId, row.quote as unknown as BillingQuote, command.receipt);
            } catch {
              throw new BillingOperationError('invalid_receipt');
            }
            const [changed] = await tx
              .update(billingRequests)
              .set({
                status: 'settlement_pending',
                revision: sql`${billingRequests.revision} + 1`,
                receipt: command.receipt as unknown as Record<string, unknown>,
                receiptFingerprint: hash(command.receipt),
                nextSettlementAt: now,
                failureCode: null,
                updatedAt: now,
              })
              .where(
                and(
                  eq(billingRequests.requestId, command.requestId),
                  eq(billingRequests.revision, command.expectedRevision),
                ),
              )
              .returning({
                requestId: billingRequests.requestId,
                userId: billingRequests.userId,
                status: billingRequests.status,
                revision: billingRequests.revision,
              });
            if (!changed) throw new BillingOperationError('state_conflict');
            return { ...changed, status: 'settlement_pending', replayed: false };
          }

          const [changed] = await tx
            .update(billingRequests)
            .set({
              status: 'released',
              revision: sql`${billingRequests.revision} + 1`,
              failureCode: 'manually_confirmed_no_charge',
              releasedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(billingRequests.requestId, command.requestId),
                eq(billingRequests.revision, command.expectedRevision),
              ),
            )
            .returning({
              requestId: billingRequests.requestId,
              userId: billingRequests.userId,
              reservedAmount: billingRequests.reservedAmount,
              planReservedAmount: billingRequests.planReservedAmount,
              subscriptionId: billingRequests.subscriptionId,
              channelId: billingRequests.channelId,
              channelReservedAmount: billingRequests.channelReservedAmount,
              revision: billingRequests.revision,
            });
          if (!changed) throw new BillingOperationError('state_conflict');
          await releaseReservations(tx, changed);
          return {
            requestId: changed.requestId,
            userId: changed.userId,
            status: 'released' as BillingRequestStatus,
            revision: changed.revision,
            replayed: false,
          };
        },
      );
      return result;
    },

    async abandonDead(command) {
      return runOperation('billing.abandon_dead', command, { ...command }, async (tx, now) => {
        const [changed] = await tx
          .update(billingRequests)
          .set({
            status: 'released',
            revision: sql`${billingRequests.revision} + 1`,
            failureCode: 'manually_abandoned',
            releasedAt: now,
            deadAt: null,
            nextSettlementAt: null,
            claimOwner: null,
            claimToken: null,
            claimUntil: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(billingRequests.requestId, command.requestId),
              eq(billingRequests.status, 'dead'),
              eq(billingRequests.revision, command.expectedRevision),
            ),
          )
          .returning({
            requestId: billingRequests.requestId,
            userId: billingRequests.userId,
            reservedAmount: billingRequests.reservedAmount,
            planReservedAmount: billingRequests.planReservedAmount,
            subscriptionId: billingRequests.subscriptionId,
            channelId: billingRequests.channelId,
            channelReservedAmount: billingRequests.channelReservedAmount,
            revision: billingRequests.revision,
          });
        if (!changed) throw new BillingOperationError('state_conflict');
        await releaseReservations(tx, changed);
        return {
          requestId: changed.requestId,
          userId: changed.userId,
          status: 'released' as BillingRequestStatus,
          revision: changed.revision,
          replayed: false,
        };
      });
    },
  };
}
