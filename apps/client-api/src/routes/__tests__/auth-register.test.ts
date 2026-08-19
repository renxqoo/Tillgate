import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb, type Db } from '@ai-gateway/db';
import { users, auditLogs, transactions } from '@ai-gateway/db/schema';
import { createEphemeralRedis, loadRootEnvFile, errorHandler, type EphemeralRedis } from '@ai-gateway/http';
import { hashPassword, type Mailer } from '@ai-gateway/identity';

import { clientAuthRoutesPublic } from '../auth.js';
import { makeServices, makeTestConfig } from '../../test/helpers.js';

/**
 * C 端邮箱自助注册（两步：注册 → 邮箱验证码 → 建号并自动登录）：
 *   - 邮箱已占用 → 409 EMAIL_TAKEN；弱密码 → 400
 *   - 验证码挑战（60s 冷却/邮箱、错 5 次作废、一次性消费）——与登录同一实现
 *   - 验证通过 → 建号（email 唯一索引兜底并发）+ ag_session + 首登赠额
 *   - 防刷：同 IP 注册请求限流 → 429；SMTP 未配置 → 503 fail-closed
 * 数据纪律：reg- 前缀，finally 清理（DB + Redis 键）。
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
    async send() {},
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
const nextEmail = () => `reg-${Date.now()}-${seq++}@test.local`;

async function cleanup(email: string): Promise<void> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.issuer, 'local'), eq(users.email, email)))
    .limit(1);
  if (rows[0]) {
    await db.delete(auditLogs).where(eq(auditLogs.adminId, rows[0].id));
    await db.delete(transactions).where(eq(transactions.userId, rows[0].id));
    await db.delete(users).where(eq(users.id, rows[0].id));
  }
  for (const pattern of [`logincode:*:*${email}`, `login:*:*${email}*`, 'register:req:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

function registerReq(app: Hono, email: string, password: string, ip?: string) {
  return app.request('/api/auth/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    body: JSON.stringify({ email, password }),
  });
}

function verifyReq(app: Hono, challengeId: string, code: string) {
  return app.request('/api/auth/register/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code }),
  });
}

describe('C 端邮箱自助注册', () => {
  it('占用邮箱 409；弱密码 400；正常注册 → 挑战+发码；验码通过建号+会话+赠额', async (ctx) => {
    if (!connected) return ctx.skip();
    const email = nextEmail();
    const mailer = stubMailer();
    const app = makeApp(mailer);
    try {
      // 先造一个占用者
      const takenEmail = nextEmail();
      await db.insert(users).values({
        issuer: 'local',
        subject: takenEmail,
        identityProvider: 'local',
        email: takenEmail,
        displayName: '占用',
        passwordHash: await hashPassword('RightPass1'),
      });
      try {
        const taken = await registerReq(app, takenEmail, 'GoodPass123');
        expect(taken.status).toBe(409);
        expect(((await taken.json()) as { error: { code: string } }).error.code).toBe('EMAIL_TAKEN');

        const weak = await registerReq(app, email, 'short');
        expect(weak.status).toBe(400);

        // 正常注册第一步
        const res = await registerReq(app, email, 'GoodPass123', '203.0.113.30');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { challengeId: string };
        expect(body.challengeId).toBeTypeOf('string');
        expect(mailer.sent).toHaveLength(1);
        expect(mailer.sent[0]!.to).toBe(email);

        // 错码 401 → 正确码 → 建号 + 会话 + 赠额
        const wrong = await verifyReq(app, body.challengeId, '000000');
        expect(wrong.status).toBe(401);

        // 模拟冷却窗口滚动（挑战 issued_at 回拨 61s）后重新发码
        await db.execute(
          sql`update identity_challenges set issued_at = clock_timestamp() - interval '61 seconds' where id = ${body.challengeId}`,
        );
        const res2 = await registerReq(app, email, 'GoodPass123', '203.0.113.30');
        const body2 = (await res2.json()) as { challengeId: string };
        const ok = await verifyReq(app, body2.challengeId, mailer.sent[1]!.code);
        expect(ok.status).toBe(200);
        const okBody = (await ok.json()) as { user: { id: number; email: string; gifted: boolean } };
        expect(okBody.user.email).toBe(email);
        expect(okBody.user.gifted).toBe(true);
        expect(ok.headers.getSetCookie().some((c) => c.startsWith('ag_session='))).toBe(true);

        // 建的号能直接走登录第一步
        const loginRes = await app.request('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'GoodPass123' }),
        });
        expect(loginRes.status).toBe(200);
        expect(((await loginRes.json()) as { twoFactorRequired: boolean }).twoFactorRequired).toBe(true);
      } finally {
        await cleanup(takenEmail);
      }
    } finally {
      await cleanup(email);
    }
  });

  it('防刷：同 IP 注册请求限流 429；60s 内重复发码 429；SMTP 未配置 503', async (ctx) => {
    if (!connected) return ctx.skip();
    const email = nextEmail();
    const mailer = stubMailer();
    const app = makeApp(mailer);
    try {
      const noMailerApp = makeApp(null);
      const failClosed = await registerReq(noMailerApp, nextEmail(), 'GoodPass123', '198.51.100.9');
      expect(failClosed.status).toBe(503);

      // 同 IP 限流：阈值后 429（前面用例 IP 不同，不受影响）
      const ip = '203.0.113.77';
      const first = await registerReq(app, nextEmail(), 'GoodPass123', ip);
      expect(first.status).toBe(200);
      for (let i = 0; i < 4; i++) {
        await registerReq(app, nextEmail(), 'GoodPass123', ip);
      }
      const limited = await registerReq(app, nextEmail(), 'GoodPass123', ip);
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('REGISTER_RATE_LIMITED');

      // 邮箱冷却：同一邮箱首条 200，60s 内第二条 429
      const firstForEmail = await registerReq(app, email, 'GoodPass123', '198.51.100.10');
      expect(firstForEmail.status).toBe(200);
      const again = await registerReq(app, email, 'GoodPass123', '198.51.100.11');
      expect(again.status).toBe(429);
      expect(((await again.json()) as { error: { code: string } }).error.code).toBe('CODE_RATE_LIMITED');
    } finally {
      await cleanup(email);
      await cleanup('reg-@test.local'); // no-op 保护
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'register:req:203.0.113.77', 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    }
  });
});
