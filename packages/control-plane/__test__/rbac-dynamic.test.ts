/**
 * 动态 RBAC 契约测试：
 *   1. enforced 注册表封闭性——43 码全量、无重复、域词表合法、与迁移种子逐码对账
 *      （迁移 SQL 文本解析,双源一致性锁死——种子漂移即红）;
 *   2. granted() 判定原语（isSuper 短路 / 集合包含 / 未知码拒绝）;
 *   3. roles/permissions/endpoints 用例族守卫矩阵（super 全锁/挂载守卫/码冲突/
 *      子节点守卫/绑定守卫/授权 diff）。
 */
import { readFileSync } from 'node:fs';
import { defined } from './defined';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENFORCED_CODES, PERMISSION_DOMAINS, granted, type AdminGrants } from '../src/domain/rbac';
import { createRole } from '../src/application/rbac/create-role';
import { updateRole } from '../src/application/rbac/update-role';
import { deleteRole } from '../src/application/rbac/delete-role';
import { createPermission } from '../src/application/rbac/create-permission';
import { createEndpointBinding } from '../src/application/rbac/create-endpoint-binding';
import { updateEndpointBinding } from '../src/application/rbac/update-endpoint-binding';
import { deleteEndpointBinding } from '../src/application/rbac/delete-endpoint-binding';
import { updatePermission } from '../src/application/rbac/update-permission';
import { deletePermission } from '../src/application/rbac/delete-permission';
import {
  createMemoryEndpointStore,
  createMemoryPermissionStore,
  createMemoryRoleStore,
} from './memory';
import type { PermissionNode, RoleRecord } from '../src/ports/rbac-store';

describe('enforced 注册表封闭性（增量至 44 码——含 funds:fx）', () => {
  it('全量清单逐一列出,无重复,域前缀合法', () => {
    expect([...ENFORCED_CODES]).toHaveLength(44);
    expect(new Set(ENFORCED_CODES).size).toBe(44);
    for (const code of ENFORCED_CODES) {
      const domain = defined(code.split(':')[0]);
      expect(PERMISSION_DOMAINS).toContain(domain);
    }
    // 读码恰 8 个（每域一个,与 8 域一一对应）
    const reads = ENFORCED_CODES.filter((code) => code.endsWith(':read'));
    expect(reads).toHaveLength(8);
    for (const domain of PERMISSION_DOMAINS) {
      expect(ENFORCED_CODES).toContain(`${domain}:read` as never);
    }
  });

  it('注册表 ↔ 0082 迁移种子逐码对账（双源一致性——种子漂移即红）', () => {
    const sql = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'db',
        'migrations',
        '0082_rbac_v2.sql',
      ),
      'utf8',
    );
    // 0087/0096 追加种子（集成写权限拆分/透支地板）并入对账面——双源 = 注册表 ↔ 全部权限种子迁移
    const extraSeeds = [
      '0087_settings_integrations_permission.sql',
      '0096_debit_floor_admin.sql',
      '0100_funds_center_module.sql',
    ]
      .map((file) =>
        readFileSync(join(import.meta.dirname, '..', '..', 'db', 'migrations', file), 'utf8'),
      )
      .join('');
    const seeded = new Set(
      [...(sql + extraSeeds).matchAll(/'([a-z]+:[a-z-]+)'/g)].map((match) => defined(match[1])),
    );
    for (const code of ENFORCED_CODES) {
      expect(seeded.has(code), `seed missing: ${code}`).toBe(true);
    }
    // 种子授权引用的码 ⊆ 注册表（防种子引出幽灵码）
    for (const code of seeded) {
      expect(
        (ENFORCED_CODES as readonly string[]).includes(code) || !code.includes(':read'),
        `seed references unknown code: ${code}`,
      ).toBe(true);
    }
  });
});

describe('granted() 判定原语', () => {
  it('isSuper 短路全量;集合包含;未知码/未授权拒绝', () => {
    const superGrants: AdminGrants = { isSuper: true, codes: [] };
    expect(granted(superGrants, 'admins:delete')).toBe(true);
    expect(granted(superGrants, 'anything:not-in-registry')).toBe(true);

    const finance: AdminGrants = { isSuper: false, codes: ['funds:read', 'funds:adjust'] };
    expect(granted(finance, 'funds:read')).toBe(true);
    expect(granted(finance, 'funds:adjust')).toBe(true);
    expect(granted(finance, 'funds:recharge')).toBe(false);
    expect(granted(finance, 'admins:read')).toBe(false);
  });
});

// ── 用例族装置 ──────────────────────────────────────────────────────────────

