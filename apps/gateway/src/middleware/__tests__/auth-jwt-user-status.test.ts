import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apps, users } from '@ai-gateway/db/schema';
import { signJwt } from '../../services/auth/jwt.js';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  createTestUser,
  setupTestModel,
  cleanupTestData,
  buildTestApp,
  makeMockAi,
} from '../../testing/helpers.js';

/**
 * JWT 路径用户状态检查（与静态 Key 对称）：
 * 用户被封禁后，已签发的 JWT 应立即失效（而非等 2 小时过期）。
 * Redis 缓存 user_profile:{userId} 60s，测试间清缓存。
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

async function setupJwtUser(
  status: number,
): Promise<{ userId: number; appId: number; token: string; model: { externalModel: string } }> {
  const userId = await createTestUser(db, '1000', 'jwtuser');
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [a] = await db
    .insert(apps)
    .values({
      appId: 'app-' + suffix,
      userId,
      clientId: 'cli-' + suffix,
      clientSecretHash: createHash('sha256').update('test-secret').digest('hex'),
      name: 'jwt-test',
      status: 0,
    })
    .returning();
  // 直接签 JWT（OAuth 签发路径由 oauth 测试覆盖）
  const token = await signJwt({ userId, appId: a!.id, rateCardId: null }, process.env.JWT_SECRET!);
  await db.update(users).set({ status }).where(eq(users.id, userId));
  const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
  return { userId, appId: a!.id, token, model: ids };
}

describe('JWT 路径用户状态检查', () => {
  it('被封禁用户（status=1）的 JWT 立即失效 → 401 user_disabled', async () => {
    if (!connected) return it.skip('no DB');
    const { userId, appId, token, model } = await setupJwtUser(1);
    try {
      await redis.del(`user_profile:${userId}`);
      const ai = makeMockAi({
        chat: vi.fn(async () => ({
          status: 'success' as const,
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            estimated: false,
            raw: {},
          },
          body: { id: 'mock', object: 'chat.completion', choices: [] },
          durationMs: 5,
        })),
      });
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; type: string } };
      expect(body.error.code).toBe('user_disabled');
      expect(body.error.type).toBe('authentication_error');
      expect(ai.chat).not.toHaveBeenCalled();
    } finally {
      await redis.del(`user_profile:${userId}`).catch(() => {});
      await db
        .delete(apps)
        .where(eq(apps.id, appId))
        .catch(() => {});
      await cleanupTestData(db, redis, userId, null, model);
    }
  });

  it('正常用户（status=0）的 JWT 通过（对照组）', async () => {
    if (!connected) return it.skip('no DB');
    const { userId, appId, token, model } = await setupJwtUser(0);
    try {
      await redis.del(`user_profile:${userId}`);
      const ai = makeMockAi({
        chat: vi.fn(async () => ({
          status: 'success' as const,
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            estimated: false,
            raw: {},
          },
          body: { id: 'mock', object: 'chat.completion', choices: [] },
          durationMs: 5,
        })),
      });
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await redis.del(`user_profile:${userId}`).catch(() => {});
      await db
        .delete(apps)
        .where(eq(apps.id, appId))
        .catch(() => {});
      await cleanupTestData(db, redis, userId, null, model);
    }
  });
});
