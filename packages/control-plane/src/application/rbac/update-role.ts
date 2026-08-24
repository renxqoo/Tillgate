/**
 * 更新角色（含授权全量替换,LWW）:
 *  - super 角色（is_super）任何字段不可改——role_immutable（自毁路径封死）;
 *  - code/is_super/is_builtin 恒不可改;
 *  - 授权码全部须为活动权限;停用 = 整角色 kill-switch（下一请求名下管理员零授权）。
 * 返回 { role, added, removed } 供路由层写审计 diff。
 */
import { controlPlaneErrors } from '../../errors';
import type { RoleRecord } from '../../ports/rbac-store';
import type { UpdateRoleRow } from '../../ports/rbac-store';
import type { RbacDeps } from './rbac-shared';

export interface RoleUpdateResult {
  readonly role: RoleRecord;
  readonly added: string[];
  readonly removed: string[];
}

export async function updateRole(deps: RbacDeps, input: UpdateRoleRow): Promise<RoleUpdateResult> {
  const role = await deps.stores.role.findById(deps.db, input.roleId);
  if (role == null) {
    throw controlPlaneErrors.business('role_not_found', { roleId: input.roleId });
  }
  if (role.isSuper) {
    throw controlPlaneErrors.business('role_immutable', { code: role.code });
  }
  if (input.status !== undefined && input.status !== 0 && input.status !== 1) {
    throw controlPlaneErrors.business('invalid_role_input', { status: input.status });
  }
  let added: string[] = [];
  let removed: string[] = [];
  if (input.codes !== undefined) {
    const active = new Set(await deps.stores.permission.activeCodes(deps.db));
    for (const code of input.codes) {
      if (!active.has(code)) {
        throw controlPlaneErrors.business('invalid_permission_code', { code });
      }
    }
    const current = await deps.stores.role.codesOf(deps.db, role.id);
    const next = new Set(input.codes);
    added = input.codes.filter((code) => !current.includes(code));
    removed = current.filter((code) => !next.has(code));
  }
  return deps.db.transaction(async (tx) => {
    if (input.codes !== undefined) {
      await deps.stores.role.replaceCodes(tx, role.id, input.codes);
    }
    const updated = await deps.stores.role.update(tx, {
      roleId: role.id,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });
    if (updated == null) {
      throw controlPlaneErrors.business('role_not_found', { roleId: role.id });
    }
    return { role: updated, added, removed };
  });
}