const ROLE_SUPER: RoleRecord = {
  id: 1,
  code: 'super_admin',
  name: '超级管理员',
  description: null,
  status: 0,
  isSuper: true,
  isBuiltin: true,
  createdAt: new Date(0),
};
const ROLE_OPERATOR: RoleRecord = {
  id: 2,
  code: 'operator',
  name: '运营',
  description: null,
  status: 0,
  isSuper: false,
  isBuiltin: true,
  createdAt: new Date(0),
};

function enforcedParentId(type: PermissionNode['type']): number | null {
  if (type === 'group') return null;
  if (type === 'page') return 1;
  return 10;
}

const enforcedNode = (
  id: number,
  code: string | null,
  type: PermissionNode['type'],
): PermissionNode => ({
  id,
  parentId: enforcedParentId(type),
  type,
  code,
  name: code ?? 'group',
  i18nKey: null,
  description: null,
  path: null,
  icon: null,
  sortOrder: 0,
  status: 0,
  source: 'enforced',
  createdAt: new Date(0),
});

function rbacSetup() {
  const roleStore = createMemoryRoleStore([ROLE_SUPER, ROLE_OPERATOR]);
  const permissionStore = createMemoryPermissionStore([
    enforcedNode(1, null, 'group'),
    enforcedNode(10, 'users:read', 'page'),
    enforcedNode(11, 'users:update', 'button'),
    enforcedNode(20, 'funds:read', 'page'),
  ]);
  const endpointStore = createMemoryEndpointStore();
  return {
    deps: {
      db: { transaction: (fn: (tx: unknown) => unknown) => fn({}) } as never,
      stores: { role: roleStore, permission: permissionStore, endpoint: endpointStore },
    },
    roleStore,
    permissionStore,
    endpointStore,
  };
}

