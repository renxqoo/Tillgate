import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import { createDb, type Db } from '@ai-gateway/db';
import { users, auditLogs, transactions } from '@ai-gateway/db/schema';
import { createEphemeralRedis, loadRootEnvFile, errorHandler, type EphemeralRedis } from '@ai-gateway/http';

import { oauthRoutes } from '../oauth.js';
import { makeServices } from '../../test/helpers.js';
import { makeTestConfig } from '../../test/helpers.js';

/**
 * OAuth 社交登录（GitHub/Google，Authorization Code + state 双提交）：
 *   - authorize：302 到 provider，ag_oauth_state cookie + Redis 单次 state
 *   - callback：cookie state == query state（防 login-CSRF）→ 换 token → 取 profile
 *     → find-or-create（issuer=provider, subject=平台 id）→ ag_session → 重定向前端
 *   - 同一平台账号二次登录不重复建号；未配置 provider 404
 * Provider 端点可覆盖 → 本测试起本地假 GitHub/Google，不打真实外网。
 * 数据纪律：oauth- 前缀 subject 域内清理。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let redis: EphemeralRedis;

let connected = false;
let fakeBase = '';
let fakeServer: ReturnType<typeof serve> | null = null;

beforeAll(async () => {
  try {
    redis = await createEphemeralRedis();
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
  // 假 provider：token 换取 + profile（GitHub /user + /user/emails；Google /userinfo）
  const fake = new Hono();
  fake.post('/github/token', async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    if (body.code !== 'good-code') return c.json({ error: 'bad_code' }, 400);
    return c.json({ access_token: 'at-gh-1', token_type: 'bearer' });
  });
  fake.get('/github/user', (c) => {
    if (c.req.header('authorization') !== 'Bearer at-gh-1') return c.json({ message: 'bad token' }, 401);
    return c.json({ id: 424242, login: 'octo-zc', name: 'Octo Cat' });
  });
  fake.get('/github/user/emails', (c) => c.json([
    { email: 'octo-zc@test.local', primary: true, verified: true },
    { email: 'octo-alt@test.local', primary: false, verified: true },
  ]));
  fake.post('/google/token', async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    if (body.code !== 'good-code') return c.json({ error: 'bad_code' }, 400);
    return c.json({ access_token: 'at-go-1', token_type: 'Bearer' });
  });
  fake.get('/google/userinfo', (c) => {
    if (c.req.header('authorization') !== 'Bearer at-go-1') return c.json({ error: 'bad token' }, 401);
    return c.json({ sub: 'g-sub-777', email: 'g-zc@test.local', email_verified: true, name: 'Google Cat' });
  });
  fakeServer = serve({ fetch: fake.fetch, port: 0 });
  fakeBase = `http://127.0.0.1:${(fakeServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  fakeServer?.close();
  await redis?.close();
  await db.$client.end().catch(() => {});
});

function makeApp(github: boolean, google: boolean) {
  const services = makeServices(db, { redis });
  const config = makeTestConfig({
    giftAmount: 1,
    oauth: {
      frontendUrl: 'http://localhost:3001',
      apiBase: 'http://api.test.local:8791',
      github: github
        ? { clientId: 'gh-id', clientSecret: 'gh-secret' }
        : null,
      google: google
        ? { clientId: 'go-id', clientSecret: 'go-secret' }
        : null,
      endpoints: {
        github: {
          authorizeUrl: `${fakeBase}/github/authorize`,
          tokenUrl: `${fakeBase}/github/token`,
          profileUrl: `${fakeBase}/github/user`,
          emailsUrl: `${fakeBase}/github/user/emails`,
        },
        google: {
          authorizeUrl: `${fakeBase}/google/authorize`,
          tokenUrl: `${fakeBase}/google/token`,
          profileUrl: `${fakeBase}/google/userinfo`,
        },
      },
    },
  });
  const app = new Hono();
  app.onError(errorHandler());
  app.route('/api/auth/oauth', oauthRoutes(services, config));
  return app;
}

async function cleanupOauthUsers(): Promise<void> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.issuer, 'github'))
    .limit(50);
  const gRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.issuer, 'google'))
    .limit(50);
  for (const u of [...rows, ...gRows]) {
    await db.delete(auditLogs).where(eq(auditLogs.adminId, u.id));
    await db.delete(transactions).where(eq(transactions.userId, u.id));
    await db.delete(users).where(eq(users.id, u.id));
  }
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'oauth:state:*', 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

describe('OAuth GitHub/Google 登录', () => {
  it('封禁/注销的 OAuth 账号 → 403 ACCOUNT_UNAVAILABLE（不得被兜底 catch 吞成 502）', async (ctx) => {
    if (!connected) return ctx.skip();
    try {
      // 预置：GitHub subject=424242 已存在但被封禁
      await cleanupOauthUsers();
      await db
        .insert(users)
        .values({
          issuer: 'github',
          subject: '424242',
          identityProvider: 'github',
          email: 'octo-zc@test.local',
          displayName: 'Banned Octo',
          status: 1,
        })
        .onConflictDoNothing();
      const app = makeApp(true, true);
      const authorize = await app.request('/api/auth/oauth/github/authorize');
      const cookieHeader = authorize.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      const state = new URL(authorize.headers.get('location')!).searchParams.get('state')!;
      const res = await app.request(
        `/api/auth/oauth/github/callback?code=good-code&state=${state}`,
        { headers: { cookie: cookieHeader } },
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'ACCOUNT_UNAVAILABLE',
      );
    } finally {
      await cleanupOauthUsers();
    }
  });


  it('未配置 provider → 404；配置后 authorize 302 + state cookie', async (ctx) => {
    if (!connected) return ctx.skip();
    const noGoogle = makeApp(true, false);
    const missing = await noGoogle.request('/api/auth/oauth/google/authorize');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('OAUTH_NOT_CONFIGURED');

    const app = makeApp(true, true);
    const res = await app.request('/api/auth/oauth/github/authorize?next=/dashboard/keys');
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toContain(`${fakeBase}/github/authorize`);
    expect(loc).toContain('client_id=gh-id');
    expect(loc).toContain('state=');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('ag_oauth_state='));
    expect(cookie).toBeTruthy();
    expect(cookie).toContain('HttpOnly');
  });

  it('GitHub callback：state cookie 不符 → 403；正确 → 建号+会话+重定向前端；二次登录同号不重复建号', async (ctx) => {
    if (!connected) return ctx.skip();
    try {
      const app = makeApp(true, true);
      const authorize = await app.request('/api/auth/oauth/github/authorize');
      const cookieHeader = authorize.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      const state = new URL(authorize.headers.get('location')!).searchParams.get('state')!;

      // state 不符（无 cookie / 错 cookie）→ 403
      const noCookie = await app.request(
        `/api/auth/oauth/github/callback?code=good-code&state=${state}`,
      );
      expect(noCookie.status).toBe(403);

      // 正确流程
      const ok = await app.request(`/api/auth/oauth/github/callback?code=good-code&state=${state}`, {
        headers: { cookie: cookieHeader },
      });
      expect(ok.status).toBe(302);
      expect(ok.headers.get('location')).toBe('http://localhost:3001/dashboard');
      const session = ok.headers.getSetCookie().find((c) => c.startsWith('ag_session='));
      expect(session).toBeTruthy();

      const created = await db.query.users.findFirst({
        where: and(eq(users.issuer, 'github'), eq(users.subject, '424242')),
      });
      expect(created).toBeTruthy();
      expect(created!.email).toBe('octo-zc@test.local');
      expect(created!.displayName).toBe('Octo Cat');

      // 同一 GitHub 账号二次登录：不重复建号
      const authorize2 = await app.request('/api/auth/oauth/github/authorize');
      const cookie2 = authorize2.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const state2 = new URL(authorize2.headers.get('location')!).searchParams.get('state')!;
      const ok2 = await app.request(
        `/api/auth/oauth/github/callback?code=good-code&state=${state2}`,
        { headers: { cookie: cookie2 } },
      );
      expect(ok2.status).toBe(302);
      const count = await db.select({ id: users.id }).from(users).where(eq(users.subject, '424242'));
      expect(count).toHaveLength(1);
    } finally {
      await cleanupOauthUsers();
    }
  });

  it('Google callback：建号 issuer=google；next 参数限站内相对路径', async (ctx) => {
    if (!connected) return ctx.skip();
    try {
      const app = makeApp(true, true);
      const authorize = await app.request('/api/auth/oauth/google/authorize?next=/dashboard/usage');
      const cookieHeader = authorize.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const state = new URL(authorize.headers.get('location')!).searchParams.get('state')!;

      const ok = await app.request(
        `/api/auth/oauth/google/callback?code=good-code&state=${state}`,
        { headers: { cookie: cookieHeader } },
      );
      expect(ok.status).toBe(302);
      expect(ok.headers.get('location')).toBe('http://localhost:3001/dashboard/usage');
      const created = await db.query.users.findFirst({
        where: and(eq(users.issuer, 'google'), eq(users.subject, 'g-sub-777')),
      });
      expect(created).toBeTruthy();
      expect(created!.email).toBe('g-zc@test.local');

      // open redirect 防护：外部 next 被回落 /dashboard
      const authorize3 = await app.request('/api/auth/oauth/google/authorize?next=https://evil.example/x');
      const cookie3 = authorize3.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const state3 = new URL(authorize3.headers.get('location')!).searchParams.get('state')!;
      const ok3 = await app.request(
        `/api/auth/oauth/google/callback?code=good-code&state=${state3}`,
        { headers: { cookie: cookie3 } },
      );
      expect(ok3.headers.get('location')).toBe('http://localhost:3001/dashboard');
    } finally {
      await cleanupOauthUsers();
    }
  });
});
