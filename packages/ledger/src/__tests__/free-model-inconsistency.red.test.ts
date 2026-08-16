import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  billingRequests,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { createBilling } from '../billing/index.js';
import type { BillingQuote } from '../billing/types.js';

/**
 * 【红测 · R6】explicitlyFree（is_free 标志）与候选价格是两套口径，允许互相矛盾
 *
 * 现状（e2e 实测，账号 7908，2026-08-15）：
 *   授权：billing-flow.ts:187 `quote.explicitlyFree → 金额 0` → 不校验余额、不预留；
 *   结算：calcAmount 按候选价格 × usage 实算 → 正常扣钱。
 * 即「is_free=true + 非零价」的模型：0 元授权 + 实价结算。
 *
 * 危害：
 *   1) 单一真相破坏：免费的判定在授权（标志）与结算（价格）两处不一致；
 *   2) 资金异常放大器：0 余额用户可无限发起请求（不校验余额），结算实扣可能
 *      超过余额 → 信用地板违规 → retry_wait/dead 堆积人工复核；
 *   3) 管理端（admin-api models.ts）接受 isFree 与非零价任意组合，无互斥校验。
 *
 * 预期（正确行为）：authorize 必须拒绝「explicitlyFree 但候选价格非全零」的报价
 * （invalid_quote），与既有用例「全零价但未标 explicitlyFree → invalid_quote」互为镜像。
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

async function createUser(balance: string): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `redfree-${randomUUID()}`,
      identityProvider: 'local',
      balance,
    })
    .returning({ id: users.id });
  return user!.id;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function quote(explicitlyFree: boolean): BillingQuote {
  return {
    maxOutputTokens: 500,
    explicitlyFree,
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

describe('RED R6: explicitlyFree 与候选价格口径必须一致', () => {
  it('explicitlyFree=true 但候选价格非全零 → 必须拒绝（invalid_quote）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('0');
    const billing = createBilling({ db });
    try {
      // 【红】当前实现：0 元授权成功（不校验余额）；正确行为应抛 invalid_quote
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          stream: false,
          quote: quote(true),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toThrow(/invalid_quote/i);
    } finally {
      await cleanup(userId);
    }
  });

  it('对照：explicitlyFree=true 且价格全零 → 0 元授权正常（既有行为不回归）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('0');
    const billing = createBilling({ db });
    try {
      const result = await billing.authorize({
        requestId: randomUUID(),
        userId,
        stream: false,
        quote: {
          ...quote(true),
          candidates: [
            {
              ...quote(true).candidates[0]!,
              inputPrice: '0',
              outputPrice: '0',
              cacheInputPrice: '0',
            },
          ],
        },
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      expect(result.reservedAmount).toBe('0');
    } finally {
      await cleanup(userId);
    }
  });
});
