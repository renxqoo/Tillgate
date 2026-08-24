/**
 * 动态 RBAC 路由契约测试（roles/permissions 管理面 + me/menus——docs/admin-rbac-dynamic §5）：
 * 信封/透传/守卫矩阵（super 全锁/内置删除拒/挂载拒/enforced 锁/码冲突/父子守卫）/
 * 审计旁路形状（postAudit 经 fakeDeps 缺省不可覆写,审计 diff 由 e2e 断言）。
 */
import { describe, expect, it, vi } from 'vitest';
import { controlPlaneErrors } from '@tillgate/control-plane';
import { createAdminApp } from '../src/app';
import { authHeader, fakeDeps } from './helpers';
import { defined } from './defined.js';

const json = { ...authHeader(), 'content-type': 'application/json' };

const roleRow = {
  id: 9,
  code: 'auditor',
  name: '审计员',
  description: null,
  status: 0,
  isSuper: false,
  isBuiltin: false,
  createdAt: new Date(0),
};

const node = {
  id: 51,
  parentId: 10,
  type: 'button' as const,
  code: 'custom:do',
  name: '自定义动作',
  i18nKey: null,
  description: null,
  path: null,
  icon: null,
  sortOrder: 9,
  status: 0,
  source: 'custom' as const,
  createdAt: new Date(0),
};

function wire(overrides?: {
  roles?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
}) {
  const rolesApi = {
    find: vi.fn(async () => roleRow),
    list: vi.fn(async () => ({
      rows: [{ ...roleRow, adminCount: 2, codes: ['users:read'] }],
      total: 1,
    })),
    create: vi.fn(async () => roleRow),
    update: vi.fn(async () => ({ role: roleRow, added: ['users:update'], removed: [] })),
    remove: vi.fn(async () => ({ ok: true as const })),
    ...overrides?.roles,
  };
  const permissionsApi = {
    tree: vi.fn(async () => [node]),
    create: vi.fn(async () => node),
    update: vi.fn(async () => node),
    remove: vi.fn(async () => ({ ok: true as const })),
    activeCodes: vi.fn(async () => ['users:read']),
    ...overrides?.permissions,
  };
  const app = createAdminApp(
    fakeDeps({
      controlPlane: {
        rbac: { roles: rolesApi, permissions: permissionsApi },
      } as never,
    }),
  );
  return { app, spies: { rolesApi, permissionsApi } };
}

describe('GET /v1/roles（统一列表契约）', () => {
  it('信封 + 查询透传（q/sort_by 白名单）;缺省 sort=id', async () => {
    const { app, spies } = wire();
    const res = await app.request('/v1/roles?page=2&page_size=5&q=审计&sort_by=code', {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 1, page: 2, pageSize: 5 });
    expect(spies.rolesApi.list).toHaveBeenCalledWith({
      q: '审计',
      sortBy: 'code',
      order: 'desc',
      limit: 5,
      offset: 5,
    });

    const bad = await app.request('/v1/roles?sort_by=hack', { headers: authHeader() });
    expect(bad.status).toBe(400);

    await app.request('/v1/roles', { headers: authHeader() });
    expect(spies.rolesApi.list).toHaveBeenLastCalledWith({
      sortBy: 'id',
      order: 'desc',
      limit: 20,
      offset: 0,
    });
  });
});

