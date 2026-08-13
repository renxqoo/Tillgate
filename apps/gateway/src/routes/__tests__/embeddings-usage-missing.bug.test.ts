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
 * 金额正确性回归：embeddings 缺可信 usage 时不允许估算扣费。
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

describe('embeddings 非流式 success 无 usage → uncertain', () => {
  it('不唤醒结算且冻结预扣', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'emb');
    const { token, keyHash } = await createTestApiKey(db, userId, 'emb');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!, { outputPrice: '0' });
    try {
      const ai = makeMockAi({
        chat: vi.fn(async () => ({
          status: 'success' as const,
          usage: undefined, // 上游返回无 usage 字段
          body: {
            object: 'list',
            data: [{ embedding: [0.1, 0.2], index: 0 }],
            model: 'embed-mock',
            usage: { prompt_tokens: 0, total_tokens: 0 },
          },
          durationMs: 10,
        })),
      });

      const dispatcher = new BillingDispatcher(redis);
      let wakeCalled = false;
      const origWake = dispatcher.wake.bind(dispatcher);
      dispatcher.wake = async (requestId) => {
        wakeCalled = true;
        return origWake(requestId);
      };

      const honoApp = buildTestApp(db, redis, ai, undefined, undefined, dispatcher);
      const res = await honoApp.request('/v1/embeddings', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, input: 'hello world' }),
      });

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
