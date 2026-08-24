/** 权限树全量（管理面;平铺节点,树组装在 admin-api 投影层——port 不藏形状） */
import type { PermissionNode } from '../../ports/rbac-store';
import type { RbacDeps } from './rbac-shared';

export function treePermissions(deps: RbacDeps): Promise<PermissionNode[]> {
  return deps.stores.permission.list(deps.db);
}
