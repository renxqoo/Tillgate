import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  billingRequests,
  plans,
  transactions,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import {
  BillingOperationError,
  createBillingAutoReleaser,
  createBillingOperations,
  createBillingProcessor,
} from '../index.js';

/**
 * 计费异常复核自动化（TDD）：
 *   - abandonDead：dead 单人工废弃 → released + 三类预扣全释放 + 幂等 + 版本冲突
 *   - 小额白名单自动放行：白名单码无条件放、其余 ≤ 阈值放、> 阈值与 dead 不碰、阈值 0 关闭
 *   - requestDead 告警 effect：转 dead 即触发（含金额与失败类目）
 */

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
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

async function createFixture(opts: {
  status: 'dead' | 'uncertain' | 'settlement_pending';
  failureCode?: string;
  reservedAmount?: string;
  planReserved?: string;
  withSubscription?: boolean;
  receipt?: Record<string, unknown> | null;
}): Promise<{ userId: number; subId: number | null; requestId: string; revision: number }> {
  const tag = randomUUID().slice(0, 8);
  const reservedAmount = opts.reservedAmount ?? '5';
  // 套餐部分默认不超过总预扣（生产不变量：plan_reserve ≤ reserved_amount）
  const planReserved = opts.planReserved ?? Math.min(3, Number(reservedAmount)).toFixed(2);
  // 用户在途只承载 payg 部分（= 总预扣 - 套餐部分），与生产不变量一致
  const paygExposure = Math.max(0, Number(reservedAmount) - Number(planReserved)).toFixed(2);
  let userId = 0;
  let subId: number | null = null;
  try {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `bra-${tag}`,
      identityProvider: 'local',
      balance: '100',
      reservedBalance: paygExposure,
    })
    .returning({ id: users.id });
  userId = user!.id;
  if (opts.withSubscription !== false) {
    const [plan] = await db
      .insert(plans)
      .values({
        name: `bra-${tag}`,
        kind: 'subscription',
        price: '10',
        periodDays: 30,
        quotaAmount: '100',
        sortOrder: 1,
        status: 0,
      })
      .returning({ id: plans.id });
    const [sub] = await db
      .insert(userSubscriptions)
      .values({
        userId,
        planId: plan!.id,
        startAt: new Date(),
        endAt: new Date(Date.now() + 86_400_000),
        quotaAmount: '100',
        reservedAmount: Math.min(Number(reservedAmount), Number(planReserved)).toFixed(2),
        quantity: 1,
        price: '10',
        status: 0,
      })
      .returning({ id: userSubscriptions.id });
    subId = sub!.id;
  }
  const requestId = randomUUID();
  // 约束 billing_requests_receipt_state_ck：settlement_pending/processing/retry_wait/settled/dead 必须带 receipt
  const needsReceipt = ['settlement_pending', 'dead'].includes(opts.status);
  const receipt =
    opts.receipt !== undefined && opts.receipt !== null
      ? opts.receipt
      : needsReceipt
        ? ({ requestId } as unknown as Record<string, unknown>)
        : null;
  await db.insert(billingRequests).values({
    requestId,
    userId,
    reservedAmount,
    planReservedAmount: subId != null ? planReserved : null,
    subscriptionId: subId,
    status: opts.status,
    stream: false,
    quote: { maxOutputTokens: 100, candidates: [] },
    authorizationFingerprint: randomUUID().replace(/-/g, ''),
    failureCode: opts.failureCode ?? null,
    failureClass: opts.status === 'dead' ? 'invariant_violation' : null,
    receipt,
  });
  return { userId, subId, requestId, revision: 0 };
  } catch (error) {
    // fixture 中途失败也要自清理，不泄漏测试用户/敞口
    await cleanup(userId, subId).catch(() => {});
    throw error;
  }
}

async function cleanup(userId: number, subId: number | null): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  if (subId != null) {
    const sub = await db.query.userSubscriptions.findFirst({
      where: eq(userSubscriptions.id, subId),
      columns: { planId: true },
    });
    await db.delete(userSubscriptions).where(eq(userSubscriptions.id, subId));
    if (sub) await db.delete(plans).where(eq(plans.id, sub.planId));
  }
  await db.delete(users).where(eq(users.id, userId));
}

