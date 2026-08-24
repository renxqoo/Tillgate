/**
 * 支付路由：下单 / 订单详情 / 列表 / 渠道目录（会话）+ 渠道回调（公开——验签是唯一信任源）。
 * 易支付回调为 urlencoded 表单或 query：合并后交 billing payments 验签归一；
 * Stripe 回调为 POST 原始事件体 + Stripe-Signature 头（非 2xx 应答触发渠道重试）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { HttpErrors, jsonBody, query as queryMiddleware } from '@tillgate/http';
import type { PaymentsApi } from '@tillgate/billing';
import { createOrderSchema, orderIdPattern, ordersListQuerySchema } from '../contracts/billing.js';
import type { SessionEnv } from '../middleware/session.js';

export interface PaymentsDeps {
  readonly payments: PaymentsApi;
}

export function paymentsRoutes(deps: PaymentsDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.post('/v1/payments/orders', session, jsonBody(createOrderSchema), async (c) => {
    const body = c.req.valid('json');
    const result = await deps.payments.createTopupOrder(c.get('userId'), {
      amount: body.amount,
      provider: body.provider,
    });
    return c.json(result, 201);
  });

  app.get('/v1/payments/orders/:id', session, async (c) => {
    const id = c.req.param('id');
    if (!orderIdPattern.test(id)) {
      throw HttpErrors.business('invalid_request', { field: 'id' });
    }
    return c.json(await deps.payments.orderDetail(c.get('userId'), id));
  });

  app.get('/v1/payments/orders', session, queryMiddleware(ordersListQuerySchema), async (c) => {
    const query = c.req.valid('query');
    const rows = await deps.payments.listOrders(c.get('userId'), {
      page: query.page,
      limit: query.limit,
    });
    return c.json({ rows });
  });

  app.get('/v1/payments/channels', session, (c) => c.json({ channels: deps.payments.channels() }));

  app.post('/v1/payments/notify/:provider', async (c) => {
    const provider = c.req.param('provider');
    if (provider === 'epay') {
      // 表单体 + query 合并（各 epay 实现放置位置不一；重复键以表单优先）
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.req.query())) merged[k] = v;
      for (const [k, v] of Object.entries(form)) if (typeof v === 'string') merged[k] = v;
      const answer = await deps.payments.handleNotify('epay', merged);
      // 渠道回调应答是裸文本（epay 协议：success/fail）
      return c.text(answer);
    }
    if (provider === 'stripe') {
      const payload = await c.req.text();
      const answer = await deps.payments.handleNotify('stripe', {
        payload,
        'stripe-signature': c.req.header('stripe-signature') ?? '',
      });
      // Stripe 协议：2xx 即确认；非 2xx 渠道按指数退避重试（验签失败重试也无害）
      return c.json({ received: answer === 'success' }, answer === 'success' ? 200 : 400);
    }
    return c.text('fail', 404);
  });

  return app;
}
