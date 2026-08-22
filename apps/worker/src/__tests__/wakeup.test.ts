/**
 * 结算唤醒链路集成套件（真 PG LISTEN/NOTIFY）：
 *   ① 合并执行器语义：突发唤醒折叠为批次
 *   ② 全链：billing.signal（带 wake 门铃）→ pg_notify → worker LISTEN 唤醒
 *     → runOnce 结算——全程不启动任何定时器（对照：纯轮询形态需等 interval）。
 * 账务正确性不依赖消息：认领 CAS + 兜底扫描双保险（消息可丢）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createBillingDomain, createSettlementDomain, createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import type { BillingQuote, UsageReceipt } from '@ai-gateway/domain';
import { SETTLE_WAKE_CHANNEL } from '@ai-gateway/service';
import { createSettleWakeupConsumer, createCoalescedRunner } from '../wakeup.js';

/** 生产端替身（与 gateway wakeup.ts 同语义：pg_notify 门铃，fire-and-forget） */
function createProducerStandIn() {
  return {
    wake: (requestId: string) => {
      void db.$client
        .query('select pg_notify($1, $2)', [SETTLE_WAKE_CHANNEL, requestId])
        .catch(() => undefined);
    },
    close: async () => {},
  };
}
import { createRunOnce } from '../run-once.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2wk-wakeup');
const settlement = createSettlementDomain({
  db,
  currency: 'CNY',
  policy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
});
const runOnce = createRunOnce({ settlement, ownerId: 'wakeup-worker', batchSize: 10, claimLeaseMs: 60_000 });

const createdUsers: number[] = [];
const createdRequests: string[] = [];
const producer = createProducerStandIn();

// NOTIFY 无残留状态，无需 beforeAll 清理
// 消费端 LISTEN 就绪需要一次连接往返——全链用例内先等通道就绪再触发生产。

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

describe('唤醒全链（真 PG LISTEN/NOTIFY）', () => {
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

    const consumer = createSettleWakeupConsumer(
      process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
      async () => {
        await runOnce(ctx);
      },
    );
    try {
      // LISTEN 就绪后再生产（NOTIFY 不排队：就绪前的通知会丢，由兜底扫描覆盖）
      await consumer.ready();
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
        // CI 慢机（import 84s 级）全链 notify→唤醒→claim→结算可超 8s——与 9636014 慢机超时同款；
        // 本用例单发门铃无兜底定时器，窗口不足即假阴性
        { timeout: 30_000, interval: 200 },
      );
    } finally {
      await consumer.close();
    }
  }, 45_000);
});

it('通道命名契约：service 常量为唯一真相', () => {
  expect(SETTLE_WAKE_CHANNEL).toBe('settle-wake');
});

describe('LISTEN 断线重连（真 PG）', () => {
  it('连接被 kill → 指数退避重连 → 新通知仍触发 onWake', { timeout: 20_000 }, async () => {
    let wakes = 0;
    const consumer = createSettleWakeupConsumer(
      process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
      async () => {
        wakes += 1;
      },
    );
    try {
      await consumer.ready();
      await db.$client.query('select pg_notify($1, $2)', [SETTLE_WAKE_CHANNEL, 'before']);
      await vi.waitFor(() => expect(wakes).toBe(1), { timeout: 5_000, interval: 100 });

      // 服务端腰斩 LISTEN 连接（模拟网络闪断/PG 重启）
      await db.$client.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'settle-wake-listener' and pid <> pg_backend_pid()`,
      );

      // 重连窗口内的通知会丢（设计语义：兜底扫描覆盖）；结果导向验证：
      // 持续发探针通知，直到 onWake 再次触发——通知只在 LISTEN 状态下到达，
      // wakes 增长即证明断线重连完成（不依赖 pg_stat_activity 的 backend 消失时序）
      const t0 = Date.now();
      for (;;) {
        await db.$client.query('select pg_notify($1, $2)', [SETTLE_WAKE_CHANNEL, 'after']);
        if (wakes >= 2) break;
        if (Date.now() - t0 > 15_000) throw new Error('15s 内断线重连未恢复（探针通知未触发）');
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(wakes).toBeGreaterThanOrEqual(2);
    } finally {
      await consumer.close();
    }
  });
});
