import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { users, admins } from '@ai-gateway/db/schema';
import { adminAuthMiddleware, hashPassword, signSession, ADMIN_SESSION_COOKIE, type AdminEnv } from '@ai-gateway/identity';
import { errorHandler, loadRootEnvFile } from '@ai-gateway/http';
import { userAdminRoutes } from '../users.js';
import { makeServices } from '../../test/helpers.js';

/**
 * BUG 回归（中危 / 凭据泄露）：PATCH /api/admin/users/:id 不得返回 passwordHash。
 *
 * 防线：所有返回用户数据的查询必须走 services/users.userProfileColumns 显式白名单，
 * 杜绝 .returning() 无参整行（含 password_hash）泄露进响应体。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
const SECRET = 'test-jwt-secret-0123456789';

let connected = false;
beforeAll(async () => {
  try {
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

/** 建一个管理员（admins 表，物理隔离）用于签发会话 + 一个普通用户作为 PATCH 目标 */
async function seedAdminAndTarget(): Promise<{ adminId: number; targetId: number; adminCookie: string }> {
  const stamp = Date.now();
  const adminHash = await hashPassword('AdminPass1');
  const [admin] = await db.insert(admins).values({
    email: `bug-admin-${stamp}@test.local`,
    displayName: `bug-admin-${stamp}`,
    passwordHash: adminHash,
    status: 0,
  }).returning();
  const targetHash = await hashPassword('TargetPass1');
  const [target] = await db.insert(users).values({
    issuer: 'local',
    subject: `bug-target-${stamp}`,
    identityProvider: 'local',
    displayName: `bug-target-${stamp}`,
    status: 0,
    passwordHash: targetHash,
  }).returning();
  const token = await signSession({ type: 'admin', id: admin!.id }, SECRET);
  return { adminId: admin!.id, targetId: target!.id, adminCookie: token };
}

async function cleanup(...ids: number[]): Promise<void> {
  for (const id of ids) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
    await db.delete(admins).where(eq(admins.id, id)).catch(() => {});
  }
}

describe('PATCH /api/admin/users/:id 不应泄露 passwordHash', () => {
  it('响应体不含 passwordHash', async () => {
    if (!connected) return it.skip('no DB');
    const { adminId, targetId, adminCookie } = await seedAdminAndTarget();
    try {
      const app = new Hono();
      app.onError(errorHandler());
      const admin = new Hono<AdminEnv>();
      admin.use('*', adminAuthMiddleware(db, SECRET));
      admin.route('/users', userAdminRoutes(makeServices(db)));
      app.route('/api/admin', admin);

      const res = await app.request(`/api/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: `${ADMIN_SESSION_COOKIE}=${adminCookie}`,
        },
        body: JSON.stringify({ displayName: 'changed-by-admin' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // 关键断言：密码哈希绝不能出现在响应里
      expect(body.passwordHash, 'PATCH 响应泄露了 passwordHash').toBeUndefined();
      expect(body.password_hash, 'PATCH 响应泄露了 password_hash（snake_case）').toBeUndefined();
      // scrypt 哈希格式为 "salt:hash:N:r:p"（含多个冒号）
      const serialized = JSON.stringify(body);
      expect(serialized, '响应里不应出现 scrypt 哈希格式串').not.toMatch(/[0-9a-f]+:[0-9a-f]+:\d+:\d+:\d+/);
    } finally {
      await cleanup(adminId, targetId);
    }
  });
});
