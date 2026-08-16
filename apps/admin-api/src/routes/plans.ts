import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { plans, userSubscriptions } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  HttpError, intParam, jsonBody, operationId, recordAudit,
  paginateQuery, query, listQuerySchema, buildList, countAll } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { mapSubscriptionError } from '../services/subscriptions.js';

/**
 * 套餐管理（api-contract §4.10）。
 *
 * 定价模型：套餐额度 = 金额（元），按「官方价 × 系数」折算扣减；底层账本全元，
 * 积分仅展示层（前端换算）。包月 Key 只扣套餐额度，普通 Key 只扣余额（Key 类型分流）。
 *
 * 业务规则：
 *   - kind 创建后不可变（subscription/pack 的下游语义完全不同）
 *   - 包月套餐 periodDays ∈ [1, 3650]；加油包固定 0（无周期）
 *   - 删除套餐前须确认无任何关联订阅（含历史，外键约束）
 */

const PLAN_PRICE_MAX = 1e9;

const planCreateSchema = z
  .object({
    name: z.string().min(1).max(32),
    kind: z.enum(['subscription', 'pack']).optional(),
    sortOrder: z.number().int().positive().nullable().optional(),
    price: z.number().positive().finite().max(PLAN_PRICE_MAX),
    /** 包月：1~3650；加油包：0 或省略 */
    periodDays: z.number().int().min(0).max(3650).optional(),
    quotaAmount: z.number().positive().finite().max(PLAN_PRICE_MAX),
    allowSeats: z.boolean().optional(),
  })
  .strict();

const planUpdateSchema = z
  .object({
    name: z.string().min(1).max(32).optional(),
    sortOrder: z.number().int().positive().nullable().optional(),
    price: z.number().positive().finite().max(PLAN_PRICE_MAX).optional(),
    periodDays: z.number().int().min(0).max(3650).optional(),
    quotaAmount: z.number().positive().finite().max(PLAN_PRICE_MAX).optional(),
    allowSeats: z.boolean().optional(),
    status: z.number().int().min(0).max(1).optional(),
  })
  .strict();

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

export function planAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return (
    new Hono<AdminEnv>()
      // 列表
      .get('/', query(listQuerySchema), async (c) => {
        const input = c.req.valid('query');
        const { page, limit, offset, where, orderBy } = buildList(input, {
          search: [plans.name],
          // plans 无 created_at，默认按 id desc（创建序倒序）
          sort: {
            by: { id: plans.id, name: plans.name, status: plans.status, price: plans.price, sortOrder: plans.sortOrder },
            fallback: 'id',
            tiebreaker: plans.id,
          },
        });
        return c.json(
          await paginateQuery(
            page,
            s.db.select().from(plans).where(where).orderBy(...orderBy).limit(limit).offset(offset),
            countAll(s.db, plans, where),
          ),
        );
      })

      // 创建
      .post('/', jsonBody(planCreateSchema), async (c) => {
        const body = c.req.valid('json');
        const kind = body.kind ?? 'subscription';
        const periodDays = assertKindPeriodConsistency(kind, body.periodDays ?? null);
        const [plan] = await s.db
          .insert(plans)
          .values({
            name: body.name,
            kind,
            sortOrder: body.sortOrder ?? null,
            price: String(body.price),
            periodDays,
            quotaAmount: String(body.quotaAmount),
            allowSeats: body.allowSeats ?? false,
            status: 0,
          })
          .returning();
        await recordAudit(s.db, {
          actor: 'admin',
          adminId: c.get('adminId'),
          action: 'plan.create',
          targetType: 'plan',
          targetId: plan!.id,
          detail: body,
        });
        return c.json(plan, 201);
      })

      // 更新（kind 不可变；periodDays 与现 kind 联合校验）
      .patch('/:id', jsonBody(planUpdateSchema), async (c) => {
        const id = intParam(c, 'id');
        const body = c.req.valid('json');
        const current = await s.db.query.plans.findFirst({
          where: eq(plans.id, id),
          columns: { kind: true, periodDays: true },
        });
        if (!current) throw new HttpError('PLAN_NOT_FOUND', '套餐不存在');
        const periodDays = assertKindPeriodConsistency(
          current.kind as 'subscription' | 'pack',
          body.periodDays ?? current.periodDays,
        );
        const update: Record<string, unknown> = {};
        if (body.name !== undefined) update.name = body.name;
        if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
        if (body.price !== undefined) update.price = String(body.price);
        if (body.periodDays !== undefined) update.periodDays = periodDays;
        if (body.quotaAmount !== undefined) update.quotaAmount = String(body.quotaAmount);
        if (body.allowSeats !== undefined) update.allowSeats = body.allowSeats;
        if (body.status !== undefined) update.status = body.status;
        const [updated] = await s.db.update(plans).set(update).where(eq(plans.id, id)).returning();
        if (!updated) throw new HttpError('PLAN_NOT_FOUND', '套餐不存在');
        await recordAudit(s.db, {
          actor: 'admin',
          adminId: c.get('adminId'),
          action: 'plan.update',
          targetType: 'plan',
          targetId: id,
          detail: body,
        });
        return c.json(updated);
      })

      // 发放加油包（kind=pack）：扣 pack.price，有效订阅额度 += pack.quota_amount
      .post('/:id/grant', jsonBody(z.object({ userId: z.number().int().positive() })), async (c) => {
        const id = intParam(c, 'id');
        const body = c.req.valid('json');
        try {
          const result = await s.ledger.grantPack({
            operationId: operationId(c),
            userId: body.userId,
            packId: id,
            adminId: c.get('adminId'),
          });
          return c.json(result);
        } catch (error) {
          throw mapSubscriptionError(error);
        }
      })

      // 删除（存在任何关联订阅——含历史——都不允许，外键无 ON DELETE，防 500）
      .delete('/:id', async (c) => {
        const id = intParam(c, 'id');
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
          adminId: c.get('adminId'),
          action: 'plan.delete',
          targetType: 'plan',
          targetId: id,
        });
        return c.json({ ok: true });
      })
  );
}