describe('POST/PATCH/DELETE /v1/roles', () => {
  it('创建:契约透传 + 201;code 冲突 409 透传', async () => {
    const { app, spies } = wire();
    const created = await app.request('/v1/roles', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ code: 'auditor', name: '审计员', permissions: ['users:read'] }),
    });
    expect(created.status).toBe(201);
    expect(spies.rolesApi.create).toHaveBeenCalledWith({
      code: 'auditor',
      name: '审计员',
      description: null,
      codes: ['users:read'],
    });

    const dup = wire({
      roles: {
        create: async () => {
          throw controlPlaneErrors.business('role_exists', { code: 'auditor' });
        },
      },
    }).app;
    const res = await dup.request('/v1/roles', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ code: 'auditor', name: 'x', permissions: [] }),
    });
    expect(res.status).toBe(409);
  });

  it('更新:守卫矩阵透传（super 全锁 403 / 挂载 409 / 不存在 404）;空补丁 400', async () => {
    for (const [code, status] of [
      ['role_immutable', 403],
      ['role_in_use', 409],
      ['role_not_found', 404],
    ] as const) {
      const { app } = wire({
        roles: {
          update: async () => {
            throw controlPlaneErrors.business(code, {});
          },
        },
      });
      const res = await app.request('/v1/roles/9', {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify({ name: 'x' }),
      });
      expect(res.status, code).toBe(status);
    }

    const empty = await wire().app.request('/v1/roles/9', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });

  it('PATCH 成功路径:审计 detail 含授权 diff 面与非授权面分支', async () => {
    const { app, spies } = wire();
    // 仅改 name（非授权面）与含 permissions（授权面）两条分支
    const onlyName = await app.request('/v1/roles/9', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ name: '只改名' }),
    });
    expect(onlyName.status).toBe(200);
    expect(spies.rolesApi.update).toHaveBeenCalledWith({ roleId: 9, name: '只改名' });

    const withGrants = await app.request('/v1/roles/9', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ permissions: ['users:read'], status: 1 }),
    });
    expect(withGrants.status).toBe(200);
    expect(spies.rolesApi.update).toHaveBeenCalledWith({
      roleId: 9,
      status: 1,
      codes: ['users:read'],
    });
  });

  it('契约面:code 太短 400;permissions 缺失 400;patchPermission 空补丁 400', async () => {
    const { app } = wire();
    expect(
      (
        await app.request('/v1/roles', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ code: 'a', name: 'x', permissions: [] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request('/v1/roles', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ code: 'valid-code', name: 'x' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request('/v1/permissions/51', {
          method: 'PATCH',
          headers: json,
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(400);
    // status 词表外（refine 分支）
    expect(
      (
        await app.request('/v1/roles/9', {
          method: 'PATCH',
          headers: json,
          body: JSON.stringify({ status: 7 }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request('/v1/permissions/51', {
          method: 'PATCH',
          headers: json,
          body: JSON.stringify({ status: 9 }),
        })
      ).status,
    ).toBe(400);
  });

  it('删除:守卫透传 + ok 信封', async () => {
    const { app, spies } = wire();
    const res = await app.request('/v1/roles/9', { method: 'DELETE', headers: authHeader() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(spies.rolesApi.remove).toHaveBeenCalledWith(9);

    const blocked = wire({
      roles: {
        remove: async () => {
          throw controlPlaneErrors.business('role_in_use', { adminCount: 3 });
        },
      },
    }).app;
    expect(
      (await blocked.request('/v1/roles/9', { method: 'DELETE', headers: authHeader() })).status,
    ).toBe(409);
  });
});

describe('permissions 管理面', () => {
  it('tree 信封 {rows};创建/更新/删除透传与守卫矩阵', async () => {
    const { app, spies } = wire();
    const tree = await app.request('/v1/permissions/tree', { headers: authHeader() });
    expect(tree.status).toBe(200);
    expect(await tree.json()).toMatchObject({ rows: [{ id: 51, code: 'custom:do' }] });

    const created = await app.request('/v1/permissions', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        parentId: 10,
        type: 'button',
        code: 'custom:do',
        name: 'x',
        sortOrder: 9,
      }),
    });
    expect(created.status).toBe(201);
    expect(spies.permissionsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'button', code: 'custom:do', parentId: 10 }),
    );

    const patched = await app.request('/v1/permissions/51', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ name: '改名' }),
    });
    expect(patched.status).toBe(200);

    expect(
      (await app.request('/v1/permissions/51', { method: 'DELETE', headers: authHeader() })).status,
    ).toBe(200);

    for (const [code, status] of [
      ['permission_code_taken', 409],
      ['permission_has_children', 409],
      ['permission_in_use', 409],
      ['invalid_permission_input', 400],
    ] as const) {
      const blocked = wire({
        permissions: {
          create: async () => {
            throw controlPlaneErrors.business(code, {});
          },
        },
      }).app;
      const res = await blocked.request('/v1/permissions', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          parentId: 10,
          type: 'button',
          code: 'c:d',
          name: 'x',
          sortOrder: 1,
        }),
      });
      expect(res.status, code).toBe(status);
    }
  });
});

