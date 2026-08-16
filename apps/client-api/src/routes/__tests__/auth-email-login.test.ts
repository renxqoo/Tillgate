import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb, type Db } from '@ai-gateway/db';
import { users, auditLogs, transactions } from '@ai-gateway/db/schema';
import { createEphemeralRedis, loadRootEnvFile, errorHandler, type EphemeralRedis } from '@ai-gateway/http';
import { hashPassword, type Mailer } from '@ai-gateway/identity';

import { clientAuthRoutesPublic } from '../auth.js';
import { makeServices } from '../../test/helpers.js';
import { makeTestConfig } from '../../test/helpers.js';

/**
 * 邮箱登录 + 强制邮箱验证码（本轮破坏性变更）：
 *   - 登录只收 email（username → 400）；邮箱+密码正确 → 不发会话，发 6 位码
 *   - /login/verify 验码通过才签发 ag_session；首登赠额/lastLogin 在验证后
 *   - fail-closed：SMTP 未配置 503；60s 重复发码 429；错 5 次作废
 *   - 防枚举：不存在邮箱与错误密码同文案 401
 * 数据纪律：eml- 前缀，finally 清理（含 Redis 冷却/挑战键）。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let redis: EphemeralRedis;

let connected = false;
beforeAll(async () => {
  try {
    redis = await createEphemeralRedis();
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis?.close();
  await db.$client.end().catch(() => {});
});

function stubMailer(): Mailer & { sent: Array<{ to: string; code: string }> } {
  const m = { sent: [] as Array<{ to: string; code: string }> };
  return Object.assign(m, {
    async sendLoginCode(to: string, code: string) {
      m.sent.push({ to, code });
    },
  }) as Mailer & { sent: Array<{ to: string; code: string }> };
}

function makeApp(mailer: Mailer | null) {
  const services = makeServices(db, { redis, mailer });
  const app = new Hono();
  app.onError(errorHandler());
  app.route('/api/auth', clientAuthRoutesPublic(services, makeTestConfig({ giftAmount: 1 })));
  return app;
}

let seq = 0;
async function createUser(): Promise<{ uid: number; email: string }> {
  const email = `eml-${Date.now()}-${seq++}@test.local`;
  const hash = await hashPassword('RightPass1');
  const [u] = await db
    .insert(users)
    .values({
      issuer: 'local',
      subject: `eml-${Date.now()}-${seq}`,
      identityProvider: 'local',
      email,
      displayName: 'eml 测试用户',
      balance: '0',
      passwordHash: hash,
    })
    .returning({ id: users.id });
  return { uid: u!.id, email };
}

async function cleanup(uid: number, email: string): Promise<void> {
  await db.delete(auditLogs).where(eq(auditLogs.adminId, uid));
  await db.delete(transactions).where(eq(transactions.userId, uid));
  await db.delete(users).where(eq(users.id, uid));
  // 冷却键以 userId 为 subject
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `logincode:*:${uid}`, 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
  cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `login:*:*${email}*`, 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

function loginReq(app: Hono, email: string, password: string) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

function verifyReq(app: Hono, challengeId: string, code: string) {
  return app.request('/api/auth/login/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code }),
  });
}

describe('C 端邮箱登录 + 强制邮箱验证码', () => {
  it('用户名字段被拒（只收 email）；密码正确不再直发会话，而是 twoFactorRequired', async (ctx) => {
    if (!connected) return ctx.skip();
    const { uid, email } = await createUser();
    const mailer = stubMailer();
    const app = makeApp(mailer);
    try {
      // username 字段 → 400（schema 收紧）
      const legacy = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'whatever', password: 'RightPass1' }),
      });
      expect(legacy.status).toBe(400);

      // 邮箱+密码正确 → 200 + challenge，无会话
      const res = await loginReq(app, email, 'RightPass1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { twoFactorRequired: boolean; challengeId: string };
      expect(body.twoFactorRequired).toBe(true);
      expect(body.challengeId).toBeTypeOf('string');
      expect(res.headers.getSetCookie().length).toBe(0);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe(email);
    } finally {
      await cleanup(uid, email);
    }
  });

  it('验码通过签发会话 + 首登赠额；错码 401、第 5 次作废 400；重放失败', async (ctx) => {
    if (!connected) return ctx.skip();
    const { uid, email } = await createUser();
    const mailer = stubMailer();
    const app = makeApp(mailer);
    try {
      const step1 = await loginReq(app, email, 'RightPass1');
      const b1 = (await step1.json()) as { challengeId: string };

      // 前 4 次错码 401
      for (let i = 0; i < 4; i++) {
        const wrong = await verifyReq(app, b1.challengeId, '000000');
        expect(wrong.status).toBe(401);
        expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('CODE_INVALID');
      }
      // 第 5 次错 → 作废 400
      const fifth = await verifyReq(app, b1.challengeId, '000000');
      expect(fifth.status).toBe(400);

      // 重新登录（清冷却）→ 正确码 → 会话 + 赠额
      await redis.del(`logincode:cool:user:${uid}`);
      const step2 = await loginReq(app, email, 'RightPass1');
      const b2 = (await step2.json()) as { challengeId: string };
      const ok = await verifyReq(app, b2.challengeId, mailer.sent[1]!.code);
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()) as { user: { id: number; email: string; gifted: boolean } };
      expect(okBody.user.id).toBe(uid);
      expect(okBody.user.email).toBe(email);
      expect(okBody.user.gifted).toBe(true);
      expect(ok.headers.getSetCookie().some((c) => c.startsWith('ag_session='))).toBe(true);

      // 挑战一次性：重放失败
      const replay = await verifyReq(app, b2.challengeId, mailer.sent[1]!.code);
      expect(replay.status).toBe(400);
    } finally {
      await cleanup(uid, email);
    }
  });

  it('fail-closed：SMTP 未配置 → 503；60s 内重复发码 → 429', async (ctx) => {
    if (!connected) return ctx.skip();
    const { uid, email } = await createUser();
    try {
      // 无 mailer：密码正确也 503，绝不降级单密码
      const noMailerApp = makeApp(null);
      const res = await loginReq(noMailerApp, email, 'RightPass1');
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TWO_FACTOR_UNAVAILABLE');

      // 有 mailer：60s 冷却
      const mailer = stubMailer();
      const app = makeApp(mailer);
      await loginReq(app, email, 'RightPass1');
      const again = await loginReq(app, email, 'RightPass1');
      expect(again.status).toBe(429);
      expect(((await again.json()) as { error: { code: string } }).error.code).toBe('CODE_RATE_LIMITED');
    } finally {
      await cleanup(uid, email);
    }
  });

  it('防枚举：不存在邮箱与错误密码同返回 401 INVALID_CREDENTIALS；封禁账号 403', async (ctx) => {
    if (!connected) return ctx.skip();
    const { uid, email } = await createUser();
    const app = makeApp(stubMailer());
    try {
      const wrong = await loginReq(app, email, 'WrongPass1');
      const ghost = await loginReq(app, `ghost-${Date.now()}@test.local`, 'whatever');
      expect(wrong.status).toBe(401);
      expect(ghost.status).toBe(401);
      expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
      expect(((await ghost.json()) as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');

      await db.update(users).set({ status: 1 }).where(eq(users.id, uid));
      await redis.del(`login:*:*${email}*`).catch(() => {});
      const banned = await loginReq(app, email, 'RightPass1');
      expect(banned.status).toBe(403);
      expect(((await banned.json()) as { error: { code: string } }).error.code).toBe('ACCOUNT_UNAVAILABLE');
    } finally {
      await cleanup(uid, email);
    }
  });
});
