/**
 * 套餐路由（会话）：列表 / 创建 / 补丁（kind 不可变 = .strict() 拒未知键）/
 * 删除（含历史订阅引用守卫 409）。
 * 价格/额度仅接收精确十进制字符串，避免 JSON number 的 IEEE-754 精度损失。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import { PLAN_SORTS, type PlansService } from '../services/plans.service.js';
import type { SessionEnv } from '../middleware/session.js';
import { positiveMoneyString } from '../http/money-schema.js';

const createSchema = z.strictObject({
  name: z.string().min(1).max(32),
  kind: z.enum(['subscription', 'pack']).optional(),
  sortOrder: z.number().int().positive().nullable().optional(),
  price: positiveMoneyString,
  periodDays: z.number().int().min(0).max(3650).optional(),
  quotaAmount: positiveMoneyString,
  allowSeats: z.boolean().optional(),
});

const updateSchema = z.strictObject({
  name: z.string().min(1).max(32).optional(),
  sortOrder: z.number().int().positive().nullable().optional(),
  price: positiveMoneyString.optional(),
  periodDays: z.number().int().min(0).max(3650).optional(),
  quotaAmount: positiveMoneyString.optional(),
  allowSeats: z.boolean().optional(),
  status: z.number().int().min(0).max(1).optional(),
});

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, 'invalid_param', 'Path parameter id must be a positive integer');
  }
  return id;
};

export function plansRoutes(service: PlansService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/plans', session, async (c) => {
    const query = parseListQuery(c.req.query(), PLAN_SORTS, 'id');
    return c.json(await service.list(adminCtxOf(c), query));
  });

  app.post('/v1/plans', session, async (c) => {
    const body = createSchema.parse(await c.req.json());
    const row = await service.create(adminCtxOf(c), {
      adminId: c.get('adminId'),
      name: body.name,
      kind: body.kind,
      sortOrder: body.sortOrder ?? null,
      price: body.price,
      periodDays: body.periodDays,
      quotaAmount: body.quotaAmount,
      allowSeats: body.allowSeats,
    });
    return c.json(row, 201);
  });

  app.patch('/v1/plans/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = updateSchema.parse(await c.req.json());
    const { price, quotaAmount, ...rest } = body;
    const row = await service.patch(adminCtxOf(c), {
      adminId: c.get('adminId'),
      planId: id,
      patch: {
        ...rest,
        ...(price !== undefined ? { price } : {}),
        ...(quotaAmount !== undefined ? { quotaAmount } : {}),
      },
    });
    return c.json(row);
  });

  app.delete('/v1/plans/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await service.remove(adminCtxOf(c), { adminId: c.get('adminId'), planId: id }));
  });

  return app;
}
