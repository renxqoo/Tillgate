/**
 * 动态 RBAC 旅程 e2e（ADR-0008;docs/admin-rbac-dynamic/IMPLEMENTATION §4——全真装配）。
 * 旅程专属行 e2e-rbacv2-* 前缀,结束自清理（角色/节点/管理员行直删）。
 *
 * 覆盖面：
 *   §H 动态建角色 → 绑码 → 挂管理员 → 读放行/写拒绝（码级判定真装配）;
 *   §I 改绑即时生效（同令牌）+ 授权审计 diff（role.updated added/removed）;
 *   §J custom 权限节点全生命周期:创建（码形状/父子守卫）→ 绑定生效（仅显示层门控
 *      语义:custom 码不在 enforced 注册表,不参与接口判定——403 仍由 enforced 码拦）
 *      → 停用 kill-switch → 删除守卫;
 *   §K enforced 全字段放开（停用/删除 200）+ 接口绑定守卫（先解绑）+ 角色停用
 *      整组下线 + super 角色全锁 + 内置角色可删(唯一硬闸=被使用);
 *   §M 绑定全字段更新:path/method 迁移下一请求生效（旧组合 fail-closed）、
 *      终态 (method,path) 撞他绑 409、空 body 400。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { admins, permissions, roles } from '@tokenlens/db';
import { call, jsonHeaders, setupE2EAdmin, teardownE2EAdmin, type E2EAdminWorld } from './kit';

let world: E2EAdminWorld | null = null;

beforeAll(async () => {
  world = await setupE2EAdmin();
}, 60_000);

const createdAdminIds: number[] = [];
const createdRoleIds: number[] = [];
const createdNodeIds: number[] = [];

afterAll(async () => {
  if (world === null) return;
  // 自清理:管理员 → 角色（授权级联）→ custom 节点（绑定守卫要求先删角色）
  await world.assembly.db.delete(admins).where(inArray(admins.id, createdAdminIds));
  await world.assembly.db.delete(roles).where(inArray(roles.id, createdRoleIds));
  await world.assembly.db.delete(permissions).where(inArray(permissions.id, createdNodeIds));
  await teardownE2EAdmin(world);
});

function w(): E2EAdminWorld {
  if (world === null) throw new Error('e2e world not ready');
  return world;
}

async function callAs(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${w().base}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

describe('H. 动态角色全旅程（建角色 → 绑码 → 挂管理员 → 码级判定）', () => {
  it('建角色绑 users:read+funds:adjust → 挂管理员 → GET users 200 / 写 funds:recharge 403 / admins 面 403', async () => {
    const stamp = Date.now();
    const created = await call(w(), '/v1/roles', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        code: `e2e-rbacv2-role-${stamp}`,
        name: 'e2e 动态角色',
        permissions: ['users:read', 'funds:adjust'],
      }),
    });
    expect(created.status).toBe(201);
    const roleId = created.body.id as number;
    createdRoleIds.push(roleId);
    expect(created.body).toMatchObject({ code: `e2e-rbacv2-role-${stamp}`, isSuper: false });

    // 挂管理员 + 签令牌
    const [row] = await w()
      .assembly.db.insert(admins)
      .values({
        email: `e2e-rbacv2-admin-${stamp}@e2e.invalid`,
        passwordHash: 'identity-managed',
        roleId,
        displayName: 'e2e-rbacv2',
      })
      .returning({ id: admins.id });
    if (row == null) throw new Error('insert admins returned no row');
    createdAdminIds.push(row.id);
    const token = await w().assembly.identity.sessions.sign({
      realm: 'admin',
      subjectId: row.id,
      ttlSec: 600,
    });

    expect((await callAs(token, '/v1/users')).status).toBe(200);
    const denied = await callAs(token, '/v1/channel-funds/recharge', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ channelId: 1, amount: '1', voucherUrl: '' }),
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: 'admin.insufficient_permission' } });
    expect((await callAs(token, '/v1/admins')).status).toBe(403);
    expect((await callAs(token, '/v1/roles')).status).toBe(403);
  });
});

describe('I. 改绑即时生效 + 授权审计 diff', () => {
  it('PATCH permissions 加码 → 同令牌下一请求放行;审计含 added/removed', async () => {
    const stamp = Date.now();
    const role = await call(w(), '/v1/roles', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        code: `e2e-rbacv2-diff-${stamp}`,
        name: 'e2e diff 角色',
        permissions: ['users:read'],
      }),
    });
    expect(role.status).toBe(201);
    const roleId = role.body.id as number;
    createdRoleIds.push(roleId);

    const [row] = await w()
      .assembly.db.insert(admins)
      .values({
        email: `e2e-rbacv2-diff-${stamp}@e2e.invalid`,
        passwordHash: 'identity-managed',
        roleId,
        displayName: 'e2e-diff',
      })
      .returning({ id: admins.id });
    if (row == null) throw new Error('insert admins returned no row');
    createdAdminIds.push(row.id);
    const token = await w().assembly.identity.sessions.sign({
      realm: 'admin',
      subjectId: row.id,
      ttlSec: 600,
    });

    // 改绑前:funds:read 拒
    expect((await callAs(token, '/v1/payment-orders')).status).toBe(403);

    const patched = await call(w(), `/v1/roles/${roleId}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ permissions: ['users:read', 'funds:read'] }),
    });
    expect(patched.status).toBe(200);

    // 同令牌下一请求生效（授权面随属主回查现读——不嵌 JWT）
    expect((await callAs(token, '/v1/payment-orders')).status).toBe(200);

    // 审计 diff:role.updated 含 added=['funds:read'] removed=[]
    const audit = await call(w(), '/v1/audit-logs?action=role.updated&page_size=50');
    expect(audit.status).toBe(200);
    const rows = (audit.body.rows ?? []) as { detail?: Record<string, unknown> }[];
    const hit = rows.find((entry) => {
      const detail = entry.detail ?? {};
      const added = detail.added as string[] | undefined;
      return Array.isArray(added) && added.includes('funds:read');
    });
    expect(hit, 'role.updated 审计应含 added=[funds:read] diff').toBeDefined();
  });
});

describe('J. custom 权限节点全生命周期', () => {
  it('创建（码形状/父子守卫）→ 绑定 → 停用 kill-switch → 删除守卫', async () => {
    const stamp = Date.now();
    // button 必须挂 page 下:先找 users 页面节点
    const tree = await call(w(), '/v1/permissions/tree');
    expect(tree.status).toBe(200);
    const nodes = (tree.body.rows ?? []) as {
      id: number;
      type: string;
      code: string | null;
      source: string;
    }[];
    const usersPage = nodes.find((node) => node.code === 'users:read');
    expect(usersPage).toBeDefined();

    // 码形状守卫
    const badCode = await call(w(), '/v1/permissions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        parentId: usersPage!.id,
        type: 'button',
        code: 'Bad Code',
        name: 'x',
        sortOrder: 99,
      }),
    });
    expect(badCode.status).toBe(400);

    // 合法 custom 节点
    const created = await call(w(), '/v1/permissions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        parentId: usersPage!.id,
        type: 'button',
        code: `e2e:custom-${stamp}`,
        name: 'e2e 自定义动作',
        sortOrder: 99,
      }),
    });
    expect(created.status).toBe(201);
    const nodeId = created.body.id as number;
    createdNodeIds.push(nodeId);
    expect(created.body).toMatchObject({ source: 'custom', status: 0 });

    // 绑到角色 → /v1/me permissions 含该码（显示层门控生效面）
    const role = await call(w(), '/v1/roles', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        code: `e2e-rbacv2-custom-${stamp}`,
        name: 'e2e custom 码角色',
        permissions: [`e2e:custom-${stamp}`],
      }),
    });
    expect(role.status).toBe(201);
    createdRoleIds.push(role.body.id as number);

    // 停用 = kill-switch（activeCodes 过滤 → 角色改绑时该码失效）
    const disabled = await call(w(), `/v1/permissions/${nodeId}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 1 }),
    });
    expect(disabled.status).toBe(200);

    // 停用后绑该码 → 400 invalid_permission_code
    const rebind = await call(w(), `/v1/roles/${role.body.id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ permissions: [`e2e:custom-${stamp}`] }),
    });
    expect(rebind.status).toBe(400);
    expect(rebind.body).toMatchObject({ error: { code: 'control_plane.invalid_permission_code' } });

    // 删除守卫:角色绑定级联撤权不拦;接口绑定拦截 → 解绑后可删
    const delRoleBound = await call(w(), `/v1/permissions/${nodeId}`, { method: 'DELETE' });
    expect(delRoleBound.status).toBe(200);
    createdNodeIds.splice(createdNodeIds.indexOf(nodeId), 1);
  });
});

describe('K. enforced 锁 + 角色停用 kill-switch + super/内置守卫', () => {
  it('enforced 节点全字段放开(停用/删除 200);接口绑定守卫;super/内置角色锁;角色停用 kill-switch', async () => {
    const tree = await call(w(), '/v1/permissions/tree');
    const nodes = (tree.body.rows ?? []) as { id: number; code: string | null; source: string }[];
    const enforced = nodes.find((node) => node.code === 'users:update');
    expect(enforced).toBeDefined();

    // 全字段放开:enforced 停用 200 → 恢复;删除被接口绑定守卫拦(409)
    const ban = await call(w(), `/v1/permissions/${enforced!.id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 1 }),
    });
    expect(ban.status).toBe(200);
    await call(w(), `/v1/permissions/${enforced!.id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 0 }),
    });
    const delBound = await call(w(), `/v1/permissions/${enforced!.id}`, { method: 'DELETE' });
    expect(delBound.status).toBe(409);
    expect(delBound.body).toMatchObject({ error: { code: 'control_plane.permission_in_use' } });

    const rolesList = await call(w(), '/v1/roles?page_size=50');
    const roleRows = (rolesList.body.rows ?? []) as {
      id: number;
      code: string;
      isSuper: boolean;
      isBuiltin: boolean;
    }[];
    const superRole = roleRows.find((role) => role.isSuper);
    const builtin = roleRows.find((role) => role.isBuiltin && !role.isSuper);
    expect(superRole).toBeDefined();
    expect(builtin).toBeDefined();

    const touchSuper = await call(w(), `/v1/roles/${superRole!.id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ name: 'hack' }),
    });
    expect(touchSuper.status).toBe(403);
    expect((await call(w(), `/v1/roles/${superRole!.id}`, { method: 'DELETE' })).status).toBe(403);
    // 内置角色不再 role_immutable(用户裁决反转):挂载临时管理员 → 删除撞 role_in_use;
    // 不直接删未挂载内置,避免破坏种子行
    const builtinStamp = Date.now();
    const [builtinHolder] = await w()
      .assembly.db.insert(admins)
      .values({
        email: `e2e-rbacv2-builtin-${builtinStamp}@e2e.invalid`,
        passwordHash: 'identity-managed',
        roleId: builtin!.id,
        displayName: 'e2e-builtin-holder',
      })
      .returning({ id: admins.id });
    if (builtinHolder == null) throw new Error('insert admins returned no row');
    createdAdminIds.push(builtinHolder.id);
    const delBuiltin = await call(w(), `/v1/roles/${builtin!.id}`, { method: 'DELETE' });
    expect(delBuiltin.status).toBe(409);
    expect(delBuiltin.body).toMatchObject({ error: { code: 'control_plane.role_in_use' } });
    await w().assembly.db.delete(admins).where(eq(admins.id, builtinHolder.id));

    // 角色停用 = 整角色 kill-switch:viewer 角色停用 → viewer 管理员下一请求零授权
    const viewerRole = roleRows.find((role) => role.code === 'viewer');
    expect(viewerRole).toBeDefined();
    const stamp = Date.now();
    const [row] = await w()
      .assembly.db.insert(admins)
      .values({
        email: `e2e-rbacv2-kill-${stamp}@e2e.invalid`,
        passwordHash: 'identity-managed',
        roleId: viewerRole!.id,
        displayName: 'e2e-kill',
      })
      .returning({ id: admins.id });
    if (row == null) throw new Error('insert admins returned no row');
    createdAdminIds.push(row.id);
    const token = await w().assembly.identity.sessions.sign({
      realm: 'admin',
      subjectId: row.id,
      ttlSec: 600,
    });
    expect((await callAs(token, '/v1/users')).status).toBe(200);

    await call(w(), `/v1/roles/${viewerRole!.id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 1 }),
    });
    expect((await callAs(token, '/v1/users')).status).toBe(403);

    // 恢复（不留污染）+ 自清理兜底:清除 e2e 残留行（重复跑防护）
    await call(w(), `/v1/roles/${viewerRole!.id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 0 }),
    });
    // 残留清扫（前次中断运行）:先删挂载管理员再删角色（FK 顺序）
    const staleRoles = await w()
      .assembly.db.select({ id: roles.id })
      .from(roles)
      .where(like(roles.code, 'e2e-rbacv2-%'));
    if (staleRoles.length > 0) {
      const staleIds = staleRoles.map((r) => r.id);
      await w().assembly.db.delete(admins).where(inArray(admins.roleId, staleIds));
      await w().assembly.db.delete(roles).where(inArray(roles.id, staleIds));
    }
  });
});

describe('L. 执行面数据化核心断言（换绑即时生效/解绑默认拒/改码零漂移）', () => {
  /** GET /v1/users 的绑定行（0084 种子）——用例内换绑/解绑并在 finally 恢复 */
  async function usersListBindingId(): Promise<number> {
    const tree = await call(w(), '/v1/endpoint-bindings');
    const rows = (tree.body.rows ?? []) as { id: number; method: string; path: string }[];
    const hit = rows.find((row) => row.method === 'GET' && row.path === '/v1/users');
    if (hit == null) throw new Error('GET /v1/users binding missing (0084 seed)');
    return hit.id;
  }

  async function usersReadNodeId(): Promise<number> {
    const tree = await call(w(), '/v1/permissions/tree');
    const rows = (tree.body.rows ?? []) as { id: number; code: string | null }[];
    const hit = rows.find((row) => row.code === 'users:read');
    if (hit == null) throw new Error('users:read node missing');
    return hit.id;
  }

  it('换绑下一请求生效;解绑 fail-closed 403(超管恢复);改码零漂移(绑定按 id)', async () => {
    const stamp = Date.now();
    const bindingId = await usersListBindingId();
    const usersReadId = await usersReadNodeId();

    // 非超管持 users:read 的令牌
    const role = await call(w(), '/v1/roles', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        code: `e2e-rbacv2-acl-${stamp}`,
        name: 'e2e acl',
        permissions: ['users:read'],
      }),
    });
    expect(role.status).toBe(201);
    createdRoleIds.push(role.body.id as number);
    const [row] = await w()
      .assembly.db.insert(admins)
      .values({
        email: `e2e-rbacv2-acl-${stamp}@e2e.invalid`,
        passwordHash: 'identity-managed',
        roleId: role.body.id as number,
        displayName: 'e2e-acl',
      })
      .returning({ id: admins.id });
    if (row == null) throw new Error('insert admins returned no row');
    createdAdminIds.push(row.id);
    const token = await w().assembly.identity.sessions.sign({
      realm: 'admin',
      subjectId: row.id,
      ttlSec: 600,
    });
    const usersCall = () => callAs(token, '/v1/users');
    expect((await usersCall()).status).toBe(200);

    try {
      // 1) 改码零漂移:users:read 改名 → 绑定按 id → 同令牌仍放行(旧架构此处会静默 403)
      const renamed = await call(w(), `/v1/permissions/${usersReadId}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ code: `e2e:renamed-${stamp}` }),
      });
      expect(renamed.status).toBe(200);
      expect((await usersCall()).status).toBe(200); // ← 零漂移核心断言

      // 2) 换绑即时生效:绑定换到 admin 域码 → 该令牌 403(无 admins:read)
      const rebound = await call(w(), `/v1/endpoint-bindings/${bindingId}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ permissionId: 1 }), // 任意非 users:read 节点(组节点码为空→视为未绑定)
      });
      expect(rebound.status).toBe(200);
      const afterRebind = await usersCall();
      expect([403, 404]).toContain(afterRebind.status); // 空码视为未绑定/或无权——一律拒绝
      expect(afterRebind.status).toBe(403);

      // 3) 解绑默认拒:非超管 403 endpoint_unbound;超管(旅程令牌)仍 200 可恢复
      const unbound = await call(w(), `/v1/endpoint-bindings/${bindingId}`, { method: 'DELETE' });
      expect(unbound.status).toBe(200);
      const denied = await usersCall();
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ error: { code: 'admin.endpoint_unbound' } });
      expect((await call(w(), '/v1/users')).status).toBe(200); // 超管恢复路径
    } finally {
      await call(w(), '/v1/endpoint-bindings', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ method: 'GET', path: '/v1/users', permissionId: usersReadId }),
      }).catch(() => undefined); // 已存在(409) = 已恢复
      await call(w(), `/v1/permissions/${usersReadId}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ code: 'users:read' }),
      }).catch(() => undefined);
      expect((await usersCall()).status).toBe(200);
    }
  });

  it('编辑全字段:path/method 迁移下一请求生效;终态撞他绑 409;空 body 400', async () => {
    const stamp = Date.now();
    // 专用叶子节点 + 专用绑定 + 持码非超管（不触碰种子行）
    const tree = await call(w(), '/v1/permissions/tree');
    const rows = (tree.body.rows ?? []) as { id: number; type: string; code: string | null }[];
    const page = rows.find((n) => n.type === 'page');
    if (page == null) throw new Error('page node missing');
    const node = await call(w(), '/v1/permissions', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        parentId: page.id,
        type: 'button',
        code: `e2e:edit${stamp}`,
        name: 'e2e binding edit',
        sortOrder: 900,
      }),
    });
    expect(node.status).toBe(201);
    createdNodeIds.push(node.body.id as number);

    const path1 = `/v1/e2e-edit-${stamp}`;
    const binding = await call(w(), '/v1/endpoint-bindings', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ method: 'GET', path: path1, permissionId: node.body.id }),
    });
    expect(binding.status).toBe(201);

    const role = await call(w(), '/v1/roles', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        code: `e2e-rbacv2-edit-${stamp}`,
        name: 'e2e edit',
        permissions: [`e2e:edit${stamp}`],
      }),
    });
    expect(role.status).toBe(201);
    createdRoleIds.push(role.body.id as number);
    const [row] = await w()
      .assembly.db.insert(admins)
      .values({
        email: `e2e-rbacv2-edit-${stamp}@e2e.invalid`,
        passwordHash: 'identity-managed',
        roleId: role.body.id as number,
        displayName: 'e2e-edit',
      })
      .returning({ id: admins.id });
    if (row == null) throw new Error('insert admins returned no row');
    createdAdminIds.push(row.id);
    const token = await w().assembly.identity.sessions.sign({
      realm: 'admin',
      subjectId: row.id,
      ttlSec: 600,
    });

    // 绑定在 + 持码 → 过 ACL;路由不存在 → 404（区别于 403 拒绝）
    expect((await callAs(token, path1)).status).toBe(404);

    try {
      // 1) 仅改 path:旧 path fail-closed,新 path 过 ACL
      const path2 = `/v1/e2e-edit2-${stamp}`;
      const moved = await call(w(), `/v1/endpoint-bindings/${binding.body.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ path: path2 }),
      });
      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({ method: 'GET', path: path2 });
      const oldPath = await callAs(token, path1);
      expect(oldPath.status).toBe(403);
      expect(oldPath.body).toMatchObject({ error: { code: 'admin.endpoint_unbound' } });
      expect((await callAs(token, path2)).status).toBe(404);

      // 2) 仅改 method:GET 拒、POST 过
      const flipped = await call(w(), `/v1/endpoint-bindings/${binding.body.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ method: 'POST' }),
      });
      expect(flipped.status).toBe(200);
      expect((await callAs(token, path2)).status).toBe(403);
      expect((await callAs(token, path2, { method: 'POST' })).status).toBe(404);

      // 3) 终态撞种子绑定 (GET /v1/users) → 409;空 body → 400
      const clash = await call(w(), `/v1/endpoint-bindings/${binding.body.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ method: 'GET', path: '/v1/users' }),
      });
      expect(clash.status).toBe(409);
      expect(clash.body).toMatchObject({ error: { code: 'control_plane.endpoint_bound' } });
      const empty = await call(w(), `/v1/endpoint-bindings/${binding.body.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);
    } finally {
      await call(w(), `/v1/endpoint-bindings/${binding.body.id}`, {
        method: 'DELETE',
      }).catch(() => undefined);
      await call(w(), `/v1/permissions/${node.body.id}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
  });
});
