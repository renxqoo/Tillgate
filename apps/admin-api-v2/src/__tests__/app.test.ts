/**
 * app 协议面：healthz / 404 信封 / 会话门禁（无 token / 跨面 token / 坏 token）。
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { signSession } from '@ai-gateway/identity';
import { admins } from '@ai-gateway/db';
import { buildTestApp, db, newAdmin, TEST_JWT_SECRET } from './helpers.js';

describe('admin-api-v2 协议面', () => {
  it('healthz 200', async () => {
    const { request } = buildTestApp();
    const res = await request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('未知路径 → 404 信封', async () => {
    const { request } = buildTestApp();
    const res = await request('/no-such-path');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('受保护路由无 token → 401', async () => {
    const { request } = buildTestApp();
    const res = await request('/v1/providers');
    expect(res.status).toBe(401);
  });

  it('用户面 token（type=user）跨面使用 → 401（issuer 物理隔离）', async () => {
    const { request } = buildTestApp();
    const userToken = await signSession({ type: 'user', id: 1 }, TEST_JWT_SECRET);
    const res = await request('/v1/providers', { token: userToken });
    expect(res.status).toBe(401);
  });

  it('乱写 token → 401', async () => {
    const { request } = buildTestApp();
    const res = await request('/v1/providers', { token: 'not-a-jwt' });
    expect(res.status).toBe(401);
  });

  it('合法管理员 Bearer → 放行', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/providers', { token });
    expect(res.status).toBe(200);
  });

  it('封禁管理员（status=1）即时下线', async () => {
    const { request } = buildTestApp();
    const { id, token } = await newAdmin();
    await db.update(admins).set({ status: 1 }).where(eq(admins.id, id));
    const res = await request('/v1/providers', { token });
    expect(res.status).toBe(401);
  });
});
