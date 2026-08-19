/**
 * billing 网关侧测试（真实 PG）：授权预扣 → 信号四事件 → 敞口预留。
 * 结算（settleClaim）是 worker 用例——此处验证 signal(succeeded) 落 settlement_pending
 * 即网关侧的资金正确边界；钱包实扣由 worker 测试覆盖（角色裁剪 2026-08-19）。
 * 数据纪律：v2b 前缀；wallet 腿/交易 append-only 留档，业务行随套件清理。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { apiKeys, billingRequests, billingReservations, plans, usageLogs, userSubscriptions, users } from '@ai-gateway/db';
import { createBillingDomain } from '../billing/index.js';
import { systemContext, type RunContext } from '../context.js';
import type { BillingQuote, UsageReceipt } from '@ai-gateway/domain';
import { Decimal, normalizeAmount, SubscriptionQuotaExhaustedError } from '@ai-gateway/domain';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2b-suite');
const billing = createBillingDomain({ db, currency: 'CNY' });
const createdUsers: number[] = [];
const createdRequests: string[] = [];
const createdKeys: number[] = [];
const createdSubscriptions: number[] = [];
const createdPlans: number[] = [];

async function newUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ issuer: 'v2b', subject: `v2b-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

/** 直充 wallet（不经 billing——refType topup） */
async function fund(userId: number, amount: string): Promise<void> {
  const { createWallet } = await import('../wallet/wallet.js');
  const wallet = createWallet({
    db,
    currency: 'CNY',
    guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
  });
  await wallet.credit(ctx, { userId, amount, refType: 'topup', refId: `v2b-fund-${userId}-${randomUUID().slice(0, 6)}` });
}

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

