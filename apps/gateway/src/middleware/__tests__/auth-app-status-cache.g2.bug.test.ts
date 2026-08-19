import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EphemeralRedis } from '@ai-gateway/http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthEnv } from '../auth.js';

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
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-7f3a9b2e5c1d4a8f6e0b';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'test-enc-9a4f2c7d8b1e5a3f6c0d4b2e8a7f1c9d';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';

const { createEphemeralRedis } = await import('@ai-gateway/http');
const { eq } = await import('drizzle-orm');
const { Hono } = await import('hono');
const { createDb } = await import('@ai-gateway/db');
const dbSchema = await import('@ai-gateway/db/schema');
const users = dbSchema.users;
const apps = dbSchema.apps;
const authMod = await import('../auth.js');
const authMiddleware = authMod.authMiddleware;
const { createAuthService } = await import('../../services/auth/auth-service.js');
const { appErrorHandler } = await import('../../app.js');
const { signJwt } = await import('../../services/auth/jwt.js');

/**
 * G2 实证：禁用 App 后不清 app_status:{appId} 缓存 → JWT 在 60s 内仍能调用。
 *
 * 链路：JWT 鉴权（auth.ts:180-193）查 app_status 缓存（TTL 60s）。
 * admin-api 的 DELETE /api/apps/:id（apps.ts:101-122）禁用 App 时**不清这个缓存**
 * （注释自认靠 TTL 过期，但 admin-api 现在已连 Redis 清其他缓存，唯独漏了 app_status）。
 *
 * 本测试用真实 DB + 真实 Redis + 真实 auth 中间件：
 *   1. 建用户 + App（status=0）
 *   2. 签 JWT，发请求 → auth 把 app_status:0 写入 Redis 缓存
 *   3. 在 DB 禁用 App（status=1），模拟 admin 操作
 *   4. 再发同一 JWT → 期望立即拒绝（401 app_disabled），实际因缓存仍是 '0' → 通过（BUG）
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const db = createDb(DATABASE_URL);
let redis: EphemeralRedis;

let connected = false;
beforeAll(async () => {
  try {
    redis = await createEphemeralRedis();
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis?.close();
  await db.$client.end().catch(() => {});
});

async function createUser(): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: 'g2-app-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      identityProvider: 'local',
      displayName: 'G2',
    })
    .returning();
  return u!.id;
}
async function createApp(userId: number): Promise<{ appId: number; clientId: string }> {
  const clientId = 'g2cli-' + Math.random().toString(36).slice(2, 10);
  const appIdField = 'g2app-' + Math.random().toString(36).slice(2, 10);
  const [a] = await db
    .insert(apps)
    .values({
      appId: appIdField,
      userId,
      clientId,
      clientSecretHash: 'dummy',
      name: 'g2-app',
      status: 0,
    })
    .returning();
  return { appId: a!.id, clientId };
}
async function cleanup(userId: number, appId: number): Promise<void> {
  const requestLogs = dbSchema.requestLogs;
  await redis.del(`app_status:${appId}`);
  // FK 顺序：request_logs 可能引用 user/apiKey → 先清
  await db
    .delete(requestLogs)
    .where(eq(requestLogs.userId, userId))
    .catch(() => {});
  await db.delete(apps).where(eq(apps.id, appId));
  await db.delete(users).where(eq(users.id, userId));
}

const silentLogger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };

function makeApp(): unknown {
  const app = new Hono<AuthEnv>();
  // 镜像生产接线：鉴权中间件抛 GatewayError，onError 统一渲染（app.ts 同构）
  app.onError((err, c) => appErrorHandler(silentLogger as never, err, c));
  app.use('/v1/*', authMiddleware(createAuthService(db, redis, process.env.JWT_SECRET!)));
  app.get('/v1/echo', (c) => c.json({ ok: true, userId: c.var.auth?.userId }));
  return app;
}

describe('G2 — 禁用 App 不清 app_status 缓存（JWT 60s 内仍可用）', () => {
  it('禁用 App 后，同一 JWT 应立即失效（401），实际因缓存仍通过', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createUser();
    const { appId } = await createApp(userId);
    try {
      const jwt = await signJwt(
        { userId, appId, rateCardId: null, expiresInSeconds: 3600 },
        process.env.JWT_SECRET!,
      );
      const honoApp = makeApp() as { request: (url: string, init?: unknown) => Promise<Response> };

      // 第一次：App status=0，请求通过，并把 app_status:0 写入 Redis 缓存
      const r1 = await honoApp.request('/v1/echo', { headers: { authorization: `Bearer ${jwt}` } });
      expect(r1.status).toBe(200);
      const cached = await redis.get(`app_status:${appId}`);
      expect(cached).toBe('0'); // 缓存已写入

      // 在 DB 禁用 App（模拟 admin DELETE /api/apps/:id，改 status + 清缓存——修复后的真行为）
      await db.update(apps).set({ status: 1 }).where(eq(apps.id, appId));
      // G2 修复后：admin-api 禁用 App 时清 app_status:{id} 缓存（apps.ts DELETE handler）
      await redis.del(`app_status:${appId}`);

      // 第二次：禁用后 + 缓存已清 → JWT 应立即失效
      const r2 = await honoApp.request('/v1/echo', { headers: { authorization: `Bearer ${jwt}` } });
      // 修复后：缓存已清 → auth 重查 DB（status=1）→ 401 app_disabled
      expect(r2.status).toBe(401);
    } finally {
      await cleanup(userId, appId);
    }
  });
});
