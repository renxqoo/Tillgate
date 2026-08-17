import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { fundOperations, paymentOrders, transactions, users } from '@ai-gateway/db/schema';
import { createLedger } from '@ai-gateway/ledger';
import { Decimal } from '@ai-gateway/money';
import { randomUUID } from 'node:crypto';
import { createEpayProvider, epaySign } from '../../services/payments/providers.js';
import { createPaymentServices } from '../../services/payments/orders.js';
import { paymentPublicRoutes } from '../payments.js';

/**
 * 易支付回调端到端：验签 → 订单 credited → 幂等入账 → 重复回调不双扣。
 */

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', {
  poolMax: 5,
});
let connected = false;

const EPAY_KEY = 'test-epay-key-0123456789abcdef';

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

describe('易支付回调 e2e（签名验证 + 幂等入账）', () => {
  it('合法签名回调 → credited + 余额入账；重复回调 → success 但不双扣；篡改签名 → fail', async () => {
    if (!connected) return it.skip('no DB');
    const ledger = createLedger({ db });
    const provider = createEpayProvider({
      pid: '1001',
      key: EPAY_KEY,
      gatewayUrl: 'https://pay.test/submit.php',
      notifyUrl: 'https://api.test/notify',
      returnUrl: 'https://app.test/billing',
    });
    const services = createPaymentServices(db, ledger, { epay: provider });

    // 测试用户 + created 订单（模拟 createOrder 已落库）
    const [u] = await db
      .insert(users)
      .values({ issuer: 'test', subject: `pay-e2e-${randomUUID()}`, identityProvider: 'local', balance: '0' })
      .returning();
    const userId = u!.id;
    const [order] = await db
      .insert(paymentOrders)
      .values({
        provider: 'epay',
        providerOrderId: `ord-${randomUUID().slice(0, 12)}`,
        userId,
        amount: '20',
        currency: 'CNY',
        creditAmount: '20',
        status: 0,
      })
      .returning({ id: paymentOrders.id, providerOrderId: paymentOrders.providerOrderId });
    const orderId = order!.id;

    const app = paymentPublicRoutes(services);
    const callback = (over: Record<string, string> = {}): Promise<Response> => {
      const params: Record<string, string> = {
        pid: '1001',
        trade_no: 'channel-123',
        out_trade_no: orderId,
        type: 'alipay',
        name: 'AI Gateway 余额充值',
        money: '20',
        trade_status: 'TRADE_SUCCESS',
        timestamp: String(Math.floor(Date.now() / 1000)),
        ...over,
      };
      params.sign = epaySign(over.sign === 'BAD'.repeat(6).slice(0, 32) ? { ...params, sign: '' } : params, EPAY_KEY);
      if (over.sign !== undefined) params.sign = over.sign;
      const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      return Promise.resolve(app.request(`/epay/notify?${qs}`));
    };

    // 篡改签名 → fail（400 契约：回 fail 文本）
    const bad = await callback({ sign: '0'.repeat(32) });
    expect(await bad.text()).toBe('fail');

    // 合法回调 → success + 入账
    const ok = await callback();
    expect(await ok.text()).toBe('success');
    const [u1] = await db.select().from(users).where(eq(users.id, userId));
    expect(new Decimal(u1!.balance).eq(20)).toBe(true);
    const [o1] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, orderId));
    expect(o1!.status).toBe(2);

    // 重复回调 → success（幂等重放）但余额不变
    const dup = await callback();
    expect(await dup.text()).toBe('success');
    const [u2] = await db.select().from(users).where(eq(users.id, userId));
    expect(new Decimal(u2!.balance).eq(20)).toBe(true);

    // 测试数据纪律：同步清理衍生投影（流水/幂等键）再删主体
    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(paymentOrders).where(eq(paymentOrders.id, orderId));
    await db.delete(fundOperations).where(eq(fundOperations.operationId, `payment-credit:epay:${order!.providerOrderId}`));
    await db.delete(users).where(eq(users.id, userId));
  });
});
