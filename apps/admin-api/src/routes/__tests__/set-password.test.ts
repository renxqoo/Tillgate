import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { users, admins, rateCards, rateCardCoefficients } from '@ai-gateway/db/schema';
import { adminAuthMiddleware, hashPassword, verifyPassword, signSession, ADMIN_SESSION_COOKIE, type AdminEnv } from '@ai-gateway/identity';
import { errorHandler, loadRootEnvFile } from '@ai-gateway/http';
import { userAdminRoutes } from '../users.js';
import { makeServices } from '../../test/helpers.js';

/**
 * POST /api/admin/users/:id/set-password：管理员开通本地账号。
 * 回归保护：管理员会话（admins 表 + ag_admin_session）下 set-password 应成功，
 * 且自动绑定默认「标准」费率卡、密码真实生效。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
const SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-jwt-secret-0123456789';

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

async function ensureStandardCard(): Promise<number> {
  let card = await db.select({ id: rateCards.id }).from(rateCards).where(eq(rateCards.name, '标准')).limit(1);
  if (card.length === 0) {
    [card] = [await db.insert(rateCards).values({ name: '标准', description: '标准', status: 0 }).returning({ id: rateCards.id })];
  }
  const cardId = card[0]!.id;
  const coeff = await db
    .select({ id: rateCardCoefficients.id })
    .from(rateCardCoefficients)
    .where(eq(rateCardCoefficients.rateCardId, cardId))
    .limit(1);
  if (coeff.length === 0) {
    await db.insert(rateCardCoefficients).values({ rateCardId: cardId, scope: 'global', coefficient: '1.000' });
  }
  return cardId;
}

/** 组装真实鉴权链（与 createApp 同构：受保护子应用 + adminAuthMiddleware） */
function makeApp(): Hono {
  const app = new Hono();
  app.onError(errorHandler());
  const admin = new Hono<AdminEnv>();
  admin.use('*', adminAuthMiddleware(db, SECRET));
  admin.route('/users', userAdminRoutes(makeServices(db)));
  app.route('/api/admin', admin);
  return app;
}

describe('POST /api/admin/users/:id/set-password', () => {
  it('管理员会话 → set-password 成功，密码真被修改', async () => {
    if (!connected) return it.skip('no DB');
    const cardId = await ensureStandardCard();
    const stamp = Date.now();
    const adminHash = await hashPassword('AdminPass1');
    const [admin] = await db.insert(admins).values({
      email: `sp-admin-${stamp}@test.local`,
      displayName: `sp-admin-${stamp}`,
      passwordHash: adminHash,
      status: 0,
    }).returning();
    const targetInitHash = await hashPassword('InitPass1');
    const [target] = await db.insert(users).values({
      issuer: 'local', subject: `sp-target-${stamp}`, identityProvider: 'local',
      displayName: `sp-target-${stamp}`, status: 0, passwordHash: targetInitHash,
    }).returning();
    try {
      const app = makeApp();
      const cookie = await signSession({ type: 'admin', id: admin!.id }, SECRET);
      const res = await app.request(`/api/admin/users/${target!.id}/set-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${ADMIN_SESSION_COOKIE}=${cookie}` },
        body: JSON.stringify({ password: 'NewSecretPass1' }),
      });
      expect(res.status, '管理员 set-password 应返回 200').toBe(200);

      // 验证密码真的被改（DB + verifyPassword）
      const updated = await db.select({ passwordHash: users.passwordHash, rateCardId: users.rateCardId })
        .from(users).where(eq(users.id, target!.id)).limit(1);
      expect(updated[0]!.rateCardId, '应自动绑定标准费率卡').toBe(cardId);
      expect(await verifyPassword('NewSecretPass1', updated[0]!.passwordHash), '新密码应能校验通过').toBe(true);
      expect(await verifyPassword('InitPass1', updated[0]!.passwordHash), '旧密码应失效').toBe(false);
    } finally {
      // audit_logs.admin_id → admins.id 设置了 onDelete: set null，删 admins 行不触发 FK 报错
      await db.delete(users).where(eq(users.id, target!.id)).catch(() => {});
      await db.delete(admins).where(eq(admins.id, admin!.id)).catch(() => {});
    }
  });
});
