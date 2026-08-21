/**
 * 结算失败路径与渠道收尾（真实 PG）：瞬态退避 → retry_wait 可重领、次数耗尽 → dead、
 * 认领失效 → claim_lost 幂等、结算的渠道三步（敞口归零 + 进货额度扣减 + CAS 收尾）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb } from '@ai-gateway/db';
import {
  billingRequests, billingReservations, channels, providers,
  usageLogs, users,
} from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { Decimal, type BillingQuote, type UsageReceipt } from '@ai-gateway/domain';
import { createBillingDomain } from '../billing/index.js';
import { systemContext, type RunContext } from '../context.js';
import { createSettlementDomain, type SettlementClaim } from '../settlement/index.js';
import { createWallet } from '../wallet/wallet.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2sf-suite');
const billing = createBillingDomain({ db, currency: 'CNY' });
const settlement = createSettlementDomain({
  db,
  currency: 'CNY',
  policy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
});

const createdUsers: number[] = [];
const createdRequests: string[] = [];
const createdChannels: number[] = [];
const createdProviders: number[] = [];

const q: BillingQuote = {
  maxOutputTokens: 0,
  candidates: [{
    mappingId: 1, externalModel: 'gpt-x', realModel: 'gpt-real',
    inputPrice: '2', outputPrice: '0', cacheInputPrice: '2',
    coefficient: '1', inputTokenUpperBound: 1_000_000, billingPolicyFingerprint: null,
  }],
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
    .values({ issuer: 'v2sf', subject: `v2sf-${randomUUID()}`, identityProvider: 'local' })
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
  await wallet.credit(ctx, { userId, amount, refType: 'topup', refId: `v2sf-fund-${userId}-${randomUUID().slice(0, 6)}` });
}

/** 授权 + 成功信号 + 认领（仅到 processing，不结算） */
async function authorizeAndClaim(userId: number, inputTokens: number): Promise<SettlementClaim> {
  const requestId = randomUUID();
  createdRequests.push(requestId);
  await billing.authorize(ctx, {
    requestId, userId, stream: false, quote: q,
    reservationLimit: '100', authorizationTtlMs: 300_000,
  });
  await billing.signal(ctx, { type: 'request.succeeded', requestId, receipt: receipt(userId, requestId, inputTokens) });
  const claims = await settlement.claim(ctx, {
    ownerId: 'v2sf-worker', batchSize: 5, claimLeaseMs: 60_000, requestIds: [requestId],
  });
  const claim = claims[0];
  if (!claim) throw new Error('claim 未领到');
  return claim;
}

const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function statusOf(requestId: string): Promise<string> {
  const [row] = await db
    .select({ status: billingRequests.status })
    .from(billingRequests)
    .where(eq(billingRequests.requestId, requestId));
  return row!.status;
}

afterAll(async () => {
  if (createdRequests.length) {
    const requestIds = createdRequests.map((id) => id as never);
    await db.delete(billingReservations).where(inArray(billingReservations.billingRequestId, requestIds));
    await db.delete(usageLogs).where(inArray(usageLogs.requestId, requestIds));
    await db.delete(billingRequests).where(inArray(billingRequests.requestId, requestIds));
  }
  if (createdChannels.length) await db.delete(channels).where(inArray(channels.id, createdChannels));
  if (createdProviders.length) await db.delete(providers).where(inArray(providers.id, createdProviders));
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await db.$client.end().catch(() => {});
});

