import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  apiKeys,
  billingRequests,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createBilling } from '../billing/index.js';
import type { BillingQuote } from '../billing/types.js';

/**
 * 【红测 · R1】request.failed 释放路径不递减 users.reserved_balance（PAYG 预占永久泄漏）
 *
 * 根因：commit 48a8718 删除了「预占余额」与「释放余额」两段（当时自洽）；
 * commit c646f20 恢复了 authorize 的余额预占（billing-flow.ts:619-638），
 * 但 request.failed 释放事务（billing-flow.ts:894-954）没有恢复对应递减——
 * 只释放套餐敞口与渠道敞口，users.reserved_balance 永久虚高。
 *
 * 影响：PAYG（未绑定订阅的 Key）用户的每一次失败请求（上游 rate_limited、
 * invalid_request 4xx 透传、circuit_open、channel_budget_exhausted 等
 * upstreamCharge=none 的失败）都永久冻结一笔预估金额。可用额度
 * = balance + credit_limit − reserved_balance 持续缩小直至用户被锁死；
 * 套餐购买闸门（balance − reserved ≥ price）同样被卡死。
 *
 * 预期（本测试断言的正确行为）：
 *   1. authorize 后 reserved_balance == 预估；
 *   2. signal(request.failed, upstreamCharge=none) 后 reserved_balance == 0；
 *   3. 连续 5 次失败请求后（未消费任何 token），第 6 次 authorize 应正常放行。
 * 当前实现：断言 2/3 失败（红灯即复现）。
 */
const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let connected = false;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

async function createPaygUser(initialBalance: string): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `redpayg-${randomUUID()}`,
      identityProvider: 'local',
      displayName: 'RED PAYG Leak Test',
      balance: initialBalance,
    })
    .returning({ id: users.id });
  return user!.id;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

async function reservedOf(userId: number): Promise<Decimal> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { reservedBalance: true },
  });
  return new Decimal(user?.reservedBalance ?? 0);
}

/** 与 billing-flow.test.ts 同构的报价：预估 = (1000×1000 + 500×2000)/1e6 × 1 = ¥2 */
function quote(): BillingQuote {
  return {
    maxOutputTokens: 500,
    candidates: [
      {
        mappingId: 1,
        externalModel: 'test-model',
        realModel: 'test-real',
        inputPrice: '1000',
        outputPrice: '2000',
        cacheInputPrice: '100',
        coefficient: '1',
        inputTokenUpperBound: 1_000,
        billingPolicyFingerprint: null,
      },
    ],
  };
}

describe('RED R1: request.failed 必须释放 PAYG 余额预占（users.reserved_balance）', () => {
  it('失败请求（upstreamCharge=none）后 reserved_balance 应回到 0', async (context) => {
    if (!connected) return context.skip();
    const userId = await createPaygUser('10');
    const billing = createBilling({ db });
    try {
      const requestId = randomUUID();
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      // 预占发生：¥2
      expect((await reservedOf(userId)).toString()).toBe('2');

      await billing.signal({
        type: 'request.failed',
        requestId,
        reason: 'rate_limited',
        delivery: 'none',
        upstreamCharge: 'none',
      });

      const br = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
        columns: { status: true },
      });
      expect(br?.status).toBe('released');
      // 【红】当前实现 reserved_balance 仍为 2（泄漏）；正确行为应为 0
      expect((await reservedOf(userId)).toString()).toBe('0');
    } finally {
      await cleanup(userId);
    }
  });

  it('连续失败请求不得锁死用户：5 次失败后第 6 次授权应放行', async (context) => {
    if (!connected) return context.skip();
    const userId = await createPaygUser('10');
    const billing = createBilling({ db });
    try {
      for (let i = 0; i < 5; i++) {
        const requestId = randomUUID();
        await billing.authorize({
          requestId,
          userId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        });
        await billing.signal({
          type: 'request.failed',
          requestId,
          reason: 'invalid_request',
          delivery: 'none',
          upstreamCharge: 'none',
        });
      }
      // 【红】当前实现 reserved_balance=10 > 余额 10 → 可用 0，第 6 次被拒
      expect((await reservedOf(userId)).toString()).toBe('0');

      const sixth = randomUUID();
      const result = await billing.authorize({
        requestId: sixth,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      expect(result.replayed).toBe(false);
      await billing.signal({
        type: 'request.failed',
        requestId: sixth,
        reason: 'rate_limited',
        delivery: 'none',
        upstreamCharge: 'none',
      });
    } finally {
      await cleanup(userId);
    }
  });

  it('残留泄漏不得发生：异常路径上 InsufficientBalanceError 不应被误抛（回归哨兵）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createPaygUser('2.000000000000000000');
    const billing = createBilling({ db });
    try {
      const requestId = randomUUID();
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'request.failed',
        requestId,
        reason: 'channel_budget_exhausted',
        delivery: 'none',
        upstreamCharge: 'none',
      });
      // 失败释放后，同一用户再次授权等额请求必须成功（可用额度已恢复）
      const again = randomUUID();
      await expect(
        billing.authorize({
          requestId: again,
          userId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).resolves.toBeTruthy();
      await billing.signal({
        type: 'request.failed',
        requestId: again,
        reason: 'rate_limited',
        delivery: 'none',
        upstreamCharge: 'none',
      });
    } finally {
      await cleanup(userId);
    }
  });
});
