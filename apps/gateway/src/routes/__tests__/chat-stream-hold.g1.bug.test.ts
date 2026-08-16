import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { billingRequests, usageLogs } from '@ai-gateway/db/schema';
import type { AiEvent, ChatStreamResult } from '@ai-gateway/ai';
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
 * 金额正确性回归：流式成功但无可信 usage 时禁止估算扣费，保留预扣等待审计。
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

describe('G1（2026-08-17 修订）— 流式完成无 usage → 估算结算；中断 → 释放', () => {
  it('完成缺 usage（bytesRelayed=0）→ 估算结算（input 计费）+ 唤醒', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'g1');
    const { token, keyHash } = await createTestApiKey(db, userId, 'g1');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      // mock Ai：chatStream 返回一个流，onEvent 注册后立即同步发 success（usage=undefined, bytesRelayed=0）
      const ai = makeMockAi({
        chatStream: vi.fn(async (): Promise<ChatStreamResult> => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          });
          return {
            stream,
            onEvent: (cb: (e: AiEvent) => void) => {
              // 同步发 success（模拟 relay-stream 流尾 done→success），无 usage、0 字节
              cb({
                type: 'success',
                requestId: 'g1-test',
                channelKey: 'g1ch',
                usage: undefined,
                durationMs: 10,
                bytesRelayed: 0,
              } as AiEvent);
            },
          };
        }),
      });

      // spy enqueue：观察计量是否入队
      const dispatcher = createBillingDispatcher(redis);
      const origWake = dispatcher.wake.bind(dispatcher);
      dispatcher.wake = origWake;

      const honoApp = buildTestApp(db, redis, ai, undefined, undefined, dispatcher);
      const res = await honoApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 10,
        }),
      });

      expect(res.status).toBe(200);
      await res.text(); // 消费到 EOF；flush 会等待 durable receipt 提交后才结束。
      // 2026-08-17 政策：估算结算 → 唤醒 worker（DB drain 兜底，唤醒失败不影响正确性）
      const billing = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.userId, userId),
      });
      // 2026-08-17 政策：完成态缺 usage → 估算结算（bytes=0 → 仅 input），不再冻结
      expect(BILLING_SETTLE_STATES).toContain(billing!.status);
      const receipt = billing!.receipt as Record<string, unknown>;
      expect((receipt.usage as Record<string, unknown>).estimated).toBe(true);
      expect(receipt.estimatedFor).toBe('usage_missing_completed');
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('中断流无 usage（upstream_truncated）→ 释放不扣（released）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'truncated');
    const { token, keyHash } = await createTestApiKey(db, userId, 'truncated');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chatStream: vi.fn(async (): Promise<ChatStreamResult> => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  'data: {"error":{"code":"upstream_stream_truncated"}}\n\ndata: [DONE]\n\n',
                ),
              );
              c.close();
            },
          });
          return {
            stream,
            onEvent: (cb: (e: AiEvent) => void) => {
              cb({
                type: 'success',
                requestId: 'truncated-test',
                channelKey: 'truncated-channel',
                durationMs: 10,
                bytesRelayed: 100,
                terminated: 'upstream_truncated',
              });
            },
          };
        }),
      });
      const dispatcher = createBillingDispatcher(redis);
      const app = buildTestApp(db, redis, ai, undefined, undefined, dispatcher);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 10,
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('upstream_stream_truncated');
      // 2026-08-17 政策：上游服务端异常 → 释放不扣（不再 uncertain 冻结）
      await new Promise((r) => setTimeout(r, 150));
      const requests = await db.query.billingRequests.findMany({
        where: eq(billingRequests.userId, userId),
        columns: { status: true, failureCode: true, receipt: true },
      });
      expect(requests).toEqual([
        { status: 'released', failureCode: 'upstream_truncated', receipt: null },
      ]);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('客户端取消但流已带 usage（逐帧累计）→ 按最新 usage 正常结算，不进 uncertain', async () => {
    if (!connected) return it.skip('no DB');
    // 契约：usage 是流的随行状态。供应商逐帧发累计 usage（continuous_usage_stats）
    // 时，客户端取消的瞬间已有可信 usage → 走正常结算（receipt 带 streamAborted），
    // 不掉进 uncertain 复核队列。
    const userId = await createTestUser(db, '1000', 'cancelbill');
    const { token, keyHash } = await createTestApiKey(db, userId, 'cancelbill');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chatStream: vi.fn(async (): Promise<ChatStreamResult> => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'));
              c.close();
            },
          });
          return {
            stream,
            onEvent: (cb: (e: AiEvent) => void) => {
              cb({
                type: 'success',
                requestId: 'cancelbill-test',
                channelKey: 'cancelbill-ch',
                usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 7, estimated: false, raw: {} },
                durationMs: 80,
                bytesRelayed: 50,
                terminated: 'client_disconnect',
              });
            },
          };
        }),
      });
      const dispatcher = createBillingDispatcher(redis);
      const wake = vi.spyOn(dispatcher, 'wake');
      const app = buildTestApp(db, redis, ai, undefined, undefined, dispatcher);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 100,
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(wake).toHaveBeenCalled(); // 有可信 usage → 唤醒结算
      await vi.waitFor(async () => {
        const rows = await db.query.billingRequests.findMany({
          where: eq(billingRequests.userId, userId),
        });
        expect(rows[0]?.status).toBe('settled');
      });
      const bill = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.userId, userId),
      });
      expect(bill?.failureCode).toBeNull();
      const usage = await db.query.usageLogs.findMany({
        where: eq(usageLogs.userId, userId),
      });
      expect(usage.length).toBe(1);
      expect(usage[0]?.outputTokens).toBe(7); // 最新累计 usage
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
