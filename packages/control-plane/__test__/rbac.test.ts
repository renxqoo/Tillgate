/**
 * RBAC 权限模型契约测试（docs/admin-rbac/DESIGN.md §2——本测试就是矩阵的规格面）:
 *   1. 词表封闭性:domains/actions/roles 全量列出,无多无少;
 *   2. 矩阵穷举:5 角色 × 8 域 × 2 动作 = 80 格逐一与 DESIGN §2.4 字面矩阵比对
 *      (非循环断言——期望值是手写字面量,不来自被测代码的派生);
 *   3. permissionsOf/can/assertAdminRole 行为面(含 fail-closed:未知角色/权限一律拒绝)。
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLES,
  PERMISSION_ACTIONS,
  PERMISSION_DOMAINS,
  assertAdminRole,
  can,
  isAdminRole,
  permissionsOf,
  type AdminRole,
} from '../src/domain/rbac';

describe('RBAC 词表封闭性（DESIGN §2.1/§2.4）', () => {
  it('权限域词表 = 8 域全量', () => {
    expect([...PERMISSION_DOMAINS]).toEqual([
      'users',
      'funds',
      'catalog',
      'plans',
      'ops',
      'growth',
      'settings',
      'admins',
    ]);
  });

  it('动作词表 = read/write', () => {
    expect([...PERMISSION_ACTIONS]).toEqual(['read', 'write']);
  });

  it('角色词表 = 5 角色全量(与 DB CHECK admins_role_ck 一致——0081 迁移)', () => {
    expect([...ADMIN_ROLES]).toEqual(['super_admin', 'operator', 'finance', 'support', 'viewer']);
  });
});

describe('RBAC 矩阵穷举（80 格 = DESIGN §2.4 字面矩阵）', () => {
  // 期望矩阵:手写字面量(✓/–),与 DESIGN §2.4 表格逐格一致——不引用被测代码派生
  const EXPECTED: Record<AdminRole, Record<string, boolean>> = {
    super_admin: {
      'users:read': true,
      'users:write': true,
      'funds:read': true,
      'funds:write': true,
      'catalog:read': true,
      'catalog:write': true,
      'plans:read': true,
      'plans:write': true,
      'ops:read': true,
      'ops:write': true,
      'growth:read': true,
      'growth:write': true,
      'settings:read': true,
      'settings:write': true,
      'admins:read': true,
      'admins:write': true,
    },
    operator: {
      'users:read': true,
      'users:write': true,
      'funds:read': true,
      'funds:write': false,
      'catalog:read': true,
      'catalog:write': true,
      'plans:read': true,
      'plans:write': true,
      'ops:read': true,
      'ops:write': true,
      'growth:read': true,
      'growth:write': true,
      'settings:read': true,
      'settings:write': true,
      'admins:read': false,
      'admins:write': false,
    },
    finance: {
      'users:read': true,
      'users:write': false,
      'funds:read': true,
      'funds:write': true,
      'catalog:read': true,
      'catalog:write': false,
      'plans:read': true,
      'plans:write': false,
      'ops:read': true,
      'ops:write': false,
      'growth:read': true,
      'growth:write': false,
      'settings:read': true,
      'settings:write': false,
      'admins:read': false,
      'admins:write': false,
    },
    support: {
      'users:read': true,
      'users:write': true,
      'funds:read': true,
      'funds:write': false,
      'catalog:read': true,
      'catalog:write': false,
      'plans:read': true,
      'plans:write': false,
      'ops:read': true,
      'ops:write': false,
      'growth:read': true,
      'growth:write': false,
      'settings:read': false,
      'settings:write': false,
      'admins:read': false,
      'admins:write': false,
    },
    viewer: {
      'users:read': true,
      'users:write': false,
      'funds:read': true,
      'funds:write': false,
      'catalog:read': true,
      'catalog:write': false,
      'plans:read': true,
      'plans:write': false,
      'ops:read': true,
      'ops:write': false,
      'growth:read': true,
      'growth:write': false,
      'settings:read': true,
      'settings:write': false,
      'admins:read': false,
      'admins:write': false,
    },
  };

  it.each(ADMIN_ROLES)('%s:16 格与 DESIGN §2.4 逐格一致(can 与 permissionsOf 双口径)', (role) => {
    const granted = new Set(permissionsOf(role));
    for (const domain of PERMISSION_DOMAINS) {
      for (const action of PERMISSION_ACTIONS) {
        const permission = `${domain}:${action}`;
        expect(can(role, permission)).toBe(EXPECTED[role][permission]);
        expect(granted.has(permission as never)).toBe(EXPECTED[role][permission]);
      }
    }
  });

  it.each(ADMIN_ROLES)('%s:permissionsOf 只含闭包内权限串且已排序', (role) => {
    const permissions = permissionsOf(role);
    const legal = new Set(
      PERMISSION_DOMAINS.flatMap((domain) =>
        PERMISSION_ACTIONS.map((action) => `${domain}:${action}`),
      ),
    );
    for (const permission of permissions) {
      expect(legal.has(permission)).toBe(true);
    }
    expect(permissions).toEqual([...permissions].toSorted());
    expect(new Set(permissions).size).toBe(permissions.length);
  });
});

describe('RBAC 运行时守卫（fail-closed）', () => {
  it('can:未知角色拒绝;未知权限串拒绝;不抛错', () => {
    expect(can('root', 'users:read')).toBe(false);
    expect(can('', 'users:read')).toBe(false);
    expect(can('super_admin', 'users:delete')).toBe(false);
    expect(can('super_admin', 'users')).toBe(false);
    expect(can('super_admin', '')).toBe(false);
  });

  it('isAdminRole:词表内 true,词表外 false', () => {
    expect(isAdminRole('viewer')).toBe(true);
    expect(isAdminRole('Viewer')).toBe(false);
    expect(isAdminRole('super-admin')).toBe(false);
    expect(isAdminRole('')).toBe(false);
  });

  it('assertAdminRole:合法值原样通过;非法值抛 invalid_admin_role(英文 message)', () => {
    expect(assertAdminRole('finance')).toBe('finance');
    expect(() => assertAdminRole('boss')).toThrowError(
      /control_plane\.invalid_admin_role|Invalid admin role/,
    );
  });
});
