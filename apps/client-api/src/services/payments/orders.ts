import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { paymentOrders } from '@ai-gateway/db/schema';
import type { Wallet } from '@ai-gateway/wallet';
import { toDecimal, toStorage } from '@ai-gateway/wallet/metering';
import { createDomainOperations } from '@ai-gateway/ledger/platform';
import { createLogger, type Logger } from '@ai-gateway/core';
import type { PaymentProvider } from './providers.js';

/**
 * 支付订单服务（S7 重写）：下单（DB 订单 + 渠道下单同事务边界内尽力一致）与回调入账。
 *
 * 订单生命周期：0 created →（回调验签）→ wallet.credit → 2 credited。
 * 入账幂等 = ledger-core 操作行（kind 'payment.credit'）+ 订单状态机条件 UPDATE；
 * 资金入账 = wallet.credit（counter-leg = outside 镜像）。
 * 渠道下单失败 → 订单落库后置 failed 原因并保持 created（用户可重新下单）。
 */

export interface PaymentServices {
  createOrder(input: { userId: number; provider: 'epay' | 'stripe'; amount: string; creditAmount: string }): Promise<
    | { ok: true; orderId: string; payUrl: string }
    | { ok: false; error: string }
  >;
  /** 回调处理：验签 → 查单 → paymentCredit。重复/非法回调幂等安全。 */
  handleCallback(provider: 'epay' | 'stripe', raw: Record<string, string>): Promise<'credited' | 'ignored' | 'replayed' | 'invalid'>;
  listOrders(userId: number, limit: number): Promise<Array<Record<string, unknown>>>;
  /** 已启用渠道（前端入口渲染） */
  channels(): Array<{ id: 'epay' | 'stripe'; label: string }>;
  getOrder(userId: number, orderId: string): Promise<Record<string, unknown> | null>;
}

export function createPaymentServices(
  db: Db,
  wallet: Wallet,
  providers: { epay?: PaymentProvider; stripe?: PaymentProvider },
  logger: Logger = createLogger({ level: 'info' }),
): PaymentServices {
  const operations = createDomainOperations(db, ['payment.credit']);
  return {
    async createOrder(input) {
      const provider = providers[input.provider];
      if (!provider) return { ok: false, error: '该支付渠道未启用' };
      const [order] = await db
        .insert(paymentOrders)
        .values({
          provider: input.provider,
          providerOrderId: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          userId: input.userId,
          amount: input.amount,
          currency: input.provider === 'stripe' ? 'CNY' : 'CNY',
          creditAmount: input.creditAmount,
          status: 0,
        })
        .returning({ id: paymentOrders.id });
      const orderId = order!.id;
      try {
        const created = await provider.createOrder({ orderId, amount: input.amount, subject: 'AI Gateway 余额充值' });
        await db
          .update(paymentOrders)
          .set({ providerOrderId: created.providerOrderId, raw: { payUrl: created.payUrl } })
          .where(eq(paymentOrders.id, orderId));
        return { ok: true, orderId, payUrl: created.payUrl };
      } catch (err) {
        logger.error({ err: (err as Error).message, orderId }, 'payment createOrder failed');
        await db
          .update(paymentOrders)
          .set({ status: 4, failureReason: `渠道下单失败: ${(err as Error).message.slice(0, 200)}` })
          .where(eq(paymentOrders.id, orderId));
        return { ok: false, error: '支付渠道下单失败，请稍后重试' };
      }
    },

    async handleCallback(providerName, raw) {
      const provider = providers[providerName];
      if (!provider) return 'invalid';
      const verified = provider.verifyCallback({ raw });
      if (!verified || !verified.ok) return 'invalid';

      // 易支付：out_trade_no = payment_orders.id；stripe：client_reference_id = id
      const orderId = raw.out_trade_no ?? raw.order_id ?? '';
      if (!orderId) return 'invalid';
      const order = await db.query.paymentOrders.findFirst({
        where: and(eq(paymentOrders.id, orderId), eq(paymentOrders.provider, providerName)),
      });
      if (!order) return 'invalid';
      if (order.status === 2) return 'replayed';
      if (order.status !== 0) return 'ignored';

      const result = await operations
        .run<{ ok: true; amount: string; balanceAfter: string } | { ok: false }>({
          operationId: `payment-credit:${providerName}:${order.providerOrderId}`,
          kind: 'payment.credit',
          fingerprint: {
            kind: 'payment.credit', provider: providerName, providerOrderId: order.providerOrderId,
            userId: order.userId, creditAmount: order.creditAmount,
          },
          execute: async (tx) => {
            // 订单状态机：created(0) → credited(2)；重复回调（0 行）幂等拒绝
            const credited = await tx
              .update(paymentOrders)
              .set({
                status: 2,
                updatedAt: new Date(),
                creditedAt: new Date(),
                creditedOperationId: `payment-credit:${providerName}:${order.providerOrderId}`,
              })
              .where(
                and(
                  eq(paymentOrders.id, order.id),
                  eq(paymentOrders.status, 0),
                  eq(paymentOrders.userId, order.userId),
                ),
              )
              .returning({ id: paymentOrders.id });
            if (credited.length === 0) return { ok: false as const };
            const amount = toStorage(toDecimal(order.creditAmount));
            const posted = await wallet.credit({
              userId: order.userId,
              amount,
              refType: 'payment',
              refId: `payment-credit:${providerName}:${order.providerOrderId}`,
              memo: `在线支付入账（${providerName}）+${amount}`,
              tx: tx as unknown as import('@ai-gateway/wallet').DbLike,
            });
            return { ok: true as const, amount, balanceAfter: posted.balanceAfter };
          },
        })
        .then(({ receipt, replayed }) => ({ ...receipt, replayed }));
      if (result.ok) {
        await db
          .update(paymentOrders)
          .set({ paidAt: new Date(), raw: { callback: raw } })
          .where(eq(paymentOrders.id, order.id));
        return 'credited';
      }
      return result.replayed ? 'replayed' : 'ignored';
    },

    channels() {
      const out: Array<{ id: 'epay' | 'stripe'; label: string }> = [];
      if (providers.epay) out.push({ id: 'epay', label: '在线支付（支付宝/微信）' });
      if (providers.stripe) out.push({ id: 'stripe', label: 'Stripe（国际卡）' });
      return out;
    },

    async listOrders(userId, limit) {
      const rows = await db.query.paymentOrders.findMany({
        where: eq(paymentOrders.userId, userId),
        orderBy: [desc(paymentOrders.createdAt)],
        limit,
        columns: {
          id: true,
          provider: true,
          amount: true,
          creditAmount: true,
          currency: true,
          status: true,
          createdAt: true,
          paidAt: true,
          creditedAt: true,
          failureReason: true,
        },
      });
      return rows as Array<Record<string, unknown>>;
    },

    async getOrder(userId, orderId) {
      const row = await db.query.paymentOrders.findFirst({
        where: and(eq(paymentOrders.id, orderId), eq(paymentOrders.userId, userId)),
        columns: {
          id: true,
          provider: true,
          amount: true,
          creditAmount: true,
          currency: true,
          status: true,
          createdAt: true,
          paidAt: true,
          creditedAt: true,
          failureReason: true,
        },
      });
      return (row as Record<string, unknown> | null) ?? null;
    },
  };
}