describe('GET /v1/me/menus（自身域动态菜单）', () => {
  it('树按授权过滤:page 无码全员/有码按 grants;空组剔除;isSuper 全量', async () => {
    const pageAll = {
      ...node,
      id: 10,
      parentId: 1,
      type: 'page' as const,
      code: null,
      name: '概览',
      path: '/dashboard',
      icon: 'ChartBar',
      sortOrder: 1,
    };
    const pageGated = {
      ...node,
      id: 11,
      parentId: 1,
      type: 'page' as const,
      code: 'users:read',
      name: '用户',
      path: '/dashboard/users',
      icon: 'UsersRound',
      sortOrder: 2,
    };
    const group = {
      ...node,
      id: 1,
      parentId: null,
      type: 'group' as const,
      code: null,
      name: '总览',
      sortOrder: 1,
    };
    const { app } = wire({
      permissions: { tree: async () => [group, pageAll, pageGated] },
    });

    const me = await app.request('/v1/me/menus', { headers: authHeader() });
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      groups: { name: string; items: { name: string; path: string | null }[] }[];
    };
    // fakeDeps owner = isSuper → 全量树
    expect(body.groups).toHaveLength(1);
    expect(defined(body.groups[0], 'body.groups[0]').items.map((item) => item.name)).toEqual([
      '概览',
      '用户',
    ]);

    // 非超管授权面:码过滤生效（users:read 未授 → 仅无码页面;组非空保留）
    const base = fakeDeps({
      controlPlane: {
        rbac: {
          roles: { find: async () => roleRow },
          permissions: { tree: async () => [group, pageAll, pageGated] },
        },
      } as never,
    });
    const limited = createAdminApp({
      ...base,
      sessions: {
        validate: base.sessions.validate,
        owner: async () => ({ status: 0, grants: { isSuper: false, codes: [] } }),
      },
    });
    const res = await limited.request('/v1/me/menus', { headers: authHeader() });
    const filtered = (await res.json()) as {
      groups: { items: { name: string }[] }[];
    };
    expect(filtered.groups).toHaveLength(1);
    expect(
      defined(filtered.groups[0], 'filtered.groups[0]').items.map((item) => item.name),
    ).toEqual(['概览']);
  });

  it('停用节点剔除:group/page status=1 不进菜单树（kill-switch 同源）', async () => {
    const groupLive = {
      ...node,
      id: 1,
      parentId: null,
      type: 'group' as const,
      code: null,
      name: '在册组',
      sortOrder: 1,
    };
    const groupDead = { ...groupLive, id: 2, name: '停用组', status: 1 as never, sortOrder: 2 };
    const pageDead = {
      ...node,
      id: 11,
      parentId: 1,
      type: 'page' as const,
      code: 'users:read',
      name: '停用页',
      status: 1 as never,
      sortOrder: 1,
    };
    const pageLive = {
      ...node,
      id: 10,
      parentId: 1,
      type: 'page' as const,
      code: null,
      name: '活页',
      sortOrder: 2,
    };
    const base = fakeDeps({
      controlPlane: {
        rbac: {
          roles: { find: async () => roleRow },
          permissions: { tree: async () => [groupLive, groupDead, pageDead, pageLive] },
        },
      } as never,
    });
    const app = createAdminApp({
      ...base,
      sessions: {
        validate: base.sessions.validate,
        owner: async () => ({ status: 0, grants: { isSuper: true, codes: [] } }),
      },
    });
    const res = await app.request('/v1/me/menus', { headers: authHeader() });
    const body = (await res.json()) as { groups: { name: string; items: { name: string }[] }[] };
    expect(body.groups).toHaveLength(1); // 停用组整组剔除
    expect(defined(body.groups[0], 'body.groups[0]').name).toBe('在册组');
    expect(defined(body.groups[0], 'body.groups[0]').items.map((item) => item.name)).toEqual([
      '活页',
    ]); // 停用页剔除
  });
});
