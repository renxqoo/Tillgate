import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { userAdminRoutes } from '../users.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * GET /api/admin/users?enterprise=1|0：企业/个人筛选（闭环：管理员能一眼筛出「哪个用户是企业」）。
 * 覆盖 enterprise 参数同时与 q 搜索组合（精确到本测试创建的两条数据，避免污染既有用户）。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });

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

describe('GET /api/admin/users?enterprise=', () => {
  it('enterprise=1 只返回企业用户，enterprise=0 只返回个人用户', async () => {
    if (!connected) return it.skip('no DB');
    const stamp = `ent-${Date.now()}`;
    const [enterprise] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `${stamp}-corp`, identityProvider: 'local', isEnterprise: true })
      .returning();
    const [personal] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `${stamp}-person`, identityProvider: 'local', isEnterprise: false })
      .returning();
    try {
      const app = makeAdminTestApp({ '/users': userAdminRoutes(makeServices(db)) });
      const corpRes = await app.request(`/api/admin/users?q=${stamp}&enterprise=1`);
      const personRes = await app.request(`/api/admin/users?q=${stamp}&enterprise=0`);
      expect(corpRes.status).toBe(200);
      expect(personRes.status).toBe(200);
      const corpBody = (await corpRes.json()) as { list: Array<{ subject: string }> };
      const personBody = (await personRes.json()) as { list: Array<{ subject: string }> };
      const corpSubjects = corpBody.list.map((u) => u.subject);
      const personSubjects = personBody.list.map((u) => u.subject);
      expect(corpSubjects).toContain(`${stamp}-corp`);
      expect(corpSubjects).not.toContain(`${stamp}-person`);
      expect(personSubjects).toContain(`${stamp}-person`);
      expect(personSubjects).not.toContain(`${stamp}-corp`);
    } finally {
      await db.delete(users).where(eq(users.id, enterprise!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, personal!.id)).catch(() => {});
    }
  });
});
