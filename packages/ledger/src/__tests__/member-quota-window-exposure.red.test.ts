import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  apiKeys,
  billingRequests,
  organizations,
  orgMembers,
  plans,
  transactions,
  usageLogs,
  userSubscriptions,
  users,
} from '@ai-gateway/db/schema';
import { createBilling } from '../billing/index.js';
import { MemberQuotaExceededError } from '../billing/errors.js';
import type { BillingQuote } from '../billing/types.js';

/**
 * 【红测 · 限额窗口（成员子配额 b）】成员月配额的「在途敞口」按
 * created_at >= 本月1号 过滤——跨月界仍在途的请求不计入，但它结算时会落进
 * 新月份的 usage_logs。与 daily-limit-window-exposure 同一类缺陷（SUM 敞口
 * 带了创建时间窗口），本用例覆盖 subscription-gate 的月度维度。
 *
 * 复现：req1 授权（在途，占成员月配额）→ 回溯 created_at 32 天（必跨月界）→
 * req2 授权应被 MemberQuotaExceededError 拒绝。
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

const PREFIX = 'mq-race';

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

async function setupTeam(suffix: string) {
  const [owner] = await db
    .insert(users)
    .values({ issuer: 'test', subject: `${PREFIX}-o-${suffix}`, identityProvider: 'local' })
    .returning({ id: users.id });
  const [member] = await db
    .insert(users)
    .values({ issuer: 'test', subject: `${PREFIX}-m-${suffix}`, identityProvider: 'local' })
    .returning({ id: users.id });
  const [org] = await db
    .insert(organizations)
    .values({ name: `${PREFIX}-${suffix}`, ownerUserId: owner!.id })
    .returning({ id: organizations.id });
  await db.insert(orgMembers).values({
    orgId: org!.id,
    userId: member!.id,
    role: 'member',
    status: 0,
    monthlyQuota: '3',
  });
  const [plan] = await db
    .insert(plans)
    .values({
      name: `${PREFIX}-${suffix}`,
      price: '10',
      periodDays: 30,
      quotaAmount: '100',
      status: 0,
      kind: 'subscription',
      sortOrder: 1,
      allowSeats: true,
    })
    .returning({ id: plans.id });
  const [sub] = await db
    .insert(userSubscriptions)
    .values({
      userId: owner!.id,
      planId: plan!.id,
      startAt: new Date(),
      endAt: new Date(Date.now() + 30 * 86400_000),
      quotaAmount: '100',
      orgId: org!.id,
      status: 0,
    })
    .returning({ id: userSubscriptions.id });
  const [key] = await db
    .insert(apiKeys)
    .values({
      keyHash: randomUUID().replace(/-/g, ''),
      keyPreview: `${PREFIX}-${suffix}`,
      userId: member!.id,
      name: 'race-key',
      subscriptionId: sub!.id,
    })
    .returning({ id: apiKeys.id });
  return { ownerId: owner!.id, memberId: member!.id, orgId: org!.id, apiKeyId: key!.id };
}

describe('RED: 成员月配额在途敞口不得按 created_at 过滤（跨月界穿透）', () => {
  it('上月授权的在途敞口必须计入本月成员子配额', async (context) => {
    if (!connected) return context.skip();
    const suffix = randomUUID().slice(0, 8);
    const { ownerId, memberId, apiKeyId } = await setupTeam(suffix);
    const billing = createBilling({ db });
    try {
      const req1 = randomUUID();
      await billing.authorize({
        requestId: req1,
        userId: memberId,
        apiKeyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      // 回溯 32 天（必跨本地月界）：模拟「上月发起、仍在途」
      await db.execute(
        sql`update billing_requests
            set created_at = created_at - interval '32 days'
            where request_id = ${req1}::uuid`,
      );

      // 月配额 3：上月敞口 2 + 本次 2 = 4 > 3 → 必须拒绝
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId: memberId,
          apiKeyId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(MemberQuotaExceededError);
    } finally {
      // 清理顺序：账单行先删（member 的账单引用 owner 的订阅，FK 约束）
      await db
        .delete(billingRequests)
        .where(inArray(billingRequests.userId, [ownerId, memberId]));
      for (const uid of [ownerId, memberId]) {
        await db.delete(usageLogs).where(eq(usageLogs.userId, uid));
        await db.delete(transactions).where(eq(transactions.userId, uid));
        await db.delete(apiKeys).where(eq(apiKeys.userId, uid));
        await db.delete(orgMembers).where(eq(orgMembers.userId, uid));
      }
      await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, ownerId));
      await db.delete(organizations).where(eq(organizations.ownerUserId, ownerId));
      await db.delete(users).where(inArray(users.id, [ownerId, memberId]));
      await db.delete(plans).where(eq(plans.name, `${PREFIX}-${suffix}`));
    }
  });
});
