import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { billingRequests, transactions, users } from '@ai-gateway/db/schema';
import { createBilling, DailySpendLimitExceededError } from '../billing-flow.js';
import type { BillingQuote } from '../types.js';

/**
 * 红测（F4）：每日花费上限是无锁 SUM（READ COMMITTED 下并发事务互相看不见
 * 未提交行）→ 并发突刺可整体突破上限。余额/额度硬闸门是原子的，日限只是
 * 防滥用天花板——但它必须不可被「同时开 N 个并发」整体击穿。
 *
 * 场景：dailySpendLimit=3，单次预估 2。并发 2 笔授权：串行时第二笔 projected
 * = 2(在途) + 2(本次) = 4 > 3 必拒；并发无锁时两笔都看到 0 → 双双通过。
 * 修法：authorize 事务内 pg_advisory_xact_lock 按 user 串行化决策（DB 层
 * 串行原语，不是重试补丁）。
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

const PREFIX = 'daily-race';

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

async function cleanup(userId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('每日花费上限并发不变量（F4 红测）', () => {
  it('并发授权 ×2（各 2 元，上限 3 元）→ 恰好 1 笔通过', async (context) => {
    if (!connected) return context.skip();
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: `${PREFIX}-${randomUUID()}`,
        identityProvider: 'local',
        balance: '1000',
        dailySpendLimit: '3',
      })
      .returning({ id: users.id });
    const userId = user!.id;
    const billing = createBilling({ db });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          billing.authorize({
            requestId: randomUUID(),
            userId,
            apiKeyId: null,
            stream: false,
            quote: quote(), // required = 2
            reservationLimit: '50',
            authorizationTtlMs: 60_000,
          }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(DailySpendLimitExceededError);
      // 通过的恰好一笔在途（另一笔不留任何行/预占）
      const rows = await db
        .select({ requestId: billingRequests.requestId })
        .from(billingRequests)
        .where(eq(billingRequests.userId, userId));
      expect(rows).toHaveLength(1);
    } finally {
      await cleanup(userId);
    }
  });
});
