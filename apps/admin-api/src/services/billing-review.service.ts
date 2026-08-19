/**
 * 死单复核服务（billing-operations）：list（status=dead 专属）+ retry/abandon。
 *
 * 幂等：operations 用例（同键同参重放回执、异参 409）；复核是资金敏感操作，
 * 审计行与业务写同事务落库（不吞失败）。
 * retry：CAS dead→retry_wait（revision 乐观锁）+ 清失败态 + 重置结算退避。
 * abandon：CAS dead→released + 三路归还（wallet 授权/订阅配额/渠道敞口）
 * ——归还失败回滚整个事务（409 state_conflict，不是 404）。
 */
import {
  createChannelBudgetUseCases,
  createDefaultFundingRegistry,
  createOperationsUseCase,
  createReleaseAllReservations,
  type WalletApi,
} from '@ai-gateway/service';
import type { RunContext } from '@ai-gateway/service';
import type { Db, DbTx } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import { AppError } from '../http/error-map.js';

export interface BillingReviewServiceDeps {
  db: Db;
  wallet: WalletApi;
  repos?: Repositories;
  clock?: () => Date;
}

export interface BillingReviewCommand {
  requestId: string;
  /** 乐观锁：与账单行 revision 不符 → state_conflict（并发复核双守卫） */
  expectedRevision: number;
  reason: string;
  evidenceRefs?: string[];
}

export interface BillingReviewService {
  list(ctx: RunContext, input: { limit: number; offset: number }): Promise<{ rows: unknown[]; total: number }>;
  retry(ctx: RunContext, input: { adminId: number; operationId: string } & BillingReviewCommand): Promise<{
    requestId: string;
    userId: number;
    status: string;
    revision: number;
    replayed: boolean;
  }>;
  abandon(ctx: RunContext, input: { adminId: number; operationId: string } & BillingReviewCommand): Promise<{
    requestId: string;
    released: boolean;
    replayed: boolean;
  }>;
}

/** 复核命令守卫（纯规则——提模块层） */
function assertCommand(input: BillingReviewCommand): void {
  if (!input.requestId) throw new AppError(409, 'billing_state_conflict', 'requestId 不能为空');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new AppError(409, 'billing_state_conflict', 'expectedRevision 必须为非负整数');
  }
  if (!input.reason.trim() || input.reason.length > 1000) {
    throw new AppError(400, 'validation_error', '复核理由必填（1~1000 字）');
  }
}

export function createBillingReviewService(deps: BillingReviewServiceDeps): BillingReviewService {
  const { db, wallet } = deps;
  const repos = deps.repos ?? createRepositories();
  const clock = deps.clock ?? (() => new Date());
  const operations = createOperationsUseCase({ db, repos });
  const releaseAllReservations = createReleaseAllReservations({
    registry: createDefaultFundingRegistry({ wallet, repos }),
    channelBudget: createChannelBudgetUseCases({ db, repos }),
    repos,
  });

  /** 复核审计与业务同事务（资金关键操作——不吞） */
  async function auditInTx(
    tx: DbTx,
    ctx: RunContext,
    input: { adminId: number; action: string; requestId: string; command: BillingReviewCommand; result: Record<string, unknown> },
  ): Promise<void> {
    await repos.auditLog.insert({ db: tx, ...ctx }, {
      adminId: input.adminId,
      actor: 'admin',
      action: input.action,
      targetType: 'billing_request',
      targetId: input.requestId,
      detail: {
        expectedRevision: input.command.expectedRevision,
        reason: input.command.reason,
        evidenceRefs: input.command.evidenceRefs ?? [],
        ...input.result,
      },
    });
  }

  return {
    async list(ctx, input) {
      const limit = Math.min(200, Math.max(1, input.limit));
      const [rows, countRows] = await Promise.all([
        repos.billingRequest.listDeadCases({ db, ...ctx }, limit, Math.max(0, input.offset)),
        repos.billingRequest.countDead({ db, ...ctx }),
      ]);
      return { rows: rows as unknown[], total: countRows };
    },

    async retry(ctx, input) {
      assertCommand(input);
      const { receipt, replayed } = await operations.run(ctx, {
        operationId: input.operationId,
        kind: 'billing.retry_dead',
        payload: {
          kind: 'billing.retry_dead',
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
        },
        execute: async (tx) => {
          const c = { db: tx, ...ctx };
          const retried = await repos.billingRequest.casRetryDead(c, {
            requestId: input.requestId,
            expectedRevision: input.expectedRevision,
          });
          if (!retried) {
            throw new AppError(409, 'billing_state_conflict', '账单不存在或状态已被并发变更');
          }
          const row = await repos.billingRequest.findByRequestId(c, input.requestId);
          await auditInTx(tx, ctx, {
            adminId: input.adminId,
            action: 'billing.retry_dead',
            requestId: input.requestId,
            command: input,
            result: { result: 'retry_wait' },
          });
          return {
            requestId: input.requestId,
            userId: row?.userId ?? 0,
            status: 'retry_wait',
            revision: row?.revision ?? 0,
          };
        },
      });
      return { ...receipt, replayed };
    },

    async abandon(ctx, input) {
      assertCommand(input);
      const { receipt, replayed } = await operations.run(ctx, {
        operationId: input.operationId,
        kind: 'billing.abandon_dead',
        payload: {
          kind: 'billing.abandon_dead',
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
        },
        execute: async (tx) => {
          const c = { db: tx, ...ctx };
          const projection = await repos.billingRequest.casAbandonDead(c, {
            requestId: input.requestId,
            expectedRevision: input.expectedRevision,
            releasedAt: clock(),
          });
          if (!projection) {
            throw new AppError(409, 'billing_state_conflict', '账单不存在或状态已被并发变更');
          }
          // 三路归还（wallet 授权 + 订阅配额 + 渠道敞口）——失败随事务回滚
          await releaseAllReservations(ctx, tx, {
            requestId: projection.request_id,
            reservedAmount: projection.reserved_amount,
            channelId: projection.channel_id ?? null,
            channelReservedAmount: projection.channel_reserved_amount ?? null,
            now: clock(),
          });
          await auditInTx(tx, ctx, {
            adminId: input.adminId,
            action: 'billing.abandon_dead',
            requestId: input.requestId,
            command: input,
            result: { result: 'released' },
          });
          return { requestId: input.requestId, released: true };
        },
      });
      return { ...receipt, replayed };
    },
  };
}
