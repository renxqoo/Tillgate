/**
 * admin-api(管理面)facade 行为规格:getAdminMe 布局守卫(v1 行为等价)、
 * facade 委托 core、B1 回归(管理面 token 源独立)。
 */
import { describe, expect, it, vi } from 'vitest';
import { createAdminApiClient } from '../src/admin-api';

const adminMeBody = JSON.stringify({ id: 9, email: 'ops@tokenlens.dev' });

function fetchReturning(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe('getAdminMe 布局守卫(v1 getAdminMe 行为等价)', () => {
  it('成功返回 AdminMeInfo(即证明持有效管理员会话)', async () => {
    const admin = createAdminApiClient({
      baseUrl: 'http://admin-api',
      fetch: fetchReturning(200, adminMeBody),
    });
    const me = await admin.getAdminMe();
    expect(me?.id).toBe(9);
  });

  it.each([
    [
      '401 无管理员会话',
      fetchReturning(401, JSON.stringify({ error: { message: 'admin auth required' } })),
    ],
    [
      '网络异常',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    ],
  ])('%s → null', async (_name, fetchImpl) => {
    const admin = createAdminApiClient({ baseUrl: 'http://admin-api', fetch: fetchImpl });
    await expect(admin.getAdminMe()).resolves.toBeNull();
  });
});

describe('facade 委托 core transport', () => {
  it('list 查询与 baseUrl 拼接正确', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ rows: [], total: 0, page: 1, limit: 10 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const admin = createAdminApiClient({ baseUrl: 'http://admin-api', fetch: fetchImpl });
    await admin.list('/v1/users', { pageSize: 10 });
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
      'http://admin-api/v1/users?page=1&limit=10',
    );
  });
});

describe('B1 回归:管理面 token 只来自本面注入(与用户面 token 源物理隔离)', () => {
  it('管理面 client 携带 admin token,与用户面 base 相同也不串源', async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: unknown) => {
      calls.push({ headers: (init as { headers: Record<string, string> }).headers });
      return new Response(adminMeBody, { status: 200 });
    }) as unknown as typeof fetch;
    const admin = createAdminApiClient({
      baseUrl: 'http://same-host',
      fetch: fetchImpl,
      getToken: () => 'admin-jwt',
    });
    await admin.getAdminMe();
    expect(calls[0]?.headers.authorization).toBe('Bearer admin-jwt');
  });
});

describe('changeMyPassword(改密换发新会话 token)', () => {
  it('POST /v1/me/password 携带新旧密码,返回新 token', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ token: 'jwt-new' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const admin = createAdminApiClient({ baseUrl: 'http://admin-api', fetch: fetchImpl });
    const res = await admin.changeMyPassword({ oldPassword: 'a', newPassword: 'b' });
    expect(res.token).toBe('jwt-new');
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://admin-api/v1/me/password');
    expect(JSON.parse(String(init.body))).toEqual({ oldPassword: 'a', newPassword: 'b' });
  });

  it('旧密错误(4xx)按 ApiError 语义抛出——调用方 toast 错误不换 cookie', async () => {
    const admin = createAdminApiClient({
      baseUrl: 'http://admin-api',
      fetch: fetchReturning(400, JSON.stringify({ error: { message: 'password mismatch' } })),
    });
    await expect(
      admin.changeMyPassword({ oldPassword: 'wrong', newPassword: 'b' }),
    ).rejects.toThrow('password mismatch');
  });
});
