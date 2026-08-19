/**
 * 订阅服务（用户面编排）：目录 / 我的订阅 / 购买 / 变更 / 续费。
 * 资金与状态机在 @ai-gateway/service subscription 域——本层只做会话归属与
 * 幂等键透传（idempotency-key 语义与 v1 一致：合法客户端键或服务端生成）。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type PlanRow, type Repositories } from '@ai-gateway/repository';
import type { RunContext, SubscribeResult, SubscriptionDomain } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';

const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

const asUser = (ctx: RunContext, userId: number): RunContext => ({
  ...ctx,
  actor: { kind: 'user', id: userId },
});

export interface SubscriptionService {
  listPlans(ctx: RunContext): Promise<PlanRow[]>;
  mySubscriptions(
    ctx: RunContext,
    userId: number,
  ): Promise<Awaited<ReturnType<Repositories['subscription']['listByUser']>>>;
  purchase(
    ctx: RunContext,
    userId: number,
    input: { idempotencyKey?: string; planId: number; quantity?: number },
  ): Promise<SubscribeResult>;
  change(
    ctx: RunContext,
    userId: number,
    input: { idempotencyKey?: string; subscriptionId: number; targetPlanId: number; quantity: number },
  ): Promise<SubscribeResult>;
  renew(
    ctx: RunContext,
    userId: number,
    input: { idempotencyKey?: string; subscriptionId: number },
  ): Promise<SubscribeResult>;
}

export function createSubscriptionService(deps: {
  db: Db;
  domain: SubscriptionDomain;
  repos?: Repositories;
}): SubscriptionService {
  const { db, domain } = deps;
  const repos = deps.repos ?? createRepositories();

  const opId = (key: string | undefined): string => {
    if (key === undefined || key === '') return randomUUID();
    if (!CLIENT_KEY_RE.test(key)) {
      throw new AppError(400, 'invalid_idempotency_key', 'idempotency-key 只允许 1-64 位字母/数字/下划线/中划线');
    }
    return key;
  };

  return {
    listPlans(ctx) {
      return repos.plan.listPlans({ db, ...ctx }, { kind: 'subscription' });
    },

    mySubscriptions(ctx, userId) {
      return repos.subscription.listByUser({ db, ...asUser(ctx, userId) }, userId);
    },

    purchase(ctx, userId, input) {
      return domain.purchase(asUser(ctx, userId), {
        operationId: opId(input.idempotencyKey),
        userId,
        planId: input.planId,
        quantity: input.quantity ?? 1,
        ensureOrg: true,
      });
    },

    change(ctx, userId, input) {
      return domain.change(asUser(ctx, userId), {
        operationId: opId(input.idempotencyKey),
        userId,
        subscriptionId: input.subscriptionId,
        targetPlanId: input.targetPlanId,
        quantity: input.quantity,
      });
    },

    renew(ctx, userId, input) {
      return domain.renew(asUser(ctx, userId), {
        operationId: opId(input.idempotencyKey),
        userId,
        subscriptionId: input.subscriptionId,
      });
    },
  };
}
