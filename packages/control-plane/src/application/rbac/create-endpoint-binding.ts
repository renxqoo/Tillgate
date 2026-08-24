/**
 * 新建接口绑定：method+path 唯一（409 endpoint_bound）;权限节点须存在且活动
 * （绑到停用码 = 该接口对非超管全体拒绝,允许但由管理面自行斟酌——校验只拦不存在）。
 */
import { controlPlaneErrors } from '../../errors';
import type { EndpointBindingRecord, CreateEndpointRow } from '../../ports/rbac-store';
import { ENDPOINT_PATH_PATTERN } from './rbac-shared';
import type { RbacDeps } from './rbac-shared';

export async function createEndpointBinding(
  deps: RbacDeps,
  input: CreateEndpointRow,
): Promise<EndpointBindingRecord> {
  if (!ENDPOINT_PATH_PATTERN.test(input.path)) {
    throw controlPlaneErrors.business('invalid_endpoint_input', { path: input.path });
  }
  const permission = await deps.stores.permission.findById(deps.db, input.permissionId);
  if (permission == null) {
    throw controlPlaneErrors.business('permission_not_found', { id: input.permissionId });
  }
  const existing = await deps.stores.endpoint.list(deps.db);
  if (existing.some((row) => row.method === input.method && row.path === input.path)) {
    throw controlPlaneErrors.business('endpoint_bound', { method: input.method, path: input.path });
  }
  return deps.stores.endpoint.create(deps.db, input);
}
