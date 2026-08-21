/**
 * 认证路由 HTTP 面（登录/验码端点）：
 *   - 密码错 401 信封；乱 body 400；正确密码 200 发 token 且 token 可用
 *   - 验码端点：非 uuid challengeId → 400
 *   - 封禁管理员登录 → 403
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { admins } from '@ai-gateway/db';
import { buildTestApp, db, newAdmin, TEST_PASSWORD } from './helpers.js';

describe('POST /v1/auth/login', () => {
  it('密码错 → 401 invalid_credentials；token 不发', async () => {
    const { request } = buildTestApp();
    const { email } = await newAdmin();
    const res = await request('/v1/auth/login', { body: { email, password: 'totally-wrong' } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_credentials');
  });

  it('正确密码 → 200 发 token；token 即刻可用于 /v1/me', async () => {
    const { request } = buildTestApp();
    const { email, id } = await newAdmin();
    const res = await request('/v1/auth/login', { body: { email, password: TEST_PASSWORD } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; adminId: number };
    expect(body.adminId).toBe(id);
    const me = await request('/v1/me', { token: body.token });
    expect(me.status).toBe(200);
  });

  it('非法 email 形状 / 缺密码 → 400；封禁管理员 → 403', async () => {
    const { request } = buildTestApp();
    const bad = await request('/v1/auth/login', { body: { email: 'not-an-email', password: 'x' } });
    expect(bad.status).toBe(400);

    const { id, email } = await newAdmin();
    await db.update(admins).set({ status: 1 }).where(eq(admins.id, id));
    const banned = await request('/v1/auth/login', { body: { email, password: TEST_PASSWORD } });
    expect(banned.status).toBe(403);
    expect(((await banned.json()) as { error: { code: string } }).error.code).toBe('account_unavailable');
  });
});

describe('POST /v1/auth/login/verify', () => {
  it('非 uuid challengeId → 400；错码形状 → 400', async () => {
    const { request } = buildTestApp();
    expect(
      (await request('/v1/auth/login/verify', { body: { challengeId: 'nope', code: '123456' } })).status,
    ).toBe(400);
    expect(
      (await request('/v1/auth/login/verify', {
        body: { challengeId: '00000000-0000-4000-8000-000000000000', code: 'abc' },
      })).status,
    ).toBe(400);
  });
});