describe('失败处置：退避与死信', () => {
  it('瞬态错误 → retry_wait（退避后可重领并正常结算）', async () => {
    const user = await newUser();
    await fund(user, '10');
    const claim = await authorizeAndClaim(user, 300_000);

    expect(await settlement.finishFailure(ctx, claim, new Error('ECONNRESET'))).toBe('retried');
    expect(await statusOf(claim.requestId)).toBe('retry_wait');

    // 退避到期后重领 → 正常结算（失败不污染资金）
    // 退避到期重领（轮询消除计时脆弱）→ 正常结算（失败不污染资金）。
    // 开发库可能有活的 worker（1s 一轮）抢先领走并结算——那是合法终态，
    // 回归点是「退避后可被重领且正常结算」，不是「只有本测试能领」。
    let reclaimed: Awaited<ReturnType<typeof settlement.claim>>[number] | undefined;
    for (let round = 0; round < 5 && reclaimed == null; round++) {
      await nap(150);
      reclaimed = (await settlement.claim(ctx, {
        ownerId: 'v2sf-worker-2', batchSize: 5, claimLeaseMs: 60_000, requestIds: [claim.requestId],
      }))[0];
    }
    if (reclaimed != null) {
      expect(await settlement.processClaim(ctx, reclaimed)).toBe('settled');
    }
    // 外部 worker 领走时（60s 租约内结算），本测试轮询等终态收敛
    for (let round = 0; round < 10 && (await statusOf(claim.requestId)) !== 'settled'; round++) {
      await nap(150);
    }
    expect(await statusOf(claim.requestId)).toBe('settled');
  });

  it('次数耗尽 → dead（人工复核出口）', async () => {
    const user = await newUser();
    await fund(user, '10');
    const firstClaim = await authorizeAndClaim(user, 300_000);
    let lastOutcome = '';
    // authorizeAndClaim 已产生第 1 次认领（attempt=1）——先失败它，再退避重领
    const requestId = createdRequests.at(-1)!;
    lastOutcome = await settlement.finishFailure(ctx, firstClaim, new Error('ECONNRESET'));
    for (let round = 2; round <= 3; round++) {
      let claim: Awaited<ReturnType<typeof settlement.claim>>[number] | undefined;
      for (let poll = 0; poll < 5 && claim == null; poll++) {
        await nap(150); // 退避（50/100ms）到期才可重领
        claim = (await settlement.claim(ctx, {
          ownerId: `v2sf-w${round}`, batchSize: 5, claimLeaseMs: 60_000, requestIds: [requestId],
        }))[0];
      }
      if (!claim) break;
      lastOutcome = await settlement.finishFailure(ctx, claim, new Error('ECONNRESET'));
    }
    expect(lastOutcome).toBe('dead');
    expect(await statusOf(requestId)).toBe('dead');
  });

  it('认领失效（token 不匹配）→ claim_lost，不计数不抛错', async () => {
    const user = await newUser();
    await fund(user, '10');
    const claim = await authorizeAndClaim(user, 300_000);
    const stale = { ...claim, claimToken: randomUUID() };
    const result = await settlement.settleClaim(ctx, stale);
    expect(result.outcome).toBe('claim_lost');
  });
});

describe('结算的渠道收尾', () => {
  it('敞口归零 + 进货额度按上游成本扣减', async () => {
    const [provider] = await db
      .insert(providers)
      .values({ name: `v2sf-${randomUUID().slice(0, 8)}`, baseUrl: 'https://v2sf.test', status: 0 })
      .returning({ id: providers.id });
    createdProviders.push(provider!.id);
    const [channel] = await db
      .insert(channels)
      .values({
        providerId: provider!.id, name: `v2sf-${randomUUID().slice(0, 8)}`,
        apiKeyEnc: 'k', status: 0, upstreamBudget: '10',
      })
      .returning({ id: channels.id });
    createdChannels.push(channel!.id);

    const user = await newUser();
    await fund(user, '10');
    const requestId = randomUUID();
    createdRequests.push(requestId);
    await billing.authorize(ctx, {
      requestId, userId: user, stream: false, quote: q,
      reservationLimit: '100', authorizationTtlMs: 300_000,
    });
    expect((await billing.reserveChannel(ctx, { requestId, channelId: channel!.id, amount: '2' })).allowed).toBe(true);
    await billing.signal(ctx, { type: 'request.succeeded', requestId, receipt: receipt(user, requestId, 300_000) });
    const claims = await settlement.claim(ctx, {
      ownerId: 'v2sf-worker', batchSize: 5, claimLeaseMs: 60_000, requestIds: [requestId],
    });
    const claim = claims[0]!;

    expect(await settlement.processClaim(ctx, claim)).toBe('settled');
    const [after] = await db
      .select({ reserved: channels.upstreamReserved, budget: channels.upstreamBudget })
      .from(channels)
      .where(eq(channels.id, channel!.id));
    expect(new Decimal(after!.reserved).isZero()).toBe(true); // 敞口归零
    expect(new Decimal(after!.budget).eq('9.4')).toBe(true); // 10 − 0.6 官方价成本
    expect(await statusOf(requestId)).toBe('settled');
  });
});
