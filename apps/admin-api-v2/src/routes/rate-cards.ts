/**
 * 费率卡路由（会话）：列表 / 创建 / 更新 / 删除（硬删，绑定守卫）/ 卡内用户 / 健康自检。
 * 系数 numeric(6,3)：0..9.999，落库与回显恒 3 位小数。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import {
  RATE_CARD_SORTS,
  RATE_CARD_USER_SORTS,
  type RateCardsService,
} from '../services/rate-cards.service.js';
import type { SessionEnv } from '../middleware/session.js';

const coefficient = z.number().min(0).max(9.999);

const createSchema = z.object({
  name: z.string().min(1).max(32),
  description: z.string().max(255).optional(),
  coefficient,
});

const updateSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  description: z.string().max(255).nullable().optional(),
  status: z.number().int().min(0).max(1).optional(),
  coefficient: coefficient.optional(),
});

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, 'invalid_param', '路径参数 id 必须为正整数');
  }
  return id;
};

export function rateCardsRoutes(service: RateCardsService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/rate-cards', session, async (c) => {
    const query = parseListQuery(c.req.query(), RATE_CARD_SORTS, 'createdAt');
    return c.json(await service.list(adminCtxOf(c), query));
  });

  app.post('/v1/rate-cards', session, async (c) => {
    const body = createSchema.parse(await c.req.json());
    const row = await service.create(adminCtxOf(c), { adminId: c.get('adminId'), ...body });
    return c.json(row, 201);
  });

  app.patch('/v1/rate-cards/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const patch = updateSchema.parse(await c.req.json());
    return c.json(await service.update(adminCtxOf(c), { adminId: c.get('adminId'), rateCardId: id, patch }));
  });

  app.delete('/v1/rate-cards/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await service.remove(adminCtxOf(c), { adminId: c.get('adminId'), rateCardId: id }));
  });

  app.get('/v1/rate-cards/:id/users', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const query = parseListQuery(c.req.query(), RATE_CARD_USER_SORTS, 'id');
    return c.json(await service.listUsers(adminCtxOf(c), { rateCardId: id, query }));
  });

  app.get('/v1/rate-cards/:id/health', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await service.health(adminCtxOf(c), id));
  });

  return app;
}
