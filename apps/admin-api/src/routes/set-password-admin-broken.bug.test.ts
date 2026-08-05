import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { users, rateCards, rateCardCoefficients } from '@ai-gateway/db/schema';
import { authRoutes } from './auth.js';
import { adminAuthMiddleware } from '../middleware/admin-auth.js';
import { resolveSession } from '../middleware/session.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signSession } from '../lib/session.js';

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

/**
 * BUG 复现（鉴权断链）：POST /api/admin/users/:id/set-password 对所有管理员永远 403。
 *
 * 该 handler（auth.ts:217）内部检查 `c.get('session')`，但 `session` 仅由
 * userSessionMiddleware 设置，而它只挂 /api/me/*、/api/keys/* 等，未挂 /api/admin/*。
 * /api/admin/* 走 adminAuthMiddleware（通过）+ adminIdInjector（只设 adminId，不设 session）。
 * 所以 c.get('session') 恒为 undefined → handler 永远 403 → 管理员无法用此接口设密码（死路由）。
 *
 * 本测试用真实 DB + 完整中间件链（adminAuthMiddleware + adminIdInjector，与 index.ts 同款），
 * 验证管理员 set-password 应成功（修复前红：403；修复后绿：200 且密码真的被改）。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const db: Db = createDb(DATABASE_URL);
const SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-0123456789';

/** 复刻 index.ts 的 adminIdInjector：resolveSession 后注入 adminId（仅管理员） */
function adminIdInjectorForTest(): MiddlewareHandler {
  return async (c, next) => {
    const session = await resolveSession(c, db, SECRET).catch(() => null);
    if (session && session.role === 1) c.set('adminId', session.userId);
    await next();
  };
}

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
  const coeff = await db.select({ id: rateCardCoefficients.id })
    .from(rateCardCoefficients)
    .where(eq(rateCardCoefficients.rateCardId, cardId))
    .limit(1);
  if (coeff.length === 0) {
    await db.insert(rateCardCoefficients).values({ rateCardId: cardId, scope: 'global', coefficient: '1.000' });
  }
  return cardId;
}

/** 组装真实生产中间件链（与 index.ts 同款：adminAuthMiddleware + adminIdInjector） */
function makeProdApp(): Hono {
  const app = new Hono();
  app.use('/api/admin/*', adminAuthMiddleware(db, SECRET));
  app.use('/api/admin/*', adminIdInjectorForTest());
  app.route('/', authRoutes(db, { jwtSecret: SECRET, giftAmount: 0, secureCookie: false }));
  return app;
}

describe('POST /api/admin/users/:id/set-password 管理员应能设密码（当前死路由 403）', () => {
  it('管理员会话 → set-password 成功，密码真被修改', async () => {
    if (!connected) return it.skip('no DB');
    const cardId = await ensureStandardCard();
    const stamp = Date.now();
    const adminHash = await hashPassword('AdminPass1');
    const [admin] = await db.insert(users).values({
      issuer: 'local', subject: `spbug-admin-${stamp}`, identityProvider: 'local',
      displayName: `spbug-admin-${stamp}`, role: 1, status: 0, passwordHash: adminHash,
    }).returning();
    const targetInitHash = await hashPassword('InitPass1');
    const [target] = await db.insert(users).values({
      issuer: 'local', subject: `spbug-target-${stamp}`, identityProvider: 'local',
      displayName: `spbug-target-${stamp}`, role: 0, status: 0, passwordHash: targetInitHash,
    }).returning();
    try {
      const app = makeProdApp();
      const cookie = await signSession({ userId: admin!.id, role: 1 }, SECRET);
      const res = await app.request(`/api/admin/users/${target!.id}/set-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `ag_session=${cookie}` },
        body: JSON.stringify({ password: 'NewSecretPass1' }),
      });
      expect(res.status, '管理员 set-password 应返回 200，当前死路由返 403').toBe(200);

      // 验证密码真的被改（DB + verifyPassword）
      const updated = await db.select({ passwordHash: users.passwordHash, rateCardId: users.rateCardId })
        .from(users).where(eq(users.id, target!.id)).limit(1);
      expect(updated[0]!.rateCardId, '应自动绑定标准费率卡').toBe(cardId);
      const okNew = await verifyPassword('NewSecretPass1', updated[0]!.passwordHash);
      const okOld = await verifyPassword('InitPass1', updated[0]!.passwordHash);
      expect(okNew, '新密码应能校验通过').toBe(true);
      expect(okOld, '旧密码应失效').toBe(false);
    } finally {
      await db.delete(users).where(eq(users.id, target!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, admin!.id)).catch(() => {});
    }
  });
});
