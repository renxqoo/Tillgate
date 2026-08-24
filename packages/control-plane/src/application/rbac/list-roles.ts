/** 角色列表（统一列表契约;含授权码集与挂载管理员计数） */
import type { RoleListQuery, RoleListResult } from '../../ports/rbac-store';
import type { RbacDeps } from './rbac-shared';

export function listRoles(deps: RbacDeps, query: RoleListQuery): Promise<RoleListResult> {
  return deps.stores.role.list(deps.db, query);
}
