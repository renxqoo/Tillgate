/**
 * 支付回调守卫边界(铁律 16 补测试拉回分支阈值;分支缺口为并行波既成,
 * 本文件只加用例不动语义):重读定夺的 fresh==null 拒收、markCredited CAS
 * 失败回滚、渠道会话回填失败大声留痕、渠道失败关单 best-effort 吞错。
 * 注入手法 = 内存 stand-in 的定向包装(单动词抛错/返回空),不造第二套世界。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createPaymentsApi } from '../src/application/payments/payments.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { createInMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';
import { createInMemoryPaymentStores } from '../src/testing/in-memory-payment-stores.js';
import type { PaymentOrderStore, PaymentProviderPort } from '../src/ports/payment-ports.js';
import type { WalletConn } from '../src/ports/wallet-store.js';

/** 可编程假渠道(cs_ 前缀触发回填路径;failCreate 触发渠道失败路径) */
function fakeProvider(behavior: { failCreate?: boolean } = {}): PaymentProviderPort {
  return {
    name: 'stripe',
    accepting: () => true,
    async createOrder(input) {
      if (behavior.failCreate) throw new Error('channel down');
      return {
        providerOrderId: `cs_${input.orderId}`,
        payUrl: `https://pay/cs_${input.orderId}`,
      };
    },
    parseNotify(raw) {
      const providerOrderId = raw.providerOrderId ?? '';
      const paidAmount = raw.paidAmount ?? '';
      if (!providerOrderId || !paidAmount) return null;
      return { providerOrderId, paidAmount };
    },
  };
}

interface EdgeHarness {
  payments: ReturnType<typeof createPaymentsApi>;
  orders: PaymentOrderStore;
  logged: string[];
}

/** 组装可定向破坏的 orders 包装层(其余动词直通内存 stand-in) */
function harness(
  breaks: {
    findByIdNull?: boolean;
    markCreditedFalse?: boolean;
    attachThrows?: boolean;
    markChannelFailedThrows?: boolean;
  } = {},
  providerBehavior: { failCreate?: boolean } = {},
): EdgeHarness {
  const walletMemory = createInMemoryWalletStore();
  const wallet = createWalletApi({
    store: walletMemory.store,
    guards: {
      refTypes: ['billing', 'topup', 'admin', 'subscription', 'pack', 'redeem'],
      currencies: ['CNY'],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: 'CNY',
  });
  const world = createInMemoryBillingWorld();
  const memory = createInMemoryPaymentStores();
  const logged: string[] = [];
  const orders: PaymentOrderStore = {
    ...memory.orderStore,
    findById: (conn, orderId) =>
      breaks.findByIdNull
        ? Promise.resolve(null)
        : memory.orderStore.findById(conn as WalletConn, orderId),
    markCredited: (conn, input) =>
      breaks.markCreditedFalse
        ? Promise.resolve(false)
        : memory.orderStore.markCredited(conn as WalletConn, input),
    attachProviderOrderId: (conn, input) =>
      breaks.attachThrows
        ? Promise.reject(new Error('attach down'))
        : memory.orderStore.attachProviderOrderId(conn as WalletConn, input),
    markChannelFailed: (conn, orderId) =>
      breaks.markChannelFailedThrows
        ? Promise.reject(new Error('close down'))
        : memory.orderStore.markChannelFailed(conn as WalletConn, orderId),
  };
  const payments = createPaymentsApi({
    store: world.billing,
    orders,
    wallet,
    providers: [fakeProvider(providerBehavior)],
    currency: 'CNY',
    exchangeRate: '1',
    topupMin: '1',
    topupMax: '1000',
    orderLimiter: undefined,
    perMinuteOrderLimit: 6,
    orderTtlMs: 600_000,
    clock: () => new Date(),
    logError: (message) => logged.push(message),
  });
  return { payments, orders, logged };
}

describe('支付守卫边界(回调重读/CAS 失败/回填失败/关单吞错)', () => {
  it('markPaid 输家重读得 null → order_state_conflict 被回调层转 fail + 留痕', async () => {
    const { payments, orders, logged } = harness({ findByIdNull: true });
    const order = await payments.createTopupOrder(9001, { amount: '10' });
    // 先把单推到 paid(markPaid 将 CAS 失败走重读;findById 被 demolition 为 null)
    await orders.markPaid({} as never, { orderId: order.orderId, paidAt: new Date() });
    const answer = await payments.handleNotify('stripe', {
      providerOrderId: `cs_${order.orderId}`,
      paidAmount: '10',
    });
    // 回调层语义:事务抛错 → 应答 fail(渠道重发)+ 留痕,不向渠道泄漏内部错误
    expect(answer).toBe('fail');
    expect(logged.some((m) => m.includes('credit failed'))).toBe(true);
  });

  it('markCredited CAS 失败 → 事务回滚抛 order_state_conflict,应答 fail(订单停留可重试)', async () => {
    const { payments } = harness({ markCreditedFalse: true });
    const order = await payments.createTopupOrder(9002, { amount: '10' });
    const answer = await payments.handleNotify('stripe', {
      providerOrderId: `cs_${order.orderId}`,
      paidAmount: '10',
    });
    expect(answer).toBe('fail');
  });

  it('渠道会话回填失败 → 大声留痕不吞(logError 记录),下单仍成功', async () => {
    const { payments, logged } = harness({ attachThrows: true });
    const order = await payments.createTopupOrder(9003, { amount: '10' });
    expect(order.payUrl).toContain('cs_');
    expect(logged.some((m) => m.includes('attach provider order id failed'))).toBe(true);
  });

  it('渠道下单失败且关单留痕也失败 → best-effort 吞错,仍抛 payment_channel_unavailable', async () => {
    const { payments } = harness({ markChannelFailedThrows: true }, { failCreate: true });
    const attempt = await payments
      .createTopupOrder(9004, { amount: '10' })
      .catch((error: unknown) => error);
    expect(isBusinessError(attempt) && attempt.code === 'billing.payment_channel_unavailable').toBe(
      true,
    );
  });
});
