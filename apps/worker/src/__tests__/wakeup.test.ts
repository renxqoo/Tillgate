/**
 * 结算唤醒链路集成套件（真 PG + 真 Redis + 真 BullMQ）：
 *   ① 合并执行器语义：突发唤醒折叠为批次
 *   ② 全链：billing.signal（带 wake 门铃）→ 队列 → worker 唤醒 → runOnce 结算
 *     ——全程不启动任何定时器（对照：纯轮询形态需等 interval）。
 * 账务正确性不依赖消息：jobId 固定去重 + 认领 CAS 双保险。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createBillingDomain, createSettlementDomain, createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import type { BillingQuote, UsageReceipt } from '@ai-gateway/domain';
import { Queue } from 'bullmq';
import { SETTLE_WAKE_QUEUE } from '@ai-gateway/service';
import { createSettleWakeupConsumer, createCoalescedRunner } from '../wakeup.js';

/** 生产端替身（与 gateway wakeup.ts 同语义：固定 jobId 去重投递） */
function createProducerStandIn(url: string) {
  const queue = new Queue(SETTLE_WAKE_QUEUE, {
    connection: { url },
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
  });
  return {
    wake: (requestId: string) => {
      void queue.add('settle', { requestId }, { jobId: 'settle-wake' }).catch(() => undefined);
    },
    close: () => queue.close(),
  };
}
import { createRunOnce } from '../run-once.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const ctx: RunContext = systemContext('v2wk-wakeup');
const settlement = createSettlementDomain({
  db,
  currency: 'CNY',
  policy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
});
const runOnce = createRunOnce({ settlement, ownerId: 'wakeup-worker', batchSize: 10, claimLeaseMs: 60_000 });

const createdUsers: number[] = [];
const createdRequests: string[] = [];
const producer = createProducerStandIn(redisUrl);

/** 队列清场：固定 jobId 的门铃语义要求测试前无残留（active/failed 态会去重挡新投递） */
async function purgeWakeQueue(): Promise<void> {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const keys = await redis.keys('bull:settle-wake*');
  if (keys.length) await redis.del(...keys);
  await redis.quit().catch(() => undefined);
}
beforeAll(purgeWakeQueue);

const q: BillingQuote = {
  maxOutputTokens: 0,
  candidates: [{
    mappingId: 1, externalModel: 'gpt-x', realModel: 'gpt-real',
    inputPrice: '2', outputPrice: '0', cacheInputPrice: '2',
    coefficient: '1', inputTokenUpperBound: 1_000_000, billingPolicyFingerprint: null,
  }],
};

async function newPendingRequest(userId: number, wake?: (requestId: string) => void): Promise<string> {
  const billing = createBillingDomain({ db, currency: 'CNY', ...(wake ? { wake } : {}) });
  const requestId = randomUUID();
  createdRequests.push(requestId);
  await billing.authorize(ctx, {
    requestId, userId, stream: false, quote: q,
    reservationLimit: '100', authorizationTtlMs: 300_000,
  });
  const receipt: UsageReceipt = {
    requestId, userId, apiKeyId: null, appId: null, credentialType: 'key',
    externalModel: 'gpt-x', realModel: 'gpt-real', channelId: null, channelKey: 'test',
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    inputPrice: '2', outputPrice: '0', cacheInputPrice: '2', coefficient: '1',
    durationMs: 5, stream: false, streamAborted: false, mappingId: 1,
    billingPolicyFingerprint: null,
  };
  await billing.signal(ctx, { type: 'request.succeeded', requestId, receipt });
  return requestId;
}

afterAll(async () => {
  if (createdRequests.length) {
    await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [createdRequests]);
    await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [createdRequests]);
    await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [createdRequests]);
  }
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  await producer.close();
  await db.$client.end().catch(() => {});
});

describe('合并执行器（纯语义）', () => {
  it('突发唤醒折叠：3 次并发 wake ≤ 2 次实际执行', async () => {
    let runs = 0;
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 60));
    const coalesced = createCoalescedRunner(async () => {
      runs += 1;
      await gate;
    });
    await Promise.all([coalesced(), coalesced(), coalesced()]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runs).toBeLessThanOrEqual(2);
    expect(runs).toBeGreaterThanOrEqual(1);
  });
});

describe('唤醒全链（真 BullMQ）', () => {
  it('signal → 入队 → worker 唤醒 → runOnce 结算（无定时器参与）', async () => {
    const [row] = await db
      .insert(users)
      .values({ issuer: 'v2wk', subject: `v2wk-${randomUUID()}`, identityProvider: 'local' })
      .returning({ id: users.id });
    createdUsers.push(row!.id);
    // 预扣需要余额：与 worker.test.ts 同口径注资
    const fundWallet = createWallet({
      db,
      currency: 'CNY',
      guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
    });
    await fundWallet.credit(ctx, { userId: row!.id, amount: '100', refType: 'topup', refId: `v2wk-wake-${randomUUID()}` });

    const consumer = createSettleWakeupConsumer(redisUrl, async () => {
      await runOnce(ctx);
    });
    try {
      // signal 带真门铃：billing domain 注入 producer.wake —— 唤醒由 signal 触发
      const requestId = await newPendingRequest(row!.id, producer.wake);

      await vi.waitFor(
        async () => {
          const r = await db.$client.query<{ status: string }>(
            'select status from billing_requests where request_id = $1',
            [requestId],
          );
          expect(r.rows[0]?.status).toBe('settled');
        },
        { timeout: 8_000, interval: 200 },
      );
    } finally {
      await consumer.close();
    }
  }, 15_000);
});

it('队列命名契约：service 常量为唯一真相', () => {
  expect(SETTLE_WAKE_QUEUE).toBe('settle-wake');
});
