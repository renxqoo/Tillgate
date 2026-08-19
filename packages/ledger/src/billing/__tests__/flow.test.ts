/** billing 域（S5 重写）核心资金流规格：授权→事件→结算/释放，全程 wallet 为资金事实。
 *  PAYG 走 wallet 冻结单；订阅走 quota；「实际 > 预留」走 §4 补充授权结算。 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  apiKeys,
  billingRequests,
  plans,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { createWallet, InsufficientBalanceError, type Wallet } from '@ai-gateway/wallet';
import { toDecimal } from '@ai-gateway/wallet/metering';
import { createBillingDomain } from '../domain.js';
import type { BillingQuote, UsageReceipt } from '../../rating/types.js';
import type { SettlementClaim } from '../types.js';

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

const PREFIX = 'blrw';
const createdUsers: number[] = [];
const createdPlans: number[] = [];
const createdSubs: number[] = [];
const createdKeys: number[] = [];
const createdRequests: string[] = [];

beforeAll(async () => {
  await db.query.users.findFirst({ columns: { id: true } });
});
afterAll(async () => {
  // 只清自己创建的行（前缀 + 本进程清单双重条件）；usage_logs 先清（FK 指向 subs/users）
  if (createdRequests.length > 0) {
    await db.delete(billingRequests).where(inArray(billingRequests.requestId, createdRequests));
    await db.delete(usageLogs).where(inArray(usageLogs.requestId, createdRequests));
  }
  if (createdKeys.length > 0 || createdSubs.length > 0 || createdPlans.length > 0 || createdUsers.length > 0) {
    await db.delete(apiKeys).where(inArray(apiKeys.id, createdKeys));
    await db.delete(userSubscriptions).where(inArray(userSubscriptions.id, createdSubs));
    await db.delete(plans).where(inArray(plans.id, createdPlans));
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

async function fund(userId: number, amount: string): Promise<void> {
  await wallet.credit({
    userId,
    amount,
    refType: 'topup',
    refId: `${PREFIX}-fund-${userId}-${randomUUID().slice(0, 8)}`,
  });
}

function quote(amounts: { input: string; output: string }): BillingQuote {
  return {
    maxOutputTokens: 0,
    candidates: [
      {
        mappingId: 1,
        externalModel: 'gpt-x',
        realModel: 'gpt-real',
        inputPrice: amounts.input,
        outputPrice: amounts.output,
        cacheInputPrice: amounts.input,
        coefficient: '1',
        inputTokenUpperBound: 1_000_000,
        billingPolicyFingerprint: null,
      },
    ],
  };
}

function receiptFor(
  q: BillingQuote,
  userId: number,
  requestId: string,
  usage: { inputTokens: number; outputTokens: number },
): UsageReceipt {
  const cand = q.candidates[0]!;
  return {
    requestId,
    userId,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: cand.externalModel,
    realModel: cand.realModel,
    channelId: null,
    channelKey: 'test',
    usage: { inputTokens: usage.inputTokens, cachedInputTokens: 0, outputTokens: usage.outputTokens, estimated: false },
    inputPrice: cand.inputPrice,
    outputPrice: cand.outputPrice,
    cacheInputPrice: cand.cacheInputPrice,
    coefficient: cand.coefficient,
    durationMs: 100,
    stream: false,
    streamAborted: false,
    mappingId: cand.mappingId,
    billingPolicyFingerprint: null,
  };
}

const requestId = (): string => randomUUID();

/** 模拟 processor 认领（settlement_pending → processing + claim 三元组） */
async function simulateClaim(requestIdValue: string): Promise<SettlementClaim> {
  const claimToken = randomUUID();
  const ownerId = 'worker-1';
  const claimUntil = new Date(Date.now() + 60_000);
  await db
    .update(billingRequests)
    .set({
      status: 'processing',
      claimOwner: ownerId,
      claimToken,
      claimUntil,
      revision: 1,
    })
    .where(eq(billingRequests.requestId, requestIdValue));
  return {
    requestId: requestIdValue,
    ownerId,
    claimToken,
    revision: 1,
    attempt: 1,
    receipt: undefined as unknown as UsageReceipt,
    claimedAt: new Date(),
    claimUntil,
    traceParent: null,
  };
}

