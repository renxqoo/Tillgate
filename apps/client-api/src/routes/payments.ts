import { Hono } from 'hono';
import { z } from 'zod';
import type { ClientEnv } from '@ai-gateway/identity';
import type { PaymentServices } from '../services/payments/orders.js';

/**
 * 支付路由：
 *   受保护：POST /api/payments（下单 → payUrl）、GET /api/payments（订单列表）、
 *           GET /api/payments/:id（状态轮询）
 *   公开（签名验证替代会话）：GET /api/public/payments/epay/notify（易支付 notify，
 *           query 验签）、POST /api/public/payments/stripe/webhook（HMAC 头验签）
 */

const createOrderSchema = z.object({
  provider: z.enum(['epay', 'stripe']),
  /** 实付金额（元；充值汇率 1:1 → creditAmount 同额） */
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, '金额格式非法（最多两位小数）')
    .refine((v) => Number(v) >= 1 && Number(v) <= 100000, { message: '单笔金额须在 1~100000 元之间' }),
});

export function paymentRoutes(s: PaymentServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()
    .post('/', async (c) => {
      const parsed = createOrderSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? '参数非法' } }, 400);
      }
      const { provider, amount } = parsed.data;
      const result = await s.createOrder({
        userId: c.var.session.userId,
        provider,
        amount,
        creditAmount: amount, // 汇率 1:1（充值汇率配置化留待运营需要时扩展）
      });
      if (!result.ok) {
        return c.json({ error: { code: 'payment_unavailable', message: result.error } }, 503);
      }
      return c.json({ orderId: result.orderId, payUrl: result.payUrl });
    })
    .get('/', async (c) => {
      const [orders, channels] = await Promise.all([s.listOrders(c.var.session.userId, 50), Promise.resolve(s.channels())]);
      return c.json({ orders, channels });
    })
    .get('/:id', async (c) => {
      const order = await s.getOrder(c.var.session.userId, c.req.param('id') ?? '');
      if (!order) return c.json({ error: { code: 'not_found', message: '订单不存在' } }, 404);
      return c.json({ order });
    });
}

export function paymentPublicRoutes(s: PaymentServices): Hono {
  return new Hono()
    .get('/epay/notify', async (c) => {
      const raw: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.req.query())) raw[k] = String(v);
      const outcome = await s.handleCallback('epay', raw);
      // 易支付协议：成功处理回纯文本 success，其余回 fail（渠道按此重试）
      return c.text(outcome === 'credited' || outcome === 'replayed' ? 'success' : 'fail');
    })
    .post('/stripe/webhook', async (c) => {
      const payload = await c.req.text();
      const raw: Record<string, string> = {
        payload,
        'stripe-signature': c.req.header('stripe-signature') ?? '',
      };
      const outcome = await s.handleCallback('stripe', raw);
      return c.json({ received: true, outcome }, outcome === 'invalid' ? 400 : 200);
    });
}
