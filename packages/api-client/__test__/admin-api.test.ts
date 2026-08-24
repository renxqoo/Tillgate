/**
 * admin-api(管理面)facade 行为规格:getAdminMe 布局守卫(v1 行为等价)、
 * facade 委托 core、B1 回归(管理面 token 源独立)。
 */
import { describe, expect, it, vi } from 'vitest';
import { createAdminApiClient } from '../src/admin-api';

const adminMeBody = JSON.stringify({ id: 9, email: 'ops@tillgate.dev' });

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

interface FacadeCase {
  readonly name: string;
  readonly invoke: (client: ReturnType<typeof createAdminApiClient>) => Promise<unknown>;
  readonly method: string;
  readonly url: string;
  readonly sendBody?: unknown;
  readonly respond: unknown;
  readonly expectResult?: (result: unknown) => void;
}

/** RBAC/管理面 facade 方法矩阵:method+URL+请求体逐条(表驱动,新增方法自动入列) */
const FACADE_CASES: readonly FacadeCase[] = [
  {
    name: 'listAdmins 全参查询串',
    invoke: (c) => c.listAdmins({ page: 2, pageSize: 20, q: 'ops', sortBy: 'id', order: 'desc' }),
    method: 'GET',
    url: 'http://admin-api/v1/admins?page=2&page_size=20&q=ops&sort_by=id&order=desc',
    respond: { rows: [], total: 0 },
  },
  {
    name: 'listAdmins 空 q 不落参(无其他参则无 ? 后缀)',
    invoke: (c) => c.listAdmins({ q: '' }),
    method: 'GET',
    url: 'http://admin-api/v1/admins',
    respond: { rows: [], total: 0 },
  },
  {
    name: 'listRoles 全参查询串',
    invoke: (c) => c.listRoles({ page: 1, pageSize: 50, q: 'x', sortBy: 'code', order: 'asc' }),
    method: 'GET',
    url: 'http://admin-api/v1/roles?page=1&page_size=50&q=x&sort_by=code&order=asc',
    respond: { rows: [], total: 0 },
  },
  {
    name: 'listRoles 无参无 ? 后缀',
    invoke: (c) => c.listRoles(),
    method: 'GET',
    url: 'http://admin-api/v1/roles',
    respond: { rows: [], total: 0 },
  },
  {
    name: 'createAdmin POST body 原样',
    invoke: (c) => c.createAdmin({ email: 'a@b.c', password: '12345678', roleId: 1 }),
    method: 'POST',
    url: 'http://admin-api/v1/admins',
    sendBody: { email: 'a@b.c', password: '12345678', roleId: 1 },
    respond: { id: 1 },
  },
  {
    name: 'updateAdmin PATCH 到 :id',
    invoke: (c) => c.updateAdmin(7, { status: 1 }),
    method: 'PATCH',
    url: 'http://admin-api/v1/admins/7',
    sendBody: { status: 1 },
    respond: { id: 7 },
  },
  {
    name: 'createRole POST',
    invoke: (c) => c.createRole({ code: 'r1', name: '角色', permissions: [] }),
    method: 'POST',
    url: 'http://admin-api/v1/roles',
    sendBody: { code: 'r1', name: '角色', permissions: [] },
    respond: { id: 3, code: 'r1' },
  },
  {
    name: 'updateRole PATCH 部分字段',
    invoke: (c) => c.updateRole(3, { status: 1, permissions: ['users:read'] }),
    method: 'PATCH',
    url: 'http://admin-api/v1/roles/3',
    sendBody: { status: 1, permissions: ['users:read'] },
    respond: { id: 3 },
  },
  {
    name: 'deleteRole DELETE 到 :id',
    invoke: (c) => c.deleteRole(3),
    method: 'DELETE',
    url: 'http://tillgate.invalid/v1/roles/3'.replace('tillgate.invalid', 'admin-api'),
    respond: { ok: true },
    expectResult: (r) => expect(r).toEqual({ ok: true }),
  },
  {
    name: 'permissionTree 解包 rows',
    invoke: (c) => c.permissionTree(),
    method: 'GET',
    url: 'http://admin-api/v1/permissions/tree',
    respond: { rows: [{ id: 1 }] },
    expectResult: (r) => expect(r).toEqual([{ id: 1 }]),
  },
  {
    name: 'permissionTree rows 缺省回落 []',
    invoke: (c) => c.permissionTree(),
    method: 'GET',
    url: 'http://admin-api/v1/permissions/tree',
    respond: {},
    expectResult: (r) => expect(r).toEqual([]),
  },
  {
    name: 'createPermission POST',
    invoke: (c) =>
      c.createPermission({ parentId: 1, type: 'button', code: 'x:y', name: 'n', sortOrder: 0 }),
    method: 'POST',
    url: 'http://admin-api/v1/permissions',
    sendBody: { parentId: 1, type: 'button', code: 'x:y', name: 'n', sortOrder: 0 },
    respond: { id: 9 },
  },
  {
    name: 'updatePermission PATCH 全字段直传',
    invoke: (c) => c.updatePermission(9, { code: 'x:z', status: 1, type: 'button', parentId: 2 }),
    method: 'PATCH',
    url: 'http://admin-api/v1/permissions/9',
    sendBody: { code: 'x:z', status: 1, type: 'button', parentId: 2 },
    respond: { id: 9 },
  },
  {
    name: 'deletePermission DELETE',
    invoke: (c) => c.deletePermission(9),
    method: 'DELETE',
    url: 'http://admin-api/v1/permissions/9',
    respond: { ok: true },
  },
  {
    name: 'listEndpointBindings 解包 rows',
    invoke: (c) => c.listEndpointBindings(),
    method: 'GET',
    url: 'http://admin-api/v1/endpoint-bindings',
    respond: { rows: [{ id: 1, method: 'GET', path: '/v1/x', permissionId: 1, source: 'custom' }] },
    expectResult: (r) => expect(r).toHaveLength(1),
  },
  {
    name: 'listEndpointBindings rows 缺省回落 []',
    invoke: (c) => c.listEndpointBindings(),
    method: 'GET',
    url: 'http://admin-api/v1/endpoint-bindings',
    respond: {},
    expectResult: (r) => expect(r).toEqual([]),
  },
  {
    name: 'createEndpointBinding POST',
    invoke: (c) => c.createEndpointBinding({ method: 'GET', path: '/v1/x', permissionId: 1 }),
    method: 'POST',
    url: 'http://admin-api/v1/endpoint-bindings',
    sendBody: { method: 'GET', path: '/v1/x', permissionId: 1 },
    respond: { id: 5 },
  },
  {
    name: 'updateEndpointBinding PATCH 部分更新体原样直传',
    invoke: (c) => c.updateEndpointBinding(5, { method: 'POST', path: '/v1/y' }),
    method: 'PATCH',
    url: 'http://admin-api/v1/endpoint-bindings/5',
    sendBody: { method: 'POST', path: '/v1/y' },
    respond: { id: 5 },
  },
  {
    name: 'deleteEndpointBinding DELETE',
    invoke: (c) => c.deleteEndpointBinding(5),
    method: 'DELETE',
    url: 'http://admin-api/v1/endpoint-bindings/5',
    respond: { ok: true },
  },
  {
    name: 'getMyMenus GET me/menus',
    invoke: (c) => c.getMyMenus(),
    method: 'GET',
    url: 'http://admin-api/v1/me/menus',
    respond: { groups: [] },
    expectResult: (r) => expect(r).toEqual({ groups: [] }),
  },
];

describe('管理面 facade 方法矩阵', () => {
  for (const testCase of FACADE_CASES) {
    it(testCase.name, async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify(testCase.respond), { status: 200 }),
      ) as unknown as typeof fetch;
      const client = createAdminApiClient({ baseUrl: 'http://admin-api', fetch: fetchImpl });
      const result = await testCase.invoke(client);
      const call = vi.mocked(fetchImpl).mock.calls[0];
      expect(call?.[0]).toBe(testCase.url);
      const init = call?.[1] as RequestInit | undefined;
      expect(init?.method ?? 'GET').toBe(testCase.method);
      if (testCase.sendBody !== undefined) {
        expect(JSON.parse(String(init?.body))).toEqual(testCase.sendBody);
      } else {
        expect(init?.body).toBeUndefined();
      }
      testCase.expectResult?.(result);
    });
  }
});
