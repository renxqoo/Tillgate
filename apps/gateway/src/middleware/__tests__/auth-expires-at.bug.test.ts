import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '@ai-gateway/db';
import type { AuthEnv } from '../auth.js';

/**
 * 注意：auth.ts 经由 `../index.js` 间接 import 了在模块加载时执行 loadGatewayEnv() 的 env。
 * 必须在任何 import 链触及 auth.ts 之前，把 JWT_SECRET / ENCRYPTION_KEY 设进 process.env。
 * 因此本文件先同步读 .env 并补齐缺失项，再动态 import auth 相关模块。
 */

const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFileIntoProcess(): void {
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnvFileIntoProcess();
// C4 测试聚焦鉴权，不需要真实生产密钥；强制用强测试值覆盖 .env 里的弱密钥
// （B3 修复后 config 拒绝 change-me-* 等占位值）。DATABASE_URL/REDIS_URL 仍从 .env 读。
process.env.JWT_SECRET = 'test-jwt-7f3a9b2e5c1d4a8f6e0b';
process.env.ENCRYPTION_KEY = 'test-enc-9a4f2c7d8b1e5a3f6c0d4b2e8a7f1c9d';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';

const { Redis } = await import('ioredis');
const { eq } = await import('drizzle-orm');
const { Hono } = await import('hono');
const { createDb } = await import('@ai-gateway/db');
const dbSchema = await import('@ai-gateway/db/schema');
const users = dbSchema.users;
const apiKeys = dbSchema.apiKeys;
const authMod = await import('../auth.js');
const authMiddleware = authMod.authMiddleware;
const { AuthService } = await import('../../services/auth/auth-service.js');

/**
 * TDD 复现测试 —— api_keys.expires_at 从未被强制执行（C4）。
 *
 * 需要真实 Postgres + Redis。当前应 FAIL：过期的 Key 仍能通过鉴权。
 * 修复后应通过：过期 Key → 401。
 *
 * 背景：auth.ts 的 DB loader 只按 keyHash 查 api_keys，不带 expires_at 条件；
 *       CachedKeyAuth 也不携带 expiresAt，缓存层无法做过期判定。
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const db: Db = createDb(DATABASE_URL);
const redis = new Redis(REDIS_URL, {
  retryStrategy: () => null,
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

let connected = false;
beforeAll(async () => {
  try {
    await redis.connect();
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

async function createUser(): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: 'expires-bug-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      identityProvider: 'local',
      displayName: 'Expires Test',
      balance: '1000',
    })
    .returning();
  return u!.id;
}

async function createApiKey(
  userId: number,
  expiresAt: Date | null,
): Promise<{ token: string; keyHash: string }> {
  // 生成与 auth.ts 一致格式的静态 Key：ag_<random>
  const token = 'ag_' + randomUUID().replace(/-/g, '');
  const keyHash = createHash('sha256').update(token).digest('hex');
  await db.insert(apiKeys).values({
    keyHash,
    keyPreview: 'ag_****' + token.slice(-4),
    userId,
    name: 'expires-bug-test',
    status: 0,
    expiresAt,
  });
  return { token, keyHash };
}

async function cleanup(userId: number, keyHash: string): Promise<void> {
  await db.delete(apiKeys).where(eq(apiKeys.keyHash, keyHash));
  await db.delete(users).where(eq(users.id, userId));
  await redis.del('auth:key:' + keyHash);
}

function makeApp() {
  const app = new Hono<AuthEnv>();
  app.use('/v1/*', authMiddleware(new AuthService(db, redis, process.env.JWT_SECRET!)));
  app.get('/v1/echo', (c) => c.json({ ok: true, userId: c.var.auth?.userId }));
  return app;
}

describe('C4 — api_keys.expires_at 从未强制执行（TDD 复现，当前应 FAIL）', () => {
  it('过期 Key（expires_at < now）应被拒绝 → 401', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createUser();
    const { token, keyHash } = await createApiKey(userId, new Date(Date.now() - 60_000)); // 1 分钟前过期
    try {
      const app = makeApp();
      const res = await app.request('/v1/echo', {
        headers: { authorization: `Bearer ${token}` },
      });
      // 期望：过期 Key 被拒绝
      expect(res.status).toBe(401); // 当前实现返回 200（鉴权通过）→ FAIL
    } finally {
      await cleanup(userId, keyHash);
    }
  });

  it('未过期 Key（expires_at > now）正常通过（对照组）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createUser();
    const { token, keyHash } = await createApiKey(userId, new Date(Date.now() + 86_400_000)); // 1 天后过期
    try {
      const app = makeApp();
      const res = await app.request('/v1/echo', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200); // 对照组：未过期应通过
    } finally {
      await cleanup(userId, keyHash);
    }
  });

  it('无过期时间（expires_at IS NULL）正常通过（对照组）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createUser();
    const { token, keyHash } = await createApiKey(userId, null); // 永不过期
    try {
      const app = makeApp();
      const res = await app.request('/v1/echo', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await cleanup(userId, keyHash);
    }
  });
});
