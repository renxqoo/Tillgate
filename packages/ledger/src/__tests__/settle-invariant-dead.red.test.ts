import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { billingRequests, transactions, usageLogs, users } from '@ai-gateway/db/schema';
import { createBilling } from '../billing/index.js';
import { createBillingProcessor } from '../billing/processor/index.js';
import type { BillingQuote, UsageReceipt } from '../billing/types.js';

/**
 * 【红测 · invariant 分类语义】结算路径的不变量破坏（资金投影与账单脱节，
 * 如 reserved_balance < 应释放的预扣）是确定性失败——重试不可能自愈。
 * 当前这类错误以裸 Error 抛出，classifyFailure 归为 'unknown' → retry_wait
 * 空转重试到 maxAttempts 才转 dead，人工复核被动延迟。
 *
 * 预期（正确行为）：类型化的不变量错误 → failure_class = 'invariant_violation'
 * → 首次失败即 dead（红灯直达人工），不产生无意义的重试 churn。
 *
 * 复现：PAYG 账单进入结算后，测试专用篡改 users.reserved_balance 破坏
 * 「预扣投影 ≥ 账单预扣」不变量 → applyCharge 守卫 UPDATE 0 行 → 抛
 * billing_reservation_invariant。
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

const PREFIX = 'inv-dead';

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

function receipt(userId: number, requestId: string): UsageReceipt {
  return {
    requestId,
    userId,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'test-model',
    realModel: 'test-real',
    channelId: null,
    channelKey: 'test-channel',
    usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 500, estimated: false },
    inputPrice: '1000',
    outputPrice: '2000',
    cacheInputPrice: '100',
    coefficient: '1',
    durationMs: 10,
    stream: false,
    streamAborted: false,
    mappingId: 1,
    billingPolicyFingerprint: null,
  };
}

describe('RED: 结算不变量破坏必须首次失败即 dead（不空转重试）', () => {
  it('reserved_balance 投影脱节 → dead + invariant_violation', async (context) => {
    if (!connected) return context.skip();
    const suffix = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: `${PREFIX}-${suffix}`,
        identityProvider: 'local',
        balance: '100',
      })
      .returning({ id: users.id });
    const userId = user!.id;
    const billing = createBilling({ db });
    const requestId = randomUUID();
    try {
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'request.succeeded',
        requestId,
        receipt: receipt(userId, requestId),
      });

      // 测试专用：破坏预扣投影（reserved_balance 2 → 0），制造不变量红灯
      await db.execute(
        sql`update users set reserved_balance = 0 where id = ${userId}`,
      );

      const run = await createBillingProcessor({
        db,
        options: {
          ownerId: 'test-worker',
          batchSize: 10,
          claimLeaseMs: 60_000,
          retryBaseMs: 10,
          retryMaxMs: 100,
          maxAttempts: 3,
        },
      }).runOnce([requestId]);

      expect(run.dead).toBe(1);
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
        columns: { status: true, failureClass: true, settlementAttempts: true },
      });
      // 【红】当前实现：retry_wait + unknown（空转重试）
      // 【正确】确定性不变量破坏：首次失败即 dead + invariant_violation
      expect(row?.status).toBe('dead');
      expect(row?.failureClass).toBe('invariant_violation');
      expect(row?.settlementAttempts).toBe(1);
    } finally {
      await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
      await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
      await db.delete(transactions).where(eq(transactions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});