describe('roles 用例族守卫矩阵', () => {
  it('create:码校验 + code 唯一;update:授权全量替换带 added/removed diff', async () => {
    const { deps } = rbacSetup();
    const created = await createRole(deps, {
      code: 'Auditor',
      name: '审计员',
      description: null,
      codes: ['users:read', 'funds:read'],
    });
    expect(created.code).toBe('auditor'); // code 归一小写

    await expect(
      createRole(deps, { code: 'auditor', name: 'x', description: null, codes: [] }),
    ).rejects.toMatchObject({ code: 'control_plane.role_exists' });
    await expect(
      createRole(deps, { code: 'bad role', name: 'x', description: null, codes: [] }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_role_input' });
    await expect(
      createRole(deps, { code: 'ghost', name: 'x', description: null, codes: ['nope:read'] }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_permission_code' });

    const result = await updateRole(deps, {
      roleId: created.id,
      codes: ['users:read', 'users:update'],
    });
    expect(result.added).toEqual(['users:update']);
    expect(result.removed).toEqual(['funds:read']);
  });

  it('update:super 全锁（任何字段）;status 词表外拒绝;停用 = kill-switch 语义放行', async () => {
    const { deps } = rbacSetup();
    await expect(updateRole(deps, { roleId: 1, name: 'x' })).rejects.toMatchObject({
      code: 'control_plane.role_immutable',
    });
    await expect(updateRole(deps, { roleId: 2, status: 7 as never })).rejects.toMatchObject({
      code: 'control_plane.invalid_role_input',
    });
    await expect(updateRole(deps, { roleId: 2, status: 1 })).resolves.toMatchObject({
      role: { status: 1 },
    });
    await expect(updateRole(deps, { roleId: 404, name: 'x' })).rejects.toMatchObject({
      code: 'control_plane.role_not_found',
    });
  });

  it('delete:super 拒;内置未挂载可删(用户裁决反转);有挂载管理员拒;自定义角色可删', async () => {
    const { deps, roleStore } = rbacSetup();
    await expect(deleteRole(deps, 1)).rejects.toMatchObject({
      code: 'control_plane.role_immutable',
    });
    // 内置(预置)角色不再不可删——唯一硬闸 = 被使用;未挂载直接删成
    const { deps: deps2 } = rbacSetup();
    await expect(deleteRole(deps2, 2)).resolves.toMatchObject({ ok: true });

    const created = await createRole(deps, {
      code: 'temp',
      name: '临时',
      description: null,
      codes: [],
    });
    roleStore.setAdminCount(created.id, 3);
    await expect(deleteRole(deps, created.id)).rejects.toMatchObject({
      code: 'control_plane.role_in_use',
    });
    roleStore.setAdminCount(created.id, 0);
    await expect(deleteRole(deps, created.id)).resolves.toMatchObject({ ok: true });
  });
});

describe('permissions 用例族守卫矩阵', () => {
  it('create:码形状/全局唯一/父子类型/层级守卫（button 挂 page,page 挂 group）', async () => {
    const { deps } = rbacSetup();
    const created = await createPermission(deps, {
      parentId: 10,
      type: 'button',
      code: 'users:export',
      name: '导出用户',
      i18nKey: null,
      description: null,
      path: null,
      icon: null,
      sortOrder: 9,
    });
    expect(created.source).toBe('custom');

    // 码形状非法 / 重复 / button 挂 group / page 挂 page / button 顶层
    await expect(
      createPermission(deps, {
        parentId: 10,
        type: 'button',
        code: 'Bad Code',
        name: 'x',
        i18nKey: null,
        description: null,
        path: null,
        icon: null,
        sortOrder: 0,
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_permission_input' });
    await expect(
      createPermission(deps, {
        parentId: 10,
        type: 'button',
        code: 'users:update',
        name: 'x',
        i18nKey: null,
        description: null,
        path: null,
        icon: null,
        sortOrder: 0,
      }),
    ).rejects.toMatchObject({ code: 'control_plane.permission_code_taken' });
    await expect(
      createPermission(deps, {
        parentId: 1,
        type: 'button',
        code: 'a:b',
        name: 'x',
        i18nKey: null,
        description: null,
        path: null,
        icon: null,
        sortOrder: 0,
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_permission_input' });
    await expect(
      createPermission(deps, {
        parentId: 10,
        type: 'page',
        code: 'c:d',
        name: 'x',
        i18nKey: null,
        description: null,
        path: '/x',
        icon: null,
        sortOrder: 0,
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_permission_input' });
    await expect(
      createPermission(deps, {
        parentId: null,
        type: 'button',
        code: 'e:f',
        name: 'x',
        i18nKey: null,
        description: null,
        path: null,
        icon: null,
        sortOrder: 0,
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_permission_input' });
  });

  it('update:全字段可改（含 enforced）——码/类型/父子/来源/状态;结构合法性仍校验', async () => {
    const { deps } = rbacSetup();
    // enforced 停用放行 + 改名 + 改码
    await expect(updatePermission(deps, { id: 11, status: 1 })).resolves.toMatchObject({
      status: 1,
    });
    await expect(updatePermission(deps, { id: 11, name: '改个名' })).resolves.toMatchObject({
      name: '改个名',
    });
    await expect(updatePermission(deps, { id: 11, code: 'users:rename' })).resolves.toMatchObject({
      code: 'users:rename',
    });
    await expect(updatePermission(deps, { id: 11, code: 'users:read' })).rejects.toMatchObject({
      code: 'control_plane.permission_code_taken',
    });
    await expect(updatePermission(deps, { id: 11, code: 'bad code' })).rejects.toMatchObject({
      code: 'control_plane.invalid_permission_input',
    });
    // 改码回原值不判重（排除自身）
    await expect(updatePermission(deps, { id: 11, code: 'users:update' })).resolves.toMatchObject({
      code: 'users:update',
    });
    // 父子一致性:button 挂 group 拒;顶层 button 拒;group 带父拒;group 带码拒
    await expect(updatePermission(deps, { id: 11, parentId: 1 })).rejects.toMatchObject({
      code: 'control_plane.invalid_permission_input',
    });
    await expect(updatePermission(deps, { id: 11, parentId: null })).rejects.toMatchObject({
      code: 'control_plane.invalid_permission_input',
    });
    await expect(
      updatePermission(deps, { id: 1, type: 'group', parentId: 10 }),
    ).rejects.toMatchObject({
      code: 'control_plane.invalid_permission_input',
    });
    await expect(
      updatePermission(deps, { id: 1, type: 'group', code: 'a:bb' }),
    ).rejects.toMatchObject({
      code: 'control_plane.invalid_permission_input',
    });
    // 合法迁移:button(id 11)改 page 挂 group(1) 且去码
    await expect(
      updatePermission(deps, { id: 11, type: 'page', parentId: 1, code: null }),
    ).resolves.toMatchObject({ type: 'page', parentId: 1 });
    // source 词表外拒;未命中 404
    await expect(
      updatePermission(deps, { id: 11, source: 'magic' as never }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_permission_input' });
    await expect(updatePermission(deps, { id: 404, name: 'x' })).rejects.toMatchObject({
      code: 'control_plane.permission_not_found',
    });
  });

  it('delete:全节点可删（enforced 同权,绑定级联撤权）;有子节点仍拒（自底向上）', async () => {
    const { deps, permissionStore } = rbacSetup();
    // 接口绑定守卫:仍守护接口时拒删（先解绑/换绑——角色绑定级联不拦）
    await createEndpointBinding(deps, {
      method: 'GET',
      path: '/v1/e2e-guard',
      permissionId: 11,
    });
    await expect(deletePermission(deps, 11)).rejects.toMatchObject({
      code: 'control_plane.permission_in_use',
    });
    // enforced 叶子解除绑定后可删
    await expect(deletePermission(deps, 11)).rejects.toMatchObject({
      code: 'control_plane.permission_in_use',
    });
    // 有子节点拒（group 1 下有 page）
    await expect(deletePermission(deps, 1)).rejects.toMatchObject({
      code: 'control_plane.permission_has_children',
    });
    await expect(deletePermission(deps, 404)).rejects.toMatchObject({
      code: 'control_plane.permission_not_found',
    });
    // custom 叶子照旧可删
    const custom = await createPermission(deps, {
      parentId: 10,
      type: 'button',
      code: 'custom:do',
      name: 'x',
      i18nKey: null,
      description: null,
      path: null,
      icon: null,
      sortOrder: 0,
    });
    permissionStore.setBinding(custom.id, 0);
    await expect(deletePermission(deps, custom.id)).resolves.toMatchObject({ ok: true });
  });
});

describe('endpoints 用例族（接口绑定——执行面数据化）', () => {
  it('创建:path 形状/唯一性/权限存在性守卫;update 部分字段+终态唯一守卫;remove 生命周期', async () => {
    const { deps, endpointStore } = rbacSetup();
    const created = await createEndpointBinding(deps, {
      method: 'GET',
      path: '/v1/things',
      permissionId: 10,
    });
    expect(created).toMatchObject({ method: 'GET', path: '/v1/things', permissionId: 10 });

    await expect(
      createEndpointBinding(deps, { method: 'GET', path: '/v1/things', permissionId: 10 }),
    ).rejects.toMatchObject({ code: 'control_plane.endpoint_bound' });
    await expect(
      createEndpointBinding(deps, { method: 'GET', path: 'bad path', permissionId: 10 }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_endpoint_input' });
    await expect(
      createEndpointBinding(deps, { method: 'GET', path: '/v1/other', permissionId: 404 }),
    ).rejects.toMatchObject({ code: 'control_plane.permission_not_found' });

    // 部分更新:仅传 permissionId（换绑语义）;method/path 未传不动
    const rebound = await updateEndpointBinding(deps, created.id, { permissionId: 20 });
    expect(rebound).toMatchObject({ permissionId: 20, method: 'GET', path: '/v1/things' });
    // 部分更新:仅传 method/path（执行面迁移）;未传字段不动
    const moved = await updateEndpointBinding(deps, created.id, {
      method: 'POST',
      path: '/v1/things2',
    });
    expect(moved).toMatchObject({ method: 'POST', path: '/v1/things2', permissionId: 20 });
    // 终态唯一守卫:撞其他绑定拒;排除自身——单字段 no-op 与完整终态重复均放行
    const clash = await createEndpointBinding(deps, {
      method: 'GET',
      path: '/v1/clash',
      permissionId: 10,
    });
    await expect(
      updateEndpointBinding(deps, created.id, { method: 'GET', path: '/v1/clash' }),
    ).rejects.toMatchObject({ code: 'control_plane.endpoint_bound' });
    await expect(updateEndpointBinding(deps, created.id, { method: 'GET' })).resolves.toMatchObject(
      { method: 'GET', path: '/v1/things2' },
    );
    // path 形状守卫 + 存在性守卫
    await expect(
      updateEndpointBinding(deps, created.id, { path: 'bad path' }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_endpoint_input' });
    await expect(updateEndpointBinding(deps, 404, { permissionId: 10 })).rejects.toMatchObject({
      code: 'control_plane.endpoint_not_found',
    });
    await expect(
      updateEndpointBinding(deps, created.id, { permissionId: 404 }),
    ).rejects.toMatchObject({ code: 'control_plane.permission_not_found' });

    await expect(deleteEndpointBinding(deps, created.id)).resolves.toMatchObject({ ok: true });
    await expect(deleteEndpointBinding(deps, created.id)).rejects.toMatchObject({
      code: 'control_plane.endpoint_not_found',
    });
    await deleteEndpointBinding(deps, clash.id);
    expect(endpointStore.rows.size).toBe(0);
  });
});
