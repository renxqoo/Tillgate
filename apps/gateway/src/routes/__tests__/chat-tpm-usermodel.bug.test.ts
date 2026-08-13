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

/**
 * G-RL 回归：TPM user 维度按模型拆（user:${id}:model:${mappingId}）。
 *
 * 背景：原实现 TPM 维度为 user:${id}（跨模型聚合），同用户并发调两个不同模型时
 *   token 合并计入同一桶 → 撞顶 → 两个模型同时 429。
 * 修复：拆成 user:${id}:model:${mappingId}，每个模型独立享有 TPM 预算。
 *
 * 本测试：预置 user:model TPM 桶超限，发 chat 请求 → 应 429 且 dimension 指向
 *   user:${userId}:model:${mappingId}（而非旧的 user:${userId}）。
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

describe('G-RL — TPM user 维度按模型拆（user:id:model:mappingId）', () => {
  it('预置 user:model TPM 桶超限 → 429，dimension 指向 user:id:model:mappingId', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'rl');
    const { token, keyHash } = await createTestApiKey(db, userId, 'rl');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    const minute = Math.floor(Date.now() / 60_000);
    const tpmKey = `{tpm}:actual:${minute}:user:${userId}:model:${ids.mappingId}`;
    try {
      // 预置 user:model 桶超过 DEFAULT_USER_TPM(1000000)
      await redis.set(tpmKey, '1000001');

      // mock Ai：TPM 限流在调用上游前，chat 不应被调用
      const ai = makeMockAi({
        chat: vi.fn(() => {
          throw new Error('should not reach upstream — TPM should block first');
        }),
      });

      const honoApp = buildTestApp(db, redis, ai);

      const res = await honoApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hello world' }],
        }),
      });

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('rate_limit_exceeded');
      // 关键：dimension 是拆分后的 user:${userId}:model:${mappingId}，不是旧的 user:${userId}
      expect(body.error.message).toContain(`user:${userId}:model:${ids.mappingId}`);
      // 上游未被调用（限流在调用前生效）
      expect(ai.chat).not.toHaveBeenCalled();
    } finally {
      await redis.del(tpmKey, `rl:{rpm}:user:${userId}`, `rl:{rpm}:global`).catch(() => {});
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
