/**
 * settlement 集成测试（真实 PG）：认领 → 结算（under/over/订阅/切分）→ 失败死信 → 回收兜底。
 * 覆盖「钱的下半生」：预扣之后必须有人收尾——结算落账、usage_logs 投影、滞留回收。
 * 数据纪律：v2s 前缀；清理顺序 = 明细 → usage → 账单 → key → 订阅 → plan → user。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import {
  apiKeys,
  billingRequests,
  billingReservations,
  plans,
  usageLogs,
  userSubscriptions,
  users,
} from '@ai-gateway/db';
import { createBillingDomain } from '../billing/index.js';
import { systemContext, type RunContext } from '../context.js';
import { Decimal, type BillingQuote, type UsageReceipt } from '@ai-gateway/domain';
import { createSettlementDomain, type SettlementClaim } from '../settlement/index.js';
import { createWallet } from '../wallet/wallet.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2s-suite');
const billing = createBillingDomain({ db, currency: 'CNY' });
const settlement = createSettlementDomain({
  db,
  currency: 'CNY',
  policy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
});

const createdUsers: number[] = [];
const createdRequests: string[] = [];
const createdKeys: number[] = [];
const createdSubscriptions: number[] = [];
const createdPlans: number[] = [];

const q: BillingQuote = {
  maxOutputTokens: 0,
  candidates: [
    {
      mappingId: 1, externalModel: 'gpt-x', realModel: 'gpt-real',
      inputPrice: '2', outputPrice: '0', cacheInputPrice: '2',
      coefficient: '1', inputTokenUpperBound: 1_000_000, billingPolicyFingerprint: null,
    },
  ],
};

function receipt(userId: number, requestId: string, inputTokens: number): UsageReceipt {
  return {
    requestId, userId, apiKeyId: null, appId: null, credentialType: 'key',
    externalModel: 'gpt-x', realModel: 'gpt-real', channelId: null, channelKey: 'test',
    usage: { inputTokens, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    inputPrice: '2', outputPrice: '0', cacheInputPrice: '2', coefficient: '1',
    durationMs: 50, stream: false, streamAborted: false, mappingId: 1,
    billingPolicyFingerprint: null,
  };
}

async function newUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ issuer: 'v2s', subject: `v2s-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

async function fund(userId: number, amount: string): Promise<void> {
  const wallet = createWallet({
    db,
    currency: 'CNY',
    guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
  });
  await wallet.credit(ctx, { userId, amount, refType: 'topup', refId: `v2s-fund-${userId}-${randomUUID().slice(0, 6)}` });
}

async function newSubscription(userId: number, quota: string): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({ name: `v2s-${randomUUID().slice(0, 8)}`, price: '0', periodDays: 30, quotaAmount: quota })
    .returning({ id: plans.id });
  createdPlans.push(plan!.id);
  const [sub] = await db
    .insert(userSubscriptions)
    .values({
      userId, planId: plan!.id, startAt: new Date(), endAt: new Date(Date.now() + 30 * 86_400_000),
      quotaAmount: quota, quantity: 1, price: '0', orgId: null,
    })
    .returning({ id: userSubscriptions.id });
  createdSubscriptions.push(sub!.id);
  return sub!.id;
}

async function newSubscriptionKey(userId: number, subscriptionId: number, allowPaygFallback: boolean): Promise<number> {
  const [key] = await db
    .insert(apiKeys)
    .values({
      keyHash: randomUUID(), keyPreview: `ag_****${randomUUID().slice(0, 4)}`,
      userId, subscriptionId, name: 'v2s-sub-key', allowPaygFallback,
    })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return key!.id;
}

/** 授权 + signal(succeeded) + 认领，返回可结算的 claim */
async function authorizeAndClaim(input: {
  userId: number;
  apiKeyId?: number;
  ttlMs?: number;
  inputTokens: number;
  reservationPolicy?: { mode: 'full' | 'fixed'; amount?: string };
}): Promise<SettlementClaim> {
  const requestId = randomUUID();
  createdRequests.push(requestId);
  await billing.authorize(ctx, {
    requestId, userId: input.userId, apiKeyId: input.apiKeyId ?? null, stream: false, quote: q,
    reservationLimit: '100', authorizationTtlMs: input.ttlMs ?? 300_000,
    ...(input.reservationPolicy != null ? { reservationPolicy: input.reservationPolicy } : {}),
  });
  await billing.signal(ctx, {
    type: 'request.succeeded',
    requestId,
    receipt: receipt(input.userId, requestId, input.inputTokens),
  });
  const claims = await settlement.claim(ctx, {
    ownerId: 'v2s-worker', batchSize: 5, claimLeaseMs: 60_000, requestIds: [requestId],
  });
  const claim = claims[0];
  if (!claim) throw new Error(`claim 未领到 ${requestId}`);
  return claim;
}

