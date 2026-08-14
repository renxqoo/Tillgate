import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { plans, userSubscriptions } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { HttpError, jsonBody, operationId, recordAudit } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { mapSubscriptionError } from '../services/subscriptions.js';

/**
 * 套餐管理（api-contract §4.10）。
 *
 * 定价模型：套餐额度 = 金额（元），按「官方价 × 系数」折算扣减；底层账本全元，
 * 积分仅展示层（前端换算）。fallback_to_balance = 额度耗尽后是否走余额。
 */

const planCreateSchema = z.object({
  name: z.string().min(1).max(32),
  kind: z.enum(['subscription', 'pack']).optional(),
  sortOrder: z.number().int().positive().nullable().optional(),
  price: z.number().positive(),
  periodDays: z.number().int().min(0),
  quotaAmount: z.number().positive(),
  fallbackToBalance: z.boolean().optional(),
  allowSeats: z.boolean().optional(),
});

const planUpdateSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  kind: z.enum(['subscription', 'pack']).optional(),
  sortOrder: z.number().int().positive().nullable().optional(),
  price: z.number().positive().optional(),
  periodDays: z.number().int().min(0).optional(),
  quotaAmount: z.number().positive().optional(),
  fallbackToBalance: z.boolean().optional(),
  allowSeats: z.boolean().optional(),
  status: z.number().int().min(0).max(1).optional(),
});

export function planAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return (
    new Hono<AdminEnv>()
      // 列表
      .get('/', async (c) => {
        const rows = await s.db.select().from(plans).orderBy(plans.id);
        return c.json({ list: rows, total: rows.length });
      })

      // 创建
      .post('/', jsonBody(planCreateSchema), async (c) => {
        const body = c.req.valid('json');
        const [plan] = await s.db
          .insert(plans)
          .values({
            name: body.name,
            kind: body.kind ?? 'subscription',
            sortOrder: body.sortOrder ?? null,
            price: String(body.price),
            periodDays: body.kind === 'pack' ? 0 : body.periodDays,
            quotaAmount: String(body.quotaAmount),
            fallbackToBalance: body.fallbackToBalance ?? true,
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

      // 更新
      .patch('/:id', jsonBody(planUpdateSchema), async (c) => {
        const id = Number(c.req.param('id'));
        const body = c.req.valid('json');
        const update: Record<string, unknown> = {};
        if (body.name !== undefined) update.name = body.name;
        if (body.kind !== undefined) update.kind = body.kind;
        if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
        if (body.price !== undefined) update.price = String(body.price);
        if (body.periodDays !== undefined) update.periodDays = body.periodDays;
        if (body.quotaAmount !== undefined) update.quotaAmount = String(body.quotaAmount);
        if (body.fallbackToBalance !== undefined) update.fallbackToBalance = body.fallbackToBalance;
        if (body.allowSeats !== undefined) update.allowSeats = body.allowSeats;
        if (body.status !== undefined) update.status = body.status;
        const [updated] = await s.db.update(plans).set(update).where(eq(plans.id, id)).returning();
        if (!updated) throw new HttpError(404, 'PLAN_NOT_FOUND', '套餐不存在');
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

      // 发放加油包（kind=pack）：扣 pack.price，用户余额 += pack.quota_amount
      .post('/:id/grant', jsonBody(z.object({ userId: z.number().int().positive() })), async (c) => {
        const id = Number(c.req.param('id'));
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

      // 删除（仅无有效订阅时允许，防孤儿订阅）
      .delete('/:id', async (c) => {
        const id = Number(c.req.param('id'));
        const bound = await s.db
          .select({ id: userSubscriptions.id })
          .from(userSubscriptions)
          .where(and(eq(userSubscriptions.planId, id), eq(userSubscriptions.status, 0)))
          .limit(1);
        if (bound.length > 0) {
          throw new HttpError(409, 'PLAN_IN_USE', '该套餐仍有有效订阅，无法删除');
        }
        const [deleted] = await s.db.delete(plans).where(eq(plans.id, id)).returning({ id: plans.id });
        if (!deleted) throw new HttpError(404, 'PLAN_NOT_FOUND', '套餐不存在');
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
