/**
 * billing/dead（S5 重写）：死单人工复核/放弃——钱包之上。
 * 自 billing/operations.ts 平移：list/count 原样；retry/abandon 的幂等走
 * ledger-core（kinds 'billing.retry_dead'/'billing.abandon_dead'），
 * abandon 的预扣释放走 release-reservations（wallet + quota + channel 三路）。
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { createLedger as createLedgerCore, OperationConflictError } from '@ai-gateway/ledger-core';
import type { Wallet } from '@ai-gateway/wallet';
import { auditLogs, billingRequests } from '@ai-gateway/db/schema';
import { releaseReservations, type ReservationProjections } from './release-reservations.js';
import type { BillingRequestStatus } from './types.js';
import type { DomainTx } from '../platform/operations.js';
import { BillingOperationError } from './review-errors.js';

export interface BillingReviewCase {
  requestId: string;
  userId: number;
  status: 'dead';
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

export interface BillingReview {
  listCases(input: { status: 'dead'; limit?: number; offset?: number }): Promise<BillingReviewCase[]>;
  countCases(status: 'dead'): Promise<number>;
  retryDead(input: OperationBase): Promise<BillingReviewResult>;
  /** 废弃 dead 单：确认不收费并释放全部预扣（人工复核或治理脚本，幂等 + 审计）。 */
  abandonDead(input: OperationBase): Promise<BillingReviewResult>;
}

function assertCommand(input: OperationBase): void {
  if (!input.operationId || !input.requestId || !Number.isInteger(input.expectedRevision)) {
    throw new BillingOperationError('state_conflict');
  }
  if (!input.reason.trim() || input.reason.length > 1000) {
    throw new BillingOperationError('state_conflict');
  }
}

export function createBillingReview(input: {
  db: Db;
  wallet: Wallet;
  clock?: () => Date;
}): BillingReview {
  const { db, wallet } = input;
  const ledgerCore = createLedgerCore(db, {
    kinds: ['billing.retry_dead', 'billing.abandon_dead'],
  });

  async function runOperation(
    kind: 'billing.retry_dead' | 'billing.abandon_dead',
    command: OperationBase,
    payload: Record<string, unknown>,
    change: (tx: DomainTx, now: Date) => Promise<BillingReviewResult>,
  ): Promise<BillingReviewResult> {
    assertCommand(command);
    try {
      const outcome = await ledgerCore.run({
        operationId: command.operationId,
        kind,
        fingerprint: { kind, ...payload },
        execute: async (coreTx): Promise<Record<string, unknown>> => {
          const tx = coreTx as unknown as DomainTx;
          const changed = await change(tx, new Date());
          const stored = {
            requestId: changed.requestId,
            userId: changed.userId,
            status: changed.status,
            revision: changed.revision,
          };
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
              result: stored,
            },
          });
          return changed as unknown as Record<string, unknown>;
        },
      });
      const base = outcome.receipt as unknown as BillingReviewResult;
      return outcome.replayed ? { ...base, replayed: true } : base;
    } catch (error) {
      if (error instanceof OperationConflictError) {
        throw new BillingOperationError('idempotency_conflict');
      }
      throw error;
    }
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
        const projections: ReservationProjections = {
          requestId: changed.requestId,
          userId: changed.userId,
          reservedAmount: changed.reservedAmount,
          planReservedAmount: changed.planReservedAmount,
          subscriptionId: changed.subscriptionId,
          channelId: changed.channelId,
          channelReservedAmount: changed.channelReservedAmount,
        };
        await releaseReservations(wallet, tx, projections).catch(() => {
          // 释放投影与账单脱节 → 状态冲突（管理端必须看到 409，不是 404）
          throw new BillingOperationError('state_conflict');
        });
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
