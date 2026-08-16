import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { hashPassword } from '@ai-gateway/identity';
import { clientAuthRoutesPublic } from '../auth.js';
import { makeClientPublicApp, makeServices, makeTestConfig } from '../../test/helpers.js';

/**
 * C7 收口回归：登录/登出挂在公开组但必须过 CSRF 校验——
 * 跨站表单（evil origin）不得强制受害者「登入攻击者账号」或被登出；
 * 合法来源（面板自身 origin）与无头客户端（兼容期双缺失头）不受影响。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

describe('POST /api/auth/login CSRF（公开组）', () => {
  it('evil Origin → 403；受信 Origin → 放行（密码错 401，非 403）；无 Origin → 兼容放行', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const [u] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__csrf7_${s}`, identityProvider: 'local', email: `__csrf7_${s}@test.local`, passwordHash: await hashPassword('RightPass1') })
      .returning({ id: users.id });
    const cfg = makeTestConfig({ trustedOrigins: ['http://localhost:3000'] });
    const stubMailer = { async sendLoginCode() {} } as unknown as import('@ai-gateway/identity').Mailer;
    const app = makeClientPublicApp({ '/api/auth': clientAuthRoutesPublic(makeServices(db, { mailer: stubMailer }), cfg) });
    try {
      const evil = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ email: `__csrf7_${s}@test.local`, password: 'RightPass1' }),
      });
      expect(evil.status).toBe(403);

      const okOrigin = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: `__csrf7_${s}@test.local`, password: 'RightPass1' }),
      });
      expect(okOrigin.status).toBe(200);

      const noOrigin = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `__csrf7_${s}@test.local`, password: 'WrongPass1' }),
      });
      expect(noOrigin.status).toBe(401); // 兼容期：无头客户端照常走凭证校验
    } finally {
      await db.delete(users).where(eq(users.id, u!.id));
    }
  });
});
