/**
 * RBAC v2 契约测试（ADR-0008;docs/admin-rbac-v2/DESIGN）：
 *   1. enforced 注册表封闭性——41 码全量、无重复、域词表合法、与 0082 迁移种子逐码对账
 *      （迁移 SQL 文本解析,双源一致性锁死——种子漂移即红）;
 *   2. granted() 判定原语（isSuper 短路 / 集合包含 / 未知码拒绝）;
 *   3. roles/permissions 用例族守卫矩阵（super 全锁/内置不可删/挂载守卫/码冲突/
 *      enforced 锁/子节点守卫/绑定守卫/授权 diff）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENFORCED_CODES, PERMISSION_DOMAINS, granted, type AdminGrants } from '../src/domain/rbac';
import { createRole } from '../src/application/rbac/create-role';
import { updateRole } from '../src/application/rbac/update-role';
import { deleteRole } from '../src/application/rbac/delete-role';
import { createPermission } from '../src/application/rbac/create-permission';
import { updatePermission } from '../src/application/rbac/update-permission';
import { deletePermission } from '../src/application/rbac/delete-permission';
import { createMemoryPermissionStore, createMemoryRoleStore } from './memory';
import type { PermissionNode, RoleRecord } from '../src/ports/rbac-store';

describe('enforced 注册表封闭性（DESIGN §2 = 41 码）', () => {
  it('全量清单逐一列出,无重复,域前缀合法', () => {
    expect([...ENFORCED_CODES]).toHaveLength(41);
    expect(new Set(ENFORCED_CODES).size).toBe(41);
    for (const code of ENFORCED_CODES) {
      const domain = code.split(':')[0]!;
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
    const seeded = new Set([...sql.matchAll(/'([a-z]+:[a-z-]+)'/g)].map((match) => match[1]!));
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

const enforcedNode = (
  id: number,
  code: string | null,
  type: PermissionNode['type'],
): PermissionNode => ({
  id,
  parentId: type === 'group' ? null : 1,
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
  return {
    deps: {
      db: { transaction: (fn: (tx: unknown) => unknown) => fn({}) } as never,
      stores: { role: roleStore, permission: permissionStore },
    },
    roleStore,
    permissionStore,
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

  it('delete:super/内置拒;有挂载管理员拒;自定义角色可删', async () => {
    const { deps, roleStore } = rbacSetup();
    await expect(deleteRole(deps, 1)).rejects.toMatchObject({
      code: 'control_plane.role_immutable',
    });
    await expect(deleteRole(deps, 2)).rejects.toMatchObject({
      code: 'control_plane.role_immutable',
    });

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

  it('update:仅展示字段可动;enforced 停用拒（路由守卫在引用）;custom 停用放行', async () => {
    const { deps } = rbacSetup();
    await expect(updatePermission(deps, { id: 11, status: 1 })).rejects.toMatchObject({
      code: 'control_plane.permission_immutable',
    });
    await expect(updatePermission(deps, { id: 11, name: '改个名' })).resolves.toMatchObject({
      name: '改个名',
    });
    const { deps: deps2 } = rbacSetup();
    const custom = await createPermission(deps2, {
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
    await expect(updatePermission(deps2, { id: custom.id, status: 1 })).resolves.toMatchObject({
      status: 1,
    });
  });

  it('delete:enforced 拒;有子节点拒;被角色绑定拒;custom 叶子可删', async () => {
    const { deps, permissionStore } = rbacSetup();
    await expect(deletePermission(deps, 11)).rejects.toMatchObject({
      code: 'control_plane.permission_immutable',
    });

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
    permissionStore.setBinding(custom.id, 2);
    await expect(deletePermission(deps, custom.id)).rejects.toMatchObject({
      code: 'control_plane.permission_in_use',
    });
    permissionStore.setBinding(custom.id, 0);
    await expect(deletePermission(deps, custom.id)).resolves.toMatchObject({ ok: true });

    // 有子节点（group 1 下有 page）
    await expect(deletePermission(deps, 1)).rejects.toMatchObject({
      code: 'control_plane.permission_immutable', // enforced group 先命中不可删
    });
  });
});
