/**
 * 订阅管理面服务：列表（用户/套餐 join 富化 + 剩余额度投影）
 * + 续费/变更/取消（共享订阅域动词；userId=null 管理面免属主检查）
 * + 加油包发放（grantPack）。
 * 幂等：路由透传 idempotency-key（缺省服务端生成）→ 域内 operations。
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext, SubscriptionDomain } from '@ai-gateway/service';
import type { ListQueryParts } from '../http/list-query.js';

export const SUBSCRIPTION_SORTS = ['id', 'createdAt', 'startAt', 'endAt', 'usedAmount'] as const;

export interface AdminSubscriptionsServiceDeps {
  db: Db;
  repos?: Repositories;
  /** 共享订阅域（purchase/renew/change/cancel/grantPack） */
  domain: SubscriptionDomain;
}

export interface AdminSubscriptionsService {
  list(
    ctx: RunContext,
    input: { query: ListQueryParts; planId?: number; userId?: number; status?: number },
  ): Promise<{ rows: unknown[]; total: number; page: number; pageSize: number }>;
  renew(
    ctx: RunContext,
    input: { adminId: number; subscriptionId: number; operationId: string },
  ): Promise<unknown>;
  change(
    ctx: RunContext,
    input: { adminId: number; subscriptionId: number; targetPlanId: number; quantity: number; operationId: string },
  ): Promise<unknown>;
  cancel(
    ctx: RunContext,
    input: { adminId: number; subscriptionId: number; operationId: string },
  ): Promise<{ subscriptionId: number; replayed: boolean }>;
  grantPack(
    ctx: RunContext,
    input: { adminId: number; userId: number; packId: number; operationId: string },
  ): Promise<unknown>;
}

export function createAdminSubscriptionsService(
  deps: AdminSubscriptionsServiceDeps,
): AdminSubscriptionsService {
  const { db, domain } = deps;
  const repos = deps.repos ?? createRepositories();

  return {
    async list(ctx, input) {
      const result = await repos.subscription.listAdminSubscriptions({ db, ...ctx }, {
        q: input.query.q,
        planId: input.planId,
        userId: input.userId,
        status: input.status,
        sortBy: input.query.sortBy as (typeof SUBSCRIPTION_SORTS)[number],
        order: input.query.order,
        limit: input.query.limit,
        offset: input.query.offset,
      });
      return {
        rows: result.rows,
        total: result.total,
        page: input.query.page,
        pageSize: input.query.pageSize,
      };
    },

    renew(ctx, input) {
      return domain.renew(ctx, {
        operationId: input.operationId,
        userId: null,
        subscriptionId: input.subscriptionId,
      });
    },

    change(ctx, input) {
      return domain.change(ctx, {
        operationId: input.operationId,
        userId: null,
        subscriptionId: input.subscriptionId,
        targetPlanId: input.targetPlanId,
        quantity: input.quantity,
      });
    },

    cancel(ctx, input) {
      return domain.cancel(ctx, {
        operationId: input.operationId,
        subscriptionId: input.subscriptionId,
      });
    },

    grantPack(ctx, input) {
      return domain.grantPack(ctx, {
        operationId: input.operationId,
        userId: input.userId,
        packId: input.packId,
      });
    },
  };
}
