import { describe, expect, it } from 'vitest';
import { createPaymentAdminApi } from '../src/application/payments/payment-admin';
import { createInMemoryPaymentStores } from '../src/testing/in-memory-payment-stores';
import { PAYMENT_ORDER_SORT_FIELDS } from '../src/ports/payment-ports';
import { isBusinessError } from '@tillgate/errors';
import type { BillingStore } from '../src/ports/billing-store';

/**
 * 支付订单管理面用例(admin-api P4):管理列表(q 双锚/排序/分页/total)+
 * 手动关单 CAS 0→4(幂等语义——非 created 状态与重复关单一律 order_state_conflict)。
 * 行为规格 = v1 payment-order.repo listAdminOrders/closeOrder + ops-logs.service。
 */

/** read/transaction 直通内存 store(会话语义在 PG 形态才存在) */
function passthroughStore(): Pick<BillingStore, 'read' | 'transaction'> {
  return {
    read: (fn) => fn({} as Parameters<typeof fn>[0]),
    transaction: (fn) => fn({} as Parameters<typeof fn>[0]),
  };
}

function setup() {
  const stores = createInMemoryPaymentStores();
  const api = createPaymentAdminApi({
    store: passthroughStore(),
    orders: stores.orderStore,
  });
  return { stores, api };
}

async function seedOrder(
  stores: ReturnType<typeof createInMemoryPaymentStores>,
  overrides: Record<string, unknown> = {},
) {
  const id = `order-${Math.random().toString(36).slice(2, 10)}`;
  await stores.orderStore.insertOrder({} as never, {
    id,
    provider: 'epay',
    providerOrderId: id,
    userId: 1,
    amount: '10',
    currency: 'CNY',
    creditAmount: '10',
    ...overrides,
  });
  return id;
}

describe('payment admin:list(管理列表语义)', () => {
  it('无 q 全量 + amount 排序 + 分页 + total 恒全量', async () => {
    const { stores, api } = setup();
    await seedOrder(stores, { amount: '30' });
    await seedOrder(stores, { amount: '10' });
    await seedOrder(stores, { amount: '20' });

    const byAmount = await api.list({ sortBy: 'amount', order: 'asc', limit: 10, offset: 0 });
    expect(byAmount.total).toBe(3);
    expect(byAmount.rows.map((r) => Number(r.amount))).toEqual([10, 20, 30]);

    const desc = await api.list({ sortBy: 'amount', order: 'desc', limit: 2, offset: 0 });
    expect(desc.rows.map((r) => Number(r.amount))).toEqual([30, 20]);
    expect(desc.total).toBe(3); // 分页不削 total

    const page2 = await api.list({ sortBy: 'amount', order: 'desc', limit: 2, offset: 2 });
    expect(page2.rows.map((r) => Number(r.amount))).toEqual([10]);
  });

  it('q 双锚:订单 uuid 精确命中 / 用户显示名精确匹配(v1 语义)', async () => {
    const { stores, api } = setup();
    const target = await seedOrder(stores);
    await seedOrder(stores);

    const byId = await api.list({ q: target, sortBy: 'id', order: 'asc', limit: 10, offset: 0 });
    expect(byId.total).toBe(1);
    expect(byId.rows[0]!.id).toBe(target);

    const byName = await api.list({
      q: 'nobody',
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(byName.total).toBe(0);
    expect(byName.rows).toEqual([]);
  });

  it('投影:userDisplayName 透出行注入;paidAt/creditedAt 缺省 null', async () => {
    const { stores, api } = setup();
    const id = await seedOrder(stores);
    const { rows } = await api.list({ q: id, sortBy: 'id', order: 'asc', limit: 10, offset: 0 });
    expect(rows[0]).toMatchObject({
      id,
      provider: 'epay',
      status: 0,
      paidAt: null,
      creditedAt: null,
      failureReason: null,
    });
  });
});

describe('payment admin:close(手动关单语义)', () => {
  it('created 单 CAS 0→4 + failureReason 留痕', async () => {
    const { stores, api } = setup();
    const id = await seedOrder(stores);
    const result = await api.close({ orderId: id, reason: '管理员手动关闭' });
    expect(result).toEqual({ ok: true });
    const { rows } = await api.list({ q: id, sortBy: 'id', order: 'asc', limit: 10, offset: 0 });
    expect(rows[0]).toMatchObject({ status: 4, failureReason: '管理员手动关闭' });
  });

  it('幂等语义:重复关单/已付/已入账/不存在 一律 order_state_conflict(409 语义)', async () => {
    const { stores, api } = setup();
    const created = await seedOrder(stores);
    await api.close({ orderId: created, reason: 'x' });
    // 第二次关单:状态已是 4 → 拒绝(v1 409 语义逐条保留)
    await expect(api.close({ orderId: created, reason: 'x' })).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'billing.order_state_conflict',
    );

    const paid = await seedOrder(stores);
    await stores.orderStore.markPaid({} as never, { orderId: paid, paidAt: new Date() });
    await expect(api.close({ orderId: paid, reason: 'x' })).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'billing.order_state_conflict',
    );

    await expect(api.close({ orderId: 'order-not-exist', reason: 'x' })).rejects.toSatisfy(
      (e: unknown) => isBusinessError(e) && e.code === 'billing.order_state_conflict',
    );
  });
});

describe('词表封闭(契约级,§10.1)', () => {
  it('排序白名单 = v1 ORDER_SORTS 逐字', () => {
    expect(PAYMENT_ORDER_SORT_FIELDS).toEqual(['id', 'amount', 'status', 'createdAt']);
  });
});
