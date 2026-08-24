/** 删除角色：super/内置拒（role_immutable）;名下有管理员拒（role_in_use）。授权行级联。 */
import { controlPlaneErrors } from '../../errors';
import type { RbacDeps } from './rbac-shared';

export async function deleteRole(deps: RbacDeps, roleId: number): Promise<{ ok: true }> {
  const role = await deps.stores.role.findById(deps.db, roleId);
  if (role == null) {
    throw controlPlaneErrors.business('role_not_found', { roleId });
  }
  if (role.isSuper || role.isBuiltin) {
    throw controlPlaneErrors.business('role_immutable', { code: role.code });
  }
  const count = await deps.stores.role.adminCount(deps.db, roleId);
  if (count > 0) {
    throw controlPlaneErrors.business('role_in_use', { roleId, adminCount: count });
  }
  await deps.stores.role.remove(deps.db, roleId);
  return { ok: true };
}
