import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiEvent, ChatStreamResult } from '@ai-gateway/ai';
import { eq } from 'drizzle-orm';
import { billingRequests } from '@ai-gateway/db/schema';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  createTestUser,
  createTestApiKey,
  setupTestModel,
  cleanupTestData,
  buildTestApp,
  makeMockAi,
  BILLING_SETTLE_STATES,
} from '../../testing/helpers.js';
import { createBillingDispatcher } from '../../services/billing/billing-dispatcher.js';

/**
 * 估算结算政策（2026-08-17 拍板，TDD 红灯先行）：
 *
 * 前提：所有厂商均无 usage 补录接口；人工复核在实践中期望价值≈0（uncertain
 * 单积压无人处置≈漏收）。政策从「宁可少收」（G1：估算绝不进资金结算）翻转
 * 为「按已交付估算收」——核心动机是防刷（上游真实计费，我们不跟=可被利用）。
 *
 * 新矩阵：
 *   完成缺 usage（流式/非流式）→ 估算结算（estimated receipt，归属 usage_missing_*）
 *   用户取消（已识别）          → 估算结算（不变，既有用例护栏）
 *   上游服务端异常（超时/5xx/截断/断连）→ 释放（不扣）
 *   未交付失败 / server_draining / 网关崩溃 → 释放（不扣）
 *   dead（不变量破坏）→ 人工复核（唯一保留队列）
 */

loadEnvFileIntoProcess();
ensureTestSecrets();

const db = createTestDb();
const redis = createTestRedis();

let connected = false;
beforeAll(async () => {
  await redis.connect().catch(() => {});
  connected = await isBackendAvailable(db, redis);
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

interface WakeSpy {
  dispatcher: ReturnType<typeof createBillingDispatcher>;
  wakeCalled: () => boolean;
}

function wakeSpy(): WakeSpy {
  const dispatcher = createBillingDispatcher(redis);
  let called = false;
  const orig = dispatcher.wake.bind(dispatcher);
  dispatcher.wake = async (requestId) => {
    called = true;
    return orig(requestId);
  };
  return { dispatcher, wakeCalled: () => called };
}

function makeStreamAi(
  events: (emit: (e: AiEvent) => void) => void,
): ReturnType<typeof makeMockAi> {
  return makeMockAi({
    chatStream: vi.fn(async (): Promise<ChatStreamResult> => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
          c.close();
        },
      });
      return {
        stream,
        onEvent: (cb) => {
          events(cb);
        },
      };
    }),
  });
}

describe('估算结算政策（2026-08-17）', () => {
  it('流式正常完成缺 usage → 估算结算：settlement_pending + estimated receipt + 唤醒', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'estpol');
    const { token, keyHash } = await createTestApiKey(db, userId, 'estpol');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    const spy = wakeSpy();
    try {
      const ai = makeStreamAi((emit) => {
        emit({ type: 'first_chunk', requestId: 'est-1' });
        setTimeout(() => {
          emit({
            type: 'success',
            requestId: 'est-1',
            channelKey: 'est-ch',
            usage: undefined,
            durationMs: 800,
            bytesRelayed: 5095,
            // 关键：terminated 缺省 = 正常完成（终止帧已到，MiniMax 没回 usage）
          });
        }, 30);
      });
      const app = buildTestApp(db, redis, ai, undefined, undefined, spy.dispatcher);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 1000,
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
      // 收尾是异步的：轮询等 billing 终态（接受 settled：本地 worker 可能已结算）
      await waitForBilling(
        userId,
        (b) => b?.status === 'settlement_pending' || b?.status === 'settled',
      );
      const billing = await getBilling(userId);
      expect(BILLING_SETTLE_STATES).toContain(billing!.status);
      const receipt = billing!.receipt as Record<string, unknown>;
      expect((receipt.usage as Record<string, unknown>).estimated).toBe(true);
      expect(receipt.estimatedFor).toBe('usage_missing_completed');
      expect(receipt.bytesRelayed).toBe(5095);
      expect(spy.wakeCalled()).toBe(true);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('流式上游截断（upstream_truncated）→ 释放不扣：released + 无收据 + 不唤醒', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'estrli');
    const { token, keyHash } = await createTestApiKey(db, userId, 'estrli');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    const spy = wakeSpy();
    try {
      const ai = makeStreamAi((emit) => {
        emit({ type: 'first_chunk', requestId: 'est-2' });
        setTimeout(() => {
          emit({
            type: 'success',
            requestId: 'est-2',
            channelKey: 'est-ch',
            usage: undefined,
            durationMs: 400,
            bytesRelayed: 1200,
            terminated: 'upstream_truncated',
          });
        }, 30);
      });
      const app = buildTestApp(db, redis, ai, undefined, undefined, spy.dispatcher);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
      await waitForBilling(userId, (b) => b?.status === 'released');
      const billing = await getBilling(userId);
      expect(billing).toMatchObject({
        status: 'released',
        failureCode: 'upstream_truncated',
        receipt: null,
      });
      expect(spy.wakeCalled()).toBe(false);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('非流式完成缺 usage → 估算结算：settlement_pending + estimated receipt（output 从响应体估算）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'estns');
    const { token, keyHash } = await createTestApiKey(db, userId, 'estns');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    const spy = wakeSpy();
    try {
      const ai = makeMockAi({
        chat: vi.fn(async () => ({
          status: 'success' as const,
          usage: undefined,
          body: {
            id: 'mock',
            object: 'chat.completion',
            choices: [{ message: { role: 'assistant', content: 'hello estimated world' } }],
          },
          durationMs: 10,
        })),
      });
      const app = buildTestApp(db, redis, ai, undefined, undefined, spy.dispatcher);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });
      expect(res.status).toBe(200);
      // 接受 settlement_pending 或 settled：本地 worker（tsx watch）可能已在断言前结算
      await waitForBilling(
        userId,
        (b) => b?.status === 'settlement_pending' || b?.status === 'settled',
      );
      const billing = await getBilling(userId);
      expect(BILLING_SETTLE_STATES).toContain(billing!.status);
      const receipt = billing!.receipt as Record<string, unknown>;
      const usage = receipt.usage as Record<string, unknown>;
      expect(usage.estimated).toBe(true);
      expect(receipt.estimatedFor).toBe('usage_missing_nonstream');
      // output 从响应体内容估算（非 0）
      expect(Number(usage.outputTokens)).toBeGreaterThan(0);
      expect(spy.wakeCalled()).toBe(true);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});

async function getBilling(userId: number) {
  return db.query.billingRequests.findFirst({
    where: eq(billingRequests.userId, userId),
  });
}

async function waitForBilling(
  userId: number,
  predicate: (b: Awaited<ReturnType<typeof getBilling>>) => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(await getBilling(userId))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