describe('abandonDead：dead 单人工废弃', () => {
  it('释放全部预扣并转 released；幂等重放；版本冲突报错', async (context) => {
    if (!connected) return context.skip();
    const f = await createFixture({ status: 'dead', failureCode: 'usage_exceeds_authorization' });
    const operations = createBillingOperations({ db });
    try {
      const result = await operations.abandonDead({
        operationId: `test-abandon-${f.requestId}`,
        requestId: f.requestId,
        expectedRevision: 0,
        adminId: null,
        actor: 'system',
        reason: 'test: 旧判定残留废弃',
      });
      expect(result.status).toBe('released');
      expect(result.replayed).toBe(false);
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, f.requestId),
      });
      expect(row!.status).toBe('released');
      expect(row!.failureCode).toBe('manually_abandoned');
      const user = await db.query.users.findFirst({
        where: eq(users.id, f.userId),
        columns: { reservedBalance: true },
      });
      expect(Number(user!.reservedBalance)).toBe(0);
      const sub = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.id, f.subId!),
        columns: { reservedAmount: true },
      });
      expect(Number(sub!.reservedAmount)).toBe(0);

      // 幂等重放
      const replay = await operations.abandonDead({
        operationId: `test-abandon-${f.requestId}`,
        requestId: f.requestId,
        expectedRevision: 0,
        adminId: null,
        actor: 'system',
        reason: 'test: 旧判定残留废弃',
      });
      expect(replay.replayed).toBe(true);

      // 非 dead 状态再废弃 → 冲突
      await expect(
        operations.abandonDead({
          operationId: `test-abandon2-${f.requestId}`,
          requestId: f.requestId,
          expectedRevision: 1,
          adminId: null,
          reason: 'test: 已释放后再废弃',
        }),
      ).rejects.toMatchObject({ code: 'state_conflict' });
      expect(BillingOperationError).toBeDefined();
    } finally {
      await cleanup(f.userId, f.subId);
    }
  });
});

describe('小额白名单自动放行', () => {
  it('白名单码无条件放；小额放；超阈值、dead、阈值0 不放', async (context) => {
    if (!connected) return context.skip();
    const operations = createBillingOperations({ db });
    const releaser = createBillingAutoReleaser({
      db,
      operations,
      config: { maxAmount: '0.1', batchSize: 50 },
    });
    const disabled = createBillingAutoReleaser({
      db,
      operations,
      config: { maxAmount: '0', batchSize: 50 },
    });

    const free = await createFixture({ status: 'uncertain', failureCode: 'rate_limit_error', reservedAmount: '5' });
    const small = await createFixture({ status: 'uncertain', failureCode: 'network', reservedAmount: '0.05' });
    const big = await createFixture({ status: 'uncertain', failureCode: 'network', reservedAmount: '1.002' });
    const dead = await createFixture({ status: 'dead', failureCode: 'usage_exceeds_authorization', reservedAmount: '0.0002' });
    try {
      const r = await releaser.runOnce();
      expect(r.released).toBeGreaterThanOrEqual(2);
      const freeRow = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, free.requestId),
      });
      expect(freeRow!.status).toBe('released');
      const smallRow = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, small.requestId),
      });
      expect(smallRow!.status).toBe('released');
      // 超阈值与 dead 不动
      const bigRow = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, big.requestId),
      });
      expect(bigRow!.status).toBe('uncertain');
      const deadRow = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, dead.requestId),
      });
      expect(deadRow!.status).toBe('dead');

      // 幂等：再跑一轮无新放行
      const again = await releaser.runOnce();
      expect(again.released).toBe(0);

      // 阈值 0 → 整个通道关闭
      const d = await disabled.runOnce();
      expect(d.released).toBe(0);
      expect(d.considered).toBe(0);
    } finally {
      await cleanup(free.userId, free.subId);
      await cleanup(small.userId, small.subId);
      await cleanup(big.userId, big.subId);
      await cleanup(dead.userId, dead.subId);
    }
  });
});

describe('requestDead 告警 effect', () => {
  it('毒收据转 dead 时触发，携带金额与失败类目', async (context) => {
    if (!connected) return context.skip();
    const f = await createFixture({
      status: 'settlement_pending',
      reservedAmount: '0.5',
      receipt: { garbage: true } as unknown as Record<string, unknown>,
    });
    const onDead = vi.fn();
    const processor = createBillingProcessor({
      db,
      options: {
        ownerId: `test-dead-${randomUUID()}`,
        batchSize: 5,
        claimLeaseMs: 60_000,
        retryBaseMs: 10,
        retryMaxMs: 100,
        maxAttempts: 1,
      },
      effects: {
        requestDead: onDead,
      },
    });
    try {
      await processor.runOnce([f.requestId]);
      await vi.waitFor(() => {
        const row = db.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, f.requestId),
        });
        return row;
      });
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, f.requestId),
      });
      expect(row!.status).toBe('dead');
      expect(onDead).toHaveBeenCalled();
      const event = onDead.mock.calls[0]![0] as { failureClass: string; reservedAmount: string };
      expect(event.failureClass).toBe('poison_receipt');
      expect(Number(event.reservedAmount)).toBeGreaterThan(0);
    } finally {
      await cleanup(f.userId, f.subId);
    }
  });
});
