import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  apiKeys,
  billingRequests,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { createBilling } from '../billing/index.js';
import { DailySpendLimitExceededError } from '../billing/errors.js';
import type { BillingQuote } from '../billing/types.js';

/**
 * 【红测 · 限额窗口】每日花费上限的「在途敞口」按 created_at >= 今日0点 过滤——
 * 跨日界仍在途的请求不计入，但它结算时会落进新窗口的 usage_logs（已消费侧
 * 按结算时间统计）。两侧口径不对称 → 用户可在日界前后叠加授权突破单日上限。
 *
 * 在途敞口的正确口径：只要请求未终结（authorized/in_flight/...），其预扣就
 * 占用额度，与创建时间无关——已结算侧才按结算时间归属窗口。
 *
 * 复现：req1 授权（在途）→ 回溯 created_at 26 小时（必跨本地日界）→
 * req2 授权应被拒（昨日敞口 + 今日新增 > 上限）。
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

const PREFIX = 'dlwin-race';

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

/** 单笔授权预估 = (1000×1000 + 2000×500)/1e6 = 2 元 */

/** 测试专用：回溯账单创建时间 26 小时（本地时区必跨日界），模拟「昨日发起、仍在途」 */
async function backdate26h(requestId: string): Promise<void> {
  await db.execute(
    sql`update billing_requests
        set created_at = created_at - interval '26 hours'
        where request_id = ${requestId}::uuid`,
  );
}

describe('RED: 每日限额在途敞口不得按 created_at 过滤（跨日界穿透）', () => {
  it('用户级：昨日授权的在途敞口必须计入今日上限', async (context) => {
    if (!connected) return context.skip();
    const suffix = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: `${PREFIX}-u-${suffix}`,
        identityProvider: 'local',
        balance: '100',
        dailySpendLimit: '3',
      })
      .returning({ id: users.id });
    const userId = user!.id;
    const billing = createBilling({ db });
    try {
      const req1 = randomUUID();
      await billing.authorize({
        requestId: req1,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await backdate26h(req1);

      // 上限 3：昨日敞口 2 + 本次 2 = 4 > 3 → 必须拒绝
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(DailySpendLimitExceededError);
    } finally {
      await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
      await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
      await db.delete(transactions).where(eq(transactions.userId, userId));
      await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  it('Key 级：昨日授权的在途敞口必须计入该 Key 今日上限', async (context) => {
    if (!connected) return context.skip();
    const suffix = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: `${PREFIX}-k-${suffix}`,
        identityProvider: 'local',
        balance: '100',
      })
      .returning({ id: users.id });
    const userId = user!.id;
    const [key] = await db
      .insert(apiKeys)
      .values({
        keyHash: randomUUID().replace(/-/g, ''),
        keyPreview: `${PREFIX}-${suffix}`,
        userId,
        name: 'race-key',
        dailySpendLimit: '3',
      })
      .returning({ id: apiKeys.id });
    const apiKeyId = key!.id;
    const billing = createBilling({ db });
    try {
      const req1 = randomUUID();
      await billing.authorize({
        requestId: req1,
        userId,
        apiKeyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await backdate26h(req1);

      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          apiKeyId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(DailySpendLimitExceededError);
    } finally {
      await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
      await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
      await db.delete(transactions).where(eq(transactions.userId, userId));
      await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
      await db.delete(apiKeys).where(eq(apiKeys.id, apiKeyId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});
