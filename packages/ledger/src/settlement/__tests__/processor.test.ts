/** settlement 编排规格（S6）：processor 认领 → billing（钱包之上）结算闭环 +
 *  恢复作业（授权过期/网关崩溃释放 = wallet 在途归还）。 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { billingRequests, usageLogs, users } from '@ai-gateway/db/schema';
import { createWallet, type Wallet } from '@ai-gateway/wallet';
import { toDecimal } from '@ai-gateway/wallet/metering';
import { createBillingDomain } from '../../billing/domain.js';
import { createSettlementProcessor } from '../index.js';
import type { BillingQuote, UsageReceipt } from '../../rating/types.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const wallet: Wallet = createWallet(db, {
  accounts: [],
  refTypes: ['topup', 'billing'],
  currencies: ['CNY'],
});
const billing = createBillingDomain({ db, wallet });
const processor = createSettlementProcessor({
  db,
  wallet,
  options: {
    ownerId: 'test-worker',
    batchSize: 10,
    concurrency: 10,
    claimLeaseMs: 60_000,
    retryBaseMs: 10,
    retryMaxMs: 50,
    maxAttempts: 2,
  },
});

const PREFIX = 'strw';
const createdUsers: number[] = [];
const createdRequests: string[] = [];

beforeAll(async () => {
  await db.query.users.findFirst({ columns: { id: true } });
});
afterAll(async () => {
  if (createdRequests.length > 0) {
    await db.delete(billingRequests).where(inArray(billingRequests.requestId, createdRequests));
    await db.delete(usageLogs).where(inArray(usageLogs.requestId, createdRequests));
  }
  if (createdUsers.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUsers));
  }
  await db.$client.end().catch(() => {});
});

async function createUser(): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({ issuer: PREFIX, subject: `${PREFIX}-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  return user!.id;
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

function receipt(userId: number, id: string, inputTokens: number): UsageReceipt {
  return {
    requestId: id, userId, apiKeyId: null, appId: null, credentialType: 'key',
    externalModel: 'gpt-x', realModel: 'gpt-real', channelId: null, channelKey: 'test',
    usage: { inputTokens, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    inputPrice: '2', outputPrice: '0', cacheInputPrice: '2', coefficient: '1',
    durationMs: 50, stream: false, streamAborted: false, mappingId: 1,
    billingPolicyFingerprint: null,
  };
}

describe('runOnce：认领→结算闭环', () => {
  it('settlement_pending 批量认领并结算（settled 计数 + wallet 实扣）', async () => {
    const user = await createUser();
    await wallet.credit({
      userId: user, amount: '100',
      refType: 'topup', refId: `${PREFIX}-fund-${user}`,
    });
    const ids = [randomUUID(), randomUUID()];
    createdRequests.push(...ids);
    for (const id of ids) {
      await billing.authorize({
        requestId: id, userId: user, stream: false, quote: q,
        reservationLimit: '10', authorizationTtlMs: 300_000,
      });
      await billing.signal({ type: 'request.succeeded', requestId: id, receipt: receipt(user, id, 100_000) });
    }
    const result = await processor.runOnce(ids);
    expect(result.claimed).toBe(2);
    expect(result.settled).toBe(2);
    // 2 × (100k × 2/M) = 0.4
    expect(toDecimal((await wallet.accounts(user))[0]!.balance).toNumber()).toBeCloseTo(99.6, 8);
    expect(toDecimal((await wallet.accounts(user))[0]!.inFlight).toNumber()).toBe(0);
  });

  it('毒收据 → dead（不扣款，wallet 在途保持）', async () => {
    const user = await createUser();
    await wallet.credit({
      userId: user, amount: '100',
      refType: 'topup', refId: `${PREFIX}-fund-${user}`,
    });
    const id = randomUUID();
    createdRequests.push(id);
    await billing.authorize({
      requestId: id, userId: user, stream: false, quote: q,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    const poisoned = receipt(user, id, 100_000);
    // 破坏收据使其成为毒载荷（usage 非法数值）
    (poisoned as { usage: Record<string, unknown> }).usage = { garbage: true };
    await db
      .update(billingRequests)
      .set({
        status: 'settlement_pending',
        receipt: poisoned as unknown as Record<string, unknown>,
        receiptFingerprint: 'x',
        nextSettlementAt: new Date(),
      })
      .where(eq(billingRequests.requestId, id));
    const result = await processor.runOnce([id]);
    expect(result.dead).toBe(1);
    const [row] = await db
      .select({ status: billingRequests.status })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, id));
    expect(row?.status).toBe('dead');
  });
});

describe('recoverOnce：滞留恢复', () => {
  it('授权过期未发上游 → released + wallet 在途归还', async () => {
    const user = await createUser();
    await wallet.credit({
      userId: user, amount: '100',
      refType: 'topup', refId: `${PREFIX}-fund-${user}`,
    });
    const id = randomUUID();
    createdRequests.push(id);
    await billing.authorize({
      requestId: id, userId: user, stream: false, quote: q,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    expect(toDecimal((await wallet.accounts(user))[0]!.inFlight).toNumber()).toBe(2);
    // 租约拨到过去，触发「authorized 过期」恢复
    await db
      .update(billingRequests)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(billingRequests.requestId, id));
    const result = await processor.recoverOnce();
    expect(result.released).toBeGreaterThanOrEqual(1);
    const [row] = await db
      .select({ status: billingRequests.status, failureCode: billingRequests.failureCode })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, id));
    expect(row?.status).toBe('released');
    expect(row?.failureCode).toBe('authorization_expired_before_dispatch');
    expect(toDecimal((await wallet.accounts(user))[0]!.inFlight).toNumber()).toBe(0);
    expect(toDecimal((await wallet.accounts(user))[0]!.balance).toNumber()).toBe(100);
  });

  it('②in_flight 租约过期（网关崩溃）→ released 释放不扣，余额不动', async () => {
    const user = await createUser();
    await wallet.credit({
      userId: user, amount: '100',
      refType: 'topup', refId: `${PREFIX}-fund-${user}`,
    });
    const id = randomUUID();
    createdRequests.push(id);
    await billing.authorize({
      requestId: id, userId: user, stream: false, quote: q,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    await billing.signal({
      type: 'upstream.started', requestId: id,
      leaseOwner: 'crashed-gateway', leaseMs: 300_000,
    });
    expect(toDecimal((await wallet.accounts(user))[0]!.inFlight).toNumber()).toBe(2);
    await db
      .update(billingRequests)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(billingRequests.requestId, id));
    const result = await processor.recoverOnce();
    expect(result.released).toBeGreaterThanOrEqual(1);
    const [row] = await db
      .select({ status: billingRequests.status, failureCode: billingRequests.failureCode })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, id));
    expect(row?.status).toBe('released');
    expect(row?.failureCode).toBe('gateway_crash_released');
    // 释放不扣：在途归还，余额与授权前入金一致
    expect(toDecimal((await wallet.accounts(user))[0]!.inFlight).toNumber()).toBe(0);
    expect(toDecimal((await wallet.accounts(user))[0]!.balance).toNumber()).toBe(100);
  });

  it('③processing 认领租约过期（worker 崩溃）→ retry_wait 立即可重领，claim 三元组清空', async () => {
    const user = await createUser();
    await wallet.credit({
      userId: user, amount: '100',
      refType: 'topup', refId: `${PREFIX}-fund-${user}`,
    });
    const id = randomUUID();
    createdRequests.push(id);
    await billing.authorize({
      requestId: id, userId: user, stream: false, quote: q,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    await billing.signal({ type: 'request.succeeded', requestId: id, receipt: receipt(user, id, 100_000) });
    // 直接伪造 worker 崩溃现场：processing + 已过期的认领租约
    await db
      .update(billingRequests)
      .set({
        status: 'processing',
        claimOwner: 'crashed-worker',
        claimToken: randomUUID(),
        claimUntil: new Date(Date.now() - 1_000),
        revision: 5,
      })
      .where(eq(billingRequests.requestId, id));
    const result = await processor.recoverOnce();
    expect(result.claimsRequeued).toBeGreaterThanOrEqual(1);
    const [row] = await db
      .select({
        status: billingRequests.status,
        claimOwner: billingRequests.claimOwner,
        claimToken: billingRequests.claimToken,
        failureClass: billingRequests.failureClass,
        nextSettlementAt: billingRequests.nextSettlementAt,
      })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, id));
    expect(row?.status).toBe('retry_wait');
    expect(row?.claimOwner).toBeNull();
    expect(row?.claimToken).toBeNull();
    expect(row?.failureClass).toBe('claim_expired');
    expect(row?.nextSettlementAt).not.toBeNull();
    // 回队后立即可被重新认领并结算（不丢钱：wallet 实扣 0.2，在途归零）
    const rerun = await processor.runOnce([id]);
    expect(rerun.settled).toBe(1);
    expect(toDecimal((await wallet.accounts(user))[0]!.inFlight).toNumber()).toBe(0);
    expect(toDecimal((await wallet.accounts(user))[0]!.balance).toNumber()).toBeCloseTo(99.8, 8);
  });
});