async function balanceOf(userId: number): Promise<{ balance: string; inFlight: string }> {
  const wallet = createWallet({
    db,
    currency: 'CNY',
    guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
  });
  const rows = await wallet.accounts(ctx, userId);
  const account = rows[0]!;
  return { balance: account.balance, inFlight: account.inFlight };
}

async function quotaOf(subscriptionId: number): Promise<{ used: string; reserved: string }> {
  const [row] = await db
    .select({ used: userSubscriptions.usedAmount, reserved: userSubscriptions.reservedAmount })
    .from(userSubscriptions)
    .where(eq(userSubscriptions.id, subscriptionId));
  return { used: row!.used, reserved: row!.reserved };
}

const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  if (createdRequests.length) {
    const requestIds = createdRequests.map((id) => id as never);
    await db.delete(billingReservations).where(inArray(billingReservations.billingRequestId, requestIds));
    await db.delete(usageLogs).where(inArray(usageLogs.requestId, requestIds));
    await db.delete(billingRequests).where(inArray(billingRequests.requestId, requestIds));
  }
  if (createdKeys.length) await db.delete(apiKeys).where(inArray(apiKeys.id, createdKeys));
  if (createdSubscriptions.length) {
    await db.delete(userSubscriptions).where(inArray(userSubscriptions.id, createdSubscriptions));
  }
  if (createdPlans.length) await db.delete(plans).where(inArray(plans.id, createdPlans));
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await db.$client.end().catch(() => {});
});

describe('回收：毒行隔离（队头阻塞防线）', () => {
  it('某行归还抛错不阻塞其余滞留单的释放', async () => {
    // 两张过期 in_flight：A 的预扣明细被人为删掉一条（投影断裂 = 毒行），B 完好
    const userA = await newUser();
    await fund(userA, '10');
    const reqA = randomUUID();
    createdRequests.push(reqA);
    await billing.authorize(ctx, {
      requestId: reqA, userId: userA, stream: false, quote: q,
      reservationLimit: '100', authorizationTtlMs: 300_000,
    });
    await billing.signal(ctx, { type: 'upstream.started', requestId: reqA, leaseOwner: 'gw', leaseMs: 1 });

    const userB = await newUser();
    await fund(userB, '10');
    const reqB = randomUUID();
    createdRequests.push(reqB);
    await billing.authorize(ctx, {
      requestId: reqB, userId: userB, stream: false, quote: q,
      reservationLimit: '100', authorizationTtlMs: 300_000,
    });
    await billing.signal(ctx, { type: 'upstream.started', requestId: reqB, leaseOwner: 'gw', leaseMs: 1 });
    await nap(30);

    // 毒化 A：删掉一条预扣明细 → 归还路径 Σ明细 ≠ 账单投影 → 抛 BillingInvariantError
    await db
      .delete(billingReservations)
      .where(eq(billingReservations.billingRequestId, reqA));

    // 批量单事务形态下 B 会被 A 阻塞（按 lease_expires_at 排序 A 在前则永不释放）；
    // 逐单事务形态下 B 必须被释放
    const result = await settlement.recover(ctx, { batchSize: 10 });
    expect(result.released).toBeGreaterThanOrEqual(1);

    const [brB] = await db
      .select({ status: billingRequests.status })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, reqB));
    expect(brB!.status).toBe('released');
    const walletB = await balanceOf(userB);
    expect(walletB.inFlight).toBe('0'); // B 的资金没有因 A 的毒行被冻结

    // A 保持原状（未错误置 released——CAS 回滚），留待人工
    const [brA] = await db
      .select({ status: billingRequests.status })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, reqA));
    expect(brA!.status).toBe('in_flight');
  });
});

