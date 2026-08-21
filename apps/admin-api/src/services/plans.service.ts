/**
 * 套餐目录管理面服务：CRUD + 校验（kind 不可变——路由 .strict() 保证；
 * 包月必带 periodDays 1..3650 / 加油包禁周期恒 0）+ 删除守卫（含历史订阅
 * 引用 → 409 plan_in_use）。
 */
import { recordAudit } from '@ai-gateway/http';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories, type PlanRow } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { ListQueryParts } from '../http/list-query.js';

export const PLAN_SORTS = ['id', 'name', 'status', 'price', 'sortOrder'] as const;

export interface PlansServiceDeps {
  db: Db;
  repos?: Repositories;
}

export interface PlansService {
  list(ctx: RunContext, query: ListQueryParts): Promise<{ rows: PlanRow[]; total: number; page: number; pageSize: number }>;
  create(
    ctx: RunContext,
    input: {
      adminId: number;
      name: string;
      kind?: string;
      sortOrder?: number | null;
      price: string;
      periodDays?: number;
      quotaAmount: string;
      allowSeats?: boolean;
    },
  ): Promise<PlanRow>;
  patch(
    ctx: RunContext,
    input: {
      adminId: number;
      planId: number;
      patch: {
        name?: string;
        sortOrder?: number | null;
        price?: string;
        periodDays?: number;
        quotaAmount?: string;
        allowSeats?: boolean;
        status?: number;
      };
    },
  ): Promise<PlanRow>;
  remove(ctx: RunContext, input: { adminId: number; planId: number }): Promise<{ ok: true }>;
}

/** kind×周期一致性：包月必带 1..3650；加油包禁周期（恒 0）——「买到立即到期」防线 */
function assertKindPeriodConsistency(kind: string, periodDays: number | null | undefined): number {
  if (kind === 'pack') {
    if (periodDays != null && periodDays !== 0) {
      throw new AppError(400, 'invalid_period_days', 'Packs have no cycle (periodDays must be omitted or 0)');
    }
    return 0;
  }
  if (periodDays == null || periodDays < 1 || periodDays > 3650) {
    throw new AppError(400, 'invalid_period_days', 'Monthly plan periodDays must be between 1 and 3650');
  }
  return periodDays;
}

export function createPlansService(deps: PlansServiceDeps): PlansService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();

  return {
    async list(ctx, query) {
      const result = await repos.plan.listAdminPlans({ db, ...ctx }, {
        q: query.q,
        sortBy: query.sortBy as (typeof PLAN_SORTS)[number],
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      });
      return { rows: result.rows, total: result.total, page: query.page, pageSize: query.pageSize };
    },

    async create(ctx, input) {
      const kind = input.kind ?? 'subscription';
      const periodDays = assertKindPeriodConsistency(kind, input.periodDays);
      const row = await repos.plan.insertPlan({ db, ...ctx }, {
        name: input.name,
        kind,
        sortOrder: input.sortOrder ?? null,
        price: input.price,
        periodDays,
        quotaAmount: input.quotaAmount,
        allowSeats: input.allowSeats ?? false,
      });
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'plan.create',
        targetType: 'plan',
        targetId: row.id,
        detail: { name: row.name, kind: row.kind, price: row.price, periodDays, quotaAmount: row.quotaAmount },
      });
      return row;
    },

    async patch(ctx, input) {
      const current = await repos.plan.findPlan({ db, ...ctx }, input.planId);
      if (!current) throw new AppError(404, 'plan_not_found', 'Plan not found');
      // 周期校验按「当前 kind ∪ 补丁」合并口径（kind 不可变）
      const periodDays = assertKindPeriodConsistency(
        current.kind,
        input.patch.periodDays ?? current.periodDays,
      );
      const row = await repos.plan.patchPlan({ db, ...ctx }, {
        planId: input.planId,
        patch: { ...input.patch, periodDays },
      });
      if (!row) throw new AppError(404, 'plan_not_found', 'Plan not found');
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'plan.update',
        targetType: 'plan',
        targetId: row.id,
        detail: { patch: input.patch },
      });
      return row;
    },

    async remove(ctx, input) {
      // 删除守卫：任何状态的订阅引用（含历史）都算「被用过」——防 FK 500
      const refs = await repos.plan.countSubscriptionsAnyStatus({ db, ...ctx }, input.planId);
      if (refs > 0) {
        throw new AppError(409, 'plan_in_use', 'Plan has associated subscriptions (including history) and cannot be deleted; disable it instead');
      }
      const removed = await repos.plan.deletePlan({ db, ...ctx }, input.planId);
      if (!removed) throw new AppError(404, 'plan_not_found', 'Plan not found');
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'plan.delete',
        targetType: 'plan',
        targetId: input.planId,
      });
      return { ok: true as const };
    },
  };
}
