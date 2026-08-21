/**
 * 支付路由：下单 / 订单列表 / 渠道目录（会话）+ 渠道回调（公开——验签是唯一信任源）。
 * 易支付回调为 urlencoded 表单或 query：两者合并后交 service 验签归一；
 * Stripe 回调为 POST 原始事件体 + Stripe-Signature 头（非 2xx 应答触发渠道重试）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { isValidAmountInput } from '../domain/topup.js';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { PaymentsService } from '../services/payments.service.js';

const createOrderSchema = z.object({
  amount: z.string().refine(isValidAmountInput, 'Must be a positive amount'),
  provider: z.enum(['epay', 'stripe']).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function paymentsRoutes(service: PaymentsService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.post('/v1/payments/orders', session, async (c) => {
    const body = createOrderSchema.parse(await c.req.json());
    const result = await service.createTopupOrder(userCtxOf(c), c.get('userId'), body);
    return c.json(result, 201);
  });

  app.get('/v1/payments/orders/:id', session, async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return c.json({ error: { code: 'invalid_request', message: 'Invalid order id' } }, 400);
    }
    return c.json(await service.orderDetail(userCtxOf(c), c.get('userId'), id));
  });

  app.get('/v1/payments/orders', session, async (c) => {
    const query = listQuerySchema.parse(c.req.query());
    const rows = await service.listOrders(userCtxOf(c), c.get('userId'), query);
    return c.json({ rows });
  });

  app.get('/v1/payments/channels', session, (c) => c.json({ channels: service.channels() }));

  app.post('/v1/payments/notify/:provider', async (c) => {
    const provider = c.req.param('provider');
    if (provider === 'epay') {
      // 表单体 + query 合并（各 epay 实现放的位置不一；重复键以表单优先）
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.req.query())) merged[k] = v;
      for (const [k, v] of Object.entries(form)) if (typeof v === 'string') merged[k] = v;
      const answer = await service.handleNotify(
        { requestId: c.get('requestId'), actor: { kind: 'system' }, traceParent: null },
        'epay',
        merged,
      );
      // 渠道回调应答是裸文本（epay 协议：success/fail）
      return c.text(answer);
    }
    if (provider === 'stripe') {
      const payload = await c.req.text();
      const raw = { payload, 'stripe-signature': c.req.header('stripe-signature') ?? '' };
      const answer = await service.handleNotify(
        { requestId: c.get('requestId'), actor: { kind: 'system' }, traceParent: null },
        'stripe',
        raw,
      );
      // Stripe 协议：2xx 即确认；非 2xx 渠道按指数退避重试（验签失败重试也无害）
      return c.json({ received: answer === 'success' }, answer === 'success' ? 200 : 400);
    }
    return c.text('fail', 404);
  });

  return app;
}