describe('结算：认领 → 落账', () => {
  it('PAYG under-hold：实扣 0.6 / 预扣 2，余量归还；usage_logs 投影落库', async () => {
    const user = await newUser();
    await fund(user, '10');
    const claim = await authorizeAndClaim({ userId: user, inputTokens: 300_000 });

    const outcome = await settlement.processClaim(ctx, claim);
    expect(outcome).toBe('settled');

    const wallet = await balanceOf(user);
    expect(wallet.balance).toBe('9.4');
    expect(wallet.inFlight).toBe('0');
    const [br] = await db
      .select({ status: billingRequests.status })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, claim.requestId));
    expect(br!.status).toBe('settled');
    const [res] = await db
      .select({ status: billingReservations.status })
      .from(billingReservations)
      .where(eq(billingReservations.billingRequestId, claim.requestId));
    expect(res!.status).toBe('settled');
    const [usage] = await db
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.requestId, claim.requestId));
    expect(new Decimal(usage!.amount).eq('0.6')).toBe(true);
    expect(usage!.billedBy).toBe('payg');
    expect(new Decimal(usage!.paygAmount).eq('0.6')).toBe(true);
    expect(new Decimal(usage!.planAmount).isZero()).toBe(true);
  });

  it('PAYG over-hold（§4 补充授权）：实扣 4 / 预扣 2——补押差价精确落账', async () => {
    const user = await newUser();
    await fund(user, '10');
    const claim = await authorizeAndClaim({ userId: user, inputTokens: 2_000_000 });

    const outcome = await settlement.processClaim(ctx, claim);
    expect(outcome).toBe('settled');
    const wallet = await balanceOf(user);
    expect(wallet.balance).toBe('6'); // 10 − 4（hold 2 + over 2）
    expect(wallet.inFlight).toBe('0');
  });

  it('PAYG 超额且余额已被预留耗尽：全额补扣并形成负余额，不得少收', async () => {
    const user = await newUser();
    await fund(user, '2');
    const claim = await authorizeAndClaim({ userId: user, inputTokens: 2_000_000 });

    expect(await settlement.processClaim(ctx, claim)).toBe('settled');
    const account = await balanceOf(user);
    expect(account.balance).toBe('-2'); // 实际 4，已有余额 2，超额 2 形成应收负余额
    expect(account.inFlight).toBe('0');
    const [usage] = await db
      .select({ amount: usageLogs.amount })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, claim.requestId));
    expect(new Decimal(usage!.amount).eq('4')).toBe(true);
  });

  it('fixed 预扣 0.01：实际 2 元仍全额补扣，最终余额 -1.99', async () => {
    const user = await newUser();
    await fund(user, '0.01');
    const claim = await authorizeAndClaim({
      userId: user,
      inputTokens: 1_000_000,
      reservationPolicy: { mode: 'fixed', amount: '0.01' },
    });

    expect((await balanceOf(user)).inFlight).toBe('0.01');
    expect(await settlement.processClaim(ctx, claim)).toBe('settled');
    const account = await balanceOf(user);
    expect(account.balance).toBe('-1.99');
    expect(account.inFlight).toBe('0');
    const [usage] = await db
      .select({ amount: usageLogs.amount })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, claim.requestId));
    expect(new Decimal(usage!.amount).eq('2')).toBe(true);
  });

  it('纯订阅：额度核销 0.6、在途归零，钱包全程不动', async () => {
    const user = await newUser();
    const subId = await newSubscription(user, '5');
    const keyId = await newSubscriptionKey(user, subId, false);
    const claim = await authorizeAndClaim({ userId: user, apiKeyId: keyId, inputTokens: 300_000 });

    expect(await settlement.processClaim(ctx, claim)).toBe('settled');
    const quota = await quotaOf(subId);
    expect(new Decimal(quota.used).eq('0.6')).toBe(true);
    expect(new Decimal(quota.reserved).eq('0')).toBe(true);
    // 无钱包账户（从未充值）——订阅路径不触 wallet
    const [usage] = await db
      .select({ billedBy: usageLogs.billedBy, planAmount: usageLogs.planAmount })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, claim.requestId));
    expect(usage!.billedBy).toBe('plan');
    expect(new Decimal(usage!.planAmount).eq('0.6')).toBe(true);
  });

  it('切分结算（开关 ON）：订阅消 1 + PAYG 消 0.5，双路精确归账', async () => {
    const user = await newUser();
    await fund(user, '5');
    const subId = await newSubscription(user, '1');
    const keyId = await newSubscriptionKey(user, subId, true);
    const claim = await authorizeAndClaim({ userId: user, apiKeyId: keyId, inputTokens: 750_000 });

    expect(await settlement.processClaim(ctx, claim)).toBe('settled');
    const quota = await quotaOf(subId);
    expect(new Decimal(quota.used).eq('1')).toBe(true);
    expect(new Decimal(quota.reserved).eq('0')).toBe(true);
    const wallet = await balanceOf(user);
    expect(wallet.balance).toBe('4.5'); // 5 − 0.5（PAYG 消耗），0.5 余量已归还
    expect(wallet.inFlight).toBe('0');
    const [usage] = await db
      .select({ planAmount: usageLogs.planAmount, paygAmount: usageLogs.paygAmount })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, claim.requestId));
    expect(new Decimal(usage!.planAmount).eq('1')).toBe(true);
    expect(new Decimal(usage!.paygAmount).eq('0.5')).toBe(true);
  });

  it('幂等：认领失效后重放 → already_settled（usage_logs 判定）', async () => {
    const user = await newUser();
    await fund(user, '10');
    const claim = await authorizeAndClaim({ userId: user, inputTokens: 300_000 });
    expect(await settlement.processClaim(ctx, claim)).toBe('settled');
    // 同一 claim 重放（认领三元组已随 finalize 失效）
    const replay = await settlement.settleClaim(ctx, claim);
    expect(replay.outcome).toBe('already_settled');
    expect(replay.amount).toBe('0.6');
  });

  it('毒收据：解码守卫拦截 → dead（人工复核），零资金动作', async () => {
    const user = await newUser();
    await fund(user, '10');
    const claim = await authorizeAndClaim({ userId: user, inputTokens: 300_000 });
    const poisoned = { ...claim, receipt: { garbage: true } };

    expect(await settlement.processClaim(ctx, poisoned)).toBe('dead');
    const [br] = await db
      .select({ status: billingRequests.status })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, claim.requestId));
    expect(br!.status).toBe('dead');
    const wallet = await balanceOf(user);
    expect(wallet.balance).toBe('10'); // 未扣
    expect(wallet.inFlight).toBe('2'); // 预扣保持——死单复核出口决定放行或释放
  });
});

