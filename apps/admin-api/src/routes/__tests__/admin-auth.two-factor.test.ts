import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDb, type Db } from '@ai-gateway/db';
import { admins } from '@ai-gateway/db/schema';
import { createRedis, loadRootEnvFile, type Redis } from '@ai-gateway/http';
import { hashPassword } from '@ai-gateway/identity';
import { adminAuthRoutesProtected, adminAuthRoutesPublic } from '../admin-auth.js';
import { errorHandler } from '@ai-gateway/http';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';
import type { Mailer } from '@ai-gateway/identity';
import type { AdminApiConfig } from '../../config.js';

/**
 * 管理员邮箱验证码二次登录（第八轮）：
 *   - 开启 2FA：密码正确 → 不发会话，返回 challenge + 邮件发码；验码通过 → 会话
 *   - 错 5 次作废（作废后连正确码也 400）；challenge 不存在 → 400
 *   - SMTP 未配置（mailer=null）：登录 fail-closed 503，不降级单密码
 * 数据纪律：__2fa_ 前缀管理员，finally 自清理（含 Redis 键）。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
const redis: Redis = createRedis(process.env.REDIS_URL ?? 'redis://:root123@localhost:6379');

let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: admins.id }).from(admins).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

/** 捕获验证码的 stub mailer */
function stubMailer(): Mailer & { sent: Array<{ to: string; code: string }> } {
  const m = { sent: [] as Array<{ to: string; code: string }> };
  return Object.assign(m, {
    async sendLoginCode(to: string, code: string) {
      m.sent.push({ to, code });
    },
  }) as Mailer & { sent: Array<{ to: string; code: string }> };
}

function testConfig(): AdminApiConfig {
  return {
    adminJwtSecret: 'test-admin-jwt-secret-32-chars-ok!!',
    secureCookie: false,
    trustedOrigins: [],
    trustedProxyHops: 1,
    voucherStorageDir: '/tmp',
    voucherMaxBytes: 1024,
    allowLocalUpstream: false,
  };
}

function makePubApp(services: ReturnType<typeof makeServices>): Hono {
  const app = new Hono();
  app.onError(errorHandler());
  app.route('/api/admin/auth', adminAuthRoutesPublic(services, testConfig()));
  return app;
}

