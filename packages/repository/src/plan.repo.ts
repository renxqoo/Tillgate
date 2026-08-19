/** plans 套餐目录仓储：用户面目录读模型 + 管理面 CRUD/删除守卫。 */
import { and, asc, desc, eq, ilike, sql } from 'drizzle-orm';
import { plans, userSubscriptions } from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

export interface PlanRow {
  id: number;
  name: string;
  kind: string;
  sortOrder: number | null;
  price: string;
  periodDays: number;
  quotaAmount: string;
  allowSeats: boolean;
  status: number;
}

const PLAN_COLUMNS = {
  id: plans.id,
  name: plans.name,
  kind: plans.kind,
  sortOrder: plans.sortOrder,
  price: plans.price,
  periodDays: plans.periodDays,
  quotaAmount: plans.quotaAmount,
  allowSeats: plans.allowSeats,
  status: plans.status,
};

/** 套餐目录仓储（无状态；方法统一接收 RepoContext） */
export class PlanRepository {
  async findPlan(c: RepoContext, planId: number): Promise<PlanRow | null> {
    const [row] = await c.db
      .select({
        id: plans.id,
        name: plans.name,
        kind: plans.kind,
        sortOrder: plans.sortOrder,
        price: plans.price,
        periodDays: plans.periodDays,
        quotaAmount: plans.quotaAmount,
        allowSeats: plans.allowSeats,
        status: plans.status,
      })
      .from(plans)
      .where(eq(plans.id, planId));
    return (row as PlanRow) ?? null;
  }

  /** 上架列表（用户面目录；kind 过滤可选——购买页只看 subscription） */
  async listPlans(
    c: RepoContext,
    input: { kind?: 'subscription' | 'pack' } = {},
  ): Promise<PlanRow[]> {
    const conditions = [eq(plans.status, 0)];
    if (input.kind) conditions.push(eq(plans.kind, input.kind));
    const rows = await c.db
      .select({
        id: plans.id,
        name: plans.name,
        kind: plans.kind,
        sortOrder: plans.sortOrder,
        price: plans.price,
        periodDays: plans.periodDays,
        quotaAmount: plans.quotaAmount,
        allowSeats: plans.allowSeats,
        status: plans.status,
      })
      .from(plans)
      .where(and(...conditions))
      .orderBy(asc(plans.sortOrder), asc(plans.id));
    return rows as PlanRow[];
  }

  // ── 管理面 ──────────────────────────────────────────────────────────────────

  async insertPlan(
    c: RepoContext,
    input: {
      name: string;
      kind: string;
      sortOrder: number | null;
      price: string;
      periodDays: number;
      quotaAmount: string;
      allowSeats: boolean;
    },
  ): Promise<PlanRow> {
    const [row] = await c.db
      .insert(plans)
      .values({ ...input, status: 0 })
      .returning(PLAN_COLUMNS);
    if (!row) throw new Error('plan.insert_failed');
    return row as PlanRow;
  }

  /** 部分更新（白名单；kind 不可变由路由 .strict() 保证）。0 行 = 不存在 */
  async patchPlan(
    c: RepoContext,
    input: {
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
  ): Promise<PlanRow | null> {
    const rows = await c.db
      .update(plans)
      .set(input.patch)
      .where(eq(plans.id, input.planId))
      .returning(PLAN_COLUMNS);
    return (rows[0] as PlanRow) ?? null;
  }

  /** 引用计数（含历史订阅——删除守卫用；任何状态都算「被用过」） */
  async countSubscriptionsAnyStatus(c: RepoContext, planId: number): Promise<number> {
    const [row] = await c.db
      .select({ count: sql<number>`count(*)::int` })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.planId, planId));
    return row?.count ?? 0;
  }

  async deletePlan(c: RepoContext, planId: number): Promise<boolean> {
    const rows = await c.db.delete(plans).where(eq(plans.id, planId)).returning({ id: plans.id });
    return rows.length > 0;
  }

  /** 管理列表：q 命中 name；缺省 id desc（plans 无 created_at——创建序即 id 序） */
  async listAdminPlans(
    c: RepoContext,
    input: { q?: string; sortBy: 'id' | 'name' | 'status' | 'price' | 'sortOrder'; order: 'asc' | 'desc'; limit: number; offset: number },
  ): Promise<{ rows: PlanRow[]; total: number }> {
    const where = input.q ? ilike(plans.name, escapeLikePattern(input.q)) : undefined;
    const sorts = {
      id: plans.id,
      name: plans.name,
      status: plans.status,
      price: plans.price,
      sortOrder: plans.sortOrder,
    } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(plans.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select(PLAN_COLUMNS)
        .from(plans)
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db.select({ count: sql<number>`count(*)::int` }).from(plans).where(where),
    ]);
    return { rows: rows as PlanRow[], total: countRows[0]?.count ?? 0 };
  }
}