describe('回收：滞留单兜底', () => {
  it('authorized 过期未发上游 → released，预占归还', async () => {
    const user = await newUser();
    await fund(user, '10');
    const requestId = randomUUID();
    createdRequests.push(requestId);
    await billing.authorize(ctx, {
      requestId, userId: user, stream: false, quote: q,
      reservationLimit: '100', authorizationTtlMs: 1,
    });
    await nap(30);

    const result = await settlement.recover(ctx, { batchSize: 10 });
    expect(result.released).toBeGreaterThan(0);
    const [br] = await db
      .select({ status: billingRequests.status })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, requestId));
    expect(br!.status).toBe('released');
    const wallet = await balanceOf(user);
    expect(wallet.balance).toBe('10');
    expect(wallet.inFlight).toBe('0');
  });

  it('in_flight 租约过期（网关崩溃语义）→ released 不扣', async () => {
    const user = await newUser();
    await fund(user, '10');
    const requestId = randomUUID();
    createdRequests.push(requestId);
    await billing.authorize(ctx, {
      requestId, userId: user, stream: false, quote: q,
      reservationLimit: '100', authorizationTtlMs: 300_000,
    });
    await billing.signal(ctx, { type: 'upstream.started', requestId, leaseOwner: 'gw', leaseMs: 1 });
    await nap(30);

    await settlement.recover(ctx, { batchSize: 10 });
    const [br] = await db
      .select({ status: billingRequests.status })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, requestId));
    expect(br!.status).toBe('released');
    const wallet = await balanceOf(user);
    expect(wallet.balance).toBe('10');
    expect(wallet.inFlight).toBe('0');
  });

  it('processing 认领租约过期（worker 崩溃语义）→ retry_wait 可重领', async () => {
    const user = await newUser();
    await fund(user, '10');
    const claim = await authorizeAndClaim({ userId: user, inputTokens: 300_000 });
    // 原租约 60s——手工改小并等待，模拟 worker 崩溃后租约流逝
    await db
      .update(billingRequests)
      .set({ claimUntil: new Date(Date.now() - 1000) })
      .where(eq(billingRequests.requestId, claim.requestId));
    void claim;

    const result = await settlement.recover(ctx, { batchSize: 10 });
    expect(result.claimsRequeued).toBeGreaterThan(0);
    const [br] = await db
      .select({ status: billingRequests.status })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, claim.requestId));
    expect(br!.status).toBe('retry_wait');
    // 重领后可正常结算（幂等收尾闭环）
    const reclaims = await settlement.claim(ctx, {
      ownerId: 'v2s-worker-2', batchSize: 5, claimLeaseMs: 60_000, requestIds: [claim.requestId],
    });
    const reclaimed = reclaims[0];
    expect(reclaimed).toBeDefined();
    expect(await settlement.processClaim(ctx, reclaimed!)).toBe('settled');
    expect((await balanceOf(user)).balance).toBe('9.4');
  });
});