async function login(app: Hono, email: string, password: string): Promise<Response> {
  return await app.request('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

async function verify(app: Hono, challengeId: string, code: string): Promise<Response> {
  return await app.request('/api/admin/auth/login/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code }),
  });
}

describe('管理员邮箱验证码二次登录', () => {
  it('全链路：密码对 → challenge（无会话）→ 错码 5 次作废 → 新 challenge 验码通过发会话', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const email = `__2fa_${s}@test.local`;
    const mailer = stubMailer();
    const app = makePubApp(makeServices(db, { redis, mailer }));
    const [a] = await db
      .insert(admins)
      .values({ email, passwordHash: await hashPassword('RightPass1'), twoFactorEnabled: true })
      .returning({ id: admins.id });
    try {
      const bad = await login(app, email, 'WrongPass1');
      expect(bad.status).toBe(401);

      const step1 = await login(app, email, 'RightPass1');
      expect(step1.status).toBe(200);
      const b1 = (await step1.json()) as { twoFactorRequired: boolean; challengeId: string };
      expect(b1.twoFactorRequired).toBe(true);
      expect(step1.headers.getSetCookie().length).toBe(0); // 未签发会话
      expect(mailer.sent.length).toBe(1);
      expect(mailer.sent[0]!.to).toBe(email);

      // 统一口径（identity login-code）：前 4 次错 401，第 5 次错即作废 400
      for (let i = 0; i < 4; i++) {
        const wrong = await verify(app, b1.challengeId, '000000');
        expect(wrong.status).toBe(401);
      }
      const fifth = await verify(app, b1.challengeId, '000000');
      expect(fifth.status).toBe(400);
      // 作废后正确码也不行
      const dead = await verify(app, b1.challengeId, mailer.sent[0]!.code);
      expect(dead.status).toBe(400);

      // 限发 60s：模拟窗口滚动后重新登录
      await redis.del(`logincode:cool:admin:${a!.id}`);
      const step1b = await login(app, email, 'RightPass1');
      const b1b = (await step1b.json()) as { challengeId: string };
      const ok = await verify(app, b1b.challengeId, mailer.sent[1]!.code);
      expect(ok.status).toBe(200);
      expect(ok.headers.getSetCookie().some((c) => c.startsWith('ag_admin_session='))).toBe(true);

      const ghost = await verify(app, '00000000-0000-4000-8000-000000000000', '123456');
      expect(ghost.status).toBe(400);
    } finally {
      await db.delete(admins).where(eq(admins.id, a!.id));
      await redis.del(`logincode:cool:admin:${a!.id}`);
    }
  });

  it('发码限流：60s 内第二次登录（密码对）→ 429', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const email = `__2fa3_${s}@test.local`;
    const mailer = stubMailer();
    const app = makePubApp(makeServices(db, { redis, mailer }));
    const [a] = await db
      .insert(admins)
      .values({ email, passwordHash: await hashPassword('RightPass1'), twoFactorEnabled: true })
      .returning({ id: admins.id });
    try {
      const first = await login(app, email, 'RightPass1');
      expect(first.status).toBe(200);
      const second = await login(app, email, 'RightPass1');
      expect(second.status).toBe(429);
    } finally {
      await db.delete(admins).where(eq(admins.id, a!.id));
      await redis.del(`logincode:cool:admin:${a!.id}`);
    }
  });

  it('SMTP 未配置：登录 fail-closed 503（不降级单密码）', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const email = `__2fa2_${s}@test.local`;
    const app = makePubApp(makeServices(db, { redis, mailer: null }));
    const [a] = await db
      .insert(admins)
      .values({ email, passwordHash: await hashPassword('RightPass1'), twoFactorEnabled: true })
      .returning({ id: admins.id });
    try {
      const res = await login(app, email, 'RightPass1');
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('TWO_FACTOR_UNAVAILABLE');
    } finally {
      await db.delete(admins).where(eq(admins.id, a!.id));
    }
  });
});

describe('2FA 开关路由 + 公开组 CSRF（A4/A11）', () => {
  it('开启要求 SMTP（未配 400）；配置后开启/关闭落库；evil Origin 登录 403', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const email = `__2fa4_${s}@test.local`;
    const mailer = stubMailer();
    const [a] = await db
      .insert(admins)
      .values({ email, passwordHash: await hashPassword('RightPass1') })
      .returning({ id: admins.id });
    try {
      // 未配 SMTP：开启被拒
      const noMailerServices = makeServices(db, { redis, mailer: null });
      const appNoSmtp = makeAdminTestApp({ '/auth': adminAuthRoutesProtected(noMailerServices) }, { adminId: a!.id });
      const denied = await appNoSmtp.request('/api/admin/auth/two-factor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      expect(denied.status).toBe(400);
      expect(((await denied.json()) as { error?: { code?: string } }).error?.code).toBe('SMTP_NOT_CONFIGURED');

      // 配置后：开启 → 落库 true；关闭 → false
      const services = makeServices(db, { redis, mailer });
      const app = makeAdminTestApp({ '/auth': adminAuthRoutesProtected(services) }, { adminId: a!.id });
      const on = await app.request('/api/admin/auth/two-factor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      expect(on.status).toBe(200);
      expect(((await on.json()) as { twoFactorEnabled?: boolean }).twoFactorEnabled).toBe(true);
      const off = await app.request('/api/admin/auth/two-factor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(off.status).toBe(200);
      const row = await db.query.admins.findFirst({ where: eq(admins.id, a!.id), columns: { twoFactorEnabled: true } });
      expect(row?.twoFactorEnabled).toBe(false);

      // A11：admin 公开组 CSRF——evil Origin 登录 403（镜像 client 面用例）
      await redis.del(`logincode:cool:admin:${a!.id}`);
      const evil = await makePubApp(services).request('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ email, password: 'RightPass1' }),
      });
      expect(evil.status).toBe(403);
    } finally {
      await db.delete(admins).where(eq(admins.id, a!.id));
      await redis.del(`logincode:cool:admin:${a!.id}`);
    }
  });
});
