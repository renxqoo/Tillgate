/**
 * 接口绑定管理路由契约（ADR-0009）:信封/守卫透传（endpoint_bound/permission_not_found/
 * endpoint_not_found）/审计旁路。绑定判定本身由 acl.test 覆盖。
 */
import { describe, expect, it, vi } from 'vitest';
import { controlPlaneErrors } from '@tillgate/control-plane';
import { createAdminApp } from '../src/app';
import { authHeader, fakeDeps } from './helpers';

const json = { ...authHeader(), 'content-type': 'application/json' };

const row = {
  id: 5,
  method: 'GET' as const,
  path: '/v1/things',
  permissionId: 10,
  source: 'custom' as const,
  createdAt: new Date(0),
};

function wire(overrides?: Record<string, unknown>) {
  const endpoints = {
    list: vi.fn(async () => [row]),
    create: vi.fn(async () => row),
    update: vi.fn(async () => ({ ...row, permissionId: 20 })),
    remove: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
  const app = createAdminApp(
    fakeDeps({
      controlPlane: {
        rbac: {
          roles: {},
          permissions: {},
          endpoints,
        },
      } as never,
    }),
  );
  return { app, spies: endpoints };
}

describe('endpoints 管理面', () => {
  it('GET 列表 {rows};POST 创建透传 + 201', async () => {
    const { app, spies } = wire();
    expect((await app.request('/v1/endpoint-bindings', { headers: authHeader() })).status).toBe(
      200,
    );
    const created = await app.request('/v1/endpoint-bindings', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ method: 'GET', path: '/v1/things', permissionId: 10 }),
    });
    expect(created.status).toBe(201);
    expect(spies.create).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/things',
      permissionId: 10,
    });
  });

  it('守卫矩阵透传:endpoint_bound 409/permission_not_found 404+400/endpoint_not_found 404;契约 400', async () => {
    for (const [code, status] of [
      ['endpoint_bound', 409],
      ['permission_not_found', 404],
      ['invalid_endpoint_input', 400],
    ] as const) {
      const { app } = wire({
        create: async () => {
          throw controlPlaneErrors.business(code, {});
        },
      });
      const res = await app.request('/v1/endpoint-bindings', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ method: 'GET', path: '/v1/x', permissionId: 1 }),
      });
      expect(res.status, code).toBe(status);
    }

    const badBody = await wire().app.request('/v1/endpoint-bindings', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ method: 'BANANA', path: '/v1/x', permissionId: 1 }),
    });
    expect(badBody.status).toBe(400);
  });

  it('PATCH 部分更新透传（单字段=换绑/全字段）;未命中 404;DELETE 解绑', async () => {
    const { app, spies } = wire();
    const rebound = await app.request('/v1/endpoint-bindings/5', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ permissionId: 20 }),
    });
    expect(rebound.status).toBe(200);
    expect(await rebound.json()).toMatchObject({ permissionId: 20 });
    expect(spies.update).toHaveBeenCalledWith(5, { permissionId: 20 });

    const edited = await app.request('/v1/endpoint-bindings/5', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ method: 'POST', path: '/v1/things2', permissionId: 30 }),
    });
    expect(edited.status).toBe(200);
    expect(spies.update).toHaveBeenCalledWith(5, {
      method: 'POST',
      path: '/v1/things2',
      permissionId: 30,
    });

    // 空 body（三字段均缺）→ 契约 400
    const empty = await app.request('/v1/endpoint-bindings/5', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    expect(
      (await app.request('/v1/endpoint-bindings/5', { method: 'DELETE', headers: authHeader() }))
        .status,
    ).toBe(200);

    const miss = wire({
      update: async () => null,
    }).app;
    expect(
      (
        await miss.request('/v1/endpoint-bindings/404', {
          method: 'PATCH',
          headers: json,
          body: JSON.stringify({ permissionId: 20 }),
        })
      ).status,
    ).toBe(404);
  });
});