describe('PAYG 计费闭环（wallet 为资金事实）', () => {
  it('授权冻结 → 成功收据 → 结算实扣（actual < hold）', async () => {
    const user = await createUser();
    await fund(user, '100');
    const id = requestId();
    createdRequests.push(id);
    // 上界 1M tokens × 2 元/M = 2 元预扣
    const q = quote({ input: '2', output: '0' });
    const auth = await billing.authorize({
      requestId: id,
      userId: user,
      stream: false,
      quote: q,
      reservationLimit: '10',
      authorizationTtlMs: 300_000,
    });
    expect(auth.replayed).toBe(false);
    expect(auth.reservedAmount).toBe('2');
    const summary = (await wallet.accounts(user))[0]!;
    expect(toDecimal(summary.balance).toNumber()).toBe(100);
    expect(toDecimal(summary.inFlight).toNumber()).toBe(2);

    // 同命令重放
    const replay = await billing.authorize({
      requestId: id,
      userId: user,
      stream: false,
      quote: q,
      reservationLimit: '10',
      authorizationTtlMs: 300_000,
    });
    expect(replay.replayed).toBe(true);
    expect(toDecimal((await wallet.accounts(user))[0]!.inFlight).toNumber()).toBe(2);

    await billing.signal({ type: 'upstream.started', requestId: id, leaseOwner: 'w1', leaseMs: 60_000 });
    const receipt = receiptFor(q, user, id, { inputTokens: 300_000, outputTokens: 0 });
    const succeeded = await billing.signal({ type: 'request.succeeded', requestId: id, receipt });
    expect(succeeded.status).toBe('settlement_pending');

    const claim = await simulateClaim(id);
    const settled = await billing.settleClaim({ ...claim, receipt });
    expect(settled.outcome).toBe('settled');
    expect(settled.amount).toBe('0.6'); // 300k × 2/M
    const after = (await wallet.accounts(user))[0]!;
    expect(toDecimal(after.balance).toNumber()).toBe(99.4);
    expect(toDecimal(after.inFlight).toNumber()).toBe(0);
  });

  it('实际 > 预留：补充授权结算（同事务三步），statement 两笔结算', async () => {
    const user = await createUser();
    await fund(user, '100');
    const id = requestId();
    createdRequests.push(id);
    const q = quote({ input: '2', output: '0' }); // hold 2
    await billing.authorize({
      requestId: id, userId: user, stream: false, quote: q,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    const receipt = receiptFor(q, user, id, { inputTokens: 1_500_000, outputTokens: 0 }); // actual 3
    await billing.signal({ type: 'request.succeeded', requestId: id, receipt });
    const claim = await simulateClaim(id);
    const settled = await billing.settleClaim({ ...claim, receipt });
    expect(settled.outcome).toBe('settled');
    expect(settled.amount).toBe('3');
    const after = (await wallet.accounts(user))[0]!;
    expect(toDecimal(after.balance).toNumber()).toBe(97);
    expect(toDecimal(after.inFlight).toNumber()).toBe(0);
    // wallet statement：原单结算 + #over 结算两条腿记录
    const statement = await wallet.statement({ userId: user, kinds: ['settle'] });
    expect(statement.items.filter((item) => item.refType === 'billing').length).toBe(2);
  });

  it('失败释放：wallet 在途归还，余额不动', async () => {
    const user = await createUser();
    await fund(user, '100');
    const id = requestId();
    createdRequests.push(id);
    const q = quote({ input: '2', output: '0' });
    await billing.authorize({
      requestId: id, userId: user, stream: false, quote: q,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    const failed = await billing.signal({
      type: 'request.failed',
      requestId: id,
      reason: 'upstream_error',
      delivery: 'none',
      upstreamCharge: 'none',
    });
    expect(failed.status).toBe('released');
    expect(toDecimal(failed.amountReleased ?? '0').toNumber()).toBe(2);
    const after = (await wallet.accounts(user))[0]!;
    expect(toDecimal(after.balance).toNumber()).toBe(100);
    expect(toDecimal(after.inFlight).toNumber()).toBe(0);
  });

  it('余额不足（含授信口径）拒绝且零残留', async () => {
    const user = await createUser();
    await fund(user, '1');
    const id = requestId();
    createdRequests.push(id);
    const rejection = await billing
      .authorize({
        requestId: id, userId: user, stream: false, quote: quote({ input: '2', output: '0' }),
        reservationLimit: '10', authorizationTtlMs: 300_000,
      })
      .catch((error) => error);
    expect(rejection).toBeInstanceOf(InsufficientBalanceError);
    // 零残留：授权拒绝不产生在途，余额原样
    const summary = (await wallet.accounts(user))[0]!;
    expect(toDecimal(summary.inFlight).toNumber()).toBe(0);
    expect(toDecimal(summary.balance).toNumber()).toBe(1);
  });
});

describe('订阅计费路径（quota 预留/核销）', () => {
  it('订阅 Key 授权占套餐额度，不占 wallet；结算核销额度', async () => {
    const user = await createUser();
    const planId = (async () => {
      const [plan] = await db
        .insert(plans)
        .values({ name: `${PREFIX}-${randomUUID().slice(0, 8)}`, price: '30', periodDays: 30, quotaAmount: '10' })
        .returning({ id: plans.id });
      createdPlans.push(plan!.id);
      return plan!.id;
    })();
    const [sub] = await db
      .insert(userSubscriptions)
      .values({
        userId: user,
        planId: await planId,
        startAt: new Date(),
        endAt: new Date(Date.now() + 30 * 86_400_000),
        quotaAmount: '10',
        price: '30',
      })
      .returning({ id: userSubscriptions.id });
    createdSubs.push(sub!.id);
    const [key] = await db
      .insert(apiKeys)
      .values({
        userId: user,
        keyHash: randomUUID(),
        keyPreview: `${PREFIX}-key`,
        name: `${PREFIX}-key`,
        subscriptionId: sub!.id,
      })
      .returning({ id: apiKeys.id });
    createdKeys.push(key!.id);

    const id = requestId();
    createdRequests.push(id);
    const q = quote({ input: '2', output: '0' }); // 2 元额度
    const auth = await billing.authorize({
      requestId: id,
      userId: user,
      apiKeyId: key!.id,
      stream: false,
      quote: q,
      reservationLimit: '10',
      authorizationTtlMs: 300_000,
    });
    expect(auth.reservedAmount).toBe('2');
    // wallet 零动作（订阅额度不是钱）
    expect((await wallet.accounts(user))[0]).toBeUndefined();
    const [subRow] = await db
      .select({ reserved: userSubscriptions.reservedAmount })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, sub!.id));
    expect(toDecimal(subRow!.reserved).toNumber()).toBe(2);

    const receipt = receiptFor(q, user, id, { inputTokens: 300_000, outputTokens: 0 });
    await billing.signal({ type: 'request.succeeded', requestId: id, receipt });
    const claim = await simulateClaim(id);
    const settled = await billing.settleClaim({ ...claim, receipt });
    expect(settled.amount).toBe('0.6');
    const [after] = await db
      .select({ used: userSubscriptions.usedAmount, reserved: userSubscriptions.reservedAmount })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, sub!.id));
    expect(toDecimal(after!.used).toNumber()).toBe(0.6);
    expect(toDecimal(after!.reserved).toNumber()).toBe(0);
  });

  it('免费模型 fast-path：0 元授权不产生任何预占', async () => {
    const user = await createUser();
    const id = requestId();
    createdRequests.push(id);
    const free = {
      maxOutputTokens: 0,
      explicitlyFree: true as const,
      candidates: [
        {
          mappingId: 1, externalModel: 'f', realModel: 'f',
          inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
          coefficient: '1', inputTokenUpperBound: 100, billingPolicyFingerprint: null,
        },
      ],
    };
    const auth = await billing.authorize({
      requestId: id, userId: user, stream: false, quote: free,
      reservationLimit: '10', authorizationTtlMs: 300_000,
    });
    expect(auth.reservedAmount).toBe('0');
    expect((await wallet.accounts(user))[0]).toBeUndefined();
  });
});
