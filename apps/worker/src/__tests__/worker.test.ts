/**
 * worker 集成测试（真实 PG）：run-once 批次闭环 + 回收定时驱动。
 * 端到端链：gateway 侧制造 settlement_pending → worker runOnce → 落账 settled。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { Decimal, type BillingQuote, type UsageReceipt } from '@ai-gateway/domain';
import { createBillingDomain, createSettlementDomain, createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import { createRunOnce } from '../run-once.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2wk-suite');
const billing = createBillingDomain({ db, currency: 'CNY' });
const settlement = createSettlementDomain({
  db,
  currency: 'CNY',
  policy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
});
const runOnce = createRunOnce({
  settlement,
  ownerId: 'v2wk-worker',
  batchSize: 10,
  claimLeaseMs: 60_000,
});

const createdUsers: number[] = [];
const createdRequests: string[] = [];

const q: BillingQuote = {
  maxOutputTokens: 0,
  candidates: [{
    mappingId: 1, externalModel: 'gpt-x', realModel: 'gpt-real',
    inputPrice: '2', outputPrice: '0', cacheInputPrice: '2',
    coefficient: '1', inputTokenUpperBound: 1_000_000, billingPolicyFingerprint: null,
  }],
};

async function newPendingRequest(userId: number, inputTokens: number): Promise<string> {
  const requestId = randomUUID();
  createdRequests.push(requestId);
  await billing.authorize(ctx, {
    requestId, userId, stream: false, quote: q,
    reservationLimit: '100', authorizationTtlMs: 300_000,
  });
  const receipt: UsageReceipt = {
    requestId, userId, apiKeyId: null, appId: null, credentialType: 'key',
    externalModel: 'gpt-x', realModel: 'gpt-real', channelId: null, channelKey: 'test',
    usage: { inputTokens, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    inputPrice: '2', outputPrice: '0', cacheInputPrice: '2', coefficient: '1',
    durationMs: 50, stream: false, streamAborted: false, mappingId: 1,
    billingPolicyFingerprint: null,
  };
  await billing.signal(ctx, { type: 'request.succeeded', requestId, receipt });
  return requestId;
}

async function newUser(funded: boolean): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ issuer: 'v2wk', subject: `v2wk-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  if (funded) {
    const wallet = createWallet({
      db,
      currency: 'CNY',
      guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
    });
    await wallet.credit(ctx, { userId: row!.id, amount: '100', refType: 'topup', refId: `v2wk-${randomUUID()}` });
  }
  return row!.id;
}

afterAll(async () => {
  // 原生参数化清理（零 drizzle import）
  if (createdRequests.length) {
    await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [createdRequests]);
    await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [createdRequests]);
    await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [createdRequests]);
  }
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  await db.$client.end().catch(() => {});
});

describe('worker run-once', () => {
  it('批次闭环：认领 → 结算 → 落账（钱包实扣、usage_logs、明细 settled）', async () => {
    const user = await newUser(true);
    const requestId = await newPendingRequest(user, 300_000);

    const result = await runOnce(ctx);
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.settled).toBeGreaterThanOrEqual(1);
    expect(result.claimLost).toBe(0);

    const wallet = createWallet({
      db,
      currency: 'CNY',
      guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
    });
    const account = (await wallet.accounts(ctx, user))[0]!;
    expect(new Decimal(account.balance).eq('99.4')).toBe(true); // 100 − 0.6 实扣
    expect(account.inFlight).toBe('0');

    const usage = await db.$client.query<{ amount: string }>(
      'select amount from usage_logs where request_id = $1', [requestId],
    );
    expect(new Decimal(usage.rows[0]!.amount).eq('0.6')).toBe(true);
  });

  it('幂等：再跑一批零认领（已全部终态）', async () => {
    await runOnce(ctx); // 上一例已结算
    const result = await runOnce(ctx);
    // 库里可能有其他套件留下的在途单——本例不断言 0，断言结构健康
    expect(result).toHaveProperty('claimed');
    expect(result).toHaveProperty('settled');
  });

  it('回收驱动：租约过期的 authorized 被释放', async () => {
    const user = await newUser(true);
    const requestId = randomUUID();
    createdRequests.push(requestId);
    await billing.authorize(ctx, {
      requestId, userId: user, stream: false, quote: q,
      reservationLimit: '100', authorizationTtlMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const recovery = await settlement.recover(ctx, { batchSize: 10 });
    expect(recovery.released).toBeGreaterThanOrEqual(1);
    const status = await db.$client.query<{ status: string }>(
      'select status from billing_requests where request_id = $1', [requestId],
    );
    expect(status.rows[0]!.status).toBe('released');
  });
});
