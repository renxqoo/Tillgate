import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { billingRequests } from '@ai-gateway/db/schema';
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
} from '../../testing/helpers.js';
import { BillingDispatcher } from '../../services/billing/billing-dispatcher.js';

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

describe('G1 — 流式 success 无 usage + bytesRelayed=0 → uncertain', () => {
  it('不唤醒结算且冻结预扣', async () => {
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
      const dispatcher = new BillingDispatcher(redis);
      let wakeCalled = false;
      const origWake = dispatcher.wake.bind(dispatcher);
      dispatcher.wake = async (requestId) => {
        wakeCalled = true;
        return origWake(requestId);
      };

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
      expect(wakeCalled).toBe(false);
      const billing = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.userId, userId),
      });
      expect(billing).toMatchObject({
        status: 'uncertain',
        failureCode: 'stream_completed_without_usage',
        receipt: null,
      });
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('中断流无 usage → 不唤醒结算，billing request 保持 uncertain', async () => {
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
      const dispatcher = new BillingDispatcher(redis);
      const wake = vi.spyOn(dispatcher, 'wake');
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
      expect(wake).not.toHaveBeenCalled();
      const requests = await db.query.billingRequests.findMany({
        where: eq(billingRequests.userId, userId),
        columns: { status: true, receipt: true },
      });
      expect(requests).toEqual([{ status: 'uncertain', receipt: null }]);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
