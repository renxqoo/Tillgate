/**
 * 管理员管理面契约测试（RBAC admins 域——docs/admin-rbac/DESIGN §2.5）：
 * 列表信封/创建双动词编排（含凭据被占补偿回滚——不留废号）/PATCH 部分更新 +
 * 自改守卫（D6）/权限面（非 super_admin 403——admins 域独占）。
 * 审计旁路形状由 e2e/admin/rbac 真装配断言（fakeDeps 的 postAudit 缺省不可覆写）。
 */
import { describe, expect, it, vi } from 'vitest';
import { identityErrors } from '@tokenlens/identity';
import { controlPlaneErrors } from '@tokenlens/control-plane';
import { createAdminApp } from '../src/app';
import { ADMIN_ID, authHeader, fakeDeps } from './helpers';

const json = { ...authHeader(), 'content-type': 'application/json' };

const record = {
  id: 1_000_000_001,
  email: 'new@tokenlens.dev',
  displayName: 'New',
  status: 0,
  role: 'operator' as 'operator' | 'viewer',
  twoFactorEnabled: false,
  lastLoginAt: null,
  createdAt: new Date(0),
};

function wire(overrides?: {
  create?: () => Promise<typeof record>;
  register?: () => Promise<unknown>;
  update?: () => Promise<typeof record | null>;
  list?: () => Promise<{ rows: (typeof record)[]; total: number }>;
}) {
  const create = vi.fn(overrides?.create ?? (async () => record));
  const register = vi.fn(
    overrides?.register ?? (async () => ({ credentialId: 9, replayed: false })),
  );
  const remove = vi.fn(async () => undefined);
  const update = vi.fn(overrides?.update ?? (async () => record));
  const list = vi.fn(overrides?.list ?? (async () => ({ rows: [record], total: 1 })));
  const app = createAdminApp(
    fakeDeps({
      controlPlane: { admins: { list, create, update, remove } },
      identity: { credentials: { register } },
    }),
  );
  return { app, spies: { create, register, remove, update, list } };
}

const createBody = {
  email: 'New@TokenLens.dev ',
  displayName: 'New',
  password: 'initial-pass-123',
  role: 'operator',
};

describe('GET /v1/admins（统一列表契约）', () => {
  it('信封 {rows,total,page,pageSize};wire 投影含 role 不含密码列;查询参数透传 store', async () => {
    const { app, spies } = wire();
    const res = await app.request('/v1/admins?page=2&page_size=5&q=ops&sort_by=email&order=desc', {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Record<string, unknown>[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body).toMatchObject({ total: 1, page: 2, pageSize: 5 });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ id: record.id, role: 'operator', status: 0 });
    expect(Object.keys(body.rows[0]!)).not.toContain('passwordHash');
    expect(spies.list).toHaveBeenCalledWith({
      q: 'ops',
      sortBy: 'email',
      order: 'desc',
      limit: 5,
      offset: 5,
    });
  });

  it('排序白名单外 400 invalid_sort_field;缺省 sort_by=id asc', async () => {
    const { app, spies } = wire();
    const bad = await app.request('/v1/admins?sort_by=passwordHash', { headers: authHeader() });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'admin.invalid_sort_field',
    );
    expect(spies.list).not.toHaveBeenCalled();

    const def = await app.request('/v1/admins', { headers: authHeader() });
    expect(def.status).toBe(200);
    // 缺省 = sort_by:id + listQuerySchema 缺省序 desc/页 20（统一列表契约口径）
    expect(spies.list).toHaveBeenCalledWith({
      sortBy: 'id',
      order: 'desc',
      limit: 20,
      offset: 0,
    });
  });

  it('权限面:viewer 403（admins 域仅 super_admin）', async () => {
    const base = fakeDeps({
      controlPlane: {
        admins: { list: async () => ({ rows: [], total: 0 }) },
      },
    });
    const viewerApp = createAdminApp({
      ...base,
      sessions: {
        validate: base.sessions.validate,
        owner: async () => ({ status: 0, role: 'viewer' }),
      },
    });
    const res = await viewerApp.request('/v1/admins', { headers: authHeader() });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'admin.insufficient_permission',
    );
  });
});

describe('POST /v1/admins（双动词编排）', () => {
  it('成功:资料行（email 归一）→ 凭据注册 → 201', async () => {
    const { app, spies } = wire();
    const res = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: record.id, role: 'operator' });
    expect(spies.create).toHaveBeenCalledWith({
      email: 'new@tokenlens.dev',
      displayName: 'New',
      role: 'operator',
    });
    expect(spies.register).toHaveBeenCalledWith({
      userId: record.id,
      identifier: { kind: 'email', value: 'new@tokenlens.dev' },
      password: 'initial-pass-123',
    });
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it('凭据被占（identity.identifier_taken）→ 补偿删行 + 409 admin_email_taken', async () => {
    const { app, spies } = wire({
      register: async () => {
        throw identityErrors.business('identifier_taken', { kind: 'email', value: 'x' });
      },
    });
    const res = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'control_plane.admin_email_taken',
    );
    expect(spies.remove).toHaveBeenCalledWith(record.id);
  });

  it('资料行重名（control_plane.admin_email_taken）→ 409,不碰 identity/补偿', async () => {
    const { app, spies } = wire({
      create: async () => {
        throw controlPlaneErrors.business('admin_email_taken', { email: 'x' });
      },
    });
    const res = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(409);
    expect(spies.register).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it('契约面:角色词表外 400;缺 role 400', async () => {
    const { app } = wire();
    const badRole = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ ...createBody, role: 'boss' }),
    });
    expect(badRole.status).toBe(400);
    const missing = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'a@b.dev', password: 'x'.repeat(12) }),
    });
    expect(missing.status).toBe(400);
  });
});

describe('PATCH /v1/admins/:id', () => {
  it('改角色/封禁透传(update 收窄补丁);未命中 404 admin.admin_not_found', async () => {
    const { app, spies } = wire({ update: async () => ({ ...record, role: 'viewer', status: 1 }) });
    const res = await app.request(`/v1/admins/${record.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ role: 'viewer', status: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'viewer', status: 1 });
    expect(spies.update).toHaveBeenCalledWith({
      adminId: record.id,
      role: 'viewer',
      status: 1,
    });

    const missApp = wire({ update: async () => null }).app;
    const missing = await missApp.request('/v1/admins/999', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ role: 'viewer' }),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'admin.admin_not_found',
    );
  });

  it('空补丁 400;status 词表外 400', async () => {
    const { app } = wire();
    const empty = await app.request(`/v1/admins/${record.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    const badStatus = await app.request(`/v1/admins/${record.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 7 }),
    });
    expect(badStatus.status).toBe(400);
  });

  it('自改守卫（D6）:改自身 role/status 400 cannot_modify_self;displayName 可改自身', async () => {
    const { app, spies } = wire();
    const self = await app.request(`/v1/admins/${ADMIN_ID}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ role: 'viewer' }),
    });
    expect(self.status).toBe(400);
    expect(((await self.json()) as { error: { code: string } }).error.code).toBe(
      'admin.cannot_modify_self',
    );
    expect(spies.update).not.toHaveBeenCalled();

    const selfBan = await app.request(`/v1/admins/${ADMIN_ID}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 1 }),
    });
    expect(selfBan.status).toBe(400);

    const selfName = await app.request(`/v1/admins/${ADMIN_ID}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ displayName: 'Me' }),
    });
    expect(selfName.status).toBe(200);
    expect(spies.update).toHaveBeenCalledWith({ adminId: ADMIN_ID, displayName: 'Me' });
  });
});
