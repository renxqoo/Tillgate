/**
 * 删除资源节点（全节点可删——用户裁决放开 enforced 锁;角色绑定随 FK 级联消失=
 * 该码对全部非超管角色即刻撤权）。唯一残留守卫:有子节点拒删（parent RESTRICT,
 * 自底向上删除;删 enforced 码后路由 guard 仍查代码注册表,超管 isSuper 免疫可恢复）。
 */
import { controlPlaneErrors } from '../../errors';
import type { RbacDeps } from './rbac-shared';

export async function deletePermission(deps: RbacDeps, id: number): Promise<{ ok: true }> {
  const node = await deps.stores.permission.findById(deps.db, id);
  if (node == null) {
    throw controlPlaneErrors.business('permission_not_found', { id });
  }
  const children = await deps.stores.permission.childCount(deps.db, id);
  if (children > 0) {
    throw controlPlaneErrors.business('permission_has_children', { id, children });
  }
  // 接口绑定守卫:节点仍守护接口时拒删（先解绑/换绑——避免整片接口瞬间默认拒绝;
  // 角色绑定随 FK 级联撤权,不拦）
  const endpointBindings = await deps.stores.endpoint.bindingCountOf(deps.db, id);
  if (endpointBindings > 0) {
    throw controlPlaneErrors.business('permission_in_use', { id, endpointBindings });
  }
  await deps.stores.permission.remove(deps.db, id);
  return { ok: true };
}
