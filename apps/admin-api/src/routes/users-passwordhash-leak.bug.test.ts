import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { users } from '@ai-gateway/db/schema';
import { userAdminRoutes } from './users.js';
import { adminAuthMiddleware } from '../middleware/admin-auth.js';
import { hashPassword } from '../lib/password.js';
import { signSession } from '../lib/session.js';

/**
 * BUG 复现（中危 / 凭据泄露）：PATCH /api/admin/users/:id 返回了 passwordHash。
 *
 * users.ts:164 用 `.returning()` 无列参数 → drizzle 返回整行（含 password_hash），
 * line 184 直接 `c.json(updated)` 把密码哈希泄露进响应体。
 * 同文件 GET handler（106-130）特意逐列手选并省略 passwordHash，证明这是遗漏。
 *
 * 本测试：创建一个有 passwordHash 的真实用户，以管理员会话 PATCH 它，
 * 断言响应体不应包含 passwordHash（修复前红；修复后绿）。
 */

const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(): void {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
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
loadEnvFile();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const db: Db = createDb(DATABASE_URL);
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

/** 建一个管理员（role=1）用于签发会话 + 一个普通用户作为 PATCH 目标 */
async function seedAdminAndTarget(): Promise<{ adminId: number; targetId: number; adminCookie: string }> {
  const stamp = Date.now();
  const adminHash = await hashPassword('AdminPass1');
  const [admin] = await db.insert(users).values({
    issuer: 'local',
    subject: `bug-admin-${stamp}`,
    identityProvider: 'local',
    displayName: `bug-admin-${stamp}`,
    role: 1,
    status: 0,
    passwordHash: adminHash,
  }).returning();
  const targetHash = await hashPassword('TargetPass1');
  const [target] = await db.insert(users).values({
    issuer: 'local',
    subject: `bug-target-${stamp}`,
    identityProvider: 'local',
    displayName: `bug-target-${stamp}`,
    role: 0,
    status: 0,
    passwordHash: targetHash,
  }).returning();
  const token = await signSession({ userId: admin!.id, role: 1 }, SECRET);
  return { adminId: admin!.id, targetId: target!.id, adminCookie: token };
}

async function cleanup(...ids: number[]): Promise<void> {
  for (const id of ids) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
}

describe('PATCH /api/admin/users/:id 不应泄露 passwordHash', () => {
  it('响应体不含 passwordHash（修复后绿）', async () => {
    if (!connected) return it.skip('no DB');
    const { adminId, targetId, adminCookie } = await seedAdminAndTarget();
    try {
      const app = new Hono();
      app.use('/api/admin/*', adminAuthMiddleware(db, SECRET));
      app.route('/', userAdminRoutes(db));

      const res = await app.request(`/api/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: `ag_session=${adminCookie}`,
        },
        body: JSON.stringify({ displayName: 'changed-by-admin' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // 关键断言：密码哈希绝不能出现在响应里
      expect(body.passwordHash, 'PATCH 响应泄露了 passwordHash').toBeUndefined();
      expect(body.password_hash, 'PATCH 响应泄露了 password_hash（snake_case）').toBeUndefined();
      // scrypt 哈希格式为 "salt:hash:N:r:p"（含多个冒号）；改 displayName 的正常响应不应出现哈希
      const serialized = JSON.stringify(body);
      expect(serialized, '响应里不应出现 scrypt 哈希格式串').not.toMatch(/[0-9a-f]+:[0-9a-f]+:\d+:\d+:\d+/);
    } finally {
      await cleanup(adminId, targetId);
    }
  });
});
