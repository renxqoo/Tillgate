import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { Decimal } from '@ai-gateway/money';
import { paymentOrders, transactions, users } from '@ai-gateway/db/schema';
import { createLedger } from '../ledger.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let connected = false;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

async function createUser(): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ issuer: 'test', subject: `pay-${randomUUID()}`, identityProvider: 'local', balance: '0' })
    .returning({ id: users.id });
  return u!.id;
}

async function createOrder(userId: number, amount: string, credit: string): Promise<string> {
  const [order] = await db
    .insert(paymentOrders)
    .values({
      provider: 'epay',
      providerOrderId: `trade-${randomUUID().slice(0, 12)}`,
      userId,
      amount,
      currency: 'CNY',
      creditAmount: credit,
      status: 0,
    })
    .returning({ id: paymentOrders.id });
  return order!.id;
}

describe('paymentCredit / paymentRefund 幂等入账', () => {
  it('首次入账成功 + 同单并发重放只入账一次（余额恒等不变量）', async () => {
    if (!connected) return it.skip('no DB');
    const ledger = createLedger({ db });
    const userId = await createUser();
    const orderId = await createOrder(userId, '10', '10');
    const providerOrderId = (
      await db.query.paymentOrders.findFirst({ where: eq(paymentOrders.id, orderId) })
    )!.providerOrderId;

    // 并发两次同单入账（模拟回调重复到达）
    const results = await Promise.allSettled([
      ledger.paymentCredit({ provider: 'epay', providerOrderId, paymentOrderId: orderId, userId, amount: '10', creditAmount: '10' }),
      ledger.paymentCredit({ provider: 'epay', providerOrderId, paymentOrderId: orderId, userId, amount: '10', creditAmount: '10' }),
    ]);
    // 恰一次真实入账（replayed=false）；另一次为幂等重放（ok=true + replayed=true）
    const executed = results.filter((r) => r.status === 'fulfilled' && r.value.ok && !r.value.replayed);
    const replayed = results.filter((r) => r.status === 'fulfilled' && r.value.ok && r.value.replayed);
    expect(executed).toHaveLength(1);
    expect(replayed).toHaveLength(1);

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(new Decimal(user!.balance).eq(10)).toBe(true); // 只加一次

    const txn = await db.query.transactions.findMany({ where: eq(transactions.userId, userId) });
    expect(txn.filter((t) => t.type === 'payment')).toHaveLength(1); // 单条入账流水（部分唯一索引双保险）

    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, orderId));
    expect(order!.status).toBe(2); // credited
    expect(order!.creditedOperationId).toBe(`payment-credit:epay:${providerOrderId}`);

    // 第三次（顺序）重放：同样不再入账
    const third = await ledger.paymentCredit({ provider: 'epay', providerOrderId, paymentOrderId: orderId, userId, amount: '10', creditAmount: '10' });
    expect(third.ok).toBe(true); // 重放契约：返回首次结果 + replayed=true
    expect(third.replayed).toBe(true);
    const [user2] = await db.select().from(users).where(eq(users.id, userId));
    expect(new Decimal(user2!.balance).eq(10)).toBe(true);

    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(paymentOrders).where(eq(paymentOrders.id, orderId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('退款：credited → refunded 扣回余额（信用地板守卫）；重复退款拒绝', async () => {
    if (!connected) return it.skip('no DB');
    const ledger = createLedger({ db });
    const userId = await createUser();
    const orderId = await createOrder(userId, '10', '10');
    const providerOrderId = (
      await db.query.paymentOrders.findFirst({ where: eq(paymentOrders.id, orderId) })
    )!.providerOrderId;

    const credit = await ledger.paymentCredit({ provider: 'epay', providerOrderId, paymentOrderId: orderId, userId, amount: '10', creditAmount: '10' });
    expect(credit.ok).toBe(true);
    // 消费 3 元（余额 7）
    await db.update(users).set({ balance: '7' }).where(eq(users.id, userId));

    const refund = await ledger.paymentRefund({ provider: 'epay', providerOrderId, paymentOrderId: orderId, userId, amount: '5' });
    expect(refund.ok).toBe(true);
    const [u1] = await db.select().from(users).where(eq(users.id, userId));
    expect(new Decimal(u1!.balance).eq(2)).toBe(true);

    const refund2 = await ledger.paymentRefund({ provider: 'epay', providerOrderId, paymentOrderId: orderId, userId, amount: '5' });
    expect(refund2.replayed).toBe(true); // 幂等重放（首次退款结果），不再扣款
    const [u2] = await db.select().from(users).where(eq(users.id, userId));
    expect(new Decimal(u2!.balance).eq(2)).toBe(true);

    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, orderId));
    expect(order!.status).toBe(3);

    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(paymentOrders).where(eq(paymentOrders.id, orderId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('grantPromotionalCredit：同 operationId 幂等（防并发双发）', async () => {
    if (!connected) return it.skip('no DB');
    const ledger = createLedger({ db });
    const userId = await createUser();
    const opId = `referral-signup:${userId}:inviter`;
    const [a, b] = await Promise.allSettled([
      ledger.grantPromotionalCredit({ operationId: opId, userId, amount: '1', kind: 'referral_signup', refId: opId }),
      ledger.grantPromotionalCredit({ operationId: opId, userId, amount: '1', kind: 'referral_signup', refId: opId }),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2); // 一次执行 + 一次重放（同指纹）
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(new Decimal(user!.balance).eq(1)).toBe(true); // 只发一次

    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });
});