describe('终审修复回归（2026-08-19：0 元结算 / 订阅超池 / billedBy 口径）', () => {
  it('0 元结算（可信 usage 全 0）：预扣全额释放 → settled（修复前 InvalidAmountError 不属死信家族 → 10 轮重试全败 dead + 预扣冻结）', async () => {
    const user = await newUser();
    await fund(user, '10');
    const claim = await authorizeAndClaim({ userId: user, inputTokens: 0 });

    expect(await settlement.processClaim(ctx, claim)).toBe('settled');
    const wallet = await balanceOf(user);
    expect(wallet.balance).toBe('10'); // 分文不扣
    expect(wallet.inFlight).toBe('0'); // 预扣全释放（修复前永久冻结）
    const [usage] = await db
      .select({ amount: usageLogs.amount, billedBy: usageLogs.billedBy })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, claim.requestId));
    expect(new Decimal(usage!.amount).isZero()).toBe(true);
    expect(usage!.billedBy).toBe('payg');
  });

  it('订阅超池（遗留低估单）：套餐核销到预留额，超额全量计入负余额', async () => {
    const user = await newUser();
    // 池 2 元；预扣保守上界 2（quote 1M × 2/M）；实际用量 1.5M × 2/M = 3 > 池容量
    const subId = await newSubscription(user, '2');
    const keyId = await newSubscriptionKey(user, subId, false);
    const claim = await authorizeAndClaim({ userId: user, apiKeyId: keyId, inputTokens: 1_500_000 });

    expect(await settlement.processClaim(ctx, claim)).toBe('settled');
    const quota = await quotaOf(subId);
    expect(new Decimal(quota.used).eq('2')).toBe(true);
    expect(new Decimal(quota.reserved).eq('0')).toBe(true);
    expect((await balanceOf(user)).balance).toBe('-1');
    const [usage] = await db
      .select({ amount: usageLogs.amount, planAmount: usageLogs.planAmount, paygAmount: usageLogs.paygAmount })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, claim.requestId));
    expect(new Decimal(usage!.amount).eq('3')).toBe(true);
    expect(new Decimal(usage!.planAmount).eq('2')).toBe(true);
    expect(new Decimal(usage!.paygAmount).eq('1')).toBe(true);
  });

  it('billedBy 口径（纯函数）：绑定订阅但订阅未吸收（planConsume=0）→ payg，不再出现 billedBy=plan && subscriptionId=null 矛盾行', async () => {
    const { usageLogProjection } = await import('../settlement/usage-projection.js');
    const receiptLike = receipt(1, 'v2s-billed-by-probe', 100);
    const mixed = usageLogProjection({
      receipt: receiptLike,
      billing: { userId: 1, subscriptionId: 5, channelId: null },
      calculatedAmount: '0.3',
      upstreamCost: '0',
      planConsume: '0',
    }) as { billedBy: string; subscriptionId: number | null; paygAmount: string };
    expect(mixed.billedBy).toBe('payg'); // 修复前：绑定订阅即记 plan
    expect(mixed.subscriptionId).toBeNull();
    expect(new Decimal(mixed.paygAmount).eq('0.3')).toBe(true);

    const planAbsorbed = usageLogProjection({
      receipt: receiptLike,
      billing: { userId: 1, subscriptionId: 5, channelId: null },
      calculatedAmount: '1',
      upstreamCost: '0',
      planConsume: '1',
    }) as { billedBy: string; subscriptionId: number | null };
    expect(planAbsorbed.billedBy).toBe('plan');
    expect(planAbsorbed.subscriptionId).toBe(5);
  });
});
