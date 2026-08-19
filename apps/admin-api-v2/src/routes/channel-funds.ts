/**
 * 渠道资金路由（会话）：流水列表 / 进货（凭证 data URL 内联）/ 调账。
 * 幂等键透传（同键同参重放、异参 409）；金额数值域铁三角在 zod 层收口。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { operationId } from '@ai-gateway/http';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { CHANNEL_FUNDS_SORTS, type ChannelFundsService } from '../services/channel-funds.service.js';
import type { SessionEnv } from '../middleware/session.js';

const MONEY_MAX = 1e9;

const listQueryExtra = z.object({
  channelId: z.coerce.number().int().positive().optional(),
  type: z.enum(['recharge', 'adjust']).optional(),
});

const rechargeSchema = z.object({
  channelId: z.number().int().positive(),
  amount: z.number().positive().finite().max(MONEY_MAX),
  orderNo: z.string().max(128).optional(),
  voucherDataUrl: z.string().max(20_000_000).optional(),
  remark: z.string().max(255).optional(),
});

const adjustSchema = z.object({
  channelId: z.number().int().positive(),
  amount: z.coerce
    .number()
    .finite()
    .max(MONEY_MAX)
    .refine((v) => v !== 0, '调账金额不能为 0'),
  remark: z.string().max(255).optional(),
});

export function channelFundsRoutes(
  service: ChannelFundsService,
  session: MiddlewareHandler<SessionEnv>,
) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/channel-funds', session, async (c) => {
    const extra = listQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), CHANNEL_FUNDS_SORTS, 'createdAt');
    return c.json(await service.list(adminCtxOf(c), { query, channelId: extra.channelId, type: extra.type }));
  });

  app.post('/v1/channel-funds/recharge', session, async (c) => {
    const body = rechargeSchema.parse(await c.req.json());
    const result = await service.recharge(adminCtxOf(c), {
      adminId: c.get('adminId'),
      channelId: body.channelId,
      amount: String(body.amount),
      orderNo: body.orderNo ?? null,
      voucherDataUrl: body.voucherDataUrl ?? null,
      remark: body.remark ?? null,
      operationId: operationId(c),
    });
    return c.json(result);
  });

  app.post('/v1/channel-funds/adjust', session, async (c) => {
    const body = adjustSchema.parse(await c.req.json());
    const result = await service.adjust(adminCtxOf(c), {
      adminId: c.get('adminId'),
      channelId: body.channelId,
      amount: String(body.amount),
      remark: body.remark ?? null,
      operationId: operationId(c),
    });
    return c.json(result);
  });

  return app;
}