function receipt(userId: number, requestId: string, inputTokens: number, channelId: number | null = null): UsageReceipt {
  return {
    requestId, userId, apiKeyId: null, appId: null, credentialType: 'key',
    externalModel: 'gpt-x', realModel: 'gpt-real', channelId, channelKey: 'test',
    usage: { inputTokens, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    inputPrice: '2', outputPrice: '0', cacheInputPrice: '2', coefficient: '1',
    durationMs: 50, stream: false, streamAborted: false, mappingId: 1,
    billingPolicyFingerprint: null,
  };
}

afterAll(async () => {
  if (createdRequests.length) {
    const requestIds = createdRequests.map((id) => id as never);
    // 明细行引用账单（FK）——先删 billing_reservations 再删账单
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

/** 建订阅（plans + user_subscriptions，个人订阅无 org）并登记清理 */
async function newSubscription(userId: number, quota: string): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({ name: `v2b-${randomUUID().slice(0, 8)}`, price: '0', periodDays: 30, quotaAmount: quota })
    .returning({ id: plans.id });
  createdPlans.push(plan!.id);
  const [sub] = await db
    .insert(userSubscriptions)
    .values({
      userId,
      planId: plan!.id,
      startAt: new Date(),
      endAt: new Date(Date.now() + 30 * 86_400_000),
      quotaAmount: quota,
      quantity: 1,
      price: '0',
      orgId: null,
    })
    .returning({ id: userSubscriptions.id });
  createdSubscriptions.push(sub!.id);
  return sub!.id;
}

/** 建套餐 Key（绑定订阅；allowPaygFallback = 包月耗尽自动转按量开关） */
async function newSubscriptionKey(
  userId: number,
  subscriptionId: number,
  allowPaygFallback: boolean,
): Promise<number> {
  const [key] = await db
    .insert(apiKeys)
    .values({
      keyHash: randomUUID(),
      keyPreview: `ag_****${randomUUID().slice(0, 4)}`,
      userId,
      subscriptionId,
      name: 'v2b-sub-key',
      allowPaygFallback,
    })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return key!.id;
}

async function quotaReservedOf(subscriptionId: number): Promise<string> {
  const [row] = await db
    .select({ reserved: userSubscriptions.reservedAmount })
    .from(userSubscriptions)
    .where(eq(userSubscriptions.id, subscriptionId));
  return row!.reserved;
}

describe('网关侧资金触点', () => {
  it('授权冻结 → 起租 → 收据验收 → settlement_pending（结算权移交 worker）', async () => {
    const user = await newUser();
    await fund(user, '10');
    const requestId = randomUUID();
    createdRequests.push(requestId);

    const authorized = await billing.authorize(ctx, {
      requestId, userId: user, stream: false, quote: q,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    expect(authorized.reservedAmount).toBe('2'); // 1M×2/M
    expect(authorized.availableBalance).toBe('8'); // 10 − 2 在途

    const started = await billing.signal(ctx, { type: 'upstream.started', requestId, leaseOwner: 'gw', leaseMs: 30_000 });
    expect(started.status).toBe('in_flight');

    const succeeded = await billing.signal(ctx, {
      type: 'request.succeeded', requestId, receipt: receipt(user, requestId, 300_000),
    });
    expect(succeeded.status).toBe('settlement_pending'); // 网关终态：等待 worker 结算
    const { createWallet } = await import('../wallet/wallet.js');
    const wallet = createWallet({
      db,
      currency: 'CNY',
      guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
    });
    const account = (await wallet.accounts(ctx, user))[0]!;
    expect(account.inFlight).toBe('2'); // 冻结保持——结算时才实扣
  });

  it('失败释放：三路归零不扣，金额证据可追', async () => {
    const user = await newUser();
    await fund(user, '5');
    const requestId = randomUUID();
    createdRequests.push(requestId);
    await billing.authorize(ctx, { requestId, userId: user, stream: false, quote: q, reservationLimit: '10', authorizationTtlMs: 300_000 });
    const failed = await billing.signal(ctx, { type: 'request.failed', requestId, reason: 'upstream_error' });
    expect(failed.status).toBe('released');
    expect(failed.amountReleased).toBe('2');
    const { createWallet } = await import('../wallet/wallet.js');
    const wallet = createWallet({
      db,
      currency: 'CNY',
      guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
    });
    const account = (await wallet.accounts(ctx, user))[0]!;
    expect(account.balance).toBe('5');
    expect(account.inFlight).toBe('0');
  });

  it('余额不足：授权拒绝零残留（钱包 InsufficientCash 原样上抛）', async () => {
    const user = await newUser();
    await fund(user, '1');
    const requestId = randomUUID();
    await expect(
      billing.authorize(ctx, { requestId, userId: user, stream: false, quote: q, reservationLimit: '10', authorizationTtlMs: 300_000 }),
    ).rejects.toThrow();
    const [row] = await db.select({ id: billingRequests.requestId }).from(billingRequests).where(eq(billingRequests.requestId, requestId));
    expect(row).toBeUndefined(); // 账单未落
  });

  it('授权幂等重放：同 requestId 同指纹 → replayed（不双冻结）', async () => {
    const user = await newUser();
    await fund(user, '10');
    const requestId = randomUUID();
    createdRequests.push(requestId);
    const first = await billing.authorize(ctx, { requestId, userId: user, stream: false, quote: q, reservationLimit: '10', authorizationTtlMs: 300_000 });
    const replay = await billing.authorize(ctx, { requestId, userId: user, stream: false, quote: q, reservationLimit: '10', authorizationTtlMs: 300_000 });
    expect(replay.replayed).toBe(true);
    expect(replay.reservedAmount).toBe(first.reservedAmount);
    const { createWallet } = await import('../wallet/wallet.js');
    const wallet = createWallet({
      db,
      currency: 'CNY',
      guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
    });
    expect((await wallet.accounts(ctx, user))[0]!.inFlight).toBe('2'); // 只冻一次
  });

  it('免费快路径：0 元授权不冻结钱包', async () => {
    const user = await newUser();
    const requestId = randomUUID();
    createdRequests.push(requestId);
    const free: BillingQuote = { ...q, explicitlyFree: true, candidates: [{ ...q.candidates[0]!, inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' }] };
    const authorized = await billing.authorize(ctx, { requestId, userId: user, stream: false, quote: free, reservationLimit: '10', authorizationTtlMs: 300_000 });
    expect(authorized.reservedAmount).toBe('0');
    expect(authorized.availableBalance).toBe('0');
  });

  it('收据验收失败：价格快照不匹配 → 拒收（防中途改价）', async () => {
    const user = await newUser();
    await fund(user, '10');
    const requestId = randomUUID();
    createdRequests.push(requestId);
    await billing.authorize(ctx, { requestId, userId: user, stream: false, quote: q, reservationLimit: '10', authorizationTtlMs: 300_000 });
    const tampered = receipt(user, requestId, 100_000);
    tampered.inputPrice = '999'; // 中途改价攻击
    await expect(
      billing.signal(ctx, { type: 'request.succeeded', requestId, receipt: tampered }),
    ).rejects.toThrow();
  });
});

describe('渠道敞口预留', () => {
  it('预留→换渠道原子替换（旧敞口释放）；预算不足拒绝', async () => {
    const { providers, channels } = await import('@ai-gateway/db');
    const [provider] = await db
      .insert(providers)
      .values({ name: `v2b-${randomUUID().slice(0, 8)}`, baseUrl: 'https://v2b.test', status: 0 })
      .returning({ id: providers.id });
    const mk = async (budget: string): Promise<number> => {
      const [row] = await db
        .insert(channels)
        .values({ providerId: provider!.id, name: `v2b-${randomUUID().slice(0, 8)}`, apiKeyEnc: 'k', status: 0, upstreamBudget: budget })
        .returning({ id: channels.id });
      return row!.id;
    };
    const ch1 = await mk('10');
    const ch2 = await mk('0.5'); // 不够 2 元敞口

    const user = await newUser();
    await fund(user, '10');
    const requestId = randomUUID();
    createdRequests.push(requestId);
    await billing.authorize(ctx, { requestId, userId: user, stream: false, quote: q, reservationLimit: '10', authorizationTtlMs: 300_000 });

    const first = await billing.reserveChannel(ctx, { requestId, channelId: ch1, amount: '2' });
    expect(first.allowed).toBe(true);
    // 换渠道：ch2 预算不足 → 拒绝（ch1 敞口保持）
    const rejected = await billing.reserveChannel(ctx, { requestId, channelId: ch2, amount: '2' });
    expect(rejected.allowed).toBe(false);
    const [ch1Row] = await db.select({ reserved: channels.upstreamReserved }).from(channels).where(eq(channels.id, ch1));
    expect(new Decimal(ch1Row!.reserved).eq('2')).toBe(true);

    // 失败释放：敞口三路归零
    await billing.signal(ctx, { type: 'request.failed', requestId, reason: 'no_available_channel' });
    const [after] = await db.select({ reserved: channels.upstreamReserved }).from(channels).where(eq(channels.id, ch1));
    expect(new Decimal(after!.reserved).eq('0')).toBe(true);

    await db.update(billingRequests).set({ channelId: null }).where(eq(billingRequests.requestId, requestId));
    await db.delete(billingReservations).where(eq(billingReservations.billingRequestId, requestId));
    await db.delete(usageLogs).where(eq(usageLogs.requestId, requestId));
    await db.delete(billingRequests).where(eq(billingRequests.requestId, requestId));
    createdRequests.pop();
    await db.delete(channels).where(inArray(channels.id, [ch1, ch2]));
    await db.delete(providers).where(eq(providers.id, provider!.id));
  });
});

describe('资金来源瀑布（订阅切分）', () => {
  it('套餐 Key（开关 OFF）足额：全额走订阅额度，钱包不动；失败释放额度归零', async () => {
    const user = await newUser();
    await fund(user, '10');
    const subId = await newSubscription(user, '5');
    const keyId = await newSubscriptionKey(user, subId, false);
    const requestId = randomUUID();
    createdRequests.push(requestId);

    const authorized = await billing.authorize(ctx, {
      requestId, userId: user, apiKeyId: keyId, stream: false, quote: q,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    expect(authorized.reservedAmount).toBe('2');
    // 全额在订阅额度——钱包可用口径未动
    expect(authorized.availableBalance).toBe('10');
    expect(new Decimal(await quotaReservedOf(subId)).eq('2')).toBe(true);
    const rows = await db
      .select({ sourceType: billingReservations.sourceType, amount: billingReservations.amount })
      .from(billingReservations)
      .where(eq(billingReservations.billingRequestId, requestId));
    expect(rows.map((r) => ({ ...r, amount: normalizeAmount(r.amount) }))).toEqual([{ sourceType: 'subscription', amount: '2' }]);

    const failed = await billing.signal(ctx, { type: 'request.failed', requestId, reason: 'test' });
    expect(failed.status).toBe('released');
    expect(failed.amountReleased).toBe('2');
    expect(new Decimal(await quotaReservedOf(subId)).eq('0')).toBe(true);
    const after = await db
      .select({ status: billingReservations.status })
      .from(billingReservations)
      .where(eq(billingReservations.billingRequestId, requestId));
    expect(after).toEqual([{ status: 'released' }]);
  });

  it('开关 OFF 额度不足：整单拒绝（现状行为）——账单未落、额度未动、无明细', async () => {
    const user = await newUser();
    await fund(user, '10');
    const subId = await newSubscription(user, '1');
    const keyId = await newSubscriptionKey(user, subId, false);
    const requestId = randomUUID();
    await expect(
      billing.authorize(ctx, {
        requestId, userId: user, apiKeyId: keyId, stream: false, quote: q,
        reservationLimit: '10', authorizationTtlMs: 300_000,
      }),
    ).rejects.toThrow(SubscriptionQuotaExhaustedError);
    const [row] = await db
      .select({ id: billingRequests.requestId })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, requestId));
    expect(row).toBeUndefined();
    expect(new Decimal(await quotaReservedOf(subId)).eq('0')).toBe(true);
  });

  it('开关 ON 额度不足：订阅出余量 + PAYG 补差；失败双路归还', async () => {
    const user = await newUser();
    await fund(user, '5');
    const subId = await newSubscription(user, '1');
    const keyId = await newSubscriptionKey(user, subId, true);
    const requestId = randomUUID();
    createdRequests.push(requestId);

    const authorized = await billing.authorize(ctx, {
      requestId, userId: user, apiKeyId: keyId, stream: false, quote: q,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    expect(authorized.reservedAmount).toBe('2');
    expect(authorized.availableBalance).toBe('4'); // 5 − 1（PAYG 补差在途）
    expect(new Decimal(await quotaReservedOf(subId)).eq('1')).toBe(true);
    const [brRow] = await db
      .select({ planReserved: billingRequests.planReservedAmount })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, requestId));
    expect(new Decimal(brRow!.planReserved!).eq('1')).toBe(true);
    const rows = await db
      .select({ sourceType: billingReservations.sourceType, amount: billingReservations.amount })
      .from(billingReservations)
      .where(eq(billingReservations.billingRequestId, requestId))
      .orderBy(billingReservations.id);
    expect(rows.map((r) => ({ ...r, amount: normalizeAmount(r.amount) }))).toEqual([
      { sourceType: 'subscription', amount: '1' },
      { sourceType: 'payg', amount: '1' },
    ]);

    const failed = await billing.signal(ctx, { type: 'request.failed', requestId, reason: 'test' });
    expect(failed.status).toBe('released');
    expect(failed.amountReleased).toBe('2');
    expect(new Decimal(await quotaReservedOf(subId)).eq('0')).toBe(true);
    const { createWallet } = await import('../wallet/wallet.js');
    const wallet = createWallet({
      db,
      currency: 'CNY',
      guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
    });
    const account = (await wallet.accounts(ctx, user))[0]!;
    expect(account.balance).toBe('5');
    expect(account.inFlight).toBe('0');
  });

  it('普通 Key（用户另有活跃订阅）：仅 PAYG，不消耗额度', async () => {
    const user = await newUser();
    await fund(user, '5');
    const subId = await newSubscription(user, '100');
    const keyId = await newSubscriptionKey(user, subId, true);
    // 解绑成普通 Key（subscription_id = null）
    await db.update(apiKeys).set({ subscriptionId: null }).where(eq(apiKeys.id, keyId));
    const requestId = randomUUID();
    createdRequests.push(requestId);

    await billing.authorize(ctx, {
      requestId, userId: user, apiKeyId: keyId, stream: false, quote: q,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    const rows = await db
      .select({ sourceType: billingReservations.sourceType, amount: billingReservations.amount })
      .from(billingReservations)
      .where(eq(billingReservations.billingRequestId, requestId));
    expect(rows.map((r) => ({ ...r, amount: normalizeAmount(r.amount) }))).toEqual([{ sourceType: 'payg', amount: '2' }]);
    expect(new Decimal(await quotaReservedOf(subId)).eq('0')).toBe(true);
  });

  it('零金额（免费快路径）：不落明细行', async () => {
    const user = await newUser();
    const requestId = randomUUID();
    createdRequests.push(requestId);
    const free: BillingQuote = {
      ...q,
      explicitlyFree: true,
      candidates: [{ ...q.candidates[0]!, inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' }],
    };
    await billing.authorize(ctx, {
      requestId, userId: user, stream: false, quote: free,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    const rows = await db
      .select({ id: billingReservations.id })
      .from(billingReservations)
      .where(eq(billingReservations.billingRequestId, requestId));
    expect(rows).toEqual([]);
  });
});
