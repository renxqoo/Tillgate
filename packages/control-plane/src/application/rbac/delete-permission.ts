/** 删除资源节点：enforced 拒;有子节点拒;被角色绑定拒（静默撤权必须拦）。custom 专属动词。 */
import { controlPlaneErrors } from '../../errors';
import type { RbacDeps } from './rbac-shared';

export async function deletePermission(deps: RbacDeps, id: number): Promise<{ ok: true }> {
  const node = await deps.stores.permission.findById(deps.db, id);
  if (node == null) {
    throw controlPlaneErrors.business('permission_not_found', { id });
  }
  if (node.source === 'enforced') {
    throw controlPlaneErrors.business('permission_immutable', {
      id,
      reason: 'enforced nodes cannot be deleted',
    });
  }
  const children = await deps.stores.permission.childCount(deps.db, id);
  if (children > 0) {
    throw controlPlaneErrors.business('permission_has_children', { id, children });
  }
  const bindings = await deps.stores.permission.bindingCount(deps.db, id);
  if (bindings > 0) {
    throw controlPlaneErrors.business('permission_in_use', { id, bindings });
  }
  await deps.stores.permission.remove(deps.db, id);
  return { ok: true };
}
