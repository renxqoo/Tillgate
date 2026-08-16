import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import { createDb, type Db } from '@ai-gateway/db';
import { users, auditLogs, transactions } from '@ai-gateway/db/schema';
import { Redis, loadRootEnvFile, errorHandler } from '@ai-gateway/http';

import { meRoutes } from './me.js';
import { clientAuthRoutesPublic } from './auth.js';
import { oauthRoutes } from './oauth.js';
import { makeServices, makeClientTestApp, makeTestConfig } from '../test/helpers.js';

/**
 * 显示名称：新用户默认 rx 前缀随机名 + 自助修改（PATCH /api/me/display-name）。
 * 数据纪律：rx- 前缀测试用户，finally 清理。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  retryStrategy: () => null,
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

let connected = false;
let fakeBase = '';
let fakeServer: ReturnType<typeof serve> | null = null;

beforeAll(async () => {
  try {
    await redis.connect();
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
  // 假 GitHub：name 为空但 login 存在 → 直接用平台用户名（不改成 rx 默认名）
  const fake = new Hono();
  fake.post('/token', (c) => c.json({ access_token: 'at-rx-1' }));
  fake.get('/user', (c) => c.json({ id: 990011, login: 'noname-rx', name: null }));
  fake.get('/user/emails', (c) => c.json([{ email: 'noname-rx@test.local', primary: true, verified: true }]));
  fakeServer = serve({ fetch: fake.fetch, port: 0 });
  fakeBase = `http://127.0.0.1:${(fakeServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  fakeServer?.close();
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

async function cleanup(issuer: string, subject: string): Promise<void> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.issuer, issuer), eq(users.subject, subject)))
    .limit(1);
  if (rows[0]) {
    await db.delete(auditLogs).where(eq(auditLogs.adminId, rows[0].id));
    await db.delete(transactions).where(eq(transactions.userId, rows[0].id));
    await db.delete(users).where(eq(users.id, rows[0].id));
  }
}

describe('显示名称：rx 默认名 + 自助修改', () => {
  it('邮箱注册默认 displayName 以 rx 开头（6 位随机后缀）', async (ctx) => {
    if (!connected) return ctx.skip();
    const email = `rx-reg-${Date.now()}@test.local`;
    const app = new Hono();
    app.onError(errorHandler());
    const services = makeServices(db, {
      redis,
      mailer: {
        sent: [] as Array<{ to: string; code: string }>,
        async sendLoginCode(to: string, code: string) {
          (services.mailer as unknown as { sent: Array<{ to: string; code: string }> }).sent.push({ to, code });
        },
      } as never,
    });
    app.route('/api/auth', clientAuthRoutesPublic(services, makeTestConfig()));
    try {
      const reg = await app.request('/api/auth/register', {
        method: 'POST',
        // 独立 IP：与 auth-register.test.ts 的限流计数器隔离（vitest 并行文件共享 Redis）
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.77' },
        body: JSON.stringify({ email, password: 'GoodPass123' }),
      });
      expect(reg.status).toBe(200);
      const { challengeId } = (await reg.json()) as { challengeId: string };
      const sent = (services.mailer as unknown as { sent: Array<{ to: string; code: string }> }).sent;
      const verify = await app.request('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId, code: sent[0]!.code }),
      });
      expect(verify.status).toBe(200);
      const { user } = (await verify.json()) as { user: { id: number } };

      const u = await db.query.users.findFirst({ where: eq(users.id, user.id) });
      expect(u!.displayName).toMatch(/^rx[a-z2-9]{6}$/);
    } finally {
      await cleanup('local', email);
    }
  });

  it('OAuth 无真实姓名 → 用平台用户名（login/邮箱前缀），不用 rx；PATCH /api/me/display-name 自助改名', async (ctx) => {
    if (!connected) return ctx.skip();
    const services = makeServices(db, { redis });
    const config = makeTestConfig({
      oauth: {
        frontendUrl: 'http://localhost:3001',
        apiBase: 'http://api.test.local:8791',
        github: { clientId: 'gh', clientSecret: 'sec' },
        google: null,
        endpoints: {
          github: {
            authorizeUrl: `${fakeBase}/authorize`,
            tokenUrl: `${fakeBase}/token`,
            profileUrl: `${fakeBase}/user`,
            emailsUrl: `${fakeBase}/user/emails`,
          },
        },
      },
    });
    const oauthApp = new Hono();
    oauthApp.onError(errorHandler());
    oauthApp.route('/api/auth/oauth', oauthRoutes(services, config));
    try {
      const authorize = await oauthApp.request('/api/auth/oauth/github/authorize');
      const cookieHeader = authorize.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const state = new URL(authorize.headers.get('location')!).searchParams.get('state')!;
      const ok = await oauthApp.request(`/api/auth/oauth/github/callback?code=good&state=${state}`, {
        headers: { cookie: cookieHeader },
      });
      expect(ok.status).toBe(302);

      // GitHub：name 空 → 直接用 login（平台用户名）
      const u = await db.query.users.findFirst({
        where: and(eq(users.issuer, 'github'), eq(users.subject, '990011')),
      });
      expect(u!.displayName).toBe('noname-rx');

      // 自助改名（受保护路由：stub 注入 userId）
      const meApp = makeClientTestApp(u!.id, { '/me': meRoutes(services) });
      const res = await meApp.request('/api/me/display-name', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '  我的昵称  ' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { displayName: string }).displayName).toBe('我的昵称');

      const after = await db.query.users.findFirst({ where: eq(users.id, u!.id) });
      expect(after!.displayName).toBe('我的昵称');

      // 校验：空 → 400；超长 → 400
      const empty = await meApp.request('/api/me/display-name', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '   ' }),
      });
      expect(empty.status).toBe(400);
      const long = await meApp.request('/api/me/display-name', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'x'.repeat(33) }),
      });
      expect(long.status).toBe(400);
    } finally {
      await cleanup('github', '990011');
    }
  });
});
