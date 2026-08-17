import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apps, users } from '@ai-gateway/db/schema';
import { signJwt } from '../../services/auth/jwt.js';
import { createAuthService } from '../../services/auth/auth-service.js';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  createTestUser,
} from '../../testing/helpers.js';

/**
 * 04 修复回归测试 —— JWT（App）路径必须加载每用户 rpm/tpm 限流。
 *
 * 修复前 authenticateJwt 置 userRpmLimit/userTpmLimit=null，管线退回 DEFAULT_USER_RPM=60，
 * 管理员给用户设的更严格限流被 JWT 静默绕过。修复后 JWT 与静态 Key 对称，从 users 表
 * 加载 rpmLimit/tpmLimit（60s 缓存）。
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

describe('04 — JWT 鉴权加载每用户 rpm/tpm 限流', () => {
  it('JWT 鉴权结果携带 DB 里的 userRpmLimit / userTpmLimit（与静态 Key 对称）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'jwt-rpm');
    const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const [a] = await db
      .insert(apps)
      .values({
        appId: 'app-' + suffix,
        userId,
        clientId: 'cli-' + suffix,
        clientSecretHash: createHash('sha256').update('test-secret').digest('hex'),
        name: 'jwt-rpm-test',
        status: 0,
      })
      .returning();
    try {
      await db.update(users).set({ rpmLimit: 1, tpmLimit: 2 }).where(eq(users.id, userId));
      await redis.del(`user_profile:${userId}`);

      const token = await signJwt({ userId, appId: a!.id, rateCardId: null }, process.env.JWT_SECRET!);
      const result = await createAuthService(db, redis, process.env.JWT_SECRET!).authenticate(
        `Bearer ${token}`,
        '127.0.0.1',
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.auth.userRpmLimit).toBe(1);
        expect(result.auth.userTpmLimit).toBe(2);
        expect(result.auth.credentialType).toBe('jwt');
      }
    } finally {
      await redis.del(`user_profile:${userId}`).catch(() => {});
      await db.delete(apps).where(eq(apps.id, a!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, userId)).catch(() => {});
    }
  });

  it('未设置每用户限流（NULL）→ userRpmLimit/userTpmLimit 为 null（退回全局默认，不改语义）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'jwt-rpm-null');
    const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const [a] = await db
      .insert(apps)
      .values({
        appId: 'app-' + suffix,
        userId,
        clientId: 'cli-' + suffix,
        clientSecretHash: createHash('sha256').update('test-secret').digest('hex'),
        name: 'jwt-rpm-null-test',
        status: 0,
      })
      .returning();
    try {
      await redis.del(`user_profile:${userId}`);
      const token = await signJwt({ userId, appId: a!.id, rateCardId: null }, process.env.JWT_SECRET!);
      const result = await createAuthService(db, redis, process.env.JWT_SECRET!).authenticate(
        `Bearer ${token}`,
        '127.0.0.1',
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.auth.userRpmLimit).toBeNull();
        expect(result.auth.userTpmLimit).toBeNull();
      }
    } finally {
      await redis.del(`user_profile:${userId}`).catch(() => {});
      await db.delete(apps).where(eq(apps.id, a!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, userId)).catch(() => {});
    }
  });
});
