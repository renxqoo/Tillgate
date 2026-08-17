import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { listQuerySchema, query } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { Db } from '@ai-gateway/db';
import { paymentOrders, users } from '@ai-gateway/db/schema';

/**
 * 支付订单管理（只读列表 + 手动关闭卡死订单）。
 * 入账/退款走渠道回调与 ledger 状态机——管理面不直接改资金（绕过状态机直接改库为纪律禁止项）。
 */

export function paymentOrderAdminRoutes(db: Db): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    .get('/', query(listQuerySchema), async (c) => {
      const { page, page_size: pageSize, q } = c.req.valid('query');
      const conditions = [];
      if (q) {
        conditions.push(
          z.string().uuid().safeParse(q).success ? eq(paymentOrders.id, q) : eq(users.displayName, q),
        );
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const rows = await db
        .select({
          id: paymentOrders.id,
          provider: paymentOrders.provider,
          providerOrderId: paymentOrders.providerOrderId,
          userId: paymentOrders.userId,
          userDisplayName: users.displayName,
          userSubject: users.subject,
          amount: paymentOrders.amount,
          creditAmount: paymentOrders.creditAmount,
          currency: paymentOrders.currency,
          status: paymentOrders.status,
          failureReason: paymentOrders.failureReason,
          createdAt: paymentOrders.createdAt,
          paidAt: paymentOrders.paidAt,
          creditedAt: paymentOrders.creditedAt,
        })
        .from(paymentOrders)
        .leftJoin(users, eq(users.id, paymentOrders.userId))
        .where(where)
        .orderBy(desc(paymentOrders.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return c.json({ list: rows });
    })
    .post('/:id/close', async (c) => {
      // 手动关闭：仅 created(0) 可关（防误关已入账订单——状态机条件 UPDATE 保证）
      const closed = await db
        .update(paymentOrders)
        .set({ status: 4, failureReason: '管理员手动关闭', updatedAt: new Date() })
        .where(and(eq(paymentOrders.id, c.req.param('id') ?? ''), eq(paymentOrders.status, 0)))
        .returning({ id: paymentOrders.id });
      if (closed.length === 0) {
        return c.json({ error: { code: 'conflict', message: '订单不存在或状态不允许关闭' } }, 409);
      }
      return c.json({ ok: true });
    });
}
