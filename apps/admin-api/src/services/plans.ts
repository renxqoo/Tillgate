import { eq } from 'drizzle-orm';
import { plans, userSubscriptions } from '@ai-gateway/db/schema';
import { buildList, countAll, HttpError, listQuerySchema, paginateQuery, recordAudit } from '@ai-gateway/http';
import { z } from 'zod';
import type { AdminServices } from './index.js';

/**
 * 套餐服务（api-contract §4.10）。
 *
 * 业务规则：
 *   - kind 创建后不可变（subscription/pack 的下游语义完全不同）
 *   - 包月套餐 periodDays ∈ [1, 3650]；加油包固定 0（无周期）
 *   - 删除套餐前须确认无任何关联订阅（含历史，外键约束）
 */

export interface PlanCreateInput {
  name: string;
  kind?: 'subscription' | 'pack';
  sortOrder?: number | null;
  price: number;
  periodDays?: number;
  quotaAmount: number;
  allowSeats?: boolean;
}

export interface PlanPatch {
  name?: string;
  sortOrder?: number | null;
  price?: number;
  periodDays?: number;
  quotaAmount?: number;
  allowSeats?: boolean;
  status?: number;
}

/** kind × periodDays 一致性（创建用完整值，更新用「覆盖值 ∪ 现值」的合成值） */
function assertKindPeriodConsistency(
  kind: 'subscription' | 'pack',
  periodDays: number | null,
): number {
  if (kind === 'pack') {
    if (periodDays != null && periodDays !== 0) {
      throw new HttpError('INVALID_PERIOD_DAYS', '加油包无周期，periodDays 必须为 0 或省略');
    }
    return 0;
  }
  if (periodDays == null || periodDays < 1) {
    throw new HttpError('INVALID_PERIOD_DAYS', '包月套餐 periodDays 必须为 1~3650 的整数');
  }
  return periodDays;
}

export async function createPlan(
  s: AdminServices,
  input: PlanCreateInput,
  adminId: number,
): Promise<typeof plans.$inferSelect> {
  const kind = input.kind ?? 'subscription';
  const periodDays = assertKindPeriodConsistency(kind, input.periodDays ?? null);
  const [plan] = await s.db
    .insert(plans)
    .values({
      name: input.name,
      kind,
      sortOrder: input.sortOrder ?? null,
      price: String(input.price),
      periodDays,
      quotaAmount: String(input.quotaAmount),
      allowSeats: input.allowSeats ?? false,
      status: 0,
    })
    .returning();
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'plan.create',
    targetType: 'plan',
    targetId: plan!.id,
    detail: { ...input },
  });
  return plan!;
}

export async function updatePlan(
  s: AdminServices,
  id: number,
  patch: PlanPatch,
  adminId: number,
): Promise<typeof plans.$inferSelect> {
  const current = await s.db.query.plans.findFirst({
    where: eq(plans.id, id),
    columns: { kind: true, periodDays: true },
  });
  if (!current) throw new HttpError('PLAN_NOT_FOUND', '套餐不存在');
  const periodDays = assertKindPeriodConsistency(
    current.kind as 'subscription' | 'pack',
    patch.periodDays ?? current.periodDays,
  );
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.sortOrder !== undefined) update.sortOrder = patch.sortOrder;
  if (patch.price !== undefined) update.price = String(patch.price);
  if (patch.periodDays !== undefined) update.periodDays = periodDays;
  if (patch.quotaAmount !== undefined) update.quotaAmount = String(patch.quotaAmount);
  if (patch.allowSeats !== undefined) update.allowSeats = patch.allowSeats;
  if (patch.status !== undefined) update.status = patch.status;
  const [updated] = await s.db.update(plans).set(update).where(eq(plans.id, id)).returning();
  if (!updated) throw new HttpError('PLAN_NOT_FOUND', '套餐不存在');
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'plan.update',
    targetType: 'plan',
    targetId: id,
    detail: { ...patch },
  });
  return updated;
}

/** 删除（存在任何关联订阅——含历史——都不允许，外键无 ON DELETE，防 500） */
export async function deletePlan(s: AdminServices, id: number, adminId: number): Promise<void> {
  const bound = await s.db
    .select({ id: userSubscriptions.id })
    .from(userSubscriptions)
    .where(eq(userSubscriptions.planId, id))
    .limit(1);
  if (bound.length > 0) {
    throw new HttpError('PLAN_IN_USE', '该套餐存在关联订阅（含历史），无法删除，可改为停用');
  }
  const [deleted] = await s.db.delete(plans).where(eq(plans.id, id)).returning({ id: plans.id });
  if (!deleted) throw new HttpError('PLAN_NOT_FOUND', '套餐不存在');
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'plan.delete',
    targetType: 'plan',
    targetId: id,
  });
}

export async function listPlans(s: AdminServices, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [plans.name],
    // plans 无 created_at，默认按 id desc（创建序倒序）
    sort: {
      by: { id: plans.id, name: plans.name, status: plans.status, price: plans.price, sortOrder: plans.sortOrder },
      fallback: 'id',
      tiebreaker: plans.id,
    },
  });
  return paginateQuery(
    page,
    s.db.select().from(plans).where(where).orderBy(...orderBy).limit(limit).offset(offset),
    countAll(s.db, plans, where),
  );
}
