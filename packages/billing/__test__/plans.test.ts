/**
 * 套餐目录管理契约测试（内存 stand-in）：
 * kind×周期一致性 / kind 不可变 / 删除守卫（含历史订阅引用 → plan_in_use）。
 */
import { describe, expect, it } from 'vitest';
import { createBilling } from '../src/billing.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { createInMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';
import { BillingErrors } from '../src/domain/errors.js';

function harness() {
  const walletMemory = createInMemoryWalletStore();
  const world = createInMemoryBillingWorld();
  const billing = createBilling(
    {
      walletStore: walletMemory.store,
      store: world.billing,
      quota: world.quota,
    },
    {
      guards: { refTypes: ['billing'], currencies: ['CNY'], internalAccounts: ['outside'] },
      currency: 'CNY',
      resolver: world.resolver,
      usageDefectBreaker: 5,
    failurePolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      clock: () => new Date('2026-08-23T00:00:00Z'),
      onError: () => {},
    },
  );
  return { billing, world };
}

describe('Billing.plans（U6）', () => {
  it('创建:包月缺省 kind/周期校验;加油包禁周期', async () => {
    const { billing } = harness();
    const monthly = await billing.plans.create({
      name: '标准月',
      price: '30',
      periodDays: 30,
      quotaAmount: '100',
    });
    expect(monthly).toMatchObject({ kind: 'subscription', periodDays: 30, status: 0 });

    const pack = await billing.plans.create({
      name: '加油包',
      kind: 'pack',
      price: '10',
      quotaAmount: '50',
    });
    expect(pack).toMatchObject({ kind: 'pack', periodDays: 0 });

    await expect(
      billing.plans.create({
        name: 'x',
        kind: 'pack',
        price: '1',
        periodDays: 7,
        quotaAmount: '1',
      }),
    ).rejects.toMatchObject({ code: 'billing.invalid_period_days' });
    await expect(
      billing.plans.create({ name: 'x', price: '1', periodDays: 0, quotaAmount: '1' }),
    ).rejects.toMatchObject({ code: 'billing.invalid_period_days' });
    await expect(
      billing.plans.create({ name: 'x', price: '1', periodDays: 3651, quotaAmount: '1' }),
    ).rejects.toMatchObject({ code: 'billing.invalid_period_days' });
  });

  it('列表 q 过滤与分页;更新按当前 kind 合并校验周期', async () => {
    const { billing } = harness();
    const a = await billing.plans.create({
      name: 'plan-alpha',
      price: '1',
      periodDays: 30,
      quotaAmount: '1',
    });
    await billing.plans.create({ name: 'plan-beta', price: '2', periodDays: 30, quotaAmount: '1' });

    const all = await billing.plans.list({ sortBy: 'id', order: 'asc', limit: 20, offset: 0 });
    expect(all.total).toBe(2);
    const filtered = await billing.plans.list({
      q: 'alpha',
      sortBy: 'id',
      order: 'asc',
      limit: 20,
      offset: 0,
    });
    expect(filtered.rows.map((row) => row.id)).toEqual([a.id]);

    const updated = await billing.plans.update({
      planId: a.id,
      patch: { price: '9', periodDays: 31, status: 1 },
    });
    expect(updated).toMatchObject({ price: '9', periodDays: 31, status: 1 });

    await expect(billing.plans.update({ planId: 999, patch: { name: 'x' } })).rejects.toMatchObject(
      {
        code: 'billing.plan_not_found',
      },
    );
  });

  it('删除守卫:任何状态的订阅引用(含历史)→ plan_in_use;无引用可删', async () => {
    const { billing, world } = harness();
    const free = await billing.plans.create({
      name: 'free',
      price: '1',
      periodDays: 30,
      quotaAmount: '1',
    });
    await expect(billing.plans.remove({ planId: free.id })).resolves.toEqual({ ok: true });
    await expect(billing.plans.remove({ planId: free.id })).rejects.toMatchObject({
      code: 'billing.plan_not_found',
    });

    const used = await billing.plans.create({
      name: 'used',
      price: '1',
      periodDays: 30,
      quotaAmount: '1',
    });
    // 直接落一条历史订阅引用(已取消 status=2——「含历史」语义)
    const seq = world.fixtures.subscriptions.size + 1;
    world.fixtures.subscriptions.set(5000 + seq, {
      id: 5000 + seq,
      userId: 1,
      orgId: null,
      quotaAmount: '1',
      usedAmount: '0',
      reservedAmount: '0',
      status: 2,
      endAt: new Date('2026-01-01T00:00:00Z'),
      planId: used.id,
      quantity: 1,
      price: '1',
      startAt: new Date('2025-12-01T00:00:00Z'),
    });
    await expect(billing.plans.remove({ planId: used.id })).rejects.toMatchObject({
      code: 'billing.plan_in_use',
    });
  });

  it('订阅管理列表:过滤 + 剩余额度投影(remaining = quota − used − reserved)', async () => {
    const { billing, world } = harness();
    const plan = await billing.plans.create({
      name: 'p',
      price: '1',
      periodDays: 30,
      quotaAmount: '100',
    });
    world.fixtures.subscriptions.set(6001, {
      id: 6001,
      userId: 42,
      orgId: null,
      quotaAmount: '100',
      usedAmount: '30',
      reservedAmount: '20',
      status: 0,
      endAt: new Date('2026-09-01T00:00:00Z'),
      planId: plan.id,
      quantity: 1,
      price: '1',
      startAt: new Date('2026-08-01T00:00:00Z'),
    });
    const rows = await billing.subscriptions.adminList({
      planId: plan.id,
      userId: 42,
      status: 0,
      sortBy: 'id',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    expect(rows.total).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      id: 6001,
      planId: plan.id,
      quotaAmount: '100',
      remainingAmount: '50',
    });
    const empty = await billing.subscriptions.adminList({
      userId: 999,
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(empty).toMatchObject({ rows: [], total: 0 });
  });

  it('错误码登记核验(U6 词表)', () => {
    expect(BillingErrors.business('plan_in_use', {}).code).toBe('billing.plan_in_use');
    expect(BillingErrors.business('redeem_batch_not_found', {}).code).toBe(
      'billing.redeem_batch_not_found',
    );
  });
});
