import { Hono } from 'hono';
import { z } from 'zod';
import { intParam, jsonBody, operationId, query, listQuerySchema } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { mapSubscriptionError } from '../services/subscriptions.js';
import { createPlan, deletePlan, listPlans, updatePlan } from '../services/plans.js';

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

export function planAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return (
    new Hono<AdminEnv>()
      // 列表
      .get('/', query(listQuerySchema), async (c) =>
        c.json(await listPlans(s, c.req.valid('query'))),
      )

      // 创建
      .post('/', jsonBody(planCreateSchema), async (c) => {
        const plan = await createPlan(s, c.req.valid('json'), c.get('adminId'));
        return c.json(plan, 201);
      })

      // 更新（kind 不可变；periodDays 与现 kind 联合校验）
      .patch('/:id', jsonBody(planUpdateSchema), async (c) => {
        const updated = await updatePlan(s, intParam(c, 'id'), c.req.valid('json'), c.get('adminId'));
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

      // 删除（存在任何关联订阅——含历史——都不允许，见 service）
      .delete('/:id', async (c) => {
        await deletePlan(s, intParam(c, 'id'), c.get('adminId'));
        return c.json({ ok: true });
      })
  );
}
