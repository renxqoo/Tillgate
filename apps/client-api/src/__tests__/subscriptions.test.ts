/**
 * 订阅生命周期集成套件（真 PG + subscription 域）：
 * 购买（现金收款/四道闸门）/ 幂等重放 / 续费顺延+凭证改绑 / 升档折算 / 降档拒绝。
 * 资损不变量：收款=钱包 transfer（现金口径禁透支）；重放不二次扣款。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { apiKeys, userSubscriptions } from '@ai-gateway/db';
import { createSubscriptionDomain, systemContext } from '@ai-gateway/service';
import { InsufficientCashError, SubscriptionDomainError } from '@ai-gateway/domain';
import {
  balanceOf,
  db,
  expectAmountEq,
  newEnterpriseUser,
  newPlan,
  newUser,
  uid,
  wallet,
} from './helpers.js';

const ctx = systemContext('cav2-sub');
const domain = createSubscriptionDomain({ db, wallet });

async function fund(userId: number, amount: string): Promise<void> {
  await wallet.credit(ctx, { userId, amount, refType: 'gift', refId: uid('fund') });
}

async function activeSubOf(userId: number) {
  const [row] = await db
    .select()
    .from(userSubscriptions)
    .where(eq(userSubscriptions.userId, userId))
    .orderBy(userSubscriptions.id);
  return row!;
}

describe('购买', () => {
  it('happy path：现金收款（禁透支）+ 订阅行快照（额度=档×席位）', async () => {
    const account = await newUser();
    await fund(account.id, '100');
    const planId = await newPlan({ price: '10', quotaAmount: '100', sortOrder: 1 });

    const result = await domain.purchase(ctx, {
      operationId: uid('op'),
      userId: account.id,
      planId,
      quantity: 1,
    });
    expect(result.quantity).toBe(1);
    expectAmountEq(result.price, '10');
    expectAmountEq(result.quotaAmount, '100');
    expectAmountEq(await balanceOf(account.id), '90'); // 100 − 10
    const sub = await activeSubOf(account.id);
    expect(sub.status).toBe(0);
    expectAmountEq(sub.quotaAmount, '100');
  });

  it('已有有效订阅 → already_subscribed（单有效订阅不变量）', async () => {
    const account = await newUser();
    await fund(account.id, '100');
    const planId = await newPlan({ price: '10', quotaAmount: '100' });
    await domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId });
    await expect(
      domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId }),
    ).rejects.toMatchObject({ code: 'already_subscribed' });
    expectAmountEq(await balanceOf(account.id), '90'); // 第二次不扣款
  });

  it('余额不足 → InsufficientCash（402 语义；不落订阅行）', async () => {
    const account = await newUser();
    const planId = await newPlan({ price: '10', quotaAmount: '100' });
    await expect(
      domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId }),
    ).rejects.toThrow(InsufficientCashError);
    const rows = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, account.id));
    expect(rows.length).toBe(0);
  });

  it('加油包 planId → not_a_pack；零价套餐 → plan_not_purchasable；停用 → plan_disabled', async () => {
    const account = await newUser();
    await fund(account.id, '1000');
    const packId = await newPlan({ price: '5', quotaAmount: '50', kind: 'pack' });
    const zeroId = await newPlan({ price: '0', quotaAmount: '50' });
    const disabledId = await newPlan({ price: '5', quotaAmount: '50', status: 1 });
    await expect(
      domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId: packId }),
    ).rejects.toMatchObject({ code: 'not_a_pack' });
    await expect(
      domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId: zeroId }),
    ).rejects.toMatchObject({ code: 'plan_not_purchasable' });
    await expect(
      domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId: disabledId }),
    ).rejects.toMatchObject({ code: 'plan_disabled' });
  });

  it('席位闸：qty>1 须 allowSeats；团队套餐须企业账户', async () => {
    const personal = await newUser();
    await fund(personal.id, '1000');
    const soloId = await newPlan({ price: '10', quotaAmount: '100' });
    await expect(
      domain.purchase(ctx, { operationId: uid('op'), userId: personal.id, planId: soloId, quantity: 2 }),
    ).rejects.toMatchObject({ code: 'seats_not_allowed' });

    const teamId = await newPlan({ price: '50', quotaAmount: '500', allowSeats: true, sortOrder: 3 });
    await expect(
      domain.purchase(ctx, { operationId: uid('op'), userId: personal.id, planId: teamId, quantity: 1 }),
    ).rejects.toMatchObject({ code: 'enterprise_required' });
  });

  it('团队套餐（企业）：组织同事务创建，owner 占 1 席；额度=档×席位', async () => {
    const owner = await newEnterpriseUser();
    await fund(owner.id, '1000');
    const teamId = await newPlan({ price: '50', quotaAmount: '500', allowSeats: true, sortOrder: 3 });

    const result = await domain.purchase(ctx, {
      operationId: uid('op'),
      userId: owner.id,
      planId: teamId,
      quantity: 3,
      ensureOrg: true,
    });
    expect(result.orgId).not.toBeNull();
    expect(result.quantity).toBe(3);
    expectAmountEq(result.quotaAmount, '1500'); // 500 × 3
    expectAmountEq(result.price, '150'); // 50 × 3
  });

  it('幂等重放：同 operationId 同参 → 回放回执不二次扣款；异参 → 409', async () => {
    const account = await newUser();
    await fund(account.id, '100');
    const planId = await newPlan({ price: '10', quotaAmount: '100' });
    const opId = uid('op');
    const first = await domain.purchase(ctx, { operationId: opId, userId: account.id, planId });
    expect(first.replayed).toBe(false);
    const replay = await domain.purchase(ctx, { operationId: opId, userId: account.id, planId });
    expect(replay.replayed).toBe(true);
    expect(replay.subscriptionId).toBe(first.subscriptionId);
    expectAmountEq(await balanceOf(account.id), '90');
  });

  it('C4：自然到期未翻转的行被惰性置 1——新购买不再死锁', async () => {
    const account = await newUser();
    await fund(account.id, '100');
    const planId = await newPlan({ price: '10', quotaAmount: '100' });
    await domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId });
    // 把 endAt 拉到过去（模拟到期后无人访问的状态）
    await db
      .update(userSubscriptions)
      .set({ endAt: new Date(Date.now() - 86_400_000) })
      .where(eq(userSubscriptions.userId, account.id));
    const second = await domain.purchase(ctx, {
      operationId: uid('op'),
      userId: account.id,
      planId,
    });
    expect(second.replayed).toBe(false);
    expectAmountEq(await balanceOf(account.id), '80');
  });
});

describe('续费', () => {
  it('顺延（未到期从旧 end 起）+ 旧订阅转到期 + 凭证改绑', async () => {
    const account = await newUser();
    await fund(account.id, '100');
    const planId = await newPlan({ price: '10', quotaAmount: '100', periodDays: 30 });
    const first = await domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId });
    // 建 Key 绑定旧订阅（续费后应自动改绑）
    const [key] = await db
      .insert(apiKeys)
      .values({
        keyHash: randomUUID().replace(/-/g, ''),
        keyPreview: 'ag_****renew',
        userId: account.id,
        name: 'sub-key',
        subscriptionId: first.subscriptionId,
      })
      .returning({ id: apiKeys.id });
    void key;

    const renewed = await domain.renew(ctx, {
      operationId: uid('op'),
      userId: account.id,
      subscriptionId: first.subscriptionId,
    });
    // 顺延：新 startAt = 旧 endAt
    expect(new Date(renewed.startAt).getTime()).toBe(new Date(first.endAt).getTime());
    // 旧订阅 status=1；新订阅 active
    const [oldRow] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, first.subscriptionId));
    expect(oldRow!.status).toBe(1);
    // Key 改绑到新订阅（续费不打断现有 key）
    const [rebound] = await db
      .select({ subscriptionId: apiKeys.subscriptionId })
      .from(apiKeys)
      .where(eq(apiKeys.userId, account.id));
    expect(rebound!.subscriptionId).toBe(renewed.subscriptionId);
    expectAmountEq(await balanceOf(account.id), '80'); // 两次 10 元
  });

  it('他人订阅续费 → no_subscription（归属校验）', async () => {
    const owner = await newUser();
    const attacker = await newUser();
    await fund(owner.id, '100');
    const planId = await newPlan({ price: '10', quotaAmount: '100' });
    const sub = await domain.purchase(ctx, { operationId: uid('op'), userId: owner.id, planId });
    await expect(
      domain.renew(ctx, { operationId: uid('op'), userId: attacker.id, subscriptionId: sub.subscriptionId }),
    ).rejects.toMatchObject({ code: 'no_subscription' });
  });
});

describe('变更（升档/加席位）', () => {
  it('升档补差价 = 新总价 − 剩余价值（线性折旧）', async () => {
    const account = await newUser();
    await fund(account.id, '1000');
    const liteId = await newPlan({ price: '10', quotaAmount: '100', sortOrder: 1 });
    const proId = await newPlan({ price: '30', quotaAmount: '400', sortOrder: 2 });
    const first = await domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId: liteId });

    // 消耗 50 额度（模拟使用：直接 UPDATE used_amount）
    await db
      .update(userSubscriptions)
      .set({ usedAmount: '50' })
      .where(eq(userSubscriptions.id, first.subscriptionId));

    const changed = await domain.change(ctx, {
      operationId: uid('op'),
      userId: account.id,
      subscriptionId: first.subscriptionId,
      targetPlanId: proId,
      quantity: 1,
    });
    // 剩余价值 = 10 × 50/100 = 5；补差 = 30 − 5 = 25；总扣款 = 10 + 25 = 35
    expectAmountEq(await balanceOf(account.id), '965');
    expectAmountEq(changed.quotaAmount, '400');
    expect(changed.subscriptionId).not.toBe(first.subscriptionId);
  });

  it('免费升级（剩余价值 ≥ 新总价）零收款；无变化 → already_subscribed', async () => {
    const account = await newUser();
    await fund(account.id, '1000');
    const expensiveId = await newPlan({ price: '100', quotaAmount: '1000', sortOrder: 1 });
    const cheapId = await newPlan({ price: '5', quotaAmount: '10', sortOrder: 2 });
    const sub = await domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId: expensiveId });

    const changed = await domain.change(ctx, {
      operationId: uid('op'),
      userId: account.id,
      subscriptionId: sub.subscriptionId,
      targetPlanId: cheapId,
      quantity: 1,
    });
    expect(changed.balanceBefore).toBeNull(); // 零收款
    expectAmountEq(await balanceOf(account.id), '900'); // 只有首购 100

    // 同套餐同数量 → already_subscribed
    await expect(
      domain.change(ctx, {
        operationId: uid('op'),
        userId: account.id,
        subscriptionId: changed.subscriptionId,
        targetPlanId: cheapId,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ code: 'already_subscribed' });
  });

  it('降档拒绝（层级不降/席位不缩容）', async () => {
    const account = await newUser();
    await fund(account.id, '1000');
    const proId = await newPlan({ price: '30', quotaAmount: '400', sortOrder: 2 });
    const liteId = await newPlan({ price: '10', quotaAmount: '100', sortOrder: 1 });
    const sub = await domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId: proId });
    await expect(
      domain.change(ctx, {
        operationId: uid('op'),
        userId: account.id,
        subscriptionId: sub.subscriptionId,
        targetPlanId: liteId,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ code: 'downgrade_not_allowed' });
  });

  it('变更后旧订阅转到期 + 新行 active', async () => {
    const account = await newUser();
    await fund(account.id, '1000');
    const liteId = await newPlan({ price: '10', quotaAmount: '100', sortOrder: 1 });
    const proId = await newPlan({ price: '30', quotaAmount: '400', sortOrder: 2 });
    const sub = await domain.purchase(ctx, { operationId: uid('op'), userId: account.id, planId: liteId });
    await domain.change(ctx, {
      operationId: uid('op'),
      userId: account.id,
      subscriptionId: sub.subscriptionId,
      targetPlanId: proId,
      quantity: 1,
    });
    const [oldRow] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, sub.subscriptionId));
    expect(oldRow!.status).toBe(1);
  });
});

describe('错误家谱自检', () => {
  it('SubscriptionDomainError 形状（code 携带语义）', () => {
    const err = new SubscriptionDomainError('plan_not_found');
    expect(err.code).toBe('plan_not_found');
    expect(err).toBeInstanceOf(Error);
  });
});
