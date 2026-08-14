import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UpstreamError } from '@ai-gateway/ai';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  createTestUser,
  createTestApiKey,
  cleanupTestData,
  buildTestApp,
  makeMockAi,
  encrypt,
} from '../../testing/helpers.js';
import { channels, modelChannels, modelMappings, providers } from '@ai-gateway/db/schema';

/**
 * 回归：embeddings 死凭据渠道应换下一个渠道（与 chat 同管线，杜绝两路由漂移）。
 *
 * 旧 bug：embeddings 缺死凭据换渠道判定，单个坏渠道让 embeddings 整体不可用。
 * 本测试：模型绑两个渠道，mock ai.chat 第 1 次返回 invalid_api_key、第 2 次成功，
 * 断言应换渠道并返回 200。
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

function deadCredError(): UpstreamError {
  const err = new Error('invalid api key') as UpstreamError;
  err.status = 401;
  err.code = 'invalid_api_key';
  err.retryable = false;
  err.circuitTrip = false;
  err.deadCredential = true;
  return err;
}

/** 模型绑两个渠道（候选循环才有「换渠道」可言） */
async function setupModelWithTwoChannels(encryptionKey: string) {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const externalModel = 'emb-dead-model-' + suffix;
  const realModel = externalModel + '-real';
  const [prov] = await db
    .insert(providers)
    .values({
      name: 'emb-dead-prov-' + suffix,
      protocol: 'openai_compatible',
      baseUrl: 'http://localhost:9999',
      status: 0,
    })
    .returning();
  const [ch1] = await db
    .insert(channels)
    .values({
      name: 'emb-dead-ch1-' + suffix,
      providerId: prov!.id,
      apiKeyEnc: encrypt('sk-dead', encryptionKey),
      status: 0,
      upstreamBudget: '1000000',
    })
    .returning();
  const [ch2] = await db
    .insert(channels)
    .values({
      name: 'emb-dead-ch2-' + suffix,
      providerId: prov!.id,
      apiKeyEnc: encrypt('sk-good', encryptionKey),
      status: 0,
      upstreamBudget: '1000000',
    })
    .returning();
  const [m] = await db
    .insert(modelMappings)
    .values({
      externalName: externalModel,
      realModel,
      status: 0,
      inputPrice: '1000',
      outputPrice: '0',
      cacheInputPrice: '100',
    })
    .returning();
  await db.insert(modelChannels).values([
    { mappingId: m!.id, channelId: ch1!.id, priority: 0, weight: 1 },
    { mappingId: m!.id, channelId: ch2!.id, priority: 0, weight: 1 },
  ]);
  return {
    externalModel,
    channelId1: ch1!.id,
    channelId2: ch2!.id,
    providerId: prov!.id,
    mappingId: m!.id,
  };
}

describe('embeddings 死凭据渠道换下一个渠道', () => {
  it('渠道1 invalid_api_key → 换渠道2 → 200', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'embdead');
    const { token, keyHash } = await createTestApiKey(db, userId, 'embdead');
    const ids = await setupModelWithTwoChannels(process.env.ENCRYPTION_KEY!);
    try {
      // mock ai.chat：第 1 次返回 invalid_api_key（可换渠道），第 2 次成功
      let calls = 0;
      const ai = makeMockAi({
        chat: vi.fn(async () => {
          calls += 1;
          if (calls === 1) {
            return { status: 'error' as const, error: deadCredError(), durationMs: 5 };
          }
          return {
            status: 'success' as const,
            usage: {
              inputTokens: 5,
              cachedInputTokens: 0,
              outputTokens: 0,
              estimated: false,
              raw: {},
            },
            body: {
              object: 'list',
              data: [{ embedding: [0.1], index: 0 }],
              model: ids.externalModel,
              usage: { prompt_tokens: 5, total_tokens: 5 },
            },
            durationMs: 5,
          };
        }),
      });

      const honoApp = buildTestApp(db, redis, ai);
      const res = await honoApp.request('/v1/embeddings', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, input: 'hello' }),
      });

      expect(res.status).toBe(200); // 换渠道后成功
      expect(calls).toBe(2); // 渠道1 失败 → 渠道2 重试
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
