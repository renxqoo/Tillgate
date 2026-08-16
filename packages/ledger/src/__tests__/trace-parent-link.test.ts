import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  apiKeys,
  billingRequests,
  plans,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { createBilling } from '../billing-flow.js';
import { createBillingProcessor } from '../billing-processor.js';
import type { BillingQuote, SettleClaimResult, SettlementClaim, UsageReceipt } from '../types.js';

/**
 * 阶段2（链路完整性）：跨进程 trace 关联。
 *
 * gateway 在 authorize 时把根 span 的 traceparent 写入 billing_requests.trace_parent；
 * worker claim 带回该列，以远端父创建 billing.settle span——
 * 「扣费」因此出现在请求的同一条 trace 里，而非孤立的 worker trace。
 *
 * 本测试锁死：① 列持久化 ② claim 带回 ③ telemetry.settle 钩子包裹结算
 * （拿到 claim（含 traceParent）与 settle 结果）。
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

async function createUser(quota = '10000'): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `tplink-${randomUUID()}`,
      identityProvider: 'local',
      displayName: 'TraceParent Link',
      balance: '100',
    })
    .returning({ id: users.id });
  const userId = user!.id;
  const [plan] = await db
    .insert(plans)
    .values({
      name: `tpl-${randomUUID().slice(0, 6)}`,
      kind: 'subscription',
      sortOrder: 1,
      price: '0',
      periodDays: 30,
      quotaAmount: quota,
      allowSeats: false,
      status: 0,
    })
    .returning({ id: plans.id });
  await db.insert(userSubscriptions).values({
    userId,
    planId: plan!.id,
    startAt: new Date(),
    endAt: new Date(Date.now() + 86_400_000),
    quotaAmount: quota,
    usedAmount: '0',
    reservedAmount: '0',
    quantity: 1,
    price: '0',
    status: 0,
  });
  return userId;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

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

describe('trace_parent 跨进程关联（worker 结算入链路）', () => {
  it('authorize 落列 → claim 带回 → telemetry.settle 包裹结算', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser();
    const requestId = randomUUID();
    const traceParent = `00-${'ab'.repeat(16)}-${'cd'.repeat(8)}-01`;
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
        traceParent,
      });

      // ① 列持久化
      const stored = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
        columns: { traceParent: true },
      });
      expect(stored?.traceParent).toBe(traceParent);

      await billing.signal({
        type: 'request.succeeded',
        requestId,
        receipt: receipt(userId, requestId),
      });

      // ③ telemetry 钩子：拿到含 traceParent 的 claim 与结算结果
      const seen: Array<{ traceParent: string | null; outcome: SettleClaimResult['outcome'] }> = [];
      const processor = createBillingProcessor({
        db,
        options: {
          ownerId: 'test-worker',
          batchSize: 10,
          claimLeaseMs: 60_000,
          retryBaseMs: 10,
          retryMaxMs: 100,
          maxAttempts: 3,
          telemetry: {
            settle: async (claim: SettlementClaim, next) => {
              const result = await next();
              seen.push({ traceParent: claim.traceParent, outcome: result.outcome });
              return result;
            },
          },
        },
      });
      const totals = await processor.runOnce([requestId]);
      expect(totals.settled).toBe(1);
      expect(seen).toHaveLength(1);
      // ② claim 带回（worker 据此创建远端父的 billing.settle span）
      expect(seen[0]!.traceParent).toBe(traceParent);
      expect(seen[0]!.outcome).toBe('settled');
    } finally {
      await cleanup(userId);
    }
  });
});
