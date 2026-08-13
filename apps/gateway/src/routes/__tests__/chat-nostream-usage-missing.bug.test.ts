import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { eq } from 'drizzle-orm';
import { billingRequests } from '@ai-gateway/db/schema';

/**
 * 金额正确性回归：供应商没有可信 usage 时禁止估算扣费，保留预扣等待审计。
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

describe('非流式 success 但 usage=undefined → uncertain', () => {
  it('不唤醒结算且冻结预扣', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'nostream');
    const { token, keyHash } = await createTestApiKey(db, userId, 'nostream');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chat: vi.fn(async () => ({
          status: 'success' as const,
          // 关键：usage=undefined（上游没返回 usage 字段，且 estimateUsage 算不出）
          usage: undefined,
          body: {
            id: 'mock',
            object: 'chat.completion',
            choices: [{ message: { role: 'assistant', content: 'hi' } }],
          },
          durationMs: 10,
        })),
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
          stream: false,
        }),
      });

      // 请求成功（200）= 上游已执行，平台已付钱
      expect(res.status).toBe(200);
      expect(wakeCalled).toBe(false);
      const billing = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.userId, userId),
      });
      expect(billing).toMatchObject({
        status: 'uncertain',
        failureCode: 'nonstream_completed_without_usage',
        receipt: null,
      });
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
