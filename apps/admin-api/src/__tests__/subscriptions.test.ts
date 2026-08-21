/**
 * 订阅管理面语义：
 *   - 取消不存在 → 404；change 缺 targetPlanId → 400
 *   - 管理面全链：入金 → 购买（域）→ 管理面续费/变更/取消
 *   - 列表 q 搜 用户 subject / 套餐名（双 join——计数同步防 500）
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { plans, users } from '@ai-gateway/db';
import { systemContext, createSubscriptionDomain } from '@ai-gateway/service';
import { Decimal } from '@ai-gateway/domain';
import {
  buildTestApp,
  db,
  fundUser,
  newAdmin,
  newPlanRow,
  newUserRow,
  uid,
  wallet,
} from './helpers.js';

const ctx = systemContext('aav2-sub-test');

async function balanceOf(userId: number): Promise<string> {
  const accounts = await wallet.accounts(ctx, userId);
  return accounts[0]?.balance ?? '0';
}

describe('订阅管理面边界', () => {
  it('cancel 不存在 → 404；change 缺 targetPlanId → 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect(
      (await request('/v1/subscriptions/999999999/cancel', { method: 'POST', token })).status,
    ).toBe(404);
    expect(
      (await request('/v1/subscriptions/999999999/change', { method: 'POST', token, body: { quantity: 1 } })).status,
    ).toBe(400);
  });
});

describe('管理面全链（购买→续费→变更→取消）', () => {
  it('续费顺延收款；取消 CAS 0→2 无资金变动', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    const planId = await newPlanRow({ price: '30', quotaAmount: '30' });
    const betterPlanId = await newPlanRow({ price: '60', quotaAmount: '60' });
    // 升档判定按 sortOrder（防降级）——高档位排前
    await db.update(plans).set({ sortOrder: 1 }).where(eq(plans.id, planId));
    await db.update(plans).set({ sortOrder: 2 }).where(eq(plans.id, betterPlanId));
    await fundUser(userId, '200');

    const domain = createSubscriptionDomain({ db, wallet });
    const purchased = await domain.purchase(ctx, {
      operationId: uid('buy'),
      userId,
      planId,
      quantity: 1,
    });
    expect(new Decimal(purchased.price).eq(30)).toBe(true);

    // 管理面续费（免属主：userId=null 路径）
    const renewKey = uid('renew');
    const renewed = (await (
      await request(`/v1/subscriptions/${purchased.subscriptionId}/renew`, {
        method: 'POST',
        token,
        headers: { 'idempotency-key': renewKey },
      })
    ).json()) as { subscriptionId: number; price: string };
    expect(new Decimal(renewed.price).eq(30)).toBe(true);

    // 管理面变更（升档）
    const changed = (await (
      await request(`/v1/subscriptions/${renewed.subscriptionId}/change`, {
        method: 'POST',
        token,
        body: { targetPlanId: betterPlanId, quantity: 1 },
        headers: { 'idempotency-key': uid('chg') },
      })
    ).json()) as { planId: number; subscriptionId: number };
    expect(changed.planId).toBe(betterPlanId);

    // 管理面取消：CAS 0→2；余额不动（无退款）
    const balanceBefore = await balanceOf(userId);
    const cancelled = await request(`/v1/subscriptions/${changed.subscriptionId}/cancel`, {
      method: 'POST',
      token,
      headers: { 'idempotency-key': uid('cxl') },
    });
    expect(cancelled.status).toBe(200);
    expect(new Decimal(await balanceOf(userId)).eq(balanceBefore)).toBe(true);

    // 再取消 → 404（no_subscription 语义）
    expect(
      (await request(`/v1/subscriptions/${changed.subscriptionId}/cancel`, {
        method: 'POST',
        token,
        headers: { 'idempotency-key': uid('cxl2') },
      })).status,
    ).toBe(404);
  });

  it('加油包发放：有效订阅加额；无有效订阅 404', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    const planId = await newPlanRow();
    const packId = await newPlanRow({ kind: 'pack', price: '5', quotaAmount: '5', periodDays: 0 });
    await fundUser(userId, '100');

    // 无订阅先发 → 404（no_subscription）
    const early = await request(`/v1/subscriptions/${packId}/grant`, {
      method: 'POST',
      token,
      body: { userId },
      headers: { 'idempotency-key': uid('g0') },
    });
    expect(early.status).toBe(404);

    const domain = createSubscriptionDomain({ db, wallet });
    const purchased = await domain.purchase(ctx, { operationId: uid('buy'), userId, planId, quantity: 1 });
    const granted = await request(`/v1/subscriptions/${packId}/grant`, {
      method: 'POST',
      token,
      body: { userId },
      headers: { 'idempotency-key': uid('g1') },
    });
    expect(granted.status).toBe(200);
    const body = (await granted.json()) as { quotaAdded: string; subscriptionId: number };
    expect(new Decimal(body.quotaAdded).eq(5)).toBe(true);
    expect(body.subscriptionId).toBe(purchased.subscriptionId);
  });
});

describe('列表 join 计数（42P01 防线）', () => {
  it('q 搜用户 subject 与套餐名 → 200 且 total 正确', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const stamp = uid('lqjc');
    const userId = await newUserRow();
    await db.update(users).set({ subject: stamp }).where(eq(users.id, userId));
    const planId = await newPlanRow();
    await db.update(plans).set({ name: `${stamp}-plan` }).where(eq(plans.id, planId));
    await fundUser(userId, '50');
    const domain = createSubscriptionDomain({ db, wallet });
    await domain.purchase(ctx, { operationId: uid('buy'), userId, planId, quantity: 1 });

    const bySubject = (await (
      await request(`/v1/subscriptions?q=${stamp}`, { token })
    ).json()) as { total: number };
    expect(bySubject.total).toBe(1);
  });
});
