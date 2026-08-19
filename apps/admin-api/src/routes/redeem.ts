/**
 * 兑换批次路由（会话）：创建（明文码仅此一次返回）/ 列表 / 详情 /
 * 批内码列表（哈希脱敏）/ 单码作废。
 * 金额/数量数值域：coerce + finite + 上限（count ≤ 10000）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import { BATCH_SORTS, CODE_SORTS, type RedeemService } from '../services/redeem.service.js';
import type { SessionEnv } from '../middleware/session.js';

const MONEY_MAX = 1e9;

const createSchema = z.object({
  name: z.string().min(1).max(64),
  remark: z.string().max(255).optional(),
  amount: z.coerce
    .number()
    .positive()
    .finite()
    .refine((v) => v <= MONEY_MAX, '金额超出上限'),
  count: z.number().int().min(1).max(10_000),
  expiresAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), '过期时间格式非法')
    .optional(),
});

const codesQueryExtra = z.object({
  status: z.coerce.number().int().min(0).max(2).optional(),
});

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, 'invalid_param', '路径参数 id 必须为正整数');
  }
  return id;
};

export function redeemRoutes(service: RedeemService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.post('/v1/redeem-batches', session, async (c) => {
    const body = createSchema.parse(await c.req.json());
    const result = await service.createBatch(adminCtxOf(c), {
      adminId: c.get('adminId'),
      name: body.name,
      remark: body.remark ?? null,
      amount: String(body.amount),
      count: body.count,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
    return c.json(result, 201);
  });

  app.get('/v1/redeem-batches', session, async (c) => {
    const query = parseListQuery(c.req.query(), BATCH_SORTS, 'createdAt');
    return c.json(await service.list(adminCtxOf(c), query));
  });

  app.get('/v1/redeem-batches/:id', session, async (c) => {
    return c.json(await service.detail(adminCtxOf(c), idParam(c.req.param('id'))));
  });

  app.get('/v1/redeem-batches/:id/codes', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const extra = codesQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), CODE_SORTS, 'id');
    return c.json(await service.listCodes(adminCtxOf(c), { batchId: id, status: extra.status, query }));
  });

  app.post('/v1/redeem-batches/codes/:codeId/revoke', session, async (c) => {
    const codeId = idParam(c.req.param('codeId'));
    return c.json(await service.revokeCode(adminCtxOf(c), { adminId: c.get('adminId'), codeId }));
  });

  return app;
}
